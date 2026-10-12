#!/usr/bin/env node
/**
 * 一键出片（新流水线）—— 以 script.yaml 为唯一输入
 *
 *   校验脚本 → 准备登录态 → 演练 → 合成旁白 → 录制并截取正式手册素材
 *     → 生成正式手册 → 后期（字幕 + 音轨）→ 元数据校验 → 片头片尾
 *
 * 用法：
 *   node produce.js [script.yaml]          完整出片（视频 + 手册）
 *   node produce.js --dry                  只校验 + 演练 + 出手册，不录制
 *   node produce.js --no-manual            不生成手册
 *   node produce.js --from compose         从某一环节开始（script / login / check / tts / record / manual / compose / verify / cards）
 *   node produce.js --skip-check           跳过演练
 *   node produce.js --relogin / --no-login
 *   node produce.js --no-cards             不加片头片尾
 *   node produce.js --headed               录制时弹出浏览器窗口
 *   node produce.js --bgm music.mp3
 *   node produce.js --allow-uncovered      功能清单里有勾选了但还没写场景的功能时，仍先出已有部分
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadScript, asLoginProject, DEFAULT_OUT: SCRIPT_JSON } = require('./script');
const { ensureLoggedIn } = require('./login');
const { ffmpegPath } = require('./deps');
const { STEPS, openPipeline, acquireLock, manualArtifacts } = require('./pipeline');
const { executionHash } = require('./requests');

const HERE = __dirname;
const OUT = path.join(HERE, 'output');
const NODE = process.execPath;
// 很多 Windows 机器上 python 指向 2.x，或有多个 3.x 只有一个装了 edge-tts：挑第一个能用的，换成它的真实路径
function findPython() {
  const candidates = [[process.env.PYTHON], ['py', '-3'], ['python3'], ['python']].filter(([cmd]) => cmd);
  const probe = 'import sys;print(sys.version_info[0]);print(sys.executable);import edge_tts';
  let bare = '';
  for (const [cmd, ...pre] of candidates) {
    const r = spawnSync(cmd, [...pre, '-c', probe], { encoding: 'utf8' });
    const [major, exe] = (r.stdout || '').trim().split(/\r?\n/);
    if (Number(major) < 3 || !exe) continue;
    if (r.status === 0) return exe.trim();
    bare = bare || exe.trim();
  }
  console.error(bare
    ? '[produce] Python 3（' + bare + '）没有装 edge-tts：运行 "' + bare + '" -m pip install -r requirements.txt'
    : '[produce] 找不到 Python 3（试过 PYTHON 环境变量、py -3、python3、python）。装好后重试，或设置 PYTHON 指向 python.exe。');
  process.exit(1);
}

// 字幕和片头片尾用 assets/ 下的微软雅黑；没有就从 Windows 字体目录复制
const FONTS = ['msyh.ttc', 'msyhbd.ttc'];
function ensureFonts() {
  const dir = path.join(HERE, 'assets');
  const sys = path.join(process.env.WINDIR || 'C:/Windows', 'Fonts');
  for (const f of FONTS) {
    const dst = path.join(dir, f);
    if (fs.existsSync(dst)) continue;
    if (!fs.existsSync(path.join(sys, f))) {
      fail('缺少字体 assets/' + f + '：把任一中文字体（如 Noto Sans CJK）复制到 ' + dir + ' 并改名为 ' + FONTS.join('、'));
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(sys, f), dst);
    console.log('[produce] 已从系统字体目录复制 ' + f + ' 到 assets/');
  }
}
let pyExe;
const PY = () => (pyExe = pyExe || findPython());

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const val = (n) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const VALUED = new Set(['--from', '--bgm']);
const scriptArg = argv.find((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));
const SCRIPT_FILE = path.resolve(HERE, scriptArg || 'script.yaml');

const MANUAL = !has('no-manual');
const FROM = val('from') || 'script';
if (!STEPS.includes(FROM)) fail('未知环节：' + FROM + '（可选：' + STEPS.join(' / ') + '）');
const should = (s) => STEPS.indexOf(s) >= STEPS.indexOf(FROM);
const tag = (s) => (STEPS.indexOf(s) + 1) + '/' + STEPS.length;

function fail(msg) {
  console.error('\n' + msg);
  process.exit(2);
}

function run(label, cmd, args, env) {
  console.log('\n==================== ' + label + ' ====================');
  const r = spawnSync(cmd, args, {
    cwd: HERE,
    stdio: 'inherit',
    env: Object.assign({}, process.env, {
      PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', FFMPEG: ffmpegPath(), NODE_EXE: NODE,
    }, env || {}),
  });
  if (r.error) fail('无法启动：' + r.error.message);
  return r.status;
}

if (Number(process.versions.node.split('.')[0]) < 20) {
  fail('需要 Node 20 或更高版本，当前是 ' + process.version + '。请升级 Node 后重新 npm install。');
}

(async () => {
  let script, rehearsalScript;
  // 续跑也必须重新解析指定 YAML；旧 JSON 不能替代确认和脚本校验。
  {
    console.log('\n==================== ' + tag('script') + '  校验脚本 ====================');
    try {
      script = loadScript(SCRIPT_FILE);
      rehearsalScript = loadScript(SCRIPT_FILE, { stage: 'rehearsal' });
    } catch (e) {
      if (e.code === 'UNCONFIRMED') {
        fail('[待确认] ' + e.message + '\n  确认页：node app/server.js 后打开 http://127.0.0.1:7788/features?f='
          + encodeURIComponent(path.relative(HERE, e.featuresFile)));
      }
      fail('[脚本错误] ' + e.message);
    }
    console.log(path.relative(HERE, SCRIPT_FILE) + '：' + script.scenes.length + ' 个场景，'
      + script.scenes.reduce((n, s) => n + s.actions.length, 0) + ' 个动作');
    if (script.pronounceHints.length) {
      console.log('⚠ 旁白里这些词含易错多音字，出片后请抽听；读错的加到 pronounce，读对的加到 pronounceChecked：\n    '
        + script.pronounceHints.join('\n    '));
    }
    if (script.features) {
      const miss = script.features.uncovered;
      console.log('功能清单：' + path.basename(script.features.file) + '（确认于 ' + script.features.confirmedAt + '）');
      if (miss.length) {
        const list = miss.map((f) => '    · ' + f.name + '（' + f.id + '）').join('\n');
        if (!has('allow-uncovered')) fail('以下功能已勾选，但脚本里还没有对应场景：\n' + list + '\n  补写场景，或加 --allow-uncovered 先出已有部分');
        console.log('⚠ 以下已勾选功能没有场景，本次不会出现在视频和手册里：\n' + list);
      }
      const dup = script.features.sharedIncluded;
      if (dup.length) {
        console.log('⚠ 以下通用操作仍单独演示，可能和《' + script.sharedGuide + '》重复；确需单独讲可忽略：\n'
          + dup.map((f) => '    · ' + f.name + '（通用·' + f.shared + '）').join('\n'));
      }
    }
  }

  const release = acquireLock(OUT);
  process.once('exit', release);
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => process.exit(code));
  const pipeline = openPipeline(OUT, script, FROM, { manual: MANUAL, skipCheck: has('skip-check') });
  fs.writeFileSync(SCRIPT_JSON, JSON.stringify(script, null, 2), 'utf8');

  const env = { ...release.env };
  if (has('no-login')) {
    env.REC_NO_LOGIN = '1';
  } else if (should('login')) {
    console.log('\n==================== ' + tag('login') + '  准备登录态（录制前完成，不会录进视频） ====================');
    try {
      const r = await ensureLoggedIn(asLoginProject(script), { force: has('relogin') || pipeline.authChanged });
      console.log(r.enabled ? '登录态就绪：' + path.relative(HERE, r.storagePath) : '本脚本不需要登录');
    } catch (e) {
      fail('登录没有完成，已中止：' + e.message);
    }
    env.REC_TRUST_AUTH = '1';
  }
  if (!should('login') && (has('relogin') || pipeline.authChanged)) env.REC_RELOGIN = '1';

  if (should('check') && !has('skip-check')) {
    const args = [path.join(HERE, 'play.js'), SCRIPT_FILE, '--dry'];
    if (MANUAL && has('dry')) args.push('--shots');
    const code = run(tag('check') + '  演练（按已确认的演练方式验证每一步与断言）', NODE, args, env);
    if (code !== 0) fail('演练未通过，已中止 —— 现场截图与页面结构见 output/run-report.json');
    const report = JSON.parse(fs.readFileSync(path.join(OUT, 'run-report.json'), 'utf8'));
    if (!report.ok || report.input !== executionHash(rehearsalScript)) fail('演练来源已变化，请重新开始。');
    fs.copyFileSync(path.join(OUT, 'run-report.json'), path.join(OUT, 'check-report.json'));
    pipeline.complete('check', ['check-report.json', ...(MANUAL && has('dry') ? manualArtifacts(OUT, 'rehearsal') : [])]);
  }

  if (has('dry')) {
    if (MANUAL && should('check') && !has('skip-check')) {
      pipeline.requireStage('check', ['manual/rehearsal/steps.json']);
      if (run('生成演练手册（Word）', NODE, [path.join(HERE, 'manual.js'), SCRIPT_FILE, '--rehearsal'], env) !== 0) fail('演练手册生成失败。');
      pipeline.complete('rehearsalManual', [script.manual.title.replace(/[\\/:*?"<>|]/g, '_').trim() + '（演练）.docx']);
    }
    console.log('\n（--dry：到此为止，未执行旁白与正式录制环节。去掉 --dry 正式出片。）');
    process.exit(0);
  }

  if (should('tts') && run(tag('tts') + '  合成旁白（先于录制，决定每个场景的时长）', PY(), [path.join(HERE, 'tts.py')]) !== 0) {
    fail('旁白合成失败。');
  }
  if (should('tts')) {
    const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'tts', 'manifest.json'), 'utf8'));
    const clips = Object.values(manifest.scenes).map((m) => path.relative(OUT, path.resolve(HERE, m.file)));
    pipeline.complete('tts', ['tts/manifest.json', ...clips]);
  }

  if (should('record')) {
    const args = [path.join(HERE, 'play.js'), SCRIPT_FILE];
    if (MANUAL) args.push('--shots');
    if (has('headed')) args.push('--headed');
    if (run(tag('record') + '  按旁白节奏录制', NODE, args, env) !== 0) fail('录制失败，详情见 output/run-report.json');
    const report = JSON.parse(fs.readFileSync(path.join(OUT, 'run-report.json'), 'utf8'));
    if (!report.ok || report.input !== executionHash(script)) fail('录制来源已变化，请重新开始。');
    pipeline.complete('record', ['raw.webm', 'session.json', 'run-report.json', ...(MANUAL ? manualArtifacts(OUT, 'record') : [])]);
  }

  if (should('manual') && MANUAL) {
    pipeline.requireStage('record', ['manual/record/steps.json']);
    if (run(tag('manual') + '  生成正式操作手册（Word）', NODE, [path.join(HERE, 'manual.js'), SCRIPT_FILE], env) !== 0) fail('手册生成失败。');
    pipeline.complete('manual', [script.manual.title.replace(/[\\/:*?"<>|]/g, '_').trim() + '.docx']);
  }

  if (should('compose') || should('cards')) ensureFonts();
  if (should('compose')) {
    const args = [path.join(HERE, 'compose.py')];
    if (val('bgm')) args.push('--bgm', path.resolve(HERE, val('bgm')));
    if (run(tag('compose') + '  后期：烧录字幕 + 旁白音轨', PY(), args) !== 0) fail('后期合成失败。');
    pipeline.complete('compose', ['demo-voiced.mp4', 'subs.srt']);
  }

  const voiced = path.join(OUT, 'demo-voiced.mp4');
  const withCards = should('cards') && !has('no-cards') && (script.intro || script.outro);
  const verifyMedia = (file) => run(tag('verify') + '  验收媒体（元数据与实际解码）', NODE,
    [path.join(HERE, 'tools', 'mp4info.js'), file, '--require-audio', '--decode']) === 0;
  let final = voiced;
  let finalSrt = path.join(OUT, 'subs.srt');
  if (withCards) {
    if (!verifyMedia(voiced)) fail('正片媒体校验未通过，不能交付。');
    const cardsFile = path.join(OUT, 'cards.gen.json');
    fs.writeFileSync(cardsFile, JSON.stringify({
      voice: script.voice,
      rate: script.rate,
      watermark: script.watermark,
      ...(script.intro ? { intro: script.intro } : {}),
      ...(script.outro ? { outro: script.outro } : {}),
    }, null, 2), 'utf8');
    const out = path.join(OUT, 'demo-final.mp4');
    finalSrt = path.join(OUT, 'subs-final.srt');
    fs.rmSync(finalSrt, { force: true });
    const NOT_A_STEP = new Set(['goto', 'wait', 'hover']);
    const steps = script.scenes.reduce((n, s) => n + s.actions.filter((a) => !NOT_A_STEP.has(a.op)).length, 0);
    const narrated = script.scenes.filter((s) => s.narration).length;
    const code = run(tag('cards') + '  片头片尾', PY(), [path.join(HERE, 'intro.py'), '--config', cardsFile,
      '--attach', voiced, '--out', out, '--steps', String(steps), '--captions', String(narrated),
      '--srt-input', path.join(OUT, 'subs.srt'), '--srt-output', finalSrt]);
    if (code !== 0) fail('片头片尾生成或验收失败，已中止交付。');
    final = out;
  }

  if (!verifyMedia(final)) fail('最终媒体校验未通过，不能交付。');
  if (!fs.existsSync(finalSrt)) fail('成品字幕缺失，不能交付。');
  const named = path.join(OUT, script.title.replace(/[\\/:*?"<>|]/g, '_').trim() + '.mp4');
  const namedSrt = named.replace(/\.mp4$/, '.srt');
  const protectedNames = new Set(['demo-voiced.mp4', 'demo-final.mp4', 'demo-silent.mp4', 'intro-card.mp4', 'outro-card.mp4', 'subs.srt', 'subs-final.srt']);
  if ([named, namedSrt].some((f) => protectedNames.has(path.basename(f).toLowerCase()))) fail('标题与内部产物文件名冲突，请更换视频标题后重跑。');
  fs.copyFileSync(final, named);
  fs.copyFileSync(finalSrt, namedSrt);
  const mb = (fs.statSync(named).size / 1024 / 1024).toFixed(2);
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  完成                                                ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('  成品：' + path.relative(HERE, named) + '（' + mb + ' MB）');
  console.log('  字幕：' + path.relative(HERE, namedSrt));
  if (MANUAL) console.log('  手册：output/' + script.manual.title.replace(/[\\/:*?"<>|]/g, '_').trim() + '.docx');
  console.log('  报告：output/run-report.json');
})().catch((e) => fail('[致命错误] ' + e.message));
