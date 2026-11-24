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
 *       hold: 0.6                       场景末尾多留几秒（默认 0.6）让结果看清。收尾动作执行后只剩 0.4 秒留白，
 *                                       要让「点完的结果」看清就把这个场景级 hold 调大；写进 ending 里会被忽略（会报错）
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
 *         cancel: { narration, actions, expect, doc }    取消收尾；写别的键会报错
 *         submit: { narration, actions, expect, doc }    提交收尾
 *         两种收尾的 actions 都要写 at：收尾旁白拼在整段旁白末尾，收尾动作却接在基础动作之后，
 *         不写 at 就必然抢在旁白之前执行。锚点取宣布该动作的那句话，见 script.yaml 最后一段完整示例。
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
 *   node script.js [script.yaml] [--rehearsal]  校验对应阶段并输出 output/script.json
 */

const CLI = require.main === module ? require('./cli').readCli({
  usage: '用法：node script.js [脚本.yaml] [--rehearsal]\n校验脚本并输出 output/script.json；--rehearsal 只校验演练阶段。',
  options: { rehearsal: { type: 'boolean' } }
}) : null;
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
function normAction(raw, where, baseUrl, baseDir, recordedUploads) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.hasOwn(raw, 'cue')) {
    throw new ScriptError(where + '：cue 是内部派生字段，不能在动作里填写；用 at 指定旁白锚点。');
  }
  const a = normActionBody(raw, where, baseUrl, baseDir, recordedUploads);
  if (raw.label !== undefined) a.label = String(raw.label);
  if (raw.at !== undefined) a.at = String(raw.at);
  if (raw.prepare !== undefined && typeof raw.prepare !== 'boolean') throw new ScriptError(where + ' prepare 必须是布尔值');
  if (raw.prepare) a.prepare = true;
  if (raw.doc !== undefined) {
    if (typeof raw.doc !== 'boolean') throw new ScriptError(where + ' doc 必须是布尔值（doc: false 表示该步骤不写入操作手册、不截手册图）');
    if (!raw.doc) a.doc = false;
  }
  // 收尾动作没写 at 时由 withEnding 算出的默认锚点；写了 at 时 resolveCue 会覆盖它。
  if (raw.defaultCue !== undefined) a.cue = Number(raw.defaultCue);
  return a;
}

// 标点处 TTS 会停顿，按两个字计
const speakWeight = (s) => [...s].reduce((n, ch) => n + (/[，。；：、！？,.;:!?]/.test(ch) ? 2 : /\s/.test(ch) ? 0 : 1), 0);

/** at：旁白里的一个短语，动作等旁白念到这里再做；换算成旁白进度比例 cue（0~1），返回命中的字符下标 */
function resolveCue(a, narration, timing, where, minPos = 0, autoStart = false) {
  if (a.at === undefined) {
    if (a.cue === undefined && autoStart && minPos > 0 && timing === 'with' && narration) {
      a.cue = speakWeight(narration.slice(0, minPos)) / (speakWeight(narration) || 1);
    }
    return minPos;
  }
  if (timing === 'before') throw new ScriptError(where + '：timing 为 before 时旁白先念完，不能用 at');
  let pos = narration.indexOf(a.at, minPos);
  if (pos < 0 && minPos > 0) pos = narration.indexOf(a.at);
  if (pos < 0) throw new ScriptError(where + '：at「' + a.at + '」在旁白里找不到');
  a.cue = speakWeight(narration.slice(0, pos)) / (speakWeight(narration) || 1);
  return pos;
}

