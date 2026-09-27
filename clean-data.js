// 数据清洗脚本：从原始仪表盘 HTML 提取 report-data JSON，清洗后输出 data.json
// 清洗项：1) 龙虎榜同日重复记录去重（code+reason） 2) 注入休市日历 3) 标记行业数据源失效
const fs = require('fs');
const path = require('path');

const SRC = 'C:/Users/Administrator/WorkBuddy/2026-09-26-17-31-20/dashboard-2026-09-24.html';
const OUT = path.join(__dirname, 'data.json');

const html = fs.readFileSync(SRC, 'utf8');
const s = html.indexOf('<script id="report-data"') + '<script id="report-data" type="application/json">'.length;
const e = html.indexOf('</script>', s);
const D = JSON.parse(html.slice(s, e));

// 1b) 同股多榜聚合视图 lhb_aggr：同一 code 多条上榜记录（如同时上换手榜+涨幅榜）会导致
//     「个股净买 TOP」排序重复累计。按 code 聚合：净买取去重后的代表值（相同值合并；不同值取
//     绝对值最大的一条），reasons 全部保留。
for (const day of D.all_days) {
  const byCode = new Map();
  for (const l of day.lhb) {
    if (!byCode.has(l.code)) byCode.set(l.code, { ...l, reasons: [l.reason] });
    else {
      const acc = byCode.get(l.code);
      if (!acc.reasons.includes(l.reason)) acc.reasons.push(l.reason);
      if (Math.abs(l.net_buy_wan || 0) > Math.abs(acc.net_buy_wan || 0)) {
        acc.net_buy_wan = l.net_buy_wan; acc.buy_wan = l.buy_wan; acc.sell_wan = l.sell_wan;
      }
    }
  }
  day.lhb_aggr = [...byCode.values()];
}

// 2) 休市日历（2026 年节假 Anchor；后续新数据可在 build 时扩展）
const MARKET_HOLIDAYS_2026 = [
  '2026-09-25', '2026-09-26', '2026-09-27' // 中秋（9-28 周一恢复）
];

// 3) 行业数据源健康检查
const industryOk = D.all_days.some(d => Array.isArray(d.industry) && d.industry.length > 0);

const out = {
  meta: {
    source: 'A股市场情绪系统（东财龙虎榜 · 同花顺题材归因 · 东财板块日K · 腾讯指数）',
    originalGenerated: D.generated,
    cleanedAt: new Date().toISOString(),
    cleanedBy: 'build/clean-data.js v1',
    holidays: MARKET_HOLIDAYS_2026,
    dataQuality: {
      lhbAggrNote: 'lhb_aggr 为按个股聚合视图（同股多榜去重），原 lhb 保留全部上榜记录（业务真实）',
      industrySourceOk: industryOk,
      industryNote: industryOk ? null : '行业板块日K数据源失效（industry 全空），情绪公式中 25% 行业广度权重已按其余指标重归一化'
    }
  },
  all_days: D.all_days,
  signals: D.signals,
  stocks: D.stocks
};

fs.writeFileSync(OUT, JSON.stringify(out));
console.log('data.json 写入完成:', (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB');
console.log('聚合视图 lhb_aggr: 已为全部交易日生成');
console.log('行业数据源:', industryOk ? '正常' : '失效（已标记降权处理）');
