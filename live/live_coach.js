// 雀魂实时教练服务端（Mortal 决策引擎版）
// 数据源: 页面钩子推送的 game-gateway 双向帧（.lq.ActionPrototype，XOR 去混淆后为 Action* 消息）
// 决策:  Mortal 神经网络本地推理（Akagi 捆绑 bot.py，行式 stdin/stdout，增量喂 mjai 事件）
// 启动: node live_coach.js                              （正常模式）
//       node live_coach.js --test=game_frames.jsonl     （离线重放捕获帧）
//       node live_coach.js --test-actions=actions.jsonl （离线重放 Action* 流）
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { decodeMsg, byPath } = require('./decode');
const mj = require('../coach.js'); // 向听数计算（补充解释用）

const args = process.argv.slice(2);
const TEST = args.find(a => a.startsWith('--test='));
const ARG_REVIEW = args.includes('--review');      // 复盘模式：切完牌才提醒
const ARG_DARK = args.includes('--dark-tiles');    // 默认黑牌模式：牌面默认为黑，按住查看
const TEST_ACTIONS = args.find(a => a.startsWith('--test-actions='));
const OUT_FILE = path.join(__dirname, (TEST || TEST_ACTIONS) ? 'live_test_output.md' : 'live_coach.md');
const OBS_LOG = path.join(__dirname, 'live_observed.log');
try { fs.writeFileSync(OUT_FILE, ''); } catch (e) {} // 每次启动从新文件开始

// ---------- Mortal 引擎（Akagi 嵌入式 Python + bot.py） ----------
const MORTAL_PY = path.join(__dirname, '..', 'engine', 'akagi', 'akagi-3.7.1-windows-x64', 'runtime', 'python', 'x86_64-pc-windows-msvc', 'python.exe');
const MORTAL_BOT_DIR = path.join(__dirname, 'mjb');
const MORTAL_BOT = path.join(MORTAL_BOT_DIR, 'bot.py');

const MORTAL = {
  proc: null,
  pending: [],     // 等待响应的回调（行式协议 FIFO）
  dead: true,
  restarts: 0,
  sentUpTo: 0,     // 引擎已消费的 mjaiBuffer 前缀长度
  gaveUp: false,   // 本场引擎已放弃（避免每巡刷屏）
};

const HON = { E: '東', S: '南', W: '西', N: '北', P: '白', F: '發', C: '中' };
function disp(t) {
  if (!t) return '?';
  if (HON[t]) return HON[t];
  if (/^5[mps]r$/.test(t)) return '红5' + t[1];
  if (t[0] === '0') return '红5' + t[1]; // 雀魂原始命名 0m/0p/0s
  if (t[1] === 'z') return ({ '1z': '東', '2z': '南', '3z': '西', '4z': '北', '5z': '白', '6z': '發', '7z': '中' })[t] || t;
  return t;
}
// 牌名 → libriichi mjai 命名（字牌 E/S/W/N/P/F/C，红宝 5mr/5pr/5sr）
const HON2 = { '1z': 'E', '2z': 'S', '3z': 'W', '4z': 'N', '5z': 'P', '6z': 'F', '7z': 'C' };
function T(t) { return !t ? '?' : HON2[t] || (t[0] === '0' ? '5' + t[1] + 'r' : t); }

// 悬浮面板数据环（最近 300 条输出，/panel 接口按序号增量拉取）
const PANEL = { idx: 0, buf: [] };
function out(line) {
  fs.appendFileSync(OUT_FILE, line + '\n');
  console.log(line);
  PANEL.buf.push({ i: ++PANEL.idx, text: line });
  if (PANEL.buf.length > 300) PANEL.buf.shift();
}
function obs(msg) {
  try { fs.appendFileSync(OBS_LOG, new Date().toISOString().slice(11, 19) + ' ' + msg + '\n'); } catch (e) {}
}

// ---------- 用户偏好（复盘模式等） ----------
// ---------- Mortal 引擎管理 ----------
function mortalStart() {
  try { if (MORTAL.proc) MORTAL.proc.kill(); } catch (e) {}
  MORTAL.restarts++;
  if (MORTAL.restarts > 8) {
    MORTAL.gaveUp = true;
    out('⚠ Mortal 引擎多次异常，本场停用（下局自动恢复）');
    return false;
  }
  MORTAL.proc = spawn(MORTAL_PY, [MORTAL_BOT], {
    cwd: MORTAL_BOT_DIR,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, OMP_NUM_THREADS: '8' },
  });
  MORTAL.dead = false;
  MORTAL.pending = [];
  MORTAL.sentUpTo = 0; // 新进程状态为空 → 下个批次从头重放
  const rl = readline.createInterface({ input: MORTAL.proc.stdout });
  rl.on('line', (line) => {
    const cb = MORTAL.pending.shift();
    if (cb) cb(line);
  });
  MORTAL.proc.on('exit', (c) => {
    MORTAL.dead = true;
    for (const cb of MORTAL.pending.splice(0)) cb(null);
    if (S.inGame) out('⚠ Mortal 引擎退出（code ' + c + '），下次出牌自动重启…');
  });
  MORTAL.proc.stdin.on('error', () => {});
  return true;
}
function mortalAlive() {
  return MORTAL.proc && !MORTAL.dead && MORTAL.proc.exitCode === null;
}
/** 发送一批新事件（一行一个 JSON 数组），返回引擎决策。bot.py 按行顺序应答。 */
function mortalSend(batch) {
  return new Promise((resolve) => {
    if (!mortalAlive()) { resolve(null); return; }
    const cb = (resp) => resolve(resp);
    MORTAL.pending.push(cb);
    try { MORTAL.proc.stdin.write(JSON.stringify(batch) + '\n'); } catch (e) { resolve(null); }
    setTimeout(() => {
      const i = MORTAL.pending.indexOf(cb);
      if (i >= 0) { MORTAL.pending.splice(i, 1); resolve(null); }
    }, 60000);
  });
}

