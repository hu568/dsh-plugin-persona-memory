/**
 * @dsh-external/dsh-persona-memory — 角色库（`$DSH_HOME/personas`）的读写与模板。
 *
 * persona.yml 的解析刻意只做最小实现（只要 `name` / `description` 两个标量），
 * 不引 YAML 解析器：角色库是本地文件，格式由本插件自己写出来。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ensureDir, readText, writeAtomic } from './store.js';
import { PERSONA_FILE, SOUL_FILE, USER_FILE, activePath, ensureTrailingNewline, orderPath, personasDir } from './paths.js';

/** 极简 persona.yml 解析：只要顶层 `name` / `description` 两个标量。 */
export function parsePersonaYml(raw) {
    let name = '';
    let description = '';
    for (const line of raw.split(/\r?\n/)) {
        const match = /^(name|description)\s*:\s*(.*)$/.exec(line);
        if (match === null)
            continue;
        const value = match[2].trim().replace(/^["']/, '').replace(/["']$/, '');
        if (match[1] === 'name')
            name = value;
        else
            description = value;
    }
    return { name, description };
}
/** 写成单行可安全解析的 YAML 标量。 */
export function yamlScalar(value) {
    const oneLine = value.replace(/\s*\r?\n\s*/g, ' ').trim();
    const plain = !/^[\s>|&*!%@`"'#-]|:\s|:\s*$/.test(oneLine);
    return plain ? oneLine : JSON.stringify(oneLine);
}
export function personaYmlText(name, description) {
    return `name: ${yamlScalar(name)}\ndescription: ${yamlScalar(description)}\n`;
}
/**
 * 识别一个目录是不是角色：必须有 persona.yml，而且**必须位于角色库之下**。
 *
 * 0.9.0 · P1-9：`isPersonaDir(join(personasDir(), id))` 过去只看
 * `<dir>/persona.yml` 存不存在 ⇒ `id = '../x'` 时能通过；`delete` 随后对
 * 同一个路径 `rmSync(recursive)`，一次手滑就删到角色库之外。这里在 resolve 之后
 * 强制做前缀检查（双保险：调用方也校验 id 形态）。失败一律 false，绝不抛错。
 */
export function isPersonaDir(dir) {
    try {
        const root = resolve(personasDir());
        const full = resolve(dir);
        if (full === root || !full.startsWith(root + sep))
            return false;
        return statSync(join(full, PERSONA_FILE)).isFile();
    }
    catch {
        return false;
    }
}
export function readOrder() {
    const raw = readText(orderPath());
    if (raw === null)
        return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed))
            return parsed.filter((item) => typeof item === 'string');
    }
    catch {
        /* 坏文件当没有排序 */
    }
    return [];
}
/** 扫描角色库并按 `.personas-order` 排序（未列出的按名称排最后）。 */
export function scanPersonas() {
    const dir = personasDir();
    let names;
    try {
        names = readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => String(entry.name));
    }
    catch {
        return [];
    }
    const found = [];
    for (const id of names) {
        const full = join(dir, id);
        if (!isPersonaDir(full))
            continue;
        const meta = parsePersonaYml(readText(join(full, PERSONA_FILE)) ?? '');
        found.push({ id, name: meta.name || id, description: meta.description });
    }
    const order = readOrder();
    const rank = new Map(order.map((id, index) => [id, index]));
    return found.sort((a, b) => {
        const ra = rank.get(a.id);
        const rb = rank.get(b.id);
        if (ra !== undefined && rb !== undefined)
            return ra - rb;
        if (ra !== undefined)
            return -1;
        if (rb !== undefined)
            return 1;
        return a.name.localeCompare(b.name, 'zh');
    });
}
export function activePersonaId() {
    const list = scanPersonas();
    const raw = (readText(activePath()) ?? '').trim();
    if (raw !== '' && list.some((persona) => persona.id === raw))
        return raw;
    const fallback = list.find((persona) => persona.id === 'default') ?? list[0];
    return fallback?.id ?? '';
}
export function readPersona(id) {
    const dir = join(personasDir(), id);
    if (!isPersonaDir(dir))
        return null;
    const meta = parsePersonaYml(readText(join(dir, PERSONA_FILE)) ?? '');
    return {
        id,
        name: meta.name || id,
        description: meta.description,
        soul: (readText(join(dir, SOUL_FILE)) ?? '').trim(),
        user: (readText(join(dir, USER_FILE)) ?? '').trim(),
    };
}
export function validPersonaId(id) {
    return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}
export function writePersona(id, fields) {
    const dir = join(personasDir(), id);
    ensureDir(dir);
    const current = readPersona(id);
    const name = fields.name ?? current?.name ?? id;
    const description = fields.description ?? current?.description ?? '';
    writeAtomic(join(dir, PERSONA_FILE), personaYmlText(name, description));
    if (fields.soul !== undefined)
        writeAtomic(join(dir, SOUL_FILE), ensureTrailingNewline(fields.soul));
    else if (!existsSync(join(dir, SOUL_FILE)))
        writeAtomic(join(dir, SOUL_FILE), soulTemplate(name));
    if (fields.user !== undefined)
        writeAtomic(join(dir, USER_FILE), ensureTrailingNewline(fields.user));
    else if (!existsSync(join(dir, USER_FILE)))
        writeAtomic(join(dir, USER_FILE), userTemplate());
}
export function soulTemplate(personaName) {
    return `# SOUL.md — ${personaName}

## Identity
（这个角色是谁：身份、背景、定位，2-3 句）

## Personality
- （3-5 个特质，每个都写到「如何体现在对话里」）

## Tone
- （语气、语言风格、回复长度偏好）

## Principles
- 永远（原则）
- 绝不（原则）

## Communication Style
- 称呼用户为（形式）
- （emoji / 格式偏好）

## Boundaries
- 不做（边界）
- 避免（边界）
`;
}
export function userTemplate() {
    return `# USER.md — 用户档案

## 基本信息
- 称呼：
- 语言偏好：
- 沟通风格：

## 偏好
- 格式偏好：
- 其他：
`;
}
/* ────────────────────────────── 记忆（全局 / 项目 / 日志） ────────────────────────────── */
/** 从 SOUL.md 里猜一个展示名：优先 `# SOUL.md — 名字`，否则取「我叫**X**」。 */
export function guessPersonaName(soul) {
    const heading = /^#\s*SOUL\.md\s*[—\-–]\s*(.+)$/m.exec(soul);
    if (heading !== null)
        return heading[1].trim();
    const called = /我叫\**\s*([^\s*，,。]+)/.exec(soul);
    if (called !== null)
        return called[1].trim();
    return '';
}
/* ─────────────────────── 设置页：附属插件设置项注册表 ─────────────────────── */
