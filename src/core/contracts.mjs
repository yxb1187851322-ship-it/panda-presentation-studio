export const VERSION_KEYS = Object.freeze(['asset', 'content', 'brand', 'layout', 'permission']);
export const SERVICE_STATUSES = Object.freeze(['pending', 'running', 'succeeded', 'failed', 'outcome_unknown', 'canceled']);
export const ADOPTION_STATUSES = Object.freeze(['pending', 'adopted', 'rejected', 'canceled', 'superseded']);

export function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value;
}

export function string(value, path) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${path} must be a nonempty string`);
  return value;
}

export function boolean(value, path) {
  if (typeof value !== 'boolean') throw new TypeError(`${path} must be a boolean`);
  return value;
}

export function enumValue(value, choices, path) {
  if (!choices.includes(value)) throw new TypeError(`${path} must be one of ${choices.join(', ')}`);
  return value;
}

export function strings(value, path, { nonempty = false } = {}) {
  if (!Array.isArray(value) || (nonempty && !value.length)) throw new TypeError(`${path} must be ${nonempty ? 'a nonempty' : 'an'} array`);
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) throw new TypeError(`${path} must not contain sparse slots`);
    string(value[index], `${path}[${index}]`);
  }
  if (new Set(value).size !== value.length) throw new TypeError(`${path} must not contain duplicates`);
  return value;
}

export function versions(value, path) {
  object(value, path);
  VERSION_KEYS.forEach(key => string(value[key], `${path}.${key}`));
  return value;
}

export function dependencies(value, path) {
  strings(value, path, { nonempty: true });
  value.forEach(key => enumValue(key, VERSION_KEYS, path));
  if (!value.includes('permission')) throw new TypeError(`${path} must include permission`);
  return value;
}

export function validateProject(project) {
  object(project, 'project');
  string(project.project_id, 'project.project_id');
  if (!Number.isSafeInteger(project.revision) || project.revision < 0) throw new TypeError('project.revision must be a nonnegative safe integer');
  versions(project.versions, 'project.versions');
  object(project.permissions, 'project.permissions');
  Object.entries(project.permissions).forEach(([key, value]) => boolean(value, `project.permissions.${key}`));
  object(project.active_tasks, 'project.active_tasks');
  Object.entries(project.active_tasks).forEach(([key, value]) => string(value, `project.active_tasks.${key}`));
}

export function staleDependencies(input, current, dependsOn) {
  return dependsOn.filter(key => input[key] !== current[key]);
}

export function sameVersions(left, right) {
  return VERSION_KEYS.every(key => left[key] === right[key]);
}
