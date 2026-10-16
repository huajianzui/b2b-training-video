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

const argv = process.argv.slice(2);
const VALUED = new Set(['--from', '--bgm']);
const SWITCHES = new Set(['--dry', '--post', '--no-manual', '--skip-check', '--skip-trial', '--allow-trial-failure', '--relogin', '--no-login', '--no-cards', '--headed', '--allow-uncovered']);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`用法：node produce.js [script.yaml] [选项]
  --dry                 只校验、演练及生成演练手册
  --post                纯后期：只更正文案/配音/手册，不登录、演练或重录
  --from <环节>         从 script / login / check / tts / record / manual / compose / verify / cards 开始
  --bgm <音频文件>      合成背景音乐；变化后从 compose 重跑
  --no-manual           不生成手册
  --no-cards            不加片头片尾
  --no-login / --relogin 跳过登录 / 重新登录
  --skip-check          跳过演练，仍需独立提交确认
  --skip-trial          跳过提交路径试跑（演练走取消分支、测不到提交分支时才用）
  --allow-trial-failure 试跑未通过仍继续录制（默认中止）
  --headed              显示录制浏览器
  --allow-uncovered     调试时允许清单部分功能未写场景
  --help / -h           显示帮助，不执行任务`);
  process.exit(0);
}
let scriptArg;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (VALUED.has(arg)) {
    if (!argv[i + 1] || argv[i + 1].startsWith('-')) fail(arg + ' 缺少参数；使用 --help 查看用法。');
    i++;
  } else if (SWITCHES.has(arg)) continue;
  else if (arg.startsWith('-')) fail('未知选项：' + arg + '；使用 --help 查看用法。');
  else if (scriptArg !== undefined) fail('只能指定一份演示脚本。');
  else scriptArg = arg;
}

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadScript, asLoginProject, DEFAULT_OUT: SCRIPT_JSON } = require('./script');
const { ensureLoggedIn } = require('./login');
const { ffmpegPath } = require('./deps');
const { STEPS, openPipeline, acquireLock, manualArtifacts, checkAudioWindows } = require('./pipeline');
const { executionHash } = require('./requests');

const HERE = __dirname;
const OUT = path.join(HERE, 'output');
const NODE = process.execPath;
const { preflight, findPython, ensureFonts } = require('./preflight');
let pyExe;
const PY = () => (pyExe = pyExe || findPython());

const has = (f) => argv.includes('--' + f);
const val = (n) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const SCRIPT_FILE = path.resolve(HERE, scriptArg || 'script.yaml');
const BGM = val('bgm') ? path.resolve(HERE, val('bgm')) : null;

const MANUAL = !has('no-manual');
if (has('post') && ['dry', 'relogin', 'headed', 'skip-check', 'allow-uncovered'].some(has) || has('post') && val('from')) fail('--post 不能与演练/录制或 --from 选项混用。');
const FROM = has('post') ? 'tts' : val('from') || 'script';
if (!STEPS.includes(FROM)) fail('未知环节：' + FROM + '（可选：' + STEPS.join(' / ') + '）');
const should = (s) => STEPS.indexOf(s) >= STEPS.indexOf(FROM);
const tag = (s) => (STEPS.indexOf(s) + 1) + '/' + STEPS.length;

function fail(msg) {
  console.error('\n' + msg);
  process.exit(2);
}

