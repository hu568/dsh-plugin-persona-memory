/**
 * 回归测试：右侧栏面板的 hook 顺序（0.13.4）。
 *
 * 事故（0.13.2 → 0.13.3）：MEMORY_OVERWRITE_LOSSY 的「确认后重试」把 saveMemory
 * 写成了 React.useCallback，并放在 Pane 的
 *     if (data === null) { return h(...) }
 * 提前返回**之后**。首次渲染走提前返回、一个 hook 都不多调；第二次渲染（data 到手）
 * 多调一个 hook，React 抛
 *     Rendered more hooks than during the previous render
 * slot 层的错误边界把它吞成 <div data-slot-error="sidebar.right.pane.tab"></div>，
 * 于是标签页在、内容是空白，控制台之外看不出任何线索。
 *
 * 这个测试不需要 DOM：直接读客户端半源码，证明 Pane 里**没有**任何 hook 写在
 * 提前返回之后。测试绿 = 面板第二次渲染的 hook 数量与第一次一致。
 *
 * 跑法：node test/client-hook-order.test.mjs
 *      PERSONA_MEMORY_CLIENT_ENTRY=file:///…/lib/client.js node test/client-hook-order.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const defaultPath = fileURLToPath(new URL('../lib/client.js', import.meta.url));
const entry = process.env.PERSONA_MEMORY_CLIENT_ENTRY ?? defaultPath;
const source = readFileSync(entry.startsWith('file:') ? fileURLToPath(entry) : entry, 'utf8');
const lines = source.split('\n');

/** 找顶层组件函数（缩进 4 空格的 function Name(）的起始行下标。 */
function componentStart(name) {
    const index = lines.findIndex((line) => new RegExp('^    function ' + name + '\\s*\\(').test(line));
    assert.notEqual(index, -1, '源码里找不到组件 ' + name);
    return index;
}

/** 从函数起始行起按花括号配平，返回函数体结束行下标。 */
function componentEnd(start) {
    let depth = 0;
    let opened = false;
    for (let i = start; i < lines.length; i += 1) {
        for (const ch of lines[i]) {
            if (ch === '{') { depth += 1; opened = true; } else if (ch === '}') depth -= 1;
        }
        if (opened && depth === 0) return i;
    }
    assert.fail('函数花括号没有配平');
}

const start = componentStart('Pane');
const end = componentEnd(start);

/* ── 1. 找到「data === null 就提前 return」的位置 ── */
const early = lines.findIndex((line, i) => i >= start && i <= end && /^\s+if \(data === null\) \{/.test(line));
assert.notEqual(early, -1, 'Pane 里找不到「data === null」的提前返回分支');
assert.ok(early > start && early < end, '提前返回分支必须落在 Pane 体内');

/* ── 2. 该分支之后不允许再出现任何 hook 调用 ── */
const hookPattern = /React\.use[A-Z][A-Za-z0-9_]*\s*\(/;
const offenders = [];
for (let i = early + 1; i <= end; i += 1) {
    if (hookPattern.test(lines[i])) offenders.push((i + 1) + ': ' + lines[i].trim());
}
assert.deepEqual(
    offenders,
    [],
    'Pane 在提前返回之后又调了 hook，第二次渲染的 hook 数量会不一致（面板会变成空白）：\n  '
    + offenders.join('\n  '),
);

/* ── 3. saveMemory 必须是普通函数（不是 React.useCallback / useMemo） ── */
const saveMemoryLine = lines.findIndex((line, i) => i >= start && i <= end && /saveMemory/.test(line)
    && /(function saveMemory|const saveMemory)/.test(line));
assert.notEqual(saveMemoryLine, -1, 'Pane 里找不到 saveMemory 的定义');
assert.doesNotMatch(
    lines[saveMemoryLine],
    /React\.use/,
    'saveMemory 不能定义成 hook：它位于 Pane 的提前返回之后，会让两次渲染的 hook 数量不一致',
);

/* ── 4. 提前返回之前至少还应该有 hook（防止「顺手把 hooks 全删了」也算绿） ── */
let hooksBefore = 0;
for (let i = start; i < early; i += 1) if (hookPattern.test(lines[i])) hooksBefore += 1;
assert.ok(hooksBefore >= 10, 'Pane 的 hook 数量明显变少（' + hooksBefore + '），检查是否被误删');

console.log('PASS client-hook-order：Pane 的 ' + hooksBefore + ' 个 hook 全部在提前返回之前，saveMemory 不是 hook');
