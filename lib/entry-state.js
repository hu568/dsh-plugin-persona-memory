/**
 * 条目生命周期状态（`DESIGN-memory-lifecycle.md` §1）：状态**内联在条目行尾**的 HTML 注释里。
 *
 * ```markdown
 * - 结论正文 <!-- memory-state: status=superseded by=1a2b3c4d5e since=2026-11-09 -->
 * 1. 结论正文 <!-- memory-state: status=archived since=2026-11-09 -->
 * ```
 *
 * 为什么内联而不是单独一行：FACT.md 只有 100 行硬预算（`maxFactLines`），
 * 「一条结论 + 一行状态」等于把一半预算花在元数据上；而 HTML 注释在 Markdown 渲染里
 * 不可见，也不额外占行。老文件没有注释 ⇒ 天然是 `active`，**零迁移**。
 *
 * 三条纪律（与 consolidate 的 `gate.js` 同款）：
 *  1. **只读不改写**：`parseEntryState` 是纯函数，认不出来一律当 `active`，
 *     绝不平整原文 —— 解析层顺手「修一下格式」是第二处会腐烂的实现；
 *  2. **认格式不认意图**：只有注释完整、在行尾、全行只有一个、`status` 取值合法时才认；
 *     残缺 / 拼错 / 重复 / 正文里出现类似字符串 ⇒ 一律 `active`（宁可不失效，也不误失效）。
 *     误判成 active 的代价是「多注入一条过时结论」，误判成 superseded 的代价是
 *     「一条真结论永远不进提示词」，两者不对称；
 *  3. **正文永远是纯正文**：`text` 不含注释 ⇒ 条目 id（`entryId(ts, text)`）在加注释后
 *     不变，索引里的元数据、`by` 引用、`restoreEntry` 的定位全部继续成立。
 *
 * 本模块**纯函数、零 IO、零依赖**：recall / consolidate 可以按契约复制同样的语义，
 * 但不 import 这里的实现（跨包运行时零依赖）。
 */

/** 正常注入 / 召回 / 可被压缩。 */
export const STATE_ACTIVE = 'active';
/** 被新结论取代：不注入、不召回、优先被压缩淘汰，但文件里保留原文。 */
export const STATE_SUPERSEDED = 'superseded';
/** 主动归档：语义同上，区别只是「不是被取代，是人为收起来」。 */
export const STATE_ARCHIVED = 'archived';

const STATUSES = new Set([STATE_ACTIVE, STATE_SUPERSEDED, STATE_ARCHIVED]);
/** 状态注释的开头（HTML 注释，渲染不可见）。 */
const MARKER_PREFIX = '<!-- memory-state:';
/** 条目行的两种形状：编号行（任意缩进）与顶层 `- ` 列表项（与 store 的条目切分同口径）。 */
const NUMBERED_LINE = /^(\s*)(\d+)\.\s+(.+)$/;
const BULLET_LINE = /^-\s+(.+)$/;
/** 「## 速查」区的列表项是参考数据，不算条目（与 store.memoryEntries() 同口径）。 */
const QUICK_SECTION_PREFIX = '速查';

function trimEnd(text) {
    return String(text ?? '').replace(/\s+$/, '');
}

function activeState() {
    return { status: STATE_ACTIVE, by: '', since: '' };
}

/** 非 active 即「休眠」：不注入、优先淘汰。 */
export function isDormantState(state) {
    const status = typeof state === 'string' ? state : state?.status;
    return status === STATE_SUPERSEDED || status === STATE_ARCHIVED;
}

/**
 * 一行是不是条目行：`'numbered' | 'bullet' | null`。
 *
 * 与 `store.factEntries()` / `store.memoryEntries()` 的切分同口径：编号行任意缩进都算
 * （模板里子结论也可以编号），`- ` 只认**顶层**（缩进的 `- ` 是上层条目的子项）。
 * 这个判定只用于 `stripSuperseded()` / `countEntryStates()` —— 那两处拿不到 scope。
 */
export function entryLineKind(line) {
    const raw = typeof line === 'string' ? line : '';
    if (NUMBERED_LINE.test(raw))
        return 'numbered';
    if (BULLET_LINE.test(raw))
        return 'bullet';
    return null;
}

