/**
 * 回归测试：全局 FACT.md 的**行数硬上限**（默认 100 行）。
 *
 * 背景：FACT.md 会被注入**每一个主会话**的提示词。项目专属结论一旦写进来，就变成
 * 所有项目、每一轮都要付的固定开销，还会把真正跨项目稳定的事实挤出去。因此：
 *  1. `memory action=update, scope=global` 超过上限必须**报错拒绝**（不是静默截断）；
 *  2. 报错文案必须把「项目内容改投 scope=project」讲清楚，否则模型只会反复重试；
 *  3. `scope=project`（项目 MEMORY.md）**不受行数限制**；
 *  4. 契约文案要事先告诉模型上限是多少，别等写了才发现；
 *  5. 上限可配置（`config.maxFactLines`）。
 *
 * 跑法：node test/fact-limit.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-fact-'));
process.env.DSH_HOME = home;

const mod = await import(process.env.PERSONA_MEMORY_ENTRY ?? '../lib/index.js');

const memoryDir = join(home, 'memory');
const factPath = join(memoryDir, 'FACT.md');
const projectRoot = join(home, 'project');
mkdirSync(memoryDir, { recursive: true });
mkdirSync(projectRoot, { recursive: true });
/* 先放一份干净的全局记忆，免得 ensureSeed 的模板干扰行数断言。 */
writeFileSync(factPath, '# 全局\n', 'utf8');

/* ── 假 ctx：捕获注册的工具与提示词段落 ── */
const tools = new Map();
const sections = [];
const makeCtx = () => ({
    logger: { info() { }, warn() { } },
    effect(fn) {
        const dispose = fn();
        return typeof dispose === 'function' ? dispose : () => { };
    },
    on() { },
    get(key) {
        if (key === 'tools') {
            return { register(tool) { tools.set(tool.name, tool); return () => { }; } };
        }
        if (key === 'systemPrompt') {
            return {
                getSectionOrder: () => 100,
                section(section) { sections.push(section); return () => { }; },
            };
        }
        return undefined;
    },
    inject() { },
});

mod.apply(makeCtx(), {}); // 默认 maxFactLines = 100

const memory = tools.get('memory');
assert.ok(memory, '应注册 memory 工具');

const exec = { agent: { session: { header: { cwd: projectRoot } } } };
const run = (args) => memory.execute(args, exec);
const lines = (count, prefix) => Array.from({ length: count }, (_, index) => `- ${prefix} ${index + 1}`).join('\n');

/* ── 1) 正好 100 行：写入成功 ── */
const exactly100 = lines(100, '行');
const wrote = await run({ action: 'update', scope: 'global', content: exactly100 });
assert.match(wrote.text, /已写入全局记忆/, '正好 100 行应写入成功');
assert.equal(readFileSync(factPath, 'utf8').trim().split('\n').length, 100, '磁盘上的 FACT.md 应为 100 行');

/* ── 2) 末尾换行不算额外一行 ── */
await run({ action: 'update', scope: 'global', content: `${exactly100}\n` });
assert.equal(readFileSync(factPath, 'utf8').trim().split('\n').length, 100, '末尾换行不应把 100 行算成 101 行');

/* ── 3) 101 行：拒绝写入，且磁盘不变 ── */
const before = readFileSync(factPath, 'utf8');
await assert.rejects(
    () => run({ action: 'update', scope: 'global', content: lines(101, '行') }),
    (error) => {
        assert.match(error.message, /硬上限 100 行/, '报错应写明上限');
        assert.match(error.message, /101 行/, '报错应写明实际行数');
        assert.match(error.message, /超出 1 行/, '报错应写明超出多少');
        assert.match(error.message, /scope=project/, '报错应把模型指向项目记忆');
        assert.match(error.message, /MEMORY\.md/, '报错应点名项目记忆文件');
        return true;
    },
    '超过 100 行必须拒绝写入',
);
assert.equal(readFileSync(factPath, 'utf8'), before, '被拒绝的写入不得改动磁盘上的 FACT.md');

/* ── 4) 项目记忆不受行数限制 ── */
const proj = await run({ action: 'update', scope: 'project', content: lines(500, '项目行') });
assert.match(proj.text, /已写入项目记忆/, '项目记忆应能写入');
assert.match(readFileSync(join(projectRoot, 'MEMORY.md'), 'utf8'), /项目行 500/, '项目记忆 500 行应完整落盘');

/* ── 5) read 报告行数/上限，并在已超限时警告 ── */
const readOk = await run({ action: 'read' });
assert.match(readOk.text, /100 行 \/ 上限 100 行/, 'read 应报告当前行数与上限');
writeFileSync(factPath, `${lines(120, '行')}\n`, 'utf8');
const readOver = await run({ action: 'read' });
assert.match(readOver.text, /超出上限 20 行/, 'read 应在已超限时警告');
assert.match(readOver.text, /写入会被拒绝/, '警告应说明后续写入会被拒');

/* ── 6) 契约文案事先声明上限 ── */
const factsSection = sections.find((section) => section.name === 'memory:facts');
assert.ok(factsSection, '应注册 memory:facts 段落');
const agent = { id: 'fact-limit-root', session: { header: { cwd: projectRoot }, events: [{ type: 'user/message' }] } };
const rendered = factsSection.text({ agent });
assert.ok(rendered.length > 0, '记忆段落应渲染出内容（渲染异常会被插件吞成空串）');
assert.match(rendered, /硬上限 100 行/, '记忆契约里应写明 FACT.md 的上限');

/* ── 7) 上限可配置 ── */
tools.clear();
sections.length = 0;
mod.apply(makeCtx(), { maxFactLines: 3 });
const small = tools.get('memory');
assert.ok(small, '应注册 memory 工具（自定义上限）');
await assert.rejects(
    () => small.execute({ action: 'update', scope: 'global', content: lines(4, '行') }, exec),
    /硬上限 3 行/,
    'maxFactLines 应覆盖默认值',
);
assert.match(
    (await small.execute({ action: 'update', scope: 'global', content: lines(3, '行') }, exec)).text,
    /已写入全局记忆/,
    '上限设为 3 时正好 3 行应通过',
);

rmSync(home, { recursive: true, force: true });
console.log('✓ fact-limit.test.mjs 全部通过');
