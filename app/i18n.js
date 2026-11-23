'use strict';
/**
 * 多语言：字典 + t()。零依赖，纯函数。
 *
 * 设计：
 *   · zh-CN 是源语言，也是**兜底**：任何语言缺 key 都回退中文，并留一条日志
 *   · 字典是扁平的 "a.b.c" 键，方便 grep 和 diff
 *   · 新增语言只要放 app/i18n/<tag>.json，不用改代码
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'i18n');
const SOURCE = 'zh-CN';
const SUPPORTED = ['zh-CN', 'en', 'ja', 'ko'];
const cache = new Map();
let onMissing = null;

function readDict(lang) {
  if (cache.has(lang)) return cache.get(lang);
  let d = {};
  try {
    d = JSON.parse(fs.readFileSync(path.join(DIR, lang + '.json'), 'utf8'));
  } catch (e) { d = {}; }
  cache.set(lang, d);
  return d;
}

/** 'en-US' → 'en'；未知 → zh-CN */
function normalize(tag) {
  const t = String(tag || '').toLowerCase();
  if (!t || t === 'auto') return null;
  if (t.startsWith('zh')) return 'zh-CN';
  for (const s of SUPPORTED) if (t === s.toLowerCase() || t.startsWith(s.split('-')[0])) return s;
  return null;
}

/** 该语言是否有真实翻译（空文件视为未翻译） */
function translated(lang) {
  return Object.keys(readDict(lang)).length > 0;
}

/** 可切换的语言列表（未翻译的不列出） */
function available() {
  return SUPPORTED.filter((l) => l === SOURCE || translated(l));
}

/** 完整字典：源语言打底，目标语言覆盖 */
function dict(lang) {
  const out = Object.assign({}, readDict(SOURCE));
  if (lang && lang !== SOURCE) Object.assign(out, readDict(lang));
  return out;
}

function t(lang, key, vars) {
  const d = dict(lang);
  let s = d[key];
  if (s === undefined) {
    if (onMissing) onMissing(String(lang), key);
    s = readDict(SOURCE)[key];
  }
  if (s === undefined) return key;
  return String(s).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
}

module.exports = { SOURCE, SUPPORTED, normalize, dict, t, available, translated, setMissingLogger: (fn) => { onMissing = fn; } };
