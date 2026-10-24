# WorkBuddy 端 · 第三份：你的前端验收结论 + 一个新增需求（多时段）

> 这条会頁面:只两件事：**① 你的前端验收通过了，我列出结论 ② 新增一个功能（多时段切换），需要你改几行。**

---

## 0. 先说结论：你的前端全部合格

我把你交回的包跑了一遍机器校验 + 人工核对，结果如下。先给结论，让你不用猜：

| 检查项 | 结果 |
|---|---|
| **双实现**（最担心的） | ✅ **零命中**。`app.js` 里没有任何 `reduce` / `reduce.clamp`/ `parseFloat` / 价格相乘 / 热量自算，10 处调用全是我的服务接口 |
| 安全红线 | ✅ `check_release.js` **22 项通过 / 0 失败**：无 `create-order`、无 Token、无 `Authorization`、无外部 CDN |
| 离线能力 | ✅ `index.html` / `style.css` / `app.js` 三个文件零 `fetch` / `XHR` / `WebSocket` |
| 图片 | ✅ 142 张全部命中本地 `img/`，没有一个自找的图；三级降级 `imageLocal → imageRemote → PLACEHOLDER` 实现正确 |
| script 顺序 | ✅ 正确，含 `data/campaigns.js` |
| 第 1 条 三版固定 | ✅ 只渲染我返回的，没自己排 |
| 第 3 条 未知营养 | ✅ 6 处「官方未提供，未估算」 |
| 第 4 条 空替代区 | ✅ 你**没有**实现替代推荐区块，做得对 |
| 第 5 条 底部三行 | ✅ 📌 / ➡️ / 🔒 三行齐全 |
| 第 6 条 目标未命中提示 | ✅ 用了 `goalInfo.recognized` |
| 第 7 条 顶栏时间 | ✅ 用了 `fetchedAt` + `slotNow` |
| 第 8 条 响应式 / 触控 | ✅ `max-width:899px` 断点 + 14 处 44px |

**没有任何一处需要你返工。**这是一次高质量的交付，谢谢。

---

## 1. 一个版本漂移，说明一下，不是你的问题

你交回的 zip 里 **`engine.js` 和 `tools/test_service.js` 是旧版**（比我们现在跑的少一段代码），原因在我：我的增量包只带了 `service.js`，没带这两个当时也改动过的文件。

具体差异两处：

1. `engine.js` 少了我后来补的**儿童乐园餐降权**（成人聚餐被配「开心乐园餐」的 bug 修复）
2. `test_service.js` 还写着 `campaignCalendarLinked === false` 的旧断言

**我已经用我这边的新版覆盖，最终版本以我为准。以后这两个文件你不用回传，打包时带不带都行。**（这不是让你重做什么，只是告诉你为什么你交的文件我没有原样采用。）

---

## 2. CSP 定档：宽松档

**确认用宽松档** —— 你现有的内联 `<script>` 和事件绑定方式**完全不用改**。

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self' data: blob:;
  script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https://*.mcd.cn https://*.myqcloud.com;
  connect-src 'none';
  font-src 'self' data:;
  base-uri 'none'; form-action 'none'
">
```

请加一行到 `<head>`。其中 **`connect-src 'none'` 是核心**——它从协议层声明了这个页面不可能联网，是我们"运行时零网络"的机器可验证证据。

---

## 3. 新增需求：多时段快照切换

### 背景

麦当劳**不同时段卖的菜不一样**。实测同一家店：

| 时段 | 餐品数 | 抓取时间 |
|---|---|---|
| 下午茶 14:44–16:45 | **122 款** | 今天 15:17 |
| 夜市 17:14–21:45 | **120 款** | 今天 18:21 |

而且同一句需求配出来的结果真的不同：

```
「3个人聚餐预算150以内」
  下午茶 → 省钱聚餐版 ¥86.3 （人均 853 kcal）
  夜市   → 省钱聚餐版 ¥101.3（人均 655 kcal）
```

这是很好的**演示弹药**：现场随手切一下时段，能看到菜单和推荐一起变，比任何讲解都有说服力。

> 技术说明：MCP 的 `query-meals` **没有"指定时段"参数**，服务端按调用时刻返回。所以每个时段都必须在该时段内真实调用一次——不是我伪造的差异。今晚会再抓一份宵夜（22:14 后）。

### 我这边已经做好的

- 新增数据文件 **`data/menu_data_night.js`**（120 款，算价 120/120 通过，营养 90 款），挂 `window.MCD_DATA_NIGHT`
- `service.js` 新增两个接口（**必须更新我给你的新版 service.js**）
- 图片**共用** `img/`，没有新图

### 新增接口

```ts
McAdvisor.listSlots(): Array<SlotInfo>        // 同步，列出已落地的时段快照

