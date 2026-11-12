/**
 * @dsh-external/dsh-persona-memory — `/memory-compact` 命令与压缩结果文案。
 *
 * 契约：handler **永远返回 `{kind, text}`，绝不 throw** —— 用户要看到原因，
 * 而不是宿主的「命令失败」。写前 hook、命令、面板共用 `runCompaction()` 这一个装配点。
 */
import { join } from 'node:path';
import { DEFAULT_KEEP_BACKUPS, compact, rollbackCompaction, seedMetadata } from './compaction.js';
import { memoryDir } from './store.js';


export function percent(ratio) {
    return Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : '—';
}

export function describeMeasures(measures) {
    if (measures === null || typeof measures !== 'object')
        return '—';
    return `${measures.lines ?? '?'} 行 / ${measures.bytes ?? '?'} 字节 / ${measures.chars ?? '?'} 字符`;
}

/** 命令结果里的目标路径（issue 要求：用户得看得出命令动的是哪个文件）。 */
export function compactPathLine(result) {
    return typeof result?.path === 'string' && result.path !== '' ? `\n  路径：${result.path}` : '';
}
/** 逐条列出被淘汰（dry 时「将淘汰」）的条目 + 分数/失效/重要性：3–5 条，直接给人看。 */
export function describeEvicted(result, dryRun) {
    if (!Array.isArray(result?.evicted) || result.evicted.length === 0)
        return [];
    const lines = [`  ${dryRun ? '将淘汰' : '已淘汰'}：`];
    // 只有保守档才加「失效 / importance」标注：完整档保持既有格式（（score x）），
    // 老用户的命令输出与既有断言都不该被新字段挤变形。
    const conservative = result.conservative === true || result.diagnostics?.mode === 'conservative';
    for (const item of result.evicted) {
        const text = String(item.text ?? '');
        const tags = [];
        if (conservative) {
            if (item.dormant === true)
                tags.push('失效条目');
            // 冷缺省档必须单独标：它删的是 importance=50 的「没人表态」条目，
            // 不标的话用户会以为它在删普通中等条目。
            if (item.coldDefault === true)
                tags.push('冷缺省');
            if (Number.isFinite(item.importance))
                tags.push(`importance ${item.importance}`);
        }
        tags.push(`score ${item.score}`);
        lines.push(`  - ${text.length > 60 ? `${text.slice(0, 60)}…` : text}（${tags.join('，')}）`);
    }
    return lines;
}

export function describeCompactionResult(scope, result, dryRun) {
    const label = scope === 'fact' ? 'FACT.md' : 'MEMORY.md';
    const prefix = dryRun ? '[dry] ' : '';
    if (result === null || result === undefined)
        return `${prefix}${label}：没有结果`;
    const pathLine = compactPathLine(result);
    if (result.skipped === 'no-target')
        return scope === 'fact'
            ? `${prefix}${label}：全局记忆文件不存在，跳过`
            : `${prefix}${label}：当前项目没有 MEMORY.md，跳过`;
    if (result.skipped === 'below-watermark')
        return `${prefix}${label}：水位 ${percent(result.ratio)} < 85%，无需压缩${pathLine}`;
    if (result.skipped === 'changed')
        return `${prefix}${label}：期间有其它写入，本轮放弃（内容一字未改）${pathLine}`;
    const finish = (head) => [head, ...describeEvicted(result, dryRun)].join('\n');
    /* 逐条精简「调了模型却 0 条通过」必须说话（0.8.3）：0.8.2 就是这么静默失败的 ——
       两轮各花 100+ 秒调 LLM，8 批全被安全校验拒掉，用户只看到「已淘汰 5 条」。 */
    const shortenRejected = Array.isArray(result.shorten?.rejected) ? result.shorten.rejected : [];
    const shortenCalls = Number(result.shorten?.calls ?? 0);
    const shortenNote = shortenCalls > 0 && shortenRejected.length > 0
        && (result.merged ?? []).every((item) => item?.kind !== 'shorten')
        ? `\n  逐条精简：调了 ${shortenCalls} 批、0 条通过（${shortenRejected.slice(0, 3).join('；')}${shortenRejected.length > 3 ? ' …' : ''}）`
        : '';
    if (result.error === 'MEMORY_BUDGET_EXCEEDED')
        return finish(`${prefix}${label}：${result.message ?? '压缩后仍超限'} → MEMORY_BUDGET_EXCEEDED${pathLine}${shortenNote}`);
    /* 0.12.0 · 淘汰层分两档：85%–100% 是保守档（只动失效 / importance ≤ 35），文案必须
       说清是哪一档，否则用户看到「淘汰 2 条」会以为完整档也在删普通条目。 */
    const conservative = result.conservative === true || result.diagnostics?.mode === 'conservative';
    if (result.changed === false) {
        const head = conservative
            ? (result.message ?? `水位 ${percent(result.ratio)}，保守档未淘汰任何条目`)
            : `水位 ${percent(result.ratio)}，未达到淘汰线且没有可合并/可精简的条目`;
        return `${prefix}${label}：${head}，文件未改动${pathLine}${shortenNote}`;
    }
    const items = Array.isArray(result.merged) ? result.merged : [];
    const mergeGroups = items.filter((item) => item?.kind !== 'shorten').length;
    const shortened = items.filter((item) => item?.kind === 'shorten').length;
    const parts = [`合并 ${mergeGroups} 组`];
    if (shortened > 0)
        parts.push(`压缩 ${shortened} 条`);
    parts.push(`淘汰 ${result.evicted?.length ?? 0} 条`);
    const modeNote = conservative
        ? `，保守档只动失效条目 / importance ≤ ${result.diagnostics?.importanceThreshold ?? 35} 的条目 / 冷缺省条目`
        : '';
    // 冷缺省档真删了要额外说一声：dry 名单是给人看的，真删只有显式 cold 才会发生。
    const coldSelected = Number(result.diagnostics?.coldDefaultSelected ?? 0);
    const coldNote = coldSelected > 0
        ? `\n  冷缺省档：${dryRun ? '将删' : '已删'} ${coldSelected} 条（importance 为缺省值、hits≤1、>30 天未命中；单次上限 ${result.diagnostics?.coldDefaultMax ?? 2} 条）`
        : '';
    return finish(`${prefix}${label}：水位 ${percent(result.beforeRatio)} → ${percent(result.ratio)}（${parts.join(' / ')}${modeNote}）${pathLine}${shortenNote}${coldNote}`);
}

