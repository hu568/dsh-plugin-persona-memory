/**
 * @dsh-external/dsh-persona-memory — 宿主机半（HOST PLANE）。
 *
 * 角色设定（角色库）+ 长期记忆（全局 / 项目 / 日志）一次性解决：
 *
 *   角色库   $DSH_HOME/personas/<id>/{persona.yml,SOUL.md,USER.md}
 *   全局记忆 $DSH_HOME/memory/FACT.md
 *   长期日志 $DSH_HOME/memory/JOURNAL.jsonl      （仅全局一份，**不注入**）
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
 *
 * ⚠️ 长期日志（JOURNAL.jsonl）**不注入**提示词：它是无上限增长的流水账，注入后
 * 每轮都要为它付 token，且最新几条往往与当前任务无关。改为在记忆契约里留一行指针，
 * 让模型自己按需 `memory action=search` 拉。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import z from 'schemastery';
import { compact, compactionStatus, DEFAULT_KEEP_BACKUPS, rollbackCompaction, seedMetadata } from './compaction.js';
import { setLock, unsetLock } from './locks.js';
import { appendJournal, assertFactWithinLimit, assertProjectMemoryWithinLimit, configureCompactor, configureStore, countBytes, countChars, countLines, DEFAULT_JOURNAL_LIMIT, dshHome, ensureDir, factPath, findProjectMemory, journalPath, memoryDir, PROJECT_MEMORY_FILE, readJournal, readText, searchJournal, syncIndexAfterWrite, writeAtomic } from './store.js';
/** Cordis 插件名。 */
export const name = '@dsh-external/dsh-persona-memory';
/** 宿主服务依赖：提示词注册表 + 工具注册表（本部署两者恒在）。 */
export const inject = ['systemPrompt', 'tools'];
const PERSONA_FILE = 'persona.yml';
const SOUL_FILE = 'SOUL.md';
const USER_FILE = 'USER.md';
const ACTIVE_FILE = '.active';
const ORDER_FILE = '.personas-order';
/** 设置页的注入开关（覆盖组合配置里的默认值）。 */
const INJECTION_FILE = 'injection.json';
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
/**
 * 全局 FACT.md 的**行数硬上限**。
 *
 * FACT.md 会被注入**每一个主会话**的提示词。若把项目专属结论写进来，就变成所有项目、
 * 每一轮都要付的固定开销，还会把真正「跨项目稳定」的事实挤出去。这里在写入侧直接
 * 卡住（超限抛错而不是截断），配合契约文案把模型引导去 `scope=project`。
 */
const DEFAULT_MAX_FACT_LINES = 100;
/**
 * 全局 FACT.md 的**字节硬上限**（UTF-8，`\r\n` 归一化后计）。
 *
 * 只卡行数是不够的：行长完全自由 ⇒ 100 行可以写 7 KB，也可以写 20 KB，全局常驻
 * token 开销不可预测。本机实测真实文风约 **75.9 B/行**，80 B/行 × 100 行 = 8000 B
 * 是「贴合真实文风、略留余量」的取值；满配约 ≈2,560 tokens。
 * 与 `maxFactLines` **同时生效**，任一超限即拒写。
 */
const DEFAULT_MAX_FACT_BYTES = 8000;
/**
 * 项目 MEMORY.md 的**字符硬上限**（口径见 `countChars()`：`trim()` 后长度，与注入侧
 * `clip()` 逐字一致）。
 *
 * 注入侧本来就有 `maxChars`（默认 8000，超出被 `clip()` **静默截断**），而写入侧
 * 完全没有闸口 ⇒ 「写的时候不拦，读的时候悄悄截断」，正是本插件明确反对的模式
 * （静默截断等于悄悄丢用户内容）。默认与 `maxChars` 同口径、同数值，让「通过写入
 * 闸口」⇒「必然不会被注入截断」。
 */
