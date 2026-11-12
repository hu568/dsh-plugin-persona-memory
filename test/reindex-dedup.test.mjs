/**
 * 回归测试：索引 reindex（dry-run / force）+ 写入侧归一化精确重复兜底（0.13.3）。
 *
 * 这份测试钉住五件事：
 *  1. `action=reindex` **默认 dry-run**：只出「将补 N 条」报告，index.json 一个字节都不动；
 *  2. 显式 force 才落盘：缺 importance/kind 的裸记录补齐、项目记录按工作区注册表补 workspaceId、
 *     孤儿记录只统计不补、FACT/MEMORY 正文不动；
 *  3. 落盘后幂等：再跑一次 force ⇒ 「没有需要补的记录」，不重复写；
 *  4. `insertEntry` 对「去掉空白/标点/引号/全半角后一字不差」的重复条目拒绝
 *     （`reason=duplicate-entry`, `demoted=journal`，不炸流程）；
 *  5. 同主题不同结论、以及**别的项目文件**里同样的句子必须放行（不误杀）。
 *
 * 跑法：node test/reindex-dedup.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-reindex-'));
process.env.DSH_HOME = home;

const store = await import('../lib/store.js');
const { memoryTool } = await import('../lib/tools.js');

const memoryDir = join(home, 'memory');
const factPath = join(memoryDir, 'FACT.md');
const indexFilePath = join(memoryDir, 'index.json');
const projectDir = join(home, 'proj-alpha');
const projectPath = join(projectDir, 'MEMORY.md');
const otherProjectDir = join(home, 'proj-beta');
mkdirSync(memoryDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });
mkdirSync(otherProjectDir, { recursive: true });

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
const sha = (file) => readFileSync(file, 'utf8');
const tool = memoryTool({});

/* ── 夹具：一份「老写入路径」留下的索引（只有五个字段）+ 两份正文 ── */
const factText = [
    '## 其它',
    '',
    '- 归一化兜底复现结论甲',
    '- 归一化兜底复现结论乙',
    '- 字段齐全的历史结论',
    '',
].join('\n');
const projectText = ['## 观点', '', '1. 项目记忆里的裸记录结论', ''].join('\n');
writeFileSync(factPath, factText);
writeFileSync(projectPath, projectText);

const ts = 1700000000000;
const factBareA = store.entryId(ts, '归一化兜底复现结论甲');
const factBareB = store.entryId(ts + 1000, '归一化兜底复现结论乙');
const factFull = store.entryId(ts + 2000, '字段齐全的历史结论');
const memBare = store.entryId(ts + 3000, '项目记忆里的裸记录结论');
// 正文里早就没有这句了（人工改过正文 ⇒ 索引记录成孤儿）
const orphan = store.entryId(ts + 4000, '正文早已被人工改掉的孤儿结论');
const seeded = {
    version: 1,
    entries: {
        [factBareA]: { scope: 'fact', workspaceId: null, firstSeen: ts, lastHit: ts, hits: 1, confidence: 'high' },
        [factBareB]: { scope: 'fact', workspaceId: null, firstSeen: ts + 1000, lastHit: ts + 1000, hits: 1, confidence: 'high' },
        [factFull]: {
            scope: 'fact', workspaceId: null, firstSeen: ts + 2000, lastHit: ts + 2000, hits: 2,
            confidence: 'high', importance: 90, kind: 'detail', importanceExplicit: true,
        },
        [memBare]: {
            scope: 'memory', workspaceId: null, firstSeen: ts + 3000, lastHit: ts + 3000, hits: 1,
            confidence: 'medium', path: projectPath,
        },
        [orphan]: { scope: 'fact', workspaceId: null, firstSeen: ts + 4000, lastHit: ts + 4000, hits: 1, confidence: 'medium' },
    },
};

await check('reindex：index.json 不存在 ⇒ 报告「不存在」，不创建文件', async () => {
    const report = store.reindexIndex({});
    assert.equal(report.indexExists, false);
    assert.equal(report.willFill, 0);
    // 不写盘：memoryDir 里此刻还没有 index.json
    let exists = true;
    try {
        sha(indexFilePath);
    }
    catch {
        exists = false;
    }
    assert.equal(exists, false, 'dry-run 不该创建 index.json');
});

writeFileSync(indexFilePath, `${JSON.stringify(seeded, null, 2)}\n`);
const indexBefore = sha(indexFilePath);
const factBefore = sha(factPath);
const projectBefore = sha(projectPath);

await check('reindex：默认 dry-run 出「将补 3 条」报告，index.json 一个字节都不动', async () => {
    const { text } = await tool.execute({ action: 'reindex' }, {});
    assert.match(text, /dry-run/);
    assert.match(text, /扫描记录：5 条（正文仍在 4 条 \/ 孤儿跳过 1 条 \/ 无法验证 0 条）/);
    assert.match(text, /需补字段：3 条 —— importance 3 \/ kind 3 \/ workspaceId 1/);
    assert.match(text, /无需改动：1 条/);
    assert.match(text, /一个字节都没写/);
    assert.equal(sha(indexFilePath), indexBefore, 'dry-run 不许写 index.json');
    assert.equal(sha(factPath), factBefore);
});

