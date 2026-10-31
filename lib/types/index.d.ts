import z from 'schemastery';
import type { Context } from 'cordis';
/** Cordis 插件名。 */
export declare const name = "@dsh-external/dsh-persona-memory";
/** 宿主服务依赖：提示词注册表 + 工具注册表（本部署两者恒在）。 */
export declare const inject: string[];
/**
 * 注入作用域。
 *
 * - `full`（主会话）：角色设定 + 全局记忆 + 项目记忆。
 * - `project`（子代理会话）：**只**注入项目记忆。
 */
export declare const INJECT_FULL = "full";
export declare const INJECT_PROJECT_ONLY = "project";
export interface Config {
    /** 注入角色设定（SOUL/USER）。 */
    personaEnabled: boolean;
    /** 注入记忆（FACT.md / 项目 MEMORY.md）。 */
    memoryEnabled: boolean;
    /** 子代理会话是否只注入项目记忆（关掉即恢复「子代理与主会话注入相同内容」）。 */
    subagentProjectOnly: boolean;
    /** 单文件注入字符上限。 */
    maxChars: number;
    /** 全局 FACT.md 的行数硬上限（`action=update, scope=global` 与面板写入都受它约束）。 */
    maxFactLines: number;
    /** 全局 FACT.md 的字节硬上限（UTF-8；与 `maxFactLines` 同时生效，任一超限即拒写）。 */
    maxFactBytes: number;
    /** 项目 MEMORY.md 的字符硬上限（`action=update, scope=project` 与面板写入都受它约束）。 */
    maxProjectChars: number;
    /**
     * 压缩管线总开关（0.8.0 · P4）：**默认 false**。
     *
     * 关闭时写入路径与 0.7.0 逐字节相同；打开后写入前水位 ≥85% 会先合并/淘汰。
     */
    compactionEnabled: boolean;
    /** 合并用的 provider（空 ⇒ 不做 LLM 合并，只走淘汰那一层）。 */
    compactProvider: string;
    /** 合并用的 model（空 ⇒ 同上）。 */
    compactModel: string;
    /** 压缩备份保留份数。 */
    compactKeepBackups: number;
    /** 右侧栏面板的 HTTP 前缀。 */
    panelPath: string;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, rawConfig: unknown): void;

/** 生效的注入开关（用户覆盖层优先，没设过回落到组合配置）。 */
export interface InjectionFlags {
    /** 注入角色设定（SOUL.md / USER.md）。 */
    persona: boolean;
    /** 注入全局记忆（FACT.md）。 */
    globalMemory: boolean;
    /** 注入项目记忆（项目根 MEMORY.md）。 */
    projectMemory: boolean;
}
/** 设置页支持的四类声明式控件。 */
export type SettingsItemKind = 'toggle' | 'select' | 'text' | 'readonly';
export interface SettingsItemOption {
    value: string | number;
    label: string;
}
/**
 * 附属插件注册到「记忆」设置页的一项。
 *
 * 只接受 JSON 可表达的数据：宿主会把它序列化进 `/persona-memory/api/settings`
 * 返回给页面。取值怎么存、变更后做什么，全由注册方的 `onChange` 决定。
 */
export interface PluginSettingsItem {
    /** 唯一 id（建议 `<插件名>:<项>`，如 `recall.enabled`）。 */
    id: string;
    /** 行标题。 */
    title: string;
    /** 行说明。 */
    description?: string;
    /** 补充提示（琥珀色）。 */
    note?: string;
    /** 分组标题，默认「附属插件」。 */
    group?: string;
    /** 控件类型，默认 `toggle`。 */
    kind?: SettingsItemKind;
    /** 当前值；类型必须与 `kind` 匹配。 */
    value: boolean | string | number;
    /** `kind=select` 的候选项（必填且非空）。 */
    options?: SettingsItemOption[];
    /** `kind=text` 的占位文案。 */
    placeholder?: string;
    /** 组内排序，小的在前，默认 1000。 */
    order?: number;
    /** 页面回写时调用；抛错则页面保留旧值并把错误显示出来。 */
    onChange?: (value: boolean | string | number) => void | Promise<void>;
}
/** `settings.register()` 返回的句柄。 */
export interface PluginSettingsItemHandle {
    readonly id: string;
    get(): boolean | string | number;
    /** 程序化写入：等价于页面回写（会触发 `onChange`）。 */
    set(value: boolean | string | number): Promise<boolean | string | number>;
    /** 只同步展示信息/值，不触发 `onChange`。 */
    update(patch: Partial<Omit<PluginSettingsItem, 'id' | 'kind' | 'onChange'>>): void;
    /** 从设置页移除该项（随注册方 fiber 卸载时也应调用）。 */
    dispose(): void;
}
/**
 * 宿主服务 `ctx.personaMemory`。
 *
 * 用 `ctx.get('personaMemory')` 或在 `ctx.inject(['personaMemory'], …)` 里拿；
 * 注册项需要自己负责回收：`ctx.effect(() => () => handle.dispose())`。
 */
export interface PersonaMemoryService {
    readonly version: 1;
    readonly settings: {
        register(item: PluginSettingsItem): PluginSettingsItemHandle;
        list(): ReadonlyArray<Omit<PluginSettingsItem, 'onChange'>>;
        has(id: string): boolean;
        set(id: string, value: boolean | string | number): Promise<Omit<PluginSettingsItem, 'onChange'>>;
    };
    readonly injection: {
        get(): InjectionFlags;
        /** 合并写入 `$DSH_HOME/memory/injection.json`，返回生效后的开关。 */
        set(patch: Partial<InjectionFlags>): InjectionFlags;
    };
}
declare module 'cordis' {
    interface Context {
        personaMemory: PersonaMemoryService;
    }
}
