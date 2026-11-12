/**
 * 回归测试：整篇覆盖防呆 + scope=global 的 expectedRevision 必填（0.13.2 · A2）。
 *
 * 背景（为什么这两条要一起做）：
 *  - 注入侧先 `stripSuperseded` 过滤，模型只看得见「过滤后视图」，照着回写会
 *    ① 丢失效注释（失效条目在注入里复活，污染上下文）② 少抄条目（真丢内容）；
 *  - 过去只有 scope=project 强制 revision，scope=global 省略即不校验 ⇒ 全局记忆
 *    这条路等于没有乐观锁。
 *
 * 本测试钉住：
 *  1. 条目数下降 ⇒ `MEMORY_OVERWRITE_LOSSY`（409），文件一个字节不变；
 *  2. dormant 数下降（失效注释被丢）⇒ 同样拒；
 *  3. 条目数与 dormant 数都不降（只是改正文/合并语义以外的等价重排）⇒ 正常写；
 *  4. `force: true` 是唯一逃生口；
 *  5. memory 工具：scope=global 缺 expectedRevision ⇒ MEMORY_REVISION_REQUIRED，
 *     带 revision 正常写；面板保存（panel 路由）对空文件豁免、对已有内容必填。
 *
 * 跑法：node test/overwrite-guard.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-overwrite-'));
process.env.DSH_HOME = home;

const store = await import('../lib/store.js');
const tools = await import('../lib/tools.js');

const here = dirname(fileURLToPath(import.meta.url));
const memoryDir = join(home, 'memory');
const factPath = join(memoryDir, 'FACT.md');
const projectRoot = join(home, 'proj');
const projectPath = join(projectRoot, 'MEMORY.md');
mkdirSync(memoryDir, { recursive: true });
mkdirSync(projectRoot, { recursive: true });

store.configureStore({ maxFactLines: 100, maxFactBytes: 8000, maxProjectChars: 8000, compactionEnabled: false });

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
        const detail = String(error?.stack ?? error?.message ?? error).split('\n').slice(0, 6).join('\n      ');
        console.log(`FAIL ${label}\n      ${detail}`);
    }
}
const read = (file) => readFileSync(file, 'utf8');
const writeFact = (text) => writeFileSync(factPath, text, 'utf8');

const FACT_TWO = '# 环境\n\n## 环境\n\n- 系统 node v22.23.3\n- 端口用 3179\n';
const DORMANT_FACT = [
    '# 环境',
    '',
    '## 环境',
    '',
    '- 旧结论：端口曾经是 3000 <!-- memory-state: status=superseded by=abc123 since=2026-11-01 -->',
    '- 端口现在是 3179',
    '',
].join('\n');

/* ═════════════ 1) 条目数下降 ⇒ 拒写 ═════════════ */
await check('条目数下降 ⇒ MEMORY_OVERWRITE_LOSSY（409），文件一个字节不变', async () => {
    writeFact(FACT_TWO);
    const before = read(factPath);
    const base = store.contentRevision(before);
    await assert.rejects(
        () => store.replaceDocument('fact', factPath, '# 环境\n\n## 环境\n\n- 系统 node v22.23.3\n', { expectedRevision: base }),
        (error) => {
            assert.equal(error.code, 'MEMORY_OVERWRITE_LOSSY');
            assert.equal(error.status, 409);
            assert.equal(error.details.entries.before, 2);
            assert.equal(error.details.entries.after, 1);
            assert.match(error.message, /条目数：2 → 1/);
            assert.match(error.message, /force: true/, '要告诉调用方逃生口');
            return true;
        },
    );
    assert.equal(read(factPath), before, '拒写时磁盘必须原样');
});

await check('dormant 数下降（失效注释被丢）⇒ 同样拒写，防止失效条目「复活」', async () => {
    writeFact(DORMANT_FACT);
    const before = read(factPath);
    const base = store.contentRevision(before);
    await assert.rejects(
        () => store.replaceDocument('fact', factPath, DORMANT_FACT.replace(/ <!-- memory-state:[^>]*-->/, ''), { expectedRevision: base }),
        (error) => {
            assert.equal(error.code, 'MEMORY_OVERWRITE_LOSSY');
            assert.equal(error.details.dormant.before, 1);
            assert.equal(error.details.dormant.after, 0);
            return true;
        },
    );
    assert.equal(read(factPath), before);
});

/* ═════════════ 2) 不降就放行 / force 逃生 ═════════════ */
await check('条目不变、只改正文 ⇒ 正常写入；条目增加 ⇒ 也正常', async () => {
    writeFact(FACT_TWO);
    const base = store.contentRevision(read(factPath));
    const saved = await store.replaceDocument('fact', factPath, '# 环境\n\n## 环境\n\n- 系统 node v22.23.3\n- 端口用 3179（已确认）\n', { expectedRevision: base });
    assert.equal(saved.written, true);
    const grew = await store.replaceDocument('fact', factPath, `${read(factPath)}- 新加的一条\n`, { expectedRevision: saved.revision });
    assert.equal(grew.written, true);
    assert.match(read(factPath), /新加的一条/);
});

