import z from 'schemastery';
import type { Context } from 'cordis';
/** Cordis 插件名。 */
export declare const name = "@dsh-external/dsh-persona-memory";
/** 宿主服务依赖：提示词注册表 + 工具注册表（本部署两者恒在）。 */
export declare const inject: string[];
/**
 * 注入作用域。
 *
 * - `full`（主会话）：角色设定 + 全局记忆 + 项目记忆 + 长期日志。
 * - `project`（子代理会话）：**只**注入项目记忆。
 */
export declare const INJECT_FULL = "full";
export declare const INJECT_PROJECT_ONLY = "project";
export interface Config {
    /** 注入角色设定（SOUL/USER）。 */
    personaEnabled: boolean;
    /** 注入记忆（FACT.md / 项目 MEMORY.md / JOURNAL）。 */
    memoryEnabled: boolean;
    /** 注入最近日志条目。 */
    journalEnabled: boolean;
    /** 子代理会话是否只注入项目记忆（关掉即恢复「子代理与主会话注入相同内容」）。 */
    subagentProjectOnly: boolean;
    /** 单文件注入字符上限。 */
    maxChars: number;
    /** 日志扫描行上限。 */
    journalLimit: number;
    /** 注入最近日志条数。 */
    journalInject: number;
    /** 右侧栏面板的 HTTP 前缀。 */
    panelPath: string;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, rawConfig: unknown): void;
