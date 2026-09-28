#!/usr/bin/env node
// rebuild-pools.js — 用腾讯 bfq(不复权)日K 数学重建涨停/跌停/炸板原始因子, 修复 pools 历史断层(8/14~9/3)
// 模式: node rebuild-pools.js           → 验证模式(拉全市场 bfq, 与 15 个真实池日对照, 不写档)
//       node rebuild-pools.js --apply   → 应用模式(重建值写入 data.json 断层日 + 重算情绪/健康)
// 判定: 涨停=收盘价>=round_half_up(昨收×(1+lim),2分); 炸板=盘中触涨停价但收盘未封; 跌停对称
// lim: ST→5% · 科创688/689→20% · 创业板30x→20% · 其余→10%; 上市前5日(无涨跌幅)跳过
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const CONC = 2, GAP = 250;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, tries = 3, backoff = 600) {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { if (i === tries - 1) throw e; await sleep(backoff * (i + 1)); }
  }
}

// ── 目标日清单: _missing 含 pools 的断层日 + 9/4 坏数据日(zt=0/dt=9 矛盾) ──
const DATA_FILE = path.join(__dirname, '..', 'data.json');
const D = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const targets = [];
for (const d of D.all_days) {
  const m = (d.summary && d.summary._missing) || [];
  if (m.includes('pools')) targets.push(d.trade_date);
  if (d.trade_date === '2026-09-04') targets.push(d.trade_date); // 池接口空返回坏数据
}
// 重建还需要每个目标日的「前一交易日」做昨收基准(含 8/14 前一日 8/13)
// 交易日序列 = 全档已存档日 + 目标日本身 + 指数日K校验日(直接用 bar 序列自身的相邻关系, 无需日历)

// ── 股票清单: kline 分片 (c/n) ──
const kdir = path.join(__dirname, '..', 'kline');
const stocks = [];
for (const f of fs.readdirSync(kdir)) {
  if (f === '_list.json' || !f.endsWith('.json')) continue;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(kdir, f), 'utf8'));
    if (s.c && s.n) stocks.push({ c: s.c, n: s.n });
  } catch (e) { /* skip */ }
}
console.log(`目标日 ${targets.length} 个: ${targets[0]} ~ ${targets[targets.length-1]} · 股票 ${stocks.length} 只`);

// ── 对照基准日(有真实池值的日子) — 同样参与重建用于误差校准 ──
const calibDays = [];
for (const d of D.all_days) {
  const s = d.summary || {};
  if (s.zt_count != null && s.zt_count > 0 && !targets.includes(d.trade_date)) calibDays.push(d.trade_date);
}
// 重建集合 = 断层日 ∪ 校准日
const rebuildDays = [...new Set([...targets, ...calibDays])].sort();

