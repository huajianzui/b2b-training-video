'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { installRuntime } = require('../install-runtime');
const { loadScript } = require('../script');
const { ffmpegPath } = require('../deps');
const scripts = path.resolve(__dirname, '..');

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'training-runtime-')), root = path.join(temp, 'runtime');
  installRuntime(scripts, root);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  return { root, temp };
}

test('安装后的两个本地示例都指向实际页面，登录格式示例可校验并保留配音规则', t => {
  const f = fixture(t);
  for (const file of ['script.yaml', 'examples/script.yaml']) {
    const script = loadScript(path.join(f.root, file));
    assert.equal(fs.existsSync(require('node:url').fileURLToPath(script.url)), true);
  }
  const example = path.join(f.root, 'examples', 'authenticated.yaml');
  const raw = YAML.parse(fs.readFileSync(example, 'utf8')), script = loadScript(example);
  assert.equal(raw.login.mode, 'auto'); assert.equal(raw.login.reuse, false); assert.equal(raw.login.storage, 'output/auth.json');
  assert.equal(raw.login.username, '${TRAINING_DEMO_USER}'); assert.equal(raw.login.password, '${TRAINING_DEMO_PASSWORD}');
  assert.equal(script.readOnlyRequests.length, 2); assert.match(script.scenes[0].speech, /每一航/);
  assert.match(script.scenes[0].narration, /每一行/);
  assert.match(script.url, /\.invalid\//);
});

test('从全新安装目录完成本地示例演练、页面快照和 MP4 实际解码诊断', { timeout: 60000 }, async t => {
  if (!process.env.TEST_BROWSER_PATH) return t.skip('设置 TEST_BROWSER_PATH 后验证安装后的真实工具入口');
  const f = fixture(t), preload = path.join(f.temp, 'browser.cjs');
  fs.writeFileSync(preload, `const pw = require(${JSON.stringify(path.join(scripts, 'node_modules', 'playwright'))});
const launch = pw.chromium.launch.bind(pw.chromium);
pw.chromium.launch = options => launch({ ...options, executablePath: process.env.TEST_BROWSER_PATH, headless: true });`);
  const env = { ...process.env, NODE_PATH: path.join(scripts, 'node_modules'), PW_WORKSPACE: scripts,
    NODE_OPTIONS: '--require=' + JSON.stringify(preload) };
  const run = (file, args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(f.root, file), ...args], { cwd: f.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, log }); });
  });
  for (const sample of ['script.yaml', 'examples/script.yaml']) {
    const result = await run('play.js', [sample, '--dry']); assert.equal(result.code, 0, result.log);
    const report = JSON.parse(fs.readFileSync(path.join(f.root, 'output', 'run-report.json')));
    assert.equal(report.ok, true); assert.equal(report.scenes.length, 5); assert.deepEqual(report.writes, []);
  }
  const subset = await run('play.js', ['script.yaml', '--dry', '--scenes', '2']);
  assert.equal(subset.code, 0, subset.log);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'output', 'run-report.json'))).scenes.length, 1);
  const steps = path.join(f.root, 'probe.json');
  fs.writeFileSync(steps, JSON.stringify([['goto', loadScript(path.join(f.root, 'script.yaml')).url], ['click', '#orders'], ['snap', 'installed-probe']]));
  const snap = await run('tools/snap.js', ['-', steps]); assert.equal(snap.code, 0, snap.log);
  const shot = path.join(f.root, 'output', '_snap', 'installed-probe.png'); assert.ok(fs.statSync(shot).size > 1000);
  assert.match(fs.readFileSync(path.join(f.root, 'output', '_snap', 'installed-probe.aria.yaml'), 'utf8'), /本地订单管理示例/);
  if (process.env.TEST_ARTIFACTS) fs.copyFileSync(shot, path.join(process.env.TEST_ARTIFACTS, 'installed-demo-1920.png'));
  const mp4 = path.join(f.root, 'output', 'diagnostic.mp4');
  const encoded = spawnSync(ffmpegPath(), ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=320x180:r=25',
    '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', mp4], { encoding: 'utf8', timeout: 60000 });
  assert.equal(encoded.status, 0, encoded.error?.message || encoded.stderr);
  const info = await run('tools/mp4info.js', [mp4, '--require-audio', '--decode']);
  assert.equal(info.code, 0, info.log); assert.match(info.log, /元数据与实际解码正常/);
});
