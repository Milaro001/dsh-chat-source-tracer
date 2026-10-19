const React = require('react')
const ReactDOM = require('react-dom')
const {createRoot} = require('react-dom/client')
const h = React.createElement
const handlers = new Map()
let pluginContext
let setOldVisible
const quote='紫杉协议采用环形索引，确保长对话中的定位一致性。\n\n**该协议保留原文的段落结构。**'
const normalize=value=>String(value).replace(/[*_`]/g,'').replace(/\s+/g,' ').trim()
const claim='因此，紫杉协议应采用环形索引，确保定位一致性。'
const sources=[
 {seq:3,role:'assistant',turn:1,step:1,messageId:'ai-old',quote},
 {seq:4,role:'user',turn:1,messageId:'user-old',quote:'我希望长对话中的原文也能被准确定位。'},
 {seq:5,role:'tool',turn:1,quote:'环形索引协议适用于顺序日志的回溯查询。',url:'https://example.org/protocol',site:'example.org'},
]
const traceResult={ok:true,claim:{seq:900,role:'assistant',turn:600,step:1,resolved:true},atoms:sources.map((ev,i)=>({text:['采用环形索引以保证定位一致性','保留长对话中的原文定位能力','这项设计需要核对外部协议'][i],relation:i===1?'inference':'direct',keywords:['紫杉协议','环形索引','定位'],evidence:[{...ev,why:'与这句话讨论的是同一项约束。',strength:'strong'}]})),assumptions:['历史记录保存完整，且目标消息尚未被修改。'],meta:{model:'本地测试替身',elapsedMs:42,messageCount:20000,retrieval:{scannedMessages:20000,selectedPassages:23}}}
const realFetch=window.fetch.bind(window)
let traceFailure = null
window.fetch=async (url,init)=>{
 if(!/^\/plugins\/dsh-provenance(?:-lens)?\//.test(String(url)))return realFetch(url,init)
 const body=JSON.parse(init.body||'{}')
 if(String(url).endsWith('/trace'))return Response.json(traceFailure || traceResult)
 if(String(url).endsWith('/locate-evidence')){
  const source=sources.find(s=>s.seq===body.seq)
  if(!source)return Response.json({ok:false})
  return Response.json({ok:true,...source})
 }
 if(String(url).endsWith('/locate'))return Response.json({ok:true,seq:900,turn:600,role:'assistant'})
 return Response.json({ok:false,message:'该操作不在测试范围'})
}
const ctx={
 get(name){
  if(name==='sessions')return {binding(){return {session:{async loadThrough(seq){window.fixtureLoads.push(seq);setOldVisible(true)}}}}}
  if(name==='uiConversation')return {binding(){return {activate(){}}}}
  if(name==='locale')return {current:'zh-CN'}
 },
 slots:{inject(_name,fn){fn()},register(options,component){handlers.set(options.name,component)}},
}
window.fixtureLoads=[]
window.__ModuleLoader__={load({factory}){const plugin=factory(name=>{if(name==='react')return React;if(name==='react-dom')return ReactDOM;throw Error(name)});pluginContext=plugin;plugin.apply(ctx)}}
window.fixtureResults=[]
window.fixtureErrors=[]
window.addEventListener('error',e=>window.fixtureErrors.push(e.message))
window.addEventListener('unhandledrejection',e=>window.fixtureErrors.push(String(e.reason)))
function SourceNode({node,children}){return h('div',{'data-chat-node-key':`node-${node.data.finalNode?.seq||node.data.seq}`,'data-chat-turn':node.data.turn||1,className:'message'},children)}
function App(){
 const [ready,setReady]=React.useState(false)
 const [old,setOld]=React.useState(false)
 setOldVisible=setOld
 React.useEffect(()=>{const script=document.createElement('script');script.src='/client.js';script.onload=()=>setReady(true);document.body.append(script)},[])
 const Trigger=handlers.get('conversation.input.right')
 const Panel=handlers.get('shell.overlay')
 return h(React.Fragment,null,
  h('div',{className:'fixture-toolbar'},h('b',null,'溯源透镜 · 本地验证'),h('button',{id:'run-tests',onClick:()=>void runTests()},'运行浏览器回归测试'),h('button',{id:'toggle-theme',onClick:()=>{document.documentElement.dataset.fixtureTheme=document.documentElement.dataset.fixtureTheme==='dark'?'light':'dark'}},'切换明暗'),h('span',{id:'test-summary'},'等待运行')),
  h('div',{'data-slot':'conversation.session',style:{display:'contents'}}),
  h('main',{'data-conversation-session':'synthetic','data-conversation-content':'','data-conversation-region':'chat',className:'conversation'},h('header',null,'测试会话',h('span',null,'所有内容均为虚构测试文本')),
   h('section',{'data-slot':'conversation.session'},h('div',{'data-slot':'conversation.chat.flow',className:'chat-flow'},
    old && sources.map(source=>h(SourceNode,{key:source.seq,node:{kind:source.role==='assistant'?'assistant-step':'user',data:source.role==='assistant'?{turn:source.turn,step:1,finalNode:{...source,kind:'assistant'}}:{...source,kind:source.role}}},
     h('small',null,source.role==='assistant'?'AI 历史结论':source.role==='user'?'你的原话':'外部工具资料'),...source.quote.split('\n\n').map((part,i)=>h('p',{key:i},part.startsWith('**')?h('strong',null,part.replace(/\*\*/g,'')):part)))),
    h('div',{className:'spacer'},'很早以前的讨论位于上方，由 DSH 分页加载。'),
    h(SourceNode,{node:{kind:'assistant-step',data:{turn:600,step:1,finalNode:{seq:900,kind:'assistant',messageId:'current-ai'}}}},h('small',null,'AI 当前回答'),h('p',{id:'claim'},claim),h('p',null,'这段回答用于检查历史依据的加载、消息限定和关键词高亮。'),h('p',{id:'decoy'},'紫杉协议采用环形索引，确保长对话中的定位一致性。 该协议保留原文的段落结构。')),
   )),
   h('footer',null,h('div',null,'给 AI 发送消息…'),ready&&h(Trigger,{sessionId:'synthetic'}))),
  ready&&h(Panel),h('pre',{id:'test-results'}))
}
const wait=ms=>new Promise(r=>setTimeout(r,ms))
async function until(check,label){const until=Date.now()+5000;while(Date.now()<until){if(check())return;await wait(30)}throw Error(label)}
async function selectClaim(){const element=document.querySelector('#claim');const range=document.createRange();range.selectNodeContents(element);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);element.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));await until(()=>document.querySelectorAll('.dsp-ev').length===3,'结果未出现')}
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
 await test('未挂载的 AI 依据由公开 loadThrough 加载并选中',async()=>{getSelection().removeAllRanges();document.querySelector('.dsp-ev').click();await until(()=>normalize(getSelection().toString())===normalize(quote),'未选中 AI 原文');if(!window.fixtureLoads.includes(3))throw Error('未调用按消息编号加载');const row=getSelection().anchorNode.parentElement.closest('[data-chat-node-key]');if(row?.dataset.chatNodeKey!=='node-3')throw Error('跳错消息')})
 await test('用户原话可以单独定位',async()=>{getSelection().removeAllRanges();[...document.querySelectorAll('.dsp-ev')].find(el=>el.textContent.includes(sources[1].quote)).click();await until(()=>getSelection().toString()===sources[1].quote,'未选中用户原话')})
 await test('工具材料可以在对话内定位',async()=>{getSelection().removeAllRanges();[...document.querySelectorAll('.dsp-ev')].find(el=>el.textContent.includes(sources[2].quote)).click();await until(()=>getSelection().toString()===sources[2].quote,'未选中工具原文')})
 await test('原有摘录跳转仍可选中原句',async()=>{window.dispatchEvent(new CustomEvent('dsh-provenance:jump-to-source',{detail:{quote:claim,seq:900,sessionId:'synthetic'}}));await until(()=>getSelection().toString()===claim,'摘录未跳转')})
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
 if(window.fixtureErrors.length)report('运行时无异常',false,window.fixtureErrors.join('\n'));else report('运行时无异常',true)
 document.querySelector('#test-summary').textContent=`${window.fixtureResults.filter(x=>x.ok).length}/${window.fixtureResults.length} 通过`
}
createRoot(document.querySelector('#root')).render(h(App))
