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
const ARG_V2 = args.includes('--v2') || args.includes('--v2-dry');  // v2.1 V1「只说不做」通道
// v2.1 V2 执行层：**默认关闭**。开启后仍受四道闸门约束（分辨率/排序口径/校准表/点击前复检）。
// 之所以做成显式开关而不是"有校准表就自动点"，是因为 V2 会真的打牌，误触代价是打错牌。
const ARG_V2_ACTIONS = args.includes('--v2-actions');
const TEST_ACTIONS = args.find(a => a.startsWith('--test-actions='));
const OUT_FILE = path.join(__dirname, (TEST || TEST_ACTIONS) ? 'live_test_output.md' : 'live_coach.md');
const OBS_LOG = path.join(__dirname, 'live_observed.log');

// ---------- 标准化外壳（app/）：版本 / 路径 / 配置 / 错误文案 ----------
// 用 try/catch 包住：即使 app/ 被裁掉，v1 主链路也必须能跑（同 initV2 的思路）。
// 约定：业务代码**不要**再自己拼 __dirname 找文件、不要自己写中文错误句，
// 一律走 APP.paths / APP.errors / APP.config —— 这是后续迭代与打包的解耦面。
let APP = null;
try {
  APP = {
    version: require('../app/version'),
    paths: require('../app/paths'),
    config: require('../app/config'),
    errors: require('../app/errors'),
    model: require('../app/model'),
    update: require('../app/update'),
    diag: require('../app/diag'),
  };
  APP.cfg = APP.config.applyCli(APP.config.load(), args);
} catch (e) {
  console.error('[app] 标准化模块加载失败，退回内置默认值：' + e.message);
  APP = null;
}
const CFG = APP ? APP.cfg : null;

// 日志轮转（重启不清空 live_observed.log；live_coach.md 仍按设计每次清空）
try {
  if (APP) {
    APP.diag.rotate(OBS_LOG);
    APP.diag.rotate(OUT_FILE, 5 * 1024 * 1024);
  }
} catch (e) {}
try { fs.writeFileSync(OUT_FILE, ''); } catch (e) {} // 每次启动从新文件开始


