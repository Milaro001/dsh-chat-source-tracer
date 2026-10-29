import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const source=fs.readFileSync(new URL('../client.js',import.meta.url),'utf8')
const browser={__ModuleLoader__:{load({factory}){factory(()=>({}))}}}
vm.runInNewContext(source.replace("    return {\n      inject: ['slots'],","    window.resizeGeometry={resizePanelRect,panelPositionForRect};\n    return {\n      inject: ['slots'],"),{window:browser})
const {resizePanelRect:resize,panelPositionForRect:position}=browser.resizeGeometry
const viewport={width:1200,height:900},rect={x:300,y:200,w:420,h:400}
for(const edge of ['n','ne','e','se','s','sw','w','nw']) test(`resize ${edge} keeps the opposite edges fixed`,()=>{
 const result=resize(rect,edge,{x:24,y:32},viewport)
 assert.equal(result.x,rect.x+(edge.includes('w')?24:0));assert.equal(result.y,rect.y+(edge.includes('n')?32:0))
 assert.equal(result.w,rect.w+(edge.includes('e')?24:edge.includes('w')?-24:0))
 assert.equal(result.h,rect.h+(edge.includes('s')?32:edge.includes('n')?-32:0))
 if(edge.includes('w'))assert.equal(result.x+result.w,rect.x+rect.w)
 if(edge.includes('n'))assert.equal(result.y+result.h,rect.y+rect.h)
})
test('resize cannot invert or move the opposite edge at minimum size',()=>{
 const result=resize(rect,'nw',{x:9999,y:9999},viewport)
 assert.equal(result.w,320);assert.equal(result.h,240);assert.equal(result.x+result.w,720);assert.equal(result.y+result.h,600)
})
test('all moving sides stop at the visible viewport boundary',()=>{
 const nw=resize(rect,'nw',{x:-9999,y:-9999},viewport),se=resize(rect,'se',{x:9999,y:9999},viewport)
 assert.equal(nw.x,8);assert.equal(nw.y,8);assert.equal(se.x+se.w,1192);assert.equal(se.y+se.h,892)
})
test('small or shrinking viewport keeps every corner visible',()=>{
 for(const edge of ['nw','se','n','e']){
  const result=resize(rect,edge,{x:9999,y:-9999},{width:280,height:210})
  assert.equal(result.w,264);assert.equal(result.h,194);assert.equal(result.x,8);assert.equal(result.y,8)
 }
})
test('saved proportional position restores the same rectangle after each edge resize',()=>{
 for(const edge of ['n','ne','e','se','s','sw','w','nw']){
  const result=resize(rect,edge,{x:-24,y:32},viewport),p=position(result,viewport)
  assert.ok(Math.abs(8+p.x*(viewport.width-result.w-16)-result.x)<.001)
  assert.ok(Math.abs(8+p.y*(viewport.height-result.h-16)-result.y)<.001)
 }
})
