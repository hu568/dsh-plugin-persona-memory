/**
 * 回归测试：压缩合并把 `max-tokens` 截断按失败记账（0.9.0 · P1-1）。
 *
 * 背景：`compaction-wiring.js` 的 `makeCompactCallModel()` 过去把 `stop` / `max-tokens` /
 * `tool-calls` 都当成功。`max-tokens` 意味着模型输出被 token 上限**切在半句**，
 * 而 `parseMergeResult()` 只查「单行 / ≤120 字 / 具体值不是全丢」，半截行反而更容易过审
 * ⇒ 半截结论被写进 FACT.md / MEMORY.md。与「半截 JSON 不许当结论」是同一条纪律。
 *
 * 本测试钉住（两种 finish 形状都覆盖）：
 *  1. `reason.kind === 'max-tokens'` ⇒ `callModel()` 返回 null（失败 / 无结果）；
 *  2. `stop` / `tool-calls` 仍算成功；
 *  3. `error` / `aborted` 仍算失败；
 *  4. 旧形状 `{ type:'finish', kind:'max-tokens' }` 同样判失败。
 *
 * 跑法：node test/compaction-max-tokens.test.mjs
 */
import assert from 'node:assert/strict';

const { makeCompactCallModel } = await import('../lib/compaction-wiring.js');

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

/** 假宿主 ctx：`llm.stream` 按给定 chunk 序列返回。 */
function ctxWithChunks(chunks) {
    return {
        get(name) {
            if (name !== 'llm')
                return undefined;
            return {
                async *stream() {
                    for (const chunk of chunks)
                        yield chunk;
                },
            };
        },
    };
}
const route = { compactProvider: 'test-provider', compactModel: 'test-model' };
const callModel = (chunks) => makeCompactCallModel(ctxWithChunks(chunks), route);

await check('max-tokens（宿主新形状）⇒ 判失败、不返回半截文本', async () => {
    const call = callModel([
        { type: 'text-delta', text: '{"merged":"node v22' },
        { type: 'finish', reason: { kind: 'max-tokens' } },
    ]);
    assert.equal(await call('prompt', {}), null, 'max-tokens 截断的合并结果必须当失败');
});

await check('stop / tool-calls 仍算成功并回全文', async () => {
    for (const kind of ['stop', 'tool-calls']) {
        const call = callModel([
            { type: 'text-delta', text: '{"merged":"node v22.23.3"}' },
            { type: 'finish', reason: { kind } },
        ]);
        assert.equal(await call('prompt', {}), '{"merged":"node v22.23.3"}', `${kind} 应算成功`);
    }
});

await check('error / aborted 仍算失败', async () => {
    for (const kind of ['error', 'aborted']) {
        const call = callModel([
            { type: 'text-delta', text: '半截' },
            { type: 'finish', reason: { kind } },
        ]);
        assert.equal(await call('prompt', {}), null, `${kind} 应算失败`);
    }
});

await check('旧形状 { type:\'finish\', kind:\'max-tokens\' } 同样判失败', async () => {
    const call = callModel([
        { type: 'text-delta', text: '半截' },
        { type: 'finish', kind: 'max-tokens' },
    ]);
    assert.equal(await call('prompt', {}), null, '旧形状不得绕过截断判定');
});

if (failures.length > 0) {
    console.log(`\n✗ compaction-max-tokens: ${failures.length} 项失败 / 共 ${checks} 项：${failures.join('、')}`);
    process.exit(1);
}
console.log(`\n✓ compaction-max-tokens: ${checks} 项全部通过`);
