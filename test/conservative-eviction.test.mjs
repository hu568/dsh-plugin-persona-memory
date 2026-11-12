/**
 * 回归测试：85%–100% 的**保守淘汰** + dry-run（0.12.0 · P0）。
 *
 * 背景：项目 MEMORY.md 真实数据到过 7973/8000 字符 = 99.66%，下一次 insertEntry 必撞
 * MEMORY_BUDGET_EXCEEDED；而模型不可用时 /memory-compact 只报「文件未改动」——
 * 因为旧实现只在 ratio ≥ 1 才进淘汰层。这里钉住新的两档门槛：
 *
 *  1. ratio < 0.85：不进淘汰层（合并/精简腾出的空间已经够了）；
 *  2. 85% ≤ ratio < 1：**保守档** —— 只删 ① 已失效（superseded/archived）条目
 *     ② 索引有元数据、importance ≤ 35、无 keep/锁/当前工作区保护的条目；
 *     缺元数据的普通条目、importance 70/90、keep、锁定、当前工作区一律不删；
 *  3. ≥ 100% 仍是完整档（普通条目也可动），保守档只是加一层更严的门槛；
 *  4. dryRun 只算不写：正文 / index.json / 备份 / 审计一个字节都不动；
 *  5. 索引缺失 ⇒ 一条都不删（「一无所知就不删」的纪律在保守档里同样成立）。
 *
 * 跑法：node test/conservative-eviction.test.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-conservative-'));
process.env.DSH_HOME = home;

const store = await import('../lib/store.js');
const compaction = await import('../lib/compaction.js');
const locks = await import('../lib/locks.js');
const command = await import('../lib/compact-command.js');

const memoryDir = store.memoryDir();
const indexPath = join(memoryDir, 'index.json');
const locksPath = join(memoryDir, 'locks.json');
const auditPath = join(memoryDir, 'compaction.jsonl');
const backupsDir = join(memoryDir, 'backups');
mkdirSync(memoryDir, { recursive: true });

/* 假项目：根目录自带 MEMORY.md。 */
const projectRoot = join(home, 'proj');
const memoryPath = join(projectRoot, 'MEMORY.md');
mkdirSync(projectRoot, { recursive: true });

const LIMITS = { maxFactLines: 100, maxFactBytes: 1200, maxProjectChars: 600 };
const setLimits = (patch = {}) => store.configureStore({ ...LIMITS, compactionEnabled: false, ...patch });
setLimits();

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const memoryText = () => readFileSync(memoryPath, 'utf8');
const memoryRatio = () => compaction.ratioOf(store.watermark('memory', { cwd: projectRoot }));
const memoryLimitFor = (text, ratio) => Math.max(1, Math.round(store.countChars(text) / ratio));

/* 固定时间：评分/近因要可复现（lastHit 都在这之前，不依赖跑测试的当天）。 */
const NOW = Date.UTC(2026, 10, 12);
const DAY = 86400000;
/* 受保护条目故意写长：让它们在文件里占大头，删掉几条低价值条目后水位仍 ≥ 75%，
   这样「全部合格候选都被删掉」与「75% 下限」两个行为能同时验证。 */
const LONG = '这是一条高价值的长正文用来占用记忆预算，内容保持唯一以便与索引 id 对应'.repeat(6);

const SUPERSEDED = '旧结论：端口 8080 已不再使用';
const LOW_20 = '细节：临时目录可以清空';
const LOW_35 = '细节：日志默认保留三天';
const HIGH_70 = `重要结论七十 node v7 ${LONG}`;
const HIGH_90 = `核心铁律九十 node v9 ${LONG}`;
const KEEP_10 = `低分但人工保留 node vk ${LONG}`;
const LOCK_10 = `低分但已锁定 node vl ${LONG}`;
const MISSING = `手写没进索引的结论 node vm ${LONG}`;
const OTHER_WS = '别的工作区的低值细节';

