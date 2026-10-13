/**
 * 回归测试：项目 MEMORY.md 的**字符硬上限**（默认 8000 字符，口径同注入侧 `maxChars`）。
 *
 * 背景（0.4.0 之前的不对称）：
 *   - 注入侧：`clip(content, maxChars)` 默认 8000，超出**静默截断**；
 *   - 写入侧：`scope=project` 的 update **完全不校验**。
 * ⇒ 「写的时候不拦，读的时候悄悄截断」，文件里会有一段内容模型永远看不到。
 * 本测试保证 0.4.0 之后：
 *  1. `scope=project` 超限 ⇒ **报错拒绝、不落盘**（不是截断）；
 *  2. 报错要给出实际字符数 / 上限 / 超出量，并指向 `action=append`（日志）与 `scope=global`；
 *  3. 恰好等于上限应通过（`<=` 语义）；
 *  4. 字符口径与注入侧一致（中文 1 字符 = 1 字符，不是按字节算）；
 *  5. 字符口径 = `clip()` 的口径（`trim()` 后长度，`\r\n` 算 2 个字符）⇒「过闸口必不被截断」；
 *  6. 上限可配置（`config.maxProjectChars`）；
 *  7. `read` 报告项目记忆的字符数与上限，超限时警告；
 *  8. 契约文案（主会话版 + 子代理版）事先写明上限。
 *
 * 跑法：node test/project-limit.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-project-'));
process.env.DSH_HOME = home;

const mod = await import(process.env.PERSONA_MEMORY_ENTRY ?? '../lib/index.js');

const memoryDir = join(home, 'memory');
const factPath = join(memoryDir, 'FACT.md');
const projectRoot = join(home, 'project');
const projectPath = join(projectRoot, 'MEMORY.md');
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

mod.apply(makeCtx(), {}); // 默认 maxProjectChars = 8000

const memory = tools.get('memory');
assert.ok(memory, '应注册 memory 工具');

const exec = { agent: { session: { header: { cwd: projectRoot } } } };
const run = (args) => memory.execute(args, exec);
const chars = (count) => 'a'.repeat(count);

/* ── 1) 超过 8000 字符：拒绝写入，且磁盘不变 ── */
assert.ok(!existsSync(projectPath), '前置：MEMORY.md 此时还不存在');
await assert.rejects(
    () => run({ action: 'update', scope: 'project', content: chars(8001) }),
    (error) => {
        assert.match(error.message, /项目记忆 MEMORY\.md 有硬上限 8000 字符/, '报错应写明文件与上限');
        assert.match(error.message, /8001 字符/, '报错应写明实际字符数');
        assert.match(error.message, /超出 1 字符/, '报错应写明超出多少');
        assert.match(error.message, /action=append/, '报错应把流水账指向 JOURNAL');
        assert.match(error.message, /scope=global/, '报错应给出换工作区就成立的内容的归属');
        return true;
    },
    '项目记忆超过 8000 字符必须拒绝写入',
);
assert.ok(!existsSync(projectPath), '被拒绝的写入不得创建/改动 MEMORY.md');

/* ── 2) 恰好 8000 字符：通过 ── */
const wrote = await run({ action: 'update', scope: 'project', content: chars(8000) });
assert.match(wrote.text, /已写入项目记忆/, '恰好 8000 字符应写入成功');
assert.match(wrote.text, /8000 字符/, '成功回执应报告字符数');
assert.equal(readFileSync(projectPath, 'utf8').trim(), chars(8000), '磁盘上应为 8000 字符正文');

/* ── 3) 已存在文件 + 超限写入：磁盘内容保持原样 ── */
const before = readFileSync(projectPath, 'utf8');
await assert.rejects(
    () => run({ action: 'update', scope: 'project', content: chars(9000) }),
    /超出 1000 字符/,
    '超限写入应报出超出量',
);
assert.equal(readFileSync(projectPath, 'utf8'), before, '被拒绝的写入不得改动磁盘上的 MEMORY.md');

/* ── 3b) 不变量：闸口位置 == 注入侧截断位置 ──
   writeFileSync 回去改一下：8000 字符不截断、8001 字符被 clip() 截断。
   这正是本项目闸口的全部意义：**过闸口 ⇒ 一定不会被注入静默截断**。 */
