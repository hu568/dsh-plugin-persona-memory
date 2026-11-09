/**
 * 项目记忆的「首次写入即创建」（0.8.6）。
 *
 * 旧行为：`validateEntry('memory', …)` 要求 cwd 下（或上层）**已经存在** MEMORY.md，
 * 否则判「对不上项目根」→ 降级 JOURNAL。后果是新鲜工作区永远长不出项目记忆，
 * 自动沉淀再好也白搭。新行为：cwd 就是项目根，文件不存在时首条写入创建它；
 * 仍然拒绝空 cwd / home / 根目录。
 *
 * 跑法：node test/project-bootstrap.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'persona-memory-bootstrap-'));
process.env.DSH_HOME = home;
const store = await import('../lib/store.js');

const projectDir = join(home, 'fresh-workspace');
const projectMemory = join(projectDir, 'MEMORY.md');

try {
    /* 1. 没有 MEMORY.md 也能首次写入（并真的创建文件） */
    assert.equal(existsSync(projectMemory), false, '前置：目录里本来没有 MEMORY.md');
    const first = await store.insertEntry('memory', '新结论进项目记忆', { cwd: projectDir });
    assert.equal(first.written, true, '首次写入必须成功，而不是降级 JOURNAL');
    assert.equal(first.target, projectMemory, '落点是 cwd/MEMORY.md');
    assert.equal(existsSync(projectMemory), true, '文件应被创建');
    assert.ok(readFileSync(projectMemory, 'utf8').includes('新结论进项目记忆'));

    /* 2. 第二条继续进同一个文件（不会另起炉灶） */
    const second = await store.insertEntry('memory', '依赖用 tarball 装', { cwd: join(projectDir, 'sub') });
    assert.equal(second.written, true);
    assert.equal(second.target, projectMemory, '子目录写入要命中已存在的项目根');
    const text = readFileSync(projectMemory, 'utf8');
    assert.ok(text.includes('新结论进项目记忆') && text.includes('依赖用 tarball 装'));

    /* 3. 空 cwd / home / 根目录仍然拒绝（避免把记忆写到奇怪的地方） */
    const empty = store.validateEntry('memory', '没有 cwd 的条目', { cwd: '' });
    assert.equal(empty.ok, false);
    assert.equal(empty.demote, 'journal');

    const asHome = store.validateEntry('memory', 'home 不是项目根', { cwd: homedir() });
    assert.equal(asHome.ok, false);
    assert.equal(asHome.demote, 'journal');

    const asRoot = store.validateEntry('memory', '根目录不是项目根', { cwd: '/' });
    assert.equal(asRoot.ok, false);

    /* 4. FACT 不受影响 */
    const fact = store.validateEntry('fact', '全局记忆照常写', { cwd: '' });
    assert.equal(fact.ok, true);
} finally {
    delete process.env.DSH_HOME;
}

console.log('✓ project-bootstrap.test.mjs 全部通过');