const RAW = [
    '# MEMORY.md — 项目记忆',
    '',
    '## 结论区',
    '',
    `1. ${SUPERSEDED} <!-- memory-state: status=superseded by=abc123 since=2026-11-01 -->`,
    `2. ${LOW_20}`,
    `3. ${LOW_35}`,
    `4. ${HIGH_70}`,
    `5. ${HIGH_90}`,
    `6. ${KEEP_10} <!-- keep -->`,
    `7. ${LOCK_10}`,
    `8. ${MISSING}`,
    `9. ${OTHER_WS}`,
    '',
].join('\n');

/*
 * 每条索引元数据（按 RAW 里的出现顺序）：null = 故意不写索引（缺元数据）。
 *  - [0] 失效条目，importance 80：**状态注释比重要性更强**，保守档照样删；
 *  - [1] importance 20 / [2] 35（边界，含）⇒ 可删；
 *  - [3] 70 / [4] 90 ⇒ 高价值，不删；
 *  - [5] keep ⇒ 不删（importance 10 也救不了它被保护）；
 *  - [6] 已锁定 ⇒ 不删；
 *  - [7] 缺元数据 ⇒ 不删；
 *  - [8] 别的工作区、importance 10 ⇒ 可删。
 */
const META = [
    { importance: 80, kind: 'conclusion' },
    { importance: 20, kind: 'detail' },
    { importance: 35, kind: 'detail' },
    { importance: 70, kind: 'conclusion' },
    { importance: 90, kind: 'conclusion' },
    { importance: 10, kind: 'detail' },
    { importance: 10, kind: 'detail' },
    null,
    { importance: 10, kind: 'detail', workspaceId: 'ws-other' },
];

/** 写正文 + 侧车索引（真实字段：scope/path/workspaceId/firstSeen/lastHit/hits/confidence/importance/kind）。 */
function setup(ratio = 0.93) {
    writeFileSync(memoryPath, RAW, 'utf8');
    rmSync(indexPath, { force: true });
    rmSync(locksPath, { force: true });
    rmSync(auditPath, { force: true });
    rmSync(backupsDir, { recursive: true, force: true });
    const entries = compaction.parseEntries('memory', RAW);
    assert.equal(entries.length, 9, `样本应解析出 9 条，实际 ${entries.length}`);
    const records = {};
    const ids = [];
    for (let index = 0; index < entries.length; index += 1) {
        const meta = META[index];
        const firstSeen = NOW - (index + 1) * 10 * DAY;
        const id = store.entryId(firstSeen, entries[index].text);
        ids.push(id);
        if (meta === null)
            continue;
        records[id] = {
            scope: 'memory',
            path: memoryPath,
            workspaceId: meta.workspaceId ?? null,
            firstSeen,
            lastHit: NOW - (index + 1) * DAY,
            hits: 1,
            confidence: 'low',
            importance: meta.importance,
            kind: meta.kind ?? 'conclusion',
        };
    }
    writeFileSync(indexPath, `${JSON.stringify({ version: 1, entries: records }, null, 2)}\n`, 'utf8');
    setLimits({ maxProjectChars: memoryLimitFor(RAW, ratio) });
    return { entries, ids, records };
}

/* ── 极简 PASS/FAIL 报告器 ── */
const failures = [];
let checks = 0;
async function check(label, fn) {
    checks += 1;
    try {
        await fn();
        console.log(`PASS ${label}`);
    }
    catch (error) {
        failures.push(label);
        const detail = String(error?.stack ?? error?.message ?? error).split('\n').slice(0, 6).join('\n      ');
        console.log(`FAIL ${label}\n      ${detail}`);
    }
}

/* ═════════════ 1) 门槛：85% 以下不进淘汰层 ═════════════ */
await check('ratio < 0.85 ⇒ compact 跳过、文件与索引一字未动（即使有可删条目）', async () => {
    setup(0.8);
    assert.ok(memoryRatio() < 0.85, `样本水位应 < 0.85，实际 ${memoryRatio()}`);
    const before = sha(memoryPath);
    const indexBefore = readFileSync(indexPath, 'utf8');
    const result = await compaction.compact('memory', { cwd: projectRoot, callModel: null, now: NOW });
    assert.equal(result.skipped, 'below-watermark');
    assert.equal(result.evicted, undefined);
    assert.equal(sha(memoryPath), before);
    assert.equal(readFileSync(indexPath, 'utf8'), indexBefore);
});

