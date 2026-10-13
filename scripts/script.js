#!/usr/bin/env node
/**
 * 演示脚本（script.yaml）的读取、归一化与校验
 *
 * script.yaml 是新流水线唯一的输入：人写也好、AI 生成也好，都落到这一份。
 * play / manual 每次从 YAML 重新校验本阶段，tts / compose 使用经流水线核验的归一化产物。
 *
 * 结构（完整示例见 script.yaml）：
 *
 *   title: 订单管理模块操作演示
 *   url: http://localhost:8080          系统入口；goto 写相对路径时以它为基准
 *   voice / rate / watermark / login / adapters
 *   intro:  { title, subtitle, narration, footer }
 *   outro:  { title, subtitle, narration }
 *   pronounce / pronounceChecked: 多音字读音规则（只影响配音）和已抽听确认的词，见 makeSpeech
 *   manual: { title, version, audience, overview, prerequisites: [...], notes: [...] }   操作手册用，可省略
 *   features: xxx.features.yaml          功能清单（见 features.js），出片前须已确认，可省略
 *   scenes:
 *     - name: 查询订单
 *       feature: list.search             本场景演示清单里的哪个功能，可写数组
 *       narration: 这一句旁白念完之前，场景不会结束
 *       timing: with | before            with = 边说边做（默认）；before = 说完再做
 *       actions:
 *         - click: { role: button, name: 搜索 }
 *           label: 搜索                   手册里对控件的称呼，可省略（默认从界面读）
 *           at: 点击搜索                  旁白念到这个短语时才做这一步，可省略（默认紧接上一步）
 *       expect:                           每条一种：visible / hidden（消失，如取消后弹窗关闭）/ disabled（不可用）跟目标写法，text / url 跟字符串
 *         - text: 搜索完成
 *       doc: { text: 手册说明（默认用旁白）, result: 操作结果（默认按断言生成）, tips: [注意事项] }
 *       feature: list.create          关联功能清单（顶层 features: xxx.features.yaml）；可写数组，任一被勾选就保留
 *       continue: true                接着上一个场景的页面状态继续（同一个窗口里分几段讲）；要和上一个场景关联相同的功能，上一个场景不能有 ending
 *       ending:                       写数据功能的两种收尾，按确认页选的处理方式取用，接在场景末尾
 *         cancel: { narration, actions, expect, doc }
 *         submit: { narration, actions, expect, doc }
 *
 * 定位写法（target）—— 可以给一个，也可以给一个数组作为降级候选，按顺序取第一个可见的：
 *   "#kw"                         字符串：原样交给 Playwright（css / text= / role= 都行）
 *   { testid: btn-export }        data-testid
 *   { id: kw }
 *   { role: button, name: 搜索 }  按无障碍角色 + 名称，最贴近“人看到的界面”
 *   { label: 订单号 } / { placeholder: 输入订单号 } / { text: 订单管理 } / { css: ".el-input" }
 *   任一写法都可加 nth: 1、exact: true
 *
 * 用法：
 *   node script.js [script.yaml]        校验并输出 output/script.json
 */

const fs = require('fs');
const path = require('path');
const { requireFrom } = require('./deps');
const { loadFeatures, validateDecisions } = require('./features');
const { normalizeRequests, assertDisjoint } = require('./requests');

const HERE = __dirname;
const DEFAULT_OUT = path.join(HERE, 'output', 'script.json');

const LOCATOR_KEYS = ['testid', 'id', 'role', 'label', 'placeholder', 'text', 'css'];

class ScriptError extends Error {}

function numeric(value, where, nonnegative = false) {
  const validType = typeof value === 'number' || typeof value === 'string' && value.trim() !== '';
  const n = Number(value);
  if (!validType || !Number.isFinite(n) || nonnegative && n < 0) {
    throw new ScriptError(where + '：必须是' + (nonnegative ? '非负的' : '') + '有限数值');
  }
  return n;
}

function milliseconds(value, where) {
  const ms = Math.round(numeric(value, where, true) * 1000);
  // Node 的 setTimeout 超出有符号 32 位毫秒范围时会缩为 1ms，不能静默缩短用户的等待。
  if (ms > 2147483647) throw new ScriptError(where + '：超出 Node 计时器的 2147483647ms 范围');
  return ms;
}

