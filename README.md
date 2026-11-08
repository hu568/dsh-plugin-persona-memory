# @dsh-external/dsh-persona-memory

DSH 的**角色设定 + 长期记忆**管理插件，注册在**宿主组合**里，对所有 agent 预设的每个会话生效。

| | |
|---|---|
| 许可证 | MIT，见 [LICENSE](./LICENSE) |
| 安装规格 | `github:hu568/dsh-plugin-persona-memory` |
| 实测 DSH | `0.1.5-rc.1` ~ `0.2.2-rc.1`（末项为 Android / proot Linux 实测） |
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

### 装完不用重启，改源码才要重启

`dsh plugin add` 除了装依赖，还会把包名追加进 profile 的 `dsh.profile.bundles`；运行中的引擎由 HMR
监听这份清单，重载对应的组合层。实测（DSH `0.2.2-rc.1`，Android / proot Linux）：

- 引擎进程（同一 PID）没有重启，安装完成后**下一次模型请求**的系统提示词里就出现了
  `memory:soul` / `memory:user` / `memory:facts`，`memory` / `persona` 工具同轮可用；
- 首条快照随即写入 `$DSH_HOME/memory/snapshots/<sessionId>.json`，`personas/` 与 `memory/` 同时 seed；
- 但改 `node_modules/` 里的 `lib/*.js` 仍然要重启：HMR 只监听 profile 清单与补丁文件，不监听
  `node_modules`，ESM 也有模块加载缓存。

### 安装时两条容易被误读的输出

| 输出 | 真实含义 |
|---|---|
| `Issues with peer dependencies found`（`cordis` / `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-system-prompt`） | 这三者不在 profile 的 `node_modules` 里就会报，**可忽略**：本插件运行时不解析它们，`lib/*.js` 的裸模块引用只有 `schemastery`（别名安装，已 hoist 到 profile），其余全是 `node:*`。它们是给宿主看的契约与类型。 |
| 客户端半没出现在界面上 | 右侧栏「角色 / 记忆」与设置页「记忆」注册在 `sidebar.right.pane.tab` / `settings.section`，是 **Harness Web UI** 的槽位。dsh-go 这类 Flutter 原生客户端没有这些槽位，手机上只有宿主侧生效（工具 + 提示词注入 + HTTP 路由），面板本身不渲染；要看面板请到 `http://127.0.0.1:<port>` 的网页端。 |

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

## 并发写入：整篇覆盖的乐观锁（0.8.4）

FACT.md / MEMORY.md 有两类写者，它们的语义完全不同：

| 写者 | 语义 | 锁 |
|---|---|---|
| `insertEntry` / `replaceEntry` / `deleteEntry`（自动沉淀、压缩管线） | 条目级「读 → 改 → 写」 | 写锁内，安全 |
| `memory action=update` / 面板保存 | **整篇覆盖**（门外的旧正文 + 新正文） | 0.8.4 起取写锁 + 核对 revision |

0.8.3 及以前，整篇覆盖不取锁也不核对版本：读完之后只要有人插入过一条，整篇覆盖就把它**静默抹掉**——不报错、不回滚，只表现为「记忆神秘地少了一段」。

现在的规则：

- `contentRevision(text)` = `sha256(文件正文原文)` 前 16 位（不做换行归一化，必须与 `readText()` 逐字可比）；
- `memory action=read` 在 FACT 段与项目段回带 `revision <16 位>`；
- `memory action=update` 可带 `expectedRevision`：与磁盘不一致 ⇒ 抛 `MEMORY_REVISION_CONFLICT`（`status: 409`），**一个字节都不写**，错误文案要求「重新读取 → 合并 → 再写」；
- 不带 `expectedRevision` ⇒ 行为与旧版一致（仍会取写锁，只少了版本核对）；
- 面板保存回传 `baseRevision`：面板开着期间模型写过，保存会被拒并在 toast 里说明，草稿保留在编辑器里（顶栏「重新读取」可强制刷新）；
- 冲突是**正常控制流**，不是坏件：重读合并即可，工具描述里写明了这一点，避免模型把 409 当故障反复重试同样的内容。

## 注入时机

首条用户消息前每轮读盘；首条消息后固化成本会话快照（内存 + 落盘），此后读快照，KV 缓存前缀稳定。快照不含日志正文，只留 `journalTotal` 计数。子代理快照只留内存。resume / 重启语义不变。

## 工具

- `memory`：`read`（全局 + 项目 + 最近日志，报告体量/上限与 `revision`）、`update`（整篇覆盖，`scope=global|project`，超限报错；可选 `expectedRevision` 乐观锁）、`append`（追加 `{ts,tags,text}`）、`search`（子串 + 可选 tag，新→旧）。
- `persona`：`list` / `current` / `show` / `use`（新会话生效）/ `create` / `update` / `delete`（当前角色不可删）。

