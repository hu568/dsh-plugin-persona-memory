/**
 * 回归测试：冷缺省档（0.13.2 · A1）。
 *
 * 背景：85%–100% 的保守档只动「失效」与「importance ≤ 35」的条目，而整篇写回会补一批
 * importance=50 的缺省记录（真实数据 42 条里 31 条如此）⇒ 候选恒为 0，「写满必挂」。
 * 这里钉住新的第四类准入：
 *  ① importance 不是显式设置的（`importanceExplicit !== true`，老索引字段缺失按未显式）；
 *  ② hits ≤ 1；③ 最后一次活动 > 30 天。三条缺一条都不删。
 * 以及两道刹车：
 *  - 单次最多 2 条（`COLD_DEFAULT_MAX_EVICTIONS`）；
 *  - dry-run 一定先把名单与正文列出来；真删必须显式 `coldDefaults: true`（命令加 cold），
 *    写前自动压缩永远拿不到这个开关。
 *
 * 跑法：node test/cold-default-eviction.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-cold-default-'));
process.env.DSH_HOME = home;

const store = await import('../lib/store.js');
const compaction = await import('../lib/compaction.js');
const locks = await import('../lib/locks.js');
const command = await import('../lib/compact-command.js');

const memoryDir = store.memoryDir();
mkdirSync(memoryDir, { recursive: true });
const indexPath = join(memoryDir, 'index.json');
const locksPath = join(memoryDir, 'locks.json');
const projectRoot = join(home, 'proj');
const memoryPath = join(projectRoot, 'MEMORY.md');
mkdirSync(projectRoot, { recursive: true });

const LIMITS = { maxFactLines: 100, maxFactBytes: 1200, maxProjectChars: 600 };
const setLimits = (patch = {}) => store.configureStore({ ...LIMITS, compactionEnabled: false, ...patch });
setLimits();

const NOW = Date.UTC(2026, 10, 12);
const DAY = 86400000;
const memoryText = () => readFileSync(memoryPath, 'utf8');
const memoryRatio = () => compaction.ratioOf(store.watermark('memory', { cwd: projectRoot }));
const memoryLimitFor = (text, ratio) => Math.max(1, Math.round(store.countChars(text) / ratio));

/* 冷缺省候选：A/B/C 三条三条同时成立；D 显式 50、E 命中过多、F 太新、G 带 keep、H 缺元数据。 */
const COLD_A = '细节甲：旧脚本的临时参数可以清掉';
const COLD_B = '细节乙：某次实验的中间目录可以清掉';
const COLD_C = '细节丙：已经没人再看的排查记录';
const EXPLICIT_50 = '有人显式打了 50 分的中等条目';
const HOT_5 = '被命中过很多次的老条目';
const FRESH = '昨天刚写进来的中等条目';
const KEEP = '带 keep 标记的冷条目';
const MISSING = '手写但索引里完全没记录的条目';
/* 填充条目：显式 importance 90（高价值、非冷缺省），只为了让文件够大 ——
   否则删 2 条就会跌破 75% 下限，测不到「单次最多 2 条」这条上限。 */
const FILLERS = Array.from({ length: 6 }, (_item, index) =>
    `固定的核心约定第${index + 1}条，用足够长的正文把记忆预算撑开，避免两次淘汰就跌破百分之七十五的下限`);

const RAW = [
    '# MEMORY.md — 项目记忆',
    '',
    '## 结论区',
    '',
    `1. ${COLD_A}`,
    `2. ${COLD_B}`,
    `3. ${COLD_C}`,
    `4. ${EXPLICIT_50}`,
    `5. ${HOT_5}`,
    `6. ${FRESH}`,
    `7. ${KEEP} <!-- keep -->`,
    `8. ${MISSING}`,
    ...FILLERS.map((text, index) => `${9 + index}. ${text}`),
    '',
].join('\n');

