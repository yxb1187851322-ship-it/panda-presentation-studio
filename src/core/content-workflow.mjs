// Structured state supplied by a reader/model adapter. This module does not infer
// intent from prose, verify source truth, render pages, or approve visual quality.
const MEDIA = ['ppt', 'web', 'images'];
const ROLES = ['project-asset', 'design-case', 'visual-reference', 'fixed-template'];
const COLLECTIONS = ['assets', 'dialogue', 'sources', 'statements', 'decisions', 'contentUnits', 'mappings', 'reviews', 'feedback'];
const SCOPES = { asset: 'assets', template: 'assets', statement: 'statements', decision: 'decisions', contentUnit: 'contentUnits', mapping: 'mappings' };
const UPSERTS = { upsertAsset: 'assets', upsertSource: 'sources', upsertStatement: 'statements', upsertDecision: 'decisions', upsertContentUnit: 'contentUnits', upsertMapping: 'mappings' };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const array = value => Array.isArray(value) ? value : [];
const clone = value => JSON.parse(JSON.stringify(value));
const issue = (code, path, message) => ({ code, path, message });
const fail = issues => { const error = new Error('Invalid content workflow'); error.code = 'WORKFLOW_INVALID'; error.issues = issues; throw error; };

function jsonIssues(value) {
  const issues = [], visiting = new Set();
  function walk(item, path) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || visiting.has(item)) { issues.push(issue('invalid_json', path, 'Use finite, acyclic JSON values only')); return; }
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) { issues.push(issue('invalid_json', path, 'Use plain JSON objects')); return; }
    visiting.add(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) walk(item[index], `${path}[${index}]`);
    } else for (const [key, child] of Object.entries(item)) walk(child, `${path}.${key}`);
    visiting.delete(item);
  }
  walk(value, '$');
  return issues;
}

