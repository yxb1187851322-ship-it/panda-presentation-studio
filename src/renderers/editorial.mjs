import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadRuntimePackage } from './assets.mjs';

const runFile = promisify(execFile);

// This fallback preserves the inspected page appearance. The separate PPTX stays editable.
export async function exportPreviewPdf({scene,outputDir,pythonExecutable=process.env.PANDA_PYTHON}) {
  validateEditorialScene(scene);
  if (!pythonExecutable) throw new Error('PANDA_PYTHON is required for the preview-based PDF fallback');
  const manifest=path.join(outputDir,'.private','pdf-manifest.json');
  await fs.writeFile(manifest,JSON.stringify({title:scene.title,width:scene.width,height:scene.height,pages:scene.pages.map((_,i)=>path.resolve(outputDir,'previews',`page-${String(i+1).padStart(2,'0')}.png`))}));
  await runFile(pythonExecutable,[fileURLToPath(new URL('./pdf-from-previews.py',import.meta.url)),manifest,path.resolve(outputDir,'booklet.pdf')],{windowsHide:true,maxBuffer:1024*1024});
  return 'raster-from-reviewed-previews';
}

const colour = /^#[\da-f]{6}$/i;
const finite = n => Number.isFinite(n) && n >= 0;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/** A reviewed editorial scene is explicit geometry, not a model/aesthetic verdict. */
export function validateEditorialScene(scene) {
  if (!scene || !finite(scene.width) || !finite(scene.height) || scene.width < 320 || scene.height < 320 || scene.width > 4096 || scene.height > 4096) throw new Error('Invalid book canvas');
  if (!Array.isArray(scene.pages) || !scene.pages.length || scene.pages.length > 100) throw new Error('Book requires 1–100 pages');
  for (const page of scene.pages) {
    if (!colour.test(page.background || '#FFFFFF') || !Array.isArray(page.elements) || page.elements.length > 100) throw new Error('Invalid page');
    for (const e of page.elements) {
      if (!['text','image'].includes(e.type)) throw new Error('Only native text and source images are supported');
      if (![e.x,e.y,e.w,e.h].every(finite) || !e.w || !e.h || e.x+e.w > scene.width+.1 || e.y+e.h > scene.height+.1) throw new Error('Element outside page');
      if (e.type === 'text' && (typeof e.text !== 'string' || e.text.length > 6000 || !finite(e.size) || e.size < 8 || !colour.test(e.color || '#161616'))) throw new Error('Invalid text');
      if (e.type === 'image' && (typeof e.asset !== 'string' || path.isAbsolute(e.asset) || /(^|[\\/])\.\.([\\/]|$)/.test(e.asset) || !/\.(png|jpg|jpeg)$/i.test(e.asset))) throw new Error('Invalid image path');
      if (e.crop && (!['left','right','top','bottom'].every(k => finite(e.crop[k]) && e.crop[k] < 1) || e.crop.left+e.crop.right >= 1 || e.crop.top+e.crop.bottom >= 1)) throw new Error('Invalid crop');
    }
  }
  return scene;
}

export function editorialViewer(scene) {
  const pages = scene.pages.map((p,i) => ({title:p.title||`第 ${i+1} 页`,src:`previews/page-${String(i+1).padStart(2,'0')}.png`,text:p.elements.filter(e=>e.type==='text').map(e=>e.text).join('\n')}));
  const json = JSON.stringify(pages).replace(/</g,'\\u003c');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(scene.title)}</title><style>
