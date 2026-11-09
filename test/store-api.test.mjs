/**
 * 回归测试：`lib/store.js` 0.7.0 · P2 新增 API（模板 / 校验 / 插入 / 侧车索引 / 写锁 / JOURNAL 失效）。
 *
 * 覆盖 01 §3.3 / §3.4 / §3.4.1 / §3.5 / §3.6 与 00 §4.1、02 §4.3 / §7.4 的验收点：
 *  1. 超限错误的 `code` 与 `details`（**message 一字不改** —— 现有测试断言了文案）；
 *  2. `watermark()`：FACT 读盘、项目记忆按 cwd 定位、无项目记忆给 0 值 + 上限；
 *  3. `templates()` 形状与 `promptFragment` 内容（四条硬规则 + FACT 原因词表）；
 *  4. `validateEntry()`：8+ 条违规样本按 01 §3.3 的表逐条处理 + 2 条正常样本放行；
 *  5. `insertEntry()`：FACT 落进同名 `## 分组`（没有就建 `## 其它`）、MEMORY 编号顺延；
 *  6. 超限拒写时**磁盘 SHA256 不变**；
 *  7. `replaceEntry` / `deleteEntry` / not-found；
 *  8. 侧车索引 `memory/index.json` 建得出来、孤儿读到就剪掉；
 *  9. `acquireWriteLock()` 互斥与超时；
 * 10. `appendJournal()` 的 id 稳定（返回值 == 落盘行 == `entryId(ts, text)`）；
 * 11. `supersedeJournal()` 只移动命中的那一条、归档前脱敏、`readJournal` 再也看不到它；
 * 12. 并发 append + supersede 不丢行。
 *
 * 跑法：node test/store-api.test.mjs
 * （run-all.ps1 第 3 步跑仓库源码；第 10 步用 PERSONA_MEMORY_STORE_ENTRY 指向已装份复跑。）
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-store-api-'));
process.env.DSH_HOME = home;

const defaultStorePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'store.js');
const storeUrl = process.env.PERSONA_MEMORY_STORE_ENTRY ?? pathToFileURL(defaultStorePath).href;
const store = await import(storeUrl);

const memoryDir = store.memoryDir();
const factPath = store.factPath();
mkdirSync(memoryDir, { recursive: true });

/* ── 假项目：根目录自带 MEMORY.md（模板同 01 §3.2） ── */
const projectRoot = join(home, 'proj');
const memoryPath = join(projectRoot, 'MEMORY.md');
mkdirSync(projectRoot, { recursive: true });
/* 一个「没有项目记忆」的目录：先放 .git，`findProjectMemory()` 到它即停，不越界到上层。 */
const noProjectRoot = join(home, 'no-project');
mkdirSync(join(noProjectRoot, '.git'), { recursive: true });

const FACT_BASE = [
    '# FACT.md — 全局长期记忆',
    '',
    '## 关于用户',
    '',
    '- 称呼「呜咕」',
    '- 用中文沟通',
    '',
    '## 关于环境',
    '',
    '- 系统 node v22',
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
    '- 打包：pnpm pack',
    '',
].join('\n');

const resetFact = (text = FACT_BASE) => writeFileSync(factPath, text, 'utf8');
const resetMemory = (text = MEMORY_BASE) => writeFileSync(memoryPath, text, 'utf8');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const factText = () => readFileSync(factPath, 'utf8');
const memoryText = () => readFileSync(memoryPath, 'utf8');

/* ── 极简 PASS/FAIL 报告器（失败不中断，攒到最后统一退出码 1） ── */
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

resetFact();
resetMemory();

