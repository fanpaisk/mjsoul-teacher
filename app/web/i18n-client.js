/* 浏览器侧：/api/i18n → 填 [data-i18n] / [data-i18n-ph] / [data-i18n-title] */
(function () {
  const state = { lang: 'zh-CN', dict: {} };
  function t(key, vars) {
    let s = state.dict[key];
    if (s === undefined) return key;
    return String(s).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
  }
  function apply(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
    scope.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
    document.documentElement.lang = state.lang;
  }
  async function init() {
    const q = new URLSearchParams(location.search).get('lang');
    try {
      const r = await fetch('/api/i18n?lang=' + encodeURIComponent(q || 'auto'), { cache: 'no-store' });
      const j = await r.json();
      state.lang = j.lang; state.dict = j.dict || {};
    } catch (e) { /* 网络失败时保留中文 */ }
    apply();
    return state.lang;
  }
  window.I18N = { init, apply, t, get lang() { return state.lang; } };
})();
