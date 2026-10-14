'use strict';

const crypto = require('crypto');
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function normalizeRequests(raw, base, where, { readOnly = false } = {}) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(where + ' 必须是 [{method, url}] 清单');
  return raw.map((r) => {
    if (!r || typeof r.method !== 'string' || typeof r.url !== 'string') throw new Error(where + ' 每项必须明确 method 和 url');
    const method = r.method.toUpperCase();
    const methods = readOnly ? ['GET', 'HEAD', 'POST', 'OPTIONS', 'WS'] : ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    if (!methods.includes(method)) throw new Error(where + ' 不允许方法 ' + method);
    if (r.url.includes('*')) throw new Error(where + ' URL 不允许通配符');
    let url;
    try { url = new URL(r.url, base); } catch { throw new Error(where + ' URL 不合法：' + r.url); }
    if (!(method === 'WS' ? ['ws:', 'wss:'] : ['http:', 'https:']).includes(url.protocol)
      || url.username || url.password || url.hash) throw new Error(where + ' URL 必须是无凭据、无片段的 HTTP(S) 或 WS 地址');
    let segments;
    try { segments = url.pathname.split('/').map(decodeURIComponent); }
    catch { throw new Error(where + ' URL 包含无效的转义字符'); }
    if (segments.some((s) => /[\/\\\u0000]/.test(s))) throw new Error(where + ' 路径段不能包含编码的斜线或空字符');
    if (segments.some((s) => /[{}]/.test(s) && !/^\{[a-zA-Z][\w]*\}$/.test(s))) {
      throw new Error(where + ' 动态路径只能写成单个完整的 {id} 段');
    }
    return { method, url: url.href };
  });
}

function matches(rule, method, value, { ignoreSearch = false } = {}) {
  if (rule.method !== method) return false;
  const expected = new URL(rule.url), actual = new URL(value);
  if (expected.origin !== actual.origin || !ignoreSearch && expected.search !== actual.search) return false;
  const left = expected.pathname.split('/'), right = actual.pathname.split('/');
  try { return left.length === right.length && left.every((part, i) => {
    const pattern = decodeURIComponent(part), segment = decodeURIComponent(right[i]);
    if (/^\{[a-zA-Z][\w]*\}$/.test(pattern)) return !!segment && !/[\/\\]/.test(segment) && !['.', '..'].includes(segment);
    return pattern === segment;
  }); } catch { return false; }
}

function assertDisjoint(readOnly, writes, { message } = {}) {
  const variable = (s) => /^\{[a-zA-Z][\w]*\}$/.test(s);
  for (const r of readOnly) for (const w of writes) {
    if (r.method !== w.method && !(r.method === 'HEAD' && w.method === 'GET')) continue;
    const a = new URL(r.url), b = new URL(w.url);
    if (a.origin !== b.origin) continue;
    const left = a.pathname.split('/').map(decodeURIComponent), right = b.pathname.split('/').map(decodeURIComponent);
    if (left.length === right.length && left.every((s, i) => s === right[i] || variable(s) || variable(right[i]))) {
      throw new Error(message ? message + '：' + r.method + ' ' + a.origin + a.pathname
        : 'readOnlyRequests 与 writeRequests 路径相交：' + r.method + ' ' + a.origin + a.pathname
          + '；共用查询和修改的接口不能整体标为只读，请使用可区分的接口地址。');
    }
  }
}

const executionHash = (script) => crypto.createHash('sha256').update(JSON.stringify({
  source: script.source, url: script.url, executionStage: script.executionStage,
  // 确认服务无需持有录制进程的凭据；校验引用与配置，不能比较不同进程展开后的值。
  login: require('./login').normLogin(script, { resolveCredentials: false }),
  scenes: script.scenes, readOnlyRequests: script.readOnlyRequests, safety: script.safety,
})).digest('hex');

