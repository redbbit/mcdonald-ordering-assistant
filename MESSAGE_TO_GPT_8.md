# MESSAGE_TO_GPT_8：套餐拆开的正确含义——子项偏好 + 混合方案 + 四维权衡（前端主战场）

> 代码先 pull（本轮提交后推 GitHub：redbbit/mcdonald-ordering-assistant）。这是第八份增量交接，只列**变更**，`FOR_GPT.md` 的接口主体继续有效。
>
> **本轮落地用户对「套餐拆开」的澄清**：不是全单点（那是 `singlesOnly` 特色模式），也不是套餐改配（官方 MCP 根本没有改配接口），而是——
> 「我想要套餐里的某部分、不想要另一部分，于是考虑把想要的子项单点，哪怕不如整套餐划算；最终方案里单点哪些、套餐哪些，要同时看价格、营养、口味。」
> 引擎侧四件事全部做完（子项偏好建模 / 混合方案生成 / 多维权衡 / 测试），**前端 UI 是你的主战场**，字段契约在第二节，必须接线项打了 🔴。

**本消息附件清单**（`mcd-advisor-delta78.zip`，**第 7 + 8 两轮合并**，共 13 个文件）：

> ⚠️ 如果你没收到过第 7 轮交接（拆单 2.0：各自点/一人代点 · 堂食外送 · 券账本 · 特色模式），**这一包就是补给你的**——先读 `MESSAGE_TO_GPT_7.md` 再读本消息，第 8 轮的前端任务是叠在第 7 轮基础上的。`engine.js`/`service.js` 是两轮合并后的最新版（以本包为准）。

| 文件 | 为什么发 |
|---|---|
| `MESSAGE_TO_GPT_7.md` | 第 7 轮主交接（拆单 2.0 契约）——没收过就先读它 |
| `MESSAGE_TO_GPT_8.md` | 本消息（第 8 轮：子项偏好 + 混合方案 + 四维权衡） |
| `app.js` / `index.html` / `style.css` | **你主场**：第 7 轮前端三件套当前版本，第 8 轮 UI 的工作基座 |
| `engine.js` | 子项偏好 + 混合方案 + 四维对比 + 权重（你只读，别改） |
| `service.js` | 契约层：拆单 2.0 + itemPrefs / sourceType / mixSummary / tradeoffExplanation / comboCompare / weights |
| `server.py` / `lib/data_adapter.js` | 在线链路（beCode / orderType / store-coupons） |
| `SCREENPLAY.md` | 录屏分镜，第 4 段多人拆单是主战场 |
| `tools/test_assign_ui.js` | 渲染回归测试（13 项），你改 app.js 后跑它 |
| `tools/test_engine.js` / `tools/test_service.js` | 第 8 轮新增断言（解析质量 / 混合候选 / 权重翻转 / 不改配边界 / plan 契约） |

---

## 一、用户原话 → 引擎落点（先对齐语义，再谈 UI）

| 用户说的 | 引擎落点 |
|---|---|
| 「我想要安格斯厚牛堡，不要薯条和可乐」 | `parseItemPrefs(text, dishes)` → `[{name, mention, code, pref:'want'\|'avoid', source:'text'}]`。去边字变体匹配（官方子项叫「中薯条/可乐中杯」，用户说「薯条/可乐」）；同句多规格去重（5 种薯条合并成 1 条）；过短变体不误命中（「无霸」不会抢「巨无霸」的三件套） |
| 「解析不出时由 UI 勾选面板兜底」 | parseQuery 接受 `input.itemPrefs`（控件回传），与文本解析结果合并：**同名/同 code 以控件为准**，被覆盖的文本信号进 `conflicts[]`（不静默丢弃） |
| 「候选池增加套餐子项单点化候选」 | `makePlans` 里每个「含忌子项或含点名子项」的套餐生成一个确定性拆开候选（`src:'comboPart'`），与随机生成的「买整份」候选进**同一个打分池**——谁分高谁上，不预设拆开更好 |
| 「同时看价格、热量/蛋白质、口味匹配」 | `scorePlan` 四维加权：`22×price + 20×kcal + 11×price×划算度 + 11×protein + 18×taste + …`，权重四元组 `{price,kcal,protein,taste}` 来自目标解析（省钱→price×1.6、减脂→kcal×1.6、高蛋白→protein×1.6、有子项偏好→taste 上调）+ **调用方注入（你的滑块）**，默认全 1 与旧版兼容 |
| 「不假设 MCP 支持套餐改配」 | 每版 `tradeoffExplanation` 都带一句「官方 MCP 不支持套餐改配（没有改配接口，算价只按标准餐品）：不能让套餐去掉某个子项。要么买整份套餐，要么像上面这样把想要的子项按单点买——本方案按后者处理。」UI 必须原样露出 |
| 「权重来自目标解析和用户滑块，不要写死」 | `normWeights(opt, goal)`：注入值 clamp 0–3，目标词再加成。`recommendPlans({text, itemPrefs, weights})` 三个入口都通 |

