// probe-v44.js — v4.4 三数据源探测
// ① 东财昨日涨停池 getTopicYDZTPool（高位股口径核心） ② 跌停池 fund 字段 ③ clist 全市场快照
const https = require('https');

function get(url, encoding = 'utf8') {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' } }, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ code: res.statusCode, body: Buffer.concat(chunks).toString(encoding) }));
    }).on('error', reject);
  });
}

(async () => {
  // ① 昨日涨停池：date=20260924 → 9-23 涨停股在 9-24 的表现
  for (const date of ['20260925', '20260924']) {
    const u1 = `https://push2ex.eastmoney.com/getTopicYDZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=fbt%3Aasc&date=${date}`;
    const r1 = await get(u1);
    let j1 = null; try { j1 = JSON.parse(r1.body); } catch (e) {}
    const pool = j1 && j1.data && j1.data.pool;
    console.log(`\n=== ① YDZTPool date=${date} http=${r1.code} rc=${j1 && j1.rc} count=${pool ? pool.length : null}`);
    if (pool && pool.length) {
      console.log('字段:', Object.keys(pool[0]).join(','));
      console.log('样本:', JSON.stringify(pool.slice(0, 3)));
      const lb3 = pool.filter(p => (p.lbc || 0) >= 3);
      console.log(`lbc>=3 家数: ${lb3.length}`, lb3.length ? JSON.stringify(lb3.slice(0, 3)) : '');
      const zdp = pool.map(p => p.zdp).filter(v => v != null);
      if (zdp.length) console.log('zdp 范围:', Math.min(...zdp), '~', Math.max(...zdp));
    }
  }

  // ② 跌停池字段（fund 封单确认）
  const u2 = `https://push2ex.eastmoney.com/getTopicDTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=fund%3Aasc&date=20260925`;
  const r2 = await get(u2);
  let j2 = null; try { j2 = JSON.parse(r2.body); } catch (e) {}
  const dt = j2 && j2.data && j2.data.pool;
  console.log(`\n=== ② DTPool date=20260925 http=${r2.code} rc=${j2 && j2.rc} count=${dt ? dt.length : null}`);
  if (dt && dt.length) {
    console.log('字段:', Object.keys(dt[0]).join(','));
    console.log('样本:', JSON.stringify(dt.slice(0, 3)));
  }

  // ③ clist 全市场快照（周末=9-25 收盘）
  const u3 = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=6000&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f2,f3,f6,f12,f14,f100`;
  const r3 = await get(u3);
  let j3 = null; try { j3 = JSON.parse(r3.body); } catch (e) {}
  const diff = j3 && j3.data && j3.data.diff;
  console.log(`\n=== ③ clist http=${r3.code} total=${j3 && j3.data && j3.data.total} got=${diff ? diff.length : null}`);
  if (diff && diff.length) {
    console.log('样本:', JSON.stringify(diff.slice(0, 2)));
    let up = 0, down = 0, flat = 0, upAmt = 0, downAmt = 0, totalAmt = 0, badF3 = 0;
    for (const d of diff) {
      const chg = typeof d.f3 === 'number' ? d.f3 : null;
      const amt = typeof d.f6 === 'number' ? d.f6 : 0;
      totalAmt += amt;
      if (chg == null || chg === '-') { badF3++; flat++; continue; }
      if (chg > 0) { up++; upAmt += amt; } else if (chg < 0) { down++; downAmt += amt; } else flat++;
    }
    const yi = v => (v / 1e8).toFixed(0);
    console.log(`涨 ${up} / 跌 ${down} / 平停 ${flat} (f3异常 ${badF3})`);
    console.log(`上涨额 ${yi(upAmt)} 亿 / 下跌额 ${yi(downAmt)} 亿 / 总额 ${yi(totalAmt)} 亿 / 比值 ${(upAmt / downAmt).toFixed(2)}`);
    const inds = new Set(diff.map(d => d.f100).filter(Boolean));
    console.log('f100 行业数:', inds.size, '示例:', [...inds].slice(0, 8).join('·'));
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