const factsSectionRef = sections.find((section) => section.name === 'memory:facts');
assert.ok(factsSectionRef, '应注册 memory:facts 段落');
const renderFor = (sessionId) => factsSectionRef.text({
    agent: { id: sessionId, session: { header: { cwd: projectRoot }, events: [{ type: 'user/message' }] } },
});
writeFileSync(projectPath, chars(8000), 'utf8');
assert.ok(!renderFor('exact-8000').includes('已截断'), '8000 字符（= maxChars）不应被注入侧截断');
writeFileSync(projectPath, chars(8001), 'utf8');
assert.ok(renderFor('exact-8001').includes('已截断'), '8001 字符应被注入侧截断（证明闸口正落在边界上）');
writeFileSync(projectPath, before, 'utf8'); // 还原，继续后面的断言

/* ── 4) 字符口径：中文按「字符」不是「字节」 ── */
// 3000 个中文 = 3000 字符（9000 字节）⇒ 按字符口径应通过
const cjk = '喵'.repeat(3000);
assert.match(
    (await run({ action: 'update', scope: 'project', content: cjk })).text,
    /3000 字符/,
    '中文应按字符数计（3000 字 = 3000 字符），与注入侧 maxChars 同口径',
);

/* ── 5) 字符口径 = `clip()` 的口径：`trim()` 后长度，`\r\n` 算 2 个字符 ── */
// 落盘 = "a\r\nb\r\nc\n"，`clip()` 那边是 `text.trim().length` ⇒ 7
await run({ action: 'update', scope: 'project', content: 'a\r\nb\r\nc' });
const crlfRead = await run({ action: 'read' });
assert.match(crlfRead.text, /7 字符 \/ 上限 8000 字符/, '字符数应与注入侧 clip() 逐字同口径（不归一化 \\r\\n）');

/* ── 6) read 报告项目记忆字符数/上限，并在超限时警告 ── */
writeFileSync(projectPath, chars(9000), 'utf8');
const readOver = await run({ action: 'read' });
assert.match(readOver.text, /9000 字符 \/ 上限 8000 字符/, 'read 应报告当前字符数与上限');
assert.match(readOver.text, /已超限/, 'read 应在项目记忆超限时警告');
assert.match(readOver.text, /写入会被拒绝/, '警告应说明后续写入会被拒');

/* ── 7) 契约文案事先声明上限（主会话版 + 子代理版） ── */
const factsSection = sections.find((section) => section.name === 'memory:facts');
assert.ok(factsSection, '应注册 memory:facts 段落');
const rootAgent = { id: 'project-limit-root', session: { header: { cwd: projectRoot }, events: [{ type: 'user/message' }] } };
const rootRendered = factsSection.text({ agent: rootAgent });
assert.match(rootRendered, /上限 8000 字符/, '主会话契约里应写明项目记忆上限');

const childAgent = {
    id: 'project-limit-child',
    session: { header: { cwd: projectRoot, origin: 'subagent', parentSession: 'project-limit-root' }, events: [{ type: 'user/message' }] },
};
const childRendered = factsSection.text({ agent: childAgent });
assert.ok(childRendered.includes('子代理只拿到**项目记忆**'), '子代理应拿到项目版契约');
assert.match(childRendered, /上限 8000 字符/, '子代理契约里也应写明项目记忆上限');

/* ── 8) 上限可配置 ── */
tools.clear();
sections.length = 0;
mod.apply(makeCtx(), { maxProjectChars: 5 });
const small = tools.get('memory');
assert.ok(small, '应注册 memory 工具（自定义项目上限）');
await assert.rejects(
    () => small.execute({ action: 'update', scope: 'project', content: chars(6) }, exec),
    /硬上限 5 字符/,
    'maxProjectChars 应覆盖默认值',
);
assert.match(
    (await small.execute({ action: 'update', scope: 'project', content: chars(5) }, exec)).text,
    /已写入项目记忆/,
    '上限设为 5 时恰好 5 字符应通过',
);

rmSync(home, { recursive: true, force: true });
console.log('✓ project-limit.test.mjs 全部通过');
