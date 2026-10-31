/**
 * 回归测试：`lib/store.js`（存储层子路径，0.7.0 从 lib/index.js 原样搬出）。
 *
 * 背景：P1 把存储层搬到 `./store` 子路径，让附属插件能 import，**逻辑一行不改**。
 * 本测试是这次搬家的对照基准，覆盖「搬出去的东西行为没变」：
 *  1. `appendJournal` → `readJournal` 往返（text/tags/ts 逐字段、`total` 计数）；
 *  2. `appendJournal` 返回值是 `{id, ts}`（0.7.0 起带稳定 id，落盘行也带 id）；
 *  3. `countLines` / `countBytes` / `countChars` 的精确口径（空串、尾换行、CRLF）；
 *  4. `assertFactWithinLimit` 恰好等于上限通过、超一行 / 超一字节就抛（文案不变）；
 *  5. `assertProjectMemoryWithinLimit` 超字符上限即抛；
 *  6. `findProjectMemory` 向上找 MEMORY.md，先遇到 `.git` 则返回 null；
 *  7. `import(pathToFileURL(lib/store.js))` 独立可用，且只依赖 node 内置模块。
 *
 * 跑法：node test/store.test.mjs
 * （run-all.ps1 第 10 步用 PERSONA_MEMORY_STORE_ENTRY 指向已装份的 lib/store.js 复跑。）
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-store-'));
process.env.DSH_HOME = home;

const defaultStorePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'store.js');
const storeUrl = process.env.PERSONA_MEMORY_STORE_ENTRY ?? pathToFileURL(defaultStorePath).href;
const storePath = fileURLToPath(storeUrl);

const store = await import(storeUrl);

const memoryDir = join(home, 'memory');
const journalPath = join(memoryDir, 'JOURNAL.jsonl');

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
const lines = (count, prefix = '行') => Array.from({ length: count }, (_, index) => `- ${prefix} ${index + 1}`).join('\n');

/* ── 1) JOURNAL：空 → 追加 → 读回 ── */
await check('readJournal：文件不存在时返回 { entries: [], total: 0 }', () => {
    assert.deepEqual(store.readJournal(10), { entries: [], total: 0 });
});

let firstEntry;
await check('appendJournal 返回 {id, ts}（id = sha1(ts+规范化文本).slice(0,10)）', async () => {
    firstEntry = await store.appendJournal('第一条笔记：node 用 v22.23.3', ['env']);
    assert.deepEqual(Object.keys(firstEntry), ['id', 'ts']);
    assert.equal(firstEntry.id, store.entryId(firstEntry.ts, '第一条笔记：node 用 v22.23.3'));
    assert.match(firstEntry.id, /^[0-9a-f]{10}$/);
    assert.match(firstEntry.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(!Number.isNaN(Date.parse(firstEntry.ts)), 'ts 应是可解析的 ISO 时间戳');
});

await check('appendJournal 写进 $DSH_HOME/memory/JOURNAL.jsonl（JSONL，一行一条，行内含 id）', () => {
    assert.equal(store.journalPath(), journalPath, 'journalPath() 应指向 $DSH_HOME/memory/JOURNAL.jsonl');
    assert.ok(existsSync(journalPath), '应创建 JOURNAL.jsonl');
    const raw = readFileSync(journalPath, 'utf8');
    const rows = raw.split('\n').filter((line) => line !== '');
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0]), {
        id: firstEntry.id,
        ts: firstEntry.ts,
        tags: ['env'],
        text: '第一条笔记：node 用 v22.23.3',
    });
});

let secondEntry;
await check('appendJournal → readJournal 往返：id / text / tags / ts 逐字段一致，total 计数正确', async () => {
    secondEntry = await store.appendJournal('第二条笔记', ['env', 'adb']);
    const { entries, total } = store.readJournal(10);
    assert.equal(total, 2, 'total 应是日志总条数');
    assert.equal(entries.length, 2, 'limit 大于总数时应返回全部');
    assert.deepEqual(entries[0], {
        id: firstEntry.id,
        ts: firstEntry.ts,
        tags: ['env'],
        text: '第一条笔记：node 用 v22.23.3',
        status: 'active',
    });
    assert.deepEqual(entries[1], {
        id: secondEntry.id,
        ts: secondEntry.ts,
        tags: ['env', 'adb'],
        text: '第二条笔记',
        status: 'active',
    });
});

await check('readJournal(limit)：只取尾部 limit 条，total 仍是总数', () => {
    const { entries, total } = store.readJournal(1);
    assert.equal(total, 2);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, secondEntry.id);
    assert.equal(entries[0].text, '第二条笔记');
});

