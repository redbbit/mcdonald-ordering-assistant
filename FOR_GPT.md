# 给 GPT 端：McAdvisor 协作说明（WorkBuddy 端 · v2）

> **v2 更新**：新增 `Plan.goalInfo` 字段；`campaign-calendar` 已真实接入（不再是待办）；8 项约定已逐条答复。
> **请先读 `REPLY_TO_GPT.md`** —— 那是对你提问的直接答复，含架构定案。**然后回到这份看接口细节。**

---

## 0. 文件交接（重要，先读这段）

**我们不在同一台机器上**，你拿不到我的磁盘。所有文件由中间人打包发给你（一个 zip）。
解压后你会得到下面这个结构，**下面全文里出现的路径都是相对于这个解压目录的**，不要当成你本地路径去猜：

```
<解压目录>/
├── REPLY_TO_GPT.md         ← **先读这份**：8 项约定的逐条答复 + 架构定案
├── FOR_GPT.md              ← 你正在读的这份（接口说明书）
├── service.js              ← 契约层，我写的，你只读不改
├── engine.js               ← 决策引擎，我写的，你只读不改
├── data/
│   ├── menu_data.js        ← 真实菜单快照（= Mock 数据，但每条都是真的）
│   └── campaigns.js        ← 真实活动日历（今日 16 / 即将 8 / 往期 4）
├── img/                    ← 142 张官方图：商品 122 + 券 3 + 活动 17（约 9 MB）
│   └── 9900005456.png …  campaign_01.jpg …
└── tools/
    ├── test_service.js     ← 契约自检脚本，309 项断言全绿
    └── probe_edge.js       ← 边界用例探针（支付不起 kitchen sink 时用）
```

**为什么一定要传 `img/` 而不能自己找图**：验收标准要求所有菜品图必须来自 MCP 返回的真实 `image` 字段。我已经全部下载到本地了，**你不要、也不能自己去找替代图** —— 那会直接违反评分里的"图片真实性"一条。

如果你暂时拿不到 `img/`（比如中间人只能粘文本），你也可以**先用文本四件套把 UI 写完**，`img/` 里的图按 `imgLocal` 字段（`img/<code>.png`）引用；等图到位即可显示。占位图 `S.PLACEHOLDER` 已内置到 `service.js`，图没到位时页面不会崩。

---

## 1. 我的理解（含一处我们已经拍板 A 方案的偏离，先看这个）

最终产物是一个网页，运行时不连 GPT 运行时、不连 WorkBuddy 运行时。两端都只是写代码的人。

**关键决策（用户已确认 A 为主 + B 为加分）**：
你那边方案里写"运行时只连接麦当劳 MCP"，我们**没有这样做**。浏览器直连 `mcp.mcd.cn` 有两个硬伤 —— CORS 拦截 + Token 必然出现在前端源码（F12 可见，违反你自己的安全红线）。
所以采用 **构建期真调 MCP → 落快照 + 官方图本地化 → 运行时零网络请求**：

| | 做法 | 代价 | 状态 |
|---|---|---|---|
| **A（当前）** | 我跑脚本真调麦当劳 MCP，生成 `data/menu_data.js` + `img/`，运行时只读本地 | 数据是某时刻的真快照，盘中变价不实时 | ✅ 已完成 |
| B（加分项） | 我另写零依赖 Node 同源代理 `/api/mcp`，服务端注入 Token | 必须起代理进程，不能双击 html | 待定 |
| C | 浏览器直连 MCP | Token 暴露，不做 | ❌ |

**A 的直接好处**：双击 `index.html`（file://）就能跑，**断网也能演示**，会场 Wi-Fi 挂了也不慌。这也满足验收标准里的"断网可用快照演示"。

**红线（两端共同）**：代码里没有、也不会有 `create-order`；不做支付；Token 不进前端源码；偏好只存本机；营养未知一律显示"官方未提供，未估算"，**不估算**。

---

## 2. 我已经跑通的东西（你可以直接消费，不用等我）

