/**
 * 回归测试：JOURNAL 写路径与读路径的脱敏（0.9.0 · P0-1）。
 *
 * 背景：JOURNAL 正文**不进提示词**，但 recall 会按 BM25 把命中的日志召回并注入上下文。
 * 0.9.0 之前 `appendJournal()`（`memory action=append` 与面板日志写入共用）**完全不脱敏**，
 * 而脱敏表只接在 `validateEntry` / `supersedeJournal` 上 ⇒ 密钥明文落盘、又每轮被送进模型。
 *
 * 本测试钉住：
 *  1. `appendJournal()` 落盘前脱敏（磁盘无明文，统一占位符 `⟨redacted⟩`）；
 *  2. 返回值 id == 落盘行 id == `entryId(ts, 脱敏后正文)`（id 不变量仍成立）；
 *  3. 历史行（0.9.0 之前写的明文）在**读**的时候打码，且**不回写磁盘**；
 *  4. `searchJournal` / `listJournal` / `supersedeJournal` 看到的都是打码后的正文。
 *
 * 跑法：node test/redact-journal.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ── 假 DSH_HOME 隔离真实数据；必须在 import 模块之前设置 ── */
const home = mkdtempSync(join(tmpdir(), 'persona-memory-redact-'));
process.env.DSH_HOME = home;

const store = await import('../lib/store.js');
store.configureStore({});
mkdirSync(store.memoryDir(), { recursive: true });

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
const journalRaw = () => readFileSync(store.journalPath(), 'utf8');

await check('appendJournal：落盘前脱敏，磁盘与 readJournal 都看不到明文', async () => {
    writeFileSync(store.journalPath(), '', 'utf8');
    const entry = await store.appendJournal('部署时用的 token: sk-abcdefghijklmnopqrstuvwxyz0123', ['ops']);
    const raw = journalRaw();
    assert.ok(!raw.includes('sk-abcdefghijklmnop'), `磁盘不得出现明文密钥：${raw}`);
    assert.ok(raw.includes('⟨redacted⟩'), '应出现统一占位符 ⟨redacted⟩');
    const back = store.readJournal(10).entries[0];
    assert.ok(!back.text.includes('sk-abcdefghijklmnop'), 'readJournal 也不得回明文');
    assert.ok(back.text.includes('⟨redacted⟩'));
    assert.equal(entry.id, store.entryId(entry.ts, back.text), 'id 必须按脱敏后的正文算');
    assert.equal(JSON.parse(raw.trim()).text, back.text, '落盘正文 == readJournal 正文');
    assert.equal(back.id, entry.id);
});

await check('appendJournal：手机号 / Bearer token 同样打码', async () => {
    writeFileSync(store.journalPath(), '', 'utf8');
    await store.appendJournal('手机号 13900139000，Bearer abcdefghijklmnopqrstuvwx 记一下', []);
    const raw = journalRaw();
    assert.ok(!raw.includes('13900139000'), `手机号不得明文落盘：${raw}`);
    assert.ok(!raw.includes('abcdefghijklmnopqrstuvwx'), 'Bearer token 不得明文落盘');
    assert.ok(!store.readJournal(10).entries[0].text.includes('13900139000'));
});

await check('历史行读时打码、不回写磁盘（只读打码）', async () => {
    const legacy = JSON.stringify({
        ts: '2026-10-31T00:00:00.000Z',
        tags: ['legacy'],
        text: '老条目里的 token: sk-zzzzzzzzzzzzzzzzzzzz',
    });
    writeFileSync(store.journalPath(), `${legacy}\n`, 'utf8');
    const before = journalRaw();
    const entry = store.readJournal(10).entries[0];
    assert.ok(!entry.text.includes('sk-zzzzzzzzzzzzzzzzzzzz'), '读路径必须打码');
    assert.ok(entry.text.includes('⟨redacted⟩'));
    assert.equal(entry.id, store.entryId('2026-10-31T00:00:00.000Z', entry.text), '老行惰性 id 也按打码正文算');
    assert.equal(journalRaw(), before, '读路径不得把文件重写');
});

await check('searchJournal / listJournal 也只见打码正文', async () => {
    const hits = store.searchJournal('老条目', '', 10);
    assert.equal(hits.length, 1);
    assert.ok(!hits[0].text.includes('sk-zzz'));
    const listed = store.listJournal({ tail: 10 });
    assert.ok(listed.every((item) => !item.text.includes('sk-zzz')));
});

await check('supersedeJournal：按读侧 id 能命中，归档同样打码', async () => {
    const entry = store.readJournal(10).entries[0];
    const result = await store.supersedeJournal([entry.id], '换一条更准的');
    assert.equal(result.moved, 1, JSON.stringify(result));
    const archive = readFileSync(store.journalArchivePath(), 'utf8');
    assert.ok(!archive.includes('sk-zzzzzzzzzzzzzzzzzzzz'), `归档必须打码：${archive}`);
    assert.ok(archive.includes('⟨redacted⟩'));
    assert.equal(JSON.parse(archive.trim()).id, entry.id);
});

rmSync(home, { recursive: true, force: true });
if (failures.length > 0) {
    console.log(`\n✗ redact-journal: ${failures.length} 项失败 / 共 ${checks} 项：${failures.join('、')}`);
    process.exit(1);
}
console.log(`\n✓ redact-journal: ${checks} 项全部通过`);
