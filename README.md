# @dsh-external/dsh-persona-memory

DSH 的**角色设定 + 长期记忆**管理插件，注册在**宿主组合**里，对所有 agent 预设的每个会话生效。

| | |
|---|---|
| 许可证 | MIT，见 [LICENSE](./LICENSE) |
| 安装规格 | `github:hu568/dsh-plugin-persona-memory` |
| 实测 DSH | `0.1.5-rc.1` ~ `0.2.0-rc.2` |
| peer 要求 | `cordis >=4.0.0-rc <5`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-system-prompt` |
| 运行依赖 | `schemastery`（别名安装 `npm:@deepseek-ai/schemastery@3.18.2`） |

## 安装 / 卸载

```powershell
# 插件管理器（创造模式）：plugin_manager action=install_bundle target="github:hu568/dsh-plugin-persona-memory"
# 或命令行（桌面端请用插件管理器或「设置 → 插件」）：
dsh plugin --profile <profile> add github:hu568/dsh-plugin-persona-memory
dsh --profile <profile> --dump-config     # 验证：应出现以本包名为标题的层与 persona-memory 行
dsh plugin --profile <profile> remove @dsh-external/dsh-persona-memory
```

卸载不删除 `$DSH_HOME/personas`、`$DSH_HOME/memory`。更新时若安装规格字符串不变会报 `ambiguous-install`，先 `remove` 再 `add`。

## 数据平面

| 平面 | 位置 | 说明 |
|------|------|------|
| 角色设定 | `$DSH_HOME/personas/<id>/{persona.yml,SOUL.md,USER.md}` | 同一时刻一个当前角色 |
| 全局记忆 | `$DSH_HOME/memory/FACT.md` | 跨会话稳定事实；上限 100 行 / 8000 字节 |
| 长期日志 | `$DSH_HOME/memory/JOURNAL.jsonl` | 仅追加 + 可检索；不注入提示词，无上限 |
| 项目记忆 | `<项目根>/MEMORY.md` | 存在才注入；上限 8000 字符 |
| 注入开关 | `$DSH_HOME/memory/injection.json` | 设置页三个开关的覆盖层；文件不在就用组合配置的默认值 |
| 会话快照 | `$DSH_HOME/memory/snapshots/<sessionId>.json` | 首条消息时固化 |

## 注入内容与作用域

提示词段落紧贴部署人格之后：`memory:soul`（`<soul>` + 编辑契约）、`memory:user`（`<user>`）、`memory:facts`（`<memory>` 全局 + 项目 + 写入契约）。

| 段落 | 主会话 | 子代理会话 |
|---|---|---|
| 角色 soul / user | ✅ | ❌ |
| 全局 FACT.md | ✅ | ❌ |
| 项目 MEMORY.md | ✅ | ✅ |
| JOURNAL.jsonl | ❌ | ❌ |

子代理只拿项目记忆与项目版写入契约，可只读 `action=read` / `action=search` 查全局记忆；`subagentProjectOnly: false` 可回退为主会话一致。子代理判定读 `session.header`：`origin === 'subagent'`、`parentSession` 存在或 `delegationDepth > 0`。日志不注入，但契约里留指针（条数 + 正文未注入 + 要求主动 search）。

## 写入硬上限（超限抛错拒绝，不落盘）

| 文件 | 闸口 | 默认 |
|---|---|---|
| 全局 `FACT.md` | 行数 AND 字节（UTF-8） | 100 行 / 8000 字节 |
| 项目 `MEMORY.md` | 字符（`trim()` 后长度，与注入侧 `maxChars` 同口径） | 8000 字符 |
| `JOURNAL.jsonl` | 无上限（有意） | — |

FACT.md 字节先做 `\r\n` → `\n` 归一化，与 `countLines()` 同口径。`memory action=read` 报告当前体量/上限并附超限警告；面板保存走同一道闸口。

## 注入时机

首条用户消息前每轮读盘；首条消息后固化成本会话快照（内存 + 落盘），此后读快照，KV 缓存前缀稳定。快照不含日志正文，只留 `journalTotal` 计数。子代理快照只留内存。resume / 重启语义不变。

## 工具

- `memory`：`read`（全局 + 项目 + 最近日志，报告体量/上限）、`update`（整篇覆盖，`scope=global|project`，超限报错）、`append`（追加 `{ts,tags,text}`）、`search`（子串 + 可选 tag，新→旧）。
- `persona`：`list` / `current` / `show` / `use`（新会话生效）/ `create` / `update` / `delete`（当前角色不可删）。

均全局注册、无路径参数，走进程内 `node:fs`。

## 面板

右侧栏「角色 / 记忆」标签页，HTTP 前缀由 `config.panelPath` 决定（默认 `/persona-memory`；客户端 `BASE` 写死，改前缀需两半同改）。

- **角色**：列表、切换、编辑 name/description/SOUL/USER、新建、删除；>4 个时出现筛选；卡片上移/下移排序（写 `personas/.personas-order`）。
- **记忆**：全局 FACT.md、项目 MEMORY.md 编辑。
- **日志**：最近条目、追加、检索（点 `#tag` 即搜）。
- **交互**：计量条（行数/字节/字符，接近上限变琥珀、超限变红，分母为默认值）、未保存徽标 + 撤销、`Ctrl/Cmd+S` 保存、`Ctrl/Cmd+Enter` 追加、错误 toast。
- **样式**：注入一张 `<style id="dsh-persona-memory-panel-style">`，类名 `.dpm-*`；同页面重载不刷新 CSS，验收请整页刷新。