// ---------- v2.1 V1 通道（结构化建议 + 可执行性校验 + 审计日志；零注入） ----------
// 用 try/catch 包住：v2 模块出问题绝不能拖垮 v1 的教练主链路。
// 注意：初始化必须放在 out()/obs() 定义**之后**（曾经放在文件顶部，触发
// "Cannot access 'PANEL' before initialization" —— const 的 TDZ，非 hoisted）。
let V2 = null;
function initV2() {
  if (!ARG_V2) return;
  try {
    const core = require('./v2/v2core');
    const prof = core.loadProfile();
    const res = core.checkResolutionNow();
    V2 = {
      core,
      captureSnapshot(S, seq) {
        return {
          handRaw: (S.hands && S.hands[S.seat] ? S.hands[S.seat] : []).slice(),
          drawnRaw: S.lastDrawn || null,
          kyoku: S.kyokuLabel || null,
          junme: S.junme || null,
          timeFixed: S.lastTimeFixed !== undefined ? S.lastTimeFixed : null,
          account: S.account || 'default',
          gameId: S.gameUuid || '',
          reqSeq: seq,
        };
      },
      publishFromVerdict(S, items, meta, kind, snap, tag) {
        try {
          if (!snap) return;
          core.setAuditContext(snap.account, snap.gameId);
          // 引擎候选：把 mjai 牌名转回雀魂原始名（映射层只认原始名）
          const mapped = items.map(x => {
            const label = x.label || '';
            const raw = (x.pais && x.pais[0]) ? T2raw(x.pais[0]) : null;
            return { label, pai: raw, value: x.value, pct: x.value, tiles: x.tiles, pais: x.pais };
          });
          const advice = core.buildAdvice({
            kind,
            handRaw: snap.handRaw,
            drawnRaw: snap.drawnRaw,
            items: mapped,
            engineMeta: { qValues: (meta.q_values || meta.qvalues || null), maskBits: meta.mask_bits },
            kyoku: snap.kyoku,
            junme: snap.junme,
            timeFixed: snap.timeFixed,
            account: snap.account,
            gameId: snap.gameId,
            reqSeq: snap.reqSeq,
          });
          core.publish(advice, [tag]);
          // V2：把"决策 → 映射 → 执行"这条链真正接上。
          //
          // ⚠ 这里的关键不是"点了没点"，而是**这条链有没有被真正跑通过**。
          //   之前各层都是单独测的（映射层单测、执行层单测），但"服务端在真实决策点上
          //   调用执行层"这条集成路径从未跑过 —— 这正是最容易藏 bug 的地方。
          //   现在每次决策都会走完这条链：闸门 → 复检 → 桥。默认 allowActions=false，
          //   所以链的终点是"被拒绝"，但**链本身被完整验证了**。
          V2.maybeExecute(S, advice, snap);
        } catch (e) { obs('v2 publish fail: ' + ((e && e.message) || e)); }
      },
      /**
       * V2 执行：把建议里的落点交给执行层。
       *
       * 链的判定逻辑已抽到 v2core.runExecution()（那里可被离线单测覆盖）；
       * 这里只提供"真实的"三个依赖：执行层、复检回调、审计写入。
       * 所有分支（含"跳过"）都会落一条 exec 审计记录 —— 跳过也要有据可查，
       * 否则未开 --v2-actions 时整条链跑了却没有任何痕迹。
       */
      maybeExecute(S, advice, snap) {
        return core.runExecution({
          advice,
          exec: V2.exec || null,
          recheck: () => V2.recheckBeforeClick(S, advice.decision.tile, advice.decision.slot),
          writeAudit: core.writeAudit,
          onResult: (info) => {
            if (info.result === 'ok') {
              out(`  ⚙ 已点击：${advice.decision.tileDisp} 位次${advice.decision.slot} `
                + `(${advice.decision.point.x},${advice.decision.point.y})｜延时 ${advice.execAttempt.delayMs}ms`);
            } else if (info.result !== 'skipped') {
              out(`  ⚙ 未点击：${info.blockedReason}`);
            }
          },
        });
      },
      /**
       * 点击前复检（plan.md §3.1 强制）：用**当前**手牌重算 sorted，
       * 确认目标位次上仍然是决策时那张牌。手牌在"决策→点击"之间可能已变。
       */
      recheckBeforeClick(S, expectedTile, slot) {
        const hand = (S.hands && S.hands[S.seat] ? S.hands[S.seat] : []).slice();
        const drawn = S.lastDrawn || null;
        const M = require('./v2/mapping');
        return M.recheck(slot, expectedTile, hand, drawn, core.v2.profile);
      },
      /**
       * 记录"实际切了哪张"（审计 phase='actual'）。
       * 用**切牌前**的手牌快照算位次，并与建议里的引擎名次对照。
       * 这组数据能回答三件事：引擎首选与实打是否一致、实打落在哪个位次、
       * 以及"教练建议被采纳了多少"——都是 plan.md §8 想要而此前完全缺失的。
       */
      recordActualDiscard(S, d, handBefore) {
        const raw = d.tile;
        if (!raw) return;
        const hand = handBefore && handBefore.length
          ? handBefore.slice()
          : (S.hands[S.seat] || []).slice();
        // handBefore 已包含这张牌（调用点做了 concat），所以排序后能直接定位到位次
        const M2 = require('./v2/mapping');
        const built = M2.buildHandRow(hand, S.lastDrawn || null, core.v2.profile);
        let slot = null;
        for (let k = built.sorted.length - 1; k >= 0; k--) {
          if (built.sorted[k] === raw) { slot = k; break; }
        }
        const adv = core.v2.lastSelfAdvice;
        let engineRank = null;
        if (adv) {
          // ⚠ 两边都要归一到"雀魂原始名"再比：advice 里的 tile 已被归一（'0m'），
          //   而这里 raw 来自帧（可能是 '0m'，也可能经 T() 变成 mjai 名）。
          //   赤5 上口径不一致会让"引擎名次"静默变成 null（误报成"不在推荐之列"）。
          const want = M2.toRaw(raw);
          const list = (adv.candidates || []).length
            ? adv.candidates
            : ((adv.engine && adv.engine.items) || []).map((it, i) => ({ rank: i + 1, tile: it.pai, action: /^Dahai /.test(it.label || '') ? 'Dahai' : null }));
          const hit = list.find(c => c.action === 'Dahai' && M2.toRaw(c.tile) === want);
          engineRank = hit ? hit.rank : null;
        }
        core.recordActual({
          tile: raw,
          slot,
          kyoku: S.kyokuLabel || null,
          junme: S.junme || null,
          handBefore: hand,
          sortedHand: built.sorted.map(t => M2.toRaw(t)),
          engineRank,
          // 关联用序号（junme 在一手内会重复，按巡配对会产生假的"位次不同"）
          advSeq: core.pendingAdviceSeq(),
          // 把"当时认为刚摸到的是哪张"也记下来（与 advice 记录的 drawnTile 是同一来源）：
          // 复算器据此重算位次，并能直接暴露"快照与下游推导对同一张牌给出不同位次"
          // 这类端到端漂移 —— 单元测试查不到，只有真实数据对拍才看得见。
          drawnRaw: S.lastDrawn || null,
        });
        // 回灌到面板数据 → 面板上形成"建议 X 位次 n ／ 你切了 Y（引擎第 m 名）"的闭环，
        // 这样 plan.md §9 的"逐手一致"核对可以直接在面板上完成
        core.attachActual(core.pendingAdviceSeq(), { tile: raw, slot, engineRank });
      },
    };
    core.v2.enabled = true;
    // v2.1 V2 执行层（可选）：只有显式传 --v2-actions 才会启动输入桥
    if (ARG_V2_ACTIONS) {
      try {
        const ex = require('./v2/exec');
        V2.exec = ex;
        ex.init(true).then((r) => {
          if (r.ok) {
            out(`⚙ 执行层已启用（allowActions=true）｜屏幕 ${r.screen.w}×${r.screen.h}｜DPI 模式 ${r.dpi && r.dpi.mode}`);
            out(`  Kill switch = ${r.kill && r.kill.key}（按下后立即停止注入，需 resume 才恢复）`);
          } else {
            out(`⚠ 执行层启动失败：${r.reason}（将只说不做）`);
          }
        }).catch(e => out('⚠ 执行层初始化异常：' + ((e && e.message) || e)));
      } catch (e) {
        out('⚠ 执行层加载失败：' + ((e && e.message) || e));
      }
    }
    out(`✓ v2.1 V1 通道已启用（只说不做，零注入）`);
    out(`  校准表：${core.v2.profilePath}${prof.ok ? '' : '（读取失败，使用默认值：' + prof.error + '）'}`);
    out(`  排序口径：${core.v2.profile.sortOrder}｜已确认=${!!core.v2.profile.sortOrderConfirmed}`
      + `｜摸牌位偏移 drawnOffsetX=${core.v2.profile.drawnOffsetX === null ? '未校准' : core.v2.profile.drawnOffsetX}`);
    if (res) for (const m of res.messages) out(`  ${res.ok ? '·' : '⚠'} ${m}`);
  } catch (e) {
    V2 = null;
    out('⚠ v2.1 模块加载失败，退回 v1 行为：' + ((e && e.message) || e));
  }
}
/** mjai 牌名 → 雀魂原始牌名（'5mr'→'0m'，'E'→'1z'）。映射层只接受原始名。 */
function T2raw(t) {
  if (!t || typeof t !== 'string') return t;
  if (/^5[mps]r$/.test(t)) return '0' + t[1];
  const back = { E: '1z', S: '2z', W: '3z', N: '4z', P: '5z', F: '6z', C: '7z' };
  return back[t] || t;
}

