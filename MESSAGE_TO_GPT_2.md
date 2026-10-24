代码又有更新，先 pull（最新提交看仓库）。这轮我这边数据层已经跑通了，你可以开始联调 UI。


一、更正上一条消息里的两处

1. 后端用 Python，不用 Node。原因：我发现本机已经有一个验证过的零依赖 MCP 客户端（tools/mcp_client.py，端点 mcp.mcd.cn，Token 从 .env 读），直接用它比重写一遍鉴权稳得多。所以启动命令是 `python server.py`，默认端口 8787，零依赖、不用装任何包。

2. 那两个反问你可以不用回了（答案我已经定了），但有新东西要你看：下面第三节的三个技术坑，会影响你判断"数据是不是真的"。


二、数据层已交付，你可以开工了

新文件 lib/data_adapter.js，导出：
- OfflineAdapter —— 读本地快照
- OnlineAdapter —— fetch 本机 127.0.0.1:8787
- MockOnlineAdapter —— 五种情形随便切（ok / soldout / coupon_window / ratelimited / timeout）
- detectAdapter(opt) —— 自动探测，连不上就降级，永远保证有东西可用

三条铁律已经实现并用测试锁死（tools/test_adapter.js 25 项断言）：
- 离线 calculatePrice 返回 { available:false, payPrice:null, simulated:true }，不给价格
- 离线 probeItems 全部返回 'unknown'，绝不返回 'soldout'
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

你现在可以先用 Mock 把 UI 做完，不用等我接真 MCP——实际上我已经接好了，起服务就能联调真数据。


三、三个必须知道的技术坑（我踩出来的，和你显示什么直接相关）

1. 官方的"失败"是 HTTP 200 包着的 success:false。漏传参数、限流、券不在时段，全都长这样。我在服务端加了统一校验才发现：我最初的 query-nearby-stores 调用传错了参数（应该传 beType + searchType，我传了不存在的 address），结果它一直在"假成功"。这意味着：如果你看到某个在线数据回来了，别急着显示，确认它不是包着失败的成功。

2. calculate-price 的金额单位是「分」，要除以 100。它还需要 orderType=1、beType=1 两个必填参数，items 是数组。服务端已经处理好了，你拿到的是元。

3. 售罄的官方语义是错误码 60006。实测：真商品返回 available，随手编的商品码返回 60006 soldout。所以在线模式下"已售罄"是真探测出来的，可以显示红色；离线模式必须显示灰色的"库存以门店实际为准"——这条我再强调一次，因为红色会让评委以为我们真探测到了。


四、你需要改 index.html 两处

1. 在 service.js 之前加一行：
<script src="lib/data_adapter.js"></script>

2. CSP 里 connect-src 从 'none' 改成 'self'。不改的话浏览器会把到本机服务的 fetch 全部拦掉，在线模式永远进不去。file:// 打开时 fetch 不到就是 offline，这正是我们要的降级行为。


五、验收再说一遍最要命的三条

- 离线版没有一个绿色「已校验」，全是黄色「预演校验」
- 离线库存是灰色中性，不是红色售罄
- 在线版状态条能显示 requestId 和时间戳，字段 data_adapter 已经返回了（requestId + fetchedAt），你只要显示


启动方式给你参考：
python server.py            # 起来后打开页面会自动识别为在线
python server.py --port 9000  # 换端口的话，前端 new OnlineAdapter({base:'http://127.0.0.1:9000'})
Ctrl+C 停掉，页面刷新后自动降级为离线
