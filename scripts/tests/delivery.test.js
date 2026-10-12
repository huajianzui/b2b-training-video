'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { ffmpegPath } = require('../deps');
const scripts = path.resolve(__dirname, '..');
const bodySrt = '1\n00:00:00,000 --> 00:00:00,500\n正文第一行\n\n2\n00:00:00,700 --> 00:00:01,200\n正文第二行\n';

function fixture(t, cards = {}) {
  if (!process.env.PYTHON) { t.skip('设置 PYTHON 后运行真实片头与字幕交付回归'); return null; }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'training-delivery-')), root = path.join(temp, 'runtime'), out = path.join(root, 'output');
  fs.cpSync(scripts, root, { recursive: true, filter: (f) => !['node_modules', 'tests', 'output', 'assets', '__pycache__'].includes(path.basename(f)) });
  fs.symlinkSync(path.join(scripts, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  fs.mkdirSync(out); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const file = path.join(root, 'demo.yaml');
  const source = { title: '交付回归', url: 'https://example.invalid', login: { enabled: false }, adapters: [], ...cards,
    scenes: [{ id: 'view', name: '查看', narration: '', actions: [] }] };
  const save = () => fs.writeFileSync(file, YAML.stringify(source)); save();
  const media = path.join(out, 'demo-voiced.mp4');
  const encoded = spawnSync(ffmpegPath(), ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=lime:s=1920x1080:r=25',
    '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '1.4', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-video_track_timescale', '12800', '-movflags', '+faststart', media], { encoding: 'utf8' });
  assert.equal(encoded.status, 0, encoded.error?.message || encoded.stderr);
  fs.writeFileSync(path.join(out, 'subs.srt'), bodySrt);
  const { loadScript } = require(path.join(root, 'script')), { openPipeline } = require(path.join(root, 'pipeline'));
  const seed = () => { const p = openPipeline(out, loadScript(file), 'script', { manual: false }); p.complete('compose', ['demo-voiced.mp4', 'subs.srt']); };
  seed();
  const run = (flags = []) => spawnSync(process.execPath, [path.join(root, 'produce.js'), 'demo.yaml', '--from', 'cards', '--no-manual', '--no-login', ...flags], {
    cwd: root, env: { ...process.env, NODE_PATH: path.join(scripts, 'node_modules'), PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8',
  });
  return { root, out, file, source, save, seed, media, run, named: path.join(out, '交付回归.mp4') };
}

test('片头生成失败必须中止，不能降级成正片并报告完成', { timeout: 60000 }, (t) => {
  const f = fixture(t, { intro: { title: '片头', narration: '', duration: 1 } }); if (!f) return;
  fs.writeFileSync(path.join(f.root, 'intro.py'), 'raise SystemExit("fixture cards failure")\n');
  const r = f.run(); assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stderr, /片头片尾.*失败/);
  assert.equal(fs.existsSync(f.named), false); assert.doesNotMatch(r.stdout, /║  完成/);
});

test('从 cards 续跑也校验最终媒体，不能把旧缓存中的空 MP4 交付为成功', { timeout: 60000 }, (t) => {
  const f = fixture(t); if (!f) return;
  fs.writeFileSync(f.media, Buffer.alloc(0)); f.seed();
  const r = f.run(['--no-cards']); assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(fs.existsSync(f.named), false); assert.doesNotMatch(r.stdout, /║  完成/);
});

