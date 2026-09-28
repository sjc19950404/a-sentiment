// fetch-daily.js — 每日数据管道 v4.4：抓取 → 组装 → 追加存档 → 重算情绪 → 重建 → 发布目录
// 数据源（全部已于 2026-09-27 对齐验证）:
//   1. 东财龙虎榜 datacenter-web.eastmoney.com RPT_DAILYBILLBOARD_DETAILSNEW（81 条全对齐, 元→万 ÷1e4）
//   2. 同花顺强势股 zx.10jqka.com.cn/event/api/getharden（51/51 全对齐, reason=题材"+"串）
//   3. 同花顺行业指数 881xxx 日K（fetch-industry/fetch-board-year 同源, 90 板块）
//   4. 腾讯指数 qt.gtimg.cn（indexes 三大指数涨跌幅）
//   5. 东财涨停/炸板/跌停池 push2ex getTopic{ZT,ZB,DT}Pool（须带 sort 与 date=YYYYMMDD; 历史保留约3周; ZT池 lbc=连板数, DT池 fba=封单金额/amount=成交额/days=连续跌停）
//   6. 同花顺大盘日K zs_1A0001(沪)+zs_399001(深) 第7列=成交额(元) → 两市总额（全年可回填）
// v4.4 新增字段（2026-09-27）: summary.zt_lb{代码→连板数}; hs_lb3_count=昨日连板≥3高位股家数;
//   hs_dt_count/hs_dt_fund/hs_dt_amt=高位股今日跌停家数/封单合计亿/成交额合计亿（区分良性换手 vs 高位崩盘; 相邻两日池齐全才可算, 池保留约3周）
// 情绪公式 v4.3 七因子（2026-09-27 起; 旧 4 因子 35/25/25/15 已退役）:
//   s_net=clamp(净买亿*2+50,0,100)  [权20]   s_pos=净买家数比%  [权10]
//   s_brd=上涨板块占比%  [权20]              s_hot=clamp((只数-20)/60*100,0,100)  [权10]
//   s_zdt=clamp((涨停+2)/(涨停+跌停+4)*100,0,100)  [权15]
//   s_zbl=clamp(100-炸板率%*2,0,100), 炸板率=炸板/(炸板+收盘涨停)*100  [权10]
//   s_amt=clamp(两市额/前20日均额*50,0,100)  [权15]
//   value=(s_net*20+s_pos*10+s_brd*20+s_hot*10+s_zdt*15+s_zbl*10+s_amt*15)/100
//   pct_rank = rank(value)/(n-1)*100（全档重算）
//   缺维容错: 池数据超保留深度或额缺失时对应 s 用中性 50 补位（summary 记 _missing）
// 用法:
//   node fetch-daily.js            — 抓最近交易日并追加（幂等: 已在存档则退出）
//   node fetch-daily.js --dry      — 只抓取与组装, 不写入不构建
//   node fetch-daily.js --check=YYYY-MM-DD — 抓指定日与存档 diff（对齐验证 + 新公式重算对照）
//   node fetch-daily.js --backfill — v4.3 一次性: 30 天存档回填池/额并全档重算（详见 backfill 分支）
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36';
const DATA_FILE = path.join(__dirname, 'data.json');
const PUB_DIR = process.env.SENT_SITE_DIR || 'C:\\Users\\Administrator\\WorkBuddy\\sentiment-dashboard-site';
const TASK_PUBLIC = path.join(__dirname, '..', 'task-manager', 'public', 'sentiment.html');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const BACKFILL = args.includes('--backfill');
const REDO = args.includes('--redo'); // v4.8.10: 重新抓取最近交易日并替换已存档数据（修复坏数据/补容错字段）
const CHECK = (args.find(a => a.startsWith('--check=')) || '').split('=')[1];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = v => Math.round(v * 100) / 100;
const r1 = v => Math.round(v * 10) / 10;

// ── v4.9 通用重试退避: 覆盖裸请求源（龙虎榜/池）。getharden/指数/行业日K 已有内建重试 ──
async function withRetry(fn, tries = 3, backoff = 800) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { err = e; if (i < tries - 1) await sleep(backoff * (i + 1)); }
  }
  throw err;
}

// ── 源1: 同花顺强势股（兼交易日探测: data[0].date 即最近交易日）──
async function fetchHot() {
  for (let att = 0; att < 3; att++) {
    try {
      const r = await fetch('https://zx.10jqka.com.cn/event/api/getharden', { headers: { 'User-Agent': UA, Referer: 'https://zx.10jqka.com.cn/' } });
      const j = await r.json();
      if (j.errocode === 0 && Array.isArray(j.data) && j.data.length) return j.data;
    } catch (e) { await sleep(800); }
  }
  throw new Error('getharden 强势股接口连续失败');
}

// ── 源2: 东财龙虎榜（分页全量）──
// v4.8.9: 区分「当日榜单未公布」与「接口故障」——前者抛 LhbNotPublishedError（主流程优雅退出 exit 0），
// 后者抛普通 Error（真故障，exit 1 触发告警）。根因：强势股接口盘中即有当日数据，龙虎榜要收盘后
// 约 17:00-18:00 才出，若管道在公布前运行（定时提前抖动 / 手动 dispatch），旧逻辑会 FATAL exit 1。
class LhbNotPublishedError extends Error {
  constructor(date) { super('龙虎榜未公布: ' + date); this.name = 'LhbNotPublishedError'; this.date = date; }
}
async function fetchLhb(date) {
  const out = []; let page = 1;
  while (page <= 5) {
    const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?pageSize=200&pageNumber=' + page +
      '&reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=ALL&filter=(TRADE_DATE%3D%27' + date + '%27)';
    // v4.9: 页内 3 次重试退避（注: LhbNotPublishedError 语义=未公布, JSON 解析成功才会抛, 不受重试影响）
    const j = await withRetry(async () => {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/' } });
      return r.json();
    });
    // 未公布特征: success=false 且无 result（东财对无数据日期返回 success:false）——仅第 1 页判定
    if (!j.success || !j.result) {
      if (page === 1 && !j.result) throw new LhbNotPublishedError(date);
      throw new Error('龙虎榜接口失败: ' + (j.message || 'empty'));
    }
    out.push(...j.result.data);
    if (out.length >= j.result.count) break;
    page++; await sleep(300);
  }
  return out;
}

// ── 源3: 881xxx 行业日K（当日涨跌幅; 复用 fetch-board-year 逻辑）──
async function fetchBoards(date) {
  const listRes = await fetch('https://q.10jqka.com.cn/thshy/', { headers: { 'User-Agent': UA } });
  const html = new TextDecoder('gbk').decode(await listRes.arrayBuffer());
  const re = /thshy\/detail\/code\/(88\d{4})\/" target="_blank">([^<]+)</g;
  let m; const boards = []; const seen = new Set();
  while ((m = re.exec(html))) if (!seen.has(m[1])) { seen.add(m[1]); boards.push({ code: m[1], name: m[2].trim() }); }
  if (boards.length < 50) throw new Error('板块列表异常: ' + boards.length);
  const ymdNum = date.replace(/-/g, '');
  const year = date.slice(0, 4);
  const rows = []; let fail = 0;
  for (let i = 0; i < boards.length; i++) {
    const { code, name } = boards[i];
    let got = null;
    for (let att = 0; att < 2 && !got; att++) {
      try {
        const r = await fetch('http://d.10jqka.com.cn/v6/line/48_' + code + '/01/' + year + '.js', { headers: { 'User-Agent': UA, Referer: 'https://q.10jqka.com.cn/' } });
        const t = await r.text();
        const s = t.slice(t.indexOf('(') + 1, t.lastIndexOf(')'));
        const obj = JSON.parse(s);
        const ks = (obj.data || '').split(';').filter(Boolean).map(l => l.split(','));
        const idx = ks.findIndex(k => k[0] === ymdNum);
        if (idx > 0) got = { close: +ks[idx][4], pre: +ks[idx - 1][4] };
        else if (idx === 0) got = null; // 年首无前收, 跳过
      } catch (e) { await sleep(500); }
    }
    if (got && got.close && got.pre) rows.push({ name, change_pct: r2((got.close / got.pre - 1) * 100) });
    else { fail++; }
    await sleep(110);
  }
  if (rows.length < 50) throw new Error('行业日K 成功过少: ' + rows.length + '/' + boards.length + '（失败 ' + fail + '）');
  return rows.sort((a, b) => b.change_pct - a.change_pct);
}

