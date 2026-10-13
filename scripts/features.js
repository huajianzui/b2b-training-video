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
 *   environment:                         录制用的环境（出片前和用户确认）
 *     name: 本地开发环境                  旁白里会提到，如「当前是生产环境」
 *     testData: true                     用户是否允许写测试数据；每轮提交还要确认本轮数据准备
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
 *       desc: 这个功能是什么
 *       how: 打算怎么演示
 *       permission: order:manage
 *       when: 显示条件
 *       requires: 演示前提（要什么数据 / 文件）
 *       blocked: 当前演示不了的原因        有值时默认不勾选
 *       minor: true                      操作过于简单，默认不勾选
 *       shared: 查询                      由公共组件提供的通用操作（查询 / 表格 / 弹窗…），已在《系统通用操作》里讲过，默认不勾选
 *       source: views/order/OrderListView.vue:6
 *       include: true                    是否演示（确认页回写；不写按默认规则）
 *       writeMode: cancel                写数据怎么处理：cancel 填完取消 | submit 真实提交（确认页回写；不写按 environment.testData 取默认）
 *       rehearsalMode: ~                 演练取消或提交，由用户单独选择；未选择不能执行写功能
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
const { normalizeRequests } = require('./requests');

const KINDS = ['read', 'write'];
const WRITE_MODES = ['cancel', 'submit'];

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
  const environment = { name: str(env.name), testData: env.testData === true };
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
    const writeMode = str(f.writeMode) || defaultWriteMode;
    if (!WRITE_MODES.includes(writeMode)) throw new FeatureError(w + '「' + id + '」：writeMode 只能是 ' + WRITE_MODES.join(' / '));
    const rehearsalMode = str(f.rehearsalMode);
    if (rehearsalMode && !WRITE_MODES.includes(rehearsalMode)) throw new FeatureError(w + '：rehearsalMode 只能是 cancel / submit');
    normalizeRequests(f.writeRequests, 'https://policy.invalid/', w + ' writeRequests');
    const blocked = str(f.blocked);
    const minor = !!f.minor;
    const shared = str(f.shared);
    return {
      id,
      page: str(f.page),
      name: str(f.name),
      kind,
      desc: str(f.desc),
      how: str(f.how),
      permission: str(f.permission),
      when: str(f.when),
      requires: str(f.requires),
      blocked,
      minor,
      shared,
      source: str(f.source),
      include: f.include === undefined ? !blocked && !minor && !shared : !!f.include,
      writeMode,
      rehearsalMode,
      writeRequests: (f.writeRequests || []).map((r) => ({ method: r.method.toUpperCase(), url: r.url })),
      status: str(f.status),
    };
  });
  return {
    file: path.resolve(file),
    module: str(raw.module),
    script: str(raw.script),
    generatedBy: str(raw.generatedBy),
    generatedAt: str(raw.generatedAt),
    confirmedAt: str(raw.confirmedAt),
    environment,
    pages,
    features,
  };
}

function loadFeatures(file) {
  return normalize(readDoc(file).toJS(), file);
}

function validateDecisions(manifest, { requireRehearsal = true } = {}) {
  for (const f of manifest.features.filter((f) => f.include && f.kind === 'write' && f.status !== 'removed')) {
    if (requireRehearsal && !f.rehearsalMode) throw new FeatureError('功能「' + f.name + '」缺少 rehearsalMode：请在确认页单独选择演练取消或真实提交。');
    if (f.writeMode === 'submit' || f.rehearsalMode === 'submit') {
      if (!manifest.environment.testData) throw new FeatureError('环境不允许写测试数据（environment.testData 不是 true），功能「' + f.name + '」不能 submit。');
      if (!f.writeRequests.length) throw new FeatureError('功能「' + f.name + '」缺少 writeRequests：核对业务代码后填写真实提交接口，再重新确认。');
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
  const definition = ({ include, writeMode, rehearsalMode, status, ...fields }) => fields;
  const features = fresh.features.map((f) => {
    const prev = old.get(f.id);
    if (!prev) {
      added.push(f.id);
      return Object.assign({}, f, { status: 'new' });
    }
    const differs = prev.status === 'removed' || JSON.stringify(definition(f)) !== JSON.stringify(definition(prev));
    if (differs) updated.push(f.id);
    return Object.assign({}, f, { include: prev.include, writeMode: prev.writeMode, rehearsalMode: prev.rehearsalMode,
      status: differs ? 'changed' : prev.status });
  });
  const freshIds = new Set(fresh.features.map((f) => f.id));
  const removed = saved.features.filter((f) => !freshIds.has(f.id) && f.status !== 'removed');
  for (const f of removed) features.push(Object.assign({}, f, { include: false, status: 'removed' }));

  const contextChanged = (fresh.module || saved.module) !== saved.module || JSON.stringify(fresh.pages) !== JSON.stringify(saved.pages);
  const changed = added.length > 0 || removed.length > 0 || updated.length > 0 || contextChanged;
  const savedEnvironment = readDoc(savedFile).toJS().environment;
  const out = {
    module: fresh.module || saved.module,
    script: saved.script || fresh.script,
    generatedBy: fresh.generatedBy,
    generatedAt: fresh.generatedAt,
    confirmedAt: changed ? null : saved.confirmedAt || null,
    environment: savedEnvironment || readDoc(freshFile).toJS().environment || saved.environment,
    pages: fresh.pages.map((p) => {
      const o = { id: p.id, name: p.name };
      if (p.entry) o.entry = p.entry;
      if (p.route) o.route = p.route;
      if (p.files.length) o.files = p.files;
      return o;
    }),
    features: features.map((f) => {
      const o = { id: f.id, page: f.page, name: f.name, kind: f.kind };
      for (const k of ['desc', 'how', 'permission', 'when', 'requires', 'blocked', 'shared', 'source']) if (f[k]) o[k] = f[k];
      if (f.minor) o.minor = true;
      o.include = f.include;
      if (f.kind === 'write') {
        o.writeMode = f.writeMode;
        if (f.rehearsalMode) o.rehearsalMode = f.rehearsalMode;
        if (f.writeRequests.length) o.writeRequests = f.writeRequests;
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
