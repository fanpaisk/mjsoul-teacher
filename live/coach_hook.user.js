// ==UserScript==
// @name         雀魂实时教练钩子
// @namespace    majsoul-coach
// @version      1.19.0
// @description  捕获雀魂 WebSocket 帧转发到本地教练（127.0.0.1:18766），并在游戏内显示实时建议悬浮面板。
// @match        https://game.maj-soul.com/*
// @match        https://game.mahjongsoul.com/*
// @match        https://www.majsoul.com/*
// @match        https://majsoul.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(() => {
  'use strict';
  // 页面真实窗口（钩 WebSocket 必须在页面世界里做）
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (W.__liveHook) return;
  W.__liveHook = { frames: 0, errors: 0, posted: 0, bytes: 0, big: 0, viaGM: typeof GM_xmlhttpRequest === 'function' };
  const RELAY = 'http://127.0.0.1:18766/frame';
  const MAX = 262144; // 256KB：完整转发，绝不截断
  const toHex = (u8) => {
    let h = '';
    const n = Math.min(u8.length, MAX);
    for (let i = 0; i < n; i++) h += u8[i].toString(16).padStart(2, '0');
    return h;
  };
  // 发送走 GM 通道（篡改猴后台直发，绕过页面 CSP/PNA/本地网络权限限制），fetch 仅兜底
  const post = (payload) => {
    W.__liveHook.posted++;
    const body = JSON.stringify(payload);
    if (typeof GM_xmlhttpRequest === 'function') {
      try {
        GM_xmlhttpRequest({
          method: 'POST',
          url: RELAY,
          data: body,
          headers: { 'Content-Type': 'application/json' },
          timeout: 8000,
          onerror: () => { W.__liveHook.errors++; },
          ontimeout: () => { W.__liveHook.errors++; },
        });
      } catch (e) { W.__liveHook.errors++; }
    } else {
      try { fetch(RELAY, { method: 'POST', body }).catch(() => { W.__liveHook.errors++; }); } catch (e) { W.__liveHook.errors++; }
    }
  };
  const teeU8 = (dir, ws, u8) => {
    try {
      if (u8 && u8.length >= 2) {
        W.__liveHook.frames++;
        W.__liveHook.bytes += u8.length;
        if (u8.length > 8192) W.__liveHook.big++;
        post({ dir, url: String((ws && ws.url) || ''), hex: toHex(u8) });
      }
    } catch (e) { W.__liveHook.errors++; }
  };
  const tee = (dir) => function (data) {
    try {
      // instanceof 必须用页面世界的构造器（隔离世界里 ev.data 来自页面）
      if (data instanceof W.ArrayBuffer) teeU8(dir, this, new W.Uint8Array(data));
      else if (data instanceof W.Uint8Array) teeU8(dir, this, data);
      else if (W.Blob && data instanceof W.Blob) {
        data.arrayBuffer().then(ab => teeU8(dir, this, new W.Uint8Array(ab))).catch(() => W.__liveHook.errors++);
      }
    } catch (e) { W.__liveHook.errors++; }
  };

  const WS = W.WebSocket;

  // 1) 出帧：原型 send 钩子
  const oSend = WS.prototype.send;
  WS.prototype.send = function (data) {
    try { tee('out').call(this, data); } catch (e) {}
    return oSend.call(this, data);
  };

  // 2) 入帧：包装 onmessage（保留原生槽位语义，不影响游戏分发）
  const omDesc = Object.getOwnPropertyDescriptor(WS.prototype, 'onmessage');
  if (omDesc && omDesc.set) {
    const nativeGet = omDesc.get, nativeSet = omDesc.set;
    Object.defineProperty(WS.prototype, 'onmessage', {
      configurable: true,
      get() { return nativeGet.call(this); },
      set(fn) {
        if (typeof fn === 'function') {
          const teeFn = tee('in');
          const wrapped = function (ev) { try { teeFn.call(this, ev.data); } catch (e) {} return fn.call(this, ev); };
          nativeSet.call(this, wrapped);
        } else {
          nativeSet.call(this, fn);
        }
      },
    });
  }

  // 3) 入帧兜底：addEventListener('message') 包装
  const oAdd = WS.prototype.addEventListener;
  WS.prototype.addEventListener = function (type, fn, opts) {
    if (type === 'message' && typeof fn === 'function' && !fn.__liveTeed) {
      const teeFn = tee('in');
      const wrapped = function (ev) { try { teeFn.call(this, ev.data); } catch (e) {} return fn.call(this, ev); };
      wrapped.__liveTeed = true;
      return oAdd.call(this, type, wrapped, opts);
    }
    return oAdd.call(this, type, fn, opts);
  };

  // 4) 状态角标
  const badge = document.createElement('div');
  badge.textContent = '教练钩子启动中…';
  badge.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:2147483647;background:rgba(0,0,0,.55);color:#9c9;padding:2px 8px;font-size:12px;line-height:1.4;border-radius:4px;pointer-events:none;font-family:sans-serif;letter-spacing:.5px;';
  const mount = () => { (document.body || document.documentElement).appendChild(badge); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
  setInterval(() => { try { if (!badge.isConnected) mount(); } catch (e) {} }, 3000);
  setInterval(() => {
    const s = W.__liveHook;
    const kb = s.bytes > 1024 ? (s.bytes / 1024).toFixed(0) + 'K' : s.bytes;
    badge.textContent = `教练${s.viaGM ? '[GM]' : ''} ${s.frames}帧/${kb}B` + (s.big ? `/大帧${s.big}` : '') + (s.errors ? `/错${s.errors}` : '');
    badge.style.color = s.errors ? '#fa8' : '#9c9';
  }, 2000);

  // 5) 实时建议悬浮面板（可拖动 / 可折叠 / 自动滚动）
  const PANEL_KEY = 'coach_panel_v1';
  let pState = { x: null, y: null, w: null, collapsed: false, hidden: false, tileDark: false };
  try { Object.assign(pState, JSON.parse(localStorage.getItem(PANEL_KEY) || '{}')); } catch (e) {}
  const saveP = () => { try { localStorage.setItem(PANEL_KEY, JSON.stringify(pState)); } catch (e) {} };
  let skinRatio = 0; // 皮肤媒体 高/宽 比（视频或图片加载后得到）
  function applyPanelSize() {
    let w = Math.round(pState.w || 450);
    if (skinRatio > 0) {
      const maxW = Math.floor((window.innerHeight - 60) / skinRatio); // 高度不超出屏幕
      w = Math.min(w, maxW);
    }
    const z = w / 450;
    panel.style.zoom = z;           // 内容整体等比缩放（文字/牌面/表情/视频全跟随）
    panel.style.width = '450px';    // 基准宽度
    if (skinRatio > 0) panel.style.height = Math.round(450 * skinRatio) + 'px';
    pState.w = w;
  }
  const panel = document.createElement('div');
  panel.id = 'cjc-panel';
  panel.style.cssText = 'position:fixed;top:12px;right:12px;width:450px;z-index:2147483646;font-family:sans-serif;background:linear-gradient(168deg,rgba(44,26,33,.94),rgba(22,12,18,.93));border:1px solid rgba(166,30,42,.45);border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.5),0 0 14px rgba(166,30,42,.2);overflow:hidden;';
  // 背景视频：GM 通道取本地视频 blob，视频加载后按 16:9 自适应面板高度
  let bgEl = null;
  const bgShade = document.createElement('div');
  bgShade.className = 'cjc-bgshade';
  panel.appendChild(bgShade);
  function applyBgMedia() {
    if (typeof GM_xmlhttpRequest !== 'function') return;
    GM_xmlhttpRequest({ method: 'GET', url: 'http://127.0.0.1:18766/assets/bg.mp4', timeout: 60000, responseType: 'blob',
      onload: (r) => {
        try {
          if (r.status !== 200 || !r.response) return;
          const isVideo = (r.response.type || '').startsWith('video');
          if (bgEl) bgEl.remove();
          bgEl = document.createElement(isVideo ? 'video' : 'img');
          bgEl.className = 'cjc-bg';
          if (isVideo) { bgEl.muted = true; bgEl.loop = true; bgEl.autoplay = true; bgEl.playsInline = true; }
          bgEl.src = URL.createObjectURL(r.response);
          panel.insertBefore(bgEl, bgShade);
          if (isVideo) {
            const tryPlay = () => bgEl.play().catch(() => {
              const kick = () => { bgEl.muted = true; bgEl.play().catch(() => {}); };
              document.addEventListener('pointerdown', kick, { once: true });
              document.addEventListener('keydown', kick, { once: true });
            });
            tryPlay();
            bgEl.addEventListener('loadedmetadata', () => { skinRatio = (bgEl.videoHeight / bgEl.videoWidth) || 0; applyPanelSize(); });
          } else {
            bgEl.addEventListener('load', () => { skinRatio = (bgEl.naturalHeight / bgEl.naturalWidth) || 0; applyPanelSize(); });
          }
        } catch (e) {}
      },
      onerror: () => {},
    });
  }
  applyBgMedia();
  const pHead = document.createElement('div');
  pHead.style.cssText = 'position:relative;z-index:1;background:linear-gradient(90deg,rgba(166,30,42,.55),rgba(90,50,110,.4));color:#f5e3d8;padding:5px 10px;font-size:13px;border-radius:6px 6px 0 0;cursor:move;user-select:none;display:flex;justify-content:space-between;align-items:center;text-shadow:0 1px 2px rgba(0,0,0,.6);';
  const pTitle = document.createElement('span');
  pTitle.textContent = '🦋 往生堂 · 雀魂教练 v1.18.0';
  const pBtn = document.createElement('span');
  pBtn.textContent = '—';
  pBtn.style.cssText = 'cursor:pointer;color:#8fa3c8;padding:0 6px;font-size:14px;';
  pHead.appendChild(pTitle);
  pHead.appendChild(pBtn);
  const pBody = document.createElement('div');
  pBody.style.cssText = 'position:relative;z-index:1;background:rgba(24,10,16,.38);color:#ffffff;text-shadow:0 1px 2px rgba(0,0,0,.8);font-size:12px;line-height:1.55;padding:6px 10px;border-radius:0 0 6px 6px;height:calc(100% - 29px);overflow-y:auto;white-space:pre-wrap;word-break:break-all;box-sizing:border-box;';
  panel.appendChild(pHead);
  panel.appendChild(pBody);
  const mountP = () => { (document.body || document.documentElement).appendChild(panel); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountP, { once: true });
  else mountP();
  function applyTilesMode() {
    pBody.classList.toggle('cjc-dark-tiles', !!pState.tileDark);
  }
  if (typeof GM_xmlhttpRequest === 'function') {
    GM_xmlhttpRequest({ method: 'GET', url: 'http://127.0.0.1:18766/config', timeout: 5000,
      onload: (r) => { try { const j = JSON.parse(r.responseText); pState.tileDark = !!j.tileDark; applyTilesMode(); saveP(); } catch (e) {} },
      onerror: () => {},
    });
  }
  const applyP = () => {
    panel.style.display = pState.hidden ? 'none' : '';
    applyPanelSize();
    if (pState.x !== null) { panel.style.left = pState.x + 'px'; panel.style.top = pState.y + 'px'; panel.style.right = 'auto'; }
    pBody.style.display = pState.collapsed ? 'none' : 'block';
    pBtn.textContent = pState.collapsed ? '▢' : '—';
    applyTilesMode();
  };
  applyP();
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'F9') return;
    e.preventDefault(); e.stopPropagation();
    pState.hidden = !pState.hidden;
    applyP(); saveP();
    try { badge.textContent = pState.hidden ? '面板已隐藏 (F9 显示)' : '面板已显示'; } catch (err) {}
  }, true);
  pBtn.addEventListener('click', () => { pState.collapsed = !pState.collapsed; applyP(); saveP(); });
  pHead.addEventListener('mousedown', (e) => {
    if (e.target === pBtn) return;
    const r = panel.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    const move = (ev) => {
      pState.x = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - ox));
      pState.y = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - oy));
      applyP();
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); saveP(); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    e.preventDefault();
  });
  const grip = document.createElement('div');
  grip.className = 'cjc-grip';
  grip.title = '拖动调整宽度';
  panel.appendChild(grip);
  grip.addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    const move = (ev) => {
      pState.w = Math.max(300, Math.min(window.innerWidth - 40, Math.round(startW + (startX - ev.clientX))));
      applyPanelSize();
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); saveP(); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  const spanOf = (text, bold, color) => {
    const s = document.createElement('span');
    s.textContent = text;
    if (bold) s.style.fontWeight = '700';
    if (color) s.style.color = color;
    return s;
  };
  // ---------- 麻将牌面渲染 ----------
  const style = document.createElement('style');
  style.textContent = `
  .cjc-tj{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;width:24px;height:32px;border-radius:4px;background:linear-gradient(160deg,#fffef8,#e7e3d4);box-shadow:0 1px 2px rgba(0,0,0,.45),inset 0 0 0 1px rgba(0,0,0,.08);margin:0 4px 0 2px;vertical-align:middle;flex:none}
  .cjc-tj b{font-size:14px;font-weight:700;line-height:1}
  .cjc-tj i{font-size:8px;font-style:normal;line-height:1;margin-top:1px;opacity:.8}
  .cjc-tj.hm{font-size:15px}
  .cjc-cm{color:#2456c4}.cjc-cp{color:#c43a3a}.cjc-cs{color:#1f8a4c}.cjc-cz{color:#3a3f4a}
  .cjc-aka b,.cjc-aka i{color:#d23b3b!important}
  .cjc-chip{display:inline-block;padding:2px 8px;border-radius:9px;font-size:11px;font-weight:700;margin:0 4px 0 2px;vertical-align:middle;flex:none}
  .cjc-chip.reach{background:rgba(255,150,50,.22);color:#ffb75e}
  .cjc-chip.skip{background:rgba(160,170,190,.18);color:#a9b4c9}
  .cjc-chip.hora{background:rgba(255,90,90,.22);color:#ff8a8a}
  .cjc-chip.call{background:rgba(90,150,255,.22);color:#8ab4ff}
  .cjc-chip.chi{background:rgba(90,210,140,.2);color:#7fe0a5}
  .cjc-pct{font-size:11px;color:#9fb3d1;margin-left:1px}
  .cjc-cand.first .cjc-pct{color:#ffd54a;font-weight:700;font-size:13px}
  .cjc-cand{display:inline-flex;align-items:center;white-space:nowrap;vertical-align:middle}
  .cjc-cand.first .cjc-tj{box-shadow:0 0 0 1.5px #ffd54a,0 1px 3px rgba(0,0,0,.5)}
  .cjc-t{width:27px;height:37px;margin:0 3px 0 1px;vertical-align:middle;flex:none;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.4));border-radius:6px;cursor:pointer}
  .cjc-tj{cursor:pointer}
  .cjc-hide-tiles .cjc-t,.cjc-hide-tiles .cjc-tj{filter:brightness(0) drop-shadow(0 1px 1.5px rgba(0,0,0,.4))!important}
  .cjc-hide-tiles .cjc-t.txt{color:transparent!important;background:#15161a}
  .cjc-t.txt{width:auto;height:auto;padding:1px 6px;background:rgba(255,255,255,.12);border-radius:4px;filter:none}
  .cjc-cand.first .cjc-t{box-shadow:0 0 0 1.5px #ffd54a,0 1px 3px rgba(0,0,0,.5)}
  .cjc-cand.first .cjc-t.txt{box-shadow:none}
  .cjc-chip.reach{background:rgba(155,111,224,.25);color:#cdb5f2}
  .cjc-chip.skip{background:rgba(180,160,170,.15);color:#b39aa4}
  .cjc-chip.hora{background:rgba(196,39,45,.3);color:#ff9099}
  .cjc-chip.call{background:rgba(245,215,142,.15);color:#f0d9a0}
  .cjc-chip.chi{background:rgba(110,200,140,.18);color:#8fe0a8}
  .cjc-pct{color:#c9a9b2}
  .cjc-cand.first .cjc-pct{color:#ffab5e;font-size:13px}
  .cjc-cand.first .cjc-t{box-shadow:0 0 0 1.5px #f5d78e,0 1px 3px rgba(0,0,0,.55)}
  .cjc-div{display:flex;align-items:center;gap:8px;margin:7px 0 3px;opacity:.9}
  .cjc-div i{flex:1;height:1px}
  .cjc-div i.l{background:linear-gradient(90deg,transparent,#a61e2a)}
  .cjc-div i.r{background:linear-gradient(270deg,transparent,#a61e2a)}
  .cjc-div em{font-style:normal;font-size:10px;color:#d9cff0;letter-spacing:3px;text-shadow:0 0 6px rgba(155,111,224,.8)}
  .cjc-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0}
  .cjc-bgshade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(22,10,16,.16),rgba(22,10,16,.02) 30%,rgba(22,10,16,.1));z-index:0}
  .cjc-grip{position:absolute;left:0;top:0;bottom:0;width:8px;cursor:ew-resize;z-index:2;background:linear-gradient(90deg,rgba(255,171,94,.4),rgba(255,171,94,0));opacity:0;transition:opacity .25s}
  .cjc-grip:hover{opacity:1}
  .cjc-dark-tiles .cjc-t,.cjc-dark-tiles .cjc-tj{filter:brightness(0) drop-shadow(0 1px 1.5px rgba(0,0,0,.4))!important}
  .cjc-dark-tiles .cjc-t.txt{color:transparent!important;background:#15161a!important}
  .cjc-dark-tiles .cjc-t.cjc-peek,.cjc-dark-tiles .cjc-tj.cjc-peek{filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.4))!important}
  .cjc-dark-tiles .cjc-t.txt.cjc-peek{color:#ecdce0!important;background:rgba(255,255,255,.12)!important}
  `;
  document.head.appendChild(style);

  // 天凤风格牌图精灵（WarL0ckNet/tile-art，经本地服务端提供，GM 通道绕开页面限制）
  window.__paiSpriteReady = false;
  const loadSprite = () => {
    if (typeof GM_xmlhttpRequest !== 'function') return;
    GM_xmlhttpRequest({
      method: 'GET',
      url: 'http://127.0.0.1:18766/assets/pai.svg',
      timeout: 8000,
      onload: (r) => {
        try {
          if (r.status !== 200 || !/<symbol/.test(r.responseText)) return;
          // 素材的牌底矩形无 fill（SVG 默认填黑），补上经典白底 + 细边
          let txt = r.responseText.replace(
            /(<symbol id="tile" viewBox="0 0 320 446">\s*<rect x="0" y="0" width="320" height="446" rx="30" ry="30")(\s*\/>)/,
            '$1 fill="#fbfaf3" stroke="#cfcaba" stroke-width="10"$2'
          );
          const holder = document.createElement('div');
          holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
          holder.innerHTML = txt;
          (document.body || document.documentElement).appendChild(holder);
          window.__paiSpriteReady = true;
        } catch (e) {}
      },
    });
  };
  loadSprite();

  // 候选 token → 精灵符号 id（服务端输出：数字牌直写、字牌汉字、红5 加"红"前缀）
  function tileSymbol(tok) {
    const aka = tok.startsWith('红');
    const core = aka ? tok.slice(1) : tok;
    if (/^[1-9][mps]$/.test(core)) return 'pai-' + core + (aka ? 'r' : '');
    if (/^[東南西北]$/.test(core)) return 'pai-' + { '東': 'e', '南': 's', '西': 'w', '北': 'n' }[core];
    if (core === '白') return 'pai-p';
    if (core === '發') return 'pai-f';
    if (core === '中') return 'pai-c';
    return null;
  }
  function tileNode(tok) {
    const id = tileSymbol(tok);
    if (id && window.__paiSpriteReady) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 320 446');
      svg.classList.add('cjc-t');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#' + id);
      svg.appendChild(use);
      return svg;
    }
    const aka = tok.startsWith('红');
    const core = aka ? tok.slice(1) : tok;
    if (id) {
      // 精灵未就绪时的 CSS 兜底牌面
      const suitChar = { m: '萬', p: '筒', s: '索' }[core[1]];
      const d = document.createElement('span');
      if (suitChar) {
        d.className = 'cjc-tj cjc-c' + core[1] + (aka ? ' cjc-aka' : '');
        const n = document.createElement('b'); n.textContent = core[0];
        const s = document.createElement('i'); s.textContent = suitChar;
        d.appendChild(n); d.appendChild(s);
      } else {
        d.className = 'cjc-tj cjc-cz cjc-hm';
        d.textContent = core;
      }
      return d;
    }
    // 非单牌 token（吃牌组合串等）→ 文本
    const s = document.createElement('span');
    s.className = 'cjc-t txt';
    s.textContent = tok;
    return s;
  }
  function chipNode(kind, label) {
    const c = { 立直: 'reach', 跳过: 'skip', 荣和: 'hora', 自摸: 'hora', 碰: 'call', 明杠: 'call', 暗杠: 'call', 加杠: 'call', 吃: 'chi' }[kind] || 'skip';
    const s = document.createElement('span');
    s.className = 'cjc-chip ' + c;
    s.textContent = label;
    return s;
  }
  const T_RE = /^(红5[mps]|[1-9][mps]|[東南西北白發中])$/;
  // 单个候选项："7s 85.56%" / "立直 9m 84.99%" / "跳过 99.87%" / "碰 5m 0.01%" / "吃 45m6m 2.10%"
  function candNode(text, first) {
    const wrap = document.createElement('span');
    wrap.className = 'cjc-cand' + (first ? ' first' : '');
    const m = /^(?:(\S+)\s+)?(?:(\S+)\s+)?(\d+(?:\.\d+)?)\s*%$/.exec(text.trim());
    if (!m) { wrap.textContent = text; return wrap; }
    const a = m[1] || '', b = m[2] || '', pct = m[3] + '%';
    if (a && !b) {
      if (/^(立直|跳过|荣和|自摸|流局)$/.test(a)) wrap.appendChild(chipNode(a, a));
      else wrap.appendChild(tileNode(a));
    } else if (a && b) {
      if (/^(碰|明杠|暗杠|加杠)$/.test(a)) { wrap.appendChild(chipNode(a, a)); wrap.appendChild(tileNode(b)); }
      else if (a === '吃') {
        wrap.appendChild(chipNode(a, a));
        const t = tileNode(b); t.style.width = 'auto'; t.style.padding = '0 5px'; t.style.fontSize = '11px';
        wrap.appendChild(t);
      } else {
        wrap.appendChild(chipNode(a, a));
        if (T_RE.test(b)) wrap.appendChild(tileNode(b));
      }
    }
    const p = document.createElement('span');
    p.className = 'cjc-pct'; p.textContent = pct;
    wrap.appendChild(p);
    return wrap;
  }
  let tilesHidden = false;
  pBody.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest || (!t.closest('.cjc-t') && !t.closest('.cjc-tj'))) return;
    if (pState.tileDark) return; // 默认黑牌模式下，点击交给按住查看逻辑
    e.preventDefault();
    tilesHidden = !tilesHidden;
    pBody.classList.toggle('cjc-hide-tiles', tilesHidden);
    try { badge.textContent = tilesHidden ? '牌面已隐藏（点击牌面恢复）' : '牌面已显示'; } catch (err) {}
  });
  pBody.addEventListener('mousedown', (e) => {
    if (!pState.tileDark) return;
    const t = e.target && e.target.closest ? e.target.closest('.cjc-t, .cjc-tj') : null;
    if (t) t.classList.add('cjc-peek');
  });
  document.addEventListener('mouseup', () => {
    document.querySelectorAll('.cjc-peek').forEach(el => el.classList.remove('cjc-peek'));
  });
  const emoURLs = [null, null, null, null]; // tier 1-4 的表情图 blob URL
  function preloadEmo() {
    if (typeof GM_xmlhttpRequest !== 'function') return;
    for (let i = 1; i <= 4; i++) {
      GM_xmlhttpRequest({ method: 'GET', url: 'http://127.0.0.1:18766/assets/emo/emo_t' + i + '.jpg', timeout: 15000, responseType: 'blob',
        onload: (r) => { try { if (r.status === 200) emoURLs[i - 1] = URL.createObjectURL(r.response); } catch (e) {} },
        onerror: () => {},
      });
    }
  }
  preloadEmo();
  const MARK_COLORS = ['#f5d78e', '#8fe0a8', '#a89aa2', '#ff6b7d'];
  const MARK_TIPS = ['完美 — 与 Mortal 首选一致', '不错 — Mortal 第 2 选择', '一般 — Mortal 第 3 选择', '失误 — 不在 Mortal 推荐之列'];
  function markNode(tier) {
    const c = MARK_COLORS[tier - 1] || MARK_COLORS[3];
    const wrap = document.createElement('span');
    wrap.style.cssText = 'flex:0 0 30px;display:inline-flex;align-items:center;justify-content:center;';
    wrap.title = MARK_TIPS[tier - 1] || MARK_TIPS[3];
    if (emoURLs[tier - 1]) {
      const img = document.createElement('img');
      img.src = emoURLs[tier - 1];
      img.style.cssText = 'width:36px;height:36px;object-fit:cover;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.5);';
      wrap.appendChild(img);
      return wrap;
    }
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '17'); svg.setAttribute('height', '17');
    const ring = document.createElementNS(NS, 'circle');
    ring.setAttribute('cx', '12'); ring.setAttribute('cy', '12'); ring.setAttribute('r', '10');
    ring.setAttribute('fill', 'rgba(0,0,0,.35)'); ring.setAttribute('stroke', c); ring.setAttribute('stroke-width', '2');
    svg.appendChild(ring);
    const st = (d) => { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); p.setAttribute('fill', 'none'); p.setAttribute('stroke', c); p.setAttribute('stroke-width', '1.8'); p.setAttribute('stroke-linecap', 'round'); svg.appendChild(p); };
    const dot = (x, y) => { const o = document.createElementNS(NS, 'circle'); o.setAttribute('cx', x); o.setAttribute('cy', y); o.setAttribute('r', '1.4'); o.setAttribute('fill', c); svg.appendChild(o); };
    if (tier === 1) { // 大笑脸：^^ 眼 + 大弧笑
      st('M6.5 10 L8.5 8 L10.5 10'); st('M13.5 10 L15.5 8 L17.5 10');
      st('M7.5 14 Q12 18.5 16.5 14');
    } else if (tier === 2) { // 微笑脸
      dot(8.5, 9); dot(15.5, 9); st('M8 14 Q12 17 16 14');
    } else if (tier === 3) { // 平淡脸
      dot(8.5, 9); dot(15.5, 9); st('M8.5 14.5 L15.5 14.5');
    } else { // 哭脸：XX 眼 + 皱眉 + 泪滴
      st('M7 8 L10 11'); st('M10 8 L7 11'); st('M14 8 L17 11'); st('M17 8 L14 11');
      st('M8 16 Q12 13 16 16');
      const tear = document.createElementNS(NS, 'path');
      tear.setAttribute('d', 'M17.5 12.5 Q18.6 14.2 17.5 15 Q16.4 14.2 17.5 12.5');
      tear.setAttribute('fill', c); tear.setAttribute('opacity', '.8');
      svg.appendChild(tear);
    }
    wrap.appendChild(svg);
    return wrap;
  }
  const fmtLine = (t) => {
    const div = document.createElement('div');
    // 建议行：候选渲染成牌面，首选项金色高亮
    if (/^[^：]*?(?:推荐：|我可：)/.test(t)) return adviceNode(t);
    // 其余行：纯文字着色（表情由组右栏负责）
    div.textContent = t;
    if (/^  (?:→ )?你切了/.test(t)) div.style.color = '#a5828c';
    else if (/^【/.test(t)) { div.style.color = '#f5d78e'; div.style.fontWeight = '600'; }
    else if (/^  座位|^>/.test(t)) div.style.color = '#c4a3ad';
    else div.style.color = '#ecdce0';
    return div;
  };
  let since = 0, pollBusy = false;
  let openGroup = null; // 当前未闭合的输出组 { div, center, markSlot }
  function newGroup() {
    const g = document.createElement('div');
    g.style.cssText = 'display:flex;align-items:center;gap:4px;';
    const slotL = document.createElement('span');
    slotL.style.cssText = 'flex:0 0 36px;display:inline-flex;'; // 左预留位
    const center = document.createElement('div');
    center.style.cssText = 'flex:1;min-width:0;';
    const markSlot = document.createElement('span');
    markSlot.style.cssText = 'flex:0 0 44px;display:inline-flex;align-items:center;justify-content:center;';
    g.appendChild(slotL); g.appendChild(center); g.appendChild(markSlot);
    return { div: g, center, markSlot };
  }
  function groupCenter() {
    if (!openGroup) {
      openGroup = newGroup();
      pBody.appendChild(openGroup.div);
    }
    return openGroup.center;
  }
  function setGroupMark(tier) {
    if (!openGroup) return;
    openGroup.markSlot.innerHTML = '';
    openGroup.markSlot.appendChild(markNode(tier));
  }
  function clearGroupMark() {
    if (!openGroup) return;
    openGroup.markSlot.innerHTML = '';
  }
  const adviceNode = (t) => {
    const div = document.createElement('div');
    const am = /^([^：]*?(?:推荐：|我可：))([\s\S]+)$/.exec(t);
    if (!am) { div.textContent = t; return div; }
    div.appendChild(spanOf(am[1], false, '#c9909c'));
    const parts = am[2].split(' ｜ ');
    parts.forEach((p, i) => {
      if (i) div.appendChild(spanOf(' ｜ ', false, '#8a6a75'));
      div.appendChild(candNode(p, i === 0));
    });
    return div;
  };
  const renderP = (data) => {
    if (!data || !Array.isArray(data.items) || !data.items.length) return;
    for (const it of data.items) {
      const t = it.text;
      const isAdv = /^[^：]*?(?:推荐：|我可：)/.test(t);
      const isFb = /^  (?:→ )?你切了/.test(t);
      if (isAdv) {
        // 新组开始：蝶引分界 + 组容器
        if (pBody.childNodes.length) {
          const dv = document.createElement('div');
          dv.className = 'cjc-div';
          dv.innerHTML = '<i class="l"></i><em>🦋 蝶引</em><i class="r"></i>';
          pBody.appendChild(dv);
        }
        openGroup = newGroup();
        clearGroupMark();
        pBody.appendChild(openGroup.div);
        openGroup.center.appendChild(fmtLine(t));
      } else if (isFb) {
        // 反馈行进当前组，并点亮组右栏的表情
        if (openGroup) {
          openGroup.center.appendChild(fmtLine(t));
          const fm = /第 (\d) 名/.exec(t);
          setGroupMark(fm ? +fm[1] : 4);
        } else {
          pBody.appendChild(fmtLine(t));
        }
      } else {
        (openGroup ? groupCenter() : pBody).appendChild(fmtLine(t));
      }
    }
    while (pBody.childNodes.length > 30) pBody.removeChild(pBody.firstChild);
    since = data.next;
    pBody.scrollTop = pBody.scrollHeight;
  };
  const pollP = () => {
    if (pollBusy) return;
    pollBusy = true;
    const done = () => { pollBusy = false; };
    if (typeof GM_xmlhttpRequest === "function") {
      GM_xmlhttpRequest({
        method: 'GET',
        url: 'http://127.0.0.1:18766/panel?since=' + since,
        timeout: 5000,
        onload: (r) => { try { renderP(JSON.parse(r.responseText)); } catch (e) {} done(); },
        onerror: done,
        ontimeout: done,
      });
    } else {
      fetch('http://127.0.0.1:18766/panel?since=' + since)
        .then(r => r.json())
        .then(renderP)
        .catch(done);
    }
  };
  setInterval(pollP, 1500);
})();
