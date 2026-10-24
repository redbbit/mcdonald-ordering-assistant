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

let fail = 0, warned = 0;
function check(cond, msg) { if (!cond) { fail++; console.log('   ❌ ' + msg); } }
// ⚠️ = 已知边界（降级但对得起用户），不是失败。要在输出里如实标出，不能假装没事。
function warn(cond, msg) { if (!cond) { warned++; console.log('   ⚠️ ' + msg + '（已知边界）'); } }

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
  { n: '极端：1人·15块',          o: { people: 1, bmax: 15, goal: '' }, loose: true }
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
    (c.loose ? warn : check)(p.kcal > 0, `方案${p.k} 热量合计为 0`);
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
    (c.loose ? warn : check)(sigs.size === r.plans.length, '三套方案出现重复');
  }
  check(r.plans.length === 3, `方案数应为 3，实际 ${r.plans.length}`);
});

/* ================= 升级项自检（问题一/三/四） ================= */
console.log('\n' + '='.repeat(78));
console.log('升级项自检：目标匹配 / 套餐对比 / 拆单用券 / 点名菜');
console.log('='.repeat(78));

/* ---- 问题三：口语目标匹配 ---- */
console.log('\n■ 目标匹配（口语扩容 + 打分制）');
const GOAL_CASES = [
  ['想吃得满足一点', 'full'],
  ['三个人想吃点性价比高的', 'cheap'],
  ['减脂期，想少长肉', 'lose'],
  ['增肌，多点蛋白质', 'bulk'],
  ['没吃过的新品想尝尝鲜', 'new'],
  ['带孩子随便吃点', 'kid'],
  ['请客吃饭要体面', 'treat'],
  ['均衡一点就行', 'balance'],
  ['今天天气还不错', null]
];
GOAL_CASES.forEach(([text, key]) => {
  const g = E.normGoal(text);
  check(key === null ? g.custom === true : (g.key === key && g.custom === false),
    `目标匹配「${text}」应为 ${key || 'custom(未识别)'}，实得 ${g.key}${g.custom ? '(custom)' : ''}`);
  if (key) {
    const m = E.matchGoal(text);
    check(m.hits.length > 0, `「${text}」应有命中词记录`);
  }
  console.log(`   「${text}」 → ${g.key === 'custom' ? '未识别·按均衡' : g.name}（${g.kcal} kcal/人）`);
});
check(E.normGoal('').key === 'balance', '空目标应落均衡');

/* ---- 问题四：套餐 vs 散件 ---- */
console.log('\n■ 套餐 vs 散件对比');
const byCode = {};
D.dishes.forEach(d => { byCode[d.code] = d; });
const combos = D.dishes.filter(d => d.role === 'combo' && d.parts && d.parts.length);
check(combos.length > 0, '菜单里应有带子项的套餐');
let comboChecked = 0, comboNull = 0, comboSaveSum = 0;
combos.forEach(c => {
  const b = E.comboBreakdown(c, byCode);
  if (b === null) { comboNull++; return; }        // 子项对不上价 → 诚实返回 null，不是错
  comboChecked++;
  check(Math.abs(b.save - (b.partsTotal - b.comboPrice)) < 0.011, `套餐 ${c.name} save 口径应自洽`);
  check(b.partsKnown >= 1 && b.partsKnown <= b.partsCount, `套餐 ${c.name} 已知子项数应合理`);
  if (b.save > 0) comboSaveSum += b.save;
});
console.log(`   ${comboChecked} 份套餐可拆解（${comboNull} 份子项无价返回 null），省钱的合计 ¥${comboSaveSum.toFixed(2)}`);
check(E.comboBreakdown(D.dishes.find(d => d.role !== 'combo'), byCode) === null, '非套餐应返回 null');
check(E.comboBreakdown(combos[0], {}) === null, '查不到子项价应返回 null，不编数');

