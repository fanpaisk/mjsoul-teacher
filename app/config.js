'use strict';
/**
 * 配置层：默认值 → config.json（用户级）→ 环境变量，命令行参数由入口最后覆盖。
 *
 * 为什么要单独一层：
 *   - 现在"配置"分散在 live/coach_settings.json（只有 reviewMode 一个布尔）、
 *     命令行开关（--review/--dark-tiles）、以及硬编码常量（端口 18766）三处，
 *     加一个选项就要动三个地方 —— 这正是"没法迭代"的根源。
 *   - 以后加功能（主题、面板布局、引擎参数、快捷键）只改 DEFAULTS + 一处读取。
 *
 * 兼容：老文件 live/coach_settings.json 仍然读，优先级低于 config.json。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');

/**
 * 公共版边界（DECISIONS D5 / D44）：只允许**复盘模式**。
 *
 * 实时模式（摸牌瞬间就给建议）太接近代打，而这个工具的定位是"事后复盘、提升牌效"。
 * 功能代码保留（以后要放开只改这一个开关再打包），但**用户没有办法打开它**：
 *   · 设置页只有一行只读的"复盘模式（固定）"
 *   · POST /api/settings 传 realtime 会被拒（400）
 *   · 命令行 --realtime 被忽略，config.json 里的 mode 也被强制覆盖
 */
const REVIEW_ONLY = true;

const DEFAULTS = {  port: 18766,
  // null = 不表态，跟随旧行为（live/coach_settings.json 的 reviewMode，缺省=实时）。
  // 公共版安装器会显式写入 'review'；这里给 null 是为了**不悄悄改变老用户的行为**。
  mode: null,              // 'review' = 切完才提醒 | 'realtime' = 摸牌即提醒
  tileDark: false,         // 默认黑牌（直播防偷看）
  pythonExe: null,         // null = 自动探测（app/paths.js）
  dataDir: null,           // null = 项目根 / 安装版由启动器设置
  logLevel: 'info',
  checkUpdates: true,
  panel: { showBadge: true },
};

const FILE_NAMES = ['config.json'];

function readJson(p) {
  try {
    // 去掉 BOM：PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 BOM，
    // 而 JSON.parse('\uFEFF{...}') 会直接抛 —— 配置文件被静默忽略过（打包后才发现）
    const txt = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(txt);
  } catch (e) { return null; }
}

/** 候选配置文件：安装目录的 config.json 是**基线**（随包发布的默认值），
 *  用户级 %APPDATA% 覆盖它（后读的赢）。顺序不能反 —— 反了用户就改不动默认值。 */
function candidateFiles() {
  const out = [];
  for (const n of FILE_NAMES) out.push(path.join(ROOT, n));
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  out.push(path.join(appData, 'MahjongSoulCoach', 'config.json'));
  return out;
}

let cached = null;
let modeDerived = false;   // mode 是否是从旧 coach_settings.json 推出来的（不是用户显式选的）

function load() {
  if (cached) return cached;
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));

  // 老配置（只有 reviewMode）：仅在 config.json 没有 mode 时兜底
  const legacy = readJson(path.join(ROOT, 'live', 'coach_settings.json'));
  let hadMode = false;

  for (const f of candidateFiles()) {
    const j = readJson(f);
    if (!j) continue;
    if (j.mode !== undefined) hadMode = true;
    Object.assign(cfg, j);
    cfg.panel = Object.assign({}, DEFAULTS.panel, j.panel || {});
  }
  if (!hadMode && legacy && legacy.reviewMode !== undefined) {
    cfg.mode = legacy.reviewMode ? 'review' : 'realtime';
    modeDerived = true;
  }
  // 公共版：无论文件里写了什么，一律复盘（用户改不出来）
  if (REVIEW_ONLY) { cfg.mode = 'review'; modeDerived = false; }

  // 环境变量（打包/调试用）优先于文件
  if (process.env.COACH_PORT) cfg.port = parseInt(process.env.COACH_PORT, 10) || cfg.port;
  if (process.env.COACH_PYTHON) cfg.pythonExe = process.env.COACH_PYTHON;
  if (process.env.COACH_DATA_DIR) cfg.dataDir = process.env.COACH_DATA_DIR;

  cached = cfg;
  return cfg;
}

