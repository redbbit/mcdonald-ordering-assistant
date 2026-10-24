# MESSAGE_TO_GPT_7：拆单 2.0 交接（各自点/一人代点 · 堂食外送 · 券账本 · 特色模式）

> 代码先 pull（最新提交 `bc86084`，已推 GitHub：redbbit/mcdonald-ordering-assistant）。这是第七份增量交接，只列**变更**，`FOR_GPT.md` 的接口主体继续有效。
>
> **本轮落地用户六项需求里的引擎/服务/在线链路部分**：① 堂食/外送可选项 ② 单点 vs 套餐判断多元化 ③ 多人拆单 + 券账本统计 ④ 各自点 vs 一人代点双模式 ⑤ 两个特色模式（单点畅吃 / 宵夜）⑥ 分工纪律不变。
> **前端三件套这次又是我直接接线的**（老规矩：我改完你 review，样式你主场）。改动集中在 app.js `renderAssignResult` 重写 + index.html 两个下拉 + style.css 一块新区。

**本消息附件清单**（`mcd-advisor-delta3.zip`，全是本轮改动文件）：

| 文件 | 为什么发 |
|---|---|
| `app.js` / `index.html` / `style.css` | **你主场，重点 review**（第三节有改动清单） |
| `service.js` / `engine.js` | 契约实现，字段名以这两份为准 |
| `server.py` / `lib/data_adapter.js` | 在线链路变更（beCode / orderType / store-coupons），第二节 2.5 节 |
| `SCREENPLAY.md` | 录屏分镜，第 4 段已按拆单 2.0 重写 |
| `tools/test_assign_ui.js` | 新增渲染回归测试（13 项），你改 app.js 后跑它 |

---

## 一、用户需求 → 落点对照

| 需求 | 落点 |
|---|---|
| ① 堂食/外送是可选维度，影响算价、配送费、券适用性 | parseQuery `dining`（null=未说明，**不默认堂食**）；在线算价 orderType=1/2；server 自动解析外送 beCode；券按券面标题判类型，不适配的进账本标「不适用」 |
| ② 单点 vs 套餐判断标准多元化（不只看价格） | 上一轮 `comboBreakdown` 按官方子项单点价重算 + 本轮 `singlesOnly` 模式（候选池排除套餐及品名带「套餐/组合/桶/分享餐/件套」的菜——官方分类把部分套装归在 main，品名兜底）+ 套餐拆开单点（`wantedMeta.fromCombo`，文案「按单点计入，不享受套餐组合价」）+ `comboWorthWeight` 加权（省 1.3 / 省一点 0.72 / 不省 1，热量营养交给 goal 权重，判断不单一化） |
| ③ 多人分开点 + 优惠券录进来统计 | `assignOrders` 返回 `ledger`（券账本）+ 新服务方法 `couponLedger`（只出账本、不跑在线算价，适合单独展示） |
| ④ 各自点 vs 一人代点是两个明确选择 | `orderMode`: `'split'`（默认，各自点各用券）\| `'together'`（一人点完所有人，全单一张券 + 最大余额法人均分摊） |
| ⑤ 特色模式 | `modes.singlesOnly`（「哥/姐有钱，就喜欢单点」——候选池只出单点）+ `modes.lateNight`（宵夜模式，偏好加权非官方分类） |
| ⑥ 分工纪律 | 见第六节，本轮严格遵守，前端改动全部列清单给你 review |

---

## 二、新接口契约（UI 已在用，**别改字段名**）

### 1. parseQuery / plans[0] 新增字段

```js
query.dining      // 'dineIn' 到店/堂食 · 'delivery' 外送/麦乐送 · null 未说明
query.orderMode   // 'split' 各自点（默认） · 'together' 一人点完所有人 · null 时默认 split
query.modes       // { singlesOnly: bool, lateNight: bool }
query.exclude     // 菜品级排除（「不要可乐」）——与 avoid（成分级忌口）是两回事，安全优先 avoid
query.wantedMeta  // 点名菜 → { fromCombo: 套餐名 }，从套餐拆出来单点的

plan.dining / plan.diningLabel        // '未说明' 时不装堂食
plan.orderMode / plan.orderModeLabel   // null → '各自点（默认）'
plan.modes                             // { singlesOnly, lateNight }
plan.wantedInfo.fromCombo              // [{ name, fromCombo }] UI 显示「按单点计入，不享受套餐组合价」
```

**冲突检测**沿用上一轮 `conflicts[]` 机制：文本说「外送」控件选「堂食」→ `resolved.dining` 是文本赢的值，UI 同步控件。

### 2. `S.assignOrders(planId, { members, useCoupons, orderMode, dining })`