/* ── 1) 超限错误码 + 文案不变 ── */
await check('闸口错误带 code=MEMORY_BUDGET_EXCEEDED，且 message 一字不改', () => {
    assert.throws(
        () => store.assertFactWithinLimit(Array.from({ length: 101 }, (_, i) => `- 行 ${i}`).join('\n'), 100, 8000),
        (error) => {
            assert.equal(error.code, 'MEMORY_BUDGET_EXCEEDED');
            assert.equal(store.isBudgetError(error), true);
            assert.equal(
                error.message,
                [
                    '全局记忆 FACT.md 有硬上限 100 行 / 8000 字节，本次 content 是 101 行（超出 1 行，上限 100 行），已拒绝写入。',
                    '- 全局 FACT.md 只放「跨会话、跨项目都成立」的事实：请先精简到 100 行且 8000 字节以内再写。',
                    '- 项目专属内容（某个工作区的约定、清单、踩坑、机制探索结论）请改用 action=update, scope=project，写当前项目根的 MEMORY.md。',
                    '- 一次性事件/会话笔记请用 action=append 写 JOURNAL.jsonl。',
                ].join('\n'),
            );
            assert.deepEqual(error.details.scope, 'fact');
            assert.equal(error.details.lines, 101);
            assert.ok(error.details.bytes > 0);
            assert.ok(error.details.chars > 0);
            assert.deepEqual(error.details.limit, { lines: 100, bytes: 8000 });
            return true;
        },
    );
});

await check('项目记忆闸口同样带 code 与 {scope, lines, bytes, chars, limit}', () => {
    assert.throws(
        () => store.assertProjectMemoryWithinLimit('a'.repeat(8001), 8000),
        (error) => {
            assert.equal(error.code, 'MEMORY_BUDGET_EXCEEDED');
            assert.match(error.message, /项目记忆 MEMORY\.md 有硬上限 8000 字符/);
            assert.equal(error.details.scope, 'memory');
            assert.equal(error.details.chars, 8001);
            assert.deepEqual(error.details.limit, { chars: 8000 });
            return true;
        },
    );
});

await check('isBudgetError：普通错误与空值都返回 false', () => {
    assert.equal(store.isBudgetError(new Error('其它错误')), false);
    assert.equal(store.isBudgetError(null), false);
    assert.equal(store.isBudgetError(undefined), false);
});

await check('configureStore()：覆盖上限、缺省键回落默认值', () => {
    assert.deepEqual(store.limits(), { maxFactLines: 100, maxFactBytes: 8000, maxProjectChars: 8000 });
    assert.deepEqual(store.configureStore({ maxFactLines: 5 }), { maxFactLines: 5, maxFactBytes: 8000, maxProjectChars: 8000 });
    assert.throws(() => store.assertFactWithinLimit(Array.from({ length: 6 }, (_, i) => `- 行 ${i}`).join('\n')), (error) => store.isBudgetError(error) && error.details.limit.lines === 5);
    store.configureStore({});
    assert.deepEqual(store.limits(), { maxFactLines: 100, maxFactBytes: 8000, maxProjectChars: 8000 });
});

/* ── 2) watermark ── */
await check('watermark(fact)：行/字节/字符与上限', () => {
    resetFact();
    const mark = store.watermark('fact');
    assert.equal(mark.lines, store.countLines(FACT_BASE));
    assert.equal(mark.bytes, store.countBytes(FACT_BASE));
    assert.equal(mark.chars, store.countChars(FACT_BASE));
    assert.deepEqual(mark.limit, { lines: 100, bytes: 8000 });
});

await check('watermark(memory)：按 cwd 找到项目 MEMORY.md', () => {
    resetMemory();
    const mark = store.watermark('memory', { cwd: join(projectRoot, 'src') });
    assert.equal(mark.lines, store.countLines(MEMORY_BASE));
    assert.equal(mark.chars, store.countChars(MEMORY_BASE));
    assert.deepEqual(mark.limit, { chars: 8000 });
    assert.equal(mark.path, memoryPath);
});

await check('watermark(memory)：没有项目记忆时给 0 值 + 上限', () => {
    const mark = store.watermark('memory', { cwd: noProjectRoot });
    assert.equal(mark.lines, 0);
    assert.equal(mark.bytes, 0);
    assert.equal(mark.chars, 0);
    assert.deepEqual(mark.limit, { chars: 8000 });
});

