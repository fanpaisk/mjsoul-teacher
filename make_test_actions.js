// 把已解码牌谱（Record* 事件流）转成 live Action* 测试流
// 用法: node make_test_actions.js <record.json> <seat> [out.jsonl]
// 模拟个性化客户端视角: 只有 seat 自己的 DealTile 带牌面，其余为暗牌
'use strict';
const fs = require('fs');

const rec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const seat = parseInt(process.argv[3] || '0', 10);
const outFile = process.argv[4] || `live/test_actions_seat${seat}.jsonl`;
const details = rec.details || [];

const lines = [];
for (const { name: rawName, data: d } of details) {
  const name = rawName.replace(/^\./, '');
  switch (name) {
    case 'RecordNewRound':
      lines.push({ name: 'ActionNewRound', data: {
        chang: d.chang, ju: d.ju, ben: d.ben,
        tiles: (d['tiles' + seat] || []).slice(),
        dora: (d.doras || [])[0] || null,
        scores: d.scores, liqibang: d.liqibang || 0,
      } });
      break;
    case 'RecordDealTile':
      lines.push({ name: 'ActionDealTile', data: {
        seat: d.seat,
        ...(d.seat === seat && d.tile ? { tile: d.tile } : {}),
        ...(d.doras && d.doras.length ? { doras: d.doras } : {}),
      } });
      break;
    case 'RecordDiscardTile':
      lines.push({ name: 'ActionDiscardTile', data: {
        seat: d.seat, tile: d.tile, is_liqi: !!d.is_liqi, moqie: !!d.moqie,
        ...(d.doras && d.doras.length ? { doras: d.doras } : {}),
      } });
      break;
    case 'RecordChiPengGang':
      lines.push({ name: 'ActionChiPengGang', data: {
        seat: d.seat, type: d.type, tiles: d.tiles, froms: d.froms,
        ...(d.doras && d.doras.length ? { doras: d.doras } : {}),
      } });
      break;
    case 'RecordAnGangAddGang':
      lines.push({ name: 'ActionAnGangAddGang', data: {
        seat: d.seat, type: d.type, tiles: d.tiles,
        ...(d.doras && d.doras.length ? { doras: d.doras } : {}),
      } });
      break;
    case 'RecordHule':
      lines.push({ name: 'ActionHule', data: { hules: d.hules, delta_scores: d.delta_scores || [] } });
      break;
    case 'RecordNoTile':
    case 'RecordLiuJu':
      lines.push({ name: 'ActionNoTile', data: {} });
      break;
    default:
      break;
  }
}
fs.writeFileSync(outFile, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
console.log(`${lines.length} actions → ${outFile} (seat=${seat}, 首局庄家=${details[0].data.ju})`);
