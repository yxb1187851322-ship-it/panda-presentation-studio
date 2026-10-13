import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStudio} from '../src/server/studio-server.mjs';
import {resolveConversationAction} from '../src/ai/conversation.mjs';

const page = (id,title) => ({id,kind:'text',title,body:'已有正文',assetIds:[],caption:'',sourceIds:[],referenceIds:[],designReason:'已有依据'});
const analysis = {summary:'依据实际资料组织汇报',facts:[],questions:[],warnings:[]};
async function harness(t,{runner,render} = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(),'panda-conversation-'));
  const calls = [], renders = [];
  const app = await createStudio({port:0,dataDir,aiGateway:{getStatus:() => ({configured:true,verified:true,models:{}})},
    importAsset:async ({name,role}) => ({id:'attached-image',name,role,kind:'image',file:'assets/image.png'}),createPlan:() => [],
    aiRunner:async args => {calls.push(args.action);return runner ? runner(args) : {ai:{analysis},reply:'已理解，先讨论内容。',nextAction:{action:'reply'}};},
    renderProject:async args => {renders.push(args.formats);if (render) return render(args);await fs.writeFile(path.join(args.outputDir,'deck.html'),'<title>test</title>');return {files:[{name:'deck.html',format:'web'}],slides:[]};}});
  t.after(async () => {await app.close();assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir())+path.sep+'panda-conversation-'));await fs.rm(dataDir,{recursive:true,force:true});});
  const session = await (await fetch(app.origin+'/api/session')).json();
  const request = (method,url,body) => fetch(app.origin+url,{method,headers:{'Content-Type':'application/json','X-Panda-Token':session.token},body:body === undefined ? undefined : JSON.stringify(body)});
  const project = await (await request('POST','/api/projects',{title:'对话测试'})).json(), base = '/api/projects/'+project.id;
  const poll = async requestId => {for (let index = 0; index < 200;index++) {const result = await (await request('GET',base+'/conversation/'+requestId)).json();if (result.status !== 'running') return result;await new Promise(resolve => setTimeout(resolve,10));}throw new Error('conversation did not settle');};
  const send = (p,message,requestId = 'turn-1',extra={}) => request('POST',base+'/conversation',{revision:p.revision,message,requestId,...extra});
  return {app,dataDir,project,base,request,send,poll,calls,renders,read:async () => (await request('GET',base)).json()};
}

test('a natural conversation produces one durable user turn and reply without rendering',async t => {
  const h = await harness(t);
  const accepted = await h.send(h.project,'先看看我们该怎么表达');assert.equal(accepted.status,202);
  const result = await h.poll('turn-1');assert.equal(result.status,'completed',JSON.stringify(result));assert.match(result.reply,/先讨论/);
  assert.deepEqual(h.calls,['analyze']);assert.equal(h.renders.length,0);
  assert.deepEqual(result.project.conversation.messages.map(item => item.role),['user','assistant']);
  assert.equal(result.project.conversation.activeRequestId,null);
  assert.equal((await fs.readdir(path.join(h.dataDir,h.project.id,'conversation-results'))).length,1);
});

test('explicit production performs understanding, planning and a usable local export',async t => {
  const h = await harness(t,{runner:async ({action}) => action === 'plan'
    ? {ai:{analysis},reply:'先讲需求，再讲回应。',slides:[page('p1','需求'),page('p2','回应')]}
    : {ai:{analysis},reply:'可以开始制作。',nextAction:{action:'produce',formats:['pptx','web','images']}}});
  await h.send(h.project,'请制作一套PPT');const result = await h.poll('turn-1');
  assert.equal(result.status,'completed');assert.deepEqual(h.calls,['analyze','plan']);assert.deepEqual(result.completedSteps,['analyze','plan','export']);
  assert.equal(result.project.slides.length,2);assert.equal(result.project.conversation.messages.length,2);
  assert.equal((await fetch(h.app.origin+result.files[0].url)).status,200);
  assert.equal(result.project.exports.revision,result.project.revision);
  assert.deepEqual(h.renders,[['pptx','web','images']]);
});

test('model revision only changes the explicitly named page and retains other pages',async t => {
  const h = await harness(t,{runner:async ({action,project,slideId}) => action === 'revise'
    ? {ai:{analysis},reply:'第二页标题已压短。',slides:project.slides.map(slide => slide.id === slideId ? {...slide,title:'简短标题'} : slide)}
    : {ai:{analysis},reply:'只改第二页。',nextAction:{action:'revise',slideId:'p2'}}});
  const seeded = await (await h.request('PUT',h.base,{expectedRevision:0,slides:[page('p1','第一页'),page('p2','第二页')]})).json();
  await h.send(seeded,'把第2页标题改短');const result = await h.poll('turn-1');
  assert.equal(result.status,'completed');assert.deepEqual(h.calls,['analyze','revise']);
  assert.deepEqual(result.project.slides[0],seeded.slides[0]);assert.equal(result.project.slides[1].title,'简短标题');
});

