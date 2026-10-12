import { mapResearchCard, selectReferenceCandidates } from '../core/index.mjs';
import { estimatedLineCount } from '../renderers/layout.mjs';

export const PLAN_LIMITS = Object.freeze({ imageAssets: 40, textSlides: 60, textCharactersPerSlide: 420 });
// Match the actual renderer's frames, using its default readable sizes rather than relying on shrink-to-fit.
const TEXT_BODY = Object.freeze({ width: 980, height: 274, fontSize: 28 });
const LABEL_FRAMES = {
  cover: { title: [568, 232, 60], caption: [520, 25, 18] },
  split: { title: [420, 178, 46], caption: [660, 34, 18] },
  hero: { title: [1152, 66, 44], caption: [1120, 64, 23] },
  plan: { title: [1140, 82, 44], caption: [254, 92, 18] },
  gallery: { title: [1152, 82, 44], caption: [1152, 36, 18] },
  text: { title: [1072, 160, 56], caption: [980, 34, 18] },
};
const TASK_TAGS = {
  cover: ['封面', '摄影留白', '文字层级'],
  hero: ['图像优先', '空间完整', '少文字空间页'],
  split: ['图文主次', '纸面留白', '非对称平衡'],
  gallery: ['图注对应', '图文主次', '主副图'],
  text: ['内容结构', '文字层级', '低干扰说明'],
  plan: ['平面总览', '几何保护', '技术图保护'],
};

function titleOf(asset) { return String(asset.title || asset.name || '未命名资料').replace(/\.[a-z0-9]{1,8}$/i, ''); }
function shapeOf(asset) { const ratio = asset.width / asset.height; return ratio > 1.25 ? 'landscape' : ratio < 0.8 ? 'portrait' : 'square'; }
function fits(value, width, height, size) { return estimatedLineCount(String(value).trim(), width, size) * size * 1.38 <= height; }

function fitLabel(value, kind, field) {
  const compact = String(value).replace(/\s+/g, ' ').trim();
  const [width, height, size] = LABEL_FRAMES[kind][field];
  if (!compact || fits(compact, width, height, size)) return compact;
  const characters = [...compact];
  let low = 0, high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(characters.slice(0, middle).join('') + '…', width, height, size)) low = middle;
    else high = middle - 1;
  }
  return characters.slice(0, low).join('') + '…';
}

/** Preserve complete source text in the asset. Splitting here only shapes its page-level reading rhythm. */
function paginate(text) {
  const characters = [...String(text).replace(/\r\n?/g, '\n').trim()];
  const pages = [];
  let offset = 0;
  while (offset < characters.length) {
    // Blank source whitespace is preserved in the original asset; it should not create an empty page.
    while (offset < characters.length && /\s/u.test(characters[offset])) offset += 1;
    if (offset >= characters.length) break;
    let low = 1, high = Math.min(PLAN_LIMITS.textCharactersPerSlide, characters.length - offset);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const content = characters.slice(offset, offset + middle).join('');
      if (fits(content, TEXT_BODY.width, TEXT_BODY.height, TEXT_BODY.fontSize)) low = middle;
      else high = middle - 1;
    }
    let cut = low;
    // Prefer the latest paragraph, line or sentence boundary if it leaves a substantial page.
    if (offset + cut < characters.length) {
      for (let index = cut - 1; index >= Math.floor(cut * 0.55); index -= 1) {
        if (/[。；!?！？\n]/u.test(characters[offset + index]) || (characters[offset + index] === '.' && characters[offset + index + 1] === ' ')) { cut = index + 1; break; }
      }
    }
    const page = characters.slice(offset, offset + cut).join('').trim();
    if (page) pages.push(page);
    offset += cut;
  }
  return pages;
}

