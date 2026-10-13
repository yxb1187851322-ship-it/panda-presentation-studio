const $ = id => document.getElementById(id);
const extensions = new Set(['png','jpg','jpeg','webp','txt','md','docx','pdf','pptx','dwg','dxf']);
const prefix = 'panda.chat.v1.';
const state = {token:null,project:null,projects:[],files:[],pending:null,busy:false,connected:false,preview:[],previewIndex:0};
const fileDrafts = new Map();
function rememberDraft(){write(draftKey(),$('message-input').value);saveUploaded();fileDrafts.set(state.project?.id||'new',state.files);}
function serverPending(project){const id=project.conversation?.activeRequestId;if(!id)return null;const m=project.conversation.messages?.find(m=>m.role==='user'&&m.requestId===id);return {requestId:id,message:m?.content||'正在处理上一条消息。',assetIds:m?.assetIds||[]};}
function node(tag,className,text){const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=String(text);return n;}
function read(key){try{return JSON.parse(localStorage.getItem(prefix+key));}catch{return null;}}
function write(key,value){try{localStorage.setItem(prefix+key,JSON.stringify(value));}catch{/* Server remains authoritative. */}}
function remove(key){try{localStorage.removeItem(prefix+key);}catch{}}
function draftKey(){return 'draft.'+(state.project?.id||'new');}
function pendingKey(id=state.project?.id){return 'pending.'+id;}
function base(){return '/api/projects/'+encodeURIComponent(state.project.id);}
function imageAsset(a){return /^image\/(png|jpeg|webp)$/i.test(a.mediaType||'');}
function assetUrl(a){return base()+'/assets/'+encodeURIComponent(a.id);}
function safeExport(value){try{const u=new URL(value,location.origin);return u.origin===location.origin&&u.pathname.startsWith(base()+'/exports/')?u.href:null;}catch{return null;}}
function errorMessage(e){if(e.status===409)return '对话内容已在另一处更新。这条消息尚未重新发送，请核对后再继续。';if(e.status===401||e.status===403)return '连接已变化，请刷新页面。输入内容会保留。';if(e.name==='TypeError')return '本地服务暂时没有回应。输入和附件已保留，请确认 Panda 仍在运行。';return e.message||'这次没有完成，资料已保留。';}
async function api(url,{method='GET',body}={}){
 const headers={Accept:'application/json'};if(method!=='GET'){headers['Content-Type']='application/json';headers['X-Panda-Token']=state.token||'';}
 const r=await fetch(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin',cache:'no-store'});
 let data;try{data=await r.json();}catch{throw new Error('暂时无法读取处理结果，请稍后查看。');}
 if(!r.ok){const e=new Error(typeof data.error==='string'?data.error:data.error?.message||data.message||'操作未完成');e.status=r.status;e.data=data;throw e;}
 return data;
}
function showError(text,recover=false){$('error-area').hidden=!text;$('error-text').textContent=text;$('recover-button').hidden=!recover;if(text)document.body.classList.remove('empty');}
function controls(){const enabled=state.connected&&!state.busy;$('send-button').disabled=!enabled||!!state.pending||!($('message-input').value.trim()||state.files.length);$('attach-button').disabled=!enabled||!!state.pending;$('new-button').disabled=state.busy;$('history-button').disabled=state.busy;document.querySelectorAll('.remove-attachment').forEach(b=>b.disabled=!enabled||!!state.pending);}
function working(value,text='正在理解你的想法…'){state.busy=value;$('working').hidden=!value;$('working-text').textContent=text;controls();if(value)document.body.classList.remove('empty');}
function resizeInput(){const input=$('message-input');input.style.height='58px';input.style.height=Math.min(180,Math.max(58,input.scrollHeight))+'px';}
function scrollEnd(){requestAnimationFrame(()=>{const el=$('chat-scroll');el.scrollTop=el.scrollHeight;});}
function adopt(project){state.project=project;write('current',project.id);try{localStorage.setItem('panda.studio.v1.lastProject',JSON.stringify(project.id));}catch{}const entry={id:project.id,title:project.title,updatedAt:project.updatedAt};const i=state.projects.findIndex(p=>p.id===project.id);if(i>=0)state.projects[i]=entry;else state.projects.unshift(entry);$('conversation-title').textContent=project.title||'';}
function fileTile(asset){const link=node('a','file-tile');link.href=assetUrl(asset);link.target='_blank';link.rel='noopener';if(imageAsset(asset)){const img=node('img');img.src=link.href;img.alt=asset.name;link.append(img);}else link.append(node('span','file-icon',(asset.name.split('.').pop()||'FILE').toUpperCase()));link.append(node('span','',asset.name));return link;}
function messageNode(message){const item=node('article','message '+(message.role==='user'?'user':'assistant'));if(message.role!=='user')item.append(node('p','speaker','PANDA'));const assets=(message.assetIds||[]).map(id=>state.project?.assets?.find(a=>a.id===id)).filter(Boolean);if(assets.length){const files=node('div','message-files');assets.forEach(a=>files.append(fileTile(a)));item.append(files);}item.append(node('p','message-content',message.content||''));return item;}
function renderResult(){
 const p=state.project,e=p?.exports;state.preview=[];if(!e||e.revision!==p.revision||p.ai?.planStale||p.ai?.analysisStale)return null;
 const card=node('section','result-card');card.setAttribute('aria-label','生成结果');const heading=node('div','result-heading');heading.append(node('strong','','已生成，看看这一版'),node('span','',(p.slides?.length||0)+' 页'));card.append(heading);
 const links=node('div','result-links');for(const f of e.files||[]){if(!['pptx','web'].includes(f.format)&&!(f.format==='images'&&/\.zip$/i.test(f.name)))continue;const url=safeExport(f.url);if(!url)continue;const link=node('a','result-link',f.format==='pptx'?'下载 PPT ↗':f.format==='web'?'打开网页 ↗':'下载图片包 ↗');link.href=url;link.target='_blank';link.rel='noopener';if(f.format!=='web')link.download=f.name;links.append(link);}
 const pages=(e.slides||[]).filter(s=>safeExport(s.url));state.preview=pages;
 if(pages.length){const view=node('button','preview-link','查看 '+pages.length+' 页');view.type='button';view.addEventListener('click',()=>openPreview(0));links.append(view);}
 card.append(links);
 if(pages.length){const previews=node('div','result-previews');pages.slice(0,3).forEach((s,i)=>{const b=node('button');b.type='button';b.setAttribute('aria-label','预览第 '+(i+1)+' 页');const img=node('img');img.src=safeExport(s.url);img.alt='第 '+(i+1)+' 页';img.loading='lazy';b.append(img);b.addEventListener('click',()=>openPreview(i));previews.append(b);});card.append(previews);}
 card.append(node('p','result-note','想改哪里，接着说就好。例如：“第 3 页图片放大，文字再少一点。”'));
 const warnings=[...new Set(e.warnings||[])];if(warnings.length){const details=node('details','result-details');details.append(node('summary','','文件说明'));const list=node('ul');warnings.forEach(x=>list.append(node('li','',x)));details.append(list);card.append(details);}
 return card;
}
function renderMessages(){
 const list=$('messages');list.replaceChildren();const p=state.project;
 const messages=(p?.conversation?.messages?.length?p.conversation.messages:p?.ai?.messages||[]).filter(m=>['user','assistant'].includes(m.role));
 if(messages.length>40)list.append(node('p','older-note','显示最近 40 条消息，较早内容仍保存在项目中。'));
 if(p?.assets?.length&&!messages.length){const note=node('div','context-note','这里已有 '+p.assets.length+' 份资料，可以直接继续说你的要求。');list.append(note);}
 messages.slice(-40).forEach(m=>list.append(messageNode(m)));
 if(state.pending&&!messages.some(m=>m.requestId===state.pending.requestId&&m.role==='user'))list.append(messageNode({role:'user',content:state.pending.message,assetIds:state.pending.assetIds||[]}));
 const result=renderResult();if(result)list.append(result);
 document.body.classList.toggle('empty',!list.childElementCount&&!state.busy);controls();
}
function renderAttachments(){
 const list=$('attachments');list.replaceChildren();state.files.forEach(entry=>{const tile=node('div','attachment');if(entry.preview){const img=node('img');img.src=entry.preview;img.alt=entry.name;tile.append(img);}else tile.append(node('span','file-icon',entry.name.split('.').pop().toUpperCase()));tile.append(node('span','attachment-name',entry.name+(entry.assetId?' · 已保存':'')));if(!entry.assetId){const b=node('button','remove-attachment','×');b.type='button';b.setAttribute('aria-label','移除附件 '+entry.name);b.addEventListener('click',()=>{if(entry.preview?.startsWith('blob:'))URL.revokeObjectURL(entry.preview);state.files=state.files.filter(x=>x!==entry);saveUploaded();renderAttachments();});tile.append(b);}list.append(tile);});
 list.hidden=!state.files.length;$('file-count').textContent=state.files.length?state.files.length+' 份附件':'';controls();
}
function saveUploaded(){if(state.project)write('uploads.'+state.project.id,state.files.filter(f=>f.assetId).map(({name,assetId})=>({name,assetId})));}
function restoreUploaded(){state.files=fileDrafts.get(state.project?.id||'new')||(read('uploads.'+state.project?.id)||[]).filter(f=>state.project?.assets?.some(a=>a.id===f.assetId)).map(f=>({...f,preview:imageAsset(state.project.assets.find(a=>a.id===f.assetId))?assetUrl({id:f.assetId}):null}));renderAttachments();}
function addFiles(files){
 if(state.busy||state.pending)return;const issues=[];for(const file of files){const ext=file.name.split('.').pop().toLowerCase();if(!extensions.has(ext)){issues.push(file.name+'：暂不支持此格式');continue;}if(file.size>64*1024*1024){issues.push(file.name+'：单个文件最多 64 MB');continue;}if((state.project?.assets?.length||0)+state.files.filter(x=>!x.assetId).length>=40){issues.push('本次项目最多保存 40 份资料');break;}if(state.files.some(x=>x.file&&x.name===file.name&&x.file.size===file.size&&x.file.lastModified===file.lastModified))continue;state.files.push({name:file.name,file,preview:/^image\/(png|jpeg|webp)$/i.test(file.type)?URL.createObjectURL(file):null});}
 showError(issues.join('\n'));renderAttachments();
}
function fileBase64(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(new Error('无法读取 '+file.name));r.readAsDataURL(file);});}
async function ensureProject(message){if(state.project)return;const p=await api('/api/projects',{method:'POST',body:{title:message.replace(/\s+/g,' ').slice(0,32)||'图片与资料',brief:'',audience:''}});const draft=$('message-input').value;adopt(p);write(draftKey(),draft);remove('draft.new');fileDrafts.delete('new');}
const phaseLabels={understanding:'正在阅读资料，理解你的要求…',analysis:'正在阅读资料，理解你的要求…',planning:'正在组织内容与页面…',revising:'正在修改你说的那一页…',rendering:'正在生成文件和页面预览…',exporting:'正在生成文件和页面预览…',completed:'已完成'};
function clearSentInput(sentText){const ids=new Set(state.pending?.assetIds||[]);state.files=state.files.filter(f=>{if(!ids.has(f.assetId))return true;if(f.preview?.startsWith('blob:'))URL.revokeObjectURL(f.preview);return false;});fileDrafts.set(state.project?.id,state.files);saveUploaded();if($('message-input').value.trim()===sentText){$('message-input').value='';write(draftKey(),'');}resizeInput();renderAttachments();}
async function acceptResult(result){
 if(result.project)adopt(result.project);
 if(result.status==='running'||result.status==='queued'){working(true,phaseLabels[result.phase]||'正在处理你的要求…');renderMessages();return false;}
 const pending=state.pending;state.pending=null;remove(pendingKey());working(false);renderMessages();
 if(result.status==='failed'){const text=typeof result.error==='string'?result.error:result.error?.message||'这次处理未完成，已完成的内容和资料都保留了。';showError(text);if(pending?.message&&!$('message-input').value){$('message-input').value=pending.message;write(draftKey(),pending.message);resizeInput();}}
 else showError('');scrollEnd();return true;
}
async function monitor(){
 if(!state.pending)return;working(true,'正在查看处理进度…');showError('');
 const expectedId=state.project.id;
 while(state.pending&&state.project?.id===expectedId){
  let result;try{result=await api(base()+'/conversation/'+encodeURIComponent(state.pending.requestId));}
  catch(e){
   if(e.status===404){try{const p=await api(base());const accepted=p.conversation?.messages?.some(m=>m.requestId===state.pending.requestId);adopt(p);if(!accepted&&!p.conversation?.activeRequestId){const unsent=state.pending;state.pending=null;remove(pendingKey());if(!$('message-input').value){$('message-input').value=unsent.message;write(draftKey(),unsent.message);}working(false);renderMessages();showError('这条消息尚未被受理，输入已保留。你可以再发送一次。');return;}}catch{}}
   working(false);showError('暂时无法确认处理结果。请点“查看处理结果”，避免重复提交。',true);return;
  }
  if(result.project?.conversation?.messages?.some(m=>m.role==='user'&&m.requestId===state.pending.requestId))clearSentInput(state.pending.draftText??state.pending.message);
  if(await acceptResult(result))return;await new Promise(resolve=>setTimeout(resolve,1400));
 }
}
async function send(event){
 event.preventDefault();if(state.busy||state.pending||!state.connected)return;
 const text=$('message-input').value.trim();if(!text&&!state.files.length)return;
 const message=text||'请先看看这些资料，告诉我可以怎样组织内容。';
 showError('');working(true,state.files.length?'正在保存附件…':'正在发送…');
 try{
  await ensureProject(message);
  for(let i=0;i<state.files.length;i++){const entry=state.files[i];if(entry.assetId)continue;entry.uploadId ||= crypto.randomUUID();working(true,'正在保存 '+(i+1)+' / '+state.files.length+' 份附件…');const before=new Set((state.project.assets||[]).map(a=>a.id));let p;try{p=await api(base()+'/assets',{method:'POST',body:{name:entry.name,base64:await fileBase64(entry.file),role:'content',uploadId:entry.uploadId,expectedRevision:state.project.revision}});}catch(e){try{const latest=await api(base());adopt(latest);const found=latest.assets.find(a=>a.clientUploadId===entry.uploadId);if(found){entry.assetId=found.id;saveUploaded();renderAttachments();continue;}}catch{}throw e;}adopt(p);entry.assetId=p.assets.find(a=>a.clientUploadId===entry.uploadId)?.id||p.assets.find(a=>!before.has(a.id))?.id;if(!entry.assetId)throw new Error('文件已处理，但未收到可用附件编号，请刷新后核对资料。');saveUploaded();renderAttachments();}
  const request={requestId:crypto.randomUUID(),revision:state.project.revision,message,assetIds:state.files.map(f=>f.assetId).filter(Boolean)};
  state.pending={...request,draftText:text};write(pendingKey(),state.pending);renderMessages();scrollEnd();
  let result;try{result=await api(base()+'/conversation',{method:'POST',body:request});}
  catch(e){
   if(e.status&&e.status<500){state.pending=null;remove(pendingKey());working(false);showError(errorMessage(e));try{adopt(await api(base()));}catch{}renderMessages();}
   else{working(false);showError('暂时无法确认消息是否处理完成。输入已保留，请点“查看处理结果”；不会自动重复提交。',true);}
   return;
  }
  clearSentInput(text);if(!(await acceptResult(result)))await monitor();
 }catch(e){working(false);showError(errorMessage(e));renderMessages();renderAttachments();}
}
async function loadProject(id){
 if(state.busy)return;rememberDraft();showError('');working(true,'正在打开对话…');
 try{adopt(await api('/api/projects/'+encodeURIComponent(id)));state.pending=serverPending(state.project)||read(pendingKey());$('message-input').value=read(draftKey())||'';restoreUploaded();renderMessages();resizeInput();working(false);scrollEnd();if(state.pending){write(pendingKey(),state.pending);void monitor();}}
 catch(e){working(false);showError(errorMessage(e));}
}
async function history(){
 if(state.busy)return;try{const data=await api('/api/projects');state.projects=data.projects||[];const list=$('history-list');list.replaceChildren();if(!state.projects.length)list.append(node('p','context-note','还没有历史对话。'));state.projects.forEach(p=>{const b=node('button','history-item');b.type='button';b.append(node('strong','',p.title||'未命名对话'),node('time','',new Date(p.updatedAt).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})));b.addEventListener('click',()=>{$('history-dialog').close();void loadProject(p.id);});list.append(b);});$('history-dialog').showModal();}catch(e){showError(errorMessage(e));}
}
function newChat(){
 if(state.busy)return;if(!state.project){$('message-input').focus();return;}rememberDraft();state.project=null;state.pending=null;state.files=fileDrafts.get('new')||[];state.preview=[];write('current',null);$('conversation-title').textContent='';$('message-input').value=read('draft.new')||'';showError('');renderMessages();renderAttachments();resizeInput();$('message-input').focus();
}
function openPreview(index){if(!state.preview.length)return;state.previewIndex=Math.max(0,Math.min(index,state.preview.length-1));const s=state.preview[state.previewIndex],url=safeExport(s.url);if(!url)return;$('preview-image').src=url;$('preview-image').alt='第 '+(state.previewIndex+1)+' 页实际生成结果';$('preview-label').textContent='第 '+(state.previewIndex+1)+' / '+state.preview.length+' 页';$('download-page').href=url+'?download=1';$('previous-page').disabled=state.previewIndex===0;$('next-page').disabled=state.previewIndex===state.preview.length-1;if(!$('preview-dialog').open)$('preview-dialog').showModal();}
$('composer').addEventListener('submit',send);
$('message-input').addEventListener('input',()=>{write(draftKey(),$('message-input').value);resizeInput();controls();});
$('message-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();if(!$('send-button').disabled)$('composer').requestSubmit();}});
$('attach-button').addEventListener('click',()=>$('file-input').click());
$('file-input').addEventListener('change',()=>{addFiles([...$('file-input').files]);$('file-input').value='';});
$('message-input').addEventListener('paste',e=>{const files=[...(e.clipboardData?.files||[])];if(files.length){e.preventDefault();addFiles(files);}});
$('history-button').addEventListener('click',history);$('close-history').addEventListener('click',()=>$('history-dialog').close());
$('new-button').addEventListener('click',newChat);$('recover-button').addEventListener('click',()=>void monitor());
$('close-preview').addEventListener('click',()=>$('preview-dialog').close());$('previous-page').addEventListener('click',()=>openPreview(state.previewIndex-1));$('next-page').addEventListener('click',()=>openPreview(state.previewIndex+1));
$('preview-dialog').addEventListener('keydown',e=>{if(e.key==='ArrowLeft')openPreview(state.previewIndex-1);if(e.key==='ArrowRight')openPreview(state.previewIndex+1);});
for(const id of ['history-dialog','preview-dialog'])$(id).addEventListener('click',e=>{if(e.target===$(id)){const r=$(id).getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$(id).close();}});
let dragDepth=0;
document.addEventListener('dragenter',e=>{if([...e.dataTransfer.types].includes('Files')){e.preventDefault();dragDepth++;if(!state.busy&&!state.pending)$('drop-overlay').hidden=false;}});
document.addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('Files')){e.preventDefault();e.dataTransfer.dropEffect=state.busy?'none':'copy';}});
document.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('drop-overlay').hidden=true;});
document.addEventListener('drop',e=>{if([...e.dataTransfer.types].includes('Files')){e.preventDefault();dragDepth=0;$('drop-overlay').hidden=true;addFiles([...e.dataTransfer.files]);}});
window.addEventListener('beforeunload',e=>{if(state.files.some(f=>!f.assetId)){e.preventDefault();e.returnValue='';}});
async function initialize(){
 controls();$('message-input').value=read('draft.new')||'';
 try{const session=await api('/api/session');state.token=session.token;state.connected=true;const current=read('current');if(current)await loadProject(current);else renderMessages();controls();}
 catch(e){showError('Panda 暂未连接。请启动本地工作台后刷新；你的输入会保留。');}
}
void initialize();
