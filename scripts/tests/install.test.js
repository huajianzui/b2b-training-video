'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installRuntime } = require('../install-runtime');
const scripts = path.resolve(__dirname, '..');
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'training-install-')), target = path.join(temp, 'runtime');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  return { temp, target };
}
test('首次安装复制工具，重复升级保留用户脚本、清单和产物', (t) => {
  const f = fixture(t); installRuntime(scripts, f.target);
  assert.equal(fs.readFileSync(path.join(f.target, 'produce.js'), 'utf8'), fs.readFileSync(path.join(scripts, 'produce.js'), 'utf8'));
  const userFiles = ['script.yaml', 'examples/script.yaml', 'examples/authenticated.yaml', 'demo.yaml', 'demo.features.yaml', 'output/pipeline.json', 'node_modules/user-owned', 'assets/user-font'];
  for (const rel of userFiles) { const file = path.join(f.target, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'user-file:' + rel); }
  fs.writeFileSync(path.join(f.target, 'produce.js'), 'old-tool-code');
  installRuntime(scripts, f.target);
  for (const rel of userFiles) assert.equal(fs.readFileSync(path.join(f.target, rel), 'utf8'), 'user-file:' + rel);
  assert.equal(fs.readFileSync(path.join(f.target, 'produce.js'), 'utf8'), fs.readFileSync(path.join(scripts, 'produce.js'), 'utf8'));
  assert.equal(fs.existsSync(path.join(f.target, 'tests')), false);
});
test('全新安装包含工作流要求的快照与 MP4 诊断工具，安装后的帮助可运行', (t) => {
  const f = fixture(t); installRuntime(scripts, f.target);
  for (const rel of ['tools/snap.js', 'tools/mp4info.js', 'tools/files.js', 'uploads.js', 'preflight.js', 'speech.py', 'app/bulk.js', 'prompts/files.md', 'prompts/production-brief.md']) {
    assert.equal(fs.readFileSync(path.join(f.target, rel), 'utf8'), fs.readFileSync(path.join(scripts, rel), 'utf8'));
  }
  const r = spawnSync(process.execPath, [path.join(f.target, 'tools/snap.js'), '--help'], {
    cwd: f.target, encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(scripts, 'node_modules') }
  });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /用法/);
  assert.equal(fs.existsSync(path.join(f.target, 'output')), false);
});
for (const dir of ['tools', 'demo']) test('新增安装目录 ' + dir + ' 的目标链接也必须在写入前拒绝', (t) => {
  const f = fixture(t); fs.mkdirSync(f.target); fs.writeFileSync(path.join(f.target, 'package.json'), '{"name":"b2b-training-video"}');
  const outside = path.join(f.temp, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.target, dir), 'junction');
  assert.throws(() => installRuntime(scripts, f.target), /符号链接/);
  assert.deepEqual(fs.readdirSync(outside), []); assert.equal(fs.existsSync(path.join(f.target, 'produce.js')), false);
});
test('非工具目录和正在运行的工具目录不会被覆盖', (t) => {
  const f = fixture(t); fs.mkdirSync(f.target); fs.writeFileSync(path.join(f.target, 'important.txt'), 'keep');
  assert.throws(() => installRuntime(scripts, f.target), /拒绝覆盖/);
  assert.equal(fs.existsSync(path.join(f.target, 'produce.js')), false);
  fs.writeFileSync(path.join(f.target, 'package.json'), '{"name":"b2b-training-video"}');
  fs.mkdirSync(path.join(f.target, 'output')); fs.writeFileSync(path.join(f.target, 'output', '.produce.lock'), 'owned-lock');
  assert.throws(() => installRuntime(scripts, f.target), /执行锁/);
  assert.equal(fs.readFileSync(path.join(f.target, 'important.txt'), 'utf8'), 'keep');
});
test('目标子目录链接与源目标重叠会在写入前拒绝', (t) => {
  const f = fixture(t); fs.mkdirSync(f.target); fs.writeFileSync(path.join(f.target, 'package.json'), '{"name":"b2b-training-video"}');
  const outside = path.join(f.temp, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.target, 'app'), 'junction');
  assert.throws(() => installRuntime(scripts, f.target), /符号链接/);
  assert.deepEqual(fs.readdirSync(outside), []); assert.equal(fs.existsSync(path.join(f.target, 'produce.js')), false);
  assert.throws(() => installRuntime(scripts, scripts), /相同|嵌套/);
  fs.unlinkSync(path.join(f.target, 'app'));
  const missing = path.join(f.temp, 'missing'); fs.symlinkSync(missing, path.join(f.target, 'app'), 'junction');
  assert.throws(() => installRuntime(scripts, f.target), /符号链接/);
  assert.equal(fs.existsSync(missing), false); assert.equal(fs.existsSync(path.join(f.target, 'produce.js')), false);
});
