/**
 * @dsh-external/dsh-persona-memory — 压缩管线（0.8.0 · P4）。
 *
 * 设计见 PLAN/01 §4。这里是**纯逻辑 + I/O**，不含任何插件接线：
 * `lib/index.js` 负责配置、命令与面板路由，`lib/store.js` 负责在写入前敲门。
 *
 * ```
 * 水位 < 85%          → 正常写
 * 85% ~ 100%          → B 合并（FACT 合并同组条目；MEMORY 只合并同一段落里的**叶子条目**，
 *                        编号与子项层级不动）
 * 合并后仍 ≥ 100%     → A 淘汰（FACT 与 MEMORY 都做）
 * 淘汰后仍 ≥ 100%     → C 停手（返回 MEMORY_BUDGET_EXCEEDED，调用方降级 JOURNAL）
 * ```
 *
 * 三条不可动的边界：
 *  1. **默认开启**（0.7.1 起）：本文件不知道配置，是否启用由 `store.configureStore({compactionEnabled})`
 *     与 `index.js` 的命令/面板入口决定；关闭时写路径与 0.7.0 逐字节相同。
 *  2. **保护区只认人**：显式锁定（`lib/locks.js`）与正文里的 `<!-- keep -->`。
 *     `★` 开头**不是**人工标记（01 §4.4 更正），绝不参与评分加权以外的任何豁免。
 *  3. **宁可不压缩，也不盲删**：侧车索引 `memory/index.json` 缺失/损坏 ⇒ 淘汰整体跳过。
 *
 * 并发：LLM 合并**在写锁外**完成，进锁后重新读全文，与计划时的 pre-image 不一致就
 * 放弃本轮（防覆盖并发写入）；应用是**一次原子写**，写前先备份。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { listLocks, readLocks } from './locks.js';
import {
    acquireWriteLock,
    countBytes,
    countChars,
    countLines,
    ensureDir,
    entryId,
    memoryDir,
    memoryIndex,
    mutateIndex,
    readText,
    watermark,
    writeAtomic,
} from './store.js';

/* ────────────────────────────── 常量 ────────────────────────────── */
/** 触发压缩的水位（85%）。 */
const TRIGGER_RATIO = 0.85;
/** 淘汰停手的水位（75%，留缓冲，别每次贴边）。 */
const TARGET_RATIO = 0.75;
/** 一次最多淘汰几条。 */
const MAX_EVICTIONS = 5;
/** 合并结果的长度上限（字）。 */
const MERGE_MAX_CHARS = 120;
/** 合并候选的语义相似度阈值（归一化到 0–1 后比较，见 00 §9 审计项）。 */
const MERGE_THRESHOLD = 0.7;
/** 每轮最多合并几组。 */
const MERGE_MAX_GROUPS = 3;
/** 一组的条目数区间。 */
const MERGE_GROUP_MIN = 2;
const MERGE_GROUP_MAX = 10;
/** 备份默认保留份数。 */
const DEFAULT_KEEP_BACKUPS = 5;
/** 单次 LLM 调用的超时（毫秒，宿主 M0 结论建议 20s）。 */
const DEFAULT_CALL_TIMEOUT = 20000;
/** 显式豁免标记。 */
const KEEP_MARKER = '<!-- keep -->';
/** 审计流水（JSONL）。 */
const AUDIT_FILE = 'compaction.jsonl';
/** 备份目录名（与 store 的 `backupsDir()` 同一个）。 */
const BACKUP_DIR = 'backups';
/** 评分窗口：90 天前最后命中 ⇒ 近因分 0。 */
const RECENCY_WINDOW_DAYS = 90;
/** 命中次数达到这个值即满分。 */
const HITS_FULL = 10;
/** 置信度映射（未知/缺省 ⇒ 保守满分，即倾向于"不淘汰"）。 */
const CONFIDENCE_SCORES = { high: 1, medium: 0.5, low: 0.2 };
/** 评分权重（01 §4.4）：近因 0.4 / 命中 0.3 / 置信度 0.2 / 人工标记 0.1。 */
const WEIGHTS = { recency: 0.4, hits: 0.3, confidence: 0.2, manualLock: 0.1 };
/** BM25 参数（与附属 recall 插件同源，见 §分词 注释）。 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/* ────────────────────────────── 小工具 ────────────────────────────── */
function normalizeScope(scope) {
    const raw = String(scope ?? '').trim().toLowerCase();
    if (raw === 'fact' || raw === 'global')
        return 'fact';
    if (raw === 'memory' || raw === 'project')
        return 'memory';
    return raw;
}

function splitLines(text) {
    const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
    while (lines.length > 0 && lines[lines.length - 1] === '')
        lines.pop();
    return lines;
}

function clamp01(value) {
    if (!Number.isFinite(value))
        return 0;
    if (value < 0)
        return 0;
    if (value > 1)
        return 1;
    return value;
}