// ---------- 全局状态 ----------
const S = {
  seat: null,          // 绝对座位号（首条个性化 DealTile 揭晓）
  inGame: false,
  gameStarted: false,  // start_game 是否已入队
  kyokuActive: false,
  mjaiBuffer: [],      // 本场对局的全部 mjai 事件（引擎重启时整段重放）
  preStart: [],        // 座位未知时扣住的事件（start_game 之前不能喂引擎）
  pendingNewRound: null,
  reqSeq: 0,
  junme: 0,
  leftTiles: null,
  hands: [[], [], [], []],     // 原始雀魂牌名（自家真实手牌，他家仅用于扣牌）
  rivers: [[], [], [], []],
  riichi: [false, false, false, false],
  melds: [[], [], [], []],
  ponMelds: [[], [], [], []],  // 各家碰组（加杠时还原 consumed 用）
  seen: new Array(34).fill(0), // 全场可见牌计数
  lastDoras: [],
  pendingReachAccept: null,    // 立直宣言牌未被荣和/鸣牌时，下一事件前补 reach_accepted
  lastDrawn: null,
  lastAdvice: null,
  reviewMode: false,     // 复盘模式：切完牌才出现该手提醒
  pendingOpReview: null, // 待事后复盘的鸣牌机会 { drawn, bufLen }            // { tile, rank, value }[] 最近一次候选
};
try {
  const st = JSON.parse(fs.readFileSync(path.join(__dirname, 'coach_settings.json'), 'utf8'));
  if (typeof st.reviewMode === 'boolean') S.reviewMode = st.reviewMode;
  if (typeof st.tileDark === 'boolean') S.tileDark = st.tileDark;
} catch (e) {}
if (ARG_REVIEW) S.reviewMode = true;
if (ARG_DARK) S.tileDark = true;


// ---------- mjai 事件输出（bot.py 增量消费） ----------
function pushEv(ev) {
  if (S.resyncing) return; // 重连重放的历史事件：去重丢弃，引擎状态不动
  if (!S.gameStarted) { S.preStart.push(ev); return; }
  S.mjaiBuffer.push(ev);
}
function ensureGameStart() {
  if (S.gameStarted) return;
  S.gameStarted = true;
  S.mjaiBuffer.push({ type: 'start_game', names: ['P0', 'P1', 'P2', 'P3'], id: S.seat });
}
function diffDoras(list) {
  for (const t of (list || [])) {
    if (!t || S.lastDoras.includes(t)) continue;
    S.lastDoras.push(t);
    pushEv({ type: 'dora', dora_marker: T(t) });
  }
}
function flushReachAccept() {
  if (S.pendingReachAccept === null) return;
  pushEv({ type: 'reach_accepted', actor: S.pendingReachAccept });
  S.pendingReachAccept = null;
}
/** 发 start_kyoku（必要时先补 end_kyoku），返回庄家起手摸牌（自家庄家时） */
function emitStart(d) {
  ensureGameStart();
  if (S.kyokuActive) pushEv({ type: 'end_kyoku' });
  S.kyokuActive = true;
  const myRaw = (d.tiles || []).slice();
  let dealerDraw = null;
  if (myRaw.length === 14) dealerDraw = myRaw.pop(); // 庄家第 14 张按 mjai 惯例作为 tsumo
  const tehais = [0, 1, 2, 3].map(s => s === S.seat ? myRaw.map(T) : new Array(13).fill('?'));
  pushEv({
    type: 'start_kyoku',
    bakaze: ['E', 'S', 'W', 'N'][d.chang] || 'E',
    kyoku: d.ju + 1,
    honba: d.ben || 0,
    kyotaku: d.liqibang || 0,
    oya: d.ju,
    scores: d.scores || [25000, 25000, 25000, 25000],
    tehais,
    dora_marker: T((d.doras && d.doras[0]) || d.dora || null),
  });
  S.lastDoras = ((d.doras && d.doras[0]) || d.dora) ? [((d.doras && d.doras[0]) || d.dora)] : [];
  if (dealerDraw) pushEv({ type: 'tsumo', actor: S.seat, pai: T(dealerDraw) });
  return dealerDraw;
}
/** 座位揭晓时把扣住的事件接回主缓冲 */
function bootstrapFromPending() {
  S.mjaiBuffer = [];
  ensureGameStart();
  const dealerDraw = emitStart(S.pendingNewRound);
  S.pendingNewRound = null;
  for (const ev of S.preStart) S.mjaiBuffer.push(ev);
  S.preStart = [];
  return dealerDraw;
}

