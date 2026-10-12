import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MODES = ['native-authoring', 'native-template', 'source-facsimile', 'reference-visual', 'editable-reconstruction', 'semantic-web', 'magazine-native'];
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const text = value => typeof value === 'string' && value.trim().length > 0;
const array = value => Array.isArray(value) ? value : [];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const statusLabel = status => ({ draft: '样稿 · 待审阅', changes_requested: '样稿 · 待修改', accepted: '已有用户采用记录' })[status] || '样稿 · 待审阅';

/** Read local evidence only. This tool does not call a model, judge taste, or certify fact/visual accuracy. */
export async function checkProductionManifest(manifest, { baseDir = process.cwd() } = {}) {
  const errors = [], warnings = [], files = new Map();
  const error = (code, location, message) => errors.push({ code, location, message });
  const warn = (code, location, message) => warnings.push({ code, location, message });
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: [{ code: 'INVALID_MANIFEST', location: '', message: '清单须为 JSON 对象。' }], warnings, files };
  }
  if (manifest.schemaVersion !== 1) error('SCHEMA_VERSION', 'schemaVersion', '仅支持 schemaVersion: 1。');
  for (const key of ['id', 'title']) if (!text(manifest[key])) error('REQUIRED_TEXT', key, `${key} 不能为空。`);
  if (!Number.isInteger(manifest.revision) || manifest.revision < 0) error('REVISION', 'revision', 'revision 须为非负整数。');
  const registry = (items, key) => {
    if (items !== undefined && !Array.isArray(items)) error('ARRAY_REQUIRED', key, `${key} 须为数组。`);
    const result = new Map();
    array(items).forEach((item, index) => {
      if (!item || !text(item.id)) error('ID_REQUIRED', `${key}[${index}]`, '须提供非空 id。');
      else if (result.has(item.id)) error('DUPLICATE_ID', `${key}[${index}].id`, `重复 id：${item.id}`);
      else result.set(item.id, item);
    });
    return result;
  };
  const sources = registry(manifest.sources, 'sources');
  const assets = registry(manifest.assets, 'assets');
  const references = registry(manifest.references, 'references');
  const units = registry(manifest.contentUnits, 'contentUnits');
  const pages = registry(manifest.pages, 'pages');
  if (!pages.size) error('NO_PAGES', 'pages', '至少需要一张实际渲染的样页。');

  async function localFile(value, location, { required = true, image = false } = {}) {
    if (!text(value)) { if (required) error('FILE_REQUIRED', location, '须提供本地文件路径。'); return; }
    if (/^[a-z]+:\/\//i.test(value)) { error('LOCAL_FILE_REQUIRED', location, '这里仅接受本地文件，远程链接请放在 locator。'); return; }
    const absolute = path.resolve(baseDir, value);
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile() || !stat.size) throw new Error('不是非空普通文件');
      if (image) {
        if (!IMAGE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
          error('IMAGE_FORMAT', location, '样页预览仅支持 PNG、JPEG 或 WebP。'); return;
        }
        const handle = await fs.open(absolute, 'r');
        const header = Buffer.alloc(12);
        try { await handle.read(header, 0, 12, 0); } finally { await handle.close(); }
        const png = header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const jpg = header[0] === 255 && header[1] === 216 && header[2] === 255;
        const webp = header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
        if (!png && !jpg && !webp) { error('IMAGE_HEADER', location, '文件内容没有受支持的图片签名。'); return; }
      }
      files.set(location, absolute);
    } catch (cause) { error('FILE_UNAVAILABLE', location, `无法读取本地文件：${cause.code || cause.message}`); }
  }

  for (const [id, source] of sources) {
    await localFile(source.path, `sources.${id}.path`, { required: false });
    if (!text(source.path) && !text(source.locator)) warn('SOURCE_LOCATION_MISSING', `sources.${id}`, '来源尚无可定位的文件或链接。');
    if (!text(source.readScope)) warn('READ_SCOPE_MISSING', `sources.${id}.readScope`, '尚未记录实际读取范围。');
  }
  for (const [id, asset] of assets) {
    await localFile(asset.path, `assets.${id}.path`);
    if (asset.sourceId && !sources.has(asset.sourceId)) error('UNKNOWN_SOURCE', `assets.${id}.sourceId`, `找不到来源：${asset.sourceId}`);
  }
  for (const [id, reference] of references) {
    await localFile(reference.path, `references.${id}.path`, { required: false });
    if (!array(reference.observations).some(text)) warn('REFERENCE_UNREAD', `references.${id}`, '尚无具体画面观察，不能把参考编号视为已经理解版式。');
  }
  for (const [id, unit] of units) {
    if (!text(unit.text)) error('CONTENT_TEXT', `contentUnits.${id}.text`, '内容单元须有实际文字。');
    if (!['fact', 'observation', 'proposal'].includes(unit.kind)) error('CONTENT_KIND', `contentUnits.${id}.kind`, '内容类型须为 fact、observation 或 proposal。');
    if (!array(unit.sourceRefs).length) warn('CONTENT_WITHOUT_EVIDENCE', `contentUnits.${id}`, '该内容尚无来源定位；草稿可导出，但不代表事实已确认。');
    for (const [index, ref] of array(unit.sourceRefs).entries()) {
      if (!sources.has(ref?.sourceId)) error('UNKNOWN_SOURCE', `contentUnits.${id}.sourceRefs[${index}]`, '内容引用了不存在的来源。');
      if (!text(ref?.locator)) warn('CONTENT_LOCATION_MISSING', `contentUnits.${id}.sourceRefs[${index}]`, '请记录页码、段落、时间码或具体用户要求。');
    }
  }
  for (const [id, page] of pages) {
    const location = `pages.${id}`;
    if (!text(page.title)) error('PAGE_TITLE', `${location}.title`, '须提供页面标题或阅读说明。');
    if (!MODES.includes(page.mode)) error('PAGE_MODE', `${location}.mode`, `mode 须为 ${MODES.join(' / ')}。`);
    await localFile(page.imagePath, `${location}.imagePath`, { image: true });
    for (const assetId of array(page.assetIds)) if (!assets.has(assetId)) error('UNKNOWN_ASSET', `${location}.assetIds`, `找不到素材：${assetId}`);
    if (!array(page.contentUnitIds).length) warn('CONTENT_MAPPING_MISSING', `${location}.contentUnitIds`, '样页尚未映射内容单元，不能视为已完成内容分析。');
    for (const unitId of array(page.contentUnitIds)) if (!units.has(unitId)) error('UNKNOWN_CONTENT', `${location}.contentUnitIds`, `找不到内容单元：${unitId}`);
    const binding = page.referenceBinding;
    if (!binding) warn('REFERENCE_BINDING_MISSING', location, '尚未记录参考与实际页面的关系。');
    else {
      const reference = references.get(binding.referenceId);
      if (!reference) error('UNKNOWN_REFERENCE', `${location}.referenceBinding`, '参考绑定须引用 references 中的 id。');
      if (!['candidate', 'applied', 'preserved'].includes(binding.status)) error('REFERENCE_STATUS', `${location}.referenceBinding.status`, 'status 须为 candidate、applied 或 preserved。');
      if (binding.status === 'candidate') warn('REFERENCE_CANDIDATE_ONLY', location, '参考仅为候选，尚未应用为本页约束。');
      if (binding.status === 'applied') {
        const constraints = array(reference?.constraints).filter(text);
        if (!constraints.length || !array(reference?.observations).some(text)) error('REFERENCE_APPLICATION_UNSUPPORTED', location, '声称 applied 须有具体观察、参考约束与逐项检查。');
        for (const constraint of constraints) {
          const check = array(binding.constraintChecks).find(item => item?.constraint === constraint);
          if (!check || !['matched', 'deviated'].includes(check.result) || !text(check.evidence)) error('CONSTRAINT_CHECK_MISSING', location, `约束缺少实际对照记录：${constraint}`);
          else if (check.result === 'deviated') warn('REFERENCE_DEVIATION', location, `实际样页偏离参考：${constraint}；${check.evidence}`);
        }
      }
      if (binding.status === 'preserved') {
        if (page.mode !== 'source-facsimile') error('PRESERVED_MODE', location, 'preserved 仅用于 source-facsimile；新生成页面应记录 applied 及逐项对照。');
        const refPath = files.get(`references.${binding.referenceId}.path`);
        const pagePath = files.get(`${location}.imagePath`);
        if (!refPath || !pagePath) error('PRESERVED_REFERENCE_FILE', location, '保留原整页须提供实际参考图片文件。');
        else if (sha256(await fs.readFile(refPath)) !== sha256(await fs.readFile(pagePath))) error('PRESERVED_BYTES_DIFFER', location, 'preserved 要求输出图片与参考图片字节相同；重编码/重绘应另记对照，不能冒称工具已验证原样保留。');
      }
    }
    for (const [index, protectedAsset] of array(page.protectedAssets).entries()) {
      const loc = `${location}.protectedAssets[${index}]`;
      if (!assets.has(protectedAsset?.originalAsset)) error('UNKNOWN_PROTECTED_ASSET', loc, 'originalAsset 须指向 assets 中的 id。');
      if (protectedAsset?.fit !== 'contain' || protectedAsset?.mayRegenerate !== false) error('PROTECTED_ASSET_POLICY', loc, '受保护素材须声明 fit=contain、mayRegenerate=false。');
      if (protectedAsset?.placement) {
        const p = protectedAsset.placement;
        if (!['px', 'pt', 'normalized'].includes(p.unit) || ![p.x, p.y, p.width, p.height].every(Number.isFinite) || p.width <= 0 || p.height <= 0) error('PROTECTED_ASSET_PLACEMENT', loc, 'placement 须含有限 x/y/width/height、正宽高和有效 unit。');
      }
      warn('PROTECTED_ASSET_VISUAL_CHECK', loc, '声明不等于保真检查；仍须核对实际画面中的边界、比例、标注与 Logo。');
    }
  }

  const sample = manifest.sample || { pageIds: [...pages.keys()], status: 'draft' };
  if (!['draft', 'changes_requested', 'accepted'].includes(sample.status)) error('SAMPLE_STATUS', 'sample.status', '样张状态须为 draft、changes_requested 或 accepted。');
  for (const id of array(sample.pageIds)) if (!pages.has(id)) error('UNKNOWN_SAMPLE_PAGE', 'sample.pageIds', `样张页不存在：${id}`);
  if (sample.status === 'accepted' && (!text(sample.userEvidence) || !array(sample.pageIds).length)) error('USER_EVIDENCE_REQUIRED', 'sample', 'accepted 须附具体采用页与用户证据；开始制作的授权不等于认可样张。');
  if (sample.status !== 'accepted') warn('SAMPLE_NOT_ACCEPTED', 'sample', '当前是可供用户审阅的样稿，不代表用户已采用视觉方向。');
  const review = manifest.review?.visual;
  if (review?.status && !['pending', 'reviewed', 'needs_changes'].includes(review.status)) error('VISUAL_STATUS', 'review.visual.status', '视觉状态须为 pending、reviewed 或 needs_changes。');
  if (review?.status === 'reviewed' && !text(review.record)) error('VISUAL_RECORD_REQUIRED', 'review.visual.record', '已复核须记录具体页面观察与问题，不能只有分数。');
  if (!review || review.status !== 'reviewed') warn('VISUAL_REVIEW_PENDING', 'review.visual', '本工具不执行视觉判断；待查看实际样页。');
  if (manifest.exports !== undefined && !Array.isArray(manifest.exports)) error('ARRAY_REQUIRED', 'exports', 'exports 须为数组。');
  for (const [index, artifact] of array(manifest.exports).entries()) {
    const loc = `exports[${index}]`;
    await localFile(artifact?.path, `${loc}.path`);
    if (!['pptx', 'pdf'].includes(artifact?.format)) error('EXPORT_FORMAT', loc, '现有文件封装仅支持 pptx 或 pdf；网页由页图忠实生成。');
    else if (text(artifact.path) && path.extname(artifact.path).toLowerCase() !== `.${artifact.format}`) error('EXPORT_EXTENSION', loc, '文件扩展名与 format 不符。');
    if (!['image_based', 'editable'].includes(artifact?.type)) error('EXPORT_TYPE', loc, '导出须明确 image_based 或 editable。');
    if (artifact?.type === 'editable') {
      if (!text(artifact.editabilityEvidence?.scope)) error('EDITABILITY_SCOPE_REQUIRED', loc, '须明确哪些对象可编辑及范围。');
      await localFile(artifact.editabilityEvidence?.path, `${loc}.editabilityEvidence.path`);
      warn('EDITABILITY_NOT_AUTOMATICALLY_VERIFIED', loc, '已登记编辑性检查记录；本封装工具不打开 PPT，也不判定全部对象可编辑。');
    }
  }
  return { ok: errors.length === 0, errors, warnings, files, sampleStatus: sample.status, pageCount: pages.size,
    scope: '仅核对清单、文件存在、引用关系和声明证据；不代表事实正确、审美通过或目标软件兼容。' };
}