test('questions, negative instructions and ambiguous revision never trigger production',async t => {
  let intent = {action:'produce'};
  const h = await harness(t,{runner:async () => ({ai:{analysis},reply:'先讨论。',nextAction:intent})});
  let current = h.project;
  for (const [index,message] of ['怎么制作PPT？','不要制作，先分析','你好'].entries()) {
    await h.send(current,message,'turn-'+index);const result = await h.poll('turn-'+index);current = result.project;assert.equal(result.status,'completed');
  }
  intent = {action:'revise',slideId:'invented'};
  for (const [index,message] of ['这页改一下','第6页不用改','第6页是什么？'].entries()) {
    await h.send(current,message,'revise-'+index);current = (await h.poll('revise-'+index)).project;
  }
  assert.equal(h.renders.length,0);assert.ok(h.calls.every(action => ['analyze','chat'].includes(action)));
  assert.deepEqual(resolveConversationAction({action:'revise',slideId:'p2'},'改第1页',[page('p1','第一'),page('p2','第二')]).action,'reply');
  assert.equal(resolveConversationAction({action:'revise'},'改第六页',Array.from({length:6},(_,index) => page('p'+index,'title'+index))).slideId,'p5');
});

test('duplicate in-flight and completed request ids return the original result without extra calls',async t => {
  let release, entered;const gate = new Promise(resolve => {release=resolve;}),started = new Promise(resolve => {entered=resolve;});
  const h = await harness(t,{runner:async () => {entered();await gate;return {ai:{analysis},reply:'回复',nextAction:{action:'reply'}};}});
  await h.send(h.project,'看看资料');await started;
  assert.equal((await h.send(h.project,'看看资料')).status,202);assert.equal(h.calls.length,1);
  assert.equal((await h.send(h.project,'不同内容')).status,409);
  assert.equal((await h.send(h.project,'另一个任务','turn-2')).status,409);
  release();await h.poll('turn-1');assert.equal((await h.send(h.project,'看看资料')).status,200);assert.equal(h.calls.length,1);
  assert.equal((await h.read()).conversation.messages.length,2);
});

test('late paid results never overwrite edits and remain on disk for recovery',async t => {
  let release, entered;const gate = new Promise(resolve => {release=resolve;}),started = new Promise(resolve => {entered=resolve;});
  const h = await harness(t,{runner:async () => {entered();await gate;return {ai:{analysis},reply:'回复',nextAction:{action:'produce'}};}});
  await h.send(h.project,'请制作PPT');await started;
  assert.equal((await h.request('PUT',h.base,{expectedRevision:0,title:'用户手改'})).status,200);
  release();const result = await h.poll('turn-1');assert.equal(result.status,'failed');assert.equal(result.project.title,'用户手改');assert.equal(result.project.ai,undefined);
  assert.equal(h.calls.length,1);assert.equal(h.renders.length,0);assert.match(result.error,/没有覆盖/);
  assert.equal((await fs.readdir(path.join(h.dataDir,h.project.id,'conversation-results'))).length,1);
});

test('export failure preserves paid pages and explicit re-export uses no model',async t => {
  let failRender = true;
  const h = await harness(t,{runner:async ({action}) => action === 'plan' ? {ai:{analysis},reply:'已规划。',slides:[page('p1','保留页面')]} : {ai:{analysis},reply:'已分析。',nextAction:{action:'produce'}},
    render:async ({outputDir}) => {if(failRender) throw new Error('secret-upstream-raw');await fs.writeFile(path.join(outputDir,'deck.html'),'ok');return {files:[{name:'deck.html',format:'web'}],slides:[]};}});
  await h.send(h.project,'制作PPT');const failed = await h.poll('turn-1');assert.equal(failed.status,'failed');assert.equal(failed.project.slides.length,1);assert.match(failed.reply,/重新导出/);assert.ok(!JSON.stringify(failed).includes('secret-upstream-raw'));
  assert.deepEqual(h.calls,['analyze','plan']);failRender=false;
  await h.send(failed.project,'重新导出','turn-2');const recovered = await h.poll('turn-2');assert.equal(recovered.status,'completed');assert.deepEqual(h.calls,['analyze','plan']);assert.equal(recovered.files.length,1);
});

test('provider failure is sanitized and duplicate failure is not retried',async t => {
  const h = await harness(t,{runner:async () => {throw new Error('secret-token raw provider response');}});
  await h.send(h.project,'分析图片');const result = await h.poll('turn-1');assert.equal(result.status,'failed');assert.equal(result.project.ai,undefined);
  assert.ok(!JSON.stringify(result).includes('secret-token'));assert.equal((await h.send(h.project,'分析图片')).status,200);assert.equal(h.calls.length,1);
});

test('pure discussion retains available exports and does not make current AI pages stale',async t => {
  const h = await harness(t,{runner:async ({action,project}) => action === 'plan' ? {ai:{analysis},reply:'已规划。',slides:[page('p1','当前页面')]} : {ai:{analysis},reply:'可以在下方下载。',nextAction:{action:project.slides.length ? 'reply' : 'produce',changesRequirements:false}}});
  await h.send(h.project,'制作PPT');const made = await h.poll('turn-1');
  await h.send(made.project,'下载在哪里？','turn-2');const discussed = await h.poll('turn-2');
  assert.equal(discussed.project.ai.planStale,false);assert.equal(discussed.files.length,1);assert.equal((await fetch(h.app.origin+discussed.files[0].url)).status,200);
  assert.equal(h.renders.length,1);
});