await check('applyPlan：合并后 85% 以下不触发保守淘汰（diagnostics 为 null）', () => {
    const raw = RAW;
    const applied = compaction.applyPlan('memory', raw, { chars: memoryLimitFor(raw, 0.8) }, [], { now: NOW });
    assert.deepEqual(applied.evicted, []);
    assert.equal(applied.diagnostics, null, '没进淘汰层就不该有诊断');
});

/* ═════════════ 2) 85%–100%：保守档只删允许项 ═════════════ */
await check('保守档：只删失效条目 + importance≤35 的条目；70/90/keep/锁/缺元数据全部保住', async () => {
    const { entries, ids } = setup(0.93);
    locks.setLock('memory', ids[6], { at: NOW });
    const ratioBefore = memoryRatio();
    assert.ok(ratioBefore >= 0.85 && ratioBefore < 1, `样本水位应在 85%–100%，实际 ${ratioBefore}`);
    const result = await compaction.compact('memory', { cwd: projectRoot, callModel: null, now: NOW });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.conservative, true);
    assert.equal(result.diagnostics?.mode, 'conservative');
    assert.equal(result.diagnostics?.importanceThreshold, 35);
    assert.equal(result.reason, 'conservative-evicted');
    assert.equal(result.ratio < 1, true, `压完应低于 100%，实际 ${result.ratio}`);
    assert.ok(result.ratio >= 0.75, `水位不许低于 75%，实际 ${result.ratio}`);

    // 允许删的 4 条：失效条目、importance 20、importance 35（边界）、别的工作区低值条目
    const allowed = new Set([entries[0].text, entries[1].text, entries[2].text, entries[8].text]);
    assert.equal(result.evicted.length, 4, `应删 4 条，实际 ${result.evicted.length}：${JSON.stringify(result.evicted.map((item) => item.text))}`);
    for (const item of result.evicted)
        assert.ok(allowed.has(item.text), `不该删：${item.text}`);
    assert.ok(result.evicted.some((item) => item.dormant === true && item.importance === 80), '失效条目要带 dormant 标记（分数 0，优先删）');
    assert.ok(result.evicted.some((item) => item.importance === 20), 'importance 20 应被删');
    assert.ok(result.evicted.some((item) => item.importance === 35), 'importance 35 是边界，应被删');
    assert.ok(result.evicted.some((item) => item.importance === 10), '别的工作区的低值条目应被删');

    // 受保护的 5 条一个都不能消失（正文里仍在）
    const after = memoryText();
    for (const text of [HIGH_70, HIGH_90, KEEP_10, LOCK_10, MISSING])
        assert.ok(after.includes(text), `受保护条目被删了：${text.slice(0, 20)}`);
    // 被删的 4 条必须从正文里消失
    for (const item of result.evicted)
        assert.ok(!after.includes(item.text), `淘汰条目仍在正文里：${item.text}`);

    assert.equal(result.diagnostics?.missingMetadata, 1, '缺元数据的普通条目记 1 条');
    assert.equal(result.diagnostics?.protectedImportance, 2, 'importance 70/90 两条被重要性门槛挡下');
    assert.equal(result.diagnostics?.protectedKeep, 1);
    assert.equal(result.diagnostics?.protectedLock, 1, '锁定条目要被算进「已锁定」而不是「重要性」');
    assert.equal(result.diagnostics?.dormantPriority, 1);
    assert.equal(result.diagnostics?.candidates, 4);
    assert.equal(result.diagnostics?.selected, 4);

    // 真删要落盘 + 备份 + 审计；索引同步后不再含被删条目的孤儿记录
    assert.equal(result.written, true);
    assert.ok(existsSync(backupsDir) && readdirSync(backupsDir).some((name) => name.endsWith('.bak')), '真删要写备份');
    assert.equal(compaction.readAudit(100).length, 1, '真删要写一条审计');
    const index = JSON.parse(readFileSync(indexPath, 'utf8')).entries;
    for (const id of ids.slice(0, 3))
        assert.equal(index[id], undefined, '被删条目的索引记录应同步清掉');
    locks.unsetLock('memory', ids[6]);
    setLimits();
});