await check('force:true 是唯一逃生口：显式要求才允许删条目', async () => {
    writeFact(FACT_TWO);
    const base = store.contentRevision(read(factPath));
    const saved = await store.replaceDocument('fact', factPath, '# 环境\n\n## 环境\n\n- 只留这一条\n', { expectedRevision: base, force: true });
    assert.equal(saved.written, true);
    assert.equal(read(factPath), '# 环境\n\n## 环境\n\n- 只留这一条\n');
});

/* ═════════════ 3) 工具层：global 必填 expectedRevision ═════════════ */
await check('memory 工具：scope=global 缺 expectedRevision ⇒ MEMORY_REVISION_REQUIRED + 当前 revision', async () => {
    writeFact(FACT_TWO);
    const tool = tools.memoryTool({});
    const exec = { agent: { session: { header: { cwd: projectRoot } } } };
    const before = read(factPath);
    await assert.rejects(
        () => tool.execute({ action: 'update', scope: 'global', content: `${before}- 新的一条\n` }, exec),
        (error) => {
            assert.equal(error.code, 'MEMORY_REVISION_REQUIRED');
            assert.equal(error.status, 409);
            assert.equal(error.details.scope, 'fact');
            assert.equal(error.details.revision, store.contentRevision(before));
            assert.match(error.message, /expectedRevision/);
            assert.match(error.message, /force: true/);
            return true;
        },
    );
    assert.equal(read(factPath), before);
});

await check('memory 工具：带正确 revision 正常写；scope=global 的 revision 过期 ⇒ 冲突拒写', async () => {
    writeFact(FACT_TWO);
    const tool = tools.memoryTool({});
    const exec = { agent: { session: { header: { cwd: projectRoot } } } };
    const base = store.contentRevision(read(factPath));
    const wrote = await tool.execute({ action: 'update', scope: 'global', content: `${read(factPath)}- 工具新加的一条\n`, expectedRevision: base }, exec);
    assert.match(wrote.text, /已写入全局记忆/);
    assert.match(read(factPath), /工具新加的一条/);
    await assert.rejects(
        () => tool.execute({ action: 'update', scope: 'global', content: `${read(factPath)}- 又一条\n`, expectedRevision: base }, exec),
        (error) => error.code === 'MEMORY_REVISION_CONFLICT',
    );
});

await check('memory 工具：force:true 才允许无 revision 覆盖（并跳过防呆）', async () => {
    writeFact(FACT_TWO);
    const tool = tools.memoryTool({});
    const exec = { agent: { session: { header: { cwd: projectRoot } } } };
    await tool.execute({ action: 'update', scope: 'global', content: '# 环境\n\n## 环境\n\n- 只剩一条\n', force: true }, exec);
    assert.equal(read(factPath), '# 环境\n\n## 环境\n\n- 只剩一条\n');
});

await check('memory 工具：带 revision 但条目变少 ⇒ MEMORY_OVERWRITE_LOSSY（不是静默丢内容）', async () => {
    writeFact(FACT_TWO);
    const before = read(factPath);
    const tool = tools.memoryTool({});
    const exec = { agent: { session: { header: { cwd: projectRoot } } } };
    await assert.rejects(
        () => tool.execute({ action: 'update', scope: 'global', content: '# 环境\n\n## 环境\n\n- 只留一条\n', expectedRevision: store.contentRevision(before) }, exec),
        (error) => error.code === 'MEMORY_OVERWRITE_LOSSY',
    );
    assert.equal(read(factPath), before);
});

/* ═════════════ 4) 项目记忆同样受保护 ═════════════ */
await check('项目 MEMORY.md：条目数下降同样拒写（scope=project）', async () => {
    writeFileSync(projectPath, '# MEMORY\n\n1. 甲\n2. 乙\n', 'utf8');
    const base = store.contentRevision(read(projectPath));
    await assert.rejects(
        () => store.replaceDocument('memory', projectPath, '# MEMORY\n\n1. 甲\n', { cwd: projectRoot, expectedRevision: base }),
        (error) => error.code === 'MEMORY_OVERWRITE_LOSSY',
    );
    assert.equal(read(projectPath), '# MEMORY\n\n1. 甲\n2. 乙\n');
});

/* ── 汇总 ── */
console.log('');
if (failures.length > 0) {
    console.log(`失败 ${failures.length} / ${checks}：${failures.join('、')}`);
    process.exit(1);
}
console.log(`覆盖防呆用例全部通过（${checks} 条）`);
rmSync(home, { recursive: true, force: true });
