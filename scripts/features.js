#!/usr/bin/env node
/**
 * 功能清单 —— 一个模块"要演示什么"由用户在确认页勾选，而不是由写脚本的人（或 AI）自己决定
 *
 * 文件：<名字>.features.yaml，由代码盘点产出（现在人工 / 以后 AI），确认页回写勾选结果。
 *
 *   module: 订单管理
 *   script: order.yaml                  对应的演示脚本
 *   generatedBy: 人工盘点 | gemini-2.5-pro
 *   generatedAt: 2026-10-09
 *   confirmedAt: ~                       确认页点「确认」后写入；为空时不允许出片
 *   environment:                         录制用的环境（出片前和用户确认，按三级阶梯降级）
 *     name: 本地开发环境                  仅供制作确认，不进入业务旁白
 *     tier: isolated                     isolated（隔离库+洁净黄金数据+快照回滚真演练）| shared-test（共享测试库+视图筛选降噪+真实提交）| restricted（受限环境+只演示不触发写接口）
 *     testData: true                     用户是否允许写测试数据；每轮提交还要确认本轮数据准备
 *   thesis:                              模块业务总纲（先读业务文档与核心代码提炼，抓住主要矛盾，指导造数与排片）
 *     why: 为什么有这个模块（解决什么业务痛点，在全局业务流中的上下游位置）
 *     coreContradiction: 本模块要解决的主要矛盾是什么
 *     mainline: 围绕主要矛盾的核心业务主线闭环
 *     keyDesigns: [化解主要矛盾的核心设计巧思与防错机制]
 *     dataDesign: 造数设计方案（如何用正反对比、阈值边界、防错纠错数据把设计巧思演出来，拒绝走过场数据）
 *   pages:
 *     - id: list
 *       name: 订单列表
 *       entry: 左侧菜单「业务 › 订单管理」     怎么进到这个页面
 *       route: /orders
 *       files: [views/order/OrderListView.vue]
 *   features:
 *     - id: list.create                  稳定 id，脚本场景用 feature: list.create 关联
 *       page: list
 *       name: 新增订单
 *       kind: write                      read 只读 | write 写数据
 *       priority: core                   core（核心主线/设计巧思，重点讲透）| supporting（支撑功能，顺带串联）| routine（常规外围操作，合并或一笔带过）
 *       desc: 这个功能是什么
 *       how: 打算怎么演示
 *       permission: order:manage
 *       when: 显示条件
 *       requires: 演示前提（要什么数据 / 文件）
 *       dependsOn: []                    强状态前置功能 id（如审批依赖新建提交）；被依赖的写功能在演练或录制选 cancel 时会阻断后续演示
 *       blocked: 当前演示不了的原因        有值时默认不勾选
 *       minor: true                      操作过于简单，默认不勾选
 *       shared: 查询                      由公共组件提供的通用操作（查询 / 表格 / 弹窗…），已在《系统通用操作》里讲过，默认不勾选
 *       source: views/order/OrderListView.vue:6
 *       include: true                    是否演示（确认页回写；不写按默认规则）
 *       writeMode: cancel                写数据怎么处理：cancel 填完取消 | submit 真实提交（确认页回写；不写按 environment.testData 取默认）
 *       rehearsalMode: ~                 演练取消或提交，由用户单独选择；未选择不能执行写功能
 *       modeOverrides: []                单项例外的阶段键；批量默认保留，明确覆盖才替换
 *       submitRestriction: 禁止真实通知   固定禁止提交的原因；普通批量覆盖不可解除
 *       preparation:                     上传/预检等提前发生的副作用，独立于最终提交
 *         description: 选择文件即上传
 *         rehearsal: false               用户明确批准才填 true
 *         record: false
 *         requests: [{method: POST, url: /api/uploads}]
 *       writeRequests: [{method: POST, url: /api/orders}]  实际写接口，来自业务代码
 *       status: new | changed | removed  改版后对比时标注，确认后清除
 *
 * 用法：
 *   node features.js <清单>                         校验并打印摘要
 *   node features.js <清单> --yes                   记录用户已经明确批准的当前选择
 *   node features.js merge <已确认清单> <新盘点清单>   对比后写回已确认清单：新增的标 new，消失的标 removed
 */

