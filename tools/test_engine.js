/* 决策引擎离线自检：不联网、不碰 DOM，只看配出来的方案像不像人话 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const sandbox = { window: {}, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'data/menu_data.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'engine.js'), 'utf8'), sandbox);

const E = sandbox.window.MCDEngine;
const D = sandbox.window.MCD_DATA;
console.log('门店:', D.store.name, '| 距离', D.store.distance, 'm | 更新', D.fetchedAt);
console.log('时段原文:', D.store.slotText);
console.log('当前时段=', E.currentSlot(D.store.slotText, new Date()));
console.log('餐品', D.dishes.length, '算价通过', D.dishes.filter(d => d.ok === true).length,
  '有营养', D.dishes.filter(d => E.hasKcal(d)).length);
console.log('='.repeat(78));

let fail = 0;
function check(cond, msg) { if (!cond) { fail++; console.log('   ❌ ' + msg); } }

const CASES = [
  { n: '1人·30以内·吃饱',        o: { people: 1, bmax: 30, goal: '吃饱管饱' } },
  { n: '2人·60-90·均衡',         o: { people: 2, bmin: 60, bmax: 90, goal: '均衡就好' } },
  { n: '4人聚餐·150-220',        o: { people: 4, bmin: 150, bmax: 220, goal: '请客聚餐' } },
  { n: '1人·40以内·减肥控卡',      o: { people: 1, bmax: 40, goal: '减肥控卡' } },
  { n: '3人·尝鲜新品·100',        o: { people: 3, bmax: 100, goal: '尝鲜新品' } },
  { n: '2人·无限预算',           o: { people: 2, unlimited: true, goal: '' } },
  { n: '1人·不吃辣+牛肉·35',      o: { people: 1, bmax: 35, avoid: ['辣', '牛肉'] } },
  { n: '6人团餐·240-360',        o: { people: 6, bmin: 240, bmax: 360, goal: '请客聚餐' } },
  { n: '1人·省钱·25',            o: { people: 1, bmax: 25, goal: '省钱第一' } },
  { n: '2人·带孩子·80',          o: { people: 2, bmax: 80, goal: '带孩子吃' } },
  { n: '自定义词·我是xx最好看',    o: { people: 2, bmax: 90, goal: '我想吃点好消化的' } },
  { n: '极端：1人·15块',          o: { people: 1, bmax: 15, goal: '' } }
];

CASES.forEach(c => {
  const r = E.makePlans(Object.assign({ dishes: D.dishes, seed: 20261024 }, c.o));
  console.log('\n■ ' + c.n);
  if (r.error) { console.log('   ⚠️ 报错：' + r.error); console.log('   建议：' + (r.advice || []).join(' / ')); return; }

  const prices = [];
  r.plans.forEach(p => {
    const list = p.items.map(i => i.d.name + (i.q > 1 ? '×' + i.q : '') + '(' + i.d.price + ')').join(' + ');
    console.log(`   [${p.k}] ${p.name}  合计 ¥${p.total}  原价 ¥${p.orig}  省 ¥${p.save}`);
    console.log(`        热量 ${p.kcal} kcal | 蛋白 ${p.protein}g | 主食当量 ${p.mainCover.toFixed(1)}/${p.people} | 营养覆盖 ${Math.round(p.nutRate * 100)}% | 分 ${p.score.toFixed(3)}`);
    console.log(`        ${list}`);
    prices.push(p.total);

    const cap = c.o.unlimited ? Infinity : c.o.bmax;
    check(cap === Infinity || p.total <= cap + 0.01, `方案${p.k} 超预算 ${p.total} > ${cap}`);
    check(p.mainCover >= p.people - 0.9, `方案${p.k} 主食没覆盖到人数 (${p.mainCover}/${p.people})`);
    check(p.items.length >= 1, `方案${p.k} 没东西`);
    check(p.kcal > 0, `方案${p.k} 热量合计为 0`);
    // 忌口硬过滤
    (c.o.avoid || []).forEach(a => {
      p.items.forEach(i => check(i.d.Avoid.indexOf(a) < 0, `方案${p.k} 踩忌口 ${a}: ${i.d.name}`));
    });
    p.items.forEach(i => check(i.d.ok === true, `方案${p.k} 含不可售 ${i.d.name}`));
  });
  if (prices.length >= 3) {
    check(prices[0] <= prices[1] + 0.01 || prices[0] < prices[2], `A 应不贵于 B（A=${prices[0]} B=${prices[1]}）`);
    check(prices[2] >= prices[1] - 0.01 || prices[2] > prices[0], `C 应不便宜于 B（C=${prices[2]} B=${prices[1]}）`);
    const sigs = new Set(r.plans.map(p => p.items.map(i => i.d.code + i.q).sort().join()));
    check(sigs.size === r.plans.length, '三套方案出现重复');
  }
  check(r.plans.length === 3, `方案数应为 3，实际 ${r.plans.length}`);
});

console.log('\n' + '='.repeat(78));
console.log(fail === 0 ? '✅ 全部断言通过' : `❌ ${fail} 条断言失败`);
process.exit(fail ? 1 : 0);
