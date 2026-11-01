/**
 * @dsh-external/dsh-persona-memory — 存储层（storage layer），与附属插件共享：
 * 只依赖 node 内置模块，不引任何第三方依赖、不读 config，import 即可读写同一套记忆文件。
 * 本文件内容是从 lib/index.js 原样搬出的，逻辑一行未改。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
const FACT_FILE = 'FACT.md';
const JOURNAL_FILE = 'JOURNAL.jsonl';
const PROJECT_MEMORY_FILE = 'MEMORY.md';
/** 日志检索时扫的最大行数（只影响 search/read，不进提示词）。 */
const DEFAULT_JOURNAL_LIMIT = 2000;
/** 侧车索引（per-entry 元数据，见 01 §3.4.1）。 */
const INDEX_FILE = 'index.json';
/** JOURNAL 失效归档（只供人工审计，不进任何检索）。 */
const JOURNAL_ARCHIVE_FILE = 'JOURNAL.archive.jsonl';
/** 写入前的备份目录（`$DSH_HOME/memory/backups`）。 */
const BACKUP_DIR = 'backups';
/** 默认写锁等待上限（毫秒）。 */
const DEFAULT_LOCK_TIMEOUT = 5000;
/** 脱敏占位符（与 02 §4.3 一致，全项目只此一种）。 */
const REDACTED = '⟨redacted⟩';
/** 全局 FACT.md 的默认硬上限（行 / 字节）。 */
const DEFAULT_MAX_FACT_LINES = 100;
const DEFAULT_MAX_FACT_BYTES = 8000;
/** 项目 MEMORY.md 的默认字符硬上限（与注入侧 maxChars 同口径）。 */
const DEFAULT_MAX_PROJECT_CHARS = 8000;
/** FACT 条目里禁止出现的原因词（01 §3.1 / §3.3）。 */
const REASON_WORDS = ['因为', '由于', '为了', '所以', '原因是', '理由', '考虑到', '之所以'];
/* ────────────────────────────── 路径与文件 ────────────────────────────── */
function dshHome() {
    return process.env.DSH_HOME || join(homedir(), '.dsh');
}
function memoryDir() {
    return join(dshHome(), 'memory');
}
function factPath() {
    return join(memoryDir(), FACT_FILE);
}
function journalPath() {
    return join(memoryDir(), JOURNAL_FILE);
}
/** 侧车索引路径：`$DSH_HOME/memory/index.json`。 */
function indexPath() {
    return join(memoryDir(), INDEX_FILE);
}
/** JOURNAL 归档路径：`$DSH_HOME/memory/JOURNAL.archive.jsonl`。 */
function journalArchivePath() {
    return join(memoryDir(), JOURNAL_ARCHIVE_FILE);
}
/** 备份目录：`$DSH_HOME/memory/backups`。 */
function backupsDir() {
    return join(memoryDir(), BACKUP_DIR);
}
/* ──────────────────────────── 上限与错误码 ──────────────────────────── */
/**
 * 生效上限。默认值 = 模块常量（与宿主配置默认值一致），`apply()` 用运行配置覆盖一次。
 *
 * 附属插件拿不到宿主配置，所以它只能读这里 —— `configureStore()` 是唯一入口。
 */
let storeLimits = {
    maxFactLines: DEFAULT_MAX_FACT_LINES,
    maxFactBytes: DEFAULT_MAX_FACT_BYTES,
    maxProjectChars: DEFAULT_MAX_PROJECT_CHARS,
};
/* ─────────────── 压缩管线接线（0.8.0 · P4；默认开启，关闭 ⇒ 写路径逐字节不变） ─────────────── */
/**
 * 注入的压缩器：`(scope, {cwd, trigger}) => Promise<result>`。
 *
 * 用**注入**而不是在 store 里直接 import 压缩模块：compaction.js 要 import 本文件的
 * 锁 / 水位 / 原子写，反向依赖就成环。`index.js` 是唯一接线处。
 */
let compactorFn = null;
/** 总开关：默认 false（由 `configureStore()` 按插件配置覆盖）。关闭时 `insertEntry` / `replaceEntry` 一次 I/O 都不多做。 */
let compactionGate = false;
/** 触发水位（与 `lib/compaction.js` 的 TRIGGER_RATIO 同口径，这里只用到这一个数）。 */
const COMPACTION_TRIGGER = 0.85;
/** 注入压缩器；传非函数即解除。返回是否已挂上。 */
function configureCompactor(fn) {
    compactorFn = typeof fn === 'function' ? fn : null;
    return compactorFn !== null;
}
/** 当前是否启用压缩（面板/命令读它，避免各自再翻一遍配置）。 */
function compactionEnabled() {
    return compactionGate === true && compactorFn !== null;
}
/**
 * 水位比例：`max(各维度 / 各自上限)`，与 `compaction.ratioOf()` 同口径。
 *
 * 这里重写 4 行而不是 import：store 是被 compaction 依赖的一方，反向 import 会成环。
 */
function watermarkRatio(view) {
    const limit = view?.limit ?? {};
    const ratios = [];
    if (Number.isFinite(limit.bytes) && limit.bytes > 0)
        ratios.push((view.bytes ?? 0) / limit.bytes);
    if (Number.isFinite(limit.lines) && limit.lines > 0)
        ratios.push((view.lines ?? 0) / limit.lines);
    if (Number.isFinite(limit.chars) && limit.chars > 0)
        ratios.push((view.chars ?? 0) / limit.chars);
    return ratios.length === 0 ? 0 : Math.max(...ratios);
}
/**
 * 写前敲门：水位 ≥ 85% 才叫压缩器，压缩完由调用方重新读盘再卡闸口。
 *
 * ⚠️ 必须在**取写锁之前**调用：压缩器自己会 `acquireWriteLock()`（进程内 mutex
 * 不可重入），持锁调它会自锁 5 秒后抛 `MEMORY_LOCK_TIMEOUT`。压缩器写完后，
 * `insertEntry` 进锁重读文件，闸口见到的就是压缩后的内容 —— 「压缩完再写」的语义不变。
 *
 * 任何异常都吞掉：压缩是写入的**加成**，绝不能让它把一次正常写变成失败。
 */
async function compactBeforeWrite(scope, cwd) {
    if (compactionGate !== true || compactorFn === null)
        return null;
    try {
        const view = watermark(scope, { cwd });
        if (view.path === null || watermarkRatio(view) < COMPACTION_TRIGGER)
            return null;
        return await compactorFn(scope, { cwd, trigger: 'insert' });
    }
    catch {
        return null;
    }
}
/** 覆盖上限；缺省/非法键回落到默认值。返回生效后的上限。 */
function configureStore(next) {
    const source = next ?? {};
    const pick = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.trunc(value) : fallback);
    storeLimits = {
        maxFactLines: pick(source.maxFactLines, DEFAULT_MAX_FACT_LINES),
        maxFactBytes: pick(source.maxFactBytes, DEFAULT_MAX_FACT_BYTES),
        maxProjectChars: pick(source.maxProjectChars, DEFAULT_MAX_PROJECT_CHARS),
    };
    // 压缩管线的两个接线位（0.8.0）。不传 ⇒ 保持上一次状态，便于 `apply()` 之外的调用方单独设。
    if (typeof source.compactionEnabled === 'boolean')
        compactionGate = source.compactionEnabled;
    if (typeof source.compact === 'function')
        configureCompactor(source.compact);
    return { ...storeLimits };
}
/** 当前生效上限的快照（只读副本，改它不影响模块状态）。 */
function limits() {
    return { ...storeLimits };
}
const BUDGET_ERROR_CODE = 'MEMORY_BUDGET_EXCEEDED';
/**
 * 超限错误：**只加 `code` 与 `details`，message 一字不改** —— 现有测试断言了文案。
 *
 * `details` = `{scope, lines, bytes, chars, limit}`：
 * `lines/bytes/chars` 是本次内容的实际值，`limit` 是该作用域的上限（fact 是
 * `{lines, bytes}`，memory 是 `{chars}`）。
 */
