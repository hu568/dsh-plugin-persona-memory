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
- **记忆**：全局 FACT.md、项目 MEMORY.md 编辑。项目记忆**跟随当前会话的工作区**：面板把主视图会话的 cwd 带到 `GET /api/state?cwd=…`，切换工作区后自动切到对应项目。**没有项目下拉框**——项目固定由工作区决定，避免出现“选中项和实际注入不一致”。
- **日志**：最近条目、追加、检索（点 `#tag` 即搜）。
- **交互**：计量条（行数/字节/字符，接近上限变琥珀、超限变红，分母为默认值）、未保存徽标 + 撤销、`Ctrl/Cmd+S` 保存、`Ctrl/Cmd+Enter` 追加、错误 toast。
- **样式**：注入一张 `<style id="dsh-persona-memory-panel-style">`，类名 `.dpm-*`；同页面重载不刷新 CSS，验收请整页刷新。

```
GET  /persona-memory/api/state?cwd=<当前工作区>   # cwd 可省略（旧客户端）
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
| `compactionEnabled` | `true` | **压缩管线总开关（0.8.0）**：默认开启，`/memory-compact` 与写前水位压缩都可用；关闭时写路径与 0.7.0 逐字节相同 |
| `compactProvider` | `''` | 合并用的 provider（空 ⇒ **继承会话模型**；见下节） |
| `compactModel` | `''` | 合并用的 model（空 ⇒ 同上；与 provider 必须同时填才生效） |
| `compactKeepBackups` | `5` | `memory/backups/` 里每份文件保留的备份数 |
| `panelPath` | `/persona-memory` | 面板 HTTP 前缀 |

`personaEnabled` / `memoryEnabled` 现在是**默认值**：设置页把用户显式设过的开关写进 `injection.json`，覆盖层优先。`globalMemory` / `projectMemory` 在覆盖层里各自独立，但默认都取 `memoryEnabled`。

## 压缩管线（0.8.0 · 默认开启）

水位 85% → 合并（LLM）→ 仍 ≥100% 淘汰（最多 5 条，投影到 ≤75%）→ 仍 ≥100% 返回 `MEMORY_BUDGET_EXCEEDED`。

**85% 与 100% 是两件事**：85% 只是「进入压缩流程」的门槛（此时只合并）；真正删条目要求合并后仍 **≥100%**。所以 7998/8000 字符（99.975%）**不会删任何东西**，这是设计而不是失效。

**没有合并、也没有淘汰时绝不写盘**：`splitLines` / `joinLines` 会把「结尾多一个空行」归一化掉，那不是压缩 —— 不写文件、不备份、不记审计（0.8.0 修）。

合并规则：
- **FACT.md**：同一 `## 分组` 里语义相近的 2–10 条 `- ` 条目交给 LLM 合并成一条（保留版本号/路径等具体值，结果必须变短）。
- **MEMORY.md**：条目 = 编号行（`1.`）**或顶层（缩进 0）的 `- ` 列表项**（真实项目记忆常常整篇 bullet 化；更深缩进的 `- ` 是子项）。只合并「同一分组里**没有子项**的叶子条目」：编号条目合并后**保留编号与缩进**并把空洞重排成连续编号，bullet 条目合并后仍是 `- `；**带子项的条目只淘汰、绝不合并**（合并会拆坏层级）；`## 速查` 里的列表项是参考数据，不参与合并/淘汰/回填。

### 合并用哪个模型

1. 配置里显式填了 `compactProvider` + `compactModel` ⇒ 用它；
2. 留空 ⇒ **继承会话模型**：读本会话最近一次请求的 `session.requestHeader().config`（provider/model）；
3. 会话还没跑过请求（拿不到）⇒ 退宿主的默认模型（`agentDefaultModel` 服务）。

三处都拿不到 ⇒ 这次只淘汰、不合并（不会因为没有模型就失败）。

