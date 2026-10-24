# -*- coding: utf-8 -*-
"""
把麦当劳官方 MCP 的真实数据，导出成网页可直接消费的 menu_data.js。

四步：
  1. extract  读 mcd_snapshot.json（菜单/门店/时段）+ nutrition.json，归一化成 Dish
  2. verify   逐款调 calculate-price，标注「当前真实可点」（官方错误码 60006 = 售罄/不可售）
  3. images   并发下载官方商品图到本地 img/（离线也能演示，且保证是真图）
  4. emit     写出 data/menu_data.js（挂到 window.MCD_DATA，可用 file:// 直接打开）

红线：全程不调用 create-order。懂的都懂，那是真扣款。
"""
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

SKILL_DIR = r"C:\Users\22428\.workbuddy\skills\mcd-order-advisor"
SCRIPTS_DIR = os.path.join(SKILL_DIR, "scripts")
DATA_DIR = os.path.join(SKILL_DIR, "data")
sys.path.insert(0, SCRIPTS_DIR)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_JS = os.path.join(ROOT, "data", "menu_data.js")
IMG_DIR = os.path.join(ROOT, "img")

STORE_CODE = "1400028"

# ---------------------------------------------------------------- 角色判定
# 按「分类 + 菜名关键词」判定一道菜在一桌饭里的角色。
ROLE_BY_CAT = {
    "麦咖啡™": "drink",
    "饮品": "drink",
    "小食拼盘/多人餐": "share",
    "小食拼盘//多人餐": "share",
    "随心配/1+1": "value",
    "500/大卡套餐": "combo",
    "500大卡套餐": "combo",
    "精选单人餐": "combo",
    "大堡口福/单人餐": "combo",
    "开心乐园": "combo",
    "鸡肉汉堡//卷": "main",
    "巨无霸/牛鱼肉堡": "main",
    "安格斯MAX/厚牛堡": "main",
    "炸鸡": "chicken",
    "蘸酱炸鸡": "chicken",
    "小食甜品//其他": "side",
    "人气热卖": "pop",
}
ROLE_BY_CAT_KEY = {k.replace("/", ""): v for k, v in ROLE_BY_CAT.items()}

DESSERT_KW = ["冰淇淋", "新地", "麦旋风", "雪冰", "奶冻", "爆珠", "拉明顿", "阿芙佳朵", "圆筒"]
DRINK_KW = ["可乐", "雪碧", "咖啡", "美式", "奶铁", "牛奶", "豆浆", "红茶", "柠", "苹果汁",
            "橙", "玉米杯", "纯悦", "玛奇朵", "卡布奇诺", "伯爵", "燕麦奶", "抹茶牛奶",
            "燕麦黑巧", "浓浓黑巧"]
MAIN_KW = ["堡", "汉堡", "卷", "麦满分", "巨无霸", "乐园", "鸡排", "粥"]
SHARE_KW = ["多人餐", "分享餐", "拼盘", "全明星", "双全盒", "搭档桶", "八件套", "欢聚餐", "桶"]


def decide_role(cat, name):
    c = (cat or "").replace("/", "")
    if c in ROLE_BY_CAT_KEY:
        role = ROLE_BY_CAT_KEY[c]
    else:
        role = "side"
    if any(k in name for k in DESSERT_KW):
        return "dessert"
    if role == "side" and any(k in name for k in DRINK_KW):
        return "drink"
    if any(k in name for k in SHARE_KW):
        return "share"
    if role == "pop":
        if any(k in name for k in MAIN_KW) or ("堡" in name):
            return "main"
        if any(k in name for k in DRINK_KW):
            return "drink"
        return "side"
    if role == "dessert":
        return "dessert"
    return role


