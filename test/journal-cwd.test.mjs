/**
 * 回归测试：JOURNAL 写入带 cwd / workspaceId（0.13.2 · B2）。
 *
 * 契约（三包共享）：JOURNAL.jsonl 每行新增**可选**字段 `cwd`（绝对路径）与
 * `workspaceId`（由 cwd 归一）。旧调用方两参调用必须照常可用，且行里**不出现**这两个键
 * （不是 null）；旧行没有字段时读取侧 fail-open，不报错。
 *
 * 跑法：node test/journal-cwd.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-journal-cwd-'));
process.env.DSH_HOME = home;

const store = await import('../lib/store.js');
const tools = await import('../lib/tools.js');

const memoryDir = store.memoryDir();
mkdirSync(memoryDir, { recursive: true });
const journalPath = store.journalPath();
const projectRoot = join(home, 'proj');
mkdirSync(projectRoot, { recursive: true });

store.configureStore({ maxFactLines: 100, maxFactBytes: 8000, maxProjectChars: 8000, compactionEnabled: false });

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
const lines = () => readFileSync(journalPath, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));

/* ═════════════ 1) 三参：行里带 cwd + workspaceId（绝对路径归一） ═════════════ */
await check('appendJournal(text, tags, {cwd})：行里带 cwd（绝对路径）与 workspaceId（归一后的同一路径）', async () => {
    const entry = await store.appendJournal('带归属的日志', ['b2'], { cwd: projectRoot });
    const [record] = lines();
    assert.equal(record.cwd, projectRoot, 'cwd 要落成绝对路径');
    assert.equal(record.workspaceId, projectRoot, 'workspaceId 由 cwd 归一（这里的 cwd 本身就是绝对路径）');
    assert.equal(record.text, '带归属的日志');
    // 返回值也带上 cwd，调用方不必再读盘
    assert.equal(entry.cwd, projectRoot);
    // 相对路径也要归一成绝对路径
    const relative = await store.appendJournal('相对路径归属', [], { cwd: '.' });
    const last = lines().at(-1);
    assert.equal(last.cwd, process.cwd(), `相对 cwd 要归一成绝对路径，实际 ${last.cwd}`);
    assert.equal(last.workspaceId, last.cwd);
    assert.ok(relative.id);
});

/* ═════════════ 2) 两参：照旧可用，行里没有 cwd/workspaceId 键 ═════════════ */
await check('两参调用（旧调用方）：照常写入，行里不出现 cwd / workspaceId 键', async () => {
    const entry = await store.appendJournal('没有归属的旧式日志', ['legacy']);
    const last = lines().at(-1);
    assert.equal(last.text, '没有归属的旧式日志');
    assert.equal('cwd' in last, false, 'cwd 为空时不许写这个键（不是 null）');
    assert.equal('workspaceId' in last, false, 'workspaceId 同理');
    assert.equal(entry.cwd, undefined);
    // cwd 是空白串 = 没给
    await store.appendJournal('空白 cwd', [], { cwd: '   ' });
    assert.equal('cwd' in lines().at(-1), false);
});

/* ═════════════ 3) 读侧：有字段读出来，旧行 fail-open ═════════════ */
await check('读 JOURNAL：有归属字段原样带出；旧行没有字段也不报错、不补键', async () => {
    // 手写一条 0.13.1 之前的老行（只有 id/ts/tags/text）
    writeFileSync(journalPath, `${readFileSync(journalPath, 'utf8')}${JSON.stringify({ id: 'old0000000', ts: '2026-01-01T00:00:00.000Z', tags: [], text: '老行没有归属' })}\n`, 'utf8');
    const { entries } = store.readJournal(100);
    const withCwd = entries.find((item) => item.text === '带归属的日志');
    assert.equal(withCwd.cwd, projectRoot);
    assert.equal(withCwd.workspaceId, projectRoot);
    const old = entries.find((item) => item.text === '老行没有归属');
    assert.ok(old, '旧行必须照样读出来');
    assert.equal('cwd' in old, false);
    assert.equal('workspaceId' in old, false);
});

/* ═════════════ 4) 工具调用点：memory action=append 传 context.cwd ═════════════ */
await check('memory 工具 action=append：落盘行带会话 cwd', async () => {
    const tool = tools.memoryTool({});
    const exec = { agent: { session: { header: { cwd: projectRoot } } } };
    await tool.execute({ action: 'append', text: '工具追加的日志', tags: ['tool'] }, exec);
    const last = lines().at(-1);
    assert.equal(last.cwd, projectRoot);
    assert.equal(last.workspaceId, projectRoot);
});

/* ═════════════ 5) index.json 新记录带 workspaceId（由 cwd 归一） ═════════════ */
await check('insertEntry（项目）：索引新记录带 workspaceId（由 cwd 归一）', async () => {
    const result = await store.insertEntry('project', { text: '带工作区的项目结论' }, { cwd: projectRoot });
    assert.equal(result.written, true);
    const record = store.memoryIndex().entries[result.id];
    assert.ok(record, '索引里应有这条记录');
    assert.equal(record.workspaceId, projectRoot, `workspaceId 应由 cwd 归一，实际 ${record.workspaceId}`);
});

/* ═════════════ 6) 整篇覆盖后同步索引：新记录的 workspaceId 继承旧记录 ═════════════ */
await check('replaceDocument 后 syncIndexAfterWrite：workspaceId 继承旧记录 / 整篇写带 kind+importance', async () => {
    const memoryFile = join(projectRoot, 'MEMORY.md');
    writeFileSync(memoryFile, '# MEMORY\n\n1. 第一条\n', 'utf8');
    // 先让索引里有带归属的记录
    const first = await store.insertEntry('project', { text: '既有条目带归属' }, { cwd: projectRoot });
    const before = store.memoryIndex().entries[first.id];
    assert.equal(before.workspaceId, projectRoot);
    const base = store.contentRevision(readFileSync(memoryFile, 'utf8'));
    const next = `${readFileSync(memoryFile, 'utf8')}2. 新加的一条\n`;
    await store.replaceDocument('memory', memoryFile, next, { cwd: projectRoot, expectedRevision: base });
    const records = Object.values(store.memoryIndex().entries).filter((meta) => meta.scope === 'memory');
    const added = records.find((meta) => meta.workspaceId === projectRoot && meta.importance === store.DEFAULT_IMPORTANCE);
    assert.ok(added, `整篇改写的新记录要带 workspaceId/importance：${JSON.stringify(records)}`);
    assert.equal(added.kind, 'conclusion');
    assert.ok(existsSync(store.indexPath()));
});

/* ── 汇总 ── */
console.log('');
if (failures.length > 0) {
    console.log(`失败 ${failures.length} / ${checks}：${failures.join('、')}`);
    process.exit(1);
}
console.log(`JOURNAL 归属用例全部通过（${checks} 条）`);
rmSync(home, { recursive: true, force: true });
