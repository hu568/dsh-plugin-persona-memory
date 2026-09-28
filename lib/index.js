/**
 * @dsh-external/dsh-persona-memory — 宿主机半（HOST PLANE）。
 *
 * 角色设定（角色库）+ 长期记忆（全局 / 项目 / 日志）一次性解决：
 *
 *   角色库   $DSH_HOME/personas/<id>/{persona.yml,SOUL.md,USER.md}
 *   全局记忆 $DSH_HOME/memory/FACT.md
 *   长期日志 $DSH_HOME/memory/JOURNAL.jsonl      （仅全局一份）
 *   项目记忆 <项目根>/MEMORY.md                  （存在才注入，不自动创建）
 *   快照     $DSH_HOME/memory/snapshots/<sessionId>.json
 *
 * 它注册在**宿主组合**里（不是 agent 预设），所以对所有预设的每个会话都生效。
 *
 * 注入时机：会话**首条用户消息**时把角色+记忆固化成本会话快照，此后每轮组装都
 * 读快照而不是读盘——KV 缓存前缀因此稳定；首条消息之前读盘实时渲染。写入立即
 * 落盘，新会话生效（工具/面板都会把这条语义写给模型看）。
 *
 * 注册的提示词段落通过 AssembleContext.agent 拿到会话身份；脱离 agent 的诊断
 * 组装拿不到身份，直接渲染空串。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import z from 'schemastery';
/** Cordis 插件名。 */
export const name = '@dsh-external/dsh-persona-memory';
/** 宿主服务依赖：提示词注册表 + 工具注册表（本部署两者恒在）。 */
export const inject = ['systemPrompt', 'tools'];
const PERSONA_FILE = 'persona.yml';
const SOUL_FILE = 'SOUL.md';
const USER_FILE = 'USER.md';
const ACTIVE_FILE = '.active';
const ORDER_FILE = '.personas-order';
const FACT_FILE = 'FACT.md';
const JOURNAL_FILE = 'JOURNAL.jsonl';
const PROJECT_MEMORY_FILE = 'MEMORY.md';
/**
 * 注入作用域。
 *
 * - `full`（主会话）：角色设定 + 全局记忆 + 项目记忆 + 长期日志。
 * - `project`（子代理会话）：**只**注入项目记忆。角色、全局 FACT.md、长期日志
 *   都可能与本项目的当前任务无关，子代理的上下文越窄越不容易跑偏。
 */
const INJECT_FULL = 'full';
const INJECT_PROJECT_ONLY = 'project';
/** 单文件注入字符上限。 */
const DEFAULT_MAX_CHARS = 8000;
/** 日志扫描上限（行）。 */
const DEFAULT_JOURNAL_LIMIT = 2000;
/** 注入最近日志条数。 */
const DEFAULT_JOURNAL_INJECT = 6;
export const Config = z.object({
    personaEnabled: z.boolean().default(true),
    memoryEnabled: z.boolean().default(true),
    journalEnabled: z.boolean().default(true),
    /** 子代理会话是否只注入项目记忆（关掉即恢复「子代理与主会话注入相同内容」）。 */
    subagentProjectOnly: z.boolean().default(true),
    maxChars: z.number().min(500).default(DEFAULT_MAX_CHARS),
    journalLimit: z.number().min(1).default(DEFAULT_JOURNAL_LIMIT),
    journalInject: z.number().min(0).default(DEFAULT_JOURNAL_INJECT),
    panelPath: z.string().default('/persona-memory'),
});
/* ────────────────────────────── 路径与文件 ────────────────────────────── */
function dshHome() {
    return process.env.DSH_HOME || join(homedir(), '.dsh');
}
function personasDir() {
    return join(dshHome(), 'personas');
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
function snapshotsDir() {
    return join(memoryDir(), 'snapshots');
}
function activePath() {
    return join(personasDir(), ACTIVE_FILE);
}
function orderPath() {
    return join(personasDir(), ORDER_FILE);
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
/** 原子覆盖写：临时文件 + rename，避免半截文件被读到。 */
function writeAtomic(file, text) {
    ensureDir(dirname(file));
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
}
function clip(text, maxChars) {
    const trimmed = text.trim();
    return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n…（已截断）` : trimmed;
}
/** 极简 persona.yml 解析：只要顶层 `name` / `description` 两个标量。 */
function parsePersonaYml(raw) {
    let name = '';
    let description = '';
    for (const line of raw.split(/\r?\n/)) {
        const match = /^(name|description)\s*:\s*(.*)$/.exec(line);
        if (match === null)
            continue;
        const value = match[2].trim().replace(/^["']/, '').replace(/["']$/, '');
        if (match[1] === 'name')
            name = value;
        else
            description = value;
    }
    return { name, description };
}
/** 写成单行可安全解析的 YAML 标量。 */
function yamlScalar(value) {
    const oneLine = value.replace(/\s*\r?\n\s*/g, ' ').trim();
    const plain = !/^[\s>|&*!%@`"'#-]|:\s|:\s*$/.test(oneLine);
    return plain ? oneLine : JSON.stringify(oneLine);
}
function personaYmlText(name, description) {
    return `name: ${yamlScalar(name)}\ndescription: ${yamlScalar(description)}\n`;
}
/** 识别一个目录是不是角色：必须有 persona.yml。 */
function isPersonaDir(dir) {
    try {
        return statSync(join(dir, PERSONA_FILE)).isFile();
    }
    catch {
        return false;
    }
}
function readOrder() {
    const raw = readText(orderPath());
    if (raw === null)
        return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed))
            return parsed.filter((item) => typeof item === 'string');
    }
    catch {
        /* 坏文件当没有排序 */
    }
    return [];
}
/** 扫描角色库并按 `.personas-order` 排序（未列出的按名称排最后）。 */
function scanPersonas() {
    const dir = personasDir();
    let names;
    try {
        names = readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => String(entry.name));
    }
    catch {
        return [];
    }
    const found = [];
    for (const id of names) {
        const full = join(dir, id);
        if (!isPersonaDir(full))
            continue;
        const meta = parsePersonaYml(readText(join(full, PERSONA_FILE)) ?? '');
        found.push({ id, name: meta.name || id, description: meta.description });
    }
    const order = readOrder();
    const rank = new Map(order.map((id, index) => [id, index]));
    return found.sort((a, b) => {
        const ra = rank.get(a.id);
        const rb = rank.get(b.id);
        if (ra !== undefined && rb !== undefined)
            return ra - rb;
        if (ra !== undefined)
            return -1;
        if (rb !== undefined)
            return 1;
        return a.name.localeCompare(b.name, 'zh');
    });
}
function activePersonaId() {
    const list = scanPersonas();
    const raw = (readText(activePath()) ?? '').trim();
    if (raw !== '' && list.some((persona) => persona.id === raw))
        return raw;
    const fallback = list.find((persona) => persona.id === 'default') ?? list[0];
    return fallback?.id ?? '';
}
function readPersona(id) {
    const dir = join(personasDir(), id);
    if (!isPersonaDir(dir))
        return null;
    const meta = parsePersonaYml(readText(join(dir, PERSONA_FILE)) ?? '');
    return {
        id,
        name: meta.name || id,
        description: meta.description,
        soul: (readText(join(dir, SOUL_FILE)) ?? '').trim(),
        user: (readText(join(dir, USER_FILE)) ?? '').trim(),
    };
}
function validPersonaId(id) {
    return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}
