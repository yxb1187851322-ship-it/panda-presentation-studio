import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = async relative => JSON.parse(await readFile(path.join(root, relative), 'utf8'));
const index = await json('resources/design-library/index.json');
const coverage = await json('resources/design-library/coverage.json');
assert.equal(index.cards.length, new Set(index.cards.map(c => c.id)).size, 'duplicate card ID');
const originalRefs = new Set(coverage.sources.map(s => s.asset_id));
for (const card of index.cards) {
  assert(card.title && card.task_tags.length && card.media_tags.length);
  assert(card.media_tags.every(t => ['ppt', 'web', 'images'].includes(t)));
  assert.equal(card.rights, 'research_reference_only_reuse_not_verified');
  assert.equal(card.preview_ref, `${card.id}-preview`, 'preview reference must be an anonymous logical ID');
  assert(!path.win32.isAbsolute(card.card_path) && !card.card_path.split('/').includes('..'));
  const detail = await json(card.card_path);
  assert.equal(detail.card_id ?? detail.id, card.id);
  assert.equal(detail.preview_ref, card.preview_ref);
  assert(!('source_path' in detail) && !('preview_path' in detail));
  assert(!('preview_sha256' in detail), 'private source fingerprint must remain local');
  assert((await stat(path.join(root, card.card_path.replace(/\.json$/, '.md')))).isFile());
  if (detail.card !== undefined) {
    assert.equal(detail.card, `${card.id}.md`, 'detail Markdown name must match portable ID');
    assert((await stat(path.join(root, path.dirname(card.card_path), detail.card))).isFile());
  }
  if (card.source_page !== null) {
    const source = coverage.sources.find(s => s.id === card.source_id);
    assert(source && Number.isInteger(card.source_page) && card.source_page >= 1 && card.source_page <= source.pages);
    assert(source.reviewed_physical_pages.includes(card.source_page));
    assert(originalRefs.has(detail.source_ref));
  }
}
assert.equal(coverage.reviewed_cards, index.cards.length);
assert.equal(coverage.original_pages_visually_reviewed, index.cards.filter(c => c.source_page !== null).length);
assert.equal(coverage.unique_magazine_images_reviewed, index.cards.filter(c => c.source_page === null).length);
assert.equal(coverage.original_sources_with_a_reviewed_page, new Set(index.cards.filter(c => c.source_page !== null).map(c => c.source_id)).size);
assert.equal(coverage.archived_pages, coverage.sources.reduce((n,s) => n + s.pages, 0));
assert.equal(coverage.full_corpus_visually_reviewed, false);
console.log(JSON.stringify({ passed: true, cards: index.cards.length, private_registry: 'not_loaded',
  reviewed_original_pages: coverage.original_pages_visually_reviewed, reviewed_original_sources: coverage.original_sources_with_a_reviewed_page,
  archived_pages: coverage.archived_pages, validates: 'metadata and portable references only; no aesthetic or renderer claim' }, null, 2));
