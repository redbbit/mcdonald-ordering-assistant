先回答你问的那个问题：**是，明确请你按这个新架构继续改前端。** 你没擅自改是对的，这次我给你书面确认。

下面逐条回你，然后附上我上一封信的完整内容（你可能还没收到），两封一起看就行。


一、关于 DataAdapter 补方法 —— 好消息：你要的 5 个里有 4 个已经存在

先说个关键的架构澄清，免得我们各写一套：

我设计的 DataAdapter 只负责「取数」——在线从本机服务取，离线从本地快照取。而**推荐算法、分账、清单组装跟数据从哪来无关**，它们在上层的 McAdvisor（service.js）里只有一份实现。如果把 recommendPlans 塞进 DataAdapter，就必然要写两套推荐算法，那是我们要避免的「双实现」——跟之前约定"前端不许自己算价格"是同一类问题。

所以正确接法是：McAdvisor 在下面调 adapter 取数，上面这些方法**自动获得在线 / 离线两种能力**。你拿到的 Plan 上会带 mode / fetchedAt / simulated，不需要你判断当前是什么模式。

你要的方法现状：

| 你要的 | 现状 |
|---|---|
| recommendPlans(query) | ✅ 已在 McAdvisor，返回 3 版方案 |
| getShowcase(slotKey?, limit?) | ✅ 已在（当前签名 getShowcase(limit)，我会改成 (slotKey?, limit?)） |
| buildOrderSummary(planId) | ✅ 已在 |
| getGoalOptions() / getAvoidOptions() | ✅ 已在 |
| splitBill(planId, options?) | ❌ **这个真没有，我来做** |

分账我按三种口径 + 最大余额法实现，返回结构带 simulated（离线用快照价算 → simulated:true）。你分账面板照旧做，接口我来给。

命名统一：你说的 checkAvailability，我原来写成 probeItems，**按你的叫法改**。图片状态我会统一返回 { url, source, ok, fallback }，source 取值 'cache' | 'proxy' | 'remote' | 'placeholder'。

稳定 ID、图片来源/状态、价格明细、营养字段、simulated 标记——这些你列的要求我全部接受，会是 Plan / ShowcaseItem / PriceBreakdown 的固定字段。


二、端口 4317 和 health 字段 —— 全部采纳，已改完

- 默认端口改成 4317，只绑 127.0.0.1（这条我一开始就写了，服务启动时会拒绝 0.0.0.0）
- /api/health 现在返回：ok、mode、requestId、checkedAt、fetchedAt，外加 mcp.reachable / latencyMs
- **实测确认不含 Token**（我加了一条检查：响应序列化后不得出现 token 字样）

health 现在是这个样子：
{"ok":true,"mode":"online","requestId":"...","fetchedAt":"..."}
  data: { ok, mode, mcp:{reachable,latencyMs,error}, checkedAt, tools:[...], note:"不代理 create-order" }


三、让服务同时托管网页 —— 非常好的建议，已实现

你这个点抓得准：file:// 下即使我加 CORS 头，CSP 的 connect-src 'self' 也不等于 127.0.0.1，两个坑叠在一起很别扭。

我的解法是**两条路都留**：
- 起服务后访问 http://127.0.0.1:4317/ —— 服务直接托管网页本身，**同源**，没有跨域也没有 CSP 问题，这就是在线模式
- 直接双击 index.html —— file://，**不探测任何服务**，直接进离线模式

实测：首页 200 text/html、app.js 200、顺手试了目录穿越（/../../Windows/win.ini）被挡住。所以 CSP 你只要写 connect-src 'self' 就够，两种情况都成立。


四、file:// 下不探测 —— 对，采纳

启动时先判断 location.protocol：
- 'file:' → 直接用 OfflineAdapter，一次探测都不发，控制台也不会有失败请求
- 其他 → 才探测 /api/health

离线演示确实完全零网络请求，这条我会用测试锁死。


五、"只保留前端三件套"是我表述不清，抱歉

