/**
 * 回归测试：右侧栏面板跟随 DSH 工作区 + 压缩管线默认开启（0.7.1）。
 *
 *  1. `GET /api/state?cwd=…` 返回 `memory.current` = 该 cwd 的项目（按注入侧同一规则向上找 MEMORY.md）；
 *  2. 项目列表包含 DSH 工作区注册表里的工作区（即使本进程一个会话都没跑过）；
 *  3. 不带 cwd 时 `memory.current = null`（旧客户端 / 写操作回包不改变面板选择）；
 *  4. 面板能保存「注册表里、没跑过会话」的工作区的项目记忆；
 *  5. 压缩管线默认开启：`Config({}).compactionEnabled === true`，且默认配置下 `/memory-compact` 可用。
 *
 * 跑法：node test/panel-workspace.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/* ── 假 DSH_HOME：隔离真实数据；必须在 import 插件之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-panel-workspace-'));
process.env.DSH_HOME = home;

const memoryDir = join(home, 'memory');
const personasDir = join(home, 'personas');
const wsAlpha = join(home, 'ws-alpha');
const wsBeta = join(home, 'ws-beta');
const wsGamma = join(home, 'ws-gamma');
for (const dir of [memoryDir, join(personasDir, 'default'), wsAlpha, wsBeta, wsGamma, join(home, 'storages')])
    mkdirSync(dir, { recursive: true });

writeFileSync(join(memoryDir, 'FACT.md'), '# FACT.md — 全局\n\n## 关于用户\n\n- 全局事实。\n', 'utf8');
writeFileSync(join(wsAlpha, 'MEMORY.md'), '# MEMORY.md — alpha\n\n1. alpha 的结论\n', 'utf8');
writeFileSync(join(wsBeta, 'MEMORY.md'), '# MEMORY.md — beta\n\n1. beta 的结论\n', 'utf8');
writeFileSync(join(personasDir, 'default', 'persona.yml'), 'name: 面板测试\n', 'utf8');
writeFileSync(join(personasDir, 'default', 'SOUL.md'), '# SOUL\n\n我是面板测试角色。\n', 'utf8');
writeFileSync(join(personasDir, 'default', 'USER.md'), '# USER\n\n称呼我主人。\n', 'utf8');
writeFileSync(join(personasDir, '.active'), 'default\n', 'utf8');
writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-alpha', 'ws-beta', 'ws-gamma'] },
    tables: {
        workspaces: {
            'ws-alpha': { path: wsAlpha, title: 'alpha', sessionIds: [] },
            'ws-beta': { path: wsBeta, title: 'beta', sessionIds: [] },
            'ws-gamma': { path: wsGamma, title: 'gamma', sessionIds: [] },
        },
    },
}, null, 2), 'utf8');

const mod = await import(process.env.PERSONA_MEMORY_ENTRY ?? '../lib/index.js');

/* ── 假宿主面：捕获 commands + webServer 路由 ───────────────────────────── */
const routes = new Map();
let registeredCommand = null;
const commands = {
    register(spec) {
        registeredCommand = spec;
        return () => { };
    },
};
const webServer = {
    register(spec) {
        routes.set(spec.path, spec.handler);
        return () => { };
    },
};
const makeCtx = () => {
    const ctx = {
        logger: { info() { }, warn() { } },
        effect(fn) {
            const dispose = fn();
            return typeof dispose === 'function' ? dispose : () => { };
        },
        on() { },
        inject(deps, callback) {
            if (deps.includes('commands') || deps.includes('webServer'))
                callback(ctx);
        },
        provide() { },
        get(name) {
            if (name === 'commands')
                return commands;
            if (name === 'webServer')
                return webServer;
            return undefined;
        },
    };
    return ctx;
};

/* ── 1. 默认配置：压缩管线应开启 ─────────────────────────────────────────── */
const defaults = mod.Config({});
assert.equal(defaults.compactionEnabled, true, '压缩管线应默认开启（/memory-compact 装上即可用）');

const ctx = makeCtx();
mod.apply(ctx, {});
assert.ok(registeredCommand !== null, '/memory-compact 应已注册');
assert.ok(routes.has('/persona-memory/api/state'), 'GET /api/state 应已注册');
assert.ok(routes.has('/persona-memory/api/memory/save'), 'POST /api/memory/save 应已注册');

