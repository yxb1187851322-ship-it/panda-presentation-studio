import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateTaskAdoption, selectReferenceCandidates, mapResearchCard, evaluateDelivery, VERSION_KEYS } from '../src/core/index.mjs';

const example = JSON.parse(await readFile(new URL('../examples/project.json', import.meta.url), 'utf8'));
const fixture = () => structuredClone(example);
const reasons = report => report.reason_codes;
const blocks = report => report.blockers.map(item => item.code);

// Synthetic evidence exercises contracts; it is never proof of a real rendering or file.
function succeeded(input = fixture()) {
  input.task.service_status = 'succeeded';
  input.result = {
    project_id: input.task.project_id,
    task_id: input.task.task_id,
    input_fingerprint: input.task.input_fingerprint,
    input_versions: { ...input.task.input_versions },
    artifact_ref: 'synthetic-test-result',
  };
  return input;
}

function reviewed(input = fixture()) {
  const a = input.artifact;
  a.exists = true;
  const binding = { project_id: a.project_id, artifact_id: a.artifact_id, artifact_version: a.version, checked_units: [...a.unit_ids] };
  input.evidence = {
    render: { ...binding, status: 'passed', method: 'actual_render', run_id: 'synthetic-render', tool_id: 'test-fixture', output_refs: ['synthetic-page-previews'] },
    technical: { ...binding, status: 'passed', run_id: 'synthetic-technical', tool_id: 'test-fixture', native_editable: true, issues: [] },
    visual: { ...binding, status: 'passed', review_id: 'synthetic-visual', reviewer: 'test-fixture', render_run_id: 'synthetic-render', issues: [] },
    user: { status: 'not_obtained' },
  };
  return input;
}

function approve(input) {
  input.evidence.user = {
    status: 'approved', project_id: input.artifact.project_id, artifact_id: input.artifact.artifact_id,
    artifact_version: input.artifact.version, checked_units: [...input.artifact.unit_ids], decision_ref: 'synthetic-user-decision',
  };
  return input;
}

test('self-contained example makes no generation or completion claim', () => {
  const input = fixture();
  assert.equal(evaluateTaskAdoption(input).can_adopt, false);
  const report = evaluateDelivery(input);
  assert.equal(report.production_complete, false);
  assert.equal(report.user_approved, false);
  assert.ok(blocks(report).includes('render_not_passed'));
});

test('current successful task returns an atomic commit guard without mutating inputs', () => {
  const input = succeeded(), before = structuredClone(input);
  const report = evaluateTaskAdoption(input);
  assert.equal(report.can_adopt, true);
  assert.equal(report.adoption_status, 'pending'); // Not adopted until host commit succeeds.
  assert.equal(report.commit_guard.expected_project_revision, 3);
  assert.equal(report.commit_guard.expected_task_id, input.task.task_id);
  assert.equal(report.commit_guard.expected_task_adoption_status, 'pending');
  assert.deepEqual(report.commit_guard.depends_on, input.task.depends_on);
  assert.equal(report.may_submit_new_request, false);
  report.commit_guard.input_versions.asset = 'changed-return-value';
  report.commit_guard.depends_on.push('changed-return-value');
  assert.deepEqual(input, before);
});

test('each declared dependency rejects a stale successful result', () => {
  for (const key of VERSION_KEYS) {
    const input = succeeded();
    input.project.versions[key] += '-new';
    const report = evaluateTaskAdoption(input);
    assert.equal(report.can_adopt, false, key);
    assert.equal(report.adoption_status, 'superseded', key);
    assert.deepEqual(report.stale_dependencies, [key]);
    assert.equal(report.commit_guard, null);
  }
});

test('undeclared unrelated changes do not invalidate a task, but commit guard binds current revision', () => {
  const input = succeeded();
  input.task.depends_on = ['asset', 'permission'];
  input.project.versions.content = 'new-unrelated-content';
  input.project.revision = 4;
  assert.equal(evaluateTaskAdoption(input).can_adopt, true);
  assert.equal(evaluateTaskAdoption(input).commit_guard.expected_project_revision, 4);
});

test('new task for the same output supersedes an older one even with identical input versions', () => {
  const input = succeeded();
  input.project.active_tasks.hero_image = 'replacement-task';
  const report = evaluateTaskAdoption(input);
  assert.equal(report.can_adopt, false);
  assert.equal(report.adoption_status, 'superseded');
  assert.ok(reasons(report).includes('task_not_current_for_output'));
});

