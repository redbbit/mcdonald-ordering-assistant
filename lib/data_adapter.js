/**
 * 双模式数据层
 * ============================================================================
 * 上层算法和 UI 只依赖 DataAdapter 接口，绝不出现散落的 `if (mode === 'online')`。
 *
 *   ┌────────────┐ fetch localhost   ┌──────────┐  Bearer Token  ┌─────────────┐
 *   │ OnlineAdapter │ ─────────────► │ server.py │ ────────────► │ mcp.mcd.cn  │
 *   └────────────┘                   └──────────┘                └─────────────┘
 *   ┌─────────────┐ 读 window.MCD_DATA*
 *   │ OfflineAdapter │ 快照是构建期真调 MCP 落盘的
 *   └─────────────┘
 *
 * Token 只存在于 server.py 进程里。浏览器永远拿不到，也就永远不可能泄露。
 *
 * 三条铁律（破坏任何一条都等于伪造数据）：
 *   1. 离线 calculatePrice 返回 null         —— 不伪造价格
 *   2. 离线 probeItems 返回 'unknown'         —— 不伪造售罄(60006)
 *   3. 离线 tryCoupons / splitBill 带 simulated:true —— 不假装真实试算
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.McAdvisorData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  // 端口与 server.py 的 DEFAULT_PORT 保持一致，改一处必须改两处
  var DEFAULT_BASE = 'http://127.0.0.1:4317';
  var PROBE_TIMEOUT_MS = 2500;      // 探测要快，超时就降级，不能让页面卡住等

  function nowIso() { return new Date().toISOString(); }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

  /* ==================================================== 工具 */

  function withTimeout(promise, ms, code) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        var e = new Error(code === 'timeout' ? '探测超时' : '请求超时');
        e.code = 'timeout';
        reject(e);
      }, ms);
      promise.then(function (v) { clearTimeout(timer); resolve(v); },
                   function (e) { clearTimeout(timer); reject(e); });
    });
  }

  /** 统一网络请求。只发给本机服务，绝不带任何凭据。 */
  function apiRequest(base, path, opt) {
    opt = opt || {};
    var url = base + path;
    var init = { method: opt.method || 'GET', headers: { 'Content-Type': 'application/json' } };
    if (opt.body) init.body = JSON.stringify(opt.body);

    var p = fetch(url, init).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok || body.ok === false) {
          var err = new Error((body.error && body.error.message) || ('HTTP ' + r.status));
          err.code = (body.error && body.error.code) || 'http_' + r.status;
          err.status = r.status;
          throw err;
        }
        return body;                       // 信封：{ ok, mode, requestId, fetchedAt, data }
      });
    });
    return opt.timeout ? withTimeout(p, opt.timeout, 'timeout') : p;
  }

  /* ==================================================== 离线实现 */

  /**
   * OfflineAdapter —— 读构建期真调 MCP 落盘的快照。
   * 快照本身是真的（122 款每款都跑过官方 calculate-price），
   * 但它是"某个时刻"的真，不是"此刻"的真，所以涉及当场核价的动作一律降级。
   */
  function OfflineAdapter(opt) {
    opt = opt || {};
    var G = typeof globalThis !== 'undefined' ? globalThis : window;
    this.mode = 'offline';
    this.base = null;
    this.slotsConfig = opt.slotsConfig || [
      { key: 'teatime', var: 'MCD_DATA', label: '下午茶' },
      { key: 'night', var: 'MCD_DATA_NIGHT', label: '夜市' },
      { key: 'latenight', var: 'MCD_DATA_LATENIGHT', label: '宵夜' }
    ];
    this.activeSlot = opt.slot || null;
    this._G = G;
  }

  OfflineAdapter.prototype._data = function (slot) {
    var G = this._G;
    if (slot) {
      var cfg = this.slotsConfig.filter(function (s) { return s.key === slot; })[0];
      return cfg ? G[cfg.var] : null;
    }
    for (var i = 0; i < this.slotsConfig.length; i++) {
      var d = G[this.slotsConfig[i].var];
      if (d) return d;
    }
    return null;
  };

  OfflineAdapter.prototype.probeAvailability = function () {
    return Promise.resolve({
      reachable: true, mode: 'offline', reason: 'snapshot-only',
      checkedAt: nowIso(),
      note: '没有本地服务，用构建期快照'
    });
  };

  OfflineAdapter.prototype.listSlots = function () {
    var self = this;
    return this.slotsConfig
      .filter(function (c) { return !!self._G[c.var]; })
      .map(function (c) {
        var d = self._G[c.var];
        return {
          key: c.key, label: d.slotLabel || c.label, fetchedAt: d.fetchedAt,
          available: true, count: (d.dishes || []).length, source: 'snapshot'
        };
      });
  };

  OfflineAdapter.prototype.getMeta = function (slot) {
    var d = this._data(slot || this.activeSlot);
    return Promise.resolve({
      mode: 'offline', fetchedAt: d && d.fetchedAt, requestId: null,
      store: d && d.store, source: d && d.source
    });
  };

  OfflineAdapter.prototype.getStore = function (slot) {
    var d = this._data(slot || this.activeSlot);
    return Promise.resolve(clone(d && d.store) || null);
  };

  OfflineAdapter.prototype.getMenu = function (slot) {
    var d = this._data(slot || this.activeSlot);
    return Promise.resolve(clone((d && d.dishes) || []));
  };

  OfflineAdapter.prototype.getCampaigns = function () {
    var G = this._G;
    return Promise.resolve(clone(G.MCD_CAMPAIGNS || { coupons: [], campaigns: [] }));
  };

  OfflineAdapter.prototype.getNutrition = function (codes) {
    var d = this._data(this.activeSlot);
    var dishes = (d && d.dishes) || [];
    var out = {};
    (codes || []).forEach(function (c) {
      for (var i = 0; i < dishes.length; i++) {
        if (dishes[i].code === c) {
          out[c] = { kcal: dishes[i].kcal, protein: dishes[i].protein,
                     fat: dishes[i].fat, carb: dishes[i].carb, sodium: dishes[i].sodium };
          return;
        }
      }
    });
    return Promise.resolve(out);
  };

  /** 离线只用本地缓存，不发起任何网络请求。 */
  OfflineAdapter.prototype.resolveImage = function (dish) {
    var local = (dish && (dish.imgLocal || dish.imageLocal)) || null;
    var fallback = { url: 'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
        '<rect width="200" height="200" fill="#f0e9df"/>' +
        '<text x="100" y="105" font-size="13" text-anchor="middle" fill="#9a8f80">占位图</text></svg>'),
      ok: false, fallback: true, source: 'placeholder' };
    return Promise.resolve(local
      ? { url: local, ok: true, fallback: false, source: 'cache' }
      : fallback);
  };

  /** 铁律 1：离线不算价，返回 null。UI 必须据此显示黄色「预演校验」。 */
  OfflineAdapter.prototype.calculatePrice = function () {
    return Promise.resolve({
      available: false, mode: 'offline', reason: 'offline-no-price',
      simulated: true, payPrice: null
    });
  };

  /** 铁律 2：离线不探测库存，一律 unknown。 */
  OfflineAdapter.prototype.probeItems = function (codes) {
    return Promise.resolve({
      mode: 'offline',
      items: (codes || []).map(function (c) { return { code: c, state: 'unknown' }; })
    });
  };

  /** 铁律 3：离线券只能按券面规则匹配，必须标 simulated。 */
  OfflineAdapter.prototype.tryCoupons = function (items, coupons) {
    var rules = [];
    (coupons || []).forEach(function (cp) {
      var min = parseFloat((String(cp.minSpend || cp.threshold || '').replace(/[^\d.]/g, '')) || 0);
      var cut = parseFloat((String(cp.amount || cp.discount || '').replace(/[^\d.]/g, '')) || 0);
      var total = (items || []).reduce(function (s, i) {
        return s + (parseFloat(i.price) || 0) * (parseInt(i.qty, 10) || 1);
      }, 0);
      rules.push({
        code: cp.code || cp.id || null, title: cp.title || cp.name,
        matched: min > 0 ? total >= min : true,
        estimatedCut: cut || 0,
        simulated: true,
        reason: 'offline-rule-match'
      });
    });
    return Promise.resolve({ mode: 'offline', simulated: true, coupons: rules });
  };

  /* ==================================================== 在线实现 */

  function OnlineAdapter(opt) {
    opt = opt || {};
    this.mode = 'online';
    this.base = (opt.base || DEFAULT_BASE).replace(/\/$/, '');
    this.activeSlot = opt.slot || null;
    this.timeout = opt.timeout || 15000;
  }

  OnlineAdapter.prototype._req = function (path, opt) {
    var o = Object.assign({}, opt || {});
    if (o.timeout == null) o.timeout = this.timeout;
    return apiRequest(this.base, path, o);
  };

  OnlineAdapter.prototype.probeAvailability = function () {
    // 探测必须短超时：连不上就赶紧降级，别让用户干等
    return this._req('/api/health', { timeout: PROBE_TIMEOUT_MS })
      .then(function (env) {
        return {
          reachable: !!(env.data && env.data.mcp && env.data.mcp.reachable),
          mode: 'online', checkedAt: nowIso(),
          latencyMs: env.data && env.data.mcp && env.data.mcp.latencyMs,
          requestId: env.requestId
        };
      })
      .catch(function (e) {
        // 注意：这不是失败，是**降级信号**。前端据此切 OfflineAdapter，不要弹红字报错。
        var err = new Error(e && e.message);
        err.code = (e && e.code) || 'network';
        err.degrade = true;
        throw err;
      });
  };

  OnlineAdapter.prototype.getMeta = function () {
    return this._req('/api/health').then(function (env) {
      return { mode: 'online', fetchedAt: env.fetchedAt, requestId: env.requestId,
               tools: env.data && env.data.tools, storeCode: env.data && env.data.storeCode };
    });
  };

  OnlineAdapter.prototype.getStore = function () {
    return this._req('/api/store').then(function (r) { return r.data; });
  };

  OnlineAdapter.prototype.getMenu = function () {
    return this._req('/api/menu').then(function (r) { return r.data; });
  };

  OnlineAdapter.prototype.getCampaigns = function () {
    return this._req('/api/campaigns').then(function (r) { return r.data; });
  };

  OnlineAdapter.prototype.getNutrition = function () {
    return this._req('/api/nutrition').then(function (r) { return r.data; });
  };

  OnlineAdapter.prototype.resolveImage = function (dish) {
    var src = (dish && (dish.img || dish.imageRemote)) || null;
    if (!src) return Promise.resolve({ ok: false, fallback: true, source: 'placeholder' });
    // 走本机代理：浏览器不直接访问外部 CDN，代理那边有域名白名单
    return Promise.resolve({
      url: this.base + '/api/img?src=' + encodeURIComponent(src),
      ok: true, fallback: false, source: 'proxy'
    });
  };

  OnlineAdapter.prototype.calculatePrice = function (items, opt) {
    opt = opt || {};
    var body = { storeCode: opt.storeCode, items: items };
    return this._req('/api/price', { method: 'POST', body: body }).then(function (r) {
      return Object.assign({ available: true, mode: 'online', simulated: false },
                           r.data, { requestId: r.requestId, fetchedAt: r.fetchedAt });
    });
  };

  OnlineAdapter.prototype.probeItems = function (codes, opt) {
    opt = opt || {};
    return this._req('/api/probe', { method: 'POST', body: { storeCode: opt.storeCode, codes: codes } })
      .then(function (r) {
        return { mode: 'online', simulated: false, requestId: r.requestId, items: r.data.items };
      });
  };

  OnlineAdapter.prototype.tryCoupons = function (items, coupons, opt) {
    opt = opt || {};
    // 真实逐张试算：每一张都单独走一次官方 calculate-price
    var self = this;
    var jobs = (coupons || []).map(function (cp) {
      return self.calculatePrice(items, { storeCode: opt.storeCode, couponCode: cp.code || cp.id })
        .then(function (r) {
          return { code: cp.code || cp.id, title: cp.title || cp.name,
                   ok: true, realCut: r.couponDiscount, simulated: false };
        })
        .catch(function (e) {
          return { code: cp.code || cp.id, title: cp.title || cp.name,
                   ok: false, simulated: false,
                   reason: e.code === 'coupon_not_in_window' ? 'not-in-window' : e.code };
        });
    });
    return Promise.all(jobs).then(function (list) {
      return { mode: 'online', simulated: false, coupons: list };
    });
  };

  /* ==================================================== Mock（给 UI 联调用） */

  /**
   * MockOnlineAdapter —— 不需要真后端就能把五种情形跑一遍。
   * 用法：new MockOnlineAdapter({ scenario: 'soldout' | 'coupon_window' | 'ratelimited' | 'timeout' | 'ok' })
   */
  function MockOnlineAdapter(opt) {
    opt = opt || {};
    this.mode = 'online';
    this.base = 'mock://local';
    this.scenario = opt.scenario || 'ok';
    this.latency = opt.latency == null ? 120 : opt.latency;
    this.activeSlot = opt.slot || null;
  }

  MockOnlineAdapter.prototype._delay = function (value) {
    var self = this;
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (self.scenario === 'timeout') { var e = new Error('模拟超时'); e.code = 'timeout'; return reject(e); }
        resolve(value);
      }, self.latency);
    });
  };

  MockOnlineAdapter.prototype.probeAvailability = function () {
    return this._delay({ reachable: this.scenario !== 'timeout', mode: 'online',
                         checkedAt: nowIso(), latencyMs: this.latency });
  };

  MockOnlineAdapter.prototype.getMeta = function () {
    return this._delay({ mode: 'online', fetchedAt: nowIso(), requestId: 'mock-' + Date.now(),
                         note: 'Mock 数据，非真实 MCP 调用' });
  };

  MockOnlineAdapter.prototype.getStore = function () {
    return this._delay({ code: '1400028', name: '麦当劳广州新港西路餐厅（Mock）', distance: 102 });
  };

  MockOnlineAdapter.prototype.getMenu = function () { return this._delay([]); };
  MockOnlineAdapter.prototype.getCampaigns = function () { return this._delay({ coupons: [], campaigns: [] }); };
  MockOnlineAdapter.prototype.getNutrition = function () { return this._delay({}); };

  MockOnlineAdapter.prototype.resolveImage = function () {
    return this._delay({ ok: this.scenario !== 'timeout', fallback: this.scenario === 'timeout',
                         source: 'proxy' });
  };

  MockOnlineAdapter.prototype.calculatePrice = function () {
    var s = this.scenario;
    return this._delay(null).then(function () {
      if (s === 'ratelimited') { var e = new Error('模拟 429 限流'); e.code = 'rate_limited'; throw e; }
      if (s === 'soldout') { var e2 = new Error('模拟 60006 售罄'); e2.code = 'soldout'; throw e2; }
      return { available: true, mode: 'online', simulated: false, price: 86.3,
               originalPrice: 102.0, requestId: 'mock-price-' + Date.now() };
    });
  };

  MockOnlineAdapter.prototype.probeItems = function (codes) {
    var s = this.scenario;
    return this._delay((codes || []).map(function (c, i) {
      return { code: c, state: s === 'soldout' && i === 0 ? 'soldout' : 'available' };
    })).then(function (items) { return { mode: 'online', simulated: false, items: items }; });
  };

  MockOnlineAdapter.prototype.tryCoupons = function (items, coupons) {
    var s = this.scenario;
    return this._delay((coupons || []).map(function (cp) {
      return { code: cp.code, title: cp.title, ok: s !== 'coupon_window',
               simulated: false,
               reason: s === 'coupon_window' ? 'not-in-window' : null,
               realCut: s === 'coupon_window' ? 0 : 5 };
    })).then(function (list) { return { mode: 'online', simulated: false, coupons: list }; });
  };

  /* ==================================================== 模式选择 */

  /**
   * 决定用哪个 adapter。原则：**永远保证有东西可用**。
   * 在线探不到，就降级到离线；离线快照也没有，那才是真的没救。
   */
  function detectAdapter(opt) {
    opt = opt || {};
    if (opt.force === 'offline') {
      return Promise.resolve({ adapter: new OfflineAdapter(opt), degraded: false, reason: 'forced' });
    }
    if (opt.force === 'mock') {
      return Promise.resolve({ adapter: new MockOnlineAdapter(opt), degraded: false, reason: 'forced' });
    }

    var online = new OnlineAdapter(opt);
    return online.probeAvailability()
      .then(function (probe) {
        if (probe.reachable) return { adapter: online, degraded: false, probe: probe };
        return { adapter: new OfflineAdapter(opt), degraded: true, reason: 'unreachable', probe: probe };
      })
      .catch(function (e) {
        return { adapter: new OfflineAdapter(opt), degraded: true, reason: e.code || 'network', probe: null };
      });
  }

  return {
    VERSION: VERSION,
    DEFAULT_BASE: DEFAULT_BASE,
    OfflineAdapter: OfflineAdapter,
    OnlineAdapter: OnlineAdapter,
    MockOnlineAdapter: MockOnlineAdapter,
    detectAdapter: detectAdapter,
    withTimeout: withTimeout
  };
});
