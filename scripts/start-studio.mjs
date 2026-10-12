import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/server/studio-server.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try {
  const runtime=JSON.parse(await fs.readFile(path.join(root,'local/runtime.json'),'utf8'));
  if (runtime.nodeModules && !process.env.PANDA_NODE_MODULES) process.env.PANDA_NODE_MODULES=runtime.nodeModules;
  if (runtime.python && !process.env.PANDA_PYTHON) process.env.PANDA_PYTHON=runtime.python;
} catch(e) { if (e.code !== 'ENOENT') throw e; }
const port=Number(process.env.PANDA_PORT || 4317);
if (!Number.isInteger(port) || port<0 || port>65535) throw new Error('PANDA_PORT 无效');
const app=await createStudio({port});
console.log(`Panda 本地编排工作台：${app.origin}`);
console.log('资料只保存在本机。按 Ctrl+C 停止服务。');
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,async()=>{await app.close();process.exit(0);});
