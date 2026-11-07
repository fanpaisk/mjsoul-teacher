'use strict';
/**
 * 模型下载器：首次运行向导用。
 *
 * 为什么放在服务端而不是网页里：浏览器不能直接写文件，而模型必须落到 live/mjb/。
 * 这里只管"下载 + 校验 + 原子替换"，不做界面（界面在 app/web/setup.html 轮询 status()）。
 *
 * 设计要点：
 *   - 双源（HF → hf-mirror），任一失败自动换下一个
 *   - 先写 .part，校验 SHA256 通过后才 rename —— 半个文件绝不能被引擎看到
 *   - 全局只有一个下载任务（重复点击返回同一个任务状态）
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const TARGET_REL = path.join('live', 'mjb', 'mortal_full.pth');
const SHA256 = 'e5f6955b6f19007fd65315e53291b36994493046bc118b991b959e9dc596d660';
const SOURCES = [
  'https://huggingface.co/haor/Mortal-S42/resolve/main/weights/s42-inference.pth',
  'https://hf-mirror.com/haor/Mortal-S42/resolve/main/weights/s42-inference.pth',
];

const state = {
  state: 'idle',        // idle | downloading | verifying | done | error
  received: 0,
  total: 0,
  source: null,
  error: null,
  startedAt: null,
};

function status() {
  return {
    ...state,
    sha256: SHA256,
    target: TARGET_REL,
    percent: state.total ? Math.floor((state.received / state.total) * 100) : null,
  };
}

function httpGet(url, onRes, depth) {
  if ((depth || 0) > 5) throw new Error('重定向次数过多');
  https.get(url, { headers: { 'User-Agent': 'majsoul-coach' } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      const next = new URL(res.headers.location, url).toString();
      return httpGet(next, onRes, (depth || 0) + 1);
    }
    onRes(res);
  }).on('error', (e) => onRes(null, e));
}

/**
 * 开始下载。返回 { started: true } 或 { started: false, reason }。
 * 进度通过 status() 查询（网页每 500ms 轮询一次）。
 */
function start(rootDir) {
  if (state.state === 'downloading' || state.state === 'verifying') {
    return { started: false, reason: '已经在下载中' };
  }
  Object.assign(state, {
    state: 'downloading', received: 0, total: 0, source: null, error: null, startedAt: Date.now(),
  });

  const target = path.join(rootDir, TARGET_REL);
  const part = target + '.part';
  try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch (e) {}

  const trySource = (i) => {
    if (i >= SOURCES.length) {
      state.state = 'error';
      state.error = '两个下载源都失败了，请检查网络，或用离线权重包手动放到 live/mjb/mortal_full.pth';
      return;
    }
    const url = SOURCES[i];
    state.source = url;
    httpGet(url, (res, err) => {
      if (err || !res || res.statusCode !== 200) {
        try { res && res.resume(); } catch (e) {}
        return trySource(i + 1);
      }
      state.total = parseInt(res.headers['content-length'] || '0', 10) || 0;
      const out = fs.createWriteStream(part);
      const hash = crypto.createHash('sha256');
      res.on('data', (chunk) => {
        state.received += chunk.length;
        hash.update(chunk);
      });
      res.pipe(out);
      out.on('finish', () => {
        state.state = 'verifying';
        const got = hash.digest('hex');
        if (got !== SHA256) {
          try { fs.unlinkSync(part); } catch (e) {}
          state.state = 'error';
          state.error = `校验失败（SHA256 ${got.slice(0, 12)}… 应为 ${SHA256.slice(0, 12)}…）`;
          return;
        }
        try {
          fs.renameSync(part, target);
          state.state = 'done';
        } catch (e) {
          state.state = 'error';
          state.error = '写文件失败：' + e.message;
        }
      });
      out.on('error', (e) => { state.state = 'error'; state.error = e.message; });
      res.on('error', () => trySource(i + 1));
    }, 0);
  };
  trySource(0);
  return { started: true };
}

module.exports = { start, status, SHA256, TARGET_REL, SOURCES };
