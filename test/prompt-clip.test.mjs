/**
 * 回归测试：项目记忆注入裁剪与写入闸口同口径（0.9.0 · P1-2）。
 *
 * 背景：项目记忆有两套上限 —— 闸口看 `maxProjectChars`、注入裁剪看 `maxChars`。
 * `maxChars < maxProjectChars` 时（例如为省 token 把 maxChars 调到 3000），
 * 写入通过 8000 字符闸口的内容会在注入时被 `clip()` **静默截断**：文件里有一大段
 * 模型永远看不到。修法：生效上限 = `min(maxChars, maxProjectChars)`，并在两值不一致
 * 时渲染一行告警。
 *
 * 本测试钉住：
 *  1. `renderFacts` 的 clip 用 `min(maxChars, maxProjectChars)`；
 *  2. `maxProjectChars > maxChars` 时项目段落里出现一行告警（两值各自写明）；
 *  3. 两值一致时不出现告警；
 *  4. 插件接线后**写入侧**也按 min 拒写 ⇒「过闸口 ⇒ 一定不会被注入静默截断」；
 *  5. 子代理（只注入项目记忆）分支同样按 min 裁剪。
 *
 * 跑法：node test/prompt-clip.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 插件之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-clip-'));
process.env.DSH_HOME = home;

const mod = await import('../lib/index.js');
const { renderFacts } = await import('../lib/prompt-render.js');

const projectRoot = join(home, 'project');
const projectPath = join(projectRoot, 'MEMORY.md');
mkdirSync(projectRoot, { recursive: true });
mkdirSync(join(home, 'memory'), { recursive: true });
writeFileSync(join(home, 'memory', 'FACT.md'), '# FACT.md — 全局\n', 'utf8');

const EMPTY_CTX = {
    logger: { info() { }, warn() { } },
    effect(fn) {
        const dispose = fn();
        return typeof dispose === 'function' ? dispose : () => { };
    },
    on() { },
    get() { return undefined; },
    inject() { },
};

/** 捕获注册的工具与提示词段落。 */
function makeCtx() {
    const tools = new Map();
    const sections = [];
    const ctx = {
        ...EMPTY_CTX,
        get(key) {
            if (key === 'tools')
                return { register(tool) { tools.set(tool.name, tool); return () => { }; } };
            if (key === 'systemPrompt')
                return { getSectionOrder: () => 100, section(section) { sections.push(section); return () => { }; } };
            return undefined;
        },
    };
    return { ctx, tools, sections };
}

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

const flags = { globalMemory: true, projectMemory: true, persona: true };
const bigContent = 'a'.repeat(5000);
const snapshotExceptProject = (content) => ({
    globalFact: '# FACT.md — 全局\n',
    project: { path: projectPath, root: projectRoot, content },
    journalTotal: 1,
});

await check('renderFacts：clip 用 min(maxChars, maxProjectChars) = 3000', () => {
    const config = { maxChars: 3000, maxProjectChars: 8000, maxFactLines: 100, maxFactBytes: 8000 };
    const rendered = renderFacts(snapshotExceptProject(bigContent), config, 'full', flags);
    assert.ok(rendered.includes('…（已截断）'), '3000 字符处应截断（min=3000）');
    assert.ok(rendered.includes('a'.repeat(3000)), '应保留前 3000 字符');
    assert.ok(!rendered.includes('a'.repeat(3001)), '不应保留第 3001 个字符');

    const projectOnly = renderFacts(snapshotExceptProject(bigContent), config, 'project', flags);
    assert.ok(projectOnly.includes('…（已截断）'), '子代理分支同样按 min 裁剪');

    /* 反向：maxChars > maxProjectChars 的老文件（历史上可能超过闸口）也必须按 min 裁剪，
       旧实现只认 maxChars=8000 ⇒ 5000 字符原样进提示词。 */
    const legacyConfig = { maxChars: 8000, maxProjectChars: 3000, maxFactLines: 100, maxFactBytes: 8000 };
    const legacy = renderFacts(snapshotExceptProject(bigContent), legacyConfig, 'full', flags);
    assert.ok(legacy.includes('…（已截断）'), 'maxChars > maxProjectChars 时也按 min=3000 裁剪');
    assert.ok(!legacy.includes('a'.repeat(3001)), '不得按 maxChars=8000 原样放行');
});

await check('renderFacts：maxProjectChars > maxChars 时渲染一行告警', () => {
    const config = { maxChars: 3000, maxProjectChars: 8000, maxFactLines: 100, maxFactBytes: 8000 };
    const rendered = renderFacts(snapshotExceptProject('短内容'), config, 'full', flags);
    assert.match(rendered, /maxChars（3000）/, '告警要写明 maxChars');
    assert.match(rendered, /maxProjectChars（8000）/, '告警要写明 maxProjectChars');
    assert.match(rendered, /统一生效/, '告警要说明按较小值统一生效');
});

await check('renderFacts：两值一致时不渲染告警', () => {
    const config = { maxChars: 8000, maxProjectChars: 8000, maxFactLines: 100, maxFactBytes: 8000 };
    const rendered = renderFacts(snapshotExceptProject('短内容'), config, 'full', flags);
    assert.ok(!rendered.includes('maxProjectChars（'), '一致时不该出现口径告警');
});

await check('写入闸口同口径：maxChars=3000 时 5000 字符写入被拒，3000 字符通过且注入不截断', async () => {
    const { ctx, tools, sections } = makeCtx();
    mod.apply(ctx, { maxChars: 3000, maxProjectChars: 8000 });
    const memory = tools.get('memory');
    assert.ok(memory, '应注册 memory 工具');
    const exec = { agent: { session: { header: { cwd: projectRoot } } } };

    await assert.rejects(
        () => memory.execute({ action: 'update', scope: 'project', content: bigContent, force: true }, exec),
        (error) => error.code === 'MEMORY_BUDGET_EXCEEDED',
        '写入侧必须按 min(3000, 8000) 拒写，而不是让注入侧静默截断',
    );
    await memory.execute({ action: 'update', scope: 'project', content: 'a'.repeat(3000), force: true }, exec);

    const section = sections.find((item) => item.name === 'memory:facts');
    assert.ok(section, '应注册 memory:facts 段落');
    const rendered = section.text({
        agent: { id: 'prompt-clip-root', session: { header: { cwd: projectRoot }, events: [{ type: 'user/message' }] } },
    });
    assert.ok(!rendered.includes('…（已截断）'), '过了闸口的内容不得再被注入侧截断');
});

rmSync(home, { recursive: true, force: true });
if (failures.length > 0) {
    console.log(`\n✗ prompt-clip: ${failures.length} 项失败 / 共 ${checks} 项：${failures.join('、')}`);
    process.exit(1);
}
console.log(`\n✓ prompt-clip: ${checks} 项全部通过`);
