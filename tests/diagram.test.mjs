import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { prepareDiagramInput, validateDiagramSummary } from '../diagram.js'
import { summarizeDiagram } from '../index.js'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const browser = { __ModuleLoader__: { load({ factory }) { factory(() => ({})) } } }
vm.runInNewContext(source.replace("    return {\n      inject: ['slots'],",
  "    window.diagramTest = { buildArchiveDiagram, archiveDiagramSvg, diagramLines, checkedDiagramGroups };\n    return {\n      inject: ['slots'],"), { window: browser })
const api = browser.diagramTest
assert.ok(api)
const records = [
  { id: 'note:one', kind: 'note', text: '环形索引保留消息编号，便于来源核对。', item: {} },
  { id: 'decision:two', kind: 'decision', text: '恢复方案需要完整的消息编号。', item: {
    assumptions: ['历史消息未被修改。'], atoms: [{ keywords: ['消息编号'], relation: 'direct', evidence: [{ seq: 1, quote: '消息编号应当保留。' }] }],
  } },
]
const input = { records: records.map(({ id, kind, text }) => ({ id, kind, text })), language: 'zh' }

test('diagram model input rejects duplicate identities, invalid kinds and over-budget selections before inference', () => {
  assert.equal(prepareDiagramInput(input).records.length, 2)
  for (const bad of [{ records: [] }, { records: [input.records[0], input.records[0]] },
    { records: [{ ...input.records[0], kind: 'trash' }] },
    { records: Array.from({ length: 21 }, (_, i) => ({ id: String(i), kind: 'note', text: '材料' })) },
    { records: [{ id: 'long', kind: 'note', text: '甲'.repeat(24001) }] }]) assert.throws(() => prepareDiagramInput(bad))
})

test('AI grouping keeps only selected sources, rejects duplicates, and explicitly retains omitted material', () => {
  const context = prepareDiagramInput(input)
  const value = { title: '恢复方案', groups: [{ title: '消息身份', summary: '需保留原始消息编号。', recordIds: ['note:one'] }] }
  const result = validateDiagramSummary(value, context)
  assert.equal(result.groups.length, 2)
  assert.equal(result.groups[1].recordIds[0], 'decision:two')
  assert.throws(() => validateDiagramSummary({ groups: [{ ...value.groups[0], recordIds: ['invented'] }] }, context))
  assert.throws(() => validateDiagramSummary({ groups: [value.groups[0], value.groups[0]] }, context))
  assert.throws(() => api.checkedDiagramGroups([{ title: '主题', summary: '', recordIds: ['invented'] }], records))
})

test('both layouts include every selected record, existing premises and sources, without altering archives', () => {
  const before = JSON.stringify(records)
  for (const layout of ['mind', 'structure']) {
    const diagram = api.buildArchiveDiagram(records, { layout, title: '紫杉协议' })
    assert.equal(diagram.nodes.filter(node => ['note', 'decision'].includes(node.kind)).length, 2)
    assert.ok(diagram.nodes.some(node => node.kind === 'source'))
    assert.ok(diagram.nodes.some(node => node.kind === 'assumption'))
    assert.ok(diagram.edges.some(edge => edge.kind === 'source' && edge.target === 'record:decision:two'))
    if (layout === 'structure') {
      const proof = diagram.nodes.find(node => node.kind === 'source')
      const conclusion = diagram.nodes.find(node => node.id === 'record:decision:two')
      assert.ok(proof.x + proof.width < conclusion.x, 'support must precede the conclusion in the structure layout')
    }
    assert.ok(diagram.nodes.every(node => node.x >= 0 && node.y >= 0 && node.x + node.width <= diagram.width && node.y + node.height <= diagram.height))
    assert.equal(JSON.stringify(records), before)
    const ids = new Set(diagram.nodes.map(node => node.id))
    assert.ok(diagram.edges.every(edge => ids.has(edge.source) && ids.has(edge.target)))
  }
})

