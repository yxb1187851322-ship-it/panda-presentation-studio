/** Style assets are versioned candidates. These checks do not judge aesthetics or authenticate feedback. */
import { createHash } from 'node:crypto';
const STATES = ['candidate', 'trial', 'accepted', 'rejected'];
const KINDS = ['image', 'drawing', 'logo'];
const OUTPUTS = ['pptx', 'html', 'png'];
const fail = (path, message) => { throw new TypeError(`${path}: ${message}`); };
const object = (value, path) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  return value;
};
const string = (value, path) => {
  if (typeof value !== 'string' || !value.trim()) fail(path, 'must be a non-empty string');
  return value;
};
const number = (value, path, min = 0, max = Infinity) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(path, `must be a finite number between ${min} and ${max}`);
  return value;
};
const positive = (value, path) => {
  number(value, path);
  if (value === 0) fail(path, 'must be greater than zero');
  return value;
};
const choice = (value, choices, path) => {
  if (!choices.includes(value)) fail(path, `must be one of: ${choices.join(', ')}`);
  return value;
};
const list = (value, path, read, min = 0) => {
  if (!Array.isArray(value) || value.length < min) fail(path, `must be an array with at least ${min} entries`);
  return value.map((item, i) => read(item, `${path}[${i}]`));
};
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const clone = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fingerprint = value => createHash('sha256').update(JSON.stringify(definition(value))).digest('hex');

function definition(input) {
  object(input, 'profile');
  const origin = object(input.origin, 'origin');
  const tokens = object(input.tokens, 'tokens');
  const type = object(tokens.typography, 'tokens.typography');
  const colors = object(tokens.colors, 'tokens.colors');
  const spacing = object(tokens.spacing, 'tokens.spacing');
  const hex = (v, p) => {
    if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) fail(p, 'must be a six-digit hex color');
    return v;
  };
  const layout = object(input.layout, 'layout');
  const canvas = object(layout.canvas, 'layout.canvas');
  const constraints = object(input.constraints, 'constraints');
  const slots = list(layout.slots, 'layout.slots', (slot, path) => {
    object(slot, path);
    const result = {
      id: string(slot.id, `${path}.id`),
      role: choice(slot.role, [...KINDS, 'text'], `${path}.role`),
      x: number(slot.x, `${path}.x`, 0, 1), y: number(slot.y, `${path}.y`, 0, 1),
      width: positive(slot.width, `${path}.width`), height: positive(slot.height, `${path}.height`),
      fit: choice(slot.fit, ['contain', 'cover', 'none'], `${path}.fit`),
      required: slot.required !== false,
    };
    if (result.x + result.width > 1.000000001 || result.y + result.height > 1.000000001) fail(path, 'rectangle must stay inside normalized canvas');
    if (result.role !== 'text' && result.fit === 'none') fail(`${path}.fit`, 'media slots require contain or cover; stretching is unsupported');
    if (slot.required !== undefined && typeof slot.required !== 'boolean') fail(`${path}.required`, 'must be boolean');
    return result;
  }, 1);
  if (new Set(slots.map(s => s.id)).size !== slots.length) fail('layout.slots', 'slot ids must be unique');
  if (origin.productionAllowed !== undefined && typeof origin.productionAllowed !== 'boolean') fail('origin.productionAllowed', 'must be boolean');
  return {
    schemaVersion: 1,
    id: string(input.id, 'id'), name: string(input.name, 'name'), version: string(input.version, 'version'),
    origin: {
      kind: choice(origin.kind, ['authored', 'licensed-template', 'research-case'], 'origin.kind'),
      sourceRef: string(origin.sourceRef, 'origin.sourceRef'),
      productionAllowed: origin.productionAllowed === true,
      ...(origin.licenseRef === undefined ? {} : { licenseRef: string(origin.licenseRef, 'origin.licenseRef') }),
    },
    tokens: {
      typography: { fontFamily: string(type.fontFamily, 'tokens.typography.fontFamily'), headingPt: positive(type.headingPt, 'tokens.typography.headingPt'), bodyPt: positive(type.bodyPt, 'tokens.typography.bodyPt'), captionPt: positive(type.captionPt, 'tokens.typography.captionPt') },
      colors: { background: hex(colors.background, 'tokens.colors.background'), foreground: hex(colors.foreground, 'tokens.colors.foreground'), ...(colors.accent === undefined ? {} : { accent: hex(colors.accent, 'tokens.colors.accent') }) },
      spacing: { marginRatio: number(spacing.marginRatio, 'tokens.spacing.marginRatio', 0, 0.5), gutterRatio: number(spacing.gutterRatio, 'tokens.spacing.gutterRatio', 0, 0.5) },
    },
    layout: { canvas: { width: positive(canvas.width, 'layout.canvas.width'), height: positive(canvas.height, 'layout.canvas.height') }, slots },
    constraints: {
      contentTasks: list(constraints.contentTasks, 'constraints.contentTasks', string, 1),
      outputs: list(constraints.outputs, 'constraints.outputs', (v, p) => choice(v, OUTPUTS, p), 1),
      requiredAssetKinds: list(constraints.requiredAssetKinds ?? [], 'constraints.requiredAssetKinds', (v, p) => choice(v, KINDS, p)),
      minImageWidth: number(constraints.minImageWidth ?? 0, 'constraints.minImageWidth'),
      minImageHeight: number(constraints.minImageHeight ?? 0, 'constraints.minImageHeight'),
      imageAspectRatios: list(constraints.imageAspectRatios ?? [], 'constraints.imageAspectRatios', positive),
      aspectRatioTolerance: number(constraints.aspectRatioTolerance ?? 0.01, 'constraints.aspectRatioTolerance', 0, 0.1),
    },
    protections: { logo: 'preserve-original-contain', drawing: 'preserve-original-contain' },
  };
}

