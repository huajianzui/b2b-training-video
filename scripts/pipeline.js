'use strict';

// 共用 output 的流水线必须串行；续跑依据当前脚本和已完成阶段，不依据旧 script.json。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normLogin } = require('./login');
const { acquireLock } = require('./lock');

const STEPS = ['script', 'login', 'check', 'tts', 'record', 'manual', 'compose', 'verify', 'cards'];
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fileHash(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  try {
    let size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, size));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function codeHash(files) {
  return digest(files.map((file) => ({ file, hash: fileHash(path.join(__dirname, file)) })));
}

function fingerprints(script, bgm, { post = false } = {}) {
  const features = script.features ? fileHash(script.features.file) : '';
  const identity = digest({ source: fs.realpathSync(script.source), url: script.url, login: normLogin(script) });
  const rehearsal = post ? script : require('./script').loadScript(script.source, { stage: 'rehearsal' });
  const browserCode = codeHash(['script.js', 'features.js', 'play.js', 'requests.js', 'confirmation.js', 'login.js', 'media.js', 'deps.js', 'cli.js', 'uploads.js',
    ...fs.readdirSync(path.join(__dirname, 'adapters')).filter((file) => file.endsWith('.js')).sort().map((file) => 'adapters/' + file)]);
  const manualCode = codeHash(['manual.js', 'cli.js']);
  const actions = rehearsal.scenes.map((s) => ({ id: s.id, continue: s.continue, feature: s.feature,
    actions: s.actions.map(({ cue, at, ...a }) => a), expect: s.expect, expectAt: s.expectAt, endExpect: s.endExpect }));
  const check = digest({ identity, features, implementation: browserCode, adapters: rehearsal.adapters, actions, requests: rehearsal.readOnlyRequests, safety: rehearsal.safety });
  const documentation = { title: script.title, manual: script.manual, sharedGuide: script.sharedGuide,
    coverSubtitle: script.intro && script.intro.subtitle, watermark: script.watermark,
    overview: script.manual.overview || (script.intro && script.intro.narration),
    shared: script.features && script.features.shared,
    scenes: script.scenes.map((s) => ({ id: s.id, name: s.name, narration: s.narration, doc: s.doc })) };
  const tts = digest({ implementation: codeHash(['tts.py', 'speech.py']), voice: script.voice, rate: script.rate, scenes: script.scenes.map((s) => ({ id: s.id, speech: s.speech })) });
  const record = digest({ identity, features, implementation: browserCode, adapters: script.adapters, tts, scenes: script.scenes,
    requests: script.readOnlyRequests, safety: script.safety });
  const capture = digest({ source: fs.realpathSync(script.source), url: script.url,
    login: normLogin(script, { resolveCredentials: false }), features, implementation: browserCode,
    adapters: script.adapters, requests: script.readOnlyRequests, safety: script.safety,
    scenes: script.scenes.map(({ narration, speech, doc, name, actions, ...scene }) => ({ ...scene,
      actions: actions.map(({ cue, at, label, ...action }) => action) })) });
  const manual = digest({ record, implementation: manualCode, ...documentation });
  if (bgm && !fs.statSync(bgm).isFile()) throw new Error('背景音乐必须是可读取的音频文件：' + bgm);
  const music = bgm ? { source: fs.realpathSync(bgm), hash: fileHash(bgm) } : null;
  const compose = digest({ record, implementation: codeHash(['compose.py', 'subtitles.py']), watermark: script.watermark, bgm: music });
  return { identity, check, capture, manual, rehearsalManual: digest({ check, implementation: manualCode, ...documentation }), tts, record, compose };
}

function artifact(out, rel) {
  const full = path.resolve(out, rel);
  const relative = path.relative(out, full);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('续跑产物路径超出 output：' + rel);
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error('续跑产物缺失：' + rel);
  const realRelative = path.relative(fs.realpathSync(out), fs.realpathSync(full));
  if (realRelative === '..' || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) {
    throw new Error('续跑产物链接超出 output：' + rel);
  }
  return { file: relative.replace(/\\/g, '/'), hash: fileHash(full) };
}

function verifyCapture(out, script, bgm = null) {
  const state = JSON.parse(fs.readFileSync(path.join(out, 'pipeline.json'), 'utf8'));
  const saved = state.stages && state.stages.record;
  if (!saved || !saved.capture || saved.capture !== fingerprints(script, bgm, { post: true }).capture || !saved.execution) {
    throw new Error('纯后期缺少录制来源，或操作、角色、授权/工具实现已改变；不能复用画面，请明确准备重录。');
  }
  for (const name of ['raw.webm', 'session.json', 'run-report.json']) {
    if (!saved.artifacts.some(a => a.file === name)) throw new Error('纯后期缺少录制产物：' + name);
  }
  for (const a of saved.artifacts) if (artifact(out, a.file).hash !== a.hash) throw new Error('录制产物已变化：' + a.file);
  return saved;
}

