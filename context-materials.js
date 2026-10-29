import { createHash } from 'node:crypto'
import { rankRelated } from './related.js'

const textOf = message => (message?.content || []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
const key = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24)
const scalar = value => typeof value === 'string' ? value.slice(0,160) : ''

/** Read only durable, explicitly identified reference snapshots and recorded tool results.
 * A path mention is an unread reference, never permission to read the filesystem.
 */
export function taskMaterialEntries(events, through, helpers) {
  const entries = [], unread = [], calls = new Map()
  let inspectedChars = 0, limited = false
  const push = row => {
    if (inspectedChars + row.text.length > 4_000_000 || entries.length >= 3000) { limited = true; return }
    inspectedChars += row.text.length
    entries.push({ ...row, seq: entries.length + 1 })
  }
  for (const event of events) {
    if (limited) break
    if (Number(event.seq) >= through) continue
    if (event.type === 'tool/call') calls.set(String(event.data?.callId), event.data)
    if (event.type === 'tool/result') {
      const original = helpers.collectEntries([event])[0]
      if (original) {
        const call = calls.get(String(event.data?.message?.toolCallId ?? event.data?.callId))
        push({ text: original.text, role: 'tool', kind: 'tool', label: scalar(call?.name) || '已记录的工具返回', sourceSeq: original.seq,
          messageId: original.messageId, capturedAt: event.time ?? null })
      }
    }
    if (event.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind === 'session-reference') {
      const text = textOf(event.data), refs = Array.isArray(source.references) ? source.references : []
      if (source.version !== 1 || source.form !== 'recall' || text.length > 1_500_000) { unread.push({ label: '引用会话快照', reason: '快照格式不支持或超过读取上限' }); continue }
      const envelope = text.match(/<referenced-sessions>\s*([\s\S]*?)\s*<\/referenced-sessions>/)
      let payload
      try { payload = JSON.parse(envelope?.[1] || '') } catch { unread.push({ label: '引用会话快照', reason: '快照正文暂时无法解析' }); continue }
      for (const ref of refs.slice(0,32)) {
        const captured = Array.isArray(payload) && payload.find(row => row.sessionId === ref.sessionId && row.capturedThroughSeq === ref.capturedThroughSeq)
        if (!captured || !Array.isArray(captured.conversation)) { unread.push({ label: scalar(ref.label) || '引用会话', reason: '没有可核对的已捕获正文' }); continue }
        for (const row of captured.conversation) {
          if (!['user','assistant'].includes(row?.role) || typeof row.text !== 'string') continue
          push({ text: row.text, role: row.role, kind: 'snapshot', label: scalar(ref.label) || '引用会话', sourceSessionId: typeof ref.sessionId === 'string' ? ref.sessionId : '', sourceSeq: event.seq,
            capturedThroughSeq: ref.capturedThroughSeq, capturedFormatVersion: ref.capturedFormatVersion ?? 0, capturedAt: event.time ?? null, truncated: ref.truncated === true })
        }
        if (ref.truncated) unread.push({ label: scalar(ref.label) || '引用会话', reason: '原快照有截断，本次只检索已保存部分' })
      }
    } else if (!source?.kind || source.kind === 'user') {
      const text = textOf(event.data)
      for (const match of text.matchAll(/(?:^|\s)@(?:"([^"\n]+)"|([^\s@]+))/g)) {
        const name = match[1] || match[2]
        if (/[/.\\]/.test(name) && !name.startsWith('[') && unread.length < 32) unread.push({ label: name.slice(0,180), reason: '路径引用不会自动读取文件；已执行读取的正文可在工具材料中匹配' })
      }
      for (const block of event.data?.content || []) if (block.type === 'file' && unread.length < 32) unread.push({ label: scalar(block.filename || block.name) || '文件附件', reason: '附件没有可直接检索的文本；不会自动打开文件' })
    }
  }
  return { entries, unread: unread.slice(0,32), limited, inspectedChars }
}

export async function searchContextMaterials(ctx, input, signal, helpers) {
  const sessionId = typeof input?.sessionId === 'string' ? input.sessionId.trim() : '', quote = String(input?.quote || '').trim()
  if (!sessionId || sessionId.length > 2000 || !quote || quote.length > 6000) throw new Error('请选择不超过6000字的原文。')
  signal?.throwIfAborted()
  const snapshot = await ctx.sessionQuery.readSession(sessionId)
  signal?.throwIfAborted()
  const entries = helpers.collectEntries(snapshot.events)
  const selected = helpers.resolveClaim(entries, quote, input)
  if (!selected) throw new Error('选中的消息无法唯一定位，请重新选择。')
  const task = input.includeTask ? taskMaterialEntries(snapshot.events, selected.seq, helpers) : { entries: [], unread: [], limited: false, inspectedChars: 0 }
  const later = input.includeLater !== false ? entries.filter(row => row.seq > selected.seq) : []
  const hits = []
  if (task.entries.length) for (const hit of await rankRelated(task.entries, quote, signal)) hits.push({ ...hit,
    id: key(['task',sessionId,hit.sourceSeq,hit.seq,hit.quote]), category: 'task', seq: hit.sourceSeq, timing: 'before', sessionId })
  if (later.length) for (const hit of await rankRelated(later, quote, signal)) hits.push({ ...hit,
    id: key(['later',sessionId,hit.seq,hit.quote]), category: 'later', timing: 'after', sessionId })
  return { ok: true, hits, unread: task.unread, meta: { modelCalled: false, taskRecords: task.entries.length, laterRecords: later.length, limited: task.limited,
    snapshotOnly: true, capturedThroughSeq: snapshot.events.at(-1)?.seq ?? null } }
}
