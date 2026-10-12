import test from 'node:test';
import assert from 'node:assert/strict';
import { createContentWorkflow, applyContentWorkflow, inspectContentWorkflow } from '../src/core/content-workflow.mjs';

// All sources and messages here are synthetic. Structural tests are not proof
// that a model read these documents or that a presentation was produced.
const op = (type, value) => ({ type, value });
const apply = (state, ...operations) => applyContentWorkflow(state, { operations }, { expectedRevision: state.revision });
const asset = (id, roles = ['project-asset']) => ({ id, roles, readStatus: 'read', readScope: ['page:1'] });
const evidence = (sourceId = 'source-plan', locator = 'page:1') => [{ sourceId, locator }];
const statement = (id = 'fact-name', text = '入口为迎宾厅') => ({ id, kind: 'fact', scope: 'project', text, evidence: evidence() });
const decision = (id = 'decision-entry', extra = {}) => ({ id, need: '解释入口组织', response: '以入口界面解释到达顺序', actions: ['标明入口与界面'], status: 'existing', statementIds: ['fact-name'], decisionIds: [], evidence: evidence(), ...extra });
const unit = (id, extra = {}) => ({ id, purpose: '说明一个具体内容', statementIds: [], decisionIds: [], assetIds: [], protectedDetails: [], ...extra });
const mapping = (id, contentUnitId, medium = 'ppt', templates = []) => ({ id, medium, locator: `${medium}:${id}`, contentUnitIds: [contentUnitId], templateAssetIds: templates });
const review = (id, kind, ids) => ({ id, scope: { kind, ids }, status: 'reviewed', record: 'Synthetic structural review record' });
const invalid = (run, code) => assert.throws(run, error => error.code === 'WORKFLOW_INVALID' && Array.isArray(error.issues) && (!code || error.issues.some(item => item.code === code)));

function prepared() {
  let state = createContentWorkflow({ brief: { mode: 'existing', audience: '业主', purpose: '解释已定方案', outputs: ['ppt', 'web', 'images'] }, assets: [asset('plan'), asset('photo'), asset('template', ['fixed-template'])] });
  state = apply(state,
    op('appendDialogue', { id: 'message-1', role: 'user', text: '请向业主解释入口安排，三端都输出。' }),
    op('upsertSource', { id: 'source-plan', assetId: 'plan' }),
    op('upsertSource', { id: 'source-user', dialogueId: 'message-1' }),
    op('upsertStatement', statement()),
    op('upsertDecision', decision()),
    op('upsertDecision', decision('decision-detail', { decisionIds: ['decision-entry'], statementIds: [] })),
    op('upsertContentUnit', unit('entry', { decisionIds: ['decision-detail'] })),
    op('upsertContentUnit', unit('photo-only', { assetIds: ['photo'] })),
    ...['ppt', 'web', 'images'].flatMap(medium => [op('upsertMapping', mapping(`${medium}-entry`, 'entry', medium, ['template'])), op('upsertMapping', mapping(`${medium}-photo`, 'photo-only', medium))]),
    op('recordReview', review('review-entry', 'contentUnit', ['entry'])),
    op('recordReview', review('review-photo', 'contentUnit', ['photo-only'])),
    op('recordReview', review('review-web', 'mapping', ['web-entry'])),
    op('recordReview', review('review-all', 'workflow', [])));
  return state;
}

test('empty creation is explicitly unready and does not infer meaning from free text', () => {
  const state = createContentWorkflow();
  assert.equal(state.revision, 0);
  assert.deepEqual(state.brief, { outputs: [] });
  assert.equal(inspectContentWorkflow(state).readyForProduction, false);
  const after = apply(state, op('appendDialogue', { id: 'u1', role: 'user', text: '做一个有品位的住宅方案，200平方米。' }));
  assert.equal(after.statements.length, 0);
  assert.equal(after.decisions.length, 0);
  assert.equal(after.history.length, 2);
});

test('create and atomic apply return detached JSON, preserving current state and inputs', () => {
  const input = { brief: { outputs: ['ppt'] }, assets: [asset('a')] }, original = structuredClone(input);
  const state = createContentWorkflow(input);
  state.assets[0].roles.push('visual-reference');
  assert.deepEqual(input, original);
  const current = prepared(), before = structuredClone(current), change = op('upsertStatement', statement('fact-name', '入口为前厅')), copy = structuredClone(change);
  const next = applyContentWorkflow(current, change, { expectedRevision: current.revision });
  next.assets[0].roles.push('visual-reference');
  assert.deepEqual(current, before);
  assert.deepEqual(change, copy);
  assert.deepEqual(JSON.parse(JSON.stringify(current)), before);
});