test('owned attachments are recorded and invalid references fail before the first model call',async t => {
  const h = await harness(t);
  assert.equal((await h.send(h.project,'', 'bad',{assetIds:['foreign']})).status,400);assert.equal(h.calls.length,0);
  const uploaded = await (await h.request('POST',h.base+'/assets',{expectedRevision:0,name:'photo.png',base64:'eA=='})).json();
  await h.send(uploaded,'','upload-1',{assetIds:['attached-image']});const result = await h.poll('upload-1');
  assert.deepEqual(result.project.conversation.messages[0].assetIds,['attached-image']);assert.equal(result.status,'completed');assert.equal(h.renders.length,0);
});

test('upload idempotency permits safe replay after a lost response and rejects changed bytes',async t => {
  const h = await harness(t), upload = {expectedRevision:0,name:'photo.png',base64:'eA==',uploadId:'upload-once'};
  const first = await (await h.request('POST',h.base+'/assets',upload)).json();
  const replay = await h.request('POST',h.base+'/assets',upload);assert.equal(replay.status,200);
  const current = await replay.json();assert.equal(current.revision,first.revision);assert.equal(current.assets.length,1);assert.equal(current.assets[0].clientUploadId,'upload-once');assert.match(current.assets[0].sha256,/^[a-f0-9]{64}$/);
  assert.equal((await h.request('POST',h.base+'/assets',{...upload,base64:'eQ=='})).status,409);
  assert.equal((await h.request('POST',h.base+'/conversation',{revision:current.revision,message:'你好'})).status,400);
});

test('persisted interrupted jobs become terminal without paying again or leaving an active marker',async t => {
  const h = await harness(t), directory = path.join(h.dataDir,h.project.id);
  const p = await h.read();p.conversation = {messages:[{id:'sent',role:'user',content:'制作PPT',requestId:'old-turn'}],activeRequestId:'old-turn'};
  await fs.writeFile(path.join(directory,'project.json'),JSON.stringify(p));await fs.mkdir(path.join(directory,'conversation-jobs'));
  await fs.writeFile(path.join(directory,'conversation-jobs','old-turn.json'),JSON.stringify({requestId:'old-turn',status:'running',phase:'planning',completedSteps:['analyze'],warnings:[]}));
  const recovered = await h.poll('old-turn');assert.equal(recovered.status,'failed');assert.equal(recovered.project.conversation.activeRequestId,null);assert.equal(recovered.project.conversation.messages.length,2);assert.match(recovered.reply,/中断/);assert.equal(h.calls.length,0);
  assert.equal((await h.poll('old-turn')).project.conversation.messages.length,2);
});

test('legacy history migrates once while internal multi-stage calls remain out of the visible conversation',async t => {
  const h = await harness(t), filename = path.join(h.dataDir,h.project.id,'project.json');
  const p = await h.read();p.ai = {analysis,messages:[{role:'user',content:'之前确认的内容',at:'2026-10-12T00:00:00Z'},{role:'assistant',content:'记下了'}]};await fs.writeFile(filename,JSON.stringify(p));
  await h.send(p,'你好');const first = await h.poll('turn-1');assert.equal(first.project.conversation.messages.length,4);assert.equal(first.project.conversation.messages[0].content,'之前确认的内容');
  await h.send(first.project,'继续讨论','turn-2');const second = await h.poll('turn-2');assert.equal(second.project.conversation.messages.length,6);
});

test('natural imperative wording and constraints on other pages retain intended production',() => {
  for (const message of ['帮我做PPT','给我一份PPT','出一份PPT']) assert.equal(resolveConversationAction({action:'produce'},message).action,'produce',message);
  assert.equal(resolveConversationAction({action:'revise',slideId:'p1'},'改第1页标题，其他页不要改',[page('p1','标题')]).action,'revise');
  assert.deepEqual(resolveConversationAction({action:'produce',formats:['pptx','images']},'不需要导出图片，只制作PPT').formats,['pptx']);
});

test('a later planning failure retains successful analysis and never resubmits a duplicate turn',async t => {
  const h = await harness(t,{runner:async ({action}) => {if(action === 'plan') throw new Error('private-provider-body');return {ai:{analysis},reply:'分析已完成。',nextAction:{action:'produce'}};}});
  await h.send(h.project,'制作PPT');const failed = await h.poll('turn-1');assert.equal(failed.status,'failed');assert.deepEqual(failed.completedSteps,['analyze']);assert.deepEqual(failed.project.ai.analysis,analysis);assert.deepEqual(h.calls,['analyze','plan']);
  await h.send(h.project,'制作PPT');assert.deepEqual(h.calls,['analyze','plan']);
});
