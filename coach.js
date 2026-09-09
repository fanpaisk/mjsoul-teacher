// 雀魂牌谱教练：解析对局事件流，对目标座位每一次摸切给出候选切牌评分与解释
// 用法: node coach.js record_<uuid>.json [座位号0-3]  （缺省分析全部座位，输出改进清单）
const fs = require('fs');
const path = require('path');

// ---------- 向听数计算（标准形 + 七对子 + 国士） ----------
function calcShanten(tiles34) {
  const t = tiles34.slice();
  let best = 8;
  // 标准形：递归拆解 面子/搭子
  function scan(idx, mentsu, taatsu, pair) {
    // 剩余牌剪枝
    let used = mentsu * 3 + taatsu * 2 + (pair ? 2 : 0);
    if (mentsu + taatsu > 4) {
      // 超出部分无效，回退已用对子/搭子
    }
    const sh = 8 - 2 * mentsu - Math.min(taatsu, Math.max(0, 4 - mentsu)) - (pair ? 1 : 0);
    if (sh < best) best = sh;
    if (idx >= 34) return;
    // 跳过该种牌
    let i = idx;
    while (i < 34 && t[i] === 0) i++;
    if (i >= 34) { scan(34, mentsu, taatsu, pair); return; }
    // 刻子
    if (t[i] >= 3) { t[i] -= 3; scan(i, mentsu + 1, taatsu, pair); t[i] += 3; }
    // 对子（作为雀头）
    if (!pair && t[i] >= 2) { t[i] -= 2; scan(i, mentsu, taatsu, true); t[i] += 2; }
    // 对子（作为搭子）
    if (t[i] >= 2) { t[i] -= 2; scan(i, mentsu, taatsu + 1, pair); t[i] += 2; }
    const suit = Math.floor(i / 9), r = i % 9;
    // 顺子
    if (suit < 3 && r <= 6 && t[i + 1] > 0 && t[i + 2] > 0) {
      t[i]--; t[i + 1]--; t[i + 2]--;
      scan(i, mentsu + 1, taatsu, pair);
      t[i]++; t[i + 1]++; t[i + 2]++;
    }
    // 两面/坎张搭子
    if (suit < 3 && r <= 7 && t[i + 1] > 0) { t[i]--; t[i + 1]--; scan(i, mentsu, taatsu + 1, pair); t[i]++; t[i + 1]++; }
    if (suit < 3 && r <= 6 && t[i + 2] > 0) { t[i]--; t[i + 2]--; scan(i, mentsu, taatsu + 1, pair); t[i]++; t[i + 2]++; }
    // 单张跳过
    scan(i + 1, mentsu, taatsu, pair);
  }
  scan(0, 0, 0, false);
  // 七对子
  let kinds = 0, pairs = 0;
  for (let i = 0; i < 34; i++) if (t[i] > 0) { kinds++; if (t[i] >= 2) pairs++; }
  const chiitoi = 6 - pairs + Math.max(0, 7 - kinds);
  // 国士
  const term = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];
  let kindsY = 0, hasPairY = false;
  for (const i of term) { if (t[i] > 0) kindsY++; if (t[i] >= 2) hasPairY = true; }
  const kokushi = 13 - kindsY - (hasPairY ? 1 : 0);
  return Math.min(best, chiitoi, kokushi);
}

// ---------- 工具 ----------
const disp = (t) => (t && t[0] === '0') ? '红5' + t[1] : t;
function tiles34Of(arr) { const t = new Array(34).fill(0); for (const x of arr) t[tileId(x)]++; return t; }
function tileId(x) {
  const raw = +x[0], s = x[1];
  const n = raw === 0 ? 5 : raw; // 红宝牌 0m/0p/0s 与 5m/5p/5s 同槽位
  if (s === 'm') return n - 1; if (s === 'p') return 9 + n - 1; if (s === 's') return 18 + n - 1;
  return 27 + n - 1; // z: 1z=东 ... 7z=中
}
const idTile = (i) => i < 9 ? (i + 1) + 'm' : i < 18 ? (i - 8) + 'p' : i < 27 ? (i - 17) + 's' : (i - 26) + 'z';

