/**
 * @dsh-external/dsh-persona-memory — 压缩管线与宿主会话 / 模型的接线。
 *
 * 回答两个问题：① 面板 / 命令没有会话上下文时该看哪个 cwd；② 合并用哪个 provider/model。
 * 路线优先级：配置显式值 → 会话最近一次请求头 → 宿主默认模型。
 */

/** 最近一次见到的工作目录（面板/命令没有会话上下文时用来定位项目记忆）。 */
export function latestSessionCwd(runtime) {
    let latest = '';
    for (const cwd of runtime.cwdBySession.values()) {
        if (typeof cwd === 'string' && cwd !== '')
            latest = cwd;
    }
    return latest === '' ? undefined : latest;
}


export function readSessionRoute(session) {
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
export function readDefaultModelRoute(ctx) {
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
export function makeCompactCallModel(ctx, config) {
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
