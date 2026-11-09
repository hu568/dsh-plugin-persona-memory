/**
 * 回归测试：备份分家（0.9.0 · P1-4）。
 *
 * 背景：条目级备份（`<file>-<yyyyMMdd-HHmmssSSS>.bak`，每次 insert/replace/delete/
 * 整篇写都一份，**从不修剪**）与压缩备份（`<file>-<yyyyMMdd-HHmmss>.bak`，秒级戳）
 * 过去混在同一个 `memory/backups/`。压缩侧的 `pruneBackups()` 按「文件名前缀 + 字符串
 * 排序」只留 5 份，条目级备份写得勤就会把压缩备份挤掉 ⇒ `/memory-compact rollback`
 * 返回「备份文件已不在」，撤销能力在真实使用频率下不可靠。
 *
 * 本测试钉住：
 *  1. store 的自动备份写 `memory/backups/auto/`，并只保留 N 份（`autoBackupKeep`）；
 *  2. 压缩备份仍在 `memory/backups/` 根；
 *  3. 压缩侧修剪**不碰** auto 目录，也不删老版本留在根目录的毫秒戳条目级备份；
 *  4. 大量条目级写入后，压缩备份仍然存在（rollback 能命中）。
 *
 * 跑法：node test/backup-split.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-backup-'));
process.env.DSH_HOME = home;

const store = await import('../lib/store.js');
const compaction = await import('../lib/compaction.js');

const factFile = store.factPath();
const backupsRoot = join(store.memoryDir(), 'backups');
const autoDir = join(backupsRoot, 'auto');
mkdirSync(store.memoryDir(), { recursive: true });
writeFileSync(factFile, '# FACT.md — 全局\n\n## 关于环境\n\n- 初始一条\n', 'utf8');

const failures = [];
let checks = 0;
async function check(label, fn) {
    checks += 1;
    try {
        await fn();
        console.log(`PASS ${label}`);
    }
    catch (error) {
        failures.push(label);
        console.log(`FAIL ${label}\n      ${String(error?.message ?? error).split('\n').join('\n      ')}`);
    }
}
const autoNames = () => {
    try {
        return readdirSync(autoDir).filter((name) => name.startsWith('FACT.md-') && name.endsWith('.bak'));
    }
    catch {
        return [];
    }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await check('store 自动备份落在 memory/backups/auto/，且只保留 autoBackupKeep 份', async () => {
    store.configureStore({ autoBackupKeep: 3, compactionEnabled: false });
    for (let index = 0; index < 6; index += 1) {
        const result = await store.insertEntry('fact', `条目 ${index}`);
        assert.equal(result.written, true, JSON.stringify(result));
        await sleep(3); // 时间戳毫秒定宽，避免同一毫秒内互相覆盖干扰计数
    }
    assert.equal(store.autoBackupsDir(), autoDir, 'autoBackupsDir() 应指向 backups/auto');
    const names = autoNames();
    assert.equal(names.length, 3, `auto 目录应只保留 3 份，实际 ${names.length}`);
    // 根目录里不应再出现 store 写的毫秒戳备份
    const rootMs = readdirSync(backupsRoot).filter((name) => /-\d{8}-\d{9}\.bak$/.test(name));
    assert.deepEqual(rootMs, [], `backups 根不应再有条目级毫秒戳备份：${rootMs.join(',')}`);
});

await check('压缩备份仍在 backups 根，且 rollback 能在大量条目级写入后命中', async () => {
    const raw = '# FACT.md — 全局\n\n## 关于环境\n\n- 压缩前一条\n';
    writeFileSync(factFile, raw, 'utf8');
    const backup = compaction.writeBackup(factFile, raw, 5);
    assert.ok(backup !== null, '压缩备份应写成功');
    assert.equal(join(backupsRoot, backup.split(/[\\/]/).pop()), backup, '压缩备份必须在 backups 根');
    assert.ok(existsSync(backup));

    // 制造更多条目级备份（最多保留 3 份，但压缩备份不该被它们影响）
    for (let index = 0; index < 5; index += 1) {
        await store.insertEntry('fact', `补充条目 ${index}`);
        await sleep(3);
    }
    assert.ok(existsSync(backup), '条目级写入不得删掉压缩备份');
});

await check('压缩侧 pruneBackups 不删 auto 目录里的文件', async () => {
    const before = autoNames().sort();
    assert.ok(before.length > 0, '前置：auto 里应有备份');
    compaction.pruneBackups('FACT.md', 1);
    assert.deepEqual(autoNames().sort(), before, '压缩侧修剪只该管 backups 根');
});

await check('老版本留在根目录的毫秒戳条目级备份也不归压缩侧修剪', async () => {
    const legacy = join(backupsRoot, 'FACT.md-20261109-120000123.bak');
    writeFileSync(legacy, '老版本留下的条目级备份\n', 'utf8');
    compaction.pruneBackups('FACT.md', 1);
    assert.ok(existsSync(legacy), '过滤条件应排除毫秒戳（9 位）文件名');
});

store.configureStore({});
rmSync(home, { recursive: true, force: true });
if (failures.length > 0) {
    console.log(`\n✗ backup-split: ${failures.length} 项失败 / 共 ${checks} 项：${failures.join('、')}`);
    process.exit(1);
}
console.log(`\n✓ backup-split: ${checks} 项全部通过`);