/** 调一次路由 handler，等待异步写回。 */
async function invoke(path, method, { url, body } = {}) {
    const handler = routes.get(path);
    assert.ok(handler, '缺少路由 ' + path);
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = {
        method,
        url: url ?? path,
        [Symbol.asyncIterator]: async function* iterate() {
            for (const chunk of chunks)
                yield chunk;
        },
    };
    const res = {
        status: 0,
        body: '',
        writeHead(status) { this.status = status; },
        end(payload) { this.body = payload; },
    };
    handler(req, res);
    for (let wait = 0; wait < 200 && res.body === ''; wait += 1)
        await new Promise((done) => setTimeout(done, 5));
    assert.notEqual(res.body, '', '路由 ' + path + ' 没有返回');
    return { status: res.status, json: JSON.parse(res.body) };
}

/* ── 2. 跟随工作区：带 cwd 时 current 指向该工作区 ───────────────────────── */
const alphaPath = resolve(join(wsAlpha, 'MEMORY.md'));
const betaPath = resolve(join(wsBeta, 'MEMORY.md'));
const gammaPath = resolve(join(wsGamma, 'MEMORY.md'));

let res = await invoke('/persona-memory/api/state', 'GET', {
    url: '/persona-memory/api/state?cwd=' + encodeURIComponent(wsAlpha),
});
assert.equal(res.status, 200);
let state = res.json.state;
assert.equal(state.memory.current.path, alphaPath, 'current 应指向 cwd 所在工作区');
assert.equal(state.memory.current.content.trim(), '# MEMORY.md — alpha\n\n1. alpha 的结论'.trim());
assert.ok(state.memory.projects.some((p) => p.path === alphaPath), '项目列表应含 alpha');
assert.ok(state.memory.projects.some((p) => p.path === betaPath), '项目列表应含 beta（注册表来源，本进程没跑过会话）');
assert.ok(state.memory.projects.some((p) => p.path === gammaPath), '项目列表应含 gamma（尚未创建 MEMORY.md）');

// 子目录也应向上找到同一个项目根（与注入侧 findProjectMemory 同规则）
res = await invoke('/persona-memory/api/state', 'GET', {
    url: '/persona-memory/api/state?cwd=' + encodeURIComponent(join(wsAlpha, 'src', 'deep')),
});
assert.equal(res.json.state.memory.current.path, alphaPath, '子目录应向上找到项目根的 MEMORY.md');

// 切到 beta：current 跟着换
res = await invoke('/persona-memory/api/state', 'GET', {
    url: '/persona-memory/api/state?cwd=' + encodeURIComponent(wsBeta),
});
assert.equal(res.json.state.memory.current.path, betaPath, '切换工作区后 current 应换成 beta');

/* ── 3. 不带 cwd：current 为 null（写回包不强制改面板选择） ─────────────── */
res = await invoke('/persona-memory/api/state', 'GET', { url: '/persona-memory/api/state' });
assert.equal(res.json.state.memory.current, null, '没有 cwd 时 current 应为 null');
assert.ok(res.json.state.memory.projects.length >= 3, '不带 cwd 也应列出注册表里的工作区');

/* ── 4. 保存「注册表里、没跑过会话」的工作区项目记忆 ────────────────────── */
res = await invoke('/persona-memory/api/memory/save', 'POST', {
    body: { scope: 'project', path: gammaPath, content: '# MEMORY.md — gamma\n\n1. gamma 的结论\n' },
});
assert.equal(res.status, 200, JSON.stringify(res.json));
assert.equal(readFileSync(gammaPath, 'utf8'), '# MEMORY.md — gamma\n\n1. gamma 的结论\n');
res = await invoke('/persona-memory/api/state', 'GET', {
    url: '/persona-memory/api/state?cwd=' + encodeURIComponent(wsGamma),
});
assert.equal(res.json.state.memory.current.exists, true, '保存后该工作区应显示已创建');

/* ── 5. 默认配置下 /memory-compact 可用 ─────────────────────────────────── */
const run = (rawInput) => registeredCommand.handler({
    rawInput,
    agent: { session: { header: { cwd: wsAlpha } } },
});
const compacted = await run('all dry');
assert.equal(compacted.kind, 'success', JSON.stringify(compacted));
assert.match(compacted.text, /FACT\.md/);
assert.match(compacted.text, /MEMORY\.md/);
assert.match(compacted.text, /alpha 的结论|水位/, 'MEMORY 的 dry 计划应指向当前工作区');

rmSync(home, { recursive: true, force: true });
console.log('panel-workspace: PASS');
