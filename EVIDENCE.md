# 麦当劳 MCP 调用证据

> 本文件由 `tools/build_evidence.py` 自动生成，**记录内容不含 Token 与请求体原文**。
> 生成时间：**2026-10-24 17:56:44**

架构说明：**构建期调用 MCP → 落本地数据快照 → 运行时零网络请求**。
运行时不联网（保证会场断网可用），但每一次调用的返回都在构建期内真实发生过，下面就是记录。

| 工具 | 用途 | 返回字节 | 耗时 | 结果 | 拿到什么 |
|---|---|---:|---:|---|---|
| `query-nearby-stores` | 按位置查门店 | 2909 | 1172 ms | ✓ JSON success | 5 家门店 |
| `query-meals` | 当前时段菜单 | 30970 | 1165 ms | ✓ JSON success | 132 个商品/分类条目 |
| `list-nutrition-foods` | 官方营养表 | 6666 | 903 ms | ✓ JSON success | 160 款官方营养数据 |
| `available-coupons` | 可领优惠券 | 1270 | 926 ms | ✓ 有返回（官方 markdown 格式） | 3 张可领券 |
| `campaign-calendar` | 官方活动日历 | 8275 | 959 ms | ✓ 有返回（官方 markdown 格式） | 13 个日期块 |
| `query-meal-detail` | 套餐配方（含默认子项） | 13551 | 975 ms | ✓ JSON success | 含套餐默认子项配置 |
| `calculate-price` | 官方算价 | 2837 | 990 ms | ✓ JSON success | 实付 ¥33.50（原价 ¥33.50） |

## 全量算价校验

- 门店 `1400028` 当前菜单 **122 款**，每一款都单独调用过 `calculate-price`，全部通过。
- 校验结果写进了每款商品数据里（不可售的会被剔除，不进推荐候选池）。
- **没有调用过 `create-order`，也不提供任何下单入口** —— 作品止于算价，下单要用户自己去麦当劳官方小程序/APP。

## 图片来源

页面上的 142 张图全部来自 MCP 返回的官方 `image` 字段，构建期下载到本地 `img/`：

- 商品图 122 张（`query-meals`）
- 优惠券图 3 张（`available-coupons`）
- 活动图 17 张（`campaign-calendar`）

外链域名只在白名单内：`menu-img.mcd.cn` / `img.mcd.cn` / `cms-cdn.mcd.cn`。