/** 写正文 + 侧车索引；lastHit 按天数间距固定，便于复现「冷/热」。 */
function setup(ratio = 0.93) {
    writeFileSync(memoryPath, RAW, 'utf8');
    rmSync(indexPath, { force: true });
    rmSync(locksPath, { force: true });
    const entries = compaction.parseEntries('memory', RAW);
    assert.equal(entries.length, 8 + FILLERS.length, `样本应解析出 ${8 + FILLERS.length} 条，实际 ${entries.length}`);
    const records = {};
    const ids = [];
    const meta = [
        // A/B/C：importance 缺省（老索引连字段都没有也认），hits≤1，>30 天
        { importanceExplicit: false, hits: 1, idle: 60 },
        { importance: 50, importanceExplicit: false, hits: 1, idle: 45 },
        { importanceExplicit: false, hits: 0, idle: 90 },
        // D：显式 50 ⇒ 不许动
        { importance: 50, importanceExplicit: true, hits: 1, idle: 100 },
        // E：命中 5 次 ⇒ 不许动
        { importance: 50, importanceExplicit: false, hits: 5, idle: 120 },
        // F：3 天前才活动 ⇒ 不许动
        { importance: 60, importanceExplicit: false, hits: 1, idle: 3 },
        // G：keep ⇒ 不许动
        { importance: 50, importanceExplicit: false, hits: 0, idle: 200 },
        // H：真缺元数据 ⇒ 不许动（与「字段缺」区分）
        null,
        // 填充条目：显式 90，永远只当「受保护」用
        ...FILLERS.map(() => ({ importance: 90, importanceExplicit: true, hits: 2, idle: 10 })),
    ];
    for (let index = 0; index < entries.length; index += 1) {
        const firstSeen = NOW - (meta[index] === null ? 30 : meta[index].idle + 5) * DAY;
        const id = store.entryId(firstSeen, entries[index].text);
        ids.push(id);
        if (meta[index] === null)
            continue;
        records[id] = {
            scope: 'memory',
            path: memoryPath,
            workspaceId: null,
            firstSeen,
            lastHit: NOW - meta[index].idle * DAY,
            hits: meta[index].hits,
            confidence: 'medium',
            ...(Number.isFinite(meta[index].importance) ? { importance: meta[index].importance } : {}),
            ...(meta[index].importanceExplicit === true ? { importanceExplicit: true } : {}),
            kind: 'detail',
        };
    }
    writeFileSync(indexPath, `${JSON.stringify({ version: 1, entries: records }, null, 2)}\n`, 'utf8');
    setLimits({ maxProjectChars: memoryLimitFor(RAW, ratio) });
    return { entries, ids };
}

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

/* ═════════════ 1) dry-run：先出名单 ═════════════ */
await check('dry：冷缺省档先出名单（候选 3 条、选中 2 条、文件一个字节不动）', async () => {
    setup(0.93);
    const before = memoryText();
    const indexBefore = readFileSync(indexPath, 'utf8');
    const result = await compaction.compact('memory', { cwd: projectRoot, dryRun: true, callModel: null, now: NOW });
    assert.equal(result.dryRun, true);
    assert.equal(result.written, false);
    assert.equal(result.coldDefaults, true, 'dry 恒开冷缺省档（要先看名单）');
    assert.equal(result.diagnostics?.coldDefaults, true);
    assert.equal(result.diagnostics?.coldDefaultCandidates, 3, `冷缺省候选应为 3 条，实际 ${result.diagnostics?.coldDefaultCandidates}`);
    assert.equal(result.diagnostics?.coldDefaultSelected, 2, '单次上限 2 条');
    assert.equal(result.diagnostics?.coldDefaultMax, 2);
    assert.equal(result.evicted.length, 2, '只该选中 2 条');
    for (const item of result.evicted) {
        assert.equal(item.coldDefault, true, `dry 名单里的每一条都要标 coldDefault：${item.text}`);
        assert.equal(item.importance, 50, '冷缺省条目的 importance 是缺省 50');
    }
    const picked = new Set(result.evicted.map((item) => item.text));
    for (const text of picked)
        assert.ok([COLD_A, COLD_B, COLD_C].includes(text), `不该选中受保护条目：${text}`);
    assert.equal(memoryText(), before, 'dry 绝不改正文');
    assert.equal(readFileSync(indexPath, 'utf8'), indexBefore, 'dry 绝不改索引');
    setLimits();
});

/* ═════════════ 2) 真删：只有显式 coldDefaults 才会删 ═════════════ */
await check('真删必须显式 coldDefaults：默认保守档一条冷缺省都不删', async () => {
    setup(0.93);
    const before = memoryText();
    const result = await compaction.compact('memory', { cwd: projectRoot, callModel: null, now: NOW });
    assert.equal(result.coldDefaults, false, '没有显式要求 ⇒ 冷缺省档关闭（不真删）');
    // 候选数照样算出来（否则用户永远不知道「还能腾 2 条」），但一条都不选。
    assert.equal(result.diagnostics?.coldDefaultCandidates, 3, '候选数要在诊断里报出来');
    assert.equal(result.diagnostics?.coldDefaultSelected, 0, '关闭时一条都不选');
    assert.equal(result.evicted.length, 0, `默认不该删任何条目，实际 ${JSON.stringify(result.evicted.map((item) => item.text))}`);
    assert.equal(memoryText(), before, '文件一字不改');
    assert.match(result.message, /冷缺省候选/, '要说清「有几条冷缺省候选、怎么才会删」');
    assert.match(result.message, /cold/, '要给出 cold 参数的提示');
    setLimits();
});

await check('真删：coldDefaults:true ⇒ 只删 2 条冷缺省，受保护条目全部留下', async () => {
    const { ids } = setup(0.93);
    const result = await compaction.compact('memory', { cwd: projectRoot, coldDefaults: true, callModel: null, now: NOW });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.coldDefaults, true);
    assert.equal(result.written, true);
    assert.equal(result.evicted.length, 2, `应删 2 条，实际 ${result.evicted.length}`);
    assert.equal(result.diagnostics?.coldDefaultSelected, 2);
    const after = memoryText();
    for (const item of result.evicted)
        assert.ok(!after.includes(item.text), `淘汰条目仍在正文：${item.text}`);
    // 显式 50 / 热条目 / 新条目 / keep / 缺元数据一条都不能消失
    for (const text of [EXPLICIT_50, HOT_5, FRESH, KEEP, MISSING])
        assert.ok(after.includes(text), `受保护条目被删：${text}`);
    // 冷却候选剩下 1 条还在
    assert.ok([COLD_A, COLD_B, COLD_C].filter((text) => after.includes(text)).length === 1, '第三条冷缺省候选要留着（单次上限 2）');
    // 索引同步：被删条目的记录不再常驻
    const index = store.memoryIndex();
    for (const item of result.evicted)
        assert.equal(index.entries[item.id], undefined, `被删条目的索引记录应清掉：${item.id}`);
    assert.ok(existsSync(join(memoryDir, 'backups')), '真删要留备份（压缩侧 backups/ 根）');
    setLimits();
});

