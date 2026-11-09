/**
 * 回归测试：闸口按**最终落盘文本**校验（0.9.0 · P1-3）。
 *
 * 背景：过去 `tools` / `panel` 先 `assert*WithinLimit(content)`、再
 * `ensureTrailingNewline(content)` 落盘 ⇒ 正文恰好等于上限时，落盘后多 1 字节，
 * 下一次 `memory action=read` 立刻报「已超限，下一次写入会被拒绝」；
 * 而 `replaceDocument()` 自己**没有任何上限校验**，是唯一可以被任意调用方绕过的写口子。
 *
 * 本测试钉住：
 *  1. `replaceDocument` 入口按最终文本卡上限（FACT 字节口径）；
 *  2. 通过的文字落盘后 `countBytes(file) <= 上限`；
 *  3. 工具 `scope=global` 先补末位换行再判 ⇒ 恰好上限 + 1 字节被拒，边界值可写；
 *  4. 项目记忆（字符口径）同样在 `replaceDocument` 入口被拦。
 *
 * 跑法：node test/gate-final-text.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-gate-'));
process.env.DSH_HOME = home;

const store = await import('../lib/store.js');
const tools = await import('../lib/tools.js');
mkdirSync(store.memoryDir(), { recursive: true });

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

const factFile = store.factPath();
const factBytes = () => store.countBytes(readFileSync(factFile, 'utf8'));

await check('replaceDocument：FACT 最终文本超字节上限 ⇒ 拒写、磁盘不变', async () => {
    store.configureStore({ maxFactBytes: 50, maxFactLines: 100 });
    writeFileSync(factFile, '- 原有的\n', 'utf8');
    const before = readFileSync(factFile, 'utf8');
    await assert.rejects(
        () => store.replaceDocument('fact', factFile, 'a'.repeat(51)),
        (error) => {
            assert.equal(error.code, 'MEMORY_BUDGET_EXCEEDED');
            assert.match(error.message, /51 字节/);
            return true;
        },
        'replaceDocument 是唯一没有闸口的写口子，必须拦住',
    );
    assert.equal(readFileSync(factFile, 'utf8'), before, '被拒时磁盘一个字节不动');
});

await check('replaceDocument：边界值可写，落盘字节数 <= 上限', async () => {
    store.configureStore({ maxFactBytes: 50, maxFactLines: 100 });
    await store.replaceDocument('fact', factFile, `${'a'.repeat(49)}\n`);
    assert.ok(factBytes() <= 50, `落盘后必须 <= 50 字节，实际 ${factBytes()}`);
    assert.equal(store.countBytes(readFileSync(factFile, 'utf8')), 50);
});

await check('工具 scope=global：先补末位换行再判（多一个换行就越界）', async () => {
    store.configureStore({ maxFactBytes: 10, maxFactLines: 100 });
    const tool = tools.memoryTool({ maxFactBytes: 10, maxFactLines: 100 });
    const exec = { agent: { session: { header: { cwd: join(home, 'project') } } } };
    mkdirSync(join(home, 'project'), { recursive: true });
    writeFileSync(factFile, '- A\n', 'utf8');

    // 10 字节正文 + 末位换行 = 11 字节 ⇒ 必须拒写
    await assert.rejects(
        () => tool.execute({ action: 'update', scope: 'global', content: 'a'.repeat(10) }, exec),
        (error) => {
            assert.equal(error.code, 'MEMORY_BUDGET_EXCEEDED');
            assert.match(error.message, /11 字节/, '报错要按最终落盘文本计');
            assert.match(error.message, /超出 1 字节/);
            return true;
        },
    );
    assert.equal(readFileSync(factFile, 'utf8'), '- A\n', '被拒时磁盘不变');

    // 9 字节正文 + 末位换行 = 10 字节 ⇒ 可写，且 read 不报超限
    await tool.execute({ action: 'update', scope: 'global', content: 'a'.repeat(9) }, exec);
    assert.equal(factBytes(), 10);
    const readBack = await tool.execute({ action: 'read' }, exec);
    assert.ok(!readBack.text.includes('当前已超限'), '过了闸口就不该立刻报超限');
});

await check('replaceDocument：项目 MEMORY.md 字符上限同样在入口被拦', async () => {
    store.configureStore({ maxProjectChars: 10 });
    const root = join(home, 'project');
    const memoryFile = join(root, 'MEMORY.md');
    writeFileSync(memoryFile, '1234567890', 'utf8');
    await assert.rejects(
        () => store.replaceDocument('memory', memoryFile, 'x'.repeat(11), { path: memoryFile }),
        (error) => error.code === 'MEMORY_BUDGET_EXCEEDED',
    );
    assert.equal(readFileSync(memoryFile, 'utf8'), '1234567890');
});

store.configureStore({});
rmSync(home, { recursive: true, force: true });
if (failures.length > 0) {
    console.log(`\n✗ gate-final-text: ${failures.length} 项失败 / 共 ${checks} 项：${failures.join('、')}`);
    process.exit(1);
}
console.log(`\n✓ gate-final-text: ${checks} 项全部通过`);
