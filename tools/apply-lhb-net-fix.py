# -*- coding: utf-8 -*-
# v4.9.3 龙虎榜净额口径修正: 按股去重求和（lhb_aggr 每股取绝对值最大榜单为代表）
# 全档重算: summary.net_total_yi/net_pos/net_neg + lhb_stocks_hs + emotion(s_net/value) + recalcRanks
# 用法: python tools/apply-lhb-net-fix.py   （自动备份 data.backup-pre-lhbfix.json）
import json, shutil, math, os, datetime

os.chdir(os.path.join(os.path.dirname(__file__), '..'))
BK = 'data.backup-pre-lhbfix.json'
shutil.copyfile('data.json', BK)
D = json.load(open('data.json', encoding='utf-8'))

def jsround(x, nd):   # 复刻 JS Math.round(floor(x*10^nd+0.5)/10^nd)
    p = 10 ** nd
    return math.floor(x * p + 0.5) / p
def r1(x): return jsround(x, 1)
def r2(x): return jsround(x, 2)
def clamp(x, a, b): return max(a, min(b, x))

n = 0
for day in D['all_days']:
    ag = day.get('lhb_aggr') or []
    s = day.get('summary') or {}
    e = day.get('emotion') or {}
    if not ag:
        print('跳过(无 aggr):', day['trade_date']); continue
    net = r2(sum(a.get('net_buy_wan') or 0 for a in ag) / 1e4)
    pos = len([a for a in ag if (a.get('net_buy_wan') or 0) > 0])
    neg = len([a for a in ag if (a.get('net_buy_wan') or 0) < 0])
    old_net = s.get('net_total_yi')
    s['net_total_yi'] = net; s['net_pos'] = pos; s['net_neg'] = neg
    s['lhb_stocks_hs'] = len([a for a in ag if not str(a['code']).startswith('92')])
    rb = s.get('_rebuild') or []
    if 'lhb_net' not in rb:
        rb.append('lhb_net'); s['_rebuild'] = rb
    e['net_total_yi'] = net
    e['s_net'] = clamp(r1(net * 2 + 50), 0, 100)
    e['s_pos'] = r1(pos / ((pos + neg) or 1) * 100)
    e['pos_ratio'] = e['s_pos']
    e['value'] = r1((e['s_net'] * 20 + e['s_pos'] * 10 + e['s_brd'] * 20 + e['s_hot'] * 10
                     + e['s_zdt'] * 15 + e['s_zbl'] * 10 + e['s_amt'] * 15) / 100)
    n += 1
    print(f"{day['trade_date']}  净额 {old_net}→{net} 亿 · 净买/卖 {s.get('_old', '')}{pos}/{neg} 家 · 情绪 → {e['value']}")

# recalcRanks 复刻（仅真实天数）
days = D['all_days']
realDays = [d for d in days if d.get('emotion') and not ((d.get('summary') or {}).get('_missing') or [])]
def rank(vals, v):
    srt = sorted(vals)
    return srt.index(v) / max(len(srt) - 1, 1) * 100
vs = [d['emotion']['value'] for d in realDays]
ns = [d['emotion']['net_total_yi'] for d in realDays]
for d in days:
    e = d.get('emotion')
    if not e: continue
    miss = ((d.get('summary') or {}).get('_missing') or [])
    if miss:
        e['pct_rank'] = None; e['net_pct_rank'] = None
    else:
        e['pct_rank'] = r1(rank(vs, e['value']))
        e['net_pct_rank'] = r1(rank(ns, e['net_total_yi']))

dq = D['meta'].setdefault('dataQuality', {})
dq['formulaVersion'] = 'v4.9.3'
h = dq.get('health')
if h is not None:
    h['checkedAt'] = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z')
dq['formulaNote'] = (dq.get('formulaNote') or '') + ('; ' if dq.get('formulaNote') else '') + \
    'lhb 净额口径修正(2026-09-28): net_total_yi/net_pos/net_neg 由按行(股票×上榜原因)求和改为按股去重求和(lhb_aggr 每股取绝对值最大榜单为代表), 多榜股重复计入消除(9/28 -1.17→-0.61 亿); summary.lhb_stocks_hs=沪深口径(剔北交所)与外部通用统计可比; 全档 s_net/value/分位联动重算'

json.dump(D, open('data.json', 'w', encoding='utf-8'), ensure_ascii=False)
print(f'\n完成 {n} 天 · 备份 {BK}')
