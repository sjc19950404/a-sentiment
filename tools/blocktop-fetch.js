// v4.9.4 概念板块结构化归因（block_top）全档拉取 + 入库
// 同花顺官方概念归因: 每日涨停股按 885xxx/881xxx 概念板块聚合(涨停数>=2 才上榜, 按涨停数排序)
// 用途: 题材榜从「诱因串解析+词典归一」升级为「官方概念归因」的结构化地基; 与 hot 题材交叉验证
// 用法: node tools/blocktop-fetch.js   （输出 tools/blocktop-cache.json + 写入 data.json summary.concept_top）
const fs = require('fs');
const path = require('path');
const D = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const REF = 'https://data.10jqka.com.cn/datacenterph/limitup/limtupInfo.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchBlockTop(dateNum) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://data.10jqka.com.cn/dataapi/limit_up/block_top?filter=HS,GEM2STAR&date=${dateNum}`,
        { headers: { 'User-Agent': UA, Referer: REF }, signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.status_code !== 0) throw new Error('api ' + j.status_msg);
      return (j.data || []).map(b => ({
        tag: b.name, code: b.code, count: b.limit_up_num,
        high: b.high || null, codes: (b.stock_list || []).map(s => s.code)
      }));
    } catch (e) {
      if (i === 2) { console.log(`  ⚠ ${dateNum} 失败: ${e.message}`); return null; }
      await sleep(900 * (i + 1));
    }
  }
}

async function main() {
  const days = D.all_days.map(d => d.trade_date.replace(/-/g, ''));
  const cache = {};
  let n = 0;
  for (const dn of days) {
    const rows = await fetchBlockTop(dn);
    if (rows) cache[dn] = rows;
    n++;
    if (n % 10 === 0) console.log(`进度 ${n}/${days.length}`);
    await sleep(350);
  }
  fs.writeFileSync(path.join(__dirname, 'blocktop-cache.json'), JSON.stringify(cache));
  console.log(`拉取完成: ${Object.keys(cache).length}/${days.length} 天`);
  // 入库: summary.concept_top = TOP10 [{tag,code,count,high,codes}]
  for (const d of D.all_days) {
    const dn = d.trade_date.replace(/-/g, '');
    const rows = cache[dn];
    if (rows && rows.length) d.summary.concept_top = rows.slice(0, 10);
  }
  fs.writeFileSync(path.join(__dirname, '..', 'data.json'), JSON.stringify(D));
  // 样例
  const last = D.all_days[D.all_days.length - 1];
  console.log('\n9/28 concept_top TOP5:', (last.summary.concept_top || []).map(x => `${x.tag}${x.count}`).join(' · '));
  const aug14 = D.all_days.find(d => d.trade_date === '2026-08-14');
  console.log('8/14 concept_top TOP5:', (aug14.summary.concept_top || []).map(x => `${x.tag}${x.count}`).join(' · '));
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
