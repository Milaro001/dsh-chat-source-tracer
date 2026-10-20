import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relatedSessions, analyzeRelationships, collectEntries, resolveClaim, locateEvidence } from '../index.js'
import { searchRelated, rankRelated, RELATED_CONTEXT_BYTES } from '../related.js'

const quote = '紫杉协议采用环形索引，确保长对话中的定位一致性。'
const message = (seq, text, role = 'assistant', time = 500) => ({ seq, time, type: `${role}/message`, surfaceOp: 'append',
  data: role === 'user' ? { id: `u${seq}`, source: { kind: 'user' }, content: [{ type: 'text', text }] }
    : { turn: 1, step: 1, message: { id: `a${seq}`, content: [{ type: 'text', text }] } } })
const input = { sessionId: 'current', quote, seq: 10, role: 'assistant', messageId: 'a10' }
const helpers = { collectEntries, resolveClaim, redactSecrets: text => text.replace(/sk-[a-z0-9]{20}/g, '[REDACTED_KEY]') }

function context(extras = []) {
  const sessions = new Map([['current', [message(10, quote, 'assistant', 1000)]], ...extras])
  const ctx = { calls: [], reads: [], searches: [], sessions,
    get(name) { if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'test-related' }) } },
    sessionQuery: {
      async listSessions() { return [...sessions.keys()].map(id => ({ header: { id } })) },
      async searchSessions(request, exec) { ctx.searches.push({ request, exec }); return { items: [] } },
      async readSession(id) { return { events: sessions.get(id) || [] } },
      async readSurface(id) { ctx.reads.push(id); if (!sessions.has(id)) throw Error('not available'); return { events: sessions.get(id) } },
      async readEvent({ sessionId, seq }) { const target = sessions.get(sessionId)?.find(item => item.seq === seq); return { target, events: target ? [target] : [] } },
      async readTitle(id) { return { text: `虚构会话 ${id}` } },
    },
    llm: { async *stream(options) {
      ctx.calls.push(options)
      const { candidates } = JSON.parse(options.messages[0].content[0].text)
      yield { type: 'text-delta', text: JSON.stringify({ relations: candidates.map(item => ({ id: item.id,
        relation: item.timing === 'after' ? 'changes' : 'similar', quote: item.text.slice(0, 40), explanation: '观点接近，但不能据此断定当时引用过。' })) }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
  }
  return ctx
}
async function drain(ctx, selected = input) {
  let result
  do {
    result = await relatedSessions(ctx, { ...selected, ...(result?.scanId ? { scanId: result.scanId } : {}) })
    assert.equal(result.ok, true, JSON.stringify(result))
  } while (!result.complete)
  return result
}

test('cross-session local search reaches later batches and AI history, without an LLM call', async () => {
  const ctx = context([...Array.from({ length: 11 }, (_, index) => [`background-${index}`, [message(1, '天气晴朗，今天整理花园。')]]),
    ['old-ai', [message(3, quote)]]])
  const result = await drain(ctx)
  assert.equal(result.totalSessions, 12)
  assert.equal(result.scannedSessions, 12)
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].sessionId, 'old-ai')
  assert.equal(result.hits[0].role, 'assistant')
  assert.equal(result.hits[0].timing, 'before')
  assert.equal(ctx.calls.length, 0)
  assert.ok(ctx.searches[0].request.eventFilters.some(filter => filter.kind === 'surface'))
  assert.ok(!ctx.reads.includes('current'))
})

test('continuation survives Cordis returning a fresh sessionQuery proxy on each access', async () => {
  const ctx = context([...Array.from({ length: 6 }, (_, index) => [`background-${index}`, [message(1, '今天整理花园。')]]), ['related', [message(3, quote)]]])
  const service = ctx.sessionQuery
  Object.defineProperty(ctx, 'sessionQuery', { get: () => ({ ...service }) })
  const result = await drain(ctx)
  assert.equal(result.scannedSessions, 7)
  assert.equal(result.hits[0].sessionId, 'related')
  assert.ok((await analyzeRelationships(ctx, { ...input, scanId: result.scanId })).relations.length)
})

test('local fallback finds Chinese substrings the installed FTS tokenizer can miss, including a huge message tail', async () => {
  const ctx = context([['long-history', [message(2, '普通背景。'.repeat(140000) + quote)]]])
  ctx.sessionQuery.searchSessions = async () => { throw Object.assign(Error('disabled'), { code: 'SESSION_QUERY_SEARCH_DISABLED' }) }
  const result = await drain(ctx)
  assert.ok(result.hits[0].quote.includes('紫杉协议'))
  assert.equal(result.meta.indexed, false)
  assert.equal(result.meta.modelCalled, false)
})

test('scope excludes this session and runtime/reasoning documents; future matches are labeled', async () => {
  const runtime = message(1, quote, 'user'); runtime.data.source.kind = 'runtime-context'
  const ctx = context([['other', [runtime, { seq: 2, type: 'assistant/reasoning', data: { text: quote } }, message(3, quote, 'assistant', 2000)]]])
  const result = await drain(ctx)
  assert.deepEqual(result.hits.map(item => [item.sessionId, item.seq, item.timing]), [['other', 3, 'after']])
})

