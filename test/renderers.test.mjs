import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildSlideLayout, resolveProjectAsset, renderProject, wrapSlideText } from '../src/renderers/index.mjs';
import { renderHtml } from '../src/renderers/html.mjs';
import { loadRuntimePackage } from '../src/renderers/assets.mjs';

const fixture = { id: 'demo', title: '空间方案', revision: 1, brand: {}, assets: [], slides: [{ id: 's1', kind: 'text', title: '空间与光线', body: '资料先形成清晰的内容结构，再进入页面设计。', assetIds: [], sourceIds: [] }] };

test('asset resolver rejects traversal, absolute paths and nonstandard file names', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'panda-path-test-'));
  for (const file of ['../secret.txt', '/etc/passwd', 'C:/secret.txt', 'assets/../secret.txt', 'assets/a.png/../b.txt', 'assets/name with spaces.png']) {
    await assert.rejects(resolveProjectAsset(root, file), { code: 'UNSAFE_ASSET_PATH' });
  }
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'assets', 'safe.txt'), 'source');
  assert.equal(await resolveProjectAsset(root, 'assets/safe.txt'), path.join(root, 'assets', 'safe.txt'));
  await assert.rejects(resolveProjectAsset(root, 'assets/missing.png'), { code: 'ASSET_MISSING' });
});

test('asset resolver rejects an assets directory linked outside the project', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'panda-link-test-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'panda-outside-test-'));
  await fs.writeFile(path.join(outside, 'safe.txt'), 'private');
  await fs.symlink(outside, path.join(root, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveProjectAsset(root, 'assets/safe.txt'), { code: 'UNSAFE_ASSET_PATH' });
});

test('layout keeps plan and logo proportional and rejects content that cannot fit', () => {
  const images = new Map([
    ['drawing', { id: 'drawing', name: '图纸', width: 1600, height: 900, role: 'plan' }],
    ['logo', { id: 'logo', name: '品牌', width: 600, height: 100, role: 'logo' }],
  ]);
  const project = { ...fixture, brand: { logoAssetId: 'logo' } };
  const result = buildSlideLayout({ ...fixture.slides[0], kind: 'plan', assetIds: ['drawing'] }, 0, project, images);
  assert.ok(result.elements.filter(element => element.type === 'image').every(element => element.fit === 'contain'));
  assert.ok(result.elements.every(element => element.left >= 0 && element.top >= 0 && element.left + element.width <= 1280 && element.top + element.height <= 720));
  assert.throws(() => buildSlideLayout({ ...fixture.slides[0], body: '长内容'.repeat(500) }, 0, fixture, new Map()), { code: 'TEXT_OVERFLOW' });
});

test('Chinese wrapping preserves content, closing punctuation and bracket pairs', () => {
  const original = '日光缓缓进入室内形成舒适明亮空间。\n\n布局采用（客餐厅一体化）设计，保留窗边视野。';
  const wrapped = wrapSlideText(original, 400, 26);
  assert.equal(wrapped.replaceAll('\n', ''), original.replaceAll('\n', ''));
  assert.ok(wrapped.includes('\n\n'));
  for (const line of wrapped.split('\n')) {
    assert.doesNotMatch(line, /^[、。，？！：；）〉》」』】]/);
    assert.doesNotMatch(line, /[（〈《「『【]$/);
  }
});

test('mixed language wrapping does not split English words or delete whitespace', () => {
  const original = "空间采用 natural lighting and well-balanced materials，保留采光。";
  const wrapped = wrapSlideText(original, 250, 26);
  assert.equal(wrapped.replaceAll('\n', ''), original);
  for (const word of ['natural', 'lighting', 'well-balanced', 'materials']) assert.ok(wrapped.includes(word));
  assert.throws(() => wrapSlideText('AnUnbreakableWordLongerThanTheTextColumn', 80, 26), { code: 'TEXT_TOKEN_TOO_LONG' });
});

