const $ = id => document.getElementById(id);
const kinds = { cover: '开场 / 封面', hero: '主视觉', split: '图文并置', gallery: '图片组', text: '文字叙述', plan: '图纸说明' };
const roles = { content: '项目内容', logo: '品牌 Logo', plan: '图纸 / 平面', reference: '版面参考' };
const formats = { pptx: '可编辑 PPT', web: '项目网页', images: '页面图片' };
const extensions = new Set(['png', 'jpg', 'jpeg', 'webp', 'txt', 'md', 'docx', 'pdf', 'pptx', 'dwg', 'dxf']);
const storagePrefix = 'panda.studio.v1.';
const state = { token: null, project: null, projects: [], step: 'intake', selected: 0, dirty: false, busy: false, connected: false, conflict: false, exports: null };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function readLocal(key) { try { return JSON.parse(localStorage.getItem(storagePrefix + key)); } catch { return null; } }
function writeLocal(key, value) { try { localStorage.setItem(storagePrefix + key, JSON.stringify(value)); } catch { /* Server-side saves remain available when local storage is disabled. */ } }
function clearLocal(key) { try { localStorage.removeItem(storagePrefix + key); } catch { /* Local storage can be disabled. */ } }
function bodyText(body) { return Array.isArray(body) ? body.map(value => typeof value === 'string' ? value : value?.text || '').join('\n') : String(body || ''); }
function currentSlide() { return state.project?.slides?.[state.selected]; }
function isImage(asset) { return /^image\/(png|jpeg|webp)$/i.test(asset.mediaType || '') || (asset.kind === 'image' && /\.(png|jpe?g|webp)$/i.test(asset.name || '')); }
function assetURL(asset) { return `/api/projects/${encodeURIComponent(state.project.id)}/assets/${encodeURIComponent(asset.id)}`; }
function showNotice(message, type = '') {
  $('notice').textContent = message;
  $('notice').className = 'notice' + (type ? ' ' + type : '');
  $('notice').hidden = !message;
}
function describeError(error) {
  if (error.status === 409) return '项目版本已经变化，或仍在制作中。你的修改已在本机保留。请先下载修改备份，再重新载入已保存版本；制作进行中时可稍后重试。';
  if (error.status === 401 || error.status === 403) return '本地会话已失效，请刷新页面重新连接。未保存修改会在这台浏览器中保留。';
  if (error.status === 413) return '文件过大。每个文件最多 64 MB，请缩小文件后重试。';
  if (error.name === 'TypeError') return '暂时无法连接本地服务。请确认启动窗口仍在运行，再刷新页面。';
  return error.message || '操作未完成，请稍后重试。';
}
async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['X-Panda-Token'] = state.token || ''; }
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' });
  let data;
  try { data = await response.json(); } catch { throw new Error(`本地服务返回了无法读取的结果（${response.status}）。`); }
  if (!response.ok) {
    const error = new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}