**与两个既有概念的分工（UI 文案千万别混）**：

- `singlesOnly`「单点畅吃」= **全单点**，一个套餐都不要（「哥/姐有钱就单点」）——特色模式，用户点名才开
- 「X套餐只要A、B」= **显式强制拆开**（parseQuery 旧逻辑，确定性行为，子项转单点 + 原套餐排除）
- **本轮 `itemPrefs`** = want/avoid 信号喂多目标优化，「整套餐 vs 拆开单点」同池竞争——**混合方案是默认推荐里的一种可能结果，不是单独模式**

---

## 二、字段契约（🔴 必须接线，字段名以 engine.js/service.js 为准）

### 1. ItemPreference——子项偏好对象

```js
{ name: '培根安格斯厚牛堡',   // 菜单/子项真实名（引擎匹配后的）
  mention: '安格斯厚牛堡',     // 用户原话——UI 回填时显示这个，让用户看到「系统理解成了什么」
  code: '511781',              // 菜单 code；对不上菜单的子项（可乐中杯）为 null
  pref: 'want',                // 'want' 想要 · 'avoid' 不想要 · （无所谓 = 不出现）
  source: 'text' }             // 'text' 文本解析 · 'panel' 勾选面板回传
```

- parseQuery 输出：`query.itemPrefs`（合并后）、`query.sources.itemPrefs`（'text' / 'merged' / 'default'）、`query.resolved.itemPrefs`（**UI 双向同步就调它**）
- recommendPlans 输入：`{ text: '…', itemPrefs: [{name, mention, code, pref}], weights: {price,kcal,protein,taste} }`——勾选变化后重新请求，**不要前端自己算价**
- conflicts 新增一种：`{field:'itemPrefs', text, control, resolved:'想要'|'不想要', note}`——面板和输入框各说各话时按面板走，弹这个提示

### 2. PlanItem.sourceType——混合方案角标 🔴

```js
item.sourceType   // 'combo' 完整套餐 · 'single' 单独点 · 'comboPart' 套餐子项转单点
item.fromCombo    // sourceType==='comboPart' 时必有：从哪个套餐拆的（字符串）；其余为 null
```

口径注意：`sourceType==='combo'` 不只按 `role`——官方把一部分三件套/套餐归类在「主食」里（role=main），品名带 套餐/组合/桶/分享餐/件套 的都算套餐。UI 角标直接用这个字段，**不要自己用 role 再判一次**。

### 3. Plan.mixSummary——方案级人话总结 🔴

```js
plan.mixSummary = {
  fullCombos: 1, singles: 2, comboParts: 1,
  fromCombos: [{ combo: '麦香鸡套餐', parts: ['麦香鸡'] }],
  text: '本方案含 1 个完整套餐 + 2 个单点 + 1 个套餐子项转单点；「麦香鸡套餐」拆开：只要 麦香鸡',
  tradeoffExplanation: [...],   // 同 plan.tradeoffExplanation
  comboCompare: [...]           // 同 plan.comboCompare
}
// 无子项偏好且无拆开子项时，mixSummary / tradeoffExplanation / comboCompare 都是 null——
// 看到 null 就不渲染对比卡，不要给普通方案硬编对比。
```

