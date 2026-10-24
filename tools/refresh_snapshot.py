# -*- coding: utf-8 -*-
"""
刷新快照：把官方 MCP 的真实数据抓下来，落进 data/mcd_snapshot.json。

为什么需要单独这一步：
    build_data.py 只负责「把快照加工成网页能用的 menu_data.js」，它自己不联网。
    抓数据是这一步的事。之前这两步是分开的，而生成快照的脚本住在 skill 目录里、
    输出路径又和本项目对不上，结果 data/mcd_snapshot.json 一度不存在——
    build_data.py 一旦跑就会崩。所以把它固化进项目，路径写死在 data/ 下。

    python tools/refresh_snapshot.py                 # 抓默认门店
    python tools/refresh_snapshot.py --store 1400028  # 只抓指定门店（快很多）

两条重要保护：
    1. **只覆盖非空结果**——打烊门店的 query-meals 会返回 0 款，
       照单全收会把有效数据冲掉（这个坑之前踩过）。
    2. 本次没抓到的营养/券，沿用旧快照里的，不置空。

红线：不调用 create-order，Token 只从本机 .env 或环境变量读，不进任何产出文件。
"""

import argparse
import glob
import json
import os
import sys
import time
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from mcp_client import Mcd                      # noqa: E402  项目内自带，零依赖

# build_data.py 是从 skill 的 data 目录读快照的（DATA_DIR 硬编码在那里），
# 所以这里必须写同一个位置，否则它读到的还是上一次的旧快照。
SKILL_DIR = r"C:\Users\22428\.workbuddy\skills\mcd-order-advisor"
SNAPSHOT = os.path.join(SKILL_DIR, "data", "mcd_snapshot.json")
DEFAULT_KEYWORD = "中山大学广州校区南校园"
DEFAULT_CITY = "广州市"
DEFAULT_STORE = "1400028"                       # 麦当劳广州新港西路餐厅

FORBIDDEN = {"create-order", "mall-create-order", "party-order-create"}


def resolve_token():
    """
    找 Token，但**绝不把它落进项目目录**——避免有人 git add 时手滑提交凭据。
    优先级：环境变量 → 用户级 skill 目录 → 项目根 → tools/。
    """
    env = os.environ.get("MCD_MCP_TOKEN")
    if env:
        return env, "环境变量 MCD_MCP_TOKEN"

    home = os.path.expanduser("~")
    candidates = sorted(glob.glob(os.path.join(home, ".workbuddy", "skills", "*", "scripts", ".env")))
    candidates += [os.path.join(ROOT, ".env"), HERE + "/.env"]

    for path in candidates:
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    if k.strip() == "MCD_MCP_TOKEN":
                        v = v.strip().strip('"').strip("'")
                        if v:
                            return v, path
        except OSError:
            continue
    return None, None


def _text(result):
    for b in (result or {}).get("content") or []:
        if isinstance(b, dict) and b.get("text"):
            return b["text"]
    return json.dumps(result, ensure_ascii=False)


def _first_json(text):
    """官方返回正文后会粘一段「数据传参规则」样例，直接 loads 会报 Extra data。"""
    idx = text.find('{"success"')
    if idx < 0:
        idx = text.find("{")
    if idx < 0:
        return {}
    try:
        return json.JSONDecoder().raw_decode(text[idx:])[0]
    except Exception:
        return {}


def _call(m, name, args):
    if name in FORBIDDEN:
        raise SystemExit(f"拒绝调用 {name}：本工具绝不触碰下单类接口")
    return _first_json(_text(m.call(name, args or {})))


