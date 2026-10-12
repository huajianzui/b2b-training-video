'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { loadScript } = require('../script');
const { acquireLock } = require('../pipeline');

const scripts = path.resolve(__dirname, '..');
const yaml = (extra = '') => `title: 示例\nurl: https://example.invalid\nlogin: {enabled: false}\n${extra}scenes:\n  - id: view\n    name: 查看\n    narration: 查看第三行。\n    actions: []\n`;

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'training-resume-'));
  const root = path.join(temp, 'runtime');
  fs.cpSync(scripts, root, { recursive: true, filter: (file) => !['node_modules', 'output', 'tests', 'assets'].includes(path.basename(file)) });
  fs.mkdirSync(path.join(root, 'output'));
  fs.symlinkSync(path.join(scripts, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  const file = path.join(root, 'demo.yaml');
  fs.writeFileSync(file, yaml());
  fs.writeFileSync(path.join(root, 'output', 'script.json'), JSON.stringify(loadScript(file)));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const run = (name = 'demo.yaml', from = 'tts', flags = []) => spawnSync(process.execPath,
    [path.join(root, 'produce.js'), name, '--dry', '--from', from, '--no-login', '--no-manual', ...flags],
    { cwd: root, env: { ...process.env, NODE_PATH: path.join(scripts, 'node_modules') }, encoding: 'utf8', timeout: 10000 });
  return { root, file, run, out: path.join(root, 'output') };
}

test('旧 output/script.json 缺少产物来源记录时，续跑明确拒绝并提示迁移', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /续跑|来源/);
  assert.match(result.stderr, /script|从头/);
});

test('指定 YAML 语法错误时不能借旧 JSON 继续运行', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, 'scenes: [broken');
  const result = f.run();
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /YAML 语法错误/);
});

test('续跑重新检查功能清单确认状态', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, yaml('features: demo.features.yaml\n'));
  fs.writeFileSync(path.join(f.root, 'demo.features.yaml'), "module: 示例\nconfirmedAt: ''\npages: []\nfeatures: []\n");
  const result = f.run();
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /还没有确认/);
});

// 仅构造阶段来源记录和可校验的合成字节，不把这些夹具当作可播放的视频。
function seed(f) {
  const script = loadScript(f.file);
  const { openPipeline } = require(path.join(f.root, 'pipeline'));
  const p = openPipeline(f.out, script, 'script', { manual: false });
  fs.writeFileSync(path.join(f.out, 'check-report.json'), '{"ok":true}');
  p.complete('check', ['check-report.json']);
  fs.mkdirSync(path.join(f.out, 'tts'), { recursive: true });
  fs.writeFileSync(path.join(f.out, 'tts', 'view.mp3'), 'fixture-audio');
  fs.writeFileSync(path.join(f.out, 'tts', 'manifest.json'), JSON.stringify({ scenes: { view: { file: 'output/tts/view.mp3', dur: 1 } } }));
  p.complete('tts', ['tts/manifest.json', 'tts/view.mp3']);
  fs.writeFileSync(path.join(f.out, 'raw.webm'), 'fixture-video');
  fs.writeFileSync(path.join(f.out, 'session.json'), '{"scenes":[]}');
  p.complete('record', ['raw.webm', 'session.json']);
  fs.writeFileSync(path.join(f.out, 'demo-voiced.mp4'), 'fixture-composition');
  fs.writeFileSync(path.join(f.out, 'subs.srt'), 'fixture-subtitles');
  p.complete('compose', ['demo-voiced.mp4', 'subs.srt']);
  return p;
}

test('修改 pronounce 后从 tts 开始，输出 JSON 使用当前 YAML 的读音', (t) => {
  const f = fixture(t);
  seed(f);
  fs.writeFileSync(f.file, yaml('pronounce: {行: 航}\n'));
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const compiled = JSON.parse(fs.readFileSync(path.join(f.out, 'script.json'), 'utf8'));
  assert.equal(compiled.scenes[0].speech, '查看第三航。');
});