function writePersona(id, fields) {
    const dir = join(personasDir(), id);
    ensureDir(dir);
    const current = readPersona(id);
    const name = fields.name ?? current?.name ?? id;
    const description = fields.description ?? current?.description ?? '';
    writeAtomic(join(dir, PERSONA_FILE), personaYmlText(name, description));
    if (fields.soul !== undefined)
        writeAtomic(join(dir, SOUL_FILE), ensureTrailingNewline(fields.soul));
    else if (!existsSync(join(dir, SOUL_FILE)))
        writeAtomic(join(dir, SOUL_FILE), soulTemplate(name));
    if (fields.user !== undefined)
        writeAtomic(join(dir, USER_FILE), ensureTrailingNewline(fields.user));
    else if (!existsSync(join(dir, USER_FILE)))
        writeAtomic(join(dir, USER_FILE), userTemplate());
}
function ensureTrailingNewline(text) {
    return text.endsWith('\n') ? text : `${text}\n`;
}
function soulTemplate(personaName) {
    return `# SOUL.md — ${personaName}

## Identity
（这个角色是谁：身份、背景、定位，2-3 句）

## Personality
- （3-5 个特质，每个都写到「如何体现在对话里」）

## Tone
- （语气、语言风格、回复长度偏好）

## Principles
- 永远（原则）
- 绝不（原则）

## Communication Style
- 称呼用户为（形式）
- （emoji / 格式偏好）

## Boundaries
- 不做（边界）
- 避免（边界）
`;
}
function userTemplate() {
    return `# USER.md — 用户档案

## 基本信息
- 称呼：
- 语言偏好：
- 沟通风格：

## 偏好
- 格式偏好：
- 其他：
`;
}
/* ────────────────────────────── 记忆（全局 / 项目 / 日志） ────────────────────────────── */
function factTemplate() {
    return `# FACT.md — 全局长期记忆

<!-- 跨会话、跨项目的稳定事实（6 个月以上仍然成立）。由 memory 工具 scope=global 维护。
     只放「事实」，不放流水账——流水账写 JOURNAL.jsonl。 -->

## 关于用户

## 关于环境

## 长期约定
`;
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
/** 读日志尾部：坏行跳过（历史脏数据不该让整个功能挂掉）。 */
function readJournal(limit) {
    const raw = readText(journalPath());
    if (raw === null)
        return { entries: [], total: 0 };
    const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
    const total = lines.length;
    const tail = lines.slice(Math.max(0, lines.length - limit));
    const entries = [];
    for (const line of tail) {
        try {
            const parsed = JSON.parse(line);
            if (parsed === null || typeof parsed !== 'object')
                continue;
            const record = parsed;
            const text = typeof record.text === 'string' ? record.text : '';
            if (text === '')
                continue;
            entries.push({
                ts: typeof record.ts === 'string' ? record.ts : '',
                tags: Array.isArray(record.tags) ? record.tags.filter((t) => typeof t === 'string') : [],
                text,
            });
        }
        catch {
            /* 坏行跳过 */
        }
    }
    return { entries, total };
}
function appendJournal(text, tags) {
    const entry = { ts: new Date().toISOString(), tags, text };
    ensureDir(memoryDir());
    appendFileSync(journalPath(), `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
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
function sessionEvents(session) {
    if (session === undefined)
        return [];
    if (typeof session.snapshotEvents === 'function')
        return session.snapshotEvents();
    return session.events ?? [];
}
function hasUserMessage(session) {
    return sessionEvents(session).some((event) => event.type === 'user/message');
}
/**
 * 判定一个会话是不是**委派出去的子代理**。
 *
 * 判据取自宿主真实写入的 session header（`@deepseek-ai/dsh-subagent` 的
 * `childSessionMeta()`）：子代理会话一定带 `origin: 'subagent'`，并带
 * `parentSession`（父会话 id）与 `delegationDepth`（递归深度）。这里三条都认，
 * 是为了兼容「只写了血缘、没写 origin」的旧日志/外部 provider —— 宁可把子代理
 * 判多，也不要漏判后把主会话的角色与全局记忆灌进委派任务。
 */
function isSubagent(session) {
    const header = session?.header;
    if (header === undefined || header === null)
        return false;
    if (header.origin === 'subagent')
        return true;
    if (typeof header.parentSession === 'string' && header.parentSession !== '')
        return true;
    return typeof header.delegationDepth === 'number' && header.delegationDepth > 0;
}
function buildSnapshot(sessionId, cwd, config, runtime) {
    const personaId = activePersonaId();
    const persona = personaId === '' ? null : readPersona(personaId);
    const project = findProjectMemory(cwd);
    const { entries, total } = readJournal(config.journalLimit);
    const snapshot = {
        version: 1,
        sessionId,
        createdAt: Date.now(),
        persona,
        globalFact: readText(factPath()) ?? '',
        project: project === null ? null : { path: project.path, root: project.root, content: project.content },
        journal: config.journalEnabled ? entries.slice(Math.max(0, entries.length - config.journalInject)) : [],
        journalTotal: total,
    };
    runtime.cwdBySession.set(sessionId, cwd ?? '');
    runtime.sessionsSeen.add(sessionId);
    if (project !== null)
        runtime.projectBySession.set(sessionId, project);
    return snapshot;
}
/**
 * 取本会话的注入快照。
 *
 * - 已固化（内存或磁盘）→ 直接返回。磁盘回填让 resume/重启后语义不变。
 * - 尚未固化且会话还没有用户消息 → 返回 null：调用方改为实时渲染，
 *   这样「建好会话 → 编辑记忆/换角色 → 发第一条消息」拿到的是最新内容。
 * - 首条用户消息之后 → 固化并（非子代理会话）落盘。
 */
function snapshotFor(agent, config, runtime) {
    const sessionId = agent?.id;
    if (typeof sessionId !== 'string' || sessionId === '')
        return null;
    runtime.sessionsSeen.add(sessionId);
    const cached = runtime.snapshots.get(sessionId);
    if (cached !== undefined)
        return cached;
    const session = agent?.session;
    const cwd = session?.header?.cwd;
    if (typeof cwd === 'string' && cwd !== '')
        runtime.cwdBySession.set(sessionId, cwd);
    const file = join(snapshotsDir(), `${sessionId}.json`);
    const raw = readText(file);
    if (raw !== null) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed !== null && typeof parsed === 'object' && parsed.version === 1) {
                runtime.snapshots.set(sessionId, parsed);
                if (parsed.project !== null) {
                    runtime.projectBySession.set(sessionId, {
                        root: parsed.project.root,
                        path: parsed.project.path,
                        exists: true,
                        content: parsed.project.content,
                    });
                }
                return parsed;
            }
        }
        catch {
            /* 坏快照当作没有，重新固化 */
        }
    }
    if (!hasUserMessage(session))
        return null;
    const snapshot = buildSnapshot(sessionId, cwd, config, runtime);
    runtime.snapshots.set(sessionId, snapshot);
    if (!isSubagent(session)) {
        try {
            writeAtomic(file, JSON.stringify(snapshot, null, 2));
        }
        catch {
            /* 落盘失败不抛错：内存快照仍然生效，下次组装重试 */
        }
    }
    return snapshot;
}
/** 实时渲染（首条用户消息之前）：每次组装直接读盘。 */
function liveSnapshot(sessionId, cwd, config, runtime) {
    return buildSnapshot(sessionId, cwd, config, runtime);
}
/* ────────────────────────────── 提示词渲染 ────────────────────────────── */
const ROLE_CONTRACT = [
    '【角色设定】以上 <soul>/<user> 是你的角色与用户档案，来自角色库。',
    '改动角色文件对新会话生效；本会话的注入内容在首条消息时已固化（KV 缓存前缀稳定）。',
    '用 `persona` 工具查看/切换/新建/编辑角色（action: list | current | show | use | create | update | delete）。',
].join('\n');
function memoryContract(globalPath, journalFile, projectPath) {
    return [
        '【记忆写入契约】本工具没有路径参数，一律走 `memory` 工具：',
        `- 长期事实（跨会话稳定）→ action=update, scope=global（写 ${globalPath}），整篇覆盖，请带上已有内容。`,
        projectPath === null
            ? '- 项目事实 → action=update, scope=project（写当前项目根的 MEMORY.md；当前项目还没有该文件，写入即创建）。'
            : `- 项目事实 → action=update, scope=project（写 ${projectPath}），整篇覆盖。`,
        `- 一次性事件/会话笔记 → action=append（追加到 ${journalFile}，可带 tags）。`,
        '- 检索历史笔记 → action=search（子串 + 可选 tag）。',
        '写入立即落盘；本会话注入的是首条消息时的快照，更新内容在**新会话**生效。',
    ].join('\n');
}
/**
 * 子代理版记忆契约：只指向项目 MEMORY.md，不提全局 FACT.md / JOURNAL.jsonl。
 * 明确写出「全局记忆与角色未注入」以免子代理以为它们不存在而乱猜。
 */
function projectMemoryContract(projectPath, projectRoot) {
    return [
        '【记忆写入契约】子代理只拿到**项目记忆**，角色设定、全局记忆（FACT.md）与长期日志（JOURNAL.jsonl）均未注入。',
        `- 项目事实 → action=update, scope=project（写 ${projectPath}），整篇覆盖，请带上已有内容。`,
        `- 需要全局记忆或历史笔记时 → action=read / action=search（只读，别写全局）。`,
        `- 项目根：${projectRoot}。`,
        '写入立即落盘；本会话注入的是首条消息时的快照，更新内容在**新会话**生效。',
    ].join('\n');
}
function renderPersona(snapshot, config, which, scope) {
    // 子代理：不注入角色（SOUL/USER 属于「你是谁的长期人设」，与委派任务无关）。
    if (scope === INJECT_PROJECT_ONLY)
        return '';
    if (!config.personaEnabled)
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
function renderFacts(snapshot, config, scope) {
    if (!config.memoryEnabled)
        return '';
    // 子代理：只注入项目记忆，跳过全局 FACT.md 与全局写入契约。
    if (scope === INJECT_PROJECT_ONLY) {
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
            projectMemoryContract(snapshot.project.path, root),
        ].join('\n');
    }
    const global = clip(snapshot.globalFact, config.maxChars);
    const project = snapshot.project === null ? '' : clip(snapshot.project.content, config.maxChars);
    if (global === '' && project === '')
        return '';
    const blocks = [];
    blocks.push(`### 全局记忆（FACT.md）\n${global === '' ? '（暂无）' : global}`);
    if (project !== '')
        blocks.push(`### 项目记忆（${snapshot.project?.path ?? PROJECT_MEMORY_FILE}）\n${project}`);
    const contract = memoryContract(factPath(), journalPath(), snapshot.project === null ? null : snapshot.project.path);
    return `<memory>\n${blocks.join('\n\n')}\n</memory>\n\n${contract}`;
}
function renderJournal(snapshot, config, scope) {
    // 子代理：不注入全局长期日志（流水账）。需要时子代理可以自己调 memory action=search。
    if (scope === INJECT_PROJECT_ONLY)
        return '';
    if (!config.memoryEnabled || !config.journalEnabled)
        return '';
    if (snapshot.journal.length === 0)
        return '';
    const lines = snapshot.journal.map((entry) => {
        const tags = entry.tags.length > 0 ? ` [${entry.tags.join(',')}]` : '';
        return `- ${entry.ts}${tags} ${entry.text}`;
    });
    return `<journal total="${snapshot.journalTotal}" showing="${snapshot.journal.length}">\n${lines.join('\n')}\n</journal>`;
}
/* ────────────────────────────── 工具 ────────────────────────────── */
const TEXT_OUTPUT = {
    schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
    },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
};
function textTool(spec) {
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
function callerCwd(exec) {
    const agent = exec?.agent;
    const cwd = agent?.session?.header?.cwd;
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
}
function memoryTool() {
    return textTool({
        name: 'memory',
        description: [
            '读写长期记忆（本工具没有路径参数）。',
            'action=read：读全局记忆 FACT.md + 当前项目记忆 MEMORY.md + 最近日志。',
            'action=update：整篇覆盖写入（scope=global 写全局 FACT.md；scope=project 写当前项目根的 MEMORY.md）。',
            'action=append：向全局长期日志 JOURNAL.jsonl 追加一条 {ts,tags,text}（一次性事件/会话笔记）。',
            'action=search：在日志里按子串（可选 tag）检索历史笔记。',
            '文件：$DSH_HOME/memory/FACT.md、$DSH_HOME/memory/JOURNAL.jsonl、<项目根>/MEMORY.md。',
        ].join('\n'),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                action: { type: 'string', enum: ['read', 'update', 'append', 'search'], description: '要执行的动作。' },
                scope: { type: 'string', enum: ['global', 'project'], description: 'update/read 的作用域，默认 global。' },
                content: { type: 'string', description: 'update 的完整新内容（整篇覆盖）。' },
                text: { type: 'string', description: 'append 的正文。' },
                tags: { type: 'array', items: { type: 'string' }, description: 'append 的标签（可选）。' },
                query: { type: 'string', description: 'search 的子串（可选）。' },
                tag: { type: 'string', description: 'search 的标签过滤（可选）。' },
                limit: { type: 'integer', description: 'search 返回上限，默认 20。' },
            },
            required: ['action'],
        },
        run: (args, exec) => {
            const action = String(args.action ?? '');
            if (action === 'read') {
                const cwd = callerCwd(exec);
                const project = findProjectMemory(cwd);
                const { entries, total } = readJournal(50);
                const parts = [
                    `## 全局记忆 · FACT.md\n路径: ${factPath()}\n\n${(readText(factPath()) ?? '（尚未创建）').trim()}`,
                    project === null
                        ? `## 项目记忆 · MEMORY.md\n当前 cwd (${cwd ?? '未知'}) 向上没有找到 MEMORY.md。`
                        : `## 项目记忆 · ${project.path}\n\n${project.content.trim() || '（空文件）'}`,
                    `## 长期日志 · JOURNAL.jsonl\n路径: ${journalPath()}（共 ${total} 条）\n\n${entries.slice(-20).map((e) => `- ${e.ts}${e.tags.length > 0 ? ` [${e.tags.join(',')}]` : ''} ${e.text}`).join('\n') || '（暂无）'}`,
                ];
                return parts.join('\n\n---\n\n');
            }
            if (action === 'update') {
                const content = typeof args.content === 'string' ? args.content : '';
                if (content.trim() === '')
                    throw new Error('update 需要非空 content（整篇覆盖，请带上要保留的旧内容）');
                const scope = args.scope === 'project' ? 'project' : 'global';
                if (scope === 'global') {
                    writeAtomic(factPath(), ensureTrailingNewline(content));
                    return `已写入全局记忆 FACT.md（${factPath()}，${content.length} 字符）。本会话注入仍是首条消息快照，新会话生效。`;
                }
                const cwd = callerCwd(exec);
                const existing = findProjectMemory(cwd);
                const target = existing === null
                    ? (cwd === undefined ? null : join(resolvePath(cwd), PROJECT_MEMORY_FILE))
                    : existing.path;
                if (target === null)
                    throw new Error('无法确定当前项目根（会话 cwd 未知），无法写项目记忆');
                writeAtomic(target, ensureTrailingNewline(content));
                return `已写入项目记忆 ${target}（${content.length} 字符）。新会话生效。`;
            }
            if (action === 'append') {
                const text = typeof args.text === 'string' ? args.text.trim() : '';
                if (text === '')
                    throw new Error('append 需要非空 text');
                const tags = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string') : [];
                const entry = appendJournal(text, tags);
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
function personaTool() {
    return textTool({
        name: 'persona',
        description: [
            '管理角色库（本工具没有路径参数）。',
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
                if (id === '')
                    throw new Error('show 需要 id');
                const persona = readPersona(id);
                if (persona === null)
                    throw new Error(`角色不存在：${id}`);
                return `角色 ${persona.name}（${persona.id}）\n简介：${persona.description || '（无）'}\n\n--- SOUL.md ---\n${persona.soul || '（空）'}\n\n--- USER.md ---\n${persona.user || '（空）'}`;
            }
            if (action === 'use') {
                if (id === '')
                    throw new Error('use 需要 id');
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
                if (id === '')
                    throw new Error('update 需要 id');
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
                if (id === '')
                    throw new Error('delete 需要 id');
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
/**
 * 首次运行时把目录结构补出来：
 * - 角色库为空 → 建 `default`，把旧版 `$DSH_HOME/memory/{SOUL.md,USER.md}` 的内容
 *   搬进来（存在的才有内容），旧文件保留不动。
 * - FACT.md 不存在 → 建模板。
 */
function ensureSeed(ctx) {
    try {
        ensureDir(memoryDir());
        if (!existsSync(factPath()))
            writeAtomic(factPath(), factTemplate());
        ensureDir(personasDir());
        if (scanPersonas().length > 0)
            return;
        const legacySoul = (readText(join(memoryDir(), SOUL_FILE)) ?? '').trim();
        const legacyUser = (readText(join(memoryDir(), USER_FILE)) ?? '').trim();
        const name = guessPersonaName(legacySoul) || 'default';
        writePersona('default', {
            name,
            description: '默认角色（从旧版记忆目录迁移）',
            soul: legacySoul === '' ? soulTemplate(name) : legacySoul,
            user: legacyUser === '' ? userTemplate() : legacyUser,
        });
        if (!existsSync(activePath()))
            writeAtomic(activePath(), 'default\n');
        ctx.logger?.info?.(`[dsh-persona-memory] 已初始化角色库 ${personasDir()}` +
            (legacySoul === '' ? '' : '（迁入旧版 memory/SOUL.md 与 USER.md）'));
    }
    catch (error) {
        ctx.logger?.warn?.(`[dsh-persona-memory] 初始化失败: ${String(error)}`);
    }
}
/** 从 SOUL.md 里猜一个展示名：优先 `# SOUL.md — 名字`，否则取「我叫**X**」。 */
function guessPersonaName(soul) {
    const heading = /^#\s*SOUL\.md\s*[—\-–]\s*(.+)$/m.exec(soul);
    if (heading !== null)
        return heading[1].trim();
    const called = /我叫\**\s*([^\s*，,。]+)/.exec(soul);
    if (called !== null)
        return called[1].trim();
    return '';
}
/* ────────────────────────────── 主入口 ────────────────────────────── */
export function apply(ctx, rawConfig) {
    const config = Config(rawConfig ?? {});
    const runtime = {
        snapshots: new Map(),
        cwdBySession: new Map(),
        projectBySession: new Map(),
        sessionsSeen: new Set(),
    };
    ensureSeed(ctx);
    /* ── 提示词段落：全局注册 ⇒ 对所有 agent 预设的每个会话生效 ── */
    const systemPrompt = ctx.get('systemPrompt');
    if (systemPrompt !== undefined) {
        const base = systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX');
        /** 本次组装的注入作用域：子代理会话只注入项目记忆。 */
        const scopeOf = (context) => {
            const agent = context.agent;
            if (agent === undefined || !config.subagentProjectOnly)
                return INJECT_FULL;
            return isSubagent(agent.session) ? INJECT_PROJECT_ONLY : INJECT_FULL;
        };
        const resolve = (context) => {
            const agent = context.agent;
            if (agent === undefined)
                return null;
            const session = agent.session;
            const cwd = session?.header?.cwd;
            return snapshotFor(agent, config, runtime) ?? liveSnapshot(agent.id, cwd, config, runtime);
        };
        const sections = [
            ['memory:soul', base + 5, (snapshot, scope) => renderPersona(snapshot, config, 'soul', scope)],
            ['memory:user', base + 6, (snapshot, scope) => renderPersona(snapshot, config, 'user', scope)],
            ['memory:facts', base + 40, (snapshot, scope) => renderFacts(snapshot, config, scope)],
            ['memory:journal', base + 41, (snapshot, scope) => renderJournal(snapshot, config, scope)],
        ];
        for (const [sectionName, order, render] of sections) {
            ctx.effect(() => systemPrompt.section({
                name: sectionName,
                order,
                // ⚠️ 必须显式关掉宿主插值：这些段落里会出现 `{{变量}}`（记忆正文、日志、
                //    角色文件都可能是任意用户文本），而 @deepseek-ai/dsh-system-prompt 的
                //    interpolate() 对「已注册变量表里没有的名字」是**抛错**而非原样保留 ——
                //    一个 `{{变量}}` 就会让整个 turn 以
                //    `malformed prompt variable reference "{{变量}}"` 失败。见 README「已知边界」。
                interpolate: false,
                text: (context) => {
                    try {
                        const snapshot = resolve(context);
                        return snapshot === null ? '' : render(snapshot, scopeOf(context));
                    }
                    catch (error) {
                        ctx.logger?.warn?.(`[dsh-persona-memory] 渲染 ${sectionName} 失败: ${String(error)}`);
                        return '';
                    }
                },
            }), `persona-memory: section ${sectionName}`);
        }
    }
    /* ── 工具 ── */
    const tools = ctx.get('tools');
    if (tools !== undefined) {
        ctx.effect(() => tools.register(memoryTool()), 'persona-memory: memory tool');
        ctx.effect(() => tools.register(personaTool()), 'persona-memory: persona tool');
    }
    /* ── 技能：随包发布角色创建流程 ── */
    const skills = ctx.get('skills');
    if (skills !== undefined) {
        const skillPath = join(PLUGIN_ROOT, 'skills', 'persona-creator', 'SKILL.md');
        ctx.effect(() => {
            const raw = readText(skillPath);
            if (raw === null)
                return () => { };
            const parsed = parseSkillFile(raw);
            try {
                return skills.register({
                    name: 'persona-creator',
                    description: parsed.description || '在 DSH 角色库里创建/编辑一个完整角色（persona.yml + SOUL.md + USER.md）。',
                    content: parsed.content,
                    source: 'custom',
                    path: skillPath,
                });
            }
            catch (error) {
                ctx.logger?.warn?.(`[dsh-persona-memory] 注册技能失败: ${String(error)}`);
                return () => { };
            }
        }, 'persona-memory: persona-creator skill');
    }
    /* ── 会话生命周期：清理内存快照 ── */
    ctx.on('agent/disposed', (payload) => {
        const id = payload?.agent?.id;
        if (typeof id !== 'string')
            return;
        runtime.snapshots.delete(id);
        runtime.sessionsSeen.delete(id);
    });
    /* ── 右侧栏管理面板的 HTTP API ── */
    const webServer = ctx.get('webServer');
    if (webServer !== undefined) {
        registerPanelRoutes(webServer, config, runtime, ctx);
    }
    else {
        // ⚠️ 启动期竞态：@deepseek-ai/dsh-host-webserver 的 fiber 要等 socket 绑定完成才
        //    ACTIVE，而 cordis 的 ctx.get() 默认 strict=true（只认 ACTIVE 的服务），加上
        //    loader 是并行启动 entry 的，插件 apply 常常早于它就绪。此时那个 `if` 会静默
        //    跳过 ⇒ 面板路由一条都不注册 ⇒ 面板永远 HTTP 404。
        //    这里用作用域 inject 等到服务就绪后补注册（与 dsh-whale-widget 同款等待方式）。
        ctx.inject(['webServer'], (panelScope) => {
            const ready = panelScope.get('webServer');
            if (ready !== undefined) {
                registerPanelRoutes(ready, config, runtime, panelScope);
            }
        });
    }
    ctx.logger?.info?.(`[dsh-persona-memory] 就绪：角色库 ${personasDir()}，记忆 ${memoryDir()}（作用于所有 agent 预设）`);
}
/** 本插件包根目录（lib/index.js 的上一级）。 */
const PLUGIN_ROOT = (() => {
    try {
        const here = new URL('.', import.meta.url).pathname;
        return dirname(dirname(decodeURIComponent(here)));
    }
    catch {
        return process.cwd();
    }
})();
/** 取 SKILL.md 的 YAML frontmatter description，并剥离 frontmatter。 */
function parseSkillFile(raw) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
    if (match === null)
        return { description: '', content: raw };
    let description = '';
    for (const line of match[1].split(/\r?\n/)) {
        const kv = /^description:\s*(.*)$/.exec(line);
        if (kv !== null)
            description = kv[1].trim().replace(/^["']/, '').replace(/["']$/, '');
    }
    return { description, content: raw.slice(match[0].length) };
}
/* ────────────────────────────── 面板 API ────────────────────────────── */
function registerPanelRoutes(webServer, config, runtime, ctx) {
    const base = config.panelPath;
    const sendJson = (res, status, payload) => {
        const body = JSON.stringify(payload);
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
    };
    const readBody = async (req, limitBytes = 262_144) => {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > limitBytes)
                throw new Error('请求体过大');
            chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        return raw.trim() === '' ? {} : JSON.parse(raw);
    };
    const route = (method, path, handler) => {
        ctx.effect(() => webServer.register({
            kind: 'exact',
            path: base + path,
            handler: (req, res) => {
                void (async () => {
                    try {
                        if (req.method !== method) {
                            sendJson(res, 405, { ok: false, error: `只支持 ${method}` });
                            return;
                        }
                        const payload = method === 'GET' ? {} : await readBody(req);
                        await handler(payload, req, res);
                    }
                    catch (error) {
                        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
                    }
                })();
            },
        }), `persona-memory: route ${method} ${path}`);
    };
    const knownProjects = () => {
        const seen = new Map();
        for (const cwd of runtime.cwdBySession.values()) {
            const project = findProjectMemory(cwd);
            if (project !== null)
                seen.set(project.path, project);
            else if (cwd !== '') {
                // 尚无 MEMORY.md 的项目也列出来，面板可以直接创建。
                const path = join(cwd, PROJECT_MEMORY_FILE);
                if (!seen.has(path))
                    seen.set(path, { root: cwd, path, exists: false, content: '' });
            }
        }
        for (const project of runtime.projectBySession.values())
            seen.set(project.path, project);
        return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
    };
    const state = () => {
        const list = scanPersonas();
        const active = activePersonaId();
        const detail = active === '' ? null : readPersona(active);
        const journal = readJournal(100);
        const snapshots = [];
        for (const snapshot of runtime.snapshots.values()) {
            snapshots.push({
                sessionId: snapshot.sessionId,
                createdAt: snapshot.createdAt,
                personaId: snapshot.persona?.id ?? null,
                personaName: snapshot.persona?.name ?? null,
                projectPath: snapshot.project?.path ?? null,
            });
        }
        return {
            ok: true,
            paths: {
                home: dshHome(),
                personas: personasDir(),
                memory: memoryDir(),
                fact: factPath(),
                journal: journalPath(),
                snapshots: snapshotsDir(),
            },
            persona: {
                active,
                list: list.map((persona) => ({ ...persona, active: persona.id === active })),
                detail,
            },
            memory: {
                global: {
                    path: factPath(),
                    exists: existsSync(factPath()),
                    content: readText(factPath()) ?? '',
                },
                projects: knownProjects(),
            },
            journal: {
                path: journalPath(),
                count: journal.total,
                entries: journal.entries.slice(-30).reverse(),
            },
            snapshots,
        };
    };
    // 统一信封：读与写一律 `{ ok: true, state }`，客户端只认这一种形状。
    route('GET', '/api/state', (_payload, _req, res) => {
        sendJson(res, 200, { ok: true, state: state() });
    });
    route('POST', '/api/persona/show', async (payload, _req, res) => {
        const id = String(payload.id ?? '').trim();
        const persona = readPersona(id);
        if (persona === null)
            throw new Error(`角色不存在：${id}`);
        sendJson(res, 200, { ok: true, persona });
    });
    route('POST', '/api/persona/use', async (payload, _req, res) => {
        const id = String(payload.id ?? '').trim();
        if (!isPersonaDir(join(personasDir(), id)))
            throw new Error(`角色不存在：${id}`);
        writeAtomic(activePath(), `${id}\n`);
        sendJson(res, 200, { ok: true, state: state() });
    });
    route('POST', '/api/persona/save', async (payload, _req, res) => {
        const id = String(payload.id ?? '').trim();
        const create = payload.create === true;
        if (!validPersonaId(id))
            throw new Error('角色 id 只能是小写字母/数字/中横线');
        const exists = isPersonaDir(join(personasDir(), id));
        if (!exists && !create)
            throw new Error(`角色不存在：${id}`);
        writePersona(id, {
            name: typeof payload.name === 'string' ? payload.name : undefined,
            description: typeof payload.description === 'string' ? payload.description : undefined,
            soul: typeof payload.soul === 'string' ? payload.soul : undefined,
            user: typeof payload.user === 'string' ? payload.user : undefined,
        });
        if (create && activePersonaId() === '')
            writeAtomic(activePath(), `${id}\n`);
        sendJson(res, 200, { ok: true, state: state() });
    });
    route('POST', '/api/persona/delete', async (payload, _req, res) => {
        const id = String(payload.id ?? '').trim();
        if (!isPersonaDir(join(personasDir(), id)))
            throw new Error(`角色不存在：${id}`);
        if (id === activePersonaId())
            throw new Error('这是当前角色，先切换到别的角色再删');
        rmSync(join(personasDir(), id), { recursive: true, force: true });
        sendJson(res, 200, { ok: true, state: state() });
    });
    route('POST', '/api/persona/order', async (payload, _req, res) => {
        const order = Array.isArray(payload.order) ? payload.order.filter((v) => typeof v === 'string') : [];
        const known = new Set(scanPersonas().map((persona) => persona.id));
        const filtered = order.filter((id) => known.has(id));
        writeAtomic(orderPath(), `${JSON.stringify(filtered, null, 2)}\n`);
        sendJson(res, 200, { ok: true, state: state() });
    });
    route('POST', '/api/memory/save', async (payload, _req, res) => {
        const scope = payload.scope === 'project' ? 'project' : 'global';
        const content = typeof payload.content === 'string' ? payload.content : '';
        if (scope === 'global') {
            writeAtomic(factPath(), ensureTrailingNewline(content));
            sendJson(res, 200, { ok: true, state: state() });
            return;
        }
        const path = String(payload.path ?? '').trim();
        if (path === '' || basename(path) !== PROJECT_MEMORY_FILE) {
            throw new Error(`项目记忆路径必须以 ${PROJECT_MEMORY_FILE} 结尾`);
        }
        const allowed = knownProjects().some((project) => project.path === path);
        if (!allowed && !existsSync(path))
            throw new Error('未知的项目记忆路径（先让会话在该项目下跑一次）');
        writeAtomic(path, ensureTrailingNewline(content));
        sendJson(res, 200, { ok: true, state: state() });
    });
    route('POST', '/api/journal/append', async (payload, _req, res) => {
        const text = String(payload.text ?? '').trim();
        if (text === '')
            throw new Error('日志内容不能为空');
        const tags = Array.isArray(payload.tags)
            ? payload.tags.filter((t) => typeof t === 'string' && t.trim() !== '')
            : [];
        appendJournal(text, tags);
        sendJson(res, 200, { ok: true, state: state() });
    });
    route('POST', '/api/journal/search', async (payload, _req, res) => {
        const query = String(payload.query ?? '');
        const tag = String(payload.tag ?? '');
        const limit = Number.isFinite(payload.limit) ? Math.max(1, Math.min(200, Math.trunc(payload.limit))) : 50;
        sendJson(res, 200, { ok: true, entries: searchJournal(query, tag, limit) });
    });
}
//# sourceMappingURL=index.js.map