const DEFAULT_MAX_PROJECT_CHARS = 8000;
export const Config = z.object({
    personaEnabled: z.boolean().default(true),
    memoryEnabled: z.boolean().default(true),
    /** 子代理会话是否只注入项目记忆（关掉即恢复「子代理与主会话注入相同内容」）。 */
    subagentProjectOnly: z.boolean().default(true),
    maxChars: z.number().min(500).default(DEFAULT_MAX_CHARS),
    /** 全局 FACT.md 的行数硬上限（`action=update, scope=global` 与面板写入都受它约束）。 */
    maxFactLines: z.number().min(1).default(DEFAULT_MAX_FACT_LINES),
    /** 全局 FACT.md 的字节硬上限（UTF-8；与 `maxFactLines` 同时生效，任一超限即拒写）。 */
    maxFactBytes: z.number().min(1).default(DEFAULT_MAX_FACT_BYTES),
    /** 项目 MEMORY.md 的字符硬上限（`action=update, scope=project` 与面板写入都受它约束）。 */
    maxProjectChars: z.number().min(1).default(DEFAULT_MAX_PROJECT_CHARS),
    /**
     * 压缩管线（0.8.0 · P4）：**默认开启**（0.7.1 起；0.8.0 初版曾默认关闭）。
     *
     * 打开后：手动 `/memory-compact` 随时可用；写入前水位 ≥85% ⇒ FACT 合并 → 淘汰 → 停手
     * （PLAN/01 §4）。关闭时写路径与 0.7.0 逐字节相同（`store.insertEntry` 里那一个 hook
     * 立即返回），但命令与面板入口也会直接拒绝 —— 用户装了插件却用不了命令，所以默认开。
     *
     * 默认开的依据是压缩自身带保护区与降级：没配 provider/model 时只走「淘汰」这一层，
     * 而淘汰只动侧车索引里有元数据、未锁定、无 `<!-- keep -->`、非当前工作区的条目
     * （见 lib/compaction.js）；索引缺失/损坏时整体跳过，宁可不压缩也不盲删。
     */
    compactionEnabled: z.boolean().default(true),
    /** 合并用的 provider（留空 ⇒ **继承会话模型**；会话拿不到再退宿主默认模型）。 */
    compactProvider: z.string().default(''),
    /** 合并用的 model（留空 ⇒ 同上；与 provider 必须同时填才生效）。 */
    compactModel: z.string().default(''),
    /** 压缩备份保留份数（`memory/backups/<file>-<yyyyMMdd-HHmmss>.bak`）。 */
    compactKeepBackups: z.number().min(1).default(DEFAULT_KEEP_BACKUPS),
    panelPath: z.string().default('/persona-memory'),
});
/* ────────────────────────────── 路径与文件 ────────────────────────────── */
function personasDir() {
    return join(dshHome(), 'personas');
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
function injectionPath() {
    return join(memoryDir(), INJECTION_FILE);
}
/**
 * 设置页的三个注入开关。键名刻意不用 `personaEnabled` / `memoryEnabled`：
 * 那是组合配置（`cordis.patch.yml`）的字段名，而这里是它之上的用户覆盖层。
 */
const INJECTION_FIELDS = ['persona', 'globalMemory', 'projectMemory'];
function clip(text, maxChars) {
    const trimmed = text.trim();
    return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n…（已截断）` : trimmed;
}
/**
 * 读设置页的覆盖层。文件不存在 / 坏掉 / 类型不对都当作「没设过」：
 * 开关只是注入的加成，绝不该让一次手改文件把整个插件炸掉。
 */
function readInjectionOverrides() {
    const raw = readText(injectionPath());
    if (raw === null)
        return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return {};
        const out = {};
        for (const key of INJECTION_FIELDS) {
            if (typeof parsed[key] === 'boolean')
                out[key] = parsed[key];
        }
        return out;
    }
    catch {
        return {};
    }
}
/** 合并写入覆盖层（只认三个布尔键），返回落盘后的完整覆盖层。 */
function writeInjectionOverrides(patch) {
    const next = readInjectionOverrides();
    if (patch !== null && typeof patch === 'object' && !Array.isArray(patch)) {
        for (const key of INJECTION_FIELDS) {
            if (typeof patch[key] === 'boolean')
                next[key] = patch[key];
        }
    }
    writeAtomic(injectionPath(), `${JSON.stringify(next, null, 2)}\n`);
    return next;
}
/**
 * 生效的注入开关：用户覆盖层优先，没设过的键回落到组合配置。
 * 每次渲染都现算 —— 开关在**当前会话的下一轮**就生效（快照只冻结文件内容，
 * 不冻结开关）。
 */
function injectionFlags(config, runtime) {
    const overrides = runtime.injection ?? {};
    return {
        persona: overrides.persona ?? config.personaEnabled,
        globalMemory: overrides.globalMemory ?? config.memoryEnabled,
        projectMemory: overrides.projectMemory ?? config.memoryEnabled,
    };
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
/**
 * FACT.md 首次创建时的模板。
 *
 * ⚠️ 本文件有**行数与字节双硬上限**（`config.maxFactLines` 默认 100 行、
 * `config.maxFactBytes` 默认 8000 字节）：模板只给骨架，别往里塞示例条目 ——
 * 每多一行都是所有项目、每一轮的固定开销。
 */
function factTemplate() {
    return `# FACT.md — 全局长期记忆

<!-- 跨会话、跨项目的稳定事实（6 个月以上仍然成立）。由 memory 工具 scope=global 维护。
     只放「事实」，不放流水账——流水账写 JOURNAL.jsonl。
     ⚠️ 项目专属事实（换目录就不成立的）请写进项目根的 MEMORY.md，不要塞这里。
     ⚠️ 本文件有硬上限 100 行 / 8000 字节：超限写入会被 memory 工具拒绝，并提示改投项目记忆。 -->

## 关于用户

## 关于环境

## 长期约定
`;
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
    const snapshot = {
        version: 1,
        sessionId,
        createdAt: Date.now(),
        persona,
        globalFact: readText(factPath()) ?? '',
        project: project === null ? null : { path: project.path, root: project.root, content: project.content },
        // ⚠️ 刻意**不存**日志：快照是每轮都读的东西，流水账放进来会让它无限膨胀。
        journalTotal: readJournal(DEFAULT_JOURNAL_LIMIT).total,
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
    if (session !== undefined && session !== null)
        runtime.sessionById.set(sessionId, session);
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
function memoryContract(globalPath, journalFile, projectPath, journalTotal, maxFactLines, maxFactBytes, maxProjectChars, flags) {
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
function projectMemoryContract(projectPath, projectRoot, journalTotal, maxProjectChars) {
    return [
        '【记忆写入契约】子代理只拿到**项目记忆**，角色设定与全局记忆（FACT.md）均未注入。',
        `- 项目事实 → action=update, scope=project（写 ${projectPath}），整篇覆盖，请带上已有内容。**上限 ${maxProjectChars} 字符，超限会被拒绝。**`,
        '- 需要全局记忆或历史笔记时 → action=read / action=search（只读，别写全局）。',
        `- 项目根：${projectRoot}。`,
        `- 长期日志（${journalPath()}）现有 ${journalTotal} 条，正文未注入；需要旧笔记时 action=search。`,
        '写入立即落盘；本会话注入的是首条消息时的快照，更新内容在**新会话**生效。',
    ].join('\n');
}
function renderPersona(snapshot, config, which, scope, flags) {
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
function renderFacts(snapshot, config, scope, flags) {
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
function memoryTool(config) {
    const maxFactLines = config.maxFactLines ?? DEFAULT_MAX_FACT_LINES;
    const maxFactBytes = config.maxFactBytes ?? DEFAULT_MAX_FACT_BYTES;
    const maxProjectChars = config.maxProjectChars ?? DEFAULT_MAX_PROJECT_CHARS;
    return textTool({
        name: 'memory',
        description: [
            '读写长期记忆（本工具没有路径参数）。',
            'action=read：读全局记忆 FACT.md + 当前项目记忆 MEMORY.md + 最近日志。',
            `action=update：整篇覆盖写入（scope=global 写全局 FACT.md，**硬上限 ${maxFactLines} 行 AND ${maxFactBytes} 字节，任一超限直接报错**；scope=project 写当前项目根的 MEMORY.md，**上限 ${maxProjectChars} 字符，超限直接报错**）。`,
            `★全局/项目分界：FACT.md 只放「换任何项目都成立」的事实（预算 ${maxFactLines} 行 / ${maxFactBytes} 字节）；本工作区的约定、机制探索结论、清单与踩坑一律写 scope=project。`,
            'action=append：向全局长期日志 JOURNAL.jsonl 追加一条 {ts,tags,text}（一次性事件/会话笔记；日志无上限且不注入提示词）。',
            'action=search：在日志里按子串（可选 tag）检索历史笔记。日志正文**不进提示词**，需要旧笔记只能靠 search/read 现取。',
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
        run: async (args, exec) => {
            const action = String(args.action ?? '');
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
                    `## 全局记忆 · FACT.md（${factLines} 行 / 上限 ${maxFactLines} 行，${factBytes} 字节 / 上限 ${maxFactBytes} 字节）\n路径: ${factPath()}${factOver}\n\n${(factRaw ?? '（尚未创建）').trim()}`,
                    project === null
                        ? `## 项目记忆 · MEMORY.md\n当前 cwd (${cwd ?? '未知'}) 向上没有找到 MEMORY.md。`
                        : `## 项目记忆 · ${project.path}（${projectChars} 字符 / 上限 ${maxProjectChars} 字符）${projectOver}\n\n${projectText.trim() || '（空文件）'}`,
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
                    assertFactWithinLimit(content, maxFactLines, maxFactBytes);
                    writeAtomic(factPath(), ensureTrailingNewline(content));
                    // 整篇写入也要维护侧车索引，否则新条目永远没有元数据（压缩淘汰层就没候选）
                    syncIndexAfterWrite('fact', factPath(), content);
                    return `已写入全局记忆 FACT.md（${factPath()}，${countChars(content)} 字符 / ${countBytes(content)} 字节 / ${countLines(content)} 行，上限 ${maxFactLines} 行 / ${maxFactBytes} 字节）。本会话注入仍是首条消息快照，新会话生效。`;
                }
                const cwd = callerCwd(exec);
                const existing = findProjectMemory(cwd);
                const target = existing === null
                    ? (cwd === undefined ? null : join(resolvePath(cwd), PROJECT_MEMORY_FILE))
                    : existing.path;
                if (target === null)
                    throw new Error('无法确定当前项目根（会话 cwd 未知），无法写项目记忆');
                assertProjectMemoryWithinLimit(content, maxProjectChars);
                writeAtomic(target, ensureTrailingNewline(content));
                syncIndexAfterWrite('memory', target, content);
                return `已写入项目记忆 ${target}（${countChars(content)} 字符，上限 ${maxProjectChars} 字符）。新会话生效。`;
            }
            if (action === 'append') {
                const text = typeof args.text === 'string' ? args.text.trim() : '';
                if (text === '')
                    throw new Error('append 需要非空 text');
                const tags = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string') : [];
                const entry = await appendJournal(text, tags);
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
/* ─────────────────────── 设置页：附属插件设置项注册表 ─────────────────────── */
/**
 * 设置页的扩展点。附属插件（如 `dsh-persona-memory-recall`）通过宿主服务
 * `ctx.personaMemory.settings.register(item)` 注册一行声明式设置项，页面只负责
 * 渲染与回写；取值怎么存、变更后做什么，全由注册方自己决定。
 *
 * 只支持四种 JSON 可表达的控件：`toggle` / `select` / `text` / `readonly`。
 * 需要完整自定义界面的插件走客户端槽 `settings.persona-memory.item`。
 */
const SETTINGS_ITEM_KINDS = new Set(['toggle', 'select', 'text', 'readonly']);
const SETTINGS_ITEM_DEFAULT_GROUP = '附属插件';
function isOptionValue(value) {
    return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}
/** 校验并归一化一个设置项的值；不合法返回 null（调用方决定报什么错）。 */
function normalizeSettingsValue(kind, value) {
    if (kind === 'toggle')
        return typeof value === 'boolean' ? value : null;
    if (kind === 'text')
        return typeof value === 'string' ? value : null;
    if (kind === 'select')
        return isOptionValue(value) ? value : null;
    return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
        ? value
        : null;
}
function normalizeSettingsOptions(raw) {
    if (!Array.isArray(raw))
        return [];
    const options = [];
    for (const option of raw) {
        if (option === null || typeof option !== 'object')
            continue;
        if (!isOptionValue(option.value))
            continue;
        options.push({ value: option.value, label: String(option.label ?? option.value) });
    }
    return options;
}
function createSettingsRegistry() {
    const items = new Map();
    let seq = 0;
    const serialize = (entry) => ({
        id: entry.id,
        group: entry.group,
        title: entry.title,
        description: entry.description,
        note: entry.note,
        kind: entry.kind,
        value: entry.value,
        options: entry.options,
        order: entry.order,
    });
    const find = (id) => {
        const key = typeof id === 'string' ? id.trim() : '';
        if (key === '')
            throw new Error('设置项 id 不能为空');
        const entry = items.get(key);
        if (entry === undefined)
            throw new Error(`未知的设置项：${key}`);
        return entry;
    };
    const registry = {
        register(raw) {
            if (raw === null || typeof raw !== 'object')
                throw new Error('设置项必须是对象');
            const id = typeof raw.id === 'string' ? raw.id.trim() : '';
            if (id === '' || id.length > 120)
                throw new Error('设置项 id 必须是非空字符串（≤120 字符）');
            if (items.has(id))
                throw new Error(`设置项 id 重复：${id}`);
            const title = typeof raw.title === 'string' ? raw.title.trim() : '';
            if (title === '')
                throw new Error(`设置项 ${id} 缺少 title`);
            const kind = SETTINGS_ITEM_KINDS.has(raw.kind) ? raw.kind : 'toggle';
            const options = normalizeSettingsOptions(raw.options);
            if (kind === 'select' && options.length === 0)
                throw new Error(`设置项 ${id} 是 select，但没有有效的 options`);
            const value = normalizeSettingsValue(kind, raw.value);
            if (value === null)
                throw new Error(`设置项 ${id} 的 value 与 kind=${kind} 不匹配`);
            if (kind === 'select' && !options.some((option) => String(option.value) === String(value)))
                throw new Error(`设置项 ${id} 的 value 不在 options 里`);
            const onChange = typeof raw.onChange === 'function' ? raw.onChange : undefined;
            const entry = {
                id,
                group: typeof raw.group === 'string' && raw.group.trim() !== '' ? raw.group.trim() : SETTINGS_ITEM_DEFAULT_GROUP,
                title,
                description: typeof raw.description === 'string' ? raw.description : '',
                note: typeof raw.note === 'string' ? raw.note : '',
                kind,
                value,
                options,
                order: Number.isFinite(raw.order) ? Number(raw.order) : 1000,
                seq: ++seq,
                onChange,
            };
            items.set(id, entry);
            const handle = {
                id,
                get: () => entry.value,
                set: (next) => registry.set(id, next),
                /** 只改展示信息，不触发 onChange（供注册方同步外部变化用）。 */
                update(patch) {
                    if (patch === null || typeof patch !== 'object')
                        return;
                    if (typeof patch.title === 'string' && patch.title.trim() !== '')
                        entry.title = patch.title.trim();
                    if (typeof patch.description === 'string')
                        entry.description = patch.description;
                    if (typeof patch.note === 'string')
                        entry.note = patch.note;
                    if (typeof patch.group === 'string' && patch.group.trim() !== '')
                        entry.group = patch.group.trim();
                    if (Number.isFinite(patch.order))
                        entry.order = Number(patch.order);
                    if (patch.options !== undefined)
                        entry.options = normalizeSettingsOptions(patch.options);
                    const next = normalizeSettingsValue(entry.kind, patch.value);
                    if (next !== null)
                        entry.value = next;
                },
                dispose() {
                    if (items.get(id) === entry)
                        items.delete(id);
                },
            };
            return handle;
        },
        list() {
            return [...items.values()]
                .sort((a, b) => a.order - b.order || a.seq - b.seq)
                .map(serialize);
        },
        has(id) {
            return typeof id === 'string' && items.has(id.trim());
        },
        async set(id, value) {
            const entry = find(id);
            if (entry.kind === 'readonly')
                throw new Error(`设置项 ${entry.id} 是只读的`);
            const next = normalizeSettingsValue(entry.kind, value);
            if (next === null)
                throw new Error(`设置项 ${entry.id} 不接受这个值`);
            if (entry.kind === 'select' && !entry.options.some((option) => String(option.value) === String(next)))
                throw new Error(`设置项 ${entry.id} 的值不在 options 里`);
            // 先等注册方处理完再落值：失败时页面显示的值与真实状态不会分叉。
            if (entry.onChange !== undefined)
                await entry.onChange(next);
            entry.value = next;
            return serialize(entry);
        },
    };
    return registry;
}
/* ────────────────────────────── 主入口 ────────────────────────────── */
export function apply(ctx, rawConfig) {
    const config = Config(rawConfig ?? {});
    // 上限只配一次：store 的闸口/水位/条目写入都从这里读（附属插件拿不到本插件的配置）。
    configureStore(config);
    const runtime = {
        snapshots: new Map(),
        cwdBySession: new Map(),
        projectBySession: new Map(),
        sessionsSeen: new Set(),
        /** 会话句柄（只读用途）：压缩要回读「本会话用的 provider/model」。 */
        sessionById: new Map(),
        /** 设置页的注入开关覆盖层（`memory/injection.json`）。 */
        injection: readInjectionOverrides(),
    };
    /* ── 压缩管线接线（P4 · 0.8.0，默认开启） ──
       `store` 只认"注入进来的压缩器"（避免 store ↔ compaction 成环），所以接线在这里：
       ① 写前 hook 用的压缩器；② 命令与面板用的 callModel / 配置。 */
    const compactRuntime = {
        latestCwd: () => latestSessionCwd(runtime),
        workspaceIdOf: (cwd) => workspaceIdFor(cwd),
        /** 按 cwd 找会话句柄：写前 hook 没有 invocation，靠它继承会话模型。 */
        sessionFor: (cwd) => {
            let fallback = undefined;
            for (const session of runtime.sessionById.values()) {
                fallback = session;
                const at = session?.header?.cwd;
                if (typeof cwd === 'string' && cwd !== '' && typeof at === 'string' && at === cwd)
                    return session;
            }
            return fallback;
        },
        callModel: makeCompactCallModel(ctx, config),
    };
    configureCompactor((scope, options) => runCompaction(scope, options, config, compactRuntime));
    const settingsRegistry = createSettingsRegistry();
    ensureSeed(ctx);
    /* ── 设置页扩展点：给附属插件用的宿主服务 ──
       用普通对象而不是 cordis Service：本插件在不装 cordis 的裸 node 测试里也要能
       apply（测试只给了假 ctx）。代价是拿不到「调用方 fiber」的自动回收，因此
       注册项返回带 `dispose()` 的句柄；文档里让注册方用 `ctx.effect` 包一层即可。 */
    const settingsApi = {
        version: 1,
        settings: {
            register: (item) => settingsRegistry.register(item),
            list: () => settingsRegistry.list(),
            has: (id) => settingsRegistry.has(id),
            set: (id, value) => settingsRegistry.set(id, value),
        },
        injection: {
            get: () => injectionFlags(config, runtime),
            set: (patch) => {
                runtime.injection = writeInjectionOverrides(patch ?? {});
                return injectionFlags(config, runtime);
            },
        },
    };
    if (typeof ctx.provide === 'function') {
        try {
            ctx.provide('personaMemory', settingsApi);
        }
        catch (error) {
            ctx.logger?.warn?.(`[dsh-persona-memory] 无法提供 personaMemory 服务: ${String(error)}`);
        }
    }
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
            if (typeof agent.id === 'string' && session !== undefined && session !== null)
                runtime.sessionById.set(agent.id, session);
            const cwd = session?.header?.cwd;
            return snapshotFor(agent, config, runtime) ?? liveSnapshot(agent.id, cwd, config, runtime);
        };
        const sections = [
            ['memory:soul', base + 5, (snapshot, scope, flags) => renderPersona(snapshot, config, 'soul', scope, flags)],
            ['memory:user', base + 6, (snapshot, scope, flags) => renderPersona(snapshot, config, 'user', scope, flags)],
            ['memory:facts', base + 40, (snapshot, scope, flags) => renderFacts(snapshot, config, scope, flags)],
            // ⚠️ 曾经还有 `memory:journal`（注入最近 N 条日志），已**整段移除**：
            //    JOURNAL.jsonl 是无上限增长的流水账，注入它等于每轮都为它付 token，
            //    而最近几条往往与当前任务无关。现在只由 memoryContract 留一行指针，
            //    模型觉得需要时自己 `memory action=search` 拉。
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
                        return snapshot === null ? '' : render(snapshot, scopeOf(context), injectionFlags(config, runtime));
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
        ctx.effect(() => tools.register(memoryTool(config)), 'persona-memory: memory tool');
        ctx.effect(() => tools.register(personaTool()), 'persona-memory: persona tool');
    }
    /* ── `/memory-compact` 命令（P4 · 0.8.0） ──
       宿主 `commands` 服务不在 inject 列表里（它缺席时本插件其余功能照常），
       所以用作用域 inject 等它；handler 支持 async（宿主 `await Promise.resolve(...)`）。 */
    ctx.inject(['commands'], (commandScope) => {
        const commands = commandScope.get('commands');
        if (commands === undefined)
            return;
        try {
            commandScope.effect(() => commands.register({
                name: 'memory-compact',
                description: '手动压缩记忆：同组条目合并 → 按水位淘汰（不带参数 = 压缩当前项目 MEMORY.md；seed = 先回填侧车索引）',
                input: { hint: '[fact|memory|all] [dry] [seed] | rollback <yyyyMMdd-HHmmss>' },
                handler: (invocation) => runCompactCommand(invocation, config, compactRuntime),
            }), 'persona-memory: command memory-compact');
        }
        catch (error) {
            ctx.logger?.warn?.(`[dsh-persona-memory] 注册 /memory-compact 失败: ${String(error)}`);
        }
    });
    /* ── 角色创建流程技能：**故意不在此注册** ──
       ⚠️ 别再往 skills.register 里加：该技能按设计**不作为技能注册**，而是作为物料安装到
       角色库 —— $DSH_HOME/personas/skills/persona-creator/SKILL.md，入口是 personas/README.md
       里的相对路径指针。内容正本在仓库 skills/persona-creator/SKILL.md，**不随包发布**
       （package.json 的 files 不含 skills），运行时既拿不到它、也不该拿它。 */
    /* ── 会话生命周期：清理内存快照 ── */
    ctx.on('agent/disposed', (payload) => {
        const id = payload?.agent?.id;
        if (typeof id !== 'string')
            return;
        runtime.snapshots.delete(id);
        runtime.sessionsSeen.delete(id);
        runtime.sessionById.delete(id);
    });
    /* ── 右侧栏管理面板的 HTTP API ── */
    const webServer = ctx.get('webServer');
    if (webServer !== undefined) {
        registerPanelRoutes(webServer, config, runtime, ctx, settingsRegistry);
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
                registerPanelRoutes(ready, config, runtime, panelScope, settingsRegistry);
            }
        });
    }
    ctx.logger?.info?.(`[dsh-persona-memory] 就绪：角色库 ${personasDir()}，记忆 ${memoryDir()}（作用于所有 agent 预设）`);
}
/* ─────────────────────── 压缩管线（P4 · 0.8.0，默认开启） ─────────────────────── */
/**
 * 会话 cwd → workspaceId（读宿主工作区注册表 `$DSH_HOME/storages/workspace.json`）。
 *
 * 只用于一件事：**当前工作区的 project 条目不许被自动淘汰**（PLAN/01 §4.4 保护区）。
 * 注册表读不到（不同版本/手改成坏 JSON）就返回 undefined —— 那时保护区只靠
 * 锁定 / `<!-- keep -->` / 元数据，绝不因为拿不到上下文而放宽淘汰。
 */