function absUrl(u, baseDir) {
  if (!u) return '';
  if (/^[a-z]+:\/\//i.test(u)) return u;
  return 'file:///' + path.resolve(baseDir, u).replace(/\\/g, '/');
}

function normTarget(raw, where) {
  if (raw === undefined || raw === null || raw === '') {
    throw new ScriptError(where + '：缺少定位（target）');
  }
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((c, i) => {
    const w = list.length > 1 ? where + ' 第 ' + (i + 1) + ' 个候选' : where;
    if (typeof c === 'string') return { selector: c };
    if (!c || typeof c !== 'object') throw new ScriptError(w + '：定位写法不认识：' + JSON.stringify(c));
    const keys = LOCATOR_KEYS.filter((k) => c[k] !== undefined);
    if (keys.length !== 1) {
      throw new ScriptError(w + '：定位要且只能用 ' + LOCATOR_KEYS.join(' / ') + ' 其中一种，实际是 ' + JSON.stringify(c));
    }
    const out = { by: keys[0], value: String(c[keys[0]]) };
    if (c.name !== undefined) out.name = String(c.name);
    if (c.exact !== undefined) out.exact = !!c.exact;
    if (c.nth !== undefined) out.nth = Number(c.nth);
    return out;
  });
}

/**
 * 动作写法：单键对象，如 { click: target } / { fill: { target, text } } / { wait: 1.5 }
 * 可附带 label：手册里对这个控件的称呼（定位写的是 id 之类时，界面上读不出名字）
 */
function normAction(raw, where, baseUrl) {
  const a = normActionBody(raw, where, baseUrl);
  if (raw.label !== undefined) a.label = String(raw.label);
  if (raw.at !== undefined) a.at = String(raw.at);
  return a;
}

// 标点处 TTS 会停顿，按两个字计
const speakWeight = (s) => [...s].reduce((n, ch) => n + (/[，。；：、！？,.;:!?]/.test(ch) ? 2 : /\s/.test(ch) ? 0 : 1), 0);

/** at：旁白里的一个短语，动作等旁白念到这里再做；换算成旁白进度比例 cue（0~1） */
function resolveCue(a, narration, timing, where) {
  if (a.at === undefined) return;
  if (timing === 'before') throw new ScriptError(where + '：timing 为 before 时旁白先念完，不能用 at');
  const pos = narration.indexOf(a.at);
  if (pos < 0) throw new ScriptError(where + '：at「' + a.at + '」在旁白里找不到');
  a.cue = speakWeight(narration.slice(0, pos)) / (speakWeight(narration) || 1);
}

function normActionBody(raw, where, baseUrl) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScriptError(where + '：动作要写成「动作名: 参数」，实际是 ' + JSON.stringify(raw));
  }
  const keys = Object.keys(raw).filter((k) => k !== 'label' && k !== 'at');
  if (keys.length !== 1) throw new ScriptError(where + '：一个动作只能有一个动作名，实际是 ' + keys.join(', '));
  const op = keys[0];
  const arg = raw[op];

  switch (op) {
    case 'goto':
      return { op, url: new URL(String(arg), baseUrl).href };
    case 'click':
    case 'hover':
    case 'waitFor':
      return { op, target: normTarget(arg, where + ' ' + op) };
    case 'fill':
    case 'type': {
      if (!arg || arg.text === undefined) throw new ScriptError(where + ' fill：要写成 { target: ..., text: ... }');
      return { op: 'fill', target: normTarget(arg.target, where + ' fill'), text: String(arg.text) };
    }
    case 'select': {
      if (!arg || arg.value === undefined) throw new ScriptError(where + ' select：要写成 { target: ..., value: ... }');
      return { op, target: normTarget(arg.target, where + ' select'), value: String(arg.value) };
    }
    case 'press':
      return { op, key: String(arg) };
    case 'scroll':
      return { op, y: numeric(arg, where + ' scroll') };
    case 'wait':
      return { op, ms: milliseconds(arg, where + ' wait') };
    default:
      throw new ScriptError(where + '：不认识的动作「' + op + '」（可用：goto / click / hover / fill / select / press / scroll / wait / waitFor）');
  }
}

