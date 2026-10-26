import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
function load() {
  const window = { __ModuleLoader__: { load({ factory }) { factory(() => ({})) } } }
  vm.runInNewContext(source.replace("    return {\n      inject: ['slots'],",
    "    window.graphTest = { buildArchiveGraph, layoutArchiveGraph, graphTerms };\n    return {\n      inject: ['slots'],"), { window })
  assert.ok(window.graphTest)
  return window.graphTest
}
const api = load()
const plain = value => JSON.parse(JSON.stringify(value))
const decision = (id, sessionId = 'one', extra = {}) => ({ id, sessionId, claim: '环形索引保证定位一致性', status: 'active', createdAt: 10, atoms: [], ...extra })
const note = (id, sessionId = 'one', extra = {}) => ({ id, sessionId, text: '环形索引保留消息编号', createdAt: 9, ...extra })

test('archive graph is local and read-only, excludes trash and revoked conclusions, and retains isolated records', () => {
  const input = { decisions: [decision('d'), decision('revoked', 'one', { status: 'revoked' })],
    notes: [note('n'), note('isolated', 'one', { text: '互不关联的独立摘录' })], assumptions: [],
    trash: [{ item: note('deleted') }] }
  const before = plain(input)
  const graph = api.buildArchiveGraph(input)
  assert.equal(graph.totalRecords, 3)
  assert.ok(graph.nodes.some(node => node.id === 'note:isolated'))
  assert.equal(graph.nodes.some(node => /revoked|deleted/.test(node.id)), false)
  assert.deepEqual(plain(input), before)
  assert.deepEqual(plain(api.buildArchiveGraph({})).nodes, [])
})

test('shared keywords and co-occurring concepts create associations, never fabricated evidence arrows', () => {
  const graph = api.buildArchiveGraph({ decisions: [decision('d', 'one', {
    atoms: [{ keywords: ['环形索引', '消息编号'], evidence: [] }],
  })], notes: [note('n')] })
  const topic = graph.nodes.find(node => node.id === 'topic:环形索引')
  assert.ok(topic)
  assert.ok(topic.recordIds.includes('decision:d') && topic.recordIds.includes('note:n'))
  assert.ok(graph.edges.some(edge => edge.kind === 'keyword'))
  assert.ok(graph.edges.some(edge => edge.kind === 'cooccurrence'))
  assert.equal(graph.edges.some(edge => edge.kind === 'evidence' || edge.kind === 'assumption'), false)
  assert.equal(graph.nodes.some(node => node.kind === 'topic' && ['这个', '我们', '可以'].includes(node.label)), false)
})

test('saved evidence is directed to its conclusion and exact notes are reused without merging different messages', () => {
  const evidence = { seq: 3, role: 'assistant', quote: '保存消息原始编号' }
  const graph = api.buildArchiveGraph({ decisions: [decision('d', 'one', {
    atoms: [{ relation: 'inference', evidence: [evidence] }, { relation: 'unsupported', evidence: [{ seq: 8, quote: '不应显示' }] }],
  })], notes: [note('matching', 'one', { text: evidence.quote, seq: 3 }),
    note('different-passage', 'one', { text: '同一消息中的另一段话', seq: 3 }),
    note('other-session', 'two', { text: evidence.quote, seq: 3 })] })
  const links = graph.edges.filter(edge => edge.kind === 'evidence')
  assert.equal(links.length, 1)
  assert.equal(links[0].source, 'note:matching')
  assert.equal(links[0].target, 'decision:d')
  assert.equal(links[0].relation, 'inference')
  assert.equal(graph.nodes.some(node => node.text === '不应显示'), false)
})