def main():
    ap = argparse.ArgumentParser(description="刷新麦当劳 MCP 快照")
    ap.add_argument("--keyword", default=DEFAULT_KEYWORD)
    ap.add_argument("--city", default=DEFAULT_CITY)
    ap.add_argument("--store", default="", help="只抓这个门店码，不填则抓前 3 家")
    ap.add_argument("--limit", type=int, default=3)
    args = ap.parse_args()

    token, src = resolve_token()
    if not token:
        raise SystemExit("本机没找到 MCD_MCP_TOKEN。二选一：\n"
                         "  ① set MCD_MCP_TOKEN=你的Token 后重试\n"
                         "  ② 确认 ~/.workbuddy/skills/mcd-order-advisor/scripts/.env 里有 MCD_MCP_TOKEN=")
    print(f"  Token 来源：{src}")
    m = Mcd(token=token)
    m.initialize()
    print("  MCP 握手成功\n")

    out = {
        "fetched_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "query": {"keyword": args.keyword, "city": args.city},
        "stores": [], "menus": {},
        "nutrition_raw": None, "available_coupons": None, "store_coupons": None,
    }

    # ---- 门店。注意必填是 beType + searchType，不是 address ----
    r = _call(m, "query-nearby-stores",
              {"beType": 1, "searchType": 2, "city": args.city, "keyword": args.keyword})
    if not r.get("success"):
        raise SystemExit("查门店失败：" + str(r.get("message"))[:200])
    stores = r.get("data") or []
    out["stores"] = stores
    print(f"📍 门店 {len(stores)} 家")

    # ---- 菜单 ----
    targets = []
    if args.store:
        targets = [s for s in stores if s.get("storeCode") == args.store] or \
                  [{"storeCode": args.store, "storeName": args.store}]
    else:
        targets = [s for s in stores if s.get("businessStatus")][:args.limit]

    for s in targets:
        code = s.get("storeCode")
        rr = _call(m, "query-meals", {"storeCode": code, "orderType": 1, "beType": 1})
        data = (rr.get("data") or {}) if rr.get("success") else {}
        meals = data.get("meals") or {}
        cats = data.get("categories") or []
        if not meals:
            print(f"   ⚠️ {s.get('storeName')} 返回 0 款（可能打烊），保留旧数据")
            continue
        out["menus"][code] = {"storeName": s.get("storeName"),
                              "categories": cats, "meals": meals}
        print(f"   ✅ {s.get('storeName')}：{len(cats)} 类 / {len(meals)} 款")
        time.sleep(0.3)

    # ---- 营养 + 券（低频），失败不致命 ----
    # 存**原始文本**：build_data.py 里 `snap.get("available_coupons")` 是直接当文本解析的
    for tool, key in (("list-nutrition-foods", "nutrition_raw"),
                      ("available-coupons", "available_coupons")):
        try:
            raw = m.call(tool, {})
            obj = _first_json(_text(raw))
            if obj.get("success") is False:
                print(f"   ⚠️ {tool} 返回失败：{str(obj.get('message'))[:80]}")
                continue
            out[key] = _text(raw)
            print(f"   ✅ {tool}")
        except SystemExit as e:
            print(f"   ⚠️ {tool} 未取到：{str(e)[:80]}")

    # ---- 旧快照里有、本次没刷到的，原样保留 ----
    if os.path.exists(SNAPSHOT):
        try:
            with open(SNAPSHOT, encoding="utf-8") as f:
                old = json.load(f)
            for k, v in (old.get("menus") or {}).items():
                out["menus"].setdefault(k, v)
            for k in ("nutrition_raw", "available_coupons", "store_coupons"):
                if not out.get(k) and old.get(k):
                    out[k] = old[k]
        except Exception as e:
            print(f"   ⚠️ 旧快照读取失败，忽略：{e}")

    if not out["menus"]:
        raise SystemExit("一家门店的菜单都没抓到，拒绝写入空快照（会冲掉有效数据）")

    os.makedirs(os.path.dirname(SNAPSHOT), exist_ok=True)
    with open(SNAPSHOT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    total = sum(len(v.get("meals") or {}) for v in out["menus"].values())
    # 快照可能在另一个盘符（skill 目录在 C:、项目在 D:），relpath 会跨盘报错，直接打绝对路径
    print(f"\n✅ 已写入 {SNAPSHOT}")
    print(f"   抓取时间 {out['fetched_at']}｜门店 {len(out['menus'])} 家｜餐品合计 {total} 款")


if __name__ == "__main__":
    main()
