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

test('内置多音字规则默认生效且保护调度，同时检测正文与收尾重复话术并保留 switchUser', (t) => {
  const f = endingFixtureRaw(t,
    { submit: { narration: '确认无误后点击保存完成提交。', actions: [{ click: { text: '确定' }, at: '点击保存' }] } },
    { switchUser: 'test_pm', narration: '周任务调度表格按人员跨行展示，点击待补码行查重并调整后点击保存。' });
  const compiled = loadScript(f, { stage: 'record' });
  const scene = compiled.scenes[0];
  assert.equal(scene.switchUser, 'test_pm');
  assert.ok(scene.speech.includes('周任务调度'), '调度不应被误改为条度：' + scene.speech);
  assert.ok(scene.speech.includes('跨航展示'), '跨行应默认映射为跨航：' + scene.speech);
  assert.ok(scene.speech.includes('待补码航'), '待补码行应默认映射为待补码航：' + scene.speech);
  assert.ok(scene.speech.includes('察虫并条整'), '查重/调整应默认映射：' + scene.speech);
  assert.ok(compiled.narrationWarnings.some((w) => w.includes('重复出现「点击保存」')), '应提示正文与收尾重复点击话术');
});

test('同一段旁白中后续动作的 at 从前序动作命中位置往后查找，不误判前文重复词倒挂；支持动作级 doc: false 与 altSpeech 预热字段', (t) => {
  const f = endingFixtureRaw(t,
    {
      cancel: { narration: '暂不提交时点击取消返回列表。', actions: [{ click: { text: '取消' }, at: '点击取消' }] },
      submit: { narration: '确认无误后点击保存返回列表。', actions: [{ click: { text: '保存' }, at: '点击保存', doc: false }] },
    },
    {
      narration: '列表上方可以按条件筛选，输入名称后点击查询，列表会立即刷新。',
      actions: [
        { click: { text: '关闭抽屉' }, doc: false },
        { fill: { target: { id: 'kw' }, text: '测试' }, at: '输入名称' },
        { click: { text: '查询' }, at: '点击查询' },
        { waitFor: { text: '结果' }, at: '列表会立即刷新' },
      ],
    });
  const rehearsal = loadScript(f, { stage: 'rehearsal' });
  const s = rehearsal.scenes[0];
  assert.equal(s.actions[0].doc, false);
  assert.equal(s.actions[4].doc, undefined);
  assert.ok(s.actions[3].cue > s.actions[2].cue, '后文「列表会立即刷新」应命中第二个「列表」，cue 大于前序动作');
  assert.ok(s.altSpeech && s.altSpeech.includes('确认无误后点击保存'), '演练阶段应编译出 submit 分支的 altSpeech 供 tts.py 预热');

  const record = loadScript(f, { stage: 'record' });
  assert.equal(record.scenes[0].actions[4].doc, false, 'ending.submit 里的 doc: false 应保留');
  assert.ok(record.scenes[0].altSpeech && record.scenes[0].altSpeech.includes('暂不提交时点击取消'), '正式阶段应编译出 cancel 分支的 altSpeech');
});

test('scroll 支持像素值、{x, y} 双向滚动及按 target 目标元素滚入视窗中央', (t) => {
  const f = endingFixtureRaw(t,
    { cancel: { narration: '返回。', actions: [{ click: { text: '取消' }, at: '返回' }] } },
    {
      narration: '先向下看列表，再横向滚到右侧查看标准任务豆列。',
      actions: [
        { scroll: 400 },
        { scroll: { x: 600, y: 0 }, at: '横向滚到右侧' },
        { scroll: { text: '标准任务豆' }, at: '查看标准任务豆列' },
      ],
    });
  const compiled = loadScript(f, { stage: 'rehearsal' });
  const acts = compiled.scenes[0].actions;
  assert.equal(acts[0].op, 'scroll');
  assert.equal(acts[0].y, 400);
  assert.equal(acts[1].op, 'scroll');
  assert.equal(acts[1].x, 600);
  assert.equal(acts[1].y, 0);
  assert.equal(acts[2].op, 'scroll');
  assert.equal(acts[2].target[0].by, 'text');
  assert.equal(acts[2].target[0].value, '标准任务豆');
});