/* ---- 问题一：券面规则解析 ---- */
console.log('\n■ 优惠券规则解析');
const RULE_CASES = [
  ['免费脆薯饼', r => r.kind === 'free' && r.item === '脆薯饼'],
  ['11.9元麦辣鸡腿堡', r => r.kind === 'fixed' && r.price === 11.9 && r.item === '麦辣鸡腿堡'],
  ['19.9元王牌炸鸡任选2', r => r.kind === 'fixed' && r.price === 19.9],
  ['满30减5', r => r.kind === 'threshold' && r.minSpend === 30 && r.cut === 5],
  ['满 40 元减 8 元', r => r.kind === 'threshold' && r.minSpend === 40 && r.cut === 8],
  ['这是什么鬼券', r => r.kind === 'unknown']
];
RULE_CASES.forEach(([title, ok]) => {
  const r = E.parseCouponRule(title);
  check(ok(r), `券面「${title}」解析结果不对：${JSON.stringify(r)}`);
});
const ml = D.dishes.find(d => d.name === '麦辣鸡腿汉堡');
check(E.matchCouponDish(E.parseCouponRule('11.9元麦辣鸡腿堡'), D.dishes) === ml,
  '「11.9元麦辣鸡腿堡」应对上「麦辣鸡腿汉堡」（差一个汉字的前缀匹配）');
check(E.estimateCouponCut(E.parseCouponRule('11.9元麦辣鸡腿堡'), ml, 100) === 10.6,
  '固定价券收益应为 22.5-11.9=10.6');
check(E.estimateCouponCut(E.parseCouponRule('满30减5'), null, 25) === 0, '不满门槛应 0');
check(E.estimateCouponCut(E.parseCouponRule('满30减5'), null, 35) === 5, '满门槛应减 5');
check(E.estimateCouponCut(E.parseCouponRule('这是什么鬼券'), ml, 100) === 0, '认不出的券收益 0');

/* ---- 问题一：拆单 + 分钱 + 券分配 ---- */
console.log('\n■ 多人拆单与券分配');
const items = [
  { code: 'a', name: 'A餐', price: 10, qty: 1 },
  { code: 'b', name: 'B餐', price: 20, qty: 1 },
  { code: 'c', name: '公共薯条', price: 10.01, qty: 1 }
];
const members = [{ name: '甲' }, { name: '乙' }];
const built = E.buildSubOrders(items, members, [[0], [1], []]);
check(built.subOrders.length === 2, '应拆出 2 单');
// 归属：A(10)→甲，B(20)→乙，公共薯条(10.01) 均摊 → 甲 15.005 / 乙 25.005，
// 最大余额法补分后：甲 ¥15.01、乙 ¥25.00，总额 ¥40.01 严格相等
check(Math.abs(built.subOrders[0].subtotal - 15.01) < 0.011, `甲应付 15.01，实得 ${built.subOrders[0].subtotal}`);
check(Math.abs(built.subOrders[1].subtotal - 25.00) < 0.011, `乙应付 25.00，实得 ${built.subOrders[1].subtotal}`);
check(Math.abs(built.total - 40.01) < 0.005, `总额应严格相等 40.01，实得 ${built.total}`);
check(built.balanced === true, '拆单必须平衡');
check(built.subOrders[0].items.some(i => i.shared === true), '甲的单里应有公共项标记');
const built2 = E.buildSubOrders(items, members, null);
check(Math.abs(built2.subOrders[0].subtotal + built2.subOrders[1].subtotal - 40.01) < 0.005,
  '无归属时全部按公共项均分，总额仍须严格相等');
check(built2.subOrders.every(s => s.items.every(i => i.shared === true)), '无归属时每项都应是公共项');
const subs = [
  { name: '甲', subtotal: 10 }, { name: '乙', subtotal: 20 }, { name: '丙', subtotal: 35 }
];
const couponPool = [
  { title: '满15减3' }, { title: '满30减5' }, { title: '免费脆薯饼' }
];
const opt = E.optimizeCoupons(subs, couponPool, D.dishes);
check(opt.totalCut > 0, '应估算出券收益');
check(subs.filter(s => s.coupon).length >= 1, '至少一单分到券');
check(subs.every(s => !s.coupon || s.payAfterCoupon >= 0), '用券后不能为负');
const usedTitles = subs.filter(s => s.coupon).map(s => s.coupon.title);
check(new Set(usedTitles).size === usedTitles.length, '同一张券不能用两次');
console.log(`   拆单 ¥${built.total}｜券分配后收益估算 ¥${opt.totalCut}｜分到：${usedTitles.join('、') || '无'}`);

