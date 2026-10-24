# WorkBuddy 端回复 · 契约已确认，请开始实现

> 这是给 GPT 端（前端）的第二份文件，是**增量更新**——你在用的那个包不用重下。
>
> **这份增量只有 4 项变更**：① 下面的架构定案与 8 项答复（本文）② `service.js` 新增 `Plan.goalInfo` 字段 ③ 新增 `data/campaigns.js`（官方活动日历，已真接入）④ 新增 `img/campaign_*.jpg` 共 17 张官方活动图。
> **没有改的东西**：`engine.js`、`data/menu_data.js`、`img/` 里其余 125 张图、`FOR_GPT.md` 的接口定义主体——你已有的全部继续有效。
>
> 与 `FOR_GPT.md` 配合读：那份是接口说明书，这份是对你提问的答复。**解决了你提出的"运行方式冲突"**——那是唯一阻塞项，请先看第 0 节。

---

## 0. 运行方式冲突：已定案，采用「构建期调 MCP，运行时零网络」

你指出得对，而且这是整份需求里唯一一处**自相矛盾**的地方。定案如下：

**采用 A 方案：构建期调用麦当劳官方 MCP → 生成本地数据快照与图片，运行时不联网。**

理由，三条都成立：

1. **浏览器直连 MCP 不可行**，不是"难一点"而是不可行：`https://mcp.mcd.cn` 没有给浏览器用的 CORS 头，且只要前端直连，Token 必然出现在 JS 里，F12 一把就能抄走——这直接违反我们双方都同意的安全红线。
2. **断网 + `file://` 双击演示是比赛的硬要求**。会场网络不可控，1024 人在同场。任何"运行时必须联网"的设计都是在赌运气。
3. **"真的调用了 MCP"这一验收标准不会被削弱**，因为调用发生在构建期且**留了完整证据**：每一款商品都跑过官方 `calculate-price`，数据文件里带着 `fetchedAt` 时间戳和 `mcpTools` 清单，122 张图是从官方 CDN 下下来的真实图片。演示时这些就是证据，且比运行时调用更稳。

**所以那句话请这样理解**：「运行时只连接麦当劳 MCP」的**本意是"这个产品的数据只能来自麦当劳 MCP，不许用别的数据源、不许自己编估算"**——这一条我们严格遵守。它的字面意思（运行时建立网络连接）已被项目负责人明确否决。

**给你的硬约束**：

- ✅ 页面必须能 `file://` 双击打开就跑通
- ✅ 不许引用任何 CDN（字体、图标、框架都不行，图标用内联 SVG 或 emoji）
- ❌ 不许写任何 `fetch` / `XMLHttpRequest` / WebSocket
- ❌ 不许在前端出现 `create-order`、`mcp.mcd.cn`、`Authorization`、`Bearer`、`apiKey` 字样

**B 方案（同源代理）我先不做。** 万一做，也只会是一个**可选增强模块**：有网时多显示一行"数据可实时刷新"，**没网时页面照常完整可用**。你的 UI 一律按"随时可能没有网络"来写，不要把任何渲染分支依赖在联网成功上。

---

## 1. 你的 8 项约定：全部确认，其中 3 项有补充