function workspaceIdFor(cwd) {
    if (typeof cwd !== 'string' || cwd.trim() === '')
        return undefined;
    const raw = readText(join(dshHome(), 'storages', 'workspace.json'));
    if (raw === null)
        return undefined;
    try {
        const parsed = JSON.parse(raw);
        const workspaces = parsed?.tables?.workspaces;
        if (workspaces === null || typeof workspaces !== 'object')
            return undefined;
        const wanted = resolvePath(cwd).toLowerCase();
        for (const [id, meta] of Object.entries(workspaces)) {
            if (typeof meta?.path !== 'string' || meta.path === '')
                continue;
            const root = resolvePath(meta.path).toLowerCase();
            if (wanted === root || wanted.startsWith(`${root}\\`) || wanted.startsWith(`${root}/`))
                return id;
        }
    }
    catch {
        /* 坏注册表 = 没有上下文 */
    }
    return undefined;
}

/** 最近一次见到的工作目录（面板/命令没有会话上下文时用来定位项目记忆）。 */
function latestSessionCwd(runtime) {
    let latest = '';
    for (const cwd of runtime.cwdBySession.values()) {
        if (typeof cwd === 'string' && cwd !== '')
            latest = cwd;
    }
    return latest === '' ? undefined : latest;
}

/**
 * DSH 工作区注册表里的全部路径（`$DSH_HOME/storages/workspace.json` 的
 * `tables.workspaces[*].path`）。坏文件 / 旧版本没有该字段 ⇒ 空数组。
 *
 * 面板要跟着工作区切换，只看"本进程见过的会话 cwd"是不够的：刚重启、还没跑过
 * 会话的工作区不会出现在列表里。这里读注册表补全，用法与 `workspaceIdFor()` 同源。
 */
