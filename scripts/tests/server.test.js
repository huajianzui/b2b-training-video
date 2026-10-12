'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

let temp, root, child, base;
const scripts = path.resolve(__dirname, '..');

before(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'training-server-'));
  root = path.join(temp, 'runtime');
  fs.cpSync(scripts, root, { recursive: true, filter: (file) => !['node_modules', 'output', 'tests', 'assets'].includes(path.basename(file)) });
  fs.mkdirSync(path.join(root, 'output'));
  fs.mkdirSync(path.join(temp, 'runtime-neighbor'));
  fs.writeFileSync(path.join(temp, 'runtime-neighbor', 'private.png'), 'outside-root');
  fs.writeFileSync(path.join(root, 'output', 'auth.json'), '{"cookies":["private"]}');
  fs.writeFileSync(path.join(root, 'output', 'frame.png'), 'public-frame');
  fs.writeFileSync(path.join(root, 'source.png'), 'private-source');
  fs.writeFileSync(path.join(root, 'demo.features.yaml'), `module: 示例\nscript: demo.yaml\nconfirmedAt: ''\nenvironment: {name: 测试, testData: false}\npages:\n  - {id: list, name: 列表}\nfeatures:\n  - {id: view, page: list, name: 查看, kind: read, include: true}\n`);
  fs.writeFileSync(path.join(root, 'demo.yaml'), 'title: 示例\nscenes:\n  - name: 查看\n    feature: view\n    actions: []\n');
  // 模拟覆盖升级留下旧生成器文件；当前服务不能因其存在恢复旧入口。
  fs.writeFileSync(path.join(root, 'app', 'index.html'), '<h1>legacy-generator</h1>');
  fs.writeFileSync(path.join(root, 'build.js'), "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'legacy-executed.txt'), 'executed');");
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(root, 'app', 'server.js')], {
    env: { ...process.env, PORT: String(port), NODE_PATH: path.join(scripts, 'node_modules') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('确认服务启动超时：' + output)), 10000);
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`确认服务退出 ${code}：${output}`)));
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('已启动')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
  });
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
});

function post(headers = {}) {
  return fetch(base + '/api/features?f=demo.features.yaml', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ decisions: { view: { include: true } }, confirm: true }),
  });
}

function rawGet(endpoint, headers) {
  return new Promise((resolve, reject) => {
    http.get(base + endpoint, { headers }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
}

test('外部 Origin 不能读取清单或确认功能，且无通配 CORS', async () => {
  const response = await post({ Origin: 'https://untrusted.example' });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const list = await fetch(base + '/api/features/list', { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(list.status, 403);
  assert.match(fs.readFileSync(path.join(root, 'demo.features.yaml'), 'utf8'), /confirmedAt: ''/);
});

test('DNS 重绑定 Host 和 cross-site 请求被拒绝', async () => {
  assert.equal(await rawGet('/api/status', { Host: 'untrusted.example' }), 403);
  assert.equal(await rawGet('/api/session', { 'Sec-Fetch-Site': 'cross-site' }), 403);
});

test('覆盖升级保留旧首页和 build.js 时也不恢复旧生成入口', async () => {
  for (const endpoint of ['/', '/index.html']) {
    const response = await fetch(base + endpoint, { redirect: 'manual' });
    assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/features');
    assert.doesNotMatch(await response.text(), /legacy-generator/);
  }
  const { token } = await (await fetch(base + '/api/session')).json();
  const response = await fetch(base + '/api/build', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Training-Token': token, Origin: base }, body: '{}' });
  assert.equal(response.status, 404); assert.match((await response.json()).error, /已下线/);
  assert.equal(fs.existsSync(path.join(root, 'legacy-executed.txt')), false);
  assert.equal((await (await fetch(base + '/api/status')).json()).running, false);
});

test('同源确认要求会话令牌，普通表单和猜测令牌不能确认', async () => {
  assert.equal((await post({ Origin: base })).status, 403);
  assert.equal((await post({ Origin: base, 'X-Training-Token': 'guess' })).status, 403);
  const session = await fetch(base + '/api/session');
  assert.equal(session.status, 200);
  const { token } = await session.json();
  assert.equal(typeof token, 'string');
  const foreign = await post({ Origin: 'https://untrusted.example', 'X-Training-Token': token });
  assert.equal(foreign.status, 403);
  const form = await fetch(base + '/api/features?f=demo.features.yaml', {
    method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Training-Token': token }, body: '{}',
  });
  assert.equal(form.status, 415);
  const authorized = await post({ Origin: base, 'X-Training-Token': token });
  assert.equal(authorized.status, 200);
  assert.ok((await authorized.json()).confirmedAt);
});

test('媒体接口只读取 output 下公开产物，拒绝凭据、源码和同名前缀目录', async () => {
  for (const file of ['output/auth.json', 'source.png', '../runtime-neighbor/private.png', '../runtime-neighbor/../runtime-neighbor/private.png']) {
    const response = await fetch(base + '/api/media?f=' + encodeURIComponent(file));
    assert.equal(response.status, 403, file);
  }
  const response = await fetch(base + '/api/media?f=output/frame.png');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'public-frame');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('符号链接不能让媒体接口指向边界外', async (t) => {
  const linkDir = path.join(root, 'output', 'linked');
  try {
    fs.symlinkSync(path.join(temp, 'runtime-neighbor'), linkDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('当前平台不允许创建测试符号链接');
    throw error;
  }
  const response = await fetch(base + '/api/media?f=output/linked/private.png');
  assert.equal(response.status, 403);
});

test('桌面确认页获取令牌并完成本地确认', async (t) => {
  const { chromium } = require('playwright');
  const executablePath = process.env.TEST_BROWSER_PATH;
  if (!executablePath && !fs.existsSync(chromium.executablePath())) {
    return t.skip('先安装 Playwright Chromium，或设置 TEST_BROWSER_PATH 指向本地 Chromium/Chrome');
  }
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}) });
  t.after(() => browser.close());
  for (const viewport of [{ width: 1440, height: 900 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base + '/features?f=demo.features.yaml');
    await page.locator('input[data-id="view"]').waitFor();
    const responsePromise = page.waitForResponse((response) => response.url().includes('/api/features?') && response.request().method() === 'POST');
    await page.locator('#btnConfirm').click();
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    assert.match(response.request().headers()['x-training-token'], /^[0-9a-f]{64}$/);
    await page.waitForFunction(() => document.querySelector('#state').textContent.startsWith('已确认'));
    assert.deepEqual(errors, []);
    if (process.env.TEST_ARTIFACTS) {
      fs.mkdirSync(process.env.TEST_ARTIFACTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.TEST_ARTIFACTS, `features-${viewport.width}.png`), fullPage: true });
    }
    await page.close();
  }
});
