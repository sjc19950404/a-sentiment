# -*- coding: utf-8 -*-
"""pytdx K线参数排查：category 枚举 × 市场枚举 × 代码枚举"""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from pytdx.hq import TdxHq_API

api = TdxHq_API()
if not api.connect("119.97.185.59", 7709, time_out=8):
    if not api.connect("124.71.187.122", 7709, time_out=8):
        print("连接失败")
        sys.exit(1)
print("已连接")

try:
    # category 枚举 × 代码组合
    combos = [
        (0, "399001"), (0, "880323"), (0, "000001"),
        (1, "000001"), (1, "399001"), (1, "880323"),
    ]
    for cat in [4, 9]:
        for mkt, code in combos:
            bars = api.get_index_bars(cat, mkt, code, 0, 5)
            n = len(bars) if bars else 0
            tag = ""
            if n:
                tag = f"尾{bars[-1]['datetime']} close={bars[-1]['close']}"
            print(f"cat={cat} mkt={mkt} {code} → {n} {tag}")

    # get_security_quotes 多市场
    for mkt, code in [(0, "000001"), (1, "600000"), (0, "399001"), (0, "880323")]:
        q = api.get_security_quotes([(mkt, code)])
        if q:
            print(f"quote mkt={mkt} {code} → name={q[0].get('name')} price={q[0].get('price')}")
        else:
            print(f"quote mkt={mkt} {code} → 空")

    # get_security_bars (个股) 验证
    bars = api.get_security_bars(4, 1, "600000", 0, 5)
    print(f"个股600000日线(sec_bars): {len(bars) if bars else 0} 根")
finally:
    api.disconnect()
print("排查完成")
