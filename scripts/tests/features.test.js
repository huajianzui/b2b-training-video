'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { mergeFresh, loadFeatures, saveDecisions } = require('../features');
const bulk = require('../app/bulk');

test('全局与模块批量只改已选可执行写功能，保留例外和固定限制', () => {
  const item = (id, extra = {}) => ({ id, page: 'a', include: true, kind: 'write', rehearsalMode: '', writeMode: 'cancel', modeOverrides: [], ...extra });
  const rows = [item('normal'), item('exception', { modeOverrides: ['writeMode'] }), item('restricted', { submitRestriction: '禁止通知' }),
    item('other', { page: 'b' }), item('off', { include: false }), item('read', { kind: 'read' }),
    item('blocked', { blocked: '待批准文件' }), item('removed', { status: 'removed' })];
  bulk.apply(rows, { page: 'a', values: { rehearsalMode: 'submit', writeMode: 'submit' }, testData: true });
  assert.equal(rows[0].writeMode, 'submit'); assert.equal(rows[1].writeMode, 'cancel'); assert.equal(rows[1].rehearsalMode, 'submit');
  for (const f of rows.slice(2)) assert.equal(f.writeMode, 'cancel', f.id);
  bulk.apply(rows, { values: { writeMode: 'submit' }, override: true, testData: true });
  assert.equal(rows[1].writeMode, 'submit'); assert.equal(rows[3].writeMode, 'submit');
  assert.equal(rows[2].writeMode, 'cancel'); assert.equal(rows[2].rehearsalMode, '');
  assert.throws(() => bulk.apply(rows, { values: { writeMode: 'submit' } }), /环境/);
});

test('固定禁止提交通过直接保存及脚本编译仍不能越过，旧选择的例外标记保留', (t) => {
  const f = fixture(t); f.source.features[0].include = true; f.source.features[0].rehearsalMode = 'cancel';
  f.source.features[0].submitRestriction = '申请不能通知'; f.save(f.source);
  const original = fs.readFileSync(f.saved, 'utf8');
  assert.throws(() => saveDecisions(f.saved, { create: { writeMode: 'submit', modeOverrides: [] } }, true), /不能 submit/);
  assert.equal(fs.readFileSync(f.saved, 'utf8'), original);
  assert.deepEqual(loadFeatures(f.saved).features[0].modeOverrides, ['rehearsalMode', 'writeMode']);
  const next = structuredClone(f.source); delete next.features[0].submitRestriction;
  fs.writeFileSync(f.fresh, YAML.stringify(next)); mergeFresh(f.saved, f.fresh);
  assert.equal(loadFeatures(f.saved).features[0].submitRestriction, '申请不能通知');
  const source = YAML.parse(fs.readFileSync(f.saved, 'utf8')); source.confirmedAt = 'fixture'; source.features[0].writeMode = 'submit';
  fs.writeFileSync(f.saved, YAML.stringify(source));
  const script = path.join(path.dirname(f.saved), 'demo.yaml');
  fs.writeFileSync(script, YAML.stringify({ url: 'https://example.invalid', features: path.basename(f.saved), scenes: [{ actions: [] }] }));
  assert.throws(() => require('../script').loadScript(script), /不能 submit/);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'training-merge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const saved = path.join(root, 'saved.features.yaml'), fresh = path.join(root, 'fresh.features.yaml');
  const source = { module: '订单', script: 'demo.yaml', confirmedAt: 'approved', generatedAt: 'old',
    environment: { name: '用户批准的测试环境', testData: true },
    pages: [{ id: 'orders', name: '订单', entry: '点击订单', route: '/orders', files: ['orders.vue'] }],
    features: [{ id: 'create', name: '新增', page: 'orders', kind: 'write', include: false,
      writeMode: 'cancel', rehearsalMode: 'submit', writeRequests: [{ method: 'POST', url: '/api/orders' }] }] };
  const save = (next) => { fs.writeFileSync(saved, YAML.stringify(source)); fs.writeFileSync(fresh, YAML.stringify(next)); };
  return { saved, fresh, source, save };
}

test('同 ID 的业务信息变化撤销确认并提示变化，保留用户选择和环境', (t) => {
  const f = fixture(t);
  for (const [key, value] of Object.entries({ name: '新建订单', desc: '限定订单类型', how: '点击新建', permission: 'admin',
    when: '审核后', requires: '新文件', blocked: '接口不可用', minor: true, shared: '通用操作', source: 'other.vue:2' })) {
    const next = structuredClone(f.source); next.features[0][key] = value;
    next.features[0].include = true; next.features[0].writeMode = 'submit'; next.features[0].rehearsalMode = 'cancel';
    next.environment = { name: '盘点者猜测的环境', testData: false };
    f.save(next);
    const result = mergeFresh(f.saved, f.fresh), merged = loadFeatures(f.saved);
    assert.equal(result.changed, true, key); assert.equal(merged.confirmedAt, '', key);
    assert.equal(merged.features[0].status, 'changed', key);
    assert.equal(merged.features[0].include, false); assert.equal(merged.features[0].writeMode, 'cancel');
    assert.equal(merged.features[0].rehearsalMode, 'submit'); assert.deepEqual(merged.environment, f.source.environment);
    saveDecisions(f.saved, {}, true); assert.equal(loadFeatures(f.saved).features[0].status, '');
  }
});

test('页面入口或路由变化也撤销旧确认，单纯盘点时间变化保留确认', (t) => {
  const f = fixture(t);
  for (const [key, value] of Object.entries({ name: '新订单页', entry: '点击销售', route: '/sales/orders', files: ['sales.vue'] })) {
    const next = structuredClone(f.source); next.pages[0][key] = value; f.save(next);
    assert.equal(mergeFresh(f.saved, f.fresh).changed, true, key); assert.equal(loadFeatures(f.saved).confirmedAt, '');
  }
  const unchanged = structuredClone(f.source); unchanged.generatedAt = 'new'; unchanged.generatedBy = '另一 Agent'; f.save(unchanged);
  assert.equal(mergeFresh(f.saved, f.fresh).changed, false); assert.equal(loadFeatures(f.saved).confirmedAt, 'approved');
  const renamed = structuredClone(f.source); renamed.module = '销售订单'; f.save(renamed);
  assert.equal(mergeFresh(f.saved, f.fresh).changed, true); assert.equal(loadFeatures(f.saved).confirmedAt, '');
});

test('未重新确认前再次盘点仍保留变化标记', (t) => {
  const f = fixture(t), next = structuredClone(f.source); next.features[0].when = '已通过审批'; f.save(next);
  mergeFresh(f.saved, f.fresh); mergeFresh(f.saved, f.fresh);
  assert.equal(loadFeatures(f.saved).features[0].status, 'changed'); assert.equal(loadFeatures(f.saved).confirmedAt, '');
});
