# 麦当劳智能点餐推荐助手

> 一句话：**对着它说人话（"3 个人、150 块以内、有人减肥、不吃辣"），它用麦当劳官方 MCP 的真实菜单、真实价格、真实营养数据，给你三套可以马上下单的方案。**

演示方式：**双击 `index.html`**。不用起服务，不用联网，拔网线照样跑。

---

## 为什么这么设计

| 需求 | 做法 | 为什么值得知道 |
|---|---|---|
| 会场网络不可控 | 构建期调 MCP 落快照，运行时零网络 | `file://` 双击即开，断网演示不翻车 |
| 数据必须是真的 | 122 款商品每款都跑过官方 `calculate-price` | 不是估算、不是编的，底气来自调用记录 |
| Token 不能泄露 | Token 只活在本机 MCP 配置里 | 前端直连 MCP 必然暴露 Token，所以不做运行时直连 |
| 不许真下单 | 代码里没有下单入口，`create-order` 由安检器禁止 | 作品止于"算这一单"，下单交给官方小程序 |

**架构一句话**：`Python 构建脚本 → 麦当劳 MCP → 静态 JS 快照 + 本地图片 → 浏览器纯本地计算`。

```
tools/build_data.py ─┐
tools/build_campaigns.py ─┼─→ [麦当劳官方 MCP] ─→ data/menu_data*.js + img/
                          │                        ↓
index.html ← app.js ← engine.js ← service.js ← data/*.js（全局 window.MCD_DATA*）
```

---

## 它能干什么

**左：对话式提问。** 预算可以是区间甚至"无限"——`150 以内`、`100-200`、`不吃辣`、`3 个人`、`高蛋白`、目标随便填一句话。

**右：滚动活动板。** 麦当劳官方活动日历 + 优惠券，图片全是官方 CDN 原图。

**中间：固定三版方案，每版都能展开看账。**

| 方案 | 思路 |
|---|---|
| 省钱聚餐版 | 在预算内把人均压到最低，优先用券和套餐差价 |
| 低卡高蛋白版 | 按"蛋白质 / 热量"密度排序，砍掉高热量低营养单品 |
| 新品活动尝鲜版 | 只挑 `tags` 里带官方"上新"标记的商品 |

每个方案下两个按钮：**「这顿的热量」** 展开逐项热量明细 + 人均；**「营养成分」** 展开蛋白质/脂肪/碳水/钠。官方没给的数据**显示"官方未提供"**，绝不自己估算。

**时段切换**：下午茶 / 夜市 / 宵夜三套真实菜单快照。同一句"3 人 150 以内"，下午茶算出 **¥86.3**，夜市算出 **¥101.3**——菜单和价格本来就不同，不是随机抖动。

---

## 跑起来

```bash
# 演示（零依赖）
双击 index.html

# 自检
node tools/test_service.js      # 309 项断言
node tools/check_release.js     # 发布安检：Token / 联网 / 图片

# 重新拉真实数据（需本机 MCP 可用）
python tools/build_data.py                 # 当前时段菜单
python tools/build_data.py --slot latenight  # 指定时段
python tools/build_campaigns.py            # 活动日历
python tools/build_evidence.py             # 生成 EVIDENCE.md 调用证据
```

---

## 目录

```
index.html / style.css / app.js     前端展示（布局、动画、交互）
engine.js                           推荐算法：预算求解、营养权衡、套餐拆分
service.js                          契约层：多时段快照加载 + 统一 API
data/menu_data.js                   下午茶时段菜单快照
data/menu_data_night.js             夜市时段菜单快照
data/campaigns.js                   官方活动日历
img/                                142 张官方图片
tools/                              构建脚本 + 测试 + 安检
EVIDENCE.md                         MCP 调用证据（自动生成）
BUILD.md                            构建与安全说明
MCP_INTEGRATION.md                  MCP 工具清单与调用细节
CONTEST_DECLARATION.md              参赛声明
workbuddy.md                        开发对话记录（含踩坑实录）
```

---

## 数据来源

门店：**麦当劳广州新港西路餐厅**（`1400028`，24 小时营业），距中山大学南校园约 100 米。全部数据经麦当劳官方 MCP 授权接口获取，版权归麦当劳（中国）所有，本项目仅用于技术演示。

详细集成说明见 [`MCP_INTEGRATION.md`](MCP_INTEGRATION.md)，调用证据见 [`EVIDENCE.md`](EVIDENCE.md)。