function budgetError(message, details) {
    const error = new Error(message);
    error.code = BUDGET_ERROR_CODE;
    error.details = details;
    return error;
}
/** 判断一个错误是不是「超限」（附属插件靠它决定降级还是重试）。 */
function isBudgetError(error) {
    return error !== null && typeof error === 'object' && error.code === BUDGET_ERROR_CODE;
}
function readText(file) {
    try {
        return readFileSync(file, 'utf8');
    }
    catch {
        return null;
    }
}
function ensureDir(dir) {
    try {
        mkdirSync(dir, { recursive: true });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Windows 上 rename 偶发 EPERM/EBUSY（杀毒/索引器短暂占句柄）。原子写依赖 rename，
 * 所以对可恢复错误做有限次同步重试；其它错误照常上抛。
 */
function renameWithRetry(from, to) {
    const delays = [2, 5, 10, 20, 50];
    for (let attempt = 0; ; attempt += 1) {
        try {
            renameSync(from, to);
            return;
        }
        catch (error) {
            if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt >= delays.length)
                throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt]);
        }
    }
}
/** 原子覆盖写：临时文件 + rename，避免半截文件被读到。 */
function writeAtomic(file, text) {
    ensureDir(dirname(file));
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, text, 'utf8');
    renameWithRetry(tmp, file);
}
/** 统计行数：末尾换行不算额外一行（`"a\nb\n"` → 2，`""` → 0）。 */
function countLines(text) {
    if (text === '')
        return 0;
    const normalized = text.replace(/\r\n/g, '\n');
    return (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n').length;
}
/** 归一化换行后按 UTF-8 计字节（与 `countLines()` 同口径，不把 `\r` 也算进去）。 */
function countBytes(text) {
    return Buffer.byteLength(text.replace(/\r\n/g, '\n'), 'utf8');
}
/**
 * 字符数：**与注入侧 `clip()` 逐字同口径** —— `trim()` 后的 JS 字符串长度（UTF-16 码元），
 * **不做 `\r\n` 归一化**。
 *
 * 为什么这里不像 `countBytes()` 那样归一化：本闸口存在的唯一理由是「通过闸口 ⇒
 * 注入侧不会静默截断」，而 `clip()` 比较的是 `text.trim().length > maxChars`。
 * 若按归一化后的长度计，一个 CRLF 文件会少算「每行 1 个 `\r`」⇒ 可能出现
 * 「写入通过了闸口，注入时照样被截断」——闸口就白加了。所以这里宁可更保守，
 * 与 `clip()` 用同一个表达式。
 */
function countChars(text) {
    return text.trim().length;
}
/**
 * 内容修订号：`sha256(文件正文原文)` 前 16 位十六进制。
 *
 * 为什么用「整篇正文的哈希」而不是递增计数器：写路径有四条（memory 工具、面板保存、
 * 压缩管线、条目级 insert/replace/delete），共用同一个文件。计数器要么要求每个写者
 * 都「读计数器 → 加一 → 写回」——那本身就是一场竞态；要么得额外落盘一个状态文件并
 * 处理它与正文不一致。哈希没有状态：谁最后写了，谁的哈希就是当前值，比对不需要
 * 任何额外文件（代价是每次写多算一次哈希，对本机几十 KB 的正文可以忽略）。
 *
 * 口径：**不做换行归一化、不 trim** —— 必须与 `readText()` 读回来的正文逐字节可比，
 * 否则带 CRLF 的文件会每次都比对失败。
 */
function contentRevision(text) {
    return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
}
/**
 * 全局 FACT.md 的硬闸口（写入前调用）：**行数与字节数双闸口**，任一超限即拒写。
 *
 * 为什么**抛错**而不是截断：`update` 是整篇覆盖语义，静默截断等于悄悄丢用户内容。
 * 报错文案要把「该往哪写」说清楚，否则模型只会反复重试精简、或者干脆放弃记录。
 */
function assertFactWithinLimit(content, maxLines = storeLimits.maxFactLines, maxBytes = storeLimits.maxFactBytes) {
    const lines = countLines(content);
    const bytes = countBytes(content);
    const overLines = lines > maxLines;
    const overBytes = bytes > maxBytes;
    if (!overLines && !overBytes)
        return;
    const problems = [];
    if (overLines)
        problems.push(`${lines} 行（超出 ${lines - maxLines} 行，上限 ${maxLines} 行）`);
    if (overBytes)
        problems.push(`${bytes} 字节（超出 ${bytes - maxBytes} 字节，上限 ${maxBytes} 字节）`);
    throw budgetError([
        `全局记忆 FACT.md 有硬上限 ${maxLines} 行 / ${maxBytes} 字节，本次 content 是 ${problems.join('，并且是 ')}，已拒绝写入。`,
        `- 全局 FACT.md 只放「跨会话、跨项目都成立」的事实：请先精简到 ${maxLines} 行且 ${maxBytes} 字节以内再写。`,
        `- 项目专属内容（某个工作区的约定、清单、踩坑、机制探索结论）请改用 action=update, scope=project，写当前项目根的 MEMORY.md。`,
        `- 一次性事件/会话笔记请用 action=append 写 JOURNAL.jsonl。`,
    ].join('\n'), {
        scope: 'fact',
        lines,
        bytes,
        chars: countChars(content),
        limit: { lines: maxLines, bytes: maxBytes },
    });
}
/**
 * 项目 MEMORY.md 的硬闸口（写入前调用）：只卡字符数，口径与注入侧 `maxChars` 对齐。
 *
 * 注入侧超限会**静默截断**，所以写入侧必须提前拦住 —— 否则文件里会有一大段
 * 内容模型永远看不到，而写入时毫无警示。
 */
function assertProjectMemoryWithinLimit(content, maxChars = storeLimits.maxProjectChars) {
    const chars = countChars(content);
    if (chars <= maxChars)
        return;
    throw budgetError([
        `项目记忆 MEMORY.md 有硬上限 ${maxChars} 字符（注入侧的 maxChars 同口径），本次 content 是 ${chars} 字符（超出 ${chars - maxChars} 字符），已拒绝写入。`,
        `- 超限的部分**不会**进提示词：注入侧会静默截断，等于悄悄丢内容，所以这里直接拒写。`,
        `- 请先精简到 ${maxChars} 字符以内再写；一次性事件/会话笔记请改用 action=append 写 JOURNAL.jsonl（它不注入、无上限）。`,
        `- 换到别的工作区就成立的事实，请改用 action=update, scope=global 写全局 FACT.md。`,
    ].join('\n'), {
        scope: 'memory',
        lines: countLines(content),
        bytes: countBytes(content),
        chars,
        limit: { chars: maxChars },
    });
}
/**
 * 从会话 cwd 向上找项目根：先命中 MEMORY.md 的目录即项目根；
 * 若先遇到 `.git` 或 home 目录则认为项目根没有记忆文件（返回 null，不注入）。
 */
function findProjectMemory(cwd) {
    if (typeof cwd !== 'string' || cwd.trim() === '')
        return null;
    let dir = resolvePath(cwd);
    const home = homedir();
    for (let depth = 0; depth < 24; depth += 1) {
        const candidate = join(dir, PROJECT_MEMORY_FILE);
        if (existsSync(candidate)) {
            return { root: dir, path: candidate, exists: true, content: readText(candidate) ?? '' };
        }
        if (dir === home)
            return null;
        if (existsSync(join(dir, '.git')))
            return null;
        const parent = dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
    return null;
}
/**
 * 解析一行 JSONL。
 *
 * 老条目（0.6.1 及之前）没有 `id`：这里**惰性算一个**（`entryId(ts, text)`），但不落盘 ——
 * 与 00 §4.1「id 惰性计算」一致，且不会因为读一次就把文件重写。
 */
function parseJournalLine(line, status = 'active') {
    try {
        const parsed = JSON.parse(line);
        if (parsed === null || typeof parsed !== 'object')
            return null;
        const record = parsed;
        const text = typeof record.text === 'string' ? record.text : '';
        if (text === '')
            return null;
        const ts = typeof record.ts === 'string' ? record.ts : '';
        const id = typeof record.id === 'string' && record.id !== '' ? record.id : entryId(ts, text);
        const entry = {
            id,
            ts,
            tags: Array.isArray(record.tags) ? record.tags.filter((tag) => typeof tag === 'string') : [],
            text,
            status,
        };
        if (status === 'archived') {
            for (const key of ['supersededAt', 'reason', 'supersededBy']) {
                if (typeof record[key] === 'string' && record[key] !== '')
                    entry[key] = record[key];
            }
        }
        return entry;
    }
    catch {
        return null;
    }
}
/** 读 JOURNAL.jsonl 的行（坏行跳过），返回原始行数组。 */
function readJournalLines() {
    const raw = readText(journalPath());
    if (raw === null)
        return [];
    return raw.split(/\r?\n/).filter((line) => line.trim() !== '');
}
/** 读日志尾部：坏行跳过（历史脏数据不该让整个功能挂掉）。 */
function readJournal(limit = DEFAULT_JOURNAL_LIMIT) {
    const max = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : DEFAULT_JOURNAL_LIMIT;
    const lines = readJournalLines();
    const total = lines.length;
    const tail = lines.slice(Math.max(0, lines.length - max));
    const entries = [];
    for (const line of tail) {
        const entry = parseJournalLine(line);
        if (entry !== null)
            entries.push(entry);
    }
    return { entries, total };
}
/**
 * 追加一条日志（`{id, ts}` 是返回值；落盘行是 `{id, ts, tags, text}`）。
 *
 * 写入在 `journal` 写锁内完成：`supersedeJournal()` 会整篇重写同一个文件，
 * 不加锁时「一边 append 一边 supersede」会丢掉刚追加的那行。
 */
async function appendJournal(text, tags = []) {
    const body = String(text ?? '').trim();
    const list = Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string') : [];
    ensureDir(memoryDir());
    const release = await acquireWriteLock('journal');
    try {
        // ts 在锁内取：并发追加的时间戳天然单调，recall 的「新→旧」顺序不会打架
        const ts = new Date().toISOString();
        const id = entryId(ts, body);
        appendFileSync(journalPath(), `${JSON.stringify({ id, ts, tags: list, text: body })}\n`, 'utf8');
        return { id, ts };
    }
    finally {
        release();
    }
}
/**
 * 列出日志条目（含 id / tags / status）。
 *
 * - `tail`：只取活跃条目的最后 N 条（默认 50）；
 * - `includeArchived`：是否把 `JOURNAL.archive.jsonl` 一并返回（`status: 'archived'`）。
 */
function listJournal(options = {}) {
    const { tail = 50, includeArchived = false } = options ?? {};
    const active = readJournal(tail).entries;
    if (!includeArchived)
        return active;
    const archived = [];
    const raw = readText(journalArchivePath());
    if (raw !== null) {
        for (const line of raw.split(/\r?\n/)) {
            if (line.trim() === '')
                continue;
            const entry = parseJournalLine(line, 'archived');
            if (entry !== null)
                archived.push(entry);
        }
    }
    return [...active, ...archived];
}
/**
 * JOURNAL 条目失效：从 `JOURNAL.jsonl` 移除 → 追加到 `JOURNAL.archive.jsonl`（02 §7.6）。
 *
 * 为什么「移出去」而不是原地标记：recall 每轮扫 JOURNAL 做 BM25 召回，标记行照样会被召回；
 * 移出去对 recall 天然透明，零改动。归档只供人工审计，不进任何检索。
 *
 * 归档前过**同一套**脱敏正则：归档文件虽然不进检索，但可能被人工或未来的工具读到。
 *
 * @returns `{moved, archived}` —— moved = 本次移除的行数，archived = 归档文件现有行数。
 */
async function supersedeJournal(ids, reason = '') {
    const wanted = new Set((Array.isArray(ids) ? ids : [ids])
        .filter((id) => typeof id === 'string')
        .map((id) => id.trim())
        .filter((id) => id !== ''));
    if (wanted.size === 0)
        return { moved: 0, archived: countArchiveLines() };
    const detail = reason !== null && typeof reason === 'object'
        ? { reason: String(reason.reason ?? ''), supersededBy: typeof reason.supersededBy === 'string' ? reason.supersededBy : '' }
        : { reason: String(reason ?? ''), supersededBy: '' };
    const release = await acquireWriteLock('journal');
    try {
        const lines = readJournalLines();
        const kept = [];
        const moved = [];
        for (const line of lines) {
            const entry = parseJournalLine(line);
            if (entry !== null && wanted.has(entry.id)) {
                moved.push(entry);
                continue;
            }
            kept.push(line);
        }
        if (moved.length === 0)
            return { moved: 0, archived: countArchiveLines() };
        ensureDir(memoryDir());
        const supersededAt = new Date().toISOString();
        const archivedLines = moved.map((entry) => {
            const record = {
                id: entry.id,
                ts: entry.ts,
                text: redactSecrets(entry.text).text,
                tags: entry.tags,
                supersededAt,
                reason: detail.reason,
                supersededBy: detail.supersededBy,
            };
            return JSON.stringify(record);
        });
        appendFileSync(journalArchivePath(), `${archivedLines.join('\n')}\n`, 'utf8');
        writeAtomic(journalPath(), kept.length === 0 ? '' : `${kept.join('\n')}\n`);
        return { moved: moved.length, archived: countArchiveLines() };
    }
    finally {
        release();
    }
}
function countArchiveLines() {
    const raw = readText(journalArchivePath());
    if (raw === null)
        return 0;
    return raw.split(/\r?\n/).filter((line) => line.trim() !== '').length;
}
function searchJournal(query, tag, limit) {
    const { entries } = readJournal(DEFAULT_JOURNAL_LIMIT);
    const needle = query.trim().toLowerCase();
    const wanted = tag.trim().toLowerCase();
    const out = [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (needle !== '' && !entry.text.toLowerCase().includes(needle))
            continue;
        if (wanted !== '' && !entry.tags.some((t) => t.toLowerCase() === wanted))
            continue;
        out.push(entry);
        if (out.length >= limit)
            break;
    }
    return out;
}
/* ═══════════════════════════ 0.7.0 · P2 新增 ═══════════════════════════
 * 模板 / 校验 / 插入 / 侧车索引 / 写锁 / JOURNAL 失效。
 * 这里**只执行已决定的 op**，不做语义归并（ADD/UPDATE/DELETE/NOOP 的裁决在附属插件，
 * 因为它需要 BM25 + LLM）。
 */
/* ───────────────────────── 规范化、id 与脱敏 ───────────────────────── */
/**
 * 条目文本规范化：去掉列表标记（`- ` / `1. `）、反引号、多余空白与尾部标点，再小写。
 *
 * 为什么要去掉列表标记：同一句结论在 FACT（`- `）与 MEMORY（`1. `）里的书写方式不同，
 * 去掉标记后「同一句话」才能算出同一个 hash。
 */
function normalizeEntryText(text) {
    return String(text ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
        .replace(/`/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[。．.；;，,、]+$/, '')
        .toLowerCase();
}
/** 条目稳定 id：`sha1(ts + 规范化文本).slice(0, 10)`（01 §3.6）。 */
function entryId(ts, text) {
    return createHash('sha1').update(`${String(ts ?? '')}${normalizeEntryText(text)}`).digest('hex').slice(0, 10);
}
/**
 * 内容 id（没有 ts 时的 id）：给**索引里没有记录**的老条目用，让 `findEntry` 也能返回
 * 一个可被 `replaceEntry` / `deleteEntry` 认出的 id。索引里有记录的条目仍用 ts 版 id。
 */
function contentId(text) {
    return entryId('', text);
}
/**
 * 作用域归一化：`global`→`fact`、`project`→`memory`（宿主工具用前者，存储层用后者）。
 * 未识别的值原样返回（`journal` 走这条路）。
 */
function normalizeScope(scope) {
    const raw = String(scope ?? '').trim().toLowerCase();
    if (raw === 'fact' || raw === 'global')
        return 'fact';
    if (raw === 'memory' || raw === 'project')
        return 'memory';
    return raw;
}
/**
 * 敏感串正则（与 02 §4.3 **同一套**，打码占位符统一 `⟨redacted⟩`）。
 *
 * 顺序有意义：私钥块最先（整块吃掉，免得被后面的卡号/手机号规则切碎），
 * 身份证在银行卡之前（18 位身份证也会命中 16–19 位卡号规则）。
 */
const SECRET_RULES = [
    {
        name: 'private-key',
        pattern: /-----BEGIN[^\n]*PRIVATE KEY-----[\s\S]*?-----END[^\n]*PRIVATE KEY-----/g,
        replace: () => REDACTED,
    },
    { name: 'private-key', pattern: /-----BEGIN[^\n]*PRIVATE KEY-----/g, replace: () => REDACTED },
    { name: 'openai-key', pattern: /sk-[A-Za-z0-9_-]{16,}/g, replace: () => REDACTED },
    {
        name: 'credential',
        pattern: /(api[_-]?key|token|password|passwd|secret)\s*[:=]\s*\S{6,}/gi,
        replace: (match) => {
            const separator = match.search(/[:=]/);
            return separator < 0 ? REDACTED : `${match.slice(0, separator)}=${REDACTED}`;
        },
    },
    { name: 'bearer', pattern: /Bearer\s+[A-Za-z0-9._-]{20,}/g, replace: () => `Bearer ${REDACTED}` },
    { name: 'mobile', pattern: /\b1[3-9]\d{9}\b/g, replace: () => REDACTED },
    { name: 'id-card', pattern: /\b\d{17}[\dXx]\b/g, replace: () => REDACTED },
    { name: 'bank-card', pattern: /\b\d{16,19}\b/g, replace: () => REDACTED },
];
/**
 * 打码：返回 `{text, hits}`，`hits` 是命中的规则名（命中即说明「这条含敏感串」）。
 * 唯一实现 —— `validateEntry` 与 `supersedeJournal` 都调它，不各写一份。
 */
function redactSecrets(text) {
    if (typeof text !== 'string' || text === '')
        return { text: typeof text === 'string' ? text : '', hits: [] };
    let out = text;
    const hits = [];
    for (const rule of SECRET_RULES) {
        rule.pattern.lastIndex = 0;
        if (!rule.pattern.test(out))
            continue;
        rule.pattern.lastIndex = 0;
        out = out.replace(rule.pattern, rule.replace);
        hits.push(rule.name);
    }
    return { text: out, hits };
}
/**
 * 英文词占比：分母 = 英文词数 + 中文字数（混排时才算）。
 *
 * 为什么分母用「中文字数」而不是「中文语段数」：一条中文结论里夹一个专有名词
 * （`adb`、`tarball`）不该被判成英文过多；「push 之后 profile 的 bundles 需要 sync」
 * 这种中英对半的句子才算（4 个英文词 / 9 = 0.44 > 0.4）。纯英文条目不判（规则只管混排）。
 */
function englishRatio(text) {
    const latin = text.match(/[A-Za-z][A-Za-z0-9._-]*/g) ?? [];
    const cjk = text.match(/[\u4e00-\u9fff]/g) ?? [];
    if (cjk.length === 0 || latin.length === 0)
        return 0;
    return latin.length / (latin.length + cjk.length);
}
/* ─────────────────────────── 模板（01 §3.1 / §3.2） ─────────────────────────── */
/**
 * 条目模板 + 给抽取提示词用的 `promptFragment`。
 *
 * 模板归主插件（拍板 2026-10-31）：附属插件生成 prompt 时向这里取，绝不自己定义一份，
 * 否则主插件做压缩管线时两边必然分叉。
 */
function templates() {
    const promptFragment = [
        '【条目模板】只写结论，一条一行。',
        '1. 一行一个结论，≤120 字（MEMORY 条目 ≤200 字）；一段里不要塞多个子步骤。',
        '2. 正文禁止行内代码：命令、路径、包名一律放到文件末尾的「## 速查」区，正文只说人话。',
        '3. 禁止过程叙述（先…然后…、尝试了…、最后发现…），只留结论。',
        '4. 中文叙述，英文只留专有名词（包名、命令、标识符）。',
        `5. 不写原因：${REASON_WORDS.join('/')} 这类词一律不写。`,
        '6. 不写密钥、密码、token、手机号、身份证、卡号；必须提到时写成 ⟨redacted⟩。',
    ].join('\n');
    return {
        fact: {
            sectionHint: '## 分组名（如「称呼」「环境」「长期约定」）；同一主题的条目放同一组，组内一行一个结论。',
            linePrefix: '- ',
        },
        memory: {
            listStyle: '1. 结论标题（编号顶层）\n   - 子结论（三空格缩进 + "- "）\n\n……结论区结束后另起「## 速查」，命令与路径集中放那里。',
        },
        promptFragment,
    };
}
/* ─────────────────────────────── 水位 ─────────────────────────────── */
/**
 * 当前水位：`{lines, bytes, chars, limit, path}`。
 *
 * `fact` 读 `$DSH_HOME/memory/FACT.md`；`memory` 读当前项目根的 MEMORY.md
 * （由 `cwd` 决定，找不到项目根则给 0 值 + 上限）。供附属插件写入前预警与面板显示。
 */
function watermark(scope, options = {}) {
    const target = normalizeScope(scope);
    if (target === 'fact') {
        const raw = readText(factPath()) ?? '';
        return {
            scope: 'fact',
            path: factPath(),
            lines: countLines(raw),
            bytes: countBytes(raw),
            chars: countChars(raw),
            limit: { lines: storeLimits.maxFactLines, bytes: storeLimits.maxFactBytes },
        };
    }
    const project = findProjectMemory(options?.cwd);
    const raw = project?.content ?? '';
    return {
        scope: 'memory',
        path: project?.path ?? null,
        lines: project === null ? 0 : countLines(raw),
        bytes: project === null ? 0 : countBytes(raw),
        chars: project === null ? 0 : countChars(raw),
        limit: { chars: storeLimits.maxProjectChars },
    };
}
/* ──────────────────── 侧车索引 `memory/index.json`（01 §3.4.1） ──────────────────── */
function emptyIndex() {
    return { version: 1, entries: {} };
}
/** 读索引（**不修剪**）：缺失/损坏/版本不认识 ⇒ 空索引，绝不抛错。 */
function readIndexRaw() {
    const raw = readText(indexPath());
    if (raw === null)
        return emptyIndex();
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1)
            return emptyIndex();
        const entries = {};
        const source = parsed.entries;
        if (source === null || typeof source !== 'object' || Array.isArray(source))
            return emptyIndex();
        for (const [id, meta] of Object.entries(source)) {
            if (typeof id !== 'string' || id === '')
                continue;
            if (meta === null || typeof meta !== 'object')
                continue;
            entries[id] = {
                scope: normalizeScope(meta.scope),
                workspaceId: typeof meta.workspaceId === 'string' ? meta.workspaceId : null,
                firstSeen: typeof meta.firstSeen === 'number' && Number.isFinite(meta.firstSeen) ? meta.firstSeen : null,
                lastHit: typeof meta.lastHit === 'number' && Number.isFinite(meta.lastHit) ? meta.lastHit : null,
                hits: typeof meta.hits === 'number' && Number.isFinite(meta.hits) ? meta.hits : 0,
                confidence: typeof meta.confidence === 'string' ? meta.confidence : 'medium',
                ...(typeof meta.path === 'string' && meta.path !== '' ? { path: meta.path } : {}),
            };
        }
        return { version: 1, entries };
    }
    catch {
        return emptyIndex();
    }
}
/** 某条正文的 id 是否等于 `id`（用索引里的 firstSeen 当 ts 复算）。 */
function textIdMatches(texts, id, meta) {
    if (!Number.isFinite(meta.firstSeen))
        return false;
    return texts.some((text) => entryId(meta.firstSeen, text) === id);
}
/**
 * 修剪孤儿：正文被人工改过 ⇒ id 变了 ⇒ 旧记录成了孤儿，读到就丢掉。
 *
 * 索引只存元数据不存正文，所以「这条 id 是否还存在于文件里」只能按行重算 hash。
 * 项目条目靠索引里的 `path` 定位文件（老索引没有 path 时无从判断，保留）。
 */
function pruneIndex(index) {
    const factTexts = factEntries(readText(factPath()) ?? '').map((entry) => entry.text);
    const memoryCache = new Map();
    const kept = {};
    for (const [id, meta] of Object.entries(index.entries)) {
        if (meta.scope === 'fact') {
            if (textIdMatches(factTexts, id, meta))
                kept[id] = meta;
            continue;
        }
        if (meta.scope !== 'memory')
            continue;
        if (typeof meta.path !== 'string' || meta.path === '') {
            kept[id] = meta;
            continue;
        }
        if (!memoryCache.has(meta.path)) {
            const raw = readText(meta.path);
            memoryCache.set(meta.path, raw === null ? null : memoryEntries(raw).map((entry) => entry.text));
        }
        const texts = memoryCache.get(meta.path);
        if (texts === null)
            continue;
        if (textIdMatches(texts, id, meta))
            kept[id] = meta;
    }
    return kept;
}
/**
 * 侧车索引：`{version, entries: {id: meta}, list: [...]}`。
 *
 * `entries` 是落盘形状（按 id 键控，权威）；`list` 是拍平后的便利视图
 * （00 §4.1 里写的 `{id, ts, confidence, hits}`），免得调用方自己 map。
 * 读的时候顺手修剪孤儿（**不落盘**，下次写入时自然收敛）。永不抛错。
 */
function memoryIndex() {
    try {
        const entries = pruneIndex(readIndexRaw());
        const list = Object.entries(entries).map(([id, meta]) => ({
            id,
            scope: meta.scope,
            workspaceId: meta.workspaceId,
            ts: meta.firstSeen,
            firstSeen: meta.firstSeen,
            lastHit: meta.lastHit,
            hits: meta.hits,
            confidence: meta.confidence,
        }));
        // missing：index.json 文件本身不存在（与「存在但为空」区分开，压缩层的报告要用）
        return { version: 1, entries, list, missing: !existsSync(indexPath()) };
    }
    catch {
        return { version: 1, entries: {}, list: [], missing: true };
    }
}
/** 在锁内改索引（读 → 修剪 → 改 → 原子写）。索引写失败不影响正文写入，故吞掉异常。 */
function mutateIndex(mutator) {
    try {
        const entries = pruneIndex(readIndexRaw());
        mutator(entries);
        writeAtomic(indexPath(), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * 整篇写入后同步侧车索引（0.8.0 · P2）：让 `memory action=update` 与面板保存写进来的
 * 条目也有元数据，否则压缩管线的淘汰层永远没有候选（ISSUE-001 的根因）。
 *
 * 规则：
 *  - 正文里**没变**的条目：保留原记录（`pruneIndex` 已按新正文复算过 id，没匹配上的
 *    记录自动丢掉，等于顺手清孤儿）；
 *  - 新条目：`firstSeen = lastHit = now`、`hits = 1`、`confidence = medium`（保守：刚写进来
 *    的样本不该马上被压缩淘汰）；
 *  - 只处理本文件：项目条目按 `path` 区分，别的项目里同样的句子不算"已覆盖"。
 *
 * 索引只是元数据：写失败不影响正文（返回 false，绝不抛）。
 */
function syncIndexAfterWrite(scope, file, content, options = {}) {
    try {
        const target = normalizeScope(scope);
        if (target !== 'fact' && target !== 'memory')
            return false;
        if (typeof file !== 'string' || file === '')
            return false;
        const texts = (target === 'fact' ? factEntries(content ?? '') : memoryEntries(content ?? ''))
            .map((entry) => entry.text);
        const now = Number.isFinite(options?.now) ? Number(options.now) : Date.now();
        const workspaceId = typeof options?.workspaceId === 'string' && options.workspaceId !== ''
            ? options.workspaceId
            : null;
        return mutateIndex((records) => {
            const existing = Object.entries(records);
            for (const text of texts) {
                const covered = existing.some(([id, meta]) => meta.scope === target
                    && (target !== 'memory' || meta.path === file)
                    && textIdMatches([text], id, meta));
                if (covered)
                    continue;
                const id = entryId(now, text);
                records[id] = {
                    scope: target,
                    workspaceId,
                    firstSeen: now,
                    lastHit: now,
                    hits: 1,
                    confidence: 'medium',
                    ...(target === 'memory' ? { path: file } : {}),
                };
            }
        });
    }
    catch {
        return false;
    }
}

/* ─────────────────────────── 条目切分 ─────────────────────────── */
/** 按行切（去掉末尾空行，`\r\n` 归一化）。 */
function splitLines(text) {
    const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
    while (lines.length > 0 && lines[lines.length - 1] === '')
        lines.pop();
    return lines;
}
/** FACT 条目：`- ` 行，保留所属 `##` 分组名。`line` 是 0 基行号。 */
function factEntries(raw) {
    const lines = splitLines(raw);
    const entries = [];
    let section = '';
    for (let index = 0; index < lines.length; index += 1) {
        const heading = /^##\s+(.+?)\s*$/.exec(lines[index]);
        if (heading !== null) {
            section = heading[1].trim();
            continue;
        }
        const bullet = /^-\s+(.+)$/.exec(lines[index]);
        if (bullet === null)
            continue;
        entries.push({ line: index, section, text: bullet[1].trim() });
    }
    return entries;
}
/**
 * MEMORY 条目：编号行（`1. 结论`）与**顶层**（缩进 0）的 `- ` 列表项。
 *
 * 为什么要收顶层 bullet：真实项目记忆经常整篇用 `- 结论` 写（本机 Astrbot / xyp-service
 * 实测都是 0 条编号 + 40~60 条顶层 bullet）。只认编号会让淘汰层与索引回填对这类文件
 * **完全失效**（0 条候选）。更深缩进的 `- ` 是上层条目的子项，不算条目。
 *
 * `## 速查` 里的列表项**不算条目**：模板规定命令与路径集中放那里，属于参考数据，
 * 不该进压缩候选。
 */
function memoryEntries(raw) {
    const lines = splitLines(raw);
    const entries = [];
    let section = '';
    let reference = false;
    for (let index = 0; index < lines.length; index += 1) {
        const heading = /^##\s+(.+?)\s*$/.exec(lines[index]);
        if (heading !== null) {
            section = heading[1].trim();
            reference = normalizeSectionName(section).startsWith('速查');
            continue;
        }
        if (reference)
            continue;
        const numbered = /^(\s*)(\d+)\.\s+(.+)$/.exec(lines[index]);
        if (numbered !== null) {
            entries.push({ line: index, section, indent: numbered[1], number: Number(numbered[2]), text: numbered[3].trim() });
            continue;
        }
        const bullet = /^-\s+(.+)$/.exec(lines[index]);
        if (bullet !== null)
            entries.push({ line: index, section, indent: '', bullet: true, text: bullet[1].trim() });
    }
    return entries;
}
/** 读某作用域的条目（文件不存在 ⇒ null）。 */
function readScopeEntries(scope, cwd) {
    const target = normalizeScope(scope);
    const file = target === 'fact' ? factPath() : projectMemoryPath(cwd);
    if (file === null)
        return null;
    const raw = readText(file);
    if (raw === null)
        return null;
    return { file, entries: target === 'fact' ? factEntries(raw) : memoryEntries(raw) };
}
/** 项目 MEMORY.md 的路径：优先命中项目根，否则认为「cwd 就是项目根」（写入即创建）。 */
function projectMemoryPath(cwd) {
    const found = findProjectMemory(cwd);
    if (found !== null)
        return found.path;
    if (typeof cwd === 'string' && cwd.trim() !== '')
        return join(resolvePath(cwd), PROJECT_MEMORY_FILE);
    return null;
}
/** 某作用域要写哪个文件（memory 无法定位项目根 ⇒ null）。 */
function targetFile(scope, cwd) {
    return normalizeScope(scope) === 'fact' ? factPath() : projectMemoryPath(cwd);
}
/* ─────────────────────────── 写入落位 ─────────────────────────── */
function normalizeSectionName(name) {
    return String(name ?? '').replace(/^#+\s*/, '').trim().toLowerCase();
}
/** FACT 插入：落在同名 `## 分组` 里，没有就找/建 `## 其它`。 */
function insertFactLine(base, text, section) {
    const lines = splitLines(base);
    const line = `- ${text}`;
    const wanted = normalizeSectionName(section);
    const headingIndex = (name) => lines.findIndex((item) => {
        const heading = /^##\s+(.+?)\s*$/.exec(item);
        return heading !== null && normalizeSectionName(heading[1]) === name;
    });
    let head = wanted === '' ? -1 : headingIndex(wanted);
    if (head < 0)
        head = headingIndex(normalizeSectionName('其它'));
    let created = false;
    if (head < 0) {
        if (lines.length > 0 && lines[lines.length - 1].trim() !== '')
            lines.push('');
        lines.push('## 其它');
        lines.push('');
        head = lines.length - 2;
        created = true;
    }
    let insertAt = lines.length;
    for (let index = head + 1; index < lines.length; index += 1) {
        if (/^##\s+/.test(lines[index])) {
            insertAt = index;
            break;
        }
    }
    // 已有分组：落到组内最后一个非空行之后（不把组尾空行顶下去）；新建的分组本身就带空行
    if (!created) {
        while (insertAt > head + 1 && lines[insertAt - 1].trim() === '')
            insertAt -= 1;
    }
    lines.splice(insertAt, 0, line);
    return `${lines.join('\n')}\n`;
}
/** MEMORY 插入：编号顺延，缩进沿用最后一条编号条目；有 `## 速查` 时不插到它后面。 */
function insertMemoryLine(base, text) {
    const lines = splitLines(base);
    let lastNumbered = -1;
    let indent = '';
    let maxNumber = 0;
    for (let index = 0; index < lines.length; index += 1) {
        const numbered = /^(\s*)(\d+)\.\s+(.+)$/.exec(lines[index]);
        if (numbered === null)
            continue;
        lastNumbered = index;
        indent = numbered[1];
        maxNumber = Math.max(maxNumber, Number(numbered[2]));
    }
    const line = `${indent}${maxNumber + 1}. ${text}`;
    if (lastNumbered >= 0) {
        // 跳过该编号条目的子项（更深缩进的非编号行），插在子项之后
        let cursor = lastNumbered + 1;
        while (cursor < lines.length && lines[cursor].trim() !== '' && /^\s+/.test(lines[cursor]) && !/^\s*\d+\.\s/.test(lines[cursor]))
            cursor += 1;
        lines.splice(cursor, 0, line);
        return `${lines.join('\n')}\n`;
    }
    const cheatIndex = lines.findIndex((item) => /^##\s+速查\s*$/.test(item));
    if (cheatIndex >= 0) {
        lines.splice(cheatIndex, 0, line, '');
    }
    else if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
        lines.push(line);
    }
    else {
        lines.push(line);
    }
    return `${lines.join('\n')}\n`;
}
/** 写前备份到 `$DSH_HOME/memory/backups/<文件名>-<yyyyMMdd-HHmmssSSS>.bak`。 */
function backupFile(file) {
    const raw = readText(file);
    if (raw === null || raw === '')
        return null;
    const now = new Date();
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;
    const target = join(backupsDir(), `${basename(file)}-${stamp}.bak`);
    try {
        writeAtomic(target, raw);
        return target;
    }
    catch {
        return null;
    }
}
/* ─────────────────────────── 写锁（进程内互斥） ─────────────────────────── */
const writeLocks = new Map();
/** 锁键：`fact` / `journal` / `memory:<项目根>`（同项目不同 cwd 共用一把锁）。 */
function lockKey(scope, options = {}) {
    const target = normalizeScope(scope);
    if (target === 'fact')
        return 'fact';
    if (target === 'journal')
        return 'journal';
    const project = findProjectMemory(options?.cwd);
    const root = project?.root ?? (typeof options?.cwd === 'string' && options.cwd.trim() !== '' ? resolvePath(options.cwd) : '');
    return `memory:${root}`;
}
/**
 * 取写锁，返回 `release()`。默认等 5000ms，超时抛 `MEMORY_LOCK_TIMEOUT`。
 *
 * 进程内 async mutex：本插件的全部写路径（insert/replace/delete/append/supersede，
 * 以及将来的压缩管线）都从这里过；跨进程写不保证（宿主只有一份实例）。
 */
function acquireWriteLock(scope, options = {}) {
    const key = lockKey(scope, options ?? {});
    const timeoutMs = typeof options?.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(0, options.timeoutMs)
        : DEFAULT_LOCK_TIMEOUT;
    let state = writeLocks.get(key);
    if (state === undefined) {
        state = { locked: false, waiters: [] };
        writeLocks.set(key, state);
    }
    return new Promise((resolve, reject) => {
        const grant = () => {
            state.locked = true;
            let released = false;
            resolve(() => {
                if (released)
                    return;
                released = true;
                const next = state.waiters.shift();
                if (next !== undefined) {
                    // 直接把所有权交给队首：不先把 locked 置 false，避免中间态被插队
                    next();
                    return;
                }
                state.locked = false;
                if (writeLocks.get(key) === state)
                    writeLocks.delete(key);
            });
        };
        if (!state.locked) {
            grant();
            return;
        }
        let timer = null;
        const waiter = () => {
            if (timer !== null)
                clearTimeout(timer);
            grant();
        };
        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                const position = state.waiters.indexOf(waiter);
                if (position >= 0)
                    state.waiters.splice(position, 1);
                const error = new Error(`获取写锁超时（${key}，已等待 ${timeoutMs}ms）`);
                error.code = 'MEMORY_LOCK_TIMEOUT';
                reject(error);
            }, timeoutMs);
        }
        state.waiters.push(waiter);
    });
}
/* ─────────────────────────── 定位（findEntry） ─────────────────────────── */
/** 用索引里的 firstSeen 反查这条正文的已知 id（索引里没有 ⇒ null）。 */
function resolveKnownId(scope, text, index) {
    for (const [id, meta] of Object.entries(index.entries)) {
        if (meta.scope !== scope || !Number.isFinite(meta.firstSeen))
            continue;
        if (entryId(meta.firstSeen, text) === id)
            return id;
    }
    return null;
}
/**
 * 定位旧条目：先按规范化 hash（索引 id），再按规范化文本「精确相等 → 子串」。
 * `id` 可能为 null（人工写的条目没有索引记录）——调用方那就降级 ADD。
 */
function findEntry(scope, hint, options = {}) {
    const target = normalizeScope(scope);
    const text = typeof hint === 'string' ? hint.trim() : '';
    if (text === '')
        return null;
    const read = readScopeEntries(target, options?.cwd);
    if (read === null)
        return null;
    const index = readIndexRaw();
    const meta = index.entries[text];
    if (meta !== undefined && meta.scope === target && Number.isFinite(meta.firstSeen)) {
        const hit = read.entries.find((entry) => entryId(meta.firstSeen, entry.text) === text);
        if (hit !== undefined)
            return { id: text, line: hit.line, text: hit.text, section: hit.section ?? '' };
    }
    const needle = normalizeEntryText(text);
    if (needle === '')
        return null;
    const normalized = read.entries.map((entry) => ({ entry, key: normalizeEntryText(entry.text) }));
    const matched = normalized.find((item) => item.key === needle) ?? normalized.find((item) => item.key.includes(needle));
    if (matched === undefined)
        return null;
    return {
        id: resolveKnownId(target, matched.entry.text, index) ?? contentId(matched.entry.text),
        line: matched.entry.line,
        text: matched.entry.text,
        section: matched.entry.section ?? '',
    };
}
/** 按 id 在条目数组里定位（索引 → 内容 id → 把 id 当规范化文本，逐级兜底）。 */
function locateById(scope, entries, index, id) {
    const meta = index.entries[id];
    if (meta !== undefined && meta.scope === scope && Number.isFinite(meta.firstSeen)) {
        const hit = entries.find((entry) => entryId(meta.firstSeen, entry.text) === id);
        if (hit !== undefined)
            return hit;
    }
    const byContent = entries.find((entry) => contentId(entry.text) === id);
    if (byContent !== undefined)
        return byContent;
    const needle = normalizeEntryText(id);
    if (needle === '')
        return null;
    return entries.find((entry) => normalizeEntryText(entry.text) === needle) ?? null;
}
/* ─────────────────────────── 校验（01 §3.3） ─────────────────────────── */
/** 去掉调用方可能顺手带上的列表标记：条目正文一律不带 `- ` / `1. `（写入时自己加）。 */
function stripListMarker(text) {
    return String(text ?? '').replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();
}
function normalizeEntryInput(raw) {
    if (typeof raw === 'string')
        return { text: stripListMarker(raw), confidence: 'medium', workspaceId: null, section: '' };
    if (raw !== null && typeof raw === 'object') {
        return {
            text: typeof raw.text === 'string' ? stripListMarker(raw.text) : '',
            confidence: typeof raw.confidence === 'string' ? raw.confidence : 'medium',
            workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : null,
            section: typeof raw.section === 'string' ? raw.section.trim() : '',
        };
    }
    return { text: '', confidence: 'medium', workspaceId: null, section: '' };
}
/**
 * 条目硬校验 → `{ok:true}` 或 `{ok:false, reason, demote:'journal'|'drop'}`。
 *
 * `drop` = 永久丢弃（含原因词 / 第一人称 / 超长 / **敏感串**）；
 * `journal` = 降级写 JOURNAL（问句、过程词、过程叙述、行内代码过多、英文过多、项目对不上）。
 *
 * ⚠️ 敏感串**永远 drop**，绝不降级 JOURNAL：JOURNAL 会被 recall 召回并注入提示词，
 * 把密钥丢进去等于直接送到模型面前（00 §9 审计 P0）。
 */
function validateEntry(scope, entry, options = {}) {
    const target = normalizeScope(scope);
    const { text } = normalizeEntryInput(entry);
    const maxLength = target === 'fact' ? 120 : 200;
    const reject = (reason, demote) => ({ ok: false, reason, demote });
    if (text === '')
        return reject('条目为空', 'drop');
    const secrets = redactSecrets(text);
    if (secrets.hits.length > 0)
        return reject(`命中敏感串（${[...new Set(secrets.hits)].join('、')}），绝不降级 JOURNAL`, 'drop');
    if (text.length > maxLength)
        return reject(`超过 ${maxLength} 字（实际 ${text.length} 字）`, 'drop');
    const reasonWord = REASON_WORDS.find((word) => text.includes(word));
    if (reasonWord !== undefined)
        return reject(`含原因词「${reasonWord}」，只写结论`, 'drop');
    if (/^(?:我们|我)(?!的)/.test(text))
        return reject('第一人称开头且没有明确主语', 'drop');
    if (/[？?]\s*$/.test(text))
        return reject('是问句而不是结论', 'journal');
    if (/然后|接着|首先/.test(text))
        return reject('含过程词（然后/接着/首先）', 'journal');
    if (/先.{0,20}(然后|接着|最后)|最后发现|尝试了/.test(text))
        return reject('是过程叙述，只留结论', 'journal');
    const spans = (text.match(/`[^`\n]+`/g) ?? []).length;
    if (spans > 2)
        return reject(`行内代码 ${spans} 处（>2），命令与路径请移到「速查」区`, 'journal');
    if (englishRatio(text) > 0.4)
        return reject('英文词占比超过 40%，请用中文叙述（专有名词除外）', 'journal');
    if (target === 'memory' && findProjectMemory(options?.cwd) === null)
        return reject('project 条目对不上当前项目根（cwd 下没有 MEMORY.md）', 'journal');
    return { ok: true };
}
/**
 * 闸口薄包装：校验 + 预演落位后卡上限，超限抛 `MEMORY_BUDGET_EXCEEDED`。
 * 校验不过抛 `MEMORY_ENTRY_REJECTED`（`details` 带 reason / demote）。
 */
function assertEntry(scope, entry, options = {}) {
    const target = normalizeScope(scope);
    const validation = validateEntry(target, entry, options);
    if (!validation.ok) {
        const error = new Error(`记忆条目未通过校验：${validation.reason}`);
        error.code = 'MEMORY_ENTRY_REJECTED';
        error.details = { scope: target, reason: validation.reason, demote: validation.demote };
        throw error;
    }
    const { text } = normalizeEntryInput(entry);
    const file = targetFile(target, options?.cwd);
    const current = (file === null ? null : readText(file)) ?? '';
    const next = target === 'fact' ? insertFactLine(current, text) : insertMemoryLine(current, text);
    if (target === 'fact')
        assertFactWithinLimit(next, storeLimits.maxFactLines, storeLimits.maxFactBytes);
    else
        assertProjectMemoryWithinLimit(next, storeLimits.maxProjectChars);
    return { ok: true, text, target: file };
}
/* ─────────────────────────── 写入（insert / replace / delete） ─────────────────────────── */
/**
 * 追加一条条目：校验 → 锁 → 重读 → 落位 → 卡上限 → 备份 → 原子写 → 更新索引。
 *
 * 校验不过**一行都不写**（`{written:false, demoted}`）；超限在**写之前**抛
 * `MEMORY_BUDGET_EXCEEDED`（磁盘保持原样）。
 */
async function insertEntry(scope, rawEntry, options = {}) {
    const target = normalizeScope(scope);
    const cwd = options?.cwd;
    const entry = normalizeEntryInput(rawEntry);
    const validation = validateEntry(target, entry, { cwd });
    const file = targetFile(target, cwd);
    if (!validation.ok)
        return { written: false, demoted: validation.demote, reason: validation.reason, target: file };
    if (file === null)
        throw new Error('无法确定当前项目根（会话 cwd 未知），无法写项目记忆');
    // 水位 ≥85% 时先压缩（压缩器自己拿锁，所以只能在锁外敲；关闭时这一个调用立即返回 null）
    await compactBeforeWrite(target, cwd);
    const release = await acquireWriteLock(target, { cwd, timeoutMs: options?.timeoutMs });
    try {
        const current = readText(file) ?? '';
        const next = target === 'fact'
            ? insertFactLine(current, entry.text, entry.section)
            : insertMemoryLine(current, entry.text);
        if (target === 'fact')
            assertFactWithinLimit(next, storeLimits.maxFactLines, storeLimits.maxFactBytes);
        else
            assertProjectMemoryWithinLimit(next, storeLimits.maxProjectChars);
        backupFile(file);
        writeAtomic(file, next);
        const ts = Date.now();
        const id = entryId(ts, entry.text);
        mutateIndex((entries) => {
            entries[id] = {
                scope: target,
                workspaceId: entry.workspaceId,
                firstSeen: ts,
                lastHit: ts,
                hits: 1,
                confidence: entry.confidence,
                ...(target === 'memory' ? { path: file } : {}),
            };
        });
        return { written: true, id, target: file };
    }
    finally {
        release();
    }
}
/**
 * 替换命中条目（保留原编号/缩进/项目符号）。找不到 ⇒ `{written:false, notFound:true}`，
 * 调用方降级 ADD（旧条目被人工改过就会走到这里，不硬改）。
 */
async function replaceEntry(scope, id, rawEntry, options = {}) {
    const target = normalizeScope(scope);
    const cwd = options?.cwd;
    const entry = normalizeEntryInput(rawEntry);
    const wanted = typeof id === 'string' ? id.trim() : '';
    if (wanted === '')
        return { written: false, notFound: true, reason: '缺少条目 id' };
    const validation = validateEntry(target, entry, { cwd });
    if (!validation.ok)
        return { written: false, demoted: validation.demote, reason: validation.reason };
    // 同 insertEntry：压缩在锁外敲门，进锁后重读再卡闸口。
    await compactBeforeWrite(target, cwd);
    const release = await acquireWriteLock(target, { cwd, timeoutMs: options?.timeoutMs });
    try {
        const file = targetFile(target, cwd);
        if (file === null)
            return { written: false, notFound: true };
        const current = readText(file);
        if (current === null)
            return { written: false, notFound: true };
        const entries = target === 'fact' ? factEntries(current) : memoryEntries(current);
        const located = locateById(target, entries, readIndexRaw(), wanted);
        if (located === null)
            return { written: false, notFound: true };
        const lines = splitLines(current);
        lines[located.line] = target === 'fact' || located.bullet === true
            ? `- ${entry.text}`
            : `${located.indent ?? ''}${located.number}. ${entry.text}`;
        const next = `${lines.join('\n')}\n`;
        if (target === 'fact')
            assertFactWithinLimit(next, storeLimits.maxFactLines, storeLimits.maxFactBytes);
        else
            assertProjectMemoryWithinLimit(next, storeLimits.maxProjectChars);
        backupFile(file);
        writeAtomic(file, next);
        const ts = Date.now();
        const newId = entryId(ts, entry.text);
        mutateIndex((indexEntries) => {
            delete indexEntries[wanted];
            indexEntries[newId] = {
                scope: target,
                workspaceId: entry.workspaceId,
                firstSeen: ts,
                lastHit: ts,
                hits: 1,
                confidence: entry.confidence,
                ...(target === 'memory' ? { path: file } : {}),
            };
        });
        return { written: true, id: newId, target: file };
    }
    finally {
        release();
    }
}
/**
 * 条目占用的行区间终点（不含）：编号/顶层 bullet 条目连带它下面更深缩进的子项。
 * 与压缩层 `parseEntries()` 的口径一致 —— 删条目别留下孤儿子项。
 */
function entrySpan(lines, startIndex) {
    let end = startIndex + 1;
    for (let cursor = startIndex + 1; cursor < lines.length; cursor += 1) {
        const current = lines[cursor];
        if (current.trim() === '')
            break;
        if (/^\s*\d+\.\s/.test(current))
            break;
        if (/^-\s+/.test(current))
            break;
        if (!/^\s+/.test(current))
            break;
        end = cursor + 1;
    }
    return end;
}
/** 删除条目（只给压缩管线与第二层用；第一层沉淀永远不删）。 */
async function deleteEntry(scope, id, options = {}) {
    const target = normalizeScope(scope);
    const cwd = options?.cwd;
    const wanted = typeof id === 'string' ? id.trim() : '';
    if (wanted === '')
        return { deleted: false };
    const release = await acquireWriteLock(target, { cwd, timeoutMs: options?.timeoutMs });
    try {
        const file = targetFile(target, cwd);
        if (file === null)
            return { deleted: false };
        const current = readText(file);
        if (current === null)
            return { deleted: false };
        const entries = target === 'fact' ? factEntries(current) : memoryEntries(current);
        const located = locateById(target, entries, readIndexRaw(), wanted);
        if (located === null)
            return { deleted: false };
        const lines = splitLines(current);
        const dropEnd = target === 'memory' ? entrySpan(lines, located.line) : located.line + 1;
        lines.splice(located.line, dropEnd - located.line);
        const next = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
        backupFile(file);
        writeAtomic(file, next);
        mutateIndex((indexEntries) => {
            delete indexEntries[wanted];
        });
        return { deleted: true, target: file };
    }
    finally {
        release();
    }
}
/**
 * 整篇覆盖写（`memory action=update` 与面板保存共用）：取写锁 → 锁内重读 → 比对
 * `expectedRevision` → 备份 → 原子写 → 同步侧车索引。
 *
 * 为什么这里也必须有锁：条目级写入（insert/replace/delete）与压缩管线都是
 * 「锁内重读 → 改 → 写」；而整篇覆盖是「门外的旧正文 + 新正文」，中间发生的任何一次
 * 条目级写入都会被它整篇盖掉。不加锁时这类丢数据**不会报错**，只会「神秘地少一段」，
 * 事后连哪一边写的都查不出来（QQ 配置被监听器占句柄、改配置被静默回滚是同类前车之鉴）。
 *
 * `expectedRevision` 省略 ⇒ 只加锁、不校验（保持旧调用方的行为）；给了但和磁盘上的
 * 当前修订号不一致 ⇒ 抛 `MEMORY_REVISION_CONFLICT`，**绝不硬写**。乐观锁的意义就是
 * 让「拿着旧内容整篇覆盖」这件事失败得响亮，而不是安静地丢掉别人的改动。
 */
async function replaceDocument(scope, file, content, options = {}) {
    const target = normalizeScope(scope);
    const cwd = options?.cwd;
    const expected = typeof options?.expectedRevision === 'string' && options.expectedRevision.trim() !== ''
        ? options.expectedRevision.trim()
        : null;
    const release = await acquireWriteLock(target, { cwd, timeoutMs: options?.timeoutMs });
    try {
        const current = readText(file) ?? '';
        const actual = contentRevision(current);
        if (expected !== null && expected !== actual) {
            const error = new Error([
                `记忆文件已被别处修改，本次写入已拒绝（revision 冲突）：${file}`,
                `- 你手里的版本：${expected}；磁盘上的当前版本：${actual}。`,
                `- 常见来源：同一时刻的 memory action=update、另一个面板保存、压缩管线或自动沉淀。`,
                `- 请重新读取最新内容，把要保留的改动合并进去后再写。直接硬写会静默丢掉别人的改动，所以这里不写。`,
            ].join('\n'));
            error.code = 'MEMORY_REVISION_CONFLICT';
            error.status = 409;
            error.details = { scope: target, path: file, expectedRevision: expected, actualRevision: actual };
            throw error;
        }
        backupFile(file);
        writeAtomic(file, content);
        syncIndexAfterWrite(target, file, content);
        return { written: true, revision: contentRevision(content), previousRevision: actual, target: file };
    }
    finally {
        release();
    }
}
export {
    DEFAULT_JOURNAL_LIMIT,
    FACT_FILE,
    JOURNAL_FILE,
    PROJECT_MEMORY_FILE,
    acquireWriteLock,
    appendJournal,
    assertEntry,
    assertFactWithinLimit,
    assertProjectMemoryWithinLimit,
    compactionEnabled,
    configureCompactor,
    configureStore,
    contentRevision,
    countBytes,
    countChars,
    countLines,
    deleteEntry,
    dshHome,
    ensureDir,
    entryId,
    factPath,
    findEntry,
    findProjectMemory,
    indexPath,
    insertEntry,
    isBudgetError,
    journalArchivePath,
    journalPath,
    limits,
    listJournal,
    memoryDir,
    memoryIndex,
    mutateIndex,
    readJournal,
    readText,
    redactSecrets,
    replaceDocument,
    replaceEntry,
    searchJournal,
    supersedeJournal,
    syncIndexAfterWrite,
    templates,
    validateEntry,
    watermark,
    writeAtomic,
};
