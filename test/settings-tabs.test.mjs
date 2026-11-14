/**
 * 回归测试：设置页「记忆」的横向页签（0.14.0）。
 *
 * 三件事必须同时成立，否则页面会白屏或页签错位：
 *  1. 页签顺序 = 本插件自己的页（注入开关）→ 附属插件整页（`settings.persona-memory.tab`，
 *     角色卡导入导出就是这一页）→ 附属插件声明式设置项的分组（自动召回 / 自动沉淀）；
 *  2. 每个页签下面渲染的是**自己那一份**内容：附属插件的整页用 `renderSlot(..., { only: id })`
 *     取，分组页画的是该组的设置行，不是把全部设置项堆在一页；
 *  3. 「数据未到」与「数据到手」两次渲染调用的 hook 数量必须一致 —— 2026-10-31 那次
 *     白屏事故的成因就是两次渲染 hook 数量不同，slot 错误边界把它吞成空白。
 *
 * 实现方式：客户端半是手写 ModuleLoader 包，没有给测试留导出面，所以这里用桩
 * （React + window.__ModuleLoader__）执行真实源码，再对源码做**两处**可断言的替换，
 * 把 SettingsPage 暴露出来、跳过 fetch。替换没命中就直接失败，避免「源码形状变了
 * 测试却还在绿」。
 *
 * 跑法：node test/settings-tabs.test.mjs
 *      PERSONA_MEMORY_CLIENT_ENTRY=file:///…/lib/client.js node test/settings-tabs.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const defaultPath = fileURLToPath(new URL('../lib/client.js', import.meta.url));
const entry = process.env.PERSONA_MEMORY_CLIENT_ENTRY ?? defaultPath;
const source = readFileSync(entry.startsWith('file:') ? fileURLToPath(entry) : entry, 'utf8');

/* ── 1. 桩：React 只记录 hook 调用次数，createElement 产出可遍历的普通对象 ── */
let hookCalls = [];
const React = {
    createElement(type, props, ...children) {
        return {
            type,
            props: props ?? {},
            children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
        };
    },
    useState(initial) {
        hookCalls.push('useState');
        return [typeof initial === 'function' ? initial() : initial, () => { }];
    },
    useCallback(fn) { hookCalls.push('useCallback'); return fn; },
    useRef(value) { hookCalls.push('useRef'); return { current: value }; },
    useEffect() { hookCalls.push('useEffect'); },
    useMemo(fn) { hookCalls.push('useMemo'); return fn(); },
    useSyncExternalStore(_subscribe, getSnapshot) { hookCalls.push('useSyncExternalStore'); return getSnapshot(); },
};

const rowsBySlot = {
    'settings.persona-memory.tab': [{ id: 'persona-card-io', order: 10, label: '角色卡' }],
    'settings.persona-memory.item': [],
};
const slots = {
    entries(key) { return (rowsBySlot[key] ?? []).map((options) => ({ options })); },
    getVersion(key) { return (rowsBySlot[key] ?? []).length; },
    subscribe() { return () => { }; },
    inject() { return () => { }; },
    register() { return () => { }; },
    registerFactory() { return () => { }; },
};

let exported = null;
const windowStub = {
    __ModuleLoader__: {
        load(spec) {
            exported = spec.factory((name) => {
                if (name === 'react') return React;
                throw new Error('客户端半不应 require 其它模块：' + name);
            });
        },
    },
};

/* ── 2. 两处替换：暴露 SettingsPage、把设置数据灌进初始 state ── */
const EXPOSE = 'globalThis.__SettingsPage = function SettingsPage(props) {';
const beforeExpose = source.includes('function SettingsPage(props) {');
assert.ok(beforeExpose, '源码里找不到 SettingsPage');
const patchedExpose = source.replace('function SettingsPage(props) {', EXPOSE);
assert.ok(patchedExpose.includes(EXPOSE), 'SettingsPage 的暴露替换没有命中');

const PAGE_STATE = "const [data, setData] = React.useState(null)\n      const [note, setNote] = React.useState(null)\n      const [busyKey, setBusyKey] = React.useState('')";
assert.ok(patchedExpose.includes(PAGE_STATE), '设置页的初始 state 三段与预期不同，测试需要同步更新');
const patched = patchedExpose.replace(
    PAGE_STATE,
    "const [data, setData] = React.useState(globalThis.__PREVIEW_SETTINGS ?? null)\n      const [note, setNote] = React.useState(null)\n      const [busyKey, setBusyKey] = React.useState('')",
);
assert.notEqual(patched, patchedExpose, 'state 替换没有命中');

new Function('window', patched)(windowStub);
assert.ok(exported !== null, 'ModuleLoader.load 没有被调用');

/* ── 3. apply：让 slots0 拿到桩（设置页按它读子槽登记） ── */
const fakeCtx = {
    logger: { info() { }, warn() { } },
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => { }; },
    inject() { },
    get(name) { return name === 'slots' ? slots : undefined; },
};
exported.apply(fakeCtx);
assert.equal(typeof globalThis.__SettingsPage, 'function', 'apply 之后应能拿到 SettingsPage');