function sha256(text) {
    return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function newRunId() {
    return `${Date.now().toString(36)}-${createHash('sha1').update(`${Math.random()}${process.hrtime.bigint()}`).digest('hex').slice(0, 6)}`;
}

/** 备份文件名里的时间戳：`yyyyMMdd-HHmmss`。 */
function stampOf(date) {
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 一段正文的体量。`chars` 与 `store.countChars()` 同口径（trim 后长度）。 */
function measuresOf(text) {
    return { lines: countLines(text), bytes: countBytes(text), chars: countChars(text) };
}

/** 一份体量 + 上限 → 水位视图（形状与 `store.watermark()` 一致，可直接喂 `ratioOf`）。 */
function withLimit(measures, limit) {
    return { lines: measures.lines, bytes: measures.bytes, chars: measures.chars, limit: limit ?? {} };
}

/**
 * 水位比例：`max(各维度实际值 / 各自上限)`。
 *
 * FACT 是**行数与字节双闸口**、且字节先到顶（01 §4.1），所以必须取最大值而不是只看一个；
 * MEMORY 只有字符闸口，自然退化成字符比。
 */
function ratioOf(view) {
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

function round3(value) {
    return Math.round(value * 1000) / 1000;
}

function backupsDir() {
    return join(memoryDir(), BACKUP_DIR);
}

function auditPath() {
    return join(memoryDir(), AUDIT_FILE);
}

/* ────────────────────────────── 评分（01 §4.4） ────────────────────────────── */
/**
 * 单条评分：`0.4×近因 + 0.3×命中次数 + 0.2×置信度 + 0.1×人工标记`，四项都归一化到 0–1。
 *
 * **缺元数据 ⇒ 返回 1（最高分，永不淘汰）**：索引里没有记录说明我们对这条一无所知，
 * 一无所知就不该被删。同理，字段缺失时取"保守"的一端（近因=1、命中=1、置信度=1）。
 *
 * @param meta 索引里的元数据（可带 `locked`）；为 null 时保守返回 1。
 * @param now 当前时间（毫秒），便于测试注入。
 * @param _options 目前只接受 `currentWorkspaceId`（评分本身不区分工作区；
 *                 工作区保护在 `selectEvictions()` 里做，因为那是"能不能删"而不是"多重要"）。
 */
function scoreEntry(meta, now, _options = {}) {
    if (meta === null || typeof meta !== 'object')
        return 1;
    // 连 firstSeen / lastHit 都没有 ⇒ 对这条一无所知 ⇒ 保守满分（永不淘汰）
    if (!Number.isFinite(meta.firstSeen) && !Number.isFinite(meta.lastHit))
        return 1;
    const nowMs = Number.isFinite(now) ? Number(now) : Date.now();
    const last = Number.isFinite(meta.lastHit)
        ? meta.lastHit
        : (Number.isFinite(meta.firstSeen) ? meta.firstSeen : null);
    const recency = last === null ? 1 : clamp01(1 - (nowMs - last) / (RECENCY_WINDOW_DAYS * 86400000));
    const hits = Number.isFinite(meta.hits) ? clamp01(meta.hits / HITS_FULL) : 1;
    const confidence = typeof meta.confidence === 'string' && meta.confidence !== ''
        ? (CONFIDENCE_SCORES[meta.confidence.toLowerCase()] ?? 1)
        : 1;
    const manualLock = meta.locked === true ? 1 : 0;
    // 0.4+0.3+0.2+0.1 在浮点里是 0.9999999999999999，四舍五入到 6 位让"满分"真的等于 1
    const score = WEIGHTS.recency * recency +
        WEIGHTS.hits * hits +
        WEIGHTS.confidence * confidence +
        WEIGHTS.manualLock * manualLock;
    return clamp01(Math.round(score * 1e6) / 1e6);
}

/* ────────────────────────── 条目解析与 id 解析 ────────────────────────── */
/**
 * 把一天的正文切成条目。**只切、不改**：`line` 是 0 基行号，`lines` 是这条占用的
 * 全部行号（编号 / 顶层 bullet 条目连带它下面更深缩进的子项），`lineTexts` 是原文行。
 *
 * MEMORY 条目 = 编号行（任意缩进）**或顶层**（缩进 0）的 `- ` 列表项。真实项目记忆
 * 常常整篇 bullet 化（本机 Astrbot / xyp-service 实测 0 条编号 + 45~60 条顶层 bullet），
 * 只认编号会让淘汰层对这类文件完全失效。更深缩进的 `- ` 仍是子项；`## 速查` 里的
 * 列表项是参考数据，不算条目（与 `store.memoryEntries()` 同口径）。
 *
 * 为什么要带整段行号：淘汰一条条目时只删首行会留下孤儿子项，文件结构就散了。
 */
function parseEntries(scope, raw) {
    const target = normalizeScope(scope);
    const lines = splitLines(raw);
    const entries = [];
    let section = '';
    let reference = false;
    for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index];
        const heading = /^##\s+(.+?)\s*$/.exec(text);
        if (heading !== null) {
            section = heading[1].trim();
            reference = /^速查/.test(section.replace(/^#+\s*/, '').trim().toLowerCase());
            continue;
        }
        if (target === 'memory') {
            if (reference)
                continue;
            const numbered = /^(\s*)(\d+)\.\s+(.+)$/.exec(text);
            const bullet = numbered === null ? /^-\s+(.+)$/.exec(text) : null;
            if (numbered === null && bullet === null)
                continue;
            const indent = numbered !== null ? numbered[1] : '';
            const span = [index];
            for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
                const current = lines[cursor];
                if (current.trim() === '')
                    break;
                if (/^\s*\d+\.\s/.test(current))
                    break;
                if (!/^\s+/.test(current))
                    break;
                // 只有比条目首行缩进更深的行才是它的子项
                if (current.length - current.trimStart().length <= indent.length)
                    break;
                span.push(cursor);
            }
            entries.push({
                scope: target,
                line: index,
                lines: span,
                lineTexts: span.map((item) => lines[item]),
                section,
                indent,
                number: numbered !== null ? Number(numbered[2]) : null,
                bullet: numbered === null,
                text: numbered !== null ? numbered[3].trim() : bullet[1].trim(),
                raw: text,
            });
            continue;
        }
        const bullet = /^-\s+(.+)$/.exec(text);
        if (bullet === null)
            continue;
        entries.push({
            scope: target,
            line: index,
            lines: [index],
            lineTexts: [text],
            section,
            text: bullet[1].trim(),
            raw: text,
        });
    }
    return entries;
}

/**
 * 给条目补上稳定 id（沿用 store 的口径：索引 id = `entryId(firstSeen, text)`，
 * 索引里没有记录时退化为内容 id = `entryId('', text)`，与 `store.findEntry()` 一致）。
 *
 * `indexed` 标记这条**有没有元数据**：淘汰只动 `indexed` 的条目。
 */
function resolveEntryIds(entries, index) {
    const known = new Set(Object.keys(index?.entries ?? {}));
    const firstSeens = [];
    for (const meta of Object.values(index?.entries ?? {})) {
        if (Number.isFinite(meta?.firstSeen))
            firstSeens.push(meta.firstSeen);
    }
    const candidates = ['', ...firstSeens];
    for (const entry of entries) {
        let matched = null;
        for (const firstSeen of candidates) {
            const candidate = entryId(firstSeen, entry.text);
            if (known.has(candidate)) {
                matched = candidate;
                break;
            }
        }
        entry.id = matched ?? entryId('', entry.text);
        entry.indexed = matched !== null;
    }
    return entries;
}

/* ────────────────────────────── 保护区 ────────────────────────────── */
/** 正文里显式写了 `<!-- keep -->` ⇒ 显式豁免（可选，人工用）。 */
function hasKeepMarker(entry) {
    const texts = Array.isArray(entry?.lineTexts) ? entry.lineTexts : [entry?.raw ?? ''];
    return texts.some((text) => typeof text === 'string' && text.includes(KEEP_MARKER));
}

/** 锁定键集合（`<scope>:<id>`）；坏文件 ⇒ 空集合。 */
function lockKeySet(locks) {
    const source = locks ?? readLocks();
    return new Set(Object.keys(source?.entries ?? {}));
}

/* ────────────────────────────── 淘汰选择 ────────────────────────────── */
/** 一条被删掉后省下的体量（含换行）。 */
function entryWeight(entry) {
    const texts = Array.isArray(entry?.lineTexts) ? entry.lineTexts : [];
    let bytes = 0;
    let chars = 0;
    for (const text of texts) {
        bytes += countBytes(text) + 1;
        chars += text.trim().length + 1;
    }
    return { lines: Math.max(1, texts.length), bytes, chars };
}

function subtractMeasures(view, weight) {
    return {
        lines: Math.max(0, (view.lines ?? 0) - weight.lines),
        bytes: Math.max(0, (view.bytes ?? 0) - weight.bytes),
        chars: Math.max(0, (view.chars ?? 0) - weight.chars),
        limit: view.limit,
    };
}

/**
 * 选要淘汰的条目：按评分**从低到高**，最多 5 条，投影水位 ≤ 75% 即停手。
 * 评分相同时**从文件尾部开始删**（手写记忆前面是核心、尾部是历史/索引）。
 *
 * 跳过（永不自动淘汰）：
 *  - 有显式锁定的条目（`memory/locks.json`）；
 *  - 正文含 `<!-- keep -->` 的条目；
 *  - 当前工作区的 project 条目（仅当调用方给了 `workspaceId`，见 `compact()` 注释）；
 *  - **索引里没有元数据的条目**（一无所知 ⇒ 不删）。
 *
 * 索引缺失 / 损坏 ⇒ 返回 `[]`（淘汰整体跳过）：宁可不压缩，也不盲删。
 *
 * `options.report` 是可选的**诊断收集器**（0.8.0 起）：函数把「一共几条 / 各有几条被
 * 什么挡下 / 为什么停手」写进这个对象，命令层据此说人话，而不是把「0 个候选」
 * 一律说成「已达淘汰上限」。
 *
 * @returns 被选中的条目副本（附 `score`），按分数升序。
 */
function selectEvictions(entries, meta, options = {}) {
    const report = options.report !== null && typeof options.report === 'object' ? options.report : null;
    const list = Array.isArray(entries)
        ? entries.filter((entry) => entry !== null && typeof entry === 'object')
        : [];
    const index = meta !== null && typeof meta === 'object' && meta.entries !== null && typeof meta.entries === 'object'
        ? meta
        : null;
    if (report !== null) {
        Object.assign(report, {
            total: list.length,
            candidates: 0,
            selected: 0,
            missingMetadata: 0,
            protectedKeep: 0,
            protectedLock: 0,
            protectedWorkspace: 0,
        });
    }
    if (index === null || Object.keys(index.entries).length === 0) {
        if (report !== null) {
            report.reason = index === null || index.missing === true ? 'index-missing' : 'index-empty';
            report.missingMetadata = list.length;
        }
        return [];
    }
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    const locks = lockKeySet(options.locks);
    const workspaceId = typeof options.workspaceId === 'string' && options.workspaceId !== ''
        ? options.workspaceId
        : null;
    const max = Number.isFinite(options.maxEvictions) && options.maxEvictions >= 0
        ? Math.trunc(options.maxEvictions)
        : MAX_EVICTIONS;
    const target = Number.isFinite(options.targetRatio) ? options.targetRatio : TARGET_RATIO;
    const base = options.watermark !== undefined && options.watermark !== null
        ? options.watermark
        : null;
    const scored = [];
    let missing = 0;
    let keep = 0;
    let locked = 0;
    let workspace = 0;
    for (const entry of list) {
        if (hasKeepMarker(entry)) {
            keep += 1;
            continue;
        }
        const record = index.entries[entry.id];
        if (record === undefined) {
            missing += 1;
            continue;
        }
        if (locks.has(`${entry.scope ?? ''}:${entry.id}`)) {
            locked += 1;
            continue;
        }
        if (workspaceId !== null && typeof record.workspaceId === 'string' && record.workspaceId === workspaceId) {
            workspace += 1;
            continue;
        }
        scored.push({ entry, score: scoreEntry({ ...record, locked: false }, now, { currentWorkspaceId: workspaceId }) });
    }
    if (report !== null) {
        Object.assign(report, {
            missingMetadata: missing,
            protectedKeep: keep,
            protectedLock: locked,
            protectedWorkspace: workspace,
            candidates: scored.length,
        });
    }
    if (max === 0) {
        if (report !== null)
            report.reason = 'max-zero';
        return [];
    }
    // 同分时的次序：**从文件尾部开始删**。手写记忆几乎都是「前重后轻」——开头是身份/铁律/
    // 当前结论，尾部是历史、已知问题、索引；按行号升序删会先砍掉最核心的那几条。
    scored.sort((a, b) => a.score - b.score || b.entry.line - a.entry.line);
    if (base === null) {
        const picked = scored.slice(0, max).map((item) => ({ ...item.entry, score: round3(item.score) }));
        if (report !== null) {
            report.selected = picked.length;
            report.reason = picked.length === 0 ? 'no-candidates' : 'selected';
        }
        return picked;
    }
    let view = base;
    let ratio = ratioOf(view);
    const selected = [];
    let stop = null;
    for (const item of scored) {
        if (selected.length >= max) {
            stop = 'max-reached';
            break;
        }
        if (ratio <= target) {
            stop = 'target-reached';
            break;
        }
        const projected = subtractMeasures(view, entryWeight(item.entry));
        const projectedRatio = ratioOf(projected);
        // 75% 是**下限**：再删一条就会跌破它时停手（宁可少删；真删不动由 compact() 报预算错误）
        if (projectedRatio < target) {
            stop = selected.length === 0 ? 'would-undershoot' : 'target-undershoot';
            break;
        }
        selected.push({ ...item.entry, score: round3(item.score) });
        view = projected;
        ratio = projectedRatio;
        if (ratio <= target) {
            stop = 'target-reached';
            break;
        }
    }
    if (report !== null) {
        report.selected = selected.length;
        report.reason = stop === null ? (selected.length === 0 ? 'no-candidates' : 'selected') : stop;
    }
    return selected;
}

/* ═══════════════════════ 分词 / BM25 / 分组 ═══════════════════════
 * ⚠️ **故意复制一份**（00 §5.1 第 2 条拍板）：共享包维护成本比这 70 行更高，
 * 且不允许改附属 recall 插件的 exports。分词口径必须与 recall 一致，否则
 * 「同一条结论」在两边算出的相似度会静默分叉 —— 所以这里连 `k1` / `b` 都照抄。
 * 本文件**不 import 任何兄弟插件**，运行时零跨插件依赖。
 */
/** 分词：CJK 单字 + 双字（bigram），拉丁/数字按词（小写、保留 `.` `_` `-`）。 */
function tokenize(text) {
    const source = String(text ?? '').toLowerCase();
    const tokens = [];
    for (const run of source.match(/[\u4e00-\u9fff]+/g) ?? []) {
        for (let index = 0; index < run.length; index += 1) {
            tokens.push(run[index]);
            if (index + 1 < run.length)
                tokens.push(run.slice(index, index + 2));
        }
    }
    for (const word of source.match(/[a-z0-9][a-z0-9._-]*/g) ?? [])
        tokens.push(word);
    return tokens;
}

/** 小 BM25 索引：`score(queryTokens, docIndex)`。绝对分、无上界（调用方负责归一化）。 */
function buildBm25(docs) {
    const tokenized = docs.map((doc) => tokenize(doc));
    const freqs = [];
    const df = new Map();
    const lengths = [];
    for (const tokens of tokenized) {
        const map = new Map();
        for (const token of tokens)
            map.set(token, (map.get(token) ?? 0) + 1);
        for (const token of map.keys())
            df.set(token, (df.get(token) ?? 0) + 1);
        freqs.push(map);
        lengths.push(tokens.length);
    }
    const total = Math.max(1, tokenized.length);
    const avgdl = lengths.reduce((sum, value) => sum + value, 0) / total;
    const idf = (token) => {
        const dfv = df.get(token) ?? 0;
        return Math.log(1 + (tokenized.length - dfv + 0.5) / (dfv + 0.5));
    };
    const score = (queryTokens, docIndex) => {
        const map = freqs[docIndex];
        const length = lengths[docIndex];
        if (map === undefined)
            return 0;
        const seen = new Set();
        let sum = 0;
        for (const token of queryTokens) {
            if (seen.has(token))
                continue;
            seen.add(token);
            const tf = map.get(token);
            if (tf === undefined)
                continue;
            const norm = 1 - BM25_B + BM25_B * (length / (avgdl || 1));
            sum += idf(token) * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm));
        }
        return sum;
    };
    return { docs: tokenized, score };
}

