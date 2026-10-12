import { readFile, stat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command = 'status', id, ...flags] = process.argv.slice(2);
const output = value => console.log(JSON.stringify(value, null, 2));

async function getRoot() {
  if (process.env.PANDA_LIBRARY_ROOT) return realpath(process.env.PANDA_LIBRARY_ROOT);
  try {
    const binding = JSON.parse(await readFile(path.join(repo, 'local/library.local.json'), 'utf8'));
    if (typeof binding.root !== 'string' || !binding.root.trim()) throw new Error('invalid root');
    return await realpath(binding.root);
  } catch {
    throw new Error('尚未绑定本机原件。按 docs/本地资源使用.md 创建 local/library.local.json，或指定 PANDA_LIBRARY_ROOT。');
  }
}

async function resolveAsset(root, asset) {
  const relative = asset.relative_path;
  if (typeof relative !== 'string' || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
    throw new Error(`资源路径不合法: ${asset.id}`);
  }
  const candidate = path.resolve(root, relative);
  const lexical = path.relative(root, candidate);
  if (lexical === '..' || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical)) throw new Error('资源路径超出资料根目录');
  const resolved = await realpath(candidate);
  const physical = path.relative(root, resolved);
  if (physical === '..' || physical.startsWith(`..${path.sep}`) || path.isAbsolute(physical)) throw new Error('资源链接指向资料根目录之外');
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error('登记资源不是文件');
  return { path: resolved, bytes: info.size, size_matches: info.size === asset.bytes };
}

async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

try {
  let registry;
  try {
    registry = JSON.parse(await readFile(path.join(repo, 'local/assets.local.json'), 'utf8'));
    if (!Array.isArray(registry.assets)) throw new Error('invalid asset registry');
  } catch {
    throw new Error('缺少本机清单 local/assets.local.json。原件文件名、路径和哈希仅保留本地；格式见 resources/sources/local-assets.schema.json。');
  }
  if (command === 'list') {
    output(registry.assets.map(a => ({ id: a.id, role: a.role, bytes: a.bytes })));
  } else if (command === 'resolve') {
    if (flags.some(f => f !== '--verify')) throw new Error('仅支持 --verify 选项');
    const asset = registry.assets.find(a => a.id === id);
    if (!asset) throw new Error('未知资源 ID；先运行 list 查看登记项');
    const value = await resolveAsset(await getRoot(), asset);
    const hashVerified = flags.includes('--verify');
    const hashMatches = hashVerified ? (await hashFile(value.path)) === asset.sha256 : null;
    output({ id, ...value, hash_verified: hashVerified, hash_matches: hashMatches, uploaded: false });
    if (!value.size_matches || hashMatches === false) process.exitCode = 1;
  } else if (command === 'status') {
    const root = await getRoot();
    const issues = [];
    for (const asset of registry.assets) {
      try {
        const value = await resolveAsset(root, asset);
        if (!value.size_matches) issues.push({ id: asset.id, reason: 'size_mismatch' });
      } catch (error) {
        issues.push({ id: asset.id, reason: error.code ?? error.message });
      }
    }
    output({ registered_records: registry.assets.length, unique_files: new Set(registry.assets.map(a => a.relative_path)).size,
      existing_with_expected_size: registry.assets.length - issues.length, issues, hashes_rechecked: false,
      content_reanalysed: false, uploaded: false });
    if (issues.length) process.exitCode = 1;
  } else throw new Error('用法: node scripts/local-library.mjs status | list | resolve <id> [--verify]');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