function registeredWorkspacePaths() {
    const raw = readText(join(dshHome(), 'storages', 'workspace.json'));
    if (raw === null)
        return [];
    try {
        const parsed = JSON.parse(raw);
        const workspaces = parsed?.tables?.workspaces;
        if (workspaces === null || typeof workspaces !== 'object')
            return [];
        const paths = [];
        for (const meta of Object.values(workspaces)) {
            if (typeof meta?.path === 'string' && meta.path.trim() !== '')
                paths.push(meta.path);
        }
        return paths;
    }
    catch {
        return [];
    }
}

/**
 * 一个 cwd 对应的「项目记忆条目」：先按注入侧同一套规则（`findProjectMemory`）向上找
 * MEMORY.md；找不到就认为项目根就是 cwd 本身（写入即创建），形状与
 * `findProjectMemory()` 的返回值一致。cwd 为空 ⇒ null。
 */
function projectEntryFor(cwd) {
    if (typeof cwd !== 'string' || cwd.trim() === '')
        return null;
    const found = findProjectMemory(cwd);
    if (found !== null)
        return found;
    const root = resolvePath(cwd);
    return { root, path: join(root, PROJECT_MEMORY_FILE), exists: false, content: '' };
}

function readSessionRoute(session) {
    try {
        const config = session?.requestHeader?.()?.config;
        if (config === null || config === undefined)
            return null;
        const provider = String(config.provider ?? '').trim();
        const model = String(config.model ?? '').trim();
        return provider === '' || model === '' ? null : { provider, model };
    }
    catch {
        return null;
    }
}

