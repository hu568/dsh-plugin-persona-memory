/**
 * 回归测试：整篇覆盖写入的**乐观锁**（revision CAS）与写锁（0.8.4 / PLAN P0）。
 *
 * 背景（为什么要这层）：
 *  - 条目级写入（`insertEntry` / `replaceEntry` / `deleteEntry`）与压缩管线都是
 *    「锁内重读 → 改 → 写」；
 *  - 而 `memory action=update` 与面板保存是「门外的旧正文 + 新正文」，
 *    中间任何一次条目级写入都会被它整篇盖掉，**且不报错**（静默丢数据）。
 *
 * 本测试钉住四件事：
 *  1. `contentRevision()` 是「正文原文」的哈希（16 位十六进制），不做换行归一化；
 *  2. 不带 `expectedRevision` ⇒ 照旧可写（保持旧调用方行为），只多拿一把锁；
 *  3. 带正确的 `expectedRevision` ⇒ 正常写入并回带新 revision；
 *  4. 带**过期**的 `expectedRevision` ⇒ 抛 `MEMORY_REVISION_CONFLICT`、文件一个字节不变，
 *     而且「读完之后别人插入的条目」还在（这正是丢失更新的现场）。
 *
 * 跑法：node test/revision.test.mjs
 * （run-all.ps1 第 3 步跑仓库源码；第 10 步用 PERSONA_MEMORY_STORE_ENTRY 复跑已装份。）
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-revision-'));
process.env.DSH_HOME = home;

const here = dirname(fileURLToPath(import.meta.url));
const storeUrl = process.env.PERSONA_MEMORY_STORE_ENTRY ?? pathToFileURL(join(here, '..', 'lib', 'store.js')).href;
const store = await import(storeUrl);

const memoryDir = join(home, 'memory');
const factPath = join(memoryDir, 'FACT.md');
const projectRoot = join(home, 'project');
const projectMemory = join(projectRoot, 'MEMORY.md');
mkdirSync(projectRoot, { recursive: true });

/* ── 极简 PASS/FAIL 报告器 ── */
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
        const detail = String(error?.message ?? error).split('\n').join('\n      ');
        console.log(`FAIL ${label}\n      ${detail}`);
    }
}
const read = (file) => readFileSync(file, 'utf8');
const writeFact = (text) => {
    mkdirSync(dirname(factPath), { recursive: true });
    writeFileSync(factPath, text, 'utf8');
};

/* ── 1) contentRevision 口径 ── */
await check('contentRevision：同文同值、16 位十六进制、不同文不同值', () => {
    const a = store.contentRevision('hello\nworld\n');
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.equal(store.contentRevision('hello\nworld\n'), a);
    assert.notEqual(store.contentRevision('hello\nworld'), a);
    assert.equal(store.contentRevision(null), store.contentRevision(''), 'null 与空串同口径（文件不存在 = 空正文）');
});

await check('contentRevision：不做 CRLF 归一化（必须与 readText 逐字可比）', () => {
    assert.notEqual(store.contentRevision('a\r\nb\r\n'), store.contentRevision('a\nb\n'));
});

/* ── 2) 不带 expectedRevision：行为不变 ── */
await check('replaceDocument 不带 expectedRevision：照旧写入并回带新 revision', async () => {
    writeFact('# FACT\n\n- 第一条\n');
    const next = '# FACT\n\n- 第一条\n- 第二条\n';
    const saved = await store.replaceDocument('fact', factPath, next);
    assert.equal(saved.written, true);
    assert.equal(read(factPath), next);
    assert.equal(saved.revision, store.contentRevision(next), '回带的 revision 必须等于写后正文的哈希');
    assert.equal(saved.previousRevision, store.contentRevision('# FACT\n\n- 第一条\n'));
});

/* ── 3) 带正确 expectedRevision ── */
await check('replaceDocument 带正确 expectedRevision：正常写入', async () => {
    const before = read(factPath);
    const base = store.contentRevision(before);
    const next = `${before}- 第三条\n`;
    const saved = await store.replaceDocument('fact', factPath, next, { expectedRevision: base });
    assert.equal(saved.written, true);
    assert.equal(read(factPath), next);
    assert.equal(saved.revision, store.contentRevision(next));
});

/* ── 4) 过期 revision：拒写 + 不动文件 + 别人的改动还在 ── */
await check('replaceDocument 带过期 revision：抛 MEMORY_REVISION_CONFLICT 且文件一个字节不变', async () => {
    const before = read(factPath);
    const stale = store.contentRevision(before);
    // 模拟「读了之后，别处（条目级写入 / 压缩管线 / 另一个面板）改了文件」
    const changed = `${before}- 别人插进来的一条\n`;
    writeFact(changed);
    await assert.rejects(
        () => store.replaceDocument('fact', factPath, '- 我的整篇覆盖\n', { expectedRevision: stale }),
        (error) => {
            assert.equal(error.code, 'MEMORY_REVISION_CONFLICT');
            assert.equal(error.status, 409);
            assert.equal(error.details.expectedRevision, stale);
            assert.equal(error.details.actualRevision, store.contentRevision(changed));
            assert.match(error.message, /已被别处修改/);
            return true;
        },
    );
    assert.equal(read(factPath), changed, '冲突时绝不能写盘');
});