/* ---- 问题五配套：点名菜进方案 ---- */
console.log('\n■ 点名菜（「想吃巨无霸」必须出现）');
const rw = E.makePlans({ dishes: D.dishes, people: 2, bmax: 120, goal: '均衡就好', wanted: ['巨无霸'], seed: 20261024 });
if (!rw.error) {
  rw.plans.forEach(p => {
    check(p.items.some(i => i.d.name.indexOf('巨无霸') >= 0), `${p.k} 版应包含巨无霸`);
  });
  check(rw.wanted.some(w => w.name === '巨无霸' && w.reason === ''), '点名菜应解析成功');
  console.log(`   三版均含巨无霸：${rw.plans.map(p => p.items.filter(i => i.d.name.includes('巨无霸')).map(i => i.d.name).join('+')).join(' | ')}`);
} else { check(false, '带点名菜的配餐不应报错'); }
const rw2 = E.makePlans({ dishes: D.dishes, people: 1, bmax: 20, goal: '', wanted: ['巨无霸'], seed: 20261024 });
if (!rw2.error) {
  check(rw2.plans.every(p => p.unmetWanted.length > 0 || p.items.some(i => i.d.name.includes('巨无霸'))),
    '预算不够时要如实记录 unmetWanted');
  console.log(`   20 元预算点巨无霸：unmet=${JSON.stringify(rw2.plans[0].unmetWanted)}`);
} else { console.log('   ⚠️ 20 元预算整体无方案（已知边界）'); }
const rw3 = E.makePlans({ dishes: D.dishes, people: 1, bmax: 60, goal: '', avoid: ['辣'], wanted: ['麦辣鸡腿汉堡'], seed: 20261024 });
check(!rw3.error && rw3.wanted.some(w => w.name === '麦辣鸡腿汉堡' && w.reason === 'avoid'),
  '忌口挡住点名菜时应记录 reason=avoid');
console.log(`   忌辣又点麦辣鸡腿汉堡：${JSON.stringify(rw3.wanted)}`);

/* ---- 本轮新增：堂食/外送 · 点餐模式 · 特色模式（用户六项要求）---- */
console.log('\n■ 用餐方式 / 点餐模式 / 特色模式');
check(E.parseDining('外送到学校') === 'delivery' && E.parseDining('麦乐送') === 'delivery', 'parseDining 外送关键词');
check(E.parseDining('堂食') === 'dineIn' && E.parseDining('到店自取') === 'dineIn' && E.parseDining('得来速') === 'dineIn', 'parseDining 堂食关键词');
check(E.parseDining('3个人100块') === null, 'parseDining 没说不默认堂食');
check(E.parseCouponType('外送专享福利券') === 'delivery', 'parseCouponType 外送券');
check(E.parseCouponType('堂食券') === 'dineIn', 'parseCouponType 堂食券');
check(E.parseCouponType('免费脆薯饼') === 'unlabeled', 'parseCouponType 未标注（真实数据里的券都没标）');
check(E.couponApplies('dineIn', 'delivery').ok === false, '堂食券不上外送单');
check(E.couponApplies('delivery', 'dineIn').ok === false, '外送券不接到店单');
check(E.couponApplies('unlabeled', 'delivery').ok === true, '未标注券按通用券处理');
check(E.couponApplies('dineIn', null).ok === true, '未说明用餐方式时不卡券');
check(E.parseOrderMode('各点各的') === 'split' && E.parseOrderMode('AA') === 'split', 'parseOrderMode 各自点');
check(E.parseOrderMode('我请客一起点') === 'together' && E.parseOrderMode('帮大家点') === 'together', 'parseOrderMode 一人点完所有人');
check(E.parseOrderMode('3个人') === null, 'parseOrderMode 没说不瞎猜');
const newModes = E.parseModes('哥有钱，就喜欢单点，宵夜模式');
check(newModes.singlesOnly === true && newModes.lateNight === true, 'parseModes 两个特色模式都认');
check(E.parseModes('3个人100块').singlesOnly === false && E.parseModes('3个人100块').lateNight === false, 'parseModes 不误报');

