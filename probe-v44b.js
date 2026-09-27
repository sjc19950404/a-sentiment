// probe-v44b.js — clist 分页重试 + ZT 池 lbc 确认 + DTPool fba 汇总验证
const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Referer': 'https://quote.eastmoney.com/',
        'Connection': 'close'
      }, timeout: 20000
    }, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ code: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
async function getRetry(url, n = 3) {
  for (let i = 1; i <= n; i++) {
    try { return await get(url); } catch (e) { console.log(`  retry ${i}/${n}: ${e.message}`); await new Promise(r => setTimeout(r, 1200 * i)); }
  }
  throw new Error('重试耗尽');
}

(async () => {
  // ① clist 分页抓全市场
  const base = 'https://push2.eastmoney.com/api/qt/clist/get?po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f3,f6,f12,f14,f100';
  let all = [], total = null;
  for (let pn = 1; pn <= 4; pn++) {
    const r = await getRetry(`${base}&pn=${pn}&pz=2000`);
    const j = JSON.parse(r.body);
    const diff = j && j.data && j.data.diff;
    if (total == null) total = j.data.total;
    if (!diff || !diff.length) break;
    all = all.concat(diff);
    if (all.length >= total) break;
  }
  console.log(`=== ① clist total=${total} got=${all.length}`);
  if (all.length) {
    console.log('样本:', JSON.stringify(all.slice(0, 2)));
    let up = 0, down = 0, flat = 0, upAmt = 0, downAmt = 0, totalAmt = 0, bad = 0;
    for (const d of all) {
      const chg = typeof d.f3 === 'number' ? d.f3 : null;
      const amt = typeof d.f6 === 'number' ? d.f6 : 0;
      totalAmt += amt;
      if (chg == null) { bad++; flat++; continue; }
      if (chg > 0) { up++; upAmt += amt; } else if (chg < 0) { down++; downAmt += amt; } else flat++;
    }
    const yi = v => (v / 1e8).toFixed(0);
    console.log(`涨 ${up} / 跌 ${down} / 平 ${flat} (f3 异常 ${bad})`);
    console.log(`上涨额 ${yi(upAmt)} 亿 / 下跌额 ${yi(downAmt)} 亿 / 总额 ${yi(totalAmt)} 亿 / 比值 ${(upAmt / downAmt).toFixed(2)}`);
    // 两市额对照存档 9-24: 1.65 万亿 → 此为 9-25 收盘
    const m = new Map();
    for (const d of all) { if (d.f100) { if (!m.has(d.f100)) m.set(d.f100, { u: 0, t: 0 }); m.get(d.f100).t++; if (typeof d.f3 === 'number' && d.f3 > 0) m.get(d.f100).u++; } }
    const rows = [...m.entries()].map(([k, v]) => [k, v.u, v.t, (v.u / v.t * 100).toFixed(0)]).sort((a, b) => b[3] - a[3]);
    console.log('f100 行业 breadth top5:', JSON.stringify(rows.slice(0, 5)));
    console.log('f100 行业 breadth bottom3:', JSON.stringify(rows.slice(-3)));
  }

  // ② ZT 池 lbc 字段确认（9-24 存档日，应 52 只）
  const ztU = 'https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=fbt%3Aasc&date=20260924';
  const r2 = await getRetry(ztU);
  const j2 = JSON.parse(r2.body);
  const zt = j2 && j2.data && j2.data.pool;
  console.log(`\n=== ② ZTPool 20260924 count=${zt ? zt.length : null}`);
  if (zt && zt.length) {
    console.log('字段:', Object.keys(zt[0]).join(','));
    const lb3 = zt.filter(p => (p.lbc || 0) >= 3);
    console.log(`lbc>=3: ${lb3.length} 家 →`, JSON.stringify(lb3.map(p => `${p.n}(${p.lbc}板)`).slice(0, 10)));
    console.log('9-24 高位股名单即「9-25 高位跌停观察池」:', JSON.stringify(lb3.map(p => p.c)));
  }

  // ③ DTPool fba 汇总 + 与 ZT 池交集（9-25 当日）
  const dtU = 'https://push2ex.eastmoney.com/getTopicDTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=fund%3Aasc&date=20260925';
  const r3 = await getRetry(dtU);
  const j3 = JSON.parse(r3.body);
  const dt = j3 && j3.data && j3.data.pool;
  console.log(`\n=== ③ DTPool 20260925 count=${dt ? dt.length : null}`);
  if (dt && dt.length && zt && zt.length) {
    // 注意：此处 ZT 是 9-24 池 = 9-25 的「昨日涨停」
    const prevZt = new Map(zt.map(p => [p.c, p.lbc || 1]));
    const hit = dt.filter(p => prevZt.has(p.c));
    const hs = hit.filter(p => (prevZt.get(p.c) || 0) >= 3);
    const yi = v => (v / 1e8).toFixed(2);
    console.log(`昨日涨停今日跌停: ${hit.length} 家 →`, JSON.stringify(hit.map(p => `${p.n}(昨${prevZt.get(p.c)}板·封单${yi(p.fba)}亿·连跌${p.days}天·开板${p.oc}次)`)));
    console.log(`其中高位(昨≥3板): ${hs.length} 家, 封单合计 ${yi(hs.reduce((s, p) => s + (p.fba || 0), 0))} 亿, 成交额合计 ${yi(hs.reduce((s, p) => s + (p.amount || 0), 0))} 亿`);
    console.log('DTPool 全池 fba 合计:', yi(dt.reduce((s, p) => s + (p.fba || 0), 0)), '亿 · days>=2:', dt.filter(p => p.days >= 2).length, '家');
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
