import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const localRequire = createRequire(import.meta.url);
export const INTAKE_LIMITS = Object.freeze({ bytes: 64 * 1024 * 1024, pixels: 40_000_000, textCharacters: 100_000, documentPages: 80 });
const ROLES = new Set(['content', 'logo', 'reference', 'plan']);
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

function detect(buffer, name) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { kind: 'image', ext: 'png', mediaType: IMAGE_TYPES.png };
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return { kind: 'image', ext: 'jpg', mediaType: IMAGE_TYPES.jpg };
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { kind: 'image', ext: 'webp', mediaType: IMAGE_TYPES.webp };
  if (buffer.toString('ascii', 0, 5) === '%PDF-') return { kind: 'document', ext: 'pdf', mediaType: 'application/pdf' };
  if (/^AC10\d\d/.test(buffer.toString('ascii', 0, 6))) return { kind: 'cad', ext: 'dwg', mediaType: 'application/octet-stream' };
  const ext = path.extname(name).toLowerCase();
  const prefix = buffer.toString('utf8', 0, Math.min(buffer.length, 8192));
  if (ext === '.dxf' && (/AutoCAD Binary DXF/.test(prefix) || /^\s*0\s*\r?\n\s*SECTION\s*\r?\n/i.test(prefix))) return { kind: 'cad', ext: 'dxf', mediaType: 'application/octet-stream' };
  if (buffer.readUInt16LE(0) === 0x4b50 && buffer[2] === 3 && buffer[3] === 4) return { kind: 'office', ext: 'zip', mediaType: 'application/octet-stream' };
  if (['.txt', '.md'].includes(ext)) {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      if (!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded)) return { kind: 'text', ext: ext.slice(1), mediaType: 'text/plain', decoded };
    } catch { /* Keep undecodable files, but do not present binary as text. */ }
  }
  return { kind: 'unknown', ext: 'bin', mediaType: 'application/octet-stream' };
}

async function sharpDependency() {
  try { return localRequire('sharp'); } catch {}
  if (process.env.PANDA_NODE_MODULES) {
    try { return localRequire(path.join(process.env.PANDA_NODE_MODULES, 'sharp')); } catch {}
  }
  return null;
}

