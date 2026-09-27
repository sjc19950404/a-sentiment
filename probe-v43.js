// probe-v43.js — v4.3 新数据源探测（一次性）：三池历史回查 + 成交额源候选
// 验证日: 2026-09-24（已知：强势股 51 只, 中秋前最后交易日）
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
        'Accept': '*/*'
      },
      timeout: 15000
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}
const j = b => { try { return JSON.parse(b.toString('utf8')); } catch (e) { return null; } };

(async () => {
  const D = '20260924';
  const UT = 'ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500';

  // ── 1. 东财三池（历史 date）──
  for (const [name, api, sort] of [
    ['涨停池', 'getLastZTPool', 'fbt%3Aasc'],
    ['炸板池', 'getLastZBPool', 'fbt%3Aasc'],
    ['跌停池', 'getLastDTPool', 'fund%3Aasc']
  ]) {
    try {
      const r = await get(`https://push2ex.eastmoney.com/${api}?${UT}&sort=${sort}&date=${D}`);
      const d = j(r.buf);
      const pool = d && d.data && d.data.pool;
      console.log(`[${name}] status=${r.status} pool=${pool ? pool.length : 'null'}`);
      if (pool && pool.length) {
        const s = pool[0];
        console.log('  首条字段:', JSON.stringify(s).slice(0, 300));
        console.log('  字段名:', Object.keys(s).join(','));
      }
    } catch (e) { console.log(`[${name}] FAIL: ${e.message}`); }
    await new Promise(r2 => setTimeout(r2, 600));
  }

  // ── 2a. 同花顺大盘日K（上证 1_000001 / 深成指 0_399001 候选前缀）──
  for (const code of ['1_000001', '0_399001', '1_1A0001', '48_1A0001']) {
    try {
      const r = await get(`https://d.10jqka.com.cn/v6/line/${code}/01/2026.js`, { referer: 'https://q.10jqka.com.cn/' });
      const t = r.buf.toString('utf8');
      const m = t.match(/"20260924","([^"]+)"/) || t.match(/"20260924",([^,\]]+)/);
      console.log(`[同花顺 ${code}] status=${r.status} len=${t.length} 9-24行=${m ? m[0].slice(0, 120) : '无'}`);
      if (!m && t.length < 200) console.log('  内容:', t.slice(0, 150));
    } catch (e) { console.log(`[同花顺 ${code}] FAIL: ${e.message}`); }
    await new Promise(r2 => setTimeout(r2, 500));
  }

  // ── 2b. 腾讯 fqkline 上证（volume 手；看有没有 amount 列）──
  try {
    const r = await get('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,,10,qfq');
    const d = j(r.buf);
    const k = d && d.data && d.data.sh000001 && (d.data.sh000001.qfqday || d.data.sh000001.day);
    console.log(`[腾讯fqkline] status=${r.status} rows=${k ? k.length : 'null'}`);
    if (k) console.log('  末行:', JSON.stringify(k[k.length - 1]));
  } catch (e) { console.log('[腾讯fqkline] FAIL: ' + e.message); }

  // ── 2c. 东财 push2his（曾被限, 复查）──
  try {
    const r = await get('https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000001&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20260925&lmt=5');
    const t = r.buf.toString('utf8');
    console.log(`[东财push2his] status=${r.status} len=${t.length} 含klines=${t.includes('klines')}`);
    if (t.includes('klines')) {
      const d = j(r.buf);
      console.log('  末3条:', JSON.stringify((d.data.klines || []).slice(-3)));
    }
  } catch (e) { console.log('[东财push2his] FAIL: ' + e.message); }
})();
