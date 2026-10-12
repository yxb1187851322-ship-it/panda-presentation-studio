import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../src/server/studio-server.mjs';

async function harness(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'panda-workflow-server-'));
  let app, session, intakeId = 0, planCalls = 0, renderCalls = 0;
  const options = {
    port:0, dataDir,
    aiGateway:{getStatus:() => ({configured:false,verified:false})},aiRunner:async () => {throw new Error('No model calls in workflow tests');},
    importAsset:async ({projectDir,name,buffer,role}) => {
      const id = `asset-${++intakeId}`, file = `assets/${id}.png`;
      await fs.mkdir(path.join(projectDir,'assets'), {recursive:true});
      await fs.writeFile(path.join(projectDir,file), buffer);
      return {id,name,kind:'image',file,mediaType:'image/png',role};
    },
    createPlan:project => {
      planCalls++;
      return {slides:[{id:'existing-slide',kind:'hero',title:project.title,body:'用户原有页面',assetIds:project.assets.map(asset => asset.id)}]};
    },
    renderProject:async ({outputDir}) => {
      renderCalls++;
      await fs.writeFile(path.join(outputDir,'deck.html'), '<!doctype html><title>test export</title>');
      return {files:[{name:'deck.html',format:'web'}],slides:[],warnings:[]};
    }
  };
  async function start() {
    app = await createStudio(options);
    session = await (await fetch(app.origin + '/api/session')).json();
  }
  await start();
  t.after(async () => {
    if (app) await app.close();
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'panda-workflow-server-'));
    await fs.rm(dataDir, {recursive:true,force:true});
  });
  async function request(method, url, body, headers = {}) {
    return fetch(app.origin + url, {method,headers:{'Content-Type':'application/json','X-Panda-Token':session.token,...headers},body:body === undefined ? undefined : JSON.stringify(body)});
  }
  const created = await request('POST','/api/projects',{title:'住宅讨论',brief:'先核对生活需求',audience:'模拟家庭'});
  assert.equal(created.status, 201);
  const project = await created.json(), base = '/api/projects/' + project.id;
  return {
    project,base,dataDir,request,
    get app() { return app; }, get session() { return session; },
    calls:() => ({planCalls,renderCalls}),
    read:async () => (await request('GET',base)).json(),
    workflow:async () => (await request('GET',base + '/workflow')).json(),
    disk:() => fs.readFile(path.join(dataDir,project.id,'project.json'),'utf8'),
    update:(state,change,headers) => request('PUT',base + '/workflow',{expectedRevision:state.projectRevision,expectedWorkflowRevision:state.workflow.revision,change},headers),
    upload:(role = 'content') => request('POST',base + '/assets',{name:'test.png',base64:'eA==',role}),
    restart:async () => { await app.close(); app = undefined; await start(); }
  };
}

test('legacy workflow GET is read-only, exposes truthful capabilities, and persists across a new session', async t => {
  const h = await harness(t);
  assert.equal(h.session.capabilities.contentWorkflowAvailable,true);
  assert.equal(h.session.capabilities.modelConnected,false);
  assert.equal(h.session.capabilities.legacyPlannerConsumesWorkflow,false);
  assert.equal(h.session.capabilities.legacyRendererConsumesWorkflow,false);
  const diskBefore = await h.disk();
  const initial = await h.workflow();
  assert.equal(initial.projectRevision,0);
  assert.equal(initial.workflow.revision,0);
  assert.equal(initial.workflow.brief.audience,'模拟家庭');
  assert.equal(initial.workflow.brief.purpose,'先核对生活需求');
  assert.equal(initial.workflow.brief.mode,undefined);
  assert.deepEqual(initial.workflow.brief.outputs,[]);
  assert.ok(initial.inspection);
  assert.deepEqual(initial.integration,{legacyPlannerConsumesWorkflow:false,legacyRendererConsumesWorkflow:false,legacyInputsDifferFromWorkflow:[],legacyAssetRolesDifferFromWorkflow:[]});
  assert.equal(await h.disk(),diskBefore);
  const response = await h.update(initial,{operations:[
    {type:'setBrief',value:{mode:'co-create',outputs:['ppt','web']}},
    {type:'appendDialogue',value:{id:'message-1',role:'user',text:'希望先讨论家庭生活，再决定内容。'}}
  ]});
  assert.equal(response.status,200);
  const saved = await response.json();
  assert.equal(saved.projectRevision,1);
  assert.equal(saved.workflow.revision,1);
  assert.deepEqual(saved.workflow.brief.outputs,['ppt','web']);
  assert.equal(saved.workflow.dialogue[0].text,'希望先讨论家庭生活，再决定内容。');
  assert.deepEqual(saved.workflow.statements,[]);
  assert.deepEqual(saved.workflow.decisions,[]);
  assert.deepEqual(h.calls(),{planCalls:0,renderCalls:0});
  const oldToken = h.session.token;
  await h.restart();
  assert.notEqual(h.session.token,oldToken);
  assert.deepEqual(await h.workflow(),saved);
  assert.equal((await h.update(saved,{type:'setBrief',value:{purpose:'old token'}},{'X-Panda-Token':oldToken})).status,403);
  const resumed = await h.update(saved,{type:'appendDialogue',value:{id:'message-2',role:'assistant',text:'这条只保存对话，不自动提炼事实。'}});
  assert.equal(resumed.status,200);
  assert.equal((await resumed.json()).workflow.dialogue.length,2);
});

