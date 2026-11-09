/**
 * JOURNAL 检索：分词 + BM25 + 时效衰减（0.10.0 · 契约第 8 节）。
 *
 * 为什么要有这一层：0.9.0 的 `searchJournal()` 是 `text.toLowerCase().includes(query)`，
 * 三个硬伤：
 *  1. **搜不到换说法**——搜「写入侧」搜不到「写侧」，搜「召回」搜不到「recall」；
 *  2. **没有排序**——命中就是命中，只有时间倒序，最相关的一条可能排在第 40 位；
 *  3. **没有时效**——半年前的临时笔记和昨天的结论一样重。
 *
 * 这里给的解法是**相关性优先、时效微调**：BM25 决定主体分数，再乘一个
 * `exp(-ageDays / HALF_LIFE_DAYS)` 的衰减。为什么不是纯时间排序：日志是
 * 「当时发生了什么」的流水账，越近越相关只是弱先验，不能让三天前的噪音压过
 * 半年前的那条准确结论。
 *
 * 与 recall 包的分词口径**必须一致**（同样是 CJK 2-gram + 拉丁整词 + 同一套停用词），
 * 但这里是主插件，**不能 import recall 源码**（独立发布的包），所以内联一份。
 * 两份实现的一致性由两边各自的 `test/tokenize.test.mjs` 与这边的测试共同锁定：
 * 改动任何一边都要同步改另一边，否则「同一句话在召回与检索里切出不同的词」。
 */

/* ───────────────────────── 分词（与 recall/lib/tokenize.js 同口径） ───────────────────────── */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const LATIN = /[a-z0-9_]/;
const LATIN_INNER = /[a-z0-9_]/;

/** 单字停用词：只去掉纯虚词，保留「在线」「和值」这类有实义的组合。 */
const CJK_STOP_UNIGRAM = new Set('的了是在和也就都而及与或我你他她它这那不有会要把被给从到对为以于之其上下中个些吗呢吧啊嗯哦嘛呀们着过之'.split(''));
/** 双字停用词。 */
const CJK_STOP_BIGRAM = new Set([
    '我们', '你们', '他们', '她们', '它们', '这个', '那个', '这些', '那些',
    '什么', '怎么', '为什么', '没有', '可以', '就是', '还是', '因为', '所以',
    '但是', '如果', '现在', '已经', '自己', '知道', '不是', '需要', '应该',
    '时候', '问题', '一个', '一下', '一些', '这样', '那样', '如何', '是否',
]);
/** 助词：出现在 2-gram 里就丢掉（「的方」「了塞」这类纯噪声）。 */
const CJK_PARTICLE = new Set('的了着过吗呢吧啊嗯哦嘛呀'.split(''));

/** NFKC + 小写（与 tokenize 内部口径一致，外部比较用）。 */
export function normalizeSearchText(text) {
    return String(text ?? '').normalize('NFKC').toLowerCase();
}

/**
 * 分词：拉丁/数字按整词（≥2 字符），CJK 按 2-gram，跳过停用词。保留重复（BM25 要词频）。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeForSearch(text) {
    const source = normalizeSearchText(text);
    const tokens = [];
    let index = 0;
    while (index < source.length) {
        const char = source[index];
        if (CJK.test(char)) {
            let end = index;
            while (end < source.length && CJK.test(source[end])) end += 1;
            const run = source.slice(index, end);
            if (run.length === 1) {
                if (!CJK_STOP_UNIGRAM.has(run)) tokens.push(run);
            }
            else {
                for (let offset = 0; offset + 1 < run.length; offset += 1) {
                    const gram = run.slice(offset, offset + 2);
                    if (CJK_STOP_BIGRAM.has(gram)) continue;
                    if (CJK_PARTICLE.has(gram[0]) || CJK_PARTICLE.has(gram[1])) continue;
                    tokens.push(gram);
                }
            }
            index = end;
            continue;
        }
        if (LATIN.test(char)) {
            let end = index;
            while (end < source.length && LATIN_INNER.test(source[end])) end += 1;
            const word = source.slice(index, end);
            index = end;
            if (word.length >= 2) tokens.push(word);
            continue;
        }
        index += 1;
    }
    return tokens;
}

/* ───────────────────────── BM25（k1=1.2, b=0.75，与 recall 一致） ───────────────────────── */

const K1 = 1.2;
const B = 0.75;

/**
 * 建倒排。`tokenLists` 每条一份 token 列表（保留重复）。
 *
 * @param {string[][]} tokenLists
 * @returns {{ docs: { tf: Map<string, number>, len: number }[], df: Map<string, number>, N: number, avgdl: number }}
 */
export function buildSearchIndex(tokenLists) {
    const docs = [];
    const df = new Map();
    let totalLength = 0;
    for (const tokens of tokenLists) {
        const tf = new Map();
        for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
        for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
        docs.push({ tf, len: tokens.length });
        totalLength += tokens.length;
    }
    const N = docs.length;
    return { docs, df, N, avgdl: N === 0 ? 0 : totalLength / N };
}

/**
 * 给全部文档打分，返回按分数降序的 `{ index, score }`（只含 score > 0）。
 *
 * @param {{ docs: { tf: Map<string, number>, len: number }[], df: Map<string, number>, N: number, avgdl: number }} index
 * @param {string[]} queryTokens
 * @returns {{ index: number, score: number }[]}
 */