await check('完整档（≥100%）仍可淘汰普通条目：保守档只是加严，不是替换', async () => {
    const { entries, ids } = setup(0.93);
    const index = store.memoryIndex();
    const resolved = compaction.resolveEntryIds(entries, index);
    // 水位投影成 ≥100% 的样子（chars 不变、limit 压低 ⇒ ratio 1.1）
    const base = { lines: 20, bytes: 3000, chars: store.countChars(RAW), limit: { chars: memoryLimitFor(RAW, 1.1) } };
    assert.ok(compaction.ratioOf(base) >= 1, '样本水位应 ≥ 100%');
    const conservative = compaction.selectEvictions(resolved, index, {
        now: NOW,
        conservative: true,
        watermark: base,
        targetRatio: 0.05,
        maxEvictions: 6,
    });
    const full = compaction.selectEvictions(resolved, index, {
        now: NOW,
        conservative: false,
        watermark: base,
        targetRatio: 0.05,
        maxEvictions: 6,
    });
    const fullIds = new Set(full.map((item) => item.id));
    assert.ok(!conservative.some((item) => item.id === ids[3]), '保守档不许动 importance 70');
    assert.ok(!conservative.some((item) => item.id === ids[4]), '保守档不许动 importance 90');
    assert.ok(fullIds.has(ids[3]) || fullIds.has(ids[4]), '完整档应能淘汰高重要性条目（只要分数最低/水位需要）');
    // 完整档也照样保护 keep / 锁 / 缺元数据
    assert.ok(!full.some((item) => item.text === entries[5].text), '完整档也要保护 keep');
});

/* ═════════════ 3) 保护区：keep / 锁 / 当前工作区 / 缺元数据 ═════════════ */
await check('保守档：当前 workspace 条目被保护（selectEvictions 直测）', () => {
    const { entries, ids } = setup(0.93);
    const index = store.memoryIndex();
    const resolved = compaction.resolveEntryIds(entries, index);
    const diagnostics = {};
    const picked = compaction.selectEvictions(resolved, index, {
        now: NOW,
        conservative: true,
        workspaceId: 'ws-other',
        watermark: { lines: 20, bytes: 3000, chars: store.countChars(RAW), limit: { chars: memoryLimitFor(RAW, 1.1) } },
        maxEvictions: 6,
        report: diagnostics,
    });
    assert.ok(!picked.some((item) => item.text === entries[8].text), '当前工作区的条目不许删');
    assert.equal(diagnostics.protectedWorkspace, 1);
    assert.equal(diagnostics.mode, 'conservative');
    setLimits();
});

await check('保守档：缺元数据的普通条目一条都不删（索引里有记录才谈得上 importance）', () => {
    const { entries } = setup(0.93);
    const index = store.memoryIndex();
    const resolved = compaction.resolveEntryIds(entries, index);
    const diagnostics = {};
    const picked = compaction.selectEvictions(resolved, index, {
        now: NOW,
        conservative: true,
        watermark: { lines: 20, bytes: 3000, chars: store.countChars(RAW), limit: { chars: memoryLimitFor(RAW, 1.1) } },
        maxEvictions: 6,
        report: diagnostics,
    });
    assert.ok(!picked.some((item) => item.text === entries[7].text), '缺元数据条目不许删');
    assert.equal(diagnostics.missingMetadata, 1);
    setLimits();
});

