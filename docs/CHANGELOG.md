# 变更记录

本文件保存该插件的历史变更记录。新变更继续追加在此处，README.md 只保留最近一版的摘要。

更早的提交级细节见 git 历史。

---

### 变更（0.14.0）：设置页改成横向页签

- **设置 → 记忆**顶部加一条横向页签：本插件自己的「注入开关」排第一，附属插件的整页
  （新的客户端子槽 `settings.persona-memory.tab`）排第二，声明式设置项按分组排后面
  （`自动召回` / `自动召回 · 高级` / `自动召回 · 语义` 归并成一页，组内仍可折叠）。
- **角色卡导入导出**（`dsh-persona-memory-io`）从「塞在主插件页里的一行」改成自己的整页，
  页签叫「角色卡」，注册在 `settings.persona-memory.tab`；旧写法 `settings.persona-memory.item`
  仍然受支持（同 id 已注册整页时不再重复画那一行）。
- 未选中的页保持挂载（`hidden`）：切页签不会丢草稿、折叠状态与搜索词。
- **回归防线**：新增 `test/settings-tabs.test.mjs`（纯 node，桩掉 React + ModuleLoader 执行
  真实源码）：断言页签顺序、「自动召回 · xxx」不单独成页、附属插件整页按 `only` 单独渲染、
  注入开关页只有 3 个开关，以及「数据未到 / 数据到手」两次渲染的 hook 数量一致。
  最后一条是 0.13.4 白屏事故的同款防线——hook 数量分叉会被 slot 错误边界吞成空白。
- **验收**：desktop 与 lab 两个 profile 都重装到 0.14.0，在 lab（0.2.2-rc.1）的设置 → 记忆里
  实测页签为「注入开关 / 角色卡」，点开「角色卡」是整页的选角色 + 三个按钮。

---

### 修复（0.13.4）：右侧栏「角色 / 记忆」面板空白

- **现象**：右栏标签页在、标题在，内容一片空白；宿主与设置页「记忆」都正常，GUI 上看不到任何报错。
  桌面端 0.2.2-rc.3 与隔离实例 0.2.2-rc.1 都能复现 ⇒ 与宿主版本无关。
- **根因**：0.13.2 的「整篇覆盖防呆」把 saveMemory 写成了 React.useCallback，而它被放在
  Pane 的「data === null 就提前 return」**之后**。首次渲染（数据未到）只调用提前返回前的 hook；
  第二次渲染（数据到手）多调用一个 hook ⇒ React 抛 Rendered more hooks than during the previous render，
  slot 层的错误边界把它渲染成 <div data-slot-error="sidebar.right.pane.tab"></div>，于是面板永远空白。
- **修法**：saveMemory 改成普通 async 函数并移到提前返回之前；两次渲染的 hook 顺序与数量一致。
- **回归防线**：新增 test/client-hook-order.test.mjs（纯 node，静态读 lib/client.js）：断言 Pane 里
  没有任何 hook 写在提前返回之后、saveMemory 不是 hook。用 0.13.3 的 lib/client.js 跑会红（定位到 1601 行），
  修好后绿。
- **验收**：dsh-lab（0.2.2-rc.1）装 0.13.4 后右栏面板正常渲染角色 / 记忆 / 日志三个标签页；已装份与仓库哈希一致。

---

### 变更（0.13.1）：把「条目要短」写进工具契约

- `memory` 工具描述新增格式约定：**一条只写一个结论、正文 ≤120 字**；命令/路径进「## 速查」，
  版本演进史、实现过程、调试记录用 `action=append` 写 JOURNAL。
- 原因：压缩器合并结果上限 120 字、逐条精简要求「合计更短且具体值不丢」，长条目在压缩阶段
  几乎无法通过 —— 文件只涨不降，这次真实故障就是项目记忆 99.66% 下不来。
- 只改提示契约，不动任何写入行为；抽取侧的强制格式门在 consolidate 0.6.0（>160 字改判 JOURNAL）。

