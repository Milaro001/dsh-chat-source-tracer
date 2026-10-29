import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { corroborate, collectEntries, resolveClaim, contextMaterials } from '../index.js'
import { taskMaterialEntries } from '../context-materials.js'
const message=(seq,text,role='user',source={kind:'user'})=>({seq,time:1000+seq,type:`${role}/message`,surfaceOp:'append',data:role==='user'?{id:`u${seq}`,source,content:[{type:'text',text}]}:{message:{id:`a${seq}`,content:[{type:'text',text}]}}})
const quote='紫杉协议通过环形索引保留消息编号。'
const reference=message(3,'## Referenced sessions\n<referenced-sessions>'+JSON.stringify([{sessionId:'source',label:'冻结资料',capturedThroughSeq:8,conversation:[{role:'user',text:quote}]}])+'</referenced-sessions>', 'user', {kind:'session-reference',version:1,form:'recall',references:[{sessionId:'source',label:'冻结资料',capturedThroughSeq:8,capturedFormatVersion:4,truncated:true}]})
const events=[message(1,'@"notes/test.md"'),reference,message(8,quote,'assistant'),message(9,'后续讨论：'+quote),message(10,'do not leak generic injected text','user',{kind:'runtime-context'})]
const helpers={collectEntries,resolveClaim}
const selected={sessionId:'current',seq:8,quote,includeTask:true,includeLater:true}
const mock=(web,value={picks:[]})=>({get(name){if(name==='web')return web;return {currentSelection:()=>({provider:'fixture',model:'mock'})}},calls:[],llm:{async *stream(input){yield {type:'text-delta',text:JSON.stringify(value)};yield {type:'finish',reason:{kind:'stop'}}}}})

test('web errors are classified safely without leaking the provider error or key',async()=>{
 const key='sk-secret-private';const ctx=mock({search(){throw Error('DeepSeek search has no API key '+key)}})
 const result=await corroborate(ctx,{quote})
 assert.equal(result.error,'web_unconfigured');assert.ok(result.hint.includes('凭据'));assert.ok(!JSON.stringify(result).includes(key))
 assert.equal((await corroborate(mock({search(){throw Error('network details')}}),{quote})).error,'web_search_failed')
 assert.equal((await corroborate(mock(null),{quote})).error,'web_unconfigured')
})
test('empty search, unreadable pages and no supporting quote are distinct outcomes',async()=>{
 assert.deepEqual((await corroborate(mock({search:async()=>({sources:[]})}),{quote})).sources,[])
 assert.equal((await corroborate(mock({search:async()=>({sources:[{url:'https://example.org'}]}),fetch:async()=>{throw Error('private path')}}),{quote})).error,'web_pages_unreadable')
 const good=await corroborate(mock({search:async()=>({sources:[{url:'https://example.org'}]}),fetch:async()=>({body:{kind:'text',content:'背景'.repeat(200)}})}),{quote})
 assert.equal(good.ok,true);assert.equal(good.sources.length,0)
})
test('explanation uses the model only, never requires web credentials and redacts secrets',async()=>{
 let prompt='';const ctx=mock(null,{explanation:'这是一个用于定位的协议。'})
 const original=ctx.llm.stream;ctx.llm.stream=function*(input){prompt=input.messages[0].content[0].text;return original(input)}
 ctx.llm.stream=async function*(input){prompt=input.messages[0].content[0].text;yield* original(input)}
 const key='sk-'+'abcde'.repeat(8)
 const result=await corroborate(ctx,{quote:quote+key,intent:'explain'})
 assert.equal(result.explanation,'这是一个用于定位的协议。');assert.ok(!prompt.includes(key));assert.equal(result.meta.modelCalled,true)
})
test('cancel interrupts waiting for web search even if provider ignores cancellation',async()=>{
 const controller=new AbortController();const promise=corroborate(mock({search:()=>new Promise(()=>{})}),{quote},controller.signal)
 controller.abort();await assert.rejects(promise,{name:'AbortError'})
})
test('task scope reads only captured reference text and records unread paths without filesystem reads',()=>{
 const result=taskMaterialEntries(events,8,helpers)
 assert.equal(result.entries.length,1);assert.equal(result.entries[0].text,quote);assert.equal(result.entries[0].capturedThroughSeq,8)
 assert.ok(result.unread.some(row=>row.label==='notes/test.md'));assert.ok(result.unread.some(row=>row.reason.includes('截断')))
 assert.ok(!JSON.stringify(result).includes('do not leak'))
 assert.equal(taskMaterialEntries(events,3,helpers).entries.length,0)
})
test('malformed and mismatched snapshots are not silently replaced with current source-session text',()=>{
 const bad=structuredClone(reference);bad.data.source.references[0].capturedThroughSeq=99
 const result=taskMaterialEntries([bad],8,helpers)
 assert.equal(result.entries.length,0);assert.ok(result.unread.length)
})
test('context search keeps later matches separate and never reads other sessions or calls a model',async()=>{
 const reads=[];const ctx={sessionQuery:{async readSession(id){reads.push(id);return {events}}},llm:{stream(){throw Error('Must not call model')}}}
 const result=await contextMaterials(ctx,selected)
 assert.equal(result.ok,true);assert.equal(result.meta.modelCalled,false);assert.deepEqual(reads,['current'])
 assert.ok(result.hits.some(hit=>hit.category==='task'&&hit.sourceSessionId==='source'))
 assert.ok(result.hits.some(hit=>hit.category==='later'&&hit.seq===9&&hit.timing==='after'))
 assert.ok(!result.hits.some(hit=>hit.seq===8))
 const earlier=await contextMaterials(ctx,{...selected,includeTask:false,includeLater:false})
 assert.equal(earlier.hits.length,0)
})
test('context identity is bound to the selected message rather than matching a future duplicate',async()=>{
 const result=await contextMaterials({sessionQuery:{readSession:async()=>({events})}},{...selected,seq:2})
 assert.equal(result.ok,false)
})
test('panel positions remain visible, snap only when enabled, and handle small viewports',()=>{
 const source=fs.readFileSync(new URL('../client.js',import.meta.url),'utf8');const browser={__ModuleLoader__:{load({factory}){factory(()=>({}))}}}
 vm.runInNewContext(source.replace("    return {\n      inject: ['slots'],","    window.geometry={clampPanelPosition};\n    return {\n      inject: ['slots'],"),{window:browser})
 const clamp=browser.geometry.clampPanelPosition
 assert.equal(clamp({x:18,y:100},420,400,{width:1200,height:800},true).x,8)
 assert.equal(clamp({x:18,y:100},420,400,{width:1200,height:800},false).x,18)
 const result=clamp({x:5000,y:-20},420,400,{width:1200,height:800},true)
 assert.equal(result.x,772);assert.equal(result.y,8)
 assert.equal(clamp({x:900,y:900},420,600,{width:350,height:450},false).x,8)
})

