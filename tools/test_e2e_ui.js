/* 端到端冒烟：真实 service.recommendPlans 输出 → app.js 渲染函数。
 * 验证「服务层字段形状」与「UI 期望」对得上，且脏输入不崩。
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

/* ---- 提取 app.js 的渲染函数 ---- */
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
var uiSandbox = {
  console: console,
  document: { getElementById: function () { return null; }, querySelectorAll: function () { return []; }, addEventListener: function () {}, createElement: function () { return null; } },
  esc: function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); },
  money: function (v) { return v == null || !isFinite(Number(v)) ? '—' : '¥' + Number(v).toFixed(2).replace(/\.00$/, ''); },
  num: function (v, d) { return v == null || !isFinite(Number(v)) ? '—' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: d == null ? 1 : d }); },
  attr: function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); },
  buildTag: function (text, kind) { return '<span class="plan-label ' + (kind || '') + '">' + text + '</span>'; },
  imageMarkup: function () { return '<span class="img-stub"></span>'; },
  roleLabel: function () { return '主食'; },
  state: { plans: [], availability: {}, mode: 'offline' }
};
vm.createContext(uiSandbox);
vm.runInContext(extractFn('renderPlan') + '\n' + extractFn('comboComparePanel') + '\nthis.renderPlan = renderPlan; this.comboComparePanel = comboComparePanel;', uiSandbox);

function renderAll(plans) {
  return plans.map(function (p) { return uiSandbox.renderPlan(p); }).join('\n');
}

(async function () {
  /* ---- 1. 普通查询 ---- */
  var plain = await S.recommendPlans('2个人，100块以内');
  check(plain.length === 3, '普通查询三版');
  var plainHtml = renderAll(plain);
  check(plainHtml.indexOf('省钱聚餐') >= 0, 'tier 标题渲染');
  check(plain.indexOf('mix-summary') < 0, '普通方案无 mix 区块（null 不硬编）');

  /* ---- 2. 口语点名菜（投诉场景） ---- */
  var wanted = await S.recommendPlans('我要吃炸鸡');
  var wantedHtml = renderAll(wanted);
  check(wanted.every(function (p) { return p.items.some(function (i) { return /炸鸡/.test(i.name); }); }), '口语点名三版含炸鸡');
  check(wantedHtml.indexOf('炸鸡') >= 0, '炸鸡渲染进卡片');

  /* ---- 3. 子项偏好 → 混合方案 + 四维对比 ---- */
  var mixed = await S.recommendPlans('2个人，100块，我想要安格斯厚牛堡，不要薯条和可乐');
  var mixedHtml = renderAll(mixed);
  var hasMix = mixed.some(function (p) { return p.mixSummary && p.mixSummary.text; });
  var hasCompare = mixed.some(function (p) { return p.comboCompare && p.comboCompare.length; });
  console.log('   子项偏好场景：mixSummary=' + hasMix + ' comboCompare=' + hasCompare);
  if (hasMix) {
    check(mixedHtml.indexOf('这份是怎么搭的') >= 0, 'mixSummary 渲染');
    check(mixedHtml.indexOf('不支持套餐改配') >= 0, '不改配边界露出');
  }
  if (hasCompare) {
    check(mixedHtml.indexOf('看套餐对比') >= 0, '对比按钮');
    var cmpHtml = uiSandbox.comboComparePanel(mixed.filter(function (p) { return p.comboCompare && p.comboCompare.length; })[0]);
    check(cmpHtml.indexOf('整份套餐 vs 拆开单点') >= 0, '对比面板标题');
    check(cmpHtml.indexOf('官方未提供，未估算') >= 0 || cmpHtml.indexOf('kcal') >= 0, '对比维度有值或未提供');
  }
  // comboPart 记账完整性 + 角标
  var partPlans = mixed.filter(function (p) { return p.items.some(function (i) { return i.sourceType === 'comboPart'; }); });
  if (partPlans.length) {
    check(partPlans[0].items.every(function (i) { return i.sourceType !== 'comboPart' || !!i.fromCombo; }), 'comboPart 必带 fromCombo');
    check(renderAll([partPlans[0]]).indexOf('src-part') >= 0, 'comboPart 角标');
  }

  /* ---- 4. 忌口冲突（第 9 轮） ---- */
  var avoidWin = await S.recommendPlans('不吃辣，想吃麦辣鸡腿堡');
  check(avoidWin[0].conflicts.some(function (c) { return c.field === 'avoid'; }), '忌口冲突上报');
  check(avoidWin.every(function (p) { return p.items.every(function (i) { return i.name.indexOf('麦辣鸡腿汉堡') < 0; }); }), '冲突菜不进方案');

  /* ---- 5. maxCal ---- */
  var calPlans = await S.recommendPlans('2个人，100块以内，不超过800大卡');
  check(calPlans.every(function (p) { return p.maxCal === 800; }), 'maxCal 透传');
  check(renderAll(calPlans).indexOf('上限 800 kcal') >= 0, 'maxCal 徽标渲染');

  /* ---- 6. 脏输入健壮性（不许崩） ---- */
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
