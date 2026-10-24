# -*- coding: utf-8 -*-
"""
麦当劳点餐助手 · 本地后端（零依赖）

为什么要有这个进程：
    MCP 的 Token 绝对不能进浏览器。浏览器一旦直连 mcp.mcd.cn，F12 就能抄走 Token。
    所以 MCP 调用只能发生在机器本地的这个进程里，浏览器通过
    http://127.0.0.1:<port>/api/* 跟它说话，永远拿不到 Token。

    ┌─────────┐  127.0.0.1    ┌──────────────┐  Bearer Token  ┌─────────────┐
    │ 浏览器  │ ───────────► │  server.py   │ ─────────────► │ mcp.mcd.cn  │
    └─────────┘  只到本机     └──────────────┘                └─────────────┘

跑起来：
    python server.py                 # 默认端口 8787
    python server.py --port 9000

安全红线（每条都由 tools/check_release.py 复查）：
    1. 绝不提供 create-order 或任何下单路由 —— 本文件里没有，也不会有
    2. Token 只存在于本进程内存，任何响应都不回传 token 字段
    3. 图片代理只允许麦当劳官方域名白名单，不做开放代理
"""

import argparse
import glob
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0]
sys.path.insert(0, ROOT + "/tools")
try:
    from mcp_client import Mcd
except ImportError:
    from tools.mcp_client import Mcd

# ------------------------------------------------------------ 常量

DEFAULT_PORT = 8787
STORE_CODE_DEFAULT = "1400028"          # 麦当劳广州新港西路餐厅

# 图片代理白名单：只放行麦当劳官方 CDN，绝不做开放代理
IMG_HOSTS = (
    "menu-img.mcd.cn", "img.mcd.cn", "cms-cdn.mcd.cn",
    "mcd-portal-prod-cos1-1300270282.cos.ap-shanghai.myqcloud.com",
)

# 无论怎么改，这个名单上的工具本服务一律不代理
FORBIDDEN_TOOLS = ("create-order", "create_order")


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


class McpError(Exception):
    """MCP 调用失败。code 用于前端判断降级原因。"""

    def __init__(self, message, code="mcp_error", status=502):
        super().__init__(message)
        self.code = code
        self.status = status


# ------------------------------------------------------------ MCP 调用

_client = None
_token_hint = None


def _read_env_value(path, key="MCD_MCP_TOKEN"):
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == key:
                    return v.strip().strip('"').strip("'")
    except OSError:
        pass
    return None


def resolve_token():
    """
    找 Token，但**绝不把它落到项目目录里**——避免有人 git add 时手滑把凭据提交上去。

    优先级：环境变量 → 用户级 skill 目录 → 项目根 → tools/。
    返回值只用于构造客户端，任何地方都不打印它本身，只说来源。
    """
    env = os.environ.get("MCD_MCP_TOKEN")
    if env:
        return env, "环境变量 MCD_MCP_TOKEN"

    home = os.path.expanduser("~")
    candidates = sorted(glob.glob(os.path.join(home, ".workbuddy", "skills", "*", "scripts", ".env")))
    candidates += [os.path.join(ROOT, ".env"), os.path.join(ROOT, "tools", ".env")]

    for path in candidates:
        tok = _read_env_value(path)
        if tok:
            return tok, path
    return None, None


def mcd():
    """懒加载单例连接，避免每次请求都重新握手。"""
    global _client, _token_hint
    if _client is None:
        token, src = resolve_token()
        if not token:
            raise McpError(
                "本机没找到 MCD_MCP_TOKEN。二选一：\n"
                "  ① set MCD_MCP_TOKEN=你的Token 后重启服务\n"
                "  ② 确认 ~/.workbuddy/skills/mcd-order-advisor/scripts/.env 里有 MCD_MCP_TOKEN=\n"
                "获取：https://open.mcd.cn 手机号登录后领取",
                code="no_token", status=503)
        _token_hint = src
        _client = Mcd(token=token)
    return _client