均全局注册、无路径参数，走进程内 `node:fs`。

## 面板

右侧栏「角色 / 记忆」标签页。**入口在右侧栏的入口页（guide）里**：点对话头部「打开右侧边栏」，再点「角色 / 记忆」（0.8.5 起；0.8.4 及更早是对话头部右上角的「角色」按钮，已在 0.8.5 移除）。HTTP 前缀由 `config.panelPath` 决定（默认 `/persona-memory`；客户端 `BASE` 写死，改前缀需两半同改）。

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

## 压缩管线（0.8.3 · 默认开启）

水位 85% → 合并（LLM）→ 逐条精简（LLM）→ 仍 ≥100% 淘汰（最多 5 条，投影到 ≤75%）→ 仍 ≥100% 返回 `MEMORY_BUDGET_EXCEEDED`。

**85% 与 100% 是两件事**：85% 只是「进入压缩流程」的门槛（此时只合并/精简）；真正删条目要求合并+精简后仍 **≥100%**。所以 7998/8000 字符（99.975%）**不会删任何东西**，这是设计而不是失效。

**没有合并、精简、淘汰时绝不写盘**：`splitLines` / `joinLines` 会把「结尾多一个空行」归一化掉，那不是压缩 —— 不写文件、不备份、不记审计（0.8.0 修）。

合并规则：
- **FACT.md**：同一 `## 分组` 里语义相近的 2–10 条 `- ` 条目交给 LLM 合并成一条（保留版本号/路径等具体值，结果必须变短）。
- **MEMORY.md**：条目 = 编号行（`1.`）**或顶层（缩进 0）的 `- ` 列表项**（真实项目记忆常常整篇 bullet 化；更深缩进的 `- ` 是子项）。只合并「同一分组里**没有子项**的叶子条目」：编号条目合并后**保留编号与缩进**并把空洞重排成连续编号，bullet 条目合并后仍是 `- `；**带子项的条目只淘汰、绝不合并**（合并会拆坏层级）；`## 速查` 里的列表项是参考数据，不参与合并/淘汰/回填。

### 逐条精简（0.8.2 起）：为什么还需要这一层

合并层要求「同一分组内两两相似度 ≥ 0.7」。真实手写记忆里**每条都是一个独立事实**（不同的命令、字段、坑），本机 Astrbot 的 43 条叶子条目在阈值 0.7 / 0.6 / 0.5 / 0.4 下实测**都是 0 组** —— 提示词写着却一次都调不到模型，用户看到的就是「有 LLM 能力却压不动」。

精简层不依赖相似度，只要求「条目够长」：
- 按 `## 分组` 顺序分批（默认 10 条/批，单次压缩最多 8 批）交给 LLM，**输出的行数必须与输入一一对应**；
- 每条必须真的变短（**正文 + 搬进速查区的项**合计比原文短），且**具体值（版本号 / 路径 / 命令 / 数字）一个都不许丢**；
- 某一条不合格只跳过那一条（保留原样），不连坐整批；整批行数不符则整批放弃；
- 因为是 1 对 1 改写，**编号、缩进、子项、条目数全部原样保留**，不需要重排编号；
- 与合并层同样只碰**叶子条目**：带子项的条目连模型都不调。

### 正文少行内代码 + 命令进「速查」（0.8.3 修）

0.8.2 的实测缺陷：Astrbot 的 33 条候选**全部含反引号**，而校验器把 `` `…` ``（连反引号）当成必须逐字保留的「具体值」⇒ 任何「正文去行内代码」的改写都被判「丢了具体值」，两轮 `/memory-compact` 各花 100+ 秒调 LLM，**一条改写都没通过**，只剩淘汰在删条目。同时提示词写的是「≤120 字」，比 MEMORY 条目模板（≤200 字）还严。

0.8.3 起的口径（对齐 PLAN 01 §3.2「正文禁止行内代码，命令/路径一律进末尾的「## 速查」区」）：

- **提示词**：MEMORY 要求按 `正文‖速查项` 两段式输出 —— 正文用中文说人话、不许有反引号、≤200 字；速查项是该条里要逐字照抄的命令 / 路径 / 包名 / 配置字段，用「·」分隔。
- **校验**：反引号**不是信息**，比较前一律脱掉（`normalizeForCompare()`）；具体值只要出现在「正文 + 速查项」里就算保留。正文里模型残留的反引号会被程序脱掉；真丢了版本号 / 路径仍然拒。
- **落盘**：速查项渲染成 `- 项`（纯文本清单，不加反引号）追加到 `## 速查` 区（没有就新建，同项去重），正文行替换为改写后的版本；审计的 `merged[].quick` 记下每条搬走了什么。
- **FACT**：没有速查区，正文同样去反引号，上限仍是 120 字。

