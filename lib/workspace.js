/**
 * @dsh-external/dsh-persona-memory — 工作区注册表与项目记忆发现。
 *
 * 读 `$DSH_HOME/storages/workspace.json`：① 会话 cwd → workspaceId（压缩保护区要用）；
 * ② 全部已登记工作区路径（面板要显示还没跑过会话的项目）。坏文件一律当空。
 */
import { join, resolve as resolvePath } from 'node:path';
import { PROJECT_MEMORY_FILE, dshHome, findProjectMemory, readText } from './store.js';

/**
 * 会话 cwd → workspaceId（读宿主工作区注册表 `$DSH_HOME/storages/workspace.json`）。
 *
 * 只用于一件事：**当前工作区的 project 条目不许被自动淘汰**（PLAN/01 §4.4 保护区）。
 * 注册表读不到（不同版本/手改成坏 JSON）就返回 undefined —— 那时保护区只靠
 * 锁定 / `<!-- keep -->` / 元数据，绝不因为拿不到上下文而放宽淘汰。
 */
export function workspaceIdFor(cwd) {
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

/**
 * DSH 工作区注册表里的全部路径（`$DSH_HOME/storages/workspace.json` 的
 * `tables.workspaces[*].path`）。坏文件 / 旧版本没有该字段 ⇒ 空数组。
 *
 * 面板要跟着工作区切换，只看"本进程见过的会话 cwd"是不够的：刚重启、还没跑过
 * 会话的工作区不会出现在列表里。这里读注册表补全，用法与 `workspaceIdFor()` 同源。
 */
export function registeredWorkspacePaths() {
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
export function projectEntryFor(cwd) {
    if (typeof cwd !== 'string' || cwd.trim() === '')
        return null;
    const found = findProjectMemory(cwd);
    if (found !== null)
        return found;
    const root = resolvePath(cwd);
    return { root, path: join(root, PROJECT_MEMORY_FILE), exists: false, content: '' };
}
