import test from 'node:test';
import assert from 'node:assert/strict';
import { createStyleProfile, recordStyleFeedback, inspectStyleFit } from '../src/core/style-profile.mjs';

// Synthetic geometry tests, not a recommended visual template or private project material.
const definition = () => ({
  id: 'test-style', name: 'Synthetic style', version: '1',
  origin: { kind: 'authored', sourceRef: 'test:authored', productionAllowed: true },
  tokens: {
    typography: { fontFamily: 'Test Sans', headingPt: 32, bodyPt: 18, captionPt: 12 },
    colors: { background: '#FFFFFF', foreground: '#202020' },
    spacing: { marginRatio: 0.05, gutterRatio: 0.02 },
  },
  layout: { canvas: { width: 1600, height: 900 }, slots: [{ id: 'hero', role: 'image', x: 0, y: 0, width: 1, height: 1, fit: 'cover' }] },
  constraints: { contentTasks: ['space-overview'], outputs: ['pptx'], requiredAssetKinds: ['image'], minImageWidth: 1200, minImageHeight: 700, imageAspectRatios: [16 / 9] },
});
const request = () => ({ taskId: 'task-1', contentTask: 'space-overview', output: 'pptx', assets: [{ id: 'photo', kind: 'image', width: 1600, height: 900, noCrop: true }], placements: [{ assetId: 'photo', slotId: 'hero' }] });
const sample = (version = '1') => ({ id: 'sample-1', version, profileVersion: '1', artifactRef: `sample:${version}`, renderRef: `render:${version}` });
const evidence = (id = 'feedback-1') => ({ id, actorRole: 'user', actorId: 'user-1', evidenceRef: `message:${id}`, quote: 'This rendered sample is the version I approve.', recordedAt: '2026-10-12T12:00:00+08:00' });
const trial = (profile = createStyleProfile(definition())) => recordStyleFeedback(profile, { action: 'trial', taskId: 'task-1', sample: sample() });
const accepted = () => recordStyleFeedback(trial(), { action: 'accept', sample: sample(), feedback: evidence() });
const codes = result => result.reasons.map(reason => reason.code);

test('candidate → trial → accepted → rejected records versioned evidence without mutating earlier states', () => {
  const input = definition();
  const candidate = createStyleProfile(input);
  const testing = trial(candidate);
  const approved = recordStyleFeedback(testing, { action: 'accept', sample: sample(), feedback: evidence() });
  const rejected = recordStyleFeedback(approved, { action: 'reject', feedback: { ...evidence('feedback-2'), quote: 'Reject this sample: image hierarchy fails.' } });
  assert.deepEqual([candidate.state, testing.state, approved.state, rejected.state], ['candidate', 'trial', 'accepted', 'rejected']);
  assert.equal(candidate.history.length, 0);
  assert.equal(approved.approval.sample.renderRef, 'render:1');
  assert.equal(rejected.approval, null);
  assert.equal(rejected.history.length, 3);
  input.tokens.typography.headingPt = 99;
  assert.equal(candidate.tokens.typography.headingPt, 32);
  assert.throws(() => { approved.approval.sample.version = 'changed'; }, TypeError);
  assert.throws(() => { candidate.layout.slots.push({}); }, TypeError);
});

test('creation never imports an accepted state supplied by caller', () => {
  const profile = createStyleProfile({ ...definition(), state: 'accepted', approval: { fake: true } });
  assert.equal(profile.state, 'candidate');
  assert.equal(profile.approval, null);
});

test('accept requires a trial, actual sample references and a user feedback evidence record', () => {
  assert.throws(() => recordStyleFeedback(createStyleProfile(definition()), { action: 'accept', sample: sample(), feedback: evidence() }), /active trial/);
  for (const field of ['evidenceRef', 'quote', 'actorId', 'recordedAt']) {
    const feedback = evidence(); delete feedback[field];
    assert.throws(() => recordStyleFeedback(trial(), { action: 'accept', sample: sample(), feedback }), new RegExp(`feedback.${field}`));
  }
  assert.throws(() => recordStyleFeedback(trial(), { action: 'accept', sample: sample(), feedback: { ...evidence(), actorRole: 'model' } }), /feedback.actorRole/);
  assert.equal(trial(accepted()).approval, null, 'a new trial clears the previous approval');
  const missingRender = sample(); delete missingRender.renderRef;
  assert.throws(() => recordStyleFeedback(createStyleProfile(definition()), { action: 'trial', taskId: 'task-1', sample: missingRender }), /sample.renderRef/);
});

