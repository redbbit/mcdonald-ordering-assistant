/* 引导页 / 输入引导的浏览器回归（需要 playwright；没装就跳过，不算失败）。
 * 重点锁用户报过的 bug：退出投屏大字 → 点「使用说明」→ 弹层隐形但遮罩仍在拦截点击（整页像卡死）。
 * 用法：NODE_PATH=<workspace>/node_modules node tools/test_guide_ui.js */
'use strict';
var path = require('path');
var URL = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');

var playwright;
try { playwright = require('playwright'); } catch (e) {
  console.log('… 未安装 playwright，跳过浏览器回归（跳过不算失败）');
  process.exit(0);
}

var fail = 0, ok = 0;
function ck(c, m) { if (c) { ok++; console.log('  ✓ ' + m); } else { fail++; console.error('  ✗ ' + m); } }

(async function () {
  var browser;
  try { browser = await playwright.chromium.launch({ channel: 'msedge', headless: true }); } catch (e) {
    console.log('… 无可用浏览器（Edge），跳过浏览器回归（跳过不算失败）');
    process.exit(0);
  }
  var ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  var page = await ctx.newPage();
  var errors = [];
  page.on('pageerror', function (e) { errors.push(e.message); });
  page.on('console', function (m) { if (m.type() === 'error') errors.push(m.text()); });

  function dlgState() {
    return page.evaluate(function () {
      var d = document.getElementById('guideDialog');
      if (!d) return { missing: true };
      var cs = getComputedStyle(d), r = d.getBoundingClientRect();
      return { open: d.open, display: cs.display, w: Math.round(r.width), h: Math.round(r.height) };
    });
  }
  async function ask(text, hold) {
    await page.fill('#requestText', text);
    await page.click('#submitButton');
    await page.waitForFunction('document.querySelectorAll(".plan-card").length>0', null, { timeout: 10000 });
    await page.waitForTimeout(hold == null ? 2200 : hold);
  }

  await page.goto(URL);
  await page.waitForTimeout(3000);

  console.log('引导页生命周期');
  var s0 = await dlgState();
  ck(s0.open === true, '首次访问自动弹出');
  ck(s0.display !== 'none' && s0.h > 0, '且可见（display=' + s0.display + ' h=' + s0.h + '）');

  await page.click('#guideDone');
  await page.waitForTimeout(700);
  var s1 = await dlgState();
  ck(s1.open === false && s1.display === 'none', '点「开始使用」关闭并隐藏');

  await page.click('#guideOpen');
  await page.waitForTimeout(800);
  var s2 = await dlgState();
  ck(s2.open === true, '点「使用说明」可重开');
  /* 🔒 回归：这里曾因 closeGuide 加了 hidden 属性，而全局 [hidden]{display:none!important}
  * 让弹层隐形但仍是模态 → 遮罩拦截所有点击，页面表现为「卡死」。 */
  ck(s2.display !== 'none' && s2.h > 0, '重开后可见（不是隐形模态框）');

  console.log('引导页内容');
  var txt = await page.textContent('#guideDialog');
  ck(/不下单/.test(txt), '含「不下单」边界');
  ck(/官方未提供/.test(txt), '含「官方未提供」边界');
  ck(/离线预演/.test(txt), '含离线预演说明');
  ck(/三步/.test(txt), '含最快三步');

  await page.click('#guideDone');
  await page.waitForTimeout(700);
  ck((await dlgState()).open === false, '可反复关闭');

  console.log('输入引导');
  var chips = await page.locator('#guideChips .suggestion-chip').count();
  ck(chips >= 5, '示例 chips 已渲染（' + chips + ' 个）');
  await page.locator('#guideChips .suggestion-chip').first().click();
  await page.waitForTimeout(400);
  var v = await page.inputValue('#requestText');
  ck(v.length > 0, '点示例填入输入框：' + v);

  console.log('补全提示');
  await ask('我要吃炸鸡', 2600);
  var miss = await page.textContent('#guideMissing').catch(function () { return ''; });
  ck(/几人/.test(miss) && /预算/.test(miss) && /忌口/.test(miss), '缺槽位时提示齐全');
  var before = await page.inputValue('#requestText');
  await page.locator('#guideMissing .hint-gap').first().click();
  await page.waitForTimeout(400);
  var after = await page.inputValue('#requestText');
  ck(after.indexOf(before) === 0 && after.length > before.length, '补全 chip 是追加');

  await browser.close();
  console.log('='.repeat(52));
  console.log(fail ? '❌ ' + fail + ' 项失败（通过 ' + ok + '）' : '✅ 引导页回归全部通过（' + ok + ' 项）');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error('崩溃: ' + e.stack); process.exit(1); });
