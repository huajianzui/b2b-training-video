'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'training-test-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ['test-runner.js', 'cli.js']) fs.copyFileSync(path.join(__dirname, '..', file), path.join(root, file));
  if (source !== null) {
    fs.mkdirSync(path.join(root, 'tests'));
    fs.writeFileSync(path.join(root, 'tests', 'fixture.test.js'), source);
  }
  const env = { ...process.env };
  // 子进程验证独立 CLI；不继承 Node 为当前测试文件设置的递归检测标记。
  delete env.NODE_TEST_CONTEXT;
  return (...args) => spawnSync(process.execPath, [path.join(root, 'test-runner.js'), ...args], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
}
test('完整验收入口在真实测试全通过时成功，在跳过时明确失败', { timeout: 60000 }, t => {
  const passing = fixture(t, "require('node:test').test('actual pass', () => {});")();
  assert.equal(passing.status, 0, passing.stdout + passing.stderr); assert.match(passing.stdout, /完整验收通过/);
  const skipped = fixture(t, "require('node:test').test('actual skip', t => t.skip('fixture requires browser'));")();
  assert.equal(skipped.status, 2, skipped.stdout + skipped.stderr); assert.match(skipped.stderr, /1 项跳过/);
  assert.doesNotMatch(skipped.stdout, /完整验收通过/);
});
test('只有显式部分回归允许跳过，失败用例在部分模式也不能通过', { timeout: 60000 }, t => {
  const skipped = fixture(t, "require('node:test').test('actual skip', t => t.skip('fixture')); ")('--allow-skips');
  assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr); assert.match(skipped.stdout, /部分回归通过.*集成验收未完成/);
  const run = fixture(t, "require('node:test').test('actual failure', () => { throw new Error('fixture failed'); });");
  for (const args of [[], ['--allow-skips']]) {
    const failed = run(...args); assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.doesNotMatch(failed.stdout, /完整验收通过|部分回归通过/);
  }
});
test('Node 将 TODO 用例计为待完成时，两种模式都不能报告回归通过', { timeout: 60000 }, t => {
  const run = fixture(t, "require('node:test').test('actual todo', {todo: true}, () => { throw new Error('unfinished assertion'); });");
  for (const args of [[], ['--allow-skips']]) {
    const pending = run(...args); assert.equal(pending.status, 2, pending.stdout + pending.stderr);
    assert.match(pending.stderr, /1 项待完成.*TODO/);
    assert.doesNotMatch(pending.stdout, /完整验收通过|部分回归通过/);
  }
});
test('空安装目录不能假报验收通过，帮助和未知参数不启动测试', { timeout: 60000 }, t => {
  const run = fixture(t, null);
  const missing = run(); assert.equal(missing.status, 2); assert.match(missing.stderr, /没有测试文件/);
  const help = run('--help'); assert.equal(help.status, 0); assert.match(help.stdout, /用法/);
  const unknown = run('--allow-skip'); assert.equal(unknown.status, 2); assert.match(unknown.stderr, /未知选项/);
});
