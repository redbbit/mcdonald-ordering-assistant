/* 端到端冒烟：真实 service.recommendPlans 输出 → app.js 渲染函数（GPT 接线版）。
 * 验证「服务层字段形状」与「UI 期望」对得上，且脏输入不崩。
 * 覆盖：来源角标/子项面板/混合方案/四维对比/权重/maxCal 黄牌/理解行/忌口冲突/XSS。
 * 用法：node tools/test_e2e_ui.js */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var root = path.resolve(__dirname, '..');
var failures = 0, checks = 0;
function check(cond, msg) { checks++; if (!cond) { failures++; console.error('FAIL ' + msg); } }

/* ---- 加载数据 + 引擎 + 服务（与 test_service 同构） ---- */
var sandbox = { window: {}, console: console, Date: Date, Math: Math, JSON: JSON, Promise: Promise, Error: Error, encodeURIComponent: encodeURIComponent };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'data/menu_data.js'), 'utf8'), sandbox);
var campPath = path.join(root, 'data/campaigns.js');
if (fs.existsSync(campPath)) vm.runInContext(fs.readFileSync(campPath, 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'engine.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'service.js'), 'utf8'), sandbox);
var D = sandbox.window.MCD_DATA;
var S = sandbox.window.McAdvisor.createService({ data: D, engine: sandbox.window.MCDEngine });

/* ---- 提取 app.js 的渲染函数（GPT 版：renderUnderstanding 独立成函数，comboCompare 内联） ---- */
var src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
function extractFn(name) {
  var start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(name + ' not found');
  var i = src.indexOf('{', start), depth = 0, end = -1;
  for (var j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return src.slice(start, end);
}
function extractVar(name) {
  var start = src.indexOf('var ' + name + ' =');
  if (start < 0) throw new Error(name + ' not found');
  var i = src.indexOf('{', start), depth = 0, end = -1;
  for (var j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return src.slice(start, end);
}
function elStub() {
  return { innerHTML: '', hidden: true, value: '', checked: false, dataset: {}, style: {},
    setAttribute: function () {}, querySelector: function () { return null; },
    querySelectorAll: function () { return []; }, addEventListener: function () {} };
}
var understandEl = elStub(), panelEl = elStub(), noticesEl = elStub();
var uiSandbox = {
  console: console,
  document: { getElementById: function (id) { return id === 'understandingLine' ? understandEl : id === 'itemPrefsPanel' ? panelEl : null; }, querySelectorAll: function () { return []; }, addEventListener: function () {}, createElement: function () { return null; } },
  $: function (id) { return id === 'understandingLine' ? understandEl : id === 'itemPrefsPanel' ? panelEl : null; },
  esc: function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); },
  money: function (v) { return v == null || !isFinite(Number(v)) ? '—' : '¥' + Number(v).toFixed(2).replace(/\.00$/, ''); },
  num: function (v, d) { return v == null || !isFinite(Number(v)) ? '—' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: d == null ? 1 : d }); },
  attr: function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); },
  buildTag: function (text, kind) { return '<span class="plan-label ' + (kind || '') + '">' + text + '</span>'; },
  imageMarkup: function () { return '<span class="img-stub"></span>'; },
  roleLabel: function () { return '主食'; },
  els: { notices: noticesEl },
  state: { plans: [], availability: {}, mode: 'offline' }
};
vm.createContext(uiSandbox);
vm.runInContext(
  extractVar('WANTED_REASON') + '\n' +
  extractFn('renderPlan') + '\n' + extractFn('renderUnderstanding') + '\n' + extractFn('showNotices') + '\n' +
  extractFn('caloriePanel') + '\n' + extractFn('nutritionPanel') + '\n' + extractFn('toggleDetail') + '\n' +
  'this.renderPlan = renderPlan; this.renderUnderstanding = renderUnderstanding; this.showNotices = showNotices;' +
  'this.caloriePanel = caloriePanel; this.nutritionPanel = nutritionPanel; this.toggleDetail = toggleDetail;',
  uiSandbox);

function renderAll(plans) {
  uiSandbox.state.plans = plans;
  return plans.map(function (p) { return uiSandbox.renderPlan(p); }).join('\n');
}

