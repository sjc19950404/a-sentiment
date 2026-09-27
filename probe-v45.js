// probe-v45.js — ①ZB 池字段（炸板金额）②两融历史报表 ③北向口径
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
(async () => {
  // ① ZB 池字段
  const r1 = await get('https://push2ex.eastmoney.com/getTopicZBPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=fbt%3Aasc&date=20260924');
  let j1 = null; try { j1 = JSON.parse(r1.body); } catch (e) {}
  const zb = j1 && j1.data && j1.data.pool;
  console.log(`=== ① ZBPool 20260924 http=${r1.code} count=${zb ? zb.length : null}`);
  if (zb && zb.length) {
    console.log('字段:', Object.keys(zb[0]).join(','));
    const amt = zb.reduce((s, p) => s + (p.amount || 0), 0);
    console.log('样本:', JSON.stringify(zb.slice(0, 2)));
    console.log('炸板股成交额合计:', (amt / 1e8).toFixed(1), '亿');
  }

  // ② 两融：东财 datacenter 沪深合计历史
  for (const rpt of ['RPT_RZRQ_LSHJ']) {
    const url2 = 'https://datacenter-web.eastmoney.com/api/data/v1/get?pageSize=5&pageNumber=1&reportName=' + rpt +
      '&columns=ALL&sortColumns=dim_date&sortTypes=-1';
    const r2 = await get(url2);
    let j2 = null; try { j2 = JSON.parse(r2.body); } catch (e) {}
    const rows = j2 && j2.result && j2.result.data;
    console.log(`\n=== ② 两融 ${rpt} http=${r2.code} success=${j2 && j2.success} count=${j2 && j2.result && j2.result.count}`);
    if (rows && rows.length) {
      console.log('字段:', Object.keys(rows[0]).join(','));
      rows.slice(0, 3).forEach(x => console.log(' ', x.DIM_DATE || x.DATE, JSON.stringify(x)));
    }
  }

  // ③ 北向：沪深港通成交概况
  const url3 = 'https://datacenter-web.eastmoney.com/api/data/v1/get?pageSize=5&pageNumber=1&reportName=RPT_MUTUAL_DEAL_HISTORY&columns=ALL&sortColumns=dim_date&sortTypes=-1';
  const r3 = await get(url3);
  let j3 = null; try { j3 = JSON.parse(r3.body); } catch (e) {}
  const rows3 = j3 && j3.result && j3.result.data;
  console.log(`\n=== ③ 北向 RPT_MUTUAL_DEAL_HISTORY http=${r3.code} success=${j3 && j3.success} count=${j3 && j3.result && j3.result.count}`);
  if (rows3 && rows3.length) {
    console.log('字段:', Object.keys(rows3[0]).join(','));
    rows3.slice(0, 3).forEach(x => console.log(' ', x.DIM_DATE || x.DATE, JSON.stringify(x).slice(0, 300)));
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