### 4. Plan.tradeoffExplanation——权衡解释（string[]）🔴

人话逐条解释「贵了 X 元但少 Y kcal / 避开了 Z」，固定带两条边界：

```
'「麦香鸡套餐」拆开单点：比买整份省 ¥11，少 0 kcal，避开了 中薯条、可乐中杯'
'官方 MCP 不支持套餐改配（没有改配接口，算价只按标准餐品）：不能让套餐去掉某个子项。要么买整份套餐，要么像上面这样把想要的子项按单点买——本方案按后者处理。'
'有子项在菜单内没有单点价，无法单点购买，已按买不到处理，未编价。'   // 有 unresolved 子项时才出现
```

### 5. Plan.comboCompare——四维对比（数组 | null）🔴

```js
plan.comboCompare = [{
  combo: '龙焰鸡腿堡三件套', comboCode: '9900016073',
  price:  { combo: 26.9, parts: 15.9, delta: -11, cheaper: 'parts' },  // cheaper: 'parts'|'combo'
  kcal:   { combo: 1003, parts: 696, delta: -307 } | null,             // 官方无数据 → null，不编
  protein:{ combo: 58,  parts: 32,  delta: -26 }  | null,
  taste:  { combo: '含 2 项你不想要的子项：中薯条、可乐中杯',
            parts: '全部匹配（已避开 中薯条、可乐中杯）', winner: 'parts' },  // winner: 'parts'|'combo'|'tie'
  unresolvedParts: ['可乐中杯'],     // 菜单内没有单点价的子项：买不到，未计入单点侧
  avoidedParts: ['中薯条', '可乐中杯'],
  note: '子项 可乐中杯 在菜单内没有单点价，无法单点购买，未计入单点侧'
}]
```

- 方案里每完整套餐一条；**官方无数据的维度是 null 不是 0**，UI 显示「官方未提供」占位，不要画 0
- `plan.weights = {price, kcal, protein, taste}`——该版实际生效的权重，滑块旁边可以回显「当前权重」

---

## 三、给 GPT 的前端任务（用户原话，照此执行）

> 用户澄清了「套餐拆开」的含义：不是全单点，而是「想要套餐里某部分、不想要另一部分，于是考虑把想要的子项单点；最终方案里单点/套餐混合，要同时看价格、营养、口味」。WorkBuddy 已在引擎层补好子项偏好和混合方案，你需要做对应的 UI：
>
> 1. **子项偏好入口**：在套餐卡/方案卡上加「拆开看看」，展开子项列表，每项可勾选「想要/不想要/无所谓」；顶部显示「整套餐 vs 只要想要的子项单点」的实时对比。勾选变化后重新请求 WorkBuddy 的 plan，**不要前端自己算**。
> 2. **自然语言回填**：用户输入「我想要安格斯厚牛堡，不要薯条和可乐」后，解析结果（`resolved.itemPrefs`）要回填到子项勾选面板，让用户看到「系统理解成了什么」——回填用 `mention` 字段显示原话。
> 3. **混合方案卡**：每个 item 标注「套餐/单点/套餐子项转单点」角标（`sourceType`）；方案底部展示 `mixSummary.text` 的人话解释。
> 4. **多维对比**：套餐对比不要只写「省 ¥8」，展示价格/热量/蛋白质/口味匹配四列（`comboCompare`）；口味匹配可以简化为「含 1 项你不想要的子项」或「全部匹配」。
> 5. **模式区分**：`singlesOnly` 是「全单点」模式，文案「哥/姐有钱就单点」，和「混合方案」不是一回事，UI 上要区分清楚。混合方案是默认推荐里的一种可能结果，由子项偏好影响。
> 6. **离线**：子项单点价来自快照，方案标 `simulated`，四维对比用黄色「预演」标识，不显示绿色「已校验」。
>
> 边界不变：你不动引擎/服务/测试，不调 create-order，不自己找图，Token 不进前端。字段契约以本消息第二节为准，先 review 再接线。