// ---------- 安危度（MVP：针对立直家） ----------
function safetyOf(tile, threats, rivers, visible) {
  if (!threats.length) return 100;
  let worst = 100;
  for (const p of threats) {
    const river = rivers[p];
    let s;
    if (river.includes(tile)) s = 98; // 现物
    else if (tile[1] === 'z') {
      const seen = visible[tileId(tile)];
      s = seen >= 3 ? 88 : seen === 2 ? 45 : 15;
    } else {
      const id = tileId(tile), suit = Math.floor(id / 9), r = id % 9;
      const has = (x) => river.includes(x);
      const nm = tile => tile; const tOf = (i2) => idTile(suit * 9 + i2);
      if (r >= 3 && r <= 5) s = has(tOf(r - 3)) && has(tOf(r + 3)) ? 78 : 22;       // 无筋中张
      else if (r === 6 || r === 7) s = has(tOf(r - 3)) && has(tOf(r + 2)) ? 78 : (has(tOf(r - 3)) || has(tOf(r + 2))) ? 60 : 22;
      else if (r === 8) s = has(tOf(r - 3)) ? 70 : 25;
      else if (r === 0) s = has(tOf(3)) ? 70 : 25;
      else if (r === 1) s = has(tOf(4)) ? 68 : 22;
      else if (r === 2) s = has(tOf(5)) ? 70 : 22;
      else s = 22;
    }
    worst = Math.min(worst, s);
  }
  return worst;
}

// ---------- 主分析 ----------
function analyze(record, seat) {  const D = record.details;
  const hands = [[], [], [], []], rivers = [[], [], [], []], melds = [[], [], [], []];
  const riichi = [false, false, false, false], wRiichi = [false, false, false, false];
  const seen = new Array(34).fill(0); // 全场可见牌（含自己手牌）
  let doraInds = [];
  let chang = 0, ju = 0, ben = 0, turn = 0;
  const decisions = [];
  const hand34 = () => tiles34Of(hands[seat]);

  function evalCandidates(drawnTile) {
    const hand = hands[seat];
    if (hand.length !== 14) return;
    const base = hand34();
    const uniq = [...new Set(hand)];
    const cands = uniq.map(t => {
      const t34 = base.slice(); t34[tileId(t)]--;
      const sh = calcShanten(t34);
      let kinds = 0, cnt = 0;
      for (let u = 0; u < 34; u++) {
        if (t34[u] >= 4) continue;
        const avail = 4 - seen[u] - (t34[u] > 0 ? 0 : 0);
        if (avail <= 0) continue;
        t34[u]++;
        if (calcShanten(t34) < sh) { kinds++; cnt += avail; }
        t34[u]--;
      }
      const threats = [0, 1, 2, 3].filter(p => p !== seat && riichi[p]);
      const saf = safetyOf(t, threats, rivers, seen);
      return { tile: t, shanten: sh, kinds, cnt, saf };
    });
    const threats = [0, 1, 2, 3].filter(p => p !== seat && riichi[p]);
    const maxCnt = Math.max(...cands.map(c => c.cnt), 1);
    const myShanten = Math.min(...cands.map(c => c.shanten));
    const wOff = !threats.length ? 1 : (myShanten <= 1 ? 0.45 : 0.2);
    for (const c of cands) {
      const offNorm = Math.round(100 * c.cnt / maxCnt);
      c.score = Math.round(wOff * offNorm + (1 - wOff) * c.saf);
    }
    cands.sort((a, b) => b.score - a.score || b.cnt - a.cnt);
    const actual = D.find ? null : null; // 占位，actual 由调用方传入
    decisions.push({
      round: (['东', '南', '西'][chang] || '?') + (ju + 1) + '局' + (ben ? '·' + ben + '本场' : ''),
      turn, drawn: drawnTile, candidates: cands.slice(0, 4),
      threats: threats.map(p => p),
    });
    return cands;
  }

  for (let idx = 0; idx < D.length; idx++) {
    const e = D[idx], d = e.data;
    if (e.name === 'RecordNewRound') {
      chang = d.chang; ju = d.ju; ben = d.ben; turn = 1;
      doraInds = (d.doras || []).slice();
      for (let s = 0; s < 4; s++) { hands[s] = (d['tiles' + s] || []).slice(); rivers[s] = []; melds[s] = []; riichi[s] = false; }
      for (let s = 0; s < 4; s++) for (const t of hands[s]) seen[tileId(t)]++;
      for (const t of doraInds) seen[tileId(t)]++;
      if (hands[seat].length === 14) {
        const drawn = hands[seat][13];
        const cands = evalCandidates(drawn);
        // 下一事件必是自己切牌
        const next = D[idx + 1];
        attachActual(cands, next);
      }
    } else if (e.name === 'RecordDealTile') {
      if (d.tile) { hands[d.seat].push(d.tile); seen[tileId(d.tile)]++; }
      if ((d.doras || []).length > doraInds.length) {
        for (const t of d.doras) if (!doraInds.includes(t)) { doraInds.push(t); seen[tileId(t)]++; }
      }
      if (d.seat === seat) { turn = rivers[seat].length + 1; const cands = evalCandidates(d.tile); const next = D[idx + 1]; attachActual(cands, next); }
    } else if (e.name === 'RecordDiscardTile') {
      const s = d.seat;
      const i = hands[s].indexOf(d.tile);
      if (i >= 0) hands[s].splice(i, 1);
      rivers[s].push(d.tile);
      if (d.is_liqi) riichi[s] = true;
    } else if (e.name === 'RecordChiPengGang') {
      const s = d.seat;
      (d.tiles || []).forEach((t, i2) => {
        seen[tileId(t)]++;
        if (s === seat && (d.froms || [])[i2] === s) {
          const i2h = hands[seat].indexOf(t);
          if (i2h >= 0) hands[seat].splice(i2h, 1);
        }
      });
      melds[s].push(d.tiles);
    } else if (e.name === 'RecordAnGangAddGang') {
      const s = d.seat;
      for (const t of (d.tiles || [])) {
        seen[tileId(t)]++;
        if (s === seat) { const i2 = hands[seat].indexOf(t); if (i2 >= 0) hands[seat].splice(i2, 1); }
      }
      melds[s].push(d.tiles);
    } else if (e.name === 'RecordHule' || e.name === 'RecordNoTile' || e.name === 'RecordLiuJu') {
      // 局终，等待下一个 NewRound
    }
  }

  function attachActual(cands, nextEv) {
    const dec = decisions[decisions.length - 1];
    if (!dec || !cands) return;
    if (nextEv && nextEv.name === 'RecordDiscardTile' && nextEv.data.seat === seat) {
      const tile = nextEv.data.tile;
      const rank = cands.findIndex(c => c.tile === tile) + 1;
      const c = cands[rank - 1];
      dec.actual = { tile, rank, score: c ? c.score : null };
      dec.actualIsLiqi = !!nextEv.data.is_liqi;
    } else dec.actual = null; // 吃碰杠等，跳过
  }

  return decisions.filter(d2 => d2.actual !== null && d2.actual !== undefined);
}

