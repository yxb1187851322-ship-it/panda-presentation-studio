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

test('portrait material uses its natural bitmap bounds and a compact adjacent annotation', () => {
  const asset = { id: 'material', width: 892, height: 1119, role: 'content' };
  const source = { id: 'materials', kind: 'split', title: '材料的主辅关系', body: '浅木与中性色构成大面。\n蓝绿与金属形成点缀。', caption: '材料意向', assetIds: ['material'] };
  const layout = buildSlideLayout(source, 0, fixture, new Map([['material', asset]]));
  const picture = layout.elements.find(element => element.type === 'image');
  const title = layout.elements.find(element => element.name === 'title');
  const body = layout.elements.find(element => element.name === 'body');
  assert.ok(Math.abs(picture.height - 648) < 1e-10);
  assert.ok(Math.abs(picture.width / picture.height - 892 / 1119) < 1e-10);
  assert.ok(title.left > picture.left + picture.width);
  assert.equal(title.fontSize, 30);
  assert.equal(body.fontSize, 20);
  assert.equal(layout.background, '#FFFFFF');
  assert.equal(layout.composition.strategy, 'portrait-with-side-note');
  assert.equal(layout.composition.imageAreaRatio, picture.width * picture.height / (1280 * 720));
  assert.match(layout.composition.measurement, /not an aesthetic score/);
});

test('moderate landscape photograph fills the page height without cropping or overlaid notes', () => {
  const images = new Map([['room', { id: 'room', width: 1835, height: 1282 }], ['logo', { id: 'logo', role: 'logo', width: 500, height: 100 }]]);
  const project = { ...fixture, brand: { logoAssetId: 'logo' } };
  const source = { id: 'room', kind: 'hero', title: '主卧的层次', body: '屏风与木饰面形成前后层次。', caption: '设计参考', assetIds: ['room'] };
  const layout = buildSlideLayout(source, 0, project, images);
  const picture = layout.elements.find(element => element.assetId === 'room');
  assert.equal(picture.height, 720);
  assert.equal(picture.top, 0);
  assert.equal(picture.fit, 'contain');
  assert.ok(Math.abs(picture.width / picture.height - 1835 / 1282) < 1e-10);
  assert.equal(layout.composition.strategy, 'photograph-with-side-note');
  for (const item of layout.elements.filter(element => element !== picture)) assert.ok(item.left + item.width <= picture.left);
  assert.throws(() => buildSlideLayout({ ...source, body: '不能静默删掉的长说明。'.repeat(40) }, 0, project, images), { code: 'TEXT_OVERFLOW' });
});

test('wide photograph and its annotation band share the actual image axis', () => {
  const asset = { id: 'wide', width: 3060, height: 1700 };
  const source = { id: 'wide', kind: 'hero', title: '客餐厅', body: '浅木墙面连接客厅与餐厅。', caption: '空间概念', assetIds: ['wide'] };
  const layout = buildSlideLayout(source, 0, fixture, new Map([['wide', asset]]));
  const picture = layout.elements.find(element => element.type === 'image');
  const title = layout.elements.find(element => element.name === 'title');
  assert.equal(layout.composition.strategy, 'photograph-with-bottom-note');
  assert.ok(Math.abs(picture.width / picture.height - 1.8) < 1e-10);
  assert.equal(title.left, picture.left);
  for (const note of layout.elements.filter(element => ['title', 'body', 'caption'].includes(element.name))) {
    assert.ok(note.top >= picture.top + picture.height);
    assert.ok(note.left >= picture.left && note.left + note.width <= picture.left + picture.width + 0.01);
  }
});

test('short portrait drawing plate stays centered on white paper with adjacent small captions', () => {
  const asset = { id: 'plan', width: 513, height: 868, role: 'plan' };
  const source = { id: 'plan', kind: 'hero', title: '平面总览', body: '', caption: '设计方署名', assetIds: ['plan'] };
  const layout = buildSlideLayout(source, 0, fixture, new Map([['plan', asset]]));
  const picture = layout.elements.find(element => element.type === 'image');
  assert.equal(layout.kind, 'plan');
  assert.equal(layout.background, '#FFFFFF');
  assert.equal(layout.composition.strategy, 'drawing-centered-plate');
  assert.equal(picture.height, 624);
  assert.ok(Math.abs(picture.left + picture.width / 2 - 640) < 1e-10);
  assert.equal(picture.fit, 'contain');
  assert.ok(Math.abs(picture.width / picture.height - 513 / 868) < 1e-10);
  const title = layout.elements.find(element => element.name === 'title');
  const caption = layout.elements.find(element => element.name === 'caption');
  assert.equal(caption.text, source.caption);
  assert.equal(title.left, picture.left);
  assert.equal(caption.left, picture.left);
  assert.equal(title.fontSize, 22);
  assert.equal(caption.fontSize, 14);
  assert.ok(title.top >= picture.top + picture.height && caption.top >= title.top + title.height);
  assert.ok(caption.top + caption.height <= 720);
  const withBody = buildSlideLayout({ ...source, body: '保留入口、公共区域与私密区域的相互关系。' }, 0, fixture, new Map([['plan', asset]]));
  assert.equal(withBody.composition.strategy, 'drawing-with-side-note');
  assert.equal(withBody.elements.find(element => element.type === 'image').height, 672);
  const longCaption = buildSlideLayout({ ...source, caption: '完整说明与署名'.repeat(5) }, 0, fixture, new Map([['plan', asset]]));
  assert.equal(longCaption.composition.strategy, 'drawing-with-side-note');
});

test('geometry receipts measure visible content for existing contain frames too', () => {
  const asset = { id: 'cover-image', width: 1800, height: 1200 };
  const layout = buildSlideLayout({ id: 'cover', kind: 'cover', title: '空间方案', assetIds: [asset.id] }, 0, fixture, new Map([[asset.id, asset]]));
  const recorded = layout.composition.images[0];
  assert.equal(recorded.width, 520);
  assert.ok(Math.abs(recorded.height - 520 / 1.5) < 1e-10);
  assert.ok(recorded.height < recorded.frame.height);
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
