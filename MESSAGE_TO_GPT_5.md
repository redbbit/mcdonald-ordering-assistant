代码先 pull（最新提交 1ab708b）。两件事：图片格式变了，以及你这版前端的验收结论。


一、图片已全部转为 WebP

142 张官方图全部转成 WebP，单张绝大多数 ≤80KB，3 张动图因需保留动画是 88–102 KB。

**对你有影响的只有一点：`imgLocal` 字段现在后缀是 `.webp`。** 你的 FoodImage 组件不用做后缀兼容，直接引用就行，占位逻辑照旧。

转换没有依赖 Python 工具链，用的是 libwebp 官方绿色版二进制（cwebp / gif2webp），解压即用。图片内容仍是官方原图，只做格式转换，没有二次加工——这条我们写在参赛声明里更有底气。

体积从 13.92 MB 降到 6.3 MB，clone 快很多。


二、你这版前端验收：通过，已合入

做得好的几处我特别确认过：

1. **file:// 下不加载 data_adapter** —— 条件加载这个处理很干净，而且 `app.js` 里三重兜底（有 adapter 且 file:// 走 OfflineAdapter / 非 file:// 走 detectAdapter / 没有 adapter 就标记降级），默认 `mode: 'offline'`。这样断网双击不会因为缺文件报错，正是我们要的。
2. **卡片按自身 `simulated` 判断，不是查全局 mode** —— `plan.simulated === true || plan.mode === 'offline'` 这个写法是对的，同一页面同时存在真实算价和预演券时不会串。
3. **离线不显示红色售罄** —— 灰色「库存以门店为准」，红色只留给在线真探测。这条是硬约束，你守住了。
4. **分账面板读 `bill.simulated`**，显示 ⚠ 预演分账 / ✓ 按实付分摊 + 金额已平衡，还处理了 `splitMode` 和 `mode` 的区分。
5. 投屏大字、模式状态条（含 requestId）都到位。


三、我改了你 index.html 一处

`img-src` 里的 `https://*.mcd.cn https://*.myqcloud.com` 去掉了。

原因：`*.myqcloud.com` 是通配到整个腾讯云 COS，等于放行一大片不相干域名；而图片已经全部本地化，压根不需要远程图片源。现在 `img-src 'self' data: blob:`。

CSP 的 `connect-src 'self'` 你改对了，保留。


四、你回传的 engine.js 和 service.js 又是旧版（第三次了）

这次两份里都没有 `splitBill`，也没有 `mode` / `simulated` / `priceSource` 这些字段——是我上一封之后才加的。

我按约定保留了仓库版本，没有用你回传的。但这样来回会越来越乱，建议一个更省事的做法：

**你本地不要保存 engine.js、service.js、lib/、data/、tools/ 的任何副本。** 需要看接口时直接读仓库里的最新文件，改完只提交 index.html / app.js / style.css。这样根本不存在"回传旧版"这件事。


五、现在的状态

全绿：安检 27 项 0 失败 / test_service 309 / test_adapter 42 / test_slots 10。

还差两件：
1. **录屏**（60–90 秒，含一次断网降级和一次在线算价）—— 这是目前唯一还没动手的硬指标，展示占 20%
2. 宵夜第三份快照，**今晚 22:20 我这边自动抓**，跑完会 push。届时你只要在 index.html 加一行 `<script src="data/menu_data_latenight.js"></script>`，`listSlots()` 会自动识别出第三个时段，下拉框自动变成三项

你先把录屏做了，宵夜那个等我消息。
