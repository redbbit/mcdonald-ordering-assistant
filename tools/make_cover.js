/* 生成 4:3 封面图（1600×1200 PNG）用于作品提交。
 * 用系统 Edge 截图，中文字体走系统渲染，不会糊。
 * 用法：NODE_PATH=<workspace>/node_modules node tools/make_cover.js */
'use strict';
var path = require('path');
var fs = require('fs');
var playwright = require('playwright');

var OUT = path.resolve(__dirname, '..', '..', 'cover.png');

var HTML = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
  '<style>',
  '  * { margin:0; padding:0; box-sizing:border-box; }',
  '  body { width:1600px; height:1200px; font-family:"Microsoft YaHei","PingFang SC",sans-serif;',
  '    background: radial-gradient(1200px 800px at 20% 15%, #fff6e0 0%, #f4efe5 45%, #ecdcc0 100%);',
  '    display:flex; align-items:center; justify-content:center; position:relative; overflow:hidden; }',
  '  .brand { position:absolute; top:64px; left:72px; display:flex; align-items:center; gap:18px; }',
  '  .emblem { width:76px; height:76px; border-radius:20px; background:#c92519; color:#f4bd32;',
  '    display:flex; align-items:center; justify-content:center; font-size:44px; font-weight:800; }',
  '  .brand-text { font-size:26px; color:#563b29; font-weight:800; letter-spacing:.04em; }',
  '  .brand-sub { position:absolute; top:150px; left:72px; font-size:19px; color:#887b6b; }',
  '  .card { width:1180px; padding:78px 84px; background:rgba(255,253,248,.92);',
  '    border:1px solid #e9dfcf; border-radius:34px; box-shadow:0 26px 70px rgba(70,45,20,.12); }',
  '  h1 { font-size:88px; color:#30261d; line-height:1.15; margin-bottom:26px; }',
  '  h1 em { color:#c92519; font-style:normal; }',
  '  .lead { font-size:34px; color:#6e6254; line-height:1.55; margin-bottom:38px; }',
  '  ul { list-style:none; }',
  '  li { font-size:27px; color:#563b29; padding:11px 0 11px 34px; position:relative; }',
  '  li::before { content:"✦"; position:absolute; left:0; color:#f4bd32; }',
  '  .foot { margin-top:40px; font-size:22px; color:#887b6b; }',
  '</style></head><body>',
  '<div class="brand"><div class="emblem">M</div><div class="brand-text">麦当劳智能点餐推荐助手</div></div>',
  '<div class="brand-sub">1024 黑客松 · 用餐赛道</div>',
  '<div class="card">',
  '  <h1>说句话，<br><em>整桌给你搭好</em></h1>',
  '  <p class="lead">几个人、预算多少、忌口什么、想吃什么——随便说。我从当前时段的官方菜单里，配出三种吃法。</p>',
  '  <ul>',
  '    <li>口语随便说：动词、缓冲词、一句多菜都能接住</li>',
  '    <li>套餐可拆：想要的部分跟整份同池比价，谁划算谁上</li>',
  '    <li>四维对比：价格 / 热量 / 蛋白质 / 口味匹配</li>',
  '    <li>多人分账：拆单各用券，券账本一行一张</li>',
  '  </ul>',
  '  <div class="foot">数据来自麦当劳官方 MCP · 页面不下单</div>',
  '</div>',
  '</body></html>'
].join('');

(async function () {
  var browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
  var page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  await page.setContent(HTML, { waitUntil: 'load' });
  await page.waitForTimeout(700);
  await page.screenshot({ path: OUT });
  await browser.close();
  var st = fs.statSync(OUT);
  console.log('封面已生成: ' + OUT + '  (' + st.size + ' bytes, ' + (st.size / 1048576).toFixed(2) + ' MB)');
})().catch(function (e) { console.error('生成封面失败: ' + e.stack); process.exit(1); });
