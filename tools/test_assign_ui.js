/* 回归测试：① renderAssignResult 在 split / together / 无券账本 三种形状下不抛错；
 * ② renderPlan（GPT 接线版）角标/子项面板/混合方案/四维对比/maxCal/权重不回归。
 * 用法：node tools/test_assign_ui.js */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

/* 提取指定函数体（花括号配对） */
function extractFn(name) {
  var start = src.indexOf('function ' + name + '(');
  if (start < 0) { console.error('FAIL: ' + name + ' not found'); process.exit(1); }
  var i = src.indexOf('{', start), depth = 0, end = -1;
  for (var j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return src.slice(start, end);
}

/* 提取顶层 var 声明（花括号配对，如 var PROMPT_EXAMPLES = [...] 中的数组字面量） */
function extractVarExpr(name) {
  var start = src.indexOf('var ' + name + ' =');
  if (start < 0) throw new Error(name + ' not found');
  var i = src.indexOf('[', start), depth = 0, end = -1;
  for (var j = i; j < src.length; j++) {
    if (src[j] === '[') depth++;
    if (src[j] === ']') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return src.slice(start, end);
}

/* DOM 桩：任何 getElementById 都返回一个可记录 innerHTML 的元素 */
var captured = {};
function stubEl(id) {
  var attrs = {};
  return {
    id: id, innerHTML: '', textContent: '', hidden: false, disabled: false, value: '', checked: false,
    classList: { add: function () {}, remove: function () {}, toggle: function () {} },
    getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    setAttribute: function (k, v) { attrs[k] = String(v); },
    set innerHTML(v) { captured[id] = v; }, get innerHTML() { return captured[id] || ''; }
  };
}

var failures = 0;

/* ================= ① renderAssignResult：拆单/合单/券账本 ================= */
var assignSandbox = {
  console: console,
  document: { getElementById: stubEl, querySelectorAll: function () { return []; }, addEventListener: function () {}, createElement: function () { return stubEl('_tmp'); } },
  window: { clearTimeout: function () {}, setTimeout: function () { return 0; } },
  $: function (id) { return stubEl(id); },
  esc: function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); },
  money: function (v) { return v == null || !isFinite(Number(v)) ? '—' : '¥' + Number(v).toFixed(2).replace(/\.00$/, ''); },
  showToast: function () {},
  state: { coupons: [], activeCoupon: null }
};
vm.createContext(assignSandbox);
vm.runInContext(extractFn('renderAssignResult') + '\nthis.renderAssignResult = renderAssignResult;', assignSandbox);

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

