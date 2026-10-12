import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStudio} from '../src/server/studio-server.mjs';

const page = (id,title) => ({id,kind:'text',title,body:'已有正文',assetIds:[],caption:'',sourceIds:[],referenceIds:[],designReason:'已有依据'});
const analysis = {summary:'根据提供的需求组织表达',goal:'讲清方案',audience:'项目业主',facts:[{text:'用于汇报',sourceIds:['user:brief']}],observations:[],designReasoning:[],questions:['需要优先讲清什么？'],warnings:[]};
async function harness(t,runner) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(),'panda-ai-server-'));
  let verified = false, calls = 0;
  const app = await createStudio({port:0,dataDir,importAsset:async ({name,role}) => ({id:'new-asset',name,role,kind:'image',file:'assets/new.png'}),createPlan:() => ({slides:[page('rule-page','规则页面')]}),
    renderProject:async ({outputDir}) => {await fs.writeFile(path.join(outputDir,'deck.html'),'<title>export</title>');return {files:[{name:'deck.html',format:'web'}],slides:[]};},
    aiGateway:{getStatus:() => ({configured:true,verified,provider:'test-provider',models:{analysis:'vision-test',planning:'writer-test',revision:'writer-test',internal:'omit'},lastSuccessAt:verified ? '2026-10-12T00:00:00.000Z' : null,limitations:[],apiKey:'secret-sentinel',keyPath:'private-path'})},
    aiRunner:async params => {calls++;const result = await (runner || (async ({project,action}) => ({ai:{analysis,messages:[...(project.ai?.messages || []),{role:'assistant',text:'已分析'}]},...(['plan','revise'].includes(action) ? {slides:[page('p1','模型页面'),page('p2','保留页面')]} : {})})))(params);verified = true;return result;}
  });
  t.after(async () => {await app.close();assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir())+path.sep+'panda-ai-server-'));await fs.rm(dataDir,{recursive:true,force:true});});
  const session = await (await fetch(app.origin+'/api/session')).json();
  const request = (method,url,body,headers={}) => fetch(app.origin+url,{method,headers:{'Content-Type':'application/json','X-Panda-Token':session.token,...headers},body:body === undefined ? undefined : JSON.stringify(body)});
  const project = await (await request('POST','/api/projects',{title:'本地模型测试',brief:'用于汇报'})).json(), base = '/api/projects/'+project.id;
  return {app,dataDir,session,request,project,base,calls:() => calls,read:async () => (await request('GET',base)).json(),ai:(p,action='analyze',extra={}) => request('POST',base+'/ai',{expectedRevision:p.revision,action,...extra})};
}

test('status distinguishes configuration from verified calls and only exposes public fields',async t => {
  const h = await harness(t);
  const status = await (await h.request('GET','/api/ai/status')).json();
  assert.equal(status.configured,true);assert.equal(status.verified,false);assert.equal(h.session.capabilities.modelConnected,false);
  assert.equal(JSON.stringify(status).includes('secret-sentinel'),false);assert.equal(JSON.stringify(status).includes('private-path'),false);assert.equal(status.models.internal,undefined);
  assert.equal((await h.ai(h.project)).status,200);
  assert.equal((await (await h.request('GET','/api/ai/status')).json()).verified,true);
  assert.equal((await (await h.request('GET','/api/session')).json()).capabilities.modelConnected,true);
});

test('AI mutations retain session, origin and revision protection before starting a call',async t => {
  const h = await harness(t), body = {expectedRevision:0,action:'analyze'};
  assert.equal((await h.request('POST',h.base+'/ai',body,{'X-Panda-Token':'bad'})).status,403);
  assert.equal((await h.request('POST',h.base+'/ai',body,{Origin:'https://example.com'})).status,403);
  assert.equal((await h.ai({...h.project,revision:44})).status,409);
  assert.equal((await h.ai(h.project,'execute')).status,400);
  assert.equal((await h.ai(h.project,'chat')).status,400);
  assert.equal(h.calls(),0);
});