test('source identity includes session, sequence and full quotation; shared sources preserve every owner', () => {
  const ev = { seq: 4, quote: '真实的同一段历史原文' }
  const graph = api.buildArchiveGraph({ decisions: [
    decision('a', 'one', { atoms: [{ relation: 'direct', evidence: [ev, ev] }] }),
    decision('b', 'one', { atoms: [{ relation: 'direct', evidence: [ev] }] }),
    decision('c', 'two', { atoms: [{ relation: 'direct', evidence: [ev] }] }),
  ] })
  const sources = graph.nodes.filter(node => node.kind === 'source')
  assert.equal(sources.length, 2)
  assert.equal(graph.edges.filter(edge => edge.kind === 'evidence').length, 3)
  assert.deepEqual(sources.find(node => node.item.sessionId === 'one').recordIds.sort().join(','), 'decision:a,decision:b')
  const filtered = api.buildArchiveGraph({ decisions: [decision('only', 'two', { atoms: [{ relation: 'direct', evidence: [ev] }] })] })
  assert.equal(filtered.nodes.find(node => node.kind === 'source').id, sources.find(node => node.item.sessionId === 'two').id)
})

test('premises connect only to the correct saved conclusion in the same session', () => {
  const input = { decisions: [decision('a'), decision('b', 'two')], assumptions: [
    { id: 'linked', sessionId: 'one', decisionId: 'a', text: '日志保存完整' },
    { id: 'legacy', sessionId: 'one', sourceClaim: '环形索引保证定位一致性', text: '消息尚未修改' },
    { id: 'wrong', sessionId: 'two', decisionId: 'a', text: '另一个会话' },
    { id: 'orphan', sessionId: 'one', decisionId: 'missing', sourceClaim: '环形索引保证定位一致性', text: '已删除结论的假设' },
  ] }
  const links = api.buildArchiveGraph(input).edges.filter(edge => edge.kind === 'assumption')
  assert.deepEqual(links.map(edge => `${edge.source}>${edge.target}`).sort().join(','),
    'assumption:legacy>decision:a,assumption:linked>decision:a')
})

test('large archives have bounded node work, preserve source arrays and advertise omitted records', () => {
  const notes = Array.from({ length: 1200 }, (_, index) => note(`n-${index}`, 'one', { createdAt: index,
    text: `环形索引恢复消息编号 ${index}。${'连续背景内容'.repeat(1200)}` }))
  const graph = api.buildArchiveGraph({ notes })
  assert.equal(graph.totalRecords, 1200)
  assert.equal(graph.shownRecords, 60)
  assert.ok(graph.nodes.length <= 90)
  assert.equal(graph.records[0].item.id, 'n-1199')
  assert.equal(notes[0].id, 'n-0')
  assert.ok(graph.nodes.every(node => Number.isFinite(node.degree)))
})

test('keyword sampling reaches both the middle and tail of a long note', () => {
  const text = '普通背景说明。'.repeat(800) + ' MiddleSignal ' + '普通背景说明。'.repeat(800) + ' TailSignal '
  const terms = api.graphTerms(text).map(term => term.key)
  assert.ok(terms.includes('middlesignal'))
  assert.ok(terms.includes('tailsignal'))
})

test('source nodes are bounded and every edge has two real endpoints', () => {
  const graph = api.buildArchiveGraph({ decisions: Array.from({ length: 80 }, (_, i) => decision(`d${i}`, 'one', {
    createdAt: i, atoms: [{ relation: 'direct', evidence: Array.from({ length: 12 }, (_, j) => ({ seq: i * 12 + j, quote: `来源 ${i} 的真实片段 ${j}` })) }],
  })) })
  const ids = new Set(graph.nodes.map(node => node.id))
  assert.equal(ids.size, graph.nodes.length)
  assert.ok(graph.nodes.filter(node => node.kind === 'source').length <= 12)
  assert.ok(graph.edges.every(edge => ids.has(edge.source) && ids.has(edge.target)))
})

test('settled layouts are deterministic, finite and stay inside narrow and expanded viewports', () => {
  const graph = api.buildArchiveGraph({ decisions: [decision('d')], notes: [note('n')] })
  for (const [width, height] of [[280, 365], [950, 600]]) {
    const first = api.layoutArchiveGraph(graph.nodes, graph.edges, width, height)
    const second = api.layoutArchiveGraph(graph.nodes, graph.edges, width, height)
    assert.deepEqual(plain([...first]), plain([...second]))
    assert.ok([...first.values()].every(point => Number.isFinite(point.x) && Number.isFinite(point.y)
      && point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height))
  }
})