test('approval cannot apply to an old sample version, modified render or another profile version', () => {
  const testing = recordStyleFeedback(trial(), { action: 'trial', taskId: 'task-1', sample: sample('2') });
  assert.throws(() => recordStyleFeedback(testing, { action: 'accept', sample: sample(), feedback: evidence() }), /exact current trial/);
  assert.throws(() => recordStyleFeedback(testing, { action: 'accept', sample: { ...sample('2'), renderRef: 'other-render' }, feedback: evidence() }), /exact current trial/);
  assert.throws(() => recordStyleFeedback(trial(), { action: 'accept', sample: { ...sample(), profileVersion: '2' }, feedback: evidence() }), /exact current trial/);
  const staleVersion = structuredClone(accepted()); staleVersion.version = '2';
  assert.deepEqual(codes(inspectStyleFit(staleVersion, request())), ['stale-approval']);
  const staleSample = structuredClone(accepted()); staleSample.sample.version = '2';
  assert.equal(inspectStyleFit(staleSample, request()).eligible, false);
});

test('an accepted profile yields only a candidate and makes no aesthetic or authenticity claim', () => {
  const result = inspectStyleFit(accepted(), request());
  assert.equal(result.eligible, true);
  assert.equal(result.decision, 'candidate');
  assert.equal(result.evidenceStatus, 'fields-recorded-not-authenticated');
  assert.deepEqual(result.reviewRequired, ['rendered-layout-review', 'user-feedback']);
  assert.equal('aestheticPassed' in result, false);
});

test('editing geometry, tokens or constraints without a version bump invalidates the old trial and approval', () => {
  for (const mutate of [
    profile => { profile.tokens.typography.headingPt = 40; },
    profile => { profile.layout.slots[0].fit = 'contain'; },
    profile => { profile.constraints.minImageWidth = 1000; },
  ]) {
    const changed = structuredClone(accepted()); mutate(changed);
    assert.equal(changed.version, '1');
    assert.ok(codes(inspectStyleFit(changed, request())).includes('stale-approval'));
    const changedTrial = structuredClone(trial()); mutate(changedTrial);
    assert.throws(() => recordStyleFeedback(changedTrial, { action: 'accept', sample: sample(), feedback: evidence() }), /definition changed after the trial/);
    assert.throws(() => recordStyleFeedback(changedTrial, { action: 'trial', taskId: 'task-1', sample: sample() }), /new rendered sample version/);
    const freshTrial = recordStyleFeedback(changedTrial, { action: 'trial', taskId: 'task-1', sample: sample('2') });
    assert.equal(recordStyleFeedback(freshTrial, { action: 'accept', sample: sample('2'), feedback: evidence() }).state, 'accepted');
  }
});

test('rejection blocks recommendations; explicit user override is limited to the exact task and version', () => {
  const rejected = recordStyleFeedback(accepted(), { action: 'reject', feedback: evidence('rejected-feedback') });
  assert.equal(inspectStyleFit(rejected, request()).eligible, false);
  const explicitStyleRequest = { profileId: rejected.id, profileVersion: rejected.version, taskId: 'task-1', actorRole: 'user', evidenceRef: 'message:exception', quote: 'Try this rejected style for this task only.' };
  const result = inspectStyleFit(rejected, { ...request(), explicitStyleRequest });
  assert.equal(result.decision, 'task-trial');
  assert.equal(result.scope, 'this-task-only');
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.approval, null);
  assert.throws(() => inspectStyleFit(rejected, { ...request(), taskId: 'task-2', explicitStyleRequest }), /exact profile version and task/);
  assert.throws(() => trial(rejected), /rejected profiles/);
  assert.equal(inspectStyleFit(rejected, { ...request(), contentTask: 'plan-analysis', explicitStyleRequest }).eligible, false);
});

test('research sources and absent production permission cannot become production recommendations', () => {
  for (const origin of [
    { kind: 'research-case', sourceRef: 'reference:public-case', productionAllowed: true },
    { kind: 'authored', sourceRef: 'test:draft' },
    { kind: 'licensed-template', sourceRef: 'test:template', productionAllowed: true },
  ]) {
    const profile = createStyleProfile({ ...definition(), origin });
    assert.equal(inspectStyleFit(profile, request()).eligible, false);
    assert.throws(() => recordStyleFeedback(trial(profile), { action: 'accept', sample: sample(), feedback: evidence() }), /origin/);
  }
  const licensed = createStyleProfile({ ...definition(), origin: { kind: 'licensed-template', sourceRef: 'test:template', productionAllowed: true, licenseRef: 'license:record' } });
  assert.equal(inspectStyleFit(licensed, request()).eligible, true);
});