两层共用一次 pre-image 与一个 `callModel`：先合并相似条目，被合并吃掉的条目不再参与精简；写盘后立刻 `syncIndexAfterWrite` 把侧车索引同步成新正文（否则改写后的条目 id 全变孤儿，下一轮会报「缺元数据」而 0 候选）。

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

```bash
node test/run-all.mjs   # 一条命令跑全量：逐个跑 test/*.test.mjs 并汇总
```

`test/run-all.mjs` 只用 node 内置模块，Windows / Linux / Android(proot) 通用，不依赖 PowerShell 或 Electron。
开跑前会调用 `test/ensure-deps.mjs`：缺 `schemastery` / 宿主包时自动从本机现有副本建符号链接（缺才补，失败只警告）。
需要真实宿主包（`cordis` / `@deepseek-ai/dsh-system-prompt`）的用例由 `test/_host-paths.mjs` 自动探测：
`DSH_ASAR_ROOT` → `/opt/dsh/node_modules/@deepseek-ai` → `$DSH_HOME/profiles/*/node_modules/@deepseek-ai` → 旧 Windows asar 路径。
单独跑某个用例：`node test/scope.test.mjs`。

覆盖：注入作用域、插值安全（`interpolate: false`）、注入开关与设置项注册表、FACT 行数/字节上限、项目字符上限与 8000/8001 边界不变量、面板跟随工作区（`/api/state?cwd=` + 工作区注册表 + 压缩默认开启）、真实 `renderPrompt()`、真实 cordis 全链路、快照续接、真实 `$DSH_HOME` 数据、压缩管线（合并/淘汰/回填/无操作不写盘/命令 kind）、整篇覆盖的乐观锁（revision 冲突拒写且文件一字不动 / 读后别人插入不丢 / 并发两写者只成功一个 / 工具层 read-front-update 闭环）。

## 已知边界

- `complete: true` 的预设（如 `minimal`）替换整个系统提示词，段落注入不进去。
- 设置页开关只管**注入**：关掉全局记忆后，`memory action=read/update, scope=global` 仍然可用（工具契约仍按开关裁剪提示，不会主动引导）。
- 设置页的扩展项注册表是**进程内**的：附属插件没装载时项自然消失；值持久化由注册方自己负责，本插件只存三个内置开关。
- 快照不随会话删除回收，`snapshots/` 会留小 JSON。
- 面板项目记忆固定跟随主视图会话的工作区（DSH 工作区注册表 + 会话 cwd 解析，0.7.1 起），没有手动选择项目的下拉框。
- 历史遗留的超限 FACT.md / MEMORY.md 不会被自动改写，`read` 附警告，其后写入被拒。
- 日志不注入，契约指针是提示不是保证，稳定结论请写进 FACT.md。

## 仓库结构

`lib/` 为唯一源码（纯 ESM，无构建链），0.8.1 起宿主半按职责拆成多个模块，`lib/index.js` 只留插件声明与 `apply` 装配：

| 模块 | 职责 |
| --- | --- |
| `lib/index.js` | `name` / `inject` / `Config` 再导出 + `apply()`：注册提示词段落、工具、命令、面板路由 |
| `lib/config.js` | 注入作用域、默认上限、Cordis `Config` 模式 |
| `lib/paths.js` | 角色库 / 记忆目录 / 快照 / 注入开关的路径与文件名常量 |
| `lib/injection.js` | 设置页注入开关覆盖层（`memory/injection.json`） |
| `lib/persona-store.js` | 角色库读写、排序与模板 |
| `lib/seed.js` | 首次运行建目录 / 迁移旧版文件 |
| `lib/snapshot.js` | 会话注入快照（首条消息固化、落盘、子代理判定） |
| `lib/prompt-render.js` | 提示词段落渲染与写入契约文案 |
| `lib/tools.js` | `memory` / `persona` 两个模型工具 |
| `lib/settings-registry.js` | 设置页「记忆」分组的扩展点 |
| `lib/workspace.js` | 工作区注册表读取、cwd → project 记忆发现 |
| `lib/compaction-wiring.js` | 压缩用的 cwd / 会话 / 模型路线接线 |
| `lib/compact-command.js` | `/memory-compact` 命令与结果文案 |
| `lib/panel.js` | 右侧栏面板与设置页的 HTTP API |

其余：`lib/store.js`（存储层）、`lib/compaction.js`（压缩管线）、`lib/locks.js`（条目写锁）、`lib/client.js`（客户端半，手写 ModuleLoader 单文件包）、`lib/types/index.d.ts`。另有 `test/*.mjs`、`skills/persona-creator/SKILL.md`、`cordis.patch.yml`（组合包层）。

## 协议

MIT License，见 [LICENSE](./LICENSE)，版权人 `hu568`（https://github.com/hu568）。