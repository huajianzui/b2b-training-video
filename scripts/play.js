#!/usr/bin/env node
/**
 * 按演示脚本回放并录屏（旁白先行）
 *
 * 输入：当前脚本 YAML（旧 JSON 只可指向其 source）+ output/tts/manifest.json
 * 输出：output/raw.webm、output/session.json（每个场景在视频里的起止时刻）、output/run-report.json
 *
 * 节奏由旁白决定：每个场景至少持续「旁白时长 + 前后留白」，所以配音永远不会被挤压加速。
 * 画面里只有光标和点击涟漪，字幕在后期烧录 —— 改字幕不用重录。
 *
 * 用法：
 *   node play.js <脚本.yaml>            正式录制，按 writeMode 收尾
 *   node play.js <脚本.yaml> --dry      演练，按 rehearsalMode 收尾；submit 仍等待用户确认数据
 *   node play.js <脚本.yaml> --shots    正式手册素材；--dry --shots 为独立演练素材
 *   node play.js --headed   弹出浏览器窗口（默认无头，服务器 / CI 上也能跑）
 *   node play.js --dry --scenes 9-20   只演练第 9～20 个场景（也可写 12 或 9-），调脚本时用；正式录制不支持
 */

const CLI = require('./cli').readCli({
  usage: '用法：node play.js [脚本.yaml] [--dry] [--shots] [--headed]\n'
    + '  --dry --scenes <9-20|9-|12>  只演练完整场景组，不截图\n'
    + '  未指定 YAML 时仅使用缓存 JSON 记录的 YAML 来源；submit 仍需本轮用户确认。',
  options: { dry: { type: 'boolean' }, shots: { type: 'boolean' }, headed: { type: 'boolean' }, scenes: { type: 'string' } },
  validate: ({ values }) => sceneRange(values)
});

const fs = require('fs');
const path = require('path');
const { requireFrom } = require('./deps');
const { ensureLoggedIn } = require('./login');
const { loadScript, asLoginProject, DEFAULT_OUT: SCRIPT_JSON } = require('./script');
const { installRequestGuard, executionHash } = require('./requests');
const { waitForData } = require('./confirmation');
const { acquireLock } = require('./lock');
const { loadAdapters, select } = require('./adapters');
const { probeDuration } = require('./media');
const { chromium } = requireFrom('playwright');

const HERE = __dirname;
const OUT = path.join(HERE, 'output');
const DRY = !!CLI.values.dry;
const HEADED = !!CLI.values.headed;
const SHOTS = !!CLI.values.shots;
const STAGE = DRY ? 'rehearsal' : 'record';
const MATERIAL_DIR = path.join(OUT, 'manual', STAGE);
const SHOT_DIR = path.join(MATERIAL_DIR, 'shots');

function sceneRange(values = CLI.values) {
  if (values.scenes === undefined) return null;
  const m = /^(\d+)(-(\d*))?$/.exec(values.scenes);
  if (!m) throw new Error('--scenes 写成 9-20、9- 或 12');
  if (!values.dry || values.shots) throw new Error('--scenes 只能用于不截图的演练（--dry）');
  const from = Number(m[1]);
  const to = m[2] ? (m[3] ? Number(m[3]) : Infinity) : from;
  if (!Number.isSafeInteger(from) || from < 1 || (to !== Infinity && (!Number.isSafeInteger(to) || to < from))) {
    throw new Error('--scenes 从 1 开始，范围终点不能小于起点。');
  }
  return (n) => n >= from && n <= to;
}

const CFG = {
  viewport: { width: 1920, height: 1080 },
  lead: 500,          // 场景开始到旁白起念的留白
  tail: 400,          // 旁白念完到场景结束的留白
  stepPause: 600,     // 动作之间的停顿
  cueLead: 300,       // 带 at 的动作提前出发，光标移过去时旁白正好念到
  typeDelay: 90,
  moveSteps: 20,
  locateTimeout: 10000,
  expectTimeout: 8000,
  tailWait: 1500,
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function closeWithin(promise, ms, label) {
  let timer;
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + '未在既有关闭时限内完成，录制未通过。')), ms); })]); }
  finally { clearTimeout(timer); }
}

