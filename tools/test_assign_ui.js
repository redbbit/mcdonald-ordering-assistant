/* 回归测试：验证 renderAssignResult 在 split / together / 无券账本 三种形状下不抛错、产出关键 DOM 文本。
 * 用法：node tools/test_assign_ui.js */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

/* 提取 renderAssignResult 函数体（花括号配对） */
var start = src.indexOf('function renderAssignResult(ao) {');
if (start < 0) { console.error('FAIL: renderAssignResult not found'); process.exit(1); }
var i = src.indexOf('{', start), depth = 0, end = -1;
for (var j = i; j < src.length; j++) {
  if (src[j] === '{') depth++;
  else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
}
if (end < 0) { console.error('FAIL: unbalanced braces'); process.exit(1); }
var fnSrc = src.slice(start, end);

/* DOM 桩：任何 getElementById 都返回一个可记录 innerHTML 的元素 */
var captured = {};
function stubEl(id) {
  return {
    id: id, innerHTML: '', textContent: '', hidden: false, disabled: false, value: '', checked: false,
    classList: { add: function () {}, remove: function () {}, toggle: function () {} },
    set innerHTML(v) { captured[id] = v; }, get innerHTML() { return captured[id] || ''; }
  };
}

var sandbox = {
  console: console,
  document: { getElementById: stubEl, querySelectorAll: function () { return []; }, addEventListener: function () {}, createElement: function () { return stubEl('_tmp'); } },
  window: { clearTimeout: function () {}, setTimeout: function () { return 0; } },
  $: function (id) { return stubEl(id); },
  esc: function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); },
  money: function (v) { return v == null || !isFinite(Number(v)) ? '—' : '¥' + Number(v).toFixed(2).replace(/\.00$/, ''); },
  showToast: function () {},
  state: { coupons: [], activeCoupon: null }
};
vm.createContext(sandbox);
vm.runInContext(fnSrc + '\nthis.renderAssignResult = renderAssignResult;', sandbox);

var cases = {
  /* split 模式：经典形状 */
  split: {
    orderMode: 'split', dining: 'dineIn',
    totals: { splitSubtotal: 89.5, estimatedCouponCut: 12, splitDeliveryFees: null, splitPayEstimate: 77.5 },
    combined: { total: 89.5, coupon: { title: '满 70 减 12 券', estimatedCut: 12 }, payEstimate: 77.5 },
    comparison: { verdict: '拆单各用券，估算省 ¥12' },
    members: [
      { index: 0, name: '小红', subtotal: 45, coupon: { title: '满 40 减 8 券', estimatedCut: 8 }, payAfterCoupon: 37, real: null },
      { index: 1, name: '小明', subtotal: 44.5, coupon: null, payAfterCoupon: 44.5, real: { price: 44.5, deliveryPrice: null } }
    ],
    notes: ['测试备注'],
    ledger: {
      rows: [
        { title: '满 40 减 8 券', type: 'threshold', typeLabel: '满减券', applicable: true, reason: '', estimatedCut: 8, usedBy: '小红', status: 'used' },
        { title: '满 70 减 12 券', type: 'threshold', typeLabel: '满减券', applicable: true, reason: '', estimatedCut: 12, usedBy: null, status: 'skipped' },
        { title: '外送专享券', type: 'delivery', typeLabel: '外送券', applicable: false, reason: '堂食单不适用', estimatedCut: 0, usedBy: null, status: 'unavailable' },
        { title: '未标注券', type: 'unlabeled', typeLabel: '未标注', applicable: true, reason: '', estimatedCut: 0, usedBy: null, status: 'no-benefit' }
      ],
      stats: { total: 4, applicable: 3, used: 1, skipped: 1, unavailable: 1, noBenefit: 1, estimatedCutTotal: 8, byMember: [{ member: '小红', estimatedCut: 8 }] },
      notes: ['账本备注：query-store-coupons 未调用']
    }
  },
  /* together 模式：人均份额 + 全单一张券 */
  together: {
    orderMode: 'together', dining: 'delivery',
    totals: { splitSubtotal: 89.5, estimatedCouponCut: 12, splitDeliveryFees: 9, splitPayEstimate: 86.5, splitRealTotal: 86.5 },
    combined: { total: 89.5, coupon: { title: '满 70 减 12 券', estimatedCut: 12 }, payEstimate: 86.5 },
    comparison: { verdict: '省事模式：一人点完所有人，全单一张券，人均 ¥28.83~¥28.84' },
    members: [
      { index: 0, name: '小红', subtotal: 28.83, payAfterCoupon: 28.83, share: true },
      { index: 1, name: '小明', subtotal: 28.84, payAfterCoupon: 28.84, share: true }
    ],
    notes: ['外送备注'],
    ledger: {
      rows: [
        { title: '满 70 减 12 券', type: 'threshold', typeLabel: '满减券', applicable: true, reason: '', estimatedCut: 12, usedBy: '合单', status: 'used' }
      ],
      stats: { total: 1, applicable: 1, used: 1, skipped: 0, unavailable: 0, noBenefit: 0, estimatedCutTotal: 12, byMember: [{ member: '合单', estimatedCut: 12 }] },
      notes: []
    }
  },
  /* 无账本（旧形状 / couponLedger 之外）不应崩 */
  bare: {
    totals: { splitSubtotal: 50, estimatedCouponCut: 0, splitPayEstimate: 50 },
    combined: { coupon: null, payEstimate: 50 },
    comparison: {},
    members: [{ index: 0, name: '小红', subtotal: 50, coupon: null, payAfterCoupon: 50 }],
    notes: []
  }
};