/** Create a candidate only. A research-case is never a production asset, even with a supplied rights flag. */
export function createStyleProfile(input) {
  return freeze({ ...definition(input), state: 'candidate', sample: null, sampleDefinitionFingerprint: null, approval: null, history: [] });
}

function sample(value, path = 'sample') {
  object(value, path);
  return Object.fromEntries(['id', 'version', 'profileVersion', 'artifactRef', 'renderRef'].map(key => [key, string(value[key], `${path}.${key}`)]));
}

function feedback(value) {
  object(value, 'feedback');
  const result = Object.fromEntries(['id', 'actorId', 'evidenceRef', 'quote', 'recordedAt'].map(key => [key, string(value[key], `feedback.${key}`)]));
  result.actorRole = choice(value.actorRole, ['user'], 'feedback.actorRole');
  if (!Number.isFinite(Date.parse(result.recordedAt))) fail('feedback.recordedAt', 'must be a parseable timestamp');
  return result;
}

function readProfile(value) {
  const base = definition(value);
  choice(value.state, STATES, 'profile.state');
  if (!Array.isArray(value.history)) fail('profile.history', 'must be an array');
  if (value.sample !== null) sample(value.sample, 'profile.sample');
  if (value.sampleDefinitionFingerprint !== null) string(value.sampleDefinitionFingerprint, 'profile.sampleDefinitionFingerprint');
  if (value.approval !== null) {
    object(value.approval, 'profile.approval');
    sample(value.approval.sample, 'profile.approval.sample');
    feedback(value.approval.feedback);
    string(value.approval.definitionFingerprint, 'profile.approval.definitionFingerprint');
  }
  return { ...base, state: value.state, sample: clone(value.sample), sampleDefinitionFingerprint: value.sampleDefinitionFingerprint, approval: clone(value.approval), history: clone(value.history) };
}

