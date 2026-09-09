// 雀魂牌谱拉取（最终版）
// 流程: requestConnection -> oauth2Check -> oauth2Login -> fetchGameRecord
// 协议: wss://route-N.maj-soul.com/gateway, 帧 = [0x02][seq uint16LE][Wrapper protobuf]
// 响应: [0x03][seq 回显][Wrapper{name:"", data: <响应消息>}]
const fs = require('fs');
const path = require('path');

const UUIDS = process.argv.slice(2).map(u => u.replace(/_[a-zA-Z0-9]+$/, ''));
if (!UUIDS.length) { console.error('usage: node fetch_record2.js <uuid>...'); process.exit(1); }

const secrets = JSON.parse(fs.readFileSync(path.join(__dirname, 'secrets.local.json'), 'utf8'));
const TOKEN = secrets.access_token;
const DEVICE_ID = secrets.device_id || '424a7e6b-dc4e-435d-8ed1-1659c2453ff5';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

// ---------- 描述文件索引（支持 protobuf 嵌套定义） ----------
const TREE = JSON.parse(fs.readFileSync(path.join(__dirname, 'liqi_new.json'), 'utf8')).nested.lq.nested;
const byPath = {};   // 'RecordGame.AccountInfo' -> fields
const shortMap = {}; // 'AccountInfo' -> 'RecordGame.AccountInfo'（首个注册者获胜）
(function walk(node, p) {
  for (const [k, v] of Object.entries(node || {})) {
    const cur = p ? p + '.' + k : k;
    if (v && v.fields) { byPath[cur] = v.fields; if (!shortMap[k]) shortMap[k] = cur; }
    if (v && v.nested) walk(v.nested, cur);
  }
})(TREE, '');
function resolveType(ctx, t) {
  if (byPath[ctx + '.' + t]) return ctx + '.' + t;
  if (byPath[t]) return t;
  if (shortMap[t]) return shortMap[t];
  return null; // 标量或枚举
}

