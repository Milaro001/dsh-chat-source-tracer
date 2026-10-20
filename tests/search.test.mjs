import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchSession, locateEvidence } from '../index.js'

const message = (seq, role, text) => ({ seq, type: `${role}/message`, surfaceOp: 'append',
  data: role === 'user' ? { id: `u${seq}`, source: { kind: 'user' }, content: [{ type: 'text', text }] }
    : { turn: seq, step: 1, message: { id: `a${seq}`, content: [{ type: 'text', text }] } } })
const host = events => ({ sessionQuery: { async readSession() { return { events } } },
  llm: { stream() { throw Error('Search must not invoke a model') } } })

test('panel search finds old user, AI and tool messages with authoritative identity', async () => {
  const events = [message(1, 'user', '我提出紫杉方案'), message(2, 'assistant', '紫杉方案采用环形索引'),
    { seq: 3, type: 'tool/result', data: { message: { content: [{ type: 'text', text: '工具资料：紫杉方案的验证结果' }] } } },
    ...Array.from({ length: 3000 }, (_, i) => message(i + 4, 'assistant', '无关的背景材料')),
    { ...message(4000, 'user', '紫杉方案运行时指令'), data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '紫杉方案运行时指令' }] } }]
  const result = await searchSession(host(events), { sessionId: 'test', query: '紫杉方案' })
  assert.equal(result.total, 3)
  assert.deepEqual(result.hits.map(hit => [hit.seq, hit.role]), [[1, 'user'], [2, 'assistant'], [3, 'tool']])
  assert.equal(result.hits[1].messageId, 'a2')
  assert.equal(result.scannedMessages, 3003)
  const located = await locateEvidence(host(events), { sessionId: 'test', ...result.hits[1] })
  assert.equal(located.seq, 2)
})

test('search reaches the tail of a huge single message and returns bounded context', async () => {
  const text = '普通背景。'.repeat(150000) + '榆树尾部定位标记。'
  const result = await searchSession(host([message(1, 'assistant', text)]), { sessionId: 'test', query: '榆树尾部定位标记' })
  assert.equal(result.total, 1)
  assert.ok(result.hits[0].excerpt.includes('榆树尾部定位标记'))
  assert.ok(result.hits[0].excerpt.length < 300)
  assert.ok(result.scannedChars > 700000)
})

test('user regular-expression metacharacters remain literal text', async () => {
  const events = [message(1, 'assistant', '字面量 a+b[2].* 已出现'), message(2, 'assistant', 'aaab2zz')]
  const result = await searchSession(host(events), { sessionId: 'test', query: 'a+b[2].*' })
  assert.deepEqual(result.hits.map(hit => hit.seq), [1])
  assert.equal(result.hits[0].quote, 'a+b[2].*')
})

test('case and whitespace matching preserves actual original spelling and Unicode offsets', async () => {
  const text = '🙂🙂原文 CAFÉ\n  Ring Index 测试'
  const result = await searchSession(host([message(5, 'assistant', text)]), { sessionId: 'test', query: 'café ring\tindex' })
  assert.equal(result.hits[0].quote, 'CAFÉ Ring Index')
  assert.ok(result.hits[0].excerpt.startsWith('🙂🙂原文'))
  assert.equal((await locateEvidence(host([message(5, 'assistant', text)]), { sessionId: 'test', ...result.hits[0] })).seq, 5)
})

test('pagination can reach later matches instead of silently truncating the conversation', async () => {
  const ctx = host(Array.from({ length: 103 }, (_, i) => message(i + 1, 'assistant', `共同标记 ${i}`)))
  const first = await searchSession(ctx, { sessionId: 'test', query: '共同标记' })
  const last = await searchSession(ctx, { sessionId: 'test', query: '共同标记', offset: 80 })
  assert.equal(first.total, 103)
  assert.equal(first.hits.length, 40)
  assert.equal(first.hasMore, true)
  assert.equal(last.hits[0].seq, 81)
  assert.equal(last.hits.length, 23)
  assert.equal(last.hasMore, false)
})

test('empty and invalid queries do not read the log; oversized queries fail before work', async () => {
  let reads = 0
  const ctx = { sessionQuery: { readSession() { reads++; throw Error('unexpected read') } } }
  assert.equal((await searchSession(ctx, { sessionId: 'test', query: ' \n ' })).total, 0)
  await assert.rejects(searchSession(ctx, { sessionId: 'test', query: '甲'.repeat(6001) }), /query too long/)
  await assert.rejects(searchSession(ctx, { sessionId: '', query: '甲' }), /missing sessionId/)
  assert.equal(reads, 0)
})

test('long search cooperatively yields and respects cancellation', async () => {
  const ctx = host(Array.from({ length: 40000 }, (_, i) => message(i + 1, 'assistant', '共同标记。'.repeat(30))))
  const controller = new AbortController()
  const pending = searchSession(ctx, { sessionId: 'test', query: '不存在的内容' }, controller.signal)
  setTimeout(() => controller.abort(), 0)
  await assert.rejects(pending, error => error.name === 'AbortError')
})

test('large whitespace in a matched phrase cannot expand the response without bound', async () => {
  const text = '开始 A' + ' '.repeat(100000) + 'B 结束'
  const result = await searchSession(host([message(1, 'assistant', text)]), { sessionId: 'test', query: 'A B' })
  assert.equal(result.hits[0].quote, 'A B')
  assert.ok(JSON.stringify(result).length < 1000)
})
