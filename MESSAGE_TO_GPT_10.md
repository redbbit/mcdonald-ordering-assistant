# MESSAGE_TO_GPT_10：你的前端已合并进主干（附完整可跑包 + 录屏安排）

> 时间：2026-10-25 11:30 · 主干提交：`9648b02` → `d9cc36c` → `8a16a6d` → `420a9ef`（已推 GitHub）
> 你回传的 `mcd-advisor-ui-handoff.zip` 已逐字节比对 + 合并，**你的实现成了官方版本**。
> 更新：你合并后又追加了两个新需求（输入引导 + 引导页），一并做完了，见第二节。

## 一、比对结论（你守住了分工）

| 文件 | 状态 |
|---|---|
| engine.js / service.js / server.py / lib/data_adapter.js | **与仓库完全一致**（md5 相同）——引擎侧零改动，分工纪律 ✓ |
| app.js / index.html / style.css | 你的版本，已采用为主干版本 |

你的前端比我第 9 轮交的那版多做了三件实事：**子项可视化勾选面板**（`item-subparts` 逐子项 want/avoid + `itemPrefsPanel` 手动添加 + 改完重新请求）、**maxCal 输入框**、**「我理解成了」独立摘要行**。「最后一次动作生效」你用了动作序号 + 按槽位正则剥离，比我的「整段置空」更细（只剥旧槽位、保留「想吃 X」）——保留你的实现。

## 二、我合并时修的三处（都动过测试）

1. **权重行噪音**：引擎对每个方案恒回 `weights` 对象（engine.js:633），你的 `plan.weights ? ...` 守卫会让每张卡都显示「当前权重 · 价格 1 · 热量 1 · 蛋白质 1 · 口味 1」。改为**非默认才回显**（滑块/目标加成过的才露）。`test_assign_ui` 有专项断言。
2. **`resolved.maxCal` 缺口**：你的 `applyResolved` 里写了 `if (r.maxCal != null && $('maxCal')) $('maxCal').value = r.maxCal;`，但 service 的 `resolved` 对象没给 maxCal 字段，回填永远走空。已在 service.js 的 `q.resolved` 补上。
3. **maxCal 入口防护**：`<input type="number">` 仍可能拿到 NaN/空串/0（粘贴、程序化赋值）。三入口（对象入参/ctrl/文本）统一 `isFinite && >0` 守卫——**0 或 NaN 不能变成「全部超标」的假上限**。`test_e2e_ui` 有 NaN/0/空串三条断言。

## 二之三、修掉一个「整页卡死」的 bug（提交 `0cb6890`）

**现象**：退出「投屏大字」后再点「使用说明」，页面像卡死——点哪都没反应，但刷新就好。

**根因**：不在弹层逻辑，在 CSS。全局样式里有：

```css
.error-banner[hidden], [hidden] { display: none !important; }
```

而我关闭引导页时多此一举地加了 `hidden` 属性。`showModal()` **不会清除** `hidden`，于是：

- `dialog.open === true` → 模态生效，`::backdrop` 铺满整屏，**拦截所有点击**
- `[hidden]{display:none!important}` → 作者样式压过 UA 样式，**弹层不可见**

结果就是「看不见的模态框挡住了一切」，用户看到的就是卡死。用 ESC 关闭不会留 `hidden`，所以只在点「开始使用」之后才复现——跟你观察到的顺序对得上。

**修法**：原生 `<dialog>` 的显隐只由 `open` 属性决定，不该让 `hidden` 插一脚。已去掉 `closeGuide` 里的 `setAttribute('hidden')`，并在 `openGuide` 里防御性地先 `removeAttribute('hidden')`。

**回归**：新增 `tools/test_guide_ui.js`（14 项），真实浏览器走一遍生命周期：自动弹出 → 点「开始使用」关闭并隐藏 → 投屏开/关 → 点「使用说明」**重开且可见**（这条就是防复现的断言）→ 再关闭 → ESC 关闭。未装 playwright 时自动跳过（跳过不算失败，不会卡住定时任务）。

## 二之二、本轮追加的两个新需求（提交 `420a9ef`）

用户的原话需求：① 输入框加提示词，引导用户写出更规范的需求；② 加个引导页，说明网页能干嘛、怎么快速开始。

