import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bundleProductionManifest, checkProductionManifest } from '../scripts/production-manifest.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPioAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'panda-production-'));
  t.after(() => fs.rm(baseDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(baseDir, 'sample.png'), png);
  return { baseDir, manifest: {
    schemaVersion: 1, id: 'synthetic-example', title: 'Test <script>not executed</script>', revision: 1,
    pages: [{ id: 'sample-1', title: 'Sample "page"', mode: 'reference-visual', imagePath: 'sample.png', notes: 'A speaker note.' }],
    sample: { status: 'draft', pageIds: ['sample-1'] },
  } };
}

test('a draft can be bundled without inventing content, visual or user approval; image bytes stay identical', async t => {
  const { baseDir, manifest } = await fixture(t);
  const result = await bundleProductionManifest(manifest, { baseDir, outputDir: path.join(baseDir, 'delivery') });
  assert.equal(result.report.ok, true);
  assert.ok(result.report.warnings.some(warning => warning.code === 'CONTENT_MAPPING_MISSING'));
  const receipt = JSON.parse(await fs.readFile(path.join(result.outputDir, 'production-receipt.json'), 'utf8'));
  assert.equal(receipt.sample.status, 'draft');
  assert.equal(receipt.review.visual.status, 'pending');
  assert.deepEqual(await fs.readFile(path.join(result.outputDir, receipt.pages[0].imagePath)), png);
  const html = await fs.readFile(path.join(result.outputDir, 'index.html'), 'utf8');
  assert.ok(html.includes('&lt;script&gt;not executed&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!JSON.stringify(receipt).includes(baseDir));
  assert.ok((await fs.readFile(path.join(result.outputDir, 'notes.md'), 'utf8')).includes('A speaker note.'));
  await assert.rejects(bundleProductionManifest(manifest, { baseDir, outputDir: result.outputDir }), { code: 'OUTPUT_NOT_EMPTY' });
});

test('fact evidence must resolve to an existing source; missing analysis remains a visible draft limitation', async t => {
  const { baseDir, manifest } = await fixture(t);
  manifest.contentUnits = [{ id: 'fact-1', kind: 'fact', text: 'A factual claim.', sourceRefs: [{ sourceId: 'missing', locator: 'page 4' }] }];
  manifest.pages[0].contentUnitIds = ['fact-1'];
  assert.ok((await checkProductionManifest(manifest, { baseDir })).errors.some(error => error.code === 'UNKNOWN_SOURCE'));
  manifest.sources = [{ id: 'missing', locator: 'user:current-request', readScope: '完整用户文字', summary: 'Requested content.' }];
  assert.equal((await checkProductionManifest(manifest, { baseDir })).ok, true);
});

test('candidate references do not become applied constraints without concrete comparison records', async t => {
  const { baseDir, manifest } = await fixture(t);
  manifest.references = [{ id: 'ref-1', path: 'sample.png', observations: ['Full page image.'], constraints: ['Keep image boundary.'] }];
  manifest.pages[0].referenceBinding = { referenceId: 'ref-1', status: 'candidate' };
  const candidate = await checkProductionManifest(manifest, { baseDir });
  assert.equal(candidate.ok, true);
  assert.ok(candidate.warnings.some(warning => warning.code === 'REFERENCE_CANDIDATE_ONLY'));
  manifest.pages[0].referenceBinding.status = 'applied';
  assert.ok((await checkProductionManifest(manifest, { baseDir })).errors.some(error => error.code === 'CONSTRAINT_CHECK_MISSING'));
  manifest.pages[0].referenceBinding.constraintChecks = [{ constraint: 'Keep image boundary.', result: 'matched', evidence: 'Reviewed preview: all four original edges visible.' }];
  assert.equal((await checkProductionManifest(manifest, { baseDir })).ok, true);
});

test('source facsimile preservation is checked against actual file bytes, not reference identifiers', async t => {
  const { baseDir, manifest } = await fixture(t);
  manifest.references = [{ id: 'ref-1', path: 'sample.png', observations: ['A complete source page.'] }];
  manifest.pages[0].mode = 'source-facsimile';
  manifest.pages[0].referenceBinding = { referenceId: 'ref-1', status: 'preserved' };
  assert.equal((await checkProductionManifest(manifest, { baseDir })).ok, true);
  await fs.writeFile(path.join(baseDir, 'other.png'), Buffer.concat([png, Buffer.from('changed')]));
  manifest.pages[0].imagePath = 'other.png';
  assert.ok((await checkProductionManifest(manifest, { baseDir })).errors.some(error => error.code === 'PRESERVED_BYTES_DIFFER'));
});

test('authorization to begin does not automatically mark a sample accepted', async t => {
  const { baseDir, manifest } = await fixture(t);
  manifest.sample.status = 'accepted';
  assert.ok((await checkProductionManifest(manifest, { baseDir })).errors.some(error => error.code === 'USER_EVIDENCE_REQUIRED'));
  manifest.sample.userEvidence = 'Synthetic test approval of sample-1 only.';
  assert.equal((await checkProductionManifest(manifest, { baseDir })).ok, true);
});

test('editable export claims require an existing evidence record and explicit scope', async t => {
  const { baseDir, manifest } = await fixture(t);
  await fs.writeFile(path.join(baseDir, 'sample.pptx'), 'Synthetic file; test verifies packaging only.');
  manifest.exports = [{ path: 'sample.pptx', format: 'pptx', type: 'editable' }];
  assert.ok((await checkProductionManifest(manifest, { baseDir })).errors.some(error => error.code === 'EDITABILITY_SCOPE_REQUIRED'));
  manifest.exports[0].type = 'image_based';
  const result = await bundleProductionManifest(manifest, { baseDir, outputDir: path.join(baseDir, 'delivery') });
  const receipt = JSON.parse(await fs.readFile(path.join(result.outputDir, 'production-receipt.json'), 'utf8'));
  assert.equal(receipt.exports[0].type, 'image_based');
  assert.equal(receipt.exports[0].editableScope, null);
});

test('protected assets cannot be silently marked regenerable or cropped', async t => {
  const { baseDir, manifest } = await fixture(t);
  manifest.assets = [{ id: 'plan', path: 'sample.png', role: 'plan' }];
  manifest.pages[0].protectedAssets = [{ originalAsset: 'plan', fit: 'cover', mayRegenerate: true }];
  assert.ok((await checkProductionManifest(manifest, { baseDir })).errors.some(error => error.code === 'PROTECTED_ASSET_POLICY'));
  Object.assign(manifest.pages[0].protectedAssets[0], { fit: 'contain', mayRegenerate: false });
  const result = await checkProductionManifest(manifest, { baseDir });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(warning => warning.code === 'PROTECTED_ASSET_VISUAL_CHECK'));
});

test('missing preview files fail before creating a deliverable folder', async t => {
  const { baseDir, manifest } = await fixture(t);
  manifest.pages[0].imagePath = 'missing.png';
  const outputDir = path.join(baseDir, 'should-not-exist');
  await assert.rejects(bundleProductionManifest(manifest, { baseDir, outputDir }), { code: 'MANIFEST_INVALID' });
  await assert.rejects(fs.stat(outputDir), { code: 'ENOENT' });
});
