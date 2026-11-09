/**
 * 回归测试：条目生命周期（`DESIGN-memory-lifecycle.md` §1–§4）—— 失效不删除。
 *
 * 覆盖的验收点：
 *  1. `parseEntryState()` 容错：无注释 / 完整注释 / 残缺注释 / `status` 拼错 / 重复注释 /
 *     正文里出现类似字符串 / 注释不在行尾 —— 一律不抛错，认不出来的按 `active` 且**不改写原文**；
 *  2. `applyEntryState()`：追加、**替换而不是追加**（重复注释会让条目「失效后复活」）、
 *     恢复成 active 时摘干净，缩进与列表标记原样保留；
 *  3. `stripSuperseded()`：只去条目行，保留标题 / 空行 / `## 速查` / active 条目；
 *     幂等；编号条目连子项一起去掉；
 *  4. `countEntryStates()`：`{total, active, superseded, archived}`；
 *  5. `store.supersedeEntry()`：只加行尾注释、**文件字节只增不减**、行数与正文一字不动、
 *     target 支持 `{id}` / `{text}` / `{number}`、找不到就 not-found 不猜、revision 冲突拒写、
 *     重复调用幂等、写前备份、写后上限校验（注释也占字节）；
 *  6. `store.restoreEntry()`：注释清回 active，条目重新可注入；
 *  7. `findEntry()` / 条目切分返回 `state`（向后兼容：只加字段），**加注释不改变条目 id**
 *     （否则索引元数据成孤儿、压缩层淘汰候选归零）；
 *  8. `renderFacts()` 在 clip 之前过滤失效条目，而快照里存的仍是原文（审计口径）；
 *  9. 压缩淘汰：失效条目优先（分数压到 0），缺元数据的失效条目也照删，普通条目照旧受保护；
 * 10. 真实数据幂等：对 `$DSH_HOME/memory/FACT.md`（或 `PERSONA_MEMORY_REAL_FACT`）跑两遍
 *     `stripSuperseded()` 结果一致，且**不写盘**。
 *
 * 跑法：node test/entry-state.test.mjs
 * （run-all.ps1 第 10 步用 PERSONA_MEMORY_STORE_ENTRY 指向已装份复跑。）
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-lifecycle-'));
process.env.DSH_HOME = home;

const here = dirname(fileURLToPath(import.meta.url));
const defaultStorePath = join(here, '..', 'lib', 'store.js');
const storeUrl = process.env.PERSONA_MEMORY_STORE_ENTRY ?? pathToFileURL(defaultStorePath).href;
const store = await import(storeUrl);
const state = await import(new URL('./entry-state.js', storeUrl).href);
const render = await import(new URL('./prompt-render.js', storeUrl).href);
const snapshotMod = await import(new URL('./snapshot.js', storeUrl).href);
const compaction = await import(new URL('./compaction.js', storeUrl).href);

const memoryDir = store.memoryDir();
const factPath = store.factPath();
const autoBackups = store.autoBackupsDir();
const projectRoot = join(home, 'proj');
const memoryPath = join(projectRoot, 'MEMORY.md');
mkdirSync(memoryDir, { recursive: true });
mkdirSync(projectRoot, { recursive: true });

/* ── 极简 PASS/FAIL 报告器（与其它用例同款：失败不中断，攒到最后统一退出码 1） ── */
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
        const detail = String(error?.message ?? error).split('\n').join('\n      ');
        console.log(`FAIL ${label}\n      ${detail}`);
    }
}

const read = (file) => readFileSync(file, 'utf8');
const bytes = (file) => Buffer.byteLength(read(file), 'utf8');
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const lineCount = (text) => (text === '' ? 0 : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length);

const FACT_BASE = [
    '# FACT.md — 全局长期记忆',
    '',
    '## 关于环境',
    '',
    '- 系统 node v22',
    '- 打包用 tarball 安装',
    '',
    '## 长期约定',
    '',
    '- 先看日志再动手',
    '',
].join('\n');

const MEMORY_BASE = [
    '# MEMORY.md — 项目记忆',
    '',
    '1. 工作区定位',
    '   - 本目录是插件装配站。',
    '',
    '2. 安装与重启',
    '   - 依赖用 tarball 装。',
    '',
    '## 速查',
    '',
    '- 打包：npm pack',
    '',
].join('\n');

