/**
 * 回归测试：注入作用域 + 宿主插值安全。
 *
 * 覆盖两个曾经真实炸掉的点：
 *  1. `memory:*` 段落里的任意用户文本（记忆正文/日志/角色文件）可能含 `{{变量}}`，
 *     宿主 @deepseek-ai/dsh-system-prompt 的 interpolate() 会**抛错**；
 *     段落必须带 `interpolate: false`。
 *  2. 子代理会话只注入项目记忆 —— 角色 / 全局 FACT.md / 长期日志一律不注入。
 *
 * 跑法：node test/scope.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── 用假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-test-'));
process.env.DSH_HOME = home;

const mod = await import(process.env.PERSONA_MEMORY_ENTRY ?? '../lib/index.js');

/* ── 造样本数据 ───────────────────────────────────────────────────────── */
const memoryDir = join(home, 'memory');
const personasDir = join(home, 'personas');
const projectRoot = join(home, 'project');
mkdirSync(memoryDir, { recursive: true });
mkdirSync(join(personasDir, 'default'), { recursive: true });
mkdirSync(projectRoot, { recursive: true });

/* 关键：全局记忆与日志里放 `{{变量}}` —— 修复前这两处都会让 turn 崩掉。 */
writeFileSync(join(memoryDir, 'FACT.md'), '# 全局\n\n用户提到过 {{变量}} 这种写法。\n', 'utf8');
writeFileSync(
    join(memoryDir, 'JOURNAL.jsonl'),
    `${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', tags: ['t'], text: '日志里有 {{变量}}' })}\n`,
    'utf8',
);
writeFileSync(join(personasDir, 'default', 'persona.yml'), 'name: 测试角色\ndescription: 测试\n', 'utf8');
writeFileSync(join(personasDir, 'default', 'SOUL.md'), '# SOUL\n\n我是 {{角色名}}。\n', 'utf8');
writeFileSync(join(personasDir, 'default', 'USER.md'), '# USER\n\n称呼我 {{用户名}}。\n', 'utf8');
writeFileSync(join(personasDir, '.active'), 'default\n', 'utf8');
writeFileSync(join(projectRoot, 'MEMORY.md'), '# 项目记忆\n\n本项目用 {{项目变量}}。\n', 'utf8');

/* ── 假 minimal 宿主 surface：记录注册的段落 ──────────────────────────── */
const registered = [];
const fakeCtx = {
    logger: { info() { }, warn() { } },
    effect(fn) {
        const dispose = fn();
        return typeof dispose === 'function' ? dispose : () => { };
    },
    on() { },
    get(key) {
        if (key === 'systemPrompt') {
            return {
                getSectionOrder: () => 100,
                section(section) {
                    registered.push(section);
                    return () => { };
                },
            };
        }
        return undefined;
    },
    inject() { },
};
mod.apply(fakeCtx, {});

assert.equal(registered.length, 4, '应注册 4 个段落');
for (const section of registered) {
    assert.equal(
        section.interpolate,
        false,
        `段落 ${section.name} 必须显式设置 interpolate: false（否则 {{变量}} 会让 turn 崩溃）`,
    );
}

const sectionOf = (name) => {
    const found = registered.find((section) => section.name === name);
    assert.ok(found, `缺少段落 ${name}`);
    return found;
};

const config = { maxChars: 8000, memoryEnabled: true, journalEnabled: true, personaEnabled: true };

/* ── 假 agent/session ─────────────────────────────────────────────────── */
const makeAgent = (origin) => ({
    id: origin === 'subagent' ? 'child-1' : 'root-1',
    session: {
        header: {
            cwd: projectRoot,
            ...origin === undefined ? {} : { origin },
        },
        events: [{ type: 'user/message' }],
    },
});

const renderAll = (agent) => ({
    soul: sectionOf('memory:soul').text({ agent }),
    user: sectionOf('memory:user').text({ agent }),
    facts: sectionOf('memory:facts').text({ agent }),
    journal: sectionOf('memory:journal').text({ agent }),
});

