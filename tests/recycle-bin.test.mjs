import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const key = 'dsh-provenance:ledger:v1'
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const legacy = () => ({ decisions: [], assumptions: [], notes: [] })

function storage(initial) {
  const values = new Map(initial ? [[key, JSON.stringify(initial)]] : [])
  return {
    fail: false,
    getItem(name) { return values.get(name) ?? null },
    setItem(name, value) {
      if (this.fail) throw new Error('QuotaExceededError')
      values.set(name, value)
    },
  }
}

function load(localStorage, clock, environment = {}) {
  const browser = { ...environment.window, __ModuleLoader__: { load({ factory }) { factory(() => ({})) } } }
  // Expose closure helpers only in the isolated test VM; production has no test API.
  const instrumented = source.replace("    return {\n      inject: ['slots'],",
    "    window.testLedger = { ledgerStore, recycleLedgerItem, restoreLedgerItem };\n    return {\n      inject: ['slots'],")
  const FakeDate = clock ? class extends Date { static now() { return clock.now } } : Date
  vm.runInNewContext(instrumented, { window: browser, localStorage, Date: FakeDate, ...environment.document ? { document: environment.document } : {} })
  assert.ok(browser.testLedger, 'client module test instrumentation failed')
  return browser.testLedger
}

test('existing archives migrate without losing active records', () => {
  const initial = { ...legacy(), notes: [{ id: 'note', text: '原有摘录', sessionId: 'one', seq: 9 }] }
  assert.deepEqual(plain(load(storage(initial)).ledgerStore.get()), { ...initial, trash: [] })
})

test('delete and restore preserve complete records, identity, evidence and status across reloads', () => {
  for (const kind of ['notes', 'decisions', 'assumptions']) {
    const item = { id: kind, sessionId: 'one', text: '保留原文', claim: '结论', seq: 9,
      role: 'assistant', createdAt: 123, status: 'confirmed', decisionId: 'linked',
      atoms: [{ evidence: [{ seq: 2, quote: '依据原文', messageId: 'original' }] }] }
    const local = storage({ ...legacy(), [kind]: [item] })
    const first = load(local)
    assert.equal(first.recycleLedgerItem(kind, item.id), 'moved')
    const second = load(local)
    assert.equal(second.ledgerStore.get()[kind].length, 0)
    const entry = second.ledgerStore.get().trash[0]
    assert.equal(entry.kind, kind)
    assert.ok(entry.deletedAt > 0)
    assert.deepEqual(plain(entry.item), item)
    assert.equal(second.restoreLedgerItem(entry.id), 'restored')
    assert.deepEqual(plain(load(local).ledgerStore.get()), { ...legacy(), [kind]: [item], trash: [] })
  }
})

test('later saves using the legacy shape retain the recycle bin and independent assumptions', () => {
  const assumption = { id: 'a', decisionId: 'd', text: '独立假设', status: 'open' }
  const api = load(storage({ ...legacy(), decisions: [{ id: 'd', claim: '结论' }], assumptions: [assumption] }))
  api.recycleLedgerItem('decisions', 'd')
  api.ledgerStore.update(current => ({ decisions: current.decisions,
    assumptions: current.assumptions, notes: [{ id: 'new-note', text: '新摘录' }] }))
  assert.equal(api.ledgerStore.get().trash.length, 1)
  assert.deepEqual(plain(api.ledgerStore.get().assumptions), [assumption])
})

test('repeated clicks are idempotent and same-ID conflicts preserve both versions', () => {
  const api = load(storage({ ...legacy(), notes: [{ id: 'n', text: '旧内容' }] }))
  assert.equal(api.recycleLedgerItem('notes', 'n'), 'moved')
  assert.equal(api.recycleLedgerItem('notes', 'n'), 'missing')
  const id = api.ledgerStore.get().trash[0].id
  api.ledgerStore.update(current => ({ ...current, notes: [{ id: 'n', text: '新内容' }] }))
  assert.equal(api.restoreLedgerItem(id), 'duplicate')
  assert.equal(api.ledgerStore.get().notes[0].text, '新内容')
  assert.equal(api.ledgerStore.get().trash[0].item.text, '旧内容')
  api.ledgerStore.update(current => ({ ...current, notes: [] }))
  assert.equal(api.restoreLedgerItem(id), 'restored')
  assert.equal(api.restoreLedgerItem(id), 'missing')
  assert.equal(api.ledgerStore.get().notes.length, 1)
})

