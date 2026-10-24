# -*- coding: utf-8 -*-
"""
把 img/ 下的官方图片转成 WebP，并把数据文件里的 imgLocal 引用同步改掉。

为什么不在 Python 里转：
    标准库没有 WebP 编码器，而本机装不了 Pillow（pip 访问 PyPI 不通）。
    所以改用 libwebp 官方发布的绿色版 Windows 二进制——不需要 pip、不需要编译，
    解压即用。脚本会自动找它，找不到就明确告诉你去哪下，不静默失败。

用法：
    python tools/compress_images.py --dry-run        # 只报告会做什么
    python tools/compress_images.py                  # 真转
    python tools/compress_images.py --keep-original  # 转完保留原图（体积不会变小）
    python tools/compress_images.py --max-kb 60      # 单张上限改成 60KB

两轮迭代策略：
    先以 -q 75 批量转 → 统计超过上限的 → 逐张降质量（70/60/50）→
    仍然超标的限制最长边（800 / 600）重转。食物图降到 q 60~70 肉眼差异不大。
    动图（gif）走 gif2webp 保留动画，只迭代质量不缩放。

红线：只处理 img/ 下的图片，不碰任何凭据文件；删除原图前先确认引用已更新。
"""

import argparse
import glob
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
IMG_DIR = os.path.join(ROOT, "img")

DATA_FILES = ["data/menu_data.js", "data/menu_data_night.js", "data/campaigns.js"]

# cwebp 的候选位置：命令行参数 > 环境变量 > 常见目录
CWEBP_CANDIDATES = [
    os.environ.get("CWEBP", ""),
    r"D:\workbuddydata\Claw\tools\webp\libwebp-1.4.0-windows-x64\bin\cwebp.exe",
    r"C:\tools\webp\bin\cwebp.exe",
]
GIF2WEBP_CANDIDATES = [
    os.environ.get("GIF2WEBP", ""),
    r"D:\workbuddydata\Claw\tools\webp\libwebp-1.4.0-windows-x64\bin\gif2webp.exe",
    r"C:\tools\webp\bin\gif2webp.exe",
]


def find_tool(candidates, name):
    for p in candidates:
        if p and os.path.isfile(p):
            return p
    # 最后在 PATH 里找一次
    from shutil import which
    w = which(name)
    return w or None


def kb(n):
    return round(n / 1024.0, 1)


def sniff(path):
    """
    按文件头判断真实格式，**不能信扩展名**。

    实测踩到：麦当劳 CDN 有些图 URL 以 .png 结尾，实际内容是 GIF
    （img/9900016078.png 的头是 GIF89a）。按扩展名交给 cwebp 会报
    BITSTREAM_ERROR 然后整张跳过——这就是最初有 2 张转不动的原因。
    """
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


def convert(cwebp, gif2webp, src, dst, quality, resize=None):
    """返回 True 表示成功。动图走 gif2webp 以保留动画。"""
    is_gif = sniff(src) == "gif"
    if is_gif:
        if not gif2webp:
            return False
        cmd = [gif2webp, "-q", str(quality), src, "-o", dst]
    else:
        cmd = [cwebp, "-q", str(quality)]
        if resize:
            cmd += ["-resize", str(resize), "0"]
        cmd += [src, "-o", dst]
    try:
        r = subprocess.run(cmd, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=60)
        return r.returncode == 0 and os.path.isfile(dst)
    except (subprocess.TimeoutExpired, OSError):
        return False


