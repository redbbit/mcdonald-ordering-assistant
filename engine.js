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

/* ---------- 目标 ---------- */
var GOALS = [
  { key:'lose',    name:'减肥控卡',   kcal:430, protein:1.6, kw:['减肥','减脂','瘦身','控卡','低卡','轻食','不想胖','怕胖','刮油','掉秤'] },
  { key:'bulk',    name:'增肌高蛋白', kcal:820, protein:2.2, kw:['增肌','蛋白','健身','撸铁','练'] },
  { key:'full',    name:'吃饱管饱',   kcal:810, protein:1.0, kw:['吃饱','管饱','很饿','饿','量大','顶饱','抗饿'] },
  { key:'treat',   name:'请客聚餐',   kcal:770, protein:1.0, rich:1, kw:['请客','聚餐','招待','体面','朋友','生日','团建','约会','请吃'] },
  { key:'new',     name:'尝鲜新品',   kcal:680, protein:1.0, novelty:1, kw:['尝鲜','新品','新上市','没吃过','限定','限定版','好奇'] },
  { key:'cheap',   name:'省钱第一',   kcal:640, protein:1.0, thrifty:1, kw:['省钱','便宜','穷','低预算','抠','廉价','最省'] },
  { key:'kid',     name:'带孩子吃',   kcal:580, protein:1.2, kw:['孩子','小孩','儿童','宝宝','小朋友','女儿','儿子'] },
  { key:'balance', name:'均衡就好',   kcal:670, protein:1.2, kw:['均衡','随便','都行','普通','正常','差不多','无所谓'] }
];

function normGoal(text) {
  var t = (text || '').trim();
  if (!t) return Object.assign({}, GOALS[GOALS.length - 1], { custom: false });
  var hit = null, bestLen = 0;
  for (var i = 0; i < GOALS.length; i++) {
    for (var j = 0; j < GOALS[i].kw.length; j++) {
      var k = GOALS[i].kw[j];
      if (t.indexOf(k) >= 0 && k.length > bestLen) { hit = GOALS[i]; bestLen = k.length; }
    }
  }
  if (hit) return Object.assign({}, hit, { custom: false });
  // 没匹配上：不假装懂，原样带着，用均衡的量化参数
  return { key:'custom', name:t.slice(0, 12), kcal:670, protein:1.2, kw:[], custom:true };
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

  // 硬过滤：忌口 + 官方算价通过 + 剔除周边 / 单独酱料包等非餐品
  var pool = dishes.filter(function (d) {
    if (d.ok !== true) return false;
    if (!isFood(d)) return false;
    if (hitAvoid(d, avoid)) return false;
    if (d.role === 'value') return false;
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

  // 每件单品的偏好权重
  function itemW(d, mode) {
    var w = 1;
    w *= 1 + clamp((d.save || 0) / 12, 0, 1.3);                 // 有折扣的更香
    if (isNewDish(d)) w *= (goal.novelty ? 3.6 : 1.4);          // 官方 tags 里的「上新 / 限定」
    if (isPromoDish(d)) w *= (goal.novelty ? 1.8 : 1.25);       // 促销 / 麦金卡优惠
    if (d.taste.indexOf('人气') >= 0) w *= 1.35;                // 官方「人气热卖」标记
    if (hasKcal(d)) w *= 1.5;                                    // 官方有营养数据的优先，热量才有据可依
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
      var pp = bmax / people;
      w *= Math.pow(clamp(pp / Math.max(6, d.price), 0.35, 2.4), 0.55 * (1 - mode * 0.6));
    }
    return w;
  }

  var ctx = { people: people, goal: goal, bmin: bmin, bmax: bmax, unlimited: !!opt.unlimited, pools: pools, itemW: itemW };
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
                bmin: bmin, bmax: bmax, unlimited: !!opt.unlimited, pools: pools, itemW: itemW };
    var best = [], seen = {};
    for (var t = 0; t < 900; t++) {
      var p = buildOnce(ctx, M.mode, rnd);
      if (!p) continue;
      if (bmax !== Infinity && p.total > bmax + 1e-6) continue;
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
  chosen[0] = out[0] && out[0].length ? pickBest(out[0], used) : null;
  if (chosen[0]) used[chosen[0].sig_] = 1;
  chosen[2] = out[2] && out[2].length ? pickBest(out[2], used) : null;

  // 三档只需互不相同；语义不同，不再强制价格单调
  var plans = [];
  MODES.forEach(function (M, i) {
    var p = chosen[i] || (out[i] && out[i][0]);
    if (!p) return;
    plans.push(Object.assign({}, p, {
      k: M.k, tier: M.tier, name: M.name, sub: M.sub, people: people, goal: Object.assign({}, goal, M.patch(goal))
    }));
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
  return { plans: plans, pool: pool, goal: goal, people: people };
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

var API = {
  GOALS: GOALS, normGoal: normGoal, parseSlots: parseSlots, currentSlot: currentSlot,
  servings: servings, includesDrink: includesDrink, hitAvoid: hitAvoid,
  makePlans: makePlans, nutritionOf: nutritionOf, hasKcal: hasKcal,
  RICE_BOWL: RICE_BOWL, WALK_KCAL: WALK_KCAL, WALK_SPEED: WALK_SPEED
};

root.MCDEngine = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;

})(typeof window !== 'undefined' ? window : globalThis);
