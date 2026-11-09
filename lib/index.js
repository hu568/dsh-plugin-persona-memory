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
import { Config, INJECT_FULL, INJECT_PROJECT_ONLY } from './config.js';
import { configureCompactor, configureStore, memoryDir } from './store.js';
import { personasDir } from './paths.js';
import { injectionFlags, readInjectionOverrides, writeInjectionOverrides } from './injection.js';
import { createSettingsRegistry } from './settings-registry.js';
import { ensureSeed } from './seed.js';
import { isSubagent, liveSnapshot, snapshotFor } from './snapshot.js';
import { renderFacts, renderPersona } from './prompt-render.js';
import { memoryTool, personaTool } from './tools.js';
import { latestSessionCwd, makeCompactCallModel } from './compaction-wiring.js';
import { workspaceIdFor } from './workspace.js';
import { runCompaction, runCompactCommand } from './compact-command.js';
import { registerPanelRoutes } from './panel.js';

export { Config, INJECT_FULL, INJECT_PROJECT_ONLY };

/** Cordis 插件名。 */
export const name = '@dsh-external/dsh-persona-memory';
/** 宿主服务依赖：提示词注册表 + 工具注册表（本部署两者恒在）。 */
export const inject = ['systemPrompt', 'tools'];
/* ────────────────────────────── 主入口 ────────────────────────────── */
export function apply(ctx, rawConfig) {
    const config = Config(rawConfig ?? {});
    // 上限只配一次：store 的闸口/水位/条目写入都从这里读（附属插件拿不到本插件的配置）。
    // 0.9.0 · P1-8：顺带注入 logger —— 写前压缩失败过去被 catch 完全吞掉，用户只看到
    // 「超限」。store 只读 `logger.warn`，拿不到就静默，绝不成为写路径的新故障点。
    configureStore({ ...config, logger: ctx.logger });
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
    configureCompactor((scope, options) => runCompaction(scope, options, config, compactRuntime), { logger: ctx.logger });
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