/* ═════════════ 3) 保护与保护区的交叉：keep / 锁 / 工作区 ═════════════ */
await check('保护区照旧：keep / 锁 / 当前工作区都挡住冷缺省档', async () => {
    const { ids } = setup(0.93);
    locks.setLock('memory', ids[0], { at: NOW });
    const result = await compaction.compact('memory', { cwd: projectRoot, coldDefaults: true, workspaceId: 'ws-1', callModel: null, now: NOW });
    const evictedTexts = result.evicted.map((item) => item.text);
    assert.ok(!evictedTexts.includes(COLD_A), '锁定的冷缺省条目不许删');
    assert.ok(!evictedTexts.includes(KEEP), 'keep 条目不许删');
    locks.unsetLock('memory', ids[0]);
    setLimits();
});

/* ═════════════ 4) hits / 时间 / 显式标记三条边界 ═════════════ */
await check('三条同时成立才准入：显式 50 / hits>1 / 30 天内活动 各差一条都不删', () => {
    const { entries } = setup(0.93);
    const index = store.memoryIndex();
    const resolved = compaction.resolveEntryIds(entries, index);
    const report = {};
    const picked = compaction.selectEvictions(resolved, index, {
        now: NOW,
        conservative: true,
        coldDefaults: true,
        watermark: { chars: store.countChars(RAW), limit: { chars: memoryLimitFor(RAW, 1.1) } },
        maxEvictions: 6,
        targetRatio: 0.75,
        report,
    });
    const texts = picked.map((item) => item.text);
    for (const text of [EXPLICIT_50, HOT_5, FRESH, KEEP, MISSING])
        assert.ok(!texts.includes(text), `不该进名单：${text}`);
    assert.equal(picked.length, 2);
    assert.equal(report.coldDefaultCandidates, 3);
    // 显式 50 记进 protectedImportance，缺元数据仍是 missingMetadata
    assert.equal(report.protectedImportance, 3 + FILLERS.length, '显式 50 / 热条目 / 新条目 + 填充条目都算「重要性 > 35 挡下」');
    assert.equal(report.missingMetadata, 1);
    setLimits();
});

/* ═════════════ 5) 命令文案：dry 标「冷缺省」，cold 才真删 ═════════════ */
await check('/memory-compact：dry 名单标「冷缺省」，加 cold 才真删，没加时给提示', async () => {
    setup(0.93);
    const dry = await compaction.compact('memory', { cwd: projectRoot, dryRun: true, callModel: null, now: NOW });
    const dryText = command.describeCompactionResult('memory', dry, true);
    assert.match(dryText, /将淘汰：/);
    assert.match(dryText, /冷缺省/, `dry 文案要标出冷缺省：\n${dryText}`);
    assert.match(command.COMPACT_USAGE, /cold/);

    const plain = await compaction.compact('memory', { cwd: projectRoot, callModel: null, now: NOW });
    const plainText = command.describeCompactionResult('memory', plain, false);
    assert.match(plainText, /冷缺省候选/, '没加 cold 时要告诉用户还有冷缺省候选');

    const real = await compaction.compact('memory', { cwd: projectRoot, coldDefaults: true, callModel: null, now: NOW });
    const realText = command.describeCompactionResult('memory', real, false);
    assert.match(realText, /已淘汰：/);
    assert.match(realText, /冷缺省档：已删 2 条/, `真删文案要单独说冷缺省：\n${realText}`);
    setLimits();
});

/* ═════════════ 6) 写前自动压缩拿不到这个开关 ═════════════ */
await check('写前自动压缩（runCompaction 不带 coldDefaults）绝不会删冷缺省条目', async () => {
    setup(0.93);
    const before = memoryText();
    const deps = { latestCwd: () => projectRoot, workspaceIdOf: () => undefined, sessionFor: () => undefined, callModel: null };
    const result = await command.runCompaction('memory', { cwd: projectRoot, trigger: 'insert' }, { compactionEnabled: true }, deps);
    assert.equal(result.coldDefaults, false);
    assert.equal(result.evicted.length, 0);
    assert.equal(memoryText(), before);
    setLimits();
});

/* ── 汇总 ── */
console.log('');
if (failures.length > 0) {
    console.log(`失败 ${failures.length} / ${checks}：${failures.join('、')}`);
    process.exit(1);
}
console.log(`冷缺省档用例全部通过（${checks} 条）`);