// ---------- protobuf ----------
function ev(v) { v = BigInt(v); const o = []; do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; o.push(b); } while (v); return Buffer.from(o); }
function lenP(b) { return Buffer.concat([ev(b.length), b]); }
function decBig(buf, pos) {
  let r = 0n, s = 0n;
  for (;;) { const b = buf[pos++]; r |= BigInt(b & 0x7f) << s; if (!(b & 0x80)) break; s += 7n; }
  return [r, pos];
}
function dec(buf, pos) { const [r, p] = decBig(buf, pos); return [Number(r), p]; }
// 按字段类型转换 varint：int32/int64 需要补码解释
function cvtVar(f, big) {
  if (!f) return Number(big);
  if (f.type === 'int32' || f.type === 'sfixed32') return Number(BigInt.asIntN(32, big));
  if (f.type === 'int64' || f.type === 'sfixed64') return Number(BigInt.asIntN(64, big));
  return Number(big);
}
function encodeMsg(name, obj) {
  const spec = byPath[name];
  if (!spec) throw new Error('no spec for ' + name);
  const parts = [];
  for (const [fname, val] of Object.entries(obj)) {
    if (val === undefined || val === null) continue;
    const f = spec[fname];
    if (!f) { console.log('[pb] skip unknown', name + '.' + fname); continue; }
    const mt = resolveType(name, f.type);
    const wt = mt || f.type === 'string' || f.type === 'bytes' ? 2 : 0;
    const tag = ev((f.id << 3) | wt);
    const vals = f.rule === 'repeated' ? [].concat(val) : [val];
    for (const v of vals) {
      if (mt) parts.push(tag, lenP(encodeMsg(mt, v)));
      else if (f.type === 'string') parts.push(tag, lenP(Buffer.from(String(v))));
      else if (f.type === 'bytes') parts.push(tag, lenP(v));
      else parts.push(tag, ev(v));
    }
  }
  return Buffer.concat(parts);
}
function decodeMsg(name, buf) {
  const spec = byPath[name];
  const out = {};
  if (!spec) return { __b64: buf.toString('base64') };
  const assign = (f, key, val, packed) => {
    if (f.rule === 'repeated' && !packed) (out[key] = out[key] || []).push(val);
    else out[key] = val; // packed 标量数组或单值：整体赋值
  };
  let pos = 0;
  while (pos < buf.length) {
    let tag; [tag, pos] = dec(buf, pos);
    const fid = tag >> 3, wt = tag & 7;
    const f = Object.values(spec).find(x => x.id === fid);
    const key = f ? (f.name || Object.keys(spec).find(k => spec[k].id === fid)) : null;
    let val;
    if (wt === 0) {
      let big; [big, pos] = decBig(buf, pos);
      val = cvtVar(f, big);
      if (!f) continue;
      assign(f, key, val, false);
    } else if (wt === 1) {
      val = buf.readDoubleLE(pos); pos += 8;
      if (!f) continue;
      assign(f, key, val, false);
    } else if (wt === 2) {
      let len; [len, pos] = dec(buf, pos);
      const s = buf.subarray(pos, pos + len); pos += len;
      const mt = f ? resolveType(name, f.type) : null;
      if (!f) continue;
      if (f.type === 'string') val = s.toString('utf8');
      else if (f.type === 'bytes') val = s;
      else if (mt) val = decodeMsg(mt, s);
      else {
        // packed 重复标量：一次 wire 块内多个值
        val = []; let p = 0; while (p < s.length) { let v; [v, p] = decBig(s, p); val.push(cvtVar(f, v)); }
      }
      const packed = !mt && f.type !== 'string' && f.type !== 'bytes';
      assign(f, key, val, packed);
    } else if (wt === 5) {
      val = buf.readFloatLE(pos); pos += 4;
      if (!f) continue;
      assign(f, key, val, false);
    } else break;
  }
  return out;
}
const W = (name, data) => Buffer.concat([ev((1 << 3) | 2), lenP(Buffer.from(name)), ev((2 << 3) | 2), lenP(data)]);

function parseDetailRecords(data) {
  const outer = decodeMsg('Wrapper', data);
  const body = outer.data && outer.name && outer.name.includes('GameDetailRecords') ? outer.data : data;
  const gdr = decodeMsg('GameDetailRecords', body);
  const details = [];
  for (const a of (gdr.actions || [])) {
    if (!a.result || !a.result.length) continue;
    const w = decodeMsg('Wrapper', a.result);
    if (!w.name) continue;
    const clean = String(w.name).replace(/^\./, '').replace(/^lq\./, '');
    const pathKey = byPath[clean] ? clean : (shortMap[clean] || clean);
    details.push({ name: pathKey.split('.').pop(), data: decodeMsg(pathKey, w.data) });
  }
  return { version: gdr.version, details };
}

// ---------- WS ----------
const CAP_REQCONN = '0201000a1b2e6c712e526f7574652e72657175657374436f6e6e656374696f6e121610011a07726f7574652d352093a6f3d4063203576562';
const payloadOf = (hex) => Buffer.from(hex, 'hex').subarray(3);

function encodeOauth2Check() {
  return Buffer.concat([ev((1 << 3) | 0), ev(0), ev((2 << 3) | 2), lenP(Buffer.from(TOKEN))]);
}
function encodeOauth2Login() {
  const body = encodeMsg('ReqOauth2Login', {
    type: 0,
    access_token: TOKEN,
    reconnect: false,
    device: {
      platform: 'pc', hardware: 'pc', os: 'windows', os_version: 'win10',
      is_browser: true, software: 'Chrome', sale_platform: 'web',
      screen_width: 1280, screen_height: 720, user_agent: UA,
    },
    random_key: DEVICE_ID,
    client_version: { resource: '0.16.274', package: '4.0.46' },
    currency_platforms: [1, 2, 5, 6, 8, 10, 11],
    client_version_string: 'WebGL_2022-0.16.274',
    tag: 'cn',
  });
  const extra = Buffer.concat([ev((13 << 3) | 0), ev(1), ev((14 << 3) | 2), lenP(Buffer.from(DEVICE_ID))]);
  return Buffer.concat([body, extra]);
}
function encodeReqGameRecord(uuid) {
  return Buffer.concat([ev((1 << 3) | 2), lenP(Buffer.from(uuid)), ev((2 << 3) | 2), lenP(Buffer.from('WebGL_2022-0.16.274'))]);
}