function firstBodyTime(file) {
  const r = spawnSync(ffmpegPath(), ['-nostdin', '-v', 'info', '-i', file, '-an', '-vf', 'scale=1:1,showinfo', '-vsync', '0', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
  assert.equal(r.status, 0, r.stderr?.toString());
  const times = [...r.stderr.toString().matchAll(/\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:([\d.e+-]+)/g)].map((m) => Number(m[1]));
  assert.equal(times.length, r.stdout.length / 3);
  for (let i = 0; i < r.stdout.length; i += 3) if (r.stdout[i + 1] > 5 && r.stdout[i + 1] > 3 * r.stdout[i] && r.stdout[i + 1] > 3 * r.stdout[i + 2]) return times[i / 3];
  assert.fail('未解码到正文的绿色帧');
}
function firstCueTime(text) {
  const m = /(\d+):(\d+):(\d+),(\d+) -->/.exec(text); assert.ok(m);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}
function deliveredSrt(f, result) {
  const match = /字幕：output[\\/](.+)/.exec(result.stdout); assert.ok(match, result.stdout);
  return { file: match[1].trim(), text: fs.readFileSync(path.join(f.out, match[1].trim()), 'utf8') };
}

for (const kind of ['intro', 'outro']) test('真实' + (kind === 'intro' ? '片头' : '片尾') + '交付字幕与解码后的正文时间一致', { timeout: 60000 }, (t) => {
  const f = fixture(t, { [kind]: { title: kind === 'intro' ? '片头' : '片尾', narration: '', duration: 1 } }); if (!f) return;
  const r = f.run(); assert.equal(r.status, 0, r.stdout + r.stderr);
  const srt = deliveredSrt(f, r), bodyAt = firstBodyTime(f.named), cueAt = firstCueTime(srt.text);
  // 淡入首帧可能为黑；允许两个 25fps 帧的解码边界误差。
  assert.ok(Math.abs(cueAt - bodyAt) < 2 / 25, '字幕 ' + cueAt + 's，正文首个可识别帧 ' + bodyAt + 's');
  assert.equal(srt.file, '交付回归.srt'); assert.equal(fs.readFileSync(path.join(f.out, 'subs.srt'), 'utf8'), bodySrt);
  assert.match(srt.text, /正文第一行/); assert.match(srt.text, /正文第二行/);
  if (kind === 'intro') {
    const again = f.run(); assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(deliveredSrt(f, again).text, srt.text);
    f.source.intro.duration = 1.4; f.save();
    const changed = f.run(); assert.equal(changed.status, 0, changed.stdout + changed.stderr);
    const shifted = deliveredSrt(f, changed).text;
    assert.ok(firstCueTime(shifted) > cueAt + 0.3);
    assert.ok(Math.abs(firstCueTime(shifted) - firstBodyTime(f.named)) < 2 / 25);
  } else assert.equal(srt.text, bodySrt);
});

test('明确不加片头片尾时，同名字幕不偏移且媒体仍通过交付校验', { timeout: 60000 }, (t) => {
  const f = fixture(t, { intro: { title: '不会执行', narration: '', duration: 1 } }); if (!f) return;
  const r = f.run(['--no-cards']); assert.equal(r.status, 0, r.stdout + r.stderr);
  const srt = deliveredSrt(f, r); assert.equal(srt.file, '交付回归.srt'); assert.equal(srt.text, bodySrt);
});

test('视频标题不能使成品字幕覆盖正片字幕及续跑来源', { timeout: 60000 }, (t) => {
  const f = fixture(t); if (!f) return;
  f.source.title = 'subs'; f.save();
  const r = f.run(['--no-cards']); assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stderr, /文件名冲突/);
  assert.equal(fs.readFileSync(path.join(f.out, 'subs.srt'), 'utf8'), bodySrt);
});

test('同时加片头片尾时，淡入与流复制拼接均使用实际正文时间轴', { timeout: 60000 }, (t) => {
  const f = fixture(t, { intro: { title: '片头', narration: '', duration: 1 }, outro: { title: '片尾', narration: '', duration: 1 } }); if (!f) return;
  const fade = f.run(); assert.equal(fade.status, 0, fade.stdout + fade.stderr);
  assert.ok(Math.abs(firstCueTime(deliveredSrt(f, fade).text) - firstBodyTime(f.named)) < 2 / 25);
  const srt = path.join(f.out, 'cut.srt'), video = path.join(f.out, 'cut.mp4');
  const cut = spawnSync(process.env.PYTHON, [path.join(f.root, 'intro.py'), '--config', path.join(f.out, 'cards.gen.json'),
    '--attach', f.media, '--out', video, '--transition', 'cut', '--srt-input', path.join(f.out, 'subs.srt'), '--srt-output', srt], {
    cwd: f.root, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', FFMPEG: ffmpegPath(), NODE_EXE: process.execPath }, encoding: 'utf8',
  });
  assert.equal(cut.status, 0, cut.stdout + cut.stderr); assert.match(cut.stdout, /流复制拼接成功/);
  assert.ok(Math.abs(firstCueTime(fs.readFileSync(srt, 'utf8')) - firstBodyTime(video)) < 2 / 25);
  assert.equal(fs.readFileSync(path.join(f.out, 'subs.srt'), 'utf8'), bodySrt);
});
