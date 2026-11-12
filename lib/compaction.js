/**
 * @dsh-external/dsh-persona-memory — 压缩管线（0.8.0 · P4）。
 *
 * 设计见 PLAN/01 §4。这里是**纯逻辑 + I/O**，不含任何插件接线：
 * `lib/index.js` 负责配置、命令与面板路由，`lib/store.js` 负责在写入前敲门。
 *
 * ```
 * 水位 < 85%          → 正常写
 * 85% ~ 100%          → B 合并（FACT 合并同组条目；MEMORY 只合并同一段落里的**叶子条目**，
 *                        编号与子项层级不动）；合并后仍在 85%–100% ⇒ **保守淘汰**
 *                        （只动已失效条目与 importance ≤ 35 的条目，见 selectEvictions）
 * 合并后仍 ≥ 100%     → A 淘汰（FACT 与 MEMORY 都做，可动普通条目）
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
import { isDormantState, parseEntryState } from './entry-state.js';
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
    syncIndexAfterWrite,
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
/**
 * 保守淘汰的入口水位（0.12.0 · P0）。
 *
 * 水位落在 85%–100% 时也进淘汰层，但只允许动「确定没价值」的条目（见
 * `selectEvictions` 的 `conservative`）：① 已失效（superseded/archived）；
 * ② 索引有元数据、importance ≤ 35、无 keep/锁/当前工作区保护。
 *
 * 为什么不直接复用 `TRIGGER_RATIO`：两者数值现在恰好都是 0.85，但含义不同 ——
 * 前者回答「要不要开始压缩」，后者回答「能不能开始删」。将来合并/精简的成本一变，
 * 这两个门槛会各自调整；共用一个常量会让后人误以为它们必须永远相等。
 */
const EVICT_TRIGGER = 0.85;
/**
 * 保守档只淘汰 importance ≤ 35 的条目（0.11 的 0–100 分制）。
 *
 * 50 是缺省「中等」，35 以下才是模型/人明确判过「这是细节、可以不要」的那一档。
 * 高价值条目（importance 70/90）在保守档里一条都不碰 —— 宁可这次压不下去、
 * 让写入报 MEMORY_BUDGET_EXCEEDED，也不拿「不重要的假设」去删用户的核心结论。
 */
const CONSERVATIVE_IMPORTANCE_MAX = 35;
/**
 * 冷缺省档（0.13.2 · A1）：保守档里额外放开的那一类「谁都没明确表态」的条目。
 *
 * 现实：整篇写回会补一批 importance=50 的缺省记录，50 > 35 ⇒ 保守档永远 0 候选，
 * 「写满必挂」。但「缺省 50」不等于「有价值 50」——它只说明没人给它打过分。
 * 只有**三条同时成立**才允许在 85%–100% 区间被保守淘汰：
 *   ① importance 不是显式设置的（`importanceExplicit !== true`，见 store 侧车）；
 *   ② hits ≤ 1（写进来之后基本没被召回/命中过）；
 *   ③ 最后一次活动 > 30 天（真的冷了，不是刚写的）。
 * 缺一条就继续按「不知道重不重要 ⇒ 不删」处理。
 */
const COLD_DEFAULT_MAX_HITS = 1;
const COLD_DEFAULT_MIN_IDLE_DAYS = 30;
/**
 * 冷缺省档单次最多删几条（2）。
 *
 * 与 `MAX_EVICTIONS`（5）分开：这是「宁可少腾一点，也不一口气删一群没人表态的条目」的
 * 独立刹车。dry-run 一定先把名单与正文列给人看；**真删必须显式要**（命令加 `cold`、
 * 或 API 显式 `coldDefaults: true`），写前自动压缩永远拿不到这个开关。
 */
const COLD_DEFAULT_MAX_EVICTIONS = 2;
/** 合并结果的长度上限（字）。 */
const MERGE_MAX_CHARS = 120;
/** 合并候选的语义相似度阈值（归一化到 0–1 后比较，见 00 §9 审计项）。 */
const MERGE_THRESHOLD = 0.7;
/** 每轮最多合并几组。 */
const MERGE_MAX_GROUPS = 3;
/** 一组的条目数区间。 */
const MERGE_GROUP_MIN = 2;
const MERGE_GROUP_MAX = 10;
/**
 * 逐条精简：一次 LLM 调用处理几条（0.8.2 起）。
 *
 * 合并层要求「同组两两相似度 ≥ 0.7」，而真实手写记忆每条都是独立事实 —— 实测
 * Astrbot 的 43 条叶子条目在阈值 0.7/0.6/0.5/0.4 下**都是 0 组**，模板提示词写了
 * 却一次都调不到模型。逐条精简不依赖相似度：按 `## 分组` 顺序分批，输出行数与输入
 * 一一对应，所以层级/编号/子项全部原样保留，只有正文变短。
 */
const SHORTEN_BATCH = 10;
/** 逐条精简：单次压缩最多调几批（文件很大时别无限烧 token）。 */
const SHORTEN_MAX_BATCHES = 8;
/** 逐条精简：比这还短的条目没有压缩空间，直接跳过。 */
const SHORTEN_MIN_CHARS = 24;
/**
 * 逐条精简：MEMORY 正文的长度上限（字）。
 *
 * 与 `store.templates()` 的「MEMORY 条目 ≤200 字」同口径（0.8.3 修）—— 0.8.2 把合并层的
 * 120 字直接套到 MEMORY 上，比条目模板还严，真实手写条目（Astrbot 33 条候选里 16 条
 * 本来就 >120 字）几乎必然「超过 120 字」被拒。FACT 条目模板仍是 ≤120 字。
 */
const MEMORY_BODY_MAX_CHARS = 200;
/** 「## 速查」区：正文禁止行内代码，命令 / 路径 / 键名集中放这里（PLAN 01 §3.2）。 */
const QUICK_SECTION = '速查';
/** 精简输出里「正文 ‖ 速查项」的分隔符（兼容模型常见的几种写法）。 */
const QUICK_SPLIT = /\s*(?:‖|\|\||｜｜|｜)\s*/;
/** 速查项之间的分隔符（提示词要求用「·」）。 */
const QUICK_ITEM_SPLIT = /\s*[·・]\s*/;
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
/** 近因半衰期（天）：越久没被访问，分数按 `exp(-ageDays/90)` 连续衰减。 */
const RECENCY_HALF_LIFE_DAYS = 90;
/** 命中次数达到这个值即满分。 */
const HITS_FULL = 10;
/** 置信度映射（未知/缺省 ⇒ 保守满分，即倾向于"不淘汰"）。 */
const CONFIDENCE_SCORES = { high: 1, medium: 0.5, low: 0.2 };
/**
 * 评分权重（0.11 · DESIGN v3 §12）：近因 0.3 / 命中 0.2 / 置信度 0.1 / **重要性 0.3** / 人工标记 0.1。
 *
 * 为什么把 0.4/0.3/0.2/0.1 改成这组：旧权重里「近因」占四成，一条 90 天没动过的核心约定
 * 会被「昨天刚写、但只是一句废话」的条目挤掉；而重要性（沉淀时由模型按「核心约定/踩坑红线」
 * 判的 0–100）才是静态槽里最该保的东西。五项原始权重合计仍为 1。
 */
