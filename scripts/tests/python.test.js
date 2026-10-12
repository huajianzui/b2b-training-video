'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Python 媒体验收故障和字幕边界回归', { timeout: 60000 }, (t) => {
  if (!process.env.PYTHON) return t.skip('设置 PYTHON 指向 Python 3 后运行 Python 回归');
  const r = spawnSync(process.env.PYTHON, ['-m', 'unittest', 'discover', '-s', 'tests', '-p', '*_test.py', '-v'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(r.status, 0, r.error?.message || r.stdout + r.stderr);
});
