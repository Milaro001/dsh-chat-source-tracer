import http from 'node:http'
import {searchSession, relatedSessions, analyzeRelationships, summarizeDiagram, serve} from '../index.js'
import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
const root=path.resolve(import.meta.dirname,'..')
const clientFile=process.env.PROVENANCE_FIXTURE_CLIENT || path.join(root,'client.js')
const port=Number(process.env.PROVENANCE_FIXTURE_PORT || 8768)
const modules=new Map()
function visit(file){if(modules.has(file))return;const item={code:fs.readFileSync(file,'utf8'),map:{}};modules.set(file,item);const req=createRequire(file);for(const match of item.code.matchAll(/require\(['"]([^'"]+)['"]\)/g)){try{const dep=req.resolve(match[1]);if(dep.startsWith('/')){item.map[match[1]]=dep;visit(dep)}}catch{}}}
const entry=path.join(root,'tests/fixture-entry.cjs');visit(entry)
const bundle=`(()=>{const process={env:{NODE_ENV:'development'}};const modules={${[...modules].map(([id,item])=>`${JSON.stringify(id)}:[function(require,module,exports){\n${item.code}\n},${JSON.stringify(item.map)}]`).join(',')}};const cache={};function load(id){if(cache[id])return cache[id].exports;const item=modules[id];if(!item)throw Error(id);const module={exports:{}};cache[id]=module;item[0](name=>load(item[1][name]),module,module.exports);return module.exports}load(${JSON.stringify(entry)})})()`
const fixtureTime=Date.UTC(2026,9,20,1,0,0)
const sample=(seq,role,text,id,turn=1)=>({seq,time:fixtureTime+(seq===900?1000:500),type:role==='tool'?'tool/result':`${role}/message`,surfaceOp:'append',data:role==='user'?{id,source:{kind:'user'},content:[{type:'text',text}]}:{turn,step:1,message:{id,content:[{type:'text',text}]}}})
const searchEvents=[sample(3,'assistant','紫杉协议采用环形索引，确保长对话中的定位一致性。\n\n**该协议保留原文的段落结构。**','ai-old'),sample(4,'user','我希望长对话中的原文也能被准确定位。','user-old'),sample(5,'tool','环形索引协议适用于顺序日志的回溯查询。'),sample(900,'assistant','因此，紫杉协议应采用环形索引，确保定位一致性。','current-ai',600)]
const relatedEvents=[sample(3,'assistant','另一段讨论里，紫杉协议采用环形索引，确保长对话中的定位一致性。我们还保留了消息的原始编号。','other-ai'),{...sample(4,'user','紫杉协议采用环形索引，确保长对话中的定位一致性。但我后来想补充一个恢复方案。','other-user'),time:fixtureTime+2000}]
const corpus=new Map([['synthetic',searchEvents],['synthetic-other',relatedEvents],...Array.from({length:5},(_,index)=>[`background-${index}`,[sample(1,'user','今天整理花园里的花草。',`unrelated-${index}`)]])])
const searchContext={
 get(name){if(name==='agentDefaultModel')return {currentSelection:()=>({provider:'fixture',model:'fixture-no-real-model'})}},
 sessionQuery:{
  async readSession(id){return {events:corpus.get(id)||[]}},
  async readSurface(id){return {events:corpus.get(id)||[]}},
  async readEvent({sessionId,seq}){const target=corpus.get(sessionId)?.find(event=>event.seq===seq);return {target,events:target?[target]:[]}},
  async listSessions(){return [...corpus.keys()].map(id=>({header:{id}}))},
  async searchSessions(){return {items:[]}},
  async readTitle(id){return {text:id==='synthetic-other'?'紫杉协议 · 另一段设计讨论':`虚构会话 ${id}`}},
 },
 llm:{async *stream(options){const {candidates,records}=JSON.parse(options.messages[0].content[0].text);const value=records?{title:'紫杉协议：定位、来源与恢复',groups:[{title:'历史定位与恢复',summary:'所选材料围绕环形索引、消息编号和上下文展开。应保留来源并核对原文，恢复方案仍需结合历史完整性验证。',recordIds:records.map(record=>record.id)}]}:{relations:candidates.map(row=>({id:row.id,relation:row.timing==='after'?'changes':'similar',quote:row.text.slice(0,50),explanation:row.timing==='after'?'这是后续讨论中的补充和变化，不能作为当时的依据。':'两段文字讨论了同一项约束，但不能据此认定 AI 当时引用过另一会话。'}))};yield {type:'text-delta',text:JSON.stringify(value)};yield {type:'finish',reason:{kind:'stop'}}}},
}
const server=http.createServer((req,res)=>{const operation=req.url?.endsWith('/diagram')?summarizeDiagram:req.url?.endsWith('/search')?searchSession:req.url?.endsWith('/related')?relatedSessions:req.url?.endsWith('/relationships')?analyzeRelationships:null;if(operation)return void serve(searchContext,req,res,operation);if(req.url==='/fixture-bundle.js'){res.writeHead(200,{'content-type':'text/javascript'});return res.end(bundle)}const file=req.url==='/client.js'?clientFile:path.join(root,'tests/fixture.html');res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript':'text/html'});res.end(fs.readFileSync(file))})
server.listen(port,'localhost',()=>console.log(`Preview ready (loopback only; port ${server.address().port})`))