const writeFact = (text = FACT_BASE) => writeFileSync(factPath, text, 'utf8');
const writeMemory = (text = MEMORY_BASE) => writeFileSync(memoryPath, text, 'utf8');

/* ═══════════════════════ 1. parseEntryState（纯函数容错） ═══════════════════════ */

await check('parseEntryState：没有状态注释 ⇒ active，text 就是整行', () => {
    const parsed = state.parseEntryState('- 系统 node v22');
    assert.deepEqual(parsed.state, { status: 'active', by: '', since: '' });
    assert.equal(parsed.text, '- 系统 node v22');
});

await check('parseEntryState：完整注释 ⇒ 剥离注释、字段解析正确', () => {
    const parsed = state.parseEntryState('- 系统 node v22 <!-- memory-state: status=superseded by=1a2b3c4d5e since=2026-11-09 -->');
    assert.deepEqual(parsed.state, { status: 'superseded', by: '1a2b3c4d5e', since: '2026-11-09' });
    assert.equal(parsed.text, '- 系统 node v22');
});

await check('parseEntryState：archived 可以省略 by（by / since 都不是认状态的必要条件）', () => {
    const parsed = state.parseEntryState('1. 安装与重启 <!-- memory-state: status=archived since=2026-11-09 -->');
    assert.deepEqual(parsed.state, { status: 'archived', by: '', since: '2026-11-09' });
    assert.equal(parsed.text, '1. 安装与重启');
});

await check('parseEntryState：字段顺序无关、多余字段忽略、正文与注释之间没空格也认', () => {
    const a = state.parseEntryState('- 甲 <!-- memory-state: since=2026-11-09 status=superseded by=abcdef0123 extra=1 -->');
    assert.equal(a.state.status, 'superseded');
    assert.equal(a.state.by, 'abcdef0123');
    assert.equal(a.text, '- 甲');
    const b = state.parseEntryState('- 乙<!-- memory-state: status=archived -->');
    assert.equal(b.state.status, 'archived');
    assert.equal(b.text, '- 乙');
});

await check('parseEntryState：注释残缺（没有 -->）⇒ active，且原文一个字都不动', () => {
    const line = '- 甲 <!-- memory-state: status=superseded since=2026-11-09';
    const parsed = state.parseEntryState(line);
    assert.equal(parsed.state.status, 'active');
    assert.equal(parsed.text, line, '认不出来的注释必须留在 text 里，解析层不猜、不改写');
});

await check('parseEntryState：status 拼错 / 缺失 ⇒ active（宁可多注入，不可误失效）', () => {
    for (const line of [
        '- 甲 <!-- memory-state: status=superceded since=2026-11-09 -->',
        '- 甲 <!-- memory-state: by=abcdef0123 since=2026-11-09 -->',
        '- 甲 <!-- memory-state: status= -->',
    ]) {
        const parsed = state.parseEntryState(line);
        assert.equal(parsed.state.status, 'active', line);
        assert.equal(parsed.text, line, `拼错的注释不改写原文：${line}`);
    }
});

await check('parseEntryState：同一行两份状态注释 ⇒ active（不知道哪份算数，就不猜）', () => {
    const line = '- 甲 <!-- memory-state: status=superseded --> <!-- memory-state: status=archived -->';
    const parsed = state.parseEntryState(line);
    assert.equal(parsed.state.status, 'active');
    assert.equal(parsed.text, line);
});

await check('parseEntryState：正文里出现类似字符串（不在行尾 / 是内容的一部分）⇒ active', () => {
    const middle = '- 甲里聊到 <!-- memory-state: status=archived --> 这种写法';
    assert.equal(state.parseEntryState(middle).state.status, 'active');
    assert.equal(state.parseEntryState(middle).text, middle);
    const withTail = '- 甲 <!-- memory-state: status=archived --> 后面还有话';
    assert.equal(state.parseEntryState(withTail).state.status, 'active');
    assert.equal(state.parseEntryState(withTail).text, withTail);
});

await check('parseEntryState：since 形状不对 ⇒ 状态仍认、since 置空（不因日期手误让结论复活）', () => {
    const parsed = state.parseEntryState('- 甲 <!-- memory-state: status=superseded since=昨天 -->');
    assert.equal(parsed.state.status, 'superseded');
    assert.equal(parsed.state.since, '');
    assert.equal(parsed.text, '- 甲');
});

/* ═══════════════════════ 2. applyEntryState（只改行尾） ═══════════════════════ */

