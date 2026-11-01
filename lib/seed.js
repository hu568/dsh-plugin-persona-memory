/**
 * @dsh-external/dsh-persona-memory — 首次运行的目录种子与旧版迁移。
 *
 * 角色库为空时建 `default` 并把旧版 `memory/SOUL.md`、`USER.md` 搬进来；
 * FACT.md 不存在时写模板。失败只记日志，绝不阻断插件启动。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, factPath, memoryDir, readText, writeAtomic } from './store.js';
import { SOUL_FILE, USER_FILE, activePath, personasDir } from './paths.js';
import { guessPersonaName, scanPersonas, soulTemplate, userTemplate, writePersona } from './persona-store.js';

/**
 * FACT.md 首次创建时的模板。
 *
 * ⚠️ 本文件有**行数与字节双硬上限**（`config.maxFactLines` 默认 100 行、
 * `config.maxFactBytes` 默认 8000 字节）：模板只给骨架，别往里塞示例条目 ——
 * 每多一行都是所有项目、每一轮的固定开销。
 */
export function factTemplate() {
    return `# FACT.md — 全局长期记忆

<!-- 跨会话、跨项目的稳定事实（6 个月以上仍然成立）。由 memory 工具 scope=global 维护。
     只放「事实」，不放流水账——流水账写 JOURNAL.jsonl。
     ⚠️ 项目专属事实（换目录就不成立的）请写进项目根的 MEMORY.md，不要塞这里。
     ⚠️ 本文件有硬上限 100 行 / 8000 字节：超限写入会被 memory 工具拒绝，并提示改投项目记忆。 -->

## 关于用户

## 关于环境

## 长期约定
`;
}
/**
 * 首次运行时把目录结构补出来：
 * - 角色库为空 → 建 `default`，把旧版 `$DSH_HOME/memory/{SOUL.md,USER.md}` 的内容
 *   搬进来（存在的才有内容），旧文件保留不动。
 * - FACT.md 不存在 → 建模板。
 */
export function ensureSeed(ctx) {
    try {
        ensureDir(memoryDir());
        if (!existsSync(factPath()))
            writeAtomic(factPath(), factTemplate());
        ensureDir(personasDir());
        if (scanPersonas().length > 0)
            return;
        const legacySoul = (readText(join(memoryDir(), SOUL_FILE)) ?? '').trim();
        const legacyUser = (readText(join(memoryDir(), USER_FILE)) ?? '').trim();
        const name = guessPersonaName(legacySoul) || 'default';
        writePersona('default', {
            name,
            description: '默认角色（从旧版记忆目录迁移）',
            soul: legacySoul === '' ? soulTemplate(name) : legacySoul,
            user: legacyUser === '' ? userTemplate() : legacyUser,
        });
        if (!existsSync(activePath()))
            writeAtomic(activePath(), 'default\n');
        ctx.logger?.info?.(`[dsh-persona-memory] 已初始化角色库 ${personasDir()}` +
            (legacySoul === '' ? '' : '（迁入旧版 memory/SOUL.md 与 USER.md）'));
    }
    catch (error) {
        ctx.logger?.warn?.(`[dsh-persona-memory] 初始化失败: ${String(error)}`);
    }
}
