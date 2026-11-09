/**
 * 回归测试：写前压缩失败可观测（0.9.0 · P1-8）。
 *
 * 背景：`store.compactBeforeWrite()` 的 `catch { return null; }` 把压缩器的任何异常
 * **完全吞掉**：写路径随后抛 `MEMORY_BUDGET_EXCEEDED`，模型/用户以为「内容太长」，
 * 实际是压缩根本没跑起来（LLM 超时、索引损坏、备份写失败）。`/memory-compact` 手动跑
 * 能看到原因，写路径却查不到 —— 「记忆没写进去」的根因在 runlog 里消失。
 *
 * 本测试钉住：
 *  1. `configureStore({ logger })` 注入的 logger 会收到一条 warn（含错误码）；
 *  2. `configureCompactor(fn, { logger })` 的 logger 同样生效；
 *  3. `MEMORY_BUDGET_EXCEEDED.details.compactionFailure = { code, message }`；
 *  4. 压缩器不抛错时 `details` 里没有 compactionFailure（不误报）。
 *
 * 跑法：node test/compaction-failure.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-compactfail-'));
process.env.DSH_HOME = home;

const store = await import('../lib/store.js');
mkdirSync(store.memoryDir(), { recursive: true });

const factFile = store.factPath();

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

/** 造一个「水位 = 100%」的 FACT.md（上限 3 行 / 8000 字节）：再插一条必然超限。 */
function fillFact() {
    writeFileSync(factFile, '# FACT.md\n\n- 已有条目 A\n', 'utf8');
}

const boom = (code = 'LLM_TIMEOUT', message = '合并模型超时') => {
    const error = new Error(message);
    error.code = code;
    return error;
};

await check('configureStore 注入 logger：压缩失败记 warn + details.compactionFailure', async () => {
    const warns = [];
    store.configureStore({
        maxFactLines: 3,
        maxFactBytes: 8000,
        compactionEnabled: true,
        compact: async () => { throw boom('LLM_TIMEOUT', '合并模型超时'); },
        logger: { warn: (message) => warns.push(String(message)) },
    });
    fillFact();
    await assert.rejects(
        () => store.insertEntry('fact', '新条目 B'),
        (error) => {
            assert.equal(error.code, 'MEMORY_BUDGET_EXCEEDED', '仍应是原来的超限错误（错误码只增不改）');
            assert.match(error.message, /硬上限 3 行/, 'message 一字不改');
            assert.equal(error.details.compactionFailure.code, 'LLM_TIMEOUT');
            assert.match(error.details.compactionFailure.message, /超时/);
            return true;
        },
    );
    assert.equal(warns.length, 1, `应记一条 warn，实际 ${JSON.stringify(warns)}`);
    assert.match(warns[0], /写前压缩失败/);
    assert.match(warns[0], /LLM_TIMEOUT/);
});

await check('configureCompactor(fn, { logger }) 的 logger 同样生效', async () => {
    const warns = [];
    store.configureStore({ maxFactLines: 3, maxFactBytes: 8000, logger: null });
    store.configureCompactor(async () => { throw boom('INDEX_CORRUPT', '索引损坏'); }, {
        logger: { warn: (message) => warns.push(String(message)) },
    });
    fillFact();
    await assert.rejects(
        () => store.insertEntry('fact', '新条目 C'),
        (error) => error.details?.compactionFailure?.code === 'INDEX_CORRUPT',
    );
    assert.equal(warns.length, 1);
    assert.match(warns[0], /INDEX_CORRUPT/);
});

await check('压缩器正常返回时 details 里没有 compactionFailure（不误报）', async () => {
    const warns = [];
    store.configureStore({
        maxFactLines: 3,
        maxFactBytes: 8000,
        compactionEnabled: true,
        compact: async () => ({ ok: true, written: false }),
        logger: { warn: (message) => warns.push(String(message)) },
    });
    fillFact();
    await assert.rejects(
        () => store.insertEntry('fact', '新条目 D'),
        (error) => {
            assert.equal(error.code, 'MEMORY_BUDGET_EXCEEDED');
            assert.equal(error.details.compactionFailure, undefined);
            return true;
        },
    );
    assert.deepEqual(warns, [], '没失败就不该有 warn');
});

await check('写路径在压缩失败后照常落盘（压缩只是加成，不是写入的前置条件）', async () => {
    const warns = [];
    store.configureStore({
        maxFactLines: 100,
        maxFactBytes: 8000,
        compactionEnabled: true,
        compact: async () => { throw boom('BOOM', '炸了'); },
        logger: { warn: (message) => warns.push(String(message)) },
    });
    writeFileSync(factFile, '# FACT.md\n\n- 已有条目 A\n', 'utf8');
    const result = await store.insertEntry('fact', '压缩挂了也要写进去的条目');
    assert.equal(result.written, true, JSON.stringify(result));
    assert.equal(warns.length, 0, '水位低于 85% 不该触发压缩');
});

store.configureCompactor(null);
store.configureStore({});
rmSync(home, { recursive: true, force: true });
if (failures.length > 0) {
    console.log(`\n✗ compaction-failure: ${failures.length} 项失败 / 共 ${checks} 项：${failures.join('、')}`);
    process.exit(1);
}
console.log(`\n✓ compaction-failure: ${checks} 项全部通过`);