/** Immutable transition. Rejected assets need a separately versioned candidate; exceptions never erase rejection. */
export function recordStyleFeedback(profile, event) {
  const next = readProfile(profile);
  object(event, 'event');
  const action = choice(event.action, ['trial', 'accept', 'reject'], 'event.action');
  if (action === 'trial') {
    if (next.state === 'rejected') fail('event.action', 'rejected profiles cannot enter reusable trial; use inspectStyleFit with a task-only explicit request');
    const trial = sample(event.sample);
    if (trial.profileVersion !== next.version) fail('sample.profileVersion', 'must match the current profile version');
    if (next.sample && next.sampleDefinitionFingerprint !== fingerprint(next) && trial.id === next.sample.id && trial.version === next.sample.version) fail('sample.version', 'a changed style definition needs a new rendered sample version');
    next.state = 'trial'; next.sample = trial; next.sampleDefinitionFingerprint = fingerprint(next); next.approval = null;
    next.history.push({ action, taskId: string(event.taskId, 'event.taskId'), sample: trial, definitionFingerprint: next.sampleDefinitionFingerprint });
  } else {
    const evidence = feedback(event.feedback);
    if (next.history.some(item => item.feedback?.id === evidence.id)) fail('feedback.id', 'has already been recorded');
    if (action === 'accept') {
      if (next.state !== 'trial') fail('event.action', 'accept requires an active trial');
      if (next.origin.kind === 'research-case' || !next.origin.productionAllowed) fail('origin', 'research or unlicensed material cannot become an accepted production asset');
      if (next.origin.kind === 'licensed-template' && !next.origin.licenseRef) fail('origin.licenseRef', 'is required for a licensed production template');
      const accepted = sample(event.sample);
      if (accepted.profileVersion !== next.version || !equal(accepted, next.sample)) fail('sample', 'acceptance must reference the exact current trial sample, version, artifact and render');
      if (next.sampleDefinitionFingerprint !== fingerprint(next)) fail('sample', 'style definition changed after the trial; render a new trial sample before acceptance');
      next.state = 'accepted'; next.approval = { sample: accepted, definitionFingerprint: next.sampleDefinitionFingerprint, feedback: evidence };
    } else {
      next.state = 'rejected'; next.approval = null;
    }
    next.history.push({ action, sample: clone(next.sample), feedback: evidence });
  }
  return freeze(next);
}