test('content tasks, output format and required asset kinds are checked independently', () => {
  const result = inspectStyleFit(createStyleProfile(definition()), { ...request(), contentTask: 'plan-analysis', output: 'html', assets: [], placements: [] });
  assert.deepEqual(codes(result), ['content-task', 'output', 'missing-asset-kind', 'empty-slot']);
});

test('image dimensions are concrete; transposed width/height and unsuitable ratios fail', () => {
  const r = request(); r.assets[0].width = 900; r.assets[0].height = 1600;
  const result = inspectStyleFit(createStyleProfile(definition()), r);
  assert.ok(codes(result).includes('image-dimensions'));
  assert.ok(codes(result).includes('image-aspect-ratio'));
  assert.ok(codes(result).includes('no-crop'));
  assert.match(result.reasons.find(reason => reason.code === 'image-dimensions').message, /900×1600.*1200×700/);
});

test('no-crop is evaluated against the actual slot and canvas ratio, with contain preserving any ratio', () => {
  const d = definition(); d.layout.slots[0].width = 0.5; d.constraints.imageAspectRatios = [];
  assert.ok(codes(inspectStyleFit(createStyleProfile(d), request())).includes('no-crop'));
  d.layout.slots[0].fit = 'contain';
  assert.equal(inspectStyleFit(createStyleProfile(d), request()).eligible, true);
  d.layout.slots[0].fit = 'cover'; d.layout.slots[0].width = 1;
  const r = request(); r.assets[0].width = 1601;
  assert.ok(codes(inspectStyleFit(createStyleProfile(d), r)).includes('no-crop'), 'even small cover cropping violates no-crop');
  r.assets[0].noCrop = false;
  assert.equal(inspectStyleFit(createStyleProfile(d), r).eligible, true);
});

test('logos and drawings require complete-original contain placements, regardless of optional noCrop flag', () => {
  for (const kind of ['logo', 'drawing']) {
    const d = definition(); d.layout.slots[0].role = kind; d.constraints.requiredAssetKinds = [kind];
    const r = request(); r.assets[0].kind = kind; r.assets[0].noCrop = false;
    assert.deepEqual(codes(inspectStyleFit(createStyleProfile(d), r)), ['protected-asset']);
    d.layout.slots[0].fit = 'contain';
    assert.equal(inspectStyleFit(createStyleProfile(d), r).eligible, true);
  }
});

test('age, gender, skin color or other audience demographics never substitute for style preferences', () => {
  const profile = createStyleProfile(definition());
  const first = inspectStyleFit(profile, { ...request(), audience: { age: 50, gender: 'male', skinColor: 'dark' } });
  const second = inspectStyleFit(profile, { ...request(), audience: { age: 25, gender: 'female', skinColor: 'light' } });
  assert.deepEqual(first, second);
  assert.deepEqual(first, inspectStyleFit(profile, request()));
});

test('malformed inputs and broken references produce readable field errors', () => {
  assert.throws(() => createStyleProfile(null), /profile: must be an object/);
  assert.throws(() => createStyleProfile({ ...definition(), version: '' }), /version: must be/);
  const d = definition(); d.layout.slots[0].width = 2;
  assert.throws(() => createStyleProfile(d), /rectangle must stay inside/);
  assert.throws(() => inspectStyleFit(createStyleProfile(definition()), null), /request: must be an object/);
  const r = request(); r.assets[0].width = '1600';
  assert.throws(() => inspectStyleFit(createStyleProfile(definition()), r), /assets\[0\].width/);
  assert.throws(() => inspectStyleFit(createStyleProfile(definition()), { ...request(), placements: [{ assetId: 'missing', slotId: 'hero' }] }), /unknown asset: missing/);
  assert.throws(() => inspectStyleFit(createStyleProfile(definition()), { ...request(), placements: [{ assetId: 'photo', slotId: 'missing' }] }), /unknown slot: missing/);
});

test('inspection leaves caller data unchanged and duplicate feedback ids cannot overwrite history', () => {
  const profile = accepted(); const r = request(); const before = structuredClone(r);
  inspectStyleFit(profile, r);
  assert.deepEqual(r, before);
  assert.throws(() => recordStyleFeedback(profile, { action: 'reject', feedback: evidence() }), /already been recorded/);
  assert.equal(profile.state, 'accepted');
});
