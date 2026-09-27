// fetch-board-year.js — 板块每日涨跌幅排行「一年回填」
// 数据源: 同花顺行业指数(881xxx) 按年日线接口 d.10jqka.com.cn/v6/line/48_<code>/01/<year>.js
//   （通达信 pytdx 公共节点已退化为目录节点: 8台服务器实测 connect 正常但 K线/行情接口全空,
//     真主站 IP 需通达信客户端动态获取; 同花顺源与本盘 30 天存档口径完全一致, 功能等价切换）
// 产物: data.board_rank = { "YYYY-MM-DD": [[板块名, 涨跌幅%], ...] } 按涨跌幅降序, 约 248 个交易日
// 口径: change_pct = close/preClose-1（与交易所一致）; 30 天存档 all_days[].industry 已是同源 881xxx, 无需重算情绪
// 运行: node fetch-board-year.js
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36';
const DATA_FILE = path.join(__dirname, 'data.json');
const START_YMD = '2025-09-22'; // 一年窗口起点（含余量）
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchYearKline(code, year) {
  for (let att = 0; att < 2; att++) {
    try {
      const r = await fetch('http://d.10jqka.com.cn/v6/line/48_' + code + '/01/' + year + '.js', {
        headers: { 'User-Agent': UA, Referer: 'https://q.10jqka.com.cn/' }
      });
      const t = await r.text();
      const s = t.slice(t.indexOf('(') + 1, t.lastIndexOf(')'));
      const obj = JSON.parse(s);
      const rows = (obj.data || '').split(';').filter(Boolean).map(l => l.split(','));
      if (rows.length) return rows.map(r2 => [r2[0], +r2[4]]); // [YYYYMMDD, close]
    } catch (e) { await sleep(500); }
  }
  return null;
}

(async () => {
  const D = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

  // ── 1. 板块列表（与 fetch-industry.js 同源）──
  const listRes = await fetch('https://q.10jqka.com.cn/thshy/', { headers: { 'User-Agent': UA } });
  const html = new TextDecoder('gbk').decode(await listRes.arrayBuffer());
  const re = /thshy\/detail\/code\/(88\d{4})\/" target="_blank">([^<]+)</g;
  let m; const boards = []; const seen = new Set();
  while ((m = re.exec(html))) {
    if (!seen.has(m[1])) { seen.add(m[1]); boards.push({ code: m[1], name: m[2].trim() }); }
  }
  if (boards.length < 50) { console.error('板块列表异常:', boards.length); process.exit(1); }
  console.log('行业板块:', boards.length, '个');

  // ── 2. 每板块拉 2025 + 2026 年日线（串行限速）──
  // kline[code] = [[YYYYMMDD, close], ...] 升序合并两年
  const kline = new Map(); let fail = 0;
  for (let i = 0; i < boards.length; i++) {
    const { code } = boards[i];
    const a = await fetchYearKline(code, '2025');
    await sleep(120);
    const b = await fetchYearKline(code, '2026');
    await sleep(120);
    if (!a && !b) { fail++; console.log('  ✗ 失败:', code, boards[i].name); continue; }
    const merged = [...(a || []), ...(b || [])];
    kline.set(code, merged);
    if ((i + 1) % 15 === 0) console.log('  进度', i + 1, '/', boards.length, '· 累计失败', fail);
  }
  console.log('日K抓取完成:', kline.size, '成功 /', fail, '失败');
  if (kline.size < 80) { console.error('成功板块过少，中止（不写入）'); process.exit(1); }

  // ── 3. 组装 board_rank：每日全量板块排行（降序二元数组, 紧凑存储）──
  // change_pct = close/preClose-1（preClose 取前一条日K, 与交易所口径一致）
  const byDay = new Map(); // ymd -> [[name, chg], ...]
  for (const [code, rows] of kline) {
    const name = boards.find(b => b.code === code).name;
    for (let i = 1; i < rows.length; i++) {
      const dt = rows[i][0], pre = rows[i - 1][1], cur = rows[i][1];
      if (!pre || !cur) continue;
      const ymd = dt.slice(0, 4) + '-' + dt.slice(4, 6) + '-' + dt.slice(6);
      if (ymd < START_YMD) continue; // 一年窗口
      if (!byDay.has(ymd)) byDay.set(ymd, []);
      byDay.get(ymd).push([name, +(((cur / pre) - 1) * 100).toFixed(2)]);
    }
  }
  const board_rank = {};
  let daysN = 0; const breadth = [];
  for (const ymd of [...byDay.keys()].sort()) {
    const arr = byDay.get(ymd).sort((a, b) => b[1] - a[1]);
    if (arr.length < 50) continue; // 板块数异常的天跳过
    board_rank[ymd] = arr;
    daysN++;
    breadth.push([ymd, +(arr.filter(x => x[1] > 0).length / arr.length * 100).toFixed(1)]);
  }
  console.log('board_rank 覆盖:', daysN, '个交易日 ·', START_YMD, '~', Object.keys(board_rank).pop() || '-');
  if (daysN < 200) { console.error('覆盖天数不足 200, 中止（不写入）'); process.exit(1); }

  // ── 4. 校验: 与 30 天存档最后一天交叉对账（同源应高度一致）──
  const D_last = D.all_days.slice().sort((a, b) => a.trade_date < b.trade_date ? -1 : 1).pop();
  const br_last = board_rank[D_last.trade_date];
  if (br_last && D_last.industry && D_last.industry.length) {
    const diff = br_last.filter(x => x[1] > 0).length - D_last.industry.filter(x => x.change_pct > 0).length;
    console.log('交叉校验: board_rank 上涨', br_last.filter(x => x[1] > 0).length, 'vs 存档', D_last.industry.filter(x => x.change_pct > 0).length, '(差', diff + ') · 领涨', br_last[0][0], br_last[0][1] + '%', 'vs', D_last.industry[0].name, D_last.industry[0].change_pct + '%');
  }

  // ── 5. 写入 data.json（备份当前版本）──
  D.board_rank = board_rank;
  D.meta = D.meta || {};
  D.meta.dataQuality = Object.assign({}, D.meta.dataQuality, {
    boardRankSource: '同花顺行业指数 881xxx 按年日线（d.10jqka.com.cn/v6/line/48_<code>/01/<year>.js）',
    boardRankNote: '通达信 pytdx 公共节点已退化为目录节点（K线接口全空，真主站 IP 需客户端动态获取），同花顺 881xxx 与 30 天存档 industry 同源同口径，功能等价切换；change_pct=close/preClose-1；每日全量板块按涨跌幅降序',
    boardRankBackfilledAt: '2026-09-27',
    boardRankDays: daysN,
    boardRankStart: START_YMD,
    boardRankCount: kline.size
  });
  fs.copyFileSync(DATA_FILE, path.join(__dirname, 'data.backup-pre-boardyear.json'));
  fs.writeFileSync(DATA_FILE, JSON.stringify(D));
  const sz = (fs.statSync(DATA_FILE).size / 1024 / 1024).toFixed(2);
  console.log('\n回填完成:');
  console.log('  board_rank:', daysN, '天 ·', kline.size, '板块 · data.json', sz, 'MB');
  console.log('  一年广度样例: ' + breadth[0][0] + ' ' + breadth[0][1] + '% … ' + breadth[breadth.length - 1][0] + ' ' + breadth[breadth.length - 1][1] + '%');
  console.log('  备份: data.backup-pre-boardyear.json');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
