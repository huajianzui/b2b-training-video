#!/usr/bin/env node
'use strict';
const { values } = require('./cli').readCli({
  usage: '用法：node test-runner.js [--allow-skips]\n'
    + '  默认执行完整验收，有失败或跳过均返回非零；--allow-skips 仅用于部分回归。',
  options: { 'allow-skips': { type: 'boolean' } }, maxPositionals: 0
});
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const directory = path.join(__dirname, 'tests');
const files = fs.existsSync(directory)
  ? fs.readdirSync(directory).filter(name => name.endsWith('.test.js')).sort().map(name => path.join(directory, name)) : [];
if (!files.length) {
  console.error('[验收未运行] 没有测试文件；请在仓库 scripts 目录安装依赖后运行 npm test。');
  process.exit(2);
}
const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], {
  cwd: __dirname, env: process.env, stdio: ['ignore', 'pipe', 'inherit']
});
const summary = {};
let pending = '';
function consume(line) {
  const match = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(line);
  if (match) summary[match[1]] = Number(match[2]);
}
child.stdout.on('data', chunk => {
  process.stdout.write(chunk);
  pending += chunk.toString();
  let newline;
  while ((newline = pending.indexOf('\n')) >= 0) {
    consume(pending.slice(0, newline)); pending = pending.slice(newline + 1);
  }
});
child.on('error', error => { console.error('[验收未运行] ' + error.message); process.exitCode = 2; });
child.on('close', (code, signal) => {
  if (pending) consume(pending);
  if (signal || code !== 0 || summary.fail || summary.cancelled) {
    console.error('[验收未通过] 测试进程失败或中止。'); process.exitCode = 1; return;
  }
  if (!['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].every(key => Number.isInteger(summary[key])) || !summary.tests) {
    console.error('[验收未通过] 缺少有效测试汇总，不能确认验收完成。'); process.exitCode = 2; return;
  }
  if (summary.todo) {
    console.error('[验收未通过] ' + summary.todo + ' 项待完成（TODO）；请完成回归断言后重新验收。');
    process.exitCode = 2; return;
  }
  if (summary.skipped && !values['allow-skips']) {
    console.error('[完整验收未通过] ' + summary.skipped + ' 项跳过。请按上方跳过原因配置 TEST_BROWSER_PATH、PYTHON 及 Playwright FFmpeg，再运行 npm test。');
    console.error('只需部分检查时显式运行 npm run test:quick；部分检查不代表集成验收通过。');
    process.exitCode = 2; return;
  }
  console.log(summary.skipped
    ? '[部分回归通过] ' + summary.pass + ' 项通过，' + summary.skipped + ' 项跳过；集成验收未完成。'
    : '[完整验收通过] ' + summary.pass + ' 项通过，0 失败、0 跳过。');
});