test('workflow writes retain token/origin protection and reject stale project or workflow versions', async t => {
  const h = await harness(t), initial = await h.workflow();
  const change = {type:'setBrief',value:{purpose:'核对空间功能'}};
  assert.equal((await h.update(initial,change,{'X-Panda-Token':'wrong'})).status,403);
  assert.equal((await h.update(initial,change,{Origin:'https://example.com'})).status,403);
  const success = await h.update(initial,change);
  assert.equal(success.status,200);
  const saved = await success.json(), diskBefore = await h.disk();
  assert.equal((await h.update(initial,change)).status,409);
  assert.equal((await h.request('PUT',h.base+'/workflow',{
    expectedRevision:saved.projectRevision,expectedWorkflowRevision:0,change
  })).status,409);
  assert.equal((await h.request('PUT',h.base+'/workflow',{expectedRevision:saved.projectRevision,change})).status,400);
  assert.equal(await h.disk(),diskBefore);
  const concurrent = await Promise.all([
    h.update(saved,{type:'appendDialogue',value:{id:'race-1',role:'user',text:'第一条更新'}}),
    h.update(saved,{type:'appendDialogue',value:{id:'race-2',role:'user',text:'第二条更新'}})
  ]);
  assert.deepEqual(concurrent.map(response => response.status).sort(),[200,409]);
  const final = await h.workflow();
  assert.equal(final.projectRevision,saved.projectRevision+1);
  assert.equal(final.workflow.dialogue.length,1);
});

test('invalid JSON and atomic batches do not overwrite persisted project data', async t => {
  const h = await harness(t);
  let state = await h.workflow();
  const saved = await h.update(state,{type:'appendDialogue',value:{id:'keep',role:'user',text:'保留这一条对话'}});
  assert.equal(saved.status,200);
  state = await saved.json();
  const diskBefore = await h.disk();
  const malformed = await fetch(h.app.origin+h.base+'/workflow',{
    method:'PUT',headers:{'Content-Type':'application/json','X-Panda-Token':h.session.token},body:'{"expectedRevision":'
  });
  assert.equal(malformed.status,400);
  assert.deepEqual(await malformed.json(),{error:'请求内容不是有效 JSON'});
  for (const invalidBody of [null,[],42]) assert.equal((await h.request('PUT',h.base+'/workflow',invalidBody)).status,400);
  const badBatch = await h.update(state,{operations:[
    {type:'appendDialogue',value:{id:'should-not-exist',role:'user',text:'整批失败时不能保存'}},
    {type:'upsertSource',value:{id:'invalid-source',assetId:'missing-asset'}}
  ]});
  assert.equal(badBatch.status,400);
  const diagnostics = await badBatch.json();
  assert.equal(typeof diagnostics.error,'string');
  assert.equal(diagnostics.code,'WORKFLOW_INVALID');
  assert.ok(diagnostics.issues.some(item => item.code === 'missing_reference' && typeof item.path === 'string' && item.message.includes('missing-asset')));
  const unsupportedFact = await h.update(state,{type:'upsertStatement',value:{id:'fact-without-evidence',kind:'fact',scope:'project',text:'未经支持的项目事实',evidence:[]}});
  assert.equal(unsupportedFact.status,400);
  const missingEvidence = await unsupportedFact.json();
  assert.equal(missingEvidence.code,'WORKFLOW_INVALID');
  assert.ok(missingEvidence.issues.some(item => item.code === 'missing_evidence' && item.path.includes('fact-without-evidence')));
  assert.equal((await h.update(state,{type:'setBrief',value:{outputs:['pptx']}})).status,400);
  assert.equal((await h.update(state,{type:'unknown-operation'})).status,400);
  assert.equal(await h.disk(),diskBefore);
  assert.deepEqual(await h.workflow(),state);
});

