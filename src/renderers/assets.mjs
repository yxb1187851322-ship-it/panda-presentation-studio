import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export async function loadRuntimePackage(name) {
  try { return await import(name); }
  catch (error) {
    if (!process.env.PANDA_NODE_MODULES) {
      throw Object.assign(new Error(`缺少 ${name}。请安装受支持依赖，或设置 PANDA_NODE_MODULES。`), { code: 'RENDER_RUNTIME_MISSING', status: 503, cause: error });
    }
    const require = createRequire(path.join(path.resolve(process.env.PANDA_NODE_MODULES), '..', 'panda-runtime.cjs'));
    return import(pathToFileURL(require.resolve(name)).href);
  }
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export async function resolveProjectAsset(projectDir, file) {
  if (typeof file !== 'string' || !/^assets\/[A-Za-z0-9_-]+\.(png|jpe?g|txt|md|pdf|docx|pptx|xlsx|dxf|dwg)$/i.test(file)) {
    throw Object.assign(new Error('资源路径必须为 assets/安全编号.扩展名。'), { code: 'UNSAFE_ASSET_PATH', status: 422 });
  }
  const root = await fs.realpath(projectDir);
  const candidate = path.resolve(root, file);
  if (!contained(root, candidate)) throw Object.assign(new Error('资源路径越界。'), { code: 'UNSAFE_ASSET_PATH', status: 422 });
  let actual;
  try { actual = await fs.realpath(candidate); }
  catch (error) { throw Object.assign(new Error(`资源不存在：${path.basename(file)}`), { code: 'ASSET_MISSING', status: 422, cause: error }); }
  if (!contained(root, actual)) throw Object.assign(new Error('资源链接指向项目外。'), { code: 'UNSAFE_ASSET_PATH', status: 422 });
  const info = await fs.stat(actual);
  if (!info.isFile()) throw Object.assign(new Error('资源不是文件。'), { code: 'ASSET_MISSING', status: 422 });
  return actual;
}

export async function loadImageAssets(project, projectDir) {
  const assets = new Map();
  const wanted = new Set(project.slides.flatMap(slide => slide.assetIds ?? []));
  if (project.brand?.logoAssetId) wanted.add(project.brand.logoAssetId);
  const sharp = (await loadRuntimePackage('sharp')).default;
  for (const asset of project.assets ?? []) {
    if (!wanted.has(asset.id) || asset.kind !== 'image') continue;
    if (assets.has(asset.id)) throw Object.assign(new Error('资源 ID 重复。'), { status: 422 });
    const sourcePath = await resolveProjectAsset(projectDir, asset.file);
    const bytes = await fs.readFile(sourcePath);
    let metadata;
    try { metadata = await sharp(bytes, { limitInputPixels: 80_000_000 }).metadata(); }
    catch (error) { throw Object.assign(new Error('图片无法解码或超过尺寸限制，请重新导入。'), { code: 'IMAGE_NOT_NORMALIZED', status: 422, cause: error }); }
    if (!['png', 'jpeg'].includes(metadata.format)) throw Object.assign(new Error('导出图片须已标准化为 PNG 或 JPEG。'), { code: 'IMAGE_NOT_NORMALIZED', status: 422 });
    if (!metadata.width || !metadata.height || (metadata.pages ?? 1) > 1 || (metadata.orientation && metadata.orientation !== 1)) {
      throw Object.assign(new Error('图片必须已完成方向与单帧标准化。'), { code: 'IMAGE_NOT_NORMALIZED', status: 422 });
    }
    assets.set(asset.id, { ...asset, bytes, width: metadata.width, height: metadata.height, mediaType: metadata.format === 'jpeg' ? 'image/jpeg' : 'image/png' });
  }
  return assets;
}
