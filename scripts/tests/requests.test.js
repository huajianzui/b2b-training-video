'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { normalizeRequests, assertDisjoint, installRequestGuard } = require('../requests');

test('只读与写规则重合或动态路径相交时拒绝歧义配置', () => {
  const ro = normalizeRequests([{ method: 'POST', url: '/items/search' }], 'https://example.invalid', 'ro', { readOnly: true });
  for (const url of ['/items/search', '/items/{id}']) assert.throws(() => assertDisjoint(ro,
    normalizeRequests([{ method: 'POST', url }], 'https://example.invalid', 'write')), /相交/);
  assert.doesNotThrow(() => assertDisjoint(ro, normalizeRequests([{ method: 'POST', url: '/items/create' }], 'https://example.invalid', 'write')));
  assert.throws(() => assertDisjoint(normalizeRequests([{ method: 'HEAD', url: '/save' }], 'https://example.invalid', 'ro', { readOnly: true }),
    normalizeRequests([{ method: 'GET', url: '/save' }], 'https://example.invalid', 'write')), /相交/);
});

test('连接变量只允许完整只读 WS 查询值，不能改变接口地址或写权限', () => {
  const normalize = (method, url) => normalizeRequests([{method, url}], 'https://example.invalid', 'ro', {readOnly:true});
  for (const [method, url] of [['POST','/query?token=${ENV}'], ['WS','ws://example.invalid/${ENV}'],
    ['WS','ws://example.invalid/?${ENV}=1'], ['WS','ws://example.invalid/?token=prefix${ENV}']]) {
    assert.throws(() => normalize(method, url));
  }
  assert.equal(new URL(normalize('WS','ws://example.invalid/?token=${ENV}')[0].url).searchParams.get('token'), '${ENV}');
});

test('缺少 WS 查询变量在访问页面前明确拒绝，不泄露值或改写规则', async () => {
  const rules = normalizeRequests([{method:'WS',url:'ws://example.invalid/?token=${B2B_MISSING_WS}'}], 'http://example.invalid', 'ro', {readOnly:true});
  const before = JSON.stringify(rules);
  const saved = process.env.B2B_MISSING_WS; delete process.env.B2B_MISSING_WS;
  try { await assert.rejects(installRequestGuard({}, {readOnlyRequests:rules}), /缺少环境变量：B2B_MISSING_WS/); }
  finally { if (saved !== undefined) process.env.B2B_MISSING_WS = saved; }
  assert.equal(JSON.stringify(rules), before);
});

