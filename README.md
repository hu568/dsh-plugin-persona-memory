# @dsh-external/dsh-persona-memory

DSH 的**角色设定 + 长期记忆**管理插件。替换掉 0.1.5 之前那套「预设级记忆加载器」
（`memory` / `memory-boot` / `ptc-memory` 三个 agent 预设 + `router-standard` 内嵌的
`memory-loader`）——那些只在选中对应预设时才注入，新方案注册在**宿主组合**里，
对**所有 agent 预设**的每个会话生效。

| | |
|---|---|
| 许可证 | MIT，见 [LICENSE](./LICENSE) |
| 安装规格 | `github:hu568/dsh-plugin-persona-memory` |
| 实测 DSH | `0.1.5-rc.1` ~ `0.1.7-rc.2` |
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
| 全局记忆 | `$DSH_HOME/memory/FACT.md` | 跨会话、跨项目的稳定事实 |
| 长期日志 | `$DSH_HOME/memory/JOURNAL.jsonl` | 一次性事件/会话笔记，仅追加 + 可检索 |
| 项目记忆 | `<项目根>/MEMORY.md` | 随项目走；**存在才注入**，不自动创建 |
| 会话快照 | `$DSH_HOME/memory/snapshots/<sessionId>.json` | 首条消息时固化的注入内容 |

注入的东西（提示词段落，顺序紧贴部署人格之后）：

- `memory:soul` → `<soul persona="…" id="…">` + 角色编辑契约
- `memory:user` → `<user persona="…">`
- `memory:facts` → `<memory>` 全局 + 项目 + 记忆写入契约
- `memory:journal` → `<journal>` 最近若干条

> **段落名为什么用 `memory:` 前缀**：用户自建的 `router-standard` 预设会在精简模式里
> 剥掉除 `memory:*` 外的全部段落。沿用这个前缀，角色与记忆在那种模式下也能存活，
> 不需要改预设里的剥离逻辑。

## 注入时机：首条消息快照冻结

- **首条用户消息之前**：每轮组装直接读盘 → 「先建会话 → 改角色/记忆 → 再发第一条消息」拿到最新内容。
- **首条用户消息之后**：把角色 + 记忆固化成本会话快照（内存 + 落盘），此后每轮读快照。
  于是 KV 缓存前缀绝对稳定，会话中途改文件不影响它，**新会话**才看到更新。
- 子代理会话的快照只留内存、不落盘（防止 `snapshots/` 随委派次数膨胀）。
- 快照落盘让 resume / 进程重启后语义不变。

## 工具

两个工具都是**全局注册**，没有路径参数，走进程内 `node:fs`（不受文件沙箱策略影响）：

### `memory`

| action | 作用 |
|--------|------|
| `read` | 读全局 FACT.md + 当前项目 MEMORY.md + 最近日志 |
| `update` | 整篇覆盖写入。`scope=global` → FACT.md；`scope=project` → `<项目根>/MEMORY.md`（不存在则创建） |
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
| `memoryEnabled` | `true` | 注入 `<memory>` / `<journal>` |
| `journalEnabled` | `true` | 注入最近日志条目 |
| `maxChars` | `8000` | 单文件注入字符上限 |
| `journalLimit` | `2000` | 日志扫描行上限 |
| `journalInject` | `6` | 注入最近日志条数 |
| `panelPath` | `/persona-memory` | 面板 HTTP 前缀 |

## 首次运行会做什么

- 建 `$DSH_HOME/memory/FACT.md`（模板，若不存在）。
- 角色库为空时建 `personas/default/`：把旧版 `$DSH_HOME/memory/{SOUL.md,USER.md}`
  的内容迁进去（旧文件保留不动），并把 `default` 设为当前角色。

## 已知边界

- **`complete: true` 的预设**（如内置 `minimal`）会把系统提示词替换成唯一一段，
  此时任何段落都注入不进去——那是该预设的语义，不是本插件的开关。
- 会话快照不随会话删除而回收；`snapshots/` 里会留小 JSON。文件很小，需要时手工清。
- 面板的「项目」列表来自本进程见过的会话 cwd；没有会话跑过的项目不会出现。

## 仓库结构与源码

本仓库以 **`lib/` 为唯一源码**，纯 JavaScript（ESM），**不需要任何构建链**，克隆即可用：

| 路径 | 角色 |
|------|------|
| `lib/index.js` | 宿主半：服务注册、提示词段落、`memory` / `persona` 工具、面板 HTTP 路由 |
| `lib/client.js` | 客户端半：手写 ModuleLoader 包，注册右侧栏标签页 |
| `lib/types/index.d.ts` | 宿主半的类型声明 |
| `skills/persona-creator/SKILL.md` | 随包技能 |
| `cordis.patch.yml` | 组合包层：把 `persona-memory` 行插进宿主组合 |

`lib/index.js.map` 是编译期留下的 sourcemap；对应的 TypeScript 原稿不在本仓库内，
修改请直接改 `lib/*.js`。改完重启 DSH（或热重载该包）即生效。

## 协议

MIT License，全文见 [LICENSE](./LICENSE)，版权人 `hu568`（https://github.com/hu568）。