const CLI = require.main === module ? require('./cli').readCli({
  usage: '用法：node features.js <清单.features.yaml> [--yes]\n'
    + '      node features.js merge <已确认清单> <新清单>\n'
    + '  --yes 仅记录用户已经明确批准的选择。',
  options: { yes: { type: 'boolean' } }, maxPositionals: 3,
  validate: ({ values, positionals }) => {
    if (positionals[0] === 'merge') {
      if (positionals.length !== 3 || values.yes) throw new Error('merge 需要两份清单且不能使用 --yes。');
    } else if (positionals.length !== 1) throw new Error('只能指定一份功能清单；使用 --help 查看用法。');
  }
}) : null;

const fs = require('fs');
const path = require('path');
const { requireFrom } = require('./deps');
const { normalizeRequests, assertDisjoint } = require('./requests');

const KINDS = ['read', 'write'];
const WRITE_MODES = ['cancel', 'submit'];
const ENV_TIERS = ['isolated', 'shared-test', 'restricted'];
const PRIORITIES = ['core', 'supporting', 'routine'];

function normThesis(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const why = str(raw.why);
  const coreContradiction = str(raw.coreContradiction);
  const mainline = str(raw.mainline);
  const keyDesigns = strList(raw.keyDesigns).map((s) => s.trim()).filter(Boolean);
  const dataDesign = str(raw.dataDesign);
  if (!why && !coreContradiction && !mainline && !keyDesigns.length && !dataDesign) return null;
  return { why, coreContradiction, mainline, keyDesigns, dataDesign };
}

class FeatureError extends Error {}

function readDoc(file) {
  const YAML = requireFrom('yaml');
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new FeatureError(path.basename(file) + ' YAML 语法错误：' + doc.errors[0].message);
  return doc;
}

const str = (v) => (v === undefined || v === null ? '' : String(v));
const strList = (v) => (v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]).map(String));