---

### 变更（0.13.0）：85%–100% 区间也能确定性腾空间

- **保守淘汰档**：合并/精简之后水位落在 85%–100% 时，淘汰层也会启动，但只允许动
  ① 已失效（superseded / archived）条目，② 索引有元数据且 `importance ≤ 35` 的条目。
  keep 标记、显式人工锁、当前工作区、缺元数据的条目一律不碰（`compaction.js` 的
  `EVICT_TRIGGER = 0.85` / `CONSERVATIVE_IMPORTANCE_MAX = 35` / `selectEvictions({ conservative })`）。
  水位 ≥ 100% 仍走完整档（普通条目也可动），单次仍受 `maxEvictions` 与目标 75% 下限约束。
- **为什么加这一档**：本机项目记忆 7973/8000 字符 = 99.66%，而模型不可用时手动
  `/memory-compact` 只报「文件未改动」，下一次 `insertEntry` 必撞 `MEMORY_BUDGET_EXCEEDED`。
- **`withPlanMetadata` 补平移 `importance` / `kind`**：改写过的条目标识会变，以前这两个字段
  会丢 ⇒ 被改写条目一律按缺省 50 分判，保守档永远删不掉，评分也被悄悄拉高。
- **可观测**：`report.mode`（`full` / `conservative`）、`protectedImportance`、
  `explainConservativeSkip()`；命令输出在淘汰名单前标注「失效条目」/「importance N」，
  保守档没删时说清被什么挡下（不是含糊的「已达淘汰上限」）。`dryRun` 全路径不写正文 /
  索引 / 备份 / 审计。
- **已知边界**：本机这份 99.66% 的文件当前**仍腾不出空间** —— 42 条里没有一条 `importance ≤ 35`
  （31 条是整篇写回时补的缺省 50）。要真正压下去得先让重要性可维护（面板星级 / 工具参数 /
  写回继承），或另批「冷缺省条目」放宽档；这一版只保证「有确定性手段 + 说得清为什么没删」。

---

### 变更（0.11.0）

- **重要性元数据（侧车索引）**：`index.json` 的条目记录新增 `importance`（0–100，缺省 50）与 `kind`；
  `insertEntry` / `replaceEntry` 接受这两个字段，`replaceEntry` 未带 importance 时沿用旧值。
  正文格式零变化（`DESIGN v3 §10`）。
- **`setEntryImportance` / `touchEntries`**：只改索引、不碰正文、不占正文写锁；
  前者找不到目标返回 `not-found` 不猜，后者做访问回写（`hits+1` / `lastHit`）。
- **淘汰评分**：改为 `0.30 近因 + 0.20 命中 + 0.10 置信度 + 0.30 重要性 + 0.10 人工锁`，
  近因用 90 天半衰期指数衰减（`DESIGN v3 §12`）。
- **兼容**：老索引缺字段按缺省值读，不迁移；老 `insertEntry` 调用（字符串 / 无新字段）行为不变。
- **测试**：新增 `test/importance.test.mjs`（12 项），并把 `scoreEntry` 用例改成五项加权 + 半衰期单调性。

---

### 变更（0.10.0）

