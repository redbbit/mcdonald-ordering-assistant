/**
 * 多时段回归测试：证明「下午茶 / 夜市 / 宵夜」是三份真实独立的快照，
 * 切时段会换菜单、换价格，而不是同一个数据换个标签。
 *
 *   node tools/test_slots.js
 *
 * 这一条同时也是演示弹药：同一句输入在不同时段给出不同结果，是评委能当场看懂的证据。
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');

/* ---- 起一个假浏览器：按 index.html 的顺序加载 ---- */
const sandbox = { console, setTimeout, clearTimeout, Date, Math, JSON, Set, Map, Array, Object, String, Number, RegExp };
sandbox.globalThis = sandbox; sandbox.window = sandbox;
vm.createContext(sandbox);
const LOAD = ['data/menu_data.js', 'data/menu_data_night.js', 'data/campaigns.js', 'engine.js', 'service.js'];
LOAD.forEach(f => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f }));

const A = sandbox.McAdvisor;
let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  ' + extra : '')); }
}

console.log('==============================================================================');
console.log('多时段快照测试');
console.log('==============================================================================\n');

const slots = A.listSlots();
console.log('[1] listSlots()');
check(slots.length >= 2, '至少能列出 2 个时段快照', '实际 ' + slots.length + ' 个');
slots.forEach(s => console.log(`     ${s.key.padEnd(10)} ${String(s.label).padEnd(6)} available=${s.available} 抓取于 ${s.fetchedAt}`));
check(slots.every(s => s.available), '所有列出的时段都可用');
check(new Set(slots.map(s => s.key)).size === slots.length, '时段 key 不重复');

(async () => {
  const live = slots.filter(s => s.available);
  const results = {};

  console.log('\n[2] 每个时段独立实例');
  for (const s of live) {
    const S = A.createService({ slot: s.key });
    const sc = await S.getShowcase();
    // 注意：对象入参不认 budgetText，预算要走字符串；这里用统一的自然语言入参
    const plans = await S.recommendPlans('3个人150以内');
    results[s.key] = { sc, plans };

    check(plans.length === 3, `[${s.label}] 固定返回三版方案`);
    check(plans.every(p => p.planId), `[${s.label}] 每个方案都有 planId`);
    console.log(`     ${s.label} 广告板 ${sc.length} 款，其中新品 ${sc.filter(x => x.isNew).length} 款、活动价 ${sc.filter(x => x.isPromo).length} 款`);
    plans.forEach(p => console.log(`       ${p.title.padEnd(14)} ¥${String(p.totalPrice).padEnd(7)} 人均 ¥${p.perPersonPrice}  ${p.totalCalories} kcal`));
  }

  console.log('\n[3] 时段之间必须是真差异');
  const keys = Object.keys(results);
  if (keys.length >= 2) {
    for (let i = 1; i < keys.length; i++) {
      const prev = results[keys[i - 1]], cur = results[keys[i]];
      // 广告板可能相同（同一家店同一天的头部新品本来就是同一批，这是真实现象），
      // 真正要守的是「整份菜单不同」——否则区段切换就是换了个标签。
      function varOf(k) { return 'MCD_DATA' + (k === 'teatime' ? '' : '_' + k.toUpperCase()); }
      const prevAll = sandbox[varOf(keys[i - 1])].dishes.map(d => d.code).sort().join(',');
      const curAll = sandbox[varOf(keys[i])].dishes.map(d => d.code).sort().join(',');
      check(prevAll !== curAll, `${keys[i - 1]} 与 ${keys[i]} 的完整菜单不同`);

      const prevBudget = prev.plans.find(p => p.tier === 'budget');
      const curBudget = cur.plans.find(p => p.tier === 'budget');
      check(prevBudget.totalPrice !== curBudget.totalPrice || prevBudget.items.length !== curBudget.items.length,
        `${keys[i - 1]} 与 ${keys[i]} 的省钱版构成或总价不同`,
        `¥${prevBudget.totalPrice} vs ¥${curBudget.totalPrice}`);
    }
  }

  console.log('\n[4] planId 跨时段不串号');
  const prevIds = new Set(results[keys[0]].plans.map(p => p.planId));
  let crossOk = true;
  for (const k of keys.slice(1)) {
    const S2 = A.createService({ slot: k });
    try {
      await S2.calculatePlan(Array.from(prevIds)[0]);
      crossOk = false;   // 上一个时段的 planId 在此时段居然能用 → 串了
    } catch (e) { /* 期望抛错 NO_PLAN */ }
  }
  check(crossOk, '切时段后旧 planId 失效（抛 NO_PLAN）');

  console.log('\n==============================================================================');
  console.log(fail === 0
    ? `全部通过 ✓（${pass} 项断言）`
    : `${pass} 通过 · ${fail} 失败 ✗`);
  console.log('==============================================================================');
  process.exit(fail === 0 ? 0 : 1);
})();