test('同名场景的另一份 YAML 不能复用当前脚本产物', (t) => {
  const f = fixture(t);
  seed(f);
  fs.writeFileSync(path.join(f.root, 'other.yaml'), yaml());
  const result = f.run('other.yaml', 'compose');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /其他脚本/);
});

test('改变读音后不能直接从 compose 跳过 TTS 和录制', (t) => {
  const f = fixture(t);
  seed(f);
  fs.writeFileSync(f.file, yaml('pronounce: {行: 航}\n'));
  const result = f.run('demo.yaml', 'compose');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /tts/);
});

test('原始录制或已合成正片被覆盖时不能续跑', (t) => {
  const f = fixture(t);
  seed(f);
  fs.writeFileSync(path.join(f.out, 'raw.webm'), 'other-video');
  const result = f.run('demo.yaml', 'compose');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /产物已变化.*raw.webm/);
  fs.writeFileSync(path.join(f.out, 'demo-voiced.mp4'), 'other-composition');
  const cards = f.run('demo.yaml', 'cards');
  assert.equal(cards.status, 2, cards.stdout + cards.stderr);
  assert.match(cards.stderr, /产物已变化.*demo-voiced.mp4/);
});

test('只修改片头从 cards 开始时保留匹配正片，并编译当前片头', (t) => {
  const f = fixture(t);
  seed(f);
  fs.writeFileSync(f.file, yaml('intro: {narration: 新片头}\n'));
  const result = f.run('demo.yaml', 'cards');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.out, 'script.json'), 'utf8')).intro.speech, '新片头');
});

test('环境变量切换登录角色后不能使用先前角色的产物', (t) => {
  const f = fixture(t);
  const old = process.env.TRAINING_TEST_USER;
  t.after(() => { if (old === undefined) delete process.env.TRAINING_TEST_USER; else process.env.TRAINING_TEST_USER = old; });
  fs.writeFileSync(f.file, yaml().replace('login: {enabled: false}', 'login: {enabled: true, mode: auto, username: "${TRAINING_TEST_USER}"}'));
  process.env.TRAINING_TEST_USER = 'role-a';
  seed(f);
  process.env.TRAINING_TEST_USER = 'role-b';
  const result = f.run();
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /登录角色/);
});

test('共用 output 的流水线不能并行覆盖产物，释放锁后可以继续', (t) => {
  const f = fixture(t);
  seed(f);
  const release = acquireLock(f.out);
  try {
    const result = f.run();
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /已有流水线/);
  } finally { release(); }
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(f.out, '.produce.lock')), false);
});

test('旧版本缓存与只有演练素材的手册续跑明确拒绝', (t) => {
  const f = fixture(t); seed(f);
  const file = path.join(f.out, 'pipeline.json');
  const state = JSON.parse(fs.readFileSync(file)); state.version = 1;
  fs.writeFileSync(file, JSON.stringify(state));
  const legacy = f.run('demo.yaml', 'compose'); assert.equal(legacy.status, 2); assert.match(legacy.stderr, /旧产物|来源/);
  seed(f);
  const manual = spawnSync(process.execPath, [path.join(f.root, 'produce.js'), 'demo.yaml', '--from', 'manual', '--dry'],
    { cwd: f.root, env: { ...process.env, NODE_PATH: path.join(scripts, 'node_modules') }, encoding: 'utf8' });
  assert.equal(manual.status, 2); assert.match(manual.stderr, /manual\/record\/steps.json/);
});