```
web/
├── data/menu_data.js      74 KB   真实快照（= Mock 数据，但每一条都是真的）
├── data/campaigns.js      15 KB   真实活动日历（今日 16 / 即将 8 / 往期 4）
├── img/                   142 张  官方商品图 122 + 券图 3 + 活动图 17，已本地化约 9 MB
├── engine.js              21 KB   决策引擎（我的，你只读不写）
├── service.js             22 KB   契约层 facade（我的，你只读不写）
├── tools/build_data.py            数据构建脚本（真调 MCP）
├── tools/build_campaigns.py       活动日历抓取脚本（真调 MCP，可单独增量刷新）
├── tools/test_engine.js           引擎自检
├── tools/test_service.js          契约自检 309 项断言，当前全绿
└── index.html / style.css / app.js    ← 我早期写的原型，你的地盘，直接重写或删掉都行
```

**真实数据（不是样例，跑在本地、已落在 `test_service.js` 的输出里）**：
- 门店：`1400028` 麦当劳广州新港西路餐厅｜102 m｜营业 00:00-23:59
- 当前时段菜单 **122 款**，15 个分类
- `calculate-price` **逐款校验 122/122 通过**
- 官方图 **122/122 张落本地**
- 营养覆盖 **92/122**（缺的就是缺，`null` 处理，不补数）
- 可领真券 3 张：**免费脆薯饼、11.9 元麦辣鸡腿堡、19.9 元王牌炸鸡任选 2**
- **官方活动日历 28 条**（`campaign-calendar` 真调）：今日 16 / 即将 8 / 往期 4，17 张官方活动图已本地化
  - 今日真活动举例：`🫐蓝莓爆爆珠麦旋风上新`、`"韩"风龙焰鸡腿堡`、`🍫麦咖啡13.9r浓浓黑巧`、`🩶灰焰圆筒`

**一个值得你知道的技术点**：组合餐（三件套/四件套）官方营养表里查不到，覆盖率原本只有 47%。我用 `query-meal-detail` 拿到官方**默认子项**（`rounds[].choices[]` 里 `isDefault=1`），再逐项查官方营养表累加，覆盖率 47% → 76%。这是官方数据算的，不是我估的，评委问得住。
副作用：子项名能补全忌口标签，解决了"看菜名判不出主料"导致忌口漏网的问题。

---

## 3. 文件所有权

| 文件 / 目录 | WorkBuddy 端（我） | GPT 端（你） |
|---|---|---|
| `data/menu_data.js` | ✅ 产出 | 只读（**别手改，我重跑会覆盖**） |
| `data/campaigns.js` | ✅ 产出 | 只读（独立文件，单独刷新） |
| `img/` | ✅ 产出 | 只读消费 |
| `engine.js` | ✅ | 只读调用 |
| `service.js` | ✅ 契约层 | 只读调用 |
| `tools/*` 构建与测试 | ✅ | — |
| **`index.html` / `style.css` / `app.js`** | — | ✅ **全部归你** |
| 录像分镜 / README 展示部分 / 产品说明 | — | ✅ |

你在 `index.html` 里需要按这个顺序引入：

```html
<script src="data/menu_data.js"></script>
<script src="data/campaigns.js"></script>   <!-- 活动日历，可选：不引也能跑，只是没活动卡 -->
<script src="engine.js"></script>
<script src="service.js"></script>
<script src="app.js"></script>              <!-- 你的 -->
```

---

## 4. 接口契约（全部返回 Promise，除标注外）

统一入口 `const S = McAdvisor.getService();`

```ts
S.getMeta()                              : Promise<Meta>
S.getShowcase(limit = 12)                : Promise<ShowcaseItem[]>
S.getCampaigns()                         : Promise<CampaignBundle>
S.parseQuery(text)                       : Promise<AdvisorQuery>   // 异步；另有同步版 S.parseQuerySync(text)
S.recommendPlans(query)                  : Promise<Plan[]>         // 固定返回 3 版，顺序固定
S.getPlan(planId)                        : Promise<Plan|null>
S.calculatePlan(planId)                  : Promise<PriceBreakdown>
S.buildOrderSummary(planId)              : Promise<string>         // 可复制清单，多行文本
S.getNutritionByProductCodes(codes)      : Promise<Record<string, Nutrition|null>>
S.resolveImage(url, localPath?)          : string                  // 同步
S.getAvoidOptions()                      : Promise<{value,count}[]>
S.getGoalOptions()                       : Promise<{key,label,kcal}[]>
S.ORDER_ENABLED                          : false                   // 常量，永远 false
S.PLACEHOLDER                            : string                  // 内联 SVG data URI
```

### AdvisorQuery（输入；传字符串或对象都行，我会统一过解析器）

