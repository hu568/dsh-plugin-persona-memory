/**
 * @dsh-external/dsh-persona-memory — 提示词段落渲染。
 *
 * 渲染是纯函数：快照 + config + 注入开关进，字符串出，不读盘（路径只进契约文案）。
 * 段落顺序、插值开关与作用域判定在 index.js 的 apply 里注册。
 */
import { dirname } from 'node:path';
import { PROJECT_MEMORY_FILE, factPath, journalPath } from './store.js';
import { DEFAULT_MAX_FACT_BYTES, DEFAULT_MAX_FACT_LINES, DEFAULT_MAX_PROJECT_CHARS, INJECT_PROJECT_ONLY } from './config.js';

export function clip(text, maxChars) {
    const trimmed = text.trim();
    return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n…（已截断）` : trimmed;
}
/* ────────────────────────────── 提示词渲染 ────────────────────────────── */
export const ROLE_CONTRACT = [
    '【角色设定】以上 <soul>/<user> 是你的角色与用户档案，来自角色库。',
    '改动角色文件对新会话生效；本会话的注入内容在首条消息时已固化（KV 缓存前缀稳定）。',
    '用 `persona` 工具查看/切换/新建/编辑角色（action: list | current | show | use | create | update | delete）。',
].join('\n');
export function memoryContract(globalPath, journalFile, projectPath, journalTotal, maxFactLines, maxFactBytes, maxProjectChars, flags) {
    const hint = journalTotal > 0
        ? `- 历史日志（${journalFile}）现有 ${journalTotal} 条，**正文未注入**（它是无上限增长的流水账）；觉得「以前可能聊过 / 踩过坑」就主动 action=search 查，别当成没有历史。`
        : `- 历史日志（${journalFile}）目前为空；记录一次性事件用 action=append。`;
    const lines = ['【记忆写入契约】本工具没有路径参数，一律走 `memory` 工具：'];
    if (flags.globalMemory) {
        lines.push(`- 长期事实（跨会话稳定）→ action=update, scope=global（写 ${globalPath}），整篇覆盖，请带上已有内容。**硬上限 ${maxFactLines} 行 AND ${maxFactBytes} 字节（UTF-8），任一超限都会被工具拒绝。**`);
    }
    if (flags.projectMemory) {
        lines.push(projectPath === null
            ? `- 项目事实 → action=update, scope=project（写当前项目根的 MEMORY.md；当前项目还没有该文件，写入即创建）。**上限 ${maxProjectChars} 字符。**`
            : `- 项目事实 → action=update, scope=project（写 ${projectPath}），整篇覆盖。**上限 ${maxProjectChars} 字符（与注入侧 maxChars 同口径，超限会被拒绝而不是截断）。**`);
    }
    if (flags.globalMemory && flags.projectMemory) {
        lines.push(`- ★分界线：只有「换任何项目都成立」的事实才进全局；本工作区的约定、机制探索结论、清单与踩坑一律写 scope=project。全局预算只有 ${maxFactLines} 行 / ${maxFactBytes} 字节，别把项目内容塞进来。`);
    }
    lines.push(`- 一次性事件/会话笔记 → action=append（追加到 ${journalFile}，可带 tags）。JOURNAL 无上限且不注入，适合放长流水账。`);
    lines.push('- 检索历史笔记 → action=search（子串 + 可选 tag）。');
    lines.push(hint);
    lines.push('写入立即落盘；本会话注入的是首条消息时的快照，更新内容在**新会话**生效。');
    return lines.join('\n');
}
/**
 * 子代理版记忆契约：只指向项目 MEMORY.md，不提全局 FACT.md。
 * 明确写出「全局记忆与角色未注入」以免子代理以为它们不存在而乱猜。
 */
export function projectMemoryContract(projectPath, projectRoot, journalTotal, maxProjectChars) {
    return [
        '【记忆写入契约】子代理只拿到**项目记忆**，角色设定与全局记忆（FACT.md）均未注入。',
        `- 项目事实 → action=update, scope=project（写 ${projectPath}），整篇覆盖，请带上已有内容。**上限 ${maxProjectChars} 字符，超限会被拒绝。**`,
        '- 需要全局记忆或历史笔记时 → action=read / action=search（只读，别写全局）。',
        `- 项目根：${projectRoot}。`,
        `- 长期日志（${journalPath()}）现有 ${journalTotal} 条，正文未注入；需要旧笔记时 action=search。`,
        '写入立即落盘；本会话注入的是首条消息时的快照，更新内容在**新会话**生效。',
    ].join('\n');
}
export function renderPersona(snapshot, config, which, scope, flags) {
    // 子代理：不注入角色（SOUL/USER 属于「你是谁的长期人设」，与委派任务无关）。
    if (scope === INJECT_PROJECT_ONLY)
        return '';
    if (!flags.persona)
        return '';
    const persona = snapshot.persona;
    if (persona === null)
        return '';
    const body = which === 'soul' ? persona.soul : persona.user;
    if (body === '')
        return '';
    const header = which === 'soul'
        ? `<soul persona="${persona.name}" id="${persona.id}">`
        : `<user persona="${persona.name}">`;
    const tag = which === 'soul' ? 'soul' : 'user';
    const parts = [`${header}\n${clip(body, config.maxChars)}\n</${tag}>`];
    if (which === 'soul')
        parts.push(ROLE_CONTRACT);
    return parts.join('\n\n');
}
export function renderFacts(snapshot, config, scope, flags) {
    const maxProjectChars = config.maxProjectChars ?? DEFAULT_MAX_PROJECT_CHARS;
    // 子代理：只注入项目记忆，跳过全局 FACT.md 与全局写入契约。
    if (scope === INJECT_PROJECT_ONLY) {
        if (!flags.projectMemory)
            return '';
        if (snapshot.project === null)
            return '';
        const content = clip(snapshot.project.content, config.maxChars);
        if (content === '')
            return '';
        const root = snapshot.project.root ?? dirname(snapshot.project.path);
        return [
            `<memory scope="project">`,
            `### 项目记忆（${snapshot.project.path}）`,
            content,
            `</memory>`,
            '',
            projectMemoryContract(snapshot.project.path, root, snapshot.journalTotal ?? 0, maxProjectChars),
        ].join('\n');
    }
    const global = flags.globalMemory ? clip(snapshot.globalFact, config.maxChars) : '';
    const project = flags.projectMemory && snapshot.project !== null ? clip(snapshot.project.content, config.maxChars) : '';
    if (!flags.globalMemory && project === '')
        return '';
    const blocks = [];
    if (flags.globalMemory)
        blocks.push(`### 全局记忆（FACT.md）\n${global === '' ? '（暂无）' : global}`);
    if (project !== '')
        blocks.push(`### 项目记忆（${snapshot.project?.path ?? PROJECT_MEMORY_FILE}）\n${project}`);
    const contract = memoryContract(
        factPath(),
        journalPath(),
        snapshot.project === null ? null : snapshot.project.path,
        snapshot.journalTotal ?? 0,
        config.maxFactLines ?? DEFAULT_MAX_FACT_LINES,
        config.maxFactBytes ?? DEFAULT_MAX_FACT_BYTES,
        maxProjectChars,
        flags,
    );
    return `<memory>\n${blocks.join('\n\n')}\n</memory>\n\n${contract}`;
}