test('produce 的锁也阻止直接 script、play、manual 入口覆盖共用输出', (t) => {
  const f = fixture(t), release = acquireLock(f.out);
  const original = fs.readFileSync(path.join(f.out, 'script.json'), 'utf8');
  try {
    for (const [name, flags] of [['script.js', []], ['play.js', ['--dry']], ['manual.js', []]]) {
      const r = spawnSync(process.execPath, [path.join(f.root, name), 'demo.yaml', ...flags],
        { cwd: f.root, env: { ...process.env, NODE_PATH: path.join(scripts, 'node_modules') }, encoding: 'utf8' });
      assert.notEqual(r.status, 0); assert.match(r.stderr, /已有流水线/);
    }
    assert.equal(fs.readFileSync(path.join(f.out, 'script.json'), 'utf8'), original);
    const foreign = spawnSync(process.execPath, ['-e', `const {spawnSync}=require('child_process'); const r=spawnSync(process.execPath,[process.argv[1],'demo.yaml'],{cwd:process.cwd(),env:process.env,encoding:'utf8'}); process.stdout.write(r.stderr); process.exit(r.status);`, path.join(f.root, 'script.js')],
      { cwd: f.root, env: { ...process.env, ...release.env, NODE_PATH: path.join(scripts, 'node_modules') }, encoding: 'utf8' });
    assert.equal(foreign.status, 1); assert.match(foreign.stdout, /已有流水线/);
  } finally { release(); }
});

test('两个进程同时遇到死 pid 锁时均明确拒绝，不自动删除或抢占锁', { timeout: 60000 }, async (t) => {
  const f = fixture(t);
  const file = path.join(f.out, '.produce.lock'), value = JSON.stringify({ pid: 2147483647, token: 'fixture-owner' });
  fs.writeFileSync(file, value);
  const start = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(f.root, 'script.js'), 'demo.yaml'], { cwd: f.root, env: { ...process.env, NODE_PATH: path.join(scripts, 'node_modules') } });
    let stderr = ''; child.stderr.on('data', (b) => { stderr += b; }); child.on('close', (code) => resolve({ code, stderr }));
  });
  const results = await Promise.all([start(), start()]);
  for (const r of results) { assert.equal(r.code, 1); assert.match(r.stderr, /已退出/); }
  assert.equal(fs.readFileSync(file, 'utf8'), value);
});

test('真实浏览器演练和 Word 生成留下可用于续跑的阶段记录', (t) => {
  const executablePath = process.env.TEST_BROWSER_PATH;
  if (!executablePath) return t.skip('设置 TEST_BROWSER_PATH 后运行真实浏览器流水线回归');
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'screen.html'), '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><button id="view" onclick="document.querySelector(\'#result\').textContent=\'查询完成\'">查询</button><p id="result"></p></html>');
  fs.writeFileSync(f.file, `title: 演练回归\nurl: ./screen.html\nlogin: {enabled: false}\nadapters: []\nscenes:\n  - id: view\n    name: 查询\n    narration: 点击查询。\n    actions:\n      - {goto: ./screen.html}\n      - {click: {id: view}}\n    expect: {text: 查询完成}\n`);
  fs.writeFileSync(path.join(f.out, 'pipeline.json'), 'damaged checkpoint');
  // 仅选择已安装的浏览器可执行文件，页面操作、截图和手册生成均执行真实代码。
  const preload = path.join(f.root, 'test-browser.cjs');
  fs.writeFileSync(preload, `const pw = require(${JSON.stringify(path.join(scripts, 'node_modules', 'playwright'))});\nconst launch = pw.chromium.launch.bind(pw.chromium);\npw.chromium.launch = (options) => launch({ ...options, executablePath: process.env.TEST_BROWSER_PATH });\n`);
  const result = spawnSync(process.execPath, [path.join(f.root, 'produce.js'), 'demo.yaml', '--dry', '--no-login'], {
    cwd: f.root, encoding: 'utf8', timeout: 25000,
    env: { ...process.env, NODE_PATH: path.join(scripts, 'node_modules'), NODE_OPTIONS: '--require=' + JSON.stringify(preload) },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(f.out, 'pipeline.json'), 'utf8'));
  assert.ok(state.stages.check);
  assert.ok(state.stages.rehearsalManual);
  assert.equal(state.stages.manual, undefined);
  assert.match(result.stderr, /从 script 重新生成/);
  assert.ok(state.stages.check.artifacts.some((a) => a.file.endsWith('.png')));
  assert.ok(fs.statSync(path.join(f.out, '演练回归手册（演练）.docx')).size > 1000);
  const { openPipeline } = require(path.join(f.root, 'pipeline'));
  const script = loadScript(f.file);
  assert.doesNotThrow(() => openPipeline(f.out, script, 'tts'));
});