// ---------- 决策请求（promise 链串行化，引擎恰好消费每个事件一次） ----------
let adviseChain = Promise.resolve();
function requestAdvice(drawn, kind, endOffset) {
  S.reqSeq++;
  const mySeq = S.reqSeq;
  const tag = kind === 'call'
    ? '鸣牌后推荐：'
    : kind === 'review'
      ? '本手复盘 · 推荐：'
      : kind === 'review-op'
        ? `事后复盘（他人切 ${disp(drawn)}）· 我可：`
        : kind === 'op'
      ? `他人切 ${disp(drawn)}，我可：`
      : kind === 'chan'
        ? `他人杠 ${disp(drawn)}，我可：`
        : '推荐：';
  const suppressStale = !(TEST || TEST_ACTIONS || S.reviewMode); // 复盘模式下每手都要出现
  const upto = S.mjaiBuffer.length - Math.max(0, endOffset || 0); // 批次边界在请求时固定（决策点语义位置）
  adviseChain = adviseChain.then(async () => {
    if (!S.inGame || S.resyncing || S.kyokuEngineBanned || !S.kyokuActive) return;
    if (MORTAL.gaveUp) return; // 本场已放弃，静默记录
    if (!mortalAlive() && !mortalStart()) { out('（引擎不可用，自主判断）'); return; }
    if (upto <= MORTAL.sentUpTo) { // 无新事件或缓冲被重建，避免发出空批次
      MORTAL.sentUpTo = upto;
      return;
    }
    const batch = S.mjaiBuffer.slice(MORTAL.sentUpTo, upto);
    const resp = await mortalSend(batch);
    MORTAL.sentUpTo = upto;
    if (suppressStale && mySeq !== S.reqSeq) { obs(`stale verdict seq=${mySeq} cur=${S.reqSeq}`); return; }
    onMortalVerdict(resp, tag, kind, drawn);
  }).catch(e => obs('advise error: ' + ((e && e.message) || e)));
}

// ---------- Mortal 决策输出 → 教练文案 ----------
const CN_ACT = { Reach: '立直', Pon: '碰', Daiminkan: '明杠', Ankan: '暗杠', Kakan: '加杠', Ron: '荣和', Tsumo: '自摸', Ryukyoku: '流局', Skip: '跳过', Nukidora: '拔北' };
function itemStr(x) {
  const v = x.value || '';
  const label = x.label || '';
  if (/^Dahai /.test(label)) {
    const pai = (x.pais || [])[0];
    return pai ? disp(pai) + ' ' + v : label + ' ' + v;
  }
  const cn = CN_ACT[label] || (label.startsWith('Chi') ? '吃' : label);
  // 鸣牌候选的 tiles 是 mahgen DSL："55m|5m"（|前=手中搭的两组，|后=荣和的那张）
  if (x.tiles) {
    const bar = x.tiles.indexOf('|');
    const consumed = bar >= 0 ? x.tiles.slice(0, bar) : x.tiles;
    const called = bar >= 0 ? x.tiles.slice(bar + 1) : '';
    if (/Pon|Daiminkan|Kakan|Ankan/.test(label)) return `${cn} ${disp(called || consumed)} ${v}`;
    if (label.startsWith('Chi')) return `吃 ${consumed}${disp(called)} ${v}`;
    return `${cn} ${x.tiles} ${v}`;
  }
  const extra = x.pais && x.pais[0] ? ' ' + disp(x.pais[0]) : '';
  return cn + extra + ' ' + v;
}
function onMortalVerdict(resp, tag, kind, actual) {
  let mv = null;
  try { mv = JSON.parse(resp); } catch (e) {}
  if (!mv) { out('⚠ 引擎无响应，自主判断'); return; }
  const meta = mv.meta || {};
  const items = (meta.show && meta.show.items) || [];
  if (!items.length) {
    // 决策点没有带候选列表 —— 引擎状态失步。连续两次则熔断本局（避免杀-重启死循环），
    // 熔断会在下一局的 start_kyoku 自动解除
    S.emptyShow = (S.emptyShow || 0) + 1;
    S.lastAdvice = null;
    if (S.emptyShow >= 2) {
      if (!S.kyokuEngineBanned) {
        S.kyokuEngineBanned = true;
        out('⚠ 引擎连续异常，本局剩余停用（下局自动恢复）');
      }
    } else {
      out('⚠ 引擎未给出候选（重启重放中）');
      healEngine('no show items');
    }
    return;
  }
  out(tag + items.map(itemStr).join(' ｜ '));
  S.lastAdvice = items.map((x, i) => ({ tile: (x.pais || [])[0], rank: i + 1, value: x.value || '' }));
  if (kind === 'review' && actual) {
    const t = T(actual);
    const c = S.lastAdvice.find(x => x.tile === t);
    out(`  → 你切了 ${disp(t)}` + (c ? `（Mortal 第 ${c.rank} 名 ${c.value}）` : '（不在推荐之列）'));
  }
  S.emptyShow = 0;
  MORTAL.restarts = 0; // 决策成功 = 引擎健康，重置熔断计数
}
/** 引擎状态失步自愈：杀掉进程，下次决策时全量重放 */
function healEngine(why) {
  obs('engine heal: ' + why);
  try { if (MORTAL.proc && MORTAL.proc.exitCode === null) MORTAL.proc.kill(); } catch (e) {}
}