function validate(state) {
  const issues = jsonIssues(state);
  if (issues.length) return issues;
  const add = (code, path, message) => issues.push(issue(code, path, message));
  const text = (value, path) => { if (!nonempty(value)) add('required_text', path, 'Expected nonempty text'); };
  const choice = (value, options, path) => { if (!options.includes(value)) add('invalid_value', path, `Expected one of: ${options.join(', ')}`); };
  const strings = (value, path, required = false) => {
    if (!Array.isArray(value)) { add('invalid_array', path, 'Expected an array'); return []; }
    if (required && !value.length) add('empty_array', path, 'At least one item is required');
    value.forEach((entry, index) => text(entry, `${path}[${index}]`));
    if (new Set(value).size !== value.length) add('duplicate_value', path, 'Duplicate entries are not allowed');
    return value;
  };
  if (!isObject(state)) return [issue('invalid_state', '$', 'Expected a workflow object')];
  if (state.schemaVersion !== 1) add('schema_version', 'schemaVersion', 'Unsupported schema version');
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) add('invalid_revision', 'revision', 'Expected a nonnegative safe integer');
  const maps = {};
  for (const key of COLLECTIONS) {
    maps[key] = new Map();
    if (!Array.isArray(state[key])) { add('invalid_array', key, 'Expected an array'); continue; }
    state[key].forEach((entry, index) => {
      const path = `${key}[${index}]`;
      if (!isObject(entry)) { add('invalid_record', path, 'Expected an object'); return; }
      text(entry.id, `${path}.id`);
      if (maps[key].has(entry.id)) add('duplicate_id', `${path}.id`, 'ID already exists in this collection');
      maps[key].set(entry.id, entry);
      if (!Number.isSafeInteger(entry.version) || entry.version < 1) add('invalid_version', `${path}.version`, 'Expected a positive record version');
      if (!Number.isSafeInteger(entry.updatedRevision) || entry.updatedRevision < 0 || entry.updatedRevision > state.revision) add('invalid_revision', `${path}.updatedRevision`, 'Record revision is outside workflow history');
    });
  }
  if (!Array.isArray(state.history)) add('invalid_array', 'history', 'Expected history entries');
  if (!isObject(state.brief)) add('invalid_brief', 'brief', 'Expected brief object');
  else {
    if (state.brief.mode !== undefined) choice(state.brief.mode, ['existing', 'co-create', 'layout'], 'brief.mode');
    for (const key of ['audience', 'purpose']) if (state.brief[key] !== undefined) text(state.brief[key], `brief.${key}`);
    strings(state.brief.outputs, 'brief.outputs').forEach(value => choice(value, MEDIA, 'brief.outputs'));
  }
  const records = key => [...maps[key].values()];
  function refs(value, key, path, required = false) {
    for (const id of strings(value, path, required)) if (!maps[key].has(id)) add('missing_reference', path, `${key} ID does not exist: ${id}`);
  }
  function scope(value, path) {
    if (!isObject(value)) { add('invalid_scope', path, 'Expected {kind, ids}'); return; }
    choice(value.kind, ['workflow', ...Object.keys(SCOPES)], `${path}.kind`);
    if (value.kind === 'workflow') {
      if (strings(value.ids, `${path}.ids`).length) add('invalid_scope', path, 'Workflow scope has no IDs');
    } else if (Object.hasOwn(SCOPES, value.kind)) {
      refs(value.ids, SCOPES[value.kind], `${path}.ids`, true);
      if (value.kind === 'template') for (const id of array(value.ids)) if (!array(maps.assets.get(id)?.roles).includes('fixed-template')) add('not_template', path, `Asset is not a fixed template: ${id}`);
    }
  }
  function evidence(value, path, { required = false, projectFact = false, observation = false } = {}) {
    if (!Array.isArray(value)) { add('invalid_array', path, 'Expected evidence references'); return; }
    if (required && !value.length) add('missing_evidence', path, 'This claim requires readable source evidence');
    value.forEach((ref, index) => {
      const at = `${path}[${index}]`;
      if (!isObject(ref)) { add('invalid_evidence', at, 'Expected {sourceId, locator}'); return; }
      text(ref.sourceId, `${at}.sourceId`); text(ref.locator, `${at}.locator`);
      const source = maps.sources.get(ref.sourceId);
      if (!source) { add('missing_reference', at, `Source does not exist: ${ref.sourceId}`); return; }
      if (source.assetId !== undefined) {
        const asset = maps.assets.get(source.assetId);
        if (!asset) return;
        if (asset.readStatus === 'unread' || (asset.readStatus === 'partial' && !array(asset.readScope).includes(ref.locator))) add('unread_evidence', at, 'Evidence locator is outside the declared reading scope');
        if (projectFact && !array(asset.roles).includes('project-asset')) add('reference_as_project_fact', at, 'Reference/template content cannot become a project fact without a project source');
      } else {
        const message = maps.dialogue.get(source.dialogueId);
        if (message && message.role !== 'user') add('assistant_as_evidence', at, 'Assistant prose is not independent source evidence');
        if (observation) add('observation_requires_asset', at, 'Visual observations require a read asset');
      }
    });
  }
  for (const item of records('assets')) {
    const path = `assets.${item.id}`;
    strings(item.roles, `${path}.roles`, true).forEach(value => choice(value, ROLES, `${path}.roles`));
    choice(item.readStatus, ['unread', 'partial', 'read'], `${path}.readStatus`);
    strings(item.readScope, `${path}.readScope`, item.readStatus === 'partial');
    if (item.readStatus === 'unread' && item.readScope?.length) add('unread_scope', path, 'Unread assets cannot have read scope');
  }
  for (const item of records('dialogue')) { choice(item.role, ['user', 'assistant'], `dialogue.${item.id}.role`); text(item.text, `dialogue.${item.id}.text`); }
  for (const item of records('sources')) {
    const path = `sources.${item.id}`;
    if ((item.assetId !== undefined) === (item.dialogueId !== undefined)) add('invalid_source', path, 'Bind exactly one assetId or dialogueId');
    else refs([item.assetId ?? item.dialogueId], item.assetId !== undefined ? 'assets' : 'dialogue', path, true);
  }
  for (const item of records('statements')) {
    const path = `statements.${item.id}`;
    choice(item.kind, ['fact', 'observation', 'interpretation', 'proposal'], `${path}.kind`);
    choice(item.scope, ['project', 'reference'], `${path}.scope`);
    text(item.text, `${path}.text`);
    evidence(item.evidence, `${path}.evidence`, { required: item.kind !== 'proposal', projectFact: item.kind === 'fact' && item.scope === 'project', observation: item.kind === 'observation' });
  }
  for (const item of records('decisions')) {
    const path = `decisions.${item.id}`;
    text(item.need, `${path}.need`); text(item.response, `${path}.response`); strings(item.actions, `${path}.actions`, true);
    choice(item.status, ['existing', 'interpretation', 'proposed'], `${path}.status`);
    refs(item.statementIds, 'statements', `${path}.statementIds`); refs(item.decisionIds, 'decisions', `${path}.decisionIds`);
    evidence(item.evidence, `${path}.evidence`, { required: item.status === 'existing', projectFact: item.status === 'existing' });
    if (item.status === 'existing' && array(item.statementIds).some(id => ['interpretation', 'proposal'].includes(maps.statements.get(id)?.kind))) add('inferred_existing_reason', path, 'An existing design reason cannot be justified by interpretations or new proposals');
    // Every existing node is checked, so an existing chain cannot hide an
    // interpretation/proposal further upstream behind another existing node.
    if (item.status === 'existing' && array(item.decisionIds).some(id => ['interpretation', 'proposed'].includes(maps.decisions.get(id)?.status))) add('inferred_existing_dependency', `${path}.decisionIds`, 'Existing design reasoning cannot depend on an interpretation or proposed design decision');
    if (state.brief?.mode === 'layout' && item.status === 'proposed') add('proposal_outside_scope', path, 'Layout-only mode does not authorize new design decisions');
  }
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) { add('decision_cycle', `decisions.${id}`, 'Decision dependencies must be acyclic'); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of array(maps.decisions.get(id)?.decisionIds)) if (maps.decisions.has(next)) visit(next);
    visiting.delete(id); visited.add(id);
  }
  for (const id of maps.decisions.keys()) visit(id);
  for (const item of records('contentUnits')) {
    const path = `contentUnits.${item.id}`;
    text(item.purpose, `${path}.purpose`);
    refs(item.statementIds, 'statements', `${path}.statementIds`); refs(item.decisionIds, 'decisions', `${path}.decisionIds`); refs(item.assetIds, 'assets', `${path}.assetIds`);
    strings(item.protectedDetails, `${path}.protectedDetails`);
    for (const id of array(item.assetIds)) if (!array(maps.assets.get(id)?.roles).includes('project-asset')) add('reference_as_asset', path, `Production asset must have project-asset role: ${id}`);
    if (!(item.statementIds?.length || item.decisionIds?.length || item.assetIds?.length)) add('empty_content', path, 'Content must link a statement, decision, or project asset');
  }
  for (const item of records('mappings')) {
    const path = `mappings.${item.id}`;
    choice(item.medium, MEDIA, `${path}.medium`); text(item.locator, `${path}.locator`);
    refs(item.contentUnitIds, 'contentUnits', `${path}.contentUnitIds`, true); refs(item.templateAssetIds, 'assets', `${path}.templateAssetIds`);
    for (const id of array(item.templateAssetIds)) if (!array(maps.assets.get(id)?.roles).includes('fixed-template')) add('not_template', path, `Template binding requires fixed-template role: ${id}`);
  }
  for (const item of records('reviews')) {
    const path = `reviews.${item.id}`;
    scope(item.scope, `${path}.scope`); choice(item.status, ['reviewed', 'needs_changes', 'stale'], `${path}.status`); text(item.record, `${path}.record`);
    if (!Number.isSafeInteger(item.reviewedRevision) || item.reviewedRevision < 0 || item.reviewedRevision > state.revision) add('invalid_revision', `${path}.reviewedRevision`, 'Invalid review revision');
  }
  for (const item of records('feedback')) {
    const path = `feedback.${item.id}`;
    refs([item.dialogueId], 'dialogue', `${path}.dialogueId`, true);
    if (maps.dialogue.get(item.dialogueId)?.role !== 'user') add('feedback_not_user', path, 'Feedback must refer to a user message');
    scope(item.scope, `${path}.scope`); choice(item.layer, ['intent', 'content', 'evidence', 'visual', 'medium'], `${path}.layer`); text(item.note, `${path}.note`);
  }
  return issues;
}

