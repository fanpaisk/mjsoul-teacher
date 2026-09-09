// 用 tensoul 的 convert.js 把我们解码的牌谱转成天凤 tenhou.net/6 格式
// 用法: node to_tenhou.js record_<uuid>.json out_tenhou.json
const fs = require('fs');
const path = require('path');

const file = process.argv[2], outFile = process.argv[3];
const record = JSON.parse(fs.readFileSync(file, 'utf8'));

// 组装 tensoul 期望的输入：head + data(解码后的动作数组，带 __type)
const actions = record.details.map(d => ({ __type: d.name, ...d.data }));
const head = record.head;
if (!head.result || !head.result.players) {
  head.result = { players: (head.accounts || []).map(a => ({ seat: a.seat })) };
}
if (!head.config) head.config = { meta: {}, mode: { mode: 12, detail_rule: {} } };
if (!head.config.meta) head.config.meta = {};
if (!head.config.mode) head.config.mode = { mode: 12, detail_rule: {} };

const convert = require('./convert_adapted.js');
const tenhou = convert.parse({ head, data: actions });

// tensoul 的点数变动数组可能含 null（未参与玩家），reviewer 需要严格 i32，全部归 0
for (const k of tenhou.log) {
  for (const r of k[16] || []) {
    if (Array.isArray(r)) for (let i = 0; i < r.length; i++) if (r[i] == null) r[i] = 0; // undefined/null 都归 0
  }
  if (Array.isArray(k[1]) && Array.isArray(k[1][0])) k[1] = k[1][0]; // 记分板平铺
}

fs.writeFileSync(outFile, JSON.stringify(tenhou));
console.log('written', outFile, 'kyokus =', tenhou.log.length);