const CURSOR_OVERLAY = `
(() => {
  if (window.__recReady) return;
  window.__recReady = true;
  function mount() {
    const style = document.createElement('style');
    style.textContent = [
      '#__cur{position:fixed;z-index:2147483646;width:20px;height:20px;border-radius:50%;',
      'background:rgba(24,95,165,.9);border:2px solid #fff;pointer-events:none;',
      'transform:translate(-50%,-50%);left:-100px;top:-100px;box-shadow:0 2px 8px rgba(0,0,0,.35);',
      'transition:left .16s ease-out,top .16s ease-out;}',
      '.__rip{position:fixed;z-index:2147483645;width:18px;height:18px;border-radius:50%;',
      'border:4px solid rgba(216,90,48,.95);pointer-events:none;transform:translate(-50%,-50%);',
      'animation:__rip .65s ease-out forwards;}',
      '@keyframes __rip{from{opacity:.95}to{width:96px;height:96px;opacity:0;border-width:1px}}'
    ].join('');
    (document.head || document.documentElement).appendChild(style);
    const dot = document.createElement('div');
    dot.id = '__cur';
    document.body.appendChild(dot);
    document.addEventListener('mousemove', e => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px'; }, true);
    document.addEventListener('mousedown', e => {
      if (window.__shotMode) return;
      const r = document.createElement('div');
      r.className = '__rip';
      r.style.left = e.clientX + 'px';
      r.style.top = e.clientY + 'px';
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 700);
    }, true);
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
`;

// ---------------------------------------------------------------- 定位

