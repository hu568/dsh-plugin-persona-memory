/**
 * @dsh-external/dsh-persona-memory — 会话注入快照。
 *
 * 会话**首条用户消息**时把角色 + 记忆固化成本会话快照（落盘让 resume/重启语义不变），
 * 之后每轮读快照而不是读盘，KV 缓存前缀因此稳定；首条消息之前读盘实时渲染。
 */
import { join } from 'node:path';
import { DEFAULT_JOURNAL_LIMIT, factPath, findProjectMemory, readJournal, readText, writeAtomic } from './store.js';
import { snapshotsDir } from './paths.js';
import { activePersonaId, readPersona } from './persona-store.js';

export function sessionEvents(session) {
    if (session === undefined)
        return [];
    if (typeof session.snapshotEvents === 'function')
        return session.snapshotEvents();
    return session.events ?? [];
}
export function hasUserMessage(session) {
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
export function isSubagent(session) {
    const header = session?.header;
    if (header === undefined || header === null)
        return false;
    if (header.origin === 'subagent')
        return true;
    if (typeof header.parentSession === 'string' && header.parentSession !== '')
        return true;
    return typeof header.delegationDepth === 'number' && header.delegationDepth > 0;
}
export function buildSnapshot(sessionId, cwd, config, runtime) {
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
export function snapshotFor(agent, config, runtime) {
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
export function liveSnapshot(sessionId, cwd, config, runtime) {
    return buildSnapshot(sessionId, cwd, config, runtime);
}