// ── 源4: 腾讯三大指数（当日涨跌幅；v4.8.10 加 3 次重试——18:30 管道实测偶发网络抖动置 null）──
async function fetchIndexes(date) {
  for (let att = 0; att < 3; att++) {
    try {
      const r = await fetch('https://qt.gtimg.cn/q=sh000001,sz399001,sz399006', { headers: { 'User-Agent': UA } });
      const txt = new TextDecoder('gbk').decode(await r.arrayBuffer());
      const idx = {}; let ok = false;
      for (const m of txt.matchAll(/v_(sh|sz)\d+="([^"]*)"/g)) {
        const f = m[2].split('~');
        const name = f[1], dateField = (f[30] || '').replace(/\//g, '-'); // YY/MM/DD → 不匹配即跳过
        // v4.8.10: 腾讯已把 f[30] 从 8 位日期改为 14 位时间戳（20260928161401），兼容两种格式取前 8 位
        const ymdNum = (f[30] || '').replace(/\D/g, '');
        const ymd = ymdNum.length >= 8 ? ymdNum.slice(0, 4) + '-' + ymdNum.slice(4, 6) + '-' + ymdNum.slice(6, 8) : '';
        if (!ymd || ymd !== date) continue; // 非当日（盘前/异常）不写入
        const chg = parseFloat(f[32]);
        if (!isNaN(chg)) { idx[name] = r2(chg); ok = true; }
      }
      if (ok) return idx;
    } catch (e) { /* 重试 */ }
    await sleep(600);
  }
  return null;
}

// ── v4.8.10: 强势股行情补全（腾讯 qt.gtimg 批量，60只/批）──
// getharden 接口自 2026-09-28 起不再返回 close/zhangfu/huanshou（实测仅 id/name/code/reason/date/market 六字段），
// 管道原 x.zhangfu||0 会把 0 直接入档 → 页面题材热度/强度榜均涨幅·均换手全为 0。
// 修复：行情三字段改由腾讯批量拉取直接覆盖（腾讯为权威源，接口字段若恢复也不回退）。
// 字段位（GB18030 文本 ~ 分隔）: f3=现价 f4=昨收 f32=涨跌幅% f38=换手率%
async function fetchHotQuotes(codes) {
  const out = {}; // code → {close, change_pct, huanshou}
  const sym = c => /^6/.test(c) ? 'sh' + c : (/^[03]/.test(c) ? 'sz' + c : null); // 分片库/行情同覆盖面：沪深，北交所跳过
  for (let i = 0; i < codes.length; i += 60) {
    const batch = codes.slice(i, i + 60).map(sym).filter(Boolean);
    if (!batch.length) continue;
    try {
      const r = await fetch('https://qt.gtimg.cn/q=' + batch.join(','), { headers: { 'User-Agent': UA } });
      const txt = new TextDecoder('gbk').decode(await r.arrayBuffer());
      for (const m of txt.matchAll(/v_(?:sh|sz|bj)(\d{6})="([^"]*)"/g)) {
        const f = m[2].split('~');
        const close = parseFloat(f[3]), pre = parseFloat(f[4]), chg = parseFloat(f[32]), hs = parseFloat(f[38]);
        if (isNaN(close) || close <= 0) continue;
        out[m[1]] = {
          close,
          change_pct: !isNaN(chg) ? chg : (pre > 0 ? r2((close / pre - 1) * 100) : 0),
          huanshou: isNaN(hs) ? 0 : hs
        };
      }
    } catch (e) { /* 单批失败容错，下一批继续 */ }
    await sleep(300);
  }
  return out;
}
async function enrichHotQuotes(hotRaw) {
  const codes = [...new Set(hotRaw.map(x => x.code).filter(Boolean))];
  let qm = {};
  try { qm = await fetchHotQuotes(codes); } catch (e) { return { hit: 0, total: codes.length }; }
  let hit = 0;
  hotRaw.forEach(x => {
    const q = qm[x.code];
    if (q) { hit++; x.close = q.close; x.zhangfu = q.change_pct; x.huanshou = q.huanshou; } // 直接覆盖
  });
  return { hit, total: codes.length };
}

// ── v4.9: 两市额代理源（腾讯指数成交额 f[37]）──
// 东财 amountMap 缺失当日时, 用上证+深成 f[37]（万元）合计 = 两市总额, 口径一致。
// 目标: s_amt 尽量不落入中性 50 空转（summary._missing 标「amount代理」供前端展示可信度）。
async function fetchIdxAmount() {
  for (let att = 0; att < 3; att++) {
    try {
      const r = await fetch('https://qt.gtimg.cn/q=sh000001,sz399001', { headers: { 'User-Agent': UA } });
      const txt = new TextDecoder('gbk').decode(await r.arrayBuffer());
      let sum = 0, ok = false;
      for (const m of txt.matchAll(/v_(?:sh|sz)\d+="([^"]*)"/g)) {
        const f = m[1].split('~');
        const v = parseFloat(f[37]);
        if (f.length > 37 && isFinite(v) && v > 0) { sum += v; ok = true; }
      }
      if (ok) return r1(sum / 1e4); // 万元 → 亿
    } catch (e) { /* 重试 */ }
    await sleep(600);
  }
  return null;
}

