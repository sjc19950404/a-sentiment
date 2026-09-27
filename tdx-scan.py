# -*- coding: utf-8 -*-
"""pytdx 普通行情验证：get_index_bars 是否可用 + 多服务器找 880 板块指数"""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from pytdx.hq import TdxHq_API

HOSTS = [
    ("180.153.18.170", 7709),
    ("180.153.18.171", 7709),
    ("119.97.185.59", 7709),
    ("106.14.201.131", 7709),
    ("122.51.120.217", 7709),
    ("111.229.247.189", 7709),
    ("124.71.187.122", 7709),
    ("124.71.187.102", 7709),
    ("124.71.187.20", 7709),
    ("47.103.48.45", 7709),
    ("110.41.147.114", 7709),
    ("114.80.63.12", 7709),
    ("218.108.98.244", 7709),
    ("218.108.47.69", 7709),
    ("61.152.230.45", 7709),
    ("61.135.142.73", 7709),
    ("115.238.56.198", 7709),
    ("115.238.90.165", 7709),
]

api = TdxHq_API()
ok = []
for host, port in HOSTS:
    try:
        if api.connect(host, port, time_out=5):
            ok.append((host, port))
            api.disconnect()
            print(f"[OK] {host}:{port}")
    except Exception as e:
        print(f"[--] {host}: {str(e)[:50]}")

print(f"可用服务器 {len(ok)} 台: {ok[:5]}")
if not ok:
    sys.exit(1)

api.connect(*ok[0], time_out=8)
try:
    # 1) 基线验证: 深证成指 399001 (市场0)
    bars = api.get_index_bars(9, 0, "399001", 0, 10)
    print(f"基线 399001: {'返回 ' + str(len(bars)) + ' 根' if bars else '空'}")
    if bars:
        print(f"  尾K线: {bars[-1]['datetime']} close={bars[-1]['close']}")

    # 2) 在每台可用服务器上试 880323 (通达信板块指数, 市场挂0)
    api.disconnect()
    for host, port in ok:
        try:
            api.connect(host, port, time_out=5)
            bars = api.get_index_bars(9, 0, "880323", 0, 5)
            q = api.get_security_quotes([(0, "880323")])
            name = q[0].get("name", "?") if q else "?"
            n = len(bars) if bars else 0
            print(f"{host}: 880323 → K线 {n} 根, 名称「{name}」")
            api.disconnect()
            if n:
                print("  找到可用服务器, 停止扫描")
                break
        except Exception as e:
            print(f"{host}: 异常 {str(e)[:50]}")
            try:
                api.disconnect()
            except Exception:
                pass
finally:
    try:
        api.disconnect()
    except Exception:
        pass
print("验证完成")