function normalize(raw, file) {
  const where = path.basename(file);
  if (!raw || typeof raw !== 'object') throw new FeatureError(where + '：内容为空');
  const pages = (raw.pages || []).map((p) => ({
    id: str(p.id), name: str(p.name), entry: str(p.entry), route: str(p.route), files: strList(p.files),
  }));
  const pageIds = new Set(pages.map((p) => p.id));
  const ids = new Set();
  const env = raw.environment || {};
  const tier = str(env.tier);
  if (tier && !ENV_TIERS.includes(tier)) {
    throw new FeatureError(where + '：environment.tier 只能是 ' + ENV_TIERS.join(' / '));
  }
  const environment = { name: str(env.name), testData: env.testData === true, ...(tier ? { tier } : {}) };
  const defaultWriteMode = environment.testData ? 'submit' : 'cancel';
  const features = (raw.features || []).map((f, i) => {
    const w = where + ' 第 ' + (i + 1) + ' 个功能';
    if (!f || !f.id || !f.name) throw new FeatureError(w + '：id 和 name 必填');
    const id = str(f.id);
    if (ids.has(id)) throw new FeatureError(w + '：id「' + id + '」重复');
    ids.add(id);
    if (!pageIds.has(str(f.page))) throw new FeatureError(w + '「' + id + '」：page「' + str(f.page) + '」不在 pages 里');
    const kind = str(f.kind) || 'read';
    if (!KINDS.includes(kind)) throw new FeatureError(w + '「' + id + '」：kind 只能是 ' + KINDS.join(' / '));
    const priority = str(f.priority);
    if (priority && !PRIORITIES.includes(priority)) {
      throw new FeatureError(w + '「' + id + '」：priority 只能是 ' + PRIORITIES.join(' / '));
    }
    const writeMode = str(f.writeMode) || defaultWriteMode;
    if (!WRITE_MODES.includes(writeMode)) throw new FeatureError(w + '「' + id + '」：writeMode 只能是 ' + WRITE_MODES.join(' / '));
    const rehearsalMode = str(f.rehearsalMode);
    if (rehearsalMode && !WRITE_MODES.includes(rehearsalMode)) throw new FeatureError(w + '：rehearsalMode 只能是 cancel / submit');
    normalizeRequests(f.writeRequests, 'https://policy.invalid/', w + ' writeRequests');
    const preparation = f.preparation || {};
    const prepRequests = normalizeRequests(preparation.requests, 'https://policy.invalid/', w + ' preparation.requests');
    if (prepRequests.length && (kind !== 'write' || !str(preparation.description))) throw new FeatureError(w + '：有准备写入须标为 write 并说明副作用');
    for (const key of ['rehearsal', 'record']) if (preparation[key] !== undefined && typeof preparation[key] !== 'boolean') throw new FeatureError(w + '：准备阶段许可必须是布尔值');
    if ((preparation.rehearsal || preparation.record) && (!prepRequests.length || !environment.testData)) throw new FeatureError(w + '：准备写入需要测试环境许可和精确接口');
    assertDisjoint(prepRequests, normalizeRequests(f.writeRequests, 'https://policy.invalid/', w + ' writeRequests'),
      { message: '准备写入与最终提交路径相交，请使用可区分的接口' });
    const modeOverrides = f.modeOverrides === undefined
      ? ['rehearsalMode', 'writeMode'].filter(k => Object.hasOwn(f, k) && f[k])
      : f.modeOverrides;
    if (!Array.isArray(modeOverrides) || modeOverrides.some(k => !['rehearsalMode', 'writeMode'].includes(k))) {
      throw new FeatureError(w + '：modeOverrides 只能包含 rehearsalMode / writeMode');
    }
    const blocked = str(f.blocked);
    const minor = !!f.minor;
    const shared = str(f.shared);
    const dependsOn = [...new Set(strList(f.dependsOn).map((d) => d.trim()).filter(Boolean))];
    return {
      id,
      page: str(f.page),
      name: str(f.name),
      kind,
      ...(priority ? { priority } : {}),
      desc: str(f.desc),
      how: str(f.how),
      permission: str(f.permission),
      when: str(f.when),
      requires: str(f.requires),
      dependsOn,
      blocked,
      minor,
      shared,
      source: str(f.source),
      include: f.include === undefined ? !blocked && !minor && !shared : !!f.include,
      writeMode,
      rehearsalMode,
      modeOverrides: [...new Set(modeOverrides)],
      submitRestriction: str(f.submitRestriction),
      preparation: { description: str(preparation.description), rehearsal: preparation.rehearsal === true, record: preparation.record === true,
        requests: (preparation.requests || []).map(r => ({ method: r.method.toUpperCase(), url: r.url })) },
      writeRequests: (f.writeRequests || []).map((r) => ({ method: r.method.toUpperCase(), url: r.url })),
      status: str(f.status),
    };
  });
  for (const f of features) {
    for (const depId of f.dependsOn) {
      if (depId === f.id) throw new FeatureError(where + '「' + f.id + '」：dependsOn 不能依赖自身');
      if (!ids.has(depId)) throw new FeatureError(where + '「' + f.id + '」：dependsOn「' + depId + '」不在 features 清单里');
    }
  }
  const thesis = normThesis(raw.thesis);
  return {
    file: path.resolve(file),
    module: str(raw.module),
    script: str(raw.script),
    generatedBy: str(raw.generatedBy),
    generatedAt: str(raw.generatedAt),
    confirmedAt: str(raw.confirmedAt),
    environment,
    ...(thesis ? { thesis } : {}),
    pages,
    features,
  };
}

