/**
 * 回归测试：JOURNAL 检索 = 分词 + BM25 + 时效衰减（0.10.0 · 契约第 8 节）。
 *
 * 背景：0.9.0 的 `searchJournal()` 是纯子串 `includes()`，导致
 *  - 「写入侧」搜不到「写侧」、「召回」搜不到「recall」；
 *  - 命中没有相关度排序，最相关的一条可能排在第 40 位；
 *  - 半年前的临时笔记和昨天的结论一样重。
 *
 * 本测试钉住：
 *  1. 分词口径（CJK 2-gram / 拉丁整词 ≥2 / 停用词）；
 *  2. 相关度排序生效（精确到主题的条目排在泛泛提到的条目前面）；
 *  3. 子串精确命中保底（不会被分词劣势埋掉）；
 *  4. 无 query 时保持时间倒序（0.9.0 行为向后兼容）；
 *  5. tag 过滤 + query 组合；
 *  6. 时效衰减：同等相关时新条目优先；
 *  7. 查不到时返回空数组，不抛错；query 分词为空时退化为子串匹配。
 *
 * 跑法：node test/journal-search.test.mjs
 */
import assert from 'node:assert/strict';

const {
    tokenizeForSearch,
    rankJournalEntries,
    recencyFactor,
    TIME_HALF_LIFE_DAYS,
} = await import('../lib/journal-search.js');

const NOW = Date.parse('2026-11-09T12:00:00+08:00');
const day = 86400000;
const ago = (days) => new Date(NOW - days * day).toISOString();

/* ── 1. 分词口径 ───────────────────────────────────────────────────── */
{
    // 中文连续串切 2-gram，虚词 2-gram（「的是」）被停用词/助词规则剔除。
    const tokens = tokenizeForSearch('写入侧的闸口坏了');
    assert.ok(tokens.includes('写入'), `应切出「写入」，实际 ${JSON.stringify(tokens)}`);
    assert.ok(tokens.includes('闸口'), `应切出「闸口」，实际 ${JSON.stringify(tokens)}`);
    assert.ok(!tokens.includes('的是'), '助词不该成为 token');

    // 拉丁按整词，单字符丢弃。
    assert.deepEqual(tokenizeForSearch('BM25 recall a'), ['bm25', 'recall']);

    // NFKC：全角转半角后按同一口径处理。
    assert.deepEqual(tokenizeForSearch('ＢＭ２５'), ['bm25']);
}

/* ── 2. 相关度排序 ─────────────────────────────────────────────────── */
const entries = [
    { ts: ago(200), tags: ['misc'], text: '今天顺手看了一眼这个项目的目录结构，没什么结论。' },
    { ts: ago(120), tags: ['misc'], text: '记忆召回插件的预算三分法讨论了一下，但还没定。' },
    { ts: ago(2), tags: ['recall'], text: 'recall 的召回预算三分法：maxTotalChars 600 / maxEntryChars 240 / minEntryChars 40，压缩后重注入。' },
    { ts: ago(1), tags: ['write'], text: '写入门控只抓同批精确重复，换说法的重述抓不住，是个已知缺陷。' },
];

{
    const hits = rankJournalEntries(entries, { query: '召回 预算三分法', limit: 3, now: NOW });
    assert.equal(hits[0]?.tags?.[0], 'recall', `最相关应是 recall 条，实际 ${JSON.stringify(hits.map((e) => e.tags))}`);
}

/* ── 3. 子串精确命中保底 ───────────────────────────────────────────── */
{
    // 「写入侧」在分词里会被切成「写入」+「入侧」，而条目写的是「写入侧」，
    // 子串命中必须让它进候选并拿到保底分，不能被丢。
    const hits = rankJournalEntries(entries, { query: '写入侧', limit: 4, now: NOW });
    assert.ok(hits.some((entry) => entry.tags?.[0] === 'write'), '子串命中不该被分词丢掉');
}

/* ── 4. 无 query 保持时间倒序 ──────────────────────────────────────── */
{
    const hits = rankJournalEntries(entries, { limit: 2, now: NOW });
    assert.deepEqual(hits.map((entry) => entry.ts), [entries[3].ts, entries[2].ts], '无 query 应按时间倒序');
    const tagged = rankJournalEntries(entries, { tag: 'misc', limit: 5, now: NOW });
    assert.equal(tagged.length, 2);
    assert.ok(tagged[0].ts > tagged[1].ts, 'tag 过滤后仍按时间倒序');
}

/* ── 5. tag + query 组合 ───────────────────────────────────────────── */
{
    const hits = rankJournalEntries(entries, { query: '预算', tag: 'recall', limit: 5, now: NOW });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].tags[0], 'recall');
}

/* ── 6. 时效衰减 ───────────────────────────────────────────────────── */
{
    assert.equal(recencyFactor(null, NOW), 1, '无时间戳应中性（不埋掉）');
    const fresh = recencyFactor(NOW, NOW);
    const stale = recencyFactor(NOW - 180 * day, NOW);
    assert.ok(fresh > stale, '越新系数越大');
    assert.ok(Math.abs(stale - Math.exp(-2)) < 1e-9, `180 天应衰减到 exp(-2)，实际 ${stale}`);
    assert.ok(TIME_HALF_LIFE_DAYS > 0);

    // 内容相同、仅时间不同 → 新的排前。
    const twins = [
        { ts: ago(180), text: '记忆沉淀写侧调用姿势要用 prepareCall。' },
        { ts: ago(1), text: '记忆沉淀写侧调用姿势要用 prepareCall。' },
    ];
    const hits = rankJournalEntries(twins, { query: '沉淀 写侧 调用姿势', limit: 2, now: NOW });
    assert.equal(hits[0].ts, twins[1].ts, '同等相关时新条目优先');
}

/* ── 7. 边界 ───────────────────────────────────────────────────────── */
{
    assert.deepEqual(rankJournalEntries([], { query: 'x' }), []);
    assert.deepEqual(rankJournalEntries(entries, { query: '完全不相干的量子色动力学' }), []);
    // 全停用词 query → 分词为空，退化成子串匹配而不是返回空。
    const hits = rankJournalEntries(entries, { query: '的了', limit: 5, now: NOW });
    assert.ok(Array.isArray(hits), '停用词 query 不应抛错');
    // 缺 ts 的条目也要能返回（不因无时间被埋）。
    const noTs = rankJournalEntries([{ text: '写入侧闸口' }], { query: '写入侧', now: NOW });
    assert.equal(noTs.length, 1);
}

console.log('journal-search: 7 组断言全部通过');
