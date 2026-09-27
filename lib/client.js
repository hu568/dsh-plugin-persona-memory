/**
 * @dsh-external/dsh-persona-memory — client half（手写 ModuleLoader 包，免构建链）。
 *
 * 提供右侧栏「角色 / 记忆」标签页：
 *   - 角色：角色列表、切换当前角色、编辑 name/description/SOUL.md/USER.md、新建、删除
 *   - 记忆：全局 FACT.md 编辑、项目 MEMORY.md 编辑（按活动会话 cwd 发现的项目）
 *   - 日志：JOURNAL.jsonl 最近条目 + 追加 + 检索
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

    /** slots 是硬依赖：没有它就没有任何 UI 挂载点。 */
    const inject = ['slots']

    const css = {
      wrap: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        fontSize: '12px',
      },
      bar: {
        display: 'flex',
        gap: '6px',
        alignItems: 'center',
        padding: '8px',
        borderBottom: '1px solid var(--dsh-border, rgba(127,127,127,0.25))',
        flex: '0 0 auto',
      },
      tabs: {
        display: 'flex',
        gap: '4px',
        padding: '6px 8px',
        borderBottom: '1px solid var(--dsh-border, rgba(127,127,127,0.25))',
        flex: '0 0 auto',
      },
      tab: {
        padding: '3px 10px',
        borderRadius: '999px',
        border: '1px solid transparent',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '12px',
        opacity: 0.7,
      },
      tabActive: {
        padding: '3px 10px',
        borderRadius: '999px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))',
        background: 'var(--dsh-surface-2, rgba(127,127,127,0.12))',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '12px',
        opacity: 1,
      },
      body: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '10px' },
      section: { marginBottom: '14px' },
      label: { display: 'block', opacity: 0.65, margin: '6px 0 3px' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '4px 6px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))',
        background: 'transparent',
        color: 'inherit',
        fontSize: '12px',
      },
      area: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))',
        background: 'transparent',
        color: 'inherit',
        fontSize: '12px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        lineHeight: 1.5,
        resize: 'vertical',
      },
      button: {
        padding: '4px 10px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '12px',
      },
      primary: {
        padding: '4px 10px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-accent, #4b7bec)',
        background: 'var(--dsh-accent, #4b7bec)',
        color: '#fff',
        cursor: 'pointer',
        fontSize: '12px',
      },
      row: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' },
      card: {
        border: '1px solid var(--dsh-border, rgba(127,127,127,0.25))',
        borderRadius: '8px',
        padding: '8px',
        marginBottom: '6px',
        cursor: 'pointer',
      },
      cardActive: {
        border: '1px solid var(--dsh-accent, #4b7bec)',
        borderRadius: '8px',
        padding: '8px',
        marginBottom: '6px',
        cursor: 'pointer',
        background: 'var(--dsh-surface-2, rgba(127,127,127,0.08))',
      },
      hint: { opacity: 0.6, lineHeight: 1.6, marginBottom: '8px' },
      note: { padding: '0 8px 6px', opacity: 0.75, minHeight: '16px', color: 'var(--dsh-warn, #c07000)' },
      entry: {
        borderLeft: '2px solid var(--dsh-border, rgba(127,127,127,0.35))',
        padding: '3px 8px',
        marginBottom: '5px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      tag: { opacity: 0.6, marginRight: '6px' },
    }

    /** 调宿主半的 JSON API。 */
    async function api(path, body) {
      const res = await fetch(BASE + path, body === undefined
        ? { method: 'GET' }
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
      let payload = null
      try {
        payload = await res.json()
      } catch {
        payload = null
      }
      if (!res.ok || payload === null || payload.ok === false) {
        throw new Error((payload && payload.error) || `HTTP ${res.status}`)
      }
      return payload
    }

    function PersonaTab(props) {
      const s = props
      return h('div', null,
        h('div', { style: css.hint },
          '角色库：', h('code', null, s.paths.personas),
          h('br'),
          '角色在会话**首条消息**时固化进提示词——切换/编辑对新会话生效。'),
        h('div', { style: { ...css.row, marginBottom: '8px' } },
          h('button', { style: css.button, onClick: s.reload, disabled: s.busy }, '刷新'),
          h('span', { style: { opacity: 0.6 } }, `当前角色：${s.active || '（无）'}`)),
        h('div', null, s.personas.length === 0
          ? h('div', { style: css.hint }, '角色库为空，先在下面新建一个。')
          : s.personas.map((p) => h('div', {
              key: p.id,
              style: p.id === s.sel ? css.cardActive : css.card,
              onClick: () => s.selectPersona(p.id),
            },
            h('div', { style: { fontWeight: 600 } }, p.name, ' ', h('span', { style: { opacity: 0.55, fontWeight: 400 } }, p.id)),
            p.description ? h('div', { style: { opacity: 0.7, marginTop: '2px' } }, p.description) : null,
            p.active ? h('div', { style: { color: 'var(--dsh-accent, #4b7bec)', marginTop: '2px' } }, '● 当前角色') : null))),

        s.sel ? h('div', { style: { ...css.section, marginTop: '12px' } },
          h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, `编辑：${s.sel}`),
          h('label', { style: css.label }, '角色名'),
          h('input', { style: css.input, value: s.pname, onChange: (e) => s.setPname(e.target.value) }),
          h('label', { style: css.label }, '一句话简介'),
          h('input', { style: css.input, value: s.pdesc, onChange: (e) => s.setPdesc(e.target.value) }),
          h('label', { style: css.label }, 'SOUL.md（人格设定）'),
          h('textarea', { style: css.area, rows: 12, value: s.soul, onChange: (e) => s.setSoul(e.target.value) }),
          h('label', { style: css.label }, 'USER.md（该角色的用户档案）'),
          h('textarea', { style: css.area, rows: 6, value: s.user, onChange: (e) => s.setUser(e.target.value) }),
          h('div', { style: { ...css.row, marginTop: '6px' } },
            h('button', { style: css.primary, disabled: s.busy, onClick: s.savePersona }, '保存'),
            s.sel !== s.active
              ? h('button', { style: css.button, disabled: s.busy, onClick: s.usePersona }, '设为当前角色')
              : null,
            h('button', { style: { ...css.button, marginLeft: 'auto' }, disabled: s.busy, onClick: s.deletePersona }, '删除角色')))
          : null,

        h('div', { style: { ...css.section, marginTop: '14px' } },
          h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '新建角色'),
          h('label', { style: css.label }, 'id（小写字母/数字/中横线，即目录名）'),
          h('input', {
            style: css.input,
            value: s.newId,
            placeholder: 'meow-teacher',
            onChange: (e) => s.setNewId(e.target.value),
          }),
          h('label', { style: css.label }, '角色名'),
          h('input', {
            style: css.input,
            value: s.newName,
            placeholder: '喵喵老师',
            onChange: (e) => s.setNewName(e.target.value),
          }),
          h('label', { style: css.label }, '一句话简介'),
          h('input', {
            style: css.input,
            value: s.newDescription,
            onChange: (e) => s.setNewDescription(e.target.value),
          }),
          h('div', { style: { ...css.row, marginTop: '6px' } },
            h('button', { style: css.primary, disabled: s.busy, onClick: s.createPersona }, '新建'))),
      )
    }

    function MemoryTab(props) {
      const s = props
      return h('div', null,
        h('div', { style: css.hint },
          '全局记忆 ', h('code', null, s.paths.fact),
          h('br'),
          '项目记忆按活动会话的 cwd 向上查找 MEMORY.md；没有就不注入。'),
        h('div', { style: css.section },
          h('div', { style: { ...css.row, justifyContent: 'space-between' } },
            h('div', { style: { fontWeight: 600 } }, '全局记忆 · FACT.md'),
            h('button', { style: css.primary, disabled: s.busy, onClick: s.saveFact }, '保存')),
          h('textarea', { style: css.area, rows: 12, value: s.fact, onChange: (e) => s.setFact(e.target.value) })),
        h('div', { style: css.section },
          h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '项目记忆 · MEMORY.md'),
          s.projects.length === 0
            ? h('div', { style: css.hint }, '还没有发现任何项目（本进程里还没有带 cwd 的会话）。')
            : h('label', { style: css.label }, '项目'),
          s.projects.length === 0
            ? null
            : h('select', {
                style: css.input,
                value: s.projectPath,
                onChange: (e) => s.selectProject(e.target.value),
              }, s.projects.map((p) => h('option', { key: p.path, value: p.path },
                `${p.exists ? '' : '（未创建）'} ${p.root}`))),
          s.projects.length === 0
            ? null
            : h('textarea', { style: css.area, rows: 10, value: s.projectText, onChange: (e) => s.setProjectText(e.target.value) }),
          s.projects.length === 0
            ? null
            : h('div', { style: { ...css.row, marginTop: '6px' } },
                h('button', { style: css.primary, disabled: s.busy, onClick: s.saveProject }, '保存项目记忆'),
                h('span', { style: { opacity: 0.6 } }, s.projectPath))),
      )
    }

    function JournalTab(props) {
      const s = props
      return h('div', null,
        h('div', { style: css.hint },
          '长期记忆 ', h('code', null, s.paths.journal),
          `　共 ${s.journalCount} 条`),
        h('div', { style: css.section },
          h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '追加一条'),
          h('textarea', {
            style: css.area,
            rows: 3,
            value: s.journalText,
            placeholder: '这次会话值得记住的事件 / 决定 / 结论',
            onChange: (e) => s.setJournalText(e.target.value),
          }),
          h('label', { style: css.label }, '标签（逗号分隔，可选）'),
          h('input', { style: css.input, value: s.journalTags, onChange: (e) => s.setJournalTags(e.target.value) }),
          h('div', { style: { ...css.row, marginTop: '6px' } },
            h('button', { style: css.primary, disabled: s.busy, onClick: s.appendJournal }, '追加'))),
        h('div', { style: css.section },
          h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '检索'),
          h('div', { style: css.row },
            h('input', {
              style: { ...css.input, flex: '1 1 120px' },
              placeholder: '子串',
              value: s.query,
              onChange: (e) => s.setQuery(e.target.value),
            }),
            h('input', {
              style: { ...css.input, flex: '0 1 90px' },
              placeholder: 'tag',
              value: s.tag,
              onChange: (e) => s.setTag(e.target.value),
            }),
            h('button', { style: css.button, disabled: s.busy, onClick: s.searchJournal }, '搜索'))),
        h('div', { style: css.section },
          h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, s.hits === null ? '最近条目' : `检索结果（${s.hits.length}）`),
          ((s.hits === null ? s.entries : s.hits) || []).map((entry, index) => h('div', { key: `${entry.ts}-${index}`, style: css.entry },
            h('span', { style: css.tag }, entry.ts),
            (entry.tags || []).map((t) => h('span', { key: t, style: css.tag }, `#${t}`)),
            h('div', null, entry.text)))),
      )
    }

    function Pane() {
      const [data, setData] = React.useState(null)
      const [tab, setTab] = React.useState('persona')
      const [note, setNote] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [sel, setSel] = React.useState('')
      const [pname, setPname] = React.useState('')
      const [pdesc, setPdesc] = React.useState('')
      const [soul, setSoul] = React.useState('')
      const [user, setUser] = React.useState('')
      const [newId, setNewId] = React.useState('')
      const [newName, setNewName] = React.useState('')
      const [newDescription, setNewDescription] = React.useState('')
      const [fact, setFact] = React.useState('')
      const [projects, setProjects] = React.useState([])
      const [projectPath, setProjectPath] = React.useState('')
      const [projectText, setProjectText] = React.useState('')
      const [journalText, setJournalText] = React.useState('')
      const [journalTags, setJournalTags] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [tag, setTag] = React.useState('')
      const [hits, setHits] = React.useState(null)

      /** 统一信封归一：`{ok,state}` 或裸 state 都接受（后端两种形状的历史包袱）。 */
      const unwrap = (payload) => {
        if (payload === null || payload === undefined) return null
        if (payload.state && typeof payload.state === 'object') return payload.state
        if (payload.paths && payload.persona) return payload
        return null
      }

      /** 当前选中的项目路径（apply 是稳定回调，读不到最新 state，用 ref 兜）。 */
      const projectPathRef = React.useRef('')
      React.useEffect(() => {
        projectPathRef.current = projectPath
      }, [projectPath])

      const apply = React.useCallback((payload) => {
        setData(payload)
        setFact(payload.memory.global.content)
        const list = payload.memory.projects || []
        setProjects(list)
        const current = projectPathRef.current
        const next = list.some((p) => p.path === current) ? current : (list[0] ? list[0].path : '')
        projectPathRef.current = next
        setProjectPath(next)
        const found = list.find((p) => p.path === next)
        setProjectText(found ? found.content : '')
      }, [])

      const guard = React.useCallback(async (fn, okNote) => {
        setBusy(true)
        setNote('')
        try {
          const payload = await fn()
          const next = unwrap(payload)
          if (next !== null) apply(next)
          if (okNote) setNote(okNote)
          return payload
        } catch (error) {
          setNote(String((error && error.message) || error))
          return null
        } finally {
          setBusy(false)
        }
      }, [apply])

      const load = React.useCallback(() => guard(() => api('/api/state')), [guard])

      const loadPersona = React.useCallback(async (id) => {
        setSel(id)
        try {
          const payload = await api('/api/persona/show', { id })
          setPname(payload.persona.name)
          setPdesc(payload.persona.description)
          setSoul(payload.persona.soul)
          setUser(payload.persona.user)
        } catch (error) {
          setNote(String((error && error.message) || error))
        }
      }, [])

      React.useEffect(() => {
        void (async () => {
          const payload = await guard(() => api('/api/state'))
          const next = unwrap(payload)
          const list = next === null ? [] : next.persona.list
          const active = next === null ? '' : next.persona.active
          const first = list.find((p) => p.id === active) || list[0]
          if (first) await loadPersona(first.id)
        })()
      }, [guard, loadPersona])

      if (data === null) {
        return h('div', { style: css.wrap },
          h('div', { style: css.bar }, '角色 / 记忆'),
          h('div', { style: css.note }, note || '加载中…'),
          note !== ''
            ? h('div', { style: css.body },
                h('button', { style: css.button, onClick: load }, '重试'))
            : null)
      }

      const selectedProject = projects.find((p) => p.path === projectPath) || null
      const selectProject = (path) => {
        setProjectPath(path)
        const found = projects.find((p) => p.path === path)
        setProjectText(found ? found.content : '')
      }

      const shared = {
        paths: data.paths,
        busy,
        note,
        reload: load,
        setNote,
      }

      const personaProps = {
        ...shared,
        personas: data.persona.list,
        active: data.persona.active,
        sel,
        pname,
        pdesc,
        soul,
        user,
        newId,
        newName,
        newDescription,
        setPname,
        setPdesc,
        setSoul,
        setUser,
        setNewId,
        setNewName,
        setNewDescription,
        selectPersona: loadPersona,
        savePersona: () => guard(
          () => api('/api/persona/save', { id: sel, name: pname, description: pdesc, soul, user }),
          '已保存（新会话生效）',
        ),
        usePersona: () => guard(() => api('/api/persona/use', { id: sel }), `已切换到 ${sel}`),
        deletePersona: () => {
          if (!window.confirm(`删除角色 ${sel}？该目录会被整体删除。`)) return
          void guard(() => api('/api/persona/delete', { id: sel }), `已删除 ${sel}`)
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
          await loadPersona(id)
          return payload
        }, '已新建角色'),
      }

      const memoryProps = {
        ...shared,
        fact,
        setFact,
        projects,
        projectPath,
        projectText,
        setProjectText,
        selectProject,
        saveFact: () => guard(() => api('/api/memory/save', { scope: 'global', content: fact }), '已保存全局记忆（新会话生效）'),
        saveProject: () => guard(
          () => api('/api/memory/save', { scope: 'project', path: projectPath, content: projectText }),
          '已保存项目记忆（新会话生效）',
        ),
      }

      const journalProps = {
        ...shared,
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
        appendJournal: () => guard(async () => {
          const text = journalText.trim()
          if (text === '') throw new Error('内容不能为空')
          const tags = journalTags.split(',').map((t) => t.trim()).filter((t) => t !== '')
          const payload = await api('/api/journal/append', { text, tags })
          setJournalText('')
          setJournalTags('')
          setHits(null)
          return payload
        }, '已追加'),
        searchJournal: () => guard(async () => {
          const payload = await api('/api/journal/search', { query, tag, limit: 50 })
          setHits(payload.entries)
          return null
        }),
      }

      const tabs = [['persona', '角色'], ['memory', '记忆'], ['journal', '日志']]

      return h('div', { style: css.wrap },
        h('div', { style: css.tabs }, tabs.map(([key, label]) => h('button', {
          key,
          style: key === tab ? css.tabActive : css.tab,
          onClick: () => setTab(key),
        }, label))),
        h('div', { style: css.note }, note),
        h('div', { style: css.body },
          tab === 'persona' ? h(PersonaTab, personaProps) : null,
          tab === 'memory' ? h(MemoryTab, memoryProps) : null,
          tab === 'journal' ? h(JournalTab, journalProps) : null),
      )
    }

    /**
     * 打开右侧栏面板的头部按钮。
     *
     * `sidebarRight.openTab()` 要求右栏座位已挂载，座位未挂载时会抛错；
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
        style: css.button,
        type: 'button',
        title: note === '' ? '打开角色 / 记忆面板' : `打开失败：${note}`,
        onClick: () => attempt(8),
      }, note === '' ? '角色' : '角色 ⚠')
    }

    /** apply 期间捕获的 ctx，供头部按钮回调使用。 */
    let ctx0 = null

    function apply(ctx) {
      ctx0 = ctx
      const slots = ctx.get('slots')
      if (slots === undefined) return

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
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
