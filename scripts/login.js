#!/usr/bin/env node
/**
 * 预登录 —— 在录制开始之前，把登录态准备好
 *
 * 为什么要单独做这一步：
 *   培训视频里不能出现"输账号密码"的画面 —— 既难看，又等于把口令印在视频里发出去。
 *   所以登录必须发生在录制之前：先登进去，把 cookie / localStorage 存成一份登录态，
 *   录制时带着这份状态开机，视频第一帧就是"已经登录好的业务页面"。
 *   附带的好处是登一次能用很久，后面重录不用再登。
 *
 * 三种情况自动分流：
 *   系统不需要登录        → 什么也不做
 *   有还没过期的登录态    → 直接复用（秒级，不弹窗）
 *   需要登录              → 弹浏览器：人工登（login.mode=manual）或脚本自动填（login.mode=auto）
 *
 * 然后按 login.start 决定什么时候开录：
 *   manual（默认）→ 弹窗等你登录，登录完你再点一下【开始录制】（终端回车 / 网页按钮都行）
 *   auto          → 判定登录成功就直接开录
 *
 * 用法（命令行）：
 *   node login.js [脚本.yaml]              默认按 script.yaml 的 login 配置执行一次
 *   node login.js [脚本.yaml] --check      只验证现有登录态，不登录
 *   node login.js [脚本.yaml] --force      忽略已有登录态，重新登录
 *   node login.js [脚本.yaml] --clear      删除这份脚本指定的登录态
 *   node login.js --project x.json         显式兼容旧 JSON，提示迁移到 YAML
 *
 * 用法（模块）：
 *   const { ensureLoggedIn } = require('./login');
 *   const { loadScript, asLoginProject } = require('./script');
 *   const auth = await ensureLoggedIn(asLoginProject(loadScript('role.yaml')));
 *   // auth.enabled === false           → 不需要登录
 *   // auth.storageState = '<文件路径>' → 把这个路径传给 browser.newContext({ storageState })
 */

const CLI = require.main === module ? require('./cli').readCli({
  usage: '用法：node login.js [脚本.yaml] [--check | --force | --clear]\n'
    + '  --mode <manual|auto|none|wait|confirm>  临时覆盖登录方式\n'
    + '  --start <manual|auto>                人工确认或自动判定登录成功\n'
    + '  --project <旧配置.json>              显式兼容入口，请迁移到 YAML',
  options: { check: { type: 'boolean' }, force: { type: 'boolean' }, clear: { type: 'boolean' },
    project: { type: 'string' }, mode: { type: 'string' }, start: { type: 'string' } },
  validate: ({ values, positionals }) => {
    if (values.project && positionals.length) throw new Error('YAML 和 --project 不能同时指定。');
    if (['check', 'force', 'clear'].filter(name => values[name]).length > 1) throw new Error('--check、--force、--clear 不能同时使用。');
    if (values.mode !== undefined && !['manual', 'auto', 'none', 'wait', 'confirm'].includes(values.mode)) throw new Error('--mode 值不合法。');
    if (values.start !== undefined && !['manual', 'auto'].includes(values.start)) throw new Error('--start 值不合法。');
  }
}) : null;

const path = require('path');
const fs = require('fs');
const { requireFrom } = require('./deps');

const HERE = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 人工闸门用的两个握手文件。
// 日志和界面共用一套措辞，免得两处对不上。
const WAIT_FILE = path.join(HERE, 'output', '.login-wait.json');   // 我：正在等你登录
const GO_FILE = path.join(HERE, 'output', '.login-go.json');       // 你：我登好了，开始吧

// ============================================================
// 配置解析
// ============================================================

/**
 * 把 ${XXX} 换成环境变量。
 * 口令不应明文写进 YAML 或旧 JSON —— 配置可能流转或留在工程里，
 * 写成 ${DEMO_PWD} 由环境变量注入，配置文件就可以放心流转。
 */
function expandEnv(v) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) =>
    process.env[k] === undefined ? '' : process.env[k]
  );
}

function absUrl(u, base) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u) || /^file:\/\//i.test(u)) return u;
  const abs = path.resolve(base || HERE, u);
  return 'file:///' + abs.replace(/\\/g, '/');
}

/** 显式旧 JSON 兼容入口；新调用使用 readLoginScript。 */
function readProject(file) {
  const p = path.resolve(HERE, file || 'project.json');
  if (!fs.existsSync(p)) throw new Error('找不到配置文件：' + p);
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
}

