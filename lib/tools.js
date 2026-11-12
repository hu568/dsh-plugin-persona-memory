/**
 * @dsh-external/dsh-persona-memory — 模型可见的两个工具（memory / persona）。
 *
 * 工具只是 store 与角色库的薄壳：参数校验留在地面层（store 的写入闸口、
 * persona-store 的 id 规则），这里只负责把结果写成人能读的文本。
 */
import { rmSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  PROJECT_MEMORY_FILE,
  appendJournal,
  assertFactWithinLimit,
  assertProjectMemoryWithinLimit,
  countBytes,
  countChars,
  countLines,
  contentRevision,
  factPath,
  findProjectMemory,
  importanceFromRating,
  insertEntry,
  journalPath,
  listEntries,
  readJournal,
  readText,
  replaceDocument,
  searchJournal,
  setEntryImportance,
  writeAtomic,
} from './store.js';
import { DEFAULT_MAX_CHARS, DEFAULT_MAX_FACT_BYTES, DEFAULT_MAX_FACT_LINES, DEFAULT_MAX_PROJECT_CHARS } from './config.js';
import { activePath, ensureTrailingNewline, personasDir } from './paths.js';
import { activePersonaId, isPersonaDir, readPersona, scanPersonas, validPersonaId, writePersona } from './persona-store.js';

/* ────────────────────────────── 工具 ────────────────────────────── */
export const TEXT_OUTPUT = {
    schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
    },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
};
export function textTool(spec) {
    return {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: TEXT_OUTPUT,
        async execute(args, exec) {
            return { text: await spec.run(args, exec) };
        },
    };
}
export function callerCwd(exec) {
    const agent = exec?.agent;
    const cwd = agent?.session?.header?.cwd;
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
}
/**
 * 整篇覆盖缺 `expectedRevision` 的统一错误（0.13.2 · A2：global 与 project 都必填）。
 *
 * 为什么必填：注入侧会先 `stripSuperseded` 过滤；模型拿着过滤视图回写时，乐观锁是
 * 唯一能发现「你看的不是最新正文」的机制（防呆 diff 只能发现条目变少）。`force: true`
 * 是唯一逃生口，且必须显式。
 */
function revisionRequiredError(scope, file, revision) {
  const label = scope === 'project' ? '项目记忆' : '全局记忆';
  const readHint = scope === 'project' ? 'action=read, scope=project' : 'action=read, scope=global';
  const error = new Error([
    `${label}的整篇覆盖需要 expectedRevision（乐观锁必填，防止静默丢掉别处的改动）。`,
    `- 目标文件：${file}`,
    `- 当前 revision：${revision}`,
    `- 请先 ${readHint} 拿到最新内容与 revision，把要保留的改动合并进去，再带 expectedRevision 回写。`,
    '- 确实要无视并覆盖时，显式传 force: true（会丢掉这中间别人写进去的内容，也跳过「条目变少」的防呆）。',
  ].join('\n'));
  error.code = 'MEMORY_REVISION_REQUIRED';
  error.status = 409;
  error.details = { scope: scope === 'project' ? 'memory' : 'fact', path: file, revision, required: true };
  return error;
}
/**
 * update 后把 importance 打到「这次新写进来的条目」上（0.13.2 · E1）。
 *
 * 为什么只打新增的：整篇覆盖会把整份文档重写一遍，如果 importance 套给所有条目，
 * 「我只是补一条核心铁律」会把所有人的分数刷成同一档，E1 就变成新的污染源。
 * 新增按正文精确匹配（条目正文已剥离列表标记，与索引 id 同一口径）。
 */