```
GET  /persona-memory/api/state
POST /persona-memory/api/persona/{show,use,save,delete,order}
POST /persona-memory/api/memory/save
POST /persona-memory/api/journal/{append,search}
```

取 `webServer` 用 `ctx.inject(['webServer'], …)` 等就绪后补注册，不用裸 `ctx.get()`（fiber 未 ACTIVE 会静默跳过导致 404）。

## 设置页：记忆功能管理

DSH「设置」里多一个 **记忆** 页（`settings.section`，id `persona-memory`），一行一个开关：

| 开关 | 控制 |
|---|---|
| 角色设定 | `memory:soul` / `memory:user` 两段 |
| 全局记忆 | `memory:facts` 里的 `FACT.md` 部分与全局写入契约 |
| 项目记忆 | `memory:facts` 里的项目 `MEMORY.md` 部分与项目写入契约（子代理也只看这个开关） |

开关写进 `$DSH_HOME/memory/injection.json`（只存用户显式设过的布尔键），**覆盖**组合配置里的 `personaEnabled` / `memoryEnabled`；删掉文件即回到组合默认值。开关在**当前会话的下一轮**就生效——快照冻结的是角色/记忆正文，不冻结开关；正文编辑仍是新会话生效。

附属插件注册的分组按**项数折叠**：超过 3 项默认收起，只显示「分组名 + 项数」，点标题展开；3 项以内保持展开。这样附属插件可以注册完整参数（例如自动召回的 10 项），页面不会被撑长。

### 给附属插件：注册设置项

宿主半提供 `ctx.personaMemory`（`ctx.get('personaMemory')` 或 `ctx.inject(['personaMemory'], …)`）：

```js
const handle = ctx.personaMemory.settings.register({
  id: 'recall.enabled',            // 唯一，建议 <插件>:<项>
  group: '自动召回',                // 分组标题，默认「附属插件」
  title: '每轮自动召回',
  description: 'BM25 检索历史日志后追加一条消息',
  kind: 'toggle',                  // toggle | select | text | readonly
  value: true,                     // 当前值，必须与 kind 匹配
  order: 10,
  onChange: async (value) => { /* 持久化 + 应用；抛错则页面保留旧值并显示错误 */ },
})
ctx.effect(() => () => handle.dispose())   // 本插件卸载时把项从页面撤掉
```

`select` 需给 `options: [{ value, label }]`；`text` 可给 `placeholder`；`readonly` 只展示不可写。宿主会校验 id 唯一、类型匹配、select 值必须在 options 里。句柄还有 `get()` / `set(value)`（等价页面回写，会触发 `onChange`）/ `update(patch)`（只同步展示，不触发回写）。

需要完整自定义界面（图表、复合控件）的客户端半，往子槽 `settings.persona-memory.item`（`kind: 'list'`）注册即可——该槽由本插件的 `settings.section` 注册项声明，每个贡献自己画整行：

```js
ctx.slots.inject('settings.persona-memory.item', () => ctx.slots.register({
  name: 'settings.persona-memory.item',
  id: 'my-panel',
  order: 100,
}, MyRow))
```

页面只负责渲染与回写，值存哪里、变更后做什么，全在注册方。`ctx.inject` 等到服务出现再注册，不要裸 `ctx.get()` 后假设非空。

```
GET  /persona-memory/api/settings
POST /persona-memory/api/settings/injection   { injection: { persona?, globalMemory?, projectMemory? } }
POST /persona-memory/api/settings/item        { id, value }
```

## 配置

| 字段 | 默认 | 说明 |
|------|------|------|
| `personaEnabled` | `true` | 注入 `<soul>` / `<user>`；设置页开关可覆盖 |
| `memoryEnabled` | `true` | 注入 `<memory>`（同时是全局/项目两个开关的默认值）；设置页开关可覆盖 |
| `subagentProjectOnly` | `true` | 子代理只注入项目记忆 |
| `maxChars` | `8000` | 单文件注入字符上限 |
| `maxFactLines` | `100` | 全局 FACT.md 行数硬上限 |
| `maxFactBytes` | `8000` | 全局 FACT.md 字节硬上限（UTF-8） |
| `maxProjectChars` | `8000` | 项目 MEMORY.md 字符硬上限 |
| `compactionEnabled` | `false` | **压缩管线总开关（0.8.0）**：关闭时写路径与 0.7.0 逐字节相同 |
| `compactProvider` | `''` | 合并用的 provider（空 ⇒ 不做 LLM 合并，只淘汰） |
| `compactModel` | `''` | 合并用的 model（空 ⇒ 同上） |
| `compactKeepBackups` | `5` | `memory/backups/` 里每份文件保留的备份数 |
| `panelPath` | `/persona-memory` | 面板 HTTP 前缀 |

