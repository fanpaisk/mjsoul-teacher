'use strict';
/**
 * 更新检查（默认手动触发，不做静默后台请求）。
 *
 * 为什么不自动更新：这东西会读写游戏页面数据，用户必须知道"什么时候换了个版本"。
 * 所以只做"告诉你有新版 + 给个链接"，不下载、不替换。
 */
const https = require('https');

const REPO = 'fanpaisk/mjsoul-teacher';
const CACHE_MS = 60 * 60 * 1000;   // 1 小时，避免连点

let cache = { at: 0, result: null };

function parseVer(v) {
  return String(v || '').replace(/^v/i, '').split(/[.\-+]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
}

function isNewer(latest, current) {
  const a = parseVer(latest), b = parseVer(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

function fetchLatest(timeoutMs) {
  return new Promise((resolve) => {
    const req = https.get(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'majsoul-coach', Accept: 'application/vnd.github+json' },
      timeout: timeoutMs || 6000,
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; if (buf.length > 512 * 1024) req.destroy(); });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ ok: false, error: `HTTP ${res.statusCode}（仓库可能还没有 release）` });
        try {
          const j = JSON.parse(buf);
          resolve({
            ok: true,
            latest: String(j.tag_name || '').replace(/^v/i, '') || null,
            url: j.html_url || `https://github.com/${REPO}/releases`,
            notes: (j.body || '').slice(0, 4000),
            publishedAt: j.published_at || null,
          });
        } catch (e) { resolve({ ok: false, error: '返回值不是 JSON' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '请求超时' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

/**
 * @param {string} current 当前版本（package.json）
 * @returns {Promise<{ok:boolean,current:string,latest?:string,hasUpdate?:boolean,url?:string,error?:string}>}
 */
async function check(current) {
  if (cache.result && Date.now() - cache.at < CACHE_MS) {
    return { ...cache.result, current, cached: true };
  }
  const r = await fetchLatest();
  if (!r.ok) {
    const res = { ok: false, current, error: r.error };
    cache = { at: Date.now(), result: res };
    return res;
  }
  const res = {
    ok: true, current, latest: r.latest,
    hasUpdate: isNewer(r.latest, current),
    url: r.url, notes: r.notes, publishedAt: r.publishedAt,
  };
  cache = { at: Date.now(), result: res };
  return res;
}

module.exports = { check, isNewer, REPO };