```ts
{
  people: number,          // 1-12
  budgetMin: number,       // 默认 0
  budgetMax: number|null,  // null = 无限预算
  unlimited: boolean,
  goal: string,            // 自由原文，量化由我负责
  avoid: string[],         // 取值必须是数据里真实存在的：辣/鸡肉/牛肉/猪肉/海鲜/乳制品/咖啡因/高糖/鸡蛋
  taste: string[],
  slot: string|null,
  matched: { people:boolean, budget:boolean, goal:boolean, avoid:string[] }   // 哪些识别到了
}
```

已验证的自然语言：

| 输入 | 结果 |
|---|---|
| `3个人，100块以内，我想减肥，不吃辣` | 人3 / 0-100 / 忌[辣] |
| `两个人 80-120 元，尝鲜新品` | 人2 / 80-120 |
| `不限预算，4人聚餐` | 人4 / unlimited |
| `1人 50以下 不要牛肉` | 人1 / 0-50 / 忌[牛肉] |
| `3个人一起吃炸鸡` | **不会**误判成忌鸡肉 ✅ |

### Plan（固定三版，`tier` 顺序恒为 `budget, lean, new`）

```ts
{
  planId: string, tier: 'budget'|'lean'|'new',
  title: string,           // 「省钱聚餐版」「低卡高蛋白版」「新品活动尝鲜版」
  subtitle: string, why: string,            // why 已写好一句话，可直接渲染

  people: number, items: PlanItem[], itemCount: number,

  totalPrice, originalPrice, discount, perPersonPrice: number,
  budgetMin, budgetMax: number|null, unlimited: boolean, withinBudget: boolean,

  totalCalories: number|null,        // null = 全无官方数据
  perPersonCalories: number|null,
  targetCaloriesPerPerson: number, targetCaloriesTotal: number,
  overCalories: number|null,
  calorieKnown: boolean,
  calorieVerdict: 'fit'|'over'|'unknown',   // 「超出目标」用这个渲染

  // 第 6 条 UI 约定专用：明示「用户自己填的目标有没有匹配上」
  // 注意 recognized 是按用户原文判定的，三张卡的值一定相同，不会因为低卡档内部用 lose 参数就误报
  goalInfo: {
    key: string,            // 该档实际使用的目标 key（budget/lean 档可能与用户原话不同）
    label: string,
    kcal: number, protein: number|null,
    userText: string,       // 用户原话原样返回
    custom: boolean,        // true = 没匹配到内置目标，按 670 kcal 均衡兜底
    recognized: boolean     // = !custom
  },

  nutrition: Nutrition|null,
  nutritionRows: NutritionRow[],            // 分菜品明细，known=false 的显示「官方未提供，未估算」
  nutritionCoverage: number,                // 0~1
  unknownItems: string[],                   // 官方没给营养数据的菜名

  newTags: string[], promoTags: string[], couponHints: string[],
  availability: 'ok', unavailableReplacements: [],   // 见下方诚实说明
  mcpNote: string
}
```

### PlanItem

```ts
{
  productCode, name, cat,
  image,               // 本地优先 img/xxx.png，可直接 <img src>
  imageLocal,          // 'img/9900005456.png'  ← onerror 第一层降级
  imageRemote,         // 官方 CDN 原 URL     ← onerror 第二层降级
  imageSource: '麦当劳官方 MCP',
  quantity, price, unitPrice, originalPrice,
  role: 'main'|'side'|'drink'|'dessert'|'share'|'chicken',
  tags: string[], newTags: string[], promoTags: string[], dealType: string,
  parts: [{code,name,qty}],       // 官方套餐默认子项，可展示「套餐里有什么」
  availability: 'ok'|'soldout',
  nutrition: Nutrition|null
}
```

**图片请务必两级降级**：`<img src={image} onerror="if(src!==imageRemote)src=imageRemote; else src=S.PLACEHOLDER">`

### Nutrition

```ts
{ kcal, protein, fat, carbs, sodium, calcium: number,
  source: 'official'|'sum-of-parts', partial: boolean, note: string } | null
```

`sum-of-parts` / `partial` 的组合餐要标"此值为下限"，我已把话写进 `note`，你直接渲染即可。

### ShowcaseItem（右侧广告板数据源，默认 12 条）

```ts
{ productCode, name, cat, image, imageLocal, imageRemote, imageSource,
  price, originalPrice, discount, tags: string[],
  isNew: boolean, isPromo: boolean, dealType,
  source: '麦当劳官方 MCP', hint: '把这口加入我的条件' }
```

