'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ffmpegPath } = require('../deps');
const scripts = path.resolve(__dirname, '..');

test('无旁白的合法脚本实际合成静音音轨、空字幕和有效视频', { timeout: 60000 }, (t) => {
  if (!process.env.PYTHON) return t.skip('设置 PYTHON 后运行真实无旁白合成回归');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'training-compose-')), out = path.join(root, 'output');
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.mkdirSync(path.join(out, 'tts'), { recursive: true });
  for (const file of ['compose.py', 'subtitles.py']) fs.copyFileSync(path.join(scripts, file), path.join(root, file));
  const encoded = spawnSync(ffmpegPath(), ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=25',
    '-t', '1.4', '-c:v', 'libvpx', path.join(out, 'raw.webm')], { encoding: 'utf8' });
  assert.equal(encoded.status, 0, encoded.error?.message || encoded.stderr);
  fs.writeFileSync(path.join(out, 'script.json'), JSON.stringify({ scenes: [{ id: 'view', narration: '' }] }));
  fs.writeFileSync(path.join(out, 'session.json'), JSON.stringify({ duration: 1.4, scenes: [{ id: 'view', audioAt: 0 }] }));
  fs.writeFileSync(path.join(out, 'tts', 'manifest.json'), JSON.stringify({ scenes: {} }));
  const r = spawnSync(process.env.PYTHON, [path.join(root, 'compose.py')], { cwd: root, encoding: 'utf8',
    env: { ...process.env, FFMPEG: ffmpegPath(), PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(fs.readFileSync(path.join(out, 'subs.srt'), 'utf8'), '');
  const checked = spawnSync(process.execPath, [path.join(scripts, 'tools', 'mp4info.js'), path.join(out, 'demo-voiced.mp4'), '--require-audio', '--decode'], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});