await check('applyEntryState：追加注释，缩进 / 编号 / 正文一字不动', () => {
    assert.equal(
        state.applyEntryState('- 正文', { status: 'superseded', by: 'abcdef0123', since: '2026-11-09' }),
        '- 正文 <!-- memory-state: status=superseded by=abcdef0123 since=2026-11-09 -->',
    );
    assert.equal(
        state.applyEntryState('   3. 子结论', { status: 'archived', since: '2026-11-09' }),
        '   3. 子结论 <!-- memory-state: status=archived since=2026-11-09 -->',
    );
});

await check('applyEntryState：**替换**而不是追加（两份注释会让下一条解析回 active）', () => {
    const once = state.applyEntryState('- 正文', { status: 'superseded', since: '2026-11-01' });
    const twice = state.applyEntryState(once, { status: 'archived', since: '2026-11-09' });
    assert.equal(twice, '- 正文 <!-- memory-state: status=archived since=2026-11-09 -->');
    assert.equal((twice.match(/memory-state/g) ?? []).length, 1);
});

await check('applyEntryState：残缺的旧注释也摘掉，不会累积成「双注释 ⇒ active」', () => {
    const broken = '- 正文 <!-- memory-state: status=superseded since=2026-11-01';
    const fixed = state.applyEntryState(broken, { status: 'superseded', since: '2026-11-09' });
    assert.equal(fixed, '- 正文 <!-- memory-state: status=superseded since=2026-11-09 -->');
    assert.equal(state.parseEntryState(fixed).state.status, 'superseded');
});

await check('applyEntryState：status=active ⇒ 摘掉注释；本来就没注释则原样返回', () => {
    const plain = '- 正文';
    assert.equal(state.applyEntryState(plain, { status: 'active' }), plain, '没注释不该被「平整」');
    assert.equal(
        state.applyEntryState(`${plain} <!-- memory-state: status=archived since=2026-11-09 -->`, { status: 'active' }),
        plain,
    );
});

/* ═══════════════════════ 3. stripSuperseded（渲染过滤） ═══════════════════════ */

const MIXED = [
    '# FACT.md',
    '',
    '## 关于环境',
    '',
    '- 系统 node v22',
    '- 系统 node v20 <!-- memory-state: status=superseded by=1a2b3c4d5e since=2026-11-09 -->',
    '- 旧机器 <!-- memory-state: status=archived since=2026-11-08 -->',
    '',
    '## 速查',
    '',
    '- 打包：npm pack',
    '',
].join('\n');

