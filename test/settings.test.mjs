/**
 * 回归测试：设置页的两个半边。
 *
 *  1. 三个注入开关（角色 / 全局记忆 / 项目记忆）—— 开关落在
 *     `$DSH_HOME/memory/injection.json`，覆盖组合配置的默认值，且**当前会话下一轮**
 *     就生效（快照只冻结文件内容，不冻结开关）。
 *  2. 附属插件设置项注册表 —— `ctx.personaMemory.settings.register()` 注册的项
 *     能被页面读到，回写走 `onChange`，非法值/重复 id/只读项都要拒绝。
 *
 * 跑法：node test/settings.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'persona-memory-settings-'));
process.env.DSH_HOME = home;

const memoryDir = join(home, 'memory');
const personasDir = join(home, 'personas');
const projectRoot = join(home, 'project');
mkdirSync(memoryDir, { recursive: true });
mkdirSync(join(personasDir, 'default'), { recursive: true });
mkdirSync(projectRoot, { recursive: true });
writeFileSync(join(memoryDir, 'FACT.md'), '# 全局\n\n全局事实。\n', 'utf8');
writeFileSync(join(personasDir, 'default', 'persona.yml'), 'name: 测试角色\ndescription: 测试\n', 'utf8');
writeFileSync(join(personasDir, 'default', 'SOUL.md'), '# SOUL\n\n我是测试角色。\n', 'utf8');
writeFileSync(join(personasDir, 'default', 'USER.md'), '# USER\n\n称呼我主人。\n', 'utf8');
writeFileSync(join(personasDir, '.active'), 'default\n', 'utf8');
writeFileSync(join(projectRoot, 'MEMORY.md'), '# 项目\n\n项目事实。\n', 'utf8');

const mod = await import(process.env.PERSONA_MEMORY_ENTRY ?? '../lib/index.js');

/** 最小宿主面：记录段落 + 捕获 provide 出来的服务。 */
function makeCtx() {
    const sections = [];
    const provided = {};
    const ctx = {
        logger: { info() { }, warn() { } },
        effect(fn) {
            const dispose = fn();
            return typeof dispose === 'function' ? dispose : () => { };
        },
        on() { },
        inject() { },
        provide(key, value) {
            provided[key] = value;
            return () => { };
        },
        get(key) {
            if (key === 'systemPrompt') {
                return {
                    getSectionOrder: () => 100,
                    section(section) {
                        sections.push(section);
                        return () => { };
                    },
                };
            }
            return undefined;
        },
    };
    return { ctx, sections, provided };
}

const sectionOf = (sections, name) => {
    const found = sections.find((section) => section.name === name);
    assert.ok(found, `缺少段落 ${name}`);
    return found;
};

/* ── 1. 默认：三个开关都开 ───────────────────────────────────────────────── */
const first = makeCtx();
mod.apply(first.ctx, {});
const api = first.provided.personaMemory;
assert.ok(api !== undefined, '应提供 personaMemory 服务');
assert.equal(api.version, 1);
assert.deepEqual(api.injection.get(), { persona: true, globalMemory: true, projectMemory: true });

const agent = {
    id: 'root-settings',
    session: { header: { cwd: projectRoot }, events: [{ type: 'user/message' }] },
};
const render = (sections) => ({
    soul: sectionOf(sections, 'memory:soul').text({ agent }),
    facts: sectionOf(sections, 'memory:facts').text({ agent }),
});

