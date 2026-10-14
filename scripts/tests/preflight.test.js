'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function probe(t, blockedModule) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'training-python-probe-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(temp, 'sitecustomize.py'), `import sys
class BlockImport:
    def find_spec(self, fullname, path=None, target=None):
        if fullname == ${JSON.stringify(blockedModule)}:
            raise ModuleNotFoundError('fixture blocked ' + fullname)
sys.meta_path.insert(0, BlockImport())
`);
  const env = { ...process.env, PYTHONPATH: temp, PYTHONDONTWRITEBYTECODE: '1' };
  const missing = spawnSync(process.env.PYTHON, ['-c', 'import ' + blockedModule], { cwd: temp, env, encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.ok(missing.stderr.includes('fixture blocked ' + blockedModule), missing.error?.message || missing.stderr);
  const script = `console.log(require(${JSON.stringify(path.resolve(__dirname, '../preflight'))}).findPython())`;
  return spawnSync(process.execPath, ['-e', script], { cwd: temp, env, encoding: 'utf8' });
}

test('Python 前置检查不要求未使用的 Pillow', (t) => {
  if (!process.env.PYTHON) return t.skip('设置 PYTHON 后运行真实解释器依赖检查');
  const result = probe(t, 'PIL');
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.ok(fs.existsSync(result.stdout.trim()), result.stdout);
});

test('显式 Python 缺少 edge-tts 仍拒绝，不换用其他解释器', (t) => {
  if (!process.env.PYTHON) return t.skip('设置 PYTHON 后运行真实解释器依赖检查');
  const result = probe(t, 'edge_tts');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /所选 Python 3 或 edge-tts.*不可用/);
});
