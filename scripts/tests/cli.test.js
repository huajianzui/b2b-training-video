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
  const entry = (name, args, env = {}) => spawnSync(process.execPath, [path.join(root, name), ...args], {
    cwd: root, encoding: 'utf8', timeout: 5000, env: { ...process.env, ...env }
  });
  const run = (...args) => entry('produce.js', args);
  return { root, run, entry };
}
test('--help 在未安装依赖时也只显示帮助，不编译脚本或创建输出', (t) => {
  const f = fixture(t), r = f.run('--help');
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /--dry/); assert.match(r.stdout, /--bgm/);
  assert.equal(fs.existsSync(path.join(f.root, 'output')), false);
});

for (const name of ['play.js', 'manual.js', 'features.js', 'login.js', 'script.js', 'preflight.js', 'tools/files.js']) {
  test(name + ' 的帮助不需要依赖，损坏的旧配置与产物也不能触发执行', (t) => {
    const f = fixture(t), output = path.join(f.root, 'output'); fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, 'script.json'), 'INVALID_CACHED_JSON');
    fs.writeFileSync(path.join(f.root, 'project.json'), 'INVALID_LEGACY_JSON');
    for (const args of [['--help'], ['-h']]) {
      const r = f.entry(name, args);
      assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /用法/);
      assert.equal(fs.readFileSync(path.join(output, 'script.json'), 'utf8'), 'INVALID_CACHED_JSON');
      assert.deepEqual(fs.readdirSync(output), ['script.json']);
    }
  });
  test(name + ' 的未知选项和多余位置参数在读取旧配置与创建锁前拒绝', (t) => {
    const f = fixture(t);
    for (const args of [['demo.yaml', '--unknown-option'], ['a.yaml', 'b.yaml']]) {
      const r = f.entry(name, args);
      assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stderr, /参数|未知选项|只能|用法/);
      assert.equal(fs.existsSync(path.join(f.root, 'output')), false);
    }
  });
}
test('play 场景范围和 login 参数的缺值、非法值及冲突在配置读取前拒绝', (t) => {
  const f = fixture(t);
  const invalid = [
    ['play.js', ['demo.yaml', '--scenes']], ['play.js', ['demo.yaml', '--dry', '--scenes', 'abc']],
    ['play.js', ['demo.yaml', '--dry', '--scenes', '9-2']], ['play.js', ['demo.yaml', '--scenes', '2']],
    ['login.js', ['--project']], ['login.js', ['--mode']], ['login.js', ['--mode', 'bogus']],
    ['login.js', ['--start', 'bogus']], ['login.js', ['demo.yaml', '--project', 'old.json']],
    ['login.js', ['--check', '--clear']], ['login.js', ['--check', '--force']],
    ['features.js', ['merge', 'old.yaml']], ['features.js', ['merge', 'old.yaml', 'new.yaml', '--yes']]
  ];
  for (const [name, args] of invalid) {
    const r = f.entry(name, args); assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(fs.existsSync(path.join(f.root, 'output')), false);
  }
});
test('login 的显式和默认 YAML 输入生效，显式旧 JSON 入口保留且提示迁移', (t) => {
  const f = fixture(t), env = { NODE_PATH: path.join(scripts, 'node_modules') };
  const yaml = 'title: 登录核查\nurl: http://127.0.0.1:1\nlogin: {enabled: false}\nscenes: [{name: 占位, actions: []}]\n';
  fs.writeFileSync(path.join(f.root, 'script.yaml'), yaml); fs.writeFileSync(path.join(f.root, 'role.yaml'), yaml);
  fs.writeFileSync(path.join(f.root, 'project.json'), 'INVALID_LEGACY_JSON');
  for (const args of [[], ['role.yaml']]) {
    const r = f.entry('login.js', args, env); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /不需要登录/);
  }
  fs.writeFileSync(path.join(f.root, 'old.json'), '{"url":"http://127.0.0.1:1","login":{"enabled":false}}');
  const r = f.entry('login.js', ['--project', 'old.json'], env);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stderr, /迁移|兼容/);
});
test('非法参数不能顺带确认有效清单或删除现有登录态', (t) => {
  const f = fixture(t), env = { NODE_PATH: path.join(scripts, 'node_modules') };
  const feature = 'module: 核查\npages: [{id: list, name: 列表}]\nfeatures: [{id: list.view, name: 查看, page: list, kind: read, include: true}]\n';
  fs.writeFileSync(path.join(f.root, 'demo.features.yaml'), feature);
  const r = f.entry('features.js', ['demo.features.yaml', '--yes', '--unknown-option'], env);
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.equal(fs.readFileSync(path.join(f.root, 'demo.features.yaml'), 'utf8'), feature);
  fs.writeFileSync(path.join(f.root, 'project.json'), '{"url":"http://127.0.0.1:1","login":{"enabled":false}}');
  fs.mkdirSync(path.join(f.root, 'output')); const auth = path.join(f.root, 'output', 'auth.json'); fs.writeFileSync(auth, 'USER_AUTH_SENTINEL');
  const clear = f.entry('login.js', ['--project', 'project.json', '--clear', '--unknown-option'], env);
  assert.equal(clear.status, 2, clear.stdout + clear.stderr); assert.equal(fs.readFileSync(auth, 'utf8'), 'USER_AUTH_SENTINEL');
});
test('未知选项和缺少参数在执行前报错，不能把演练拼写错误当作正式出片', (t) => {
  const f = fixture(t);
  for (const args of [['demo.yaml', '--dray'], ['--from'], ['--bgm'], ['a.yaml', 'b.yaml']]) {
    const r = f.run(...args); assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /未知选项|缺少参数|只能指定一份/); assert.equal(fs.existsSync(path.join(f.root, 'output')), false);
  }
});