/** 回退路线：宿主设置页里的默认模型（agentDefaultModel 服务，缺席 ⇒ null）。 */
function readDefaultModelRoute(ctx) {
    try {
        const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
        if (selection === null || selection === undefined)
            return null;
        const provider = String(selection.provider ?? '').trim();
        const model = String(selection.model ?? '').trim();
        return provider === '' || model === '' ? null : { provider, model };
    }
    catch {
        return null;
    }
}

/**
 * 合并用的 `callModel`：照宿主的 chunk 协议累加文本。
 *
 * - `text-delta` 累加 `chunk.text`；
 * - 终结块是 `finish`，`kind` 为 `stop` / `max-tokens` / `tool-calls` 才算成功
 *   （`error` / `aborted` 带 `failure.code`，一律当"这次合并没结果"）。
 *
 * 路线优先级（0.7.2 起）：
 *  1. 配置里显式填的 `compactProvider` / `compactModel`；
 *  2. 当前会话最近一次请求的 provider/model（`session.requestHeader().config`，
 *     会话至少跑过一步后可用 —— 即"继承会话模型"）；
 *  3. 宿主默认模型（`agentDefaultModel` 服务）。
 *
 * 三处都拿不到（或 `llm` 服务不在 / 调用抛错）⇒ 返回 null，压缩退化为"只淘汰"。
 */
