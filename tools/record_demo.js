/* 演示走查录屏（全功能版）：按 DEMO_SCRIPT.md 的分镜依次走一遍。
 * 每个镜头开始前打时间戳，录制结束后据此生成 demo-captions.srt。
 * 用 127.0.0.1:4317 在线模式录制：能同时展示「在线 MCP」状态与券的「（实时）」标记，
 * 且画面里不出现本地文件路径（不暴露用户名/目录结构）。
 * 用法：NODE_PATH=<workspace>/node_modules node tools/record_demo.js */
'use strict';
var path = require('path');
var fs = require('fs');
var playwright = require('playwright');

var ROOT = path.resolve(__dirname, '..');
var OUT_DIR = path.resolve(ROOT, '..', 'demo_video');
var PAGE_URL = process.env.DEMO_URL || 'http://127.0.0.1:4317/';

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

/* 镜头字幕：[字幕文案] —— 与下面的操作段落一一对应 */
var SCENES = [
  '开场：三个人一顿饭，说句话就能配 —— 菜单、门店、价格全部来自麦当劳官方 MCP',
  '首次打开自动弹引导页：它是什么、话怎么说、三条诚实边界（不下单 / 不编数据 / 离线是预演）',
  '顶部「在线 MCP · 可切离线」：在线走官方实时数据，双击 index.html 就是离线预演，同一套页面一键切',
  '优惠券箱：在线模式下每张券都标「（实时）」，来自官方 available-coupons',
  '输入框下方 8 个示例，点一下就填；也可以完全按自己的话说',
  '三份方案：省钱聚餐 / 低卡高蛋白 / 新品尝鲜，省钱版 ¥84.70',
  '口语也认：「我要吃炸鸡」→ 三份方案全都含蘸酱炸鸡',
  '一句话两个菜：「想吃炸鸡和薯饼」→ 两个都收下',
  '重头戏：想要套餐里的汉堡、不要薯条 → 跟整份套餐同池比价，谁便宜听谁的',
  '四维对比：价格 / 热量 / 蛋白质 / 口味；官方没给的一律写「官方未提供」',
  '子项面板可逐项改「想要 / 不想要」，改完自动重新搭配',
  '忌口优先：「不吃辣，想吃麦辣鸡腿堡」→ 明确提示冲突，且不会塞进方案',
  '热量上限 + 多人拆单：券属于下单账号，按券数拆单、每单限一张，人只算内部转账',
  '彩蛋：点「全场单点」先问「您确定单点吗」→ 确认后「震撼全场，你是那个靓仔」→ 再出全单点方案'
];

