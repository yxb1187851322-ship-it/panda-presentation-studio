import { boolean, dependencies, enumValue, object, staleDependencies, string, strings, validateProject, versions } from './contracts.mjs';

/** Validates supplied evidence records; it does not render, inspect files, or fabricate evidence. */
export function evaluateDelivery({ project, artifact, evidence }) {
  validateProject(project);
  object(artifact, 'artifact');
  for (const key of ['project_id', 'artifact_id', 'version', 'format']) string(artifact[key], `artifact.${key}`);
  strings(artifact.unit_ids, 'artifact.unit_ids', { nonempty: true });
  versions(artifact.input_versions, 'artifact.input_versions');
  dependencies(artifact.depends_on, 'artifact.depends_on');
  boolean(artifact.exists, 'artifact.exists');
  boolean(artifact.editable_required, 'artifact.editable_required');
  object(evidence, 'evidence');

  const blockers = [], acceptanceIssues = [];
  const add = (check, code) => blockers.push({ check, code });
  const matches = check => check.project_id === artifact.project_id
    && check.artifact_id === artifact.artifact_id && check.artifact_version === artifact.version;
  const covers = check => Array.isArray(check.checked_units) && artifact.unit_ids.every(id => check.checked_units.includes(id));
  const hasText = value => typeof value === 'string' && value.trim().length > 0;
  const hasStrings = value => {
    if (!Array.isArray(value) || !value.length) return false;
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index) || !hasText(value[index])) return false;
    }
    return true;
  };
  const validateCheck = (name, statuses) => {
    const check = object(evidence[name], `evidence.${name}`);
    enumValue(check.status, statuses, `evidence.${name}.status`);
    if (check.checked_units !== undefined) strings(check.checked_units, `evidence.${name}.checked_units`);
    if (check.issues !== undefined) {
      if (!Array.isArray(check.issues)) throw new TypeError(`evidence.${name}.issues must be an array`);
      for (let index = 0; index < check.issues.length; index++) {
        if (!Object.hasOwn(check.issues, index)) throw new TypeError(`evidence.${name}.issues must not contain sparse slots`);
        const issue = check.issues[index];
        object(issue, `evidence.${name}.issue`);
        enumValue(issue.severity, ['blocking', 'warning'], `evidence.${name}.issue.severity`);
        string(issue.code, `evidence.${name}.issue.code`);
      }
    }
    return check;
  };

  if (artifact.project_id !== project.project_id) add('artifact', 'project_mismatch');
  if (!artifact.exists) add('artifact', 'artifact_not_verified_present');
  const stale = staleDependencies(artifact.input_versions, project.versions, artifact.depends_on);
  if (stale.length) add('artifact', 'artifact_inputs_stale');

  const render = validateCheck('render', ['not_run', 'passed', 'failed']);
  if (render.status !== 'passed') add('render', 'render_not_passed');
  else {
    if (!matches(render)) add('render', 'render_artifact_mismatch');
    if (render.method !== 'actual_render') add('render', 'actual_render_required');
    if (!hasText(render.run_id) || !hasText(render.tool_id) || !hasStrings(render.output_refs)) add('render', 'render_evidence_missing');
    if (!covers(render)) add('render', 'render_coverage_incomplete');
  }
  if (render.issues?.some(issue => issue.severity === 'blocking')) add('render', 'render_blocking_issue');

  const technical = validateCheck('technical', ['not_run', 'passed', 'failed']);
  if (technical.status !== 'passed') add('technical', 'technical_not_passed');
  else {
    if (!matches(technical)) add('technical', 'technical_artifact_mismatch');
    if (!hasText(technical.run_id) || !hasText(technical.tool_id)) add('technical', 'technical_evidence_missing');
    if (!covers(technical)) add('technical', 'technical_coverage_incomplete');
    if (artifact.editable_required && technical.native_editable !== true) add('technical', 'native_editability_not_verified');
    if (!Array.isArray(technical.issues)) add('technical', 'technical_issue_review_missing');
  }
  if (technical.issues?.some(issue => issue.severity === 'blocking')) add('technical', 'technical_blocking_issue');

  const visual = validateCheck('visual', ['not_run', 'passed', 'needs_changes', 'unable_to_assess']);
  if (visual.status !== 'passed') add('visual', 'visual_not_passed');
  else {
    if (!matches(visual)) add('visual', 'visual_artifact_mismatch');
    if (!hasText(visual.review_id) || !hasText(visual.reviewer)) add('visual', 'visual_evidence_missing');
    if (!hasText(render.run_id) || visual.render_run_id !== render.run_id) add('visual', 'visual_render_mismatch');
    if (!covers(visual)) add('visual', 'visual_coverage_incomplete');
    if (!Array.isArray(visual.issues)) add('visual', 'visual_issue_review_missing');
  }
  if (visual.issues?.some(issue => issue.severity === 'blocking')) add('visual', 'visual_blocking_issue');

  const user = validateCheck('user', ['not_obtained', 'approved', 'changes_requested']);
  if (user.status !== 'not_obtained') {
    if (!matches(user)) acceptanceIssues.push('user_artifact_mismatch');
    if (!hasText(user.decision_ref)) acceptanceIssues.push('user_decision_evidence_missing');
    if (user.status === 'approved' && !covers(user)) acceptanceIssues.push('user_approval_partial');
    if (user.status === 'changes_requested' && !user.checked_units?.some(id => artifact.unit_ids.includes(id))) acceptanceIssues.push('user_request_scope_missing');
  }
  const approved = user.status === 'approved' && acceptanceIssues.length === 0;
  const changesRequested = user.status === 'changes_requested' && acceptanceIssues.length === 0;
  const complete = blockers.length === 0;
  return {
    production_complete: complete,
    ready_for_delivery: complete && !changesRequested,
    user_approved: approved,
    status: !complete ? 'needs_work' : approved ? 'accepted' : changesRequested ? 'changes_requested' : 'ready_for_delivery',
    checks: {
      render: render.status, technical: technical.status, visual: visual.status, user: user.status,
    },
    verified_checks: Object.fromEntries(['render', 'technical', 'visual'].map(check => [check, !blockers.some(item => item.check === check)])),
    blockers,
    acceptance_issues: acceptanceIssues,
    stale_dependencies: stale,
  };
}
