/**
 * 回归测试：`lib/compaction.js` + `lib/locks.js` + `lib/store.js` 的压缩管线（0.8.0 · P4）。
 *
 * 覆盖 PLAN/01 §4 的验收点：
 *  1. 水位 < 85% ⇒ 跳过（`below-watermark`）；
 *  2. FACT 合并保留具体值（版本号 / 路径），合并后水位下降且能回滚；
 *  3. 合并结果 >120 字 / 把具体值压没了 ⇒ 拒绝，一个字节都不写；
 *  4. 淘汰按评分（0.4 近因 + 0.3 命中 + 0.2 置信度 + 0.1 人工标记）从低到高，最多 5 条；
 *  5. 保护区：显式锁定 + `<!-- keep -->` + 当前工作区条目 —— 永不自动淘汰；
 *  6. 侧车索引缺失/损坏 ⇒ 淘汰整体跳过（宁可不压缩也不盲删）；
 *  7. 75% 是**下限**：不会为了缓冲把水位一次砸穿；
 *  8. MEMORY 只淘汰、绝不合并（callModel 一次都不许被调）；
 *  9. 淘汰后仍 ≥100% ⇒ `MEMORY_BUDGET_EXCEEDED`；
 * 10. 压缩与并发写入同时发生：不丢行（本轮直接放弃）；
 * 11. 回滚：从 `.bak` 恢复，SHA256 与压缩前一致；备份被改过则拒回滚；
 * 12. `compactionEnabled:false` ⇒ `insertEntry` 落盘结果与不装压缩器**逐字节相同**。
 *
 * 跑法：node test/compaction.test.mjs
 * （run-all.ps1 第 3 步跑仓库源码；第 10 步用 PERSONA_MEMORY_STORE_ENTRY 指向已装份复跑，
 *   已装份没有 `lib/compaction.js` 时第 10 步自动跳过。）
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-compaction-'));
process.env.DSH_HOME = home;

const defaultStorePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'store.js');
const storeUrl = process.env.PERSONA_MEMORY_STORE_ENTRY ?? pathToFileURL(defaultStorePath).href;
const store = await import(storeUrl);
const compaction = await import(new URL('./compaction.js', storeUrl).href);
const locks = await import(new URL('./locks.js', storeUrl).href);

const memoryDir = store.memoryDir();
const factPath = store.factPath();
const indexPath = join(memoryDir, 'index.json');
const locksPath = join(memoryDir, 'locks.json');
const auditPath = join(memoryDir, 'compaction.jsonl');
const backupsDir = join(memoryDir, 'backups');
mkdirSync(memoryDir, { recursive: true });

/* 假项目：根目录自带 MEMORY.md。 */
const projectRoot = join(home, 'proj');
const memoryPath = join(projectRoot, 'MEMORY.md');
mkdirSync(projectRoot, { recursive: true });

/* 小上限把水位逼到 85% / 100% 附近，省得为了测试造几 KB 中文样本（上限是运行时可配的）。 */
const LIMITS = { maxFactLines: 100, maxFactBytes: 1200, maxProjectChars: 600 };
const setLimits = (patch = {}) => store.configureStore({ ...LIMITS, compactionEnabled: false, ...patch });
setLimits();

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const factText = () => readFileSync(factPath, 'utf8');
const memoryText = () => readFileSync(memoryPath, 'utf8');
const factRatio = () => compaction.ratioOf(store.watermark('fact'));
const resetAudit = () => rmSync(auditPath, { force: true });
/** 让一份正文刚好落在 `ratio` 水位上（FACT 按字节、MEMORY 按字符）。 */
const factLimitFor = (text, ratio) => Math.max(1, Math.round(store.countBytes(text) / ratio));
const memoryLimitFor = (text, ratio) => Math.max(1, Math.round(store.countChars(text) / ratio));

const FACT_HEAD = ['# FACT.md — 全局长期记忆', '', '## 关于用户', '', '- 称呼「呜咕」', ''];
const ENV_A = 'node 用 v22.23.3，adb 用 platform-tools 目录里那份';
const ENV_B = 'node 用 v22.23.3，adb 在 platform-tools 目录里那份';
const FILLER = (index) => `- 备忘第 ${index} 条：装配站里的临时文件与草稿不放进仓库，也不写进记忆`;

/** 造一份 FACT.md：`env` 条目（自动补 `- `）+ `## 备忘` 下的填充行，直到字节 ≥ targetBytes。 */
function buildFact({ env = [], targetBytes = 0 } = {}) {
    const head = [...FACT_HEAD, '## 环境', '', ...env.map((text) => (text.startsWith('- ') ? text : `- ${text}`)), ''];
    const notes = [];
    let text = `${[...head, '## 备忘', '', ...notes].join('\n')}\n`;
    let extra = 0;
    while (store.countBytes(text) < targetBytes) {
        extra += 1;
        notes.push(FILLER(extra));
        text = `${[...head, '## 备忘', '', ...notes].join('\n')}\n`;
    }
    return text;
}

