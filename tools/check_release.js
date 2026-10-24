/* ============================================================================
 * 发布前安检（零依赖，node 22+ 直接跑）
 *
 *   node tools/check_release.js            # 检查发布集合
 *   node tools/check_release.js --strict   # 连风格问题也报错
 *
 * 检查三类红线：
 *   ① 安全：Token / 鉴权头 / create-order 出现在任何要发布的文件里
 *   ② 离线：index.html + css + ui js 里出现联网能力（fetch / XHR / WebSocket / CDN）
 *   ③ 图片：引用的本地图必须真的存在；外链图必须落在麦当劳官方域名白名单里
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const strict = process.argv.includes('--strict');

/* ---- 配置：这些就是我们的红线定义，改这里等于改规则 ---- */
const IMG_HOSTS = [
  'menu-img.mcd.cn', 'img.mcd.cn', 'cms-cdn.mcd.cn',
  'mcd-portal-prod-cos1-1300270282.cos.ap-shanghai.myqcloud.com'
];
// 发布集合：这些文件会被带进公开仓库 / 交付给评委
const RELEASE_FILES = [
  'index.html', 'style.css', 'app.js',
  'service.js', 'engine.js',
  'data/menu_data.js', 'data/campaigns.js'
];
// UI 层：运行时在浏览器里执行的代码，禁止任何联网能力
const UI_FILES = ['index.html', 'style.css', 'app.js'];

