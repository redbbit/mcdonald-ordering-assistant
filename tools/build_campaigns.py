# -*- coding: utf-8 -*-
"""
抓取麦当劳官方活动日历（campaign-calendar），落成本地数据 + 官方活动图。

为什么要单独一个脚本：
  campaign-calendar 是独立于菜单的数据源，重跑 build_data.py 会连菜单/算价一起重来（几分钟），
  而活动信息盘中更新更频繁。两者分开，各自可增量刷新。

  python tools/build_campaigns.py          # 抓并写入 data/campaigns.js
  python tools/build_campaigns.py --dry    # 只打印，不下载不落盘

产出：data/campaigns.js  →  window.MCD_CAMPAIGNS
该文件由本脚本独占维护，build_data.py 不会覆盖它。
"""
import io
import json
import os
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG_DIR = os.path.join(ROOT, "img")
OUT = os.path.join(ROOT, "data", "campaigns.js")
SKILL = os.path.join(
    os.path.expanduser("~"),
    ".workbuddy", "skills", "mcd-order-advisor", "scripts")

sys.path.insert(0, SKILL)
from mcd_mcp import Mcd  # noqa: E402

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "Referer": "https://mcd.cn/"}


def fetch_calendar():
    m = Mcd()
    m.initialize()
    r = m.call("campaign-calendar", {})
    return r["content"][0]["text"]


ENTRY_RE = re.compile(
    r'-\s+\*\*活动标题\*\*：(.*?)\n\s*\*\*活动内容介绍\*\*：(.*?)\n\s*'
    r'\*\*活动图片介绍\*\*：\s*\n\s*<img src="([^"]+)"',
    re.S)

DATE_RE = re.compile(r'^\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*(.*)$')


def parse(text):
    blocks = re.split(r"^#### ", text, flags=re.M)[1:]
    rows = []
    for b in blocks:
        head = b.split("\n", 1)[0]
        dm = DATE_RE.match(head)
        if not dm:
            continue
        date = "%04d-%02d-%02d" % (int(dm.group(1)), int(dm.group(2)), int(dm.group(3)))
        status_raw = dm.group(4).strip()
        if "今日" in status_raw:
            phase = "today"
        elif "往期" in status_raw:
            phase = "past"
        else:
            phase = "upcoming"
        for m in ENTRY_RE.finditer(b):
            title = re.sub(r"\s+", " ", m.group(1)).strip()
            desc = re.sub(r"\n+", "\n", m.group(2)).strip()
            img = m.group(3).strip()
            if not title:
                continue
            rows.append({"date": date, "phase": phase,
                         "title": title, "desc": desc, "img": img})
    return rows


def download(rows):
    """按 URL 去重下载，返回 url -> 本地相对路径"""
    os.makedirs(IMG_DIR, exist_ok=True)
    urls = []
    for r in rows:
        if r["img"] and r["img"] not in urls:
            urls.append(r["img"])

    def one(i_url):
        i, url = i_url
        ext = os.path.splitext(url.split("?")[0])[1].lower()
        if ext not in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
            ext = ".jpg"
        fname = "campaign_%02d%s" % (i + 1, ext)
        path = os.path.join(IMG_DIR, fname)
        if os.path.exists(path) and os.path.getsize(path) > 1024:
            return url, "img/" + fname, "cached"
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=25) as resp:
                data = resp.read()
            if len(data) < 500:
                return url, "", "too-small(%d)" % len(data)
            with open(path, "wb") as f:
                f.write(data)
            return url, "img/" + fname, "ok"
        except Exception as e:
            return url, "", "fail:" + type(e).__name__

    mapping, stat = {}, {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        for url, local, st in ex.map(one, list(enumerate(urls))):
            if local:
                mapping[url] = local
            stat[st.split("(")[0]] = stat.get(st.split("(")[0], 0) + 1
    return mapping, stat


def extract_codes(desc):
    """从活动文案里揪出提到的菜品名，用于把活动和菜单挂上钩"""
    hits = []
    for kw in ("龙焰鸡腿堡", "麦辣鸡腿堡", "蘸酱炸鸡", "薯饼", "脆薯饼", "巨无霸",
               "麦旋风", "板烧鸡腿堡", "安格斯", "麦香鱼", "吉士汉堡"):
        if kw in desc and kw not in hits:
            hits.append(kw)
    return hits


def main():
    dry = "--dry" in sys.argv
    print("① 调用 campaign-calendar …")
    text = fetch_calendar()
    print("   返回 %d 字符" % len(text))

    rows = parse(text)
    print("② 解析出 %d 条活动" % len(rows))
    if not rows:
        print("   ⚠ 没解析到任何活动，检查正则是否还能匹配官方返回格式")
        return 1

    phases = {}
    for r in rows:
        phases[r["phase"]] = phases.get(r["phase"], 0) + 1
    print("   " + " / ".join("%s=%d" % (k, v) for k, v in phases.items()))

    if dry:
        for r in rows[:8]:
            print("   [%s] %s | %s" % (r["phase"], r["date"], r["title"][:40]))
        return 0

    print("③ 下载官方活动图 …")
    mapping, stat = download(rows)
    print("   " + " / ".join("%s=%d" % (k, v) for k, v in stat.items()))

    for r in rows:
        r["imgLocal"] = mapping.get(r["img"], "")
        r["mentions"] = extract_codes(r["desc"])

    payload = {
        "fetchedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "source": "麦当劳官方 MCP · campaign-calendar",
        "count": len(rows),
        "phases": phases,
        "items": rows,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with io.open(OUT, "w", encoding="utf-8") as f:
        f.write("window.MCD_CAMPAIGNS = ")
        f.write(json.dumps(payload, ensure_ascii=False, indent=1))
        f.write(";\n")

    size = os.path.getsize(OUT)
    have = sum(1 for r in rows if r["imgLocal"])
    print("④ 写出 %s（%.1f KB，%d 条，其中 %d 条带本地图）"
          % (os.path.relpath(OUT, ROOT), size / 1024, len(rows), have))

    today = [r for r in rows if r["phase"] == "today"]
    if today:
        print("   今日活动：")
        for r in today:
            print("     · " + r["title"][:46])
    return 0


if __name__ == "__main__":
    sys.exit(main())