async function parseDocument(file, type) {
  const python = process.env.PANDA_PYTHON || 'python';
  const script = fileURLToPath(new URL('./parse_document.py', import.meta.url));
  const { stdout } = await execFileAsync(python, ['-I', '-X', 'utf8', script, file, type], {
    encoding: 'utf8', timeout: 25_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}

/** Store originals first. Parsing produces a separate local derivative and never executes source instructions. */
export async function importAsset({ projectDir, name, buffer, role = 'content' }) {
  if (typeof projectDir !== 'string' || !projectDir) throw new TypeError('projectDir is required');
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('文件名不能为空');
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (!buffer.length) throw new RangeError('文件为空');
  if (buffer.length > INTAKE_LIMITS.bytes) throw new RangeError('单个文件不能超过 64 MB');
  if (!ROLES.has(role)) throw new TypeError('用途必须是 content、logo、reference 或 plan');
  const safeName = name.split(/[\\/]/).pop().replace(/[\x00-\x1f]/g, '').slice(0, 240) || '未命名资料';
  await mkdir(projectDir, { recursive: true });
  const root = await realpath(projectDir);
  const assetsDir = path.join(root, 'assets');
  await mkdir(assetsDir, { recursive: true });
  if (await realpath(assetsDir) !== assetsDir) throw new Error('资料目录不能是符号链接');
  const type = buffer.length >= 4 ? detect(buffer, safeName) : { kind: 'unknown', ext: 'bin', mediaType: 'application/octet-stream' };
  // Short valid text files are still text; signature readers require four bytes.
  if (buffer.length < 4 && /\.(txt|md)$/i.test(safeName)) {
    try { const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer); if (!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded)) Object.assign(type, { kind: 'text', ext: 'txt', mediaType: 'text/plain', decoded }); } catch {}
  }
  const id = randomUUID();
  const originalFile = `assets/${id}.${type.ext}`;
  const originalPath = path.join(root, ...originalFile.split('/'));
  await writeFile(originalPath, buffer, { flag: 'wx' });
  const asset = { id, name: safeName, kind: type.kind, mediaType: type.mediaType, file: originalFile, originalFile, bytes: buffer.length, width: null, height: null, text: '', status: 'pending', role, warnings: [], readScope: null, fit: 'contain' };
  if (type.kind === 'image') {
    const sharp = await sharpDependency();
    if (!sharp) { asset.warnings.push('缺少 sharp 图像依赖；原件已保存，尚未验证图像尺寸和安全解码。'); return asset; }
    try {
      const meta = await sharp(buffer, { limitInputPixels: INTAKE_LIMITS.pixels, failOn: 'warning' }).metadata();
      if (!meta.width || !meta.height || meta.width * meta.height > INTAKE_LIMITS.pixels) throw new Error('像素数量超过 4000 万或图像尺寸缺失');
      if (meta.pages > 1) { asset.warnings.push('动态图像仅导入第一帧；完整原件已保留。'); }
      const file = `assets/${id}-preview.png`;
      const { info } = await sharp(buffer, { limitInputPixels: INTAKE_LIMITS.pixels, failOn: 'warning' }).rotate().resize({ width: 4800, height: 4800, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true }).then(async result => { await writeFile(path.join(root, ...file.split('/')), result.data, { flag: 'wx' }); return result; });
      Object.assign(asset, { file, width: info.width, height: info.height, mediaType: 'image/png', status: 'ready', readScope: { mode: 'dimensions_only', originalWidth: meta.width, originalHeight: meta.height, imageSemanticsAnalyzed: false, orientationApplied: true, derivativeMaxEdge: 4800 } });
    } catch (error) { asset.status = 'unsupported'; asset.warnings.push(`图像未完成安全解码：${String(error.message).slice(0, 220)}；原件已保留。`); }
  } else if (type.kind === 'text') {
    const text = type.decoded.replace(/^\uFEFF/, '');
    asset.text = text.slice(0, INTAKE_LIMITS.textCharacters);
    asset.status = text.length > INTAKE_LIMITS.textCharacters ? 'partial' : 'ready';
    asset.readScope = { mode: 'text', charactersRead: asset.text.length, totalCharacters: text.length, complete: asset.status === 'ready' };
    if (asset.status === 'partial') asset.warnings.push('正文仅读取前 100000 个字符，剩余内容保留在原件中。');
  } else if (type.kind === 'document' || type.kind === 'office') {
    try {
      const parsed = await parseDocument(originalPath, type.ext);
      asset.kind = parsed.kind || 'document';
      asset.text = parsed.text || '';
      asset.status = parsed.status;
      asset.readScope = parsed.readScope || null;
      asset.warnings.push(...(parsed.warnings || []));
      if (parsed.format) asset.format = parsed.format;
    } catch (error) {
      asset.kind = 'document'; asset.status = 'pending';
      // Do not leak machine paths or process arguments through parser errors.
      asset.warnings.push(error.killed || error.code === 'ETIMEDOUT' ? '文档解析超过 25 秒，原件已保存；需要分拆或人工检查。' : '本机文档解析器暂不可用或读取失败；原件已保存，尚未读取正文。');
    }
  } else if (type.kind === 'cad') {
    asset.warnings.push('已接收 CAD 原件，当前未做原生解析、测量或渲染。请提供图纸 PDF/PNG 以便试排。');
  } else {
    asset.status = 'unsupported';
    asset.warnings.push('该格式或文件签名暂不支持；原件已保存，没有执行或解释其中的内容。');
  }
  // A final filesystem check makes a successful intake mean that an original really exists.
  if ((await stat(originalPath)).size !== buffer.length) throw new Error('原件保存校验失败');
  return asset;
}
