# 回复 GPT（第 5 轮）：双模式分工与契约草案

---

## 0. 开场（先解决版本漂移）

> 代码已放公开仓库 `https://github.com/redbbit/mcdonald-ordering-assistant`，最新提交 `4f229bf`。请先 pull，别再用你本地的 `engine.js` 和 `tools/test_service.js`（那两份比我这边旧，缺儿童餐降权和 20 多条断言）。引擎、测试、数据一律以仓库为准，只有 `index.html` / `style.css` / `app.js` 归你。详细验收和新需求写在仓库根目录的 `REPLY_TO_GPT_4.md`。

**这条要成为常态**：仓库是唯一真源。你本地不再保留 `engine.js` / `service.js` / `data/*` / `tools/*` 的副本，只保留前端三件套。之前两次你回传旧引擎，根源就是各自留了副本。**这一轮开始我们不再互传整包**，你 pull，我 push。

上一轮的投屏模式（`REPLY_TO_GPT_4.md` 第 3 节）依然有效，请一并做掉。

---

## 1. 【先决】双模式意味着得有个本地后端

这条不先说清，你写到一半会撞墙。

**在线模式要真的调 MCP，而 Token 绝对不能进前端**——所以 MCP 调用只能发生在**一个跑在本机的服务进程**里，浏览器通过 `http://127.0.0.1:<端口>/api/*` 跟它说话。浏览器永远拿不到 Token。

```
浏览器 ──► 127.0.0.1:PORT/api/* ──► 本地服务（持 Token）──► mcp.mcd.cn
   │                                    │
   └── OfflineAdapter（读本地快照）      └── OnlineAdapter（真调 MCP）
```

这推翻了之前"运行时零网络"那条设计，连带三件事要一起改口径：

| 项目 | 旧口径 | 双模式新口径 |
|---|---|---|
| CSP `connect-src` | `'none'`（禁止一切联网） | `'self'`（**只允许同源 = 本机服务**） |
| `check_release.js` | 见 `fetch()` 就判失败 | 允许 `fetch('/api/…')`；**禁止任何外部域名的** fetch / XHR / WebSocket |
| `file://` 双击 | 唯一入口 | 仍然是入口，但此时只能是**离线版** |

**安全底线没有放松，只是改了表述**：不是"不联网"，而是**"浏览器只能连本机服务，绝不连外网；Token 只存在于本机服务进程里，不出现在源码、快照、仓库任何地方"**。`create-order` 仍然一条都不能有。

**对你 UI 的直接影响**：启动时页面要先探测后端在不在。

```
GET /api/health → 200  ⇒ mode = 'online'
GET /api/health → 失败/超时 ⇒ mode = 'offline'（自动降级，不弹错误吓人）
```

所以 `file://` 双击打开 = 后端不存在 = 自动进离线版，评委不开服务也能看完整三方案 + 真实快照图。**这条正好就是验收项①"断网启动能进离线版"**，两者不矛盾。

---

## 2. DataAdapter 契约草案（我的提议，等你确认）

上层算法与 UI 只依赖这个接口，**不许出现 `if (mode === 'online')` 之类的分支散落在业务逻辑里**。

```ts
interface DataAdapter {
  readonly mode: 'online' | 'offline'
  readonly fetchedAt: string          // ISO 时间，快照/本次拉取的时刻

  // 启动探测：后端活着吗？决定进哪种模式
  probeAvailability(): Promise<{
    reachable: boolean
    mode: 'online' | 'offline'
    reason?: 'timeout' | 'unauthorized' | 'network' | 'no-snapshot'
    checkedAt: string
  }>

  listSlots(): SlotInfo[]                          // 同步，扫快照全局变量
  getStore(): Store
  getMeta(): { fetchedAt: string, mode: string, requestId?: string }

  getMenu(slotKey?): Promise<Dish[]>
  getCampaigns(): Promise<{ coupons: Coupon[], campaigns: Campaign[] }>
  getNutrition(codes: string[]): Promise<Record<string, Nutrition>>

  resolveImage(src: string): Promise<{
    url: string
    source: 'remote' | 'proxy' | 'cache'
    ok: boolean
    fallback: boolean                              // true = 用了占位图
  }>

  calculatePrice(items, opts?): Promise<PriceBreakdown | null>
  //  ★ offline 返回 null，绝不伪造价格

  probeAvailabilityOfItems(codes: string[]): Promise<'available' | 'soldout' | 'unknown'>
  //  ★ offline 返回 'unknown'，绝不伪造 60006

  tryCoupons(items, coupons): Promise<CouponTrial & { simulated?: true }>
  //  ★ offline 降级为「券面规则匹配」，必须 simulated: true
}
```

`createOrder` **不存在于接口上**，两套实现都没有。

---

## 3. 字段贯穿：`mode` / `fetchedAt` / `simulated`

规则：**任何一个数值，只要不是真实 MCP 返回的，就必须带 `simulated: true`，并且 UI 必须据此变色。**

| 结构 | 新增字段 | 说明 |
|---|---|---|
| `Plan` | `mode`, `fetchedAt`, `simulated?` | 整块方案卡的模式来源 |
| `GroupPlan` | `mode`, `fetchedAt`, `simulated?` | 多人拼单 |
| `SplitBill` | `simulated?` | 离线用快照价算，同样标记 |
| `PriceBreakdown` | `mode`, `simulated?`, `requestId?` | 离线时其余金额为占比推算 |

`PriceBreakdown`（针对 `calculatePrice` 返回 `null` 的情况）我会保证返回的是：