function readLoginScript(file = 'script.yaml') {
  const { loadScript, asLoginProject } = require('./script');
  return asLoginProject(loadScript(path.resolve(HERE, file)));
}

/**
 * 把 project.login 归一化成内部配置。
 *
 * 这里是两个**互相独立**的问题，别把它们揉成一个 mode：
 *
 *   1) 登录怎么完成   → login.mode
 *        manual  弹出浏览器，人工登录（默认；验证码 / 扫码 / 短信码都靠它）
 *        auto    脚本自动填 username / password
 *        none    这个系统不需要登录
 *
 *   2) 什么时候开始录 → login.start
 *        manual  登录完之后由人点【开始录制】才开录（默认，最可控）
 *        auto    一旦判定登录成功就自动开录
 *
 * 二者可以任意组合，比如「自动填账号密码 + 我点开始录制」也成立 ——
 * 自动填完可能还有验证码要过，这时候当然得等人。
 *
 * 兼容旧写法：mode="wait" 等价于 mode="manual" + start="manual"。
 */
function normLogin(project, { resolveCredentials = true } = {}) {
  const r = (project && project.login) || {};
  const raw = String(r.mode || '').toLowerCase();

  let enabled;
  if (r.enabled === false) enabled = false;
  else if (r.enabled === true) enabled = true;
  else enabled = raw !== '' && raw !== 'none';

  // 旧写法 mode="wait" / "confirm"：就是"人工登录 + 人工触发"
  const legacyWait = raw === 'wait' || raw === 'confirm';

  const mode = raw === 'auto' ? 'auto' : 'manual';

  const startRaw = String(r.start || r.trigger || '').toLowerCase();
  let start;
  if (startRaw === 'auto' || startRaw === 'manual') start = startRaw;
  else start = legacyWait ? 'manual' : 'manual';   // 默认人工触发

  const storageRel = r.storage || 'output/auth.json';

  return {
    enabled,
    mode,
    /** 'manual' = 登录完成后要人点一下才开始录；'auto' = 判定登录成功就开录 */
    start,
    /** 是否把登录动作也录进视频（默认否，绝大多数培训视频不需要） */
    record: r.record === true,
    url: absUrl(r.url || (project && project.url) || ''),
    storagePath: path.isAbsolute(storageRel) ? storageRel : path.resolve(HERE, storageRel),
    reuse: r.reuse !== false,
    timeoutSec: Math.max(20, Number(r.timeout || 300)),
    headless: r.headless === true,
    username: resolveCredentials ? expandEnv(r.username) : String(r.username || ''),
    password: resolveCredentials ? expandEnv(r.password) : String(r.password || ''),
    userSelector: r.usernameSelector || r.userSelector || '',
    passSelector: r.passwordSelector || r.passSelector || '',
    submitSelector: r.submitSelector || r.loginButton || '',
    successSelector: r.successSelector || r.afterLoginSelector || '',
    successUrl: r.successUrl || '',
    preClick: Array.isArray(r.preClick) ? r.preClick.filter(Boolean) : r.preClick ? [r.preClick] : [],
    readOnlyRequests: require('./requests').normalizeRequests(project && project.readOnlyRequests, (project && project.url) || r.url, 'readOnlyRequests', { readOnly: true }),
    writeRequests: require('./requests').normalizeRequests(project && (project.writeRequests || project.safety && project.safety.writeRequests), (project && project.url) || r.url, 'writeRequests'),
  };
}

/** 说法的中文版，日志和界面共用一套措辞，免得两处对不上 */
function describeLogin(cfg) {
  if (!cfg || !cfg.enabled) return '不需要登录';
  const how = cfg.mode === 'auto' ? '自动填账号密码' : '人工登录';
  const when = cfg.start === 'manual' ? '登录后由你点【开始录制】' : '登录成功即自动开录';
  return how + ' · ' + when;
}


// ============================================================
// 浏览器
// ============================================================

