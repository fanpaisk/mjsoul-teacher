// 牌谱复盘：抓谱 → 转 tenhou6 → akochan-reviewer 逐手审计 → 报告
// 用法:
//   node review.js <uuid|paipu链接> [seat]   审计任意牌谱（默认 seat 0）
//   node review.js --last [seat]             审计最近一局（教练在线时打完的局）
// 评审引擎: akochan（与实时建议的 Mortal 相互独立，交叉验证）
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const TMP = path.join(ROOT, 'tmp_review');
const REVIEWER = path.join(ROOT, 'engine', 'reviewer', 'akochan-reviewer.exe');
const AKOCHAN_DIR = path.join(ROOT, 'engine', 'reviewer', 'akochan');

const args = process.argv.slice(2);
let input = args[0] || '';
let seat = parseInt(args[1] || '0', 10);
if (isNaN(seat)) seat = 0;

function normId(s) {
  s = String(s).trim();
  const m = /paipu=([0-9]{6}-[0-9a-f-]+)/.exec(s);
  if (m) return m[1];
  s = s.replace(/_[a-zA-Z0-9]+$/, '');
  return s;
}
const isLast = input === '--last';

function findRecordFile(uuid) {
  // record_<YYMMDD>-<uuid>.json
  for (const f of fs.readdirSync(ROOT)) {
    if (f.startsWith('record_') && f.endsWith('.json') && f.includes(uuid)) return path.join(ROOT, f);
  }
  return null;
}

function fetchRecord(uuid) {
  const secPath = path.join(ROOT, 'secrets.local.json');
  if (!fs.existsSync(secPath)) {
    console.error('✗ 缺少登录令牌（secrets.local.json）。');
    console.error('  方法：保持教练服务端运行，然后刷新一次雀魂页面，令牌会自动捕获。');
    process.exit(1);
  }
  console.log('→ 抓取牌谱 ' + uuid + ' …');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'fetch_record2.js'), uuid], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) {
    console.error('✗ 抓取失败：\n' + (r.stdout || '') + (r.stderr || ''));
    process.exit(1);
  }
  const file = findRecordFile(uuid);
  if (!file) { console.error('✗ 抓取后未找到 record 文件'); process.exit(1); }
  return file;
}

function runReview(recordFile, uuid) {
  fs.mkdirSync(TMP, { recursive: true });
  const tenhouFile = path.join(TMP, 'tenhou_' + uuid + '.json');
  console.log('→ 转换为 tenhou6 格式 …');
  const c = spawnSync(process.execPath, [path.join(ROOT, 'to_tenhou.js'), recordFile, tenhouFile], { cwd: ROOT, encoding: 'utf8' });
  if (c.status !== 0) { console.error('✗ 转换失败：\n' + (c.stdout || '') + (c.stderr || '')); process.exit(1); }

  console.log('→ akochan 逐手审计中（整局约需几分钟）…');
  const r = spawnSync(REVIEWER, ['-i', tenhouFile, '-a', String(seat), '--json', '--no-open', '-d', AKOCHAN_DIR], {
    cwd: path.dirname(REVIEWER), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000,
  });
  // akochan-reviewer --json 把结果写到 out-dir 下的 json；stdout 是进度
  let reviewFile = null;
  const outDir = path.join(path.dirname(REVIEWER), 'out');
  const candidates = [path.join(path.dirname(REVIEWER), 'review.json'), path.join(TMP, uuid + '.json')];
  try { for (const f of fs.readdirSync(outDir || '')) candidates.push(path.join(outDir, f)); } catch (e) {}
  candidates.sort((a, b) => { try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch (e) { return 0; } });
  for (const f of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j.kyokus) { reviewFile = f; break; }
    } catch (e) {}
  }
  if (!reviewFile) {
    console.error('✗ 未找到评审输出。\nstdout: ' + (r.stdout || '').slice(-2000) + '\nstderr: ' + (r.stderr || '').slice(-2000));
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
}

// ---------- 报告 ----------
const HON = { E: '東', S: '南', W: '西', N: '北', P: '白', F: '發', C: '中' };
const dispT = (t) => HON[t] || (/^5[mps]r$/.test(t) ? '红' + t[0] + t[1] : t);
function mvStr(ms) {
  return ms.map(m => {
    switch (m.type) {
      case 'dahai': return '切' + dispT(m.pai);
      case 'chi': return '吃' + (m.pai || '');
      case 'pon': return '碰' + (m.pai || '');
      case 'daiminkan': return '明杠' + (m.pai || '');
      case 'ankan': return '暗杠' + (m.pai || '');
      case 'kakan': return '加杠' + (m.pai || '');
      case 'reach': return '立直';
      case 'hora': return '荣和';
      case 'none': return '跳过';
      default: return m.type;
    }
  }).join('+');
}
function kyokuLabel(i, k) {
  const n = typeof k.kyoku === 'number' ? k.kyoku : 0;
  const names = ['东1', '东2', '东3', '东4', '南1', '南2', '南3', '南4', '西1', '西2', '西3', '西4'];
  const base = names[n] || ('第' + (n + 1) + '局');
  return base + (k.honba ? '·' + k.honba + '本' : '');
}