var failures = 0;
Object.keys(cases).forEach(function (name) {
  try {
    captured = {};
    sandbox.renderAssignResult(cases[name]);
    var html = captured['assignResult'] || '';
    var checks = [];
    if (name === 'split') {
      checks.push([html.indexOf('拆单小计合计') >= 0, 'split 统计卡标签']);
      checks.push([html.indexOf('券账本') >= 0, '券账本标题']);
      checks.push([html.indexOf('已用') >= 0 && html.indexOf('未排上') >= 0 && html.indexOf('不适用') >= 0 && html.indexOf('无收益') >= 0, '四种账本状态']);
      checks.push([html.indexOf('query-store-coupons 未调用') >= 0, '账本备注合并']);
      checks.push([html.indexOf('¥77.5') >= 0 || html.indexOf('¥77.50') >= 0, '合单估付金额']);
      checks.push([html.indexOf('小红') >= 0 && html.indexOf('MCP 实算') >= 0, '成员卡 + MCP 实算']);
    } else if (name === 'together') {
      checks.push([html.indexOf('整单小计') >= 0, 'together 统计卡标签']);
      checks.push([html.indexOf('人均') >= 0, '人均卡']);
      checks.push([html.indexOf('全单一张券（见下方）') >= 0, '合单券提示']);
      checks.push([html.indexOf('人均估付') >= 0 && html.indexOf('¥28.83') >= 0, '人均区间']);
      checks.push([html.indexOf('合单') >= 0, '账本 usedBy 合单']);
    } else {
      checks.push([html.indexOf('两条路子估算打平') >= 0, '裸形状 verdict 兜底']);
      checks.push([html.indexOf('assign-ledger') < 0, '无账本不渲染账本区']);
    }
    checks.forEach(function (c) {
      if (!c[0]) { failures++; console.error('FAIL [' + name + '] ' + c[1]); }
    });
    console.log((failures ? 'FAIL ' : 'PASS ') + name + ' (' + checks.length + ' checks)');
  } catch (e) {
    failures++;
    console.error('FAIL [' + name + '] threw: ' + e.message);
  }
});
console.log(failures ? failures + ' FAILURES' : 'ALL SMOKE CHECKS PASSED');