await check('stripSuperseded：只去失效条目，标题 / 空行 / 速查 / active 全部保留', () => {
    const kept = state.stripSuperseded(MIXED);
    assert.match(kept, /# FACT\.md/);
    assert.match(kept, /- 系统 node v22/);
    assert.doesNotMatch(kept, /系统 node v20/);
    assert.doesNotMatch(kept, /旧机器/);
    assert.match(kept, /## 速查/);
    assert.match(kept, /- 打包：npm pack/);
});

await check('stripSuperseded：幂等（跑两遍与跑一遍逐字节相同）', () => {
    const once = state.stripSuperseded(MIXED);
    assert.equal(state.stripSuperseded(once), once);
});

await check('stripSuperseded：编号条目连它的缩进子项一起去掉（不留孤儿子项）', () => {
    const doc = [
        '# MEMORY.md',
        '',
        '1. 旧结论 <!-- memory-state: status=superseded since=2026-11-09 -->',
        '   - 子项 A',
        '   - 子项 B',
        '',
        '2. 新结论',
        '   - 子项 C',
        '',
        '## 速查',
        '',
        '- 命令：npm pack',
        '',
    ].join('\n');
    const kept = state.stripSuperseded(doc);
    assert.doesNotMatch(kept, /旧结论/);
    assert.doesNotMatch(kept, /子项 A/);
    assert.doesNotMatch(kept, /子项 B/);
    assert.match(kept, /2\. 新结论/);
    assert.match(kept, /子项 C/);
    assert.equal(state.stripSuperseded(kept), kept, '幂等');
});

await check('stripSuperseded：不是条目的行（正文段落 / 认不出的注释）一个字都不删', () => {
    const doc = [
        '# 标题',
        '',
        '这一段里提到 <!-- memory-state: status=archived --> 这种写法，但它不是条目。',
        '',
        '- 甲 <!-- memory-state: status=superceded -->',
        '',
    ].join('\n');
    assert.equal(state.stripSuperseded(doc), doc);
});

await check('stripSuperseded：空文本 / 全是失效条目时返回干净结果（不抛错）', () => {
    assert.equal(state.stripSuperseded(''), '');
    // 整篇都是失效条目 ⇒ 只剩空串（没有标题、没有速查）
    assert.equal(state.stripSuperseded('- 甲 <!-- memory-state: status=superseded -->\n'), '');
});

/* ═══════════════════════ 4. countEntryStates ═══════════════════════ */

await check('countEntryStates：{total, active, superseded, archived}，速查与子项不计数', () => {
    assert.deepEqual(state.countEntryStates(MIXED), { total: 3, active: 1, superseded: 1, archived: 1 });
    assert.deepEqual(state.countEntryStates(''), { total: 0, active: 0, superseded: 0, archived: 0 });
    // MEMORY_BASE 的两条 `- 子项` 是缩进子项（不是条目），所以 total = 2
    assert.deepEqual(state.countEntryStates(MEMORY_BASE), { total: 2, active: 2, superseded: 0, archived: 0 });
});

/* ═══════════════════════ 5. store.supersedeEntry / restoreEntry ═══════════════════════ */

await check('条目切分与 findEntry 默认带 state=active（向后兼容：只新增字段）', () => {
    writeFact();
    const found = store.findEntry('fact', '系统 node v22');
    assert.ok(found !== null);
    assert.equal(found.text, '系统 node v22', 'text 仍是纯正文');
    assert.deepEqual(found.state, { status: 'active', by: '', since: '' });
});

await check('supersedeEntry（{text}）：文件字节只增不减、行数不变、每行都是原行的前缀（只加注释）', async () => {
    writeFact();
    const before = read(factPath);
    const beforeBytes = bytes(factPath);
    const beforeLines = lineCount(before);
    const beforeId = store.findEntry('fact', '系统 node v22').id;

    const result = await store.supersedeEntry('fact', { text: '系统 node v22' }, { by: 'abcdef0123', at: '2026-11-09' });

    assert.equal(result.ok, true, JSON.stringify(result.reason));
    assert.equal(result.unchanged, false);
    assert.equal(result.path, factPath);
    assert.deepEqual(result.entry.state, { status: 'superseded', by: 'abcdef0123', since: '2026-11-09' });
    assert.equal(result.revision, store.contentRevision(read(factPath)));
    assert.ok(bytes(factPath) > beforeBytes, '「失效不删除」：字节只能变多');
    assert.equal(lineCount(read(factPath)), beforeLines, '不新增行（FACT 只有 100 行预算）');
    const afterLines = read(factPath).split('\n');
    const originalLines = before.split('\n');
    afterLines.forEach((line, index) => {
        assert.ok(line.startsWith(originalLines[index] ?? ''), `第 ${index + 1} 行被改写了：${JSON.stringify(line)}`);
    });
    // 正文还在文件里，只是行尾多了注释
    assert.match(read(factPath), /- 系统 node v22 <!-- memory-state: status=superseded by=abcdef0123 since=2026-11-09 -->/);
    // ⚠️ 加注释不能让条目 id 变：否则索引元数据成孤儿、压缩淘汰候选归零
    assert.equal(store.findEntry('fact', '系统 node v22').id, beforeId);
});

await check('supersedeEntry：条目状态可读回（findEntry.state），重复调用幂等且不再长字节', async () => {
    writeFact();
    await store.supersedeEntry('fact', { text: '系统 node v22' }, { since: '2026-11-09' });
    const first = bytes(factPath);
    assert.equal(store.findEntry('fact', '系统 node v22').state.status, 'superseded');
    const again = await store.supersedeEntry('fact', { text: '系统 node v22' }, { since: '2026-11-09' });
    assert.equal(again.ok, true);
    assert.equal(again.unchanged, true, '已经是目标状态 ⇒ 幂等，不重复备份、不再加字符');
    assert.equal(bytes(factPath), first);
});

await check('supersedeEntry（{id}）：按条目 id 定位', async () => {
    writeFact();
    const id = store.findEntry('fact', '打包用 tarball 安装').id;
    const result = await store.supersedeEntry('fact', { id }, { at: '2026-11-09' });
    assert.equal(result.ok, true, JSON.stringify(result.reason));
    assert.equal(result.entry.text, '打包用 tarball 安装');
    assert.equal(store.findEntry('fact', '打包用 tarball 安装').state.status, 'superseded');
});

await check('supersedeEntry（{number}）：项目 MEMORY.md 按编号定位，编号与子项原样保留', async () => {
    writeMemory();
    const before = read(memoryPath);
    const result = await store.supersedeEntry('memory', { number: 2 }, { cwd: projectRoot, at: '2026-11-09' });
    assert.equal(result.ok, true, JSON.stringify(result.reason));
    assert.equal(result.entry.text, '安装与重启');
    assert.equal(result.entry.state.status, 'superseded');
    const after = read(memoryPath);
    assert.match(after, /^2\. 安装与重启 <!-- memory-state: status=superseded since=2026-11-09 -->$/m);
    assert.match(after, /   - 依赖用 tarball 装。/, '子项不许被牵连');
    assert.equal(lineCount(after), lineCount(before));
    // 编号条目定位仍按编号：`{number}` 不受注释影响
    assert.equal(store.findEntry('memory', '安装与重启', { cwd: projectRoot }).state.status, 'superseded');
});

await check('supersedeEntry：找不到就是 not-found，文件一个字节都不动（不猜目标）', async () => {
    writeFact();
    const before = sha(factPath);
    const result = await store.supersedeEntry('fact', { text: '根本没有这条结论' }, { at: '2026-11-09' });
    assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: 'not-found' });
    assert.equal(sha(factPath), before);
});