test('unknown upstream result never permits adoption or a new request', () => {
  const input = fixture();
  input.task.service_status = 'outcome_unknown';
  const report = evaluateTaskAdoption(input);
  assert.equal(report.service_status, 'outcome_unknown');
  assert.equal(report.adoption_status, 'pending');
  assert.equal(report.can_adopt, false);
  assert.equal(report.may_submit_new_request, false);
  assert.deepEqual(report.next_actions, ['query_original_job']);
});

test('revoked permission and changed logo preserve unknown service state while prohibiting adoption', () => {
  const input = fixture();
  input.task.service_status = 'outcome_unknown';
  input.project.permissions.image_outpaint = false;
  input.project.versions.permission = 'p2';
  input.project.versions.brand = 'b2';
  const report = evaluateTaskAdoption(input);
  assert.equal(report.service_status, 'outcome_unknown');
  assert.equal(report.adoption_status, 'rejected');
  assert.equal(report.can_adopt, false);
  assert.ok(report.next_actions.includes('stop_local_queue_and_retries'));
  assert.ok(report.next_actions.includes('request_upstream_cancel_if_supported'));
  assert.ok(reasons(report).includes('permission_not_granted'));
});

test('local cancellation cannot claim upstream cancellation, and a late success stays canceled', () => {
  const input = fixture();
  input.task.cancel_requested = true;
  input.task.service_status = 'running';
  assert.equal(evaluateTaskAdoption(input).service_status, 'running');
  const late = succeeded(input);
  const report = evaluateTaskAdoption(late);
  assert.equal(report.service_status, 'succeeded');
  assert.equal(report.adoption_status, 'canceled');
  assert.equal(report.can_adopt, false);
  assert.ok(report.next_actions.includes('retain_unadopted_result'));
});

test('upstream confirmed cancel, failure, pending and running cannot be adopted', () => {
  for (const status of ['canceled', 'failed', 'pending', 'running']) {
    const input = fixture(); input.task.service_status = status;
    const report = evaluateTaskAdoption(input);
    assert.equal(report.can_adopt, false, status);
    assert.equal(report.may_submit_new_request, false, status);
  }
});

test('terminal adoption decisions cannot be revived or committed twice', () => {
  for (const state of ['adopted', 'rejected', 'canceled', 'superseded']) {
    const input = succeeded(); input.task.adoption_status = state;
    const report = evaluateTaskAdoption(input);
    assert.equal(report.can_adopt, false, state);
    assert.equal(report.adoption_status, state);
    assert.equal(report.commit_guard, null);
  }
});

test('locally terminal decisions still reconcile unknown upstream execution without reviving adoption', () => {
  for (const state of ['rejected', 'canceled', 'superseded']) {
    const input = fixture(); input.task.adoption_status = state; input.task.service_status = 'outcome_unknown';
    const report = evaluateTaskAdoption(input);
    assert.equal(report.can_adopt, false, state);
    assert.equal(report.adoption_status, state);
    assert.equal(report.service_status, 'outcome_unknown');
    assert.deepEqual(report.next_actions, ['query_original_job']);
    assert.equal(report.may_submit_new_request, false);
  }
});

test('cross-project task cannot authorize adoption or side-effect suggestions against another project', () => {
  const input = succeeded(); input.project.project_id = 'different-project';
  const report = evaluateTaskAdoption(input);
  assert.equal(report.adoption_status, 'rejected');
  assert.deepEqual(report.next_actions, []);
});

test('missing or mismatched result binding is rejected', () => {
  const missing = succeeded(); missing.result = null;
  assert.ok(reasons(evaluateTaskAdoption(missing)).includes('result_missing'));
  for (const key of ['project_id', 'task_id', 'input_fingerprint']) {
    const input = succeeded(); input.result[key] = 'wrong-binding';
    assert.ok(reasons(evaluateTaskAdoption(input)).includes('result_binding_mismatch'), key);
  }
  const input = succeeded(); input.result.input_versions.asset = 'other-input';
  assert.equal(evaluateTaskAdoption(input).adoption_status, 'rejected');
});

