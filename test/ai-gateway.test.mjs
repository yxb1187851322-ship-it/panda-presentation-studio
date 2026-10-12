import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createModelGateway, readDotEnv } from '../src/ai/gateway.mjs';

const json = (value,status=200,headers={}) => new Response(JSON.stringify(value),{status,headers});
async function fixture(format='gemini',options={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'panda-gateway-'));
  await fs.writeFile(path.join(root,'.env'),'KEEP=yes\nAPI_KEY=obsolete\nAPI_KEY=test-secret-not-live\n');
  const calls=[];
  const config={models:{analysis:'test-model',planning:'test-model',revision:'test-model'},maxOutputTokens:3000,maxEstimatedCost:2,...options.config};
  const fetchImpl=async(url,request) => {
    calls.push({url,request});
    if(url.endsWith('/pricing')) return json({available_for_this_key:options.available??true,channel_groups:[{is_active:true,in_key_whitelist:true,billing_method:'按token',input_token_price:1,output_token_price:3,...options.price}]});
    if(url.endsWith('/balance')) return json({balance:options.balance??100,api_key_quota:{limit:0}});
    if(url.includes('task-status')) return json({is_final:true,cost:0.012});
    if(request.method==='GET') return json({name:'test-model',api_format:format,tags:options.tags??['多模态']});
    if(options.response) return options.response(request,root);
    const body=format==='gemini'?{candidates:[{content:{parts:[{text:'{"summary":"完成"}'}]},finishReason:'STOP'}],usageMetadata:{totalTokenCount:42}}:format==='anthropic'?{content:[{type:'thinking',thinking:'hidden'},{type:'text',text:'{"summary":"完成"}'}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:22}}:{choices:[{message:{content:'{"summary":"完成"}'},finish_reason:'stop'}],usage:{total_tokens:42}};
    return json(body,200,{'x-task-id':'123'});
  };
  const gateway=await createModelGateway({repoRoot:root,config,fetchImpl});
  return {root,calls,gateway};
}

test('dotenv uses the last assignment without exposing it in status',async()=>{
  assert.deepEqual(readDotEnv('\uFEFFAPI_KEY=old\nexport API_KEY="new"\nX=value # note'),{API_KEY:'new',X:'value'});
  const {gateway,calls}=await fixture();
  const status=await gateway.getStatus();
  assert.equal(status.configured,true);assert.equal(status.verified,false);assert.equal(calls.length,0);
  assert.doesNotMatch(JSON.stringify(status),/test-secret|obsolete|\.env/);
});
for(const format of ['gemini','openai','anthropic']) test(`${format} sends actual image bytes using documented protocol and captures receipt`,async()=>{
  const {gateway,calls,root}=await fixture(format);
  const image={assetId:'room',mimeType:'image/png',data:Buffer.from('image-bytes').toString('base64')};
  const result=await gateway.complete({system:'Instruction',prompt:'Explain source',images:[image]});
  assert.equal(result.cost,0.012);assert.equal(result.taskId,'123');assert.equal(result.text,'{"summary":"完成"}');
  const post=calls.filter(call=>call.request.method==='POST');assert.equal(post.length,1);
  const body=JSON.parse(post[0].request.body);
  assert.equal(post[0].request.headers.Authorization,'Bearer test-secret-not-live');
  assert.equal(post[0].request.redirect,'error');
  if(format==='gemini')assert.equal(body.contents[0].parts[2].inline_data.data,image.data);
  if(format==='openai')assert.equal(body.messages[1].content[2].image_url.url,`data:image/png;base64,${image.data}`);
  if(format==='anthropic')assert.equal(body.messages[0].content[2].source.data,image.data);
  assert.equal((await gateway.getStatus()).verified,true);
  await fs.appendFile(path.join(root,'.env'),'API_KEY=changed-secret\n');
  assert.equal((await gateway.getStatus()).verified,false);
});
for(const [name,options,code] of [['unavailable',{available:false},'AI_MODEL_UNAVAILABLE'],['low balance',{balance:0},'AI_BALANCE_LOW'],['unknown vision',{tags:[]},'AI_VISION_UNVERIFIED'],['cost limit',{config:{maxEstimatedCost:0.000001}},'AI_COST_LIMIT']]) test(`${name} blocks submission`,async()=>{
  const {gateway,calls}=await fixture('gemini',options);
  await assert.rejects(gateway.complete({prompt:'x',images:[{assetId:'i',mimeType:'image/png',data:'aW1n'}]}),{code});
  assert.equal(calls.filter(call=>call.request.method==='POST').length,0);
});
test('provider failure is redacted and never automatically retried',async()=>{
  const {gateway,calls}=await fixture('openai',{response:()=>json({error:{message:'secret test-secret-not-live file C:/private',type:'upstream_failure'}},500)});
  await assert.rejects(gateway.complete({prompt:'hello'}),error=>error.code==='AI_PROVIDER_ERROR' && !JSON.stringify(error).includes('test-secret-not-live'));
  assert.equal(calls.filter(call=>call.request.method==='POST').length,1);
});
test('truncated output is not adopted as a successful model call',async()=>{
  const {gateway}=await fixture('openai',{response:()=>json({choices:[{message:{content:'{"cut":'},finish_reason:'length'}]})});
  await assert.rejects(gateway.complete({prompt:'hello'}),{code:'AI_INCOMPLETE_RESPONSE'});
  assert.equal((await gateway.getStatus()).verified,false);
});
test('malformed inputs are blocked before network access',async()=>{
  const {gateway,calls}=await fixture();
  await assert.rejects(gateway.complete({model:'not-enabled'}),{code:'AI_MODEL_NOT_ALLOWED'});
  await assert.rejects(gateway.complete({images:[{mimeType:'image/svg+xml',data:'aW1n'}]}),{code:'AI_IMAGES_INVALID'});
  assert.equal(calls.length,0);
});

test('invalid or negative pricing cannot bypass the preflight cost gate',async()=>{
  for (const price of [{input_image_price:'unknown'},{input_image_free_count:'none'},{input_token_price:-1},{output_token_price:-1},{input_image_free_count:-1},{input_token_price:1e308}]) {
    const {gateway,calls}=await fixture('openai',{price});
    await assert.rejects(gateway.complete({prompt:'pricing probe',images:[{assetId:'i',mimeType:'image/png',data:'aW1n'}]}),{code:'AI_PRICE_UNKNOWN'});
    assert.equal(calls.filter(call=>call.request.method==='POST').length,0);
  }
});

test('oversized streamed replies stop reading and retain the paid task number',async()=>{
  let cancelled=false;
  const {gateway,calls}=await fixture('openai',{response:()=>new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}}),{headers:{'x-task-id':'paid-large'}})});
  await assert.rejects(gateway.complete({prompt:'probe'}),{code:'AI_RESPONSE_TOO_LARGE',taskId:'paid-large'});
  assert.equal(cancelled,true);assert.equal(calls.filter(call=>call.request.method==='POST').length,1);
});

test('connection receipt write failure keeps the completed paid response with a warning',async()=>{
  const {gateway,calls}=await fixture('openai',{response:async(request,root)=>{
    await fs.mkdir(path.join(root,'local','ai-connection.json'));
    return json({choices:[{message:{content:'{"summary":"received"}'},finish_reason:'stop'}]},200,{'x-task-id':'paid-saved'});
  }});
  const result=await gateway.complete({prompt:'probe'});
  assert.equal(result.taskId,'paid-saved');assert.equal(result.text,'{"summary":"received"}');assert.ok(result.warnings.some(w=>w.includes('回执')));
  assert.equal(calls.filter(call=>call.request.method==='POST').length,1);
});
