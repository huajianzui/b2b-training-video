'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ffmpegPath } = require('../deps');
let root, video, silent, audio;
const checker = path.resolve(__dirname, '../tools/mp4info.js');
function generate(file, flags) {
  const r = spawnSync(ffmpegPath(), ['-nostdin', '-y', '-v', 'error', ...flags, '-t', '1.4', '-movflags', '+faststart', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.error?.message || r.stderr);
}
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'training-media-'));
  video = path.join(root, 'video.mp4'); silent = path.join(root, 'silent.mp4'); audio = path.join(root, 'audio.mp4');
  const color = ['-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=25'];
  const sound = ['-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono'];
  generate(video, [...color, ...sound, '-c:v', 'libx264', '-c:a', 'aac']);
  generate(silent, [...color, '-c:v', 'libx264', '-an']);
  generate(audio, [...sound, '-c:a', 'aac', '-vn']);
});
after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });
function check(file, flags = [], env = {}) {
  return spawnSync(process.execPath, [checker, file, ...flags], { env: { ...process.env, ...env }, encoding: 'utf8' });
}
function malformed(name, mutate) {
  const file = path.join(root, name + '.mp4'); fs.writeFileSync(file, mutate(fs.readFileSync(video))); return file;
}
test('空 MP4 不能返回校验正常', () => {
  const f = malformed('empty', () => Buffer.alloc(0)); assert.equal(check(f).status, 2);
});
test('缺 moov 和截断 mdat 的 MP4 都不能交付', () => {
  const missing = malformed('missing-moov', (buf) => {
    const parts = []; for (let at = 0; at < buf.length;) { const size = buf.readUInt32BE(at); if (buf.toString('ascii', at + 4, at + 8) !== 'moov') parts.push(buf.subarray(at, at + size)); at += size; }
    return Buffer.concat(parts);
  });
  assert.equal(check(missing).status, 2);
  assert.equal(check(malformed('truncated', (buf) => buf.subarray(0, buf.length - 5))).status, 2);
});
test('只有音轨的 MP4 不通过视频校验，要求配音时也拒绝只有视频的文件', () => {
  assert.equal(check(audio).status, 2); assert.equal(check(silent, ['--require-audio']).status, 2);
  assert.equal(check(silent).status, 0);
});
test('容器正常但视频负载损坏时实际解码失败', () => {
  const damaged = malformed('bad-payload', (buf) => {
    for (let at = 0; at < buf.length;) { const size = buf.readUInt32BE(at); if (buf.toString('ascii', at + 4, at + 8) === 'mdat') buf.fill(0, at + 8, at + size); at += size; }
    return buf;
  });
  assert.equal(check(damaged, ['--require-audio', '--decode']).status, 2);
});
test('有效音视频通过元数据和实际解码校验，解码器缺失明确失败', () => {
  const good = check(video, ['--require-audio', '--decode']); assert.equal(good.status, 0, good.stdout + good.stderr);
  const missing = check(video, ['--decode'], { FFMPEG: path.join(root, 'missing-ffmpeg.exe') });
  assert.equal(missing.status, 2); assert.match(missing.stderr, /解码|ffmpeg/);
});