/**
 * 相似度（归一化到 0–1）：`score(B|A) / score(A|A)`，双向取大。
 *
 * BM25 是**绝对分**（02 §478 审计项），不能直接和 0.7 比 —— 必须先用
 * "自己命中自己"的分数做上界归一化，阈值才有一致含义。
 */
function similarityOf(bm25, left, right) {
    const selfLeft = bm25.score(bm25.docs[left], left);
    const selfRight = bm25.score(bm25.docs[right], right);
    const forward = selfLeft > 0 ? bm25.score(bm25.docs[left], right) / selfLeft : 0;
    const backward = selfRight > 0 ? bm25.score(bm25.docs[right], left) / selfRight : 0;
    return clamp01(Math.max(forward, backward));
}

function normalizeGroupSize(groupSize) {
    if (!Array.isArray(groupSize) || groupSize.length < 2)
        return [MERGE_GROUP_MIN, MERGE_GROUP_MAX];
    const min = Number.isFinite(groupSize[0]) ? Math.max(2, Math.trunc(groupSize[0])) : MERGE_GROUP_MIN;
    const max = Number.isFinite(groupSize[1]) ? Math.max(min, Math.trunc(groupSize[1])) : MERGE_GROUP_MAX;
    return [min, max];
}

/**
 * 找可合并的组：**同一个 `## 分组` 内**语义相近的 2–10 条（01 §4.3）。
 *
 * 贪心：每轮挑"未成组里近邻最多"的那条做种子，按相似度取到上限，成组后不再参与。
 * 带 `<!-- keep -->` 的条目不参与合并（它可以被单独保留）。
 *
 * @returns `[{section, entries: [...]}]`，最多 `maxGroups` 组。
 */