/**
 * 把注释体（`status=… by=… since=…`）解析成状态对象；**认不出来返回 null**。
 *
 * 字段分隔只用空白：值里带空格本来就不合法，多认一种写法就多一处会分叉的实现。
 * `status` 决定「认不认这条注释」；`by` / `since` 只做形状校验，坏了就置空 ——
 * 一个写错的日期不该让整条结论重新开始注入。
 */
function parseFields(body) {
    const fields = {};
    for (const token of String(body ?? '').split(/\s+/)) {
        if (token === '')
            continue;
        const at = token.indexOf('=');
        // 不是 key=value 的碎片直接忽略（模型手写注释时经常多打逗号/句号）
        if (at <= 0)
            continue;
        fields[token.slice(0, at).trim().toLowerCase()] = token.slice(at + 1).trim();
    }
    const status = String(fields.status ?? '').toLowerCase();
    if (!STATUSES.has(status))
        return null;
    const by = /^[A-Za-z0-9_-]{1,64}$/.test(fields.by ?? '') ? fields.by : '';
    const since = /^\d{4}-\d{2}-\d{2}$/.test(fields.since ?? '') ? fields.since : '';
    return { status, by, since };
}

/**
 * 解析一行（或一条正文）：`{ text, state }`，`text` 是**剥离注释后的纯正文**。
 *
 * 容错口径见文件头第 2 条：以下都按 `active` 处理，且 `text` 里**保留**那段文本
 * （解析层不猜、不改写）：
 *  - 注释残缺（没有 `-->`）；
 *  - `status` 缺失或拼错；
 *  - 同一行出现多份状态注释；
 *  - 注释后面还有别的正文（不在行尾）。
 *
 * 尾随空白会去掉（条目正文不该带尾空格），行首缩进**原样保留** —— 调用方拿到的
 * 是全行时，缩进信息不能丢。
 */
export function parseEntryState(line) {
    const raw = typeof line === 'string' ? line : String(line ?? '');
    // 每次新建正则：`lastIndex` 是全局正则的状态，复用会让「同一行解析两次」结果不同
    const matches = [...raw.matchAll(/<!--\s*memory-state:([\s\S]*?)-->/g)];
    if (matches.length !== 1)
        return { text: trimEnd(raw), state: activeState() };
    const match = matches[0];
    const state = parseFields(match[1]);
    if (state === null)
        return { text: trimEnd(raw), state: activeState() };
    const start = match.index ?? 0;
    // 注释必须在行尾：`正文 <!-- memory-state: … --> 后面还有话` 是误用，不认
    if (raw.slice(start + match[0].length).trim() !== '')
        return { text: trimEnd(raw), state: activeState() };
    return { text: trimEnd(raw.slice(0, start)), state };
}

/** 把状态里的字段清洗成可安全内联进 HTML 注释的值。 */
function cleanValue(value) {
    return String(value ?? '').replace(/\s+/g, '').replace(/-->/g, '').replace(/--/g, '-');
}

/**
 * 给一行追加/替换行尾状态注释，返回新行（**不动缩进与列表标记**）。
 *
 * - `status=active` ⇒ 摘掉注释（`restoreEntry` 走这里）；
 * - 其他状态 ⇒ 先摘掉行尾已有的状态注释（含残缺、重复的那几份）再追加一份 ——
 *   「替换而不是追加」是契约硬要求：追加出两份注释，下一次解析就会判成 active，
 *   等于「按了失效，条目却满血复活」。
 */
export function applyEntryState(line, state) {
    const raw = typeof line === 'string' ? line : String(line ?? '');
    const status = String(state?.status ?? '').trim().toLowerCase();
    const wanted = STATUSES.has(status) ? status : STATE_ACTIVE;
    let body = raw;
    let removed = false;
    // 行尾可能有多份（人工手抄、旧版本累积）：循环摘到没有为止。
    // 两种形状分开处理，都要求**贴到行尾**：
    //  - 完整注释：随便里面写了什么，只要 `-->` 在末尾；
    //  - 残缺注释（没有 `-->`）：只在「后面再没有 `-->`」时才算 —— 否则
    //    `正文 <!-- memory-state: … --> 尾巴` 这种误用会被整段吃掉，等于悄悄删正文。
    for (;;) {
        const next = body
            .replace(/\s*<!--\s*memory-state:[\s\S]*?-->\s*$/, '')
            .replace(/\s*<!--\s*memory-state:(?:(?!-->)[\s\S])*$/, '');
        if (next === body)
            break;
        body = next;
        removed = true;
    }
    if (wanted === STATE_ACTIVE)
        return removed ? trimEnd(body) : raw;
    body = trimEnd(body);
    const parts = [`status=${wanted}`];
    const by = cleanValue(state?.by);
    if (by !== '')
        parts.push(`by=${by}`);
    const since = cleanValue(state?.since);
    if (since !== '')
        parts.push(`since=${since}`);
    return `${body} ${MARKER_PREFIX} ${parts.join(' ')} -->`;
}

