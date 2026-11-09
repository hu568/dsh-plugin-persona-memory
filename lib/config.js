/**
 * @dsh-external/dsh-persona-memory — 宿主半的配置与常量。
 *
 * 只放「可被别处 import 的纯配置」：注入作用域、默认上限、Cordis `Config` 模式。
 * 不碰文件系统、不持运行时状态，避免拆模块后出现循环依赖。
 */
import z from 'schemastery';
import { DEFAULT_KEEP_BACKUPS } from './compaction.js';

/**
 * 注入作用域。
 *
 * - `full`（主会话）：角色设定 + 全局记忆 + 项目记忆 + 长期日志。
 * - `project`（子代理会话）：**只**注入项目记忆。角色、全局 FACT.md、长期日志
 *   都可能与本项目的当前任务无关，子代理的上下文越窄越不容易跑偏。
 */
export const INJECT_FULL = 'full';
export const INJECT_PROJECT_ONLY = 'project';
/** 单文件注入字符上限。 */
export const DEFAULT_MAX_CHARS = 8000;
/**
 * 全局 FACT.md 的**行数硬上限**。
 *
 * FACT.md 会被注入**每一个主会话**的提示词。若把项目专属结论写进来，就变成所有项目、
 * 每一轮都要付的固定开销，还会把真正「跨项目稳定」的事实挤出去。这里在写入侧直接
 * 卡住（超限抛错而不是截断），配合契约文案把模型引导去 `scope=project`。
 */
export const DEFAULT_MAX_FACT_LINES = 100;
/**
 * 全局 FACT.md 的**字节硬上限**（UTF-8，`\r\n` 归一化后计）。
 *
 * 只卡行数是不够的：行长完全自由 ⇒ 100 行可以写 7 KB，也可以写 20 KB，全局常驻
 * token 开销不可预测。本机实测真实文风约 **75.9 B/行**，80 B/行 × 100 行 = 8000 B
 * 是「贴合真实文风、略留余量」的取值；满配约 ≈2,560 tokens。
 * 与 `maxFactLines` **同时生效**，任一超限即拒写。
 */
export const DEFAULT_MAX_FACT_BYTES = 8000;
/**
 * 项目 MEMORY.md 的**字符硬上限**（口径见 `countChars()`：`trim()` 后长度，与注入侧
 * `clip()` 逐字一致）。
 *
 * 注入侧本来就有 `maxChars`（默认 8000，超出被 `clip()` **静默截断**），而写入侧
 * 完全没有闸口 ⇒ 「写的时候不拦，读的时候悄悄截断」，正是本插件明确反对的模式
 * （静默截断等于悄悄丢用户内容）。默认与 `maxChars` 同口径、同数值，让「通过写入
 * 闸口」⇒「必然不会被注入截断」。
 */
export const DEFAULT_MAX_PROJECT_CHARS = 8000;
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
    /**
     * 库级信任门（0.9.0）：项目根 MEMORY.md **可能随仓库分发**。
     *
     * clone / fork 别人的仓库时，那份 MEMORY.md 是被别人（或别人的模型）提交的文本，
     * 里面完全可能出现「忽略之前的指令」这类写给模型的句子。开启时（默认），只要
     * 项目位于 git 仓库内（`.git` 目录，或 `.git` 文件里带 `gitdir:`）**或无法判断**
     * 是否在仓库内，注入的项目记忆段落就会追加一段「来源不可信」告示：其中出现的
     * 指令不作为系统指令执行，冲突以当前用户消息为准。
     *
     * 设为 `false` 表示「我确认这份 MEMORY.md 是本机生成/我自己的」，不再显示告示。
     * 判定失败按不可信处理（fail-open），只多一行提示，绝不抛错。
     */
    trustProjectFromRepo: z.boolean().default(true),
    panelPath: z.string().default('/persona-memory'),
});