function makeCompactCallModel(ctx, config) {
    const configuredProvider = String(config.compactProvider ?? '').trim();
    const configuredModel = String(config.compactModel ?? '').trim();
    return async (prompt, meta) => {
        let route = null;
        if (configuredProvider !== '' && configuredModel !== '') {
            route = { provider: configuredProvider, model: configuredModel };
        }
        else {
            route = readSessionRoute(meta?.session) ?? readDefaultModelRoute(ctx);
        }
        if (route === null)
            return null;
        const llm = ctx.get('llm');
        if (llm === undefined || typeof llm.stream !== 'function')
            return null;
        let text = '';
        let failed = false;
        try {
            for await (const chunk of llm.stream({
                provider: route.provider,
                model: route.model,
                messages: [{ role: 'user', content: [{ type: 'text', text: String(prompt) }] }],
            })) {
                const type = chunk?.type;
                if (type === 'text-delta') {
                    if (typeof chunk.text === 'string')
                        text += chunk.text;
                    continue;
                }
                if (type === 'finish') {
                    const kind = chunk.kind;
                    if (kind !== 'stop' && kind !== 'max-tokens' && kind !== 'tool-calls')
                        failed = true;
                }
            }
        }
        catch {
            return null;
        }
        return failed ? null : text;
    };
}

function percent(ratio) {
    return Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : '—';
}

function describeMeasures(measures) {
    if (measures === null || typeof measures !== 'object')
        return '—';
    return `${measures.lines ?? '?'} 行 / ${measures.bytes ?? '?'} 字节 / ${measures.chars ?? '?'} 字符`;
}

