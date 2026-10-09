/**
 * 复现生产路径：**首条消息已固化快照**的会话（0.1.x 落盘的快照里可能含 journal）。
 *
 * 前面几个测试都走「实时渲染」（首条消息之前每轮读盘）。真实故障发生时，插件已经
 * 把注入内容写进了 `$DSH_HOME/memory/snapshots/<sessionId>.json`，之后每一轮都从
 * **快照**读，而不是读盘。这条路径必须单独验：快照里的文本同样依赖 `interpolate: false`。
 *
 * ★ 0.2.0 的迁移点也在这里钉住：旧快照带 `journal` 字段时，**必须被忽略** ——
 * 日志不再进提示词，而且不能因为「快照里正好有 journal 数组」就把它渲染出来。
 *
 * 跑法：
 *   ELECTRON_RUN_AS_NODE=1 "<Harness.exe>" test/snapshot-resume.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 仓库源码入口：从本测试文件自身位置推导，别写死绝对路径（插件搬过家）。 */
const REPO_ENTRY = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.js')).href;

const ASAR = process.env.DSH_ASAR_ROOT
    ?? 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai';

const home = mkdtempSync(join(tmpdir(), 'persona-memory-snap-'));
process.env.DSH_HOME = home;

const memoryDir = join(home, 'memory');
const personasDir = join(home, 'personas');
const projectRoot = join(home, 'project');
const sessionId = 'session-snapshot-test';
mkdirSync(memoryDir, { recursive: true });
mkdirSync(join(memoryDir, 'snapshots'), { recursive: true });
mkdirSync(join(personasDir, 'default'), { recursive: true });
mkdirSync(projectRoot, { recursive: true });

/* 磁盘上的「真相」保持干净，把 {{…}} 只放进**快照**，确保测的就是快照路径。 */
writeFileSync(join(memoryDir, 'FACT.md'), '# 全局\n\n干净内容。\n', 'utf8');
writeFileSync(join(memoryDir, 'JOURNAL.jsonl'), '', 'utf8');
writeFileSync(join(personasDir, 'default', 'persona.yml'), 'name: 测试\ndescription: t\n', 'utf8');
writeFileSync(join(personasDir, 'default', 'SOUL.md'), '# SOUL\n\n干净的人设。\n', 'utf8');
writeFileSync(join(personasDir, 'default', 'USER.md'), '# USER\n\n干净的用户档案。\n', 'utf8');
writeFileSync(join(personasDir, '.active'), 'default\n', 'utf8');

/* ★ 预置快照：模拟 0.1.x 「首条消息时固化」的产物，含 {{变量}}，
 *   且**故意带上旧的 journal 数组** —— 验证升级后它被忽略。 */
const snapshot = {
    version: 1,
    sessionId,
    createdAt: Date.now(),
    persona: { id: 'default', name: '测试', description: 't', soul: '我是 {{角色名}}。', user: '叫我 {{用户名}}。' },
    globalFact: '全局事实里有 {{全局变量}}。',
    project: { path: join(projectRoot, 'MEMORY.md'), root: projectRoot, content: '项目里有 {{项目变量}}。' },
    journal: [{ ts: '2026-01-01T00:00:00.000Z', tags: [], text: '快照日志里有 {{变量}}' }],
    journalTotal: 1,
};
writeFileSync(join(memoryDir, 'snapshots', `${sessionId}.json`), JSON.stringify(snapshot, null, 2), 'utf8');

const { Context } = await import(`file:///${ASAR}/cordis/lib/index.js`);
const SystemPrompt = (await import(`file:///${ASAR}/dsh-system-prompt/lib/index.js`)).default;
const { renderPrompt } = await import(`file:///${ASAR}/dsh-system-prompt/lib/index.js`);
const personaMemory = await import(process.env.PERSONA_MEMORY_ENTRY ?? REPO_ENTRY);

const ctx = new Context();
ctx.provide('tools', { register() { return () => { }; } });
const pf = ctx.plugin(SystemPrompt, { personaPrefix: 'agent', personaSuffix: 'wd {{cwd}}.' });
await pf.await();
const systemPrompt = ctx.get('systemPrompt');
systemPrompt.variable('cwd', () => projectRoot);

const mf = ctx.plugin(personaMemory, {});
await mf.await();
assert.equal(mf.state, 2, '插件 fiber 应 ACTIVE');

const renderFor = async (agent) => renderPrompt(await systemPrompt.assemble({ agent }));
const agent = {
    id: sessionId,
    session: { header: { cwd: projectRoot }, events: [{ type: 'user/message' }] },
};

/* ★ 关键断言：从磁盘快照回填 + 渲染，必须不抛错，且 {{…}} 原样保留。 */
let text;
await assert.doesNotReject(async () => { text = await renderFor(agent); },
    '含 {{变量}} 的**已固化快照**也必须能渲染（这正是用户重启/续接会话时走的路径）');
assert.ok(text.includes('{{角色名}}'), '快照角色里的 {{角色名}} 应原样保留');
assert.ok(text.includes('{{全局变量}}'), '快照全局记忆里的 {{全局变量}} 应原样保留');
assert.ok(text.includes('{{项目变量}}'), '快照项目记忆里的 {{项目变量}} 应原样保留');

/* ★ 0.2.0 迁移断言：旧快照里的 journal 数组（含 {{变量}}）必须被完全忽略。 */
assert.ok(!text.includes('快照日志里有'), '旧快照里的 journal 正文不应被渲染出来');
assert.ok(!text.includes('<journal '), '不应出现 <journal> 段落');
assert.match(text, /正文未注入/, '契约里仍应保留「日志正文未注入」的指针');

/* 同一会话再渲染一次（模拟第 2、3 轮），仍不能抛错。 */
await assert.doesNotReject(async () => { await renderFor(agent); }, '同一快照重复渲染不应抛错');

/* 子代理复用同一份快照时，只应拿到项目记忆那部分。 */
const childAgent = {
    id: sessionId,
    session: { header: { cwd: projectRoot, origin: 'subagent' }, events: [{ type: 'user/message' }] },
};
const childText = await renderFor(childAgent);
assert.ok(childText.includes('{{项目变量}}'), '子代理应拿到项目记忆');
assert.ok(!childText.includes('<soul '), '子代理不应拿到角色');
assert.ok(!childText.includes('<journal '), '不应出现 <journal> 段落');
assert.ok(!childText.includes('快照日志里有'), '子代理不应拿到日志正文');
assert.ok(!childText.includes('### 全局记忆'), '子代理不应拿到全局记忆');

await mf.dispose();
await pf.dispose();
rmSync(home, { recursive: true, force: true });
console.log('✓ snapshot-resume.test.mjs 全部通过（已固化快照路径 + 子代理作用域）');
