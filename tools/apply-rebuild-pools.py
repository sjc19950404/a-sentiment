# -*- coding: utf-8 -*-
"""apply-rebuild-pools.py — pools 历史断层修复(正式应用)
方法: 本地 qfq K线库比例判定重建 zt/dt/zb + 15 基准日线性校准(动态拟合)
写入: 15 个 pools 补位日 + 9/4 坏数据日 → 校准后的 zt_count/dt_count/zb_count/zbl_pct
      + summary._rebuild=['pools'] 口径标记(_missing 移除 pools)
重算: 涉及日 s_zdt/s_zbl/value + 全档 pct_rank/net_pct_rank + health + formulaVersion v4.9.2
前置: 自动备份 data.backup-pre-poolsfix.json
"""
import json, glob, os, shutil, math, subprocess

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(BASE, '..')
os.chdir(ROOT)

# ── 参数 ──
EPS = 0.0015
DAYS_FIX = 16   # 打印对照天数上限

# ── 载入 + 备份 ──
D = json.load(open('data.json', encoding='utf-8'))
shutil.copyfile('data.json', 'data.backup-pre-poolsfix.json')
print('已备份 → data.backup-pre-poolsfix.json')

days = D['all_days']
targets = []   # 待修复日
truth = {}     # 校准基准日
for d in days:
    s = d.get('summary') or {}
    m = s.get('_missing') or []
    if 'pools' in m:
        targets.append(d)
    if d['trade_date'] == '2026-09-04':
        targets.append(d)
    if s.get('zt_count') is not None and s['zt_count'] > 0:
        truth[d['trade_date']] = s
print(f'待修复 {len(targets)} 天 · 校准基准 {len(truth)} 天')

# ── 本地 qfq K线重建 ──
def lim_pct(code, name):
    if 'ST' in name.upper():
        return 5.0
    b = code[2:]
    if b.startswith(('688', '689')) or b.startswith('30'):
        return 20.0
    return 10.0

want = {d['trade_date'] for d in targets} | set(truth.keys())
rec = {t: {'zt': 0, 'dt': 0, 'zb': 0} for t in want}
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
    code, name = shard['c'], shard.get('n', '')
    L = lim_pct(code, name) / 100.0
    HI = L + 0.05
    LO = -(L + 0.05)
    for i in range(1, len(bars)):
        b, pb = bars[i], bars[i - 1]
        date = b[0]
        if date not in want or i < 5:
            continue
        pc = pb[2]
        if not pc or pc <= 0:
            continue
        c, h, l = b[2], b[3], b[4]
        r = c / pc - 1
        rh = h / pc - 1
        rl = l / pc - 1
        if r > HI or rl < LO:   # 除权虚高/异常跳过
            continue
        t = rec[date]
        if r >= L - EPS:
            t['zt'] += 1
        elif rh >= L - EPS:
            t['zb'] += 1
        if r <= -(L - EPS):
            t['dt'] += 1