function loadFeatures(file) {
  return normalize(readDoc(file).toJS(), file);
}

function validateDecisions(manifest, { requireRehearsal = true } = {}) {
  const byId = new Map(manifest.features.map((f) => [f.id, f]));
  for (const f of manifest.features.filter((f) => f.include && f.kind === 'write' && f.status !== 'removed')) {
    if (f.blocked && (f.preparation.rehearsal || f.preparation.record)) throw new FeatureError('阻塞功能不能批准准备写入：' + f.name);
    if (requireRehearsal && !f.rehearsalMode) throw new FeatureError('功能「' + f.name + '」缺少 rehearsalMode：请在确认页单独选择演练取消或真实提交。');
    if (f.writeMode === 'submit' || f.rehearsalMode === 'submit') {
      if (f.blocked || f.submitRestriction) throw new FeatureError('功能「' + f.name + '」不能 submit：' + (f.submitRestriction || f.blocked));
      if (manifest.environment.tier === 'restricted') throw new FeatureError('三级环境与数据洁净度分级为 restricted（受限环境）时，功能「' + f.name + '」不能设为 submit。');
      if (!manifest.environment.testData) throw new FeatureError('环境不允许写测试数据（environment.testData 不是 true），功能「' + f.name + '」不能 submit。');
      if (!f.writeRequests.length) throw new FeatureError('功能「' + f.name + '」缺少 writeRequests：核对业务代码后填写真实提交接口，再重新确认。');
    }
  }
  for (const f of manifest.features.filter((f) => f.include && f.status !== 'removed' && (f.dependsOn || []).length)) {
    for (const depId of f.dependsOn) {
      const dep = byId.get(depId);
      if (!dep || !dep.include || dep.status === 'removed') {
        throw new FeatureError('功能「' + f.name + '」依赖前置功能「' + (dep ? dep.name : depId) + '」，请同时勾选该前置功能，或取消勾选「' + f.name + '」。');
      }
      if (dep.kind === 'write') {
        if (requireRehearsal && dep.rehearsalMode === 'cancel' && (!f.kind || f.kind === 'read' || f.rehearsalMode === 'submit')) {
          throw new FeatureError('功能「' + f.name + '」依赖前置功能「' + dep.name + '」提交后的数据，但「' + dep.name + '」在演练阶段选了「填完取消」，会导致演练无法走通后续链路；请将前置功能演练也设为 submit（配合隔离库快照还原或双套测试数据），或将后续功能演练改为 cancel。');
        }
        if (dep.writeMode === 'cancel' && (f.kind === 'read' || f.writeMode === 'submit')) {
          throw new FeatureError('功能「' + f.name + '」依赖前置功能「' + dep.name + '」提交后的数据，但「' + dep.name + '」在正式录制选了「填完取消」，会导致正式录制链路中断；请将前置功能录制设为 submit，或取消勾选「' + f.name + '」。');
        }
      }
    }
  }
}

const findFeatureNode = (doc, id) => doc.get('features').items.find((n) => str(n.get('id')) === id);

/**
 * 确认页回写 include / writeMode / rehearsalMode / status / confirmedAt，其余内容和注释原样保留。
 * decisions: { [id]: { include, writeMode, rehearsalMode } }
 */