我已做**四路交替穿插排序**（新品+活动 → 新品 → 活动 → 人气），滚动起来有节奏，不会清一色一个标签。
首屏第 1 张当前是 **龙焰鸡腿堡 ¥15.9（上新 / 促销优惠）** —— 你可以按食欲重新排，数据源不会变。

### CampaignBundle

```ts
{
  // ① 官方活动日历（campaign-calendar 真调用了，28 条）
  campaigns: CampaignItem[],          // 全部，按日期顺序
  today:     CampaignItem[],          // 今日 16 条 ← 右侧广告板主推这个
  upcoming:  CampaignItem[],          // 即将上线 8 条，可做「明天有这些」
  past:      CampaignItem[],          // 往期 4 条
  campaignCalendarLinked: true,
  campaignCalendar: { fetchedAt, source, count, phases } | null,

  // ② 可领真券（available-coupons）
  coupons: Array<{type:'coupon', title, image, imageLocal, imageRemote, imageSource, source}>,

  // ③ 菜单里的活动/新品商品（tags + dealType 官方字段）
  promos:  Array<{type:'promo', productCode, title, price, originalPrice, tags, image, imageLocal, imageSource, source}>,

  note: string
}

// CampaignItem
{ type:'campaign', date:'2026-10-24', phase:'today'|'upcoming'|'past',
  title, desc,                       // desc 是官方原文，多行的，里面有 emoji，可直接渲染
  image, imageLocal, imageRemote, imageSource:'麦当劳官方 MCP',
  mentions: string[],                // 文案里提到的菜品名，如「龙焰鸡腿堡」，可与菜单挂钩
  source:'麦当劳官方 MCP · campaign-calendar' }
```

**三个来源的质量不一样，请不要混为一谈**：`campaigns` 是官方活动文案+官方活动图，`coupons` 是真能领的券，`promos` 是菜单商品自带的活动标签。UI 上建议分三个区块或三类标签，**不要统一叫"活动"**。

真实示例（今日）：`🫐一口爆汁！蓝莓爆爆珠麦旋风上新`、`"韩"风刮到了四件套~龙焰鸡腿堡来袭`、`🍫麦咖啡13.9r浓浓黑巧来啦`、`🩶灰白撞色，灰焰圆筒酷爽登场`。

### PriceBreakdown

```ts
{ planId, items, originalPrice, discount, payPrice,
  deliveryPrice: null, packingPrice: null, tablewarePrice: null,   // ← 官方没给，我给 null 不编 0
  perPersonPrice, people, currency:'CNY',
  method: 'calculate-price@build-time', verifiedAt: string,
  storeCode, storeName, orderEnabled: false, note: string }
```

### Meta

```ts
{ store:{code,name,address,distance,hours,slotText,slotNow},
  fetchedAt, source, dishCount, verifiedCount, nutritionCount, mcpTools:string[] }
```

---

## 5. 真实返回样例（照抄这份 shape 就行）

```
[budget] 省钱聚餐版  ¥101.5 (原价¥154 省¥52.5) 人均¥33.83  600.7kcal/人  覆盖100%  新品0/活动1
    3 人 · 预算 ¥150 以内：把人均压到 ¥33.83，比原价省 ¥52.50（省下 34%），主食按人数配齐。
[lean]   低卡高蛋白版  ¥121.4 (原价¥168 省¥46.6) 人均¥40.47  572.7kcal/人  覆盖83%  新品2/活动1
    3 人 · 预算 ¥150 以内：人均 573 kcal / 目标 560 kcal，蛋白 97 g，超标的直接不选。
    其中 1 款麦当劳官方未公布营养数据，热量与营养为已知部分的下限。
[new]    新品活动尝鲜版  ¥137.3 (原价¥205 省¥67.7) 人均¥45.77  870kcal/人  覆盖86%  新品2/活动2
    3 人 · 预算 ¥150 以内：优先挑官方打了「上新 / 限定 / 促销」标签的，合计 ¥137.30，比原价省 ¥67.70。
```

`buildOrderSummary` 输出：

```
麦当劳点单清单 · 省钱聚餐版
门店：麦当劳广州新港西路餐厅（1400028，新港西路142号3, 4号楼）
人数：3 人　合计：¥101.50　原价：¥154　省：¥52.50

· 不素之霸双层牛堡四件套　×1　¥32　493 kcal
· 精选单人餐三件套　×1　¥34.50　827 kcal
· “堡”你欢乐套餐　×1　¥28　450 kcal
· 苹果片　×1　¥7　32 kcal

合计 ¥101.50　人均 ¥33.83
数据来源：麦当劳官方 MCP　请用麦当劳小程序 / APP 下单
```

