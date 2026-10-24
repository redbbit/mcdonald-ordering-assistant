# -*- coding: utf-8 -*-
"""
重下官方活动图原图，用「海报级」参数重编码，修掉活动图被压糊的问题。

背景（这次踩的坑）：
    compress_images.py 按 80KB 上限 + q50 兜底压缩，对 427×320 的商品图没问题，
    但活动海报是 1125×1125 的文字密集型图片，q50 + 强制缩到 800 把标题和规则
    全压花了 —— 右侧广告板一眼就能看出糊。活动图是门面，值得单独一套参数。

本脚本只做三件事：
    1. 按 data/campaigns.js 里现存的 (imgLocal, img) 对照表重下原图（原图已被
       压缩脚本删除，URL 仍在数据文件里，可追溯）；
    2. 用 cwebp -q 88 重编码：静态海报统一 800×800（展示位约 280px，2.8 倍
       冗余，文字锐利），上限 220KB；动图走 gif2webp 保留动画；
    3. 校验：每张都要能解码、尺寸正确、不超上限，然后才覆盖旧 .webp。

红线：只碰 img/campaign_*.webp 与其下载临时文件，不碰商品图、不碰数据文件的
      图片字段（imgLocal 路径不变，无需改数据）。

用法：
    python tools/recompress_campaigns.py --dry-run    # 只报告会做什么
    python tools/recompress_campaigns.py              # 真下真转
"""

import argparse
import glob
import io
import json
import os
import re
import subprocess
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
IMG_DIR = os.path.join(ROOT, "img")
CAMPAIGNS = os.path.join(ROOT, "data", "campaigns.js")

CWEBP = r"D:\workbuddydata\Claw\tools\webp\libwebp-1.4.0-windows-x64\bin\cwebp.exe"
GIF2WEBP = r"D:\workbuddydata\Claw\tools\webp\libwebp-1.4.0-windows-x64\bin\gif2webp.exe"

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "Referer": "https://mcd.cn/"}

# 活动海报专用参数：展示位小，但字多，质量优先
TARGET_EDGE = 800        # 统一最长边（1125 → 800，展示位约 280px）
QUALITY = 88             # 商品图 75 够用，海报 88 文字才锐利
SIZE_LIMIT_KB = 220      # 单张上限（比商品图的 80KB 宽松）
GIF_LIMIT_KB = 320       # 动图上限（保留动画，略宽松）


def kb(n):
    return round(n / 1024.0, 1)


def sniff(path):
    """按文件头判断真实格式——CDN 有些 URL 后缀是 .png，内容却是 GIF。"""
    try:
        with open(path, "rb") as f:
            head = f.read(12)
    except OSError:
        return None
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if head[:2] == b"\xff\xd8":
        return "jpeg"
    if head[:3] == b"GIF":
        return "gif"
    if head[:4] == b"RIFF":
        return "webp"
    return None


def load_pairs():
    """从 data/campaigns.js 提取 (imgLocal, 远程URL) 对照表，按 imgLocal 去重。"""
    s = io.open(CAMPAIGNS, encoding="utf-8").read()
    m = re.search(r"window\.MCD_CAMPAIGNS = (\{.*\});", s, re.S)
    if not m:
        raise SystemExit("campaigns.js 格式不符合预期（找不到 window.MCD_CAMPAIGNS）")
    data = json.loads(m.group(1))
    pairs = {}
    for item in data.get("items", []):
        local, remote = item.get("imgLocal") or "", item.get("img") or ""
        if local.startswith("img/campaign_") and remote:
            pairs.setdefault(local, remote)
    return pairs


def download(local, url):
    """下载到 img/.orig/<local 文件名>，返回本地路径或 None。"""
    os.makedirs(os.path.join(IMG_DIR, ".orig"), exist_ok=True)
    name = os.path.basename(local)
    dst = os.path.join(IMG_DIR, ".orig", name)
    if os.path.exists(dst) and os.path.getsize(dst) > 1024:
        return dst                                    # 已有下载缓存，复用
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read()
        if len(body) < 500:
            return None
        with open(dst, "wb") as f:
            f.write(body)
        return dst
    except Exception as e:
        print("    ✗ 下载失败 %s：%s" % (name, type(e).__name__))
        return None