type SlotInfo = {
  key: 'teatime'|'night'|'latenight'|…,   // 默认那份 ''
  label: string,                          // '下午茶' / '夜市' / '宵夜'
  global: string,                         // 'MCD_DATA_NIGHT'
  fetchedAt: string,                      // '2026-10-24 18:21:36'
  dishCount: number,
  verifiedCount: number,                  // calculate-price 通过数
  nutritionCount: number,
  timeRanges: Array<{name, range}>,       // 门店官方营业时段原文
  available: true
}

// 取某个时段的服务实例（其余所有接口不变）
McAdvisor.createService({ slot: 'night' })  // → 新的 S
```

真实返回值（今天）：

```
下午茶  key=teatime  MCD_DATA_TEATIME  餐品 122  算价通过 122  营养 92  抓于 2026-10-24 15:17:38
夜市    key=night    MCD_DATA_NIGHT    餐品 120  算价通过 120  营养 90  抓于 2026-10-24 18:21:36
```

### 需要你改的三处

**① `index.html` 加一行 script**（在 `service.js` 之前）：

```html
<script src="data/menu_data.js"></script>
<script src="data/menu_data_night.js"></script>   <!-- 新增 -->
<script src="data/campaigns.js"></script>
<script src="engine.js"></script>
<script src="service.js"></script>
<script src="app.js"></script>
```

**② 加一个时段切换器**（建议放顶栏，在"数据更新于 HH:MM"旁边）。

建议形态：一组 chip 或一个小下拉，显示 `label + 抓于 HH:MM`，例如：

```
时段 [下午茶 15:17 ▾]  ← 切换
```

**③ 切换时重建服务实例并重跑**——这一步很关键：

```js
// 千万不能只换显示：planId 属于产生它的那个 service 实例
var S = McAdvisor.createService({});               // 初始（默认时段）

function switchSlot(key) {
  S = McAdvisor.createService({ slot: key });      // ← 重建实例
  renderMeta(S);                                   // 顶栏：门店 / 时段 / 更新时间要跟着变
  renderShowcase(S);                               // 右侧广告板要换成该时段的
  // 如果用户已经配过一次，用原话自动重跑，体验最好
  if (lastQueryText) runRecommend(lastQueryText);
}
```

**三个坑，提前告诉你：**

1. **`planId` 会失效**。它是按实例自增的，换了 `S` 之后旧 `planId` 查不到（会抛 `NO_PLAN`）。所以切换后**必须重跑 `recommendPlans`**，不要用旧的 id 去 `calculatePlan`。
2. **`getShowcase()` 也要重取**，两个时段的商品不一样，否则广告板会停留在旧时段。
3. **如果用户已经勾过方案**，切换时段后应该清掉勾选并提示"已切换到 XX 时段，按当前条件重新配了"——不要静默保留旧选择。

---

## 4. 顺手修的一个 bug（会影响你显示的数字）

`service.js` 里的取整函数写成了 `Math.pow(10, n || 2)`，**当 n=0 时会退化成保留 2 位小数**。所以之前人均热量会显示成 `606.33 kcal` 这种。

已修。**新版 `service.js` 里所有热量都是整数**（606 kcal）。**请务必更新这个文件**，否则数字还会是小数，评委一眼就能看出不专业。

---

## 5. 要发给你的东西

增量包 `mcd-advisor-delta2.zip`，只有 3 个文件：

```
service.js                    ← 必换（多时段接口 + 取整修复）
data/menu_data_night.js       ← 新增（夜市时段真快照）
tools/probe_slots.js          ← 可选，跑一下能看到两个时段的配餐差异
```

解压覆盖原目录。另外你可以跑：

```bash
node tools/probe_slots.js
```

会打印两份时段的清单 + 同一句话在两个时段配出的三版方案，方便你对数据。

---

## 6. 之后还有吗

大概率还有一次：**今晚 22:14 之后我会抓「宵夜」时段**，届时多一个 `data/menu_data_latenight.js`，你只需要在 `index.html` 再加一行同样格式的 script —— **切换器会自动识别它，不用再改代码**（`listSlots()` 是扫描全局变量的）。

这样就覆盖了这家店三个真实时段（下午茶 / 夜市 / 宵夜），演示时随便切。

**除此之外我不再给你加新需求了。**剩下的是 README 的 MCP 证据部分和构建脚本，那是我自己的活。