let out = render(first.sections);
assert.match(out.soul, /<soul /, '默认应注入角色');
assert.match(out.facts, /### 全局记忆/, '默认应注入全局记忆');
assert.match(out.facts, /### 项目记忆/, '默认应注入项目记忆');
assert.match(out.facts, /scope=global/, '默认契约应提到全局写入');
assert.match(out.facts, /scope=project/, '默认契约应提到项目写入');

/* ── 2. 关掉项目记忆：当前会话下一轮就生效 ──────────────────────────────── */
assert.deepEqual(api.injection.set({ projectMemory: false }), { persona: true, globalMemory: true, projectMemory: false });
out = render(first.sections);
assert.match(out.facts, /### 全局记忆/, '关项目记忆不应连带关掉全局');
assert.ok(!out.facts.includes('### 项目记忆'), '关掉的段落不应再注入');
assert.ok(!out.facts.includes('scope=project'), '关掉项目记忆后契约不应再指向它');
assert.match(out.facts, /scope=global/, '全局契约应保留');

const saved = JSON.parse(readFileSync(join(memoryDir, 'injection.json'), 'utf8'));
assert.equal(saved.projectMemory, false, '开关应落盘到 memory/injection.json');

/* ── 3. 关掉全局记忆 ─────────────────────────────────────────────────────── */
api.injection.set({ globalMemory: false, projectMemory: true });
out = render(first.sections);
assert.ok(!out.facts.includes('### 全局记忆'), '关掉后不应注入全局记忆');
assert.match(out.facts, /### 项目记忆/, '项目记忆仍应注入');
assert.ok(!out.facts.includes('scope=global'), '全局契约应消失');
assert.match(out.facts, /scope=project/, '项目契约应保留');

/* ── 4. 三个全关：段落渲染空串（角色也不注入） ──────────────────────────── */
api.injection.set({ persona: false, globalMemory: false, projectMemory: false });
out = render(first.sections);
assert.equal(out.soul, '', '关掉角色后不应注入 SOUL');
assert.equal(out.facts, '', '两个记忆都关时应整段留空');

/* ── 5. 覆盖层跨进程（重新 apply）仍生效 ─────────────────────────────────── */
const second = makeCtx();
mod.apply(second.ctx, {});
assert.deepEqual(
    second.provided.personaMemory.injection.get(),
    { persona: false, globalMemory: false, projectMemory: false },
    '覆盖层应在新实例里从 injection.json 读回',
);

/* ── 6. 附属插件设置项注册表 ─────────────────────────────────────────────── */
const received = [];
const handle = api.settings.register({
    id: 'recall.enabled',
    group: '自动召回',
    title: '每轮自动召回',
    description: 'BM25 检索历史日志后追加一条消息',
    kind: 'toggle',
    value: true,
    order: 10,
    onChange(value) { received.push(value); },
});
assert.ok(api.settings.has('recall.enabled'));
let listed = api.settings.list();
assert.equal(listed.length, 1);
assert.equal(listed[0].title, '每轮自动召回');
assert.equal(listed[0].group, '自动召回');
assert.equal(listed[0].value, true);
assert.ok(!('onChange' in listed[0]), '宿主函数不应被序列化进页面数据');

await api.settings.set('recall.enabled', false);
assert.deepEqual(received, [false], '回写应触发 onChange');
assert.equal(handle.get(), false, '句柄应看到新值');

await assert.rejects(async () => api.settings.set('recall.enabled', 'yes'), /不接受这个值/, '类型不符应拒绝');
await assert.rejects(async () => api.settings.set('missing', true), /未知的设置项/, '未知 id 应拒绝');
assert.throws(() => api.settings.register({ id: 'recall.enabled', title: 'dup' }), /重复/, '重复 id 应拒绝');
assert.throws(() => api.settings.register({ id: 'bad', title: 'bad', kind: 'select', value: 'a' }), /options/, 'select 缺 options 应拒绝');

const readonly = api.settings.register({ id: 'stats', title: '索引条数', kind: 'readonly', value: '42' });
await assert.rejects(async () => api.settings.set('stats', '43'), /只读/, '只读项应拒绝回写');
readonly.dispose();
assert.ok(!api.settings.has('stats'), 'dispose 后设置项应移除');

handle.dispose();
assert.ok(!api.settings.has('recall.enabled'), '句柄 dispose 后设置项应移除');

rmSync(home, { recursive: true, force: true });
console.log('✓ settings.test.mjs 全部通过');