function setBusy(value) {
  state.busy = value;
  document.body.classList.toggle('busy-cursor', value);
  document.querySelectorAll('button, input, textarea, select').forEach(node => { if (node.id !== 'close-image') node.disabled = value || !state.connected; });
  $('drop-zone').setAttribute('aria-disabled', String(value || !state.connected));
  if (!value && state.connected) {
    $('save-project').disabled = !state.project || !state.dirty;
    $('go-deliver').disabled = !state.project?.slides?.length;
    $('export-project').disabled = !state.project?.slides?.length;
    $('generate-plan').disabled = state.conflict;
    $('save-project').disabled ||= state.conflict;
    $('export-project').disabled ||= state.conflict;
  }
}
async function operate(message, work) {
  if (state.busy || !state.connected) return;
  setBusy(true);
  showNotice(message, 'busy');
  try { await work(); }
  catch (error) {
    if (error.status === 409) { state.conflict = true; $('conflict-actions').hidden = false; }
    showNotice(describeError(error), 'error');
  } finally { setBusy(false); }
}
function intakeValues() { return { title: $('project-title').value.trim() || '未命名项目', brief: $('project-brief').value.trim(), audience: $('project-audience').value.trim() }; }
function persistDraft() {
  if (!state.project) { writeLocal('intake', intakeValues()); return; }
  writeLocal(`draft.${state.project.id}`, { revision: state.project.revision, title: state.project.title, brief: state.project.brief, audience: state.project.audience, slides: state.project.slides, brand: state.project.brand, assets: state.project.assets.map(({ id, role }) => ({ id, role })), savedAt: new Date().toISOString() });
}
function markDirty() {
  state.dirty = true;
  state.exports = null;
  if (state.project) state.project.exports = null;
  persistDraft();
  updateSaveState();
  renderExports();
  if (!state.busy) setBusy(false);
}
function updateSaveState() {
  const revision = state.project?.revision;
  $('revision-label').textContent = revision !== undefined ? `版本 ${revision} · ${state.dirty ? '有未保存修改' : '已保存'}` : '尚未编排';
  $('intake-saved').textContent = state.project ? (state.dirty ? '修改暂存在本机，生成或保存后写入项目。' : '资料已保存到本机，可关闭后继续。') : '资料与项目保存在这台电脑，不会自动上传 GitHub。';
  $('delivery-revision').textContent = revision !== undefined ? `PROJECT / V${revision}${state.dirty ? ' · 待保存' : ''}` : '尚未制作';
  $('export-summary').textContent = state.project?.slides?.length ? `共 ${state.project.slides.length} 页。${state.dirty ? '制作前会先保存当前修改。' : '将使用当前已保存版本制作。'}` : '先完成编排，再制作文件。';
  $('footer-state').textContent = state.project ? `${state.project.title} · ${state.project.slides?.length || 0} 页 · ${state.dirty ? '待保存' : '已保存'}` : '本地资料 · 分步设计 · 可继续修改';
}
function adoptProject(project, { clearDraft = true } = {}) {
  state.project = project;
  state.project.assets ||= [];
  state.project.slides ||= [];
  state.project.brand ||= {};
  state.dirty = false;
  state.conflict = false;
  state.exports = project.exports || null;
  state.selected = Math.min(state.selected, Math.max(0, project.slides.length - 1));
  $('conflict-actions').hidden = true;
  writeLocal('lastProject', project.id);
  if (clearDraft) clearLocal(`draft.${project.id}`);
  const index = state.projects.findIndex(value => value.id === project.id);
  const summary = { id: project.id, title: project.title, updatedAt: project.updatedAt };
  if (index >= 0) state.projects[index] = summary; else state.projects.unshift(summary);
  renderAll();
}
function restoreDraft(project) {
  const draft = readLocal(`draft.${project.id}`);
  if (!draft) return;
  if (draft.revision !== project.revision) {
    state.conflict = true;
    $('conflict-actions').hidden = false;
    showNotice('发现上一轮未保存的修改，但项目版本已变化。请下载修改备份，或重新载入已保存版本继续。', 'error');
    return;
  }
  for (const field of ['title', 'brief', 'audience', 'slides', 'brand']) if (draft[field] !== undefined) state.project[field] = draft[field];
  for (const entry of draft.assets || []) {
    const asset = state.project.assets.find(value => value.id === entry.id);
    if (asset && roles[entry.role]) asset.role = entry.role;
  }
  state.dirty = true;
  state.exports = null;
  showNotice('已恢复上次未保存的修改。检查后点击“保存修改”，或直接继续制作。');
  renderAll();
}
async function ensureProject() {
  if (state.project) return state.project;
  const project = await api('/api/projects', { method: 'POST', body: intakeValues() });
  adoptProject(project);
  clearLocal('intake');
  return project;
}
async function saveProject() {
  if (!state.project || !state.dirty) return;
  if (state.conflict) throw new Error('请先处理项目版本变化，再保存修改。');
  const project = await api(`/api/projects/${encodeURIComponent(state.project.id)}`, { method: 'PUT', body: { expectedRevision: state.project.revision, title: state.project.title, brief: state.project.brief, audience: state.project.audience, slides: state.project.slides, brand: state.project.brand, assets: state.project.assets.map(({ id, role }) => ({ id, role })) } });
  adoptProject(project);
}
function changeStep(step) {
  if (!['intake', 'compose', 'deliver'].includes(step)) return;
  state.step = step;
  document.querySelectorAll('.step-panel').forEach(node => { node.hidden = node.id !== `${step}-panel`; });
  document.querySelectorAll('.steps [data-step]').forEach(node => { const active = node.dataset.step === step; node.classList.toggle('active', active); if (active) node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current'); });
  if (state.project) writeLocal('step.' + state.project.id, step);
}
function renderPicker() {
  const picker = $('project-picker');
  picker.replaceChildren(new Option('选择项目', ''));
  for (const project of state.projects) picker.add(new Option(project.title || '未命名项目', project.id));
  picker.value = state.project?.id || '';
}
function renderAssets() {
  const assets = state.project?.assets || [];
  $('asset-count').textContent = `${assets.length} 份资料`;
  $('empty-assets').hidden = assets.length > 0;
  $('asset-list').replaceChildren();
  for (const asset of assets) {
    const card = element('article', 'asset-card');
    if (isImage(asset) && asset.status === 'ready') {
      const button = element('button', 'asset-thumb-button');
      button.type = 'button'; button.setAttribute('aria-label', `预览 ${asset.name}`);
      const image = element('img', 'asset-thumb'); image.src = assetURL(asset); image.alt = asset.name; image.loading = 'lazy';
      button.append(image); button.addEventListener('click', () => openImage(image.src, asset.name)); card.append(button);
    } else card.append(element('span', 'asset-thumb asset-filetype', (asset.name.split('.').pop() || 'FILE').toUpperCase().slice(0,5)));
    const copy = element('div', 'asset-copy');
    copy.append(element('strong', '', asset.name));
    const dimensions = asset.width && asset.height ? `${asset.width} × ${asset.height}` : '';
    let status = asset.text ? `${asset.status === 'partial' ? '已读取部分文字' : '已读取文字'} · ${asset.text.length.toLocaleString()} 字符` : dimensions ? `${dimensions} · 图像已保存` : '已保存 · 需补充内容说明';
    if (/pending|unsupported|registered|unparsed|needs|reference/i.test(asset.status || '') || /\.(pdf|pptx|dwg|dxf)$/i.test(asset.name) && !asset.text) status = '已登记 · 尚未完成内容解析';
    const statusNode = element('p', status.includes('尚未') ? 'pending' : '', status); copy.append(statusNode); card.append(copy);
    const select = element('select', 'asset-role-select'); select.setAttribute('aria-label', `${asset.name} 的用途`);
    for (const [value, label] of Object.entries(roles)) select.add(new Option(label, value));
    select.value = asset.role || 'content';
    select.addEventListener('change', () => {
      const role = select.value;
      operate('正在保存资料用途…', async () => {
        asset.role = role;
        if (role === 'logo' && isImage(asset) && !state.project.brand.logoAssetId) state.project.brand.logoAssetId = asset.id;
        if (role !== 'logo' && state.project.brand.logoAssetId === asset.id) state.project.brand.logoAssetId = null;
        markDirty(); await saveProject(); showNotice('资料用途已保存。已有页面内容不会因此自动重排；需要时回到资料生成新初稿。');
      });
    });
    card.append(select); $('asset-list').append(card);
  }
}
function renderSlides() {
  const slides = state.project?.slides || [];
  $('empty-plan').hidden = slides.length > 0;
  $('editor-workspace').hidden = !slides.length;
  $('slide-count').textContent = `${slides.length} 页`;
  $('slide-list').replaceChildren();
  slides.forEach((slide, index) => {
    const button = element('button', `page-button${index === state.selected ? ' active' : ''}`); button.type = 'button'; button.setAttribute('aria-label', `第 ${index + 1} 页：${slide.title}`); button.setAttribute('aria-pressed', String(index === state.selected));
    const mini = element('span', 'page-mini');
    const asset = state.project.assets.find(value => (slide.assetIds || []).includes(value.id) && isImage(value));
    if (asset) { const img = element('img'); img.src = assetURL(asset); img.alt = ''; img.loading = 'lazy'; mini.append(img); } else mini.classList.add('no-image');
    mini.append(element('span', '', slide.title || '未命名页面')); button.append(mini, element('span', '', `${String(index + 1).padStart(2, '0')}  ${slide.title || '未命名页面'}`));
    button.addEventListener('click', () => { state.selected = index; renderSlides(); }); $('slide-list').append(button);
  });
  renderEditor();
}
function renderEditor() {
  const slide = currentSlide();
  if (!slide) return;
  $('slide-title').value = slide.title || '';
  $('slide-body').value = bodyText(slide.body);
  $('slide-caption').value = slide.caption || '';
  $('slide-kind').value = kinds[slide.kind] ? slide.kind : 'split';
  $('page-label').textContent = `${String(state.selected + 1).padStart(2, '0')} / ${kinds[slide.kind] || '页面'}`;
  $('page-reason').replaceChildren(element('strong', '', '初稿编排依据'), document.createTextNode(slide.designReason || '根据这一页的表达任务调整图文关系，导出后继续检查实际版面。'));
  $('slide-images').replaceChildren();
  const images = state.project.assets.filter(asset => isImage(asset) && asset.role !== 'logo' && asset.id !== state.project.brand.logoAssetId && asset.status === 'ready');
  const maxImages = slide.kind === 'text' ? 0 : slide.kind === 'gallery' ? 3 : 1;
  $('image-choice-note').textContent = maxImages === 0 ? '文字页不放图片；需要图文同页时请选择图文并置' : maxImages === 1 ? '选择 1 张主图；选择新图会替换当前图' : '最多 3 张图片，保留清楚的图幅';
  if (maxImages === 0) { renderBrand(); renderPreview(); return; }
  if (!images.length) $('slide-images').append(element('p', 'small-note', '还没有可用的项目图片。可回到资料继续上传。'));
  for (const asset of images) {
    const label = element('label', 'image-choice'); const input = element('input'); input.type = 'checkbox'; input.checked = (slide.assetIds || []).includes(asset.id); input.setAttribute('aria-label', `使用图片 ${asset.name}`);
    const img = element('img'); img.src = assetURL(asset); img.alt = ''; img.loading = 'lazy';
    label.append(input, img, element('span', '', asset.role === 'reference' ? `参考：${asset.name}` : asset.name));
    input.addEventListener('change', () => {
      let ids = new Set(slide.assetIds || []);
      if (input.checked) {
        if (maxImages === 1) ids = new Set([asset.id]);
        else if (ids.size >= maxImages) { input.checked = false; showNotice('图片组最多放 3 张图。请先取消一张，或把更多图片安排在其他页面。', 'error'); return; }
        else ids.add(asset.id);
      } else ids.delete(asset.id);
      slide.assetIds = [...ids]; markDirty(); renderEditor();
    });
    $('slide-images').append(label);
  }
  renderBrand(); renderPreview();
}
function renderBrand() {
  const logo = $('brand-logo'); logo.replaceChildren(new Option('不添加 Logo', ''));
  for (const asset of state.project.assets.filter(asset => isImage(asset) && asset.status === 'ready')) logo.add(new Option(`${asset.role === 'logo' ? 'Logo · ' : ''}${asset.name}`, asset.id));
  logo.value = state.project.brand.logoAssetId || '';
  const accent = /^#[0-9a-f]{6}$/i.test(state.project.brand.accent || '') ? state.project.brand.accent : '#333333';
  $('brand-accent').value = accent; $('accent-value').textContent = accent.toUpperCase();
}
function renderPreview() {
  const slide = currentSlide(); if (!slide) return;
  const preview = $('slide-preview'); preview.replaceChildren();
  preview.style.setProperty('--accent', /^#[0-9a-f]{6}$/i.test(state.project.brand.accent || '') ? state.project.brand.accent : '#333333');
  const page = element('article', 'preview-page kind-' + (kinds[slide.kind] ? slide.kind : 'split'));
  const header = element('div', 'preview-header'); header.append(element('span', 'preview-number', String(state.selected + 1).padStart(2, '0')));
  const logo = state.project.assets.find(asset => asset.id === state.project.brand.logoAssetId && isImage(asset));
  if (logo) { const image = element('img', 'preview-logo'); image.src = assetURL(logo); image.alt = '项目 Logo'; header.append(image); }
  const content = element('div', 'preview-content');
  const copy = element('p', 'preview-copy', bodyText(slide.body)); content.append(copy);
  const images = (slide.assetIds || []).map(id => state.project.assets.find(asset => asset.id === id && id !== state.project.brand.logoAssetId && isImage(asset))).filter(Boolean);
  if (slide.kind !== 'text') {
    const media = element('div', 'preview-media' + (images.length <= 1 ? ' single' : ''));
    if (!images.length) media.append(element('span', 'no-image-note', '在下方选择本页图片'));
    for (const asset of images.slice(0,4)) { const image = element('img'); image.src = assetURL(asset); image.alt = asset.name; media.append(image); }
    content.append(media);
  }
  page.append(header, element('h2', 'preview-title', slide.title || '未命名页面'), content, element('p', 'preview-caption', slide.caption || ''));
  preview.append(page);
}
function safeExportURL(value) {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value, location.origin); const base = `/api/projects/${encodeURIComponent(state.project.id)}/exports/`; return url.origin === location.origin && url.pathname.startsWith(base) ? url.href : null; } catch { return null; }
}
function renderExports() {
  const results = state.exports;
  const files = Array.isArray(results?.files) ? results.files : [];
  $('export-results').hidden = !files.length || state.dirty;
  $('export-files').replaceChildren(); $('rendered-pages').replaceChildren();
  if (!files.length || state.dirty) return;
  $('export-version').textContent = `版本 ${results.revision ?? state.project.revision}`;
  for (const file of files) {
    const url = safeExportURL(file.url); if (!url) continue;
    const link = element('a', 'button', `${formats[file.format] || file.format || '文件'} · ${file.name || '下载'}`); link.href = url; link.target = '_blank'; link.rel = 'noopener'; if (file.format !== 'web') link.download = file.name || ''; $('export-files').append(link);
  }
  for (const [index, slide] of (results.slides || []).entries()) {
    const card = element('article', 'rendered-page');
    const preview = safeExportURL(slide.url || slide.preview);
    if (preview && /\.(png|jpe?g|webp|svg)(?:\?|$)/i.test(preview)) {
      const button = element('button', 'asset-thumb-button'); button.type = 'button'; button.setAttribute('aria-label', `查看第 ${index + 1} 页实际渲染`);
      const image = element('img'); image.src = preview; image.alt = `第 ${index + 1} 页导出预览`; image.loading = 'lazy'; button.append(image); button.addEventListener('click', () => openImage(preview, `第 ${index + 1} 页 · 导出预览`)); card.append(button);
    } else if (preview) { const link = element('a', '', `查看第 ${index + 1} 页`); link.href = preview; link.target = '_blank'; link.rel = 'noopener'; card.append(link); }
    card.append(element('p', '', `${String(index + 1).padStart(2, '0')} · ${state.project.slides[index]?.title || slide.id || '页面'}`)); $('rendered-pages').append(card);
  }
}
function renderLimitations() {
  const assetWarnings = (state.project?.assets || []).flatMap(asset => (asset.warnings || []).map(warning => `${asset.name}：${typeof warning === 'string' ? warning : warning.message || JSON.stringify(warning)}`));
  const limitations = [...(state.project?.limitations || []), ...assetWarnings, ...(state.exports?.warnings || [])].map(value => typeof value === 'string' ? value : value.message || value.reason || JSON.stringify(value));
  const unique = [...new Set(limitations)]; $('limitations-wrap').hidden = !unique.length; $('limitations-count').textContent = `(${unique.length})`; $('limitations-list').replaceChildren(...unique.map(text => element('li', '', text)));
}
function renderAll() {
  renderPicker();
  const values = state.project || readLocal('intake') || {};
  $('project-title').value = values.title === '未命名项目' ? '' : values.title || '';
  $('project-brief').value = values.brief || ''; $('project-audience').value = values.audience || '';
  renderAssets(); renderSlides(); updateSaveState(); renderExports(); renderLimitations(); changeStep(state.step); setBusy(state.busy);
}
function openImage(url, name) { $('full-image').src = url; $('full-image').alt = name; $('full-image-label').textContent = name; $('image-dialog').showModal(); }
function fileBase64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error(`无法读取文件：${file.name}`)); reader.readAsDataURL(file); }); }
async function uploadFiles(fileList) {
  const files = [...fileList]; if (!files.length) return;
  const role = $('upload-role').value;
  await operate(`准备上传 ${files.length} 份资料…`, async () => {
    const issues = []; let uploaded = 0;
    await ensureProject(); await saveProject();
    for (const [index, file] of files.entries()) {
      if (!extensions.has(file.name.split('.').pop().toLowerCase())) { issues.push(`${file.name}：暂不支持此文件类型`); continue; }
      if (file.size > 64 * 1024 * 1024) { issues.push(`${file.name}：超过 64 MB`); continue; }
      if (state.project.assets.length >= 40) { issues.push('项目最多保存 40 份资料，其余文件未上传'); break; }
      showNotice(`正在上传 ${index + 1} / ${files.length}：${file.name}`, 'busy');
      try {
        const base64 = await fileBase64(file);
        const project = await api(`/api/projects/${encodeURIComponent(state.project.id)}/assets`, { method: 'POST', body: { name: file.name, base64, role } });
        adoptProject(project); uploaded++;
      } catch (error) { issues.push(`${file.name}：${describeError(error)}`); if (error.status === 401 || error.status === 403 || error.status === 409 || error.name === 'TypeError') break; }
    }
    showNotice(`已保存 ${uploaded} 份资料。${issues.length ? '\n' + issues.join('\n') : '补充用途说明后，即可生成编排初稿。'}`, issues.length ? 'error' : '');
    $('file-input').value = '';
  });
}

