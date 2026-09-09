// 页面注入器 v2：WebSocket 双向帧捕获 → 本地中继
// - 出帧：原型 send 钩子（对已存在与新建连接都生效）
// - 入帧：onmessage 改为"包装后回写原生槽位"（不影响游戏自身消息分发）
//         + addEventListener('message') 包装兜底
// 用法（由 ZCode 通过浏览器 evaluate 注入，幂等）
module.exports = `(() => {
  if (window.__liveHook) return 'already';
  window.__liveHook = { frames: 0, errors: 0, posted: 0 };
  const RELAY = 'http://127.0.0.1:18766/frame';
  const toHex = (u8) => {
    let h = '';
    const n = Math.min(u8.length, 8192);
    for (let i = 0; i < n; i++) h += u8[i].toString(16).padStart(2, '0');
    return h;
  };
  const post = (payload) => {
    window.__liveHook.posted++;
    try { fetch(RELAY, { method: 'POST', body: JSON.stringify(payload) }).catch(() => { window.__liveHook.errors++; }); } catch (e) { window.__liveHook.errors++; }
  };
  const tee = (dir) => function(data) {
    try {
      const b = data instanceof ArrayBuffer ? new Uint8Array(data) : (data instanceof Uint8Array ? data : null);
      if (b && b.length >= 4) { window.__liveHook.frames++; post({ dir, url: String(this.url || ''), hex: toHex(b) }); }
    } catch (e) { window.__liveHook.errors++; }
  };

  // 1) 出帧
  const oSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data) {
    try { tee('out').call(this, data); } catch (e) {}
    return oSend.call(this, data);
  };

  // 2) 入帧：包装 onmessage（保留原生槽位语义，避免破坏游戏分发）
  const omDesc = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
  if (omDesc && omDesc.set) {
    const nativeGet = omDesc.get, nativeSet = omDesc.set;
    Object.defineProperty(WebSocket.prototype, 'onmessage', {
      configurable: true,
      get() { return nativeGet.call(this); },
      set(fn) {
        if (typeof fn === 'function') {
          const teeFn = tee('in');
          const wrapped = function(ev) { try { teeFn.call(this, ev.data); } catch (e) {} return fn.call(this, ev); };
          nativeSet.call(this, wrapped);
        } else {
          nativeSet.call(this, fn);
        }
      },
    });
  }

  // 3) 入帧兜底：addEventListener('message')
  const oAdd = WebSocket.prototype.addEventListener;
  WebSocket.prototype.addEventListener = function(type, fn, opts) {
    if (type === 'message' && typeof fn === 'function' && !fn.__liveTeed) {
      const teeFn = tee('in');
      const wrapped = function(ev) { try { teeFn.call(this, ev.data); } catch (e) {} return fn.call(this, ev); };
      wrapped.__liveTeed = true;
      return oAdd.call(this, type, wrapped, opts);
    }
    return oAdd.call(this, type, fn, opts);
  };
  return 'live-hook-installed';
})()`;
