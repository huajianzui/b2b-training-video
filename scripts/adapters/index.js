/**
 * 组件库适配层
 *
 * 核心回放只认通用动作；组件库特有的交互（自定义下拉、级联、日期面板……）
 * 由适配器接管。按脚本里 adapters 的顺序尝试，返回 true 表示已处理。
 * 都不认识时走通用兜底：点开目标，再点浮层里文字完全一致的选项。
 *
 * 新增组件库：在本目录加一个文件，导出 { name, select(ctx, el, value) }，并登记到 REGISTRY。
 */

const REGISTRY = {
  native: require('./native'),
  'element-plus': require('./element-plus'),
};

function loadAdapters(names) {
  const list = [REGISTRY.native];
  for (const n of names || []) {
    const a = REGISTRY[n];
    if (!a) throw new Error('未知的组件库适配器「' + n + '」，可用：' + Object.keys(REGISTRY).join(' / '));
    if (!list.includes(a)) list.push(a);
  }
  return list;
}

async function genericSelect(ctx, el, value) {
  await ctx.click(el);
  const opt = await ctx.findVisible([
    { by: 'role', value: 'option', name: value, exact: true },
    { by: 'text', value, exact: true },
  ], 5000);
  await ctx.click(opt.locator);
}

async function select(adapters, ctx, el, value) {
  for (const a of adapters) {
    if (await a.select(ctx, el, value)) return a.name;
  }
  await genericSelect(ctx, el, value);
  return 'generic';
}

module.exports = { loadAdapters, select, REGISTRY };
