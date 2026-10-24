/* =========================================================
   决策引擎 —— 纯函数，不碰 DOM，可在 Node 里离线单测
   ========================================================= */
(function (root) {
'use strict';

/* ---------- 伪随机（可复现，便于调试） ---------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function gauss(x, mu, sigma) { var d = (x - mu) / sigma; return Math.exp(-0.5 * d * d); }

/* ---------- 常量（都写成 conversations 里能解释的量） ---------- */
var RICE_BOWL = 200;      // 一碗米饭 ≈ 200 kcal
var WALK_KCAL = 9.5;      // 快走每分钟 ≈ 9.5 kcal
var WALK_SPEED = 80;      // 步行约 80 m/min

/* 饮品名识别：套餐默认子项里有没有带饮料 */
var DRINK_RE = /(可乐|雪碧|美式|咖啡|牛奶|豆浆|红茶|柠檬|橙|苹果汁|玉米|茶|水|芭依|怡泉|泡泡)/;

/* ---------- 目标 ----------
   关键词表按「用户真的会怎么说」扩写过一轮：
   第一版只有书面语（减肥/增肌/吃饱…），实测「想吃得满足一点」「性价比高一点」
   这种口语全部落空，界面只好弹「没能匹配到内置目标」——看着像大部分需求都接不住。
   现在每条目标都带口语同义词，匹配也从「首个命中」改成「命中数 × 词长」打分，
   一句话里出现多个目标信号时，证据多的那个赢。 */
var GOALS = [
  { key:'lose',    name:'减肥控卡',   kcal:430, protein:1.6, kw:['减肥','减脂','瘦身','控卡','低卡','轻食','不想胖','怕胖','刮油','掉秤','减重','降脂','低热量','低脂','不长胖','别长胖','控制体重','减肚子','卡路里','热量低','吃不胖','少长肉','减点儿肥','减点肥'] },
  { key:'bulk',    name:'增肌高蛋白', kcal:820, protein:2.2, kw:['增肌','蛋白','健身','撸铁','练肌肉','肌肉','高蛋白','补充蛋白','健身餐','运动后','增重','长肌肉','练练','壮一点','蛋白质'] },
  { key:'full',    name:'吃饱管饱',   kcal:810, protein:1.0, kw:['吃饱','管饱','很饿','饿','量大','顶饱','抗饿','吃到撑','大胃口','饿死了','填饱','饱腹','吃得饱','胃口大','饿得慌','充饥','满足','吃爽','垫肚子','先吃点'] },
  { key:'treat',   name:'请客聚餐',   kcal:770, protein:1.0, rich:1, kw:['请客','聚餐','招待','体面','朋友','生日','团建','约会','请吃','聚会','热闹','丰盛','吃顿好的','改善一下','犒劳','庆祝','搞丰盛','搞点好'] },
  { key:'new',     name:'尝鲜新品',   kcal:680, protein:1.0, novelty:1, kw:['尝鲜','新品','新上市','没吃过','限定','限定版','好奇','新款','新鲜','尝尝新','新口味','新出的','尝个鲜','试新','拔草','新花样'] },
  { key:'cheap',   name:'省钱第一',   kcal:640, protein:1.0, thrifty:1, kw:['省钱','便宜','穷','低预算','抠','廉价','最省','实惠','划算','性价比','少花钱','经济','省一点','节约','优惠点','花少点','省着点'] },
  { key:'kid',     name:'带孩子吃',   kcal:580, protein:1.2, kw:['孩子','小孩','儿童','宝宝','小朋友','女儿','儿子','亲子','遛娃','带娃','儿童餐','小孩吃'] },
  { key:'balance', name:'均衡就好',   kcal:670, protein:1.2, kw:['均衡','随便','都行','普通','正常','差不多','无所谓','一般','家常','营养均衡','均衡一点','没特别要求','不挑','均衡点'] }
];

/* 打分制目标匹配：每个目标累计「命中关键词的长度和」，分高者赢；
   并列时看最长命中词，再并列按 GOALS 顺序（保证可复现）。
   返回 { goal, score, hits }，hits 是命中的关键词列表，供界面解释「为什么这么理解」。 */
function matchGoal(text) {
  var t = (text || '').trim();
  if (!t) return { goal: null, score: 0, hits: [] };
  var best = null, bestScore = 0, bestLen = 0, bestHits = [];
  for (var i = 0; i < GOALS.length; i++) {
    var g = GOALS[i], score = 0, maxLen = 0, hits = [];
    for (var j = 0; j < g.kw.length; j++) {
      var k = g.kw[j];
      if (t.indexOf(k) >= 0) {
        score += k.length;
        if (k.length > maxLen) maxLen = k.length;
        hits.push(k);
      }
    }
    if (score > bestScore || (score === bestScore && score > 0 && maxLen > bestLen)) {
      best = g; bestScore = score; bestLen = maxLen; bestHits = hits;
    }
  }
  return { goal: best, score: bestScore, hits: bestHits };
}

function normGoal(text) {
  var t = (text || '').trim();
  if (!t) return Object.assign({}, GOALS[GOALS.length - 1], { custom: false });
  var m = matchGoal(t);
  if (m.goal) return Object.assign({}, m.goal, { custom: false, hits: m.hits });
  // 没匹配上：不假装懂，原样带着，用均衡的量化参数；hits 为空即「未识别」的依据
  return { key:'custom', name:t.slice(0, 12), kcal:670, protein:1.2, kw:[], custom:true, hits: [] };
}

/* ---------- 营业时段 ---------- */
function parseSlots(text) {
  var out = [], re = /([^\(（,，]+?)\(([^\)）]+)\)/g, m;
  while ((m = re.exec(text || ''))) out.push({ name: m[1].trim(), raw: m[2] });
  return out;
}
function currentSlot(slotsText, date) {
  var slots = parseSlots(slotsText);
  var now = (date.getHours() * 60 + date.getMinutes());
  for (var i = 0; i < slots.length; i++) {
    var re = /(\d{1,2}):(\d{2})至(\d{1,2}):(\d{2})/g, m;
    while ((m = re.exec(slots[i].raw))) {
      var a = (+m[1]) * 60 + (+m[2]), b = (+m[3]) * 60 + (+m[4]);
      if (a <= b ? (now >= a && now <= b) : (now >= a || now <= b)) return slots[i].name;
    }
  }
  return '';
}

/* ---------- 一道菜能顶几个人 / 是否自带饮料 ---------- */
function servings(d) {
  if (d.role === 'drink' || d.role === 'dessert') return 0;
  if (d.role === 'share') {
    var n = 0;
    (d.parts || []).forEach(function (p) { if (!DRINK_RE.test(p.name)) n += (p.qty || 1); });
    return clamp(n || 3, 2, 5);
  }
  if (d.role === 'side') return 0.45;
  if (d.role === 'chicken') return (d.kcal && d.kcal >= 300) ? 0.75 : 0.5;
  return 1;
}
function includesDrink(d) {
  if (d.role === 'drink') return true;
  if (!/件套|套餐|随心选|分享餐|乐园|双人|多人|桶/.test(d.name)) return false;
  var parts = d.parts || [];
  if (!parts.length) return true;           // 拿不到配方时，按麦当劳套餐惯例视为含饮
  return parts.some(function (p) { return DRINK_RE.test(p.name); });
}
function hasKcal(d) { return typeof d.kcal === 'number' && d.kcal > 0; }

/* ---------- 新品 / 活动识别 ----------
   官方数据里「新品」不在 taste 里，而在 tags（'上新' / '限定特惠'）和 dealType（促销优惠 / 随单购麦金卡优惠）。
   一开始用 taste.indexOf('新品') 判，恒 false，导致尝鲜版等于随机配 —— 这里按真实字段重做。 */
function hasTag(d, kw) {
  var t = d.tags || [];
  for (var i = 0; i < t.length; i++) if (t[i].indexOf(kw) >= 0) return true;
  return false;
}
function isNewDish(d) { return hasTag(d, '上新') || hasTag(d, '新品'); }   // 「限定」归活动，不算新品
function isPromoDish(d) {
  if (d.dealType) return true;                 // 促销优惠 / 随单购麦金卡优惠
  return hasTag(d, '限定特惠') || (d.taste || []).indexOf('促销') >= 0;
}

/* ---------- 输入校验 ---------- */
/* 非餐品：官方菜单里混着联名周边和单独售卖的酱料包，不能当饭配进方案 */
var NONFOOD_RE = /(棒球帽|水手帽|渔夫帽|丝巾|保温杯|水壶|玻璃杯|马克杯|公仔|玩偶|玩具|抱枕|抱枕被|鼠标垫|手提袋|购物袋|背包|徽章|贴纸|钥匙扣|按摩捶|痒痒挠|不求人)/;
function isFood(d) {
  if (NONFOOD_RE.test(d.name || '')) return false;
  // 单独售卖的蘸酱包（名字以「酱」收尾且价格极低），不是菜
  if (/酱$/.test((d.name || '').trim()) && d.price <= 6) return false;
  if (d.role === 'merch') return false;
  return true;
}
function hitAvoid(d, avoid) {
  for (var i = 0; i < avoid.length; i++) if (d.Avoid.indexOf(avoid[i]) >= 0) return true;
  return false;
}

/* ---------- 单套方案构造 ---------- */
function wpick(list, wfn, rnd) {
  if (!list.length) return null;
  var w = [], tot = 0, i;
  for (i = 0; i < list.length; i++) { var x = Math.max(1e-6, wfn(list[i])); w.push(x); tot += x; }
  var r = rnd() * tot;
  for (i = 0; i < list.length; i++) { r -= w[i]; if (r <= 0) return list[i]; }
  return list[list.length - 1];
}

function buildOnce(ctx, mode, rnd) {
  var N = ctx.people, G = ctx.goal;
  var cap = ctx.unlimited ? Infinity : ctx.bmax;
  var P = ctx.pools;
  var items = [], spent = 0, kcal = 0, protein = 0, nutKnown = 0, nutTotal = 0;
  var mainCover = 0, i;

  function rest() { return cap === Infinity ? Infinity : cap - spent; }
  function push(d, q) {
    q = q || 1;
    for (i = 0; i < items.length; i++) if (items[i].d.code === d.code) { items[i].q += q; return; }
    items.push({ d: d, q: q });
  }
  function recalc() {
    spent = kcal = protein = 0; nutKnown = nutTotal = 0; mainCover = 0;
    for (i = 0; i < items.length; i++) {
      var it = items[i], d = it.d;
      spent += d.price * it.q;
      if (hasKcal(d)) { kcal += d.kcal * it.q; protein += (d.protein || 0) * it.q; nutKnown += it.q; }
      nutTotal += it.q;
      mainCover += servings(d) * it.q;
    }
  }

  // ① 多人进行时，先赌一盘分享装（比一人一份更划算，也更符合聚餐场景）
  var wantShare = (N >= 3) && rnd() < (0.3 + 0.45 * mode);
  if (wantShare && P.share.length) {
    var sh = wpick(P.share, function (d) {
      return ctx.itemW(d, mode) * (d.price <= rest() ? 1 : 0.001) * (0.6 + 0.4 * mode);
    }, rnd);
    if (sh && sh.price <= rest()) { push(sh, 1); recalc(); }
  }

  // ② 主食（每个人一份，分享装已经顶掉几份）
  var guard = 0;
  while (mainCover < N - 0.35 && guard++ < 14) {
    var av = P.main.filter(function (d) { return d.price <= rest() + 1e-6; });
    if (!av.length) break;
    var m = wpick(av, function (d) { return ctx.itemW(d, mode); }, rnd);
    if (!m) break;
    push(m, 1); recalc();
    if (cap !== Infinity && spent > cap) { removeLast(); break; }
  }

  // ③ 小食 / 炸鸡
  var nSnack = Math.max(0, Math.round(N * (0.35 + 0.55 * mode)));
  guard = 0;
  while (nSnack > 0 && guard++ < 10) {
    var sAv = P.snack.filter(function (d) { return d.price <= rest() + 1e-6; });
    if (!sAv.length) break;
    var s = wpick(sAv, function (d) { return ctx.itemW(d, mode); }, rnd);
    if (!s) break;
    push(s, 1); recalc(); nSnack--;
    if (cap !== Infinity && spent > cap) { removeLast(); break; }
  }

  // ④ 饮料：主食里带饮的部分不再重复买
  var comboWithDrink = 0;
  for (i = 0; i < items.length; i++) comboWithDrink += includesDrink(items[i].d) * items[i].q;
  var needDrink = Math.max(0, N - comboWithDrink);
  guard = 0;
  while (needDrink > 0 && guard++ < 12) {
    var dAv = P.drink.filter(function (d) { return d.price <= rest() + 1e-6; });
    if (!dAv.length) break;
    var dr = wpick(dAv, function (d) { return ctx.itemW(d, mode) * (hasKcal(d) && d.kcal < 30 ? 1.6 : 1); }, rnd);
    if (!dr) break;
    push(dr, 1); recalc(); needDrink--;
    if (cap !== Infinity && spent > cap) { removeLast(); break; }
  }

  // ⑤ 甜品：预算松 / 目标偏「吃好」时才加
  var wantDessert = (mode > 0.55 || G.rich) && rnd() < (0.35 + 0.4 * mode);
  if (wantDessert && P.dessert.length) {
    var need = Math.max(1, Math.ceil(N / 3));
    guard = 0;
    while (need > 0 && guard++ < 8) {
      var dAv2 = P.dessert.filter(function (d) { return d.price <= rest() + 1e-6; });
      if (!dAv2.length) break;
      var de = wpick(dAv2, function (d) { return ctx.itemW(d, mode) * 0.9; }, rnd);
      if (!de) break;
      push(de, 1); recalc(); need--;
      if (cap !== Infinity && spent > cap) { removeLast(); break; }
    }
  }

  function removeLast() {
    var it = items.pop();
    if (!it) return;
    if (it.q > 1) { items.push({ d: it.d, q: it.q - 1 }); }
    recalc();
  }

  if (!items.length) return null;

  // 汇总（Atot = 原价合计）
  var orig = 0;
  for (i = 0; i < items.length; i++) orig += items[i].d.orig * items[i].q;
  return {
    items: items, total: Math.round(spent * 100) / 100, orig: Math.round(orig * 100) / 100,
    save: Math.round((orig - spent) * 100) / 100,
    kcal: Math.round(kcal), protein: Math.round(protein * 10) / 10,
    mainCover: mainCover, nutRate: nutTotal ? nutKnown / nutTotal : 0,
    unknown: items.filter(function (t) { return !hasKcal(t.d); })
  };
}

function scorePlan(p, ctx, mode) {
  var N = ctx.people, G = ctx.goal;

  // 主食有没有覆盖到每个人
  var coverErr = Math.max(0, N - p.mainCover);
  if (coverErr > 0.6) return -1e6 - coverErr * 1000;      // 有人没得吃，直接淘汰
  if (p.mainCover > N * 1.9) return -1e6;

  // 热量贴合
  var targetKcal = N * G.kcal;
  var kFit;
  if (p.kcal <= 0) kFit = 0.15;
  else kFit = G.key === 'lose'
    ? clamp(1 - Math.max(0, p.kcal - targetKcal) / (targetKcal * 0.75), 0, 1) * 0.85
        + gauss(p.kcal, targetKcal * 0.92, targetKcal * 0.42) * 0.15
    : gauss(p.kcal, targetKcal, targetKcal * 0.46);

  // 预算贴合：mode 决定在 [min,max] 区间里的落点
  var min = ctx.bmin || 0, cap = ctx.unlimited ? Infinity : ctx.bmax;
  var pFit;
  if (cap === Infinity) pFit = 0.62;
  else {
    var tPrice = min + (cap - min) * (0.48 + 0.44 * mode);
    pFit = gauss(p.total, Math.max(tPrice, cap * 0.45), Math.max(cap * 0.3, 12));
    if (p.total < min * 0.92) pFit *= 0.25;              // 比用户给出的下限还低
  }

  // 优惠力度
  var dealFit = p.orig > 0 ? clamp((p.orig - p.total) / p.orig / 0.32, 0, 1) : 0;

  // 蛋白质
  var proFit = clamp(p.protein / Math.max(1, N * 26 * G.protein), 0, 1);

  // 多样性：不同分类数 / 不同角色
  var cats = {}, roles = {};
  p.items.forEach(function (t) { cats[t.d.cat] = 1; roles[t.d.role] = 1; });
  var variety = clamp(objectKeys(cats).length / 4.2, 0, 1) * 0.6 + clamp(objectKeys(roles).length / 4, 0, 1) * 0.4;

  // 目标加分
  var goalBonus = 0;
    if (G.novelty) {
      p.items.forEach(function (t) {
        if (isNewDish(t.d)) goalBonus += 0.34;
        else if (isPromoDish(t.d)) goalBonus += 0.16;
      });
      goalBonus = clamp(goalBonus, 0, 1);
    } else if (G.thrifty) {
    goalBonus = clamp(1 - p.total / Math.max(1, cap === Infinity ? N * 45 : cap * 0.8), 0, 1);
  } else if (G.rich) {
    goalBonus = clamp(objectKeys(roles).length / 4, 0, 1) * 0.5 + clamp(p.items.length / (N * 2.4), 0, 1) * 0.5;
  } else if (G.protein >= 1.5) {
    goalBonus = proFit;
  } else {
    goalBonus = kFit;
  }

  // 营养数据完整度：优先推官方有数据的组合，热量那一栏才站得住
  var cov = p.nutRate;

  var W = 22 * pFit + 20 * kFit + 11 * dealFit + 11 * proFit
        + 9 * variety + 14 * goalBonus + 7 * cov + 6 * clamp(1 - Math.abs(1 - p.mainCover / N) * 1.4, 0, 1);
  return W / 100;
}

function objectKeys(o) { var r = []; for (var k in o) if (o.hasOwnProperty(k)) r.push(k); return r; }

function sig(p) {
  return p.items.map(function (t) { return t.d.code + 'x' + t.q; }).sort().join('|');
}

/* ---------- 主入口 ---------- */
function makePlans(opt) {
  var dishes = opt.dishes || [];
  var people = clamp(opt.people || 1, 1, 12);
  var avoid = opt.avoid || [];
  var bmin = Math.max(0, opt.bmin || 0);
  var bmax = opt.unlimited ? Infinity : Math.max(bmin, opt.bmax || 0);
  var goal = normGoal(opt.goal);
  var lateNight = !!opt.lateNight;
  var singlesOnly = !!opt.singlesOnly;

  // 菜品级排除：「不要可乐」「不要这道菜」——与忌口（成分级、安全优先）是两件事
  var excludeCodes = {};
  (opt.exclude || []).forEach(function (c) { if (c) excludeCodes[c] = true; });

  // 套餐拆解对照表（套餐值得度权重用）
  var byCodeAll = {};
  dishes.forEach(function (d) { if (d && d.code) byCodeAll[d.code] = d; });

  // 硬过滤：忌口 + 官方算价通过 + 剔除周边 / 单独酱料包等非餐品
  //        + 菜品级排除（用户点名不要的）+ 单点模式（套餐整体出局）
  var pool = dishes.filter(function (d) {
    if (d.ok !== true) return false;
    if (!isFood(d)) return false;
    if (hitAvoid(d, avoid)) return false;
    if (d.role === 'value') return false;
    if (excludeCodes[d.code]) return false;
    /* 单点畅吃：候选池排除套餐。官方分类把一部分套装（X三件套/X套餐）
     * 归在了「主食」里，只按 role 过滤会漏，这里按品名再补一刀。 */
    if (singlesOnly && (d.role === 'combo' || /(套餐|组合|桶|分享餐|件套)/.test(d.name || ''))) return false;
    return true;
  });

  var pools = {
    main: pool.filter(function (d) { return d.role === 'main' || d.role === 'combo'; }),
    share: pool.filter(function (d) { return d.role === 'share'; }),
    snack: pool.filter(function (d) { return d.role === 'side' || d.role === 'chicken'; }),
    drink: pool.filter(function (d) { return d.role === 'drink'; }),
    dessert: pool.filter(function (d) { return d.role === 'dessert'; })
  };
  if (!pools.main.length) return { error: '在当前忌口条件下，这家店已经没有可以当正餐的选项了' };

  /* ---- 点名菜先解析（配餐前就要解析，预算得给它预留位置） ----
   * 用户「想吃巨无霸」就必须出现在方案里。界面上「把这口加入我的条件」按钮一向只把菜名
   * 塞进输入框，引擎原来并不认——点了等于没点。现在把点名菜解析成真实菜品
   * （带规格层级惩罚，避免「麦辣鸡腿堡」对上「四件套」），配餐时预留出它的钱，
   * 再尽量塞进每一版；塞不进去的（忌口挡住 / 超预算 / 菜单里没有）进 unmetWanted，如实说明。 */
  var wantedResolved = [];
  (opt.wanted || []).forEach(function (w) {
    // 兼容两种传法：字符串（测试/简单调用）或 {name, fromCombo}（套餐拆开单点）
    var name = typeof w === 'string' ? w : (w && w.name);
    var fromCombo = typeof w === 'string' ? null : (w && w.fromCombo) || null;
    if (!name) return;
    var hit = pickBestDish(name, dishes.filter(function (d) { return d.ok === true && isFood(d); }));
    if (!hit) { wantedResolved.push({ name: name, reason: 'not-found' }); return; }
    if (hitAvoid(hit, avoid)) {
      wantedResolved.push({ name: hit.name, reason: 'avoid',
        avoid: avoid.filter(function (v) { return hit.Avoid.indexOf(v) >= 0; }) });
      return;
    }
    if (wantedResolved.some(function (x) { return x.dish === hit; })) return;
    wantedResolved.push({ name: hit.name, code: hit.code, dish: hit, reason: '', fromCombo: fromCombo });
  });

  // 点名菜预算预留：配餐阶段的有效上限先扣掉点名菜总价，别把钱花光导致点名菜插不进来
  var wantCost = 0;
  wantedResolved.forEach(function (w) { if (!w.reason && w.dish) wantCost += w.dish.price; });
  var bmaxEff = bmax;
  if (bmax !== Infinity && wantCost > 0) {
    var room = bmax - wantCost;
    // 预留后仍满足最低预算才预留；否则不预留（照常用全额预算配餐），
    // 点名菜插不进去时会如实进 unmetWanted，而不是假装成功
    if (room >= bmin) bmaxEff = room;
  }

  // 每件单品的偏好权重
  function itemW(d, mode) {
    var w = 1;
    w *= 1 + clamp((d.save || 0) / 12, 0, 1.3);                 // 有折扣的更香
    w *= comboWorthWeight(d, byCodeAll);                        // 套餐 vs 拆开单点：差价维度
    if (isNewDish(d)) w *= (goal.novelty ? 3.6 : 1.4);          // 官方 tags 里的「上新 / 限定」
    if (isPromoDish(d)) w *= (goal.novelty ? 1.8 : 1.25);       // 促销 / 麦金卡优惠
    if (d.taste.indexOf('人气') >= 0) w *= 1.35;                // 官方「人气热卖」标记
    if (hasKcal(d)) w *= 1.5;                                    // 官方有营养数据的优先，热量才有据可依
    // 宵夜模式：小食/炸鸡/饮品/甜品/分享规格加权，大份正餐略降。
    // 这是我们的偏好加权，不是官方分类——UI 必须注明
    if (lateNight) {
      if (d.role === 'side' || d.role === 'chicken' || d.role === 'drink' || d.role === 'dessert') w *= 1.9;
      else if (d.role === 'share') w *= 1.6;
      else if (d.role === 'main' && d.price >= 35) w *= 0.8;
    }
    if (goal.key === 'lose') {
      if (hasKcal(d) && d.kcal > 620) w *= 0.45;
      if ((d.protein || 0) > 22) w *= 1.5;
      if (d.taste.indexOf('清爽') >= 0) w *= 1.4;
      if (d.cat.indexOf('500') === 0) w *= 1.8;                  // 官方「500大卡套餐」分类
    }
    if (goal.protein >= 1.5 && (d.protein || 0) > 20) w *= 1.8;
    if (goal.thrifty) w *= Math.pow(28 / Math.max(6, d.price), 0.7);
    if (goal.kid && (d.cat.indexOf('开心乐园') >= 0 || d.name.indexOf('乐园') >= 0)) w *= 2.6;
    // 反向：目标不是带孩子时，儿童乐园餐不该出现在成人聚餐里（实测被配进过 3 人局）
    else if (d.cat.indexOf('开心乐园') >= 0 || /乐园餐|开心乐园/.test(d.name)) w *= 0.22;
    if (goal.rich) w *= (0.7 + 0.5 * mode);
    // 预算越高，越敢点贵的
    if (bmax !== Infinity) {
      var pp = bmaxEff / people;
      w *= Math.pow(clamp(pp / Math.max(6, d.price), 0.35, 2.4), 0.55 * (1 - mode * 0.6));
    }
    return w;
  }

  var ctx = { people: people, goal: goal, bmin: bmin, bmax: bmaxEff, unlimited: !!opt.unlimited, pools: pools, itemW: itemW };
  var MODES = [
    { k:'A', tier:'budget', mode:0.12, name:'省钱聚餐版', sub:'预算内把人均压到最低，主食一口不少',
      patch:function (g) { return { thrifty:1, novelty:0, rich:0, protein:Math.min(g.protein, 1.2) }; } },
    { k:'B', tier:'lean',   mode:0.50, name:'低卡高蛋白版', sub:'压热量、拉蛋白，超标的直接不吃',
      patch:function (g) { return { key:'lose', kcal:Math.min(g.kcal, 560), protein:Math.max(g.protein, 1.9), thrifty:0, novelty:0, rich:0 }; } },
    { k:'C', tier:'new',    mode:0.72, name:'新品活动尝鲜版', sub:'活动与新品标签优先，预算内尽量体面',
      patch:function (g) { return { novelty:1, thrifty:0, rich:0 }; } }
  ];

  var rnd = mulberry32(opt.seed || 20261024);
  var out = [];
  MODES.forEach(function (M, mi) {
    // 每档用自己的那份目标参数，人数/预算/忌口共享
    var ctx = { people: people, goal: Object.assign({}, goal, M.patch(goal)),
                bmin: bmin, bmax: bmaxEff, unlimited: !!opt.unlimited, pools: pools, itemW: itemW };
    var best = [], seen = {};
    for (var t = 0; t < 900; t++) {
      var p = buildOnce(ctx, M.mode, rnd);
      if (!p) continue;
      if (bmaxEff !== Infinity && p.total > bmaxEff + 1e-6) continue;
      var s = scorePlan(p, ctx, M.mode);
      if (s < -1e5) continue;
      var sg = sig(p);
      if (seen[sg]) continue;
      seen[sg] = 1;
      p.score = s;
      best.push(p);
      if (best.length > 40) break;
    }
    best.sort(function (a, b2) { return b2.score - a.score; });
    out[mi] = best;
  });

  // 三版不能长得一样：B 先用最高分，A/C 再挑与 B 明显不同的
  function pickBest(list, avoidSig) {
    for (var i = 0; i < list.length; i++) if (!avoidSig[list[i].sig_]) return list[i];
    return list[0];
  }
  out.forEach(function (l) { l.forEach(function (p) { p.sig_ = sig(p); }); });

  var chosen = new Array(3);
  var used = {};
  if (out[1] && out[1].length) { chosen[1] = out[1][0]; used[chosen[1].sig_] = 1; }
  chosen[0] = out[0] && out[0].length ? (pickCheapest(out[0], used, 0.10) || pickBest(out[0], used)) : null;
  if (chosen[0]) used[chosen[0].sig_] = 1;
  chosen[2] = out[2] && out[2].length ? pickBest(out[2], used) : null;

  // 三档只需互不相同；语义不同，不再强制价格单调
  // ——但 A 必须对得起「省钱」这个名字：同组高分候选里取最便宜的，
  //   否则会当场出现「省钱版 ¥28、低卡版 ¥24」这种一眼穿帮的组合。
  function pickCheapest(list, avoidSig, tol) {
    var pool = list.filter(function (p) { return !avoidSig[p.sig_]; });
    if (!pool.length) return null;
    var top = pool[0].score;
    var keep = pool.filter(function (p) { return p.score >= top - Math.abs(top) * tol; });
    if (!keep.length) keep = pool;
    var best = keep[0];
    keep.forEach(function (p) { if (p.total < best.total - 1e-6) best = p; });
    return best;
  }

  var plans = [];
  MODES.forEach(function (M, i) {
    var p = chosen[i] || (out[i] && out[i][0]);
    if (!p) return;
    plans.push(Object.assign({}, p, {
      k: M.k, tier: M.tier, name: M.name, sub: M.sub, people: people, goal: Object.assign({}, goal, M.patch(goal))
    }));
  });

  /* ---- 点名菜插入：wantedResolved 已在配餐前解析并预留预算 ----
   * 尽量塞进每一版；塞不进去的（超预算）进 unmetWanted，由 UI 如实说明。 */
  plans.forEach(function (p) {
    p.unmetWanted = [];
    var touched = false;
    wantedResolved.forEach(function (w) {
      if (w.reason) { p.unmetWanted.push({ name: w.name, reason: w.reason, avoid: w.avoid }); return; }
      var has = p.items.some(function (it) { return it.d.code === w.code; });
      if (has) return;
      var d = w.dish;
      if (bmax === Infinity || p.total + d.price <= bmax + 1e-6) {
        p.items.push({ d: d, q: 1 });
        touched = true;
      } else {
        p.unmetWanted.push({ name: w.name, reason: 'budget' });
      }
    });
    if (touched) {
      var spent = 0, orig = 0, kcal = 0, protein = 0, nutKnown = 0, nutTotal = 0, mainCover = 0;
      p.items.forEach(function (it) {
        spent += it.d.price * it.q;
        orig += it.d.orig * it.q;
        if (hasKcal(it.d)) { kcal += it.d.kcal * it.q; protein += (it.d.protein || 0) * it.q; nutKnown += it.q; }
        nutTotal += it.q;
        mainCover += servings(it.d) * it.q;
      });
      p.total = Math.round(spent * 100) / 100;
      p.orig = Math.round(orig * 100) / 100;
      p.save = Math.round((orig - spent) * 100) / 100;
      p.kcal = Math.round(kcal); p.protein = Math.round(protein * 10) / 10;
      p.mainCover = mainCover;
      p.nutRate = nutTotal ? nutKnown / nutTotal : 0;
      p.unknown = p.items.filter(function (t) { return !hasKcal(t.d); });
    }
  });

  if (!plans.length) {
    return {
      error: '这个预算 / 忌口组合下，没有凑出合适的方案',
      advice: [
        '把最高预算往上调一点（人均 ' + Math.round((pools.main[0] ? minPrice(pools.main) : 25)) + ' 元起才有主食）',
        '减少一条忌口试试',
        '把人数改小，先配一个人的，其他人照着点'
      ]
    };
  }
  return { plans: plans, pool: pool, goal: goal, people: people, wanted: wantedResolved,
           modes: { singlesOnly: singlesOnly, lateNight: lateNight } };
}

function minPrice(list) {
  var m = Infinity;
  list.forEach(function (d) { if (d.price < m) m = d.price; });
  return m;
}

/* ---------- 营养汇总（供界面展开区用） ---------- */
function nutritionOf(plan) {
  var t = { kcal: 0, protein: 0, fat: 0, carb: 0, sodium: 0, calcium: 0 };
  var rows = [];
  plan.items.forEach(function (it) {
    var d = it.d, q = it.q;
    if (hasKcal(d)) {
      var kk = d.kcal * q;
      t.kcal += kk; t.protein += (d.protein || 0) * q; t.fat += (d.fat || 0) * q;
      t.carb += (d.carb || 0) * q; t.sodium += (d.sodium || 0) * q; t.calcium += (d.calcium || 0) * q;
      rows.push({ name: d.name, q: q, kcal: kk, protein: (d.protein || 0) * q, fat: (d.fat || 0) * q,
                  carb: (d.carb || 0) * q, sodium: (d.sodium || 0) * q, calcium: (d.calcium || 0) * q, ok: true });
    } else {
      rows.push({ name: d.name, q: q, ok: false });
    }
  });
  ['kcal','protein','fat','carb','sodium','calcium'].forEach(function (k) { t[k] = Math.round(t[k] * 10) / 10; });
  return { total: t, rows: rows };
}

/* ------------------------------------------------ 分账
   三种口径：
     even    人均等分（最常用）
     byItem  按归属：谁点了什么谁付，公共项再均分
     byWeight 按权重（有人吃得多 / AA 但有人请客）

   统一用「最大余额法」落到分：先按整数分分配，再把余下的分按小数部分
   从大到小依次补给各份。这样保证 Σ各份 === 总额，绝不会出现差一分钱。
*/
function largestRemainder(weights, totalCents) {
  var n = weights.length;
  if (!n) return [];
  var sum = 0;
  weights.forEach(function (w) { sum += w; });
  if (sum <= 0) {                                  // 全 0 权重退化成均分
    weights = weights.map(function () { return 1; });
    sum = n;
  }

  var base = [], rema = [];
  for (var i = 0; i < n; i++) {
    var exact = totalCents * weights[i] / sum;
    var floor = Math.floor(exact);
    base.push(floor);
    rema.push({ i: i, r: exact - floor });
  }
  var left = totalCents - base.reduce(function (a, b) { return a + b; }, 0);
  // 余数大的先补；完全相等时按原始顺序，保证结果稳定可复现
  rema.sort(function (a, b) { return b.r - a.r || a.i - b.i; });
  for (var k = 0; k < Math.min(left, n); k++) base[rema[k].i] += 1;
  return base;
}

/**
 * @param {number} total   总额（元）
 * @param {object} opt
 *   mode     'even' | 'byItem' | 'byWeight'
 *   members  [{ name, weight?, code? }]
 *   items    byItem 时需要：[{ code|name, price, qty, owners:[成员下标] }]
 * @returns {{ mode, total, shares:[{name,amount,items}], method, balanced }}
 */
function splitBill(total, opt) {
  opt = opt || {};
  var mode = opt.mode || 'even';
  var members = (opt.members || []).map(function (m) {
    return typeof m === 'string' ? { name: m } : Object.assign({}, m);
  });
  var n = opt.people || members.length || 1;
  if (!members.length) {
    for (var i = 0; i < n; i++) members.push({ name: '第 ' + (i + 1) + ' 人' });
  }

  var totalCents = Math.round((parseFloat(total) || 0) * 100);
  var weights, itemMap = null;

  if (mode === 'byItem') {
    // 归属口径：先把每笔钱摊到点了它的人头上，得到一个应付款额，再按这个额度配权
    var raw = members.map(function () { return 0; });
    var items = opt.items || [];
    items.forEach(function (it) {
      var cents = Math.round((parseFloat(it.price) || 0) * (parseInt(it.qty, 10) || 1) * 100);
      var owners = (it.owners && it.owners.length) ? it.owners : null;
      if (!owners) {                               // 没人认领 = 公共项，全员均摊
        var each = cents / members.length;
        for (var i = 0; i < members.length; i++) raw[i] += each;
        return;
      }
      var per = cents / owners.length;
      owners.forEach(function (oi) { if (raw[oi] != null) raw[oi] += per; });
    });
    if (!items.length) {                           // 没给明细就退化成均分
      weights = members.map(function () { return 1; });
    } else {
      weights = raw;
    }
    itemMap = raw.map(function (c) { return Math.round(c) / 100; });
  } else if (mode === 'byWeight') {
    weights = members.map(function (m) { return parseFloat(m.weight) || 1; });
  } else {
    weights = members.map(function () { return 1; });
  }

  var cents = largestRemainder(weights, totalCents);
  var shares = members.map(function (m, i) {
    return {
      name: m.name || ('第 ' + (i + 1) + ' 人'),
      amount: Math.round(cents[i]) / 100,
      items: itemMap ? itemMap[i] : null
    };
  });

  var sum = shares.reduce(function (a, s) { return a + s.amount; }, 0);
  return {
    mode: mode,
    total: Math.round(totalCents) / 100,
    shares: shares,
    method: 'largest-remainder',
    balanced: Math.abs(sum - Math.round(totalCents) / 100) < 1e-9
  };
}

/* ------------------------------------------------ 套餐 vs 散件对比
   用户问：「套餐和散件搭配哪个更划算，现有网页能实现吗」——原来只闷头选，不告诉人。
   这里把每份套餐拆开按官方子项单点价重算，得到「比拆开单点省多少」。
   铁律：parts 里有查不到价的子项时，只按已知部分算并标 complete:false，
   绝不用估算价把窟窿填上。 */
function comboBreakdown(dish, byCode) {
  if (!dish || dish.role !== 'combo' || !dish.parts || !dish.parts.length || !byCode) return null;
  var total = 0, known = 0;
  dish.parts.forEach(function (p) {
    var sub = byCode[p.code];
    if (sub && typeof sub.price === 'number' && sub.price > 0) {
      total += sub.price * (p.qty || 1);
      known += 1;
    }
  });
  if (!known) return null;                      // 子项一个都对不上价，不硬算
  var save = Math.round((total - dish.price) * 100) / 100;
  return {
    partsTotal: Math.round(total * 100) / 100,
    comboPrice: Math.round(dish.price * 100) / 100,
    save: save,
    worthwhile: save >= 1,                      // 省不到 1 块不算「真划算」
    partsKnown: known,
    partsCount: dish.parts.length,
    complete: known === dish.parts.length
  };
}

/* ------------------------------------------------ 优惠券规则（券面解析）
   官方 available-coupons 只回标题/图片/状态，**不回券 code**——所以无论在线离线，
   都没法把券真正代入 calculate-price 试算（couponCode 无从得知）。
   这里做的是「按券面标题规则估算」，所有结果必须带 simulated:true。
   支持的标题形态（都是官方返回里真实出现的）：
     「免费脆薯饼」      → 免费单品
     「11.9元麦辣鸡腿堡」 → 指定品固定价
     「19.9元王牌炸鸡任选2」→ 指定品固定价（任选 N 只按 1 份估）
     「满30减5」/「满30减5元」→ 门槛满减
   认不出的形态返回 kind:'unknown'，估算收益 0，不装懂。 */
function parseCouponRule(title) {
  var t = (title || '').trim();
  if (!t) return { kind: 'unknown', raw: t };
  var m;
  if ((m = /^满\s*([\d.]+)\s*(?:元)?\s*减\s*([\d.]+)\s*(?:元)?/.exec(t))) {
    return { kind: 'threshold', minSpend: +m[1], cut: +m[2], raw: t };
  }
  if ((m = /^([\d.]+)\s*元\s*(.+)$/.exec(t))) {
    return { kind: 'fixed', price: +m[1], item: m[2].replace(/\s+/g, ''), raw: t };
  }
  if ((m = /^免费\s*(.+)$/.exec(t))) {
    return { kind: 'free', item: m[1].replace(/\s+/g, ''), raw: t };
  }
  if ((m = /^(.+?)\s*立减\s*([\d.]+)\s*(?:元)?/.exec(t))) {
    return { kind: 'threshold', minSpend: 0, cut: +m[2], item: m[1].replace(/\s+/g, ''), raw: t };
  }
  return { kind: 'unknown', raw: t };
}

/* 名字相像度打分：完全相等 > 菜单名包含用户说法 > 用户说法包含菜单名 > 共同前缀 ≥3 字。
 * 为什么需要前缀规则：官方券面写「11.9元麦辣鸡腿堡」，菜单里叫「麦辣鸡腿汉堡」——
 * 差一个「汉」字，互相包含全都失效，券就永远对不上菜品。
 * 为什么相等分最高、并列取短名：用户说「想吃巨无霸」要的是单品 ¥25.5，
 * 不是「巨无霸三件套」¥36.5；券写「麦辣鸡腿堡」对应的是汉堡，不是三件套。 */
function nameMatchScore(query, name) {
  if (!query || !name) return 0;
  if (query === name) return 1000 + name.length;
  if (name.indexOf(query) >= 0) return 500 + name.length;
  if (query.indexOf(name) >= 0) return 400 + name.length;
  var n = Math.min(query.length, name.length), i = 0;
  while (i < n && query.charAt(i) === name.charAt(i)) i++;
  return i >= 3 ? 100 + i : 0;
}

/* 规格层级词：三件套/桶/分享餐… 说法里没带、菜品名却带了，就不是同一个东西。
 * 实例：券面「11.9元麦辣鸡腿堡」指向 ¥22.5 的单品汉堡，
 * 而菜单里「麦辣鸡腿堡四件套」¥28 反而包含「麦辣鸡腿堡」五个字——
 * 不罚层级就会把券配到四件套上，估算收益全错。 */
var DISH_TIER_RE = /(三件套|四件套|五件套|双件套|件套|套餐|桶|分享餐|双人|多人|随心选|组合|任选)/;

function pickBestDish(query, dishes) {
  var best = null, bestScore = 0;
  (dishes || []).forEach(function (d) {
    var name = d.name || '';
    var s = nameMatchScore(query, name);
    if (s <= 0) return;
    if (DISH_TIER_RE.test(name) && !DISH_TIER_RE.test(query || '')) s = Math.min(s, 99);
    if (s > bestScore || (s === bestScore && best && name.length < (best.name || '').length)) {
      best = d; bestScore = s;
    }
  });
  return best;
}

/* 把券面规则对上菜单里的真实菜品：分数高者赢，并列取更接近用户原话的短名 */
function matchCouponDish(rule, dishes) {
  if (!rule || !rule.item || !dishes) return null;
  return pickBestDish(rule.item, dishes);
}

/* 估算某张券在这一单里能省多少（元）。认不出/用不上一律 0，不编。 */
function estimateCouponCut(rule, dish, subTotal) {
  if (!rule) return 0;
  if (rule.kind === 'threshold') {
    if (rule.minSpend > 0 && !(subTotal >= rule.minSpend)) return 0;
    return Math.max(0, rule.cut || 0);
  }
  if (rule.kind === 'fixed') {
    if (!dish || !(dish.price > 0)) return 0;
    return Math.max(0, Math.round((dish.price - rule.price) * 100) / 100);
  }
  if (rule.kind === 'free') {
    if (!dish || !(dish.price > 0)) return 0;
    return Math.round(dish.price * 100) / 100;   // 免费单品：按它的单价估
  }
  return 0;
}

/* ------------------------------------------------ 用餐方式：堂食 / 外送
   官方 calculate-price 的 orderType：1 = 到店自取（我们的快照价就是这一档），
   2 = 外送（麦乐送，还要 beType=2 + beCode；beCode 来自
   delivery-query-addresses → delivery-query-stores 链）。
   离线快照只有到店价：外送档的餐价与配送费一律「未估算」，不编。 */
var DINING_LABEL = { dineIn: '到店/堂食', delivery: '外送/麦乐送' };

/* 用餐方式文本解析：外送类说法 → 'delivery'；到店类说法 → 'dineIn'；没说 → null。
 * 没说就是没说，不默认堂食——UI 会把它当「未说明」处理，券的适用性据此分支。 */
function parseDining(text) {
  var t = text || '';
  if (/(外送|外卖|麦乐送|送到家|配送|送货|送到学校|送到公司|送到楼下)/.test(t)) return 'delivery';
  if (/(堂食|到店|店里吃|在店里|自取|得来速|打包|带走)/.test(t)) return 'dineIn';
  return null;
}

/* 券类型：券面标题分流。
   官方 available-coupons 只回名称/图片/状态，**没有适用范围字段**——类型只能从
   标题文字判断；判断不出就是 'unlabeled'（未标注），按通用券处理，
   并在账本里注明「官方券面未标注适用范围」，不装懂。
   在线模式另有 query-store-coupons 按 orderType 返回真实可用券，可覆盖此推断。 */
function parseCouponType(title) {
  var t = (title || '').trim();
  if (!t) return 'unlabeled';
  if (/(外送|麦乐送|配送|外卖|送到家)/.test(t)) return 'delivery';
  if (/(堂食|到店|自取|得来速|餐厅|店内)/.test(t)) return 'dineIn';
  return 'unlabeled';
}
var COUPON_TYPE_LABEL = { delivery: '外送券', dineIn: '堂食券', unlabeled: '未标注范围' };

/* 这张券在当前用餐方式下能不能用。返回 {ok, reason}，reason 是给人看的那句话。 */
function couponApplies(couponType, dining) {
  if (!dining) return { ok: true, reason: '' };              // 用户没说堂食/外送：不拦
  if (couponType === 'unlabeled') {
    return { ok: true, reason: '官方券面未标注适用范围，按通用券处理' };
  }
  if (couponType === dining) return { ok: true, reason: '' };
  return {
    ok: false,
    reason: '该券为' + (COUPON_TYPE_LABEL[couponType] || couponType) + '，当前是' +
      (DINING_LABEL[dining] || dining) + '单，不可用'
  };
}

/* ------------------------------------------------ 点餐模式：各自点 / 一人代点
   多人场景的两种组织方式（用户明确要求这是两个选择）：
     split     各自点——拆成每人一张小单，各用各的券
     together  一人点完所有人的——一张合单用一张券，按人均展示          */
function parseOrderMode(text) {
  var t = text || '';
  if (/(各点各|各自点|分开点|各付各|各买各|自己点自己的|AA|aa)/.test(t)) return 'split';
  if (/(一起点|一个人点|我请|帮大家点|帮着点|代点|合起来点|省事|点一份大家|大家分一份)/.test(t)) return 'together';
  return null;
}
var ORDER_MODE_LABEL = { split: '各自点', together: '一人点完所有人' };

/* ------------------------------------------------ 特色模式（用户点名要的两个）
   singlesOnly「哥/姐有钱，就喜欢单点」：候选池排除套餐，只出单点商品；
   lateNight  「宵夜模式」：偏好加权偏向小食/炸鸡/饮品/甜品/分享规格。
   注意：宵夜适合吃什么**没有官方分类**，这是我们自己的偏好加权，
   UI 必须注明，不能冒充官方标签。                                */
function parseModes(text) {
  var t = text || '';
  return {
    singlesOnly: /(单点|就要单点|只单点|不要套餐|不想吃套餐|有钱|拆开单点|单点就行|单点畅吃)/.test(t),
    lateNight: /(宵夜|夜宵|半夜|凌晨|深夜|夜猫|通宵|晚上饿|夜里想吃)/.test(t)
  };
}
var MODE_LABEL = { singlesOnly: '单点畅吃', lateNight: '宵夜模式' };

/* 套餐 vs 拆开单点：差价只是维度之一，但先把它算对。
   子项有官方价时：套餐价比子项单点合计低 ≥1 元 → 套餐本身划算，加权；
   拆开更便宜 ≥1 元 → 套餐不值这个价，降权。子项没价就原样返回，不猜。
   （热量/营养/喜好维度由 goal 权重与评分负责，不在这一个函数里重复。） */
function comboWorthWeight(dish, byCode) {
  if (!dish || dish.role !== 'combo' || !byCode) return 1;
  var cb = comboBreakdown(dish, byCode);
  if (!cb) return 1;
  if (cb.save >= 1) return 1.3;
  if (cb.save <= -1) return 0.72;
  return 1;
}

/* ------------------------------------------------ 多人拆单（问题一）
   把「总需求清单」按成员拆成各自的小单，再给每张小额单配一张券。
   约束与假设（全部对用户明示）：
     · 每张小单最多用 1 张券（官方未提供叠加规则，不假设能叠）
     · 券收益是券面规则估算（官方不回券 code，无法真试算）
     · 配送费只有在线模式拿得到真实值，离线不计入也不编   */
function buildSubOrders(items, members, owners) {
  // owners[i] = 第 i 个 item 的成员下标数组；空 = 公共项，全员均摊
  items = items || [];
  members = (members || []).map(function (m) { return typeof m === 'string' ? { name: m } : Object.assign({}, m); });
  if (!members.length) members = [{ name: '第 1 人' }];
  var n = members.length;
  var subs = members.map(function (m, i) {
    return { index: i, name: m.name || ('第 ' + (i + 1) + ' 人'), items: [], subtotal: 0 };
  });
  var raw = members.map(function () { return 0; });

  items.forEach(function (it, idx) {
    var price = parseFloat(it.price) || 0;
    var qty = parseInt(it.qty, 10) || 1;
    var cents = Math.round(price * qty * 100);
    var own = (owners && owners[idx]) || null;
    if (!own || !own.length) {                       // 公共项：全员均摊
      var each = cents / n;
      for (var i = 0; i < n; i++) {
        raw[i] += each;
        subs[i].items.push({ name: it.name, code: it.code, qty: qty, unitPrice: price,
                             shared: true, lineTotal: Math.round(each) / 100 });
        subs[i].subtotal += each;
      }
      return;
    }
    var per = cents / own.length;
    own.forEach(function (oi) {
      if (oi < 0 || oi >= n || raw[oi] == null) return;
      raw[oi] += per;
      subs[oi].items.push({ name: it.name, code: it.code, qty: qty, unitPrice: price,
                            shared: own.length > 1, lineTotal: Math.round(per) / 100 });
      subs[oi].subtotal += per;
    });
  });

  // 分账落分：最大余额法，保证 Σ各单 === 总额
  var cents = largestRemainder(raw, Math.round(items.reduce(function (s, it) {
    return s + (parseFloat(it.price) || 0) * (parseInt(it.qty, 10) || 1) * 100;
  }, 0)));
  subs.forEach(function (s, i) { s.subtotal = Math.round(cents[i]) / 100; });

  var total = subs.reduce(function (a, s) { return a + s.subtotal; }, 0);
  return { subOrders: subs, total: Math.round(total * 100) / 100, balanced: true };
}

/* 券分配：按估算收益从大到小贪心，一券一单、一单一券。
   返回每单分到的券 + 全单估算总减免。 */
function optimizeCoupons(subOrders, coupons, dishes) {
  subOrders = subOrders || [];
  coupons = (coupons || []).map(function (c) {
    var rule = c.rule || parseCouponRule(c.title || c.name || '');
    return { title: c.title || c.name || '', code: c.code || c.id || null, rule: rule,
             dish: matchCouponDish(rule, dishes) };
  });
  var used = {}, assigned = {};
  var cand = [];
  subOrders.forEach(function (s, si) {
    coupons.forEach(function (c, ci) {
      var cut = estimateCouponCut(c.rule, c.dish, s.subtotal);
      if (cut > 0) cand.push({ si: si, ci: ci, cut: cut });
    });
  });
  cand.sort(function (a, b) { return b.cut - a.cut || a.si - b.ci; });
  var totalCut = 0;
  cand.forEach(function (x) {
    if (used[x.ci] || assigned[x.si]) return;
    used[x.ci] = 1; assigned[x.si] = 1;
    var c = coupons[x.ci], s = subOrders[x.si];
    s.coupon = { title: c.title, code: c.code, estimatedCut: x.cut, rule: c.rule.kind };
    totalCut += x.cut;
  });
  subOrders.forEach(function (s) {
    if (!s.coupon) s.coupon = null;
    s.payAfterCoupon = Math.round((s.subtotal - (s.coupon ? s.coupon.estimatedCut : 0)) * 100) / 100;
    if (s.payAfterCoupon < 0) s.payAfterCoupon = 0;
  });
  return { totalCut: Math.round(totalCut * 100) / 100 };
}

var API = {
  GOALS: GOALS, normGoal: normGoal, matchGoal: matchGoal, parseSlots: parseSlots, currentSlot: currentSlot,
  servings: servings, includesDrink: includesDrink, hitAvoid: hitAvoid,
  makePlans: makePlans, nutritionOf: nutritionOf, hasKcal: hasKcal,
  splitBill: splitBill, largestRemainder: largestRemainder,
  comboBreakdown: comboBreakdown, comboWorthWeight: comboWorthWeight,
  nameMatchScore: nameMatchScore, pickBestDish: pickBestDish, isFood: isFood,
  parseCouponRule: parseCouponRule, matchCouponDish: matchCouponDish, estimateCouponCut: estimateCouponCut,
  parseCouponType: parseCouponType, couponApplies: couponApplies, parseDining: parseDining,
  DINING_LABEL: DINING_LABEL, COUPON_TYPE_LABEL: COUPON_TYPE_LABEL,
  parseOrderMode: parseOrderMode, ORDER_MODE_LABEL: ORDER_MODE_LABEL,
  parseModes: parseModes, MODE_LABEL: MODE_LABEL,
  buildSubOrders: buildSubOrders, optimizeCoupons: optimizeCoupons,
  RICE_BOWL: RICE_BOWL, WALK_KCAL: WALK_KCAL, WALK_SPEED: WALK_SPEED
};

root.MCDEngine = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;

})(typeof window !== 'undefined' ? window : globalThis);
