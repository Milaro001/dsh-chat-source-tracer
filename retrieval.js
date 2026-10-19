/** Full-history, query-time retrieval. No model call, embedding service or DOM needed. */
export const CHUNK_SIZE = 1400
const OVERLAP = 240
export const PROMPT_BUDGET = 42000

export function terms(value) {
  const text = String(value).normalize('NFKC').toLowerCase()
  const found = new Set(text.match(/[a-z][a-z0-9_-]{2,}|\d+(?:\.\d+)?/g) || [])
  for (const run of text.match(/[\p{Script=Han}]+/gu) || []) {
    for (const size of [2, 3]) {
      for (let i = 0; i + size <= run.length; i++) found.add(run.slice(i, i + size))
    }
  }
  return found
}

/** Scan every chunk, including the end of very large individual tool/AI messages. */
function* retrievalSteps(entries, quote, budget) {
  const allTerms = [...terms(quote)]
  // Sample across the entire selection; a long selection must not search only its opening.
  const query = allTerms.length <= 160 ? allTerms : Array.from({ length: 160 }, (_, i) => allTerms[Math.floor(i * allTerms.length / 160)])
  const df = new Map(query.map(word => [word, 0]))
  const chunks = []
  let scannedChars = 0
  for (const entry of entries) {
    scannedChars += entry.text.length
    for (let start = 0; start < entry.text.length; start += CHUNK_SIZE - OVERLAP) {
      const text = entry.text.slice(start, start + CHUNK_SIZE)
      const tokens = terms(text)
      const matches = query.filter(word => tokens.has(word))
      for (const word of matches) df.set(word, df.get(word) + 1)
      chunks.push({ entry, start, text, matches, score: 0 })
      if (chunks.length % 256 === 0) yield
      if (start + CHUNK_SIZE >= entry.text.length) break
    }
  }
  for (const chunk of chunks) {
    chunk.score = chunk.matches.reduce((score, word) => score + Math.log(1 + chunks.length / (1 + df.get(word))), 0)
    const flatQuote = String(quote).replace(/\s+/g, ' ').trim()
    if (flatQuote.length >= 4 && chunk.text.replace(/\s+/g, ' ').includes(flatQuote)) chunk.score += 30
  }
  const ranked = chunks.filter(chunk => chunk.score > 0).sort((a, b) => b.score - a.score || a.entry.seq - b.entry.seq || a.start - b.start)
  const selected = []
  let used = 0
  const add = chunk => {
    if (!chunk || selected.some(item => item.entry.seq === chunk.entry.seq && Math.abs(item.start - chunk.start) < CHUNK_SIZE / 2)) return
    const cost = chunk.text.length + 120
    if (used + cost > budget) return
    selected.push(chunk)
    used += cost
  }
  // Reserve space for earlier AI conclusions as well as user words and tools.
  for (const role of ['assistant', 'user', 'tool']) {
    for (const chunk of ranked.filter(chunk => chunk.entry.role === role).slice(0, 5)) add(chunk)
  }
  for (const chunk of ranked) { add(chunk); if (used >= budget - CHUNK_SIZE) break }
  // Recent context is supplemental; it cannot crowd out high scoring old passages.
  for (const entry of entries.slice(-4).reverse()) add(chunks.findLast(chunk => chunk.entry === entry))
  selected.sort((a, b) => a.entry.seq - b.entry.seq || a.start - b.start)
  return {
    passages: selected.map(({ entry, start, text }) => ({ seq: entry.seq, role: entry.role, turn: entry.turn, start, text })),
    meta: { strategy: 'full-history-lexical-v1', scannedMessages: entries.length, scannedChars, scannedChunks: chunks.length,
      selectedPassages: selected.length, promptChars: used, historyComplete: false,
      limitation: '已扫描日志全文；模型只核对检索片段，语义改写且无共享词的来源可能漏检。' },
  }
}

/** Synchronous variant for reproducible CLI benchmarks. */
export function retrieve(entries, quote, budget = PROMPT_BUDGET) {
  const steps = retrievalSteps(entries, quote, budget)
  let next
  do { next = steps.next() } while (!next.done)
  return next.value
}

/** Let the host handle other requests and cancellation while scanning long logs. */
export async function retrieveAsync(entries, quote, { budget = PROMPT_BUDGET, signal } = {}) {
  const steps = retrievalSteps(entries, quote, budget)
  while (true) {
    signal?.throwIfAborted()
    const next = steps.next()
    if (next.done) return next.value
    await new Promise(resolve => setImmediate(resolve))
  }
}