test('analysis, follow-up, page creation and export keep a durable project lifecycle',async t => {
  const h = await harness(t);
  const analyzed = await (await h.ai(h.project)).json();
  assert.deepEqual(analyzed.ai.analysis,analysis);assert.deepEqual(analyzed.slides,[]);assert.equal(analyzed.revision,1);
  const discussed = await (await h.ai(analyzed,'chat',{message:'优先说明家庭使用'})).json();
  assert.equal(discussed.ai.messages.length,2);assert.deepEqual(discussed.slides,[]);
  const planned = await (await h.ai(discussed,'plan')).json();assert.equal(planned.slides.length,2);
  const exported = await (await h.request('POST',h.base+'/export',{expectedRevision:planned.revision,formats:['web']})).json();
  assert.equal((await fetch(h.app.origin+exported.files[0].url)).status,200);
  const updated = await (await h.ai(planned,'chat',{message:'再核对房间含义'})).json();
  assert.equal(updated.exports,null);assert.deepEqual(updated.slides,planned.slides);
  assert.equal((await fetch(h.app.origin+exported.files[0].url)).status,404);
  assert.deepEqual((await h.read()).ai,updated.ai);
});

test('failed provider call exposes no raw secret and leaves project unchanged',async t => {
  const h = await harness(t,async ({project}) => {project.title = 'must not persist';throw new Error('secret-sentinel raw request Authorization');});
  const before = await h.read(), response = await h.ai(before), body = await response.text();
  assert.equal(response.status,502);assert.equal(body.includes('secret-sentinel'),false);assert.deepEqual(await h.read(),before);
});

test('concurrent edits stay available and late AI result is retained without overwriting',async t => {
  let entered, release;const started = new Promise(resolve => {entered = resolve;}), paused = new Promise(resolve => {release = resolve;});
  const h = await harness(t,async () => {entered();await paused;return {ai:{analysis}};});
  const pending = h.ai(h.project);await started;
  assert.equal((await h.ai(h.project)).status,409);
  const edited = await h.request('PUT',h.base,{expectedRevision:0,title:'用户期间手改'});assert.equal(edited.status,200);
  release();const late = await pending;assert.equal(late.status,409);
  const current = await h.read();assert.equal(current.title,'用户期间手改');assert.equal(current.ai,undefined);
  const candidates = await fs.readdir(path.join(h.dataDir,h.project.id,'ai-candidates'));assert.equal(candidates.length,1);
  const candidate = JSON.parse(await fs.readFile(path.join(h.dataDir,h.project.id,'ai-candidates',candidates[0]),'utf8'));assert.deepEqual(candidate.result.ai.analysis,analysis);
});

test('analysis cannot replace slides, invalid references never persist',async t => {
  let invalidRefs = false;
  const h = await harness(t,async () => ({ai:{analysis},slides:[{...page('p1','bad'),assetIds:invalidRefs ? ['foreign'] : []}]}));
  assert.equal((await h.ai(h.project)).status,502);assert.equal((await h.read()).revision,0);
  invalidRefs = true;assert.equal((await h.ai(h.project,'plan')).status,400);assert.equal((await h.read()).revision,0);
});

test('local revision changes only the selected slide and rejects collateral changes',async t => {
  let collateral = false;
  const h = await harness(t,async ({project,slideId}) => ({ai:{analysis},slides:project.slides.map(slide => slide.id === slideId ? {...slide,title:'局部修改'} : collateral ? {...slide,title:'不可意外修改'} : slide)}));
  const seeded = await (await h.request('PUT',h.base,{expectedRevision:0,slides:[page('p1','第一页'),page('p2','第二页')]})).json();
  const revised = await (await h.ai(seeded,'revise',{message:'标题简短',slideId:'p1'})).json();
  assert.equal(revised.slides[0].title,'局部修改');assert.deepEqual(revised.slides[1],seeded.slides[1]);
  collateral = true;assert.equal((await h.ai(revised,'revise',{message:'再改',slideId:'p1'})).status,502);assert.deepEqual(await h.read(),revised);
});

test('new analysis marks existing AI pages stale and blocks export or partial revision until planning',async t => {
  const h = await harness(t);
  const analyzed = await (await h.ai(h.project)).json(), planned = await (await h.ai(analyzed,'plan')).json();
  assert.equal(planned.ai.planStale,false);assert.equal(planned.ai.pagesMode,'model');
  const discussed = await (await h.ai(planned,'chat',{message:'改成先讲居住需求'})).json();
  assert.equal(discussed.ai.planStale,true);assert.equal(discussed.ai.analysisStale,false);assert.deepEqual(discussed.slides,planned.slides);
  assert.equal((await h.request('POST',h.base+'/export',{expectedRevision:discussed.revision,formats:['web']})).status,422);
  const callsBefore = h.calls();
  assert.equal((await h.ai(discussed,'revise',{message:'只改标题',slideId:'p1'})).status,422);assert.equal(h.calls(),callsBefore);
  const replanned = await (await h.ai(discussed,'plan')).json();assert.equal(replanned.ai.planStale,false);
  assert.equal((await h.request('POST',h.base+'/export',{expectedRevision:replanned.revision,formats:['web']})).status,200);
});

