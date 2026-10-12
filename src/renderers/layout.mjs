export const CANVAS = Object.freeze({ width: 1280, height: 720 });
const BG = '#FFFFFF';
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

/** Measure the visible bitmap, not the larger contain frame around it. */
function naturalPhoto(asset, bounds, { horizontal = 0.5, vertical = 0.5 } = {}) {
  const scale = Math.min(bounds.width / asset.width, bounds.height / asset.height);
  const width = asset.width * scale;
  const height = asset.height * scale;
  return photo(asset, { left: bounds.left + (bounds.width - width) * horizontal, top: bounds.top + (bounds.height - height) * vertical, width, height }, true);
}

function textHeight(value, width, size) {
  return asText(value).trim() ? estimatedLineCount(value, width, size) * size * 1.38 : 0;
}

/** A compact annotation column. Content that does not fit must be edited or split. */
function sideNote(title, body, caption, box, { titleSize = 30, bodySize = 20, captionSize = 16 } = {}) {
  const items = [];
  let top = box.top;
  for (const [name, value, size, gap] of [['title', title, titleSize, 0], ['body', body, bodySize, 24], ['caption', caption, captionSize, 22]]) {
    if (!asText(value).trim()) continue;
    const height = textHeight(value, box.width, size);
    if (items.length) top += gap;
    if (top + height > box.top + box.height) throw Object.assign(new Error('图片页的说明过长，请缩短说明或另设正文页。'), { code: 'TEXT_OVERFLOW', field: name, status: 422 });
    items.push(text(name, value, { left: box.left, top, width: box.width, height }, size, { color: name === 'title' ? INK : MUTED }));
    top += height;
  }
  return items;
}

function widePhotoComposition(asset, title, body, caption) {
  let image = naturalPhoto(asset, { left: 32, top: 24, width: 1216, height: 592 }, { vertical: 0 });
  // The photograph's natural width also sets the annotation band's width.
  for (let iteration = 0; iteration < 8; iteration++) {
    const titleWidth = Math.min(300, image.width * 0.3);
    const detailWidth = image.width - titleWidth - 36;
    const titleHeight = textHeight(title, titleWidth, 30);
    const bodyHeight = textHeight(body, detailWidth, 18);
    const captionHeight = textHeight(caption, detailWidth, 16);
    const detailHeight = bodyHeight + (bodyHeight && captionHeight ? 8 : 0) + captionHeight;
    const height = Math.max(titleHeight, detailHeight);
    if (height > 180) throw Object.assign(new Error('主图页说明过长，请拆页后保留主图的阅读尺度。'), { code: 'TEXT_OVERFLOW', field: 'body', status: 422 });
    const next = naturalPhoto(asset, { left: 32, top: 24, width: 1216, height: 720 - 24 - 20 - height - 32 }, { vertical: 0 });
    if (Math.abs(next.width - image.width) < 0.01) break;
    image = next;
  }
  // Final measurements use the final bitmap width, including very wide panoramas.
  const titleWidth = Math.min(300, image.width * 0.3);
  const detailWidth = image.width - titleWidth - 36;
  const titleHeight = textHeight(title, titleWidth, 30);
  const bodyHeight = textHeight(body, detailWidth, 18);
  const captionHeight = textHeight(caption, detailWidth, 16);
  const noteTop = image.top + image.height + 20;
  if (noteTop + Math.max(titleHeight, bodyHeight + (bodyHeight && captionHeight ? 8 : 0) + captionHeight) > 688.01) throw Object.assign(new Error('主图页说明超出页面，请拆页。'), { code: 'TEXT_OVERFLOW', field: 'body', status: 422 });
  return [image,
    text('title', title, { left: image.left, top: noteTop, width: titleWidth, height: titleHeight }, 30),
    text('body', body, { left: image.left + titleWidth + 36, top: noteTop, width: detailWidth, height: bodyHeight }, 18, { color: MUTED }),
    text('caption', caption, { left: image.left + titleWidth + 36, top: noteTop + bodyHeight + (bodyHeight && captionHeight ? 8 : 0), width: detailWidth, height: captionHeight }, 16, { color: MUTED }),
  ].filter(Boolean);
}

