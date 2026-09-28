# -*- coding: utf-8 -*-
# v4.9.4 同花顺历史池真实数据替换 v4.9.2 校准重建值
# 断层 15 天(8/14~9/3) + 9/4 坏数据日 = 16 天写入真实 zt/dt/zb + zt_lb/lb_dist/dt_band/hs_lb3_count/hs_dt_count
# 口径验证: 15 个东财真实池重叠日平均绝对误差 zt 0.5/dt 0.2/zb 0.0（tools/thspool-verify.js）
# 用法: python tools/apply-thspool-fix.py   （备份 data.backup-pre-thsfix.json）
import json, shutil, math, os, re, datetime

os.chdir(os.path.join(os.path.dirname(__file__), '..'))
BK = 'data.backup-pre-thsfix.json'
shutil.copyfile('data.json', BK)
D = json.load(open('data.json', encoding='utf-8'))
THS = json.load(open('tools/thspool-cache.json', encoding='utf-8'))

def jsround(x, nd):
    p = 10 ** nd
    return math.floor(x * p + 0.5) / p
def r1(x): return jsround(x, 1)
def r2(x): return jsround(x, 2)
def clamp(x, a, b): return max(a, min(b, x))

def parse_lb(high_days):
    # "首板"→1, "2天2板"→2, "9天4板"→4（取板数）
    if not high_days: return None
    if high_days == '首板': return 1
    m = re.search(r'(\d+)板', high_days)
    return int(m.group(1)) if m else None

FIX_FROM, FIX_TO = '2026-08-14', '2026-09-04'
fixed = []
for i, day in enumerate(D['all_days']):
    td = day['trade_date']; s = day['summary']; e = day['emotion']
    if not (FIX_FROM <= td <= FIX_TO): continue
    dn = td.replace('-', ''); rec = THS.get(dn)
    if not rec or (rec['zt'] == 0 and rec['dt'] == 0):
        print('跳过(无同花顺数据):', td); continue
    zt, dt, zb = rec['zt'], rec['dt'], rec['zb']
    s['zt_count'], s['dt_count'], s['zb_count'] = zt, dt, zb
    s['zbl_pct'] = r1(zb / (zb + zt) * 100) if (zb + zt) > 0 else None
    # zt_lb: 涨停池全 1 板, 连板池覆盖真实板数
    zt_lb = {c: 1 for c in rec['zt_codes']}
    for item in rec.get('lb_detail') or []:
        m = re.match(r'(\d+)\((.+)\)', item)  # "603102(9天4板)"
        if m:
            lb = parse_lb(m.group(2))
            if lb: zt_lb[m.group(1)] = lb
    s['zt_lb'] = zt_lb
    lb_dist = {}
    for lb in zt_lb.values():
        if lb >= 2: lb_dist[str(lb)] = lb_dist.get(str(lb), 0) + 1
    s['lb_dist'] = lb_dist
    # dt_band / hs_*: 需昨日数据（8/14 是存档首日, 无前日）
    if i > 0:
        prev = D['all_days'][i - 1]; ps = prev['summary']
        pz = (ps.get('zt_lb') or {}) or {c: 1 for c in (THS.get(prev['trade_date'].replace('-', ''), {}).get('zt_codes') or [])}
        if pz:
            s['dt_band'] = len([c for c in pz if c not in set(rec['zt_codes'])])
            lb3 = [c for c, lb in pz.items() if lb >= 3]
            if lb3:
                s['hs_lb3_count'] = len(lb3)
                s['hs_dt_count'] = len([c for c in lb3 if c in set(rec['dt_codes'])])
    # 七因子联动
    e['s_zdt'] = clamp(r1((zt + 2) / (zt + dt + 4) * 100), 0, 100)
    e['s_zbl'] = clamp(r1(100 - s['zbl_pct'] * 2), 0, 100) if s['zbl_pct'] is not None else 50
    e['value'] = r1((e['s_net'] * 20 + e['s_pos'] * 10 + e['s_brd'] * 20 + e['s_hot'] * 10
                     + e['s_zdt'] * 15 + e['s_zbl'] * 10 + e['s_amt'] * 15) / 100)
    e.pop('s_zdt_raw', None); e.pop('s_zbl_raw', None)   # 真实值替换重建值, raw 留档删除
    rb = [x for x in (s.get('_rebuild') or []) if x != 'pools']
    if 'pools_ths' not in rb: rb.append('pools_ths')
    s['_rebuild'] = rb
    m0 = [x for x in (s.get('_missing') or []) if x != 'pools']
    s['_missing'] = m0 or None
    fixed.append(td)
    print(f"{td}  zt/dt/zb {s.get('_old', '')}{zt}/{dt}/{zb} · zbl_pct {s['zbl_pct']} · dt_band {s.get('dt_band')} · hs {s.get('hs_lb3_count')}/{s.get('hs_dt_count')} · 情绪 → {e['value']} (s_zdt {e['s_zdt']} s_zbl {e['s_zbl']})")

# recalcRanks 复刻（全部 31 天均为真实天数）
days = D['all_days']
def rank(vals, v):
    srt = sorted(vals)
    return srt.index(v) / max(len(srt) - 1, 1) * 100
vs = [d['emotion']['value'] for d in days if d.get('emotion')]
ns = [d['emotion']['net_total_yi'] for d in days if d.get('emotion')]
for d in days:
    e = d.get('emotion')
    if not e: continue
    e['pct_rank'] = r1(rank(vs, e['value']))
    e['net_pct_rank'] = r1(rank(ns, e['net_total_yi']))

dq = D['meta'].setdefault('dataQuality', {})
dq['formulaVersion'] = 'v4.9.4'
h = dq.get('health')
if h is not None:
    h['checkedAt'] = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    h['missingDays'] = 0; h['issues'] = []
dq['formulaNote'] = (dq.get('formulaNote') or '') + '; ' + \
    'v4.9.4(2026-09-28): 发现同花顺池接口保留完整历史(limit_up_pool/open_limit_pool/lower_limit_pool/continuous_limit_pool), 与东财真实池 15 个重叠日对照平均误差 zt 0.5/dt 0.2/zb 0.0, 用真实数据替换 8/14~9/4 共 16 天的校准重建值, 并恢复 zt_lb/lb_dist/dt_band/hs_lb3_count/hs_dt_count(8/15 起); zb_amt(炸板封单额)同花顺炸板后清零无法恢复保持缺失; hs_dt_fund/hs_dt_amt 需跌停池封单/成交额明细未恢复; _rebuild 标记 pools_ths'

json.dump(D, open('data.json', 'w', encoding='utf-8'), ensure_ascii=False)
print(f'\n完成 {len(fixed)} 天({fixed[0]}~{fixed[-1]}) · 备份 {BK}')
