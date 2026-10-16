'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { loadScript, sceneFeatureIds } = require('../script');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'training-script-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'demo.yaml');
  const source = { title: '输入边界', url: 'https://example.invalid', login: { enabled: false },
    scenes: [{ id: '查看-1', name: '查看', actions: [] }] };
  const save = () => fs.writeFileSync(file, YAML.stringify(source)); save();
  return { file, source, save };
}

test('场景 id 不能使截图路径越界，合法中文和标点 id 保持原值', (t) => {
  const f = fixture(t);
  for (const id of ['../../../outside', '..\\..\\outside', '/absolute', 'C:\\outside', 'bad\u0000id']) {
    f.source.scenes[0].id = id; f.save();
    assert.throws(() => loadScript(f.file), /id.*路径|id.*文件名/, id);
  }
  for (const id of ['查看-1', 'orders.view', '__proto__']) {
    f.source.scenes[0].id = id; f.save(); assert.equal(loadScript(f.file).scenes[0].id, id);
  }
  f.source.scenes = [{ id: 'Orders', actions: [] }, { id: 'orders', actions: [] }]; f.save();
  assert.throws(() => loadScript(f.file), /id.*重复|id.*冲突/);
});

test('显式零等待和零滚动保持为零，非法数值在执行前拒绝', (t) => {
  const f = fixture(t), s = f.source.scenes[0];
  s.actions = [{ wait: 0 }, { scroll: 0 }]; s.hold = 0; f.save();
  const compiled = loadScript(f.file).scenes[0];
  assert.equal(compiled.actions[0].ms, 0); assert.equal(compiled.actions[1].y, 0); assert.equal(compiled.hold, 0);
  for (const value of [-1, 'invalid', NaN, Infinity, null, false, ' ', 2147483.648]) {
    s.actions = [{ wait: value }]; f.save(); assert.throws(() => loadScript(f.file), /wait/, String(value));
    s.actions = []; s.hold = value; f.save(); assert.throws(() => loadScript(f.file), /hold/, String(value));
  }
  delete s.hold;
  for (const value of ['invalid', NaN, Infinity, null, false, ' ']) {
    s.actions = [{ scroll: value }]; f.save(); assert.throws(() => loadScript(f.file), /scroll/, String(value));
  }
  s.actions = [{ wait: '0.25' }, { scroll: -200 }]; f.save();
  const valid = loadScript(f.file).scenes[0]; assert.equal(valid.actions[0].ms, 250); assert.equal(valid.actions[1].y, -200);
});

test('功能映射中的合法 __proto__ id 不与对象原型冲突', (t) => {
  const f = fixture(t); f.source.scenes[0].feature = '__proto__'; f.save();
  assert.deepEqual(sceneFeatureIds(f.file).__proto__, ['查看']);
});

// 收尾旁白拼在整段末尾，收尾动作却接在基础动作之后；不写 at 就必然抢跑。
// 这里只验证默认锚点的计算与优先级，不断言真实画面时序。
function endingFixtureRaw(t, ending, overrides = {}) {
  const f = fixture(t);
  f.source.scenes = [{
    id: 'save', name: '保存', feature: 'demo.save',
    narration: '核对各项信息后点击保存。',
    actions: [{ click: { text: '保存' }, at: '点击保存' }],
    ending, ...overrides,
  }];
  f.source.features = 'demo.features.yaml';
  f.save();
  fs.writeFileSync(path.join(path.dirname(f.file), 'demo.features.yaml'), YAML.stringify({
    module: '示例', confirmedAt: '2026-01-01T00:00:00.000Z',
    pages: [{ id: 'detail', name: '明细', route: '/detail' }],
    environment: { name: '测试', testData: true },
    features: [{ id: 'demo.save', name: '保存', page: 'detail', kind: 'write', include: true,
      writeMode: 'submit', rehearsalMode: 'cancel',
      writeRequests: [{ method: 'POST', url: 'https://example.invalid/api/save' }] }],
  }));
  return f.file;
}

const endingFixture = (t, ending, overrides) => loadScript(endingFixtureRaw(t, ending, overrides), { stage: 'record' }).scenes[0];

test('收尾动作没写 at 时默认锚到收尾旁白的最后一个分句', (t) => {
  const compiled = endingFixture(t, { submit: { narration: '现在点击确定，正式完成归档。', actions: [{ click: { text: '确定' } }] } });
  assert.equal(compiled.actions.length, 2);
  const ending = compiled.actions[1];
  assert.ok(Number.isFinite(ending.cue), '收尾动作应得到默认 cue');
  assert.ok(ending.cue > 0.6, '默认锚点应落在整段旁白的末尾附近，实际 ' + ending.cue);
  assert.equal(ending.at, undefined, '默认锚点不能伪造 at 字段');
});

test('作者写了 at 的收尾动作以作者为准，不被默认锚点覆盖', (t) => {
  const compiled = endingFixture(t, { submit: { narration: '先讲结果，再讲返回；现在点击确定完成。',
    actions: [{ click: { text: '确定' }, at: '先讲结果' }] } });
  const ending = compiled.actions[1];
  assert.equal(ending.at, '先讲结果');
  assert.ok(ending.cue < 0.5, '作者写的锚点应早于默认的末尾锚点，实际 ' + ending.cue);
});

test('场景没写 feature 时 ending 会被整块忽略，改为直接报错', (t) => {
  const f = endingFixtureRaw(t, { submit: { narration: '现在点击保存。', actions: [{ click: { text: '保存' } }] } }, { feature: undefined });
  assert.throws(() => loadScript(f), /ending 只在关联了 feature/);
});

test('ending 只有 cancel / submit 两种收尾，写别的模式直接报错', (t) => {
  const f = endingFixtureRaw(t, { ok: { narration: '好了。', actions: [] } });
  assert.throws(() => loadScript(f), /ending 只有 cancel（填完取消）和 submit（真实提交）两种收尾/);
});

test('ending 里写了 hold 等不认识的键直接报错，并指出 hold 是场景级字段', (t) => {
  const f = endingFixtureRaw(t, { submit: { narration: '现在点击保存。', actions: [{ click: { text: '保存' } }], hold: 2 } });
  assert.throws(() => loadScript(f), /ending\.submit 不认识「hold」.*hold 是场景级字段/);
});

test('cue 是内部派生字段，写进场景直接报错', (t) => {
  const f = fixture(t);
  f.source.scenes[0].actions = [{ click: { text: '保存' }, cue: 0.5 }];
  f.save();
  assert.throws(() => loadScript(f.file), /cue.*内部派生字段/);
});