document.querySelectorAll('[data-step]').forEach(button => button.addEventListener('click', () => { if (!state.busy) changeStep(button.dataset.step); }));
$('file-input').addEventListener('change', event => uploadFiles(event.target.files));
$('drop-zone').addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && !state.busy && state.connected) { event.preventDefault(); $('file-input').click(); } });
$('drop-zone').addEventListener('click', event => { if (state.busy || !state.connected) event.preventDefault(); });
for (const name of ['dragenter', 'dragover']) $('drop-zone').addEventListener(name, event => { event.preventDefault(); if (!state.busy) $('drop-zone').classList.add('dragging'); });
for (const name of ['dragleave', 'drop']) $('drop-zone').addEventListener(name, event => { event.preventDefault(); $('drop-zone').classList.remove('dragging'); });
$('drop-zone').addEventListener('drop', event => { if (!state.busy && state.connected) uploadFiles(event.dataTransfer.files); });
for (const [id, field] of [['project-title', 'title'], ['project-brief', 'brief'], ['project-audience', 'audience']]) $(id).addEventListener('input', () => {
  if (state.project) { state.project[field] = $(id).value; markDirty(); } else persistDraft();
});
$('generate-plan').addEventListener('click', () => operate('正在整理资料并生成编排初稿…', async () => {
  const values = intakeValues();
  if (!(state.project?.assets?.length)) throw new Error('请先上传至少一份图片或可读取文档，再生成编排初稿。“用途与内容”帮助确定表达方向，目前不会独立生成页面。');
  if (state.project?.slides?.length && !window.confirm('重新生成初稿会替换当前页面编排。资料会保留，是否继续？')) { showNotice('保留了当前编排。'); return; }
  await ensureProject(); await saveProject();
  const project = await api(`/api/projects/${encodeURIComponent(state.project.id)}/plan`, { method: 'POST', body: values });
  state.selected = 0; adoptProject(project);
  if (!project.slides.length) { changeStep('intake'); showNotice('资料已保存，但尚无可用于编排的图片或正文。请查看下方“资料与能力说明”，再补充可用图片或可读取文档。', 'error'); return; }
  changeStep('compose'); showNotice(`编排初稿已生成，共 ${project.slides.length} 页。请核对内容，再逐页调整标题、正文与版式。`);
}));
$('save-project').addEventListener('click', () => operate('正在保存修改…', async () => { await saveProject(); showNotice('修改已保存。'); }));
$('go-deliver').addEventListener('click', () => operate('正在保存并准备制作…', async () => { await saveProject(); changeStep('deliver'); showNotice('选择所需格式，制作当前内容的交付文件。'); }));
for (const [id, field] of [['slide-title', 'title'], ['slide-body', 'body'], ['slide-caption', 'caption']]) $(id).addEventListener('input', () => { const slide = currentSlide(); if (!slide) return; slide[field] = $(id).value; markDirty(); renderPreview(); });
$('slide-kind').addEventListener('change', () => {
  const slide = currentSlide(); if (!slide) return; slide.kind = $('slide-kind').value;
  const maxImages = slide.kind === 'text' ? 0 : slide.kind === 'gallery' ? 3 : 1;
  if ((slide.assetIds || []).length > maxImages) { slide.assetIds = slide.assetIds.slice(0, maxImages); showNotice(maxImages ? '新版式已保留首张主图。其他图片仍在资料库，可随时替换或用于别页。' : '已改为文字页，图片仍在资料库。需要图文同页时，可改回图文并置并选择图片。'); }
  markDirty(); renderSlides();
});
$('brand-logo').addEventListener('change', () => { state.project.brand.logoAssetId = $('brand-logo').value || null; markDirty(); renderEditor(); });
$('brand-accent').addEventListener('input', () => { state.project.brand.accent = $('brand-accent').value; $('accent-value').textContent = $('brand-accent').value.toUpperCase(); markDirty(); renderPreview(); });
$('export-project').addEventListener('click', () => operate('正在制作文件，请保留本地服务运行…', async () => {
  const requestedFormats = [...document.querySelectorAll('input[name=format]:checked')].map(input => input.value);
  if (!requestedFormats.length) throw new Error('请至少选择一种输出格式。');
  await saveProject();
  const result = await api(`/api/projects/${encodeURIComponent(state.project.id)}/export`, { method: 'POST', body: { formats: requestedFormats, expectedRevision: state.project.revision } });
  state.exports = result; state.project.exports = result; renderExports(); renderLimitations();
  showNotice(`制作完成，已生成 ${result.files?.length || 0} 个文件。请查看实际预览，并核对文字、图纸与品牌。${result.warnings?.length ? ' 下方“资料与能力说明”记录了本次限制。' : ''}`);
}));
$('project-picker').addEventListener('change', () => {
  const id = $('project-picker').value;
  if (!id || id === state.project?.id) { renderPicker(); return; }
  operate('正在打开项目…', async () => {
    await saveProject(); const project = await api(`/api/projects/${encodeURIComponent(id)}`); state.selected = 0; state.step = readLocal('step.' + id) || 'intake'; adoptProject(project, { clearDraft: false }); restoreDraft(project); renderAll(); if (!state.dirty && !state.conflict) showNotice('项目已打开，可继续上次工作。');
  }).finally(renderPicker);
});
$('new-project').addEventListener('click', () => operate('正在准备新项目…', async () => {
  await saveProject(); state.project = null; state.selected = 0; state.dirty = false; state.conflict = false; state.exports = null; state.step = 'intake'; clearLocal('lastProject'); clearLocal('intake'); $('conflict-actions').hidden = true; renderAll(); showNotice('新项目已准备好。先上传图片或文档，再填写用途说明。'); $('project-title').focus();
}));
$('reload-project').addEventListener('click', () => operate('正在重新载入项目…', async () => {
  if (!state.project) return;
  if (!window.confirm('将载入服务器已保存的项目并清除当前待保存草稿。需要保留修改时，请先取消并下载备份。')) { showNotice('保留了当前草稿。'); return; }
  const project = await api(`/api/projects/${encodeURIComponent(state.project.id)}`); adoptProject(project); showNotice('已载入最新保存版本。');
}));
$('download-draft').addEventListener('click', () => {
  if (!state.project) return;
  const draft = readLocal(`draft.${state.project.id}`) || state.project;
  const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' })); const link = element('a'); link.href = url; link.download = 'Panda-未保存修改备份.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('limitations-toggle').addEventListener('click', () => { const expanded = $('limitations-toggle').getAttribute('aria-expanded') === 'true'; $('limitations-toggle').setAttribute('aria-expanded', String(!expanded)); $('limitations-list').hidden = expanded; });
$('close-image').addEventListener('click', () => $('image-dialog').close());
$('image-dialog').addEventListener('click', event => { if (event.target === $('image-dialog')) { const rect = $('image-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('image-dialog').close(); } });
window.addEventListener('beforeunload', event => { if (state.busy) { event.preventDefault(); event.returnValue = ''; } });

async function initialize() {
  setBusy(true); renderAll();
  try {
    const session = await api('/api/session'); state.token = session.token; state.connected = true;
    const result = await api('/api/projects'); state.projects = result.projects || [];
    $('connection').textContent = '本地服务已连接'; $('connection').classList.add('ready');
    const lastId = readLocal('lastProject');
    if (lastId && state.projects.some(project => project.id === lastId)) {
      const project = await api(`/api/projects/${encodeURIComponent(lastId)}`); state.step = readLocal('step.' + lastId) || (project.slides.length ? 'compose' : 'intake'); adoptProject(project, { clearDraft: false }); restoreDraft(project);
    }
    renderAll();
  } catch (error) { $('connection').textContent = '本地服务未连接'; showNotice(describeError(error), 'error'); }
  finally { setBusy(false); }
}
initialize();