test('a failed persistent write leaves delete and restore transactions unchanged', () => {
  const local = storage({ ...legacy(), notes: [{ id: 'n', text: '不能丢失' }] })
  const api = load(local)
  let changes = 0
  api.ledgerStore.subscribe(() => changes++)
  local.fail = true
  const beforeDelete = plain(api.ledgerStore.get())
  assert.equal(api.recycleLedgerItem('notes', 'n'), 'storage-error')
  assert.deepEqual(plain(api.ledgerStore.get()), beforeDelete)
  assert.equal(changes, 0)
  local.fail = false
  api.recycleLedgerItem('notes', 'n')
  const beforeRestore = plain(api.ledgerStore.get())
  local.fail = true
  assert.equal(api.restoreLedgerItem(beforeRestore.trash[0].id), 'storage-error')
  assert.deepEqual(plain(api.ledgerStore.get()), beforeRestore)
  assert.deepEqual(plain(load(local).ledgerStore.get()), beforeRestore)
  assert.equal(changes, 1)
})

test('restoring near active-list limits does not discard another record', () => {
  const notes = Array.from({ length: 501 }, (_, index) => ({ id: `n${index}`, createdAt: index }))
  const api = load(storage({ ...legacy(), notes, trash: [{ id: 't', kind: 'notes',
    item: { id: 'old-note', createdAt: 10.5, text: '从回收站恢复' }, deletedAt: Date.now() }] }))
  assert.equal(api.restoreLedgerItem('t'), 'restored')
  const restored = api.ledgerStore.get().notes
  assert.equal(restored.length, 502)
  assert.equal(new Set(restored.map(item => item.id)).size, 502)
  assert.equal(restored[0].id, 'n500')
  assert.ok(restored.findIndex(item => item.id === 'old-note') > 0)
})

const day = 24 * 60 * 60 * 1000
const anchor = Date.UTC(2026, 9, 20)
const deleted = (id, deletedAt, kind = 'notes', sessionId = 'one') => ({
  id: `trash-${id}`, kind, deletedAt, item: { id, sessionId, text: `虚构内容 ${id}`, createdAt: 10 },
})

test('recycle bin keeps the 50 newest deletions across all record types and sessions, including after reload', () => {
  const clock = { now: anchor }
  const initial = Array.from({ length: 50 }, (_, index) => deleted(`old-${index}`, anchor - index - 1,
    ['notes', 'decisions', 'assumptions'][index % 3], index % 2 ? 'one' : 'two'))
  const local = storage({ ...legacy(), notes: [{ id: 'new', text: '新删除内容' }], trash: initial })
  const api = load(local, clock)
  local.fail = true
  assert.equal(api.recycleLedgerItem('notes', 'new'), 'storage-error')
  assert.equal(api.ledgerStore.get().notes.length, 1)
  assert.equal(api.ledgerStore.get().trash.at(-1).item.id, 'old-49')
  local.fail = false
  assert.equal(api.recycleLedgerItem('notes', 'new'), 'moved')
  const saved = load(local, clock).ledgerStore.get()
  assert.equal(saved.trash.length, 50)
  assert.equal(saved.trash[0].item.id, 'new')
  assert.equal(saved.trash.at(-1).item.id, 'old-48')
  assert.equal(saved.notes.length, 0)
  assert.equal(saved.trash.some(entry => entry.item.id === 'old-49'), false)
})

test('startup cleans expired and over-limit entries, retains the exact 30-day boundary, and leaves active records intact', () => {
  const clock = { now: anchor }
  const keep = { id: 'active', text: '活动摘录' }
  const initial = [deleted('expired', anchor - 30 * day - 1), deleted('boundary', anchor - 30 * day),
    deleted('recent-deletion', anchor - day)]
  const local = storage({ ...legacy(), notes: [keep], trash: initial })
  const api = load(local, clock)
  assert.deepEqual(plain(api.ledgerStore.get().notes), [keep])
  assert.deepEqual(api.ledgerStore.get().trash.map(entry => entry.item.id).join(','), 'recent-deletion,boundary')
  assert.equal(JSON.parse(local.getItem(key)).trash.length, 2)
  const overfull = storage({ ...legacy(), trash: Array.from({ length: 63 }, (_, index) => deleted(`${index}`, anchor - index)) })
  assert.equal(load(overfull, clock).ledgerStore.get().trash.length, 50)
  assert.equal(JSON.parse(overfull.getItem(key)).trash.length, 50)
})