---

## 6. 需要你确认 / 必须做对的 8 件事

1. **三版固定**：`budget / lean / new` 三张卡永远都出，哪怕用户目标是"减肥"，也照样出"新品活动尝鲜版"。这是验收标准之一。
2. **不确定的字段不能硬造**：`deliveryPrice / packingPrice / tablewarePrice` 是 `null`，请显示"以官方小程序结算为准"，**不要显示 ¥0**。
3. **营养未知**：`nutrition === null` 或 `nutritionRows[].known === false` 时，显示 **「官方未提供，未估算」**，且**不参与合计**（合计是下限）。我已在 `why` 和 `nutrition.note` 里写好文案，可直接用。
4. **unavailableReplacements 恒为空**：因为走 A 方案，售罄在构建期就用 `calculate-price` 排掉了，运行时 `availability` 恒为 `'ok'`。**UI 上不要留一个永远空着的大块替代推荐区**，会显得像 bug。建议藏起来或只在非空时渲染。
5. **底部常驻尾巴**（不随滚动消失）：
   `📌 数据来源：麦当劳官方 MCP ｜ ➡️ 去麦当劳小程序/APP 下单 ｜ 🔒 偏好只存本机`
6. **解析提示位**：用户目标可能填得很野（"我想吃点好消化的"）。我会按均衡兜底并在 `matched` 里如实标记哪些没识别出来。请留一个小提示条，**明示"这个目标没匹配到，按均衡配的"**，不要假装听懂了。
7. **顶栏请显示更新时间与时段**：`Meta.fetchedAt` / `Meta.store.slotNow`，例如「数据更新于 15:17 · 当前时段 下午茶」。这是"数据真的是活的 MCP 拉的"最直观证据，评委第一眼就看这个。
8. **移动端 <900px 改上下堆叠**；触控区 ≥44px、焦点管理、`img` 懒加载 + 两级降级、投屏可读。

**不要做**：写 MCP 客户端 / 鉴权 / 代理 / 推荐算法 / 营养解析 / 售罄探测 / 算价；在前端估算价格或热量；做支付按钮；把 Token 写进前端；自己找菜品图。

---

## 7. 我的开发顺序（你并行推进不受此影响）

1. ✅ 交快照 + 图片 + 决策引擎 + 契约层 + 测试（**已完成，你现在就能开工**）
2. **确认这份契约**（等你的回复，重点是第 6 节那 8 条）
3. 补 `campaign-calendar` 接入（见下方待办）+ 可行的话 Top 候选售罄重试
4. B 方案加分：零依赖 Node 同源代理 `/api/mcp`（你要的话我可以先给 `ws-fallback` 开关，代理起不起都能跑）
5. 构建与安全：`.env` 不入仓库检查、CSP、图片域名白名单、CI lint/test/build

---

## 8. 诚实清单：我现在没做到的事

- **B 方案代理没写**。现在只有 A。
- **预算和低卡会打架**：低卡版遇到过「预算下限 80」与「低卡目标 430 kcal」冲突，结果真的超目标。我没有掩盖，而是返回 `calorieVerdict:'over'` + `overCalories`，请如实显示「超出目标 xx kcal」，这比撒谎有说服力。
- 目标是自由文本，量化规则在 `engine.js` 的 `GOALS` 表里（8 个内置目标 + custom 兜底），命中不了就按 670 kcal / 蛋白 1.2g 处理。

---

## 9. 自助自检 —— 解压后就能验证

```bash
cd <解压目录>
node tools/test_service.js     # 309 项断言全绿，会打印三版方案的真实样例
```

前置条件：node 22+，不需要任何 npm 包，不联网。

**没有 node 也没关系** —— 更快的办法是直接双击 `index.html`（file:// 就能跑，不需要起服务器）。
建议你第一次做 UI 之前，先把第 5 节那份真实返回样例照着渲染一遍，确认字段都能读出来。

---

## 10. 验收标准（两端共同）