默认开启（0.7.1 起）：`/memory-compact` 装上即可用，不再需要先改配置；没配 `compactProvider` / `compactModel` 时按「继承会话模型」取路线（0.8.0 起）。想恢复 0.7.0 的纯写入行为，把 `compactionEnabled` 设为 `false`（命令与面板入口会一并拒绝）。

- 手动：`/memory-compact`（不带参数 = 压缩当前工作区的项目 `MEMORY.md`）、`/memory-compact [fact|memory|all] [dry] [seed]`、`/memory-compact rollback <yyyyMMdd-HHmmss>`
- 手动命令的结果里带**实际目标路径**；任一 scope 失败 ⇒ 命令 `kind: 'error'`（`all` 里一个成功一个失败时逐项标明，不误报 success）
- `seed`：先回填侧车索引（见下），只写 `memory/index.json`，不删任何正文；`seed dry` 只列计划。终于能压「手写 / 整篇写入」的老文件了
- 面板：`GET /api/memory/compaction`、`POST /api/memory/lock`、`POST /api/memory/unlock`
- 保护区只认**人工锁定**（`memory/locks.json`）与正文里的 `<!-- keep -->`；`★` 不是保护信号
- 侧车索引 `memory/index.json` 缺失/损坏 ⇒ 淘汰整体跳过（宁可不压缩，也不盲删）；命令会如实说「缺元数据 N 条」并提示先 `seed`
- 索引维护：`memory action=update` 与面板保存这些**整篇写入**也会同步索引（0.8.0 起）—— 未变条目保留原元数据、新条目 `firstSeen=now / hits=1 / confidence=medium`、孤儿自动清掉
- `seed` 回填的是**冷元数据**：`firstSeen = lastHit = 文件 mtime`、`hits = 0`、`confidence = low`（所有手写条目分数接近 ⇒ 同分时**从文件尾部开始删**：开头是身份/铁律/当前结论，尾部是历史与索引；先 `dry` 看计划，真删仍受锁定 / `<!-- keep -->` / 备份 / 回滚保护）
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
node test/panel-workspace.test.mjs
node test/compaction.test.mjs
pwsh -File test/run-all.ps1   # 其余需真实宿主渲染器/cordis 的用例
```

覆盖：注入作用域、插值安全（`interpolate: false`）、注入开关与设置项注册表、FACT 行数/字节上限、项目字符上限与 8000/8001 边界不变量、面板跟随工作区（`/api/state?cwd=` + 工作区注册表 + 压缩默认开启）、真实 `renderPrompt()`、真实 cordis 全链路、快照续接、真实 `$DSH_HOME` 数据、压缩管线（合并/淘汰/回填/无操作不写盘/命令 kind）。

## 已知边界

- `complete: true` 的预设（如 `minimal`）替换整个系统提示词，段落注入不进去。
- 设置页开关只管**注入**：关掉全局记忆后，`memory action=read/update, scope=global` 仍然可用（工具契约仍按开关裁剪提示，不会主动引导）。
- 设置页的扩展项注册表是**进程内**的：附属插件没装载时项自然消失；值持久化由注册方自己负责，本插件只存三个内置开关。
- 快照不随会话删除回收，`snapshots/` 会留小 JSON。
- 面板项目记忆固定跟随主视图会话的工作区（DSH 工作区注册表 + 会话 cwd 解析，0.7.1 起），没有手动选择项目的下拉框。
- 历史遗留的超限 FACT.md / MEMORY.md 不会被自动改写，`read` 附警告，其后写入被拒。
- 日志不注入，契约指针是提示不是保证，稳定结论请写进 FACT.md。

## 仓库结构

`lib/` 为唯一源码（纯 ESM，无构建链）：`lib/index.js`（宿主半）、`lib/client.js`（客户端半）、`lib/types/index.d.ts`。另有 `test/*.mjs`、`skills/persona-creator/SKILL.md`、`cordis.patch.yml`（组合包层）。

## 协议

MIT License，见 [LICENSE](./LICENSE)，版权人 `hu568`（https://github.com/hu568）。