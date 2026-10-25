/* 演示走查录屏：按 DEMO_SCRIPT.md 的六个场景依次走一遍。
 * 每个场景开始前打一个时间戳，录制结束后据此生成 demo-captions.srt，
 * 保证「字幕 i 的显示区间 = 场景 i 的画面区间」。
 * 用法：NODE_PATH=<workspace>/node_modules node tools/record_demo.js */
'use strict';
var path = require('path');
var fs = require('fs');
var playwright = require('playwright');

var ROOT = path.resolve(__dirname, '..');
var OUT_DIR = path.resolve(ROOT, '..', 'demo_video');
var PAGE_URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

/* 场景：[字幕, 输入框文本(为空则只等待), 停留毫秒] */
var SCENES = [
  ['开场：三个人凑一顿，随便说句话 —— 我从麦当劳官方菜单里配出三种吃法', null, 1200],
  ['引导页：首次访问自动弹出，说明它能做什么、话该怎么说', null, 5200],
  ['点「开始使用」关闭引导页', null, 1800],
  ['① 基础配餐：点下面的示例 chip，或自己敲一句话', null, 2400],
  ['① 三份方案出来了：省钱聚餐 / 低卡高蛋白 / 新品尝鲜，省钱版 ¥84.70', null, 6000],
  ['② 口语随便说：「我要吃炸鸡」→ 三份方案全都含蘸酱炸鸡', '我要吃炸鸡', 5200],
  ['② 一句话两个菜：「我想吃炸鸡和薯饼」→ 两个都收下', '我想吃炸鸡和薯饼', 5200],
  ['③ 重头戏：想要套餐里的汉堡、不要薯条 → 跟整份套餐同池比价', '2 个人，100 块，我想要巨无霸套餐里的汉堡，不要薯条', 5600],
  ['③ 四维对比：价格 / 热量 / 蛋白质 / 口味匹配；官方没给的一律写「官方未提供」', null, 4200],
  ['③ 子项可视化勾选面板：改完偏好会自动重新搭配', null, 3800],
  ['④ 忌口优先：「不吃辣，想吃麦辣鸡腿堡」→ 冲突提示，且不塞进方案', '不吃辣，想吃麦辣鸡腿堡', 5200],
  ['⑤ 热量上限：右上角填 900 大卡 → 超标直接挂黄牌', null, 2600],
  ['⑤ 多人拆单：选两份 → 分账 → 拆单并用券 → 券账本一行一张', null, 6500]
];

function fmtSrt(ms) {
  function pad(n, w) { var v = String(n); while (v.length < w) v = '0' + v; return v; }
  var h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + ',' + pad(r, 3);
}

var t0 = Date.now();
var marks = [];
var errors = [];
var page;

function log(s) { console.log('[' + ((Date.now() - t0) / 1000).toFixed(1) + 's] ' + s); }
function mark() { marks.push(Date.now() - t0); }

(async function () {
  var browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
  var ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 900 } }
  });
  page = await ctx.newPage();
  page.on('pageerror', function (e) { errors.push(e.message); });
  page.on('console', function (m) { if (m.type() === 'error') errors.push(m.text()); });

  async function submit(waitMs) {
    await page.click('#submitButton');
    await page.waitForFunction('document.querySelectorAll(".plan-card").length>0', null, { timeout: 10000 });
    await page.waitForTimeout(waitMs);
  }

  /* 引导页会在加载后自动弹出，先让它露脸 */
  await page.goto(PAGE_URL);
  await page.waitForSelector('#guideDialog[open]', { timeout: 10000 }).catch(function () {});
  await page.waitForTimeout(1200);   // 开场：首页
  mark();                            // 场景 0 起 → 引导页
  await page.waitForTimeout(5200);
  await page.click('#guideDone');
  await page.waitForTimeout(1800);
  mark();                            // 场景 1 起 → ① 基础配餐（示例 chip）
  await page.evaluate(function () { document.getElementById('requestText').scrollIntoView({ block: 'center' }); });
  await page.waitForTimeout(2400);
  var hint = page.locator('#guideChips .suggestion-chip').first();
  if (await hint.count()) await hint.click();
  await page.waitForTimeout(2000);
  await submit(6000);
  mark();                            // 场景 2 起 → ② 口语点名
  await page.fill('#requestText', '我要吃炸鸡');
  await submit(5200);
  mark();                            // 场景 3 起 → ② 一句两菜
  await page.fill('#requestText', '我想吃炸鸡和薯饼');
  await submit(5200);
  mark();                            // 场景 4 起 → ③ 套餐拆开
  await page.fill('#requestText', '2 个人，100 块，我想要巨无霸套餐里的汉堡，不要薯条');
  await submit(5600);
  var cmp = page.locator('.combo-comparison').first();
  if (await cmp.count()) await cmp.locator('summary').click();
  await page.waitForTimeout(4200);
  mark();                            // 场景 5 起 → ③ 子项面板
  var sub = page.locator('.item-subparts').first();
  if (await sub.count()) await sub.locator('summary').click();
  await page.waitForTimeout(3800);
  mark();                            // 场景 6 起 → ④ 忌口
  await page.fill('#requestText', '不吃辣，想吃麦辣鸡腿堡');
  await submit(5200);
  mark();                            // 场景 7 起 → ⑤ 热量上限 + 拆单
  await page.fill('#maxCal', '900');
  await page.fill('#requestText', '2 个人，100 块以内');
  await submit(2500);
  var selects = page.locator('.plan-card .select-plan');
  if (await selects.count() >= 2) {
    await selects.nth(0).click(); await page.waitForTimeout(400);
    await selects.nth(1).click(); await page.waitForTimeout(700);
  }
  await page.click('#splitSelected');
  await page.waitForTimeout(1000);
  await page.click('#runAssign');
  await page.waitForTimeout(6500);
  mark();                            // 收尾边界

  await browser.close();

  /* 字幕 i = CAPTIONS[i]，区间 [marks[i], marks[i+1]] */
  var lines = [];
  var total = Math.max.apply(null, marks);
  for (var i = 0; i < marks.length - 1; i++) {
    lines.push(String(i + 1));
    lines.push(fmtSrt(marks[i]) + ' --> ' + fmtSrt(marks[i + 1]));
    lines.push((SCENES[i] && SCENES[i][0]) || '');
    lines.push('');
  }
  var srtPath = path.join(OUT_DIR, 'demo-captions.srt');
  fs.writeFileSync(srtPath, '\ufeff' + lines.join('\n'), 'utf8');
  console.log('字幕 ' + (marks.length - 1) + ' 条，总时长 ' + (total / 1000).toFixed(1) + 's → ' + srtPath);
  console.log('页面错误：' + (errors.length ? errors.join(' | ') : '无'));
  var videos = fs.readdirSync(OUT_DIR).filter(function (f) { return /\.webm$/.test(f); });
  videos.forEach(function (f) { console.log('VIDEO ' + path.join(OUT_DIR, f)); });
})().catch(function (e) { console.error('录屏失败: ' + e.stack); process.exit(1); });