await check('watermark：global/project 别名等价于 fact/memory', () => {
    assert.equal(store.watermark('global').scope, 'fact');
    assert.equal(store.watermark('project', { cwd: projectRoot }).scope, 'memory');
});

/* ── 3) templates ── */
await check('templates()：形状齐全，promptFragment 含四条硬规则 + FACT 原因词表', () => {
    const tpl = store.templates();
    assert.equal(typeof tpl.fact.sectionHint, 'string');
    assert.equal(tpl.fact.linePrefix, '- ');
    assert.equal(typeof tpl.memory.listStyle, 'string');
    assert.ok(tpl.memory.listStyle.includes('速查'), 'memory.listStyle 应指向末尾「速查」区');
    const fragment = tpl.promptFragment;
    assert.ok(fragment.includes('120'), '规则 1：一行一个结论 ≤120 字');
    assert.ok(fragment.includes('速查'), '规则 2：命令/路径进「速查」区');
    assert.ok(fragment.includes('行内代码'), '规则 2：正文禁行内代码');
    assert.ok(fragment.includes('过程叙述'), '规则 3：禁过程叙述');
    assert.ok(fragment.includes('中文叙述'), '规则 4：中文叙述，英文只留专有名词');
    for (const word of ['因为', '由于', '为了', '所以', '原因是', '理由', '考虑到', '之所以']) {
        assert.ok(fragment.includes(word), `promptFragment 应列出禁用原因词：${word}`);
    }
});

/* ── 4) validateEntry：01 §3.3 的逐条样本 ── */
await check('validateEntry：11 条违规样本按表处理（drop / journal）', () => {
    const cases = [
        // [scope, 文本, 期望 demote, 期望 reason 片段]
        ['fact', `${'这一段结论非常长'.repeat(20)}`, 'drop', '超过 120 字'],
        ['fact', '因为依赖要装两次', 'drop', '原因词'],
        ['fact', '我觉得这个更快', 'drop', '第一人称'],
        ['fact', '这条结论成立吗？', 'journal', '问句'],
        ['fact', '先打包，接着安装', 'journal', '过程词'],
        ['fact', 'a `x` b `y` c `z` d', 'journal', '行内代码'],
        ['fact', 'push 之后 profile 的 bundles 需要 sync', 'journal', '英文'],
        ['fact', 'api_key=abcdefghijkl', 'drop', '敏感串'],
        ['fact', '手机号 13800138000', 'drop', '敏感串'],
        ['fact', '私钥 -----BEGIN RSA PRIVATE KEY----- MIIE -----END RSA PRIVATE KEY-----', 'drop', '敏感串'],
        ['fact', '最后发现补丁不生效', 'journal', '过程叙述'],
    ];
    for (const [scope, text, demote, reason] of cases) {
        const verdict = store.validateEntry(scope, text, { cwd: join(home, 'no-project') });
        assert.equal(verdict.ok, false, `应被拦下：${text}`);
        assert.equal(verdict.demote, demote, `${text} 应 ${demote}，实际 ${verdict.demote}（${verdict.reason}）`);
        assert.ok(verdict.reason.includes(reason), `${text} 的 reason 应含「${reason}」，实际「${verdict.reason}」`);
    }
    assert.equal(cases.length >= 8, true);

    /* 0.8.6：memory 条目不再要求「cwd 下已有 MEMORY.md」——cwd 就是项目根，首次写入即创建 */
    assert.equal(
        store.validateEntry('memory', '只跟某个目录有关的结论', { cwd: join(home, 'no-project') }).ok,
        true,
        '缺 MEMORY.md 也应放行（自动沉淀要能长出第一份项目记忆）',
    );
    const noCwd = store.validateEntry('memory', '只跟某个目录有关的结论', { cwd: '' });
    assert.equal(noCwd.ok, false);
    assert.equal(noCwd.demote, 'journal');
});

await check('validateEntry：2 条正常样本放行（FACT / MEMORY 各一）', () => {
    const fact = store.validateEntry('fact', '称呼「呜咕」');
    assert.deepEqual(fact, { ok: true });
    const memory = store.validateEntry('memory', { text: '本目录是插件装配站，不是依赖源', confidence: 'high' }, { cwd: projectRoot });
    assert.deepEqual(memory, { ok: true });
});