test('completed content graph is structurally ready without claiming production or approval', () => {
  const report = inspectContentWorkflow(prepared());
  assert.deepEqual(report, { readyForProduction: true, issues: [], revision: 1 });
  assert.equal(Object.hasOwn(report, 'userApproved'), false);
  assert.equal(Object.hasOwn(report, 'factVerified'), false);
});

test('stale writer conflicts carry expected and current revisions', () => {
  const current = prepared();
  assert.throws(() => applyContentWorkflow(current, op('setBrief', { audience: '团队' }), { expectedRevision: 0 }), error => error.code === 'WORKFLOW_CONFLICT' && error.expectedRevision === 0 && error.actualRevision === 1);
});

test('failed batch commits nothing and rejects free text operations', () => {
  const current = prepared(), before = structuredClone(current);
  invalid(() => apply(current, op('setBrief', { audience: '团队' }), op('upsertStatement', { ...statement(), evidence: evidence('missing') })), 'missing_reference');
  assert.deepEqual(current, before);
  invalid(() => applyContentWorkflow(current, '从这句话自动理解'), 'invalid_operation');
});

test('references can be supplied in a single atomic batch regardless of order', () => {
  const state = createContentWorkflow({ assets: [asset('plan')] });
  const next = apply(state, op('upsertStatement', statement()), op('upsertSource', { id: 'source-plan', assetId: 'plan' }));
  assert.equal(next.statements.length, 1);
});

test('reject missing source, asset, decision, and content references', () => {
  const state = prepared();
  for (const operation of [op('upsertSource', { id: 'bad', assetId: 'missing' }), op('upsertStatement', { ...statement('bad'), evidence: evidence('missing') }), op('upsertContentUnit', unit('bad', { decisionIds: ['missing'] })), op('upsertMapping', mapping('bad', 'missing'))]) invalid(() => apply(state, operation), 'missing_reference');
});

test('partial reading accepts exact inspected locators and rejects uninspected pages', () => {
  let state = createContentWorkflow({ assets: [{ ...asset('plan'), readStatus: 'partial', readScope: ['page:1'] }] });
  state = apply(state, op('upsertSource', { id: 'source-plan', assetId: 'plan' }), op('upsertStatement', statement()));
  invalid(() => apply(state, op('upsertStatement', { ...statement('bad'), evidence: evidence('source-plan', 'page:2') })), 'unread_evidence');
});

test('unread assets cannot substantiate a fact even when the source exists', () => {
  const state = createContentWorkflow({ assets: [{ id: 'plan', roles: ['project-asset'] }] });
  invalid(() => apply(state, op('upsertSource', { id: 'source-plan', assetId: 'plan' }), op('upsertStatement', statement())), 'unread_evidence');
});

test('assistant messages and case facts cannot become project facts', () => {
  let state = createContentWorkflow({ assets: [asset('case', ['design-case'])] });
  state = apply(state, op('appendDialogue', { id: 'assistant', role: 'assistant', text: '这是我的猜测。' }), op('upsertSource', { id: 'assistant-source', dialogueId: 'assistant' }), op('upsertSource', { id: 'case-source', assetId: 'case' }));
  invalid(() => apply(state, op('upsertStatement', { ...statement(), evidence: evidence('assistant-source', 'message') })), 'assistant_as_evidence');
  invalid(() => apply(state, op('upsertStatement', { ...statement(), evidence: evidence('case-source') })), 'reference_as_project_fact');
  const reference = apply(state, op('upsertStatement', { ...statement(), scope: 'reference', evidence: evidence('case-source') }));
  assert.equal(reference.statements[0].scope, 'reference');
});

test('explicit user messages can support facts but not visual observations', () => {
  const state = prepared();
  const value = { ...statement('user-fact'), evidence: evidence('source-user', 'message:1') };
  assert.equal(apply(state, op('upsertStatement', value)).statements.at(-1).kind, 'fact');
  invalid(() => apply(state, op('upsertStatement', { ...value, kind: 'observation' })), 'observation_requires_asset');
});

test('existing author reasoning cannot be promoted from an interpretation', () => {
  const state = prepared();
  invalid(() => apply(state, op('upsertStatement', { ...statement('guess'), kind: 'interpretation' }), op('upsertDecision', decision('invented-history', { statementIds: ['guess'] }))), 'inferred_existing_reason');
  assert.equal(apply(state, op('upsertDecision', decision('hypothesis', { status: 'interpretation' }))).decisions.at(-1).status, 'interpretation');
});

