import { boolean, enumValue, object, string, strings } from './contracts.mjs';

const MEDIA = ['ppt', 'web', 'images'];
const DENSITIES = ['low', 'medium', 'high'];

/** Map an index entry into reasoning metadata. Missing compatibility data remains unknown. */
export function mapResearchCard(card, { scope } = {}) {
  object(card, 'research_card');
  for (const key of ['id', 'title', 'source_id', 'review_status', 'rights']) string(card[key], `research_card.${key}`);
  for (const key of ['task_tags', 'media_tags', 'suitable_for', 'avoid']) strings(card[key], `research_card.${key}`);
  object(scope, 'scope');
  enumValue(scope.kind, ['public', 'project'], 'scope.kind');
  if (scope.kind === 'project') string(scope.project_id, 'scope.project_id');
  if (card.source_page !== null && (!Number.isSafeInteger(card.source_page) || card.source_page < 1)) throw new TypeError('research_card.source_page must be a positive page number or null');
  return {
    card_id: card.id,
    scope: scope.kind === 'project' ? { kind: 'project', project_id: scope.project_id } : { kind: 'public' },
    source: {
      source_id: card.source_id,
      locator: card.source_page === null ? 'source_image' : `page:${card.source_page}`,
      review_status: ['actual_preview_viewed', 'actual_image_viewed'].includes(card.review_status) ? 'observed' : 'unreviewed',
    },
    media: [...card.media_tags],
    task_tags: [...card.task_tags],
    text_densities: [],
    image_shapes: [],
    requires_changes: null,
    editable_strategy: 'unknown',
    design_logic: card.suitable_for.length ? card.suitable_for.join('；') : card.title,
    cautions: [...card.avoid],
    rights: {
      study: card.rights === 'research_reference_only_reuse_not_verified' ? 'allowed' : 'unknown',
      reproduce: 'unknown',
    },
  };
}

/** Returns design-reasoning candidates only. It does not license or return production assets. */
export function selectReferenceCandidates({ page_task, cards, limit = 5 }) {
  object(page_task, 'page_task');
  for (const key of ['project_id', 'page_task_id']) string(page_task[key], `page_task.${key}`);
  enumValue(page_task.medium, MEDIA, 'page_task.medium');
  enumValue(page_task.text_density, DENSITIES, 'page_task.text_density');
  strings(page_task.task_tags, 'page_task.task_tags', { nonempty: true });
  strings(page_task.image_shapes, 'page_task.image_shapes');
  strings(page_task.locked_elements, 'page_task.locked_elements');
  boolean(page_task.require_editable, 'page_task.require_editable');
  if (!Array.isArray(cards)) throw new TypeError('cards must be an array');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive safe integer');
  const ids = new Set(), candidates = [], excluded = [];

  for (const card of cards) {
    object(card, 'card');
    string(card.card_id, 'card.card_id');
    if (ids.has(card.card_id)) throw new TypeError(`duplicate card_id: ${card.card_id}`);
    ids.add(card.card_id);
    object(card.scope, 'card.scope');
    enumValue(card.scope.kind, ['public', 'project'], 'card.scope.kind');
    if (card.scope.kind === 'project') string(card.scope.project_id, 'card.scope.project_id');
    object(card.source, 'card.source');
    for (const key of ['source_id', 'locator']) string(card.source[key], `card.source.${key}`);
    enumValue(card.source.review_status, ['observed', 'unreviewed'], 'card.source.review_status');
    for (const key of ['media', 'task_tags', 'text_densities', 'image_shapes']) strings(card[key], `card.${key}`);
    if (card.requires_changes !== null) strings(card.requires_changes, 'card.requires_changes');
    if (card.cautions !== undefined) strings(card.cautions, 'card.cautions');
    card.media.forEach(value => enumValue(value, MEDIA, 'card.media'));
    card.text_densities.forEach(value => enumValue(value, DENSITIES, 'card.text_densities'));
    enumValue(card.editable_strategy, [true, false, 'unknown'], 'card.editable_strategy');
    string(card.design_logic, 'card.design_logic');
    object(card.rights, 'card.rights');
    enumValue(card.rights.study, ['allowed', 'unknown', 'forbidden'], 'card.rights.study');
    enumValue(card.rights.reproduce, ['licensed', 'unknown', 'forbidden'], 'card.rights.reproduce');

    const reasons = [];
    const tags = page_task.task_tags.filter(tag => card.task_tags.includes(tag));
    if (card.scope.kind === 'project' && card.scope.project_id !== page_task.project_id) reasons.push('reference_outside_project_scope');
    if (card.rights.study !== 'allowed') reasons.push('study_use_not_cleared');
    if (card.source.review_status !== 'observed') reasons.push('reference_not_observed');
    if (!card.media.includes(page_task.medium)) reasons.push('medium_mismatch');
    if (page_task.require_editable && card.editable_strategy === false) reasons.push('editable_strategy_missing');
    if (card.requires_changes?.some(element => page_task.locked_elements.includes(element))) reasons.push('locked_element_conflict');
    if (!tags.length) reasons.push('page_task_mismatch');
    if (reasons.length) {
      excluded.push({ card_id: card.card_id, reason_codes: reasons });
      continue;
    }
    const densityMatches = card.text_densities.includes(page_task.text_density);
    const shapes = page_task.image_shapes.filter(shape => card.image_shapes.includes(shape));
    candidates.push({
      card_id: card.card_id,
      score: tags.length * 5 + Number(densityMatches) * 2 + shapes.length,
      reasons: [
        `页任务匹配：${tags.join('、')}`,
        ...(densityMatches ? [`文字密度匹配：${page_task.text_density}`] : ['文字密度不同，需用本项目内容试排']),
        ...(shapes.length ? [`图像结构匹配：${shapes.join('、')}`] : ['图像结构需重新校准']),
        `可借鉴的方法：${card.design_logic}`,
      ],
      review_requirements: [
        ...(card.requires_changes === null ? ['锁定元素兼容性尚未核验'] : []),
        ...(page_task.require_editable && card.editable_strategy === 'unknown' ? ['原生可编辑实现尚未核验'] : []),
        ...(card.cautions || []).map(note => `参考卡限制：${note}`),
        '需使用本项目内容试排并复核；标签匹配不代表设计通过',
      ],
      use_mode: 'design_reasoning_only',
      asset_copy_authorized: false,
    });
  }
  candidates.sort((a, b) => b.score - a.score || (a.card_id < b.card_id ? -1 : a.card_id > b.card_id ? 1 : 0));
  return { page_task_id: page_task.page_task_id, candidates: candidates.slice(0, limit), excluded, asset_copy_authorized: false };
}