function normExpect(raw, where) {
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return list.map((e, i) => {
    const w = where + ' expect 第 ' + (i + 1) + ' 条';
    if (!e || typeof e !== 'object') throw new ScriptError(w + '：写法不认识');
    if (e.visible !== undefined) return { kind: 'visible', target: normTarget(e.visible, w) };
    if (e.hidden !== undefined) return { kind: 'hidden', target: normTarget(e.hidden, w) };
    if (e.disabled !== undefined) return { kind: 'disabled', target: normTarget(e.disabled, w) };
    if (e.text !== undefined) return { kind: 'text', text: String(e.text) };
    if (e.url !== undefined) return { kind: 'url', url: String(e.url) };
    throw new ScriptError(w + '：只支持 visible / hidden / disabled / text / url');
  });
}

const asList = (v) => (v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]).map(String));

/** 场景的手册专用内容：text 替代旁白作为说明文字，result 替代按断言自动生成的操作结果，tips 是注意事项 */
function normDoc(raw) {
  const d = raw || {};
  return { text: d.text ? String(d.text) : '', result: d.result ? String(d.result) : '', tips: asList(d.tips) };
}

const MODE_NAME = { cancel: '填完取消', submit: '真实提交' };

/**
 * 把选中的收尾接到场景后面：旁白、动作顺接，手册结果以收尾为准。
 * 场景自己的断言要在收尾动作之前检查（取消之后弹窗就关了），所以记下 expectAt；收尾的断言另放 endExpect。
 */
function withEnding(s, end) {
  const d = s.doc || {};
  const e = end.doc || {};
  const list = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  return Object.assign({}, s, {
    narration: [s.narration, end.narration].filter(Boolean).join(''),
    actions: list(s.actions).concat(list(end.actions)),
    expectAt: list(s.actions).length,
    endExpect: list(end.expect),
    doc: { text: e.text || d.text, result: e.result || d.result, tips: list(d.tips).concat(list(e.tips)) },
  });
}

/**
 * 按功能清单筛场景。返回 null 表示这个场景关联的功能都没被勾选，跳过。
 * 没写 feature 的场景（比如进入模块的导航）始终保留。
 */
function applyFeature(s, featById, where, stage, continued) {
  if (s.feature === undefined) return s;
  if (!featById) throw new ScriptError(where + '：写了 feature 但脚本顶层没有配置 features 清单');
  const ids = (Array.isArray(s.feature) ? s.feature : [s.feature]).map(String);
  const feats = ids.map((id) => {
    const f = featById.get(id);
    if (!f) throw new ScriptError(where + '：功能清单里没有「' + id + '」');
    return f;
  });
  const on = feats.filter((f) => f.include);
  if (!on.length) return null;
  if (!s.ending) {
    if (on.some((f) => f.kind === 'write') && !continued) throw new ScriptError(where + '：写功能组尾必须提供 ending，不能在基础动作中保存。');
    return s;
  }
  if (feats.length > 1) throw new ScriptError(where + '：ending 只能用在只关联一个功能的场景上');
  const f = feats[0];
  const mode = stage === 'rehearsal' && f.kind === 'write' ? f.rehearsalMode : f.writeMode;
  const end = s.ending[mode];
  if (!end) throw new ScriptError(where + '：功能「' + f.name + '」本阶段选的是「' + MODE_NAME[mode] + '」，场景缺少 ending.' + mode);
  return Object.assign(withEnding(s, end), { writeMode: f.kind === 'write' ? mode : 'cancel', writeRequests: f.writeRequests });
}

/**
 * 读音规则：TTS 读不准的多音字，配音时换成读音唯一的同音字，字幕和手册仍用原文。
 * edge-tts 免费接口不接受自定义 SSML（phoneme 标签无效），只能靠改写送去合成的文字。
 *   pronounce:
 *     行: { say: 航, except: [执行, 进行] }   这个字一律读作「航」，除外词里的保持原样
 *     重新: 虫新                              整词替换
 *   pronounceChecked: [调整, 预校验]          抽听过、TTS 读对了的词，不再提示（内置 BUILTIN_CHECKED 之外追加；没听过不许写）
 * 规则按键长从长到短依次处理，返回 (旁白) => 配音文本
 *
 * 选替换字：挑只有一个读音、声调相同的常用字（行 háng → 航，校 jiào → 叫）；
 * 找不到合适的字时，改写旁白避开（第三行 → 第三条）。
 */
