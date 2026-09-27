// probe-v45b.js — datacenter 报表名矩阵（两融 + 北向）
const https = require('https');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/154.0.0.0';
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/' }, timeout: 15000 }, res => {
      let b = []; res.on('data', c => b.push(c));
      res.on('end', () => resolve({ code: res.statusCode, body: Buffer.concat(b).toString('utf8') }));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}
const BASE = 'https://datacenter-web.eastmoney.com/api/data/v1/get?pageSize=3&pageNumber=1&columns=ALL';
(async () => {
  const tests = [
    ['两融A', 'RPTA_WEB_RZRQ_ZSBJETC', ''],
    ['两融B', 'RPTA_WEB_RZRQ_LSHJ', ''],
    ['两融C', 'RPT_RZRQ_ZSBJ', ''],
    ['两融D', 'RPTA_RZRQ_LSHJ', ''],
    ['北向A', 'RPT_MUTUAL_DEAL_HISTORY', encodeURIComponent('(MUTUAL_TYPE="001")')],
    ['北向B', 'RPT_MUTUAL_DEAL', ''],
  ];
  for (const [tag, rpt, filter] of tests) {
    const url = BASE + '&reportName=' + rpt + (filter ? '&filter=' + filter : '') + (rpt.includes('MUTUAL') ? '&sortColumns=DIM_DATE&sortTypes=-1' : '&sortColumns=DIM_DATE&sortTypes=-1');
    try {
      const r = await get(url);
      const j = JSON.parse(r.body);
      const rows = j.result && j.result.data;
      console.log(`${tag} ${rpt}: success=${j.success} count=${j.result && j.result.count}`);
      if (rows && rows.length) {
        console.log('  字段:', Object.keys(rows[0]).slice(0, 16).join(','));
        console.log('  首行:', JSON.stringify(rows[0]).slice(0, 400));
      }
    } catch (e) { console.log(`${tag} ${rpt}: ERR ${e.message}`); }
    await new Promise(r2 => setTimeout(r2, 300));
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