*{box-sizing:border-box}body{margin:0;background:#101112;color:#f5f5f5;font:14px "Microsoft YaHei",sans-serif}header{height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 24px;gap:20px;border-bottom:1px solid #333}header strong{font-weight:400}nav{display:flex;gap:18px}a{color:inherit;text-decoration:none}button{font:inherit;border:1px solid #777;background:transparent;color:inherit;border-radius:3px;padding:9px 15px;cursor:pointer}button:disabled{opacity:.3;cursor:default}main{height:calc(100dvh - 136px);display:flex;align-items:center;justify-content:center;padding:18px}.page{max-width:100%;max-height:100%;object-fit:contain;box-shadow:0 10px 48px #0008}footer{height:72px;display:flex;align-items:center;justify-content:center;gap:22px}#count{min-width:85px;text-align:center;color:#bfc1c3}dialog{background:#161718;color:#eee;border:1px solid #666;max-width:680px;width:calc(100% - 32px);max-height:80vh;padding:28px}dialog::backdrop{background:#000a}#reading{white-space:pre-line;line-height:1.9}#close{float:right}@media(max-width:600px){header{padding:0 14px;font-size:12px}nav{gap:12px}main{padding:8px}footer{gap:10px}button{padding:9px 12px}}
</style><header><strong>${esc(scene.title)}</strong><nav><a href="booklet.pdf" download>PDF</a><a href="booklet.pptx" download>PPT</a><button id="read">读文字</button></nav></header><main><img id="page" class="page" alt=""></main><footer><button id="prev">上一页</button><span id="count"></span><button id="next">下一页</button></footer><dialog id="dialog"><button id="close">关闭</button><h2 id="chapter"></h2><p id="reading"></p></dialog><script>
const pages=${json};let index=Math.max(0,Math.min(pages.length-1,(Number(location.hash.slice(1))||1)-1));const $=s=>document.getElementById(s);function show(){const p=pages[index];$('page').src=p.src;$('page').alt=p.title;$('count').textContent=(index+1)+' / '+pages.length;$('prev').disabled=!index;$('next').disabled=index===pages.length-1;history.replaceState(null,'','#'+(index+1));$('chapter').textContent=p.title;$('reading').textContent=p.text}function move(n){index=Math.max(0,Math.min(pages.length-1,index+n));show()}$('prev').onclick=()=>move(-1);$('next').onclick=()=>move(1);$('read').onclick=()=>{$('dialog').showModal()};$('close').onclick=()=>{$('dialog').close()};document.addEventListener('keydown',e=>{if($('dialog').open)return;if(e.key==='ArrowRight')move(1);if(e.key==='ArrowLeft')move(-1)});show();</script></html>`;
}

export async function renderEditorialBook({scene,assetRoot,outputDir,pngShortEdge=2160}) {
  validateEditorialScene(scene);
  if (!Number.isFinite(pngShortEdge) || pngShortEdge < 720 || pngShortEdge > 4320) throw new Error('Invalid render resolution');
  const root=await fs.realpath(assetRoot);
  await fs.mkdir(outputDir,{recursive:true});
  if ((await fs.readdir(outputDir)).length) throw new Error('Use a new empty output directory');
  await fs.mkdir(path.join(outputDir,'previews'));
  await fs.mkdir(path.join(outputDir,'.private'));
  const {Presentation,PresentationFile}=await loadRuntimePackage('@oai/artifact-tool');
  const sharp=(await loadRuntimePackage('sharp')).default;
  const presentation=Presentation.create({slideSize:{width:scene.width,height:scene.height}});
  const assets=new Map();const coverage=[];
  for(let i=0;i<scene.pages.length;i++) {
    const page=scene.pages[i];const slide=presentation.slides.add();slide.background.fill=page.background||'#FFFFFF';
    for(const e of page.elements) {
      const position={left:e.x,top:e.y,width:e.w,height:e.h};
      if(e.type==='text') {
        const shape=slide.shapes.add({geometry:'textbox',name:e.name||e.text.slice(0,20),position,fill:'none',line:{fill:'none',width:0,style:'solid'}});
        shape.text=e.text;shape.text.style={typeface:e.font||scene.font||'Microsoft YaHei',fontSize:e.size,bold:e.bold||false,color:e.color||'#161616',insets:0,verticalAlignment:'top',wrap:'square',autoFit:'none',alignment:e.align||'left'};
      } else {
        if(!assets.has(e.asset)) {
          const resolved=await fs.realpath(path.resolve(root,e.asset));const relative=path.relative(root,resolved);
          if(relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative))throw new Error('Image escapes asset root');
          const bytes=await fs.readFile(resolved);const meta=await sharp(bytes,{limitInputPixels:80000000}).metadata();
          if(!['png','jpeg'].includes(meta.format)||meta.pages>1||meta.orientation>1)throw new Error('Image must be normalized PNG/JPEG');
          assets.set(e.asset,{bytes,meta});
        }
        const {bytes,meta}=assets.get(e.asset);
        slide.images.add({blob:new Uint8Array(bytes),contentType:meta.format==='png'?'image/png':'image/jpeg',alt:e.alt||page.title,fit:e.fit||'contain',position,...(e.crop?{crop:e.crop}:{})});
        coverage.push({page:i+1,asset:e.asset,nativeWidth:meta.width,nativeHeight:meta.height,crop:e.crop||null,fit:e.fit||'contain'});
      }
    }
    slide.speakerNotes.text=page.notes||'';
  }
  const candidate=path.join(outputDir,'.private','candidate.pptx');
  await (await PresentationFile.exportPptx(presentation)).save(candidate);
  const scale=pngShortEdge/Math.min(scene.width,scene.height);
  for(let i=0;i<presentation.slides.items.length;i++) {
    const slide=presentation.slides.items[i];const stem='page-'+String(i+1).padStart(2,'0');
    const png=await presentation.export({slide,format:'png',scale});
    await fs.writeFile(path.join(outputDir,'previews',stem+'.png'),new Uint8Array(await png.arrayBuffer()));
    await fs.writeFile(path.join(outputDir,'.private',stem+'.layout.json'),await (await slide.export({format:'layout'})).text());
  }
  let pdfMode='native-artifact-tool';
  try {
    await fs.writeFile(path.join(outputDir,'booklet.pdf'),new Uint8Array(await (await presentation.export({format:'pdf'})).arrayBuffer()));
  } catch(error) {
    if (!String(error.message).includes('#standard-fonts/')) throw error;
    pdfMode=await exportPreviewPdf({scene,outputDir});
  }
  await fs.writeFile(path.join(outputDir,'index.html'),editorialViewer(scene));
  await fs.writeFile(path.join(outputDir,'.private','render-receipt.json'),JSON.stringify({renderer:'artifact-tool editorial scene',pageCount:scene.pages.length,canvas:{width:scene.width,height:scene.height},pngShortEdge,pdfMode,coverage,editable:'PPTX: text and individual image objects; content inside supplied screenshots remains raster',status:'rendered-awaiting-visual-review'},null,2));
  return {presentation,PresentationFile,candidate,coverage};
}
