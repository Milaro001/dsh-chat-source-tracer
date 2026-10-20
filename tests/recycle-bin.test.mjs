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

function load(localStorage) {
  const browser = { __ModuleLoader__: { load({ factory }) { factory(() => ({})) } } }
  // Expose closure helpers only in the isolated test VM; production has no test API.
  const instrumented = source.replace("    return {\n      inject: ['slots'],",
    "    window.testLedger = { ledgerStore, recycleLedgerItem, restoreLedgerItem };\n    return {\n      inject: ['slots'],")
  vm.runInNewContext(instrumented, { window: browser, localStorage })
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
    item: { id: 'old-note', createdAt: 10.5, text: '从回收站恢复' }, deletedAt: 1000 }] }))
  assert.equal(api.restoreLedgerItem('t'), 'restored')
  const restored = api.ledgerStore.get().notes
  assert.equal(restored.length, 502)
  assert.equal(new Set(restored.map(item => item.id)).size, 502)
  assert.equal(restored[0].id, 'n500')
  assert.ok(restored.findIndex(item => item.id === 'old-note') > 0)
})