/* singlesOnly「哥/姐有钱，就喜欢单点」：候选池排除套餐 */
const rso = E.makePlans({ dishes: D.dishes, people: 2, bmax: 100, goal: '', singlesOnly: true, seed: 20261025 });
if (!rso.error) {
  check(rso.plans.every(p => p.items.every(i => i.d.role !== 'combo' && !/(套餐|组合|桶|分享餐|件套)/.test(i.d.name))),
    '单点畅吃：任何方案都不应含套餐/套装（官方分类漏标的按品名补过滤）');
  console.log(`   单点畅吃三版：${rso.plans.map(p => p.items.map(i => i.d.name).join('+')).join(' | ')}`);
} else check(false, '单点畅吃模式不应报错');

/* lateNight「宵夜模式」：只做偏好加权，不能把方案配崩 */
const rln = E.makePlans({ dishes: D.dishes, people: 1, bmax: 50, goal: '', lateNight: true, seed: 20261025 });
check(!rln.error && rln.plans.length > 0, '宵夜模式应正常出方案');
if (!rln.error) console.log(`   宵夜模式首版：${rln.plans[0].items.map(i => i.d.name).join('+')}（偏好加权，非官方分类）`);

/* exclude：菜品级排除（「不要可乐」——与忌口是两件事） */
const drink = D.dishes.filter(d => d.ok === true && /可乐/.test(d.name))[0];
const rex = E.makePlans({ dishes: D.dishes, people: 2, bmax: 100, goal: '', exclude: [drink.code], seed: 20261025 });
if (!rex.error) {
  check(rex.plans.every(p => p.items.every(i => i.d.code !== drink.code)), '被排除的菜品不应出现在任何方案里');
  console.log(`   排除「${drink.name}」后仍出 ${rex.plans.length} 版`);
} else check(false, '带 exclude 的配餐不应报错');

/* 套餐拆开单点：wanted 子项带 fromCombo 标记，按单点进方案 */
const comboWithParts = D.dishes.filter(d => d.role === 'combo' && d.parts && d.parts.length)[0];
if (comboWithParts) {
  const part = comboWithParts.parts[0];
  const rpc = E.makePlans({ dishes: D.dishes, people: 1, bmax: 80, goal: '',
    wanted: [{ name: part.name, fromCombo: comboWithParts.name }], seed: 20261025 });
  if (!rpc.error) {
    check(rpc.plans.every(p => p.items.some(i => i.d.name === part.name)), '套餐拆出的子项应按单点进方案');
    console.log(`   「${comboWithParts.name}」只要「${part.name}」→ ${rpc.plans[0].items.map(i => i.d.name).join('+')}`);
  } else check(false, '套餐拆开单点不应报错');
} else { console.log('   ⚠️ 数据里没有带 parts 的套餐（已知边界）'); }

/* comboWorthWeight：省 ≥1 元加权 1.3，拆开更便宜降权 0.72，其余 1 */
const byCodeAll = {}; D.dishes.forEach(d => { byCodeAll[d.code] = d; });
const combosWithParts = D.dishes.filter(d => d.role === 'combo' && d.parts && d.parts.length);
const worthUp = combosWithParts.filter(c => { const cb = E.comboBreakdown(c, byCodeAll); return cb && cb.save >= 1; })[0];
const worthDown = combosWithParts.filter(c => { const cb = E.comboBreakdown(c, byCodeAll); return cb && cb.save <= -1; })[0];
if (worthUp) check(E.comboWorthWeight(worthUp, byCodeAll) === 1.3, '套餐真划算应加权 1.3');
if (worthDown) check(E.comboWorthWeight(worthDown, byCodeAll) === 0.72, '套餐不值应降权 0.72');
check(E.comboWorthWeight(D.dishes.filter(d => d.role !== 'combo')[0], byCodeAll) === 1, '非套餐权重恒 1');
console.log(`   套餐值得度：加权 ${combosWithParts.filter(c => E.comboWorthWeight(c, byCodeAll) === 1.3).length} 个 / 降权 ${combosWithParts.filter(c => E.comboWorthWeight(c, byCodeAll) === 0.72).length} 个 / 持平 ${combosWithParts.filter(c => E.comboWorthWeight(c, byCodeAll) === 1).length} 个`);

/* =========================================================
   子项偏好 + 混合方案（套餐拆开的正确含义）
   「我想要安格斯厚牛堡，不要薯条和可乐」——不是全单点、不是套餐改配，
   而是 want/avoid 信号喂多目标优化，让「整套餐 vs 拆开单点」同池竞争。
   ========================================================= */