test('missing permission and omitted or misspelled dependencies fail closed', () => {
  const input = succeeded(); delete input.project.permissions.image_outpaint;
  assert.ok(reasons(evaluateTaskAdoption(input)).includes('permission_not_granted'));
  input.task.depends_on = ['asset'];
  assert.throws(() => evaluateTaskAdoption(input), /must include permission/);
  input.task.depends_on = ['assets', 'permission'];
  assert.throws(() => evaluateTaskAdoption(input), /must be one of/);
  input.task.depends_on = ['asset', 'permission']; delete input.task.input_versions.brand;
  assert.throws(() => evaluateTaskAdoption(input), /input_versions.brand/);
});

test('reference selection explains design relevance without authorizing copies', () => {
  const input = fixture(), before = structuredClone(input);
  const result = selectReferenceCandidates(input);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].card_id, 'fictional-reasoning-card');
  assert.equal(result.candidates[0].use_mode, 'design_reasoning_only');
  assert.equal(result.candidates[0].asset_copy_authorized, false);
  assert.equal(result.asset_copy_authorized, false);
  assert.ok(result.candidates[0].reasons.some(reason => reason.includes('共用对齐轴')));
  assert.ok(result.excluded[0].reason_codes.includes('reference_outside_project_scope'));
  assert.deepEqual(input, before);
});

test('licensed source still does not turn research selection into a production asset grant', () => {
  const input = fixture(); input.cards[0].rights.reproduce = 'licensed';
  input.cards[0].asset_path = 'do-not-return-this-asset.png';
  const result = selectReferenceCandidates(input);
  assert.equal(result.candidates[0].asset_copy_authorized, false);
  assert.equal(JSON.stringify(result).includes('do-not-return-this-asset'), false);
});

test('brand locks, medium, editable requirements, unread sources and study rights are enforced before scoring', () => {
  const changes = [
    [card => { card.requires_changes = ['logo']; }, 'locked_element_conflict'],
    [card => { card.media = ['images']; }, 'medium_mismatch'],
    [card => { card.editable_strategy = false; }, 'editable_strategy_missing'],
    [card => { card.source.review_status = 'unreviewed'; }, 'reference_not_observed'],
    [card => { card.rights.study = 'unknown'; }, 'study_use_not_cleared'],
    [card => { card.task_tags = ['cover']; }, 'page_task_mismatch'],
  ];
  for (const [change, expected] of changes) {
    const input = fixture(); change(input.cards[0]);
    const result = selectReferenceCandidates(input);
    assert.equal(result.candidates.length, 0, expected);
    assert.ok(result.excluded[0].reason_codes.includes(expected));
  }
});

test('no usable reference returns no forced fallback; duplicate IDs are invalid', () => {
  const input = fixture(); input.cards = [];
  assert.deepEqual(selectReferenceCandidates(input).candidates, []);
  input.cards = [fixture().cards[0], fixture().cards[0]];
  assert.throws(() => selectReferenceCandidates(input), /duplicate card_id/);
});

test('reference ranking is deterministic and limit selects candidates without claiming approval', () => {
  const input = fixture(), other = structuredClone(input.cards[0]);
  other.card_id = 'aaa-card'; input.cards.push(other);
  const result = selectReferenceCandidates({ ...input, limit: 1 });
  assert.deepEqual(result.candidates.map(card => card.card_id), ['aaa-card']);
  assert.equal(result.candidates[0].asset_copy_authorized, false);
});

test('resource index mapping needs explicit scope and does not guess compatibility from prose', () => {
  const source = {
    id: 'research-1', title: '研究卡', source_id: 'source-1', source_page: 2,
    task_tags: ['space_explanation'], media_tags: ['ppt'], suitable_for: ['一张横图配密集说明'],
    avoid: ['内容太多时不能强塞'], review_status: 'actual_preview_viewed',
    rights: 'research_reference_only_reuse_not_verified', card_path: 'private/card.json',
  };
  assert.throws(() => mapResearchCard(source), /scope must be an object/);
  const mapped = mapResearchCard(source, { scope: { kind: 'project', project_id: 'fictional-hotel' } });
  assert.deepEqual(mapped.image_shapes, []);
  assert.deepEqual(mapped.text_densities, []);
  assert.equal(mapped.requires_changes, null);
  assert.equal(mapped.editable_strategy, 'unknown');
  const result = selectReferenceCandidates({ page_task: fixture().page_task, cards: [mapped] });
  assert.equal(result.candidates.length, 1);
  assert.ok(result.candidates[0].review_requirements.includes('锁定元素兼容性尚未核验'));
  assert.ok(result.candidates[0].review_requirements.includes('原生可编辑实现尚未核验'));
  assert.equal(result.candidates[0].asset_copy_authorized, false);
  assert.equal(JSON.stringify(result).includes('private/card.json'), false);
  source.source_page = null; source.review_status = 'actual_image_viewed';
  assert.equal(mapResearchCard(source, { scope: { kind: 'public' } }).source.locator, 'source_image');
});