function metrics(elements, project, assets, strategy) {
  const images = elements.filter(element => element.type === 'image' && element.assetId !== project.brand?.logoAssetId).map(element => {
    const asset = assets.get(element.assetId);
    const visible = element.fit === 'contain' ? naturalPhoto(asset, element) : element;
    return { assetId: element.assetId, left: visible.left, top: visible.top, width: visible.width, height: visible.height, frame: { left: element.left, top: element.top, width: element.width, height: element.height } };
  });
  return { strategy, imageAreaRatio: images.reduce((sum, element) => sum + element.width * element.height, 0) / (CANVAS.width * CANVAS.height), measurement: 'bitmap bounds; internal source whitespace is not measured; not an aesthetic score', images };
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
  let strategy = kind;
  if (['cover', 'hero', 'split', 'plan'].includes(kind) && selected.length > 1) throw Object.assign(new Error('该版式只放一张主图，请改为对照页或拆页。'), { code: 'TOO_MANY_IMAGES', status: 422 });
  if (['cover', 'hero', 'split', 'gallery', 'plan'].includes(kind) && selected.length === 0) kind = 'text';
  if (selected.length === 1 && ['plan', 'drawing', 'floorplan'].includes(selected[0].role) && kind !== 'text') kind = 'plan';
  if (kind === 'cover') {
    add(image(selected[0], { left: 696, top: 72, width: 520, height: 560 }));
    add(text('title', title, { left: 64, top: 184, width: 568, height: 232 }, 60, { min: 48 }));
    add(text('body', body, { left: 68, top: 454, width: 526, height: 150 }, 26, { min: 24, color: MUTED }));
    add(text('caption', caption, { left: 696, top: 642, width: 520, height: 25 }, 18, { color: MUTED }));
  } else if (kind === 'split' || kind === 'hero') {
    const asset = selected[0];
    const ratio = asset.width / asset.height;
    if (ratio >= 1.2 && ratio <= 1.6) {
      strategy = 'photograph-with-side-note';
      const picture = naturalPhoto(asset, { left: 248, top: 0, width: 1032, height: 720 }, { horizontal: 1 });
      add(picture, ...sideNote(title, body, caption, { left: 28, top: 72, width: Math.min(224, picture.left - 56), height: 544 }));
    } else if (ratio > 1.6) {
      strategy = 'photograph-with-bottom-note';
      add(...widePhotoComposition(asset, title, body, caption));
    } else {
      strategy = 'portrait-with-side-note';
      const picture = naturalPhoto(asset, { left: 96, top: 36, width: 700, height: 648 }, { horizontal: 0 });
      add(picture, ...sideNote(title, body, caption, { left: picture.left + picture.width + 72, top: 144, width: Math.min(336, 1216 - picture.left - picture.width - 72), height: 464 }));
    }
  } else if (kind === 'plan') {
    const asset = selected[0];
    const plateImage = naturalPhoto(asset, { left: 112, top: 16, width: 1056, height: 624 }, { vertical: 0 });
    let compactPlate = false;
    if (asset.width / asset.height < 1 && !body.trim()) {
      try { compactPlate = textHeight(title, plateImage.width, 22) <= 22 * 1.38 && textHeight(caption, plateImage.width, 14) <= 14 * 1.38; }
      catch (error) { if (error.code !== 'TEXT_TOKEN_TOO_LONG') throw error; }
    }
    if (compactPlate) {
      strategy = 'drawing-centered-plate';
      const noteTop = plateImage.top + plateImage.height + 12;
      const titleHeight = textHeight(title, plateImage.width, 22);
      add(plateImage,
        text('title', title, { left: plateImage.left, top: noteTop, width: plateImage.width, height: titleHeight }, 22),
        text('caption', caption, { left: plateImage.left, top: noteTop + titleHeight + 4, width: plateImage.width, height: textHeight(caption, plateImage.width, 14) }, 14, { color: MUTED }));
    } else if (asset.width / asset.height <= 1.25) {
      strategy = 'drawing-with-side-note';
      const picture = naturalPhoto(asset, { left: 112, top: 24, width: 752, height: 672 }, { horizontal: 0 });
      add(picture, ...sideNote(title, body, caption, { left: picture.left + picture.width + 88, top: 112, width: Math.min(320, 1216 - picture.left - picture.width - 88), height: 488 }, { titleSize: 30, bodySize: 18, captionSize: 16 }));
    } else {
      strategy = 'drawing-with-bottom-note';
      add(...widePhotoComposition(asset, title, body, caption));
    }
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
    strategy = 'text';
    add(text('title', title, { left: 104, top: 130, width: 1072, height: 160 }, 56, { min: 44 }));
    add(text('body', body, { left: 108, top: 340, width: 980, height: 274 }, 28, { min: 24, color: MUTED }));
    add(text('caption', caption, { left: 108, top: 620, width: 980, height: 34 }, 18, { color: MUTED }));
  }
  const logo = images.get(project.brand?.logoAssetId);
  const sidePhoto = strategy === 'photograph-with-side-note';
  if (logo) add(photo(logo, sidePhoto ? { left: 28, top: 644, width: 132, height: 28 } : { left: 1092, top: 696, width: 132, height: 20 }, true));
  add(text('page-number', String(index + 1).padStart(2, '0'), { left: sidePhoto ? 28 : 32, top: 696, width: 52, height: 23 }, 14, { color: accent }));
  return { id: slide.id, kind, background: BG, fontFamily: project.brand?.fontFamily || 'Microsoft YaHei', elements, composition: metrics(elements, project, images, strategy) };
}