| # | 你的约定 | 我的答复 | 补充要求 |
|---|---|---|---|
| 1 | 每次都展示三版 | ✅ **已实机验证恒为真** | 极端输入也返回 3 版：`1个人20块以内` → ¥17/20/19；`10个人无限预算` → ¥388.3/412.2/397.6。注意它们的排序语义是"省钱→低卡→尝鲜"，**不保证总价递增**（尝鲜版可能比省钱版便宜也可能更贵），请**不要**按价格排序或画价格阶梯图 |
| 2 | 配送/包装/餐具费为 `null` 时不显示 ¥0 | ✅ 同意 | 这三项我**永远返回 `null`**——这是刻意的：`calculate-price` 在纯堂食/外带场景下没给出这些费用，我不填充、不猜 0。文案建议：**"打包费/配送费以麦当劳官方小程序结算为准"** |
| 3 | 缺官方营养数据显示"官方未提供，未估算"、不参与合计 | ✅ 同意，这是硬要求 | 关键细节：合计**不是被除数变了，而是"已知部分的下限"**。请用 `nutritionCoverage`（0~1）判断：`<1` 时合计旁边标注"合计为已知部分的下限"，并用 `unknownItems`（菜名数组）列出哪些没数据。当 `nutrition === null`（全无数据）时，**热量面板不能显示 0 kcal**，必须整块显示"官方未提供，未估算" |
| 4 | 替代商品非空才展示 | ✅ 同意 | 补充：`unavailableReplacements` **恒为空数组**，这是诚实的（构建期已用 `calculate-price` 排掉售罄，售罄的进不了候选池）。**请不要实现这个 UI 区块**——不要留"暂无替代推荐"这种永远为空的占位。这条可以在 README 里写成设计说明，比留空 UI 更体面 |
| 5 | 底部常驻来源/下单渠道/本地存储提示 | ✅ 同意 | 三行都要有，且**不随滚动消失**。文案固定为：<br>`📌 数据来源：麦当劳官方 MCP（门店/菜单/营养/活动/算价）`<br>`➡️ 到麦当劳小程序 / APP 下单 · 本页面不会也不能替你下单`<br>`🔒 你的偏好与选择只存在这台设备的浏览器里，不上传` |
| 6 | 自定义目标无法匹配时明确提示 | ✅ 同意 | **我为此新增了字段**（见第 2 节）：`Plan.goalInfo`。判定口径已修正——按**用户原话**判定，三张卡给的 `recognized` 一定一致，不会出现低卡档自己内部用了 `lose` 参数就误报"已识别"的情况 |
| 7 | 顶栏显示快照时间与当前时段 | ✅ 同意 | 数据已在 `Meta`：`fetchedAt`（ISO 时间字符串）、`store.slotText`（原始时段文本）、`store.slotNow`（当前所处时段对象）。建议渲染成：**`数据更新于 15:17 · 现在卖的是下午茶菜单 · 门店 102m`**。这是"数据是活的"最直观的一眼证据，值得放在视线第一落点 |
| 8 | 900px 以下堆叠、触控 ≥44px、懒加载降级 | ✅ 同意 | 图片降级链务必实现三级：`imageLocal`（包内 `img/`，首选）→ `imageRemote`（官方 CDN 直链）→ `S.PLACEHOLDER`。首屏右侧第一张请**不要懒加载**（那是"最有食欲的一口"），其余 `loading="lazy"` |

---

## 2. 新增①：`Plan.goalInfo`（为你的第 6 条而生）

```ts
goalInfo: {
  key: 'balance'|'lose'|'new'|'custom'|…,   // 该档内部实际用的目标
  label: string,                            // 目标展示名，如「减肥控卡」
  kcal: number, protein: number|null,       // 该档按多少 kcal/人 配的
  userText: string,                         // 用户原话，原样返回
  custom: boolean,                          // true = 没匹配到内置目标
  recognized: boolean                       // = !custom
}
```

**实机取值样例**（你可以直接抄去 mock）：

```
输入「2个人减肥不吃辣预算60到80」
  → goalInfo = { key:'lose', label:'减肥控卡', kcal:430, recognized:true }

输入「1个人20块以内」（没说目标）
  → goalInfo = { key:'custom', label:'1个人20块以内', kcal:670, recognized:false }
```

**UI 行为**：`recognized === false` 时显示提示条：

> ⚠️ 你说的「{userText}」我没能匹配到内置目标，这一版按**均衡（670 kcal/人）**配的。要更准，可以写「减肥」「高蛋白」「尝新品」这类词。

`recognized === true` 时无需任何提示。

---

## 3. 新增②：`data/campaigns.js` —— 官方活动日历已经真接上了

**你手上如果是旧包，请更新为新包。** 上次我交给你的时候 `campaign-calendar` 还没调，`FOR_GPT.md` 里如实写着"未接入"。**现在已经真跑了**，右侧广告板的"活动"不再是只有券。

**必须加一行 script**（在 `engine.js` 之后、`service.js` 之前）：

```html
<script src="data/menu_data.js"></script>
<script src="data/campaigns.js"></script>   <!-- 新增：官方活动日历 -->
<script src="engine.js"></script>
<script src="service.js"></script>
<script src="app.js"></script>              <!-- 你的 -->
```

这个文件是**可选**的：漏引也能跑，`getCampaigns()` 会降级到"只有菜单活动标签 + 券"，并把 `campaignCalendarLinked` 置为 `false`。我已实机验证过漏引分支不报错。

**`CampaignBundle` 真实形状**：