function checkAudioWindows(out, script) {
  const session = JSON.parse(fs.readFileSync(path.join(out, 'session.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'tts/manifest.json'), 'utf8'));
  if (session.scenes.length !== script.scenes.length || session.scenes.some((s, i) => s.id !== script.scenes[i].id)) {
    throw new Error('原录制场景与当前脚本不一致，不能纯后期。');
  }
  for (const [i, s] of session.scenes.entries()) {
    const scene = script.scenes[i]; if (!scene.narration) continue;
    const m = manifest.scenes[s.id], end = Math.min(s.end, session.duration, session.scenes[i + 1]?.audioAt ?? Infinity);
    if (!m || m.speech !== scene.speech || !Number.isFinite(m.dur) || m.dur <= 0 || s.audioAt + m.dur > end) {
      throw new Error('场景 ' + s.id + ' 的新配音超出原画面时间窗或来源不匹配；缩短旁白或明确重录，不能截断或顺延冒充成功。');
    }
  }
}

function openPipeline(out, script, from, { manual = true, skipCheck = false, bgm = null, post = false } = {}) {
  const stateFile = path.join(out, 'pipeline.json');
  const hashes = fingerprints(script, bgm, { post });
  let previous = null;
  if (fs.existsSync(stateFile)) {
    try { previous = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch (error) {
      if (from !== 'script') throw new Error('续跑来源记录损坏，请从 script 环节开始：' + error.message);
      console.warn('[produce] 续跑记录损坏；本次从 script 重新生成，不复用旧产物。');
    }
  }
  const resumable = STEPS.indexOf(from) >= STEPS.indexOf('tts');
  if (resumable && (!previous || previous.version !== 2 || !previous.stages)) {
    throw new Error('旧产物缺少可靠的续跑来源记录，请从 script 环节开始（node produce.js <脚本.yaml>）。');
  }
  if (resumable && !post && previous.identity !== hashes.identity) {
    throw new Error('续跑产物属于其他脚本、环境或登录角色，请从 script 环节开始。');
  }
  if (post) verifyCapture(out, script, bgm);
  const state = previous && previous.version === 2 && previous.stages && (previous.identity === hashes.identity || post) && from !== 'script'
    ? previous : { version: 2, source: fs.realpathSync(script.source), identity: hashes.identity, stages: {} };

  function requireStage(stage, requiredFiles = []) {
    const saved = state.stages[stage];
    if (!saved || (post && stage === 'record' ? saved.capture !== hashes.capture : saved.input !== hashes[stage])) throw new Error('续跑输入已变化或未完成，请从 ' + stage + ' 环节开始。');
    if (!Array.isArray(saved.artifacts) || !saved.artifacts.length) throw new Error('续跑来源记录缺少 ' + stage + ' 产物，请重跑该环节。');
    for (const file of requiredFiles) {
      if (!saved.artifacts.some((a) => a.file === file)) throw new Error('续跑缺少 ' + file + '，请从 ' + stage + ' 环节开始。');
    }
    for (const a of saved.artifacts) {
      if (artifact(out, a.file).hash !== a.hash) throw new Error('续跑产物已变化：' + a.file + '，请从 ' + stage + ' 环节开始。');
    }
  }

  if (resumable && !post) {
    const index = STEPS.indexOf(from);
    if (index <= STEPS.indexOf('record') && !skipCheck) requireStage('check');
    if (['record', 'manual', 'compose'].includes(from)) requireStage('tts', ['tts/manifest.json']);
    if (['manual', 'compose'].includes(from)) requireStage('record', ['raw.webm', 'session.json', ...(manual ? ['manual/record/steps.json'] : [])]);
    if (manual && index > STEPS.indexOf('manual')) requireStage('manual');
    if (from === 'verify' || from === 'cards') requireStage('compose', ['demo-voiced.mp4', 'subs.srt']);
  }

  function save() {
    fs.mkdirSync(out, { recursive: true });
    const temporary = stateFile + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(temporary, stateFile);
  }

  // 在执行前撤销本阶段和下游的完成记录；失败后不能复用上次成功的残留产物。
  for (const stage of STEPS.slice(STEPS.indexOf(from))) if (!(post && stage === 'record')) delete state.stages[stage];
  if (STEPS.indexOf(from) <= STEPS.indexOf('check')) delete state.stages.rehearsalManual;
  save();
  return {
    authChanged: !previous || previous.identity !== hashes.identity,
    requireStage,
    complete(stage, files) {
      if (!hashes[stage]) return;
      state.stages[stage] = { input: hashes[stage], artifacts: files.map((file) => artifact(out, file)) };
      if (stage === 'record') Object.assign(state.stages[stage], { capture: hashes.capture, execution: require('./requests').executionHash(script),
        uploads: require('./uploads').listUploads(script) });
      save();
    },
  };
}

function manualArtifacts(out, stage) {
  const file = path.join('manual', stage, 'steps.json');
  const material = JSON.parse(fs.readFileSync(path.join(out, file), 'utf8'));
  const shots = material.scenes.flatMap((s) => [...s.steps.map((st) => st.shot), s.result && s.result.shot]).filter(Boolean);
  return [file.replace(/\\/g, '/'), ...new Set(shots.map((file) => path.relative(out, path.resolve(path.dirname(out), file))))];
}

module.exports = { STEPS, openPipeline, acquireLock, manualArtifacts, verifyCapture, checkAudioWindows };