/** 统一的压缩参数装配点：写前 hook、命令、面板都从这里过。 */
export function runCompaction(scope, options, config, deps) {
    const given = typeof options?.cwd === 'string' && options.cwd !== '' ? options.cwd : undefined;
    const cwd = given ?? deps.latestCwd();
    return compact(scope, {
        cwd,
        dryRun: options?.dryRun === true,
        workspaceId: deps.workspaceIdOf(cwd),
        session: options?.session ?? deps.sessionFor?.(cwd),
        callModel: config.compactionEnabled === true ? deps.callModel : null,
        keepBackups: config.compactKeepBackups ?? DEFAULT_KEEP_BACKUPS,
        /* 冷缺省档只有显式要求才打开：写前自动压缩（store 的 compactBeforeWrite）不传它，
           于是永远不会「为了让水位降下来」自动删没人表态的条目。 */
        coldDefaults: options?.coldDefaults === true,
        trigger: typeof options?.trigger === 'string' ? options.trigger : 'manual',
    });
}

/** `seed` 子命令的结果文案：说清回填几条、索引写在哪、dry 时列出将回填哪些。 */
export function describeSeedResult(scope, result, dryRun) {
    const label = scope === 'fact' ? 'FACT.md' : 'MEMORY.md';
    const prefix = dryRun ? '[dry] ' : '';
    if (result === null || result === undefined)
        return `${prefix}${label}：没有结果`;
    if (result.skipped === 'no-target')
        return scope === 'fact'
            ? `${prefix}${label}：全局记忆文件不存在，跳过`
            : `${prefix}${label}：当前项目没有 MEMORY.md，跳过`;
    if (result.ok !== true)
        return `${prefix}${label}：回填失败（${result.message ?? result.error ?? '未知原因'}）`;
    if (result.seeded === 0)
        return `${prefix}${label}：索引已齐（${result.total} 条全部有元数据），无需回填`;
    const lines = [
        `${prefix}${label}：${dryRun ? '将回填' : '已回填'} ${result.seeded} 条（共 ${result.total} 条，已有 ${result.alreadyIndexed} 条元数据）`,
        `  索引：${join(memoryDir(), 'index.json')}`,
    ];
    if (dryRun) {
        const preview = result.entries.slice(0, 10).map((item) => `  - ${String(item.text).slice(0, 60)}`);
        lines.push(...preview);
        if (result.entries.length > preview.length)
            lines.push(`  ……还有 ${result.entries.length - preview.length} 条`);
    }
    return lines.join('\n');
}

export const COMPACT_USAGE = '用法：/memory-compact [fact|memory|all] [dry] [seed] [cold]　或　/memory-compact rollback <yyyyMMdd-HHmmss>（不带参数 = 压缩当前项目的 MEMORY.md；先 seed 回填索引；cold = 允许真删冷缺省条目，先用 dry 看名单）';