/* ── 4. 依赖的页面数据 ── */
const settings = {
    path: 'C:/Users/x/.dsh/memory/injection.json',
    injection: { persona: true, globalMemory: true, projectMemory: true },
    overrides: {},
    context: {
        persona: { id: 'fei-yu', name: '蓝色大肥鱼' },
        fact: { exists: true, lines: 85, bytes: 7980, maxLines: 100, maxBytes: 8000 },
        projectCount: 11,
    },
    items: [
        { id: 'recall.enabled', group: '自动召回', title: '每轮自动召回', kind: 'toggle', value: true, order: 10, options: [] },
        { id: 'recall.maxTotalChars', group: '自动召回 · 高级', title: '总字数上限', kind: 'text', value: '4000', order: 60, options: [] },
        { id: 'recall.semanticEnabled', group: '自动召回 · 语义', title: '语义通道', kind: 'toggle', value: true, order: 200, options: [] },
        { id: 'consolidate.mode', group: '自动沉淀', title: '运行档位', kind: 'select', value: 'auto', order: 20, options: [{ value: 'auto', label: '正式写入' }] },
    ],
};

const slotCalls = [];
const renderSlot = (key, owner, opts) => {
    slotCalls.push({ key, only: opts === undefined ? undefined : opts.only });
    return { slot: key, only: opts === undefined ? undefined : opts.only, props: {}, children: [] };
};

/* ── 5. 有数据：页签、分组归并、子槽渲染 ── */
globalThis.__PREVIEW_SETTINGS = settings;
hookCalls = [];
const page = globalThis.__SettingsPage({ renderSlot });
const hooksWithData = hookCalls.length;

/** 收集指定 className 的节点（只认字符串 className，够用）。 */
function collect(node, predicate, out = []) {
    if (node === null || node === undefined || node === false) return out;
    if (Array.isArray(node)) { for (const child of node) collect(child, predicate, out); return out; }
    if (typeof node !== 'object') return out;
    if (predicate(node)) out.push(node);
    for (const child of node.children ?? []) collect(child, predicate, out);
    return out;
}

const textOf = (node) => (node.children ?? []).filter((child) => typeof child === 'string').join('');

const tabButtons = collect(page, (node) => node.props.className === 'dpm-set-tab');
assert.deepEqual(
    tabButtons.map(textOf),
    ['注入开关', '角色卡', '自动召回', '自动沉淀'],
    '页签顺序应为「本插件页 → 附属插件整页 → 声明式设置项分组」',
);
assert.deepEqual(
    tabButtons.map((node) => node.props['aria-selected']),
    ['true', 'false', 'false', 'false'],
    '默认选中第一个页签',
);
assert.equal(tabButtons[0].props.role, 'tab', '页签按钮要有 role=tab');
assert.equal(collect(page, (node) => node.props.className === 'dpm-set-tabs')[0].props.role, 'tablist', '页签容器要有 role=tablist');

/* 每一页都在，只是未选中的 hidden：切回来时草稿与折叠状态还在。 */
const pages = collect(page, (node) => node.props.className === 'dpm-set-page');
assert.equal(pages.length, 4, '应有 4 个页面容器（注入开关 + 角色卡 + 两个分组），实际 ' + pages.length);
assert.deepEqual(
    pages.map((node) => node.props.hidden === true),
    [false, true, true, true],
    '只有当前页可见，其余隐藏但保持挂载',
);

/* 附属插件的整页走 only 过滤，不能把别人那一份也画进来。 */
assert.deepEqual(
    slotCalls,
    [{ key: 'settings.persona-memory.tab', only: 'persona-card-io' }],
    '附属插件整页应按 id 单独渲染，实际：' + JSON.stringify(slotCalls),
);

/* 「自动召回 · 高级 / 语义」归并进「自动召回」一页，而不是各占一个页签。 */
assert.equal(tabButtons.filter((node) => textOf(node) === '自动召回').length, 1, '自动召回应只有一个页签');
assert.equal(tabButtons.filter((node) => textOf(node).startsWith('自动召回 ·')).length, 0, '带「 · 」的子分组不应单独成页');

/* 注入开关页只放三个注入开关，别把设置项也堆进来。
   （SettingsSwitch 是组件，测试里不会真的渲染它，所以按元素类型数。） */
const switches = collect(pages[0], (node) => typeof node.type === 'function' && node.type.name === 'SettingsSwitch');
assert.equal(switches.length, 3, '注入开关页应有 3 个开关，实际 ' + switches.length);

/* ── 6. 无数据（loading 骨架）：hook 数量必须与有数据时一致 ── */
globalThis.__PREVIEW_SETTINGS = null;
hookCalls = [];
globalThis.__SettingsPage({ renderSlot });
const hooksLoading = hookCalls.length;
globalThis.__PREVIEW_SETTINGS = settings;

assert.equal(
    hooksLoading,
    hooksWithData,
    '两次渲染的 hook 数量不一致（' + hooksLoading + ' vs ' + hooksWithData + '）：React 会抛 '
    + '"Rendered more hooks than during the previous render"，被 slot 错误边界吞成空白面板',
);

/* ── 7. 既没有附属插件页、也没有声明式设置项时只剩一个页签，不画页签条 ── */
rowsBySlot['settings.persona-memory.tab'] = [];
globalThis.__PREVIEW_SETTINGS = { ...settings, items: [] };
const soloPage = globalThis.__SettingsPage({ renderSlot });
assert.equal(
    collect(soloPage, (node) => node.props.className === 'dpm-set-tabs').length,
    0,
    '只有一个页签时不该画页签条',
);
globalThis.__PREVIEW_SETTINGS = settings;

console.log('PASS settings-tabs：页签顺序 ' + JSON.stringify(tabButtons.map(textOf))
    + '，hook 数 ' + hooksWithData + '（loading 时同样 ' + hooksLoading + '）');
