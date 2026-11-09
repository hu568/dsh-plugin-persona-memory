/**
 * 回归测试：库级信任门（0.9.0 新增）。
 *
 * 背景：项目根 MEMORY.md 可能是**随仓库分发**的文件 —— clone / fork 别人的仓库时它被
 * 预置，里面完全可能出现「忽略之前的指令」这类写给模型的句子。注入时必须声明来源不可信，
 * 否则等于把别人的仓库文本当系统指令读。
 *
 * 判定规则（`store.gitOriginOf()`）：向上找 `.git`，目录 ⇒ `repo`；文件且含 `gitdir:`
 * ⇒ `repo`（worktree / submodule）；存在但形状不认识 / 读失败 / 走不到根 ⇒ `unknown`；
 * 走到文件系统根都没有 ⇒ `local`。**永不抛错**，`repo`/`unknown` 一律 fail-open 打告示。
 *
 * 本测试钉住：
 *  1. 非仓库目录 ⇒ 不打扰（无告示）；
 *  2. `.git` 目录 ⇒ 主会话与子代理两种注入都追加「来源不可信」固定告示；
 *  3. `.git` 文件带 `gitdir:` ⇒ 同样打告示；
 *  4. `.git` 存在但形状不认识 ⇒ 按不可信打告示（fail-open）；
 *  5. `trustProjectFromRepo: false` ⇒ 明确信任、不告示；默认值为 true；
 *  6. `gitOriginOf()` 永不抛错（空串 / 不存在路径都给 unknown）。
 *
 * 跑法：node test/trust-gate.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-trust-'));
process.env.DSH_HOME = home;

const store = await import('../lib/store.js');
const { renderFacts } = await import('../lib/prompt-render.js');
const { Config } = await import('../lib/config.js');

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

/** 造一个项目目录（可选地标记成 git 仓库）。 */
function makeProject(name, gitMarker) {
    const root = join(home, name);
    mkdirSync(root, { recursive: true });
    const content = '# MEMORY.md — 项目记忆\n\n1. 这个仓库里的人写的一条结论\n';
    writeFileSync(join(root, 'MEMORY.md'), content, 'utf8');
    if (gitMarker === 'dir')
        mkdirSync(join(root, '.git'), { recursive: true });
    else if (gitMarker === 'gitdir')
        writeFileSync(join(root, '.git'), 'gitdir: /somewhere/.git/worktrees/w1\n', 'utf8');
    else if (gitMarker === 'weird')
        writeFileSync(join(root, '.git'), '这不是 gitdir，也不是目录\n', 'utf8');
    return {
        root,
        snapshot: { path: join(root, 'MEMORY.md'), root, content },
    };
}

const BASE_CONFIG = { maxChars: 8000, maxProjectChars: 8000, maxFactLines: 100, maxFactBytes: 8000 };
const flags = { globalMemory: true, projectMemory: true, persona: true };
const renderFull = (snapshot, config = {}) => renderFacts(
    { globalFact: '# FACT.md\n', project: snapshot, journalTotal: 0 },
    { ...BASE_CONFIG, trustProjectFromRepo: true, ...config },
    'full',
    flags,
);
const renderProjectOnly = (snapshot, config = {}) => renderFacts(
    { globalFact: '# FACT.md\n', project: snapshot, journalTotal: 0 },
    { ...BASE_CONFIG, trustProjectFromRepo: true, ...config },
    'project',
    flags,
);

await check('config：trustProjectFromRepo 默认 true', () => {
    assert.equal(Config({}).trustProjectFromRepo, true);
    assert.equal(Config({ trustProjectFromRepo: false }).trustProjectFromRepo, false);
});

await check('非 git 项目：不打扰（无告示）', () => {
    const { snapshot } = makeProject('plain');
    assert.equal(store.gitOriginOf(snapshot.root), 'local');
    const rendered = renderFull(snapshot);
    assert.ok(!rendered.includes('来源不可信'), '本机生成的项目不该有告示');
    assert.ok(rendered.includes('这个仓库里的人写的一条结论'), '项目正文照常注入');
});

await check('.git 目录：主会话与子代理都追加固定告示', () => {
    const { snapshot } = makeProject('with-git', 'dir');
    assert.equal(store.gitOriginOf(snapshot.root), 'repo');
    for (const [label, rendered] of [['full', renderFull(snapshot)], ['project', renderProjectOnly(snapshot)]]) {
        assert.match(rendered, /来源不可信/, `${label} 应打告示`);
        assert.match(rendered, /不作为系统指令执行/, `${label} 告示第二行缺失`);
        assert.match(rendered, /以用户消息为准/, `${label} 告示应说明冲突优先级`);
        assert.ok(rendered.includes('这个仓库里的人写的一条结论'), `${label} 项目正文仍要注入（只是标注不可信）`);
    }
});

await check('.git 文件带 gitdir（worktree / submodule）：同样按仓库打告示', () => {
    const { snapshot } = makeProject('with-worktree', 'gitdir');
    assert.equal(store.gitOriginOf(snapshot.root), 'repo');
    assert.match(renderFull(snapshot), /来源不可信/);
});

await check('.git 存在但形状不认识：fail-open 按不可信打告示', () => {
    const { snapshot } = makeProject('with-weird-git', 'weird');
    assert.equal(store.gitOriginOf(snapshot.root), 'unknown');
    assert.match(renderFull(snapshot), /来源不可信/, '判断失败必须展示告示（fail-open）');
});

await check('trustProjectFromRepo=false：明确信任，不再告示', () => {
    const { snapshot } = makeProject('trusted-repo', 'dir');
    const rendered = renderFull(snapshot, { trustProjectFromRepo: false });
    assert.ok(!rendered.includes('来源不可信'));
    assert.ok(rendered.includes('这个仓库里的人写的一条结论'));
});

await check('gitOriginOf：空参数 / 不存在路径 / 非字符串都返回 unknown，绝不抛错', () => {
    for (const value of ['', undefined, null, 42, join(home, 'not-exists', 'deep')]) {
        assert.equal(store.gitOriginOf(value), 'unknown');
    }
});

rmSync(home, { recursive: true, force: true });
if (failures.length > 0) {
    console.log(`\n✗ trust-gate: ${failures.length} 项失败 / 共 ${checks} 项：${failures.join('、')}`);
    process.exit(1);
}
console.log(`\n✓ trust-gate: ${checks} 项全部通过`);