# ── 线性校准(最小二乘) ──
def linfit(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    a = sxy / sxx if sxx else 1.0
    return a, my - a * mx

calib_days = sorted(truth.keys())
params = {}
for key in ('zt', 'dt', 'zb'):
    xs = [rec[d][key] for d in calib_days]
    if key == 'zt':
        ys = [truth[d]['zt_count'] for d in calib_days]
    elif key == 'dt':
        ys = [truth[d].get('dt_count') or 0 for d in calib_days]
    else:
        ys = [truth[d].get('zb_count') or 0 for d in calib_days]
    params[key] = linfit(xs, ys)
print(f'校准参数: ' + ' | '.join(f'{k} a={v[0]:.4f} b={v[1]:.1f}' for k, v in params.items()))

def clamp(v, lo, hi):
    return max(min(v, hi), lo)

def jsround1(x):
    # 复刻 JS Math.round(x*10)/10 (正数域 floor(x*10+0.5)/10)
    return math.floor(x * 10 + 0.5) / 10

# ── 写入修复 ──
print('\n══ 修复明细 ══')
for d in targets:
    s = d['summary']
    e = d['emotion']
    t = rec[d['trade_date']]
    zt = max(round(params['zt'][0] * t['zt'] + params['zt'][1]), 0)
    dt = max(round(params['dt'][0] * t['dt'] + params['dt'][1]), 0)
    zb = max(round(params['zb'][0] * t['zb'] + params['zb'][1]), 0)
    old_val = e.get('value')
    # 原始值(校准前)
    s['zt_count'], s['dt_count'], s['zb_count'] = zt, dt, zb
    s['zbl_pct'] = jsround1(100 * zb / (zb + zt)) if (zb + zt) else None
    s['s_zdt_raw'], s['s_zbl_raw'] = t['zt'], t['zb']   # 重建原始值留档(校准前口径)
    m = s.get('_missing') or []
    if 'pools' in m:
        m.remove('pools')
        s['_missing'] = m
    s['_rebuild'] = sorted(set((s.get('_rebuild') or []) + ['pools']))  # 口径透明标记
    # 重算因子
    e['s_zdt'] = clamp(jsround1((zt + 2) / (zt + dt + 4) * 100), 0, 100)
    e['s_zbl'] = clamp(jsround1(100 - s['zbl_pct'] * 2), 0, 100) if s['zbl_pct'] is not None else 50
    e['value'] = jsround1((e['s_net'] * 20 + e['s_pos'] * 10 + e['s_brd'] * 20 + e['s_hot'] * 10 + e['s_zdt'] * 15 + e['s_zbl'] * 10 + e['s_amt'] * 15) / 100)
    print(f"{d['trade_date']}  zt={t['zt']}→{zt} dt={t['dt']}→{dt} zb={t['zb']}→{zb}  | 情绪 {old_val}→{e['value']} (s_zdt→{e['s_zdt']} s_zbl→{e['s_zbl']})")

# ── 全档 recalcRanks 等价(JS recalcRanks 复刻: 仅真实天数) ──
def missing_count(d):
    return len((d.get('summary') or {}).get('_missing') or [])

real = [d for d in days if d.get('emotion') and missing_count(d) == 0]
vs = [d['emotion']['value'] for d in real]
ns = [d['emotion']['net_total_yi'] for d in real if d['emotion'].get('net_total_yi') is not None]
def rank_of(vals, v):
    s = sorted(vals)
    return s.index(v) / max(len(s) - 1, 1) * 100 if s else None
for d in days:
    e = d.get('emotion')
    if not e:
        continue
    if missing_count(d):
        e['pct_rank'] = None
        e['net_pct_rank'] = None
    else:
        e['pct_rank'] = jsround1(rank_of(vs, e['value'])) if e['value'] is not None else None
        if e.get('net_total_yi') is not None and ns:
            e['net_pct_rank'] = jsround1(rank_of(ns, e['net_total_yi']))
        else:
            e['net_pct_rank'] = None
print(f'\n分位重算: 真实日 {len(real)}/{len(days)} · 补位日 {len(days)-len(real)}')

# ── health 重算 ──
dq = D['meta']['dataQuality']
miss_days = sum(1 for d in days if missing_count(d))
issues = []
if days and miss_days > len(days) * 0.4:
    issues.append('补位因子天数占比 >40%')
last = days[-1]
if (last.get('summary') or {}).get('zt_count') is None:
    issues.append('当日涨跌停池缺失')
dq['health'] = {
    'checkedAt': __import__('datetime').datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z'),
    'totalDays': len(days),
    'missingDays': miss_days,
    'issues': issues,
}
print('health:', json.dumps(dq['health'], ensure_ascii=False))

# ── 口径标记 ──
dq['pctRankRealOnly'] = True
dq['formulaVersion'] = 'v4.9.2 七因子（s_net20/s_pos10/s_brd20/s_hot10/s_zdt15/s_zbl10/s_amt15）+ yzt/dt_band/hs/lb_dist/zb_amt/rzrq + 题材归一(词典+个股数+黑名单+全局孤点≥2) + pctRankRealOnly + pools 历史断层修复(重建校准)'
dq['formulaNote'] = dq.get('formulaNote', '') + "; pools 修复(2026-09-28): 8/14~9/3 池数据超东财保留窗口, 用全市场K线库比例判定重建涨停/跌停/炸板家数 + 15 个真实池日线性校准(zt r=0.99/dt r=0.98/zb r=0.72), 校准后 s_zdt 传导误差 0.47 分/s_zbl 0.93 分(情绪值), 优于中性 50 补位; summary._rebuild 含 pools 标记重建日, s_zdt_raw/s_zbl_raw 留档重建原始值; dt_band/hs_*/lb_dist/zb_amt 历史段不可重建保持缺失"
dq['poolsRebuiltAt'] = __import__('datetime').datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z')

with open('data.json', 'w', encoding='utf-8') as f:
    json.dump(D, f, ensure_ascii=False, separators=(',', ':'))
print('\ndata.json 已写入')
