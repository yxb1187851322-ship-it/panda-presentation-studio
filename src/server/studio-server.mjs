import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ID = /^[a-zA-Z0-9-]{1,80}$/;
const ROLES = new Set(['content', 'logo', 'plan', 'reference']);
const KINDS = new Set(['cover', 'hero', 'split', 'gallery', 'text', 'plan']);
const FORMATS = new Set(['pptx', 'web', 'images']);
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

export async function createStudio({ dataDir = path.join(repoRoot, 'data'), port = 4317, host = '127.0.0.1', importAsset, createPlan, renderProject } = {}) {
  if (host !== '127.0.0.1') throw new Error('当前工作台只监听本机 127.0.0.1');
  importAsset ??= (await import('../intake/index.mjs')).importAsset;
  createPlan ??= (await import('../planner/index.mjs')).createPlan;
  renderProject ??= (await import('../renderers/index.mjs')).renderProject;
  await fs.mkdir(dataDir, { recursive: true });
  dataDir = await fs.realpath(dataDir);
  const token = randomBytes(32).toString('hex');
  const locks = new Map();
  const jobs = new Set();
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
      return { id, kind:s.kind, title:str(s.title, 100), body:str(s.body, 1200), assetIds:[...new Set(s.assetIds)], caption:str(s.caption, 240), sourceIds:list(s.sourceIds), referenceIds:list(s.referenceIds), designReason:str(s.designReason, 600) };
    });
  }
  function invalidate(p) { p.revision++; p.exports = null; }
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
      if (url.pathname === '/api/session' && req.method === 'GET') return json(200, { token, capabilities:{local:true,modelConnected:false,formats:['pptx','web','images'],cadParsed:false,maxAssetBytes:64*1024*1024} });
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
        const p = {id:randomUUID(),title:str(b.title,100,'我的汇报'),brief:str(b.brief,12000),audience:str(b.audience,200),revision:0,brand:{logoAssetId:null,accent:'#4e625c',fontFamily:'Microsoft YaHei'},assets:[],slides:[],limitations:['当前按资料结构生成编排初稿，尚未连接大模型。图片语义与项目事实需核对。'],exports:null};
        await save(p); return json(201,p);
      }
      if (parts[0] === 'api' && parts[1] === 'projects' && parts[2]) {
        const id = uid(parts[2]);
        if (req.method === 'GET') {
          const p = await load(id);
          if (parts.length === 3) return json(200,p);
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
        return await locked(id, async () => {
          const p = await load(id);
          if (parts.length === 3 && req.method === 'PUT') {
            checkRevision(p, body);
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
            if (a.role === 'logo' && a.kind === 'image') p.brand.logoAssetId = a.id;
            invalidate(p); await save(p); return json(200,p);
          }
          if (parts.length === 4 && parts[3] === 'plan' && req.method === 'POST') {
            checkRevision(p,body,false);
            p.title=str(body.title,100,p.title); p.brief=str(body.brief,12000,p.brief); p.audience=str(body.audience,200,p.audience);
            const cards=JSON.parse(await fs.readFile(path.join(repoRoot,'resources/design-library/index.json'),'utf8')).cards;
            const result = await createPlan(p,{cards});
            p.slides = validateSlides(Array.isArray(result) ? result : result.slides,p);
            if (result.limitations) p.limitations=result.limitations;
            invalidate(p); await save(p); return json(200,p);
          }
          if (parts.length === 4 && parts[3] === 'export' && req.method === 'POST') {
            checkRevision(p,body);
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
      if (!res.headersSent) json(e.status || 500,{error:e.status ? e.message : '操作未完成，资料已保留。请查看本机服务日志后重试。'});
      else res.end();
      if (!e.status) console.error('[Panda studio]',e.message);
    }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  origin=`http://${host}:${server.address().port}`;
  return {server,origin,dataDir,close:()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}
