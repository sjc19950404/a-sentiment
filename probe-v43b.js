// probe-v43b.js — v4.3 二轮探测：getTopic* 三池 + 指数代码前缀矩阵 + 分流 push2his
const https = require('https');
const url = require('url');

function get(rawUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = url.parse(rawUrl);
    const req = https.get({
      hostname: u.hostname, path: u.path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Referer': opts.referer || 'https://quote.eastmoney.com/',
        'Accept': '*/*',
        ...(opts.headers || {})
      },
      timeout: 15000
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}
const j = b => { try { return JSON.parse(b.toString('utf8')); } catch (e) { return null; } };

(async () => {
  const D = '20260924';
  const BASE = 'ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500';

  // ── 1. getTopic* 三池（lab-realtime 已验证 getTopicZTPool 当日可用）──
  for (const [name, api] of [
    ['涨停池', 'getTopicZTPool'], ['炸板池', 'getTopicZBPool'], ['跌停池', 'getTopicDTPool']
  ]) {
    try {
      const r = await get(`https://push2ex.eastmoney.com/${api}?${BASE}&date=${D}`);
      const d = j(r.buf);
      const pool = d && d.data && d.data.pool;
      console.log(`[${name}] status=${r.status} pool=${pool ? pool.length : 'null'} tc=${d && d.data ? d.data.tc : '?'}`);
      if (pool && pool.length) console.log('  首条:', JSON.stringify(pool[0]).slice(0, 260));
    } catch (e) { console.log(`[${name}] FAIL: ${e.message}`); }
    await new Promise(r2 => setTimeout(r2, 700));
  }

  // ── 2. 同花顺指数前缀矩阵（v6/line/<prefix>_1A0001 或裸 code）──
  for (const code of ['1A0001', 'zs_1A0001', '17_1A0001', 'hs_1A0001', '1_1A0001']) {
    try {
      const r = await get(`https://d.10jqka.com.cn/v6/line/${code}/01/2026.js`, { referer: 'https://q.10jqka.com.cn/' });
      const t = r.buf.toString('utf8');
      console.log(`[ths ${code}] status=${r.status} len=${t.length}${t.length < 200 ? ' body=' + t.slice(0, 100) : ' ✓有数据'}`);
    } catch (e) { console.log(`[ths ${code}] FAIL: ${e.message}`); }
    await new Promise(r2 => setTimeout(r2, 400));
  }

  // ── 3. 东财 push2his 分流域名（f57=成交额）──
  for (const sub of ['48', '92', '33']) {
    try {
      const r = await get(`https://${sub}.push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000001&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20260925&lmt=4`);
      const t = r.buf.toString('utf8');
      if (t.includes('klines')) {
        const d = j(r.buf);
        console.log(`[push2his ${sub}] ✓ 末条:`, (d.data.klines || []).slice(-1)[0]);
      } else {
        console.log(`[push2his ${sub}] status=${r.status} len=${t.length} 无klines`);
      }
    } catch (e) { console.log(`[push2his ${sub}] FAIL: ${e.message}`); }
    await new Promise(r2 => setTimeout(r2, 400));
  }

  // ── 4. 雪球（先拿 cookie 再 kline, item 含 amount）──
  try {
    const home = await get('https://xueqiu.com/', { referer: 'https://xueqiu.com/' });
    const setc = (home.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const beg = 1790300000000; // 大约 2026-09-25 附近
    const r = await get(`https://stock.xueqiu.com/v5/stock/chart/kline.json?symbol=SH000001&begin=${beg}&period=day&type=before&count=-5&indicator=kline`, { headers: { Cookie: setc }, referer: 'https://xueqiu.com/S/SH000001' });
    const d = j(r.buf);
    if (d && d.data && d.data.item) {
      console.log(`[雪球] ✓ column=${JSON.stringify(d.data.column)} 末条=${JSON.stringify(d.data.item[d.data.item.length - 1])}`);
    } else {
      console.log(`[雪球] status=${r.status} body=${r.buf.toString('utf8').slice(0, 120)}`);
    }
  } catch (e) { console.log('[雪球] FAIL: ' + e.message); }
})();