/** 命令行覆盖（入口调用一次，保证 --review/--dark-tiles 仍然有效） */
function applyCli(cfg, argv) {
  const args = argv || [];
  if (REVIEW_ONLY) {
    cfg.mode = 'review';          // 忽略 --realtime
  } else {
    if (args.includes('--review')) cfg.mode = 'review';
    if (args.includes('--realtime')) cfg.mode = 'realtime';
  }
  if (args.includes('--dark-tiles')) cfg.tileDark = true;
  const p = args.find(a => a.startsWith('--port='));
  if (p) cfg.port = parseInt(p.split('=')[1], 10) || cfg.port;
  return cfg;
}

/** 写回用户级配置（设置页用；开发时不写项目根，避免污染仓库） */
function save(patch) {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const dir = path.join(appData, 'MahjongSoulCoach');
  const file = path.join(dir, 'config.json');
  const cur = Object.assign({}, load(), patch || {});
  // 不要把"从旧文件推出来的" mode 固化进 config.json：
  // 否则用户以后改 live/coach_settings.json 就再也不生效了，而且从文件里看不出这是推导值。
  if (modeDerived && (!patch || patch.mode === undefined)) cur.mode = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cur, null, 2) + '\n', 'utf8');
    cached = cur;
    return { ok: true, file };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 设置接口的入参校验（P0 安全）。
 *
 * 为什么必须做：`/api/settings` 以前把请求体直接 merge 进配置，而 `config.pythonExe`
 * 会被当作解释器 `spawn` 起来 —— 等于"任何能 POST 的网页都能让下一次开局执行任意 exe"。
 * 这里只放行已知字段，且 pythonExe 必须落在安装目录里、文件名像 python。
 *
 * @returns {{ok:boolean, value?:object, error?:string}}
 */
function sanitize(patch, rootDir) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: '请求体必须是 JSON 对象' };
  }
  const out = {};
  const bad = [];

  if ('mode' in patch) {
    if (REVIEW_ONLY) {
      if (patch.mode === null || patch.mode === 'review') out.mode = patch.mode;
      else bad.push('mode（公共版只支持复盘模式）');
    } else if (patch.mode === null || patch.mode === 'review' || patch.mode === 'realtime') {
      out.mode = patch.mode;
    } else bad.push('mode');
  }
  if ('tileDark' in patch) {
    if (typeof patch.tileDark === 'boolean') out.tileDark = patch.tileDark; else bad.push('tileDark');
  }
  if ('checkUpdates' in patch) {
    if (typeof patch.checkUpdates === 'boolean') out.checkUpdates = patch.checkUpdates; else bad.push('checkUpdates');
  }
  if ('port' in patch) {
    const n = parseInt(patch.port, 10);
    if (Number.isInteger(n) && n >= 1024 && n <= 65535) out.port = n; else bad.push('port');
  }
  if ('logLevel' in patch) {
    if (patch.logLevel === 'info' || patch.logLevel === 'debug') out.logLevel = patch.logLevel;
    else bad.push('logLevel');
  }
  if ('panel' in patch) {
    if (patch.panel && typeof patch.panel === 'object' && typeof patch.panel.showBadge === 'boolean') {
      out.panel = { showBadge: patch.panel.showBadge };
    } else bad.push('panel');
  }
  if ('pythonExe' in patch) {
    if (patch.pythonExe === null) {
      out.pythonExe = null;
    } else {
      const abs = path.resolve(String(patch.pythonExe || ''));
      const rel = path.relative(rootDir || ROOT, abs);
      const inside = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      const nameOk = /^pythonw?\.exe$/i.test(path.basename(abs));
      if (inside && nameOk) out.pythonExe = abs; else bad.push('pythonExe（必须在安装目录内且是 python.exe）');
    }
  }

  if (bad.length) return { ok: false, error: '字段不合法：' + bad.join('、') };
  if (!Object.keys(out).length) return { ok: false, error: '没有可保存的字段' };
  return { ok: true, value: out };
}

module.exports = { DEFAULTS, REVIEW_ONLY, load, save, applyCli, candidateFiles, sanitize };