/* ═════════════ 4) dryRun：只算不写 ═════════════ */
await check('dryRun：算出将淘汰谁，但正文/index.json/备份/审计一个字节都不动', async () => {
    const { ids } = setup(0.93);
    locks.setLock('memory', ids[6], { at: NOW });
    const before = sha(memoryPath);
    const indexBefore = readFileSync(indexPath, 'utf8');
    const locksBefore = readFileSync(locksPath, 'utf8');
    const result = await compaction.compact('memory', { cwd: projectRoot, dryRun: true, callModel: null, now: NOW });
    assert.equal(result.dryRun, true);
    assert.equal(result.written, false);
    assert.equal(result.changed, true, 'dry 也要把「将会发生什么」算出来');
    assert.equal(result.conservative, true);
    assert.equal(result.diagnostics?.mode, 'conservative');
    assert.equal(result.evicted.length, 4, `dry 应算出 4 条，实际 ${result.evicted.length}`);
    // 落盘面的四个检查点
    assert.equal(sha(memoryPath), before, 'dry 绝不改正文');
    assert.equal(readFileSync(indexPath, 'utf8'), indexBefore, 'dry 绝不改 index.json');
    assert.equal(readFileSync(locksPath, 'utf8'), locksBefore, 'dry 绝不改锁定表');
    assert.equal(existsSync(backupsDir), false, 'dry 不许生成备份目录');
    assert.equal(existsSync(auditPath), false, 'dry 不许生成审计流水');
    locks.unsetLock('memory', ids[6]);
    setLimits();
});

await check('dryRun 的计划与真删一致：同一份数据算出的淘汰名单相同', async () => {
    const { ids } = setup(0.93);
    locks.setLock('memory', ids[6], { at: NOW });
    const dry = await compaction.compact('memory', { cwd: projectRoot, dryRun: true, callModel: null, now: NOW });
    const real = await compaction.compact('memory', { cwd: projectRoot, callModel: null, now: NOW });
    assert.deepEqual(dry.evicted.map((item) => item.id), real.evicted.map((item) => item.id), 'dry 与真删名单必须一致');
    assert.equal(dry.ratio, real.ratio, 'dry 报出来的水位应与真删后一致');
    locks.unsetLock('memory', ids[6]);
    setLimits();
});

/* ═════════════ 5) 索引缺失：一律不删 ═════════════ */
await check('85%–100% + 索引缺失 ⇒ 一条都不删，文案说清原因并给 seed 提示', async () => {
    setup(0.93);
    rmSync(indexPath, { force: true });
    const before = sha(memoryPath);
    const result = await compaction.compact('memory', { cwd: projectRoot, callModel: null, now: NOW });
    assert.equal(result.evicted.length, 0);
    assert.equal(result.changed, false);
    assert.equal(result.written, false, '看起来 okay 也不能写盘');
    assert.equal(result.ok, true, '85%–100% 本来就没超限，没删不算失败');
    assert.equal(result.conservative, true);
    assert.equal(result.diagnostics?.mode, 'conservative');
    assert.equal(result.diagnostics?.reason, 'index-missing');
    assert.match(result.message, /保守档未淘汰任何条目/);
    assert.match(result.message, /index\.json/);
    assert.equal(sha(memoryPath), before);
    setLimits();
});

