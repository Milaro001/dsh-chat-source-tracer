import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
function load() {
  const browser = { __ModuleLoader__: { load({ factory }) { factory(() => ({})) } } }
  vm.runInNewContext(source.replace("    return {\n      inject: ['slots'],",
    "    window.readingTest = { compactDate, compactMeta, insertSourceDraft, sessionStore };\n    return {\n      inject: ['slots'],"), { window: browser })
  assert.ok(browser.readingTest)
  return browser.readingTest
}

test('compact dates handle yesterday across year boundaries and preserve seconds and IDs in the tooltip', () => {
  const api = load()
  const now = new Date(2026, 0, 1, 12, 0, 0)
  assert.match(api.compactDate(new Date(2026, 0, 1, 11, 27), false, now), /^今天 11:27$/)
  assert.match(api.compactDate(new Date(2025, 11, 31, 11, 27), false, now), /^昨天 11:27$/)
  assert.match(api.compactDate(new Date(2024, 9, 20), false, now), /2024/)
  assert.equal(api.compactDate(null, false), '时间未知')
  const meta = api.compactMeta({ time: new Date(2026, 0, 1, 11, 27, 39), role: 'assistant', seq: 807, sessionId: 'synthetic', en: false })
  assert.match(meta.label, /AI 回答/)
  assert.doesNotMatch(meta.label, /807|synthetic|:39/)
  assert.match(meta.title, /11:27:39.*消息 #807.*synthetic/)
})

function composer(api, options = {}) {
  const state = { draft: '已经写好的问题', draftRev: 7, attachmentIds: ['existing-file'], phase: 'idle', ...options }
  let inserted = null
  let focused = false
  let submitted = false
  const shell = { state: { getSnapshot: () => state }, actions: {
    captureInsertion: () => ({ start: 1, end: 4, draftRev: 7 }),
    insertText(text, span) {
      if (span.draftRev !== state.draftRev) return false
      inserted = { text, span }
      state.draft = state.draft.slice(0, span.start) + text + state.draft.slice(span.end)
      return true
    }, submit() { submitted = true },
  }, focus() { focused = true } }
  const binding = { ctx: {} }
  const ctx = { get(name) { return name === 'sessions' ? { binding: () => binding }
    : name === 'conversation' ? { input: { for(actx) { assert.equal(actx, binding.ctx); return shell } } } : null } }
  api.sessionStore.set('synthetic')
  return { ctx, state, result: () => ({ inserted, focused, submitted }) }
}

test('source insertion preserves selected draft text and attachments, uses revision checks, and never submits', () => {
  const api = load()
  const c = composer(api)
  assert.equal(api.insertSourceDraft(c.ctx, { sessionId: 'synthetic', quote: '第一段原文\n第二段原文' }, false), true)
  const result = c.result()
  assert.equal(result.inserted.span.start, 4)
  assert.equal(result.inserted.span.end, 4)
  assert.equal(result.inserted.span.draftRev, 7)
  assert.match(c.state.draft, /^已经写好\n\n关于这段原文：\n> 第一段原文\n> 第二段原文\n\n的问题$/)
  assert.deepEqual(c.state.attachmentIds, ['existing-file'])
  assert.equal(result.focused, true)
  assert.equal(result.submitted, false)
})

test('stale drafts, another session, unavailable APIs and a submitting composer fail without overwriting text', () => {
  const api = load()
  for (const options of [{ draftRev: 8 }, { phase: 'submitting' }, { phase: 'adjudicating' }]) {
    const c = composer(api, options)
    assert.equal(api.insertSourceDraft(c.ctx, { sessionId: 'synthetic', quote: '原文' }, false), false)
    assert.equal(c.state.draft, '已经写好的问题')
    assert.equal(c.result().focused, false)
    assert.equal(c.result().submitted, false)
  }
  const c = composer(api)
  assert.equal(api.insertSourceDraft(c.ctx, { sessionId: 'other', quote: '原文' }, false), false)
  assert.equal(api.insertSourceDraft({ get() { return null } }, { sessionId: 'synthetic', quote: '原文' }, false), false)
  assert.equal(c.result().inserted, null)
})
