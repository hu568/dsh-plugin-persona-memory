/**
 * @dsh-external/dsh-persona-memory — 设置页的注入开关覆盖层（`memory/injection.json`）。
 *
 * 覆盖层只认 persona / globalMemory / projectMemory 三个布尔键：坏文件、类型不对
 * 一律当「没设过」—— 开关只是注入的加成，不该让一次手改文件把插件炸掉。
 */
import { readText, writeAtomic } from './store.js';
import { injectionPath } from './paths.js';

/**
 * 设置页的三个注入开关。键名刻意不用 `personaEnabled` / `memoryEnabled`：
 * 那是组合配置（`cordis.patch.yml`）的字段名，而这里是它之上的用户覆盖层。
 */
export const INJECTION_FIELDS = ['persona', 'globalMemory', 'projectMemory'];
/**
 * 读设置页的覆盖层。文件不存在 / 坏掉 / 类型不对都当作「没设过」：
 * 开关只是注入的加成，绝不该让一次手改文件把整个插件炸掉。
 */
export function readInjectionOverrides() {
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
export function writeInjectionOverrides(patch) {
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
export function injectionFlags(config, runtime) {
    const overrides = runtime.injection ?? {};
    return {
        persona: overrides.persona ?? config.personaEnabled,
        globalMemory: overrides.globalMemory ?? config.memoryEnabled,
        projectMemory: overrides.projectMemory ?? config.memoryEnabled,
    };
}
