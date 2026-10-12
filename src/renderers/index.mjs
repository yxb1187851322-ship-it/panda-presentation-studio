import fs from 'node:fs/promises';
import path from 'node:path';
import { loadImageAssets, loadRuntimePackage } from './assets.mjs';
import { CANVAS, buildSlideLayout } from './layout.mjs';
import { renderHtml } from './html.mjs';

const writeBlob = async (destination, blob) => fs.writeFile(destination, new Uint8Array(await blob.arrayBuffer()));

/** Render a reviewed project snapshot. All paths in the result are relative to outputDir. */
export async function renderProject({ project, projectDir, outputDir, formats = ['pptx', 'web', 'images'] }) {
  if (!project || !Array.isArray(project.slides) || project.slides.length === 0) throw Object.assign(new Error('项目至少需要一页。'), { code: 'EMPTY_PROJECT', status: 422 });
  if (!Array.isArray(project.assets)) throw Object.assign(new Error('项目缺少资源清单。'), { code: 'INVALID_PROJECT', status: 422 });
  if (!Array.isArray(formats) || formats.length === 0 || formats.some(format => !['pptx', 'web', 'images'].includes(format))) throw Object.assign(new Error('不支持的导出格式。'), { code: 'INVALID_FORMAT', status: 422 });
  if (project.slides.length > 100) throw Object.assign(new Error('单次导出最多 100 页。'), { code: 'TOO_MANY_SLIDES', status: 422 });
  const imageAssets = await loadImageAssets(project, projectDir);
  const warnings = [];
  for (const slide of project.slides) {
    const missing = (slide.assetIds ?? []).filter(id => !project.assets.some(asset => asset.id === id));
    if (missing.length) throw Object.assign(new Error('页面引用了不存在的资源。'), { code: 'ASSET_MISSING', status: 422 });
    const unavailable = (slide.assetIds ?? []).filter(id => project.assets.find(asset => asset.id === id)?.kind === 'image' && !imageAssets.has(id));
    if (unavailable.length) throw Object.assign(new Error('页面图片无法读取。'), { code: 'ASSET_MISSING', status: 422 });
  }
  if (project.brand?.logoAssetId && !imageAssets.has(project.brand.logoAssetId)) throw Object.assign(new Error('所选 Logo 不是可用图片。'), { code: 'LOGO_UNAVAILABLE', status: 422 });
  const layouts = project.slides.map((slide, index) => buildSlideLayout(slide, index, project, imageAssets));
  const target = path.resolve(outputDir);
  await fs.mkdir(target, { recursive: true });
  if ((await fs.readdir(target)).length) throw Object.assign(new Error('导出目录必须为空，每次导出应使用新的目录。'), { code: 'OUTPUT_EXISTS', status: 422 });
  await fs.mkdir(path.join(target, 'previews'));
  await fs.mkdir(path.join(target, '.private'));
  const { Presentation, PresentationFile } = await loadRuntimePackage('@oai/artifact-tool');
  const presentation = Presentation.create({ slideSize: CANVAS });
  const previews = [];
  const files = [];
  for (let index = 0; index < layouts.length; index++) {
    const layout = layouts[index];
    const source = project.slides[index];
    const slide = presentation.slides.add();
    slide.background.fill = layout.background;
    for (const element of layout.elements) {
      const position = { left: element.left, top: element.top, width: element.width, height: element.height };
      if (element.type === 'image') {
        const asset = imageAssets.get(element.assetId);
        slide.images.add({ blob: new Uint8Array(asset.bytes), contentType: asset.mediaType, position, fit: element.fit, alt: element.alt });
      } else {
        const shape = slide.shapes.add({ geometry: 'textbox', name: element.name, position, fill: 'none', line: { fill: 'none', width: 0, style: 'solid' } });
        shape.text = element.text;
        shape.text.style = { typeface: layout.fontFamily, fontSize: element.fontSize, bold: element.bold, color: element.color, insets: 0, verticalAlignment: 'top', wrap: 'square', autoFit: 'none' };
      }
    }
    slide.speakerNotes.text = (source.sourceIds ?? []).length ? `内容来源编号：${source.sourceIds.join('、')}` : '';
    const stem = `slide-${String(index + 1).padStart(3, '0')}`;
    await fs.writeFile(path.join(target, '.private', `${stem}.design.json`), JSON.stringify(layout, null, 2));
    const layoutBlob = await slide.export({ format: 'layout' });
    await fs.writeFile(path.join(target, '.private', `${stem}.layout.json`), await layoutBlob.text());
    const preview = `previews/${stem}.png`;
    await writeBlob(path.join(target, preview), await presentation.export({ slide, format: 'png', scale: 1 }));
    previews.push({ id: source.id, preview });
    if (formats.includes('images')) files.push({ name: preview, format: 'images' });
  }
  if (formats.includes('pptx')) {
    await (await PresentationFile.exportPptx(presentation)).save(path.join(target, 'presentation.pptx'));
    const inspectPath = path.join(target, 'presentation.pptx.inspect.ndjson');
    try { await fs.rename(inspectPath, path.join(target, '.private', 'presentation.inspect.ndjson')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    files.unshift({ name: 'presentation.pptx', format: 'pptx' });
  }
  if (formats.includes('web')) {
    await fs.writeFile(path.join(target, 'index.html'), renderHtml(project, layouts, imageAssets), 'utf8');
    files.push({ name: 'index.html', format: 'web' });
  }
  await fs.writeFile(path.join(target, '.private', 'render-receipt.json'), JSON.stringify({ renderer: 'artifact-tool', version: 1, slideSize: CANVAS, revision: project.revision ?? 0, slideCount: layouts.length, fontFamilies: [...new Set(layouts.map(layout => layout.fontFamily))], formats, warnings, status: 'rendered-awaiting-visual-review', nativeText: true, images: 'embedded-original-normalized-assets', cad: 'only-supplied-raster-preview' }, null, 2));
  return { files, slides: previews, warnings };
}

export { buildSlideLayout, CANVAS, estimatedLineCount, wrapSlideText } from './layout.mjs';
export { resolveProjectAsset } from './assets.mjs';