/** `since` / `by` 的日期口径：`YYYY-MM-DD`（本地时区）。非法值 ⇒ 今天。 */
export function formatStateDate(value) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()))
        return value.trim();
    const at = value instanceof Date
        ? value
        : (typeof value === 'number' && Number.isFinite(value) ? new Date(value) : new Date());
    const date = Number.isNaN(at.getTime()) ? new Date() : at;
    const pad = (number) => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 从整份文档剔除非 active 条目（渲染层用）：保留标题、空行、`## 速查` 里的参考数据。
 *
 * 为什么渲染层要过滤而不是写盘时删除：`DESIGN-memory-lifecycle.md` §0 的目标是
 * 「失效不删除」—— 文件即真源，随时可审计、可 `restoreEntry` 恢复。注入是唯一
 * 需要「干净视图」的地方，所以过滤只发生在渲染。
 *
 * 编号条目连带它下面更深缩进的子项一起去掉（`entrySpan` 同口径）：只删首行会在
 * 注入里留下一串没有归属的缩进子项。
 *
 * **幂等**：输出再跑一遍结果不变（过滤只做减法，且不改写保留的行）。
 */
export function stripSuperseded(raw) {
    const text = String(raw ?? '');
    if (text === '')
        return '';
    // 与 store.splitLines() 同口径归一化换行；LF 文件逐字节等价
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const kept = [];
    let reference = false;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const heading = /^##\s+(.+?)\s*$/.exec(line);
        if (heading !== null) {
            reference = heading[1].replace(/^#+\s*/, '').trim().toLowerCase().startsWith(QUICK_SECTION_PREFIX);
            kept.push(line);
            continue;
        }
        // 速查区是参考数据（命令 / 路径），不是结论条目：不带状态语义，原样保留
        if (reference) {
            kept.push(line);
            continue;
        }
        const kind = entryLineKind(line);
        if (kind === null) {
            kept.push(line);
            continue;
        }
        const { state } = parseEntryState(line);
        if (!isDormantState(state)) {
            kept.push(line);
            continue;
        }
        // 编号条目的缩进子项属于这条结论：一起跳过（空行 / 下一条 / 更深缩进才停）
        if (kind === 'numbered') {
            for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
                const current = lines[cursor];
                if (current.trim() === '')
                    break;
                if (/^\s*\d+\.\s/.test(current))
                    break;
                if (/^-\s+/.test(current))
                    break;
                if (!/^\s+/.test(current))
                    break;
                index = cursor;
            }
        }
    }
    return kept.join('\n');
}

/**
 * 统计条目状态：`{ total, active, superseded, archived }`。
 *
 * 只数条目行（标题 / 空行 / 速查项 / 子项都不算）；认不出来的注释算 `active`，
 * 与 `parseEntryState()` 的口径一致 —— 面板上「失效 3 条」不会因为一行手抄错就对不上。
 */
export function countEntryStates(raw) {
    const counts = { total: 0, active: 0, superseded: 0, archived: 0 };
    const text = String(raw ?? '');
    if (text === '')
        return counts;
    let reference = false;
    for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
        const heading = /^##\s+(.+?)\s*$/.exec(line);
        if (heading !== null) {
            reference = heading[1].replace(/^#+\s*/, '').trim().toLowerCase().startsWith(QUICK_SECTION_PREFIX);
            continue;
        }
        if (reference)
            continue;
        if (entryLineKind(line) === null)
            continue;
        const { state } = parseEntryState(line);
        counts.total += 1;
        counts[state.status] += 1;
    }
    return counts;
}