/** 断线重连重同步：引擎与事件缓冲【原封不动】，进入"重放去重"模式。
 *  重放的历史事件按牌山计数识别并丢弃（计数随摸牌单调递减，
 *  计数 < 最后已见值的事件即新事件），无缝续上，无需重建。 */
function onGameResync() {
  out('⚠ 检测到断线重连，正在对齐牌局（几秒内自动恢复）…');
  obs('resync on reconnect');
  S.resyncing = true;
  S.resyncLastLeft = S.leftTiles; // 最后已见的牌山剩余数
  S.lastAdvice = null;
  S.reqSeq++; // 作废在途决策
}
/** 重同步期间的事件分流：识别重放历史 vs 新事件 */
function handleResyncAction(name, d) {
  if (name === 'ActionDealTile') {
    if (d.left_tile_count === undefined) { obs('resync: DealTile 无计数，丢弃'); return; }
    if (S.resyncLastLeft !== null && S.resyncLastLeft !== undefined && d.left_tile_count < S.resyncLastLeft) {
      // 新事件！退出重同步，按正常流程处理本事件
      S.resyncing = false;
      out('✓ 牌局已对齐，建议恢复');
      obs(`resync exit at left=${d.left_tile_count}`);
      handleAction(name, d);
      return;
    }
    S.resyncLastLeft = d.left_tile_count; // 重放历史（含与断点相同的最后事件）
    return;
  }
  if (name === 'ActionNewRound') {
    // 局边界：标签没见过的 = 真正的新一局（重连跨局场景）
    const label = (['东', '南', '西', '北'][d.chang] || '?') + (d.ju + 1) + '局' + (d.ben ? '·' + d.ben + '本场' : '');
    if (S.kyokuLabelsSeen && S.kyokuLabelsSeen.has(label)) { obs('resync: 重放局 ' + label + '，丢弃'); return; }
    S.resyncing = false;
    out('✓ 牌局已对齐（新一局），建议恢复');
    handleAction(name, d);
    return;
  }
  // 其余动作（切牌/鸣牌/和了等）都是重放历史的一部分，丢弃
}