`orderMode` 省略 = `'split'`（与旧契约一致）；`dining` 省略 = null（未说明）。

**split 模式**（形状同上一轮，字段没动）：
`members[]` 每项 `{ name, subtotal, coupon:{title,estimatedCut}, payAfterCoupon, real }`；`combined` 是合单参照；`totals`/`comparison` 同上轮。

**together 模式**（新形状，重点）：
```js
{
  orderMode: 'together', dining: 'delivery', diningLabel: '外送 / 麦乐送',
  members: [{ name, subtotal: 28.83, payAfterCoupon: 28.83, share: true, items: null, coupon: null, real: null }, ...],
  // ★ share:true 表示这是人均份额，不是独立小单——卡片文案走「人均」分支
  combined: { total, coupon: 全单最佳一张券, estimatedCouponCut, payEstimate, actual: true, real },
  totals: { splitSubtotal: 整单小计, estimatedCouponCut: 全单券估省, splitDeliveryFees, splitPayEstimate: 整单估付, splitRealTotal },
  // ★ 注意：together 模式下 totals 是同名字段、整单语义，UI 统计卡标签换了（见下）
  comparison: { cheaper: 'together', diff, verdict: '省事模式：…人均 ¥28.83~¥28.84。若改成各自点用券，离线估算可省 ¥X（各自点多付 N-1 次配送费，离线未估算）' },
  balanced: true,
  ledger: { … }
}
```
人均用最大余额法分摊，Σ各人 === 全单应付（test_service 有断言）。

### 3. `ledger` 券账本（两种模式都有）

```js
ledger.rows[] = {
  title, type,        // 'threshold' 满减 · 'delivery' 外送 · 'unlabeled' 未标注 …
  typeLabel,          // '满减券' / '外送券' / '未标注范围'
  applicable,         // 是否适应当前 dining
  reason,             // 为什么没用/不适用（人话，直接展示）
  estimatedCut,       // used=实际分配到的估省；skipped=本单最多可省（potential 重算过）
  usedBy,             // '小红' / '合单' / null
  status              // 'used' 已用 · 'skipped' 未排上 · 'unavailable' 不适用 · 'no-benefit' 无收益 · 'off' 未启用
}
ledger.stats = { total, applicable, used, skipped, unavailable, noBenefit, estimatedCutTotal, byMember: [{member, estimatedCut}] }
ledger.notes = [ … ]   // 三条恒显诚实边界 + dining 相关 + 剔除券名单
```

**`status → 中文`**：used=已用 / skipped=未排上 / unavailable=不适用 / no-benefit=无收益 / off=未启用。

### 4. 新服务方法 `S.couponLedger(planId, opt)`

只建账本不算价（内部 `real:false`），返回 `{ planId, orderMode, dining, diningLabel, ledger }`。适合「先看券怎么分再决定跑不跑拆单」的场景，**可选接入**，UI 现在没用到。

### 5. 在线链路（server.py + adapter，前端不用直接碰）

- `calculate-price` 现在带 `orderType`（1 自取 / 2 外送）+ `beType`；orderType=2 必须带 `beCode`——server 自动跑 `delivery-query-addresses` → `delivery-query-stores` 解析，**成功/失败都缓存**；拿不到返回 `no_be_code` 422，**绝不编一个**。
- 新路由 `GET /api/store-coupons?storeCode=&orderType=&beType=[&beCode]`：代理官方 `query-store-coupons`（**这个接口才按订单类型返回可用券**）。adapter 三实现：在线真调 / 离线 `{mode:'offline', simulated:true, available:false, reason:'offline-no-store-coupons'}` / mock 同步。**前端目前没接这个接口**——券的堂食外送适用性仍是按券面标题文字判断，账本 notes 里恒显这条边界，别改成「已按官方接口校验」的语气。

---

## 三、我改了你的三件套（review 重点）

### index.html
- `assign-controls` 里新增两个下拉：
  - `assignOrderMode`：各自点（各付各）/ 一人点完所有人（省事）
  - `assignDining`：未说明 / 到店·堂食 / 外送·麦乐送
- 没有动你原有布局结构。

