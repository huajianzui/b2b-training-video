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
