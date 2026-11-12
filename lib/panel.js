/**
 * @dsh-external/dsh-persona-memory — 右侧栏面板 / 设置页的 HTTP API。
 *
 * 全部路由挂在 `config.panelPath` 下，统一信封 `{ ok, state }`；客户端半只认这一种形状。
 * 写路径与 memory 工具共用 store 的同一道闸口（上限不会从面板绕过）。
 */
import { existsSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  PROJECT_MEMORY_FILE,
  appendJournal,
  assertFactWithinLimit,
  assertProjectMemoryWithinLimit,
  countBytes,
  countLines,
  contentRevision,
  dshHome,
  factPath,
  journalPath,
  memoryDir,
  readJournal,
  readText,
  replaceDocument,
  searchJournal,
  writeAtomic,
} from './store.js';
import { DEFAULT_MAX_CHARS, DEFAULT_MAX_FACT_BYTES, DEFAULT_MAX_FACT_LINES, DEFAULT_MAX_PROJECT_CHARS } from './config.js';
import { activePath, ensureTrailingNewline, injectionPath, orderPath, personasDir, snapshotsDir } from './paths.js';
import { injectionFlags, writeInjectionOverrides } from './injection.js';
import { activePersonaId, isPersonaDir, readPersona, scanPersonas, validPersonaId, writePersona } from './persona-store.js';
import { projectEntryFor, registeredWorkspacePaths } from './workspace.js';
import { latestSessionCwd } from './compaction-wiring.js';
import { compactionStatus } from './compaction.js';
import { setLock, unsetLock } from './locks.js';