/* ================= 第 8/9 轮方案卡渲染回归（renderPlan / comboComparePanel） ================= */
/* 提取 renderPlan + comboComparePanel 函数体（花括号配对，两个函数分别提取） */
function extractFn(name) {
  var start = src.indexOf('function ' + name + '(');
  if (start < 0) { console.error('FAIL: ' + name + ' not found'); process.exit(1); }
  var i = src.indexOf('{', start), depth = 0, end = -1;
  for (var j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return src.slice(start, end);
}
var planSandbox = {
  console: console,
  document: { getElementById: stubEl, querySelectorAll: function () { return []; }, addEventListener: function () {}, createElement: function () { return stubEl('_tmp'); } },
  window: { clearTimeout: function () {}, setTimeout: function () { return 0; } },
  esc: function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); },
  money: function (v) { return v == null || !isFinite(Number(v)) ? '—' : '¥' + Number(v).toFixed(2).replace(/\.00$/, ''); },
  num: function (v, d) { return v == null || !isFinite(Number(v)) ? '—' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: d == null ? 1 : d }); },
  attr: function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); },
  buildTag: function (text, kind) { return '<span class="plan-label ' + (kind || '') + '">' + text + '</span>'; },
  imageMarkup: function () { return '<span class="img-stub"></span>'; },
  roleLabel: function () { return '主食'; },
  state: { plans: [], availability: {}, mode: 'offline' }
};
vm.createContext(planSandbox);
vm.runInContext(extractFn('renderPlan') + '\n' + extractFn('comboComparePanel') + '\nthis.renderPlan = renderPlan; this.comboComparePanel = comboComparePanel;', planSandbox);

var planFailures = 0, planChecks = 0;
function planCheck(cond, msg) { planChecks++; if (!cond) { planFailures++; console.error('FAIL [plan] ' + msg); } }
var basePlan = {
  planId: 'plan-budget-1', tier: 'budget', title: '省钱聚餐', subtitle: '2 人 · 4 款',
  why: '按预算搭的', people: 2, itemCount: 4, items: [
    { name: '麦香鸡套餐', quantity: 1, productCode: 'a1', sourceType: 'combo', fromCombo: null, combo: { comboPrice: 26.9, partsTotal: 37.9, save: 11, partsKnown: 3, partsCount: 3, complete: true }, imageLocal: 'img/x.png' },
    { name: '麦香鸡', quantity: 1, productCode: 'b2', sourceType: 'comboPart', fromCombo: '麦香鸡套餐' },
    { name: '中薯条', quantity: 1, productCode: 'c3', sourceType: 'single', fromCombo: null }
  ],
  totalPrice: 40.9, originalPrice: 51.9, discount: 11, perPersonPrice: 20.45,
  simulated: true, priceSource: 'snapshot', newTags: [], promoTags: [],
  mixSummary: { fullCombos: 1, singles: 1, comboParts: 1, text: '本方案含 1 个完整套餐 + 1 个单点 + 1 个套餐子项转单点' },
  tradeoffExplanation: ['「麦香鸡套餐」拆开单点：比买整份省 ¥11，少 0 kcal', '官方 MCP 不支持套餐改配'],
  comboCompare: [{
    combo: '麦香鸡套餐', comboCode: '9900016073',
    price: { combo: 26.9, parts: 15.9, delta: -11, cheaper: 'parts' },
    kcal: { combo: 800, parts: 500, delta: -300 },
    protein: { combo: 30, parts: 20, delta: -10 },
    taste: { combo: '含 1 项你不想要的子项：中薯条', parts: '全部匹配（已避开 中薯条）', winner: 'parts' },
    unresolvedParts: ['可乐中杯'], avoidedParts: ['中薯条'],
    note: '子项 可乐中杯 在菜单内没有单点价'
  }],
  weights: { price: 1, kcal: 1, protein: 1, taste: 1.6 },
  maxCal: 800, withinMaxCal: false,
  singlesOnly: false, lateNight: false
};
try {
  var html = planSandbox.renderPlan(basePlan);
  planCheck(html.indexOf('src-part') >= 0, 'comboPart 角标渲染');
  planCheck(html.indexOf('拆自 麦香鸡套餐') >= 0, 'comboPart fromCombo 透出');
  planCheck(html.indexOf('src-combo') >= 0 && html.indexOf('src-single') >= 0, 'combo/single 角标渲染');
  planCheck(html.indexOf('这份是怎么搭的') >= 0 && html.indexOf('1 个完整套餐') >= 0, 'mixSummary 渲染');
  planCheck(html.indexOf('不支持套餐改配') >= 0, 'tradeoffExplanation 含不改配边界');
  planCheck(html.indexOf('看套餐对比') >= 0, 'comboCompare 按钮出现');
  planCheck(html.indexOf('data-panel="comboCompare"') >= 0, 'comboCompare 面板容器');
  planCheck(html.indexOf('上限 800 kcal') >= 0 && html.indexOf('已超标') >= 0, 'maxCal 超标提示');
  planCheck(html.indexOf('cal-over') >= 0, '超标黄牌 class');
  planCheck(html.indexOf('评分权重') >= 0 && html.indexOf('口味×1.6') >= 0, '非默认权重回显');
  planCheck(html.indexOf('套餐比单点省 ¥11') >= 0, '既有套餐省幅徽标不回归');
  var compareHtml = planSandbox.comboComparePanel(basePlan);
  planCheck(compareHtml.indexOf('麦香鸡套餐') >= 0, '对比卡标题');
  planCheck(compareHtml.indexOf('拆开省 ¥11') >= 0, '价格差方向（拆开省）');
  planCheck(compareHtml.indexOf('800 vs 500 kcal') >= 0, '热量对比');
  planCheck(compareHtml.indexOf('30 vs 20 g') >= 0, '蛋白质对比');
  planCheck(compareHtml.indexOf('买不到、未编价：可乐中杯') >= 0, 'unresolvedParts 不编价');
  planCheck(compareHtml.indexOf('官方 MCP 不支持套餐改配') >= 0, '对比面板底部边界文案');
  console.log('PASS renderPlan-rich (' + planChecks + ' checks)');
} catch (e) { planFailures++; console.error('FAIL [plan] rich threw: ' + e.message); }

