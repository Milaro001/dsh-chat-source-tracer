import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { completeJson, errorReply, parseJson, serve, trace } from '../index.js'

const atom = { text: '环形索引保证定位一致性', relation: 'direct', evidence: [{ seq: 1, quote: '紫杉协议采用环形索引。' }] }
const valid = JSON.stringify({ atoms: [atom], assumptions: [] })
const delta = text => ({ type: 'text-delta', text })
const finish = (kind = 'stop') => ({ type: 'finish', reason: { kind } })
const reply = (text = valid, kind = 'stop') => [delta(text), finish(kind)]
const options = { provider: 'mock', model: 'mock', prompt: '虚构测试资料' }
function scripted(...responses) {
  const calls = []
  return { calls, llm: { async *stream(input) {
    const response = responses[calls.length]
    calls.push(input)
    assert.ok(response, 'Unexpected additional model call')
    if (typeof response === 'function') { yield* response(input); return }
    for (const event of response) {
      if (event instanceof Error) throw event
      yield event
    }
  } } }
}

test('valid streamed JSON keeps escaped quotes, backslashes and newlines without retry', async () => {
  const quote = '他说："使用 C:\\archive"。\n第二段保留原样。'
  const content = JSON.stringify({ atoms: [{ ...atom, evidence: [{ seq: 1, quote }] }] })
  const ctx = scripted([delta(content.slice(0, 23)), delta(content.slice(23)), finish()])
  const result = await completeJson(ctx, options)
  assert.equal(result.value.atoms[0].evidence[0].quote, quote)
  assert.equal(result.meta.attempts, 1)
  assert.equal(result.meta.finishReason, 'stop')
  assert.equal(ctx.calls[0].maxTokens, 4096)
})

test('missing comma triggers one retry with more output space and unchanged source data', async () => {
  const malformed = valid.replace('"assumptions":[]', '"assumptions":["甲" "乙"]')
  const ctx = scripted(reply(malformed), reply())
  const result = await completeJson(ctx, options)
  assert.equal(ctx.calls.length, 2)
  assert.deepEqual(ctx.calls.map(call => call.maxTokens), [4096, 6144])
  assert.deepEqual(ctx.calls[0].messages, ctx.calls[1].messages)
  assert.ok(ctx.calls[1].system.includes('不得改变来源编号或编造引文'))
  assert.equal(result.meta.retryReason, 'model_invalid_json')
  assert.equal(result.meta.retried, true)
})

test('unescaped quotation marks retry; no malformed JSON is silently repaired', async () => {
  const malformed = '{"atoms":[{"text":"他说"采用索引"","evidence":[]}]}'
  assert.throws(() => parseJson(malformed), { code: 'model_invalid_json' })
  const ctx = scripted(reply(malformed), reply())
  assert.deepEqual((await completeJson(ctx, options)).value.atoms[0], atom)
})

test('code fences are accepted but prose or multiple JSON objects are rejected', () => {
  assert.deepEqual(parseJson('\uFEFF```json\n' + valid + '\n```'), JSON.parse(valid))
  for (const text of ['解释如下：' + valid, valid + '\n' + valid, valid + '\n附言']) {
    assert.throws(() => parseJson(text), { code: 'model_invalid_json' })
  }
})

test('token-limit ending is rejected even when the partial output happens to parse', async () => {
  const ctx = scripted(reply(valid, 'max-tokens'), reply())
  const result = await completeJson(ctx, options)
  assert.equal(result.meta.retryReason, 'model_output_truncated')
  assert.equal(ctx.calls.length, 2)
})

test('repeated truncation stops after two attempts with safe, specific diagnostics', async () => {
  const ctx = scripted(reply(valid.slice(0, -4), 'max-tokens'), reply(valid.slice(0, -2), 'max-tokens'))
  await assert.rejects(completeJson(ctx, options), error => {
    assert.equal(error.code, 'model_output_truncated')
    assert.equal(error.diagnostics.attempts, 2)
    assert.equal(error.diagnostics.finishReason, 'max-tokens')
    assert.equal(error.diagnostics.maxTokens, 6144)
    const response = errorReply(error)
    assert.ok(response.hint.includes('已自动重试一次'))
    assert.ok(!JSON.stringify(response).includes('紫杉协议'))
    return true
  })
  assert.equal(ctx.calls.length, 2)
})

test('wrong result structure retries once instead of rendering unusable cards', async () => {
  for (const bad of [null, [], { atoms: [] }, { atoms: [{ text: '结论' }] }, { atoms: [null] }]) {
    const ctx = scripted(reply(JSON.stringify(bad)), reply())
    assert.equal((await completeJson(ctx, options)).meta.retryReason, 'model_invalid_shape')
  }
})

