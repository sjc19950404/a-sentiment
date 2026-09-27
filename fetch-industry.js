// fetch-industry.js — 行业板块涨跌榜数据源修复
// 根因: 原东财板块日K源(push2his)对本机 IP 持续受限 → 30 天存档 industry 全空
// 修复: 用同花顺行业指数(881xxx, 140个, d.10jqka.com.cn 对本机放行)日K回填重建
// 动作: 抓列表+日K → 组装逐日 industry 涨跌榜 → 重算 s_brd/up_ratio/value/pct_rank
//       → 更新 meta.dataQuality → 写回 data.json
// 运行: node fetch-industry.js
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36';
const DATA_FILE = path.join(__dirname, 'data.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const D = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const days = D.all_days.slice().sort((a, b) => a.trade_date < b.trade_date ? -1 : 1);
  console.log('存档交易日:', days.length, days[0].trade_date, '~', days[days.length - 1].trade_date);

  // ── 1. 板块列表（GBK 页面 → 代码+名称）──
  const listRes = await fetch('https://q.10jqka.com.cn/thshy/', { headers: { 'User-Agent': UA } });
  const html = new TextDecoder('gbk').decode(await listRes.arrayBuffer());
  const re = /thshy\/detail\/code\/(88\d{4})\/" target="_blank">([^<]+)</g;
  let m; const boards = []; const seen = new Set();
  while ((m = re.exec(html))) {
    if (!seen.has(m[1])) { seen.add(m[1]); boards.push({ code: m[1], name: m[2].trim() }); }
  }
  if (boards.length < 50) { console.error('板块列表异常:', boards.length); process.exit(1); }
  console.log('行业板块:', boards.length, '个 · 样例:', boards.slice(0, 4).map(b => b.code + b.name).join(' '));

  // ── 2. 逐板块抓 2026 年日K（串行 + 120ms + 重试1次）──
  // kline[code] = [[YYYYMMDD, close], ...] 升序
  const kline = new Map(); let fail = 0;
  for (let i = 0; i < boards.length; i++) {
    const { code, name } = boards[i];
    let ok = false;
    for (let att = 0; att < 2 && !ok; att++) {
      try {
        const r = await fetch('http://d.10jqka.com.cn/v6/line/48_' + code + '/01/2026.js', { headers: { 'User-Agent': UA, Referer: 'https://q.10jqka.com.cn/' } });
        const t = await r.text();
        const s = t.slice(t.indexOf('(') + 1, t.lastIndexOf(')'));
        const obj = JSON.parse(s);
        const rows = (obj.data || '').split(';').filter(Boolean).map(l => l.split(','));
        if (rows.length > 100) { kline.set(code, rows.map(r2 => [r2[0], +r2[4]])); ok = true; }
      } catch (e) { await sleep(400); }
    }
    if (!ok) { fail++; console.log('  ✗ 失败:', code, name); }
    if ((i + 1) % 20 === 0) console.log('  进度', i + 1, '/', boards.length);
    await sleep(120);
  }
  console.log('日K抓取完成:', kline.size, '成功 /', fail, '失败');
  if (kline.size < 80) { console.error('成功板块过少，中止（不写入）'); process.exit(1); }

  // ── 3. 组装逐日行业涨跌榜 + 重算情绪 ──
  // 涨跌幅 = close/preClose-1（preClose 取日K序列前一条，与交易所口径一致）
  const chgOf = new Map(); // 'YYYY-MM-DD' -> Map(code -> change_pct)
  for (const [code, rows] of kline) {
    for (let i = 1; i < rows.length; i++) {
      const dt = rows[i][0], pre = rows[i - 1][1], cur = rows[i][1];
      if (!pre) continue;
      const ymd = dt.slice(0, 4) + '-' + dt.slice(4, 6) + '-' + dt.slice(6);
      if (!chgOf.has(ymd)) chgOf.set(ymd, new Map());
      chgOf.get(ymd).set(code, +(((cur / pre) - 1) * 100).toFixed(2));
    }
  }

  const values = [];
  for (const d of days) {
    const dayChg = chgOf.get(d.trade_date);
    if (!dayChg || dayChg.size < 50) {
      console.warn('  ⚠', d.trade_date, '板块数据不足(' + (dayChg ? dayChg.size : 0) + ')，该日保持空');
      continue;
    }
    const arr = [...dayChg.entries()].map(([c, p]) => ({ name: (boards.find(b => b.code === c) || {}).name || c, change_pct: p }))
      .sort((a, b) => b.change_pct - a.change_pct);
    d.industry = arr;
    const up = arr.filter(x => x.change_pct > 0).length;
    d.summary.ind_up = up;
    d.summary.ind_down = arr.length - up - arr.filter(x => x.change_pct === 0).length; // 跌=非涨非平（平盘单列不计跌，与常见口径一致）
    d.summary.ind_up = arr.filter(x => x.change_pct > 0).length;
    d.summary.ind_down = arr.filter(x => x.change_pct < 0).length;
    const e = d.emotion;
    e.s_brd = +(up / arr.length * 100).toFixed(1);
    e.up_ratio = e.s_brd;
    e.value = +((e.s_net * 35 + e.s_pos * 25 + e.s_brd * 25 + e.s_hot * 15) / 100).toFixed(1);
    values.push(e.value);
    e.industryCount = arr.length; // 审计辅助字段
  }

  // ── 4. pct_rank 重算（存档期内分位, B式: <x 计数/(n-1)，有数据的日子统一重排）──
  const withVal = days.filter(d => d.emotion && d.emotion.value != null);
  const n = withVal.length;
  for (const d of withVal) {
    const lt = withVal.filter(x => x.emotion.value < d.emotion.value).length;
    d.emotion.pct_rank = n > 1 ? +(lt / (n - 1) * 100).toFixed(1) : 50;
  }

  // ── 5. meta 更新 ──
  D.meta = D.meta || {};
  D.meta.dataQuality = Object.assign({}, D.meta.dataQuality, {
    industrySourceOk: true,
    industryNote: '原东财板块日K源(push2his)对本机IP持续受限导致30天空缺；2026-09-27 已用同花顺行业指数(881xxx)日K回填重建涨跌榜，s_brd/up_ratio/情绪值/情绪分位已按官方公式重算（pct_rank 口径为存档期内分位，v1 原为更长历史口径；net_pct_rank 未受影响保持原值）',
    industryBackfilledAt: '2026-09-27',
    industrySource: '同花顺行业指数 d.10jqka.com.cn（' + kline.size + ' 个板块）'
  });

  // ── 6. 备份 + 写回 ──
  fs.copyFileSync(DATA_FILE, path.join(__dirname, 'data.backup-pre-industry.json'));
  fs.writeFileSync(DATA_FILE, JSON.stringify(D));
  const vs = values;
  console.log('\n回填完成:');
  console.log('  覆盖交易日:', vs.length, '/', days.length);
  console.log('  情绪值范围:', Math.min(...vs), '~', Math.max(...vs), '（修复前最后一次 62.8）');
  const last = days[days.length - 1];
  console.log('  最后交易日行业榜: 领涨', last.industry[0].name, '+' + last.industry[0].change_pct + '% · 领跌', last.industry[last.industry.length - 1].name, last.industry[last.industry.length - 1].change_pct + '%');
  console.log('  最后交易日 s_brd:', last.emotion.s_brd + '% · 新情绪值:', last.emotion.value, '· 分位:', last.emotion.pct_rank + '%');
  console.log('  备份: data.backup-pre-industry.json');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
