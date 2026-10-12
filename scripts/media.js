const { spawnSync } = require('child_process');
const { ffmpegPath } = require('./deps');

/** 读媒体时长（秒）。ffmpeg-static 不含 ffprobe，从 ffmpeg -i 的输出里解析 */
function probeDuration(file) {
  // 必须显式传 stdio 数组：本机 node 的 spawnSync 不带它时一律 EBUSY
  const r = spawnSync(ffmpegPath(), ['-i', file], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(String(r.stderr || '') + String(r.stdout || ''));
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
}

module.exports = { probeDuration };
