const React = require('react')
const ReactDOM = require('react-dom')
const {createRoot} = require('react-dom/client')
const h = React.createElement
const handlers = new Map()
let pluginContext
let setOldVisible
let setArchiveVisible
let setLaterVisible=()=>{}
let setFixtureSettings=()=>{}
window.fixtureConfigNavigations=0
let setFixtureSession
let remountMessages
let setLongSelection
const quote='紫杉协议采用环形索引，确保长对话中的定位一致性。\n\n**该协议保留原文的段落结构。**'
const normalize=value=>String(value).replace(/[*_`]/g,'').replace(/\s+/g,' ').trim()
const claim='因此，紫杉协议应采用环形索引，确保定位一致性。'
const longSelectionText='这是一段用于验证长选文折叠的虚构原文，需要完整保留分析与保存的内容。'.repeat(16)
const sources=[
 {seq:3,role:'assistant',turn:1,step:1,messageId:'ai-old',quote},
 {seq:4,role:'user',turn:1,messageId:'user-old',quote:'我希望长对话中的原文也能被准确定位。'},
 {seq:5,role:'tool',turn:1,quote:'环形索引协议适用于顺序日志的回溯查询。',url:'https://example.org/protocol',site:'example.org'},
]
const relatedSources=[
 {seq:3,role:'assistant',turn:1,step:1,messageId:'other-ai',quote:'另一段讨论里，紫杉协议采用环形索引，确保长对话中的定位一致性。我们还保留了消息的原始编号。'},
 {seq:4,role:'user',turn:1,messageId:'other-user',quote:'紫杉协议采用环形索引，确保长对话中的定位一致性。但我后来想补充一个恢复方案。'},
]
const traceResult={ok:true,claim:{seq:900,role:'assistant',turn:600,step:1,resolved:true},atoms:sources.map((ev,i)=>({text:['采用环形索引以保证定位一致性','保留长对话中的原文定位能力','这项设计需要核对外部协议'][i],relation:i===1?'inference':'direct',keywords:['紫杉协议','环形索引','定位'],evidence:[{...ev,why:'与这句话讨论的是同一项约束。',strength:'strong'}]})),assumptions:['历史记录保存完整，且目标消息尚未被修改。'],meta:{model:'本地测试替身',elapsedMs:42,messageCount:20000,retrieval:{scannedMessages:20000,selectedPassages:23}}}
const reviewMode = new URLSearchParams(location.search).has('review')
const graphDemo = new URLSearchParams(location.search).has('graph-demo')
if(graphDemo){
 const time=Date.UTC(2026,9,26,10,0)
 const decisions=[
  ['ring','环形索引让紫杉协议在长对话中准确定位原文。',['紫杉协议','环形索引','原文定位'],sources[0]],
  ['check','原文定位后，仍需要逐段核对来源与上下文。',['原文定位','来源核对','上下文'],sources[1]],
  ['restore','恢复方案通过消息编号重新连接来源。',['恢复方案','消息编号','来源核对'],sources[2]],
  ['context','上下文保存完整，有助于恢复原文定位。',['上下文','恢复方案','原文定位'],sources[0]],
 ].map(([id,claim,keywords,evidence],i)=>({id,claim,sessionId:'synthetic',claimSeq:900,createdAt:time+i*1000,status:'active',assumptions:[],atoms:[{text:claim,relation:i===1?'inference':'direct',keywords,evidence:[evidence]}]}))
 const assumptions=[{id:'complete',decisionId:'ring',text:'紫杉协议的历史消息仍然保存完整。',sourceClaim:decisions[0].claim},
  {id:'identity',decisionId:'restore',text:'恢复方案使用的消息编号不会被重复分配。',sourceClaim:decisions[2].claim}].map(item=>({...item,sessionId:'synthetic',status:'open',createdAt:time}))
 const notes=[...sources.map((source,i)=>({id:`source-${i}`,text:source.quote,quote:source.quote,seq:source.seq,role:source.role})),
  {id:'local',text:'环形索引与恢复方案都需要保留消息编号。'},
  {id:'context-note',text:'上下文与来源核对是原文定位之后的下一步。'},
  {id:'island',text:'独立记录：界面配色可以保留较低饱和度。'}].map((item,i)=>({...item,sessionId:'synthetic',createdAt:time+i*1000}))
 notes.push({id:'other-session',text:'另一会话也在讨论紫杉协议与恢复方案。',sessionId:'synthetic-other',createdAt:time+12000})
 localStorage.setItem('dsh-provenance:ledger:v1',JSON.stringify({decisions,assumptions,notes,trash:[]}))
}
const realFetch=window.fetch.bind(window)
let traceFailure = null
let relatedMode = 'normal'
let traceBehavior = 'normal'
let relationBehavior = 'normal'
let diagramBehavior = 'normal'
window.fixtureDiagramRequests=[]
window.fixtureRelatedRequests=[]
window.fixtureRelationCalls=0
window.fixtureSearchRequests=[]
window.fixtureTraceCalls=0
window.fixtureTraceRequests=[]
window.fixtureWebRequests=[]
window.fixtureMaterialRequests=[]
let webBehavior='normal'
window.fixtureRelationRequests=[]
window.fixtureViewActivations=[]
window.fetch=async (url,init)=>{
 if(!/^\/plugins\/dsh-chat-source-tracer\//.test(String(url)))return realFetch(url,init)
 const body=JSON.parse(init.body||'{}')
 if(String(url).endsWith('/context-materials')){window.fixtureMaterialRequests.push(body);return realFetch(url,init)}
 if(String(url).endsWith('/diagram')){
  const request={aborted:false,completed:false,body};window.fixtureDiagramRequests.push(request)
  init.signal?.addEventListener('abort',()=>{request.aborted=true},{once:true})
  const response=await realFetch(url,{...init,...(diagramBehavior==='late'?{signal:undefined}:{})})
  if(diagramBehavior==='late')await new Promise(resolve=>setTimeout(resolve,900))
  request.completed=true;return response
 }
 if(String(url).endsWith('/related')){
  const request={...body,mode:relatedMode,completed:false};window.fixtureRelatedRequests.push(request)
  let response
  if(relatedMode==='empty')response=Response.json({ok:true,scanId:'empty',hits:[],complete:true,scannedSessions:6,totalSessions:6,failedSessions:0})
  else if(relatedMode==='error')response=Response.json({ok:false,error:'related_failed',message:'关联检索暂未完成，请重试。'})
  else {response=await realFetch(url,{...init,...(relatedMode==='slow'?{signal:undefined}:{})});if(request.mode==='slow')await new Promise(resolve=>setTimeout(resolve,1000))}
  request.completed=true
  return response
 }
 if(String(url).endsWith('/relationships')){
  window.fixtureRelationCalls++
  const request={aborted:false,completed:false};window.fixtureRelationRequests.push(request)
  init.signal?.addEventListener('abort',()=>{request.aborted=true},{once:true})
  const response=await realFetch(url,{...init,...(relationBehavior==='late'?{signal:undefined}:{})})
  if(relationBehavior==='late')await new Promise(resolve=>setTimeout(resolve,900))
  request.completed=true;return response
 }
 if(String(url).endsWith('/search')){
  const request={query:body.query,aborted:false};window.fixtureSearchRequests.push(request)
  init.signal?.addEventListener('abort',()=>{request.aborted=true},{once:true})
  if(body.query==='迟到旧查询'){
   const response=await realFetch(url,{...init,signal:undefined})
   await new Promise(resolve=>setTimeout(resolve,1000))
   return response
  }
  return realFetch(url,init)
 }
 if(String(url).endsWith('/trace')){
  window.fixtureTraceCalls++;window.fixtureLastTrace=body
  const request={aborted:false,completed:false,behavior:traceBehavior};window.fixtureTraceRequests.push(request)
  init.signal?.addEventListener('abort',()=>{request.aborted=true},{once:true})
  const response=structuredClone(traceFailure||traceResult)
  if(request.behavior==='hold')await new Promise((_resolve,reject)=>{
   const abort=()=>{request.completed=true;traceBehavior='normal';relatedMode='normal';reject(new DOMException('Cancelled','AbortError'))}
   if(init.signal?.aborted)abort();else init.signal?.addEventListener('abort',abort,{once:true})
  })
  if(request.behavior==='late'){
   response.atoms[0].text='迟到的旧分析'
   await new Promise(resolve=>setTimeout(resolve,900))
  }
  request.completed=true;return Response.json(response)
 }
 if(String(url).endsWith('/corroborate')){
  const request={aborted:false,completed:false,body};window.fixtureWebRequests.push(request)
  if(webBehavior==='unconfigured')return Response.json({ok:false,error:'web_unconfigured',message:'尚未配置可用的网页检索服务。',hint:'请在 DSH 的模型与网页检索配置中检查检索提供方的凭据。'})
  if(webBehavior==='empty')return Response.json({ok:true,sources:[]})
  if(body.intent==='explain')return Response.json({ok:true,explanation:'紫杉协议是用于演示定位流程的虚构术语。解释不等于历史依据。',sources:[]})
  init.signal?.addEventListener('abort',()=>{request.aborted=true},{once:true})
  await new Promise(resolve=>setTimeout(resolve,900));request.completed=true
  return Response.json({ok:true,sources:[{quote:'迟到的网页材料',site:'example.org',url:'https://example.org/fixture'}]})
 }
 if(String(url).endsWith('/locate-evidence')){
  const source=(body.sessionId==='synthetic-other'?relatedSources:sources).find(s=>s.seq===body.seq)||(body.seq===900?{seq:900,role:'assistant',turn:600,step:1,messageId:'current-ai',quote:claim}:null)
  if(!source&&body.seq===920)return Response.json({ok:true,seq:920,role:'user',messageId:'later-note',quote:body.quote,text:'后续补充：紫杉协议应采用环形索引，确保定位一致性，但恢复流程还要核对消息编号。'})
  if(!source)return Response.json({ok:false})
  return Response.json({ok:true,...source})
 }
 if(String(url).endsWith('/locate'))return Response.json({ok:true,seq:900,turn:600,role:'assistant'})
 return Response.json({ok:false,message:'该操作不在测试范围'})
}
const draftState = {draft:'已经写好的问题',draftRev:0,phase:'idle',attachmentIds:['synthetic-attachment']}
window.fixtureDraftInsertions=[]
window.fixtureSubmitCalls=0
const inputShell={state:{getSnapshot:()=>({...draftState})},actions:{
 captureInsertion(){const input=document.querySelector('#fixture-composer');return {start:input.selectionStart,end:input.selectionEnd,draftRev:draftState.draftRev}},
 insertText(text,span){
  if(span.draftRev!==draftState.draftRev||draftState.phase==='submitting')return false
  const input=document.querySelector('#fixture-composer')
  const next=draftState.draft.slice(0,span.start)+text+draftState.draft.slice(span.end)
  draftState.draft=next;draftState.draftRev++;input.value=next
  input.setSelectionRange(span.start+text.length,span.start+text.length)
  window.fixtureDraftInsertions.push({text,span,attachmentIds:[...draftState.attachmentIds]})
  return true
 },submit(){window.fixtureSubmitCalls++},
},focus(){document.querySelector('#fixture-composer').focus({preventScroll:true})}}
const bindingContext={}
const ctx={
 get(name){
  if(name==='conversation')return {input:{for(actx){if(actx!==bindingContext)throw Error('wrong context');return inputShell}}}
  if(name==='sessions')return {binding(){return {ctx:bindingContext,session:{async loadThrough(seq){window.fixtureLoads.push(seq);setOldVisible(true);if(seq===920)setLaterVisible(true)}}}}}
  if(name==='uiConversation')return {binding(){return {activate(view){window.fixtureViewActivations.push(view)}}}}
  if(name==='pluginNavigation')return {openList(){window.fixtureConfigNavigations++;setFixtureSettings('list')}}
  if(name==='uiWorkspace')return {openSession(id){setFixtureSession(typeof id==='string'?id:id.sessionId)}}
  if(name==='locale')return {current:'zh-CN'}
 },
 slots:{inject(_name,fn){fn()},register(options,component){handlers.set(options.name,component)}},
}
window.fixtureLoads=[]
window.__ModuleLoader__={load({factory}){const plugin=factory(name=>{if(name==='react')return React;if(name==='react-dom')return ReactDOM;throw Error(name)});pluginContext=plugin;plugin.apply(ctx)}}
window.fixtureResults=[]
window.fixtureErrors=[]
window.fixtureConfirmCalls=[]
window.confirm=message=>{window.fixtureConfirmCalls.push(message);return false}
window.addEventListener('error',e=>window.fixtureErrors.push(e.message))
window.addEventListener('unhandledrejection',e=>window.fixtureErrors.push(String(e.reason)))
function SourceNode({node,children}){return h('div',{'data-chat-node-key':`node-${node.data.finalNode?.seq||node.data.seq}`,'data-chat-turn':node.data.turn||1,className:'message'},children)}
function App(){
 const [ready,setReady]=React.useState(false)
 const [activeSession,setActiveSession]=React.useState('synthetic')
 setFixtureSession=setActiveSession
 const [largeMessage,setLargeMessage]=React.useState(false)
 const [longSelection,setLong]=React.useState(false)
 setLongSelection=setLong
 const [old,setOld]=React.useState(false)
 const [fixtureSettings,updateSettings]=React.useState(null);setFixtureSettings=updateSettings
 const [laterVisible,setLater]=React.useState(false);setLaterVisible=setLater
 const [messageEpoch,setMessageEpoch]=React.useState(0)
 remountMessages=()=>setMessageEpoch(value=>value+1)
 const [archiveVisible,setArchive]=React.useState(graphDemo)
 setArchiveVisible=setArchive
 setOldVisible=setOld
 React.useEffect(()=>{const script=document.createElement('script');script.src='/client.js';script.onload=()=>setReady(true);document.body.append(script)},[])
 const Trigger=handlers.get('conversation.input.right')
 const Panel=handlers.get('shell.overlay')
 const Archive=handlers.get('conversation.view')
 return h(React.Fragment,null,
  fixtureSettings==='list'?h('div',{'data-plugin-item':'web-search'},h('button',{onClick:()=>updateSettings('web')},'查看 网页搜索')):fixtureSettings==='web'?h('section',{'data-fixture-config':true},h('h2',null,'网页搜索配置（模拟）'),h('p',null,'在 DSH 的此处填写检索凭据，测试不读写密钥。')):null,
  reviewMode ? h('div',{className:'fixture-toolbar',style:{maxWidth:620,height:'auto',flexWrap:'wrap',padding:'66px 24px 12px',boxSizing:'border-box',position:'relative'}},h('b',null,'V0.5 · 虚构会话 / 模拟模型'),h('button',{onClick:()=>void demoReview('selection')},'演示选词入口'),h('button',{onClick:()=>void demoReview('progress')},'演示分析进度'),h('button',{onClick:()=>void demoReview('web')},'演示检索失败与重试'),h('button',{onClick:()=>void demoReview('materials')},'查看任务材料与后续补充'),h('button',{id:'toggle-theme',onClick:()=>{document.documentElement.dataset.fixtureTheme=document.documentElement.dataset.fixtureTheme==='dark'?'light':'dark'}},'切换明暗')) : h('div',{className:'fixture-toolbar'},h('b',null,'DSH 对话溯源助手 · 本地验证'),h('button',{id:'run-resize-tests',onClick:()=>void runResizeTests()},'检查窗口缩放'),h('button',{id:'run-interaction-tests',onClick:()=>void runInteractionTests()},'检查检索与选词交互'),h('button',{id:'run-tests',onClick:()=>void runTests()},'运行浏览器回归测试'),h('button',{id:'toggle-theme',onClick:()=>{document.documentElement.dataset.fixtureTheme=document.documentElement.dataset.fixtureTheme==='dark'?'light':'dark'}},'切换明暗'),h('button',{id:'switch-session',onClick:()=>setActiveSession(id=>id==='synthetic'?'synthetic-other':'synthetic')},'切换测试会话'),h('button',{id:'stress-message',onClick:()=>setLargeMessage(value=>!value)},'长消息验证'),h('button',{id:'toggle-archive',onClick:()=>setArchive(value=>!value)},'查看测试档案'),h('button',{id:'demo-followup',onClick:()=>void demoFollowup()},'演示原文追问'),h('button',{id:'demo-long-selection',title:'Shift + 点击演示取消分析',onClick:event=>void(event.shiftKey?demoCancelAnalysis():demoLongSelection())},'演示长选文'),h('span',{id:'test-summary'},'等待运行')),
  h('div',{'data-slot':'conversation.session',style:{display:'contents'}}),
  ready&&graphDemo&&h('button',{id:'run-graph-dock-tests',onClick:()=>void runGraphDockTests(),style:{position:'fixed',top:16,right:20,zIndex:20}},'检查底部呼出'),
  ready&&graphDemo&&h('button',{id:'run-diagram-tests',onClick:()=>void runDiagramWorkspaceTests(),style:{position:'fixed',top:16,right:140,zIndex:20}},'检查导图工作台'),
  h('main',{'data-conversation-session':activeSession,'data-conversation-content':'','data-conversation-region':'chat',className:'conversation'},h('header',null,'测试会话',h('span',null,'所有内容均为虚构测试文本'),
   h('div',{'data-conversation-tabs':'',role:'tablist','aria-label':'测试视图'},
    h('button',{type:'button',role:'tab','aria-selected':!archiveVisible,onClick:()=>setArchive(false)},'对话'),
    h('button',{type:'button',role:'tab','aria-selected':archiveVisible,onClick:()=>setArchive(true)},'档案'))),
   h('section',{'data-slot':'conversation.session'},h('div',{'data-slot':'conversation.chat.flow',className:'chat-flow'},
    old && (activeSession==='synthetic-other'?relatedSources:sources).map(source=>h(SourceNode,{key:`${messageEpoch}-${source.seq}`,node:{kind:source.role==='assistant'?'assistant-step':'user',data:source.role==='assistant'?{turn:source.turn,step:1,finalNode:{...source,kind:'assistant'}}:{...source,kind:source.role}}},
     h('small',null,source.role==='assistant'?'AI 历史结论':source.role==='user'?'你的原话':'外部工具资料'),...source.quote.split('\n\n').map((part,i)=>h('p',{key:i},part.startsWith('**')?h('strong',null,part.replace(/\*\*/g,'')):(largeMessage&&source.seq===3&&i===0?'普通背景说明。'.repeat(1300)+part:part))))),
    h('div',{className:'spacer',style:reviewMode?{height:50}:undefined},'很早以前的讨论位于上方，由 DSH 分页加载。'),
    h(SourceNode,{key:messageEpoch,node:{kind:'assistant-step',data:{turn:600,step:1,finalNode:{seq:900,kind:'assistant',messageId:'current-ai'}}}},h('small',null,'AI 当前回答'),h('p',{id:'claim'},longSelection?longSelectionText:claim),h('p',null,'这段回答用于检查历史依据的加载、消息限定和关键词高亮。'),h('p',{id:'decoy'},'紫杉协议采用环形索引，确保长对话中的定位一致性。 该协议保留原文的段落结构。')),
   laterVisible&&h(SourceNode,{node:{kind:'user',data:{seq:920,role:'user',messageId:'later-note'}}},h('p',null,'后续补充：紫杉协议应采用环形索引，确保定位一致性，但恢复流程还要核对消息编号。')),
   )),
   h('footer',null,h('textarea',{id:'fixture-composer','aria-label':'测试输入框',defaultValue:draftState.draft,onChange:event=>{draftState.draft=event.target.value;draftState.draftRev++},style:{flex:1,minWidth:0,height:70,resize:'vertical',border:'1px solid var(--dsw-alias-border-l2)',borderRadius:10,background:'var(--dsw-alias-bg-base)',color:'var(--dsw-alias-label-primary)',padding:10}}),ready&&h(Trigger,{sessionId:activeSession}))),
  ready&&archiveVisible&&h('div',{id:'fixture-archive',style:{position:'fixed',top:82,left:32,right:graphDemo?'auto':470,
   width:graphDemo?`min(${new URLSearchParams(location.search).has('narrow')?420:1000}px, calc(100vw - 64px))`:undefined,
   bottom:24,zIndex:3,background:'var(--dsw-alias-bg-base)'}},h(Archive,{sessionId:activeSession})),
  ready&&h(Panel),h('pre',{id:'test-results'}))
}
const wait=ms=>new Promise(r=>setTimeout(r,ms))
async function until(check,label){const until=Date.now()+5000;while(Date.now()<until){if(check())return;await wait(30)}throw Error(label)}
async function runDiagramWorkspaceTests(){
 const checks=[]
 const report=(name,ok,detail='')=>{checks.push({name,ok,detail});document.querySelector('#test-results').textContent=JSON.stringify(checks,null,2)}
 const test=async(name,fn)=>{try{await fn();report(name,true)}catch(error){report(name,false,String(error))}}
 const dialog=()=>document.querySelector('.dmd-dialog')
 const button=text=>[...dialog().querySelectorAll('button')].find(node=>node.textContent===text)
 const open=async()=>{[...document.querySelectorAll('.dpl-head button')].find(node=>node.textContent==='生成导图').click();await until(dialog,'未打开工作台')}
 const initialRequests=window.fixtureDiagramRequests.length
 await test('从结论档案打开工作台，不自动调用模型',async()=>{
  await open();await until(()=>dialog().querySelector('.dmd-artboard svg'),'没有 SVG 预览')
  if(window.fixtureDiagramRequests.length!==initialRequests)throw Error('打开预览消耗了模型调用')
  if(dialog().querySelectorAll('.dmd-choice input:checked').length!==4)throw Error('默认选择未对应当前结论标签')
 })
 await test('两种布局可以切换，并保留同一组材料',async()=>{
  const count=dialog().querySelectorAll('.dmd-choice input:checked').length
  button('思维导图').click();await until(()=>dialog().querySelector('svg desc').textContent.includes('思维导图'),'未切换思维导图')
  button('结构导图').click();await until(()=>dialog().querySelector('svg desc').textContent.includes('结构导图'),'未切换结构导图')
  if(dialog().querySelectorAll('.dmd-choice input:checked').length!==count)throw Error('切换布局丢失选择')
 })
 await test('清空与全选更新预览，空选择不能导出',async()=>{
  button('清空').click();await until(()=>!dialog().querySelector('.dmd-artboard svg'),'清空后仍显示旧图')
  if(!button('导出 SVG').disabled||!button('导出 PNG').disabled)throw Error('空图仍能导出')
  button('全选').click();await until(()=>dialog().querySelector('.dmd-artboard svg'),'全选后未恢复预览')
  if(dialog().querySelectorAll('.dmd-choice input:checked').length!==10)throw Error('全选未覆盖摘录和结论')
 })
 await test('点击 AI 总结才调用模型，返回带来源的归纳',async()=>{
  button('AI 总结').click();await until(()=>dialog().querySelector('.dmd-settings').textContent.includes('AI 归纳'),'AI 摘要没有出现')
  if(window.fixtureDiagramRequests.length!==initialRequests+1)throw Error('AI 调用数量异常')
  if(!dialog().querySelector('svg').textContent.includes('历史定位与恢复'))throw Error('归纳组未进入图中')
 })
 await test('更换选择会清除旧归纳，并保持预览可用',async()=>{
  dialog().querySelector('.dmd-choice input:checked').click()
  await until(()=>dialog().querySelector('.dmd-settings').textContent.includes('原文整理'),'修改选择后沿用了旧归纳')
  if(!dialog().querySelector('.dmd-artboard svg'))throw Error('修改选择后预览崩溃')
 })
 await test('取消 AI 总结后，迟到结果不会覆盖原文导图',async()=>{
  diagramBehavior='late';button('AI 总结').click();await until(()=>button('取消总结'),'没有取消入口');button('取消总结').click();await wait(1050)
  if(!window.fixtureDiagramRequests.at(-1).aborted||dialog().querySelector('.dmd-settings').textContent.includes('AI 归纳'))throw Error('取消后显示迟到归纳')
  diagramBehavior='normal'
 })
 await test('AI 分析中更换材料会终止旧请求',async()=>{
  diagramBehavior='late';button('AI 总结').click();await until(()=>button('取消总结'),'请求未开始');dialog().querySelector('.dmd-choice input:checked').click();await wait(1050)
  if(!window.fixtureDiagramRequests.at(-1).aborted||dialog().querySelector('.dmd-settings').textContent.includes('AI 归纳'))throw Error('旧材料的摘要覆盖新材料')
  diagramBehavior='normal'
 })
 await test('Esc 关闭工作台并恢复档案操作',async()=>{
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await until(()=>!dialog(),'Esc 未关闭')
  if(!document.querySelector('.dpl-root')||document.body.style.overflow==='hidden')throw Error('档案页面被锁定')
 })
 await open()
 document.querySelector('#test-summary').textContent=`${checks.filter(item=>item.ok).length}/${checks.length} 导图检查通过`
}
async function runGraphDockTests(){
 const checks=[]
 const report=(name,ok,detail='')=>{checks.push({name,ok,detail});document.querySelector('#test-results').textContent=JSON.stringify(checks,null,2)}
 const test=async(name,fn)=>{try{await fn();report(name,true)}catch(error){report(name,false,String(error))}}
 const dock=()=>document.querySelector('.dpg-dock')
 const sheet=()=>document.querySelector('.dpg-sheet')
 const pointer=(type,target,relatedTarget)=>target.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerType:'mouse',relatedTarget}))
 const enter=()=>pointer('pointerover',dock(),document.body)
 const leave=()=>pointer('pointerout',dock(),document.body)
 await test('默认仅显示底部入口，图谱不占正文高度',async()=>{
  if(dock().classList.contains('open')||sheet().getAttribute('aria-hidden')!=='true')throw Error('图谱默认展开')
  if(document.querySelector('.dpl-record-area').getBoundingClientRect().height<300)throw Error('正文被图谱挤压')
 })
 await test('档案标题加大到约 22 像素',async()=>{
  if(parseFloat(getComputedStyle(document.querySelector('.dpl-title')).fontSize)<21)throw Error('标题未加大')
 })
 await test('移到底部后向上渐显',async()=>{
  enter();await until(()=>dock().classList.contains('open'),'悬停没有呼出')
  await wait(100)
  const style=getComputedStyle(sheet())
  if(style.visibility!=='visible'||Number(style.opacity)<=0||!style.transitionTimingFunction.includes('cubic-bezier'))throw Error('缺少上滑渐显过渡')
  await wait(300)
  if(Math.abs(new DOMMatrix(getComputedStyle(sheet()).transform).m42)>1)throw Error('图谱未到达展开位置')
 })
 await test('移入图谱后保持展开',async()=>{
  pointer('pointerout',dock(),sheet());pointer('pointerover',sheet(),dock());await wait(650)
  if(!dock().classList.contains('open'))throw Error('从入口移进图谱时意外收起')
 })
 await test('展开后有独立滚动空间，图谱保持在档案边界内',async()=>{
  const area=sheet(),root=document.querySelector('.dpl-root').getBoundingClientRect(),box=area.getBoundingClientRect()
  if(getComputedStyle(area).overflowY!=='auto'||area.scrollHeight<=area.clientHeight)throw Error('图谱不能滚动')
  if(box.top<root.top||box.bottom>root.bottom)throw Error('图谱超出档案窗口')
  area.scrollTop=70;if(area.scrollTop<1)throw Error('内部滚动没有生效');area.scrollTop=0
 })
 await test('移出后延迟收起，并保留淡出动画',async()=>{
  leave();await until(()=>!dock().classList.contains('open'),'移出后没有收起')
  if(sheet().getAttribute('aria-hidden')!=='true'||!sheet().inert)throw Error('隐藏图谱仍可聚焦')
  await wait(420)
  if(getComputedStyle(sheet()).visibility!=='hidden'||Number(getComputedStyle(sheet()).opacity)!==0)throw Error('退场未完成')
 })
 await test('收起按钮不会在焦点返回后立即重开',async()=>{
  enter();await until(()=>dock().classList.contains('open'),'第二次呼出失败');await wait(400)
  ;[...dock().querySelectorAll('button')].find(button=>button.textContent==='收起图谱').click();await wait(100)
  if(dock().classList.contains('open'))throw Error('收起后被焦点重新打开')
  document.querySelector('#run-graph-dock-tests').focus();leave();await wait(600)
 })
 await test('键盘聚焦可展开，Esc 可关闭',async()=>{
  document.querySelector('.dpg-handle').focus();await until(()=>dock().classList.contains('open'),'键盘聚焦没有展开')
  document.querySelector('.dpg-handle').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(100)
  if(dock().classList.contains('open'))throw Error('Esc 未关闭或立即重开')
  document.querySelector('#run-graph-dock-tests').focus();leave();await wait(600)
 })
 // Leave the sheet open for a real wheel check through the browser tools.
 enter();await until(()=>dock().classList.contains('open'),'最终展开失败');await wait(400)
 document.querySelector('#test-summary').textContent=`${checks.filter(x=>x.ok).length}/${checks.length} 底部呼出检查通过`
}
async function selectClaim(){const calls=window.fixtureTraceCalls;const element=document.querySelector('#claim');const range=document.createRange();range.selectNodeContents(element);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);element.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));await until(()=>window.fixtureTraceCalls>calls&&document.querySelectorAll('.dsp-atom .dsp-ev').length===3,'结果未出现')}
async function demoCancelAnalysis(){
 relatedMode='empty'
 await demoLongSelection()
 traceBehavior='hold'
 ;[...document.querySelectorAll('.dsp-card button')].find(button=>button.textContent==='重新分析').click()
}
async function demoLongSelection(){
 if(document.querySelector('.dsp-trigger').getAttribute('aria-pressed')!=='true'){document.querySelector('.dsp-trigger').click();await wait(80)}
 const scope=document.querySelector('.dsp-scope');if(scope?.getAttribute('aria-pressed')==='true')scope.click()
 document.querySelector('[data-dsp-tab="trace"]').click()
 setLongSelection(true);await until(()=>document.querySelector('#claim').textContent===longSelectionText,'长选文未显示');await selectClaim()
}
async function demoFollowup(){
 if(document.querySelector('.dsp-trigger').getAttribute('aria-pressed')!=='true'){document.querySelector('.dsp-trigger').click();await wait(80)}
 const scope=document.querySelector('.dsp-scope');if(scope?.getAttribute('aria-pressed')==='true')scope.click()
 document.querySelector('[data-dsp-tab="trace"]').click();await selectClaim()
 const card=document.querySelector('.dsp-ev');card.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));card.click()
 await until(()=>normalize(getSelection().toString())===normalize(quote),'原文未定位');await wait(450)
 const rect=[...getSelection().getRangeAt(0).getClientRects()].find(rect=>rect.width>0&&rect.top>0)
 document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:rect.left+3,clientY:rect.top+rect.height/2}))
}
async function runTests(){
 window.fixtureResults=[]
 const report=(name,ok,detail='')=>{window.fixtureResults.push({name,ok,detail});document.querySelector('#test-results').textContent=JSON.stringify(window.fixtureResults,null,2)}
 const test=async(name,fn)=>{try{await fn();report(name,true)}catch(e){report(name,false,String(e))}}
 await test('按钮开启只跑一次光段，结束后保持蓝色微光',async()=>{
  const button=document.querySelector('.dsp-trigger');button.click();await wait(35)
  const orbit=button.querySelector('.dsp-trigger-orbit')
  const animations=orbit.getAnimations({subtree:true})
  if(animations.length<2)throw Error('开启时没有光段')
  if(animations.some(animation=>animation.effect.getTiming().iterations!==1 || animation.effect.getTiming().duration>500))throw Error('光段不是半秒内的单次动画')
  const transitionMs=parseFloat(getComputedStyle(button).transitionDuration)*1000
  if(transitionMs<=480)throw Error('按钮外观过渡早于光段结束')
  const fill=button.querySelector('.dsp-trigger-fill')
  const firstFlowX=new DOMMatrix(getComputedStyle(fill,'::before').transform).m41
  const firstBubbleX=new DOMMatrix(getComputedStyle(fill,'::after').transform).m41
  const frame=document.querySelector('.dsp-frame')
  if(!frame?.querySelector('.dsp-frame-orbit').getAnimations({subtree:true}).length)throw Error('聊天外框没有进入光段')
  const borderAlpha=()=>Number(getComputedStyle(frame).borderTopColor.match(/[\d.]+/g)?.[3] || 0)
  const entryAlpha=borderAlpha()
  const area=document.querySelector('[data-conversation-content]').getBoundingClientRect()
  const border=frame.getBoundingClientRect()
  if(border.width<200 || border.height<200 || Math.abs(border.width-area.width)>2)throw Error('选中了无尺寸的插槽而非真实聊天区域')
  if(getComputedStyle(frame).pointerEvents!=='none')throw Error('聊天氛围层拦截了交互')
  await wait(530)
  if(button.getAttribute('aria-pressed')!=='true' || !button.classList.contains('active'))throw Error('开启状态没有保留')
  if(Number(getComputedStyle(orbit).opacity)!==0 || orbit.getAnimations({subtree:true}).length)throw Error('开启光段未结束')
  if(getComputedStyle(button).boxShadow==='none')throw Error('常亮微光未保留')
  if(new DOMMatrix(getComputedStyle(fill,'::before').transform).m41<=firstFlowX || new DOMMatrix(getComputedStyle(fill,'::after').transform).m41<=firstBubbleX)throw Error('渐变或气泡没有从左向右移动')
  const atmosphere=document.querySelector('.dsp-frame-atmosphere')
  if(Number(getComputedStyle(atmosphere).opacity)<=0 || atmosphere.querySelectorAll('.dsp-wave').length!==2)throw Error('聊天蓝色渐变或波浪未显示')
  if(atmosphere.parentElement!==document.querySelector('[data-conversation-content]') || getComputedStyle(atmosphere).zIndex!=='-1' || getComputedStyle(atmosphere.parentElement).isolation!=='isolate')throw Error('渐变没有位于原生聊天内容下方')
  if(frame.contains(atmosphere))throw Error('渐变仍放在顶部浮层')
  if(frame.querySelector('.dsp-frame-orbit').getAnimations({subtree:true}).length)throw Error('聊天边缘光段没有结束')
  await wait(740)
  if(borderAlpha()<.25 || borderAlpha()>.48 || borderAlpha()>=entryAlpha-.1)throw Error('工作时边框过亮、过淡或未从开启亮度收暗')
 })
 await test('再次点击取消时再绕一圈，先结束光段再完成淡出',async()=>{
  const button=document.querySelector('.dsp-trigger');button.click();await wait(35)
  const orbit=button.querySelector('.dsp-trigger-orbit')
  if(!orbit.getAnimations({subtree:true}).length)throw Error('退出时未重播光段')
  const frame=document.querySelector('.dsp-frame')
  if(!frame?.querySelector('.dsp-frame-orbit').getAnimations({subtree:true}).length)throw Error('聊天外框在退出前被移除')
  await until(()=>Number(getComputedStyle(frame).borderTopColor.match(/[\d.]+/g)?.[3] || 0)>=.44,'关闭时没有短暂提亮')
  await wait(530)
  if(button.getAttribute('aria-pressed')!=='false')throw Error('取消模式未生效')
  if(orbit.getAnimations({subtree:true}).length || Number(getComputedStyle(orbit).opacity)!==0)throw Error('退出光段没有消失')
  if(!button.getAnimations().length)throw Error('按钮淡出没有晚于光段结束')
  const atmosphere=document.querySelector('.dsp-frame-atmosphere')
  if(!button.querySelector('.dsp-trigger-fill').classList.contains('moving') || Number(getComputedStyle(atmosphere).opacity)<=0)throw Error('背景动效没有保留淡出余程')
  await wait(450)
  if(button.querySelector('.dsp-trigger-fill').getAnimations({subtree:true}).length || atmosphere.getAnimations({subtree:true}).length)throw Error('退出后还有不可见的循环动画')
  await until(()=>!document.querySelector('.dsp-frame'),'聊天氛围层未移除')
  if(document.querySelector('.dsp-frame-atmosphere, .dsp-atmosphere-host, .dsp-atmosphere-static-host'))throw Error('退出后底层背景或宿主样式残留')
 })
 await test('快速连续开关不会留下叠加动画或错误状态',async()=>{
  const button=document.querySelector('.dsp-trigger')
  button.click();await wait(60);button.click();await wait(60);button.click();await wait(560)
  if(button.getAttribute('aria-pressed')!=='true')throw Error('最终开启状态错误')
  if(button.querySelector('.dsp-trigger-orbit').getAnimations({subtree:true}).length)throw Error('旧动画残留')
  button.click();await wait(1000)
 })
 await test('收起结果面板时保留模式提示和聊天渐变',async()=>{
  document.querySelector('.dsp-trigger').click();await wait(50)
  document.querySelector('.dsp-card [aria-label="收起"]').click()
  await until(()=>document.querySelector('.dsp-pill'),'面板未收起')
  if(!document.querySelector('.dsp-frame') || !document.querySelector('.dsp-trigger.active'))throw Error('收起错误地移除了运行状态')
  document.querySelector('.dsp-trigger').click();await wait(1200)
 })
 await test('真实 DOM 选区触发三类依据',async()=>{document.querySelector('.dsp-trigger').click();await wait(30);await selectClaim()})
 await test('跳转前记录阅读位置，加载旧消息后返回仍恢复原选区和可见位置',async()=>{
  const claimElement=document.querySelector('#claim');const scroll=document.querySelector('.conversation section')
  scroll.scrollTop=scroll.scrollHeight
  const offset=claimElement.getBoundingClientRect().top-scroll.getBoundingClientRect().top
  const range=document.createRange();range.selectNodeContents(claimElement);getSelection().removeAllRanges();getSelection().addRange(range)
  const card=document.querySelector('.dsp-ev');card.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));card.click()
  await until(()=>normalize(getSelection().toString())===normalize(quote),'没有选中原文');await wait(400)
  const back=document.querySelector('.dsp-back-reading');if(!back)throw Error('缺少返回按钮');back.click()
  await until(()=>getSelection().toString()===claim,'返回后原选区丢失');await wait(100)
  if(Math.abs(claimElement.getBoundingClientRect().top-scroll.getBoundingClientRect().top-offset)>5)throw Error('分页加载改变了原阅读位置 '+JSON.stringify({offset,after:claimElement.getBoundingClientRect().top-scroll.getBoundingClientRect().top,top:scroll.scrollTop,anchor:document.querySelector('[data-chat-node-key="node-900"]').getBoundingClientRect().top-scroll.getBoundingClientRect().top}))
 })
 await test('未挂载的 AI 依据由公开 loadThrough 加载并选中',async()=>{getSelection().removeAllRanges();document.querySelector('.dsp-ev').click();await until(()=>normalize(getSelection().toString())===normalize(quote),'未选中 AI 原文');if(!window.fixtureLoads.includes(3))throw Error('未调用按消息编号加载');const row=getSelection().anchorNode.parentElement.closest('[data-chat-node-key]');if(row?.dataset.chatNodeKey!=='node-3')throw Error('跳错消息')})
 await test('用户原话可以单独定位',async()=>{getSelection().removeAllRanges();[...document.querySelectorAll('.dsp-atom .dsp-ev')].find(el=>el.textContent.includes(sources[1].quote)).click();await until(()=>getSelection().toString()===sources[1].quote,'未选中用户原话')})
 await test('工具材料可以在对话内定位',async()=>{getSelection().removeAllRanges();[...document.querySelectorAll('.dsp-atom .dsp-ev')].find(el=>el.textContent.includes(sources[2].quote)).click();await until(()=>getSelection().toString()===sources[2].quote,'未选中工具原文')})
 await test('原有摘录跳转仍可选中原句',async()=>{window.dispatchEvent(new CustomEvent('dsh-provenance:jump-to-source',{detail:{quote:claim,seq:900,sessionId:'synthetic'}}));await until(()=>getSelection().toString()===claim,'摘录未跳转')})
 await test('悬停原文只有追问和返回，追问携带引用并保留草稿与附件且不自动发送',async()=>{
  await wait(450)
  const range=getSelection().getRangeAt(0);const rect=[...range.getClientRects()].find(rect=>rect.width>0&&rect.top>0)
  const input=document.querySelector('#fixture-composer');input.setSelectionRange(1,4)
  const traceCalls=window.fixtureTraceCalls
  document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:rect.left+3,clientY:rect.top+rect.height/2}))
  await until(()=>document.querySelector('.dsp-source-actions'),'悬停没有出现操作条')
  if(document.querySelector('.dsp-source-insert')||[...document.querySelectorAll('.dsp-source-actions button')].some(button=>button.textContent.includes('添加原文')))throw Error('重复的添加原文入口未移除')
  const followup=document.querySelector('.dsp-source-followup')
  if(!followup||followup.textContent!=='追问'||document.querySelectorAll('.dsp-source-actions button').length!==2)throw Error('原文操作条没有仅保留追问与返回')
  followup.click()
  await until(()=>input.value.includes('请基于以下原文回答我的追问：'),'引用未插入')
  if(!input.value.startsWith('已经写好')||!input.value.endsWith('的问题'))throw Error('已有草稿被覆盖')
  if(!input.value.includes('> '+claim)||!input.value.includes('我的追问：'))throw Error('原文引用或追问提示不符')
  if(!input.value.slice(0,input.selectionStart).endsWith('我的追问：'))throw Error('光标没有落在追问输入处')
  if(window.fixtureDraftInsertions.at(-1).attachmentIds[0]!=='synthetic-attachment'||window.fixtureSubmitCalls!==0)throw Error('附件丢失或自动发送')
  if(document.activeElement!==input||window.fixtureTraceCalls!==traceCalls)throw Error('没有聚焦输入框或误触发新分析')
 })
 await test('长引文默认三行，展开和收起不会跳原文',async()=>{
  const original=traceResult.atoms[0].evidence[0].quote
  traceResult.atoms[0].evidence[0].quote=('较长的依据原文，需要保留上下文供阅读。'.repeat(12))
  await selectClaim();await until(()=>document.querySelector('.dsp-quote-toggle'),'没有长引文展开按钮')
  const card=document.querySelector('.dsp-ev');const collapsed=card.querySelector('.dsp-ev-quote');const toggle=card.querySelector('.dsp-quote-toggle')
  if(getComputedStyle(collapsed).webkitLineClamp!=='3'||collapsed.scrollHeight<=collapsed.clientHeight)throw Error('长引文没有收为三行')
  const before=getSelection().toString();toggle.click();await wait(50)
  if(!card.querySelector('.dsp-ev-quote.expanded')||getSelection().toString()!==before)throw Error('展开触发了跳转或未展开')
  toggle.click();await wait(50)
  if(!card.querySelector('.dsp-ev-quote.clamped'))throw Error('未收起')
  traceResult.atoms[0].evidence[0].quote=original;await selectClaim()
 })
 await test('返回可在原消息重新挂载后恢复选区，并取消未结束的跳转',async()=>{
  const scroll=document.querySelector('.conversation section');scroll.scrollTop=scroll.scrollHeight
  const claimElement=document.querySelector('#claim');const range=document.createRange();range.selectNodeContents(claimElement)
  getSelection().removeAllRanges();getSelection().addRange(range)
  const card=document.querySelector('.dsp-ev');card.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));card.click()
  await until(()=>normalize(getSelection().toString())===normalize(quote),'未跳转');await wait(400)
  remountMessages();await wait(80)
  document.querySelector('.dsp-back-reading').click()
  await until(()=>getSelection().toString()===claim,'重新挂载后选区未恢复')
  if(getSelection().anchorNode.parentElement.closest('[data-chat-node-key]')?.dataset.chatNodeKey!=='node-900')throw Error('恢复了错误的同文消息')
  window.dispatchEvent(new CustomEvent('dsh-provenance:jump-to-source',{detail:{quote:quote,seq:3,sessionId:'synthetic'}}))
  await until(()=>document.querySelector('.dsp-back-reading'),'未记录新跳转')
  document.querySelector('.dsp-back-reading').click();await wait(600)
  if(getSelection().toString()!==claim)throw Error('旧跳转定时器抢回了选区')
 })
 await test('关闭窗口先缩小淡出，再移除',async()=>{const card=document.querySelector('.dsp-card');card.querySelector('[aria-label="关闭"]').click();await wait(40);if(!document.querySelector('.dsp-closing'))throw Error('没有关闭过渡');await until(()=>!document.querySelector('.dsp-card'),'未关闭')})
 await test('再次打开不残留旧动效状态',async()=>{document.querySelector('.dsp-trigger').click();await wait(30);await selectClaim();if(document.querySelector('.dsp-closing'))throw Error('残留关闭状态')})
 await test('底部回弹保留原生滚动',async()=>{const body=document.querySelector('.dsp-body');body.scrollTop=body.scrollHeight;body.dispatchEvent(new WheelEvent('wheel',{deltaY:100,bubbles:true}));await wait(35);if(!body.getAnimations().length)throw Error('没有边界回弹');await wait(400)})
 const analyzeAgain=()=>[...document.querySelectorAll('.dsp-btn')].find(el=>el.textContent==='重新分析').click()
 await test('格式异常显示具体说明与自动重试提示',async()=>{
  traceFailure={ok:false,error:'model_invalid_json',message:'模型返回的结果格式有误，暂时无法显示溯源。',hint:'已自动重试一次。请重新分析；摘录仍可保存。'}
  analyzeAgain()
  await until(()=>document.querySelector('.dsp-body')?.textContent.includes('已自动重试一次'),'重试提示未显示')
  const text=document.querySelector('.dsp-body').textContent
  if(!text.includes('结果格式有误') || text.includes('常见原因：') || text.includes('Expected'))throw Error('显示了不对应的错误说明')
 })
 await test('输出截断显示独立提示且替换上一条错误',async()=>{
  traceFailure={ok:false,error:'model_output_truncated',message:'模型的分析结果未输出完整。',hint:'已自动重试一次。可以缩小选区后重新分析。'}
  analyzeAgain()
  await until(()=>document.querySelector('.dsp-body')?.textContent.includes('未输出完整'),'截断提示未显示')
  const text=document.querySelector('.dsp-body').textContent
  if(!text.includes('缩小选区') || text.includes('结果格式有误'))throw Error('旧错误残留')
 })
 await test('重新分析恢复后清除错误并保留全部依据',async()=>{
  traceFailure=null;analyzeAgain()
  await until(()=>document.querySelectorAll('.dsp-atom .dsp-ev').length===3,'重新分析未恢复')
  const text=document.querySelector('.dsp-body').textContent
  if(text.includes('已自动重试一次') || text.includes('分析失败'))throw Error('错误提示未清除')
 })
 const tabIds=()=>[...document.querySelectorAll('[data-dsp-tab]')].map(e=>e.dataset.dspTab)
 const defaultTabs=['trace','decisions','assumptions','notes']
 const sameTabs=expected=>JSON.stringify(tabIds())===JSON.stringify(expected)
 const gear=()=>document.querySelector('.dsp-card [aria-label="设置 / Settings"]')
 const resetButton=()=>[...document.querySelectorAll('.dsp-settings button')].find(e=>e.textContent==='恢复默认 / Reset')
 await test('键盘调整标签顺序不切换页面并保留焦点',async()=>{
  gear().click();await until(resetButton,'没有恢复默认入口')
  if(!resetButton().disabled)resetButton().click()
  await until(()=>sameTabs(defaultTabs),'未恢复基准顺序')
  gear().click()
  const notes=document.querySelector('[data-dsp-tab="notes"]')
  notes.focus()
  notes.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',altKey:true,bubbles:true,cancelable:true}))
  const expected=['trace','decisions','notes','assumptions']
  await until(()=>sameTabs(expected),'键盘移动后顺序不正确')
  if(document.querySelector('.dsp-tab.active')?.dataset.dspTab!=='trace')throw Error('排序切换了当前页面')
  if(document.activeElement!==notes)throw Error('移动后丢失键盘焦点')
  if(localStorage.getItem('dsh-provenance:panel-tab-order:v1')!==JSON.stringify(expected))throw Error('顺序未保存')
 })
 await test('移动到边界不重复或丢失标签，关闭重开保留顺序',async()=>{
  const notes=document.querySelector('[data-dsp-tab="notes"]')
  for(let i=0;i<4;i++){
   notes.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',altKey:true,bubbles:true,cancelable:true}))
   await wait(20)
  }
  const expected=['notes','trace','decisions','assumptions']
  if(!sameTabs(expected))throw Error('越过边界时丢失标签或顺序错误')
  document.querySelector('.dsp-card [aria-label="关闭"]').click()
  await until(()=>!document.querySelector('.dsp-card'),'面板未关闭')
  document.querySelector('.dsp-trigger').click()
  await until(()=>document.querySelector('[data-dsp-tab]'),'面板未重新出现')
  if(!sameTabs(expected))throw Error('重开后顺序未保留')
  await selectClaim()
 })
 await test('外来拖放不改变顺序，设置可恢复默认',async()=>{
  const before=tabIds()
  const drop=new Event('drop',{bubbles:true,cancelable:true})
  document.querySelector('.dsp-tabs').dispatchEvent(drop)
  if(drop.defaultPrevented || !sameTabs(before))throw Error('错误接管了外来拖放')
  gear().click();await until(resetButton,'恢复默认入口未出现')
  if(resetButton().disabled)throw Error('自定义后恢复入口仍被禁用')
  resetButton().click()
  await until(()=>sameTabs(defaultTabs) && resetButton().disabled,'恢复默认未同步到标签和设置')
  if(localStorage.getItem('dsh-provenance:panel-tab-order:v1')!==JSON.stringify(defaultTabs))throw Error('默认顺序未保存')
  gear().click()
 })
 const searchInput=()=>document.querySelector('.dsp-search-input')
 const inputSearch=async value=>{const input=searchInput();if(!input)throw Error('没有搜索框');input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));await wait(30)}
 const tab=id=>document.querySelector(`[data-dsp-tab="${id}"]`).click()
 const byText=text=>[...document.querySelectorAll('.dsp-card button')].find(button=>button.textContent===text)
 await test('搜索入口替换模型状态行，输入前后保持同一个输入框',async()=>{
  const dock=document.querySelector('.dsp-foot-top .dsp-search-dock')
  if(!dock || document.querySelector('.dsp-card > .dsp-search-dock') || document.querySelector('.dsp-foot-stats'))throw Error('搜索入口未合并到原状态行')
  const input=searchInput()
  await inputSearch('测试查询')
  if(searchInput()!==input || document.activeElement!==input)throw Error('开始搜索时输入框重建或丢失焦点')
  await inputSearch('')
  if(searchInput()!==input || document.querySelectorAll('.dsp-foot-grid button').length!==4)throw Error('清空搜索后未恢复操作按钮')
 })
 await test('底部搜索支持键盘显现并保留渐变过渡',async()=>{
  searchInput().focus()
  await until(()=>{const style=getComputedStyle(document.querySelector('.dsp-search-form'));return Number(style.opacity)>.99&&Math.abs(new DOMMatrix(style.transform).m42)<.01},'搜索框未从底部完整显现')
  const form=document.querySelector('.dsp-search-form');const style=getComputedStyle(form)
  if(!style.transitionProperty.includes('transform')||parseFloat(style.transitionDuration)<.15)throw Error('缺少搜索框过渡')
  if(searchInput().getBoundingClientRect().right>document.querySelector('.dsp-card').getBoundingClientRect().right)throw Error('搜索框溢出')
 })
 await test('间接溯源检索旧 AI 并高亮，不调用模型或抢走输入焦点',async()=>{
  const calls=window.fixtureTraceCalls
  await inputSearch('紫杉协议')
  await until(()=>document.querySelectorAll('.dsp-search-result').length===2,'没有搜索结果')
  await until(()=>CSS.highlights.has('dsp-search-current'),'没有定位高亮')
  if(!window.fixtureLoads.includes(3))throw Error('没有加载旧消息')
  if(window.fixtureTraceCalls!==calls)throw Error('输入搜索触发了模型分析')
  if(document.activeElement!==searchInput())throw Error('自动定位抢走了输入焦点')
  const highlight=CSS.highlights.get('dsp-search')
  if(!highlight?.size)throw Error('没有词句高亮')
  for(const range of highlight)if(!range.toString().includes('紫杉协议'))throw Error('高亮不对应查询')
 })
 await test('匹配词在超高 Markdown 父块末尾时也能滚入可见区域',async()=>{
  document.querySelector('#stress-message').click();await wait(40)
  await inputSearch('');await wait(30);await inputSearch('紫杉协议')
  await until(()=>CSS.highlights.has('dsp-search-current'),'长消息未定位')
  await until(()=>{const range=[...CSS.highlights.get('dsp-search-current')][0];if(!range)return false;const box=range.getClientRects()[0];const viewport=document.querySelector('.conversation section').getBoundingClientRect();return box.top>=viewport.top&&box.bottom<=viewport.bottom},'只滚到父消息开头，匹配词仍在视口外')
  document.querySelector('#stress-message').click();await wait(40)
 })
 await test('清空搜索会清除专属高亮并恢复原溯源结果',async()=>{
  byText('×')?.closest('.dsp-search-dock')?.querySelector('button[aria-label="清空搜索"]')?.click()
  await inputSearch('')
  await until(()=>!CSS.highlights.has('dsp-search')&&!CSS.highlights.has('dsp-search-current'),'搜索高亮残留')
  if(document.querySelectorAll('.dsp-atom .dsp-ev').length!==3)throw Error('原溯源结果未恢复')
 })
 await test('中文输入法组合期间不发搜索请求',async()=>{
  const before=window.fixtureSearchRequests.length
  searchInput().dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))
  await inputSearch('环形索引');await wait(550)
  if(window.fixtureSearchRequests.length!==before)throw Error('拼音未确认就搜索')
  searchInput().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'环形索引'}))
  await until(()=>document.querySelectorAll('.dsp-search-result').length===3,'输入确认后没有搜索')
 })
 await test('忽略取消的迟到回复，不覆盖新的查询',async()=>{
  await inputSearch('迟到旧查询')
  await until(()=>window.fixtureSearchRequests.some(x=>x.query==='迟到旧查询'),'旧查询未开始')
  await inputSearch('紫杉协议')
  await until(()=>document.querySelectorAll('.dsp-search-result').length===2,'新查询未显示')
  await wait(1100)
  if(document.querySelectorAll('.dsp-search-result').length!==2||searchInput().value!=='紫杉协议')throw Error('迟到结果覆盖了新查询')
  if(!window.fixtureSearchRequests.find(x=>x.query==='迟到旧查询').aborted)throw Error('旧请求未被取消')
 })
 await test('搜索结果可直接溯源，并采用匹配消息身份而非旧选区',async()=>{
  const before=window.fixtureTraceCalls
  document.querySelector('.dsp-search-result .dsp-btn').click()
  await until(()=>document.querySelectorAll('.dsp-atom .dsp-ev').length===3,'没有进入分析结果')
  if(searchInput().value||CSS.highlights.has('dsp-search-current'))throw Error('未退出词句搜索')
  if(window.fixtureTraceCalls!==before+1||window.fixtureLastTrace.seq!==3||window.fixtureLastTrace.role!=='assistant')throw Error('沿用了旧选区的消息身份')
  if(!window.fixtureLastTrace.quote.includes('紫杉协议'))throw Error('没有使用匹配处原文')
 })
 await test('摘录、结论、假设各自筛选并记住查询，不请求聊天搜索',async()=>{
  await inputSearch('')
  await selectClaim();await wait(70)
  await until(()=>window.fixtureLastTrace.seq===900,'未选定当前回答')
  const save=byText('存为笔记');if(save)save.click();await wait(30)
  const decoy=document.querySelector('#decoy');const range=document.createRange();range.selectNodeContents(decoy);getSelection().removeAllRanges();getSelection().addRange(range);decoy.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));await until(()=>byText('存为笔记'),'第二条选区未分析')
  byText('存为笔记').click();await wait(30)
  byText('存档这条结论').click();await wait(30)
  const requests=window.fixtureSearchRequests.length
  tab('notes');await wait(30);await inputSearch('段落结构')
  if(document.querySelectorAll('.dsp-note-item').length!==1||!document.querySelector('.dsp-search-mark'))throw Error('摘录筛选或标记错误')
  tab('decisions');await wait(30);if(searchInput().value)throw Error('摘录查询泄漏到结论')
  await inputSearch('不在结论中的词句')
  if(document.querySelectorAll('.dsp-note-item').length)throw Error('未匹配结论仍显示')
  tab('assumptions');await wait(30);await inputSearch('历史记录')
  if(document.querySelectorAll('.dsp-note-item').length!==1)throw Error('假设筛选错误')
  tab('notes');await wait(30);if(searchInput().value!=='段落结构')throw Error('未记住摘录查询')
  if(window.fixtureSearchRequests.length!==requests)throw Error('本地标签搜索调用了聊天检索')
 })
 await test('搜索框内 Escape 清词而不退出溯源模式',async()=>{
  searchInput().dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await wait(40)
  if(searchInput().value||!document.querySelector('.dsp-trigger.active'))throw Error('Escape 错误地退出模式')
 })
 await test('切换会话清空搜索词、结果和高亮',async()=>{
  tab('trace');await wait(30);await inputSearch('紫杉协议')
  await until(()=>document.querySelectorAll('.dsp-search-result').length===2,'未显示搜索结果')
  document.querySelector('#switch-session').click();await wait(80)
  if(searchInput().value||document.querySelector('.dsp-search-result')||CSS.highlights.has('dsp-search'))throw Error('旧会话搜索残留')
  document.querySelector('#switch-session').click();await wait(80)
 })
 const readLedger=()=>JSON.parse(localStorage.getItem('dsh-provenance:ledger:v1'))
 const openBin=async()=>{document.querySelector('.dsp-trash-toggle').click();await until(()=>document.querySelector('.dsp-card .dpr-list'),'回收站未打开')}
 const backFromBin=async()=>{byText('← 返回').click();await until(()=>!document.querySelector('.dsp-card .dpr-list'),'回收站未关闭')}
 const restoreFirst=async()=>{const button=document.querySelector('.dsp-card [data-trash-id] button');if(!button)throw Error('没有恢复入口');button.click();await wait(40)}
 await test('摘录删除直接移入回收站，不弹确认，恢复后保留原文身份',async()=>{
  tab('notes');await wait(40);await inputSearch('')
  const before=readLedger().notes[0]
  document.querySelector('.dsp-card .dsp-note-item .danger').click()
  await until(()=>!readLedger().notes.some(item=>item.id===before.id),'没有直接移除摘录')
  if(window.fixtureConfirmCalls.length)throw Error('仍调用删除确认')
  const entry=readLedger().trash.find(item=>item.item.id===before.id)
  if(!entry || JSON.stringify(entry.item)!==JSON.stringify(before))throw Error('回收站没有保留完整原记录')
  await openBin();await restoreFirst();await backFromBin()
  if(JSON.stringify(readLedger().notes.find(item=>item.id===before.id))!==JSON.stringify(before))throw Error('恢复后原文位置或内容改变')
 })
 await test('结论与假设都支持直接删除和恢复，结论删除不连带移除假设',async()=>{
  for(const kind of ['decisions','assumptions']){
   tab(kind);await wait(40);await inputSearch('')
   const before=readLedger()[kind][0];if(!before)throw Error('缺少测试存档')
   const assumptions=readLedger().assumptions.length
   document.querySelector('.dsp-card .dsp-note-item .danger').click()
   await until(()=>!readLedger()[kind].some(item=>item.id===before.id),'没有直接删除')
   if(kind==='decisions'&&readLedger().assumptions.length!==assumptions)throw Error('假设被连带删除')
   await openBin();await restoreFirst();await backFromBin()
   if(JSON.stringify(readLedger()[kind].find(item=>item.id===before.id))!==JSON.stringify(before))throw Error('依据或状态没有完整恢复')
  }
 })
 await test('关闭重开和切换会话后仍可找回；小窗回收站只显示本对话',async()=>{
  tab('notes');await wait(40);await inputSearch('')
  const before=readLedger().notes[0]
  document.querySelector('.dsp-card .dsp-note-item .danger').click();await wait(40)
  document.querySelector('.dsp-card [aria-label="关闭"]').click();await until(()=>!document.querySelector('.dsp-card'),'小窗没有关闭')
  document.querySelector('.dsp-trigger').click();await until(()=>document.querySelector('.dsp-trash-toggle'),'小窗没有重开')
  await openBin()
  if(!document.querySelector('.dsp-card [data-trash-id]'))throw Error('重开后回收站丢失')
  document.querySelector('#switch-session').click();await wait(80);await openBin()
  if(document.querySelector('.dsp-card [data-trash-id]'))throw Error('其他会话显示了本对话删除的内容')
  document.querySelector('#switch-session').click();await wait(80);await openBin();await restoreFirst();await backFromBin()
  if(!readLedger().notes.some(item=>item.id===before.id))throw Error('切换后无法恢复')
 })
 await test('档案页摘录与结论删除也不弹窗，并通过档案回收站恢复',async()=>{
  document.querySelector('#toggle-archive').click();await until(()=>document.querySelector('.dpl-root'),'档案未打开')
  const archiveTab=label=>[...document.querySelectorAll('.dpl-tabs button')].find(button=>button.textContent.startsWith(label))
  for(const [kind,label] of [['notes','摘录'],['decisions','结论']]){
   archiveTab(label).click();await wait(40)
   const before=readLedger()[kind][0]
   document.querySelector('.dpl-root .dpl-card .danger').click();await wait(40)
   if(readLedger()[kind].some(item=>item.id===before.id))throw Error('档案删除没有生效')
   archiveTab('回收站').click();await until(()=>document.querySelector('.dpl-root [data-trash-id]'),'档案回收站没有记录')
   document.querySelector('.dpl-root [data-trash-id] button').click();await wait(40)
   if(JSON.stringify(readLedger()[kind].find(item=>item.id===before.id))!==JSON.stringify(before))throw Error('档案记录恢复不完整')
  }
  if(window.fixtureConfirmCalls.length)throw Error('某个删除入口仍调用确认')
  document.querySelector('#toggle-archive').click();await wait(40)
  tab('trace');await selectClaim()
 })
 const scope=()=>document.querySelector('.dsp-scope')
 await test('跨会话自动检索出现绿色点，切换候选不调用关系模型',async()=>{
  tab('trace');await selectClaim()
  const before=window.fixtureRelationCalls
  await until(()=>scope()&&!scope().disabled&&scope().querySelector('.found'),'没有绿色候选提示')
  if(!scope().textContent.includes('本对话'))throw Error('默认范围不是本对话')
  scope().click();await until(()=>document.querySelectorAll('.dsp-related-item').length>=2,'没有跨会话卡片')
  await until(()=>document.querySelector('.dsp-body')?.textContent.includes('6 / 6'),'没有续查全部其他会话')
  if(window.fixtureRelationCalls!==before)throw Error('查找或切换自动调用了关系模型')
  if(!document.querySelector('.dsp-body').textContent.includes('后续补充 · 不计入此前依据'))throw Error('没有区分后续观点')
  if(document.querySelector('.dsp-foot-grid')||document.querySelector('.dsp-search-dock'))throw Error('候选视图混入本对话操作')
 })
 await test('关系分析只在点击后调用，并保留候选原文及关系限制',async()=>{
  const before=window.fixtureRelationCalls
  document.querySelector('.dsp-analyze-relations').click()
  await until(()=>document.querySelector('.dsp-related-explanation'),'没有显示关系分析')
  if(window.fixtureRelationCalls!==before+1)throw Error('关系分析请求次数不对')
  if(!document.querySelector('.dsp-body').textContent.includes('6,000 字节'))throw Error('没有说明片段预算')
  if(!document.querySelector('.dsp-related-explanation').textContent.includes('不能'))throw Error('未显示关系限制')
  scope().click();await wait(40)
  if(document.querySelectorAll('.dsp-atom .dsp-ev').length!==3)throw Error('返回本对话丢失原溯源结果')
  scope().click();await wait(40)
  if(window.fixtureRelationCalls!==before+1)throw Error('反复切换自动分析')
  scope().click();await wait(40)
 })
 await test('没有候选时按钮灰色不可切换；失败单独显示且可以重试',async()=>{
  relatedMode='empty';await selectClaim()
  await until(()=>window.fixtureRelatedRequests.at(-1)?.mode==='empty'&&window.fixtureRelatedRequests.at(-1)?.completed,'空结果没有返回')
  await wait(40)
  if(!scope().disabled||scope().querySelector('.found'))throw Error('无结果仍可切换或显示绿点')
  relatedMode='error';await selectClaim()
  await until(()=>document.querySelector('.dsp-body')?.textContent.includes('关联检索暂未完成'),'失败没有单独说明')
  if(!byText('重试关联检索'))throw Error('没有重试入口')
  relatedMode='normal';byText('重试关联检索').click()
  await until(()=>!scope().disabled&&scope().querySelector('.found'),'重试没有恢复')
 })
 await test('重新选择后忽略取消的迟到跨会话检索结果',async()=>{
  relatedMode='slow';await selectClaim()
  await until(()=>window.fixtureRelatedRequests.some(row=>row.mode==='slow'),'延迟查询未开始')
  relatedMode='empty'
  const decoy=document.querySelector('#decoy');const range=document.createRange();range.selectNodeContents(decoy);getSelection().removeAllRanges();getSelection().addRange(range);decoy.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
  await until(()=>window.fixtureRelatedRequests.at(-1)?.mode==='empty'&&window.fixtureRelatedRequests.at(-1)?.completed,'新查询没有返回')
  await wait(1100)
  if(!scope().disabled||scope().querySelector('.found'))throw Error('旧查询覆盖了新选句')
  relatedMode='normal'
 })
 await test('跨会话跳转采用目标会话与消息身份，同编号原文不会跳错',async()=>{
  await selectClaim();await until(()=>!scope().disabled,'没有关联候选');scope().click()
  await until(()=>document.querySelector('.dsp-open-related'),'没有打开原文入口')
  getSelection().removeAllRanges();document.querySelector('.dsp-open-related').click()
  await until(()=>document.querySelector('[data-conversation-session="synthetic-other"]'),'没有切到关联会话')
  await until(()=>getSelection().toString().includes('另一段讨论里'),'没有选中关联会话原文')
  const row=getSelection().anchorNode.parentElement.closest('[data-chat-node-key]')
  if(row?.dataset.chatNodeKey!=='node-3')throw Error('没有定位到目标消息')
  if(document.querySelector('.dsp-related-item')||document.querySelector('.dsp-ev'))throw Error('新会话仍显示原会话的旧结果')
  const back=document.querySelector('.dsp-back-reading');if(!back)throw Error('跨会话后返回记录丢失');back.click()
  await until(()=>document.querySelector('[data-conversation-session="synthetic"]')&&getSelection().toString()===claim,'未返回原会话及选区')
  await selectClaim();await until(()=>!scope().disabled,'返回后未恢复关联检索');scope().click()
 })
 await test('摘录默认短日期与来源，完整秒数和编号仍在悬停提示中',async()=>{
  if(scope().getAttribute('aria-pressed')==='true')scope().click()
  const tab=document.querySelector('.dsp-tab[data-dsp-tab="notes"]');tab.click();await wait(80)
  const meta=document.querySelector('.dsp-note-meta span[title]')
  if(!meta||!meta.textContent.includes('今天')||meta.textContent.includes('#'))throw Error('摘录日期或编号未精简')
  if(!/\d{2}:\d{2}:\d{2}/.test(meta.title)||!meta.title.includes('消息 #'))throw Error('完整日期或消息编号丢失')
  document.querySelector('.dsp-tab[data-dsp-tab="trace"]').click()
 })
 await test('长选文默认四行并可展开收起，分析和摘录保留全文，新选区恢复折叠',async()=>{
  await demoLongSelection()
  const selected=document.querySelector('.dsp-claim-preview .dsp-claim-text')
  const toggle=document.querySelector('.dsp-claim-toggle')
  if(!selected||!toggle||getComputedStyle(selected).webkitLineClamp!=='4')throw Error('选文没有默认收为四行')
  if(selected.scrollHeight<=selected.clientHeight||selected.clientHeight>parseFloat(getComputedStyle(selected).lineHeight)*4+2)throw Error('四行省略没有生效')
  if(selected.textContent!==`「${longSelectionText}」`||window.fixtureLastTrace.quote!==longSelectionText)throw Error('折叠截断了原文或分析请求')
  const height=selected.clientHeight;const calls=window.fixtureTraceCalls
  toggle.click();await wait(50)
  if(toggle.getAttribute('aria-expanded')!=='true'||selected.clientHeight<=height)throw Error('展开后仍未显示全文')
  if(window.fixtureTraceCalls!==calls)throw Error('展开误触发了分析')
  toggle.click();await wait(50)
  if(toggle.getAttribute('aria-expanded')!=='false'||selected.clientHeight!==height)throw Error('没有恢复四行')
  const save=[...document.querySelectorAll('.dsp-claim-actions button')].find(button=>button.textContent==='存为笔记');save.click();await wait(50)
  if(!JSON.parse(localStorage.getItem('dsh-provenance:ledger:v1')).notes.some(note=>note.text===longSelectionText))throw Error('摘录未保存完整选文')
  toggle.click();await wait(30)
  setLongSelection(false);await until(()=>document.querySelector('#claim').textContent===claim,'短选文未恢复');await selectClaim()
  if(document.querySelector('.dsp-claim-toggle')||document.querySelector('.dsp-claim-text.expanded'))throw Error('新选文残留展开状态或无须展开的按钮')
 })
 await test('展开和存笔记靠右，固定标签栏在滚动及切换页面时保持可用',async()=>{
  await demoLongSelection()
  const preview=document.querySelector('.dsp-claim-preview');const expand=preview.querySelector('.dsp-claim-toggle')
  if(Math.abs(expand.getBoundingClientRect().right-preview.getBoundingClientRect().right)>2)throw Error('展开按钮未右对齐')
  const actions=document.querySelector('.dsp-claim-actions');const save=[...actions.querySelectorAll('button')].find(button=>['存为笔记','已存笔记'].includes(button.textContent))
  if(Math.abs(save.getBoundingClientRect().right-actions.getBoundingClientRect().right)>2)throw Error('存笔记未右对齐')
  const bar=document.querySelector('.dsp-tabbar');const body=document.querySelector('.dsp-body')
  if(bar.parentElement!==document.querySelector('.dsp-card')||body.contains(bar))throw Error('标签栏仍在滚动正文内')
  const top=bar.getBoundingClientRect().top;body.scrollTop=body.scrollHeight;await wait(60)
  if(Math.abs(bar.getBoundingClientRect().top-top)>1)throw Error('标签栏跟随正文滚动')
  tab('notes');await wait(60)
  if(!document.querySelector('[data-dsp-tab="notes"]').classList.contains('active')||body.scrollTop!==0)throw Error('滚动后不能切换或新正文未从开头显示')
  tab('trace');await wait(30)
  setLongSelection(false);await until(()=>document.querySelector('#claim').textContent===claim,'短选文未恢复');await selectClaim()
 })
 await test('三类记录与档案长文默认三行，右侧查看全文可展开并保留搜索标记',async()=>{
  const original=traceResult.assumptions[0]
  const longAssumption='这是一条需要逐项确认的虚构长假设，展开后应当保留全部内容。'.repeat(14)+'假设末尾匹配'
  traceResult.assumptions[0]=longAssumption
  await demoLongSelection()
  const save=byText('存为笔记');if(save)save.click();await wait(40)
  byText('存档这条结论').click();await wait(60)
  for(const name of ['notes','decisions','assumptions']){
   tab(name);await wait(60);await inputSearch('')
   const expected=name==='assumptions'?longAssumption:longSelectionText
   const text=[...document.querySelectorAll('.dsp-body .dsp-record-text')].find(element=>element.textContent===expected)
   if(!text||getComputedStyle(text).webkitLineClamp!=='3'||text.scrollHeight<=text.clientHeight)throw Error(name+' 未收为三行')
   const parent=text.closest('.dsp-record-preview');const toggle=parent.querySelector('.dsp-record-toggle')
   if(!toggle||Math.abs(toggle.getBoundingClientRect().right-parent.getBoundingClientRect().right)>2)throw Error(name+' 查看全文未右对齐')
   const before=text.clientHeight;toggle.click();await wait(30)
   if(text.clientHeight<=before||text.textContent!==expected)throw Error(name+' 展开未保留全文')
   toggle.click();await wait(30)
   if(text.clientHeight!==before)throw Error(name+' 未收起')
  }
  await inputSearch('假设末尾匹配')
  const match=document.querySelector('.dsp-record-text .dsp-search-mark')
  if(!match)throw Error('折叠组件丢失搜索标记')
  match.closest('.dsp-record-preview').querySelector('.dsp-record-toggle').click();await wait(30)
  if(!match.closest('.dsp-record-text').classList.contains('expanded'))throw Error('匹配内容未能展开')
  await inputSearch('')
  document.querySelector('#toggle-archive').click();await wait(70)
  const archive=document.querySelector('#fixture-archive')
  const notes=[...archive.querySelectorAll('.dpl-tabs button')].find(button=>button.textContent.startsWith('摘录'));notes.click();await wait(50)
  const archived=[...archive.querySelectorAll('.dsp-record-text')].find(element=>element.textContent===longSelectionText)
  if(!archived||getComputedStyle(archived).webkitLineClamp!=='3')throw Error('档案页未应用三行预览')
  archived.closest('.dsp-record-preview').querySelector('.dsp-record-toggle').click();await wait(30)
  if(!archived.classList.contains('expanded'))throw Error('档案页未展开')
  document.querySelector('#toggle-archive').click();await wait(40)
  traceResult.assumptions[0]=original;tab('trace');setLongSelection(false)
  await until(()=>document.querySelector('#claim').textContent===claim,'短选文未恢复');await selectClaim()
 })
 await test('取消分析中断请求并保留选文，可立即重新分析，迟到结果不会覆盖新结果',async()=>{
  traceBehavior='late'
  const calls=window.fixtureTraceCalls
  const input=document.querySelector('#claim');const range=document.createRange();range.selectNodeContents(input)
  getSelection().removeAllRanges();getSelection().addRange(range);input.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))
  await until(()=>window.fixtureTraceCalls>calls&&document.querySelector('.dsp-cancel-analysis'),'缺少取消分析入口')
  const request=window.fixtureTraceRequests.at(-1)
  const actions=document.querySelector('.dsp-progress');const cancel=actions.querySelector('.dsp-cancel-analysis')
  if(!cancel.classList.contains('danger')||Math.abs(cancel.getBoundingClientRect().right-actions.getBoundingClientRect().right)>2)throw Error('取消按钮未与进度文字同排靠右')
  if(document.querySelector('.dsp-claim-actions .dsp-cancel-analysis')||Math.abs(cancel.getBoundingClientRect().y+cancel.getBoundingClientRect().height/2-actions.querySelector('.dsp-progress-message').getBoundingClientRect().y-actions.querySelector('.dsp-progress-message').getBoundingClientRect().height/2)>2)throw Error('取消按钮仍单独占行或未对齐')
  cancel.click();await wait(60)
  if(!request.aborted||document.querySelector('.dsp-spin')||document.querySelector('.dsp-cancel-analysis'))throw Error('取消未中断请求或未停止加载')
  if(document.querySelector('.dsp-claim-text').textContent!==`「${claim}」`||!byText('存为笔记'))throw Error('取消后选文或存笔记丢失')
  traceBehavior='normal';await selectClaim()
  await until(()=>request.completed,'旧响应没有返回');await wait(50)
  if(document.querySelector('.dsp-body').textContent.includes('迟到的旧分析')||document.querySelectorAll('.dsp-atom .dsp-ev').length!==3)throw Error('旧分析覆盖了新结果')
 })
 await test('补充网页检索也可取消，迟到材料不显示且可再次发起检索',async()=>{
  byText('联网查资料').click();await until(()=>document.querySelector('.dsp-cancel-analysis'),'补查缺少取消按钮')
  const request=window.fixtureWebRequests.at(-1)
  document.querySelector('.dsp-cancel-analysis').click();await wait(50)
  if(!request.aborted||!byText('联网查资料')||byText('联网查资料').disabled)throw Error('补查未中断或没有恢复入口')
  await until(()=>request.completed,'迟到补查没有结束');await wait(40)
  if(document.querySelector('.dsp-body').textContent.includes('迟到的网页材料')||document.querySelectorAll('.dsp-atom .dsp-ev').length!==3)throw Error('取消补查影响原结果或显示迟到材料')
 })
 await test('关系分析可取消且保留候选，迟到分析不显示并支持重新分析',async()=>{
  await selectClaim();await until(()=>!scope().disabled,'没有关联候选');scope().click();await wait(50)
  relationBehavior='late';document.querySelector('.dsp-analyze-relations').click()
  await until(()=>document.querySelector('.dsp-cancel-analysis'),'关系分析没有取消入口')
  const request=window.fixtureRelationRequests.at(-1)
  document.querySelector('.dsp-cancel-analysis').click();await wait(40)
  if(!request.aborted||document.querySelector('.dsp-analyze-relations').disabled||!document.querySelector('.dsp-related-item'))throw Error('取消关系分析后候选或入口丢失')
  await until(()=>request.completed,'迟到关系分析未结束');await wait(40)
  if(document.querySelector('.dsp-related-explanation'))throw Error('取消后显示了迟到关系判断')
  relationBehavior='normal';document.querySelector('.dsp-analyze-relations').click()
  await until(()=>document.querySelector('.dsp-related-explanation'),'重新分析没有恢复')
  scope().click();await wait(40)
 })
 await test('分析圆环保持正圆，背景气泡上升到半高，波浪向右移动并在取消后渐隐停止',async()=>{
  traceBehavior='hold';analyzeAgain()
  try{
   await until(()=>document.querySelector('.dsp-spin')&&document.querySelector('.dsp-thinking.moving'),'分析动效未启动')
   const surface=document.querySelector('.dsp-thinking');const card=surface.closest('.dsp-card')
   const spinner=document.querySelector('.dsp-spin');const ring=spinner.getBoundingClientRect()
   if(spinner.tagName.toLowerCase()!=='svg'||spinner.querySelectorAll('circle').length!==2||Math.abs(ring.width-ring.height)>1||ring.width<14)throw Error('加载圆环变形或被文字挤压')
   const area=surface.getBoundingClientRect();const bounds=card.getBoundingClientRect()
   if(Math.abs(area.top-(bounds.top+bounds.height/2))>2||Math.abs(area.bottom-bounds.bottom)>2)throw Error('气泡范围超过窗口下半部')
   if(getComputedStyle(surface).pointerEvents!=='none'||getComputedStyle(surface).zIndex!=='-1'||getComputedStyle(card).isolation!=='isolate')throw Error('动效没有放在文字和控件下方')
   await wait(250)
   const opacity=Number(getComputedStyle(surface).opacity)
   if(opacity<=0||opacity>=1)throw Error('进入时没有渐显')
   const wave=surface.querySelector('.dsp-thinking-wave');const bubble=surface.querySelector('.dsp-thinking-bubble')
   const waveX=new DOMMatrix(getComputedStyle(wave).transform).m41;const bubbleY=new DOMMatrix(getComputedStyle(bubble).transform).m42
   await wait(130)
   if(new DOMMatrix(getComputedStyle(wave).transform).m41<=waveX||new DOMMatrix(getComputedStyle(bubble).transform).m42>=bubbleY)throw Error('波浪或气泡方向错误')
   await until(()=>Number(getComputedStyle(surface).opacity)>.99,'动效未完成渐显')
   document.querySelector('.dsp-cancel-analysis').click();await wait(80)
   if(Number(getComputedStyle(surface).opacity)<=0||!surface.classList.contains('moving'))throw Error('结束时动效突然消失')
   await until(()=>Number(getComputedStyle(surface).opacity)===0&&!surface.classList.contains('moving'),'动效没有完成渐隐')
   if(surface.getAnimations({subtree:true}).length)throw Error('隐藏后仍运行循环动画')
  }finally{
   document.querySelector('.dsp-cancel-analysis')?.click();traceBehavior='normal'
  }
 })
 await test('设置可单独关闭和恢复分析气泡波浪，保留选择且不影响分析请求',async()=>{
  await selectClaim();traceBehavior='hold';analyzeAgain()
  try{
   await until(()=>document.querySelector('.dsp-thinking.moving'),'分析未开始')
   gear().click();await until(()=>document.querySelector('.dsp-settings-check input'),'缺少分析动效开关')
   const toggle=()=>document.querySelector('.dsp-settings-check input')
   if(!toggle().checked)throw Error('动效默认未开启')
   const request=window.fixtureTraceRequests.at(-1);toggle().click()
   await until(()=>!document.querySelector('.dsp-thinking.moving'),'关闭后没有停止动画')
   if(localStorage.getItem('dsh-provenance:thinking-effects:v1')!=='false'||request.aborted||!document.querySelector('.dsp-spin'))throw Error('关闭动效没有持久保存或误中断分析')
   gear().click();await wait(30);gear().click();await wait(30)
   if(toggle().checked)throw Error('重新打开设置丢失选择')
   toggle().click();await until(()=>document.querySelector('.dsp-thinking.moving'),'重新勾选未恢复动效')
   if(localStorage.getItem('dsh-provenance:thinking-effects:v1')!=='true')throw Error('开启选择未保存')
  }finally{
   const toggle=document.querySelector('.dsp-settings-check input');if(toggle&&!toggle.checked)toggle.click()
   if(document.querySelector('.dsp-settings'))gear().click()
   document.querySelector('.dsp-cancel-analysis')?.click();traceBehavior='normal'
  }
 })
 await test('筛选、思路链与假设保持同排，悬停只显示对应内容并支持筛选和键盘',async()=>{
  await selectClaim()
  const tool=id=>document.querySelector(`[data-dsp-tool="${id}"]`)
  const ids=['filter','chain','assumptions'];const rects=ids.map(id=>tool(id).getBoundingClientRect())
  if(rects.some(rect=>Math.abs(rect.top-rects[0].top)>1)||!(rects[0].right<=rects[1].left&&rects[1].right<=rects[2].left))throw Error('三项工具没有从左到右同排')
  const hover=async(id,previous)=>{if(previous)tool(previous).dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:tool(id)}));else tool(id).dispatchEvent(new MouseEvent('mouseover',{bubbles:true,relatedTarget:document.body}));await wait(30)}
  await hover('filter')
  if(document.querySelectorAll('.dsp-filters button').length!==5)throw Error('悬停没有展开来源筛选')
  ;[...document.querySelectorAll('.dsp-filters button')].find(button=>button.textContent==='你的原话').click();await wait(30)
  if(document.querySelectorAll('.dsp-atom .dsp-ev').length!==1||!document.querySelector('.dsp-ev').textContent.includes('你的原话'))throw Error('筛选没有限制依据来源')
  ;[...document.querySelectorAll('.dsp-filters button')].find(button=>button.textContent==='全部').click();await wait(30)
  await hover('chain','filter')
  if(document.querySelectorAll('.dsp-node').length!==4||document.querySelector('.dsp-filters'))throw Error('思路链未独立显示')
  await hover('assumptions','chain')
  if(!document.querySelector('.dsp-tool-assumptions')||document.querySelector('.dsp-timeline')||!byText('只存假设'))throw Error('假设未独立显示')
  tool('assumptions').click();await wait(30)
  document.querySelector('.dsp-analysis-tools').dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}));await wait(30)
  if(!document.querySelector('.dsp-tool-assumptions'))throw Error('点击后无法保留展开内容')
  tool('assumptions').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await wait(30)
  if(document.querySelector('.dsp-analysis-content')||!document.querySelector('.dsp-trigger.active'))throw Error('Escape 没有仅收起工具')
  tool('filter').focus();tool('filter').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));await wait(30)
  if(document.activeElement!==tool('chain')||tool('chain').getAttribute('aria-expanded')!=='true')throw Error('键盘不能切换工具')
  tool('chain').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await wait(30)
 })
 await test('查看档案切换原生大对话页签并聚焦已存结论，与搜索入口有竖线分隔',async()=>{
  await selectClaim();byText('存档这条结论').click();await wait(50)
  const divider=document.querySelector('.dsp-foot-divider');const input=document.querySelector('.dsp-search-input')
  if(getComputedStyle(divider).display==='none'||divider.getBoundingClientRect().width>2||divider.getBoundingClientRect().height<12)throw Error('档案与搜索之间缺少竖线')
  byText('查看档案').click();await until(()=>document.querySelector('.dpl-root'),'查看档案没有切换视图')
  const archiveTab=[...document.querySelectorAll('[data-conversation-tabs] [role="tab"]')].find(button=>button.textContent==='档案')
  if(archiveTab.getAttribute('aria-selected')!=='true'||!document.querySelector('.dpl-ev'))throw Error('没有切换大对话档案或聚焦结论')
  const archive=document.querySelector('.dpl-root')
  ;[...archive.querySelectorAll('.dpl-tabs button')].find(button=>button.textContent.startsWith('摘录')).click();await wait(30)
  byText('查看档案').click();await wait(40)
  if(!document.querySelector('.dpl-ev')||![...archive.querySelectorAll('.dpl-tabs button')].find(button=>button.textContent.startsWith('结论')).classList.contains('active'))throw Error('档案已经打开时没有返回对应结论')
  ;[...archive.querySelectorAll('.dpl-tabs button')].find(button=>button.textContent.startsWith('摘录')).click();await wait(30)
  const jump=archive.querySelector('[data-dsp-jump]');jump.click();await until(()=>!document.querySelector('.dpl-root'),'跳转原文没有返回对话视图')
  if(document.querySelector('.dsp-search-input')!==input)throw Error('打开档案替换了搜索输入框')
 })
 await test('模式提示相对主对话区域居中，拖动宽度后仍居中且保持在区域内',async()=>{
  const region=document.querySelector('[data-conversation-content]');const original=region.style.cssText
  const centered=()=>{const box=region.getBoundingClientRect();const hint=document.querySelector('.dsp-hint').getBoundingClientRect();return Math.abs((hint.left+hint.width/2)-(box.left+box.width/2))<2&&hint.width<=box.width-22}
  try{
   await until(centered,'提示条没有相对主对话居中')
   region.style.width=`${Math.min(800,innerWidth-100)}px`;region.style.marginLeft='64px';region.style.marginRight='0'
   await until(centered,'加宽和移动对话区域后提示条未跟随')
   region.style.width='320px'
   await until(centered,'缩窄后提示条没有保持居中或超出区域')
  }finally{region.style.cssText=original;await until(centered,'恢复布局后居中错误')}
 })
 await test('设置与回收站展示全会话共用的 50 条、30 天保留规则',async()=>{
  gear().click();await until(()=>document.querySelector('.dsp-retention-policy'),'设置缺少回收站规则')
  const policy=document.querySelector('.dsp-retention-policy').textContent
  if(!policy.includes('50')||!policy.includes('30')||!policy.includes('所有会话共用'))throw Error('设置里的容量或期限错误')
  gear().click();await openBin()
  const hint=document.querySelector('.dsp-card .dpr-hint').textContent
  if(!hint.includes('50')||!hint.includes('30')||!hint.includes('最早移入'))throw Error('回收站没有说明自动清理规则')
  await backFromBin()
 })
 if(window.fixtureErrors.length)report('运行时无异常',false,window.fixtureErrors.join('\n'));else report('运行时无异常',true)
 document.querySelector('#test-summary').textContent=`${window.fixtureResults.filter(x=>x.ok).length}/${window.fixtureResults.length} 通过`
}
createRoot(document.querySelector('#root')).render(h(App))

async function runInteractionTests(){
 const checks=[]
 const record=(name,ok,detail='')=>{checks.push({name,ok,detail});document.querySelector('#test-results').textContent=JSON.stringify(checks,null,2)}
 const test=async(name,fn)=>{try{await fn();record(name,true)}catch(error){record(name,false,String(error))}}
 const byText=text=>[...document.querySelectorAll('button')].find(el=>el.textContent===text)
 const selectRaw=()=>{const el=document.querySelector('#claim'),r=document.createRange();r.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(r);el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))}
 const close=async()=>{if(document.querySelector('.dsp-card')){document.querySelector('.dsp-card [aria-label="关闭"]').click();await until(()=>!document.querySelector('.dsp-card'),'关闭未完成')}getSelection().removeAllRanges()}
 const check=text=>[...document.querySelectorAll('.dsp-material-options label')].find(el=>el.textContent===text).querySelector('input')
 if(!document.querySelector('.dsp-card')){document.querySelector('.dsp-trigger').click();await until(()=>document.querySelector('.dsp-card'),'初始化模式失败')}
 document.querySelector('.dsp-card [aria-label="设置 / Settings"]').click();await until(()=>document.querySelector('.dsp-settings'),'初始化设置失败')
 for(const label of ['窗口边缘吸附','拖选后自动分析']){const input=[...document.querySelectorAll('.dsp-settings-check')].find(el=>el.textContent.includes(label)).querySelector('input');if(input.checked!==(label==='窗口边缘吸附'))input.click()}
 await wait(40);byText('恢复窗口位置 / Reset position').click();document.querySelector('.dsp-card [aria-label="设置 / Settings"]').click()
 await close()
 await test('未开模式拖选只出现小入口，不调用模型；点击后启动溯源',async()=>{
  const before=window.fixtureTraceCalls;selectRaw();await until(()=>document.querySelector('.dsp-quick-trace'),'缺少选词入口')
  if(window.fixtureTraceCalls!==before)throw Error('拖选即调用模型')
  byText('溯源这段').click();await until(()=>window.fixtureTraceCalls===before+1&&document.querySelectorAll('.dsp-atom .dsp-ev').length===3,'未启动溯源')
 })
 await test('检索未配置有明确提示，失败按钮可直接重试且保留归因',async()=>{
  webBehavior='unconfigured';const before=window.fixtureTraceCalls;byText('联网查资料').click()
  await until(()=>document.querySelector('.dsp-extra')?.textContent.includes('尚未配置'),'缺少配置说明')
  if(!byText('重试网页检索')||byText('重试网页检索').disabled)throw Error('失败后仍禁用')
  webBehavior='empty';byText('重试网页检索').click();await until(()=>document.querySelector('.dsp-extra')?.textContent.includes('未找到可直接支撑'),'空结果不明确')
  if(window.fixtureTraceCalls!==before||byText('再次检索网页').disabled)throw Error('重试影响了归因或入口')
  if(document.querySelector('.dsp-extra').textContent.includes('当时未使用'))throw Error('仍有误导文案')
 })
 await test('解释词句独立于网页检索，明确解释未核验',async()=>{
  webBehavior='normal';byText('解释词句').click();await until(()=>document.querySelector('.dsp-explanation'),'解释未显示')
  if(window.fixtureWebRequests.at(-1).body.intent!=='explain'||!document.querySelector('.dsp-extra .dsp-extra-title').textContent.includes('未作事实核验'))throw Error('解释与核验混淆')
 })
 await test('标题拖动吸附并保存位置，不影响设置按钮',async()=>{
  const head=document.querySelector('.dsp-head'),box=document.querySelector('.dsp-card').getBoundingClientRect(),x=box.x+70,y=box.y+20
  head.dispatchEvent(new PointerEvent('pointerdown',{button:0,clientX:x,clientY:y,bubbles:true}))
  window.dispatchEvent(new PointerEvent('pointermove',{clientX:70+12,clientY:100,bubbles:true}));await wait(50)
  window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));await wait(50)
  const moved=document.querySelector('.dsp-card').getBoundingClientRect()
  if(Math.abs(moved.left-8)>2||!localStorage.getItem('dsh-provenance:position:v1'))throw Error('未吸附并保存')
  document.querySelector('.dsp-card [aria-label="设置 / Settings"]').click();await until(()=>document.querySelector('.dsp-settings'),'设置按钮不能点击')
 })
 await test('设置可关闭吸附，恢复窗口位置',async()=>{
  const wrap=[...document.querySelectorAll('.dsp-settings-check')].find(el=>el.textContent.includes('窗口边缘吸附'));wrap.querySelector('input').click();await wait(30)
  if(JSON.parse(localStorage.getItem('dsh-provenance:interaction:v1')).snap!==false)throw Error('吸附设置未保存')
  byText('恢复窗口位置 / Reset position').click();await wait(30)
  if(localStorage.getItem('dsh-provenance:position:v1'))throw Error('位置未重置')
  wrap.querySelector('input').click();await wait(30);document.querySelector('.dsp-card [aria-label="设置 / Settings"]').click();await wait(30)
 })
 await test('任务材料读取冻结快照并标记未读取文件；默认不调用关系模型',async()=>{
  check('包含任务材料').click();await until(()=>document.querySelector('.dsp-materials')?.textContent.includes('任务内冻结资料'),'任务快照未出现')
  const el=document.querySelector('.dsp-materials');if(!el.textContent.includes('截至 #4')||!el.textContent.includes('research/notes.md')||window.fixtureMaterialRequests.at(-1).analyze)throw Error('快照身份/读取范围不正确')
  if(document.querySelectorAll('.dsp-material-options input').length!==1)throw Error('仍有后续补充勾选项')
 })
 await test('后续内容单独展示并能打开原文，未倒置成历史依据',async()=>{
  await until(()=>document.querySelector('.dsp-materials')?.textContent.includes('后续补充：'),'未发现后续材料')
  if(!document.querySelector('.dsp-later .dsp-rel-later')||!document.querySelector('.dsp-materials').textContent.includes('晚于选句'))throw Error('后续材料没有时间边界')
  const earlier=document.querySelector('.dsp-atom'),later=document.querySelector('.dsp-later');if(!(earlier.compareDocumentPosition(later)&Node.DOCUMENT_POSITION_FOLLOWING))throw Error('后续未排在此前依据后面')
  document.querySelector('[data-dsp-tool=filter]').click();await until(()=>document.querySelector('[data-filter=later]'),'缺少后续筛选');document.querySelector('[data-filter=later]').click();await wait(30)
  if(document.querySelector('.dsp-atom')||!document.querySelector('.dsp-later'))throw Error('后续筛选混入此前依据')
  document.querySelector('[data-filter=all]').click();await wait(30)
  const card=[...document.querySelectorAll('.dsp-materials article')].find(el=>el.textContent.includes('后续补充：'));card.querySelector('button').click();await until(()=>window.fixtureLoads.includes(920)&&getSelection().toString().includes('后续补充：'),'后续原文跳转未完成')
 })
 await test('同一选句重新分析会重新读取后续消息，不沿用旧起点',async()=>{
  const previous=window.fixtureMaterialRequests.length;byText('重新分析').click()
  await until(()=>window.fixtureMaterialRequests.length>previous&&document.querySelector('.dsp-later'),'重新分析未更新后续内容')
  if(window.fixtureMaterialRequests.at(-1).includeLater!==true)throw Error('默认后续检索未传递')
 })
 await test('关系分析按需调用并保留材料来源',async()=>{
  byText('分析材料关系').click();await until(()=>document.querySelector('.dsp-materials')?.textContent.includes('这是后续讨论中的补充'),'关系说明未出现')
  if(!window.fixtureMaterialRequests.at(-1).analyze)throw Error('未发显式分析')
 })
 await test('自动分析可选，关闭模式后拖选也可直接启动',async()=>{
  document.querySelector('.dsp-card [aria-label="设置 / Settings"]').click()
  await until(()=>document.querySelector('.dsp-settings'),'设置未打开');const auto=[...document.querySelectorAll('.dsp-settings-check')].find(el=>el.textContent.includes('拖选后自动分析')).querySelector('input');auto.click();await wait(50)
  await close();const before=window.fixtureTraceCalls;selectRaw();await until(()=>window.fixtureTraceCalls>before&&document.querySelectorAll('.dsp-atom .dsp-ev').length>=3,'自动分析未触发')
  document.querySelector('.dsp-card [aria-label="设置 / Settings"]').click();await until(()=>document.querySelector('.dsp-settings'),'重开设置未出现');[...document.querySelectorAll('.dsp-settings-check')].find(el=>el.textContent.includes('拖选后自动分析')).querySelector('input').click()
  document.querySelector('.dsp-card [aria-label="设置 / Settings"]').click()
 })
 await test('缺少检索凭据时可打开内置配置页，不提交凭据或重新分析',async()=>{
  webBehavior='unconfigured';byText('联网查资料')?.click();if(!byText('联网查资料'))byText('再次检索网页')?.click()
  await until(()=>byText('配置网页检索'),'缺少配置入口');const before=window.fixtureTraceCalls
  byText('配置网页检索').click();await until(()=>document.querySelector('[data-fixture-config]'),'未打开配置页')
  if(window.fixtureConfigNavigations!==1||window.fixtureTraceCalls!==before)throw Error('配置导航造成额外归因调用')
 })
 await test('运行时无异常',async()=>{if(window.fixtureErrors.length)throw Error(window.fixtureErrors.join(' | '))})
 window.fixtureInteractionResults=checks
}

async function demoReview(kind){
 await until(()=>document.querySelector('.dsp-trigger'),'插件尚未加载完成')
 const byText=text=>[...document.querySelectorAll('button')].find(el=>el.textContent===text)
 if(kind==='selection'){
  if(document.querySelector('.dsp-card')){document.querySelector('.dsp-card [aria-label="关闭"]').click();await until(()=>!document.querySelector('.dsp-card'),'关闭中')}
  const el=document.querySelector('#claim');el.scrollIntoView({block:'center'});const range=document.createRange();range.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(range);el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return
 }
 if(!document.querySelector('.dsp-card')){document.querySelector('.dsp-trigger').click();await until(()=>document.querySelector('.dsp-card'),'未打开')}
 for(const input of document.querySelectorAll('.dsp-material-options input'))if(input.checked)input.click()
 await wait(60);await selectClaim()
 if(kind==='progress'){traceBehavior='hold';byText('重新分析').click();return}
 if(kind==='web'){
  webBehavior='unconfigured';byText('联网查资料').click();await until(()=>document.querySelector('.dsp-extra')?.textContent.includes('尚未配置'),'未显示错误');webBehavior='normal'
  document.querySelector('.dsp-extra').scrollIntoView({block:'center'})
 }else{
  for(const input of document.querySelectorAll('.dsp-material-options input'))if(!input.checked)input.click()
  await until(()=>document.querySelector('.dsp-materials')?.textContent.includes('任务内冻结资料'),'材料未加载')
  document.querySelector('.dsp-body').scrollTop=0
 }
}

async function runResizeTests(){
 const checks=[],record=(name,ok,detail='')=>{checks.push({name,ok,detail});document.querySelector('#test-results').textContent=JSON.stringify(checks,null,2)}
 const test=async(name,fn)=>{try{await fn();record(name,true)}catch(error){record(name,false,String(error))}}
 const box=()=>document.querySelector('.dsp-card').getBoundingClientRect()
 const drag=async(edge,dx,dy,cancel=false)=>{
  const el=document.querySelector(`.dsp-resize[data-edge="${edge}"]`),r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2
  el.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:1,clientX:x,clientY:y,bubbles:true}))
  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,clientX:x+dx,clientY:y+dy,bubbles:true}));await wait(35)
  window.dispatchEvent(new PointerEvent(cancel?'pointercancel':'pointerup',{pointerId:1,clientX:x+dx,clientY:y+dy,bubbles:true}));await wait(60)
 }
 const baseline=async()=>{
  let r=box();await drag('se',420-r.width,400-r.height);r=box()
  document.querySelector('.dsp-head').dispatchEvent(new PointerEvent('pointerdown',{button:0,clientX:r.x+70,clientY:r.y+20,bubbles:true}))
  window.dispatchEvent(new PointerEvent('pointermove',{clientX:270,clientY:120,bubbles:true}));await wait(30)
  window.dispatchEvent(new PointerEvent('pointerup'));await wait(40)
 }
 if(!document.querySelector('.dsp-card')){document.querySelector('.dsp-trigger').click();await until(()=>document.querySelector('.dsp-card'),'窗口未打开')}
 await selectClaim()
 await test('四边四角都有独立缩放入口，按钮仍可点击',async()=>{
  if(document.querySelectorAll('.dsp-resize').length!==8)throw Error('缩放入口不是八个')
  document.querySelector('.dsp-gear').click();await until(()=>document.querySelector('.dsp-settings'),'边角遮挡设置按钮');document.querySelector('.dsp-gear').click()
 })
 for(const edge of ['n','ne','e','se','s','sw','w','nw'])await test(`${edge} 缩放保持对边不动`,async()=>{
  await baseline();const before=box(),dx=edge.includes('w')?18:edge.includes('e')?-18:0,dy=edge.includes('n')?18:edge.includes('s')?-18:0
  await drag(edge,dx,dy);const after=box()
  if(Math.abs(after.width-(before.width-(dx?18:0)))>1||Math.abs(after.height-(before.height-(dy?18:0)))>1)throw Error('尺寸变化错误')
  if(Math.abs((edge.includes('w')?after.right:after.left)-(edge.includes('w')?before.right:before.left))>1)throw Error('左右对边漂移')
  if(Math.abs((edge.includes('n')?after.bottom:after.top)-(edge.includes('n')?before.bottom:before.top))>1)throw Error('上下对边漂移')
 })
 await test('最小尺寸和屏幕边界限制，不会反向翻转',async()=>{
  await baseline();await drag('nw',9999,9999);let r=box();if(Math.abs(r.width-320)>1||Math.abs(r.height-240)>1)throw Error('最小尺寸失效')
  await drag('nw',-9999,-9999);r=box();if(r.left<7||r.top<7)throw Error('窗口移出屏幕')
  await drag('se',9999,9999);r=box();if(r.right>innerWidth-7||r.bottom>innerHeight-7)throw Error('窗口越过屏幕')
 })
 await test('指针取消后停止缩放，关闭重开保留大小与位置',async()=>{
  await baseline();await drag('e',-18,0,true);let r=box();const saved=JSON.parse(localStorage.getItem('dsh-provenance:size:v1'))
  if(Math.abs(saved.w-r.width)>1||document.querySelector('.dsp-card').dataset.resizing!=='false')throw Error('未保存或未停止')
  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,clientX:900,clientY:800}));await wait(30);if(box().width!==r.width)throw Error('取消后仍在缩放')
  document.querySelector('.dsp-close').click();await until(()=>!document.querySelector('.dsp-card'),'关闭未完成');document.querySelector('.dsp-trigger').click();await until(()=>document.querySelector('.dsp-card'),'重开失败');await wait(280)
  if(Math.abs(box().width-r.width)>1||Math.abs(box().left-r.left)>1)throw Error('重开后丢失尺寸或位置')
 })
 await test('键盘可微调尺寸，双击恢复默认宽度',async()=>{
  await baseline();const before=box(),handle=document.querySelector('.dsp-resize[data-edge="w"]');handle.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await wait(40)
  if(Math.abs(box().width-before.width+16)>1||Math.abs(box().right-before.right)>1)throw Error('键盘调整失效')
  handle.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));await wait(50);if(box().width!==420)throw Error('双击未复位')
 })
 await test('运行时无异常',async()=>{if(window.fixtureErrors.length)throw Error(window.fixtureErrors.join(' | '))})
}
