/**
 * 双模式数据层测试
 *
 *   node tools/test_adapter.js
 *
 * 这一份主要守三件事：
 *   ① 离线绝不伪造 —— 价格 null、库存 unknown、券 simulated
 *   ② 五种故障情形都能被正确分类（不是笼统一个 error）
 *   ③ 在线探不到时自动降级到离线，而不是抛错把页面搞死
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');

const A = require(root + '/lib/data_adapter.js');

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  ' + extra : '')); }
}

/* 起一个假浏览器，按 index.html 的顺序加载，供 OfflineAdapter 读全局变量 */
const sandbox = { console, setTimeout, clearTimeout, Date, Math, JSON, Set, Map, Array, Object, String, Number, RegExp, Promise, fetch };
sandbox.globalThis = sandbox; sandbox.window = sandbox;
vm.createContext(sandbox);
['data/menu_data.js', 'data/menu_data_night.js', 'data/campaigns.js', 'engine.js'].forEach(f => {
  if (fs.existsSync(path.join(root, f))) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  }
});

console.log('==============================================================================');
console.log('双模式数据层测试');
console.log('==============================================================================\n');

(async () => {
  /* ---------------------------------------------------- ① 离线：三条铁律 */
  console.log('[1] OfflineAdapter · 绝不伪造');
  {
    const off = new A.OfflineAdapter({ globalThisShim: sandbox });
    off._G = sandbox;                       // 指向假浏览器

    const slots = off.listSlots();
    check(slots.length >= 2, '能列出至少 2 个时段快照', '实际 ' + slots.length);
    check(slots.every(s => s.source === 'snapshot'), '快照来源标注正确');

    const price = await off.calculatePrice([{ code: '9900005456', qty: 1 }]);
    check(price.available === false, '① 离线算价标记不可用', 'available=' + price.available);
    check(price.payPrice === null, '① 离线算价不给价格（不伪造）', 'payPrice=' + price.payPrice);
    check(price.simulated === true, '① 离线算价带 simulated');

    const probe = await off.probeItems(['9900005456', 'nope']);
    check(probe.items.every(i => i.state === 'unknown'),
      '② 离线库存一律 unknown（不伪造 60006 售罄）',
      probe.items.map(i => i.state).join(','));

    const coupon = await off.tryCoupons([{ price: 30, qty: 1 }], [{ code: 'c1', title: '满20减5', minSpend: '20元', amount: '5元' }]);
    check(coupon.simulated === true, '③ 离线券试算带 simulated');
    check(coupon.coupons[0].matched === true, '③ 券面规则仍然可用（30 ≥ 20）');

    const img = await off.resolveImage({ imgLocal: 'img/9900005456.png' });
    check(img.source === 'cache' && img.url === 'img/9900005456.png',
      '离线图片走本地缓存', img.url);
    const miss = await off.resolveImage({});
    check(miss.fallback === true && miss.url.indexOf('data:image/svg') === 0,
      '离线图片缺失时用占位（不发网络请求）');

    const menu = await off.getMenu();
    check(menu.length > 0, '离线菜单来自快照', menu.length + ' 款');
  }

  /* ---------------------------------------------------- ② Mock：五种情形 */
  console.log('\n[2] MockOnlineAdapter · 五种故障情形');
  {
    const ok = new A.MockOnlineAdapter({ scenario: 'ok', latency: 5 });
    const p = await ok.calculatePrice([{ code: 'x', qty: 1 }]);
    check(p.available === true && p.simulated === false, '正常情形返回真实结构', '¥' + p.price);

    for (const [scenario, want] of [['soldout', 'soldout'], ['ratelimited', 'rate_limited']]) {
      const m = new A.MockOnlineAdapter({ scenario, latency: 5 });
      let got = null;
      try { await m.calculatePrice([{ code: 'x', qty: 1 }]); } catch (e) { got = e.code; }
      check(got === want, `${scenario} 被正确归类`, 'code=' + got);
    }

    const to = new A.MockOnlineAdapter({ scenario: 'timeout', latency: 5 });
    let toCode = null;
    try { await to.calculatePrice([{ code: 'x', qty: 1 }]); } catch (e) { toCode = e.code; }
    check(toCode === 'timeout', '超时被正确归类', 'code=' + toCode);

    const cw = new A.MockOnlineAdapter({ scenario: 'coupon_window', latency: 5 });
    const res = await cw.tryCoupons([{ price: 30, qty: 1 }], [{ code: 'c1', title: '券' }]);
    check(res.coupons[0].reason === 'not-in-window', '券不在时段被单独识别（600012）', res.coupons[0].reason);

    const pr = await A.MockOnlineAdapter.prototype.probeItems.call(
      new A.MockOnlineAdapter({ scenario: 'soldout', latency: 5 }), ['a', 'b']);
    check(pr.items[0].state === 'soldout' && pr.items[1].state === 'available',
      '售罄探测区分 soldout / available');
  }

  /* ---------------------------------------------------- ③ 降级 */
  console.log('\n[3] 模式探测与降级');
  {
    const forced = await A.detectAdapter({ force: 'offline' });
    check(forced.adapter.mode === 'offline' && forced.degraded === false,
      '强制离线时不算降级');

    // 指向一个必然没人听的端口，应当降级而不是抛错
    const dead = await A.detectAdapter({ base: 'http://127.0.0.1:1', timeout: 1200 });
    check(dead.adapter.mode === 'offline', '后端不可达时自动降级为离线', 'mode=' + dead.adapter.mode);
    check(dead.degraded === true, '降级被标记出来（UI 据此显示离线状态条）', 'reason=' + dead.reason);
  }

  /* ---------------------------------------------------- ④ 真实后端（可选） */
  console.log('\n[4] 真实后端联调（需先 python server.py，没起则跳过）');
  {
    let live = false;
    try {
      const r = await A.detectAdapter({ timeout: 2500 });
      live = r.adapter.mode === 'online';
    } catch (e) { /* 没起服务 */ }

    if (!live) {
      console.log('  … 未检测到本机服务，跳过（起服务后重跑可验证在线路径）');
    } else {
      const r = await A.detectAdapter({ timeout: 3000 });
      check(r.adapter.mode === 'online', '在线模式可用');
      const meta = await r.adapter.getMeta();
      check(!!meta.requestId, '在线响应带 requestId（可作调用证据）', meta.requestId);
      const pr = await r.adapter.calculatePrice([{ code: '9900005456', qty: 1 }]);
      check(pr.available === true && pr.simulated === false, '在线算价是真实结果', '¥' + pr.price);
      check(pr.price > 0, '在线算价金额为正且单位已转元', '¥' + pr.price);
      const probe = await r.adapter.probeItems(['9900005456', '0000000000']);
      const hit = probe.items.filter(i => i.state === 'soldout').length;
      check(hit > 0, '在线售罄探测能识别真实 60006', 'soldout ' + hit + ' 个');
    }
  }

  /* ---------------------------------------------------- ⑤ 分账 */
  console.log('\n[5] 分账 · 三种口径与最大余额法');
  {
    const eng = sandbox.MCDEngine;
    check(!!eng && typeof eng.splitBill === 'function', '引擎提供 splitBill');
    if (eng && eng.splitBill) {
      // 100 元三人均分：33.33 × 3 = 99.99，差一分——最大余额法必须补平
      const even = eng.splitBill(100, { mode: 'even', people: 3 });
      const sum3 = even.shares.reduce((s, x) => s + x.amount, 0);
      check(even.balanced === true, '均分：Σ各份 === 总额', `${sum3} vs 100`);
      check(Math.abs(sum3 - 100) < 1e-9, '均分：没有差一分钱', 'Σ=' + sum3);

      const w = eng.splitBill(100, { mode: 'byWeight',
        members: [{ name: '甲', weight: 2 }, { name: '乙', weight: 1 }, { name: '丙', weight: 1 }] });
      const sw = w.shares.reduce((s, x) => s + x.amount, 0);
      check(w.balanced === true && Math.abs(sw - 100) < 1e-9, '权重分账：Σ === 总额', 'Σ=' + sw);
      check(w.shares[0].amount > w.shares[1].amount, '权重分账：权重大的付得多',
        `${w.shares[0].amount} > ${w.shares[1].amount}`);

      const item = eng.splitBill(60, {
        mode: 'byItem',
        members: [{ name: '甲' }, { name: '乙' }],
        items: [
          { code: 'a', price: 30, qty: 1, owners: [0] },
          { code: 'b', price: 30, qty: 1, owners: [1] }
        ]
      });
      check(item.balanced === true, '按归属分账：Σ === 总额');
      check(item.shares[0].amount === 30 && item.shares[1].amount === 30,
        '按归属分账：各付各的', `${item.shares[0].amount} / ${item.shares[1].amount}`);

      // 公共菜（无人认领）应当全员均摊
      const shared = eng.splitBill(60, {
        mode: 'byItem', members: [{ name: '甲' }, { name: '乙' }],
        items: [{ code: 'share', price: 60, qty: 1 }]
      });
      check(shared.shares[0].amount === 30 && shared.shares[1].amount === 30,
        '公共菜无人认领时均摊', `${shared.shares[0].amount} / ${shared.shares[1].amount}`);
    }
  }

  console.log('\n[6] 服务层分账 · 必须带 simulated');
  {
    const sb2 = { console, setTimeout, clearTimeout, Date, Math, JSON, Set, Map, Array, Object, String, Number, RegExp, Promise };
    sb2.globalThis = sb2; sb2.window = sb2;
    vm.createContext(sb2);
    ['data/menu_data.js', 'data/campaigns.js', 'engine.js', 'service.js'].forEach(f =>
      vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sb2, { filename: f }));

    const S = sb2.McAdvisor.createService();
    const plans = await S.recommendPlans('3个人150以内');
    check(plans.length === 3, '拿到三版方案');

    const p0 = plans[0];
    check(p0.mode === 'offline', '方案带 mode（离线）', 'mode=' + p0.mode);
    check(p0.simulated === true, '离线方案 simulated 为 true');
    check(!!p0.fetchedAt, '方案带 fetchedAt（快照时间）', String(p0.fetchedAt).slice(0, 16));

    const bill = await S.splitBill(p0.planId, { mode: 'even' });
    check(bill.simulated === true, '离线分账带 simulated（UI 必须显示黄色预演）');
    check(bill.balanced === true, '服务层分账 Σ === 总额', 'Σ=' +
      bill.shares.reduce((s, x) => s + x.amount, 0));
    check(bill.shares.length === 3, '分账份数 = 人数', bill.shares.length + ' 份');
    check(bill.splitMode === 'even' && bill.mode === 'offline',
      'splitMode 与 mode 是两个不同维度', `${bill.splitMode} / ${bill.mode}`);
    check(/预演/.test(bill.note), '离线分账文案含「预演」', bill.note);
  }

  console.log('\n==============================================================================');
  console.log(fail === 0 ? `全部通过 ✓（${pass} 项断言）` : `${pass} 通过 · ${fail} 失败 ✗`);
  console.log('==============================================================================');
  process.exit(fail === 0 ? 0 : 1);
})();