def call_tool(name, args=None, retries=1):
    """调 MCP 工具，把 mcp_client 抛的 SystemExit 转成可分类的错误。"""
    if name in FORBIDDEN_TOOLS:
        raise McpError("本服务不代理下单类工具", code="forbidden", status=403)

    last = None
    for attempt in range(retries + 1):
        try:
            return mcd().call(name, args or {})
        except SystemExit as e:
            msg = str(e)
            if "401" in msg or "Unauthorized" in msg or "403" in msg:
                raise McpError("MCP 鉴权失败，请检查本机 Token 是否有效", code="unauthorized", status=401)
            if "429" in msg:
                last = McpError("MCP 限流（429），稍后重试", code="rate_limited", status=429)
            elif "timed out" in msg.lower() or "Timeout" in msg:
                last = McpError("MCP 调用超时", code="timeout", status=504)
            else:
                last = McpError(msg[:400], code="mcp_error", status=502)
            if attempt < retries:
                time.sleep(0.6)
        except Exception as e:
            last = McpError(f"{type(e).__name__}: {e}"[:400], code="network", status=502)
            if attempt < retries:
                time.sleep(0.6)

    raise last


def text_of(result):
    """取出 MCP 返回里的原始文本。活动和券这类工具返回的是 markdown。"""
    blocks = (result or {}).get("content") or []
    for block in blocks:
        if isinstance(block, dict) and block.get("text"):
            return block["text"]
    return json.dumps(result, ensure_ascii=False)


def json_of(result):
    """整段能 parse 就返回对象，否则原样包一层 markdown。"""
    text = text_of(result)
    try:
        return json.loads(text)
    except Exception:
        return {"markdown": text}


def checked(result, tool_name):
    """
    官方工具的业务失败是「HTTP 200 + 正文里 success:false」，会漏传参数、会限流、
    会券不在时段。不检查 success 就等于把失败包装成真实数据返回给前端——
    那比报错更糟，因为前端会拿它当真价显示。

    有些工具（活动、券）返回的是纯 markdown，没有 success 字段，那种不算失败。
    """
    text = text_of(result)
    obj = first_json(text)
    if "success" in obj and not obj.get("success"):
        code = str(obj.get("code") or "")
        raise McpError(f"{tool_name} 官方返回失败：{str(obj.get('message') or '')[:200]}",
                       code=("soldout" if code == "60006"
                             else "coupon_not_in_window" if code == "600012"
                             else "rate_limited" if code == "429"
                             else f"mcp_{code or 'failed'}"),
                       status=422)
    return json_of(result)


def first_json(text):
    """
    ⚠️ 官方返回会在正文后面再粘一段「数据传参规则」样例，直接 json.loads(整段) 会报
    Extra data。必须只截第一个完整对象——这个坑是 tools/build_data.py 先踩出来的。
    """
    idx = text.find('{"success"')
    if idx < 0:
        idx = text.find("{")
    if idx < 0:
        return {}
    try:
        return json.JSONDecoder().raw_decode(text[idx:])[0]
    except Exception:
        return {}


def parse_calc_price(result):
    """
    解析 calculate-price 的结果，产出结构化金额。

    官方返回的金额单位是**分**，必须 /100。
    """
    obj = first_json(text_of(result))
    if not obj.get("success"):
        return {"ok": False, "errCode": str(obj.get("code") or ""),
                "message": str(obj.get("message") or "")[:200]}
    data = obj.get("data") or {}
    # 单位：分 → 元
    def yuan(v):
        return round((v or 0) / 100.0, 2)
    return {
        "ok": True,
        "price": yuan(data.get("price")),
        "originalPrice": yuan(data.get("originalPrice")),
        "deliveryPrice": yuan(data.get("deliveryPrice")),
        "packingPrice": yuan(data.get("packingPrice")),
        "tablewarePrice": yuan(data.get("tablewarePrice")),
        "couponDiscount": yuan(data.get("couponDiscount") or data.get("discount")),
        "raw": data,
    }


# ------------------------------------------------------------ 业务处理

