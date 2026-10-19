import http from 'node:http'
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
const server=http.createServer((req,res)=>{if(req.url==='/fixture-bundle.js'){res.writeHead(200,{'content-type':'text/javascript'});return res.end(bundle)}const file=req.url==='/client.js'?clientFile:path.join(root,'tests/fixture.html');res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript':'text/html'});res.end(fs.readFileSync(file))})
server.listen(port,'localhost',()=>console.log(`Preview ready (loopback only; port ${server.address().port})`))