function makeSpeech(raw) {
  if (raw === undefined || raw === null) return (t) => t;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ScriptError('pronounce 要写成「字或词: 读作」的映射');
  const rules = Object.entries(raw).map(([key, v]) => {
    if (typeof v === 'string') return { key, say: v, except: [] };
    if (!v || typeof v !== 'object' || typeof v.say !== 'string') {
      throw new ScriptError('pronounce「' + key + '」：要写成 读作 或 { say: 读作, except: [例外词] }');
    }
    return { key, say: v.say, except: v.except === undefined ? [] : [].concat(v.except).map(String) };
  }).sort((a, b) => b.key.length - a.key.length);
  return (text) => rules.reduce((t, r) => {
    // 先把例外词换成占位符保护起来，替换完再还原
    const kept = [];
    const guarded = r.except.slice().sort((a, b) => b.length - a.length)
      .reduce((s, w) => s.split(w).join('\u0000' + (kept.push(w) - 1) + '\u0000'), t);
    return guarded.split(r.key).join(r.say).replace(/\u0000(\d+)\u0000/g, (m, i) => kept[Number(i)]);
  }, text);
}

// TTS 在业务旁白里容易读错的多音字。只用来提示抽听，不自动改
const RISKY_POLYPHONES = '行重长调还数量空差便处传种率降藏校参转弹卡占称';
// 已在默认音色（edge-tts 晓晓）下由人抽听确认读对的词；只有真的听过才能往这里加，换音色后要重新确认
const BUILTIN_CHECKED = ['参与', '卡片', '行数', '数量', '数据', '系数', '总数', '工作量', '批量', '名称', '重置', '重新',
  '清空', '空行', '空白', '占比', '弹出', '还可', '还没', '处理', '方便', '调整', '流转', '差不多', '校验'];

/**
 * 旁白里含易错多音字、又没被 pronounce 规则或 pronounceChecked 覆盖的地方，按字分组：
 * ['量：批量设 作量', ...]，每处取前后各一个字（去掉标点）帮助定位
 */
function pronounceHints(texts, rules, checked) {
  const ruleKeys = rules ? Object.keys(rules) : [];
  const covered = ruleKeys.filter((k) => k.length > 1).concat(checked);
  const charRules = new Set(ruleKeys.filter((k) => k.length === 1));
  const byChar = new Map();
  for (const t of texts) {
    for (let i = 0; i < t.length; i++) {
      if (!RISKY_POLYPHONES.includes(t[i]) || charRules.has(t[i])) continue;
      const inCovered = covered.some((w) => {
        for (let p = t.indexOf(w); p >= 0; p = t.indexOf(w, p + 1)) if (p <= i && i < p + w.length) return true;
        return false;
      });
      if (inCovered) continue;
      const around = t.slice(Math.max(0, i - 1), i + 2).replace(/[^\u4e00-\u9fa5]/g, '');
      if (!byChar.has(t[i])) byChar.set(t[i], new Set());
      byChar.get(t[i]).add(around);
    }
  }
  return [...byChar].map(([c, set]) => c + '：' + [...set].join(' '));
}

function normCard(raw, fallbackTitle, speech) {
  if (!raw) return null;
  const card = typeof raw === 'string' ? { title: fallbackTitle, narration: raw } : Object.assign({ title: fallbackTitle }, raw);
  if (card.narration) card.speech = speech(String(card.narration));
  return card;
}

