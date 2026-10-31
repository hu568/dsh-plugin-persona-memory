/**
 * @dsh-external/dsh-persona-memory — 人工锁定表（压缩管线的保护区）。
 *
 * 落盘：`$DSH_HOME/memory/locks.json`
 *
 * ```json
 * { "version": 1, "entries": { "fact:<id>": { "locked": true, "at": 1793416415938 } } }
 * ```
 *
 * ⚠️ **只有这里有发言权**：`★` 开头的行不是人工标记（01 §4.4 更正 —— 几乎所有
 * MEMORY.md 都是模型自己写的，`★` 只是它表达"重要"的语气），绝不能当免死金牌。
 * 压缩管线的保护区只认两样：本文件里的显式锁定，和正文里的 `<!-- keep -->`。
 *
 * 读失败 / 坏文件一律当"没有锁定"，**永不抛错**：锁定表是压缩的加成，
 * 不该因为一次手改文件把写路径炸掉。
 */
import { join } from 'node:path';
import { ensureDir, memoryDir, readText, writeAtomic } from './store.js';

const LOCKS_FILE = 'locks.json';

/** 锁定表路径：`$DSH_HOME/memory/locks.json`。 */
function locksPath() {
    return join(memoryDir(), LOCKS_FILE);
}

/** 作用域归一化：`global`→`fact`、`project`→`memory`（与 store 同口径）。 */
function normalizeLockScope(scope) {
    const raw = String(scope ?? '').trim().toLowerCase();
    if (raw === 'fact' || raw === 'global')
        return 'fact';
    if (raw === 'memory' || raw === 'project')
        return 'memory';
    return raw;
}

/** 锁定键：`<scope>:<id>`。 */
function lockKey(scope, id) {
    return `${normalizeLockScope(scope)}:${String(id ?? '').trim()}`;
}

function emptyLocks() {
    return { version: 1, entries: {} };
}

/**
 * 读锁定表：缺失 / 损坏 / 版本不认识 / 结构不对 ⇒ 空表（**绝不抛错**）。
 * 只保留结构合法的记录，手改坏的单个条目不影响其余条目。
 */
function readLocks() {
    const raw = readText(locksPath());
    if (raw === null)
        return emptyLocks();
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1)
            return emptyLocks();
        const source = parsed.entries;
        if (source === null || typeof source !== 'object' || Array.isArray(source))
            return emptyLocks();
        const entries = {};
        for (const [key, value] of Object.entries(source)) {
            if (typeof key !== 'string' || key === '')
                continue;
            if (value === null || typeof value !== 'object' || Array.isArray(value))
                continue;
            if (value.locked !== true)
                continue;
            entries[key] = {
                locked: true,
                at: typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : null,
            };
        }
        return { version: 1, entries };
    }
    catch {
        return emptyLocks();
    }
}

/** 原子写锁定表（临时文件 + rename）。失败返回 false，不抛错。 */
function writeLocks(data) {
    try {
        ensureDir(memoryDir());
        writeAtomic(locksPath(), `${JSON.stringify(data, null, 2)}\n`);
        return true;
    }
    catch {
        return false;
    }
}

/** 拍平视图：`[{key, scope, id, at}]`（按 scope、id 排序，便于面板稳定渲染）。 */
function listLocks(scope) {
    const wanted = scope === undefined || scope === null || String(scope).trim() === ''
        ? null
        : normalizeLockScope(scope);
    const entries = readLocks().entries;
    const out = [];
    for (const [key, value] of Object.entries(entries)) {
        const separator = key.indexOf(':');
        const entryScope = separator < 0 ? '' : key.slice(0, separator);
        const id = separator < 0 ? key : key.slice(separator + 1);
        if (wanted !== null && entryScope !== wanted)
            continue;
        out.push({ key, scope: entryScope, id, at: value.at });
    }
    return out.sort((a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id));
}

/** 是否已锁定（读不到/坏文件 ⇒ false）。 */
function isLocked(scope, id) {
    const key = lockKey(scope, id);
    if (key.endsWith(':'))
        return false;
    return readLocks().entries[key] !== undefined;
}

/**
 * 锁定一条：返回 `{ok, key, locks}`。id 为空 ⇒ `{ok:false, reason}`（不写盘）。
 * `at` 由调用方给（默认当前时间），面板与命令行都用同一个字段做审计。
 */
function setLock(scope, id, options = {}) {
    const key = lockKey(scope, id);
    if (key.endsWith(':'))
        return { ok: false, reason: '缺少条目 id', key, locks: listLocks() };
    const data = readLocks();
    const at = Number.isFinite(options?.at) ? Number(options.at) : Date.now();
    data.entries[key] = { locked: true, at };
    const written = writeLocks(data);
    return { ok: written, key, at, locks: listLocks() };
}

/** 解锁一条：返回 `{ok, key, removed, locks}`。本来就没锁也返回 `ok:true`。 */
function unsetLock(scope, id) {
    const key = lockKey(scope, id);
    if (key.endsWith(':'))
        return { ok: false, reason: '缺少条目 id', key, removed: false, locks: listLocks() };
    const data = readLocks();
    const removed = data.entries[key] !== undefined;
    if (removed)
        delete data.entries[key];
    const written = removed ? writeLocks(data) : true;
    return { ok: written, key, removed, locks: listLocks() };
}

export { isLocked, lockKey, locksPath, listLocks, normalizeLockScope, readLocks, setLock, unsetLock };
