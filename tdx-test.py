# -*- coding: utf-8 -*-
"""pytdx 通达信数据源可行性验证：连接 → 板块指数列表 → 一年日线样例"""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from pytdx.hq import TdxHq_API

HOSTS = [
    ("119.147.212.81", 7709),
    ("114.80.63.12", 7709),
    ("114.80.63.35", 7709),
    ("180.153.18.170", 7709),
    ("180.153.18.171", 7709),
    ("202.108.25.130", 7709),
    ("122.51.120.217", 7709),
    ("106.14.201.131", 7709),
    ("111.229.247.189", 7709),
    ("124.71.187.122", 7709),
    ("124.71.187.102", 7709),
    ("124.71.187.20", 7709),
]

api = TdxHq_API()
connected = None
for host, port in HOSTS:
    try:
        if api.connect(host, port, time_out=6):
            connected = (host, port)
            print(f"[OK] 连接成功 {host}:{port}")
            break
        else:
            print(f"[--] 连接失败 {host}:{port}")
    except Exception as e:
        print(f"[--] 异常 {host}:{port}: {str(e)[:60]}")

if not connected:
    print("全部服务器连接失败")
    sys.exit(1)

try:
    # 1) 直接试拉已知 880 板块指数代码（通达信行业指数挂在市场0）
    test_codes = ["880323", "880310", "880301", "881121", "881156"]
    quotes = api.get_security_quotes([(0, c) for c in test_codes])
    print("行情快照:")
    for q in quotes or []:
        print(f"  {q['code']} {q['name']} close={q['price']}")
    ok_codes = [q["code"] for q in (quotes or []) if q.get("name")]

    # 2) 拉日线一年
    for tc in ["880323", "881121"]:
        print(f"拉取 {tc} 日线(市场0)...")
        bars = api.get_index_bars(9, 0, tc, 0, 260)
        if bars:
            print(f"  返回 {len(bars)} 根K线 · 首 {bars[0]['datetime']} close={bars[0]['close']} · 尾 {bars[-1]['datetime']} close={bars[-1]['close']}")
        else:
            print("  空")

    # 3) 板块信息文件（板块成分归属，可选验证）
    try:
        info = api.get_and_parse_block_info("block_zs.dat")
        print(f"block_zs.dat 板块成分: {len(info) if info else 0} 条")
        if info:
            print("样例:", info[:3])
    except Exception as e:
        print(f"block info 异常: {str(e)[:80]}")
finally:
    api.disconnect()
print("验证完成")