test('cover preserves its caption as editable text', () => {
  const images = new Map([['photo', { id: 'photo', width: 1200, height: 1800 }]]);
  const layout = buildSlideLayout({ ...fixture.slides[0], kind: 'cover', caption: '项目图片说明', assetIds: ['photo'] }, 0, fixture, images);
  assert.equal(layout.elements.find(element => element.name === 'caption').text, '项目图片说明');
});

test('offline HTML escapes uploaded text and prevents remote/script execution', () => {
  const hostile = { ...fixture, title: '<script>alert(1)</script>', slides: [{ ...fixture.slides[0], title: '<img src=x onerror=alert(1)>', body: '<script>bad()</script>' }] };
  const layout = buildSlideLayout(hostile.slides[0], 0, hostile, new Map());
  const html = renderHtml(hostile, [layout], new Map());
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /@media\(max-width:740px\)/);
});

test('real renderer produces native text PPTX, PNG and offline HTML', { skip: !process.env.PANDA_NODE_MODULES }, async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'panda-render-test-'));
  const outputDir = path.join(projectDir, 'result');
  const result = await renderProject({ project: fixture, projectDir, outputDir });
  assert.equal(result.slides.length, 1);
  const png = await fs.readFile(path.join(outputDir, result.slides[0].preview));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const JSZip = (await loadRuntimePackage('jszip')).default;
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(outputDir, 'presentation.pptx')));
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  assert.match(xml, /空间与光线/);
  assert.match(xml, /<a:t>/);
  assert.match(xml, /Microsoft YaHei/);
  assert.ok((await fs.readFile(path.join(outputDir, 'index.html'), 'utf8')).includes('资料先形成'));
  assert.ok((await fs.stat(path.join(outputDir, '.private', 'slide-001.layout.json'))).size > 0);
  await assert.rejects(renderProject({ project: fixture, projectDir, outputDir }), { code: 'OUTPUT_EXISTS' });
});

test('all six layouts embed actual image objects and generate individual previews', { skip: !process.env.PANDA_NODE_MODULES }, async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'panda-image-render-test-'));
  await fs.mkdir(path.join(projectDir, 'assets'));
  // A one-pixel raster fixture tests the embedding pipeline, not visual quality.
  const fixturePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLioAAAAASUVORK5CYII=', 'base64');
  await fs.writeFile(path.join(projectDir, 'assets', 'raster.png'), fixturePng);
  const project = { ...fixture, assets: [{ id: 'raster', kind: 'image', file: 'assets/raster.png', name: '图像测试样本' }], slides: ['cover', 'hero', 'split', 'gallery', 'plan', 'text'].map((kind, index) => ({ id: `page${index}`, kind, title: '空间方案', body: kind === 'split' ? '日光缓缓进入室内形成舒适明亮空间。' : '自然光与材料关系', caption: '', assetIds: kind === 'text' ? [] : ['raster'], sourceIds: ['raster'] })) };
  const outputDir = path.join(projectDir, 'result');
  const result = await renderProject({ project, projectDir, outputDir });
  assert.equal(result.slides.length, 6);
  const JSZip = (await loadRuntimePackage('jszip')).default;
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(outputDir, 'presentation.pptx')));
  for (let index = 1; index <= 6; index++) {
    const xml = await zip.file(`ppt/slides/slide${index}.xml`).async('string');
    assert.match(xml, /空间方案/);
    if (index === 3) {
      const nativeText = [...xml.matchAll(/<a:t>(.*?)<\/a:t>/g)].map(match => match[1]).join('');
      assert.ok(nativeText.includes('日光缓缓进入室内形成舒适明亮空间。'));
    }
    if (index < 6) assert.match(xml, /<p:pic>/);
    assert.ok((await fs.stat(path.join(outputDir, result.slides[index - 1].preview))).size > 100);
  }
  assert.ok(!(await fs.readdir(outputDir)).some(name => name.endsWith('.ndjson')));
});