/* ── 主会话：四段全注入 ───────────────────────────────────────────────── */
const root = renderAll(makeAgent(undefined));
assert.match(root.soul, /<soul /, '主会话应注入角色 SOUL');
assert.match(root.user, /<user /, '主会话应注入角色 USER');
assert.match(root.facts, /### 全局记忆/, '主会话应注入全局记忆');
assert.match(root.facts, /### 项目记忆/, '主会话应注入项目记忆');
assert.match(root.journal, /<journal /, '主会话应注入长期日志');
assert.ok(root.journal.includes('{{变量}}'), '日志里的 {{变量}} 应原样保留（不被宿主插值吞掉/炸掉）');

/* ── 子代理：只注入项目记忆 ───────────────────────────────────────────── */
const child = renderAll(makeAgent('subagent'));
assert.equal(child.soul, '', '子代理不应注入角色 SOUL');
assert.equal(child.user, '', '子代理不应注入角色 USER');
assert.equal(child.journal, '', '子代理不应注入长期日志');
assert.match(child.facts, /### 项目记忆/, '子代理应注入项目记忆');
assert.ok(!child.facts.includes('### 全局记忆'), '子代理不应注入全局记忆');
assert.ok(!child.facts.includes('FACT.md），整篇覆盖'), '子代理不应拿到全局写入契约');
assert.ok(child.facts.includes('scope=project'), '子代理应拿到项目写入契约');

/* ── 子代理 + 无项目记忆 → 一段都不注入 ───────────────────────────────── */
// 注意：快照按 session id 缓存，这里必须换一个 id，否则会复用上面的快照。
const noProject = {
    id: 'child-no-project',
    session: { header: { cwd: tmpdir(), origin: 'subagent' }, events: [{ type: 'user/message' }] },
};
const bare = renderAll(noProject);
assert.equal(bare.soul, '');
assert.equal(bare.user, '');
assert.equal(bare.journal, '');
assert.ok(!bare.facts.includes('### 项目记忆'), '没有 MEMORY.md 时不应凭空注入项目记忆');

/* ── 血缘判据：只有 parentSession / delegationDepth 也要认作子代理 ─────── */
const lineageOnly = {
    id: 'child-lineage-only',
    session: { header: { cwd: projectRoot, parentSession: 'root-1' }, events: [{ type: 'user/message' }] },
};
const depthOnly = {
    id: 'child-depth-only',
    session: { header: { cwd: projectRoot, delegationDepth: 1 }, events: [{ type: 'user/message' }] },
};
for (const [label, agent] of [['parentSession', lineageOnly], ['delegationDepth', depthOnly]]) {
    const out = renderAll(agent);
    assert.equal(out.soul, '', `仅凭 ${label} 也应判定为子代理：不应注入角色`);
    assert.equal(out.journal, '', `仅凭 ${label} 也应判定为子代理：不应注入日志`);
    assert.ok(!out.facts.includes('### 全局记忆'), `仅凭 ${label} 也应判定为子代理：不应注入全局记忆`);
    assert.match(out.facts, /### 项目记忆/, `仅凭 ${label} 也应判定为子代理：应注入项目记忆`);
}

/* ── 配置可回退：subagentProjectOnly=false 时子代理与主会话一致 ───────── */
registered.length = 0;
const fallbackCtx = { ...fakeCtx, get: fakeCtx.get };
mod.apply(fallbackCtx, { subagentProjectOnly: false });
const child2 = renderAll(makeAgent('subagent'));
assert.match(child2.soul, /<soul /, '关掉 subagentProjectOnly 后子代理应恢复注入角色');
assert.match(child2.facts, /### 全局记忆/, '关掉 subagentProjectOnly 后子代理应恢复注入全局记忆');
assert.match(child2.journal, /<journal /, '关掉 subagentProjectOnly 后子代理应恢复注入日志');

rmSync(home, { recursive: true, force: true });
console.log('✓ scope.test.mjs 全部通过');
