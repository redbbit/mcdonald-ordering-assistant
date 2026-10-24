# 构建、发布与安全

> 这一份是**仓库里的交付说明**，写给评委和未来的自己，也是 `index.html` 要上架公开仓库前的检查清单。
> 前端部分（页面怎么用、长什么样）请看 GPT 端写的 README。

---

## 1. 三行说清怎么跑起来

```bash
node tools/test_service.js        # 数据与算法自检：309 项断言
node tools/test_engine.js         # 推荐引擎边界：¥15 极端预算下的降级会标 ⚠️ 已知边界
node tools/test_slots.js          # 多时段：证明三段快照是真独立数据，不是换标签
node tools/check_release.js       # 发布前安检：Token / 离线 / 图片
python tools/build_data.py        # 可选：重新向麦当劳 MCP 拉一次真实数据
python tools/build_campaigns.py   # 可选：单独刷新官方活动日历
```

要**演示**：直接双击 `index.html`，不需要起服务、不需要联网。

要**重新拉数据**：跑上面两条 `python`（要装 `requests` 且本机 MCP 可用）。菜单重跑会走 122 次 `calculate-price`，几分钟；活动单独跑，因为盘中变得更快。

---

## 2. 架构：为什么页面不联网

**构建期调 MCP → 落本地快照 → 运行时零网络。**

理由三条：

1. 浏览器**不可能**直连 `mcp.mcd.cn`：没有给浏览器用的 CORS 头，且只要前端直连，Token 就一定出现在 JS 里，F12 抄走即可——违反任何一条安全要求。
2. **断网 + `file://` 双击可演示**是硬需求。会场网络不可控。
3. 这不削弱"真的调用了 MCP"：调用发生在构建期，**122 款商品每一款都真实跑过 `calculate-price`**，图片是从官方 CDN 下载的原始图，每次调用记录见 **`EVIDENCE.md`**。

运行时浏览器里**没有任何** `fetch` / `XHR` / `WebSocket` / 外部 CDN 引用，这一点由 `check_release.js` 强制校验。

---

## 3. 安全红线（由 `check_release.js` 自动检查，不是口头承诺）

| 红线 | 怎么保证 |
|---|---|
| MCP Token 不进前端源码 | Token 只存在于**本机 MCP 客户端配置**里，构建脚本运行时由客户端自己读取，从不写进任何产出文件 |
| MCP Token 不进公开仓库 | `.gitignore` 忽略 `.env` 与所有凭据文件；`check_release.js` 扫描发布集合，命中 `Authorization` / `Bearer` / `apiKey` / 私钥直接失败 |
| 不调用 `create-order` | 代码里没有下单入口，`ORDER_ENABLED` 恒为 `false`；`check_release.js` 扫到 `create-order` 出现在**可执行代码**里就失败（注释里声明"不使用"是允许的，那是加分） |
| 不做真实支付 | 页面最多到"算这一单 / 生成去官方小程序下单清单"，没有任何支付按钮 |
| 偏好只存本机 | 用户的目标、忌口、勾选全部留在浏览器本地，不上传任何地方 |
| 图片只来自官方 | 外链域名白名单：`menu-img.mcd.cn` / `img.mcd.cn` / `cms-cdn.mcd.cn`；页面上的 142 张图全部是构建期从这些域名下载到本地的 |

---

## 4. CSP：两档，自己选

要在 `file://` 下生效，只能写在 `<meta>` 里（HTTP 响应头用不上）。

**宽松档（推荐，兼容性最好）**——允许内联样式和 `onerror` 降级：

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self' data: blob:;
  script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  connect-src 'none';
  font-src 'self' data:;
  base-uri 'none'; form-action 'none'
">
```

**严格档**——`connect-src 'none'` 从协议层掐死一切联网企图，但要求**不用内联 `<script>`、不用 `onclick` 属性**，事件一律走 `addEventListener`：

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self' data: blob:;
  script-src 'self';
  style-src 'self';
  img-src 'self' data: blob: https://*.mcd.cn;
  connect-src 'none';
  base-uri 'none'; form-action 'none'
">
```

> 无论哪一档，`connect-src 'none'` 都是核心——它就是"这个页面不可能联网"的机器可验证声明。

---

## 5. 公开仓库前 checklist

```bash
node tools/check_release.js --selftest   # 先确认安检器自己没坏
node tools/check_release.js              # 再通过发布检查
git status --porcelain                   # 确认没有 .env 被 add
```

- [ ] `.env`、凭据、包含 Token 的文件**没有被 `git add`**
- [ ] `check_release.js` 两项检查都是 ✅ 通过（0 失败）
- [ ] `img/` 在仓库里（122 商品 + 3 券 + 17 活动图）
- [ ] `EVIDENCE.md` 是**当天**生成的，时间点能对得上演示时间
- [ ] 双击 `index.html` 能开、拔网线后图片仍在

---

## 6. 数据新鲜度

所有数据在构建那一刻被冻结，三个地方能看到时间：

| 位置 | 内容 |
|---|---|
| `Meta.fetchedAt` | 菜单快照时间，页面顶栏显示"数据更新于 HH:MM" |
| `Meta.store.slotNow` | 当前所处营业时段（如"下午茶"）——麦当劳不同时段菜单不同 |
| `EVIDENCE.md` 生成时间 | MCP 调用证据的时间 |

**演示前建议当天重跑一次 `build_data.py`**，否则评委可能看到昨天的时段菜单。