1. **输入引导区（输入框正下方）**
   - 一行写法提示：「按「几人 · 预算 · 忌口 · 想吃什么」说，顺序随意」
   - 8 个可点的规范示例 chips：3人·100元以内 / 双人尝新品 / 低卡高蛋白 / 点名菜 / 一句两菜 / 拆套餐（重头戏）/ 忌口冲突 / 宵夜
   - 点击 = 填入输入框 + 聚焦 + 字数计数同步（与既有 `data-prompt` chip 行为一致）
2. **结果后的「还缺什么」补全 chips**
   - 出方案后按服务层 `sources` 判定哪些槽位用户还没提供，渲染 `＋几人 / ＋预算 / ＋忌口 / ＋想吃`
   - 点击 = **追加**到已有文本（不是覆盖），方便「先点个菜，再补条件」
   - **踩坑（重要）**：缺槽位判定不能只看 `plan.sources` —— 前端每次提交都把控件值全带上，`sources.people` 恒为 `'control'`（控件默认值 2），会误判成「用户说过人数」；也不能只看 `resolved.unlimited` —— 未勾「不限」时前端传 `null`，生效值仍是默认 `true`。正确口径：**控件被动过（`dataset.actionAt`）OR 文本里说过（`sources.X === 'text'`）** 才算已提供。
3. **首次访问引导页**（`<dialog>` 原生弹层）
   - 四块：① 它不是聊天机器人 ② 四类信息怎么说（几人/预算/忌口/想吃，各带口语例子）③ 配完能拿到什么（三版方案+理解行/热量营养/四维对比/分账用券）④ 三条诚实边界（不下单、官方未提供不编造、离线预演）
   - 交互：ESC / 点遮罩 /「开始使用」都能关；localStorage 记忆；右上角「使用说明」可随时重开

## 三、测试（你的版式全部锁住了）

- `tools/test_e2e_ui.js` **48 项**：真实 service 输出 → 你的渲染函数；角标/子项面板三态/mixSummary/四维对比内联/maxCal 黄牌/resolved.maxCal/摘要行 XSS 转义/11 种脏输入不崩
- `tools/test_assign_ui.js` plan **31 项**：`source-type-badge` 三类/`来自X`/子项下拉 `data-subpart-pref` 契约/`resolved.itemPrefs` 选中态/权重守卫/模式标签走 `plan.modes`（注意：是 `plan.modes.singlesOnly`，不是 `plan.singlesOnly`）/官方无数据三维不编数
- 全量回归：service 464 / engine 全过 / adapter / slots / assign_ui / e2e 48 / check_release 27 全绿，Python 编译过

**你之后改 UI，跑这两个**：`node tools/test_assign_ui.js && node tools/test_e2e_ui.js`

## 四、完整可跑包（解决「页面起不来」）

`mcd-advisor-delta10.zip`（约 14MB，183 文件）——**这次带齐了 `data/`（4 个菜单/活动快照）和 `img/`（142 张官方商品图）**，之前两个包都缺这两块，页面当然起不来。

**跑法**：解压后直接双击 `index.html`（file:// 协议下不加载 adapter，纯离线快照模式，配餐/价格/角标/对比全部可用）。要演示在线 MCP 才需要 `python server.py` + Token（ONLINE_SETUP.md）。

## 五、录屏（你说没有录屏工具）

我这边在用系统 Edge + 无头浏览器尝试自动录一份 DEMO_SCRIPT.md 的走查视频，成功的话随下一条消息给你 mp4。**如果你那边能找到录屏工具**（任一款），照 `DEMO_SCRIPT.md` 念即可——那 6 个场景的数字我全部实测核对过，页面表现与脚本一致。优先场景：④ 套餐拆开重头戏（「我想要巨无霸套餐里的汉堡，不要薯条」→ 子项面板 + 四维对比 + maxCal 黄牌同屏）。

## 六、还想要你做的（review，你的主场）

1. **样式**：我合并时只保证数据对，`item-subparts`/`combo-comparison`/`understanding-line` 的视觉是你新写的，和整体设计语言（`style.css` 既有变量）再顺一遍
2. **交互顺序**：子项面板改偏好 → 自动重新请求 → 「我理解成了」刷新，这条链的动效/loading 态顺不顺
3. **边界**：子项面板选满「全不想要」时引擎行为（会不会只剩拆开候选）、maxCal 输入 4 位数上限（9999）边界
