/**
 * dsh-provenance — Client half.
 *
 * Three jobs, all browser-side:
 *  1. Arm a selection mode from a header button or the hotkey.
 *  2. Capture the selected sentence and post it to the Host route.
 *  3. Render the provenance panel and paint highlights over the chat DOM
 *     without touching React-managed nodes (CSS Custom Highlight API).
 *
 * The panel lives in `shell.overlay` (frame-wide, outside every scroll
 * container) so its fixed position cannot be captured by the composer's
 * stacking context. The header button records the current session for it.
 */

window.__ModuleLoader__.load({
  id: 'dsh-chat-source-tracer',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement

    const ROUTE = '/plugins/dsh-chat-source-tracer/trace'
    const MESSAGE_ROUTE = '/plugins/dsh-chat-source-tracer/message'
    const LOCATE_ROUTE = '/plugins/dsh-chat-source-tracer/locate'
    const EVIDENCE_LOCATE_ROUTE = '/plugins/dsh-chat-source-tracer/locate-evidence'
    const CORROBORATE_ROUTE = '/plugins/dsh-chat-source-tracer/corroborate'
    const SEARCH_ROUTE = '/plugins/dsh-chat-source-tracer/search'
    const RELATED_ROUTE = '/plugins/dsh-chat-source-tracer/related'
    const RELATION_ROUTE = '/plugins/dsh-chat-source-tracer/relationships'
    const DIAGRAM_ROUTE = '/plugins/dsh-chat-source-tracer/diagram'
    const pendingCrossJump = { value: null }
    const ARM_EVENT = 'dsh-provenance:arm'
    const JUMP_EVENT = 'dsh-provenance:jump-to-source'
    const CLAIM_HIGHLIGHT = 'dsp-claim'
    const SOURCE_HIGHLIGHT = 'dsp-source'
    const FOCUS_HIGHLIGHT = 'dsp-focus'
    const KEYWORD_HIGHLIGHT = 'dsp-keyword'
    const SEARCH_HIGHLIGHT = 'dsp-search'
    const SEARCH_CURRENT_HIGHLIGHT = 'dsp-search-current'
    const SIZE_KEY = 'dsh-provenance:size:v1'
    const FEEDBACK_KEY = 'dsh-provenance:feedback:v1'
    // Session-scoped detail behind the flat FEEDBACK_KEY set: enough to tell
    // the Host which (seq, quote) pairs a user already marked wrong for a
    // given session, so a later trace in that same session can tell the
    // attribution model not to bring them back.
    const FEEDBACK_DETAIL_KEY = 'dsh-provenance:feedback-detail:v1'
    const FEEDBACK_DETAIL_MAX = 300
    const LEDGER_KEY = 'dsh-provenance:ledger:v1'

    /** Panel and trigger are separate slots, so they share this tiny store. */
    const sessionStore = {
      id: null,
      listeners: new Set(),
      set(id) {
        const next = id ? String(id) : null
        if (this.id === next) return
        this.id = next
        for (const listener of this.listeners) listener()
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }

    function useActiveSession() {
      return React.useSyncExternalStore(
        listener => sessionStore.subscribe(listener),
        () => sessionStore.id,
      )
    }

    /** Shared "trace mode is on" flag for the composer button's animation. */
    const traceModeStore = {
      active: false,
      listeners: new Set(),
      set(active) {
        const next = Boolean(active)
        if (this.active === next) return
        this.active = next
        for (const listener of this.listeners) listener()
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }

    function useTraceMode() {
      return React.useSyncExternalStore(
        listener => traceModeStore.subscribe(listener),
        () => traceModeStore.active,
      )
    }

    /* ------------------------------------------------------------- ledger --- */

    const TRASH_MAX_ITEMS = 50
    const TRASH_RETENTION_DAYS = 30
    const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000
    let ledgerWritePending = false

    function retainTrash(entries, now = Date.now()) {
      return entries.filter(validTrashEntry).map(entry => {
        // Older malformed timestamps receive one retention window, saved on
        // migration. Clamp future dates so they cannot escape expiry forever.
        const deletedAt = Number.isFinite(entry.deletedAt) && entry.deletedAt >= 0
          ? Math.min(entry.deletedAt, now) : now
        return deletedAt === entry.deletedAt ? entry : { ...entry, deletedAt }
      }).filter(entry => now - entry.deletedAt <= TRASH_RETENTION_MS)
        .sort((left, right) => right.deletedAt - left.deletedAt)
        .slice(0, TRASH_MAX_ITEMS)
    }

    function sameTrash(left, right) {
      return left.length === right.length && left.every((entry, index) => entry === right[index])
    }

    function emptyLedger() {
      return { decisions: [], assumptions: [], notes: [], trash: [] }
    }

    function loadLedger() {
      try {
        const raw = JSON.parse(localStorage.getItem(LEDGER_KEY) || 'null')
        if (raw && Array.isArray(raw.decisions) && Array.isArray(raw.assumptions)) {
          const ledger = {
            decisions: raw.decisions,
            assumptions: raw.assumptions,
            notes: Array.isArray(raw.notes) ? raw.notes : [],
            trash: Array.isArray(raw.trash) ? raw.trash : [],
          }
          const trash = retainTrash(ledger.trash)
          const next = { ...ledger, trash }
          if (!sameTrash(ledger.trash, trash)) saveLedger(next)
          return next
        }
      } catch {
        // Corrupt or missing storage starts an empty archive.
      }
      return emptyLedger()
    }

    function saveLedger(value) {
      try {
        localStorage.setItem(LEDGER_KEY, JSON.stringify(value))
        ledgerWritePending = false
        return true
      } catch {
        // The in-memory archive still works when storage is denied.
        ledgerWritePending = true
        return false
      }
    }

    /** Decisions and assumptions are shared by the panel and the Archive view. */
    const ledgerStore = {
      value: loadLedger(),
      listeners: new Set(),
      retentionTimer: null,
      retentionWake: null,
      get() {
        return this.value
      },
      update(mutator, { requirePersistence = false } = {}) {
        const current = {
          decisions: [...this.value.decisions],
          assumptions: [...this.value.assumptions],
          notes: [...this.value.notes],
          trash: [...this.value.trash],
        }
        // Older save paths return only the three active collections.
        const next = { ...current, ...mutator(current) }
        next.trash = retainTrash(next.trash)
        const persisted = saveLedger(next)
        // Never remove an item if its recoverable copy cannot be saved.
        if (requirePersistence && !persisted) return false
        this.value = next
        for (const listener of this.listeners) listener()
        return persisted
      },
      prune() {
        const trash = retainTrash(this.value.trash)
        if (sameTrash(trash, this.value.trash) && !ledgerWritePending) return true
        const next = { ...this.value, trash }
        if (!saveLedger(next)) return false
        this.value = next
        for (const listener of this.listeners) listener()
        return true
      },
      subscribe(listener) {
        this.listeners.add(listener)
        if (this.listeners.size === 1) {
          this.prune()
          // One sweep per minute while the plugin is running; waking a
          // suspended app checks immediately, as does every archive update.
          if (typeof window.setInterval === 'function') this.retentionTimer = window.setInterval(() => this.prune(), 60000)
          this.retentionWake = () => this.prune()
          if (typeof window.addEventListener === 'function') window.addEventListener('focus', this.retentionWake)
          if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.retentionWake)
        }
        return () => {
          this.listeners.delete(listener)
          if (this.listeners.size) return
          if (this.retentionTimer !== null) window.clearInterval(this.retentionTimer)
          if (typeof window.removeEventListener === 'function') window.removeEventListener('focus', this.retentionWake)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.retentionWake)
          this.retentionTimer = null
          this.retentionWake = null
        }
      },
    }

    function useLedger() {
      const [value, setValue] = React.useState(ledgerStore.get())
      React.useEffect(() => ledgerStore.subscribe(() => setValue(ledgerStore.get())), [])
      return value
    }

    function makeId(prefix) {
      return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    }

    function validTrashEntry(entry) {
      return entry && ['notes', 'decisions', 'assumptions'].includes(entry.kind)
        && typeof entry.id === 'string' && entry.item && typeof entry.item.id === 'string'
    }

    /** Move the complete record atomically; linked assumptions stay independent. */
    function recycleLedgerItem(kind, id) {
      if (!['notes', 'decisions', 'assumptions'].includes(kind)) return 'missing'
      const item = ledgerStore.get()[kind].find(record => record.id === id)
      if (!item) return 'missing'
      const persisted = ledgerStore.update(current => ({
        ...current,
        [kind]: current[kind].filter(record => record.id !== id),
        trash: [{ id: makeId('trash'), kind, item, deletedAt: Date.now() }, ...current.trash],
      }), { requirePersistence: true })
      return persisted ? 'moved' : 'storage-error'
    }

    function restoreLedgerItem(id) {
      if (!ledgerStore.prune()) return 'storage-error'
      const entry = ledgerStore.get().trash.find(record => record.id === id)
      if (!entry) return 'missing'
      // Keep both versions if an active record already owns this identity.
      if (ledgerStore.get()[entry.kind].some(item => item.id === entry.item.id)) return 'duplicate'
      const persisted = ledgerStore.update(current => ({
        ...current,
        [entry.kind]: [entry.item, ...current[entry.kind]]
          .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0)),
        trash: current.trash.filter(record => record.id !== id),
      }), { requirePersistence: true })
      return persisted ? 'restored' : 'storage-error'
    }

    function recycleNotice(status, t) {
      if (status === 'moved') return t(`已移入回收站，最多保留 ${TRASH_MAX_ITEMS} 条，超过 ${TRASH_RETENTION_DAYS} 天或容量上限自动清理。`, `Moved to the recycle bin. Items beyond ${TRASH_RETENTION_DAYS} days or the ${TRASH_MAX_ITEMS}-item limit are removed automatically.`)
      if (status === 'restored') return t('已恢复到原来的分类。', 'Restored to its original category.')
      if (status === 'duplicate') return t('原列表已有同编号内容，这条记录仍保留在回收站。', 'An active record has the same ID. This copy remains in the recycle bin.')
      if (status === 'storage-error') return t('本机保存失败，内容未移动。请先导出备份，再重试。', 'Local save failed; nothing was moved. Export a backup before retrying.')
      return t('这条内容已处理，请查看最新列表。', 'This item has already been handled. Check the updated list.')
    }

    function RecycleBin({ entries, en, archive = false, onRestore }) {
      const t = (zh, english) => en ? english : zh
      const prefix = archive ? 'dpl' : 'dsp'
      const kindLabel = kind => kind === 'notes' ? t('摘录', 'Note')
        : kind === 'decisions' ? t('结论', 'Conclusion') : t('假设', 'Assumption')
      return h('div', { className: 'dpr-list', role: 'region', 'aria-label': t('回收站内容', 'Recycle bin contents') },
        h('div', { className: `${prefix}-note dpr-hint` },
          t(`所有会话合计最多 ${TRASH_MAX_ITEMS} 条；移入超过 ${TRASH_RETENTION_DAYS} 天自动清理，超出容量时优先清理最早移入的内容。`, `Up to ${TRASH_MAX_ITEMS} items across all conversations. Items older than ${TRASH_RETENTION_DAYS} days expire; the oldest deleted items are removed first when full.`)),
        entries.length ? entries.map(entry => h('div', {
          key: entry.id, className: archive ? 'dpl-card' : 'dsp-note-item', 'data-trash-id': entry.id,
        },
          h('div', { className: 'dpr-kind' }, kindLabel(entry.kind)),
          h(CollapsibleText, { text: entry.item.text || entry.item.claim, en, variant: 'record', className: archive ? 'dpl-note' : 'dsp-note-text',
            metadata: h('div', { className: archive ? 'dpl-meta' : 'dsp-note-meta' },
              h(CompactMeta, { time: entry.deletedAt, en, prefix: t('删除于 ', 'Deleted ') })),
          }),
          h('div', { className: archive ? 'dpl-actions' : 'dsp-note-actions' },
            h('button', { type: 'button', className: `${prefix}-btn`, onClick: () => onRestore(entry.id),
              title: t('恢复到', 'Restore to ') + kindLabel(entry.kind) }, t('恢复', 'Restore'))),
        )) : h('div', { className: archive ? 'dpl-empty' : 'dsp-note' }, t('回收站是空的。', 'The recycle bin is empty.')),
      )
    }

    /** Hand a focus identity to the Archive view and activate its tab. */
    const ledgerFocus = { value: null, sessionId: null }
    const LEDGER_FOCUS_EVENT = 'dsh-provenance:focus-archive'

    function openLedger(ctx, sessionId, focus) {
      ledgerFocus.value = focus || null
      ledgerFocus.sessionId = sessionId
      // binding.activate() assembles target data; only the native tab also
      // updates the shell's selected view. Follow that same click path.
      const opened = clickConversationTab(['档案', 'Archive'], sessionId)
      if (opened) window.dispatchEvent(new CustomEvent(LEDGER_FOCUS_EVENT, { detail: { sessionId } }))
      return opened
    }

    /** Switch the conversation back to the chat view before focusing text. */
    function openChat(ctx, sessionId) {
      if (clickConversationTab(['对话', 'Chat'], sessionId)) return true
      try {
        const ui = ctx.get('uiConversation')
        const binding = ui?.binding?.(sessionId)
        if (binding && typeof binding.activate === 'function') {
          binding.activate('chat')
          return true
        }
      } catch {
        // Leave the current view; the focus retry will simply fall back.
      }
      return false
    }

    /** Open another conversation by id; the string form is what the shell uses. */
    function openSessionById(ctx, sessionId) {
      const workspace = ctx.get('uiWorkspace')
      if (!workspace || typeof workspace.openSession !== 'function') return false
      try {
        workspace.openSession(sessionId)
        return true
      } catch {
        // Some builds accept an addressed target object instead.
      }
      try {
        workspace.openSession({ kind: 'session', sessionId })
        return true
      } catch {
        return false
      }
    }

    /** Select the resident shell tab, scoped to the requested conversation. */
    function clickConversationTab(labels, sessionId) {
      const roots = []
      if (sessionId) {
        for (const occurrence of document.querySelectorAll(`[data-conversation-session="${CSS.escape(sessionId)}"]`)) {
          let root = occurrence
          for (let depth = 0; root && depth < 8; depth++, root = root.parentElement) {
            const tabs = root.querySelector('[data-conversation-tabs]')
            if (tabs) { roots.push(tabs); break }
          }
        }
      }
      if (!roots.length) roots.push(...document.querySelectorAll('[data-conversation-tabs], [role="tablist"]'))
      for (const root of roots) {
        for (const element of root.querySelectorAll('button, [role="tab"], a')) {
          if (element.closest('.dsp-card, .dsp-pill, .dsp-hint, .dsp-source-actions, .dsp-reading-return')) continue
          const text = (element.textContent || '').trim()
          const rect = element.getBoundingClientRect()
          if (labels.includes(text) && !element.disabled && rect.width && rect.height && getComputedStyle(element).visibility !== 'hidden') {
            if (element.getAttribute('aria-selected') !== 'true') element.click()
            return true
          }
        }
      }
      return false
    }

    function clickChatTab() {
      return clickConversationTab(['对话', 'Chat'], sessionStore.id)
    }

    function findTurnRail() {
      for (const nav of document.querySelectorAll('nav')) {
        const label = nav.getAttribute('aria-label') || ''
        if (label.includes('轮次') || /turn/i.test(label) || nav.querySelector('button[data-index]')) {
          return nav
        }
      }
      return null
    }

    function messageIdentity(element) {
      // Real DSH renders a stable ChatNodeSeat and finalNode.seq, not a seq DOM attribute.
      // Walk only the selected subtree's ancestors; compatibility reads fail closed.
      let fiber = reactFiberOf(element)
      for (let depth = 0; fiber && depth < 32; depth++, fiber = fiber.return) {
        const props = fiber.memoizedProps
        const node = props?.node || props?.owner?.node || props?.children?.props?.node
        const data = node?.data?.finalNode || node?.data || node
        if (Number.isSafeInteger(data?.seq)) {
          return { seq: data.seq, role: data.kind === 'assistant' ? 'assistant' : data.kind === 'user' || data.kind === 'steering' ? 'user' : undefined,
            messageId: data.messageId, turn: data.turn, step: data.step }
        }
      }
      const row = element?.closest?.('[data-message-seq]')
      return row ? { seq: Number(row.dataset.messageSeq) } : {}
    }

    function sourceRows(flow, identity) {
      if (!identity || identity.seq == null) return [flow]
      const rows = []
      const selector = identity.turn
        ? `[data-chat-node-key][data-chat-turn="${Number(identity.turn)}"], [data-message-seq="${Number(identity.seq)}"]`
        : '[data-chat-node-key], [data-message-seq]'
      for (const row of flow.querySelectorAll(selector)) {
        const points = [row, ...row.querySelectorAll('[data-slot="conversation.chat.node"], p, li, pre')]
        if (points.some(point => messageIdentity(point).seq === identity.seq)) rows.push(row)
      }
      return rows
    }

    function expandSourceTurn(flow, turn) {
      if (!turn || !flow) return
      for (const group of flow.querySelectorAll(`[data-chat-turn="${Number(turn)}"]`)) {
        const button = group.querySelector(':scope > div > button[aria-expanded="false"]')
        if (button) button.click()
      }
    }

    /**
     * `__reactFiber$...` is not a public API; a future DSH build could rename
     * or restructure it. Fail closed (null) rather than throw, so callers
     * fall through to their DOM-based fallback instead of the whole jump
     * silently dying mid-retry.
     */
    function reactFiberOf(element) {
      try {
        const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'))
        return key ? element[key] : null
      } catch {
        return null
      }
    }

    function turnRailProps() {
      const rail = findTurnRail()
      if (!rail) return null
      try {
        let fiber = reactFiberOf(rail)
        // Bounded walk: the component tree is only ever a few hundred fibers
        // deep in practice; the cap is pure insurance against a future
        // internals change turning this into a runaway loop.
        let depth = 0
        while (fiber && depth < 400) {
          const props = fiber.memoizedProps
          if (props && Array.isArray(props.items) && typeof props.onNavigate === 'function') {
            return props
          }
          fiber = fiber.return
          depth += 1
        }
      } catch {
        // Same reasoning as reactFiberOf above: degrade to the caller's next
        // fallback tier instead of throwing out of the retry loop.
      }
      return null
    }

    /**
     * The rail's marks are virtualized, so the target button may not exist even
     * after scrolling. Its React fiber still holds the complete `items` array
     * and the `onNavigate` callback; invoking that is exactly what a click does,
     * including "load this unloaded turn first".
     */
    function navigateTurnViaFiber(turn) {
      const props = turnRailProps()
      if (!props) return false
      const item = props.items.find((entry) => Number(entry.turn) === turn)
      if (!item) return false
      try {
        props.onNavigate(item)
        return true
      } catch {
        // A host-owned callback we don't control; if it throws, let the
        // caller's DOM-based fallback take over instead of propagating.
        return false
      }
    }

    /** When only a seq is known, pick the turn whose anchor starts at or before it. */
    function navigateTurnForSeq(seq) {
      const props = turnRailProps()
      if (!props) return false
      let candidate = null
      for (const item of props.items) {
        const anchorSeq = Number(item.anchor?.seq)
        if (Number.isFinite(anchorSeq) && anchorSeq <= seq) candidate = item
      }
      if (!candidate) return false
      try {
        props.onNavigate(candidate)
        return true
      } catch {
        return false
      }
    }

    /**
     * The chat's own turn rail already knows how to load an unloaded turn.
     * Clicking its mark for turn N makes the view page history and land there,
     * which is the only public path for jumping to an old, unmounted message.
     * The rail is virtualized, so first scroll it to the estimated index.
     */
    function clickTurnMark(turn) {
      // Prefer the rail's own navigation callback: it does not depend on the
      // target mark being mounted in the virtualized rail.
      if (navigateTurnViaFiber(turn)) return true
      const mountedTurn = document.querySelector(`[data-chat-turn="${turn}"]`)
      if (mountedTurn) {
        mountedTurn.scrollIntoView({ block: 'center', behavior: 'smooth' })
        return false
      }
      const rail = findTurnRail()
      if (!rail) return false
      const buttons = Array.from(rail.querySelectorAll('button'))
      const turnOf = (button) => {
        const label = button.getAttribute('aria-label') || ''
        const match = label.match(/(\d+)/)
        return match ? Number(match[1]) : null
      }
      const byLabel = buttons.find((button) => {
        const label = button.getAttribute('aria-label') || ''
        return label.includes(`第 ${turn} 轮`) || turnOf(button) === turn
      })
      if (byLabel) {
        byLabel.click()
        return true
      }

      const scroller = Array.from(rail.querySelectorAll('div')).find((element) => {
        const style = getComputedStyle(element)
        return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight
      }) || rail
      if (!scroller) return false

      // The rail is virtualized. Walk it relative to the marks currently in the
      // DOM instead of assuming data-index === turn - 1.
      const rendered = buttons
        .map((button) => turnOf(button))
        .filter((value) => value !== null)
      let nextTop = scroller.scrollTop
      if (rendered.length === 0) {
        nextTop = Math.max(0, (turn - 1) * 10 - scroller.clientHeight / 2)
      } else {
        const min = Math.min(...rendered)
        const max = Math.max(...rendered)
        const step = Math.max(scroller.clientHeight * 0.8, 40)
        if (turn > max) nextTop += Math.min(step, (turn - max) * 10 + 40)
        else if (turn < min) nextTop -= Math.min(step, (min - turn) * 10 + 40)
        else nextTop = Math.max(0, (turn - 1) * 10 - scroller.clientHeight / 2)
      }
      scroller.scrollTop = Math.max(0, nextTop)
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
      return false
    }

    /* -------------------------------------------------------------- theme --- */

    const THEME_KEY = 'dsh-provenance:theme:v1'
    const FONT_KEY = 'dsh-provenance:font:v1'
    const THINKING_EFFECTS_KEY = 'dsh-provenance:thinking-effects:v1'

    /** Accent-only palettes: surfaces stay on host tokens so light/dark still work. */
    const THEMES = [
      { id: 'ocean', name: '海蓝 Ocean', accent: '#4f8cff', soft: 'rgba(79,140,255,0.16)', contrast: '#ffffff' },
      { id: 'teal', name: '青碧 Teal', accent: '#2fc4b2', soft: 'rgba(47,196,178,0.16)', contrast: '#04211d' },
      { id: 'violet', name: '紫罗兰 Violet', accent: '#a78bfa', soft: 'rgba(167,139,250,0.18)', contrast: '#ffffff' },
      { id: 'amber', name: '琥珀 Amber', accent: '#f2b544', soft: 'rgba(242,181,68,0.18)', contrast: '#231a05' },
      { id: 'rose', name: '玫瑰 Rose', accent: '#f472b6', soft: 'rgba(244,114,182,0.18)', contrast: '#2a0a1a' },
      { id: 'slate', name: '石墨 Graphite', accent: '#94a3b8', soft: 'rgba(148,163,184,0.18)', contrast: '#0b1220' },
    ]

    function loadThemeId() {
      try {
        const id = localStorage.getItem(THEME_KEY)
        if (THEMES.some((item) => item.id === id)) return id
      } catch {
        // Fall through to the default.
      }
      return 'ocean'
    }

    const themeStore = {
      id: loadThemeId(),
      listeners: new Set(),
      set(id) {
        if (this.id === id || !THEMES.some((item) => item.id === id)) return
        this.id = id
        try {
          localStorage.setItem(THEME_KEY, id)
        } catch {
          // The choice still applies to this page.
        }
        for (const listener of this.listeners) listener()
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }

    function useTheme() {
      const [id, setId] = React.useState(themeStore.id)
      React.useEffect(() => themeStore.subscribe(() => setId(themeStore.id)), [])
      return THEMES.find((item) => item.id === id) || THEMES[0]
    }

    function themeVars(theme) {
      return {
        '--dsp-accent': theme.accent,
        '--dsp-accent-soft': theme.soft,
        '--dsp-accent-contrast': theme.contrast,
      }
    }

    function ThemeDots() {
      const theme = useTheme()
      return h('div', { className: 'dsp-themes' },
        ...THEMES.map((item) =>
          h('button', {
            key: item.id,
            type: 'button',
            className: 'dsp-dot' + (item.id === theme.id ? ' on' : ''),
            title: item.name,
            'aria-label': item.name,
            style: { background: item.accent },
            onClick: () => themeStore.set(item.id),
          })),
      )
    }

    /* ---------------------------------------------------------- appearance --- */

    const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]

    function loadFontSize() {
      try {
        const value = Number(localStorage.getItem(FONT_KEY))
        if (FONT_SIZES.includes(value)) return value
      } catch {
        // Fall through to the default.
      }
      return 13
    }

    const fontStore = {
      value: loadFontSize(),
      listeners: new Set(),
      set(value) {
        const next = Math.min(20, Math.max(10, Math.round(Number(value) || 13)))
        if (this.value === next) return
        this.value = next
        try {
          localStorage.setItem(FONT_KEY, String(next))
        } catch {
          // The choice still applies to this page.
        }
        for (const listener of this.listeners) listener()
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }

    function useFontSize() {
      const [value, setValue] = React.useState(fontStore.value)
      React.useEffect(() => fontStore.subscribe(() => setValue(fontStore.value)), [])
      return value
    }

    function fontVars(size) {
      return { '--dsp-fs': `${size}px` }
    }

    function loadThinkingEffects() {
      try { return localStorage.getItem(THINKING_EFFECTS_KEY) !== 'false' }
      catch { return true }
    }

    const thinkingEffectsStore = {
      enabled: loadThinkingEffects(),
      listeners: new Set(),
      set(enabled) {
        const next = Boolean(enabled)
        if (next === this.enabled) return
        this.enabled = next
        try { localStorage.setItem(THINKING_EFFECTS_KEY, String(next)) } catch {}
        for (const listener of this.listeners) listener()
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }

    function useThinkingEffects() {
      return React.useSyncExternalStore(
        listener => thinkingEffectsStore.subscribe(listener),
        () => thinkingEffectsStore.enabled,
      )
    }

    const TAB_ORDER_KEY = 'dsh-provenance:panel-tab-order:v1'
    const DEFAULT_TAB_ORDER = ['trace', 'decisions', 'assumptions', 'notes']

    function normalizeTabOrder(value) {
      const known = Array.isArray(value) ? value.filter(id => DEFAULT_TAB_ORDER.includes(id)) : []
      return [...new Set([...known, ...DEFAULT_TAB_ORDER])]
    }

    function loadTabOrder() {
      try { return normalizeTabOrder(JSON.parse(localStorage.getItem(TAB_ORDER_KEY) || 'null')) }
      catch { return [...DEFAULT_TAB_ORDER] }
    }

    const tabOrderStore = {
      value: loadTabOrder(),
      listeners: new Set(),
      set(value) {
        const next = normalizeTabOrder(value)
        if (next.every((id, index) => id === this.value[index])) return
        this.value = next
        try { localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(next)) } catch {}
        for (const listener of this.listeners) listener()
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }

    function useTabOrder() {
      const [order, setOrder] = React.useState(tabOrderStore.value)
      React.useEffect(() => tabOrderStore.subscribe(() => setOrder(tabOrderStore.value)), [])
      return order
    }

    /** Pointer capture also works in native hosts that intercept HTML drag-and-drop. */
    function ReorderableTabs({ items, active, onSelect, en }) {
      const order = useTabOrder()
      const [dragging, setDragging] = React.useState(null)
      const [insertion, setInsertion] = React.useState(null)
      const [dragPosition, setDragPosition] = React.useState(null)
      const [announcement, setAnnouncement] = React.useState('')
      const gesture = React.useRef(null)
      const stripRef = React.useRef(null)
      const suppressClickUntil = React.useRef(0)
      const t = (zh, english) => en ? english : zh

      const announce = (id, next) => {
        const label = items.find(item => item.id === id)?.label || id
        const position = next.indexOf(id) + 1
        setAnnouncement(t(`已将「${label}」移到第 ${position} 位，共 ${next.length} 项`, `${label} moved to position ${position} of ${next.length}`))
      }
      const finishDrag = () => {
        const current = gesture.current
        gesture.current = null
        if (current?.moving) suppressClickUntil.current = Date.now() + 200
        try {
          if (current?.button.hasPointerCapture(current.pointerId)) current.button.releasePointerCapture(current.pointerId)
        } catch {}
        setDragging(null)
        setInsertion(null)
        setDragPosition(null)
      }
      React.useEffect(() => {
        const onKey = event => {
          if (event.key !== 'Escape' || !gesture.current) return
          event.preventDefault()
          event.stopPropagation()
          finishDrag()
        }
        const onBlur = () => { if (gesture.current) finishDrag() }
        window.addEventListener('keydown', onKey, true)
        window.addEventListener('blur', onBlur)
        return () => {
          window.removeEventListener('keydown', onKey, true)
          window.removeEventListener('blur', onBlur)
          const current = gesture.current
          gesture.current = null
          try {
            if (current?.button.hasPointerCapture(current.pointerId)) current.button.releasePointerCapture(current.pointerId)
          } catch {}
        }
      }, [])
      const dropTarget = event => {
        // Rectangles also handle wrapped rows and the gaps between buttons.
        const strip = stripRef.current
        if (!strip) return null
        const bounds = strip.getBoundingClientRect()
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return null
        const buttons = [...strip.querySelectorAll('[data-dsp-tab]')]
        let closest = null, distance = Infinity
        for (const button of buttons) {
          const rect = button.getBoundingClientRect()
          const dx = Math.max(rect.left - event.clientX, 0, event.clientX - rect.right)
          const dy = Math.max(rect.top - event.clientY, 0, event.clientY - rect.bottom)
          const squared = dx * dx + dy * dy
          if (squared >= distance) continue
          distance = squared
          closest = {
            id: button.dataset.dspTab,
            after: event.clientY > rect.bottom || (event.clientY >= rect.top && event.clientX >= rect.left + rect.width / 2),
          }
        }
        return closest
      }

      return h('div', {
        ref: stripRef,
        className: 'dsp-tabs' + (dragging ? ' sorting' : ''),
        role: 'group',
        'aria-label': t('标签页，可拖动调整顺序', 'Pages, drag to reorder'),
      },
        ...order.map(id => {
          const item = items.find(item => item.id === id)
          if (!item) return null
          return h('button', {
            key: id,
            type: 'button',
            className: 'dsp-tab' + (active === id ? ' active' : '') + (dragging === id ? ' dragging' : '')
              + (insertion?.id === id ? (insertion.after ? ' drop-after' : ' drop-before') : ''),
            'data-dsp-tab': id,
            'aria-pressed': active === id,
            'aria-keyshortcuts': 'Alt+ArrowLeft Alt+ArrowRight',
            title: t('拖动调整顺序；Option/Alt + ← / → 也可移动', 'Drag to reorder; Option/Alt + Left / Right also moves this page'),
            draggable: false,
            onDragStart: event => event.preventDefault(),
            onPointerDown: event => {
              if (event.button !== 0 || event.isPrimary === false || gesture.current) return
              gesture.current = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, button: event.currentTarget, moving: false }
              try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
            },
            onPointerMove: event => {
              const current = gesture.current
              if (!current || current.pointerId !== event.pointerId) return
              if (!current.moving && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6) return
              current.moving = true
              suppressClickUntil.current = Infinity
              event.preventDefault()
              setDragging(current.id)
              const target = dropTarget(event)
              setInsertion(target?.id === current.id ? null : target)
              const bounds = stripRef.current.getBoundingClientRect()
              setDragPosition({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
            },
            onPointerUp: event => {
              const current = gesture.current
              if (!current || current.pointerId !== event.pointerId) return
              if (current.moving) {
                event.preventDefault()
                event.stopPropagation()
                const target = dropTarget(event)
                if (target && target.id !== current.id) {
                  const next = order.filter(value => value !== current.id)
                  next.splice(next.indexOf(target.id) + (target.after ? 1 : 0), 0, current.id)
                  tabOrderStore.set(next)
                  announce(current.id, next)
                }
              }
              finishDrag()
            },
            onPointerCancel: finishDrag,
            onLostPointerCapture: () => { if (gesture.current) finishDrag() },
            onClick: event => {
              if (Date.now() < suppressClickUntil.current) {
                event.preventDefault()
                event.stopPropagation()
                return
              }
              // Stable keys preserve focus and pointer capture during reordering.
              if (active === id && typeof event.currentTarget.animate === 'function'
                && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                event.currentTarget.animate([{ transform: 'scale(1)', offset: 0 }, { transform: 'scale(.94)', offset: .35 }, { transform: 'scale(1.02)', offset: .7 }, { transform: 'scale(1)', offset: 1 }], { duration: 180, easing: 'cubic-bezier(.2,.8,.3,1.1)' })
              }
              onSelect(id)
            },
            onKeyDown: event => {
              if (!event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
              event.preventDefault()
              event.stopPropagation()
              const from = order.indexOf(id)
              const to = Math.min(order.length - 1, Math.max(0, from + (event.key === 'ArrowLeft' ? -1 : 1)))
              if (to === from) return
              const next = [...order]
              next.splice(to, 0, ...next.splice(from, 1))
              tabOrderStore.set(next)
              announce(id, next)
            },
          },
            h('svg', { className: 'dsp-tab-grip', viewBox: '0 0 6 10', 'aria-hidden': 'true', focusable: 'false' },
              ...[1.5, 5, 8.5].flatMap(cy => [1.5, 4.5].map(cx => h('circle', { key: `${cx}-${cy}`, cx, cy, r: .7, fill: 'currentColor' }))),
            ),
            item.label,
          )
        }),
        dragging && dragPosition ? h('span', {
          className: 'dsp-tab-ghost', 'aria-hidden': 'true',
          style: { left: dragPosition.x, top: dragPosition.y },
        }, items.find(item => item.id === dragging)?.label) : null,
        h('span', { className: 'dsp-sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, announcement),
      )
    }

    /** Gear button: accent, size and tab order live in one small popover. */
    function SettingsMenu() {
      const fontSize = useFontSize()
      const tabOrder = useTabOrder()
      const thinkingEffects = useThinkingEffects()
      const [open, setOpen] = React.useState(false)
      const wrapRef = React.useRef(null)

      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      return h('div', { className: 'dsp-settings-wrap', ref: wrapRef },
        h('button', {
          className: 'dsp-x dsp-gear',
          type: 'button',
          onClick: () => setOpen((value) => !value),
          title: '设置 / Settings',
          'aria-label': '设置 / Settings',
          'aria-expanded': open ? 'true' : 'false',
        },
          h('svg', {
            viewBox: '0 0 24 24', width: 15, height: 15,
            fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
          },
            h('path', { d: 'M4 7h10M18 7h2M4 12h4M12 12h8M4 17h12M20 17h0' }),
            h('circle', { cx: 16, cy: 7, r: 2, fill: 'currentColor', stroke: 'none' }),
            h('circle', { cx: 10, cy: 12, r: 2, fill: 'currentColor', stroke: 'none' }),
            h('circle', { cx: 18, cy: 17, r: 2, fill: 'currentColor', stroke: 'none' }),
          ),
        ),
        open
          ? h('div', { className: 'dsp-settings', role: 'dialog', 'aria-label': '插件设置 / Settings' },
              h('div', { className: 'dsp-settings-title' }, '设置 / Settings'),
              h('div', { className: 'dsp-settings-label' }, '主色 / Accent'),
              h(ThemeDots),
              h('div', { className: 'dsp-settings-label' }, `字号 / Size · ${fontSize}px`),
              h('input', {
                className: 'dsp-slider', type: 'range', min: 10, max: 20, step: 1,
                value: fontSize, 'aria-label': '字号',
                onChange: (event) => fontStore.set(Number(event.target.value)),
              }),
              h('label', { className: 'dsp-settings-check' },
                h('input', { type: 'checkbox', checked: thinkingEffects,
                  onChange: event => thinkingEffectsStore.set(event.target.checked) }),
                h('span', null, '分析气泡与波浪 / Analysis effects'),
              ),
              h('div', { className: 'dsp-settings-label' }, '标签顺序 / Tab order'),
              h('button', {
                className: 'dsp-btn', type: 'button',
                disabled: tabOrder.every((id, index) => id === DEFAULT_TAB_ORDER[index]),
                onClick: () => tabOrderStore.set(DEFAULT_TAB_ORDER),
                title: '恢复溯源、结论、假设、摘录的默认顺序 / Restore default tab order',
              }, '恢复默认 / Reset'),
              h('div', { className: 'dsp-settings-label' }, '回收站 / Recycle bin'),
              h('div', { className: 'dsp-retention-policy' },
                h('span', null, `上限 ${TRASH_MAX_ITEMS} 条 / Max ${TRASH_MAX_ITEMS} items`),
                h('span', null, `超过 ${TRASH_RETENTION_DAYS} 天清理 / Expire after ${TRASH_RETENTION_DAYS} days`),
                h('small', null, '所有会话共用；超限先清理最早移入的内容。 / Shared across chats; oldest deleted first.'),
              ),
            )
          : null,
      )
    }

    function TraceTools({ en, filter, onFilter, timeline, onJump, assumptions, assumptionsSaved, onSaveAssumptions }) {
      const t = (zh, english) => en ? english : zh
      const [open, setOpen] = React.useState(null)
      const [pinned, setPinned] = React.useState(null)
      const panelId = React.useId()
      const filters = [['all', '全部', 'All'], ['user', '你的原话', 'Yours'], ['assistant', '结论', 'Conclusions'], ['tool', '外部', 'External']]
      const activeFilter = filters.find(([value]) => value === filter) || filters[0]
      const tools = [
        { id: 'filter', label: `${t('筛选', 'Filter')} · ${t(activeFilter[1], activeFilter[2])}`, title: t('筛选依据来源', 'Filter evidence sources') },
        { id: 'chain', label: `${t('思路链', 'Trace chain')} · ${timeline.length}`, title: t('查看思路链', 'View trace chain'), disabled: timeline.length < 2 },
        { id: 'assumptions', label: `${t('依赖假设', 'Assumptions')} · ${assumptions.length}`, title: t('这条结论依赖的假设', 'Assumptions behind this conclusion'), disabled: !assumptions.length },
      ]
      const expanded = tools.find(tool => tool.id === open && !tool.disabled)
      return h('div', { className: 'dsp-analysis-tools',
        onMouseLeave: () => setOpen(pinned),
        onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(pinned) },
        onKeyDown: event => {
          if (event.key !== 'Escape') return
          event.preventDefault(); event.stopPropagation(); setOpen(null); setPinned(null)
        },
      },
        h('div', { className: 'dsp-analysis-tabs', role: 'group', 'aria-label': t('溯源工具', 'Trace tools') },
          ...tools.map(tool => h('button', { key: tool.id, type: 'button',
            className: 'dsp-chip dsp-analysis-toggle', 'data-dsp-tool': tool.id, disabled: tool.disabled,
            'aria-expanded': open === tool.id, 'aria-controls': panelId, title: tool.title,
            onMouseEnter: () => { if (!tool.disabled) setOpen(tool.id) },
            onFocus: () => setOpen(tool.id),
            onClick: () => {
              const next = pinned === tool.id ? null : tool.id
              setPinned(next); setOpen(next)
            },
            onKeyDown: event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const buttons = [...event.currentTarget.parentElement.querySelectorAll('button:not(:disabled)')]
              const index = buttons.indexOf(event.currentTarget)
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
              buttons[next]?.focus()
            },
          }, h('span', { className: 'dsp-analysis-label' }, tool.label),
            h('span', { className: 'dsp-analysis-caret', 'aria-hidden': true }, open === tool.id ? '▴' : '▾'))),
        ),
        expanded ? h('div', { className: 'dsp-analysis-content', id: panelId, role: 'region', 'aria-label': expanded.title },
          open === 'filter' ? h('div', { className: 'dsp-filters' }, ...filters.map(([value, zh, english]) =>
            h('button', { key: value, type: 'button', className: 'dsp-chip' + (filter === value ? ' active' : ''),
              'aria-pressed': filter === value, onClick: () => onFilter(value) }, t(zh, english))))
          : open === 'chain' ? h('div', { className: 'dsp-timeline' }, ...timeline.map(node =>
            h('button', { key: node.seq, type: 'button', className: 'dsp-node' + (node.role === 'claim' ? ' claim' : ''),
              title: node.quote, onClick: () => onJump(node) },
              h('span', { className: 'dsp-node-role' }, (node.role === 'claim' ? t('本结论', 'This claim') : roleLabel(node.role, t)) + (node.turn ? ` · ${node.turn}` : '')),
              h('span', { className: 'dsp-node-quote' }, String(node.quote || '').slice(0, 40)))))
          : h('div', { className: 'dsp-tool-assumptions' },
              ...assumptions.map((text, index) => h('div', { key: index, className: 'dsp-asm' }, `· ${text}`)),
              h('button', { className: 'dsp-btn', type: 'button', style: { alignSelf: 'flex-start' },
                disabled: assumptionsSaved, onClick: onSaveAssumptions }, assumptionsSaved ? t('假设已存入台账', 'Assumptions saved') : t('只存假设', 'Save assumptions only'))),
        ) : null,
      )
    }

    const DANGER_STYLES = `
      .dsp-card, .dpl-root, .dsp-pill {
        --dsp-danger-text: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d84f62) 60%, var(--dsw-alias-label-primary, #1a2b46));
        --dsp-danger-bg: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d84f62) 16%, transparent);
        --dsp-danger-border: color-mix(in srgb, var(--dsp-danger-text) 58%, var(--dsw-alias-border-l2, #d4dfed));
        --dsp-danger-ring: color-mix(in srgb, var(--dsp-danger-text) 12%, transparent);
      }
      :is(.dsp-card, .dpl-root, .dsp-pill) :is(.dsp-btn.danger, .dpl-btn.danger, .dsp-close, .dsp-pill-x) {
        transition: color 160ms ease, border-color 160ms ease, background-color 160ms ease, box-shadow 160ms ease;
      }
      :is(.dsp-card, .dpl-root, .dsp-pill) :is(.dsp-btn.danger, .dpl-btn.danger, .dsp-close, .dsp-pill-x):not(:disabled):is(:hover, :focus-visible) {
        background: var(--dsp-danger-bg); color: var(--dsp-danger-text);
        border-color: var(--dsp-danger-border); box-shadow: 0 0 0 1px var(--dsp-danger-ring);
      }
      :is(.dsp-card, .dpl-root, .dsp-pill) :is(.dsp-btn.danger, .dpl-btn.danger, .dsp-close, .dsp-pill-x):focus-visible {
        outline: 2px solid var(--dsp-danger-text); outline-offset: 3px;
      }
      @media (prefers-reduced-motion: reduce) {
        :is(.dsp-card, .dpl-root, .dsp-pill) :is(.dsp-btn.danger, .dpl-btn.danger, .dsp-close, .dsp-pill-x) { transition: none; }
      }
    `

    const RECYCLE_STYLES = `
      .dpr-list { display: flex; flex-direction: column; gap: 10px; max-width: 860px; }
      .dpr-hint { color: var(--dsw-alias-label-secondary); font-size: calc(var(--dsp-fs, 13px) * .92); font-weight: 400; }
      .dpr-kind { display: inline-block; align-self: flex-start; width: fit-content; border: 1px solid var(--dsw-alias-border-l2); border-radius: 5px; padding: 0 6px; margin-bottom: 6px; color: var(--dsp-accent, var(--dsw-alias-brand-primary)); font-size: calc(var(--dsp-fs, 13px) * .85); }
      .dsp-trash-toggle[aria-pressed="true"] { color: var(--dsp-accent, var(--dsw-alias-brand-primary)); background: var(--dsp-accent-soft); }
      .dpl-notice { margin-bottom: 12px; color: var(--dsp-accent, var(--dsw-alias-brand-primary)); }
    `

    const RELATED_STYLES = `
      .dsp-scope { display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto; margin-right: 4px; padding: 3px 7px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; cursor: pointer; }
      .dsp-scope:not(:disabled):is(:hover,:focus-visible), .dsp-scope[aria-pressed="true"] { border-color: var(--dsp-hover-border); color: var(--dsp-accent, #4f8cff); background: var(--dsp-accent-soft); }
      .dsp-scope:disabled { cursor: default; opacity: .65; }
      .dsp-related-dot { width: 6px; height: 6px; flex: 0 0 6px; border-radius: 50%; background: var(--dsw-alias-label-secondary); opacity: .5; }
      .dsp-related-dot.found { background: #36b882; opacity: 1; box-shadow: 0 0 5px #36b88255; }
      .dsp-related-dot.searching { background: var(--dsp-accent, #4f8cff); animation: dsp-related-pulse 1.2s ease-in-out infinite; }
      @keyframes dsp-related-pulse { 50% { opacity: 1; } }
      .dsp-related-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: calc(var(--dsp-fs,13px) * .85); color: var(--dsw-alias-label-secondary); }
      .dsp-related-title { color: var(--dsp-accent, #4f8cff); font-weight: 600; overflow-wrap: anywhere; }
      .dsp-related-relation { font-size: calc(var(--dsp-fs,13px) * .85); color: var(--dsp-accent, #4f8cff); }
      .dsp-related-explanation { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 6px; font-size: calc(var(--dsp-fs,13px) * .92); overflow-wrap: anywhere; }
      .dsp-related-explanation.contradicts { color: var(--dsw-alias-state-warn-primary); }
      .dsp-related-tools { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
      @media(prefers-reduced-motion:reduce) { .dsp-related-dot.searching { animation: none; } }
    `

    const READING_STYLES = `
      .dsp-quote-wrap, .dsp-record-preview, .dpl-asm-text { min-width: 0; }
      .dsp-record-text { line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
      .dsp-record-text.clamped { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
      .dsp-record-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
      .dsp-record-row > :first-child:not(.dsp-record-toggle) { flex: 1; min-width: 0; overflow-wrap: anywhere; }
      .dsp-record-row > .dsp-record-toggle { flex-shrink: 0; margin-top: 0; }
      .dsp-record-preview > .dpl-claim { margin-bottom: 0; }
      .dsp-ev-quote { line-height: 1.65; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
      .dsp-ev-quote.clamped { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
      .dsp-ev-quote.expanded { white-space: pre-wrap; }
      .dsp-quote-toggle { display: block; margin-top: 5px; padding: 1px 0; margin-left: auto; text-align: right; border: 0; background: transparent; color: var(--dsp-accent, #4f8cff); font: inherit; font-size: .85em; cursor: pointer; border-radius: 3px; }
      .dsp-quote-toggle:is(:hover,:focus-visible) { text-decoration: underline; text-underline-offset: 3px; }
      .dsp-ev .dsp-ev-head { margin-bottom: 7px; gap: 8px; }
      .dsp-ev .dsp-ev-why { border-top: 1px solid var(--dsw-alias-border-l1); margin-top: 9px; padding-top: 7px; line-height: 1.55; font-size: .88em; }
      .dsp-why-label { display: block; font-size: .9em; font-weight: 600; margin-bottom: 3px; }
      .dsp-reading-notice { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .dsp-reading-notice .dsp-btn { font-size: inherit; flex-shrink: 0; }
      .dsp-source-actions, .dsp-reading-return { position: fixed; z-index: 74; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 5px 20px #0003; font-size: var(--dsp-fs,13px); border-radius: 10px; }
      .dsp-source-actions { display: flex; flex-wrap: wrap; gap: 3px; padding: 4px; max-width: calc(100vw - 16px); animation: dsp-source-in 150ms ease-out; }
      .dsp-source-actions button { white-space: nowrap; font: inherit; border: 0; border-radius: 6px; padding: 6px 8px; background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; transition: color 150ms, background 150ms; }
      .dsp-source-actions .dsp-source-followup { color: var(--dsp-accent, #4f8cff); }
      .dsp-source-actions button:is(:hover,:focus-visible), .dsp-reading-return:is(:hover,:focus-visible) { background: var(--dsp-accent-soft); color: var(--dsp-accent, #4f8cff); outline: 1px solid var(--dsp-accent, #4f8cff); }
      .dsp-insert-error { flex-basis: 100%; max-width: 290px; padding: 4px 8px; font-size: .9em; color: var(--dsw-alias-label-secondary); }
      .dsp-reading-return { right: 20px; bottom: 144px; padding: 8px 12px; cursor: pointer; font-family: inherit; }
      .dsp-source-actions button:disabled, .dsp-reading-return:disabled { opacity: .55; cursor: default; }
      @keyframes dsp-source-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }
      @media(prefers-reduced-motion:reduce) { .dsp-source-actions { animation: none; } .dsp-source-actions button { transition: none; } }
    `

    const STYLES = `
      ::highlight(dsp-claim) { background-color: rgba(245, 197, 66, 0.42); color: inherit; }
      ::highlight(dsp-source) { background-color: rgba(74, 158, 255, 0.26); color: inherit; text-decoration: underline; text-decoration-thickness: 1px; }
      ::highlight(dsp-focus) { background-color: rgba(74, 158, 255, 0.55); color: inherit; }
      ::highlight(dsp-keyword) { background-color: #ffd84d; color: #1b1400; text-decoration: underline; text-decoration-color: #ff9f1a; text-decoration-thickness: 2px; }
      ::highlight(dsp-search) { background-color: rgba(255, 205, 72, .35); color: inherit; }
      ::highlight(dsp-search-current) { background-color: rgba(255, 195, 45, .65); color: inherit; text-decoration: underline; }
      .dsp-search-dock { position: relative; flex-shrink: 0; min-height: 50px; border-top: 1px solid var(--dsw-alias-border-l1); padding: 9px 16px; }
      .dsp-search-peek { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 8px; min-height: 31px; border: 0; padding: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; cursor: text; transition: opacity 180ms ease; }
      .dsp-search-peek small { display: flex; align-items: center; gap: 6px; opacity: .72; font-size: .85em; }
      .dsp-search-form { position: absolute; inset: 9px 16px; display: flex; gap: 7px; align-items: center; opacity: 0; transform: translateY(10px); pointer-events: none; transition: opacity 240ms ease-in-out, transform 260ms cubic-bezier(.4,0,.2,1); }
      .dsp-search-dock:is(:hover, :focus-within, .open) .dsp-search-form { opacity: 1; transform: translateY(0); pointer-events: auto; }
      .dsp-search-dock:is(:hover, :focus-within, .open) .dsp-search-peek { opacity: 0; pointer-events: none; }
      .dsp-search-input-wrap { display: flex; flex: 1; min-width: 0; align-items: center; gap: 7px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; padding: 4px 9px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-base); transition: border-color 160ms, box-shadow 160ms; }
      .dsp-search-input-wrap:focus-within { border-color: var(--dsp-accent, #4f8cff); box-shadow: 0 0 0 2px var(--dsp-hover-ring); }
      .dsp-search-input { flex: 1; width: 100%; min-width: 0; border: 0; padding: 0; outline: 0; font: inherit; font-size: .92em; line-height: 1.65; background: transparent; color: var(--dsw-alias-label-primary); }
      .dsp-search-input::-webkit-search-cancel-button { display: none; }
      .dsp-search-clear { border: 0; background: transparent; color: inherit; font: inherit; padding: 0 3px; cursor: pointer; }
      .dsp-search-count { font-size: .8em; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
      .dsp-search-result { display: flex; flex-direction: column; gap: 7px; padding: 10px 11px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-base); }
      .dsp-search-result.selected { border-color: var(--dsp-accent, #4f8cff); }
      .dsp-search-result:hover { border-color: var(--dsp-hover-border); }
      .dsp-search-hit { text-align: left; border: 0; background: transparent; padding: 0; color: inherit; font: inherit; cursor: pointer; overflow-wrap: anywhere; white-space: pre-wrap; }
      .dsp-search-hit:hover { color: var(--dsp-hover-text); }
      .dsp-search-hit small { display: block; color: var(--dsw-alias-label-secondary); font-size: .82em; margin-bottom: 4px; }
      .dsp-search-results { display: flex; flex-direction: column; gap: 9px; }
      .dsp-search-pager { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
      .dsp-search-mark { background: color-mix(in srgb, var(--dsp-accent, #4f8cff) 22%, transparent); color: inherit; border-radius: 2px; }
      @media (hover: none) { .dsp-search-dock .dsp-search-form { opacity: 1; transform: none; pointer-events: auto; } .dsp-search-peek { visibility: hidden; } }
      .dsp-trigger {
        position: relative; overflow: visible; isolation: isolate;
        display: inline-flex; align-items: center; justify-content: center; gap: 4px;
        height: 28px; min-width: 28px; padding: 0 9px;
        border: 1px solid rgba(96, 148, 226, 0.55); border-radius: 8px;
        background: rgba(34, 70, 133, 0.5); color: #cfe0ff;
        font-size: calc(var(--dsp-fs, 13px) * 0.92); cursor: pointer; line-height: 1;
        box-shadow: 0 0 0 0 rgba(79, 157, 255, 0), inset 0 0 0 rgba(79, 157, 255, 0);
        transition: background-color .9s ease, border-color .9s ease, color .9s ease, box-shadow .9s ease;
      }
      .dsp-trigger.active {
        background: rgba(42, 87, 162, 0.9); color: #ffffff;
        border-color: #80baff;
        box-shadow: 0 0 8px 1px rgba(74, 153, 255, .38), inset 0 0 6px rgba(91, 171, 255, .14);
        transition-duration: .72s;
      }
      .dsp-trigger:hover:not(.active) {
        background: rgba(40, 82, 153, .66);
        border-color: rgba(126, 174, 255, .72); color: #ffffff;
      }
      .dsp-trigger:focus-visible { outline: 2px solid #92c6ff; outline-offset: 4px; }
      .dsp-trigger-label { position: relative; z-index: 1; display: inline-flex; align-items: center; gap: 4px; }
      .dsp-trigger-fill {
        position: absolute; inset: 0; z-index: 0; border-radius: 7px;
        overflow: hidden; pointer-events: none; opacity: 0;
      }
      .dsp-trigger-fill::before, .dsp-trigger-fill::after {
        content: ''; position: absolute; top: 0; left: -100%; width: 200%; height: 100%;
        background-size: 50% 100%; background-repeat: repeat-x;
        transform: translateX(0); pointer-events: none;
      }
      .dsp-trigger-fill::before {
        background-image: linear-gradient(90deg, #183f85 0%, #326dbe 30%, #3d93b3 55%, #4b71c7 78%, #183f85 100%);
      }
      .dsp-trigger-fill::after {
        background-image:
          radial-gradient(circle at 14% 72%, rgba(219,242,255,.12) 0 1.3px, rgba(219,242,255,.46) 1.5px 2px, transparent 2.5px),
          radial-gradient(circle at 42% 28%, rgba(219,242,255,.4) 0 1px, transparent 1.6px),
          radial-gradient(circle at 70% 65%, rgba(219,242,255,.12) 0 1.7px, rgba(219,242,255,.4) 1.9px 2.4px, transparent 2.9px),
          radial-gradient(circle at 91% 38%, rgba(219,242,255,.36) 0 .8px, transparent 1.4px);
      }
      .dsp-trigger-fill.moving::before { animation: dsp-mode-drift 6.4s linear infinite; }
      .dsp-trigger-fill.moving::after { animation: dsp-mode-drift 8.8s linear infinite; }
      @keyframes dsp-mode-drift { from { transform: translateX(0); } to { transform: translateX(50%); } }
      .dsp-trigger-orbit, .dsp-frame-orbit {
        position: absolute; left: -1px; top: -1px;
        width: calc(100% + 2px); height: calc(100% + 2px);
        overflow: visible; pointer-events: none; opacity: 0; z-index: 2;
      }
      .dsp-trigger-orbit path, .dsp-frame-orbit path { fill: none; stroke-linecap: round; vector-effect: non-scaling-stroke; }
      .dsp-orbit-halo { stroke: #3f98ff; stroke-width: 4; opacity: .3; filter: blur(2px); }
      .dsp-orbit-tail { stroke: #69b2ff; stroke-width: 2; filter: drop-shadow(0 0 3px #4b9fff); }
      .dsp-orbit-head { stroke: #e1f3ff; stroke-width: 2.2; filter: drop-shadow(0 0 2px #83c3ff); }
      @media (prefers-reduced-motion: reduce) {
        .dsp-trigger-orbit, .dsp-frame-orbit { display: none; }
        .dsp-trigger-fill::before, .dsp-trigger-fill::after, .dsp-wave { animation: none !important; }
      }
      @keyframes dsp-panel-enter {
        from { opacity: 0; transform: translateY(14px) scale(.96); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes dsp-panel-exit {
        to { opacity: 0; transform: translate(18px, 26px) scale(.68); }
      }
      .dsp-card {
        --dsp-hover-text: color-mix(in srgb, var(--dsw-alias-label-primary) 84%, #fff);
        --dsp-hover-border: color-mix(in srgb, var(--dsp-accent, #4f8cff) 72%, var(--dsw-alias-label-primary));
        --dsp-hover-ring: color-mix(in srgb, var(--dsp-accent, #4f8cff) 12%, transparent);
        position: fixed; right: 20px; bottom: 96px; z-index: 70;
        width: min(420px, calc(100vw - 40px)); max-height: 85vh;
        display: flex; flex-direction: column;
        background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
        border: 1px solid color-mix(in srgb, var(--dsp-accent, #4f8cff) 25%, var(--dsw-alias-border-l2)); border-radius: 18px;
        box-shadow: 0 24px 72px rgba(5, 20, 48, .24), 0 4px 16px rgba(5, 20, 48, .09), inset 0 2px 0 var(--dsp-accent, #4f8cff);
        transform-origin: bottom right;
        animation: dsp-panel-enter 240ms cubic-bezier(.2,.8,.2,1) both;
        font-size: var(--dsp-fs, 13px); line-height: 1.55; overflow: hidden;
        min-height: 240px;
        pointer-events: auto;
      }
      .dsp-card.dsp-closing { animation: dsp-panel-exit 280ms cubic-bezier(.4,0,.8,1) both; pointer-events: none; }
      .dsp-card :is(button, [role="button"]):focus-visible { outline: 2px solid var(--dsp-accent, #4f8cff); outline-offset: 3px; }
      .dsp-card :is(.dsp-head, .dsp-body, .dsp-foot, .dsp-tabbar) { box-sizing: border-box; }
      .dsp-coverage { font-size: 11px; line-height: 1.6; padding: 9px 11px; border-radius: 10px; color: var(--dsw-alias-label-secondary); background: var(--dsp-accent-soft, #eef4ff); }
      .dsp-body > * { flex-shrink: 0; }
      .dsp-body { overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--dsw-alias-border-l2) transparent; }
      @media (prefers-reduced-motion: reduce) {
        .dsp-card, .dsp-card *, .dsp-hint, .dsp-hint::before, .dsp-hint::after, .dsp-frame, .dsp-trigger, .dsp-trigger::before, .dsp-trigger::after { animation: none !important; transition: none !important; }
      }
      .dsp-resize {
        position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
        cursor: nwse-resize; touch-action: none;
        background: transparent;
        border-right: 2px solid var(--dsw-alias-border-l2);
        border-bottom: 2px solid var(--dsw-alias-border-l2);
        border-bottom-right-radius: 13px;
      }
      .dsp-resize:hover { border-color: var(--dsp-accent, var(--dsw-alias-brand-primary)); }
      .dsp-timeline { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 0 6px; overflow: visible; }
      .dsp-node {
        flex: 0 0 auto; max-width: 156px; border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 9px; padding: 4px 7px; background: var(--dsw-alias-bg-base);
        cursor: pointer; text-align: left; color: inherit; font: inherit;
      }
      .dsp-node:is(:hover, :focus-visible) { border-color: var(--dsp-hover-border); background: var(--dsp-accent-soft, var(--dsw-alias-bg-layer-2)); color: var(--dsp-hover-text); box-shadow: 0 0 0 1px var(--dsp-hover-ring); }
      .dsp-node:is(:hover, :focus-visible) .dsp-node-role { color: var(--dsw-alias-label-primary); }
      .dsp-node.claim { border-color: var(--dsp-accent, var(--dsw-alias-brand-primary)); }
      .dsp-node-role { font-size: calc(var(--dsp-fs, 13px) * 0.77); color: var(--dsw-alias-label-secondary); display: block; }
      .dsp-node-quote { font-size: calc(var(--dsp-fs, 13px) * 0.85); display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsp-sep { align-self: center; color: var(--dsw-alias-label-secondary); font-size: calc(var(--dsp-fs, 13px) * 0.85); }
      .dsp-mark { background: rgba(245, 197, 66, 0.45); color: inherit; border-radius: 2px; }
      .dsp-flag {
        border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 32%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent);
        color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 60%, var(--dsw-alias-label-secondary));
        border-radius: 5px; cursor: pointer; font-size: calc(var(--dsp-fs, 13px) * 0.85);
        padding: 1px 6px; margin-left: auto; line-height: 1.5; white-space: nowrap; flex-shrink: 0;
      }
      .dsp-flag:is(:hover, :focus-visible), .dsp-flag.on {
        color: var(--dsw-alias-state-error-primary);
        border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 65%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 13%, transparent);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent);
      }
      .dsp-ev.flagged { opacity: 0.62; border-style: dashed; }
      .dsp-analysis-tools { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
      .dsp-analysis-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
      .dsp-analysis-tabs .dsp-analysis-toggle { display: flex; align-items: center; justify-content: center; gap: 3px; min-width: 0; max-width: 100%; padding: 4px 6px; white-space: nowrap; }
      .dsp-analysis-toggle:first-child { justify-content: flex-start; }
      .dsp-analysis-toggle:last-child { justify-content: flex-end; }
      .dsp-analysis-label { overflow: hidden; text-overflow: ellipsis; }
      .dsp-analysis-caret { flex-shrink: 0; font-size: .85em; }
      .dsp-analysis-toggle[aria-expanded="true"] { color: var(--dsp-accent, #4f8cff); border-color: var(--dsp-accent, #4f8cff); background: var(--dsp-accent-soft); }
      .dsp-analysis-toggle:disabled { opacity: .45; cursor: default; }
      .dsp-analysis-content { min-width: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 8px; }
      .dsp-tool-assumptions { display: flex; flex-direction: column; gap: 7px; }
      .dsp-asm { font-size: calc(var(--dsp-fs, 13px) * 0.92); color: var(--dsw-alias-label-primary); }
      .dsp-head { display: flex; align-items: center; gap: 8px; padding: 13px 15px; background: transparent; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .dsp-title { font-weight: 600; font-size: var(--dsp-fs, 13px); color: var(--dsp-accent, inherit); }
      .dsp-count { color: var(--dsw-alias-label-secondary); font-size: calc(var(--dsp-fs, 13px) * 0.92); }
      .dsp-head-spacer { flex: 1; }
      .dsp-head-actions { position: relative; display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }
      .dsp-themes { display: inline-flex; gap: 4px; align-items: center; justify-content: center; }
      .dsp-dot { width: 12px; height: 12px; border-radius: 50%; border: 1px solid transparent; padding: 0; cursor: pointer; opacity: .6; }
      .dsp-dot:hover { opacity: 1; }
      .dsp-dot.on { opacity: 1; box-shadow: 0 0 0 2px var(--dsw-alias-bg-layer-1), 0 0 0 3px var(--dsp-accent, #4f8cff); }
      .dsp-settings-wrap { display: inline-flex; }
      .dsp-gear { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; }
      .dsp-settings {
        position: absolute; top: calc(100% + 12px); right: 0; z-index: 90;
        width: 180px; max-height: min(70vh, 340px); padding: 8px;
        display: flex; flex-direction: column; gap: 6px;
        align-items: center; text-align: center;
        background: var(--dsw-alias-bg-base);
        border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
        box-shadow: 0 14px 36px rgba(0, 0, 0, 0.32);
        overflow: auto;
      }
      .dsp-settings-title { font-size: calc(var(--dsp-fs, 13px) * 0.92); font-weight: 600; }
      .dsp-settings-label { font-size: calc(var(--dsp-fs, 13px) * 0.85); color: var(--dsw-alias-label-secondary); }
      .dsp-settings-check { display: flex; align-items: center; gap: 7px; width: 100%; padding: 5px 2px; text-align: left; cursor: pointer; font-size: calc(var(--dsp-fs, 13px) * 0.85); }
      .dsp-settings-check input { appearance: auto; flex: 0 0 auto; width: 14px; height: 14px; margin: 0; accent-color: var(--dsp-accent, #4f8cff); cursor: pointer; }
      .dsp-retention-policy { width: 100%; display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 7px; text-align: left; font-size: calc(var(--dsp-fs, 13px) * .85); }
      .dsp-retention-policy small { color: var(--dsw-alias-label-secondary); line-height: 1.5; }
      .dsp-slider {
        width: 100%; height: 16px; cursor: pointer;
        accent-color: var(--dsp-accent, #4f8cff);
      }
      .dsp-x { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: calc(var(--dsp-fs, 13px) * 1.23); line-height: 1; padding: 0; border-radius: 6px; }
      .dsp-x svg { display: block; }
      .dsp-x:hover { background: var(--dsp-accent-soft, var(--dsw-alias-bg-layer-2)); color: var(--dsp-accent, var(--dsw-alias-label-primary)); }
      .dsp-body { padding: 12px 12px 18px; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; gap: 12px; flex: 1; min-height: 0; }
      .dsp-head, .dsp-foot { flex: 0 0 auto; }
      .dsp-claim { border-left: 3px solid var(--dsp-accent, var(--dsw-alias-brand-primary)); padding: 2px 0 2px 10px; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
      .dsp-claim-text { line-height: 1.65; white-space: pre-wrap; }
      .dsp-claim-text.clamped { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden; }
      .dsp-claim-preview .dsp-claim-toggle { margin-top: 5px; }
      .dsp-claim-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 6px; margin-top: -6px; }
      .dsp-tabbar { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; border-bottom: 1px solid var(--dsw-alias-border-l1); padding: 10px 12px 9px; }
      .dsp-tabs { position: relative; display: flex; flex-wrap: wrap; gap: 4px; flex: 1; min-width: 0; }
      .dsp-tabs.sorting .dsp-tab { cursor: grabbing; }
      .dsp-tab-ghost { position: absolute; z-index: 2; transform: translate(8px, -50%); pointer-events: none; white-space: nowrap; border: 1px solid var(--dsp-accent, #4f8cff); border-radius: 999px; padding: 3px 8px; color: var(--dsp-hover-text); background: var(--dsw-alias-bg-layer-1); box-shadow: 0 4px 12px rgba(0,0,0,.16); font-size: calc(var(--dsp-fs, 13px) * .92); }
      .dsp-tab-grip { position: absolute; left: 3px; top: 50%; width: 6px; height: 10px; transform: translateY(-50%); opacity: .38; pointer-events: none; }
      .dsp-tab:is(:hover, :focus-visible) .dsp-tab-grip { opacity: .8; }
      .dsp-tab.dragging { opacity: .5; background: var(--dsp-accent-soft, transparent); animation: none; }
      .dsp-tab:is(.drop-before, .drop-after)::after { content: ''; position: absolute; top: 3px; bottom: 3px; width: 2px; border-radius: 2px; background: var(--dsp-accent, #4f8cff); pointer-events: none; }
      .dsp-tab.drop-before::after { left: -3px; }
      .dsp-tab.drop-after::after { right: -3px; }
      .dsp-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; border: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
      .dsp-tab-export { border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 7px; padding: 2px 7px; font-size: calc(var(--dsp-fs, 13px) * 0.85); cursor: pointer; white-space: nowrap; }
      .dsp-tab-export:is(:hover, :focus-visible) { color: var(--dsp-hover-text); border-color: var(--dsp-hover-border); background: var(--dsp-accent-soft, var(--dsw-alias-bg-layer-2)); box-shadow: 0 0 0 1px var(--dsp-hover-ring); }
      .dsp-toast { padding: 6px 12px; font-size: calc(var(--dsp-fs, 13px) * 0.92); color: var(--dsp-accent, var(--dsw-alias-brand-primary)); background: var(--dsp-accent-soft, transparent); border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .dsp-tab { position: relative; flex-shrink: 0; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-size: calc(var(--dsp-fs, 13px) * 0.92); padding: 3px 7px 3px 13px; border-radius: 999px; cursor: grab; white-space: nowrap; user-select: none; -webkit-user-select: none; touch-action: none; -webkit-user-drag: none; }
      .dsp-tab:is(:hover, :focus-visible) { color: var(--dsp-hover-text); background: var(--dsp-accent-soft, transparent); }
      .dsp-tab.active { color: var(--dsp-accent, var(--dsw-alias-brand-primary)); background: var(--dsp-accent-soft, transparent); animation: dsp-tab-pop .18s cubic-bezier(.2, .8, .3, 1.1); }
      @keyframes dsp-tab-pop {
        0% { transform: scale(1); }
        35% { transform: scale(.94); }
        70% { transform: scale(1.02); }
        100% { transform: scale(1); }
      }
      .dsp-note-item { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
      .dsp-note-text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: calc(var(--dsp-fs, 13px) * 0.92); color: var(--dsw-alias-label-primary); }
      .dsp-note-meta { color: var(--dsw-alias-label-secondary); font-size: calc(var(--dsp-fs, 13px) * 0.85); }
      .dsp-note-actions { display: flex; gap: 6px; }
      .dsp-note { color: var(--dsw-alias-label-secondary); font-size: calc(var(--dsp-fs, 13px) * 0.92); overflow-wrap: anywhere; }
      .dsp-atom { display: flex; flex-direction: column; gap: 8px; border-left: 2px solid var(--dsw-alias-border-l1); padding-left: 9px; }
      .dsp-atom.direct { border-left-color: var(--dsw-alias-state-success-primary); }
      .dsp-atom.inference { border-left-color: var(--dsp-accent, var(--dsw-alias-brand-primary)); }
      .dsp-atom.merge { border-left-color: var(--dsw-alias-label-secondary); }
      .dsp-atom.assumption { border-left-color: var(--dsw-alias-state-warn-primary); }
      .dsp-atom.unsupported { border-left-color: var(--dsw-alias-state-error-primary); }
      .dsp-atom-text { font-weight: 600; overflow-wrap: anywhere; }
      .dsp-rel { display: inline-block; font-size: calc(var(--dsp-fs, 13px) * 0.85); padding: 1px 6px; border-radius: 999px; margin-right: 6px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); vertical-align: 1px; }
      .dsp-rel.direct { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .dsp-rel.inference { color: var(--dsp-accent, var(--dsw-alias-brand-primary)); border-color: var(--dsp-accent, var(--dsw-alias-brand-primary)); }
      .dsp-rel.unsupported { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .dsp-ev { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); border-radius: 12px; padding: 10px 12px; cursor: pointer; text-align: left; color: inherit; font: inherit; transition: border-color 150ms, background-color 150ms, box-shadow 150ms; }
      .dsp-ev[role="button"]:is(:hover, :focus-visible) {
        border-color: var(--dsp-hover-border);
        background: color-mix(in srgb, var(--dsp-accent, #4f8cff) 6%, var(--dsw-alias-bg-base));
        box-shadow: 0 0 0 1px var(--dsp-hover-ring);
      }
      .dsp-ev[role="button"]:is(:hover, :focus-visible) .dsp-ev-quote { color: var(--dsp-hover-text); }
      .dsp-ev[role="button"]:is(:hover, :focus-visible) :is(.dsp-ev-head, .dsp-ev-why) { color: color-mix(in srgb, var(--dsw-alias-label-secondary) 65%, var(--dsw-alias-label-primary)); }
      .dsp-ev-head { display: flex; gap: 6px; align-items: baseline; color: var(--dsw-alias-label-secondary); font-size: calc(var(--dsp-fs, 13px) * 0.85); margin-bottom: 4px; }
      .dsp-ev-role { font-weight: 600; }
      .dsp-ev-quote { color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
      .dsp-ev-why { color: var(--dsw-alias-label-secondary); font-size: calc(var(--dsp-fs, 13px) * 0.92); margin-top: 4px; }
      .dsp-unsupported { color: var(--dsw-alias-state-warn-primary); font-size: calc(var(--dsp-fs, 13px) * 0.92); }
      .dsp-filters { display: flex; gap: 6px; flex-wrap: wrap; }
      .dsp-chip { border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 999px; padding: 2px 8px; font-size: calc(var(--dsp-fs, 13px) * 0.85); cursor: pointer; }
      .dsp-chip:is(:hover, :focus-visible) { border-color: var(--dsp-hover-border); color: var(--dsp-hover-text); background: var(--dsp-accent-soft, transparent); box-shadow: 0 0 0 1px var(--dsp-hover-ring); }
      .dsp-chip.active { color: var(--dsp-accent, var(--dsw-alias-brand-primary)); border-color: var(--dsp-accent, var(--dsw-alias-brand-primary)); background: var(--dsp-accent-soft, transparent); }
      .dsp-foot { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; padding: 10px 14px; border-top: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font-size: calc(var(--dsp-fs, 13px) * 0.85); }
      .dsp-foot-result { flex-direction: column; align-items: stretch; gap: 8px; padding: 8px 12px; }
      .dsp-foot-top { display: flex; align-items: center; gap: 8px; width: 100%; }
      .dsp-foot-aux { display: flex; flex-wrap: wrap; gap: 4px; }
      .dsp-foot-aux:empty { display: none; }
      .dsp-foot-divider { display: none; flex: 0 0 1px; height: 18px; background: var(--dsw-alias-border-l2); }
      .dsp-foot-aux:not(:empty) + .dsp-foot-divider { display: block; }
      .dsp-foot-top .dsp-search-dock { flex: 1; min-width: 0; min-height: 32px; padding: 0; border-top: 0; font-size: var(--dsp-fs, 13px); }
      .dsp-foot-top .dsp-search-form { inset: 0; }
      .dsp-foot-top .dsp-search-peek { min-height: 32px; }
      .dsp-foot-grid { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr); gap: 6px; width: 100%; }
      .dsp-foot-cell { width: 100%; min-width: 0; height: 30px; display: inline-flex; align-items: center; justify-content: center; padding: 0 8px; font-size: 12px; line-height: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .dsp-foot-aux .dsp-btn { font-size: 11px; padding: 2px 6px; }
      .dsp-foot > span:first-child { flex-basis: 100%; overflow-wrap: anywhere; }
      .dsp-btn { border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 3px 8px; font-size: calc(var(--dsp-fs, 13px) * 0.92); cursor: pointer; }
      .dsp-btn:not(:disabled):is(:hover, :focus-visible) { background: var(--dsp-accent-soft, var(--dsw-alias-bg-layer-2)); border-color: var(--dsp-hover-border); color: var(--dsp-hover-text); box-shadow: 0 0 0 1px var(--dsp-hover-ring); }
      .dsp-btn.primary { background: var(--dsp-accent, var(--dsw-alias-brand-primary)); border-color: transparent; color: var(--dsp-accent-contrast, #fff); }
      .dsp-btn.primary:not(:disabled):is(:hover, :focus-visible) { background: var(--dsp-accent, var(--dsw-alias-brand-primary)); color: var(--dsp-accent-contrast, #fff); filter: brightness(1.08); }
      .dsp-btn.active { border-color: var(--dsp-accent, var(--dsw-alias-border-l2)); color: var(--dsp-accent, var(--dsw-alias-label-primary)); background: var(--dsp-accent-soft, transparent); }
      .dsp-btn.active:not(:disabled):is(:hover, :focus-visible), .dsp-chip.active:is(:hover, :focus-visible), .dsp-tab.active:is(:hover, :focus-visible) { color: var(--dsp-hover-border); }
      .dsp-btn:disabled { opacity: .55; cursor: default; }
      .dsp-card :is(.dsp-btn, .dsp-tab-export, .dsp-tab, .dsp-chip, .dsp-node, .dsp-flag),
      .dsp-ev :is(.dsp-ev-head, .dsp-ev-quote, .dsp-ev-why) {
        transition: color 160ms ease, border-color 160ms ease, background-color 160ms ease, box-shadow 160ms ease, filter 160ms ease;
      }
      .dsp-ev-site { color: var(--dsp-accent, var(--dsw-alias-brand-primary)); text-decoration: none; margin-left: auto; }
      .dsp-ev-site:hover { text-decoration: underline; }
      .dsp-original { border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: calc(var(--dsp-fs, 13px) * 0.92); background: var(--dsw-alias-bg-base); }
      .dsp-extra { border-top: 1px dashed var(--dsw-alias-border-l2); padding-top: 10px; display: flex; flex-direction: column; gap: 8px; }
      .dsp-extra-title { font-size: calc(var(--dsp-fs, 13px) * 0.92); font-weight: 600; color: var(--dsw-alias-label-secondary); }
      .dsp-hint {
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%) translateY(-6px); z-index: 71;
        width: max-content; max-width: calc(100vw - 24px); box-sizing: border-box;
        background: linear-gradient(180deg, rgba(38, 78, 150, 0.97), rgba(23, 49, 99, 0.97));
        color: #e8f0ff;
        border: 1px solid rgba(126, 174, 255, 0.78); border-radius: 999px;
        padding: 7px 14px; font-size: calc(var(--dsp-fs, 13px) * 0.92);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32), 0 0 0 1px rgba(126, 174, 255, 0.16);
        pointer-events: none;
        overflow: hidden; isolation: isolate;
        opacity: 0; transition: opacity 1s cubic-bezier(.4,0,.2,1), transform 1s cubic-bezier(.4,0,.2,1);
      }
      .dsp-hint.visible { opacity: 1; transform: translateX(-50%) translateY(0); animation: dsp-fade-in .25s ease; }
      .dsp-hint::before {
        content: ''; position: absolute; inset: -45% 0; z-index: -1; pointer-events: none;
        background-image:
          radial-gradient(circle at 12% 80%, rgba(160, 205, 255, 0.4) 0 5px, transparent 6px),
          radial-gradient(circle at 38% 55%, rgba(160, 205, 255, 0.3) 0 3px, transparent 4px),
          radial-gradient(circle at 64% 85%, rgba(160, 205, 255, 0.36) 0 4px, transparent 5px),
          radial-gradient(circle at 88% 45%, rgba(160, 205, 255, 0.26) 0 2px, transparent 3px);
        background-size: 150px 90px;
        animation: dsp-hint-rise 4.2s linear infinite;
      }
      .dsp-hint::after {
        content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none;
        background: linear-gradient(180deg, transparent 0%, rgba(130, 180, 255, 0.22) 50%, transparent 100%);
        background-size: 100% 220%;
        animation: dsp-hint-sheen 2.8s ease-in-out infinite;
      }
      @keyframes dsp-hint-rise {
        from { transform: translateY(32%); }
        to { transform: translateY(-32%); }
      }
      @keyframes dsp-hint-sheen {
        0%, 100% { background-position: 0 -120%; }
        50% { background-position: 0 120%; }
      }
      @keyframes dsp-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      .dsp-hint b { color: #b9d4ff; font-weight: 600; }
      .dsp-hint-btn {
        pointer-events: auto; margin-left: 8px;
        border: 1px solid rgba(170, 200, 255, 0.5); background: transparent;
        color: #e8f0ff; border-radius: 999px;
        padding: 2px 8px; font-size: calc(var(--dsp-fs, 13px) * 0.85); cursor: pointer; line-height: 1.4;
      }
      .dsp-hint-btn:hover { background: rgba(126, 174, 255, 0.18); border-color: #a8c8ff; }
      .dsp-frame {
        position: fixed; z-index: 69; pointer-events: none;
        box-sizing: border-box; border: 1px solid transparent; border-radius: 16px;
      }
      .dsp-frame.visible {
        border-color: rgba(103,155,231,.36);
        animation: dsp-frame-settle 1.2s cubic-bezier(.2,.7,.3,1) both;
      }
      .dsp-frame.leaving { animation: dsp-frame-leave .9s ease-out both; }
      @keyframes dsp-frame-settle {
        0% { border-color: rgba(110,168,255,.62); box-shadow: 0 0 5px rgba(79,140,255,.08); }
        40% { border-color: rgba(107,161,242,.44); box-shadow: 0 0 5px rgba(79,140,255,.02); }
        100% { border-color: rgba(103,155,231,.36); box-shadow: 0 0 5px rgba(79,140,255,.025); }
      }
      @keyframes dsp-frame-leave {
        0% { border-color: rgba(103,155,231,.36); box-shadow: 0 0 5px rgba(79,140,255,.025); }
        8% { border-color: rgba(110,168,255,.56); box-shadow: 0 0 5px rgba(79,140,255,.08); }
        53% { border-color: rgba(110,168,255,.38); box-shadow: 0 0 5px rgba(79,140,255,.02); }
        100% { border-color: transparent; box-shadow: 0 0 5px rgba(79,140,255,0); }
      }
      /* The native host paints this negative layer above its base, below all content. */
      .dsp-atmosphere-host { isolation: isolate; }
      .dsp-atmosphere-static-host { position: relative; }
      .dsp-frame-atmosphere {
        position: absolute; inset: 0; z-index: -1; overflow: hidden; border-radius: 14px;
        pointer-events: none; opacity: 0;
        background: linear-gradient(0deg, rgba(35,113,241,.10) 0%, rgba(48,129,237,.035) 26%, transparent 64%);
      }
      .dsp-wave {
        position: absolute; left: -100%; bottom: 0; width: 200%; height: min(46%, 300px);
        /* The SVG's centerline sits on the UI bottom; only crests rise into view. */
        translate: 0 50%;
        overflow: visible; pointer-events: none; transform: translateX(0); filter: blur(2px);
      }
      .dsp-wave-back { color: rgba(91,168,255,.05); }
      .dsp-wave-front { color: rgba(48,133,241,.065); }
      .moving .dsp-wave-back { animation: dsp-mode-drift 14s linear infinite; }
      .moving .dsp-wave-front { animation: dsp-mode-drift 19s linear infinite; }
      .dsp-pill {
        position: fixed; right: 20px; bottom: 96px; z-index: 70;
        display: flex; align-items: center; gap: 2px;
        background: var(--dsw-alias-bg-layer-1);
        border: 1px solid #6ea8ff; border-radius: 999px;
        padding: 3px 4px 3px 10px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
      }
      .dsp-pill-main { border: 0; background: transparent; color: #9cc4ff; font-size: calc(var(--dsp-fs, 13px) * 0.92); cursor: pointer; padding: 3px 4px; }
      .dsp-pill-main:hover { color: #dbeaff; }
      .dsp-pill-x { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: calc(var(--dsp-fs, 13px) * 1.08); line-height: 1; padding: 2px 6px; border-radius: 999px; }
      .dsp-pill-x:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .dsp-card .dsp-spin { display: block; flex: 0 0 16px; width: 16px; height: 16px; min-width: 16px; min-height: 16px; box-sizing: border-box; border: 0; overflow: visible; animation: dsp-spin .9s linear infinite; }
      .dsp-spin-track { stroke: var(--dsw-alias-border-l2); }
      .dsp-spin-arc { stroke: var(--dsp-accent, #4f8cff); }
      @keyframes dsp-spin { to { transform: rotate(360deg); } }
      /* An isolated negative layer keeps the activity behind every control and text. */
      .dsp-card { isolation: isolate; }
      .dsp-thinking { position: absolute; inset: 50% 0 0; z-index: -1; overflow: hidden; pointer-events: none; opacity: 0; background: linear-gradient(0deg, rgba(75,151,255,.1), rgba(75,151,255,.025) 60%, transparent); mask-image: linear-gradient(to top, #000 60%, transparent 100%); }
      .dsp-thinking-wave { position: absolute; left: -100%; bottom: -12%; width: 200%; height: 54%; color: rgba(81,157,255,.11); transform: translateX(0); }
      .dsp-thinking-wave.back { bottom: -5%; height: 63%; color: rgba(112,185,255,.075); }
      .dsp-thinking.moving .dsp-thinking-wave { animation: dsp-thinking-drift 17s linear infinite; }
      .dsp-thinking.moving .dsp-thinking-wave.back { animation-duration: 23s; }
      .dsp-thinking-bubble { position: absolute; left: var(--bubble-x); bottom: 0; height: 100%; width: var(--bubble-size); opacity: 0; }
      .dsp-thinking-bubble::after { content: ''; position: absolute; bottom: 0; left: 0; width: var(--bubble-size); height: var(--bubble-size); box-sizing: border-box; border: 1px solid rgba(131,198,255,.34); border-radius: 50%; background: radial-gradient(circle at 30% 25%, rgba(187,225,255,.25), rgba(80,158,255,.12) 65%); }
      .dsp-thinking.moving .dsp-thinking-bubble { animation: dsp-thinking-rise var(--bubble-duration) linear infinite; animation-delay: var(--bubble-delay); }
      @keyframes dsp-thinking-drift { to { transform: translateX(50%); } }
      @keyframes dsp-thinking-rise { 0% { opacity: 0; transform: translate3d(0,12px,0); } 16% { opacity: .85; } 65% { opacity: .7; } 100% { opacity: 0; transform: translate3d(var(--bubble-drift),-100%,0); } }
      @media (prefers-reduced-motion: reduce) { .dsp-thinking { display: none; } }
      @media (prefers-reduced-motion: reduce) {
        .dsp-frame, .dsp-hint, .dsp-hint::before, .dsp-hint::after, .dsp-trigger::before, .dsp-trigger::after { animation: none; }
      }
      ${RELATED_STYLES}
      ${READING_STYLES}
      ${RECYCLE_STYLES}
      ${DANGER_STYLES}
    `

    const LEDGER_STYLES = `
      .dpl-root { height: 100%; overflow: auto; padding: 20px 24px 56px; color: var(--dsw-alias-label-primary); font-size: var(--dsp-fs, 13px); line-height: 1.55; }
      .dpl-head { position: relative; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
      .dpl-title { font-size: calc(var(--dsp-fs, 13px) * 1.7); line-height: 1.25; font-weight: 650; color: var(--dsp-accent, inherit); }
      .dpl-sub { color: var(--dsw-alias-label-secondary); font-size: calc(var(--dsp-fs, 13px) * 0.92); }
      .dpl-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; overflow: hidden; }
      .dpl-seg button { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); padding: 4px 10px; font-size: calc(var(--dsp-fs, 13px) * 0.92); cursor: pointer; }
      .dpl-seg button.on { background: var(--dsp-accent-soft, var(--dsw-alias-bg-layer-2)); color: var(--dsp-accent, var(--dsw-alias-label-primary)); }
      .dpl-search { flex: 1; min-width: 160px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: inherit; border-radius: 8px; padding: 6px 10px; font-size: calc(var(--dsp-fs, 13px) * 0.92); outline: none; }
      .dpl-search:focus { border-color: var(--dsp-accent, var(--dsw-alias-brand-primary)); }
      .dpl-stats { display: flex; gap: 18px; margin-bottom: 16px; color: var(--dsw-alias-label-secondary); font-size: calc(var(--dsp-fs, 13px) * 0.92); flex-wrap: wrap; }
      .dpl-stats b { color: var(--dsp-accent, var(--dsw-alias-label-primary)); font-size: calc(var(--dsp-fs, 13px) * 1.15); margin-right: 4px; }
      .dpl-section { display: flex; flex-direction: column; gap: 10px; max-width: 860px; }
      .dpl-tabs { display: flex; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; }
      .dpl-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 12px; padding: 12px 14px; }
      .dpl-card:hover { border-color: var(--dsp-accent-soft, var(--dsw-alias-border-l2)); }
      .dpl-card.revoked { opacity: .55; }
      .dpl-claim { font-weight: 600; margin-bottom: 6px; }
      .dpl-note { white-space: pre-wrap; font-weight: 500; overflow-wrap: anywhere; }
      .dpl-meta { color: var(--dsw-alias-label-secondary); font-size: calc(var(--dsp-fs, 13px) * 0.85); display: flex; gap: 8px; flex-wrap: wrap; }
      .dpl-asms { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
      .dpl-asm { border: 1px dashed var(--dsw-alias-border-l2); border-radius: 999px; padding: 1px 8px; font-size: calc(var(--dsp-fs, 13px) * 0.85); color: var(--dsw-alias-state-warn-primary); }
      .dpl-actions { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
      .dpl-btn { border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 3px 8px; font-size: calc(var(--dsp-fs, 13px) * 0.92); cursor: pointer; }
      .dpl-btn:hover { background: var(--dsp-accent-soft, var(--dsw-alias-bg-layer-2)); border-color: var(--dsp-accent, var(--dsw-alias-border-l2)); }
      .dpl-btn.active { border-color: var(--dsp-accent, var(--dsw-alias-brand-primary)); color: var(--dsp-accent, var(--dsw-alias-brand-primary)); }
      .dpl-btn.danger { color: var(--dsw-alias-state-error-primary); }
      .dpl-ev { border-top: 1px solid var(--dsw-alias-border-l1); margin-top: 10px; padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
      .dpl-ev-row { font-size: calc(var(--dsp-fs, 13px) * 0.92); }
      .dpl-ev-role { color: var(--dsw-alias-label-secondary); font-size: calc(var(--dsp-fs, 13px) * 0.85); margin-right: 6px; }
      .dpl-ev-atom { font-weight: 600; margin-top: 4px; }
      .dpl-empty { border: 1px dashed var(--dsw-alias-border-l2); border-radius: 12px; padding: 30px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: var(--dsp-fs, 13px); max-width: 860px; }
      .dpl-empty b { color: var(--dsp-accent, var(--dsw-alias-label-primary)); }
      .dpl-asm-row { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 10px; padding: 10px 12px; }
      .dpl-asm-text { flex: 1; }
      .dpl-asm-src { color: var(--dsw-alias-label-secondary); font-size: calc(var(--dsp-fs, 13px) * 0.85); margin-top: 4px; }
      ${READING_STYLES}
      ${RECYCLE_STYLES}
      ${DANGER_STYLES}
    `

    function supportsHighlight() {
      return typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined'
    }

    function clearHighlights() {
      if (!supportsHighlight()) return
      for (const name of [CLAIM_HIGHLIGHT, SOURCE_HIGHLIGHT, FOCUS_HIGHLIGHT, KEYWORD_HIGHLIGHT, SEARCH_HIGHLIGHT, SEARCH_CURRENT_HIGHLIGHT]) {
        CSS.highlights.delete(name)
      }
    }

    function findFlow() {
      const direct = document.querySelector('[data-slot="conversation.chat.flow"]')
      if (direct) return direct
      const session = document.querySelector('[data-slot="conversation.session"]')
      if (session) return session
      // Fallback for a DOM that no longer exposes the slot attributes: the
      // largest scrollable, text-bearing container outside our own panel.
      let best = null
      let bestLength = 0
      for (const element of document.querySelectorAll('div')) {
        if (element.closest('.dsp-card, .dsp-pill, .dsp-hint, .dsp-source-actions, .dsp-reading-return')) continue
        if (!element.scrollHeight || element.scrollHeight <= element.clientHeight) continue
        const style = window.getComputedStyle(element)
        if (!/(auto|scroll)/.test(style.overflowY)) continue
        const length = (element.textContent || '').length
        if (length > bestLength) {
          best = element
          bestLength = length
        }
      }
      return best || document.querySelector('main')
    }

    function findEvidenceFlow() {
      const sessionRoot = sessionStore.id && document.querySelector(`[data-conversation-session="${CSS.escape(sessionStore.id)}"]`)
      const direct = (sessionRoot || document).querySelector('[data-slot="conversation.chat.flow"]')
      if (direct) return direct
      const session = document.querySelector('[data-slot="conversation.session"]')
      if (session) return session
      // Fallback for a DOM that no longer exposes the slot attributes: the
      // largest scrollable, text-bearing container outside our own panel.
      let best = null
      let bestLength = 0
      for (const element of document.querySelectorAll('div')) {
        if (element.closest('.dsp-card, .dsp-pill, .dsp-hint, .dsp-source-actions, .dsp-reading-return')) continue
        if (!element.scrollHeight || element.scrollHeight <= element.clientHeight) continue
        const style = window.getComputedStyle(element)
        if (!/(auto|scroll)/.test(style.overflowY)) continue
        const length = (element.textContent || '').length
        if (length > bestLength) {
          best = element
          bestLength = length
        }
      }
      return best || document.querySelector('main')
    }

    /** Scroll the chat to the top so a paged history can mount older rows. */
    function scrollChatToTop() {
      let node = findFlow()
      while (node && node !== document.body) {
        const style = window.getComputedStyle(node)
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
          node.scrollTop = 0
          return true
        }
        node = node.parentElement
      }
      return false
    }

    /**
     * Elements whose start reads as a line break, the way native selection
     * serialization (`Selection.toString()`) treats them. Without this, two
     * adjacent block elements with no literal whitespace text node between
     * them (e.g. `<p>foo</p><p>bar</p>`, or separate list items) collapse to
     * "foobar" in the index while a quote captured across them normalizes to
     * "foo bar" -- so a selection spanning more than one paragraph/list item
     * never matches here, and the "jump to source" retry loop times out even
     * though the message is on screen. A single sentence inside one block
     * never crosses this path, which is why short selections work fine.
     */
    const INDEX_BREAK_TAGS = new Set([
      'P', 'DIV', 'SECTION', 'ARTICLE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'PRE', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'HR', 'BR',
    ])

    /** Build a whitespace-normalized text plus a char->DOM point map. */
    function buildIndex(root) {
      if (!root) return null
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode(node) {
          const tag = node.nodeType === 1 ? node.tagName : node.parentElement && node.parentElement.tagName
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA') return NodeFilter.FILTER_REJECT
          if (node.nodeType === 3 && (!node.nodeValue || !node.nodeValue.trim())) return NodeFilter.FILTER_REJECT
          return NodeFilter.FILTER_ACCEPT
        },
      })
      const points = []
      let text = ''
      let pendingBreak = false
      let node = walker.nextNode()
      while (node) {
        if (node.nodeType === 1) {
          if (INDEX_BREAK_TAGS.has(node.tagName)) pendingBreak = true
          node = walker.nextNode()
          continue
        }
        const value = node.nodeValue || ''
        for (let i = 0; i < value.length; i += 1) {
          const ch = value[i]
          if (ch === '\u200B' || ch === '\u200C' || ch === '\u200D' || ch === '\uFEFF') continue
          if (/\s/.test(ch)) {
            pendingBreak = false
            if (text.length === 0 || text[text.length - 1] === ' ') continue
            text += ' '
            points.push([node, i])
            continue
          }
          if (pendingBreak && text.length > 0 && text[text.length - 1] !== ' ') {
            text += ' '
            points.push([node, i])
          }
          pendingBreak = false
          text += ch
          points.push([node, i])
        }
        node = walker.nextNode()
      }
      return { text, points }
    }

    function rangeAt(index, start, end) {
      if (!index || start < 0 || end > index.points.length) return null
      const startPoint = index.points[start]
      const endPoint = index.points[end - 1]
      if (!startPoint || !endPoint) return null
      try {
        const range = document.createRange()
        range.setStart(startPoint[0], startPoint[1])
        range.setEnd(endPoint[0], endPoint[1] + 1)
        return range
      } catch {
        return null
      }
    }

    function findRange(root, needle) {
      const index = buildIndex(root)
      if (!index) return null
      const flat = String(needle || '').replace(/\s+/g, ' ').trim()
      if (!flat) return null
      const at = index.text.indexOf(flat)
      if (at < 0) return null
      return rangeAt(index, at, at + flat.length)
    }

    // A single sentence is a few dozen characters; a note-worthy excerpt can
    // run to several paragraphs. 600 was sized for the former and silently
    // dropped the latter (readSelection returned null, nothing happened, no
    // feedback) -- exactly the "selected a big chunk, nothing visibly broke,
    // but it never did anything" complaint. This is generous enough for a
    // multi-paragraph excerpt while still refusing an accidental "select all".
    const MAX_QUOTE_LENGTH = 6000

    /**
     * Capture the current selection, refusing picks outside the chat body.
     * Returns `{ ok: true, quote, raw, prefix, suffix }` on success, or
     * `{ ok: false, reason }` so the caller can tell the user *why* nothing
     * happened instead of failing silently.
     */
    function readSelection() {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return { ok: false, reason: 'empty' }
      }
      const quote = selection.toString().replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
      if (quote.length < 2) return { ok: false, reason: 'empty' }
      if (quote.length > MAX_QUOTE_LENGTH) return { ok: false, reason: 'too_long' }
      const range = selection.getRangeAt(0)
      const flow = findFlow()
      if (flow && !flow.contains(range.commonAncestorContainer)) return { ok: false, reason: 'outside' }
      return { ok: true, quote, raw: structuredSelection(range), ...surroundings(range), ...messageIdentity(range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer) }
    }

    const BLOCK_TAGS = new Set([
      'P', 'DIV', 'SECTION', 'ARTICLE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'PRE', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'HR',
    ])

    /**
     * Serialize the selected DOM back into readable Markdown-ish text instead
     * of flattening every newline. Ordered lists keep their 1./2./3. markers,
     * because a rendered <ol> hides them in CSS and selection.toString() drops
     * them entirely.
     */
    function structuredSelection(range) {
      try {
        const fragment = range.cloneContents()
        const container = document.createElement('div')
        container.appendChild(fragment)
        const children = Array.from(container.childNodes)
        const hasBlock = children.some(
          (node) => node.nodeType === 1 && BLOCK_TAGS.has(node.tagName),
        )
        if (!hasBlock) {
          return (serializeNode(container).trim() || range.toString().trim())
        }
        const blocks = children
          .map((node) => serializeNode(node).trim())
          .filter(Boolean)
        return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() || range.toString().trim()
      } catch {
        return range.toString()
      }
    }

    function serializeNode(node) {
      if (node.nodeType === 3) return node.nodeValue || ''
      if (node.nodeType !== 1) return ''
      const element = node
      const tag = element.tagName
      if (tag === 'BR') return '\n'
      if (tag === 'OL' || tag === 'UL') {
        const ordered = tag === 'OL'
        const start = Number(element.getAttribute('start')) || 1
        return Array.from(element.children)
          .filter((child) => child.tagName === 'LI')
          .map((child, index) => {
            const body = serializeNode(child).trim().replace(/\n/g, '\n   ')
            return `${ordered ? `${start + index}.` : '-'} ${body}`
          })
          .join('\n')
      }
      if (tag === 'LI') return serializeNode(element).trim()
      if (/^H[1-6]$/.test(tag)) {
        return `${'#'.repeat(Number(tag[1]))} ${textOf(element)}`
      }
      if (tag === 'PRE') {
        return `\`\`\`\n${(element.textContent || '').replace(/\n+$/, '')}\n\`\`\``
      }
      if (tag === 'BLOCKQUOTE') {
        return Array.from(element.childNodes)
          .map(serializeNode)
          .join('')
          .trim()
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')
      }
      if (tag === 'HR') return '---'
      if (tag === 'TABLE') {
        return Array.from(element.querySelectorAll('tr'))
          .map((row) => {
            const cells = Array.from(row.children).map((cell) => textOf(cell))
            return `| ${cells.join(' | ')} |`
          })
          .join('\n')
      }
      return Array.from(element.childNodes).map(serializeNode).join('')
    }

    function textOf(element) {
      return (element.textContent || '').replace(/\s+/g, ' ').trim()
    }

    function surroundings(range, size = 48) {
      let prefix = ''
      let suffix = ''
      const start = range.startContainer
      const end = range.endContainer
      if (start && start.nodeType === 3) {
        prefix = (start.nodeValue || '').slice(Math.max(0, range.startOffset - size), range.startOffset)
      }
      if (end && end.nodeType === 3) {
        suffix = (end.nodeValue || '').slice(range.endOffset, range.endOffset + size)
      }
      return {
        prefix: prefix.replace(/\s+/g, ' ').trim(),
        suffix: suffix.replace(/\s+/g, ' ').trim(),
      }
    }

    function paint(result, claimText) {
      if (!supportsHighlight()) return
      clearHighlights()
      const flow = findFlow()
      if (!flow) return
      // One DOM walk for every quote in the result: rebuilding the index per
      // evidence card would cost O(n) walks on a long conversation.
      const index = buildIndex(flow)
      if (!index) return
      const locate = (needle) => {
        const flat = String(needle || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
        if (!flat) return null
        const at = index.text.indexOf(flat)
        return at < 0 ? null : rangeAt(index, at, at + flat.length)
      }
      const claimRange = locate(claimText)
      if (claimRange) CSS.highlights.set(CLAIM_HIGHLIGHT, new Highlight(claimRange))
      const ranges = []
      for (const atom of result.atoms || []) {
        for (const evidence of atom.evidence || []) {
          const range = locate(evidence.quote)
          if (range) ranges.push(range)
        }
      }
      if (ranges.length > 0) CSS.highlights.set(SOURCE_HIGHLIGHT, new Highlight(...ranges))
      const keywords = []
      for (const atom of result.atoms || []) {
        for (const keyword of atom.keywords || []) {
          if (!keywords.includes(keyword)) keywords.push(keyword)
        }
      }
      paintKeywords(index, keywords)
    }

    function paintKeywords(index, keywords) {
      if (!index || !Array.isArray(keywords) || keywords.length === 0) return
      const ranges = []
      for (const keyword of keywords) {
        const needle = String(keyword).replace(/\s+/g, ' ').trim()
        if (needle.length < 2) continue
        let from = 0
        while (ranges.length < 40) {
          const at = index.text.indexOf(needle, from)
          if (at < 0) break
          const range = rangeAt(index, at, at + needle.length)
          if (range) ranges.push(range)
          from = at + needle.length
        }
      }
      if (ranges.length > 0) CSS.highlights.set(KEYWORD_HIGHLIGHT, new Highlight(...ranges))
    }

    // Reading positions and selected source passages stay in memory only.
    const readingStore = {
      value: { history: [], source: null, returning: false, travel: null },
      listeners: new Set(), generation: 0, staged: null, lastSelection: null,
      set(patch) {
        this.value = { ...this.value, ...patch }
        for (const listener of this.listeners) listener()
      },
      clear() {
        this.generation++
        this.staged = this.lastSelection = null
        this.set({ history: [], source: null, returning: false, travel: null })
      },
    }

    function useReading() {
      return React.useSyncExternalStore(listener => {
        readingStore.listeners.add(listener)
        return () => readingStore.listeners.delete(listener)
      }, () => readingStore.value)
    }

    function rangeElement(range) {
      return range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer
    }

    function selectedPassage() {
      const selection = window.getSelection()
      if (!selection?.rangeCount || selection.isCollapsed) return null
      const range = selection.getRangeAt(0)
      const flow = findEvidenceFlow()
      if (!flow?.contains(range.commonAncestorContainer)) return null
      return { range: range.cloneRange(), quote: selection.toString(), rangeText: range.toString(), sessionId: sessionStore.id,
        identity: messageIdentity(rangeElement(range)) }
    }

    function chatScrollers(flow) {
      const scrollers = []
      for (let node = flow; node && node !== document.body; node = node.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) {
          scrollers.push({ node, top: node.scrollTop, left: node.scrollLeft })
        }
      }
      return scrollers
    }

    function captureReading() {
      const flow = findEvidenceFlow()
      if (!flow || !sessionStore.id) return null
      const selection = selectedPassage() || (readingStore.lastSelection?.sessionId === sessionStore.id ? readingStore.lastSelection : null)
      const scrollers = chatScrollers(flow)
      const viewport = (scrollers[0]?.node || flow).getBoundingClientRect()
      const anchor = [...flow.querySelectorAll('[data-chat-node-key], [data-message-seq]')]
        .find(row => { const rect = row.getBoundingClientRect(); return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom })
      const anchorIdentity = anchor && messageIdentity(anchor.querySelector('p, li, pre') || anchor)
      return { sessionId: sessionStore.id, selection, scrollers, windowX: window.scrollX, windowY: window.scrollY,
        anchor: anchorIdentity?.seq != null ? { identity: anchorIdentity,
          offset: anchor.getBoundingClientRect().top - viewport.top } : null }
    }

    function beginReadingJump(sessionId, captured = false) {
      const generation = ++readingStore.generation
      if (!captured) {
        const staged = readingStore.staged
        const bookmark = staged && Date.now() - staged.at < 1500 ? staged.bookmark : captureReading()
        readingStore.staged = null
        if (bookmark) readingStore.set({ history: [...readingStore.value.history.slice(-9), bookmark] })
      }
      readingStore.set({ source: null, returning: false, travel: sessionId })
      return generation
    }

    function rememberSource(range) {
      const source = { range: range.cloneRange(), quote: window.getSelection()?.toString() || range.toString(), rangeText: range.toString(),
        sessionId: sessionStore.id, identity: messageIdentity(rangeElement(range)) }
      readingStore.lastSelection = source
      readingStore.set({ source, travel: null })
    }

    function restoredRange(passage, flow) {
      const live = passage?.range
      if (live?.startContainer.isConnected && live.endContainer.isConnected &&
          flow.contains(live.commonAncestorContainer) && live.toString() === (passage.rangeText ?? passage.quote)) return live.cloneRange()
      if (!passage?.quote) return null
      const flat = passage.quote.replace(/\s+/g, ' ').trim()
      for (const row of sourceRows(flow, passage.identity)) {
        const index = buildIndex(row)
        const at = index?.text.indexOf(flat) ?? -1
        // Refuse an ambiguous replacement after virtualization or editing.
        if (at >= 0 && index.text.indexOf(flat, at + 1) < 0) return rangeAt(index, at, at + flat.length)
      }
      return null
    }

    async function returnToReading(ctx) {
      const bookmark = readingStore.value.history.at(-1)
      if (!bookmark || readingStore.value.returning) return false
      const generation = ++readingStore.generation
      readingStore.set({ returning: true, travel: bookmark.sessionId, source: null })
      try {
        if (sessionStore.id !== bookmark.sessionId && !openSessionById(ctx, bookmark.sessionId)) return false
        const deadline = Date.now() + 25000
        let loaded = false
        while (Date.now() < deadline && generation === readingStore.generation) {
          if (sessionStore.id !== bookmark.sessionId) { await new Promise(resolve => setTimeout(resolve, 100)); continue }
          openChat(ctx, bookmark.sessionId)
          const flow = findEvidenceFlow()
          if (!flow) { await new Promise(resolve => setTimeout(resolve, 100)); continue }
          expandSourceTurn(flow, bookmark.selection?.identity?.turn || bookmark.anchor?.identity?.turn)
          const range = restoredRange(bookmark.selection, flow)
          const rows = bookmark.anchor ? sourceRows(flow, bookmark.anchor.identity) : []
          const anchor = rows.find(row => row !== flow)
          if (bookmark.selection && !range || bookmark.anchor && !anchor) {
            const seqs = [bookmark.selection?.identity?.seq, bookmark.anchor?.identity?.seq].filter(Number.isFinite)
            if (!loaded && seqs.length) {
              loaded = true
              // Only request missing history; loading an already visible row can move the viewport.
              const session = ctx.get('sessions')?.binding?.(bookmark.sessionId)?.session
              if (typeof session?.loadThrough === 'function') void Promise.resolve(session.loadThrough(Math.min(...seqs))).catch(() => {})
            }
            await new Promise(resolve => setTimeout(resolve, 100)); continue
          }
          if (generation !== readingStore.generation) return false
          if (range) {
            const selection = window.getSelection()
            selection.removeAllRanges(); selection.addRange(range)
            if (supportsHighlight()) CSS.highlights.set(FOCUS_HIGHLIGHT, new Highlight(range))
          } else window.getSelection()?.removeAllRanges()
          const current = chatScrollers(flow)
          // Preserve the visible row even when loading older messages changed its offset.
          for (let index = 0; index < current.length; index++) {
            const saved = bookmark.scrollers.find(item => item.node === current[index].node)
            const top = anchor && index === 0
              ? current[index].node.scrollTop + anchor.getBoundingClientRect().top - current[index].node.getBoundingClientRect().top - bookmark.anchor.offset
              : saved?.top ?? bookmark.scrollers[index]?.top ?? current[index].top
            current[index].node.scrollTo({ top, left: saved?.left ?? 0, behavior: 'instant' })
          }
          window.scrollTo({ top: bookmark.windowY, left: bookmark.windowX, behavior: 'instant' })
          readingStore.lastSelection = range ? { ...bookmark.selection, range } : null
          readingStore.set({ history: readingStore.value.history.slice(0, -1), source: range ? readingStore.lastSelection : null })
          return true
        }
        return false
      } finally {
        if (generation === readingStore.generation) readingStore.set({ returning: false, travel: null })
      }
    }

    function prepareSourceFollowup(ctx, source, en) {
      if (!source?.quote?.trim() || source.sessionId !== sessionStore.id) return false
      try {
        const binding = ctx.get('sessions')?.binding?.(source.sessionId)
        const input = ctx.get('conversation')?.input
        const shell = binding?.ctx && typeof input?.for === 'function' ? input.for(binding.ctx) : input?.shell?.(source.sessionId)
        const actions = shell?.actions
        const state = shell?.state?.getSnapshot?.()
        if (!actions?.captureInsertion || !actions?.insertText || ['adjudicating', 'submitting'].includes(state?.phase)) return false
        const caret = actions.captureInsertion()
        if (!Number.isFinite(caret?.end) || caret.draftRev == null) return false
        const text = `\n\n${en ? 'Please answer my follow-up based on this passage:' : '请基于以下原文回答我的追问：'}\n> ${source.quote.trim().replace(/\r\n?/g, '\n').replace(/\n/g, '\n> ')}\n\n${en ? 'My follow-up: ' : '我的追问：'}`
        // Collapse at the caret's end so even a selected draft is preserved.
        const inserted = actions.insertText(text, { ...caret, start: caret.end, end: caret.end })
        if (inserted !== true) return false
        shell.focus?.()
        return true
      } catch { return false }
    }

    function SourceActions({ ctx, en, theme, fontSize, onReturn, onNotice, showReturn }) {
      const reading = useReading()
      const [position, setPosition] = React.useState(null)
      const [insertError, setInsertError] = React.useState('')
      const toolbar = React.useRef(null)
      const inside = React.useRef(false)
      const hideTimer = React.useRef(null)
      React.useEffect(() => {
        setPosition(null)
        setInsertError('')
        const source = reading.source
        if (!source || source.sessionId !== sessionStore.id) return
        const hide = () => { clearTimeout(hideTimer.current); hideTimer.current = setTimeout(() => {
          if (!inside.current && !toolbar.current?.contains(document.activeElement)) setPosition(null)
        }, 220) }
        const move = event => {
          if (toolbar.current?.contains(event.target)) { clearTimeout(hideTimer.current); return }
          if (!source.range.startContainer.isConnected || source.sessionId !== sessionStore.id || window.getSelection()?.toString() !== source.quote) { setPosition(null); return }
          const rect = [...source.range.getClientRects()].find(rect => rect.width > 0 && rect.height > 0 &&
            event.clientX >= rect.left - 3 && event.clientX <= rect.right + 3 && event.clientY >= rect.top - 3 && event.clientY <= rect.bottom + 3)
          if (!rect) { hide(); return }
          const clip = chatScrollers(findEvidenceFlow())[0]?.node.getBoundingClientRect()
          if (clip && (event.clientY < clip.top || event.clientY > clip.bottom)) { hide(); return }
          clearTimeout(hideTimer.current)
          setPosition({ left: Math.max(8, Math.min(window.innerWidth - 300, rect.left)),
            top: rect.top > 50 ? rect.top - 43 : rect.bottom + 7 })
        }
        const moved = () => setPosition(null)
        const selectionChanged = () => {
          const selection = window.getSelection()
          if (selection?.toString() !== source.quote && !toolbar.current?.contains(document.activeElement)) setPosition(null)
        }
        document.addEventListener('pointermove', move, { passive: true })
        document.addEventListener('scroll', moved, true)
        document.addEventListener('selectionchange', selectionChanged)
        window.addEventListener('resize', moved)
        return () => {
          clearTimeout(hideTimer.current)
          document.removeEventListener('pointermove', move)
          document.removeEventListener('scroll', moved, true)
          document.removeEventListener('selectionchange', selectionChanged)
          window.removeEventListener('resize', moved)
          inside.current = false
        }
      }, [reading.source])
      const t = (zh, english) => en ? english : zh
      const styles = { ...themeVars(theme), ...fontVars(fontSize) }
      return h(React.Fragment, null,
        position ? h('div', { ref: toolbar, className: 'dsp-source-actions', role: 'toolbar',
          'aria-label': t('原文操作', 'Source actions'), style: { ...styles, ...position },
          onPointerDown: event => event.preventDefault(),
          onPointerEnter: () => { inside.current = true; clearTimeout(hideTimer.current) },
          onPointerLeave: () => { inside.current = false; hideTimer.current = setTimeout(() => setPosition(null), 220) },
          onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) setPosition(null) },
        },
          h('button', { type: 'button', className: 'dsp-source-followup',
            title: t('引用这段原文，并在输入框里继续提问', 'Quote this passage and continue asking in the composer'), onClick: () => {
            if (prepareSourceFollowup(ctx, reading.source, en)) {
              setPosition(null)
              onNotice(t('已准备原文追问，直接在输入框里写问题即可', 'Ready to follow up on this passage. Type your question in the composer.'))
            } else {
              const message = t('暂时无法插入，请检查输入框是否可编辑。原文仍保留选中。', 'Could not insert. Check that the composer is editable. The source remains selected.')
              setInsertError(message); onNotice(message)
            }
          } }, t('追问', 'Follow up')),
          reading.history.length ? h('button', { type: 'button', disabled: reading.returning, onClick: onReturn }, t('↶ 返回', '↶ Back')) : null,
          insertError ? h('span', { className: 'dsp-insert-error', role: 'status' }, insertError) : null,
        ) : null,
        showReturn && reading.history.length ? h('button', { type: 'button', className: 'dsp-reading-return', style: styles,
          disabled: reading.returning, onClick: onReturn }, reading.returning ? t('正在返回…', 'Returning…') : t('↶ 返回刚才的位置', '↶ Back to reading')) : null,
      )
    }

    function focusQuote(quote, keywords) {
      const flow = findFlow()
      if (!flow) return false
      const index = buildIndex(flow)
      if (!index) return false
      const flat = String(quote || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
      if (!flat) return false
      const at = index.text.indexOf(flat)
      if (at < 0) return false
      const range = rangeAt(index, at, at + flat.length)
      if (!range) return false
      // Select the passage natively: the jump should read as "this is the text",
      // not as a highlight that silently disappears.
      try {
        const selection = window.getSelection()
        if (selection) {
          selection.removeAllRanges()
          selection.addRange(range)
        }
      } catch {
        // A refused selection still leaves the CSS highlight below.
      }
      const host =
        range.startContainer.nodeType === 3
          ? range.startContainer.parentElement
          : range.startContainer
      if (host && typeof host.scrollIntoView === 'function') {
        host.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
      if (supportsHighlight()) {
        CSS.highlights.set(FOCUS_HIGHLIGHT, new Highlight(range))
        paintKeywords(index, keywords)
      }
      rememberSource(range)
      return true
    }

    function focusEvidenceQuote(quote, keywords, identity, options = {}) {
      const flow = findEvidenceFlow()
      if (!flow) return false
      const flat = String(quote || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
      if (!flat) return false
      let index, range
      for (const row of sourceRows(flow, identity)) {
        index = buildIndex(row)
        if (!index) continue
        let at = index.text.indexOf(flat)
        let length = flat.length
        // Evidence is stored as Markdown; the DOM renders its text, links and emphasis.
        if (at < 0) {
          const stripped = flat.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_~`#>|]/g, '').replace(/\s+/g, ' ').trim()
          at = index.text.indexOf(stripped)
          length = stripped.length
        }
        if (at >= 0 && length) range = rangeAt(index, at, at + length)
        if (range && range.getClientRects().length) break
        range = null
      }
      if (!range) return false
      // Select the passage natively: the jump should read as "this is the text",
      // not as a highlight that silently disappears.
      try {
        const selection = window.getSelection()
        if (selection && !options.search) {
          selection.removeAllRanges()
          selection.addRange(range)
        }
      } catch {
        // A refused selection still leaves the CSS highlight below.
      }
      const host =
        range.startContainer.nodeType === 3
          ? range.startContainer.parentElement
          : range.startContainer
      if (options.search && host) {
        // A Markdown parent can span many screens. Center the Range's first
        // line, rather than scrolling that whole parent to its beginning.
        let scroller = host
        let centered = false
        while (scroller && scroller !== document.body) {
          const style = window.getComputedStyle(scroller)
          if (/(auto|scroll)/.test(style.overflowY) && scroller.scrollHeight > scroller.clientHeight + 1) {
            const rect = [...range.getClientRects()].find(item => item.width > 0 && item.height > 0)
            const viewport = scroller.getBoundingClientRect()
            if (rect) scroller.scrollBy({ top: rect.top + rect.height / 2 - viewport.top - scroller.clientHeight / 2,
              behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
            centered = Boolean(rect)
            break
          }
          scroller = scroller.parentElement
        }
        if (!centered) host.scrollIntoView({ block: 'center' })
      } else if (host && typeof host.scrollIntoView === 'function') {
        host.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
      }
      if (supportsHighlight()) {
        CSS.highlights.set(options.search ? SEARCH_CURRENT_HIGHLIGHT : FOCUS_HIGHLIGHT, new Highlight(range))
        if (!options.search) paintKeywords(index, keywords)
      }
      if (!options.search) rememberSource(range)
      return true
    }

    /** Chromium text fragment: open a page scrolled to the quoted sentence. */
    function deepLink(url, quote) {
      try {
        const target = new URL(url, window.location.href)
        const fragment = String(quote || '').replace(/\s+/g, ' ').trim().slice(0, 120)
        if (fragment && !target.hash) target.hash = `:~:text=${encodeURIComponent(fragment)}`
        return target.toString()
      } catch {
        return url
      }
    }

    /**
     * macOS turns Option+T into a dead-key character in `event.key`, so a
     * key-based check silently never matches. `event.code` is the physical
     * key and is layout/modifier independent.
     */
    function isHotkey(event) {
      const code = event.code === 'KeyT' || String(event.key).toLowerCase() === 't'
      return (event.metaKey || event.ctrlKey) && event.altKey && code
    }

    function isEnglish(ctx) {
      try {
        const active = ctx.get('locale')?.getSnapshot?.()?.active
        return typeof active === 'string' && active.toLowerCase().startsWith('en')
      } catch {
        return false
      }
    }

    function loadSize() {
      try {
        const raw = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null')
        if (raw && Number.isFinite(raw.w) && Number.isFinite(raw.h)) {
          return {
            w: Math.min(760, Math.max(320, raw.w)),
            h: Math.max(0, Math.min(900, raw.h)),
          }
        }
      } catch {
        // Corrupt storage falls back to the default size.
      }
      return { w: 420, h: 0 }
    }

    function saveSize(size) {
      try {
        localStorage.setItem(SIZE_KEY, JSON.stringify(size))
      } catch {
        // Storage can be unavailable; the size still applies for this session.
      }
    }

    function loadFeedback() {
      try {
        const raw = JSON.parse(localStorage.getItem(FEEDBACK_KEY) || '[]')
        return new Set(Array.isArray(raw) ? raw.filter((item) => typeof item === 'string') : [])
      } catch {
        return new Set()
      }
    }

    function saveFeedback(set) {
      try {
        localStorage.setItem(FEEDBACK_KEY, JSON.stringify([...set]))
      } catch {
        // Ignore a denied write.
      }
    }

    function evidenceKey(item) {
      return `${item.seq}:${String(item.quote || '').slice(0, 80)}`
    }

    function loadFeedbackDetail() {
      try {
        const raw = JSON.parse(localStorage.getItem(FEEDBACK_DETAIL_KEY) || '[]')
        if (!Array.isArray(raw)) return []
        return raw.filter(
          (entry) =>
            entry &&
            typeof entry.sessionId === 'string' &&
            Number.isFinite(entry.seq) &&
            typeof entry.quote === 'string',
        )
      } catch {
        return []
      }
    }

    function saveFeedbackDetail(list) {
      try {
        localStorage.setItem(FEEDBACK_DETAIL_KEY, JSON.stringify(list.slice(0, FEEDBACK_DETAIL_MAX)))
      } catch {
        // Ignore a denied write; the flat FEEDBACK_KEY set still dims the card.
      }
    }

    /** Add or remove one (sessionId, seq, quote) negative marker, newest first. */
    function updateFeedbackDetail(sessionId, item, flaggedOn) {
      const seq = Number(item.seq)
      const quote = String(item.quote || '')
      const current = loadFeedbackDetail()
      const without = current.filter(
        (entry) => !(entry.sessionId === sessionId && entry.seq === seq && entry.quote === quote),
      )
      const next = flaggedOn ? [{ sessionId, seq, quote }, ...without] : without
      saveFeedbackDetail(next)
    }

    /** Evidence this session's user already flagged wrong, for the trace prompt's exclude list. */
    function feedbackExcludeFor(sessionId) {
      if (!sessionId) return []
      return loadFeedbackDetail()
        .filter((entry) => entry.sessionId === sessionId)
        .map((entry) => ({ seq: entry.seq, quote: entry.quote }))
        .slice(0, 40)
    }

    /**
     * Resolve a note back to the text the chat actually renders. Structured
     * notes carry synthesized 1./- markers that are CSS list markers in the
     * DOM, so strip them before searching.
     */
    function noteJumpText(note) {
      if (note && note.quote) return note.quote
      return String(note?.text || '')
        .split('\n')
        .map((line) => line.replace(/^\s*(?:\d+\.|[-*+]|>|#{1,6})\s+/, '').trim())
        .filter(Boolean)
        .join(' ')
    }

    function downloadText(filename, text) {
      try {
        const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        anchor.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 1200)
      } catch {
        // A blocked download changes nothing else.
      }
    }

    /** Highlight the quoted span inside the inline original-text fallback. */
    function renderMarked(text, quote) {
      const source = String(text || '')
      const needle = String(quote || '')
      const at = needle ? source.indexOf(needle) : -1
      if (at < 0) return source
      return [
        source.slice(0, at),
        h('mark', { key: 'm', className: 'dsp-mark' }, needle),
        source.slice(at + needle.length),
      ]
    }

    /** One node per distinct evidence message, ordered by seq. */
    function buildTimeline(result) {
      const nodes = new Map()
      for (const atom of result.atoms || []) {
        for (const item of atom.evidence || []) {
          if (!nodes.has(item.seq)) {
            nodes.set(item.seq, {
              seq: item.seq,
              role: item.role,
              turn: item.turn || 0,
              quote: item.quote,
            })
          }
        }
      }
      if (result.claim && result.claim.seq) {
        nodes.set(result.claim.seq, {
          seq: result.claim.seq,
          role: 'claim',
          turn: 0,
          quote: result.claim.text || '',
        })
      }
      return [...nodes.values()].sort((left, right) => left.seq - right.seq)
    }

    function keywordsFor(result, seq) {
      const isClaim = result.claim && result.claim.seq === seq
      const words = []
      for (const atom of result.atoms || []) {
        if (!isClaim && !(atom.evidence || []).some((item) => item.seq === seq)) continue
        for (const word of atom.keywords || []) {
          if (!words.includes(word)) words.push(word)
        }
      }
      return words
    }

    /* ------------------------------------------------------- archive graph --- */

    const GRAPH_RECORD_LIMIT = 60
    const GRAPH_SOURCE_LIMIT = 12
    const GRAPH_TERM_LIMIT = 18
    const GRAPH_TEXT_LIMIT = 1600
    const GRAPH_STOP_WORDS = new Set(('这个 这些 那个 我们 你们 可以 需要 因为 所以 通过 进行 一个 一些 以及 内容 用户 原文 结论 假设 记录 依据 当前 已经 对于 相关 主要 能够 其中 如果 同时 是否 分别 这样 因此 之前 之后 时候 问题 什么 就是 如何 这里 应该 可能 没有 认为 比较 出现 本次 以上 还有 所有 使用 保存 查看 分析 中的 上的 里的 之中 方面 而言 保留 完整 the and for that this with from have has are was were will can should into about not but its our their then than also dsh').split(' '))
    const graphText = value => String(value || '').replace(/https?:\/\/\S+/g, ' ').replace(/[#*_`>\[\]]/g, '').replace(/\s+/g, ' ').trim()
    const graphKey = value => graphText(value).toLocaleLowerCase()
    const graphLabel = (value, length = 16) => {
      const chars = Array.from(graphText(value))
      return chars.slice(0, length).join('') + (chars.length > length ? '…' : '')
    }
    function graphIdentity(value) {
      let first = 2166136261, second = 5381
      for (let i = 0; i < value.length; i++) {
        first = Math.imul(first ^ value.charCodeAt(i), 16777619)
        second = Math.imul(second, 33) ^ value.charCodeAt(i)
      }
      return `${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`
    }

    function graphTerms(text, keywords = []) {
      const terms = new Map()
      const add = (value, explicit = false) => {
        const label = graphText(value).trim()
        const key = label.toLocaleLowerCase()
        if (label.length < 2 || label.length > 24 || GRAPH_STOP_WORDS.has(key)
          || !/[\p{L}]/u.test(label) || /^\d/.test(label)) return
        const old = terms.get(key)
        if (!old || explicit) terms.set(key, { key, label, explicit })
      }
      for (const keyword of keywords.slice(0, 24)) if (typeof keyword === 'string') add(keyword, true)
      const plain = graphText(text)
      // Sample beginning, middle and end so a long note's final concept is
      // still eligible, without tokenizing its whole body on every update.
      const source = plain.length <= GRAPH_TEXT_LIMIT ? plain
        : [plain.slice(0, 600), plain.slice(Math.floor(plain.length / 2) - 250, Math.floor(plain.length / 2) + 250), plain.slice(-500)].join('\n')
      if (typeof Intl.Segmenter === 'function') {
        const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
        let previous = null
        for (const part of segmenter.segment(source)) {
          if (!part.isWordLike || GRAPH_STOP_WORDS.has(part.segment.toLocaleLowerCase())) { previous = null; continue }
          add(part.segment)
          if (previous && /^[\p{Script=Han}]{2,4}$/u.test(previous.segment)
            && /^[\p{Script=Han}]{2,4}$/u.test(part.segment)
            && previous.index + previous.segment.length === part.index) add(previous.segment + part.segment)
          previous = part
        }
      } else {
        for (const token of source.match(/[a-z][a-z0-9-]{2,23}|[\p{Script=Han}]{2,8}/giu) || []) add(token)
      }
      return [...terms.values()]
    }

    /** Bounded, local associations. Only stored provenance creates directed edges. */
    function buildArchiveGraph({ decisions = [], assumptions = [], notes = [] }) {
      const records = []
      for (const [kind, items] of [['decision', decisions], ['assumption', assumptions], ['note', notes]]) {
        for (const item of items) {
          if (!item || typeof item.id !== 'string' || (kind === 'decision' && item.status === 'revoked')) continue
          const text = String(kind === 'decision' ? item.claim || '' : item.text || '')
          if (!text.trim()) continue
          records.push({ id: `${kind}:${item.id}`, kind, text, item })
        }
      }
      records.sort((a, b) => (Number(b.item.createdAt) || 0) - (Number(a.item.createdAt) || 0) || a.id.localeCompare(b.id))
      const shown = records.slice(0, GRAPH_RECORD_LIMIT)
      const nodes = shown.map(record => ({ ...record, label: graphLabel(record.text, 12), recordIds: [record.id] }))
      const edges = []
      const seenEdges = new Set()
      const addEdge = (source, target, kind, extra = {}) => {
        const key = `${kind}:${source}:${target}`
        if (source === target || seenEdges.has(key)) return
        seenEdges.add(key)
        edges.push({ id: key, source, target, kind, ...extra })
      }
      const terms = new Map()
      for (const record of shown) {
        const explicit = record.kind === 'decision'
          ? (record.item.atoms || []).flatMap(atom => Array.isArray(atom.keywords) ? atom.keywords : []).slice(0, 24) : []
        const recordTerms = graphTerms(record.text, explicit)
        for (const term of recordTerms) {
          if (!terms.has(term.key)) terms.set(term.key, { ...term, recordIds: [], explicitCount: 0 })
          const found = terms.get(term.key)
          found.recordIds.push(record.id)
          if (term.explicit) found.explicitCount++
        }
      }
      const ranked = [...terms.values()].filter(term => term.recordIds.length >= 2 || term.explicitCount)
        .sort((a, b) => (b.recordIds.length * 3 + b.explicitCount * 8) - (a.recordIds.length * 3 + a.explicitCount * 8)
          || b.label.length - a.label.length || a.key.localeCompare(b.key))
      // Prefer "环形索引" over also drawing "环形" and "索引" for the same records.
      const chosen = []
      for (const term of ranked) {
        if (chosen.some(other => other.key.includes(term.key) && term.recordIds.every(id => other.recordIds.includes(id)))) continue
        chosen.push(term)
        if (chosen.length === GRAPH_TERM_LIMIT) break
      }
      for (const term of chosen) {
        const id = `topic:${term.key}`
        nodes.push({ id, kind: 'topic', label: term.label, text: term.label, recordIds: term.recordIds })
        for (const recordId of term.recordIds) {
          if (chosen.filter(other => other.recordIds.includes(recordId)).slice(0, 4).includes(term)) addEdge(id, recordId, 'keyword')
        }
      }
      const topicPairs = []
      for (let i = 0; i < chosen.length; i++) for (let j = i + 1; j < chosen.length; j++) {
        const shared = chosen[i].recordIds.filter(id => chosen[j].recordIds.includes(id))
        if (shared.length >= 2) topicPairs.push({ source: `topic:${chosen[i].key}`, target: `topic:${chosen[j].key}`, count: shared.length })
      }
      topicPairs.sort((a, b) => b.count - a.count)
      for (const pair of topicPairs.slice(0, 20)) addEdge(pair.source, pair.target, 'cooccurrence', { count: pair.count })

      const sourceNodes = new Map()
      for (const record of shown.filter(row => row.kind === 'decision')) {
        for (const assumption of shown.filter(row => row.kind === 'assumption')) {
          if (assumption.item.sessionId !== record.item.sessionId) continue
          if (assumption.item.decisionId === record.item.id
            || (!assumption.item.decisionId && graphKey(assumption.item.sourceClaim) === graphKey(record.text))) {
            addEdge(assumption.id, record.id, 'assumption')
          }
        }
        let perDecision = 0
        for (const atom of record.item.atoms || []) for (const evidence of atom.evidence || []) {
          if (!evidence || !String(evidence.quote || '').trim() || atom.relation === 'unsupported') continue
          const sourceSession = evidence.sessionId ?? record.item.sessionId
          const key = JSON.stringify([sourceSession, evidence.seq, evidence.quote])
          const note = shown.find(row => row.kind === 'note' && row.item.sessionId === sourceSession
            && row.item.seq != null && row.item.seq === evidence.seq
            && graphKey(row.item.quote || row.text) === graphKey(evidence.quote))
          let node = note || sourceNodes.get(key)
          if (!node) {
            if (sourceNodes.size >= GRAPH_SOURCE_LIMIT || perDecision >= 2) continue
            node = { id: `source:${graphIdentity(key)}`, kind: 'source', text: String(evidence.quote),
              label: graphLabel(evidence.quote), recordIds: [],
              item: { ...evidence, sessionId: sourceSession } }
            sourceNodes.set(key, node)
            nodes.push(node)
            perDecision++
          }
          const actual = note ? nodes.find(row => row.id === note.id) : node
          if (!actual.recordIds.includes(record.id)) actual.recordIds.push(record.id)
          addEdge(actual.id, record.id, 'evidence', { relation: atom.relation })
        }
      }
      const degree = new Map()
      for (const edge of edges) for (const id of [edge.source, edge.target]) degree.set(id, (degree.get(id) || 0) + 1)
      for (const node of nodes) node.degree = degree.get(node.id) || 0
      return { nodes, edges, records: shown, totalRecords: records.length, shownRecords: shown.length }
    }

    /** Deterministic settling, no perpetual animation or additional dependency. */
    function layoutArchiveGraph(nodes, edges, width = 760, height = 380) {
      const positions = new Map()
      const ordered = [...nodes].sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
      ordered.forEach((node, index) => {
        const angle = index * 2.399963
        const radius = Math.sqrt(index / Math.max(1, nodes.length)) * Math.min(width * .39, height * .36)
        positions.set(node.id, { x: width / 2 + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius })
      })
      for (let step = 0; step < 130; step++) {
        const forces = new Map(nodes.map(node => [node.id, { x: 0, y: 0 }]))
        for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
          const a = positions.get(nodes[i].id), b = positions.get(nodes[j].id)
          const dx = a.x - b.x || .1, dy = a.y - b.y || .1
          const distance2 = Math.max(100, dx * dx + dy * dy)
          const force = 145 / distance2
          forces.get(nodes[i].id).x += dx * force
          forces.get(nodes[i].id).y += dy * force
          forces.get(nodes[j].id).x -= dx * force
          forces.get(nodes[j].id).y -= dy * force
        }
        for (const edge of edges) {
          const a = positions.get(edge.source), b = positions.get(edge.target)
          if (!a || !b) continue
          const dx = b.x - a.x, dy = b.y - a.y
          const distance = Math.max(1, Math.hypot(dx, dy))
          const pull = (distance - (edge.kind === 'cooccurrence' ? 125 : 95)) * .055
          forces.get(edge.source).x += dx / distance * pull
          forces.get(edge.source).y += dy / distance * pull
          forces.get(edge.target).x -= dx / distance * pull
          forces.get(edge.target).y -= dy / distance * pull
        }
        for (const node of nodes) {
          const point = positions.get(node.id), force = forces.get(node.id)
          const cooling = 1 - step / 150
          point.x = Math.max(62, Math.min(width - 62, point.x + Math.max(-7, Math.min(7, force.x + (width / 2 - point.x) * .022)) * cooling))
          point.y = Math.max(30, Math.min(height - 38, point.y + Math.max(-7, Math.min(7, force.y + (height / 2 - point.y) * .022)) * cooling))
        }
      }
      return positions
    }

    const GRAPH_STYLES = `
      .dpg-root { container-type: inline-size; margin-top: 22px; max-width: 1120px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 16px; overflow: hidden; background: var(--dsw-alias-bg-layer-1); }
      .dpg-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 14px 16px 10px; }
      .dpg-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
      .dpg-title::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--dsp-accent, #7e9fff); box-shadow: 0 0 12px var(--dsp-accent-soft, #7e9fff33); }
      .dpg-caption, .dpg-foot { color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .dpg-controls, .dpg-legend { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .dpg-controls .dpl-btn { font-size: 12px; }
      .dpg-legend { padding: 0 16px 12px; gap: 14px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .dpg-key { display: inline-flex; align-items: center; gap: 5px; }
      .dpg-key i { width: 6px; height: 6px; border-radius: 50%; background: var(--dpg-color); }
      .dpg-body { display: grid; grid-template-columns: minmax(0, 1fr) 244px; min-height: 365px; border-top: 1px solid var(--dsw-alias-border-l1); }
      .dpg-canvas { position: relative; min-width: 0; height: 365px; background: radial-gradient(ellipse at 48% 46%, var(--dsp-accent-soft, #4f8cff12), transparent 68%), var(--dsw-alias-bg-base); overflow: hidden; }
      .dpg-root.large .dpg-canvas { height: min(66vh, 640px); min-height: 365px; }
      .dpg-canvas svg { display: block; width: 100%; height: 100%; touch-action: none; user-select: none; cursor: grab; }
      .dpg-canvas svg:active { cursor: grabbing; }
      .dpg-edge { stroke: var(--dsw-alias-label-secondary); stroke-opacity: .19; stroke-width: 1; transition: stroke-opacity .16s; pointer-events: none; }
      .dpg-edge.keyword, .dpg-edge.cooccurrence { stroke-dasharray: 3 5; stroke-opacity: .14; }
      .dpg-edge.hot { stroke: var(--dsp-accent, #7e9fff); stroke-opacity: .75; stroke-width: 1.4; }
      .dpg-edge.faint { stroke-opacity: .045; }
      .dpg-node { cursor: pointer; outline: none; opacity: 1; transition: opacity .16s; }
      .dpg-node.faint { opacity: .2; }
      .dpg-node circle { fill: var(--dpg-color); stroke: var(--dsw-alias-bg-layer-1); stroke-width: 1.7; }
      .dpg-node.selected circle, .dpg-node:focus-visible circle { stroke: var(--dsp-accent, #7e9fff); stroke-width: 3; filter: drop-shadow(0 0 6px var(--dsp-accent-soft, #7e9fff55)); }
      .dpg-node text { fill: var(--dsw-alias-label-primary); font-family: inherit; font-size: 11px; paint-order: stroke; stroke: var(--dsw-alias-bg-base); stroke-width: 3px; stroke-linejoin: round; pointer-events: none; }
      .dpg-node.selected text { font-weight: 600; }
      .dpg-zoom { position: absolute; bottom: 10px; left: 12px; display: flex; align-items: center; gap: 4px; padding: 3px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; }
      .dpg-zoom button { width: 28px; height: 26px; padding: 0; }
      .dpg-zoom span { min-width: 42px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .dpg-detail { padding: 14px; border-left: 1px solid var(--dsw-alias-border-l1); max-height: 365px; overflow: auto; }
      .dpg-root.large .dpg-detail { max-height: min(66vh, 640px); }
      .dpg-detail h4 { margin: 8px 0; font-size: 14px; overflow-wrap: anywhere; }
      .dpg-kind { color: var(--dpg-color); font-size: 11px; }
      .dpg-detail p { margin: 6px 0 12px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .dpg-record { display: block; width: 100%; text-align: left; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; padding: 8px 9px; background: transparent; color: inherit; cursor: pointer; margin-top: 7px; }
      .dpg-record:hover, .dpg-record:focus-visible { border-color: var(--dsp-accent, #7e9fff); background: var(--dsp-accent-soft); }
      .dpg-record small { display: block; color: var(--dsw-alias-label-secondary); font-size: 10px; margin-bottom: 3px; }
      .dpg-record span { font-size: 12px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
      .dpg-foot { padding: 9px 16px; border-top: 1px solid var(--dsw-alias-border-l1); }
      .dpg-empty { min-height: 180px; display: grid; place-content: center; text-align: center; padding: 24px; color: var(--dsw-alias-label-secondary); }
      .dpg-empty b { color: var(--dsw-alias-label-primary); margin-bottom: 6px; font-weight: 500; }
      .dpl-root { position: relative; display: flex; flex-direction: column; box-sizing: border-box; overflow: hidden; padding-bottom: 62px; }
      .dpl-head, .dpl-stats, .dpl-tabs, .dpl-notice { flex-shrink: 0; }
      .dpl-record-area { flex: 1; min-height: 0; overflow: auto; padding: 1px 3px 12px 1px; }
      .dpg-dock { position: absolute; z-index: 5; left: 24px; right: 24px; bottom: 14px; height: 30px; display: flex; justify-content: center; }
      .dpg-dock.open::before { content: ''; position: absolute; left: 0; right: 0; bottom: 26px; height: 18px; }
      .dpg-handle { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 5px 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); font: inherit; font-size: 12px; cursor: pointer; transition: color .2s ease, border-color .2s ease, background .2s ease; }
      .dpg-handle svg { width: 20px; height: 14px; flex: 0 0 auto; }
      .dpg-handle small { font-size: 10px; opacity: .65; }
      .dpg-handle:hover, .dpg-handle:focus-visible, .dpg-dock.open .dpg-handle { color: var(--dsp-accent, #659ce8); border-color: var(--dsp-accent-soft); background: var(--dsw-alias-bg-layer-2); }
      .dpg-sheet { position: absolute; left: 0; right: 0; bottom: 38px; max-height: min(520px, calc(var(--dpg-space, 600px) * .7)); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; border: 1px solid var(--dsw-alias-border-l2); border-radius: 16px; background: var(--dsw-alias-bg-layer-1); box-shadow: 0 -10px 38px rgba(0,0,0,.13); opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(calc(100% + 52px)); transition: transform .36s cubic-bezier(.22,1,.36,1), opacity .24s ease, visibility 0s linear .36s; }
      .dpg-dock.open .dpg-sheet { opacity: 1; visibility: visible; pointer-events: auto; transform: translateY(0); transition-delay: 0s; }
      .dpg-sheet .dpg-root { margin: 0; max-width: none; border: 0; border-radius: 0; overflow: visible; }
      .dpg-sheet .dpg-head { position: sticky; top: 0; z-index: 2; background: var(--dsw-alias-bg-layer-1); }
      .dpl-card[data-graph-focus="true"], .dpl-asm-row[data-graph-focus="true"] { border-color: var(--dsp-accent); box-shadow: 0 0 0 2px var(--dsp-accent-soft); }
      @container (max-width: 620px) { .dpg-body { grid-template-columns: 1fr; } .dpg-detail { max-height: 210px; border-left: 0; border-top: 1px solid var(--dsw-alias-border-l1); } .dpg-root.large .dpg-detail { max-height: 260px; } }
      @media (prefers-reduced-motion: reduce) { .dpg-edge, .dpg-node, .dpg-sheet, .dpg-handle { transition: none; } }
    `

    /** A bottom edge trigger reveals a contained, independently scrollable sheet. */
    function ArchiveGraphDock({ graph, en, onReveal, archiveRootRef }) {
      const t = (zh, english) => en ? english : zh
      const [visible, setVisible] = React.useState(false)
      const [mounted, setMounted] = React.useState(false)
      const [space, setSpace] = React.useState(600)
      const dockRef = React.useRef(null)
      const handleRef = React.useRef(null)
      const visibleRef = React.useRef(false)
      const insideRef = React.useRef(false)
      const suppressedRef = React.useRef(false)
      const openTimer = React.useRef(null)
      const closeTimer = React.useRef(null)
      const pointerOpenState = React.useRef(null)
      const clearTimers = () => { window.clearTimeout(openTimer.current); window.clearTimeout(closeTimer.current) }
      const show = () => {
        clearTimers()
        setMounted(true)
        visibleRef.current = true
        setVisible(true)
      }
      const hide = (restoreFocus = false) => {
        clearTimers()
        suppressedRef.current = restoreFocus || insideRef.current
        visibleRef.current = false
        setVisible(false)
        if (restoreFocus) handleRef.current?.focus({ preventScroll: true })
      }
      const scheduleHide = () => {
        window.clearTimeout(closeTimer.current)
        closeTimer.current = window.setTimeout(() => {
          if (insideRef.current || dockRef.current?.contains(document.activeElement)) return
          hide()
        }, 550)
      }
      React.useEffect(() => () => clearTimers(), [])
      React.useEffect(() => {
        const root = archiveRootRef.current
        if (!root) return undefined
        const measure = () => setSpace(Math.max(180, root.clientHeight))
        measure()
        if (typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver(measure)
        observer.observe(root)
        return () => observer.disconnect()
      }, [archiveRootRef])
      React.useEffect(() => {
        if (!visible) return undefined
        const outside = event => {
          if (!dockRef.current?.contains(event.target)) hide()
        }
        document.addEventListener('pointerdown', outside, true)
        return () => document.removeEventListener('pointerdown', outside, true)
      }, [visible])
      return h('div', { className: 'dpg-dock' + (visible ? ' open' : ''), ref: dockRef,
        style: { '--dpg-space': `${space}px` },
        onPointerEnter: event => {
          if (event.pointerType === 'touch') return
          insideRef.current = true
          window.clearTimeout(closeTimer.current)
          if (!suppressedRef.current && !visibleRef.current) openTimer.current = window.setTimeout(show, 130)
        },
        onPointerLeave: event => {
          if (event.pointerType === 'touch') return
          insideRef.current = false
          suppressedRef.current = false
          window.clearTimeout(openTimer.current)
          scheduleHide()
        },
        onFocus: () => { if (!suppressedRef.current) show() },
        onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) scheduleHide() },
        onKeyDown: event => { if (event.key === 'Escape' && visibleRef.current) { event.stopPropagation(); event.preventDefault(); suppressedRef.current = true; hide(true) } },
      },
        h('div', { className: 'dpg-sheet', 'aria-hidden': !visible, inert: !visible ? true : undefined },
          mounted ? h(ArchiveGraph, { graph, en, onDismiss: () => hide(true), onReveal: record => { hide(); onReveal(record) } }) : null),
        h('button', { ref: handleRef, type: 'button', className: 'dpg-handle', 'aria-expanded': visible,
          'aria-label': t('关系图谱', 'Relationship graph'),
          title: t('移到这里展开；也可点击或用键盘打开', 'Hover to reveal, or open with a click or keyboard'),
          onPointerDown: () => { pointerOpenState.current = visibleRef.current },
          onClick: () => {
            const wasOpen = pointerOpenState.current ?? visibleRef.current
            pointerOpenState.current = null
            if (wasOpen) { suppressedRef.current = true; hide() } else { suppressedRef.current = false; show() }
          } },
          h('svg', { viewBox: '0 0 24 16', fill: 'none', 'aria-hidden': true },
            h('path', { d: 'M4 12 12 4 20 12', stroke: 'currentColor', strokeWidth: 1, opacity: .65 }),
            ...[[4,12],[12,4],[20,12]].map(([cx,cy]) => h('circle', { key: cx, cx, cy, r: 2.3, fill: 'currentColor' }))),
          t('关系图谱', 'Relationship graph'), h('small', { 'aria-hidden': true }, visible ? '⌄' : '⌃')))
    }

    function ArchiveGraph({ graph, en, onReveal, onDismiss }) {
      const t = (zh, english) => en ? english : zh
      const colors = { topic: '#a78bfa', decision: '#659ce8', assumption: '#d6a658', note: '#94a3b8', source: '#55aaa3' }
      const kindName = kind => ({ topic: t('概念', 'Concept'), decision: t('结论', 'Conclusion'), assumption: t('假设', 'Assumption'), note: t('摘录', 'Note'), source: t('依据原文', 'Source') })[kind]
      const [selectedId, setSelectedId] = React.useState(null)
      const [hoverId, setHoverId] = React.useState(null)
      const [large, setLarge] = React.useState(false)
      const [open, setOpen] = React.useState(true)
      const [size, setSize] = React.useState({ width: 700, height: 365 })
      const [view, setView] = React.useState({ x: 0, y: 0, scale: 1 })
      const [moved, setMoved] = React.useState({})
      const canvasRef = React.useRef(null)
      const svgRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const suppressClick = React.useRef(false)
      const settled = React.useMemo(() => layoutArchiveGraph(graph.nodes, graph.edges, size.width, size.height), [graph, size])
      React.useEffect(() => {
        setMoved({})
        setView({ x: 0, y: 0, scale: 1 })
        setSelectedId(id => graph.nodes.some(node => node.id === id) ? id
          : [...graph.nodes].filter(node => node.kind === 'topic').sort((a, b) => b.degree - a.degree)[0]?.id || null)
      }, [graph])
      React.useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return undefined
        const measure = () => {
          const box = canvas.getBoundingClientRect()
          if (box.width > 0 && box.height > 0) setSize(old => Math.abs(old.width - box.width) < 1 && Math.abs(old.height - box.height) < 1
            ? old : { width: box.width, height: box.height })
        }
        measure()
        if (typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver(measure)
        observer.observe(canvas)
        return () => observer.disconnect()
      }, [open, large, graph.nodes.length > 0])
      const zoom = (factor, anchor = { x: size.width / 2, y: size.height / 2 }) => setView(old => {
        const scale = Math.max(.45, Math.min(2.8, old.scale * factor))
        return { scale, x: anchor.x - (anchor.x - old.x) * scale / old.scale, y: anchor.y - (anchor.y - old.y) * scale / old.scale }
      })
      React.useEffect(() => {
        const svg = svgRef.current
        if (!svg) return undefined
        const wheel = event => {
          if (!event.ctrlKey && !event.metaKey) return
          event.preventDefault()
          const box = svg.getBoundingClientRect()
          zoom(event.deltaY > 0 ? .9 : 1.1, { x: event.clientX - box.left, y: event.clientY - box.top })
        }
        svg.addEventListener('wheel', wheel, { passive: false })
        return () => svg.removeEventListener('wheel', wheel)
      }, [open, graph.nodes.length > 0])
      const point = nodeId => moved[nodeId] || settled.get(nodeId)
      const activeId = hoverId || selectedId
      const neighborhood = new Set(activeId ? [activeId] : [])
      for (const edge of graph.edges) if (edge.source === activeId || edge.target === activeId) { neighborhood.add(edge.source); neighborhood.add(edge.target) }
      const labels = new Map()
      const labelBoxes = []
      const priority = node => node.id === activeId ? 100 : neighborhood.has(node.id) ? 50 : node.kind === 'topic' ? 20 : 0
      for (const node of [...graph.nodes].sort((a, b) => priority(b) - priority(a) || b.degree - a.degree)) {
        if (activeId && !neighborhood.has(node.id) && node.kind !== 'topic') continue
        const position = point(node.id)
        const width = Math.min(178, Array.from(node.label).reduce((sum, char) => sum + (/\p{Script=Han}/u.test(char) ? 11 : 6), 8))
        for (const y of [25, -18]) {
          const box = { left: position.x - width / 2, right: position.x + width / 2, top: position.y + y - 11, bottom: position.y + y + 4 }
          if (node.id !== activeId && labelBoxes.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) continue
          labels.set(node.id, y)
          labelBoxes.push(box)
          break
        }
      }
      const selected = graph.nodes.find(node => node.id === selectedId)
      const selectedRecords = new Set(selected?.recordIds || [])
      if (selected && selected.kind !== 'topic') for (const edge of graph.edges) {
        if (!['evidence', 'assumption'].includes(edge.kind)) continue
        const neighborId = edge.source === selected.id ? edge.target : edge.target === selected.id ? edge.source : null
        const neighbor = graph.nodes.find(node => node.id === neighborId)
        for (const recordId of neighbor?.recordIds || []) selectedRecords.add(recordId)
      }
      const related = graph.records.filter(record => selectedRecords.has(record.id))
      const jumpTarget = selected?.kind === 'source' || (selected?.kind === 'note' && selected.item.seq != null)
        ? { quote: selected.kind === 'note' ? noteJumpText(selected.item) : selected.text, seq: selected.item.seq, sessionId: selected.item.sessionId }
        : selected?.kind === 'decision' && selected.item.claimSeq != null
          ? { quote: selected.text, seq: selected.item.claimSeq, sessionId: selected.item.sessionId } : null
      const start = (event, nodeId = null) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        suppressClick.current = false
        dragRef.current = { id: nodeId, pointerId: event.pointerId, x: event.clientX, y: event.clientY, view, point: nodeId ? point(nodeId) : null }
        svgRef.current?.setPointerCapture(event.pointerId)
      }
      const move = event => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y
        if (Math.hypot(dx, dy) > 4) suppressClick.current = true
        if (!suppressClick.current) return
        if (drag.id) setMoved(old => ({ ...old, [drag.id]: { x: drag.point.x + dx / drag.view.scale, y: drag.point.y + dy / drag.view.scale } }))
        else setView({ ...drag.view, x: drag.view.x + dx, y: drag.view.y + dy })
      }
      const finish = event => {
        const drag = dragRef.current
        if (drag?.pointerId !== event.pointerId) return
        if (event.type !== 'pointercancel' && drag.id && !suppressClick.current) setSelectedId(drag.id)
        suppressClick.current = suppressClick.current || Boolean(drag.id)
        dragRef.current = null
        if (svgRef.current?.hasPointerCapture(event.pointerId)) svgRef.current.releasePointerCapture(event.pointerId)
      }
      const reset = () => { setView({ x: 0, y: 0, scale: 1 }); setMoved({}); setSelectedId(null); setHoverId(null) }
      const edgeTitle = edge => edge.kind === 'assumption' ? t('结论依赖的已保存假设', 'Saved premise of the conclusion')
        : edge.kind === 'evidence' ? t('已保存的溯源关系：', 'Saved source relationship: ') + relationLabel(edge.relation, t)
        : edge.kind === 'cooccurrence' ? t(`共同出现在 ${edge.count} 条档案中`, `Co-occurs in ${edge.count} records`) : t('包含共同关键词', 'Shared keyword')
      return h('section', { className: 'dpg-root' + (large ? ' large' : ''), 'aria-label': t('档案关系图谱', 'Archive relationship graph') },
        h('div', { className: 'dpg-head' },
          h('div', null, h('div', { className: 'dpg-title' }, t('关系图谱', 'Relationship graph')),
            h('div', { className: 'dpg-caption' }, t('从一个概念，找到相连的观点与原文。', 'Follow a concept to its connected ideas and sources.'))),
          h('div', { className: 'dpg-controls' },
            open && graph.nodes.length ? h('button', { type: 'button', className: 'dpl-btn', onClick: () => setLarge(value => !value), 'aria-pressed': large }, large ? t('缩小视图', 'Compact view') : t('放大视图', 'Expand view')) : null,
            h('button', { type: 'button', className: 'dpl-btn', onClick: onDismiss || (() => setOpen(value => !value)), 'aria-expanded': open }, open ? t('收起图谱', 'Hide graph') : t('展开图谱', 'Show graph')))),
        open ? h(React.Fragment, null,
          h('div', { className: 'dpg-legend' }, ...['topic', 'decision', 'assumption', 'note', 'source'].map(kind => h('span', { key: kind, className: 'dpg-key', style: { '--dpg-color': colors[kind] } }, h('i'), kindName(kind)))),
          graph.nodes.length ? h('div', { className: 'dpg-body' },
            h('div', { className: 'dpg-canvas', ref: canvasRef },
              h('svg', { ref: svgRef, role: 'group', 'aria-label': t('可拖动的概念与档案节点', 'Draggable concept and archive nodes'),
                viewBox: `0 0 ${size.width} ${size.height}`, onPointerDown: event => start(event), onPointerMove: move, onPointerUp: finish, onPointerCancel: finish,
                onLostPointerCapture: () => { dragRef.current = null }, onClick: () => { if (!suppressClick.current) setSelectedId(null) } },
                h('g', { transform: `translate(${view.x} ${view.y}) scale(${view.scale})` },
                  ...graph.edges.map(edge => {
                    const a = point(edge.source), b = point(edge.target)
                    const hot = activeId && (edge.source === activeId || edge.target === activeId)
                    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1
                    const endX = b.x - dx / length * 12, endY = b.y - dy / length * 12
                    return h('g', { key: edge.id, 'aria-hidden': true },
                      h('line', { x1: a.x, y1: a.y, x2: endX, y2: endY, className: `dpg-edge ${edge.kind}${hot ? ' hot' : activeId ? ' faint' : ''}` }, h('title', null, edgeTitle(edge))),
                      ['evidence', 'assumption'].includes(edge.kind) ? h('path', {
                        d: `M ${endX - dx / length * 5 - dy / length * 3} ${endY - dy / length * 5 + dx / length * 3} L ${endX} ${endY} L ${endX - dx / length * 5 + dy / length * 3} ${endY - dy / length * 5 - dx / length * 3}`,
                        className: `dpg-edge${hot ? ' hot' : activeId ? ' faint' : ''}`, fill: 'none',
                      }) : null)
                  }),
                  ...graph.nodes.map(node => {
                    const p = point(node.id)
                    const select = event => { event.stopPropagation(); if (!suppressClick.current) setSelectedId(node.id) }
                    return h('g', { key: node.id, role: 'button', tabIndex: 0, 'aria-label': `${kindName(node.kind)}：${node.text}`, 'aria-pressed': selectedId === node.id,
                      'data-graph-node': node.id, className: `dpg-node${selectedId === node.id ? ' selected' : ''}${activeId && !neighborhood.has(node.id) ? ' faint' : ''}`,
                      style: { '--dpg-color': colors[node.kind] }, transform: `translate(${p.x} ${p.y})`, onClick: select,
                      onPointerDown: event => start(event, node.id), onPointerEnter: () => setHoverId(node.id), onPointerLeave: () => setHoverId(null),
                      onFocus: () => setHoverId(node.id), onBlur: () => setHoverId(null),
                      onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(node.id) } } },
                      h('title', null, `${kindName(node.kind)} · ${node.text}`),
                      h('circle', { r: 16, style: { fill: 'transparent', stroke: 'none' } }),
                      h('circle', { r: node.kind === 'topic' ? Math.min(13, 7 + node.recordIds.length) : Math.min(10, 4 + Math.sqrt(node.degree)) }),
                      labels.has(node.id) ? h('text', { y: labels.get(node.id), textAnchor: 'middle' }, node.label) : null)
                  }))),
              h('div', { className: 'dpg-zoom' },
                h('button', { type: 'button', className: 'dpl-btn', onClick: () => zoom(.8), 'aria-label': t('缩小图谱', 'Zoom out') }, '−'),
                h('span', null, `${Math.round(view.scale * 100)}%`),
                h('button', { type: 'button', className: 'dpl-btn', onClick: () => zoom(1.25), 'aria-label': t('放大图谱', 'Zoom in') }, '+'),
                h('button', { type: 'button', className: 'dpl-btn', onClick: reset, 'aria-label': t('重置图谱视图', 'Reset graph view'), title: t('重置视图', 'Reset view') }, '↺'))),
            h('aside', { className: 'dpg-detail', 'aria-live': 'polite' },
              selected ? h(React.Fragment, null,
                h('span', { className: 'dpg-kind', style: { '--dpg-color': colors[selected.kind] } }, kindName(selected.kind)),
                h('h4', null, selected.kind === 'topic' ? selected.text : graphLabel(selected.text, 34)),
                selected.kind !== 'topic' ? h(CollapsibleText, { text: selected.text, en, variant: 'record' }) : null,
                h('p', null, t(`关联 ${related.length} 条档案。点击条目可查看。`, `${related.length} connected records. Open a record to inspect it.`)),
                ...related.map(record => h('button', { key: record.id, type: 'button', className: 'dpg-record', onClick: () => onReveal(record) },
                  h('small', null, `${kindName(record.kind)} · ${compactDate(record.item.createdAt, en)}`), h('span', null, record.text))),
                jumpTarget ? h('button', { type: 'button', className: 'dpl-btn', 'data-dsp-jump': '', style: { marginTop: '10px' },
                  onClick: () => window.dispatchEvent(new CustomEvent(JUMP_EVENT, { detail: { ...jumpTarget, addressed: true } })) }, t('跳转原文', 'Jump to source')) : null,
              ) : h(React.Fragment, null, h('h4', null, t('点亮一个概念', 'Choose a concept')),
                h('p', null, t('点击圆点，查看相邻概念、关联档案与来源。也可以拖动圆点，整理眼前的关系。', 'Select a node to inspect its neighbors, records and sources. Drag nodes to arrange the view.')),
                h('p', null, t('实线箭头：已存档的依据或依赖假设。虚线：共同关键词或概念共现，供探索关联。', 'Arrows: saved source or premise relationships. Dashed lines: shared keywords or co-occurring concepts.')))))
          : h('div', { className: 'dpg-empty' },
              h('b', null, graph.totalRecords ? t('当前筛选没有可显示的节点', 'No nodes in this selection') : t('保存一些观点，关系会在这里生长', 'Save ideas to start your graph')),
              h('span', null, t('存档结论、假设或摘录后自动生成，也可以切换到「全部会话」。', 'Save conclusions, assumptions or notes, or switch to All sessions.'))),
          h('div', { className: 'dpg-foot' }, t(
            `本地生成 · ${graph.shownRecords}/${graph.totalRecords} 条档案 · 虚线关联不代表证据。拖动空白平移，Ctrl/⌘ + 滚轮缩放。${graph.totalRecords > graph.shownRecords ? '当前显示最近 60 条，可用上方搜索缩小范围。' : ''}`,
            `Local graph · ${graph.shownRecords}/${graph.totalRecords} records · Dashed links are associations, not evidence. Drag to pan; Ctrl/⌘ + wheel to zoom.${graph.totalRecords > graph.shownRecords ? ' Showing the latest 60 records; use archive search to narrow the scope.' : ''}`))) : null)
    }

    /* -------------------------------------------------------- diagram export --- */

    const DIAGRAM_MAX_RECORDS = 20
    const DIAGRAM_MAX_CHARS = 24000
    const diagramPlain = value => String(value || '').replace(/[#*_`>\[\]]/g, '').replace(/\s+/g, ' ').trim()
    const diagramXml = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
      .replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char])

    function diagramLines(value, columns = 30, maxLines = 8) {
      const chars = Array.from(diagramPlain(value))
      const lines = []
      let line = '', width = 0
      for (let i = 0; i < chars.length; i++) {
        const char = chars[i], advance = /[MW@#%&]/.test(char) ? 1 : /[A-Zmw]/.test(char) ? .82 : /[\x00-\xff]/.test(char) ? .65 : 1
        if (width + advance > columns && line) {
          lines.push(line.trim())
          if (lines.length === maxLines) { lines[maxLines - 1] = lines[maxLines - 1].replace(/.$/u, '') + '…'; return lines }
          line = ''; width = 0
        }
        line += char; width += advance
      }
      if (line.trim()) lines.push(line.trim())
      return lines
    }

    function localDiagramGroups(records, en) {
      const candidates = new Map()
      const words = new Map()
      for (const record of records) {
        const explicit = record.kind === 'decision' ? (record.item.atoms || []).flatMap(atom => atom.keywords || []) : []
        const terms = graphTerms(record.text, explicit)
        words.set(record.id, new Set(terms.map(term => term.key)))
        for (const term of terms) {
          if (!candidates.has(term.key)) candidates.set(term.key, { ...term, count: 0, score: 0 })
          const candidate = candidates.get(term.key)
          candidate.count++; candidate.score += term.explicit ? 5 : 1
        }
      }
      const topics = [...candidates.values()].filter(term => term.count >= 2)
        .sort((a, b) => b.score - a.score || b.label.length - a.label.length).slice(0, 5)
      const groups = new Map()
      for (const record of records) {
        const topic = topics.find(term => words.get(record.id).has(term.key))
        const key = topic?.key || record.kind
        if (!groups.has(key)) groups.set(key, { id: `group-${groups.size + 1}`,
          title: topic?.label || (record.kind === 'note' ? (en ? 'Saved excerpts' : '摘录材料') : (en ? 'Saved conclusions' : '存档结论')),
          summary: '', recordIds: [] })
        groups.get(key).recordIds.push(record.id)
      }
      return [...groups.values()].map(group => ({ ...group, summary: en
        ? `${group.recordIds.length} selected records, organized by shared terms or record type.`
        : `按共同词或记录类型整理的 ${group.recordIds.length} 条选中材料。` }))
    }

    function checkedDiagramGroups(raw, records) {
      const ids = new Set(records.map(record => record.id)), seen = new Set()
      if (!Array.isArray(raw) || !raw.length || raw.length > 7) throw new Error('Invalid diagram groups')
      const groups = raw.map((group, index) => {
        if (!group || typeof group.title !== 'string' || !group.title.trim() || group.title.length > 80
          || typeof group.summary !== 'string' || group.summary.length > 600 || !Array.isArray(group.recordIds) || !group.recordIds.length) throw new Error('Invalid diagram group')
        const recordIds = [...new Set(group.recordIds)]
        for (const id of recordIds) { if (!ids.has(id) || seen.has(id)) throw new Error('Invalid diagram source'); seen.add(id) }
        return { id: `group-${index + 1}`, title: group.title, summary: group.summary, recordIds }
      })
      if (seen.size !== ids.size) throw new Error('Missing diagram source')
      return groups
    }

    /** Both layouts preserve the same selected records and source references. */
    function buildArchiveDiagram(records, { layout = 'mind', title = '', en = false, groups: supplied, ai = false, includeSources = true } = {}) {
      if (!records.length || records.length > DIAGRAM_MAX_RECORDS) throw new Error('Select 1–20 records')
      const groups = supplied ? checkedDiagramGroups(supplied, records) : localDiagramGroups(records, en)
      const text = (zh, english) => en ? english : zh
      const nodes = [], edges = []
      const card = (id, kind, label, heading, body, recordId = null, width = 280) => {
        const titleLines = diagramLines(heading, Math.floor((width - 32) / (kind === 'root' ? 18 : 14)), 2)
        const bodyLines = diagramLines(body, Math.floor((width - 32) / 12), ['synthesis', 'group'].includes(kind) ? 12 : ['note', 'decision'].includes(kind) ? 9 : 7)
        return { id, kind, label, titleLines, bodyLines, recordId, width,
          height: 52 + titleLines.length * 20 + bodyLines.length * 18 + 16, x: 0, y: 0 }
      }
      const numbers = new Map(records.map((record, index) => [record.id, `${record.kind === 'note' ? 'N' : 'C'}${String(index + 1).padStart(2, '0')}`]))
      const mapping = new Map(records.map(record => [record.id, record]))
      const slots = []
      for (const group of groups) {
        const groupCard = card(group.id, ai ? 'synthesis' : 'group', ai ? text('AI 归纳 · 待核对', 'AI synthesis · review') : text('主题整理', 'Topic group'), group.title, group.summary)
        const members = group.recordIds.map(id => {
          const record = mapping.get(id)
          const node = card(`record:${id}`, record.kind === 'note' ? 'note' : 'decision',
            `${record.kind === 'note' ? text('摘录', 'Excerpt') : text('结论', 'Conclusion')} ${numbers.get(id)}`,
            '', record.text, id, 310)
          const leaves = []
          if (includeSources && record.kind === 'decision') {
            const seen = new Set()
            for (const atom of record.item.atoms || []) for (const evidence of atom.evidence || []) {
              if (!evidence?.quote || atom.relation === 'unsupported' || leaves.length >= 2) continue
              const key = JSON.stringify([evidence.sessionId || record.item.sessionId, evidence.seq, evidence.quote])
              if (seen.has(key)) continue
              seen.add(key)
              const leaf = card(`evidence:${id}:${leaves.length}`, 'source', text('已存依据', 'Saved source'),
                relationLabel(atom.relation, text), evidence.quote, id, 270)
              leaves.push(leaf)
              edges.push({ source: leaf.id, target: node.id, kind: 'source' })
            }
            for (const assumption of (record.item.assumptions || []).slice(0, 2)) {
              const leaf = card(`premise:${id}:${leaves.length}`, 'assumption', text('待核对前提', 'Premise to review'),
                text('依赖假设', 'Assumption'), assumption, id, 270)
              leaves.push(leaf)
              edges.push({ source: leaf.id, target: node.id, kind: 'assumption' })
            }
          }
          const leavesHeight = leaves.reduce((sum, leaf) => sum + leaf.height + 20, 0) - (leaves.length ? 20 : 0)
          return { node, leaves, height: Math.max(node.height, leavesHeight) + 30 }
        })
        slots.push({ groupCard, members, height: Math.max(groupCard.height + 30, members.reduce((sum, member) => sum + member.height, 0)) })
      }
      const total = slots.reduce((sum, slot) => sum + slot.height + 44, 0)
      const sourceColumn = includeSources && slots.some(slot => slot.members.some(member => member.leaves.length))
      const positions = layout === 'structure' ? { group: sourceColumn ? 1130 : 760, record: sourceColumn ? 775 : 390, leaf: 390 }
        : { group: 390, record: 760, leaf: 1150 }
      const root = card('root', 'root', text('导图主题', 'Main topic'), title || text('摘录与结论', 'Excerpts and conclusions'),
        text(`${records.filter(record => record.kind === 'note').length} 条摘录 · ${records.filter(record => record.kind === 'decision').length} 条结论`,
          `${records.filter(record => record.kind === 'note').length} excerpts · ${records.filter(record => record.kind === 'decision').length} conclusions`), null, 260)
      root.x = 48; root.y = 130 + Math.max(0, total - root.height) / 2
      nodes.push(root)
      let y = 130
      for (const slot of slots) {
        slot.groupCard.x = positions.group
        slot.groupCard.y = y + (slot.height - slot.groupCard.height) / 2
        nodes.push(slot.groupCard)
        if (layout === 'mind') edges.push({ source: root.id, target: slot.groupCard.id, kind: 'organization' })
        let memberY = y + Math.max(0, slot.height - slot.members.reduce((sum, member) => sum + member.height, 0)) / 2
        for (const member of slot.members) {
          member.node.x = layout === 'structure' && sourceColumn && !member.leaves.length ? 390 : positions.record
          member.node.y = memberY + (member.height - 30 - member.node.height) / 2
          nodes.push(member.node)
          edges.push(layout === 'structure' ? { source: member.node.id, target: slot.groupCard.id, kind: 'organization' }
            : { source: slot.groupCard.id, target: member.node.id, kind: 'organization' })
          if (layout === 'structure') {
            for (const target of member.leaves.length ? member.leaves : [member.node]) edges.push({ source: root.id, target: target.id, kind: 'organization' })
          }
          let leafY = memberY
          for (const leaf of member.leaves) { leaf.x = positions.leaf; leaf.y = leafY; leafY += leaf.height + 20; nodes.push(leaf) }
          memberY += member.height
        }
        y += slot.height + 44
      }
      return { title: title || text('摘录与结论', 'Excerpts and conclusions'), layout, en, ai, nodes, edges,
        width: Math.max(...nodes.map(node => node.x + node.width)) + 48,
        height: Math.max(...nodes.map(node => node.y + node.height)) + 100, recordCount: records.length }
    }

    function archiveDiagramSvg(document, paper = 'dark') {
      const light = paper === 'light'
      const palette = light ? { background: '#f7f9fc', frame: '#c5d2e1', text: '#172b42', muted: '#53667b', line: '#8b9cae',
        root: ['#e8effa','#92abd0'], note: ['#edf7fc','#8db7c9'], decision: ['#f3eef9','#b09bc7'], source: ['#f0f5f8','#8ea7b3'],
        assumption: ['#fff8e7','#c4a967'], group: ['#eaf3f3','#87b3b3'], synthesis: ['#f2edf8','#a48bbb'] }
        : { background: '#10161f', frame: '#3e5169', text: '#e5ecf4', muted: '#9babbf', line: '#75869a',
          root: ['#1b2635','#657e9b'], note: ['#192e3b','#497890'], decision: ['#2c263b','#79658f'], source: ['#1b2933','#4e6c7a'],
          assumption: ['#302a1b','#9e874c'], group: ['#1c3035','#547e84'], synthesis: ['#2c263b','#84709f'] }
      const esc = diagramXml
      const nodeMap = new Map(document.nodes.map(node => [node.id, node]))
      const lines = document.edges.map(edge => {
        const a = nodeMap.get(edge.source), b = nodeMap.get(edge.target)
        const right = b.x > a.x
        const x1 = right ? a.x + a.width : a.x, x2 = right ? b.x : b.x + b.width
        const y1 = a.y + a.height / 2, y2 = b.y + b.height / 2, mid = (x1 + x2) / 2
        const color = edge.kind === 'source' ? (light ? '#528897' : '#71a6b2') : edge.kind === 'assumption' ? '#b39a58' : palette.line
        let path = `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`
        if (document.layout === 'structure' && edge.kind === 'organization') {
          if (a.kind === 'root') path = `M${x1},${y1} C${x1+36},${y1} ${x1+36},${y2} ${x1+52},${y2} L${x2},${y2}`
          else { const lane = x2 - 25; path = `M${x1},${y1} L${lane},${y1} C${lane},${y1} ${lane},${y2} ${x2},${y2}` }
        }
        return `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.5"${edge.kind === 'organization' ? ' stroke-dasharray="4 4"' : ''} marker-end="url(#dmd-arrow)"/>`
      }).join('')
      const cards = document.nodes.map(node => {
        const [fill, stroke] = palette[node.kind]
        const bodyY = node.y + 48 + node.titleLines.length * 20
        return `<g><rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="9" fill="${fill}" stroke="${stroke}"${node.kind === 'assumption' ? ' stroke-dasharray="4 3"' : ''}/>`
          + `<text x="${node.x+16}" y="${node.y+25}" fill="${palette.muted}" font-size="11">${esc(node.label)}</text>`
          + `<text fill="${palette.text}" font-size="${node.kind==='root'?18:14}" font-weight="600">${node.titleLines.map((line,index)=>`<tspan x="${node.x+16}" y="${node.y+49+index*20}">${esc(line)}</tspan>`).join('')}</text>`
          + `<text fill="${palette.text}" font-size="12">${node.bodyLines.map((line,index)=>`<tspan x="${node.x+16}" y="${bodyY+index*18}">${esc(line)}</tspan>`).join('')}</text></g>`
      }).join('')
      const subtitle = document.en ? `${document.layout==='mind'?'Mind map':'Structure diagram'} · ${document.recordCount} selected records · ${document.ai?'AI synthesis, review required':'Local organization'}`
        : `${document.layout==='mind'?'思维导图':'结构导图'} · ${document.recordCount} 条选中档案 · ${document.ai?'AI 归纳，待核对':'原文整理'}`
      const footer = document.en ? 'Cards contain summaries or excerpts. Dashed lines organize content; solid arrows show saved sources or premises. Check the full originals in Archive.'
        : '卡片为摘要或节选。虚线表示内容组织，实线箭头表示已存依据或前提；完整原文请在档案中核对。'
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${document.width}" height="${document.height}" viewBox="0 0 ${document.width} ${document.height}" role="img" aria-label="${esc(document.title)}" font-family="-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif"><title>${esc(document.title)}</title><desc>${esc(subtitle)}</desc><defs><marker id="dmd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="${palette.line}"/></marker></defs><rect width="100%" height="100%" fill="${palette.background}"/><rect x="18" y="18" width="${document.width-36}" height="${document.height-36}" rx="14" fill="none" stroke="${palette.frame}"/><text x="48" y="61" fill="${palette.text}" font-size="23" font-weight="600">${esc(graphLabel(document.title,60))}</text><text x="48" y="88" fill="${palette.muted}" font-size="12">${esc(subtitle)}</text>${lines}${cards}<text x="48" y="${document.height-42}" fill="${palette.muted}" font-size="11">${esc(footer)}</text></svg>`
    }

    function downloadDiagramBlob(blob, filename) {
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = filename
      document.body.append(anchor); anchor.click(); anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 10000)
    }

    async function diagramPng(svg, width, height) {
      const scale = Math.min(2, Math.sqrt(16000000 / (width * height)), 16300 / width, 16300 / height)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.floor(width * scale)); canvas.height = Math.max(1, Math.floor(height * scale))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas unavailable')
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
      try {
        const image = new Image()
        await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('SVG could not be rendered')); image.src = url })
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png'))
      } finally { URL.revokeObjectURL(url); canvas.width = 1; canvas.height = 1 }
    }

    const DIAGRAM_STYLES = `
      .dmd-backdrop { position: fixed; inset: 0; z-index: 2000; display: grid; place-items: center; padding: 20px; background: rgba(6,12,22,.55); backdrop-filter: blur(5px); }
      .dmd-dialog { width: min(1340px, 100%); height: min(880px, calc(100vh - 40px)); display: flex; flex-direction: column; min-width: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 18px; box-shadow: 0 24px 90px rgba(0,0,0,.32); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: 13px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif; overflow: hidden; }
      .dmd-head { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex: 0 0 auto; }
      .dmd-head h3 { margin: 0; font-size: 19px; }
      .dmd-head p { margin: 2px 0 0; color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .dmd-head > div:first-child { flex: 1; min-width: 0; }
      .dmd-close { font-size: 22px !important; line-height: 1; padding: 5px 10px !important; }
      .dmd-body { display: grid; grid-template-columns: 258px minmax(0, 1fr); min-height: 0; flex: 1; }
      .dmd-picker { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--dsw-alias-border-l1); }
      .dmd-picker-head { padding: 14px; display: flex; flex-direction: column; gap: 9px; }
      .dmd-picker-head b { font-size: 13px; }
      .dmd-input { box-sizing: border-box; min-width: 0; width: 100%; background: var(--dsw-alias-bg-base); color: inherit; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 7px 9px; font: inherit; outline: none; }
      .dmd-input:focus { border-color: var(--dsp-accent, #659ce8); }
      .dmd-picker-actions { display: flex; gap: 6px; align-items: center; }
      .dmd-picker-actions select { width: 90px; padding: 5px; font-size: 11px; }
      .dmd-records { flex: 1; overflow: auto; padding: 0 10px 12px; min-height: 0; }
      .dmd-choice { display: flex; align-items: flex-start; gap: 8px; padding: 10px 9px; border: 1px solid transparent; border-radius: 10px; cursor: pointer; margin-bottom: 5px; }
      .dmd-choice.on { background: var(--dsp-accent-soft, #659ce815); border-color: var(--dsp-accent-soft, #659ce82a); }
      .dmd-choice:hover { border-color: var(--dsp-accent, #659ce8); }
      .dmd-choice input { margin: 4px 0 0; accent-color: var(--dsp-accent, #659ce8); flex-shrink: 0; }
      .dmd-choice small { display: block; color: var(--dsw-alias-label-secondary); font-size: 10px; margin-bottom: 4px; }
      .dmd-choice span { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; font-size: 12px; overflow-wrap: anywhere; }
      .dmd-workspace { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
      .dmd-options { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .dmd-title-input { flex: 1; min-width: 150px; }
      .dmd-switch { display: inline-flex; gap: 3px; padding: 3px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; }
      .dmd-switch button { border: 0; }
      .dmd-settings { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 8px 14px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .dmd-settings label { display: inline-flex; gap: 5px; align-items: center; }
      .dmd-settings select { width: auto; padding: 3px 7px; font-size: 11px; }
      .dmd-stage { position: relative; flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 18px; background: #0c1118; }
      .dmd-stage.light { background: #e9eef5; }
      .dmd-artboard { margin: 0 auto; box-shadow: 0 8px 30px rgba(0,0,0,.2); }
      .dmd-artboard svg { display: block; width: 100%; height: 100%; }
      .dmd-empty { display: grid; place-content: center; min-height: 240px; color: #9babbf; text-align: center; }
      .dmd-bottom { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 9px 14px; border-top: 1px solid var(--dsw-alias-border-l1); flex-shrink: 0; }
      .dmd-bottom small { flex: 1; color: var(--dsw-alias-label-secondary); font-size: 10px; min-width: 160px; }
      .dmd-status { padding: 7px 14px; font-size: 11px; background: var(--dsp-accent-soft, #659ce815); flex-shrink: 0; }
      .dmd-status.error { color: var(--dsw-alias-state-error-primary); }
      .dmd-btn { white-space: nowrap; font-size: 12px; }
      .dmd-btn:disabled { opacity: .4; cursor: default; }
      @media (max-width: 760px) { .dmd-backdrop { padding: 8px; } .dmd-dialog { height: calc(100vh - 16px); } .dmd-body { grid-template-columns: minmax(150px, 30%) minmax(0, 1fr); } .dmd-head { padding: 12px; flex-wrap: wrap; } .dmd-options { padding: 8px; } .dmd-picker-head { padding: 10px; } }
      @media (max-width: 480px) { .dmd-body { display: flex; flex-direction: column; } .dmd-picker { flex: 0 0 180px; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l1); } .dmd-picker-head { padding: 6px 10px; gap: 4px; } .dmd-records { display: flex; gap: 5px; overflow-x: auto; } .dmd-choice { min-width: 180px; max-width: 180px; } .dmd-workspace { flex: 1; } }
    `

    function ArchiveDiagramDialog({ records, initialKind, en, onClose, theme, fontSize }) {
      const t = (zh, english) => en ? english : zh
      const initial = records.filter(record => record.kind === initialKind)
      const [selected, setSelected] = React.useState(() => new Set((initial.length ? initial : records).slice(0, 8).map(record => record.id)))
      const [filter, setFilter] = React.useState('')
      const [kind, setKind] = React.useState('all')
      const [layout, setLayout] = React.useState('structure')
      const [title, setTitle] = React.useState('')
      const [paper, setPaper] = React.useState('dark')
      const [includeSources, setIncludeSources] = React.useState(true)
      const [summary, setSummary] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [exporting, setExporting] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [zoom, setZoom] = React.useState(.5)
      const stageRef = React.useRef(null)
      const dialogRef = React.useRef(null)
      const requestRef = React.useRef(null)
      const aliveRef = React.useRef(true)
      const chosen = records.filter(record => selected.has(record.id))
      const signature = JSON.stringify(chosen.map(record => [record.id, record.text]))
      const chars = chosen.reduce((sum, record) => sum + record.text.length, 0)
      const activeSummary = summary?.signature === signature ? summary : null
      const actualTitle = title.trim() || activeSummary?.title || t('摘录与结论', 'Excerpts and conclusions')
      const diagram = React.useMemo(() => chosen.length ? buildArchiveDiagram(chosen, {
        layout, title: actualTitle, en, groups: activeSummary?.groups, ai: Boolean(activeSummary), includeSources,
      }) : null, [signature, layout, actualTitle, en, activeSummary, includeSources])
      const svg = React.useMemo(() => diagram ? archiveDiagramSvg(diagram, paper) : '', [diagram, paper])
      const visible = records.filter(record => (kind === 'all' || record.kind === kind) && record.text.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
      React.useEffect(() => {
        requestRef.current?.abort(); requestRef.current = null
        setBusy(false); setSummary(null); setError(''); setNotice('')
      }, [signature])
      React.useEffect(() => {
        const allowed = new Set(records.map(record => record.id))
        setSelected(old => [...old].every(id => allowed.has(id)) ? old : new Set([...old].filter(id => allowed.has(id))))
      }, [records])
      React.useEffect(() => {
        aliveRef.current = true
        const previous = document.activeElement
        const overflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        dialogRef.current?.querySelector('input')?.focus({ preventScroll: true })
        const keydown = event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
          if (event.key !== 'Tab') return
          const elements = [...(dialogRef.current?.querySelectorAll('button:not(:disabled), input, select') || [])].filter(element => element.getClientRects().length)
          const first = elements[0], last = elements[elements.length - 1]
          if (!first) return
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
        document.addEventListener('keydown', keydown, true)
        return () => {
          aliveRef.current = false; requestRef.current?.abort()
          document.removeEventListener('keydown', keydown, true)
          document.body.style.overflow = overflow
          if (previous?.isConnected) previous.focus({ preventScroll: true })
        }
      }, [])
      const toggle = id => {
        setError('')
        setSelected(old => {
          const next = new Set(old)
          if (next.has(id)) next.delete(id)
          else if (next.size < DIAGRAM_MAX_RECORDS) next.add(id)
          else { setError(t('一次最多选择 20 条，请先减少一些内容。', 'Select up to 20 records at a time.')); return old }
          return next
        })
      }
      const fit = all => {
        if (!diagram || !stageRef.current) return
        const width = (stageRef.current.clientWidth - 40) / diagram.width
        const height = (stageRef.current.clientHeight - 40) / diagram.height
        setZoom(Math.max(.08, Math.min(1, all ? Math.min(width, height) : width)))
      }
      React.useEffect(() => { fit(false) }, [layout, diagram?.width])
      const summarize = async () => {
        if (!chosen.length || busy) return
        if (chars > DIAGRAM_MAX_CHARS) { setError(t('所选正文超过 24,000 字，请减少条目后再使用 AI 总结。', 'Reduce the selection to 24,000 characters before AI synthesis.')); return }
        const controller = new AbortController()
        requestRef.current?.abort(); requestRef.current = controller
        setBusy(true); setError(''); setNotice('')
        try {
          const response = await fetch(DIAGRAM_ROUTE, { method: 'POST', credentials: 'same-origin', signal: controller.signal,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ records: chosen.map(record => ({ id: record.id, kind: record.kind, text: record.text })), title: actualTitle, language: en ? 'en' : 'zh' }) })
          const data = await response.json()
          if (controller.signal.aborted || requestRef.current !== controller || !aliveRef.current) return
          if (!response.ok || !data?.ok) throw new Error(en ? data?.messageEn || 'AI synthesis is unavailable. The original diagram can still be used.' : data?.message || 'AI 整理未完成，仍可使用原文导图。')
          const groups = checkedDiagramGroups(data.groups, chosen)
          setSummary({ signature, title: String(data.title || actualTitle).slice(0,100), groups })
          setNotice(t('AI 归纳已生成，请核对摘要与来源后导出。', 'AI synthesis is ready. Review the summaries and sources before exporting.'))
        } catch (cause) {
          if (!controller.signal.aborted && requestRef.current === controller && aliveRef.current) setError(cause instanceof Error ? cause.message : t('AI 总结失败。', 'AI synthesis failed.'))
        } finally { if (requestRef.current === controller && aliveRef.current) { requestRef.current = null; setBusy(false) } }
      }
      const cancel = () => { requestRef.current?.abort(); requestRef.current = null; setBusy(false); setNotice(t('已取消 AI 总结，保留当前导图。', 'AI synthesis cancelled. Your current diagram is preserved.')) }
      const exportImage = async format => {
        if (!diagram || busy || exporting) return
        setExporting(true); setError('')
        try {
          const blob = format === 'svg' ? new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }) : await diagramPng(svg, diagram.width, diagram.height)
          if (!aliveRef.current) return
          const filename = actualTitle.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0,60) || 'dsh-diagram'
          downloadDiagramBlob(blob, `${filename}-${layout === 'mind' ? 'mind-map' : 'structure'}.${format}`)
          setNotice(t(`${format.toUpperCase()} 已导出。`, `${format.toUpperCase()} exported.`))
        } catch { if (aliveRef.current) setError(t('图片导出失败，请重试或先导出 SVG。', 'Image export failed. Retry or export SVG.')) }
        finally { if (aliveRef.current) setExporting(false) }
      }
      const button = (label, onClick, disabled = false, extra = {}) => h('button', { type: 'button', className: 'dpl-btn dmd-btn', onClick, disabled, ...extra }, label)
      return createPortal(h('div', { className: 'dmd-backdrop', style: { ...themeVars(theme), ...fontVars(fontSize) } },
        h('style', null, LEDGER_STYLES + DIAGRAM_STYLES),
        h('section', { className: 'dmd-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t('导图工作台', 'Diagram workspace'), ref: dialogRef },
          h('header', { className: 'dmd-head' },
            h('div', null, h('h3', null, t('导图工作台', 'Diagram workspace')), h('p', null, t('选好材料，整理成图，预览后再导出。', 'Select records, organize a diagram, then preview and export.'))),
            button(t('导出 SVG', 'Export SVG'), () => exportImage('svg'), !diagram || busy || exporting),
            button(exporting ? t('正在导出…', 'Exporting…') : t('导出 PNG', 'Export PNG'), () => exportImage('png'), !diagram || busy || exporting),
            button('×', onClose, false, { className: 'dpl-btn dmd-close danger', 'aria-label': t('关闭导图', 'Close diagram') })),
          h('div', { className: 'dmd-body' },
            h('aside', { className: 'dmd-picker' },
              h('div', { className: 'dmd-picker-head' }, h('b', null, t(`选择材料 · ${chosen.length}/20`, `Select records · ${chosen.length}/20`)),
                h('input', { className: 'dmd-input', value: filter, onChange: event => setFilter(event.target.value), placeholder: t('查找摘录或结论…', 'Find excerpts or conclusions…'), 'aria-label': t('筛选导图材料', 'Filter diagram records') }),
                h('div', { className: 'dmd-picker-actions' },
                  h('select', { className: 'dmd-input', value: kind, onChange: event => setKind(event.target.value), 'aria-label': t('材料类型', 'Record type') },
                    h('option', { value: 'all' }, t('全部', 'All')), h('option', { value: 'note' }, t('摘录', 'Excerpts')), h('option', { value: 'decision' }, t('结论', 'Conclusions'))),
                  button(visible.length > 20 ? t('选前20条', 'First 20') : t('全选', 'Select all'), () => setSelected(new Set(visible.slice(0,20).map(record => record.id)))),
                  button(t('清空', 'Clear'), () => setSelected(new Set())))),
              h('div', { className: 'dmd-records' }, ...visible.map(record => h('label', { className: 'dmd-choice' + (selected.has(record.id) ? ' on' : ''), key: record.id },
                h('input', { type: 'checkbox', checked: selected.has(record.id), onChange: () => toggle(record.id), 'aria-label': `${record.kind === 'note' ? t('摘录', 'Excerpt') : t('结论', 'Conclusion')}：${record.text}` }),
                h('div', null, h('small', null, `${record.kind === 'note' ? t('摘录', 'Excerpt') : t('结论', 'Conclusion')} · ${compactDate(record.item.createdAt, en)}`), h('span', null, record.text)))))),
            h('main', { className: 'dmd-workspace' },
              h('div', { className: 'dmd-options' },
                h('input', { className: 'dmd-input dmd-title-input', value: title, maxLength: 100, onChange: event => setTitle(event.target.value), placeholder: actualTitle, 'aria-label': t('导图标题', 'Diagram title') }),
                h('div', { className: 'dmd-switch', 'aria-label': t('导图类型', 'Diagram type') },
                  ...[['mind', t('思维导图', 'Mind map')], ['structure', t('结构导图', 'Structure')]].map(([id,label]) => button(label, () => setLayout(id), false, { key: id, className: 'dpl-btn dmd-btn' + (layout===id?' active':''), 'aria-pressed': layout===id }))),
                busy ? button(t('取消总结', 'Cancel synthesis'), cancel, false, { className: 'dpl-btn dmd-btn danger' }) : button(t('AI 总结', 'AI synthesis'), summarize, !chosen.length, { title: t('仅将所选正文交给当前模型整理，可能产生模型用量', 'Send only selected text to the current model; model usage may apply') })),
              h('div', { className: 'dmd-settings' },
                h('span', null, activeSummary ? t('AI 归纳 · 待核对', 'AI synthesis · review') : t('原文整理 · 不调用模型', 'Local organization · no model call')),
                activeSummary ? button(t('恢复原文整理', 'Use original text'), () => setSummary(null)) : null,
                h('label', { title: t('每条结论最多显示 2 条已存依据和 2 条假设；完整内容保留在档案中', 'Up to 2 saved sources and 2 premises per conclusion; full records remain in Archive') }, h('input', { type: 'checkbox', checked: includeSources, onChange: event => setIncludeSources(event.target.checked) }), t('附带已存依据与假设', 'Include saved sources and premises')),
                h('select', { className: 'dmd-input', value: paper, onChange: event => setPaper(event.target.value), 'aria-label': t('导图配色', 'Diagram colors') }, h('option', { value: 'dark' }, t('深色', 'Dark')), h('option', { value: 'light' }, t('浅色', 'Light')))),
              h('div', { className: 'dmd-stage' + (paper==='light'?' light':''), ref: stageRef, 'aria-label': t('导图在线预览', 'Live diagram preview') },
                diagram ? h('div', { className: 'dmd-artboard', style: { width: `${diagram.width * zoom}px`, height: `${diagram.height * zoom}px` }, dangerouslySetInnerHTML: { __html: svg } })
                  : h('div', { className: 'dmd-empty' }, t('从左侧选择摘录或结论，导图会在这里出现。', 'Select excerpts or conclusions to preview a diagram.'))),
              h('div', { className: 'dmd-bottom' },
                button('−', () => setZoom(value => Math.max(.08,value / 1.2)), !diagram, { 'aria-label': t('缩小导图', 'Zoom out diagram') }),
                h('span', null, `${Math.round(zoom*100)}%`),
                button('+', () => setZoom(value => Math.min(2,value * 1.2)), !diagram, { 'aria-label': t('放大导图', 'Zoom in diagram') }),
                button(t('适应宽度', 'Fit width'), () => fit(false), !diagram), button(t('查看全图', 'Fit all'), () => fit(true), !diagram),
                h('small', null, t(`已选 ${chosen.length} 条 · ${chars.toLocaleString()} 字。默认最近 8 条，可自行调整；卡片为摘要或节选。`, `${chosen.length} records · ${chars.toLocaleString()} characters. Starts with the latest 8; adjust the selection. Cards contain summaries or excerpts.`))))),
          busy || error || notice ? h('div', { className: 'dmd-status' + (error?' error':''), role: 'status' }, busy ? t('正在根据所选内容整理导图…可随时取消。', 'Organizing selected records… You can cancel anytime.') : error || notice) : null)), document.body)
    }

    function createLedger(ctx) {
      return function LedgerView(props) {
        const ledger = useLedger()
        const en = isEnglish(ctx)
        const t = (zh, english) => (en ? english : zh)
        const theme = useTheme()
        const fontSize = useFontSize()
        const sessionId = props.sessionId
        React.useEffect(() => {
          sessionStore.set(sessionId)
        }, [sessionId])
        const [scope, setScope] = React.useState('session')
        const [section, setSection] = React.useState('decisions')
        const [query, setQuery] = React.useState('')
        const [expanded, setExpanded] = React.useState(null)
        const [archiveNotice, setArchiveNotice] = React.useState('')
        const [graphFocus, setGraphFocus] = React.useState(null)
        const [diagramOpen, setDiagramOpen] = React.useState(false)
        const archiveRootRef = React.useRef(null)

        React.useEffect(() => {
          const applyFocus = () => {
            if (ledgerFocus.sessionId !== sessionId) return
            const focus = ledgerFocus.value
            if (!focus) return
            ledgerFocus.value = null
            setScope('session')
            setQuery('')
            if (String(focus).startsWith('decision:')) {
              setSection('decisions')
              setExpanded(String(focus).slice('decision:'.length))
            } else if (focus === 'section:assumptions' || focus === 'section:trash') {
              setSection(String(focus).slice('section:'.length))
            }
          }
          applyFocus()
          window.addEventListener(LEDGER_FOCUS_EVENT, applyFocus)
          return () => window.removeEventListener(LEDGER_FOCUS_EVENT, applyFocus)
        }, [sessionId])

        React.useEffect(() => {
          const request = props.viewRequest
          if (!request || !request.focus) return
          if (String(request.focus).startsWith('decision:')) {
            setSection('decisions')
            setExpanded(String(request.focus).slice('decision:'.length))
          } else if (request.focus === 'section:assumptions' || request.focus === 'section:trash') {
            setSection(String(request.focus).slice('section:'.length))
          }
          props.completeViewRequest?.()
        }, [props.viewRequest])

        const inScope = (item) => scope === 'all' || item.sessionId === sessionId
        const needle = query.trim().toLowerCase()
        const decisions = ledger.decisions.filter((item) =>
          inScope(item) &&
          (!needle ||
            String(item.claim || '').toLowerCase().includes(needle) ||
            (item.atoms || []).some((atom) => String(atom.text || '').toLowerCase().includes(needle))))
        const assumptions = ledger.assumptions.filter((item) =>
          inScope(item) &&
          (!needle ||
            String(item.text || '').toLowerCase().includes(needle) ||
            String(item.sourceClaim || '').toLowerCase().includes(needle)))
        const notes = ledger.notes.filter((item) =>
          inScope(item) &&
          (!needle || String(item.text || '').toLowerCase().includes(needle)))
        const trash = ledger.trash.filter(entry => inScope(entry.item) && (!needle ||
          [entry.item.text, entry.item.claim, entry.item.sourceClaim,
            ...(entry.item.atoms || []).map(atom => atom.text)].join('\n').toLowerCase().includes(needle)))
        const openCount = assumptions.filter((item) => item.status === 'open').length
        const confirmedCount = assumptions.filter((item) => item.status === 'confirmed').length
        const graph = React.useMemo(() => buildArchiveGraph({ decisions, assumptions, notes }), [ledger, scope, sessionId, query])
        const diagramRecords = React.useMemo(() => [
          ...decisions.filter(item => item.status !== 'revoked').map(item => ({ id: `decision:${item.id}`, kind: 'decision', text: String(item.claim || ''), item })),
          ...notes.map(item => ({ id: `note:${item.id}`, kind: 'note', text: String(item.text || ''), item })),
        ].filter(record => record.text.trim()).sort((a,b) => (Number(b.item.createdAt)||0) - (Number(a.item.createdAt)||0)), [ledger, scope, sessionId, query])
        const revealGraphRecord = record => {
          setSection(record.kind === 'decision' ? 'decisions' : record.kind === 'assumption' ? 'assumptions' : 'notes')
          if (record.kind === 'decision') setExpanded(record.item.id)
          setGraphFocus(record.id)
        }
        React.useEffect(() => {
          if (!graphFocus) return undefined
          const frame = window.requestAnimationFrame(() => {
            const target = [...(archiveRootRef.current?.querySelectorAll('[data-archive-id]') || [])]
              .find(element => element.getAttribute('data-archive-id') === graphFocus)
            if (!target) return
            target.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
            target.focus({ preventScroll: true })
          })
          return () => window.cancelAnimationFrame(frame)
        }, [graphFocus, section])

        const setStatus = (id, status) =>
          ledgerStore.update((current) => ({
            ...current,
            assumptions: current.assumptions.map((item) =>
              item.id === id ? { ...item, status } : item),
          }))

        const toggleDecision = (id) =>
          ledgerStore.update((current) => ({
            ...current,
            decisions: current.decisions.map((item) =>
              item.id === id
                ? { ...item, status: item.status === 'revoked' ? 'active' : 'revoked' }
                : item),
          }))

        const removeDecision = id => setArchiveNotice(recycleNotice(recycleLedgerItem('decisions', id), t))
        const restoreItem = id => setArchiveNotice(recycleNotice(restoreLedgerItem(id), t))

        const exportLedger = () => {
          try {
            const blob = new Blob([JSON.stringify(ledger, null, 2)], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = 'dsh-provenance-archive.json'
            anchor.click()
            URL.revokeObjectURL(url)
          } catch {
            // A blocked download changes nothing in the stored archive.
          }
        }

        const exportMarkdown = () => {
          const lines = ['# 对话溯源档案', '']
          if (notes.length > 0) {
            lines.push('## 重点摘录', '')
            for (const note of [...notes].sort((a, b) => a.createdAt - b.createdAt)) {
              const meta = [
                new Date(note.createdAt).toLocaleString(),
                note.role ? `${roleLabel(note.role, t)} #${note.seq}` : '',
              ].filter(Boolean).join(' · ')
              lines.push(`- **${meta}**`)
              for (const line of String(note.text || '').split('\n')) {
                lines.push(`  > ${line}`)
              }
            }
            lines.push('')
          }
          if (decisions.length > 0) {
            lines.push('## 结论', '')
            for (const decision of decisions) {
              lines.push(`### ${decision.claim}`)
              lines.push(`- ${new Date(decision.createdAt).toLocaleString()} · ${decision.status}`)
              for (const atom of orderAtoms(decision.atoms)) {
                for (const item of atom.evidence || []) {
                  lines.push(`  - [${item.role} #${item.seq}] 「${item.quote}」`)
                }
              }
              if ((decision.assumptions || []).length > 0) {
                lines.push(`- 假设：${decision.assumptions.join('；')}`)
              }
              lines.push('')
            }
          }
          if (assumptions.length > 0) {
            lines.push('## 假设', '')
            for (const item of assumptions) {
              lines.push(`- [${item.status}] ${item.text}`)
            }
            lines.push('')
          }
          try {
            const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
            const url = URL.createObjectURL(blob)
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = 'dsh-provenance-archive.md'
            anchor.click()
            URL.revokeObjectURL(url)
          } catch {
            // A blocked download changes nothing in the archive.
          }
        }

        const header = h('div', { className: 'dpl-head' },
          h('div', null,
            h('div', { className: 'dpl-title' }, t('档案', 'Archive')),
            h('div', { className: 'dpl-sub' },
              t('存档的结论、待确认的假设、摘录的重点，都留在这里。',
                'Archived conclusions, open assumptions, and saved notes live here.')),
          ),
          h('div', { className: 'dpl-seg' },
            h('button', {
              type: 'button',
              className: scope === 'session' ? 'on' : '',
              onClick: () => setScope('session'),
            }, t('当前会话', 'This session')),
            h('button', {
              type: 'button',
              className: scope === 'all' ? 'on' : '',
              onClick: () => setScope('all'),
            }, t('全部会话', 'All sessions')),
          ),
          h('input', {
            className: 'dpl-search',
            placeholder: t('搜索结论、假设、依据…', 'Search decisions, assumptions, evidence…'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h(SettingsMenu, { key: 'settings' }),
          ['notes', 'decisions'].includes(section) ? h('button', { className: 'dpl-btn', type: 'button', disabled: !diagramRecords.length,
            onClick: () => setDiagramOpen(true), title: t('选择摘录和结论，预览并导出思维导图或结构导图', 'Select excerpts and conclusions to preview and export a diagram') }, t('生成导图', 'Create diagram')) : null,
          h('button', { className: 'dpl-btn', type: 'button', onClick: exportMarkdown },
            t('导出 MD', 'Export MD')),
          h('button', { className: 'dpl-btn', type: 'button', onClick: exportLedger },
            t('导出 JSON', 'Export JSON')),
        )

        const stats = h('div', { className: 'dpl-stats' },
          h('span', null, h('b', null, String(decisions.length)), t('结论', 'conclusions')),
          h('span', null, h('b', null, String(openCount)), t('待确认假设', 'open assumptions')),
          h('span', null, h('b', null, String(confirmedCount)), t('已确认', 'confirmed')),
          h('span', null, h('b', null, String(notes.length)), t('摘录', 'notes')),
        )

        const tabs = h('div', { className: 'dpl-tabs' },
          h('button', {
            type: 'button',
            className: 'dpl-btn' + (section === 'decisions' ? ' active' : ''),
            onClick: () => setSection('decisions'),
          }, t('结论', 'Conclusions')),
          h('button', {
            type: 'button',
            className: 'dpl-btn' + (section === 'assumptions' ? ' active' : ''),
            onClick: () => setSection('assumptions'),
          }, t('假设', 'Assumptions')),
          h('button', {
            type: 'button',
            className: 'dpl-btn' + (section === 'notes' ? ' active' : ''),
            onClick: () => setSection('notes'),
          }, t('摘录', 'Notes')),
          h('button', {
            type: 'button', className: 'dpl-btn' + (section === 'trash' ? ' active' : ''),
            onClick: () => setSection('trash'),
          }, `${t('回收站', 'Recycle bin')} · ${ledger.trash.filter(entry => inScope(entry.item)).length}`),
        )

        const renderDecision = (decision) => {
          const isOpen = expanded === decision.id
          const evidenceCount = (decision.atoms || []).reduce(
            (sum, atom) => sum + (atom.evidence ? atom.evidence.length : 0), 0)
          const rows = []
          for (const atom of orderAtoms(decision.atoms)) {
            rows.push(
              h('div', { key: `a-${rows.length}`, className: 'dpl-ev-atom' },
                h('span', { className: 'dpl-ev-role' }, relationLabel(atom.relation, t)),
                atom.text,
              ),
            )
            for (const item of atom.evidence || []) {
              rows.push(
                h('div', { key: `e-${rows.length}`, className: 'dpl-ev-row' },
                  h('span', { className: 'dpl-ev-role', title: `#${item.seq}${item.turn ? ` · ${item.turn}` : ''}` },
                    roleLabel(item.role, t)),
                  h(EvidenceQuote, { text: item.quote, en }),
                  item.url
                    ? h('a', {
                        href: item.url,
                        target: '_blank',
                        rel: 'noreferrer noopener',
                        style: { marginLeft: '6px' },
                      }, '↗')
                    : null,
                ),
              )
            }
            if (atom.note) {
              rows.push(h('div', { key: `n-${rows.length}`, className: 'dpl-meta' }, atom.note))
            }
          }
          return h('div', {
            key: decision.id,
            className: 'dpl-card' + (decision.status === 'revoked' ? ' revoked' : ''),
            'data-archive-id': `decision:${decision.id}`, 'data-graph-focus': graphFocus === `decision:${decision.id}`, tabIndex: -1,
          },
            h(CollapsibleText, { text: decision.claim, en, variant: 'record', className: 'dpl-claim',
              metadata: h('div', { className: 'dpl-meta' },
                h(CompactMeta, { time: decision.createdAt, seq: decision.claimSeq, sessionId: decision.sessionId, en }),
                h('span', null, `${evidenceCount} ${t('条依据', 'sources')}`),
                decision.status === 'revoked' ? h('span', null, t('已撤销', 'revoked')) : null,
              ),
            }),
            (decision.assumptions || []).length > 0
              ? h(CollapsibleText, { text: decision.assumptions.join('\n'), en, variant: 'record', className: 'dpl-asm-src' })
              : null,
            h('div', { className: 'dpl-actions' },
              h('button', {
                className: 'dpl-btn',
                type: 'button',
                onClick: () => setExpanded(isOpen ? null : decision.id),
              }, isOpen ? t('收起依据', 'Collapse') : t('展开依据', 'Evidence')),
              h('button', {
                className: 'dpl-btn',
                type: 'button',
                onClick: () => toggleDecision(decision.id),
              }, decision.status === 'revoked' ? t('恢复', 'Restore') : t('撤销', 'Revoke')),
              h('button', {
                className: 'dpl-btn danger',
                type: 'button',
                onClick: () => removeDecision(decision.id),
              }, t('删除', 'Delete')),
            ),
            isOpen ? h('div', { className: 'dpl-ev' }, ...rows) : null,
          )
        }

        const renderAssumption = (item) => h('div', { key: item.id, className: 'dpl-asm-row',
          'data-archive-id': `assumption:${item.id}`, 'data-graph-focus': graphFocus === `assumption:${item.id}`, tabIndex: -1 },
          h('div', { className: 'dpl-asm-text' },
            h(CollapsibleText, { text: item.text, en, variant: 'record' }),
            item.sourceClaim
              ? h(CollapsibleText, { text: t('来自：', 'From: ') + item.sourceClaim, en, variant: 'record', className: 'dpl-asm-src' })
              : null,
          ),
          h('div', { className: 'dpl-actions', style: { marginTop: 0 } },
            ...[
              ['open', t('待确认', 'Open')],
              ['confirmed', t('确认', 'Confirm')],
              ['rejected', t('否决', 'Reject')],
            ].map(([value, label]) =>
              h('button', {
                key: value,
                className: 'dpl-btn' + (item.status === value ? ' active' : ''),
                type: 'button',
                onClick: () => setStatus(item.id, value),
              }, label)),
          ),
        )

        const removeNote = id => setArchiveNotice(recycleNotice(recycleLedgerItem('notes', id), t))

        const renderNote = (note) => h('div', { key: note.id, className: 'dpl-card',
          'data-archive-id': `note:${note.id}`, 'data-graph-focus': graphFocus === `note:${note.id}`, tabIndex: -1 },
          h(CollapsibleText, { text: note.text, en, variant: 'record', className: 'dpl-note',
            metadata: h('div', { className: 'dpl-meta' },
              h(CompactMeta, { time: note.createdAt, role: note.role, seq: note.seq, sessionId: note.sessionId, en }),
            ),
          }),
          h('div', { className: 'dpl-actions' },
            h('button', {
              className: 'dpl-btn',
              type: 'button',
              'data-dsp-jump': '',
              title: t('跳到这句原文', 'Jump to the source'),
              onClick: () => {
                const quote = noteJumpText(note)
                window.dispatchEvent(new CustomEvent(JUMP_EVENT, {
                  detail: { quote, seq: note.seq, sessionId: note.sessionId },
                }))
              },
            }, t('跳转原文', 'Jump')),
            h('button', {
              className: 'dpl-btn danger',
              type: 'button',
              onClick: () => removeNote(note.id),
            }, t('删除', 'Delete')),
          ),
        )

        const content = section === 'trash'
          ? h(RecycleBin, { entries: trash, en, archive: true, onRestore: restoreItem })
          : section === 'decisions'
          ? (decisions.length === 0
              ? h('div', { className: 'dpl-empty' },
                  t('还没有结论。在任意回答上框选一句，点「存档这条结论」。',
                    'No decisions yet. Select a sentence, trace it, then pin it.'))
              : h('div', { className: 'dpl-section' }, ...decisions.map(renderDecision)))
          : section === 'assumptions'
            ? (assumptions.length === 0
                ? h('div', { className: 'dpl-empty' },
                    t('还没有假设。溯源时模型会列出结论依赖、但对话没有证实的前提。',
                      'No assumptions yet. A trace lists premises the answer relies on but never established.'))
                : h('div', { className: 'dpl-section' }, ...assumptions.map(renderAssumption)))
            : (notes.length === 0
                ? h('div', { className: 'dpl-empty' },
                    t('还没有摘录。框选一句话，点「存为笔记」。',
                      'No notes yet. Select a passage and choose “Save as note”.'))
                : h('div', { className: 'dpl-section' }, ...notes.map(renderNote)))

        return h('div', { className: 'dpl-root', ref: archiveRootRef, style: { ...themeVars(theme), ...fontVars(fontSize) } },
          h('style', null, LEDGER_STYLES + GRAPH_STYLES),
          header,
          stats,
          tabs,
          archiveNotice ? h('div', { className: 'dpl-notice', role: 'status' }, archiveNotice) : null,
          h('div', { className: 'dpl-record-area' }, content),
          section !== 'trash' ? h(ArchiveGraphDock, { graph, en, onReveal: revealGraphRecord, archiveRootRef }) : null,
          diagramOpen ? h(ArchiveDiagramDialog, { records: diagramRecords, initialKind: section === 'notes' ? 'note' : 'decision', en, theme, fontSize,
            onClose: () => setDiagramOpen(false) }) : null,
        )
      }
    }

    /** Moving surfaces run through their exit fade and stop once invisible. */
    function MotionSurface({ active, className, children }) {
      const surfaceRef = React.useRef(null)
      const [running, setRunning] = React.useState(active)
      React.useLayoutEffect(() => {
        const surface = surfaceRef.current
        if (!surface) return undefined
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        if (reduced || typeof surface.animate !== 'function') {
          surface.style.opacity = active ? '1' : '0'
          setRunning(false)
          return undefined
        }
        const opacity = getComputedStyle(surface).opacity
        if (!active && Number(opacity) === 0) { setRunning(false); return undefined }
        if (active) setRunning(true)
        let cancelled = false
        const animation = surface.animate([{ opacity }, { opacity: active ? 1 : 0 }], {
          duration: active ? 720 : 900, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'both',
        })
        void animation.finished.then(() => {
          if (cancelled) return
          surface.style.opacity = active ? '1' : '0'
          animation.cancel()
          if (!active) setRunning(false)
        }).catch(() => {})
        return () => {
          cancelled = true
          surface.style.opacity = getComputedStyle(surface).opacity
          animation.cancel()
        }
      }, [active])
      return h('span', { className: className + (running ? ' moving' : ''), ref: surfaceRef, 'aria-hidden': 'true' }, children)
    }

    function LoadingSpinner() {
      return h('svg', { className: 'dsp-spin', width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('circle', { className: 'dsp-spin-track', cx: 8, cy: 8, r: 6, strokeWidth: 2 }),
        h('circle', { className: 'dsp-spin-arc', cx: 8, cy: 8, r: 6, strokeWidth: 2, strokeLinecap: 'round', strokeDasharray: '11 27' }),
      )
    }

    function AnalysisAtmosphere({ active }) {
      const wave = 'M0 120 C200 75 400 75 600 120 S1000 165 1200 120 C1400 75 1600 75 1800 120 S2200 165 2400 120 V240 H0Z'
      return h(MotionSurface, { active, className: 'dsp-thinking' },
        ...['back', 'front'].map(layer => h('svg', { key: layer, className: `dsp-thinking-wave ${layer}`, viewBox: '0 0 2400 240', preserveAspectRatio: 'none', focusable: 'false' },
          h('path', { d: wave, fill: 'currentColor' }))),
        ...[9, 24, 39, 54, 69, 84, 17, 46, 76].map((left, index) => h('span', { key: left, className: 'dsp-thinking-bubble', style: {
          '--bubble-x': `${left}%`, '--bubble-size': `${4 + index % 4 * 1.5}px`,
          '--bubble-duration': `${6.5 + index % 4 * .8}s`, '--bubble-delay': `${-index * 1.1}s`,
          '--bubble-drift': `${index % 2 ? 12 : -9}px`,
        } })),
      )
    }

    /** Use the resident viewport, not a slot wrapper (which may be display:contents). */
    function conversationFrameRegion(sessionId) {
      const native = [...document.querySelectorAll('[data-conversation-content][data-conversation-region="chat"]')]
      const candidates = [
        ...native.filter(node => node.getAttribute('data-conversation-session') === sessionId),
        ...native,
        ...document.querySelectorAll('[data-conversation-scroll], [data-slot="conversation.session"], [data-slot="conversation.chat.flow"], main'),
      ]
      for (const element of new Set(candidates)) {
        const rect = element.getBoundingClientRect()
        if (rect.width < 40 || rect.height < 40 || getComputedStyle(element).visibility === 'hidden') continue
        const left = Math.max(0, Math.round(rect.left)), top = Math.max(0, Math.round(rect.top))
        const right = Math.min(window.innerWidth, Math.round(rect.right)), bottom = Math.min(window.innerHeight, Math.round(rect.bottom))
        if (right - left < 40 || bottom - top < 40) continue
        return { host: element, rect: { left, top, width: right - left, height: bottom - top } }
      }
      return null
    }

    function TraceFrame({ active, rect, host }) {
      React.useLayoutEffect(() => {
        if (!host) return undefined
        const hadIsolation = host.classList.contains('dsp-atmosphere-host')
        const hadPosition = host.classList.contains('dsp-atmosphere-static-host')
        const needsPosition = getComputedStyle(host).position === 'static'
        host.classList.add('dsp-atmosphere-host')
        if (needsPosition) host.classList.add('dsp-atmosphere-static-host')
        return () => {
          if (!hadIsolation) host.classList.remove('dsp-atmosphere-host')
          if (needsPosition && !hadPosition) host.classList.remove('dsp-atmosphere-static-host')
        }
      }, [host])
      const wave = 'M0 120 C200 75 400 75 600 120 S1000 165 1200 120 C1400 75 1600 75 1800 120 S2200 165 2400 120 V240 H0Z'
      return h(React.Fragment, null,
        h('div', { className: 'dsp-frame' + (active ? ' visible' : ' leaving'), style: rect, 'aria-hidden': 'true' },
          h(PerimeterOrbit, { active, frame: true }),
        ),
        host ? createPortal(h(MotionSurface, { active, className: 'dsp-frame-atmosphere' },
          ...['back', 'front'].map(layer => h('svg', { key: layer, className: `dsp-wave dsp-wave-${layer}`, viewBox: '0 0 2400 240', preserveAspectRatio: 'none', focusable: 'false' },
            h('path', { d: wave, fill: 'currentColor' }),
          )),
        ), host, 'dsp-background') : null,
      )
    }

    /** A finite perimeter pass, independent of the result panel's lifetime. */
    function PerimeterOrbit({ active, frame = false }) {
      const svgRef = React.useRef(null)
      const previous = React.useRef(false)
      const [size, setSize] = React.useState({ width: 64, height: 28 })

      React.useLayoutEffect(() => {
        const button = svgRef.current?.parentElement
        if (!button) return undefined
        const measure = () => {
          const rect = button.getBoundingClientRect()
          const width = Math.max(20, rect.width)
          const height = Math.max(20, rect.height)
          setSize(current => current.width === width && current.height === height ? current : { width, height })
        }
        measure()
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        observer?.observe(button)
        window.addEventListener('resize', measure)
        return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
      }, [])

      React.useLayoutEffect(() => {
        if (previous.current === active) return undefined
        previous.current = active
        const svg = svgRef.current
        if (!svg || typeof svg.animate !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined
        // One lap in 400 ms, then an 80 ms fade at the upper-left starting point.
        // Both finish before the button's 720/900 ms appearance transitions.
        const timing = { duration: 480, easing: 'linear', fill: 'both' }
        const animations = [svg.animate([
          { opacity: 0, offset: 0 }, { opacity: 1, offset: .08 },
          { opacity: 1, offset: 5 / 6 }, { opacity: 0, offset: 1 },
        ], timing)]
        for (const path of svg.querySelectorAll('path')) {
          const length = Number(path.getAttribute('data-segment'))
          animations.push(path.animate([
            { strokeDashoffset: length, offset: 0 },
            { strokeDashoffset: length - 100, offset: 5 / 6 },
            { strokeDashoffset: length - 100, offset: 1 },
          ], timing))
        }
        // Cancel superseded passes on rapid toggles and release finished effects.
        void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
          for (const animation of animations) animation.cancel()
        })
        return () => { for (const animation of animations) animation.cancel() }
      }, [active])

      const { width: w, height: hgt } = size
      const r = Math.min(frame ? 15 : 7, (w - 2) / 2, (hgt - 2) / 2)
      const right = w - 1, bottom = hgt - 1
      // Start at the upper-left tangent, then top → right → bottom → left.
      const d = `M ${1 + r} 1 H ${right - r} A ${r} ${r} 0 0 1 ${right} ${1 + r} V ${bottom - r} A ${r} ${r} 0 0 1 ${right - r} ${bottom} H ${1 + r} A ${r} ${r} 0 0 1 1 ${bottom - r} V ${1 + r} A ${r} ${r} 0 0 1 ${1 + r} 1 Z`
      return h('svg', { className: frame ? 'dsp-frame-orbit' : 'dsp-trigger-orbit', ref: svgRef, viewBox: `0 0 ${w} ${hgt}`, 'aria-hidden': 'true', focusable: 'false' },
        ...(frame ? [['halo', 9], ['tail', 6], ['head', 1.2]] : [['halo', 18], ['tail', 12], ['head', 3]]).map(([name, length]) => h('path', {
          key: name, className: `dsp-orbit-${name}`, d, pathLength: 100,
          strokeDasharray: `${length} ${100 - length}`, 'data-segment': length,
        })),
      )
    }

    function createTrigger(ctx) {
      return function ProvenanceTrigger(props) {
        const sessionId = props.sessionId
        React.useEffect(() => {
          // Do not clear on unmount: switching to the Archive view unmounts the
          // composer, and the floating panel still needs the session id.
          sessionStore.set(sessionId)
        }, [sessionId])

        const en = isEnglish(ctx)
        const tracing = useTraceMode()
        return h('div', { className: 'dsp-trigger-wrap' },
          h('style', null, STYLES),
          h('button', {
            className: 'dsp-trigger' + (tracing ? ' active' : ''),
            type: 'button',
            title: en ? 'Trace where this answer came from (⌘⌥T)' : '溯源这句话的依据（⌘⌥T）',
            'aria-label': en ? 'Trace provenance' : '溯源',
            'aria-pressed': tracing,
            onClick: () => window.dispatchEvent(new CustomEvent(ARM_EVENT)),
          }, h(MotionSurface, { active: tracing, className: 'dsp-trigger-fill' }),
            h('span', { className: 'dsp-trigger-label' }, '⌕', h('span', null, en ? 'Trace' : '溯源')),
            h(PerimeterOrbit, { active: tracing })),

        )
      }
    }

    const blankPanelQueries = () => ({ trace: '', notes: '', decisions: '', assumptions: '' })
    const emptySearch = () => ({ status: 'idle', query: '', sessionId: null, hits: [], total: 0, offset: 0, hasMore: false, selected: -1 })
    const searchText = value => String(value || '').replace(/\s+/g, ' ').trim()
    function literalSearchPattern(query, flags = 'iu') {
      const pattern = searchText(query).split(' ').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
      return pattern ? new RegExp(pattern, flags) : null
    }
    function markedSearchText(text, query) {
      const matcher = literalSearchPattern(query, 'giu')
      if (!matcher) return text
      const pieces = []
      let last = 0
      for (const match of String(text || '').matchAll(matcher)) {
        pieces.push(String(text).slice(last, match.index), h('mark', { key: match.index, className: 'dsp-search-mark' }, match[0]))
        last = match.index + match[0].length
        if (pieces.length >= 200) break
      }
      pieces.push(String(text || '').slice(last))
      return pieces
    }
    function clearSearchHighlights() {
      if (!supportsHighlight()) return
      CSS.highlights.delete(SEARCH_HIGHLIGHT)
      CSS.highlights.delete(SEARCH_CURRENT_HIGHLIGHT)
    }
    function paintSearchMatches(query, hits) {
      if (!supportsHighlight()) return
      const flow = findEvidenceFlow()
      const matcher = literalSearchPattern(query, 'giu')
      if (!flow || !matcher) return
      const ranges = []
      const rows = new Set(hits.flatMap(hit => sourceRows(flow, hit)))
      for (const row of rows) {
        const index = buildIndex(row)
        if (!index) continue
        matcher.lastIndex = 0
        for (const match of index.text.matchAll(matcher)) {
          const range = rangeAt(index, match.index, match.index + match[0].length)
          if (range) ranges.push(range)
          if (ranges.length >= 400) break
        }
        if (ranges.length >= 400) break
      }
      CSS.highlights.set(SEARCH_HIGHLIGHT, new Highlight(...ranges))
    }
    function PanelSearchDock({ value, onChange, onComposing, placeholder, label, count, en }) {
      const input = React.useRef(null)
      const [pinned, setPinned] = React.useState(false)
      const focus = () => { setPinned(true); input.current?.focus() }
      return h('div', { className: 'dsp-search-dock' + (pinned || value ? ' open' : '') },
        h('button', { type: 'button', className: 'dsp-search-peek', onClick: focus, tabIndex: -1, 'aria-label': placeholder },
          h('span', null, label), h('small', null, '⌕', en ? 'Search' : '搜索')),
        h('div', { className: 'dsp-search-form', role: 'search', 'aria-label': placeholder },
          h('label', { className: 'dsp-search-input-wrap' },
            h('span', { 'aria-hidden': true }, '⌕'),
            h('input', { ref: input, className: 'dsp-search-input', type: 'search', value, maxLength: 6000,
              placeholder, 'aria-label': placeholder, autoComplete: 'off', spellCheck: false,
              onChange: event => onChange(event.target.value),
              onCompositionStart: () => onComposing(true),
              onCompositionEnd: event => { onChange(event.target.value); onComposing(false) },
              onBlur: () => setPinned(false),
              onKeyDown: event => {
                if (event.nativeEvent?.isComposing) return
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (value) onChange(''); else { setPinned(false); input.current?.blur() } }
                if (event.key === 'Enter') event.preventDefault()
              },
            }),
            value ? h('button', { type: 'button', className: 'dsp-search-clear', 'aria-label': en ? 'Clear search' : '清空搜索',
              onClick: () => { onChange(''); input.current?.focus() } }, '×') : null),
          h('span', { className: 'dsp-search-count', role: 'status', 'aria-live': 'polite' }, count)),
      )
    }

    function createPanel(ctx) {
      return function ProvenancePanel() {
        const sessionId = useActiveSession()
        const ledger = useLedger()
        const en = isEnglish(ctx)
        const t = (zh, english) => (en ? english : zh)
        const theme = useTheme()
        const fontSize = useFontSize()

        const [mode, setMode] = React.useState('idle')
        const thinkingEffects = useThinkingEffects()
        const [panelTab, setPanelTab] = React.useState('trace')
        const [traceScope, setTraceScope] = React.useState('session')
        const [relatedSelection, setRelatedSelection] = React.useState(null)
        const [related, setRelated] = React.useState({ status: 'idle', hits: [] })
        const [relations, setRelations] = React.useState({ status: 'idle', items: [] })
        const [relatedRetry, setRelatedRetry] = React.useState(0)
        const relatedAbortRef = React.useRef(null)
        const relationsAbortRef = React.useRef(null)
        const previousSessionRef = React.useRef(sessionId)
        const [showTrash, setShowTrash] = React.useState(false)
        const [recycleStatus, setRecycleStatus] = React.useState('')
        const [panelQueries, setPanelQueries] = React.useState(blankPanelQueries)
        const [searchComposing, setSearchComposing] = React.useState(false)
        const [searchOffset, setSearchOffset] = React.useState(0)
        const [traceSearch, setTraceSearch] = React.useState(emptySearch)
        const searchJumpAbortRef = React.useRef(null)
        const [chromeVisible, setChromeVisible] = React.useState(false)
        const [hintMode, setHintMode] = React.useState('armed')
        const [claim, setClaim] = React.useState('')
        const [rawQuote, setRawQuote] = React.useState('')
        const [result, setResult] = React.useState(null)
        const [error, setError] = React.useState(null)
        const [errorHint, setErrorHint] = React.useState('')
        const [original, setOriginal] = React.useState(null)
        const [extra, setExtra] = React.useState(null)
        const [filter, setFilter] = React.useState('all')
        const [elapsed, setElapsed] = React.useState(0)
        const [chatRect, setChatRect] = React.useState(null)
        const [chatHost, setChatHost] = React.useState(null)
        const [copied, setCopied] = React.useState(false)
        const [size, setSize] = React.useState(loadSize)
        const [flagged, setFlagged] = React.useState(loadFeedback)
        const [pinnedId, setPinnedId] = React.useState(null)
        const [assumptionsSaved, setAssumptionsSaved] = React.useState(false)
        const [noteSaved, setNoteSaved] = React.useState(false)
        const [minimized, setMinimized] = React.useState(false)
        const [notice, setNotice] = React.useState('')
        const reading = useReading()
        const abortRef = React.useRef(null)
        const corroborateAbortRef = React.useRef(null)
        const jumpAbortRef = React.useRef(null)
        const selectionRef = React.useRef({})
        const bodyRef = React.useRef(null)
        const motionRef = React.useRef(false)
        const [closing, setClosing] = React.useState(false)
        const [collapsing, setCollapsing] = React.useState(false)
        const closingTimer = React.useRef(null)
        const sizeRef = React.useRef(size)
        sizeRef.current = size
        const modeRef = React.useRef('idle')
        modeRef.current = mode

        const stopTracing = React.useCallback(() => {
          pendingCrossJump.value = null
          corroborateAbortRef.current?.abort()
          readingStore.clear()
          relatedAbortRef.current?.abort()
          relationsAbortRef.current?.abort()
          setRelatedSelection(null)
          setTraceScope('session')
          setRelated({ status: 'idle', hits: [] })
          setRelations({ status: 'idle', items: [] })
          window.clearTimeout(closingTimer.current)
          motionRef.current = false
          jumpAbortRef.current?.abort()
          searchJumpAbortRef.current?.abort()
          setPanelQueries(blankPanelQueries())
          setSearchComposing(false)
          setSearchOffset(0)
          abortRef.current?.abort()
          abortRef.current = null
          setClosing(false)
          setMode('idle')
          setResult(null)
          setClaim('')
          setRawQuote('')
          setError(null)
          setErrorHint('')
          setOriginal(null)
          setExtra(null)
          setPinnedId(null)
          setAssumptionsSaved(false)
          setNoteSaved(false)
          setMinimized(false)
          setPanelTab('trace')
          setShowTrash(false)
          setRecycleStatus('')
          setNotice('')
          setFilter('all')
          setCopied(false)
          clearHighlights()
        }, [])

        const runTrace = React.useCallback(
          async (quote, raw, identity) => {
            setShowTrash(false)
            corroborateAbortRef.current?.abort()
            readingStore.generation++
            readingStore.set({ source: null, returning: false, travel: null })
            readingStore.lastSelection = selectedPassage()
            searchJumpAbortRef.current?.abort()
            setPanelQueries(current => ({ ...current, trace: '' }))
            if (identity) selectionRef.current = identity
            setTraceScope('session')
            setRelatedSelection({ sessionId, quote, seq: selectionRef.current.seq,
              role: selectionRef.current.role, messageId: selectionRef.current.messageId,
              prefix: selectionRef.current.prefix, suffix: selectionRef.current.suffix })
            jumpAbortRef.current?.abort()
            if (!sessionId) {
              setError(t('没有会话上下文。', 'No session context.'))
              setErrorHint(t('请打开一个会话后重新选择原文。', 'Open a conversation and select the passage again.'))
              setMode('error')
              return
            }
            setClaim(quote)
            setRawQuote(raw || quote)
            setResult(null)
            setError(null)
            setErrorHint('')
            setOriginal(null)
            setExtra(null)
            setFilter('all')
            setCopied(false)
            setPinnedId(null)
            setAssumptionsSaved(false)
            setNoteSaved(false)
            setMinimized(false)
            setPanelTab('trace')
            setNotice('')
            setMode('loading')
            clearHighlights()
            abortRef.current?.abort()
            const controller = new AbortController()
            abortRef.current = controller
            try {
              const response = await fetch(ROUTE, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId, quote, seq: selectionRef.current.seq, role: selectionRef.current.role, messageId: selectionRef.current.messageId, prefix: selectionRef.current.prefix, suffix: selectionRef.current.suffix, exclude: feedbackExcludeFor(sessionId) }),
                signal: controller.signal,
              })
              if (response.status === 404) throw Object.assign(new Error(t('Host 端路由不存在。', 'Host route is missing.')), {
                hint: t('请确认插件已启用，并重新加载 DSH 后再试。', 'Check that the plugin is enabled, then reload DSH and try again.'),
              })
              const data = await response.json().catch(() => null)
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              if (!data || data.ok !== true) {
                throw Object.assign(new Error((en ? data?.messageEn || data?.message : data?.message) || data?.error || t('分析失败。', 'Trace failed.')), {
                  hint: en ? data?.hintEn || data?.hint : data?.hint,
                })
              }
              if (controller.signal.aborted) return
              setResult(data)
              setMode('done')
              paint(data, quote)
            } catch (cause) {
              if (controller.signal.aborted || (cause && cause.name === 'AbortError')) return
              setError(cause instanceof Error ? cause.message : String(cause))
              setErrorHint(cause?.hint || t('请重新分析；如果仍然失败，请确认 DSH 已加载最新插件并检查当前模型服务。', 'Analyze again. If it still fails, check that DSH has loaded the latest plugin and the model service is available.'))
              setMode('error')
            } finally {
              if (abortRef.current === controller) abortRef.current = null
            }
          },
          [sessionId, en],
        )

        React.useEffect(() => {
          selectionRef.current = {}
          corroborateAbortRef.current?.abort()
          abortRef.current?.abort()
          jumpAbortRef.current?.abort()
          if (previousSessionRef.current !== sessionId) {
            previousSessionRef.current = sessionId
            if (readingStore.value.travel !== sessionId) readingStore.clear()
            setRelatedSelection(null)
            setTraceScope('session')
            setRelated({ status: 'idle', hits: [] })
            setRelations({ status: 'idle', items: [] })
            setResult(null)
            setClaim('')
            setRawQuote('')
            setError(null)
            setErrorHint('')
            setPinnedId(null)
            setAssumptionsSaved(false)
            setNoteSaved(false)
            setMode(current => current === 'idle' ? 'idle' : 'armed')
          }
        }, [sessionId])

        const cancelAnalysis = () => {
          abortRef.current?.abort()
          abortRef.current = null
          corroborateAbortRef.current?.abort()
          relationsAbortRef.current?.abort()
          if (extra?.status === 'loading') setExtra(null)
          if (relations.status === 'loading') setRelations({ status: 'idle', items: [] })
          if (modeRef.current === 'loading') {
            relatedAbortRef.current?.abort()
            setRelatedSelection(null)
            setRelated({ status: 'idle', hits: [] })
            setTraceScope('session')
            setMode('armed')
            setResult(null)
            setError(null)
            setErrorHint('')
            setElapsed(0)
            clearHighlights()
          }
          setNotice(t('已取消分析，可以重新选择文字。', 'Analysis cancelled. You can select another passage.'))
        }

        const runCorroborate = React.useCallback(async () => {
          if (!claim) return
          corroborateAbortRef.current?.abort()
          const controller = new AbortController()
          corroborateAbortRef.current = controller
          setExtra({ status: 'loading' })
          try {
            const response = await fetch(CORROBORATE_ROUTE, {
              method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ quote: claim }), signal: controller.signal,
            })
            const data = await response.json().catch(() => null)
            if (controller.signal.aborted) return
            if (!data || data.ok !== true) {
              throw new Error((en ? data?.messageEn || data?.message : data?.message) || data?.error || t('检索失败', 'Search failed'))
            }
            setExtra({ status: 'done', sources: data.sources || [] })
          } catch (cause) {
            if (!controller.signal.aborted) setExtra({ status: 'error', error: cause instanceof Error ? cause.message : String(cause) })
          } finally {
            if (corroborateAbortRef.current === controller) corroborateAbortRef.current = null
          }
        }, [claim, en])

        /** Jump requests come from the Archive tab, not from the chat view. */
        const showOriginalFallback = React.useCallback(async (seq, quote, targetSessionId) => {
          const targetSession = targetSessionId || sessionId
          if (!targetSession) return
          let targetSeq = seq
          let text = ''
          let role = null
          try {
            if (targetSeq) {
              const response = await fetch(MESSAGE_ROUTE, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId: targetSession, seq: targetSeq }),
              })
              const data = await response.json().catch(() => null)
              if (data && data.ok === true) {
                text = data.text || ''
                role = data.type === 'user/message'
                  ? 'user'
                  : data.type === 'assistant/message'
                    ? 'assistant'
                    : 'tool'
              }
            }
            if (!text) {
              // No seq, or that row is gone: resolve the quote against the log.
              const response = await fetch(LOCATE_ROUTE, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId: targetSession, quote }),
              })
              const data = await response.json().catch(() => null)
              if (data && data.ok === true) {
                targetSeq = data.seq
                text = data.text || ''
                role = data.role || null
              }
            }
          } catch {
            // Fall through with whatever text we have (possibly none).
          }
          setPanelTab('trace')
          setClaim(quote)
          setRawQuote(quote)
          setOriginal({ seq: targetSeq, text: text || quote, quote })
          setResult({
            ok: true,
            claim: { seq: targetSeq, role, text: quote, resolved: Boolean(targetSeq) },
            atoms: [],
            assumptions: [],
            meta: {},
          })
          setMode('idle')
          setMinimized(false)
          setError(null)
          setErrorHint('')
          setNotice(text ? t('已显示原文', 'Source shown') : t('没找到原文', 'Source not found'))
          window.setTimeout(() => setNotice(''), 2600)
        }, [sessionId, en])

        React.useEffect(() => {
          const stage = event => {
            if (!event.target?.closest?.('[data-dsp-jump]') || event.target.closest('.dsp-quote-toggle, .dsp-flag, a')) return
            readingStore.staged = { at: Date.now(), bookmark: captureReading() }
          }
          const remember = () => { const selection = selectedPassage(); if (selection) readingStore.lastSelection = selection }
          document.addEventListener('pointerdown', stage, true)
          document.addEventListener('selectionchange', remember)
          return () => {
            document.removeEventListener('pointerdown', stage, true)
            document.removeEventListener('selectionchange', remember)
          }
        }, [])

        const backToReading = async () => {
          jumpAbortRef.current?.abort()
          searchJumpAbortRef.current?.abort()
          try {
            const returned = await returnToReading(ctx)
            setNotice(returned ? t('已返回刚才的位置', 'Back to your reading position')
              : t('暂未恢复原位置，原记录仍保留，可重试。', 'Could not restore the reading position yet. You can retry.'))
          } catch { setNotice(t('暂未恢复原位置，可重试。', 'Could not restore the reading position. Retry.')) }
        }

        /** Shared jump used by the Archive tab and the panel's Notes tab. */
        const runJump = React.useCallback((quote, seq, targetSessionId) => {
          if (!quote) return
          const jumpSession = targetSessionId || sessionId
          const navigation = beginReadingJump(jumpSession)
          const switching = Boolean(jumpSession && jumpSession !== sessionId)
          if (switching) {
            // The note may belong to another conversation; open it first.
            openSessionById(ctx, jumpSession)
          }
          setNotice(t('正在定位…', 'Locating…'))
          let targetSeq = seq
          let turn = null
          let railClicked = false
          let attempts = 0

          void (async () => {
            try {
              const response = await fetch(LOCATE_ROUTE, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId: jumpSession, quote }),
              })
              const data = await response.json().catch(() => null)
              if (data && data.ok === true) {
                targetSeq = data.seq
                turn = Number(data.turn) || null
                if (turn) {
                  setNotice(t(`正在定位第 ${turn} 轮…`, `Locating turn ${turn}…`))
                }
              }
            } catch {
              // Keep the caller-provided seq and try the visible DOM.
            }

            const tryFocus = () => {
              if (navigation !== readingStore.generation) return
              if (sessionStore.id !== jumpSession) {
                if (++attempts < 120) window.setTimeout(tryFocus, 150)
                return
              }
              // A cached transcript can stay mounted behind Archive. Select
              // Chat explicitly before locating, even when that DOM exists.
              openChat(ctx, jumpSession)
              clickChatTab()
              if (focusQuote(quote, [])) {
                setNotice(t('已定位到原文', 'Located'))
                window.setTimeout(() => setNotice(''), 1800)
                return
              }
              if (turn && !railClicked) {
                railClicked = clickTurnMark(turn)
                if (railClicked) setNotice(t('正在加载并跳转…', 'Loading and jumping…'))
              } else if (!turn && !railClicked && targetSeq) {
                railClicked = navigateTurnForSeq(targetSeq)
                if (railClicked) setNotice(t('正在加载并跳转…', 'Loading and jumping…'))
              }
              attempts += 1
              if (attempts < (turn ? 120 : 20)) {
                window.setTimeout(tryFocus, 150)
              } else {
                // Never dump a copied transcript into the panel: the note is
                // already in the list. Tell the user the chat could not land.
                setNotice(turn
                  ? t(`第 ${turn} 轮未能定位，可再点一次或手动滚动加载更早消息`,
                      `Turn ${turn} did not land; retry or scroll to load older messages`)
                  : t('未能在对话中定位，可再点一次或手动滚动加载更早消息',
                      'Could not land in the chat; retry or scroll to load older messages'))
                readingStore.set({ travel: null })
                window.setTimeout(() => setNotice(''), 4200)
              }
            }
            window.setTimeout(tryFocus, 60)
          })()
        }, [sessionId, en, showOriginalFallback])

        /** Evidence cards use cancellable, message-addressed navigation. */
        const runEvidenceJump = React.useCallback(async (quote, seq, targetSessionId, keywords = [], identity = {}, options = {}) => {
          if (!quote) return
          jumpAbortRef.current?.abort()
          searchJumpAbortRef.current?.abort()
          const controller = new AbortController()
          if (options.search) searchJumpAbortRef.current = controller
          else jumpAbortRef.current = controller
          const jumpSession = targetSessionId || sessionId
          if (!options.search) beginReadingJump(jumpSession, options.captured)
          const pause = () => new Promise(resolve => window.setTimeout(resolve, 150))
          setOriginal(null)
          setNotice(t('正在定位原消息…', 'Locating the source message…'))
          try {
            const response = await fetch(EVIDENCE_LOCATE_ROUTE, {
              method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: jumpSession, quote, seq, ...identity }), signal: controller.signal,
            })
            const data = await response.json()
            if (!response.ok || !data?.ok) throw new Error(t('原文已改变、未找到或存在重复，无法可靠定位。', 'Source changed, missing or ambiguous.'))
            if (controller.signal.aborted) return
            if (sessionStore.id !== jumpSession && !openSessionById(ctx, jumpSession)) throw new Error(t('无法打开来源会话。', 'Could not open the source chat.'))
            let loaded = false
            let loading = false
            let railClicked = false
            const deadline = Date.now() + 25000
            while (!controller.signal.aborted && Date.now() < deadline) {
              if (sessionStore.id !== jumpSession) { await pause(); continue }
              openChat(ctx, jumpSession)
              const flow = findEvidenceFlow()
              if (!flow) { await pause(); continue }
              // Public Session loader handles the paged history; no scrolling to the top.
              const session = ctx.get('sessions')?.binding?.(jumpSession)?.session
              if (!loaded && !loading && typeof session?.loadThrough === 'function') {
                loading = true
                Promise.resolve(session.loadThrough(data.seq)).then(() => { loaded = true; loading = false }, () => { loaded = true; loading = false })
              }
              if (options.search && loading) { await pause(); continue }
              expandSourceTurn(flow, data.turn)
              if (focusEvidenceQuote(quote, keywords, data, options)) {
                setNotice(options.search ? t('已定位匹配原文', 'Match located') : t('已定位并选中原文', 'Source located and selected'))
                return true
              }
              if (!railClicked && (!session || loaded)) {
                railClicked = data.turn ? clickTurnMark(data.turn) : navigateTurnForSeq(data.seq)
              }
              await pause()
            }
            if (!controller.signal.aborted) setNotice(t('原消息尚未展开或当前 DSH 版本不支持定位，请展开该轮后重试。', 'Source is folded or this DSH version cannot navigate to it. Expand its turn and retry.'))
          } catch (cause) {
            if (!controller.signal.aborted) setNotice(cause instanceof Error ? cause.message : String(cause))
          } finally {
            if (!options.search && !controller.signal.aborted) readingStore.set({ travel: null })
          }
        }, [sessionId, en])

        const jumpTo = React.useCallback((item, keywords) => runEvidenceJump(item.quote, item.seq, sessionId, keywords, item), [runEvidenceJump, sessionId])

        React.useEffect(() => {
          if (!relatedSelection || relatedSelection.sessionId !== sessionId || mode === 'idle' || closing || minimized) {
            setRelated({ status: 'idle', hits: [] })
            return
          }
          const controller = new AbortController()
          relatedAbortRef.current = controller
          relationsAbortRef.current?.abort()
          setRelated({ status: 'loading', hits: [] })
          setRelations({ status: 'idle', items: [] })
          const timer = window.setTimeout(() => {
            void (async () => {
              let scanId
              try {
                do {
                  const response = await fetch(RELATED_ROUTE, { method: 'POST', credentials: 'same-origin',
                    headers: { 'content-type': 'application/json' }, signal: controller.signal,
                    body: JSON.stringify({ ...relatedSelection, ...(scanId ? { scanId } : {}) }) })
                  const data = await response.json()
                  if (!response.ok || !data?.ok) throw Object.assign(new Error(data?.message || t('关联检索暂不可用，请重试。', 'Related-session search unavailable. Retry.')), { code: data?.error })
                  if (controller.signal.aborted) return
                  scanId = data.scanId
                  setRelated({ ...data, status: data.complete ? 'ready' : 'loading', hits: data.hits || [] })
                  if (data.complete) break
                  if (!scanId) throw new Error(t('关联检索未返回续查标识。', 'Missing search continuation.'))
                } while (!controller.signal.aborted)
              } catch (cause) {
                if (!controller.signal.aborted) setRelated(current => ({ ...current,
                  status: cause.code === 'related_unavailable' ? 'unavailable' : 'error', error: cause.message }))
              }
            })()
          }, 550)
          return () => { window.clearTimeout(timer); controller.abort() }
        }, [relatedSelection, relatedRetry, sessionId, mode === 'idle', closing, minimized, en])

        React.useEffect(() => {
          if (traceScope !== 'all' || showTrash || panelTab !== 'trace' || closing || minimized) {
            relationsAbortRef.current?.abort()
            setRelations(current => current.status === 'loading' ? { status: 'idle', items: [] } : current)
          }
        }, [traceScope, showTrash, panelTab, closing, minimized])

        const analyzeRelated = async () => {
          if (!relatedSelection || !related.scanId || !related.hits.length || relations.status === 'loading') return
          relationsAbortRef.current?.abort()
          const controller = new AbortController()
          relationsAbortRef.current = controller
          setRelations({ status: 'loading', items: [] })
          try {
            const response = await fetch(RELATION_ROUTE, { method: 'POST', credentials: 'same-origin',
              headers: { 'content-type': 'application/json' }, signal: controller.signal,
              body: JSON.stringify({ ...relatedSelection, scanId: related.scanId }) })
            const data = await response.json()
            if (!response.ok || !data?.ok) throw new Error(data?.message || t('关系分析暂时失败，请重试。', 'Relationship analysis failed. Retry.'))
            if (!controller.signal.aborted) setRelations({ status: 'done', items: data.relations || [], meta: data.meta })
          } catch (cause) {
            if (!controller.signal.aborted) setRelations({ status: 'error', items: [], error: cause.message })
          }
        }

        const openRelated = hit => {
          beginReadingJump(hit.sessionId)
          pendingCrossJump.value = { ...hit, at: Date.now() }
          if (!openSessionById(ctx, hit.sessionId)) {
            pendingCrossJump.value = null
            setNotice(t('当前 DSH 无法自动打开关联会话。', 'This DSH version cannot open the related session.'))
          } else setNotice(t('正在打开关联会话并定位…', 'Opening the related session…'))
        }

        React.useEffect(() => {
          const pending = pendingCrossJump.value
          if (!pending || pending.sessionId !== sessionId) return
          pendingCrossJump.value = null
          if (Date.now() - pending.at > 30000) return
          setMode('armed')
          setMinimized(false)
          setPanelTab('trace')
          setTraceScope('session')
          setShowTrash(false)
          void runEvidenceJump(pending.quote, pending.seq, pending.sessionId, [], pending, { captured: true })
        }, [sessionId, runEvidenceJump])

        React.useEffect(() => {
          setPanelQueries(blankPanelQueries())
          setSearchOffset(0)
          setSearchComposing(false)
          setTraceSearch(emptySearch())
          searchJumpAbortRef.current?.abort()
          clearSearchHighlights()
        }, [sessionId])

        React.useEffect(() => {
          clearSearchHighlights()
          const query = searchText(panelQueries.trace)
          if (traceScope === 'all' || showTrash || panelTab !== 'trace' || mode === 'idle' || closing || minimized || searchComposing || !query || !sessionId) {
            setTraceSearch(emptySearch())
            return
          }
          clearHighlights()
          // A previous text selection can otherwise stay blue behind search matches.
          // Input caret/selection is separate from document Selection in Chromium.
          const selection = window.getSelection()
          if (selection && !selection.isCollapsed) selection.removeAllRanges()
          const controller = new AbortController()
          setTraceSearch({ ...emptySearch(), sessionId, query, status: 'waiting' })
          const timer = window.setTimeout(async () => {
            setTraceSearch(current => ({ ...current, status: 'loading' }))
            try {
              const response = await fetch(SEARCH_ROUTE, { method: 'POST', credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId, query, offset: searchOffset }), signal: controller.signal })
              const data = await response.json()
              if (!response.ok || !data?.ok) throw new Error(data?.message || t('会话搜索暂不可用，请重载插件后重试。', 'Search unavailable. Reload the plugin and retry.'))
              if (controller.signal.aborted) return
              setTraceSearch({ ...data, sessionId, status: 'ready', selected: data.hits.length ? 0 : -1 })
              if (data.hits[0]) void runEvidenceJump(data.hits[0].quote, data.hits[0].seq, sessionId, [], data.hits[0], { search: true })
            } catch (cause) {
              if (!controller.signal.aborted) setTraceSearch({ ...emptySearch(), sessionId, query, status: 'error', error: cause.message || String(cause) })
            }
          }, 450)
          return () => { window.clearTimeout(timer); controller.abort(); searchJumpAbortRef.current?.abort(); clearSearchHighlights() }
        }, [panelQueries.trace, panelTab, traceScope, showTrash, sessionId, searchOffset, searchComposing, mode === 'idle', closing, minimized, runEvidenceJump])

        React.useEffect(() => {
          if (traceScope === 'all' || showTrash || traceSearch.status !== 'ready' || traceSearch.sessionId !== sessionId || panelTab !== 'trace') return
          let timer
          const paint = () => paintSearchMatches(traceSearch.query, traceSearch.hits)
          paint()
          const flow = findEvidenceFlow()
          const observer = new MutationObserver(() => { window.clearTimeout(timer); timer = window.setTimeout(paint, 80) })
          if (flow) observer.observe(flow, { subtree: true, childList: true, characterData: true })
          return () => { observer.disconnect(); window.clearTimeout(timer) }
        }, [traceSearch, sessionId, panelTab, traceScope, showTrash])

        React.useEffect(() => {
          if (traceScope === 'session' && !showTrash && panelTab === 'trace' && !searchText(panelQueries.trace) && result && mode !== 'idle' && !minimized && !closing) paint(result, claim)
        }, [panelTab, traceScope, panelQueries.trace, result, claim, mode, minimized, closing, showTrash])

        React.useEffect(() => {
          setShowTrash(false)
          setRecycleStatus('')
        }, [sessionId])

        React.useEffect(() => {
          if (noteSaved && !ledger.notes.some(item => item.sessionId === (sessionId || '') && item.text === (rawQuote || claim).trim())) setNoteSaved(false)
          if (pinnedId && !ledger.decisions.some(item => item.id === pinnedId)) setPinnedId(null)
          if (assumptionsSaved && (result?.assumptions || []).some(text => !ledger.assumptions.some(item => item.sessionId === (sessionId || '') && item.sourceClaim === claim && item.text === text))) setAssumptionsSaved(false)
        }, [ledger, sessionId, rawQuote, claim, result, noteSaved, pinnedId, assumptionsSaved])

        React.useEffect(() => {
          const onJump = (event) => {
            const detail = event.detail || {}
            const quote = String(detail.quote || '').trim()
            if (!quote) return
            const seq = detail.seq == null ? null : Number(detail.seq)
            if (detail.addressed && Number.isSafeInteger(seq) && seq >= 0) {
              void runEvidenceJump(quote, seq, detail.sessionId || null)
            } else runJump(quote, seq || null, detail.sessionId || null)
          }
          window.addEventListener(JUMP_EVENT, onJump)
          return () => window.removeEventListener(JUMP_EVENT, onJump)
        }, [runJump, runEvidenceJump])

        // A note saved while the trace was still loading has no seq yet; fill
        // it in when the claim resolves so "Jump to source" becomes available.
        React.useEffect(() => {
          if (!result || !result.claim || result.claim.seq == null) return
          const text = (rawQuote || claim).trim()
          if (!text) return
          ledgerStore.update((current) => {
            let changed = false
            const notes = current.notes.map((item) => {
              if (item.seq == null && item.text === text && item.sessionId === (sessionId || '')) {
                changed = true
                return { ...item, seq: result.claim.seq, role: result.claim.role, quote: claim }
              }
              return item
            })
            return changed ? { ...current, notes } : current
          })
        }, [result, claim, rawQuote, sessionId])

        React.useEffect(() => {
          const arm = () => {
            abortRef.current?.abort()
            abortRef.current = null
            if (modeRef.current !== 'idle') {
              stopTracing()
              return
            }
            setMode('armed')
            setResult(null)
            setError(null)
            setErrorHint('')
            setOriginal(null)
            setExtra(null)
            setFilter('all')
            setCopied(false)
            setPinnedId(null)
            setAssumptionsSaved(false)
            setNoteSaved(false)
            setMinimized(false)
            setPanelTab('trace')
            setNotice('')
            clearHighlights()
          }
          const onKey = (event) => {
            if (event.isComposing) return
            if (event.key === 'Escape') {
              if (event.target?.closest?.('.dsp-search-dock')) return
              if (event.target?.closest?.('.dsp-analysis-tools')?.querySelector('[aria-expanded="true"]')) return
              // Let the settings popover consume Escape without exiting the mode.
              if (document.querySelector('.dsp-settings')) return
              stopTracing()
              return
            }
            if (!isHotkey(event)) return
            event.preventDefault()
            event.stopPropagation()
            arm()
          }
          window.addEventListener(ARM_EVENT, arm)
          document.addEventListener('keydown', onKey, true)
          return () => {
            window.removeEventListener(ARM_EVENT, arm)
            document.removeEventListener('keydown', onKey, true)
          }
        }, [])

        React.useEffect(() => {
          if (mode === 'idle' || mode === 'loading') return undefined
          const onUp = (event) => {
            // Clicking our own hint or panel must never start a trace, even if
            // some text was still selected underneath.
            if (event.target?.closest?.('.dsp-hint, .dsp-card, .dsp-pill, .dsp-source-actions, .dsp-reading-return')) return
            window.setTimeout(() => {
              if (modeRef.current === 'idle' || modeRef.current === 'loading') return
              const picked = readSelection()
              if (!picked.ok) {
                // 'empty'/'outside' fire on every plain click while armed (no
                // drag happened) — silence there is correct, not a bug.
                // 'too_long' is the one case the user actually did something
                // and got nothing back; that deserves an explanation.
                if (picked.reason === 'too_long') {
                  setNotice(t(
                    `选区太长（超过 ${MAX_QUOTE_LENGTH} 字），请缩小范围再试`,
                    `Selection too long (over ${MAX_QUOTE_LENGTH} chars) — select a smaller range`,
                  ))
                  window.setTimeout(() => setNotice(''), 3200)
                }
                return
              }
              void runTrace(picked.quote, picked.raw, picked)
            }, 10)
          }
          document.addEventListener('mouseup', onUp, true)
          return () => document.removeEventListener('mouseup', onUp, true)
        }, [mode, runTrace])

        React.useEffect(() => {
          if (mode === 'idle') return undefined
          const onContext = (event) => {
            if (event.target?.closest?.('.dsp-card, .dsp-pill, .dsp-hint, .dsp-source-actions, .dsp-reading-return')) return
            event.preventDefault()
            stopTracing()
          }
          document.addEventListener('contextmenu', onContext, true)
          return () => document.removeEventListener('contextmenu', onContext, true)
        }, [mode, stopTracing])

        React.useEffect(() => {
          if (mode !== 'loading') {
            setElapsed(0)
            return undefined
          }
          const started = Date.now()
          const timer = window.setInterval(() => {
            setElapsed(Math.floor((Date.now() - started) / 1000))
          }, 500)
          return () => window.clearInterval(timer)
        }, [mode])

        React.useEffect(() => {
          // Retain the last rectangle for the perimeter and atmosphere exit.
          if (mode === 'idle') return undefined
          // Track the conversation body's viewport rect so the mode frame hugs
          // it through window resizes and sidebar toggles.
          let last = ''
          let lastHost = null
          let observer = null
          const update = () => {
            const region = conversationFrameRegion(sessionId)
            if (!region) return
            if (region.host !== lastHost) {
              lastHost = region.host; setChatHost(region.host)
              observer?.disconnect(); observer?.observe(region.host)
            }
            const next = region.rect
            const key = `${next.left}:${next.top}:${next.width}:${next.height}`
            if (key === last) return
            last = key
            setChatRect(next)
          }
          if (typeof ResizeObserver !== 'undefined') observer = new ResizeObserver(update)
          update()
          const timer = window.setInterval(update, 300)
          window.addEventListener('resize', update)
          window.addEventListener('scroll', update, true)
          return () => {
            observer?.disconnect()
            window.clearInterval(timer)
            window.removeEventListener('resize', update)
            window.removeEventListener('scroll', update, true)
          }
        }, [mode, sessionId])

        React.useEffect(() => {
          if (mode !== 'idle') {
            setChromeVisible(true)
            setHintMode(mode)
            return undefined
          }
          const timer = window.setTimeout(() => setChromeVisible(false), 1100)
          return () => window.clearTimeout(timer)
        }, [mode])

        React.useEffect(() => {
          traceModeStore.set(mode !== 'idle')
        }, [mode])

        React.useEffect(
          () => () => {
            relatedAbortRef.current?.abort()
            relationsAbortRef.current?.abort()
            corroborateAbortRef.current?.abort()
            abortRef.current?.abort()
            jumpAbortRef.current?.abort()
            searchJumpAbortRef.current?.abort()
            window.clearTimeout(closingTimer.current)
            clearHighlights()
          },
          [],
        )

        const dismiss = (collapse = false) => {
          if (motionRef.current) return
          motionRef.current = true
          setClosing(true)
          corroborateAbortRef.current?.abort()
          jumpAbortRef.current?.abort()
          searchJumpAbortRef.current?.abort()
          abortRef.current?.abort()
          traceModeStore.set(false)
          const finish = () => {
            motionRef.current = false
            setClosing(false)
            if (collapse && result) {
              setMinimized(true)
              setMode('idle')
              setNotice('')
              clearHighlights()
            } else stopTracing()
          }
          const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
          closingTimer.current = window.setTimeout(finish, reduced ? 0 : 300)
        }
        const close = () => {
          setMinimized(false)
          dismiss(false)
        }
        const minimize = () => {
          if (motionRef.current) return
          searchJumpAbortRef.current?.abort()
          motionRef.current = true
          setCollapsing(true)
          window.setTimeout(() => {
            motionRef.current = false
            setCollapsing(false)
            setMinimized(true)
            setNotice('')
          }, 300)
        }

        const restore = () => {
          setMinimized(false)
          if (result) {
            setMode('done')
            paint(result, claim)
          }
        }

        const startResize = (event) => {
          if (event.button !== undefined && event.button !== 0) return
          event.preventDefault()
          event.stopPropagation()
          const startX = event.clientX
          const startY = event.clientY
          const startW = sizeRef.current.w
          const startH = sizeRef.current.h || Math.min(window.innerHeight * 0.64, 720)
          const move = (moveEvent) => {
            const w = Math.min(760, Math.max(320, startW + (moveEvent.clientX - startX)))
            const h = Math.min(window.innerHeight * 0.85, Math.max(220, startH + (moveEvent.clientY - startY)))
            const next = { w, h }
            sizeRef.current = next
            setSize(next)
          }
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            saveSize(sizeRef.current)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        }

        const resetSize = () => {
          const next = { w: 420, h: 0 }
          sizeRef.current = next
          setSize(next)
          saveSize(next)
        }

        const toggleFlag = (item) => {
          const key = evidenceKey(item)
          setFlagged((current) => {
            const next = new Set(current)
            const flaggedOn = !next.has(key)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            saveFeedback(next)
            // Scoped by session+seq+quote so a later trace in this same
            // session can tell the attribution model "not this one again".
            if (sessionId) updateFeedbackDetail(sessionId, item, flaggedOn)
            return next
          })
        }

        const pinDecision = () => {
          if (!result || !claim || pinnedId) return
          const decisionId = makeId('dec')
          const now = Date.now()
          ledgerStore.update((current) => {
            const existing = new Set(
              current.assumptions
                .filter((item) => item.sessionId === (sessionId || '') && item.sourceClaim === claim)
                .map((item) => item.text),
            )
            const fresh = (result.assumptions || [])
              .filter((text) => !existing.has(text))
              .map((text) => ({
                id: makeId('asm'),
                sessionId: sessionId || '',
                decisionId,
                text,
                status: 'open',
                createdAt: now,
                sourceClaim: claim,
              }))
            return {
              decisions: [
                {
                  id: decisionId,
                  sessionId: sessionId || '',
                  claim,
                  claimSeq: result.claim?.seq ?? null,
                  atoms: result.atoms || [],
                  assumptions: result.assumptions || [],
                  createdAt: now,
                  status: 'active',
                },
                ...current.decisions,
              ].slice(0, 200),
              assumptions: [...fresh, ...current.assumptions].slice(0, 400),
              notes: current.notes,
            }
          })
          setPinnedId(decisionId)
          setAssumptionsSaved(true)
          setNotice(t('已存档这条结论', 'Conclusion archived'))
          window.setTimeout(() => setNotice(''), 2500)
        }

        /** Save the assumptions without creating a decision record. */
        const saveAssumptionsOnly = () => {
          if (!result || !claim || assumptionsSaved || pinnedId) return
          const now = Date.now()
          let added = 0
          ledgerStore.update((current) => {
            const existing = new Set(
              current.assumptions
                .filter((item) => item.sessionId === (sessionId || '') && item.sourceClaim === claim)
                .map((item) => item.text),
            )
            const fresh = (result.assumptions || [])
              .filter((text) => !existing.has(text))
              .map((text) => ({
                id: makeId('asm'),
                sessionId: sessionId || '',
                decisionId: null,
                text,
                status: 'open',
                createdAt: now,
                sourceClaim: claim,
              }))
            added = fresh.length
            return {
              decisions: current.decisions,
              assumptions: [...fresh, ...current.assumptions].slice(0, 400),
              notes: current.notes,
            }
          })
          setAssumptionsSaved(true)
          setNotice(added > 0
            ? t(`已存入 ${added} 条假设`, `${added} assumptions saved`)
            : t('这些假设已在台账里', 'These assumptions are already saved'))
          window.setTimeout(() => setNotice(''), 2500)
        }

        /** Keep the selected passage as a notebook-style excerpt. */
        const saveNote = () => {
          if (!claim || noteSaved) return
          const text = (rawQuote || claim).trim()
          if (!text) return
          const now = Date.now()
          let added = false
          ledgerStore.update((current) => {
            const exists = current.notes.some(
              (item) => item.sessionId === (sessionId || '') && item.text === text,
            )
            if (exists) return current
            added = true
            return {
              ...current,
              notes: [
                {
                  id: makeId('note'),
                  sessionId: sessionId || '',
                  text,
                  quote: claim,
                  seq: result?.claim?.seq ?? null,
                  role: result?.claim?.role ?? null,
                  createdAt: now,
                },
                ...current.notes,
              ].slice(0, 500),
            }
          })
          setNoteSaved(true)
          setNotice(added
            ? t('已存为笔记', 'Saved as note')
            : t('这条笔记已在档案里', 'Already in the archive'))
          window.setTimeout(() => setNotice(''), 2500)
        }

        const removeNote = id => setRecycleStatus(recycleNotice(recycleLedgerItem('notes', id), t))
        const restoreItem = id => setRecycleStatus(recycleNotice(restoreLedgerItem(id), t))

        const jumpToNote = (note) => {
          runJump(noteJumpText(note), note.seq, note.sessionId)
        }

        const togglePanelDecision = (id) =>
          ledgerStore.update((current) => ({
            ...current,
            decisions: current.decisions.map((item) =>
              item.id === id
                ? { ...item, status: item.status === 'revoked' ? 'active' : 'revoked' }
                : item),
          }))

        const removePanelDecision = id => setRecycleStatus(recycleNotice(recycleLedgerItem('decisions', id), t))

        const setPanelAssumptionStatus = (id, status) =>
          ledgerStore.update((current) => ({
            ...current,
            assumptions: current.assumptions.map((item) =>
              item.id === id ? { ...item, status } : item),
          }))

        const removePanelAssumption = id => setRecycleStatus(recycleNotice(recycleLedgerItem('assumptions', id), t))

        const goArchive = () => {
          const focus = pinnedId
            ? `decision:${pinnedId}`
            : assumptionsSaved
              ? 'section:assumptions'
              : null
          const ok = openLedger(ctx, sessionId, focus)
          if (!ok) setNotice(t('请点顶部「档案」查看', 'Open the Archive tab to view'))
        }

        const traceMarkdown = () => {
          if (!result) return ''
          const lines = [`# 溯源报告`, '', `- 结论：「${claim}」`, '']
          for (const atom of orderAtoms(result.atoms)) {
            lines.push(`## ${atom.text}`, `- 关系：${atom.relation}`)
            if (!atom.evidence || atom.evidence.length === 0) lines.push('- 未找到依据。')
            for (const item of atom.evidence || []) {
              lines.push(`- [${item.role} #${item.seq}] 「${item.quote}」`)
              if (item.why) lines.push(`  - ${item.why}`)
              if (item.url) lines.push(`  - ${item.url}`)
            }
            if (atom.note) lines.push(`- 备注：${atom.note}`)
            lines.push('')
          }
          if (extra && extra.sources && extra.sources.length > 0) {
            lines.push('## 补充来源（AI 当时未使用）', '')
            for (const source of extra.sources) {
              lines.push(`- ${source.site || ''} 「${source.quote}」`)
              if (source.url) lines.push(`  - ${source.url}`)
            }
          }
          return lines.join('\n')
        }

        const decisionsMarkdown = () => {
          const lines = ['# 结论', '']
          for (const decision of sessionDecisions) {
            lines.push(`## ${decision.claim}`)
            lines.push(`- ${new Date(decision.createdAt).toLocaleString()} · ${decision.status}`)
            for (const atom of orderAtoms(decision.atoms)) {
              for (const item of atom.evidence || []) {
                lines.push(`  - [${item.role} #${item.seq}] 「${item.quote}」`)
              }
            }
            if ((decision.assumptions || []).length > 0) {
              lines.push(`- 假设：${decision.assumptions.join('；')}`)
            }
            lines.push('')
          }
          return lines.join('\n')
        }

        const assumptionsMarkdown = () => {
          const lines = ['# 假设', '']
          for (const item of sessionAssumptions) {
            lines.push(`- [${item.status}] ${item.text}`)
            if (item.sourceClaim) lines.push(`  - 来源：${item.sourceClaim}`)
          }
          return lines.join('\n')
        }

        const notesMarkdown = () => {
          const lines = ['# 摘录', '']
          for (const note of [...sessionNotes].sort((left, right) => left.createdAt - right.createdAt)) {
            const meta = new Date(note.createdAt).toLocaleString()
              + (note.role ? ` · ${roleLabel(note.role, t)} #${note.seq}` : '')
            lines.push(`- **${meta}**`)
            for (const line of String(note.text || '').split('\n')) {
              lines.push(`  > ${line}`)
            }
          }
          return lines.join('\n')
        }

        const exportActive = () => {
          let text = ''
          let filename = 'provenance.md'
          if (panelTab === 'trace' && traceScope === 'all') {
            const lines = ['# 跨会话候选关联', '', `选句：${claim}`, '',
              '候选关联不代表 AI 当时已引用这些会话；关系判断仍需核对原文。', '']
            for (const hit of related.hits) {
              const relation = relations.items.find(item => item.id === hit.id)
              lines.push(`## ${hit.title || `会话 #${hit.sessionId.slice(-6)}`}`, `- 会话：${hit.sessionId} · ${hit.role} #${hit.seq}`,
                `- 时间先后：${hit.timing}`, `> ${hit.quote}`, '')
              if (relation) lines.push(`- 关系：${relation.relation}`, `- 说明：${relation.explanation}`, '')
            }
            text = lines.join('\n')
            filename = 'provenance-related-conversations.md'
          } else if (panelTab === 'trace') {
            text = traceMarkdown()
            filename = 'provenance-trace.md'
            if (!text) {
              setNotice(t('还没有溯源结果', 'No trace result yet'))
              window.setTimeout(() => setNotice(''), 2200)
              return
            }
          } else if (panelTab === 'decisions') {
            text = decisionsMarkdown()
            filename = 'provenance-conclusions.md'
          } else if (panelTab === 'assumptions') {
            text = assumptionsMarkdown()
            filename = 'provenance-assumptions.md'
          } else {
            text = notesMarkdown()
            filename = 'provenance-notes.md'
          }
          downloadText(filename, text)
          setNotice(t('已导出 Markdown', 'Markdown exported'))
          window.setTimeout(() => setNotice(''), 2200)
        }

        const copyReport = async () => {
          const text = traceMarkdown()
          if (!text) return
          try {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1600)
          } catch {
            // Clipboard permission can be denied; the button then does nothing.
          }
        }

        const bounceAtEdge = event => {
          const node = bodyRef.current
          if (!node || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
          const atTop = node.scrollTop <= 1 && event.deltaY < 0
          const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1 && event.deltaY > 0
          if ((!atTop && !atBottom) || node.getAnimations().length) return
          const delta = Math.min(9, Math.abs(event.deltaY) * 0.12) * (atTop ? 1 : -1)
          node.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${delta}px)` },
            { transform: `translateY(${-delta * .2}px)` }, { transform: 'translateY(0)' }],
            { duration: 360, easing: 'cubic-bezier(.2,.7,.3,1)' })
        }

        const style = h('style', { key: 'dsp-style' }, STYLES)

        const parts = [style, h(SourceActions, { key: 'source-actions', ctx, en, theme, fontSize, onReturn: backToReading, onNotice: setNotice, showReturn: minimized || mode === 'idle' })]
        const active = mode !== 'idle'

        if (chromeVisible && chatRect) {
          parts.push(h(TraceFrame, { active: active && !closing, key: 'frame', rect: chatRect, host: chatHost }))
        }

        if (chromeVisible) {
          const armed = hintMode === 'armed'
          parts.push(
            h('div', { className: 'dsp-hint' + (active ? ' visible' : ''), key: 'hint',
              style: chatRect ? { left: chatRect.left + chatRect.width / 2, maxWidth: Math.max(0, chatRect.width - 24) } : undefined },
              h('b', null, armed ? '⌘⌥T' : '⌕'),
              ' ',
              armed
                ? t('已进入溯源模式：拖选聊天里的一句话', 'Trace mode: drag across a sentence')
                : t('溯源模式：继续拖选另一句 · 右键 / Esc 退出', 'Trace mode: select another sentence · right-click / Esc to exit'),
              h('button', {
                className: 'dsp-hint-btn',
                type: 'button',
                onClick: close,
                title: t('退出溯源模式（Esc）', 'Exit trace mode (Esc)'),
              }, t('退出 · Esc', 'Exit · Esc')),
            ),
          )
        }


        if (minimized) {
          const pillLabel = result
            ? `⌕ ${t('溯源', 'Trace')} · ${(result.atoms || []).length} ${t('个论断', 'claims')}`
            : mode === 'loading'
              ? `⌕ ${t('溯源中…', 'Tracing…')}`
              : `⌕ ${t('溯源模式运行中', 'Trace mode running')}`
          return h(React.Fragment, null,
            ...parts,
            h('div', { className: 'dsp-pill', key: 'pill' },
              h('button', {
                className: 'dsp-pill-main',
                type: 'button',
                onClick: restore,
                title: t('展开（模式继续运行）', 'Restore (mode stays on)'),
              }, pillLabel),
              h('button', {
                className: 'dsp-pill-x',
                type: 'button',
                onClick: close,
                title: t('退出溯源模式', 'Exit trace mode'),
                'aria-label': t('退出溯源模式', 'Exit trace mode'),
              }, '×'),
            ),
          )
        }

        const idleEmpty = mode === 'idle' && !result && !error

        const sessionNotes = ledger.notes.filter((note) => note.sessionId === sessionId)
        const sessionDecisions = ledger.decisions.filter((item) => item.sessionId === sessionId)
        const sessionAssumptions = ledger.assumptions.filter((item) => item.sessionId === sessionId)
        const sessionTrash = ledger.trash.filter(entry => entry.item.sessionId === sessionId)
        const panelQuery = searchText(panelQueries[panelTab])
        const localMatcher = panelQuery ? literalSearchPattern(panelQuery) : null
        const matchesLocal = text => !localMatcher || localMatcher.test(String(text || ''))
        const visibleNotes = sessionNotes.filter(note => matchesLocal(note.text))
        const visibleDecisions = sessionDecisions.filter(item => matchesLocal([item.claim, ...(item.assumptions || [])].join('\n')))
        const visibleAssumptions = sessionAssumptions.filter(item => matchesLocal([item.text, item.sourceClaim].join('\n')))
        const liveSearch = traceSearch.sessionId === sessionId && traceSearch.query === panelQuery
          ? traceSearch : { ...emptySearch(), status: 'waiting' }
        const tabTitle = showTrash ? t('回收站', 'Recycle bin') : panelTab === 'trace' && traceScope === 'all'
          ? t('跨会话关联', 'Related conversations') : panelTab === 'trace'
          ? panelQuery ? t('查找与溯源', 'Find and trace') : t('这句话的依据', 'Where this came from')
          : panelTab === 'decisions'
            ? t('结论', 'Conclusions')
            : panelTab === 'assumptions'
              ? t('假设', 'Assumptions')
              : t('摘录', 'Notes')
        const tabCount = showTrash ? t(`${sessionTrash.length} 条 · 本对话`, `${sessionTrash.length} · this chat`) : panelTab === 'trace'
          ? panelQuery ? (liveSearch.status === 'ready' ? t(`${liveSearch.total} 条匹配`, `${liveSearch.total} matches`) : null)
            : (result && result.atoms ? t(`${result.atoms.length} 个论断`, `${result.atoms.length} claims`) : null)
          : panelTab === 'decisions'
            ? t(`${sessionDecisions.length} 条`, `${sessionDecisions.length} conclusions`)
            : panelTab === 'assumptions'
              ? t(`${sessionAssumptions.length} 条`, `${sessionAssumptions.length} assumptions`)
              : t(`${sessionNotes.length} 条`, `${sessionNotes.length} notes`)

        if (idleEmpty) {
          return h(React.Fragment, null, ...parts)
        }

        const header = h('div', { className: 'dsp-head', key: 'head' },
          h('span', { className: 'dsp-title' }, tabTitle),
          tabCount && (showTrash || panelTab !== 'trace') ? h('span', { className: 'dsp-count' }, tabCount) : null,
          h('span', { className: 'dsp-head-spacer', key: 'spacer' }),
          h('div', { className: 'dsp-head-actions', key: 'actions' },
            panelTab === 'trace' && !showTrash ? h('button', {
              type: 'button', className: 'dsp-scope', 'aria-pressed': traceScope === 'all',
              'aria-label': t('溯源范围', 'Trace scope'), disabled: !related.hits.length && traceScope !== 'all',
              title: related.hits.length ? t('已发现其他会话的候选关联，点击切换查看。', 'Related passages found in other sessions. Click to view.')
                : related.status === 'loading' ? t('正在本地检索其他会话，不调用模型。', 'Searching other sessions locally, without a model.')
                : related.status === 'error' || related.status === 'unavailable' ? related.error
                : related.failedSessions ? t('部分会话未能读取，暂未找到候选。', 'Some sessions could not be read; no candidates found.')
                : relatedSelection ? t('暂未找到其他会话的相关候选。', 'No related passages found in other sessions.') : t('选中一句话后自动查找关联。', 'Select a passage to find related sessions.'),
              onClick: () => setTraceScope(value => value === 'all' ? 'session' : 'all'),
            }, t(traceScope === 'all' ? '全对话' : '本对话', traceScope === 'all' ? 'All chats' : 'This chat'),
              h('span', { className: 'dsp-related-dot' + (related.hits.length ? ' found' : related.status === 'loading' ? ' searching' : ''), 'aria-hidden': true }),
              h('span', { 'aria-hidden': true }, '⌄')) : null,
            h('button', {
              className: 'dsp-x dsp-trash-toggle', type: 'button',
              'aria-label': t('回收站', 'Recycle bin'), 'aria-pressed': showTrash,
              title: t('回收站：找回删除的内容', 'Recycle bin: restore deleted items'),
              onClick: () => setShowTrash(value => !value),
            }, h('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
              h('path', { d: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7' }))),
            h(SettingsMenu, { key: 'settings' }),
            h('button', {
              className: 'dsp-x',
              onClick: minimize,
              title: t('收起', 'Minimize'),
              'aria-label': t('收起', 'Minimize'),
            },
              h('svg', {
                viewBox: '0 0 24 24', width: 15, height: 15,
                fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
              }, h('path', { d: 'M5 12h14' }))),
            h('button', { className: 'dsp-x dsp-close', onClick: close, title: t('关闭', 'Close'), 'aria-label': t('关闭', 'Close') },
              h('svg', {
                viewBox: '0 0 24 24', width: 15, height: 15,
                fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
              }, h('path', { d: 'M6 6l12 12M18 6L6 18' }))),
          ),
        )

        const body = []
        const isAnalyzing = mode === 'loading' || extra?.status === 'loading' || relations.status === 'loading'
        const cancelControl = h('button', { type: 'button', className: 'dsp-btn danger dsp-cancel-analysis', onClick: cancelAnalysis,
          title: t('中断正在进行的分析请求', 'Stop the active analysis request') }, t('取消分析', 'Cancel analysis'))

        if (claim) {
          body.push(h(CollapsibleText, { text: claim, en, variant: 'claim', key: `claim-${claim}` }))
          body.push(
            h('div', { key: 'claim-actions', className: 'dsp-claim-actions' },
              h('button', {
                className: 'dsp-btn',
                type: 'button',
                disabled: noteSaved,
                onClick: saveNote,
                title: t('把选中的话存进「档案 → 摘录」', 'Save this passage to Archive → Notes'),
              }, noteSaved ? t('已存笔记', 'Note saved') : t('存为笔记', 'Save as note')),
              isAnalyzing ? cancelControl : null,
            ),
          )
        }

        if (result) {
          body.push(h(TraceTools, { key: 'trace-tools', en, filter, onFilter: setFilter,
            timeline: buildTimeline(result),
            onJump: node => void jumpTo({ seq: node.seq, quote: node.quote }, keywordsFor(result, node.seq)),
            assumptions: result.assumptions || [], assumptionsSaved: assumptionsSaved || Boolean(pinnedId),
            onSaveAssumptions: saveAssumptionsOnly,
          }))
        }

        if (mode === 'loading') {
          body.push(
            h('div', { className: 'dsp-note', key: 'loading', style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              h(LoadingSpinner),
              t(`正在回看前面的对话… ${elapsed}s`, `Reading back through the conversation… ${elapsed}s`),
            ),
          )
        }

        if (error) {
          body.push(
            h('div', { key: 'err', style: { color: 'var(--dsw-alias-state-error-primary)' } },
              t('分析失败：', 'Could not analyze: '),
              error,
            ),
            h('div', { key: 'err-hint', className: 'dsp-note' },
              errorHint,
            ),
          )
        }

        if (result) {
          if (result.claim && result.claim.resolved === false) {
            body.push(
              h('div', { key: 'unresolved', className: 'dsp-note' },
                t('这句话没能在会话日志里定位，仅按选区内容分析。', 'That sentence was not found in the session log; analyzed from the selection alone.'),
              ),
            )
          }
          for (const [index, atom] of orderAtoms(result.atoms).entries()) {
            const evidence = atom.evidence || []
            const visible = filter === 'all' ? evidence : evidence.filter((item) => item.role === filter)
            body.push(
              h('div', { className: `dsp-atom ${atom.relation}`, key: `atom-${index}` },
                h('div', { className: 'dsp-atom-text' },
                  h('span', { className: `dsp-rel ${atom.relation}` }, relationLabel(atom.relation, t)),
                  atom.text,
                ),
                evidence.length === 0
                  ? h('div', { className: 'dsp-unsupported' },
                      t('未找到依据——这句可能是模型自行补充的。', 'No supporting source found — the model may have added this itself.'),
                    )
                  : visible.length === 0
                    ? h('div', { className: 'dsp-note' },
                        t('该论断没有这类依据。', 'No source of this kind for this claim.'))
                    : visible.map((item, i) =>
                      h('div', {
                        key: `ev-${index}-${i}`,
                        'data-dsp-jump': '',
                        className: 'dsp-ev' + (flagged.has(evidenceKey(item)) ? ' flagged' : ''),
                        role: 'button',
                        tabIndex: 0,
                        onClick: () => void jumpTo(item, atom.keywords),
                        onKeyDown: (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            void jumpTo(item, atom.keywords)
                          }
                        },
                        title: t('点击跳到原文', 'Jump to the source'),
                      },
                        h('div', { className: 'dsp-ev-head' },
                          h('span', { className: 'dsp-ev-role', title: `${roleLabel(item.role, t)} · #${item.seq}${item.turn ? ` · ${t('轮次', 'Turn')} ${item.turn}` : ''}` }, item.role === 'assistant' ? t('AI 回答', 'AI reply') : roleLabel(item.role, t)),
                          item.strength === 'partial' ? h('span', null, t('部分', 'partial')) : null,
                          item.url
                            ? h('a', {
                                className: 'dsp-ev-site',
                                href: deepLink(item.url, item.quote),
                                target: '_blank',
                                rel: 'noreferrer noopener',
                                onClick: (event) => event.stopPropagation(),
                                title: t('打开网页并定位到这句', 'Open the page at this sentence'),
                              }, `↗ ${item.site || 'web'}`)
                            : null,
                          h('button', {
                            className: 'dsp-flag' + (flagged.has(evidenceKey(item)) ? ' on' : ''),
                            type: 'button',
                            style: { marginLeft: item.url ? '6px' : 'auto' },
                            title: t('标记这条依据不准确', 'Mark this source as wrong'),
                            onClick: (event) => {
                              event.stopPropagation()
                              toggleFlag(item)
                            },
                            onKeyDown: (event) => event.stopPropagation(),
                          }, flagged.has(evidenceKey(item)) ? t('已标不准', 'Flagged') : t('不准', 'Wrong')),
                        ),
                        h(EvidenceQuote, { text: item.quote, en }),
                        item.why ? h('div', { className: 'dsp-ev-why' }, h('span', { className: 'dsp-why-label' }, t('关联理由', 'Why related')), item.why) : null,
                      ),
                    ),
                atom.note ? h('div', { className: 'dsp-note' }, atom.note) : null,
              ),
            )
          }

          if (original) {
            body.push(
              h('div', { key: 'original', className: 'dsp-original' },
                h('div', { className: 'dsp-extra-title' },
                  original.seq
                    ? t(`原文 · #${original.seq}（不在当前视图）`, `Original · #${original.seq} (not in view)`)
                    : t('原文（不在当前视图）', 'Original (not in view)')),
                h('div', { style: { marginTop: '6px' } },
                  original.text
                    ? renderMarked(original.text, original.quote)
                    : t('（该消息没有可显示的文本）', '(no displayable text)')),
              ),
            )
          }

          if (extra) {
            const items = [
              h('div', { key: 'x-title', className: 'dsp-extra-title' },
                t('同领域补充来源 · AI 当时未使用', 'Same-field sources · not used by the AI')),
            ]
            if (extra.status === 'loading') {
              items.push(
                h('div', { key: 'x-loading', className: 'dsp-note', style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                  h(LoadingSpinner),
                  t('正在检索并抓取网页…', 'Searching and fetching pages…')),
              )
            } else if (extra.status === 'error') {
              items.push(h('div', { key: 'x-err', className: 'dsp-note' },
                t('检索失败：', 'Search failed: '), extra.error))
            } else {
              for (const [i, source] of (extra.sources || []).entries()) {
                items.push(
                  h('div', { key: `x-${i}`, className: 'dsp-ev', style: { cursor: 'default' } },
                    h('div', { className: 'dsp-ev-head' },
                      h('span', { className: 'dsp-ev-role' }, source.site || 'web'),
                      h('a', {
                        className: 'dsp-ev-site',
                        href: deepLink(source.url, source.quote),
                        target: '_blank',
                        rel: 'noreferrer noopener',
                      }, '↗ ' + t('打开原句', 'Open')),
                    ),
                    h(EvidenceQuote, { text: source.quote, en }),
                    source.why ? h('div', { className: 'dsp-ev-why' }, source.why) : null,
                  ),
                )
              }
            }
            body.push(h('div', { key: 'extra', className: 'dsp-extra' }, ...items))
          }
        }

        const STATUS_LABELS = [
          ['open', t('待确认', 'Open')],
          ['confirmed', t('确认', 'Confirm')],
          ['rejected', t('否决', 'Reject')],
        ]

        const tabs = h('div', { key: 'panel-tabs', className: 'dsp-tabbar' },
          h(ReorderableTabs, {
            items: [
              { id: 'trace', label: t('溯源', 'Trace') },
              { id: 'decisions', label: `${t('结论', 'Conclusions')} · ${sessionDecisions.length}` },
              { id: 'assumptions', label: `${t('假设', 'Assumptions')} · ${sessionAssumptions.length}` },
              { id: 'notes', label: `${t('摘录', 'Notes')} · ${sessionNotes.length}` },
            ],
            active: panelTab, onSelect: value => { setPanelTab(value); setShowTrash(false); setRecycleStatus(''); bodyRef.current?.scrollTo({ top: 0 }) }, en,
          }),
          h('button', {
            className: 'dsp-tab-export',
            type: 'button',
            onClick: exportActive,
            title: t('导出当前选项卡为 Markdown', 'Export this tab as Markdown'),
          }, t('导出', 'Export')),
        )

        if (panelTab === 'notes') {
          body.length = 0
          if (sessionNotes.length === 0) {
            body.push(h('div', { key: 'notes-empty', className: 'dsp-note' },
              t('还没有摘录。框选一句话，点「存为笔记」。', 'No notes yet. Select a passage and choose “Save as note”.')))
          } else {
            for (const note of visibleNotes) {
              body.push(
                h('div', { key: note.id, className: 'dsp-note-item' },
                  h(CollapsibleText, { text: note.text, en, variant: 'record', content: markedSearchText(note.text, panelQuery),
                    metadata: h('div', { className: 'dsp-note-meta' },
                      h(CompactMeta, { time: note.createdAt, role: note.role, seq: note.seq, sessionId: note.sessionId, en }),
                    ),
                  }),
                  h('div', { className: 'dsp-note-actions' },
                    h('button', { className: 'dsp-btn', type: 'button', disabled: Boolean(note.sessionId && note.sessionId !== sessionId), 'data-dsp-jump': '', onClick: () => jumpToNote(note) }, t('跳转原文', 'Jump')),
                    h('button', { className: 'dsp-btn danger', type: 'button', onClick: () => removeNote(note.id) }, t('删除', 'Delete')),
                  ),
                ),
              )
            }
          }
        } else if (panelTab === 'decisions') {
          body.length = 0
          if (sessionDecisions.length === 0) {
            body.push(h('div', { key: 'decisions-empty', className: 'dsp-note' },
              t('还没有结论。在溯源结果里点「存档这条结论」。', 'No conclusions yet. Trace a sentence and archive it.')))
          } else {
            for (const decision of visibleDecisions) {
              const evidenceCount = (decision.atoms || []).reduce((sum, atom) => sum + (atom.evidence ? atom.evidence.length : 0), 0)
              body.push(
                h('div', { key: decision.id, className: 'dsp-note-item' },
                  h(CollapsibleText, { text: decision.claim, en, variant: 'record', style: { fontWeight: 600 }, content: markedSearchText(decision.claim, panelQuery),
                    metadata: h('div', { className: 'dsp-note-meta' },
                      h(CompactMeta, { time: decision.createdAt, seq: decision.claimSeq, sessionId: decision.sessionId, en }),
                      ` · ${evidenceCount} ${t('条依据', 'sources')}`,
                      decision.status === 'revoked' ? ` · ${t('已撤销', 'revoked')}` : '',
                    ),
                  }),
                  (decision.assumptions || []).length > 0
                    ? h(CollapsibleText, { text: decision.assumptions.join('\n'), en, variant: 'record', className: 'dsp-asm', content: markedSearchText(decision.assumptions.join('\n'), panelQuery) })
                    : null,
                  h('div', { className: 'dsp-note-actions' },
                    h('button', { className: 'dsp-btn', type: 'button', 'data-dsp-jump': '', onClick: () => runJump(decision.claim, decision.claimSeq, decision.sessionId) }, t('跳转原文', 'Jump')),
                    h('button', { className: 'dsp-btn', type: 'button', onClick: () => togglePanelDecision(decision.id) }, decision.status === 'revoked' ? t('恢复', 'Restore') : t('撤销', 'Revoke')),
                    h('button', { className: 'dsp-btn danger', type: 'button', onClick: () => removePanelDecision(decision.id) }, t('删除', 'Delete')),
                  ),
                ),
              )
            }
          }
        } else if (panelTab === 'assumptions') {
          body.length = 0
          if (sessionAssumptions.length === 0) {
            body.push(h('div', { key: 'assumptions-empty', className: 'dsp-note' },
              t('还没有假设。溯源时模型会列出结论依赖但未证实的前提。', 'No assumptions yet. A trace records premises the answer relies on.')))
          } else {
            for (const item of visibleAssumptions) {
              body.push(
                h('div', { key: item.id, className: 'dsp-note-item' },
                  h(CollapsibleText, { text: item.text, en, variant: 'record', content: markedSearchText(item.text, panelQuery) }),
                  item.sourceClaim
                    ? h(CollapsibleText, { text: `${t('来源', 'From')}：${item.sourceClaim}`, en, variant: 'record', className: 'dsp-note-meta', content: markedSearchText(`${t('来源', 'From')}：${item.sourceClaim}`, panelQuery) })
                    : null,
                  h('div', { className: 'dsp-note-actions' },
                    ...STATUS_LABELS.map(([value, label]) =>
                      h('button', {
                        key: value,
                        className: 'dsp-btn' + (item.status === value ? ' active' : ''),
                        type: 'button',
                        onClick: () => setPanelAssumptionStatus(item.id, value),
                      }, label)),
                    h('button', { className: 'dsp-btn danger', type: 'button', onClick: () => removePanelAssumption(item.id) }, t('删除', 'Delete')),
                  ),
                ),
              )
            }
          }
        } else if (!result && !error && mode !== 'loading') {
          body.push(h('div', { key: 'placeholder', className: 'dsp-note' },
            t('拖选聊天里的一句话开始溯源。', 'Select a sentence in the chat to trace it.')))
        }

        if (panelTab !== 'trace' && panelQuery &&
            !(panelTab === 'notes' ? visibleNotes.length : panelTab === 'decisions' ? visibleDecisions.length : visibleAssumptions.length)) {
          body.push(h('div', { key: 'no-local-matches', className: 'dsp-note' },
            t('当前标签没有匹配内容。可以换个词，或去当前对话里找。', 'No matches in this tab. Try another phrase or search the current chat.')),
            h('button', { key: 'search-in-chat', className: 'dsp-btn', type: 'button', onClick: () => {
              setPanelQueries(current => ({ ...current, trace: panelQuery })); setSearchOffset(0); setPanelTab('trace')
            } }, t('去对话里找', 'Search in chat')))
        }

        if (panelTab === 'trace' && panelQuery) {
          body.length = 0
          const status = liveSearch.status
          body.push(h('div', { key: 'search-summary', className: 'dsp-coverage', role: 'status' },
            status === 'waiting' ? t('输入停顿后查找当前对话…', 'Searching after you finish typing…')
              : status === 'loading' ? t('正在查找当前对话…', 'Searching this conversation…')
              : status === 'error' ? liveSearch.error
              : t(`找到 ${liveSearch.total} 条匹配消息 · 扫描 ${liveSearch.scannedMessages} 条`,
                `${liveSearch.total} matching messages · ${liveSearch.scannedMessages} scanned`)))
          if (status === 'ready') {
            body.push(h('div', { key: 'search-explainer', className: 'dsp-note' },
              t('间接溯源：先定位词句，再按需分析依据。搜索本身不调用模型。', 'Find a passage, then trace its basis if needed. Search itself does not call a model.')))
            body.push(h('div', { key: 'search-results', className: 'dsp-search-results' },
              ...liveSearch.hits.map((hit, index) => h('div', { key: hit.seq,
                className: 'dsp-search-result' + (liveSearch.selected === index ? ' selected' : '') },
                h('button', { type: 'button', className: 'dsp-search-hit', onClick: () => {
                  setTraceSearch(current => ({ ...current, selected: index }))
                  void runEvidenceJump(hit.quote, hit.seq, sessionId, [], hit, { search: true })
                } },
                  h('small', null, `${roleLabel(hit.role, t)} · #${hit.seq}${hit.turn ? ` · ${t('第', 'Turn ')}${hit.turn}${t('轮', '')}` : ''}`),
                  hit.clippedBefore ? '…' : '', markedSearchText(hit.excerpt, panelQuery), hit.clippedAfter ? '…' : ''),
                h('div', { className: 'dsp-note-actions' },
                  h('button', { type: 'button', className: 'dsp-btn', onClick: () => void runTrace(hit.traceQuote, hit.traceQuote, hit) }, t('溯源这段', 'Trace this passage'))))),
            ))
            if (!liveSearch.total) body.push(h('div', { key: 'search-no-hits', className: 'dsp-note' },
              t('当前对话没有匹配这段词句。可缩短词句后再试；这是文本匹配，不是语义问答。', 'No exact text match in this conversation. Try a shorter phrase; this is text search, not semantic Q&A.')))
            if (liveSearch.offset > 0 || liveSearch.hasMore) body.push(h('div', { key: 'search-pages', className: 'dsp-search-pager' },
              h('button', { type: 'button', className: 'dsp-btn', disabled: liveSearch.offset === 0,
                onClick: () => { bodyRef.current?.scrollTo({ top: 0 }); setSearchOffset(Math.max(0, liveSearch.offset - liveSearch.limit)) } }, t('上一页', 'Previous page')),
              h('span', { className: 'dsp-note' }, `${liveSearch.offset + 1}–${liveSearch.offset + liveSearch.hits.length} / ${liveSearch.total}`),
              h('button', { type: 'button', className: 'dsp-btn', disabled: !liveSearch.hasMore,
                onClick: () => { bodyRef.current?.scrollTo({ top: 0 }); setSearchOffset(liveSearch.offset + liveSearch.limit) } }, t('下一页', 'Next page'))))
          }
        }


        const localTotal = panelTab === 'notes' ? sessionNotes.length : panelTab === 'decisions' ? sessionDecisions.length : sessionAssumptions.length
        const localVisible = panelTab === 'notes' ? visibleNotes.length : panelTab === 'decisions' ? visibleDecisions.length : visibleAssumptions.length
        const searchScope = panelTab === 'trace' ? t('当前对话', 'this conversation')
          : panelTab === 'notes' ? t('当前摘录', 'these notes')
          : panelTab === 'decisions' ? t('当前结论', 'these conclusions') : t('当前假设', 'these assumptions')
        const searchDock = h(PanelSearchDock, { key: `panel-search-${panelTab}`, value: panelQueries[panelTab],
          en, placeholder: t(`搜索${searchScope}…`, `Search ${searchScope}…`),
          label: panelTab === 'trace' ? t('在对话里查找词句', 'Find a passage in this chat')
            : t(`${localVisible}${panelQuery ? ` / ${localTotal}` : ''} 条${panelTab === 'notes' ? '摘录' : panelTab === 'decisions' ? '结论' : '假设'}`,
              `${localVisible}${panelQuery ? ` / ${localTotal}` : ''} ${panelTab === 'notes' ? 'notes' : panelTab}`),
          count: panelQuery ? panelTab === 'trace'
            ? liveSearch.status === 'ready' ? `${liveSearch.total} ${t('条', 'hits')}` : liveSearch.status === 'error' ? '!' : '…'
            : `${localVisible}/${localTotal}` : '',
          onChange: value => { setPanelQueries(current => ({ ...current, [panelTab]: value })); if (panelTab === 'trace') setSearchOffset(0) },
          onComposing: setSearchComposing,
        })

        // Keep the input in one stable parent while entering/leaving search.
        const footer = panelTab !== 'trace'
          ? null
          : h('div', { className: 'dsp-foot dsp-foot-result', key: 'foot' },
                h('div', { className: 'dsp-foot-top' },
                  h('div', { className: 'dsp-foot-aux' },
                    !panelQuery && (pinnedId || assumptionsSaved)
                      ? h('button', { className: 'dsp-btn', type: 'button', onClick: goArchive },
                          t('查看档案', 'Archive'))
                      : null,
                    !panelQuery && result && original && (result.atoms || []).length === 0
                      ? h('button', {
                          className: 'dsp-btn',
                          type: 'button',
                          onClick: () => {
                            openChat(ctx, sessionId)
                            clickChatTab()
                          },
                        }, t('打开对话', 'Open chat'))
                      : null,
                  ),
                  h('span', { className: 'dsp-foot-divider', 'aria-hidden': true }),
                  searchDock,
                ),
                !panelQuery && (result || error) ? h('div', { className: 'dsp-foot-grid' },
                  h('button', {
                    className: 'dsp-btn dsp-foot-cell',
                    type: 'button',
                    disabled: !result,
                    onClick: () => void copyReport(),
                  }, copied ? t('已复制', 'Copied') : t('复制报告', 'Copy report')),
                  h('button', {
                    className: 'dsp-btn dsp-foot-cell',
                    type: 'button',
                    disabled: !result || Boolean(extra),
                    onClick: () => void runCorroborate(),
                  }, extra ? t('已补充检索', 'Sources added') : t('补充检索网页', 'Search the web')),
                  h('button', {
                    className: 'dsp-btn dsp-foot-cell',
                    type: 'button',
                    disabled: mode === 'loading',
                    onClick: () => void runTrace(claim),
                  }, t('重新分析', 'Analyze again')),
                  h('button', {
                    className: 'dsp-btn primary dsp-foot-cell',
                    type: 'button',
                    disabled: !result || Boolean(pinnedId),
                    onClick: pinDecision,
                  }, pinnedId ? t('已归档', 'Archived') : t('存档这条结论', 'Archive this conclusion')),
                ) : null,
              )

        if (panelTab === 'trace' && !panelQuery && result?.meta?.retrieval) body.push(h('div', { className: 'dsp-coverage', key: 'coverage' }, t(`全文扫描 ${result.meta.retrieval.scannedMessages} 条 · 模型核对 ${result.meta.retrieval.selectedPassages} 个片段。无共享词的语义关联可能漏检。`, `Scanned ${result.meta.retrieval.scannedMessages} messages; verified ${result.meta.retrieval.selectedPassages} passages. Semantic matches without shared terms may be missed.`)))

        const inRelated = panelTab === 'trace' && traceScope === 'all' && !showTrash
        const relationLabels = {
          similar: t('相似观点', 'Similar view'), supports: t('补充支持', 'Supporting context'),
          changes: t('观点变化', 'Changed view'), contradicts: t('可能矛盾', 'Possible contradiction'),
          unrelated: t('未确认关联', 'No confirmed connection'),
        }
        const retryRelated = () => { setRelations({ status: 'idle', items: [] }); setRelatedRetry(value => value + 1) }
        const relatedIssue = related.status === 'error' || related.status === 'unavailable' || related.failedSessions > 0
        if (inRelated) {
          body.length = 0
          body.push(
            h(CollapsibleText, { text: claim, en, variant: 'claim', key: `related-claim-${claim}` }),
            isAnalyzing ? h('div', { key: 'related-cancel', className: 'dsp-claim-actions' }, cancelControl) : null,
            h('div', { key: 'related-description', className: 'dsp-note' },
              t('这些是其他会话中的候选关联，不代表 AI 当时引用过它们。先看原文，需要时再分析关系。',
                'These are related passages from other sessions, not proof that the AI originally used them. Review the sources before analyzing.')),
            h('div', { key: 'related-progress', className: 'dsp-note', role: 'status', 'aria-live': 'polite' },
              t(`${related.status === 'loading' ? '正在本地查找' : '本地查找'} · ${related.scannedSessions || 0} / ${related.totalSessions || 0} 个其他会话 · ${related.hits.length} 条候选`,
                `${related.status === 'loading' ? 'Searching locally' : 'Local search'} · ${related.scannedSessions || 0} / ${related.totalSessions || 0} other sessions · ${related.hits.length} candidates`)),
            h('div', { key: 'related-tools', className: 'dsp-related-tools' },
              h('button', { type: 'button', className: 'dsp-btn primary dsp-analyze-relations',
                disabled: !related.hits.length || relations.status === 'loading', onClick: () => void analyzeRelated() },
                relations.status === 'loading' ? t('正在分析关系…', 'Analyzing connections…')
                  : relations.status === 'done' ? t('重新分析关系', 'Analyze connections again') : t('分析关系', 'Analyze connections')),
              h('button', { type: 'button', className: 'dsp-btn', disabled: related.status === 'loading', onClick: retryRelated }, t('重新查找', 'Search again'))),
            h('div', { key: 'related-budget', className: 'dsp-note' },
              t('本地查找和切换不调用模型。仅点「分析关系」才使用模型；最多 6 条候选，额外片段合计不超过 6,000 字节。',
                'Search and switching do not call a model. Analyze connections sends up to 6 candidates, with at most 6,000 bytes of extra passages.')),
          )
          if (relatedIssue) body.push(h('div', { key: 'related-error', className: 'dsp-note', role: 'status' },
            related.error || t(`${related.failedSessions} 个会话未能读取，结果可能不完整。`, `${related.failedSessions} sessions could not be read. Results may be incomplete.`)))
          if (relations.status === 'error') body.push(h('div', { key: 'relations-error', className: 'dsp-note', role: 'status' }, relations.error))
          if (relations.status === 'done' && !relations.items.length) body.push(h('div', { key: 'relations-empty', className: 'dsp-note' }, t('模型未返回可核验的关系判断，可继续查看候选原文。', 'The model returned no verifiable connection. You can still review the candidate sources.')))
          if (relations.meta?.claimTruncated) body.push(h('div', { key: 'relations-clipped', className: 'dsp-note' }, t('选句较长，本次关系分析只使用预算内的选句开头。', 'The selection was long; this analysis used its opening within the input budget.')))
          for (const hit of related.hits) {
            const relation = relations.items.find(item => item.id === hit.id)
            body.push(h('div', { key: `related-${hit.id}`, className: 'dsp-note-item dsp-related-item' },
              h('div', { className: 'dsp-related-title' }, hit.title || t(`会话 #${hit.sessionId.slice(-6)}`, `Conversation #${hit.sessionId.slice(-6)}`)),
              h('div', { className: 'dsp-related-meta' }, h(CompactMeta, { time: hit.time, role: hit.role, seq: hit.seq, sessionId: hit.sessionId, en }),
                h('span', null, hit.timing === 'after' ? t('晚于本条，不能作为当时的依据', 'Later than this passage; cannot be an earlier source')
                  : hit.timing === 'before' ? t('早于本条', 'Earlier than this passage') : t('先后时间待确认', 'Relative time unknown'))),
              h('div', { className: 'dsp-note-text' }, hit.quote),
              relation ? h('div', { className: `dsp-related-explanation ${relation.relation}` },
                h('b', { className: 'dsp-related-relation' }, `${relationLabels[relation.relation]} · `), relation.explanation) : null,
              h('div', { className: 'dsp-note-actions' }, h('button', { type: 'button', className: 'dsp-btn dsp-open-related', 'data-dsp-jump': '',
                onClick: () => openRelated(hit) }, t('打开会话并定位', 'Open source conversation'))),
            ))
          }
        } else if (panelTab === 'trace' && !panelQuery && relatedIssue) {
          body.push(h('div', { key: 'related-status', className: 'dsp-note', role: 'status' },
            related.error || t('部分会话未能读取，关联检索可能不完整。', 'Some sessions could not be read. Related results may be incomplete.'), ' ',
            h('button', { className: 'dsp-btn', type: 'button', onClick: retryRelated }, t('重试关联检索', 'Retry related search'))))
        }

        if (showTrash) {
          body.length = 0
          body.push(
            h('button', { key: 'trash-back', className: 'dsp-btn', type: 'button',
              style: { alignSelf: 'flex-start' }, onClick: () => setShowTrash(false) }, t('← 返回', '← Back')),
            h(RecycleBin, { key: 'trash', entries: sessionTrash, en, onRestore: restoreItem }),
          )
        }

        parts.push(
          h('div', {
            className: 'dsp-card' + ((closing || collapsing) ? ' dsp-closing' : ''),
            key: 'card',
            role: 'region',
            'aria-label': t('上下文溯源', 'Context provenance'),
            style: {
              ...themeVars(theme),
              ...fontVars(fontSize),
              width: size.w,
              maxWidth: 'calc(100vw - 40px)',
              ...(size.h ? { height: size.h } : {}),
            },
          },
            h(AnalysisAtmosphere, { key: 'thinking', active: thinkingEffects && isAnalyzing && panelTab === 'trace' && !showTrash && !panelQuery }),
            header,
            recycleStatus ? h('div', { className: 'dsp-toast', key: 'recycle-status', role: 'status' }, recycleStatus)
              : notice || reading.history.length ? h('div', { className: 'dsp-toast dsp-reading-notice', key: 'toast' },
                reading.history.length ? h('button', { type: 'button', className: 'dsp-btn dsp-back-reading',
                  disabled: reading.returning, onClick: backToReading }, reading.returning ? t('正在返回…', 'Returning…') : t('↶ 返回刚才的位置', '↶ Back to reading')) : null,
                notice ? h('span', { role: 'status' }, notice) : null) : null,
            showTrash ? null : tabs,
            h('div', { className: 'dsp-body', ref: bodyRef, onWheel: bounceAtEdge }, ...body),
            showTrash || inRelated ? null : footer,
            showTrash || panelTab === 'trace' ? null : searchDock,
            h('div', {
              key: 'resize',
              className: 'dsp-resize',
              onPointerDown: startResize,
              onDoubleClick: resetSize,
              title: t('拖动调整大小，双击复位', 'Drag to resize, double-click to reset'),
            }),
          ),
        )

        return h(React.Fragment, null, ...parts)
      }
    }

    function orderAtoms(atoms) {
      const rank = { direct: 0, inference: 1, merge: 2, assumption: 3, unsupported: 4 }
      return [...(atoms || [])].sort(
        (left, right) => (rank[left.relation] ?? 9) - (rank[right.relation] ?? 9),
      )
    }

    function relationLabel(relation, t) {
      switch (relation) {
        case 'direct': return t('直接依据', 'Direct basis')
        case 'inference': return t('推论', 'Inference')
        case 'merge': return t('合并多条', 'Merged')
        case 'assumption': return t('模型假设', 'Assumption')
        default: return t('未找到依据', 'Unsupported')
      }
    }

    function roleLabel(role, t) {
      if (role === 'user') return t('你的原话', 'Your words')
      if (role === 'assistant') return t('我之前的结论', 'Earlier conclusion')
      return t('外部材料', 'External material')
    }

    function compactDate(value, en, now = new Date()) {
      const date = new Date(value == null || value === '' ? NaN : value)
      if (!Number.isFinite(date.getTime())) return en ? 'Unknown time' : '时间未知'
      const sameDay = (left, right) => left.getFullYear() === right.getFullYear()
        && left.getMonth() === right.getMonth() && left.getDate() === right.getDate()
      const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1)
      const clock = date.toLocaleTimeString(en ? 'en-GB' : 'zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
      const day = sameDay(date, now) ? (en ? 'Today' : '今天')
        : sameDay(date, yesterday) ? (en ? 'Yesterday' : '昨天')
        : date.toLocaleDateString(en ? 'en-GB' : 'zh-CN', { ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}), month: 'numeric', day: 'numeric' })
      return `${day} ${clock}`
    }

    function compactMeta({ time, role, seq, sessionId, en, prefix = '' }) {
      const shortRole = role === 'assistant' ? (en ? 'AI reply' : 'AI 回答')
        : role === 'user' ? (en ? 'Your words' : '你的话') : role ? (en ? 'Tool material' : '工具材料') : ''
      const date = new Date(time == null || time === '' ? NaN : time)
      const fullDate = Number.isFinite(date.getTime())
        ? date.toLocaleString(en ? 'en-GB' : 'zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
        : en ? 'Unknown time' : '时间未知'
      return {
        label: [prefix + compactDate(time, en), shortRole].filter(Boolean).join(' · '),
        title: [prefix + fullDate, shortRole, seq != null ? `${en ? 'Message' : '消息'} #${seq}` : '',
          sessionId ? `${en ? 'Session' : '会话'} ${sessionId}` : ''].filter(Boolean).join(' · '),
      }
    }

    function CompactMeta({ time, role, seq, sessionId, en, prefix, className }) {
      const meta = compactMeta({ time, role, seq, sessionId, en, prefix })
      return h('span', { className, title: meta.title }, meta.label)
    }

    function EvidenceQuote(props) {
      return h(CollapsibleText, props)
    }

    function CollapsibleText({ text, en, variant = 'evidence', content, className, style, metadata }) {
      const isClaim = variant === 'claim'
      const isRecord = variant === 'record'
      const quoteId = React.useId()
      const ref = React.useRef(null)
      const [expanded, setExpanded] = React.useState(false)
      const [overflow, setOverflow] = React.useState(false)
      React.useEffect(() => setExpanded(false), [text])
      React.useLayoutEffect(() => {
        const element = ref.current
        if (!element || expanded) return
        const measure = () => setOverflow(element.scrollHeight > element.clientHeight + 1)
        measure()
        if (typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(measure); observer.observe(element)
        return () => observer.disconnect()
      }, [text, expanded])
      const toggle = overflow || expanded ? h('button', { type: 'button', className: 'dsp-quote-toggle' + (isClaim ? ' dsp-claim-toggle' : isRecord ? ' dsp-record-toggle' : ''), 'aria-expanded': expanded, 'aria-controls': quoteId,
          title: isRecord ? (en ? 'Show or hide the full text' : '查看或收起全文') : isClaim ? (en ? 'Show or hide the full selected passage' : '展开或收起完整选文') : (en ? 'Expand or collapse the quote without jumping' : '仅展开或收起引文，不跳转'),
          onClick: event => { event.stopPropagation(); setExpanded(value => !value) },
          onKeyDown: event => event.stopPropagation() }, expanded ? (en ? 'Collapse' : '收起') : isRecord ? (en ? 'View full text' : '查看全文') : isClaim ? (en ? 'Expand selection' : '展开原文') : (en ? 'Expand quote' : '展开引文')) : null
      return h('div', { className: isClaim ? 'dsp-claim dsp-claim-preview' : isRecord ? 'dsp-record-preview' : 'dsp-quote-wrap' },
        h('div', { ref, id: quoteId, className: (isClaim ? 'dsp-claim-text' : isRecord ? `${className || 'dsp-note-text'} dsp-record-text` : 'dsp-ev-quote') + (expanded ? ' expanded' : ' clamped'), style }, isRecord ? (content ?? text) : `「${text}」`),
        isRecord ? (metadata || toggle ? h('div', { className: 'dsp-record-row' }, metadata, toggle) : null) : toggle,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Sits in the composer's right-hand control row, immediately before
        // the submit action — the same place people look when they finish a turn.
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            { name: 'conversation.input.right', id: 'dsh-provenance', order: 10 },
            createTrigger(ctx),
          ),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-provenance', order: 60 },
            createPanel(ctx),
          ),
        )
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: 'ledger',
              order: 40,
              label: () => (isEnglish(ctx) ? 'Archive' : '档案'),
            },
            createLedger(ctx),
          ),
        )
      },
    }
  },
})