(async () => {
  const ws = new WebSocket('wss://route-5.maj-soul.com/gateway');
  ws.binaryType = 'arraybuffer';
  const bySeq = new Map();
  ws.addEventListener('message', (e) => {
    const b = Buffer.from(e.data);
    const seq = b.readUInt16LE(1);
    let inner = b.subarray(3), name = '';
    try { const w = decodeMsg('Wrapper', inner); if (w.name) name = w.name; if (w.data) inner = w.data; } catch (err) {}
    if (name.includes('notify')) { console.log('[ws] notify:', name); return; }
    const w = bySeq.get(seq);
    if (w) { bySeq.delete(seq); w(inner); }
    else console.log('[ws] unmatched seq=' + seq + ' name=' + (name || '(empty)'));
  });
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });

  let seq = 0;
  const call = (payloadBuf, ms = 20000) => new Promise((resolve, reject) => {
    const my = ++seq;
    const head = Buffer.alloc(3); head[0] = 2; head.writeUInt16LE(my, 1);
    bySeq.set(my, resolve);
    ws.send(Buffer.concat([head, payloadBuf]));
    setTimeout(() => { if (bySeq.has(my)) { bySeq.delete(my); reject(new Error('timeout seq ' + my)); } }, ms);
  });

  await call(payloadOf(CAP_REQCONN)); console.log('[main] requestConnection ok');
  await call(W('.lq.Lobby.oauth2Check', encodeOauth2Check())); console.log('[main] oauth2Check ok');
  const loginResp = await call(W('.lq.Lobby.oauth2Login', encodeOauth2Login()));
  const loginRes = decodeMsg('ResLogin', loginResp);
  if (loginRes.error && (loginRes.error.code || loginRes.error.id)) {
    console.log('[main] LOGIN ERROR:', JSON.stringify(loginRes.error)); process.exit(2);
  }
  console.log('[main] logged in as', loginRes.account_id);

  for (const uuid of UUIDS) {
    try {
      const resp = await call(W('.lq.Lobby.fetchGameRecord', encodeReqGameRecord(uuid)), 30000);
      const res = decodeMsg('ResGameRecord', resp);
      if (res.error && (res.error.code || res.error.id)) { console.log('[main] RECORD ERROR', uuid, JSON.stringify(res.error)); continue; }
      let data = res.data || null;
      if (!data && res.data_url) {
        const r = await fetch(res.data_url);
        data = Buffer.from(await r.arrayBuffer());
        if (data[0] === 0x7b) data = Buffer.from(JSON.parse(data.toString('utf8')).data, 'base64');
      }
      if (!data) { console.log('[main] no data for', uuid); continue; }
      fs.writeFileSync(path.join(__dirname, `raw_${uuid}.bin`), data);
      const parsed = parseDetailRecords(data);
      fs.writeFileSync(path.join(__dirname, `record_${uuid}.json`), JSON.stringify({ head: res.head || null, details: parsed.details }));
      console.log('[main] SAVED', uuid, 'details=' + parsed.details.length);
    } catch (e) { console.log('[main] fail', uuid, e.message); }
  }
  ws.close();
  console.log('[main] DONE');
  process.exit(0);
})().catch(e => { console.error('[main] fatal:', e.message || e); process.exit(1); });
