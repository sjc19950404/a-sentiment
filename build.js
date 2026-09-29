// build.js — 市场情绪仪表盘 v2 构建脚本
// 输入: template.html (代码骨架, 含 __REPORT_DATA__ 占位符) + data.json (清洗后数据)
// 输出: dist/index.html (单文件成品, file:// 可直接打开)
// patch 内容见 PATCHES 注释
const fs = require('fs');
const path = require('path');

const TPL = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8').replace(/\r\n/g, '\n');
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));

// ── patch 1: CSS 溢出修复（移动端 scrollW 1021 vs 375 问题的根因防护）──
const CSS_FIX = `
/* ── v2 溢出修复 ── */
html,body{overflow-x:hidden;max-width:100%}
.kpi,.kpi .val,.sec-desc,section,.grid2>section{min-width:0}
svg{max-width:100%}
.kpis{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.badge.next-open{border-color:rgba(232,176,75,.45);color:var(--gold)}
.dq-note{background:rgba(217,58,58,.08);border:1px solid rgba(217,58,58,.35);border-radius:10px;padding:10px 14px;color:#ff8a8a;font-size:12px;margin-bottom:12px}
@media(max-width:640px){body{padding:12px 8px 32px}header{padding:14px 14px}.tab{padding:8px 12px;font-size:12.5px}#modal{padding:14px}}`;

// ── patch 2: 净买 TOP15 改用聚合视图（修复同股多榜重复排序）──
const LHB_TOP_OLD = `  const lhb=CUR.lhb.slice(0,15);
  $id('lhb-desc').textContent=`;
const LHB_TOP_NEW = `  const lhb=(CUR.lhb_aggr&&CUR.lhb_aggr.length?CUR.lhb_aggr:CUR.lhb).slice(0,15);
  $id('lhb-desc').textContent=`;

// ── patch 3: 行业失效标注（Tab1 行业榜标题 note）──
const IND_OLD = `  $id('ind-note').textContent=(ind.length)+' 个板块 · 涨跌榜由板块日K重建';`;
const IND_NEW = `  const indOk = !(META.dataQuality && META.dataQuality.industrySourceOk === false);
  $id('ind-note').textContent = indOk
    ? (ind.length) + ' 个板块 · 涨跌榜由板块日K重建'
    : '数据源失效（0 个板块）· 情绪公式中行业广度按中性 50% 处理';`;

// ── patch 4: header 增加下一交易日提示（休市日感知）──
const HOLI_OLD = `  $id('st-count').textContent='已存档 '+DAYS.length+' 个交易日';`;
const HOLI_NEW = `  $id('st-count').textContent='已存档 '+DAYS.length+' 个交易日';
  { // 休市日感知: 从 CUR 之后的第一个休市日起逐日推进, 找到第一个非休市日即下一交易日
    const hol = (META.holidays || []).slice().sort();
    const after = hol.filter(h => h > CUR.trade_date);
    if (after.length) {
      const addDay = s => { const [y,m,d] = s.split('-').map(Number); const dt = new Date(y, m-1, d+1); return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0'); };
      let next = after[0];
      while (hol.includes(next)) next = addDay(next);
      const d = new Date(next + 'T00:00:00'), wd = ['日','一','二','三','四','五','六'][d.getDay()];
      const b = document.createElement('span');
      b.className = 'badge next-open';
      b.textContent = '休市中 · 下一交易日 ' + next + '（周' + wd + '）';
      $id('st-count').after(b);
    }
  }`;

// ── patch 5: Tab2 情绪卡「行业广度」失效提示 ──
const BRD_OLD = `<div class="kpi"><div class="lab">行业广度</div><div class="val num">\${e.s_brd}%\${arrow(e.s_brd,prev.s_brd)}</div><div class="sub">上涨板块占比</div></div>`;
const BRD_NEW = `<div class="kpi"><div class="lab">行业广度</div><div class="val num">\${e.s_brd}%\${arrow(e.s_brd,prev.s_brd)}</div><div class="sub">\${META.dataQuality && META.dataQuality.industrySourceOk === false ? '源失效 · 中性默认' : '上涨板块占比'}</div></div>`;

// ── patch 6: 数据质量警示条（行业失效时在顶部显示）──
const DQ_OLD = `<div class="warn">⚠️ 「信号中心」为统计外推与动量跟踪（数学），不是行情预测（玄学）。任何分值/趋势仅供参考复盘，不构成投资建议。</div>`;
const DQ_NEW = `<div class="warn">⚠️ 「信号中心」为统计外推与动量跟踪（数学），不是行情预测（玄学）。任何分值/趋势仅供参考复盘，不构成投资建议。</div>
<div class="dq-note" id="dq-note" style="display:none"></div>`;