const SECRET_PATTERNS = [
  { re: /create[-_]?order/i, msg: '出现 create-order（本项目禁止下单能力）' },
  { re: /mcp\.mcd\.cn|mcp\.mcd/i, msg: '出现 MCP 服务端地址' },
  { re: /Authorization\s*[:=]/i, msg: '出现 Authorization 头' },
  { re: /Bearer\s+[A-Za-z0-9._-]{8,}/i, msg: '出现 Bearer Token' },
  { re: /api[_-]?key\s*[:=]\s*['"][^'"]{6,}/i, msg: '出现 apiKey' },
  { re: /MCP[_-]?TOKEN|mcpToken\s*[:=]/i, msg: '出现 MCP Token 变量名' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, msg: '出现私钥' }
];
/* 两个"看起来违规但其实不是"的东西，单独放行，避免误报掩盖真问题：
 *  - www.w3.org 是占位图 SVG 的 xmlns 命名空间，不是网络请求
 *  - 注释里明说"本项目不使用 create-order"，是加分项，不是违规 */
const NS_HOSTS = ['www.w3.org'];
const SAFE_MENTION = /(禁止|不使用|不用|不得|绝无|不调用|没有|don'?t|no )/i;

/* 去掉注释后再查红线：真正执行的代码里绝不能出现下单能力 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}
function commentedMentions(s, re) {
  const hits = [];
  const stripped = stripComments(s);
  const origin = s.match(re);
  if (!origin) return hits;
  // 如果去掉注释后就没了 → 只在注释里出现
  const left = stripped.match(re);
  if (!left) {
    for (const m of s.matchAll(/(?:\/\/|\/\*|<!--)[^\n]*\n?/g)) {
      if (re.test(m[0])) hits.push(m[0].trim().slice(0, 90));
    }
  }
  return hits;
}
/**
 * 联网检查的口径在「双模式」上线后变了：
 *
 *   旧口径：见 fetch() 就判违规 —— 那时是纯离线单模式，运行时确实零网络。
 *   新口径：**不许连外网，但允许连本机服务**（双模式要靠它真调 MCP）。
 *
 * 为什么不干脆放开：浏览器一旦能连外网，就等于开了可以把数据送出去的口子；
 * 而本机 127.0.0.1 那个口子只通向持 Token 的本地进程，Token 本身从不下发到浏览器。
 * 所以真正的红线没变，只是从「禁止联网」收窄成「禁止外部域名」。
 */
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const EXTERNAL_SCHEME = /https?:\/\/([^\s"'()<>[\]]+)/gi;

function hostOfUrl(u) {
  try { return new URL(u).hostname; } catch (e) { return (u.split('/')[0] || '').split(':')[0]; }
}
function isExternalHost(host) {
  if (!host) return false;
  if (LOCAL_HOSTS.indexOf(host) >= 0) return false;
  return !hostAllowed(host);        // 图片服务白名单（支持 *.mcd.cn 通配）
}

/**
 * 扫一段代码里出现的外部域名。
 * 跳过 xmlns 命名空间——那是 XML 的 Schema 标识字符串，不是网络请求，
 * 早期版本因此误报过 www.w3.org。
 */
function externalHostsIn(s) {
  const hosts = [];
  for (const m of String(s).matchAll(EXTERNAL_SCHEME)) {
    const pre = s.slice(Math.max(0, m.index - 24), m.index);
    if (/xmlns\s*=\s*["']?$/.test(pre)) continue;
    const host = hostOfUrl(m[1]);
    if (isExternalHost(host)) hosts.push(host);
  }
  return hosts;
}

const NET_PATTERNS = [
  { re: /<script[^>]+src\s*=\s*["']https?:/i, msg: '引用了外部 CDN 脚本' },
  { re: /<link[^>]+href\s*=\s*["']https?:/i, msg: '引用了外部 CDN 样式/字体' },
  { re: /\bWebSocket\b|EventSource\s*\(/, msg: '使用了 WebSocket / EventSource（本机服务用不上）' },
  { re: /navigator\.sendBeacon|importScripts\s*\(/, msg: '使用了后台上报 / 动态脚本' }
];

let fail = 0, warn = 0, pass = 0;
const out = [];
function ok(m) { pass++; out.push('   ✓ ' + m); }
function bad(file, m) { fail++; out.push('   ❌ [' + file + '] ' + m); }
function warnOf(file, m) { warn++; out.push('   ⚠ [' + file + '] ' + m); }

function read(f) {
  try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch (e) { return null; }
}

if (process.argv.includes('--selftest')) {
  console.log('='.repeat(78));
  console.log('安检器自检：真违规必须被抓，纯注释必须放行');
  console.log('='.repeat(78));
  const CASES = [
    { code: "mcp.call('create-order', {items:[]})", should: 'catch', re: SECRET_PATTERNS[0].re },
    { code: "var plan = { note: 'create-order 会真下单' }", should: 'catch', re: SECRET_PATTERNS[0].re },
    { code: "// 只到 calculate-price，绝无 create-order\nvar a=1;", should: 'pass', re: SECRET_PATTERNS[0].re },
    { code: "/* 本项目不使用 create-order，也不会做真实支付 */", should: 'pass', re: SECRET_PATTERNS[0].re },
    { code: "headers: { Authorization: 'Bearer ' + token }", should: 'catch', re: SECRET_PATTERNS[2].re },
    { code: "Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.x.y'", should: 'catch', re: SECRET_PATTERNS[3].re },
    // 双模式后 fetch('/api/...') 是允许的（连本机服务），这条用例的期望随之反转
    { code: "const r = await fetch('/api/menu')", should: 'pass', judge: function (c) { return externalHostsIn(c).length > 0; } },
    { code: "await fetch('http://127.0.0.1:8787/api/health')", should: 'pass', judge: function (c) { return externalHostsIn(c).length > 0; } },
    { code: "await fetch('https://api.example.com/collect', {body: data})", should: 'catch', judge: function (c) { return externalHostsIn(c).length > 0; } },
    { code: "ws = new WebSocket('wss://x')", should: 'catch', re: NET_PATTERNS[2].re },
    { code: "<script src=\"https://cdn.jsdelivr.net/npm/vue\"></script>", should: 'catch', re: NET_PATTERNS[0].re },
    { code: "img.src = 'https://menu-img.mcd.cn/a.png'", should: 'pass', judge: function (c) { return externalHostsIn(c).length > 0; } },
    { code: 'xmlns="http://www.w3.org/2000/svg"', should: 'pass', judge: function (c) { return externalHostsIn(c).length > 0; } }
  ];
  let sf = 0;
  CASES.forEach(function (c) {
    const inCode = c.judge ? c.judge(stripComments(c.code)) : c.re.test(stripComments(c.code));
    const got = inCode ? 'catch' : 'pass';
    const good = got === c.should;
    if (!good) sf++;
    console.log((good ? '   ✓ ' : '   ❌ ') + (c.should === 'catch' ? '应抓→' : '应放→') + got +
      '  ' + JSON.stringify(c.code).slice(0, 62));
  });
  console.log('-'.repeat(78));
  console.log(sf ? `❌ 安检器本身有 ${sf} 条判定不准，修好再用` : '✅ 安检器自检通过');
  process.exit(sf ? 1 : 0);
}

console.log('='.repeat(78));
console.log('McAdvisor 发布前安检');
console.log('='.repeat(78));

/* ---------- ① 存在性 ---------- */
console.log('\n[1] 发布文件是否齐全');
for (const f of RELEASE_FILES) {
  if (fs.existsSync(path.join(root, f))) ok(f);
  else {
    if (UI_FILES.includes(f)) warnOf(f, '缺失（GPT 端未交付？）');
    else bad(f, '缺失');
  }
}

/* ---------- ② 秘密 / 下单能力 ---------- */
console.log('\n[2] 安全红线：Token 与 create-order');
const scanFiles = RELEASE_FILES.filter(f => fs.existsSync(path.join(root, f)));
for (const f of scanFiles) {
  const s = read(f);
  if (s == null) continue;
  let hit = false;
  for (const p of SECRET_PATTERNS) {
    const inCode = p.re.test(stripComments(s));
    if (!inCode) {
      // 只出现在注释里：必须是「明确声明不用」的语气，否则算可疑
      const cms = commentedMentions(s, p.re);
      for (const c of cms) {
        if (SAFE_MENTION.test(c) || /^[\s/*<!-]*$/.test(c)) ok(f + ' 注释交代清楚了：' + c.slice(0, 40));
        else { bad(f, p.msg + '（注释里，且语气不明确）'); hit = true; }
      }
      continue;
    }
    const m = stripComments(s).match(new RegExp(p.re.source, 'gi'));
    bad(f, p.msg + (m ? ' ×' + m.length : ''));
    hit = true;
  }
  if (!hit) ok(f + ' 干净');
}

/* ---------- ③ 联网红线：允许本机服务，禁止外部域名 ---------- */
console.log('\n[3] 联网红线：可连本机服务，绝不能连外网');
const netTargets = Array.from(new Set(
  UI_FILES.concat(scanFiles.filter(x => /\.js$/.test(x)))));
for (const f of netTargets) {
  if (!fs.existsSync(path.join(root, f))) continue;
  const s = read(f);
  let hit = 0;

  for (const p of NET_PATTERNS) {
    const m = stripComments(s).match(new RegExp(p.re.source, 'gi'));
    if (m) { bad(f, p.msg + ' ×' + m.length); hit++; }
  }

  const external = externalHostsIn(stripComments(s));
  for (const host of Array.from(new Set(external))) {
    bad(f, '出现了外部域名请求目标：' + host); hit++;
  }

  if (!hit) ok(f + ' 联网目标受限（本机服务 / 官方图床）');
}

/* ---------- ④ 图片：本地图存在 + 外链域名白名单 ---------- */
console.log('\n[4] 图片：本地图真实性 + 外链域名白名单');
const allUrls = new Map();   // url -> 出现的文件
const localRefs = new Set();

for (const f of scanFiles) {
  const s = read(f);
  if (s == null) continue;
  // https 外链
  for (const m of s.matchAll(/https?:\/\/[^\s"'()<>]+/g)) {
    if (!allUrls.has(m[0])) allUrls.set(m[0], f);
  }
  // img/xxx 本地引用
  for (const m of s.matchAll(/(?:^|["'(=])(img\/[A-Za-z0-9_.\-]+)/g)) localRefs.add(m[1]);
}

// 白名单域名允许以 CSP 通配形式出现（如 *.mcd.cn），但 *.com 这种过宽的一律拒绝
function hostAllowed(host) {
  if (IMG_HOSTS.includes(host)) return true;
  if (!/^\*\./.test(host)) return false;
  const labels = host.slice(2).split('.');
  if (labels.length < 2) return false;
  const suffix = host.slice(1);
  return IMG_HOSTS.some(h => h.endsWith(suffix));
}

let badHost = 0, nsSeen = 0;
for (const [u, f] of allUrls) {
  let host = '';
  try { host = new URL(u).hostname; } catch (e) { continue; }
  if (hostAllowed(host)) continue;
  if (NS_HOSTS.includes(host)) {
    // 命名空间必须真的是 xmlns，不能是被拿来当资源地址用
    const s = read(f) || '';
    if (new RegExp('xmlns[^>]{0,20}' + u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(s)) { nsSeen++; continue; }
    bad(f, '疑似把 ' + host + ' 当资源地址引用'); badHost++; continue;
  }
  bad(f, '外链域名不在白名单：' + host); badHost++;
}
if (!badHost) ok('外链域名全部合规（' + (allUrls.size - nsSeen) + ' 个图片 URL 在白名单，' + nsSeen + ' 个是 SVG 命名空间）');
else if (badHost === allUrls.size) out.push('      （白名单：' + IMG_HOSTS.join(', ') + '）');

let missing = 0;
for (const r of localRefs) {
  if (!fs.existsSync(path.join(root, r))) { bad('(引用)', '引用的本地图不存在：' + r); missing++; }
}
if (!missing) ok('引用的本地图全部存在（共 ' + localRefs.size + ' 个引用）');

// 数据里声明的 imgLocal 必须真的落地
for (const df of ['data/menu_data.js', 'data/campaigns.js']) {
  if (!fs.existsSync(path.join(root, df))) continue;
  const s = read(df);
  let n = 0, miss = 0;
  for (const m of s.matchAll(/"imgLocal"\s*:\s*"(img\/[^"]+)"/g)) {
    n++;
    if (!fs.existsSync(path.join(root, m[1]))) { miss++; if (miss <= 3) bad(df, '声明的本地图缺失：' + m[1]); }
  }
  if (n && !miss) ok(df + ' 声明的 ' + n + ' 张本地图全部存在');
  else if (n) bad(df, '尚有 ' + miss + ' 张本地图缺失');
}

/* ---------- ⑤ 仓库卫生 ---------- */
console.log('\n[5] 仓库卫生：不得有 .env 之类的秘密文件');
const badFiles = ['.env', '.env.local', 'token.txt', 'secret.json', 'credentials.json', 'mcp.json'];
for (const bf of badFiles) {
  if (fs.existsSync(path.join(root, bf))) bad(bf, '秘密文件出现在发布目录');
}
if (!badFiles.some(bf => fs.existsSync(path.join(root, bf)))) ok('无 .env / 凭据文件');
const gi = path.join(root, '.gitignore');
if (fs.existsSync(gi)) ok('.gitignore 存在');
else warnOf('.gitignore', '建议加一份（忽略 .env、tools/__pycache__ 等）');

/* ---------- 汇总 ---------- */
console.log('\n' + '-'.repeat(78));
console.log(out.join('\n'));
console.log('-'.repeat(78));
console.log(`通过 ${pass} 项 · 警告 ${warn} 项 · 失败 ${fail} 项`);
if (fail) {
  console.log('\n❌ 未通过发布检查。上面 ❌ 每一行都必须在提交前修掉。');
  process.exit(1);
}
console.log('\n✅ 通过发布检查：可进公开仓库，可断网演示。');
