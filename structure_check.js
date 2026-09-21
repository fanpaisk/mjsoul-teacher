// 最终体检：所有面板函数唯一性检查
'use strict';
const fs = require('fs');
const s = fs.readFileSync('live/coach_hook.user.js', 'utf8');
let ok = true;
const items = [
  'const fmtLine', 'const adviceNode', 'const renderP', 'const pollP',
  'function markNode', 'function candNode', 'function tileNode', 'function chipNode',
  'function applyPanelSize', 'function applyTilesMode', 'function applyBgMedia',
  'function newGroup', 'function groupCenter', 'function setGroupMark',
  'let openGroup', 'let since', 'pollBusy', 'setInterval(pollP', '蝶引',
];
for (const fn of items) {
  const c = s.split(fn).length - 1;
  const pass = c === 1;
  if (!pass) ok = false;
  console.log((pass ? '✓' : '✗') + ' ' + fn + ' ×' + c);
}
console.log(ok ? '=== 结构就绪 ===' : '=== 有重复/缺失 ===');
process.exit(ok ? 0 : 1);