await check('validateEntry：接受字符串或 {text, confidence, workspaceId}，空条目 drop', () => {
    assert.deepEqual(store.validateEntry('fact', '  用中文沟通  '), { ok: true });
    assert.deepEqual(store.validateEntry('fact', { text: '用中文沟通', confidence: 'low', workspaceId: 'w1' }), { ok: true });
    assert.equal(store.validateEntry('fact', '   ').demote, 'drop');
    assert.equal(store.validateEntry('fact', { text: '用中文沟通' }).ok, true);
});

/* ── 5) insertEntry：落位 ── */
await check('insertEntry(fact)：插进同名 `##` 分组内（不越到下一个分组）', async () => {
    resetFact();
    const result = await store.insertEntry('fact', { text: 'adb 用平台工具那一份', section: '关于环境' }, { cwd: projectRoot });
    assert.equal(result.written, true);
    assert.equal(result.target, factPath);
    const lines = factText().split('\n');
    const envIndex = lines.indexOf('## 关于环境');
    const nextIndex = lines.indexOf('## 长期约定');
    const insertedIndex = lines.indexOf('- adb 用平台工具那一份');
    assert.ok(insertedIndex > envIndex, '应落在「关于环境」之后');
    assert.ok(insertedIndex < nextIndex, '应落在「长期约定」之前');
    // 备份也写了
    assert.ok(existsSync(join(memoryDir, 'backups')), '应创建 memory/backups');
});

