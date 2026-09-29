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

  /* ── 大盘哨兵（v4.9.14）：市场状态位置/炸板率/净买/趋势/仓位依据 ──
     判定结果复用 Tab6 暴露的 window.__mktState（缺失时本地兜底重算） */
  function stripTags(s){return String(s||'').replace(/<[^>]+>/g,'');}
  function spark(vals){ // 近 5 日情绪分迷你折线（涨红跌绿）
    const w=110,h=28,p=3;
    if(!vals.length)return '';
    const mn=Math.min(...vals),mx=Math.max(...vals),rg=(mx-mn)||1;
    const pts=vals.map((v,i)=>(p+i*(w-2*p)/Math.max(1,vals.length-1)).toFixed(1)+','+(h-p-(v-mn)/rg*(h-2*p)).toFixed(1)).join(' ');
    const col=vals[vals.length-1]>=vals[0]?'#ff5a5a':'#2fbf8f';
    return `<svg width="${w}" height="${h}" style="vertical-align:middle" aria-label="近5日情绪分走势"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/></svg>`;
  }
  function renderMarket(){
    const host=$id('s5-market'); if(!host)return;
    const E=CUR.emotion||{},S=CUR.summary||{};
    let MS=window.__mktState;
    if(!MS){ // 兜底: 主脚本异常时本地重算（与 Tab6 同规则）
      const vals=DAYS.map(d=>d.emotion&&d.emotion.value).filter(v=>v!=null);
      const ref=vals.length>3?vals[vals.length-4]:vals[0];
      const d3=(E.value||0)-(ref!=null?ref:(E.value||0));
      const recentHot=DAYS.slice(-6,-1).some(x=>x.emotion&&x.emotion.value>65);
      const v=E.value==null?50:E.value;
      const st=v<30?'ice':v>65?'hot':d3>=4?'rec':(d3<=-4&&recentHot)?'ret':'neu';
      MS={st,name:{ice:'❄ 冰点区',rec:'📈 回升期',neu:'➖ 中性区',hot:'🔥 偏热区',ret:'🌧 退潮期'}[st],play:[],warns:[],d3};
    }
    const d3=MS.d3||0;
    // ① 状态位置: 五状态标签一排, 当前态高亮并带实际分值, 其余带分数区间
    const seq=[['ice','❄ 冰点','&lt;30'],['rec','📈 回升','30~65 ↑'],['neu','➖ 中性','45~55'],['hot','🔥 偏热','&gt;65'],['ret','🌧 退潮','拐点 ↓']];
    const tags=seq.map(([k,lab,rng])=>{
      const on=k===MS.st;
      return '<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 11px;border-radius:16px;border:1.5px solid '+(on?'#e8b04b':'var(--line)')+';color:'+(on?'var(--gold)':'var(--faint)')+';font-size:12px;font-weight:'+(on?'700':'400')+';background:'+(on?'rgba(232,176,75,.08)':'transparent')+'">'+lab
        +(on?' <b class="num" style="font-size:13px">'+(E.value!=null?E.value:'—')+'分</b>':' <span class="num" style="font-size:10.5px">'+rng+'</span>')+'</span>';
    }).join('<span style="color:var(--faint);margin:0 2px">·</span>');
    // ② 趋势: 近3日方向 + 近5日情绪分迷你折线
    const v5=DAYS.slice(-5).map(d=>d.emotion&&d.emotion.value).filter(v=>v!=null);
    const dirTxt=d3>0.5?'上行':(d3<-0.5?'下行':'走平');
    const dirCls=d3>0.5?'up':(d3<-0.5?'down':'');
    const g=(v,k,c)=>'<div style="background:var(--card);border:1px solid var(--line);border-radius:10px;padding:9px 12px;text-align:center"><div class="num" style="font-size:17px;font-weight:700;color:'+(c||'var(--txt)')+'">'+v+'</div><div style="font-size:11.5px;color:var(--dim)">'+k+'</div></div>';
    const net=S.net_total_yi, zbl=S.zbl_pct;
    // ③ 仓位依据: 状态 + 趋势 + 资金 + 炸板 → 对应打法
    let basis='当前处于 <b style="color:var(--gold)">'+MS.name+'</b>（情绪分 <b class="num">'+(E.value!=null?E.value:'—')+'</b>，近 3 日 <span class="'+dirCls+'">'+dirTxt+' '+(d3>0?'+':'')+d3.toFixed(1)+' 分</span>）'
      +'，龙虎榜资金'+(Number(net)>=0?'净流入 <span class="up num">'+(net>=0?'+':'')+net+'亿</span>':'净流出 <span class="down num">'+net+'亿</span>')
      +'，炸板率 <b class="num">'+(zbl!=null?zbl+'%':'—')+'</b>'+((Number(zbl)||0)>30?'<span style="color:var(--gold)"> ⚠ 超 30% 警戒线</span>':'（正常）')
      +' → '+(MS.play&&MS.play.length?stripTags(MS.play[0]):'按五状态对照表执行：位置 + 趋势 + 拐点 = 仓位依据。');
    if(MS.warns&&MS.warns.length)basis+='<div style="margin-top:6px;color:var(--gold)">⚠ '+MS.warns.map(stripTags).join('；')+'</div>';
    host.innerHTML='<div style="border:1px solid var(--line);border-radius:12px;padding:13px 15px;background:var(--panel)">'
      +'<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px"><b style="font-size:13.5px">🛡 大盘哨兵</b><span class="dim" style="font-size:11.5px">市场位置一览 · 随每日存档自动更新 · '+CUR.trade_date+'</span></div>'
      +'<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">'+tags+'</div>'
      +'<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:9px;margin:11px 0">'
      +g((zbl!=null?zbl+'%':'—'),'炸板率'+((Number(zbl)||0)>30?' ⚠':''),(Number(zbl)||0)>30?'var(--gold)':null)
      +g((Number(net)>=0?'+':'')+(net!=null?net:'—')+'亿','龙虎榜净买'+(S.net_total_yi!=null?'（分位 '+(E.net_pct_rank!=null?E.net_pct_rank+'%':'—')+'）':''),Number(net)>=0?'var(--up)':'var(--down)')
      +'<div style="background:var(--card);border:1px solid var(--line);border-radius:10px;padding:9px 12px;text-align:center"><div>'+(spark(v5)||'<span class="dim">—</span>')+'</div><div style="font-size:11.5px;color:var(--dim)">情绪趋势 · 近 3 日 <span class="'+dirCls+'">'+dirTxt+'</span></div></div>'
      +'</div>'
      +'<div style="background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 14px;font-size:12.5px;line-height:1.8"><b style="color:var(--gold)">📋 仓位依据</b>　'+basis+'</div>'
      +'</div>';
  }
  renderMarket();

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
