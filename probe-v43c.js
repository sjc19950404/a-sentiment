// probe-v43c.js — 三轮: getTopic* pool=null 诊断 + zs_1A0001 字段验证 + 深市指数代码
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
        'Accept': '*/*', ...(opts.headers || {})
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
  // ── 1. getTopicZTPool 完整响应诊断（多种参数组合）──
  const tries = [
    ['历史date+pagesize500', 'ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500&date=20260924'],
    ['历史date+pagesize5', 'ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=5&date=20260924'],
    ['无date', 'ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=5']
  ];
  for (const [tag, qs] of tries) {
    try {
      const r = await get(`https://push2ex.eastmoney.com/getTopicZTPool?${qs}`);
      const body = r.buf.toString('utf8');
      console.log(`[ZT ${tag}] status=${r.status} body前200:`, body.slice(0, 200));
    } catch (e) { console.log(`[ZT ${tag}] FAIL: ${e.message}`); }
    await new Promise(r2 => setTimeout(r2, 700));
  }

  // ── 2. 同花顺指数日K字段验证（上证 zs_1A0001 / 深成指 zs_399001 / 创业板 zs_399006）──
  for (const code of ['zs_1A0001', 'zs_399001', 'zs_399006']) {
    try {
      const r = await get(`https://d.10jqka.com.cn/v6/line/${code}/01/2026.js`, { referer: 'https://q.10jqka.com.cn/' });
      const t = r.buf.toString('utf8');
      const m = t.match(/"20260924","([^"]*)"/);
      console.log(`[${code}] status=${r.status} 9-24行:`, m ? m[1] : '无（len=' + t.length + '）');
      if (m) {
        const cols = m[1].split(',');
        console.log(`   列数=${cols.length} 各列: ${cols.map((c, i) => i + '=' + c).join(' | ')}`);
      }
    } catch (e) { console.log(`[${code}] FAIL: ${e.message}`); }
    await new Promise(r2 => setTimeout(r2, 500));
  }
})();