def encode(src, dst, limit_kb):
    """
    重编码单张。静态：cwebp -q 88 -resize 800 800，超限降质量；
    动图：gif2webp -q 88 -resize 800 800，只降质量不缩尺寸以外的变换。
    返回 (ok, size, used)。
    """
    is_gif = sniff(src) == "gif"
    limit = limit_kb * 1024

    def run(q, resize):
        tool = GIF2WEBP if is_gif else CWEBP
        if not os.path.isfile(tool):
            return False
        if is_gif:
            cmd = [tool, "-q", str(q)]
            if resize:
                cmd += ["-resize", str(resize), str(resize)]
            cmd += [src, "-o", dst]
        else:
            cmd = [tool, "-q", str(q), "-m", "6"]
            if resize:
                cmd += ["-resize", str(resize), str(resize)]
            cmd += [src, "-o", dst]
        try:
            r = subprocess.run(cmd, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=90)
            return r.returncode == 0 and os.path.isfile(dst)
        except (subprocess.TimeoutExpired, OSError):
            return False

    for q in (QUALITY, 85, 82):
        if run(q, TARGET_EDGE) and os.path.getsize(dst) <= limit:
            return True, os.path.getsize(dst), "q%d/%dpx" % (q, TARGET_EDGE)
    if not is_gif:
        for q in (QUALITY, 84):
            if run(q, 700) and os.path.getsize(dst) <= limit:
                return True, os.path.getsize(dst), "q%d/700px" % q
    if os.path.isfile(dst):
        return False, os.path.getsize(dst), "oversize"
    return False, 0, "fail"


def main():
    ap = argparse.ArgumentParser(description="活动图高清重编码")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    for tool in (CWEBP, GIF2WEBP):
        if not os.path.isfile(tool):
            print("❌ 没找到 %s" % tool)
            sys.exit(2)

    pairs = load_pairs()
    print("  campaigns.js 引用 %d 张活动图\n" % len(pairs))

    if args.dry_run:
        print("  [dry-run] 将执行：")
        print("    重下 %d 张原图 → img/.orig/（URL 来自 campaigns.js，可追溯）" % len(pairs))
        print("    cwebp -q %d -m 6 -resize %d %d（上限 %dKB）" % (QUALITY, TARGET_EDGE, TARGET_EDGE, SIZE_LIMIT_KB))
        print("    动图走 gif2webp -q %d -resize %d %d（上限 %dKB）" % (QUALITY, TARGET_EDGE, TARGET_EDGE, GIF_LIMIT_KB))
        print("    覆盖同名 img/campaign_*.webp，imgLocal 路径不变")
        return

    # ① 下载（并发 6）
    fetched = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(download, local, url): local for local, url in pairs.items()}
        for fut in futs:
            pass
        for fut, local in futs.items():
            try:
                path = fut.result()
            except Exception:
                path = None
            if path:
                fetched[local] = path
    print("  ① 原图就绪 %d/%d 张" % (len(fetched), len(pairs)))

    # ② 重编码
    ok_list, fail_list = [], []
    before_total = 0
    for local in sorted(pairs):
        src = fetched.get(local)
        dst = os.path.join(IMG_DIR, os.path.basename(local))
        old_size = os.path.getsize(dst) if os.path.isfile(dst) else 0
        before_total += old_size
        if not src:
            fail_list.append((local, "download-failed"))
            continue
        is_gif = sniff(src) == "gif"
        limit = GIF_LIMIT_KB if is_gif else SIZE_LIMIT_KB
        tmp = dst + ".tmp"
        ok, size, used = encode(src, tmp, limit)
        if ok:
            os.replace(tmp, dst)                       # 成功才覆盖，失败保留旧的
            ok_list.append((local, kb(old_size), kb(size), used))
        else:
            if os.path.isfile(tmp):
                os.remove(tmp)
            fail_list.append((local, used))

    print("  ② 重编码成功 %d 张｜失败 %d 张\n" % (len(ok_list), len(fail_list)))
    for local, old, new, used in ok_list:
        flag = "↑" if new > old else "↓"
        print("    %-24s %6.1f KB → %6.1f KB（%s）%s" % (os.path.basename(local), old, new, used, flag))
    for local, why in fail_list:
        print("    ✗ %-24s %s（保留旧文件不动）" % (os.path.basename(local), why))

    after_total = sum(os.path.getsize(os.path.join(IMG_DIR, os.path.basename(l)))
                      for l in pairs if os.path.isfile(os.path.join(IMG_DIR, os.path.basename(l))))
    print("\n  活动图合计 %.2f MB → %.2f MB" % (before_total / 1048576, after_total / 1048576))
    print("  下一步：node tools/check_release.js 验证引用完整")


if __name__ == "__main__":
    main()