export function scoreSearchIndex(index, queryTokens) {
    const { docs, df, N, avgdl } = index;
    if (N === 0 || avgdl === 0) return [];
    const unique = [...new Set(queryTokens)];
    const idf = new Map();
    for (const token of unique) {
        const frequency = df.get(token) ?? 0;
        if (frequency === 0) continue;
        idf.set(token, Math.log(1 + (N - frequency + 0.5) / (frequency + 0.5)));
    }
    if (idf.size === 0) return [];
    const scored = [];
    for (let position = 0; position < docs.length; position += 1) {
        const doc = docs[position];
        let score = 0;
        for (const [token, weight] of idf) {
            const tf = doc.tf.get(token);
            if (tf === undefined) continue;
            score += (weight * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * doc.len) / avgdl));
        }
        if (score > 0) scored.push({ index: position, score });
    }
    return scored.sort((left, right) => right.score - left.score || left.index - right.index);
}

/* ───────────────────────── 时效衰减与排序 ───────────────────────── */

/** 时效衰减的半衰期（天）。90 天 = 一个季度，正好覆盖「这轮工作的有效期」。 */
export const TIME_HALF_LIFE_DAYS = 90;

/** 子串精确命中的保底系数：至少拿到最高分的这个比例，避免精确关键词排到后面。 */
const SUBSTRING_FLOOR = 0.6;

/** 时间戳解析：字符串 ISO / 数字毫秒都收，解析不出来给 null（不猜）。 */
function timestampOf(entry) {
    const value = entry?.ts;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

/**
 * 时效系数：`exp(-ageDays / HALF_LIFE)`。
 *
 * 时间戳缺失 / 解析失败 → **1（中性）**，而不是 0：不因为一条日志少了 ts 就把它埋掉。
 * 未来时间（时钟漂移）→ 也按 0 天算，不放大。
 *
 * @param {number | null} ts
 * @param {number} now
 * @returns {number}
 */
export function recencyFactor(ts, now) {
    if (ts === null) return 1;
    const ageDays = Math.max(0, (now - ts) / 86400000);
    return Math.exp(-ageDays / TIME_HALF_LIFE_DAYS);
}

/**
 * 在（已按时间正序读入的）日志条目里检索。
 *
 * 行为矩阵：
 *  - `query` 为空、`tag` 有值 → 按 tag 过滤后**时间倒序**（保持 0.9.0 行为，不引入打分）；
 *  - `query` 有值 → BM25 打分 × 时效系数，子串精确命中给保底，取前 `limit`；
 *  - 两者都空 → 时间倒序。
 *
 * 返回的是**原条目对象**（不重建、不改写），调用方拿它当 API 返回值。
 *
 * @param {{ ts?: any, tags?: string[], text?: string }[]} entries 时间正序
 * @param {{ query?: string, tag?: string, limit?: number, now?: number }} [options]
 * @returns {any[]}
 */
export function rankJournalEntries(entries, options = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.trunc(options.limit)) : list.length;
    const needle = String(options.query ?? '').trim();
    const wanted = String(options.tag ?? '').trim().toLowerCase();
    const filtered = wanted === ''
        ? list
        : list.filter((entry) => Array.isArray(entry?.tags) && entry.tags.some((tag) => String(tag).toLowerCase() === wanted));

    // 无 query：不打分，保持原顺序（调用方给的是时间正序，这里翻成倒序）。
    if (needle === '') return filtered.slice().reverse().slice(0, limit);

    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const queryTokens = tokenizeForSearch(needle);
    const normalizedNeedle = normalizeSearchText(needle);

    // 子串命中的下标集合（保底用）。BF 匹配在 2000 条上是毫秒级，不需要额外结构。
    const substringHits = new Set();
    filtered.forEach((entry, index) => {
        if (normalizeSearchText(entry?.text ?? '').includes(normalizedNeedle)) substringHits.add(index);
    });

    // 分词后一个 token 都没有（比如整句都是停用词）→ 退化成子串匹配，别返回空。
    if (queryTokens.length === 0) {
        return filtered
            .map((entry, index) => ({ entry, index }))
            .filter((item) => substringHits.has(item.index))
            .reverse()
            .slice(0, limit)
            .map((item) => item.entry);
    }

    const index = buildSearchIndex(filtered.map((entry) => tokenizeForSearch(entry?.text ?? '')));
    const scored = scoreSearchIndex(index, queryTokens);
    const scoreByIndex = new Map(scored.map((hit) => [hit.index, hit.score]));
    // 子串命中也必须进候选集：分词切碎后可能一个词都不匹配（同义词、缩写）。
    for (const hitIndex of substringHits) {
        if (!scoreByIndex.has(hitIndex)) scoreByIndex.set(hitIndex, 0);
    }
    if (scoreByIndex.size === 0) return [];

    const top = Math.max(...scoreByIndex.values());
    const ranked = [...scoreByIndex.entries()].map(([entryIndex, score]) => {
        const entry = filtered[entryIndex];
        const base = substringHits.has(entryIndex) ? Math.max(score, top * SUBSTRING_FLOOR) : score;
        const final = base * recencyFactor(timestampOf(entry), now);
        return { entry, index: entryIndex, score: final };
    });

    ranked.sort((left, right) => right.score - left.score || right.index - left.index);
    return ranked.slice(0, limit).map((item) => item.entry);
}
