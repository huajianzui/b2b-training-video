'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 共用 output 的所有 Node 写入口互斥；produce 可把锁归属委托给自己的子进程。
function acquireLock(out) {
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, '.produce.lock');
  if (fs.existsSync(file)) {
    let owner;
    try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new Error('流水线锁损坏，请检查 output/.produce.lock；未自动覆盖。'); }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !owner.token) throw new Error('流水线锁的归属无效，未自动覆盖。');
    try { process.kill(owner.pid, 0); }
    catch (error) {
      throw new Error(error.code === 'ESRCH'
        ? 'output/.produce.lock 的进程已退出；确认没有其他任务使用 output 后，手动移除这一个锁文件再运行。'
        : '无法验证现有流水线进程，已拒绝并行出片。');
    }
    if (process.ppid === owner.pid && process.env.TRAINING_LOCK_TOKEN === owner.token && Number(process.env.TRAINING_LOCK_PID) === owner.pid) return () => {};
    throw new Error('已有流水线使用 output，请等待完成后再运行。');
  }
  if (process.env.TRAINING_LOCK_TOKEN) throw new Error('父流水线的锁已失效，拒绝写入共用 output。');
  const token = crypto.randomBytes(32).toString('hex');
  let fd;
  try { fd = fs.openSync(file, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('已有流水线使用 output，请等待完成后再运行。'); throw error; }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(fd); }
  const release = () => {
    if (!fs.existsSync(file)) return;
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (owner.pid === process.pid && owner.token === token) fs.unlinkSync(file);
  };
  release.env = { TRAINING_LOCK_TOKEN: token, TRAINING_LOCK_PID: String(process.pid) };
  return release;
}

module.exports = { acquireLock };