function run(label, cmd, args, env) {
  const started = Date.now();
  console.log('\n==================== ' + label + ' ====================');
  const r = spawnSync(cmd, args, {
    cwd: HERE,
    stdio: 'inherit',
    env: Object.assign({}, process.env, {
      PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', FFMPEG: ffmpegPath(), NODE_EXE: NODE,
    }, env || {}),
  });
  if (r.error) fail('无法启动：' + r.error.message);
  fs.appendFileSync(path.join(OUT, 'timing.jsonl'), JSON.stringify({ stage: label, at: new Date(started).toISOString(),
    elapsedMs: Date.now() - started, exitCode: r.status }) + '\n', 'utf8');
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
      const recordedUploads = has('post') ? JSON.parse(fs.readFileSync(path.join(OUT, 'pipeline.json'), 'utf8')).stages?.record?.uploads || [] : [];
      script = loadScript(SCRIPT_FILE, { recordedUploads, stage: has('dry') ? 'rehearsal' : 'record' });
      rehearsalScript = has('post') || has('dry') ? script : loadScript(SCRIPT_FILE, { stage: 'rehearsal' });
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
    // 收尾动作没写 at 会抢在收尾旁白之前执行（实测抢跑中位 10.8s、最大 23.7s）。
    // 未写的由 withEnding 默认锚到收尾旁白的最后一个分句；这里只提示还能更准的地方。
    if (!has('post')) {
      const loose = script.scenes.flatMap((s) => s.actions.slice(s.expectAt)
        .filter((a) => a.at === undefined && a.op !== 'wait').map((a) => s.id + ' ' + a.op));
      if (loose.length) {
        console.log('⚠ 这些收尾动作没写 at，已按「收尾旁白的最后一个分句」默认对齐；'
          + '要让画面更贴合旁白，给它们补上宣布该动作的那句话：\n    ' + loose.join('\n    '));
      }
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
  const pipeline = openPipeline(OUT, script, FROM, { manual: MANUAL, skipCheck: has('skip-check'), bgm: BGM, post: has('post') });
  fs.writeFileSync(SCRIPT_JSON, JSON.stringify(script, null, 2), 'utf8');

  if (!has('dry')) {
    await preflight({ browser: should('record') && !has('post'), python: PY() });
    if (should('tts')) {
      if (run('前置配音：合成旁白', PY(), [path.join(HERE, 'tts.py')]) !== 0) fail('旁白合成失败，尚未进入业务演练。');
      const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'tts', 'manifest.json'), 'utf8'));
      const clips = Object.values(manifest.scenes).map(m => path.relative(OUT, path.resolve(HERE, m.file)));
      pipeline.complete('tts', ['tts/manifest.json', ...clips]);
    }
  }

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
  if (!has('post') && !should('login') && (has('relogin') || pipeline.authChanged)) env.REC_RELOGIN = '1';

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

  // 演练走 rehearsalMode（多为「填完取消」），提交分支从不执行，所以定位、遮挡和动作顺序
  // 只有真正录制时才会暴露。这里用正式阶段的脚本再跑一次：动作照常执行，写请求被拦截、不落库。
  // 只在本次真的做了前置校验时跑（续跑 --from record/manual/compose 不必再花这一遍）。
  if (should('record') && !has('post') && !has('dry') && !has('skip-trial') && !has('skip-check')
    && STEPS.indexOf(FROM) <= STEPS.indexOf('check')) {
    const code = run(tag('record') + '  提交路径试跑（写请求被拦截，不落库）', NODE,
      [path.join(HERE, 'play.js'), SCRIPT_FILE, '--dry', '--trial'], env);
    const trialFile = path.join(OUT, 'trial-report.json');
    const trial = fs.existsSync(trialFile) ? JSON.parse(fs.readFileSync(trialFile, 'utf8')) : null;
    if (code !== 0) {
      console.log('⚠ 提交路径试跑未通过，正式录制很可能在同一处失败；现场见 output/trial-report.json'
        + (trial && trial.failure ? '：' + trial.failure.error : ''));
      if (!has('allow-trial-failure')) fail('提交路径试跑未通过；修好后再录制，或加 --allow-trial-failure 强行继续。');
    } else if (trial) {
      const trialed = trial.scenes.filter((s) => s.status === 'trial').length;
      console.log('提交路径试跑通过：' + trial.scenes.length + ' 个场景可执行，'
        + trialed + ' 个场景走到提交分支（写请求已拦截）。');
    }
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

  if (has('post')) checkAudioWindows(OUT, script);
  if (should('record') && !has('post')) {
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
    if (run(tag('manual') + '  生成正式操作手册（Word）', NODE, [path.join(HERE, 'manual.js'), SCRIPT_FILE, ...(has('post') ? ['--post'] : [])], env) !== 0) fail('手册生成失败。');
    pipeline.complete('manual', [script.manual.title.replace(/[\\/:*?"<>|]/g, '_').trim() + '.docx']);
  }

  if (should('compose') || should('cards')) ensureFonts();
  if (should('compose')) {
    const args = [path.join(HERE, 'compose.py')];
    if (BGM) args.push('--bgm', BGM);
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
