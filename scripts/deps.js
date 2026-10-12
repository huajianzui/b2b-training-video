/**
 * 依赖解析 —— 依赖默认装在本目录（npm install）；
 * 想共用别处已装好的依赖时，用环境变量 PW_WORKSPACE 指向含 node_modules 的目录。
 */

const path = require('path');

const WORKSPACE = process.env.PW_WORKSPACE || '';

function requireFrom(name) {
  const candidates = [name].concat(WORKSPACE ? [path.join(WORKSPACE, 'node_modules', name)] : []);
  const tried = [];
  for (const c of candidates) {
    try {
      return require(c);
    } catch (e) {
      tried.push(c);
    }
  }
  throw new Error(
    '找不到依赖「' + name + '」。\n' +
    '  试过：' + tried.join('、') + '\n' +
    '  修复：在 ' + __dirname + ' 下运行 npm install（之后 npx playwright install chromium）'
  );
}

function ffmpegPath() {
  // 顺序：环境变量 FFMPEG → npm 装的 ffmpeg-static（本目录或 PW_WORKSPACE）→ 系统 PATH 上的 ffmpeg
  const fs = require('fs');
  if (process.env.FFMPEG) return process.env.FFMPEG;
  try {
    const bundled = requireFrom('ffmpeg-static');
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch (e) { /* 没装就用 PATH 上的 */ }
  return 'ffmpeg';
}

module.exports = { requireFrom, ffmpegPath, WORKSPACE };