/** 直接写 sidecar 索引（`memoryIndex()` 会按正文复算 id，构造时必须自洽）。 */
function writeIndex(records, scope = 'fact') {
    const entries = {};
    for (const item of records) {
        entries[store.entryId(item.firstSeen, item.text)] = {
            scope,
            workspaceId: item.workspaceId ?? null,
            firstSeen: item.firstSeen,
            lastHit: item.lastHit ?? item.firstSeen,
            hits: item.hits ?? 1,
            confidence: item.confidence ?? 'medium',
            ...(scope === 'memory' ? { path: memoryPath } : {}),
        };
    }
    writeFileSync(indexPath, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8');
    return entries;
}

/** 写正文 + 清索引/锁定，返回该正文对应的 fact 上限。 */
function resetFact(text, ratio) {
    writeFileSync(factPath, text, 'utf8');
    rmSync(indexPath, { force: true });
    rmSync(locksPath, { force: true });
    const limit = ratio === undefined ? undefined : factLimitFor(text, ratio);
    if (limit !== undefined)
        setLimits({ maxFactBytes: limit });
    return limit;
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

/* ═════════════════════════ 1) 水位与跳过 ═════════════════════════ */
await check('水位 < 85% ⇒ 跳过（skipped=below-watermark），文件一字未动', async () => {
    setLimits();
    const text = buildFact({ env: [ENV_A, ENV_B], targetBytes: 600 });
    writeFileSync(factPath, text, 'utf8');
    rmSync(indexPath, { force: true });
    resetAudit();
    assert.ok(factRatio() < 0.85, `样本水位应 <0.85，实际 ${factRatio()}`);
    const before = sha(factPath);
    const result = await compaction.compact('fact', { callModel: async () => '- x' });
    assert.equal(result.skipped, 'below-watermark');
    assert.equal(sha(factPath), before);
});

/* ═════════════════════════ 2) FACT 合并 ═════════════════════════ */
await check('FACT 合并：保留版本号与路径，合并后水位下降，审计记录齐全', async () => {
    setLimits();
    const text = buildFact({ env: [ENV_A, ENV_B], targetBytes: 1060 });
    writeFileSync(factPath, text, 'utf8');
    rmSync(indexPath, { force: true });
    rmSync(locksPath, { force: true });
    resetAudit();
    const before = sha(factPath);
    const ratioBefore = factRatio();
    assert.ok(ratioBefore >= 0.85 && ratioBefore < 1, `样本水位应在 85%~100%，实际 ${ratioBefore}`);
    const mergedLine = 'node v22.23.3；adb 用 platform-tools\\adb.exe';
    const calls = [];
    const callModel = async (prompt) => {
        calls.push(prompt);
        return prompt.includes('v22.23.3') ? mergedLine : '';
    };
    const result = await compaction.compact('fact', { callModel });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.merged.length, 1, `应合并 1 组，实际 ${JSON.stringify(result.merged)}`);
    assert.ok(calls.length >= 1, 'callModel 应至少被调用一次');
    const after = factText();
    assert.ok(after.includes(mergedLine), '合并后的新行必须落盘');
    assert.ok(!after.includes(ENV_A), '原条目 A 应被合并掉');
    assert.ok(!after.includes(ENV_B), '原条目 B 应被合并掉');
    assert.ok(result.ratio < ratioBefore, `${result.ratio} 应小于 ${ratioBefore}`);
    assert.equal(result.evicted.length, 0, '合并后已不超限，不该再淘汰');
    const records = compaction.readAudit(50);
    const last = records[records.length - 1];
    assert.equal(last.scope, 'fact');
    assert.equal(last.merged.length, 1);
    assert.equal(last.merged[0].to, mergedLine);
    assert.equal(last.before.sha256, before);
    assert.ok(typeof last.backup === 'string' && last.backup.endsWith('.bak'));
    assert.match(last.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(sha(factPath) !== before);
});

await check('groupFactCandidates：只在同一个 ## 分组内成组，跳过 <!-- keep --> 的条目', () => {
    const keepRaw = '- adb 用 platform-tools 目录里那份 node v22.23.3 <!-- keep -->';
    const entries = [
        { line: 0, section: '环境', text: ENV_A, lineTexts: [`- ${ENV_A}`], raw: `- ${ENV_A}` },
        { line: 1, section: '环境', text: ENV_B, lineTexts: [`- ${ENV_B}`], raw: `- ${ENV_B}` },
        { line: 2, section: '环境', text: 'adb 用 platform-tools 目录里那份 node v22.23.3', lineTexts: [keepRaw], raw: keepRaw },
        { line: 3, section: '长期约定', text: ENV_A, lineTexts: [`- ${ENV_A}`], raw: `- ${ENV_A}` },
    ];
    const groups = compaction.groupFactCandidates(entries);
    assert.equal(groups.length, 1, `应只有 1 组，实际 ${JSON.stringify(groups.map((group) => group.section))}`);
    assert.equal(groups[0].section, '环境');
    assert.equal(groups[0].entries.length, 2);
    assert.ok(!groups[0].entries.some((entry) => entry.line === 2), 'keep 条目不该进合并组');
});

/* ═════════════════════════ 3) 合并结果校验 ═════════════════════════ */
await check('parseMergeResult：>120 字拒绝、丢光具体值拒绝、多行拒绝、正常单行放行', () => {
    const long = `v22.23.3 ${'x'.repeat(112)}`;
    assert.ok(long.length > 120);
    const tooLong = compaction.parseMergeResult(long);
    assert.equal(tooLong.ok, false);
    assert.match(tooLong.reason, /120/);
    const lost = compaction.parseMergeResult('环境已就绪', { sources: [ENV_A, ENV_B] });
    assert.equal(lost.ok, false);
    assert.match(lost.reason, /具体值/);
    assert.equal(compaction.parseMergeResult('- a v1\n- b v2').ok, false);
    const good = compaction.parseMergeResult('- node v22.23.3；adb 用 platform-tools\\adb.exe');
    assert.equal(good.ok, true);
    assert.equal(good.text, 'node v22.23.3；adb 用 platform-tools\\adb.exe');
});

await check('合并结果 >120 字 ⇒ 拒绝，端到端一个字节都不写', async () => {
    setLimits();
    const text = buildFact({ env: [ENV_A, ENV_B], targetBytes: 1060 });
    writeFileSync(factPath, text, 'utf8');
    rmSync(indexPath, { force: true });
    resetAudit();
    const before = sha(factPath);
    const result = await compaction.compact('fact', {
        callModel: async (prompt) => (prompt.includes('v22.23.3') ? `v22.23.3 ${'x'.repeat(112)}` : ''),
    });
    assert.equal(result.merged.length, 0);
    assert.equal(sha(factPath), before, '被拒绝的合并绝不能落盘');
});

/* ═════════════════════════ 4) 评分与淘汰顺序 ═════════════════════════ */
await check('scoreEntry：四项加权，缺元数据 ⇒ 1（永不淘汰）', () => {
    const now = Date.UTC(2026, 9, 31);
    const top = compaction.scoreEntry({ lastHit: now, firstSeen: now, hits: 10, confidence: 'high', locked: true }, now);
    assert.equal(top, 1);
    const cold = compaction.scoreEntry({ lastHit: now - 200 * 86400000, firstSeen: now - 200 * 86400000, hits: 0, confidence: 'low' }, now);
    assert.ok(cold < 0.3, `冷条目分数应很低，实际 ${cold}`);
    assert.ok(compaction.scoreEntry({ lastHit: now, firstSeen: now, hits: 10, confidence: 'high' }, now) < top, '人工标记应抬高分数');
    assert.equal(compaction.scoreEntry(null, now), 1);
    assert.equal(compaction.scoreEntry(undefined, now), 1);
    assert.equal(compaction.scoreEntry({}, now), 1, '字段全缺 ⇒ 保守满分');
});

await check('selectEvictions：按评分从低到高、最多 5 条', () => {
    const now = Date.UTC(2026, 9, 31);
    const lines = ['- 条目甲 node v1', '- 条目乙 adb v2', '- 条目丙 path v3', '- 条目丁 key v4', '- 条目戊 abc v5', '- 条目己 xyz v6'];
    const raw = `# FACT.md\n\n## 环境\n\n${lines.join('\n')}\n`;
    writeFileSync(factPath, raw, 'utf8');
    const records = lines.map((text, index) => ({
        text,
        firstSeen: now - (index + 1) * 30 * 86400000,
        hits: index,
        confidence: index === 0 ? 'low' : 'high',
    }));
    const indexEntries = writeIndex(records);
    const entries = compaction.resolveEntryIds(compaction.parseEntries('fact', raw), { version: 1, entries: indexEntries });
    const picked = compaction.selectEvictions(entries, store.memoryIndex(), {
        now,
        watermark: { lines: 10, bytes: 1190, chars: 300, limit: { lines: 100, bytes: 1200 } },
    });
    assert.equal(picked.length, 5, `最多 5 条，实际 ${picked.length}`);
    for (let index = 1; index < picked.length; index += 1)
        assert.ok(picked[index - 1].score <= picked[index].score, `应升序：${picked.map((item) => item.score)}`);
    const everyone = entries.map((entry) => ({ id: entry.id, score: compaction.scoreEntry(indexEntries[entry.id], now) }));
    const coldest = everyone.reduce((left, right) => (left.score <= right.score ? left : right));
    assert.equal(picked[0].id, coldest.id, `最冷的那条应排第一：${JSON.stringify(everyone)}`);
});

/* ═════════════════════════ 5) 保护区 ═════════════════════════ */
await check('保护区：显式锁定 + <!-- keep --> 永不淘汰（其它照删）', () => {
    const now = Date.now();
    const lines = [
        '- 锁定条 node v1',
        '- keep 条 adb v2 <!-- keep -->',
        '- 普通甲 path v3',
        '- 普通乙 key v4',
        '- 普通丙 abc v5',
        '- 普通丁 xyz v6',
    ];
    const raw = `# FACT.md\n\n## 环境\n\n${lines.join('\n')}\n`;
    writeFileSync(factPath, raw, 'utf8');
    rmSync(locksPath, { force: true });
    const records = lines.map((text, index) => ({
        text,
        firstSeen: now - (index + 1) * 40 * 86400000,
        hits: index,
        confidence: index === 0 ? 'low' : 'high',
    }));
    const indexEntries = writeIndex(records);
    const lockedId = store.entryId(records[0].firstSeen, records[0].text);
    locks.setLock('fact', lockedId);
    const entries = compaction.resolveEntryIds(compaction.parseEntries('fact', raw), { version: 1, entries: indexEntries });
    const picked = compaction.selectEvictions(entries, store.memoryIndex(), {
        now,
        watermark: { lines: 8, bytes: 1180, chars: 300, limit: { lines: 100, bytes: 1200 } },
    });
    assert.ok(!picked.some((item) => item.id === lockedId), '锁定条目不该出现在淘汰名单里');
    assert.ok(!picked.some((item) => item.text.includes('keep')), 'keep 条目不该出现在淘汰名单里');
    assert.ok(picked.length >= 1, '未受保护的条目应该照常淘汰');
    locks.unsetLock('fact', lockedId);
});

await check('保护区：当前工作区的 project 条目（给了 workspaceId 时）不淘汰', () => {
    const now = Date.now();
    const lines = ['- 本工作区条目 node v1', '- 别的条目 adb v2'];
    const raw = `# FACT.md\n\n## 环境\n\n${lines.join('\n')}\n`;
    writeFileSync(factPath, raw, 'utf8');
    rmSync(locksPath, { force: true });
    const indexEntries = writeIndex([
        { text: lines[0], firstSeen: now - 90 * 86400000, hits: 0, confidence: 'low', workspaceId: 'ws-live' },
        { text: lines[1], firstSeen: now - 60 * 86400000, hits: 0, confidence: 'low', workspaceId: 'ws-other' },
    ]);
    const entries = compaction.resolveEntryIds(compaction.parseEntries('fact', raw), { version: 1, entries: indexEntries });
    const picked = compaction.selectEvictions(entries, store.memoryIndex(), {
        now,
        workspaceId: 'ws-live',
        watermark: { lines: 5, bytes: 1190, chars: 200, limit: { lines: 100, bytes: 1200 } },
    });
    assert.equal(picked.length, 1, `只该淘汰别的条目，实际 ${JSON.stringify(picked.map((item) => item.text))}`);
    assert.ok(picked[0].text.includes('别的条目'));
});

/* ═════════════════════════ 6) 索引缺失 ═════════════════════════ */
await check('侧车索引缺失 ⇒ 淘汰整体跳过（文件 SHA 不变）', async () => {
    setLimits();
    const text = buildFact({ env: [ENV_A, ENV_B], targetBytes: 1240 });
    writeFileSync(factPath, text, 'utf8');
    rmSync(indexPath, { force: true });
    resetAudit();
    assert.ok(factRatio() >= 1, `样本应已超限，实际 ${factRatio()}`);
    const before = sha(factPath);
    const result = await compaction.compact('fact', { callModel: null });
    assert.equal(sha(factPath), before, '没有索引就一条都不许删');
    assert.equal(result.evicted.length, 0);
});

await check('selectEvictions：meta 为 null / 空索引 ⇒ 返回 []；有元数据才算分', () => {
    const entries = [{ id: 'a', scope: 'fact', text: 'x', line: 0, lines: [0], lineTexts: ['- x'] }];
    assert.deepEqual(compaction.selectEvictions(entries, null, {}), []);
    assert.deepEqual(compaction.selectEvictions(entries, { version: 1, entries: {} }, {}), []);
    const one = compaction.selectEvictions(entries, { entries: { a: { scope: 'fact', firstSeen: 1, hits: 0 } } }, {});
    assert.equal(one.length, 1);
});

await check('索引损坏（坏 JSON）⇒ 当成空索引，不抛错', async () => {
    setLimits();
    const text = buildFact({ env: [ENV_A, ENV_B], targetBytes: 1240 });
    writeFileSync(factPath, text, 'utf8');
    writeFileSync(indexPath, '{ this is not json', 'utf8');
    const before = sha(factPath);
    const result = await compaction.compact('fact', { callModel: null });
    assert.equal(result.evicted.length, 0);
    assert.equal(sha(factPath), before);
});

/* ═════════════════════════ 7) 75% 下限 ═════════════════════════ */
await check('75% 是下限：删到再删就跌破 75% 时停手（宁可少删）', async () => {
    const now = Date.now();
    const lines = Array.from({ length: 12 }, (_, index) => `- 条目${index + 1} node v${index + 1}.0.0 装配站里的临时文件与草稿不放进仓库，也不写进记忆`);
    const raw = `# FACT.md — 全局长期记忆\n\n## 环境\n\n${lines.join('\n')}\n`;
    const limit = resetFact(raw, 1.008);
    const records = lines.map((text) => ({ text, firstSeen: now - 100 * 86400000, hits: 0, confidence: 'low' }));
    writeIndex(records);
    assert.ok(factRatio() >= 1, `样本应已超限，实际 ${factRatio()}（limit=${limit}）`);
    const result = await compaction.compact('fact', { callModel: null });
    assert.ok(result.evicted.length > 0, '应该真的删了几条');
    assert.ok(result.ratio >= 0.75, `水位不许低于 75%，实际 ${result.ratio}`);
    assert.ok(result.ratio < 1, `删完应该不再超限，实际 ${result.ratio}`);
    assert.equal(result.evicted.length, 3, `应删 3 条后停手，实际 ${result.evicted.length}（${result.ratio}）`);
    setLimits();
});

await check('75% 下限是硬的：删一条就会砸穿 ⇒ 一条都不删，报 MEMORY_BUDGET_EXCEEDED', async () => {
    const now = Date.now();
    // 两条大条目、水位 ~101%：删任意一条都会掉到 ~50% ⇒ 越界，宁可不删
    const lines = Array.from({ length: 2 }, (_, index) => `- 大条目${index + 1} node v${index + 1}.0.0 装配站里的临时文件与草稿不放进仓库，也不写进记忆，这一条故意写得很长很长很长很长很长很长很长很长很长很长很长`);
    const raw = `# FACT.md — 全局长期记忆\n\n## 环境\n\n${lines.join('\n')}\n`;
    resetFact(raw, 1.01);
    writeIndex(lines.map((text) => ({ text, firstSeen: now - 100 * 86400000, hits: 0, confidence: 'low' })));
    const before = sha(factPath);
    const result = await compaction.compact('fact', { callModel: null });
    assert.equal(result.evicted.length, 0, '越界的那种删法不许做');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'MEMORY_BUDGET_EXCEEDED');
    assert.equal(sha(factPath), before, '没删任何东西就别动文件');
    setLimits();
});

/* ═════════════════════════ 8) MEMORY 只淘汰 ═════════════════════════ */
await check('MEMORY 只淘汰、绝不合并（callModel 一次都不许被调）', async () => {
    setLimits();
    const now = Date.now();
    const childs = Array.from({ length: 6 }, (_, index) => `第 ${index + 1} 条子项：装配站里的临时文件与草稿不放进仓库，也不写进记忆`);
    const numbered = childs.map((child, index) => `结论 ${index + 1} node v${index + 1}.0.0`);
    const raw = `# MEMORY.md — 项目记忆\n\n${numbered.map((line, index) => `${index + 1}. ${line}\n   - ${childs[index]}`).join('\n\n')}\n`;
    writeFileSync(memoryPath, raw, 'utf8');
    rmSync(indexPath, { force: true });
    rmSync(locksPath, { force: true });
    setLimits({ maxProjectChars: memoryLimitFor(raw, 1.05) });
    const records = numbered.map((text) => ({ text, firstSeen: now - 100 * 86400000, hits: 0, confidence: 'low' }));
    writeIndex(records, 'memory');
    const ratio = compaction.ratioOf(store.watermark('memory', { cwd: projectRoot }));
    assert.ok(ratio >= 1, `样本应已超限，实际 ${ratio}`);
    let called = 0;
    const result = await compaction.compact('memory', {
        cwd: projectRoot,
        callModel: async () => {
            called += 1;
            return '- 不该被调用';
        },
    });
    assert.equal(called, 0, 'MEMORY 不该走合并');
    assert.equal(result.merged.length, 0);
    assert.ok(result.evicted.length > 0, 'MEMORY 应该走淘汰');
    const after = memoryText();
    assert.ok(!after.includes('结论 1 node v1.0.0'), '被淘汰的编号条目应消失（连带子项）');
    assert.ok(!after.includes('第 1 条子项'), '子项必须一起走，不能留孤儿');
    assert.ok(after.includes('# MEMORY.md'), '标题必须留着');
    assert.equal(compaction.parseEntries('memory', after).length + result.evicted.length, 6);
    setLimits();
});

/* ═════════════════════════ 9) 仍超限 ⇒ 预算错误 ═════════════════════════ */
await check('淘汰后仍 ≥100% ⇒ MEMORY_BUDGET_EXCEEDED（全部锁定）', async () => {
    setLimits();
    const now = Date.now();
    const lines = Array.from({ length: 3 }, (_, index) => `- 锁定条目${index + 1} node v${index + 1}.0.0 装配站里的临时文件与草稿不放进仓库，也不写进记忆`);
    const raw = `# FACT.md\n\n## 环境\n\n${lines.join('\n')}\n`;
    resetFact(raw, 1.05);
    const records = lines.map((text) => ({ text, firstSeen: now - 100 * 86400000, hits: 0, confidence: 'low' }));
    writeIndex(records);
    for (const record of records)
        locks.setLock('fact', store.entryId(record.firstSeen, record.text));
    const result = await compaction.compact('fact', { callModel: null });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error, 'MEMORY_BUDGET_EXCEEDED');
    assert.equal(result.evicted.length, 0);
    for (const record of records)
        locks.unsetLock('fact', store.entryId(record.firstSeen, record.text));
    setLimits();
});