function launch(headless) {
  const { chromium } = requireFrom('playwright');
  return chromium.launch({
    headless: !!headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

async function newCtx(browser, storageState, cfg) {
  const opt = { viewport: { width: 1440, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block' };
  if (storageState) opt.storageState = storageState;
  const context = await browser.newContext(opt);
  context.requestGuard = await require('./requests').installRequestGuard(context, { ...cfg, pageUrl: cfg.url });
  return context;
}

/**
 * 关浏览器。
 * 无头模式下 browser.close() 有概率不返回（本项目实测过，与页面内容无关），
 * 所以这里统一加超时兜底；超时后直接杀进程 —— 杀的是我们自己拉起来的那个，
 * 不会碰到用户已经在用的浏览器。
 */
async function shutdown(browser, ctx) {
  if (ctx) await Promise.race([ctx.close().catch(() => {}), sleep(4000)]);
  if (browser) {
    await Promise.race([browser.close().catch(() => {}), sleep(6000)]);
    try {
      const proc = browser.process && browser.process();
      if (proc && proc.exitCode === null) proc.kill('SIGKILL');
    } catch (e) {
      /* 已经退了 */
    }
  }
}

/** 有些系统登录后会开新标签页，要跟着切过去 */
function activePage(ctx, fallback) {
  try {
    const pages = ctx.pages().filter((p) => !p.isClosed());
    return pages.length ? pages[pages.length - 1] : fallback;
  } catch (e) {
    return fallback;
  }
}

// ============================================================
// 登录状态判定
// ============================================================

/**
 * 判断当前页面是"已登录"还是"还在登录页"。
 *   'in'      已登录
 *   'out'     还在登录页
 *   'unknown' 判断不了（配了成功标志但没出现）
 *
 * 优先用配置里给的标志；没配就退化为"页面上还有没有密码框"这个朴素但有效的信号。
 */
async function judge(page, cfg) {
  if (!page || page.isClosed()) return 'unknown';
  try {
    if (cfg.successSelector) {
      const vis = await page.locator(cfg.successSelector).first().isVisible().catch(() => false);
      if (vis) return 'in';
    }
    if (cfg.successUrl) {
      try {
        if (new RegExp(cfg.successUrl).test(page.url())) return 'in';
      } catch (e) {
        /* 正则写错了就当没配 */
      }
    }
    const pwd = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
    if (pwd) return 'out';
    if (cfg.successSelector || cfg.successUrl) return 'unknown';
    return 'in';
  } catch (e) {
    return 'unknown';
  }
}

// ============================================================
// 人工闸门 —— 弹窗口给你登，登完由你说"开始"
// ============================================================

/**
 * 开一个闸门，等用户明确说"我登好了"。
 *
 * 为什么不用"检测到登录成功就自动开始"：真实系统里登录成功后往往还有
 * 验证码校验、二次确认、首次登录改密码这类岔路，脚本判早了会把半成品录进去。
 * 与其猜，不如让用户说一句 —— 反正他就坐在那儿。
 *
 * 触发源有两个，谁先来算谁：
 *   · 终端回车      —— 命令行跑的时候最顺手（stdin 是 TTY 才会装上这个监听）
 *   · 网页界面按钮  —— 从界面跑的时候没有终端，靠它
 *
 * @returns {{ runId:string, poll:()=>('go'|'force'|null), warn:(text:string)=>void, close:()=>void }}
 */
function humanGate(cfg, log) {
  const runId = 'run-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const startedAt = Date.now();
  let hint = '在浏览器里完成登录后，回到终端按一次回车，或在本地确认页点「我已登录完成 · 继续」';
  let needForce = false;

  const writeWaitFile = () => {
    try {
      fs.mkdirSync(path.dirname(WAIT_FILE), { recursive: true });
      fs.writeFileSync(WAIT_FILE, JSON.stringify({
        runId,
        pid: process.pid,
        startedAt,
        url: cfg.url,
        timeout: cfg.timeoutSec,
        hint,
        needForce,
      }, null, 2), 'utf8');
    } catch (e) {
      /* 写不进去不影响主流程：终端回车这条路径不依赖它 */
    }
  };

  // 上一轮如果留下了残标，清掉；否则这一轮会被它直接放过去
  try { fs.unlinkSync(GO_FILE); } catch (e) { /* 本来就没有 */ }
  writeWaitFile();

  // Ctrl+C 时也要把闸门文件收干净。
  // 不收的话它会一直躺在那儿，界面会一直显示一个"点不动的按钮"。
  const cleanup = () => {
    try { fs.unlinkSync(WAIT_FILE); } catch (e) { /* 无所谓 */ }
    try { fs.unlinkSync(GO_FILE); } catch (e) { /* 无所谓 */ }
  };
  const onSignal = () => {
    cleanup();
    try { process.stdin.pause(); } catch (e) { /* 无所谓 */ }
    console.log('\n[登录] 已取消（Ctrl+C）。');
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let stdinHit = false;
  let stdinArmed = false;
  if (process.stdin.isTTY) {
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.resume();
      process.stdin.on('data', (d) => {
        if (/\r|\n/.test(String(d))) stdinHit = true;
      });
      stdinArmed = true;
    } catch (e) {
      stdinArmed = false;
    }
  }

  log('[登录] 等待确认的闸门已开（' + (stdinArmed ? '终端回车 / ' : '') + '网页按钮）');

  return {
    runId,
    stdinArmed,
    /** 有触发就返回触发类型：'go' 普通确认；'force' 忽略登录检查强行继续 */
    poll() {
      if (stdinHit) {
        stdinHit = false;
        return needForce ? 'force' : 'go';
      }
      if (fs.existsSync(GO_FILE)) {
        let ok = false;
        let force = false;
        try {
          const j = JSON.parse(fs.readFileSync(GO_FILE, 'utf8'));
          ok = j && j.runId === runId;
          force = !!(j && j.force);
        } catch (e) {
          ok = false;
        }
        try { fs.unlinkSync(GO_FILE); } catch (e) { /* 已经被别处清了 */ }
        if (ok) return force ? 'force' : 'go';
      }
      return null;
    },
    /** 检查没通过时更新提示：让界面上的按钮变成"仍然继续"，用户知道为什么 */
    warn(text) {
      hint = text;
      needForce = true;
      writeWaitFile();
    },
    close() {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      cleanup();
      if (stdinArmed) {
        try { process.stdin.pause(); } catch (e) { /* 无所谓 */ }
      }
    },
  };
}

/**
 * 等着用户确认登录完成。
 * 确认后会顺手看一眼页面是不是真的登进去了 —— 没登进去就再问一次，
 * 免得用户手快点了按钮，结果存下来一份"还没登录"的登录态，
 * 一路带到录制环节才炸。
 *
 * @returns {Promise<boolean>} 用户是否确认了
 */
async function waitForHumanConfirm(cfg, getPage, log) {
  const gate = humanGate(cfg, log);
  const deadline = Date.now() + cfg.timeoutSec * 1000;
  let attempts = 0;

  try {
    while (Date.now() < deadline) {
      const hit = gate.poll();
      if (!hit) {
        await sleep(300);
        continue;
      }

      attempts += 1;
      const page = getPage();
      if (!page || page.isClosed()) throw new Error('浏览器窗口被关掉了，登录没有完成。');

      const st = await judge(page, cfg);

      // 用户第一次就点了"仍然继续"，或者这是第二次确认 —— 尊重用户，放行
      if (st === 'in' || hit === 'force' || attempts >= 2) {
        log('[登录] 已收到确认' + (st === 'in' ? '，页面确认处于已登录状态。' : '。'));
        return true;
      }

      // 判定还在登录页：不硬闯，先问一句
      const msg = cfg.successSelector
        ? '页面上还没看到「' + cfg.successSelector + '」，像是没登进去'
        : '页面上还留着密码输入框，像是没登进去';
      log('');
      log('  ⚠ ' + msg + '。');
      log('    如果确实已经登录成功（只是识别不准），再确认一次就会跳过这个检查：');
      log('      · 终端：再按一次回车');
      log('      · 界面：点「仍然继续」');
      log('');
      gate.warn('没检测到已登录（' + msg + '）。如果确定已登好，点这里继续。');
    }
    return false;
  } finally {
    gate.close();
  }
}

// ============================================================
// 登录表单的自动识别（mode=auto 时用；人工登录完全不需要）
// ============================================================

const USER_GUESS = [
  'input[type="text"][name*="user" i]',
  'input[type="text"][id*="user" i]',
  'input[name*="account" i]',
  'input[id*="account" i]',
  'input[name*="login" i]',
  'input[placeholder*="用户"]',
  'input[placeholder*="账号"]',
  'input[placeholder*="邮箱"]',
  'input[placeholder*="手机"]',
  'input[type="email"]',
  'input[type="text"]',
  'input:not([type])',
];

const PASS_GUESS = ['input[type="password"]'];

const SUBMIT_GUESS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("登录")',
  'button:has-text("登 录")',
  'button:has-text("Sign in")',
  'button:has-text("Login")',
  '[class*="login" i] button',
  'form button',
];

async function guess(page, sels) {
  for (const sel of sels) {
    const loc = page.locator(sel);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 5); i++) {
      const one = loc.nth(i);
      if (await one.isVisible().catch(() => false)) return { sel, loc: one };
    }
  }
  return null;
}

async function autoFill(page, cfg, log) {
  if (!cfg.username || !cfg.password) {
    throw new Error(
      'mode=auto 但没有配账号密码。\n'
        + '   · login.username / login.password 都要填\n'
        + '   · 口令建议写成环境变量引用，例如 "password": "${DEMO_PWD}"'
    );
  }

  const u = cfg.userSelector
    ? { sel: cfg.userSelector, loc: page.locator(cfg.userSelector).first() }
    : await guess(page, USER_GUESS);

  const p = cfg.passSelector
    ? { sel: cfg.passSelector, loc: page.locator(cfg.passSelector).first() }
    : await guess(page, PASS_GUESS);

  if (!p) {
    throw new Error(
      '没找到密码输入框，没法自动填。常见的三个原因：\n'
        + '   1) 登录表单藏在一个标签页后面 → 用 login.preClick 配上要先点的元素\n'
        + '   2) 密码框不是标准的 type="password" → 用 login.passwordSelector 直接指定\n'
        + '   3) 登录页有验证码 / 滑块 / 短信码 → 自动填不了，把 login.mode 改成 "manual"，\n'
        + '      人工登录一次即可，之后会自动复用登录态，不用每次都登。'
    );
  }

  if (u) {
    await u.loc.fill('');
    await u.loc.fill(cfg.username);
    log('[登录] 已填账号');
  }
  await p.loc.fill('');
  await p.loc.fill(cfg.password);
  log('[登录] 已填口令（不回显）');

  const s = cfg.submitSelector
    ? { sel: cfg.submitSelector, loc: page.locator(cfg.submitSelector).first() }
    : await guess(page, SUBMIT_GUESS);

  if (s) {
    log('[登录] 提交：' + s.sel);
    await s.loc.click({ timeout: 10000 });
  } else {
    log('[登录] 没找到登录按钮，改用回车提交');
    await p.loc.press('Enter');
  }
}

// ============================================================
// 两条主路径
// ============================================================

/** 现有登录态还有效吗 */
async function validateAuth(cfg, log) {
  if (!fs.existsSync(cfg.storagePath)) return 'missing';
  const browser = await launch(true);
  let ctx = null;
  try {
    ctx = await newCtx(browser, cfg.storagePath, cfg);
    const page = await ctx.newPage();
    await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await sleep(1200);
    ctx.requestGuard.assert();
    return await judge(page, cfg);
  } catch (e) {
    if (ctx) ctx.requestGuard.assert();
    if (e.code === 'REQUEST_POLICY') throw e;
    if (log) log('[登录] 校验登录态时出错（当作失效处理）：' + e.message.split('\n')[0]);
    return 'unknown';
  } finally {
    if (ctx) ctx.requestGuard.close();
    await shutdown(browser, ctx);
    if (ctx) ctx.requestGuard.assert();
  }
}

/** 真正去登录一次，成功则保存登录态 */
async function captureLogin(cfg, log) {
  // 只要有人工环节，就必须看得见窗口 —— headless 下用户没法登录，也没法点"开始录制"
  const needsEyes = cfg.mode !== 'auto' || cfg.start === 'manual';
  const headless = needsEyes ? false : cfg.headless;
  if (needsEyes && cfg.headless) {
    log('[登录] 本次需要人工参与，已忽略 headless 设置，改为弹出可见窗口。');
  }

  const browser = await launch(headless);
  let ctx = null;
  try {
    ctx = await newCtx(browser, null, cfg);
    let page = await ctx.newPage();

    log('[登录] 打开：' + cfg.url);
    await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await sleep(800);
    ctx.requestGuard.assert();

    for (const sel of cfg.preClick) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        log('[登录] 先点开：' + sel);
        await loc.click({ timeout: 6000 }).catch(() => {});
        await sleep(600);
      }
    }

    const openedIn = (await judge(page, cfg)) === 'in';
    if (openedIn) {
      log('[登录] 打开就是已登录状态，不用填表。');
    } else if (cfg.mode === 'auto') {
      await autoFill(page, cfg, log);
    } else {
      log('');
      log('  ┌──────────────────────────────────────────────────────────┐');
      log('  │  已在浏览器窗口里打开登录页，请先完成登录                  │');
      log('  └──────────────────────────────────────────────────────────┘');
    }

    // ---------------- 等"可以开始录了" ----------------
    let loggedIn = false;

    if (cfg.start === 'manual') {
      // 人工触发：登录归登录，什么时候开录由你说了算。
      // 已经登录的情况下也等 —— 这个开关的语义就是"由我决定什么时候开始"。
      if (!openedIn) {
        log('  登录成功后，用下面任意一种方式告诉我"可以开始录了"：');
        log('    · 回到这个终端，按一次回车');
        log('    · 打开本地确认页，点【我已登录完成 · 继续】');
        log('  （登录过程不会录进视频，可以放心操作）');
      }
      log('');
      loggedIn = await waitForHumanConfirm(cfg, () => activePage(ctx, page), log);
      if (!loggedIn) {
        throw new Error(
          '等了 ' + cfg.timeoutSec + ' 秒也没等到你点"开始录制"。\n'
            + '   · 登录完成后再按一次回车（或点界面上的按钮）就能继续\n'
            + '   · 想多留点时间，把 login.timeout 调大（当前 ' + cfg.timeoutSec + ' 秒）\n'
            + '   · 不想每次都要点一下：把 login.start 改成 "auto"'
        );
      }
    } else {
      // 自动开录。要求连续两次判定为已登录：SPA 跳转中间那一瞬间页面可能是空的，
      // 单次判定容易把"正在跳转"误当成"登好了"。
      const deadline = Date.now() + cfg.timeoutSec * 1000;
      let streak = 0;
      let lastTip = Date.now();

      while (Date.now() < deadline) {
        await sleep(1000);
        ctx.requestGuard.assert();
        page = activePage(ctx, page);
        if (!page || page.isClosed()) throw new Error('浏览器窗口被关掉了，登录没有完成。');

        const st = await judge(page, cfg);
        if (st === 'in') {
          streak += 1;
          if (streak >= 2) {
            loggedIn = true;
            break;
          }
        } else {
          streak = 0;
        }

        if (Date.now() - lastTip > 15000) {
          lastTip = Date.now();
          const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
          log('  仍在等待登录……（还剩 ' + left + ' 秒）');

        }
      }

      if (!loggedIn) {
        throw new Error(
          '等了 ' + cfg.timeoutSec + ' 秒还没等到登录完成。\n'
            + '   · 确认一下窗口里是否真的登进去了\n'
            + '   · 如果登录后页面特征不明显，配上 login.successSelector（比如头像、用户名）就能准确识别\n'
            + '   · 想每次都由自己说了算，把 login.start 改成 "manual"（登录完点一下【开始录制】）'
        );
      }
    }

    ctx.requestGuard.assert();
    fs.mkdirSync(path.dirname(cfg.storagePath), { recursive: true });
    await ctx.storageState({ path: cfg.storagePath });
    log('[登录] 成功，登录态已存到 ' + path.relative(HERE, cfg.storagePath));
    if (cfg.reuse) log('[登录] 以后再录同一个系统会自动复用，不用再登。');
    return cfg.storagePath;
  } finally {
    if (ctx) ctx.requestGuard.close();
    await shutdown(browser, ctx);
    if (ctx) ctx.requestGuard.assert();
  }
}


