/**
 * 决定性验证：真实插件 + 真实宿主渲染器 + **用户真实的记忆/角色文件**。
 *
 * 前面的测试都用临时 DSH_HOME 造假数据。这个脚本直接读用户真实的
 * $DSH_HOME/memory/JOURNAL.jsonl（含真出问题的 `{{变量}}`）、FACT.md、personas/，
 * 走真实的 cordis + 真实的 @deepseek-ai/dsh-system-prompt 全会话组装链。
 *
 * 这是「修复到底有没有效」的最终判据 —— 因为它用的就是让用户崩溃的那份数据。
 *
 * 跑法：
 *   ELECTRON_RUN_AS_NODE=1 "<Harness.exe>" test/real-data.test.mjs
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ASAR = process.env.DSH_ASAR_ROOT
    ?? 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai';

/* 用真实数据的**副本**跑，但写操作落在临时 DSH_HOME。
 *
 * 早先这里直接指向真实的 `$DSH_HOME`，结果插件把快照写进了真实的
 * `memory/snapshots/`（`real-root.json` 等）—— 测试不该污染用户数据目录。
 * 现在把真实记忆/角色**拷进临时 home**：既保留「用真实数据验证」的价值，
 * 又保证零写入真实目录。 */
const REAL_HOME = process.env.DSH_REAL_HOME ?? 'C:/Users/Administrator/.dsh';
const home = mkdtempSync(join(tmpdir(), 'persona-memory-real-'));
process.env.DSH_HOME = home;

for (const rel of ['memory', 'personas']) {
    const src = join(REAL_HOME, rel);
    if (existsSync(src)) cpSync(src, join(home, rel), { recursive: true });
}
mkdirSync(join(home, 'memory'), { recursive: true });

const journalPath = join(home, 'memory', 'JOURNAL.jsonl');
const factPath = join(home, 'memory', 'FACT.md');

/* 先确认（拷贝来的）真实数据里确实存在会让旧版崩溃的内容；否则这个测试没有意义。 */
const journalRaw = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '';
assert.ok(journalRaw.includes('{{'),
    `真实 JOURNAL.jsonl 里应含 {{…}}（否则测不出修复）: ${join(REAL_HOME, 'memory', 'JOURNAL.jsonl')}`);
console.log(`  · 真实 journal 含 {{…}}：是（${journalRaw.split(/\r?\n/).filter((l) => l.trim()).length} 条，已拷贝到临时 home）`);
if (existsSync(factPath)) {
    console.log(`  · 真实 FACT.md 含 {{…}}：${readFileSync(factPath, 'utf8').includes('{{') ? '是' : '否'}`);
}

const { Context } = await import(`file:///${ASAR}/cordis/lib/index.js`);
const SystemPrompt = (await import(`file:///${ASAR}/dsh-system-prompt/lib/index.js`)).default;
const { renderPrompt } = await import(`file:///${ASAR}/dsh-system-prompt/lib/index.js`);

const entry = process.env.PERSONA_MEMORY_ENTRY
    ?? 'file:///D:/test1/dsh-plugin-persona-memory/lib/index.js';
const personaMemory = await import(entry);
console.log(`  · 被测插件：${entry}`);

const ctx = new Context();
ctx.provide('tools', { register() { return () => { }; } });
const pf = ctx.plugin(SystemPrompt, {
    personaPrefix: 'You are a coding agent powered by the {{model}} model.',
    personaSuffix: 'Your working directory is {{cwd}}.',
});
await pf.await();
const systemPrompt = ctx.get('systemPrompt');
systemPrompt.variable('cwd', () => 'D:\\test1');
systemPrompt.variable('model', () => 'deepseek-v4.1-flash');

const mf = ctx.plugin(personaMemory, {});
await mf.await();
assert.equal(mf.state, 2, '插件 fiber 应 ACTIVE');

/* ── 用真实 cwd 组装（D:\test1 是用户真实工作目录） ── */
const renderFor = async (agent) => renderPrompt(await systemPrompt.assemble({ agent }));
const rootAgent = { id: 'real-root', session: { header: { cwd: 'D:\\test1' }, events: [{ type: 'user/message' }] } };
const childAgent = { id: 'real-child', session: { header: { cwd: 'D:\\test1', origin: 'subagent' }, events: [{ type: 'user/message' }] } };

let rootText;
await assert.doesNotReject(async () => { rootText = await renderFor(rootAgent); },
    '★ 用真实记忆数据 + 真实宿主渲染器，主会话组装必须不抛错（这就是用户崩溃的那条路径）');

console.log('  · 主会话渲染成功，长度=%d', rootText.length);
assert.ok(rootText.includes('{{变量}}'), '真实 journal 里的 {{变量}} 应原样进入提示词，而不是被插值/炸掉');

/* ── 子代理：只注入项目记忆 ── */
const childText = await renderFor(childAgent);
assert.ok(!childText.includes('<soul '), '子代理不应注入角色 SOUL');
assert.ok(!childText.includes('<user '), '子代理不应注入角色 USER');
assert.ok(!childText.includes('<journal '), '子代理不应注入长期日志');
assert.ok(!childText.includes('### 全局记忆'), '子代理不应注入全局记忆');
console.log('  · 子代理渲染成功，长度=%d（无角色/全局/日志）', childText.length);

await mf.dispose();
await pf.dispose();

/* 反向自检：真实快照目录里**不应**出现本测试的 id —— 证明隔离确实生效。 */
const realSnapshots = join(REAL_HOME, 'memory', 'snapshots');
for (const id of ['real-root', 'real-child']) {
    assert.ok(!existsSync(join(realSnapshots, `${id}.json`)),
        `测试污染了真实快照目录：${join(realSnapshots, `${id}.json`)} 不应存在`);
}
console.log('  · 真实 snapshots 目录未被写入（隔离生效）');

rmSync(home, { recursive: true, force: true });
console.log('✓ real-data.test.mjs 全部通过（真实记忆数据 + 真实宿主，无崩溃）');