# ---------------------------------------------------------------- 忌口/口味标签
# 说明：官方 MCP 没有「口味」「忌口」字段。这里按菜名关键词标注，
# 属于启发式，界面上必须如实说明来源；宁可少推，不可推错。
AVOID_RULES = {
    "辣": ["辣", "麻辣", "川", "辣翅", "香辣"],
    "牛肉": ["牛", "巨无霸", "安格斯", "不素之霸", "吉士汉堡", "双层吉士", "牛堡", "芝士牛"],
    "猪肉": ["猪", "火腿", "培根", "香肠", "图林根", "烟肉"],
    "鸡肉": ["鸡", "麦乐鸡", "脆汁鸡", "鸡排", "鸡球", "趣鸡球", "V翅", "辣翅", "鸡腿"],
    "海鲜": ["鱼", "鳕鱼", "虾", "深海"],
    "鸡蛋": ["蛋", "吉士"],
    "乳制品": ["奶", "芝士", "吉士", "冰淇淋", "新地", "麦旋风", "雪冰", "牛奶",
               "奶铁", "玛奇朵", "卡布奇诺", "拿铁", "阿芙佳朵", "拉明顿", "奶冻", "黄油"],
    "咖啡因": ["咖啡", "美式", "奶铁", "拿铁", "卡布奇诺", "玛奇朵", "阿芙佳朵",
               "红茶", "伯爵", "抹茶", "可乐", "怡泉"],
    "花生坚果": ["花生", "坚果", "杏仁"],
    "洋葱": ["洋葱"],
    "高糖": ["雪冰", "新地", "麦旋风", "冰淇淋", "奶冻", "爆珠", "可乐", "雪碧",
             "橙", "柠檬红茶", "苹果汁", "拉明顿", "蛋卷", "苹果片"],
}

TASTE_TAGS = {
    "新品": ["新品", "新上市", "上市"],
    "人气": ["人气", "热卖", "爆款", "招牌"],
    "限时": ["限时", "季节性"],
    "促销": ["促销", "特价", "优惠", "特惠", "随心配", "1+1"],
    "早餐": ["早餐", "麦满分", "早安"],
    "儿童": ["乐园", "儿童"],
    "酥脆": ["脆", "酥", "炸"],
    "芝士": ["芝士", "吉士", "拉丝"],
    "清爽": ["柠檬", ".apple", "苹果", "沙拉", "鲜蔬", "玉米", "果汁"],
}


def tag_match(name, rules):
    hits = []
    for tag, kws in rules.items():
        if any(k in name for k in kws):
            hits.append(tag)
    return hits


# ---------------------------------------------------------------- 主流程
def fetch_parts(dishes):
    """
    调 query-meal-detail 拿套餐的「官方默认子项」。

    这一步解决两个问题：
      1. 营养缺口 —— 组合餐（三件套/四件套）营养表里查不到，
         但它的默认子项（汉堡/薯条/可乐）都是官方已公布营养的单品，
         按 isDefault=1 的子项累加 = 官方数据算出来的，不是我估的。
      2. 忌口漏网 —— 「精选xx套餐」这种菜名判不出主料，
         但子项名写得清清楚楚（"猪柳"/"牛肉"/"鸡腿"），能兜住。

    注意：query-meal-detail 依赖 query-meals 建立上下文，必须先调一次。
    """
    from mcd_mcp import Mcd
    m = Mcd()
    m.initialize()
    m.call("query-meals", {"storeCode": STORE_CODE, "orderType": 1, "beType": 1})
    got = 0
    for i, d in enumerate(dishes, 1):
        d["parts"] = None
        try:
            r = m.call("query-meal-detail", {
                "storeCode": STORE_CODE, "orderType": 1, "beType": 1, "code": d["code"],
            })
            txt = r["content"][0]["text"]
            # ⚠️ 坑：这段文本里会串接多个 JSON 对象（正文后面还粘着一段「数据传参规则」样例），
            # json.loads(整段) 会报 "Extra data"。必须用 raw_decode 只截第一个完整对象。
            idx = txt.find('{"success"')
            obj = json.JSONDecoder().raw_decode(txt[idx:])[0] if idx >= 0 else {}
            data = obj.get("data") or {}
            comps = []
            for rd in (data.get("rounds") or []):
                for ch in (rd.get("choices") or []):
                    q = ch.get("quantity") or 0
                    if ch.get("isDefault") == 1 and q > 0:
                        comps.append({
                            "code": ch.get("code"),
                            "name": (ch.get("name") or "").strip(),
                            "qty": q,
                        })
            if comps:
                d["parts"] = comps
                got += 1
        except Exception as e:
            d["partsErr"] = f"{type(e).__name__}: {e}"[:120]
        if i % 25 == 0:
            print(f"   套餐配方 {i}/{len(dishes)}…")
        time.sleep(0.1)
    return got


