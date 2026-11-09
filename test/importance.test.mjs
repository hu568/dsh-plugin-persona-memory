/**
 * 回归测试：重要性元数据与访问回写（0.11 · DESIGN v3 §10/§11）。
 *
 * 这份测试钉住四件事：
 *  1. `insertEntry` / `replaceEntry` 把 importance 落进**侧车索引**，正文格式一个字都不变；
 *  2. 改写正文时未指定 importance ⇒ 沿用旧值（不能把重要结论悄悄降级）；
 *  3. `setEntryImportance` 只改索引、找不到目标就明说 not-found（绝不猜、绝不新建条目）；
 *  4. `touchEntries` 只动 hits/lastHit，不碰正文；未知 id 静默跳过。
 *
 * 跑法：node test/importance.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-importance-'));
process.env.DSH_HOME = home;

const store = await import('../lib/store.js');

const memoryDir = join(home, 'memory');
const factPath = join(memoryDir, 'FACT.md');
const projectDir = join(home, 'proj');
const projectPath = join(projectDir, 'MEMORY.md');
mkdirSync(projectDir, { recursive: true });

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

const sha = (file) => readFileSync(file, 'utf8');

await check('insertEntry：带 importance/kind ⇒ 落进侧车索引，正文不含任何元数据', async () => {
    const result = await store.insertEntry('global', {
        text: '依赖用本地 tarball 安装',
        confidence: 'high',
        importance: 70,
        kind: 'detail',
    });
    assert.equal(result.written, true);
    const raw = readFileSync(factPath, 'utf8');
    assert.ok(!raw.includes('importance'), '正文里不该出现 importance（侧车索引才是元数据）');
    assert.ok(raw.includes('依赖用本地 tarball 安装'));
    const list = store.memoryIndex().list;
    const record = list.find((item) => item.id === result.id);
    assert.ok(record, '索引里应有这条记录');
    assert.equal(record.importance, 70);
    assert.equal(record.kind, 'detail');
});

await check('insertEntry：不带 importance ⇒ 缺省 50，kind ⇒ conclusion', async () => {
    const result = await store.insertEntry('global', { text: '项目根不允许是 home 目录' });
    const record = store.memoryIndex().list.find((item) => item.id === result.id);
    assert.equal(record.importance, store.DEFAULT_IMPORTANCE);
    assert.equal(record.kind, 'conclusion');
});

await check('importance 越界/非法 ⇒ 收敛到 0–100，不抛错', async () => {
    const high = await store.insertEntry('global', { text: '越界上限测试条目', importance: 150 });
    const low = await store.insertEntry('global', { text: '越界下限测试条目', importance: -20 });
    const bad = await store.insertEntry('global', { text: '非法值测试条目', importance: 'abc' });
    const byId = (id) => store.memoryIndex().list.find((item) => item.id === id)?.importance;
    assert.equal(byId(high.id), 100);
    assert.equal(byId(low.id), 0);
    assert.equal(byId(bad.id), store.DEFAULT_IMPORTANCE);
});

await check('replaceEntry：未带 importance ⇒ 沿用旧值；带了 ⇒ 更新', async () => {
    const inserted = await store.insertEntry('global', { text: '改写前的重要性结论', importance: 85 });
    const afterReplace = await store.replaceEntry('global', inserted.id, {
        text: '改写后仍然重要的结论',
        confidence: 'high',
    });
    assert.equal(afterReplace.written, true);
    assert.equal(
        store.memoryIndex().list.find((item) => item.id === afterReplace.id)?.importance,
        85,
        '只改正文不该把重要性降级',
    );
    const withExplicit = await store.replaceEntry('global', afterReplace.id, {
        text: '主动降级的结论',
        confidence: 'medium',
        importance: 20,
    });
    assert.equal(store.memoryIndex().list.find((item) => item.id === withExplicit.id)?.importance, 20);
});

await check('insertEntry 到项目记忆：索引记录带 path，importance 同样生效', async () => {
    const result = await store.insertEntry('project', { text: '本项目的记忆条目', importance: 60 }, { cwd: projectDir });
    assert.equal(result.written, true);
    assert.equal(result.target, projectPath);
    const record = store.memoryIndex().list.find((item) => item.id === result.id);
    assert.equal(record.scope, 'memory');
    assert.equal(record.importance, 60);
    assert.equal(record.path ?? store.memoryIndex().entries[result.id]?.path, projectPath);
});

await check('setEntryImportance：只改索引，正文逐字节不变', async () => {
    const inserted = await store.insertEntry('global', { text: '面板上调重要性的结论', importance: 30 });
    const before = sha(factPath);
    const result = store.setEntryImportance('global', inserted.id, 90);
    assert.equal(result.ok, true);
    assert.equal(result.importance, 90);
    assert.equal(sha(factPath), before, '正文一个字节都不该动');
    assert.equal(store.memoryIndex().list.find((item) => item.id === inserted.id)?.importance, 90);
});

await check('setEntryImportance：目标不存在 ⇒ not-found，绝不新建条目', async () => {
    const before = sha(factPath);
    const result = store.setEntryImportance('global', 'deadbeef00', 80);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-found');
    assert.equal(sha(factPath), before);
    assert.equal(store.memoryIndex().list.some((item) => item.id === 'deadbeef00'), false);
});

await check('touchEntries：hits+1、lastHit 更新，正文不变；未知 id 静默跳过', async () => {
    const inserted = await store.insertEntry('global', { text: '被访问回写的结论', importance: 55 });
    const before = sha(factPath);
    const first = store.touchEntries([{ scope: 'global', id: inserted.id }], { at: 1_800_000_000_000 });
    assert.equal(first.touched, 1);
    let record = store.memoryIndex().entries[inserted.id];
    assert.equal(record.hits, 2, '写入时 hits=1，命中一次应变成 2');
    assert.equal(record.lastHit, 1_800_000_000_000);
    assert.equal(sha(factPath), before, '访问回写不许碰正文');

    const again = store.touchEntries([{ scope: 'global', id: inserted.id }, { scope: 'global', id: 'nope000000' }], { at: 1_800_000_100_000 });
    assert.equal(again.touched, 1, '未知 id 跳过，不能算命中');
    record = store.memoryIndex().entries[inserted.id];
    assert.equal(record.hits, 3);
    assert.equal(record.lastHit, 1_800_000_100_000);
});

await check('touchEntries：传 contentId（不是索引 id）也能命中', async () => {
    const text = '用 contentId 命中的结论';
    const inserted = await store.insertEntry('global', { text });
    const contentId = store.entryId('', text);
    assert.notEqual(contentId, inserted.id, '索引 id 用写入时间算，contentId 用空 ts');
    const touched = store.touchEntries([{ scope: 'global', id: contentId }]);
    assert.equal(touched.touched, 1);
    assert.ok(store.memoryIndex().list.find((item) => item.id === inserted.id).hits >= 2);
});

await check('touchEntries：作用域不明/空列表 ⇒ touched 0，不误伤别的文件', async () => {
    assert.equal(store.touchEntries([]).touched, 0);
    assert.equal(store.touchEntries([{ scope: 'journal', id: 'abc' }]).touched, 0);
    assert.equal(store.touchEntries([{ scope: 'global' }]).touched, 0);
});

await check('老索引（没有 importance 字段）⇒ 读出来按缺省 50，不迁移、不改文件', () => {
    const indexPath = join(memoryDir, 'index.json');
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
    const firstKey = Object.keys(parsed.entries)[0];
    delete parsed.entries[firstKey].importance;
    delete parsed.entries[firstKey].kind;
    writeFileSync(indexPath, JSON.stringify(parsed), 'utf8');
    const before = readFileSync(indexPath, 'utf8');
    const list = store.memoryIndex().list;
    const record = list.find((item) => item.id === firstKey);
    assert.equal(record.importance, 50);
    assert.equal(record.kind, 'conclusion');
    assert.equal(readFileSync(indexPath, 'utf8'), before, '只读不写：读索引不该顺手迁移');
});

await check('索引文件缺失 ⇒ setEntryImportance 写入后自动建索引，正文不变', async () => {
    const target = join(memoryDir, 'index.json');
    if (existsSync(target)) rmSync(target);
    const inserted = await store.insertEntry('global', { text: '索引缺失场景的结论', importance: 40 });
    // insertEntry 本身会建索引；再手动删一次，模拟「人工写的条目没有元数据」。
    rmSync(target);
    const before = sha(factPath);
    // 没有索引时按**正文**定位（人工写的条目就是这样拿到元数据的）。
    const result = store.setEntryImportance('global', '索引缺失场景的结论', 77);
    assert.equal(result.ok, true);
    assert.equal(sha(factPath), before);
    assert.ok(existsSync(target), '应重建 index.json');
    assert.equal(store.memoryIndex().entries[result.id].importance, 77);
    assert.equal(store.memoryIndex().entries[result.id].hits, 0, '补记录时 hits 从 0 开始（确实还没被用过）');
});

console.log(`\n共 ${checks} 项检查：通过 ${checks - failures.length}，失败 ${failures.length}`);
try {
    rmSync(home, { recursive: true, force: true });
}
catch {
    /* 临时目录清不掉不影响结论 */
}
if (failures.length > 0) {
    console.error(`失败项：${failures.join(' / ')}`);
    process.exit(1);
}
