const React = require('react')
const ReactDOM = require('react-dom')
const {createRoot} = require('react-dom/client')
const h = React.createElement
const handlers = new Map()
let pluginContext
let setOldVisible
let setArchiveVisible
let setFixtureSession
let remountMessages
const quote='紫杉协议采用环形索引，确保长对话中的定位一致性。\n\n**该协议保留原文的段落结构。**'
const normalize=value=>String(value).replace(/[*_`]/g,'').replace(/\s+/g,' ').trim()
const claim='因此，紫杉协议应采用环形索引，确保定位一致性。'
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
const realFetch=window.fetch.bind(window)
let traceFailure = null
let relatedMode = 'normal'
window.fixtureRelatedRequests=[]
window.fixtureRelationCalls=0
window.fixtureSearchRequests=[]
window.fixtureTraceCalls=0
window.fetch=async (url,init)=>{
 if(!/^\/plugins\/dsh-provenance(?:-lens)?\//.test(String(url)))return realFetch(url,init)
 const body=JSON.parse(init.body||'{}')
 if(String(url).endsWith('/related')){
  const request={...body,mode:relatedMode,completed:false};window.fixtureRelatedRequests.push(request)
  let response
  if(relatedMode==='empty')response=Response.json({ok:true,scanId:'empty',hits:[],complete:true,scannedSessions:6,totalSessions:6,failedSessions:0})
  else if(relatedMode==='error')response=Response.json({ok:false,error:'related_failed',message:'关联检索暂未完成，请重试。'})
  else {response=await realFetch(url,{...init,...(relatedMode==='slow'?{signal:undefined}:{})});if(request.mode==='slow')await new Promise(resolve=>setTimeout(resolve,1000))}
  request.completed=true
  return response
 }
 if(String(url).endsWith('/relationships')){window.fixtureRelationCalls++;return realFetch(url,init)}
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
 if(String(url).endsWith('/trace')){window.fixtureTraceCalls++;window.fixtureLastTrace=body;return Response.json(traceFailure || traceResult)}
 if(String(url).endsWith('/locate-evidence')){
  const source=(body.sessionId==='synthetic-other'?relatedSources:sources).find(s=>s.seq===body.seq)||(body.seq===900?{seq:900,role:'assistant',turn:600,step:1,messageId:'current-ai',quote:claim}:null)
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
  if(name==='sessions')return {binding(){return {ctx:bindingContext,session:{async loadThrough(seq){window.fixtureLoads.push(seq);setOldVisible(true)}}}}}
  if(name==='uiConversation')return {binding(){return {activate(view){setArchiveVisible?.(view==='ledger')}}}}
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
 const [old,setOld]=React.useState(false)
 const [messageEpoch,setMessageEpoch]=React.useState(0)
 remountMessages=()=>setMessageEpoch(value=>value+1)
 const [archiveVisible,setArchive]=React.useState(false)
 setArchiveVisible=setArchive
 setOldVisible=setOld
 React.useEffect(()=>{const script=document.createElement('script');script.src='/client.js';script.onload=()=>setReady(true);document.body.append(script)},[])
 const Trigger=handlers.get('conversation.input.right')
 const Panel=handlers.get('shell.overlay')
 const Archive=handlers.get('conversation.view')
 return h(React.Fragment,null,
  h('div',{className:'fixture-toolbar'},h('b',null,'溯源透镜 · 本地验证'),h('button',{id:'run-tests',onClick:()=>void runTests()},'运行浏览器回归测试'),h('button',{id:'toggle-theme',onClick:()=>{document.documentElement.dataset.fixtureTheme=document.documentElement.dataset.fixtureTheme==='dark'?'light':'dark'}},'切换明暗'),h('button',{id:'switch-session',onClick:()=>setActiveSession(id=>id==='synthetic'?'synthetic-other':'synthetic')},'切换测试会话'),h('button',{id:'stress-message',onClick:()=>setLargeMessage(value=>!value)},'长消息验证'),h('button',{id:'toggle-archive',onClick:()=>setArchive(value=>!value)},'查看测试档案'),h('button',{id:'demo-followup',onClick:()=>void demoFollowup()},'演示原文追问'),h('span',{id:'test-summary'},'等待运行')),
  h('div',{'data-slot':'conversation.session',style:{display:'contents'}}),
  h('main',{'data-conversation-session':activeSession,'data-conversation-content':'','data-conversation-region':'chat',className:'conversation'},h('header',null,'测试会话',h('span',null,'所有内容均为虚构测试文本')),
   h('section',{'data-slot':'conversation.session'},h('div',{'data-slot':'conversation.chat.flow',className:'chat-flow'},
    old && (activeSession==='synthetic-other'?relatedSources:sources).map(source=>h(SourceNode,{key:`${messageEpoch}-${source.seq}`,node:{kind:source.role==='assistant'?'assistant-step':'user',data:source.role==='assistant'?{turn:source.turn,step:1,finalNode:{...source,kind:'assistant'}}:{...source,kind:source.role}}},
     h('small',null,source.role==='assistant'?'AI 历史结论':source.role==='user'?'你的原话':'外部工具资料'),...source.quote.split('\n\n').map((part,i)=>h('p',{key:i},part.startsWith('**')?h('strong',null,part.replace(/\*\*/g,'')):(largeMessage&&source.seq===3&&i===0?'普通背景说明。'.repeat(1300)+part:part))))),
    h('div',{className:'spacer'},'很早以前的讨论位于上方，由 DSH 分页加载。'),
    h(SourceNode,{key:messageEpoch,node:{kind:'assistant-step',data:{turn:600,step:1,finalNode:{seq:900,kind:'assistant',messageId:'current-ai'}}}},h('small',null,'AI 当前回答'),h('p',{id:'claim'},claim),h('p',null,'这段回答用于检查历史依据的加载、消息限定和关键词高亮。'),h('p',{id:'decoy'},'紫杉协议采用环形索引，确保长对话中的定位一致性。 该协议保留原文的段落结构。')),
   )),
   h('footer',null,h('textarea',{id:'fixture-composer','aria-label':'测试输入框',defaultValue:draftState.draft,onChange:event=>{draftState.draft=event.target.value;draftState.draftRev++},style:{flex:1,minWidth:0,height:70,resize:'vertical',border:'1px solid var(--dsw-alias-border-l2)',borderRadius:10,background:'var(--dsw-alias-bg-base)',color:'var(--dsw-alias-label-primary)',padding:10}}),ready&&h(Trigger,{sessionId:activeSession}))),
  ready&&archiveVisible&&h('div',{id:'fixture-archive',style:{position:'fixed',top:82,left:32,right:470,bottom:24,zIndex:3,background:'var(--dsw-alias-bg-base)'}},h(Archive,{sessionId:activeSession})),
  ready&&h(Panel),h('pre',{id:'test-results'}))
}
const wait=ms=>new Promise(r=>setTimeout(r,ms))
async function until(check,label){const until=Date.now()+5000;while(Date.now()<until){if(check())return;await wait(30)}throw Error(label)}
async function selectClaim(){const calls=window.fixtureTraceCalls;const element=document.querySelector('#claim');const range=document.createRange();range.selectNodeContents(element);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);element.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));await until(()=>window.fixtureTraceCalls>calls&&document.querySelectorAll('.dsp-ev').length===3,'结果未出现')}
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
 await test('用户原话可以单独定位',async()=>{getSelection().removeAllRanges();[...document.querySelectorAll('.dsp-ev')].find(el=>el.textContent.includes(sources[1].quote)).click();await until(()=>getSelection().toString()===sources[1].quote,'未选中用户原话')})
 await test('工具材料可以在对话内定位',async()=>{getSelection().removeAllRanges();[...document.querySelectorAll('.dsp-ev')].find(el=>el.textContent.includes(sources[2].quote)).click();await until(()=>getSelection().toString()===sources[2].quote,'未选中工具原文')})
 await test('原有摘录跳转仍可选中原句',async()=>{window.dispatchEvent(new CustomEvent('dsh-provenance:jump-to-source',{detail:{quote:claim,seq:900,sessionId:'synthetic'}}));await until(()=>getSelection().toString()===claim,'摘录未跳转')})
 await test('悬停原文出现小操作条，插入保留草稿与附件且不自动发送',async()=>{
  await wait(450)
  const range=getSelection().getRangeAt(0);const rect=[...range.getClientRects()].find(rect=>rect.width>0&&rect.top>0)
  const input=document.querySelector('#fixture-composer');input.setSelectionRange(1,4)
  const traceCalls=window.fixtureTraceCalls
  document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:rect.left+3,clientY:rect.top+rect.height/2}))
  await until(()=>document.querySelector('.dsp-source-actions'),'悬停没有出现操作条')
  document.querySelector('.dsp-source-insert').click()
  await until(()=>input.value.includes('关于这段原文：'),'引用未插入')
  if(!input.value.startsWith('已经写好')||!input.value.endsWith('的问题'))throw Error('已有草稿被覆盖')
  if(!input.value.includes('> '+claim))throw Error('引用内容不符')
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
  await until(()=>document.querySelectorAll('.dsp-ev').length===3,'重新分析未恢复')
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
  if(document.querySelectorAll('.dsp-ev').length!==3)throw Error('原溯源结果未恢复')
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
  await until(()=>document.querySelectorAll('.dsp-ev').length===3,'没有进入分析结果')
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
  if(!document.querySelector('.dsp-body').textContent.includes('晚于本条，不能作为当时的依据'))throw Error('没有区分后续观点')
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
  if(document.querySelectorAll('.dsp-ev').length!==3)throw Error('返回本对话丢失原溯源结果')
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
 if(window.fixtureErrors.length)report('运行时无异常',false,window.fixtureErrors.join('\n'));else report('运行时无异常',true)
 document.querySelector('#test-summary').textContent=`${window.fixtureResults.filter(x=>x.ok).length}/${window.fixtureResults.length} 通过`
}
createRoot(document.querySelector('#root')).render(h(App))