def main():
    ap = argparse.ArgumentParser(description="官方图片转 WebP")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--keep-original", action="store_true", help="转完保留原图")
    ap.add_argument("--max-kb", type=int, default=80)
    ap.add_argument("--cwebp", default="")
    args = ap.parse_args()

    if args.cwebp:
        CWEBP_CANDIDATES.insert(0, args.cwebp)
    cwebp = find_tool(CWEBP_CANDIDATES, "cwebp")
    gif2webp = find_tool(GIF2WEBP_CANDIDATES, "gif2webp")

    if not cwebp:
        print("❌ 没找到 cwebp.exe。零安装获取方式：")
        print("   curl -L -o libwebp.zip https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.4.0-windows-x64.zip")
        print("   解压后把 bin/ 目录路径用 --cwebp 传进来，或设环境变量 CWEBP")
        sys.exit(2)

    limit = args.max_kb * 1024
    print(f"  cwebp: {cwebp}")
    print(f"  gif2webp: {gif2webp or '（未找到，gif 将跳过）'}")
    print(f"  单张上限 {args.max_kb} KB｜目录 {IMG_DIR}\n")

    targets = []
    for ext in ("png", "jpg", "jpeg", "gif"):
        targets += glob.glob(os.path.join(IMG_DIR, "*." + ext))
    targets.sort()

    if not targets:
        print("  没有需要转换的图片"); return

    before = sum(os.path.getsize(t) for t in targets)
    print(f"  待处理 {len(targets)} 张，当前合计 {kb(before)/1024:.2f} MB\n")

    if args.dry_run:
        gifs = [t for t in targets if t.lower().endswith(".gif")]
        print("  [dry-run] 将执行：")
        print(f"    {len(targets) - len(gifs)} 张静态图 → cwebp -q 75（超限时降质量/缩放）")
        print(f"    {len(gifs)} 张动图 → gif2webp -q 75（保留动画）" + ("（工具缺失，会跳过）" if not gif2webp else ""))
        print(f"    更新 {len(DATA_FILES)} 个数据文件的 imgLocal 引用")
        print(f"    {'保留' if args.keep_original else '删除'}原图")
        print("\n  确认无误后去掉 --dry-run 再跑。")
        return

    done, skipped, oversize = [], [], []

    for src in targets:
        base = os.path.splitext(os.path.basename(src))[0]
        dst = os.path.join(IMG_DIR, base + ".webp")

        ok = convert(cwebp, gif2webp, src, dst, 75)
        if ok and os.path.getsize(dst) > limit:
            for q in (70, 60, 50):
                ok = convert(cwebp, gif2webp, src, dst, q)
                if ok and os.path.getsize(dst) <= limit:
                    break
        if ok and os.path.getsize(dst) > limit and sniff(src) != "gif":
            for w in (800, 600):
                ok = convert(cwebp, gif2webp, src, dst, 70, resize=w)
                if ok and os.path.getsize(dst) <= limit:
                    break

        if not ok:
            skipped.append(src); continue
        size = os.path.getsize(dst)
        if size > limit:
            oversize.append((os.path.basename(dst), kb(size)))
        done.append((src, dst, size))

    print(f"  转换成功 {len(done)} 张｜跳过 {len(skipped)} 张｜仍超上限 {len(oversize)} 张")

    if oversize:
        print("  仍超上限的（动图或内容过于复杂）：")
        for name, s in oversize[:12]:
            print(f"    {name}  {s} KB")

    # ---- 更新数据文件里的 imgLocal 引用 ----
    mapping = {}
    for src, dst, _ in done:
        mapping["img/" + os.path.basename(src)] = "img/" + os.path.basename(dst)

    changed = 0
    for rel in DATA_FILES:
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path):
            continue
        s = open(path, encoding="utf-8").read()
        orig = s
        for old, new in mapping.items():
            s = s.replace('"' + old + '"', '"' + new + '"')
        if s != orig:
            open(path, "w", encoding="utf-8").write(s)
            changed += 1
    print(f"  已更新 {changed} 个数据文件的图片引用（{len(mapping)} 条映射）")

    # ---- 原图处理：引用更新成功后才删 ----
    if not args.keep_original and changed == len(DATA_FILES):
        removed = 0
        for src, dst, _ in done:
            try:
                os.remove(src); removed += 1
            except OSError:
                pass
        print(f"  已删除原图 {removed} 张")
    elif not args.keep_original:
        print("  ⚠️ 数据文件未全部更新成功，保留原图不动（安全优先）")

    # ---- 清理：删掉没有任何数据文件引用的图片（含转完剩下的原图） ----
    # 按「是否被引用」删，而不是按扩展名删——这样即使某张没转成功也不会被误删。
    if not args.keep_original:
        referenced = set()
        for rel in DATA_FILES:
            path = os.path.join(ROOT, rel)
            if os.path.isfile(path):
                referenced |= set(re.findall(r'"(img/[^"]+)"', open(path, encoding="utf-8").read()))
        pruned = 0
        for p in glob.glob(os.path.join(IMG_DIR, "*")):
            rel = "img/" + os.path.basename(p)
            if rel not in referenced:
                try:
                    os.remove(p); pruned += 1
                except OSError:
                    pass
        print(f"  清理未被引用的图片 {pruned} 张")

    after = sum(os.path.getsize(p) for p in glob.glob(os.path.join(IMG_DIR, "*")))
    print(f"\n✅ 完成｜img/ 合计 {kb(before)/1024:.2f} MB → {kb(after)/1024:.2f} MB "
          f"（省 {round((1 - after / before) * 100)}%）")
    print("  下一步：跑 node tools/check_release.js 确认图片引用全部存在")


if __name__ == "__main__":
    main()
