import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectEntries, resolveClaim, validateAtoms, trace, locateEvidence as locate } from '../index.js'
import { retrieve, PROMPT_BUDGET } from '../retrieval.js'
const msg = (seq,role,text,turn=1) => ({seq,type:`${role}/message`,surfaceOp:'append',data:role==='user'?{id:`u${seq}`,role,source:{kind:'user'},content:[{type:'text',text}]}:{turn,step:1,message:{id:`a${seq}`,role,content:[{type:'text',text}]}}})
const context = (events, evidence) => ({
  sessionQuery:{readSession:async()=>({events})},
  get:()=>({currentSelection:()=>({provider:'mock',model:'mock'})}),
  calls:[],
  llm:{async *stream(input){this.owner.calls.push(input);yield {type:'text-delta',text:JSON.stringify({atoms:[{text:'待核对结论',relation:'direct',evidence}]})};yield {type:'finish',reason:{kind:'stop'}}}},
})
function mock(events,evidence){const ctx=context(events,evidence);ctx.llm.owner=ctx;return ctx}

test('full history retrieval finds old AI and user and tool, not just recent messages',()=>{
 const entries=Array.from({length:3000},(_,i)=>({seq:i+1,role:i%2?'assistant':'user',text:`普通背景 ${i} `+'日常信息。'.repeat(90)}))
 entries[0].text='早期用户确定：紫杉协议使用环形索引。'
 entries[1].text='早期助手结论：紫杉协议应使用环形索引以确保一致性。'
 entries[2]={...entries[2],role:'tool',text:'外部资料：紫杉协议的环形索引测试结果。'}
 const result=retrieve(entries,'紫杉协议的环形索引保证一致性。')
 for(const seq of [1,2,3])assert.ok(result.passages.some(x=>x.seq===seq),`missing ${seq}`)
 assert.equal(result.meta.scannedMessages,3000)
 assert.ok(result.meta.promptChars<=PROMPT_BUDGET)
})

test('retrieval scans a single huge message all the way to its end',()=>{
 const result=retrieve([{seq:1,role:'assistant',text:'普通说明。'.repeat(70000)+'尾部特有信号：榆树定位标记使用六角索引。'}],'榆树定位标记使用六角索引。')
 assert.ok(result.passages.some(x=>x.text.includes('榆树定位标记')))
 assert.ok(result.meta.scannedChars>350000)
})

test('collection excludes injected runtime context and reasoning while keeping AI text',()=>{
 const events=[{seq:1,type:'turn/start',data:{turn:7}},msg(2,'user','真实提问'),{...msg(3,'user','运行时指令'),data:{source:{kind:'runtime-context'},content:[{type:'text',text:'运行时指令'}]}},msg(4,'assistant','真实回答',7)]
 const entries=collectEntries(events)
 assert.deepEqual(entries.map(x=>x.text),['真实提问','真实回答'])
 assert.equal(entries[1].messageId,'a4');assert.equal(entries[0].turn,7)
})

test('same text in user and assistant cannot silently resolve to the assistant',()=>{
 const entries=[{seq:1,role:'assistant',text:'重复原文'},{seq:2,role:'user',text:'重复原文'}]
 assert.equal(resolveClaim(entries,'重复原文'),null)
 assert.equal(resolveClaim(entries,'重复原文',{seq:2}).seq,2)
 assert.equal(resolveClaim(entries,'重复原文',{seq:9}),null)
})

test('Markdown selections resolve and supplied context disambiguates repeated text',()=>{
 const entries=[{seq:1,text:'甲前文 **引用句** 甲后文'},{seq:2,text:'乙前文 **引用句** 乙后文'}]
 assert.equal(resolveClaim(entries,'引用句',{prefix:'乙前文',suffix:'乙后文'}).seq,2)
})

test('evidence remains a real substring after shortening; self/future/fabrication/exclusions rejected',()=>{
 const source='甲'.repeat(300)
 const entries=[{seq:2,role:'assistant',text:source},{seq:4,role:'user',text:'原始用户依据'}]
 const run=evidence=>validateAtoms({atoms:[{text:'结论',relation:'direct',evidence}]},entries,10,'结论',[])[0]
 const ev=run([{seq:2,quote:source}]).evidence[0]
 assert.ok(source.includes(ev.quote));assert.equal(ev.role,'assistant')
 assert.equal(run([{seq:99,quote:'伪造'},{seq:2,quote:'不存在'},{seq:10,quote:'结论'}]).evidence.length,0)
 assert.equal(validateAtoms({atoms:[{text:'结论',evidence:[{seq:4,quote:'原始用户依据'}]}]},entries,10,'结论',[{seq:4,quote:'原始用户依据'}])[0].evidence.length,0)
})

