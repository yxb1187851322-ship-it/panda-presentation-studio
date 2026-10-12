import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createContentWorkflow, applyContentWorkflow, inspectContentWorkflow } from '../core/content-workflow.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ID = /^[a-zA-Z0-9-]{1,80}$/;
const ROLES = new Set(['content', 'logo', 'plan', 'reference']);
const KINDS = new Set(['cover', 'hero', 'split', 'gallery', 'text', 'plan']);
const FORMATS = new Set(['pptx', 'web', 'images']);
const WORKFLOW_INTEGRATION = Object.freeze({legacyPlannerConsumesWorkflow:false,legacyRendererConsumesWorkflow:false});
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.json':'application/json; charset=utf-8', '.zip':'application/zip' };
const error = (status, message) => Object.assign(new Error(message), { status });
const str = (v, max, fallback = '') => {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || v.length > max) throw error(400, `文字需要在 ${max} 字以内`);
  return v.trim();
};
const uid = value => { if (!ID.test(value)) throw error(400, '项目或资料编号无效'); return value; };

async function jsonBody(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw error(415, '请求需要 JSON 内容');
  const chunks = []; let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 90 * 1024 * 1024) throw error(413, '单次上传超过 64 MB，请拆分资料');
    chunks.push(part);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw error(400, '请求内容不是有效 JSON'); }
}

async function safeFile(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw error(400, '文件路径无效');
  const base = await fs.realpath(root);
  const candidate = path.resolve(base, relative);
  if (!candidate.startsWith(base + path.sep)) throw error(403, '文件不在当前项目中');
  let actual;
  try { actual = await fs.realpath(candidate); } catch { throw error(404, '文件不存在'); }
  if (!actual.startsWith(base + path.sep)) throw error(403, '文件不在当前项目中');
  return actual;
}