function normalize(doc, file, { stage = 'record' } = {}) {
  if (!['rehearsal', 'record'].includes(stage)) throw new ScriptError('执行阶段只能是 rehearsal / record');
  if (!doc || typeof doc !== 'object') throw new ScriptError('脚本为空或不是对象');
  const baseDir = path.dirname(path.resolve(file));
  const url = absUrl(doc.url, baseDir);
  if (!url) throw new ScriptError('缺少 url（系统入口）');
  if (!Array.isArray(doc.scenes) || !doc.scenes.length) throw new ScriptError('scenes 不能为空');

  let feat = null;
  if (doc.features) {
    feat = loadFeatures(path.resolve(baseDir, String(doc.features)));
    if (!feat.confirmedAt) {
      const e = new ScriptError('功能清单「' + path.basename(feat.file) + '」还没有确认，先在确认页勾选要演示的功能并点确认');
      e.code = 'UNCONFIRMED';
      e.featuresFile = feat.file;
      throw e;
    }
    validateDecisions(feat);
  }
  const featById = feat ? new Map(feat.features.map((f) => [f.id, f])) : null;
  const covered = new Set();
  const speech = makeSpeech(doc.pronounce);

  const ids = new Set();
  const scenes = doc.scenes.map((raw, i) => {
    const where = '第 ' + (i + 1) + ' 个场景' + (raw && raw.name ? '「' + raw.name + '」' : '');
    if (!raw || typeof raw !== 'object') throw new ScriptError(where + '：写法不认识');
    for (const key of ['writeMode', 'writeRequests', 'expectAt', 'endExpect']) {
      if (Object.hasOwn(raw, key)) throw new ScriptError(where + '：' + key + ' 是内部字段，不能在场景中填写；提交授权由已确认功能清单和 ending 派生。');
    }
    const id = String(raw.id || 's' + String(i + 1).padStart(2, '0'));
    if (/[\/\\:*?"<>|\u0000-\u001f]/.test(id)) throw new ScriptError(where + '：id 不能包含路径分隔符、控制字符或文件名非法字符');
    const fileId = id.toLowerCase();
    if (ids.has(fileId)) throw new ScriptError(where + '：id「' + id + '」忽略大小写后重复，会导致截图文件名冲突');
    ids.add(fileId);
    if (raw.feature !== undefined) for (const f of [].concat(raw.feature)) covered.add(String(f));
    if (raw.continue) {
      const prev = doc.scenes[i - 1];
      const key = (x) => [].concat(x.feature === undefined ? [] : x.feature).map(String).join(',');
      if (!prev) throw new ScriptError(where + '：第一个场景不能写 continue');
      // 关联相同功能，清单筛选时才会和上一个场景一起保留或一起跳过
      if (key(prev) !== key(raw)) throw new ScriptError(where + '：continue 的场景要和上一个场景关联相同的 feature');
      if (prev.ending) throw new ScriptError(where + '：上一个场景有 ending（收尾会关掉页面状态），不能 continue');
    }
    const s = applyFeature(raw, featById, where, stage, !!(doc.scenes[i + 1] && doc.scenes[i + 1].continue));
    if (!s) return null;
    const timing = s.timing || 'with';
    if (timing !== 'with' && timing !== 'before') throw new ScriptError(where + '：timing 只能是 with 或 before');
    const narration = s.narration ? String(s.narration).trim() : '';
    const actions = (s.actions || []).map((a, j) => {
      const w = where + ' 第 ' + (j + 1) + ' 个动作';
      const act = normAction(a, w, url);
      resolveCue(act, narration, timing, w);
      return act;
    });
    return {
      id,
      name: s.name ? String(s.name) : '',
      features: asList(s.feature),
      continue: !!raw.continue,
      narration,
      speech: speech(narration),
      timing,
      hold: milliseconds(s.hold === undefined ? 0.6 : s.hold, where + ' hold'),
      actions,
      expect: normExpect(s.expect, where),
      expectAt: s.expectAt === undefined ? actions.length : s.expectAt,
      endExpect: normExpect(s.endExpect, where + ' 收尾'),
      doc: normDoc(s.doc),
      feature: raw.feature === undefined ? [] : [].concat(raw.feature).map(String),
      writeMode: s.writeMode || 'cancel',
      writeRequests: normalizeRequests(s.writeRequests, url, where + ' writeRequests'),
    };
  }).filter(Boolean);
  if (!scenes.length) throw new ScriptError('按功能清单筛选后没有可演示的场景');
  const intro = normCard(doc.intro, String(doc.title || '操作演示'), speech);
  const outro = normCard(doc.outro, '演示结束', speech);
  const narrations = [intro, outro, ...scenes].filter((x) => x && x.narration).map((x) => String(x.narration));

  const readOnlyRequests = normalizeRequests(doc.readOnlyRequests, url, 'readOnlyRequests', { readOnly: true });
  const writeRequests = feat ? feat.features.flatMap((f) => normalizeRequests(f.writeRequests, url, 'writeRequests')) : [];
  const approvedWriteRequests = feat ? feat.features.filter((f) => f.include && f.kind === 'write'
    && (stage === 'rehearsal' ? f.rehearsalMode : f.writeMode) === 'submit'
    && scenes.some((s) => s.feature.includes(f.id))).flatMap((f) => normalizeRequests(f.writeRequests, url, 'writeRequests')) : [];
  assertDisjoint(readOnlyRequests, writeRequests);
  return {
    source: path.resolve(file),
    executionStage: stage,
    readOnlyRequests,
    safety: { environment: feat ? feat.environment : { name: '', testData: false },
      writes: feat ? feat.features.filter((f) => f.include && f.kind === 'write').map((f) => ({ id: f.id, name: f.name,
        mode: stage === 'rehearsal' ? f.rehearsalMode : f.writeMode })) : [],
      writeRequests, approvedWriteRequests },
    title: String(doc.title || '操作演示'),
    url,
    voice: doc.voice || 'zh-CN-XiaoxiaoNeural',
    rate: doc.rate || '-6%',
    watermark: doc.watermark || '',
    adapters: Array.isArray(doc.adapters) ? doc.adapters.map(String) : ['element-plus'],
    login: doc.login || { enabled: false },
    intro,
    outro,
    pronounceHints: pronounceHints(narrations, doc.pronounce, BUILTIN_CHECKED.concat(doc.pronounceChecked || []).map(String)),
    manual: {
      title: String((doc.manual && doc.manual.title) || String(doc.title || '操作演示').replace(/演示$/, '') + '手册'),
      version: doc.manual && doc.manual.version ? String(doc.manual.version) : '',
      audience: doc.manual && doc.manual.audience ? String(doc.manual.audience) : '',
      overview: doc.manual && doc.manual.overview ? String(doc.manual.overview) : '',
      prerequisites: asList(doc.manual && doc.manual.prerequisites),
      notes: asList(doc.manual && doc.manual.notes),
    },
    features: feat && {
      file: feat.file,
      confirmedAt: feat.confirmedAt,
      // 勾选了但脚本里还没有场景的功能：需要补写场景（以后由 AI 补）
      uncovered: feat.features.filter((f) => f.include && !covered.has(f.id)).map((f) => ({ id: f.id, name: f.name })),
      // 没单独演示、交给《系统通用操作》的功能，手册里写引用；仍勾选的出片时提示可能重复
      shared: feat.features.filter((f) => f.shared && !f.include && f.status !== 'removed').map((f) => ({ id: f.id, name: f.name, shared: f.shared })),
      sharedIncluded: feat.features.filter((f) => f.shared && f.include).map((f) => ({ id: f.id, name: f.name, shared: f.shared })),
    },
    sharedGuide: String(doc.sharedGuide || '系统通用操作'),
    scenes,
  };
}

function loadScript(file, options) {
  const YAML = requireFrom('yaml');
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    throw new ScriptError('YAML 语法错误：' + e.message);
  }
  return normalize(doc, file, options);
}

/** 脚本里每个功能 id 有哪些场景（不做清单筛选和确认检查），给确认页标注"已有场景 / 缺场景" */
function sceneFeatureIds(file) {
  const YAML = requireFrom('yaml');
  const doc = YAML.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
  const map = Object.create(null);
  for (const s of doc.scenes || []) {
    if (!s || s.feature === undefined) continue;
    for (const id of [].concat(s.feature).map(String)) (map[id] = map[id] || []).push(String(s.name || ''));
  }
  return map;
}

/** 把已校验 YAML 转成登录模块的内部配置；单项 login CLI 也走相同转换。 */
function asLoginProject(script) {
  return { url: script.url, login: script.login, readOnlyRequests: script.readOnlyRequests,
    writeRequests: script.safety && script.safety.writeRequests };
}

module.exports = { loadScript, sceneFeatureIds, asLoginProject, ScriptError, DEFAULT_OUT };

if (require.main === module) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('用法：node script.js [脚本.yaml]   校验脚本并输出 output/script.json（格式见本文件开头注释）');
    process.exit(0);
  }
  const file = path.resolve(HERE, process.argv[2] || 'script.yaml');
  try {
    const s = loadScript(file);
    const release = require('./lock').acquireLock(path.dirname(DEFAULT_OUT));
    process.once('exit', release);
    fs.mkdirSync(path.dirname(DEFAULT_OUT), { recursive: true });
    fs.writeFileSync(DEFAULT_OUT, JSON.stringify(s, null, 2), 'utf8');
    const ops = s.scenes.reduce((n, x) => n + x.actions.length, 0);
    console.log('脚本校验通过：' + s.scenes.length + ' 个场景，' + ops + ' 个动作');
    console.log('已写入 ' + path.relative(HERE, DEFAULT_OUT));
    if (s.pronounceHints.length) console.log('⚠ 含易错多音字、待抽听的词：\n    ' + s.pronounceHints.join('\n    '));
  } catch (e) {
    console.error('[脚本错误] ' + e.message);
    process.exit(1);
  }
}
