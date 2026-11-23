'use strict';
/**
 * 诊断：日志轮转 + 一键导出诊断包。
 *
 * 目的很具体：用户说"教练不灵了"，以前只能让他翻 live_observed.log（2.9 MB 文本），
 * 现在给一个 zip，里面是版本、脱敏配置、日志尾部、端口状态、引擎诊断。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/** 超过 maxBytes 就把 file 轮成 file.1 … file.<keep> */
function rotate(file, maxBytes, keep) {
  const max = maxBytes || 10 * 1024 * 1024;
  const n = keep || 3;
  try {
    const st = fs.statSync(file);
    if (st.size < max) return false;
  } catch (e) { return false; }
  try {
    for (let i = n - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      const to = `${file}.${i + 1}`;
      if (fs.existsSync(from)) {
        try { fs.renameSync(from, to); } catch (e) {}
      }
    }
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch (e) { return false; }
}

function tail(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    const n = Math.min(st.size, maxBytes || 512 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, st.size - n);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (e) { return ''; }
}

function portState(port) {
  const r = spawnSync('cmd.exe', ['/c', `netstat -ano | findstr :${port} | findstr LISTENING`], { encoding: 'utf8', timeout: 4000 });
  return (r.stdout || '').trim();
}

/**
 * 打包诊断 zip 到 %TEMP%。返回 { ok, file } 或 { ok:false, error }。
 * @param {object} ctx { root, version, diagnostics, cfg, port }
 */
function exportBundle(ctx) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(os.tmpdir(), `coach-diag-${stamp}`);
  const zip = path.join(os.tmpdir(), `coach-diag-${stamp}.zip`);
  try {
    fs.mkdirSync(dir, { recursive: true });

    const info = {
      exportedAt: new Date().toISOString(),
      version: ctx.version,
      platform: `${os.platform()} ${os.release()} ${process.arch}`,
      node: process.version,
      port: ctx.port,
      config: ctx.cfg,
      engine: ctx.diagnostics,
      listeners: portState(ctx.port),
    };
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(info, null, 2), 'utf8');

    const logs = ['live/live_observed.log', 'live/server.log', 'live/live_coach.md'];
    for (const rel of logs) {
      const p = path.join(ctx.root, rel);
      if (fs.existsSync(p)) {
        fs.writeFileSync(path.join(dir, path.basename(rel)), tail(p, 512 * 1024), 'utf8');
      }
    }

    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${dir}\\*' -DestinationPath '${zip}' -Force`], { encoding: 'utf8', timeout: 20000 });
    if (!fs.existsSync(zip)) {
      return { ok: false, error: (r.stderr || 'Compress-Archive 失败').trim().slice(0, 300) };
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    return { ok: true, file: zip, bytes: fs.statSync(zip).size };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { rotate, tail, exportBundle, portState };