test('mapping unknown research rights or unobserved pages does not silently approve access', () => {
  const source = {
    id: 'research-1', title: '研究卡', source_id: 'source-1', source_page: null,
    task_tags: ['space_explanation'], media_tags: ['ppt'], suitable_for: [], avoid: [],
    review_status: 'unread', rights: 'unknown',
  };
  const mapped = mapResearchCard(source, { scope: { kind: 'project', project_id: 'fictional-hotel' } });
  const result = selectReferenceCandidates({ page_task: fixture().page_task, cards: [mapped] });
  assert.equal(result.candidates.length, 0);
  assert.ok(result.excluded[0].reason_codes.includes('reference_not_observed'));
  assert.ok(result.excluded[0].reason_codes.includes('study_use_not_cleared'));
});

test('rendered, technically checked and visually reviewed artifact can be delivered without inventing user approval', () => {
  const input = reviewed(), before = structuredClone(input);
  const report = evaluateDelivery(input);
  assert.equal(report.production_complete, true);
  assert.equal(report.ready_for_delivery, true);
  assert.equal(report.user_approved, false);
  assert.equal(report.status, 'ready_for_delivery');
  assert.deepEqual(input, before);
  assert.equal(evaluateDelivery(approve(input)).status, 'accepted');
});

test('static checks and user approval cannot substitute for an actual rendering', () => {
  const input = approve(reviewed());
  input.evidence.render.method = 'static_check';
  const report = evaluateDelivery(input);
  assert.equal(report.production_complete, false);
  assert.equal(report.ready_for_delivery, false);
  assert.equal(report.user_approved, true); // User evidence stays separate.
  assert.ok(blocks(report).includes('actual_render_required'));
});

test('missing render outputs and partial render or review coverage prevent completion', () => {
  const noOutput = reviewed(); noOutput.evidence.render.output_refs = [];
  assert.ok(blocks(evaluateDelivery(noOutput)).includes('render_evidence_missing'));
  for (const check of ['render', 'technical', 'visual']) {
    const input = reviewed(); input.evidence[check].checked_units = ['cover'];
    const report = evaluateDelivery(input);
    assert.equal(report.production_complete, false, check);
    assert.ok(blocks(report).includes(`${check}_coverage_incomplete`));
  }
});

test('old artifact evidence and a visual review of another render cannot be reused', () => {
  for (const check of ['render', 'technical', 'visual']) {
    const input = reviewed(); input.evidence[check].artifact_version = 'old';
    assert.ok(blocks(evaluateDelivery(input)).includes(`${check}_artifact_mismatch`), check);
  }
  const input = reviewed(); input.evidence.visual.render_run_id = 'another-render';
  assert.ok(blocks(evaluateDelivery(input)).includes('visual_render_mismatch'));
});

test('new project inputs or a foreign artifact prevent delivery of apparently passed output', () => {
  const stale = reviewed(); stale.project.versions.brand = 'b2';
  assert.ok(blocks(evaluateDelivery(stale)).includes('artifact_inputs_stale'));
  const foreign = reviewed(); foreign.project.project_id = 'other-project';
  assert.ok(blocks(evaluateDelivery(foreign)).includes('project_mismatch'));
});

test('blocking issues cannot be averaged away by a passed status', () => {
  for (const check of ['render', 'technical', 'visual']) {
    const input = reviewed(); input.evidence[check].issues = [{ severity: 'blocking', code: 'logo_distorted' }];
    const report = evaluateDelivery(input);
    assert.equal(report.production_complete, false, check);
    assert.ok(blocks(report).includes(`${check}_blocking_issue`));
  }
});