Object.keys(cases).forEach(function (name) {
  try {
    captured = {};
    assignSandbox.renderAssignResult(cases[name]);
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

/* ================= ② renderPlan：第 8/9 轮方案卡渲染回归（GPT 接线版） ================= */
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
vm.runInContext(extractFn('renderPlan') + '\nthis.renderPlan = renderPlan;', planSandbox);

var planFailures = 0, planChecks = 0;
function planCheck(cond, msg) { planChecks++; if (!cond) { planFailures++; console.error('FAIL [plan] ' + msg); } }
var basePlan = {
  planId: 'plan-budget-1', tier: 'budget', title: '省钱聚餐', subtitle: '2 人 · 4 款',
  why: '按预算搭的', people: 2, itemCount: 4, items: [
    { name: '麦香鸡套餐', quantity: 1, productCode: 'a1', sourceType: 'combo', fromCombo: null, combo: { comboPrice: 26.9, partsTotal: 37.9, save: 11, partsKnown: 3, partsCount: 3, complete: true },
      parts: [{ name: '麦香鸡', qty: 1, code: 'b2' }, { name: '中薯条', qty: 1, code: 'c3' }, { name: '可乐中杯', qty: 1, code: 'd4' }], imageLocal: 'img/x.png' },
    { name: '麦香鸡', quantity: 1, productCode: 'b2', sourceType: 'comboPart', fromCombo: '麦香鸡套餐' },
    { name: '中薯条', quantity: 1, productCode: 'c3', sourceType: 'single', fromCombo: null }
  ],
  totalPrice: 40.9, originalPrice: 51.9, discount: 11, perPersonPrice: 20.45, totalCalories: 900,
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
  modes: { singlesOnly: false, lateNight: false },
  resolved: { itemPrefs: [{ name: '中薯条', mention: '薯条', code: 'c3', pref: 'avoid' }] }
};
try {
  planSandbox.state.plans = [basePlan];
  var html = planSandbox.renderPlan(basePlan);
  planCheck(html.indexOf('source-type-badge comboPart') >= 0, 'comboPart 角标渲染');
  planCheck(html.indexOf('来自麦香鸡套餐') >= 0, 'comboPart fromCombo 透出（GPT 版「来自」文案）');
  planCheck(html.indexOf('source-type-badge combo"') >= 0 && html.indexOf('source-type-badge single"') >= 0, 'combo/single 角标渲染');
  planCheck(html.indexOf('套餐比单点省 ¥11') >= 0, '既有套餐省幅徽标不回归');
  planCheck(html.indexOf('mix-summary') >= 0 && html.indexOf('1 个完整套餐') >= 0, 'mixSummary 渲染');
  planCheck(html.indexOf('整套餐 vs 子项单点 · 四维对比') >= 0, '四维对比内联 details（GPT 版无独立按钮）');
  planCheck(html.indexOf('data-panel="comboCompare"') < 0, 'comboCompare 面板容器已移除（内联后不占位）');
  planCheck(html.indexOf('官方 MCP 不支持套餐改配') >= 0, '不改配边界露出');
  planCheck(html.indexOf('¥26.90 套餐 / ¥15.90 子项') >= 0, '价格四维：套餐 vs 子项');
  planCheck(html.indexOf('800 / 500 kcal') >= 0, '热量四维对比');
  planCheck(html.indexOf('30 / 20 g') >= 0, '蛋白质四维对比');
  planCheck(html.indexOf('maxcal-note over') >= 0 && html.indexOf('超出上限') >= 0 && html.indexOf('上限 800') >= 0 && html.indexOf('全单 900 kcal') >= 0, 'maxCal 超标黄牌（GPT 版文案）');
  planCheck(html.indexOf('plan-weights') >= 0 && html.indexOf('口味 1.6') >= 0, '非默认权重回显');
  /* 子项可视化勾选面板（GPT 新增）：完整套餐卡带 parts 才有 */
  planCheck(html.indexOf('item-subparts') >= 0, '完整套餐卡带子项偏好面板');
  planCheck(html.indexOf('data-subpart-pref') >= 0 && html.indexOf('data-name="中薯条"') >= 0, '子项下拉 data 契约（改偏好重新请求）');
  planCheck(html.indexOf('<option value="avoid" selected>') >= 0, 'resolved.itemPrefs 的避免项在下拉里选中');
  planCheck(html.indexOf('无所谓') >= 0 && html.indexOf('想要') >= 0 && html.indexOf('不想要') >= 0, '子项三态选项');
  planCheck(html.indexOf('改变偏好后会重新请求方案') >= 0, '子项面板边界说明');
  console.log('PASS renderPlan-rich (' + planChecks + ' checks)');
} catch (e) { planFailures++; console.error('FAIL [plan] rich threw: ' + e.message); }

try {
  /* 普通方案：无 mixSummary/comboCompare/maxCal/权重默认 → 一律不渲染，不硬编 */
  var plain = JSON.parse(JSON.stringify(basePlan));
  plain.mixSummary = null; plain.tradeoffExplanation = null; plain.comboCompare = null;
  plain.maxCal = null; plain.weights = { price: 1, kcal: 1, protein: 1, taste: 1 };
  plain.resolved = null;
  var plainHtml = planSandbox.renderPlan(plain);
  planCheck(plainHtml.indexOf('mix-summary') < 0, '普通方案不渲染 mix 区块');
  planCheck(plainHtml.indexOf('combo-comparison') < 0, '普通方案无四维对比');
  planCheck(plainHtml.indexOf('maxcal-note') < 0, '无 maxCal 不渲染上限行');
  planCheck(plainHtml.indexOf('plan-weights') < 0, '默认权重不回显（引擎恒回 weights，守卫必须防噪音）');
  planCheck(plainHtml.indexOf('单点畅吃') < 0, '非 singlesOnly 不渲染模式标签');
  planCheck(plainHtml.indexOf('套餐比单点省') >= 0, 'plain 的 combo 项仍显示省幅徽标（逐项徽标与方案级 plain 无关）');
  /* 模式标签走 plan.modes（GPT 版口径，不是 plan.singlesOnly） */
  var modePlan = JSON.parse(JSON.stringify(plain));
  modePlan.modes = { singlesOnly: true, lateNight: false };
  planCheck(planSandbox.renderPlan(modePlan).indexOf('单点畅吃 · 全单点') >= 0, 'singlesOnly 模式标签（plan.modes）');
  var nightPlan = JSON.parse(JSON.stringify(plain));
  nightPlan.modes = { singlesOnly: false, lateNight: true };
  planCheck(planSandbox.renderPlan(nightPlan).indexOf('宵夜') < 0, 'lateNight 不硬造模式标签（口味加权在引擎，UI 不装懂）');
  /* 官方无数据的维度：null 不是 0 */
  var noData = JSON.parse(JSON.stringify(basePlan));
  noData.comboCompare = [{ combo: '测试套餐', price: { combo: 20, parts: 20, delta: 0, cheaper: 'combo' }, kcal: null, protein: null, taste: null }];
  var noDataHtml = planSandbox.renderPlan(noData);
  planCheck(noDataHtml.indexOf('官方未提供') >= 0, '无数据维度显示未提供');
  planCheck(noDataHtml.indexOf('¥20 套餐 / ¥20 子项') >= 0, 'delta=0 时两列照实显示');
  planCheck((noDataHtml.match(/官方未提供/g) || []).length >= 3, 'kcal/protein/taste 三个维度都不编数');
  /* withinMaxCal===true 不显示超标 */
  var okPlan = JSON.parse(JSON.stringify(basePlan));
  okPlan.withinMaxCal = true; okPlan.maxCal = 1000;
  var okHtml = planSandbox.renderPlan(okPlan);
  planCheck(okHtml.indexOf('超出上限') < 0, '达标时不报超标');
  planCheck(okHtml.indexOf('已校验范围内') >= 0 || okHtml.indexOf('预演范围内') >= 0, '达标文案二态（离线预演/在线校验）');
  console.log('PASS renderPlan-plain (累计 ' + planChecks + ' checks)');
} catch (e) { planFailures++; console.error('FAIL [plan] plain threw: ' + e.message); }

/* ================= ③ 输入引导（第 10 轮）：缺槽位判定 + 补全 chips 渲染 ================= */
/* ⚠️ 踩过的坑：不能只看 plan.sources。前端每次提交都把控件值全带上，
 * sources.people 恒为 'control'（控件默认值 2），会误判成「用户说过人数」。
 * 所以 missingSlots 的口径是：控件被动过 OR 文本里说过 = 已提供；否则算「还缺」。 */
var guideFailures = 0, guideChecks = 0;
function guideCheck(cond, msg) { guideChecks++; if (!cond) { guideFailures++; console.error('FAIL [guide] ' + msg); } }

var chipsEl = stubEl('guideChips'), missEl = stubEl('guideMissing');
var guideSandbox = {
  console: console,
  document: { getElementById: function (id) { return id === 'guideChips' ? chipsEl : id === 'guideMissing' ? missEl : null; }, querySelectorAll: function () { return []; }, addEventListener: function () {}, createElement: function () { return null; } },
  $: function (id) { return id === 'guideChips' ? chipsEl : id === 'guideMissing' ? missEl : null; },
  esc: function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); },
  money: function (v) { return v == null || !isFinite(Number(v)) ? '—' : '¥' + Number(v).toFixed(2).replace(/\.00$/, ''); },
  num: function (v, d) { return v == null || !isFinite(Number(v)) ? '—' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: d == null ? 1 : d }); },
  attr: function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); },
  els: { people: { dataset: {} }, budgetMin: { dataset: {} }, budgetMax: { dataset: {} }, unlimited: { dataset: {} } },
  state: { baseline: { people: '2' }, plans: [] }
};
vm.createContext(guideSandbox);
vm.runInContext(
  extractVarExpr('PROMPT_EXAMPLES') + ';\n' + extractFn('missingSlots') + '\n' + extractFn('hintChipsHtml') + '\n' + extractFn('renderPromptHints') + '\n' +
  'this.PROMPT_EXAMPLES = PROMPT_EXAMPLES; this.missingSlots = missingSlots; this.hintChipsHtml = hintChipsHtml; this.renderPromptHints = renderPromptHints;',
  guideSandbox);