const WEIGHTS = { recency: 0.3, hits: 0.2, confidence: 0.1, importance: 0.3, manualLock: 0.1 };
/** 重要性的缺省值：索引里没有这个字段 ⇒ 中等（0.5 分），既不保护也不优先淘汰。 */
const DEFAULT_IMPORTANCE_SCORE = 0.5;
/** 重要性缺省值（0–100 制，与 `store.DEFAULT_IMPORTANCE` 同口径）：保守档据此判「不知道就不删」。 */
const DEFAULT_IMPORTANCE = 50;
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
 * 单条评分：`0.3×近因 + 0.2×命中 + 0.1×置信度 + 0.3×重要性 + 0.1×人工标记`，五项归一化到 0–1。
 *
 * 近因用指数衰减（90 天半衰期），不用旧的「90 天线性窗口」：线性衰减在第 91 天直接掉到 0，
 * 一条「每年用一次」的约定会常年贴着 0 分，比一条昨天刚写的临时发现更容易被删。
 *
 * **缺元数据 ⇒ 返回 1（最高分，永不淘汰）**：索引里没有记录说明我们对这条一无所知，
 * 一无所知就不该被删。同理，字段缺失时取"保守"的一端（近因=1、命中=1、置信度=1、
 * 重要性=0.5——重要性是唯一故意取中间值的，因为它有明确缺省）。
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
    const ageDays = last === null ? 0 : Math.max(0, (nowMs - last) / 86400000);
    const recency = last === null ? 1 : Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
    const hits = Number.isFinite(meta.hits) ? clamp01(meta.hits / HITS_FULL) : 1;
    const confidence = typeof meta.confidence === 'string' && meta.confidence !== ''
        ? (CONFIDENCE_SCORES[meta.confidence.toLowerCase()] ?? 1)
        : 1;
    // 重要性：0–100 归一化；缺失/非法按 50 分（0.5），写坏的值不该让条目突然变成"最该删"。
    const importance = Number.isFinite(meta.importance)
        ? clamp01(meta.importance / 100)
        : DEFAULT_IMPORTANCE_SCORE;
    const manualLock = meta.locked === true ? 1 : 0;
    const score = WEIGHTS.recency * recency +
        WEIGHTS.hits * hits +
        WEIGHTS.confidence * confidence +
        WEIGHTS.importance * importance +
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
 *
 * 0.10 · 条目生命周期：`text` 是**剥离行尾状态注释后的纯正文**（与 `store.factEntries()`
 * 同口径，否则 id 与索引对不上、淘汰候选全成「缺元数据」），`state` 是解析出的状态，
 * `raw` / `lineTexts` 保留原文（备份、改写、审计都按原文）。
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
            const parsed = parseEntryState(numbered !== null ? numbered[3] : bullet[1]);
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
                text: parsed.text.trim(),
                state: parsed.state,
                raw: text,
            });
            continue;
        }
        const bullet = /^-\s+(.+)$/.exec(text);
        if (bullet === null)
            continue;
        const parsed = parseEntryState(bullet[1]);
        entries.push({
            scope: target,
            line: index,
            lines: [index],
            lineTexts: [text],
            section,
            text: parsed.text.trim(),
            state: parsed.state,
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
/**
 * 「冷缺省」判定（0.13.2 · A1）：只有三条同时成立才算——
 * ① `importanceExplicit !== true`（没人显式打过重要性，50 是缺省补的）；
 * ② `hits ≤ 1`（写进来之后基本没被命中过）；
 * ③ 最后一次活动距今 > 30 天（`lastHit` 缺失时用 `firstSeen`；两者都没有就**不判**，
 *    因为「不知道多冷」= 不删）。
 *
 * 为什么 `importanceExplicit` 缺失时按「未显式」处理：老索引没有这个字段，而 50 恰好是
 * 缺省值 —— 把「字段缺失」当成「显式 50」会让整批老记录永远进不了冷缺省档，这正是
 * 真实数据 0 候选的根因。反过来的风险由 ②③ 兜住：刚写的、被命中过的照样不动。
 */
function isColdDefaultCandidate(record, now) {
    if (record === null || typeof record !== 'object')
        return false;
    if (record.importanceExplicit === true)
        return false;
    const hits = Number.isFinite(record.hits) ? record.hits : 0;
    if (hits > COLD_DEFAULT_MAX_HITS)
        return false;
    const last = Number.isFinite(record.lastHit)
        ? record.lastHit
        : (Number.isFinite(record.firstSeen) ? record.firstSeen : null);
    if (last === null)
        return false;
    const idleDays = Math.max(0, (Number.isFinite(now) ? Number(now) : Date.now()) - last) / 86400000;
    return idleDays > COLD_DEFAULT_MIN_IDLE_DAYS;
}
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
 * **保守档**（`options.conservative === true`，0.12.0 · P0）：水位 85%–100% 时用。
 * 在完整档的全部豁免之上再加一条 —— 只允许淘汰
 *  ① 已失效（superseded/archived）条目（分数 0，状态注释是比索引更强的确定信息）；
 *  ② 索引有元数据且 `importance ≤ 35` 的条目（`kind` 不参与判定）。
 * **缺元数据的普通条目在保守档里一律不删**（「一无所知就不删」的纪律不变；缺 importance
 * 时 `memoryIndex()` 会补 50，50 > 35 ⇒ 同样不删）。keep / 显式锁 / 当前工作区保护照旧。
 *
 * `options.report` 是可选的**诊断收集器**（0.8.0 起）：函数把「一共几条 / 各有几条被
 * 什么挡下 / 为什么停手」写进这个对象，命令层据此说人话，而不是把「0 个候选」
 * 一律说成「已达淘汰上限」。`report.mode` 区分 `full` / `conservative`，保守档额外
 * 记 `importanceThreshold` 与 `protectedImportance`（被重要性门槛挡下的条数）。
 *
 * @returns 被选中的条目副本（附 `score`、`dormant`、`importance`），按分数升序。
 */
function selectEvictions(entries, meta, options = {}) {
    const report = options.report !== null && typeof options.report === 'object' ? options.report : null;
    const list = Array.isArray(entries)
        ? entries.filter((entry) => entry !== null && typeof entry === 'object')
        : [];
    const index = meta !== null && typeof meta === 'object' && meta.entries !== null && typeof meta.entries === 'object'
        ? meta
        : null;
    const conservative = options.conservative === true;
    /* 冷缺省档只在保守档里生效：≥100% 的完整档本来就能动普通条目，不需要它。
       dryRun 由 `applyPlan` 侧强制打开（先看名单），真删必须调用方显式要。 */
    const coldDefaults = conservative && options.coldDefaults === true;
    if (report !== null) {
        Object.assign(report, {
            total: list.length,
            candidates: 0,
            selected: 0,
            missingMetadata: 0,
            protectedKeep: 0,
            protectedLock: 0,
            protectedWorkspace: 0,
            protectedImportance: 0,
            mode: conservative ? 'conservative' : 'full',
            importanceThreshold: conservative ? CONSERVATIVE_IMPORTANCE_MAX : null,
            coldDefaults,
            coldDefaultCandidates: 0,
            coldDefaultSelected: 0,
            coldDefaultMax: coldDefaults ? COLD_DEFAULT_MAX_EVICTIONS : 0,
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
    let dormant = 0;
    let highImportance = 0;
    let coldCandidates = 0;
    for (const entry of list) {
        if (hasKeepMarker(entry)) {
            keep += 1;
            continue;
        }
        /* 0.10 · 条目生命周期：`superseded` / `archived` 条目**优先被淘汰**。
           分数压到 0 —— 正常条目最低也有 `0.2 × 0.2 = 0.04`（其余三项全 0 时），
           所以 0 分天然排在「分数升序 + 同分从尾部开始」的最前面，压缩的目标水位
           逻辑一行都不用改（不重写压缩器）。

           为什么「缺元数据」的失效条目也删：淘汰层「一无所知就不删」的理由是
           「不了解这条重不重要」；而状态注释本身就是**比索引更强的确定信息** ——
           「它已经不作数了」。留着只会白占预算。 */
        const isDormant = isDormantState(entry.state);
        const record = index.entries[entry.id];
        if (record === undefined) {
            if (!isDormant) {
                missing += 1;
                continue;
            }
            dormant += 1;
            scored.push({ entry, score: 0 });
            continue;
        }
        if (locks.has(`${entry.scope ?? ''}:${entry.id}`)) {
            locked += 1;
            continue;
        }
        // 工作区保护是「别删别人正在用的结论」；失效条目不是任何人的当前结论，不受它约束
        if (!isDormant && workspaceId !== null && typeof record.workspaceId === 'string' && record.workspaceId === workspaceId) {
            workspace += 1;
            continue;
        }
        /* 0.12.0 · 保守档：只剩「确定没价值」的条目可删。importance 缺失（老索引）时
           memoryIndex() 已补 50（中等），按「不删」处理 —— 宁可这次压不下去，也不把
           「不知道重不重要」的条目当低价值删掉。失效条目不受这条约束（上面已算休眠）。 */
        let coldDefault = false;
        if (!isDormant && conservative) {
            const importance = Number.isFinite(record.importance) ? record.importance : DEFAULT_IMPORTANCE;
            if (importance > CONSERVATIVE_IMPORTANCE_MAX) {
                /* 0.13.2 · 冷缺省档：importance 不是显式设置的、hits ≤ 1、>30 天没活动 ——
                   三条同时成立才准入。它和「importance ≤ 35」是两条独立的准入路径，
                   各自有数量上限，互不占用。 */
                /* 候选判定与「要不要真删」分开：候选数永远算出来（dry 与普通命令都能
                   告诉用户「还有 N 条冷不冷、要不要加 cold」），删不删由下面的 coldDefaults 决定。 */
                if (conservative && isColdDefaultCandidate(record, now)) {
                    coldDefault = true;
                    coldCandidates += 1;
                }
                else {
                    highImportance += 1;
                    continue;
                }
            }
        }
        if (isDormant)
            dormant += 1;
        scored.push({
            entry,
            score: isDormant ? 0 : scoreEntry({ ...record, locked: false }, now, { currentWorkspaceId: workspaceId }),
            dormant: isDormant,
            // 观测用：命令层要能说出「这条为什么在名单里」（失效 / importance 几分 / 冷缺省）
            importance: Number.isFinite(record.importance) ? record.importance : null,
            ...(coldDefault === true ? { coldDefault: true } : {}),
        });
    }
    if (report !== null) {
        Object.assign(report, {
            missingMetadata: missing,
            protectedKeep: keep,
            protectedLock: locked,
            protectedWorkspace: workspace,
            // 诊断口径：保守档被 importance > 35 挡下的条数（完整档恒为 0）
            protectedImportance: highImportance,
            // 诊断口径：本次候选里有几条是「已失效、优先淘汰」的
            dormantPriority: dormant,
            // 冷缺省档：候选数（dry-run 报告要能把「为什么这次能腾空间」说出来）
            coldDefaultCandidates: coldCandidates,
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
    /** 输出副本：分数 + 「为什么被选中」的标签（失效 / importance），命令层直接拿来解释。 */
    const decorate = (item) => ({
        ...item.entry,
        score: round3(item.score),
        ...(item.dormant === true ? { dormant: true } : {}),
        ...(item.coldDefault === true ? { coldDefault: true } : {}),
        ...(Number.isFinite(item.importance) ? { importance: item.importance } : {}),
    });
    /* 冷缺省档的独立刹车：最多 2 条（`COLD_DEFAULT_MAX_EVICTIONS`）。
       超出的条目不是「候选」更不是错误，只是这次不删它们（下一轮/下次命令还有机会）。 */
    let coldSelected = 0;
    let coldSkipped = 0;
    if (base === null) {
        const picked = [];
        for (const item of scored) {
            if (picked.length >= max)
                break;
            if (item.coldDefault === true && (coldDefaults !== true || coldSelected >= COLD_DEFAULT_MAX_EVICTIONS)) {
                coldSkipped += 1;
                continue;
            }
            if (item.coldDefault === true)
                coldSelected += 1;
            picked.push(decorate(item));
        }
        if (report !== null) {
            report.selected = picked.length;
            report.coldDefaultSelected = coldSelected;
            report.coldDefaultSkipped = coldSkipped;
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
        // 未显式要求 / 冷缺省档满 2 条 ⇒ 跳过这条冷条目，但继续看后面（按分数排序）的普通候选。
        if (item.coldDefault === true && (coldDefaults !== true || coldSelected >= COLD_DEFAULT_MAX_EVICTIONS)) {
            coldSkipped += 1;
            continue;
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
        if (item.coldDefault === true)
            coldSelected += 1;
        selected.push(decorate(item));
        view = projected;
        ratio = projectedRatio;
        if (ratio <= target) {
            stop = 'target-reached';
            break;
        }
    }
    if (report !== null) {
        report.selected = selected.length;
        report.coldDefaultSelected = coldSelected;
        report.coldDefaultSkipped = coldSkipped;
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
        '3. 正文不写行内代码：**不要用反引号**，路径与命令直接写成普通文字。',
        '4. 只写结论，不写原因：不要出现「因为/由于/为了/所以/原因是/理由/考虑到/之所以」。',
        '5. 中文叙述，英文只留专有名词；不写密钥、密码、token、手机号、身份证、卡号。',
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

/**
 * 比较用归一化：**去掉反引号**、折叠空白、转小写。
 *
 * 为什么必须先脱掉反引号（0.8.3 修）：行内代码只是排版，不是信息。0.8.2 把
 * 「`…`（连反引号）」整段当成必须逐字保留的 token ⇒ 任何「正文少用行内代码」
 * 的改写都会被判「丢了具体值」，与 PLAN 01 §3.2 的目标正面相反。
 */
function normalizeForCompare(text) {
    return String(text ?? '').replace(/`/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 年份（`2026`）不当作「必须保留的具体值」：日期一般以 `10-26` 的形式出现。 */
const YEAR_TOKEN = /^(19|20)\d{2}$/;

/**
 * 抽"具体值"：**路径、版本号、标识符、端口/编号、配置片段** —— 用来判断改写有没有把信息压没。
 *
 * 三条边界（0.8.3 实测调出来的，都是为了别把「化简」误判成「丢信息」）：
 *  1. 反引号只是排版，比较前一律脱掉（`normalizeForCompare`）；
 *  2. 反引号里的**普通英文词**（`record` / `path` / `url` / `getattr` / `None`）与**年份**
 *     不算具体值 —— 它们本来就该在「正文说人话」时被翻译掉；
 *  3. 纯数字（端口、上限、QQ 号）从**正文文本**里抽；行内代码只有带
 *     `\\ / : _ . - = @ [ ] { } ( )` 分隔符的才算（版本号、`base64://`、`provider.modalities`）。
 */
function concreteTokens(text) {
    const source = String(text ?? '');
    const tokens = new Set();
    // ① 正文里的数字（端口 / 上限 / 次数 / QQ 号），年份不算
    for (const match of source.match(/\d{2,}/g) ?? []) {
        if (!YEAR_TOKEN.test(match))
            tokens.add(match);
    }
    // ② 正文里的路径 / URL
    for (const match of source.match(/[A-Za-z0-9._-]*[\\/][A-Za-z0-9._/\\-]+/g) ?? [])
        tokens.add(match.toLowerCase());
    // ③ 行内代码：只留「看起来是值」的（带分隔符），普通英文词直接跳过
    for (const raw of source.match(/`[^`\n]+`/g) ?? []) {
        const inner = normalizeForCompare(raw);
        if (inner === '' || YEAR_TOKEN.test(inner))
            continue;
        // JSON 片段（["image"]）不整段比对：它的值已经在别的 token 里了
        if (/^[[{]/.test(inner))
            continue;
        if (/[\\/:_.\-=@[\]{}()]/.test(inner))
            tokens.add(inner);
    }
    return [...tokens];
}

/**
 * 原文里的具体值，在「新正文」里找不到的（`target` 可以是正文 + 速查项的合并串）。
 *
 * 比较一律走 `normalizeForCompare()`：去掉反引号、折叠空白、忽略大小写。
 */
function missingConcreteTokens(source, target) {
    const haystack = normalizeForCompare(target);
    return concreteTokens(source).filter((token) => !haystack.includes(token));
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
    // 行内代码只是排版：统一脱掉反引号（PLAN 01 §3.2「正文禁止行内代码」）
    const merged = lines[0].replace(/`/g, '').trim();
    if (merged === '')
        return { ok: false, reason: '空结果' };
    if (merged.length > MERGE_MAX_CHARS)
        return { ok: false, reason: `超过 ${MERGE_MAX_CHARS} 字（实际 ${merged.length} 字）` };
    const sources = Array.isArray(options.sources) ? options.sources.join('\n') : String(options.sources ?? '');
    const wanted = concreteTokens(sources);
    const lost = missingConcreteTokens(sources, merged);
    if (wanted.length > 0 && lost.length === wanted.length)
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
        /* 0.9.0 · P1-4：条目级自动备份（毫秒戳 `-<yyyyMMdd-HHmmssSSS>.bak`）已经搬到
           `backups/auto/`；这里再排除一遍毫秒戳文件名，是为了兼容老版本留在 `backups/`
           根的历史文件 —— 压缩侧的修剪绝不能删 store 写的备份。 */
        .filter((item) => !/-\d{8}-\d{9}(?:-\d+)?\.bak$/.test(item))
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
    // 0.9.0 · P0-3：回滚也按目标文件取锁，和 store 的整篇/条目级写入互斥
    const release = await acquireWriteLock(target, { cwd: options?.cwd, path, timeoutMs: options?.timeoutMs });
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

/**
 * 速查项的比较键：脱掉反引号、折叠空白、去掉标点、转小写 —— 用来去重。
 */
function quickItemKey(text) {
    return String(text ?? '')
        .replace(/`/g, '')
        .replace(/\s+/g, '')
        .replace(/[。；;，,、·・:：]/g, '')
        .toLowerCase();
}

/**
 * 把命令 / 路径落到「## 速查」区（PLAN 01 §3.2：正文说人话，命令集中放一处）。
 *
 * - 文件里已有 `## 速查` ⇒ 追加到该分组末尾（下一个 `## ` 之前）；没有 ⇒ 在文件末尾新建；
 * - 每项渲染成 `- \`…\``（速查区允许行内代码，正文禁止）；
 * - 已存在的同项不重复追加（按 `quickItemKey()` 去重），空项跳过。
 *
 * 纯函数：只返回新行数组，不碰文件。
 */
function mergeQuickSection(lines, items) {
    const list = Array.isArray(lines) ? [...lines] : [];
    const wanted = [];
    const seen = new Set();
    for (const item of Array.isArray(items) ? items : []) {
        const text = String(item ?? '').replace(/`/g, '').trim();
        if (text === '')
            continue;
        const key = quickItemKey(text);
        if (key === '' || seen.has(key))
            continue;
        seen.add(key);
        wanted.push(text);
    }
    if (wanted.length === 0)
        return list;
    // 速查区渲染成纯文本清单（`- 项`）：不加反引号，省掉每项 2 字的排版开销，
    // 也避免「正文禁行内代码、速查又全是行内代码」的怪样式。
    const bullet = (text) => `- ${text}`;
    let head = -1;
    for (let index = 0; index < list.length; index += 1) {
        const heading = /^##\s+(.+?)\s*$/.exec(list[index]);
        if (heading !== null && /^速查/.test(heading[1].trim())) {
            head = index;
            break;
        }
    }
    if (head < 0) {
        while (list.length > 0 && list[list.length - 1] === '')
            list.pop();
        return [...list, '', `## ${QUICK_SECTION}`, '', ...wanted.map(bullet)];
    }
    let end = list.length;
    for (let index = head + 1; index < list.length; index += 1) {
        if (/^##\s+/.test(list[index])) {
            end = index;
            break;
        }
    }
    const existing = new Set();
    for (let index = head + 1; index < end; index += 1) {
        if (/^\s*-\s+/.test(list[index]))
            existing.add(quickItemKey(list[index].replace(/^\s*-\s+/, '')));
    }
    const add = wanted.filter((text) => !existing.has(quickItemKey(text)));
    if (add.length === 0)
        return list;
    // 插在分组末尾（跳过尾部空行，保住与下一个 ## 之间的空行）
    let at = end;
    while (at > head + 1 && list[at - 1].trim() === '')
        at -= 1;
    list.splice(at, 0, ...add.map(bullet));
    return list;
}

function joinLines(lines, raw) {
    if (lines.length === 0)
        return '';
    return `${lines.join('\n')}${String(raw ?? '').endsWith('\n') ? '\n' : ''}`;
}

/**
 * 给「被改写过的条目」补一份**内存里的**元数据视图（不落盘）。
 *
 * 为什么需要：条目 id 是 `entryId(firstSeen, text)`，正文一变 id 就变。压缩是在
 * 同一轮里先改写再淘汰的，若淘汰层还读磁盘上的旧索引，改写过的条目就都成了
 * 「缺元数据」⇒ 一律不删 ⇒ 大文件永远压不下来。这里按原记录把 `firstSeen/hits/
 * confidence` 平移到新 id 上：分数不变，改写不该影响"这条重不重要"。
 */
function withPlanMetadata(index, plan, now) {
    const base = index !== null && typeof index === 'object' && index.entries !== null && typeof index.entries === 'object'
        ? index.entries
        : {};
    const extra = {};
    for (const item of Array.isArray(plan) ? plan : []) {
        const head = Array.isArray(item?.entries) ? item.entries[0] : undefined;
        if (head === undefined || head === null)
            continue;
        const original = base[head.id];
        const firstSeen = Number.isFinite(original?.firstSeen) ? original.firstSeen : now;
        const id = entryId(firstSeen, item.text);
        extra[id] = {
            scope: head.scope ?? 'memory',
            workspaceId: original?.workspaceId ?? null,
            firstSeen,
            lastHit: Number.isFinite(original?.lastHit) ? original.lastHit : firstSeen,
            hits: Number.isFinite(original?.hits) ? original.hits : 0,
            confidence: typeof original?.confidence === 'string' ? original.confidence : 'low',
            // 重要性/分层必须一起平移：保守淘汰按 importance ≤ 35 判定，丢了就补成 50（永远删不掉）；
            // 评分也会从「30 分」悄悄变成「50 分」，改写过的条目会突然比没改写的更"值钱"。
            ...(Number.isFinite(original?.importance) ? { importance: original.importance } : {}),
            ...(typeof original?.kind === 'string' && original.kind !== '' ? { kind: original.kind } : {}),
        };
    }
    return { ...index, entries: { ...base, ...extra } };
}

/**
 * 把计划应用到正文上（纯函数，不落盘）：
 * ① 合并（FACT 按 `- ` 列表；MEMORY 保留原编号与缩进）→ ② 淘汰：
 *    - 合并后仍 **≥ 100%** ⇒ 完整淘汰（普通条目也可动）；
 *    - 合并后落在 **85%–100%** ⇒ **保守淘汰**（只动失效条目与 importance ≤ 35 的条目）。
 *
 * @returns `{text, merged, evicted, ratio, reason, diagnostics}`；`merged` 与 `evicted`
 *          都为空表示**什么都没发生**（`text` 可能只差尾部空行归一化，调用方不该写盘）。
 */
function applyPlan(target, raw, limit, plan, options = {}) {
    const lines = splitLines(raw);
    const replacements = new Map();
    const removals = new Set();
    const merged = [];
    /** 从正文搬去「## 速查」区的命令 / 路径（MEMORY 才有）。 */
    const quickItems = [];
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
        const quick = [];
        const seenQuick = new Set();
        for (const text of Array.isArray(item.quick) ? item.quick : []) {
            const value = String(text ?? '').trim();
            if (value === '')
                continue;
            const key = quickItemKey(value);
            if (key === '' || seenQuick.has(key))
                continue;
            seenQuick.add(key);
            quick.push(value);
        }
        if (target === 'memory')
            quickItems.push(...quick);
        merged.push({
            section: item.section,
            from: item.entries.map((entry) => entry.text),
            to: item.text,
            // 'merge' = N 合 1；'shorten' = 1 条改写回 1 条（口径不同，审计里要能分开数）
            kind: item.kind === 'shorten' ? 'shorten' : 'merge',
            // 从这条正文搬进速查区的命令/路径（审计里能看清「正文少行内代码」到底搬了什么）
            ...(quick.length > 0 ? { quick } : {}),
        });
    }
    let rewritten = rewriteLines(lines, replacements, removals);
    if (target === 'memory' && merged.length > 0) {
        // 只重排**被合并过的分组**：别的分组即便历史上就有编号空洞，也绝不顺手改。
        rewritten = renumberNumbered(rewritten, new Set(merged.map((item) => item.section ?? '')));
    }
    // 正文改完了，再把这些条目里的命令/路径集中落到「## 速查」区（没有就新建）
    if (target === 'memory' && quickItems.length > 0)
        rewritten = mergeQuickSection(rewritten, quickItems);
    let text = joinLines(rewritten, raw);
    let ratio = ratioOf(withLimit(measuresOf(text), limit));
    const evicted = [];
    // 淘汰层的诊断（没进淘汰层就是 null）：reason 说明为什么没删 / 为什么停手。
    let diagnostics = null;
    let reason = merged.length === 0 ? 'no-op' : 'merged';
    /* 0.12.0 · 淘汰层的两档门槛：
        - >100%：完整淘汰（可动普通条目，先删失效/低分，最多 5 条，投影到 ≤75%）；
        - 85%–100%：**保守淘汰**（只动失效条目与 importance ≤ 35 的条目）—— 这是为了
          「99.7% 的项目记忆下一个 insertEntry 必撞上限、而模型不可用时命令只说文件未改动」
          那条真实故障；85% 以下不进淘汰层，合并/精简腾出的空间已经够了。 */
    const conservative = ratio < 1;
    if (ratio >= (conservative ? EVICT_TRIGGER : 1)) {
        diagnostics = {};
        const index = memoryIndex();
        // 改写过的条目 id 会变：先把元数据平移到新 id，否则淘汰层会看到一堆「缺元数据」
        const effective = withPlanMetadata(index, plan, Number.isFinite(options.now) ? Number(options.now) : Date.now());
        const entries = resolveEntryIds(parseEntries(target, text), effective);
        const picked = selectEvictions(entries, effective, {
            now: options.now,
            watermark: withLimit(measuresOf(text), limit),
            maxEvictions: options.maxEvictions,
            targetRatio: options.targetRatio,
            workspaceId: options.workspaceId,
            conservative,
            coldDefaults: options.coldDefaults === true,
            report: diagnostics,
        });
        if (picked.length > 0) {
            const nextLines = splitLines(text);
            const drop = new Set();
            for (const entry of picked) {
                for (const line of entry.lines)
                    drop.add(line);
                evicted.push({
                    id: entry.id,
                    text: entry.text,
                    score: entry.score,
                    section: entry.section ?? '',
                    // 观测字段：命令层能说出「删的是失效条目」还是「importance 20 的细节」
                    ...(entry.dormant === true ? { dormant: true } : {}),
                    // 冷缺省档单独标记：dry-run 报告与审计要能区分「低分」与「没人表态」
                    ...(entry.coldDefault === true ? { coldDefault: true } : {}),
                    ...(Number.isFinite(entry.importance) ? { importance: entry.importance } : {}),
                });
            }
            text = joinLines(rewriteLines(nextLines, new Map(), drop), text);
            ratio = ratioOf(withLimit(measuresOf(text), limit));
            reason = merged.length === 0
                ? (conservative ? 'conservative-evicted' : 'evicted')
                : (conservative ? 'merged+conservative-evicted' : 'merged+evicted');
        }
        else {
            reason = merged.length === 0
                ? (conservative ? 'conservative-no-eviction' : 'no-eviction')
                : 'merged';
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
       带子项的条目合并会把「编号行 + 缩进子项」整体并成一行，层级就散了。
       0.10：失效条目**不进合并计划** —— 它已经不进提示词，改写它没有收益；
       而且合并输出是模型写的纯正文，状态注释会在这一步丢掉（「失效的条目悄悄复活」）。 */
    const entries = parseEntries(target, raw)
        .filter((entry) => !isDormantState(entry.state))
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

/* ═══════════════ 逐条精简（0.8.2 · LLM 按模板压缩） ═══════════════
 * 与合并层的分工：
 *  - 合并层：N 条**相似**条目 → 1 条（会改变条目数，故要重排编号）；
 *  - 精简层：N 条条目 → 仍是 N 条，只是每条更短（不改变结构，不需要重排）。
 *
 * 为什么必须有精简层：合并层的门槛是「同一分组内两两相似度 ≥ 0.7」，而真实手写
 * 记忆里每条都是一个独立事实（不同的命令/字段/坑），本机 Astrbot 43 条叶子条目
 * 实测 0.7→0.4 全部 0 组 —— 模型从来没被调用过。精简层不依赖相似度，只依赖
 * 「条目够长」，所以对这类文件有效。
 */

/**
 * 逐条精简的提示词：**行数与顺序一一对应**，每条必须更短且不许丢具体值。
 *
 * 与 `buildMergePrompt` 的关键差别：那里输出 1 行（N 合 1），这里输出 N 行。
 * 后者不改变条目语义边界，是「改写」而不是「合并」，风险低得多。
 */
function buildShortenPrompt(entries, options = {}) {
    const target = options.target === 'memory' ? 'memory' : 'fact';
    const file = target === 'memory' ? 'MEMORY.md' : 'FACT.md';
    const count = Array.isArray(entries) ? entries.length : 0;
    const section = typeof options.section === 'string' && options.section !== '' ? `「## ${options.section}」分组里的 ` : '';
    const list = (Array.isArray(entries) ? entries : [])
        .map((entry, index) => `${index + 1}. ${String(entry?.text ?? '').trim()}`)
        .join('\n');
    if (target === 'memory') {
        /* MEMORY（0.8.3）：正文说人话 + 命令/路径搬进「## 速查」区（PLAN 01 §3.2）。
           输出用「正文‖速查项」两段式：程序按 ‖ 切开，正文落原位、速查项追加到速查区。
           示例与「最多 6 项」是实测调出来的：不给示例，模型会把正文原样留着、再把所有
           英文标识符一股脑塞进速查，整条比原文还长（首版实测 8 条全被拒）。 */
        return [
            `下面是 ${file} ${section}${count} 条结论，请**逐条**改写：正文说人话，命令与路径搬去「## ${QUICK_SECTION}」区。`,
            '',
            list,
            '',
            '示例（只学格式，别抄内容）：',
            '输入：- **中转**（`/opt/*` + systemd）：`new-api`:3000（网关 `v1.0.0-rc.46`，SQLite `data/one-api.db`）',
            '输出：本机四个中转都在 /opt 下由 systemd 托管，new-api 是网关‖/opt·new-api:3000·v1.0.0-rc.46·data/one-api.db',
            '',
            '规则：',
            `1. 必须输出 ${count} 行，顺序与上面一一对应；一行一条，不要空行，不要解释。`,
            `2. 每行格式：\`正文‖速查项\`。正文是**中文口语化的一句话**，**不许出现反引号**；硬上限 ${MEMORY_BODY_MAX_CHARS} 字（超了整条作废），目标 120 字左右。`,
            '3. 速查项只放「要逐字照抄」的东西：命令、路径、包名、配置键名；**最多 6 项**。没搬进速查的具体值必须留在正文里，不许丢（普通英文词、日期、事故描述、状态说明不用搬）。',
            '4. 正文必须真的删减：合并重复描述、删掉取证细节与客套话；数字、版本号、路径可以只保留在速查项里，不用在正文重复。',
            '5. 具体值不许丢：原文里的版本号、路径、命令、包名、数字必须出现在正文或速查项里（信息量不得减少）；但普通词不要为了强调加反引号。',
            '6. 只写结论，不写原因：不要出现「因为/由于/为了/所以/原因是/理由/考虑到/之所以」。',
            '7. 中文叙述，英文只留专有名词；不写密钥、密码、token、手机号、身份证、卡号。',
            '8. 每条直接写正文，不要带编号或列表符号。',
            '9. 验收标准：**正文 + 速查项合计必须比原文短**（超了整条作废），别把原文原样搬过去。',
        ].join('\n');
    }
    return [
        `下面是 ${file} ${section}${count} 条结论，请**逐条**改写得更短。`,
        '',
        list,
        '',
        '规则：',
        `1. 必须输出 ${count} 行，顺序与上面一一对应；一行一条，不要空行，不要解释。`,
        `2. 每条不超过 ${MERGE_MAX_CHARS} 字，而且必须比原文更短：删掉修饰语、重复铺垫和客套话，只留结论本身。`,
        '3. 保留所有具体值：版本号、路径、命令、包名、数字都不能丢（合并后信息量不得减少）。',
        '4. 正文不写行内代码：**不要用反引号**，路径与命令直接写成普通文字。',
        '5. 只写结论，不写原因：不要出现「因为/由于/为了/所以/原因是/理由/考虑到/之所以」。',
        '6. 中文叙述，英文只留专有名词；不写密钥、密码、token、手机号、身份证、卡号。',
        '7. 每条直接写正文，不要带编号、列表符号或前缀。',
    ].join('\n');
}

/**
 * 把一行「正文‖速查项」切成两段。没有 ‖ ⇒ 只有正文。
 *
 * `‖`（以及模型常见的 `||` / `｜`）只是标记，不写进正文；速查项按「·」再切。
 */
function splitQuickPart(row) {
    const match = QUICK_SPLIT.exec(row);
    if (match === null)
        return { body: row, quick: [] };
    const body = row.slice(0, match.index).trim();
    const tail = row.slice(match.index + match[0].length).trim();
    const quick = tail === ''
        ? []
        : tail.split(QUICK_ITEM_SPLIT).map((item) => item.trim()).filter((item) => item !== '');
    return { body, quick };
}

/**
 * 解析逐条精简结果 → `{ok, lines, quicks, rejected}`。
 *
 * `lines[i]` 是第 i 条的新**正文**，`null` 表示**这一条保持原样**（没变短/超长/丢具体值）。
 * `quicks[i]` 是同一行的速查项数组（`null` 表示这一条没通过），由 `applyPlan` 追加到
 * `## 速查` 区 —— 正文里不许再出现行内代码（PLAN 01 §3.2）。
 *
 * 单条不合格只跳过那一条，不连坐整批 —— 手写记忆里本来就有几条已经压得很紧。
 *
 * 拒绝口径：空、正文超上限（MEMORY 200 / FACT 120 字）、**正文 + 速查项合计没变短**、
 * 具体值（版本号/路径/命令）在正文与速查项里都找不到。行内代码**不算具体值**：
 * 反引号一律脱掉再比（0.8.3 修，见 `normalizeForCompare`）。
 */
function parseShortenResult(text, options = {}) {
    const target = options.target === 'memory' ? 'memory' : 'fact';
    const cap = target === 'memory' ? MEMORY_BODY_MAX_CHARS : MERGE_MAX_CHARS;
    const sources = Array.isArray(options.sources) ? options.sources.map((item) => String(item ?? '')) : [];
    if (typeof text !== 'string' || text.trim() === '')
        return { ok: false, reason: '空结果', lines: [], quicks: [] };
    const body = text.replace(/```[a-z]*\n?/gi, ' ').trim();
    const rows = body
        .split(/\r?\n/)
        .map((line) => stripMergeDecoration(line))
        .filter((line) => line !== '');
    if (rows.length !== sources.length)
        return { ok: false, reason: `行数不符（期望 ${sources.length} 行，实际 ${rows.length} 行）`, lines: [], quicks: [] };
    const lines = [];
    const quicks = [];
    const rejected = [];
    for (let index = 0; index < rows.length; index += 1) {
        const source = sources[index].trim();
        const parsedRow = target === 'memory' ? splitQuickPart(rows[index]) : { body: rows[index], quick: [] };
        // 行内代码只是排版：先脱掉反引号。模型把命令留在正文里也照样能过（只是没搬去速查）
        const merged = parsedRow.body.replace(/`/g, '').trim();
        const quick = parsedRow.quick
            .map((item) => item.replace(/`/g, '').trim())
            .filter((item) => item !== '');
        if (merged === '') {
            lines.push(null);
            quicks.push(null);
            rejected.push(`第 ${index + 1} 条为空`);
            continue;
        }
        if (merged.length > cap) {
            lines.push(null);
            quicks.push(null);
            rejected.push(`第 ${index + 1} 条超过 ${cap} 字（实际 ${merged.length} 字）`);
            continue;
        }
        // 速查项渲染成一行 `- 项`，按 +2 字估算，避免「体量从正文搬到速查」伪装成压缩
        const total = merged.length + quick.reduce((sum, item) => sum + item.length + 2, 0);
        if (total >= source.length) {
            lines.push(null);
            quicks.push(null);
            rejected.push(`第 ${index + 1} 条没有变短（${source.length} → ${total}）`);
            continue;
        }
        const lost = missingConcreteTokens(source, `${merged}\n${quick.join('\n')}`);
        if (lost.length > 0) {
            lines.push(null);
            quicks.push(null);
            rejected.push(`第 ${index + 1} 条丢了具体值（${lost.slice(0, 3).join('、')}）`);
            continue;
        }
        lines.push(merged);
        quicks.push(quick);
    }
    const used = lines.filter((line) => typeof line === 'string').length;
    if (used === 0)
        return { ok: false, reason: rejected[0] ?? '没有可用的改写', lines, quicks, rejected };
    return { ok: true, lines, quicks, used, rejected };
}

/**
 * 生成逐条精简计划：**只读、不写、不拿锁**（与 `planMerges` 同一纪律）。
 *
 * 边界与合并层保持一致，避免两套豁免规则打架：
 *  - MEMORY 只碰**叶子条目**（`lines.length === 1`）：带子项的条目改写首行会与子项
 *    语义脱节（测试明确断言这种条目 `callModel` 一次都不许被调）；
 *  - 跳过 `<!-- keep -->`、显式锁定、以及已被合并计划吃掉的条目（`skipLines`）；
 *  - 太短（`< SHORTEN_MIN_CHARS`）的条目没有压缩空间。
 *
 * @returns `{plan, blocks, calls, rewritten, rejected}`；`plan` 的每项只含 1 个条目，
 *          `text` 是改写后的正文（`applyPlan` 会沿用原来的编号/缩进前缀）。
 */
async function planShortenings(target, raw, callModel, options = {}) {
    const empty = { plan: [], blocks: 0, calls: 0, rewritten: 0, rejected: [] };
    if (typeof callModel !== 'function')
        return empty;
    if (target !== 'fact' && target !== 'memory')
        return empty;
    const skip = options.skipLines instanceof Set ? options.skipLines : new Set();
    const batchSize = Number.isFinite(options.shortenBatchSize)
        ? Math.max(1, Math.trunc(options.shortenBatchSize))
        : SHORTEN_BATCH;
    const maxBatches = Number.isFinite(options.shortenMaxBatches)
        ? Math.max(0, Math.trunc(options.shortenMaxBatches))
        : SHORTEN_MAX_BATCHES;
    if (maxBatches === 0)
        return empty;
    const locks = lockKeySet(options.locks);
    const index = memoryIndex();
    const entries = resolveEntryIds(parseEntries(target, raw), index).filter((entry) => {
        if (target === 'memory' && (!Array.isArray(entry.lines) || entry.lines.length !== 1))
            return false;
        // 0.10：失效条目不走改写 —— 改写会把行尾状态注释丢掉，等于把一条主张废的结论
        // 重新塞回注入（而且正文还变了）。它的处置只有一条：淘汰。
        if (isDormantState(entry.state))
            return false;
        if (skip.has(entry.line))
            return false;
        if (hasKeepMarker(entry))
            return false;
        if (locks.has(`${entry.scope ?? ''}:${entry.id}`))
            return false;
        return String(entry.text ?? '').trim().length >= SHORTEN_MIN_CHARS;
    });
    if (entries.length === 0)
        return empty;
    // 按分组顺序分批（同组连续条目放一起），保持输出顺序与文件顺序一致
    const buckets = new Map();
    for (const entry of entries) {
        const section = typeof entry.section === 'string' ? entry.section : '';
        if (!buckets.has(section))
            buckets.set(section, []);
        buckets.get(section).push(entry);
    }
    const plan = [];
    const rejected = [];
    let calls = 0;
    for (const [section, list] of buckets) {
        for (let start = 0; start < list.length; start += batchSize) {
            if (calls >= maxBatches)
                return { plan, blocks: calls, calls, rewritten: plan.length, rejected };
            const block = list.slice(start, start + batchSize);
            if (block.length === 0)
                continue;
            calls += 1;
            const answer = await withTimeout(
                callModel(buildShortenPrompt(block, { target, section }), {
                    entries: block,
                    target,
                    section,
                    session: options.session,
                }),
                options.callTimeoutMs,
            );
            if (typeof answer !== 'string' || answer.trim() === '')
                continue;
            const parsed = parseShortenResult(answer, { sources: block.map((entry) => entry.text), target });
            if (parsed.ok !== true) {
                rejected.push(...(parsed.rejected ?? [parsed.reason]));
                continue;
            }
            block.forEach((entry, at) => {
                const text = parsed.lines[at];
                if (typeof text !== 'string')
                    return;
                // `quick` 是这条从正文搬去「## 速查」区的命令/路径（MEMORY 才有）
                plan.push({ section, entries: [entry], text, quick: parsed.quicks?.[at] ?? [], kind: 'shorten' });
            });
        }
    }
    return { plan, blocks: calls, calls, rewritten: plan.length, rejected };
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
 * 85%–100% 的保守档一条都没删：说清「保守档只动哪两类条目」以及被什么挡下。
 *
 * 与 `explainNoEviction` 分开写：完整档在 ≥100% 时「没删」是**失败**（要报预算超限），
 * 保守档在 <100% 时「没删」只是**这次没腾出空间**（文件本来就没超限），措辞不能混。
 */
function explainConservativeSkip(diagnostics, ratio) {
    const d = diagnostics !== null && typeof diagnostics === 'object' ? diagnostics : {};
    const pct = `${Math.round((Number.isFinite(ratio) ? ratio : 0) * 100)}%`;
    const parts = [];
    let indexHint = false;
    if (d.reason === 'index-missing') {
        parts.push('侧车索引 memory/index.json 不存在');
        indexHint = true;
    }
    else if (d.reason === 'index-empty') {
        parts.push('侧车索引为空');
        indexHint = true;
    }
    if ((d.missingMetadata ?? 0) > 0) {
        parts.push(`${d.missingMetadata} 条缺元数据`);
        indexHint = true;
    }
    if ((d.protectedImportance ?? 0) > 0)
        parts.push(`${d.protectedImportance} 条重要性 > ${CONSERVATIVE_IMPORTANCE_MAX}`);
    /* 冷缺省档：候选不为 0 时一定要说，否则用户看到「保守档未淘汰任何条目」会以为
       机制坏了 —— 实际是「等你先看 dry-run 名单、再决定要不要加 cold」。 */
    if ((d.coldDefaultCandidates ?? 0) > 0)
        parts.push(`${d.coldDefaultCandidates} 条冷缺省候选（hits≤${COLD_DEFAULT_MAX_HITS}、>${COLD_DEFAULT_MIN_IDLE_DAYS} 天未命中、importance 为缺省值；可加 cold 参数删，单次最多 ${COLD_DEFAULT_MAX_EVICTIONS} 条）`);
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
    const why = parts.length > 0 ? parts.join('，') : '没有已失效或 importance ≤ 35 的条目';
    const hints = [];
    if (indexHint)
        hints.push('先跑 /memory-compact memory seed 回填索引');
    if ((d.coldDefaultCandidates ?? 0) > 0 && d.coldDefaults !== true)
        hints.push('确认名单后加 cold 参数才会真删冷缺省条目');
    const hint = hints.length > 0 ? `；${hints.join('；')}` : '';
    return `水位 ${pct}，保守档未淘汰任何条目（${why}${hint}）`;
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
 * 合并后 85%~100% → **保守淘汰**（只动失效条目与 importance ≤ 35 的条目，最多 5 条，投影到 ≤75%）
 * 合并后 ≥ 100%   → 淘汰（普通条目也可动，最多 5 条，投影到 ≤75%）
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
    /* 0.13.2 · A1：「先出 dry-run 报告，再真删」——dry 一律把冷缺省档的名单算出来，
       真删必须调用方显式要（命令加 cold / API 传 coldDefaults:true）。写前自动压缩
       走 `runCompaction()`，那里永远不传这个开关。 */
    const coldDefaults = options?.coldDefaults === true || dryRun;
    const callModel = typeof options?.callModel === 'function' ? options.callModel : null;
    const before = watermark(target, { cwd });
    if (before.path === null)
        return { ok: false, scope: target, skipped: 'no-target' };
    const beforeRatio = ratioOf(before);
    if (beforeRatio < TRIGGER_RATIO)
        return { ok: false, scope: target, skipped: 'below-watermark', before, ratio: round3(beforeRatio) };
    const runId = newRunId();
    const preImage = readText(before.path) ?? '';
    /* ① 锁外：LLM 计划（慢，且绝不能在写锁里做；dryRun 也只读不写）
       —— 先合并相似条目（N 合 1），再把没被合并吃掉的条目逐条精简（N 回 N）。
       两层都走同一份 pre-image 与同一个 callModel，失败/超时只是少压一点。 */
    const mergePlan = await planMerges(target, preImage, callModel, options);
    const touchedLines = new Set();
    for (const item of mergePlan) {
        for (const entry of item.entries) {
            for (const line of Array.isArray(entry?.lines) ? entry.lines : [entry?.line]) {
                if (Number.isFinite(line))
                    touchedLines.add(line);
            }
        }
    }
    const shorten = await planShortenings(target, preImage, callModel, { ...options, skipLines: touchedLines });
    const plan = mergePlan.concat(shorten.plan);
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
        // 本轮淘汰层用的是哪一档（full / conservative）；命令与面板据此换措辞
        conservative: false,
        // 本轮冷缺省档是否打开（dry=true 恒开；真删只有显式要求才开）
        coldDefaults,
        // 逐条精简的诊断（命令/面板据此说"压缩了几条"，而不是把改写也算成"合并几组"）
        shorten: { calls: shorten.calls, rewritten: shorten.rewritten, rejected: shorten.rejected.slice(0, 5) },
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
        result.conservative = result.diagnostics?.mode === 'conservative';
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
            else if (result.conservative) {
                // 85%–100% 的保守档没找到可删的：不是失败（文件本来就没超限），
                // 但必须说清「被什么挡下」，否则用户只会看到「文件未改动」。
                result.message = explainConservativeSkip(result.diagnostics, beforeRatio);
            }
            return result;
        }
        result.after = auditBody(measuresOf(applied.text), applied.text);
        result.ratio = round3(applied.ratio);
        if (applied.ratio >= 1) {
            result.ok = false;
            result.error = 'MEMORY_BUDGET_EXCEEDED';
            const head = explainShortfall(result.diagnostics, applied.ratio, options?.maxEvictions ?? MAX_EVICTIONS);
            // 让用户看得出「LLM 已经干过活」：压了几条、有几条被安全校验挡下
            const note = result.shorten.rewritten > 0
                ? `；本轮 LLM 逐条压缩 ${result.shorten.rewritten} 条` +
                    (result.shorten.rejected.length > 0
                        ? `，另有 ${result.shorten.rejected.length} 条因未变短/丢具体值被拒`
                        : '')
                : '';
            result.message = `${head}${note}`;
        }
        return result;
    };
    if (dryRun)
        return settle(applyPlan(target, preImage, before.limit, plan, { ...options, coldDefaults }));
    /* ② 锁内：重读 → 变了就放弃 → 规划 → 备份 → 一次原子写 → 审计 */
    // 0.9.0 · P0-3：memory 作用域的锁键按**目标文件**（与 store 的写入路径同一把锁）
    const release = await acquireWriteLock(target, { cwd, path: before.path, timeoutMs: options?.timeoutMs });
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
            coldDefaults,
            workspaceId: target === 'fact' ? options?.workspaceId : null,
        });
        settle(applied);
        if (!result.changed)
            return result;
        const backup = writeBackup(before.path, current, options?.keepBackups ?? DEFAULT_KEEP_BACKUPS);
        writeAtomic(before.path, applied.text);
        // 改写/淘汰都会让旧 id 变成孤儿：立刻按新正文同步侧车索引，
        // 否则下一轮压缩会看到"全是缺元数据"⇒ 0 候选（大文件会卡死在这里）。
        syncIndexAfterWrite(target, before.path, applied.text, {
            workspaceId: target === 'fact' ? options?.workspaceId : null,
        });
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
        // 淘汰层门槛（0.12.0）：85%–100% 走保守档，>100% 走完整档
        evictTrigger: EVICT_TRIGGER,
        conservativeImportanceMax: CONSERVATIVE_IMPORTANCE_MAX,
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
    CONSERVATIVE_IMPORTANCE_MAX,
    DEFAULT_CALL_TIMEOUT,
    DEFAULT_KEEP_BACKUPS,
    EVICT_TRIGGER,
    KEEP_MARKER,
    MAX_EVICTIONS,
    MEMORY_BODY_MAX_CHARS,
    MERGE_MAX_CHARS,
    MERGE_MAX_GROUPS,
    MERGE_THRESHOLD,
    QUICK_SECTION,
    TARGET_RATIO,
    TRIGGER_RATIO,
    applyPlan,
    auditPath,
    backupsDir,
    buildMergePrompt,
    buildShortenPrompt,
    compact,
    compactionStatus,
    concreteTokens,
    groupFactCandidates,
    hasKeepMarker,
    lastRun,
    measuresOf,
    mergeQuickSection,
    missingConcreteTokens,
    normalizeForCompare,
    parseEntries,
    parseMergeResult,
    parseShortenResult,
    planMerges,
    planShortenings,
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