test('workflow uses uploaded assets, marks uploads unread, and preserves manual roles and logo state', async t => {
  const h = await harness(t);
  const uploaded = await (await h.upload('reference')).json();
  assert.equal(uploaded.workflow,undefined);
  let state = await h.workflow();
  assert.equal(state.workflow.assets[0].id,uploaded.assets[0].id);
  assert.deepEqual(state.workflow.assets[0].roles,['visual-reference']);
  assert.equal(state.workflow.assets[0].readStatus,'unread');
  assert.deepEqual(state.workflow.assets[0].readScope,[]);
  const asset = {id:uploaded.assets[0].id,roles:['design-case','visual-reference'],readStatus:'partial',readScope:['第 2 页']};
  const result = await h.update(state,{type:'upsertAsset',value:asset});
  assert.equal(result.status,200);
  state = await result.json();
  const diskBefore = await h.disk();
  const foreign = await h.update(state,{type:'upsertAsset',value:{id:'foreign-upload',roles:['project-asset'],readStatus:'unread',readScope:[]}});
  assert.equal(foreign.status,400);
  assert.equal(await h.disk(),diskBefore);
  const logoResponse = await h.upload('logo');
  assert.equal(logoResponse.status,200);
  const after = await logoResponse.json();
  assert.equal(after.revision,state.projectRevision+1);
  assert.equal(after.workflow.revision,state.workflow.revision+1);
  assert.deepEqual(after.workflow.assets[0],state.workflow.assets[0]);
  assert.equal(after.workflow.assets[1].readStatus,'unread');
  assert.deepEqual(after.workflow.assets[1].readScope,[]);
  assert.deepEqual(after.workflow.assets[1].roles,['project-asset']);
  assert.equal(after.assets[1].role,'logo');
  assert.equal(after.brand.logoAssetId,after.assets[1].id);
  const roleUpdate = await h.request('PUT',h.base,{
    expectedRevision:after.revision,assets:after.assets.map(item => ({id:item.id,role:'content'}))
  });
  assert.equal(roleUpdate.status,200);
  assert.deepEqual((await roleUpdate.json()).workflow.assets,after.workflow.assets);
  const afterRoles = await h.workflow();
  assert.deepEqual(afterRoles.integration.legacyAssetRolesDifferFromWorkflow,[{
    assetId:asset.id,legacyRole:'content',workflowRoles:['design-case','visual-reference']
  }]);
  assert.deepEqual(afterRoles.workflow.assets,after.workflow.assets, 'reporting disagreement must not overwrite explicit workflow roles');
});

test('successful workflow changes invalidate exports but preserve existing slides; rejected changes preserve exports', async t => {
  const h = await harness(t);
  await h.upload();
  const planned = await (await h.request('POST',h.base+'/plan',{})).json();
  const exportedResponse = await h.request('POST',h.base+'/export',{expectedRevision:planned.revision,formats:['web']});
  assert.equal(exportedResponse.status,200);
  const exported = await exportedResponse.json();
  assert.equal((await fetch(h.app.origin+exported.files[0].url)).status,200);
  const initial = await h.workflow(), diskBefore = await h.disk();
  assert.equal((await h.update(initial,{type:'setBrief',value:{mode:'invalid'}})).status,400);
  assert.equal(await h.disk(),diskBefore);
  assert.equal((await fetch(h.app.origin+exported.files[0].url)).status,200);
  const changedResponse = await h.update(initial,{type:'setBrief',value:{mode:'layout',purpose:'先保留现有图像，再讨论页面任务'}});
  assert.equal(changedResponse.status,200);
  const changed = await changedResponse.json(), project = await h.read();
  assert.equal(project.revision,planned.revision+1);
  assert.equal(project.exports,null);
  assert.deepEqual(project.slides,planned.slides);
  assert.equal(project.brief,planned.brief);
  assert.equal(project.audience,planned.audience);
  assert.equal(changed.projectRevision,project.revision);
  assert.equal((await fetch(h.app.origin+exported.files[0].url)).status,404);
  assert.deepEqual(h.calls(),{planCalls:1,renderCalls:1});
});

test('legacy project edits and planning expose differing inputs without replacing the saved workflow brief', async t => {
  const h = await harness(t);
  const savedResponse = await h.update(await h.workflow(),{type:'setBrief',value:{mode:'existing',outputs:['ppt']}});
  assert.equal(savedResponse.status,200);
  const saved = await savedResponse.json();
  assert.deepEqual(saved.integration.legacyInputsDifferFromWorkflow,[]);
  const editedResponse = await h.request('PUT',h.base,{expectedRevision:saved.projectRevision,audience:'另一位汇报对象'});
  assert.equal(editedResponse.status,200);
  const edited = await editedResponse.json(), afterEdit = await h.workflow();
  assert.deepEqual(edited.workflow,saved.workflow);
  assert.deepEqual(afterEdit.integration.legacyInputsDifferFromWorkflow,['audience']);
  const plannedResponse = await h.request('POST',h.base+'/plan',{
    expectedRevision:edited.revision,brief:'旧编排器的新简述',audience:'旧编排器的新对象'
  });
  assert.equal(plannedResponse.status,200);
  const planned = await plannedResponse.json(), afterPlan = await h.workflow();
  assert.equal(planned.brief,'旧编排器的新简述');
  assert.equal(planned.audience,'旧编排器的新对象');
  assert.deepEqual(planned.workflow,saved.workflow);
  assert.deepEqual(afterPlan.integration,{legacyPlannerConsumesWorkflow:false,legacyRendererConsumesWorkflow:false,legacyInputsDifferFromWorkflow:['purpose','audience'],legacyAssetRolesDifferFromWorkflow:[]});
  assert.equal(afterPlan.workflow.revision,saved.workflow.revision);
  assert.equal(afterPlan.projectRevision,saved.projectRevision+2);
  assert.deepEqual(h.calls(),{planCalls:1,renderCalls:0});
});