def handle_health(query):
    """探针：前端靠它决定进在线还是离线。不能因为任何原因返回 5xx 以外的假成功。"""
    status = {"reachable": False, "latencyMs": None, "error": None}
    t0 = time.time()
    try:
        checked(call_tool("query-nearby-stores", {
            "searchType": 2, "beType": 1,
            "keyword": "中山大学广州校区南校园", "city": "广州市",
        }), "query-nearby-stores")
        status["reachable"] = True
    except McpError as e:
        status["error"] = e.code
    status["latencyMs"] = round((time.time() - t0) * 1000)

    return {
        "mode": "online" if status["reachable"] else "unreachable",
        "mcp": status,
        "storeCode": STORE_CODE_DEFAULT,
        "tools": ["query-nearby-stores", "query-meals", "list-nutrition-foods",
                  "available-coupons", "campaign-calendar", "query-meal-detail",
                  "calculate-price"],
        "note": "本服务不代理 create-order",
    }


def handle_store(query):
    # 官方必填入参是 beType + searchType，不是 address。传错会得到 success:false 而不是报错，
    # 所以这个错曾经一直没人发现——直到加了 checked() 才暴露。
    return checked(call_tool("query-nearby-stores", {
        "searchType": int(query.get("searchType") or 2),   # 2 = 按位置搜索附近餐厅
        "beType": int(query.get("beType") or 1),           # 1 = 到店自提
        "keyword": query.get("keyword") or "中山大学广州校区南校园",
        "city": query.get("city") or "广州市",
    }), "query-nearby-stores")


def handle_menu(query):
    store = query.get("storeCode") or STORE_CODE_DEFAULT
    # 注意①：query-meals 没有时段参数，服务端按调用时刻返回当前时段菜单
    # 注意②：orderType / beType 是必填，漏了会返回 success:false（1=到店 / 1=到店取餐）
    args = {"storeCode": store, "orderType": int(query.get("orderType") or 1),
            "beType": int(query.get("beType") or 1)}
    return checked(call_tool("query-meals", args), "query-meals")


def handle_nutrition(query):
    return checked(call_tool("list-nutrition-foods", {}), "list-nutrition-foods")


def handle_campaigns(query):
    store = query.get("storeCode") or STORE_CODE_DEFAULT
    coupons = checked(call_tool("available-coupons", {"storeCode": store}), "available-coupons")
    calendar = checked(call_tool("campaign-calendar", {}), "campaign-calendar")
    return {"coupons": coupons, "calendar": calendar}


def handle_price(payload):
    """真实算价。在线模式下唯一能得到真实价格的途径，失败必须如实失败。"""
    store = payload.get("storeCode") or STORE_CODE_DEFAULT
    items = payload.get("items") or []
    if not items:
        raise McpError("items 不能为空", code="bad_request", status=400)

    # orderType / beType 是必填：1 = 到店，1 = 到店取餐。漏传官方会返回 success:false
    args = {
        "storeCode": store,
        "orderType": int(payload.get("orderType") or 1),
        "beType": int(payload.get("beType") or 1),
        "items": [{"productCode": it.get("code"), "quantity": int(it.get("qty") or 1)}
                  for it in items],
    }
    parsed = parse_calc_price(call_tool("calculate-price", args))
    if not parsed["ok"]:
        # 官方明确的失败语义，直接映射给前端，不要包装成成功
        raise McpError(f"官方算价失败：{parsed['message'] or parsed['errCode']}",
                       code="calc_failed" if parsed["errCode"] != "60006" else "soldout",
                       status=422)
    parsed.pop("raw", None)
    return parsed


def handle_probe(payload):
    """逐张算价探测售罄。官方语义：码 60006 = 已售罄或不可售。"""
    store = payload.get("storeCode") or STORE_CODE_DEFAULT
    codes = payload.get("codes") or []
    if not codes:
        raise McpError("codes 不能为空", code="bad_request", status=400)

    out = []
    for code in codes[:40]:                      # 限流保护，一次最多 40 个
        args = {"storeCode": store, "orderType": 1, "beType": 1,
                "items": [{"productCode": code, "quantity": 1}]}
        try:
            p = parse_calc_price(call_tool("calculate-price", args))
        except McpError as e:
            out.append({"code": code, "state": "unknown", "reason": e.code})
            continue
        if p["ok"]:
            out.append({"code": code, "state": "available", "price": p["price"]})
        elif p["errCode"] == "60006":
            out.append({"code": code, "state": "soldout", "errCode": "60006"})
        else:
            out.append({"code": code, "state": "unknown", "errCode": p["errCode"]})
    return {"items": out}