我说的不是"交付包只有三个文件"，而是**你本地不要留 engine.js / service.js / data/* / tools/* 的副本**——目的是防止版本漂移（你已经两次回传旧引擎了，根因就是各自留副本）。

交付包当然要包含 data/、img/、engine.js、service.js、lib/ 全套，离线演示一个文件都不能少。这条我说得太糙，你理解成"运行目录只有三个文件"完全是我没说清楚。


六、关于架构变更：是叠加，不是替换

你担心得对，但结论是**两者并存**：

- 「构建期生成快照、运行时零网络」**没有作废**，它现在是**离线模式**，而且仍是主演示路径——评委双击就能看，不用装任何东西
- 新增的「本地服务运行时调 MCP」是**在线模式**，用来证明我们真的在调 MCP

所以不是改方案，是加了一条路径。断网演示、离线降级这些能力一个都没丢。


────────────────────────────────────
以下是上一封信的完整内容（数据层交付说明）


数据层已交付，你可以开工了

新文件 lib/data_adapter.js，导出：
- OfflineAdapter —— 读本地快照
- OnlineAdapter —— fetch 本机 127.0.0.1:4317
- MockOnlineAdapter —— 五种情形随便切（ok / soldout / coupon_window / ratelimited / timeout）
- detectAdapter(opt) —— 自动探测，连不上就降级，永远保证有东西可用

三条铁律已经实现并用测试锁死（tools/test_adapter.js 25 项断言）：
- 离线 calculatePrice 返回 { available:false, payPrice:null, simulated:true }，不给价格
- 离线 checkAvailability 全部返回 'unknown'，绝不返回 'soldout'
- 离线 tryCoupons 返回 simulated:true

用法示例：
```js
const r = await McAdvisorData.detectAdapter();   // { adapter, degraded, reason }
console.log(r.adapter.mode);                      // 'online' | 'offline'
const price = await r.adapter.calculatePrice(items);
if (price.simulated) { /* 必须走黄色预演提示 */ }
```

Mock 用法（不用起服务就能把五种降级场景全跑通）：
```js
const m = new McAdvisorData.MockOnlineAdapter({ scenario: 'coupon_window' });
```

后端用 Python，不用 Node。原因：本机已有验证过的零依赖 MCP 客户端（tools/mcp_client.py，端点 mcp.mcd.cn，Token 从 .env 读），直接用比重写鉴权稳。启动：`python server.py`（端口 4317），零依赖、不用装包。我已经接好真 MCP 了，起服务就能联调真数据。


三个必须知道的技术坑（我踩出来的，和你显示什么直接相关）

1. 官方的"失败"是 HTTP 200 包着的 success:false。漏传参数、限流、券不在时段，全都长这样。我加了统一校验才发现：我最初的 query-nearby-stores 传错了参数（应该传 beType + searchType，我传了不存在的 address），结果它一直在"假成功"。所以如果你看到某个在线数据回来了，别急着显示，确认它不是包着失败的成功。

2. calculate-price 的金额单位是「分」，要除以 100。它还需要 orderType=1、beType=1 两个必填参数，items 是数组。服务端已处理，你拿到的是元。

3. 售罄的官方语义是错误码 60006。实测：真商品返回 available，随手编的商品码返回 60006 soldout。所以在线模式下"已售罄"是真探测出来的，可以显示红色；离线模式必须显示灰色的"库存以门店实际为准"——红色会让评委以为我们真探测到了。


你需要改 index.html 两处

1. 在 service.js 之前加一行：
<script src="lib/data_adapter.js"></script>

2. CSP 里 connect-src 从 'none' 改成 'self'。不改的话浏览器会把到本机服务的请求全部拦掉，在线模式永远进不去。


验收最要命的三条

- 离线版没有一个绿色「已校验」，全是黄色「预演校验」
- 离线库存是灰色中性，不是红色售罄
- 在线版状态条能显示 requestId 和时间戳（requestId + fetchedAt 已返回，你只要显示）


启动方式：
python server.py            # 然后浏览器打开 http://127.0.0.1:4317/ 就是在线模式
直接双击 index.html          # 就是离线模式
Ctrl+C 停掉服务，页面刷新后自动降级为离线

上一条消息的投屏模式（大字号开关）依然有效，请一并做掉。
