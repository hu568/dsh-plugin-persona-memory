/**
 * @dsh-external/dsh-persona-memory — client half（手写 ModuleLoader 包，免构建链）。
 *
 * 提供右侧栏「角色 / 记忆」标签页：
 *   - 角色：角色列表（头像卡 + 排序 + 当前标记）、切换当前角色、编辑 name/description/SOUL.md/USER.md、新建、删除
 *   - 记忆：全局 FACT.md 编辑（行/字节双闸口计量）、项目 MEMORY.md 编辑（字符闸口计量，按活动会话 cwd 发现的项目）
 *   - 日志：JOURNAL.jsonl 最近条目 + 追加 + 检索（标签可点即搜）
 *
 * 视觉（0.5.0 重做）：**不靠内联 style 对象堆样式，改为注入一份带前缀的样式表**——
 * 内联对象写不出 hover / focus / transition / 伪元素，而这正是「像不像一方界面」的分界。
 * 主题适配走 color-mix(in srgb, currentColor N%, transparent)：面板继承宿主文字色，
 * 由此推出的中性色在深色/浅色主题下都自洽，不依赖任何运行时未必存在的变量
 * （实测宿主 --dsh-border / --dsh-accent / --dsw-* 在面板作用域内全为空值）。
 *
 * 契约为本部署一方源码实测（同 dsh-browser-use）：
 *   - 标签类型注册：ctx.inject(['sidebarRightTabs'], …) → tabs.register({ id, kind, priority, title })
 *   - 面板主体：ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name, key }, Component))
 *   - 打开面板：ctx.sidebarRight.openTab(kind, { revealIfOpened: true })
 *   - 数据面：宿主半在 BASE 下注册的 HTTP 路由
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-persona-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const TAB_ID = '@dsh-external/dsh-persona-memory/panel'
    const TAB_KIND = 'persona-memory'
    const BASE = '/persona-memory'
    const STYLE_ID = 'dsh-persona-memory-panel-style'

    /** slots 是硬依赖：没有它就没有任何 UI 挂载点。 */
    const inject = ['slots']

    /* ───────────────────────────── 样式表 ───────────────────────────── */

    const STYLE_TEXT = `
.dpm-root,
.dpm-openbtn,
.dpm-set {
  --dpm-accent: #4b7bec;
  --dpm-accent-strong: #5d8bf4;
  --dpm-accent-soft: color-mix(in srgb, #4b7bec 15%, transparent);
  --dpm-danger: #e5544b;
  --dpm-warn: #d99b2b;
  --dpm-ok: #3fae74;
  --dpm-line: color-mix(in srgb, currentColor 13%, transparent);
  --dpm-line-soft: color-mix(in srgb, currentColor 8%, transparent);
  --dpm-fill: color-mix(in srgb, currentColor 5%, transparent);
  --dpm-fill-2: color-mix(in srgb, currentColor 10%, transparent);
  --dpm-muted: color-mix(in srgb, currentColor 62%, transparent);
  --dpm-faint: color-mix(in srgb, currentColor 40%, transparent);
  --dpm-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --dpm-r: 10px;
}
@supports not (color: color-mix(in srgb, red 10%, transparent)) {
  .dpm-root,
  .dpm-openbtn,
  .dpm-set {
    --dpm-accent-soft: rgba(75, 123, 236, 0.16);
    --dpm-line: rgba(127, 127, 127, 0.26);
    --dpm-line-soft: rgba(127, 127, 127, 0.16);
    --dpm-fill: rgba(127, 127, 127, 0.10);
    --dpm-fill-2: rgba(127, 127, 127, 0.18);
    --dpm-muted: rgba(127, 127, 127, 0.95);
    --dpm-faint: rgba(127, 127, 127, 0.72);
  }
}

.dpm-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-size: 12px;
  line-height: 1.6;
  color: inherit;
}
.dpm-root *,
.dpm-root *::before,
.dpm-root *::after,
.dpm-set *,
.dpm-set *::before,
.dpm-set *::after { box-sizing: border-box; }
@media (prefers-reduced-motion: reduce) {
  .dpm-root *, .dpm-openbtn, .dpm-set * { animation: none !important; transition: none !important; }
}

/* 顶栏 + 分段标签 */
.dpm-top {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  flex: 0 0 auto;
  border-bottom: 1px solid var(--dpm-line-soft);
}
.dpm-tabs {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 999px;
  background: var(--dpm-fill);
  border: 1px solid var(--dpm-line-soft);
}
.dpm-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 12px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--dpm-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.dpm-tab:hover { color: inherit; background: var(--dpm-fill-2); }
.dpm-tab[aria-selected="true"] {
  color: inherit;
  font-weight: 600;
  background: var(--dpm-fill-2);
  box-shadow: inset 0 0 0 1px var(--dpm-line);
}
.dpm-tab-n {
  font-family: var(--dpm-mono);
  font-size: 10px;
  opacity: 0.6;
}
.dpm-top-spacer { flex: 1 1 auto; }

/* 进度条（busy 时出现） */
.dpm-progress { flex: 0 0 auto; height: 2px; overflow: hidden; }
.dpm-progress > i {
  display: block;
  height: 100%;
  width: 34%;
  background: var(--dpm-accent);
  animation: dpm-slide 1.1s ease-in-out infinite;
}
@keyframes dpm-slide { 0% { margin-left: -34%; } 100% { margin-left: 100%; } }

/* 提示条 */
.dpm-toast {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 8px 12px 0;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  border: 1px solid var(--dpm-line);
  background: var(--dpm-fill);
  animation: dpm-in 0.18s ease-out;
}
@keyframes dpm-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
.dpm-toast.is-ok {
  color: var(--dpm-ok);
  border-color: color-mix(in srgb, var(--dpm-ok) 42%, transparent);
  background: color-mix(in srgb, var(--dpm-ok) 10%, transparent);
}
.dpm-toast.is-err {
  color: var(--dpm-danger);
  border-color: color-mix(in srgb, var(--dpm-danger) 42%, transparent);
  background: color-mix(in srgb, var(--dpm-danger) 10%, transparent);
}
.dpm-toast-text { flex: 1 1 auto; min-width: 0; word-break: break-word; white-space: pre-wrap; }
.dpm-toast-x {
  flex: 0 0 auto;
  border: 0;
  background: transparent;
  color: inherit;
  opacity: 0.7;
  cursor: pointer;
  padding: 0 2px;
  font: inherit;
  line-height: 1;
}
.dpm-toast-x:hover { opacity: 1; }

/* 主体 */
.dpm-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 12px 12px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.dpm-body::-webkit-scrollbar { width: 8px; height: 8px; }
.dpm-body::-webkit-scrollbar-thumb {
  background: var(--dpm-fill-2);
  border-radius: 99px;
}
.dpm-body::-webkit-scrollbar-thumb:hover { background: var(--dpm-line); }

.dpm-sec { display: flex; flex-direction: column; gap: 8px; }
.dpm-sec-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dpm-title { font-weight: 600; font-size: 12.5px; }
.dpm-sub { color: var(--dpm-muted); font-size: 11.5px; }
.dpm-hint { color: var(--dpm-muted); font-size: 11.5px; line-height: 1.7; }
.dpm-spacer { flex: 1 1 auto; }
.dpm-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dpm-col { display: flex; flex-direction: column; gap: 6px; }
.dpm-card {
  border: 1px solid var(--dpm-line-soft);
  border-radius: var(--dpm-r);
  padding: 10px;
}
.dpm-empty {
  text-align: center;
  color: var(--dpm-faint);
  font-size: 11.5px;
  padding: 20px 10px;
  border: 1px dashed var(--dpm-line);
  border-radius: var(--dpm-r);
}
code.dpm-path {
  font-family: var(--dpm-mono);
  font-size: 10.5px;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--dpm-fill-2);
  color: var(--dpm-muted);
  word-break: break-all;
}

/* 按钮 */
.dpm-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 26px;
  padding: 4px 10px;
  border-radius: 8px;
  border: 1px solid var(--dpm-line);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, opacity 0.15s, box-shadow 0.15s;
}
.dpm-btn:hover:not(:disabled) { background: var(--dpm-fill); }
.dpm-btn:disabled { opacity: 0.42; cursor: not-allowed; }
.dpm-btn:focus-visible { outline: 2px solid var(--dpm-accent); outline-offset: 1px; }
.dpm-btn--primary {
  background: var(--dpm-accent);
  border-color: var(--dpm-accent);
  color: #fff;
}
.dpm-btn--primary:hover:not(:disabled) {
  background: var(--dpm-accent-strong);
  border-color: var(--dpm-accent-strong);
}
.dpm-btn--primary.is-dirty { box-shadow: 0 0 0 3px var(--dpm-accent-soft); }
.dpm-btn--ghost { border-color: transparent; color: var(--dpm-muted); }
.dpm-btn--ghost:hover:not(:disabled) { color: inherit; background: var(--dpm-fill); }
.dpm-btn--danger {
  color: var(--dpm-danger);
  border-color: color-mix(in srgb, var(--dpm-danger) 42%, transparent);
}
.dpm-btn--danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dpm-danger) 14%, transparent); }
.dpm-btn--sm { min-height: 22px; padding: 2px 7px; font-size: 11px; border-radius: 6px; }
.dpm-btn--icon { width: 26px; padding: 0; }
.dpm-btn--icon.dpm-btn--sm { width: 22px; }

/* 字段 */
.dpm-field { display: flex; flex-direction: column; gap: 4px; margin-top: 9px; }
.dpm-label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--dpm-muted);
  font-size: 11.5px;
}
.dpm-label .dpm-count {
  margin-left: auto;
  font-family: var(--dpm-mono);
  font-size: 10.5px;
  color: var(--dpm-faint);
}
.dpm-input,
.dpm-area {
  width: 100%;
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid var(--dpm-line);
  background: var(--dpm-fill);
  color: inherit;
  font: inherit;
  font-size: 12px;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.dpm-area {
  font-family: var(--dpm-mono);
  font-size: 11.5px;
  line-height: 1.65;
  padding: 8px;
  min-height: 120px;
  resize: vertical;
}
.dpm-input:focus,
.dpm-area:focus {
  outline: none;
  border-color: var(--dpm-accent);
  /* 只改底色，别用 background 简写：那会把 select 的自绘箭头一起清掉。 */
  background-color: transparent;
  box-shadow: 0 0 0 3px var(--dpm-accent-soft);
}
.dpm-input::placeholder,
.dpm-area::placeholder { color: var(--dpm-faint); }
/* 原生 select 的背景不受 background: transparent 控制：透明会露出浏览器自绘的
   浅色控件底，而文字沿用 currentColor（暗色模式下是白色）⇒ 白字白底。
   这里关掉原生外观，用跟随 color-scheme 的系统色画底和字，并用 currentColor
   画箭头 —— 亮/暗两套主题都能看清，弹层也跟随同一个 color-scheme。 */
select.dpm-input {
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  color-scheme: inherit;
  background-color: Field;
  color: FieldText;
  padding-right: 26px;
  background-image:
    linear-gradient(45deg, transparent 50%, currentColor 50%),
    linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position:
    calc(100% - 14px) calc(50% + 1px),
    calc(100% - 9px) calc(50% + 1px);
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
}
select.dpm-input:focus {
  outline: none;
  border-color: var(--dpm-accent);
  background-color: Field;
  color: FieldText;
  box-shadow: 0 0 0 3px var(--dpm-accent-soft);
}
select.dpm-input option {
  background-color: Field;
  color: FieldText;
}

/* 计量条 */
.dpm-meters { display: flex; gap: 12px; flex-wrap: wrap; }
.dpm-meter { flex: 1 1 120px; min-width: 96px; display: flex; flex-direction: column; gap: 4px; }
.dpm-meter-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 10.5px;
  color: var(--dpm-muted);
}
.dpm-meter-head b { font-weight: 600; color: inherit; font-family: var(--dpm-mono); }
.dpm-meter.is-over .dpm-meter-head { color: var(--dpm-danger); }
.dpm-meter-track {
  height: 3px;
  border-radius: 99px;
  background: var(--dpm-fill-2);
  overflow: hidden;
}
.dpm-meter-fill {
  height: 100%;
  border-radius: 99px;
  background: var(--dpm-accent);
  transition: width 0.2s ease-out, background 0.15s;
}
.dpm-meter-fill.is-warn { background: var(--dpm-warn); }
.dpm-meter-fill.is-over { background: var(--dpm-danger); }

/* 角色卡 */
.dpm-persona {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 9px 10px;
  border: 1px solid var(--dpm-line-soft);
  border-radius: var(--dpm-r);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.dpm-persona:hover { background: var(--dpm-fill); border-color: var(--dpm-line); }
.dpm-persona.is-sel {
  background: var(--dpm-accent-soft);
  border-color: color-mix(in srgb, var(--dpm-accent) 62%, transparent);
}
.dpm-persona.is-active::before {
  content: '';
  position: absolute;
  left: -1px;
  top: 16%;
  bottom: 16%;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--dpm-accent);
}
.dpm-avatar {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, var(--dpm-accent), #7a5af8);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16);
  user-select: none;
}
.dpm-persona-main { flex: 1 1 auto; min-width: 0; }
.dpm-pname { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12.5px; }
.dpm-pid { font-family: var(--dpm-mono); font-size: 10.5px; font-weight: 400; color: var(--dpm-faint); }
.dpm-pdesc {
  margin-top: 2px;
  color: var(--dpm-muted);
  font-size: 11.5px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dpm-persona-side {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
}
.dpm-persona-side .dpm-btn { opacity: 0; transition: opacity 0.15s; }
.dpm-persona:hover .dpm-persona-side .dpm-btn,
.dpm-persona:focus-within .dpm-persona-side .dpm-btn { opacity: 1; }
@media (hover: none) {
  .dpm-persona-side .dpm-btn { opacity: 1; }
}
.dpm-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10.5px;
  color: var(--dpm-accent);
  background: var(--dpm-accent-soft);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dpm-accent) 34%, transparent);
}
.dpm-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }

/* 编辑区 */
.dpm-editor-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-bottom: 8px;
  margin-bottom: 2px;
  border-bottom: 1px solid var(--dpm-line-soft);
}
.dpm-editor-head .dpm-spacer { display: none; }
.dpm-editor-head .dpm-btn:first-of-type { margin-left: auto; }
.dpm-editor-head .dpm-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-left: auto;
}
.dpm-editor-head .dpm-actions .dpm-btn:first-of-type { margin-left: 0; }
.dpm-dirty {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  color: var(--dpm-warn);
}
.dpm-dirty .dpm-dot { animation: dpm-pulse 1.6s ease-in-out infinite; }
@keyframes dpm-pulse { 50% { opacity: 0.3; } }

/* 折叠块 */
.dpm-disclosure {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--dpm-muted);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.dpm-disclosure:hover { color: inherit; }
.dpm-chev { transition: transform 0.18s; }
.dpm-chev.is-open { transform: rotate(90deg); }

/* 日志 */
.dpm-entry {
  border: 1px solid var(--dpm-line-soft);
  border-left: 2px solid var(--dpm-line);
  border-radius: 8px;
  padding: 7px 9px;
  transition: background 0.15s, border-color 0.15s;
}
.dpm-entry:hover { background: var(--dpm-fill); border-left-color: var(--dpm-accent); }
.dpm-entry-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 10.5px;
  color: var(--dpm-faint);
}
.dpm-entry-text { margin-top: 3px; white-space: pre-wrap; word-break: break-word; }
.dpm-tags { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.dpm-chip {
  border: 1px solid var(--dpm-line);
  border-radius: 999px;
  padding: 1px 7px;
  font-family: inherit;
  font-size: 10px;
  color: var(--dpm-muted);
  background: transparent;
  cursor: pointer;
}
.dpm-chip:hover { color: inherit; background: var(--dpm-fill-2); }

/* 加载态 */
.dpm-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 32px 16px;
  color: var(--dpm-muted);
}
.dpm-spin {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid var(--dpm-line);
  border-top-color: var(--dpm-accent);
  animation: dpm-spin 0.8s linear infinite;
}
@keyframes dpm-spin { to { transform: rotate(360deg); } }

/* 头部「角色」按钮 */
.dpm-openbtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border: 1px solid var(--dpm-line);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.dpm-openbtn:hover { background: var(--dpm-fill); }
.dpm-openbtn.is-warn { color: var(--dpm-danger); border-color: color-mix(in srgb, var(--dpm-danger) 42%, transparent); }

/* ── 设置页（settings.section） ──
   与右侧栏面板同源配色，但留白按整页排：这是在 DSH 设置弹窗里，不是在窄侧栏。 */
.dpm-set {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 4px 2px 40px;
  font-size: 12px;
  line-height: 1.6;
  color: inherit;
}
.dpm-set-head { display: flex; align-items: flex-end; gap: 12px; }
.dpm-set-head-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dpm-set-title { font-size: 15px; font-weight: 650; letter-spacing: -0.01em; }
.dpm-set-lead { color: var(--dpm-muted); font-size: 11.5px; line-height: 1.65; }
.dpm-set-group { display: flex; flex-direction: column; gap: 8px; }
.dpm-set-group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--dpm-faint);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.dpm-set-group-title::after {
  content: '';
  flex: 1 1 auto;
  height: 1px;
  background: var(--dpm-line-soft);
}
/* 附属插件分组可折叠：项数多时默认收起，只留一行标题，避免把页面撑长。 */
.dpm-set-group-toggle {
  appearance: none;
  border: 0;
  background: none;
  padding: 2px 0;
  margin: 0;
  width: 100%;
  font: inherit;
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--dpm-faint);
  cursor: pointer;
}
.dpm-set-group-toggle:hover { color: var(--dpm-muted); }
.dpm-set-group-toggle:focus-visible {
  outline: 2px solid var(--dpm-accent);
  outline-offset: 2px;
  border-radius: 4px;
}
.dpm-set-count {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--dpm-fill-2);
  color: var(--dpm-faint);
  font-size: 10px;
  letter-spacing: 0;
}
.dpm-row {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 12px 14px;
  border: 1px solid var(--dpm-line-soft);
  border-radius: var(--dpm-r);
  background: var(--dpm-fill);
  transition: border-color 0.15s, background 0.15s;
}
.dpm-row:hover { border-color: var(--dpm-line); background: var(--dpm-fill-2); }
.dpm-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.dpm-row-title { font-size: 12.5px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.dpm-row-desc { color: var(--dpm-muted); font-size: 11.5px; line-height: 1.6; }
.dpm-row-meta { color: var(--dpm-faint); font-size: 11px; font-variant-numeric: tabular-nums; }
.dpm-row-note { color: var(--dpm-warn); font-size: 11px; line-height: 1.6; }
.dpm-row-aside { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding-top: 1px; }
.dpm-row-aside .dpm-input { width: 150px; padding: 3px 8px; }

.dpm-switch {
  position: relative;
  flex: 0 0 auto;
  width: 38px;
  height: 22px;
  padding: 0;
  border-radius: 999px;
  border: 1px solid var(--dpm-line);
  background: var(--dpm-fill-2);
  cursor: pointer;
  transition: background 0.16s, border-color 0.16s;
}
.dpm-switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: color-mix(in srgb, currentColor 55%, transparent);
  transition: transform 0.16s, background 0.16s;
}
.dpm-switch:hover { border-color: var(--dpm-line); }
.dpm-switch[aria-checked="true"] { background: var(--dpm-accent); border-color: var(--dpm-accent); }
.dpm-switch[aria-checked="true"]::after { transform: translateX(16px); background: #fff; }
.dpm-switch:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--dpm-accent-soft); }
.dpm-switch:disabled { opacity: 0.45; cursor: not-allowed; }

.dpm-set-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--dpm-faint);
  font-size: 11px;
  line-height: 1.6;
}
.dpm-set-foot code {
  font-family: var(--dpm-mono);
  font-size: 10.5px;
  color: var(--dpm-muted);
  word-break: break-all;
}
`

    /** 样式表只挂一次（id 幂等）。刻意不随 ctx 释放移除：重载若先卸后挂，会把新表一并带走。 */
    function mountStyles() {
      if (typeof document === 'undefined' || document.head === null) return
      if (document.getElementById(STYLE_ID) !== null) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = STYLE_TEXT
      document.head.appendChild(el)
    }

    /* ───────────────────────────── 小工具 ───────────────────────────── */

    /** feather 风格图标（内联 SVG，线宽跟随文字色）。 */
    const ICON_SHAPES = {
      refresh: [['polyline', { points: '23 4 23 10 17 10' }], ['path', { d: 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10' }]],
      save: [['path', { d: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z' }], ['polyline', { points: '17 21 17 13 7 13 7 21' }], ['polyline', { points: '7 3 7 8 15 8' }]],
      trash: [['polyline', { points: '3 6 5 6 21 6' }], ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }]],
      plus: [['line', { x1: 12, y1: 5, x2: 12, y2: 19 }], ['line', { x1: 5, y1: 12, x2: 19, y2: 12 }]],
      star: [['polygon', { points: '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2' }]],
      search: [['circle', { cx: 11, cy: 11, r: 8 }], ['line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }]],
      x: [['line', { x1: 18, y1: 6, x2: 6, y2: 18 }], ['line', { x1: 6, y1: 6, x2: 18, y2: 18 }]],
      check: [['polyline', { points: '20 6 9 17 4 12' }]],
      chevron: [['polyline', { points: '9 18 15 12 9 6' }]],
      up: [['polyline', { points: '18 15 12 9 6 15' }]],
      down: [['polyline', { points: '6 9 12 15 18 9' }]],
      alert: [['circle', { cx: 12, cy: 12, r: 10 }], ['line', { x1: 12, y1: 8, x2: 12, y2: 12 }], ['line', { x1: 12, y1: 16, x2: 12.01, y2: 16 }]],
      clock: [['circle', { cx: 12, cy: 12, r: 10 }], ['polyline', { points: '12 6 12 12 16 14' }]],
      undo: [['polyline', { points: '1 4 1 10 7 10' }], ['path', { d: 'M3.51 15a9 9 0 1 0 2.13-9.36L1 10' }]],
    }

    function icon(name, size) {
      const shapes = ICON_SHAPES[name] || []
      return h('svg', {
        key: 'i',
        viewBox: '0 0 24 24',
        width: size === undefined ? 14 : size,
        height: size === undefined ? 14 : size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { flex: '0 0 auto', display: 'block' },
      }, shapes.map((shape, index) => h(shape[0], Object.assign({ key: 's' + index }, shape[1]))))
    }

    /** 统一按钮：variant = primary | ghost | danger；iconOnly 时只给图标。 */
    function Btn(props) {
      const cls = [
        'dpm-btn',
        props.variant ? 'dpm-btn--' + props.variant : '',
        props.small === true ? 'dpm-btn--sm' : '',
        props.iconOnly === true ? 'dpm-btn--icon' : '',
        props.dirty === true ? 'is-dirty' : '',
      ].filter((part) => part !== '').join(' ')
      return h('button', {
        type: 'button',
        className: cls,
        title: props.title,
        disabled: props.disabled === true,
        onClick: props.onClick,
        'aria-label': props.ariaLabel,
      }, props.icon === undefined ? null : icon(props.icon, props.size),
        props.label === undefined ? null : h('span', { key: 'l' }, props.label))
    }

    /** 计量条：value/max，超限变红，接近上限变琥珀。 */
    function Meter(props) {
      const max = props.max > 0 ? props.max : 1
      const ratio = props.value / max
      const over = props.value > props.max
      const warn = !over && ratio >= 0.85
      return h('div', { className: 'dpm-meter' + (over ? ' is-over' : '') },
        h('div', { className: 'dpm-meter-head' },
          h('span', null, props.label),
          h('span', null, h('b', null, fmtInt(props.value)), ' / ' + fmtInt(props.max) + (props.unit ? ' ' + props.unit : ''))),
        h('div', { className: 'dpm-meter-track' },
          h('div', {
            className: 'dpm-meter-fill' + (over ? ' is-over' : warn ? ' is-warn' : ''),
            style: { width: Math.min(100, ratio * 100) + '%' },
          })))
    }

    function fmtInt(value) {
      return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /**
     * 体量口径与宿主半 lib/index.js 逐字一致：
     *   countLines —— \r\n 归一化、末尾换行不算额外一行；
     *   countBytes —— \r\n 归一化后的 UTF-8 字节数；
     *   countChars —— trim() 后长度（**不**归一化，与注入侧 clip() 同口径）。
     */
    function countLines(text) {
      if (text === '') return 0
      const normalized = text.replace(/\r\n/g, '\n')
      return (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n').length
    }
    function countBytes(text) {
      return new TextEncoder().encode(text.replace(/\r\n/g, '\n')).length
    }
    function countChars(text) {
      return text.trim().length
    }
    /** 日志时间戳 → 可读本地时间（坏值原样返回）。 */
    function fmtTime(value) {
      if (typeof value !== 'string' || value === '') return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      const pad = (n) => String(n).padStart(2, '0')
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
        + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    /** 宿主上限默认值（与 lib/index.js 的 DEFAULT_* 同值）；宿主未来若在 state 里下发 limits 则以其为准。 */
    const LIMITS = { factLines: 100, factBytes: 8000, projectChars: 8000 }
    function limitsOf(state) {
      const raw = state === null || state === undefined ? null : state.limits
      if (raw === null || raw === undefined || typeof raw !== 'object') return LIMITS
      return {
        factLines: typeof raw.factLines === 'number' ? raw.factLines : LIMITS.factLines,
        factBytes: typeof raw.factBytes === 'number' ? raw.factBytes : LIMITS.factBytes,
        projectChars: typeof raw.projectChars === 'number' ? raw.projectChars : LIMITS.projectChars,
      }
    }

    /** 调宿主半的 JSON API（30 秒无响应即报错：否则 busy 会一直挂着，面板所有按钮都点不动）。 */
    async function api(path, body) {
      const controller = new AbortController()
      const timer = window.setTimeout(() => controller.abort(), 30000)
      let res
      try {
        res = await fetch(BASE + path, Object.assign(
          { signal: controller.signal },
          body === undefined
            ? { method: 'GET' }
            : {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              },
        ))
      } catch (error) {
        const aborted = error !== null && error !== undefined && error.name === 'AbortError'
        throw new Error(aborted ? '面板接口 30 秒没有响应' : String((error && error.message) || error))
      } finally {
        window.clearTimeout(timer)
      }
      let payload = null
      try {
        payload = await res.json()
      } catch {
        payload = null
      }
      if (!res.ok || payload === null || payload.ok === false) {
        throw new Error((payload && payload.error) || 'HTTP ' + res.status)
      }
      return payload
    }

    /**
     * 当前主视图会话的工作目录（cwd）—— 面板项目记忆跟随 DSH 工作区切换的依据。
     *
     * 数据来自宿主客户端的两个可选服务（都不在 apply 的 inject 里，取不到就退回旧行为）：
     *   - `uiSession.current`：主视图当前会话的绑定，`getSnapshot().key` 是 sessionId；
     *   - `sessions.list`：会话摘要（含 cwd 与 retainedBy.mainView）。
     * 预览工装 / 旧宿主没有这两个服务时返回空串，面板仍可用（只是不跟随工作区）。
     */
    function useCurrentWorkspaceCwd() {
      const ctx = ctx0
      const sessions = ctx === null ? undefined : ctx.get('sessions')
      const uiSession = ctx === null ? undefined : ctx.get('uiSession')

      const subscribe = React.useCallback((onChange) => {
        const disposers = []
        try {
          const current = uiSession && uiSession.current
          if (current && typeof current.subscribe === 'function') disposers.push(current.subscribe(onChange))
          const list = sessions && sessions.list
          if (list && typeof list.subscribe === 'function') disposers.push(list.subscribe(onChange))
        } catch {
          /* 服务形状与预期不同：保持空串，不影响面板其它功能 */
        }
        return () => {
          for (const dispose of disposers) {
            try { dispose() } catch { /* 已释放 */ }
          }
        }
      }, [sessions, uiSession])

      const read = React.useCallback(() => {
        try {
          const list = sessions && sessions.list ? sessions.list.getSnapshot() : null
          const byId = (list && list.byId) || {}
          let id = uiSession && uiSession.current ? uiSession.current.getSnapshot().key : undefined
          if (id === undefined || byId[id] === undefined) {
            const retained = Object.values(byId).find((row) => row && ((row.retainedBy && row.retainedBy.mainView) || 0) > 0)
            id = retained === undefined ? undefined : retained.id
          }
          const cwd = id === undefined ? undefined : (byId[id] && byId[id].cwd)
          return typeof cwd === 'string' ? cwd : ''
        } catch {
          return ''
        }
      }, [sessions, uiSession])

      return React.useSyncExternalStore(subscribe, read, () => '')
    }

    /* ───────────────────────────── 三个标签页 ───────────────────────────── */

    function PersonaTab(props) {
      const s = props
      const [filter, setFilter] = React.useState('')
      const activePersona = s.personas.find((p) => p.id === s.active) || null
      const keyword = filter.trim().toLowerCase()
      const list = keyword === ''
        ? s.personas
        : s.personas.filter((p) => p.id.toLowerCase().includes(keyword)
            || String(p.name).toLowerCase().includes(keyword)
            || String(p.description || '').toLowerCase().includes(keyword))

      return h('div', { className: 'dpm-sec' },
        h('div', { className: 'dpm-hint' },
          '角色库 ', h('code', { className: 'dpm-path' }, s.paths.personas),
          h('br'),
          '角色在会话首条消息时固化进提示词——切换 / 编辑只对新会话生效。'),

        h('div', null,
          h('div', { className: 'dpm-sec-head', style: { marginBottom: '8px' } },
            h('span', { className: 'dpm-title' }, '角色库'),
            h('span', { className: 'dpm-badge', title: '当前角色' },
              h('i', { className: 'dpm-dot' }),
              s.active === '' ? '（无）' : (activePersona === null ? s.active : activePersona.name)),
            h('span', { className: 'dpm-spacer' }),
            s.personas.length > 4
              ? h('input', {
                  className: 'dpm-input',
                  style: { width: '120px' },
                  placeholder: '筛选',
                  'aria-label': '筛选角色',
                  value: filter,
                  onChange: (e) => setFilter(e.target.value),
                })
              : null),
          s.personas.length === 0
            ? h('div', { className: 'dpm-empty' }, '角色库为空，展开下面的「新建角色」创建第一个。')
            : h('div', { className: 'dpm-col' }, list.map((p) => {
                const index = s.personas.findIndex((item) => item.id === p.id)
                return h('div', {
                  key: p.id,
                  role: 'button',
                  tabIndex: 0,
                  className: 'dpm-persona' + (p.id === s.sel ? ' is-sel' : '') + (p.active ? ' is-active' : ''),
                  onClick: () => s.selectPersona(p.id),
                  onKeyDown: (e) => {
                    if (e.target !== e.currentTarget) return
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      s.selectPersona(p.id)
                    }
                  },
                },
                h('div', { className: 'dpm-avatar', 'aria-hidden': 'true' }, Array.from(String(p.name || p.id))[0]),
                h('div', { className: 'dpm-persona-main' },
                  h('div', { className: 'dpm-pname' }, p.name, h('span', { className: 'dpm-pid' }, p.id)),
                  p.description ? h('div', { className: 'dpm-pdesc' }, p.description) : null),
                h('div', { className: 'dpm-persona-side' },
                  s.personas.length > 1
                    ? h(Btn, {
                        key: 'up', small: true, iconOnly: true, icon: 'up', size: 12,
                        title: '上移', ariaLabel: '上移 ' + p.id,
                        disabled: s.busy || index === 0,
                        onClick: (e) => { e.stopPropagation(); s.movePersona(p.id, -1) },
                      })
                    : null,
                  s.personas.length > 1
                    ? h(Btn, {
                        key: 'down', small: true, iconOnly: true, icon: 'down', size: 12,
                        title: '下移', ariaLabel: '下移 ' + p.id,
                        disabled: s.busy || index === s.personas.length - 1,
                        onClick: (e) => { e.stopPropagation(); s.movePersona(p.id, 1) },
                      })
                    : null))
              }))),

        s.sel !== ''
          ? h('div', { className: 'dpm-card' },
              h('div', { className: 'dpm-editor-head' },
                h('span', { className: 'dpm-title' }, '编辑 ', h('span', { className: 'dpm-pid' }, s.sel)),
                s.personaDirty
                  ? h('span', { className: 'dpm-dirty' }, h('i', { className: 'dpm-dot' }), '未保存')
                  : null,
                h('div', { className: 'dpm-actions' },
                  s.sel !== s.active
                  ? h(Btn, { small: true, icon: 'star', size: 12, label: '设为当前', disabled: s.busy, onClick: s.usePersona })
                  : null,
                h(Btn, {
                  small: true, variant: 'danger', icon: 'trash', size: 12, label: '删除',
                  title: s.sel === s.active ? '当前角色不能删除，先切换成别的角色' : '删除 ' + s.sel + ' 的整个目录',
                  disabled: s.busy || s.sel === s.active, onClick: s.deletePersona,
                }),
                h(Btn, {
                  small: true, variant: 'primary', icon: 'save', size: 12, label: '保存',
                  dirty: s.personaDirty, disabled: s.busy || !s.personaDirty, onClick: s.savePersona,
                }))),
              h('div', { className: 'dpm-field' },
                h('label', { className: 'dpm-label' }, '角色名'),
                h('input', {
                  className: 'dpm-input',
                  value: s.pname,
                  placeholder: '展示用名字',
                  onChange: (e) => s.setPname(e.target.value),
                })),
              h('div', { className: 'dpm-field' },
                h('label', { className: 'dpm-label' }, '一句话简介'),
                h('input', {
                  className: 'dpm-input',
                  value: s.pdesc,
                  placeholder: '这个角色是做什么的',
                  onChange: (e) => s.setPdesc(e.target.value),
                })),
              h('div', { className: 'dpm-field' },
                h('label', { className: 'dpm-label' }, 'SOUL.md（人格设定）',
                  h('span', { className: 'dpm-count' }, fmtInt(countChars(s.soul)) + ' 字符')),
                h('textarea', {
                  className: 'dpm-area',
                  rows: 14,
                  spellCheck: false,
                  value: s.soul,
                  onChange: (e) => s.setSoul(e.target.value),
                })),
              h('div', { className: 'dpm-field' },
                h('label', { className: 'dpm-label' }, 'USER.md（该角色的用户档案）',
                  h('span', { className: 'dpm-count' }, fmtInt(countChars(s.user)) + ' 字符')),
                h('textarea', {
                  className: 'dpm-area',
                  rows: 8,
                  spellCheck: false,
                  value: s.user,
                  onChange: (e) => s.setUser(e.target.value),
                })))
          : null,

        h('div', { className: 'dpm-sec' },
          h('button', {
            type: 'button',
            className: 'dpm-disclosure',
            'aria-expanded': s.newOpen === true,
            onClick: () => s.setNewOpen(!s.newOpen),
          },
          h('span', { className: 'dpm-chev' + (s.newOpen === true ? ' is-open' : '') }, icon('chevron', 12)),
          '新建角色'),
          s.newOpen === true
            ? h('div', { className: 'dpm-card' },
                h('div', { className: 'dpm-field', style: { marginTop: 0 } },
                  h('label', { className: 'dpm-label' }, 'id（小写字母 / 数字 / 中横线，即目录名）'),
                  h('input', {
                    className: 'dpm-input',
                    value: s.newId,
                    placeholder: 'meow-teacher',
                    onChange: (e) => s.setNewId(e.target.value),
                  })),
                h('div', { className: 'dpm-field' },
                  h('label', { className: 'dpm-label' }, '角色名'),
                  h('input', {
                    className: 'dpm-input',
                    value: s.newName,
                    placeholder: '喵喵老师',
                    onChange: (e) => s.setNewName(e.target.value),
                  })),
                h('div', { className: 'dpm-field' },
                  h('label', { className: 'dpm-label' }, '一句话简介'),
                  h('input', {
                    className: 'dpm-input',
                    value: s.newDescription,
                    onChange: (e) => s.setNewDescription(e.target.value),
                  })),
                h('div', { className: 'dpm-row', style: { marginTop: '9px' } },
                  h(Btn, { variant: 'primary', icon: 'plus', size: 13, label: '新建', disabled: s.busy, onClick: s.createPersona }),
                  h('span', { className: 'dpm-sub' }, '新建后 SOUL.md / USER.md 是模板骨架，可在上面的编辑区改写。')))
            : null),
      )
    }

    function MemoryTab(props) {
      const s = props
      const limits = s.limits
      const factLines = countLines(s.fact)
      const factBytes = countBytes(s.fact)
      const projectChars = countChars(s.projectText)
      const project = s.projects.find((p) => p.path === s.projectPath) || null

      return h('div', { className: 'dpm-sec' },
        h('div', { className: 'dpm-hint' },
          '全局记忆 ', h('code', { className: 'dpm-path' }, s.paths.fact),
          h('br'),
          '项目记忆固定跟随当前会话的工作区（cwd 向上查找 MEMORY.md），没有手动选择；切换工作区会自动切到这里，没有就不注入。超限写入会被宿主拒绝，不会静默截断。'),

        h('div', { className: 'dpm-card' },
          h('div', { className: 'dpm-editor-head' },
            h('span', { className: 'dpm-title' }, '全局记忆 · FACT.md'),
            h('span', { className: 'dpm-sub' }, '注入每个主会话'),
            s.factDirty ? h('span', { className: 'dpm-dirty' }, h('i', { className: 'dpm-dot' }), '未保存') : null,
            h('div', { className: 'dpm-actions' },
              s.factDirty
                ? h(Btn, { small: true, icon: 'undo', size: 12, label: '撤销改动', disabled: s.busy, onClick: s.resetFact })
                : null,
            h(Btn, {
              small: true, variant: 'primary', icon: 'save', size: 12, label: '保存',
              dirty: s.factDirty, disabled: s.busy || !s.factDirty, onClick: s.saveFact,
            }))),
          h('div', { className: 'dpm-field', style: { marginTop: '9px' } },
            h('div', { className: 'dpm-meters' },
              h(Meter, { key: 'l', label: '行数', value: factLines, max: limits.factLines, unit: '行' }),
              h(Meter, { key: 'b', label: '字节（UTF-8）', value: factBytes, max: limits.factBytes, unit: 'B' }))),
          h('textarea', {
            className: 'dpm-area',
            rows: 14,
            spellCheck: false,
            value: s.fact,
            onChange: (e) => s.setFact(e.target.value),
          })),

        h('div', { className: 'dpm-card' },
          h('div', { className: 'dpm-editor-head' },
            h('span', { className: 'dpm-title' }, '项目记忆 · MEMORY.md'),
            s.projects.length === 0
              ? h('span', { className: 'dpm-sub' }, '未发现项目')
              : h('span', { className: 'dpm-sub' }, project !== null && project.exists === false ? '尚未创建' : '已存在'),
            s.projectDirty ? h('span', { className: 'dpm-dirty' }, h('i', { className: 'dpm-dot' }), '未保存') : null,
            h('span', { className: 'dpm-spacer' }),
            s.projects.length === 0
              ? null
              : h(Btn, {
                  small: true, variant: 'primary', icon: 'save', size: 12, label: '保存',
                  dirty: s.projectDirty, disabled: s.busy || !s.projectDirty, onClick: s.saveProject,
                })),
          s.projects.length === 0
            ? h('div', { className: 'dpm-empty' }, '还没有发现任何工作区项目（DSH 工作区注册表为空，且本进程还没有带 cwd 的会话）。')
            : null,
          project === null
            ? null
            : h('div', { className: 'dpm-field', style: { marginTop: '9px' } },
                h('label', { className: 'dpm-label' }, '当前项目'),
                h('div', { className: 'dpm-sub' }, h('code', { className: 'dpm-path' }, project.path))),
          project === null
            ? null
            : h('div', { className: 'dpm-field' },
                h('div', { className: 'dpm-meters' },
                  h(Meter, { label: '字符', value: projectChars, max: limits.projectChars, unit: '字符' })),
                h('textarea', {
                  className: 'dpm-area',
                  rows: 12,
                  spellCheck: false,
                  value: s.projectText,
                  placeholder: '这个项目专属的约定 / 机制结论 / 清单……',
                  onChange: (e) => s.setProjectText(e.target.value),
                }))),
      )
    }

    function JournalTab(props) {
      const s = props
      const shown = s.hits === null ? (s.entries || []) : s.hits
      return h('div', { className: 'dpm-sec' },
        h('div', { className: 'dpm-hint' },
          '长期日志 ', h('code', { className: 'dpm-path' }, s.paths.journal),
          '　共 ', h('b', null, fmtInt(s.journalCount)), ' 条',
          h('br'),
          '日志不注入提示词，需要时按 tag / 子串检索；一次性的流水账往这里写。'),

        h('div', { className: 'dpm-card' },
          h('div', { className: 'dpm-editor-head' },
            h('span', { className: 'dpm-title' }, '追加一条'),
            h('span', { className: 'dpm-spacer' }),
            h(Btn, {
              small: true, variant: 'primary', icon: 'plus', size: 12, label: '追加',
              disabled: s.busy || s.journalText.trim() === '', onClick: s.appendJournal,
            })),
          h('textarea', {
            className: 'dpm-area',
            rows: 4,
            style: { minHeight: '72px' },
            value: s.journalText,
            placeholder: '这次会话值得记住的事件 / 决定 / 结论（Ctrl+Enter 追加）',
            onChange: (e) => s.setJournalText(e.target.value),
            onKeyDown: (e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault()
                if (!s.busy) s.appendJournal()
              }
            },
          }),
          h('div', { className: 'dpm-field' },
            h('label', { className: 'dpm-label' }, '标签（逗号分隔，可选）'),
            h('input', {
              className: 'dpm-input',
              value: s.journalTags,
              placeholder: '决策, 排障',
              onChange: (e) => s.setJournalTags(e.target.value),
            }))),

        h('div', { className: 'dpm-card' },
          h('div', { className: 'dpm-editor-head' },
            h('span', { className: 'dpm-title' }, '检索'),
            s.hits !== null ? h('span', { className: 'dpm-badge' }, s.hits.length + ' 条命中') : null,
            h('span', { className: 'dpm-spacer' }),
            s.hits !== null
              ? h(Btn, { small: true, variant: 'ghost', icon: 'x', size: 12, label: '清除', onClick: s.clearSearch })
              : null),
          h('div', { className: 'dpm-field', style: { marginTop: '9px' } },
            h('div', { className: 'dpm-row' },
              h('input', {
                className: 'dpm-input',
                style: { flex: '1 1 160px' },
                placeholder: '子串',
                'aria-label': '日志检索子串',
                value: s.query,
                onChange: (e) => s.setQuery(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void s.searchJournal() }
                },
              }),
              h('input', {
                className: 'dpm-input',
                style: { flex: '0 1 110px' },
                placeholder: 'tag',
                'aria-label': '日志检索标签',
                value: s.tag,
                onChange: (e) => s.setTag(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void s.searchJournal() }
                },
              }),
              h(Btn, { icon: 'search', size: 13, label: '搜索', disabled: s.busy, onClick: s.searchJournal })))),

        h('div', { className: 'dpm-sec' },
          h('div', { className: 'dpm-sec-head' },
            h('span', { className: 'dpm-title' }, s.hits === null ? '最近条目' : '检索结果'),
            h('span', { className: 'dpm-sub' }, shown.length + ' 条')),
          shown.length === 0
            ? h('div', { className: 'dpm-empty' }, s.hits === null ? '还没有任何日志。' : '没有命中，换个关键词或 tag 试试。')
            : h('div', { className: 'dpm-col' }, shown.map((entry, index) => h('div', {
                key: String(entry.ts) + '-' + index,
                className: 'dpm-entry',
              },
              h('div', { className: 'dpm-entry-head' },
                icon('clock', 11),
                h('span', null, fmtTime(entry.ts)),
                h('span', { className: 'dpm-tags' }, (entry.tags || []).map((t, tagIndex) => h('button', {
                  key: t + '-' + tagIndex,
                  type: 'button',
                  className: 'dpm-chip',
                  title: '按此标签检索',
                  onClick: () => s.searchByTag(t),
                }, '#' + t)))),
              h('div', { className: 'dpm-entry-text' }, entry.text))))),
      )
    }

    /* ───────────────────────────── 面板主体 ───────────────────────────── */

    function Pane() {
      const [data, setData] = React.useState(null)
      const [tab, setTab] = React.useState('persona')
      const [note, setNote] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [sel, setSel] = React.useState('')
      const [pname, setPname] = React.useState('')
      const [pdesc, setPdesc] = React.useState('')
      const [soul, setSoul] = React.useState('')
      const [user, setUser] = React.useState('')
      const [pbase, setPbase] = React.useState(null)
      const [newOpen, setNewOpen] = React.useState(false)
      const [newId, setNewId] = React.useState('')
      const [newName, setNewName] = React.useState('')
      const [newDescription, setNewDescription] = React.useState('')
      const [fact, setFact] = React.useState('')
      const [factBase, setFactBase] = React.useState('')
      const [projects, setProjects] = React.useState([])
      const [projectPath, setProjectPath] = React.useState('')
      const [projectText, setProjectText] = React.useState('')
      const [projectBase, setProjectBase] = React.useState('')
      const [journalText, setJournalText] = React.useState('')
      const [journalTags, setJournalTags] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [tag, setTag] = React.useState('')
      const [hits, setHits] = React.useState(null)

      /** 主视图会话的工作区 cwd：切换工作区时项目记忆要跟着换。 */
      const workspaceCwd = useCurrentWorkspaceCwd()
      const workspaceCwdRef = React.useRef('')
      const loadedCwdRef = React.useRef('')
      React.useEffect(() => { workspaceCwdRef.current = workspaceCwd }, [workspaceCwd])

      /** 统一信封归一：{ok,state} 或裸 state 都接受（后端两种形状的历史包袱）。 */
      const unwrap = (payload) => {
        if (payload === null || payload === undefined) return null
        if (payload.state && typeof payload.state === 'object') return payload.state
        if (payload.paths && payload.persona) return payload
        return null
      }

      /** 当前选中的项目路径（apply 是稳定回调，读不到最新 state，用 ref 兜）。 */
      const projectPathRef = React.useRef('')
      /** 宿主下发的「当前工作区项目」路径：只在它真的变化时自动跟随。 */
      const workspacePathRef = React.useRef('')
      /** 工作区切换被未保存草稿挡住时记下目标项目，草稿清空后补切。 */
      const pendingWorkspaceRef = React.useRef('')
      React.useEffect(() => {
        projectPathRef.current = projectPath
      }, [projectPath])

      /**
       * 编辑器脏标记的镜像。apply 是稳定回调、读不到最新 state，用 ref 兜。
       * 为什么必须有这层：任何写操作返回的 state 信封都会走 apply —— 没有防护时
       * 「FACT 改到一半 → 顺手往日志追加一条」会把刚写的正文静默覆盖回磁盘版。
       */
      const dirtyRef = React.useRef({ persona: false, fact: false, project: false })

      /** force=true 时无视脏标记（顶栏「重新读取」用）。 */
      const apply = React.useCallback((payload, force) => {
        setData(payload)
        const dirty = dirtyRef.current
        if (force === true || !dirty.fact) {
          setFact(payload.memory.global.content)
          setFactBase(payload.memory.global.content)
        }
        const list = payload.memory.projects || []
        setProjects(list)
        // 宿主随 GET /api/state?cwd=… 下发当前工作区项目；POST 回包或旧宿主没有这个字段。
        const workspaceProject = payload.memory.current
        const workspacePath = workspaceProject !== null && workspaceProject !== undefined
          && typeof workspaceProject.path === 'string'
          ? workspaceProject.path
          : ''
        const current = projectPathRef.current
        let next = list.some((p) => p.path === current) ? current : (list[0] ? list[0].path : '')
        if (workspacePath !== '' && list.some((p) => p.path === workspacePath)) {
          const switched = workspacePath !== workspacePathRef.current
          workspacePathRef.current = workspacePath
          if (switched) {
            if (dirty.project && current !== '' && current !== workspacePath) {
              // 有未保存草稿：不替主人做丢弃决定，保留当前项目并说明怎么切过去。
              next = current
              pendingWorkspaceRef.current = workspacePath
              setNote({
                kind: 'err',
                text: '工作区已切换，但项目记忆有未保存改动：已保留当前项目。保存或撤销后再切到「'
                  + workspacePath + '」。',
              })
            } else {
              next = workspacePath
              pendingWorkspaceRef.current = ''
            }
          } else {
            // 又切回当前项目所在的工作区：取消挂起的跟随，避免保存后跳去别处。
            pendingWorkspaceRef.current = ''
          }
        }
        projectPathRef.current = next
        setProjectPath(next)
        const found = list.find((p) => p.path === next)
        if (force === true || !(dirty.project && next === current)) {
          setProjectText(found ? found.content : '')
          setProjectBase(found ? found.content : '')
        }
      }, [])

      const guard = React.useCallback(async (fn, okNote, force) => {
        setBusy(true)
        setNote(null)
        try {
          const payload = await fn()
          const next = unwrap(payload)
          if (next !== null) apply(next, force === true)
          if (okNote) setNote({ kind: 'ok', text: okNote })
          return payload
        } catch (error) {
          setNote({ kind: 'err', text: String((error && error.message) || error) })
          return null
        } finally {
          setBusy(false)
        }
      }, [apply])

      /** 成功提示 4 秒后自动收掉；错误提示留着等人读。 */
      React.useEffect(() => {
        if (note === null || note.kind !== 'ok') return undefined
        const timer = window.setTimeout(() => setNote(null), 4000)
        return () => window.clearTimeout(timer)
      }, [note])

      /**
       * 读面板状态；cwd 非空时让宿主按该工作区定位项目记忆（跟随工作区切换）。
       * `force` 默认 true = 无视未保存草稿（顶栏「重新读取」）；工作区切换必须传 false，
       * 否则会把主人正在改的项目/全局记忆草稿静默覆盖回磁盘版。
       */
      const load = React.useCallback((cwd, force) => guard(
        () => api('/api/state' + (typeof cwd === 'string' && cwd !== '' ? '?cwd=' + encodeURIComponent(cwd) : '')),
        null,
        force !== false,
      ), [guard])
      /** 顶栏刷新 / 重试按钮：总是带上当前工作区，并强制重读磁盘。 */
      const reload = React.useCallback(() => load(workspaceCwdRef.current, true), [load])

      /** persona/show 的在途序号：快速连点两张卡片时，只认最后一次请求的结果。 */
      const personaSeq = React.useRef(0)

      const loadPersona = React.useCallback(async (id) => {
        const seq = ++personaSeq.current
        setSel(id)
        setPbase(null)
        try {
          const payload = await api('/api/persona/show', { id })
          if (seq !== personaSeq.current) return
          setPname(payload.persona.name)
          setPdesc(payload.persona.description)
          setSoul(payload.persona.soul)
          setUser(payload.persona.user)
          setPbase({
            name: payload.persona.name,
            description: payload.persona.description,
            soul: payload.persona.soul,
            user: payload.persona.user,
          })
        } catch (error) {
          if (seq !== personaSeq.current) return
          // 读不到就把编辑器清空收起来：留着上一个角色的草稿 + pbase=null
          // 会让「保存」永久禁用、标题却显示新 id，比直接收起更误导。
          setSel('')
          setPname('')
          setPdesc('')
          setSoul('')
          setUser('')
          setPbase(null)
          setNote({ kind: 'err', text: String((error && error.message) || error) })
        }
      }, [])

      React.useEffect(() => {
        void (async () => {
          const payload = await load(workspaceCwdRef.current)
          loadedCwdRef.current = workspaceCwdRef.current
          const next = unwrap(payload)
          const list = next === null ? [] : next.persona.list
          const active = next === null ? '' : next.persona.active
          const first = list.find((p) => p.id === active) || list[0]
          if (first) await loadPersona(first.id)
        })()
      }, [load, loadPersona])

      /** 主视图切到别的工作区 ⇒ 带新 cwd 重新读状态；同一个工作区不重复请求。 */
      React.useEffect(() => {
        if (workspaceCwd === '' || workspaceCwd === loadedCwdRef.current) return
        loadedCwdRef.current = workspaceCwd
        // force=false：切换工作区时保留未保存草稿（apply 里会说明并保留原项目）
        void load(workspaceCwd, false)
      }, [workspaceCwd, load])

      /** 脏标记在早退分支之前算：hook 顺序必须恒定，off-by-one 都会让 React 抛错。 */
      const personaDirty = pbase !== null && (pname !== pbase.name || pdesc !== pbase.description
        || soul !== pbase.soul || user !== pbase.user)
      const factDirty = fact !== factBase
      const projectDirty = projectText !== projectBase
      React.useEffect(() => {
        dirtyRef.current = { persona: personaDirty, fact: factDirty, project: projectDirty }
      })

      /** 工作区切换被未保存草稿挡住后，草稿清空（保存 / 改回原样）即补上那次切换。 */
      React.useEffect(() => {
        const pending = pendingWorkspaceRef.current
        if (pending === '' || projectDirty || data === null) return
        const list = (data.memory && data.memory.projects) || []
        const found = list.find((p) => p.path === pending)
        if (found === undefined) return
        pendingWorkspaceRef.current = ''
        workspacePathRef.current = pending
        projectPathRef.current = pending
        setProjectPath(pending)
        setProjectText(found.content)
        setProjectBase(found.content)
        setNote({ kind: 'ok', text: '已跟随工作区切到「' + pending + '」。' })
      }, [projectDirty, data])

      if (data === null) {
        return h('div', { className: 'dpm-root' },
          h('div', { className: 'dpm-top' }, h('span', { className: 'dpm-title' }, '角色 / 记忆')),
          h('div', { className: 'dpm-progress' }, busy ? h('i', { key: 'p' }) : null),
          note !== null && note.kind === 'err'
            ? h('div', { className: 'dpm-toast is-err' },
                icon('alert', 13), h('span', { className: 'dpm-toast-text' }, note.text))
            : null,
          h('div', { className: 'dpm-loading' },
            busy ? h('div', { className: 'dpm-spin' }) : null,
            h('div', null, busy ? '正在读取角色库与记忆…' : '尚未连上面板接口。'),
            busy ? null : h(Btn, { icon: 'refresh', size: 13, label: '重试', onClick: reload })))
      }

      const limits = limitsOf(data)

      const shared = { paths: data.paths, busy, limits, reload }

      const movePersona = (id, delta) => {
        const ids = data.persona.list.map((p) => p.id)
        const from = ids.indexOf(id)
        const to = from + delta
        if (from < 0 || to < 0 || to >= ids.length) return
        const next = ids.slice()
        next.splice(to, 0, next.splice(from, 1)[0])
        void guard(() => api('/api/persona/order', { order: next }))
      }

      const personaProps = Object.assign({}, shared, {
        personas: data.persona.list,
        active: data.persona.active,
        sel,
        pname,
        pdesc,
        soul,
        user,
        personaDirty,
        newOpen,
        newId,
        newName,
        newDescription,
        setPname,
        setPdesc,
        setSoul,
        setUser,
        setNewOpen,
        setNewId,
        setNewName,
        setNewDescription,
        selectPersona: (id) => {
          if (id !== sel && dirtyRef.current.persona
            && !window.confirm('角色「' + sel + '」的改动还没保存，切换会丢弃这些改动。继续？')) return
          void loadPersona(id)
        },
        movePersona,
        savePersona: () => guard(async () => {
          const payload = await api('/api/persona/save', { id: sel, name: pname, description: pdesc, soul, user })
          setPbase({ name: pname, description: pdesc, soul, user })
          return payload
        }, '角色已保存（新会话生效）'),
        usePersona: () => guard(() => api('/api/persona/use', { id: sel }), '已把 ' + sel + ' 设为当前角色'),
        deletePersona: () => {
          if (!window.confirm('删除角色 ' + sel + '？该目录会被整体删除。')) return
          void guard(async () => {
            const payload = await api('/api/persona/delete', { id: sel })
            setSel('')
            setPname('')
            setPdesc('')
            setSoul('')
            setUser('')
            setPbase(null)
            return payload
          }, '已删除 ' + sel)
        },
        createPersona: () => guard(async () => {
          const id = newId.trim()
          if (id === '') throw new Error('id 不能为空')
          const payload = await api('/api/persona/save', {
            id,
            name: newName.trim() || id,
            description: newDescription.trim(),
            create: true,
          })
          setNewId('')
          setNewName('')
          setNewDescription('')
          setNewOpen(false)
          await loadPersona(id)
          return payload
        }, '已新建角色'),
      })

      const memoryProps = Object.assign({}, shared, {
        fact,
        setFact,
        factDirty,
        resetFact: () => setFact(factBase),
        projects,
        projectPath,
        projectText,
        projectDirty,
        setProjectText,
        saveFact: () => guard(async () => {
          const payload = await api('/api/memory/save', { scope: 'global', content: fact })
          dirtyRef.current.fact = false
          return payload
        }, '已保存全局记忆（新会话生效）'),
        saveProject: () => guard(async () => {
          const payload = await api('/api/memory/save', { scope: 'project', path: projectPath, content: projectText })
          dirtyRef.current.project = false
          return payload
        }, '已保存项目记忆（新会话生效）'),
      })

      const journalProps = Object.assign({}, shared, {
        entries: data.journal.entries,
        journalCount: data.journal.count,
        journalText,
        journalTags,
        query,
        tag,
        hits,
        setJournalText,
        setJournalTags,
        setQuery,
        setTag,
        clearSearch: () => {
          setHits(null)
          setQuery('')
          setTag('')
        },
        searchByTag: (value) => {
          setTag(value)
          setQuery('')
          void guard(async () => {
            const payload = await api('/api/journal/search', { query: '', tag: value, limit: 50 })
            setHits(payload.entries)
            return null
          })
        },
        appendJournal: () => guard(async () => {
          const text = journalText.trim()
          if (text === '') throw new Error('内容不能为空')
          const tags = journalTags.split(',').map((t) => t.trim()).filter((t) => t !== '')
          const payload = await api('/api/journal/append', { text, tags })
          setJournalText('')
          setJournalTags('')
          setHits(null)
          return payload
        }, '已追加到日志'),
        searchJournal: () => guard(async () => {
          const payload = await api('/api/journal/search', { query, tag, limit: 50 })
          setHits(payload.entries)
          return null
        }),
      })

      /** Ctrl/Cmd+S：按当前标签页保存。 */
      const saveCurrent = () => {
        if (busy) return
        if (tab === 'persona' && sel !== '' && personaDirty) personaProps.savePersona()
        else if (tab === 'memory') {
          if (factDirty) void memoryProps.saveFact()
          if (projectDirty) void memoryProps.saveProject()
        }
      }

      const tabs = [
        ['persona', '角色', data.persona.list.length],
        ['memory', '记忆', null],
        ['journal', '日志', data.journal.count],
      ]

      return h('div', {
        className: 'dpm-root',
        onKeyDown: (e) => {
          if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
            e.preventDefault()
            saveCurrent()
          }
        },
      },
      h('div', { className: 'dpm-top' },
        h('div', { className: 'dpm-tabs', role: 'tablist' }, tabs.map(([key, label, count]) => h('button', {
          key,
          type: 'button',
          role: 'tab',
          'aria-selected': key === tab ? 'true' : 'false',
          className: 'dpm-tab',
          onClick: () => setTab(key),
        }, label, count === null ? null : h('span', { key: 'n', className: 'dpm-tab-n' }, count)))),
        h('span', { className: 'dpm-top-spacer' }),
        h(Btn, {
          iconOnly: true, icon: 'refresh', size: 13, title: '重新读取', ariaLabel: '重新读取',
          disabled: busy, onClick: reload,
        })),
      h('div', { className: 'dpm-progress' }, busy ? h('i', { key: 'p' }) : null),
      note === null
        ? null
        : h('div', { className: 'dpm-toast ' + (note.kind === 'err' ? 'is-err' : 'is-ok') },
            note.kind === 'err' ? icon('alert', 13) : icon('check', 13),
            h('span', { className: 'dpm-toast-text' }, note.text),
            h('button', {
              type: 'button',
              className: 'dpm-toast-x',
              title: '关闭',
              onClick: () => setNote(null),
            }, icon('x', 12))),
      h('div', { className: 'dpm-body' },
        tab === 'persona' ? h(PersonaTab, personaProps) : null,
        tab === 'memory' ? h(MemoryTab, memoryProps) : null,
        tab === 'journal' ? h(JournalTab, journalProps) : null),
      )
    }

    /* ───────────────────── 设置页：记忆功能管理 ─────────────────────
       注册在 `settings.section`（整页），不是 `settings.general.item`（单行）：
       这里要管三个注入开关，还要给附属插件留一块注册区。 */

    function SettingsSwitch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: 'dpm-switch',
        'aria-checked': props.checked === true ? 'true' : 'false',
        'aria-label': props.label,
        title: props.checked === true ? '已开启' : '已关闭',
        disabled: props.disabled === true,
        onClick: props.onChange,
      })
    }

    /** 一行设置：标题/说明/状态在左，控件在右。 */
    function SettingsRow(props) {
      return h('div', { className: 'dpm-row' },
        h('div', { className: 'dpm-row-main' },
          h('div', { className: 'dpm-row-title' }, props.title,
            props.tag === undefined ? null : h('span', { key: 'tag', className: 'dpm-badge' }, props.tag)),
          props.desc === undefined || props.desc === '' ? null
            : h('div', { key: 'd', className: 'dpm-row-desc' }, props.desc),
          props.meta === undefined || props.meta === '' ? null
            : h('div', { key: 'm', className: 'dpm-row-meta' }, props.meta),
          props.note === undefined || props.note === '' ? null
            : h('div', { key: 'n', className: 'dpm-row-note' }, props.note)),
        h('div', { className: 'dpm-row-aside' }, props.children))
    }

    /**
     * 附属插件通过宿主服务注册的声明式设置项。控件种类在宿主侧已校验，
     * 这里只负责画；值一律走 /api/settings/item 回写，成功后才更新显示。
     */
    function PluginSettingItem(props) {
      const item = props.item
      const isText = item.kind === 'text'
      const initial = typeof item.value === 'string' ? item.value : String(item.value ?? '')
      const [draft, setDraft] = React.useState(initial)
      React.useEffect(() => { setDraft(initial) }, [initial])

      const commitText = () => {
        if (draft === initial) return
        props.onCommit(item, draft)
      }

      let control = null
      if (item.kind === 'toggle') {
        control = h(SettingsSwitch, {
          checked: item.value === true,
          label: item.title,
          disabled: props.busy,
          onChange: () => props.onCommit(item, !(item.value === true)),
        })
      } else if (item.kind === 'select') {
        control = h('select', {
          className: 'dpm-input',
          value: String(item.value),
          disabled: props.busy,
          title: item.title,
          onChange: (event) => {
            const picked = (item.options || []).find((option) => String(option.value) === event.target.value)
            props.onCommit(item, picked === undefined ? event.target.value : picked.value)
          },
        }, (item.options || []).map((option) => h('option', {
          key: String(option.value),
          value: String(option.value),
        }, option.label)))
      } else if (item.kind === 'text') {
        control = [
          h('input', {
            key: 'i',
            className: 'dpm-input',
            value: draft,
            disabled: props.busy,
            placeholder: item.placeholder || '',
            title: item.title,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.nativeEvent?.isComposing) commitText()
            },
          }),
          h(Btn, {
            key: 'b',
            small: true,
            label: '保存',
            disabled: props.busy || draft === initial,
            onClick: commitText,
          }),
        ]
      } else {
        control = h('span', { className: 'dpm-row-meta' }, initial)
      }

      return h(SettingsRow, {
        title: item.title,
        desc: item.description,
        meta: item.kind === 'readonly' ? '' : undefined,
        note: item.note,
      }, control)
    }

    /**
     * 附属插件设置分组：超过 3 项时默认收起，点分组标题展开。
     *
     * 声明式注册表不知道附属插件会注册多少项（本机的自动召回有 10 项），
     * 全部平铺会把「记忆」页撑得很长；折叠后页面只多一行摘要。
     * 3 项以内不值得藏，保持展开。
     */
    function SettingsGroup(props) {
      const { group, busy, onCommit } = props
      const collapsible = group.items.length > 3
      const [open, setOpen] = React.useState(!collapsible)

      const rows = group.items.map((item) => h(PluginSettingItem, {
        key: item.id,
        item,
        busy,
        onCommit,
      }))

      if (!collapsible) {
        return h('div', { className: 'dpm-set-group' },
          h('div', { className: 'dpm-set-group-title' }, group.name),
          rows)
      }

      return h('div', { className: 'dpm-set-group' },
        h('button', {
          type: 'button',
          className: 'dpm-set-group-title dpm-set-group-toggle',
          'aria-expanded': open === true ? 'true' : 'false',
          title: open === true ? '收起' : '展开',
          onClick: () => setOpen(!open),
        },
          h('span', { key: 'chev', className: 'dpm-chev' + (open === true ? ' is-open' : '') }, icon('chevron', 12)),
          h('span', { key: 'name' }, group.name),
          h('span', { key: 'count', className: 'dpm-set-count' }, String(group.items.length)),
        ),
        open === true ? rows : null)
    }

    function SettingsPage(props) {
      const renderSlot = props.renderSlot
      const [data, setData] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const [busyKey, setBusyKey] = React.useState('')

      const apply = React.useCallback((settings) => {
        if (settings !== null && typeof settings === 'object') setData(settings)
      }, [])

      const guard = React.useCallback(async (key, fn, okNote) => {
        setBusyKey(key)
        setNote(null)
        try {
          const payload = await fn()
          if (payload.settings !== undefined) apply(payload.settings)
          if (okNote !== undefined) setNote({ kind: 'ok', text: okNote })
          return payload
        } catch (error) {
          setNote({ kind: 'err', text: String((error && error.message) || error) })
          return null
        } finally {
          setBusyKey('')
        }
      }, [apply])

      const load = React.useCallback(() => guard('load', () => api('/api/settings')), [guard])

      React.useEffect(() => { load() }, [load])

      /** 成功提示 4 秒后自动收掉；错误提示留着等人读。 */
      React.useEffect(() => {
        if (note === null || note.kind !== 'ok') return undefined
        const timer = window.setTimeout(() => setNote(null), 4000)
        return () => window.clearTimeout(timer)
      }, [note])

      const toggle = (key) => guard('inj:' + key, () => api('/api/settings/injection', {
        injection: { [key]: !(data.injection[key] === true) },
      }))

      const commitItem = (item, value) => guard('item:' + item.id,
        () => api('/api/settings/item', { id: item.id, value }),
        `已更新「${item.title}」`)

      const head = h('div', { className: 'dpm-set-head' },
        h('div', { className: 'dpm-set-head-main' },
          h('div', { className: 'dpm-set-title' }, '记忆功能管理'),
          h('div', { className: 'dpm-set-lead' },
            '控制角色设定与长期记忆往提示词里注入什么。开关立即对后续回合生效；记忆正文的编辑仍在右侧栏「角色 / 记忆」面板。')),
        h(Btn, {
          small: true,
          icon: 'refresh',
          label: '刷新',
          disabled: busyKey !== '',
          onClick: () => load(),
        }))

      const toast = note === null ? null : h('div', { className: 'dpm-toast is-' + note.kind },
        h('span', { className: 'dpm-toast-text' }, note.text),
        h('button', { type: 'button', className: 'dpm-toast-x', title: '关闭', onClick: () => setNote(null) }, icon('x', 12)))

      if (data === null) {
        return h('div', { className: 'dpm-set' }, head, toast,
          h('div', { className: 'dpm-loading' },
            h('div', { className: 'dpm-spin' }),
            h('span', null, '正在读取记忆设置…')))
      }

      const flags = data.injection || {}
      const context = data.context || {}
      const persona = context.persona || null
      const fact = context.fact || null
      const builtinRows = [
        {
          key: 'persona',
          title: '角色设定',
          desc: '注入当前角色的 SOUL.md 与 USER.md：我是谁，主人是谁。',
          meta: persona === null
            ? '角色库为空，先在右侧栏「角色 / 记忆」里建一个'
            : `当前角色：${persona.name}（${persona.id}）`,
        },
        {
          key: 'globalMemory',
          title: '全局记忆',
          desc: '注入 $DSH_HOME/memory/FACT.md：跨会话、跨项目都成立的长期事实。',
          meta: fact === null
            ? ''
            : `FACT.md ${fmtInt(fact.lines)} / ${fmtInt(fact.maxLines)} 行 · ${fmtInt(fact.bytes)} / ${fmtInt(fact.maxBytes)} 字节`,
        },
        {
          key: 'projectMemory',
          title: '项目记忆',
          desc: '注入当前项目根的 MEMORY.md：本工作区的约定、机制与踩坑。',
          meta: `已发现 ${fmtInt(context.projectCount || 0)} 个项目`,
        },
      ]

      const groups = []
      for (const item of data.items || []) {
        let group = groups.find((candidate) => candidate.name === item.group)
        if (group === undefined) {
          group = { name: item.group, items: [] }
          groups.push(group)
        }
        group.items.push(item)
      }

      return h('div', { className: 'dpm-set' },
        head,
        toast,
        h('div', { className: 'dpm-set-group' },
          h('div', { className: 'dpm-set-group-title' }, '注入开关'),
          builtinRows.map((row) => h(SettingsRow, {
            key: row.key,
            title: row.title,
            desc: row.desc,
            meta: row.meta,
            tag: data.overrides && typeof data.overrides[row.key] === 'boolean' ? '已手动设置' : undefined,
          }, h(SettingsSwitch, {
            checked: flags[row.key] === true,
            label: row.title,
            disabled: busyKey !== '',
            onChange: () => toggle(row.key),
          })))),
        groups.map((group) => h(SettingsGroup, {
          key: group.name,
          group,
          busy: busyKey !== '',
          onCommit: commitItem,
        })),
        // 客户端槽：给需要完整自定义界面的附属插件留的位置。每个贡献自己画整行。
        renderSlot === undefined ? null : renderSlot('settings.persona-memory.item', {}),
        h('div', { className: 'dpm-set-foot' },
          h('span', null, '开关覆盖：'),
          h('code', null, data.path || ''),
          h('span', null, '· 删除该文件即恢复组合配置的默认值。'),
          h('span', null, '当前会话下一轮生效；记忆正文改动仍是新会话生效。')))
    }

    /**
     * 打开右侧栏面板的头部按钮。
     *
     * sidebarRight.openTab() 要求右栏座位已挂载，座位未挂载时会抛错；
     * 先开一次右栏再重试，最终失败把原因显示出来（不要静默死按钮）。
     */
    function OpenButton() {
      const [note, setNote] = React.useState('')

      const attempt = (tries) => {
        const ctx = ctx0
        if (ctx === null) {
          setNote('插件尚未就绪')
          return
        }
        const sidebarRight = ctx.get('sidebarRight')
        if (sidebarRight === undefined) {
          setNote('侧栏控制器不可用')
          return
        }
        try {
          sidebarRight.openTab(TAB_KIND, { revealIfOpened: true })
          setNote('')
          return
        } catch (cause) {
          if (tries > 0) {
            try {
              if (sidebarRight.open !== undefined) sidebarRight.open()
            } catch {
              /* 座位挂载后重试即可 */
            }
            window.setTimeout(() => attempt(tries - 1), 120)
            return
          }
          setNote(String((cause && cause.message) || cause))
        }
      }

      return h('button', {
        className: 'dpm-openbtn' + (note === '' ? '' : ' is-warn'),
        type: 'button',
        title: note === '' ? '打开角色 / 记忆面板' : '打开失败：' + note,
        onClick: () => attempt(8),
      }, icon('star', 13), '角色', note === '' ? null : h('span', { key: 'warn' }, '⚠'))
    }

    /** apply 期间捕获的 ctx，供头部按钮回调使用。 */
    let ctx0 = null

    function apply(ctx) {
      ctx0 = ctx
      const slots = ctx.get('slots')
      if (slots === undefined) return

      ctx.effect(() => { mountStyles() }, 'persona-memory: panel styles')

      // tab 类型必须等 sidebarRightTabs 就绪再注册：本插件可能早于
      // ui-sidebar-right 装配，一次性 ctx.get 会读到 undefined，
      // 于是面板 body 在、tab 类型不在，点击必抛错。
      ctx.inject(['sidebarRightTabs'], (scope) => {
        scope.effect(() => scope.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          title: () => '角色 / 记忆',
        }), 'persona-memory: sidebar tab type')
      })

      ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
      }, Pane)), 'persona-memory: sidebar pane body')

      ctx.effect(() => slots.inject('conversation.session.header.utilities', () => slots.register({
        name: 'conversation.session.header.utilities',
        id: 'dsh-persona-memory-open',
        order: 61,
        label: () => '角色 / 记忆',
      }, OpenButton)), 'persona-memory: header open button')

      // 设置页：整页 section。子槽 `settings.persona-memory.item` 必须由本注册项声明，
      // 附属插件的客户端半才能往里注册自定义行；声明随本注册项一起回收。
      ctx.effect(() => slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'persona-memory',
        order: 40,
        label: '记忆',
        children: {
          'settings.persona-memory.item': { kind: 'list', scope: 'root' },
        },
      }, SettingsPage)), 'persona-memory: settings section')
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