```ts
{
  coupons:   Array<{type:'coupon',   title, image, imageLocal, imageRemote, imageSource, source}>,  // 3 张真券
  promos:    Array<{type:'promo',    productCode, title, price, originalPrice, tags, image, imageLocal, imageSource, source}>,  // 10 条
  campaigns: Array<CampaignItem>,   // 全部 28 条
  today:     Array<CampaignItem>,   // 今日 16 条 ← 广告板主推这个
  upcoming:  Array<CampaignItem>,   // 即将 8 条
  past:      Array<CampaignItem>,   // 往期 4 条
  campaignCalendarLinked: boolean,  // 当前为 true
  campaignCalendar: { fetchedAt, source, count, phases } | null,
  note: string
}

type CampaignItem = {
  type: 'campaign', date: string, phase: 'today'|'upcoming'|'past',
  title: string, desc: string,
  image: string, imageLocal: string|null, imageRemote: string|null,
  imageSource: '麦当劳官方 MCP',
  mentions: string[],        // 文案里提到的菜品名，可与菜单挂钩（加分项）
  source: '麦当劳官方 MCP · campaign-calendar'
}
```

**今日真实内容包括**（不是我编的，是今天拉回来的）：🫐 蓝莓爆爆珠麦旋风上新 ／ 龙焰鸡腿堡来袭 ／ 🍫 麦咖啡 13.9r 浓浓黑巧 ／ 灰焰圆筒酷爽登场 ／ 限定丝巾 / 联名加价购。

**重要——三个来源不许混为一谈**：

| 来源 | 字段 | 标签上怎么写 |
|---|---|---|
| `campaign-calendar` | `today` / `upcoming` | 「官方活动」 |
| `available-coupons` | `coupons` | 「可领券」 |
| 菜单 `tags` / `dealType` | `promos` | 「活动价 / 上新」 |

不要把三者统称"活动"，也不要给菜单标签贴"官方活动日历"的名号——那是假的，评委问一句就穿。

`img/` 里现在有 **142 张图**（商品 122 + 券 3 + **活动 17**，活动图文件名前缀 `campaign_`）。

---

## 4. 关于旧原型：你工作区里没有，这是对的

你说"当前工作区没有先前原型文件可供盘点"——**完全正确，那是我刻意的**。

我早期在自己机器上写过一版 `index.html / style.css / app.js` 原型，**我故意没打进交付包**，就是不想让你在别人的代码上改。**请你从头写这三个文件**，不用考虑兼容我的东西。

因此 `FOR_GPT.md` 第 11 节（旧实现盘点 / adapter 映射）**对你不适用，可以整节跳过**。我的数据层是全新给的，你也是全新写，两者靠第 3 节的接口契约对接，不需要 adapter。

---

## 5. 我院这边还欠的账（不影响你开工，但可以提前知道）

| 事项 | 状态 | 对你的影响 |
|---|---|---|
| **构建与安全检查** | 待做 | 做完后我会给你一份"公开仓库前检查清单"，主要是 `.env` / Token 不入库、CSP meta、图片域名白名单。**CSP 可能会要求你不用内联 `<script>`**，这点我尽量不折腾你——如果你已经写完且用了内联 handler，告诉我不加 CSP 或加宽松版即可 |
| **B 方案同源代理** | 大概率不做 | 若做，以可选模块形式给，你的 UI 不需要改 |
| **README / 参赛材料的 MCP 证据部分** | 我写 | 你写产品说明和录镜分镜即可，接口调用证据（门店/菜单/营养/活动/算价五次调用的时间戳与返回摘要）我来 |
| **你交付后的核对** | 等你的文件 | 我会跑三项：① 页面数字与 `test_service.js` 真实输出逐字段一致 ② 断网 `file://` 能开且图片全在本地 ③ 安全红线 grep 零命中 |

## 6. 现在请你做（按顺序）

1. **按第 0 节的架构定案开工**——不再需要等我确认任何一件事
2. 三个包提供文件（`service.js` / `engine.js` / `data/*`）**只读不改**，重跑数据或调算法时我这边换文件即可，你一行不用动
3. 完成后请把这三样给我，我做最终核对：
   - `index.html` 的 `<script>` 引入顺序片段（10 行内）
   - 你页面上显示的**关键字段来源**（比如总价取的 `p.totalPrice` 还是自己算的，热量取的哪个字段）
   - 一张跑起来的截图（可选）
4. 如果实现过程中发现**某个字段你想显示但我没给**，直接提出来，我加。**不要退而求其次在前端自己算任何价格/热量/营养**——这是我们能拿分的最硬的一条底线

---

## 7. 一句话总结

**架构：构建期真调 MCP，运行时零网络，file:// 可演示。** 你的 8 项约定全部确认，其中第 3、4、6 条有补充要求，第 6 条所需的新字段 `goalInfo` 已加，活动日历所需的新文件 `campaigns.js` 已给。**现在没有任何阻塞项，请开工。**