// ============================================================
// 对外主入口
// ============================================================

const defaultLog = (s) => console.log(s);

/**
 * 保证"接下来这一刻是已登录的"。
 *
 * @param {object} project      asLoginProject(script) 的归一化登录配置（留空则读 script.yaml）
 * @param {object} opts
 *        opts.force   忽略已有登录态，强制重新登录
 *        opts.trust   信任已有登录态，跳过有效性验证（同一轮构建里前面刚验过，省几秒）
 *        opts.log     日志函数，默认 console.log
 * @returns {{enabled:boolean, storageState:string|null, reused:boolean, storagePath?:string}}
 */
async function ensureLoggedIn(project, opts = {}) {
  const log = opts.log || defaultLog;

  // produce.js --no-login 时统一走这条。
  if (process.env.REC_NO_LOGIN === '1') {
    log('[登录] 本次构建按配置跳过了登录（--no-login）。');
    return { enabled: false, storageState: null, reused: false };
  }

  const cfg = normLogin(project === undefined || project === null
    ? (opts.projectFile ? readProject(opts.projectFile) : readLoginScript(opts.scriptFile)) : project);

  if (!cfg.enabled) {
    return { enabled: false, storageState: null, reused: false };
  }

  if (!cfg.url) {
    throw new Error('配置里启用了登录，但脚本 url 和 login.url 都是空的。');
  }

  log('[登录] 方式：' + describeLogin(cfg));

  const hasAuth = fs.existsSync(cfg.storagePath);

  if (hasAuth && cfg.reuse && !opts.force) {
    if (opts.trust) {
      log('[登录] 沿用本轮已确认有效的登录态。');
      return { enabled: true, storageState: cfg.storagePath, reused: true, storagePath: cfg.storagePath };
    }

    log('[登录] 发现已保存的登录态，正在验证是否还有效……');
    const st = await validateAuth(cfg, log);
    if (st === 'in') {
      log('[登录] 登录态仍然有效，直接复用（不会弹窗）。');
      return { enabled: true, storageState: cfg.storagePath, reused: true, storagePath: cfg.storagePath };
    }
    log('[登录] 登录态已失效' + (st === 'out' ? '（被弹回登录页）' : '（无法确认）') + '，需要重新登录。');
  }

  const storageState = await captureLogin(cfg, log);
  return { enabled: true, storageState, reused: false, storagePath: cfg.storagePath };
}

