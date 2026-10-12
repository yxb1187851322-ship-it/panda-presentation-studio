import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../src/server/studio-server.mjs';

async function harness(t) {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'panda-server-'));
  const app=await createStudio({port:0,dataDir,
    importAsset:async ({projectDir,name,buffer,role})=>{await fs.mkdir(path.join(projectDir,'assets'),{recursive:true});await fs.writeFile(path.join(projectDir,'assets','asset.png'),buffer);return{id:'asset-1',name,kind:'image',file:'assets/asset.png',mediaType:'image/png',role};},
    createPlan:p=>({slides:[{id:'page-1',kind:'hero',title:p.title,body:'',assetIds:p.assets.map(a=>a.id)}],limitations:[]}),
    renderProject:async ({outputDir})=>{await fs.writeFile(path.join(outputDir,'deck.html'),'<!doctype html><title>local</title>');return{files:[{name:'deck.html',format:'web'}],slides:[],warnings:[]};}
  });
  t.after(async()=>{await app.close();assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir())+path.sep+'panda-server-'));await fs.rm(dataDir,{recursive:true,force:true});});
  const session=await (await fetch(app.origin+'/api/session')).json();
  const request=async(method,url,body,extra={})=>fetch(app.origin+url,{method,headers:{'Content-Type':'application/json','X-Panda-Token':session.token,...extra},body:body===undefined?undefined:JSON.stringify(body)});
  const p=await (await request('POST','/api/projects',{title:'测试汇报'})).json();
  return{app,request,p};
}
test('project persists, token and origin protect writes, foreign assets are rejected',async t=>{
  const {app,request,p}=await harness(t);
  assert.equal((await fetch(app.origin+'/api/projects/'+p.id)).status,200);
  assert.equal((await request('PUT','/api/projects/'+p.id,{expectedRevision:0,title:'x'},{'X-Panda-Token':'wrong'})).status,403);
  assert.equal((await request('PUT','/api/projects/'+p.id,{expectedRevision:0,title:'x'},{Origin:'https://example.com'})).status,403);
  assert.equal((await request('PUT','/api/projects/'+p.id,{expectedRevision:0,slides:[{id:'p',kind:'hero',assetIds:['foreign']}]})).status,400);
  assert.equal((await request('PUT','/api/projects/'+p.id,{expectedRevision:99,title:'x'})).status,409);
});
test('upload, plan, edit, export and stale output invalidation form a real lifecycle',async t=>{
  const {app,request,p}=await harness(t);
  const base='/api/projects/'+p.id;
  const uploaded=await (await request('POST',base+'/assets',{name:'image.png',base64:Buffer.from('image bytes').toString('base64')})).json();
  assert.equal(uploaded.assets.length,1);
  const planned=await (await request('POST',base+'/plan',{title:'空间提案'})).json();
  assert.equal(planned.slides.length,1);
  const result=await (await request('POST',base+'/export',{formats:['web'],expectedRevision:planned.revision})).json();
  assert.equal((await fetch(app.origin+result.files[0].url)).status,200);
  assert.equal((await fetch(app.origin+base+'/exports/project.json')).status,404);
  const edited=await (await request('PUT',base,{expectedRevision:planned.revision,title:'修改后'})).json();
  assert.equal(edited.revision,planned.revision+1);
  assert.equal((await fetch(app.origin+result.files[0].url)).status,404);
  assert.equal((await request('POST',base+'/export',{formats:['web'],expectedRevision:planned.revision})).status,409);
});
test('user-supplied asset paths cannot replace server-owned files',async t=>{
  const {app,request,p}=await harness(t); const base='/api/projects/'+p.id;
  const uploaded=await (await request('POST',base+'/assets',{name:'x.png',base64:'eA=='})).json();
  const result=await (await request('PUT',base,{expectedRevision:uploaded.revision,assets:[{id:'asset-1',role:'plan',file:'../../secret'}]})).json();
  assert.equal(result.assets[0].file,'assets/asset.png');
  assert.equal(result.assets[0].role,'plan');
  assert.equal((await fetch(app.origin+base+'/assets/asset-1')).status,200);
});