test('existing reasoning rejects direct and transitive interpretation/proposal dependencies', () => {
  for (const status of ['interpretation', 'proposed']) {
    const state = prepared();
    invalid(() => apply(state,
      op('upsertDecision', decision('unconfirmed', { status, evidence: [] })),
      op('upsertDecision', decision('claim-original', { decisionIds: ['unconfirmed'] }))
    ), 'inferred_existing_dependency');
    invalid(() => apply(state,
      op('upsertDecision', decision('unconfirmed', { status, evidence: [] })),
      op('upsertDecision', decision('middle-original', { decisionIds: ['unconfirmed'] })),
      op('upsertDecision', decision('claim-original', { decisionIds: ['middle-original'] }))
    ), 'inferred_existing_dependency');
    const changedDependency = () => apply(state, op('upsertDecision', decision('decision-entry', { status, evidence: [] })));
    invalid(changedDependency, 'inferred_existing_dependency');
    assert.equal(state.decisions[0].status, 'existing', 'failed batch preserves the original chain');
  }
});

test('layout-only work refuses a new design decision; proposal remains explicitly typed in co-creation', () => {
  const state = apply(prepared(), op('setBrief', { mode: 'layout' }));
  invalid(() => apply(state, op('upsertDecision', decision('new', { status: 'proposed', evidence: [] }))), 'proposal_outside_scope');
  const coCreate = apply(state, op('setBrief', { mode: 'co-create' }), op('upsertStatement', { id: 'proposal', kind: 'proposal', scope: 'project', text: '建议比较入口开合', evidence: [] }), op('upsertDecision', decision('new', { status: 'proposed', evidence: [], statementIds: ['proposal'] })));
  assert.equal(coCreate.statements.at(-1).kind, 'proposal');
});

test('fact changes invalidate transitive reasoning and all dependent media, preserving unrelated reviews', () => {
  const state = prepared(), next = apply(state, op('upsertStatement', statement('fact-name', '入口为前厅')));
  assert.deepEqual(next.lastImpact.decisionIds, ['decision-detail', 'decision-entry']);
  assert.deepEqual(next.lastImpact.contentUnitIds, ['entry']);
  assert.deepEqual(next.lastImpact.mappingIds, ['images-entry', 'ppt-entry', 'web-entry']);
  assert.equal(next.reviews.find(item => item.id === 'review-entry').status, 'stale');
  assert.equal(next.reviews.find(item => item.id === 'review-photo').status, 'reviewed');
  assert.equal(inspectContentWorkflow(next).readyForProduction, false);
  assert.equal(next.statements[0].version, 2);
  assert.equal(state.history[1].operations.find(item => item.type === 'upsertStatement').value.text, '入口为迎宾厅');
  assert.equal(next.history.at(-1).operations[0].value.text, '入口为前厅');
});

test('analysis changes also invalidate dependent review and can be explicitly re-reviewed', () => {
  const state = prepared();
  const changed = apply(state, op('upsertDecision', decision('decision-entry', { response: '增加清楚的对照解释' })));
  assert.deepEqual(changed.lastImpact.contentUnitIds, ['entry']);
  const reviewed = apply(changed, ...changed.reviews.filter(item => item.status === 'stale').map(item => op('recordReview', { id: item.id, scope: item.scope, status: 'reviewed', record: 'Synthetic fresh recheck' })));
  assert.equal(inspectContentWorkflow(reviewed).readyForProduction, true);
  assert.equal(reviewed.reviews[0].reviewedRevision, reviewed.revision);
});

test('local feedback affects the selected medium without rewriting content or other outputs', () => {
  const state = prepared();
  const next = apply(state, op('appendDialogue', { id: 'feedback-message', role: 'user', text: '只改网页入口页字距。' }), op('feedback', { id: 'feedback-1', dialogueId: 'feedback-message', layer: 'medium', scope: { kind: 'mapping', ids: ['web-entry'] }, note: '调整网页入口字距' }));
  assert.deepEqual(next.lastImpact.mappingIds, ['web-entry']);
  assert.deepEqual(next.lastImpact.contentUnitIds, []);
  assert.deepEqual(next.statements, state.statements);
  assert.equal(next.reviews.find(item => item.id === 'review-entry').status, 'reviewed');
  assert.equal(next.reviews.find(item => item.id === 'review-web').status, 'stale');
});