export function serializableReport(report) {
  const { files, ...publicReport } = report;
  return publicReport;
}

/** Package only finished previews and explicit exports. Original documents and model credentials are never copied. */
export async function bundleProductionManifest(manifest, { baseDir = process.cwd(), outputDir } = {}) {
  const report = await checkProductionManifest(manifest, { baseDir });
  if (!report.ok) throw Object.assign(new Error('清单检查未通过。'), { code: 'MANIFEST_INVALID', report: serializableReport(report) });
  if (!text(outputDir)) throw new Error('必须指定新的输出目录。');
  const output = path.resolve(outputDir);
  try { if ((await fs.readdir(output)).length) throw Object.assign(new Error('输出目录必须为空；不会覆盖上一版。'), { code: 'OUTPUT_NOT_EMPTY' }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(path.join(output, 'pages'), { recursive: true });
  const pages = [];
  for (const [index, page] of manifest.pages.entries()) {
    const input = report.files.get(`pages.${page.id}.imagePath`);
    const relative = `pages/page-${String(index + 1).padStart(3, '0')}${path.extname(input).toLowerCase()}`;
    const bytes = await fs.readFile(input);
    await fs.writeFile(path.join(output, relative), bytes);
    pages.push({ id: page.id, title: page.title, mode: page.mode, imagePath: relative, sha256: sha256(bytes), notes: page.notes || '', contentUnitIds: array(page.contentUnitIds), assetIds: array(page.assetIds), referenceBinding: page.referenceBinding || null });
  }
  const exports = [];
  for (const [index, artifact] of array(manifest.exports).entries()) {
    const relative = `presentation-${String(index + 1).padStart(2, '0')}.${artifact.format}`;
    const bytes = await fs.readFile(report.files.get(`exports[${index}].path`));
    await fs.writeFile(path.join(output, relative), bytes);
    exports.push({ path: relative, format: artifact.format, type: artifact.type, sha256: sha256(bytes), editableScope: artifact.editabilityEvidence?.scope || null });
  }
  const receipt = { schemaVersion: 1, id: manifest.id, title: manifest.title, revision: manifest.revision,
    sample: manifest.sample || { status: 'draft', pageIds: pages.map(page => page.id) },
    review: manifest.review || { visual: { status: 'pending' } }, pages, exports,
    contentUnits: array(manifest.contentUnits),
    sources: array(manifest.sources).map(({ id, label, readScope, summary }) => ({ id, label, readScope, summary })),
    references: array(manifest.references).map(({ id, observations, constraints }) => ({ id, observations, constraints })),
    checks: serializableReport(report), privacy: '原始文件及其本机路径未复制。讲稿、内容和复核记录按输入保留，分享前仍需审阅其内容。' };
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(manifest.title)}</title>
<style>*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#141414;color:#f4f4f4;font:14px/1.5 system-ui,sans-serif}header{max-width:1680px;margin:auto;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px}header strong{font-size:15px;font-weight:500}header span{color:#bbb}main{max-width:1680px;margin:auto}figure{margin:0 0 24px;background:white;line-height:0}img{display:block;width:100%;height:auto}footer{max-width:1680px;margin:auto;padding:0 20px 24px;color:#bbb;font-size:12px}a{color:inherit}@media print{body{background:white}header,footer{display:none}figure{margin:0;break-after:page}img{max-height:100vh;object-fit:contain}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}</style></head>
<body><header><strong>${escapeHtml(manifest.title)}</strong><span>${escapeHtml(statusLabel(report.sampleStatus))} · ${pages.length} 页</span></header><main>
${pages.map((page, index) => `<figure id="page-${index + 1}"><img src="${page.imagePath}" alt="${escapeHtml(page.title)}" loading="${index ? 'lazy' : 'eager'}"></figure>`).join('\n')}
</main><footer>整页图像预览，保留已制作样页的比例与版面。<a href="notes.md">讲稿与内容来源</a> · <a href="production-receipt.json">制作记录</a>${exports.map(item => ` · <a href="${item.path}">${escapeHtml(item.format.toUpperCase())}（${item.type === 'image_based' ? '整页图像' : '编辑范围见记录'}）</a>`).join('')}</footer></body></html>`;
  const units = new Map(array(manifest.contentUnits).map(unit => [unit.id, unit]));
  const notes = [`# ${manifest.title}`, '', statusLabel(report.sampleStatus), '', '本文件按制作清单整理，不代表内容或审美已获用户认可。', ...pages.flatMap((page, index) => [
    '', `## ${index + 1}. ${page.title}`, '', page.notes || '（尚未填写讲稿）', '', '内容与来源：',
    ...page.contentUnitIds.map(id => { const unit = units.get(id); return `- ${unit.kind}：${unit.text}｜${array(unit.sourceRefs).map(ref => `${ref.sourceId} ${ref.locator || ''}`).join('；') || '待补来源'}`; }),
  ])].join('\n');
  await fs.writeFile(path.join(output, 'index.html'), html, 'utf8');
  await fs.writeFile(path.join(output, 'notes.md'), notes, 'utf8');
  await fs.writeFile(path.join(output, 'production-receipt.json'), JSON.stringify(receipt, null, 2), 'utf8');
  return { outputDir: output, pageCount: pages.length, files: ['index.html', 'notes.md', 'production-receipt.json', ...pages.map(page => page.imagePath), ...exports.map(item => item.path)], report: serializableReport(report) };
}

async function main() {
  const [command, manifestPath, ...args] = process.argv.slice(2);
  if (!['check', 'bundle'].includes(command) || !manifestPath || (command === 'check' && args.length) || (command === 'bundle' && (args.length !== 2 || args[0] !== '--out'))) {
    console.error('用法：node scripts/production-manifest.mjs check manifest.json\n      node scripts/production-manifest.mjs bundle manifest.json --out 新的空目录');
    process.exitCode = 2; return;
  }
  const absolute = path.resolve(manifestPath);
  const manifest = JSON.parse((await fs.readFile(absolute, 'utf8')).replace(/^\uFEFF/, ''));
  const options = { baseDir: path.dirname(absolute), outputDir: args[1] };
  const result = command === 'check' ? serializableReport(await checkProductionManifest(manifest, options)) : await bundleProductionManifest(manifest, options);
  console.log(JSON.stringify(result, null, 2));
  if (result.ok === false) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ error: error.message, code: error.code || 'ERROR', report: error.report }, null, 2)); process.exitCode = 2; });
}
