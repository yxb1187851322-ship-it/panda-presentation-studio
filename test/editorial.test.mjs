import test from 'node:test';
import assert from 'node:assert/strict';
import {validateEditorialScene,editorialViewer} from '../src/renderers/editorial.mjs';
const scene=()=>({title:'Book',width:1440,height:1018,pages:[{title:'Plan',elements:[{type:'image',asset:'plan.png',x:0,y:0,w:1200,h:900}]}]});
test('editorial rejects off-page objects and path traversal',()=>{let s=scene();s.pages[0].elements[0].w=1600;assert.throws(()=>validateEditorialScene(s),/outside/);s=scene();s.pages[0].elements[0].asset='../secret.png';assert.throws(()=>validateEditorialScene(s),/path/);});
test('editorial rejects crops removing entire source',()=>{const s=scene();s.pages[0].elements[0].crop={left:.6,right:.5,top:0,bottom:0};assert.throws(()=>validateEditorialScene(s),/crop/);});
test('viewer escapes user content in markup and script data',()=>{const s=scene();s.title='<script>alert(1)</script>';s.pages[0].title='</script><script>alert(2)</script>';const html=editorialViewer(s);assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('\\u003c/script>'));assert.ok(!html.includes('<script>alert('));});
