# -*- coding: utf-8 -*-
"""pytdx 扩展行情验证：通达信 880/881 板块指数在扩展行情市场"""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from pytdx.exhq import TdxExHq_API

HOSTS = [
    ("119.147.212.81", 7727),
    ("180.153.39.51", 7727),
    ("114.80.63.12", 7727),
    ("122.51.120.217", 7727),
    ("106.14.201.131", 7727),
    ("111.229.247.189", 7727),
    ("124.71.187.122", 7727),
    ("124.71.187.102", 7727),
    ("124.71.187.20", 7727),
    ("47.103.48.45", 7727),
    ("110.41.147.114", 7727),
    ("124.71.187.122", 7727),
]

api = TdxExHq_API()
connected = None
for host, port in HOSTS:
    try:
        if api.connect(host, port, time_out=6):
            connected = (host, port)
            print(f"[OK] 扩展行情连接成功 {host}:{port}")
            break
    except Exception as e:
        print(f"[--] {host}:{port}: {str(e)[:60]}")

if not connected:
    print("全部扩展服务器连接失败")
    sys.exit(1)

try:
    markets = api.get_markets()
    print(f"扩展市场 {len(markets)} 个:")
    for m in markets:
        print(f"  {m['name']} 代码前缀区间 {m['range']} 短名 {m['short_name']} 市场号 {m['market']}")
finally:
    api.disconnect()
print("验证完成")
