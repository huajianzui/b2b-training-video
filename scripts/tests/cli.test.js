'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const scripts = path.resolve(__dirname, '..');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'training-cli-'));
  fs.cpSync(scripts, root, { recursive: true, filter: (f) => !['node_modules', 'tests', 'output', 'assets', '__pycache__'].includes(path.basename(f)) });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'produce.js'), ...args], { cwd: root, encoding: 'utf8' });
  return { root, run };
}
test('--help 在未安装依赖时也只显示帮助，不编译脚本或创建输出', (t) => {
  const f = fixture(t), r = f.run('--help');
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /--dry/); assert.match(r.stdout, /--bgm/);
  assert.equal(fs.existsSync(path.join(f.root, 'output')), false);
});
test('未知选项和缺少参数在执行前报错，不能把演练拼写错误当作正式出片', (t) => {
  const f = fixture(t);
  for (const args of [['demo.yaml', '--dray'], ['--from'], ['--bgm'], ['a.yaml', 'b.yaml']]) {
    const r = f.run(...args); assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /未知选项|缺少参数|只能指定一份/); assert.equal(fs.existsSync(path.join(f.root, 'output')), false);
  }
});
