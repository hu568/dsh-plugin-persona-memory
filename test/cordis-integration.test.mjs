/**
 * 端到端集成测试：真实 cordis Context + 真实 @deepseek-ai/dsh-system-prompt。
 *
 * 与 host-interpolate.test.mjs 的区别：那个直接调渲染函数，这个走**完整**注册/组装链
 * —— systemPrompt.context() → ScopedLayers → assemble() → renderContextSnapshot()，
 * 也就是线上真正跑的那条路。只有它能证明 `interpolate: false` 穿过 NamedEntries /
 * 作用域层之后仍然活着，以及角色与记忆**没有**漏回 system prompt。
 *
 * 0.12.0 起注入通道从 system 段改成 runtime-context：角色与记忆不再进 renderPrompt()，
 * 而是渲染成一条 user 角色消息（见 lib/index.js 顶部注释）。
 *
 * 跑法（必须用 Harness 的 Electron node，才能 import asar 内的包）：
 *   ELECTRON_RUN_AS_NODE=1 "<Harness.exe>" test/cordis-integration.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveHostModules } from './_host-paths.mjs';

/** 仓库源码入口：从本测试文件自身位置推导，别写死绝对路径（插件搬过家）。 */
const REPO_ENTRY = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.js')).href;

const HOST = resolveHostModules();

const { Context } = await import(pathToFileURL(join(HOST, 'cordis', 'lib', 'index.js')).href);
const SystemPrompt = (await import(pathToFileURL(join(HOST, 'dsh-system-prompt', 'lib', 'index.js')).href)).default;

/* ── 隔离的 DSH_HOME，样本里塞满 {{…}} ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-e2e-'));
process.env.DSH_HOME = home;
const memoryDir = join(home, 'memory');
const personasDir = join(home, 'personas');
const projectRoot = join(home, 'project');
mkdirSync(memoryDir, { recursive: true });
mkdirSync(join(personasDir, 'default'), { recursive: true });
mkdirSync(projectRoot, { recursive: true });
writeFileSync(join(memoryDir, 'FACT.md'), '# 全局\n\n用户写过 {{变量}}。\n', 'utf8');
writeFileSync(
    join(memoryDir, 'JOURNAL.jsonl'),
    `${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', tags: [], text: '日志里有 {{变量}}' })}\n`,
    'utf8',
);
writeFileSync(join(personasDir, 'default', 'persona.yml'), 'name: 测试\ndescription: t\n', 'utf8');
writeFileSync(join(personasDir, 'default', 'SOUL.md'), '# SOUL\n\n我是 {{角色名}}。\n', 'utf8');
writeFileSync(join(personasDir, 'default', 'USER.md'), '# USER\n\n叫我 {{用户名}}。\n', 'utf8');
writeFileSync(join(personasDir, '.active'), 'default\n', 'utf8');
writeFileSync(join(projectRoot, 'MEMORY.md'), '# 项目\n\n本项目用 {{项目变量}}。\n', 'utf8');

const personaMemory = await import(process.env.PERSONA_MEMORY_ENTRY ?? REPO_ENTRY);
const promptModule = await import(pathToFileURL(join(HOST, 'dsh-system-prompt', 'lib', 'index.js')).href);
const { renderPrompt, renderContextSnapshot } = promptModule;

/* ── 起一个真实的 Context，挂真实的 system-prompt 服务 ── */
const ctx = new Context();
// 本插件 inject 了 'tools'（要注册 memory/persona 工具）。真实部署里那个服务恒在；
// 这里给一个最小替身，好让插件的 fiber 真的激活到 ACTIVE —— 否则它注册的段落根本
// 不会进 assembly，测试就变成「什么都没验证」。
const registeredTools = [];
ctx.provide('tools', {
    register(tool) { registeredTools.push(tool); return () => { }; },
});

const promptFiber = ctx.plugin(SystemPrompt, {
    personaPrefix: 'You are a coding agent.',
    personaSuffix: 'Your working directory is {{cwd}}.',
});
await promptFiber.await();
const systemPrompt = ctx.get('systemPrompt');
assert.ok(systemPrompt, '真实 systemPrompt 服务应就绪');

/* 线上 `{{cwd}}` 由别的宿主插件注册；这里补上，好验证 interpolate:false 只保护
 * 本插件的条目、并没有把宿主的变量插值一起关掉。 */
systemPrompt.variable('cwd', () => projectRoot);