function assertValid(state) { const issues = validate(state); if (issues.length) fail(issues); }
function emptyImpact() { return { workflow: false, sourceIds: [], assetIds: [], templateIds: [], statementIds: [], decisionIds: [], contentUnitIds: [], mappingIds: [], reviewIds: [] }; }
function record(value, old, revision) { return { ...clone(value), version: (old?.version ?? 0) + 1, updatedRevision: revision }; }
function contentOnly(value) { if (!value) return value; const { version, updatedRevision, ...rest } = value; return rest; }
function same(left, right) { return JSON.stringify(contentOnly(left)) === JSON.stringify(contentOnly(right)); }

export function createContentWorkflow(options = {}) {
  if (!isObject(options)) fail([issue('invalid_input', '$', 'Expected an options object')]);
  const { brief = {}, assets = [] } = options;
  const incoming = jsonIssues({ brief, assets }); if (incoming.length) fail(incoming);
  if (!isObject(brief) || !Array.isArray(assets)) fail([issue('invalid_input', '$', 'Expected brief object and assets array')]);
  const state = { schemaVersion: 1, revision: 0, brief: { outputs: [], ...clone(brief) }, ...Object.fromEntries(COLLECTIONS.map(key => [key, []])), history: [], lastImpact: emptyImpact() };
  state.assets = assets.map(value => record({ readStatus: 'unread', readScope: [], ...value }, null, 0));
  state.history.push({ revision: 0, operations: [{ type: 'create', value: { brief: clone(state.brief), assets: clone(state.assets) } }], impact: emptyImpact() });
  assertValid(state);
  return state;
}