`personaEnabled` / `memoryEnabled` 现在是**默认值**：设置页把用户显式设过的开关写进 `injection.json`，覆盖层优先。`globalMemory` / `projectMemory` 在覆盖层里各自独立，但默认都取 `memoryEnabled`。

## 压缩管线（0.8.0 · 默认关闭）

水位 85% → FACT 合并（LLM）→ 仍 ≥100% 淘汰（最多 5 条，投影到 ≤75%）→ 仍 ≥100% 返回 `MEMORY_BUDGET_EXCEEDED`。MEMORY.md 只淘汰、不合并。

- 手动：`/memory-compact <fact|memory|all> [dry]`、`/memory-compact rollback <yyyyMMdd-HHmmss>`
- 面板：`GET /api/memory/compaction`、`POST /api/memory/lock`、`POST /api/memory/unlock`
- 保护区只认**人工锁定**（`memory/locks.json`）与正文里的 `<!-- keep -->`；`★` 不是保护信号
- 侧车索引 `memory/index.json` 缺失/损坏 ⇒ 淘汰整体跳过（宁可不压缩，也不盲删）
- 审计 `memory/compaction.jsonl`；备份 `memory/backups/<file>-<yyyyMMdd-HHmmss>.bak`（保留 5 份，SHA256 校验后才回滚）

## 首次运行

建 `$DSH_HOME/memory/FACT.md`（模板，若不存在）；角色库为空时建 `personas/default/`，迁移旧 `$DSH_HOME/memory/{SOUL.md,USER.md}` 内容（旧文件保留），并设为当前角色。

## 技能：persona-creator

正本在 `skills/persona-creator/SKILL.md`，**不注册为技能、不进 tarball**。安装 = 拷到 `$DSH_HOME/personas/skills/persona-creator/SKILL.md`，并由 `personas/README.md` 以相对路径指向。发现通路：`persona` 工具描述 → 角色库 → README → 技能文件。

## 改源码后为何仍是旧行为

DSH 不监听 `node_modules`，Node 缓存 ESM 模块。改 `lib/*.js` 必须重启 DSH；改 `cordis.yml` / `cordis.patch.yml` 才可能热生效。自检：`Select-String ... -Pattern 'interpolate: false'` 看磁盘版本，`Get-Process` 看 Host 启动时间。改已安装副本时用「拷临时文件 → 删原文件 → 移回」，避免硬链接写穿 pnpm store。

## 测试

```powershell
node test/scope.test.mjs
node test/settings.test.mjs
node test/fact-limit.test.mjs
node test/fact-bytes.test.mjs
node test/project-limit.test.mjs
pwsh -File test/run-all.ps1   # 其余需真实宿主渲染器/cordis 的用例
```

覆盖：注入作用域、插值安全（`interpolate: false`）、注入开关与设置项注册表、FACT 行数/字节上限、项目字符上限与 8000/8001 边界不变量、真实 `renderPrompt()`、真实 cordis 全链路、快照续接、真实 `$DSH_HOME` 数据。

## 已知边界

- `complete: true` 的预设（如 `minimal`）替换整个系统提示词，段落注入不进去。
- 设置页开关只管**注入**：关掉全局记忆后，`memory action=read/update, scope=global` 仍然可用（工具契约仍按开关裁剪提示，不会主动引导）。
- 设置页的扩展项注册表是**进程内**的：附属插件没装载时项自然消失；值持久化由注册方自己负责，本插件只存三个内置开关。
- 快照不随会话删除回收，`snapshots/` 会留小 JSON。
- 面板「项目」列表来自本进程见过的会话 cwd。
- 历史遗留的超限 FACT.md / MEMORY.md 不会被自动改写，`read` 附警告，其后写入被拒。
- 日志不注入，契约指针是提示不是保证，稳定结论请写进 FACT.md。

## 仓库结构

`lib/` 为唯一源码（纯 ESM，无构建链）：`lib/index.js`（宿主半）、`lib/client.js`（客户端半）、`lib/types/index.d.ts`。另有 `test/*.mjs`、`skills/persona-creator/SKILL.md`、`cordis.patch.yml`（组合包层）。

## 协议

MIT License，见 [LICENSE](./LICENSE)，版权人 `hu568`（https://github.com/hu568）。