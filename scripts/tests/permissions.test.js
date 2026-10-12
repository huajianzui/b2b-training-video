'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { loadScript } = require('../script');
const { saveDecisions, loadFeatures } = require('../features');

function fixture(t, changes = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'training-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = { module: '订单', confirmedAt: '2026-10-12 10:00:00',
    environment: { name: '测试环境', testData: true }, pages: [{ id: 'orders', name: '订单' }],
    features: [{ id: 'create', page: 'orders', name: '新增', kind: 'write', include: true,
      writeMode: 'submit', rehearsalMode: 'cancel', writeRequests: [{ method: 'POST', url: '/api/orders' }] }], ...changes };
  const features = path.join(root, 'demo.features.yaml');
  const file = path.join(root, 'demo.yaml');
  const source = { title: '订单', url: 'https://training.example.invalid', features: 'demo.features.yaml',
    readOnlyRequests: [{ method: 'POST', url: '/api/search' }], scenes: [{ id: 'create', name: '新增', feature: 'create',
      narration: '填写订单。', actions: [{ fill: { target: '#name', text: '演示' } }],
      ending: { cancel: { narration: '取消。', actions: [{ click: '#cancel' }] },
        submit: { narration: '保存。', actions: [{ click: '#save' }] } } }] };
  const save = () => { fs.writeFileSync(features, YAML.stringify(manifest)); fs.writeFileSync(file, YAML.stringify(source)); };
  save();
  return { root, file, features, manifest, source, save };
}

test('环境不允许测试数据时，任何阶段的 submit 都被拒绝', (t) => {
  const f = fixture(t, { environment: { name: '生产环境', testData: false } });
  assert.throws(() => loadScript(f.file), /testData|不允许.*写/);
  f.manifest.features[0].writeMode = 'cancel';
  f.manifest.features[0].rehearsalMode = 'submit'; f.save();
  assert.throws(() => loadScript(f.file, { stage: 'rehearsal' }), /testData|不允许.*写/);
});

test('演练和正式录制按照分别确认的收尾执行', (t) => {
  const f = fixture(t);
  const rehearsal = loadScript(f.file, { stage: 'rehearsal' });
  const recording = loadScript(f.file);
  assert.equal(rehearsal.scenes[0].actions.at(-1).target[0].selector, '#cancel');
  assert.equal(recording.scenes[0].actions.at(-1).target[0].selector, '#save');
  f.manifest.features[0].rehearsalMode = 'submit';
  f.manifest.features[0].writeMode = 'cancel'; f.save();
  assert.equal(loadScript(f.file, { stage: 'rehearsal' }).scenes[0].actions.at(-1).target[0].selector, '#save');
  assert.equal(loadScript(f.file).scenes[0].actions.at(-1).target[0].selector, '#cancel');
});

test('写功能缺少 ending 时不能用普通动作直接保存', (t) => {
  const f = fixture(t);
  delete f.source.scenes[0].ending;
  f.source.scenes[0].actions.push({ click: '#save' }); f.save();
  assert.throws(() => loadScript(f.file), /ending/);
});

test('导航、只读和 continue 场景不能自行注入内部提交授权或收尾边界', (t) => {
  const f = fixture(t);
  f.manifest.features[0].writeMode = 'cancel';
  f.manifest.features.push({ id: 'read', page: 'orders', name: '查看', kind: 'read', include: true });
  const selected = { ...f.source.scenes[0] };
  for (const kind of ['navigation', 'read', 'continue']) for (const [key, value] of Object.entries({
    writeMode: 'submit', writeRequests: [{ method: 'POST', url: '/outside' }], expectAt: 0, endExpect: [],
  })) {
    const injected = { id: 'injected', name: '越权场景', actions: [{ click: '#save' }], [key]: value };
    if (kind === 'read') injected.feature = 'read';
    if (kind === 'continue') {
      injected.feature = 'create'; injected.continue = true; injected.ending = selected.ending;
      f.source.scenes = [{ ...selected, ending: undefined }, injected];
    } else f.source.scenes = [selected, injected];
    f.save();
    assert.throws(() => loadScript(f.file, { stage: 'rehearsal' }), /内部字段/, kind + ':' + key);
  }
});

test('continue 可以分段填写，组尾仍必须提供收尾', (t) => {
  const f = fixture(t);
  const final = { ...f.source.scenes[0], id: 'finish', continue: true, actions: [] };
  delete f.source.scenes[0].ending;
  f.source.scenes.push(final); f.save();
  assert.equal(loadScript(f.file).scenes.length, 2);
  delete final.ending; f.save();
  assert.throws(() => loadScript(f.file), /ending/);
});

test('旧写脚本缺少演练选择或提交接口时给出具体迁移提示', (t) => {
  const f = fixture(t);
  delete f.manifest.features[0].rehearsalMode; f.save();
  assert.throws(() => loadScript(f.file), /rehearsalMode/);
  f.manifest.features[0].rehearsalMode = 'cancel';
  delete f.manifest.features[0].writeRequests; f.save();
  assert.throws(() => loadScript(f.file), /writeRequests/);
});

test('草稿改变写入选择后撤销旧确认，必须重新确认', (t) => {
  const f = fixture(t);
  saveDecisions(f.features, { create: { writeMode: 'cancel', rehearsalMode: 'submit' } }, false);
  assert.equal(loadFeatures(f.features).confirmedAt, '');
  assert.throws(() => loadScript(f.file), /还没有确认/);
  saveDecisions(f.features, {}, true);
  assert.ok(loadScript(f.file));
});

test('非法提交选择被拒绝，原清单不被写成非法状态', (t) => {
  const f = fixture(t);
  f.manifest.environment.testData = false;
  f.manifest.features[0].writeMode = 'cancel'; f.save();
  const before = fs.readFileSync(f.features, 'utf8');
  assert.throws(() => saveDecisions(f.features, { create: { rehearsalMode: 'submit' } }, true), /testData|不允许.*写/);
  assert.equal(fs.readFileSync(f.features, 'utf8'), before);
});

test('只读接口清单不允许将 DELETE 冒充查询，也不允许通配 URL', (t) => {
  const f = fixture(t);
  f.source.readOnlyRequests = [{ method: 'DELETE', url: '/api/orders' }]; f.save();
  assert.throws(() => loadScript(f.file), /readOnlyRequests/);
  f.source.readOnlyRequests = [{ method: 'POST', url: 'https://*/api/*' }]; f.save();
  assert.throws(() => loadScript(f.file), /通配|URL/);
});