/* ═════════════════════════ 10) 回滚 ═════════════════════════ */
await check('回滚：从 .bak 恢复后 SHA256 与压缩前一致；备份被改过则拒绝', async () => {
    setLimits();
    const text = buildFact({ env: [ENV_A, ENV_B], targetBytes: 1060 });
    writeFileSync(factPath, text, 'utf8');
    rmSync(indexPath, { force: true });
    resetAudit();
    const before = sha(factPath);
    const result = await compaction.compact('fact', {
        callModel: async (prompt) => (prompt.includes('v22.23.3') ? 'node v22.23.3；adb 用 platform-tools\\adb.exe' : ''),
    });
    assert.equal(result.merged.length, 1);
    const record = compaction.readAudit(50).pop();
    const stamp = record.backup.match(/(\d{8}-\d{6})/)[1];
    const rolled = await compaction.rollbackCompaction(stamp);
    assert.equal(rolled.ok, true, JSON.stringify(rolled));
    assert.equal(sha(factPath), before, '回滚后必须与压缩前逐字节一致');
    assert.equal(factText().includes(ENV_A), true);
    // 备份被改过 ⇒ SHA 对不上 ⇒ 拒回滚，文件保持原样
    writeFileSync(record.backup, '被篡改的备份\n', 'utf8');
    const snapshot = sha(factPath);
    const bad = await compaction.rollbackCompaction(stamp);
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'SHA256_MISMATCH');
    assert.equal(sha(factPath), snapshot);
    assert.equal((await compaction.rollbackCompaction('20990101-000000')).error, 'NO_BACKUP');
    assert.equal((await compaction.rollbackCompaction('')).error, 'BAD_TIMESTAMP');
});