/** 命令结果里的目标路径（issue 要求：用户得看得出命令动的是哪个文件）。 */
function compactPathLine(result) {
    return typeof result?.path === 'string' && result.path !== '' ? `\n  路径：${result.path}` : '';
}
/** 逐条列出被淘汰（dry 时「将淘汰」）的条目 + 分数：3–5 条，直接给人看。 */
function describeEvicted(result, dryRun) {
    if (!Array.isArray(result?.evicted) || result.evicted.length === 0)
        return [];
    const lines = [`  ${dryRun ? '将淘汰' : '已淘汰'}：`];
    for (const item of result.evicted) {
        const text = String(item.text ?? '');
        lines.push(`  - ${text.length > 60 ? `${text.slice(0, 60)}…` : text}（score ${item.score}）`);
    }
    return lines;
}

function describeCompactionResult(scope, result, dryRun) {
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
    if (result.error === 'MEMORY_BUDGET_EXCEEDED')
        return finish(`${prefix}${label}：${result.message ?? '压缩后仍超限'} → MEMORY_BUDGET_EXCEEDED${pathLine}`);
    if (result.changed === false)
        return `${prefix}${label}：水位 ${percent(result.ratio)}，未达到淘汰线且没有可合并的条目，文件未改动${pathLine}`;
    return finish(`${prefix}${label}：水位 ${percent(result.beforeRatio)} → ${percent(result.ratio)}（合并 ${result.merged?.length ?? 0} 组 / 淘汰 ${result.evicted?.length ?? 0} 条）${pathLine}`);
}

/** 统一的压缩参数装配点：写前 hook、命令、面板都从这里过。 */
function runCompaction(scope, options, config, deps) {
    const given = typeof options?.cwd === 'string' && options.cwd !== '' ? options.cwd : undefined;
    const cwd = given ?? deps.latestCwd();
    return compact(scope, {
        cwd,
        dryRun: options?.dryRun === true,
        workspaceId: deps.workspaceIdOf(cwd),
        session: options?.session ?? deps.sessionFor?.(cwd),
        callModel: config.compactionEnabled === true ? deps.callModel : null,
        keepBackups: config.compactKeepBackups ?? DEFAULT_KEEP_BACKUPS,
        trigger: typeof options?.trigger === 'string' ? options.trigger : 'manual',
    });
}

/** `seed` 子命令的结果文案：说清回填几条、索引写在哪、dry 时列出将回填哪些。 */
function describeSeedResult(scope, result, dryRun) {
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

const COMPACT_USAGE = '用法：/memory-compact [fact|memory|all] [dry] [seed]　或　/memory-compact rollback <yyyyMMdd-HHmmss>（不带参数 = 压缩当前项目的 MEMORY.md；先 seed 回填索引）';

/** 不带参数时的默认作用域：项目级 MEMORY.md（主人 2026-11-01 要求）。 */
const COMPACT_DEFAULT_VERB = 'memory';

/**
 * `/memory-compact` 的 handler。
 *
 * 契约：**永远返回 `{kind, text}`，绝不 throw**（宿主会把抛出的 handler 结算成
 * `command/done` 错误，用户看到的是一句"命令失败"而不是我们能解释的原因）。
 */
async function runCompactCommand(invocation, config, deps) {
    try {
        const tokens = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter((token) => token !== '');
        const isDryToken = (token) => {
            const lower = String(token ?? '').toLowerCase();
            return lower === 'dry' || lower === '--dry';
        };
        const isSeedToken = (token) => String(token ?? '').toLowerCase() === 'seed';
        const first = (tokens[0] ?? '').toLowerCase();
        const usedDefault = first === '' || isDryToken(first) || isSeedToken(first);
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
            const result = await runCompaction(scope, { cwd, dryRun, trigger: 'command', session }, config, deps);
            lines.push(describeCompactionResult(scope, result, dryRun));
            if (result?.ok === false && typeof result?.error === 'string')
                failed += 1;
        }
        if (seed) {
            lines.push('提示：seed 只补侧车索引元数据（firstSeen/lastHit = 文件 mtime、hits=0、confidence=low），不删任何正文；确认计划后跑不带 seed 的命令才会真删（≤5 条，压到 75% 起步）。');
        }
        else if (verb !== 'fact') {
            lines.push('提示：MEMORY.md 只合并「同一段落里没有子项的叶子条目」，编号与缩进原样保留；带子项的条目只淘汰、不合并。');
        }
        return { kind: failed > 0 ? 'error' : 'success', text: lines.join('\n') };
    }
    catch (error) {
        return { kind: 'error', text: `压缩失败：${String(error?.message ?? error)}` };
    }
}