test('only recorded tool output prior to the target enters the task-material corpus',()=>{
 const result=taskMaterialEntries([{seq:1,type:'tool/call',data:{callId:'r1',name:'read',arguments:{path:'notes.md'}}},
 {seq:2,type:'tool/result',data:{message:{toolCallId:'r1',content:[{type:'text',text:quote}]}}},
 {seq:9,type:'tool/result',data:{message:{content:[{type:'text',text:'Future file content'}]}}}],8,helpers)
 assert.equal(result.entries.length,1);assert.equal(result.entries[0].label,'read');assert.equal(result.entries[0].sourceSeq,2)
})
test('explicit context analysis uses bounded candidate excerpts and retains later classification',async()=>{
 const ctx=mock(null);ctx.sessionQuery={readSession:async()=>({events})};let payload
 ctx.llm.stream=async function*(input){payload=JSON.parse(input.messages[0].content[0].text);yield {type:'text-delta',text:JSON.stringify({relations:payload.candidates.map(c=>({id:c.id,relation:'supports',quote:c.text,explanation:'可以补充核对，但不代表当时使用。'}))})};yield {type:'finish',reason:{kind:'stop'}}}
 const result=await contextMaterials(ctx,{...selected,analyze:true})
 assert.equal(result.meta.modelCalled,true);assert.ok(payload.candidates.length<=6);assert.ok(payload.candidates.reduce((n,c)=>n+Buffer.byteLength(c.text),0)<=6000)
 assert.equal(result.hits.find(c=>c.category==='later').timing,'after');assert.ok(result.hits.every(c=>c.relation))
})

test('later supplements are searched by default without a model and retain temporal identity',async()=>{
 const ctx={sessionQuery:{readSession:async()=>({events})},llm:{stream(){throw Error('No automatic model call')}}}
 const result=await contextMaterials(ctx,{sessionId:'current',seq:8,quote})
 assert.equal(result.meta.modelCalled,false)
 assert.ok(result.hits.some(hit=>hit.category==='later'&&hit.seq===9&&hit.timing==='after'))
 assert.ok(!result.hits.some(hit=>hit.category==='task'||hit.seq<=8))
})