function toLocator(page, c) {
  let loc;
  switch (c.by) {
    case undefined: loc = page.locator(c.selector); break;
    case 'testid': loc = page.getByTestId(c.value); break;
    case 'id': loc = page.locator('[id="' + c.value.replace(/"/g, '\\"') + '"]'); break;
    case 'css': loc = page.locator(c.value); break;
    case 'role': loc = page.getByRole(c.value, c.name !== undefined ? { name: c.name, exact: !!c.exact } : {}); break;
    case 'label': loc = page.getByLabel(c.value, { exact: !!c.exact }); break;
    case 'placeholder': loc = page.getByPlaceholder(c.value, { exact: !!c.exact }); break;
    case 'text': loc = page.getByText(c.value, { exact: c.exact !== false }); break;
    default: throw new Error('未知定位方式：' + c.by);
  }
  loc = loc.filter({ visible: true });
  return c.nth !== undefined ? loc.nth(c.nth) : loc.first();
}

function describe(c) {
  if (c.by === undefined) return c.selector;
  return c.by + '=' + c.value + (c.name !== undefined ? '[' + c.name + ']' : '') + (c.nth !== undefined ? '#' + c.nth : '');
}

/** 轮询所有候选，返回第一个可见的；index > 0 说明主定位已失效、靠降级命中 */
async function findVisible(page, candidates, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (let i = 0; i < candidates.length; i++) {
      const locator = toLocator(page, candidates[i]);
      if (await locator.isVisible().catch(() => false)) return { locator, index: i };
    }
    if (Date.now() > deadline) {
      throw new Error('找不到可见元素：' + candidates.map(describe).join(' ｜ '));
    }
    await wait(250);
  }
}

// ---------------------------------------------------------------- 手册截图

/** 从界面读出控件的类型和名称，手册里写成「在【订单状态】下拉框中选择」 */
const DESCRIBE_EL = (n) => {
  const t = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const tag = n.tagName.toLowerCase();
  const role = n.getAttribute('role') || '';
  let kind = '';
  if (tag === 'select' || role === 'combobox' || n.closest('.el-select, .el-select-v2, .el-cascader, .el-tree-select')) kind = 'select';
  else if (tag === 'input' || tag === 'textarea' || n.isContentEditable || n.closest('.el-input, .el-textarea')) kind = 'input';
  else if (tag === 'button' || role === 'button' || n.closest('button')) kind = 'button';
  else if (role === 'tab' || n.closest('.el-tabs__item')) kind = 'tab';
  else if (role === 'menuitem' || n.closest('.el-menu-item, .el-sub-menu__title')) kind = 'menu';
  else if (tag === 'a' || role === 'link') kind = 'link';

  const formItem = n.closest('.el-form-item');
  const formLabel = formItem && formItem.querySelector('.el-form-item__label');
  const ownLabel = n.labels && n.labels[0];
  const name = t(n.getAttribute('aria-label'))
    || t(ownLabel && ownLabel.innerText)
    || t(formLabel && formLabel.innerText).replace(/[:：]$/, '')
    || (kind === 'input' ? t(n.placeholder) : '')
    || (kind !== 'select' && kind !== 'input' ? t(n.innerText).slice(0, 20) : '');
  return { kind, name };
};

/** 手册截图里不要光标（点击涟漪在截图模式下根本不生成，见 __shotMode） */
async function cleanShot(page, file, box) {
  await page.evaluate((b) => {
    const c = document.getElementById('__cur');
    if (c) c.style.visibility = 'hidden';
    if (!b) return;
    const d = document.createElement('div');
    d.id = '__hl';
    Object.assign(d.style, {
      position: 'fixed', left: (b.x - 6) + 'px', top: (b.y - 6) + 'px',
      width: (b.width + 12) + 'px', height: (b.height + 12) + 'px',
      border: '3px solid #e5484d', borderRadius: '6px', boxShadow: '0 0 0 4px rgba(229,72,77,.18)',
      zIndex: 2147483647, pointerEvents: 'none',
    });
    document.body.appendChild(d);
  }, box || null);
  await page.screenshot({ path: file });
  await page.evaluate(() => {
    const d = document.getElementById('__hl');
    if (d) d.remove();
    const c = document.getElementById('__cur');
    if (c) c.style.visibility = '';
  });
  return path.relative(HERE, file).replace(/\\/g, '/');
}

async function capture(page, loc, file) {
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const info = await loc.evaluate(DESCRIBE_EL);
  const box = await loc.boundingBox();
  if (!box) return info;
  return Object.assign(info, { shot: await cleanShot(page, file, box) });
}

const captureResult = (page, file) => cleanShot(page, file, null);

// ---------------------------------------------------------------- 拟人操作

function makeCtx(page) {
  const ctx = {
    page,
    async moveTo(loc) {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      const box = await loc.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: DRY ? 1 : CFG.moveSteps });
        if (!DRY) await wait(250);
      }
    },
    async click(loc) {
      await ctx.moveTo(loc);
      await loc.click();
    },
    findVisible: (cands, timeout) => findVisible(page, cands, timeout || CFG.locateTimeout),
  };
  return ctx;
}

/** 目标可能是组件库的外层容器（如 .el-input），真正能输入的是里面的 input */
async function editable(loc) {
  const ok = await loc.evaluate((n) => n.matches('input, textarea, [contenteditable=""], [contenteditable="true"]'));
  return ok ? loc : loc.locator('input, textarea').filter({ visible: true }).first();
}