console.log('\n■ 子项偏好与混合方案');

/* ① parseItemPrefs：want/avoid 解析质量 */
const pf1 = E.parseItemPrefs('我想要安格斯厚牛堡，不要薯条和可乐', D.dishes);
check(pf1.some(p => p.pref === 'want' && /安格斯厚牛堡/.test(p.name)), '「想要安格斯厚牛堡」应解析出 want');
check(pf1.filter(p => p.pref === 'want').length === 1, 'want 只留一条最具体的（同义多规格去重）');
check(pf1.some(p => p.pref === 'avoid' && p.name === '薯条'), '「不要薯条」应解析出 avoid（标准品名，去边字命中）');
check(pf1.some(p => p.pref === 'avoid' && /可乐/.test(p.name)), '「不要可乐」应解析出 avoid');
check(pf1.filter(p => p.pref === 'avoid').length === 2, 'avoid 应恰好 2 条（5 种薯条规格合并成 1 条）');
check(pf1.every(p => p.mention && p.mention.length >= 2), '每条偏好都带 mention（UI 回填用户原话）');
const pf2 = E.parseItemPrefs('想吃巨无霸，别放可乐', D.dishes);
check(pf2.some(p => p.pref === 'want' && p.name === '巨无霸'), '「想吃巨无霸」应解析出 want 巨无霸');
check(pf2.every(p => p.pref !== 'want' || p.name === '巨无霸'), '「无霸」过短变体不得误命中三件套/四件套');
const pf3 = E.parseItemPrefs('安格斯厚牛堡套餐只要汉堡和薯条', D.dishes);
check(pf3.length === 0, '显式拆开句式交给 parseQuery 旧逻辑，这里零输出（不重复消费）');
check(E.parseItemPrefs('3个人100块', D.dishes).length === 0, '没有偏好表达时零输出');
console.log(`   解析样例：${pf1.map(p => p.pref + ':' + p.name + '(' + p.mention + ')').join(' / ')}`);

/* ② comboPartFit：role=main 的套装（巨无霸三件套）也拆得动——isComboLike 口径 */
const bigMac3 = D.dishes.filter(d => d.name === '巨无霸三件套')[0];
const pfIdx = E.buildPrefIndex(pf1, D.dishes);
if (bigMac3) {
  const fit = E.comboPartFit(bigMac3, pfIdx);
  check(fit.avoided.indexOf('中薯条') >= 0 && fit.avoided.indexOf('可乐中杯') >= 0,
    '巨无霸三件套（官方 role=main）应识别出忌子项 中薯条/可乐中杯');
  check(fit.taste === 'conflict', '含忌子项 → taste=conflict');
} else check(false, '数据里应有巨无霸三件套');
check(E.planTasteFit({ items: [{ q: 1, d: bigMac3 }] }, E.buildPrefIndex([], D.dishes)) === 1,
  '无子项偏好时口味匹配恒 1（向后兼容：旧排序一分不变）');

/* ③ 混合方案生成：拆开候选进同一打分池，sourceType/fromCombo 记账 */
const rmix = E.makePlans({ dishes: D.dishes, people: 2, bmax: 100, goal: '',
  itemPrefs: pf1, seed: 20261025 });
if (!rmix.error) {
  const allPlans = rmix.plans;
  const withParts = allPlans.filter(p => p.items.some(i => i.src === 'comboPart'));
  check(withParts.length > 0, '应出现「套餐子项转单点」候选（与整份同池竞争）');
  check(allPlans.every(p => p.items.every(i => i.src !== 'comboPart' || i.fromCombo)),
    'comboPart 项必须带 fromCombo（告诉用户这是从哪个套餐拆的）');
  // 拆出子项按官方菜单价计，不编价
  const seedItem = withParts[0].items.filter(i => i.src === 'comboPart')[0];
  const menuDish = D.dishes.filter(d => d.code === seedItem.d.code)[0];
  check(menuDish && menuDish.price === seedItem.d.price, '拆出子项按菜单单点价计（官方数据，不估算）');
  // 源套餐不与自己的拆开版同池出现（都已拆开了，再把整份加回来自相矛盾）
  const badMix = withParts.filter(p => p.items.some(i => i.src === 'comboPart' &&
    p.items.some(j => j.src !== 'comboPart' && j.d.name === i.fromCombo)));
  check(badMix.length === 0, '源套餐整份不得与自己的拆开子项同版出现');
  console.log(`   混合候选：${withParts.length}/${allPlans.length} 版含拆开子项，例：` +
    withParts[0].items.map(i => (i.src === 'comboPart' ? '[拆]' : '') + i.d.name).join('+'));
} else check(false, '带子项偏好的配餐不应报错');

