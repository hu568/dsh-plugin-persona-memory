/**
 * @dsh-external/dsh-persona-memory — 路径、文件名常量与写文件小工具。
 *
 * 角色库、记忆目录、快照与注入开关的落点都在这里；只依赖 ./store.js 的
 * `dshHome()` / `memoryDir()`。别处一律从这里取路径，避免同一条路径写两遍。
 */
import { join } from 'node:path';
import { dshHome, memoryDir } from './store.js';

export const PERSONA_FILE = 'persona.yml';
export const SOUL_FILE = 'SOUL.md';
export const USER_FILE = 'USER.md';
export const ACTIVE_FILE = '.active';
export const ORDER_FILE = '.personas-order';
/** 设置页的注入开关（覆盖组合配置里的默认值）。 */
export const INJECTION_FILE = 'injection.json';
/* ────────────────────────────── 路径与文件 ────────────────────────────── */
export function personasDir() {
    return join(dshHome(), 'personas');
}
export function snapshotsDir() {
    return join(memoryDir(), 'snapshots');
}
export function activePath() {
    return join(personasDir(), ACTIVE_FILE);
}
export function orderPath() {
    return join(personasDir(), ORDER_FILE);
}
export function injectionPath() {
    return join(memoryDir(), INJECTION_FILE);
}
export function ensureTrailingNewline(text) {
    return text.endsWith('\n') ? text : `${text}\n`;
}