NUT_KEYS = ("kcal", "protein", "fat", "carb", "sodium", "calcium")


def fill_nutrition(dishes, nut_table):
    """直接命中优先；命中不了就用官方默认子项累加，并如实标来源。"""
    from nutrition import match as nut_match
    summed = partial = 0
    for d in dishes:
        if d.get("kcal") is not None:
            d["nutSrc"] = "direct"
            continue
        parts = d.get("parts")
        if not parts:
            d["nutSrc"] = "none"
            continue
        tot = {k: 0.0 for k in NUT_KEYS}
        miss = []
        for p in parts:
            rec = nut_match(p["name"], nut_table)
            if rec and rec.get("kcal") is not None:
                for k in NUT_KEYS:
                    tot[k] += float(rec.get(k) or 0) * (p["qty"] or 1)
            else:
                miss.append(p["name"])
        if tot["kcal"] <= 0:
            d["nutSrc"] = "none"
            continue
        for k in NUT_KEYS:
            d[k] = round(tot[k], 1)
        d["nutSrc"] = "sum" if not miss else "sum-partial"
        d["nutMiss"] = miss
        if miss:
            partial += 1
        else:
            summed += 1

        # 用子项真实配料补全忌口标签（弥补「菜名看不出主料」的盲区）
        extra = tag_match("".join(p["name"] for p in parts), AVOID_RULES)
        for e in extra:
            if e not in d["Avoid"]:
                d["Avoid"].append(e)
    return summed, partial


def extract():
    with open(os.path.join(DATA_DIR, "mcd_snapshot.json"), encoding="utf-8") as f:
        snap = json.load(f)
    with open(os.path.join(DATA_DIR, "nutrition.json"), encoding="utf-8") as f:
        nut_table = json.load(f).get("items", {})

    from nutrition import match as nut_match  # 复用官方营养表的模糊匹配（避免短名误吞长名）

    menu = snap["menus"][STORE_CODE]
    # 建立 code -> 所属分类 + 标签
    cat_of, tags_of = {}, {}
    for c in menu["categories"]:
        cn = (c.get("name") or "").replace("\n", "/")
        for m in c.get("meals", []):
            cat_of[m["code"]] = cn
            tags_of.setdefault(m["code"], [])
            for t in m.get("tags", []):
                if t not in tags_of[m["code"]]:
                    tags_of[m["code"]].append(t)

    store = next(s for s in snap["stores"] if s["storeCode"] == STORE_CODE)

    dishes = []
    for code, m in menu["meals"].items():
        name = (m.get("name") or "").strip()
        price = float(m.get("currentPrice") or 0)
        orig = float(m.get("originalPrice") or price)
        cat = cat_of.get(code, "")
        tags = tags_of.get(code, [])
        nt = nut_match(name, nut_table) or {}

        role = decide_role(cat, name)
        hay = name + "".join(tags)
        dish = {
            "code": code,
            "name": name,
            "cat": cat,
            "role": role,
            "img": m.get("image") or "",
            "price": round(price, 2),
            "orig": round(orig, 2),
            "save": round(max(0.0, orig - price), 2),
            "dealType": m.get("discountType") or "",
            "tags": tags,
            "Avoid": tag_match(hay, AVOID_RULES),
            "taste": tag_match(hay, TASTE_TAGS),
            "kcal": nt.get("kcal"),
            "protein": nt.get("protein"),
            "fat": nt.get("fat"),
            "carb": nt.get("carb"),
            "sodium": nt.get("sodium"),
            "calcium": nt.get("calcium"),
            "nutName": nt.get("productName") or None,
        }
        dishes.append(dish)

    return snap, store, menu, dishes