/* ── 5) 真实丢数据现场：read → 别人 insertEntry → 我用旧 revision 整篇覆盖 ── */
await check('读后别人插入条目：旧 revision 整篇覆盖被拒，插入的条目不丢', async () => {
    writeFact('# FACT\n\n- A\n');
    const base = store.contentRevision(read(factPath));
    // 另一个写者（自动沉淀 / 压缩管线）插入一条
    const inserted = await store.insertEntry('fact', { text: 'B 别人写的条目', confidence: 'high' });
    assert.equal(inserted.written, true);
    assert.match(read(factPath), /B 别人写的条目/);
    // 我拿着旧 revision 整篇覆盖 ⇒ 必须被拒
    await assert.rejects(
        () => store.replaceDocument('fact', factPath, '# FACT\n\n- A\n', { expectedRevision: base }),
        (error) => error.code === 'MEMORY_REVISION_CONFLICT',
    );
    assert.match(read(factPath), /B 别人写的条目/, '插入的条目不能在冲突后被静默抹掉');
});

/* ── 6) 重新读取后合并再写：应当成功 ── */
await check('冲突后重读最新 revision 再写：成功（乐观锁的正确用法）', async () => {
    const latest = store.contentRevision(read(factPath));
    const merged = `${read(factPath)}- C\n`;
    const saved = await store.replaceDocument('fact', factPath, merged, { expectedRevision: latest });
    assert.equal(saved.written, true);
    assert.match(read(factPath), /B 别人写的条目/);
    assert.match(read(factPath), /- C/);
});

/* ── 7) 项目 MEMORY.md 同样生效（scope=memory + cwd） ── */
await check('replaceDocument 对项目 MEMORY.md 同样生效（scope=memory，cwd 参与锁键）', async () => {
    writeFileSync(projectMemory, '# MEMORY\n\n- 项目事实\n', 'utf8');
    const stale = store.contentRevision('# MEMORY\n\n- 项目事实\n');
    writeFileSync(projectMemory, '# MEMORY\n\n- 项目事实\n- 别处追加\n', 'utf8');
    await assert.rejects(
        () => store.replaceDocument('memory', projectMemory, '# MEMORY\n\n- 我改的\n', { cwd: projectRoot, expectedRevision: stale }),
        (error) => error.code === 'MEMORY_REVISION_CONFLICT',
    );
    assert.match(read(projectMemory), /别处追加/);
    const ok = await store.replaceDocument('memory', projectMemory, '# MEMORY\n\n- 我改的\n', {
        cwd: projectRoot,
        expectedRevision: store.contentRevision(read(projectMemory)),
    });
    assert.equal(ok.written, true);
    assert.equal(read(projectMemory), '# MEMORY\n\n- 我改的\n');
});

/* ── 8) 并发：两个写者同时整篇覆盖，锁让它们串行，文件不会写坏 ── */
await check('并发两个 replaceDocument：串行写入，结果完整（不起锁时这里是竞态的）', async () => {
    writeFact('# FACT\n');
    const base = store.contentRevision(read(factPath));
    const results = await Promise.allSettled([
        store.replaceDocument('fact', factPath, '# FACT\n- 甲\n', { expectedRevision: base }),
        store.replaceDocument('fact', factPath, '# FACT\n- 乙\n', { expectedRevision: base }),
    ]);
    const ok = results.filter((item) => item.status === 'fulfilled');
    const rejected = results.filter((item) => item.status === 'rejected');
    assert.equal(ok.length, 1, '同一 base revision 只允许一个成功');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'MEMORY_REVISION_CONFLICT');
    const final = read(factPath);
    assert.ok(final === '# FACT\n- 甲\n' || final === '# FACT\n- 乙\n', `文件内容应是完整的一份，实际：${JSON.stringify(final)}`);
});

/* ── 9) 工具层：read 回带 revision，update 用 stale revision 被拒 ── */
await check('memory 工具：read 输出带 revision，update 带过期 revision 被拒、带最新 revision 成功', async () => {
    const tools = await import(pathToFileURL(join(here, '..', 'lib', 'tools.js')).href);
    const tool = tools.memoryTool({});
    const exec = { agent: { session: { header: { cwd: projectRoot } } } };
    writeFact('# FACT\n\n- 工具测试\n');
    const readOut = await tool.execute({ action: 'read' }, exec);
    const match = /revision ([0-9a-f]{16})/.exec(readOut.text);
    assert.ok(match !== null, `read 输出里应有 revision，实际：${readOut.text.slice(0, 200)}`);
    const base = match[1];
    // 别处改了文件
    writeFact('# FACT\n\n- 工具测试\n- 别处改的\n');
    await assert.rejects(
        () => tool.execute({ action: 'update', scope: 'global', content: '# FACT\n\n- 我的版本\n', expectedRevision: base }, exec),
        (error) => error.code === 'MEMORY_REVISION_CONFLICT',
    );
    assert.match(read(factPath), /别处改的/, '冲突时不能写盘');
    // 重新读 → 合并后写
    const again = await tool.execute({ action: 'read' }, exec);
    const latest = /revision ([0-9a-f]{16})/.exec(again.text)[1];
    const merged = `${read(factPath)}- 合并后新增\n`;
    const wrote = await tool.execute({ action: 'update', scope: 'global', content: merged, expectedRevision: latest }, exec);
    assert.match(wrote.text, /新 revision [0-9a-f]{16}/);
    assert.match(read(factPath), /别处改的/);
    assert.match(read(factPath), /合并后新增/);
});

/* ── 收尾 ── */
rmSync(home, { recursive: true, force: true });
if (failures.length > 0) {
    console.log(`\n✗ revision: ${failures.length} 项失败 / 共 ${checks} 项：${failures.join('、')}`);
    process.exit(1);
}
console.log(`\n✓ revision: ${checks} 项全部通过`);