test('notes-only diagrams do not manufacture supporting sources; optional details can be excluded', () => {
  const notes = api.buildArchiveDiagram(records.slice(0,1))
  assert.equal(notes.edges.some(edge => edge.kind !== 'organization'), false)
  const compact = api.buildArchiveDiagram(records, { includeSources: false })
  assert.equal(compact.nodes.some(node => ['source', 'assumption'].includes(node.kind)), false)
  assert.equal(compact.nodes.filter(node => ['note', 'decision'].includes(node.kind)).length, 2)
})

test('SVG escapes user and AI text, is self-contained and has a solid background in both palettes', () => {
  const unsafe = '</text><script>alert("x")</script>& \u0000😀 https://example.org?a=1&b=2'
  const diagram = api.buildArchiveDiagram([{ id:'note:unsafe', kind:'note', text:unsafe, item:{} }], { title: unsafe })
  for (const paper of ['dark', 'light']) {
    const svg = api.archiveDiagramSvg(diagram, paper)
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/)
    assert.match(svg, /&lt;script&gt;/)
    assert.doesNotMatch(svg, /<script|<foreignObject|<image|href=|\u0000/)
    assert.match(svg, /width="100%" height="100%"/)
    assert.ok(svg.includes('😀'))
  }
})

test('diagram wrapping keeps Unicode intact, limits card length and signals a shortened excerpt', () => {
  const lines = api.diagramLines('😀中'.repeat(500), 20, 3)
  assert.equal(lines.length, 3)
  assert.ok(lines.at(-1).endsWith('…'))
  assert.ok(lines.every(line => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(line)))
  assert.throws(() => api.buildArchiveDiagram([]))
})

function modelContext() {
  const calls = []
  return { calls, get: () => ({ currentSelection: () => ({ provider:'fixture', model:'diagram-test' }) }),
    sessionQuery: { readSession() { throw new Error('Must not read unselected conversations') } },
    llm: { async *stream(options) {
      calls.push(options)
      const request = JSON.parse(options.messages[0].content[0].text)
      yield { type:'text-delta', text:JSON.stringify({ title:'来源与恢复', groups:[{ title:'原始编号', summary:'这些材料讨论消息编号的保存。', recordIds:request.records.map(record=>record.id) }] }) }
      yield { type:'finish', reason:{kind:'stop'} }
    } },
  }
}

test('diagram summaries use only selected bounded text, redact credentials and reuse identical model work', async () => {
  const ctx = modelContext()
  const selected = { records:[{id:'note:secret-fixture',kind:'note',text:'保留编号。Bearer fixture-token-value-1234567890'}] }
  const first = await summarizeDiagram(ctx, selected)
  const second = await summarizeDiagram(ctx, selected)
  assert.equal(first.ok, true)
  assert.equal(second.meta.cached, true)
  assert.equal(ctx.calls.length, 1)
  assert.ok(!JSON.stringify(ctx.calls[0].messages).includes('fixture-token-value-1234567890'))
  assert.ok(JSON.stringify(ctx.calls[0].messages).includes('REDACTED'))
  assert.ok(ctx.calls[0].maxTokens <= 3200)
})

test('invalid selection never invokes a model; user cancellation propagates without retries', async () => {
  const ctx = modelContext()
  await assert.rejects(summarizeDiagram(ctx,{records:[]}))
  assert.equal(ctx.calls.length, 0)
  const controller = new AbortController()
  ctx.llm.stream = async function* (options) {
    ctx.calls.push(options)
    controller.abort(new DOMException('Cancelled','AbortError'))
    options.signal.throwIfAborted()
    yield { type:'finish',reason:{kind:'stop'} }
  }
  await assert.rejects(summarizeDiagram(ctx,{records:[{id:'note:cancel',kind:'note',text:'取消材料'}]},controller.signal),error=>error.name==='AbortError')
  assert.equal(ctx.calls.length, 1)
})