function applyImportanceToNewEntries(scope, beforeTexts, options, value) {
    if (value === null)
        return 0;
    let applied = 0;
    for (const entry of listEntries(scope, options)) {
        if (beforeTexts.has(entry.text.trim()))
            continue;
        if (setEntryImportance(scope, entry.id, value, options).ok === true)
            applied += 1;
    }
    return applied;
}
export function memoryTool(config) {
    const maxFactLines = config.maxFactLines ?? DEFAULT_MAX_FACT_LINES;
    const maxFactBytes = config.maxFactBytes ?? DEFAULT_MAX_FACT_BYTES;
    /**
     * 项目记忆的**生效**上限（0.9.0 · P1-2）：`min(maxChars, maxProjectChars)`。
     * 注入侧按同一个数裁剪，所以「过了闸口 ⇒ 一定不会被注入静默截断」。
     */
    const maxProjectChars = Math.min(
        typeof config.maxChars === 'number' && Number.isFinite(config.maxChars) && config.maxChars >= 1 ? config.maxChars : DEFAULT_MAX_CHARS,
        typeof config.maxProjectChars === 'number' && Number.isFinite(config.maxProjectChars) && config.maxProjectChars >= 1 ? config.maxProjectChars : DEFAULT_MAX_PROJECT_CHARS,
    );
    return textTool({
        name: 'memory',
        description: [
            '读写长期记忆（本工具没有路径参数）。',
            'action=read：读全局记忆 FACT.md + 当前项目记忆 MEMORY.md + 最近日志。',
            `action=update：整篇覆盖写入（scope=global 写全局 FACT.md，**硬上限 ${maxFactLines} 行 AND ${maxFactBytes} 字节，任一超限直接报错**；scope=project 写当前项目根的 MEMORY.md，**上限 ${maxProjectChars} 字符，超限直接报错**）。`,
            '★整篇覆盖（scope=global 与 project 都一样）必须带 expectedRevision：先 action=read 拿到 revision 再回写。文件若已被别处（另一个会话 / 面板 / 自动沉淀）改过，本次写入会被拒（MEMORY_REVISION_CONFLICT），重新读取合并后再写即可 —— 这是防止静默丢掉别人改动的乐观锁，不是错误。',
            '★覆盖防呆：新正文的条目数或失效（dormant）数比磁盘上少，会拒写并抛 MEMORY_OVERWRITE_LOSSY（注入侧只给过滤后的视图，照抄容易丢行）；确认要删条目时显式传 force: true。',
            `★全局/项目分界：FACT.md 只放「换任何项目都成立」的事实（预算 ${maxFactLines} 行 / ${maxFactBytes} 字节）；本工作区的约定、机制探索结论、清单与踩坑一律写 scope=project。`,
            '★格式约定：一条只写一个结论，正文 ≤120 字；超长条目压缩器根本合并不动（合并结果上限 120 字），会让文件只涨不降、迟早撞上限。命令与路径进「## 速查」区；版本演进史、实现过程、调试记录用 action=append 写 JOURNAL，不写进 FACT/MEMORY。',
            'action=append：给 scope 时向该作用域追加**一条记忆条目**（global 写 FACT.md / project 写当前项目 MEMORY.md，可带 importance 1–5 星级）；不给 scope 时向全局长期日志 JOURNAL.jsonl 追加一条 {ts,tags,text}（日志无上限且不注入提示词，不收 importance）。',
            '★importance 只在 update / append(带 scope) 生效：1–5 星映射 20/35/50/70/90 写进侧车 index.json（正文不动）；非法/越界收敛到 3。update 时只打给「这次新写进来的条目」，不会把整篇都刷成一个分数。',
            'action=search：在日志里按子串（可选 tag）检索历史笔记。日志正文**不进提示词**，需要旧笔记只能靠 search/read 现取。',
            '文件：$DSH_HOME/memory/FACT.md、$DSH_HOME/memory/JOURNAL.jsonl、<项目根>/MEMORY.md。',
        ].join('\n'),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                action: { type: 'string', enum: ['read', 'update', 'append', 'search'], description: '要执行的动作。' },
                scope: { type: 'string', enum: ['global', 'project'], description: 'update/read 的作用域（append 带 scope 时改判为「追加一条记忆条目」），默认 global。' },
                content: { type: 'string', description: 'update 的完整新内容（整篇覆盖）。' },
                expectedRevision: { type: 'string', description: 'update 的乐观锁令牌：action=read 返回的 revision。磁盘已被别处改动 ⇒ 拒写（MEMORY_REVISION_CONFLICT），重读合并后再写。**scope=global 与 project 均必填**（缺省返回 MEMORY_REVISION_REQUIRED + 当前 revision）。' },
                force: { type: 'boolean', description: 'update 的逃生口：显式 true 才允许不带 expectedRevision 整篇覆盖，同时跳过「条目数/失效数变少」的防呆（会静默覆盖别处的改动、可能删条目，非必要别用）。' },
                text: { type: 'string', description: 'append 的正文。' },
                tags: { type: 'array', items: { type: 'string' }, description: 'append 的标签（可选）。' },
                query: { type: 'string', description: 'search 的子串（可选）。' },
                tag: { type: 'string', description: 'search 的标签过滤（可选）。' },
                limit: { type: 'integer', description: 'search 返回上限，默认 20。' },
                importance: { type: 'integer', minimum: 1, maximum: 5, description: '重要性星级 1–5（1=20/2=35/3=50/4=70/5=90，写侧车索引不改正文）。仅 update 与「append 带 scope」生效；update 时只给本次新写入的条目打分。' },
            },
            required: ['action'],
        },
        run: async (args, exec) => {
            const action = String(args.action ?? '');
            /* 0.13.2 · E1：importance 只收 1–5 星级（非法/越界收敛到 3），映射到 0–100 写侧车索引。
               undefined/null ⇒ null = 「这次不表态」，与「显式打 3 分」是两回事。 */
            const importanceValue = args.importance === undefined || args.importance === null
                ? null
                : importanceFromRating(args.importance);
            if (action === 'read') {
                const cwd = callerCwd(exec);
                const project = findProjectMemory(cwd);
                const { entries, total } = readJournal(50);
                const factRaw = readText(factPath());
                const factLines = countLines(factRaw ?? '');
                const factBytes = countBytes(factRaw ?? '');
                const factOver = factLines > maxFactLines || factBytes > maxFactBytes
                    ? `\n\n⚠️ 当前已超限（${factLines} 行 / ${factBytes} 字节，上限 ${maxFactLines} 行 / ${maxFactBytes} 字节）：**下一次 scope=global 写入会被拒绝**，请先精简，并把项目内容移到 scope=project。`
                    : '';
                const projectText = project === null ? '' : (project.content ?? '');
                const projectChars = countChars(projectText);
                const projectOver = project !== null && projectChars > maxProjectChars
                    ? `\n\n⚠️ 当前已超限（${projectChars} 字符 / 上限 ${maxProjectChars} 字符）：**下一次 scope=project 写入会被拒绝**，请先精简（把流水账迁去 action=append 的 JOURNAL.jsonl）。注入侧也会静默截断超出部分。`
                    : '';
                const parts = [
                    `## 全局记忆 · FACT.md（${factLines} 行 / 上限 ${maxFactLines} 行，${factBytes} 字节 / 上限 ${maxFactBytes} 字节，revision ${contentRevision(factRaw ?? '')}）\n路径: ${factPath()}${factOver}\n\n${(factRaw ?? '（尚未创建）').trim()}`,
                    project === null
                        ? `## 项目记忆 · MEMORY.md\n当前 cwd (${cwd ?? '未知'}) 向上没有找到 MEMORY.md。`
                        : `## 项目记忆 · ${project.path}（${projectChars} 字符 / 上限 ${maxProjectChars} 字符，revision ${contentRevision(projectText)}）${projectOver}\n\n${projectText.trim() || '（空文件）'}`,
                    `## 长期日志 · JOURNAL.jsonl\n路径: ${journalPath()}（共 ${total} 条）\n\n${entries.slice(-20).map((e) => `- ${e.ts}${e.tags.length > 0 ? ` [${e.tags.join(',')}]` : ''} ${e.text}`).join('\n') || '（暂无）'}`,
                ];
                return parts.join('\n\n---\n\n');
            }
            if (action === 'update') {
                const content = typeof args.content === 'string' ? args.content : '';
                if (content.trim() === '')
                    throw new Error('update 需要非空 content（整篇覆盖，请带上要保留的旧内容）');
                const scope = args.scope === 'project' ? 'project' : 'global';
                // 乐观锁：带了 revision 就必须和磁盘一致；不带只加写锁（兼容旧调用）。
                const expectedRevision = typeof args.expectedRevision === 'string' ? args.expectedRevision.trim() : '';
                const force = args.force === true;
                /* 0.9.0 · P1-3：先补末位换行再判上限 —— 落盘文本才是闸口该看的文本，
                   否则「恰好等于上限」会变成「落盘后超 1 字节」，下一次 read 立刻报超限。 */
                const finalText = ensureTrailingNewline(content);
                if (scope === 'global') {
                    assertFactWithinLimit(finalText, maxFactLines, maxFactBytes);
                    /* 0.13.2 · A2：global 的 expectedRevision 也改必填（过去只有 project 强制，
                       全局省略即不校验 ⇒ 工具这条路径等于没有乐观锁）。 */
                    if (expectedRevision === '' && force !== true)
                        throw revisionRequiredError('global', factPath(), contentRevision(readText(factPath()) ?? ''));
                    // 带 cwd 只影响索引里的 workspaceId（FACT 仍是全局文件，不按工作区隔离）
                    const cwd = callerCwd(exec);
                    const beforeTexts = new Set(listEntries('fact', { cwd }).map((entry) => entry.text.trim()));
                    const saved = await replaceDocument('fact', factPath(), finalText, { expectedRevision, force, cwd });
                    const rated = applyImportanceToNewEntries('fact', beforeTexts, { cwd }, importanceValue);
                    const rateNote = rated > 0 ? `；本次新写入的 ${rated} 条按 importance=${importanceValue}/100 写入侧车索引` : '';
                    return `已写入全局记忆 FACT.md（${factPath()}，${countChars(content)} 字符 / ${countBytes(content)} 字节 / ${countLines(content)} 行，上限 ${maxFactLines} 行 / ${maxFactBytes} 字节，新 revision ${saved.revision}）${rateNote}。本会话注入仍是首条消息快照，新会话生效。`;
                }
                const cwd = callerCwd(exec);
                const existing = findProjectMemory(cwd);
                const target = existing === null
                    ? (cwd === undefined ? null : join(resolvePath(cwd), PROJECT_MEMORY_FILE))
                    : existing.path;
                if (target === null)
                    throw new Error('无法确定当前项目根（会话 cwd 未知），无法写项目记忆');
                assertProjectMemoryWithinLimit(finalText, maxProjectChars);
                /* 0.9.0 · P0-3：scope=project 的 expectedRevision 改为**必填**。
                   同一份 MEMORY.md 还有面板 / 压缩 / 自动沉淀三条写路径，工具这条
                   过去等于没有乐观锁 ⇒ 「读-改-写」静默丢别人改动。显式 force:true 是
                   唯一的逃生口（旧的「不带 revision」行为不再默认允许）。 */
                if (expectedRevision === '' && force !== true)
                    throw revisionRequiredError('project', target, contentRevision(readText(target) ?? ''));
                const beforeTexts = new Set(listEntries('project', { cwd }).map((entry) => entry.text.trim()));
                const saved = await replaceDocument('memory', target, finalText, { cwd, expectedRevision, path: target, force });
                const rated = applyImportanceToNewEntries('project', beforeTexts, { cwd }, importanceValue);
                const rateNote = rated > 0 ? `；本次新写入的 ${rated} 条按 importance=${importanceValue}/100 写入侧车索引` : '';
                return `已写入项目记忆 ${target}（${countChars(content)} 字符，上限 ${maxProjectChars} 字符，新 revision ${saved.revision}）${rateNote}。新会话生效。`;
            }
            if (action === 'append') {
                const text = typeof args.text === 'string' ? args.text.trim() : '';
                if (text === '')
                    throw new Error('append 需要非空 text');
                const tags = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string') : [];
                /* 0.13.2 · E1：带 scope ⇒ 追加**一条记忆条目**（而不是日志）。
                   这是 importance 唯一能用在 append 上的场景：JOURNAL 没有侧车索引，
                   收了 importance 也没处落（契约：journal 不收）。 */
                const scope = args.scope === 'project' ? 'project' : (args.scope === 'global' ? 'global' : '');
                if (scope !== '') {
                    const cwd = callerCwd(exec);
                    const inserted = await insertEntry(scope, {
                        text,
                        confidence: 'high',
                        ...(importanceValue === null ? {} : { importance: importanceValue }),
                    }, { cwd });
                    if (inserted.written !== true) {
                        const where = inserted.demoted === 'journal' ? '已改判为 JOURNAL（未写入静态槽）' : '已丢弃';
                        return `未写入记忆：${inserted.reason}（${where}）。需要留档请用不带 scope 的 append 写 JOURNAL。`;
                    }
                    const file = scope === 'global' ? 'FACT.md' : 'MEMORY.md';
                    const rateNote = importanceValue === null ? '' : `，importance ${importanceValue}/100 已写入侧车索引`;
                    return `已追加${scope === 'global' ? '全局' : '项目'}记忆条目（${file}）${rateNote}：${text}`;
                }
                // 0.13.2 · B2：带上会话 cwd —— recall 按工作区隔离 JOURNAL 召回的依据
                const entry = await appendJournal(text, tags, { cwd: callerCwd(exec) });
                return `已追加长期日志：${entry.ts}${tags.length > 0 ? ` [${tags.join(',')}]` : ''} ${text}`;
            }
            if (action === 'search') {
                const query = typeof args.query === 'string' ? args.query : '';
                const tag = typeof args.tag === 'string' ? args.tag : '';
                const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(100, Math.trunc(args.limit))) : 20;
                const hits = searchJournal(query, tag, limit);
                if (hits.length === 0)
                    return `日志中没有匹配（query="${query}" tag="${tag}"）。`;
                return [`命中 ${hits.length} 条（新→旧）：`, ...hits.map((e) => `- ${e.ts}${e.tags.length > 0 ? ` [${e.tags.join(',')}]` : ''} ${e.text}`)].join('\n');
            }
            throw new Error(`未知 action: ${action}（可选 read/update/append/search）`);
        },
    });
}
export function personaTool() {
    return textTool({
        name: 'persona',
        description: [
            '管理角色库（本工具没有路径参数）。',
            '角色管理请走 `$DSH_HOME\\personas`。',
            'action=list：列出所有角色；action=current：当前角色与其文件；action=show：读某角色三件套。',
            'action=use：把某角色设为当前角色（新会话生效）。',
            'action=create：新建角色（id + name + description，可选 soul/user）。',
            'action=update：改已有角色的 name/description/soul/user。',
            'action=delete：删除角色。',
            `角色库目录：${personasDir()}/<id>/{persona.yml,SOUL.md,USER.md}。`,
        ].join('\n'),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                action: { type: 'string', enum: ['list', 'current', 'show', 'use', 'create', 'update', 'delete'], description: '要执行的动作。' },
                id: { type: 'string', description: '角色 id（小写+中横线，即目录名）。' },
                name: { type: 'string', description: '角色名（展示用）。' },
                description: { type: 'string', description: '一句话简介。' },
                soul: { type: 'string', description: 'SOUL.md 完整内容。' },
                user: { type: 'string', description: 'USER.md 完整内容。' },
            },
            required: ['action'],
        },
        run: (args) => {
            const action = String(args.action ?? '');
            const id = typeof args.id === 'string' ? args.id.trim() : '';
            /* 0.9.0 · P1-9：所有按 id 取目录的动作统一校验 id 形态。
               过去只有 create 校验 —— `delete` 会对 `join(personasDir(), id)` 做
               `rmSync(recursive)`，`id = '../x'` 能删到角色库之外。空 id 各自报各自的话。 */
            const requireValidId = (verb) => {
                if (id === '')
                    throw new Error(`${verb} 需要 id`);
                if (!validPersonaId(id))
                    throw new Error('id 只能是小写字母/数字/中横线，且以字母或数字开头');
            };
            if (action === 'list') {
                const list = scanPersonas();
                if (list.length === 0)
                    return `角色库为空（${personasDir()}）。用 action=create 新建一个。`;
                const active = activePersonaId();
                return [`角色库 ${personasDir()}（${list.length} 个，active=${active || '无'}）：`,
                    ...list.map((p) => `- ${p.id === active ? '*' : ' '} ${p.id} — ${p.name}${p.description === '' ? '' : `：${p.description}`}`),
                ].join('\n');
            }
            if (action === 'current') {
                const active = activePersonaId();
                const persona = active === '' ? null : readPersona(active);
                if (persona === null)
                    return '当前没有可用角色（角色库为空）。';
                return `当前角色：${persona.name}（${persona.id}）\n简介：${persona.description || '（无）'}\n\n--- SOUL.md ---\n${persona.soul || '（空）'}\n\n--- USER.md ---\n${persona.user || '（空）'}`;
            }
            if (action === 'show') {
                requireValidId('show');
                const persona = readPersona(id);
                if (persona === null)
                    throw new Error(`角色不存在：${id}`);
                return `角色 ${persona.name}（${persona.id}）\n简介：${persona.description || '（无）'}\n\n--- SOUL.md ---\n${persona.soul || '（空）'}\n\n--- USER.md ---\n${persona.user || '（空）'}`;
            }
            if (action === 'use') {
                requireValidId('use');
                if (!isPersonaDir(join(personasDir(), id)))
                    throw new Error(`角色不存在：${id}`);
                writeAtomic(activePath(), `${id}\n`);
                return `已把当前角色切换为 ${id}。角色在会话首条消息时固化，新会话生效。`;
            }
            if (action === 'create') {
                if (id === '')
                    throw new Error('create 需要 id');
                if (!validPersonaId(id))
                    throw new Error('id 只能是小写字母/数字/中横线，且以字母或数字开头');
                if (isPersonaDir(join(personasDir(), id)))
                    throw new Error(`角色已存在：${id}（用 update 修改）`);
                const personaName = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : id;
                writePersona(id, {
                    name: personaName,
                    description: typeof args.description === 'string' ? args.description.trim() : '',
                    soul: typeof args.soul === 'string' ? args.soul : undefined,
                    user: typeof args.user === 'string' ? args.user : undefined,
                });
                return `已新建角色 ${id}（${personaName}）→ ${join(personasDir(), id)}。用 action=use 设为当前角色。`;
            }
            if (action === 'update') {
                requireValidId('update');
                if (!isPersonaDir(join(personasDir(), id)))
                    throw new Error(`角色不存在：${id}（用 create 新建）`);
                writePersona(id, {
                    name: typeof args.name === 'string' ? args.name.trim() : undefined,
                    description: typeof args.description === 'string' ? args.description.trim() : undefined,
                    soul: typeof args.soul === 'string' ? args.soul : undefined,
                    user: typeof args.user === 'string' ? args.user : undefined,
                });
                return `已更新角色 ${id}。文件改动对新会话生效。`;
            }
            if (action === 'delete') {
                requireValidId('delete');
                if (!isPersonaDir(join(personasDir(), id)))
                    throw new Error(`角色不存在：${id}`);
                if (id === activePersonaId())
                    throw new Error(`角色 ${id} 正在使用中，先 action=use 切到别的角色再删`);
                rmSync(join(personasDir(), id), { recursive: true, force: true });
                return `已删除角色 ${id}。`;
            }
            throw new Error(`未知 action: ${action}`);
        },
    });
}
/* ────────────────────────────── 种子与迁移 ────────────────────────────── */