// ---------- Action* 处理 ----------
function handleAction(name, d) {
  if (S.resyncing) { handleResyncAction(name, d); return; }
  if (S.pendingOpReview) {
    const pr = S.pendingOpReview;
    S.pendingOpReview = null;
    requestAdvice(pr.drawn, 'review-op', Math.max(0, S.mjaiBuffer.length - pr.bufLen));
  }
  // 立直宣言牌存活确认：下一个事件若非荣和/流局/鸣牌，则立直成立
  if (S.pendingReachAccept !== null && !['ActionHule', 'ActionNoTile', 'ActionLiuJu', 'ActionChiPengGang'].includes(name)) {
    flushReachAccept();
  }

  if (name === 'ActionNewRound') {
    if (!S.inGame) {
      S.inGame = true;
      MORTAL.restarts = 0;
      MORTAL.gaveUp = false;
      out('\n===== 新对局开始 ' + new Date().toLocaleTimeString('zh-CN') + ' =====');
    }
    S.kyokuLabel = (['东', '南', '西', '北'][d.chang] || '?') + (d.ju + 1) + '局' + (d.ben ? '·' + d.ben + '本场' : '');
    (S.kyokuLabelsSeen = S.kyokuLabelsSeen || new Set()).add(S.kyokuLabel); // 登记本局标签（重放去重用）
    S.kyokuEngineBanned = false;
    S.emptyShow = 0;
    S.junme = 0;
    S.leftTiles = d.left_tile_count !== undefined ? d.left_tile_count : null;
    S.expLeft = d.left_tile_count !== undefined ? d.left_tile_count : null; // 漏帧守恒检查基准
    S.dealCnt = 0;
    S.driftWarned = false;
    S.hands = [[], [], [], []];
    S.rivers = [[], [], [], []];
    S.riichi = [false, false, false, false];
    S.melds = [[], [], [], []];
    S.ponMelds = [[], [], [], []];
    S.lastDrawn = null;
    S.lastAdvice = null;
    S.lastLiqiTile = null;
    S.pendingReachAccept = null;
    S.myTiles = (d.tiles || []).slice();
    // 可见牌计数重置：自家手牌 + 宝牌指示牌
    S.seen = new Array(34).fill(0);
    for (const t of S.myTiles) S.seen[mj.tileId(t)]++;
    if (S.seat === null) { // 注意座位 0 是合法值，不能用 falsy 判断
      if (S.myTiles.length === 14) {
        // 14 张起手 = 自家坐庄 → 座位立刻揭晓
        S.seat = d.ju;
        out('> 识别到你的座位: ' + S.seat + '（庄家）');
        S.pendingNewRound = d; // bootstrap 需要开局数据
        const drawn = bootstrapFromPending();
        S.hands[S.seat] = S.myTiles.slice();
        if (d.dora) S.seen[mj.tileId(d.dora)]++;
        out(`【${S.kyokuLabel}】宝牌 ${T(d.dora) || '?'}｜点数 ${JSON.stringify(d.scores || [])}`);
        if (drawn) { S.junme = 1; S.lastDrawn = drawn; requestAdvice(drawn, 'draw'); }
      } else {
        // 非庄家：扣起，等首条个性化摸牌揭晓座位
        S.pendingNewRound = d;
        out(`【${S.kyokuLabel}】宝牌 ${T(d.dora) || '?'}（等待首摸以识别座位…）`);
      }
      return;
    }
    // 座位已知：直接发本局开局
    const drawn = emitStart(d);
    S.hands[S.seat] = S.myTiles.slice();
    if (d.dora) S.seen[mj.tileId(d.dora)]++;
    out(`【${S.kyokuLabel}】宝牌 ${T(d.dora) || '?'}｜点数 ${JSON.stringify(d.scores || [])}`);
    if (drawn) { S.junme = 1; S.lastDrawn = drawn; requestAdvice(drawn, 'draw'); }
    return;
  }

  if (name === 'ActionDealTile') {
    diffDoras(d.doras);
    // 漏帧守恒检查：客户端报的牌山剩余数每次摸牌应恰好 -1，对不上 = 漏帧
    if (d.left_tile_count !== undefined) {
      if (S.expLeft === null || S.expLeft === undefined) {
        S.expLeft = d.left_tile_count; // 基线建立（重同步后首摸）
        S.dealCnt = 0;
      } else {
        S.dealCnt++;
        const expect = S.expLeft - S.dealCnt;
        if (d.left_tile_count !== expect) {
          obs(`drift: client=${d.left_tile_count} expect=${expect} (dealCnt=${S.dealCnt})`);
          if (!S.driftWarned) {
            S.driftWarned = true;
            out(`⚠ 牌数不齐（客户端余 ${d.left_tile_count}，推算应余 ${expect}）——检测到漏帧，引擎重启校正`);
            healEngine('tile count drift');
          }
          S.expLeft = d.left_tile_count;
          S.dealCnt = 0;
        }
      }
      S.leftTiles = d.left_tile_count;
    }
    if (S.seat === null) { // 注意座位 0 是合法值，不能用 falsy 判断
      if (d.tile) {
        // 第一条带牌面的摸牌 = 自家摸牌 → 座位揭晓，接回扣住的事件
        S.seat = d.seat;
        out('> 识别到你的座位: ' + S.seat);
        if (S.pendingNewRound) {
          bootstrapFromPending();
          S.hands[S.seat] = S.myTiles.slice(); // 13 张起手（此时才补上）
        }
        // 服务端中途重启时没有开局数据：先只记座位，等下一局 ActionNewRound 再启动引擎
      } else {
        pushEv({ type: 'tsumo', actor: d.seat, pai: '?' });
        return;
      }
    }
    if (d.seat === S.seat) {
      flushReachAccept();
      pushEv({ type: 'tsumo', actor: S.seat, pai: T(d.tile) });
      if (d.tile) {
        S.hands[S.seat].push(d.tile);
        S.seen[mj.tileId(d.tile)]++;
      }
      S.lastDrawn = d.tile;
      S.junme = S.rivers[S.seat].length + 1;
      S.leftTiles = d.left_tile_count !== undefined ? d.left_tile_count : S.leftTiles;
      if (d.tile && !S.reviewMode) requestAdvice(d.tile, 'draw');
    } else {
      pushEv({ type: 'tsumo', actor: d.seat, pai: '?' });
    }
    return;
  }

  if (name === 'ActionDiscardTile') {
    diffDoras(d.doras);
    const s = d.seat;
    const pai = T(d.tile);
    if (s === S.seat) {
      const i = S.hands[s].indexOf(d.tile);
      if (i >= 0) S.hands[s].splice(i, 1);
      if (S.lastAdvice) {
        const c = S.lastAdvice.find(x => x.tile === pai);
        out(`  你切了 ${disp(pai)}` + (c ? `（Mortal 第 ${c.rank} 名 ${c.value}）` : '（不在推荐之列）'));
      }
      S.lastAdvice = null;
      S.lastDrawn = null;
      S.rivers[s].push(d.tile);
      if (d.tile) S.seen[mj.tileId(d.tile)]++;
    } else {
      S.rivers[s].push(d.tile);
      if (d.tile) S.seen[mj.tileId(d.tile)]++;
    }
    const beforePush = S.mjaiBuffer.length;
    if (d.is_liqi) {
      pushEv({ type: 'reach', actor: s });
      S.riichi[s] = true;
      S.pendingReachAccept = s;
      S.lastLiqiTile = d.tile;
      out(`  座位${s} 立直宣言！`);
    }
    pushEv({ type: 'dahai', actor: s, pai, tsumogiri: !!d.moqie });
    if (s === S.seat && S.reviewMode && d.tile) {
      requestAdvice(d.tile, 'review', S.mjaiBuffer.length - beforePush);
    }
    // 他家切牌后我有吃/碰/杠/荣和机会 → 请求操作评分（含跳过）
    if (s !== S.seat && d.tile) {
      const ops = d.operation && d.operation.operation_list;
      if (ops && ops.length) {
        if (S.reviewMode) S.pendingOpReview = { drawn: d.tile, bufLen: S.mjaiBuffer.length };
        else requestAdvice(d.tile, 'op');
      }
    }
    return;
  }

  if (name === 'ActionChiPengGang') {
    diffDoras(d.doras);
    const tiles = (Array.isArray(d.tiles) ? d.tiles : [d.tiles]).map(T);
    const froms = Array.isArray(d.froms) && Array.isArray(d.froms[0]) ? d.froms[0] : (d.froms || []);
    const calledIdx = froms.findIndex(f => f !== d.seat);
    const called = calledIdx >= 0 ? tiles[calledIdx] : tiles[0];
    const target = calledIdx >= 0 ? froms[calledIdx] : null;
    const consumed = tiles.filter((_, i) => i !== calledIdx).sort();
    if (d.type === 0) pushEv({ type: 'chi', actor: d.seat, target, pai: called, consumed });
    else if (d.type === 1) {
      pushEv({ type: 'pon', actor: d.seat, target, pai: called, consumed });
      // 记录碰组，供加杠时还原 consumed（含红宝牌情形）
      (S.ponMelds[d.seat] = S.ponMelds[d.seat] || []).push([called, ...consumed].sort());
    }
    else pushEv({ type: 'daiminkan', actor: d.seat, target, pai: called, consumed });
    // 鸣牌若吃掉立直宣言牌，立直不成立（reach_accepted 不再补发）
    if (S.pendingReachAccept !== null && calledIdx >= 0 && d.tiles[calledIdx] === S.lastLiqiTile) {
      S.pendingReachAccept = null;
    }
    S.melds[d.seat].push(tiles);
    if (d.seat === S.seat) {
      for (let i = 0; i < tiles.length; i++) {
        if (froms[i] === d.seat) {
          const h = S.hands[d.seat].indexOf(d.tiles[i]);
          if (h >= 0) S.hands[d.seat].splice(h, 1);
        }
      }
      S.lastDrawn = null;
    }
    if (calledIdx >= 0) S.seen[mj.tileId(tiles[calledIdx])]++;
    out(`  座位${d.seat} ${d.type === 0 ? '吃' : d.type === 1 ? '碰' : '明杠'} ${tiles.map(disp).join('')}`);
    if (d.seat === S.seat && !S.reviewMode) requestAdvice(null, 'call'); // 鸣牌后立即请求切牌建议
    return;
  }

  if (name === 'ActionAnGangAddGang') {
    diffDoras(d.doras);
    const tile = T(Array.isArray(d.tiles) ? d.tiles[0] : d.tiles);
    const raw = Array.isArray(d.tiles) ? d.tiles[0] : d.tiles;
    if (d.type === 3 || d.type === 0) {
      pushEv({ type: 'ankan', actor: d.seat, consumed: [tile, tile, tile, tile] });
      if (d.seat === S.seat) {
        for (let k = 0; k < 4; k++) {
          const h = S.hands[d.seat].indexOf(raw);
          if (h >= 0) S.hands[d.seat].splice(h, 1);
        }
      }
    } else {
      const meld = (S.ponMelds[d.seat] || []).find(m => m.includes(tile));
      pushEv({ type: 'kakan', actor: d.seat, pai: tile, consumed: meld || [tile, tile, tile] });
      if (d.seat === S.seat) {
        const h = S.hands[d.seat].indexOf(raw);
        if (h >= 0) S.hands[d.seat].splice(h, 1);
      }
    }
    S.melds[d.seat].push([tile, tile, tile, tile]);
    S.lastDrawn = null;
    if (d.seat !== S.seat) S.seen[mj.tileId(tile)]++; // 他家暗杠亮明牌张
    out(`  座位${d.seat} ${d.type === 3 || d.type === 0 ? '暗杠' : '加杠'} ${disp(tile)}`);
    // 他家加杠 → 可抢杠荣和
    if (d.seat !== S.seat) {
      const ops = d.operation && d.operation.operation_list;
      if (ops && ops.length) requestAdvice(tile, 'chan');
    }
    return;
  }

  if (name === 'ActionHule') {
    const hules = d.hules || [];
    if (hules.length > 1) {
      pushEv({ type: 'ryukyoku' }); // 双响/三家和：按流局收尾（下局 start_kyoku 校正点数）
      out('【和了】多家和了（按流局简化处理）');
      return;
    }
    const h = hules[0];
    if (h) {
      const deltas = d.delta_scores || [];
      let target = h.seat;
      if (!h.zimo) {
        // 荣和：放铳者 = 分数变动为负的座位（dadian 是点数不是座位）
        const negs = deltas.map((v, i) => ({ v, i })).filter(x => x.v < 0);
        target = negs.length === 1 ? negs[0].i : (negs.find(x => -x.v === h.dadian) || { i: h.seat }).i;
      }
      pushEv({ type: 'hora', actor: h.seat, target, deltas, ura_markers: (h.li_doras || []).map(T) });
      out(`【和了】座位${h.seat} ${h.zimo ? '自摸' : '荣和'} ${h.count || 0}番${h.fu || 0}符 ${h.point_sum || ''}点${h.title ? '（' + h.title + '）' : ''}`);
    }
    return;
  }
  if (name === 'ActionNoTile' || name === 'ActionLiuJu') {
    pushEv({ type: 'ryukyoku' });
    out('【流局】');
    return;
  }
  // ActionMJStart / ActionGangResult / ActionBaBei 等忽略
}