// ---------- 输出 ----------
function fmtDecision(d) {
  const lines = [];
  const act = d.actual;
  lines.push(`【${d.round}·${d.turn}巡】摸进 ${disp(d.drawn)}，切了 ${disp(act.tile)}（${act.score}分，第${act.rank}名）`);
  lines.push('建议：' + d.candidates.map(c => `${disp(c.tile)} ${c.score}`).join(' ｜ '));
  const top = d.candidates[0];
  const reasons = [];
  const threats = d.threats;
  if (threats.length) {
    if (top.saf >= 90) reasons.push('对立直家是现物，安全');
    else if (top.saf >= 60) reasons.push('筋安全牌，放铳风险低');
    else if (top.saf <= 30) reasons.push('无现物筋，属危险牌但进攻价值最高');
  }
  if (top.cnt === 0) reasons.push('有效进张已被封死，维持当前向听');
  else reasons.push(`进张 ${top.kinds} 种 ${top.cnt} 枚（切后 ${top.shanten} 向听）`);
  lines.push('▸ ' + disp(top.tile) + '：' + reasons.join('；'));
  return lines.join('\n');
}

function main() {
  const file = process.argv[2];
  const seatArg = process.argv[3];
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  const names = (record.head.accounts || []).sort((a, b) => a.seat - b.seat).map(a => a.nickname + '(' + a.account_id + ')');
  console.log('玩家: ' + names.map((n, i) => `座位${i}=${n}`).join(' | '));
  const seats = seatArg !== undefined ? [ +seatArg ] : [0, 1, 2, 3];
  const out = [];
  for (const seat of seats) {
    const decisions = analyze(record, seat);
    const mistakes = decisions.filter(d => d.actual.rank > 1 && d.candidates[0].score - d.actual.score >= 5);
    console.log(`\n===== 座位${seat} ${names[seat]} 共${decisions.length}手有效决策，可改进 ${mistakes.length} 手 =====`);
    out.push(`# 座位${seat} ${names[seat]}\n`);
    out.push(`有效决策 ${decisions.length} 手；与最优分差≥5 的可改进决策 ${mistakes.length} 手\n`);
    for (const d of decisions.slice(0, 0)) {}
    for (const m of mistakes.sort((a, b) => (b.candidates[0].score - b.actual.score) - (a.candidates[0].score - a.actual.score)).slice(0, 15)) {
      const block = fmtDecision(m);
      console.log(block);
      console.log('');
      out.push(block + '\n');
    }
  }
  const outFile = path.join(__dirname, 'review.md');
  fs.writeFileSync(outFile, out.join('\n'));
  console.log('已写入', outFile);
}
if (require.main === module) main();
module.exports = { analyze, calcShanten, tileId, disp, tiles34Of, idTile };
