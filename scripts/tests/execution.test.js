'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { chromium } = require('playwright');
const scripts = path.resolve(__dirname, '..');

async function until(fn, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('测试未等到：' + label);
}
async function fixture(t, { rehearsal = 'submit', record = 'submit', badExpect = false, baseSave = false, narration = '', account = {} } = {}) {
  if (!process.env.TEST_BROWSER_PATH) { t.skip('设置 TEST_BROWSER_PATH 后验证真实演练与录制'); return null; }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'training-execution-'));
  const root = path.join(temp, 'runtime'), out = path.join(root, 'output');
  fs.cpSync(scripts, root, { recursive: true, filter: (f) => !['node_modules', 'tests', 'output', 'assets'].includes(path.basename(f)) });
  fs.symlinkSync(path.join(scripts, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  fs.mkdirSync(out);
  const state = { writes: 0, rows: new Set(), logins: 0 };
  const backend = http.createServer((req, res) => {
    if (req.url === '/timed') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><button id="start" onclick="window.started=performance.now()">开始</button>
<button id="check" onclick="result.textContent=performance.now()-window.started>=250?'等待已完成':'执行太早'">检查</button><p id="result"></p>`);
      return;
    }
    if (req.url === '/save' && req.method === 'POST') {
      state.writes++; state.rows.add('fixture-row'); res.end('保存成功'); return;
    }
    if (req.url === '/query' && req.method === 'POST') { res.end('查询完成'); return; }
    if (req.url === '/login' && req.method === 'POST') { state.logins++; res.end('已登录'); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (['/login-screen', '/unsafe-login'].includes(req.url)) {
      res.end(`<!doctype html><input id="user"><input id="pass" type="password"><button id="login" onclick="fetch('/login',{method:'POST'}).then(()=>document.body.innerHTML='<p id=done>已登录</p>')">登录</button>`
        + (req.url === '/unsafe-login' ? `<script>fetch('/save',{method:'POST'}).catch(()=>{});</script>` : '')); return;
    }
    res.end(`<!doctype html><meta charset="utf-8"><title>写入回归</title>
<button id="open" onclick="panel.hidden=false;result.textContent=''">新增</button>
<section id="panel" hidden><label>名称<input id="name"></label>
<button id="save" onclick="fetch('/save',{method:'POST'}).then(r=>r.text()).then(t=>{result.textContent=t;panel.hidden=true}).catch(()=>result.textContent='请求被拦截')">保存</button>
<button id="cancel" onclick="panel.hidden=true;result.textContent='取消完成'">取消</button></section><p id="result"></p>`);
  });
  await new Promise((r) => backend.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + backend.address().port;
  const featureFile = path.join(root, 'demo.features.yaml'), file = path.join(root, 'demo.yaml');
  fs.writeFileSync(featureFile, YAML.stringify({ module: '写入回归', script: 'demo.yaml', confirmedAt: 'fixture-confirmed',
    environment: { name: '本机回归测试环境', testData: true }, pages: [{ id: 'list', name: '列表' }],
    features: [{ id: 'list.create', name: '新增', page: 'list', kind: 'write', include: true, rehearsalMode: rehearsal,
      writeMode: record, writeRequests: [{ method: 'POST', url: '/save' }] }] }));
  fs.writeFileSync(file, YAML.stringify({ title: '写入回归', url, login: { enabled: false }, adapters: [], features: 'demo.features.yaml',
    readOnlyRequests: [{ method: 'POST', url: '/query' }, { method: 'POST', url: '/login' }],
    scenes: [{ id: 'create', name: '新增', narration, feature: 'list.create', actions: [
      { click: { id: 'open' } }, { fill: { target: { id: 'name' }, text: '回归样例' } }, ...(baseSave ? [{ click: { id: 'save' } }] : [])],
      expect: { visible: { id: 'panel' } }, ending: {
        submit: { actions: [{ click: { id: 'save' } }], expect: { text: badExpect ? '不会出现的结果' : '保存成功' } },
        cancel: { actions: [{ click: { id: 'cancel' } }], expect: { text: '取消完成' } } } }] }));
  const preload = path.join(root, 'test-browser.cjs');
  fs.writeFileSync(preload, `const pw = require('playwright'); const launch = pw.chromium.launch.bind(pw.chromium);
pw.chromium.launch = (options) => launch({ ...options, executablePath: process.env.TEST_BROWSER_PATH, headless: true });`);
  const children = new Set();
  const env = { ...process.env, ...account, NODE_PATH: path.join(scripts, 'node_modules'), NODE_OPTIONS: '--require=' + JSON.stringify(preload) };
  function start(name, args = [], extraEnv = {}) {
    const child = spawn(process.execPath, [path.join(root, name), ...args], { cwd: root, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child); let log = '';
    child.stdout.on('data', (b) => { log += b; }); child.stderr.on('data', (b) => { log += b; });
    const done = new Promise((r) => { child.on('error', (e) => r({ code: -1, log: log + e.message })); child.on('close', (code) => { children.delete(child); r({ code, log }); }); });
    return { child, done, get log() { return log; } };
  }
  const service = start('app/server.js', [], { PORT: '0' });
  const base = await until(() => /http:\/\/127.0.0.1:\d+/.exec(service.log)?.[0], '确认服务');
  const token = (await (await fetch(base + '/api/session')).json()).token;
  const status = async () => (await (await fetch(base + '/api/status')).json());
  const wait = (stage) => until(async () => { const s = await status(); return s.dataWait?.stage === stage && s.dataWait; }, stage + ' 提交确认');
  const decide = (w, cancel = false) => fetch(base + '/api/data-confirm', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Training-Token': token, Origin: base },
    body: JSON.stringify({ runId: w.runId, stage: w.stage, input: w.input, cancel }) });
  t.after(async () => {
    for (const c of children) c.kill();
    await Promise.all([...children].map((c) => new Promise((r) => c.once('close', r))));
    backend.closeAllConnections(); await new Promise((r) => backend.close(r));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  function emptyManifest() { fs.mkdirSync(path.join(out, 'tts'), { recursive: true }); fs.writeFileSync(path.join(out, 'tts', 'manifest.json'), JSON.stringify({ voice: 'zh-CN-XiaoxiaoNeural', rate: '-6%', scenes: {} })); }
  const { loadScript } = require(path.join(root, 'script'));
  const { executionHash } = require(path.join(root, 'requests'));
  const { openPipeline } = require(path.join(root, 'pipeline'));
  return { root, out, file, featureFile, state, base, token, start, wait, decide, status, emptyManifest, loadScript, executionHash, openPipeline };
}

test('路径型场景 id 在导航与截图前拒绝，不能覆盖工具目录中的其他文件', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { rehearsal: 'cancel', record: 'cancel' }); if (!f) return;
  const source = YAML.parse(fs.readFileSync(f.file, 'utf8'));
  source.scenes[0].id = '../../../../outside'; fs.writeFileSync(f.file, YAML.stringify(source));
  const sentinel = path.join(f.root, 'outside-01.png'); fs.writeFileSync(sentinel, 'USER_FILE');
  const result = await f.start('play.js', ['demo.yaml', '--dry', '--shots']).done;
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(sentinel)).digest('hex'),
    crypto.createHash('sha256').update('USER_FILE').digest('hex'), '目录外的用户文件被截图覆盖');
  assert.notEqual(result.code, 0, result.log); assert.match(result.log, /id.*路径|id.*文件名/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'USER_FILE'); assert.equal(f.state.writes, 0);
  assert.equal(fs.existsSync(path.join(f.out, 'run-report.json')), false);
});

test('演练遵守显式 wait，延迟依赖与正式录制保持一致', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { rehearsal: 'cancel', record: 'cancel' }); if (!f) return;
  const source = YAML.parse(fs.readFileSync(f.file, 'utf8')); delete source.features; source.url += '/timed';
  source.scenes = [{ id: 'timed', actions: [{ click: { id: 'start' } }, { wait: 0.35 }, { click: { id: 'check' } }], expect: { text: '等待已完成' } }];
  fs.writeFileSync(f.file, YAML.stringify(source)); f.emptyManifest();
  const recorded = await f.start('play.js', ['demo.yaml']).done; assert.equal(recorded.code, 0, recorded.log);
  const rehearsed = await f.start('play.js', ['demo.yaml', '--dry']).done; assert.equal(rehearsed.code, 0, rehearsed.log);
  assert.equal(f.state.writes, 0);
});

test('合法 __proto__ 场景 id 的旁白时长不丢失，录制完整保留配音时间', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { rehearsal: 'cancel', record: 'cancel' }); if (!f) return;
  const source = YAML.parse(fs.readFileSync(f.file, 'utf8')); delete source.features;
  source.scenes = [{ id: '__proto__', narration: '保留完整旁白。', hold: 0, actions: [] }];
  fs.writeFileSync(f.file, YAML.stringify(source)); f.emptyManifest();
  const clip = path.join(f.out, 'tts', 'voice.mp3');
  const encoded = spawnSync(require('../deps').ffmpegPath(), ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '3', clip], { encoding: 'utf8' });
  assert.equal(encoded.status, 0, encoded.stderr);
  const script = f.loadScript(f.file);
  fs.writeFileSync(path.join(f.out, 'tts', 'manifest.json'), JSON.stringify({ voice: script.voice, rate: script.rate,
    scenes: Object.fromEntries([['__proto__', { speech: script.scenes[0].speech, dur: 3, file: 'output/tts/voice.mp3' }]]) }));
  const result = await f.start('play.js', ['demo.yaml']).done; assert.equal(result.code, 0, result.log);
  const session = JSON.parse(fs.readFileSync(path.join(f.out, 'session.json'), 'utf8'));
  assert.ok(session.scenes[0].end + 0.002 >= session.scenes[0].audioAt + 3.4, JSON.stringify(session));
});

test('演练和录制两轮提交独立确认，旧确认不能放行新一轮，录制产生真实视频和正式素材', { timeout: 60000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const dry = f.start('play.js', ['demo.yaml', '--dry', '--shots']);
  const first = await f.wait('rehearsal'); assert.equal(f.state.writes, 0);
  assert.equal((await f.decide(first)).status, 200); assert.equal((await f.decide(first)).status, 409);
  const rehearsal = await dry.done; assert.equal(rehearsal.code, 0, rehearsal.log); assert.equal(f.state.writes, 1);
  assert.equal((await f.status()).dataWait, null);
  f.emptyManifest();
  const recording = f.start('play.js', ['demo.yaml', '--shots']);
  const second = await f.wait('record'); assert.notEqual(second.runId, first.runId);
  assert.equal((await f.decide(first)).status, 409); assert.equal(f.state.writes, 1);
  f.state.rows.clear(); // 代表用户核对并复位测试数据；Skill 不自行删除业务数据。
  assert.equal((await f.decide(second)).status, 200);
  const result = await recording.done; assert.equal(result.code, 0, result.log); assert.equal(f.state.writes, 2);
  assert.ok(fs.statSync(path.join(f.out, 'raw.webm')).size > 1000);
  for (const stage of ['rehearsal', 'record']) {
    const material = JSON.parse(fs.readFileSync(path.join(f.out, 'manual', stage, 'steps.json')));
    assert.equal(material.stage, stage); assert.equal(material.input, f.executionHash(f.loadScript(f.file, { stage })));
    assert.ok(material.scenes[0].steps.some((s) => s.name === '保存'));
  }
  const report = JSON.parse(fs.readFileSync(path.join(f.out, 'run-report.json')));
  assert.equal(report.writes[0].status, 200); assert.equal(report.ok, true);
});

for (const [rehearsal, record] of [['submit', 'cancel'], ['cancel', 'submit']]) test('两种收尾分别执行：演练 ' + rehearsal + ' / 正式 ' + record, { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { rehearsal, record }); if (!f) return;
  const dry = f.start('play.js', ['demo.yaml', '--dry', '--shots']);
  if (rehearsal === 'submit') assert.equal((await f.decide(await f.wait('rehearsal'))).status, 200);
  const r1 = await dry.done; assert.equal(r1.code, 0, r1.log);
  const doc1 = f.start('manual.js', ['demo.yaml', '--rehearsal']); const m1 = await doc1.done; assert.equal(m1.code, 0, m1.log);
  f.emptyManifest(); const rec = f.start('play.js', ['demo.yaml', '--shots']);
  if (record === 'submit') assert.equal((await f.decide(await f.wait('record'))).status, 200);
  const r2 = await rec.done; assert.equal(r2.code, 0, r2.log); assert.equal(f.state.writes, 1);
  const doc2 = f.start('manual.js', ['demo.yaml']); const m2 = await doc2.done; assert.equal(m2.code, 0, m2.log);
  assert.ok(fs.statSync(path.join(f.out, '写入回归手册（演练）.docx')).size > 1000);
  assert.ok(fs.statSync(path.join(f.out, '写入回归手册.docx')).size > 1000);
  const mat = JSON.parse(fs.readFileSync(path.join(f.out, 'manual', 'record', 'steps.json')));
  assert.equal(mat.scenes[0].steps.at(-1).name, record === 'submit' ? '保存' : '取消');
  assert.equal(mat.scenes[0].result.expects[0].text, record === 'submit' ? '保存成功' : '取消完成');
  // 演练素材不能替代正式素材。
  fs.copyFileSync(path.join(f.out, 'manual', 'rehearsal', 'steps.json'), path.join(f.out, 'manual', 'record', 'steps.json'));
  const wrong = await f.start('manual.js', ['demo.yaml']).done; assert.equal(wrong.code, 1); assert.match(wrong.log, /不匹配/);
});

test('用户批准 submit 也不能在基础动作中偷跑保存，拦截后报告失败', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { baseSave: true }); if (!f) return;
  const dry = f.start('play.js', ['demo.yaml', '--dry', '--shots']);
  assert.equal((await f.decide(await f.wait('rehearsal'))).status, 200);
  const result = await dry.done; assert.equal(result.code, 2, result.log); assert.equal(f.state.writes, 0);
  const report = JSON.parse(fs.readFileSync(path.join(f.out, 'run-report.json')));
  assert.equal(report.ok, false); assert.match(report.failure.error, /未批准/);
  assert.equal(fs.existsSync(path.join(f.out, 'manual', 'rehearsal', 'steps.json')), false);
});

test('提交后断言失败明确提示核对数据，重跑仍需新确认；取消等待不产生第二次写入', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { badExpect: true }); if (!f) return;
  const dry = f.start('play.js', ['demo.yaml', '--dry', '--shots']); const first = await f.wait('rehearsal');
  assert.equal((await f.decide(first)).status, 200);
  const result = await dry.done; assert.equal(result.code, 2, result.log); assert.equal(f.state.writes, 1);
  const report = JSON.parse(fs.readFileSync(path.join(f.out, 'run-report.json')));
  assert.match(report.recovery, /数据可能已改变/); assert.equal(report.writes[0].outcome, 'response');
  assert.equal(fs.existsSync(path.join(f.out, 'manual', 'rehearsal', 'steps.json')), false);
  const retry = f.start('play.js', ['demo.yaml', '--dry']); const second = await f.wait('rehearsal');
  assert.notEqual(first.runId, second.runId); assert.equal(f.state.writes, 1);
  assert.equal((await f.decide(second, true)).status, 200);
  const stopped = await retry.done; assert.equal(stopped.code, 2); assert.match(stopped.log, /用户取消/);
  assert.equal(f.state.writes, 1); assert.equal((await f.status()).dataWait, null);
});

test('等待期间改变当前脚本会拒绝原确认；缺失或无效 pid 也不能授权', { timeout: 60000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const dry = f.start('play.js', ['demo.yaml', '--dry']); const w = await f.wait('rehearsal');
  const source = fs.readFileSync(f.file, 'utf8'); fs.writeFileSync(f.file, source.replace('回归样例', '已改变的样例'));
  assert.equal((await f.decide(w)).status, 409); assert.equal(f.state.writes, 0);
  assert.equal((await f.decide(w, true)).status, 200); await dry.done;
  for (const pid of [undefined, 0, -1, 2147483647]) {
    fs.writeFileSync(path.join(f.out, 'data-wait.json'), JSON.stringify({ ...w, pid }));
    assert.equal((await f.decide(w)).status, 409); assert.equal((await f.status()).dataWait, null);
  }
});

test('真实登录允许声明的认证 POST，同时阻止登录页提前写业务数据', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { rehearsal: 'cancel', record: 'cancel' }); if (!f) return;
  const doc = YAML.parse(fs.readFileSync(f.file, 'utf8'));
  doc.login = { enabled: true, mode: 'auto', start: 'auto', reuse: false, headless: true,
    url: doc.url + '/login-screen', username: '${TRAINING_FIXTURE_USER}', password: '${TRAINING_FIXTURE_PASSWORD}',
    usernameSelector: '#user', passwordSelector: '#pass', submitSelector: '#login', successSelector: '#done' };
  fs.writeFileSync(f.file, YAML.stringify(doc));
  const account = { TRAINING_FIXTURE_USER: 'fixture-user', TRAINING_FIXTURE_PASSWORD: crypto.randomBytes(16).toString('hex') };
  const valid = await f.start('play.js', ['demo.yaml', '--dry'], account).done;
  assert.equal(valid.code, 0, valid.log); assert.equal(f.state.logins, 1); assert.equal(f.state.writes, 0);
  doc.login.url = doc.url + '/unsafe-login'; fs.writeFileSync(f.file, YAML.stringify(doc));
  const unsafe = await f.start('play.js', ['demo.yaml', '--dry'], account).done;
  assert.equal(unsafe.code, 2, unsafe.log); assert.equal(f.state.writes, 0); assert.match(unsafe.log, /未批准/);
  const report = JSON.parse(fs.readFileSync(path.join(f.out, 'run-report.json')));
  assert.equal(report.ok, false); assert.match(report.failure.error, /未批准/);
});

test('局部演练选组首、组中或组尾都验证完整收尾', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { rehearsal: 'cancel', record: 'cancel' }); if (!f) return;
  const doc = YAML.parse(fs.readFileSync(f.file, 'utf8')), scene = doc.scenes[0];
  doc.scenes = [
    { ...scene, id: 'start', actions: [scene.actions[0]], ending: undefined },
    { ...scene, id: 'middle', continue: true, actions: [scene.actions[1]], ending: undefined },
    { ...scene, id: 'end', continue: true, actions: [] },
  ];
  fs.writeFileSync(f.file, YAML.stringify(doc));
  for (const range of ['1', '2', '3']) {
    const result = await f.start('play.js', ['demo.yaml', '--dry', '--scenes', range]).done;
    assert.equal(result.code, 0, result.log); assert.equal(f.state.writes, 0);
    const report = JSON.parse(fs.readFileSync(path.join(f.out, 'run-report.json')));
    assert.deepEqual(report.scenes.map((s) => s.id), ['start', 'middle', 'end']); assert.equal(report.ok, true);
  }
});

test('桌面清单重新确认后，非 TTY 人工登录按钮继续任务且不替代提交确认', { timeout: 60000 }, async (t) => {
  const account = { TRAINING_FIXTURE_USER: 'fixture-user', TRAINING_FIXTURE_PASSWORD: crypto.randomBytes(16).toString('hex') };
  const f = await fixture(t, { account }); if (!f) return;
  const doc = YAML.parse(fs.readFileSync(f.file, 'utf8'));
  doc.login = { enabled: true, mode: 'auto', start: 'manual', reuse: false, headless: true,
    url: doc.url + '/login-screen', username: '${TRAINING_FIXTURE_USER}', password: '${TRAINING_FIXTURE_PASSWORD}',
    usernameSelector: '#user', passwordSelector: '#pass', submitSelector: '#login', successSelector: '#done' };
  fs.writeFileSync(f.file, YAML.stringify(doc));
  const config = YAML.parse(fs.readFileSync(f.featureFile, 'utf8'));
  config.confirmedAt = null; config.features[0].status = 'changed'; config.features[0].when = '通过审批后';
  fs.writeFileSync(f.featureFile, YAML.stringify(config));
  const browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER_PATH }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(f.base + '/features?f=demo.features.yaml');
  await page.getByText('信息有变化', { exact: true }).waitFor();
  assert.equal(await page.locator('#btnDry').isDisabled(), true);
  await page.locator('#btnConfirm').click();
  await page.waitForFunction(() => document.querySelector('#state').textContent.startsWith('已确认'));
  const pending = f.start('play.js', ['demo.yaml', '--dry']);
  const login = await until(async () => (await f.status()).loginWait, '人工登录闸门');
  assert.equal(f.state.logins, 1); assert.equal(f.state.writes, 0);
  assert.equal(await page.locator('#btnLogin').count(), 1);
  await page.locator('#loginWait').waitFor({ state: 'visible' });
  assert.match(await page.locator('#loginSummary').innerText(), /127.0.0.1.*login-screen/);
  if (process.env.TEST_ARTIFACTS) {
    fs.mkdirSync(process.env.TEST_ARTIFACTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEST_ARTIFACTS, 'manual-login-1440.png'), fullPage: true });
  }
  const stale = await fetch(f.base + '/api/login-confirm', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Training-Token': f.token, Origin: f.base }, body: JSON.stringify({ runId: login.runId + '-old' }) });
  assert.equal(stale.status, 409);
  await page.locator('#btnLogin').click(); await page.locator('#dataWait').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#loginWait').isVisible(), false); assert.equal(f.state.writes, 0);
  assert.equal(await page.locator('#btnData').isDisabled(), true);
  await page.locator('#dataReady').check(); await page.locator('#btnData').click();
  const result = await pending.done; assert.equal(result.code, 0, result.log); assert.equal(f.state.writes, 1);
});

test('桌面确认页要求选择演练方式，并逐轮展示环境、功能和数据确认', { timeout: 60000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const config = YAML.parse(fs.readFileSync(f.featureFile, 'utf8'));
  config.confirmedAt = null; config.features[0].rehearsalMode = '';
  fs.writeFileSync(f.featureFile, YAML.stringify(config));
  const browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(f.base + '/features?f=demo.features.yaml');
  await page.locator('select[data-key="rehearsalMode"]').waitFor();
  assert.equal(await page.locator('#btnConfirm').isDisabled(), true);
  await page.getByLabel('新增演练', { exact: true }).selectOption('submit');
  await page.locator('#btnConfirm').click();
  await page.waitForFunction(() => document.querySelector('#state').textContent.startsWith('已确认'));
  const dry = f.start('play.js', ['demo.yaml', '--dry']);
  await page.locator('#dataWait').waitFor({ state: 'visible' });
  assert.match(await page.locator('#dataTitle').innerText(), /演练提交确认/);
  assert.match(await page.locator('#dataSummary').innerText(), /本机回归测试环境.*127.0.0.1/s);
  assert.match(await page.locator('#dataSummary').innerText(), /写入回归.*demo.yaml/);
  assert.equal(await page.locator('#dataMismatch').isVisible(), false);
  assert.equal(await page.locator('#btnData').isDisabled(), true); assert.equal(f.state.writes, 0);
  if (process.env.TEST_ARTIFACTS) {
    fs.mkdirSync(process.env.TEST_ARTIFACTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEST_ARTIFACTS, 'submit-confirmation-1440.png'), fullPage: true });
  }
  await page.locator('#dataReady').check(); await page.locator('#btnData').click();
  const r1 = await dry.done; assert.equal(r1.code, 0, r1.log); assert.equal(f.state.writes, 1);
  f.emptyManifest(); const rec = f.start('play.js', ['demo.yaml', '--shots']);
  await page.waitForFunction(() => document.querySelector('#dataTitle').textContent === '正式录制提交确认');
  assert.equal(await page.locator('#dataReady').isChecked(), false); assert.equal(await page.locator('#btnData').isDisabled(), true);
  assert.equal(f.state.writes, 1);
  await page.locator('#btnCancelData').click(); const r2 = await rec.done; assert.equal(r2.code, 2, r2.log);
  assert.equal(f.state.writes, 1);
});

test('打开 A 清单时另一个终端运行 B，提交确认明确显示 B 并只授权 B', { timeout: 60000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const feature = YAML.parse(fs.readFileSync(f.featureFile, 'utf8'));
  feature.module = '另一模块'; feature.script = 'other.yaml';
  fs.writeFileSync(path.join(f.root, 'other.features.yaml'), YAML.stringify(feature));
  const script = YAML.parse(fs.readFileSync(f.file, 'utf8'));
  script.title = '另一脚本'; script.features = 'other.features.yaml';
  fs.writeFileSync(path.join(f.root, 'other.yaml'), YAML.stringify(script));
  const browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(f.base + '/features?f=demo.features.yaml');
  await page.locator('select[data-key="rehearsalMode"]').waitFor();
  const pending = f.start('play.js', ['other.yaml', '--dry']);
  const wait = await f.wait('rehearsal');
  await page.waitForFunction(() => document.querySelector('#dataSummary').textContent.includes('other.yaml'));
  assert.match(await page.locator('#module').innerText(), /写入回归/);
  assert.match(await page.locator('#dataSummary').innerText(), /另一脚本.*other.yaml/);
  assert.match(await page.locator('#dataSummary').innerText(), /127.0.0.1.*功能：新增/s);
  assert.equal(await page.locator('#dataMismatch').isVisible(), true);
  assert.match(await page.locator('#dataMismatch').innerText(), /当前清单关联 demo.yaml/);
  assert.equal(await page.locator('#btnData').isDisabled(), true); assert.equal(f.state.writes, 0);
  if (process.env.TEST_ARTIFACTS) await page.screenshot({ path: path.join(process.env.TEST_ARTIFACTS, 'different-script-confirmation-1440.png'), fullPage: true });
  await page.locator('#dataReady').check(); await page.locator('#btnData').click();
  const result = await pending.done; assert.equal(result.code, 0, result.log); assert.equal(f.state.writes, 1);
  const report = JSON.parse(fs.readFileSync(path.join(f.out, 'run-report.json')));
  assert.equal(report.title, '另一脚本'); assert.equal(report.input, wait.input);
  assert.equal(report.confirmation.source, path.join(f.root, 'other.yaml'));
});

test('真实 produce 流水线两轮确认后完成录制、正式手册、合成和片头片尾，manual 续跑只复用正式素材', { timeout: 60000 }, async (t) => {
  if (!process.env.PYTHON) return t.skip('设置已安装 requirements.txt 的 PYTHON 后运行完整流水线');
  const f = await fixture(t, { narration: '点击新增并填写名称。' }); if (!f) return;
  const doc = YAML.parse(fs.readFileSync(f.file, 'utf8'));
  doc.intro = { title: '开始演示', narration: '', duration: 1 };
  doc.outro = { title: '演示完成', narration: '', duration: 1 };
  fs.writeFileSync(f.file, YAML.stringify(doc));
  // 预置本地产生的静音音频缓存；真实 tts.py、录制与合成照常执行，不验证微软在线音色。
  const key = crypto.createHash('sha1').update('zh-CN-XiaoxiaoNeural|-6%|点击新增并填写名称。').digest('hex').slice(0, 16);
  fs.mkdirSync(path.join(f.out, 'tts-cache'));
  const audio = spawnSync(require('../deps').ffmpegPath(), ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '0.5', path.join(f.out, 'tts-cache', key + '.mp3')], { encoding: 'utf8' });
  assert.equal(audio.status, 0, audio.stderr);
  const production = f.start('produce.js', ['demo.yaml', '--no-login']);
  assert.equal((await f.decide(await f.wait('rehearsal'))).status, 200);
  const second = await f.wait('record'); assert.equal(f.state.writes, 1); f.state.rows.clear();
  assert.equal((await f.decide(second)).status, 200);
  const result = await production.done; assert.equal(result.code, 0, result.log); assert.equal(f.state.writes, 2);
  const state = JSON.parse(fs.readFileSync(path.join(f.out, 'pipeline.json')));
  assert.equal(state.version, 2); for (const stage of ['check', 'tts', 'record', 'manual', 'compose']) assert.ok(state.stages[stage]);
  assert.ok(state.stages.record.artifacts.some((a) => a.file === 'manual/record/steps.json'));
  assert.ok(fs.statSync(path.join(f.out, '写入回归.mp4')).size > 1000);
  const firstCue = (text) => { const m = /(\d+):(\d+):(\d+),(\d+) -->/.exec(text); assert.ok(m); return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000; };
  const bodySrt = fs.readFileSync(path.join(f.out, 'subs.srt'), 'utf8'), finalSrt = fs.readFileSync(path.join(f.out, '写入回归.srt'), 'utf8');
  assert.ok(Math.abs(firstCue(finalSrt) - firstCue(bodySrt) - 1) < 2 / 25);
  assert.match(result.log, /元数据与实际解码正常/);
  const p = f.openPipeline(f.out, f.loadScript(f.file), 'manual');
  p.requireStage('record', ['manual/record/steps.json']);
  const manual = await f.start('manual.js', ['demo.yaml']).done; assert.equal(manual.code, 0, manual.log);
  assert.equal(f.state.writes, 2);
});
