/**
 * 回归测试：全局 FACT.md 的**字节硬上限**（默认 8000 B，UTF-8）。
 *
 * 背景：0.3.0 只卡行数（100 行）⇒ 行长完全自由，100 行可以写 7 KB 也可以写 20 KB，
 * 全局常驻 token 开销不可预测。0.4.0 补上字节闸口，与行数闸口**同时生效**：
 *  1. 行数没超、字节超了 ⇒ 同样必须**报错拒绝**（不是静默截断）；
 *  2. 行数与字节**都**超时，报错文案要同时给出两项实际值；
 *  3. 恰好等于上限应通过（`<=` 语义，与行数闸口一致）；
 *  4. 字节按 **UTF-8** 计（中文 3 字节，不是 1 字符 = 1 字节）；
 *  5. 口径与 `countLines()` 一致：先做 `\r\n` 归一化，不把 `\r` 算进去；
 *  6. 上限可配置（`config.maxFactBytes`），且**不影响**行数闸口；
 *  7. `read` 报告字节数与字节上限；契约文案事先写明双上限。
 *
 * 跑法：node test/fact-bytes.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-factbytes-'));
process.env.DSH_HOME = home;

const mod = await import(process.env.PERSONA_MEMORY_ENTRY ?? '../lib/index.js');

const memoryDir = join(home, 'memory');
const factPath = join(memoryDir, 'FACT.md');
const projectRoot = join(home, 'project');
mkdirSync(memoryDir, { recursive: true });
mkdirSync(projectRoot, { recursive: true });
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

mod.apply(makeCtx(), {}); // 默认 maxFactLines = 100, maxFactBytes = 8000

const memory = tools.get('memory');
assert.ok(memory, '应注册 memory 工具');

const exec = { agent: { session: { header: { cwd: projectRoot } } } };
const run = (args) => memory.execute(args, exec);
/** 造一个「行数不超、字节超」的内容：单行超长。 */
const bigLine = (bytes) => 'a'.repeat(bytes);

/* ── 1) 行数没超、字节超了：拒绝写入，且磁盘不变 ── */
const before = readFileSync(factPath, 'utf8');
await assert.rejects(
    () => run({ action: 'update', scope: 'global', content: bigLine(8001) }),
    (error) => {
        assert.match(error.message, /硬上限 100 行 \/ 8000 字节/, '报错应写明双上限');
        assert.match(error.message, /8001 字节/, '报错应写明实际字节数');
        assert.match(error.message, /超出 1 字节/, '报错应写明超出多少字节');
        assert.ok(!/超出 \d+ 行/.test(error.message), '行数没超就不该报行数超限');
        assert.match(error.message, /scope=project/, '报错应把模型指向项目记忆');
        assert.match(error.message, /action=append/, '报错应把流水账指向 JOURNAL');
        return true;
    },
    '字节超过 8000 必须拒绝写入（即使只有 1 行）',
);
assert.equal(readFileSync(factPath, 'utf8'), before, '被拒绝的写入不得改动磁盘上的 FACT.md');

/* ── 2) 恰好 8000 字节：通过（`<=` 语义） ── */
const exactly8000 = bigLine(8000);
const wrote = await run({ action: 'update', scope: 'global', content: exactly8000 });
assert.match(wrote.text, /已写入全局记忆/, '恰好 8000 字节应写入成功');
assert.match(wrote.text, /8000 字节/, '成功回执应报告字节数');
assert.equal(readFileSync(factPath, 'utf8').trim(), exactly8000, '磁盘上的 FACT.md 应为 8000 字节正文');

/* ── 3) 行数与字节都超：两项实际值都要出现 ── */
const both = Array.from({ length: 120 }, (_, index) => `- 行 ${index + 1} ${'a'.repeat(80)}`).join('\n');
await assert.rejects(
    () => run({ action: 'update', scope: 'global', content: both }),
    (error) => {
        assert.match(error.message, /120 行（超出 20 行/, '应报实际行数与超出量');
        assert.match(error.message, /字节（超出 \d+ 字节/, '应报实际字节数与超出量');
        return true;
    },
    '行数与字节都超时应把两项都写进报错',
);

/* ── 4) 字节按 UTF-8 计：中文 3 字节 ── */
await assert.rejects(
    () => run({ action: 'update', scope: 'global', content: '喵'.repeat(2700) }),
    /8100 字节/,
    '中文应按 UTF-8 3 字节/字计（2700 字 = 8100 字节）',
);
const cjk = '喵'.repeat(2666); // 7998 字节
assert.match(
    (await run({ action: 'update', scope: 'global', content: cjk })).text,
    /已写入全局记忆/,
    '7998 字节的中文内容应通过',
);

/* ── 5) `\r\n` 归一化：换行符只按 1 字节算 ── */
const crlf = 'a\r\nb\r\nc';
await run({ action: 'update', scope: 'global', content: crlf }); // 落盘 = "a\r\nb\r\nc\n" ⇒ 归一化 "a\nb\nc\n" = 6 字节
const crlfRead = await run({ action: 'read' });
assert.match(crlfRead.text, /6 字节 \/ 上限 8000 字节/, '\\r\\n 应归一化成 \\n 后计数（每行尾 1 字节）');

/* ── 6) read 报告字节数/上限，并在字节超限时警告 ── */
writeFileSync(factPath, bigLine(9000), 'utf8'); // 无尾换行 ⇒ 恰好 9000 字节
const readOver = await run({ action: 'read' });
assert.match(readOver.text, /9000 字节 \/ 上限 8000 字节/, 'read 应报告当前字节数与上限');
assert.match(readOver.text, /已超限/, 'read 应在字节超限时警告');
assert.match(readOver.text, /写入会被拒绝/, '警告应说明后续写入会被拒');

/* ── 7) 契约文案事先声明双上限 ── */
const factsSection = sections.find((section) => section.name === 'memory:facts');
assert.ok(factsSection, '应注册 memory:facts 段落');
const agent = { id: 'fact-bytes-root', session: { header: { cwd: projectRoot }, events: [{ type: 'user/message' }] } };
const rendered = factsSection.text({ agent });
assert.ok(rendered.length > 0, '记忆段落应渲染出内容（渲染异常会被插件吞成空串）');
assert.match(rendered, /硬上限 100 行 AND 8000 字节/, '契约应写明 FACT.md 的双上限');

/* ── 8) 上限可配置：只调字节、不动行数 ── */
tools.clear();
sections.length = 0;
mod.apply(makeCtx(), { maxFactBytes: 10 });
const small = tools.get('memory');
assert.ok(small, '应注册 memory 工具（自定义字节上限）');
await assert.rejects(
    () => small.execute({ action: 'update', scope: 'global', content: bigLine(11) }, exec),
    /硬上限 100 行 \/ 10 字节/,
    'maxFactBytes 应覆盖默认值，且行数上限保持 100',
);
assert.match(
    (await small.execute({ action: 'update', scope: 'global', content: bigLine(10) }, exec)).text,
    /已写入全局记忆/,
    '字节上限设为 10 时恰好 10 字节应通过',
);

rmSync(home, { recursive: true, force: true });
console.log('✓ fact-bytes.test.mjs 全部通过');
