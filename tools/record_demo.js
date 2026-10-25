/* 录屏：用系统 Edge（headless）走查 DEMO_SCRIPT.md 的 6 个场景，产出 webm。
 * 用法：NODE_PATH=<workspace>/node_modules node tools/record_demo.js */
'use strict';
var path = require('path');
var playwright = require('playwright');

var ROOT = path.resolve(__dirname, '..');
var OUT_DIR = path.resolve(__dirname, '..', '..', 'demo_video');
var PAGE_URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');

(async function () {
  var browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
  var context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 900 } }
  });
  var page = await context.newPage();
  page.on('pageerror', function (e) { console.error('PAGEERROR: ' + e.message); });
  page.on('console', function (m) { if (m.type() === 'error') console.error('CONSOLE: ' + m.text()); });

  function log(s) { console.log('[' + new Date().toTimeString().slice(0, 8) + '] ' + s); }

  await page.goto(PAGE_URL);
  await page.waitForTimeout(2500); // ⓿ 开场：首页 + 轮播
  log('⓿ 开场');

  async function ask(text, holdMs) {
    await page.fill('#requestText', text);
    await page.waitForTimeout(400);
    await page.click('#submitButton');
    await page.waitForSelector('.plan-card', { timeout: 10000 });
    await page.waitForTimeout(holdMs == null ? 2200 : holdMs);
  }

  // ① 基础配餐
  await ask('3 个人，100 块以内，想吃得满足一点');
  var understand = await page.textContent('#understandingLine').catch(function () { return ''; });
  log('① 基础配餐（理解行：' + (understand || '').slice(0, 60) + '）');

  // ② 口语点名
  await ask('我要吃炸鸡');
  log('② 口语点名：我要吃炸鸡');
  await ask('我想吃炸鸡和薯饼');
  log('② 一句两菜');

  // ③ 套餐拆开重头戏
  await ask('2 个人，100 块，我想要巨无霸套餐里的汉堡，不要薯条', 3000);
  var compare = page.locator('.combo-comparison').first();
  if (await compare.count()) {
    await compare.locator('summary').click();
    await page.waitForTimeout(1800);
    log('③ 四维对比已展开');
  } else {
    log('③ ⚠ 无 combo-comparison（检查场景文本）');
  }

  // ④ 忌口冲突
  await ask('不吃辣，想吃麦辣鸡腿堡');
  var notice = await page.textContent('#noticeStack').catch(function () { return ''; });
  log('④ 忌口冲突（notices：' + (notice || '').slice(0, 50) + '）');

  // ⑤ 多人拆单：选两份 → 分账 → 拆单并用券
  var selectButtons = page.locator('.plan-card .select-plan');
  if (await selectButtons.count() >= 2) {
    await selectButtons.nth(0).click();
    await page.waitForTimeout(300);
    await selectButtons.nth(1).click();
    await page.waitForTimeout(500);
    await page.click('#splitSelected');
    await page.waitForTimeout(800);
    var planOptions = await page.locator('#splitPlan option').count();
    if (planOptions > 0) { await page.selectOption('#splitPlan', { index: 0 }); }
    await page.click('#runAssign');
    await page.waitForTimeout(2500);
    var assignHtml = await page.textContent('#assignResult').catch(function () { return ''; });
    log('⑤ 拆单用券（' + (assignHtml || '').slice(0, 50) + '…）');
  } else {
    log('⑤ ⚠ 方案卡不足两张，跳过拆单');
  }

  // ⑥ 收尾
  await page.waitForTimeout(1500);
  log('⑥ 收尾');

  await context.close();
  await browser.close();
  var fs = require('fs');
  var files = fs.readdirSync(OUT_DIR).filter(function (f) { return /\.webm$/.test(f); });
  files.forEach(function (f) { console.log('VIDEO ' + path.join(OUT_DIR, f)); });
  if (!files.length) { console.error('未产出视频'); process.exit(1); }
})().catch(function (e) { console.error('录屏失败: ' + e.stack); process.exit(1); });