test('search uses the current folded replacement text and reports incomplete reads honestly', async () => {
  const edited = { ...message(3, quote), surfaceOp: 'replace' }
  const ctx = context([['edited', [edited]], ['broken', []]])
  const read = ctx.sessionQuery.readSurface
  ctx.sessionQuery.readSurface = async id => { if (id === 'broken') throw Error('private filesystem detail'); return read(id) }
  const result = await drain(ctx)
  assert.equal(result.failedSessions, 1)
  assert.equal(result.hits[0].sessionId, 'edited')
  assert.ok(!JSON.stringify(result).includes('private filesystem detail'))
})

test('continuations are bound to their original selection and provider, and raw index hits cannot add invisible sessions', async () => {
  const ctx = context([['other', [message(1, quote)]]])
  ctx.sessionQuery.searchSessions = async () => ({ items: [{ header: { id: 'not-listed' }, bestMatch: { snippet: quote } }] })
  const result = await drain(ctx)
  assert.equal(result.hits[0].sessionId, 'other')
  assert.equal((await relatedSessions(ctx, { ...input, quote: '不同的选句', scanId: result.scanId })).error, 'related_expired')
  const otherContext = context()
  assert.equal((await relatedSessions(otherContext, { ...input, scanId: result.scanId })).error, 'related_expired')
})

test('explicit relation analysis has bounded, redacted passages and reuses unchanged analysis', async () => {
  const syntheticKey = 'sk-' + 'abcdefghij'.repeat(2)
  const ctx = context(Array.from({ length: 9 }, (_, index) => [`related-${index}`, [message(2, `${quote} ${syntheticKey} ${'重复材料。'.repeat(200)}`)]]))
  const found = await drain(ctx)
  const result = await analyzeRelationships(ctx, { ...input, scanId: found.scanId })
  assert.equal(ctx.calls.length, 1)
  const payload = JSON.parse(ctx.calls[0].messages[0].content[0].text)
  assert.ok(payload.candidates.length <= 6)
  assert.ok(Buffer.byteLength(JSON.stringify(payload.candidates)) <= RELATED_CONTEXT_BYTES)
  assert.ok(!JSON.stringify(payload).includes(syntheticKey))
  assert.ok(JSON.stringify(payload).includes('[REDACTED_KEY]'))
  assert.ok(ctx.calls[0].maxTokens <= 2048)
  assert.ok(result.relations.length)
  assert.equal((await analyzeRelationships(ctx, { ...input, scanId: found.scanId })).meta.cached, true)
  assert.equal(ctx.calls.length, 1)
})

test('edited or removed candidate text is revalidated before spending model tokens', async () => {
  const ctx = context([['other', [message(2, quote)]]])
  const found = await drain(ctx)
  ctx.sessions.set('other', [message(2, '这条消息已经修改。')])
  await assert.rejects(analyzeRelationships(ctx, { ...input, scanId: found.scanId }), /原文已变化/)
  assert.equal(ctx.calls.length, 0)
})

test('model cannot manufacture candidate IDs or quotes as relationships', async () => {
  const ctx = context([['other', [message(2, quote)]]])
  const found = await drain(ctx)
  ctx.llm.stream = async function* (options) {
    const { candidates } = JSON.parse(options.messages[0].content[0].text)
    yield { type: 'text-delta', text: JSON.stringify({ relations: [
      { id: 'forged', relation: 'supports', quote, explanation: '伪造来源' },
      { id: candidates[0].id, relation: 'supports', quote: '没有提供的原话', explanation: '伪造引文' },
    ] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  assert.deepEqual((await analyzeRelationships(ctx, { ...input, scanId: found.scanId })).relations, [])
})

test('cancellation interrupts long scans and waiting on non-cancellable session reads', async () => {
  const controller = new AbortController()
  const pending = rankRelated([{ seq: 1, text: '普通背景。'.repeat(200000) }], quote, controller.signal)
  setImmediate(() => controller.abort())
  await assert.rejects(pending, error => error.name === 'AbortError')
  const ctx = context([['other', [message(2, quote)]]])
  ctx.sessionQuery.readSurface = async () => new Promise(() => {})
  const waiting = new AbortController()
  const result = searchRelated(ctx, input, waiting.signal, helpers)
  setTimeout(() => waiting.abort(), 10)
  await assert.rejects(result, error => error.name === 'AbortError')
})

test('cross-session identity resolves the same seq in the correct conversation', async () => {
  const ctx = context([['other', [message(10, quote)]]])
  const found = await drain(ctx)
  const hit = found.hits[0]
  const resolved = await locateEvidence(ctx, { ...hit, sessionId: hit.sessionId })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.seq, 10)
  assert.equal(hit.sessionId, 'other')
})

test('an edited current-surface candidate can be located without changing legacy raw-log navigation', async () => {
  const replacement = { ...message(4, quote), surfaceOp: 'replace' }
  const ctx = context([['edited', [replacement]]])
  const found = await drain(ctx)
  assert.equal(found.hits[0].currentSurface, true)
  assert.equal((await locateEvidence(ctx, found.hits[0])).ok, true)
  assert.equal((await locateEvidence(ctx, { ...found.hits[0], currentSurface: false })).ok, false)
})