/** Returns technical/content eligibility only. Caller must still render, review and authenticate user feedback. */
export function inspectStyleFit(profile, request) {
  const current = readProfile(profile);
  object(request, 'request');
  const taskId = string(request.taskId, 'request.taskId');
  const contentTask = string(request.contentTask, 'request.contentTask');
  const output = choice(request.output, OUTPUTS, 'request.output');
  const assets = list(request.assets, 'request.assets', (asset, path) => {
    object(asset, path);
    if (asset.noCrop !== undefined && typeof asset.noCrop !== 'boolean') fail(`${path}.noCrop`, 'must be boolean');
    return { id: string(asset.id, `${path}.id`), kind: choice(asset.kind, KINDS, `${path}.kind`), width: positive(asset.width, `${path}.width`), height: positive(asset.height, `${path}.height`), noCrop: asset.noCrop === true };
  });
  if (new Set(assets.map(a => a.id)).size !== assets.length) fail('request.assets', 'asset ids must be unique');
  const placements = list(request.placements, 'request.placements', (placement, path) => {
    object(placement, path);
    return { assetId: string(placement.assetId, `${path}.assetId`), slotId: string(placement.slotId, `${path}.slotId`) };
  });
  if (new Set(placements.map(p => p.slotId)).size !== placements.length) fail('request.placements', 'a slot cannot receive multiple assets');
  let explicit = false;
  if (request.explicitStyleRequest !== undefined) {
    const value = object(request.explicitStyleRequest, 'request.explicitStyleRequest');
    ['profileId', 'profileVersion', 'taskId', 'evidenceRef', 'quote'].forEach(key => string(value[key], `request.explicitStyleRequest.${key}`));
    choice(value.actorRole, ['user'], 'request.explicitStyleRequest.actorRole');
    if (value.profileId !== current.id || value.profileVersion !== current.version || value.taskId !== taskId) fail('request.explicitStyleRequest', 'must identify this exact profile version and task');
    explicit = true;
  }
  const reasons = [];
  const block = (code, message) => reasons.push({ code, message });
  if (current.origin.kind === 'research-case') block('research-only', 'Research cases are learning evidence, not production assets.');
  if (!current.origin.productionAllowed || (current.origin.kind === 'licensed-template' && !current.origin.licenseRef)) block('rights-unconfirmed', 'Production use requires recorded permission and any applicable license reference.');
  if (current.state === 'rejected' && !explicit) block('rejected', 'User-rejected style cannot be recommended.');
  if (current.state === 'accepted' && (!current.approval || !current.sample || current.approval.sample.profileVersion !== current.version || !equal(current.approval.sample, current.sample) || current.approval.definitionFingerprint !== fingerprint(current) || current.sampleDefinitionFingerprint !== fingerprint(current))) block('stale-approval', 'Approval does not match the current style definition and rendered sample version.');
  const rules = current.constraints;
  if (!rules.contentTasks.includes(contentTask)) block('content-task', `Unsupported content task: ${contentTask}.`);
  if (!rules.outputs.includes(output)) block('output', `Unsupported output: ${output}.`);
  for (const kind of rules.requiredAssetKinds) if (!assets.some(a => a.kind === kind)) block('missing-asset-kind', `Required asset kind is missing: ${kind}.`);
  for (const asset of assets) {
    if (!placements.some(p => p.assetId === asset.id)) block('unplaced-asset', `Asset ${asset.id} has no placement.`);
    if (asset.kind === 'image') {
      if (asset.width < rules.minImageWidth || asset.height < rules.minImageHeight) block('image-dimensions', `Image ${asset.id} is ${asset.width}×${asset.height}; minimum is ${rules.minImageWidth}×${rules.minImageHeight}.`);
      if (rules.imageAspectRatios.length && !rules.imageAspectRatios.some(ratio => Math.abs(asset.width / asset.height / ratio - 1) <= rules.aspectRatioTolerance)) block('image-aspect-ratio', `Image ${asset.id} aspect ratio does not match the configured ratios.`);
    }
  }
  for (const slot of current.layout.slots) if (slot.role !== 'text' && slot.required && !placements.some(p => p.slotId === slot.id)) block('empty-slot', `Required media slot ${slot.id} is empty.`);
  for (const placement of placements) {
    const asset = assets.find(a => a.id === placement.assetId);
    const slot = current.layout.slots.find(s => s.id === placement.slotId);
    if (!asset) fail('request.placements', `unknown asset: ${placement.assetId}`);
    if (!slot) fail('request.placements', `unknown slot: ${placement.slotId}`);
    if (slot.role !== asset.kind) block('slot-role', `${asset.id} (${asset.kind}) cannot occupy ${slot.id} (${slot.role}).`);
    if (['logo', 'drawing'].includes(asset.kind) && slot.fit !== 'contain') block('protected-asset', `${asset.kind} ${asset.id} must use contain to preserve the complete original.`);
    const ratio = (slot.width * current.layout.canvas.width) / (slot.height * current.layout.canvas.height);
    // A no-crop promise cannot use a broad aesthetic tolerance: cover crops even a slight mismatch.
    if (asset.noCrop && slot.fit === 'cover' && Math.abs(asset.width / asset.height / ratio - 1) > 1e-9) block('no-crop', `Asset ${asset.id} is ${asset.width}×${asset.height}, while slot ${slot.id} has aspect ratio ${ratio}; cover would crop it.`);
  }
  const eligible = reasons.length === 0;
  return freeze({
    profileId: current.id, profileVersion: current.version, profileState: current.state, taskId,
    eligible, decision: eligible ? (explicit ? 'task-trial' : 'candidate') : 'blocked',
    scope: explicit ? 'this-task-only' : 'candidate-selection', reasons,
    evidenceStatus: 'fields-recorded-not-authenticated',
    reviewRequired: ['rendered-layout-review', 'user-feedback'],
  });
}