function saveDecisions(file, decisions, confirm) {
  const doc = readDoc(file);
  const current = normalize(doc.toJS(), file);
  for (const [id, d] of Object.entries(decisions || {})) {
    const node = findFeatureNode(doc, id);
    if (!node) throw new FeatureError('清单里没有功能「' + id + '」');
    if (d.include !== undefined) node.set('include', !!d.include);
    if (d.modeOverrides !== undefined) node.set('modeOverrides', d.modeOverrides);
    if (d.preparation !== undefined) {
      if (!node.get('preparation')) throw new FeatureError('不能通过选择新增准备写接口，请先核实清单');
      for (const key of ['rehearsal', 'record']) if (d.preparation[key] !== undefined) node.setIn(['preparation', key], d.preparation[key]);
    }
    if (d.writeMode !== undefined) {
      if (!WRITE_MODES.includes(d.writeMode)) throw new FeatureError('「' + id + '」writeMode 不合法：' + d.writeMode);
      node.set('writeMode', d.writeMode);
    }
    if (d.rehearsalMode !== undefined) {
      if (d.rehearsalMode !== '' && !WRITE_MODES.includes(d.rehearsalMode)) throw new FeatureError('「' + id + '」rehearsalMode 不合法');
      node.set('rehearsalMode', d.rehearsalMode);
    }
  }
  const updated = normalize(doc.toJS(), file);
  validateDecisions(updated, { requireRehearsal: !!confirm });
  if (!confirm && JSON.stringify(current.features) !== JSON.stringify(updated.features)) doc.set('confirmedAt', null);
  if (confirm) {
    for (const f of current.features) {
      if (!f.status) continue;
      const node = findFeatureNode(doc, f.id);
      if (f.status === 'removed') doc.get('features').delete(doc.get('features').items.indexOf(node));
      else node.delete('status');
    }
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    doc.set('confirmedAt', local.toISOString().slice(0, 19).replace('T', ' '));
  }
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }), 'utf8');
  return loadFeatures(file);
}

/**
 * 改版后重跑：拿新盘点结果和已确认清单对比，写回已确认清单。
 * 已有功能保留用户的选择，业务信息变化标 changed；新增标 new；消失标 removed 并取消勾选。
 * 有任何变化就清空 confirmedAt，出片前必须重新确认；没变化则保持已确认，直接出片。
 */
function mergeFresh(savedFile, freshFile) {
  const YAML = requireFrom('yaml');
  const saved = loadFeatures(savedFile);
  const fresh = loadFeatures(freshFile);
  const old = new Map(saved.features.map((f) => [f.id, f]));
  const added = [];
  const updated = [];
  const definition = ({ include, writeMode, rehearsalMode, modeOverrides, submitRestriction, status, preparation, ...fields }) => ({
    ...fields, preparation: { description: preparation.description, requests: preparation.requests } });
  const features = fresh.features.map((f) => {
    const prev = old.get(f.id);
    if (!prev) {
      added.push(f.id);
      return Object.assign({}, f, { status: 'new' });
    }
    const differs = prev.status === 'removed' || (!prev.submitRestriction && !!f.submitRestriction)
      || JSON.stringify(definition(f)) !== JSON.stringify(definition(prev));
    if (differs) updated.push(f.id);
    return Object.assign({}, f, { include: prev.include, writeMode: prev.writeMode, rehearsalMode: prev.rehearsalMode, modeOverrides: prev.modeOverrides,
      submitRestriction: prev.submitRestriction || f.submitRestriction,
      preparation: { ...f.preparation, rehearsal: differs ? false : prev.preparation.rehearsal, record: differs ? false : prev.preparation.record },
      status: differs ? 'changed' : prev.status });
  });
  const freshIds = new Set(fresh.features.map((f) => f.id));
  const removed = saved.features.filter((f) => !freshIds.has(f.id) && f.status !== 'removed');
  for (const f of removed) features.push(Object.assign({}, f, { include: false, status: 'removed' }));

  const contextChanged = (fresh.module || saved.module) !== saved.module
    || JSON.stringify(fresh.pages) !== JSON.stringify(saved.pages)
    || JSON.stringify(fresh.thesis || null) !== JSON.stringify(saved.thesis || null);
  const changed = added.length > 0 || removed.length > 0 || updated.length > 0 || contextChanged;
  const savedEnvironment = readDoc(savedFile).toJS().environment;
  const mergedThesis = fresh.thesis || saved.thesis || null;
  const out = {
    module: fresh.module || saved.module,
    script: saved.script || fresh.script,
    generatedBy: fresh.generatedBy,
    generatedAt: fresh.generatedAt,
    confirmedAt: changed ? null : saved.confirmedAt || null,
    environment: savedEnvironment || readDoc(freshFile).toJS().environment || saved.environment,
    ...(mergedThesis ? { thesis: mergedThesis } : {}),
    pages: fresh.pages.map((p) => {
      const o = { id: p.id, name: p.name };
      if (p.entry) o.entry = p.entry;
      if (p.route) o.route = p.route;
      if (p.files.length) o.files = p.files;
      return o;
    }),
    features: features.map((f) => {
      const o = { id: f.id, page: f.page, name: f.name, kind: f.kind };
      if (f.priority) o.priority = f.priority;
      for (const k of ['desc', 'how', 'permission', 'when', 'requires', 'blocked', 'shared', 'source', 'submitRestriction']) if (f[k]) o[k] = f[k];
      if (f.dependsOn && f.dependsOn.length) o.dependsOn = f.dependsOn;
      if (f.minor) o.minor = true;
      o.include = f.include;
      if (f.kind === 'write') {
        o.writeMode = f.writeMode;
        o.modeOverrides = f.modeOverrides;
        if (f.rehearsalMode) o.rehearsalMode = f.rehearsalMode;
        if (f.writeRequests.length) o.writeRequests = f.writeRequests;
        if (f.preparation.requests.length) o.preparation = f.preparation;
      }
      if (f.status) o.status = f.status;
      return o;
    }),
  };
  fs.writeFileSync(savedFile, YAML.stringify(out, { lineWidth: 0 }), 'utf8');
  return { added, updated, removed: removed.map((f) => f.id), changed };
}

