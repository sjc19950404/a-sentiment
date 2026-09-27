/* ═══════════ 实时条（JSONP 轮询 · file:// 可用 · 零代理 · 多源容错）═══════════
   主力源（稳定）: 腾讯指数 qt.gtimg.cn + 腾讯市场状态 marketStat + 东财涨停池 push2ex(带date)
   增强源（容错）: 东财涨跌家数 push2（多候选轮换，失败自动隐藏该段，不影响主体） */
(function () {
  const bar = $id('rt-bar');
  if (!bar) return;
  let seq = 0, timer = null, statOpen = null; // statOpen: true=开市 false=休市 null=未知
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── 跨域加载（file:// 下唯一可靠方案）──
  // 模式 A: 回调式 JSONP（东财: 返回 cb({...})）
  function jsonp(url, cbParam) {
    return new Promise((resolve, reject) => {
      const name = '_asentRtCb' + (++seq);
      const s = document.createElement('script');
      const done = fn => { try { fn(); } catch (e) {} try { delete window[name]; } catch (e) { window[name] = undefined; } s.remove(); clearTimeout(tmo); };
      const tmo = setTimeout(() => done(() => reject(new Error('timeout'))), 9000);
      window[name] = data => done(() => resolve(data));
      s.onerror = () => done(() => reject(new Error('network')));
      s.referrerPolicy = 'no-referrer';
      s.src = url + (url.includes('?') ? '&' : '?') + cbParam + '=' + name + '&_=' + Date.now();
      document.head.appendChild(s);
    });
  }
  // 模式 B: 变量捕获式（腾讯 qt.gtimg.cn: 忽略 callback 参数, 返回 var v_xxx="..." 裸赋值）
  function jsonpVar(url, varNames) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      const done = fn => { try { fn(); } catch (e) {} s.remove(); clearTimeout(tmo); };
      const tmo = setTimeout(() => done(() => reject(new Error('timeout'))), 9000);
      s.onload = () => done(() => {
        const out = {};
        varNames.forEach(n => { try { out[n] = window[n]; } catch (e) {} });
        resolve(out);
      });
      s.onerror = () => done(() => reject(new Error('network')));
      s.referrerPolicy = 'no-referrer';
      s.src = url + (url.includes('?') ? '&' : '?') + '_=' + Date.now();
      document.head.appendChild(s);
    });
  }

  // ── 数据源 ──
  async function fetchIdx() {
    const res = await jsonpVar('https://qt.gtimg.cn/q=sh000001,sz399001,sz399006', ['v_sh000001', 'v_sz399001', 'v_sz399006']);
    const out = {};
    Object.values(res).forEach(raw => {
      const f = String(raw || '').split('~');
      if (f.length > 32 && f[3]) out[f[2]] = { name: f[1], px: +f[3], chg: +f[31], pct: +f[32], time: f[30] };
    });
    if (!Object.keys(out).length) throw new Error('idx parse fail');
    return out;
  }
  async function fetchStat() {
    try {
      const res = await jsonpVar('https://qt.gtimg.cn/q=marketStat', ['v_marketStat']);
      const m = String(res.v_marketStat || '').match(/^([^|]*)\|/);
      if (!m) return null;
      const parts = String(res.v_marketStat).split('|');
      const sh = parts.find(p => p.indexOf('SH_') === 0) || '';
      const seg = sh.split('_');
      return { status: seg[1], reason: seg[2] || '', time: parts[0] || '' };
    } catch (e) { return null; }
  }
  async function fetchBreadth() {
    const candidates = [
      'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000001&fields=f104,f105,f106',
      'https://push2.eastmoney.com/api/qt/stock/get?secid=1.000001&fields=f104,f105,f106'
    ];
    for (const u of candidates) {
      try {
        const d = await jsonp(u, 'cb');
        let dd = (d && d.data) || null;
        if (dd && dd.diff) dd = Array.isArray(dd.diff) ? dd.diff[0] : dd.diff;
        if (dd && dd.f104 != null && (dd.f104 + dd.f105) > 0) return { up: dd.f104, down: dd.f105 };
      } catch (e) { /* 换下一个候选 */ }
    }
    return null;
  }
  async function fetchZTPool() {
    const dt = CUR.trade_date.replace(/-/g, '');
    try {
      const d = await jsonp('https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=5&sort=fbt%3Aasc&date=' + dt, 'cb');
      if (!d || !d.data || !d.data.pool) return null;
      const pool = d.data.pool || [];
      const qd = String(d.data.qdate || '');
      return { count: d.data.tc != null ? d.data.tc : pool.length, date: qd.length === 8 ? qd.slice(4, 6) + '-' + qd.slice(6) : '', top: pool.slice(0, 3).map(p => p.n) };
    } catch (e) { return null; }
  }

  // ── 交易时段（本地规则兜底；marketStat 优先）──
  function localSession() {
    const n = new Date(), day = n.getDay();
    if (day === 0 || day === 6) return false;
    const hm = n.getHours() * 100 + n.getMinutes();
    return (hm >= 915 && hm <= 1135) || (hm >= 1255 && hm <= 1505);
  }
  const isOpen = () => statOpen === true || (statOpen == null && localSession());

  function fmtIdx(o) {
    if (!o) return '<span class="dim">—</span>';
    const c = o.pct > 0 ? 'up' : o.pct < 0 ? 'down' : '';
    return `<b class="num">${o.px.toFixed(2)}</b> <span class="num ${c}" style="font-weight:700">${o.pct > 0 ? '+' : ''}${o.pct.toFixed(2)}%</span>`;
  }

  // 分通道渲染: 各数据源独立补充，互不阻塞（谁先到谁先显示）
  const state = { idx: null, stat: null, breadth: null, zt: null };
  const setMsg = t => { const s = bar.querySelector('#rt-status'); if (s) s.innerHTML = t; };

  function renderAll() {
    const { idx, stat, breadth, zt } = state;
    if (!idx) return; // 主通道未到，保持「连接中」
    const segs = [];
    if (stat && stat.status !== 'open') segs.push(`<span class="gold" style="font-weight:700">🏮 ${esc(stat.reason) || '休市'}</span>`);
    segs.push(`<span>上证 ${fmtIdx(idx['000001'])}</span>`, `<span>深成 ${fmtIdx(idx['399001'])}</span>`, `<span>创业板 ${fmtIdx(idx['399006'])}</span>`);
    if (breadth) segs.push(`<span>涨/跌 <span class="up num">${breadth.up}</span>/<span class="down num">${breadth.down}</span></span>`);
    if (zt) segs.push(`<span>涨停 <b class="up num">${zt.count}</b><span class="dim" style="font-size:10.5px">（${esc(zt.date)}）</span></span>` +
      (zt.top && zt.top.length ? `<span class="dim" style="font-size:11px">前排: ${zt.top.map(esc).join('·')}</span>` : ''));
    const dataEl = bar.querySelector('#rt-data');
    if (dataEl) dataEl.innerHTML = segs.join('');
    const open = isOpen();
    setMsg(`<span class="${open ? 'up' : 'dim'}">● ${open ? '实时' : esc(stat && stat.reason ? stat.reason : '盘外快照')}</span> · <span class="num dim" style="font-size:11px">${timeStr()}</span>`);
  }
  function timeStr() {
    const t = (state.idx && (state.idx['000001'] || {}).time) || '';
    return t.length >= 14 ? t.replace(/^(\d{8})(\d{2})(\d{2})(\d{2}).*/, (m, d, h, mi, se) => d.slice(4, 6) + '-' + d.slice(6) + ' ' + h + ':' + mi + ':' + se) : new Date().toTimeString().slice(0, 8);
  }

  function refresh() {
    // 分通道 fire-and-forget: 各源独立渲染先到先显示；并发无害（渲染幂等）
    fetchIdx().then(d => { state.idx = d; renderAll(); }).catch(() => {
      if (!state.idx) setMsg('<span class="down">实时接口不可达</span> · <span class="dim">稍后自动重试</span>');
    });
    fetchStat().then(d => { state.stat = d; if (d) statOpen = d.status === 'open'; renderAll(); }).catch(() => {});
    fetchBreadth().then(d => { state.breadth = d; renderAll(); }).catch(() => {});
    fetchZTPool().then(d => { state.zt = d; renderAll(); }).catch(() => {});
  }

  function startStop() {
    if (isOpen()) {
      if (!timer) { timer = setInterval(() => { if (!document.hidden) refresh(); }, 30000); }
    } else if (timer) { clearInterval(timer); timer = null; }
  }

  $id('rt-refresh').onclick = () => { refresh(); LAB.toast('正在拉取实时快照…'); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); startStop(); } });

  refresh();
  startStop();
  setInterval(startStop, 60000); // 每分钟检查开闭市状态，跨开盘/收盘边界自动启停

  /* ── v4.4 前端实时增强: 全市场快照 → 量能拆分 + 行业/题材内部涨跌比 ──
     push2 clist JSONP 分页; 盘后/休市返回最近收盘快照与存档日一致;
     全链路静默容错: 失败保持占位符, 不影响主体（与上方增强源同模式） */
  async function fetchMkt() {
    let all = [], total = null;
    for (let pn = 1; pn <= 3; pn++) {
      const d = await jsonp('https://push2.eastmoney.com/api/qt/clist/get?pn=' + pn + '&pz=2000&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f3,f6,f100', 'cb');
      if (!d || !d.data || !Array.isArray(d.data.diff)) break;
      if (total == null) total = d.data.total;
      all = all.concat(d.data.diff);
      if (all.length >= total) break;
    }
    if (all.length < 3000) throw new Error('mkt snapshot incomplete: ' + all.length);
    let up = 0, down = 0, upAmt = 0, downAmt = 0;
    const ind = new Map();
    for (const d of all) {
      const chg = typeof d.f3 === 'number' ? d.f3 : null;
      const amt = typeof d.f6 === 'number' ? d.f6 : 0;
      if (chg == null) continue;
      if (chg > 0) { up++; upAmt += amt; } else if (chg < 0) { down++; downAmt += amt; }
      if (d.f100) { const o = ind.get(d.f100) || { u: 0, t: 0 }; o.t++; if (chg > 0) o.u++; ind.set(d.f100, o); }
    }
    return { up, down, upAmt, downAmt, ind, at: Date.now() };
  }
  // 题材内部涨跌比: 东财概念板块列表 → 名称双向匹配 → 逐板块拉成员涨跌（串行+间隔防限流）
  async function fillTopics() {
    const tds = [...document.querySelectorAll('td.v44bd[data-topic]')];
    if (!tds.length) return;
    const cl = await jsonp('https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=500&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f14', 'cb');
    const list = cl && cl.data && Array.isArray(cl.data.diff) ? cl.data.diff : [];
    for (const td of tds) {
      const tag = td.getAttribute('data-topic') || '';
      const bk = list.find(b => b.f14 && (b.f14.includes(tag) || tag.includes(String(b.f14).replace(/概念$/, ''))));
      if (!bk) continue;
      try {
        const md = await jsonp('https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=500&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b:' + bk.f12 + '&fields=f3', 'cb');
        const mem = md && md.data && Array.isArray(md.data.diff) ? md.data.diff : [];
        const tot = mem.filter(m => typeof m.f3 === 'number').length;
        const ups = mem.filter(m => typeof m.f3 === 'number' && m.f3 > 0).length;
        if (tot >= 5) {
          const ratio = Math.round(ups / tot * 100);
          td.innerHTML = '<span style="color:' + (ratio >= 60 ? '#ff8a8a' : ratio < 40 ? '#6ea86e' : '#c6cfdd') + '">' + ratio + '%</span>' + (ratio < 40 ? '<span class="dim" style="font-size:10px"> 独涨</span>' : '');
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 150));
    }
  }
  function fillV44(m) {
    const yi = v => (v / 1e8).toFixed(0);
    const amtSub = document.querySelector('#kpi-amt .sub');
    if (amtSub) amtSub.innerHTML += ' · 上涨 ¥' + yi(m.upAmt) + '亿 / 下跌 ¥' + yi(m.downAmt) + '亿' + (m.downAmt > m.upAmt * 1.5 ? ' · <b style="color:#6ea86e">放量杀跌</b>' : '');
    const indSub = document.querySelector('#kpi-ind .sub');
    if (indSub && m.ind.size) {
      const rows = [...m.ind.entries()].map(([n, v]) => ({ n, r: v.u / v.t })).filter(x => x.r >= 0).sort((a, b) => b.r - a.r);
      if (rows.length) indSub.innerHTML += ' · 内部涨跌比 最强 ' + esc(rows[0].n) + ' ' + Math.round(rows[0].r * 100) + '% / 最弱 ' + esc(rows[rows.length - 1].n) + ' ' + Math.round(rows[rows.length - 1].r * 100) + '%';
    }
  }
  setTimeout(() => {
    fetchMkt().then(m => { window.__v44mkt = m; fillV44(m); fillTopics().catch(() => {}); }).catch(() => {});
  }, 1500);
})();
