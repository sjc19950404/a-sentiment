// 同花顺池接口历史恢复 · 口径对照验证
// 用途: 拉同花顺涨停/炸板/跌停/连板池(保留完整历史), 与存档东财真实池重叠期对照,
//       验证口径偏差后决定是否用真实数据替换 v4.9.2 的校准重建值。
// 用法: node tools/thspool-verify.js [--full]
//   默认只拉东财真实池重叠期(9/4~9/28)做对照; --full 拉全档 31 天(含断层日)并输出恢复预览
const fs = require('fs');
const path = require('path');
const D = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
const FULL = process.argv.includes('--full');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const REF = 'https://data.10jqka.com.cn/datacenterph/limitup/limtupInfo.html';
const FIELD = '199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: REF }, signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.status_code !== 0) throw new Error('api ' + j.status_code + ' ' + j.status_msg);
      return j;
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(800 * (i + 1));
    }
  }
}

// 拉某池某日全部成员(分页)
async function fetchPool(ep, dateNum) {
  const codes = []; let page = 1;
  while (true) {
    const url = `https://data.10jqka.com.cn/dataapi/limit_up/${ep}?page=${page}&limit=100&field=${FIELD}&filter=HS,GEM2STAR&order_field=330324&order_type=0&date=${dateNum}`;
    const j = await getJSON(url);
    const info = (j.data && j.data.info) || [];
    for (const it of info) codes.push({ code: it.code, name: it.name, high_days: it.high_days, change_rate: it.change_rate });
    const pg = (j.data && j.data.page) || {};
    if (!info.length || page >= (pg.count || 1)) break;
    page++; await sleep(250);
  }
  return codes;
}

async function main() {
  const days = D.all_days.filter(d => FULL || (d.trade_date >= '2026-09-04')).map(d => d.trade_date.replace(/-/g, ''));
  console.log(`拉取 ${days.length} 天 × 4 池 (同花顺, filter=HS,GEM2STAR)…`);
  const result = {}; // dateNum → {zt, zb, dt, lb, codes:{zt:[],dt:[]}}
  let n = 0;
  for (const dn of days) {
    const rec = { zt: 0, zb: 0, dt: 0, lb: 0, zt_codes: [], dt_codes: [], lb_detail: [] };
    try {
      const [zt, zb, dt, lb] = await Promise.all([
        fetchPool('limit_up_pool', dn), fetchPool('open_limit_pool', dn),
        fetchPool('lower_limit_pool', dn), fetchPool('continuous_limit_pool', dn)
      ]);
      rec.zt = zt.length; rec.zb = zb.length; rec.dt = dt.length; rec.lb = lb.length;
      rec.zt_codes = zt.map(x => x.code); rec.dt_codes = dt.map(x => x.code);
      rec.lb_detail = lb.map(x => `${x.code}(${x.high_days})`);
    } catch (e) { console.log(`  ⚠ ${dn} 拉取失败: ${e.message}`); }
    result[dn] = rec;
    n++;
    if (n % 5 === 0) console.log(`  进度 ${n}/${days.length}`);
    await sleep(400);
  }
  fs.writeFileSync(path.join(__dirname, 'thspool-cache.json'), JSON.stringify(result, null, 1));

  // ── 对照: 东财真实池重叠期 ──
  console.log('\n══ 口径对照(东财真实池 vs 同花顺) ══');
  console.log('日期         东财 zt/dt/zb      同花顺 zt/dt/zb    差(同-东)');
  let sz = 0, sd = 0, sb = 0, m = 0;
  for (const d of D.all_days) {
    const s = d.summary || {}; const dn = d.trade_date.replace(/-/g, '');
    const r = result[dn];
    if (!r || (s.zt_count == null)) continue;
    if (d.trade_date === '2026-09-04') { console.log('(9/4 东财坏数据 zt=0/dt=9 跳过对照)'); continue; }
    if (!r.zt && !r.dt) continue;
    m++;
    const ez = r.zt - s.zt_count, ed = r.dt - (s.dt_count ?? 0), eb = r.zb - (s.zb_count ?? 0);
    sz += Math.abs(ez); sd += Math.abs(ed); sb += Math.abs(eb);
    console.log(`${d.trade_date}  ${String(s.zt_count).padStart(4)}/${String(s.dt_count ?? '—').padStart(3)}/${String(s.zb_count ?? '—').padStart(3)}    ${String(r.zt).padStart(4)}/${String(r.dt).padStart(3)}/${String(r.zb).padStart(3)}    ${ez >= 0 ? '+' : ''}${ez}/${ed >= 0 ? '+' : ''}${ed}/${eb >= 0 ? '+' : ''}${eb}`);
  }
  if (m) console.log(`\n平均绝对误差: zt ${(sz / m).toFixed(1)}  dt ${(sd / m).toFixed(1)}  zb ${(sb / m).toFixed(1)}（${m} 个对照日）`);

  if (FULL) {
    console.log('\n══ 断层日真实池预览(替换校准重建值) ══');
    for (const d of D.all_days) {
      const dn = d.trade_date.replace(/-/g, ''); const r = result[dn];
      const s = d.summary || {};
      if (!r || s.zt_count != null && d.trade_date !== '2026-09-04') continue;
      console.log(`${d.trade_date}  zt=${r.zt} dt=${r.dt} zb=${r.zb} lb(连板池)=${r.lb} · 现存 s_zdt=${(d.emotion || {}).s_zdt}`);
    }
    console.log('\n连板池样本(8/19):', result['20260819'] && result['20260819'].lb_detail.slice(0, 9).join(' '));
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
