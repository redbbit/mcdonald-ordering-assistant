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
process.exit(failures ? 1 : 0);
