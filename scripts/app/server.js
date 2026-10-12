#!/usr/bin/env node
/**
 * 操作视频生成器 —— 本地服务
 *
 * 提供一个网页界面：填访问地址、指代码目录、写开场白结束语和重点功能，
 * 点一下开始生成，实时看进度，完成后直接在页面里预览。
 *
 * 启动：
 *   node app/server.js
 * 然后打开 http://127.0.0.1:7788
 *
 * 只监听本机回环地址，不对外暴露。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 7788);
const PROJECT_FILE = path.join(ROOT, 'project.json');
// 每次启动生成，不写入磁盘；外部网页既不能读取它，也不能伪造确认请求。
const SESSION_TOKEN = crypto.randomBytes(32).toString('hex');

// 登录闸门的两个握手文件（login.js 里定义，这里只读/写，不自己造路径）
const { WAIT_FILE, GO_FILE } = require('../login');
const { loadFeatures, saveDecisions } = require('../features');
const { sceneFeatureIds } = require('../script');
const { readDataWait, confirmData } = require('../confirmation');

// ---------------------------------------------------------------- 登录闸门

/**
 * 登录那一步在等用户确认时，会写一个 .login-wait.json。
 * 界面上据此显示【我已登录完成 · 开始录制】按钮 —— 用户点一下，
 * 我们就往 .login-go.json 写个标记，login.js 的轮询会看到它并继续。
 *
 * 为什么要用文件而不是让界面直接控制子进程：录制进程可能是从命令行
 * 起的，也可能是从界面起的，文件是两边都能碰到的唯一交集。
 */