try {
  /* 普通方案：无 mixSummary/comboCompare/maxCal/权重默认 → 一律不渲染，不硬编 */
  var plain = JSON.parse(JSON.stringify(basePlan));
  plain.mixSummary = null; plain.tradeoffExplanation = null; plain.comboCompare = null;
  plain.maxCal = null; plain.weights = { price: 1, kcal: 1, protein: 1, taste: 1 };
  var plainHtml = planSandbox.renderPlan(plain);
  planCheck(plainHtml.indexOf('mix-summary') < 0, '普通方案不渲染 mix 区块');
  planCheck(plainHtml.indexOf('看套餐对比') < 0, '普通方案无对比按钮');
  planCheck(plainHtml.indexOf('cal-cap') < 0, '无 maxCal 不渲染上限徽标');
  planCheck(plainHtml.indexOf('weights-pill') < 0, '默认权重不回显');
  planCheck(plainHtml.indexOf('全单点模式') < 0, '非 singlesOnly 不渲染模式标签');
  /* singlesOnly 模式标签 */
  var single = JSON.parse(JSON.stringify(plain));
  single.singlesOnly = true;
  planCheck(planSandbox.renderPlan(single).indexOf('全单点模式') >= 0, 'singlesOnly 模式标签');
  /* 官方无数据的维度：null 不是 0 */
  var noData = JSON.parse(JSON.stringify(basePlan));
  noData.comboCompare = [{ combo: '测试套餐', price: { combo: 20, parts: 20, delta: 0, cheaper: 'combo' }, kcal: null, protein: null, taste: null }];
  var noDataHtml = planSandbox.comboComparePanel(noData);
  planCheck(noDataHtml.indexOf('官方未提供，未估算') >= 0, '无数据维度显示未提供');
  planCheck(noDataHtml.indexOf('价格一样') >= 0, 'delta=0 文案');
  console.log('PASS renderPlan-plain (累计 ' + planChecks + ' checks)');
} catch (e) { planFailures++; console.error('FAIL [plan] plain threw: ' + e.message); }
console.log(planFailures ? planFailures + ' PLAN FAILURES' : 'ALL PLAN CHECKS PASSED');
if (failures || planFailures) process.exit(1);
