import { performance } from 'node:perf_hooks'
import { retrieve } from '../retrieval.js'
import assert from 'node:assert/strict'
const count=Number(process.argv[2]||20000)
const entries=Array.from({length:count},(_,i)=>({seq:i+1,role:i%2?'assistant':'user',text:`会话编号 ${i+1}。`+'一般讨论内容包含需求、实现和反馈。'.repeat(30)}))
entries[1].text='早期助手结论：紫杉协议采用环形索引，确保定位一致性。'
entries[Math.floor(count/2)].text='中间用户要求：紫杉协议的环形索引必须保留原文定位。'
entries[count-2].text='最近助手确认：紫杉协议的环形索引需要验证定位一致性。'
const before=process.memoryUsage().heapUsed;const start=performance.now()
const result=retrieve(entries,'紫杉协议采用环形索引，确保定位一致性。')
const elapsedMs=Math.round(performance.now()-start)
for(const seq of [2,Math.floor(count/2)+1,count-1])assert.ok(result.passages.some(x=>x.seq===seq),`missing source ${seq}`)
console.log(JSON.stringify({messages:count,characters:result.meta.scannedChars,chunks:result.meta.scannedChunks,selectedPassages:result.passages.length,promptCharacters:result.meta.promptChars,elapsedMs,heapDeltaMiB:Math.round((process.memoryUsage().heapUsed-before)/1024/1024),allThreeSentinelsRetrieved:true},null,2))
