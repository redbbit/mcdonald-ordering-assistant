/* 契约层自检：验证 service.js 对前端承诺的每个字段都真的有值（Node 离线跑） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const sandbox = { window: {}, console, Date, Math, JSON, Promise, Error, encodeURIComponent };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'data/menu_data.js'), 'utf8'), sandbox);
// 活动日历是可选数据源：没这个文件也必须能跑，这里两者都试
const campPath = path.join(root, 'data/campaigns.js');
const hasCamp = fs.existsSync(campPath);
if (hasCamp) vm.runInContext(fs.readFileSync(campPath, 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'engine.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'service.js'), 'utf8'), sandbox);

const E = sandbox.window.MCDEngine;
const D = sandbox.window.MCD_DATA;
const S = sandbox.window.McAdvisor.createService({ data: D, engine: E });

let fail = 0, pass = 0;
function check(cond, msg) {
  if (cond) { pass++; } else { fail++; console.log('   ❌ ' + msg); }
}
function done(label) { console.log('   ✓ ' + label); }

console.log('='.repeat(78));
console.log('McAdvisor Service 契约自检');
console.log('='.repeat(78));

(async function () {
  /* ---- 1. getMeta ---- */
  const meta = await S.getMeta();
  check(meta.store.code === '1400028', 'getMeta 门店');
  check(meta.verifiedCount === meta.dishCount, 'getMeta 算价应 100% 通过');
  check(!!meta.fetchedAt, 'getMeta fetchedAt');
  console.log(`1. getMeta  ${meta.store.name} | ${meta.dishCount} 款 | 算价通过 ${meta.verifiedCount} | 有营养 ${meta.nutritionCount} | 更新 ${meta.fetchedAt}`);

  /* ---- 2. getShowcase ---- */
  const showcase = await S.getShowcase(12);
  const localOk = showcase.filter(s => s.imageLocal && fs.existsSync(path.join(root, s.imageLocal)));
  check(showcase.length > 0, 'getShowcase 非空');
  check(localOk.length === showcase.length, 'getShowcase 图片必须全部落本地');
  check(showcase.filter(s => s.isNew || s.isPromo).length > 0, 'getShowcase 应含新品/活动');
  console.log(`2. getShowcase  ${showcase.length} 条 | 本地图 ${localOk.length}/${showcase.length} | 新品 ${showcase.filter(s => s.isNew).length} | 活动 ${showcase.filter(s => s.isPromo).length}`);
  console.log('   首屏第一口:', showcase[0].name, '¥' + showcase[0].price, '| tags:', showcase[0].tags.join('/'));

  /* ---- 3. getCampaigns ---- */
  const camp = await S.getCampaigns();
  check(camp.coupons.length > 0, 'getCampaigns 券');
  check(camp.campaignCalendarLinked === true, 'campaign-calendar 应已接入');
  check(camp.today.length > 0, '今日活动不能为空');
  check(camp.campaigns.every(c => c.imageLocal), '每条活动都要有本地图');
  camp.campaigns.forEach(c => {
    check(fs.existsSync(path.join(root, c.imageLocal || '')), `活动图缺失：${c.title} → ${c.imageLocal}`);
  });
  console.log(`3. getCampaigns  券 ${camp.coupons.length} 张: ${camp.coupons.map(c => c.title).join('、')}`);
  console.log(`   活动日历 ${camp.campaigns.length} 条 = 今日 ${camp.today.length} / 即将 ${camp.upcoming.length} / 往期 ${camp.past.length}`);
  console.log(`   更新 ${camp.campaignCalendar && camp.campaignCalendar.fetchedAt} | 菜单活动 ${camp.promos.length} 条`);
  camp.today.slice(0, 4).forEach(c => console.log('   今日· ' + c.title.slice(0, 40)));

  /* ---- 4. parseQuery ---- */
  const Q = [
    ['3个人，100块以内，我想减肥，不吃辣', { people: 3, budgetMax: 100, avoid: ['辣'] }],
    ['两个人 80-120 元，尝鲜新品', { people: 2, budgetMin: 80, budgetMax: 120 }],
    ['不限预算，4人聚餐', { people: 4, unlimited: true, budgetMax: null }],
    ['无限预算 2 位', { people: 2, unlimited: true }],
    ['1人 50以下 不要牛肉', { people: 1, budgetMax: 50, avoid: ['牛肉'] }],
    ['我想吃点还没吃过的', { people: 1, unlimited: true }]
  ];
  console.log('4. parseQuery');
  for (const [text, exp] of Q) {
    const r = await S.parseQuery(text);
    for (const k of Object.keys(exp)) {
      check(JSON.stringify(r[k]) === JSON.stringify(exp[k]),
        `parseQuery "${text}" 的 ${k} 应为 ${JSON.stringify(exp[k])}，实得 ${JSON.stringify(r[k])}`);
    }
    console.log(`   "${text}"  → 人${r.people} 预算${r.unlimited ? '不限' : r.budgetMin + '-' + r.budgetMax} 忌[${r.avoid}]`);
  }
  // 「3个人吃炸鸡」不能被误判成忌鸡肉
  check(S.parseQuerySync('3个人一起吃炸鸡').avoid.indexOf('鸡肉') < 0, '不得把「吃炸鸡」误判为忌鸡肉');

  /* ---- 5. recommendPlans 固定三版 ---- */
  const qs = [
    { text: '3个人聚餐，150以内，随便吃' },
    { text: '2个人 80-120，我想减肥' },
    { text: '不限预算，尝鲜新品', people: 4 },
    { text: '1人 40以内 不吃牛肉' }
  ];
  console.log('5. recommendPlans');
  for (const raw of qs) {
    const plans = await S.recommendPlans(raw);
    check(plans.length === 3, `${raw.text} 必须固定返回 3 版，实得 ${plans.length}`);
    check(plans.map(p => p.tier).join(',') === 'budget,lean,new', 'tier 顺序固定 budget,lean,new');
    check(new Set(plans.map(p => p.planId)).size === 3, 'planId 唯一');
    check(plans.every(p => p.items.length > 0), '每版都要有菜');
    plans.forEach(p => {
      check(!!p.why, 'why 不能为空');
      check(p.people >= 1, 'people');
      check(p.perPersonPrice > 0, 'perPersonPrice');
      check(p.unavailableReplacements.length === 0, '构建期已排售罄，运行时应为空');
      check(p.availability === 'ok', 'availability');
      p.items.forEach(i => {
        check(!!i.productCode && !!i.name, 'PlanItem 基础字段');
        check(fs.existsSync(path.join(root, i.imageLocal || '')), `图缺失 ${i.name} → ${i.imageLocal}`);
        check(i.imageSource === '麦当劳官方 MCP', 'imageSource');
      });
    });
    // 语义：lean 版热量必须可判定；超标时要给出幅度，让 UI 能明说「超了 xx kcal」
    const lean = plans[1];
    check(lean.calorieVerdict !== 'unknown', `lean 版热量不应为 unknown（${raw.text}）`);
    if (lean.calorieVerdict === 'over') check(lean.overCalories > 0, 'over 必须给出超出幅度');
    check(lean.perPersonCalories == null ||
      lean.perPersonCalories <= lean.targetCaloriesPerPerson * 1.4,
      `lean 版人均热量 ${lean.perPersonCalories} 远超目标 ${lean.targetCaloriesPerPerson}（${raw.text}）`);
    // 语义：new 版应优先带新品/活动标签
    check(plans[2].newTags.length + plans[2].promoTags.length > 0, `new 版不应用不带标签的凑数 ${raw.text}`);

    console.log(`   "${raw.text}"`);
    plans.forEach(p => {
      console.log(`     [${p.tier}] ${p.title}  ¥${p.totalPrice} (原价¥${p.originalPrice} 省¥${p.discount}) 人均¥${p.perPersonPrice}  ${
        p.perPersonCalories == null ? '热量未知' : p.perPersonCalories + 'kcal/人'}  覆盖${(p.nutritionCoverage * 100).toFixed(0)}%  新品${p.newTags.length}/活动${p.promoTags.length}`);
      console.log(`         ${p.why}`);
    });
  }

  /* ---- 6. 忌口真的生效 ---- */
  const noBeef = await S.recommendPlans('2个人 100以内 不要牛肉');
  const beefHit = noBeef.flatMap(p => p.items).filter(i => (byCode(i.productCode).Avoid || []).indexOf('牛肉') >= 0);
  check(beefHit.length === 0, '忌牛肉后方案里仍出现牛肉: ' + beefHit.map(i => i.name).join());
  function byCode(c) { return D.dishes.find(d => d.code === c) || {}; }
  console.log(`6. 忌口过滤  忌牛肉 → 命中牛肉项 ${beefHit.length}（应为 0）`);

  /* ---- 7. calculatePlan / buildOrderSummary ---- */
  const ps = await S.recommendPlans('3人 150以内');
  const bd = await S.calculatePlan(ps[0].planId);
  check(bd.orderEnabled === false, '禁止下单必须写明');
  check(bd.method.indexOf('calculate-price') === 0, 'method 必须是 calculate-price');
  check(bd.payPrice === ps[0].totalPrice, '实付应与方案一致');
  check(bd.deliveryPrice === null, '配送费不可编造为 0');
  console.log(`7. calculatePlan  实付¥${bd.payPrice} 省¥${bd.discount} method=${bd.method} 下单=${bd.orderEnabled}`);

  const sum = await S.buildOrderSummary(ps[0].planId);
  check(sum.indexOf('门店') >= 0 && sum.indexOf('ps') < 0, '摘要含门店');
  check(sum.indexOf('create-order') < 0, '摘要不得出现下单');
  console.log('8. buildOrderSummary');
  sum.split('\n').slice(0, 9).forEach(l => console.log('   ' + l));

  try { await S.calculatePlan('plan-x-999'); check(false, '未知 planId 应报错'); }
  catch (e) { check(e.code === 'NO_PLAN', '未知 planId 错误码'); }

  /* ---- 8. 营养：未知必须是 null，不许估算 ---- */
  const nutMap = await S.getNutritionByProductCodes(ps[0].items.map(i => i.productCode).concat(['0000000000']));
  check(nutMap['0000000000'] === null, '未知 code 必须 null');
  const unknownInPlan = ps[0].items.filter(i => !i.nutrition);
  if (unknownInPlan.length) {
    console.log(`9. 营养未知项 ${unknownInPlan.length} 款（nutrition=null，界面须显示「官方未提供，未估算」）:`);
    unknownInPlan.forEach(i => console.log('   - ' + i.name));
    check(ps[0].unknownItems.length === unknownInPlan.length, 'unknownItems 计数应一致');
  } else {
    console.log('9. 本方案全部有官方营养数据');
  }

  /* ---- 10. 图片覆盖率总账 ---- */
  const allLocal = D.dishes.filter(d => d.imgLocal && fs.existsSync(path.join(root, d.imgLocal)));
  console.log(`10. 图片总账  ${allLocal.length}/${D.dishes.length} 张官方图落本地`);
  check(allLocal.length === D.dishes.length, '应全部落本地');

  console.log('='.repeat(78));
  console.log(fail === 0 ? `全部通过 ✓（${pass} 项断言）` : `失败 ${fail} 项 / 通过 ${pass} 项`);
  process.exit(fail === 0 ? 0 : 1);
})();