async function installRequestGuard(context, { readOnlyRequests = [], writeRequests = [], approvedWriteRequests = [], pageUrl } = {}) {
  assertDisjoint(readOnlyRequests, writeRequests);
  // fulfill 的页面没有浏览器连接的地址空间；Chrome 的 LNA 会误挡其同源内网连接。
  // 只为脚本明确指定的页面来源授权，本模块的接口策略仍逐条检查。
  if (pageUrl && /^https?:/.test(pageUrl)) await context.grantPermissions(['local-network-access'], { origin: new URL(pageUrl).origin });
  const violations = [], writes = [];
  let grant = [], closing = false;
  const describe = (method, value) => {
    const u = new URL(value), keys = [...new Set(u.searchParams.keys())].map(encodeURIComponent);
    return method + ' ' + u.origin + u.pathname + (keys.length ? '?' + keys.map(k => k + '=<已隐藏>').join('&') : '');
  };
  function blocked(method, url) {
    const message = '写入未批准或接口未声明：' + describe(method, url)
      + '；请核对 readOnlyRequests / writeRequests 和本阶段的提交确认';
    violations.push(message);
  }
  function allowed(method, url, approved) {
    if (!['http:', 'https:'].includes(new URL(url).protocol)) return false;
    if (/%(?:2f|5c|00)/i.test(new URL(url).pathname)) return false;
    // HEAD 可能复用服务端 GET 处理器；已知 GET 写路径也不能以 HEAD 绕过。
    const declaredWrite = writeRequests.some((r) => matches(r, method === 'HEAD' ? 'GET' : method, url, { ignoreSearch: true }));
    return approved.some((r) => matches(r, method, url))
      || (!declaredWrite && (SAFE_METHODS.has(method) || readOnlyRequests.some((r) => matches(r, method, url))));
  }
  await context.route('**/*', async (route) => {
    const request = route.request(), method = request.method(), url = request.url();
    if (new URL(url).protocol === 'file:' && method === 'GET') { await route.continue(); return; }
    const approved = grant.slice(); // 已发起的请求不能借用下一场景的许可。
    if (!allowed(method, url, approved)) {
      blocked(method, url);
      await route.abort('blockedbyclient');
      return;
    }
    let target = url, verb = method, body = request.postDataBuffer();
    let headers = request.headers();
    try {
      for (let redirects = 0; ; redirects++) {
        if (!allowed(verb, target, approved)) { blocked(verb, target); await route.abort('blockedbyclient'); return; }
        const entry = approved.some((r) => matches(r, verb, target)) ? { request: describe(verb, target), outcome: 'unknown' } : null;
        if (entry) writes.push(entry);
        // route.continue 只拦截重定向链的首跳，故在发送每一跳之前检查策略。
        const response = redirects === 0 ? await route.fetch({ maxRedirects: 0 })
          : await context.request.fetch(target, { method: verb, headers, ...(body ? { data: body } : {}), maxRedirects: 0 });
        if (entry) { entry.outcome = 'response'; entry.status = response.status(); }
        const location = response.headers().location;
        if (![301, 302, 303, 307, 308].includes(response.status()) || !location) {
          await route.fulfill({ response }); await response.dispose(); return;
        }
        const next = new URL(location, target).href;
        // API 请求可以逐跳返回最终响应；页面跳转需保持地址和相对资源语义，不能伪造成功。
        if (request.isNavigationRequest()) {
          violations.push('页面发生 HTTP 重定向：' + describe(verb, target) + '；请将脚本或 login.url 配置为最终页面地址，再演练。');
          await response.dispose(); await route.abort('blockedbyclient'); return;
        }
        if (redirects >= 19) throw new Error('HTTP 重定向超过 Playwright 默认的 20 跳限制');
        if (response.status() === 303 && verb !== 'HEAD' || [301, 302].includes(response.status()) && verb === 'POST') {
          verb = 'GET'; body = null;
          delete headers['content-type']; delete headers['content-length'];
        }
        if (new URL(next).origin !== new URL(target).origin) { delete headers.authorization; delete headers['proxy-authorization']; }
        delete headers.cookie; delete headers.host;
        await response.dispose(); target = next;
      }
    } catch (error) {
      if (writes.some((w) => w.outcome === 'unknown')) violations.push('提交响应未知：请核对测试数据后重试。');
      else if (!closing) violations.push('受保护请求未完成：' + describe(verb, target) + '；请核对网络和重定向配置后重试。');
      await route.abort('failed').catch(() => {});
    }
  });
  // WebSocket 不经过 HTTP route；只转发已核对为只读的连接，业务写入通道不开放。
  await context.routeWebSocket('**/*', (socket) => {
    if (readOnlyRequests.some((r) => matches(r, 'WS', socket.url()))) socket.connectToServer();
    else { blocked('WS', socket.url()); socket.close({ code: 1008, reason: '未经批准的业务通道' }); }
  });
  return {
    violations, writes,
    grant(requests = []) {
      const same = (a, b) => a.method === b.method && a.url === b.url;
      if (!Array.isArray(requests) || requests.some((r) => !writeRequests.some((w) => same(w, r))
        || !approvedWriteRequests.some((w) => same(w, r)))) {
        throw new Error('本阶段未批准该写接口，不能开放提交许可。');
      }
      grant = requests.slice();
    },
    close() { closing = true; grant = []; },
    assert() { if (violations.length) { const error = new Error(violations[0]); error.code = 'REQUEST_POLICY'; throw error; } },
  };
}

module.exports = { normalizeRequests, assertDisjoint, matches, installRequestGuard, executionHash };
