/**
 * Element Plus 适配器
 *
 * el-select / el-select-v2 / el-tree-select / el-cascader 都不是原生 <select>：
 * 要先点开触发器，再到挂在 body 下的浮层里点选项。
 * 级联选择的 value 用「/」分隔逐级点击，如「山东省/青岛市」。
 */

const ROOT = '.el-select, .el-select-v2, .el-tree-select, .el-cascader';
const ROOT_XPATH = 'xpath=ancestor-or-self::*[' +
  ['el-select', 'el-select-v2', 'el-tree-select', 'el-cascader']
    .map((c) => `contains(concat(' ', normalize-space(@class), ' '), ' ${c} ')`)
    .join(' or ') + '][1]';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactText = (s) => new RegExp('^\\s*' + escapeRe(s) + '\\s*$');

async function pick(ctx, css, label) {
  const opt = ctx.page.locator(css).filter({ visible: true }).filter({ hasText: exactText(label) }).first();
  await opt.waitFor({ state: 'visible', timeout: 5000 });
  await ctx.click(opt);
}

module.exports = {
  name: 'element-plus',

  async select(ctx, el, value) {
    const kind = await el.evaluate((n, sel) => {
      const r = n.closest(sel) || n.querySelector(sel);
      if (!r) return '';
      return r.classList.contains('el-cascader') ? 'cascader' : 'select';
    }, ROOT);
    if (!kind) return false;

    // 2.x 的内部 input 被 wrapper 盖住，直接点它会一直被拦截，要点组件根节点
    const up = el.locator(ROOT_XPATH);
    const root = (await up.count()) ? up.first() : el.locator(ROOT).first();
    await ctx.click(root);

    if (kind === 'cascader') {
      for (const level of value.split('/').map((s) => s.trim()).filter(Boolean)) {
        await pick(ctx, '.el-cascader-node', level);
      }
      return true;
    }

    await pick(ctx, '.el-select-dropdown__item, .el-tree-node__content', value);
    return true;
  },
};
