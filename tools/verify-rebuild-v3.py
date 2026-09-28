# -*- coding: utf-8 -*-
"""验证 v3: 本地 qfq + 紧 ε + 线性回归校准 → 评估校准后残差与情绪因子传导误差
回归: real ≈ a×rebuild + b (15 基准日最小二乘); 输出 leave-one-out 稳健性
"""
import json, glob, os

BASE = os.path.dirname(os.path.abspath(__file__))
os.chdir(os.path.join(BASE, '..'))

EPS = 0.0015  # 0.15% 容差(v3 收紧)

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

rec = {d: {'zt': 0, 'dt': 0, 'zb': 0} for d in want}
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
        if r > HI or rl < LO:
            continue
        t = rec[date]
        if r >= L - EPS:
            t['zt'] += 1
        elif rh >= L - EPS:
            t['zb'] += 1
        if r <= -(L - EPS):
            t['dt'] += 1

days = sorted(want)

def linfit(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    a = sxy / sxx if sxx else 1.0
    return a, my - a * mx

def corr(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return sxy / ((sxx * syy) ** 0.5) if sxx and syy else 0

print('=== 各量相关性 + 校准(去一法 leave-one-out 稳健性) ===')
for key in ('zt', 'dt', 'zb'):
    xs = [rec[d][key] for d in days]
    ys = [(truth[d]['zt_count'] if key == 'zt' else truth[d].get('dt_count') or 0) if key != 'zb' else (truth[d].get('zb_count') or 0) for d in days]
    if key == 'zt':
        ys = [truth[d]['zt_count'] for d in days]
    c = corr(xs, ys)
    a, b = linfit(xs, ys)
    # leave-one-out 最大残差
    worst = 0.0
    for i in range(len(days)):
        xi = xs[:i] + xs[i + 1:]
        yi = ys[:i] + ys[i + 1:]
        ai, bi = linfit(xi, yi)
        pred = ai * xs[i] + bi
        worst = max(worst, abs(pred - ys[i]))
    fitted = [a * x + b for x in xs]
    resid = [abs(f - y) for f, y in zip(fitted, ys)]
    print(f"{key}: 相关性 r={c:.4f}  校准 real={a:.4f}×rec+{b:.1f}  平均|残差|={sum(resid)/len(resid):.1f}  LOO最大|残差|={worst:.1f}")

# 校准后 s_zdt/s_zbl 传导误差
print('\n=== 校准后情绪因子传导 ===')
params = {}
for key in ('zt', 'dt', 'zb'):
    xs = [rec[d][key] for d in days]
    if key == 'zt':
        ys = [truth[d]['zt_count'] for d in days]
    elif key == 'dt':
        ys = [truth[d].get('dt_count') or 0 for d in days]
    else:
        ys = [truth[d].get('zb_count') or 0 for d in days]
    params[key] = linfit(xs, ys)

dz = db = 0.0
rows = []
for d in days:
    s = truth[d]
    zt_r = max(round(params['zt'][0] * rec[d]['zt'] + params['zt'][1]), 0)
    dt_r = max(round(params['dt'][0] * rec[d]['dt'] + params['dt'][1]), 0)
    zb_r = max(round(params['zb'][0] * rec[d]['zb'] + params['zb'][1]), 0)
    sz_t = (s['zt_count'] + 2) / (s['zt_count'] + (s.get('dt_count') or 0) + 4) * 100
    sz_c = (zt_r + 2) / (zt_r + dt_r + 4) * 100
    zt0, zb0 = s['zt_count'], (s.get('zb_count') or 0)
    zbl_t = min(max(100 - (100 * zb0 / (zb0 + zt0) * 2) if (zb0 + zt0) else 50, 0), 100)
    zbl_c = min(max(100 - (100 * zb_r / (zb_r + zt_r) * 2) if (zb_r + zt_r) else 50, 0), 100)
    dz += abs(sz_c - sz_t); db += abs(zbl_c - zbl_t)
    rows.append(f"{d}  s_zdt {sz_t:.1f}→{sz_c:.1f}(Δ{sz_c-sz_t:+.1f})  s_zbl {zbl_t:.1f}→{zbl_c:.1f}(Δ{zbl_c-zbl_t:+.1f})")
print('\n'.join(rows))
print(f'\n校准后平均 |Δs_zdt| = {dz/len(days):.2f} 分 → 情绪值传导 {dz/len(days)*0.15:.2f} 分')
print(f'校准后平均 |Δs_zbl| = {db/len(days):.2f} 分 → 情绪值传导 {db/len(days)*0.10:.2f} 分')
print(f'\n校准参数: zt a={params["zt"][0]:.4f} b={params["zt"][1]:.1f} | dt a={params["dt"][0]:.4f} b={params["dt"][1]:.1f} | zb a={params["zb"][0]:.4f} b={params["zb"][1]:.1f}')