def verify(dishes, do_verify=True):
    """逐款调官方 calculate-price，标注当前是否真的点得到。"""
    if not do_verify:
        for d in dishes:
            d["ok"] = None
        return 0
    from mcd_mcp import Mcd
    m = Mcd()
    m.initialize()
    ok = 0
    for i, d in enumerate(dishes, 1):
        try:
            r = m.call("calculate-price", {
                "storeCode": STORE_CODE, "orderType": 1, "beType": 1,
                "items": [{"productCode": d["code"], "quantity": 1}],
            })
            txt = r["content"][0]["text"]
            # ⚠️ 坑：这段文本里会串接多个 JSON 对象（正文后面还粘着一段「数据传参规则」样例），
            # json.loads(整段) 会报 "Extra data"。必须用 raw_decode 只截第一个完整对象。
            idx = txt.find('{"success"')
            obj = json.JSONDecoder().raw_decode(txt[idx:])[0] if idx >= 0 else {}
            data = obj.get("data") or {}
            if obj.get("success") and data:
                d["ok"] = True
                d["livePrice"] = round(data.get("price", 0) / 100.0, 2)
                d["liveOrig"] = round(data.get("originalPrice", 0) / 100.0, 2)
                ok += 1
            else:
                d["ok"] = False
                d["errCode"] = str(obj.get("code") or "")
        except Exception as e:
            d["ok"] = None
            d["errCode"] = f"{type(e).__name__}"
        if i % 20 == 0:
            print(f"   算价校验 {i}/{len(dishes)}…")
        time.sleep(0.12)
    return ok


def download_images(dishes, coupons):
    os.makedirs(IMG_DIR, exist_ok=True)

    jobs = []
    for d in dishes:
        if d["img"]:
            ext = ".gif" if d["img"].lower().split("?")[0].endswith(".gif") else ".png"
            jobs.append((d["code"] + ext, d["img"]))
    for i, c in enumerate(coupons):
        if c.get("img"):
            jobs.append(("coupon_%d.png" % i, c["img"]))

    def one(job):
        fname, url = job
        path = os.path.join(IMG_DIR, fname)
        if os.path.exists(path) and os.path.getsize(path) > 1024:
            return fname, "cached"
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Referer": "https://mcd.cn/",
        })
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                data = r.read()
            if len(data) < 500:
                return fname, "too-small"
            with open(path, "wb") as f:
                f.write(data)
            return fname, "ok"
        except Exception as e:
            return fname, "fail:" + type(e).__name__

    done = {"ok": 0, "cached": 0}
    with ThreadPoolExecutor(max_workers=8) as ex:
        for i, (fname, st) in enumerate(ex.map(one, jobs), 1):
            done[st.split(":")[0]] = done.get(st.split(":")[0], 0) + 1
            if i % 40 == 0:
                print(f"   图片 {i}/{len(jobs)}…")
    print("   图片结果:", done)
    for d in dishes:
        ext = ".gif" if (d["img"] or "").lower().split("?")[0].endswith(".gif") else ".png"
        p = os.path.join(IMG_DIR, d["code"] + ext)
        d["imgLocal"] = ("img/" + d["code"] + ext) if (os.path.exists(p) and os.path.getsize(p) > 1024) else ""
    for i, c in enumerate(coupons):
        p = os.path.join(IMG_DIR, "coupon_%d.png" % i)
        c["imgLocal"] = ("img/coupon_%d.png" % i) if os.path.exists(p) else ""


def parse_coupons(snap):
    out = []
    txt = snap.get("available_coupons") or ""
    for blk in txt.split("- 优惠券标题："):
        if not blk.strip():
            continue
        title = blk.split("\\")[0].strip()
        m = re.search(r'<img src="([^"]+)"', blk)
        if not title:
            continue
        out.append({"title": title, "img": m.group(1) if m else ""})
    return out