function groupFactCandidates(entries, options = {}) {
    const threshold = Number.isFinite(options.threshold) ? options.threshold : MERGE_THRESHOLD;
    const maxGroups = Number.isFinite(options.maxGroups) ? Math.max(0, Math.trunc(options.maxGroups)) : MERGE_MAX_GROUPS;
    const [minSize, maxSize] = normalizeGroupSize(options.groupSize);
    if (maxGroups === 0)
        return [];
    const buckets = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        if (entry === null || typeof entry !== 'object')
            continue;
        if (hasKeepMarker(entry))
            continue;
        const text = typeof entry.text === 'string' ? entry.text.trim() : '';
        if (text === '')
            continue;
        const section = typeof entry.section === 'string' ? entry.section : '';
        if (!buckets.has(section))
            buckets.set(section, []);
        buckets.get(section).push(entry);
    }
    const groups = [];
    for (const [section, list] of buckets) {
        if (groups.length >= maxGroups)
            break;
        if (list.length < minSize)
            continue;
        const bm25 = buildBm25(list.map((entry) => entry.text));
        const used = new Set();
        while (groups.length < maxGroups) {
            let seed = -1;
            let neighbours = [];
            for (let left = 0; left < list.length; left += 1) {
                if (used.has(left))
                    continue;
                const close = [];
                for (let right = 0; right < list.length; right += 1) {
                    if (left === right || used.has(right))
                        continue;
                    const value = similarityOf(bm25, left, right);
                    if (value >= threshold)
                        close.push({ at: right, value });
                }
                if (close.length + 1 < minSize)
                    continue;
                if (seed < 0 || close.length > neighbours.length) {
                    seed = left;
                    neighbours = close;
                }
            }
            if (seed < 0)
                break;
            neighbours.sort((a, b) => b.value - a.value || a.at - b.at);
            const members = [seed, ...neighbours.slice(0, maxSize - 1).map((item) => item.at)].sort((a, b) => a - b);
            for (const at of members)
                used.add(at);
            groups.push({ section, entries: members.map((at) => list[at]) });
        }
    }
    return groups;
}

/* ────────────────────────────── 合并提示词与结果解析 ────────────────────────────── */
/**
 * 合并提示词：组名 + 组内原文，要求输出**一行 ≤120 字**且**不许丢具体值**。
 *
 * 这里刻意把"不许丢版本号/路径"写成硬要求并附反例 —— 模型最常见的失手是把
 * 「node v22.23.3 + adb 用 platform-tools 那份」压成「环境已就绪」，信息量直接归零。
 */
function buildMergePrompt(group, entries, options = {}) {
    const section = typeof group?.section === 'string' && group.section !== '' ? group.section : '其它';
    const file = options.target === 'memory' ? 'MEMORY.md' : 'FACT.md';
    const list = (Array.isArray(entries) ? entries : (group?.entries ?? []))
        .map((entry) => `- ${String(entry?.text ?? '').trim()}`)
        .filter((line) => line !== '- ');
    return [
        `下面是 ${file}「## ${section}」分组里语义相近的 ${list.length} 条结论，请合并成 1 条。`,
        '',
        ...list,
        '',
        '规则：',
        `1. 只输出一行，不超过 ${MERGE_MAX_CHARS} 字，不要列表符号，不要解释。`,
        '2. 保留所有具体值：版本号、路径、命令、包名、数字都不能丢（合并后信息量不得减少）。',
        '3. 只写结论，不写原因：不要出现「因为/由于/为了/所以/原因是/理由/考虑到/之所以」。',
        '4. 中文叙述，英文只留专有名词；不写密钥、密码、token、手机号、身份证、卡号。',
    ].join('\n');
}

