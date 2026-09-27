// probe-v43d.js — 四轮: getTopic* 带 sort + zs_1A0001 data 串原始结构
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
      }, timeout: 15000
    }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}
const j = b => { try { return JSON.parse(b.toString('utf8')); } catch (e) { return null; } };

(async () => {
  // ── 1. getTopic* 三池带 sort（照抄 lab-realtime 参数 + date 历史）──
  for (const [name, api, sort] of [
    ['涨停池', 'getTopicZTPool', 'fbt%3Aasc'],
    ['炸板池', 'getTopicZBPool', 'fbt%3Aasc'],
    ['跌停池', 'getTopicDTPool', 'fund%3Aasc']
  ]) {
    try {
      const r = await get(`https://push2ex.eastmoney.com/${api}?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=${sort}&date=20260924`);
      const d = j(r.buf);
      const pool = d && d.data && d.data.pool;
      console.log(`[${name}] rc=${d && d.rc} pool=${pool ? pool.length : 'null'}`);
      if (pool && pool.length) console.log('  首条:', JSON.stringify(pool[0]).slice(0, 300));
    } catch (e) { console.log(`[${name}] FAIL: ${e.message}`); }
    await new Promise(r2 => setTimeout(r2, 700));
  }

  // ── 2. 同花顺指数 data 串结构（上证/深成指 9-24 行）──
  for (const code of ['zs_1A0001', 'zs_399001']) {
    try {
      const r = await get(`https://d.10jqka.com.cn/v6/line/${code}/01/2026.js`, { referer: 'https://q.10jqka.com.cn/' });
      const t = r.buf.toString('utf8');
      const json = t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
      const obj = JSON.parse(json);
      const rows = (obj.data || '').split(';').filter(Boolean);
      console.log(`[${code}] 总行数=${rows.length}`);
      const i = rows.findIndex(l => l.startsWith('20260924'));
      console.log(`  9-24行: ${rows[i]}`);
      console.log(`  前一日:  ${rows[i - 1]}`);
      console.log(`  最后3行: ${rows.slice(-3).join(' ;; ')}`);
    } catch (e) { console.log(`[${code}] FAIL: ${e.message}`); }
    await new Promise(r2 => setTimeout(r2, 500));
  }
})();