function buildReport(review, sourceLabel) {
  const lines = [];
  let total = 0, agree = 0, tolerable = 0, disagree = 0;
  const bads = [];
  for (let ki = 0; ki < review.kyokus.length; ki++) {
    const k = review.kyokus[ki];
    for (const e of (k.entries || [])) {
      total++;
      if (e.acceptance === 'agree') agree++;
      else if (e.acceptance === 'tolerable') tolerable++;
      else disagree++;
      // EV 损失 = 最优候选期望 - 实际选择期望
      if (!e.details || !e.details.length) continue;
      let best = -Infinity, bestD = null, actD = null;
      const actKey = JSON.stringify((e.actual || []).map(m => ({ type: m.type, pai: m.pai })));
      for (const d of e.details) {
        const pt = d.review && d.review.pt_exp_total;
        if (typeof pt !== 'number') continue;
        if (pt > best) { best = pt; bestD = d; }
        if (JSON.stringify(d.moves.map(m => ({ type: m.type, pai: m.pai }))) === actKey) actD = d;
      }
      if (!bestD) continue;
      const loss = actD ? best - actD.review.pt_exp_total : null;
      bads.push({
        ki, label: kyokuLabel(ki, k), junme: e.junme, pai: e.pai,
        hand: (e.state.tehai || []).map(dispT).join(''),
        fuuros: (e.state.fuuros || []).length,
        actual: mvStr(e.actual || []),
        best: mvStr(bestD.moves),
        loss: loss === null ? null : loss,
        acceptance: e.acceptance,
      });
    }
  }
  bads.sort((a, b) => (b.loss || 0) - (a.loss || 0));
  const rate = total ? (agree / total * 100).toFixed(1) : '-';
  lines.push('# 牌谱复盘 ' + sourceLabel + '（座位 ' + review.target_actor + '）');
  lines.push('- 决策点 ' + total + ' 个：吻合 ' + agree + '（' + rate + '%）、可容忍 ' + tolerable + '、分歧 ' + disagree);
  lines.push('- 评审引擎：akochan（与实时建议的 Mortal 相互独立）');
  lines.push('- EV 为期望位次得分，损失 = 最优选择 − 实际选择，越大越差');
  lines.push('');
  const bad = bads.filter(b => b.loss !== null && b.loss > 0.01).slice(0, 12);
  if (!bad.length) { lines.push('## 没有损失超过 0.01 的分歧手，本局几乎没有失误 🎉'); return lines.join('\n'); }
  lines.push('## 损失最大的手（Top ' + bad.length + '）');
  bad.forEach((b, i) => {
    lines.push((i + 1) + '. 【' + b.label + '·第' + b.junme + '巡】损失 ' + b.loss.toFixed(3));
    lines.push('   手牌: ' + b.hand + (b.fuuros ? '（' + b.fuuros + '副露）' : '') + (b.pai ? '  摸: ' + dispT(b.pai) : ''));
    lines.push('   实际: ' + b.actual + '  →  应: ' + b.best);
  });
  return lines.join('\n');
}

// ---------- 主流程 ----------
(async () => {
  let recordFile, uuid;
  if (isLast) {
    const lastFile = path.join(ROOT, 'live', 'games', 'last_game.txt');
    if (!fs.existsSync(lastFile)) {
      console.error('✗ 没有记录到最近对局（需要在教练开启时打完一局）。请直接粘贴牌谱链接。');
      process.exit(1);
    }
    uuid = fs.readFileSync(lastFile, 'utf8').trim();
    console.log('最近一局: ' + uuid);
  } else {
    uuid = normId(input);
  }
  if (!/^[0-9]{6}-[0-9a-f-]{36}/.test(uuid)) {
    console.error('✗ 牌谱 ID 格式不对: ' + uuid + '（应形如 260905-ac2bde2e-…）');
    process.exit(1);
  }
  recordFile = findRecordFile(uuid);
  if (!recordFile) recordFile = fetchRecord(uuid);
  else console.log('使用本地已抓取的牌谱: ' + path.basename(recordFile));

  const review = runReview(recordFile, uuid);
  const report = buildReport(review, uuid);
  const outFile = path.join(ROOT, 'review_' + uuid + '.md');
  fs.writeFileSync(outFile, report + '\n');
  console.log('\n' + report);
  console.log('\n完整报告: ' + outFile);

  // 推摘要到游戏内面板（教练在线时）
  try {
    const first = report.split('\n').filter(l => l.startsWith('- ') || l.startsWith('# '));
    await fetch('http://127.0.0.1:18766/announce', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '【复盘完成】' + (first[1] || '').replace(/^- /, '') + '，详见 ' + path.basename(outFile) }),
    });
  } catch (e) { /* 教练不在线，跳过 */ }
})();
