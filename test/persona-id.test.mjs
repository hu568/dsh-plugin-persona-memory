/**
 * 回归测试：persona 工具与面板的 id 校验（0.9.0 · P1-9）。
 *
 * 背景：只有 `create`（工具）与 `save`（面板）校验 id 形态；`show` / `use` / `update` /
 * `delete` 只判 `isPersonaDir(join(personasDir(), id))`，而 `delete` 随后对同一路径
 * 做 `rmSync(recursive, force)` —— 模型传 `id = '../x'` 且 `$DSH_HOME/x/persona.yml`
 * 恰好存在时，就会递归删掉角色库之外的目录。一次手滑就够。
 *
 * 本测试钉住：
 *  1. `isPersonaDir()` 内部 resolve 后必须位于 `personasDir()` 之下（双保险）；
 *  2. 工具 show/use/update/delete 传 `'../escape'` / `'..'` 一律抛错，且外面目录原样；
 *  3. 面板 show/use/delete 同样返回 400，且外面目录原样；
 *  4. 正常 id 的路径不受影响（不误伤：show 存在角色、delete 非当前角色照常工作）。
 *
 * 跑法：node test/persona-id.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-personaid-'));
process.env.DSH_HOME = home;

const personaStore = await import('../lib/persona-store.js');
const tools = await import('../lib/tools.js');
const panel = await import('../lib/panel.js');

const personasDir = join(home, 'personas');
for (const id of ['default', 'other']) {
    mkdirSync(join(personasDir, id), { recursive: true });
    writeFileSync(join(personasDir, id, 'persona.yml'), `name: ${id}\n`, 'utf8');
    writeFileSync(join(personasDir, id, 'SOUL.md'), `# SOUL — ${id}\n`, 'utf8');
    writeFileSync(join(personasDir, id, 'USER.md'), '# USER\n', 'utf8');
}
writeFileSync(join(personasDir, '.active'), 'default\n', 'utf8');
/* 角色库之外的目录，且同样带 persona.yml（旧实现会认成角色）。 */
const escapeDir = join(home, 'escape');
mkdirSync(escapeDir, { recursive: true });
writeFileSync(join(escapeDir, 'persona.yml'), 'name: escape\n', 'utf8');

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

/* ── 面板假路由：把 register() 的 handler 收起来，按 HTTP 形状调用 ── */
const routes = new Map();
const webServer = {
    register(spec) {
        routes.set(spec.path, spec.handler);
        return () => { };
    },
};
const ctx = {
    effect(fn) {
        const dispose = fn();
        return typeof dispose === 'function' ? dispose : () => { };
    },
    on() { },
    get() { return undefined; },
};
const runtime = {
    snapshots: new Map(),
    cwdBySession: new Map(),
    projectBySession: new Map(),
    injection: {},
};
panel.registerPanelRoutes(webServer, {
    panelPath: '/persona-memory',
    maxFactLines: 100,
    maxFactBytes: 8000,
    maxChars: 8000,
    maxProjectChars: 8000,
    compactionEnabled: false,
    personaEnabled: true,
    memoryEnabled: true,
}, runtime, ctx, { list: () => [] });

function invoke(path, method, body) {
    return new Promise((resolve, reject) => {
        const handler = routes.get(path);
        if (handler === undefined) {
            reject(new Error(`路由未注册：${path}`));
            return;
        }
        const req = {
            method,
            url: path,
            async *[Symbol.asyncIterator]() {
                if (body !== undefined)
                    yield Buffer.from(JSON.stringify(body));
            },
        };
        const res = {
            status: 0,
            writeHead(status) { this.status = status; },
            end(text) {
                try {
                    resolve({ status: this.status, json: JSON.parse(String(text)) });
                }
                catch (error) {
                    reject(error);
                }
            },
        };
        handler(req, res);
    });
}

await check('isPersonaDir：必须位于 personasDir 之下（resolve 后判前缀）', () => {
    assert.equal(personaStore.isPersonaDir(join(personasDir, 'default')), true, '正常角色应认得');
    assert.equal(personaStore.isPersonaDir(join(personasDir, '..', 'escape')), false, '角色库之外的目录不得认成角色');
    assert.equal(personaStore.isPersonaDir(personasDir), false, '角色库根目录本身不是角色');
    assert.equal(personaStore.isPersonaDir(join(escapeDir, 'persona.yml')), false);
});

await check('工具 show/use/update/delete：非法 id 一律拒绝，且外面目录原样', async () => {
    const tool = tools.personaTool();
    for (const action of ['show', 'use', 'update', 'delete']) {
        for (const id of ['../escape', '..', '../escape/persona.yml']) {
            await assert.rejects(
                () => tool.execute({ action, id }),
                (error) => {
                    assert.match(error.message, /只能是小写字母/, `${action} + ${id} 应被 id 校验拦下`);
                    return true;
                },
                `${action} 传 ${id} 必须拒绝`,
            );
        }
    }
    assert.ok(existsSync(join(escapeDir, 'persona.yml')), '角色库之外的目录一个字节都不能动');
    assert.ok(existsSync(join(personasDir, 'default', 'persona.yml')), '正常角色也必须还在');
});

await check('工具：normal id 不受影响（show 存在角色 / delete 非当前角色）', async () => {
    const tool = tools.personaTool();
    const shown = await tool.execute({ action: 'show', id: 'other' });
    assert.match(shown.text, /角色 other/);
    const removed = await tool.execute({ action: 'delete', id: 'other' });
    assert.match(removed.text, /已删除角色 other/);
    assert.equal(existsSync(join(personasDir, 'other')), false);
    await assert.rejects(() => tool.execute({ action: 'show', id: 'other' }), /角色不存在/);
    await assert.rejects(() => tool.execute({ action: 'delete', id: 'default' }), /正在使用中/);
});

await check('面板 show/use/delete：非法 id 返回 400，且外面目录原样', async () => {
    for (const route of ['show', 'use', 'delete']) {
        const res = await invoke(`/persona-memory/api/persona/${route}`, 'POST', { id: '../escape' });
        assert.equal(res.status, 400, `${route} 应返回 400：${JSON.stringify(res.json)}`);
        assert.match(res.json.error, /只能是小写字母/);
    }
    assert.ok(existsSync(join(escapeDir, 'persona.yml')), '面板被拦下后目录必须原样');
    assert.ok(existsSync(join(personasDir, 'default', 'persona.yml')));
});

await check('面板：合法 id 但角色不存在 ⇒ 角色不存在（不误报 id 非法）', async () => {
    const res = await invoke('/persona-memory/api/persona/show', 'POST', { id: 'nope' });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /角色不存在/);
});

rmSync(home, { recursive: true, force: true });
if (failures.length > 0) {
    console.log(`\n✗ persona-id: ${failures.length} 项失败 / 共 ${checks} 项：${failures.join('、')}`);
    process.exit(1);
}
console.log(`\n✓ persona-id: ${checks} 项全部通过`);