// ---------- Mortal 引擎（Akagi 嵌入式 Python + bot.py） ----------
// 路径不再写死 akagi-3.7.1：见 app/paths.js（安装版 runtime/python、开发版 engine/akagi/<任意版本>）。
const MORTAL_PY = APP ? APP.paths.pythonExe(CFG) : null;
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
// 运行统计：设置向导判断"页面到底接没接上"，以及诊断包用
const STATS = { frames: 0, bigFrames: 0, lastFrameAt: null, denied: 0, dropped: 0, rateWin: 0, rateN: 0, scriptVersion: null, verWarned: false };
function out(line) {
  fs.appendFileSync(OUT_FILE, line + '\n');
  console.log(line);
  PANEL.buf.push({ i: ++PANEL.idx, text: line });
  if (PANEL.buf.length > 300) PANEL.buf.shift();
}
function obs(msg) {
  try { fs.appendFileSync(OBS_LOG, new Date().toISOString().slice(11, 19) + ' ' + msg + '\n'); } catch (e) {}
}

// v2.1 V1 通道在此初始化：out()/obs() 都已就绪（见 initV2 定义处的 TDZ 说明）
initV2();

// ---------- 用户偏好（复盘模式等） ----------
// ---------- Mortal 引擎管理 ----------
function mortalStart() {
  try { if (MORTAL.proc) MORTAL.proc.kill(); } catch (e) {}
  // 找不到 Python 时**不要**静默重试 8 次：那是"看起来在跑其实没引擎"的经典死法。
  // 直接给一条可操作的中文提示并停用本场（下局用户修好后自动恢复）。
  if (!MORTAL_PY) {
    MORTAL.gaveUp = true;
    out(APP ? APP.errors.line('PYTHON_MISSING') : '⚠ 引擎无法启动：找不到 Python 运行时（见 docs/PLAN-packaging.md）');
    return false;
  }
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
    if (S.inGame) {
      const m = APP ? APP.paths.model() : null;
      out(APP ? APP.errors.engineExit(c, { hadModel: !!(m && m.file), modelLabel: m && m.label })
        : '⚠ Mortal 引擎退出（code ' + c + '），下次出牌自动重启…');
    }
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
// config.json（app/config.js）优先于旧 coach_settings.json；命令行最后覆盖
if (CFG && CFG.mode) S.reviewMode = CFG.mode === 'review';
if (CFG && CFG.tileDark) S.tileDark = true;
if (ARG_REVIEW) S.reviewMode = true;
if (ARG_DARK) S.tileDark = true;
// 公共版边界（D5/D44）：即使 config.json 写 realtime、或命令行带 --realtime，也强制复盘
if (APP && APP.config.REVIEW_ONLY) S.reviewMode = true;


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

// ---------- v2.1：思考时限记录（只读，不调度） ----------
/**
 * 帧里带 OptionalOperationList 的时机才有 time_fixed（实测：自摸 8000ms、他家切牌后 5000ms）。
 * v1 一个都没读；v2.1 先把它记录下来，供审计日志与将来的调度层使用。
 */
function recordTimeLimit(d, name) {
  const op = d && d.operation;
  if (!op) return;
  if (op.time_fixed !== undefined) {
    S.lastTimeFixed = op.time_fixed;
    S.deadline = Date.now() + op.time_fixed;
  }
  if (op.time_add !== undefined) S.lastTimeAdd = op.time_add;
  // P0-2：记录当前可执行动作集（v1 只判断 operation_list 真值，从不看里面是什么）。
  // 关键：带上当时的决策序号 reqSeq —— offer 只在**同一个决策点**内有效，
  // 否则会拿"别人切牌时我能吃碰"的 offer 去校验"我摸牌后自由切牌"，把正常切牌判成非法。
  if (V2) {
    try {
      const offer = V2.core.setOffer(op.operation_list, S.reqSeq);
      obs(`offer@${name} seq=${S.reqSeq}: [${offer.actions.join(',')}] confirmed=${offer.confirmed}`);
    } catch (e) { obs('setOffer fail: ' + ((e && e.message) || e)); }
  }
}

// ---------- 决策请求（promise 链串行化，引擎恰好消费每个事件一次） ----------
let adviseChain = Promise.resolve();
function requestAdvice(drawn, kind, endOffset, actual) {
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
  // v2.1：决策点快照。必须在**同步阶段**取，因为 await 之后手牌可能已经变了
  // （这正是 plan.md §10 第 3 条"快照校验"要防的事，也让审计日志能离线复算）。
  const snap = V2 ? V2.captureSnapshot(S, mySeq) : null;
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
    onMortalVerdict(resp, tag, kind, actual, snap);
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
function onMortalVerdict(resp, tag, kind, actual, snap) {
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
  // v2.1 V1：发布结构化建议（含位次/坐标/可否点击），走长轮询通道；文字行通道照旧
  if (V2) V2.publishFromVerdict(S, items, meta, kind, snap, tag);
  if (kind === 'review-op' && actual) {
    const wantLabel = ({ chi: 'Chi', pon: 'Pon', kan: 'Daiminkan', ron: 'Ron', skip: 'Skip' })[actual.type] || 'Skip';
    const cn = ({ chi: '吃', pon: '碰', kan: '明杠', ron: '荣和', skip: '跳过' })[actual.type] || actual.type;
    let hit = null;
    ((meta.show && meta.show.items) || []).forEach((it, i) => {
      if (hit) return;
      const L = it.label || '';
      if (wantLabel === 'Chi' ? L.startsWith('Chi') : L === wantLabel) hit = { rank: i + 1, value: it.value || '' };
    });
    out(`  → 你选择了${cn}` + (hit ? `（Mortal 第 ${hit.rank} 名 ${hit.value}）` : '（Mortal 推荐之外）'));
  }
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
    let actual = { type: 'skip' }; // 窗口关闭且未见自家鸣牌 → 跳过
    if (name === 'ActionChiPengGang' && d.seat === S.seat) {
      actual = { type: ['chi', 'pon', 'kan'][d.type] || 'chi' };
    } else if (name === 'ActionHule' && (d.hules || []).some(h => h.seat === S.seat)) {
      actual = { type: 'ron' };
    }
    requestAdvice(pr.drawn, 'review-op', Math.max(0, S.mjaiBuffer.length - pr.bufLen), actual);
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
    // v2.1 P0-1：记录本帧的思考时限。v1 从不读 time_fixed，导致任何延时方案都无法与真实
    // 时限对齐（plan.md §7：上限须守 time_fixed − 1000ms）。这里只记录，不做调度。
    recordTimeLimit(d, name);
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
    recordTimeLimit(d, name);
    const s = d.seat;
    const pai = T(d.tile);
    if (s === S.seat) {
      const i = S.hands[s].indexOf(d.tile);
      if (i >= 0) S.hands[s].splice(i, 1);
      if (S.lastAdvice) {
        const c = S.lastAdvice.find(x => x.tile === pai);
        out(`  你切了 ${disp(pai)}` + (c ? `（Mortal 第 ${c.rank} 名 ${c.value}）` : '（不在推荐之列）'));
      }
      // v2.1：把"你实际切了哪张"也写进审计日志（phase='actual'）。
      // 注意取的是**删除前**的手牌快照 —— note 里的位次必须按切牌前的手牌算。
      if (V2) {
        try {
          V2.recordActualDiscard(S, d, i >= 0 ? S.hands[s].concat([d.tile]) : null);
        } catch (e) { obs('v2 recordActual fail: ' + ((e && e.message) || e)); }
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
  const PORT_EARLY = CFG ? CFG.port : 18766;

  // ---------- 安全边界（P0）----------
  // 之前这里对所有响应都发 Access-Control-Allow-Origin: *，等于把本地端口交给任何网页：
  //   · 任意网站可以读 /panel（你的手牌与建议）、改设置、伪造 /frame
  //   · 再配合"配置无校验 + pythonExe 会被 spawn"，能串成本地任意程序执行
  // 现在三层闸门：
  //   1) Host 白名单 —— 防 DNS rebinding（恶意域名解析到 127.0.0.1 时浏览器仍发 Host: evil.com）
  //   2) Origin 白名单 —— 恶意网页的跨源请求必带 Origin；油猴 GM 请求不带或带扩展 scheme
  //   3) 请求体上限 —— 以前 req.on('data') 无上限，一个网页就能把内存打满
  const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT_EARLY}`, `localhost:${PORT_EARLY}`, `[::1]:${PORT_EARLY}`]);
  const OK_ORIGINS = new Set([
    `http://127.0.0.1:${PORT_EARLY}`, `http://localhost:${PORT_EARLY}`,
    'https://game.maj-soul.com', 'https://game.mahjongsoul.com',
    'https://majsoul.com', 'https://www.majsoul.com',
  ]);
  const MAX_BODY = 1024 * 1024;   // 1 MB：/frame 的 hex 上限 256KB（≈512KB 文本），够用
  const FRAME_PER_SEC = 300;      // 每秒帧数上限（真实对局每秒十几帧，给足余量）

  // 本地页面的 CSP：这些页面只有我们自己的内联脚本，不需要任何外部资源
  function setCsp(res) {
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  }

  function originVerdict(origin, url) {
    if (!origin) return 'allow';                    // 油猴 GM 请求不带 Origin
    if (OK_ORIGINS.has(origin)) return 'allow';     // 雀魂页面自身 / 本机页面
    if (/^(chrome|moz|safari-web)-extension:\/\//.test(origin)) return 'allow'; // 扩展后台请求
    // Origin: null（沙箱 iframe）—— 某些油猴版本会这么发。
    // 允许它读/发帧（否则可能把正常用户挡在外面），但**任何 /api/ 写操作一律拒绝**：
    // 写操作才是"能造成后果"的那一类（改配置、触发下载、导诊断包）。
    if (origin === 'null') return /^\/api\//.test(url || '') ? 'deny' : 'allow';
    return 'deny';
  }

  const server = http.createServer((req, res) => {
    const host = req.headers.host || '';
    if (host && !LOCAL_HOSTS.has(host)) {
      obs(`拒绝非法 Host：${host} ${req.method} ${req.url}`);
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('forbidden host');
      return;
    }
    const origin = req.headers.origin;
    if (originVerdict(origin, req.url) === 'deny') {
      STATS.denied++;
      obs(`拒绝跨源请求：origin=${origin} ${req.method} ${req.url}`);
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('forbidden origin');
      return;
    }
    // 只对白名单来源回 CORS 头
    if (origin && OK_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      if (req.headers['access-control-request-private-network'] === 'true') {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
    }
    if (req.method === 'OPTIONS') { res.end(); return; }
    // 壁纸上传是二进制，不能走 body += chunk（Buffer→字符串会毁掉字节），单独收 chunks
    const isUpload = req.url === '/api/wallpaper' && req.method === 'POST';
    const limit = isUpload ? 64 * 1024 * 1024 : MAX_BODY;
    let body = '';
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > limit) {
        tooBig = true;
        body = '';
        res.statusCode = 413;
        res.end('payload too large');
        try { req.destroy(); } catch (e) {}
        return;
      }
      if (isUpload) chunks.push(c);
      else body += c;
    });
    req.on('end', () => {
      if (tooBig) return;
      const rawBody = isUpload ? Buffer.concat(chunks) : null;
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
          // 壁纸来源优先级：用户壁纸目录（%APPDATA%，升级不丢）→ 安装目录 live/assets（随包默认）
          // 各目录里取 mtime 最新的那个媒体文件；文件名随意。
          try {
            const MEDIA = /\.(mp4|webm|png|jpe?g|webp|gif)$/i;
            const newestIn = (dir) => {
              let best = null;
              let names = [];
              try { names = fs.readdirSync(dir); } catch (e) { return null; }
              for (const f of names) {
                if (!MEDIA.test(f)) continue;
                const full = path.join(dir, f);
                let st; try { st = fs.statSync(full); } catch (e) { continue; }
                if (!best || st.mtimeMs > best.t) best = { f, t: st.mtimeMs, full };
              }
              return best;
            };
            // 用户壁纸**整类优先**（不看 mtime）：否则重装后随包默认的 mtime 更新，会盖掉用户自己传的
            const best = newestIn(APP.paths.wallpaperDir()) || newestIn(APP.paths.assetsDir());
            if (!best) { res.statusCode = 404; res.end(''); return; }
            const data = fs.readFileSync(best.full);
            const ext = best.f.toLowerCase().split('.').pop();
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
        // 一键安装/更新页面脚本：Tampermonkey 见到 .user.js 结尾的地址会弹安装页。
        // 版本在这里注入（package.json 是唯一来源），避免"服务端 v1.25 / 脚本 v1.24"的静默错配。
        if (req.url === '/coach.user.js') {
          try {
            const src = APP ? APP.paths.userscript() : path.join(__dirname, 'coach_hook.user.js');
            let body = fs.readFileSync(src, 'utf8');
            const ver = APP ? APP.version.version : null;
            if (ver) body = body.replace(/^(\/\/\s*@version\s+).*$/m, '$1' + ver);
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(body);
          } catch (e) {
            res.statusCode = 500;
            res.end('userscript not found');
          }
          return;
        }

        // ---------- 设置向导 / 设置页（内置网页，不联网） ----------
        if (req.method === 'GET' && (req.url === '/' || req.url === '/setup' || req.url === '/settings')) {
          const page = req.url === '/settings' ? 'settings.html' : 'setup.html';
          try {
            const html = fs.readFileSync(path.join(APP.paths.webDir(), page), 'utf8');
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            setCsp(res);
            res.end(html);
          } catch (e) {
            res.statusCode = 500;
            res.end('页面缺失：' + page);
          }
          return;
        }
        if (req.url === '/api/settings' && req.method === 'POST') {
          let patch = {};
          try { patch = JSON.parse(body || '{}'); } catch (e) {}
          const chk = APP.config.sanitize(patch, APP.paths.ROOT);
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          if (!chk.ok) {
            obs(`拒绝设置请求：${chk.error}`);
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: chk.error }));
            return;
          }
          const r = APP.config.save(chk.value);
          res.end(JSON.stringify(r));
          return;
        }
        // ---------- 壁纸（用户自传 → %APPDATA%\MahjongSoulCoach\wallpaper\） ----------
        // **不能存在安装目录**：覆盖安装/换目录会把上传的壁纸一起清掉（实机踩过：重启后壁纸没了）。
        // 面板固定请求 /assets/bg.mp4；该路由按 "用户壁纸目录 → 安装目录 live/assets(默认)" 取最新的媒体。
        if (req.url === '/api/wallpaper' && req.method === 'GET') {
          const MEDIA = /\.(mp4|webm|png|jpe?g|webp|gif)$/i;
          const scan = (dir, source) => {
            let out2 = [];
            try {
              out2 = fs.readdirSync(dir).filter(f => MEDIA.test(f)).map(f => {
                const st = fs.statSync(path.join(dir, f));
                return { name: f, bytes: st.size, at: st.mtimeMs, source };
              });
            } catch (e) {}
            return out2;
          };
          const user = scan(APP.paths.wallpaperDir(), 'user');
          const builtin = scan(APP.paths.assetsDir(), 'builtin');
          const all = user.concat(builtin).sort((a, b) => (b.source === 'user') - (a.source === 'user') || b.at - a.at);
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: true, current: all[0] || null, files: all }));
          return;
        }
        if (req.url === '/api/wallpaper' && req.method === 'POST') {
          const ct = String(req.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
          const EXT = {
            'video/mp4': '.mp4', 'video/webm': '.webm',
            'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
          };
          const ext = EXT[ct];
          if (!ext) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: '只支持 mp4 / webm / png / jpg / gif / webp' }));
            return;
          }
          if (!rawBody || rawBody.length < 1024) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: '文件为空或太小' }));
            return;
          }
          const dirA = APP.paths.wallpaperDir();
          try {
            fs.mkdirSync(dirA, { recursive: true });
            // 只清用户壁纸目录里的旧文件（安装目录里的默认壁纸不动）
            for (const f of fs.readdirSync(dirA)) {
              try { fs.unlinkSync(path.join(dirA, f)); } catch (e) {}
            }
            const name = 'user' + ext;
            fs.writeFileSync(path.join(dirA, name), rawBody);
            out('壁纸已更新：' + name + '（' + Math.round(rawBody.length / 1048576 * 10) / 10 + ' MB），刷新游戏页生效');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, name, bytes: rawBody.length, dir: dirA }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
          return;
        }
        if (req.url === '/api/wallpaper' && req.method === 'DELETE') {
          // 只删"用户上传的"，恢复成随包的默认壁纸
          const dirA = APP.paths.wallpaperDir();
          try {
            for (const f of fs.readdirSync(dirA)) {
              try { fs.unlinkSync(path.join(dirA, f)); } catch (e) {}
            }
          } catch (e) {}
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.url === '/api/model/status') {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(APP.model.status()));
          return;
        }
        if (req.url === '/api/model/download' && req.method === 'POST') {
          const r = APP.model.start(APP.paths.ROOT);
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(r));
          return;
        }

        if (req.url.startsWith('/api/update')) {
          // 只有用户点"检查更新"才会走到这里（默认不联网）
          Promise.resolve(APP.update.check(APP.version.version)).then((r) => {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(r));
          }).catch((e) => {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
          });
          return;
        }
        if (req.url === '/api/diag/export' && req.method === 'POST') {
          const r = APP.diag.exportBundle({
            root: APP.paths.ROOT,
            version: APP.version.version,
            diagnostics: APP.paths.diagnostics(CFG),
            cfg: CFG,
            port: CFG ? CFG.port : 18766,
          });
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(r));
          return;
        }

        if (req.url === '/config') {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          const diag = APP ? APP.paths.diagnostics(CFG) : null;
          res.end(JSON.stringify({
            version: APP ? APP.version.version : null,
            product: APP ? APP.version.productName : null,
            mode: S.reviewMode ? 'review' : 'realtime',
            review: !!S.reviewMode, tileDark: !!S.tileDark,
            port: CFG ? CFG.port : 18766,
            frames: STATS.frames,
            lastFrameAt: STATS.lastFrameAt,
            denied: STATS.denied,
            dropped: STATS.dropped,
            scriptVersion: STATS.scriptVersion || null,
            engine: diag ? {
              python: diag.python, pythonFound: diag.pythonFound,
              model: diag.model, modelLabel: diag.modelLabel, modelSizeMB: diag.modelSizeMB,
              vcRuntime: diag.vcRuntime,
            } : null,
            v2: !!V2,
            v2version: V2 ? '2.1-V1' : null,
            sortOrder: V2 ? V2.core.v2.profile.sortOrder : null,
            sortOrderConfirmed: V2 ? !!V2.core.v2.profile.sortOrderConfirmed : null,
            drawnOffsetX: V2 ? V2.core.v2.profile.drawnOffsetX : null,
            resolutionOk: V2 ? !!(V2.core.v2.resolution && V2.core.v2.resolution.ok) : null,
          }));
          return;
        }

        // ---------- v2.1 V1 通道 ----------
        // 长轮询：有建议立即返回，否则挂起至多 wait 毫秒（事件唤醒，不是 1500ms 定时采样）
        if (V2 && req.url.startsWith('/v2/advice')) {
          const ms = /since=(\d+)/.exec(req.url);
          const wm = /wait=(\d+)/.exec(req.url);
          const since = ms ? +ms[1] : 0;
          const waitMs = wm ? +wm[1] : 20000;
          // latest=1：立刻返回当前最新建议（面板刚挂载时用）。
          // 注意：没有建议时也必须**立刻**回一个空对象，不能落到长轮询去挂 20 秒——
          // 否则面板首次连接会白等（实测挂满 10 秒以上）。
          if (/latest=1/.test(req.url)) {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(V2.core.v2.latest || { seq: V2.core.v2.seq, none: true }));
            return;
          }
          V2.core.waitFor(since, waitMs).then((a) => {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(a || { seq: V2.core.v2.seq, none: true }));
          }).catch(() => { res.statusCode = 500; res.end('err'); });
          return;
        }
        // 结构化状态：给"逐手核对"用的可读文本视图（不依赖任何图像能力）
        if (V2 && req.url.startsWith('/v2/state')) {
          const asText = /text=1/.test(req.url);
          const a = V2.core.v2.latest;
          if (!asText) {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({
              seq: V2.core.v2.seq, stats: V2.core.v2.stats,
              resolution: V2.core.v2.resolution, screen: V2.core.v2.screen,
              profile: V2.core.v2.profile, offer: V2.core.v2.offer, advice: a,
            }));
            return;
          }
          const L = [];
          L.push(`seq=${V2.core.v2.seq} 发布时间=${a ? new Date(a.ts).toLocaleTimeString('zh-CN') : '-'} 类型=${a ? a.kind : '-'} 局=${a ? a.kyoku : '-'} 巡=${a ? a.junme : '-'}`);
          if (V2.core.v2.screen) L.push(`屏幕(物理像素)=${V2.core.v2.screen.width}×${V2.core.v2.screen.height} @${Math.round(V2.core.v2.screen.scale * 100)}%  分辨率校验=${V2.core.v2.resolution && V2.core.v2.resolution.ok ? '通过' : '不通过'}`);
          if (a) {
            L.push(`手牌(已排序)=${a.sortedDisp.map((t, i) => i + ':' + t).join(' ')}`);
            L.push(`手牌(原始序)=${a.handDisp.join(' ')}   刚摸到=${a.drawnSlot === null ? '-' : '位次' + a.drawnSlot}`);
            if (a.note) L.push(`提示：${a.note}`);
            L.push('位次 → 坐标：');
            for (const s of a.slots) L.push(`  [${String(s.i).padStart(2)}] ${s.disp.padEnd(4)} x=${s.x === null ? '--' : s.x} y=${s.y} ${s.blocked ? '⛔' : '✓'}${s.isDrawn ? ' ←刚摸到' : ''}`);
            L.push('引擎候选：');
            for (const c of a.candidates) L.push(`  #${c.rank} ${c.label} value=${c.value} 位次=${c.slot} 落点=(${c.point.x},${c.point.y}) ${c.clickable ? '可点' : '不可点：' + (c.point.reason || '')}`);
            L.push(`决策（若自动）：${a.decision ? `${a.decision.tileDisp} 位次${a.decision.slot} 落点(${a.decision.point.x},${a.decision.point.y}) wouldClick=${a.decision.wouldClick}` : '-'}`);
            L.push(`可执行性：${a.executable.ok ? '通过' : '不通过：' + a.executable.reason}｜offer=${a.offer ? '[' + a.offer.actions.join(',') + ']' : '无'}`);
            // 建议 → 实打 的闭环（V1 逐手核对就靠这一行）
            if (a.actual) {
              const rk = a.actual.engineRank;
              L.push(`你实际切了：${a.actual.tileDisp}（位次 ${a.actual.slot}）｜`
                + (rk ? `Mortal 第 ${rk} 名` : '不在 Mortal 推荐之列')
                + `｜建议是 ${a.decision ? a.decision.tileDisp + ' 位次' + a.decision.slot : '-'}`);
            }
            L.push(`闸门：${a.gating.length ? a.gating.join(' ｜ ') : '无（V1 零注入，无论如何都不会点击）'}`);
            L.push(`time_fixed=${a.timeFixed} deadline=${a.deadline ? new Date(a.deadline).toLocaleTimeString('zh-CN') : '-'}`);
          } else {
            L.push('（还没有建议：需要在 --v2 模式下打一手）');
          }
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(L.join('\n') + '\n');
          return;
        }
        // 校准：列出当前校准表 / 写入字段（用户实机标定后用）
        if (V2 && req.url.startsWith('/v2/calib')) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          if (req.method === 'GET') {
            res.end(JSON.stringify({ profile: V2.core.v2.profile, resolution: V2.core.v2.resolution, screen: V2.core.v2.screen }, null, 1));
            return;
          }
          // POST: {"drawnOffsetX":41} / {"sortOrder":"num-major","sortOrderConfirmed":true} / {...}
          let patch = {};
          try { patch = JSON.parse(body || '{}'); } catch (e) { res.statusCode = 400; res.end('bad json'); return; }
          if (patch.drawnOffsetX !== undefined && patch.drawnOffsetX !== null) {
            patch.drawnOffsetX = Math.round(Number(patch.drawnOffsetX));
            if (!isFinite(patch.drawnOffsetX)) { res.statusCode = 400; res.end('drawnOffsetX 非法'); return; }
          }
          const r = V2.core.saveProfile(patch);
          out(`⚙ 校准表已更新：${JSON.stringify(patch)} → ${r.ok ? '已落盘 ' + V2.core.v2.profilePath : '失败：' + r.error}`);
          res.end(JSON.stringify({ ok: r.ok, error: r.error || null, profile: V2.core.v2.profile }));
          return;
        }
        // 重新校验分辨率（用户切窗口后调用）
        if (V2 && req.url === '/v2/recheck-resolution') {
          const r = V2.core.checkResolutionNow();
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ result: r, screen: V2.core.v2.screen }));
          return;
        }
        // v2.1 V2 执行层状态 / 内部控制
        if (V2 && req.url.startsWith('/v2/exec')) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          if (!V2.exec) { res.end(JSON.stringify({ enabled: false, note: '执行层未启用（需 --v2-actions 启动）' })); return; }
          if (req.method === 'POST') {
            let body2 = {};
            try { body2 = JSON.parse(body || '{}'); } catch (e) {}
            const act = body2.action;
            if (act === 'stop') { V2.exec.stop().then(r => res.end(JSON.stringify(r))); return; }
            if (act === 'resume') { V2.exec.resume().then(r => res.end(JSON.stringify(r))); return; }
            if (act === 'ping') { V2.exec.status().then(r => res.end(JSON.stringify(r))); return; }
            res.end(JSON.stringify({ ok: false, reason: '未知 action（可用 stop/resume/ping）' }));
            return;
          }
          res.end(JSON.stringify(V2.exec.snapshot()));
          return;
        }
        // 校准 CLI 的只读接口：读鼠标物理坐标（标定用，不产生输入）
        if (V2 && req.url.startsWith('/v2/cursor')) {
          try {
            const osprobe = require('./v2/osprobe');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(osprobe.cursorPos()));
          } catch (e) { res.statusCode = 500; res.end('err'); }
          return;
        }
        if (req.url === '/announce') {
          const f = JSON.parse(body);
          if (f && f.text) out(String(f.text));
          res.end('ok');
          return;
        }
        // v2.1 几何探针上报：只读快照，落盘供 V0 校准使用，不参与决策
        if (req.url === '/frame' && body.indexOf('"_probe"') >= 0) {
          const f = JSON.parse(body);
          const rep = f.report || {};
          const v2dir = path.join(__dirname, 'v2');
          try {
            fs.appendFileSync(path.join(v2dir, 'probe_geometry.jsonl'), JSON.stringify(f) + '\n');
            S.lastProbe = rep;
            if (rep.note === 'mark-cursor' || rep.req === 'GetCursorPos') {
              // 用户按 F7：读取真实鼠标物理坐标（必须 DPI-aware）
              const osprobe = require('./v2/osprobe');
              const pos = osprobe.cursorPos();
              const scr = osprobe.screenInfo();
              const rec = { ts: new Date().toISOString(), kind: 'cursor-mark', ...pos, ...scr };
              fs.appendFileSync(path.join(v2dir, 'calibration_marks.jsonl'), JSON.stringify(rec) + '\n');
              out(`📍 标定点：鼠标物理坐标 (${pos.x}, ${pos.y})｜屏幕 ${scr.width}×${scr.height} @${Math.round(scr.scale * 100)}%`);
            } else if (rep.note === 'list-windows' || rep.req === 'EnumWindows') {
              const osprobe = require('./v2/osprobe');
              const list = osprobe.listWindows(80).filter(w => w.w > 0 && w.h > 0);
              fs.writeFileSync(path.join(v2dir, 'windows.json'), JSON.stringify(list, null, 1));
              out(`🪟 窗口清单（按 Z 序，仅列出有面积的）：共 ${list.length} 个`);
              for (const w of list.slice(0, 12)) {
                out(`   z=${String(w.z).padStart(2)} ${String(w.proc).slice(0, 16).padEnd(16)} `
                  + `${w.w}×${w.h} @${w.l},${w.t} dpi=${w.dpi} ${String(w.title).slice(0, 28)}`);
              }
            } else {
              const scr = { width: rep.innerWidth, height: rep.innerHeight, dpr: rep.devicePixelRatio, vv: rep.vvScale };
              try { fs.writeFileSync(path.join(v2dir, 'screen.json'), JSON.stringify(rep, null, 1)); } catch (e) {}
              const hr = rep.handRow || {};
              out(`🔍 几何快照（${rep.note || '?'}）：页面视口 ${scr.width}×${scr.height} dpr=${scr.dpr}｜`
                + `牌行矩形 ${hr.count || 0} 个`
                + (hr.firstCenter !== undefined
                  ? `，首中心 ${hr.firstCenter}、末中心 ${hr.lastCenter}、行中心Y ${hr.rowCenterY}、末位中心距 ${hr.lastGap}`
                  : `（${hr.reason || '无'}）`));
              if (hr.deltas) out(`   与公式逐位偏差：${JSON.stringify(hr.deltas)}`);
              // 校准结论：把实测牌行与公式对拍，直接算出 pitch / y / drawnOffsetX 的实测值
              if (hr.centers && hr.centers.length >= 4) {
                const M = require('./v2/mapping');
                const c = hr.centers;
                const pitch = (c[c.length - 2] - c[0]) / (c.length - 2); // 末位不参与（可能是摸牌位）
                const y = hr.rowCenterY;
                const base = M.DEFAULT_PROFILE.hand;
                const fitErr = Math.max(...c.slice(0, c.length - 1).map((v, i) => Math.abs(v - (base.x0 + pitch * i))));
                out(`   ▶ 实测拟合：pitch=${pitch.toFixed(2)}（公式 ${base.pitch}）｜行中心Y=${y}（公式 ${base.y}）`
                  + `｜逐位最大残差 ${fitErr.toFixed(2)}px`);
                const lastDelta = c[c.length - 1] - (base.x0 + pitch * (c.length - 1));
                if (c.length === 14) {
                  out(`   ▶ 第 14 位（摸到的牌）相对均匀网格偏移 = ${lastDelta.toFixed(1)}px`
                    + ` → 若稳定在 +40 附近，可写入校准表 drawnOffsetX=${Math.round(lastDelta)}`);
                } else if (Math.abs(lastDelta) > 5) {
                  out(`   ⚠ 末位相对均匀网格偏移 ${lastDelta.toFixed(1)}px（手牌 ${c.length} 张，非 14 张，可能是鸣牌状态）`);
                }
                try {
                  fs.writeFileSync(path.join(v2dir, 'calibration_report.json'), JSON.stringify({
                    ts: new Date().toISOString(), note: rep.note,
                    viewport: { w: rep.innerWidth, h: rep.innerHeight, dpr: rep.devicePixelRatio },
                    measured: { pitch: +pitch.toFixed(3), rowCenterY: y, maxResidual: +fitErr.toFixed(2), lastDelta: +lastDelta.toFixed(1) },
                    centers: c,
                    formula: base,
                  }, null, 1));
                } catch (e) {}
              }
            }
          } catch (e) {
            obs('probe handle fail: ' + e.message + ' | ' + (e.stack || '').split('\n').slice(0, 2).join(' <- '));
          }
          res.end('ok');
          return;
        }
        if (req.url === '/frame') {
          // 速率限制：只靠体积上限挡不住"小包洪水"（每秒几千个 100 字节的包同样能顶满 CPU）
          const sec = Math.floor(Date.now() / 1000);
          if (sec !== STATS.rateWin) { STATS.rateWin = sec; STATS.rateN = 0; }
          if (++STATS.rateN > FRAME_PER_SEC) {
            STATS.dropped++;
            res.statusCode = 429;
            res.end('too many frames');
            return;
          }
          const f = JSON.parse(body);
          // 帧体校验：hex 必须是字符串且不超 256KB（油猴侧 MAX=262144）—— 否则一个畸形请求就能让解码器吃满 CPU
          if (typeof f.hex !== 'string' || f.hex.length > 600000) {
            res.statusCode = 400;
            res.end('bad frame');
            return;
          }
          STATS.frames++;                       // 设置向导第 4 步靠它判断"页面接通了"
          STATS.lastFrameAt = Date.now();
          STATS.bigFrames += (f.hex && f.hex.length > 32000) ? 1 : 0;
          // 版本握手：脚本版本与服务端不一致时说一句（这类错配否则完全静默，是最难查的一类）
          if (f.v) STATS.scriptVersion = f.v;
          if (APP && f.v && f.v !== APP.version.version && !STATS.verWarned) {
            STATS.verWarned = true;
            out(APP.errors.line('USERSCRIPT_STALE') + `（脚本 v${f.v} / 服务端 v${APP.version.version}）`);
          }
          handleFrame(f.dir, f.url || '', f.hex);
        }
        res.end('ok');
      } catch (e) {
        // 保留可诊断性：以前这里只回 'err'，导致探针出错时无从查起
        obs(`http fail: ${req.method} ${req.url} — ${e.message}`);
        res.statusCode = 500; res.end('err');
      }
    });
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      if (APP) { console.log(APP.errors.line('PORT_IN_USE')); }
      else { console.log('✓ 教练服务端已经在运行了，无需重复启动。（本窗口可以直接关闭）'); }
      process.exit(0);
    }
    throw e;
  });
  const PORT = CFG ? CFG.port : 18766;
  server.listen(PORT, '127.0.0.1', () => {
    const ver = APP ? APP.version.display() : '雀魂实时教练';
    const diag = APP ? APP.paths.diagnostics(CFG) : null;
    out('============================================');
    out('  ' + ver + ' 已启动（中继 127.0.0.1:' + PORT + '）');
    out('  决策引擎: Mortal 本地神经网络' + (diag ? ' · ' + diag.modelLabel : ''));
    out('  实时输出: ' + OUT_FILE);
    if (diag) {
      if (!diag.pythonFound) out(APP.errors.line('PYTHON_MISSING'));
      if (diag.model === 'none') out(APP.errors.line('MODEL_NONE'));
      else if (diag.model === 'lite') out(APP.errors.line('MODEL_LITE'));
    }
    out('  页面脚本: http://127.0.0.1:' + PORT + '/coach.user.js');
    out('============================================');
  });
}
