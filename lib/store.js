/**
 * @dsh-external/dsh-persona-memory — 存储层（storage layer），与附属插件共享：
 * 只依赖 node 内置模块，不引任何第三方依赖、不读 config，import 即可读写同一套记忆文件。
 * 本文件内容是从 lib/index.js 原样搬出的，逻辑一行未改。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, parse as parsePath, resolve as resolvePath } from 'node:path';
import { STATE_ACTIVE, applyEntryState, formatStateDate, isDormantState, parseEntryState } from './entry-state.js';
import { rankJournalEntries } from './journal-search.js';
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
/**
 * 条目级自动备份的子目录名（0.9.0 · P1-4 备份分家）。
 *
 * `backups/` 下**只留压缩管线**的备份（`<file>-<yyyyMMdd-HHmmss>.bak`，秒级戳，
 * 回滚要靠它）；store 的条目级备份（每次 insert/replace/delete/整篇写都一份，
 * 毫秒级戳）落到 `backups/auto/`。两侧各有各的修剪，互不删对方的文件 ——
 * 否则一天十几份条目级备份会把压缩备份挤掉，`/memory-compact rollback` 找不到备份。
 */
const AUTO_BACKUP_DIR = 'auto';
/** 条目级自动备份默认保留份数（同一文件最多留这么多份）。 */
const DEFAULT_KEEP_AUTO_BACKUPS = 20;
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
/** 备份目录：`$DSH_HOME/memory/backups`（0.9.0 起只放压缩备份）。 */
function backupsDir() {
    return join(memoryDir(), BACKUP_DIR);
}
/** 条目级自动备份目录：`$DSH_HOME/memory/backups/auto`。 */
function autoBackupsDir() {
    return join(backupsDir(), AUTO_BACKUP_DIR);
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
/**
 * 注入的 logger（0.9.0 · P1-8）。只用来把「写前压缩失败」这类**被吞掉的异常**
 * 说一声；拿不到就静默（绝不让日志变成写路径的新故障点）。
 */
let storeLogger = null;
/** 条目级自动备份保留份数（`configureStore({ autoBackupKeep })` 覆盖）。 */
let autoBackupKeep = DEFAULT_KEEP_AUTO_BACKUPS;
/** 只接受带 warn / error 的对象；其余当没有。 */
function normalizeLogger(logger) {
    if (logger === null || typeof logger !== 'object')
        return null;
    if (typeof logger.warn !== 'function' && typeof logger.error !== 'function')
        return null;
    return logger;
}
/** 触发水位（与 `lib/compaction.js` 的 TRIGGER_RATIO 同口径，这里只用到这一个数）。 */
const COMPACTION_TRIGGER = 0.85;
/**
 * 注入压缩器；传非函数即解除。返回是否已挂上。
 *
 * `options.logger`（0.9.0）与 `configureStore({ logger })` 等价，先者为准。
 */
function configureCompactor(fn, options = {}) {
    compactorFn = typeof fn === 'function' ? fn : null;
    if (options?.logger !== undefined)
        storeLogger = normalizeLogger(options.logger);
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
 *
 * 0.9.0 · P1-8：但「吞掉」不等于「不留痕」。失败时记一条 warn，并把
 * `{ code, message }` 作为 `{ failure }` 返回；调用方（`insertEntry` 等）在随后
 * 的 `MEMORY_BUDGET_EXCEEDED` 上挂 `details.compactionFailure` ——
 * 否则用户只看到「超限」，永远不知道根因是压缩没跑起来。
 */
async function compactBeforeWrite(scope, cwd, trigger = 'insert') {
    if (compactionGate !== true || compactorFn === null)
        return null;
    try {
        const view = watermark(scope, { cwd });
        if (view.path === null || watermarkRatio(view) < COMPACTION_TRIGGER)
            return null;
        return await compactorFn(scope, { cwd, trigger });
    }
    catch (error) {
        const failure = {
            code: typeof error?.code === 'string' && error.code !== '' ? error.code : 'COMPACTION_ERROR',
            message: String(error?.message ?? error),
        };
        try {
            storeLogger?.warn?.(`[persona-memory] 写前压缩失败（已忽略，继续写入）：${failure.code} ${failure.message}`);
        }
        catch {
            /* 日志自身抛错不许影响写入 */
        }
        return { failure };
    }
}
/** 把压缩失败原因挂到超限错误的 `details` 上（只对 budgetError 生效，绝不改 message）。 */
function attachCompactionFailure(error, failure) {
    if (failure === null || failure === undefined)
        return error;
    if (isBudgetError(error) && error.details !== null && typeof error.details === 'object')
        error.details = { ...error.details, compactionFailure: failure };
    return error;
}
/** 覆盖上限；缺省/非法键回落到默认值。返回生效后的上限。 */
function configureStore(next) {
    const source = next ?? {};
    const pick = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.trunc(value) : fallback);
    /* 0.9.0 · P1-2：两套上限统一口径 —— 项目记忆的**生效**上限是
       `min(maxChars, maxProjectChars)`。注入侧按 `maxChars` 裁剪、写入侧按
       `maxProjectChars` 拦，两者不一致时「过了闸口照样被静默截断」。 */
    const projectChars = pick(source.maxProjectChars, DEFAULT_MAX_PROJECT_CHARS);
    const charCap = typeof source.maxChars === 'number' && Number.isFinite(source.maxChars) && source.maxChars >= 1
        ? Math.trunc(source.maxChars)
        : null;
    autoBackupKeep = pick(source.autoBackupKeep, DEFAULT_KEEP_AUTO_BACKUPS);
    storeLimits = {
        maxFactLines: pick(source.maxFactLines, DEFAULT_MAX_FACT_LINES),
        maxFactBytes: pick(source.maxFactBytes, DEFAULT_MAX_FACT_BYTES),
        maxProjectChars: charCap === null ? projectChars : Math.min(projectChars, charCap),
    };
    // 压缩管线的两个接线位（0.8.0）。不传 ⇒ 保持上一次状态，便于 `apply()` 之外的调用方单独设。
    if (typeof source.compactionEnabled === 'boolean')
        compactionGate = source.compactionEnabled;
    if (typeof source.compact === 'function')
        configureCompactor(source.compact);
    if (source.logger !== undefined)
        storeLogger = normalizeLogger(source.logger);
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
 * 项目目录的「来源可信度」（0.9.0 · 库级信任门，新增）。
 *
 * 项目根 MEMORY.md 可能是**随仓库分发**的文件：clone / fork 别人的仓库时它被预置，
 * 里面可能有别人提交的文本（甚至是写给模型看的「指令」）。注入时我们要能说一句
 * 「这段来源不可信」。判定只看 `.git`：
 *
 *  - `.git` 是目录 ⇒ `'repo'`（普通仓库）；
 *  - `.git` 是文件且含 `gitdir:` ⇒ `'repo'`（worktree / submodule）；
 *  - `.git` 存在但形状不认识、读失败、向上 24 层都没走到根 ⇒ `'unknown'`；
 *  - 走到文件系统根都没有 `.git` ⇒ `'local'`（本机生成的项目，不是仓库分发）。
 *
 * 返回 `'repo' | 'local' | 'unknown'`。**永不抛错**；调用方对 `repo`/`unknown`
 * 一律按「不可信」展示告示（fail-open：宁多多提示一句，不冒把仓库文本当系统指令的风险）。
 */
function gitOriginOf(dir) {
    try {
        if (typeof dir !== 'string' || dir.trim() === '')
            return 'unknown';
        let current = resolvePath(dir);
        // 起点目录不存在 ⇒ 判断不了（fail-open：按不可信处理，不猜 local）
        if (!existsSync(current))
            return 'unknown';
        for (let depth = 0; depth < 24; depth += 1) {
            const marker = join(current, '.git');
            if (existsSync(marker)) {
                try {
                    if (statSync(marker).isDirectory())
                        return 'repo';
                }
                catch {
                    return 'unknown';
                }
                const raw = readText(marker);
                if (raw !== null && /^\s*gitdir\s*:/m.test(raw))
                    return 'repo';
                // `.git` 存在但不是目录、也不含 gitdir：形状不认识 ⇒ 不可信
                return 'unknown';
            }
            const parent = dirname(current);
            if (parent === current)
                return 'local';
            current = parent;
        }
        return 'unknown';
    }
    catch {
        return 'unknown';
    }
}
/**
 * cwd → workspaceId 的**归一**（0.13.2 · B2；契约见三包共享的 DESIGN §14）。
 *
 * 用 `resolvePath` 去掉尾斜杠后的绝对路径：同一目录的不同写法（相对路径 / 尾斜杠 /
 * 大小写不敏感平台上的重复登记）归一到同一个键。**不读宿主 workspace.json**：
 * store 是最底层，`workspace.js` 依赖它，反向 import 会成环；需要注册表 id 的调用方
 * 自己传 `workspaceId`。
 *
 * 拿不到 cwd ⇒ null（不猜）。
 */
function workspaceIdFromCwd(cwd) {
    if (typeof cwd !== 'string' || cwd.trim() === '')
        return null;
    const resolved = resolvePath(cwd.trim());
    const stripped = resolved.replace(/[\\/]+$/, '');
    return stripped === '' ? resolved : stripped;
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
        const rawText = typeof record.text === 'string' ? record.text : '';
        if (rawText === '')
            return null;
        /* 0.9.0 · P0-1：历史行在**读**的时候也打码（只改返回值，不回写磁盘）。
           recall 会按 BM25 把 JOURNAL 正文召回并注入提示词；0.9.0 之前写入的
           明文密钥/手机号不能因为「当时没脱敏」就继续每轮进模型上下文。
           打码是幂等的（占位符 `⟨redacted⟩` 不会再命中任何规则）。 */
        const text = redactSecrets(rawText).text;
        const ts = typeof record.ts === 'string' ? record.ts : '';
        const id = typeof record.id === 'string' && record.id !== '' ? record.id : entryId(ts, text);
        const entry = {
            id,
            ts,
            tags: Array.isArray(record.tags) ? record.tags.filter((tag) => typeof tag === 'string') : [],
            text,
            status,
        };
        /* 0.13.2 · B2：归属字段只**新增**、不做任何校验 —— 旧行没有这两个字段时
           原样不出现（fail-open），读取方按「无归属 = 放行」处理，绝不因为字段缺失报错。 */
        if (typeof record.cwd === 'string' && record.cwd !== '')
            entry.cwd = record.cwd;
        if (typeof record.workspaceId === 'string' && record.workspaceId !== '')
            entry.workspaceId = record.workspaceId;
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
 *
 * 0.9.0 · P0-1：**落盘前脱敏**（`redactSecrets`）。JOURNAL 会被 recall 召回并注入
 * 提示词，明文密钥等于直接送到模型面前；`validateEntry` 对敏感串是「永远 drop」，
 * 而 `action=append` / 面板日志写入过去完全没有闸口。`id` 也按脱敏后的正文算，
 * 保证「返回值 id == 落盘行 id == `entryId(ts, 落盘正文)`」这条不变量成立。
 *
 * 0.13.2 · B2：第三参 `options.cwd`（可选）落成行内 `cwd` + 归一后的 `workspaceId`，
 * 供 recall 按工作区隔离。**两参调用一字不变**（旧调用方 / 附属插件不用跟版）。
 */
async function appendJournal(text, tags = [], options = {}) {
    const body = redactSecrets(String(text ?? '').trim()).text;
    const list = Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string') : [];
    /* 0.13.2 · B2：归属字段是**可选**的（契约：旧调用方两参照旧可用）。
       cwd 为空 ⇒ 整行不出现 cwd/workspaceId（不是 null），读取方按 fail-open 放行。 */
    const cwd = typeof options?.cwd === 'string' && options.cwd.trim() !== ''
        ? resolvePath(options.cwd.trim())
        : null;
    const workspaceId = cwd === null ? null : workspaceIdFromCwd(cwd);
    ensureDir(memoryDir());
    const release = await acquireWriteLock('journal');
    try {
        // ts 在锁内取：并发追加的时间戳天然单调，recall 的「新→旧」顺序不会打架
        const ts = new Date().toISOString();
        const id = entryId(ts, body);
        const record = {
            id,
            ts,
            tags: list,
            text: body,
            ...(cwd === null ? {} : { cwd }),
            ...(workspaceId === null ? {} : { workspaceId }),
        };
        appendFileSync(journalPath(), `${JSON.stringify(record)}\n`, 'utf8');
        return { id, ts, ...(cwd === null ? {} : { cwd }) };
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
                // 归档不丢归属：以后要按工作区审计「这个项目删过哪些日志」还得靠它
                ...(typeof entry.cwd === 'string' && entry.cwd !== '' ? { cwd: entry.cwd } : {}),
                ...(typeof entry.workspaceId === 'string' && entry.workspaceId !== '' ? { workspaceId: entry.workspaceId } : {}),
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
/**
 * JOURNAL 检索（0.10.0 · 契约第 8 节）。
 *
 * 0.9.0 是纯子串 `includes()`：搜「写入侧」搜不到「写侧」，命中没有相关度排序，
 * 半年前的临时笔记和昨天的结论一样重。现在交给 `journal-search.js`：分词 + BM25
 * 打分 × 时效衰减，子串命中给保底。**签名与返回形状不变**（仍是时间正序读入、
 * 返回原条目对象），调用方（tools / panel / client）零改动。
 *
 * 无 query 时保持旧行为（时间倒序）：日志页「最近发生了什么」不该校验相关度。
 */
function searchJournal(query, tag, limit) {
    const { entries } = readJournal(DEFAULT_JOURNAL_LIMIT);
    return rankJournalEntries(entries, { query, tag, limit });
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
/** 重要性的缺省值（`DESIGN v3 §10`）：不写 = 中等，既不高看也不低看。 */
const DEFAULT_IMPORTANCE = 50;
/** 条目分层的合法取值（只作观测，不参与筛选）。 */
const ENTRY_KINDS = ['conclusion', 'detail'];

/**
 * 归一重要性：0–100 整数。
 *
 * **越界收敛、非法回落**：调用方是模型（1–5 分）与人（面板输入），
 * 一个写坏的字段不该让整条元数据作废，更不该抛错阻断写入。
 *
 * @param {any} value
 * @param {number} [fallback] 非法/缺失时的返回值。
 * @returns {number}
 */
function normalizeImportance(value, fallback = DEFAULT_IMPORTANCE) {
    if (value === undefined || value === null || value === '')
        return fallback;
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number))
        return fallback;
    return Math.min(100, Math.max(0, Math.round(number)));
}

/** 归一分层：只认 `conclusion` / `detail`，其它一律回落（缺省 conclusion）。 */
function normalizeKind(value, fallback = 'conclusion') {
    const kind = String(value ?? '').trim().toLowerCase();
    return ENTRY_KINDS.includes(kind) ? kind : fallback;
}

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
                // 0.11 · DESIGN v3 §10：重要性/分层元数据。缺省值在读侧补齐，
                // 老索引零迁移（`importance` 缺失 ⇒ 50，`kind` 缺失 ⇒ conclusion）。
                importance: normalizeImportance(meta.importance),
                kind: normalizeKind(meta.kind),
                /* 0.13.2 · A1：这条 importance 是「人/模型显式打的」还是「写入时补的缺省 50」。
                   冷缺省档只允许删后者；老索引没有这个字段 ⇒ 当作未显式（由 hits/lastHit 兜底），
                   否则整批老记录永远进不了冷缺省档，真实数据就永远 0 候选。 */
                importanceExplicit: meta.importanceExplicit === true,
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
/** 孤儿索引的落盘阈值（0.13.2 · E2）：读路径攒够这么多条才顺手写一次 index.json。 */
const ORPHAN_PRUNE_PERSIST_THRESHOLD = 3;
/**
 * 修剪孤儿：正文被人工改过 ⇒ id 变了 ⇒ 旧记录成了孤儿，读到就丢掉。
 *
 * 索引只存元数据不存正文，所以「这条 id 是否还存在于文件里」只能按行重算 hash。
 * 项目条目靠索引里的 `path` 定位文件（老索引没有 path 时无从判断，保留）。
 *
 * 返回 `{entries, dropped}`：`dropped` 是本次被丢掉的孤儿数，读路径据此决定
 * 要不要把修剪结果落盘（7 条孤儿常驻是 0.11 的实测问题，见 `memoryIndex()`）。
 */
function pruneIndexResult(index) {
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
    return { entries: kept, dropped: Object.keys(index.entries).length - Object.keys(kept).length };
}
/** 兼容旧调用方的薄壳：只要修剪后的 entries（写路径用；它自己会原子写，不额外落盘）。 */
function pruneIndex(index) {
    return pruneIndexResult(index).entries;
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
        const pruned = pruneIndexResult(readIndexRaw());
        const entries = pruned.entries;
        /* 0.13.2 · E2：孤儿过去只在读视图里修剪、从不落盘 ⇒ index.json 里 7 条孤儿常驻，
           每次读都要重算一遍 hash。攒够阈值（3 条）就顺手把修剪结果原子写回；
           只读一个小 JSON，不碰正文，失败静默（索引是派生物，读路径不该因此报错）。 */
        if (pruned.dropped >= ORPHAN_PRUNE_PERSIST_THRESHOLD)
            persistIndex(entries);
        const list = Object.entries(entries).map(([id, meta]) => ({
            id,
            scope: meta.scope,
            workspaceId: meta.workspaceId,
            ts: meta.firstSeen,
            firstSeen: meta.firstSeen,
            lastHit: meta.lastHit,
            hits: meta.hits,
            confidence: meta.confidence,
            // 0.11 · DESIGN v3 §10：面板/命令/压缩层统一从这里读。
            importance: normalizeImportance(meta.importance),
            kind: normalizeKind(meta.kind),
            // 0.13.2 · A1：冷缺省档判定用（见 readIndexRaw 注释）
            importanceExplicit: meta.importanceExplicit === true,
        }));
        // missing：index.json 文件本身不存在（与「存在但为空」区分开，压缩层的报告要用）
        return { version: 1, entries, list, missing: !existsSync(indexPath()) };
    }
    catch {
        return { version: 1, entries: {}, list: [], missing: true };
    }
}
/** 原子写索引（读路径修剪落盘与写路径共用；失败静默，索引只是派生物）。 */
function persistIndex(entries) {
    try {
        writeAtomic(indexPath(), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
        return true;
    }
    catch {
        return false;
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
        /* 0.13.2 · E2：新记录要带 kind / importance（整篇写回过去只写 5 个字段，
           47 条记录缺 importance/kind ⇒ 淘汰层把它们当「缺元数据」永远不删）。
           workspaceId 显式没给时继承**旧记录**：整篇改写不该把条目的工作区归属洗成 null。 */
        const explicitWorkspace = typeof options?.workspaceId === 'string' && options.workspaceId !== ''
            ? options.workspaceId
            : null;
        const explicitImportance = optionalImportance(options?.importance);
        const kind = options?.kind === undefined || options?.kind === null || options?.kind === ''
            ? 'conclusion'
            : normalizeKind(options.kind);
        return mutateIndex((records) => {
            const existing = Object.entries(records);
            const inheritedWorkspace = explicitWorkspace !== null
                ? explicitWorkspace
                : (existing.find(([, meta]) => meta.scope === target
                    && (target !== 'memory' || meta.path === file)
                    && typeof meta.workspaceId === 'string' && meta.workspaceId !== '')?.[1].workspaceId ?? null);
            for (const text of texts) {
                const covered = existing.some(([id, meta]) => meta.scope === target
                    && (target !== 'memory' || meta.path === file)
                    && textIdMatches([text], id, meta));
                if (covered)
                    continue;
                const id = entryId(now, text);
                records[id] = {
                    scope: target,
                    workspaceId: inheritedWorkspace,
                    firstSeen: now,
                    lastHit: now,
                    hits: 1,
                    confidence: 'medium',
                    importance: explicitImportance ?? DEFAULT_IMPORTANCE,
                    importanceExplicit: explicitImportance !== null,
                    kind,
                    ...(target === 'memory' ? { path: file } : {}),
                };
            }
        });
    }
    catch {
        return false;
    }
}

/* ─────────────── 0.11 · 重要性/访问回写（只改侧车索引，不碰正文） ─────────────── */
/**
 * 1–5 星级 ↔ 0–100 重要性（0.13.2 · E1；DESIGN v3 §14.2 的写入映射）：
 * 1→20 / 2→35 / 3→50 / 4→70 / 5→90。模型与面板只报星级，0–100 是存储层内部口径。
 *
 * 非法/越界收敛到 3（缺省中等）：写坏的值不该让条目突然变成最该删/最该保的那一档。
 */
const IMPORTANCE_RATING_MAP = { 1: 20, 2: 35, 3: 50, 4: 70, 5: 90 };
const IMPORTANCE_DEFAULT_RATING = 3;
/** 星级归一：非数字 ⇒ 3；越界收敛到 1–5（四舍五入）。 */
function normalizeImportanceRating(value) {
    if (value === undefined || value === null || value === '')
        return IMPORTANCE_DEFAULT_RATING;
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number))
        return IMPORTANCE_DEFAULT_RATING;
    return Math.min(5, Math.max(1, Math.round(number)));
}
/** 星级 → 0–100（写索引用）。 */
function importanceFromRating(value) {
    return IMPORTANCE_RATING_MAP[normalizeImportanceRating(value)];
}
/**
 * 列出某作用域的条目（正文 + 索引 id），给「按条目打重要性」用。
 *
 * 与 `findEntry()` 同一套 id 口径：索引 id → 内容 id；人工写的条目也能拿到一个 id，
 * 打完分由 `setEntryImportance()` 补记录（hits=0）。
 */
function listEntries(scope, options = {}) {
    const target = normalizeScope(scope);
    const read = readScopeEntries(target, options?.cwd);
    if (read === null)
        return [];
    const index = readIndexRaw();
    return read.entries.map((entry) => ({
        id: resolveKnownId(target, entry.text, index) ?? contentId(entry.text),
        text: entry.text,
        section: entry.section ?? '',
    }));
}
/**
 * 设置一条记忆的重要性（DESIGN v3 §10.3）。
 *
 * 三条纪律：
 *  1. **只改索引**：正文一个字节都不动，所以不需要正文写锁；索引自己 `mutateIndex`
 *     走原子写，与正文写并发时以正文为准（下次 `pruneIndex` 自然收敛）。
 *  2. **找不到就明说**：目标不存在返回 `{ok:false, reason:'not-found'}`，绝不猜、
 *     绝不顺手插入一条新记忆。
 *  3. **人工写的条目也能打分**：索引里没有记录（例如 `memory action=update` 之前手工
 *     写的）时补一条元数据，`firstSeen` 记当前时间、`hits=0`（它确实还没被用过）。
 *
 * @param {'fact'|'memory'|'global'|'project'} scope
 * @param {string} target 索引 id / contentId / 正文
 * @param {number|string} importance 0–100（非法值按 50）
 * @param {{ cwd?: string, at?: number }} [options]
 * @returns {{ ok: boolean, id?: string, importance?: number, reason?: string }}
 */
function setEntryImportance(scope, target, importance, options = {}) {
    const targetScope = normalizeScope(scope);
    const wanted = String(target ?? '').trim();
    if (wanted === '')
        return { ok: false, reason: 'missing-target' };
    const value = normalizeImportance(importance);
    const read = readScopeEntries(targetScope, options?.cwd);
    if (read === null)
        return { ok: false, reason: 'not-found' };
    const located = locateById(targetScope, read.entries, readIndexRaw(), wanted);
    if (located === null)
        return { ok: false, reason: 'not-found' };
    const now = Number.isFinite(options?.at) ? Number(options.at) : Date.now();
    let id = '';
    const changed = mutateIndex((records) => {
        let previousId = '';
        for (const [recordId, meta] of Object.entries(records)) {
            if (meta.scope !== targetScope)
                continue;
            if (recordId === wanted
                || (Number.isFinite(meta.firstSeen) && entryId(meta.firstSeen, located.text) === recordId)) {
                previousId = recordId;
                break;
            }
        }
        const previous = previousId !== '' ? records[previousId] : null;
        id = previousId !== '' ? previousId : entryId(now, located.text);
        records[id] = {
            scope: targetScope,
            workspaceId: previous?.workspaceId
                ?? workspaceIdFromCwd(options?.cwd)
                ?? (targetScope === 'memory' && typeof read.file === 'string' ? workspaceIdFromCwd(dirname(read.file)) : null),
            firstSeen: previous?.firstSeen ?? now,
            lastHit: previous?.lastHit ?? now,
            hits: previous?.hits ?? 0,
            confidence: previous?.confidence ?? 'medium',
            importance: value,
            // 走 setEntryImportance 就是「有人显式打了分」——冷缺省档从此不再碰它
            importanceExplicit: true,
            kind: previous?.kind ?? 'conclusion',
            ...(targetScope === 'memory' ? { path: read.file } : {}),
        };
    });
    if (!changed)
        return { ok: false, reason: 'index-write-failed' };
    return { ok: true, id, importance: value };
}

/**
 * 访问回写（DESIGN v3 §11）：命中一次 ⇒ `hits += 1`、`lastHit = at`。
 *
 * 谁是「命中」由调用方定义（consolidate 用 NOOP/UPDATE 证据）。这里不做语义判断，
 * 也**不写正文**：失败的代价只是排序信号少一条，绝不该影响业务结果。
 *
 * `targets` 兼容 `{scope, id}` 数组、单个对象、字符串 id（按 fact 处理？不：作用域不明
 * 时直接跳过——猜错作用域会把 A 文件的命中记到 B 条目头上）。
 *
 * @param {{ scope: string, id: string }[] | { scope: string, id: string }} targets
 * @param {{ cwd?: string, at?: number }} [options]
 * @returns {{ touched: number }}
 */
function touchEntries(targets, options = {}) {
    const list = Array.isArray(targets) ? targets : (targets === null || targets === undefined ? [] : [targets]);
    const at = Number.isFinite(options?.at) ? Number(options.at) : Date.now();
    const wanted = [];
    for (const item of list) {
        if (item === null || typeof item !== 'object')
            continue;
        const targetScope = normalizeScope(item.scope);
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (id === '' || (targetScope !== 'fact' && targetScope !== 'memory'))
            continue;
        wanted.push({ scope: targetScope, id });
    }
    if (wanted.length === 0)
        return { touched: 0 };
    const index = readIndexRaw();
    const cache = new Map();
    const resolved = [];
    for (const item of wanted) {
        const direct = index.entries[item.id];
        if (direct !== undefined && direct.scope === item.scope) {
            resolved.push({ scope: item.scope, id: item.id });
            continue;
        }
        // 不是索引键：按 contentId 回到正文里认人（pool 里的 id 就是 contentId）。
        if (!cache.has(item.scope)) {
            const read = readScopeEntries(item.scope, options?.cwd);
            cache.set(item.scope, read === null ? [] : read.entries);
        }
        const hit = cache.get(item.scope).find((entry) => contentId(entry.text) === item.id);
        if (hit === undefined)
            continue;
        const known = Object.entries(index.entries).find(([recordId, meta]) => meta.scope === item.scope
            && Number.isFinite(meta.firstSeen) && entryId(meta.firstSeen, hit.text) === recordId);
        resolved.push({ scope: item.scope, id: known?.[0] ?? entryId(at, hit.text) });
    }
    if (resolved.length === 0)
        return { touched: 0 };
    let touched = 0;
    const changed = mutateIndex((records) => {
        for (const item of resolved) {
            const previous = records[item.id];
            records[item.id] = previous === undefined
                ? {
                    scope: item.scope,
                    // 访问回写补记录时也带归属，避免这些记录永久进不了工作区保护区
                    workspaceId: workspaceIdFromCwd(options?.cwd),
                    firstSeen: at,
                    lastHit: at,
                    hits: 1,
                    confidence: 'medium',
                    importance: DEFAULT_IMPORTANCE,
                    importanceExplicit: false,
                    kind: 'conclusion',
                }
                : { ...previous, hits: (Number.isFinite(previous.hits) ? previous.hits : 0) + 1, lastHit: at };
            touched += 1;
        }
    });
    return { touched: changed ? touched : 0 };
}

/* ─────────────────────────── 条目切分 ─────────────────────────── */
/** 按行切（去掉末尾空行，`\r\n` 归一化）。 */
function splitLines(text) {
    const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
    while (lines.length > 0 && lines[lines.length - 1] === '')
        lines.pop();
    return lines;
}
/**
 * FACT 条目：`- ` 行，保留所属 `##` 分组名。`line` 是 0 基行号。
 *
 * 0.10 起 `text` 是**剥离行尾状态注释后的纯正文**，`state` 是解析出的生命周期状态
 * （没有注释 ⇒ `active`）。为什么必须剥：条目 id 是 `entryId(ts, text)`，正文里带着
 * 注释算 id 的话，`supersedeEntry` 一加注释 id 就变，索引里的元数据全成孤儿、
 * 压缩层的淘汰候选直接归零。
 */
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
        const parsed = parseEntryState(bullet[1]);
        entries.push({ line: index, section, text: parsed.text.trim(), state: parsed.state });
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
            const parsed = parseEntryState(numbered[3]);
            entries.push({ line: index, section, indent: numbered[1], number: Number(numbered[2]), text: parsed.text.trim(), state: parsed.state });
            continue;
        }
        const bullet = /^-\s+(.+)$/.exec(lines[index]);
        if (bullet !== null) {
            const parsed = parseEntryState(bullet[1]);
            entries.push({ line: index, section, indent: '', bullet: true, text: parsed.text.trim(), state: parsed.state });
        }
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
/**
 * 写前备份到 `memory/backups/auto/<文件名>-<yyyyMMdd-HHmmssSSS>.bak`（0.9.0 · P1-4）。
 *
 * 与压缩备份（`memory/backups/` 根，秒级戳）**分家**：条目级备份每写一次就多一份，
 * 过去和压缩备份混在同一个目录里、又被压缩侧按「前缀 + 字符串排序」修剪，结果
 * 「压缩备份被条目级备份挤掉 ⇒ rollback 找不到备份」。现在各自目录、各自修剪。
 */
function backupFile(file) {
    const raw = readText(file);
    if (raw === null || raw === '')
        return null;
    const now = new Date();
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;
    const target = join(autoBackupsDir(), `${basename(file)}-${stamp}.bak`);
    try {
        writeAtomic(target, raw);
        pruneSameFile(file);
        return target;
    }
    catch {
        return null;
    }
}
/**
 * 只留同一文件最近的 N 份自动备份（0.9.0 · P1-4；返回删掉的份数）。
 *
 * 只在 `backups/auto/` 里按文件名前缀找自己那一族（时间戳定宽 ⇒ 字符串序 = 时间序），
 * 绝不去碰压缩侧的备份。
 */
function pruneSameFile(file, keep = autoBackupKeep) {
    const limit = typeof keep === 'number' && Number.isFinite(keep) && keep >= 1
        ? Math.trunc(keep)
        : DEFAULT_KEEP_AUTO_BACKUPS;
    let names;
    try {
        names = readdirSync(autoBackupsDir());
    }
    catch {
        return 0;
    }
    const name = basename(file);
    const mine = names
        .filter((item) => item.startsWith(`${name}-`) && item.endsWith('.bak'))
        .sort();
    const extra = mine.slice(0, Math.max(0, mine.length - limit));
    let removed = 0;
    for (const item of extra) {
        try {
            rmSync(join(autoBackupsDir(), item), { force: true });
            removed += 1;
        }
        catch {
            /* 删不掉就留着：多一份备份不影响正确性 */
        }
    }
    return removed;
}
/* ─────────────────────────── 写锁（进程内互斥） ─────────────────────────── */
const writeLocks = new Map();
/**
 * 锁键：`fact` / `journal` / `memory:<目标文件路径>`（0.9.0 · P0-3）。
 *
 * 为什么 memory 作用域必须按**文件**取键，而不是按 cwd 推导的项目根：
 * 同一个 MEMORY.md 有两类写者 —— 面板（只带 `path`、不带 cwd）与工具/沉淀
 * （只带 `cwd`）。按 cwd 推导时面板那边拿不到 cwd ⇒ 键恒为 `memory:`，
 * 两把互不阻塞的 mutex 保护同一个文件 ⇒ 「读-改-写」交错、后写者整篇覆盖前者
 * 且不报错。现在两条路径都归一到 `resolvePath(目标文件)`：
 * `targetFile('memory', cwd)`（写入侧的同一函数）与显式 `options.path` 必然相等。
 */
function lockKey(scope, options = {}) {
    const target = normalizeScope(scope);
    if (target === 'fact')
        return 'fact';
    if (target === 'journal')
        return 'journal';
    const explicit = typeof options?.path === 'string' && options.path !== ''
        ? options.path
        : (typeof options?.file === 'string' && options.file !== '' ? options.file : '');
    const file = explicit !== '' ? resolvePath(explicit) : targetFile('memory', options?.cwd);
    return `memory:${file === null ? '' : resolvePath(file)}`;
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
 * 找一条正文在索引里的旧记录（`{ id, meta }` 或 null）。
 *
 * `wanted` 可能是索引 id、contentId、甚至规范化文本（`locateById` 的三级兜底），
 * 所以先按 id 直查，再按 `entryId(firstSeen, text)` 反算。改写时要靠它继承
 * importance（DESIGN v3 §10.3：未带 importance 的 replace 不降级旧值）。
 */
function findIndexRecord(scope, text, wanted = '') {
    const index = readIndexRaw();
    const direct = wanted !== '' ? index.entries[wanted] : undefined;
    if (direct !== undefined && direct.scope === scope)
        return { id: wanted, meta: direct };
    for (const [id, meta] of Object.entries(index.entries)) {
        if (meta.scope !== scope || !Number.isFinite(meta.firstSeen))
            continue;
        if (entryId(meta.firstSeen, text) === id)
            return { id, meta };
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
            return { id: text, line: hit.line, text: hit.text, section: hit.section ?? '', state: hit.state ?? { status: STATE_ACTIVE, by: '', since: '' } };
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
        // 0.10：只**新增**字段，旧字段与旧语义一律不动（consolidate / recall 按需读）
        state: matched.entry.state ?? { status: STATE_ACTIVE, by: '', since: '' },
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
/**
 * 可选的重要性：**没写 ≠ 写错**。
 *
 * `insertEntry` 里没写 ⇒ 缺省 50；`replaceEntry` 里没写 ⇒ 沿用旧记录的 importance
 * （改写正文不该把「这条很重要」悄悄降成中等）。所以这里保留 null 表示「未指定」，
 * 非法值也按未指定处理（写坏的字段宁可回落，也不该把旧值抹掉）。
 */
function optionalImportance(value) {
    if (value === undefined || value === null || value === '')
        return null;
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? normalizeImportance(number) : null;
}
function normalizeEntryInput(raw) {
    if (typeof raw === 'string')
        return { text: stripListMarker(raw), confidence: 'medium', workspaceId: null, section: '', importance: null, kind: null };
    if (raw !== null && typeof raw === 'object') {
        return {
            text: typeof raw.text === 'string' ? stripListMarker(raw.text) : '',
            confidence: typeof raw.confidence === 'string' ? raw.confidence : 'medium',
            workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : null,
            section: typeof raw.section === 'string' ? raw.section.trim() : '',
            importance: optionalImportance(raw.importance),
            kind: raw.kind === undefined || raw.kind === null || raw.kind === '' ? null : normalizeKind(raw.kind),
        };
    }
    return { text: '', confidence: 'medium', workspaceId: null, section: '', importance: null, kind: null };
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
    if (target === 'memory') {
        // 0.8.6：项目记忆改成「跟工作区文件夹走」——cwd 就是项目根，文件不存在时**首次写入即创建**。
        // 旧行为要求 cwd 下（或上层）已经有一份 MEMORY.md，等于「项目记忆必须手工先建」，
        // 自动沉淀永远长不出来。仍然拒绝 home / 根目录当项目根，避免写错位置。
        const root = typeof options?.cwd === 'string' && options.cwd.trim() !== '' ? resolvePath(options.cwd) : '';
        if (root === '')
            return reject('project 条目缺少工作目录（cwd）', 'journal');
        // 根目录判定要跨平台：Windows 下 resolve('/') 是「当前盘根」(D:\)，它既不等于
        // '/' 也不等于 homedir —— 只在 POSIX 上成立的字面比较会放过盘根。
        if (parsePath(root).root === root || root === homedir())
            return reject('拒绝把 home / 根目录当作项目根', 'journal');
    }
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
    const pre = await compactBeforeWrite(target, cwd);
    const compactionFailure = pre?.failure ?? null;
    const release = await acquireWriteLock(target, { cwd, path: file, timeoutMs: options?.timeoutMs });
    try {
        const current = readText(file) ?? '';
        const next = target === 'fact'
            ? insertFactLine(current, entry.text, entry.section)
            : insertMemoryLine(current, entry.text);
        try {
            if (target === 'fact')
                assertFactWithinLimit(next, storeLimits.maxFactLines, storeLimits.maxFactBytes);
            else
                assertProjectMemoryWithinLimit(next, storeLimits.maxProjectChars);
        }
        catch (error) {
            throw attachCompactionFailure(error, compactionFailure);
        }
        backupFile(file);
        writeAtomic(file, next);
        const ts = Date.now();
        const id = entryId(ts, entry.text);
        mutateIndex((entries) => {
            entries[id] = {
                scope: target,
                // 0.13.2 · B2：没显式给归属时按 cwd 归一（项目条目沿用会话工作区）
                workspaceId: entry.workspaceId ?? workspaceIdFromCwd(cwd),
                firstSeen: ts,
                lastHit: ts,
                hits: 1,
                confidence: entry.confidence,
                // 0.11 · DESIGN v3 §10：写入侧带的重要性落进侧车索引（不动正文）。
                importance: entry.importance ?? DEFAULT_IMPORTANCE,
                importanceExplicit: entry.importance !== null,
                kind: entry.kind ?? 'conclusion',
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
    const file = targetFile(target, cwd);
    if (file === null)
        return { written: false, notFound: true };
    const pre = await compactBeforeWrite(target, cwd);
    const compactionFailure = pre?.failure ?? null;
    const release = await acquireWriteLock(target, { cwd, path: file, timeoutMs: options?.timeoutMs });
    try {
        const current = readText(file);
        if (current === null)
            return { written: false, notFound: true };
        const entries = target === 'fact' ? factEntries(current) : memoryEntries(current);
        const located = locateById(target, entries, readIndexRaw(), wanted);
        if (located === null)
            return { written: false, notFound: true };
        const lines = splitLines(current);
        const rewritten = target === 'fact' || located.bullet === true
            ? `- ${entry.text}`
            : `${located.indent ?? ''}${located.number}. ${entry.text}`;
        // 0.10：改写正文**必须保留状态**。旧实现直接把整行换成新正文，一条 superseded
        // 条目被 replaceEntry 改一行就悄悄回到 active（重新开始注入），而调用方毫无感知。
        lines[located.line] = applyEntryState(rewritten, located.state ?? { status: STATE_ACTIVE });
        const next = `${lines.join('\n')}\n`;
        try {
            if (target === 'fact')
                assertFactWithinLimit(next, storeLimits.maxFactLines, storeLimits.maxFactBytes);
            else
                assertProjectMemoryWithinLimit(next, storeLimits.maxProjectChars);
        }
        catch (error) {
            throw attachCompactionFailure(error, compactionFailure);
        }
        backupFile(file);
        writeAtomic(file, next);
        const ts = Date.now();
        const newId = entryId(ts, entry.text);
        // 0.11 · DESIGN v3 §10.3：改写正文时**未指定** importance 就沿用旧记录，
        // 否则「把一条重要结论补全个错别字」会把它降成中等、优先被压缩淘汰。
        const previous = findIndexRecord(target, located.text, wanted);
        mutateIndex((indexEntries) => {
            delete indexEntries[wanted];
            if (previous !== null)
                delete indexEntries[previous.id];
            indexEntries[newId] = {
                scope: target,
                workspaceId: entry.workspaceId ?? workspaceIdFromCwd(cwd) ?? previous?.meta?.workspaceId ?? null,
                firstSeen: ts,
                lastHit: ts,
                hits: 1,
                confidence: entry.confidence,
                importance: entry.importance ?? previous?.meta?.importance ?? DEFAULT_IMPORTANCE,
                // 显式标记跟着「这一次有没有人主动打分」走，否则改写一次就把冷缺省资格洗白/误标
                importanceExplicit: entry.importance !== null ? true : previous?.meta?.importanceExplicit === true,
                kind: entry.kind ?? previous?.meta?.kind ?? 'conclusion',
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
    const file = targetFile(target, cwd);
    if (file === null)
        return { deleted: false };
    const release = await acquireWriteLock(target, { cwd, path: file, timeoutMs: options?.timeoutMs });
    try {
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
/* ─────────────────── 条目状态写入（supersede / restore · 0.10） ─────────────────── */
/**
 * target 归一化：`{id} | {number} | {text}`（也收裸字符串 / 数字，脚本里顺手）。
 *
 * 10 位十六进制字符串先按 id 试、再按正文找：`entryId()` / `contentId()` 的形状是
 * 固定的 10 位 hex，命中就是命中，不算「猜用户想改哪条」。
 */
function normalizeTarget(target) {
    if (target === null || target === undefined)
        return null;
    if (typeof target === 'number' && Number.isFinite(target))
        return { number: Math.trunc(target) };
    if (typeof target === 'string') {
        const text = target.trim();
        if (text === '')
            return null;
        return /^[0-9a-f]{10}$/i.test(text) ? { id: text, text } : { text };
    }
    if (typeof target !== 'object')
        return null;
    if (typeof target.id === 'string' && target.id.trim() !== '')
        return { id: target.id.trim() };
    if (typeof target.number === 'number' && Number.isFinite(target.number))
        return { number: Math.trunc(target.number) };
    if (typeof target.text === 'string' && target.text.trim() !== '')
        return { text: target.text.trim() };
    return null;
}
/**
 * 在条目数组里定位 target。**找不到就是 not-found，绝不模糊到「大概是这条」**。
 *
 * - `{id}`：索引 id → 内容 id → 把 id 当规范化正文（`locateById()` 的既有三级兜底）；
 * - `{number}`：MEMORY 的编号（`3. 结论` 里的 3）；FACT 没有编号，退化为**条目序号**
 *   （文件里的第 N 条，1 基）；
 * - `{text}`：规范化后**精确相等**优先；不一致时只接受「唯一包含」——
 *   包含到多条说明这句话是好几条结论的共同片段，此时宁可不改（`ambiguous`）。
 */
function resolveEntryTarget(scope, entries, index, target) {
    const spec = normalizeTarget(target);
    if (spec === null)
        return { ok: false, reason: 'bad-target' };
    if (typeof spec.id === 'string') {
        const hit = locateById(scope, entries, index, spec.id);
        if (hit !== null)
            return { ok: true, entry: hit };
        if (typeof spec.text !== 'string')
            return { ok: false, reason: 'not-found' };
    }
    if (typeof spec.number === 'number') {
        const numbered = entries.filter((entry) => Number.isFinite(entry.number));
        const hit = numbered.length > 0
            ? numbered.find((entry) => entry.number === spec.number)
            : entries[spec.number - 1];
        return hit === undefined ? { ok: false, reason: 'not-found' } : { ok: true, entry: hit };
    }
    const needle = normalizeEntryText(spec.text);
    if (needle === '')
        return { ok: false, reason: 'not-found' };
    const exact = entries.filter((entry) => normalizeEntryText(entry.text) === needle);
    if (exact.length > 0)
        return { ok: true, entry: exact[0] };
    const contained = entries.filter((entry) => normalizeEntryText(entry.text).includes(needle));
    if (contained.length === 1)
        return { ok: true, entry: contained[0] };
    if (contained.length > 1)
        return { ok: false, reason: 'not-found', ambiguous: true, candidates: contained.length };
    return { ok: false, reason: 'not-found' };
}
/**
 * 写入后的回读：`text` 用条目切分时的**纯正文**（与 `findEntry()` 同一口径），
 * `state` 用落盘那一行重新解析 —— 不回带调用方的意图（比如传了 status 但没写成）。
 */
function stateEntry(line, entry, id) {
    return { id, line: entry.line, text: entry.text, state: parseEntryState(line).state };
}
/**
 * supersede / restore 的共同写路径：{ 写前压缩（仅 supersede）→ 锁 → 重读 → revision
 * → 定位 → 只改目标那一行的行尾 → 卡上限 → 备份 → 原子写 }。
 *
 * 三条纪律：
 *  1. **只动目标行的行尾**：正文、行号、缩进、编号一个字节都不碰（`applyEntryState()`
 *     负责这件事），所以「失效不删除」在字节层面成立（只增不减）；
 *  2. **与 insertEntry 同一把锁**：`lockKey()` 按**目标文件**归一，面板 / 工具 / 压缩
 *     管线都排队，避免「读-改-写」交错；
 *  3. **revision 先校验再改写**：给了 `expectedRevision` 就是乐观锁，过期直接抛
 *     `MEMORY_REVISION_CONFLICT`，磁盘保持原样。
 */
async function writeEntryState(scope, target, options = {}) {
    const targetScope = normalizeScope(scope);
    if (targetScope !== 'fact' && targetScope !== 'memory')
        return { ok: false, reason: 'bad-scope' };
    const cwd = options?.cwd;
    const file = targetFile(targetScope, cwd);
    if (file === null)
        return { ok: false, reason: 'no-project' };
    const expected = typeof options?.expectedRevision === 'string' && options.expectedRevision.trim() !== ''
        ? options.expectedRevision.trim()
        : null;
    const release = await acquireWriteLock(targetScope, { cwd, path: file, timeoutMs: options?.timeoutMs });
    try {
        const current = readText(file);
        if (current === null)
            return { ok: false, reason: 'not-found' };
        const actual = contentRevision(current);
        if (expected !== null && expected !== actual)
            throw revisionConflictError(file, expected, actual, targetScope);
        const entries = targetScope === 'fact' ? factEntries(current) : memoryEntries(current);
        const index = readIndexRaw();
        const located = resolveEntryTarget(targetScope, entries, index, target);
        if (located.ok !== true)
            return located;
        // 回带的 id 与 `findEntry()` 同源（索引 id → 内容 id），调用方能直接拿去再操作
        const resolvedId = resolveKnownId(targetScope, located.entry.text, index) ?? contentId(located.entry.text);
        const lines = splitLines(current);
        const before = lines[located.entry.line];
        const after = applyEntryState(before, options?.state ?? { status: STATE_ACTIVE });
        if (after === before) {
            // 已经是目标状态（重复 supersede / 重复 restore）：幂等成功，不产生一次空备份
            return {
                ok: true,
                unchanged: true,
                path: file,
                entry: stateEntry(before, located.entry, resolvedId),
                revision: actual,
            };
        }
        lines[located.entry.line] = after;
        const next = `${lines.join('\n')}\n`;
        try {
            if (targetScope === 'fact')
                assertFactWithinLimit(next, storeLimits.maxFactLines, storeLimits.maxFactBytes);
            else
                assertProjectMemoryWithinLimit(next, storeLimits.maxProjectChars);
        }
        catch (error) {
            throw attachCompactionFailure(error, options?.compactionFailure ?? null);
        }
        backupFile(file);
        writeAtomic(file, next);
        return {
            ok: true,
            unchanged: false,
            path: file,
            entry: stateEntry(after, located.entry, resolvedId),
            revision: contentRevision(next),
        };
    }
    finally {
        release();
    }
}
/**
 * 把一条结论标记为 `superseded`（被新结论取代）：**只加行尾注释，不改正文、不删行**。
 *
 * 为什么不是直接删掉：文件即真源。过时结论留在文件里可审计、可 `restoreEntry()` 恢复；
 * 而它在注入 / 召回里已经不可见了。删除只发生在压缩层（真到了预算上限时），
 * 而且是 `superseded` 优先被淘汰。
 *
 * `options`：`{by, at, cwd, expectedRevision, timeoutMs}`。
 *  - `by` = 取代它的条目 id（可省）；
 *  - `at` = `since` 的日期（`YYYY-MM-DD` / Date / 毫秒，缺省今天）。
 *
 * 返回 `{ok:true, path, entry:{line,text,state}, revision}` 或 `{ok:false, reason}`；
 * `reason` 取值：`not-found` / `bad-target` / `bad-scope` / `no-project`（外加
 * `ambiguous:true` 说明「包含匹配命中了多条」）。找不到就是找不到，不猜。
 */
async function supersedeEntry(scope, target, options = {}) {
    const targetScope = normalizeScope(scope);
    // 作用域先判：`journal` 之类不该走到压缩器那儿去敲门
    if (targetScope !== 'fact' && targetScope !== 'memory')
        return { ok: false, reason: 'bad-scope' };
    // 写前敲门：行尾注释会加字符，水位已经很高时先让压缩层腾地方（与 insertEntry 同姿势，
    // 压缩在锁外做；压缩失败只记 warn + 挂 details，不阻断这次写入）。
    const pre = await compactBeforeWrite(targetScope, options?.cwd, 'supersede');
    return writeEntryState(targetScope, target, {
        ...options,
        compactionFailure: pre?.failure ?? null,
        state: {
            status: 'superseded',
            by: typeof options?.by === 'string' ? options.by.trim() : '',
            since: formatStateDate(options?.at),
        },
    });
}
/**
 * 把一条结论恢复成 `active`（摘掉状态注释）。
 *
 * 与 supersede 的两点差别：
 *  1. **不做写前压缩**：restore 只会让文件变小，没有压缩的必要；而且压缩层优先淘汰
 *     superseded 条目，敲门反而可能先把「正要恢复的那一条」删掉；
 *  2. 文件字节会减少（摘掉注释），这是恢复语义的一部分。
 */
async function restoreEntry(scope, target, options = {}) {
    return writeEntryState(normalizeScope(scope), target, { ...options, state: { status: STATE_ACTIVE } });
}
/**
 * 整篇覆盖「丢条目」错误（0.13.2 · A2）。
 *
 * 场景：注入侧先 `stripSuperseded` 把失效条目滤掉，模型只看过滤视图就整篇回写 ——
 * 注释丢了（失效条目复活、污染注入），行少了（真删条目、丢掉教训）。两种都是静默的，
 * 所以落盘前 diff 条目数与 dormant 数，数量下降就拒写，`force: true` 才放行。
 */
function overwriteLossyError(file, scope, before, after) {
    const error = new Error([
        `整篇覆盖会让记忆条目变少，已拒绝写入：${file}`,
        `- 条目数：${before.entries} → ${after.entries}；失效（dormant）数：${before.dormant} → ${after.dormant}。`,
        '- 常见原因：注入侧只给了过滤后的视图（失效条目不显示），模型按那个视图回写就丢了行；或者漏抄了旧内容。',
        '- 请先 action=read 拿到完整正文，把要保留的改动合并进去后再写。',
        '- 确实要删条目时，显式传 force: true（会跳过这条防呆检查）。',
    ].join('\n'));
    error.code = 'MEMORY_OVERWRITE_LOSSY';
    error.status = 409;
    error.details = { scope, path: file, entries: before.entries === after.entries ? undefined : { before: before.entries, after: after.entries }, dormant: before.dormant === after.dormant ? undefined : { before: before.dormant, after: after.dormant } };
    return error;
}
/**
 * 整篇覆盖前的防呆：条目数 / dormant 数**任一**下降就拒写（`force` 放行）。
 *
 * 为什么 diff 用「条目数」而不是「字节数」：把五条合并成三条是正常压缩（条目变少但
 * 信息还在），但**整篇覆盖**不是压缩器，它只是把一份文档写回去 —— 条目变少只有两种
 * 解释：想删（那就显式 force），或丢了（必须拒）。
 */
function assertOverwriteNotLossy(target, file, current, next, options = {}) {
    if (options?.force === true)
        return;
    const parse = target === 'fact' ? factEntries : memoryEntries;
    const beforeEntries = parse(current ?? '');
    const afterEntries = parse(next ?? '');
    const before = {
        entries: beforeEntries.length,
        dormant: beforeEntries.filter((entry) => isDormantState(entry.state)).length,
    };
    const after = {
        entries: afterEntries.length,
        dormant: afterEntries.filter((entry) => isDormantState(entry.state)).length,
    };
    if (after.entries >= before.entries && after.dormant >= before.dormant)
        return;
    throw overwriteLossyError(file, target, before, after);
}
/**
 * 乐观锁冲突错误（`replaceDocument` 与 supersede/restore 共用一份文案）。
 *
 * 文案必须说清「为什么拒写」与「下一步怎么办」：这是**唯一**会因为并发而拒写的错误，
 * 模型看到它时最需要的不是错误码，而是「重读 → 合并 → 再写」这条动作。
 */
function revisionConflictError(file, expected, actual, scope = null) {
    const error = new Error([
        `记忆文件已被别处修改，本次写入已拒绝（revision 冲突）：${file}`,
        `- 你手里的版本：${expected}；磁盘上的当前版本：${actual}。`,
        `- 常见来源：同一时刻的 memory action=update、另一个面板保存、压缩管线或自动沉淀。`,
        `- 请重新读取最新内容，把要保留的改动合并进去后再写。直接硬写会静默丢掉别人的改动，所以这里不写。`,
    ].join('\n'));
    error.code = 'MEMORY_REVISION_CONFLICT';
    error.status = 409;
    error.details = { scope, path: file, expectedRevision: expected, actualRevision: actual };
    return error;
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
 * `expectedRevision` 省略 ⇒ 只加锁、不校验（**工具层已改为必填**，store 层保持宽容
 * 以兼容内部调用方）；给了但和磁盘上的当前修订号不一致 ⇒ 抛
 * `MEMORY_REVISION_CONFLICT`，**绝不硬写**。乐观锁的意义就是让「拿着旧内容整篇覆盖」
 * 这件事失败得响亮，而不是安静地丢掉别人的改动。
 *
 * 0.13.2 · A2 追加防呆：落盘前 diff 条目数 / dormant 数，任一减少 ⇒
 * `MEMORY_OVERWRITE_LOSSY`（`force: true` 放行）。它挡的是「拿过滤视图回写把条目写没」，
 * 与乐观锁（挡并发）是两件事，所以两条都要。
 */
async function replaceDocument(scope, file, content, options = {}) {
    const target = normalizeScope(scope);
    const cwd = options?.cwd;
    const expected = typeof options?.expectedRevision === 'string' && options.expectedRevision.trim() !== ''
        ? options.expectedRevision.trim()
        : null;
    /* 0.9.0 · P1-3：闸口按**最终落盘文本**再校验一次。
       过去只有 tools / panel 各自先 `assert*WithinLimit(content)`、再
       `ensureTrailingNewline(content)` 落盘 —— 末位换行会让「恰好等于上限」变成
       「落盘后超 1 字节」，而且 `replaceDocument` 是唯一没有闸口的写入口，
       契约全靠调用方自觉。这里兜住所有调用方（含未来的）。 */
    if (target === 'fact')
        assertFactWithinLimit(typeof content === 'string' ? content : String(content ?? ''), storeLimits.maxFactLines, storeLimits.maxFactBytes);
    else if (target === 'memory')
        assertProjectMemoryWithinLimit(typeof content === 'string' ? content : String(content ?? ''), storeLimits.maxProjectChars);
    const release = await acquireWriteLock(target, { cwd, path: file, timeoutMs: options?.timeoutMs });
    try {
        const current = readText(file) ?? '';
        const actual = contentRevision(current);
        if (expected !== null && expected !== actual)
            throw revisionConflictError(file, expected, actual, target);
        // 0.13.2 · A2：乐观锁挡的是「并发」，这里挡的是「拿着过滤视图整篇回写把条目写没」。
        assertOverwriteNotLossy(target, file, current, typeof content === 'string' ? content : String(content ?? ''), options);
        backupFile(file);
        writeAtomic(file, content);
        /* 0.13.2 · B2：整篇覆盖后同步索引也要带归属 —— 面板只给路径、工具给 cwd，
           两条路都归一到同一套 workspaceId（项目文件按项目根、全局按会话 cwd）。 */
        const workspaceId = options?.workspaceId !== undefined && options.workspaceId !== null
            ? options.workspaceId
            : (workspaceIdFromCwd(options?.cwd)
                ?? (target === 'memory' ? workspaceIdFromCwd(dirname(file)) : null));
        syncIndexAfterWrite(target, file, content, { workspaceId });
        return { written: true, revision: contentRevision(content), previousRevision: actual, target: file };
    }
    finally {
        release();
    }
}
export {
    DEFAULT_IMPORTANCE,
    DEFAULT_JOURNAL_LIMIT,
    DEFAULT_KEEP_AUTO_BACKUPS,
    FACT_FILE,
    JOURNAL_FILE,
    PROJECT_MEMORY_FILE,
    acquireWriteLock,
    appendJournal,
    assertEntry,
    assertFactWithinLimit,
    assertProjectMemoryWithinLimit,
    autoBackupsDir,
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
    gitOriginOf,
    indexPath,
    insertEntry,
    importanceFromRating,
    isBudgetError,
    journalArchivePath,
    journalPath,
    limits,
    listEntries,
    normalizeImportanceRating,
    listJournal,
    lockKey,
    memoryDir,
    memoryIndex,
    mutateIndex,
    pruneSameFile,
    readJournal,
    readText,
    redactSecrets,
    replaceDocument,
    replaceEntry,
    restoreEntry,
    searchJournal,
    setEntryImportance,
    supersedeEntry,
    supersedeJournal,
    syncIndexAfterWrite,
    templates,
    touchEntries,
    validateEntry,
    watermark,
    writeAtomic,
};