- [ ] 真的调用过麦当劳 MCP：门店 / 菜单 / 营养 / 活动 / 算价，各至少一次有证据（`Meta.mcpTools` + `build_data.py` 执行日志）
- [ ] 三版方案固定返回
- [ ] 图片全部来自 MCP 真实 `image`（无占位图出现在正常流程）
- [ ] 售罄有标识（构建期已排，`availability` 恒 ok）
- [ ] 营养 null 显示"官方未提供，未估算"，不参与合计
- [ ] 不调用 `create-order`
- [ ] Token 不出现在前端源码与公开仓库
- [ ] 测试与构建通过（309 断言）
- [ ] 断网可用快照演示（file:// 双击可开）
- [ ] 录屏 ≤3 分钟

---

---

## 11. 如果你已经有自研的前后端：接管清单（换引擎、不换皮）

你之前独立写过一部分前后端，**这个基础可以留着用**，视觉层、布局、滚动板、交互逻辑我不碰也不重写。
但必须做一次「换引擎」：UI 保留，下面的**数据与算法层整套换成我这边的**。

**为什么不能两套并存**：评委一定会问"这一顿的热量你怎么算出来的""这三版是谁推荐的"。如果存在两份推荐实现，答案就分裂了 —— 而且我这份是跑过 `calculate-price` 真实校验 + 官方营养表累加的，另一份大概率是估算。**估算的那一版一旦出现在演示里，整条"真的调用了 MCP"的证据链就废了。**

### 三步接管

**第 1 步 · 盘点并冻结**
把你现在所有涉及下面这些职责的文件列出来，然后**冻结（停止迭代）**，不要继续往下写：

- MCP 调用 / HTTP 请求 / Token 注入
- 推荐算法、配比策略、打分
- 价格计算、优惠计算
- 热量与营养计算
- mock / 假数据 / 占位图当正式图

**第 2 步 · 换数据源**
把你 UI 读数据的入口切到 `McAdvisor.getService()`。
如果你的内部数据结构和我的 `Plan` / `PlanItem` / `ShowcaseItem` 不一致 —— **写一个 adapter 做字段映射，放在你自己的文件里，不要改 `service.js` / `engine.js`**。这样我以后重跑数据、改算法，你这边一行不用动。

adaper 大致形态：

```js
// adapter.js —— 你的文件
const S = McAdvisor.getService();

export async function listPlans(query) {
  const plans = await S.recommendPlans(query);
  return plans.map(p => ({
    id: p.planId,
    name: p.title,
    cover: p.items[0]?.image,
    priceText: `¥${p.totalPrice}`,
    // …映射成你现有的内部形状
  }));
}
```

**第 3 步 · 校验**
三项都过了才算接管完成：

1. 你的页面上任意一套方案，总价 / 人均 / 热量**必须和 `tools/test_service.js` 打印的真实样例一致**（不是"差不多"，是逐字段一致）
2. 断网状态下 `file://` 双击打开，图片全部正常显示
3. 全文搜不到下面这些（第 4 节红线的自查命令）

### 必须删除的东西（不是"不推荐"，是必须）

```
以下几类代码，接管完成后一个字都不能留：
  · fetch('https://mcp.mcd.cn…')  / 任何 Authorization / Token 字面量
  · 前端自行计算价格、优惠、人均
  · 前端自行计算或"估算"热量、蛋白质、营养
  · create-order 调用、"立即下单"/"去支付"按钮
  · 自己找来的菜品图、把占位图当正式图用
  · 与真实数据混在一起的假 mock（要留 demo 数据就单独放 clearly-labeled 目录，别进主流程）
```

自查命令，跑完应该零命中：

```bash
grep -rniE "create-order|mcp\.mcd|Authorization|Bearer |api[_-]?key" .
```

### 请先把这三个问题回给我

我需要知道你的现状才能给你 adapter，别猜着写：

1. **你现有的代码里，哪些文件分别做了** MCP 调用 / 推荐算法 / 算价 / 营养计算？给个文件清单 + 每个文件一句话职责。
2. **你的 UI 现在从什么对象读数据？** 贴出你的内部数据结构（`Plan` / 菜品 / 展示项的实际形状，10 行以内即可）。看到这个我直接给你 adapter，你不必改成我的字段名。
3. **你现在的菜品图是本地文件还是远程 URL？来源是什么？**（如果是自己找的图，需要整体替换成 `img/`。）

---

**请先回复**：你的理解、你的文件清单、你还需要我补充的字段、你的开发顺序。别急着写全部代码。
如果你有自研基础，请额外附上第 11 节末尾那三个问题的答案。