await check('备份保留份数：默认只留 5 份', async () => {
    const raw = '# FACT.md\n\n## 环境\n\n- 一条 node v1\n';
    writeFileSync(factPath, raw, 'utf8');
    rmSync(backupsDir, { recursive: true, force: true });
    for (let index = 0; index < 8; index += 1) {
        compaction.writeBackup(factPath, raw, 5);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const names = readdirSync(backupsDir).filter((name) => name.startsWith('FACT.md-') && name.endsWith('.bak'));
    assert.equal(names.length, 5, `备份应正好留 5 份，实际 ${names.length}`);
});

/* ═════════════════════════ 11) 并发 ═════════════════════════ */
await check('并发：压缩期间有写入 ⇒ 本轮放弃，一行都不丢', async () => {
    setLimits();
    const text = buildFact({ env: [ENV_A, ENV_B], targetBytes: 1060 });
    writeFileSync(factPath, text, 'utf8');
    rmSync(indexPath, { force: true });
    resetAudit();
    const before = sha(factPath);
    const appended = '并发写入的结论 node v99.9.9';
    let insertedFlag = false;
    const result = await compaction.compact('fact', {
        callModel: async (prompt) => {
            if (!prompt.includes('v22.23.3'))
                return '';
            // 模拟"合并计划还在算的时候有人写了一条"（insertEntry 自己会拿写锁）
            const inserted = await store.insertEntry('fact', { text: appended, section: '环境' });
            insertedFlag = inserted.written === true;
            return 'node v22.23.3；adb 用 platform-tools\\adb.exe';
        },
    });
    assert.equal(insertedFlag, true, '并发写入本身应当成功');
    assert.equal(result.skipped, 'changed', `应放弃本轮，实际 ${JSON.stringify({ skipped: result.skipped, reason: result.reason })}`);
    assert.equal(result.merged.length, 0);
    const after = factText();
    assert.ok(after.includes(appended), '并发写入的那条必须还在');
    assert.ok(after.includes(ENV_A) && after.includes(ENV_B), '原本的两条也一条都不能丢');
    assert.ok(sha(factPath) !== before);
});

/* ═════════════════════════ 12) 关闭时行为逐字节相同 ═════════════════════════ */
await check('compactionEnabled=false ⇒ insertEntry 落盘结果与不装压缩器逐字节相同', async () => {
    setLimits();
    const raw = buildFact({ env: [ENV_A, ENV_B], targetBytes: 1060 });
    assert.ok(store.countBytes(raw) / store.limits().maxFactBytes >= 0.85, '样本水位应 ≥85%（用来证明压缩器"本该"被触发）');
    const payload = { text: '关闭压缩时写入的结论 node v5.5.5', section: '环境' };
    let called = 0;
    store.configureCompactor(() => {
        called += 1;
        return null;
    });
    writeFileSync(factPath, raw, 'utf8');
    const first = await store.insertEntry('fact', payload);
    assert.equal(first.written, true);
    const withCompactor = sha(factPath);
    assert.equal(called, 0, '关闭时压缩器一次都不许被调用');
    store.configureCompactor(null);
    writeFileSync(factPath, raw, 'utf8');
    const second = await store.insertEntry('fact', payload);
    assert.equal(second.written, true);
    assert.equal(sha(factPath), withCompactor, '关闭压缩时两种情况落盘结果必须逐字节相同');
});

await check('compactionEnabled=true 且水位 ≥85% ⇒ 写前自动压缩（压缩器被调用一次）', async () => {
    const text = buildFact({ env: [ENV_A, ENV_B], targetBytes: 1060 });
    const seen = [];
    store.configureStore({ ...LIMITS, compactionEnabled: true });
    store.configureCompactor(async (scope, options) => {
        seen.push({ scope, trigger: options?.trigger });
        return { ok: true, scope };
    });
    writeFileSync(factPath, text, 'utf8');
    const result = await store.insertEntry('fact', { text: '触发压缩的结论 node v7.7.7', section: '环境' });
    assert.equal(result.written, true);
    assert.equal(seen.length, 1, `压缩器应被调用一次，实际 ${JSON.stringify(seen)}`);
    assert.equal(seen[0].scope, 'fact');
    assert.equal(seen[0].trigger, 'insert');
    store.configureCompactor(null);
    setLimits();
});

await check('compactionEnabled=true 但水位 < 85% ⇒ 压缩器不被调用', async () => {
    const text = buildFact({ env: [ENV_A, ENV_B], targetBytes: 400 });
    let called = 0;
    store.configureStore({ ...LIMITS, compactionEnabled: true });
    store.configureCompactor(() => {
        called += 1;
        return null;
    });
    writeFileSync(factPath, text, 'utf8');
    await store.insertEntry('fact', { text: '低水位写入的结论 node v8.8.8', section: '环境' });
    assert.equal(called, 0);
    store.configureCompactor(null);
    setLimits();
});

/* ═════════════════════════ 13) 锁定表 ═════════════════════════ */
await check('locks：set/unset/list/isLocked + 作用域归一化', () => {
    rmSync(locksPath, { force: true });
    assert.deepEqual(locks.listLocks(), []);
    const set = locks.setLock('global', 'abc123');
    assert.equal(set.ok, true);
    assert.equal(set.key, 'fact:abc123');
    assert.equal(locks.isLocked('fact', 'abc123'), true);
    assert.equal(locks.isLocked('memory', 'abc123'), false);
    locks.setLock('project', 'def456');
    const list = locks.listLocks();
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((item) => item.key), ['fact:abc123', 'memory:def456']);
    assert.equal(locks.listLocks('fact').length, 1);
    const removed = locks.unsetLock('fact', 'abc123');
    assert.equal(removed.removed, true);
    assert.equal(locks.isLocked('fact', 'abc123'), false);
    const nothing = locks.unsetLock('fact', 'nope');
    assert.equal(nothing.ok, true);
    assert.equal(nothing.removed, false);
    assert.equal(locks.setLock('fact', '  ').ok, false);
});

