/**
 * 回归测试：注入位置 —— 运行时上下文快照必须排在用户消息**之前**。
 *
 * 背景（0.12.0）：角色与记忆从 system prompt 段落改成 `systemPrompt.context()`，
 * 宿主把它渲染成一条 user 角色消息。落点由 agent/pre-step 返回的 messages 里
 * 「runtime-context 占位消息」的位置决定（agent-loop 在原位替换成最新快照）。
 * 宿主默认把占位追加在用户消息**之后**，于是角色落在用户发言后面；lib/index.js
 * 注册的监听把占位提到 messages[0]，得到 [runtime-context, user, ...]。
 *
 * 这个文件同时钉住两条注册契约：
 *   - 三个条目都走 `context()`，且 `required: true`（抑制可选运行时上下文的预设
 *     不该把角色与记忆一起抹掉）；
 *   - 排序监听是纯函数式的：不改传入的 decision/messages。
 *
 * 跑法：node test/injection-position.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── 隔离的 DSH_HOME：apply 会 ensureSeed / 读角色库，绝不能碰真实数据 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-position-'));
process.env.DSH_HOME = home;

const mod = await import(process.env.PERSONA_MEMORY_ENTRY ?? '../lib/index.js');

const contexts = [];
const listeners = new Map();
const fakeCtx = {
    logger: { info() { }, warn() { } },
    effect(fn) {
        const dispose = fn();
        return typeof dispose === 'function' ? dispose : () => { };
    },
    on(name, listener) {
        listeners.set(name, listener);
        return () => { };
    },
    get(key) {
        if (key === 'systemPrompt') {
            return {
                getSectionOrder: () => 0,
                section(entry) { throw new Error('0.12.0 起不该再走 section 通道'); },
                context(entry) { contexts.push(entry); return () => { }; },
            };
        }
        return undefined;
    },
    inject() { },
};
mod.apply(fakeCtx, {});

/* ══ 1. 注册契约：3 个 context、required、interpolate:false ══ */
assert.deepEqual(contexts.map((entry) => entry.name), ['memory:soul', 'memory:user', 'memory:facts'],
    '应注册三个 runtime-context 条目');
for (const entry of contexts) {
    assert.equal(entry.required, true, `${entry.name} 必须 required:true，否则被抑制的预设会整段丢角色`);
    assert.equal(entry.interpolate, false, `${entry.name} 必须关掉宿主插值`);
}
assert.ok(contexts[0].order < contexts[2].order, '角色应排在记忆之前');

/* ══ 2. 排序监听：把占位提到最前 ══ */
const listener = listeners.get('agent/pre-step');
assert.equal(typeof listener, 'function', '应注册 agent/pre-step 监听');

const userMessage = { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } };
const contextMessage = { id: 'c1', role: 'user', content: [{ type: 'text', text: 'Current runtime context. …' }], source: { kind: 'runtime-context' } };

/** 跑一次监听：next() 返回给定的 decision。 */
const run = async (decision) => listener({}, async () => decision);

/* 2a. 默认落点（用户消息之后）→ 提到最前 */
{
    const decision = { kind: 'enter', messages: [userMessage, contextMessage] };
    const snapshotOfMessages = [...decision.messages];
    const out = await run(decision);
    assert.deepEqual(out.messages.map((message) => message.source.kind), ['runtime-context', 'user'],
        '快照应排在用户消息之前');
    assert.equal(out.messages.length, 2, '不应复制或丢弃消息');
    assert.deepEqual(decision.messages, snapshotOfMessages, '不得就地改写传入的 messages');
    assert.notEqual(out.messages, decision.messages, '应返回新的 messages 数组');
}

/* 2b. 已在最前 → 原样返回同一个 decision（避免无意义的新对象） */
{
    const decision = { kind: 'enter', messages: [contextMessage, userMessage] };
    assert.equal(await run(decision), decision, '已排在最前时应原样返回');
}

/* 2c. 没有快照占位 → 原样返回 */
{
    const decision = { kind: 'enter', messages: [userMessage] };
    assert.equal(await run(decision), decision, '没有占位时不应改动决策');
    const empty = { kind: 'enter', messages: [] };
    assert.equal(await run(empty), empty, '空消息列表也应原样返回');
}

/* 2d. reject 决策 → 原样返回（不能把被拒绝的步骤改写成 enter） */
{
    const decision = { kind: 'reject', messages: [userMessage, contextMessage] };
    assert.equal(await run(decision), decision, 'reject 决策必须原样透传');
}

/* 2e. 快照夹在中间 → 仍排到最前，且其余顺序不变 */
{
    const other = { id: 'p1', role: 'user', content: [{ type: 'text', text: '插件消息' }], source: { kind: 'plugin' } };
    const out = await run({ kind: 'enter', messages: [userMessage, contextMessage, other] });
    assert.deepEqual(out.messages.map((message) => message.source.kind), ['runtime-context', 'user', 'plugin']);
}

rmSync(home, { recursive: true, force: true });
console.log('✓ injection-position.test.mjs 全部通过（快照排在用户消息之前）');