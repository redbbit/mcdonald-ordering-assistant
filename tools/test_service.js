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

  /* ---- 4b. 点名菜：口语变体 + 一句多菜 ----
   * 投诉复盘：「我想吃炸鸡它一直推汉堡」「想吃薯饼推的餐一个薯饼也没有」。
   * 根因：动词正则捕获带缓冲词（吃炸鸡/个炸鸡/份炸鸡/炸鸡和薯饼），原串匹配静默落空。
   * 修法：动词表扩充 + wantCandidates 剥缓冲词/切连接词，一句多菜各收各的。 */
  const WANT = [
    '我要吃炸鸡', '想吃个炸鸡', '想吃点炸鸡', '想吃那个炸鸡',
    '加点炸鸡', '我想吃炸鸡和薯饼', '整一份炸鸡',
    '我想吃炸鸡', '想吃薯饼'
  ];
  for (const text of WANT) {
    const q = S.parseQuerySync(text, D.dishes);
    check(q.wanted.length > 0, `「${text}」应解析出点名菜，实得 wanted=${JSON.stringify(q.wanted)}`);
    check((q.unmetWanted || []).length === 0, `「${text}」点名菜应能在菜单里找到，unmet=${JSON.stringify(q.unmetWanted)}`);
  }
  // 一句多菜：连接词切开后两个都要收
  const qMulti = S.parseQuerySync('我想吃炸鸡和薯饼', D.dishes);
  check(qMulti.wanted.indexOf('蘸酱炸鸡') >= 0, '「想吃炸鸡和薯饼」应含 蘸酱炸鸡');
  check(qMulti.wanted.indexOf('脆薯饼') >= 0, '「想吃炸鸡和薯饼」应含 脆薯饼');
  // 标准说法不受影响
  check(JSON.stringify(S.parseQuerySync('想吃薯饼', D.dishes).wanted) === '["脆薯饼"]', '「想吃薯饼」仍精确命中 脆薯饼');
  // 口语变体不得误伤既有边界：规格层级惩罚仍生效
  check(S.parseQuerySync('想吃麦辣鸡腿堡', D.dishes).wanted.indexOf('麦辣鸡腿汉堡') >= 0,
    '「想吃麦辣鸡腿堡」应命中 麦辣鸡腿汉堡（共同前缀≥3）');
  check(S.parseQuerySync('想吃麦辣鸡腿堡', D.dishes).wanted.every(w => w.indexOf('四件套') < 0),
    '「想吃麦辣鸡腿堡」不得串到四件套');
  // 端到端：口语输入的三版方案都必须含点名菜（用户投诉的直接场景）
  const wantPlans = await S.recommendPlans('我要吃炸鸡');
  check(wantPlans.every(p => p.items.some(i => /炸鸡/.test(i.name))),
    '「我要吃炸鸡」三版方案都必须含炸鸡，实得 ' + wantPlans.map(p => p.items.map(i => i.name).join('/')).join(' | '));

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

  /* ---- 11. 输入冲突检测与双向同步（问题五） ---- */
  console.log('11. 输入冲突检测');
  const cq = await S.parseQuery({ text: '三个人，100块以内，想吃麦辣鸡腿堡，不吃辣', people: 2, budgetMax: 200, unlimited: false, avoid: [] }, D.dishes);
  check(cq.conflicts.length >= 2, `应检出人数+预算两条冲突，实得 ${cq.conflicts.length}`);
  check(cq.people === 3, '人数应按文本的 3 人生效');
  check(cq.budgetMax === 100, '预算应按文本的 100 生效');
  check(cq.resolved.people === 3 && cq.resolved.budgetMax === 100, 'resolved 应给出实际生效值（UI 双向同步用）');
  check(cq.sources.people === 'text' && cq.sources.budget === 'text', '来源应标记为 text');
  const avoidConflict = cq.conflicts.find(c => c.field === 'avoid');
  check(!!avoidConflict && avoidConflict.resolved === 'dropped', '想吃麦辣鸡腿堡又忌辣 → 应记录 dropped');
  check(cq.wanted.indexOf('麦辣鸡腿堡') < 0, '被忌口挡掉的点名菜不应进 wanted');
  cq.conflicts.forEach(c => console.log(`   ⚠ ${c.field}: ${c.note}`));
  const cq2 = await S.parseQuery({ text: '两个人，预算80到120', people: 2, budgetMin: 80, budgetMax: 120, unlimited: false });
  check(cq2.conflicts.length === 0, '文本与控件一致时不应报冲突');
  const cq3 = await S.parseQuery({ text: '想吃巨无霸', people: 1, unlimited: true }, D.dishes);
  check(cq3.wanted.indexOf('巨无霸') >= 0, '「想吃巨无霸」应校验成真实菜名');
  check(cq3.conflicts.length === 0, '单纯点名菜不是冲突');
  console.log(`   「${cq.text}」 → 人${cq.resolved.people} 预算${cq.resolved.unlimited ? '不限' : cq.resolved.budgetMin + '-' + cq.resolved.budgetMax} 点名[${cq3.wanted}]`);

  /* ---- 12. 推荐方案新字段：冲突 / 点名菜 / 套餐对比 / 目标兜底 ---- */
  console.log('12. 推荐方案新字段');
  const rp = await S.recommendPlans({ text: '3个人，120块以内，想吃巨无霸，想吃得满足一点', people: 2, budgetMax: 200, unlimited: false });
  check(rp.length === 3, '仍应出三版');
  check(!!rp[0].conflicts, '方案应带 conflicts（UI 统一出口）');
  check(rp.every(p => p.wantedInfo.requested.indexOf('巨无霸') >= 0), '三版都应带点名菜报告');
  check(rp.every(p => p.items.some(i => i.name.indexOf('巨无霸') >= 0)), '巨无霸应进入每一版');
  check(rp[0].goalInfo.recognized === true, '「想吃得满足一点」应识别为吃饱管饱');
  check(rp[0].goalInfo.key === 'full', '口语目标应命中 full');
  check(rp[0].why.indexOf('单点') >= 0 || rp[0].comboSummary.savingCount === 0, '有套餐节省时 why 应提及单点对比');
  const comboTotals = rp.map(p => p.comboSummary);
  console.log(`   套餐汇总：${comboTotals.map(c => c.comboCount + '份/省¥' + c.totalSave).join(' | ')}`);
  const rpCustom = await S.recommendPlans({ text: '2个人，你看着配一下', people: 2, unlimited: true });
  check(rpCustom[0].goalInfo.recognized === false, '无法识别的目标应如实标记');
  check(!!rpCustom[0].goalInfo.fallback, '未识别时应给温和兜底文案');
  check((rpCustom[0].goalInfo.suggestions || []).length >= 3, '兜底应给出可点的目标示例');
  console.log(`   未识别目标兜底：「${rpCustom[0].goalInfo.fallback}」建议：${(rpCustom[0].goalInfo.suggestions || []).join('/')}`);
  // 套餐项应带 combo 对比信息
  const withCombo = rp.find(p => p.items.some(i => i.combo));
  if (withCombo) {
    const ci = withCombo.items.find(i => i.combo);
    check(ci.combo.partsTotal > 0 && typeof ci.combo.save === 'number', '套餐项应带 partsTotal/save');
    check(ci.combo.partsKnown <= ci.combo.partsCount, '已知子项数不应超过总数');
    console.log(`   套餐对比示例：${ci.name} 套餐¥${ci.combo.comboPrice} vs 单点合计¥${ci.combo.partsTotal}（${ci.combo.partsKnown}/${ci.combo.partsCount} 子项有价，省¥${ci.combo.save}）`);
  }

  /* ---- 13. assignOrders：多人拆单分人用券（问题一） ---- */
  console.log('13. assignOrders 拆单用券');
  const ap = await S.recommendPlans('4个人，160块以内');
  const ao = await S.assignOrders(ap[0].planId, { members: ['阿甲', '小乙', '丙丙', '老丁'], useCoupons: true });
  check(ao.members.length === 4, '应拆出 4 单');
  check(ao.balanced === true, '各单之和必须等于总额');
  const sumSub = ao.members.reduce((s, m) => s + m.subtotal, 0);
  check(Math.abs(sumSub - ap[0].totalPrice) < 0.02, `各单小计之和应等于总额（${sumSub} vs ${ap[0].totalPrice}）`);
  check(ao.simulated === true, '离线必须标 simulated');
  check(ao.notes.some(n => n.indexOf('available-coupons') >= 0), '必须说明券收益为何只是估算');
  check(ao.notes.some(n => n.indexOf('最多用 1 张') >= 0), '必须说明一单一券假设');
  check(ao.combined.total === ap[0].totalPrice, '合单参照额应等于方案总额');
  check(['split', 'combined', 'tie'].indexOf(ao.comparison.cheaper) >= 0, '必须给出拆/合哪个划算');
  ao.members.forEach(m => {
    check(m.payAfterCoupon <= m.subtotal + 1e-9, '用券后不应更贵');
    if (m.coupon) check(m.coupon.estimatedCut > 0, '分到券就应有正收益');
  });
  console.log(`   拆单 ¥${ao.totals.splitSubtotal}｜券收益估算 ¥${ao.totals.estimatedCouponCut}｜合单参照 ¥${ao.combined.total}（券估算 ¥${ao.combined.estimatedCouponCut}）`);
  console.log(`   结论：${ao.comparison.verdict}`);
  ao.members.forEach(m => console.log(`   · ${m.name}: ¥${m.subtotal}${m.coupon ? ' → 用「' + m.coupon.title + '」估省¥' + m.coupon.estimatedCut : ''} → 估付¥${m.payAfterCoupon}`));
  // 关掉券：不应有任何券被分到
  const aoNoCoupon = await S.assignOrders(ap[0].planId, { members: ['甲', '乙'], useCoupons: false });
  check(aoNoCoupon.totals.estimatedCouponCut === 0, '关掉券后收益必须为 0');
  check(aoNoCoupon.members.every(m => !m.coupon), '关掉券后不应分到券');
  // 归属：把第一道菜全划给甲
  const owners = ap[0].items.map((i, idx) => idx === 0 ? [0] : null);
  const aoOwn = await S.assignOrders(ap[0].planId, { members: ['甲', '乙'], owners: owners, useCoupons: false });
  check(aoOwn.members[0].subtotal > aoOwn.members[1].subtotal, '划给甲的菜应让甲的小计更高');
  console.log(`   归属测试：甲 ¥${aoOwn.members[0].subtotal} / 乙 ¥${aoOwn.members[1].subtotal}`);
  try { await S.assignOrders('plan-x-999', {}); check(false, '未知 planId 应报错'); }
  catch (e) { check(e.code === 'NO_PLAN', 'assignOrders 未知 planId 错误码'); }

  /* ---- 14. 本轮新增：堂食/外送 · 点餐模式 · 特色模式 · 套餐拆开 · 券账本 ---- */
  console.log('14. 用餐方式/点餐模式/特色模式/套餐拆开/券账本');
  // parseQuery 新字段
  const qd = S.parseQuerySync('外送到学校，3个人，100块', D.dishes);
  check(qd.dining === 'delivery' && qd.sources.dining === 'text', '文本说外送 → dining=delivery');
  check(qd.orderMode === 'split' && qd.sources.orderMode === 'default', '没说点餐模式 → 默认各自点');
  const qt = S.parseQuerySync('堂食，各点各的', D.dishes);
  check(qt.dining === 'dineIn' && qt.orderMode === 'split', '堂食 + 各点各的都能识别');
  const qTg = S.parseQuerySync('我请客，帮大家点', D.dishes);
  check(qTg.orderMode === 'together', '「帮大家点」→ 一人点完所有人');
  const qMode = S.parseQuerySync('哥有钱就喜欢单点，宵夜模式', D.dishes);
  check(qMode.modes.singlesOnly === true && qMode.modes.lateNight === true, '两个特色模式都能解析');
  check(S.parseQuerySync('3个人100块', D.dishes).modes.singlesOnly === false, '特色模式不误报');
  // 控件值 + 冲突检测
  const qCtrl = S.parseQuerySync({ text: '3个人', people: 3, dining: 'dineIn', orderMode: 'together' }, D.dishes);
  check(qCtrl.dining === 'dineIn' && qCtrl.sources.dining === 'control', '控件选堂食生效');
  check(qCtrl.orderMode === 'together' && qCtrl.sources.orderMode === 'control', '控件选合单生效');
  const qConflict = S.parseQuerySync({ text: '外送，各点各的', dining: 'dineIn', orderMode: 'together' }, D.dishes);
  check(qConflict.dining === 'delivery', '冲突时文本赢（外送 vs 堂食）');
  check(qConflict.conflicts.some(c => c.field === 'dining'), '堂食/外送冲突要进 conflicts');
  check(qConflict.conflicts.some(c => c.field === 'orderMode'), '点餐模式冲突要进 conflicts');
  check(qConflict.resolved && qConflict.resolved.dining === 'delivery', 'resolved 给实际生效值');
  // 菜品级排除：与忌口是两件事
  const coke = D.dishes.filter(d => d.ok === true && d.name === '可乐')[0];
  const qEx = S.parseQuerySync('2个人，不要可乐', D.dishes);
  check(qEx.exclude.indexOf(coke.code) >= 0, '「不要可乐」应进 exclude（菜品级）');
  check(qEx.avoid.length === 0, '「不要可乐」不是忌口');
  // 套餐拆开：形态①只要几样 + 形态②整份拆开
  // 选一个「整个名字都能被解析正则认出 + 至少两个子项对得上真实菜品」的套餐
  const splitCombo = D.dishes.filter(d => d.role === 'combo' && d.parts && d.parts.length &&
    /^[\u4e00-\u9fa5A-Za-z0-9]{2,12}?(?:套餐|组合|桶|分享餐|双人餐|多人餐)$/.test(d.name) &&
    d.parts.filter(p => D.dishes.some(x => x.code === p.code)).length >= 2)[0];
  if (splitCombo) {
    const partNames = splitCombo.parts
      .map(p => (D.dishes.filter(d => d.code === p.code)[0] || {}).name)
      .filter(n => n && /^[\u4e00-\u9fa5A-Za-z0-9]+$/.test(n));
    const qWhole = S.parseQuerySync('把' + splitCombo.name + '拆开单点', D.dishes);
    check(qWhole.exclude.indexOf(splitCombo.code) >= 0, '整份拆开：原套餐应被排除');
    check(partNames.every(n => qWhole.wanted.indexOf(n) >= 0), '整份拆开：子项应全部进 wanted');
    check(Object.keys(qWhole.wantedMeta).length >= partNames.length, '整份拆开：子项都带 fromCombo 标记');
    const qPart = S.parseQuerySync(splitCombo.name + '里只要' + partNames[0] + '和' + partNames[1], D.dishes);
    check(qPart.exclude.indexOf(splitCombo.code) >= 0, '点套餐部分子项：父套餐应排除');
    check(qPart.wanted.indexOf(partNames[0]) >= 0 && qPart.wanted.indexOf(partNames[1]) >= 0, '只要 A、B：两项进 wanted');
    check(qPart.wanted.length === 2, '只要 A、B：不多带其他子项');
    check((qPart.wantedMeta[partNames[0]] || {}).fromCombo === splitCombo.name, '子项应标记从哪个套餐拆出');
    console.log(`   套餐拆开：「${splitCombo.name}」→ 只要 ${partNames[0]}+${partNames[1]}（父套餐已排除，按单点计入）`);
    // 拆开后的子项要真的进方案，且文案说明不享受组合价
    const rpSplit = await S.recommendPlans('2个人，120块，' + splitCombo.name + '里只要' + partNames[0] + '和' + partNames[1]);
    const hasPart = rpSplit[0].items.some(i => i.name === partNames[0]);
    check(hasPart, '拆出的子项应出现在方案里');
    check(rpSplit[0].items.every(i => i.name !== splitCombo.name), '父套餐不应再以整份出现');
    check((rpSplit[0].why || '').indexOf('按单点计入') >= 0, '方案文案应说明子项按单点计入');
  } else { check(false, '数据里应至少有一个可拆的套餐（名字以套餐/双人餐等结尾且子项可解析）'); }
  // 子项偏好：文本解析 → resolved 回填 + 面板回传优先 + 忌口守卫
  const qPref = S.parseQuerySync('2个人，100块，我想要安格斯厚牛堡，不要薯条和可乐', D.dishes);
  check(qPref.itemPrefs.some(p => p.pref === 'want' && /安格斯厚牛堡/.test(p.name)), '文本子项偏好：want 应解析出来');
  check(qPref.itemPrefs.some(p => p.pref === 'avoid' && p.name === '薯条'), '文本子项偏好：avoid 应解析出来');
  check(qPref.itemPrefs.every(p => p.source === 'text'), '纯文本解析的偏好 source=text');
  check(qPref.sources.itemPrefs === 'text', 'sources.itemPrefs=text');
  check(qPref.resolved.itemPrefs.length === qPref.itemPrefs.length, 'resolved.itemPrefs 应回传全部偏好（UI 勾选面板回填）');
  check(qPref.resolved.itemPrefs.every(p => p.mention), 'resolved 偏好带 mention（回填时显示用户原话）');
  // 面板与文本冲突：按面板走，但必须留 conflict 记录（不静默覆盖）
  const fries = D.dishes.filter(d => d.ok === true && d.name === '薯条')[0];
  const qPanel = S.parseQuerySync({ text: '2个人，100块，不要薯条', itemPrefs: [{ name: '薯条', mention: '薯条', code: fries.code, pref: 'want' }] }, D.dishes);
  check(qPanel.itemPrefs.length === 1 && qPanel.itemPrefs[0].pref === 'want', '面板回传优先：同名子项以控件为准');
  check(qPanel.sources.itemPrefs === 'merged', '文本+面板都有时 sources.itemPrefs=merged');
  check(qPanel.conflicts.some(c => c.field === 'itemPrefs' && c.control), '面板覆盖文本偏好必须留 conflict 记录');
  // 忌口守卫：「不要辣」是忌口，不进子项偏好（两套逻辑不重复记）
  const qAvoid = S.parseQuerySync('不要辣，想吃巨无霸', D.dishes);
  check(qAvoid.avoid.indexOf('辣') >= 0, '「不要辣」应进忌口');
  check(qAvoid.itemPrefs.every(p => p.name !== '辣'), '忌口别名不得混进子项偏好');
  console.log(`   子项偏好：文本 ${qPref.itemPrefs.length} 条 → resolved 回填；面板覆盖留 conflict`);
  // 方案层：新模式标记 + 候选池过滤
  const rpSingle = await S.recommendPlans('2个人，80块，哥有钱就喜欢单点');
  check(rpSingle[0].modes && rpSingle[0].modes.singlesOnly === true, '方案应带 singlesOnly 标记');
  check(rpSingle[0].items.every(i => i.role !== 'combo' && !/(套餐|组合|桶|分享餐|件套)/.test(i.name)),
    '单点畅吃方案不应含任何套餐/套装');
  const rpLate = await S.recommendPlans('1个人，50块，宵夜模式');
  check(rpLate[0].modes && rpLate[0].modes.lateNight === true, '方案应带 lateNight 标记');
  const rpDining = await S.recommendPlans('2个人，100块，外送');
  check(rpDining[0].dining === 'delivery' && (rpDining[0].diningLabel || '').indexOf('外送') >= 0, '方案应带 dining 与中文标签');
  check(rpDining[0].orderMode === 'split', '方案应带 orderMode（默认各自点）');
  // 混合方案契约：itemPrefs / sourceType / mixSummary / tradeoffExplanation / comboCompare / weights
  const rpPref = await S.recommendPlans('2个人，100块，我想要安格斯厚牛堡，不要薯条和可乐');
  check(rpPref[0].itemPrefs && rpPref[0].itemPrefs.length >= 2, '方案应带 itemPrefs（UI 勾选面板初始化用）');
  check(rpPref[0].items.every(i => ['combo', 'single', 'comboPart'].indexOf(i.sourceType) >= 0),
    '每个 item 必须带合法 sourceType（套餐/单点/套餐子项转单点）');
  check(rpPref[0].mixSummary && typeof rpPref[0].mixSummary.text === 'string', '有子项偏好时方案应带 mixSummary.text');
  check((rpPref[0].tradeoffExplanation || []).some(s => s.indexOf('不支持套餐改配') >= 0),
    'tradeoffExplanation 必须写明官方不支持套餐改配（边界诚实）');
  check(rpPref[0].weights && typeof rpPref[0].weights.price === 'number', '方案应带四维权衡 weights');
  check(rpPref[0].comboCompare == null || Array.isArray(rpPref[0].comboCompare), 'comboCompare 要么是数组要么 null');
  // 无子项偏好时对比字段为 null（不给普通方案硬编对比）
  const rpPlain = await S.recommendPlans('2个人，100块');
  check(rpPlain[0].mixSummary === null && rpPlain[0].comboCompare === null, '无子项偏好时对比字段为 null');
  // 离线快照数据必须标 simulated（四维对比是预演，不是已校验）
  check(rpPref[0].simulated === true && rpPref[0].priceSource === 'snapshot', '离线数据必须标 simulated/snapshot');
  // UI 滑块权重透传
  const rpW = await S.recommendPlans({ text: '2个人，100块，不要薯条', weights: { price: 3, kcal: 1, protein: 1, taste: 0.2 } });
  check(rpW[0].weights && rpW[0].weights.price === 3, 'UI 滑块权重应透传到方案（不写死）');
  // comboPart 记账完整性：fromCombo 必有，源套餐不与拆开子项同版
  const partPlans = rpPref.filter(pl => pl.items.some(i => i.sourceType === 'comboPart'));
  if (partPlans.length) {
    check(partPlans.every(pl => pl.items.filter(i => i.sourceType === 'comboPart').every(i => i.fromCombo)),
      'comboPart 项必须带 fromCombo（从哪个套餐拆的）');
    check(partPlans.every(pl => pl.items.filter(i => i.sourceType === 'comboPart')
      .every(i => !pl.items.some(j => j.sourceType !== 'comboPart' && j.name === i.fromCombo))),
      '源套餐整份不得与自己的拆开子项同版出现');
  }
  console.log(`   混合方案：${partPlans.length}/${rpPref.length} 版含拆开子项｜` +
    `${rpPref[0].mixSummary ? rpPref[0].mixSummary.text : '无 mix'}｜simulated=${rpPref[0].simulated}`);
  // assignOrders：合单模式（一人点完所有人）
  const ap2 = await S.recommendPlans('3个人，100块');
  const tg = await S.assignOrders(ap2[0].planId, { members: ['甲', '乙', '丙'], orderMode: 'together' });
  check(tg.orderMode === 'together', '合单模式 orderMode=together');
  check(tg.members.length === 3 && tg.members.every(m => m.share === true), '合单模式成员为人均份额');
  const sumShare = tg.members.reduce((s, m) => s + m.payAfterCoupon, 0);
  check(Math.abs(sumShare - tg.totals.splitPayEstimate) < 0.005, `合单模式 Σ人均 === 全单应付（${sumShare} vs ${tg.totals.splitPayEstimate}）`);
  check(tg.combined.actual === true, '合单模式 combined 即实际结果');
  check(tg.notes.some(n => n.indexOf('一人点完所有人') >= 0), '合单模式必须说明这是一张合单');
  check(tg.comparison.verdict.indexOf('省事模式') === 0, '合单模式结论应点明「省事模式」');
  console.log(`   合单：${tg.comparison.verdict}`);
  // dining 透传与 notes
  const tgD = await S.assignOrders(ap2[0].planId, { members: ['甲', '乙'], orderMode: 'together', dining: 'delivery' });
  check(tgD.dining === 'delivery' && tgD.notes.some(n => n.indexOf('orderType=2') >= 0), '外送合单 note 应提 orderType=2');
  const tgI = await S.assignOrders(ap2[0].planId, { members: ['甲', '乙'], orderMode: 'together', dining: 'dineIn' });
  check(tgI.notes.some(n => n.indexOf('orderType=1') >= 0), '堂食合单 note 应提 orderType=1');
  // couponLedger：券账本
  const couponTotal = (D.coupons || []).filter(c => c && c.title && c.title.indexOf('###') !== 0).length;
  const lg = await S.couponLedger(ap2[0].planId, { members: ['甲', '乙', '丙'], useCoupons: true });
  check(lg.ledger.rows.length === couponTotal, `账本应覆盖每一张券（${couponTotal}）`);
  check(lg.ledger.rows.every(r => ['used', 'skipped', 'unavailable', 'no-benefit', 'off'].indexOf(r.status) >= 0), '每行必须有合法状态');
  check(lg.ledger.rows.every(r => r.type && r.typeLabel), '每行必须带券类型与中文标签');
  check(lg.ledger.stats.used === lg.ledger.rows.filter(r => r.status === 'used').length, 'stats.used 与行数据一致');
  check(lg.ledger.stats.total === couponTotal, 'stats.total 与券数一致');
  check(lg.ledger.stats.estimatedCutTotal === lg.ledger.rows.filter(r => r.status === 'used').reduce((s, r) => s + r.estimatedCut, 0),
    'stats.estimatedCutTotal 只累计已用的券');
  check(lg.ledger.notes.some(n => n.indexOf('query-store-coupons') >= 0), '账本必须说明堂食/外送判断依据与官方真源的差距');
  check(lg.ledger.notes.some(n => n.indexOf('available-coupons') >= 0), '账本必须说明券收益为何只是估算');
  const lgOff = await S.couponLedger(ap2[0].planId, { members: ['甲', '乙'], useCoupons: false });
  check(lgOff.ledger.rows.every(r => r.status === 'off'), '关掉用券后账本全部标 off');
  try { await S.couponLedger('plan-x-999', {}); check(false, 'couponLedger 未知 planId 应报错'); }
  catch (e) { check(e.code === 'NO_PLAN', 'couponLedger 未知 planId 错误码'); }
  console.log(`   券账本：${lg.ledger.rows.map(r => `${r.title}[${r.typeLabel}/${r.status}/¥${r.estimatedCut}]`).join(' | ')}`);

  console.log('='.repeat(78));
  console.log(fail === 0 ? `全部通过 ✓（${pass} 项断言）` : `失败 ${fail} 项 / 通过 ${pass} 项`);
  process.exit(fail === 0 ? 0 : 1);
})();