def handle_img(query):
    """图片代理。只放行官方 CDN 白名单，不做开放代理。"""
    src = query.get("src") or ""
    host = urllib.parse.urlparse(src).hostname or ""
    if not host or not any(host == h or host.endswith("." + h) for h in IMG_HOSTS):
        raise McpError(f"图片域名不在白名单：{host}", code="host_not_allowed", status=403)

    req = urllib.request.Request(src, headers={
        "Referer": "https://mcd.cn/",
        "User-Agent": "Mozilla/5.0 mcd-advisor-local/1.0",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        return {"__binary__": True, "body": r.read(),
                "contentType": r.headers.get("Content-Type") or "image/png"}


ROUTES = {
    "/api/health":     ("GET",  handle_health),
    "/api/store":      ("GET",  handle_store),
    "/api/menu":       ("GET",  handle_menu),
    "/api/nutrition":  ("GET",  handle_nutrition),
    "/api/campaigns":  ("GET",  handle_campaigns),
    "/api/price":      ("POST", handle_price),
    "/api/probe":      ("POST", handle_probe),
    "/api/img":        ("GET",  handle_img),
}


# ------------------------------------------------------------ HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "mcd-advisor-local"

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s - %s\n" % (self.address_string(), fmt % args))

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Cache-Control", "no-store")

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, data, content_type, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self._cors()
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _dispatch(self, method):
        parsed = urllib.parse.urlparse(self.path)
        path, query = parsed.path, dict(urllib.parse.parse_qsl(parsed.query))

        if path not in ROUTES:
            return self._send_json(
                envelope(path, ok=False, error={"code": "not_found", "message": f"无此路由：{path}"}),
                status=404)

        want_method, fn = ROUTES[path]
        if want_method != method:
            return self._send_json(
                envelope(path, ok=False, error={"code": "method_not_allowed", "message": f"应用 {want_method}"}),
                status=405)

        t0 = time.time()
        try:
            if method == "POST":
                length = int(self.headers.get("Content-Length") or 0)
                payload = json.loads(self.rfile.read(length) or b"{}")
                data = fn(payload)
            else:
                data = fn(query)
        except McpError as e:
            return self._send_json(
                envelope(path, ok=False, error={"code": e.code, "message": str(e)},
                         elapsedMs=round((time.time() - t0) * 1000)),
                status=e.status)
        except Exception as e:
            return self._send_json(
                envelope(path, ok=False,
                         error={"code": "internal", "message": f"{type(e).__name__}: {e}"[:300]},
                         elapsedMs=round((time.time() - t0) * 1000)),
                status=500)

        if isinstance(data, dict) and data.get("__binary__"):
            return self._send_bytes(data["body"], data["contentType"])

        self._send_json(envelope(path, ok=True, data=data,
                                 elapsedMs=round((time.time() - t0) * 1000)))

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")


def envelope(path, ok, data=None, error=None, elapsedMs=None):
    """统一信封。每个响应都带 requestId + fetchedAt，供页面上出示调用证据。"""
    env = {
        "ok": ok,
        "mode": "online",
        "route": path,
        "requestId": f"{int(time.time() * 1000):x}-{path.strip('/').replace('/', '-')}",
        "fetchedAt": now_iso(),
        "elapsedMs": elapsedMs,
    }
    if data is not None:
        env["data"] = data
    if error is not None:
        env["error"] = error
    return env


def main():
    ap = argparse.ArgumentParser(description="麦当劳点餐助手 · 本地后端")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--host", default="127.0.0.1", help="只允许本机，不要改成 0.0.0.0")
    args = ap.parse_args()

    try:
        mcd()
        print("  MCP 握手成功，Token 已在本机就位（不会回传给浏览器）")
    except Exception as e:
        print(f"  ⚠️ MCP 握手失败：{e}\n     服务仍会启动，health 会返回 unreachable，前端将自动降级为离线模式")

    print(f"  本地后端已启动 → http://{args.host}:{args.port}")
    print("  路由：" + "  ".join(sorted(ROUTES)))
    print("  按 Ctrl+C 停止\n")
    try:
        ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
