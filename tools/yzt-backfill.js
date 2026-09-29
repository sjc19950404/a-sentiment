// yzt（同花顺 883994 昨日涨停指数）滞后回填工具 · v1.0 (2026-09-29)
// 背景: 每日管道 18:30 跑时 d.10jqka.com.cn 的 883994 历史时序偶尔当天还没出 bar
//       （9/29 实测 19:58 仍只有到 0928），导致当日 yzt_chg 缺 → summary._missing 含 'yzt'
//       → v4.9.1 的 pctRankRealOnly 规则把「当前情绪分位/净买入分位」置 null（信号中心显示 —）。
// 本工具幂等可反复跑: 哪个存档日缺 yzt、且源文件现已补出该日 bar，就回填 yzt_chg、
// 从 _missing 里摘除 'yzt'，并按 fetch-daily.js 同口径重算全档 pct_rank / net_pct_rank。
// 用法: node tools/yzt-backfill.js [--dry]   （--dry 只报告不写）
// 回填后需: node build.js 重建产物 + 提交推送 + 小程序云表同步（见自动化/备忘）。
const fs = require('fs');
const path = require('path');
const DRY = process.argv.includes('--dry');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const REF = 'https://q.10jqka.com.cn/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;

// 与 fetch-daily.js fetchYztMap 完全同源同参
async function fetchYztMap() {
  const map = {}; const closes = {}; const rowsAll = [];
  for (const year of [2025, 2026]) {
    try {
      const r = await fetch('https://d.10jqka.com.cn/v6/line/48_883994/01/' + year + '.js',
        { headers: { 'User-Agent': UA, Referer: REF } });
      const t = await r.text();
      const obj = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
      (obj.data || '').split(';').filter(Boolean).forEach(l => rowsAll.push(l.split(',')));
    } catch (e) { /* 单年失败容错 */ }
    await sleep(300);
  }
  for (let i = 1; i < rowsAll.length; i++) {
    const k = rowsAll[i], p = rowsAll[i - 1];
    if (k.length >= 5 && +k[4] > 0 && +p[4] > 0) { map[k[0]] = r2((+k[4] / +p[4] - 1) * 100); closes[k[0]] = +k[4]; }
  }
  return Object.keys(map).length ? { map, closes } : null;
}

async function main() {
  const file = path.join(__dirname, '..', 'data.json');
  const D = JSON.parse(fs.readFileSync(file, 'utf8'));
  const src = await fetchYztMap();
  if (!src) { console.error('883994 源拉取失败，本次跳过（下次再试）'); process.exit(3); }
  const { map } = src;
  console.log('源时序最新日期: %s（%s 个交易日）', Object.keys(map).sort().pop(), Object.keys(map).length);

  // 与 fetch-daily.js recalcRanks 完全同口径: 分位仅用「无补位因子」的真实天数
  const rank = (vals, v) => { const s = [...vals].sort((a, b) => a - b); return s.indexOf(v) / Math.max(s.length - 1, 1) * 100; };
  const recalcRanks = () => {
    const days = D.all_days;
    const realDays = days.filter(d => d.emotion && !((d.summary && d.summary._missing) || []).length);
    const vs = realDays.map(d => d.emotion.value), ns = realDays.map(d => d.emotion.net_total_yi);
    days.forEach(d => {
      if (!d.emotion) return;
      const miss = ((d.summary && d.summary._missing) || []).length;
      if (miss) { d.emotion.pct_rank = null; d.emotion.net_pct_rank = null; }
      else { d.emotion.pct_rank = r1(rank(vs, d.emotion.value)); d.emotion.net_pct_rank = r1(rank(ns, d.emotion.net_total_yi)); }
    });
  };

  let fixed = 0;
  for (const d of D.all_days) {
    if (!d.summary) continue;
    const miss = d.summary._missing || [];
    if (!miss.includes('yzt')) continue;
    const ymd = d.trade_date.replace(/-/g, '');
    if (map[ymd] == null) { console.log('· %s 仍缺（源尚未出该日 bar）', d.trade_date); continue; }
    console.log('✓ %s 回填 yzt_chg=%s%%（此前缺）', d.trade_date, map[ymd]);
    if (DRY) continue;
    d.summary.yzt_chg = map[ymd];
    const rest = miss.filter(x => x !== 'yzt');
    if (rest.length) d.summary._missing = rest; else delete d.summary._missing;
    fixed++;
  }
  if (!fixed) { console.log(DRY ? '[dry] 无可回填项' : '无可回填项，data.json 未改动'); return; }
  if (DRY) { console.log('[dry] 可回填 %s 天，未写入', fixed); return; }
  recalcRanks();
  fs.writeFileSync(file, JSON.stringify(D));
  console.log('已写入 data.json · 重算全档分位完成（补位天数=%s）', D.all_days.filter(d => d.summary && (d.summary._missing || []).length).length);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