// ── patch 7: META 常量注入 + 数据质量警示渲染 ──
const META_OLD = `const DAYS = D.all_days.slice().sort((a,b)=>a.trade_date<b.trade_date?-1:1);`;
const META_NEW = `const META = D.meta || {holidays:[],dataQuality:{}};
if (!D.generated && META.originalGenerated) D.generated = META.originalGenerated + ' · 数据清洗版';
const DAYS = D.all_days.slice().sort((a,b)=>a.trade_date<b.trade_date?-1:1);`;

// ── patch 8: 净买 TOP 排名 desc 说明（区分聚合口径）──
const DESC_OLD = `  $id('lhb-desc').textContent=\`净买合计 ¥\${CUR.summary.net_total_yi.toFixed(2)}亿 · 正 \${CUR.summary.net_pos} 条 / 负 \${CUR.summary.net_neg} 条\`;`;
const DESC_NEW = `  const agg = CUR.lhb_aggr && CUR.lhb_aggr.length;
  $id('lhb-desc').textContent=\`净买合计 ¥\${CUR.summary.net_total_yi.toFixed(2)}亿（按股去重, 多榜股取绝对值最大榜单为代表） · \${agg ? CUR.lhb_aggr.length + ' 只个股（同股多榜已聚合去重）' : CUR.summary.net_pos + ' 家净买 / ' + CUR.summary.net_neg + ' 家净卖'}\`;`;

const PATCHES = [
  ['/*__DATA__*/', '<script id="report-data" type="application/json">__REPORT_DATA__</' + 'script>'],
  ['.warn{background:rgba(232,176,75,.08);border:1px solid rgba(232,176,75,.3);border-radius:10px;padding:10px 14px;color:var(--gold);font-size:12px;margin-bottom:12px}',
   '.warn{background:rgba(232,176,75,.08);border:1px solid rgba(232,176,75,.3);border-radius:10px;padding:10px 14px;color:var(--gold);font-size:12px;margin-bottom:12px}' + CSS_FIX],
  [LHB_TOP_OLD, LHB_TOP_NEW],
  [IND_OLD, IND_NEW],
  [HOLI_OLD, HOLI_NEW],
  [BRD_OLD, BRD_NEW],
  [DQ_OLD, DQ_NEW],
  [META_OLD, META_NEW],
  [DESC_OLD, DESC_NEW]
];

// ── v3: 实验室模块拼接（显式清单，顺序敏感: lab-core 必须最先；lab-kline 须在 s6/s8 前——s6 的 IIFE
//    同步检查 window.__klineList 注册异步覆盖口径；s8 运行时检查 __klineShard；vendor 必须在 lab-sync 前）──
const MODULES = [
  'lab-core.js',
  'lab-kline.js',
  'lab-s1.js',
  'lab-s2.js',
  'lab-s5.js',
  'lab-s7.js',
  'lab-s6.js',
  'lab-s4.js',
  'lab-s8.js',
  'lab-s3.js',
  'lab-s9.js',
  'lab-s11.js',
  'vendor/qrcode.min.js',
  'lab-sync.js',
  'lab-realtime.js'
];
const MOD_ANCHOR = '/*__LAB_MODULES__*/';

// ── v3: 每日复盘简报生成（S3）──
function makeBrief(day, prevDay, allDays) {
  const e = day.emotion || {}, s = day.summary || {};
  const pe = (prevDay && prevDay.emotion) || {};
  const L = [];
  L.push(`【${day.trade_date} 复盘简报】A股市场情绪系统`);
  const diff = pe.value != null ? e.value - pe.value : null;
  L.push(`一、情绪面：综合情绪 ${e.value ?? '—'}（历史分位 ${e.pct_rank ?? '—'}%，存档 ${allDays.length} 日内排名）${diff != null ? `，较前值${diff >= 0 ? ' ↑' : ' ↓'}${Math.abs(diff).toFixed(1)}` : ''}。龙虎榜净买入 ${e.net_total_yi == null ? '—' : (e.net_total_yi >= 0 ? '+' : '') + e.net_total_yi + ' 亿元'}（净买 ${s.net_pos} 家 / 净卖 ${s.net_neg} 家）。`);
  const tp = (day.topics || [])[0] || {};
  L.push(`二、热点：最热题材「${tp.tag || '—'}」${tp.count || 0} 只；题材集中度 ${e.topic_conc ?? '—'}%；同花顺强势股 ${s.hot_count ?? '—'} 只。`);
  const aggr = (day.lhb_aggr && day.lhb_aggr.length ? day.lhb_aggr : day.lhb) || [];
  if (aggr.length) {
    const sorted = aggr.slice().sort((a, b) => b.net_buy_wan - a.net_buy_wan);
    const top1 = sorted[0], bot1 = sorted[sorted.length - 1];
    const fmt = v => (v >= 0 ? '+' : '') + (v / 10000).toFixed(2) + '亿';
    L.push(`三、资金：净买第一「${top1.name}」${fmt(top1.net_buy_wan)}（${top1.reason || '—'}）；净卖第一「${bot1.name}」${fmt(bot1.net_buy_wan)}。上榜个股共 ${aggr.length} 只。`);
  }
  if (day.industry && day.industry.length) {
    const t = day.industry[0], b = day.industry[day.industry.length - 1];
    L.push(`四、行业：领涨「${t.name}」${t.change_pct > 0 ? '+' : ''}${t.change_pct}%；领跌「${b.name}」${b.change_pct}%。`);
  } else {
    L.push(`四、行业：板块数据源失效，行业广度因子按中性值 50 处理（情绪公式 25% 权重降级）。`);
  }
  L.push(`五、提示：以上为统计口径复盘素材，非行情预测。情绪分位 = 当日在全部存档交易日中的排名。`);
  return L.join('\n');
}