/* ────────────────────────────── 面板 API ────────────────────────────── */
export function registerPanelRoutes(webServer, config, runtime, ctx, settingsRegistry) {
    const base = config.panelPath;
    /** 项目记忆的生效上限（0.9.0 · P1-2）：`min(maxChars, maxProjectChars)`，与注入侧同口径。 */
    const projectLimit = Math.min(
        typeof config.maxChars === 'number' && Number.isFinite(config.maxChars) && config.maxChars >= 1 ? config.maxChars : DEFAULT_MAX_CHARS,
        typeof config.maxProjectChars === 'number' && Number.isFinite(config.maxProjectChars) && config.maxProjectChars >= 1 ? config.maxProjectChars : DEFAULT_MAX_PROJECT_CHARS,
    );
    /**
     * 0.9.0 · P1-9：面板的角色动作与工具走同一套 id 校验（show/use/delete）。
     * `save` 本来就有，这里补上其余三个 —— 否则 `POST /api/persona/delete` 传
     * `'../x'` 同样会 rmSync 到角色库之外。
     */
    const requireValidPersonaId = (id) => {
        if (!validPersonaId(id))
            throw new Error('角色 id 只能是小写字母/数字/中横线');
    };
    const sendJson = (res, status, payload) => {
        const body = JSON.stringify(payload);
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
    };
    const readBody = async (req, limitBytes = 262_144) => {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > limitBytes)
                throw new Error('请求体过大');
            chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        return raw.trim() === '' ? {} : JSON.parse(raw);
    };
    const route = (method, path, handler) => {
        ctx.effect(() => webServer.register({
            kind: 'exact',
            path: base + path,
            handler: (req, res) => {
                void (async () => {
                    try {
                        if (req.method !== method) {
                            sendJson(res, 405, { ok: false, error: `只支持 ${method}` });
                            return;
                        }
                        const payload = method === 'GET' ? {} : await readBody(req);
                        await handler(payload, req, res);
                    }
                    catch (error) {
                        // 乐观锁冲突要能被客户端识别：默认 400，修订号冲突给 409。
                        sendJson(res, Number.isInteger(error?.status) ? error.status : 400, {
                            ok: false,
                            error: String(error?.message ?? error),
                            code: typeof error?.code === 'string' ? error.code : undefined,
                            // 0.13.2 · A2：MEMORY_OVERWRITE_LOSSY 需要把「条目数 5→3」带给面板，
                            // 客户端才能 popconfirm「确认要删这几条吗」，而不是只看到一句话。
                            details: error?.details !== null && typeof error?.details === 'object' ? error.details : undefined,
                        });
                    }
                })();
            },
        }), `persona-memory: route ${method} ${path}`);
    };
    /**
     * 面板「项目」列表，按 path 去重，三个来源：
     *  1. DSH 工作区注册表 —— 刚重启、还没跑过会话的工作区也要能看到，否则面板无法
     *     在切换工作区后立刻显示对应 MEMORY.md；
     *  2. 本进程见过的会话 cwd（注入/写入实际用到的路径）；
     *  3. 已固化的会话快照里记录的项目。
     * 当前请求带来的 cwd 一并并入（注册表可能还没登记刚打开的新目录）。
     */
    const knownProjects = (currentCwd) => {
        const seen = new Map();
        const add = (project) => {
            if (project !== null)
                seen.set(project.path, project);
        };
        for (const root of registeredWorkspacePaths())
            add(projectEntryFor(root));
        for (const cwd of runtime.cwdBySession.values())
            add(projectEntryFor(cwd));
        for (const project of runtime.projectBySession.values())
            add(project);
        add(projectEntryFor(currentCwd));
        return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
    };
    /**
     * 设置页数据：三个注入开关 + 一眼能看懂的当前体量 + 附属插件注册项。
     * 与侧栏面板的 `state` 分开：设置页不需要角色正文/日志条目的全量。
     */
    const settingsState = () => {
        const active = activePersonaId();
        const persona = active === '' ? null : readPersona(active);
        const fact = readText(factPath()) ?? '';
        return {
            path: injectionPath(),
            injection: injectionFlags(config, runtime),
            defaults: {
                persona: config.personaEnabled,
                globalMemory: config.memoryEnabled,
                projectMemory: config.memoryEnabled,
            },
            overrides: runtime.injection ?? {},
            context: {
                persona: persona === null ? null : { id: persona.id, name: persona.name },
                fact: {
                    exists: existsSync(factPath()),
                    lines: countLines(fact),
                    bytes: countBytes(fact),
                    maxLines: config.maxFactLines ?? DEFAULT_MAX_FACT_LINES,
                    maxBytes: config.maxFactBytes ?? DEFAULT_MAX_FACT_BYTES,
                },
                projectCount: knownProjects().length,
            },
            items: settingsRegistry.list(),
        };
    };
    /** 面板状态。`cwd` = 请求方主视图会话的工作目录（由 GET /api/state?cwd= 传入）。 */
    const state = (cwd) => {
        const list = scanPersonas();
        const active = activePersonaId();
        const detail = active === '' ? null : readPersona(active);
        const journal = readJournal(100);
        const snapshots = [];
        for (const snapshot of runtime.snapshots.values()) {
            snapshots.push({
                sessionId: snapshot.sessionId,
                createdAt: snapshot.createdAt,
                personaId: snapshot.persona?.id ?? null,
                personaName: snapshot.persona?.name ?? null,
                projectPath: snapshot.project?.path ?? null,
            });
        }
        const factContent = readText(factPath()) ?? '';
        /**
         * 项目条目补上 revision：面板保存时原样回传，store 用它做乐观锁比对。
         * 口径与 `contentRevision()` 一致（对正文原文哈希），所以「面板加载 → 别处改动
         * → 面板保存」会被拒而不是静默盖掉。
         */
        const withRevision = (entry) => entry === null || entry === undefined
            ? entry
            : { ...entry, revision: contentRevision(entry.content ?? '') };
        return {
            ok: true,
            paths: {
                home: dshHome(),
                personas: personasDir(),
                memory: memoryDir(),
                fact: factPath(),
                journal: journalPath(),
                snapshots: snapshotsDir(),
            },
            persona: {
                active,
                list: list.map((persona) => ({ ...persona, active: persona.id === active })),
                detail,
            },
            memory: {
                global: {
                    path: factPath(),
                    exists: existsSync(factPath()),
                    content: factContent,
                    /** 整篇覆盖的乐观锁令牌：保存时原样回传 baseRevision。 */
                    revision: contentRevision(factContent),
                },
                /** 请求方当前所在的项目（面板据此跟随工作区切换；没有 cwd 时为 null）。 */
                current: withRevision(projectEntryFor(cwd)),
                projects: knownProjects(cwd).map(withRevision),
            },
            journal: {
                path: journalPath(),
                count: journal.total,
                entries: journal.entries.slice(-30).reverse(),
            },
            snapshots,
        };
    };
    // 统一信封：读与写一律 `{ ok: true, state }`，客户端只认这一种形状。
    route('GET', '/api/state', (_payload, req, res) => {
        // 面板把主视图会话的 cwd 带上来，项目记忆才能跟随 DSH 工作区切换。
        // 查询串不参与路由匹配（宿主按 pathname 命中 exact 路由），旧客户端不带它照常工作。
        let cwd = '';
        try {
            cwd = new URL(req?.url ?? '/', 'http://x').searchParams.get('cwd') ?? '';
        }
        catch {
            cwd = '';
        }
        sendJson(res, 200, { ok: true, state: state(cwd) });
    });
    /* ── 设置页：注入开关 + 附属插件设置项 ── */
    route('GET', '/api/settings', (_payload, _req, res) => {
        sendJson(res, 200, { ok: true, settings: settingsState() });
    });
    route('POST', '/api/settings/injection', async (payload, _req, res) => {
        const patch = payload.injection ?? payload;
        runtime.injection = writeInjectionOverrides(patch);
        sendJson(res, 200, { ok: true, settings: settingsState() });
    });
    route('POST', '/api/settings/item', async (payload, _req, res) => {
        const id = String(payload.id ?? '').trim();
        const item = await settingsRegistry.set(id, payload.value);
        sendJson(res, 200, { ok: true, item, settings: settingsState() });
    });
    route('POST', '/api/persona/show', async (payload, _req, res) => {
        const id = String(payload.id ?? '').trim();
        requireValidPersonaId(id);
        const persona = readPersona(id);
        if (persona === null)
            throw new Error(`角色不存在：${id}`);
        sendJson(res, 200, { ok: true, persona });
    });
    route('POST', '/api/persona/use', async (payload, _req, res) => {
        const id = String(payload.id ?? '').trim();
        requireValidPersonaId(id);
        if (!isPersonaDir(join(personasDir(), id)))
            throw new Error(`角色不存在：${id}`);
        writeAtomic(activePath(), `${id}\n`);
        sendJson(res, 200, { ok: true, state: state() });
    });
    route('POST', '/api/persona/save', async (payload, _req, res) => {
        const id = String(payload.id ?? '').trim();
        const create = payload.create === true;
        if (!validPersonaId(id))
            throw new Error('角色 id 只能是小写字母/数字/中横线');
        const exists = isPersonaDir(join(personasDir(), id));
        if (!exists && !create)
            throw new Error(`角色不存在：${id}`);
        writePersona(id, {
            name: typeof payload.name === 'string' ? payload.name : undefined,
            description: typeof payload.description === 'string' ? payload.description : undefined,
            soul: typeof payload.soul === 'string' ? payload.soul : undefined,
            user: typeof payload.user === 'string' ? payload.user : undefined,
        });
        if (create && activePersonaId() === '')
            writeAtomic(activePath(), `${id}\n`);
        sendJson(res, 200, { ok: true, state: state() });
    });
    route('POST', '/api/persona/delete', async (payload, _req, res) => {
        const id = String(payload.id ?? '').trim();
        requireValidPersonaId(id);
        if (!isPersonaDir(join(personasDir(), id)))
            throw new Error(`角色不存在：${id}`);
        if (id === activePersonaId())
            throw new Error('这是当前角色，先切换到别的角色再删');
        rmSync(join(personasDir(), id), { recursive: true, force: true });
        sendJson(res, 200, { ok: true, state: state() });
    });
    route('POST', '/api/persona/order', async (payload, _req, res) => {
        const order = Array.isArray(payload.order) ? payload.order.filter((v) => typeof v === 'string') : [];
        const known = new Set(scanPersonas().map((persona) => persona.id));
        const filtered = order.filter((id) => known.has(id));
        writeAtomic(orderPath(), `${JSON.stringify(filtered, null, 2)}\n`);
        sendJson(res, 200, { ok: true, state: state() });
    });
    route('POST', '/api/memory/save', async (payload, _req, res) => {
        const scope = payload.scope === 'project' ? 'project' : 'global';
        const content = typeof payload.content === 'string' ? payload.content : '';
        // 面板加载时拿到的那份 revision：原样回传，store 用它判「这中间有没有别人改过」。
        const baseRevision = typeof payload.baseRevision === 'string' ? payload.baseRevision : '';
        /* 0.13.2 · A2：面板与工具同口径 —— 整篇覆盖缺 revision 就拒（global 也必填），
           逃生口是面板请求里显式 `force: true`（客户端在「确认要删条目」后才带）。 */
        const force = payload.force === true;
        const requireRevision = (label, file) => {
            if (baseRevision !== '' || force)
                return;
            // 目标文件不存在 / 是空文件 ⇒ 没有可丢的旧内容，首次创建不该被乐观锁挡住。
            if ((readText(file) ?? '') === '')
                return;
            const error = new Error(`${label}的整篇覆盖需要 baseRevision（先加载再保存；确认要无视时带 force）。`);
            error.code = 'MEMORY_REVISION_REQUIRED';
            error.status = 409;
            error.details = { scope: label === '全局记忆' ? 'fact' : 'memory', path: file, revision: contentRevision(readText(file) ?? ''), required: true };
            throw error;
        };
        /**
         * 冲突文案是给人看的：store 里那段是写给模型的（含 expected/actual 两个修订号），
         * 面板 toast 塞不下一屏技术细节，所以这里换一句「草稿还在、怎么继续」的人话，
         * 只保留 code 供客户端识别。
         */
        /* 0.9.0 · P1-3：闸口按最终落盘文本判（先补末位换行）；并显式带 `path` 取写锁，
           保证面板（只带 path、不带 cwd）与工具/沉淀（只带 cwd）落到同一把锁。 */
        const finalText = ensureTrailingNewline(content);
        const save = async (targetScope, file) => {
            try {
                await replaceDocument(targetScope, file, finalText, { expectedRevision: baseRevision, path: file, force });
            }
            catch (error) {
                /* 0.13.2 · A2：「条目变少」的拒写也要给人话（store 那段是写给模型的）。 */
                if (error?.code === 'MEMORY_OVERWRITE_LOSSY') {
                    const entries = error.details?.entries;
                    const dormant = error.details?.dormant;
                    const change = [
                        entries === undefined ? '' : `条目 ${entries.before} → ${entries.after}`,
                        dormant === undefined ? '' : `失效条目 ${dormant.before} → ${dormant.after}`,
                    ].filter((item) => item !== '').join('，');
                    const lossy = new Error(`这次保存会让记忆变少（${change || '条目数下降'}），已拒绝以免丢掉内容。确认要删再点一次（会带 force）。`);
                    lossy.code = error.code;
                    lossy.status = 409;
                    lossy.details = error.details;
                    throw lossy;
                }
                if (error?.code !== 'MEMORY_REVISION_CONFLICT')
                    throw error;
                const conflict = new Error('这份记忆在你打开面板之后被别处改过（模型写入 / 另一个面板 / 自动沉淀），已拒绝保存以免丢掉那些改动。你的草稿还在编辑器里：点顶栏「重新读取」看看新内容，合并后再保存。');
                conflict.code = error.code;
                conflict.status = 409;
                conflict.details = error.details;
                throw conflict;
            }
        };
        if (scope === 'global') {
            // 面板与工具走同一道闸口，避免「从面板能绕过上限」。
            assertFactWithinLimit(finalText, config.maxFactLines ?? DEFAULT_MAX_FACT_LINES, config.maxFactBytes ?? DEFAULT_MAX_FACT_BYTES);
            requireRevision('全局记忆', factPath());
            await save('fact', factPath());
            sendJson(res, 200, { ok: true, state: state() });
            return;
        }
        const path = String(payload.path ?? '').trim();
        if (path === '' || basename(path) !== PROJECT_MEMORY_FILE) {
            throw new Error(`项目记忆路径必须以 ${PROJECT_MEMORY_FILE} 结尾`);
        }
        const allowed = knownProjects().some((project) => project.path === path);
        if (!allowed && !existsSync(path))
            throw new Error('未知的项目记忆路径（先让会话在该项目下跑一次）');
        // 同一道闸口：面板也必须受项目记忆字符上限约束。
        assertProjectMemoryWithinLimit(finalText, projectLimit);
        requireRevision('项目记忆', path);
        await save('memory', path);
        sendJson(res, 200, { ok: true, state: state() });
    });
    route('POST', '/api/journal/append', async (payload, _req, res) => {
        const text = String(payload.text ?? '').trim();
        if (text === '')
            throw new Error('日志内容不能为空');
        const tags = Array.isArray(payload.tags)
            ? payload.tags.filter((t) => typeof t === 'string' && t.trim() !== '')
            : [];
        await appendJournal(text, tags);
        sendJson(res, 200, { ok: true, state: state() });
    });
    route('POST', '/api/journal/search', async (payload, _req, res) => {
        const query = String(payload.query ?? '');
        const tag = String(payload.tag ?? '');
        const limit = Number.isFinite(payload.limit) ? Math.max(1, Math.min(200, Math.trunc(payload.limit))) : 50;
        sendJson(res, 200, { ok: true, entries: searchJournal(query, tag, limit) });
    });
    /* ── 压缩管线（P4 · 0.8.0）：状态 + 人工锁定 ── */
    const compactionState = () => compactionStatus({
        cwd: latestSessionCwd(runtime),
        enabled: config.compactionEnabled === true,
    });
    route('GET', '/api/memory/compaction', (_payload, _req, res) => {
        sendJson(res, 200, { ok: true, compaction: compactionState() });
    });
    route('POST', '/api/memory/lock', async (payload, _req, res) => {
        const id = String(payload.id ?? '').trim();
        if (id === '')
            throw new Error('需要条目 id');
        const scope = payload.scope === 'memory' || payload.scope === 'project' ? 'memory' : 'fact';
        const result = setLock(scope, id);
        if (result.ok !== true)
            throw new Error(result.reason ?? '写锁定表失败');
        sendJson(res, 200, { ok: true, key: result.key, compaction: compactionState() });
    });
    route('POST', '/api/memory/unlock', async (payload, _req, res) => {
        const id = String(payload.id ?? '').trim();
        if (id === '')
            throw new Error('需要条目 id');
        const scope = payload.scope === 'memory' || payload.scope === 'project' ? 'memory' : 'fact';
        const result = unsetLock(scope, id);
        if (result.ok !== true)
            throw new Error(result.reason ?? '写锁定表失败');
        sendJson(res, 200, { ok: true, key: result.key, removed: result.removed, compaction: compactionState() });
    });
}