// ── 源5: 东财涨停/炸板/跌停池（须带 sort; date 支持历史但保留约 3 周）──
async function fetchPools(date) {
  const ymd = date.replace(/-/g, '');
  const base = 'ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500';
  const apis = [
    ['getTopicZTPool', 'zt', 'fbt%3Aasc'],
    ['getTopicZBPool', 'zb', 'fbt%3Aasc'],
    ['getTopicDTPool', 'dt', 'fund%3Aasc']
  ];
  const out = { zt: null, zb: null, dt: null, max_lb: null, lb2: null, zt_codes: null, zt_lb: null, dt_detail: null };
  let any = false;
  for (const [api, key, sort] of apis) {
    try {
      const j = await withRetry(async () => {
        const r = await fetch('https://push2ex.eastmoney.com/' + api + '?' + base + '&sort=' + sort + '&date=' + ymd,
          { headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' } });
        return r.json();
      }, 2, 600); // v4.9: 池接口 2 次重试
      const pool = j && j.data && Array.isArray(j.data.pool) ? j.data.pool : null;
      if (pool && pool.length) { out[key] = pool.length; any = true; }
      else out[key] = (pool ? 0 : null);
      if (api === 'getTopicZTPool' && pool && pool.length) {
        out.max_lb = Math.max(...pool.map(p => p.lbc || 1));
        out.lb2 = pool.filter(p => (p.lbc || 1) >= 2).length;
        out.zt_codes = pool.map(p => p.c); // 涨停成员入档（断板统计基础）
        out.zt_lb = {}; pool.forEach(p => { out.zt_lb[p.c] = p.lbc || 1; }); // 代码→连板数映射（v4.4 高位股判定基础）
      }
      if (api === 'getTopicDTPool' && pool) {
        out.dt_detail = pool.map(p => ({ c: p.c, fba: p.fba || 0, amount: p.amount || 0, days: p.days || 0 })); // fba=封单金额(元)·amount=成交额(元)·days=连续跌停
      }
      if (api === 'getTopicZBPool' && pool) {
        out.zb_detail = pool.map(p => ({ c: p.c, amount: p.amount || 0 })); // v4.5 炸板金额基础（成交额元）
      }
    } catch (e) { /* 单池失败保持 null */ }
    await sleep(400);
  }
  return any ? out : null; // 全空 = 超保留深度
}

// ── 源7: 同花顺昨日涨停指数 883994（打板赚钱效应: 当日涨跌幅=昨日涨停组合今日表现）──
async function fetchYztMap() {
  const map = {}; // ymdNum → 当日涨跌幅%（close/preClose−1）
  const closes = {}; // ymdNum → close（跨年 preClose 用）
  const years = [2025, 2026];
  const rowsAll = [];
  for (const year of years) {
    try {
      const r = await fetch('https://d.10jqka.com.cn/v6/line/48_883994/01/' + year + '.js',
        { headers: { 'User-Agent': UA, Referer: 'https://q.10jqka.com.cn/' } });
      const t = await r.text();
      const obj = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
      (obj.data || '').split(';').filter(Boolean).forEach(l => rowsAll.push(l.split(',')));
    } catch (e) { /* 单年失败容错 */ }
    await sleep(300);
  }
  for (let i = 1; i < rowsAll.length; i++) {
    const k = rowsAll[i], p = rowsAll[i - 1];
    if (k.length >= 5 && +k[4] > 0 && +p[4] > 0) map[k[0]] = r2((+k[4] / +p[4] - 1) * 100);
  }
  return Object.keys(map).length ? map : null;
}

// ── 源6: 同花顺大盘日K → 两市成交额 Map（YYYYMMDD → 亿; 拉 2025+2026 两年防跨年 MA20 缺口）──
async function fetchAmountMap() {
  const map = {};
  const years = [2025, 2026];
  const okParts = [];
  for (const code of ['zs_1A0001', 'zs_399001']) {   // c[6]=单市成交额(元)——两市总额必须沪深两段相加
    for (const year of years) {
      try {
        const obj = await withRetry(async () => {
          const r = await fetch('https://d.10jqka.com.cn/v6/line/' + code + '/01/' + year + '.js',
            { headers: { 'User-Agent': UA, Referer: 'https://q.10jqka.com.cn/' } });
          const t = await r.text();
          return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
        }, 3, 1000);
        (obj.data || '').split(';').filter(Boolean).forEach(l => {
          const c = l.split(',');
          if (c.length >= 7 && +c[6] > 0) map[c[0]] = (map[c[0]] || 0) + (+c[6]) / 1e8; // 元 → 亿
        });
        okParts.push(code + '/' + year);
      } catch (e) { console.error('  成交额年K失败: ' + code + '/' + year + ' — ' + e.message); }
      await sleep(300);
    }
  }
  // v4.9: 缺段拒绝入库——单市口径会腰斩两市总额（2026-09-28 实锤: 深成指年K瞬断被静默吞 → 全 Map 腰斩,
  // 9/28 额 17028→8045 亿、s_amt 虚高）, 宁可管道失败告警也不入错数
  if (okParts.length < 4) { console.error('FATAL: 成交额年K缺段（仅 ' + okParts.join(',') + '）——单市口径会腰斩总额, 拒绝入库'); return null; }
  if (!Object.keys(map).length) return null;
  return map;
}

// ── 源8: 东财两融历史（v4.5; T+1 披露 → 最新一日可能缺; RZJME=融资净买入(元) RZYE=融资余额(元)）──
async function fetchRzrqMap() {
  const out = {}; let page = 1;
  while (page <= 3) {
    try {
      const r = await fetch('https://datacenter-web.eastmoney.com/api/data/v1/get?pageSize=500&pageNumber=' + page +
        '&reportName=RPTA_RZRQ_LSHJ&columns=ALL&sortColumns=DIM_DATE&sortTypes=-1',
        { headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/' } });
      const j = await r.json();
      const rows = j && j.result && Array.isArray(j.result.data) ? j.result.data : null;
      if (!rows || !rows.length) break;
      rows.forEach(x => {
        const d = (x.DIM_DATE || '').slice(0, 10);
        if (d && x.RZYE != null) out[d] = { jme: r2((x.RZJME || 0) / 1e8), ye: r1(x.RZYE / 1e8) };
      });
      if (rows.length < 500) break;
      page++; await sleep(300);
    } catch (e) { break; }
  }
  return Object.keys(out).length ? out : null;
}

// ── v4.9.1 题材降噪（融合 normalize_themes.py 原型）──
// 原型：精确词典 CANON + 精确黑名单 + 全局孤点剔除（fit 全存档, 覆盖 ≥2 只个股才算题材）
// 本版在原型之上保留 v4.9 的正则家族/动词黑名单作兜底（泛化词典未收录的新变体, 如明日新「XX国资」）
// 1) 精确词典: 表面变体 → 标准题材（原型 CANON 全量移植, 种子可增量维护）
const TOPIC_CANON = {
  '上海国资':'国企改革','广州国资':'国企改革','广州国资入主':'国企改革','深圳国资':'国企改革','福建国资':'国企改革','珠海国资':'国企改革','黑龙江国资':'国企改革','国资背景':'国企改革','国企':'国企改革','国企背景':'国企改革','国资':'国企改革','央企':'国企改革',
  '控股变更':'并购重组','控制权变更':'并购重组','控制权拟变更':'并购重组','控股股东拟变更':'并购重组','资产重组':'并购重组','重大资产重组':'并购重组','拟收购':'并购重组','股份转让':'并购重组','股权转让':'并购重组','溢价转让':'并购重组','协议转让':'并购重组','定增审核':'并购重组','大股东增持':'并购重组',
  'AI应用':'AI算力','AI应用出海':'AI算力','AI终端':'AI算力','AI服务器':'AI算力','AI服务器电源':'AI算力','AI算力':'AI算力','AI文旅':'AI算力','智算云':'AI算力','算力':'AI算力','算力硬件':'AI算力','算力租赁':'AI算力','算力基础设施':'AI算力','垂直大模型':'AI算力','智谱AI':'AI算力','政务智能体':'AI算力','政务数字化':'AI算力',
  '文化传媒':'文化传媒','图书发行':'文化传媒','教科书发行':'文化传媒','数字教育':'文化传媒','广电网络':'文化传媒','杭州日报':'文化传媒','影视制作':'文化传媒','视听大数据':'文化传媒','视听安全':'文化传媒','媒体内容安全监测':'文化传媒','出版发行':'文化传媒',
  '创新药':'医药','AI医疗':'医药','中药大健康':'医药','独家中药':'医药','化学制药':'医药','医疗器械':'医药','体外诊断':'医药','基因检测':'医药','医药数字化':'医药','医药流通':'医药','药品注册':'医药','解热镇痛':'医药','呼吸用药':'医药','皮肤科学':'医药','阿尔茨海默病':'医药','三代测序':'医药','健康机器人':'医药',
  'PCB':'PCB','PCB概念':'PCB','PCB刀具':'PCB','PCB用化学试剂':'PCB','PCB设备':'PCB','PCB铜箔':'PCB','高端PCB':'PCB','高阶HDI':'PCB','HDI板':'PCB','覆铜板':'PCB','高速覆铜板':'PCB',
  '光模块':'光通信','高速光模块':'光通信','光纤光缆':'光通信','光通信':'光通信','光通信测试':'光通信','PI膜':'光通信','TAC膜':'光通信','MLCC':'光通信','MLCC离型膜':'光通信',
  '半导体':'半导体','半导体IP':'半导体','半导体硅片':'半导体','半导体设备':'半导体','半导体测试':'半导体','半导体装备':'半导体','半导体超纯水膜':'半导体','功率半导体IDM':'半导体','碳化硅衬底':'半导体','先进封装':'半导体',
  '液冷':'液冷','液冷散热':'液冷','液冷服务器':'液冷',
  '电子化学品':'电子','电子玻璃':'电子','玻璃基板':'电子','消费电子':'电子','消费电子包装':'电子','苹果供应链':'电子','存储芯片':'电子',
  '机器人':'机器人','机器人缝制':'机器人','机器人轴承':'机器人','机器人电池':'机器人','机器人线束':'机器人','机器人结构件':'机器人','七腾机器人':'机器人','水务机器人':'机器人','环卫机器人':'机器人','工业母机':'机器人','具身智能':'机器人','人形机器人':'机器人','间接投资宇树科技':'机器人',
  '固态电池':'新能源','储能':'新能源','锂电铜箔':'新能源','电池箔':'新能源','氢能汽车':'新能源','氢氟酸':'新能源','清洁能源':'新能源','海上风电':'新能源','风电铸件':'新能源','风电轴承':'新能源','风电齿轮箱':'新能源','风电设备':'新能源',
  '智能驾驶':'智能网','车联网':'智能网','车路云':'智能网','智能电网':'智能网','智能输配电':'智能网','智能配电':'智能网','V2G':'智能网','特高压':'智能网','虚拟电厂':'智能网',
  '商业航天':'商业航天','卫星智算':'商业航天','低空经济':'低空经济',
  '业绩增长':'业绩线','净利增长':'业绩线','业绩扭亏':'业绩线','半年报增长':'业绩线','半年报减亏':'业绩线','中报增长':'业绩线','中报扭亏':'业绩线','扭亏为盈':'业绩线','净利润增长':'业绩线',
  'AI安全':'网络安全','网络安全':'网络安全','网络靶场':'网络安全','数据安全':'网络安全','数据标注':'网络安全','数字风洞':'网络安全',
};
// 2) 精确黑名单: 单票专属诱因 / 不可投资题材（原型 BLACKLIST 全量移植）
const TOPIC_BLACKLIST = new Set(['拟收购界面财联社','拟收购民族出版社','教科书发行','图书发行','杭州日报','参股神州龙芯（CPU）','参股CPU','一汽配套','索具龙头','深海系泊','炭黑龙头','炭黑涨价','高端黄酒','黄酒主业','针织服装','鸭业全产业链','羽绒出口','贴牌加工','服装贴牌','家电复材','模切业务','导热凝胶','电容配件','铝板带','锡锑铟','铁路扣件合同','矿业整合','硅砂矿','矿山服务','盐湖提锂','玉米种业','安赛蜜','精细化工','食品饲料添加剂','高纯四氯化硅','功能性硅烷','日用陶瓷','日用陶瓷出口','纺织主业','纺织印染','绿色低碳','绿色印染','造纸化学品','聚酯薄膜','膜分离','航空零部件','精密制造','高端部件','易开盖','烟标印刷','热电联产','特种电缆','电线电缆','电力服务','电力水电','生态水利','生活用纸','客户资源','客户拓展','订单充足','订单增长','产能扩张','产能满产','大兆瓦装备','大尺寸拓展','多元化布局','行业龙头','华字辈','兰亭','哪吒重整','安哥拉电解铝','客车销量','导电炭黑','岩土固化','岩土固化剂','环卫自动驾驶','环卫装备','海南自贸港','游船票务','溢价转让','协议转让','苹果供应链','视听大数据','视听安全','媒体内容安全监测']);
// 3) 正则家族兜底（v4.9）: 词典未命中时泛化归一
const TOPIC_FAMILIES = [
  [/央企|中国电子|中国电科|中船|航天科工|兵器|核工业/, '央企改革'],
  [/国资|国企|国有/, '国企改革'],
  [/拟收购|收购|并购|资产重组|重组|控股变更|控股股东变更|实控人变更|实际控制人变更|控制权变更|借壳|要约/, '并购重组'],
];
const MA_TOUCH = /收购|并购|重组|借壳|要约/; // 并购家族: 长串(≥7字)几乎必带具体公司名 → 专属诱因
const TOPIC_NOISE_RE = /拟|签署|签订|终止|解除|收到|完成|中标|竞得|摘牌|摘得|获批|获得|通过|回复|问询|立案|处罚|警示|监管|增持|减持|回购|质押|解禁|分红|派息|转增|重整|破产|清算|预盈|预亏|预增|预减|更名|改名|退市|戴帽|摘帽|ST|举牌|定增|配股|增发|发行|变更|设立|募资/;
const MIN_TOPIC_STOCKS_GLOBAL = 2; // 全局孤点阈值: 覆盖 <2 只个股的题材=噪声（v4.9.1 由「当日阈值」升级为「全局孤点剔除」）

function normalizeTopicTag(t) {
  if (TOPIC_BLACKLIST.has(t)) return null;              // 精确黑名单优先（原型口径）
  if (Object.prototype.hasOwnProperty.call(TOPIC_CANON, t)) return TOPIC_CANON[t]; // 精确词典
  for (const [re, std] of TOPIC_FAMILIES) {             // 正则家族兜底（泛化新变体）
    if (re.test(t)) {
      if (std === '并购重组' && MA_TOUCH.test(t) && t.length >= 7) return null; // 带专名的专属串
      return std;
    }
  }
  if (TOPIC_NOISE_RE.test(t)) return null;              // 动词黑名单兜底（新事件词）
  return t;                                             // 原样保留
}
// 全局孤点剔除（原型 fit 等价）: 扫全部 hot 归一后统计题材覆盖个股数, ≥minGlobal 才有效
function computeValidThemes(hotLists) {
  const cover = new Map();
  hotLists.forEach(hot => (hot || []).forEach(h => {
    const tokens = [...new Set((h.reason || '').split(/[+＋]/).map(w => w.trim()).filter(Boolean))];
    tokens.map(normalizeTopicTag).filter(Boolean).forEach(t => {
      if (!cover.has(t)) cover.set(t, new Set());
      cover.get(t).add(h.code);
    });
  }));
  const valid = new Set();
  cover.forEach((codes, t) => { if (codes.size >= MIN_TOPIC_STOCKS_GLOBAL) valid.add(t); });
  return valid;
}
// buildTopics: validThemes 传入=全局孤点口径（当日不限票数）; 不传=当日 ≥2 兜底
function buildTopics(hot, validThemes) {
  const vote = new Map(); // 标准题材 → Set(个股 code)
  hot.forEach(h => {
    const tokens = [...new Set((h.reason || '').split(/[+＋]/).map(w => w.trim()).filter(Boolean))];
    const stds = new Set(tokens.map(normalizeTopicTag).filter(Boolean)); // 同票同题材只投 1 票
    stds.forEach(t => { if (!vote.has(t)) vote.set(t, new Set()); vote.get(t).add(h.code); });
  });
  const list = [...vote.entries()]
    .filter(([tag, codes]) => validThemes ? validThemes.has(tag) : codes.size >= MIN_TOPIC_STOCKS_GLOBAL)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 15)
    .map(([tag, codes]) => ({ tag, count: codes.size, codes: [...codes] }));
  return { list, kinds: vote.size };
}
// 全档 topics 统一口径重算（纯内存, 与 recalcRanks 同模式）: emotion.top_topic/topic_conc/summary.topic_kinds 同步
function refreshAllTopics(D) {
  const validAll = computeValidThemes(D.all_days.map(d => d.hot || []));
  D.all_days.forEach(d => {
    if (!d.hot) return;
    const tp = buildTopics(d.hot, validAll);
    d.topics = tp.list;
    if (d.summary) d.summary.topic_kinds = tp.kinds;
    if (d.emotion) {
      d.emotion.topic_conc = r1(tp.list.length ? tp.list[0].count / ((d.hot || []).length || 1) * 100 : 0);
      d.emotion.top_topic = tp.list.length ? tp.list[0].tag : '—';
    }
  });
  return validAll;
}

// ── day 组装（v4.5: +连板梯队分布/炸板金额/两融）──
function buildDay(date, lhbRaw, hotRaw, industry, indexes, pools, amountYi, amountMap, yztMap, prevZtCodes, prevZtLb, rzrqMap) {
  const lhb = lhbRaw.map(x => ({
    code: x.SECURITY_CODE, name: x.SECURITY_NAME_ABBR, reason: x.EXPLANATION || '—',
    close: x.CLOSE_PRICE, change_pct: r2(x.CHANGE_RATE || 0),
    net_buy_wan: r1((x.BILLBOARD_NET_AMT || 0) / 1e4),
    buy_wan: r1((x.BILLBOARD_BUY_AMT || 0) / 1e4),
    sell_wan: r1((x.BILLBOARD_SELL_AMT || 0) / 1e4),
    turnover_pct: r2(x.TURNOVERRATE || 0)
  })).sort((a, b) => b.net_buy_wan - a.net_buy_wan);

  // lhb_aggr（clean-data.js 同逻辑）
  const byCode = new Map();
  for (const l of lhb) {
    if (!byCode.has(l.code)) byCode.set(l.code, { ...l, reasons: [l.reason] });
    else {
      const acc = byCode.get(l.code);
      if (!acc.reasons.includes(l.reason)) acc.reasons.push(l.reason);
      if (Math.abs(l.net_buy_wan || 0) > Math.abs(acc.net_buy_wan || 0)) { acc.net_buy_wan = l.net_buy_wan; acc.buy_wan = l.buy_wan; acc.sell_wan = l.sell_wan; }
    }
  }
  const lhb_aggr = [...byCode.values()];

  const hot = hotRaw.map(x => ({ code: x.code, name: x.name, reason: x.reason || '', close: x.close, change_pct: r2(x.zhangfu || 0), huanshou: r2(x.huanshou || 0) }));
  // v4.9: 归一+个股数聚合（含 codes 供前端直用）; 旧词频口径见 git 历史
  const tp = buildTopics(hot);
  const topics = tp.list;

  // v4.9.3 净额口径修正: 按股去重求和（lhb_aggr 每股取绝对值最大榜单为代表）。
  // 旧口径按行求和会把多上榜原因股（不同榜单席位不同）重复计入——2026-09-28 行求和 -1.17 亿 vs 按股 -0.61 亿。
  const net_total_yi = r2(lhb_aggr.reduce((a, l) => a + (l.net_buy_wan || 0), 0) / 1e4);
  const net_pos = lhb_aggr.filter(l => (l.net_buy_wan || 0) > 0).length;
  const net_neg = lhb_aggr.filter(l => (l.net_buy_wan || 0) < 0).length;
  const ind_up = industry.filter(i => i.change_pct > 0).length;
  const ind_down = industry.filter(i => i.change_pct < 0).length;

  // ── 新因子: 涨跌停/炸板/成交额 ──
  const missing = [];
  const zt = pools ? pools.zt : null, dt = pools ? pools.dt : null, zb = pools ? pools.zb : null;
  if (zt == null || dt == null || zb == null) missing.push('pools');
  const zbl_pct = (zt != null && zb != null && (zb + zt) > 0) ? r1(zb / (zb + zt) * 100) : null;
  const ymdNum = date.replace(/-/g, '');
  const amount_yi = amountYi != null ? r1(amountYi) : null;
  if (amount_yi == null) missing.push('amount');
  // 前 20 日两市均额（不含当日; 从全年 Map 取）
  const histAmts = amountMap ? Object.keys(amountMap).filter(k => k < ymdNum && amountMap[k] > 0).sort().slice(-20) : [];
  const amt_ma = histAmts.length >= 10 ? histAmts.reduce((a, k) => a + amountMap[k], 0) / histAmts.length : null;
  // 昨日涨停指数（打板赚钱效应）+ 断板家数（昨日涨停今日未涨停）
  const yzt_chg = yztMap ? (yztMap[ymdNum] != null ? yztMap[ymdNum] : null) : null;
  if (yzt_chg == null) missing.push('yzt');
  const todayZt = pools && pools.zt_codes ? new Set(pools.zt_codes) : null;
  const dt_band = (prevZtCodes && prevZtCodes.length && todayZt) ? prevZtCodes.filter(c => !todayZt.has(c)).length : null;

  // ── v4.4 高位股亏钱效应: 昨日连板≥3 高位股今日跌停数/封单/成交额 ──
  // 区分「良性换手」与「高位崩盘」：高位股大额封单跌停 = 风险扩散信号
  let hs_lb3_count = null, hs_dt_count = null, hs_dt_fund = null, hs_dt_amt = null;
  if (prevZtLb && pools) {
    const lb3 = Object.entries(prevZtLb).filter(([, lb]) => lb >= 3);
    if (lb3.length) {
      hs_lb3_count = lb3.length;
      const dtPool = Array.isArray(pools.dt_detail) ? pools.dt_detail : null;
      if (dtPool) {
        const hit = dtPool.filter(p => lb3.some(([c]) => c === p.c));
        hs_dt_count = hit.length;
        hs_dt_fund = r1(hit.reduce((s, p) => s + (p.fba || 0), 0) / 1e8);
        hs_dt_amt = r1(hit.reduce((s, p) => s + (p.amount || 0), 0) / 1e8);
      }
    }
  }

  // ── v4.5: 连板梯队分布 / 炸板金额 / 两融 ──
  const lb_dist = (() => {
    if (!pools || !pools.zt_lb) return null;
    const dist = {};
    Object.values(pools.zt_lb).forEach(lb => { if (lb >= 2) dist[lb] = (dist[lb] || 0) + 1; });
    return dist; // {} = 有池数据但无≥2板（与 null=无池数据 区分）
  })();
  const zb_amt = (pools && Array.isArray(pools.zb_detail) && pools.zb_detail.length)
    ? r1(pools.zb_detail.reduce((s, p) => s + (p.amount || 0), 0) / 1e8)
    : (pools && pools.zb === 0 ? 0 : null); // 0=无炸板（合法）· null=池数据缺失
  const rzrq = rzrqMap ? (rzrqMap[date] || null) : null; // T+1 披露, 最新一日可能缺

  // ── 七因子 ──
  const s_net = clamp(r1(net_total_yi * 2 + 50), 0, 100);
  const s_pos = r1(net_pos / (net_pos + net_neg || 1) * 100);
  const up_ratio = r1(ind_up / (industry.length || 1) * 100);
  const s_hot = clamp(r1((hot.length - 20) / 60 * 100), 0, 100);
  const s_zdt = (zt != null && dt != null) ? clamp(r1((zt + 2) / (zt + dt + 4) * 100), 0, 100) : 50;
  const s_zbl = (zbl_pct != null) ? clamp(r1(100 - zbl_pct * 2), 0, 100) : 50;
  const s_amt = (amount_yi != null && amt_ma != null) ? clamp(r1(amount_yi / amt_ma * 50), 0, 100) : 50;
  const value = r1((s_net * 20 + s_pos * 10 + up_ratio * 20 + s_hot * 10 + s_zdt * 15 + s_zbl * 10 + s_amt * 15) / 100);

  const summary = {
    lhb_count: lhb.length, lhb_stocks: lhb_aggr.length,
    lhb_stocks_hs: lhb_aggr.filter(l => !/^92|^bj/.test(l.code)).length,
    net_total_yi, net_pos, net_neg,
    hot_count: hot.length, topic_kinds: tp.kinds,
    ind_count: industry.length, ind_up, ind_down, top_industry: null, bottom_industry: null,
    zt_count: zt, dt_count: dt, zb_count: zb, zbl_pct,
    max_lb: pools ? pools.max_lb : null, lb2_count: pools ? pools.lb2 : null,
    zt_codes: pools ? (pools.zt_codes || null) : null,
    zt_lb: pools ? (pools.zt_lb || null) : null,
    dt_band, yzt_chg,
    hs_lb3_count, hs_dt_count, hs_dt_fund, hs_dt_amt,
    lb_dist, zb_amt, rzrq,
    amount_yi
  };
  if (missing.length) summary._missing = missing;

  const emotion = {
    value, s_net, s_pos, s_brd: up_ratio, s_hot, s_zdt, s_zbl, s_amt,
    net_total_yi, pos_ratio: s_pos, up_ratio,
    hot_count: hot.length, topic_conc: r1(topics.length ? topics[0].count / (hot.length || 1) * 100 : 0),
    top_topic: topics.length ? topics[0].tag : '—',
    pct_rank: null, net_pct_rank: null, industryCount: industry.length
  };
  return { trade_date: date, lhb, hot, topics, industry, summary, indexes, emotion, lhb_aggr };
}

// ── 全档分位重算（pct_rank = rank/(n-1)*100）──
// v4.9.1: 分位仅用「无补位因子」的真实天数计算——中性 50 天参与分位会拉平分布、失真历史可比性;
// 补位日 pct_rank 置 null（前端显示 —）。开关 meta.dataQuality.pctRankRealOnly=true。
function recalcRanks(days) {
  const rank = (vals, v) => { const s = [...vals].sort((a, b) => a - b); return s.indexOf(v) / Math.max(s.length - 1, 1) * 100; };
  const realDays = days.filter(d => d.emotion && !((d.summary && d.summary._missing) || []).length);
  const vs = realDays.map(d => d.emotion.value), ns = realDays.map(d => d.emotion.net_total_yi);
  days.forEach(d => {
    if (!d.emotion) return;
    const miss = ((d.summary && d.summary._missing) || []).length;
    if (miss) { d.emotion.pct_rank = null; d.emotion.net_pct_rank = null; }
    else {
      d.emotion.pct_rank = r1(rank(vs, d.emotion.value));
      d.emotion.net_pct_rank = r1(rank(ns, d.emotion.net_total_yi));
    }
  });
}

// ── stocks 追加（close 直接用榜单收盘价, 零额外请求）──
function appendStocks(D, day) {
  const seen = new Map();
  day.lhb.forEach(l => seen.set(l.code, l.close));
  day.hot.forEach(h => { if (!seen.has(h.code)) seen.set(h.code, h.close); });
  for (const [code, close] of seen) {
    if (!close) continue;
    const st = D.stocks[code];
    if (st) {
      if (!st.days.includes(day.trade_date)) { st.days.push(day.trade_date); st.closes.push([day.trade_date, close]); }
      if (!st.name && day.lhb.concat(day.hot).find(x => x.code === code)) st.name = (day.lhb.find(x => x.code === code) || day.hot.find(x => x.code === code)).name;
    } else {
      const rec = day.lhb.find(x => x.code === code) || day.hot.find(x => x.code === code);
      D.stocks[code] = { name: rec.name, days: [day.trade_date], closes: [[day.trade_date, close]] };
    }
  }
}

// ── v4.5 回填: 存档全部历史日补池/额/赚钱效应/高位亏钱效应/两融并全档重算（幂等可重跑; 也可用于补洞）──
async function backfill() {
  console.log('═ v4.5 回填: 历史日涨跌停/炸板/成交额/赚钱效应/高位亏钱效应/梯队分布/炸板金额/两融 + 全档重算 ═');
  const D = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const amountMap = await fetchAmountMap();
  if (!amountMap) { console.error('成交额 Map 拉取失败, 中止'); process.exit(1); }
  console.log('成交额 Map:', Object.keys(amountMap).length, '个交易日（2025+2026）');
  const yztMap = await fetchYztMap();
  console.log('昨涨停指数 883994:', yztMap ? Object.keys(yztMap).length + ' 个交易日' : '拉取失败（yzt 中性缺失）');
  const rzrqMap = await fetchRzrqMap();
  console.log('两融历史:', rzrqMap ? Object.keys(rzrqMap).length + ' 个交易日（T+1 披露, 最新一日可能缺）' : '拉取失败（rzrq 缺失）');
  let filled = 0, missPool = 0, missAmt = 0, hasCodes = 0, hasHs = 0;
  let prevCodes = null, prevLb = null;
  for (const day of D.all_days) {
    const ymd = day.trade_date.replace(/-/g, '');
    const pools = await fetchPools(day.trade_date);
    const amountYi = amountMap[ymd] || null;
    if (pools) filled++; else missPool++;
    if (!amountYi) missAmt++;
    // 重组 summary/emotion 新字段（保留原有其余字段）
    const rebuilt = buildDay(day.trade_date,
      day.lhb.map(l => ({ SECURITY_CODE: l.code, SECURITY_NAME_ABBR: l.name, EXPLANATION: l.reason, CLOSE_PRICE: l.close, CHANGE_RATE: l.change_pct, BILLBOARD_NET_AMT: l.net_buy_wan * 1e4, BILLBOARD_BUY_AMT: l.buy_wan * 1e4, BILLBOARD_SELL_AMT: l.sell_wan * 1e4, TURNOVERRATE: l.turnover_pct })),
      day.hot.map(h => ({ code: h.code, name: h.name, reason: h.reason, close: h.close, zhangfu: h.change_pct, huanshou: h.huanshou })),
      day.industry || [], day.indexes || null, pools, amountYi, amountMap, yztMap, prevCodes, prevLb, rzrqMap);
    day.summary = rebuilt.summary;
    day.emotion = rebuilt.emotion;
    day.topics = rebuilt.topics; // v4.9: 题材归一口径全档重算（新旧算法不混图）
    if (day.summary.zt_codes) hasCodes++;
    if (day.summary.hs_dt_count != null) hasHs++;
    prevCodes = day.summary.zt_codes; // 相邻天传递 → 断板家数
    prevLb = day.summary.zt_lb;       // 相邻天传递 → 高位股亏钱效应（v4.4）
    console.log(' ', day.trade_date, '· 涨停', day.summary.zt_count == null ? '缺' : day.summary.zt_count,
      '· 断板', day.summary.dt_band == null ? '缺' : day.summary.dt_band,
      '· 赚钱效应', day.summary.yzt_chg == null ? '缺' : day.summary.yzt_chg + '%',
      '· 高位跌停', day.summary.hs_dt_count == null ? '缺' : day.summary.hs_dt_count + '(封单' + (day.summary.hs_dt_fund ?? '—') + '亿)',
      '· 炸板额', day.summary.zb_amt == null ? '缺' : day.summary.zb_amt + '亿',
      '· 两融净', day.summary.rzrq == null ? '缺' : day.summary.rzrq.jme + '亿',
      '· 额', day.summary.amount_yi == null ? '缺' : day.summary.amount_yi + '亿',
      '→ 情绪', day.emotion.value);
    await sleep(400);
  }
  refreshAllTopics(D); // v4.9.1: 全档 topics 统一口径（原型 ThemeDenoiser.fit 等价）
  recalcRanks(D.all_days);
  D.meta = D.meta || {};
  D.meta.dataQuality = Object.assign({}, D.meta.dataQuality, {
    formulaVersion: 'v4.9.3 七因子（s_net20/s_pos10/s_brd20/s_hot10/s_zdt15/s_zbl10/s_amt15）+ yzt/dt_band/hs/lb_dist/zb_amt/rzrq + 题材归一(词典+个股数+黑名单+全局孤点≥2) + pctRankRealOnly + lhb净额按股去重',
    formulaNote: 's_zdt=(涨停+2)/(涨停+跌停+4)*100; s_zbl=100-炸板率*2; s_amt=两市额/前20日均额*50; 东财池保留约3周, 更早日 s_zdt/s_zbl 中性50补位（summary._missing 标记）; yzt_chg=同花顺883994昨日涨停指数当日涨跌幅（打板赚钱效应）; dt_band=断板家数（相邻两日池齐全才可算）; hs_lb3_count=昨日连板≥3高位股家数, hs_dt_count/hs_dt_fund/hs_dt_amt=高位股今日跌停数/封单合计(亿)/成交额合计(亿); lb_dist=连板梯队分布{板级:家数}(≥2板); zb_amt=炸板股成交额合计(亿); rzrq=两融{jme:融资净买入(亿),ye:融资余额(亿)}（T+1 披露, 最新一日可能缺, 重跑 backfill 即补）; topics=题材词典归一+个股数聚合（一票一题材一票）+精确/动词黑名单+全局孤点剔除（全存档覆盖<2只个股的题材=噪声）, codes=该题材成员股代码表（前端下钻直用）; pct_rank 仅用无补位真实天数计算, 补位日 null',
    formulaChangeDate: '2026-09-28',
    pctRankRealOnly: true,
    backfilledAt: new Date().toISOString()
  });
  fs.copyFileSync(DATA_FILE, path.join(__dirname, 'data.backup-pre-v45.json'));
  // v4.9.1: 健康自检（与主流程同口径, 入 meta 供前端 S6 复核/告警）
  // 注意: 必须在 writeFileSync 之前写内存（v4.9.1 首版写盘在后, health 永不落盘——已修）
  {
    const missDays = D.all_days.filter(d => ((d.summary && d.summary._missing) || []).length).length;
    const issues = [];
    if (missDays > D.all_days.length * 0.4) issues.push('补位因子天数占比 >40%（东财池保留深度限制, 历史可比性打折）');
    D.meta.dataQuality.health = { checkedAt: new Date().toISOString(), totalDays: D.all_days.length, missingDays: missDays, issues };
    console.log('健康自检: ' + (issues.length ? '⚠ ' + issues.join(' ; ') : '✓ 无异常') + `（补位 ${missDays}/${D.all_days.length} 天）`);
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(D));
  console.log('\n回填完成: 真实池 ' + filled + ' 天 · 缺池 ' + missPool + '（中性补位） · 缺额 ' + missAmt + ' · 涨停成员 ' + hasCodes + ' 天 · 高位亏钱效应 ' + hasHs + ' 天');
  console.log('备份: data.backup-pre-v45.json · 存档 ' + D.all_days.length + ' 天已重算');
  console.log('重建 dist…');
  execSync('node build.js', { cwd: __dirname, stdio: 'inherit' });
  console.log('已同步发布目录（build.js: dist + 独立发布目录 + task-manager/public）');
}

(async () => {
  if (BACKFILL) { await backfill(); return; }
  console.log('═ SDK 每日管道启动（v4.3 七因子）═' + (DRY ? '（dry 干跑）' : '') + (CHECK ? '（check=' + CHECK + ' 对齐验证）' : '') + (REDO ? '（redo 替换重抓）' : ''));
  const hotRaw = await fetchHot();
  const apiDate = hotRaw[0].date;
  console.log('最近交易日:', apiDate, '· 强势股', hotRaw.length, '只');
  const D = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const dates = D.all_days.map(d => d.trade_date);

  // ── v4.8.10: 强势股行情补全（腾讯源·直接覆盖）——getharden 不再提供 close/zhangfu/huanshou ──
  const qEnrich = await enrichHotQuotes(hotRaw);
  console.log('  强势股行情补全（腾讯源）:', qEnrich.hit + '/' + qEnrich.total, '只');

  // ── check 模式: 指定日（须已在存档）抓取 diff ──
  if (CHECK) {
    const arch = D.all_days.find(d => d.trade_date === CHECK);
    if (!arch) { console.error('存档无 ' + CHECK + '，无法比对'); process.exit(1); }
    if (apiDate !== CHECK) console.log('⚠ API 最新交易日是 ' + apiDate + '，非 ' + CHECK + '——数据按存档日期抓取比对');
    const [lhbRaw, pools, amountMap, yztMap] = [await fetchLhb(CHECK), await fetchPools(CHECK), await fetchAmountMap(), await fetchYztMap()];
    const amountYi = pools ? (amountMap ? (amountMap[CHECK.replace(/-/g, '')] || null) : null) : null;
    const ci = D.all_days.findIndex(d => d.trade_date === CHECK);
    const prevZtCodes = ci > 0 ? (D.all_days[ci - 1].summary.zt_codes || null) : null;
    const prevZtLb = ci > 0 ? (D.all_days[ci - 1].summary.zt_lb || null) : null;
    // check 模式两融传 null（不参与对齐比对）
    const lhbNew = buildDay(CHECK, lhbRaw, hotRaw, arch.industry || [], null, pools, amountYi, amountMap, yztMap, prevZtCodes, prevZtLb, null);
    const diffL = lhbNew.lhb.filter(n => { const o = arch.lhb.find(l => l.code === n.code && l.reason === n.reason); return !o || Math.abs(o.net_buy_wan - n.net_buy_wan) > 0.01; });
    const diffH = lhbNew.hot.filter(n => { const o = arch.hot.find(l => l.code === n.code); return !o || Math.abs(o.close - n.close) > 0.001; });
    console.log('对齐验证 · 龙虎榜: 抓', lhbNew.lhb.length, 'vs 存', arch.lhb.length, '· 差异', diffL.length, diffL.slice(0, 3));
    console.log('对齐验证 · 强势股: 抓', lhbNew.hot.length, 'vs 存', arch.hot.length, '· 差异', diffH.length, diffH.slice(0, 3));
    console.log('对齐验证 · 净买: 抓', lhbNew.summary.net_total_yi, 'vs 存', arch.summary.net_total_yi);
    console.log('新因子 · 池:', pools ? JSON.stringify(pools) : '超保留深度', '· 两市额:', amountYi ? r1(amountYi) + '亿' : '缺');
    if (arch.summary.zt_count != null) console.log('新因子对照 · 存档: 涨停', arch.summary.zt_count, '炸板', arch.summary.zb_count, '· 抓取: 涨停', lhbNew.summary.zt_count, '炸板', lhbNew.summary.zb_count);
    console.log('情绪对照 · 存档（回填后公式）:', arch.emotion.value, '· 现抓重算:', lhbNew.emotion.value);
    console.log(CHECK === apiDate ? '结论: 原始数据 ' + (diffL.length + diffH.length === 0 ? '✓ 对齐通过' : '✗ 有差异!') : '结论: 非同日, 仅参考');
    return;
  }

  // ── 幂等: 已是最新（redo 模式豁免——重新抓取并替换当日）──
  if (dates.includes(apiDate) && !REDO) { console.log('✓ ' + apiDate + ' 已在存档（共 ' + dates.length + ' 天），无新交易日，退出'); return; }
  if (REDO && !dates.includes(apiDate)) console.log('⚠ --redo 但 ' + apiDate + ' 不在档，按普通新增执行');

  // ── 抓取其余源 ──
  console.log('抓取龙虎榜…');
  let lhbRaw;
  try {
    lhbRaw = await fetchLhb(apiDate);
  } catch (e) {
    if (e instanceof LhbNotPublishedError) {
      // 龙虎榜尚未公布（收盘后约 17:00-18:00 才有）——非交易日 or 管道跑得太早。
      // 优雅退出：exit 0 + 输出「无新交易日」让 workflow 门控判定 updated=false，跳过构建发布不空转。
      console.log('✓ ' + apiDate + ' 龙虎榜尚未公布（东财收盘后约 17:00-18:00 发布）· 无新交易日，退出');
      return;
    }
    throw e;
  }
  if (!lhbRaw.length) { console.log('✓ ' + apiDate + ' 龙虎榜为空 · 无新交易日，退出'); return; }
  console.log('  龙虎榜', lhbRaw.length, '条');
  console.log('抓取行业日K（90 板块 × 当日, 约 12s）…');
  const industry = await fetchBoards(apiDate);
  console.log('  行业', industry.length, '个 · 领涨', industry[0].name, industry[0].change_pct + '% · 领跌', industry[industry.length - 1].name, industry[industry.length - 1].change_pct + '%');
  const indexes = await fetchIndexes(apiDate);
  console.log('  指数:', indexes ? JSON.stringify(indexes) : '（不可用, 置空容错）');
  console.log('抓取涨跌停/炸板池 + 两市成交额 + 昨涨停指数…');
  const pools = await fetchPools(apiDate);
  const amountMap = await fetchAmountMap();
  const yztMap = await fetchYztMap();
  console.log('抓取两融历史（T+1 披露）…');
  const rzrqMap = await fetchRzrqMap();
  let amountYi = amountMap ? (amountMap[apiDate.replace(/-/g, '')] || null) : null;
  // v4.9: 两市额主源缺失 → 腾讯指数成交额代理（防 s_amt 中性 50 空转; 入档标「amount代理」）
  let amountProxy = false;
  if (amountYi == null) {
    const proxy = await fetchIdxAmount();
    if (proxy != null) { amountYi = proxy; amountProxy = true; console.log('  两市额主源缺失 → 指数成交额代理 ' + proxy + ' 亿'); }
  }
  // v4.8.10: redo 替换模式下「前一交易日」须取目标日之前的存档——最后一项就是目标日自己，
  // 自我对比会把 dt_band（断板数）错算成 0
  const tgtIdx = dates.indexOf(apiDate);
  const lastDay = (REDO && tgtIdx > 0) ? D.all_days[tgtIdx - 1] : D.all_days[D.all_days.length - 1];
  const prevZtCodes = (lastDay && lastDay.summary) ? (lastDay.summary.zt_codes || null) : null;
  const prevZtLb = (lastDay && lastDay.summary) ? (lastDay.summary.zt_lb || null) : null;
  console.log('  池:', pools ? ('涨停 ' + pools.zt + ' · 炸板 ' + pools.zb + ' · 跌停 ' + pools.dt + ' · 最高连板 ' + pools.max_lb) : '超保留深度（中性补位）',
    '· 两市额:', amountYi ? r1(amountYi) + '亿' : '缺',
    '· 昨涨停效应:', yztMap && yztMap[apiDate.replace(/-/g, '')] != null ? yztMap[apiDate.replace(/-/g, '')] + '%' : '缺');

  const day = buildDay(apiDate, lhbRaw, hotRaw, industry, indexes, pools, amountYi, amountMap, yztMap, prevZtCodes, prevZtLb, rzrqMap);
  // v4.9: 代理成功时 amountYi 非 null, _missing 里不会有 'amount'; 显式补标供前端展示「X/7 因子补位」
  if (amountProxy && day.summary) (day.summary._missing = day.summary._missing || []).push('amount代理');
  if (!day.lhb.length || !day.hot.length) { console.error('当日数据异常（空榜）——可能非交易日，中止'); process.exit(1); }

  // ── 追加/替换（redo）+ 全档重算 ──
  const existIdx = D.all_days.findIndex(d => d.trade_date === apiDate);
  if (existIdx >= 0) {
    console.log('REDO: 替换已有存档 ' + apiDate + '（hot ' + (D.all_days[existIdx].hot || []).length + '→' + day.hot.length + ' 只 · lhb ' + (D.all_days[existIdx].lhb_aggr || D.all_days[existIdx].lhb || []).length + '→' + day.lhb_aggr.length + ' 只）');
    D.all_days[existIdx] = day;
    // stocks 该日条目先移除，appendStocks 以新值重写
    Object.values(D.stocks).forEach(st => {
      const di = (st.days || []).indexOf(apiDate);
      if (di >= 0) { st.days.splice(di, 1); (st.closes || []).splice(di, 1); }
    });
  } else {
    D.all_days.push(day);
  }
  D.all_days.sort((a, b) => a.trade_date < b.trade_date ? -1 : 1);
  refreshAllTopics(D); // v4.9.1: 全档 topics 统一「全局孤点剔除」口径（含当日, 新旧不混图）
  recalcRanks(D.all_days);
  appendStocks(D, day);
  D.board_rank = D.board_rank || {};
  D.board_rank[apiDate] = industry.map(i => [i.name, i.change_pct]);
  D.meta = D.meta || {};
  D.meta.holidays = [...new Set([...(D.meta.holidays || [])])].sort();
  D.meta.dataQuality = Object.assign({}, D.meta.dataQuality, {
    dailyPipe: 'fetch-daily.js 自动管道 v4.9（东财龙虎榜+getharden+881xxx日K+腾讯指数+涨跌停炸板池(含封单/梯队/炸板额)+两市额+883994昨涨停+高位亏钱效应+两融+题材词典归一/全局孤点剔除）',
    dailyPipeNote: 'pct_rank/net_pct_rank 为「无补位真实天数」内分位（v4.9.1 起补位日置 null）; topics 每次追加全档统一重算',
    formulaVersion: 'v4.9.3 七因子（s_net20/s_pos10/s_brd20/s_hot10/s_zdt15/s_zbl10/s_amt15）+ yzt/dt_band/hs/lb_dist/zb_amt/rzrq + 题材归一(词典+个股数+黑名单+全局孤点≥2) + pctRankRealOnly + lhb净额按股去重',
    pctRankRealOnly: true,
    dailyPipeLastRun: new Date().toISOString()
  });
  // ── v4.9.1 管道自判健康度（S6 思想移植: 跑完自检, 异常显式输出并入 meta 供前端复核/告警）──
  {
    const missDays = D.all_days.filter(d => ((d.summary && d.summary._missing) || []).length).length;
    const issues = [];
    if (missDays > D.all_days.length * 0.4) issues.push('补位因子天数占比 >40%（东财池保留深度限制, 历史可比性打折）');
    if (day.summary.zt_count == null) issues.push('当日涨跌停池缺失（s_zdt/s_zbl 中性补位）');
    if (day.summary.yzt_chg == null) issues.push('当日昨涨停效应缺失（883994 时序）');
    const health = { checkedAt: new Date().toISOString(), totalDays: D.all_days.length, missingDays: missDays, issues };
    D.meta.dataQuality.health = health;
    console.log('\n健康自检: ' + (issues.length ? '⚠ ' + issues.join(' ; ') : '✓ 无异常') + `（补位 ${missDays}/${D.all_days.length} 天）`);
  }

  // ── 校验: 新日情绪与其 KPI 合理性 ──
  console.log('\n新交易日组装完成:');
  console.log('  情绪值', day.emotion.value, '（净买', day.emotion.s_net, '· 广度', day.emotion.s_brd, '· 热度', day.emotion.s_hot, '· 涨跌停', day.emotion.s_zdt, '· 封板', day.emotion.s_zbl, '· 量能', day.emotion.s_amt, '）');
  console.log('  净买 ¥' + day.summary.net_total_yi + '亿 · 榜', day.summary.lhb_count, '条/' + day.summary.lhb_stocks + '股 · 强势股', day.summary.hot_count,
    '· 涨停', day.summary.zt_count, '· 断板', day.summary.dt_band, '· 昨涨停效应', day.summary.yzt_chg + '%',
    '· 高位股', day.summary.hs_lb3_count == null ? '缺' : day.summary.hs_lb3_count,
    '· 高位跌停', day.summary.hs_dt_count == null ? '缺' : day.summary.hs_dt_count + '(封单' + (day.summary.hs_dt_fund ?? '—') + '亿)',
    '· 炸板额', day.summary.zb_amt == null ? '缺' : day.summary.zb_amt + '亿',
    '· 两融净', day.summary.rzrq == null ? '缺' : day.summary.rzrq.jme + '亿',
    '· 两市 ¥' + day.summary.amount_yi + '亿 · 领涨板块', day.industry[0].name);
  if (day.summary.lhb_count < 20 || day.summary.hot_count < 10) { console.error('⚠ 数据量异常偏少, 中止不写入'); process.exit(1); }

  if (DRY) { console.log('\n（dry 模式: 不写入不构建）'); return; }

  fs.copyFileSync(DATA_FILE, path.join(__dirname, 'data.backup-pre-daily.json'));
  fs.writeFileSync(DATA_FILE, JSON.stringify(D));
  console.log('data.json 已写入（备份 data.backup-pre-daily.json）·', D.all_days.length, '个交易日');

  // ── 构建 + 发布目录 ──
  console.log('重建 dist…');
  execSync('node build.js', { cwd: __dirname, stdio: 'inherit' });
  if (fs.existsSync(path.dirname(TASK_PUBLIC))) fs.copyFileSync(path.join(__dirname, 'dist', 'index.html'), TASK_PUBLIC); // 云端无 task-manager 目录则跳过
  if (fs.existsSync(PUB_DIR)) fs.copyFileSync(path.join(__dirname, 'dist', 'index.html'), path.join(PUB_DIR, 'index.html')); // build.js 已建目录，守卫兜底
  console.log('已同步: task-manager/public/sentiment.html + 独立发布目录');
  console.log('\n══ ' + apiDate + ' 入档完成 · 存档 ' + D.all_days.length + ' 个交易日 ══');
  console.log('（发布: 用 sites 工具重发 task-manager 目录即可上线）');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
