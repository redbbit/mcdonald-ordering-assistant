分账做好了，你可以做分账面板了。这封只讲新增的接口，别的不用改。


一、splitBill 已实现

签名：
```js
const bill = await S.splitBill(planId, {
  mode: 'even' | 'byItem' | 'byWeight',
  members: [{ name:'甲', weight:2 }, { name:'乙' }, { name:'丙' }],  // byWeight 时传 weight
  items: [{ code, owners:[0,1] }]      // 仅 byItem 需要，不传就用方案里的明细
});
```

三种口径：
- even —— 人均等分
- byItem —— 按归属，谁点了什么谁付；**没人认领的菜（公共菜）自动全员均摊**
- byWeight —— 按权重，比如有人请客多出点

用「最大余额法」落到分：100 元三人均分不会出现 33.33×3=99.99 差一分，实测是 33.34+33.33+33.33=100。返回里 `balanced:true` 就是「Σ各份 === 总额」的保证，你可以直接用它做校验态。


二、一个命名必须看清楚，否则你会搞混

返回里有两个「模式」，我特意分开命名了：

- `splitMode` —— 分账口径（even / byItem / byWeight）
- `mode` —— 数据源模式（online / offline）

如果你在面板上写 `if (bill.mode === 'even')` 就错了，那是数据源。判断分账口径要用 `splitMode`。


三、分账带 simulated，离线必须显示黄色

离线时 `bill.simulated === true`，同时 `bill.note` 会给好现成文案，你直接显示就行：

- 离线 → "预演分账，在线后校准"
- 在线 → "按实付分摊"

同理，**方案卡现在也带这三个字段了**（之前没有）：
```
plan.mode        // 'online' | 'offline'
plan.fetchedAt   // 快照抓取时间
plan.simulated   // 离线恒为 true
plan.priceSource // 'snapshot' | 'mcp-live'
```

所以你现在有两套判断依据：看 `plan.simulated`，或者看 `S.isSimulated()`。建议用前者——每张卡片自己带标记，比查全局稳（同一页面可能同时存在真实算价和预演券）。


四、createService 现在支持传 adapter

```js
const { adapter } = await McAdvisorData.detectAdapter();
const S = McAdvisor.createService({ adapter });   // 不传就是离线快照
S.mode();           // 'online' | 'offline'
S.isSimulated();    // true = 结果是预演
```

在线模式下同样这些方法都能用，返回的 simulated 会自动变成 false。


实测数据给你对一下（3人150以内，下午茶快照）：
- 方案：¥84.7 / ¥128.4 / ¥131.2，均带 mode='offline', simulated=true
- 分账：3 份，Σ=84.7，balanced=true，splitMode='even'
- 测试 42 项断言全过（tools/test_adapter.js）

上两封里的投屏模式和离线降级提示组件依然要一并做，别忘了。