function readLoginWait() {
  try {
    if (!fs.existsSync(WAIT_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(WAIT_FILE, 'utf8'));
    if (!j || !j.runId) return null;
    // 进程没了还留着文件 → 是残留，别让界面显示一个点不动的按钮
    // （ESRCH = 没这个进程；EPERM = 进程还在但我没权限发信号，算它在）
    if (j.pid) {
      try {
        process.kill(j.pid, 0);
      } catch (e) {
        if (e && e.code === 'ESRCH') return null;
      }
    }
    return {
      runId: j.runId,
      url: j.url || '',
      hint: j.hint || '',
      needForce: !!j.needForce,
      elapsed: Math.max(0, Math.round((Date.now() - (j.startedAt || Date.now())) / 1000)),
      timeout: j.timeout || 0,
    };
  } catch (e) {
    return null;
  }
}

function confirmLogin(force, runId) {
  const wait = readLoginWait();
  if (!wait) return { ok: false, error: '当前没有在等待登录确认（可能已经开始了，或登录不在这台机器上跑）。' };
  if (runId !== undefined && runId !== wait.runId) return { ok: false, error: '登录确认已失效，请刷新后查看当前等待。' };
  if (fs.existsSync(GO_FILE)) return { ok: false, error: '登录确认已提交，请等待登录状态检查。' };
  fs.writeFileSync(GO_FILE, JSON.stringify({ runId: wait.runId, force: !!force, at: Date.now() }, null, 2), 'utf8');
  return { ok: true, force: !!force };
}

// ---------------------------------------------------------------- 工具

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function authorize(req, res) {
  const port = req.socket.localPort;
  const host = req.headers.host;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) {
    send(res, 403, JSON.stringify({ ok: false, error: '只允许本机确认服务的 Host' }));
    return false;
  }
  const origin = `http://${host}`;
  const fetchSite = req.headers['sec-fetch-site'];
  if ((req.headers.origin && req.headers.origin !== origin)
    || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
    send(res, 403, JSON.stringify({ ok: false, error: '不允许外部站点访问确认服务' }));
    return false;
  }
  if (!['GET', 'POST'].includes(req.method)) {
    send(res, 405, JSON.stringify({ ok: false, error: '不支持该请求方法' }));
    return false;
  }
  if (req.method === 'POST') {
    if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      send(res, 415, JSON.stringify({ ok: false, error: '写入请求必须使用 application/json' }));
      return false;
    }
    const token = req.headers['x-training-token'];
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)
      || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(SESSION_TOKEN))) {
      send(res, 403, JSON.stringify({ ok: false, error: '缺少有效的确认会话令牌，请刷新确认页' }));
      return false;
    }
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2 * 1024 * 1024) reject(new Error('请求体过大'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- 构建进程与日志广播

let running = null;
const clients = new Set();

function broadcast(line) {
  for (const c of clients) {
    try { c.write('data: ' + JSON.stringify(line) + '\n\n'); } catch (e) { clients.delete(c); }
  }
}

function startJob(script, args) {
  if (running) return { ok: false, error: '已有任务在运行中' };

  const child = spawn(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  running = child;

  broadcast({ kind: 'start', text: '开始执行：' + script + ' ' + args.join(' ') });

  let buf = '';
  const onChunk = (chunk, stream) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      broadcast({ kind: 'log', stream, text: line });
    }
  };
  child.stdout.on('data', (c) => onChunk(c, 'out'));
  child.stderr.on('data', (c) => onChunk(c, 'err'));

  child.on('exit', (code, signal) => {
    // 用 exit 而不是 close：close 要等 stdio 管道全部关闭，
    // 而录制时弹出的浏览器会继承这些管道句柄 —— 它没退，close 就永远不来，
    // 界面上会一直停在"生成中"，哪怕活早就干完了。
    setTimeout(() => {
      if (buf.trim()) broadcast({ kind: 'log', stream: 'out', text: buf.trim() });
      buf = '';
      broadcast({ kind: 'done', code: code === null ? -1 : code, signal: signal || null });
      running = null;
    }, 300);
  });
  child.on('error', (e) => {
    broadcast({ kind: 'log', stream: 'err', text: '进程启动失败：' + e.message });
    broadcast({ kind: 'done', code: -1 });
    running = null;
  });

  return { ok: true };
}

// ---------------------------------------------------------------- 短命令

/**
 * 子进程参数校验。spawn 用数组传参、不经过 shell，所以不用做转义，
 * 只挡控制字符和超长串。
 *
 * 关键：非法参数要「整包拒绝」，绝不可以逐条过滤掉 ——
 * 过滤会让 ["--config", "C:\\Users\\a\\x.json"] 这种参数错位成
 * ["--config"]，脚本就读了默认配置、写到别的文件上去，而且不报错。
 * （这个坑真踩过一次：Windows 路径里的反斜杠被过滤，结果把配置写进了项目根目录。）
 */
function badArg(a) {
  return typeof a !== 'string' || a.length === 0 || a.length > 500 || /[\x00-\x1F\x7F]/.test(a);
}

/**
 * 跑一个用完就退的小脚本，把输出原样收回来。
 * 用异步 spawn 而不是 spawnSync：探测网关可能连着试好几个模型、每个几秒，
 * spawnSync 会把整个服务卡住（连日志推送都得停）。
 */
function runOnce(script, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, script), ...args], {
      cwd: ROOT,
      env: process.env,
    });
    let out = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { out += c.toString('utf8'); });
    const done = (code) => {
      clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, out: out.trim() });
    };
    child.on('exit', done);
    child.on('error', (e) => { out += '\n进程启动失败：' + e.message; done(-1); });
  });
}

// ---------------------------------------------------------------- 视频文件

const MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.png': 'image/png',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.srt': 'text/plain; charset=utf-8' };

