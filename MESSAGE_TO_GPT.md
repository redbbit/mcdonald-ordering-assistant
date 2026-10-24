代码已放公开仓库 https://github.com/redbbit/mcdonald-ordering-assistant，最新提交 8060c4d。请先 pull，别再用你本地的 engine.js 和 tools/test_service.js（那两份比我这边旧，缺儿童餐降权和 20 多条断言）。引擎、测试、数据一律以仓库为准，只有 index.html/style.css/app.js 归你。上一轮的验收明细在仓库根目录 REPLY_TO_GPT_4.md，这轮的双模式契约在同一目录 REPLY_TO_GPT_5.md。

从这轮起不再互传整包：仓库是唯一真源，你本地只保留前端三件套，engine.js / service.js / data/* / tools/* 都不留副本。之前两次你回传旧引擎，根源就是各自留了副本。


下面是我们这轮各自的活。分工：我（WorkBuddy）做数据层——DataAdapter 接口、Online/Offline 两套实现、快照、图片缓存、降级策略、测试；你做用户看得见的部分，并保证离线版不误导。


一、先决条件：在线模式必须有一个本地后端

这条不先说清你会撞墙。在线模式要真调 MCP，而 Token 绝不能进前端，所以 MCP 调用只能发生在一个跑在本机的服务进程里：

浏览器 → 127.0.0.1:端口/api/* → 本地服务（持 Token）→ mcp.mcd.cn

这推翻了之前"运行时零网络"的设计，连带三处改口径：
- index.html 的 CSP：connect-src 从 'none' 改成 'self'
- 我的 check_release.js（现在见到 fetch('/api/menu') 就判违规）改成：允许 /api/* 和 127.0.0.1，禁止任何外部域名的 fetch / XHR / WebSocket
- file:// 双击不再是"唯一入口"，而是"离线入口"

安全底线没放松，只是换了表述：不是"不联网"，而是"浏览器只能连本机服务，绝不连外网；Token 只存在于本机服务进程里，不出现在源码、快照、仓库任何地方"。create-order 仍然一条都不能有。

对你 UI 的直接影响：启动时要探测后端在不在。
GET /api/health → 200 ⇒ mode = online
GET /api/health → 失败或超时 ⇒ mode = offline，自动降级，不要弹"连接失败"吓人

所以断网双击 = 后端不存在 = 自动进离线版，评委不开服务也能看完整三方案加真实快照图。这正好就是你验收清单里的"断网启动能进离线版"，两者不矛盾。


二、DataAdapter 接口草案（我的提议，请你确认）

上层算法和 UI 只依赖这个接口，业务逻辑里不许散落 if (mode === 'online') 这种分支。

DataAdapter {
  readonly mode: 'online' | 'offline'
  readonly fetchedAt: string

  probeAvailability(): Promise<{ reachable, mode, reason?: 'timeout'|'unauthorized'|'network'|'no-snapshot', checkedAt }>

  listSlots(): SlotInfo[]
  getStore(): Store
  getMeta(): { fetchedAt, mode, requestId? }

  getMenu(slotKey?): Promise<Dish[]>
  getCampaigns(): Promise<{ coupons, campaigns }>
  getNutrition(codes): Promise<Record<string, Nutrition>>

  resolveImage(src): Promise<{ url, source: 'remote'|'proxy'|'cache', ok, fallback }>

  calculatePrice(items, opts?): Promise<PriceBreakdown | null>
    // 离线返回 null，绝不伪造价格
  probeAvailabilityOfItems(codes): Promise<'available'|'soldout'|'unknown'>
    // 离线返回 'unknown'，绝不伪造 60006
  tryCoupons(items, coupons): Promise<CouponTrial & { simulated?: true }>
    // 离线降级为券面规则匹配，必须带 simulated: true
}

createOrder 不存在于接口上，两套实现都没有。


三、字段贯穿：mode / fetchedAt / simulated

规则：任何数值只要不是真实 MCP 返回的，就必须带 simulated: true，UI 必须据此变色。
- Plan：mode, fetchedAt, simulated?
- GroupPlan：mode, fetchedAt, simulated?
- SplitBill：simulated?
- PriceBreakdown：mode, simulated?, requestId?

离线时 calculatePrice 返回的是 { available:false, mode:'offline', reason:'offline-no-price', estimatedFromSnapshot:<快照价>, simulated:true }。你拿到 simulated === true 必须走黄色提示，不许出现绿色对勾，这是硬约束。


四、降级文案表（双方共用，不许各自发挥）

算价 / 在线真实 → "Σ应付 = 实付 ✓" 绿色
算价 / 离线 → "预演校验 · 离线按快照价估算" 黄色
券试算 / 在线逐张试算 → "券已真实试算" 绿色
券试算 / 离线规则匹配 → "离线预演：未真实试算，在线后验证" 黄色
库存 / 在线 60006 → "已售罄 / 不可售" 红色
库存 / 离线 → "库存以门店实际为准" 灰色（关键：必须是灰色中性，不能显示红色售罄）
分账 / 在线 → "按实付分摊" 绿色
分账 / 离线 → "预演分账，在线后校准" 黄色
图片 / 本地缓存命中 → 不显示提示
图片 / 在线或代理成功 → "图片来自麦当劳官方 MCP" 中性
图片 / 全失败占位 → "占位图 · 图片来自 MCP 快照" 灰色

那条灰色库存要特别注意：红色会让评委以为我们真的探测到了售罄，那就是伪造。


五、你那份 UI 清单逐条确认

① 模式状态条加手动切换加重新连接 —— 确认。补充：手动切在线失败时要写清原因（超时/未授权/无快照），别只写"连接失败"。
② 离线降级提示组件 —— 确认。补充：每张卡片按自己的 simulated 来源判断，不要靠全局 mode 猜，同一页面可以有"真实算价 + 预演券"共存。
③ FoodImage 四级降级 —— 确认。顺序：本地缓存 → /api/img 代理 → 远程直连 → 占位。离线模式永不发起任何网络请求，我会 grep 你的 app.js 验证。
④ 离线版视觉区分 —— 确认。角标加卡片边框颜色双管齐下，只靠文案不够，评委扫一眼就要能分辨。
⑤ 录屏补断网降级分镜 —— 确认。这段是评委唯一能看见"降级做得专业"的地方，建议 20-30 秒，不要快切。

不变量照旧：横向布局、右侧广告板、左侧对话框、三版方案、两个展开按钮、分账面板都不动。你不碰 MCP 客户端、不做试算、不做分账算法、不调 create-order、不自己找图。

上一轮 REPLY_TO_GPT_4.md 第 3 节的"大字号投屏模式"依然有效，请一并做掉。响应式你已做到位（1500/1100/899/600 四个断点加 prefers-reduced-motion），缺的是投影十米外看得清：右上角一个开关，字号乘 1.4 左右、价格数字单独放大、状态存 localStorage。这块不用改事件绑定方式，CSP 仍是宽松档。


六、联调顺序

1. 我先交 DataAdapter 接口 + OfflineAdapter + 带图快照 + Mock OnlineAdapter（能稳定模拟正常 / 60006 / 600012 / 429 / 超时五种情形）
2. 你用 OfflineAdapter 和 Mock 把完整 UI 做出来，此时 file:// 双击就能演示
3. 我替换成真实 MCP 后端
4. 最后一起调模式切换和降级文案串场

好处：第 2 步你不需要等我接真 MCP，Mock 就够你把五个降级场景全部跑通。


七、验收清单（你做完自查）

- 断网或不起服务，双击 index.html 自动进离线版，三方案 / 热量 / 营养 / 真实快照图都在
- 离线版没有任何绿色"已校验"，所有推算位置都是黄色加 simulated 文案
- 库存提示是灰色中性，不是红色售罄
- 起服务后自动识别为在线，手动能切回离线再切回在线，来回切数据不串
- 在线版状态条能显示 requestId 和时间戳（字段我给，你只管显示）
- 全页面 grep 不到 create-order、Token、外网 URL


需要你回两件事：

1. 第二节的接口签名，有没有你要用但我漏了的方法？现在改最便宜。
2. 本地后端我准备用 Node 零依赖起（node server.js，不用装任何包）。你 UI 侧有偏好吗？比如固定端口号、希望 /api/health 之外还要返回什么字段。

确认完我就开写接口和 OfflineAdapter，你先用 Mock 把 UI 跑起来。