await check('insertEntry(fact)：没有匹配分组时建 `## 其它`', async () => {
    resetFact();
    const result = await store.insertEntry('fact', '不存在的分组结论', { cwd: projectRoot });
    assert.equal(result.written, true);
    const raw = factText();
    assert.ok(raw.includes('## 其它'), '应建出「## 其它」分组');
    assert.ok(/\n## 其它\n\n- 不存在的分组结论\n/.test(raw), `结论应在「## 其它」下面：\n${raw}`);
});

await check('insertEntry(memory)：编号顺延，落在「## 速查」之前', async () => {
    resetMemory();
    const result = await store.insertEntry('memory', '新结论进项目记忆', { cwd: projectRoot });
    assert.equal(result.written, true);
    assert.equal(result.target, memoryPath);
    const raw = memoryText();
    assert.ok(raw.includes('3. 新结论进项目记忆'), `应写成 3 号条目：\n${raw}`);
    assert.ok(raw.indexOf('3. 新结论进项目记忆') < raw.indexOf('## 速查'), '应插在速查区之前');
    assert.ok(raw.indexOf('2. 安装与重启') < raw.indexOf('3. 新结论进项目记忆'), '应排在 2 号之后');
});

await check('insertEntry：校验不过不写盘，返回 demoted', async () => {
    resetFact();
    const before = sha256(factPath);
    const result = await store.insertEntry('fact', '因为我想这么写', { cwd: projectRoot });
    assert.equal(result.written, false);
    assert.equal(result.demoted, 'drop');
    assert.equal(sha256(factPath), before, '校验不过时文件不得改动');
});

/* ── 6) 超限拒写：SHA256 不变 ── */
await check('insertEntry 超限抛 MEMORY_BUDGET_EXCEEDED，文件 SHA256 不变', async () => {
    resetFact('- 一\n- 二\n- 三\n- 四\n');
    const before = sha256(factPath);
    store.configureStore({ maxFactLines: 4 });
    try {
        await assert.rejects(
            () => store.insertEntry('fact', '第五条结论', { cwd: projectRoot }),
            (error) => {
                assert.equal(store.isBudgetError(error), true);
                assert.equal(error.code, 'MEMORY_BUDGET_EXCEEDED');
                assert.equal(error.details.limit.lines, 4);
                return true;
            },
        );
    }
    finally {
        store.configureStore({});
    }
    assert.equal(sha256(factPath), before, '超限拒写后文件必须逐字节不变');
});

await check('assertEntry：校验/闸口薄包装（超限抛 code，正常返回 ok）', () => {
    resetFact('- 一\n- 二\n');
    store.configureStore({ maxFactLines: 2 });
    try {
        assert.throws(() => store.assertEntry('fact', '第三条'), (error) => store.isBudgetError(error));
        assert.throws(() => store.assertEntry('fact', '因为不行'), (error) => error.code === 'MEMORY_ENTRY_REJECTED' && error.details.demote === 'drop');
    }
    finally {
        store.configureStore({});
    }
    assert.equal(store.assertEntry('fact', '第三条').ok, true);
});

/* ── 7) replace / delete / not-found ── */
await check('findEntry + replaceEntry：按 id 替换，保留 `- ` 前缀', async () => {
    resetFact();
    const found = store.findEntry('fact', '称呼「呜咕」');
    assert.ok(found !== null, '应能定位到条目');
    assert.ok(typeof found.id === 'string' && /^[0-9a-f]{10}$/.test(found.id), '定位结果应带 id');
    assert.equal(found.section, '关于用户');
    const result = await store.replaceEntry('fact', found.id, '称呼「呜咕」，用中文沟通', { cwd: projectRoot });
    assert.equal(result.written, true);
    const raw = factText();
    assert.ok(raw.includes('- 称呼「呜咕」，用中文沟通'), '应被替换');
    assert.ok(!raw.includes('- 称呼「呜咕」\n'), '旧条目不应还在');
});

await check('replaceEntry：找不到 / id 为空 ⇒ written:false, notFound:true', async () => {
    resetFact();
    const missing = await store.replaceEntry('fact', 'ffffffffff', '随便一条结论', { cwd: projectRoot });
    assert.equal(missing.written, false);
    assert.equal(missing.notFound, true);
    const empty = await store.replaceEntry('fact', '', '随便一条结论', { cwd: projectRoot });
    assert.equal(empty.notFound, true);
});

await check('deleteEntry：删掉命中条目；再删同一条返回 deleted:false', async () => {
    resetFact();
    resetMemory();
    const inserted = await store.insertEntry('memory', '待删除的结论', { cwd: projectRoot });
    assert.equal(inserted.written, true);
    const deleted = await store.deleteEntry('memory', inserted.id, { cwd: projectRoot });
    assert.equal(deleted.deleted, true);
    assert.ok(!memoryText().includes('待删除的结论'), '删除后文件里不应还有它');
    const again = await store.deleteEntry('memory', inserted.id, { cwd: projectRoot });
    assert.equal(again.deleted, false);
});

/* ── 8) 侧车索引：建立 + 孤儿修剪 ── */
await check('memoryIndex：索引文件落盘（version 1 + 按 id 键控），条目含元数据', async () => {
    resetFact();
    const inserted = await store.insertEntry('fact', '索引里要有的结论', { cwd: projectRoot });
    const file = join(memoryDir, 'index.json');
    assert.ok(existsSync(file), '应写出 memory/index.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(parsed.version, 1);
    assert.ok(parsed.entries[inserted.id], '新条目应有索引记录');
    assert.equal(parsed.entries[inserted.id].scope, 'fact');
    assert.equal(parsed.entries[inserted.id].hits, 1);
    assert.equal(parsed.entries[inserted.id].confidence, 'medium');
    assert.ok(Number.isFinite(parsed.entries[inserted.id].firstSeen));

    const index = store.memoryIndex();
    const entry = index.list.find((item) => item.id === inserted.id);
    assert.ok(entry, 'memoryIndex().list 里应有它');
    assert.equal(entry.scope, 'fact');
    assert.ok(Number.isFinite(entry.ts), 'list 视图应带 ts（= firstSeen）');
});

await check('memoryIndex：正文被人工改过 ⇒ 旧记录成孤儿，读到就剪掉', async () => {
    resetFact();
    const inserted = await store.insertEntry('fact', '会被人工改掉的结论', { cwd: projectRoot });
    assert.ok(store.memoryIndex().entries[inserted.id], '前置：索引里有它');
    // 模拟人工编辑：这一行被改写了 ⇒ id 变了
    resetFact(FACT_BASE.replace('- 先看日志再动手', '- 先看日志再动手，别猜'));
    const after = store.memoryIndex();
    assert.equal(after.entries[inserted.id], undefined, '孤儿应被剪掉');
    assert.ok(after.list.every((item) => item.id !== inserted.id));
});

await check('memoryIndex：索引损坏 ⇒ 空索引，不抛错', () => {
    writeFileSync(join(memoryDir, 'index.json'), '{ 这不是 JSON', 'utf8');
    const index = store.memoryIndex();
    assert.deepEqual(index.entries, {});
    assert.deepEqual(index.list, []);
});

/* ── 9) 写锁 ── */
await check('acquireWriteLock：互斥（第二次必须等 release）', async () => {
    const release = await store.acquireWriteLock('fact', { timeoutMs: 1000 });
    let second = null;
    const pending = store.acquireWriteLock('fact', { timeoutMs: 1000 }).then((fn) => {
        second = fn;
        return fn;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(second, null, '第一次没 release 之前第二次不该拿到锁');
    release();
    const release2 = await pending;
    assert.equal(typeof release2, 'function');
    release2();
});

await check('acquireWriteLock：超时抛错（默认 5000ms，可传 timeoutMs）', async () => {
    const release = await store.acquireWriteLock('fact', { timeoutMs: 1000 });
    try {
        await assert.rejects(
            () => store.acquireWriteLock('fact', { timeoutMs: 60 }),
            (error) => {
                assert.match(error.message, /获取写锁超时/);
                assert.equal(error.code, 'MEMORY_LOCK_TIMEOUT');
                return true;
            },
        );
    }
    finally {
        release();
    }
});

await check('acquireWriteLock：不同作用域互不阻塞（fact vs memory:<root>）', async () => {
    const releaseFact = await store.acquireWriteLock('fact', { timeoutMs: 1000 });
    try {
        const releaseMemory = await store.acquireWriteLock('memory', { cwd: projectRoot, timeoutMs: 1000 });
        releaseMemory();
    }
    finally {
        releaseFact();
    }
});

/* ── 10) JOURNAL：id 稳定 ── */
await check('appendJournal 返回 {id, ts}，落盘行同 id，且 id == entryId(ts, text)', async () => {
    writeFileSync(store.journalPath(), '', 'utf8');
    const entry = await store.appendJournal('第一条日志', ['t']);
    assert.deepEqual(Object.keys(entry), ['id', 'ts']);
    assert.equal(entry.id, store.entryId(entry.ts, '第一条日志'));
    const rows = readFileSync(store.journalPath(), 'utf8').split('\n').filter((line) => line !== '');
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0]), { id: entry.id, ts: entry.ts, tags: ['t'], text: '第一条日志' });
    const back = store.readJournal(10).entries[0];
    assert.equal(back.id, entry.id, 'readJournal 应回同一个 id');
    assert.equal(back.status, 'active');
    assert.equal(store.listJournal({ tail: 10 })[0].id, entry.id);
});

await check('readJournal：老条目（没有 id 字段）惰性补 id，且不落盘改写', () => {
    const legacyPath = store.journalPath();
    writeFileSync(legacyPath, `${JSON.stringify({ ts: '2026-10-31T00:00:00.000Z', tags: [], text: '老条目' })}\n`, 'utf8');
    const before = readFileSync(legacyPath, 'utf8');
    const entry = store.readJournal(10).entries[0];
    assert.match(entry.id, /^[0-9a-f]{10}$/);
    assert.equal(entry.id, store.entryId('2026-10-31T00:00:00.000Z', '老条目'));
    assert.equal(readFileSync(legacyPath, 'utf8'), before, '惰性 id 不得把文件改写');
});

/* ── 11) supersede：移动一条 + 归档脱敏 ── */
await check('supersedeJournal：只移动命中的那条，归档前脱敏，readJournal 看不到它', async () => {
    writeFileSync(store.journalPath(), '', 'utf8');
    const one = await appendJournalFrom('手机号 13900139000 记一下', ['secret']);
    const two = await appendJournalFrom('保留这一条', ['keep']);
    await appendJournalFrom('也保留这一条', []);

    const result = await store.supersedeJournal([one.id], '与现行事实冲突');
    assert.equal(result.moved, 1, '只应移动一条');
    assert.equal(result.archived, 1, '归档文件里应有 1 条');

    const active = store.readJournal(10);
    assert.equal(active.total, 2);
    assert.ok(active.entries.every((entry) => entry.id !== one.id), 'readJournal 不应再看到它');
    assert.ok(active.entries.some((entry) => entry.id === two.id), '未命中的条目应原样保留');

    const archiveRaw = readFileSync(store.journalArchivePath(), 'utf8');
    assert.ok(!archiveRaw.includes('13900139000'), '归档必须脱敏');
    assert.ok(archiveRaw.includes('⟨redacted⟩'), '归档应出现统一占位符');
    const archived = JSON.parse(archiveRaw.trim());
    assert.equal(archived.id, one.id);
    assert.equal(archived.reason, '与现行事实冲突');
    assert.ok(typeof archived.supersededAt === 'string' && archived.supersededAt !== '');
    assert.deepEqual(archived.tags, ['secret']);

    // 默认不返回归档；includeArchived 才给
    assert.equal(store.listJournal({ tail: 10 }).some((entry) => entry.id === one.id), false);
    const all = store.listJournal({ tail: 10, includeArchived: true });
    const restored = all.find((entry) => entry.id === one.id);
    assert.ok(restored, 'includeArchived 应能拿到归档条目');
    assert.equal(restored.status, 'archived');
    assert.equal(restored.reason, '与现行事实冲突');
});

await check('supersedeJournal：不存在的 id 不产生归档行', async () => {
    const before = readFileSync(store.journalArchivePath(), 'utf8');
    const result = await store.supersedeJournal(['0000000000'], '无命中');
    assert.equal(result.moved, 0);
    assert.equal(readFileSync(store.journalArchivePath(), 'utf8'), before, '归档文件不应变化');
});

/* ── 12) 并发：append + supersede 不丢行 ── */
await check('并发 append + supersede：一条都不丢', async () => {
    writeFileSync(store.journalPath(), '', 'utf8');
    writeFileSync(store.journalArchivePath(), '', 'utf8');
    const base = [];
    for (let index = 0; index < 5; index += 1)
        base.push(await appendJournalFrom(`基线日志 ${index}`, ['base']));
    const target = base[1];

    await Promise.all([
        store.appendJournal('并发追加 A', ['a']),
        store.appendJournal('并发追加 B', ['b']),
        store.supersedeJournal([target.id], '并发失效'),
    ]);

    const active = store.readJournal(100).entries;
    assert.equal(active.length, 6, `基线 5 条 - 失效 1 条 + 追加 2 条 = 6 条，实际 ${active.length}`);
    assert.ok(active.every((entry) => entry.id !== target.id), '目标条目应已移出');
    assert.ok(active.some((entry) => entry.text === '并发追加 A'), 'A 不该丢');
    assert.ok(active.some((entry) => entry.text === '并发追加 B'), 'B 不该丢');
    assert.equal(readFileSync(store.journalArchivePath(), 'utf8').split('\n').filter((line) => line !== '').length, 1);
});

/* ── 收尾 ── */
rmSync(home, { recursive: true, force: true });

if (failures.length > 0) {
    console.log(`\n✗ store-api.test.mjs 失败 ${failures.length}/${checks}：${failures.join('、')}`);
    process.exit(1);
}
console.log(`\n✓ store-api.test.mjs 全部通过（${checks} 项）`);

/** 小工具：按固定文本追加一条日志。 */
async function appendJournalFrom(text, tags) {
    return store.appendJournal(text, tags);
}