/** This is an explainable rules draft. It never claims to recognize image semantics or render a fixed template. */
export function createPlan(project, { cards = [] } = {}) {
  if (!project || !Array.isArray(project.assets)) throw new TypeError('project.assets must be an array');
  const slides = [];
  const limitations = ['当前为本地规则初稿，未调用视觉或语言模型。图像只依据尺寸与用户指定用途编排；图片语义、标题和项目事实需要确认。'];
  const assets = project.assets;
  const cardData = Array.isArray(cards) ? cards : cards?.cards || [];
  const mapped = [];
  for (const card of cardData) {
    try { mapped.push(mapResearchCard(card, { scope: { kind: 'public' } })); } catch { limitations.push(`设计卡 ${card?.id || '未知'} 格式不完整，未参与候选。`); }
  }
  const used = new Set();
  function page(kind, title, body, pageAssets, reason, caption = '') {
    const id = `slide-${String(slides.length + 1).padStart(3, '0')}`;
    const displayTitle = fitLabel(title, kind, 'title');
    const displayCaption = fitLabel(caption, kind, 'caption');
    if (displayTitle.endsWith('…') && displayTitle !== title) limitations.push(`${id}：显示标题按版面容量缩略，完整项目名或资料名仍保存在项目和资料中。`);
    if (displayCaption.endsWith('…') && displayCaption !== caption) limitations.push(`${id}：显示图注按版面容量缩略，完整资料名仍保存在资料中。`);
    const references = selectReferenceCandidates({ page_task: { project_id: project.id || 'local-project', page_task_id: id, medium: 'ppt', text_density: body.length > 260 ? 'high' : body ? 'medium' : 'low', task_tags: TASK_TAGS[kind], image_shapes: [...new Set(pageAssets.filter(a => a.kind === 'image').map(shapeOf))], locked_elements: [], require_editable: true }, cards: mapped, limit: 2 });
    pageAssets.forEach(asset => used.add(asset.id));
    slides.push({ id, kind, title: displayTitle, body, assetIds: pageAssets.filter(a => a.kind === 'image').map(a => a.id), caption: displayCaption, sourceIds: pageAssets.map(a => a.id), referenceIds: references.candidates.map(c => c.card_id), designReason: reason + (references.candidates.length ? `；参考方法：${references.candidates.map(c => `${c.card_id}（${c.reasons[0]}）`).join('、')}。仅借鉴设计逻辑，未复制案例素材。` : '；暂无匹配的设计研究卡，需人工复核。'), imageFit: 'contain' });
  }
  const eligible = assets.filter(a => a.role !== 'logo' && a.role !== 'reference');
  const imagesAll = eligible.filter(a => a.kind === 'image' && a.status === 'ready' && a.width > 0 && a.height > 0);
  const images = imagesAll.slice(0, PLAN_LIMITS.imageAssets);
  if (imagesAll.length > images.length) limitations.push(`本次图像试排上限为 ${PLAN_LIMITS.imageAssets} 张；还有 ${imagesAll.length - images.length} 张图片未排版，原件保留。`);
  const photos = images.filter(a => a.role !== 'plan');
  const projectTitle = String(project.title || project.name || '').trim();
  const hasProjectTitle = projectTitle && !['未命名项目', '新项目', '我的项目'].includes(projectTitle);
  if (hasProjectTitle && photos.length >= 2) {
    const cover = photos[0];
    page('cover', projectTitle, '', [cover], '项目已有标题且有多张图片，采用独立标题区与完整主图建立开场；标题来自用户输入', titleOf(cover));
  }
  for (let index = 0; index < images.length; index += 1) {
    const asset = images[index];
    if (used.has(asset.id)) continue;
    if (asset.role === 'plan') { page('plan', titleOf(asset), '', [asset], '用户指定为图纸；保留完整边界、等比缩放和独立图注，禁止装饰裁切与变形；标注可读性仍需逐页检查', '图纸按原图展示；未核验尺寸、比例与专业标注。'); continue; }
    const next = images[index + 1];
    if (shapeOf(asset) === 'portrait' && next && next.role !== 'plan' && shapeOf(next) === 'portrait' && !used.has(next.id)) {
      page('gallery', '图像选辑', '', [asset, next], '两张相邻竖幅采用并列完整图幅与各自图注；并列只代表上传顺序，不预设空间或方案关系', `${titleOf(asset)} / ${titleOf(next)}`);
      index += 1;
    } else if (asset.width / asset.height >= 1.45) page('hero', titleOf(asset), '', [asset], '横幅图片采用单张完整主图和独立标题，避免裁掉两端信息；不从画面推测空间用途', titleOf(asset));
    else page('split', titleOf(asset), '', [asset], '中性比例或竖幅保留完整图像，标题与图注放在独立文字区，以留白控制层级', titleOf(asset));
  }
  let textPageCount = 0;
  for (const asset of eligible.filter(a => a.role !== 'plan' && (a.kind === 'text' || a.kind === 'document'))) {
    if (!asset.text || !['ready', 'partial'].includes(asset.status)) continue;
    const chunks = paginate(asset.text);
    const remaining = Math.max(0, PLAN_LIMITS.textSlides - textPageCount);
    const selected = chunks.slice(0, remaining);
    for (const [index, chunk] of selected.entries()) page('text', `${chunks.length > 1 ? `${index + 1}/${chunks.length} · ` : ''}${titleOf(asset)}`, chunk, [asset], '按原文顺序和实际正文框的行容量分页，优先在段落或句末续页；保留默认可读字号，正文未改写或补充事实', asset.readScope?.complete === false ? '该资料只完成部分读取，详见资料解析范围。' : '原始文字摘入；请确认段落顺序与表格关系。');
    textPageCount += selected.length;
    if (selected.length < chunks.length) limitations.push(`${asset.name}：需要 ${chunks.length} 个文字页，本次生成 ${selected.length} 页；达到总计 ${PLAN_LIMITS.textSlides} 个文字页上限，剩余原文保留在资料中。`);
    if (asset.status === 'partial') limitations.push(`${asset.name}：资料仅部分解析，当前排版不代表已读取完整文档。`);
  }
  for (const asset of assets) {
    if (asset.role === 'logo') {
      if (!(asset.kind === 'image' && asset.status === 'ready')) limitations.push(`${asset.name}：Logo 尚不能安全显示，未应用到页面。`);
      continue;
    }
    if (asset.role === 'reference') { limitations.push(`${asset.name}：作为参考保留，未作为内容素材使用；固定版面的锁定区域需要人工确认。`); continue; }
    if (asset.role === 'plan' && asset.kind !== 'image') limitations.push(`${asset.name}：用户指定为图纸，但当前没有可用的图纸渲染图；保留原件与已提取文字，不能用文字页替代完整图纸。请提供 PNG/JPEG/WebP 图纸预览。`);
    if (!used.has(asset.id)) limitations.push(`${asset.name}：尚未进入页面（${asset.status === 'ready' ? '超出本次范围或没有可编排正文' : '未完成可用内容解析'}）；原件保留。`);
    for (const warning of asset.warnings || []) limitations.push(`${asset.name}：${warning}`);
  }
  if (!slides.length) limitations.push('没有可用于排版的已解析内容；请添加 PNG/JPEG/WEBP 图片或可读取的文字资料。');
  return { slides, limitations: [...new Set(limitations)] };
}