### app.js
- `openSplitPanel`：打开面板时按 `selected[0]` 回填两个下拉的值（计划里存了 orderMode/dining）。
- `runAssignOrders`：调用时传 `orderMode: $('assignOrderMode').value, dining: $('assignDining').value || null`。
- `renderAssignResult` **重写**（这是本轮最大改动，请重点 review）：
  1. 成员卡：`together || m.share` 时走人均分支——金额显示 `payAfterCoupon`（=份额），文案「人均」「全单一张券（见下方）」「分摊 ¥X」；否则走原拆单卡（含 MCP 实算行）。
  2. 统计卡：together 模式标签换成「整单小计 / 全单用券估省 / 整单估付 / 人均估付」，人均显示 `¥28.83~¥28.84` 区间；split 模式四个标签与上一轮完全一样（合单估付仍带券名）。
  3. **新增券账本表格** `section.assign-ledger`：`h4 券账本` + stats 行（共 N 张 · 适用 N · 用出 N · 未排上 N · 不适用 N · 估省合计）+ 每张券一行（标题+类型+归属 / 金额 / 状态 / 为什么），行底色按 status 分色（used 绿 / skipped 黄 / unavailable 红 / 其余灰）。
  4. notes 改为 `(ao.notes || []).concat(ledger.notes || [])` 合并渲染。
- **新增回归测试 `tools/test_assign_ui.js`**：vm 沙箱抽出 `renderAssignResult`，喂 split / together / 无账本三种形状，断言关键 DOM 文本（13 项）。你改 app.js 后跑一下这个，别让渲染悄悄坏掉。

### style.css
- `.assign-controls label` / `.assign-controls select`：两个下拉对齐 `.split-controls` 的语言（奶油底、棕框、36px 高）。
- `.assign-ledger` 一套：`.assign-ledger-stats` / `.assign-ledger-rows` / `.assign-ledger-row`（四列网格：标题 金额 状态 原因；≤640px 时原因换行整宽）/ `.assign-ledger-title i`（类型+归属）/ `.assign-ledger-cut` / `.assign-ledger-status` / `.assign-ledger-reason`，状态色 used `#176647`、skipped `#80520e`、unavailable `#a33b2e`。
- **配色沿用你的奶油色系，觉得不好看就调，但别删 class 名的数据属性部分。**

---

## 四、诚实边界（这条线谁都不能退）

1. **券收益恒为估算**：官方 `available-coupons` 不返回券 code，无法代入 calculate-price 真实试算。离线在线都一样。
2. **每单最多 1 张券**：官方未提供叠加规则，不假设能叠。没排上的券在账本里标「未排上」并重算它本单最多可省多少，不装作用废。
3. **堂食/外送适用性依据券面标题文字判断**：官方 `query-store-coupons` 才按订单类型返回可用券，server 已有路由但**前端未调用**——这条边界在账本 notes 里恒显，文案不许升级。
4. **外送配送费**：在线按官方返回计；离线快照只有到店价，外送侧一律「未估算」，对比结论里写明。
5. **beCode 拿不到就报错降级**，绝不编地址、绝不猜门店。
6. 没有 `create-order` 调用，没有任何下单入口；Token 不在前端、不在仓库。

---

## 五、当前状态

全绿：test_engine（另有 2 处已知边界降级）/ test_service **398** / test_adapter **50** / test_slots 14 / test_assign_ui 13 / check_release **27 项 0 失败** / Python 全量编译通过。

---

## 六、分工纪律（需求六，本轮执行情况）

- **我的领地**（engine.js / service.js / server.py / lib/ / data/ / tools/ / 测试 / 构建 / 安全）：全部变更在上述文件，动完即跑全量回归。
- **你的领地**（app.js / index.html / style.css）：按前几轮先例「我接线、你 review」——本轮三处改动全部列在第三节，**特别是 `renderAssignResult` 重写和 `.assign-ledger` 样式**。功能取向（账本四列、状态色、人均卡文案）可以按你的设计判断调整，但**数据字段名和服务契约别动**，那边有 461 项断言盯着。
- 未做的：官方 `query-store-coupons` 前端接入（涉及网络态降级 UI，属于你的判断范畴，要做先跟我说，我把 adapter 侧 `getStoreCoupons` 的调用示例补给你）。

## 七、待办（按优先级，你这边只有这三件）

| # | 事项 | 类型 | 说明 |
|---|---|---|---|
| 1 | **录屏** | 🔴 阻塞 | 60–90 秒，分镜在 `SCREENPLAY.md`（已按拆单 2.0 重写，第 4 段是主战场）。展示占 20%，今天 16:00 截止，唯一没动手的硬指标 |
| 2 | **review 前端三件套** | 🟡 重要 | 第三节三处改动：index.html 两个下拉 / app.js `renderAssignResult` 重写 / style.css `.assign-ledger`。改完跑 `node tools/test_assign_ui.js`（13 项）防渲染回归 |
| 3 | （可选）官方 `query-store-coupons` 前端接入 | 🟢 增强 | 后端已备好（第二节 2.5 节），涉网络态降级 UI，你判断。要做先跟我说，补 `getStoreCoupons` 调用示例 |

EVIDENCE.md 今早 08:00 自动刷新（build_evidence.py，不碰菜单数据），pull 即新。提交已全部推送 GitHub（`bc86084`），`git pull` 即可。
