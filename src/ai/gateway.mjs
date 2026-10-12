import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const BASE = 'https://api.lk888.ai/api';
const DEFAULT_MODELS = { analysis: 'gem-3.8-flash', planning: 'tt-6.1-sol', revision: 'gem-3.8-flash' };
const failure = (code, message, status = 502, extra = {}) => Object.assign(new Error(message), { code, status, publicMessage:message, ...extra });

// A user may append a replacement key; the last assignment is authoritative.
export function readDotEnv(text) {
  const result = {};
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    result[match[1]] = value;
  }
  return result;
}

async function optionalJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw failure('AI_CONFIG_INVALID', '本地模型配置不是有效 JSON。', 503); }
}

function scrub(value, key) {
  const json = JSON.stringify(value);
  return JSON.parse(json.split(key).join('[REDACTED]').replace(/sk-[a-zA-Z0-9_-]{12,}/g, '[REDACTED]'));
}

/** Provider aliases are not official model identities. Availability is checked live. */
export async function createModelGateway({ repoRoot, fetchImpl = globalThis.fetch, config: suppliedConfig, envFile: suppliedEnvFile, timeoutMs = 300_000 } = {}) {
  if (!repoRoot) throw new TypeError('repoRoot is required');
  const config = suppliedConfig ?? await optionalJson(path.join(repoRoot, 'local', 'ai-config.json'));
  const models = { ...DEFAULT_MODELS, ...config.models };
  const allowedModels = new Set([...Object.values(models), ...(config.allowedModels ?? [])]);
  const maxTokens = config.maxOutputTokens ?? 8000;
  const maxEstimatedCost = config.maxEstimatedCost ?? 2;
  if (!Number.isInteger(maxTokens) || maxTokens < 100 || maxTokens > 16000 || !Number.isFinite(maxEstimatedCost) || maxEstimatedCost <= 0 || maxEstimatedCost > 20) throw failure('AI_CONFIG_INVALID', '模型输出上限或试用费用上限无效。', 503);
  for (const name of allowedModels) if (typeof name !== 'string' || !/^[a-zA-Z0-9_.\/-]{1,100}$/.test(name) || name.includes('..')) throw failure('AI_CONFIG_INVALID', '模型 ID 无效。', 503);
  const envLocation = suppliedEnvFile ?? process.env.PANDA_ENV_FILE ?? config.envFile ?? '.env';
  const envFile = path.isAbsolute(envLocation) ? envLocation : path.resolve(repoRoot,envLocation);
  const receiptFile = path.join(repoRoot, 'local', 'ai-connection.json');
  let verified = false;
  let lastSuccessAt = null;
  let verifiedModels = [];
  let credentialFingerprint = null;
  const fingerprint = key => createHash('sha256').update(key).digest('hex');
  // Only this gateway's completed model calls create a receipt; configuration alone is not verification.
  const previous = await optionalJson(receiptFile);
  if (previous.provider === 'yijing' && previous.lastSuccessAt && previous.credentialFingerprint && Array.isArray(previous.models)) {
    verifiedModels = previous.models.filter(name => allowedModels.has(name));
    verified = verifiedModels.length > 0;
    lastSuccessAt = previous.lastSuccessAt;
    credentialFingerprint = previous.credentialFingerprint;
  }
  async function credentials() {
    let values = {};
    try { values = readDotEnv(await fs.readFile(envFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw failure('AI_ENV_UNREADABLE', '无法读取本地模型密钥配置。', 503); }
    const key = values.API_KEY || process.env.API_KEY;
    if (!key || /[\r\n]/.test(key)) throw failure('AI_NOT_CONFIGURED', '请在本地 .env 配置 API_KEY，再使用模型分析。', 503);
    return key;
  }
  async function getStatus() {
    let configured = true;
    let matches = false;
    try { matches = fingerprint(await credentials()) === credentialFingerprint; } catch { configured = false; }
    return { configured, verified: configured && verified && matches, provider: 'yijing', models, verifiedModels:matches ? verifiedModels : [], lastSuccessAt:matches ? lastSuccessAt : null,
      maxOutputTokens: maxTokens, maxEstimatedCost, costUnit: '算力',
      limitations: ['模型名为接入平台返回的别名；未独立验证上游身份。', '连通与结构校验不代表设计获得认可。', '调用将发送当前任务所需资料；按平台实际用量计费。'] };
  }
  async function request(endpoint, key, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(BASE + endpoint, { method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Accept-Language':'zh-CN', Accept:'application/json' },
        ...(body ? { body:JSON.stringify(body) } : {}) });
      const taskId = response.headers.get('x-task-id') || null;
      const chunks = []; let totalBytes = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const {done,value} = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > 8 * 1024 * 1024) {
              await reader.cancel();
              throw failure('AI_RESPONSE_TOO_LARGE', '模型回复超过本地读取上限；没有自动重复提交。', 502, {taskId});
            }
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let data;
      try { data = scrub(JSON.parse(raw), key); } catch { throw failure('AI_BAD_RESPONSE', '模型服务未返回有效 JSON；没有自动重复提交。', 502, { taskId }); }
      if (!response.ok || data.error || (typeof data.code === 'number' && data.code !== 200 && data.code >= 400)) {
        const type = String(data.error?.type || data.error?.code || data.error_code || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
        const message = response.status === 401 ? 'API Key 未通过验证。'
          : response.status === 402 ? '服务账户余额不足。'
          : response.status === 403 ? '当前 Key 没有该模型的可用权限或渠道。'
          : response.status === 429 ? '模型服务限流，请稍后手动重试。'
          : '模型服务调用失败；已保留当前项目，没有自动重复提交。';
        throw failure('AI_PROVIDER_ERROR', message, 502, { providerStatus:response.status, providerCode:type, taskId });
      }
      return { data, taskId };
    } catch (error) {
      if (error.code?.startsWith('AI_')) throw error;
      throw failure('AI_RESULT_UNKNOWN', '模型连接中断或超时，结果与费用可能尚未确定；请查询调用记录，不要立即重复提交。', 502, { uncertain:method === 'POST' });
    } finally { clearTimeout(timer); }
  }
  async function complete({ stage = 'analysis', system = '', prompt = '', images = [], model } = {}) {
    const name = model || models[stage];
    if (!allowedModels.has(name)) throw failure('AI_MODEL_NOT_ALLOWED', '该模型未在本地配置中启用。', 400);
    if (typeof system !== 'string' || typeof prompt !== 'string' || system.length + prompt.length > 140_000) throw failure('AI_INPUT_TOO_LARGE', '本轮资料文字超过上限，请分段分析。', 422);
    if (!Array.isArray(images) || images.length > 30 || images.some(image => !['image/png','image/jpeg','image/webp'].includes(image.mimeType) || typeof image.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data))) throw failure('AI_IMAGES_INVALID', '模型图片需要是已规范化的本地预览，最多 30 张。', 422);
    const bytes = images.reduce((sum,image) => sum + Buffer.byteLength(image.data,'base64'), 0);
    if (bytes > 15 * 1024 * 1024) throw failure('AI_INPUT_TOO_LARGE', '本轮图像预览超过 15 MB，请拆分资料。', 422);
    const key = await credentials();
    if (fingerprint(key) !== credentialFingerprint) { verified = false; verifiedModels = []; lastSuccessAt = null; }
    const modelPath = `/v1/skills/models/${name}`;
    const [detailResponse, priceResponse, balanceResponse] = await Promise.all([
      request(modelPath, key), request(`${modelPath}/pricing`, key), request('/v1/skills/balance', key)
    ]);
    const detail = detailResponse.data;
    const pricing = priceResponse.data;
    const balance = balanceResponse.data;
    if (pricing.available_for_this_key === false || detail.available_for_this_key === false) throw failure('AI_MODEL_UNAVAILABLE', '当前 Key 没有该模型的可用渠道。', 503);
    const format = detail.api_format;
    if (!['openai','gemini','anthropic'].includes(format)) throw failure('AI_FORMAT_UNSUPPORTED', '该模型的调用协议尚未实现。', 422);
    const vision = (detail.tags ?? []).some(tag => /多模态|multimodal|vision/i.test(tag)) || (detail.params ?? []).some(param => param.name === 'attachments' && /图片|image/i.test(param.description || ''));
    if (images.length && !vision) throw failure('AI_VISION_UNVERIFIED', '服务目录未声明该模型支持图片，本次不发送图像。', 422);
    const groups = (pricing.channel_groups ?? []).filter(group => group.is_active === true && group.in_key_whitelist !== false && group.excluded_for_this_key !== true);
    if (!groups.length) throw failure('AI_MODEL_UNAVAILABLE', '没有可用于本次调用的模型渠道。', 503);
    const validPrice = value => Number.isFinite(value) && value >= 0;
    if (groups.some(group => group.billing_method !== '按token' || !validPrice(group.input_token_price) || !validPrice(group.output_token_price)
      || !validPrice(group.input_image_price ?? 0) || !Number.isSafeInteger(group.input_image_free_count ?? 0) || (group.input_image_free_count ?? 0) < 0)) throw failure('AI_PRICE_UNKNOWN', '无法核实本次语言模型费用，请先检查价格文档。', 503);
    // Conservative planning estimate, NOT a guaranteed bill: image tokenization and upstream reasoning vary.
    const estimatedInputTokens = Buffer.byteLength(system + prompt, 'utf8') + images.length * 6000;
    const estimatedCost = Math.max(...groups.map(group => (estimatedInputTokens * group.input_token_price + maxTokens * group.output_token_price) / 1_000_000 + Math.max(0, images.length - (group.input_image_free_count ?? 0)) * (group.input_image_price ?? 0)));
    if (!validPrice(estimatedCost)) throw failure('AI_PRICE_UNKNOWN', '本轮费用估算无效，尚未提交模型。', 503);
    const available = Math.min(Number(balance.balance), balance.api_key_quota?.limit > 0 ? Number(balance.api_key_quota.remaining ?? balance.api_key_quota.limit - balance.api_key_quota.used) : Infinity);
    if (!Number.isFinite(available) || available <= estimatedCost) throw failure('AI_BALANCE_LOW', '余额或 Key 剩余额度不足以覆盖本轮估算。', 402);
    if (estimatedCost > maxEstimatedCost) throw failure('AI_COST_LIMIT', '本轮估算超过本地单次费用上限，请减少资料或在本地配置调整上限。', 422, { estimatedCost, maxEstimatedCost });
    const identityText = image => ({ text:`以下图片对应资料 ${String(image.assetId ?? '').slice(0,100)}。` });
    let endpoint, body;
    if (format === 'gemini') {
      endpoint = `/v1beta/models/${name}:generateContent`;
      body = { systemInstruction:{parts:[{text:system}]}, contents:[{role:'user',parts:[{text:prompt}, ...images.flatMap(image => [identityText(image), {inline_data:{mime_type:image.mimeType,data:image.data}}])]}], generationConfig:{maxOutputTokens:maxTokens,responseMimeType:'application/json'} };
    } else if (format === 'anthropic') {
      endpoint = '/v1/messages';
      body = { model:name, max_tokens:maxTokens, system, messages:[{role:'user',content:[{type:'text',text:prompt},...images.flatMap(image => [{type:'text',...identityText(image)},{type:'image',source:{type:'base64',media_type:image.mimeType,data:image.data}}])]}] };
    } else {
      endpoint = '/v1/chat/completions';
      body = { model:name, stream:false, max_tokens:maxTokens, messages:[{role:'system',content:system},{role:'user',content:images.length ? [{type:'text',text:prompt},...images.flatMap(image => [{type:'text',...identityText(image)},{type:'image_url',image_url:{url:`data:${image.mimeType};base64,${image.data}`}}])] : prompt}] };
    }
    const start = Date.now();
    const callId = randomUUID();
    const journalFile = path.join(repoRoot,'local','ai-calls.ndjson');
    const journal = async value => { await fs.mkdir(path.dirname(journalFile),{recursive:true}); await fs.appendFile(journalFile,JSON.stringify({callId,model:name,stage,at:new Date().toISOString(),...value})+'\n'); };
    try { await journal({event:'submitting',estimatedCost}); }
    catch { throw failure('AI_LOCAL_STORAGE', '无法保存本地调用记录，本次未提交模型。', 503); }
    const warnings = [];
    const recordAfterSubmission = async value => {
      try { await journal(value); }
      catch { warnings.push('模型已提交，但部分本地调用日志保存失败；请按任务编号核对费用，不要重复提交。'); }
    };
    let response;
    try {
      response = await request(endpoint, key, { method:'POST', body });
      await recordAfterSubmission({event:'response-received',taskId:response.taskId});
    } catch (error) {
      await recordAfterSubmission({event:'failed-or-unknown',code:error.code,taskId:error.taskId??null,uncertain:error.uncertain??false});
      throw error;
    }
    const data = response.data;
    let text, finish;
    if (format === 'gemini') {
      text = (data.candidates?.[0]?.content?.parts ?? []).filter(part => !part.thought).map(part => part.text || '').join('');
      finish = data.candidates?.[0]?.finishReason;
    } else if (format === 'anthropic') {
      text = (data.content ?? []).filter(part => part.type === 'text').map(part => part.text || '').join(''); finish = data.stop_reason;
    } else { text = data.choices?.[0]?.message?.content; finish = data.choices?.[0]?.finish_reason; }
    if (typeof text !== 'string' || !text.trim() || ['length','MAX_TOKENS','max_tokens'].includes(finish)) throw failure('AI_INCOMPLETE_RESPONSE', '模型正文为空或被截断，未采用本次结果；请减少资料或调整输出上限。', 502, {taskId:response.taskId});
    verified = true; lastSuccessAt = new Date().toISOString(); verifiedModels = [...new Set([...verifiedModels,name])];
    credentialFingerprint = fingerprint(key);
    try {
      await fs.mkdir(path.dirname(receiptFile),{recursive:true});
      await fs.writeFile(receiptFile, JSON.stringify({provider:'yijing',models:verifiedModels,lastSuccessAt,credentialFingerprint},null,2));
    } catch { warnings.push('模型结果已收到，但连接回执未能保存；当前结果继续保留，请勿因此重复调用。'); }
    let cost = null;
    if (response.taskId && /^[a-zA-Z0-9_-]{1,100}$/.test(response.taskId)) {
      try { const receipt = (await request(`/v1/skills/task-status?task_id=${encodeURIComponent(response.taskId)}`, key)).data; if (receipt.is_final && Number.isFinite(receipt.cost)) cost = receipt.cost; } catch { /* A cost lookup failure does not discard an already completed call. */ }
    }
    const usage = data.usage || data.usageMetadata || null;
    await recordAfterSubmission({event:'completed',taskId:response.taskId,usage,cost});
    return { text, provider:'yijing', model:name, format, taskId:response.taskId, usage, cost, estimatedCost, costUnit:'算力', durationMs:Date.now()-start, completedAt:lastSuccessAt, warnings:[...new Set(warnings)] };
  }
  return { getStatus, complete };
}