/** 清掉已保存的登录态（换账号、或怀疑它坏了的时候用） */
function clearAuth(project) {
  const cfg = normLogin(project || readLoginScript());
  if (fs.existsSync(cfg.storagePath)) {
    fs.unlinkSync(cfg.storagePath);
    return cfg.storagePath;
  }
  return null;
}

module.exports = {
  ensureLoggedIn,
  clearAuth,
  normLogin,
  readProject,
  readLoginScript,
  describeLogin,
  WAIT_FILE,
  GO_FILE,
};

// ============================================================
// 命令行入口
// ============================================================

if (require.main === module) {
  (async () => {
    const { values, positionals } = CLI;
    if (values.project) console.error('[迁移提示] --project 仅兼容旧 JSON；新调用使用 node login.js <脚本.yaml>。');
    const project = values.project ? readProject(values.project) : readLoginScript(positionals[0]);

    // 命令行临时覆盖，不用动配置文件：
    //   --mode manual|auto|none   登录怎么完成
    //   --start manual|auto       什么时候开录（manual = 你点【开始录制】）
    const overrides = {};
    const modeOverride = values.mode || '';
    if (modeOverride === 'wait' || modeOverride === 'confirm') {
      overrides.mode = 'manual';
      overrides.start = 'manual';
      overrides.enabled = true;
    } else if (modeOverride) {
      overrides.mode = modeOverride;
      overrides.enabled = modeOverride !== 'none';
    }
    const startOverride = values.start || '';
    if (startOverride === 'manual' || startOverride === 'auto') overrides.start = startOverride;
    if (Object.keys(overrides).length) {
      project.login = Object.assign({}, project.login || {}, overrides);
    }

    const cfg = normLogin(project);

    if (values.clear) {
      const f = clearAuth(project);
      console.log(f ? '已删除登录态：' + path.relative(HERE, f) : '本来就没有保存登录态。');
      process.exit(0);
    }

    if (!cfg.enabled) {
      console.log('配置里 login 未启用（enabled=false 或 mode=none），这个系统不需要登录。');
      console.log('要启用，把 login 改成：{ "enabled": true }　默认就是「人工登录 + 我点开始录制」');
      process.exit(0);
    }

    console.log('登录方式：' + describeLogin(cfg) + '　地址 ' + cfg.url);
    console.log('登录态文件：' + path.relative(HERE, cfg.storagePath));

    if (values.check) {
      const st = await validateAuth(cfg, defaultLog);
      const label = { in: '仍然有效', out: '已失效（会被弹回登录页）', unknown: '无法确认', missing: '还没有保存过' }[st];
      console.log('结论：' + label);
      process.exit(st === 'in' ? 0 : 2);
    }

    const r = await ensureLoggedIn(project, { force: !!values.force });
    console.log(r.reused ? '完成：复用了已有的登录态。' : '完成：已登录并保存登录态。');
    process.exit(0);
  })().catch((e) => {
    console.error('\n[登录失败] ' + e.message);
    process.exit(1);
  });
}