test('template feedback and project material scope are separate', () => {
  const state = prepared();
  const next = apply(state, op('appendDialogue', { id: 'u2', role: 'user', text: '模板标题太重。' }), op('feedback', { id: 'f2', dialogueId: 'u2', layer: 'visual', scope: { kind: 'template', ids: ['template'] }, note: '调整模板标题重量' }));
  assert.deepEqual(next.lastImpact.templateIds, ['template']);
  assert.deepEqual(next.lastImpact.assetIds, []);
  assert.deepEqual(next.lastImpact.contentUnitIds, []);
  assert.deepEqual(next.lastImpact.mappingIds, ['images-entry', 'ppt-entry', 'web-entry']);
  invalid(() => apply(state, op('upsertMapping', mapping('bad', 'entry', 'ppt', ['photo']))), 'not_template');
  invalid(() => apply(state, op('upsertContentUnit', unit('bad', { assetIds: ['template'] }))), 'reference_as_asset');
});

test('reading corrections cannot silently preserve claims from withdrawn evidence', () => {
  const state = prepared();
  invalid(() => apply(state, op('upsertAsset', { ...asset('plan'), readStatus: 'unread', readScope: [] })), 'unread_evidence');
});

test('dialogue and feedback are append-only and feedback must have a user source', () => {
  const state = prepared();
  invalid(() => apply(state, op('appendDialogue', { id: 'message-1', role: 'user', text: '覆盖历史' })), 'immutable_record');
  invalid(() => apply(state, op('appendDialogue', { id: 'a1', role: 'assistant', text: '假定认可' }), op('feedback', { id: 'bad', dialogueId: 'a1', layer: 'content', scope: { kind: 'workflow', ids: [] }, note: '认可' })), 'feedback_not_user');
});

test('decision dependencies reject self and multi-node cycles', () => {
  const state = prepared();
  invalid(() => apply(state, op('upsertDecision', decision('decision-entry', { decisionIds: ['decision-entry'] }))), 'decision_cycle');
  invalid(() => apply(state, op('upsertDecision', decision('decision-entry', { decisionIds: ['decision-detail'] }))), 'decision_cycle');
});

test('a no-op upsert does not invalidate review or increment the record version', () => {
  const state = prepared(), next = apply(state, op('upsertStatement', statement()));
  assert.equal(next.revision, state.revision + 1);
  assert.equal(next.statements[0].version, state.statements[0].version);
  assert.deepEqual(next.lastImpact.reviewIds, []);
});

test('malformed JSON and graph fields return structured issues, not raw exceptions', () => {
  invalid(() => createContentWorkflow(null));
  invalid(() => createContentWorkflow({ assets: [new Date()] }), 'invalid_json');
  const state = prepared();
  for (const value of [null, undefined, NaN, new Date(), { x: undefined }]) invalid(() => applyContentWorkflow(state, value));
  const circular = {}; circular.self = circular;
  invalid(() => applyContentWorkflow(state, circular), 'invalid_json');
  for (const [collection, field] of [['decisions', 'statementIds'], ['decisions', 'decisionIds'], ['contentUnits', 'assetIds'], ['mappings', 'templateAssetIds'], ['assets', 'roles']]) {
    const malformed = structuredClone(state); malformed[collection][0][field] = {};
    assert.equal(inspectContentWorkflow(malformed).readyForProduction, false);
  }
  assert.equal(inspectContentWorkflow(null).readyForProduction, false);
});

test('missing media mapping and unread production assets prevent readiness', () => {
  let state = createContentWorkflow({ brief: { mode: 'layout', audience: '读者', purpose: '图片展示', outputs: ['ppt'] }, assets: [{ id: 'photo', roles: ['project-asset'] }] });
  state = apply(state, op('upsertContentUnit', unit('picture', { assetIds: ['photo'] })));
  const codes = inspectContentWorkflow(state).issues.map(item => item.code);
  assert.ok(codes.includes('mapping_missing'));
  assert.ok(codes.includes('asset_unread'));
});

test('reserved object property names cannot bypass operation or scope validation', () => {
  const state = prepared();
  for (const type of ['toString', 'constructor', '__proto__']) invalid(() => apply(state, op(type, {})), 'unknown_operation');
  for (const kind of ['toString', 'constructor', '__proto__']) invalid(() => apply(state, op('recordReview', review('bad', kind, []))), 'invalid_value');
});