/** 去掉列表符号 / 引用符 / 反引号包裹，得到纯正文。 */
function stripMergeDecoration(line) {
    return String(line ?? '')
        .trim()
        .replace(/^[-*+]\s+/, '')
        .replace(/^\d+[.)]\s+/, '')
        .replace(/^>\s*/, '')
        .replace(/^`+|`+$/g, '')
        .replace(/^["'「『]+|["'」』]+$/g, '')
        .trim();
}

/** 抽"具体值"：版本号/数字、路径、反引号内容 —— 用来判断合并有没有把信息压没。 */
function concreteTokens(text) {
    const source = String(text ?? '');
    const tokens = new Set();
    for (const match of source.match(/[A-Za-z]{0,4}\d[\w.]*/g) ?? []) {
        if (match.length >= 2)
            tokens.add(match.toLowerCase());
    }
    for (const match of source.match(/[A-Za-z0-9._-]*[\\/][A-Za-z0-9._/\\-]+/g) ?? [])
        tokens.add(match.toLowerCase());
    for (const match of source.match(/`[^`\n]+`/g) ?? [])
        tokens.add(match.toLowerCase());
    return [...tokens];
}

/**
 * 解析合并结果 → `{ok:true, text}` 或 `{ok:false, reason}`。
 *
 * 拒绝四类：空、多行、超过 120 字、**把具体值压没了**（原文有版本号/路径，合并结果
 * 一个都没有）。最后一条是硬要求：宁可这组不合并，也不要一条"环境已就绪"。
 */
function parseMergeResult(text, options = {}) {
    if (typeof text !== 'string' || text.trim() === '')
        return { ok: false, reason: '空结果' };
    const body = text.replace(/```[a-z]*\n?/gi, ' ').trim();
    const lines = body
        .split(/\r?\n/)
        .map((line) => stripMergeDecoration(line))
        .filter((line) => line !== '');
    if (lines.length === 0)
        return { ok: false, reason: '空结果' };
    if (lines.length > 1)
        return { ok: false, reason: '结果不是单行' };
    const merged = lines[0];
    if (merged.length > MERGE_MAX_CHARS)
        return { ok: false, reason: `超过 ${MERGE_MAX_CHARS} 字（实际 ${merged.length} 字）` };
    const sources = Array.isArray(options.sources) ? options.sources.join('\n') : String(options.sources ?? '');
    const wanted = concreteTokens(sources);
    if (wanted.length > 0 && concreteTokens(merged).length === 0)
        return { ok: false, reason: '具体值（版本号/路径）全部丢失' };
    return { ok: true, text: merged };
}

/* ────────────────────────── 备份 / 审计 / 回滚 ────────────────────────── */
/**
 * 压缩前备份：`$DSH_HOME/memory/backups/<文件名>-<yyyyMMdd-HHmmss>.bak`，保留 N 份。
 *
 * 同一秒内重复压缩时后缀 `-2`/`-3`（时间戳前缀不变，回滚按前缀仍能命中）。
 */
function writeBackup(file, raw, keep = DEFAULT_KEEP_BACKUPS) {
    if (typeof raw !== 'string' || raw === '')
        return null;
    ensureDir(backupsDir());
    const stamp = stampOf(new Date());
    const name = basename(file);
    let target = join(backupsDir(), `${name}-${stamp}.bak`);
    for (let attempt = 2; existsSync(target) && attempt < 100; attempt += 1)
        target = join(backupsDir(), `${name}-${stamp}-${attempt}.bak`);
    writeAtomic(target, raw);
    pruneBackups(name, keep);
    return target;
}

/** 只留最近的 N 份（按文件名里的时间戳排序；坏名排在后面一并清掉）。 */
function pruneBackups(name, keep = DEFAULT_KEEP_BACKUPS) {
    const limit = Number.isFinite(keep) && keep > 0 ? Math.trunc(keep) : DEFAULT_KEEP_BACKUPS;
    let names;
    try {
        names = readdirSync(backupsDir());
    }
    catch {
        return 0;
    }
    const mine = names
        .filter((item) => item.startsWith(`${name}-`) && item.endsWith('.bak'))
        .sort();
    const extra = mine.slice(0, Math.max(0, mine.length - limit));
    let removed = 0;
    for (const item of extra) {
        try {
            rmSync(join(backupsDir(), item), { force: true });
            removed += 1;
        }
        catch {
            /* 删不掉就留着：备份多一份不影响正确性 */
        }
    }
    return removed;
}

/**
 * 追加一条审计：`$DSH_HOME/memory/compaction.jsonl`。
 * 形状按 01 §4.5，另加 `before.sha256` / `path` / `backup` —— 回滚要靠它们定位与校验。
 */
function appendAudit(record) {
    try {
        ensureDir(memoryDir());
        appendFileSync(auditPath(), `${JSON.stringify(record)}\n`, 'utf8');
        return true;
    }
    catch {
        return false;
    }
}

/** 读审计（坏行跳过，旧→新返回，只取最后 `limit` 条）。 */
function readAudit(limit = 50) {
    const raw = readText(auditPath());
    if (raw === null)
        return [];
    const records = [];
    for (const line of raw.split(/\r?\n/)) {
        if (line.trim() === '')
            continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed !== null && typeof parsed === 'object')
                records.push(parsed);
        }
        catch {
            /* 坏行跳过 */
        }
    }
    const max = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 50;
    return records.slice(Math.max(0, records.length - max));
}

/** 最近一次压缩（面板用）。 */
function lastRun() {
    const records = readAudit(50);
    return records.length === 0 ? null : records[records.length - 1];
}

/**
 * 回滚：按时间戳找 `.bak` → 校验 SHA256 → 原子写回。
 *
 * 时间戳可以是 `yyyyMMdd-HHmmss`（备份名里的那一截），也可以是审计记录 `ts` 里的
 * 任意唯一前缀；两条路都先走审计记录（那里有 `path` 与 `before.sha256`）。
 * SHA 对不上就**不写**：说明备份被改过，回滚会引入未知内容。
 */
async function rollbackCompaction(timestamp, options = {}) {
    const wanted = String(timestamp ?? '').trim();
    if (wanted === '')
        return { ok: false, error: 'BAD_TIMESTAMP', message: '需要一个时间戳（yyyyMMdd-HHmmss）' };
    const digest = wanted.replace(/\D/g, '');
    const records = readAudit(1000);
    let record = null;
    for (let index = records.length - 1; index >= 0; index -= 1) {
        const candidate = records[index];
        if (typeof candidate?.backup !== 'string' || candidate.backup === '')
            continue;
        const name = basename(candidate.backup);
        if (name.includes(wanted) || (digest !== '' && name.replace(/\D/g, '').includes(digest))) {
            record = candidate;
            break;
        }
    }
    if (record === null)
        return { ok: false, error: 'NO_BACKUP', message: `找不到对应 ${wanted} 的压缩备份` };
    const raw = readText(record.backup);
    if (raw === null)
        return { ok: false, error: 'NO_BACKUP', message: `备份文件已不在：${record.backup}` };
    const actual = sha256(raw);
    const expected = typeof record.before?.sha256 === 'string' ? record.before.sha256 : '';
    if (expected !== '' && expected !== actual)
        return { ok: false, error: 'SHA256_MISMATCH', message: `备份内容与记录的压缩前镜像不一致（期望 ${expected}，实际 ${actual}）`, expected, actual };
    const path = typeof record.path === 'string' && record.path !== ''
        ? record.path
        : (options?.path ?? null);
    if (path === null)
        return { ok: false, error: 'NO_TARGET', message: '审计记录里没有目标文件路径' };
    const target = normalizeScope(record.scope);
    const release = await acquireWriteLock(target, { cwd: options?.cwd, timeoutMs: options?.timeoutMs });
    try {
        const current = readText(path) ?? '';
        writeAtomic(path, raw);
        const restored = measuresOf(raw);
        appendAudit({
            ts: new Date().toISOString(),
            scope: target,
            runId: newRunId(),
            reason: 'rollback',
            path,
            before: { ...measuresOf(current), sha256: sha256(current) },
            after: { ...restored, sha256: actual },
            merged: [],
            evicted: [],
            rollbackOf: record.runId ?? null,
            backup: record.backup,
        });
        return { ok: true, path, backup: record.backup, sha256: actual, before: measuresOf(current), after: restored, rollbackOf: record.runId ?? null };
    }
    finally {
        release();
    }
}

/* ────────────────────────────── 应用的改写 ────────────────────────────── */
/**
 * 一次性重排行：`replacements`（行号 → 新行）与 `removals`（行号集合）同时生效。
 * `removals` 里同时也在 `replacements` 的行以替换为准（不会删掉合并后的新行）。
 */
function rewriteLines(lines, replacements, removals) {
    const out = [];
    for (let index = 0; index < lines.length; index += 1) {
        if (replacements.has(index)) {
            out.push(replacements.get(index));
            continue;
        }
        if (removals.has(index))
            continue;
        out.push(lines[index]);
    }
    return out;
}

