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
 *  8. MEMORY 带子项的条目只淘汰、不改写（callModel 一次都不许被调）；叶子条目走合并/逐条精简；
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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

await check('同分（手写冷条目）时从文件尾部开始删：开头那几条核心结论要保住', () => {
    const now = Date.UTC(2026, 9, 31);
    const lines = Array.from({ length: 6 }, (_, index) => `- 条目${index + 1} node v${index + 1} 装配站里的临时文件不放进仓库`);
    const raw = `# FACT.md\n\n## 环境\n\n${lines.join('\n')}\n`;
    writeFileSync(factPath, raw, 'utf8');
    const records = lines.map((text) => ({ text, firstSeen: now - 100 * 86400000, hits: 0, confidence: 'low' }));
    const indexEntries = writeIndex(records);
    const entries = compaction.resolveEntryIds(compaction.parseEntries('fact', raw), { version: 1, entries: indexEntries });
    const picked = compaction.selectEvictions(entries, store.memoryIndex(), {
        now,
        maxEvictions: 2,
        watermark: { lines: 8, bytes: 1300, chars: 400, limit: { lines: 100, bytes: 1200 } },
    });
    // `parseEntries().text` 已去掉 `- ` 前缀，`line` 是整篇原文的 0 基行号（含前面的标题/空行），
    // 所以期望值直接从解析结果取，别拿带前缀的原文或手数行号去比。
    assert.deepEqual(picked.map((item) => item.text), [entries[5].text, entries[4].text], '同分应从尾部删');
    assert.deepEqual(picked.map((item) => item.line), [entries[5].line, entries[4].line], '同分应删靠后的行');
    assert.equal(picked[0].text, lines[5].replace(/^- /, ''), '期望值与原文（去前缀后）一致');
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

/* ═════════════════════════ 8) MEMORY 带子项 ⇒ 只淘汰 ═════════════════════════ */
await check('MEMORY 带子项的编号条目只淘汰、不合并（callModel 一次都不许被调）', async () => {
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
    assert.equal(called, 0, '带子项的条目不该走合并（合并会拆坏层级）');
    assert.equal(result.merged.length, 0);
    assert.ok(result.evicted.length > 0, 'MEMORY 应该走淘汰');
    const after = memoryText();
    assert.ok(after.includes('# MEMORY.md'), '标题必须留着');
    for (const item of result.evicted)
        assert.ok(!after.includes(item.text), `被淘汰的条目应消失：${item.text}`);
    // 子项必须跟着父条目一起走，不能留孤儿（具体删哪几条由评分/次序决定，这里只查一致性）
    for (const index of [1, 2, 3, 4, 5, 6]) {
        const parent = after.includes(`结论 ${index} node`);
        const child = after.includes(`第 ${index} 条子项`);
        assert.equal(parent, child, `条目${index}与子项必须同进同退（parent=${parent} child=${child}）`);
    }
    assert.equal(compaction.parseEntries('memory', after).length + result.evicted.length, 6);
    setLimits();
});

/* ═══════════════ 8b) MEMORY 叶子条目合并（编号连续、子项不动） ═══════════════ */
await check('MEMORY 叶子条目合并：保留编号、重排空洞、带子项与其它分组不动', async () => {
    setLimits();
    const leaf = (index) => `结论 ${index} node v22.23.3 装配站里的临时文件不放进仓库`;
    const raw = [
        '# MEMORY.md — 项目记忆',
        '',
        '## 结论区',
        '',
        `1. ${leaf(1)}`,
        `2. ${leaf(2)}`,
        `3. ${leaf(3)}`,
        `4. ${leaf(4)}`,
        '5. 带子项的条目 node v22.23.3',
        '   - 子项 A 不许丢',
        '',
        '## 别的分组',
        '',
        '1. 无关条目甲 node v1',
        '2. 别的分组不参与合并 node v2',
        '',
    ].join('\n');
    writeFileSync(memoryPath, raw, 'utf8');
    rmSync(indexPath, { force: true });
    rmSync(locksPath, { force: true });
    setLimits({ maxProjectChars: memoryLimitFor(raw, 0.9) });
    const before = sha(memoryPath);

    const preview = await compaction.compact('memory', {
        cwd: projectRoot,
        dryRun: true,
        callModel: async () => '叶子结论合并 node v22.23.3',
    });
    assert.ok(preview.merged.length >= 1, `dry 也要算出合并计划：${JSON.stringify(preview.merged)}`);
    assert.equal(sha(memoryPath), before, 'dry 绝不落盘');

    const result = await compaction.compact('memory', {
        cwd: projectRoot,
        callModel: async (prompt) => {
            assert.match(prompt, /MEMORY\.md/, 'MEMORY 的合并提示词应写 MEMORY.md');
            return '叶子结论合并 node v22.23.3';
        },
    });
    assert.ok(result.merged.length >= 1, `应发生 MEMORY 合并：${JSON.stringify(result)}`);
    const after = memoryText();
    assert.ok(after.includes('带子项的条目 node v22.23.3'), '带子项的条目必须原样留着');
    assert.ok(after.includes('子项 A 不许丢'), '子项一个字都不许丢');
    assert.ok(after.includes('别的分组不参与合并 node v2'), '没被合并的分组一字不改');
    // 结论区分组：合并后应在「编号 1」上，带子项那条顺延成 2（不得出现 1,5 这种空洞）
    const sectionBlock = after.split('## 别的分组')[0];
    const numbers = sectionBlock.split('\n')
        .map((line) => /^(\d+)\.\s+/.exec(line))
        .filter((match) => match !== null)
        .map((match) => Number(match[1]));
    assert.deepEqual(numbers, [1, 2], `结论区编号应连续，实际 ${numbers.join(',')}`);
    assert.match(sectionBlock, /^1\. 叶子结论合并/m, '合并结果要带上编号');
    assert.match(after.split('## 别的分组')[1], /^1\. 无关条目甲/m, '别的分组编号不动');
    setLimits();
});

/* ═══════════════ 8c) 逐条精简（0.8.2 · LLM 按模板压缩） ═══════════════ */
/** 三条**互不相似**的长叶子条目：合并层找不到组，只有逐条精简能动它们。 */
const SHORTEN_RAW = [
    '# MEMORY.md — 项目记忆',
    '',
    '## 结论区',
    '',
    '1. 装配站里的临时文件与草稿不放进仓库，也不写进记忆，这一条故意写得很长很长很长很长很长',
    '2. 云服务器的 ssh 配置与密钥轮换必须每周检查一次并且记录变更历史这一条同样很长很长很长',
    '3. 数据库备份保留三十天并且每天凌晨三点执行快照恢复演练这一条写得也不短很长很长很长很长',
    '4. 带子项的条目 node v22.23.3',
    '   - 子项 A 不许丢',
    '',
].join('\n');

await check('parseShortenResult：行数一一对应；单条不合格只跳过那一条', () => {
    const sources = ['结论甲 v22.23.3 装配站里的临时文件不放进仓库', '结论乙很短的条目'];
    const good = compaction.parseShortenResult('- 结论甲 v22.23.3\n- 结论乙', { sources });
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.deepEqual(good.lines, ['结论甲 v22.23.3', '结论乙']);
    // 行数不符 ⇒ 整批放弃（顺序映射会错位，不能猜）
    const mismatch = compaction.parseShortenResult('只有一行', { sources });
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.reason, /行数不符/);
    // 第 2 条没变短 ⇒ 那一条保留原样，第 1 条照压
    const partial = compaction.parseShortenResult('结论甲 v22.23.3\n结论乙很短的条目', { sources });
    assert.equal(partial.ok, true);
    assert.equal(partial.lines[0], '结论甲 v22.23.3');
    assert.equal(partial.lines[1], null, '没变短的那条必须保持原样');
    // 丢具体值 ⇒ 那一条保留原样
    const lost = compaction.parseShortenResult('结论甲\n结论乙', { sources });
    assert.equal(lost.ok, true);
    assert.equal(lost.lines[0], null, '丢了 v22.23.3 的改写不许用');
    assert.match(lost.rejected.join(' '), /具体值/);
});

await check('buildShortenPrompt(memory)：‖ 两段式 + 正文禁反引号 + 200 字上限（0.8.3）', () => {
    const prompt = compaction.buildShortenPrompt([{ text: '适配器仅 `napcat_main`，这一条故意写长一点好让改写有空间' }], {
        target: 'memory',
        section: '环境',
    });
    assert.ok(prompt.includes('速查'), 'MEMORY 的改写必须指向「## 速查」区');
    assert.ok(prompt.includes('‖'), '必须给出「正文‖速查项」的格式');
    assert.ok(prompt.includes(String(compaction.MEMORY_BODY_MAX_CHARS)), '正文上限要与条目模板同口径（200 字）');
    assert.ok(prompt.includes('不许出现反引号'), '正文禁行内代码要写进提示词');
    assert.ok(!prompt.includes('超过 120 字'), 'MEMORY 不该再套合并层的 120 字');
    const factPrompt = compaction.buildShortenPrompt([{ text: 'node 用 `v22.23.3`，这一条故意写长一点好让改写有空间' }], { target: 'fact' });
    assert.ok(factPrompt.includes(String(compaction.MERGE_MAX_CHARS)), 'FACT 仍是 120 字');
    assert.ok(factPrompt.includes('不要用反引号'), 'FACT 也要正文去行内代码');
    assert.ok(!factPrompt.includes('‖'), 'FACT 没有速查区，不该出现两段式格式');
});

await check('parseShortenResult：脱反引号不算丢具体值，‖ 之后是速查项（0.8.3 修复）', () => {
    const sources = ['适配器只保留 `napcat_main` 这一个（aiocqhttp；NapCat 反连 6196 / API 6197），qq_official 已经删掉了这一条要写得很长很长'];
    const answer = '适配器只留 napcat_main，反连 6196、6197，qq_official 已删‖napcat_main · 6196 · 6197';
    const parsed = compaction.parseShortenResult(answer, { sources, target: 'memory' });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.equal(parsed.lines[0], '适配器只留 napcat_main，反连 6196、6197，qq_official 已删');
    assert.deepEqual(parsed.quicks[0], ['napcat_main', '6196', '6197']);
    // 模型把反引号留在正文里也放行：程序统一脱掉（行内代码只是排版，不是信息）
    const residual = compaction.parseShortenResult('适配器只留 `napcat_main`，反连 `6196`、`6197`，qq_official 已删', { sources, target: 'memory' });
    assert.equal(residual.lines[0], '适配器只留 napcat_main，反连 6196、6197，qq_official 已删');
    // 真丢了具体值（6196/6197）照样拒
    const real = compaction.parseShortenResult('适配器只留 napcat_main，qq_official 已删', { sources, target: 'memory' });
    assert.equal(real.lines[0], null);
    assert.match(real.rejected.join(' '), /具体值/);
});

await check('applyPlan：速查项落到「## 速查」区（没有就新建），同项不重复', () => {
    const raw = ['# MEMORY.md', '', '## 关于用户', '', '- 称呼「呜咕」，这一条故意写得长一些好让改写真的更短', ''].join('\n');
    const entries = compaction.parseEntries('memory', raw);
    assert.equal(entries.length, 1);
    const plan = [{ section: '关于用户', entries, text: '称呼是呜咕', quick: ['称呼=呜咕', '称呼=呜咕'], kind: 'shorten' }];
    const applied = compaction.applyPlan('memory', raw, null, plan, {});
    assert.ok(applied.text.includes('## 速查'), '缺速查区时必须新建');
    assert.equal(applied.text.split('- 称呼=呜咕').length - 1, 1, '同一项只写一次');
    assert.ok(applied.text.includes('- 称呼是呜咕'), '正文要换成改写后的版本');
    assert.equal(applied.merged[0].kind, 'shorten');
    assert.deepEqual(applied.merged[0].quick, ['称呼=呜咕'], '审计里要能看出搬了什么');
});

await check('逐条精简：LLM 把每条改短，编号/子项原样保留，索引同步到新条目', async () => {
    setLimits();
    writeFileSync(memoryPath, SHORTEN_RAW, 'utf8');
    rmSync(indexPath, { force: true });
    rmSync(locksPath, { force: true });
    setLimits({ maxProjectChars: memoryLimitFor(SHORTEN_RAW, 1.3) });
    const ratioBefore = compaction.ratioOf(store.watermark('memory', { cwd: projectRoot }));
    assert.ok(ratioBefore >= 1, `样本应已超限，实际 ${ratioBefore}`);
    const before = sha(memoryPath);
    const result = await compaction.compact('memory', {
        cwd: projectRoot,
        callModel: async (prompt) => {
            if (!prompt.includes('逐条')) return ''; // 合并提示词一律不配合（这三条本来也不相似）
            const count = Number(/(\d+) 条结论/.exec(prompt)?.[1] ?? 0);
            return Array.from({ length: count }, (_, index) => `短结论 ${index + 1}`).join('\n');
        },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const shortened = (result.merged ?? []).filter((item) => item.kind === 'shorten');
    assert.equal(shortened.length, 3, `应逐条压缩 3 条，实际 ${JSON.stringify(result.merged)}`);
    assert.equal(result.merged.filter((item) => item.kind !== 'shorten').length, 0, '这三条不该被合并');
    assert.ok(result.ratio < ratioBefore, `水位应下降：${result.ratio} vs ${ratioBefore}`);
    const after = memoryText();
    assert.ok(after.includes('短结论 1') && after.includes('短结论 3'), '改写结果必须落盘');
    assert.match(after, /^1\. 短结论 1/m, '编号必须保留');
    assert.ok(after.includes('带子项的条目 node v22.23.3'), '带子项的条目一个字都不许动');
    assert.ok(after.includes('子项 A 不许丢'), '子项也要留着');
    assert.ok(sha(memoryPath) !== before);
    // 改写会让条目 id 变化 ⇒ 压缩后必须把索引同步成新正文，否则下一轮全是"缺元数据"
    const index = store.memoryIndex();
    const matched = ['短结论 1', '短结论 2', '短结论 3'].filter((text) => Object.entries(index.entries)
        .some(([id, meta]) => meta.path === memoryPath && store.entryId(meta.firstSeen, text) === id));
    assert.equal(matched.length, 3, `改写后的条目必须重新进索引，实际 ${matched.length}`);
});

/* 正文说人话 + 命令搬进「## 速查」区（PLAN 01 §3.2 / 0.8.3） */
const QUICK_RAW = [
    '# MEMORY.md — 项目记忆',
    '',
    '## 一、中转',
    '',
    '- 四个中转都在 `/opt` 下用 systemd 托管，日志统一在 `/var/log/<svc>.log`，其中 new-api 是网关，其余三个是中转，改完配置要重启对应服务再冒烟测一次；'
        + '这一段是纯噪音，用来把条目撑长，好让水位真的越过门槛并进入精简层，不要删掉，真的不要删掉。',
    '',
].join('\n');

await check('端到端：MEMORY 逐条精简把行内代码搬进「## 速查」，正文不再有反引号', async () => {
    setLimits();
    writeFileSync(memoryPath, QUICK_RAW, 'utf8');
    rmSync(indexPath, { force: true });
    rmSync(locksPath, { force: true });
    setLimits({ maxProjectChars: memoryLimitFor(QUICK_RAW, 1.05) });
    assert.ok(compaction.ratioOf(store.watermark('memory', { cwd: projectRoot })) >= 1, '样本应已超限');
    const answer = '四个中转用 systemd 托管，日志在 var/log 下，new-api 是网关、其余三个是中转，改完重启并冒烟测'
        + '‖/opt · /var/log/<svc>.log · new-api · systemctl restart';
    const result = await compaction.compact('memory', {
        cwd: projectRoot,
        callModel: async (prompt) => (prompt.includes('逐条') ? answer : ''),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const after = memoryText();
    assert.ok(after.includes('## 速查'), '缺速查区时必须新建');
    assert.ok(after.includes('- /opt'), `命令/路径要落到速查区：\n${after}`);
    const body = after.split('## 速查')[0];
    assert.ok(!body.includes('`'), `正文不许再有行内代码：\n${body}`);
    const shortened = (result.merged ?? []).find((item) => item.kind === 'shorten');
    assert.ok(shortened !== undefined, '应发生逐条精简');
    assert.ok(Array.isArray(shortened.quick) && shortened.quick.includes('/opt'), '审计里要记下搬走的速查项');
});

await check('逐条精简：行数不符 ⇒ 整批放弃，文件一个字节都不写', async () => {
    setLimits();
    writeFileSync(memoryPath, SHORTEN_RAW, 'utf8');
    rmSync(indexPath, { force: true });
    rmSync(locksPath, { force: true });
    setLimits({ maxProjectChars: memoryLimitFor(SHORTEN_RAW, 1.3) });
    const before = sha(memoryPath);
    const result = await compaction.compact('memory', {
        cwd: projectRoot,
        callModel: async () => '只有一行',
    });
    assert.equal(result.merged.length, 0, JSON.stringify(result.merged));
    assert.equal(result.changed, false);
    assert.equal(sha(memoryPath), before, '被拒绝的改写绝不能落盘');
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

/* ═══════════════ 15) 报告与 no-op（ISSUE-001 · P0） ═══════════════ */
await check('no-op 绝不写盘：只有尾部空行被归一化不算压缩', async () => {
    setLimits();
    const lines = Array.from({ length: 4 }, (_, index) => `- 条目${index + 1} node v${index + 1}.0.0 装配站里的临时文件与草稿不放进仓库，也不写进记忆`);
    // 故意用两个换行结尾：旧实现会把它归一化成一个，然后 backup + write + audit
    const raw = `# FACT.md\n\n## 环境\n\n${lines.join('\n')}\n\n`;
    resetFact(raw, 1.2);
    rmSync(indexPath, { force: true });
    resetAudit();
    const before = sha(factPath);
    const result = await compaction.compact('fact', { callModel: null });
    assert.equal(result.changed, false, JSON.stringify(result.reason));
    assert.equal(result.written, false);
    assert.equal(result.evicted.length, 0);
    assert.equal(sha(factPath), before, 'no-eviction 不许写盘（尾部空行归一化也不是压缩）');
    assert.equal(compaction.readAudit(1000).length, 0, 'no-op 不该产生审计记录');
    setLimits();
});

await check('索引缺失且 ≥100% ⇒ 如实报「缺元数据」并给出 seed 命令（不再说「已达淘汰上限」）', async () => {
    setLimits();
    const lines = Array.from({ length: 3 }, (_, index) => `- 条目${index + 1} node v${index + 1}.0.0 装配站里的临时文件与草稿不放进仓库，也不写进记忆`);
    const raw = `# FACT.md\n\n## 环境\n\n${lines.join('\n')}\n`;
    resetFact(raw, 1.1);
    rmSync(indexPath, { force: true });
    const before = sha(factPath);
    const result = await compaction.compact('fact', { callModel: null });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'MEMORY_BUDGET_EXCEEDED');
    assert.equal(result.diagnostics?.reason, 'index-missing', JSON.stringify(result.diagnostics));
    assert.equal(result.diagnostics?.missingMetadata, 3);
    assert.match(result.message, /缺元数据/);
    assert.match(result.message, /memory-compact fact seed/, '要告诉用户下一步怎么修');
    assert.doesNotMatch(result.message, /已达淘汰上限/, '0 个候选不许说成删满上限');
    assert.equal(sha(factPath), before);
    setLimits();
});

await check('全部锁定 ⇒ 文案说「已锁定」而不是「缺元数据」', async () => {
    setLimits();
    const now = Date.now();
    const lines = Array.from({ length: 2 }, (_, index) => `- 锁定${index + 1} node v${index + 1}.0.0 装配站里的临时文件与草稿不放进仓库，也不写进记忆`);
    const raw = `# FACT.md\n\n## 环境\n\n${lines.join('\n')}\n`;
    resetFact(raw, 1.1);
    const records = lines.map((text) => ({ text, firstSeen: now - 100 * 86400000, hits: 0, confidence: 'low' }));
    writeIndex(records);
    for (const record of records)
        locks.setLock('fact', store.entryId(record.firstSeen, record.text));
    const result = await compaction.compact('fact', { callModel: null });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics?.protectedLock, 2);
    assert.match(result.message, /已锁定/);
    assert.doesNotMatch(result.message, /缺元数据/);
    for (const record of records)
        locks.unsetLock('fact', store.entryId(record.firstSeen, record.text));
    setLimits();
});

/* ═══════════════ 16) 索引回填 seed（ISSUE-001 · P1） ═══════════════ */
await check('seed：dry 只算计划；真回填写冷元数据（mtime / hits=0 / low）；重跑保留已有记录', async () => {
    setLimits();
    const lines = Array.from({ length: 6 }, (_, index) => `- 手写条目${index + 1} node v${index + 1}.0.0 装配站里的临时文件与草稿不放进仓库，也不写进记忆`);
    const raw = `# FACT.md\n\n## 环境\n\n${lines.join('\n')}\n`;
    writeFileSync(factPath, raw, 'utf8');
    rmSync(indexPath, { force: true });
    rmSync(locksPath, { force: true });

    const dry = compaction.seedMetadata('fact', { dryRun: true });
    assert.equal(dry.ok, true, JSON.stringify(dry));
    assert.equal(dry.seeded, 6);
    assert.equal(dry.written, false);
    assert.equal(dry.entries.length, 6);
    assert.equal(readdirSync(memoryDir).includes('index.json'), false, 'dry 不许写 index.json');

    const seeded = compaction.seedMetadata('fact');
    assert.equal(seeded.ok, true, JSON.stringify(seeded));
    assert.equal(seeded.seeded, 6);
    assert.equal(seeded.written, true);
    const mtime = Math.round(statSync(factPath).mtimeMs);
    assert.equal(seeded.firstSeen, mtime, 'firstSeen 应取文件 mtime（视为冷数据）');
    const records = JSON.parse(readFileSync(indexPath, 'utf8')).entries;
    assert.equal(Object.keys(records).length, 6);
    for (const meta of Object.values(records)) {
        assert.equal(meta.firstSeen, mtime);
        assert.equal(meta.lastHit, mtime);
        assert.equal(meta.hits, 0);
        assert.equal(meta.confidence, 'low');
        assert.equal(meta.scope, 'fact');
    }

    // 再跑一次：全都有记录了 ⇒ seeded 0，已有记录不动
    const again = compaction.seedMetadata('fact', { now: 1 });
    assert.equal(again.seeded, 0);
    assert.equal(again.alreadyIndexed, 6);
    assert.equal(again.written, false);
    assert.equal(JSON.parse(readFileSync(indexPath, 'utf8')).entries[Object.keys(records)[0]].firstSeen, mtime, '已有记录不许被覆盖');
    setLimits();
});

await check('seed 之后真删：最多 5 条、水位不再 ≥100%，evicted 非空', async () => {
    setLimits();
    const lines = Array.from({ length: 8 }, (_, index) => `- 手写条目${index + 1} node v${index + 1}.0.0 装配站里的临时文件与草稿不放进仓库，也不写进记忆`);
    const raw = `# FACT.md\n\n## 环境\n\n${lines.join('\n')}\n`;
    writeFileSync(factPath, raw, 'utf8');
    rmSync(indexPath, { force: true });
    setLimits({ maxFactBytes: factLimitFor(raw, 1.3) });
    assert.ok(factRatio() >= 1);
    compaction.seedMetadata('fact');
    resetAudit();
    const result = await compaction.compact('fact', { callModel: null });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.evicted.length > 0 && result.evicted.length <= 5, `淘汰 ${result.evicted.length} 条`);
    assert.ok(result.ratio < 1, `压完应不再超限，实际 ${result.ratio}`);
    assert.ok(result.ratio >= 0.75 - 1e-9, `不许跌破 75%，实际 ${result.ratio}`);
    assert.equal(compaction.readAudit(1000).length, 1, '真删必须留审计');
    setLimits();
});

await check('syncIndexAfterWrite：未变条目保留元数据、新条目建记录、孤儿被清（P2）', () => {
    setLimits();
    const raw1 = '# FACT.md\n\n## 环境\n\n- 条目甲 node v1.0.0 装配站里的临时文件不放进仓库\n- 条目乙 node v2.0.0 装配站里的临时文件不放进仓库\n';
    writeFileSync(factPath, raw1, 'utf8');
    rmSync(indexPath, { force: true });
    assert.equal(store.syncIndexAfterWrite('fact', factPath, raw1, { now: 5000 }), true);
    let entries = JSON.parse(readFileSync(indexPath, 'utf8')).entries;
    assert.equal(Object.keys(entries).length, 2, JSON.stringify(entries));
    for (const meta of Object.values(entries)) {
        assert.equal(meta.firstSeen, 5000);
        assert.equal(meta.hits, 1);
        assert.equal(meta.confidence, 'medium');
    }

    // 原文保留 + 新加一条 ⇒ 老的两条 firstSeen 不变，新的一条用 now
    const raw2 = `${raw1}- 条目丙 node v3.0.0 装配站里的临时文件不放进仓库\n`;
    writeFileSync(factPath, raw2, 'utf8');
    assert.equal(store.syncIndexAfterWrite('fact', factPath, raw2, { now: 9000 }), true);
    entries = JSON.parse(readFileSync(indexPath, 'utf8')).entries;
    assert.equal(Object.keys(entries).length, 3);
    assert.equal(Object.values(entries).filter((meta) => meta.firstSeen === 5000).length, 2, '未变条目要保留原元数据');
    assert.equal(Object.values(entries).filter((meta) => meta.firstSeen === 9000).length, 1, '新条目用 now');

    // 删掉一条 ⇒ 它的记录成孤儿，prune 掉（索引只留还存在于正文里的）
    const raw3 = '# FACT.md\n\n## 环境\n\n- 条目乙 node v2.0.0 装配站里的临时文件不放进仓库\n- 条目丙 node v3.0.0 装配站里的临时文件不放进仓库\n';
    writeFileSync(factPath, raw3, 'utf8');
    assert.equal(store.syncIndexAfterWrite('fact', factPath, raw3, { now: 12000 }), true);
    entries = JSON.parse(readFileSync(indexPath, 'utf8')).entries;
    assert.equal(Object.keys(entries).length, 2, JSON.stringify(entries));
    setLimits();
});

/* ═══════ 16b) MEMORY 顶层 bullet（真实项目记忆的常见写法） ═══════ */
await check('parseEntries：MEMORY 认顶层 bullet，跳过子项与「## 速查」', () => {
    const raw = [
        '# MEMORY.md — 项目记忆',
        '',
        '## 一、结论',
        '',
        '- 顶层条目甲 node v1.0.0',
        '  - 子项甲（不算条目）',
        '- 顶层条目乙 node v2.0.0',
        '',
        '## 速查',
        '',
        '- 命令：node test/run-all.ps1',
        '',
    ].join('\n');
    const entries = compaction.parseEntries('memory', raw);
    assert.deepEqual(entries.map((entry) => entry.text), ['顶层条目甲 node v1.0.0', '顶层条目乙 node v2.0.0']);
    assert.deepEqual(entries[0].lines, [4, 5], '子项要算进这条的行号（4 基 0）');
    assert.equal(entries[0].bullet, true);
});

await check('整篇 bullet 的 MEMORY：seed 回填 6 条，淘汰时子项跟着走、标题保留', async () => {
    setLimits();
    const items = Array.from({ length: 6 }, (_, index) => `- 顶层条目${index + 1} node v${index + 1}.0.0 装配站里的临时文件与草稿不放进仓库，也不写进记忆\n  - 子项${index + 1} 必须一起走`);
    const raw = `# MEMORY.md — 项目记忆\n\n## 一、结论\n\n${items.join('\n')}\n`;
    writeFileSync(memoryPath, raw, 'utf8');
    rmSync(indexPath, { force: true });
    rmSync(locksPath, { force: true });
    setLimits({ maxProjectChars: memoryLimitFor(raw, 1.3) });
    const seeded = compaction.seedMetadata('memory', { cwd: projectRoot });
    assert.equal(seeded.seeded, 6, JSON.stringify(seeded));
    const result = await compaction.compact('memory', { cwd: projectRoot, callModel: null });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.evicted.length > 0, JSON.stringify(result));
    const after = memoryText();
    assert.ok(after.includes('# MEMORY.md'), '标题必须留着');
    for (const index of [1, 2, 3, 4, 5, 6]) {
        const parent = after.includes(`顶层条目${index} node`);
        const child = after.includes(`子项${index} 必须一起走`);
        assert.equal(parent, child, `条目${index}与子项必须同进同退（parent=${parent} child=${child}）`);
    }
    setLimits();
});

await check('store.deleteEntry / replaceEntry：顶层 bullet 条目保留 bullet 形式、删时连子项', async () => {
    setLimits();
    const raw = '# MEMORY.md — 项目记忆\n\n## 一、结论\n\n- 条目甲 node v1\n  - 子项甲\n- 条目乙 node v2\n';
    writeFileSync(memoryPath, raw, 'utf8');
    rmSync(indexPath, { force: true });
    const idA = store.entryId('', '条目甲 node v1');
    const replaced = await store.replaceEntry('memory', idA, '- 条目甲改写 node v9', { cwd: projectRoot });
    assert.equal(replaced.written, true, JSON.stringify(replaced));
    assert.match(memoryText(), /^- 条目甲改写 node v9$/m, '替换后要保留 bullet，不能变成 undefined. 或编号');
    assert.ok(memoryText().includes('子项甲'), '替换只动首行，子项保留');
    const idB = store.entryId('', '条目乙 node v2');
    const deleted = await store.deleteEntry('memory', idB, { cwd: projectRoot });
    assert.equal(deleted.deleted, true);
    assert.ok(!memoryText().includes('条目乙'), '条目本身要删掉');
    setLimits();
});

/* 命令文案：逐条精简「0 条通过」必须说话（0.8.3） */
await check('命令文案：逐条精简 0 条通过时要在结果里说清原因', async () => {
    const mod = await import(new URL('./compact-command.js', storeUrl).href);
    const silent = mod.describeCompactionResult('memory', {
        path: memoryPath,
        beforeRatio: 1.3,
        ratio: 1.3,
        changed: false,
        merged: [],
        evicted: [],
        shorten: { calls: 6, rewritten: 0, rejected: ['第 1 条超过 200 字（实际 237 字）', '第 2 条没有变短（277 → 305）'] },
    }, false);
    assert.match(silent, /0 条通过/, silent);
    assert.match(silent, /超过 200 字/, silent);
    const good = mod.describeCompactionResult('memory', {
        path: memoryPath,
        beforeRatio: 1.3,
        ratio: 0.72,
        changed: true,
        merged: [{ kind: 'shorten', from: ['甲'], to: '乙' }],
        evicted: [],
        shorten: { calls: 1, rewritten: 1, rejected: [] },
    }, false);
    assert.doesNotMatch(good, /0 条通过/);
    assert.match(good, /压缩 1 条/);
});

/* ══════════════════ 17) 插件接线：/memory-compact 命令 + 面板路由 ══════════════════
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
        const registeredTools = new Map();
        const toolsRegistry = { register(spec) { registeredTools.set(spec.name, spec); return () => { }; } };
        const llmCalls = [];
        const llm = {
            async *stream(options) {
                llmCalls.push(options);
                yield { type: 'text-delta', text: 'node v22.23.3；adb 用 platform-tools\\adb.exe' };
                yield { type: 'finish', kind: 'stop' };
            },
        };
        const scopes = [];
        const fakeCtx = {
            get: (name) => {
                if (name === 'commands')
                    return commands;
                if (name === 'webServer')
                    return webServer;
                if (name === 'llm')
                    return llm;
                if (name === 'tools')
                    return toolsRegistry;
                if (name === 'agentDefaultModel')
                    return { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) };
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
        // 会话模型继承用：requestHeader() 是宿主唯一持久化「本会话路由」的地方
        const sessionAgent = {
            session: {
                header: { cwd: projectRoot },
                requestHeader: () => ({ config: { provider: 'session-provider', model: 'session-model' } }),
            },
        };
        const run = (rawInput, target = agent) => registeredCommand.handler({ rawInput, agent: target });

        // 不带参数 ⇒ 默认压缩当前项目的 MEMORY.md（不是用法错误）
        const bare = '# MEMORY.md — 项目记忆\n\n1. 一条很短的结论\n';
        writeFileSync(memoryPath, bare, 'utf8');
        const beforeDefault = sha(memoryPath);
        const noArg = await run('');
        assert.equal(noArg.kind, 'success', JSON.stringify(noArg));
        assert.match(noArg.text, /MEMORY\.md/);
        assert.doesNotMatch(noArg.text, /用法/);
        assert.equal(sha(memoryPath), beforeDefault, '水位不足时默认命令不许改文件');

        // 只给 dry 也走默认作用域（内存里预览，不落盘）
        const dryOnly = await run('dry');
        assert.equal(dryOnly.kind, 'success', JSON.stringify(dryOnly));
        assert.match(dryOnly.text, /\[dry\] MEMORY\.md/);
        assert.equal(sha(memoryPath), beforeDefault, 'dry 绝不落盘');

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
        assert.match(memory.text, /叶子条目/, 'MEMORY 只合并叶子条目，提示要说清楚');

        const all = await run('all dry');
        assert.equal(all.kind, 'success');
        assert.match(all.text, /FACT\.md/);
        assert.match(all.text, /MEMORY\.md/);

        /* ── LLM 路线：配置留空 ⇒ 继承会话模型；会话拿不到 ⇒ 宿主默认模型 ── */
        writeFileSync(factPath, buildFact({ env: [ENV_A, ENV_B], targetBytes: 1000 }), 'utf8');
        llmCalls.length = 0;
        const merged = await run('fact dry', sessionAgent);
        assert.equal(merged.kind, 'success', JSON.stringify(merged));
        assert.ok(llmCalls.length >= 1, '配置留空也应调 llm（继承会话模型）');
        assert.equal(llmCalls[0].provider, 'session-provider', '应继承会话的 provider');
        assert.equal(llmCalls[0].model, 'session-model', '应继承会话的 model');

        // 会话没有 requestHeader（还没跑过请求）⇒ 退宿主默认模型
        llmCalls.length = 0;
        await run('fact dry');
        assert.equal(llmCalls[0]?.provider, 'default-provider', '没有会话路由时退默认模型');
        assert.equal(llmCalls[0]?.model, 'default-model');

        // 配置显式填了 ⇒ 配置优先于会话
        plugin.apply(fakeCtx, {
            compactionEnabled: true,
            compactProvider: 'cfg-provider',
            compactModel: 'cfg-model',
            maxFactBytes: LIMITS.maxFactBytes,
            maxFactLines: LIMITS.maxFactLines,
            maxProjectChars: LIMITS.maxProjectChars,
        });
        llmCalls.length = 0;
        await run('fact dry', sessionAgent);
        assert.equal(llmCalls[0]?.provider, 'cfg-provider', '显式配置应优先');
        plugin.apply(fakeCtx, { compactionEnabled: true, maxFactBytes: LIMITS.maxFactBytes, maxFactLines: LIMITS.maxFactLines, maxProjectChars: LIMITS.maxProjectChars });

        // 关闭时命令必须直接拒绝（默认开启，但显式关掉后一切压缩入口都不动）
        plugin.apply(fakeCtx, { compactionEnabled: false, maxFactBytes: LIMITS.maxFactBytes, maxFactLines: LIMITS.maxFactLines, maxProjectChars: LIMITS.maxProjectChars });
        const disabled = await run('fact');
        assert.equal(disabled.kind, 'error');
        assert.match(disabled.text, /已关闭/);

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

        /* ── ISSUE-001：命令如实反映失败 + seed 回填（0.8.0 修复） ── */
        plugin.apply(fakeCtx, { compactionEnabled: true, maxFactBytes: LIMITS.maxFactBytes, maxFactLines: LIMITS.maxFactLines, maxProjectChars: 600 });
        const overLines = Array.from({ length: 6 }, (_, index) => `结论 ${index + 1} node v${index + 1}.0.0 装配站里的临时文件与草稿不放进仓库`);
        const overRaw = `# MEMORY.md — 项目记忆\n\n${overLines.map((text, index) => `${index + 1}. ${text}`).join('\n')}\n`;
        writeFileSync(memoryPath, overRaw, 'utf8');
        rmSync(indexPath, { force: true });
        setLimits({ maxProjectChars: memoryLimitFor(overRaw, 1.3) });

        const firstRun = await run('memory');
        assert.equal(firstRun.kind, 'error', JSON.stringify(firstRun));
        assert.match(firstRun.text, /缺元数据/);
        assert.match(firstRun.text, /seed/);
        assert.ok(firstRun.text.includes(memoryPath), `结果要带目标路径：${firstRun.text}`);

        const seedDry = await run('memory seed dry');
        assert.equal(seedDry.kind, 'success', JSON.stringify(seedDry));
        assert.match(seedDry.text, /将回填 6 条/);
        assert.equal(existsSync(indexPath), false, 'seed dry 不许写索引');

        const seedReal = await run('memory seed');
        assert.equal(seedReal.kind, 'success', JSON.stringify(seedReal));
        assert.match(seedReal.text, /已回填 6 条/);
        assert.equal(existsSync(indexPath), true, 'seed 要写出 index.json');
        assert.equal(Object.keys(JSON.parse(readFileSync(indexPath, 'utf8')).entries).length, 6);

        const plan = await run('memory dry');
        assert.equal(plan.kind, 'success', JSON.stringify(plan));
        assert.match(plan.text, /\[dry\] MEMORY\.md/);
        assert.match(plan.text, /淘汰 [1-5] 条/, 'dry 要给出淘汰计划');
        assert.match(plan.text, /将淘汰：/, 'dry 要列出将淘汰的条目');
        assert.match(plan.text, /（score [\d.]+）/, '每条要给分数，便于人工判断');

        const whole = await run('memory');
        assert.equal(whole.kind, 'success', JSON.stringify(whole));
        assert.match(whole.text, /淘汰 [1-5] 条/);

        // all：FACT 无需压缩、MEMORY 失败 ⇒ 整体不许报 success，且逐项标明
        writeFileSync(factPath, buildFact({ env: [ENV_A], targetBytes: 200 }), 'utf8');
        writeFileSync(memoryPath, overRaw, 'utf8');
        rmSync(indexPath, { force: true });
        const partial = await run('all');
        assert.equal(partial.kind, 'error', JSON.stringify(partial));
        assert.match(partial.text, /FACT\.md：水位/, '成功的 scope 也要照常报');
        assert.match(partial.text, /MEMORY\.md：[^\n]*缺元数据/);

        /* ── P2：memory action=update（整篇写入）也要维护侧车索引 ── */
        const memoryTool = registeredTools.get('memory');
        assert.ok(memoryTool !== undefined, 'memory 工具应已注册');
        writeFileSync(factPath, buildFact({ env: [ENV_A], targetBytes: 100 }), 'utf8');
        rmSync(indexPath, { force: true });
        const nextFact = `${readFileSync(factPath, 'utf8')}- 新写入的一条 node v9.9.9\n`;
        await memoryTool.execute({ action: 'update', scope: 'global', content: nextFact }, { agent: { session: { header: { cwd: projectRoot } } } });
        const factIndex = JSON.parse(readFileSync(indexPath, 'utf8')).entries;
        const factRecords = Object.values(factIndex).filter((meta) => meta.scope === 'fact');
        assert.ok(factRecords.length >= 2, `整篇写入后索引应有记录：${JSON.stringify(factIndex)}`);
        assert.ok(factRecords.every((meta) => Number.isFinite(meta.firstSeen) && meta.hits >= 1));

        const nextMemory = '# MEMORY.md — 项目记忆\n\n1. 项目条目甲 node v1\n2. 项目条目乙 node v2\n';
        writeFileSync(memoryPath, '# MEMORY.md — 项目记忆\n\n1. 项目条目甲 node v1\n', 'utf8');
        await memoryTool.execute({ action: 'update', scope: 'project', content: nextMemory }, { agent: { session: { header: { cwd: projectRoot } } } });
        const memoryRecords = Object.values(JSON.parse(readFileSync(indexPath, 'utf8')).entries)
            .filter((meta) => meta.scope === 'memory');
        assert.equal(memoryRecords.length, 2, JSON.stringify(memoryRecords));
        assert.ok(memoryRecords.every((meta) => meta.path === memoryPath), '项目条目要记 path');

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