await check('locks：坏文件 ⇒ 当空表、不抛错，且还能恢复写入', () => {
    writeFileSync(locksPath, 'not json at all', 'utf8');
    assert.deepEqual(locks.listLocks(), []);
    assert.deepEqual(locks.readLocks(), { version: 1, entries: {} });
    assert.equal(locks.isLocked('fact', 'x'), false);
    writeFileSync(locksPath, JSON.stringify({ version: 9, entries: { 'fact:x': { locked: true } } }), 'utf8');
    assert.deepEqual(locks.listLocks(), []);
    writeFileSync(locksPath, JSON.stringify({ version: 1, entries: { 'fact:x': { locked: 'yes' }, 'fact:y': { locked: true, at: 5 } } }), 'utf8');
    assert.deepEqual(locks.listLocks().map((item) => item.key), ['fact:y']);
    assert.equal(locks.setLock('fact', 'z').ok, true);
    assert.equal(locks.isLocked('fact', 'z'), true);
    rmSync(locksPath, { force: true });
});

/* ═════════════════════════ 14) 面板状态 / dryRun ═════════════════════════ */
await check('compactionStatus：水位 / 锁定 / 最近一次运行都在', () => {
    const status = compaction.compactionStatus({ cwd: projectRoot, enabled: false });
    assert.equal(status.triggerRatio, 0.85);
    assert.equal(status.targetRatio, 0.75);
    assert.equal(status.maxEvictions, 5);
    assert.equal(typeof status.watermark.fact.ratio, 'number');
    assert.ok(Array.isArray(status.locked));
    assert.ok(status.paths.audit.endsWith('compaction.jsonl'));
    assert.ok(status.paths.backups.endsWith('backups'));
});