async function fixture(t, extra = () => false) {
  if (!process.env.TEST_BROWSER_PATH) { t.skip('设置 TEST_BROWSER_PATH 后验证真实浏览器请求'); return null; }
  const counts = { save: 0, read: 0, login: 0, socket: 0 }, sockets = new Set();
  const server = http.createServer((req, res) => {
    if (extra(req, res, counts)) return;
    if (decodeURIComponent(new URL(req.url, 'http://fixture.invalid').pathname) === '/save') counts.save++;
    if (req.url === '/query') counts.read++;
    if (req.url === '/login') { counts.login++; res.setHeader('Set-Cookie', 'session=fixture; Path=/'); }
    res.setHeader('Content-Type', req.url === '/' ? 'text/html' : 'application/json');
    res.end(req.url === '/' ? '<!doctype html><title>接口回归</title>' : '{"ok":true}');
  });
  server.on('upgrade', (req, socket) => {
    counts.socket++;
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.on('data', () => {}); socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER_PATH });
  t.after(async () => { await browser.close(); for (const socket of sockets) socket.destroy(); server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const ro = normalizeRequests(['/query', '/login', '/redirect'].map((url) => ({ method: 'POST', url })), url, 'ro', { readOnly: true });
  ro.push({ method: 'WS', url: url.replace('http:', 'ws:') + '/read-socket' });
  const writes = normalizeRequests([{ method: 'POST', url: '/save' }, { method: 'GET', url: '/save' }], url, 'writes');
  const guard = await installRequestGuard(context, { readOnlyRequests: ro, writeRequests: writes, approvedWriteRequests: writes, pageUrl: url });
  const page = await context.newPage(), errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('websocket', (ws) => ws.on('socketerror', (e) => errors.push(e)));
  await page.goto(url);
  const send = (route, method = 'POST') => page.evaluate(async ({ route, method }) => {
    try { return await (await fetch(route, { method })).json(); } catch { return { blocked: true }; }
  }, { route, method });
  return { counts, guard, page, send, writes, context, errors };
}

test('未批准写请求后台计数为零，批准期间可保存，普通登录和 POST 查询可用', { timeout: 60000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  assert.deepEqual(await f.send('/query'), { ok: true });
  assert.deepEqual(await f.send('/login'), { ok: true });
  assert.ok((await f.context.cookies()).some((c) => c.name === 'session'));
  assert.deepEqual(await f.send('/save'), { blocked: true });
  assert.equal(f.counts.save, 0); assert.throws(() => f.guard.assert(), /未批准/);
  f.guard.grant(f.writes);
  assert.deepEqual(await f.send('/save'), { ok: true }); assert.equal(f.counts.save, 1);
  assert.equal(f.guard.writes[0].outcome, 'response'); assert.equal(f.guard.writes[0].status, 200);
  f.guard.grant([]);
  assert.deepEqual(await f.send('/save', 'GET'), { blocked: true }); assert.equal(f.counts.save, 1);
  assert.deepEqual(await f.send('/%73ave', 'GET'), { blocked: true });
  assert.deepEqual(await f.send('/save?other=1', 'GET'), { blocked: true }); assert.equal(f.counts.save, 1);
  assert.equal(f.counts.read, 1); assert.equal(f.counts.login, 1);
});

test('只读 POST 的 307 重定向不能进入未批准的写接口', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, (req, res) => {
    if (req.url !== '/redirect') return false;
    res.writeHead(307, { Location: '/save' }); res.end(); return true;
  }); if (!f) return;
  assert.deepEqual(await f.send('/redirect'), { blocked: true }); assert.equal(f.counts.save, 0);
  assert.throws(() => f.guard.assert(), /未批准/);
});

test('声明为 GET 写接口的 HEAD 请求不能借用默认只读方法', { timeout: 60000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  assert.deepEqual(await f.send('/save', 'HEAD'), { blocked: true });
  assert.equal(f.counts.save, 0); assert.throws(() => f.guard.assert(), /未批准/);
});

test('运行时不能授权未声明或本阶段未获准的写接口', { timeout: 60000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const outside = normalizeRequests([{ method: 'POST', url: '/outside' }], f.page.url(), 'grant');
  assert.throws(() => f.guard.grant(outside), /本阶段.*批准/);
  const context = await f.context.browser().newContext({ serviceWorkers: 'block' });
  const guard = await installRequestGuard(context, { writeRequests: f.writes, approvedWriteRequests: [], pageUrl: f.page.url() });
  assert.throws(() => guard.grant(f.writes), /本阶段.*批准/);
  await context.close();
  assert.equal(f.counts.save, 0);
});

test('跨来源重定向不能借用原来源的只读接口许可', { timeout: 60000 }, async (t) => {
  let reached = 0;
  const other = http.createServer((_, res) => { reached++; res.end('{}'); });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => other.close(r)));
  const f = await fixture(t, (req, res) => {
    if (req.url !== '/redirect') return false;
    res.writeHead(307, { Location: 'http://127.0.0.1:' + other.address().port + '/query' }); res.end(); return true;
  }); if (!f) return;
  assert.deepEqual(await f.send('/redirect'), { blocked: true }); assert.equal(reached, 0);
  assert.throws(() => f.guard.assert(), /未批准/);
});

