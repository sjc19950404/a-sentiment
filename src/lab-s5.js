/* ═══════════ S5 自选股情绪哨兵 ═══════════ */
(function () {
  let WL = LAB.get('watchlist', []); // [{code, addedAt}]
  const save = () => LAB.set('watchlist', WL);

  // 股票池（用于 datalist 与名称解析）
  const pool = new Map();
  DAYS.forEach(d => {
    (d.lhb_aggr || d.lhb || []).forEach(s => { if (!pool.has(s.code)) pool.set(s.code, s.name); });
    (d.hot || []).forEach(s => { if (!pool.has(s.code)) pool.set(s.code, s.name); });
  });
  Object.entries(D.stocks || {}).forEach(([c, st]) => { if (!pool.has(c) && st.name) pool.set(c, st.name); });
  $id('s5-dl').innerHTML = [...pool.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([c, n]) => `<option value="${c}">${n}</option>`).join('');

  const resolveName = code => {
    if (D.stocks[code] && D.stocks[code].name) return D.stocks[code].name;
    for (let i = DAYS.length - 1; i >= 0; i--) {
      const d = DAYS[i];
      const r = (d.lhb_aggr || d.lhb || []).find(s => s.code === code) || (d.hot || []).find(s => s.code === code);
      if (r) return r.name;
    }
    return code;
  };

  function timeline(code) {
    const recs = [];
    DAYS.forEach(d => (d.lhb_aggr || d.lhb || []).forEach(s => { if (s.code === code) recs.push({ date: d.trade_date, net: s.net_buy_wan || 0, chg: s.change_pct }); }));
    return recs;
  }
  function lastHot(code) {
    for (let i = DAYS.length - 1; i >= 0; i--) {
      const r = (DAYS[i].hot || []).find(s => s.code === code);
      if (r) return { date: DAYS[i].trade_date, reason: r.reason || '' };
    }
    return null;
  }
  function pxInfo(code) {
    const cl = (D.stocks[code] || {}).closes || [];
    if (!cl.length) return null;
    const last = cl[cl.length - 1], first = cl[0];
    return { px: last[1], pxDate: last[0], range: (last[1] / first[1] - 1) * 100, n: cl.length };
  }
  function alerts(code) {
    const out = [];
    const tl = timeline(code);
    if (tl.length) {
      const ago = LAB.idxOf[CUR.trade_date] - LAB.idxOf[tl[tl.length - 1].date];
      if (ago === 0) out.push(['🔔 今日新上榜', 'hot']);
      let consec = 0;
      for (let i = DAYS.length - 1; i >= 0; i--) { if (tl.some(r => r.date === DAYS[i].trade_date)) consec++; else break; }
      if (consec >= 2) out.push(['🔥 连续 ' + consec + ' 日在榜', 'hot']);
      if (ago >= 3) out.push(['💤 已 ' + ago + ' 个交易日未上榜', 'dim']);
      const totalNet = tl.reduce((a, r) => a + r.net, 0);
      if (totalNet <= -10000) out.push(['💧 存档期累计净卖 ' + fmtW(totalNet), 'dn']);
      else if (totalNet >= 10000) out.push(['💰 存档期累计净买 +' + fmtW(totalNet), 'up']);
    } else {
      out.push(['😴 存档期未上过龙虎榜', 'dim']);
    }
    const p = pxInfo(code);
    if (p && p.range <= -10) out.push(['📉 ' + p.n + '日区间 ' + p.range.toFixed(1) + '%', 'dn']);
    else if (p && p.range >= 15) out.push(['🚀 ' + p.n + '日区间 +' + p.range.toFixed(1) + '%', 'up']);
    return out;
  }

  function addStock() {
    const raw = $id('s5-input').value.trim();
    if (!raw) return;
    let code = null;
    if (pool.has(raw)) code = raw;
    else {
      const byName = [...pool.entries()].filter(([, n]) => n === raw);
      if (byName.length) code = byName[0][0];
      else {
        const fuzzy = [...pool.entries()].filter(([, n]) => n.includes(raw));
        if (fuzzy.length === 1) code = fuzzy[0][0];
        else if (fuzzy.length > 1) { LAB.toast('「' + raw + '」匹配 ' + fuzzy.length + ' 只（' + fuzzy.slice(0, 3).map(f => f[1]).join('、') + '…），请输入完整名称或代码'); return; }
      }
    }
    if (!code) { LAB.toast('未找到「' + raw + '」— 输入 6 位代码或完整名称'); return; }
    if (WL.some(w => w.code === code)) { LAB.toast('已在哨兵名单中'); return; }
    WL.unshift({ code, addedAt: Date.now() });
    save(); $id('s5-input').value = '';
    LAB.toast('哨兵已上岗: ' + resolveName(code));
    render();
  }
  $id('s5-add').onclick = addStock;
  $id('s5-input').addEventListener('keydown', e => { if (e.key === 'Enter') addStock(); });

  function render() {
    const host = $id('s5-cards');
    $id('s5-empty').textContent = WL.length ? '' : '名单为空。添加方式: 输入代码/名称（支持联想），或在龙虎榜表格点行看详情后记下代码。哨兵监控内容: 上榜动静 / 连板节奏 / 资金累计 / 区间强弱。';
    host.innerHTML = WL.map(w => {
      const code = w.code, name = resolveName(code);
      const tl = timeline(code), p = pxInfo(code), h = lastHot(code);
      const totalNet = tl.reduce((a, r) => a + r.net, 0);
      const lastLhb = tl[tl.length - 1];
      const al = alerts(code).map(([t, k]) => `<span class="alert-tag tag ${k === 'hot' ? 'hot' : ''}" style="${k === 'up' ? 'color:#ff8a8a;border-color:rgba(255,90,90,.4)' : k === 'dn' ? 'color:#5fd8b4;border-color:rgba(47,191,143,.4)' : ''}">${t}</span>`).join(' ');
      return `<div class="wl-card">
        <span class="x" data-del="${code}" title="移除哨兵">✕</span>
        <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
          <b style="font-size:14.5px">${name}</b><span class="code num">${code}</span>
          ${p ? `<span class="num" style="font-weight:700">¥${p.px.toFixed(2)}</span><span class="num ${cls(p.range)}" style="font-size:12px">${p.range > 0 ? '+' : ''}${p.range.toFixed(1)}%<span class="dim">（${p.n}日）</span></span>` : ''}
        </div>
        <div style="margin-top:5px;font-size:12.5px" class="num">
          上榜 <b>${tl.length}</b> 次 · 累计净买 <span class="${cls(totalNet)}" style="font-weight:700">${tl.length ? (totalNet >= 0 ? '+' : '') + fmtW(totalNet) : '—'}</span>
          ${lastLhb ? ` · 最近 <b>${lastLhb.date.slice(5)}</b> 当次 <span class="${cls(lastLhb.net)}">${lastLhb.net >= 0 ? '+' : ''}${fmtW(lastLhb.net)}</span>` : ''}
        </div>
        ${h ? `<div style="margin-top:4px;font-size:12px">题材 <span class="dim">${h.date.slice(5)}:</span> ${(h.reason || '—').split('+').slice(0, 4).map(t => `<span class="tag">${t.trim()}</span>`).join('')}</div>` : ''}
        <div style="margin-top:6px">${al}</div>
      </div>`;
    }).join('');
    host.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      WL = WL.filter(w => w.code !== b.dataset.del);
      save(); render(); LAB.toast('哨兵已撤岗');
    });
  }
  render();
})();