**必须接线 🔴**（契约字段，名字不能改）：`resolved.itemPrefs` 回填、`item.sourceType`/`fromCombo` 角标、`mixSummary.text`、`tradeoffExplanation`、`comboCompare` 四列、`weights` 回显、`conflicts[].field==='itemPrefs'` 提示。
**样式待你重做 🟡**（我只保证数据对）：我这边没有为这些字段加新 DOM——勾选面板、混合方案卡、四维对比表的样式和交互完全你的主场。**不要默认你会原样接受任何 UI 临时方案**，第二节字段名是唯一约束。

---

## 四、诚实边界（UI 文案必须遵守）

1. **官方 MCP 没有套餐改配接口**：`calculate-price` 只按标准餐品算价。「去掉薯条的汉堡套餐」买不到——要么整份、要么子项单点。`comboPart` 是「按子项单点价另买」，不是「改过的套餐」，角标文案不能写成「定制套餐」。
2. **对不上面价的子项不编价**：麦乐鸡4块、可乐中杯等官方无单点价 → `unresolvedParts`，单点侧不计入、对比显示「官方未提供」，kcal/protein 同理 null。
3. **软性不硬禁**：含忌子项的套餐是降权（itemW×0.55 + 口味扣分），不是排除——价格足够划算时整份仍可能赢。这是用户明确要求的「同池竞争」，UI 不要承诺「一定拆开」。
4. **离线三不伪造**：快照数据 `simulated: true`、`priceSource: 'snapshot'`，四维对比是「预演」不是「已校验」。
5. **「汉堡」这类泛称映射不到具体菜品**：解析不出就没有信号，靠勾选面板兜底——不要前端猜。

---

## 五、测试与自查

| 套件 | 结果 | 新增覆盖 |
|---|---|---|
| `tools/test_engine.js` | 全部通过（2 处已知边界 ⚠️） | parseItemPrefs 解析质量（去重/过短变体/显式拆开句式零输出）、comboPartFit 对 role=main 套装的识别、混合候选生成与记账（fromCombo/不重复计费/源套餐不同版）、**权重翻转胜出切换**（price×3 首版 2 个完整套餐 ↔ taste×3 首版 0 个且出拆开版）、不改配边界文案、四维对比字段完整性 |
| `tools/test_service.js` | 423 项通过 | parseQuery itemPrefs（文本/面板覆盖/conflict/忌口守卫/resolved 回填）、plan 契约（sourceType 合法值/mixSummary/tradeoff 含不改配/weights 透传/simulated）、comboPart 记账完整性 |
| `tools/test_adapter.js` / `test_slots.js` / `test_assign_ui.js` | 50 / 14 / 13 通过 | 无回归 |
| `tools/check_release.js` | 27 项 0 失败 | 可进公开仓库 |

**你改完前端后跑这三个**：`node tools/test_assign_ui.js`（渲染回归）、`node tools/test_service.js`（契约）、`node tools/check_release.js`（发布前）。

---

## 六、待办优先级（接 10/25 16:00 截止）

| 优先级 | 事项 | 负责 |
|---|---|---|
| 🔴 录屏 | `SCREENPLAY.md` 已就绪，第 4 段多人拆单是主战场；建议补一段「输入：我想要安格斯厚牛堡，不要薯条和可乐 → 勾选面板回填 → 混合方案卡 → 四维对比」 | GPT |
| 🔴 前端接线 | 第三节六项，字段契约第二节 | GPT |
| 🟡 review | 本轮 engine/service 改动（子项偏好 + 混合方案），重点看 `parseItemPrefs` 匹配质量和 `scorePlan` 权重公式 | GPT |
| 🟢 `query-store-coupons` | 在线券真源接入（当前离线快照，账本已标明差距） | 待排 |
| 🟢 提交 | 截止前 commit + push，`check_release` 必须绿 | 共同 |