test('actual brief and asset changes require new analysis while no-op saves retain readiness',async t => {
  const h = await harness(t);
  const analyzed = await (await h.ai(h.project)).json(), planned = await (await h.ai(analyzed,'plan')).json();
  const saved = await (await h.request('PUT',h.base,{expectedRevision:planned.revision,title:planned.title,brief:planned.brief,audience:planned.audience,assets:[],slides:planned.slides})).json();
  assert.equal(saved.ai.analysisStale,false);assert.equal(saved.ai.planStale,false);
  assert.equal((await h.request('POST',h.base+'/export',{expectedRevision:saved.revision,formats:['web']})).status,200);
  const changed = await (await h.request('PUT',h.base,{expectedRevision:saved.revision,brief:'以新的居住需求为主线'})).json();
  assert.equal(changed.ai.analysisStale,true);assert.equal(changed.ai.planStale,true);
  const callsBefore = h.calls();assert.equal((await h.ai(changed,'plan')).status,422);assert.equal(h.calls(),callsBefore);
  const reanalyzed = await (await h.ai(changed)).json();assert.equal(reanalyzed.ai.analysisStale,false);assert.equal(reanalyzed.ai.planStale,true);
  const rebuilt = await (await h.ai(reanalyzed,'plan')).json();
  const uploaded = await (await h.request('POST',h.base+'/assets',{expectedRevision:rebuilt.revision,name:'new.png',base64:'eA=='})).json();
  assert.equal(uploaded.ai.analysisStale,true);assert.equal(uploaded.ai.planStale,true);
  assert.equal((await h.ai(uploaded,'plan')).status,422);
});

test('new uploads invalidate analysis even before any AI pages, and explicit rules remain usable',async t => {
  const h = await harness(t), analyzed = await (await h.ai(h.project)).json();
  const uploaded = await (await h.request('POST',h.base+'/assets',{expectedRevision:analyzed.revision,name:'new.png',base64:'eA=='})).json();
  assert.equal(uploaded.ai.analysisStale,true);assert.equal(uploaded.ai.planStale,false);
  assert.equal((await h.ai(uploaded,'plan')).status,422);
  const rules = await (await h.request('POST',h.base+'/plan',{expectedRevision:uploaded.revision})).json();
  assert.equal(rules.ai.pagesMode,'rules');assert.equal(rules.ai.analysisStale,true);
  assert.equal((await h.request('POST',h.base+'/export',{expectedRevision:rules.revision,formats:['web']})).status,200);
});

test('semantic workflow changes invalidate model pages while repeated values do not',async t => {
  const h = await harness(t), analyzed = await (await h.ai(h.project)).json(), planned = await (await h.ai(analyzed,'plan')).json();
  const workflow = await (await h.request('GET',h.base+'/workflow')).json();
  const repeated = await h.request('PUT',h.base+'/workflow',{expectedRevision:planned.revision,expectedWorkflowRevision:workflow.workflow.revision,change:{type:'setBrief',value:{purpose:planned.brief}}});
  assert.equal(repeated.status,200);const same = await h.read();assert.equal(same.ai.analysisStale,false);assert.equal(same.ai.planStale,false);
  assert.equal((await h.request('POST',h.base+'/export',{expectedRevision:same.revision,formats:['web']})).status,200);
  const changed = await h.request('PUT',h.base+'/workflow',{expectedRevision:same.revision,expectedWorkflowRevision:same.workflow.revision,change:{type:'appendDialogue',value:{id:'user-correction',role:'user',text:'本次不再向业主汇报，改为内部复核'}}});
  assert.equal(changed.status,200);const stale = await h.read();assert.equal(stale.ai.analysisStale,true);assert.equal(stale.ai.planStale,true);
  assert.equal((await h.request('POST',h.base+'/export',{expectedRevision:stale.revision,formats:['web']})).status,422);
  assert.equal((await h.ai(stale,'plan')).status,422);
});
