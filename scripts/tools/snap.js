#!/usr/bin/env node
/**
 * 页面快照：复用已保存的登录态，按步骤操作页面，在指定时刻保存截图 + 无障碍结构 + 当前地址
 * 写演示脚本前用来看清真实页面（以后 AI 探索页面也用它）
 *
 * 用法：
 *   node tools/snap.js <登录态文件> <步骤文件.json>
 *   node tools/snap.js - <步骤文件.json>        还没有登录态时（如查看登录页），登录态文件写 -
 *   node tools/snap.js <登录态文件> <网址> [快照名]   只看一页时不用写步骤文件
 *
 * 步骤文件：数组，每项一个动作，选择器用 Playwright 字符串写法
 *   ["goto", "http://localhost:5174/orders"]
 *   ["click", "tr:has-text('SO-20261008-002') >> role=button[name='详情']"]
 *   ["fill", "role=textbox[name='订单号']", "SO-001"]
 *   ["press", "Escape"]
 *   ["wait", 1500]
 *   ["snap", "detail"]                     存 output/_snap/detail.png / .aria.yaml，并打印当前地址
 *   ["parallel", [["list", "http://.../list"], ["detail", "http://.../detail"]]]  同会话多标签页并行拍多页快照
 *   ["eval", "document.title"]             在页面里求值并打印结果
 * 产物：output/_snap/
 */

const fs = require('fs');
const path = require('path');
const { requireFrom } = require('../deps');
const { chromium } = requireFrom('playwright');

const USAGE = '用法：node tools/snap.js <登录态文件|-> <步骤文件.json>\n'
  + '      node tools/snap.js <登录态文件|-> <网址> [快照名]   只打开一页拍快照（快照名默认 page）';
const [authFile, target, snapName] = process.argv.slice(2);
const OUT = path.join(__dirname, '..', 'output', '_snap');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

async function smartGoto(p, url) {
  await p.goto(url, { waitUntil: 'domcontentloaded' });
  await p.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
}

async function captureSnap(p, name) {
  await p.waitForTimeout(250);
  const [, aria] = await Promise.all([
    p.screenshot({ path: path.join(OUT, name + '.png') }),
    p.locator('body').ariaSnapshot(),
  ]);
  fs.writeFileSync(path.join(OUT, name + '.aria.yaml'), aria, 'utf8');
  console.log('[snap] ' + name + '  ' + p.url());
}

(async () => {
  if (!authFile || !target) throw new Error(USAGE);
  const steps = /^(?:https?|file):\/\//.test(target)
    ? [['goto', target], ['snap', snapName || 'page']]
    : JSON.parse(fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, ''));
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  // 还没登录过（看登录页本身）时传 - 表示空登录态
  const storageState = authFile === '-' ? undefined : authFile;
  const context = await browser.newContext({ storageState, viewport: { width: 1920, height: 1080 }, locale: 'zh-CN' });
  const page = await context.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));

  for (const [i, [op, a, b]] of steps.entries()) {
    const where = '第 ' + (i + 1) + ' 步 ' + op + ' ' + (typeof a === 'string' ? a : '');
    try {
      if (op === 'goto') await smartGoto(page, a);
      else if (op === 'click') await page.locator(a).filter({ visible: true }).first().click({ timeout: 8000 });
      else if (op === 'fill') await page.locator(a).filter({ visible: true }).first().fill(String(b), { timeout: 8000 });
      else if (op === 'press') await page.keyboard.press(a);
      else if (op === 'wait') await page.waitForTimeout(Number(a) || 1000);
      else if (op === 'eval') console.log('[eval] ' + JSON.stringify(await page.evaluate(a)));
      else if (op === 'snap') await captureSnap(page, a);
      else if (op === 'parallel' && Array.isArray(a)) {
        await Promise.all(a.map(async ([name, url]) => {
          const tab = await context.newPage();
          tab.on('dialog', (d) => d.dismiss().catch(() => {}));
          try {
            await smartGoto(tab, url);
            await captureSnap(tab, name);
          } finally {
            await tab.close().catch(() => {});
          }
        }));
      } else throw new Error('不认识的动作');
      if (op === 'click' || op === 'goto') await page.waitForTimeout(350);
    } catch (e) {
      console.error('[失败] ' + where + '：' + e.message.split('\n')[0]);
      await page.screenshot({ path: path.join(OUT, '_fail.png') }).catch(() => {});
      fs.writeFileSync(path.join(OUT, '_fail.aria.yaml'), await page.locator('body').ariaSnapshot().catch(() => ''), 'utf8');
      process.exitCode = 1;
      break;
    }
  }
  await browser.close();
})().catch((e) => {
  console.error('[快照失败] ' + e.message);
  process.exit(1);
});