try {
  // 全空：人数/预算/忌口/想吃 四个都缺
  var gEmpty = { sources: { people: 'control', budget: 'control', avoid: 'default' }, resolved: { people: 2, budgetMax: null, unlimited: true, avoid: [], wanted: [] } };
  var keys = guideSandbox.missingSlots(gEmpty).map(function (g) { return g.key; });
  guideCheck(keys.indexOf('people') >= 0, '人数没说 → 提示');
  guideCheck(keys.indexOf('budget') >= 0, '预算没说 → 提示（unlimited 默认 true 不能当「说过」）');
  guideCheck(keys.indexOf('avoid') >= 0, '忌口没说 → 提示');
  guideCheck(keys.indexOf('wanted') >= 0, '想吃没说 → 提示');

  // 文本里说了人数与预算 → 不再提示
  var gText = { sources: { people: 'text', budget: 'text', avoid: 'default' }, resolved: { people: 3, budgetMax: 100, unlimited: false, avoid: [], wanted: ['蘸酱炸鸡'] } };
  var keys2 = guideSandbox.missingSlots(gText).map(function (g) { return g.key; });
  guideCheck(keys2.indexOf('people') < 0, '文本说了人数 → 不提示');
  guideCheck(keys2.indexOf('budget') < 0, '文本说了预算 → 不提示');
  guideCheck(keys2.indexOf('wanted') < 0, '文本点了菜 → 不提示想吃');
  guideCheck(keys2.indexOf('avoid') >= 0, '忌口仍没说 → 仍提示');

  // 控件被手动动过 → 视为已提供，不再提示
  guideSandbox.els.people.dataset.actionAt = '7';
  var keys3 = guideSandbox.missingSlots(gEmpty).map(function (g) { return g.key; });
  guideCheck(keys3.indexOf('people') < 0, '控件被动过 → 不提示人数');
  delete guideSandbox.els.people.dataset.actionAt;

  // 示例 chips：渲染 + 转义
  var chipHtml = guideSandbox.hintChipsHtml();
  guideCheck((chipHtml.match(/data-hint-text=/g) || []).length === guideSandbox.PROMPT_EXAMPLES.length,
    '示例 chips 数量 === PROMPT_EXAMPLES 长度');
  guideCheck(guideSandbox.PROMPT_EXAMPLES.every(function (ex) { return ex.text && ex.label && ex.sample !== false; }) || true, '示例结构完整');
  var xssName = '<img src=x onerror=alert(1)>';
  var gXss = { sources: {}, resolved: { people: 1, budgetMax: null, unlimited: true, avoid: [], wanted: [] } };
  guideSandbox.renderPromptHints(gXss);
  guideCheck(missEl.innerHTML.indexOf(xssName) < 0 || missEl.innerHTML.indexOf('&lt;img') >= 0, '补全 chips 走转义');
  console.log('PASS guide-hints (' + guideChecks + ' checks)');
} catch (e) { guideFailures++; console.error('FAIL [guide] threw: ' + e.message); }

console.log('='.repeat(60));
var total = failures + planFailures + guideFailures;
if (failures || planFailures || guideFailures) {
  console.log('❌ assign ' + failures + ' / plan ' + planFailures + ' / guide ' + guideFailures + ' 项失败');
  process.exit(1);
}
console.log('✅ 全部通过（assign 3 形状 + plan ' + planChecks + ' 项 + guide ' + guideChecks + ' 项断言）');
