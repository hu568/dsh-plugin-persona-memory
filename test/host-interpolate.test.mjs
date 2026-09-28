/**
 * 用**真实**的 @deepseek-ai/dsh-system-prompt 渲染器验证 memory:* 段落。
 *
 * 为什么必须用真家伙：修复点是 `interpolate: false`，而「interpolate 会不会被
 * 保留/会不会被遵守」完全是宿主的实现细节。这个脚本直接从 asar 里 import 宿主
 * 的 `renderPrompt()`，按宿主 `assemble()` 的同样方式拼 assembly，再喂给它真实
 * 的 memory:* 段落文本 —— 拿到「真崩 / 真不崩」的结论，而不是自说自话。
 *
 * 跑法（必须用 Harness 的 Electron node，才能 import asar 内的包）：
 *   ELECTRON_RUN_AS_NODE=1 "<Harness.exe>" test/host-interpolate.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ASAR = process.env.DSH_ASAR_ROOT
    ?? 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai';
// asar 内的包必须走 file:// URL（裸盘符路径会被 ESM loader 当成非法 scheme 拒绝）。
const { renderPrompt } = await import(`file:///${ASAR}/dsh-system-prompt/lib/index.js`);

/* ── 隔离的 DSH_HOME，样本里故意塞满 {{…}} ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-host-'));
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

const mod = await import(process.env.PERSONA_MEMORY_ENTRY
    ?? 'file:///D:/test1/dsh-plugin-persona-memory/lib/index.js');

/* ── 捕获插件真实注册的段落对象 ── */
const registered = [];
mod.apply({
    logger: { info() { }, warn() { } },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => { }; },
    on() { },
    get(key) {
        if (key === 'systemPrompt') {
            return {
                getSectionOrder: () => 0,
                section(section) { registered.push(section); return () => { }; },
            };
        }
        return undefined;
    },
    inject() { },
}, {});

/** 完全照宿主 assemble() 的写法拼 section（含 interpolate 的保留规则）。 */
const toAssemblySections = (agent) => registered.map((section) => ({
    name: section.name,
    text: typeof section.text === 'function' ? section.text({ agent }) : section.text,
    ...section.interpolate !== void 0 ? { interpolate: section.interpolate } : {},
}));

const rootAgent = { id: 'root-1', session: { header: { cwd: projectRoot }, events: [{ type: 'user/message' }] } };
const childAgent = { id: 'child-1', session: { header: { cwd: projectRoot, origin: 'subagent' }, events: [{ type: 'user/message' }] } };

/* ══ 1. 结论：真实的 renderPrompt 必须不抛错，且 {{…}} 原样保留 ══ */
const rootAssembly = { sections: toAssemblySections(rootAgent), variables: {} };
let rendered;
assert.doesNotThrow(() => { rendered = renderPrompt(rootAssembly); },
    '真实的宿主 renderPrompt 不应在本插件段落上抛错');
assert.ok(rendered.includes('{{变量}}'), '记忆里的 {{变量}} 应原样进入提示词');
assert.ok(rendered.includes('{{角色名}}'), '角色文件里的 {{角色名}} 应原样进入提示词');
assert.ok(rendered.includes('{{项目变量}}'), '项目记忆里的 {{项目变量}} 应原样进入提示词');

/* ══ 2. 反证：只把 memory:journal 的 interpolate:false 摘掉，就精确复现用户的错误 ══
 *
 * 用户的真实数据里只有 JOURNAL.jsonl 含 `{{变量}}`（SOUL.md / FACT.md 都没有），
 * 所以当时崩的正是 memory:journal —— 与截图逐字一致。这里刻意只摘 journal 一个
 * 段落的标记，让 memory:soul / :user / :facts 仍受保护，从而复现同一个失败面。 */
const journal = registered.find((section) => section.name === 'memory:journal');
assert.ok(journal, '应注册了 memory:journal');
const unguardedJournal = {
    sections: rootAssembly.sections.map((section) => section.name === 'memory:journal'
        ? { name: section.name, text: section.text }
        : section),
    variables: {},
};
assert.throws(
    () => renderPrompt(unguardedJournal),
    (error) => {
        assert.match(String(error.message), /malformed prompt variable reference/,
            '去掉 interpolate:false 应复现 malformed prompt variable reference');
        assert.match(String(error.message), /memory:journal/,
            '复现的错误应点名 memory:journal（与用户截图一致）');
        assert.match(String(error.message), /variable names match/,
            '复现的应是「变量名不合法」那一支（与用户截图逐字一致）');
        return true;
    },
    '必须能复现原始崩溃 —— 否则这个测试证明不了任何事',
);

/* ══ 3. 子代理 assembly：项目记忆在、角色/全局/日志不在，且同样不抛错 ══ */
const childAssembly = { sections: toAssemblySections(childAgent), variables: {} };
let childRendered;
assert.doesNotThrow(() => { childRendered = renderPrompt(childAssembly); });
assert.ok(childRendered.includes('### 项目记忆'), '子代理应拿到项目记忆');
assert.ok(!childRendered.includes('### 全局记忆'), '子代理不应拿到全局记忆');
assert.ok(!childRendered.includes('<soul '), '子代理不应拿到角色 SOUL');
assert.ok(!childRendered.includes('<user '), '子代理不应拿到角色 USER');
assert.ok(!childRendered.includes('<journal '), '子代理不应拿到长期日志');

rmSync(home, { recursive: true, force: true });
console.log('✓ host-interpolate.test.mjs 全部通过（用真实宿主渲染器验证）');