await check('searchJournal：子串与 tag 过滤（新→旧）', () => {
    assert.deepEqual(store.searchJournal('第二条', '', 10).map((e) => e.text), ['第二条笔记']);
    assert.deepEqual(store.searchJournal('', 'adb', 10).map((e) => e.text), ['第二条笔记']);
    assert.deepEqual(store.searchJournal('', '', 10).map((e) => e.text), ['第二条笔记', '第一条笔记：node 用 v22.23.3']);
    assert.deepEqual(store.searchJournal('不存在的串', '', 10), []);
});

/* ── 2) 计量口径 ── */
await check('countLines："" → 0，尾换行不算额外一行，CRLF 归一化', () => {
    assert.equal(store.countLines(''), 0);
    assert.equal(store.countLines('\n'), 1);
    assert.equal(store.countLines('a'), 1);
    assert.equal(store.countLines('a\n'), 1, '尾换行不该把 1 行算成 2 行');
    assert.equal(store.countLines('a\nb'), 2);
    assert.equal(store.countLines('a\nb\n'), 2, '尾换行不该把 2 行算成 3 行');
    assert.equal(store.countLines('a\r\nb\r\n'), 2, 'CRLF 与 LF 同口径');
    assert.equal(store.countLines('a\r\nb'), 2);
});

await check('countBytes：UTF-8 计字节，CRLF 归一化后每行尾 1 字节', () => {
    assert.equal(store.countBytes(''), 0);
    assert.equal(store.countBytes('a'), 1);
    assert.equal(store.countBytes('喵'), 3, '中文按 UTF-8 3 字节计');
    assert.equal(store.countBytes('a\nb'), 3);
    assert.equal(store.countBytes('a\r\nb'), 3, '\\r\\n 归一化成 \\n 后计数');
});

await check('countChars：trim() 后长度，**不**归一化 CRLF（与注入侧 clip() 同口径）', () => {
    assert.equal(store.countChars(''), 0);
    assert.equal(store.countChars('  a  '), 1, '两端空白被 trim 掉');
    assert.equal(store.countChars('喵'), 1);
    assert.equal(store.countChars('a\r\nb'), 4, '按字符计不归一化：a + \\r + \\n + b');
    assert.equal(store.countChars('😀'), 2, '口径是 UTF-16 码元长度');
});

/* ── 3) FACT 双闸口 ── */
await check('assertFactWithinLimit：恰好 100 行 / 8000 字节通过', () => {
    assert.doesNotThrow(() => store.assertFactWithinLimit(lines(100), 100, 8000), '正好 100 行应通过');
    assert.doesNotThrow(() => store.assertFactWithinLimit('a'.repeat(8000), 100, 8000), '正好 8000 字节应通过');
    assert.doesNotThrow(() => store.assertFactWithinLimit(`${lines(100)}\n`, 100, 8000), '尾换行不该算成 101 行');
});

await check('assertFactWithinLimit：101 行抛错（文案逐字不变）', () => {
    assert.throws(
        () => store.assertFactWithinLimit(lines(101), 100, 8000),
        (error) => {
            assert.match(error.message, /全局记忆 FACT\.md 有硬上限 100 行 \/ 8000 字节/);
            assert.match(error.message, /101 行（超出 1 行，上限 100 行）/);
            assert.match(error.message, /scope=project/);
            assert.match(error.message, /action=append/);
            return true;
        },
        '超过 100 行必须抛错',
    );
});

await check('assertFactWithinLimit：8001 字节抛错（行数没超也要拦）', () => {
    assert.throws(
        () => store.assertFactWithinLimit('a'.repeat(8001), 100, 8000),
        (error) => {
            assert.match(error.message, /8001 字节（超出 1 字节，上限 8000 字节）/);
            assert.ok(!/超出 \d+ 行/.test(error.message), '行数没超就不该报行数超限');
            return true;
        },
        '超过 8000 字节必须抛错',
    );
});

/* ── 4) 项目 MEMORY 闸口 ── */
await check('assertProjectMemoryWithinLimit：8000 字符通过、8001 字符抛错', () => {
    assert.doesNotThrow(() => store.assertProjectMemoryWithinLimit('a'.repeat(8000), 8000));
    assert.throws(
        () => store.assertProjectMemoryWithinLimit('a'.repeat(8001), 8000),
        (error) => {
            assert.match(error.message, /项目记忆 MEMORY\.md 有硬上限 8000 字符/);
            assert.match(error.message, /8001 字符（超出 1 字符）/);
            assert.match(error.message, /action=append/);
            assert.match(error.message, /action=update, scope=global/);
            return true;
        },
        '超过 8000 字符必须抛错',
    );
});

