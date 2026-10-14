(function (root) {
  'use strict';
  const keys = ['rehearsalMode', 'writeMode'];
  const eligible = (f, page) => f.include && f.kind === 'write' && !f.blocked && f.status !== 'removed'
    && (!page || f.page === page);
  function apply(features, { page = '', values = {}, override = false, testData = false } = {}) {
    for (const [key, value] of Object.entries(values)) {
      if (!keys.includes(key) || !['cancel', 'submit'].includes(value)) throw new Error('批量设置不合法');
      if (value === 'submit' && !testData) throw new Error('环境未允许测试数据');
    }
    const changed = [];
    for (const f of features.filter(f => eligible(f, page))) {
      for (const [key, value] of Object.entries(values)) {
        if (value === 'submit' && f.submitRestriction) continue;
        if (!override && (f.modeOverrides || []).includes(key)) continue;
        if (f[key] !== value) { f[key] = value; changed.push(f.id); }
        if (override) f.modeOverrides = (f.modeOverrides || []).filter(k => k !== key);
      }
    }
    return [...new Set(changed)];
  }
  const api = { keys, eligible, apply };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TrainingBulk = api;
})(typeof globalThis === 'undefined' ? this : globalThis);