test('严禁旁白出现内部演练话术、过长片头片尾及首场景跳过菜单导航', (t) => {
  const f = fixture(t);
  f.source.scenes[0].narration = '演练阶段只核对表单，不实际发布，不会产生任何业务数据变更。';
  f.save();
  assert.throws(() => loadScript(f.file), /旁白严禁包含内部演练\/测试话术/);

  f.source.scenes[0].narration = '首先在左侧菜单点击项目管理进入列表。';
  f.source.intro = { narration: '本视频演示如何在招标采购平台发布一个待发布项目，包括打开列表、筛选待发布项目、填写时间。请跟随画面操作。' };
  f.save();
  assert.throws(() => loadScript(f.file), /intro：片头旁白过长/);

  f.source.intro = { narration: '本视频演示待发布项目的发布操作。' };
  f.source.outro = { narration: '以上就是发布项目的完整操作。正式发布前，请再次核对时间，并确认供应商已完成实名认证。' };
  f.save();
  assert.throws(() => loadScript(f.file), /outro：片尾旁白过长/);

  f.source.outro = { narration: '以上就是发布项目的操作演示，感谢观看。' };
  f.source.manual = { title: '发布项目手册' };
  f.source.scenes[0].narration = '首先进入竞价项目列表查看所有项目。';
  f.save();
  assert.throws(() => loadScript(f.file), /首场景旁白必须交代如何通过菜单进入该功能/);

  f.source.scenes[0].narration = '首先在左侧菜单点击项目管理进入列表。';
  f.source.scenes[0].actions = [{ goto: '/orders' }];
  f.save();
  assert.throws(() => loadScript(f.file), /首场景必须包含点击菜单\/页签进入功能页面的 click 动作/);

  // 即使手写 confirmedAt 绕过 features.js --yes，只要未填 environment.tier 也在编译阶段直接拦截
  const featFile = path.join(path.dirname(f.file), 'demo.features.yaml');
  fs.writeFileSync(featFile, YAML.stringify({
    module: '项目管理',
    confirmedAt: '2026-11-23T00:00:00.000Z',
    environment: { name: '测试环境', testData: false },
    pages: [{ id: 'list', name: '列表', entry: '左侧菜单', route: '/orders', files: ['a.vue'] }],
    features: [{ id: 'list.publish', page: 'list', name: '发布项目', kind: 'write', include: true, writeMode: 'cancel', rehearsalMode: 'cancel' }],
  }));
  f.source.features = 'demo.features.yaml';
  f.source.scenes[0].actions = [{ click: { text: '项目管理' }, at: '点击项目管理' }];
  f.save();
  assert.throws(() => loadScript(f.file), /缺少 environment\.tier（三级环境与数据洁净度分级）/);

  // 补齐 environment.tier 后，校验：
  // 1) 禁止用带记录 ID 或 toPublish 的 goto 跳过列表按钮点击；
  // 2) 多字段填写必须介绍字段间关系；
  // 3) 写功能（含 ending.cancel）必须介绍点击确定后的正确现象与对下游的业务影响
  fs.writeFileSync(featFile, YAML.stringify({
    module: '项目管理',
    confirmedAt: '2026-11-23T00:00:00.000Z',
    environment: { name: '测试环境', tier: 'restricted', testData: false },
    pages: [{ id: 'list', name: '列表', entry: '左侧菜单', route: '/orders', files: ['a.vue'] }],
    features: [{ id: 'list.publish', page: 'list', name: '发布项目', kind: 'write', include: true, writeMode: 'cancel', rehearsalMode: 'cancel' }],
  }));

  f.source.scenes.push({
    id: 's02',
    name: '填写发布时间',
    feature: 'list.publish',
    narration: '点击发布进入表单，填写公示时间、报价开始时间、报价截止时间。',
    actions: [
      { goto: '/bmsController.do?toPublish&id=123' },
    ],
    ending: {
      cancel: {
        narration: '暂不发布时点击取消返回。',
        actions: [{ click: { text: '取消' }, at: '点击取消' }],
      },
    },
  });
  f.save();
  assert.throws(() => loadScript(f.file), /严禁使用带具体记录 ID 或表单动作的 goto/);

  // 去掉深层 goto，但没有先 click 列表按钮就直接 fill 填表 -> 拦截
  f.source.scenes[1].actions = [
    { fill: { label: '公示时间' }, value: '2026-11-24 10:00:00', at: '公示时间' },
    { fill: { label: '报价开始时间' }, value: '2026-11-24 12:00:00', at: '报价开始时间' },
    { fill: { label: '报价截止时间' }, value: '2026-11-25 12:00:00', at: '报价截止时间' },
  ];
  f.save();
  assert.throws(() => loadScript(f.file), /进入表单填写前必须先在页面或列表中真实 click 触发按钮/);

  // 加上了 click 按钮，但 3 个 fill 字段只报读了字段名、没讲字段间先后关系 -> 拦截
  f.source.scenes[1].actions.unshift({ click: { text: '发布' }, at: '点击发布' });
  f.save();
  assert.throws(() => loadScript(f.file), /必须介绍字段之间的业务关系、先后顺序或校验规则/);

  // 讲了字段间先后顺序，但 ending.cancel 只讲了“点击取消”，没讲点击确定后的正确现象 -> 拦截
  f.source.scenes[1].narration = '在列表点击发布打开弹窗，按先后顺序依次填写公示时间、报价开始时间与报价截止时间，后续时间不能早于前序节点。';
  f.save();
  assert.throws(() => loadScript(f.file), /旁白都必须讲清楚点击确定\/保存\/提交后的正确系统现象/);

  // 讲了点击确定后的状态变化，但没讲功能生效后对下游角色/供应商的业务影响 -> 拦截
  f.source.scenes[1].ending.cancel.narration = '核对后点击确定，系统将提示操作完成且状态变为已完结；暂不办理可点击取消返回。';
  f.save();
  assert.throws(() => loadScript(f.file), /不只要介绍功能操作本身，还必须在旁白中介绍该功能生效后的业务影响/);

  // 同时讲清字段间先后关系、点击确定后的正确现象以及对下游供应商的业务影响 -> 编译通过
  f.source.scenes[1].ending.cancel.narration = '核对后点击确定，系统将提示发布成功且状态变为已发布，同时生成采购公告通知供应商并在报价开始时间开放报价权限；暂不办理可点击取消返回。';
  f.save();
  const ok = loadScript(f.file);
  assert.equal(ok.scenes.length, 2);
});