function impacted(state, seeds) {
  const impact = Object.fromEntries(Object.entries(seeds).map(([key, values]) => [key, key === 'workflow' ? values : new Set(values)]));
  const intersects = (values, set) => values.some(value => set.has(value));
  if (impact.workflow) for (const [collection, key] of [['assets', 'assetIds'], ['sources', 'sourceIds'], ['statements', 'statementIds'], ['decisions', 'decisionIds'], ['contentUnits', 'contentUnitIds'], ['mappings', 'mappingIds']]) state[collection].forEach(value => impact[key].add(value.id));
  for (const source of state.sources) if (impact.assetIds.has(source.assetId)) impact.sourceIds.add(source.id);
  for (const statement of state.statements) if (statement.evidence.some(ref => impact.sourceIds.has(ref.sourceId))) impact.statementIds.add(statement.id);
  let grew = true;
  while (grew) {
    const count = impact.decisionIds.size;
    for (const decision of state.decisions) if (intersects(decision.statementIds, impact.statementIds) || intersects(decision.decisionIds, impact.decisionIds) || decision.evidence.some(ref => impact.sourceIds.has(ref.sourceId))) impact.decisionIds.add(decision.id);
    grew = count !== impact.decisionIds.size;
  }
  for (const unit of state.contentUnits) if (intersects(unit.statementIds, impact.statementIds) || intersects(unit.decisionIds, impact.decisionIds) || intersects(unit.assetIds, impact.assetIds)) impact.contentUnitIds.add(unit.id);
  for (const mapping of state.mappings) if (intersects(mapping.contentUnitIds, impact.contentUnitIds) || intersects(mapping.templateAssetIds, impact.templateIds)) impact.mappingIds.add(mapping.id);
  const scopeKeys = { asset: 'assetIds', template: 'templateIds', statement: 'statementIds', decision: 'decisionIds', contentUnit: 'contentUnitIds', mapping: 'mappingIds' };
  const any = impact.workflow || Object.entries(impact).some(([key, set]) => key !== 'workflow' && key !== 'reviewIds' && set.size > 0);
  for (const review of state.reviews) if (any && (impact.workflow || review.scope.kind === 'workflow' || intersects(review.scope.ids, impact[scopeKeys[review.scope.kind]]))) impact.reviewIds.add(review.id);
  return Object.fromEntries(Object.entries(impact).map(([key, values]) => [key, key === 'workflow' ? values : [...values].sort()]));
}

