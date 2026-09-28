/* ═══ lab-kline v4.8: 全市场K线库（仓库分片 + IndexedDB 缓存 + 任意A股蜡烛图）═══ */
(function () {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  // ── IndexedDB（分片当日缓存；file:// 等无 IDB 环境自动降级直连）──
  let _dbP = null;
  function idb() {
    if (_dbP) return _dbP;
    _dbP = new Promise(resolve => {
      try {
        if (!window.indexedDB) return resolve(null);
        const rq = indexedDB.open('asent-kline', 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore('shards', { keyPath: 'c' });
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    return _dbP;
  }
  function idbGet(code) {
    return idb().then(db => new Promise((resolve, reject) => {
      if (!db) return reject(new Error('no idb'));
      const rq = db.transaction('shards').objectStore('shards').get(code);
      rq.onsuccess = () => resolve(rq.result || null); rq.onerror = () => reject(rq.error);
    }));
  }
  function idbPut(val) {
    return idb().then(db => new Promise((resolve, reject) => {
      if (!db) return reject(new Error('no idb'));
      const rq = db.transaction('shards', 'readwrite').objectStore('shards').put(val);
      rq.onsuccess = resolve; rq.onerror = () => reject(rq.error);
    }));
  }

  // ── 清单懒加载（localStorage 当日缓存；file:// 拉取失败静默降级）──
  let _list = null, _listP = null;
  function getList() {
    if (_list) return Promise.resolve(_list);
    if (_listP) return _listP;
    _listP = (async () => {
      if (location.protocol === 'file:') { _list = { codes: [], offline: true, day: todayStr() }; _s6Touch('fail'); return _list; } // file:// 下 fetch 必被 CORS 拦截，直接降级不产生噪音
      try {
        const cached = JSON.parse(localStorage.getItem('asent.v48.klist') || 'null');
        if (cached && cached.day === todayStr() && cached.codes && cached.codes.length) { _list = cached; _s6Touch('ok'); return _list; }
      } catch (e) {}
      try {
        const res = await fetch('kline/_list.json');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        _list = { codes: j.codes || [], generatedAt: j.generatedAt || '', day: todayStr() };
        try { localStorage.setItem('asent.v48.klist', JSON.stringify(_list)); } catch (e) {}
        _s6Touch('ok');
      } catch (e) {
        _list = { codes: [], offline: true, day: todayStr() };
        _s6Touch('fail');
      }
      return _list;
    })();
    return _listP;
  }

  // ── 分片获取（IndexedDB 当日缓存 → Pages 静态分片）──
  async function getShard(code) {
    if (location.protocol === 'file:') throw new Error('本地 file:// 环境不支持K线拉取（线上可用）');
    try { const v = await idbGet(code); if (v && v.day === todayStr() && v.bars && v.bars.length) return v; } catch (e) {}
    const res = await fetch('kline/' + code + '.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (!j || !Array.isArray(j.bars) || !j.bars.length) throw new Error('空分片');
    const val = { c: j.c || code, n: j.n || '', bars: j.bars, day: todayStr() };
    try { await idbPut(val); } catch (e) {}
    return val;
  }

  // ── 蜡烛图 SVG（红涨绿跌 · MA5/MA10 · 量带 · 右侧价轴）──
  function candleSVG(bars, n) {
    const pts = bars.slice(-n);
    if (pts.length < 3) return '<div class="dim" style="padding:30px;text-align:center">数据不足</div>';
    const W = 800, H = 360, L = 10, R = W - 70;
    const PA = { t: 14, b: 250 }, VA = { t: 266, b: 336 };
    const highs = pts.map(p => p[3]), lows = pts.map(p => p[4]);
    let mn = Math.min.apply(null, lows), mx = Math.max.apply(null, highs);
    const pad = (mx - mn) * 0.05 || mx * 0.01; mn -= pad; mx += pad;
    const stepX = (R - L) / pts.length, cw = Math.max(stepX * 0.62, 1.5);
    const y = v => PA.t + (mx - v) / (mx - mn) * (PA.b - PA.t);
    const ma = k => pts.map((_, i) => { if (i < k - 1) return null; let s = 0; for (let j = i - k + 1; j <= i; j++) s += pts[j][2]; return s / k; });
    const ma5 = ma(5), ma10 = ma(10);
    const maPath = arr => { let d = '', started = false; arr.forEach((v, i) => { if (v == null) return; d += (started ? 'L' : 'M') + (L + stepX * (i + 0.5)).toFixed(1) + ',' + y(v).toFixed(1); started = true; }); return d; };
    let grid = '';
    for (let g = 0; g <= 4; g++) {
      const yy = PA.t + (PA.b - PA.t) * g / 4;
      grid += `<line x1="${L}" y1="${yy}" x2="${R}" y2="${yy}" stroke="#1c2434" stroke-width="1"/><text x="${R + 6}" y="${yy + 4}" fill="#5a6a80" font-size="10">${(mx - (mx - mn) * g / 4).toFixed(2)}</text>`;
    }
    for (let g = 0; g <= 2; g++) { const yy = VA.t + (VA.b - VA.t) * g / 2; grid += `<line x1="${L}" y1="${yy}" x2="${R}" y2="${yy}" stroke="#1c2434" stroke-width="1"/>`; }
    let candles = '', vols = '', labels = '';
    const vmax = Math.max.apply(null, pts.map(p => p[5])) || 1;
    const lblEvery = Math.ceil(pts.length / 6);
    pts.forEach((b, i) => {
      const cx = L + stepX * (i + 0.5), up = b[2] >= b[1], col = up ? '#ff5a5a' : '#2fbf8f';
      const yO = y(b[1]), yC = y(b[2]), top = Math.min(yO, yC), hgt = Math.max(Math.abs(yC - yO), 1);
      candles += `<line x1="${cx.toFixed(1)}" y1="${y(b[3]).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(b[4]).toFixed(1)}" stroke="${col}" stroke-width="1"/><rect x="${(cx - cw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${cw.toFixed(1)}" height="${hgt.toFixed(1)}" fill="${up ? '#12151d' : col}" stroke="${col}" stroke-width="1"/>`;
      const vh = (b[5] / vmax) * (VA.b - VA.t);
      vols += `<rect x="${(cx - cw / 2).toFixed(1)}" y="${(VA.b - vh).toFixed(1)}" width="${cw.toFixed(1)}" height="${vh.toFixed(1)}" fill="${col}" opacity="0.55"/>`;
      if (i % lblEvery === 0) labels += `<text x="${cx.toFixed(0)}" y="${H - 4}" fill="#5a6a80" font-size="10" text-anchor="middle">${b[0].slice(5)}</text>`;
    });
    const last = pts[pts.length - 1];
    return `<svg class="km-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      ${grid}${candles}${vols}
      <path d="${maPath(ma5)}" fill="none" stroke="#c9a04e" stroke-width="1.2"/>
      <path d="${maPath(ma10)}" fill="none" stroke="#7aa2f7" stroke-width="1.2"/>
      <text x="${R + 6}" y="${(y(last[2]) + 4).toFixed(1)}" fill="#e8edf5" font-size="11" font-weight="700">${last[2].toFixed(2)}</text>
      ${labels}
      <text x="${L}" y="${VA.t - 6}" fill="#5a6a80" font-size="10">成交量</text>
      <text x="${L + 64}" y="12" fill="#c9a04e" font-size="10">MA5</text><text x="${L + 100}" y="12" fill="#7aa2f7" font-size="10">MA10</text>
    </svg>`;
  }

  // ── 任意A股K线弹窗 ──
  window._openKline = async function (code, nameHint) {
    let mask = document.getElementById('kmodal-mask');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'kmodal-mask';
      mask.innerHTML = '<div id="kmodal"></div>';
      document.body.appendChild(mask);
      mask.addEventListener('click', e => { if (e.target === mask) mask.classList.remove('on'); });
    }
    const box = mask.querySelector('#kmodal');
    const show = html => { box.innerHTML = html; mask.classList.add('on'); };
    const closeBtn = `onclick="document.getElementById('kmodal-mask').classList.remove('on')"`;
    show(`<div class="km-head"><b>${esc(nameHint || code)}</b><span class="c num">${esc(code)}</span><div class="km-rng" style="margin-left:auto"></div><span class="km-close" ${closeBtn}>✕</span></div><div class="dim" style="padding:36px 0;text-align:center">拉取K线分片…</div>`);
    try {
      const v = await getShard(code);
      const name = nameHint || v.n || '';
      let cur = 60;
      const render = () => {
        const bars = v.bars, last = bars[bars.length - 1], prev = bars.length > 1 ? bars[bars.length - 2] : null;
        const chg = prev ? (last[2] / prev[2] - 1) * 100 : null;
        show(`<div class="km-head"><b>${esc(name || code)}</b><span class="c num">${esc(code)}</span>
          <span style="font-size:17px;font-weight:700">${last[2].toFixed(2)}</span>
          ${chg != null ? `<span style="color:${chg >= 0 ? '#ff5a5a' : '#2fbf8f'};font-weight:700">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>` : ''}
          <div class="km-rng" style="margin-left:auto">${[60, 120, 250].map(r => `<button class="${r === cur ? 'on' : ''}" data-r="${r}">${r}日</button>`).join('')}</div>
          <span class="km-close" ${closeBtn}>✕</span></div>
          ${candleSVG(bars, cur)}
          <div class="km-meta"><span>📅 ${bars.length} 根 · ${bars[0][0]} ~ ${last[0]}</span><span>💾 IndexedDB 当日缓存</span><span>腾讯前复权日K · 仓库分片</span></div>`);
        box.querySelectorAll('.km-rng button').forEach(b => { b.onclick = () => { cur = +b.dataset.r; render(); }; });
      };
      render();
    } catch (e) {
      show(`<div class="km-head"><b>${esc(nameHint || code)}</b><span class="km-close" ${closeBtn}>✕</span></div><div class="dim" style="padding:36px 0;text-align:center">K线分片不可达（${esc(e.message)}）——离线模式或该代码无数据</div>`);
    }
  };

  // ── 搜索扩展接口（全局搜索调用）──
  window.__klineSearch = async function (q) {
    const l = await getList();
    if (!l.codes.length) return [];
    const out = [];
    for (const it of l.codes) {
      if (it.c.indexOf(q) >= 0 || it.n.toLowerCase().indexOf(q) >= 0) { out.push(it); if (out.length >= 10) break; }
    }
    return out;
  };

  // ── 对内扩展接口（v4.8.8: S8 统计研判 / S6 健康面板按需取用分片库）──
  // __klineShard(code) → Promise<{c,n,bars,day}>，bars=[[日期,开,收,高,低,量],...]，收盘价取 b[2]（file:// 下 reject）
  // __klineList() → Promise<{codes:[{c,n}],generatedAt,day,offline?}>（file:// 下返回 offline 空清单）
  window.__klineShard = getShard;
  window.__klineList = getList;

  // ── S6 健康面板异步状态行（清单就绪后插入）──
  function _s6Touch(st) {
    const el = document.getElementById('s6-list');
    if (!el || el.dataset.klineRow) return;
    el.dataset.klineRow = '1';
    const div = document.createElement('div');
    div.className = 'hl-row';
    div.innerHTML = `<div style="min-width:0"><div style="font-size:13px;font-weight:700;color:#c6cfdd">全市场K线库 <span class="dim" style="font-weight:400;font-size:11px">v4.8 · 仓库分片 + IndexedDB 当日缓存</span></div><div style="font-size:12px;color:var(--dim);margin-top:2px;line-height:1.6">${_list.codes.length} 只沪深A股 · 每股 ≤640 日K（前复权）· 清单 ${_list.generatedAt || '—'} · 全档数据留存 git 仓库</div></div><span class="hl-st ${st === 'ok' ? 'hl-ok' : 'hl-warn'}">${st === 'ok' ? '✓ 就绪' : '⚠ 不可达'}</span>`;
    el.insertBefore(div, el.firstChild);
  }

  getList();
})();
