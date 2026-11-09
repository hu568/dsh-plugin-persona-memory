/**
 * 回归测试：写锁统一 + 工具侧乐观锁必填（0.9.0 · P0-3）。
 *
 * 背景：同一份 MEMORY.md 有两把互不阻塞的写锁 ——
 *  - 面板保存只带 `path`、不带 cwd ⇒ 旧 `lockKey()` 推导出 `memory:`；
 *  - 工具/自动沉淀只带 cwd ⇒ 旧 `lockKey()` 推导出 `memory:<项目根>`。
 * 两把 mutex 保护同一个文件，并发「读-改-写」交错、后写者整篇覆盖前者且不报错。
 * 另外工具侧 `expectedRevision` 可选 ⇒ 工具路径等于没有乐观锁。
 *
 * 本测试钉住：
 *  1. `lockKey('memory', {cwd})` 与 `lockKey('memory', {path})` 指向同一把锁；
 *  2. 持 `{path}` 的锁时，`{cwd}` 的取锁请求会被阻塞到超时（同一把锁的直接证据）；
 *  3. `memory action=update, scope=project` 缺 `expectedRevision` ⇒ `MEMORY_REVISION_REQUIRED`
 *     且 `details.revision` = 当前磁盘 revision，文件一个字节不动；
 *  4. 带上正确 revision 可写；带过期 revision ⇒ `MEMORY_REVISION_CONFLICT`；
 *  5. 显式 `force: true` 允许无 revision 覆盖（逃生口，且旧的宽容行为不再默认）；
 *  6. `scope=global` 不受影响（工具行为向后兼容）。
 *
 * 跑法：node test/lock-key.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-lockkey-'));
process.env.DSH_HOME = home;

const store = await import('../lib/store.js');
const tools = await import('../lib/tools.js');
store.configureStore({});

const projectRoot = join(home, 'project');
const memoryPath = join(projectRoot, 'MEMORY.md');
mkdirSync(projectRoot, { recursive: true });
writeFileSync(memoryPath, '# MEMORY.md — 项目记忆\n\n1. 一条项目结论\n', 'utf8');

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
        console.log(`FAIL ${label}\n      ${String(error?.message ?? error).split('\n').join('\n      ')}`);
    }
}
const read = () => readFileSync(memoryPath, 'utf8');

await check('lockKey：memory 作用域按目标文件取键（cwd 与 path 落到同一把锁）', () => {
    const byCwd = store.lockKey('memory', { cwd: projectRoot });
    const byPath = store.lockKey('memory', { path: memoryPath });
    assert.equal(byCwd, byPath, `面板(path) 与工具(cwd) 必须是同一把锁：${byCwd} vs ${byPath}`);
    assert.equal(byPath, `memory:${resolve(memoryPath)}`);
    // fact / journal 的键语义不变
    assert.equal(store.lockKey('fact', { cwd: projectRoot }), 'fact');
    assert.equal(store.lockKey('journal'), 'journal');
});

await check('同一把锁：持 {path} 时 {cwd} 取锁会超时（旧实现会立刻拿到）', async () => {
    const release = await store.acquireWriteLock('memory', { path: memoryPath });
    try {
        await assert.rejects(
            () => store.acquireWriteLock('memory', { cwd: projectRoot, timeoutMs: 40 }),
            (error) => error.code === 'MEMORY_LOCK_TIMEOUT',
            '两个入口必须争抢同一把锁',
        );
    }
    finally {
        release();
    }
});

await check('工具：scope=project 缺 expectedRevision ⇒ MEMORY_REVISION_REQUIRED + 当前 revision', async () => {
    const tool = tools.memoryTool({});
    const exec = { agent: { session: { header: { cwd: projectRoot } } } };
    const before = read();
    await assert.rejects(
        () => tool.execute({ action: 'update', scope: 'project', content: '# MEMORY.md — 项目记忆\n\n1. 想覆盖\n' }, exec),
        (error) => {
            assert.equal(error.code, 'MEMORY_REVISION_REQUIRED');
            assert.equal(error.details.revision, store.contentRevision(before), '必须回带当前 revision');
            assert.equal(error.details.path, memoryPath);
            assert.match(error.message, /expectedRevision/);
            assert.match(error.message, /force: true/, '要告诉调用方逃生口');
            return true;
        },
        '缺 revision 必须拒写',
    );
    assert.equal(read(), before, '被拒时文件一个字节都不能变');
});

await check('工具：带正确 revision 可写；过期 revision 被拒（409）', async () => {
    const tool = tools.memoryTool({});
    const exec = { agent: { session: { header: { cwd: projectRoot } } } };
    const stale = store.contentRevision(read());
    const next = `${read()}\n2. 带 revision 写进来的一条\n`;
    const saved = await tool.execute({ action: 'update', scope: 'project', content: next, expectedRevision: stale }, exec);
    assert.match(saved.text, /已写入项目记忆/);
    assert.equal(read(), next, '落盘 = 最终文本（已有末位换行，不再追加）');

    const afterStale = read();
    await assert.rejects(
        () => tool.execute({ action: 'update', scope: 'project', content: '# MEMORY.md — 覆盖\n', expectedRevision: store.contentRevision('# 别的版本\n') }, exec),
        (error) => error.code === 'MEMORY_REVISION_CONFLICT',
    );
    assert.equal(read(), afterStale, '冲突时不能写盘');
});

await check('工具：显式 force:true 才允许无 revision 覆盖', async () => {
    const tool = tools.memoryTool({});
    const exec = { agent: { session: { header: { cwd: projectRoot } } } };
    await tool.execute({ action: 'update', scope: 'project', content: '# MEMORY.md — force 覆盖\n', force: true }, exec);
    assert.equal(read(), '# MEMORY.md — force 覆盖\n');
});

await check('工具：scope=global 不带 revision 仍然可写（向后兼容）', async () => {
    const tool = tools.memoryTool({});
    const exec = { agent: { session: { header: { cwd: projectRoot } } } };
    const saved = await tool.execute({ action: 'update', scope: 'global', content: '# FACT.md\n\n- 全局一条\n' }, exec);
    assert.match(saved.text, /已写入全局记忆/);
    assert.match(readFileSync(store.factPath(), 'utf8'), /全局一条/);
});

rmSync(home, { recursive: true, force: true });
if (failures.length > 0) {
    console.log(`\n✗ lock-key: ${failures.length} 项失败 / 共 ${checks} 项：${failures.join('、')}`);
    process.exit(1);
}
console.log(`\n✓ lock-key: ${checks} 项全部通过`);
