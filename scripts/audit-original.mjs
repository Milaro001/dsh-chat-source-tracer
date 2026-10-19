import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
const root = process.argv[2]
if (!root) throw new Error('Pass the original plugin directory')
const source = await fs.readFile(`${root}/index.js`, 'utf8')
const client = await fs.readFile(`${root}/client.js`, 'utf8')
const mod = await import(`data:text/javascript;base64,${Buffer.from(source + '\nexport {buildPrompt, resolveClaim, validateAtoms};').toString('base64')}`)
const entries = Array.from({length: 150}, (_, i) => ({seq: i+1, role: i%2 ? 'assistant' : 'user', turn: i+1, text: `背景话题${i}。` + '普通的讨论和无关信息。'.repeat(170)}))
entries[1].text = '旧助手重要结论：使用紫杉缓存协议保证索引一致性。'
entries[148].text = '最近用户消息开头。' + '普通说明。'.repeat(450) + '消息尾部的关键依据：末尾定位标记。'
const claim = {seq:151, role:'assistant',text:'紫杉缓存协议保证索引一致性。'}
const prompt = mod.buildPrompt([...entries,claim],claim.text,claim,[])
const evidence=mod.validateAtoms({atoms:[{text:'结论',relation:'direct',evidence:[{seq:2,quote:'甲'.repeat(300)}]}]},[{seq:2,role:'assistant',text:'甲'.repeat(300)}],151,'结论',[])[0].evidence[0]
const findings = {
 fullLogReadExists: source.includes('ctx.sessionQuery.readSession(sessionId)'),
 oldAssistantIsMissingFromPrompt: !prompt.includes('旧助手重要结论'),
 recentMessageTailIsMissingFromPrompt: !prompt.includes('末尾定位标记'),
 currentClaimIsInEvidencePrompt: prompt.includes('[#151] 助手'),
 duplicateUserQuoteResolvesToAssistant: mod.resolveClaim([{seq:1,role:'assistant',text:'重复原文'},{seq:2,role:'user',text:'重复原文'}],'重复原文').seq===1,
 truncatedEvidenceIsNoLongerSubstring: !'甲'.repeat(300).includes(evidence.quote),
 evidenceAndNoteHaveDifferentJumpPaths: client.includes('const jumpTo =') && client.includes('const runJump =') && client.slice(client.indexOf('const jumpTo ='),client.indexOf('const runCorroborate')).includes('setOriginal('),
 shortCacheKeyExists: source.includes('norm(quote).slice(0, 240)'),
}
for (const [name,confirmed] of Object.entries(findings)) assert.equal(confirmed,true,name)
console.log(JSON.stringify(findings,null,2))