// ── v3.1: 行业 5 日动量（信号中心 Tab4）· 由板块日K动态重建（不再依赖 v1 预计算 signals.industry）──
function addIndustryMomentum(DATA) {
  const days = DATA.all_days.slice().sort((a, b) => a.trade_date < b.trade_date ? -1 : 1);
  if (!days.length) return 0;
  const win = days.slice(-5);
  if (win.length < 5) return 0; // 数据积累不足 5 日，保持空榜
  const acc = new Map();
  win.forEach(d => (d.industry || []).forEach(it => {
    const o = acc.get(it.name) || { prod: 1, n: 0 };
    o.prod *= (1 + (it.change_pct || 0) / 100); o.n++;
    acc.set(it.name, o);
  }));
  const rows = [...acc.entries()]
    .filter(([, o]) => o.n === win.length) // 5 日数据齐全才参与，避免半程噪音
    .map(([name, o]) => ({ name, chg5: Math.round((o.prod - 1) * 10000) / 100 }))
    .sort((a, b) => b.chg5 - a.chg5);
  DATA.signals = DATA.signals || {};
  DATA.signals.industry = {
    top: rows.slice(0, 8),
    bottom: rows.slice(-8).reverse(), // 跌幅最大在前
    asOf: win[win.length - 1].trade_date,
    note: '由最近 5 个存档交易日板块涨跌幅复合重建（同花顺行业指数日K）'
  };
  return rows.length;
}

function addBriefs(DATA) {
  const days = DATA.all_days.slice().sort((a, b) => a.trade_date < b.trade_date ? -1 : 1);
  const briefs = {};
  days.forEach((d, i) => { briefs[d.trade_date] = makeBrief(d, days[i - 1], days); });
  DATA.briefs = briefs;
  return briefs;
}

let out = TPL;
for (const [oldS, newS] of PATCHES) {
  if (!out.includes(oldS)) { console.error('PATCH 匹配失败:', oldS.slice(0, 60)); process.exit(1); }
  out = out.replace(oldS, () => newS); // 函数式替换: 防 newS 中 $&/$$/$' 等 $ 模式被解释
}

// 模块拼接（放在 patch 之后，语法上彼此独立、互不依赖执行顺序，除 lab-core 需在前）
if (!out.includes(MOD_ANCHOR)) { console.error('实验室占位符缺失:', MOD_ANCHOR); process.exit(1); }
const modCodes = MODULES.map(f => {
  const p = path.join(__dirname, 'src', f);
  if (!fs.existsSync(p)) { console.error('模块文件缺失: src/' + f); process.exit(1); }
  return '// ════ src/' + f + ' ════\n' + fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trim();
});
out = out.replace(MOD_ANCHOR, () => modCodes.join('\n\n')); // 函数式: 模块代码含 $'/$& 等 $ 模式时不被特殊解释（vendor 的 case '$' 踩中过）

// 数据质量警示条内容（行业失效时显示）
out = out.replace('</script>\n</body>', () => (`
// 数据质量警示渲染
(function(){
  const dq = META.dataQuality || {};
  const el0 = $id('dq-note');
  if (!el0) return;
  const msgs = [];
  if (dq.industrySourceOk === false) msgs.push('⚠ 行业板块数据源失效：行业广度按中性 50% 处理（情绪公式 25% 权重降级），行业相关榜单暂无数据。');
  if (msgs.length) { el0.innerHTML = msgs.join('<br>'); el0.style.display = 'block'; }
})();
</` + `script>
</body>`));

