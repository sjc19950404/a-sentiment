# -*- coding: utf-8 -*-
"""验证 v2: 本地 qfq K线库 + 比例判定(改进) → 重建 zt/dt/zb vs 东财池真实值
改进点: ①比例判定替代价格判定(ε=0.3% 吸收复权舍入) ②涨幅上界过滤除权虚高
        ③新股(分片前5根)跳过 ④ST 名称→5% 精确限幅
用法: python verify-rebuild-pools.py
"""
import json, glob, os

BASE = os.path.dirname(os.path.abspath(__file__))
os.chdir(os.path.join(BASE, '..'))

data = json.load(open('data.json', encoding='utf-8'))
truth = {}
for d in data['all_days']:
    s = d.get('summary') or {}
    if s.get('zt_count') is not None and s['zt_count'] > 0:
        truth[d['trade_date']] = s
want = set(truth.keys())

def lim_pct(code, name):
    if 'ST' in name.upper():
        return 5.0
    b = code[2:]
    if b.startswith(('688', '689')) or b.startswith('30'):
        return 20.0
    return 10.0

EPS = 0.003  # 0.3% 容差
rec = {d: {'zt': 0, 'dt': 0, 'zb': 0} for d in want}
shards = 0
for fp in glob.glob('kline/*.json'):
    if fp.endswith('_list.json'):
        continue
    try:
        shard = json.load(open(fp, encoding='utf-8'))
    except Exception:
        continue
    bars = shard.get('bars') or []
    if len(bars) < 2:
        continue
    shards += 1
    code, name = shard['c'], shard.get('n', '')
    L = lim_pct(code, name) / 100.0
    HI = L + 0.05   # 上界: 超过 lim+5% 视为除权虚高, 跳过
    LO = -(L + 0.05)
    for i in range(1, len(bars)):
        b, pb = bars[i], bars[i - 1]
        date = b[0]
        if date not in want:
            continue
        if i < 5:      # 新股上市前5日无涨跌幅限制
            continue
        pc = pb[2]
        if not pc or pc <= 0:
            continue
        c, h, l = b[2], b[3], b[4]
        r = c / pc - 1          # 收盘涨跌幅(qfq 比例)
        rh = h / pc - 1         # 最高涨跌幅
        rl = l / pc - 1         # 最低涨跌幅
        if r > HI or rl < LO:   # 除权日虚高/异常, 整票跳过
            continue
        t = rec[date]
        if r >= L - EPS:
            t['zt'] += 1
        elif rh >= L - EPS:     # 盘中触板未封 = 炸板
            t['zb'] += 1
        if r <= -(L - EPS):
            t['dt'] += 1

print(f'分片: {shards} · 基准日: {len(want)}')
print('日期         真实 zt/dt/zb      重建 zt/dt/zb      误差')
tz = td = tb = 0
for d in sorted(want):
    s = truth[d]
    r = rec[d]
    ez, ed, eb = r['zt'] - s['zt_count'], r['dt'] - (s.get('dt_count') or 0), r['zb'] - (s.get('zb_count') or 0)
    tz += abs(ez); td += abs(ed); tb += abs(eb)
    print(f"{d}  {s['zt_count']:>4}/{str(s.get('dt_count') or '—'):>3}/{str(s.get('zb_count') or '—'):>3}    {r['zt']:>4}/{r['dt']:>3}/{r['zb']:>3}    {ez:+d}/{ed:+d}/{eb:+d}")
n = len(want)
print(f'\n平均绝对误差: zt {tz/n:.1f}  dt {td/n:.1f}  zb {tb/n:.1f}')
# 误差 → s_zdt/s_zbl 传导评估
print('\n=== 情绪因子传导(s_zdt/s_zbl 真实 vs 重建) ===')
dz = db = 0.0
for d in sorted(want):
    s = truth[d]
    r = rec[d]
    sz_t = (s['zt_count'] + 2) / (s['zt_count'] + (s.get('dt_count') or 0) + 4) * 100
    sz_r = (r['zt'] + 2) / (r['zt'] + r['dt'] + 4) * 100
    zt0, zb0 = s['zt_count'], (s.get('zb_count') or 0)
    zbl_t = 100 - (100 * zb0 / (zb0 + zt0) * 2) if (zb0 + zt0) else 50
    zbl_r = 100 - (100 * r['zb'] / (r['zb'] + r['zt']) * 2) if (r['zb'] + r['zt']) else 50
    dz += abs(sz_r - sz_t); db += abs(min(max(zbl_r, 0), 100) - min(max(zbl_t, 0), 100))
    print(f"{d}  s_zdt {sz_t:.1f}→{sz_r:.1f} (Δ{sz_r-sz_t:+.1f})  s_zbl {max(min(zbl_t,100),0):.1f}→{max(min(zbl_r,100),0):.1f} (Δ{zbl_r-zbl_t:+.1f})")
print(f'\n平均 |Δs_zdt| = {dz/n:.2f} 分(权15% → 情绪值传导 {dz/n*0.15:.2f} 分)')
print(f'平均 |Δs_zbl| = {db/n:.2f} 分(权10% → 情绪值传导 {db/n*0.10:.2f} 分)')