/* ═════════════ 6) 改写过的条目：importance 要跟着新 id 平移 ═════════════ */
await check('withPlanMetadata：被精简改写的条目仍带原 importance，保守档才删得掉它', () => {
    const high = `核心铁律九十 node v9 ${LONG}`;
    const low = '低值细节原文 node v2';
    const raw = ['# MEMORY.md — 项目记忆', '', '## 结论区', '', `1. ${high}`, `2. ${low}`, ''].join('\n');
    writeFileSync(memoryPath, raw, 'utf8');
    rmSync(indexPath, { force: true });
    rmSync(locksPath, { force: true });
    const parseOnly = compaction.parseEntries('memory', raw);
    const highId = store.entryId(NOW - DAY, parseOnly[0].text);
    const lowId = store.entryId(NOW - 2 * DAY, parseOnly[1].text);
    writeFileSync(indexPath, `${JSON.stringify({
        version: 1,
        entries: {
            [highId]: { scope: 'memory', path: memoryPath, workspaceId: null, firstSeen: NOW - DAY, lastHit: NOW - DAY, hits: 1, confidence: 'low', importance: 90, kind: 'conclusion' },
            [lowId]: { scope: 'memory', path: memoryPath, workspaceId: null, firstSeen: NOW - 2 * DAY, lastHit: NOW - 2 * DAY, hits: 1, confidence: 'low', importance: 20, kind: 'detail' },
        },
    }, null, 2)}\n`, 'utf8');
    // 真实链路：planShortenings 交给 applyPlan 的 entries 是**已解析过 id** 的
    // （resolveEntryIds 之后），withPlanMetadata 才找得到原记录、把 importance 平移过去。
    const parsed = compaction.resolveEntryIds(parseOnly, store.memoryIndex());
    assert.equal(parsed[1].indexed, true, '低值条目应命中索引');
    const limit = { chars: memoryLimitFor(raw, 0.93) };
    const plan = [{ section: '结论区', entries: [parsed[1]], text: '低值细节改短 v2', kind: 'shorten' }];
    const applied = compaction.applyPlan('memory', raw, limit, plan, { now: NOW });
    assert.equal(applied.diagnostics?.mode, 'conservative');
    assert.equal(applied.evicted.length, 1, `改写后应能淘汰低值条目，实际 ${JSON.stringify(applied.evicted)}`);
    assert.equal(applied.evicted[0].text, '低值细节改短 v2');
    assert.equal(applied.evicted[0].importance, 20, '重要性必须跟到新 id 上（否则会被当成 50 分而删不掉）');
    setLimits();
});

/* ═════════════ 7) 命令文案：说清「保守档 / 删了谁 / dry 前缀」 ═════════════ */
await check('/memory-compact 文案：保守档真删要标注，dry 前缀与「将淘汰」照旧', async () => {
    const { ids } = setup(0.93);
    locks.setLock('memory', ids[6], { at: NOW });
    const dry = await compaction.compact('memory', { cwd: projectRoot, dryRun: true, callModel: null, now: NOW });
    const dryText = command.describeCompactionResult('memory', dry, true);
    assert.match(dryText, /^\[dry\] MEMORY\.md/m, 'dry 前缀照旧');
    assert.match(dryText, /保守档只动失效条目 \/ importance ≤ 35 的条目/, `要说清是保守档：\n${dryText}`);
    assert.match(dryText, /将淘汰：/);
    assert.match(dryText, /失效条目/, '失效条目要有标注');
    assert.match(dryText, /importance 20/);

    const real = await compaction.compact('memory', { cwd: projectRoot, callModel: null, now: NOW });
    const realText = command.describeCompactionResult('memory', real, false);
    assert.doesNotMatch(realText, /\[dry\]/, '真删不该有 dry 前缀');
    assert.match(realText, /已淘汰：/);
    assert.match(realText, /保守档只动失效条目 \/ importance ≤ 35 的条目/);
    locks.unsetLock('memory', ids[6]);
    setLimits();
});

await check('/memory-compact 文案：保守档没删时用结果 message 说清被什么挡下', async () => {
    setup(0.93);
    rmSync(indexPath, { force: true });
    const result = await compaction.compact('memory', { cwd: projectRoot, callModel: null, now: NOW });
    const text = command.describeCompactionResult('memory', result, false);
    assert.match(text, /保守档未淘汰任何条目/);
    assert.match(text, /index\.json/);
    assert.match(text, /文件未改动/);
    setLimits();
});

/* ── 汇总 ── */
console.log('');
if (failures.length > 0) {
    console.log(`失败 ${failures.length} / ${checks}：${failures.join('、')}`);
    process.exit(1);
}
console.log(`保守淘汰用例全部通过（${checks} 条）`);
