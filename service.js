/* ==========================================================================
 * McAdvisor Service —— 数据服务契约层（WorkBuddy 端所有）
 *
 * 前端只调本文件暴露的方法，禁止直接读 window.MCD_DATA / window.MCDEngine
 * （数据形状是我的实现细节，随时可能改；这里的返回值形状才是契约）。
 *
 * 数据来源：麦当劳官方 MCP（query-nearby-stores / query-meals /
 *           list-nutrition-foods / calculate-price / query-meal-detail）
 * 采集方式：构建期由 tools/build_data.py 真调 MCP 落快照 + 122 张官方图本地化
 *           → 运行时零网络请求，file:// 双击即可打开，断网可演示
 * 红线    ：代码里没有、也不会有 create-order；算价只到 calculate-price
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.McAdvisor = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /* ---------------- 官方图域名白名单（非白名单一律返回占位图） ---------------- */
  var IMG_HOSTS = [
    'menu-img.mcd.cn', 'img.mcd.cn', 'cms-cdn.mcd.cn',
    'mcd-portal-prod-cos1-1300270282.cos.ap-shanghai.myqcloud.com'
  ];
  var PLACEHOLDER =
    'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">' +
      '<rect width="320" height="320" fill="#2a1608"/>' +
      '<text x="160" y="150" fill="#FFC72C" font-size="26" font-family="sans-serif" text-anchor="middle">官方图未提供</text>' +
      '<text x="160" y="190" fill="#9a8a7a" font-size="16" font-family="sans-serif" text-anchor="middle">占位图 · 非 MCP 素材</text>' +
      '</svg>');

  function isOfficialImg(url) {
    if (!url) return false;
    if (url.slice(0, 5) === 'data:') return true;
    var m = /^https?:\/\/([^/]+)/.exec(url);
    if (!m) return false;
    for (var i = 0; i < IMG_HOSTS.length; i++) if (m[1].indexOf(IMG_HOSTS[i]) >= 0) return true;
    return false;
  }

  /* ---------------- 图片：本地优先 → 官方直链 → 占位 ----------------
   * 返回 string。契约对象里另给 imageLocal / imageRemote 两个字段，
   * 前端请在 <img onerror> 里依次降级，不要只用这一个返回值。            */
  function resolveImage(url, localPath) {
    if (localPath) return localPath;
    if (isOfficialImg(url)) return url;
    return PLACEHOLDER;
  }

  /* ---------------- 忌口：别名 → 数据里真实的 Avoid 取值 ---------------- */
  /* key 必须等于数据里真实的 Avoid 取值（辣/鸡肉/牛肉/猪肉/乳制品/咖啡因/高糖/海鲜/鸡蛋），
   * 不能凭空造一个 UI 选项，否则 hitAvoid 精确匹配不到，勾了等于没勾。 */
  var AVOID_ALIAS = {
    '辣': ['麻辣', '香辣', '重辣', '怕辣'],
    '鸡肉': ['鸡', '炸鸡', '鸡排', '鸡翅'],
    '牛肉': ['牛', '牛排', '牛肉饼'],
    '猪肉': ['猪', '猪柳', '培根', '火腿', '香肠'],
    '海鲜': ['海鲜', '虾', '蟹', '鱼', '鳕鱼', '鱿鱼'],
    '乳制品': ['奶', '牛奶', '芝士', '奶酪', '冰淇淋', '雪冰', '新地'],
    '咖啡因': ['咖啡', '茶', '提神'],
    '高糖': ['糖', '甜', '甜品', '太甜', '控糖', '戒糖'],
    '鸡蛋': ['蛋', '鸡蛋']
  };
  var NEG_RE = /(不|别|忌|戒|不要|不吃|拒绝|讨厌|过敏|不能吃|吃不了|排斥)/;

  /* ---------------- 自然语言 → AdvisorQuery ----------------
   * 解析失败不抛错：给默认值 + matchedReason，UI 照常能跑，不会卡住。   */
  function parseQuery(input) {
    var raw = (typeof input === 'string') ? input : (input || {}).text || '';
    var t = raw.replace(/\s+/g, ' ');
    var q = {
      text: t,
      people: 1,
      budgetMin: 0,
      budgetMax: null,      // null = 无限预算
      unlimited: true,      // 没写钱就是不限
      goal: '',
      avoid: [],
      taste: [],
      slot: null,
      matched: { people: false, budget: false, goal: false, avoid: [] }
    };
    if (input && typeof input === 'object') {
      if (input.people) q.people = input.people;
      if (input.budgetMin != null) q.budgetMin = input.budgetMin;
      if (input.budgetMax != null) q.budgetMax = input.budgetMax;
      if (input.unlimited != null) q.unlimited = !!input.unlimited;
      if (input.goal) q.goal = input.goal;
      if (input.avoid) q.avoid = input.avoid.slice();
      if (input.taste) q.taste = input.taste.slice();
    }

    /* 人数：阿拉伯数字 + 中文数字 */
    var CN = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    var m = /([0-9]+|[一二两三四五六七八九十])\s*(个人|人|位|位朋友|号人)/.exec(t);
    if (m) {
      q.people = CN[m[1]] || parseInt(m[1], 10);
      q.matched.people = true;
    } else if (/(双人|两个人)/.test(t)) { q.people = 2; q.matched.people = true; }
    else if (/单人|一个人|自己吃/.test(t)) { q.people = 1; q.matched.people = true; }
    q.people = Math.max(1, Math.min(12, q.people || 1));

    /* 预算：无限 / 区间 / 上限 / 下限 */
    if (/(无限预算|不限预算|不封顶|随便花|不差钱|多少钱都行|不确定预算)/.test(t)) {
      q.unlimited = true; q.budgetMax = null; q.matched.budget = true;
    } else {
      var b;
      b = /([0-9]{1,4})\s*[-~—－至到]\s*([0-9]{1,4})\s*(块|元|块钱|rmb|RMB)?/.exec(t);
      if (b) {
        q.budgetMin = Math.min(+b[1], +b[2]); q.budgetMax = Math.max(+b[1], +b[2]);
        q.unlimited = false; q.matched.budget = true;
      }
      if (!q.matched.budget) {
        b = /(预算|花|控制在|控制在|便宜点)?\s*([0-9]{1,4})\s*(块|元|块钱|rmb|RMB)?\s*(以内|以下|之内|封顶|左右|出头|搞定)/.exec(t);
        if (b) { q.budgetMin = 0; q.budgetMax = +b[2]; q.unlimited = false; q.matched.budget = true; }
      }
      if (!q.matched.budget && input && typeof input === 'object' && input.budgetMax != null) {
        q.unlimited = false;
      }
    }
    if (q.budgetMax != null) { q.budgetMax = Math.max(q.budgetMin, q.budgetMax); q.unlimited = false; }

    /* 目标：整句留给用户，量化由引擎 normGoal 负责 */
    if (t) q.goal = q.goal || t;

    /* 忌口：否定词 + 食材同现才算，避免「3个人吃炸鸡」被误判成忌鸡肉 */
    Object.keys(AVOID_ALIAS).forEach(function (v) {
      var keys = [v].concat(AVOID_ALIAS[v]), hit = false, i, idx, win;
      for (i = 0; i < keys.length; i++) {
        idx = t.indexOf(keys[i]);
        if (idx < 0) continue;
        win = t.slice(Math.max(0, idx - 6), idx);
        if (NEG_RE.test(win) || NEG_RE.test(t.slice(idx, idx + keys[i].length + 5))) { hit = true; break; }
      }
      if (hit && q.avoid.indexOf(v) < 0) { q.avoid.push(v); q.matched.avoid.push(v); }
    });

    return q;
  }

  /* ---------------- 工厂：注入数据 + 引擎，便于 Node 侧单测 ---------------- */
  /* ---------------- 多时段 ----------------
   * 麦当劳不同时段卖的菜不一样（实测同一家店：下午茶 122 款 / 夜市 120 款），
   * 而 query-meals 没有"指定时段"参数，服务端按调用时刻返回 —— 所以想要的
   * 时段只能在那个时段里真的去调一次。每份快照一个文件：
   *   data/menu_data.js          → window.MCD_DATA          （默认）
   *   data/menu_data_night.js    → window.MCD_DATA_NIGHT
   * 全量用 <script> 引入（file:// 下最稳），运行时用 key 切换，不联网。   */
  var SLOT_ORDER = ['breakfast', 'lunch', 'teatime', 'night', 'latenight'];
  var SLOT_LABEL = {
    breakfast: '早餐', lunch: '正餐', teatime: '下午茶',
    night: '夜市', latenight: '宵夜'
  };

  function scope() {
    return (typeof window !== 'undefined' ? window : null) ||
      (typeof globalThis !== 'undefined' ? globalThis : null) || {};
  }

  function dataOf(slot) {
    var w = scope();
    if (!slot) return w.MCD_DATA || null;
    return w['MCD_DATA_' + String(slot).toUpperCase()] || null;
  }

  function slotInfo(key, d) {
    // 这里在 createService 之外，拿不到 E，用同规则的本地解析（engine.parseSlots 的等价写法）
    var wraps = [], re = /([^\(（,，]+?)\(([^\)）]+)\)/g, m;
    while ((m = re.exec((d.store && d.store.slotText) || ''))) {
      wraps.push({ name: m[1].trim(), raw: m[2] });
    }
    var hasKcal = function (x) { return typeof x.kcal === 'number' && x.kcal > 0; };
    return {
      key: key,
      label: (d.slotLabel) || SLOT_LABEL[key] || (d.slot ? d.slot : '当前时段'),
      global: 'MCD_DATA' + (key ? '_' + String(key).toUpperCase() : ''),
      fetchedAt: d.fetchedAt || null,
      dishCount: (d.dishes || []).length,
      verifiedCount: (d.dishes || []).filter(function (x) { return x.ok === true; }).length,
      nutritionCount: (d.dishes || []).filter(hasKcal).length,
      timeRanges: wraps.map(function (r) { return { name: r.name, range: r.raw }; }),
      available: true
    };
  }

  function listSlots() {
    var out = [];
    var def = dataOf(null);
    if (def) out.push(slotInfo(def.slot || '', def));
    SLOT_ORDER.forEach(function (k) {
      var d = dataOf(k);
      if (d) out.push(slotInfo(k, d));
    });
    // 同一时段可能被重复登记（默认文件正好也是某个时段），按 key 去重
    var seen = {}, uniq = [];
    out.forEach(function (s) {
      if (seen[s.key]) return;
      seen[s.key] = 1;
      uniq.push(s);
    });
    return uniq;
  }

  function createService(opt) {
    opt = opt || {};
    var DATA = opt.data || (opt.slot ? dataOf(opt.slot) : null) ||
      (typeof window !== 'undefined' ? window.MCD_DATA : null) ||
      (typeof globalThis !== 'undefined' ? globalThis.MCD_DATA : null);
    var E = opt.engine || (typeof window !== 'undefined' ? window.MCDEngine : null) ||
      (typeof require === 'function' ? require('./engine.js') : null);

    if (!DATA) throw new Error('MCD_DATA 未加载：请确保 data/menu_data.js 先于 service.js 引入');
    if (!E) throw new Error('MCDEngine 未加载：请确保 engine.js 先于 service.js 引入');

    // 活动日历是独立文件（data/campaigns.js），可选：没加载就降级，不挡主流程
    var CAMP = opt.campaigns ||
      (typeof window !== 'undefined' ? window.MCD_CAMPAIGNS : null) ||
      (typeof globalThis !== 'undefined' ? globalThis.MCD_CAMPAIGNS : null) || null;

    var DISHES = DATA.dishes || [];
    var byCode = {};
    DISHES.forEach(function (d) { byCode[d.code] = d; });

    /* 计划注册表：recommendPlans 之后按 planId 回溯 */
    var plans = {};
    var seq = 0;

    function p(v) { return Promise.resolve(v); }
    function round(v, n) { var d = (n == null ? 2 : n); var k = Math.pow(10, d); return Math.round(v * k) / k; }
    function yuan(v) { return '¥' + (Math.round(v * 100) / 100).toFixed(2).replace(/\.00$/, ''); }

    /* 单个 dish → 官方营养。不可编造：查不到就是 null */
    function nutritionOfDish(d) {
      if (!E.hasKcal(d)) return null;
      var partial = d.nutSrc === 'sum-partial';
      return {
        kcal: d.kcal, protein: d.protein, fat: d.fat, carbs: d.carb,
        sodium: d.sodium, calcium: d.calcium,
        source: d.nutSrc === 'direct' ? 'official' : 'sum-of-parts',
        partial: partial,
        note: partial ? '组合餐子项中部分无官方数据，此值为下限' :
          (d.nutSrc === 'sum' ? '由官方套餐子项（query-meal-detail）逐项累加' : '麦当劳官方营养表')
      };
    }

    function itemOf(it) {
      var d = it.d;
      return {
        productCode: d.code, name: d.name, cat: d.cat,
        image: resolveImage(d.img, d.imgLocal),
        imageLocal: d.imgLocal || null,
        imageRemote: d.img || null,
        imageSource: '麦当劳官方 MCP',
        quantity: it.q,
        price: round(d.price * it.q), unitPrice: d.price,
        originalPrice: round(d.orig * it.q),
        role: d.role === 'combo' ? 'main' : d.role,
        tags: (d.tags || []).slice(),
        newTags: buildNewTags(d), promoTags: buildPromoTags(d),
        dealType: d.dealType || '',
        parts: (d.parts || []).map(function (x) { return { code: x.code, name: x.name, qty: x.qty }; }),
        availability: d.ok === true ? 'ok' : 'soldout',
        nutrition: nutritionOfDish(d)
      };
    }

    function buildNewTags(d) {
      var out = [];
      (d.tags || []).forEach(function (t) { if (/上新|新品/.test(t)) out.push(t); });
      return out;
    }
    function buildPromoTags(d) {
      var out = [];
      if (d.dealType) out.push(d.dealType);
      (d.tags || []).forEach(function (t) { if (/特惠|限定|优惠|省\d/.test(t) && out.indexOf(t) < 0) out.push(t); });
      if ((d.taste || []).indexOf('促销') >= 0) out.push('促销');
      return out;
    }
    function isNew(d) { return buildNewTags(d).length > 0; }
    function isPromo(d) { return buildPromoTags(d).length > 0; }

    /* ---------------- getMeta ---------------- */
    function getMeta() {
      return p({
        store: {
          code: DATA.store.code, name: DATA.store.name,
          address: DATA.store.address, distance: DATA.store.distance,
          hours: DATA.store.hours, slotText: DATA.store.slotText,
          slotNow: E.currentSlot(DATA.store.slotText, new Date())
        },
        fetchedAt: DATA.fetchedAt,
        source: DATA.source,
        dishCount: DISHES.length,
        verifiedCount: DISHES.filter(function (d) { return d.ok === true; }).length,
        nutritionCount: DISHES.filter(E.hasKcal).length,
        mcpTools: ['query-nearby-stores', 'query-meals', 'query-meal-detail',
          'list-nutrition-foods', 'available-coupons', 'calculate-price',
          'campaign-calendar']
      });
    }

    /* ---------------- getShowcase：右侧广告板数据源 ----------------
     * 排序：新品 → 活动促销 → 人气。全部带真实官方图，不带图的不要。 */
    function getShowcase(limit) {
      limit = limit || 12;
      var pool = DISHES.filter(function (d) {
        return d.ok === true && (d.imgLocal || d.img) && d.role !== 'merch';
      });
      function rank(d) {
        if (isNew(d) && isPromo(d)) return 0;
        if (isNew(d)) return 1;
        if (isPromo(d)) return 2;
        if ((d.taste || []).indexOf('人气') >= 0 || d.cat === '人气热卖') return 3;
        return 4;
      }
      var list = pool.slice().sort(function (a, b) {
        var r = rank(a) - rank(b);
        if (r) return r;
        return (b.orig - b.price) - (a.orig - a.price);   // 优惠力度大的在前
      });

      // 四路交替穿插：新品+活动 → 新品 → 活动 → 人气，滚动起来有节奏，
      // 也避免板子上清一色全是同一个标签
      var np = list.filter(function (d) { return isNew(d) && isPromo(d); });
      var n1 = list.filter(function (d) { return isNew(d) && !isPromo(d); });
      var p1 = list.filter(function (d) { return isPromo(d) && !isNew(d); });
      var hot = list.filter(function (d) {
        return !isNew(d) && !isPromo(d) && ((d.taste || []).indexOf('人气') >= 0 || d.cat === '人气热卖');
      });
      var seen = {}, merged = [];
      function push(d) { if (!d || seen[d.code]) return; seen[d.code] = 1; merged.push(d); }
      var maxLen = Math.max(np.length, n1.length, p1.length, hot.length);
      for (var i = 0; i < maxLen; i++) { push(np[i]); push(n1[i]); push(p1[i]); push(hot[i]); }
      list.forEach(push);

      return p(merged.slice(0, limit).map(function (d) {
        return {
          productCode: d.code, name: d.name, cat: d.cat,
          image: resolveImage(d.img, d.imgLocal),
          imageLocal: d.imgLocal || null, imageRemote: d.img || null,
          imageSource: '麦当劳官方 MCP',
          price: d.price, originalPrice: d.orig, discount: round(d.orig - d.price),
          tags: dedupe(buildNewTags(d).concat(buildPromoTags(d), (d.tags || []).slice(0, 2))),
          isNew: isNew(d), isPromo: isPromo(d),
          dealType: d.dealType || '',
          source: '麦当劳官方 MCP',
          hint: '把这口加入我的条件'
        };
      }));
    }

    /* ---------------- getCampaigns：活动 / 券 ----------------
     * coupons 来自 available-coupons（真可领）；promos 来自菜单活动标签。
     * 诚实标注：campaign-calendar 尚未接入，标签源不说谎。               */
    function getCampaigns() {
      var coupons = (DATA.coupons || []).filter(function (c) { return c.title.indexOf('###') !== 0; })
        .map(function (c) {
          return {
            type: 'coupon', title: c.title,
            image: resolveImage(c.img, c.imgLocal),
            imageLocal: c.imgLocal || null, imageRemote: c.img || null,
            imageSource: '麦当劳官方 MCP', source: '麦当劳官方 MCP · available-coupons'
          };
        });
      var promos = DISHES.filter(function (d) { return d.ok === true && (isPromo(d) || isNew(d)); })
        .slice(0, 10).map(function (d) {
          return {
            type: 'promo', productCode: d.code, title: d.name, price: d.price, originalPrice: d.orig,
            tags: buildNewTags(d).concat(buildPromoTags(d)),
            image: resolveImage(d.img, d.imgLocal), imageLocal: d.imgLocal || null,
            imageSource: '麦当劳官方 MCP', source: '麦当劳官方 MCP · 菜单活动标签'
          };
        });

      // 官方活动日历（campaign-calendar）—— 独立数据源，真正在跑了
      function pack(list) {
        return list.map(function (c) {
          return {
            type: 'campaign', date: c.date, phase: c.phase,
            title: c.title, desc: c.desc,
            image: resolveImage(c.img, c.imgLocal),
            imageLocal: c.imgLocal || null, imageRemote: c.img || null,
            imageSource: '麦当劳官方 MCP',
            mentions: c.mentions || [],                 // 文案里提到的菜品名，可与菜单挂钩
            source: '麦当劳官方 MCP · campaign-calendar'
          };
        });
      }
      var all = CAMP ? (CAMP.items || []) : [];
      var today = pack(all.filter(function (c) { return c.phase === 'today'; }));
      var upcoming = pack(all.filter(function (c) { return c.phase === 'upcoming'; }));
      var past = pack(all.filter(function (c) { return c.phase === 'past'; }));

      return p({
        coupons: coupons, promos: promos,
        // 活动日历（三个分面都用，主推 today）
        campaigns: all.length ? pack(all) : [],
        today: today, upcoming: upcoming, past: past,
        campaignCalendarLinked: all.length > 0,
        campaignCalendar: all.length ? {
          fetchedAt: CAMP.fetchedAt, source: CAMP.source,
          count: CAMP.count, phases: CAMP.phases
        } : null,
        note: all.length
          ? 'campaign-calendar 已接入：今日 ' + today.length + ' / 即将 ' + upcoming.length +
            ' / 往期 ' + past.length + ' 条，均为麦当劳官方返回'
          : 'campaign-calendar 数据文件未加载；活动标签回落到菜单 tags / dealType 官方字段'
      });
    }

    /* ---------------- recommendPlans：固定三版 ---------------- */
    function recommendPlans(query) {
      // 无论传字符串还是结构化对象，都统一过一遍解析器，保证字段齐全
      var q = parseQuery(query);
      if (!q.people) q.people = 1;

      var res = E.makePlans({
        dishes: DISHES, people: q.people, avoid: q.avoid,
        bmin: q.budgetMin || 0, bmax: q.budgetMax == null ? 0 : q.budgetMax,
        unlimited: q.unlimited || q.budgetMax == null,
        goal: q.goal
      });

      if (res.error) {
        return Promise.reject(Object.assign(
          new Error(res.error), { code: 'NO_PLAN', advice: res.advice || [] }));
      }

      var out = res.plans.map(function (raw) {
        return toPlan(raw, q, res.goal);
      });
      return p(out);
    }

    function toPlan(raw, q, goal) {
      var items = raw.items.map(itemOf);
      var N = raw.people || 1;
      var plannerGoal = raw.goal || goal;          // 该档自己的目标参数
      var targetPer = plannerGoal.kcal || 670;
      var targetAll = targetPer * N;
      var nut = E.nutritionOf(raw);
      var hasAnyKcal = items.some(function (i) { return i.nutrition; });
      var knownN = items.filter(function (i) { return i.nutrition; }).length;
      var unknownNames = items.filter(function (i) { return !i.nutrition; }).map(function (i) { return i.name; });

      seq += 1;
      var planId = 'plan-' + raw.tier + '-' + seq;

      var plan = {
        planId: planId,
        tier: raw.tier,                                    // 'budget' | 'lean' | 'new'
        title: raw.name,
        subtitle: raw.sub,
        why: buildWhy(raw, N, q, targetPer, unknownNames),

        people: N,
        items: items,
        itemCount: items.length,

        totalPrice: round(raw.total),
        originalPrice: round(raw.orig),
        discount: round(raw.save),
        perPersonPrice: round(raw.total / N),

        budgetMin: q.budgetMin, budgetMax: q.unlimited ? null : q.budgetMax,
        unlimited: !!q.unlimited,
        withinBudget: q.unlimited ? true : raw.total <= (q.budgetMax || 0) + 1e-6,

        totalCalories: hasAnyKcal ? round(nut.total.kcal, 0) : null,
        perPersonCalories: hasAnyKcal ? round(nut.total.kcal / N, 0) : null,
        targetCaloriesPerPerson: targetPer,
        targetCaloriesTotal: targetAll,
        // UI 第 6 条用：明示「目标有没有匹配上」，没匹配上必须如实提示，不许假装听懂
        goalInfo: (function () {
          // recognized 一律按「用户自己填的那句话」判定，不按某档的内部参数——
          // 否则低卡档永远显示 key='lose'，UI 会误报"目标已识别"
          var ug = (typeof E.normGoal === 'function' && q.goal) ? E.normGoal(q.goal) : { custom: true };
          return {
            key: plannerGoal.key || 'custom',
            label: plannerGoal.name || '',
            kcal: targetPer,
            protein: plannerGoal.protein || null,
            userText: q.goal || '',
            custom: !!ug.custom,
            recognized: !ug.custom
          };
        })(),
        // over=null 表示因缺官方数据无法判定，不能硬说没超
        overCalories: hasAnyKcal ? Math.max(0, round(nut.total.kcal - targetAll, 0)) : null,
        calorieKnown: hasAnyKcal,
        // 'fit' 达标 / 'over' 超目标（预算下限和低卡冲突时会真超）/ 'unknown' 官方无数据
        calorieVerdict: !hasAnyKcal ? 'unknown' : (nut.total.kcal <= targetAll * 1.05 ? 'fit' : 'over'),

        nutrition: hasAnyKcal ? {
          kcal: round(nut.total.kcal, 0), protein: round(nut.total.protein, 1),
          fat: round(nut.total.fat, 1), carbs: round(nut.total.carb, 1),
          sodium: round(nut.total.sodium, 0), calcium: round(nut.total.calcium, 0),
          source: 'official', partial: unknownNames.length > 0,
          note: unknownNames.length ? '含 ' + unknownNames.length + ' 款官方未提供营养数据，合计为下限' : '全部来自麦当劳官方数据'
        } : null,
        nutritionRows: nut.rows.map(function (r) {
          return {
            name: r.name, quantity: r.q, known: !!r.ok,
            kcal: r.ok ? round(r.kcal, 0) : null,
            protein: r.ok ? round(r.protein, 1) : null,
            fat: r.ok ? round(r.fat, 1) : null,
            carbs: r.ok ? round(r.carb, 1) : null,
            sodium: r.ok ? round(r.sodium, 0) : null,
            calcium: r.ok ? round(r.calcium, 0) : null
          };
        }),
        nutritionCoverage: round(knownN / Math.max(1, items.length), 2),
        unknownItems: unknownNames,

        newTags: collect(items, 'newTags'),
        promoTags: collect(items, 'promoTags'),
        couponHints: [],

        availability: 'ok',
        // 构建期已用 calculate-price 逐款校验，售罄的进不了候选池，故运行时恒为空
        unavailableReplacements: [],
        mcpNote: '构建期 calculate-price 逐款校验通过 ' +
          DISHES.filter(function (d) { return d.ok === true; }).length + '/' + DISHES.length + ' 款'
      };
      plans[planId] = plan;
      return plan;
    }

    function dedupe(arr) {
      var s = {}, out = [];
      (arr || []).forEach(function (v) { if (v && !s[v]) { s[v] = 1; out.push(v); } });
      return out;
    }

    function collect(items, key) {
      var s = {};
      items.forEach(function (i) { (i[key] || []).forEach(function (v) { s[v] = 1; }); });
      return Object.keys(s);
    }

    function buildWhy(raw, N, q, targetPer, unknownNames) {
      var bits = [];
      bits.push(N + ' 人');
      if (q.unlimited || q.budgetMax == null) bits.push('预算不限');
      else if (q.budgetMin) bits.push('预算 ' + yuan(q.budgetMin) + '–' + yuan(q.budgetMax));
      else bits.push('预算 ' + yuan(q.budgetMax) + ' 以内');
      if (q.avoid.length) bits.push('忌 ' + q.avoid.join('、'));

      var head = bits.join(' · ');
      var body;
      if (raw.tier === 'budget') {
        body = '把人均压到 ' + yuan(raw.total / N) + '，比原价省 ' + yuan(raw.save) +
          '（省下 ' + Math.round((raw.orig ? raw.save / raw.orig : 0) * 100) + '%），主食按人数配齐。';
      } else if (raw.tier === 'lean') {
        body = '人均 ' + (Math.round(raw.kcal / N) || 0) + ' kcal / 目标 ' + targetPer +
          ' kcal，蛋白 ' + Math.round(raw.protein) + ' g，超标的直接不选。';
      } else {
        body = '优先挑官方打了「上新 / 限定 / 促销」标签的，合计 ' + yuan(raw.total) +
          '，比原价省 ' + yuan(raw.save) + '。';
      }
      if (unknownNames.length) {
        body += ' 其中 ' + unknownNames.length + ' 款麦当劳官方未公布营养数据，热量与营养为已知部分的下限。';
      }
      return head + '：' + body;
    }

    /* ---------------- calculatePlan ----------------
     * 只到 calculate-price，绝无 create-order。
     * 构建期算过价，运行时返回快照金额 + verifiedAt 时间戳。            */
    function calculatePlan(planId) {
      var plan = plans[planId];
      if (!plan) return Promise.reject(Object.assign(new Error('planId 不存在或已过期'), { code: 'NO_PLAN' }));
      var orig = plan.originalPrice, pay = plan.totalPrice;
      return p({
        planId: planId,
        items: plan.items.map(function (i) {
          return { productCode: i.productCode, name: i.name, quantity: i.quantity, price: i.price };
        }),
        originalPrice: orig,
        discount: plan.discount,
        payPrice: pay,
        // 官方算价返回里没有配送/打包/餐具的可靠值，给 null 而不是编 0
        deliveryPrice: null, packingPrice: null, tablewarePrice: null,
        perPersonPrice: plan.perPersonPrice,
        people: plan.people,
        currency: 'CNY',
        method: 'calculate-price@build-time',
        verifiedAt: DATA.fetchedAt,
        storeCode: DATA.store.code, storeName: DATA.store.name,
        orderEnabled: false,
        note: '金额为构建期调用 calculate-price 的官方结果；最终以麦当劳小程序/APP 结算页为准。本工具不提供下单入口。'
      });
    }

    /* ---------------- buildOrderSummary：可复制清单 ---------------- */
    function buildOrderSummary(planId) {
      var plan = plans[planId];
      if (!plan) return Promise.reject(Object.assign(new Error('planId 不存在或已过期'), { code: 'NO_PLAN' }));
      var lines = [];
      lines.push('麦当劳点单清单 · ' + plan.title);
      lines.push('门店：' + DATA.store.name + '（' + DATA.store.code + '，' + DATA.store.address + '）');
      lines.push('人数：' + plan.people + ' 人　合计：' + yuan(plan.totalPrice) +
        '　原价：' + yuan(plan.originalPrice) + '　省：' + yuan(plan.discount));
      lines.push('');
      plan.items.forEach(function (i) {
        lines.push('· ' + i.name + '　×' + i.quantity + '　' + yuan(i.price) +
          (i.nutrition ? '　' + i.nutrition.kcal * i.quantity + ' kcal' : '　官方未提供营养数据'));
      });
      lines.push('');
      lines.push('合计 ' + yuan(plan.totalPrice) + '　人均 ' + yuan(plan.perPersonPrice));
      if (plan.totalCalories != null) {
        lines.push('热量合计 ' + plan.totalCalories + ' kcal　人均 ' + plan.perPersonCalories + ' kcal' +
          (plan.unknownItems.length ? '（未含 ' + plan.unknownItems.length + ' 款官方无数据项，为下限）' : ''));
      } else {
        lines.push('热量：所选菜品麦当劳官方未公布营养数据，未估算');
      }
      lines.push('');
      lines.push('数据来源：麦当劳官方 MCP　请用麦当劳小程序 / APP 下单');
      return p(lines.join('\n'));
    }

    /* ---------------- getPlan / getNutritionByProductCodes ---------------- */
    function getPlan(planId) { return p(plans[planId] || null); }

    function getNutritionByProductCodes(codes) {
      var out = {};
      (codes || []).forEach(function (c) {
        var d = byCode[c];
        out[c] = d ? nutritionOfDish(d) : null;   // 查不到就是 null，不推算
      });
      return p(out);
    }

    /* ---------------- 忌口选项：从真实数据统计，不硬编码猜测 ---------------- */
    function getAvoidOptions() {
      var c = {};
      DISHES.forEach(function (d) { (d.Avoid || []).forEach(function (v) { c[v] = (c[v] || 0) + 1; }); });
      return p(Object.keys(c).sort(function (a, b) { return c[b] - c[a]; })
        .filter(function (v) { return AVOID_ALIAS[v] || c[v] >= 3; })
        .map(function (v) { return { value: v, count: c[v] }; }));
    }

    function getGoalOptions() {
      return p(E.GOALS.map(function (g) { return { key: g.key, label: g.name, kcal: g.kcal }; }));
    }

    return {
      getMeta: getMeta,
      getShowcase: getShowcase,
      getCampaigns: getCampaigns,
      parseQuery: function (text) { return p(parseQuery(text)); },
      parseQuerySync: parseQuery,
      recommendPlans: recommendPlans,
      getPlan: getPlan,
      calculatePlan: calculatePlan,
      buildOrderSummary: buildOrderSummary,
      getNutritionByProductCodes: getNutritionByProductCodes,
      resolveImage: function (url, local) { return resolveImage(url, local); },
      getAvoidOptions: getAvoidOptions,
      getGoalOptions: getGoalOptions,
      getSlots: function () { return p(listSlots()); },
      getSlotsSync: listSlots,
      currentSlot: function () { return getMeta(); },
      PLACEHOLDER: PLACEHOLDER,
      ORDER_ENABLED: false
    };
  }

  /* 默认实例：浏览器里直接用 window.McAdvisor.xxx()，data+engine 已就绪时 */
  function getService(opt) { return createService(opt); }

  return {
    createService: createService,
    getService: getService,
    parseQuery: parseQuery,
    resolveImage: resolveImage,
    // 列出已落地的时段快照（不用先建 service，方便 UI 先渲染切换器）
    listSlots: function () { return listSlots(); },
    SLOT_LABEL: SLOT_LABEL
  };
});