function normActionBody(raw, where, baseUrl, baseDir, recordedUploads) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScriptError(where + '：动作要写成「动作名: 参数」，实际是 ' + JSON.stringify(raw));
  }
  const keys = Object.keys(raw).filter((k) => !['label', 'at', 'prepare', 'doc', 'defaultCue'].includes(k));
  if (keys.length !== 1) throw new ScriptError(where + '：一个动作只能有一个动作名，实际是 ' + keys.join(', '));
  const op = keys[0];
  const arg = raw[op];

  switch (op) {
    case 'upload':
      if (!arg || !arg.target) throw new ScriptError(where + ' upload 要写成 {target, files: [...]}');
      return { op, target: normTarget(arg.target, where + ' upload'),
        files: require('./uploads').normalizeFiles(arg.files, baseDir, recordedUploads) };
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
      if (arg && typeof arg === 'object') {
        if (!Array.isArray(arg) && (arg.y !== undefined || arg.x !== undefined) && !LOCATOR_KEYS.some((k) => arg[k] !== undefined) && arg.target === undefined) {
          return {
            op,
            ...(arg.x !== undefined ? { x: numeric(arg.x, where + ' scroll.x') } : {}),
            y: arg.y !== undefined ? numeric(arg.y, where + ' scroll.y') : 0,
          };
        }
        return { op, target: normTarget(arg.target !== undefined ? arg.target : arg, where + ' scroll') };
      }
      return { op, y: numeric(arg, where + ' scroll') };
    case 'wait':
      return { op, ms: milliseconds(arg, where + ' wait') };
    default:
      throw new ScriptError(where + '：不认识的动作「' + op + '」（可用：goto / click / hover / fill / select / upload / press / scroll / wait / waitFor）');
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
// ending.<模式> 里允许写的键；写别的会被整块忽略，所以宁可报错
const ENDING_KEYS = ['narration', 'actions', 'expect', 'doc'];

/**
 * 收尾写法检查：这三种写法都会被静默忽略，出的片子看不出问题，所以直接报错。
 *   1. 场景没有 feature → applyFeature 直接返回原场景，ending 整块丢掉
 *   2. ending 下写了 cancel / submit 以外的模式
 *   3. ending.<模式> 里写了 narration / actions / expect / doc 以外的键（如把 hold 写进收尾）
 */
function checkEnding(raw, where) {
  const end = raw.ending;
  if (end === undefined || end === null) return;
  if (raw.feature === undefined) {
    throw new ScriptError(where + '：ending 只在关联了 feature 的写功能场景里生效，这个场景没写 feature，整块收尾会被忽略。');
  }
  if (typeof end !== 'object' || Array.isArray(end)) throw new ScriptError(where + '：ending 要写成 { cancel: {...}, submit: {...} }');
  for (const [mode, block] of Object.entries(end)) {
    if (!Object.hasOwn(MODE_NAME, mode)) {
      throw new ScriptError(where + '：ending 只有 cancel（填完取消）和 submit（真实提交）两种收尾，实际写了「' + mode + '」');
    }
    if (!block || typeof block !== 'object' || Array.isArray(block)) throw new ScriptError(where + '：ending.' + mode + ' 要写成对象');
    const extra = Object.keys(block).filter((k) => !ENDING_KEYS.includes(k));
    if (extra.length) {
      throw new ScriptError(where + '：ending.' + mode + ' 不认识「' + extra.join('、') + '」，可用的只有 '
        + ENDING_KEYS.join(' / ') + '；hold 是场景级字段，要写在这一层场景上。');
    }
  }
}

/**
 * 收尾旁白的最后一个分句，作为没写 at 的收尾动作的默认锚点。
 * 提示词要求把「暂不发起时可以取消返回」这类话放在旁白结尾，收尾动作却接在基础动作之后，
 * 所以不写 at 的收尾动作必然抢在旁白之前执行（实测抢跑中位 10.8s、最大 23.7s）。
 */
function defaultEndingAnchor(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const parts = s.split(/(?<=[。！？；])|(?<=[，、])/).map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

/**
 * 把选中的收尾接到场景后面：旁白、动作顺接，手册结果以收尾为准。
 * 场景自己的断言要在收尾动作之前检查（取消之后弹窗就关了），所以记下 expectAt；收尾的断言另放 endExpect。
 */
function withEnding(s, end) {
  const d = s.doc || {};
  const e = end.doc || {};
  const list = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const bodyNarr = s.narration ? String(s.narration).trim() : '';
  const endNarr = end.narration ? String(end.narration).trim() : '';
  const narration = [bodyNarr, endNarr].filter(Boolean).join('');
  const anchor = defaultEndingAnchor(endNarr);
  const anchorAt = anchor ? narration.lastIndexOf(anchor) : -1;
  const actions = list(end.actions).map((a) => {
    if (anchorAt >= 0 && a && typeof a === 'object' && !Array.isArray(a) && !Object.hasOwn(a, 'at')) {
      return Object.assign({}, a, { defaultCue: speakWeight(narration.slice(0, anchorAt)) / (speakWeight(narration) || 1) });
    }
    return a;
  });
  return Object.assign({}, s, {
    narration,
    bodyNarrationText: bodyNarr,
    endNarrationText: endNarr,
    bodyNarrationLen: bodyNarr && endNarr ? bodyNarr.length : 0,
    actions: list(s.actions).concat(actions),
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
  s = { ...s, preparationRequests: on.filter(f => f.preparation[stage]).flatMap(f => f.preparation.requests) };
  if (!s.ending) {
    if (on.some((f) => f.kind === 'write') && !continued) throw new ScriptError(where + '：写功能组尾必须提供 ending，不能在基础动作中保存。');
    return s;
  }
  if (feats.length > 1) throw new ScriptError(where + '：ending 只能用在只关联一个功能的场景上');
  const f = feats[0];
  const mode = stage === 'rehearsal' && f.kind === 'write' ? f.rehearsalMode : f.writeMode;
  const end = s.ending[mode];
  if (!end) throw new ScriptError(where + '：功能「' + f.name + '」本阶段选的是「' + MODE_NAME[mode] + '」，场景缺少 ending.' + mode);
  const altMode = mode === 'submit' ? 'cancel' : 'submit';
  const altEnd = s.ending[altMode];
  const altNarration = altEnd && altEnd.narration
    ? [s.narration ? String(s.narration).trim() : '', String(altEnd.narration).trim()].filter(Boolean).join('')
    : '';
  return Object.assign(withEnding(s, end), {
    writeMode: f.kind === 'write' ? mode : 'cancel',
    writeRequests: f.writeRequests,
    ...(altNarration ? { altNarration } : {}),
  });
}

/**
 * 读音规则：TTS 读不准的多音字，配音时换成读音唯一的同音字，字幕和手册仍用原文。
 * edge-tts 免费接口不接受自定义 SSML（phoneme 标签无效），只能靠改写送去合成的文字。
 * 建议按具体词组替换，避免单字全局替换误伤其他词（如「行」误伤「先行」「执行」）：
 *   pronounce:
 *     已选行: 已选航
 *     重新: 虫新
 *   pronounceChecked: [调整, 预校验]          抽听过、TTS 读对了的词，不再提示（内置 BUILTIN_CHECKED 之外追加；没听过不许写）
 * 规则按键长从长到短依次处理，返回 (旁白) => 配音文本
 *
 * 选替换字：挑只有一个读音、声调相同的常用字（行 háng → 航，校 jiào → 叫）；
 * 找不到合适的字时，改写旁白避开（第三行 → 第三条）。
 */
const BUILTIN_PRONOUNCE = {
  跨行: '跨航', 任意行: '任意航', 每行: '每航', 本行: '本航', 首行: '首航', 末行: '末航',
  勾选行: '勾选航', 汇总行: '汇总航', 待补码行: '待补码航', 已选行: '已选航', 全部行: '全部航',
  多行: '多航', 空白行: '空白航', 各行: '各航', 上一行: '上一航', 下一行: '下一航', 行内: '航内',
  查重: '察虫', 重排: '虫排', 重算: '虫算', 重置: '虫置', 重提: '虫提', 重新: '虫新', 重复: '虫复',
  调平: '条平', 调整: '条整', 调休: '条休', 微调: '微条', 协调: '协条', 调减: '条减', 调增: '条增',
  弹窗: '谈窗',
};

function makeSpeech(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new ScriptError('pronounce 要写成「字或词: 读作」的映射');
  }
  const merged = Object.assign({}, BUILTIN_PRONOUNCE, raw || {});
  const rules = Object.entries(merged).map(([key, v]) => {
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
const BUILTIN_CHECKED = ['参与', '参加', '参照', '调度', '卡片', '行数', '数量', '数据', '系数', '总数', '工作量', '批量',
  '衡量', '余量', '全量', '量化', '任务量', '名称', '重置', '重新', '清空', '空行', '空白', '占比', '弹出', '还可', '还没',
  '处理', '方便', '调整', '流转', '转正', '差不多', '差额', '进度差', '校验', '执行', '进行'];

const FORBIDDEN_META_NARRATION = /演练阶段|本次演练|只做演练|仅作演练|本次只演示|本片段未执行|不实际发布|不实际提交|不会产生任何业务数据|不产生任何业务数据|不修改真实数据|零副作用/;
const DEEP_FORM_GOTO_RE = /[?&](id|recordId|projectId|biddingId|taskId|orderId)=|[?&](toPublish|toEdit|toAdd|toDetail|toUpdate|toAudit)\b|\/(edit|detail|publish|audit)\/[^/?#]+/i;
const SUBMIT_ACTION_RE = /(点击|点)[^，。；！？]{0,12}(确定|保存|提交|发布|确认|下发|通过|完成)/;
const SUBMIT_RESULT_RE = /(后|即可|将|会)[^。！？]{0,28}(状态|变为|进入|成功|生效|生成|列表|流转|发送|通知|更新|完成|归档|提示)/;
const BUSINESS_IMPACT_RE = /影响|下游|后续|供应商|审批|负责人|成员|团队|人员|客户端|通知|公告|消息|待办|开放|开启|解锁|锁定|禁止|不可|不能再|方可|才能|随即|自动|同步|流转|进入.*(阶段|环节|流程)|生效|报价|填报|核销|结算|权限/;
const FIELD_RELATION_RE = /先后|顺序|早于|晚于|大于|小于|不超过|不少于|等于|联动|合计|上限|下限|区间|周期|开始.*截止|起始.*结束|之后|之前|关联|对应|计算|公式|比例|占比|规则|必须|不能|需/;

function assertNoMetaText(text, where) {
  if (!text) return;
  const hit = String(text).match(FORBIDDEN_META_NARRATION);
  if (hit) {
    throw new ScriptError(where + '：严禁包含内部演练/测试话术「' + hit[0] + '」，请改用面向业务用户的正常话术（如「核对后点击确定即可发布，系统提示发布成功且状态变为已发布；暂不办理时可点击取消返回」）');
  }
}

function assertCardAndEntryNorms(doc, scenes, intro, outro, feat) {
  if (intro && intro.narration) {
    assertNoMetaText(intro.narration, 'intro');
    const t = String(intro.narration);
    const han = t.replace(/[^\u4e00-\u9fa5]/g, '').length;
    if (han > 25 || /包括.*、|请跟随画面操作/.test(t)) {
      throw new ScriptError('intro：片头旁白过长（' + han + '字）或含步骤罗列套话，须精简为一句话（≤25字，如「本视频演示……的操作流程。」）');
    }
  }
  if (outro && outro.narration) {
    assertNoMetaText(outro.narration, 'outro');
    const t = String(outro.narration);
    const han = t.replace(/[^\u4e00-\u9fa5]/g, '').length;
    if (han > 20) {
      throw new ScriptError('outro：片尾旁白过长（' + han + '字），须精简为一句话（≤20字，如「以上就是……的操作演示，感谢观看。」）');
    }
  }
  if (doc && doc.manual) {
    for (const piece of [doc.manual.overview, ...asList(doc.manual.prerequisites), ...asList(doc.manual.notes)]) {
      assertNoMetaText(piece, 'manual');
    }
  }
  if (doc && doc.intro && doc.outro && doc.manual && scenes.length > 0) {
    if (feat && !feat.environment.tier) {
      throw new ScriptError('功能清单「' + path.basename(feat.file) + '」缺少 environment.tier（三级环境与数据洁净度分级）：请先向用户询问确认采用 isolated（独立隔离库+洁净黄金基线+快照回滚真演练）、shared-test（共享测试环境+视图筛选降噪+真实提交）或 restricted（受限环境+只演示填完取消不触发写接口），写入 environment.tier 后再编译出片');
    }
    const s0 = scenes[0];
    if (!/菜单|导航|左侧|顶部/.test(s0.narration || '')) {
      throw new ScriptError(s0.id + '：介绍功能首先要让观众找到功能，首场景旁白必须交代如何通过菜单进入该功能（如「首先在左侧菜单点击……，进入……」），勿跳过菜单导航');
    }
    if (!(s0.actions || []).some((a) => a.op === 'click')) {
      throw new ScriptError(s0.id + '：介绍功能首先要让观众找到功能，首场景必须包含点击菜单/页签进入功能页面的 click 动作，不能仅靠 goto 跳过菜单导航');
    }
    for (const s of scenes) {
      const acts = s.actions || [];
      for (const a of acts) {
        if (a.op === 'goto' && DEEP_FORM_GOTO_RE.test(a.url || '')) {
          throw new ScriptError(s.id + '：严禁使用带具体记录 ID 或表单动作的 goto（' + a.url + '）跳过列表中的操作按钮点击；必须先在列表中筛选/定位目标行（操作列被遮挡时先横向 scroll），再真实 click 行上的操作按钮（如「发布」「编辑」）进入表单，让观众看到按钮位置与点击动作');
        }
      }
      const firstFillIdx = acts.findIndex((a) => a.op === 'fill');
      if (firstFillIdx >= 0 && !s.continue) {
        const hasClickBeforeFill = acts.slice(0, firstFillIdx).some((a) => a.op === 'click');
        if (!hasClickBeforeFill) {
          throw new ScriptError(s.id + '：进入表单填写前必须先在页面或列表中真实 click 触发按钮（如「新建」「发布」「编辑」），不能跳过点击入口按钮直接填表');
        }
      }
      const fillCount = acts.filter((a) => a.op === 'fill').length;
      if (fillCount >= 3 && !FIELD_RELATION_RE.test(s.narration || '')) {
        throw new ScriptError(s.id + '：包含多个表单字段填写时，旁白不能只机械报读字段名，必须介绍字段之间的业务关系、先后顺序或校验规则（如各时间节点的先后约束、金额比例关系等；若项目无文档，应从前后端校验代码、已有历史样本或通用业务常识中提炼补充）');
      }
      if (s.endNarrationText) {
        if (!SUBMIT_ACTION_RE.test(s.narration || '') || !SUBMIT_RESULT_RE.test(s.narration || '')) {
          throw new ScriptError(s.id + '：写功能（无论真实提交还是填完取消 ending.cancel）旁白都必须讲清楚点击确定/保存/提交后的正确系统现象、状态变化或结果查看位置（如「核对无误后点击确定即可完成发布，系统提示发布成功且项目状态变为已发布」），让使用者知道怎样才算操作成功');
        }
        if (!BUSINESS_IMPACT_RE.test(s.narration || '')) {
          throw new ScriptError(s.id + '：不只要介绍功能操作本身，还必须在旁白中介绍该功能生效后的业务影响（如对下游角色/供应商/审批人的通知或待办、开启或锁定的后续流程与修改限制等）');
        }
      }
    }
  }
}

function narrationWarnings(scenes) {
  const warnings = [];
  if (scenes.length > 0 && scenes[0].narration) {
    const s0 = scenes[0];
    if (!/菜单|导航|左侧|顶部/.test(s0.narration)) {
      warnings.push(s0.id + '：首场景旁白未介绍如何通过菜单进入该功能（应边点击菜单边交代「在左侧菜单点击……进入……」），勿跳过菜单导航');
    }
  }
  for (const s of scenes) {
    const body = s.bodyNarrationText || '';
    const end = s.endNarrationText || '';
    if (body && end) {
      const clicks = [...new Set((body.match(/点击[\u4e00-\u9fa5]{2,8}/g) || []))];
      const dup = clicks.filter((c) => end.includes(c));
      if (dup.length) {
        warnings.push(s.id + '：正文与收尾旁白重复出现「' + dup.join('、') + '」，会造成先念一遍再做一遍的重复感');
      }
    }
    const text = s.narration || '';
    const longClauses = text.split(/[，。；！？、]/).map((c) => c.trim()).filter((c) => c.replace(/[^\u4e00-\u9fa5]/g, '').length > 24);
    if (longClauses.length) {
      warnings.push(s.id + '：分句过长（>24字），易导致字幕硬切或 TTS 断句异常：「' + longClauses[0].slice(0, 16) + '…」');
    }
    if (/解锁后续/.test(text)) {
      warnings.push(s.id + '：含易粘连词组「解锁后续」，建议改为「即可创建…」或加逗号断开');
    }
  }
  return warnings;
}

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

function normalize(doc, file, { stage = 'record', recordedUploads = [] } = {}) {
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
    for (const key of ['writeMode', 'writeRequests', 'preparationRequests', 'expectAt', 'endExpect']) {
      if (Object.hasOwn(raw, key)) throw new ScriptError(where + '：' + key + ' 是内部字段，不能在场景中填写；提交授权由已确认功能清单和 ending 派生。');
    }
    checkEnding(raw, where);
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
    assertNoMetaText(narration, where + ' 旁白');
    assertNoMetaText(s.altNarration, where + ' 备选收尾旁白');
    if (s.doc) {
      assertNoMetaText(s.doc.text, where + ' doc.text');
      assertNoMetaText(s.doc.result, where + ' doc.result');
      for (const tip of asList(s.doc.tips)) assertNoMetaText(tip, where + ' doc.tips');
    }
    let prevAt = -1;
    let lastPos = 0;
    const actions = (s.actions || []).map((a, j) => {
      const w = where + ' 第 ' + (j + 1) + ' 个动作';
      const act = normAction(a, w, url, baseDir, recordedUploads);
      if (act.prepare && !(s.preparationRequests || []).length) throw new ScriptError(w + '：本阶段尚未批准上传/预检副作用');
      const isEndStart = s.expectAt !== undefined && j === s.expectAt;
      const inEnding = s.expectAt !== undefined && j >= s.expectAt;
      const floorPos = Math.max(inEnding ? (s.bodyNarrationLen || 0) : 0, lastPos);
      const matchedPos = resolveCue(act, narration, timing, w, floorPos, isEndStart);
      if (act.at !== undefined && act.cue !== undefined) {
        if (act.cue < prevAt - 1e-6) {
          throw new ScriptError(w + '：at「' + act.at + '」在旁白中的位置早于前一个动作的 at，会导致音画顺序倒挂');
        }
        prevAt = act.cue;
        lastPos = matchedPos;
      }
      return act;
    });
    return {
      id,
      name: s.name ? String(s.name) : '',
      switchUser: s.switchUser ? String(s.switchUser) : '',
      bodyNarrationText: s.bodyNarrationText || '',
      endNarrationText: s.endNarrationText || '',
      ...(s.altNarration ? { altSpeech: speech(s.altNarration) } : {}),
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
      preparationRequests: normalizeRequests(s.preparationRequests, url, where + ' preparationRequests'),
    };
  }).filter(Boolean);
  if (!scenes.length) throw new ScriptError('按功能清单筛选后没有可演示的场景');
  const intro = normCard(doc.intro, String(doc.title || '操作演示'), speech);
  const outro = normCard(doc.outro, '演示结束', speech);
  assertCardAndEntryNorms(doc, scenes, intro, outro, feat);
  const narrations = [intro, outro, ...scenes].filter((x) => x && x.narration).map((x) => String(x.narration));

  const readOnlyRequests = normalizeRequests(doc.readOnlyRequests, url, 'readOnlyRequests', { readOnly: true });
  const finalRequests = feat ? feat.features.flatMap(f => normalizeRequests(f.writeRequests, url, 'writeRequests')) : [];
  const preparationRequests = feat ? feat.features.flatMap(f => normalizeRequests(f.preparation.requests, url, 'preparation.requests')) : [];
  // 使用真实来源统一解析所有功能，防止相对/绝对别名或其他功能的动态路径借走最终提交权限。
  assertDisjoint(preparationRequests, finalRequests, { message: '准备写入与最终提交路径相交，请使用可区分的接口' });
  const writeRequests = [...finalRequests, ...preparationRequests];
  const approvedWriteRequests = feat ? feat.features.filter((f) => f.include && f.kind === 'write'
    && (stage === 'rehearsal' ? f.rehearsalMode : f.writeMode) === 'submit'
    && scenes.some((s) => s.feature.includes(f.id))).flatMap((f) => normalizeRequests(f.writeRequests, url, 'writeRequests')) : [];
  approvedWriteRequests.push(...scenes.filter(s => s.actions.some(a => a.prepare)).flatMap(s => s.preparationRequests));
  assertDisjoint(readOnlyRequests, writeRequests);
  return {
    source: path.resolve(file),
    executionStage: stage,
    readOnlyRequests,
    safety: { environment: feat ? feat.environment : { name: '', testData: false },
      writes: feat ? feat.features.filter((f) => f.include && f.kind === 'write').map((f) => ({ id: f.id, name: f.name,
        mode: stage === 'rehearsal' ? f.rehearsalMode : f.writeMode,
        preparation: f.preparation[stage] ? f.preparation.description : '' })) : [],
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
    pronounceHints: pronounceHints(narrations, Object.assign({}, BUILTIN_PRONOUNCE, doc.pronounce || {}), BUILTIN_CHECKED.concat(doc.pronounceChecked || []).map(String)),
    narrationWarnings: narrationWarnings(scenes, intro, outro),
    manual: {
      title: String((doc.manual && doc.manual.title) || String(doc.title || '操作演示').replace(/演示$/, '') + '手册'),
      version: doc.manual && doc.manual.version ? String(doc.manual.version) : '',
      audience: doc.manual && doc.manual.audience ? String(doc.manual.audience) : '',
      overview: doc.manual && doc.manual.overview ? String(doc.manual.overview) : '',
      prerequisites: asList(doc.manual && doc.manual.prerequisites),
      notes: asList(doc.manual && doc.manual.notes),
    },
    ...(feat && feat.thesis ? { thesis: feat.thesis } : {}),
    features: feat && {
      file: feat.file,
      confirmedAt: feat.confirmedAt,
      ...(feat.thesis ? { thesis: feat.thesis } : {}),
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
  const file = path.resolve(HERE, CLI.positionals[0] || 'script.yaml');
  try {
    const s = loadScript(file, { stage: CLI.values.rehearsal ? 'rehearsal' : 'record' });
    const release = require('./lock').acquireLock(path.dirname(DEFAULT_OUT));
    process.once('exit', release);
    fs.mkdirSync(path.dirname(DEFAULT_OUT), { recursive: true });
    fs.writeFileSync(DEFAULT_OUT, JSON.stringify(s, null, 2), 'utf8');
    const ops = s.scenes.reduce((n, x) => n + x.actions.length, 0);
    console.log('脚本校验通过：' + s.scenes.length + ' 个场景，' + ops + ' 个动作');
    console.log('已写入 ' + path.relative(HERE, DEFAULT_OUT));
    if (s.pronounceHints.length) console.log('⚠ 含易错多音字、待抽听的词：\n    ' + s.pronounceHints.join('\n    '));
    if (s.narrationWarnings && s.narrationWarnings.length) console.log('⚠ 旁白断句与重复提示：\n    ' + s.narrationWarnings.join('\n    '));
  } catch (e) {
    console.error('[脚本错误] ' + e.message);
    process.exit(1);
  }
}
