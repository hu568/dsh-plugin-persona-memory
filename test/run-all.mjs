#!/usr/bin/env node
/**
 * 跨平台测试入口：收集同目录下所有 *.test.mjs，逐个用 `node` 子进程跑，最后汇总。
 *
 * 为什么要有它：仓库原生的 test/run-all.ps1 绑定 Windows + Harness Electron，
 * 在 Linux / Android(proot) 上跑不了。这个脚本只用 node 内置模块，桌面端与手机端
 * 都能一条命令跑全量；需要真实宿主包（cordis / dsh-system-prompt）的用例由
 * test/_host-paths.mjs 自动探测目录，可用 DSH_ASAR_ROOT 覆盖。
 *
 * 跑法：node test/run-all.mjs
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDeps } from './ensure-deps.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));

ensureDeps();
const files = readdirSync(testDir)
    .filter((f) => f.endsWith('.test.mjs'))
    .sort();

if (files.length === 0) {
    console.error('没有找到 *.test.mjs');
    process.exit(1);
}

const failures = [];
const results = [];
for (const file of files) {
    const name = file.replace(/\.test\.mjs$/, '');
    const started = Date.now();
    const run = spawnSync(process.execPath, [join(testDir, file)], {
        stdio: 'pipe',
        encoding: 'utf8',
        env: process.env,
    });
    const ms = Date.now() - started;
    const ok = run.status === 0;
    results.push({ name, ok, ms });
    if (!ok) failures.push({ name, out: `${run.stdout ?? ''}${run.stderr ?? ''}` });
    console.log(`${ok ? '✓' : '✗'} ${name} (${ms}ms)`);
}

console.log('');
const passed = results.filter((r) => r.ok).length;
console.log(`共 ${results.length} 个用例：通过 ${passed}，失败 ${results.length - passed}`);

if (failures.length > 0) {
    for (const f of failures) {
        console.error(`\n──── ${f.name} ────\n${f.out.trim().split('\n').slice(-25).join('\n')}`);
    }
    process.exit(1);
}