test('提交到达后台但连接断开时保留响应未知，禁止假成功和自动重试', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, (req, res, counts) => {
    if (req.url !== '/save') return false;
    counts.save++; res.socket.destroy(); return true;
  }); if (!f) return;
  f.guard.grant(f.writes);
  assert.deepEqual(await f.send('/save'), { blocked: true }); assert.equal(f.counts.save, 1);
  assert.equal(f.guard.writes[0].outcome, 'unknown'); assert.throws(() => f.guard.assert(), /提交响应未知/);
});

test('允许的只读 API 重定向逐跳执行，导航重定向明确要求最终地址', { timeout: 60000 }, async (t) => {
  const f = await fixture(t, (req, res) => {
    if (!['/redirect', '/navigation'].includes(req.url)) return false;
    res.writeHead(307, { Location: '/query' }); res.end(); return true;
  }); if (!f) return;
  assert.deepEqual(await f.send('/redirect'), { ok: true }); assert.equal(f.counts.read, 1); f.guard.assert();
  await assert.rejects(f.page.goto(new URL('/navigation', f.page.url()).href));
  assert.throws(() => f.guard.assert(), /重定向.*最终页面地址/);
});

test('未声明的 WebSocket 不连接服务器，只读连接仍可建立', { timeout: 60000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const open = (route) => f.page.evaluate((route) => new Promise((r) => {
    const socket = new WebSocket(location.origin.replace('http:', 'ws:') + route);
    socket.onopen = () => { socket.close(); r(true); }; socket.onclose = socket.onerror = () => r(false);
  }), route);
  assert.equal(await open('/write-socket'), false); assert.equal(f.counts.socket, 0);
  assert.equal(await open('/read-socket?token=secret-value&v=1'), false);
  assert.equal(f.counts.socket, 0);
  assert.ok(f.guard.violations.some(message => message.includes('token') && message.includes('v')));
  assert.ok(f.guard.violations.every(message => !message.includes('secret-value')));
  assert.equal(await open('/read-socket'), true, JSON.stringify({ counts: f.counts, violations: f.guard.violations, errors: f.errors })); assert.equal(f.counts.socket, 1);
  assert.throws(() => f.guard.assert(), /WS/);
});

test('实际 WS 按进程变量精确匹配，特殊字符不扩大查询范围且不会落入报告', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const saved = process.env.B2B_TEST_WS; process.env.B2B_TEST_WS = 'value &other=?/中文';
  t.after(() => { if (saved === undefined) delete process.env.B2B_TEST_WS; else process.env.B2B_TEST_WS = saved; });
  const rules = normalizeRequests([{method:'WS',url:new URL('/env-socket?token=${B2B_TEST_WS}', f.page.url()).href.replace('http:','ws:')}], f.page.url(), 'ro', {readOnly:true});
  const before = JSON.stringify(rules);
  const context = await f.context.browser().newContext({serviceWorkers:'block'});
  const guard = await installRequestGuard(context, {readOnlyRequests:rules, pageUrl:f.page.url()});
  const page = await context.newPage(); await page.goto(f.page.url());
  const open = route => page.evaluate(route => new Promise(resolve => {
    const ws = new WebSocket(location.origin.replace('http:','ws:') + route);
    ws.onopen = () => { ws.close(); resolve(true); }; ws.onclose = ws.onerror = () => resolve(false);
  }), route);
  assert.equal(await open('/env-socket?token=wrong'), false); assert.equal(f.counts.socket,0);
  assert.equal(await open('/env-socket?token=' + encodeURIComponent(process.env.B2B_TEST_WS) + '&extra=1'), false); assert.equal(f.counts.socket,0);
  assert.equal(await open('/env-socket?token=' + encodeURIComponent(process.env.B2B_TEST_WS)), true); assert.equal(f.counts.socket,1);
  assert.equal(JSON.stringify(rules),before);
  assert.ok(!JSON.stringify({rules,violations:guard.violations}).includes('value'));
  assert.equal(f.counts.save,0); await context.close();
});
