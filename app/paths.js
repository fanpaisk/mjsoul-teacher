'use strict';
/**
 * 运行时路径解析 —— **全项目唯一允许知道"文件在哪"的地方**。
 *
 * 为什么单独抽出来：
 *   1. 打包后目录结构与开发目录不同（runtime/python/ vs engine/akagi/<版本>/...），
 *      旧代码把 `akagi-3.7.1-windows-x64` 写死在 live_coach.js 里，一打包就必然找不到引擎。
 *   2. 以后换运行时（PyInstaller 单文件、内置 python.exe）只改这一个文件。
 *   3. 解耦：功能代码只调 paths.pythonExe()，不关心它是怎么被找到的。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function exists(p) {
  try { return !!p && fs.existsSync(p); } catch (e) { return false; }
}

function firstExisting(list) {
  for (const p of list) if (exists(p)) return p;
  return null;
}

/** 开发目录：engine/akagi/<任意版本>/runtime/python/<arch>/python.exe（版本号不写死） */
function findDevPython() {
  const base = path.join(ROOT, 'engine', 'akagi');
  if (!exists(base)) return null;
  try {
    const versions = fs.readdirSync(base).sort().reverse();
    for (const v of versions) {
      const pyDir = path.join(base, v, 'runtime', 'python');
      if (!exists(pyDir)) continue;
      for (const arch of fs.readdirSync(pyDir)) {
        const exe = path.join(pyDir, arch, 'python.exe');
        if (exists(exe)) return exe;
      }
    }
  } catch (e) {}
  return null;
}

/** 安装版：<安装目录>/runtime/python/python.exe */
function findPackagedPython() {
  return firstExisting([
    path.join(ROOT, 'runtime', 'python', 'python.exe'),
    path.join(ROOT, 'runtime', 'python.exe'),
  ]);
}

const botDir = path.join(ROOT, 'live', 'mjb');

/**
 * Python 解释器。优先级：config.pythonExe > 环境变量 > 安装版目录 > 开发目录。
 * 返回 null 表示"找不到" —— 调用方必须给出可操作的中文提示（不要静默降级）。
 */
function pythonExe(config) {
  const custom = (config && config.pythonExe) || process.env.COACH_PYTHON || null;
  if (custom) return exists(custom) ? custom : null;
  return findPackagedPython() || findDevPython();
}

/** 权重：S42 完整版权重优先，lite 兜底。返回实际会加载的那个。 */
function model() {
  const full = firstExisting([
    path.join(botDir, 'mortal_full.pth'),
    path.join(botDir, 's42-inference.pth'),
  ]);
  if (full) {
    return { file: full, kind: 'full', label: 'Mortal-S42（完整版）', bytes: sizeOf(full) };
  }
  const lite = path.join(botDir, 'mortal.pth');
  if (exists(lite)) {
    return { file: lite, kind: 'lite', label: '精简版（lite，非 S42）', bytes: sizeOf(lite) };
  }
  return { file: null, kind: 'none', label: '未找到模型', bytes: 0 };
}

function sizeOf(p) {
  try { return fs.statSync(p).size; } catch (e) { return 0; }
}

/** userscript 源码（服务端 /coach.user.js 从这里读） */
function userscript() {
  return firstExisting([
    path.join(ROOT, 'live', 'coach_hook.user.js'),
    path.join(ROOT, 'coach_hook.user.js'),
  ]);
}

/** 可写目录：安装版用 %APPDATA%，开发目录用项目根（保持老行为） */
function dataDir(config) {
  if (config && config.dataDir) return config.dataDir;
  if (process.env.COACH_DATA_DIR) return process.env.COACH_DATA_DIR;
  return ROOT;
}

/** 内置网页（设置向导 / 设置页）目录 */
function webDir() {
  return path.join(ROOT, 'app', 'web');
}

/** VC++ 运行库：本机 System32 有，或者随包放在 runtime/python 下 */
function hasVcRuntime() {
  const py = pythonExe(null);
  const dir = py ? path.dirname(py) : null;
  const sys = process.env.WINDIR ? path.join(process.env.WINDIR, 'System32') : 'C:\\Windows\\System32';
  const probe = (d) => d && exists(path.join(d, 'msvcp140.dll'));
  return probe(dir) || probe(sys);
}

/** 用户数据目录（%APPDATA%\MahjongSoulCoach）：配置、用户壁纸都放这里 ——
 *  装进安装目录的东西会在升级/覆盖安装时被清掉（实机踩过：上传的壁纸重启后就没了）。 */
function userDataDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'MahjongSoulCoach');
}

/** 用户自传壁纸目录（与安装目录分离，升级不丢） */
function wallpaperDir() {
  return path.join(userDataDir(), 'wallpaper');
}

/** 随包发布的默认壁纸目录（只读） */
function assetsDir() {
  return path.join(ROOT, 'live', 'assets');
}

module.exports = {
  ROOT, botDir, webDir, userDataDir, wallpaperDir, assetsDir,
  pythonExe, model, userscript, dataDir, hasVcRuntime,
  exists,
  diagnostics(config) {
    const py = pythonExe(config);
    const m = model();
    return {
      root: ROOT,
      python: py,
      pythonFound: !!py,
      bot: path.join(botDir, 'bot.py'),
      botFound: exists(path.join(botDir, 'bot.py')),
      model: m.kind,
      modelLabel: m.label,
      modelSizeMB: Math.round((m.bytes / 1048576) * 10) / 10,
      vcRuntime: hasVcRuntime(),
    };
  },
};