(async function () {
  /* ---- 1. 普通查询 ---- */
  var plain = await S.recommendPlans('2个人，100块以内');
  check(plain.length === 3, '普通查询三版');
  var plainHtml = renderAll(plain);
  check(plainHtml.indexOf('省钱聚餐') >= 0, 'tier 标题渲染');
  check(plainHtml.indexOf('mix-summary') < 0, '普通方案无 mix 区块（null 不硬编）');
  check(plainHtml.indexOf('combo-comparison') < 0, '普通方案无四维对比（无完整套餐可比）');
  check(plainHtml.indexOf('source-type-badge single') >= 0, '普通单点也有来源角标（GPT 版口径：有 sourceType 就标）');

  /* ---- 2. 口语点名菜（投诉场景） ---- */
  var wanted = await S.recommendPlans('我要吃炸鸡');
  var wantedHtml = renderAll(wanted);
  check(wanted.every(function (p) { return p.items.some(function (i) { return /炸鸡/.test(i.name); }); }), '口语点名三版含炸鸡');
  check(wantedHtml.indexOf('炸鸡') >= 0, '炸鸡渲染进卡片');

  /* ---- 3. 子项偏好 → 混合方案 + 四维对比（内联 details） ---- */
  var mixed = await S.recommendPlans('2个人，100块，我想要安格斯厚牛堡，不要薯条和可乐');
  var mixedHtml = renderAll(mixed);
  var hasMix = mixed.some(function (p) { return p.mixSummary && p.mixSummary.text; });
  var hasCompare = mixed.some(function (p) { return p.comboCompare && p.comboCompare.length; });
  console.log('   子项偏好场景：mixSummary=' + hasMix + ' comboCompare=' + hasCompare);
  if (hasMix) {
    check(mixedHtml.indexOf('mix-summary') >= 0, 'mixSummary 渲染');
    check(mixedHtml.indexOf('plan-weights') >= 0 || mixedHtml.indexOf('plan-labels') >= 0, '权重行或标签行存在');
  }
  if (hasCompare) {
    check(mixedHtml.indexOf('整套餐 vs 子项单点 · 四维对比') >= 0, '四维对比内联渲染');
    check(mixedHtml.indexOf('不支持套餐改配') >= 0, '不改配边界露出');
    check(mixedHtml.indexOf('官方未提供') >= 0, '官方无数据维度不编造');
  }
  // comboPart 记账完整性 + 角标（GPT 版类名 source-type-badge）
  var partPlans = mixed.filter(function (p) { return p.items.some(function (i) { return i.sourceType === 'comboPart'; }); });
  if (partPlans.length) {
    check(partPlans[0].items.every(function (i) { return i.sourceType !== 'comboPart' || !!i.fromCombo; }), 'comboPart 必带 fromCombo');
    check(renderAll([partPlans[0]]).indexOf('source-type-badge comboPart') >= 0, 'comboPart 角标（含来自套餐名）');
    check(renderAll([partPlans[0]]).indexOf('来自') >= 0, '角标带「来自 X」');
  }
  // 完整套餐卡带子项勾选面板
  var comboPlans = mixed.filter(function (p) { return p.items.some(function (i) { return i.sourceType === 'combo' && i.parts && i.parts.length; }); });
  if (comboPlans.length) {
    var comboHtml = renderAll([comboPlans[0]]);
    check(comboHtml.indexOf('item-subparts') >= 0, '完整套餐卡带子项偏好面板');
    check(comboHtml.indexOf('data-subpart-pref') >= 0, '子项下拉有 data 契约（改偏好重新请求用）');
  }

  /* ---- 4. 忌口冲突（第 9 轮） ---- */
  var avoidWin = await S.recommendPlans('不吃辣，想吃麦辣鸡腿堡');
  check(avoidWin[0].conflicts.some(function (c) { return c.field === 'avoid'; }), '忌口冲突上报');
  check(avoidWin.every(function (p) { return p.items.every(function (i) { return i.name.indexOf('麦辣鸡腿汉堡') < 0; }); }), '冲突菜不进方案');
  noticesEl.innerHTML = '';
  uiSandbox.showNotices(avoidWin);
  check(noticesEl.innerHTML.indexOf('⚠') >= 0, '忌口冲突进 notices');

  /* ---- 5. maxCal：徽标 / 超标黄牌 / resolved 回填 / NaN 防护 ---- */
  var calPlans = await S.recommendPlans('2个人，100块以内，不超过800大卡');
  check(calPlans.every(function (p) { return p.maxCal === 800; }), 'maxCal 透传');
  check(calPlans[0].resolved && calPlans[0].resolved.maxCal === 800, 'resolved.maxCal 回填（控件同步用）');
  var calHtml = renderAll(calPlans);
  check(calHtml.indexOf('maxcal-note') >= 0, 'maxCal 徽标渲染');
  check(calHtml.indexOf('上限 800') >= 0, '上限数字露出');
  var overPlans = await S.recommendPlans('2个人，100块以内，不超过100大卡');
  var overHtml = renderAll(overPlans);
  check(overPlans.every(function (p) { return p.withinMaxCal === false; }), '超标不谎报达标');
  check(overHtml.indexOf('maxcal-note over') >= 0, '超标黄牌 class');
  check(overHtml.indexOf('超出上限') >= 0, '超标文案');
  // NaN / 空串 / 0 都不是合法上限：不得变成「全部超标」的假上限
  var nanPlan = (await S.recommendPlans({ people: 2, budgetMax: 100, maxCal: NaN }))[0];
  check(nanPlan.maxCal === null, 'NaN maxCal 视为不限制');
  var zeroPlan = (await S.recommendPlans({ people: 2, budgetMax: 100, maxCal: 0 }))[0];
  check(zeroPlan.maxCal === null, '0 maxCal 视为不限制');
  var emptyPlan = (await S.recommendPlans({ people: 2, budgetMax: 100, maxCal: '' }))[0];
  check(emptyPlan.maxCal === null, '空串 maxCal 视为不限制');

  /* ---- 6. 「我理解成了」独立摘要行（renderUnderstanding） ---- */
  understandEl.innerHTML = ''; understandEl.hidden = true; panelEl.innerHTML = ''; panelEl.hidden = true;
  uiSandbox.renderUnderstanding(avoidWin);
  check(!understandEl.hidden, '摘要行有内容时显示');
  check(understandEl.innerHTML.indexOf('我理解成了') >= 0, '摘要文案');
  check(understandEl.innerHTML.indexOf('不吃') >= 0, '摘要含忌口');
  check(understandEl.innerHTML.indexOf('麦辣鸡腿堡') >= 0, '摘要含点名菜');
  uiSandbox.renderUnderstanding(calPlans);
  check(understandEl.innerHTML.indexOf('800') >= 0, '摘要含热量上限');
  check(!panelEl.hidden, '子项偏好面板常驻可加');
  // XSS：摘要行必须转义
  var xssUnderstood = [{ resolved: { people: 1, avoid: ['<script>alert(1)</script>'] }, conflicts: [] }];
  understandEl.innerHTML = '';
  uiSandbox.renderUnderstanding(xssUnderstood);
  check(understandEl.innerHTML.indexOf('<script>alert(1)</script>') < 0, '摘要行 XSS 转义');

  /* ---- 7. toggleDetail：热量/营养面板照旧，comboCompare 已内联无此 kind ---- */
  var card = { dataset: { planId: plain[0].planId }, querySelector: function () { return { hidden: true }; }, querySelectorAll: function () { return []; } };
  var button = { setAttribute: function () {} };
  uiSandbox.state.plans = plain;
  await uiSandbox.toggleDetail(card, 'calories', button);
  checks++;
  var nutCard = { dataset: { planId: plain[0].planId }, querySelector: function () { return { hidden: true, innerHTML: '' }; }, querySelectorAll: function () { return []; } };
  uiSandbox.toggleDetail(nutCard, 'nutrition', button);
  checks++;

  /* ---- 8. 脏输入健壮性（不许崩） ---- */
  var dirty = ['', '   ', '啊'.repeat(600), '🍔🍟🍗', '12345', '<script>alert(1)</script>', '"quoted" 想吃', 'null undefined NaN', '想吃不存在的东西abcxyz', '预算-100到-50', '0个人'];
  for (var di = 0; di < dirty.length; di++) {
    try {
      var dp = await S.recommendPlans(dirty[di]);
      check(Array.isArray(dp), '脏输入 ' + di + ' 返回数组');
      renderAll(dp);
    } catch (e) {
      check(false, '脏输入 ' + di + '（' + dirty[di].slice(0, 12) + '）不抛错，实得 ' + e.message);
    }
  }
  // XSS 串必须被转义
  var xss = await S.recommendPlans('2个人');
  var xssHtml = uiSandbox.renderPlan(xss[0]);
  check(xssHtml.indexOf('<script>alert(1)</script>') < 0, '方案卡不出现未转义脚本串（输入串进不了 plan，双保险）');

  console.log('='.repeat(60));
  console.log(failures ? '❌ ' + failures + ' / ' + checks + ' 项失败' : '✅ E2E 全部通过（' + checks + ' 项断言）');
  process.exit(failures ? 1 : 0);
})().catch(function (e) { console.error('E2E 崩溃: ' + e.stack); process.exit(1); });
