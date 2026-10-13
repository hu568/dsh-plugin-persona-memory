# @dsh-external/dsh-persona-memory

DSH 的**角色设定 + 长期记忆**管理插件。替换掉 0.1.5 之前那套「预设级记忆加载器」
（`memory` / `memory-boot` / `ptc-memory` 三个 agent 预设 + `router-standard` 内嵌的
`memory-loader`）——那些只在选中对应预设时才注入，新方案注册在**宿主组合**里，
对**所有 agent 预设**的每个会话生效。

| | |
|---|---|
| 许可证 | MIT，见 [LICENSE](./LICENSE) |
| 安装规格 | `github:hu568/dsh-plugin-persona-memory` |
| 实测 DSH | `0.1.5-rc.1` ~ `0.2.0-rc.2` |
| peer 要求 | `cordis >=4.0.0-rc <5`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-system-prompt`（随 DSH 提供） |
| 运行依赖 | `schemastery`（别名安装 `npm:@deepseek-ai/schemastery@3.18.2`，从 npm registry 拉取） |

## 安装

```powershell
# DSH 内置插件管理器（创造模式）：
#   plugin_manager  action=install_bundle  target="github:hu568/dsh-plugin-persona-memory"

# 或命令行。桌面端（Electron）profile 由应用独占管理，请改用插件管理器或「设置 → 插件」：
dsh plugin --profile <profile> add github:hu568/dsh-plugin-persona-memory
```

安装后本包被追加进 profile 的 `dsh.profile.bundles`，其 `cordis.patch.yml` 作为组合包层
把 `persona-memory` 这一行插进**宿主组合**。profile 在运行中通常即时生效，否则重启一次 DSH。

验证：

```powershell
dsh --profile <profile> --dump-config     # 应出现以本包名为标题的层与 persona-memory 行
```

也可以在 agent 里直接 `GET /persona-memory/api/state`：返回 `200` + `ok: true` 说明面板路由已注册。

卸载：

```powershell
dsh plugin --profile <profile> remove @dsh-external/dsh-persona-memory
```

卸载不会删除角色库与记忆文件（`$DSH_HOME/personas`、`$DSH_HOME/memory`），需要时手动清理。

> **更新时注意**：DSH 通过 profile 依赖差分识别「这次装的是哪个包」。若内容变了但安装规格字符串
> 没变，会报 `ambiguous-install`；请先 `remove` 再 `add`，或让版本号/文件名变化。

## 它解决什么

| 平面 | 位置 | 说明 |
|------|------|------|
| 角色设定 | `$DSH_HOME/personas/<id>/{persona.yml,SOUL.md,USER.md}` | 角色库，同一时刻一个「当前角色」 |
| 全局记忆 | `$DSH_HOME/memory/FACT.md` | 跨会话、跨项目的稳定事实；**写入硬上限 100 行 / 8000 字节** |
| 长期日志 | `$DSH_HOME/memory/JOURNAL.jsonl` | 一次性事件/会话笔记，仅追加 + 可检索；**不注入提示词** |
| 项目记忆 | `<项目根>/MEMORY.md` | 随项目走；**存在才注入**，不自动创建；**写入硬上限 8000 字符** |
| 会话快照 | `$DSH_HOME/memory/snapshots/<sessionId>.json` | 首条消息时固化的注入内容 |

注入的东西（提示词段落，顺序紧贴部署人格之后）：

- `memory:soul` → `<soul persona="…" id="…">` + 角色编辑契约
- `memory:user` → `<user persona="…">`
- `memory:facts` → `<memory>` 全局 + 项目 + 记忆写入契约

> **段落名为什么用 `memory:` 前缀**：用户自建的 `router-standard` 预设会在精简模式里
> 剥掉除 `memory:*` 外的全部段落。沿用这个前缀，角色与记忆在那种模式下也能存活，
> 不需要改预设里的剥离逻辑。

> **为什么都设 `interpolate: false`**：宿主 `@deepseek-ai/dsh-system-prompt` 的
> `renderPrompt()` 会对未标记的段落做 `{{变量}}` 插值，而 `interpolate()` 对
> **未注册的名字是抛错**（不是原样保留）——它认为「malformed prompt 比响亮地失败更糟」。
> 本插件的段落内容全是用户可写的自由文本（FACT.md、SOUL.md…），
> 只要哪篇记忆里写了一句 `{{变量}}`，整个 turn 就会以
> `malformed prompt variable reference "{{变量}}" in section "memory:facts"` 失败。
> 因此这些段落一律 `interpolate: false`：**内容原样进提示词，`{{…}}` 不再有特殊含义**。

## 长期日志：不注入，只按需检索

`JOURNAL.jsonl` 是**无上限增长**的流水账。0.1.x 曾把最近 6 条注入 `<journal>` 段落，
0.2.0 起**整段移除**，代价与收益：

| | 0.1.x（注入最近 6 条） | 0.2.0（不注入） |
|---|---|---|
| 每轮 token | 每轮都为最近 6 条付费，随文件增长 | 0（快照里也不存了） |
| 内容相关性 | 最近几条常常与当前任务无关 | 由模型自己判断要不要查 |
| 快照体积 | 随日志增长 | 恒定 |
| 取旧笔记 | 自动到手 | 要模型主动 `memory action=search` |

**不至于「忘了自己有历史」**：记忆契约里留了一行指针，写明日志有多少条、正文未注入，
并明确要求模型在觉得「以前可能聊过 / 踩过坑」时主动 `action=search`。子代理契约里也有一行。

日志的**写与读能力完全保留**：`memory` 工具的 `append` / `search` / `read`、
面板的「日志」标签页、`/api/journal/{append,search}` 路由都照旧可用。
变的只是「不再自动灌进上下文」。

> 旧 profile 里若写了 `journalEnabled` / `journalInject` / `journalLimit`，删掉即可 ——
> `schemastery` 对未知键是静默保留不抛错，留着也不会让插件起不来（实测）。

## 写入体量硬上限（全局行数 + 字节，项目字符）

三个平面各有闸口，都在**写入侧**卡住（超限**抛错拒绝，不落盘**，绝不静默截断）：

| 文件 | 闸口 | 默认 | 依据 |
|---|---|---|---|
| 全局 `FACT.md` | 行数 **AND** 字节（UTF-8） | `100` 行 / `8000` 字节 | 注入**每个主会话**，最坏开销要可预测 |
| 项目 `MEMORY.md` | 字符 | `8000` 字符 | 与注入侧 `maxChars` 同口径 |
| 长期日志 `JOURNAL.jsonl` | **无上限**（有意） | — | 不注入提示词，是流水账的去处 |

### 全局 FACT.md：100 行 AND 8000 字节

FACT.md 是**所有项目、所有主会话**都要注入的提示词段落。项目专属结论一旦写进来，
就变成每个项目、每一轮都要付的固定开销，还会把真正「跨项目稳定」的事实挤出去。

只卡行数是**不够的**：行长完全自由 ⇒ 100 行可以写 7 KB，也可以写 20 KB。
0.4.0 起两个闸口**同时生效**，任一超限即拒写：

| 入口 | 行为 |
|---|---|
| `memory action=update, scope=global` | 行数 > `maxFactLines` **或** 字节 > `maxFactBytes` ⇒ **抛错拒绝** |
| 面板 `POST /api/memory/save`（`scope=global`） | 同一道闸口，避免从面板绕开 |
| `memory action=read` | 报告「当前行数 / 上限，当前字节 / 上限」，已超限时附警告 |
| 记忆契约（进提示词） | 事先写明双上限，并要求「本工作区的内容一律写 `scope=project`」 |

**为什么 8000 字节**：本机实测真实文风约 **75.9 B/行**（4,100 B / 54 行）⇒
`80 B/行 × 100 行 = 8000 B` 是贴合真实文风、略留余量的取值。满配约 **≈2,560 tokens**
（实测换算比 0.3205 tok/字节），把最坏情况钉住。

字节口径：**UTF-8**（中文 3 字节/字），且先做 `\r\n` → `\n` 归一化
（与 `countLines()` 同口径，不把 `\r` 算进去）。

### 项目 MEMORY.md：8000 字符（补上原本缺失的一侧）

0.4.0 之前这里是**不对称**的：

| 侧 | 0.3.0 行为 |
|---|---|
| **注入侧** | 有闸口 —— `maxChars` 默认 8000，超出被 `clip()` **静默截断** |
| **写入侧** | **完全没有** —— `scope=project` 的 `update` 不校验体量 |

⇒ 「写的时候不拦，读的时候悄悄截断」：文件里会有一大段内容模型**永远看不到**，
而写入时毫无警示。这正是本插件明确反对的模式（静默截断等于悄悄丢用户内容），
此前只堵了 global 一侧。0.4.0 补上：

| 入口 | 行为 |
|---|---|
| `memory action=update, scope=project` | 字符 > `maxProjectChars`（默认 8000）⇒ **抛错拒绝**，并指向 `action=append` |
| 面板 `POST /api/memory/save`（`scope=project`） | 同一道闸口 |
| `memory action=read` | 报告项目记忆的「当前字符 / 上限」，已超限时附警告 |
| 主会话契约 + 子代理契约 | 都事先写明项目记忆上限 |

单位用**字符**，与注入侧 `maxChars` **逐字同口径**（都取 `trim()` 后的 JS 字符串长度，
`\r\n` 按 2 个字符算、不做归一化）⇒ 「通过写入闸口」即「必然不会被注入侧截断」，
边界正好落在 8000 与 8001 之间。中文按字符算（3000 个汉字 = 3000 字符）。

**JOURNAL.jsonl 故意不设上限**：它是无上限增长的流水账、且**不注入提示词**，
body 不进上下文 ⇒ 加限制只会逼用户丢历史。要写长内容就往这里写。

## 注入作用域：子代理只拿项目记忆

| 段落 | 主会话 | 子代理会话 |
|---|---|---|
| `memory:soul` / `memory:user`（角色） | ✅ | ❌ 不注入 |
| `memory:facts` → 全局 FACT.md | ✅ | ❌ 不注入 |
| `memory:facts` → 项目 MEMORY.md | ✅ | ✅ 注入 |
| 长期日志 JOURNAL.jsonl | ❌ 一律不注入（0.2.0 起） | ❌ |

理由：子代理拿到的是一份**具体委派任务**。角色人设、跨项目全局事实、历史流水账
都与该任务无关，灌进去只会让子代理的上下文变宽、更容易跑偏；项目记忆才是它需要的
那部分（本仓库/本项目的约定与事实）。

判定「是不是子代理」读的是宿主真实写入的 `session.header`：`origin === 'subagent'`
优先，另外 `parentSession` 存在或 `delegationDepth > 0` 也认（兼容只写血缘的旧日志
与外部 provider）。宁可判多，也不要漏判后把主会话的角色灌进委派任务。

子代理只注入项目记忆时，写入契约也换成项目版：明确告诉它「全局记忆与角色未注入」，
并允许它**只读**地 `action=read` / `action=search` 去查全局记忆，而不是以为不存在。

想恢复旧行为（子代理与主会话注入完全相同）就设 `subagentProjectOnly: false`。

## 注入时机：首条消息快照冻结

- **首条用户消息之前**：每轮组装直接读盘 → 「先建会话 → 改角色/记忆 → 再发第一条消息」拿到最新内容。
- **首条用户消息之后**：把角色 + 记忆固化成本会话快照（内存 + 落盘），此后每轮读快照。
  于是 KV 缓存前缀绝对稳定，会话中途改文件不影响它，**新会话**才看到更新。
  快照里**不含**日志正文（0.2.0 起），只留一个 `journalTotal` 计数供契约措辞使用。
- 子代理会话的快照只留内存、不落盘（防止 `snapshots/` 随委派次数膨胀）。
- 快照落盘让 resume / 进程重启后语义不变。

## 工具

两个工具都是**全局注册**，没有路径参数，走进程内 `node:fs`（不受文件沙箱策略影响）：

### `memory`

| action | 作用 |
|--------|------|
| `read` | 读全局 FACT.md + 当前项目 MEMORY.md + 最近日志（两者都报告「当前体量 / 上限」） |
| `update` | 整篇覆盖写入。`scope=global` → FACT.md（**超 100 行或 8000 字节直接报错**）；`scope=project` → `<项目根>/MEMORY.md`（不存在则创建，**超 8000 字符直接报错**） |
| `append` | 向 JOURNAL.jsonl 追加一条 `{ts,tags,text}` |
| `search` | 按子串（可选 tag）检索日志，新→旧 |

### `persona`

| action | 作用 |
|--------|------|
| `list` / `current` / `show` | 列角色 / 看当前角色 / 读某角色三件套 |
| `use` | 切换当前角色（新会话生效） |
| `create` / `update` / `delete` | 新建 / 改 / 删角色（当前角色不允许直接删） |

## 技能

随包发布 `persona-creator`：按访谈流程把一个角色写成三件套，含质量检查清单。
用户说「给我创建个角色 / 新建角色 / 写个人设」时触发。

## 右侧栏面板

「角色 / 记忆」标签页（会话标题右侧的「角色」按钮打开）：

- **角色**：列表、切换当前角色、编辑 name/description/SOUL.md/USER.md、新建、删除
- **记忆**：全局 FACT.md 编辑；项目 MEMORY.md 编辑（按本进程见过会话的 cwd 发现的项目）
- **日志**：最近条目、追加、检索

面板走宿主注册的 HTTP 路由（前缀 `/persona-memory`，`config.panelPath` 可改）：

```
GET  /persona-memory/api/state
POST /persona-memory/api/persona/{show,use,save,delete,order}
POST /persona-memory/api/memory/save
POST /persona-memory/api/journal/{append,search}
```

> **实现注记**：取 `webServer` 服务时不能只用裸 `ctx.get('webServer')`。宿主 webserver 的
> fiber 要等 socket 绑定完成才 ACTIVE，而 cordis 的 `ctx.get()` 默认 `strict=true`（只认 ACTIVE
> 的服务），加上 Loader 并行启动 entry，插件 `apply` 常常早于它就绪，此时那个判空会静默跳过 ⇒
> 面板路由一条都不注册 ⇒ 面板永远 HTTP 404。本包的做法：拿不到就挂作用域
> `ctx.inject(['webServer'], …)` 等就绪后补注册。

## 配置

| 字段 | 默认 | 说明 |
|------|------|------|
| `personaEnabled` | `true` | 注入 `<soul>` / `<user>` |
| `memoryEnabled` | `true` | 注入 `<memory>` |
| `subagentProjectOnly` | `true` | 子代理会话只注入项目记忆（关掉＝子代理与主会话一致） |
| `maxChars` | `8000` | 单文件注入字符上限 |
| `maxFactLines` | `100` | 全局 FACT.md 的行数硬上限（写入时校验，超限报错） |
| `maxFactBytes` | `8000` | 全局 FACT.md 的字节硬上限（UTF-8；与 `maxFactLines` 同时生效） |
| `maxProjectChars` | `8000` | 项目 MEMORY.md 的字符硬上限（写入时校验，超限报错；与 `maxChars` 同口径） |
| `panelPath` | `/persona-memory` | 面板 HTTP 前缀 |

> 0.2.0 移除了 `journalEnabled` / `journalInject` / `journalLimit` 三个键 ——
> 长期日志不再进提示词，这些开关没有意义了。

## 首次运行会做什么

- 建 `$DSH_HOME/memory/FACT.md`（模板，若不存在）。
- 角色库为空时建 `personas/default/`：把旧版 `$DSH_HOME/memory/{SOUL.md,USER.md}`
  的内容迁进去（旧文件保留不动），并把 `default` 设为当前角色。

## 排错：改完 `lib/*.js` 为什么还是旧行为？

**因为 DSH 默认不监听 `node_modules`，而且 Node 会缓存已 import 的 ESM 模块。**
改完插件源码后，即使 `plugin_manager set_bundle enabled=true` 报告
`application: applied`，**正在运行的那个 Host 进程里仍是旧模块**——它只重新组合了
profile 补丁层（让 `persona-memory` 这一行重新挂上），并不会重新从磁盘 import
那份 `lib/index.js`。

具体机制（读宿主源码得到）：

- `dsh-hmr` 的默认 `ignored` 含 `**/node_modules`，而插件装在
  `profiles/<name>/node_modules/@dsh-external/...` 下 ⇒ 它**根本不在监听范围内**。
- base 组合包里 `hmr` 的 `config.root` 是 `[]`（见 `profiles/<name>/cordis.yml`），
  即「只看显式注册的配置文件，不做源码模块监听」。
- 模块一旦被 import 就进了 Node 的 ESM `loadCache`；不清缓存 + 重新 import，
  拿到的就是旧命名空间。

因此：**改了 `lib/*.js` 必须重启 DSH**（或让 `dsh-hmr` 真的能看见该文件并走
`partialReload()` 清缓存）。改 `cordis.yml` / `cordis.patch.yml` 这类配置才可能热生效。

自检「当前跑的是哪一版」：

```powershell
# 1) 磁盘上这份是不是新的
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@dsh-external\dsh-persona-memory\lib\index.js" -Pattern 'interpolate: false'

# 2) Host 主进程是什么时候起的（早于你改文件的时间 ⇒ 它跑的是旧代码）
Get-Process | Where-Object ProcessName -match 'DeepSeek' | Select-Object Id,StartTime
```

> **改已安装副本时的坑（实测）**：这个 profile 用 `nodeLinker: hoisted`，git 依赖的
> **文件**是硬链接到 pnpm store 的 —— 没改过的 `browser-use` 用 `fsutil hardlink list`
> 能看到 2 个链接（profile 路径 + store 路径）。所以**直接 `Copy-Item` 覆盖会写穿到
> store**，可能污染其他 profile。正确做法：
> `Copy-Item` 到临时文件 → `Remove-Item` 原文件（断开链接）→ `Move-Item` 回来。
> 改完 `fsutil hardlink list` 应只剩 1 个链接。

## 回归测试

```powershell
# 纯 node 那四条
node test/scope.test.mjs
node test/fact-limit.test.mjs
node test/fact-bytes.test.mjs
node test/project-limit.test.mjs
# 其余几条（要真实宿主渲染器 / 真实 cordis）用统一入口，会自动跑仓库源码 + 已安装副本
pwsh -File test/run-all.ps1
```

| 测试 | 验什么 |
|---|---|
| `scope.test.mjs` | 注入作用域：子代理只拿项目记忆；`subagentProjectOnly` 可回退；**日志段落不存在** |
| `fact-limit.test.mjs` | **FACT.md 行数硬上限**：上限内通过 / 超 1 行被拒且不落盘 / `read` 报告与超限警告 / 契约写明上限 / `maxFactLines` 可配 |
| `fact-bytes.test.mjs` | **FACT.md 字节硬上限**：行数没超但字节超也被拒 / 恰好 8000 B 通过 / 双超时两项都报 / UTF-8 3 字节每汉字 / `\r\n` 归一化 / 契约写明双上限 / `maxFactBytes` 可配 |
| `project-limit.test.mjs` | **项目 MEMORY.md 字符硬上限**：超限被拒且不落盘 / 恰好 8000 通过 / **边界不变量：8000 不被截断、8001 被截断** / 报错指向 `action=append` 与 `scope=global` / 中文按字符算 / 主会话与子代理契约都写明上限 / `maxProjectChars` 可配 |
| `host-interpolate.test.mjs` | 用**真实** `renderPrompt()` 验证 `interpolate: false` 生效；反证「摘掉它就会复现用户的报错」 |
| `cordis-integration.test.mjs` | 真实 `Context` + 真实 `system-prompt` 全链路（section 注册 → assemble → render） |
| `snapshot-resume.test.mjs` | 已固化快照的续接路径；旧快照里的 `journal` 字段必须被忽略 |
| `real-data.test.mjs` | ★ 用**用户真实**的 `$DSH_HOME` 记忆与角色文件跑真实渲染，不抛错 |

覆盖两个曾经真实炸掉的点：① 段落必须 `interpolate: false`（记忆里出现 `{{变量}}`
不能让 turn 崩）；② 子代理只注入项目记忆，角色/全局记忆一律不注入，
且 `subagentProjectOnly: false` 能回退到旧行为。测试用临时 `DSH_HOME`，不碰真实数据。

## 已知边界

- **`complete: true` 的预设**（如内置 `minimal`）会把系统提示词替换成唯一一段，
  此时任何段落都注入不进去——那是该预设的语义，不是本插件的开关。
- 会话快照不随会话删除而回收；`snapshots/` 里会留小 JSON。文件很小，需要时手工清。
- 面板的「项目」列表来自本进程见过的会话 cwd；没有会话跑过的项目不会出现。
- **角色 / 全局记忆只在主会话注入**。子代理需要这些内容时，让它自己调
  `memory action=read` / `action=search`（只读）——注入面收窄是有意的。
- **长期日志任何会话都不注入**（0.2.0 起）。旧版本落盘的会话快照里可能还留着
  `journal` 字段，读快照时代码会忽略它 —— 无害，也可以直接删掉那些 JSON。
- 不注入日志 ≠ 模型自动会查。契约里的指针是**提示**不是保证：模型仍可能漏查。
  这是拿 token 换准确率的有意取舍 —— 想要「零漏查」请把稳定结论写进 FACT.md。
- **历史遗留的超限 FACT.md 不会被自动改写**：`read` 会附警告，其后任何 `scope=global`
  写入都会被拒。要么精简到上限内，要么把项目内容搬去 `scope=project`。
- **历史遗留的超限项目 MEMORY.md 同样不会被自动改写**：`read` 附警告，其后任何
  `scope=project` 写入都会被拒。想恢复可写，就得先精简到 `maxProjectChars` 以内
  （或临时把上限调大）——这是有意的：宁可写不进去，也不要静默截断。

## 仓库结构与源码

本仓库以 **`lib/` 为唯一源码**，纯 JavaScript（ESM），**不需要任何构建链**，克隆即可用：

| 路径 | 角色 |
|------|------|
| `lib/index.js` | 宿主半：服务注册、提示词段落、`memory` / `persona` 工具、面板 HTTP 路由 |
| `lib/client.js` | 客户端半：手写 ModuleLoader 包，注册右侧栏标签页 |
| `lib/types/index.d.ts` | 宿主半的类型声明 |
| `test/scope.test.mjs` | 注入作用域 + 插值安全的回归测试 |
| `test/fact-limit.test.mjs` | 全局 FACT.md 行数硬上限的回归测试 |
| `test/fact-bytes.test.mjs` | 全局 FACT.md 字节硬上限的回归测试 |
| `test/project-limit.test.mjs` | 项目 MEMORY.md 字符硬上限的回归测试 |
| `skills/persona-creator/SKILL.md` | 随包技能 |
| `cordis.patch.yml` | 组合包层：把 `persona-memory` 行插进宿主组合 |

`lib/index.js.map` 是编译期留下的 sourcemap；对应的 TypeScript 原稿不在本仓库内，
修改请直接改 `lib/*.js`。改完重启 DSH（或热重载该包）即生效。

## 协议

MIT License，全文见 [LICENSE](./LICENSE)，版权人 `hu568`（https://github.com/hu568）。
