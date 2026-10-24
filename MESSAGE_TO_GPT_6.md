代码先 pull（最新提交 362fb87）。这一轮把你之前提的问题一、三、四、五全做完了——引擎、服务、UI 三层都动了，前端三件套这次是我直接改的，你需要 review 一遍样式与交互细节。

一、这一轮做了什么（对应用户提的五个问题）

| 问题 | 状态 | 落在哪 |
|---|---|---|
| 一、多人拆单分人各用券达到最省钱 | ✅ 做完 | engine.js `buildSubOrders`/`optimizeCoupons` + service.js `assignOrders` + app.js 拆单面板新区块 |
| 二、活动图压糊 | ✅ 上一轮已修 | 17 张官方原图重下，q88/800px 重编码，目检文字锐利 |
| 三、目标匹配 | ✅ 做完 | GOALS 词表扩容 + 打分制；未识别给温和兜底 + 可点示例 |
| 四、套餐 vs 散件对比 | ✅ 做完 | `comboBreakdown` 按官方子项单点价重算，菜品上直接显示「比单点省 ¥X」 |
| 五、输入冲突 | ✅ 做完 | parseQuery 检出三类冲突 + resolved 回填控件 + 点名菜校验 |

二、你必须知道的新接口（UI 已经在用，别改字段名）

1. `plans[0].conflicts` / `plans[0].resolved` / `plans[0].sources` / `plans[0].wantedReport`
   冲突数组每项 `{field, note, resolved}`，note 就是直接弹给人看的那句话；resolved 是实际生效值，UI 据此把控件同步回去。
2. `plan.goalInfo.fallback`（兜底文案）/ `plan.goalInfo.suggestions`（可点目标数组）。recognized=false 时展示这两个，**不要再弹「没能匹配到内置目标」**——我已经换了，你回传旧版时会看到这句，以仓库版为准。
3. `plan.comboSummary`（{comboCount, savingCount, totalSave}）+ `item.combo`（{partsTotal, comboPrice, save, partsKnown, partsCount, complete}）。complete=false 表示子项只对上一部分价，**省额是下限**，UI 文案带「起」字，别改成确定语气。
4. `S.assignOrders(planId, {members, useCoupons})` → `{members[], combined, totals, comparison, notes, balanced}`。members 每项 `{name, subtotal, coupon:{title,estimatedCut}, payAfterCoupon, real}`；online 时 real 有官方 price/deliveryPrice。notes 三条是诚实边界，UI 原样展示。

三、我改了你的三件套，改了这些地方（review 重点）

- **index.html**：分账面板里加了 `assign-block`（拆单用券区块），新 id：`assignUseCoupons` / `runAssign` / `assignResult`。没有动你原有的布局结构。
- **app.js**：
  - `mergeQuery()` 简化了——不再自己做「文本 vs 控件」裁决，原样传给服务层，冲突检测和 resolved 都走 service.js。你以前写的 touched 逻辑我保留了数据集标记，但读取方变了。
  - 新增 `applyResolved()`：文本赢的时候把控件改回文本的值并标 touched，用户能直观看到「刚才那句话算出来是 3 人」。
  - `showGoalNotices` → `showNotices`：冲突提示、点名菜落榜说明、目标兜底 + 可点建议 chips（`data-goal-suggest`，点了填目标框并重配）。
  - `renderPlan`：套餐徽标 + comboSummary 标签。
  - 新增 `runAssignOrders` / `renderAssignResult`。
- **style.css**：新增 `.notice-warn` / `.notice-info` / `.notice-suggestion` / `.combo-save` / `.combo-partial` / `.assign-*` 一套样式，配色沿用你现有的奶油色系。**样式是你主场，觉得不好看就调，但别删 class 名的数据属性部分。**

四、诚实边界（这条线谁都不能退）

- 券收益恒为估算：官方 `available-coupons` 不返回券 code，没法代入 calculate-price。离线在线都一样，UI 必须带 simulated 标注。
- 每单最多一张券：官方没给叠加规则，不假设能叠。
- 离线不显示红色售罄、不显示绿色已校验；官方没营养数据的显示「官方未提供，未估算」。
- 没有 create-order 调用，也没有任何下单入口。

五、现在的状态与待办

全绿：test_service 349 / test_engine 新增四组 / test_adapter 42 / test_slots 14 / check_release 27 项 0 失败。

还剩两件：
1. **录屏**（60–90 秒，分镜在 SCREENPLAY.md）——展示占 20%，这是目前唯一没动手的硬指标。这一轮的新功能（拆单用券对比、冲突提示）建议各给几个镜头。
2. 你 review 前端三件套的本轮改动，尤其是 assign-block 的样式和 notice 的呈现。

EVIDENCE.md 明早 08:00 会自动刷新（跑 build_evidence.py，不碰菜单数据），届时你 pull 一下就是新的调用证据。