/* ④ 权重翻转：price 拉高整份套餐回归，taste 拉高套餐整体出局 */
const W_PRICE = { price: 3, kcal: 1, protein: 1, taste: 0.2 };
const W_TASTE = { price: 0.2, kcal: 1, protein: 1, taste: 3 };
const rwP = E.makePlans({ dishes: D.dishes, people: 2, bmax: 100, goal: '', itemPrefs: pf1, weights: W_PRICE, seed: 20261025 });
const rwT = E.makePlans({ dishes: D.dishes, people: 2, bmax: 100, goal: '', itemPrefs: pf1, weights: W_TASTE, seed: 20261025 });
if (!rwP.error && !rwT.error) {
  check(rwP.plans[0].items.some(i => E.isComboLike(i.d)),
    '价格权重拉高：首版应含完整套餐（组合价更省）');
  check(rwT.plans[0].items.every(i => !E.isComboLike(i.d)),
    '口味权重拉高：首版不应含完整套餐（含忌子项的套餐被口味扣分压下去）');
  check(rwT.plans.some(p => p.items.some(i => i.src === 'comboPart')),
    '口味权重拉高：应出现套餐子项转单点');
  console.log(`   权重翻转：price×3 首版含 ${rwP.plans[0].items.filter(i => E.isComboLike(i.d)).length} 个完整套餐 / ` +
    `taste×3 首版含 ${rwT.plans[0].items.filter(i => E.isComboLike(i.d)).length} 个，` +
    `拆开版 ${rwT.plans.filter(p => p.items.some(i => i.src === 'comboPart')).length} 版`);
} else check(false, '权重翻转两组配餐都不应报错');

/* ⑤ 官方不改配边界 + 四维对比 + 离线 simulated 标注 */
if (!rmix.error) {
  check(rmix.plans.every(p => (p.tradeoffExplanation || []).some(s => s.indexOf('不支持套餐改配') >= 0)),
    '有子项偏好时每版都要写明「官方 MCP 不支持套餐改配」');
  check(rmix.plans.every(p => !p.mixSummary || typeof p.mixSummary.text === 'string'),
    'mixSummary.text 必须存在（人话总结）');
  const cmp = rmix.plans.map(p => p.comboCompare).filter(Boolean)[0];
  if (cmp && cmp.length) {
    check(cmp.every(c => c.price && typeof c.price.combo === 'number' && typeof c.price.parts === 'number'),
      '四维对比：价格维度 combo/parts 双值齐全');
    check(cmp.every(c => c.kcal == null || (typeof c.kcal.combo === 'number' && typeof c.kcal.parts === 'number')),
      '四维对比：热量维度要么双值齐全、要么 null（官方无数据不编）');
    check(cmp.every(c => c.taste && typeof c.taste.winner === 'string'),
      '四维对比：口味匹配维度 winner 存在');
    console.log(`   四维对比样例：${cmp[0].combo} 整份¥${cmp[0].price.combo} vs 拆开¥${cmp[0].price.parts}，` +
      `口味胜者 ${cmp[0].taste.winner}${cmp[0].unresolvedParts.length ? '，无价子项 ' + cmp[0].unresolvedParts.join('、') : ''}`);
  } else check(false, '有子项偏好时应产出四维对比');
  // 对不上面价的子项不得被编出单点价
  const noPrice = D.dishes.filter(d => (d.parts || []).some(pt => pt.name === '可乐中杯'));
  check(noPrice.length > 0, '数据里应存在含「可乐中杯」的套餐（官方无单点价的子项）');
}

console.log('\n' + '='.repeat(78));
console.log(fail === 0 ? '✅ 全部断言通过' : `❌ ${fail} 条断言失败`);
if (warned) console.log(`   另有 ${warned} 处已知边界（极端预算下的降级，已在上方 ⚠️ 标出）`);
process.exit(fail ? 1 : 0);