/**
 * MEMORY 合并后重排编号：同一 `## 分组` + 同一缩进算一组，按出现顺序从组内**第一个编号**
 * 起连续编号。只为消掉「合并掉两条 ⇒ 编号 1,4,5」这种空洞，不改分组的起始编号。
 *
 * 原序列不是严格递增（人工乱序/重复）就整组跳过：那种情况重排只会制造更多困惑。
 */
function renumberNumbered(lines, sections) {
    const groups = new Map();
    let section = '';
    for (let index = 0; index < lines.length; index += 1) {
        const heading = /^##\s+(.+?)\s*$/.exec(lines[index]);
        if (heading !== null) {
            section = heading[1].trim();
            continue;
        }
        const numbered = /^(\s*)(\d+)\.\s+(.+)$/.exec(lines[index]);
        if (numbered === null)
            continue;
        if (sections !== undefined && !sections.has(section))
            continue;
        const key = `${section}\u0000${numbered[1]}`;
        if (!groups.has(key))
            groups.set(key, []);
        groups.get(key).push(index);
    }
    const out = [...lines];
    for (const indexes of groups.values()) {
        if (indexes.length === 0)
            continue;
        const numbers = indexes.map((index) => Number(/^(\s*)(\d+)\.\s+/.exec(out[index])[2]));
        if (!numbers.every((value, at) => at === 0 || value > numbers[at - 1]))
            continue;
        const base = numbers[0];
        indexes.forEach((index, at) => {
            const match = /^(\s*)(\d+)\.\s+([\s\S]*)$/.exec(out[index]);
            out[index] = `${match[1]}${base + at}. ${match[3]}`;
        });
    }
    return out;
}

function joinLines(lines, raw) {
    if (lines.length === 0)
        return '';
    return `${lines.join('\n')}${String(raw ?? '').endsWith('\n') ? '\n' : ''}`;
}

/**
 * 把计划应用到正文上（纯函数，不落盘）：
 * ① 合并（FACT 按 `- ` 列表；MEMORY 保留原编号与缩进）→ ② 合并后仍 ≥100% 才淘汰。
 *
 * @returns `{text, merged, evicted, ratio, reason, diagnostics}`；`merged` 与 `evicted`
 *          都为空表示**什么都没发生**（`text` 可能只差尾部空行归一化，调用方不该写盘）。
 */
function applyPlan(target, raw, limit, plan, options = {}) {
    const lines = splitLines(raw);
    const replacements = new Map();
    const removals = new Set();
    const merged = [];
    for (const item of Array.isArray(plan) ? plan : []) {
        const sourceLines = item.entries.map((entry) => entry.line);
        if (sourceLines.some((line) => replacements.has(line) || removals.has(line)))
            continue;
        // FACT 是 `- ` 列表；MEMORY 编号条目合并后必须**保留编号与缩进**（否则编号顺序
        // 会断，下游 insertEntry 按最大编号顺延会撞号）；bullet 条目继续用 `- `。
        const head = item.entries[0];
        const mergedText = target === 'memory' && head.bullet !== true
            ? `${head.indent ?? ''}${head.number ?? 1}. ${item.text}`
            : `- ${item.text}`;
        replacements.set(sourceLines[0], mergedText);
        for (const line of sourceLines.slice(1))
            removals.add(line);
        merged.push({ section: item.section, from: item.entries.map((entry) => entry.text), to: item.text });
    }
    let rewritten = rewriteLines(lines, replacements, removals);
    if (target === 'memory' && merged.length > 0) {
        // 只重排**被合并过的分组**：别的分组即便历史上就有编号空洞，也绝不顺手改。
        rewritten = renumberNumbered(rewritten, new Set(merged.map((item) => item.section ?? '')));
    }
    let text = joinLines(rewritten, raw);
    let ratio = ratioOf(withLimit(measuresOf(text), limit));
    const evicted = [];
    // 淘汰层的诊断（没进淘汰层就是 null）：reason 说明为什么没删 / 为什么停手。
    let diagnostics = null;
    let reason = merged.length === 0 ? 'no-op' : 'merged';
    if (ratio >= 1) {
        diagnostics = {};
        const index = memoryIndex();
        const entries = resolveEntryIds(parseEntries(target, text), index);
        const picked = selectEvictions(entries, index, {
            now: options.now,
            watermark: withLimit(measuresOf(text), limit),
            maxEvictions: options.maxEvictions,
            targetRatio: options.targetRatio,
            workspaceId: options.workspaceId,
            report: diagnostics,
        });
        if (picked.length > 0) {
            const nextLines = splitLines(text);
            const drop = new Set();
            for (const entry of picked) {
                for (const line of entry.lines)
                    drop.add(line);
                evicted.push({ id: entry.id, text: entry.text, score: entry.score, section: entry.section ?? '' });
            }
            text = joinLines(rewriteLines(nextLines, new Map(), drop), text);
            ratio = ratioOf(withLimit(measuresOf(text), limit));
            reason = merged.length === 0 ? 'evicted' : 'merged+evicted';
        }
        else {
            reason = merged.length === 0 ? 'no-eviction' : 'merged';
        }
    }
    return { text, merged, evicted, ratio, reason, diagnostics };
}

/* ────────────────────────────── 合并计划（锁外调 LLM） ────────────────────────────── */
function withTimeout(promise, timeoutMs) {
    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_CALL_TIMEOUT;
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            resolve(null);
        }, limit);
        Promise.resolve(promise).then((value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        }, () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(null);
        });
    });
}

/**
 * 生成合并计划：**只读、不写、不拿锁**（LLM 慢，绝不能占着写锁）。
 * 每组一次调用；解析失败 / 超时 / 调用报错都只是"这组不合并"，不影响其它组。
 */
async function planMerges(target, raw, callModel, options = {}) {
    if (typeof callModel !== 'function')
        return [];
    if (target !== 'fact' && target !== 'memory')
        return [];
    /* MEMORY 是编号 + 子项结构：只合并**叶子条目**（没有子项的单行编号条目）。
       带子项的条目合并会把「编号行 + 缩进子项」整体并成一行，层级就散了。 */
    const entries = parseEntries(target, raw)
        .filter((entry) => (target === 'fact' || (Array.isArray(entry.lines) && entry.lines.length === 1)));
    const groups = groupFactCandidates(entries, {
        threshold: options.mergeThreshold,
        maxGroups: options.maxGroups,
        groupSize: options.groupSize,
    });
    const plan = [];
    for (const group of groups) {
        const answer = await withTimeout(
            callModel(buildMergePrompt(group, group.entries, { target }), {
                ...group,
                target,
                // 会话句柄只用于让调用方回读"本会话用的 provider/model"（继承会话模型），
                // 压缩本身不依赖它。
                session: options.session,
            }),
            options.callTimeoutMs,
        );
        if (typeof answer !== 'string' || answer.trim() === '')
            continue;
        const parsed = parseMergeResult(answer, { sources: group.entries.map((entry) => entry.text) });
        if (!parsed.ok)
            continue;
        // 合并必须真的变小，否则这一组没有意义（还可能因为多了前缀反而变大）
        const before = group.entries.reduce((sum, entry) => sum + entry.text.length, 0);
        if (parsed.text.length >= before)
            continue;
        plan.push({ section: group.section, entries: group.entries, text: parsed.text });
    }
    return plan;
}