module.exports = { loadFeatures, saveDecisions, validateDecisions, mergeFresh, FeatureError, WRITE_MODES };

if (require.main === module) {
  const [cmd, a, b] = CLI.positionals;
  try {
    if (cmd === 'merge') {
      if (!a || !b) throw new FeatureError('用法：node features.js merge <已确认清单> <新盘点清单>');
      const r = mergeFresh(path.resolve(a), path.resolve(b));
      if (!r.changed) console.log(loadFeatures(path.resolve(a)).confirmedAt
        ? '功能没有变化，保持已确认状态，可以直接出片。' : '未发现新变化；清单仍待用户确认。');
      else {
        if (r.added.length) console.log('新增 ' + r.added.length + ' 项：' + r.added.join('、'));
        if (r.updated.length) console.log('变化 ' + r.updated.length + ' 项：' + r.updated.join('、'));
        if (r.removed.length) console.log('消失 ' + r.removed.length + ' 项：' + r.removed.join('、'));
        console.log('清单已更新，需要在确认页重新确认后才能出片。');
      }
    } else {
      if (!cmd) throw new FeatureError('用法：node features.js <清单> [--yes]');
      const file = path.resolve(cmd);
      if (CLI.values.yes) {
        const pre = loadFeatures(file);
        if (!pre.environment.tier) {
          throw new FeatureError('缺少 environment.tier（三级环境与数据洁净度分级）：请先向用户询问确认采用 isolated（独立隔离库+洁净黄金基线+快照回滚真演练）、shared-test（共享测试环境+视图筛选降噪+真实提交）或 restricted（受限环境+只演示填完取消不触发写接口），写入 environment.tier 后再执行 --yes。');
        }
      }
      const f = CLI.values.yes ? saveDecisions(file, {}, true) : loadFeatures(file);
      const on = f.features.filter((x) => x.include);
      console.log(f.module + '：' + f.pages.length + ' 个页面，' + f.features.length + ' 个功能，勾选 ' + on.length + ' 个'
        + '（写数据 ' + on.filter((x) => x.kind === 'write').length + '）');
      console.log(f.confirmedAt ? '已确认：' + f.confirmedAt : '尚未确认');
    }
  } catch (e) {
    console.error('[清单错误] ' + e.message);
    process.exit(1);
  }
}