test('requested changes retain production evidence but do not signal current user acceptance or readiness', () => {
  const input = approve(reviewed()); input.evidence.user.status = 'changes_requested';
  input.evidence.user.checked_units = ['cover'];
  const report = evaluateDelivery(input);
  assert.equal(report.production_complete, true);
  assert.equal(report.ready_for_delivery, false);
  assert.equal(report.user_approved, false);
  assert.equal(report.status, 'changes_requested');
});

test('old or unbound change requests cannot mark a different artifact as rejected by the user', () => {
  const input = approve(reviewed()); input.evidence.user.status = 'changes_requested';
  input.evidence.user.artifact_version = 'old';
  const report = evaluateDelivery(input);
  assert.equal(report.status, 'ready_for_delivery');
  assert.ok(report.acceptance_issues.includes('user_artifact_mismatch'));
  input.evidence.user = { status: 'changes_requested' };
  assert.ok(evaluateDelivery(input).acceptance_issues.includes('user_request_scope_missing'));
});

test('native editability, file presence and issue review must be explicitly evidenced', () => {
  const notEditable = reviewed(); notEditable.evidence.technical.native_editable = false;
  assert.ok(blocks(evaluateDelivery(notEditable)).includes('native_editability_not_verified'));
  const missing = reviewed(); missing.artifact.exists = false;
  assert.ok(blocks(evaluateDelivery(missing)).includes('artifact_not_verified_present'));
  const unchecked = reviewed(); delete unchecked.evidence.visual.issues;
  assert.ok(blocks(evaluateDelivery(unchecked)).includes('visual_issue_review_missing'));
});

test('partial or outdated user approval is never generalized to the whole new artifact', () => {
  const partial = approve(reviewed()); partial.evidence.user.checked_units = ['cover'];
  assert.equal(evaluateDelivery(partial).user_approved, false);
  assert.ok(evaluateDelivery(partial).acceptance_issues.includes('user_approval_partial'));
  const old = approve(reviewed()); old.evidence.user.artifact_version = 'old';
  assert.equal(evaluateDelivery(old).user_approved, false);
  assert.equal(evaluateDelivery(old).production_complete, true);
});

test('malformed evidence and unknown statuses do not silently pass', () => {
  const input = reviewed(); input.evidence.visual.status = 'beautiful';
  assert.throws(() => evaluateDelivery(input), /evidence.visual.status/);
  input.evidence.visual.status = 'passed'; input.evidence.visual.issues = 'none';
  assert.throws(() => evaluateDelivery(input), /issues must be an array/);
});

test('sparse artifact units cannot make empty checked coverage pass vacuously', () => {
  const input = reviewed();
  input.artifact.unit_ids = new Array(1);
  for (const check of ['render', 'technical', 'visual']) input.evidence[check].checked_units = [];
  assert.throws(() => evaluateDelivery(input), /artifact.unit_ids must not contain sparse slots/);
});

test('sparse checked units and inherited array entries are rejected explicitly', () => {
  for (const check of ['render', 'technical', 'visual', 'user']) {
    const input = reviewed(); input.evidence[check].checked_units = new Array(1);
    assert.throws(() => evaluateDelivery(input), new RegExp(`evidence.${check}.checked_units must not contain sparse slots`));
  }
  const input = reviewed(), inherited = new Array(1);
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: 'cover' }));
  input.artifact.unit_ids = inherited;
  assert.throws(() => evaluateDelivery(input), /artifact.unit_ids must not contain sparse slots/);
});

test('sparse, empty or blank render references cannot verify actual rendering', () => {
  const inherited = new Array(1);
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: 'inherited-reference' }));
  for (const refs of [new Array(1), ['synthetic-preview', ,], inherited, [], ['']]) {
    const input = reviewed(); input.evidence.render.output_refs = refs;
    const report = evaluateDelivery(input);
    assert.equal(report.production_complete, false);
    assert.equal(report.ready_for_delivery, false);
    assert.equal(report.verified_checks.render, false);
    assert.ok(blocks(report).includes('render_evidence_missing'));
  }
});

test('sparse issue records cannot masquerade as completed issue review', () => {
  for (const check of ['render', 'technical', 'visual', 'user']) {
    const input = reviewed(); input.evidence[check].issues = new Array(1);
    assert.throws(() => evaluateDelivery(input), new RegExp(`evidence.${check}.issues must not contain sparse slots`));
  }
});