await check('supersedeEntry：包含匹配命中多条 ⇒ not-found + ambiguous（不替用户选一条）', async () => {
    writeFact([
        '# FACT.md',
        '',
        '## 环境',
        '',
        '- node v22 安装在系统目录',
        '- node v20 只用于旧项目',
        '',
    ].join('\n'));
    const before = sha(factPath);
    const result = await store.supersedeEntry('fact', { text: 'node v2' }, { at: '2026-11-09' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-found');
    assert.equal(result.ambiguous, true);
    assert.equal(result.candidates, 2);
    assert.equal(sha(factPath), before);
});

await check('supersedeEntry：target 认不出 ⇒ bad-target，不抛错、不写盘', async () => {
    writeFact();
    const before = sha(factPath);
    for (const target of [null, undefined, {}, [], '', '   ', { id: '  ' }, { text: '   ' }]) {
        const result = await store.supersedeEntry('fact', target, { at: '2026-11-09' });
        assert.equal(result.ok, false, String(target));
        assert.equal(result.reason, 'bad-target', String(target));
    }
    assert.equal(sha(factPath), before);
});

await check('supersedeEntry：过期 revision ⇒ MEMORY_REVISION_CONFLICT，文件一个字节不变', async () => {
    writeFact();
    const stale = store.contentRevision(read(factPath));
    const changed = `${FACT_BASE}- 别人插进来的一条\n`;
    writeFact(changed);
    const before = sha(factPath);
    await assert.rejects(
        () => store.supersedeEntry('fact', { text: '系统 node v22' }, { at: '2026-11-09', expectedRevision: stale }),
        (error) => {
            assert.equal(error.code, 'MEMORY_REVISION_CONFLICT');
            assert.equal(error.status, 409);
            assert.equal(error.details.expectedRevision, stale);
            assert.equal(error.details.actualRevision, store.contentRevision(changed));
            return true;
        },
    );
    assert.equal(sha(factPath), before, '冲突时磁盘必须原样');
    // 正确 revision ⇒ 正常写入
    const ok = await store.supersedeEntry('fact', { text: '系统 node v22' }, {
        at: '2026-11-09',
        expectedRevision: store.contentRevision(read(factPath)),
    });
    assert.equal(ok.ok, true);
});

await check('supersedeEntry：写前备份到 backups/auto（可回滚到加注释之前）', async () => {
    writeFact();
    const before = read(factPath);
    await store.supersedeEntry('fact', { text: '系统 node v22' }, { at: '2026-11-09' });
    const names = readdirSync(autoBackups).filter((name) => name.startsWith('FACT.md-') && name.endsWith('.bak'));
    assert.ok(names.length >= 1, '应留下至少一份备份');
    const latest = names.sort().at(-1);
    assert.equal(read(join(autoBackups, latest)), before);
});

await check('supersedeEntry：注释也占字节 ⇒ 写后重新卡上限，超限抛 MEMORY_BUDGET_EXCEEDED 且不落盘', async () => {
    // 把上限压到「正文放得下、加了注释就放不下」
    const base = '# FACT.md\n\n## 环境\n\n- 系统 node v22\n';
    writeFact(base);
    const need = Buffer.byteLength(base, 'utf8') + 20;
    store.configureStore({ maxFactBytes: need, maxFactLines: 100 });
    try {
        const before = sha(factPath);
        await assert.rejects(
            () => store.supersedeEntry('fact', { text: '系统 node v22' }, { at: '2026-11-09' }),
            (error) => {
                assert.equal(error.code, 'MEMORY_BUDGET_EXCEEDED');
                assert.equal(store.isBudgetError(error), true);
                return true;
            },
        );
        assert.equal(sha(factPath), before, '超限时磁盘保持原样');
    }
    finally {
        store.configureStore({ maxFactBytes: 8000, maxFactLines: 100 });
    }
});

await check('restoreEntry：摘掉注释回到 active，条目重新可注入（字节回落到加注释之前）', async () => {
    writeFact();
    const original = read(factPath);
    await store.supersedeEntry('fact', { text: '系统 node v22' }, { at: '2026-11-09' });
    assert.equal(store.findEntry('fact', '系统 node v22').state.status, 'superseded');
    const restored = await store.restoreEntry('fact', { text: '系统 node v22' });
    assert.equal(restored.ok, true, JSON.stringify(restored.reason));
    assert.equal(restored.entry.state.status, 'active');
    assert.equal(read(factPath), original, '恢复后应逐字节回到加注释之前');
    // 幂等：已经 active 再恢复一次不产生写入
    const again = await store.restoreEntry('fact', { text: '系统 node v22' });
    assert.equal(again.unchanged, true);
});

await check('restoreEntry：项目记忆同样可恢复（{number} 定位）', async () => {
    writeMemory();
    await store.supersedeEntry('memory', { number: 1 }, { cwd: projectRoot, at: '2026-11-09' });
    assert.equal(store.findEntry('memory', '工作区定位', { cwd: projectRoot }).state.status, 'superseded');
    const result = await store.restoreEntry('memory', { number: 1 }, { cwd: projectRoot });
    assert.equal(result.ok, true);
    assert.equal(read(memoryPath), MEMORY_BASE);
});

await check('replaceEntry 改写正文时保留状态（不许把 superseded 悄悄写回 active）', async () => {
    writeFact();
    const id = store.findEntry('fact', '系统 node v22').id;
    await store.supersedeEntry('fact', { id }, { at: '2026-11-09' });
    // 正文换成纯中文（`validateEntry` 会拦「英文词占比 > 40%」的条目，与本用例无关）
    const replaced = await store.replaceEntry('fact', id, { text: '系统已升级到新版' });
    assert.equal(replaced.written, true, replaced.reason);
    const found = store.findEntry('fact', '系统已升级到新版');
    assert.equal(found.state.status, 'superseded', '改写正文后状态必须还在');
    assert.equal(found.state.since, '2026-11-09');
});

/* ═══════════════════════ 6. 注入过滤（渲染层，快照存原文） ═══════════════════════ */

await check('renderFacts：失效条目一个 token 都不进提示词，active 条目照常注入', () => {
    const snapshot = {
        persona: null,
        globalFact: [
            '# FACT.md',
            '',
            '## 环境',
            '',
            '- 在用的结论：node v22',
            '- 过时的结论：node v20 <!-- memory-state: status=superseded since=2026-11-09 -->',
            '- 归档的结论：node v18 <!-- memory-state: status=archived since=2026-11-08 -->',
            '',
        ].join('\n'),
        project: {
            path: memoryPath,
            root: projectRoot,
            content: [
                '# MEMORY.md',
                '',
                '1. 在用的项目结论',
                '2. 过时的项目结论 <!-- memory-state: status=superseded since=2026-11-09 -->',
                '',
                '## 速查',
                '',
                '- 打包：npm pack',
                '',
            ].join('\n'),
        },
        journalTotal: 0,
    };
    const rendered = render.renderFacts(snapshot, {}, 'full', { persona: true, globalMemory: true, projectMemory: true });
    assert.match(rendered, /在用的结论：node v22/);
    assert.match(rendered, /在用的项目结论/);
    assert.match(rendered, /打包：npm pack/);
    assert.doesNotMatch(rendered, /过时的结论/);
    assert.doesNotMatch(rendered, /归档的结论/);
    assert.doesNotMatch(rendered, /过时的项目结论/);
    assert.doesNotMatch(rendered, /memory-state/, '过滤后不该剩下任何状态注释');
});

await check('renderFacts：子代理（scope=project）也只注入 active 项目条目', () => {
    const snapshot = {
        persona: null,
        globalFact: '# FACT.md\n\n- 全局独有标记行\n',
        project: {
            path: memoryPath,
            root: projectRoot,
            content: '1. 能给子代理看\n2. 不该给子代理看 <!-- memory-state: status=superseded since=2026-11-09 -->\n',
        },
        journalTotal: 0,
    };
    const rendered = render.renderFacts(snapshot, {}, 'project', { persona: true, globalMemory: true, projectMemory: true });
    assert.match(rendered, /能给子代理看/);
    assert.doesNotMatch(rendered, /不该给子代理看/);
    assert.doesNotMatch(rendered, /全局独有标记行/, '子代理不注入全局记忆内容');
});

await check('快照里存的仍是**原文**（审计 / 恢复口径，过滤只发生在渲染层）', () => {
    writeFact([
        '# FACT.md',
        '',
        '## 环境',
        '',
        '- 过时的结论 <!-- memory-state: status=superseded since=2026-11-09 -->',
        '',
    ].join('\n'));
    const runtime = { cwdBySession: new Map(), sessionsSeen: new Set(), projectBySession: new Map(), snapshots: new Map(), sessionById: new Map() };
    const snapshot = snapshotMod.buildSnapshot('s-lifecycle', projectRoot, {}, runtime);
    assert.match(snapshot.globalFact, /memory-state: status=superseded/);
    // 但渲染出来是干净的
    const rendered = render.renderFacts(snapshot, {}, 'full', { persona: true, globalMemory: true, projectMemory: false });
    assert.doesNotMatch(rendered, /memory-state/);
});

await check('注入预算按**过滤后**的文本算：失效条目不该把 clip 预算吃掉', () => {
    const active = '- 在用的结论'.repeat(1);
    const dormant = `- 过时的结论 ${'x'.repeat(400)} <!-- memory-state: status=superseded since=2026-11-09 -->`;
    const snapshot = {
        persona: null,
        globalFact: `# FACT.md\n\n## 环境\n\n${active}\n${dormant}\n`,
        project: null,
        journalTotal: 0,
    };
    // maxChars 只够放 active + 一点余量：如果失效条目先参与 clip，active 会被截断
    const rendered = render.renderFacts(snapshot, { maxChars: 60 }, 'full', { persona: true, globalMemory: true, projectMemory: false });
    assert.match(rendered, /在用的结论/);
    assert.doesNotMatch(rendered, /已截断/);
});

/* ═══════════════════════ 7. 压缩淘汰优先级 ═══════════════════════ */

await check('parseEntries：text 剥离注释、state 可读（id 与 store 同口径，否则元数据成孤儿）', () => {
    writeFact();
    const id = store.findEntry('fact', '系统 node v22').id;
    const text = read(factPath).replace('- 系统 node v22', '- 系统 node v22 <!-- memory-state: status=superseded by=abcdef0123 since=2026-11-09 -->');
    const entries = compaction.resolveEntryIds(compaction.parseEntries('fact', text), store.memoryIndex());
    const hit = entries.find((entry) => entry.text === '系统 node v22');
    assert.ok(hit !== undefined, 'text 必须是纯正文');
    assert.equal(hit.id, id, '加注释不能改变条目 id');
    assert.deepEqual(hit.state, { status: 'superseded', by: 'abcdef0123', since: '2026-11-09' });
});

await check('selectEvictions：失效条目优先被淘汰（分数压到 0，排序逻辑一行没改）', () => {
    const text = [
        '# FACT.md',
        '',
        '## 环境',
        '',
        '- 活跃结论 node v22 装配站',
        '- 过时结论 node v20 装配站 <!-- memory-state: status=superseded since=2026-11-09 -->',
        '- 归档结论 node v18 装配站 <!-- memory-state: status=archived since=2026-11-08 -->',
        '',
    ].join('\n');
    writeFact(text);
    store.syncIndexAfterWrite('fact', factPath, text);
    const entries = compaction.resolveEntryIds(compaction.parseEntries('fact', text), store.memoryIndex());
    const report = {};
    const picked = compaction.selectEvictions(entries, store.memoryIndex(), { now: Date.now(), maxEvictions: 2, report });
    assert.equal(picked.length, 2);
    assert.ok(picked.every((entry) => entry.score === 0), `失效条目应是 0 分：${JSON.stringify(picked)}`);
    assert.deepEqual(picked.map((entry) => entry.text.includes('过时') || entry.text.includes('归档')).sort(), [true, true]);
    assert.equal(report.dormantPriority, 2);
    assert.ok(!picked.some((entry) => entry.text.includes('活跃结论')), '活跃条目不该被先删');
});

await check('selectEvictions：缺元数据的失效条目照删；缺元数据的 active 条目继续受保护', () => {
    /* 索引不能整份缺失（那样淘汰层直接跳过），所以先让索引里有一条**在文件里的**记录，
       再往正文里追加两条没有元数据的条目：一条失效、一条活跃。 */
    const seed = '# FACT.md\n\n## 环境\n\n- 有元数据的活跃条目 node v24 装配站\n';
    writeFact(seed);
    store.syncIndexAfterWrite('fact', factPath, seed);
    const text = [
        '# FACT.md',
        '',
        '## 环境',
        '',
        '- 有元数据的活跃条目 node v24 装配站',
        '- 活跃但没有元数据的条目 node v22 装配站',
        '- 失效且没有元数据的条目 node v20 装配站 <!-- memory-state: status=superseded since=2026-11-09 -->',
        '',
    ].join('\n');
    writeFact(text);
    const entries = compaction.resolveEntryIds(compaction.parseEntries('fact', text), store.memoryIndex());
    const report = {};
    const picked = compaction.selectEvictions(entries, store.memoryIndex(), { now: Date.now(), maxEvictions: 1, report });
    assert.deepEqual(picked.map((entry) => entry.text), ['失效且没有元数据的条目 node v20 装配站']);
    assert.equal(report.dormantPriority, 1);
    assert.equal(report.missingMetadata, 1, '活跃条目缺元数据仍算「一无所知就不删」');
});

await check('压缩改写不碰失效条目（否则行尾状态会被模型输出丢掉 ⇒ 悄悄复活）', async () => {
    const longActive = '- 活跃条目 '.repeat(1) + '这是一条足够长的活跃结论，用来触发逐条精简的候选筛选逻辑装配站';
    const longDormant = `${'这只是过时的长结论'.repeat(1)} 这是一条足够长的失效结论，用来确认它不会进精简候选组件装配站 <!-- memory-state: status=superseded since=2026-11-09 -->`;
    const text = `# FACT.md\n\n## 环境\n\n${longActive}\n${longDormant}\n`;
    writeFact(text);
    store.syncIndexAfterWrite('fact', factPath, text);
    const seen = [];
    await compaction.planShortenings('fact', text, async (prompt, meta) => {
        seen.push(meta.entries.map((entry) => entry.text));
        return '';
    }, { shortenMaxBatches: 4 });
    const flat = seen.flat();
    assert.ok(!flat.some((line) => line.includes('过时的长结论')), `失效条目不该出现在精简提示词里：${JSON.stringify(flat)}`);
});

/* ═══════════════════════ 8. 真实数据幂等（只读，不写盘） ═══════════════════════ */

await check('真实 FACT.md：stripSuperseded 两遍结果一致，且一个字节都没被写回去', () => {
    const realPath = process.env.PERSONA_MEMORY_REAL_FACT ?? join(homedir(), '.dsh', 'memory', 'FACT.md');
    if (!existsSync(realPath)) {
        console.log(`      SKIP 没有真实数据：${realPath}`);
        return;
    }
    const raw = readFileSync(realPath, 'utf8');
    const before = createHash('sha256').update(readFileSync(realPath)).digest('hex');
    const once = state.stripSuperseded(raw);
    const twice = state.stripSuperseded(once);
    assert.equal(twice, once, 'stripSuperseded 必须幂等');
    const after = createHash('sha256').update(readFileSync(realPath)).digest('hex');
    assert.equal(after, before, '过滤是纯函数，绝不许改真实数据');
    assert.equal(state.stripSuperseded(state.stripSuperseded(once)), once);
});

/* ── 汇总 ── */
if (failures.length > 0) {
    console.error(`\n✗ entry-state 失败 ${failures.length}/${checks}：`);
    for (const name of failures)
        console.error(`  - ${name}`);
    rmSync(home, { recursive: true, force: true });
    process.exit(1);
}
console.log(`\n✓ entry-state 全部 ${checks} 条通过`);
rmSync(home, { recursive: true, force: true });
