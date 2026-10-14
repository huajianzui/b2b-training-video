'use strict';
const CLI = require.main === module ? require('./cli').readCli({
  usage: '用法：node preflight.js [--online]\n检查本机依赖、浏览器录屏、中文字幕与媒体解码；--online 另向微软发送固定测试句。',
  options: { online: { type: 'boolean' } }, maxPositionals: 0
}) : null;
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
const { requireFrom, ffmpegPath } = require('./deps');

function findPython() {
  const candidates = [[process.env.PYTHON], ['py', '-3'], ['python3'], ['python']].filter(([cmd]) => cmd);
  for (const [cmd, ...pre] of candidates) {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys,edge_tts,PIL;assert sys.version_info.major==3;print(sys.executable)'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    if (process.env.PYTHON && cmd === process.env.PYTHON) break;
  }
  throw new Error('所选 Python 3 或 edge-tts/Pillow 不可用；配置 PYTHON，并在该环境安装 requirements.txt。');
}

function ensureFonts() {
  const dir = path.join(__dirname, 'assets'), sys = path.join(process.env.WINDIR || 'C:/Windows', 'Fonts');
  for (const name of ['msyh.ttc', 'msyhbd.ttc']) {
    const target = path.join(dir, name);
    if (fs.existsSync(target)) continue;
    if (!fs.existsSync(path.join(sys, name))) throw new Error('缺少中文字体 assets/' + name + '，请准备可用的中文字体后重试。');
    fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(path.join(sys, name), target);
  }
}

async function preflight({ media = true, browser = true, online = false, python } = {}) {
  requireFrom('yaml'); requireFrom('docx');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'training-preflight-'));
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: temp, encoding: 'utf8', env: { ...process.env, FFMPEG: ffmpegPath(), PYTHONIOENCODING: 'utf-8' } });
    if (result.status !== 0) throw new Error('前置检查失败：' + path.basename(command) + '；' + (result.error?.message || (result.stderr || result.stdout).split(/\r?\n/).slice(-5).join('\n')));
  };
  let instance;
  try {
    if (media) { python ||= findPython(); ensureFonts(); }
    let video;
    if (browser) {
      instance = await requireFrom('playwright').chromium.launch({ headless: true });
      const context = await instance.newContext({ ...(media ? { recordVideo: { dir: temp, size: { width: 320, height: 180 } } } : {}) });
      const page = await context.newPage(); await page.setContent('<meta charset="utf-8"><p>培训视频准备检查</p>');
      if (media) { await page.waitForTimeout(400); video = page.video(); }
      await context.close(); await instance.close(); instance = null;
    }
    if (media) {
      fs.copyFileSync(path.join(__dirname, 'assets/msyh.ttc'), path.join(temp, 'font.ttc'));
      fs.writeFileSync(path.join(temp, 'probe.srt'), '1\n00:00:00,000 --> 00:00:00,200\n中文检查\n');
      const source = video ? ['-i', await video.path()] : ['-f', 'lavfi', '-i', 'color=s=320x180:r=25'];
      run(ffmpegPath(), ['-nostdin', '-v', 'error', ...source, '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono',
        '-t', '0.2', '-vf', 'subtitles=probe.srt:fontsdir=.', '-c:v', 'libx264', '-c:a', 'aac', 'probe.mp4']);
      run(ffmpegPath(), ['-nostdin', '-v', 'error', '-xerror', '-i', 'probe.mp4', '-f', 'null', '-']);
    }
    if (online) run(python || findPython(), [path.join(__dirname, 'tts.py'), '--probe', path.join(temp, 'probe.mp3')]);
    console.log('[前置检查通过] ' + (media ? '依赖、中文字幕与媒体解码' : '浏览器') + (online ? '、在线语音' : '；未请求在线语音'));
  } finally {
    try { if (instance) await instance.close(); } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
}
module.exports = { preflight, findPython, ensureFonts };
if (CLI) preflight({ online: CLI.values.online }).catch(error => { console.error(error.message); process.exitCode = 2; });