test('a stream without a finish event and an empty stopped stream both retry once', async () => {
  for (const [first, code] of [[[delta(valid)], 'model_incomplete'], [[finish()], 'model_empty_output']]) {
    const ctx = scripted(first, reply())
    assert.equal((await completeJson(ctx, options)).meta.retryReason, code)
  }
})

test('partial output followed by service failure reports the service error without retry', async () => {
  for (const ending of [finish('error'), new Error('provider secret=test-private-value')]) {
    const ctx = scripted([delta('{"atoms":['), ending])
    await assert.rejects(completeJson(ctx, options), error => {
      assert.equal(error.code, 'model_upstream_error')
      const response = errorReply(error)
      assert.ok(response.message.includes('模型服务'))
      assert.ok(response.messageEn.includes('service'))
      assert.ok(!JSON.stringify(response).includes('test-private-value'))
      return true
    })
    assert.equal(ctx.calls.length, 1)
  }
})

test('model abort does not retry', async () => {
  const ctx = scripted([finish('aborted')])
  await assert.rejects(completeJson(ctx, options), { code: 'model_aborted' })
  assert.equal(ctx.calls.length, 1)
})

test('user cancellation reaches the provider and never starts a retry', async () => {
  const controller = new AbortController()
  let providerAborted = false
  const ctx = scripted(async function* ({ signal }) {
    await new Promise(resolve => {
      signal.addEventListener('abort', () => { providerAborted = true; resolve() }, { once: true })
      setImmediate(() => controller.abort())
    })
  })
  await assert.rejects(completeJson(ctx, { ...options, signal: controller.signal }), { name: 'AbortError' })
  assert.equal(providerAborted, true)
  assert.equal(ctx.calls.length, 1)
})

test('timeout stops waiting even if the provider ignores abort; it does not retry', async () => {
  let signal
  const ctx = scripted(async function* (input) { signal = input.signal; await new Promise(() => {}) })
  await assert.rejects(completeJson(ctx, { ...options, timeoutMs: 15 }), { code: 'model_timeout' })
  assert.equal(signal.aborted, true)
  assert.equal(ctx.calls.length, 1)
})

test('corroboration also retries malformed output using its own schema and budgets', async () => {
  const picks = { picks: [{ page: 1, quote: '外部资料原文。' }] }
  const ctx = scripted(reply('{"picks":['), reply(JSON.stringify(picks)))
  const result = await completeJson(ctx, { ...options, kind: 'corroborate', maxTokens: 2048, retryMaxTokens: 4096 })
  assert.deepEqual(result.value, picks)
  assert.deepEqual(ctx.calls.map(call => call.maxTokens), [2048, 4096])
})

test('the HTTP route returns readable JSON-format errors with a retry hint', async () => {
  const ctx = scripted(reply('{"atoms":['), reply('{"atoms":['))
  const req = Readable.from([Buffer.from('{}')])
  req.method = 'POST'; req.headers = {}
  const res = new EventEmitter()
  res.writeHead = status => { res.status = status }
  res.end = body => { res.body = JSON.parse(body); res.writableEnded = true }
  await serve(ctx, req, res, () => completeJson(ctx, options))
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, false)
  assert.equal(res.body.error, 'model_invalid_json')
  assert.equal(res.body.diagnostics.attempts, 2)
  assert.ok(res.body.message.includes('格式'))
  assert.ok(res.body.hint.includes('已自动重试一次'))
  assert.ok(!res.body.message.includes('Expected'))
})

test('a long selection survives retry while forged, current and future evidence stays excluded', async () => {
  const source = '早期结论：紫杉协议采用环形索引。'
  const claim = '长段落中的待溯源结论。'.repeat(400)
  const msg = (seq, text) => ({ seq, type: 'assistant/message', data: { turn: seq, step: 1, message: { id: `a${seq}`, role: 'assistant', content: [{ type: 'text', text }] } } })
  const evidence = [
    { seq: 1, quote: source },
    { seq: 1, quote: '模型编造的原文' },
    { seq: 2, quote: claim },
    { seq: 3, quote: '未来内容不得引用' },
  ]
  const ctx = scripted(reply('{"atoms":['), reply(JSON.stringify({ atoms: [{ ...atom, evidence }] })))
  ctx.sessionQuery = { readSession: async () => ({ events: [msg(1, source), msg(2, claim), msg(3, '未来内容不得引用')] }) }
  ctx.get = () => ({ currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  const result = await trace(ctx, { sessionId: 'json-retry-long-selection', seq: 2, quote: claim })
  assert.equal(result.meta.modelOutput.attempts, 2)
  assert.deepEqual(result.atoms[0].evidence.map(item => item.quote), [source])
  assert.equal(result.meta.quote, claim)
  assert.equal((await trace(ctx, { sessionId: 'json-retry-long-selection', seq: 2, quote: claim })).meta.cached, true)
  assert.equal(ctx.calls.length, 2)
})