await check('dryRun：只出计划不落盘', async () => {
    setLimits();
    const text = buildFact({ env: [ENV_A, ENV_B], targetBytes: 1060 });
    writeFileSync(factPath, text, 'utf8');
    rmSync(indexPath, { force: true });
    resetAudit();
    const before = sha(factPath);
    const result = await compaction.compact('fact', {
        dryRun: true,
        callModel: async (prompt) => (prompt.includes('v22.23.3') ? 'node v22.23.3；adb 用 platform-tools\\adb.exe' : ''),
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.merged.length, 1, 'dryRun 也要算出计划');
    assert.equal(sha(factPath), before, 'dryRun 绝不落盘');
});

/* ══════════════════ 15) 插件接线：/memory-compact 命令 + 面板路由 ══════════════════
 * 只在仓库源码那一轮跑（第 10 步跑已装份时用 PERSONA_MEMORY_STORE_ENTRY 指路，
 * 而这里要 import 仓库的 lib/index.js + schemastery，不混用）。 */
if (process.env.PERSONA_MEMORY_STORE_ENTRY === undefined) {
    await check('插件接线：/memory-compact 命令与面板路由（返回 {kind,text}，绝不抛错）', async () => {
        const entry = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.js')).href;
        const plugin = await import(entry);
        let registeredCommand = null;
        const routes = new Map();
        const commands = {
            register(spec) {
                registeredCommand = spec;
                return () => { };
            },
        };
        const webServer = {
            register(spec) {
                routes.set(`${spec.path}`, spec.handler);
                return () => { };
            },
        };
        const scopes = [];
        const fakeCtx = {
            get: (name) => {
                if (name === 'commands')
                    return commands;
                if (name === 'webServer')
                    return webServer;
                return undefined;
            },
            inject: (deps, callback) => {
                scopes.push(deps.join(','));
                if (deps.includes('commands') || deps.includes('webServer'))
                    callback(fakeCtx);
            },
            effect: (fn) => {
                fn();
            },
            on: () => { },
            provide: () => { },
            logger: { info: () => { }, warn: () => { } },
        };
        plugin.apply(fakeCtx, { compactionEnabled: true, maxFactBytes: LIMITS.maxFactBytes, maxFactLines: LIMITS.maxFactLines, maxProjectChars: LIMITS.maxProjectChars });
        assert.ok(registeredCommand !== null, '/memory-compact 应已注册');
        assert.equal(registeredCommand.name, 'memory-compact');
        assert.ok(Array.isArray(scopes) && scopes.includes('commands'), 'commands 应通过 ctx.inject 等就绪');
        const agent = { session: { header: { cwd: projectRoot } } };
        const run = (rawInput) => registeredCommand.handler({ rawInput, agent });

        const usage = await run('');
        assert.equal(usage.kind, 'error');
        assert.match(usage.text, /用法/);
        const unknown = await run('bogus');
        assert.equal(unknown.kind, 'error');
        assert.match(unknown.text, /用法/);

        const text = buildFact({ env: [ENV_A, ENV_B], targetBytes: 400 });
        writeFileSync(factPath, text, 'utf8');
        const dry = await run('fact dry');
        assert.equal(dry.kind, 'success', JSON.stringify(dry));
        assert.match(dry.text, /\[dry\]/);
        assert.match(dry.text, /85%/);

        const stamp = await run('rollback 20990101-000000');
        assert.equal(stamp.kind, 'error');
        assert.match(stamp.text, /回滚失败/);
        assert.equal((await run('rollback')).kind, 'error');

        const memory = await run('memory dry');
        assert.equal(memory.kind, 'success');
        assert.match(memory.text, /MEMORY\.md/);
        assert.match(memory.text, /人工整理/, 'MEMORY 只淘汰，要提示人工整理');

        const all = await run('all dry');
        assert.equal(all.kind, 'success');
        assert.match(all.text, /FACT\.md/);
        assert.match(all.text, /MEMORY\.md/);

        // 关闭时命令必须直接拒绝（默认关闭 ⇒ 一切压缩入口都不动）
        plugin.apply(fakeCtx, { compactionEnabled: false, maxFactBytes: LIMITS.maxFactBytes, maxFactLines: LIMITS.maxFactLines, maxProjectChars: LIMITS.maxProjectChars });
        const disabled = await run('fact');
        assert.equal(disabled.kind, 'error');
        assert.match(disabled.text, /未启用/);

        // 面板路由：三个路径都注册上了，GET 返回状态信封
        assert.ok(routes.has('/persona-memory/api/memory/compaction'), `路由应有 compaction 状态：${[...routes.keys()]}`);
        assert.ok(routes.has('/persona-memory/api/memory/lock'));
        assert.ok(routes.has('/persona-memory/api/memory/unlock'));
        const readJson = async (handler, method, payload) => {
            const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))];
            const req = { method, [Symbol.asyncIterator]: async function* iterate() { for (const chunk of chunks)
                yield chunk; } };
            const res = {
                status: 0,
                body: '',
                writeHead(status) { this.status = status; },
                end(body) { this.body = body; },
            };
            handler(req, res);
            for (let wait = 0; wait < 40 && res.body === ''; wait += 1)
                await new Promise((resolve) => setTimeout(resolve, 5));
            return { status: res.status, json: res.body === '' ? null : JSON.parse(res.body) };
        };
        const status = await readJson(routes.get('/persona-memory/api/memory/compaction'), 'GET');
        assert.equal(status.status, 200);
        assert.equal(status.json.ok, true);
        assert.equal(status.json.compaction.triggerRatio, 0.85);
        const lock = await readJson(routes.get('/persona-memory/api/memory/lock'), 'POST', { id: 'abc', scope: 'fact' });
        assert.equal(lock.status, 200, JSON.stringify(lock));
        assert.ok(lock.json.compaction.locked.some((item) => item.key === 'fact:abc'));
        const unlock = await readJson(routes.get('/persona-memory/api/memory/unlock'), 'POST', { id: 'abc', scope: 'fact' });
        assert.equal(unlock.status, 200);
        assert.ok(!unlock.json.compaction.locked.some((item) => item.key === 'fact:abc'));
        const badLock = await readJson(routes.get('/persona-memory/api/memory/lock'), 'POST', { id: '' });
        assert.equal(badLock.status, 400, '缺 id 应该是 400 而不是崩');

        store.configureCompactor(null);
        setLimits();
        rmSync(locksPath, { force: true });
    });
}

/* ── 收尾 ── */
console.log(`\n# 环境：${JSON.stringify({ home, limits: store.limits(), backups: (() => {
    try {
        return readdirSync(backupsDir).length;
    }
    catch {
        return 0;
    }
})(), auditLines: compaction.readAudit(1000).length })}`);
if (failures.length > 0) {
    console.log(`\n✗ ${failures.length}/${checks} 失败：${failures.join('、')}`);
    process.exit(1);
}
console.log(`\n✓ ${checks}/${checks} 全部通过`);
try {
    rmSync(home, { recursive: true, force: true });
}
catch {
    /* 临时目录删不掉不影响结论 */
}