export function applyContentWorkflow(current, change, options = {}) {
  if (!isObject(options)) fail([issue('invalid_input', 'options', 'Expected an options object')]);
  const { expectedRevision } = options;
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) fail([issue('invalid_revision', 'expectedRevision', 'Expected a nonnegative safe integer')]);
  assertValid(current);
  if (expectedRevision !== undefined && expectedRevision !== current.revision) {
    const error = new Error(`Workflow revision conflict: expected ${expectedRevision}, current ${current.revision}`);
    error.code = 'WORKFLOW_CONFLICT'; error.expectedRevision = expectedRevision; error.actualRevision = current.revision; throw error;
  }
  const incoming = jsonIssues(change); if (incoming.length) fail(incoming);
  const operations = isObject(change) && Array.isArray(change.operations) ? change.operations : [change];
  if (!operations.length) fail([issue('empty_change', 'operations', 'At least one explicit operation is required')]);
  if (current.revision === Number.MAX_SAFE_INTEGER) fail([issue('revision_overflow', 'revision', 'Revision cannot be incremented safely')]);
  const next = clone(current), revision = current.revision + 1, seeds = emptyImpact(), pendingReviews = [];
  next.revision = revision;
  const seedKeys = { assets: 'assetIds', sources: 'sourceIds', statements: 'statementIds', decisions: 'decisionIds', contentUnits: 'contentUnitIds', mappings: 'mappingIds' };
  const markScope = value => {
    if (value?.kind === 'workflow') seeds.workflow = true;
    else {
      const key = value?.kind === 'template' ? 'templateIds' : seedKeys[SCOPES[value?.kind]];
      if (key && Array.isArray(value.ids)) seeds[key].push(...value.ids);
    }
  };
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index], path = `operations[${index}]`;
    if (!isObject(operation) || !nonempty(operation.type) || !isObject(operation.value)) fail([issue('invalid_operation', path, 'Expected {type, value: object}')]);
    const value = clone(operation.value);
    if (operation.type === 'setBrief') {
      const merged = { ...next.brief, ...value };
      if (!same(next.brief, merged)) seeds.workflow = true;
      next.brief = merged;
    } else if (Object.hasOwn(UPSERTS, operation.type)) {
      const collection = UPSERTS[operation.type], at = next[collection].findIndex(item => item.id === value.id), old = next[collection][at];
      if (!nonempty(value.id)) fail([issue('required_text', `${path}.value.id`, 'Expected nonempty ID')]);
      if (same(old, value)) continue;
      const entry = record(value, old, revision);
      if (at < 0) next[collection].push(entry); else next[collection][at] = entry;
      seeds[seedKeys[collection]].push(value.id);
      if (collection === 'assets' && (array(old?.roles).includes('fixed-template') || array(value.roles).includes('fixed-template'))) seeds.templateIds.push(value.id);
    } else if (operation.type === 'appendDialogue' || operation.type === 'feedback') {
      const collection = operation.type === 'feedback' ? 'feedback' : 'dialogue';
      if (next[collection].some(item => item.id === value.id)) fail([issue('immutable_record', path, `${collection} IDs are append-only`)]);
      next[collection].push(record(value, null, revision));
      if (collection === 'feedback') markScope(value.scope);
    } else if (operation.type === 'recordReview') {
      if (!['reviewed', 'needs_changes'].includes(value.status)) fail([issue('invalid_value', `${path}.value.status`, 'New reviews must be reviewed or needs_changes')]);
      pendingReviews.push(value);
    } else fail([issue('unknown_operation', `${path}.type`, `Unsupported operation: ${operation.type}`)]);
  }
  // Validate before dependency traversal: malformed references never reach graph code.
  assertValid(next);
  next.lastImpact = impacted(next, seeds);
  for (const id of next.lastImpact.reviewIds) {
    const review = next.reviews.find(value => value.id === id);
    review.status = 'stale'; review.invalidatedRevision = revision; review.version++; review.updatedRevision = revision;
  }
  for (const value of pendingReviews) {
    const at = next.reviews.findIndex(item => item.id === value.id);
    const entry = record({ ...value, reviewedRevision: revision }, next.reviews[at], revision);
    if (at < 0) next.reviews.push(entry); else next.reviews[at] = entry;
  }
  next.history.push({ revision, operations: clone(operations), impact: clone(next.lastImpact) });
  assertValid(next);
  return next;
}

export function inspectContentWorkflow(state) {
  const issues = validate(state);
  if (!issues.length) {
    for (const key of ['mode', 'audience', 'purpose']) if (!state.brief[key]) issues.push(issue('brief_incomplete', `brief.${key}`, 'Required before production planning'));
    if (!state.brief.outputs.length) issues.push(issue('outputs_missing', 'brief.outputs', 'Choose at least one delivery medium'));
    if (!state.contentUnits.length) issues.push(issue('content_missing', 'contentUnits', 'No structured content has been prepared'));
    for (const unit of state.contentUnits) {
      for (const id of unit.assetIds) if (state.assets.find(value => value.id === id).readStatus === 'unread') issues.push(issue('asset_unread', `contentUnits.${unit.id}`, `Production asset has not been read: ${id}`));
      for (const medium of state.brief.outputs) if (!state.mappings.some(mapping => mapping.medium === medium && mapping.contentUnitIds.includes(unit.id))) issues.push(issue('mapping_missing', `contentUnits.${unit.id}`, `No ${medium} mapping for this content unit`));
    }
    for (const mapping of state.mappings) for (const id of mapping.templateAssetIds) if (state.assets.find(value => value.id === id).readStatus === 'unread') issues.push(issue('template_unread', `mappings.${mapping.id}`, `Template has not been read: ${id}`));
    for (const review of state.reviews) if (review.status !== 'reviewed') issues.push(issue('review_unresolved', `reviews.${review.id}`, `Review status: ${review.status}`));
  }
  return { readyForProduction: issues.length === 0, issues, revision: state?.revision ?? null };
}