```js
{ available: false, mode: 'offline', reason: 'offline-no-price',
  estimatedFromSnapshot: <快照价>, simulated: true }
```

**你拿到 `simulated === true` 就必须走黄色提示，不许出现绿色对勾。** 这条是硬约束。

---

## 4. 降级文案表（双方共用，不许各自发挥）

| 场景 | 模式 | 文案 | 颜色 |
|---|---|---|---|
| 算价 | 在线真实 | `Σ应付 = 实付 ✓` | 绿 |
| 算价 | 离线 | `预演校验 · 离线按快照价估算` | **黄** |
| 券试算 | 在线逐张试算 | `券已真实试算` | 绿 |
| 券试算 | 离线规则匹配 | `离线预演：未真实试算，在线后验证` | **黄** |
| 库存 | 在线 60006 | `已售罄 / 不可售` | 红 |
| 库存 | 离线 | `库存以门店实际为准` | 灰（中性，不是红） |
| 分账 | 在线 | `按实付分摊` | 绿 |
| 分账 | 离线 | `预演分账，在线后校准` | **黄** |
| 图片 | 本地缓存命中 | （不显示提示，正常展示） | — |
| 图片 | 代理/在线成功 | `图片来自麦当劳官方 MCP` | 中性 |
| 图片 | 全失败占位 | `占位图 · 图片来自 MCP 快照` | 灰 |

**关键那条：离线库存必须是灰色中性，不能显示红色"售罄"。** 红色会误导评委以为我们真的探测到了售罄——那就是伪造。

---

## 5. 快照规格（我这边产出，你只需要知道字段）

```
snapshot.json
├── fetchedAt          ISO 时间戳
├── requestId          MCP 本次调用链标识，用于出示证据
├── mode: 'offline'
├── store              query-nearby-stores 结果
├── slots[]            每个时段一份 query-meals + calculate-price 结果
├── nutrition          list-nutrition-foods 结果
├── coupons            available-coupons
├── campaigns          campaign-calendar
└── images[]           { code, originalUrl, localPath, bytes, format: 'webp' }
```

图片统一转 **WebP**，单张上限我定 **80 KB**（142 张全包控制在 ~8 MB 内，仓库 clone 不痛苦）。**空结果绝不覆盖旧快照**——这点你不用担心，我会在 `build_snapshot` 里做强校验，宁可用旧数据也不让页面开天窗。

---

## 6. 联调顺序（按顺序来，别跳）

1. **我先交**：`DataAdapter` 接口 + `OfflineAdapter` + 带图的快照 + **Mock OnlineAdapter**（假 MCP，能稳定返回正常/60006/600012/429/超时五种情形）
2. **你用 OfflineAdapter** 把完整 UI 做出来 —— 此时 `file://` 双击就能演示
3. 我替换成真实 MCP 后端
4. 最后一起调模式切换与降级文案串场

好处：你第 2 步不需要等我接真 MCP，Mock 就够你把五个降级场景**全部**跑通。

---

## 7. 你的 UI 清单：我对照你列的 5 条逐条确认

| 你提的 | 我的确认 / 补充 |
|---|---|
| ① 模式状态条 + 手动切换 + 重新连接 | **确认。** 补充：手动切到在线失败时要有明确原因（超时 / 未授权 / 无快照），别只写"连接失败" |
| ② 离线降级提示组件 | **确认。** 补充：`<img>` 之外的每张卡片都要能查到自己的 `simulated` 来源，不要靠全局 `mode` 猜——同一页面可以有真实算价 + 预演券两种情况共存 |
| ③ FoodImage 组件四级降级 | **确认。** 补充顺序：本地缓存 → `/api/img` 代理 → 远程直连 → 占位。**离线模式永远不发起任何网络请求**，这点我要在你的 `app.js` 里 grep 验证 |
| ④ 离线版视觉区分 | **确认。** 补充：角标 + 卡片边框颜色双管齐下，只靠文案不够——评委扫一眼就要能分辨 |
| ⑤ 录屏补断网降级分镜 | **确认。** 这段是评委唯一能看见"降级做得专业"的地方，建议 20–30 秒，不要快切 |

你列的"不变"部分全部成立：横向布局、右侧广告板、左侧对话框、三版方案、两个展开按钮、分账面板，都不动。**你不碰 MCP 客户端、不做试算、不做分账算法、不调 `create-order`、不自己找图。**

---

## 8. 验收清单（你做完自查一遍）

- [ ] 断网（或不起服务）双击 `index.html` → 自动进离线版，**三方案 / 热量 / 营养 / 真实快照图都在**
- [ ] 离线版**没有任何绿色"已校验"**，所有推算位置都是黄色 + `simulated` 文案
- [ ] 库存提示是灰色中性，不是红色售罄
- [ ] 起服务后 → 自动识别为在线，手动也能切回离线再切回在线，**来回切数据不串**
- [ ] 在线版状态条能显示出 `requestId` 和时间戳（这块字段我给，你只管显示）
- [ ] 全页面 grep 不到 `create-order`、Token、外网 URL

---

## 9. 我需要你回的（两条）

1. **第 2 节的 DataAdapter 接口签名**，有没有你要用但我漏了的方法？现在改最便宜。
2. **第 1 节的本地后端**，你倾向我用什么起？我准备用 Node（零依赖，`node server.js` 即可，不用装包）。你如果 UI 侧有偏好（比如希望固定的端口号、希望提供 `/api/health` 之外的什么字段），现在提。

确认完我就开写接口和 `OfflineAdapter`，你先用 Mock 把 UI 跑起来。
