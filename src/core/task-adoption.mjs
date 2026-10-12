import {
  ADOPTION_STATUSES, SERVICE_STATUSES, boolean, dependencies, enumValue,
  object, sameVersions, staleDependencies, string, validateProject, versions,
} from './contracts.mjs';

/** Evaluate only. The host must persist terminal decisions and atomically apply commit_guard. */
export function evaluateTaskAdoption({ project, task, result = null }) {
  validateProject(project);
  object(task, 'task');
  for (const key of ['task_id', 'project_id', 'operation', 'output_slot', 'input_fingerprint']) string(task[key], `task.${key}`);
  versions(task.input_versions, 'task.input_versions');
  dependencies(task.depends_on, 'task.depends_on');
  enumValue(task.service_status, SERVICE_STATUSES, 'task.service_status');
  enumValue(task.adoption_status, ADOPTION_STATUSES, 'task.adoption_status');
  boolean(task.cancel_requested, 'task.cancel_requested');
  if (result !== null) {
    object(result, 'result');
    for (const key of ['project_id', 'task_id', 'input_fingerprint', 'artifact_ref']) string(result[key], `result.${key}`);
    versions(result.input_versions, 'result.input_versions');
  }

  const reasons = [];
  const stale = staleDependencies(task.input_versions, project.versions, task.depends_on);
  const projectMatches = task.project_id === project.project_id;
  const permitted = Object.hasOwn(project.permissions, task.operation) && project.permissions[task.operation] === true;
  const active = Object.hasOwn(project.active_tasks, task.output_slot) && project.active_tasks[task.output_slot] === task.task_id;
  const resultMatches = result !== null && result.project_id === task.project_id && result.task_id === task.task_id
    && result.input_fingerprint === task.input_fingerprint && sameVersions(result.input_versions, task.input_versions);
  if (!projectMatches) reasons.push('project_mismatch');
  if (task.adoption_status !== 'pending') reasons.push(`terminal_adoption_${task.adoption_status}`);
  if (task.cancel_requested) reasons.push('cancel_requested');
  if (!permitted) reasons.push('permission_not_granted');
  if (!active) reasons.push('task_not_current_for_output');
  if (stale.length) reasons.push('input_versions_changed');
  if (task.service_status !== 'succeeded') reasons.push(`service_${task.service_status}`);
  if (task.service_status === 'succeeded' && result === null) reasons.push('result_missing');
  if (result !== null && !resultMatches) reasons.push('result_binding_mismatch');

  let adoptionStatus = 'pending';
  if (task.adoption_status !== 'pending') adoptionStatus = task.adoption_status;
  else if (!projectMatches || (result !== null && !resultMatches)) adoptionStatus = 'rejected';
  else if (task.cancel_requested || task.service_status === 'canceled') adoptionStatus = 'canceled';
  else if (!permitted) adoptionStatus = 'rejected';
  else if (!active || stale.length) adoptionStatus = 'superseded';
  else if (task.service_status === 'failed') adoptionStatus = 'rejected';

  const canAdopt = reasons.length === 0;
  const nextActions = [];
  // A foreign project's task must never be used to query or cancel that project's service job.
  // Reconciliation continues even after local adoption became terminal; unknown is not canceled.
  if (projectMatches && task.service_status === 'outcome_unknown') nextActions.push('query_original_job');
  if (projectMatches && task.adoption_status === 'pending') {
    const stop = task.cancel_requested || !permitted || !active || stale.length > 0;
    if (stop) {
      nextActions.push('stop_local_queue_and_retries');
      if (['pending', 'running', 'outcome_unknown'].includes(task.service_status)) nextActions.push('request_upstream_cancel_if_supported');
    }
    if (task.service_status === 'succeeded' && !canAdopt) nextActions.push('retain_unadopted_result');
    if (task.service_status === 'failed' && !stop) nextActions.push('inspect_failure');
  }
  if (canAdopt) nextActions.push('commit_with_guard');

  return {
    can_adopt: canAdopt,
    service_status: task.service_status,
    adoption_status: adoptionStatus,
    reason_codes: reasons,
    stale_dependencies: stale,
    next_actions: nextActions,
    // This evaluator never authorizes a paid retry, including supported idempotent submissions.
    may_submit_new_request: false,
    commit_guard: canAdopt ? {
      project_id: project.project_id,
      expected_project_revision: project.revision,
      output_slot: task.output_slot,
      expected_task_id: task.task_id,
      expected_task_adoption_status: 'pending',
      expected_cancel_requested: false,
      expected_service_status: 'succeeded',
      input_fingerprint: task.input_fingerprint,
      input_versions: { ...task.input_versions },
      depends_on: [...task.depends_on],
    } : null,
  };
}
