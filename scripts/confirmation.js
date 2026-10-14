'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { executionHash } = require('./requests');
const OUT = path.join(__dirname, 'output');
const WAIT_FILE = path.join(OUT, 'data-wait.json');
const GO_FILE = path.join(OUT, 'data-go.json');

function readDataWait() {
  if (!fs.existsSync(WAIT_FILE)) return null;
  const value = JSON.parse(fs.readFileSync(WAIT_FILE, 'utf8'));
  if (!Number.isInteger(value.pid) || value.pid <= 0 || !/^[a-f0-9]{64}$/.test(value.runId || '')
    || !['rehearsal', 'record'].includes(value.stage) || !/^[a-f0-9]{64}$/.test(value.input || '')) return null;
  try { process.kill(value.pid, 0); } catch { return null; }
  return value;
}

function confirmData({ runId, input, stage, cancel = false } = {}) {
  const current = readDataWait();
  if (!current || current.runId !== runId || current.input !== input || current.stage !== stage) throw new Error('本轮提交确认已失效，请刷新后查看当前等待的环境和阶段。');
  if (fs.existsSync(GO_FILE)) throw new Error('本轮已经确认或取消，请等待执行器处理。');
  if (!cancel && executionHash(currentScript(current)) !== current.input) throw new Error('脚本或功能选择已经变化，请停止并重新运行后确认。');
  fs.writeFileSync(GO_FILE, JSON.stringify({ runId, input, stage, cancel: !!cancel }), { flag: 'wx' });
  return current;
}

function currentScript(current) {
  const script = require('./script').loadScript(current.source, { stage: current.stage });
  script.scenes = script.scenes.filter((s) => current.sceneIds.includes(s.id));
  return script;
}

async function waitForData(script) {
  const scenes = script.scenes.filter((s) => s.writeMode === 'submit' || s.actions.some(a => a.prepare));
  if (!scenes.length) return;
  if (!script.safety.environment.testData) throw new Error('当前环境未获准写入测试数据，不能提交。');
  const current = { runId: crypto.randomBytes(32).toString('hex'), pid: process.pid,
    stage: script.executionStage, input: executionHash(script), source: script.source,
    title: script.title, url: script.url, environment: script.safety.environment.name, sceneIds: script.scenes.map((s) => s.id),
    features: script.safety.writes.filter((f) => (f.mode === 'submit' || f.preparation) && scenes.some((s) => s.feature.includes(f.id))),
    at: new Date().toISOString() };
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(GO_FILE, { force: true });
  fs.writeFileSync(WAIT_FILE, JSON.stringify(current, null, 2), 'utf8');
  const cleanup = () => {
    if (fs.existsSync(WAIT_FILE) && JSON.parse(fs.readFileSync(WAIT_FILE, 'utf8')).runId === current.runId) fs.rmSync(WAIT_FILE);
    // 保留本轮决定到下一轮启动，拒绝已读到旧 WAIT 的并发确认请求。
  };
  process.once('exit', cleanup);
  const autoApprove = process.env.TRAINING_VIDEO_AUTO_APPROVE === '1'
    || process.argv.includes('--yes')
    || process.argv.includes('--auto-approve');
  if (autoApprove) {
    try {
      console.log('[自动放行] 已启用免打扰自动批准模式，直接放行本轮写入：' + current.stage);
      return confirmData({ runId: current.runId, input: current.input, stage: current.stage });
    } finally { cleanup(); process.removeListener('exit', cleanup); }
  }
  console.log('[待确认] ' + (current.stage === 'rehearsal' ? '演练' : '正式录制') + '将真实提交：'
    + current.features.map((f) => f.name + (f.preparation ? '（准备写入：' + f.preparation + '）' : '')).join('、') + '\n  环境：' + current.environment + ' ' + current.url
    + '\n  请在本地确认页核对：数据已复位或本轮使用独立测试数据，再允许这一轮提交。');
  try {
    for (;;) {
      if (fs.existsSync(GO_FILE)) {
        const decision = JSON.parse(fs.readFileSync(GO_FILE, 'utf8'));
        if (decision.runId !== current.runId || decision.input !== current.input || decision.stage !== current.stage) throw new Error('收到过期的提交确认，请重新运行。');
        if (decision.cancel) throw new Error('用户取消了本轮提交，已停止。');
        if (executionHash(currentScript(current)) !== current.input) throw new Error('等待期间脚本或功能选择变化，已停止；请重新运行再确认。');
        return current;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  } finally { cleanup(); process.removeListener('exit', cleanup); }
}

module.exports = { readDataWait, confirmData, waitForData, WAIT_FILE, GO_FILE };