/** 不带参数时的默认作用域：项目级 MEMORY.md（主人 2026-11-01 要求）。 */
export const COMPACT_DEFAULT_VERB = 'memory';

/**
 * `/memory-compact` 的 handler。
 *
 * 契约：**永远返回 `{kind, text}`，绝不 throw**（宿主会把抛出的 handler 结算成
 * `command/done` 错误，用户看到的是一句"命令失败"而不是我们能解释的原因）。
 */
export async function runCompactCommand(invocation, config, deps) {
    try {
        const tokens = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter((token) => token !== '');
        const isDryToken = (token) => {
            const lower = String(token ?? '').toLowerCase();
            return lower === 'dry' || lower === '--dry';
        };
        const isSeedToken = (token) => String(token ?? '').toLowerCase() === 'seed';
        /* cold：允许真删「冷缺省」条目（importance=缺省值 + hits≤1 + >30 天未命中）。
           为什么单独一个 token：这是唯一会删「没人明确说过不重要」的正文的出口，
           必须先 dry 看过名单再手动加它，绝不能让写前自动压缩顺手删。 */
        const isColdToken = (token) => String(token ?? '').toLowerCase() === 'cold';
        const first = (tokens[0] ?? '').toLowerCase();
        const usedDefault = first === '' || isDryToken(first) || isSeedToken(first) || isColdToken(first);
        const verb = usedDefault ? COMPACT_DEFAULT_VERB : first;
        if (config.compactionEnabled !== true)
            return { kind: 'error', text: '压缩管线已关闭（compactionEnabled=false）：在组合配置里把它改回 true，重启 DSH 后再试。' };
        const cwd = typeof invocation?.agent?.session?.header?.cwd === 'string' && invocation.agent.session.header.cwd !== ''
            ? invocation.agent.session.header.cwd
            : deps.latestCwd();
        if (verb === 'rollback') {
            const stamp = tokens[1] ?? '';
            if (stamp === '')
                return { kind: 'error', text: COMPACT_USAGE };
            const rolled = await rollbackCompaction(stamp, { cwd });
            if (rolled.ok !== true)
                return { kind: 'error', text: `回滚失败：${rolled.message ?? rolled.error}` };
            return {
                kind: 'success',
                text: `已回滚 ${rolled.path}\n备份：${rolled.backup}\nSHA256：${rolled.sha256}\n体量：${describeMeasures(rolled.before)} → ${describeMeasures(rolled.after)}`,
            };
        }
        if (verb !== 'fact' && verb !== 'memory' && verb !== 'all')
            return { kind: 'error', text: COMPACT_USAGE };
        const dryRun = tokens.some(isDryToken);
        const seed = tokens.some(isSeedToken);
        const cold = tokens.some(isColdToken);
        const scopes = verb === 'all' ? ['fact', 'memory'] : [verb];
        const lines = [];
        const session = invocation?.agent?.session;
        let failed = 0;
        for (const scope of scopes) {
            if (seed) {
                const seeded = seedMetadata(scope, { cwd, dryRun, workspaceId: deps.workspaceIdOf(cwd) });
                lines.push(describeSeedResult(scope, seeded, dryRun));
                if (seeded?.ok === false && seeded?.skipped === undefined)
                    failed += 1;
                continue;
            }
            const result = await runCompaction(scope, { cwd, dryRun, coldDefaults: cold, trigger: 'command', session }, config, deps);
            lines.push(describeCompactionResult(scope, result, dryRun));
            if (result?.ok === false && typeof result?.error === 'string')
                failed += 1;
        }
        if (seed) {
            lines.push('提示：seed 只补侧车索引元数据（firstSeen/lastHit = 文件 mtime、hits=0、confidence=low），不删任何正文；确认计划后跑不带 seed 的命令才会真删（≤5 条，压到 75% 起步）。');
        }
        else if (verb !== 'fact') {
            lines.push('提示：MEMORY.md 只处理「同一段落里没有子项的叶子条目」——先合并相似条目，再逐条精简；编号与缩进原样保留。');
        }
        if (!seed && !cold && !dryRun) {
            lines.push('提示：冷缺省条目（importance 缺省 50、hits≤1、>30 天未命中）默认不删。先跑 dry 看将删名单（会标「冷缺省」），确认后加 cold 才会真删，单次最多 2 条。');
        }
        return { kind: failed > 0 ? 'error' : 'success', text: lines.join('\n') };
    }
    catch (error) {
        return { kind: 'error', text: `压缩失败：${String(error?.message ?? error)}` };
    }
}

