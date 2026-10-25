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

  /* parseQuery 定义在 createService 之外（模块级），但要用引擎能力
   * （parseDining / parseOrderMode / parseModes / DINING_LABEL…）。
   * createService 时把引擎注入到这里；没注入过就退化成 `{}`，
   * 所有调用点都带 `E.xxx ? … : 兜底` 保护，老调用方式照样能跑。 */
  var ENGINE = null;

  /* ---------------- 自然语言 → AdvisorQuery ----------------
   * 解析失败不抛错：给默认值 + matchedReason，UI 照常能跑，不会卡住。
   *
   * 冲突检测（问题五的修法）：
   *   以前是「文本 silently 覆盖控件」——输入框写 3 人、人数控件是 2，界面显示 2
   *   实际按 3 算，用户完全看不出发生了什么事。现在：
   *     ① 每个字段记录 source：'text' | 'control' | 'default'
   *     ② 文本与控件不一致时进 conflicts[]，UI 弹提示
   *     ③ resolved 给出「实际生效值」，UI 据此把控件同步过来（双向同步）
   *   优先级固定为：文本 > 控件 > 默认（文本是这一次查询里最新的意图表述）。
   *   忌口冲突（文本想吃 X，但 X 在忌口清单里）另行检测：忌口赢，安全优先，
   *   并把被挡掉的菜名如实告诉用户——不静默丢弃。                       */
  function parseQuery(input, dishes, engine) {
    var E = engine || ENGINE || {};   // 见上方 ENGINE 说明：模块级函数借引擎能力
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
      wanted: [],           // 用户点名要的菜（「」「想吃X」），已校验成真实菜名
      wantedMeta: {},        // 点名菜 → {fromCombo: 套餐名}：从套餐里拆出来单点的
      exclude: [],           // 菜品级排除：「不要可乐」——与忌口（成分级）是两件事
      itemPrefs: [],         // 子项偏好：「想要/不想要/无所谓」——喂多目标优化，不预设拆不拆
      weights: null,         // 四维权衡 {price,kcal,protein,taste}：目标解析 + UI 滑块注入
      dining: null,          // 'dineIn' 到店/堂食 · 'delivery' 外送/麦乐送 · null 未说明
      orderMode: null,       // 'split' 各自点 · 'together' 一人点完所有人 · null 默认合单
      maxCal: null,          // 全单热量上限：「不超过800大卡」——null 不限制
      modes: { singlesOnly: false, lateNight: false },   // 单点畅吃 / 宵夜模式
      slot: null,
      matched: { people: false, budget: false, goal: false, avoid: [], maxCal: false },
      conflicts: [],
      sources: { people: 'default', budget: 'default', avoid: 'default', itemPrefs: 'default', maxCal: 'default' },
      resolved: null        // 实际生效值快照，UI 双向同步用
    };
    // 控件原值（冲突检测的对照组）；只在传入对象时存在
    var ctrl = null;
    if (input && typeof input === 'object') {
      ctrl = {
        people: input.people != null ? +input.people : null,
        budgetMin: input.budgetMin != null ? +input.budgetMin : null,
        budgetMax: input.budgetMax != null ? +input.budgetMax : null,
        unlimited: input.unlimited != null ? !!input.unlimited : null,
        goal: input.goal || null,
        avoid: input.avoid ? input.avoid.slice() : null,
        dining: input.dining || null,
        orderMode: input.orderMode || null,
        maxCal: input.maxCal != null ? +input.maxCal : null,
        exclude: input.exclude ? input.exclude.slice() : null,
        itemPrefs: input.itemPrefs ? input.itemPrefs.slice() : null,
        weights: input.weights || null
      };
      if (input.people) q.people = input.people;
      if (input.budgetMin != null) q.budgetMin = input.budgetMin;
      if (input.budgetMax != null) q.budgetMax = input.budgetMax;
      if (input.unlimited != null) q.unlimited = !!input.unlimited;
      if (input.goal) q.goal = input.goal;
      if (input.avoid) q.avoid = input.avoid.slice();
      if (input.taste) q.taste = input.taste.slice();
      if (input.dining) q.dining = input.dining;
      if (input.orderMode) q.orderMode = input.orderMode;
      if (input.maxCal != null) q.maxCal = input.maxCal;
      if (input.exclude) q.exclude = input.exclude.slice();
      if (input.itemPrefs) q.itemPrefs = input.itemPrefs.slice();
      if (input.weights) q.weights = input.weights;
    }

    /* 人数：阿拉伯数字 + 中文数字（含口语 俩=2/仨=3；「我们三个」的「个」也是量词） */
    var CN = { 一: 1, 两: 2, 二: 2, 俩: 2, 三: 3, 仨: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    var m = /([0-9]+|[一二两俩三仨四五六七八九十])\s*(?:个人|个|人|位|位朋友|号人)/.exec(t);
    if (m) {
      q.people = CN[m[1]] || parseInt(m[1], 10);
      q.matched.people = true;
      q.sources.people = 'text';
    } else if (/(双人|两个人)/.test(t)) { q.people = 2; q.matched.people = true; q.sources.people = 'text'; }
    else if (/(?:咱|我们|咱们|大家)?俩/.test(t)) { q.people = 2; q.matched.people = true; q.sources.people = 'text'; }
    else if (/(?:咱|我们|咱们|大家)?仨/.test(t)) { q.people = 3; q.matched.people = true; q.sources.people = 'text'; }
    else if (/单人|一个人|自己吃/.test(t)) { q.people = 1; q.matched.people = true; q.sources.people = 'text'; }
    q.people = Math.max(1, Math.min(12, q.people || 1));
    if (q.sources.people === 'default' && ctrl && ctrl.people) q.sources.people = 'control';

    /* 预算：无限 / 区间 / 上限 / 下限 */
    if (/(无限预算|不限预算|不封顶|随便花|不差钱|多少钱都行|不确定预算)/.test(t)) {
      q.unlimited = true; q.budgetMax = null; q.matched.budget = true; q.sources.budget = 'text';
    } else {
      var b;
      b = /([0-9]{1,4})\s*[-~—－至到]\s*([0-9]{1,4})\s*(块|元|块钱|rmb|RMB)?/.exec(t);
      if (b) {
        q.budgetMin = Math.min(+b[1], +b[2]); q.budgetMax = Math.max(+b[1], +b[2]);
        q.unlimited = false; q.matched.budget = true; q.sources.budget = 'text';
      }
      if (!q.matched.budget) {
        b = /(预算|花|控制在|控制在|便宜点)?\s*([0-9]{1,4})\s*(块|元|块钱|rmb|RMB)?\s*(以内|以下|之内|封顶|左右|出头|搞定)/.exec(t);
        if (b) { q.budgetMin = 0; q.budgetMax = +b[2]; q.unlimited = false; q.matched.budget = true; q.sources.budget = 'text'; }
      }
      if (!q.matched.budget && ctrl && (ctrl.budgetMax != null || ctrl.unlimited === false)) {
        q.sources.budget = 'control';
      }
    }
    if (q.budgetMax != null) { q.budgetMax = Math.max(q.budgetMin, q.budgetMax); q.unlimited = false; }

    /* 热量上限：「不超过800大卡」「800大卡以内」「控制在600千卡」。
     * 只认明确数字；「低卡」交给 goal 解析（normGoal），不在这里编默认值。 */
    var mc = /(?:不超过|最多|以内|控制在|限制在)?\s*([0-9]{2,4})\s*(?:大卡|千卡|kcal|卡)/i.exec(t);
    if (mc) { q.maxCal = +mc[1]; q.matched.maxCal = true; q.sources.maxCal = 'text'; }
    else if (ctrl && ctrl.maxCal != null) { q.maxCal = ctrl.maxCal; q.sources.maxCal = 'control'; }

    /* 目标：整句留给用户，量化由引擎 normGoal 负责 */
    if (t) q.goal = q.goal || t;

    /* 用餐方式：堂食/到店 vs 外送（官方 calculate-price 的 orderType=1/2）。
     * 没说不代表默认堂食——标 null「未说明」，券的适用性判断与算价都据此分支。 */
    var diningText = E.parseDining ? E.parseDining(t) : null;
    if (diningText) { q.dining = diningText; q.sources.dining = 'text'; }
    else if (ctrl && ctrl.dining) { q.dining = ctrl.dining; q.sources.dining = 'control'; }

    /* 点餐模式：各自点 / 一人点完所有人（用户原话：「是两个选择」）。
     * 没说时默认各自点——与 assignOrders 拆单面板的默认行为一致；
     * 「图省事」的人在控件里选「一人点完所有人」即可。 */
    var orderModeText = E.parseOrderMode ? E.parseOrderMode(t) : null;
    if (orderModeText) { q.orderMode = orderModeText; q.sources.orderMode = 'text'; }
    else if (ctrl && ctrl.orderMode) { q.orderMode = ctrl.orderMode; q.sources.orderMode = 'control'; }
    else q.orderMode = 'split';              // 默认各自点；合单是显式选的省事模式
    if (!q.sources.orderMode) q.sources.orderMode = 'default';

    /* 特色模式：「哥/姐有钱就喜欢单点」+「宵夜模式」——从文本和目标控件文本里找 */
    var modeText = t + ' ' + (q.goal || '');
    var modeHit = E.parseModes ? E.parseModes(modeText) : { singlesOnly: false, lateNight: false };
    q.modes.singlesOnly = !!modeHit.singlesOnly;
    q.modes.lateNight = !!modeHit.lateNight;
    if (q.modes.singlesOnly || q.modes.lateNight) q.sources.modes = 'text';
    else q.sources.modes = 'default';

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
    if (q.avoid.length && !(ctrl && ctrl.avoid && ctrl.avoid.length)) q.sources.avoid = 'text';
    else if (q.avoid.length) q.sources.avoid = 'merged';

    /* 点名菜：「巨无霸」/「想吃麦辣鸡腿堡」→ 校验成数据里的真实菜名。
     * 认不出来（比如活动标题）就静默忽略——不拿它当忌口、不当目标、不乱报冲突。
     * 匹配规则与引擎一致：相等 / 互相包含 / 共同前缀 ≥3 字
     * （券面和口语常说「麦辣鸡腿堡」，菜单里叫「麦辣鸡腿汉堡」，差一个字）。
     * 口语缓冲词要剥：「我要吃炸鸡」捕获出「吃炸鸡」、「想吃个炸鸡」出「个炸鸡」、
     * 「整一份炸鸡」出「份炸鸡」、「想吃炸鸡和薯饼」出「炸鸡和薯饼」——
     * 原串直接匹配会静默落空，用户看到的就是「我说了想吃炸鸡，它一直推汉堡」。
     * 修法：按连接词切开、剥首尾缓冲词，与原串一起当候选取最高分
     * （原串同分优先——菜名真以缓冲词开头时（那么大鸡排）不会误伤）。 */
    if (dishes && dishes.length) {
      var wantedNames = [];
      var qre = /[「『“"]([^」』”"]{2,15})[」』”"]/g, qm;
      while ((qm = qre.exec(t))) wantedNames.push(qm[1]);
      // 动词表覆盖口语：长的放前面（我要吃 先于 我要），量词留给缓冲词剥离兜
      var vre = /(?:想吃|想要|想点|想加|想来|我要吃|我要|来[一份两个三个]?|加[一个份]?|点[一个份]?|整[一个份]?)\s*([\u4e00-\u9fa5A-Za-z0-9]{2,12})/g, vm;
      while ((vm = vre.exec(t))) wantedNames.push(vm[1]);
      function wantCandidates(raw) {
        var out = [raw];
        (raw || '').split(/[和跟及与、，,]/).forEach(function (piece) {
          var s = piece.replace(/^[吃喝个点些那这了份]+/, '').replace(/[吧呀哦了啊呢嘛]+$/, '');
          if (s.length >= 2 && out.indexOf(s) < 0) out.push(s);
        });
        return out;
      }
      function nameScore(query, name) {
        if (!query || !name) return 0;
        if (query === name) return 1000 + name.length;
        if (name.indexOf(query) >= 0) return 500 + name.length;
        if (query.indexOf(name) >= 0) return 400 + name.length;
        var n = Math.min(query.length, name.length), i = 0;
        while (i < n && query.charAt(i) === name.charAt(i)) i++;
        return i >= 3 ? 100 + i : 0;
      }
      var TIER_RE = /(三件套|四件套|五件套|双件套|件套|套餐|桶|分享餐|双人|多人|随心选|组合|任选)/;
      wantedNames.forEach(function (name) {
        var cands = wantCandidates(name);
        var hits = [];
        cands.forEach(function (cand) {
          var best = null, bestScore = 0;
          dishes.forEach(function (d) {
            if (!d || d.name.length < 2) return;
            var s = nameScore(cand, d.name);
            if (s <= 0) return;
            // 规格层级不一致：说法没带「套/桶/分享」而菜名带了 → 不是同一个东西
            if (TIER_RE.test(d.name) && !TIER_RE.test(cand)) s = Math.min(s, 99);
            if (s > bestScore || (s === bestScore && best && d.name.length < best.name.length)) {
              best = d; bestScore = s;
            }
          });
          if (best) hits.push({ d: best, s: bestScore, cand: cand });
        });
        /* 一句多菜（「想吃炸鸡和薯饼」切出 炸鸡/薯饼）要都收；
         * 但短 cand 是另一个 cand 的子串且分不高时丢掉——防「无霸」式误命中
         * （子串关系的 cands 只留分高的那个，互不为子串的各收各的）。 */
        hits.forEach(function (h) {
          var dominated = hits.some(function (o) {
            return o !== h && o.cand !== h.cand && o.cand.indexOf(h.cand) >= 0 && o.s >= h.s;
          });
          if (!dominated && q.wanted.indexOf(h.d.name) < 0) q.wanted.push(h.d.name);
        });
      });
    }

    /* ---- 菜品级排除：「不要可乐」「别放薯条」 ----
     * 与忌口的分工：忌口是成分级、安全优先（不吃辣/牛肉）；这里是这道菜别放进方案，
     * 用户可能就是不喜欢可乐。同一个否定窗口，先认菜品名；这个名字同时是忌口别名
     * （辣/牛肉/鸡肉…）就交给忌口逻辑，不重复记。 */
    if (dishes && dishes.length) {
      var foodDishes = dishes.filter(function (d) { return d && d.ok === true && d.name && d.name.length >= 2; });
      foodDishes.forEach(function (d) {
        var idx = t.indexOf(d.name);
        while (idx >= 0) {
          var win = t.slice(Math.max(0, idx - 6), idx);
          var after = t.slice(idx + d.name.length, idx + d.name.length + 5);
          if (NEG_RE.test(win) || NEG_RE.test(after)) {
            var isAvoidWord = !!AVOID_ALIAS[d.name] || Object.keys(AVOID_ALIAS).some(function (k) {
              return AVOID_ALIAS[k].indexOf(d.name) >= 0;
            });
            if (!isAvoidWord && q.exclude.indexOf(d.code) < 0) q.exclude.push(d.code);
            break;
          }
          idx = t.indexOf(d.name, idx + 1);
        }
      });
    }

    /* ---- 子项偏好：「我想要安格斯厚牛堡，不要薯条和可乐」 ----
     * 与下面「套餐拆开」的分工：拆开句式是确定性行为（子项转单点、原套餐排除）；
     * 这里是 want/avoid 信号，喂给多目标优化，让「整套餐 vs 拆开单点」同池竞争——
     * 不预设谁赢。控件回传（勾选面板）优先：同名/同 code 以控件为准，
     * 文本只补控件没有的；被控件覆盖的文本信号进 conflicts，不静默丢弃。
     * 忌口守卫：偏好名落在忌口别名里（辣/牛肉/鸡肉…）就交给忌口逻辑，不重复记。
     * 放在拆开解析之前：parseItemPrefs 内部会先把拆开句式挖掉，两边不重复消费。 */
    if (dishes && dishes.length) {
      var textPrefs = (E.parseItemPrefs && E.parseItemPrefs(t, dishes)) || [];
      var panelPrefs = (ctrl && ctrl.itemPrefs) || [];
      var mergedPrefs = panelPrefs.map(function (pp) {
        return {
          name: pp.name, mention: pp.mention || pp.name, code: pp.code || null,
          pref: pp.pref === 'avoid' ? 'avoid' : 'want', source: 'panel'
        };
      });
      textPrefs.forEach(function (tp) {
        var dup = mergedPrefs.some(function (mp) {
          if (mp.code && tp.code && mp.code === tp.code) return true;
          return mp.name === tp.name;
        });
        if (dup) {
          // 面板与文本各说各话：按面板走，但必须告诉用户发生了什么
          var panelOne = mergedPrefs.filter(function (mp) {
            return (mp.code && tp.code && mp.code === tp.code) || mp.name === tp.name;
          })[0];
          q.conflicts.push({
            field: 'itemPrefs', text: tp.mention, control: panelOne.mention,
            resolved: panelOne.pref === 'avoid' ? '不想要' : '想要',
            note: '输入框说「' + (tp.pref === 'avoid' ? '不要' : '想要') + tp.mention +
              '」，勾选面板标的是「' + (panelOne.pref === 'avoid' ? '不想要' : '想要') +
              panelOne.mention + '」，已按面板计算'
          });
          return;
        }
        mergedPrefs.push(tp);
      });
      mergedPrefs = mergedPrefs.filter(function (pp) {
        var isAvoidWord = !!AVOID_ALIAS[pp.name] || Object.keys(AVOID_ALIAS).some(function (k) {
          return AVOID_ALIAS[k].indexOf(pp.name) >= 0;
        });
        return !isAvoidWord;   // 忌口别名交给忌口逻辑，安全优先
      });
      q.itemPrefs = mergedPrefs;
      if (mergedPrefs.length) {
        q.sources.itemPrefs = panelPrefs.length ? 'merged' : 'text';
      }
    }

    /* ---- 套餐拆开：只要其中几样 / 整份拆成单点 ----
     * 「麦辣鸡腿堡套餐只要汉堡和薯条」「把双人餐拆开单点」→
     * 点名的子项按单点计入（wanted + fromCombo 标记），原套餐整体排除，
     * 既不享受组合价、也不重复计费。子项对不上价就如实说不估算。 */
    if (dishes && dishes.length) {
      var pickBest = E.pickBestDish, scoreName = E.nameMatchScore, isFoodDish = E.isFood;
      if (!pickBest || !scoreName || !isFoodDish) return q;   // 没引擎就不做套餐拆解，不猜
      var comboPool = dishes.filter(function (d) { return d && d.ok === true && d.role === 'combo'; });
      var byCodeLocal = {};
      dishes.forEach(function (d) { if (d && d.code) byCodeLocal[d.code] = d; });
      function pushPartPick(comboName, partNames) {
        var combo = pickBest(comboName, comboPool);
        if (!combo) return;                        // 说的不是套餐：不猜，交给普通点名菜逻辑
        if (q.exclude.indexOf(combo.code) < 0) q.exclude.push(combo.code);
        (partNames || []).forEach(function (pn) {
          if (!pn || pn.length < 2) return;
          var part = null;
          (combo.parts || []).forEach(function (p) {
            var sub = byCodeLocal[p.code];
            if (sub && !part && scoreName(pn, sub.name) > 0) part = sub;
          });
          if (!part) part = pickBest(pn, dishes.filter(function (d) { return d.ok === true && isFoodDish(d); }));
          if (part && q.wanted.indexOf(part.name) < 0) {
            q.wanted.push(part.name);
            q.wantedMeta[part.name] = { fromCombo: combo.name };
          }
        });
      }
      // 形态①：「X套餐（里/中）只要/想要 A、B」
      var pre = /([\u4e00-\u9fa5A-Za-z0-9]{2,12}?(?:套餐|组合|桶|分享餐|双人餐|多人餐))\s*(?:里|中|内|里面)?\s*(?:只要|只点|只想要|想要|要|加|加上)\s*([\u4e00-\u9fa5A-Za-z0-9、和及跟，,]{2,30})/g;
      var pm;
      while ((pm = pre.exec(t))) {
        pushPartPick(pm[1], pm[2].split(/[、和及跟，,]\s*/));
      }
      // 形态②：「把X套餐拆开（单点）」→ 全部子项按单点计入
      var bre = /(?:把|将)?\s*([\u4e00-\u9fa5A-Za-z0-9]{2,12}?(?:套餐|组合|桶|分享餐|双人餐|多人餐))\s*拆开/g;
      var bm;
      while ((bm = bre.exec(t))) {
        var combo2 = pickBest(bm[1], comboPool);
        if (!combo2) continue;
        var allParts = (combo2.parts || []).map(function (p) {
          var sub = byCodeLocal[p.code];
          return sub ? sub.name : null;
        }).filter(Boolean);
        pushPartPick(bm[1], allParts);
      }
    }

    /* ---- 冲突检测：文本 vs 控件 ---- */
    if (ctrl) {
      if (q.sources.people === 'text' && ctrl.people && ctrl.people !== q.people) {
        q.conflicts.push({
          field: 'people', text: q.people, control: ctrl.people, resolved: q.people,
          note: '输入框写的是 ' + q.people + ' 人，人数控件选的是 ' + ctrl.people + ' 人，已按输入框的 ' + q.people + ' 人计算'
        });
      }
      var ctrlBudgetKnown = ctrl.budgetMax != null || ctrl.unlimited === true;
      if (q.matched.budget && ctrlBudgetKnown) {
        var sameBudget = (q.unlimited && ctrl.unlimited === true) ? true :
          (!q.unlimited && ctrl.unlimited !== true && ctrl.budgetMax != null &&
           ctrl.budgetMax === q.budgetMax && (ctrl.budgetMin || 0) === q.budgetMin);
        if (!sameBudget) {
          var ctrlDesc = ctrl.unlimited === true ? '不限预算' :
            ('¥' + (ctrl.budgetMin || 0) + (ctrl.budgetMax != null ? '–' + ctrl.budgetMax : ' 以内'));
          var textDesc = q.unlimited ? '不限预算' : ('¥' + q.budgetMin + (q.budgetMax != null ? '–' + q.budgetMax : ' 以内'));
          q.conflicts.push({
            field: 'budget', text: textDesc, control: ctrlDesc,
            resolved: q.unlimited ? null : { min: q.budgetMin, max: q.budgetMax },
            note: '输入框写的是「' + textDesc + '」，预算控件是「' + ctrlDesc + '」，已按输入框计算'
          });
        }
      }
      // 用餐方式冲突：文本说外送、控件选堂食（或反过来）——按文本，并说清楚
      if (q.sources.dining === 'text' && ctrl.dining && ctrl.dining !== q.dining) {
        q.conflicts.push({
          field: 'dining', text: q.dining, control: ctrl.dining, resolved: q.dining,
          note: '输入框说的是' + ((E.DINING_LABEL || {})[q.dining] || q.dining) + '，控件选的是' +
            ((E.DINING_LABEL || {})[ctrl.dining] || ctrl.dining) + '，已按输入框计算（算价与用券都按这个来）'
        });
      }
      // 点餐模式冲突：文本说各付各、控件选一起点——按文本
      if (q.sources.orderMode === 'text' && ctrl.orderMode && ctrl.orderMode !== q.orderMode) {
        q.conflicts.push({
          field: 'orderMode', text: q.orderMode, control: ctrl.orderMode, resolved: q.orderMode,
          note: '输入框说的是「' + ((E.ORDER_MODE_LABEL || {})[q.orderMode] || q.orderMode) + '」，控件选的是「' +
            ((E.ORDER_MODE_LABEL || {})[ctrl.orderMode] || ctrl.orderMode) + '」，已按输入框计算'
        });
      }
    }

    /* 忌口 vs 点名菜：忌口赢，安全优先，但必须告诉用户谁被挡了——不静默丢弃。
     * 官方 Avoid 标签驱动（麦辣鸡腿汉堡 Avoid=['辣','鸡肉']，官方数据 106/122 菜有标注），不猜成分。
     * 不依赖 ctrl：纯文本「不吃辣，想吃麦辣鸡腿堡」同样要检测——
     * 这个场景没有控件对照，以前整块被跳过，用户看到的就是「说了忌口还给我麦辣」。 */
    if (q.avoid.length && q.wanted.length && dishes && dishes.length) {
      q.wanted.slice().forEach(function (name) {
        var d = null;
        dishes.forEach(function (x) { if (x.name === name) d = x; });
        if (!d) return;
        var blocked = q.avoid.filter(function (v) { return (d.Avoid || []).indexOf(v) >= 0; });
        if (blocked.length) {
          q.conflicts.push({
            field: 'avoid', text: name, control: blocked.join('、'), resolved: 'dropped',
            note: '你说想吃「' + name + '」，但它含 ' + blocked.join('、') + '，与忌口冲突，已不加入方案'
          });
          q.wanted.splice(q.wanted.indexOf(name), 1);
        }
      });
    }

    q.resolved = {
      people: q.people,
      budgetMin: q.budgetMin,
      budgetMax: q.unlimited ? null : q.budgetMax,
      unlimited: q.unlimited,
      avoid: q.avoid.slice(),
      wanted: q.wanted.slice(),
      dining: q.dining,
      orderMode: q.orderMode,
      modes: { singlesOnly: q.modes.singlesOnly, lateNight: q.modes.lateNight },
      exclude: q.exclude.slice(),
      // 子项偏好快照：UI 勾选面板据此回填（用户能看到「系统理解成了什么」）
      itemPrefs: q.itemPrefs.map(function (pp) {
        return { name: pp.name, mention: pp.mention, code: pp.code, pref: pp.pref, source: pp.source };
      }),
      weights: q.weights
    };
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

    ENGINE = E;   // 供模块级 parseQuery 借用（多实例时后建的覆盖先建的，
                  // 服务内调用一律走包装器显式传参，不受此影响）

    // 活动日历是独立文件（data/campaigns.js），可选：没加载就降级，不挡主流程
    var CAMP = opt.campaigns ||
      (typeof window !== 'undefined' ? window.MCD_CAMPAIGNS : null) ||
      (typeof globalThis !== 'undefined' ? globalThis.MCD_CAMPAIGNS : null) || null;

    var DISHES = DATA.dishes || [];
    var byCode = {};
    DISHES.forEach(function (d) { byCode[d.code] = d; });

    /* 双模式：传了 adapter 就是在线，没传就当离线快照用。
       SIMULATED 的含义是「这个价格不是此刻官方算出来的」，离线恒为 true。 */
    var ADAPTER = opt.adapter || null;
    var MODE = ADAPTER ? ADAPTER.mode : 'offline';
    var FETCHED_AT = (DATA && DATA.fetchedAt) || null;
    var SIMULATED = (MODE === 'offline');

    /** 给任何返回值打上模式标记，前端靠它决定显示绿色还是黄色。 */
    function stamp(o) {
      return Object.assign({ mode: MODE, fetchedAt: FETCHED_AT, simulated: SIMULATED }, o);
    }

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
        nutrition: nutritionOfDish(d),
        // 混合方案角标：'combo' 完整套餐 · 'single' 单独点 · 'comboPart' 套餐子项转单点
        // （官方无套餐改配，comboPart 是按子项单点价另买的，不是改过的套餐）
        // 口径与引擎一致：品名带 套餐/组合/桶/分享餐/件套 的也算套餐——官方分类
        // 把一部分三件套归在了「主食」里，role 不是 combo，但用户眼里就是套餐
        sourceType: it.src === 'comboPart' ? 'comboPart'
          : ((E.isComboLike && E.isComboLike(d)) || d.role === 'combo' ||
             /(套餐|组合|桶|分享餐|件套)/.test(d.name || '') ? 'combo' : 'single'),
        fromCombo: it.fromCombo || null,
        // 套餐 vs 散件：按官方子项单点价重算的对比（问题四）。非套餐或子项无价为 null
        combo: E.comboBreakdown ? E.comboBreakdown(d, byCode) : null
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
      // 无论传字符串还是结构化对象，都统一过一遍解析器，保证字段齐全。
      // 传入 DISHES：点名菜校验与忌口冲突检测都需要真实菜单。
      var q = parseQuery(query, DISHES);
      if (!q.people) q.people = 1;

      var res = E.makePlans({
        dishes: DISHES, people: q.people, avoid: q.avoid,
        bmin: q.budgetMin || 0, bmax: q.budgetMax == null ? 0 : q.budgetMax,
        unlimited: q.unlimited || q.budgetMax == null,
        goal: q.goal,
        wanted: (q.wanted || []).map(function (n) {
          return { name: n, fromCombo: (q.wantedMeta[n] || {}).fromCombo || null };
        }),
        exclude: q.exclude || [],
        itemPrefs: q.itemPrefs || [],
        weights: q.weights || null,
        singlesOnly: q.modes.singlesOnly,
        lateNight: q.modes.lateNight
      });

      if (res.error) {
        return Promise.reject(Object.assign(
          new Error(res.error), { code: 'NO_PLAN', advice: res.advice || [], conflicts: q.conflicts || [] }));
      }

      var out = res.plans.map(function (raw) {
        return toPlan(raw, q, res.goal, res.wanted || []);
      });
      // 冲突、点名菜落空、实际生效值挂在第一份方案上，UI 统一读（数组接口不变）
      if (out.length) {
        out[0].conflicts = q.conflicts || [];
        out[0].resolved = q.resolved;
        out[0].sources = q.sources;
        out[0].wantedReport = res.wanted || [];
        out[0].dining = q.dining;
        out[0].orderMode = q.orderMode;
        out[0].modes = q.modes;
        out[0].itemPrefs = q.itemPrefs || [];
        out[0].weights = res.weights || q.weights || null;
      }
      return p(out);
    }

    function toPlan(raw, q, goal, wantedReport) {
      var items = raw.items.map(itemOf);
      var N = raw.people || 1;
      var plannerGoal = raw.goal || goal;          // 该档自己的目标参数
      var targetPer = plannerGoal.kcal || 670;
      var targetAll = targetPer * N;
      var nut = E.nutritionOf(raw);
      var hasAnyKcal = items.some(function (i) { return i.nutrition; });
      var knownN = items.filter(function (i) { return i.nutrition; }).length;
      var unknownNames = items.filter(function (i) { return !i.nutrition; }).map(function (i) { return i.name; });

      // 套餐 vs 散件汇总（问题四）：这一版里几份套餐、比拆开单点共省多少
      var comboItems = items.filter(function (i) { return i.combo && i.combo.save > 0; });
      var comboSummary = {
        comboCount: items.filter(function (i) { return i.combo; }).length,
        savingCount: comboItems.length,
        totalSave: round(comboItems.reduce(function (s, i) { return s + i.combo.save * i.quantity; }, 0))
      };

      seq += 1;
      var planId = 'plan-' + raw.tier + '-' + seq;

      var plan = {
        planId: planId,
        tier: raw.tier,                                    // 'budget' | 'lean' | 'new'
        title: raw.name,
        subtitle: raw.sub,
        why: buildWhy(raw, N, q, targetPer, unknownNames, comboSummary, wantedReport),

        /* 双模式标记：离线时价格来自快照，UI 必须显示黄色「预演校验」而非绿色对勾 */
        mode: MODE,
        fetchedAt: FETCHED_AT,
        simulated: SIMULATED,
        priceSource: SIMULATED ? 'snapshot' : 'mcp-live',

        people: N,
        items: items,
        itemCount: items.length,

        totalPrice: round(raw.total),
        originalPrice: round(raw.orig),
        discount: round(raw.save),
        perPersonPrice: round(raw.total / N),

        budgetMin: q.budgetMin, budgetMax: q.unlimited ? null : q.budgetMax,
        unlimited: !!q.unlimited,
        maxCal: q.maxCal || null,
        withinMaxCal: (q.maxCal != null && hasAnyKcal) ? round(nut.total.kcal, 0) <= q.maxCal : null,
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
          var info = {
            key: plannerGoal.key || 'custom',
            label: plannerGoal.name || '',
            kcal: targetPer,
            protein: plannerGoal.protein || null,
            userText: q.goal || '',
            custom: !!ug.custom,
            recognized: !ug.custom
          };
          if (ug.custom) {
            // 兜底话术升级（问题三）：不再用「没能匹配到内置目标」这种吓人说法，
            // 改成「先按均衡理解」+ 给出可点的目标示例，语气是接住了、不是拒收了。
            info.fallback = '先按「均衡就好」理解（' + targetPer + ' kcal/人）';
            info.suggestions = ['减肥控卡', '增肌高蛋白', '吃饱管饱', '尝鲜新品'];
          } else {
            info.hits = ug.hits || [];       // 命中了哪些词，解释「为什么这么理解」
          }
          return info;
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

        // 套餐 vs 散件对比（问题四）
        comboSummary: comboSummary,
        // 混合方案（套餐拆开的正确含义）：mixSummary 人话总结 + tradeoffExplanation
        // 权衡解释 + comboCompare 四维对比。无子项偏好时引擎不产这三个字段 → null，
        // UI 看到 null 就不渲染对比卡，不给普通方案硬编对比。
        mixSummary: raw.mixSummary || null,
        tradeoffExplanation: raw.tradeoffExplanation || null,
        comboCompare: raw.comboCompare || null,
        weights: raw.weights || null,
        // 点名菜落实报告（问题五配套）：点了什么、哪几版塞进去了、谁被挡住了
        wantedInfo: {
          requested: (wantedReport || []).map(function (w) { return w.name; }),
          unmet: (raw.unmetWanted || []).map(function (u) {
            return { name: u.name, reason: u.reason, avoid: u.avoid || [] };
          }),
          // 从套餐里拆出来单点的：UI 要显示「按单点计入，不享受套餐组合价」
          fromCombo: (wantedReport || []).filter(function (w) { return w.fromCombo; })
            .map(function (w) { return { name: w.name, fromCombo: w.fromCombo }; })
        },
        conflicts: q.conflicts || [],
        // 用餐方式 / 点餐模式 / 特色模式（本轮新增）
        dining: q.dining,
        diningLabel: q.dining ? (E.DINING_LABEL[q.dining] || q.dining) : '未说明',
        orderMode: q.orderMode,
        orderModeLabel: q.orderMode ? (E.ORDER_MODE_LABEL[q.orderMode] || q.orderMode) : '各自点（默认）',
        modes: q.modes,

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

    function buildWhy(raw, N, q, targetPer, unknownNames, comboSummary, wantedReport) {
      var bits = [];
      bits.push(N + ' 人');
      if (q.unlimited || q.budgetMax == null) bits.push('预算不限');
      else if (q.budgetMin) bits.push('预算 ' + yuan(q.budgetMin) + '–' + yuan(q.budgetMax));
      else bits.push('预算 ' + yuan(q.budgetMax) + ' 以内');
      if (q.avoid.length) bits.push('忌 ' + q.avoid.join('、'));
      if (q.wanted && q.wanted.length) bits.push('想吃 ' + q.wanted.join('、'));
      // 本轮新增：用餐方式 / 特色模式也进推荐语，让用户看见"我是按什么理解的"
      if (q.dining) bits.push(E.DINING_LABEL[q.dining] || q.dining);
      if (q.modes && q.modes.singlesOnly) bits.push('单点畅吃');
      if (q.modes && q.modes.lateNight) bits.push('宵夜模式');

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
      // 套餐 vs 散件：把「比拆开单点省多少」写进推荐语（问题四）
      if (comboSummary && comboSummary.savingCount > 0) {
        body += ' 其中 ' + comboSummary.savingCount + ' 份套餐按官方子项单点价重算，比拆开单点共省 ' +
          yuan(comboSummary.totalSave) + '。';
      }
      // 特色模式的依据必须写明是偏好加权，不是官方分类
      if (q.modes && q.modes.singlesOnly) {
        body += ' 按你的要求只出单点商品，不配套餐。';
      }
      if (q.modes && q.modes.lateNight) {
        body += ' 宵夜模式：小食 / 饮品 / 分享规格优先（这是我们的偏好加权，不是官方分类）。';
      }
      // 套餐拆开单点的子项：说清"按单点计入，不享受组合价"
      var fromCombo = (wantedReport || []).filter(function (w) { return w.fromCombo && !w.reason; });
      if (fromCombo.length) {
        body += ' ' + fromCombo.map(function (w) { return w.name; }).join('、') +
          ' 按单点计入（从' + fromCombo[0].fromCombo + '拆出），不享受套餐组合价。';
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

    /**
     * 分账。三种口径都走最大余额法，保证各份之和 === 总额。
     *
     *   注意命名：返回里 splitMode 是分账口径（even / byItem / byWeight），
     *   mode 是数据源模式（online / offline）——两个都叫 mode 会混。
     *
     *   离线时 simulated 恒为 true，因为分摊的基础是快照价，不是此刻官方算价。
     */
    function splitBill(planId, opt) {
      opt = opt || {};
      var plan = plans[planId];
      if (!plan) {
        return Promise.reject(Object.assign(
          new Error('planId 不存在或已过期'), { code: 'NO_PLAN' }));
      }
      var src = opt.items || plan.items;
      var bill = E.splitBill(plan.totalPrice, {
        mode: opt.mode || 'even',
        members: opt.members,
        people: opt.people || plan.people,
        items: src.map(function (i) {
          return {
            code: i.productCode || i.code, name: i.name,
            price: i.unitPrice != null && i.quantity ? i.unitPrice : i.price,
            qty: i.quantity || i.q || 1,
            owners: i.owners
          };
        })
      });

      return p(stamp({
        planId: planId,
        splitMode: bill.mode,
        currency: 'CNY',
        total: bill.total,
        people: plan.people,
        shares: bill.shares,
        method: bill.method,
        balanced: bill.balanced,
        note: SIMULATED ? '预演分账，在线后校准' : '按实付分摊'
      }));
    }

    /* ---------------- assignCore：拆单 / 合单两条路子的公共内核 ----------------
     * 一次覆盖用户提的几件事：
     *  ① 堂食/外送是可选项：dining = 'dineIn' | 'delivery' | null
     *     （**未说明不默认堂食**）。影响两处：
     *       · 券先按券面标题判类型，与当前用餐方式不符的直接出局
     *         （堂食券不上外送单、外送券不接到店单——「优惠券也分堂食和外送两种」）
     *       · 在线算价把 orderType 透传给官方 calculate-price（=1 自取 / =2 外送）
     *  ② 各自点 vs 一人点完所有人是两个选择（「有些人图省事就喜欢一个人点完所有人的」）：
     *       · orderMode='split'    拆小单 → 一券一单 → 各自付各自的
     *       · orderMode='together' 一张合单 → 整单最佳一张券 → 最大余额法人均分摊
     *  ③ 优惠券怎么录进来统计：buildLedger 给每一张券记一行账
     *     （类型 / 是否适配 / 为什么 / 估省 / 谁用的 / 状态），再出汇总 stats。
     *
     * 诚实的边界（全部写进返回的 notes 与 ledger.notes，UI 原样展示）：
     *   · 官方 available-coupons 只回券标题/图片/状态，**不回券 code**，
     *     所以券收益在离线与在线都只能是「券面规则估算」，恒带 simulated:true；
     *   · 官方 query-store-coupons 才按订单类型返回可用券；本工具只能读券面
     *     标题文字判断类型，标题没标注的按通用券处理并如实标注；
     *   · 每单最多用 1 张券（官方未提供叠加规则，不假设能叠）；
     *   · 配送费只有在线模式拿得到真实值（官方 calculate-price 返回），
     *     离线不编，也不计入对比。                                    */
    function assignCore(plan, opt) {
      opt = opt || {};
      var dining = opt.dining || null;
      // 默认各自点：与旧版 assignOrders 契约一致（拆单面板点进来就是拆）；
      // 「一人点完所有人」是显式选的省事模式。
      var orderMode = (opt.orderMode === 'together') ? 'together' : 'split';
      var useCoupons = opt.useCoupons !== false;
      var wantReal = opt.real !== false;

      var members = (opt.members && opt.members.length)
        ? opt.members.map(function (m) { return typeof m === 'string' ? { name: m } : Object.assign({}, m); })
        : Array.from({ length: plan.people }, function (_, i) { return { name: '第 ' + (i + 1) + ' 人' }; });

      // 归属：opt.owners 与 plan.items 对齐；或 opt.assignment 按 productCode 查
      var owners = null;
      if (opt.owners && opt.owners.length) owners = opt.owners;
      else if (opt.assignment) {
        owners = plan.items.map(function (i) { return opt.assignment[i.productCode] || null; });
      }

      var couponList = (opt.coupons && opt.coupons.length ? opt.coupons : (DATA.coupons || []))
        .filter(function (c) { return c && c.title && c.title.indexOf('###') !== 0; });

      /* 券面类型判定 + 用餐方式适配。
       * 真源是官方 query-store-coupons（按 storeCode+orderType 返回可用券），
       * 但 available-coupons 只给标题，所以这里只能读标题文字，并在账本里注明。 */
      var couponRows = couponList.map(function (c) {
        var type = E.parseCouponType ? E.parseCouponType(c.title) : 'unlabeled';
        var applies = E.couponApplies ? E.couponApplies(type, dining) : { ok: true, reason: '' };
        return { coupon: c, title: c.title, code: c.code || c.id || null,
                 type: type, typeLabel: (E.COUPON_TYPE_LABEL || {})[type] || type,
                 applicable: applies.ok, reason: applies.reason || '' };
      });
      var eligible = useCoupons
        ? couponRows.filter(function (r) { return r.applicable; }).map(function (r) { return r.coupon; })
        : [];
      var blocked = useCoupons ? couponRows.filter(function (r) { return !r.applicable; }) : [];
      var unlabeled = couponRows.filter(function (r) { return r.type === 'unlabeled'; });

      var planItems = plan.items.map(function (i) {
        return { code: i.productCode, name: i.name, price: i.unitPrice != null ? i.unitPrice : i.price, qty: i.quantity };
      });
      var orderTotal = round(planItems.reduce(function (s, it) {
        return s + (parseFloat(it.price) || 0) * (parseInt(it.qty, 10) || 1);
      }, 0));

      /* ---- 两条路子各自的离线骨架 ---- */
      var core = { orderMode: orderMode };
      if (orderMode === 'split') {
        core.built = E.buildSubOrders(planItems, members, owners);
        core.couponResult = { totalCut: 0 };
        if (eligible.length) core.couponResult = E.optimizeCoupons(core.built.subOrders, eligible, DISHES);
        // 合单参照：一整单用它能用的最好的那张券（同样只是估算）
        core.combinedCoupon = null; core.combinedCut = 0;
        eligible.forEach(function (c) {
          var rule = E.parseCouponRule(c.title || c.name || '');
          var dish = E.matchCouponDish(rule, DISHES);
          var cut = E.estimateCouponCut(rule, dish, orderTotal);
          if (cut > core.combinedCut) { core.combinedCut = cut; core.combinedCoupon = { title: c.title, estimatedCut: cut }; }
        });
      } else {
        // 一人点完所有人：整单最佳一张券
        core.best = null; core.bestCut = 0;
        eligible.forEach(function (c) {
          var rule = E.parseCouponRule(c.title || c.name || '');
          var dish = E.matchCouponDish(rule, DISHES);
          var cut = E.estimateCouponCut(rule, dish, orderTotal);
          if (cut > core.bestCut) {
            core.bestCut = cut;
            core.best = { title: c.title, code: c.code || c.id || null, estimatedCut: cut, rule: rule.kind };
          }
        });
      }

      /* ---- 在线：真调官方 calculate-price（只读算价，绝无下单）----
       * dining 一并透传：适配器负责转成官方 orderType，外送还要地址 beCode。 */
      var realJobs = [];
      if (!SIMULATED && wantReal && ADAPTER && typeof ADAPTER.calculatePrice === 'function') {
        var calcOpt = { storeCode: DATA.store.code, dining: dining };
        if (orderMode === 'split') {
          realJobs = core.built.subOrders.map(function (s) {
            return ADAPTER.calculatePrice(s.items.map(function (i) {
              return { code: i.code, qty: i.qty };
            }), calcOpt).catch(function (e) {
              return { ok: false, error: (e && e.code) || 'calc_failed' };
            });
          });
        } else {
          realJobs = [ADAPTER.calculatePrice(planItems.map(function (i) {
            return { code: i.code, qty: i.qty };
          }), calcOpt).catch(function (e) {
            return { ok: false, error: (e && e.code) || 'calc_failed' };
          })];
        }
      }

      return (realJobs.length ? Promise.all(realJobs) : p(null)).then(finalize);

      /* ---------------- 券账本：每一张券一行账 ---------------- */
      function buildLedger() {
        var usedByTitle = {};   // title -> { member, cut }
        if (orderMode === 'split') {
          core.built.subOrders.forEach(function (s) {
            if (s.coupon) usedByTitle[s.coupon.title] = { member: s.name, cut: s.coupon.estimatedCut };
          });
        } else if (core.best) {
          usedByTitle[core.best.title] = { member: '合单', cut: core.best.estimatedCut };
        }
        function withBase(couponRow, specific) {
          return couponRow.reason ? (couponRow.reason + '；' + specific) : specific;
        }
        var rows = couponRows.map(function (couponRow) {
          var u = usedByTitle[couponRow.title] || null;
          var row = {
            title: couponRow.title, type: couponRow.type, typeLabel: couponRow.typeLabel,
            applicable: couponRow.applicable, reason: '', estimatedCut: 0, usedBy: null,
            status: 'no-benefit'
          };
          if (!useCoupons) { row.status = 'off'; row.reason = '本回合未启用用券'; return row; }
          if (!couponRow.applicable) { row.status = 'unavailable'; row.reason = couponRow.reason; return row; }
          if (u) {
            row.status = 'used'; row.usedBy = u.member; row.estimatedCut = u.cut;
            row.reason = withBase(couponRow, orderMode === 'split'
              ? ('已分配给 ' + u.member + ' 的小单')
              : '合单只用这一张（一人点完所有人）');
            return row;
          }
          // 没排上的券：按当前餐单重算它的上限，省得到账本里看不出它值多少
          var rule = E.parseCouponRule(couponRow.title);
          var dish = E.matchCouponDish(rule, DISHES);
          var potential = 0;
          if (orderMode === 'split') {
            core.built.subOrders.forEach(function (s) {
              var cut = E.estimateCouponCut(rule, dish, s.subtotal);
              if (cut > potential) potential = cut;
            });
          } else {
            potential = E.estimateCouponCut(rule, dish, orderTotal);
          }
          if (potential > 0) {
            row.status = 'skipped';
            row.estimatedCut = potential;
            row.reason = withBase(couponRow, '可省但本轮未排上：每单限用 1 张券，已分配收益更高的券（本单最多可省 ' + yuan(potential) + '）');
          } else {
            row.status = 'no-benefit';
            row.reason = withBase(couponRow, '当前餐单里这张券估省为 0：没有它减免的菜品，或未到使用门槛');
          }
          return row;
        });
        var byMember = {};
        rows.forEach(function (r) {
          if (r.status !== 'used') return;
          byMember[r.usedBy] = round((byMember[r.usedBy] || 0) + r.estimatedCut);
        });
        var stats = {
          total: rows.length,
          applicable: rows.filter(function (r) { return r.applicable && useCoupons; }).length,
          used: rows.filter(function (r) { return r.status === 'used'; }).length,
          skipped: rows.filter(function (r) { return r.status === 'skipped'; }).length,
          unavailable: rows.filter(function (r) { return r.status === 'unavailable'; }).length,
          noBenefit: rows.filter(function (r) { return r.status === 'no-benefit'; }).length,
          estimatedCutTotal: round(rows.reduce(function (s, r) {
            return s + (r.status === 'used' ? r.estimatedCut : 0);
          }, 0)),
          byMember: Object.keys(byMember).map(function (k) {
            return { member: k, estimatedCut: byMember[k] };
          })
        };
        var notes = [
          '券收益为券面规则估算：官方 available-coupons 不返回券 code，无法代入 calculate-price 真实试算；领取与核销请在麦当劳 APP / 小程序完成',
          '每单最多用 1 张券：官方未提供叠加规则，不假设可以叠'
        ];
        if (dining === 'delivery') {
          notes.push('外送单：官方 calculate-price 需 orderType=2 且带地址 beCode；配送费/餐盒费以官方返回为准，离线快照只有到店价、外送侧未估算');
        } else if (dining === 'dineIn') {
          notes.push('堂食单：按到店自取（orderType=1）算价，不涉及配送费');
        } else {
          notes.push('未说明堂食/外送：算价与用券按通用处理；说明之后可切换为官方 orderType=1/2 精确算价');
        }
        notes.push('堂食/外送适用性依据券面标题文字判断：官方 query-store-coupons 才按订单类型返回可用券，本工具未调用该接口');
        if (blocked.length) {
          notes.push('已按券面标题剔除 ' + blocked.length + ' 张不适配当前用餐方式的券：' +
            blocked.map(function (r) { return '「' + r.title + '」（' + r.typeLabel + '）'; }).join('、'));
        }
        if (unlabeled.length) {
          notes.push(unlabeled.length + ' 张券面未标注适用范围，按通用券处理（账本里已逐行标注）');
        }
        return { rows: rows, stats: stats, notes: notes };
      }

      function finalize(realResults) {
        var result = {
          orderMode: orderMode,
          dining: dining,
          diningLabel: dining ? ((E.DINING_LABEL || {})[dining] || dining) : '未说明'
        };
        if (orderMode === 'split') {
          var subOrders = core.built.subOrders.map(function (s, i) {
            var real = realResults ? realResults[i] : null;
            return {
              index: s.index,
              name: s.name,
              items: s.items,
              subtotal: s.subtotal,
              coupon: s.coupon,
              payAfterCoupon: s.payAfterCoupon,
              real: real ? {
                price: real.price, originalPrice: real.originalPrice,
                deliveryPrice: real.deliveryPrice != null ? real.deliveryPrice : null,
                packingPrice: real.packingPrice != null ? real.packingPrice : null,
                tablewarePrice: real.tablewarePrice != null ? real.tablewarePrice : null,
                requestId: real.requestId || null
              } : null
            };
          });
          var splitRealTotal = null, splitDelivery = null;
          if (realResults) {
            splitRealTotal = 0; splitDelivery = 0;
            realResults.forEach(function (r) {
              if (r && typeof r.price === 'number') splitRealTotal += r.price;
              if (r && typeof r.deliveryPrice === 'number') splitDelivery += r.deliveryPrice;
            });
            splitRealTotal = round(splitRealTotal);
            splitDelivery = round(splitDelivery);
          }
          var splitSubtotal = core.built.total;
          var splitPay = round(splitSubtotal - core.couponResult.totalCut + (splitDelivery || 0));
          var combinedPay = round(plan.totalPrice - core.combinedCut);
          var diff = round(splitPay - combinedPay);
          result.splitMode = 'byItem';
          result.people = members.length;
          result.members = subOrders;
          result.couponsUsed = subOrders.filter(function (s) { return s.coupon; })
            .map(function (s) { return { member: s.name, title: s.coupon.title, estimatedCut: s.coupon.estimatedCut }; });
          result.combined = {
            total: plan.totalPrice,
            coupon: core.combinedCoupon,
            estimatedCouponCut: core.combinedCut,
            payEstimate: combinedPay,
            actual: false
          };
          result.totals = {
            splitSubtotal: splitSubtotal,
            estimatedCouponCut: core.couponResult.totalCut,
            splitDeliveryFees: splitDelivery,
            splitPayEstimate: splitPay,
            splitRealTotal: splitRealTotal
          };
          result.comparison = {
            cheaper: diff < -0.005 ? 'split' : (diff > 0.005 ? 'combined' : 'tie'),
            diff: diff,
            verdict: diff < -0.005
              ? '拆单各用券，估算省 ' + yuan(-diff) + '（配送费' + (splitDelivery ? '已按官方返回计入' : '未计入') + '）'
              : (diff > 0.005
                ? '合单更划算：拆单估算多付 ' + yuan(diff) + (splitDelivery ? '（含各单配送费）' : '')
                : '两条路子估算打平')
          };
          result.balanced = core.built.balanced;
        } else {
          /* 一人点完所有人：全单一张券，人均用最大余额法分摊（Σ各人 === 全单应付） */
          var real = realResults ? realResults[0] : null;
          var deliveryFee = (real && typeof real.deliveryPrice === 'number') ? real.deliveryPrice : 0;
          var packingFee = (real && typeof real.packingPrice === 'number') ? real.packingPrice : 0;
          var payEstimate = round(orderTotal - core.bestCut + deliveryFee + packingFee);
          var rawShares = members.map(function () { return payEstimate * 100 / members.length; });
          var shares = E.largestRemainder(rawShares, Math.round(payEstimate * 100))
            .map(function (c) { return Math.round(c) / 100; });
          var minShare = Math.min.apply(null, shares), maxShare = Math.max.apply(null, shares);
          var perText = (minShare === maxShare) ? yuan(minShare) : (yuan(minShare) + '~' + yuan(maxShare));
          /* 省事 vs 省钱的参照：各自点能省多少（离线估算，配送费拿不到、不计入） */
          var altBuilt = E.buildSubOrders(planItems, members, owners);
          var altCoupon = { totalCut: 0 };
          if (eligible.length) altCoupon = E.optimizeCoupons(altBuilt.subOrders, eligible, DISHES);
          var altPay = round(altBuilt.total - altCoupon.totalCut);
          var altDiff = round(payEstimate - altPay);
          result.splitMode = 'together';
          result.people = members.length;
          result.members = members.map(function (m, i) {
            return { index: i, name: m.name, items: null, subtotal: shares[i],
                     coupon: null, payAfterCoupon: shares[i], share: true, real: null };
          });
          result.couponsUsed = core.best
            ? [{ member: '合单（一人点完所有人）', title: core.best.title, estimatedCut: core.best.estimatedCut }]
            : [];
          result.combined = {
            total: plan.totalPrice,
            coupon: core.best,
            estimatedCouponCut: core.bestCut,
            payEstimate: payEstimate,
            actual: true,
            real: real ? {
              price: real.price, originalPrice: real.originalPrice,
              deliveryPrice: real.deliveryPrice != null ? real.deliveryPrice : null,
              packingPrice: real.packingPrice != null ? real.packingPrice : null,
              tablewarePrice: real.tablewarePrice != null ? real.tablewarePrice : null,
              requestId: real.requestId || null
            } : null
          };
          result.totals = {
            splitSubtotal: orderTotal,
            estimatedCouponCut: core.bestCut,
            splitDeliveryFees: (real && typeof real.deliveryPrice === 'number') ? real.deliveryPrice : null,
            splitPayEstimate: payEstimate,
            splitRealTotal: (real && typeof real.price === 'number') ? real.price : null
          };
          result.comparison = {
            cheaper: 'together',
            diff: altDiff,
            verdict: altDiff > 0.005
              ? '省事模式：一人点完所有人，全单一张券，人均 ' + perText + '。若改成各自点用券，离线估算可省 ' +
                yuan(altDiff) + '（各自点多付 ' + (members.length - 1) + ' 次配送费，离线未估算）'
              : (altDiff < -0.005
                ? '省事模式：一人点完所有人，全单一张券，人均 ' + perText + '。各自点离线估算反而多付 ' +
                  yuan(-altDiff) + '，当前合单更省'
                : '省事模式：一人点完所有人，全单一张券，人均 ' + perText + '。两条路子离线估算打平')
          };
          result.balanced = true;
        }

        result.ledger = buildLedger();
        var notes = [
          '券收益为券面规则估算：官方 available-coupons 不返回券 code，无法代入 calculate-price 真实试算；领取与核销请在麦当劳 APP / 小程序完成',
          '每单最多用 1 张券：官方未提供叠加规则，不假设可以叠'
        ];
        if (SIMULATED) {
          notes.push('离线预演：各单金额为快照价；配送费官方未在快照中提供，未计入对比');
        }
        if (dining === 'delivery') {
          notes.push('外送/麦乐送单：在线算价按官方 orderType=2（需地址 beCode）；离线不估算配送费');
        } else if (dining === 'dineIn') {
          notes.push('到店/堂食单：在线算价按官方 orderType=1');
        } else {
          notes.push('未说明堂食/外送：算价与用券按通用方式处理');
        }
        if (blocked.length) {
          notes.push('已剔除 ' + blocked.length + ' 张不适配当前用餐方式的券（明细见券账本）');
        }
        if (orderMode === 'together') {
          notes.push('一人点完所有人模式：全单一张券，人均金额用最大余额法分摊，Σ各人等于全单应付');
        }
        if (realResults && realResults[0] && realResults[0].ok === false) {
          notes.push('官方算价调用失败（' + (realResults[0].error || '未知错误') + '）：金额回退为快照价估算');
        }
        result.notes = notes;
        return stamp(result);
      }
    }

    /* assignOrders：多人拆单 · 分人用券（问题一/三/四）
     * 返回形状对旧版 UI 保持兼容（split 模式的 members/totals/comparison/comparison.verdict
     * 字段没动）；新增 orderMode/dining/ledger，together 模式见 MESSAGE_TO_GPT_7。 */
    function assignOrders(planId, opt) {
      opt = opt || {};
      var plan = plans[planId];
      if (!plan) {
        return Promise.reject(Object.assign(
          new Error('planId 不存在或已过期'), { code: 'NO_PLAN' }));
      }
      return assignCore(plan, opt);
    }

    /* couponLedger：券账本独立入口。
     * 与 assignOrders 同一套 assignCore 计算（不发起官方算价调用），
     * 只回账本：UI 想在拆单结果旁边单独渲染「每张券去哪了」时调它。 */
    function couponLedger(planId, opt) {
      opt = opt || {};
      var plan = plans[planId];
      if (!plan) {
        return Promise.reject(Object.assign(
          new Error('planId 不存在或已过期'), { code: 'NO_PLAN' }));
      }
      return assignCore(plan, Object.assign({}, opt, { real: false })).then(function (r) {
        return stamp({
          planId: planId,
          orderMode: r.orderMode,
          dining: r.dining,
          diningLabel: r.diningLabel,
          ledger: r.ledger
        });
      });
    }

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
      parseQuery: function (text, dishes) { return p(parseQuery(text, dishes, E)); },
      parseQuerySync: parseQuery,
      recommendPlans: recommendPlans,
      getPlan: getPlan,
      calculatePlan: calculatePlan,
      splitBill: splitBill,
      assignOrders: assignOrders,
      couponLedger: couponLedger,
      buildOrderSummary: buildOrderSummary,
      mode: function () { return MODE; },
      isSimulated: function () { return SIMULATED; },
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