/** step 是手册里的这一步：定位到目标后补上控件类型、名称和截图 */
async function runAction(ctx, adapters, a, notes, step) {
  const { page } = ctx;
  let hitName = '';
  const locate = async () => {
    const hit = await ctx.findVisible(a.target);
    hitName = describe(a.target[hit.index]);
    if (hit.index > 0) notes.push('主定位失效，降级命中第 ' + (hit.index + 1) + ' 个候选：' + hitName);
    if (SHOTS) Object.assign(step, await capture(page, hit.locator, path.join(SHOT_DIR, step.id + '.png')));
    return hit.locator;
  };

  switch (a.op) {
    case 'goto':
      // 场景开头的 goto 是为了能单独执行；已经在这一页时再刷新会让视频闪一下
      if (page.url() === a.url) return a.url + '（已在此页）';
      await page.goto(a.url, { waitUntil: 'domcontentloaded' });
      return a.url;
    case 'click':
      await ctx.click(await locate());
      return hitName;
    case 'hover':
      await ctx.moveTo(await locate());
      return hitName;
    case 'waitFor':
      await locate();
      return hitName;
    case 'fill': {
      const el = await editable(await locate());
      await ctx.click(el);
      await el.fill('');
      if (DRY) await el.fill(a.text);
      else await el.pressSequentially(a.text, { delay: CFG.typeDelay });
      return hitName + ' ← ' + a.text;
    }
    case 'select': {
      const el = await locate();
      const by = await select(adapters, ctx, el, a.value);
      return hitName + ' ← ' + a.value + '（' + by + '）';
    }
    case 'press':
      await page.keyboard.press(a.key);
      return a.key;
    case 'scroll':
      await page.mouse.wheel(0, a.y);
      return String(a.y);
    case 'wait':
      await wait(a.ms);
      return a.ms + 'ms';
    default:
      throw new Error('未知动作：' + a.op);
  }
}

