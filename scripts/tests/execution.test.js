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
async function fixture(t, { rehearsal = 'submit', record = 'submit', badExpect = false, baseSave = false, narration = '', account = {}, upload = false } = {}) {
  if (!process.env.TEST_BROWSER_PATH) { t.skip('设置 TEST_BROWSER_PATH 后验证真实演练与录制'); return null; }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'training-execution-'));
  const root = path.join(temp, 'runtime'), out = path.join(root, 'output');
  fs.cpSync(scripts, root, { recursive: true, filter: (f) => !['node_modules', 'tests', 'output'].includes(path.basename(f)) });
  fs.symlinkSync(path.join(scripts, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  fs.mkdirSync(out);
  const state = { writes: 0, rows: new Set(), logins: 0, visits: 0, uploads: [], previews: 0 };
  const backend = http.createServer((req, res) => {
    state.visits++;
    if (req.url === '/timed') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><button id="start" onclick="window.started=performance.now()">开始</button>
<button id="check" onclick="result.textContent=performance.now()-window.started>=250?'等待已完成':'执行太早'">检查</button><p id="result"></p>`);
      return;
    }
    if (req.url === '/save' && req.method === 'POST') {
      if (upload && !state.uploads.length) { res.statusCode = 422; res.end('附件必填'); return; }
      state.writes++; state.rows.add('fixture-row'); res.end('保存成功'); return;
    }
    if (req.url === '/upload' && req.method === 'POST') {
      const parts = []; req.on('data', part => parts.push(part)); req.on('end', () => { state.uploads.push(Buffer.concat(parts)); res.end('上传完成'); }); return;
    }
    if (req.url === '/preview' && req.method === 'POST') { state.previews++; res.end('预检完成'); return; }
    if (req.url === '/query' && req.method === 'POST') { res.end('查询完成'); return; }
    if (req.url === '/login' && req.method === 'POST') { state.logins++; res.end('已登录'); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (['/login-screen', '/unsafe-login'].includes(req.url)) {
      res.end(`<!doctype html><input id="user"><input id="pass" type="password"><button id="login" onclick="fetch('/login',{method:'POST'}).then(()=>document.body.innerHTML='<p id=done>已登录</p>')">登录</button>`
        + (req.url === '/unsafe-login' ? `<script>fetch('/save',{method:'POST'}).catch(()=>{});</script>` : '')); return;
    }
    if (state.onPage) state.onPage();
    res.end(`<!doctype html><meta charset="utf-8"><title>写入回归</title>
<button id="open" onclick="panel.hidden=false;result.textContent=''">新增</button>
<section id="panel" hidden><label>名称<input id="name"></label>
${upload ? `<input id="file" type="file" hidden onchange="const data=new FormData();data.append('file',this.files[0]);fetch('/upload',{method:'POST',body:data}).then(r=>r.text()).then(t=>result.textContent=t).catch(()=>result.textContent='上传被拦截')">
<button id="preview" onclick="fetch('/preview',{method:'POST'}).then(r=>r.text()).then(t=>result.textContent=t)">预检</button>` : ''}
<button id="save" onclick="fetch('/save',{method:'POST'}).then(r=>r.text()).then(t=>{result.textContent=t;panel.hidden=true}).catch(()=>result.textContent='请求被拦截')">保存</button>
<button id="cancel" onclick="panel.hidden=true;result.textContent='取消完成'">取消</button></section><p id="result"></p><span id="hidden-note" hidden>仅内部使用</span>
${upload ? `<script>const attachment=document.querySelector('#file');attachment.remove();setTimeout(()=>panel.appendChild(attachment),1000);</script>` : ''}`);
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

function uploadScenario(f, { approved = true, mark = true } = {}) {
  const source = path.join(f.root, 'prepared.txt'); fs.writeFileSync(source, '培训演示附件样本');
  const file = require('../tools/files').add(f.root, 'fixture', source);
  const features = YAML.parse(fs.readFileSync(f.featureFile, 'utf8'));
  features.features[0].preparation = { description: '上传附件并写入预检记录', rehearsal: approved, record: approved,
    requests: [{ method: 'POST', url: '/upload' }, { method: 'POST', url: '/preview' }] };
  fs.writeFileSync(f.featureFile, YAML.stringify(features));
  const doc = YAML.parse(fs.readFileSync(f.file, 'utf8'));
  doc.scenes[0].actions.push({ upload: { target: { id: 'file' }, files: [path.relative(f.root, file)] }, prepare: mark, label: '附件' },
    { waitFor: { text: '上传完成' }, prepare: mark }, { click: { id: 'preview' }, prepare: mark }, { waitFor: { text: '预检完成' }, prepare: mark });
  fs.writeFileSync(f.file, YAML.stringify(doc)); return { file, source, doc };
}

test('必填附件未获准备许可时执行前拒绝，去掉标记也不能绕过请求拦截', { timeout: 60000 }, async t => {
  const f = await fixture(t, { rehearsal: 'cancel', record: 'cancel', upload: true }); if (!f) return;
  const sample = uploadScenario(f, { approved: false });
  let result = await f.start('play.js', ['demo.yaml', '--dry']).done;
  assert.notEqual(result.code, 0); assert.match(result.log, /尚未批准上传/); assert.equal(f.state.visits, 0);
  for (const action of sample.doc.scenes[0].actions) delete action.prepare;
  fs.writeFileSync(f.file, YAML.stringify(sample.doc));
  result = await f.start('play.js', ['demo.yaml', '--dry']).done;
  assert.notEqual(result.code, 0); assert.match(result.log, /未批准/);
  assert.equal(f.state.uploads.length, 0); assert.equal(f.state.previews, 0); assert.equal(f.state.writes, 0);
});

test('取消收尾仍独立确认上传和预检，文件变化使旧确认失效，另一阶段许可不继承', { timeout: 60000 }, async t => {
  const f = await fixture(t, { rehearsal: 'cancel', record: 'cancel', upload: true }); if (!f) return;
  const sample = uploadScenario(f), original = fs.readFileSync(sample.file);
  const features = YAML.parse(fs.readFileSync(f.featureFile, 'utf8')); features.features[0].preparation.record = false;
  fs.writeFileSync(f.featureFile, YAML.stringify(features));
  assert.throws(() => f.loadScript(f.file, { stage: 'record' }), /尚未批准上传/);
  const pending = f.start('play.js', ['demo.yaml', '--dry', '--shots']), wait = await f.wait('rehearsal');
  assert.match(wait.features[0].preparation, /预检/); assert.equal(f.state.uploads.length, 0);
  fs.writeFileSync(sample.file, '确认前替换'); assert.equal((await f.decide(wait)).status, 409);
  fs.writeFileSync(sample.file, original);
  const browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER_PATH }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); await page.goto(f.base + '/features?f=demo.features.yaml');
  await page.locator('#dataWait').waitFor({ state: 'visible' });
  assert.match(await page.locator('#dataSummary').innerText(), /上传附件并写入预检记录/);
  assert.match(await page.locator('#dataSummary').innerText(), /取消/);
  assert.match(await page.locator('#stat').innerText(), /准备写入：演练 1 \/ 录制 0/);
  if (process.env.TEST_ARTIFACTS) { fs.mkdirSync(process.env.TEST_ARTIFACTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.TEST_ARTIFACTS, 'upload-confirmation-1440.png'), fullPage: true }); }
  await page.locator('#dataReady').check(); await page.locator('#btnData').click();
  const result = await pending.done; assert.equal(result.code, 0, result.log);
  assert.equal(f.state.uploads.length, 1); assert.ok(f.state.uploads[0].includes(original));
  assert.equal(f.state.previews, 1); assert.equal(f.state.writes, 0);
});

test('准备许可不能用于最终保存；通过确认后替换附件也会在发送前停止', { timeout: 60000 }, async t => {
  const f = await fixture(t, { rehearsal: 'cancel', record: 'cancel', upload: true }); if (!f) return;
  const sample = uploadScenario(f), proper = YAML.stringify(sample.doc);
  sample.doc.scenes[0].actions[4] = { click: { id: 'save' }, prepare: true }; fs.writeFileSync(f.file, YAML.stringify(sample.doc));
  const pending = f.start('play.js', ['demo.yaml', '--dry']); assert.equal((await f.decide(await f.wait('rehearsal'))).status, 200);
  const rejected = await pending.done; assert.notEqual(rejected.code, 0); assert.match(rejected.log, /未批准/); assert.equal(f.state.writes, 0);
  fs.writeFileSync(f.file, proper); f.state.uploads.length = 0;
  f.state.onPage = () => fs.writeFileSync(sample.file, '确认以后替换');
  const next = f.start('play.js', ['demo.yaml', '--dry']); assert.equal((await f.decide(await f.wait('rehearsal'))).status, 200);
  const changed = await next.done; assert.notEqual(changed.code, 0); assert.match(changed.log, /内容已变化/);
  assert.equal(f.state.uploads.length, 0); assert.equal(f.state.writes, 0);
});

test('仅批准演练上传时校验、单项登录及 produce 演练手册可完成，正式入口仍拒绝', { timeout: 60000 }, async t => {
  const f = await fixture(t, { rehearsal: 'cancel', record: 'cancel', upload: true }); if (!f) return;
  uploadScenario(f);
  const features = YAML.parse(fs.readFileSync(f.featureFile, 'utf8')); features.features[0].preparation.record = false;
  fs.writeFileSync(f.featureFile, YAML.stringify(features));
  for (const entry of ['script.js', 'login.js']) {
    const result = await f.start(entry, ['demo.yaml', '--rehearsal']).done; assert.equal(result.code, 0, result.log);
  }
  assert.equal(f.state.visits, 0);
  const dry = f.start('produce.js', ['demo.yaml', '--dry']); assert.equal((await f.decide(await f.wait('rehearsal'))).status, 200);
  const result = await dry.done; assert.equal(result.code, 0, result.log); assert.equal(f.state.uploads.length, 1); assert.equal(f.state.writes, 0);
  assert.ok(fs.statSync(path.join(f.out, '写入回归手册（演练）.docx')).size > 1000);
  const visits = f.state.visits, record = await f.start('produce.js', ['demo.yaml']).done;
  assert.notEqual(record.code, 0); assert.match(record.log, /尚未批准上传/); assert.equal(f.state.visits, visits);
});

for (const alias of ['absolute', 'cross-feature']) test('准备接口不能借用最终保存权限：' + alias, { timeout: 60000 }, async t => {
  const f = await fixture(t, { rehearsal: 'cancel', record: 'cancel' }); if (!f) return;
  const doc = YAML.parse(fs.readFileSync(f.file, 'utf8')), features = YAML.parse(fs.readFileSync(f.featureFile, 'utf8'));
  features.features[0].submitRestriction = '最终提交禁止';
  features.features[0].preparation = { description: '所谓准备动作', rehearsal: true, record: true,
    requests: [{ method: 'POST', url: alias === 'absolute' ? doc.url + '/save' : '/{operation}' }] };
  if (alias === 'cross-feature') {
    features.features.push({ ...features.features[0], id: 'list.other', name: '禁止功能', include: false, preparation: undefined });
    features.features[0].writeRequests = [{ method: 'POST', url: '/operations/final' }];
  }
  doc.scenes[0].actions.push({ click: { id: 'save' }, prepare: true });
  fs.writeFileSync(f.featureFile, YAML.stringify(features)); fs.writeFileSync(f.file, YAML.stringify(doc));
  const result = await f.start('play.js', ['demo.yaml', '--dry']).done;
  assert.notEqual(result.code, 0); assert.match(result.log, /准备写入与最终提交路径相交/);
  assert.equal(f.state.visits, 0); assert.equal(f.state.writes, 0); assert.equal((await f.status()).dataWait, null);
});

test('确认服务无需录制进程的凭据环境，仍能确认同一来源且不放行改过的脚本', { timeout: 60000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const doc = YAML.parse(fs.readFileSync(f.file, 'utf8'));
  doc.login = { enabled: true, mode: 'auto', start: 'auto', reuse: false, headless: true,
    url: doc.url + '/login-screen', username: '${TRAINING_FIXTURE_USER}', password: '${TRAINING_FIXTURE_PASSWORD}',
    usernameSelector: '#user', passwordSelector: '#pass', submitSelector: '#login', successSelector: '#done' };
  fs.writeFileSync(f.file, YAML.stringify(doc));
  const account = { TRAINING_FIXTURE_USER: 'fixture-user', TRAINING_FIXTURE_PASSWORD: crypto.randomBytes(16).toString('hex') };
  const pending = f.start('play.js', ['demo.yaml', '--dry'], account), wait = await f.wait('rehearsal');
  const original = fs.readFileSync(f.file, 'utf8');
  doc.scenes[0].actions[1].fill.text = 'changed'; fs.writeFileSync(f.file, YAML.stringify(doc));
  assert.equal((await f.decide(wait)).status, 409); assert.equal(f.state.writes, 0);
  fs.writeFileSync(f.file, original);
  const decision = await f.decide(wait); assert.equal(decision.status, 200, await decision.text());
  const result = await pending.done; assert.equal(result.code, 0, result.log);
  assert.equal(f.state.logins, 1); assert.equal(f.state.writes, 1);
  assert.ok(!JSON.stringify(wait).includes(account.TRAINING_FIXTURE_PASSWORD));
});

test('确认请求明确失败后同一页面可再次点击，成功后禁止重复确认', { timeout: 60000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER_PATH }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pending = f.start('play.js', ['demo.yaml', '--dry']); await f.wait('rehearsal');
  await page.goto(f.base + '/features?f=demo.features.yaml');
  await page.locator('#dataWait').waitFor({ state: 'visible' });
  await page.route('**/api/data-confirm', route => route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"fixture retry"}' }), { times: 1 });
  await page.locator('#dataReady').check(); await page.locator('#btnData').click();
  await page.waitForFunction(() => document.querySelector('#msg').textContent.includes('fixture retry'));
  await until(() => page.locator('#btnData').isEnabled(), '恢复确认按钮');
  assert.equal(f.state.writes, 0);
  await page.locator('#btnData').click();
  const result = await pending.done; assert.equal(result.code, 0, result.log); assert.equal(f.state.writes, 1);
  assert.equal(await page.locator('#btnData').isDisabled(), true);
});

test('完整生产缺少媒体依赖时在登录和任何业务操作之前停止', { timeout: 60000 }, async (t) => {
  if (!process.env.PYTHON) return t.skip('设置 PYTHON 后运行前置依赖回归');
  const f = await fixture(t); if (!f) return;
  const result = await f.start('produce.js', ['demo.yaml'], { FFMPEG: path.join(f.root, 'missing-ffmpeg.exe') }).done;
  assert.notEqual(result.code, 0); assert.match(result.log, /前置检查失败/);
  assert.equal(f.state.visits, 0); assert.equal(f.state.writes, 0); assert.equal((await f.status()).dataWait, null);
});

test('已有有效 YAML、JSON 和 TTS 缓存时，play 帮助及拼错的演练参数仍不启动浏览器或操作页面', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { rehearsal: 'cancel', record: 'cancel' }); if (!f) return;
  f.emptyManifest();
  const json = path.join(f.out, 'script.json'), cached = JSON.stringify({ source: f.file }); fs.writeFileSync(json, cached);
  for (const [args, expected] of [[['--help'], 0], [['--dry', '--help'], 0], [['--dray'], 2]]) {
    const r = await f.start('play.js', args).done; assert.equal(r.code, expected, r.log);
    assert.equal(f.state.visits, 0, r.log); assert.equal(f.state.writes, 0, r.log);
    assert.equal(fs.readFileSync(json, 'utf8'), cached);
    for (const file of ['run-report.json', 'raw.webm', 'session.json', '.produce.lock']) assert.equal(fs.existsSync(path.join(f.out, file)), false, file);
  }
});

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
  assert.ok(session.scenes[0].end + 0.002 >= session.scenes[0].audioAt + 3.4, result.log + '\n' + JSON.stringify(session));
});

test('实际录制文件过短时拒绝交付，不能将场景时间截成零后报告成功', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { rehearsal: 'cancel', record: 'cancel' }); if (!f) return;
  const source = YAML.parse(fs.readFileSync(f.file, 'utf8')); delete source.features;
  source.scenes = [{ id: 'view', narration: '保留完整旁白。', hold: 0, actions: [] }];
  fs.writeFileSync(f.file, YAML.stringify(source)); f.emptyManifest();
  const short = path.join(f.root, 'short.webm'), clip = path.join(f.out, 'tts', 'voice.mp3');
  const ffmpeg = require('../deps').ffmpegPath();
  for (const args of [
    ['-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '3', clip],
    ['-f', 'lavfi', '-i', 'color=s=320x180:r=25', '-t', '1', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', short]
  ]) {
    const encoded = spawnSync(ffmpeg, ['-nostdin', '-y', '-v', 'error', ...args], { encoding: 'utf8' });
    assert.equal(encoded.status, 0, encoded.error?.message || encoded.stderr);
  }
  const script = f.loadScript(f.file);
  fs.writeFileSync(path.join(f.out, 'tts', 'manifest.json'), JSON.stringify({ voice: script.voice, rate: script.rate,
    scenes: { view: { speech: script.scenes[0].speech, dur: 3, file: 'output/tts/voice.mp3' } } }));
  // 保留真实浏览器执行，只将录制器交付的文件替换为实际的一秒 WebM，复现首次全量发现的故障。
  fs.appendFileSync(path.join(f.root, 'test-browser.cjs'), `\nconst fixtureLaunch = pw.chromium.launch;
pw.chromium.launch = async options => {
  const browser = await fixtureLaunch(options), newContext = browser.newContext.bind(browser);
  browser.newContext = async options => {
    const context = await newContext(options), newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage(), video = page.video();
      if (video) video.path = async () => ${JSON.stringify(short)};
      return page;
    };
    return context;
  };
  return browser;
};\n`);
  const result = await f.start('play.js', ['demo.yaml']).done;
  assert.equal(result.code, 2, result.log); assert.match(result.log, /录制.*未覆盖|录制.*过短/);
  assert.doesNotMatch(result.log, /\[完成\]/);
  assert.equal(fs.existsSync(path.join(f.out, 'session.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.out, 'run-report.json'), 'utf8')).ok, false);
  assert.equal(f.state.writes, 0);
});

test('演练和录制两轮提交独立确认，旧确认不能放行新一轮，录制产生真实视频和正式素材', { timeout: 60000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const dry = f.start('play.js', ['demo.yaml', '--dry', '--shots']);
  const first = await f.wait('rehearsal'); assert.equal(f.state.writes, 0);
  assert.equal((await f.decide(first)).status, 200); assert.equal((await f.decide(first)).status, 409);
  await until(async () => !(await f.status()).dataWait, '确认已被执行器消费');
  // 固定复现第二个请求读到旧等待记录、执行器随后清理记录的跨进程交错。
  const confirmation = require(path.join(f.root, 'confirmation'));
  const exists = fs.existsSync, read = fs.readFileSync;
  fs.existsSync = (file) => file === confirmation.WAIT_FILE || exists(file);
  fs.readFileSync = (file, ...args) => file === confirmation.WAIT_FILE ? JSON.stringify(first) : read(file, ...args);
  try {
    assert.throws(() => confirmation.confirmData(first), /已经确认|已失效/, '消费后的同一轮确认必须拒绝，不能再次返回成功');
  } finally { fs.existsSync = exists; fs.readFileSync = read; }
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

test('桌面批量设置可按模块应用并保留单项例外，保存后仍受固定禁止限制', { timeout: 60000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const config = YAML.parse(fs.readFileSync(f.featureFile, 'utf8'));
  config.confirmedAt = null;
  config.features[0].modeOverrides = []; config.features[0].rehearsalMode = '';
  config.features.push({ ...config.features[0], id: 'list.apply', name: '申请', writeMode: 'cancel', rehearsalMode: 'cancel', submitRestriction: '禁止通知' });
  fs.writeFileSync(f.featureFile, YAML.stringify(config));
  const browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER_PATH }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(f.base + '/features?f=demo.features.yaml');
  const group = page.locator('[data-bulk="list"]');
  await group.locator('[data-key="rehearsalMode"]').selectOption('submit');
  await group.locator('[data-key="writeMode"]').selectOption('submit');
  await group.getByRole('button', { name: '应用本组' }).click();
  assert.equal(await page.getByLabel('新增演练', { exact: true }).inputValue(), 'submit');
  assert.equal(await page.getByLabel('申请正式录制', { exact: true }).inputValue(), 'cancel');
  await page.getByLabel('新增正式录制', { exact: true }).selectOption('cancel');
  const global = page.locator('[data-bulk=""]');
  await global.locator('[data-key="writeMode"]').selectOption('submit'); await global.getByRole('button').click();
  assert.equal(await page.getByLabel('新增正式录制', { exact: true }).inputValue(), 'cancel');
  await page.locator('#btnConfirm').click();
  await page.waitForFunction(() => document.querySelector('#state').textContent.startsWith('已确认'));
  const saved = YAML.parse(fs.readFileSync(f.featureFile, 'utf8'));
  assert.equal(saved.features[0].writeMode, 'cancel'); assert.ok(saved.features[0].modeOverrides.includes('writeMode'));
  assert.equal(saved.features[1].writeMode, 'cancel');
  if (process.env.TEST_ARTIFACTS) {
    fs.mkdirSync(process.env.TEST_ARTIFACTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEST_ARTIFACTS, 'bulk-confirmation-1440.png'), fullPage: true });
  }
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
  await page.getByLabel('新增演练', { exact: true }).waitFor();
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
  await page.getByLabel('新增演练', { exact: true }).waitFor();
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

test('真实 produce 两轮确认、手册与纯后期更正不重放业务，超窗和操作变更明确拒绝', { timeout: 120000 }, async (t) => {
  if (!process.env.PYTHON) return t.skip('设置已安装 requirements.txt 的 PYTHON 后运行完整流水线');
  const f = await fixture(t, { narration: '点击新增并填写名称。', upload: true }); if (!f) return;
  uploadScenario(f);
  const doc = YAML.parse(fs.readFileSync(f.file, 'utf8'));
  doc.intro = { title: '开始演示', narration: '', duration: 1 };
  doc.outro = { title: '演示完成', narration: '', duration: 1 };
  doc.scenes[0].actions[0].label = '旧按钮名称';
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
  const hash = name => crypto.createHash('sha256').update(fs.readFileSync(path.join(f.out, name))).digest('hex');
  const raw = hash('raw.webm'), session = hash('session.json'), material = hash('manual/record/steps.json'), visits = f.state.visits;
  doc.pronounce = { 名称: '明称' }; doc.scenes[0].doc = { text: '填写完成后点击保存。' };
  doc.scenes[0].actions[0].label = '新按钮名称';
  fs.writeFileSync(f.file, YAML.stringify(doc));
  const updated = f.loadScript(f.file), spoken = updated.scenes[0].speech;
  const newKey = crypto.createHash('sha1').update(updated.voice + '|' + updated.rate + '|' + spoken).digest('hex').slice(0, 16);
  fs.copyFileSync(path.join(f.out, 'tts-cache', key + '.mp3'), path.join(f.out, 'tts-cache', newKey + '.mp3'));
  assert.equal(f.state.uploads.length, 2); assert.equal(f.state.previews, 2);
  assert.equal(require('../tools/files').cleanup(f.root, 'fixture').removed, 1);
  const post = await f.start('produce.js', ['demo.yaml', '--post']).done;
  assert.equal(post.code, 0, post.log); assert.equal(f.state.visits, visits); assert.equal(f.state.writes, 2);
  assert.equal(hash('raw.webm'), raw); assert.equal(hash('session.json'), session);
  assert.equal(hash('manual/record/steps.json'), material);
  const zip = await require('jszip').loadAsync(fs.readFileSync(path.join(f.out, '写入回归手册.docx')));
  const document = await zip.file('word/document.xml').async('string');
  assert.match(document, /新按钮名称/); assert.doesNotMatch(document, /旧按钮名称/);
  // 实际 Word 曾把步骤留在前页、截图放到后页；验证每组文字—图—图注的分页约束。
  const paragraphs = document.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g);
  const headings = paragraphs.filter(p => /<w:pStyle w:val="Heading[12]"/.test(p));
  assert.ok(headings.length > 0);
  for (const p of headings) assert.match(p, /<w:keepNext\b/, '标题不能孤立留在上一页');
  assert.match(headings[0], /<w:pageBreakBefore\b/, '正文应在段前分页，目录满页时不能多出空白页');
  assert.doesNotMatch(document, /<w:br w:type="page"/, '不能用可挤到新页的空段落插入分页');
  const styles = await zip.file('word/styles.xml').async('string');
  for (const level of [1, 2]) {
    const tocStyle = styles.match(new RegExp('<w:style[^>]*w:styleId="TOC' + level + '"[\\s\\S]*?</w:style>'))?.[0];
    assert.ok(tocStyle, '目录样式必须显式定义，不依赖本机 Word 默认值');
    assert.match(tocStyle, /w:line="320" w:lineRule="exact"/);
  }
  const pictures = paragraphs.flatMap((p, i) => p.includes('<w:drawing>') ? [i] : []);
  assert.ok(pictures.length > 0);
  for (const i of pictures) {
    assert.match(paragraphs[i - 1], /<w:keepNext\b/, '截图前的步骤或结果须与截图同页');
    assert.match(paragraphs[i], /<w:keepNext\b/, '截图须与图注同页');
    assert.match(paragraphs[i + 1], /<w:keepLines\b/, '长图注不能跨页拆分');
    assert.doesNotMatch(paragraphs[i + 1], /<w:keepNext\b/, '不同截图组不得串成无法分页的长链');
  }
  const final = hash('写入回归.mp4');
  const long = spawnSync(require('../deps').ffmpegPath(), ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '20', path.join(f.out, 'tts-cache', newKey + '.mp3')], { encoding: 'utf8' });
  assert.equal(long.status, 0, long.stderr);
  const oversized = await f.start('produce.js', ['demo.yaml', '--post']).done;
  assert.notEqual(oversized.code, 0); assert.match(oversized.log, /时间窗/);
  assert.equal(f.state.visits, visits); assert.equal(hash('写入回归.mp4'), final); assert.equal(hash('raw.webm'), raw);
  doc.scenes[0].actions[1].fill.text = 'changed operation'; fs.writeFileSync(f.file, YAML.stringify(doc));
  const changed = await f.start('produce.js', ['demo.yaml', '--post']).done;
  assert.notEqual(changed.code, 0); assert.match(changed.log, /操作.*改变/); assert.equal(f.state.visits, visits);
});

test('截图目录积压超过阈值时整体让位，不做批量删除', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { rehearsal: 'cancel', record: 'cancel' }); if (!f) return;
  const shots = path.join(f.out, 'manual', 'rehearsal', 'shots');
  fs.mkdirSync(shots, { recursive: true });
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(shots, 'stale-' + i + '.png'), 'old-shot');
  const result = await f.start('play.js', ['demo.yaml', '--dry', '--shots']).done;
  assert.equal(result.code, 0, result.log);
  const moved = fs.readdirSync(path.join(f.out, '_stale')).filter((name) => name.startsWith('shots-rehearsal-'));
  assert.equal(moved.length, 1, '旧截图目录应整体移到 output/_stale，而不是逐个删除');
  assert.equal(fs.readdirSync(path.join(f.out, '_stale', moved[0])).length, 25);
  assert.match(result.log, /整体移至 output\/_stale/);
  assert.equal(fs.existsSync(path.join(shots, 'stale-0.png')), false, '本轮应使用全新目录重新截图');
});

test('定位超时时说明元素是「不存在」还是「存在但不可见」', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, { rehearsal: 'cancel', record: 'cancel' }); if (!f) return;
  const doc = YAML.parse(fs.readFileSync(f.file, 'utf8'));
  doc.scenes[0].expect = { visible: { id: 'hidden-note' } };
  fs.writeFileSync(f.file, YAML.stringify(doc));
  const result = await f.start('play.js', ['demo.yaml', '--dry']).done;
  assert.notEqual(result.code, 0, result.log);
  assert.match(result.log, /找不到可见元素/);
  assert.match(result.log, /能匹配到元素，但当前不可见/);
  assert.match(result.log, /hidden-note/);
});

test('提交路径试跑执行提交分支但不落库', { timeout: 60000 }, async (t) => {
  // 演练走 rehearsalMode=cancel，submit 分支从不执行；试跑要覆盖它，同时保证业务数据不变。
  const f = await fixture(t, { rehearsal: 'cancel', record: 'submit' }); if (!f) return;
  const before = f.state.writes;
  const result = await f.start('play.js', ['demo.yaml', '--dry', '--trial']).done;
  assert.equal(result.code, 0, result.log);
  assert.equal(f.state.writes, before, '试跑不能真正写入业务数据');
  const report = JSON.parse(fs.readFileSync(path.join(f.out, 'trial-report.json'), 'utf8'));
  assert.equal(report.mode, 'trial');
  assert.ok(report.blockedWrites.length, '应记录被拦截的写请求：' + result.log);
  assert.match(result.log, /走到了提交分支/);
  // 走到提交点的场景记为 trial，不算失败；也不能污染正式的 run-report
  assert.equal(report.scenes[0].status, 'trial');
  assert.equal(report.ok, true);
  assert.equal(fs.existsSync(path.join(f.out, 'run-report.json')), false, '试跑不写正式运行报告');
});

test('试跑不发放写许可，未声明的写入仍然拦截', { timeout: 60000 }, async (t) => {
  // 试跑只放行「已声明的写接口被拦」，不能变成绕过请求保护的后门。
  const f = await fixture(t, { rehearsal: 'cancel', record: 'submit' }); if (!f) return;
  const doc = YAML.parse(fs.readFileSync(f.file, 'utf8'));
  doc.scenes[0].actions.push({ click: { id: 'open' } });
  doc.scenes[0].actions.push({ click: { css: 'button#save' } });
  // 把写接口从清单里去掉，改由场景直接触发，模拟未声明写入
  const features = YAML.parse(fs.readFileSync(f.featureFile, 'utf8'));
  features.features[0].writeRequests = [{ method: 'POST', url: '/nowhere' }];
  fs.writeFileSync(f.featureFile, YAML.stringify(features));
  fs.writeFileSync(f.file, YAML.stringify(doc));
  const result = await f.start('play.js', ['demo.yaml', '--dry', '--trial']).done;
  assert.notEqual(result.code, 0, '未声明写入必须仍然失败：' + result.log);
  assert.match(result.log, /写入未批准或接口未声明/);
  assert.equal(f.state.writes, 0);
});