test('expired records cannot be restored during a long-running session and maintenance persists the cleanup', () => {
  const clock = { now: anchor }
  const local = storage({ ...legacy(), trash: [deleted('old', anchor), deleted('newer', anchor + 1)] })
  const api = load(local, clock)
  clock.now += 30 * day + 1
  assert.equal(api.restoreLedgerItem('trash-old'), 'missing')
  assert.equal(api.ledgerStore.get().notes.length, 0)
  assert.equal(api.ledgerStore.get().trash.length, 0)
  assert.equal(JSON.parse(local.getItem(key)).trash.length, 0)
})

test('failed cleanup retries without changing active records or losing the current archive state', () => {
  const clock = { now: anchor }
  const local = storage({ ...legacy(), notes: [{ id: 'active' }], trash: [deleted('old', anchor)] })
  const api = load(local, clock)
  clock.now += 31 * day
  local.fail = true
  const before = plain(api.ledgerStore.get())
  assert.equal(api.ledgerStore.prune(), false)
  assert.deepEqual(plain(api.ledgerStore.get()), before)
  assert.equal(api.restoreLedgerItem('trash-old'), 'storage-error')
  local.fail = false
  assert.equal(api.ledgerStore.prune(), true)
  assert.deepEqual(plain(api.ledgerStore.get()), { ...legacy(), notes: [{ id: 'active' }], trash: [] })
})

test('a startup cleanup that cannot be saved is persisted on the next successful maintenance sweep', () => {
  const clock = { now: anchor }
  const local = storage({ ...legacy(), notes: [{ id: 'active' }], trash: [deleted('expired', anchor - 31 * day)] })
  local.fail = true
  const api = load(local, clock)
  assert.equal(api.ledgerStore.get().trash.length, 0)
  assert.equal(JSON.parse(local.getItem(key)).trash.length, 1)
  local.fail = false
  assert.equal(api.ledgerStore.prune(), true)
  assert.deepEqual(JSON.parse(local.getItem(key)), { ...legacy(), notes: [{ id: 'active' }], trash: [] })
})

test('malformed and future legacy deletion times migrate once rather than extending retention on every load', () => {
  const clock = { now: anchor }
  const local = storage({ ...legacy(), trash: [deleted('missing'), deleted('future', anchor + 100 * day)] })
  const first = load(local, clock).ledgerStore.get()
  assert.equal(first.trash.length, 2)
  assert.ok(first.trash.every(entry => entry.deletedAt === anchor))
  clock.now += day
  assert.ok(load(local, clock).ledgerStore.get().trash.every(entry => entry.deletedAt === anchor))
  clock.now += 30 * day
  assert.equal(load(local, clock).ledgerStore.get().trash.length, 0)
})

test('one shared maintenance timer handles expiration and app wake, and stops when no archive views are subscribed', () => {
  const clock = { now: anchor }
  const timers = new Map(), focus = new Map(), visibility = new Map()
  const environment = { window: {
    setInterval(fn, delay) { assert.equal(delay, 60000); timers.set(1, fn); return 1 },
    clearInterval(id) { timers.delete(id) },
    addEventListener(name, fn) { focus.set(name, fn) },
    removeEventListener(name, fn) { if (focus.get(name) === fn) focus.delete(name) },
  }, document: {
    addEventListener(name, fn) { visibility.set(name, fn) },
    removeEventListener(name, fn) { if (visibility.get(name) === fn) visibility.delete(name) },
  } }
  const local = storage({ ...legacy(), trash: [deleted('first', anchor)] })
  const api = load(local, clock, environment)
  const stopOne = api.ledgerStore.subscribe(() => {})
  const stopTwo = api.ledgerStore.subscribe(() => {})
  assert.equal(timers.size, 1)
  clock.now += 31 * day
  timers.get(1)()
  assert.equal(api.ledgerStore.get().trash.length, 0)
  api.ledgerStore.update(current => ({ ...current, trash: [deleted('second', clock.now)] }))
  clock.now += 31 * day
  focus.get('focus')()
  assert.equal(api.ledgerStore.get().trash.length, 0)
  api.ledgerStore.update(current => ({ ...current, trash: [deleted('third', clock.now)] }))
  clock.now += 31 * day
  visibility.get('visibilitychange')()
  assert.equal(api.ledgerStore.get().trash.length, 0)
  stopOne(); assert.equal(timers.size, 1)
  stopTwo()
  assert.equal(timers.size, 0)
  assert.equal(focus.size, 0)
  assert.equal(visibility.size, 0)
})