/* ────────────────────────────── 编排 ────────────────────────────── */
function auditBody(measures, text) {
    return { ...measures, sha256: sha256(text) };
}

/* ──────────────────── 失败原因的白话解释（命令与面板共用） ──────────────────── */
/**
 * 为什么一条都没删？把 selectEvictions() 的诊断翻成一句人话。
 *
 * 0.8.0 之前这里只会说「已达淘汰上限 5 条」，而真实原因往往是一条候选都没有 ——
 * 用户以为命令坏了。现在按诊断分情况说，并在缺元数据时直接给出回填命令。
 */
function explainNoEviction(diagnostics, ratio, scope) {
    const d = diagnostics !== null && typeof diagnostics === 'object' ? diagnostics : {};
    const pct = `${Math.round((Number.isFinite(ratio) ? ratio : 0) * 100)}%`;
    const parts = [];
    if (d.reason === 'index-missing')
        parts.push('侧车索引 memory/index.json 不存在');
    else if (d.reason === 'index-empty')
        parts.push('侧车索引为空');
    if ((d.missingMetadata ?? 0) > 0)
        parts.push(`${d.missingMetadata} 条缺元数据`);
    if ((d.protectedKeep ?? 0) > 0)
        parts.push(`${d.protectedKeep} 条带 keep 标记`);
    if ((d.protectedLock ?? 0) > 0)
        parts.push(`${d.protectedLock} 条已锁定`);
    if ((d.protectedWorkspace ?? 0) > 0)
        parts.push(`${d.protectedWorkspace} 条属当前工作区`);
    if (d.reason === 'would-undershoot')
        parts.push('删任意一条都会跌破 75% 下限');
    if (d.reason === 'max-zero')
        parts.push('淘汰条数上限为 0');
    const why = parts.length > 0 ? parts.join('，') : '没有可安全压缩的对象';
    const seedScope = normalizeScope(scope) === 'fact' ? 'fact' : 'memory';
    const hint = d.reason === 'index-missing' || d.reason === 'index-empty' || (d.missingMetadata ?? 0) > 0
        ? `；先跑 /memory-compact ${seedScope} seed 回填索引后再压`
        : '';
    return `水位 ${pct}，没有可安全压缩的对象（${why}${hint}）`;
}
/**
 * 已经删/合并过了、但压完仍 ≥100%：说清是「删满 5 条」还是「再删就跌破 75%」
 * 还是「根本没有候选」。
 */
function explainShortfall(diagnostics, ratio, maxEvictions) {
    const d = diagnostics !== null && typeof diagnostics === 'object' ? diagnostics : {};
    const pct = `${Math.round((Number.isFinite(ratio) ? ratio : 0) * 100)}%`;
    const max = Number.isFinite(maxEvictions) ? maxEvictions : MAX_EVICTIONS;
    if (d.reason === 'max-reached')
        return `压缩后水位仍为 ${pct}（已达淘汰上限 ${max} 条，剩余 ${Math.max(0, (d.candidates ?? 0) - (d.selected ?? 0))} 条候选）`;
    if (d.reason === 'target-undershoot')
        return `压缩后水位仍为 ${pct}（再删一条就会跌破 75% 下限）`;
    if (d.reason === 'would-undershoot')
        return `压缩后水位仍为 ${pct}（删任意一条都会跌破 75% 下限）`;
    if ((d.candidates ?? 0) === 0)
        return `压缩后水位仍为 ${pct}（没有可安全淘汰的对象）`;
    return `压缩后水位仍为 ${pct}`;
}
/**
 * 压一个作用域。
 *
 * ```
 * 水位 < 85%      → {skipped:'below-watermark'}
 * 85% ~ 100%      → 合并（FACT 合同组条目；MEMORY 只合同一段落的叶子条目）
 * 合并后 ≥ 100%   → 淘汰（最多 5 条，投影到 ≤75%）
 * 淘汰后 ≥ 100%   → {error:'MEMORY_BUDGET_EXCEEDED'}
 * ```
 *
 * @param scope `fact` | `memory`（`global`/`project` 也认）。
 * @param options `{cwd, dryRun, callModel, session, workspaceId, now, keepBackups,
 *                  targetRatio, maxEvictions, maxGroups, groupSize, mergeThreshold,
 *                  callTimeoutMs, timeoutMs}`（`session` 会透传给 `callModel` 的第二参，
 *                 用于回读本会话的 provider/model）
 */
async function compact(scope, options = {}) {
    const target = normalizeScope(scope);
    const cwd = options?.cwd;
    const dryRun = options?.dryRun === true;
    const callModel = typeof options?.callModel === 'function' ? options.callModel : null;
    const before = watermark(target, { cwd });
    if (before.path === null)
        return { ok: false, scope: target, skipped: 'no-target' };
    const beforeRatio = ratioOf(before);
    if (beforeRatio < TRIGGER_RATIO)
        return { ok: false, scope: target, skipped: 'below-watermark', before, ratio: round3(beforeRatio) };
    const runId = newRunId();
    const preImage = readText(before.path) ?? '';
    /* ① 锁外：LLM 合并计划（慢，且绝不能在写锁里做；dryRun 也只读不写） */
    const plan = await planMerges(target, preImage, callModel, options);
    const result = {
        ok: true,
        scope: target,
        runId,
        dryRun,
        path: before.path,
        before: auditBody({ lines: before.lines, bytes: before.bytes, chars: before.chars }, preImage),
        beforeRatio: round3(beforeRatio),
        merged: [],
        evicted: [],
        diagnostics: null,
        after: null,
        ratio: round3(beforeRatio),
        reason: 'no-op',
        changed: false,
        written: false,
    };
    /**
     * 把 applyPlan 的结果记账。
     *
     * 判「有没有真的发生压缩」只看 merged / evicted 是否为空 —— **不看 text** 是否与
     * 原文不同：splitLines + joinLines 会把「结尾多一个空行」归一化掉，那不是压缩。
     * 没有合并也没有淘汰时绝不写盘（issue 里的 bug：Astrbot 那次只删了末尾空行，
     * 却生成了备份 + 审计，用户还以为命令动了文件）。
     */
    const settle = (applied) => {
        result.merged = applied.merged;
        result.evicted = applied.evicted;
        result.diagnostics = applied.diagnostics ?? null;
        result.reason = applied.reason;
        result.changed = applied.merged.length > 0 || applied.evicted.length > 0;
        if (!result.changed) {
            // 什么都没发生：after 保持压缩前镜像，比例也说压缩前的（别拿归一化后的数字骗人）
            result.after = result.before;
            result.ratio = round3(beforeRatio);
            if (beforeRatio >= 1) {
                result.ok = false;
                result.error = 'MEMORY_BUDGET_EXCEEDED';
                result.message = explainNoEviction(result.diagnostics, beforeRatio, target);
            }
            return result;
        }
        result.after = auditBody(measuresOf(applied.text), applied.text);
        result.ratio = round3(applied.ratio);
        if (applied.ratio >= 1) {
            result.ok = false;
            result.error = 'MEMORY_BUDGET_EXCEEDED';
            result.message = explainShortfall(result.diagnostics, applied.ratio, options?.maxEvictions ?? MAX_EVICTIONS);
        }
        return result;
    };
    if (dryRun)
        return settle(applyPlan(target, preImage, before.limit, plan, options));
    /* ② 锁内：重读 → 变了就放弃 → 规划 → 备份 → 一次原子写 → 审计 */
    const release = await acquireWriteLock(target, { cwd, timeoutMs: options?.timeoutMs });
    try {
        const current = readText(before.path) ?? '';
        if (current !== preImage) {
            // 期间有人写了（insertEntry / 面板 / 人工）：本轮作废，绝不覆盖
            return { ...result, ok: false, skipped: 'changed', reason: 'changed' };
        }
        /* ⚠️ 当前工作区的 project 条目保护只在 fact 作用域生效：MEMORY.md 本身
           就属于当前工作区，若也保护它，淘汰就永远没有候选（01 §4.4 的保护区原意
           是"别删用户当前正在用的那个项目的条目"，不是"禁止压缩项目记忆"）。 */
        const applied = applyPlan(target, current, before.limit, plan, {
            ...options,
            workspaceId: target === 'fact' ? options?.workspaceId : null,
        });
        settle(applied);
        if (!result.changed)
            return result;
        const backup = writeBackup(before.path, current, options?.keepBackups ?? DEFAULT_KEEP_BACKUPS);
        writeAtomic(before.path, applied.text);
        result.written = true;
        appendAudit({
            ts: new Date().toISOString(),
            scope: target,
            runId,
            path: before.path,
            backup,
            before: result.before,
            after: result.after,
            merged: result.merged,
            evicted: result.evicted,
            diagnostics: result.diagnostics,
            reason: result.reason,
            dryRun: false,
            trigger: typeof options?.trigger === 'string' ? options.trigger : 'manual',
        });
        return result;
    }
    finally {
        release();
    }
}