/* ── 5) 项目根定位 ── */
const projectRoot = join(home, 'proj');
const nestedDir = join(projectRoot, 'a', 'b', 'c');
const projectMemoryPath = join(projectRoot, 'MEMORY.md');
await check('findProjectMemory：从深层目录向上找到 MEMORY.md', () => {
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(projectMemoryPath, '# 项目\n', 'utf8');
    const found = store.findProjectMemory(nestedDir);
    assert.ok(found, '应找到项目记忆');
    assert.equal(found.root, projectRoot, 'root 应是含 MEMORY.md 的目录');
    assert.equal(found.path, projectMemoryPath);
    assert.equal(found.exists, true);
    assert.equal(found.content, '# 项目\n');
});

await check('findProjectMemory：先遇到 .git 就返回 null（不越界到上层项目）', () => {
    const outer = join(home, 'outer');
    const repo = join(outer, 'repo');
    const deep = join(repo, 'src');
    mkdirSync(deep, { recursive: true });
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(outer, 'MEMORY.md'), '# 上层\n', 'utf8');
    assert.ok(store.findProjectMemory(outer) !== null, '前置：outer 自己有 MEMORY.md');
    assert.equal(store.findProjectMemory(deep), null, 'repo 有 .git 就该停下，返 null');
});

await check('findProjectMemory：cwd 为空/非字符串返回 null', () => {
    assert.equal(store.findProjectMemory(''), null);
    assert.equal(store.findProjectMemory('   '), null);
    assert.equal(store.findProjectMemory(undefined), null);
    assert.equal(store.findProjectMemory(null), null);
});

/* ── 6) 读写原语 ── */
await check('readText：文件不存在返回 null；writeAtomic：建目录 + 原子覆盖', () => {
    const target = join(home, 'atomic', 'deep', 'file.txt');
    assert.equal(store.readText(target), null);
    store.writeAtomic(target, 'v1');
    assert.equal(store.readText(target), 'v1');
    store.writeAtomic(target, 'v2');
    assert.equal(store.readText(target), 'v2');
    assert.equal(readFileSync(target, 'utf8'), 'v2');
});

/* ── 7) 独立可用：只依赖 node 内置模块 + 导出名单 ── */
await check('lib/store.js 只依赖 node 内置模块（不引 schemastery、不读 config）', () => {
    const source = readFileSync(storePath, 'utf8');
    const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1]);
    assert.ok(specifiers.length > 0, '应至少 import 一个内置模块');
    for (const specifier of specifiers) {
        assert.ok(specifier.startsWith('node:'), `lib/store.js 不应依赖非内置模块：${specifier}`);
    }
    assert.ok(!/schemastery/.test(source), 'lib/store.js 不应引用 schemastery');
    assert.ok(!/\bConfig\b/.test(source), 'lib/store.js 不应引用 Config');
});

await check('import(pathToFileURL(lib/store.js)) 可用，导出名单与常量齐全', async () => {
    const standalone = await import(pathToFileURL(storePath).href);
    const functions = [
        'factPath', 'journalPath', 'readText', 'writeAtomic',
        'countLines', 'countBytes', 'countChars',
        'assertFactWithinLimit', 'assertProjectMemoryWithinLimit',
        'appendJournal', 'readJournal', 'searchJournal', 'findProjectMemory',
        // 0.7.0 · P2 新增（模板 / 校验 / 插入 / 索引 / 锁 / JOURNAL 失效）
        'configureStore', 'isBudgetError', 'watermark', 'templates',
        'memoryIndex', 'entryId', 'findEntry', 'validateEntry', 'assertEntry',
        'insertEntry', 'replaceEntry', 'deleteEntry', 'acquireWriteLock',
        'listJournal', 'supersedeJournal', 'redactSecrets',
    ];
    for (const name of functions) {
        assert.equal(typeof standalone[name], 'function', `应导出函数 ${name}`);
    }
    assert.equal(standalone.FACT_FILE, 'FACT.md');
    assert.equal(standalone.JOURNAL_FILE, 'JOURNAL.jsonl');
    assert.equal(standalone.PROJECT_MEMORY_FILE, 'MEMORY.md');
    assert.equal(standalone.DEFAULT_JOURNAL_LIMIT, 2000);
    assert.equal(standalone.memoryDir(), memoryDir, 'memoryDir() 应是 $DSH_HOME/memory');
    assert.equal(standalone.factPath(), join(memoryDir, 'FACT.md'));
    assert.equal(standalone.journalPath(), journalPath);
});

/* ── 收尾 ── */
rmSync(home, { recursive: true, force: true });

if (failures.length > 0) {
    console.log(`\n✗ store.test.mjs 失败 ${failures.length}/${checks}：${failures.join('、')}`);
    process.exit(1);
}
console.log(`\n✓ store.test.mjs 全部通过（${checks} 项）`);