await check('reindex force：补 importance/kind/workspaceId，孤儿与全字段记录不动，正文不动', async () => {
    const { text } = await tool.execute({ action: 'reindex', force: true }, {});
    assert.match(text, /已补 3 条/);
    const document = JSON.parse(sha(indexFilePath));
    const entries = document.entries;
    assert.equal(entries[factBareA].importance, store.DEFAULT_IMPORTANCE);
    assert.equal(entries[factBareA].kind, 'conclusion');
    assert.equal(entries[factBareB].importance, store.DEFAULT_IMPORTANCE);
    assert.equal(entries[factBareB].kind, 'conclusion');
    // 归属口径与 insertEntry 一致（DESIGN §14）：归一后的**项目根绝对路径**，不是注册表 id
    assert.equal(entries[memBare].workspaceId, projectDir, '项目记录按 path 的上一层目录补归属');
    assert.equal(entries[memBare].importance, store.DEFAULT_IMPORTANCE);
    assert.equal(entries[factFull].importance, 90, '本来就齐全的记录一个字段都不该被改写');
    assert.equal(entries[factFull].kind, 'detail');
    assert.equal('importance' in entries[orphan], false, '孤儿只统计、不补字段');
    assert.equal(Object.keys(entries).length, Object.keys(seeded.entries).length, '不增不删记录');
    assert.equal(sha(factPath), factBefore, 'FACT.md 正文不该被动过');
    assert.equal(sha(projectPath), projectBefore, 'MEMORY.md 正文不该被动过');
});

await check('reindex force 幂等：再跑一次 ⇒ 没有需要补的记录，不再写盘', async () => {
    const after = sha(indexFilePath);
    const report = store.reindexIndex({ force: true });
    assert.equal(report.willFill, 0);
    assert.equal(report.written, false);
    assert.equal(report.orphans, 1, '孤儿仍然只统计');
    assert.equal(sha(indexFilePath), after);
});

await check('insertEntry：去掉标点后一字不差 ⇒ duplicate-entry 降级 JOURNAL，不炸流程', async () => {
    const before = sha(factPath);
    const result = await store.insertEntry('global', { text: '归一化兜底，复现结论：甲' });
    assert.equal(result.written, false);
    assert.equal(result.reason, 'duplicate-entry');
    assert.equal(result.demoted, 'journal');
    assert.match(String(result.duplicateOf), /归一化兜底复现结论甲/);
    assert.equal(sha(factPath), before, '重复条目一个字节都不该写');
});

await check('insertEntry：全角／空白／引号差异也算重复（NFKC + 去空白 + 去标点）', async () => {
    const first = await store.insertEntry('global', { text: 'AB 测试结论归一' });
    assert.equal(first.written, true);
    const before = sha(factPath);
    const again = await store.insertEntry('global', { text: 'ＡＢ「测试结论」归一！' });
    assert.equal(again.written, false);
    assert.equal(again.reason, 'duplicate-entry');
    assert.equal(sha(factPath), before);
});

await check('insertEntry：同主题不同结论放行（不误杀）', async () => {
    const result = await store.insertEntry('global', { text: '归一化兜底复现结论甲（已修正阈值）' });
    assert.equal(result.written, true);
});

await check('insertEntry：另一个项目文件里同样的句子放行（按目标文件算）', async () => {
    const result = await store.insertEntry('project', { text: '归一化兜底复现结论甲' }, { cwd: otherProjectDir });
    assert.equal(result.written, true, '不同项目文件互不干扰');
    assert.ok(sha(join(otherProjectDir, 'MEMORY.md')).includes('归一化兜底复现结论甲'));
});

await check('replaceEntry：改成别的条目 ⇒ 拒绝；原样重写自己 ⇒ 放行', async () => {
    const [a, b] = await Promise.all([
        store.insertEntry('global', { text: '替换目标条目甲' }),
        store.insertEntry('global', { text: '替换目标条目乙' }),
    ]);
    assert.equal(a.written, true);
    assert.equal(b.written, true);
    const blocked = await store.replaceEntry('global', a.id, { text: '替换目标条目乙' });
    assert.equal(blocked.written, false);
    assert.equal(blocked.reason, 'duplicate-entry');
    assert.equal(blocked.demoted, 'journal');
    const selfRewrite = await store.replaceEntry('global', a.id, { text: '替换目标条目甲' });
    assert.equal(selfRewrite.written, true, '原样重写不该被自己拦下');
});

console.log(`\n共 ${checks} 项检查：通过 ${checks - failures.length}，失败 ${failures.length}`);
try {
    rmSync(home, { recursive: true, force: true });
}
catch {
    /* 临时目录清不掉不影响结论 */
}
if (failures.length > 0) {
    console.error(`失败项：${failures.join(' / ')}`);
    process.exit(1);
}