function within(dir, file) {
  const rel = path.relative(dir, file);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function serveMedia(res, rel) {
  // 只允许输出目录下的文件，防目录穿越
  if (!rel || rel.includes('\0') || path.isAbsolute(rel)) return send(res, 403, '拒绝访问', 'text/plain; charset=utf-8');
  const output = path.join(ROOT, 'output');
  const full = path.resolve(ROOT, rel);
  const ext = path.extname(full).toLowerCase();
  if (!within(output, full) || !MIME[ext]) return send(res, 403, '拒绝访问', 'text/plain; charset=utf-8');
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return send(res, 404, '文件不存在', 'text/plain; charset=utf-8');
  }

  // realpath 同时检查 output 本身和其内部链接，不能借链接读出凭据或其他目录。
  const realOutput = fs.realpathSync(output);
  const realFull = fs.realpathSync(full);
  if (realOutput !== path.join(fs.realpathSync(ROOT), 'output') || !within(realOutput, realFull)) {
    return send(res, 403, '拒绝访问', 'text/plain; charset=utf-8');
  }
  if (!MIME[path.extname(realFull).toLowerCase()]) return send(res, 403, '拒绝访问', 'text/plain; charset=utf-8');
  const stat = fs.statSync(full);

  res.writeHead(200, {
    'Content-Type': MIME[ext],
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(full).pipe(res);
}

// ---------------------------------------------------------------- 功能清单

/** 只认项目根目录下（不含子目录）指定后缀的文件，防目录穿越 */
function rootFile(rel, suffix) {
  const name = String(rel || '');
  if (!name.endsWith(suffix) || name !== path.basename(name)) return null;
  const full = path.join(ROOT, name);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return fs.realpathSync(full) === path.join(fs.realpathSync(ROOT), name) ? full : null;
}

function listFeatureFiles() {
  return fs.readdirSync(ROOT).filter((n) => rootFile(n, '.features.yaml')).map((n) => {
    try {
      const f = loadFeatures(path.join(ROOT, n));
      return { file: n, module: f.module, script: f.script, confirmedAt: f.confirmedAt,
        total: f.features.length, included: f.features.filter((x) => x.include).length };
    } catch (e) {
      return { file: n, error: e.message };
    }
  });
}

/** 清单 + 每个功能在脚本里对应的场景名（确认页用来标"缺场景"） */
function featureView(full) {
  const f = loadFeatures(full);
  const scriptFull = f.script ? rootFile(f.script, '.yaml') : null;
  let scenes = {};
  let scriptError = '';
  if (scriptFull) {
    try { scenes = sceneFeatureIds(scriptFull); } catch (e) { scriptError = e.message; }
  }
  return Object.assign({}, f, { file: path.basename(full), scriptFound: !!scriptFull, scriptSource: scriptFull, scriptError, scenes });
}

// ---------------------------------------------------------------- 路由

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (!authorize(req, res)) return;
    if (!req.url.startsWith('/')) return send(res, 400, JSON.stringify({ ok: false, error: '请求地址不合法' }));
    const url = new URL(req.url, 'http://' + req.headers.host);
    const p = url.pathname;

    if (p === '/api/session' && req.method === 'GET') {
      return send(res, 200, JSON.stringify({ token: SESSION_TOKEN }));
    }
    if (p === '/' || p === '/index.html') {
      // 覆盖升级可能保留旧文件，入口始终使用当前确认流程。
      res.writeHead(302, { Location: '/features' });
      return res.end();
    }

    if (p === '/features' || p === '/features.html') {
      const html = fs.readFileSync(path.join(__dirname, 'features.html'));
      return send(res, 200, html, 'text/html; charset=utf-8');
    }

    if (p === '/api/features/list') {
      return send(res, 200, JSON.stringify(listFeatureFiles()));
    }

    if (p === '/api/features') {
      const full = rootFile(url.searchParams.get('f'), '.features.yaml');
      if (!full) return send(res, 404, JSON.stringify({ ok: false, error: '找不到这份功能清单' }));
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        saveDecisions(full, body.decisions || {}, !!body.confirm);
      }
      return send(res, 200, JSON.stringify(featureView(full)));
    }

    if (p === '/api/produce' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const script = rootFile(body.script, '.yaml');
      if (!script) return send(res, 400, JSON.stringify({ ok: false, error: '找不到演示脚本：' + (body.script || '') }));
      const args = [path.basename(script)];
      if (body.dry) args.push('--dry');
      if (body.allowUncovered) args.push('--allow-uncovered');
      const r = startJob('produce.js', args);
      return send(res, r.ok ? 200 : 409, JSON.stringify(r));
    }

    if (p === '/api/project' && req.method === 'GET') {
      const raw = fs.existsSync(PROJECT_FILE) ? fs.readFileSync(PROJECT_FILE, 'utf8') : '{}';
      return send(res, 200, raw);
    }

    if (p === '/api/project' && req.method === 'POST') {
      const body = await readBody(req);
      const obj = JSON.parse(body);
      fs.writeFileSync(PROJECT_FILE, JSON.stringify(obj, null, 2), 'utf8');
      return send(res, 200, JSON.stringify({ ok: true }));
    }

    if (p === '/api/ai-config' && req.method === 'GET') {
      // 只把模型接口那段给界面（用来回显网关地址），没有就返回空对象
      const f = path.join(ROOT, 'ai.config.json');
      if (!fs.existsSync(f)) return send(res, 200, '{}');
      try {
        const c = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
        return send(res, 200, JSON.stringify({ baseUrl: c.baseUrl || '', model: c.model || '' }));
      } catch (e) {
        return send(res, 200, '{}');
      }
    }

    if (p === '/api/build' && req.method === 'POST') {
      return send(res, 404, JSON.stringify({ ok: false, error: '旧版生成接口已下线，请用演示脚本 + produce.js 出片' }));
    }

    if (p === '/api/probe' && req.method === 'POST') {
      if (!fs.existsSync(path.join(ROOT, 'ai-probe.js'))) {
        return send(res, 404, JSON.stringify({ ok: false, error: '模型探测不在本工具包里' }));
      }
      // 探测模型网关：列模型 / 试单个模型 / 把选中的写进 ai.config.json
      const body = await readBody(req).catch(() => '{}');
      let args = [];
      try {
        args = JSON.parse(body || '{}').args || [];
      } catch (e) { /* 当作空参数 */ }
      if (!Array.isArray(args) || args.some(badArg)) {
        return send(res, 400, JSON.stringify({ ok: false, code: -1, out: '参数不合法，已拒绝执行' }));
      }
      const r = await runOnce('ai-probe.js', args);
      // 探测失败（连不上 / key 不对）不算服务出错，把原始输出交给界面显示
      return send(res, 200, JSON.stringify({ ok: r.code === 0, code: r.code, out: r.out }));
    }

    if (p === '/api/logout' && req.method === 'POST') {
      // 清掉已保存的登录态（换账号、或怀疑它坏了的时候用）
      const r = spawnSync(process.execPath, [path.join(ROOT, 'login.js'), '--clear'], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      const out = ((r.stdout || '') + (r.stderr || '')).trim();
      return send(res, r.status === 0 ? 200 : 500, JSON.stringify({ ok: r.status === 0, out }));
    }

    if (p === '/api/login-confirm' && req.method === 'POST') {
      // 用户在界面上点了【我已登录完成 · 继续】
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = confirmLogin(!!body.force, body.runId);
      return send(res, r.ok ? 200 : 409, JSON.stringify(r));
    }

    if (p === '/api/status') {
      return send(res, 200, JSON.stringify({ running: !!running, loginWait: readLoginWait(), dataWait: readDataWait() }));
    }

    if (p === '/api/data-confirm' && req.method === 'POST') {
      try {
        confirmData(JSON.parse(await readBody(req)));
        return send(res, 200, JSON.stringify({ ok: true }));
      } catch (e) { return send(res, 409, JSON.stringify({ ok: false, error: e.message })); }
    }

    if (p === '/api/log') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (p === '/api/media') {
      return serveMedia(res, url.searchParams.get('f') || '');
    }

    send(res, 404, '未找到', 'text/plain; charset=utf-8');
  } catch (e) {
    send(res, 500, JSON.stringify({ ok: false, error: e.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('操作视频生成器已启动：http://127.0.0.1:' + server.address().port);
  console.log('（只监听本机，不会对外暴露；按 Ctrl+C 停止）');
});