/** 返回给手册用的结果描述 */
async function checkExpect(ctx, e) {
  const { page } = ctx;
  switch (e.kind) {
    case 'visible': {
      const hit = await findVisible(page, e.target, CFG.expectTimeout);
      return { kind: 'visible', name: SHOTS ? (await hit.locator.evaluate(DESCRIBE_EL)).name : '' };
    }
    case 'hidden': {
      const deadline = Date.now() + CFG.expectTimeout;
      for (;;) {
        const shown = await Promise.all(e.target.map((c) => toLocator(page, c).isVisible().catch(() => false)));
        if (!shown.includes(true)) return { kind: 'hidden' };
        if (Date.now() > deadline) throw new Error('元素没有消失：' + e.target.map(describe).join(' ｜ '));
        await wait(200);
      }
    }
    case 'disabled': {
      const hit = await findVisible(page, e.target, CFG.expectTimeout);
      const deadline = Date.now() + CFG.expectTimeout;
      // Element Plus 的禁用态在外层用 is-disabled 类，原生控件在内部
      const isDisabled = (el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true'
        || el.classList.contains('is-disabled') || !!el.querySelector('input:disabled, textarea:disabled, button:disabled');
      while (!(await hit.locator.evaluate(isDisabled))) {
        if (Date.now() > deadline) throw new Error('控件不是禁用状态：' + e.target.map(describe).join(' ｜ '));
        await wait(200);
      }
      return { kind: 'disabled', name: SHOTS ? (await hit.locator.evaluate(DESCRIBE_EL)).name : '' };
    }
    case 'text':
      await page.getByText(e.text).filter({ visible: true }).first()
        .waitFor({ state: 'visible', timeout: CFG.expectTimeout });
      return { kind: 'text', text: e.text };
    case 'url': {
      const deadline = Date.now() + CFG.expectTimeout;
      while (!page.url().includes(e.url)) {
        if (Date.now() > deadline) throw new Error('地址里没有出现「' + e.url + '」，当前：' + page.url());
        await wait(200);
      }
      return { kind: 'url', url: e.url };
    }
    default:
      throw new Error('未知断言：' + e.kind);
  }
}

const EXPECT_WORD = { visible: '可见', hidden: '消失', disabled: '禁用' };
const describeExpect = (e) => (e.target ? EXPECT_WORD[e.kind] + ' ' + e.target.map(describe).join(' ｜ ') : e.kind + ' ' + (e.text || e.url));

// ---------------------------------------------------------------- 失败现场

/** 截图 + 页面无障碍结构，留给人排查，也是后续 AI 自愈这一步的输入 */
async function captureFailure(page, scene) {
  const shot = path.join(OUT, 'fail-' + scene.id + '.png');
  await page.screenshot({ path: shot }).catch(() => {});
  const aria = await page.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => '');
  return { screenshot: path.relative(HERE, shot), url: page.url(), aria: aria.slice(0, 20000) };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const source = CLI.positionals[0]
    || (fs.existsSync(SCRIPT_JSON) && JSON.parse(fs.readFileSync(SCRIPT_JSON, 'utf8')).source);
  if (!source) throw new Error('缺少 YAML 来源；旧 JSON 不能作为执行输入，请运行 node play.js <脚本.yaml>。');
  const script = loadScript(path.resolve(HERE, source), { stage: STAGE });
  const inRange = sceneRange();
  if (inRange) {
    const keep = script.scenes.map((s, i) => inRange(i + 1));
    // 范围必须包含完整接续组，不能漏掉基础动作或取消/提交收尾。
    for (let i = keep.length - 1; i > 0; i--) if (keep[i] && script.scenes[i].continue) keep[i - 1] = true;
    for (let i = 1; i < keep.length; i++) if (keep[i - 1] && script.scenes[i].continue) keep[i] = true;
    script.scenes = script.scenes.filter((s, i) => keep[i]);
    if (!script.scenes.length) throw new Error('--scenes 没有命中场景');
  }
  const release = acquireLock(OUT);
  process.once('exit', release);
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => process.exit(code));
  const adapters = loadAdapters(script.adapters);

  const manifestFile = path.join(OUT, 'tts', 'manifest.json');
  const durs = Object.create(null);
  if (!DRY) {
    if (!fs.existsSync(manifestFile)) throw new Error('找不到旁白清单 ' + manifestFile + '，先跑 tts.py');
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (m.voice !== script.voice || m.rate !== script.rate) throw new Error('旁白音色或语速已变化，请按当前脚本重新合成 tts.py。');
    for (const s of script.scenes) {
      if (s.narration && !m.scenes[s.id]) throw new Error('场景 ' + s.id + ' 的旁白还没合成，重跑 tts.py');
      if (s.narration && (m.scenes[s.id].speech !== s.speech || !Number.isFinite(m.scenes[s.id].dur) || m.scenes[s.id].dur <= 0
        || !fs.existsSync(path.resolve(HERE, m.scenes[s.id].file)))) throw new Error('场景 ' + s.id + ' 的旁白来源不匹配；旧清单需重跑 tts.py。');
      durs[s.id] = s.narration ? Math.round(m.scenes[s.id].dur * 1000) : 0;
    }
  }

  fs.mkdirSync(OUT, { recursive: true });
  const report = { title: script.title, mode: DRY ? 'dry' : 'record', stage: STAGE, input: executionHash(script),
    at: new Date().toISOString(), scenes: [], writes: [] };
  const reportFile = path.join(OUT, 'run-report.json');
  const session = { input: report.input, stage: STAGE, scenes: [] };
  const manual = { input: report.input, stage: STAGE, scenes: [] };
  let browser, context, guard, page, video, stopAt, failed;
  const videoDir = path.join(OUT, '_video');
  // 本次执行失败时，不留下可被直接手册入口误用的旧素材。
  fs.rmSync(path.join(MATERIAL_DIR, 'steps.json'), { force: true });
  try {
    const auth = await ensureLoggedIn(asLoginProject(script), { force: !!process.env.REC_RELOGIN, trust: !!process.env.REC_TRUST_AUTH });
    const confirmationStarted = Date.now();
    report.confirmation = await waitForData(script);
    report.confirmationWaitMs = Date.now() - confirmationStarted;
    browser = await chromium.launch({ headless: !HEADED, args: ['--disable-blink-features=AutomationControlled'] });
    fs.rmSync(videoDir, { recursive: true, force: true });
    context = await browser.newContext({ viewport: CFG.viewport, deviceScaleFactor: 1, locale: 'zh-CN', serviceWorkers: 'block',
      recordVideo: DRY ? undefined : { dir: videoDir, size: CFG.viewport },
      ...(auth.storageState ? { storageState: auth.storageState } : {}) });
    guard = await installRequestGuard(context, { readOnlyRequests: script.readOnlyRequests,
      writeRequests: script.safety.writeRequests, approvedWriteRequests: script.safety.approvedWriteRequests, pageUrl: script.url });
    report.writes = guard.writes;
    if (DRY && SHOTS) await context.addInitScript('window.__shotMode = true;');
    await context.addInitScript(CURSOR_OVERLAY);
    page = await context.newPage();
    const ctx = makeCtx(page);
    const t0 = Date.now(), now = () => Date.now() - t0;
    console.log('[' + (DRY ? '演练' : '录制') + '] ' + script.title + '，共 ' + script.scenes.length + ' 个场景');
    await page.goto(script.url, { waitUntil: 'domcontentloaded' });
    if (!DRY) await wait(800);
    guard.assert();
    if (SHOTS) { fs.rmSync(SHOT_DIR, { recursive: true, force: true }); fs.mkdirSync(SHOT_DIR, { recursive: true }); }
  for (const scene of script.scenes) {
    guard.grant([]);
    const start = now();
    const narr = durs[scene.id] || 0;
    const audioAt = start + CFG.lead;
    const entry = { id: scene.id, name: scene.name, status: 'ok', steps: [], notes: [] };
    report.scenes.push(entry);
    console.log('\n■ ' + scene.id + ' ' + (scene.name || '') + (narr ? '（旁白 ' + (narr / 1000).toFixed(1) + 's）' : ''));

    const doc = { id: scene.id, steps: [], result: null };
    manual.scenes.push(doc);

    // 手册的结果截图取最后一次有断言的检查点：收尾是「取消」时停在弹窗还开着的画面，是「提交」时停在成功提示
    const checkpoint = async (expects) => {
      const results = [];
      for (const e of expects) {
        results.push(await checkExpect(ctx, e));
        guard.assert();
        entry.steps.push('expect ' + describeExpect(e));
        console.log('   ✓ 断言  ' + describeExpect(e));
      }
      if (SHOTS && results.length) {
        // 断言在弹窗淡入时就会成立，等动画结束再截
        await wait(400);
        doc.result = { expects: results, shot: await captureResult(page, path.join(SHOT_DIR, scene.id + '-result.png')) };
      }
    };

    try {
      if (!DRY) await wait(scene.timing === 'before' ? CFG.lead + narr + 200 : CFG.lead);

      for (const [i, a] of scene.actions.entries()) {
        if (i === scene.expectAt) await checkpoint(scene.expect);
        if (i >= scene.expectAt && scene.writeMode === 'submit') guard.grant(scene.writeRequests);
        const step = { id: scene.id + '-' + String(i + 1).padStart(2, '0'), op: a.op, label: a.label || '',
          text: a.text, value: a.value, key: a.key, url: a.url, y: a.y };
        doc.steps.push(step);
        if (!DRY && a.cue !== undefined) {
          const due = audioAt + narr * a.cue - CFG.cueLead;
          if (now() < due) await wait(due - now());
        }
        const what = await runAction(ctx, adapters, a, entry.notes, step);
        guard.assert();
        entry.steps.push(a.op + ' ' + what);
        console.log('   ✓ ' + a.op + '  ' + what);
        if (!DRY && a.op !== 'wait') await wait(CFG.stepPause);
      }
      if (scene.expectAt >= scene.actions.length) await checkpoint(scene.expect);
      await checkpoint(scene.endExpect);
      guard.assert();
      guard.grant([]);
      for (const n of entry.notes) console.log('   ⚠ ' + n);
    } catch (err) {
      entry.status = 'failed';
      entry.error = err.message.split('\n')[0];
      entry.failure = await captureFailure(page, scene);
      failed = entry;
      console.error('   ✘ ' + entry.error);
      console.error('     现场截图：' + entry.failure.screenshot);
      break;
    }

    if (!DRY) {
      const minEnd = audioAt + narr + CFG.tail;
      if (now() < minEnd) await wait(minEnd - now());
      await wait(scene.hold);
    }
    session.scenes.push({ id: scene.id, start: start / 1000, audioAt: audioAt / 1000, end: now() / 1000 });
  }

  if (!DRY && !failed) await wait(CFG.tailWait);
  guard.assert(); stopAt = now() / 1000; video = DRY ? null : page.video();
  } catch (error) {
    failed = failed || { id: 'setup', name: '准备与导航', error: error.message.split('\n')[0] };
    if (page && !failed.failure) failed.failure = await captureFailure(page, failed);
  } finally {
    if (guard) guard.close();
    try { if (context) await closeWithin(context.close(), 15000, '浏览器上下文关闭'); }
    catch (error) { failed = failed || { error: error.message }; }
    try { if (browser) await closeWithin(browser.close(), 8000, '浏览器关闭'); }
    catch (error) { failed = failed || { error: error.message }; }
  }
  try {
    if (guard) guard.assert();
    if (report.writes.some((w) => w.outcome === 'unknown')) throw new Error('已有提交请求响应未知，请核对测试数据后重新确认。');
    if (failed) throw new Error(failed.error);
    if (!DRY) {
      const raw = path.join(OUT, 'raw.webm');
      fs.copyFileSync(await video.path(), raw);
      fs.rmSync(videoDir, { recursive: true, force: true });
      const videoDur = probeDuration(raw);
      if (!Number.isFinite(videoDur) || videoDur <= 0) throw new Error('读不到有效视频时长：' + raw);
      const delta = stopAt - videoDur;
      const shift = (t) => Math.round((t - delta) * 1000) / 1000;
      for (const s of session.scenes) {
        // 录制器缺帧时可能只交付一秒占位视频；不能截成零时间并假报完成。
        if (s.start - delta < 0) throw new Error('录制视频未覆盖场景 ' + s.id
          + '（场景起点 ' + s.start.toFixed(3) + 's，运行终点 ' + stopAt.toFixed(3)
          + 's，视频 ' + videoDur.toFixed(3) + 's），请核对录制环境后重录。');
        s.start = shift(s.start); s.audioAt = shift(s.audioAt); s.end = shift(s.end);
        // 各时间保留三位小数，比较允许两次取整合计的 2ms 误差。
        if (s.end + 0.002 < s.audioAt + ((durs[s.id] || 0) + CFG.tail) / 1000) {
          throw new Error('录制视频未覆盖场景 ' + s.id + ' 的完整旁白与留白，请重录。');
        }
      }
      session.duration = videoDur; session.video = path.relative(HERE, raw);
      fs.writeFileSync(path.join(OUT, 'session.json'), JSON.stringify(session, null, 2), 'utf8');
      console.log('\n[完成] ' + session.video + '  时长 ' + videoDur.toFixed(1) + 's');
    }
    if (SHOTS) {
      fs.mkdirSync(MATERIAL_DIR, { recursive: true });
      fs.writeFileSync(path.join(MATERIAL_DIR, 'steps.json'), JSON.stringify(manual, null, 2), 'utf8');
      console.log('[手册素材] ' + path.relative(HERE, MATERIAL_DIR));
    }
    report.ok = true;
    if (DRY) console.log('\n[演练通过] 全部 ' + script.scenes.length + ' 个场景可执行，断言成立。');
  } catch (error) { report.ok = false; report.failure = failed || { error: error.message }; }
  if (!report.ok && report.writes.length) {
    report.recovery = '已有提交请求发出，数据可能已改变；核对响应和测试数据、复位或换用独立数据后，重新运行并确认。不会自动回滚。';
    console.error(report.recovery);
  }
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
  if (!report.ok) console.error('[失败] ' + report.failure.error + '；详情：output/run-report.json');
  process.exit(report.ok ? 0 : 2);
}

main().catch((e) => {
  console.error('[致命错误] ' + e.message);
  process.exit(1);
});