function onGameEnd() {
  out('===== 对局结束 =====');
  // 记录本局 UUID，供复盘（node review.js --last）
  try {
    if (S.gameUuid) {
      const dirG = path.join(__dirname, 'games');
      fs.mkdirSync(dirG, { recursive: true });
      fs.writeFileSync(path.join(dirG, 'last_game.txt'), S.gameUuid + '\n');
    }
  } catch (e) {}
  S.resyncing = false;
  S.kyokuEngineBanned = false;
  S.emptyShow = 0;
  S.kyokuLabelsSeen = new Set();
  S.inGame = false;
  S.seat = null;
  S.gameStarted = false;
  S.kyokuActive = false;
  S.pendingNewRound = null;
  S.preStart = [];
  S.mjaiBuffer = [];
  S.kyokuLabel = null;
  S.lastAdvice = null;
  MORTAL.sentUpTo = 0;
  MORTAL.restarts = 0;
  MORTAL.gaveUp = false;
  S.reqSeq++; // 作废在途决策
}

// ---------- 帧解码与分发 ----------
function handleFrame(dir, url, hex) {
  const buf = Buffer.from(hex, 'hex');
  const off = dir === 'in' ? 1 : 3; // 游戏网关: 服务器推帧前缀 1 字节，客户端帧前缀 3 字节(类型+seq)
  if (buf.length <= off) return;
  if (dir === 'out' && buf[0] !== 2) return;
  if (dir === 'in' && buf[0] !== 1 && buf[0] !== 3) return;
  let inner = buf.subarray(off), name = '';
  try {
    const w = decodeMsg('Wrapper', inner);
    if (w.name && typeof w.name === 'string') { name = w.name; }
    if (w.data) inner = w.data;
  } catch (e) {
    obs(`decode fail: ${dir} ${url.replace('wss://', '')} len=${buf.length} head=${buf.subarray(0, 4).toString('hex')} — ${e.message}`);
    return;
  }
  if (typeof name !== 'string') { obs('bad frame: non-string name'); return; }

  // 出向帧：捕获登录令牌（供牌谱抓取）与对局 UUID（供复盘定位）
  if (dir === 'out' && name.includes('oauth2Login')) {
    try {
      const req = decodeMsg('ReqOauth2Login', inner);
      if (req && req.access_token) {
        const secPath = path.join(__dirname, '..', 'secrets.local.json');
        let sec = {};
        try { sec = JSON.parse(fs.readFileSync(secPath, 'utf8')); } catch (e) {}
        sec.access_token = req.access_token;
        if (req.device_id) sec.device_id = req.device_id;
        fs.writeFileSync(secPath, JSON.stringify(sec, null, 1));
        if (S.lastToken !== req.access_token) {
          S.lastToken = req.access_token;
          out('✓ 已从页面捕获登录令牌，牌谱抓取可用');
        }
        obs('token captured len=' + String(req.access_token).length);
      }
    } catch (e) { obs('token capture fail: ' + e.message); }
    return;
  }
  if (dir === 'out' && name.includes('authGame')) {
    try {
      const req = decodeMsg('ReqAuthGame', inner);
      if (req && req.game_uuid) {
        // 断线重连会对同一局重新 authGame —— 服务器将重放历史动作。
        // 重放事件用牌山计数去重（见 handleResyncAction），引擎状态全程不动
        if (S.inGame && S.gameUuid === req.game_uuid && !S.resyncing) {
          onGameResync();
        }
        S.gameUuid = req.game_uuid;
        obs('game uuid: ' + req.game_uuid);
      }
    } catch (e) {}
    return;
  }

  if (dir === 'in' && (name.includes('NotifyGameEndResult') || name.includes('NotifyGameTerminate') || name.includes('NotifyLobbyFinish'))) {
    onGameEnd();
    return;
  }
  if (dir === 'in' && name.includes('ActionPrototype')) {
    const ap = decodeMsg('ActionPrototype', inner);
    if (!ap.name) return;
    const KEYS = [0x84, 0x5e, 0x4e, 0x42, 0x39, 0xa2, 0x1f, 0x60, 0x1c];
    let data = Buffer.from(ap.data || []);
    for (let i = 0; i < data.length; i++) {
      const u = ((23 ^ data.length) + 5 * i + KEYS[i % KEYS.length]) & 255;
      data[i] ^= u;
    }
    const actionName = String(ap.name).replace(/^\./, '');
    if (!byPath[actionName]) { obs('unknown action: ' + ap.name); return; }
    try {
      handleAction(actionName, decodeMsg(actionName, data));
    } catch (e) {
      obs('action decode fail: ' + ap.name + ' — ' + e.message);
    }
    return;
  }
  if (++S.obsCount % 50 === 0) obs(`${dir} ${name || '(noname)'} len=${buf.length}`);
}