export async function createStudio({ dataDir = path.join(repoRoot, 'data'), port = 4317, host = '127.0.0.1', importAsset, createPlan, renderProject, aiGateway, aiRunner } = {}) {
  if (host !== '127.0.0.1') throw new Error('当前工作台只监听本机 127.0.0.1');
  importAsset ??= (await import('../intake/index.mjs')).importAsset;
  createPlan ??= (await import('../planner/index.mjs')).createPlan;
  renderProject ??= (await import('../renderers/index.mjs')).renderProject;
  aiGateway ??= await (await import('../ai/gateway.mjs')).createModelGateway({repoRoot});
  aiRunner ??= (await import('../ai/pipeline.mjs')).runAiAction;
  await fs.mkdir(dataDir, { recursive: true });
  dataDir = await fs.realpath(dataDir);
  const token = randomBytes(32).toString('hex');
  const locks = new Map();
  const jobs = new Set();
  const aiJobs = new Set();
  let origin;
  const projectDir = id => path.join(dataDir, uid(id));
  async function load(id) {
    try { return JSON.parse(await fs.readFile(await safeFile(projectDir(id), 'project.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT' || e.status === 404) throw error(404, '项目不存在'); throw e; }
  }
  async function save(project) {
    project.updatedAt = new Date().toISOString();
    const dir = projectDir(project.id);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `project-${randomUUID()}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(project, null, 2), 'utf8');
    await fs.rename(tmp, path.join(dir, 'project.json'));
  }
  async function locked(id, action) {
    const previous = locks.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    locks.set(id, current);
    try { return await current; } finally { if (locks.get(id) === current) locks.delete(id); }
  }
  function checkRevision(project, body, required = true) {
    if (body.expectedRevision === undefined && !required) return;
    if (body.expectedRevision !== project.revision) throw error(409, '项目已有新修改，请重新载入后再操作');
  }
  function validateSlides(slides, project) {
    if (!Array.isArray(slides) || slides.length > 100) throw error(400, '页面数量应为 0–100 页');
    const assets = new Set(project.assets.map(a => a.id));
    const ids = new Set();
    return slides.map(s => {
      if (!s || !KINDS.has(s.kind)) throw error(400, '页面版式无效');
      const id = uid(s.id);
      if (ids.has(id)) throw error(400, '页面编号重复'); ids.add(id);
      if (!Array.isArray(s.assetIds) || s.assetIds.length > 8 || s.assetIds.some(a => !assets.has(a))) throw error(400, '页面引用了不存在的资料');
      const list = v => Array.isArray(v) ? v.slice(0, 20).map(x => str(x, 100)) : [];
      return { id, kind:s.kind, title:str(s.title, 100), body:str(s.body, 1200), assetIds:[...new Set(s.assetIds)], caption:str(s.caption, 240), sourceIds:list(s.sourceIds), referenceIds:list(s.referenceIds), designReason:str(s.designReason, 600),...(s.imageFit === 'contain' ? {imageFit:'contain'} : {}) };
    });
  }
  function invalidate(p) { p.revision++; p.exports = null; }
  function hasAiSlides(p) {
    return !!p.slides?.length && (p.ai?.pagesMode === 'model' || (!p.ai?.pagesMode && p.ai?.runs?.some(run => ['plan','revise'].includes(run.action))));
  }
  function markAiInputsStale(p) {
    if (!p.ai) return;
    p.ai.analysisStale = true;
    if (hasAiSlides(p)) p.ai.planStale = true;
  }
  const analysisInputs = p => JSON.stringify({title:p.title,brief:p.brief,audience:p.audience,assets:p.assets.map(a => ({id:a.id,role:a.role}))});
  const workflowInputs = workflow => JSON.stringify({brief:workflow.brief,statements:workflow.statements,decisions:workflow.decisions,contentUnits:workflow.contentUnits,
    assets:(workflow.assets || []).map(({id,roles}) => ({id,roles})),
    dialogue:(workflow.dialogue || []).filter(item => item.role === 'user').map(({id,text}) => ({id,text}))},
    (key,value) => ['version','updatedRevision'].includes(key) ? undefined : value);
  async function aiStatus() {
    const value = await aiGateway.getStatus();
    // Explicitly select public fields; credentials and their locations stay on the server.
    return {configured:!!value.configured,verified:!!value.verified,provider:typeof value.provider === 'string' ? value.provider : '',
      models:Object.fromEntries(['analysis','planning','revision'].map(key => [key,typeof value.models?.[key] === 'string' ? value.models[key] : ''])),
      verifiedModels:Array.isArray(value.verifiedModels) ? value.verifiedModels.filter(item => typeof item === 'string') : [],
      lastSuccessAt:typeof value.lastSuccessAt === 'string' ? value.lastSuccessAt : null,
      limitations:Array.isArray(value.limitations) ? value.limitations.filter(item => typeof item === 'string') : []};
  }
  const workflowAsset = asset => ({ id:asset.id, roles:[asset.role === 'reference' ? 'visual-reference' : 'project-asset'], readStatus:'unread', readScope:[] });
  function workflowFor(project) {
    return project.workflow ?? createContentWorkflow({
      brief:{...(project.audience ? {audience:project.audience} : {}),...(project.brief ? {purpose:project.brief} : {})},
      assets:project.assets.map(workflowAsset)
    });
  }
  function workflowResult(project, workflow = workflowFor(project)) {
    // A difference is visible without guessing which brief is authoritative.
    const legacyInputsDifferFromWorkflow = Object.entries({purpose:project.brief,audience:project.audience})
      .filter(([key,value]) => (value ?? '') !== (workflow.brief[key] ?? '')).map(([key]) => key);
    const legacyAssetRolesDifferFromWorkflow = project.assets.flatMap(asset => {
      const saved = workflow.assets.find(item => item.id === asset.id);
      const expected = asset.role === 'reference' ? 'visual-reference' : 'project-asset';
      return saved && !saved.roles.includes(expected)
        ? [{assetId:asset.id,legacyRole:asset.role,workflowRoles:[...saved.roles]}] : [];
    });
    return { projectRevision:project.revision, workflow, inspection:inspectContentWorkflow(workflow),
      integration:{...WORKFLOW_INTEGRATION,legacyInputsDifferFromWorkflow,legacyAssetRolesDifferFromWorkflow} };
  }
  function applyWorkflow(project, current, change, expectedRevision) {
    let next;
    try { next = applyContentWorkflow(current, change, {expectedRevision}); }
    catch (e) {
      if (e.code === 'WORKFLOW_CONFLICT') throw Object.assign(error(409,e.message), {code:e.code});
      if (e.code === 'WORKFLOW_INVALID' && Array.isArray(e.issues) && e.issues.every(item =>
        item && ['code','path','message'].every(key => typeof item[key] === 'string'))) {
        throw Object.assign(error(400,e.message), {code:e.code,issues:e.issues.map(({code,path,message}) => ({code,path,message}))});
      }
      throw e;
    }
    const assetIds = new Set(project.assets.map(asset => asset.id));
    if (next.assets.some(asset => !assetIds.has(asset.id))) throw error(400, '内容流程引用了未上传到当前项目的资料');
    return next;
  }
  const server = http.createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' }); res.end(JSON.stringify(value)); };
    async function sendFile(file, { download = false, name } = {}) {
      const ext = path.extname(file).toLowerCase();
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control':'no-store' };
      if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name || path.basename(file))}`;
      const content = await fs.readFile(file);
      res.writeHead(200, headers); res.end(content);
    }
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; connect-src 'self'");
      if (req.headers.host !== new URL(origin).host) throw error(403, '仅允许本机工作台访问');
      if (req.headers.origin && req.headers.origin !== origin) throw error(403, '跨站请求已拒绝');
      const url = new URL(req.url, origin);
      const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
      if (!['GET', 'POST', 'PUT'].includes(req.method)) throw error(405, '不支持此操作');
      if (req.method !== 'GET') {
        const supplied = Buffer.from(String(req.headers['x-panda-token'] || ''));
        const expected = Buffer.from(token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw error(403, '会话已变化，请刷新页面');
      }
      if (url.pathname === '/api/session' && req.method === 'GET') {
        const ai = await aiStatus();
        return json(200, { token, capabilities:{local:true,contentWorkflowAvailable:true,...WORKFLOW_INTEGRATION,modelConnected:ai.verified,aiAvailable:true,formats:['pptx','web','images'],cadParsed:false,maxAssetBytes:64*1024*1024} });
      }
      if (url.pathname === '/api/ai/status' && req.method === 'GET') return json(200, await aiStatus());
      if (url.pathname === '/api/projects' && req.method === 'GET') {
        const dirs = await fs.readdir(dataDir, { withFileTypes:true });
        const projects = [];
        for (const d of dirs.filter(d => d.isDirectory() && ID.test(d.name))) {
          try { const p = await load(d.name); projects.push({id:p.id,title:p.title,updatedAt:p.updatedAt}); } catch { /* damaged project is kept for recovery */ }
        }
        return json(200, {projects:projects.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))});
      }
      if (url.pathname === '/api/projects' && req.method === 'POST') {
        const b = await jsonBody(req);
        const p = {id:randomUUID(),title:str(b.title,100,'我的汇报'),brief:str(b.brief,12000),audience:str(b.audience,200),revision:0,brand:{logoAssetId:null,accent:'#4e625c',fontFamily:'Microsoft YaHei'},assets:[],slides:[],limitations:['规则快速编排不进行模型理解；模型分析与页面制作请使用“与 Panda 讨论内容”。'],exports:null};
        await save(p); return json(201,p);
      }
      if (parts[0] === 'api' && parts[1] === 'projects' && parts[2]) {
        const id = uid(parts[2]);
        if (req.method === 'GET') {
          const p = await load(id);
          if (parts.length === 3) return json(200,p);
          if (parts.length === 4 && parts[3] === 'workflow') return json(200,workflowResult(p));
          if (parts[3] === 'assets' && parts.length === 5) {
            const a = p.assets.find(a => a.id === uid(parts[4]));
            if (!a) throw error(404, '资料不存在');
            return sendFile(await safeFile(projectDir(id), a.file), { download:a.kind !== 'image', name:a.name });
          }
          if (parts[3] === 'exports' && parts.length >= 5) {
            // Only files explicitly returned by the completed render can be served.
            const name = parts.slice(4).join('/');
            const e = p.exports;
            if (!e || e.revision !== p.revision) throw error(404, '请按当前内容重新导出');
            const allowed = [...e.files.map(f=>f.name), ...e.slides.map(s=>s.preview)];
            if (!allowed.includes(name)) throw error(404, '导出文件不存在');
            const file = await safeFile(path.join(projectDir(id),'exports',e.runId),name);
            return sendFile(file, { download: url.searchParams.get('download') === '1' || path.extname(file) === '.pptx' || path.extname(file) === '.zip' });
          }
          throw error(404,'入口不存在');
        }
        const body = await jsonBody(req);
        if (jobs.has(id)) throw error(409,'正在导出当前版本，完成后再修改');
        if (parts.length === 4 && parts[3] === 'ai' && req.method === 'POST') {
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw error(400,'模型请求需要 JSON 对象');
          if (!['analyze','chat','plan','revise'].includes(body.action)) throw error(400,'模型操作无效');
          const message = str(body.message,8000), slideId = body.slideId === undefined ? undefined : uid(body.slideId);
          if (body.action === 'chat' && !message) throw error(400,'请填写需要补充的要求');
          if (body.action === 'revise' && (!message || !slideId)) throw error(400,'请指定要修改的页面及要求');
          const snapshot = await locked(id, async () => {
            if (aiJobs.has(id)) throw error(409,'当前项目的模型任务仍在处理，请稍后再试');
            const p = await load(id); checkRevision(p,body);
            if (body.action === 'plan' && p.ai?.analysisStale) throw error(422,'项目说明或资料已变化，请先重新分析资料，再生成页面');
            if (body.action === 'revise' && (p.ai?.analysisStale || p.ai?.planStale)) throw error(422,'整套页面与当前内容尚未同步。请先重新分析并生成页面，局部改稿不能清除整套待更新状态');
            if (slideId && !p.slides.some(slide => slide.id === slideId)) throw error(400,'要修改的页面不存在');
            aiJobs.add(id); return structuredClone(p);
          });
          try {
            let result;
            try { result = await aiRunner({project:snapshot,projectDir:projectDir(id),action:body.action,message,slideId,gateway:aiGateway}); }
            catch (e) {
              // Never log upstream response bodies, request headers, or credential-bearing errors.
              const safe = typeof e.publicMessage === 'string' ? e.publicMessage
                : e.status === 422 ? '模型结果未通过内容检查，当前项目已保留。请调整要求后重试。'
                : '模型调用未完成，当前项目已保留。请检查模型配置或稍后重试。';
              throw Object.assign(error(e.status === 422 ? 422 : e.status === 503 ? 503 : 502,safe),{code:'AI_ACTION_FAILED'});
            }
            return await locked(id,async () => {
              const p = await load(id);
              if (p.revision !== snapshot.revision) {
                const candidates = path.join(projectDir(id),'ai-candidates');
                await fs.mkdir(candidates,{recursive:true});
                await fs.writeFile(path.join(candidates,`${randomUUID()}.json`),JSON.stringify({basedOnRevision:snapshot.revision,action:body.action,result},null,2));
                throw error(409,'模型处理期间项目已修改。新结果已保留为本机候选，未覆盖你的修改，请重新载入后再分析。');
              }
              if (!result || !result.ai || typeof result.ai !== 'object' || Array.isArray(result.ai)) throw error(502,'模型未返回有效分析，当前项目已保留');
              const slides = result.slides === undefined ? undefined : validateSlides(result.slides,p);
              if (['analyze','chat'].includes(body.action) && slides !== undefined) throw error(502,'分析任务不能直接替换页面，当前项目已保留');
              if (['plan','revise'].includes(body.action) && !slides?.length) throw error(502,'模型未返回可用页面，当前项目已保留');
              const previousSlides = body.action === 'revise' ? validateSlides(p.slides,p) : null;
              if (body.action === 'revise' && (slides.length !== previousSlides.length || slides.some((slide,index) =>
                slide.id !== previousSlides[index].id || (slide.id !== slideId && JSON.stringify(slide) !== JSON.stringify(previousSlides[index]))))) {
                throw error(502,'局部改稿影响了其他页面，当前项目已保留');
              }
              const previousAi = p.ai, hadAiPages = hasAiSlides(p);
              p.ai = {...result.ai,
                analysisStale:['analyze','chat'].includes(body.action) ? false : !!previousAi?.analysisStale,
                planStale:body.action === 'plan' ? false : (['analyze','chat'].includes(body.action) && hadAiPages) || !!previousAi?.planStale,
                pagesMode:body.action === 'plan' ? 'model' : previousAi?.pagesMode || (hadAiPages ? 'model' : 'rules')};
              if (slides !== undefined) p.slides = body.action === 'revise'
                ? p.slides.map(slide => slide.id === slideId ? slides.find(next => next.id === slideId) : slide)
                : slides;
              invalidate(p); await save(p); return json(200,p);
            });
          } finally { aiJobs.delete(id); }
        }
        return await locked(id, async () => {
          const p = await load(id);
          if (parts.length === 4 && parts[3] === 'workflow' && req.method === 'PUT') {
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw error(400, '内容流程请求需要 JSON 对象');
            checkRevision(p, body);
            if (!Number.isInteger(body.expectedWorkflowRevision) || body.expectedWorkflowRevision < 0) throw error(400, '需要有效的内容流程版本');
            const current = workflowFor(p);
            if (body.expectedWorkflowRevision !== current.revision) throw error(409, '内容流程已有新修改，请重新载入后再操作');
            p.workflow = applyWorkflow(p, current, body.change, body.expectedWorkflowRevision);
            if (workflowInputs(p.workflow) !== workflowInputs(current)) markAiInputsStale(p);
            invalidate(p); await save(p); return json(200,workflowResult(p));
          }
          if (parts.length === 3 && req.method === 'PUT') {
            checkRevision(p, body);
            const inputsBefore = analysisInputs(p);
            if (body.slides !== undefined) p.slides = validateSlides(body.slides,p);
            if (body.title !== undefined) p.title = str(body.title,100);
            if (body.brief !== undefined) p.brief = str(body.brief,12000);
            if (body.audience !== undefined) p.audience = str(body.audience,200);
            if (body.assets !== undefined) {
              if (!Array.isArray(body.assets) || body.assets.length !== p.assets.length) throw error(400,'资料列表不一致');
              const seen = new Set();
              for (const update of body.assets) {
                const a = p.assets.find(a=>a.id === update.id);
                if (!a || seen.has(a.id) || !ROLES.has(update.role)) throw error(400,'资料角色无效');
                seen.add(a.id); a.role = update.role;
              }
            }
            if (body.brand !== undefined) {
              const b = body.brand;
              if (!b || typeof b !== 'object') throw error(400,'品牌设置无效');
              if (b.accent !== undefined) { if (!/^#[a-f\d]{6}$/i.test(b.accent)) throw error(400,'品牌色应为六位颜色'); p.brand.accent=b.accent; }
              if (b.logoAssetId !== undefined) { if (b.logoAssetId !== null && !p.assets.some(a=>a.id===b.logoAssetId && a.kind==='image')) throw error(400,'Logo 需要图片资料'); p.brand.logoAssetId=b.logoAssetId; }
            }
            if (analysisInputs(p) !== inputsBefore) markAiInputsStale(p);
            invalidate(p); await save(p); return json(200,p);
          }
          if (parts.length === 4 && parts[3] === 'assets' && req.method === 'POST') {
            checkRevision(p,body,false);
            if (p.assets.length >= 40) throw error(400,'本轮最多 40 份资料，请分项目制作');
            if (typeof body.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.base64)) throw error(400,'文件编码无效');
            const buffer = Buffer.from(body.base64,'base64');
            if (!buffer.length || buffer.length > 64*1024*1024) throw error(413,'文件需要为 1 字节至 64 MB');
            if (!ROLES.has(body.role || 'content')) throw error(400,'资料角色无效');
            const total = p.assets.reduce((s,a)=>s+(a.bytes||0),0);
            if (total + buffer.length > 512*1024*1024) throw error(413,'此项目已超过 512 MB，请拆分资料');
            const a = await importAsset({projectDir:projectDir(id),name:str(body.name,255),buffer,role:body.role || 'content'});
            a.bytes = buffer.length;
            p.assets.push(a);
            markAiInputsStale(p);
            if (p.workflow) p.workflow = applyWorkflow(p, p.workflow, {type:'upsertAsset',value:workflowAsset(a)}, p.workflow.revision);
            if (a.role === 'logo' && a.kind === 'image') p.brand.logoAssetId = a.id;
            invalidate(p); await save(p); return json(200,p);
          }
          if (parts.length === 4 && parts[3] === 'plan' && req.method === 'POST') {
            checkRevision(p,body,false);
            const inputsBefore = analysisInputs(p);
            p.title=str(body.title,100,p.title); p.brief=str(body.brief,12000,p.brief); p.audience=str(body.audience,200,p.audience);
            const cards=JSON.parse(await fs.readFile(path.join(repoRoot,'resources/design-library/index.json'),'utf8')).cards;
            const result = await createPlan(p,{cards});
            if (analysisInputs(p) !== inputsBefore) markAiInputsStale(p);
            p.slides = validateSlides(Array.isArray(result) ? result : result.slides,p);
            if (p.ai) { p.ai.pagesMode = 'rules'; p.ai.planStale = false; }
            if (result.limitations) p.limitations=result.limitations;
            invalidate(p); await save(p); return json(200,p);
          }
          if (parts.length === 4 && parts[3] === 'export' && req.method === 'POST') {
            checkRevision(p,body);
            if (hasAiSlides(p) && (p.ai?.planStale || p.ai?.analysisStale)) throw error(422,'当前页面仍是旧内容。请按最新分析重新生成页面，再制作交付文件');
            if (!Array.isArray(body.formats) || !body.formats.length || body.formats.some(f=>!FORMATS.has(f))) throw error(400,'请选择有效输出格式');
            if (!p.slides.length) throw error(400,'请先生成并检查内容编排');
            const runId=randomUUID(); const outputDir=path.join(projectDir(id),'exports',runId);
            await fs.mkdir(outputDir,{recursive:true}); jobs.add(id);
            try {
              const result=await renderProject({project:p,projectDir:projectDir(id),outputDir,formats:[...new Set(body.formats)]});
              const fileUrl=name=>`/api/projects/${id}/exports/${name.split('/').map(encodeURIComponent).join('/')}`;
              const files=await Promise.all(result.files.map(async f=>{ await safeFile(outputDir,f.name); return {...f,url:fileUrl(f.name)}; }));
              const slides=await Promise.all((result.slides || []).map(async s=>{ await safeFile(outputDir,s.preview); return {...s,url:fileUrl(s.preview)}; }));
              p.exports={runId,revision:p.revision,files,slides,warnings:result.warnings || []}; await save(p);
              return json(200,p.exports);
            } finally { jobs.delete(id); }
          }
          throw error(404,'入口不存在');
        });
      }
      if (req.method === 'GET' && ['/','/index.html','/styles.css','/app.js'].includes(url.pathname)) {
        return sendFile(await safeFile(path.join(repoRoot,'studio'),url.pathname==='/'?'index.html':url.pathname.slice(1)));
      }
      throw error(404,'入口不存在');
    } catch (e) {
      const details = e.code === 'WORKFLOW_INVALID' && e.status === 400 ? {code:e.code,issues:e.issues}
        : e.code === 'WORKFLOW_CONFLICT' && e.status === 409 ? {code:e.code} : {};
      if (!res.headersSent) json(e.status || 500,{error:e.status ? e.message : '操作未完成，资料已保留。请查看本机服务日志后重试。',...details});
      else res.end();
      if (!e.status) console.error('[Panda studio]',e.message);
    }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  origin=`http://${host}:${server.address().port}`;
  return {server,origin,dataDir,close:()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}