// 注入数据（保持 JSON 安全转义 </script）
const momN = addIndustryMomentum(DATA);
const briefs = addBriefs(DATA);
// ── 页面滑动窗口（仅裁剪注入页面的副本；仓库 data.json 永远全量，真备份=git 历史）──
const PAGE_WINDOW = parseInt(process.env.SENT_PAGE_WINDOW || '250', 10);
let pageData = DATA;
if (PAGE_WINDOW > 0 && Array.isArray(DATA.all_days) && DATA.all_days.length > PAGE_WINDOW) {
  const keepSet = new Set(DATA.all_days.slice(-PAGE_WINDOW).map(d => d.trade_date));
  pageData = {
    ...DATA,
    all_days: DATA.all_days.slice(-PAGE_WINDOW),
    board_rank: Object.fromEntries(Object.entries(DATA.board_rank || {}).filter(([dt]) => keepSet.has(dt))),
    stocks: Object.fromEntries(Object.entries(DATA.stocks || {}).map(([code, st]) => [code, Object.assign({}, st, { closes: (st.closes || []).filter(pair => keepSet.has(pair[0])) })]))
  };
  pageData.meta = Object.assign({}, DATA.meta, { pageWindowDays: PAGE_WINDOW, pageWindowNote: '页面仅注入最近 ' + PAGE_WINDOW + ' 个交易日；全档数据永远留存于仓库 data.json' });
  console.log('页面滑动窗口: 注入最近', PAGE_WINDOW, '个交易日（全档', DATA.all_days.length, '天留存于 data.json）');
}
const json = JSON.stringify(pageData).replace(/<\//g, '<\\/');
out = out.replace('__REPORT_DATA__', () => json); // 函数式: 防 JSON 内容含 $ 特殊模式（$&/$$）破坏输出

// 顺带产出最新一期简报文件（便于外部使用/归档）
const lastDate = Object.keys(briefs).sort().pop();
if (!fs.existsSync(path.join(__dirname, 'dist'))) fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true }); // 云端冷启动 dist 不存在（本机总有历史产物故从未暴露）
fs.writeFileSync(path.join(__dirname, 'dist', 'brief-latest.txt'), briefs[lastDate] + '\n');
console.log('简报生成:', Object.keys(briefs).length, '期 · 最新', lastDate, '→ dist/brief-latest.txt');
console.log('行业 5 日动量:', momN, '个板块参与（top/bottom 8 注入 signals.industry）');

const distDir = path.join(__dirname, 'dist');
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
const outFile = path.join(distDir, 'index.html');
fs.writeFileSync(outFile, out);

// v4.1: 发布目录（单文件静态站，供 sites 发布上线——手机/微信同链打开）
// 注意：必须在项目树外（上级目录有其他应用的 .wbapp_*.genie 标记，sites 发布会向上命中导致覆盖别的应用）
const siteDir = process.env.SENT_SITE_DIR || 'C:\\Users\\Administrator\\WorkBuddy\\sentiment-dashboard-site';
if (!fs.existsSync(siteDir)) fs.mkdirSync(siteDir, { recursive: true });
fs.writeFileSync(path.join(siteDir, 'index.html'), out);

// v4.9.12: 实战使用指南随产物发布（Tab6 内嵌 iframe 同源加载 guide.html）
const guideSrc = path.join(__dirname, 'guide.html');
if (fs.existsSync(guideSrc)) {
  fs.copyFileSync(guideSrc, path.join(distDir, 'guide.html'));
  fs.copyFileSync(guideSrc, path.join(siteDir, 'guide.html'));
  console.log('指南随产物: guide.html → dist/ + 发布目录/');
}

// v4.3: 同步 task-manager 静态目录（线上挂载点——原在 fetch-daily.js 尾部, 收进 build 保证任何构建后产物一致）
const taskPublic = path.join(__dirname, '..', 'task-manager', 'public', 'sentiment.html');
if (fs.existsSync(path.dirname(taskPublic))) fs.copyFileSync(outFile, taskPublic);

console.log('发布目录:', path.join(siteDir, 'index.html'));

// v4.8: 全市场K线分片随产物发布（Pages 伺服 kline/*.json，前端按需 fetch + IndexedDB 缓存）
const klineDir = path.join(__dirname, 'kline');
if (fs.existsSync(klineDir)) {
  const kdist = path.join(distDir, 'kline');
  if (!fs.existsSync(kdist)) fs.mkdirSync(kdist, { recursive: true });
  let kn = 0;
  for (const f of fs.readdirSync(klineDir)) {
    if (!f.endsWith('.json')) continue;
    fs.copyFileSync(path.join(klineDir, f), path.join(kdist, f));
    kn++;
  }
  console.log('K线分片随产物:', kn, '个文件 → dist/kline/');
}

console.log('构建完成:', outFile, (fs.statSync(outFile).size / 1024).toFixed(0) + ' KB');
console.log('patch 应用:', PATCHES.length, '项 + 数据质量警示 1 项 + 实验室模块', MODULES.length, '个，全部成功');