/* ── 挂本插件（真实 context() 注册路径） ── */
const memoryFiber = ctx.plugin(personaMemory, {});
await memoryFiber.await();
assert.equal(memoryFiber.state, 2, '本插件 fiber 应激活到 ACTIVE（state 2）');
assert.ok(registeredTools.some((tool) => tool.name === 'memory'), 'memory 工具应已注册');
assert.ok(registeredTools.some((tool) => tool.name === 'persona'), 'persona 工具应已注册');

const agentOf = (id, header) => ({ id, session: { header, events: [{ type: 'user/message' }] } });

/** 走完整链路：assemble() 出 assembly，再分别渲染 system 提示词与运行时上下文快照。 */
const renderFor = async (agent) => {
    const assembly = await systemPrompt.assemble({ agent });
    return {
        assembly,
        prompt: renderPrompt(assembly),
        context: renderContextSnapshot(assembly),
        names: assembly.contexts.map((entry) => entry.name),
    };
};

/* ══ 1. 主会话：上下文快照不抛错，{{…}} 原样保留 ══ */
const root = await renderFor(agentOf('root-1', { cwd: projectRoot }));
assert.deepEqual(root.names, ['memory:soul', 'memory:user', 'memory:facts'],
    '三个条目应注册为 runtime-context，而不是 system 段落');
assert.ok(root.context.includes('{{变量}}'), '全局记忆里的 {{变量}} 应原样进入快照');
assert.ok(root.context.includes('{{角色名}}'), 'SOUL.md 里的 {{角色名}} 应原样进入快照');
assert.ok(root.context.includes('{{项目变量}}'), '项目记忆里的 {{项目变量}} 应原样进入快照');
assert.ok(root.context.includes('### 全局记忆'), '主会话应注入全局记忆');
assert.ok(root.context.includes('### 项目记忆'), '主会话应注入项目记忆');
assert.ok(root.context.includes('<soul '), '主会话应注入角色 SOUL');
assert.ok(root.context.startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'),
    '快照应带宿主的固定前言');
assert.ok(root.context.indexOf('<soul ') < root.context.indexOf('### 全局记忆'),
    '角色应排在记忆之前（order 1000 < 1040）');

/* ★ 核心断言：角色与记忆不再出现在 system prompt 里 —— 这正是它们躲开工具说明段的原因。 */
assert.ok(!root.prompt.includes('<soul '), '角色 SOUL 不应再进 system prompt');
assert.ok(!root.prompt.includes('<user '), '角色 USER 不应再进 system prompt');
assert.ok(!root.prompt.includes('### 全局记忆'), '全局记忆不应再进 system prompt');
assert.ok(!root.prompt.includes('### 项目记忆'), '项目记忆不应再进 system prompt');

/* ★ 0.2.0：日志正文两个通道都不该出现。 */
assert.ok(!root.context.includes('<journal '), '不应再有 <journal> 段落');
assert.ok(!root.context.includes('日志里有'), '日志正文不应进入快照');
assert.match(root.context, /正文未注入/, '契约里应有「日志正文未注入」的指针');

/* 顺带确认：宿主的 {{cwd}} 变量仍然正常工作（没被 interpolate:false 波及） */
assert.ok(!root.prompt.includes('{{cwd}}'), '部署人格里的 {{cwd}} 仍应被宿主插值');

/* ══ 2. 子代理：只注入项目记忆 ══ */
const child = await renderFor(agentOf('child-1', { cwd: projectRoot, origin: 'subagent' }));
assert.ok(child.context.includes('### 项目记忆'), '子代理应注入项目记忆');
assert.ok(child.context.includes('{{项目变量}}'), '子代理的项目记忆 {{项目变量}} 应原样保留');
assert.ok(!child.context.includes('### 全局记忆'), '子代理不应注入全局记忆');
assert.ok(!child.context.includes('<soul '), '子代理不应注入角色 SOUL');
assert.ok(!child.context.includes('<user '), '子代理不应注入角色 USER');
assert.ok(!child.context.includes('<journal '), '不应有 <journal> 段落');
assert.ok(!child.context.includes('日志里有'), '子代理不应注入日志正文');
assert.ok(!child.context.includes('{{角色名}}'), '子代理不应看到角色文件内容');

/* ══ 3. 每次组装都可重复（注册是幂等的，没有重复名冲突） ══ */
await assert.doesNotReject(async () => renderFor(agentOf('root-2', { cwd: projectRoot })),
    '重复组装不应报重名');

await memoryFiber.dispose();
await promptFiber.dispose();
rmSync(home, { recursive: true, force: true });
console.log('✓ cordis-integration.test.mjs 全部通过（真实 cordis + 真实 system-prompt 全链路）');