/* ────────────────────────────── 面板 API ────────────────────────────── */
function registerPanelRoutes(webServer, config, runtime, ctx, settingsRegistry) {
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
    /**
     * 面板「项目」列表，按 path 去重，三个来源：
     *  1. DSH 工作区注册表 —— 刚重启、还没跑过会话的工作区也要能看到，否则面板无法
     *     在切换工作区后立刻显示对应 MEMORY.md；
     *  2. 本进程见过的会话 cwd（注入/写入实际用到的路径）；
     *  3. 已固化的会话快照里记录的项目。
     * 当前请求带来的 cwd 一并并入（注册表可能还没登记刚打开的新目录）。
     */
    const knownProjects = (currentCwd) => {
        const seen = new Map();
        const add = (project) => {
            if (project !== null)
                seen.set(project.path, project);
        };
        for (const root of registeredWorkspacePaths())
            add(projectEntryFor(root));
        for (const cwd of runtime.cwdBySession.values())
            add(projectEntryFor(cwd));
        for (const project of runtime.projectBySession.values())
            add(project);
        add(projectEntryFor(currentCwd));
        return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
    };
    /**
     * 设置页数据：三个注入开关 + 一眼能看懂的当前体量 + 附属插件注册项。
     * 与侧栏面板的 `state` 分开：设置页不需要角色正文/日志条目的全量。
     */
    const settingsState = () => {
        const active = activePersonaId();
        const persona = active === '' ? null : readPersona(active);
        const fact = readText(factPath()) ?? '';
        return {
            path: injectionPath(),
            injection: injectionFlags(config, runtime),
            defaults: {
                persona: config.personaEnabled,
                globalMemory: config.memoryEnabled,
                projectMemory: config.memoryEnabled,
            },
            overrides: runtime.injection ?? {},
            context: {
                persona: persona === null ? null : { id: persona.id, name: persona.name },
                fact: {
                    exists: existsSync(factPath()),
                    lines: countLines(fact),
                    bytes: countBytes(fact),
                    maxLines: config.maxFactLines ?? DEFAULT_MAX_FACT_LINES,
                    maxBytes: config.maxFactBytes ?? DEFAULT_MAX_FACT_BYTES,
                },
                projectCount: knownProjects().length,
            },
            items: settingsRegistry.list(),
        };
    };
    /** 面板状态。`cwd` = 请求方主视图会话的工作目录（由 GET /api/state?cwd= 传入）。 */
    const state = (cwd) => {
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
                /** 请求方当前所在的项目（面板据此跟随工作区切换；没有 cwd 时为 null）。 */
                current: projectEntryFor(cwd),
                projects: knownProjects(cwd),
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
    route('GET', '/api/state', (_payload, req, res) => {
        // 面板把主视图会话的 cwd 带上来，项目记忆才能跟随 DSH 工作区切换。
        // 查询串不参与路由匹配（宿主按 pathname 命中 exact 路由），旧客户端不带它照常工作。
        let cwd = '';
        try {
            cwd = new URL(req?.url ?? '/', 'http://x').searchParams.get('cwd') ?? '';
        }
        catch {
            cwd = '';
        }
        sendJson(res, 200, { ok: true, state: state(cwd) });
    });
    /* ── 设置页：注入开关 + 附属插件设置项 ── */
    route('GET', '/api/settings', (_payload, _req, res) => {
        sendJson(res, 200, { ok: true, settings: settingsState() });
    });
    route('POST', '/api/settings/injection', async (payload, _req, res) => {
        const patch = payload.injection ?? payload;
        runtime.injection = writeInjectionOverrides(patch);
        sendJson(res, 200, { ok: true, settings: settingsState() });
    });
    route('POST', '/api/settings/item', async (payload, _req, res) => {
        const id = String(payload.id ?? '').trim();
        const item = await settingsRegistry.set(id, payload.value);
        sendJson(res, 200, { ok: true, item, settings: settingsState() });
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
            // 面板与工具走同一道闸口，避免「从面板能绕过上限」。
            assertFactWithinLimit(content, config.maxFactLines ?? DEFAULT_MAX_FACT_LINES, config.maxFactBytes ?? DEFAULT_MAX_FACT_BYTES);
            writeAtomic(factPath(), ensureTrailingNewline(content));
            syncIndexAfterWrite('fact', factPath(), content);
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
        // 同一道闸口：面板也必须受项目记忆字符上限约束。
        assertProjectMemoryWithinLimit(content, config.maxProjectChars ?? DEFAULT_MAX_PROJECT_CHARS);
        writeAtomic(path, ensureTrailingNewline(content));
        syncIndexAfterWrite('memory', path, content);
        sendJson(res, 200, { ok: true, state: state() });
    });
    route('POST', '/api/journal/append', async (payload, _req, res) => {
        const text = String(payload.text ?? '').trim();
        if (text === '')
            throw new Error('日志内容不能为空');
        const tags = Array.isArray(payload.tags)
            ? payload.tags.filter((t) => typeof t === 'string' && t.trim() !== '')
            : [];
        await appendJournal(text, tags);
        sendJson(res, 200, { ok: true, state: state() });
    });
    route('POST', '/api/journal/search', async (payload, _req, res) => {
        const query = String(payload.query ?? '');
        const tag = String(payload.tag ?? '');
        const limit = Number.isFinite(payload.limit) ? Math.max(1, Math.min(200, Math.trunc(payload.limit))) : 50;
        sendJson(res, 200, { ok: true, entries: searchJournal(query, tag, limit) });
    });
    /* ── 压缩管线（P4 · 0.8.0）：状态 + 人工锁定 ── */
    const compactionState = () => compactionStatus({
        cwd: latestSessionCwd(runtime),
        enabled: config.compactionEnabled === true,
    });
    route('GET', '/api/memory/compaction', (_payload, _req, res) => {
        sendJson(res, 200, { ok: true, compaction: compactionState() });
    });
    route('POST', '/api/memory/lock', async (payload, _req, res) => {
        const id = String(payload.id ?? '').trim();
        if (id === '')
            throw new Error('需要条目 id');
        const scope = payload.scope === 'memory' || payload.scope === 'project' ? 'memory' : 'fact';
        const result = setLock(scope, id);
        if (result.ok !== true)
            throw new Error(result.reason ?? '写锁定表失败');
        sendJson(res, 200, { ok: true, key: result.key, compaction: compactionState() });
    });
    route('POST', '/api/memory/unlock', async (payload, _req, res) => {
        const id = String(payload.id ?? '').trim();
        if (id === '')
            throw new Error('需要条目 id');
        const scope = payload.scope === 'memory' || payload.scope === 'project' ? 'memory' : 'fact';
        const result = unsetLock(scope, id);
        if (result.ok !== true)
            throw new Error(result.reason ?? '写锁定表失败');
        sendJson(res, 200, { ok: true, key: result.key, removed: result.removed, compaction: compactionState() });
    });
}