def emit(snap, store, menu, dishes, coupons, slot="", out_path=None, global_name="MCD_DATA"):
    """产出一份时段的菜单快照。

    麦当劳不同时段卖的东西不一样（下午茶 / 夜市 / 宵夜），而 MCP 的 query-meals
    没有"指定时段"参数，只能由服务端按当前时间返回 —— 所以想要的时段必须
    在那个时段里真的去调一次。多份快照各写各的文件，运行时可切换。
    """
    slot_text = ""
    for r in store.get("reservationTimeOptions", []):
        if r.get("today"):
            slot_text = r.get("reservationOptionText", "")
            break

    payload = {
        "fetchedAt": snap.get("fetched_at"),
        "source": "麦当劳官方 MCP（query-nearby-stores / query-meals / list-nutrition-foods / calculate-price）",
        "keyword": snap.get("query", {}).get("keyword"),
        "city": snap.get("query", {}).get("city"),
        "store": {
            "code": store["storeCode"],
            "name": store["storeName"],
            "address": store.get("address"),
            "distance": store.get("distance"),
            "hours": f'{store.get("businessStartTime")}-{store.get("businessEndTime")}',
            "slotText": slot_text,
        },
        "categories": [c["name"].replace("\n", "/") for c in menu["categories"]],
        "dishes": dishes,
        "coupons": coupons,
    }
    if slot:
        payload["slot"] = slot
        payload["slotLabel"] = SLOT_LABEL.get(slot, slot)
    out_path = out_path or OUT_JS
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("/* 由 tools/build_data.py 自动生成，数据源：麦当劳官方 MCP。请勿手改。 */\n")
        f.write("window." + global_name + " = ")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    hit = sum(1 for d in dishes if d.get("kcal") is not None)
    ok = sum(1 for d in dishes if d.get("ok") is True)
    imgok = sum(1 for d in dishes if d.get("imgLocal"))
    print(f"\n✅ 写出 {out_path}")
    print(f"   餐品 {len(dishes)} 款｜营养命中 {hit}（{hit*100//max(1,len(dishes))}%）"
          f"｜算价通过 {ok}｜本地图 {imgok}｜券 {len(coupons)} 张")


SLOT_LABEL = {
    "breakfast": "早餐",
    "lunch": "正餐",
    "teatime": "下午茶",
    "night": "夜市",
    "latenight": "宵夜",
}

if __name__ == "__main__":
    do_verify = "--no-verify" not in sys.argv

    def arg(name, default=None):
        return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default

    slot = arg("--slot", "")
    suffix = ("_" + slot) if slot else ""
    out_file = arg("--out", os.path.join(ROOT, "data", "menu_data" + suffix + ".js"))
    global_name = "MCD_DATA" + ("_" + slot.upper() if slot else "")
    # 图片是跨时段共用的，统一放 img/，不重复下载
    if slot:
        print(f"⏱  构建时段：{slot}（{SLOT_LABEL.get(slot, slot)}）→ {os.path.basename(out_file)}")
    print("① 抽取菜单 + 营养…")
    snap, store, menu, dishes = extract()
    print(f"   {len(dishes)} 款餐品")
    print("② 官方 calculate-price 逐款校验（只算价，绝不下单）…")
    verify(dishes, do_verify)
    print("②b 官方 query-meal-detail 取套餐默认配方…")
    n_parts = fetch_parts(dishes)
    with open(os.path.join(DATA_DIR, "nutrition.json"), encoding="utf-8") as f:
        nut_table = json.load(f).get("items", {})
    s, p = fill_nutrition(dishes, nut_table)
    print(f"   拿到配方 {n_parts} 款｜子项累加补全 {s} 款（另有 {p} 款部分子项缺数据）")
    print("③ 解析优惠券…")
    coupons = parse_coupons(snap)
    print("④ 下载官方商品图…")
    download_images(dishes, coupons)
    print("⑤ 导出…")
    emit(snap, store, menu, dishes, coupons, slot=slot, out_path=out_file, global_name=global_name)