/** 文件 mtime（毫秒，取整）。取不到就退当前时间（回填不该因为 stat 失败而中止）。 */
function fileMtime(file) {
    try {
        return Math.round(statSync(file).mtimeMs);
    }
    catch {
        return Date.now();
    }
}

/**
 * 回填侧车索引（0.8.0 · P1）：给「手写 / 整篇写入」的老条目补一份**冷元数据**。
 *
 * 背景：淘汰层只认 `memory/index.json` 里的记录（一无所知就不删）。旧文件里的条目
 * 没有记录 ⇒ 永远 0 候选。这里做一次性回填：`firstSeen = lastHit = 文件 mtime`、
 * `hits = 0`、`confidence = low`（视为冷数据，评分最低，压缩时优先淘汰）。
 *
 * 安全边界：
 *  - **只补缺的**：已有记录的条目原样保留（再跑一次 `seeded` 为 0）；
 *  - **只动目标 scope 的那一个文件**：写回时 pruneIndex 按正文复算，别的 scope 不受影响；
 *  - `dryRun` 只算计划，不写 `index.json`；
 *  - 不删任何正文，只写索引。
 *
 * @param scope `fact` | `memory`
 * @param options `{cwd, dryRun, workspaceId, now, firstSeen}`
 */
function seedMetadata(scope, options = {}) {
    const target = normalizeScope(scope);
    if (target !== 'fact' && target !== 'memory')
        return { ok: false, scope: target, error: 'BAD_SCOPE', message: `未知作用域：${scope}（可选 fact / memory）` };
    const view = watermark(target, { cwd: options?.cwd });
    if (view.path === null)
        return { ok: false, scope: target, skipped: 'no-target' };
    const raw = readText(view.path);
    if (raw === null)
        return { ok: false, scope: target, skipped: 'no-target' };
    const dryRun = options?.dryRun === true;
    const index = memoryIndex();
    const entries = resolveEntryIds(parseEntries(target, raw), index);
    const firstSeen = Number.isFinite(options?.firstSeen)
        ? Number(options.firstSeen)
        : (Number.isFinite(options?.now) ? Number(options.now) : fileMtime(view.path));
    const workspaceId = typeof options?.workspaceId === 'string' && options.workspaceId !== ''
        ? options.workspaceId
        : null;
    const plan = [];
    const seen = new Set();
    for (const entry of entries) {
        if (entry.indexed === true)
            continue;
        const id = entryId(firstSeen, entry.text);
        if (seen.has(id))
            continue;
        seen.add(id);
        plan.push({
            id,
            text: entry.text,
            section: entry.section ?? '',
            meta: {
                scope: target,
                workspaceId,
                firstSeen,
                lastHit: firstSeen,
                hits: 0,
                confidence: 'low',
                ...(target === 'memory' ? { path: view.path } : {}),
            },
        });
    }
    const result = {
        ok: true,
        scope: target,
        path: view.path,
        dryRun,
        total: entries.length,
        alreadyIndexed: entries.filter((entry) => entry.indexed === true).length,
        seeded: plan.length,
        firstSeen,
        entries: plan.map((item) => ({ id: item.id, text: item.text, section: item.section })),
        written: false,
    };
    if (dryRun || plan.length === 0)
        return result;
    const written = mutateIndex((records) => {
        for (const item of plan)
            records[item.id] = item.meta;
    });
    result.written = written;
    if (!written) {
        result.ok = false;
        result.error = 'INDEX_WRITE_FAILED';
        result.message = `写索引失败：${join(memoryDir(), 'index.json')}`;
    }
    return result;
}

/** 状态快照（面板与命令共用）：水位 + 锁定 + 最近一次运行。 */
function compactionStatus(options = {}) {
    const cwd = options?.cwd;
    const fact = watermark('fact');
    const memory = watermark('memory', { cwd });
    const locks = listLocks();
    return {
        enabled: options?.enabled === true,
        triggerRatio: TRIGGER_RATIO,
        targetRatio: TARGET_RATIO,
        maxEvictions: MAX_EVICTIONS,
        watermark: {
            fact: { ...fact, ratio: round3(ratioOf(fact)) },
            memory: { ...memory, ratio: round3(ratioOf(memory)) },
        },
        locked: locks,
        lastRun: lastRun(),
        paths: { audit: auditPath(), backups: backupsDir(), locks: join(memoryDir(), 'locks.json') },
    };
}

export {
    DEFAULT_CALL_TIMEOUT,
    DEFAULT_KEEP_BACKUPS,
    KEEP_MARKER,
    MAX_EVICTIONS,
    MERGE_MAX_CHARS,
    MERGE_MAX_GROUPS,
    MERGE_THRESHOLD,
    TARGET_RATIO,
    TRIGGER_RATIO,
    applyPlan,
    auditPath,
    backupsDir,
    buildMergePrompt,
    compact,
    compactionStatus,
    concreteTokens,
    groupFactCandidates,
    hasKeepMarker,
    lastRun,
    measuresOf,
    parseEntries,
    parseMergeResult,
    planMerges,
    pruneBackups,
    ratioOf,
    readAudit,
    resolveEntryIds,
    rollbackCompaction,
    scoreEntry,
    seedMetadata,
    selectEvictions,
    tokenize,
    writeBackup,
};
