// liqi 解码器共享模块（从 fetch_record2 提取）
'use strict';
const fs = require('fs');
const path = require('path');
const TREE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'liqi_new.json'), 'utf8')).nested.lq.nested;
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


module.exports = { byPath, shortMap, resolveType, ev, lenP, decBig, dec, cvtVar, encodeMsg, decodeMsg, W };
