/**
 * 原生表单控件适配器：<select> 直接选值
 */

module.exports = {
  name: 'native',

  async select(ctx, el, value) {
    const tag = await el.evaluate((n) => n.tagName);
    if (tag !== 'SELECT') return false;
    await ctx.moveTo(el);
    await el.selectOption({ label: value }).catch(() => el.selectOption(value));
    return true;
  },
};
