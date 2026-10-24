# MCP 集成说明

> 这一份写给评委：我们到底调了麦当劳 MCP 的哪些工具、怎么调的、为什么是"构建期调"而不是"运行时调"。

---

## 1. 用了哪些工具

| MCP 工具 | 用途 | 调用量 | 落到了哪里 |
|---|---|---|---|
| `query-nearby-stores` | 按位置找门店 | 每个快照 1 次 | `Meta.store`（门店码、地址、营业时段） |
| `query-meals` | 拉取服务端当前时段菜单 | 每个快照 1 次 | `dishes[]`、`categories[]` |
| `query-meal-detail` | 拆解套餐内默认子项 | 每个套餐 1 次 | 子项清单 → 参与营养累加 |
| `list-nutrition-foods` | 官方营养成分表 | 每个快照 1 次 | `dish.kcal / protein / fat / carb / sodium` |
| `available-coupons` | 当前可领优惠券 | 每个快照 1 次 | `data/campaigns.js` 的券部分 |
| `campaign-calendar` | 官方活动日历 | 每次刷新 1 次 | `data/campaigns.js` 的活动部分 |
| `calculate-price` | **官方算价（含优惠）** | **每款商品 1 次** | `dish.price / orig / save` |

**`create-order` 一次都没有调用，也没有封装任何可调用入口。** `tools/check_release.js` 会扫描发布文件集合，一旦 `create-order` 出现在可执行代码里就直接判失败——这是机器校验，不是口头承诺。

---

## 2. MCP 调用发生在哪：两条路径，都在本机

**浏览器从头到尾没有直接碰过 MCP。** 它要么读本地快照，要么跟本机服务说话。

| 路径 | 谁调 MCP | Token 在哪 | 网络 |
|---|---|---|---|
| **离线**（双击 `index.html`） | 构建期的 `build_data.py` | 只在本机 MCP 配置里 | 运行时**零网络请求** |
| **在线**（`python server.py`） | `server.py` 进程 | 只在该进程内存里 | 只连 `127.0.0.1` |

为什么不让浏览器直连 MCP，三条理由任一条都足够否决：

1. **CORS**：`mcp.mcd.cn` 没有给浏览器用的跨域响应头。
2. **Token**：前端直连 = Token 一定出现在 JS 里，F12 抄走即可——**违反任何一条安全底线**。
3. **离线**：会场网络不可控，`file://` 双击可演示是硬需求。

在线模式绕开前两条的办法是**加一层本机服务**：浏览器 → `127.0.0.1:4317/api/*` → `server.py`（持 Token）→ `mcp.mcd.cn`。浏览器拿不到 Token，因为 Token 从没离开过那个进程。

所以安检器的口径也从"禁止 `fetch`"改成了：**允许连本机服务和官方图床，禁止任何外部域名请求目标**。红线没放松，只是从"不联网"收窄成"不连外网"——毕竟本机那个口子只通向持 Token 的进程，而外网的口子通向任何地方。

**两条路径的调用都是真的**：122 款商品每一款都单独跑过官方 `calculate-price`，证据在 `EVIDENCE.md`；在线模式每次调用还会返回 `requestId` + `fetchedAt`，可以直接出示。

### 在线/离线的能力边界（这点必须说清）

在线模式**不是**把离线功能换个数据源重做一遍，而是**多出三类只有当场调 MCP 才能做的事**：

| 能力 | 离线 | 在线 |
|---|---|---|
| 价格 | 快照价，标 `simulated` | 官方实算 |
| 库存 | 一律 `unknown` | 真探测，返回 60006 才算售罄 |
| 券试算 | 券面规则匹配，标 `simulated` | 逐张真实试算 |

反过来，**离线不做的事绝不假装做了**。离线返回 `unknown` 而不是猜一个售罄，返回 `null` 而不是编一个价格。这条由 `tools/test_adapter.js` 的 42 项断言守着。

---

## 3. 几个踩出来的坑（给后来人）

`query-meals` **没有时段参数**，只有 `storeCode / orderType / beType / beCode / reservationDate`。服务端按**调用时刻**返回当前时段的菜单——想去查询历史时段是不可能的，只能在那个时段里真抓。这是快照方案成立的根本原因：三个时段 = 三次真实抓取。

`query-meal-detail` 返回的不是单个 JSON，而是**多段 JSON 串接**，必须用 `raw_decode` 逐段解析；套餐默认子项要筛 `isDefault=1 且 quantity>0`。改完这两处，套餐营养覆盖率从 47% 提到约 76%。

套餐模板会把**非餐品（棒球帽 / 丝巾 / 按摩捶）和单独包装的酱包**当成"默认配菜"返回，需要正则 + role 双重过滤，否则会在推荐里出现"加购丝巾"。

新品判定不能看 `taste` 字段。真实的新品标记在 `tags` 的「上新」里，靠口味文案判断会把一堆"限定"品误判成新品。

**官方的"失败"是 HTTP 200 包着的 `success:false`。** 漏传参数、限流、券不在时段，全都长这样。不检查 `success` 字段就等于把失败包装成真实数据返回——比直接报错更糟，因为前端会拿它当真价显示。我因此踩过一次：`query-nearby-stores` 传了不存在的 `address`（必填其实是 `beType` + `searchType`），一直返回"成功"，加了统一校验才发现**这个接口从未真正成功过**。教训是调外部 API 要先用 `list_tools()` 拿到 `inputSchema` 的 `required`，别靠猜。

`calculate-price` 的入参是 **`items` 数组 + `orderType`/`beType`**（不是单个 `productCode`），返回金额单位是**分**，要 `/100`。返回文本里除了正文还粘着一段"数据传参规则"样例，直接 `json.loads(整段)` 会报 Extra data，要在 `{"success"` 处用 `raw_decode` 截取第一段。

`calculate-price` 返回的金额单位是**分**，要 `/100`。

---

## 4. 数据不自洽时怎么办

**原则：官方没给的数据，界面上写"官方未提供"，绝不自己估算。**

具体三处：

- 某款商品查不到官方营养 → 该商品不进"低卡高蛋白版"候选池，其余方案仍可出现；展开营养成分时该项标注"官方未提供"。
- 某款商品 `calculate-price` 失败（不可售）→ 直接剔除，不进任何推荐。
- 三个方案的提示文案是否显示"已识别你的目标"，按**用户原始输入**判定，按内部推导结果判定会导致三张卡片不一致。

---

## 5. 复现

```bash
python tools/build_data.py                # 抓当前时段 → data/menu_data.js
python tools/build_data.py --slot night   # 抓夜市   → data/menu_data_night.js
python tools/build_data.py --slot latenight # 抓宵夜  → data/menu_data_latenight.js
python tools/build_campaigns.py           # 活动日历 → data/campaigns.js
python tools/build_evidence.py            # 生成调用证据 → EVIDENCE.md
```

每个快照文件顶部都带 `fetchedAt`、`store.slotText`，页面顶栏会显示"数据更新于 HH:MM"。**演示当天建议重跑一次**，否则评委可能看到昨天的时段菜单。
