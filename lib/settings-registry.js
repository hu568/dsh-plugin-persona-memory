/**
 * @dsh-external/dsh-persona-memory — 设置页「记忆」分组的扩展点。
 *
 * 附属插件（如 dsh-persona-memory-recall）通过宿主服务 `ctx.personaMemory.settings`
 * 注册声明式设置项；本模块只管校验、排序与回写，不关心值存在哪、变更后做什么。
 */

/**
 * 设置页的扩展点。附属插件（如 `dsh-persona-memory-recall`）通过宿主服务
 * `ctx.personaMemory.settings.register(item)` 注册一行声明式设置项，页面只负责
 * 渲染与回写；取值怎么存、变更后做什么，全由注册方自己决定。
 *
 * 只支持四种 JSON 可表达的控件：`toggle` / `select` / `text` / `readonly`。
 * 需要完整自定义界面的插件走客户端槽 `settings.persona-memory.item`。
 */
export const SETTINGS_ITEM_KINDS = new Set(['toggle', 'select', 'text', 'readonly']);
export const SETTINGS_ITEM_DEFAULT_GROUP = '附属插件';
export function isOptionValue(value) {
    return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}
/** 校验并归一化一个设置项的值；不合法返回 null（调用方决定报什么错）。 */
export function normalizeSettingsValue(kind, value) {
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
export function normalizeSettingsOptions(raw) {
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
export function createSettingsRegistry() {
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