function fmtSrt(ms) {
  function pad(n, w) { var v = String(n); while (v.length < w) v = '0' + v; return v; }
  return pad(Math.floor(ms / 3600000), 2) + ':' + pad(Math.floor(ms / 60000), 2) + ':' +
    pad(Math.floor(ms / 1000) % 60, 2) + ',' + pad(ms % 1000, 3);
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
    recordVideo: { dir: OUT_DIR }   // 不要指定 size：指定后 Playwright 会降级成 800x500 并留黑边
  });
  page = await ctx.newPage();
  page.on('pageerror', function (e) { errors.push(e.message); });
  page.on('console', function (m) { if (m.type() === 'error') errors.push(m.text()); });

  async function submit(waitMs) {
    await page.click('#submitButton');
    await page.waitForFunction('document.querySelectorAll(".plan-card").length>0', null, { timeout: 15000 });
    await page.waitForTimeout(waitMs);
  }

  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 45000 });
  await page.waitForSelector('#guideDialog[open]', { timeout: 12000 }).catch(function () {});
  await page.waitForTimeout(1400);          // 镜头 0：开场首页 + 引导页在场

  mark();                                   // 镜头 1：引导页内容
  await page.waitForTimeout(5200);

  mark();                                   // 镜头 2：关闭引导 → 顶部模式按钮 + 状态条
  await page.click('#guideDone');
  await page.waitForTimeout(900);
  await page.hover('#modeSwitch');           // 在线态点它是切换模式，这里只悬停展示
  await page.waitForTimeout(3800);

  mark();                                   // 镜头 3：券箱实时标记
  await page.click('#couponOpen');
  await page.waitForTimeout(4200);

  mark();                                   // 镜头 5：关券箱 + 示例 chips
  await page.click('#couponDone');
  await page.waitForTimeout(600);
  await page.evaluate(function () {
    document.getElementById('requestText').scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(1800);
  var hint = page.locator('#guideChips .suggestion-chip').first();
  if (await hint.count()) await hint.click();
  await page.waitForTimeout(1400);

  mark();                                   // 镜头 6：① 基础配餐结果
  await submit(5600);

  mark();                                   // 镜头 7：② 口语点名
  await page.fill('#requestText', '我要吃炸鸡');
  await submit(4800);

  mark();                                   // 镜头 8：② 一句两菜
  await page.fill('#requestText', '我想吃炸鸡和薯饼');
  await submit(4600);

  mark();                                   // 镜头 9：③ 套餐拆开
  await page.fill('#requestText', '2 个人，100 块，我想要巨无霸套餐里的汉堡，不要薯条');
  await submit(5000);

  mark();                                   // 镜头 10：四维对比
  var cmp = page.locator('.combo-comparison').first();
  if (await cmp.count()) await cmp.locator('summary').click();
  await page.waitForTimeout(4000);

  mark();                                   // 镜头 11：子项面板
  var sub = page.locator('.item-subparts').first();
  if (await sub.count()) await sub.locator('summary').click();
  await page.waitForTimeout(3800);

  mark();                                   // 镜头 12：④ 忌口冲突
  await page.fill('#requestText', '不吃辣，想吃麦辣鸡腿堡');
  await submit(5000);

  mark();                                   // 镜头 13：⑤ 热量上限 + 多人拆单
  await page.fill('#maxCal', '900');
  await page.fill('#requestText', '2 个人，100 块以内');
  await submit(2400);
  var selects = page.locator('.plan-card .select-plan');
  if (await selects.count() >= 2) {
    await selects.nth(0).click(); await page.waitForTimeout(400);
    await selects.nth(1).click(); await page.waitForTimeout(600);
  }
  await page.click('#splitSelected');
  await page.waitForTimeout(900);
  await page.click('#runAssign');
  await page.waitForTimeout(6000);

  /* 彩蛋镜头：滚回输入区，点「全场单点」→ 确认 → 震撼全场 → 出全单点方案 */
  mark();
  await page.evaluate(function () {
    var box = document.getElementById('guideChips');
    if (box) box.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(1200);
  var eggChip = page.locator('#guideChips .suggestion-chip', { hasText: '全场单点' });
  if (await eggChip.count()) {
    await eggChip.first().click();
    await page.waitForTimeout(3000);          // 第一问：您确定单点吗
    await page.click('#eggYes');
    await page.waitForTimeout(3200);          // 第二句：震撼全场
    await page.click('#eggOk');
    await page.waitForTimeout(1500);          // 词条落进输入框
    await submit(4500);                       // 全单点方案
    await page.waitForTimeout(1800);
  }
  await browser.close();

  var lines = [];
  for (var i = 0; i < marks.length - 1; i++) {
    lines.push(String(i + 1));
    lines.push(fmtSrt(marks[i]) + ' --> ' + fmtSrt(marks[i + 1]));
    lines.push(SCENES[i] || '');
    lines.push('');
  }
  var srtPath = path.join(OUT_DIR, 'demo-captions.srt');
  fs.writeFileSync(srtPath, '\ufeff' + lines.join('\n'), 'utf8');
  var total = marks[marks.length - 1];
  console.log('字幕 ' + (marks.length - 1) + ' 条，总时长 ' + (total / 1000).toFixed(1) + 's');
  console.log('页面错误：' + (errors.length ? errors.join(' | ') : '无'));
  fs.readdirSync(OUT_DIR).filter(function (f) { return /\.webm$/.test(f); })
    .forEach(function (f) { console.log('VIDEO ' + path.join(OUT_DIR, f)); });
})().catch(function (e) { console.error('录屏失败: ' + e.stack); process.exit(1); });