- **条目生命周期：失效不删除**：新增 `lib/entry-state.js`（`parseEntryState` / `applyEntryState` / `stripSuperseded` / `countEntryStates`）与 store 的 `supersedeEntry` / `restoreEntry`。过时结论不再只能等压缩删掉，而是行尾内联 `<!-- memory-state: status=superseded by=… since=… -->` 留痕：不注入、优先淘汰、可恢复；文件字节只增不减。
- **注入渲染层过滤**：`renderFacts()` 在 `clip()` 之前对 FACT / 项目原文调 `stripSuperseded()`；快照仍存原文，`watermark` 与闸口按原文算（口径差异写在 `lib/prompt-render.js` 注释里）。
- **压缩淘汰优先级**：`superseded` / `archived` 条目分数压到 0（缺元数据也照删），合并 / 精简候选池排除失效条目；`selectEvictions()` 报告新增 `dormantPriority`。
- **条目不因加注释而换 id**：条目切分统一先剥状态注释，`findEntry()` / 压缩层的 `parseEntries()` 得到的 `text` 都是纯正文；返回条目新增 `state` 字段。
- **`replaceEntry()` 改写正文时保留状态**：旧实现整行替换会把一条 superseded 条目悄悄写回 active。
- **测试**：新增 `test/entry-state.test.mjs`（42 条），含真实 `FACT.md` 的 `stripSuperseded` 幂等校验（只读，不写盘）。
- **JOURNAL 检索升级**：`lib/journal-search.js`（分词 + BM25 + 时效衰减 + 子串保底；无 query 保持时间倒序），`store.searchJournal()` 签名与返回形状不变、委托 `rankJournalEntries()` 打分排序；`test/journal-search.test.mjs` 7 组断言。

---

### 变更（0.9.0）

- **JOURNAL 写入与读取都脱敏**：`appendJournal()` 落盘前打码，`parseJournalLine()` 读回时再打一次（只改返回值，不回写）。历史明文密钥不会再被 recall 每轮召回；`id` 按脱敏后的正文算，保证「返回值 id == 落盘行 id」。
- **写锁统一按目标文件取键**：`memory:<绝对路径>`。面板（只带 `path`）与工具/沉淀（只带 `cwd`）终于落到同一把 mutex，压缩与回滚也显式传 `path`。
- **项目记忆整篇覆盖必须带 `expectedRevision`**：缺省抛 `MEMORY_REVISION_REQUIRED`（409，附当前 revision）；逃生口是显式 `force: true`。全局作用域仍可选。
- **`max-tokens` 不再算成功**：合并 / 精简的 `finish.kind` 只有 `stop` / `tool-calls` 算完成，截断一律当这轮没结果。
- **项目记忆裁剪口径统一**：写入闸口与注入裁剪都用 `min(maxChars, maxProjectChars)`，不再「写入通过、注入静默截断」。
- **备份分家**：条目级自动备份搬到 `memory/backups/auto/`（默认每文件 20 份），压缩备份留在 `backups/`（默认 5 份），各自修剪。
- **写前压缩失败可观测**：`logger.warn` + `MEMORY_BUDGET_EXCEEDED.details.compactionFailure = { code, message }`。
- **persona id 校验**：所有按 id 的动作都要求 `[a-z0-9][a-z0-9-]*`，角色目录必须位于角色库之下。
- **库级信任门**：新增 `trustProjectFromRepo`（默认 `true`）与 `store.gitOriginOf()`，项目记忆可能随仓库分发时追加「来源不可信」告示。

---

### 变更（0.8.7）

- **项目记忆首次写入即创建**：`validateEntry('memory', …)` 不再要求 cwd 下已有一份
  `MEMORY.md`（旧行为等于「项目记忆必须手工先建」，自动沉淀永远长不出来）。
  cwd 就是项目根，缺少文件时首条写入创建它；仍然拒绝空 cwd、home 与根目录。
  配套的是附属插件的「路径优先归属」：项目记忆跟工作区文件夹走，不靠会话名单反查。

---

### 变更（0.8.6）

- **修复 finish 块形状的合同漂移**：宿主的 `llm.stream` 终结块是
  `{ type:'finish', reason:{ kind, failure? } }`（`/opt/dsh` 的 `StreamChunk`
  声明与 `dsh-llm` 实现均如此），旧代码读的是 `chunk.kind` ⇒ 任何一次合并
  都被判「没结果」，压缩只剩淘汰在干活。现在两种形状都认
  （`lib/compaction-wiring.js` 的 `finishOf()`）。0.8.6 时 `stop` / `max-tokens` /
  `tool-calls` 都算成功；**0.9.0 起 `max-tokens` 改按截断/失败处理**（见上）。
- 单测补了宿主形状与旧形状两条路径，避免下次换宿主再静默失效。



