/**
 * 回归测试：importance 1–5 可维护（0.13.2 · E1）。
 *
 * 钉住四件事：
 *  1. memory 工具 importance 收 1–5 星级，映射 20/35/50/70/90；非法/越界收敛到 3（50）；
 *  2. append 带 scope ⇒ 追加一条记忆条目，importance 落 index.json 且 importanceExplicit=true
 *     （冷缺省档靠它区分「显式打分」与「缺省补的 50」，否则显式条目会被误删）；
 *  3. append 不带 scope（JOURNAL）不收 importance：日志行不产生任何索引记录；
 *  4. update 只给「本次新写入」的条目打分，老条目分数不被刷；淘汰同分时按重要性
 *     升序（低分先删），不再单纯从文件尾部删。
 *
 * 跑法：node test/importance-maintain.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-importance-maintain-'));
process.env.DSH_HOME = home;

const store = await import('../lib/store.js');
const tools = await import('../lib/tools.js');
const compaction = await import('../lib/compaction.js');

const memoryDir = store.memoryDir();
mkdirSync(memoryDir, { recursive: true });
const factPath = store.factPath();
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
const tool = tools.memoryTool({});
const exec = { agent: { session: { header: { cwd: projectRoot } } } };
const factText = () => readFileSync(factPath, 'utf8');
const findRecord = (text) => store.listEntries('fact').find((entry) => entry.text === text)?.id
    ?? store.memoryIndex().list.find((item) => item.text === undefined && false)?.id;
const recordOf = (id) => store.memoryIndex().entries[id];

/* ═════════════ 1) 星级映射 ═════════════ */
await check('append(scope=global, importance=5) ⇒ index importance=90 且 importanceExplicit=true', async () => {
    const out = await tool.execute({ action: 'append', scope: 'global', text: '核心铁律：写入前必须先拿 revision', importance: 5 }, exec);
    assert.match(out.text, /已追加全局记忆条目/);
    assert.ok(factText().includes('核心铁律：写入前必须先拿 revision'));
    const id = store.listEntries('fact').find((entry) => entry.text === '核心铁律：写入前必须先拿 revision').id;
    const record = recordOf(id);
    assert.equal(record.importance, 90);
    assert.equal(record.importanceExplicit, true, '显式打分必须标记，冷缺省档才不会再删它');
});

await check('importance 收敛：0→1(20)、9→5(90)、\'abc\'→3(50)、3→50', async () => {
    const cases = [
        ['低到越界', 0, 20],
        ['高到越界', 9, 90],
        ['非法字符串', 'abc', 50],
        ['正常三星', 3, 50],
        ['二星', 2, 35],
    ];
    for (const [text, given, wanted] of cases) {
        await tool.execute({ action: 'append', scope: 'global', text, importance: given }, exec);
        const id = store.listEntries('fact').find((entry) => entry.text === text).id;
        assert.equal(recordOf(id).importance, wanted, `${text}：${given} 应映射为 ${wanted}`);
        assert.equal(recordOf(id).importanceExplicit, true);
    }
});

/* ═════════════ 2) JOURNAL 不收 importance ═════════════ */
await check('append 不带 scope（JOURNAL）不收 importance：只写日志行，不产生索引记录', async () => {
    const before = Object.keys(store.memoryIndex().entries).length;
    await tool.execute({ action: 'append', text: '一次性日志不收 importance', tags: ['e1'], importance: 5 }, exec);
    const last = store.readJournal(5).entries.at(-1);
    assert.equal(last.text, '一次性日志不收 importance');
    assert.equal('cwd' in last, true, 'B2：日志照旧带 cwd');
    assert.equal(Object.keys(store.memoryIndex().entries).length, before, 'JOURNAL 不该写进侧车索引');
});

/* ═════════════ 3) update：只给新增条目打分 ═════════════ */
await check('update(scope=global) 带 importance：只打新条目，老条目分数不被刷', async () => {
    await tool.execute({ action: 'append', scope: 'global', text: '老条目保持原分', importance: 2 }, exec);
    const oldId = store.listEntries('fact').find((entry) => entry.text === '老条目保持原分').id;
    assert.equal(recordOf(oldId).importance, 35);
    const before = factText();
    const next = `${before}- 新写入的重要结论\n`;
    const out = await tool.execute({ action: 'update', scope: 'global', content: next, expectedRevision: store.contentRevision(before), importance: 5 }, exec);
    assert.match(out.text, /本次新写入的 1 条按 importance=90\/100/);
    const newId = store.listEntries('fact').find((entry) => entry.text === '新写入的重要结论').id;
    assert.equal(recordOf(newId).importance, 90);
    assert.equal(recordOf(newId).importanceExplicit, true);
    assert.equal(recordOf(oldId).importance, 35, '老条目分数不许被整篇覆盖刷成 90');
});

/* ═════════════ 4) 淘汰同分：按重要性升序（低分先删），不按尾部 ═════════════ */
await check('selectEvictions 同分时先删低重要性（低分写在文件前面也不许留尾巴删）', () => {
    // 两条记录分数**完全相等**：A(importance 20, hits 9, medium) 与 B(importance 90, hits 0, low)
    // 都满足 0.3×1 + … = 0.59。旧实现「同分从文件尾部删」会删 B（高分、写在后面），这里必须删 A。
    const LOW = '低重要性的细节写在最前面';
    const HIGH = '高重要性的结论写在最后面';
    const raw = `# FACT\n\n## 其它\n\n- ${LOW}\n- ${HIGH}\n`;
    const entries = compaction.parseEntries('fact', raw);
    assert.equal(entries.length, 2);
    const index = { version: 1, entries: {}, list: [], missing: false };
    const now = Date.UTC(2026, 10, 12);
    const metaOf = (entry, importance, hits, confidence) => {
        const id = store.entryId(now, entry.text);
        return { id, meta: { scope: 'fact', workspaceId: null, firstSeen: now, lastHit: now, hits, confidence, importance, importanceExplicit: true } };
    };
    const low = metaOf(entries[0], 20, 9, 'medium');
    const high = metaOf(entries[1], 90, 0, 'low');
    index.entries[low.id] = low.meta;
    index.entries[high.id] = high.meta;
    const resolved = compaction.resolveEntryIds(entries, index);
    const picked = compaction.selectEvictions(resolved, index, { now, maxEvictions: 1, conservative: false });
    assert.equal(picked.length, 1);
    assert.equal(picked[0].text, LOW, '同分时必须先淘汰低重要性的那条（哪怕它写在前面）');
});

/* ── 汇总 ── */
console.log('');
if (failures.length > 0) {
    console.log(`失败 ${failures.length} / ${checks}：${failures.join('、')}`);
    process.exit(1);
}
console.log(`importance 可维护用例全部通过（${checks} 条）`);
rmSync(home, { recursive: true, force: true });