// ── 拉取 bfq 日K(近 40 根, 覆盖 8/13~9/28); 结果缓存 tools/bfq-cache.json, 重跑免拉 ──
const daily = {};
const CACHE = path.join(__dirname, 'bfq-cache.json');
if (fs.existsSync(CACHE)) {
  Object.assign(daily, JSON.parse(fs.readFileSync(CACHE, 'utf8')));
  console.log(`缓存命中: ${Object.keys(daily).length} 只已拉取`);
}
let done = 0, fail = 0;
const failed = [];
async function fetchOne(st) {
  // 数据源: 新浪不复权日K(240min=日线); 腾讯 ifzq fqkline 对本机触发风控(501)后改道
  const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${st.c}&scale=240&ma=no&datalen=40`;
  try {
    const j = await withRetry(async () => {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' }, signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }, 3, 500);
    if (Array.isArray(j) && j.length) {
      daily[st.c] = j.map(b => [b.day, Math.round(parseFloat(b.open) * 100), Math.round(parseFloat(b.close) * 100), Math.round(parseFloat(b.high) * 100), Math.round(parseFloat(b.low) * 100)]);
      return true;
    }
  } catch (e) { /* fallthrough */ }
  return false;
}
let idx = 0;
// 每日的重建结果 + 涨停成员(为后续 dt_band 递推预留)
const rec = {};   // date → {zt, dt, zb, zt_codes:[], dt_codes:[]}
function limOf(code, name) {
  if (/ST/i.test(name)) return 5;
  const b = code.slice(2);
  if (b.startsWith('688') || b.startsWith('689')) return 20;
  if (b.startsWith('30')) return 20;
  return 10;
}
async function main() {
  // 拉取(跳过已缓存) — 两轮: 全速 + 失败降速补拉
  for (let round = 0; round < 2; round++) {
    const pending = stocks.filter(s => !daily[s.c]);
    if (!pending.length) break;
    if (round) console.log(`补拉第 ${round + 1} 轮: ${pending.length} 只(降速)`);
    idx = 0;
    done = 0; fail = 0;
    const conc = round ? 1 : CONC, gap = round ? 600 : GAP;
    const plist = [...pending];
    await Promise.all(Array.from({ length: conc }, async () => {
      while (idx < plist.length) {
        const st = plist[idx++];
        const ok = await fetchOne(st);
        if (!ok) fail++;
        done++;
        if (done % 500 === 0) console.log(`  拉取进度 ${done}/${plist.length} · 失败 ${fail}`);
        await sleep(gap);
      }
    }));
    failed.push(fail);
  }
  fs.writeFileSync(CACHE, JSON.stringify(daily));
  console.log(`bfq 拉取完成: ${Object.keys(daily).length}/${stocks.length} 成功(已缓存)`);

  // ── 重建: 断层日 ∪ 校准日 ──
  for (const t of rebuildDays) rec[t] = { zt: 0, dt: 0, zb: 0, zt_codes: [], dt_codes: [] };

  for (const [code, bars] of Object.entries(daily)) {
    const name = (stocks.find(s => s.c === code) || {}).n || '';
    const L = limOf(code, name);
    for (let i = 1; i < bars.length; i++) {
      const [date, , c, h] = bars[i];
      const t = rec[date];
      if (!t) continue;
      if (i < 5) continue;             // 上市前 5 日无涨跌幅限制, 跳过
      const pcFen = bars[i - 1][2];    // 昨收(整数分)
      if (!pcFen) continue;
      const ztFen = Math.round(pcFen * (1 + L / 100)); // round half up 到分
      const dtFen = Math.round(pcFen * (1 - L / 100));
      if (c >= ztFen) { t.zt++; t.zt_codes.push(code); }
      else if (h >= ztFen) t.zb++;
      if (c <= dtFen) { t.dt++; t.dt_codes.push(code); }
    }
  }

  // ── 对照(验证模式) — 仅 zt>0 的可信基准日(9/4 zt=0 为池接口空返回坏数据, 不校准) ──
  const truth = {};
  for (const d of D.all_days) {
    const s = d.summary || {};
    if (s.zt_count != null && s.zt_count > 0) truth[d.trade_date] = s;
  }
  console.log('\n══ 基准日对照(真实池 vs bfq 重建) ══');
  console.log('日期         真实 zt/dt/zb      重建 zt/dt/zb      误差');
  let sz = 0, sd = 0, sb = 0, n = 0;
  for (const d of Object.keys(truth).sort()) {
    const s = truth[d], r = rec[d];
    if (!r) continue;
    n++;
    const ez = r.zt - s.zt_count, ed = r.dt - (s.dt_count ?? 0), eb = r.zb - (s.zb_count ?? 0);
    sz += Math.abs(ez); sd += Math.abs(ed); sb += Math.abs(eb);
    console.log(`${d}  ${String(s.zt_count).padStart(4)}/${String(s.dt_count ?? '—').padStart(3)}/${String(s.zb_count ?? '—').padStart(3)}    ${String(r.zt).padStart(4)}/${String(r.dt).padStart(3)}/${String(r.zb).padStart(3)}    ${ez >= 0 ? '+' : ''}${ez}/${ed >= 0 ? '+' : ''}${ed}/${eb >= 0 ? '+' : ''}${eb}`);
  }
  if (n) console.log(`\n平均绝对误差: zt ${(sz / n).toFixed(1)}  dt ${(sd / n).toFixed(1)}  zb ${(sb / n).toFixed(1)}`);
  console.log('\n══ 断层日重建值 ══');
  for (const t of targets) {
    const r = rec[t];
    const zbl = (r.zt + r.zb) ? +(100 * r.zb / (r.zb + r.zt)).toFixed(1) : null;
    console.log(`${t}  zt=${String(r.zt).padStart(4)} dt=${String(r.dt).padStart(3)} zb=${String(r.zb).padStart(3)} → s_zdt≈${Math.round((r.zt + 2) / (r.zt + r.dt + 4) * 1000) / 10} s_zbl≈${zbl != null ? Math.round((100 - zbl * 2) * 10) / 10 : 50}`);
  }

  if (APPLY) {
    console.log('\n(--apply 模式待验证通过后启用)');
  }
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
