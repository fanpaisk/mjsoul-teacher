'use strict';
/**
 * 面向用户的错误文案 —— 全部集中在这里。
 *
 * 旧行为：引擎挂掉只打 `⚠ Mortal 引擎退出（code 1），下次出牌自动重启…`，
 * 用户看不懂、也不知道该做什么，而真正的排障信息只能在 obs 日志里找。
 * 标准化产品的要求是"每条错误都说清三件事：怎么了 / 为什么 / 怎么办"。
 *
 * 以后加功能只在这里加条目，不要在业务代码里拼中文句子。
 */

const EN = {
  PYTHON_MISSING: {
    short: 'Engine cannot start: Python runtime not found',
    why: 'runtime/python/python.exe is missing from the install dir, or engine/akagi/ is absent in a dev checkout.',
    todo: 'Run the installer again to repair; for dev, unpack Akagi 3.7.x into engine/akagi/ or set pythonExe in config.json.',
  },
  BOT_MISSING: {
    short: 'Engine cannot start: bot.py not found',
    why: 'live/mjb/bot.py is missing — the package is incomplete.',
    todo: 'Run the installer again (choose Repair).',
  },
  MODEL_LITE: {
    short: 'Using the lite model (not S42)',
    why: 'mortal_full.pth was not found, so the engine fell back to the lite model; decisions get noticeably worse.',
    todo: 'Download the full model from Settings (~43 MB), or place it at live/mjb/mortal_full.pth.',
  },
  MODEL_NONE: {
    short: 'Engine cannot start: no model weights',
    why: 'Neither mortal_full.pth nor mortal.pth exists under live/mjb/.',
    todo: 'Download the full model from Settings (~43 MB).',
  },
  PORT_IN_USE: {
    short: 'Port already in use — coach did not start',
    why: 'Another coach instance or program is bound to 127.0.0.1:18766.',
    todo: 'Stop it from the tray menu, or kill leftover node.exe; you can also change the port in Settings.',
  },
  USERSCRIPT_STALE: {
    short: 'Userscript is out of date',
    why: 'Tampermonkey has an older script version; fields may be missing.',
    todo: 'Open http://127.0.0.1:18766/coach.user.js and reinstall (Tampermonkey asks to update).',
  },
  ENGINE_CRASH: {
    short: 'Engine exited unexpectedly',
    why: 'Usually a failed model load, out of memory, or the runtime was blocked by antivirus.',
    todo: 'Tray menu → Export diagnostics and send the log. The coach retries on the next hand.',
  },
};

const CODES = {
  PYTHON_MISSING: {
    zh: '引擎无法启动：找不到 Python 运行时',
    why: '安装目录里缺少 runtime/python/python.exe，或开发环境没有 engine/akagi/。',
    todo: '安装版请重新运行安装程序修复；开发环境请解压 Akagi 3.7.x 到 engine/akagi/，或在 config.json 里设置 pythonExe。',
  },
  BOT_MISSING: {
    zh: '引擎无法启动：找不到 bot.py',
    why: 'live/mjb/bot.py 缺失，安装包不完整。',
    todo: '重新运行安装程序（选择"修复"）。',
  },
  MODEL_LITE: {
    zh: '当前使用精简版权重（不是 S42）',
    why: '没有找到 mortal_full.pth，引擎回退到 lite 模型，决策质量会明显下降。',
    todo: '在设置页点"下载完整版模型"（约 43 MB），或手动放到 live/mjb/mortal_full.pth。',
  },
  MODEL_NONE: {
    zh: '引擎无法启动：没有任何模型权重',
    why: 'live/mjb/ 下既没有 mortal_full.pth 也没有 mortal.pth。',
    todo: '在设置页下载完整版模型（约 43 MB）。',
  },
  PORT_IN_USE: {
    zh: '端口被占用，教练没有启动',
    why: '另一个教练实例或别的程序已经占用了 127.0.0.1:18766。',
    todo: '先在托盘菜单里"停止"，或结束残留的 node.exe；也可以改端口（设置页）。',
  },
  USERSCRIPT_STALE: {
    zh: '页面脚本版本过旧',
    why: 'Tampermonkey 里装的是旧版脚本，与服务端不匹配可能缺少字段。',
    todo: '打开 http://127.0.0.1:18766/coach.user.js 重新安装（Tampermonkey 会弹更新确认）。',
  },
  ENGINE_CRASH: {
    zh: '引擎异常退出',
    why: '通常是模型加载失败、显存/内存不足，或运行时被杀毒软件拦截。',
    todo: '托盘菜单 → 导出诊断包，把日志发给开发者。教练会在下一手自动重试。',
  },
};

function get(code, lang) {
  const base = CODES[code] || { zh: code, why: '', todo: '' };
  if (lang === 'en' && EN[code]) return { zh: EN[code].short, why: EN[code].why, todo: EN[code].todo };
  return base;
}

/** 单行版（日志/面板用） */
function line(code, lang) {
  const c = get(code, lang);
  return `⚠ ${c.zh}${c.todo ? ' —— ' + c.todo : ''}`;
}

/** 引擎退出码 → 可读文案 */
function engineExit(code, ctx, lang) {
  const c = get('ENGINE_CRASH', lang);
  const extra = ctx && ctx.hadModel === false ? '（当时没找到模型：' + ctx.modelLabel + '）' : '';
  return `⚠ ${c.zh}（退出码 ${code}）${extra} —— ${c.todo}`;
}

module.exports = { CODES, EN, get, line, engineExit };