test('trace resolves source first, retrieves old AI, excludes future and self, and invalidates edited cache',async()=>{
 const events=[msg(1,'assistant','紫杉协议应使用环形索引。'),...Array.from({length:200},(_,i)=>msg(i+2,'user',`无关背景${i}。`+'说明。'.repeat(100))),msg(300,'assistant','所以紫杉协议采用环形索引。'),msg(301,'user','此后消息绝不能作为依据。')]
 const ctx=mock(events,[{seq:1,quote:'紫杉协议应使用环形索引。'},{seq:301,quote:'此后消息绝不能作为依据。'}])
 const input={sessionId:'synthetic',quote:'所以紫杉协议采用环形索引。',seq:300}
 const result=await trace(ctx,input)
 assert.equal(result.atoms[0].evidence.length,1)
 const prompt=ctx.calls[0].messages[0].content[0].text
 assert.ok(prompt.includes('紫杉协议应使用环形索引'))
 assert.ok(!prompt.includes('此后消息绝不能作为依据'))
 assert.equal(result.meta.retrieval.historyComplete,true)
 assert.equal((await trace(ctx,input)).meta.cached,true)
 events[0]=msg(1,'assistant','修改过的内容。')
 assert.equal((await trace(ctx,input)).meta.cached,false)
 assert.equal(ctx.calls.length,2)
 await assert.rejects(trace(ctx,{...input,quote:'根本不存在'}),/无法唯一定位/)
})

test('locate respects known identity, detects edited source and never caches stale locations',async()=>{
 const events=[msg(1,'assistant','相同句子'),msg(2,'user','相同句子')]
 const ctx=mock(events,[])
 assert.equal((await locate(ctx,{sessionId:'jump',quote:'相同句子',seq:2})).seq,2)
 assert.equal((await locate(ctx,{sessionId:'jump',quote:'相同句子'})).ok,false)
 events[1]=msg(2,'user','已修改')
 assert.equal((await locate(ctx,{sessionId:'jump',quote:'相同句子',seq:2})).ok,false)
})

test('model may only quote a passage that was actually supplied',()=>{
 const entry={seq:1,role:'assistant',text:'已提供的片段。未提供的同消息尾部。'}
 const result=validateAtoms({atoms:[{text:'结论',evidence:[{seq:1,quote:'未提供的同消息尾部。'}]}]},[entry],2,'结论',[],[{seq:1,text:'已提供的片段。'}])
 assert.equal(result[0].relation,'unsupported')
})

test('long retrieval yields to the host and can be cancelled',async()=>{
 const {retrieveAsync}=await import('../retrieval.js')
 const entries=Array.from({length:1000},(_,i)=>({seq:i,role:'assistant',text:'长历史记录。'.repeat(250)}))
 const controller=new AbortController()
 setImmediate(()=>controller.abort())
 await assert.rejects(retrieveAsync(entries,'历史',{signal:controller.signal}),{name:'AbortError'})
})

test('HTTP route rejects another origin port before reading any session',async()=>{
 const {Readable}=await import('node:stream');const {EventEmitter}=await import('node:events');const {serve}=await import('../index.js')
 const req=Readable.from([Buffer.from('{}')]);req.method='POST';req.headers={origin:'https://origin.example.invalid:9443',host:'origin.example.invalid:8443'}
 const res=new EventEmitter();res.writeHead=status=>res.status=status;res.end=body=>{res.body=JSON.parse(body);res.writableEnded=true}
 let called=false
 await serve({},req,res,async()=>{called=true;return {ok:true}})
 assert.equal(res.status,403);assert.equal(called,false)
})

test('disconnect signal reaches the model and does not populate a result',async()=>{
 const events=[msg(1,'user','依据是环形索引。'),msg(2,'assistant','因此采用环形索引。')]
 const controller=new AbortController();let observed=false
 const ctx=mock(events,[])
 ctx.llm.stream=async function*({signal}){await new Promise(resolve=>{signal.addEventListener('abort',()=>{observed=true;resolve()},{once:true});setImmediate(()=>controller.abort())})}
 await assert.rejects(trace(ctx,{sessionId:'cancelled-model',seq:2,quote:'因此采用环形索引。'},controller.signal),{name:'AbortError'})
 assert.equal(observed,true)
})
