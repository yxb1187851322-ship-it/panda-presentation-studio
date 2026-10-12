export const CANVAS = Object.freeze({ width: 1280, height: 720 });
const BG = '#F5F4F0';
const INK = '#28332E';
const MUTED = '#606A64';

const asText = value => Array.isArray(value) ? value.join('\n') : String(value ?? '');
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
const closing = new Set([... '、。，．？！：；％‰）］｝〉》」』】〙〗〟’”»…,.!?;:%)]}']);
const opening = new Set([... '（［｛〈《「『【〘〖〝‘“«([{']);
const wordPart = value => /^[\p{Script=Latin}\p{N}\p{M}_]+$/u.test(value ?? '');
const wordJoin = value => /^['’\-]$/.test(value ?? '');
const weight = char => {
  if (/^[\u2E80-\uFFFF]/u.test(char) || /\p{Extended_Pictographic}/u.test(char)) return 1.06;
  if (/^\s$/u.test(char)) return 0.38;
  if (/^[ilI1!.,:;'|]$/.test(char)) return 0.34;
  if (/^[mMwW@#]$/.test(char)) return 1;
  if (/^[A-Z]$/.test(char)) return 0.8;
  return 0.66;
};
const canBreak = (chars, index) => {
  const left = chars[index - 1];
  const right = chars[index];
  let previousVisible = index - 1;
  let nextVisible = index;
  while (previousVisible >= 0 && /^\s$/u.test(chars[previousVisible])) previousVisible--;
  while (nextVisible < chars.length && /^\s$/u.test(chars[nextVisible])) nextVisible++;
  if (closing.has(chars[nextVisible]) || opening.has(chars[previousVisible])) return false;
  if (wordPart(left) && wordPart(right)) return false;
  if (wordPart(left) && wordJoin(right) && wordPart(chars[index + 1])) return false;
  if (wordJoin(left) && wordPart(right) && wordPart(chars[index - 2])) return false;
  return true;
};

/** Insert only line breaks. Conservative widths leave room for font shaping. */
export function wrapSlideText(value, width, fontSize) {
  if (!(width > 0) || !(fontSize > 0)) throw new RangeError('文字宽度和字号必须为正数。');
  const budget = (width - 2) / fontSize;
  return asText(value).split('\n').map(paragraph => {
    const chars = [...segmenter.segment(paragraph)].map(part => part.segment);
    if (!chars.length) return '';
    const lines = [];
    let start = 0;
    while (start < chars.length) {
      let end = start;
      let used = 0;
      while (end < chars.length && used + weight(chars[end]) <= budget) used += weight(chars[end++]);
      if (end === chars.length) { lines.push(chars.slice(start).join('')); break; }
      while (end > start && !canBreak(chars, end)) end--;
      if (end === start) throw Object.assign(new Error('文字包含超出栏宽的不可拆分词组，请缩短或调整版式。'), { code: 'TEXT_TOKEN_TOO_LONG', status: 422 });
      lines.push(chars.slice(start, end).join(''));
      start = end;
    }
    return lines.join('\n');
  }).join('\n');
}

export function estimatedLineCount(value, width, fontSize) {
  return wrapSlideText(value, width, fontSize).split('\n').length;
}

function text(name, value, box, size, options = {}) {
  const content = asText(value);
  if (!content.trim()) return null;
  const min = options.min ?? size;
  let selected = size;
  let wrapped;
  let fits = false;
  for (; selected >= min; selected--) {
    try {
      wrapped = wrapSlideText(content, box.width, selected);
      if (wrapped.split('\n').length * selected * 1.38 <= box.height) { fits = true; break; }
    } catch (error) { if (error.code !== 'TEXT_TOKEN_TOO_LONG') throw error; }
  }
  if (!fits) {
    throw Object.assign(new Error(`页面的${name === 'title' ? '标题' : name === 'caption' ? '图注' : '正文'}过长，请拆页或缩短后再导出。`), { code: 'TEXT_OVERFLOW', field: name, status: 422 });
  }
  return { type: 'text', name, text: wrapped, ...box, fontSize: selected, color: options.color ?? INK, bold: options.bold ?? false };
}

function photo(asset, box, forceContain = true) {
  const ratio = asset.width / asset.height;
  const frame = box.width / box.height;
  const retained = Math.min(ratio / frame, frame / ratio);
  const fit = forceContain || ['plan', 'logo', 'drawing', 'floorplan'].includes(asset.role) || retained < 0.88 ? 'contain' : 'cover';
  return { type: 'image', name: `image-${asset.id}`, assetId: asset.id, alt: asset.name ?? '项目图片', ...box, fit };
}

export function buildSlideLayout(slide, index, project, images) {
  const selected = (slide.assetIds ?? []).filter(id => id !== project.brand?.logoAssetId).map(id => images.get(id)).filter(Boolean);
  const image = (asset, box) => photo(asset, box, slide.imageFit !== 'cover');
  const accent = /^#[0-9a-f]{6}$/i.test(project.brand?.accent ?? '') ? project.brand.accent : '#53695D';
  const elements = [];
  const add = (...items) => elements.push(...items.filter(Boolean));
  const title = slide.title || project.title || '项目方案';
  const body = asText(slide.body);
  const caption = asText(slide.caption);
  let kind = slide.kind ?? 'text';
  if (['cover', 'hero', 'split', 'plan'].includes(kind) && selected.length > 1) throw Object.assign(new Error('该版式只放一张主图，请改为对照页或拆页。'), { code: 'TOO_MANY_IMAGES', status: 422 });
  if (['cover', 'hero', 'split', 'gallery', 'plan'].includes(kind) && selected.length === 0) kind = 'text';
  if (kind === 'cover') {
    add(image(selected[0], { left: 696, top: 72, width: 520, height: 560 }));
    add(text('title', title, { left: 64, top: 184, width: 568, height: 232 }, 60, { min: 48 }));
    add(text('body', body, { left: 68, top: 454, width: 526, height: 150 }, 26, { min: 24, color: MUTED }));
    add(text('caption', caption, { left: 696, top: 642, width: 520, height: 25 }, 18, { color: MUTED }));
  } else if (kind === 'split') {
    add(text('title', title, { left: 64, top: 128, width: 420, height: 178 }, 46, { min: 40 }));
    add(text('body', body, { left: 68, top: 348, width: 400, height: 250 }, 26, { min: 24, color: MUTED }));
    add(image(selected[0], { left: 548, top: 72, width: 668, height: 526 }));
    add(text('caption', caption, { left: 550, top: 614, width: 660, height: 34 }, 18, { color: MUTED }));
  } else if (kind === 'hero') {
    add(text('title', title, { left: 64, top: 40, width: 1152, height: 66 }, 44, { min: 40 }));
    add(image(selected[0], { left: 64, top: 124, width: 1152, height: 470 }));
    add(text('body', [body, caption].filter(Boolean).join('\n'), { left: 64, top: 602, width: 1120, height: 64 }, 23, { min: 23, color: MUTED }));
  } else if (kind === 'plan') {
    add(text('title', title, { left: 64, top: 48, width: 1140, height: 82 }, 44, { min: 40 }));
    add(photo(selected[0], { left: 64, top: 158, width: 850, height: 472 }, true));
    add(text('body', body, { left: 962, top: 182, width: 254, height: 326 }, 24, { min: 23, color: MUTED }));
    add(text('caption', caption, { left: 962, top: 534, width: 254, height: 92 }, 18, { color: MUTED }));
  } else if (kind === 'gallery') {
    if (selected.length > 3) throw Object.assign(new Error('对照页最多放 3 张图片，请拆页以保留可读尺寸。'), { code: 'TOO_MANY_IMAGES', status: 422 });
    add(text('title', title, { left: 64, top: 48, width: 1152, height: 82 }, 44, { min: 40 }));
    add(text('body', body, { left: 64, top: 138, width: 1152, height: 64 }, 24, { min: 23, color: MUTED }));
    const gap = 28;
    const width = (1152 - gap * (selected.length - 1)) / selected.length;
    selected.forEach((asset, i) => add(image(asset, { left: 64 + i * (width + gap), top: 238, width, height: 354 })));
    add(text('caption', caption, { left: 64, top: 615, width: 1152, height: 36 }, 18, { color: MUTED }));
  } else {
    kind = 'text';
    add(text('title', title, { left: 104, top: 130, width: 1072, height: 160 }, 56, { min: 44 }));
    add(text('body', body, { left: 108, top: 340, width: 980, height: 274 }, 28, { min: 24, color: MUTED }));
    add(text('caption', caption, { left: 108, top: 620, width: 980, height: 34 }, 18, { color: MUTED }));
  }
  const logo = images.get(project.brand?.logoAssetId);
  if (logo) add(photo(logo, { left: 64, top: 668, width: 132, height: 28 }, true));
  add(text('page-number', String(index + 1).padStart(2, '0'), { left: 1164, top: 667, width: 52, height: 28 }, 16, { color: accent }));
  return { id: slide.id, kind, background: BG, fontFamily: project.brand?.fontFamily || 'Microsoft YaHei', elements };
}