// ---------- 入口 ----------
async function runTestActions(file0) {
  const file = file0;
  const lines = fs.readFileSync(path.isAbsolute(file) ? file : path.join(__dirname, '..', file), 'utf8').trim().split('\n');
  out('===== 离线重放 Action*: ' + file + ' =====');
  for (const ln of lines) {
    let f; try { f = JSON.parse(ln); } catch (e) { continue; }
    try { handleAction(f.name, f.data); } catch (e) { obs('action fail: ' + f.name + ' — ' + e.message); }
    await adviseChain; // 逐巡等待引擎决策，回放才有完整输出
  }
  out('===== 重放结束（等待引擎收尾…） =====');
}
if (TEST_ACTIONS) {
  runTestActions(TEST_ACTIONS.slice(15)).then(() => setTimeout(() => process.exit(0), 3000));
} else if (TEST) {
  const file = TEST.slice(7);
  const lines = fs.readFileSync(path.isAbsolute(file) ? file : path.join(__dirname, '..', file), 'utf8').trim().split('\n');
  out('===== 离线重放: ' + file + ' =====');
  for (const ln of lines) {
    let f; try { f = JSON.parse(ln); } catch (e) { continue; }
    handleFrame(f.dir, f.url || '', f.hex);
  }
  out('===== 重放结束（等待引擎收尾…） =====');
  setTimeout(() => process.exit(0), 5000);
} else {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    // 浏览器私有网络访问（PNA）探测：网页 → 127.0.0.1 需要服务端明确许可
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') { res.end(); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        if (req.method === 'GET' && req.url.startsWith('/panel')) {
          const m = /since=(\d+)/.exec(req.url);
          const since = m ? +m[1] : 0;
          const items = PANEL.buf.filter(x => x.i > since).slice(-40);
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ items, next: PANEL.idx }));
          return;
        }
        if (req.url.startsWith('/assets/') && req.url !== '/assets/pai.svg' && !req.url.startsWith('/assets/emo/')) {
          // 自动选取 live/assets 下最新的视频文件（mp4/webm），文件名随意，换视频即换背景
          try {
            const dirA = path.join(__dirname, 'assets');
            const vids = fs.readdirSync(dirA)
              .filter(f => /.(mp4|webm|png|jpe?g|webp|gif)$/i.test(f))
              .map(f => ({ f, t: fs.statSync(path.join(dirA, f)).mtimeMs }))
              .sort((a, b) => b.t - a.t);
            if (!vids.length) { res.statusCode = 404; res.end(''); return; }
            const data = fs.readFileSync(path.join(dirA, vids[0].f));
            const ext = vids[0].f.toLowerCase().split('.').pop();
            res.setHeader('Content-Type', ({ mp4: 'video/mp4', webm: 'video/webm', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' })[ext] || 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.end(data);
          } catch (e) { res.statusCode = 404; res.end(''); }
          return;
        }
        if (req.url.startsWith('/assets/emo/')) {
          try {
            const name = path.basename(decodeURIComponent(req.url));
            if (!/^emo_t[1-4].jpg$/.test(name)) throw new Error('bad name');
            const data = fs.readFileSync(path.join(__dirname, 'assets', 'emo', name));
            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Cache-Control', 'max-age=86400');
            res.end(data);
          } catch (e) { res.statusCode = 404; res.end(''); }
          return;
        }
        if (req.url.startsWith('/assets/emo/')) {
          try {
            const name = path.basename(decodeURIComponent(req.url));
            if (!/^emo_t[1-4]\.jpg$/.test(name)) throw new Error('bad name');
            const data = fs.readFileSync(path.join(__dirname, 'assets', 'emo', name));
            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Cache-Control', 'max-age=86400');
            res.end(data);
          } catch (e) { res.statusCode = 404; res.end(''); }
          return;
        }
        if (req.url === '/assets/pai.svg') {
          try {
            const data = fs.readFileSync(path.join(__dirname, 'assets', 'pai.svg'));
            res.setHeader('Content-Type', 'image/svg+xml');
            res.setHeader('Cache-Control', 'max-age=86400');
            res.end(data);
          } catch (e) { res.statusCode = 404; res.end(''); }
          return;
        }
        if (req.url === '/config') {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ review: !!S.reviewMode, tileDark: !!S.tileDark }));
          return;
        }
        if (req.url === '/announce') {
          const f = JSON.parse(body);
          if (f && f.text) out(String(f.text));
          res.end('ok');
          return;
        }
        if (req.url === '/frame') {
          const f = JSON.parse(body);
          handleFrame(f.dir, f.url || '', f.hex);
        }
        res.end('ok');
      } catch (e) { res.statusCode = 500; res.end('err'); }
    });
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log('✓ 教练服务端已经在运行了，无需重复启动。');
      console.log('  （本窗口可以直接关闭）');
      process.exit(0);
    }
    throw e;
  });
  server.listen(18766, '127.0.0.1', () => {
    out('============================================');
    out('  雀魂实时教练已启动（中继 127.0.0.1:18766）');
    out('  决策引擎: Mortal 本地神经网络');
    out('  实时输出: ' + OUT_FILE);
    out('============================================');
  });
}
