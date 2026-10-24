(function () {
  'use strict';

  var S;
  var state = { meta: null, showcase: [], campaigns: [], coupons: [], activeCoupon: null, plans: [], selected: new Set(), slots: [], activeSlot: '', lastQuery: null, slotRevision: 0, slide: 0, campaignSlide: 0, toastTimer: 0, rotationTimer: 0, campaignTimer: 0, adapter: null, mode: 'offline', degraded: false, degradeReason: '', requestId: '', availability: {} };
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    metaLine: $('metaLine'), slotSelector: $('slotSelector'), conversation: $('conversation'), request: $('requestText'), charCount: $('charCount'), form: $('advisorForm'), submit: $('submitButton'),
    people: $('people'), budgetMin: $('budgetMin'), budgetMax: $('budgetMax'), unlimited: $('unlimited'), goal: $('goal'), avoid: $('avoidOptions'), goals: $('goalChips'),
    results: $('resultsSection'), planGrid: $('planGrid'), notices: $('noticeStack'), error: $('errorBanner'), selectionBar: $('selectionBar'), selectedCount: $('selectedCount'),
    summaryOutput: $('summaryOutput'), summaryText: $('summaryText'), showcaseImage: $('showcaseImage'), heroName: $('heroName'), heroCategory: $('heroCategory'), heroPrice: $('heroPrice'),
    heroOriginal: $('heroOriginal'), heroLabels: $('heroLabels'), heroSource: $('heroSource'), heroAction: $('heroAction'), slideIndex: $('slideIndex'), dots: $('carouselDots'),
    campaignTrack: $('campaignTrack'), campaignPosition: $('campaignPosition'), couponDialog: $('couponDialog'), couponList: $('couponList'), couponCount: $('couponCount'), toast: $('toast')
  };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
  }
  function money(value) { return value == null || !isFinite(Number(value)) ? '—' : '¥' + Number(value).toFixed(2).replace(/\.00$/, ''); }
  function num(value, digits) { return value == null || !isFinite(Number(value)) ? '—' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits == null ? 1 : digits }); }
  function attr(value) { return esc(value).replace(/`/g, '&#96;'); }
  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('is-visible');
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(function () { els.toast.classList.remove('is-visible'); }, 2400);
  }
  function fmtDateTime(raw) {
    if (!raw) return '—';
    var date = new Date(String(raw).replace(' ', 'T'));
    if (isNaN(date.getTime())) return String(raw);
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }
  function slotDisplayLabel(slot) {
    if (slot.label && slot.label !== '当前时段') return slot.label;
    var stamp = new Date(String(slot.fetchedAt || '').replace(' ', 'T'));
    if (!isNaN(stamp.getTime())) {
      var minute = stamp.getHours() * 60 + stamp.getMinutes();
      for (var i = 0; i < (slot.timeRanges || []).length; i++) {
        var range = slot.timeRanges[i].range || '';
        var match = /(\d{1,2}):(\d{2})至(\d{1,2}):(\d{2})/.exec(range);
        if (!match) continue;
        var start = Number(match[1]) * 60 + Number(match[2]);
        var end = Number(match[3]) * 60 + Number(match[4]);
        if (start <= end ? minute >= start && minute <= end : minute >= start || minute <= end) return slot.timeRanges[i].name;
      }
    }
    return slot.key || '当前菜单';
  }
  function renderSlotSelector() {
    els.slotSelector.innerHTML = state.slots.map(function (slot) {
      var label = slotDisplayLabel(slot);
      return '<option value="' + attr(slot.key || '') + '" ' + ((slot.key || '') === state.activeSlot ? 'selected' : '') + '>' + esc(label) + ' · ' + esc(fmtDateTime(slot.fetchedAt)) + '</option>';
    }).join('');
    els.slotSelector.disabled = state.slots.length < 2;
    els.slotSelector.setAttribute('aria-label', '切换菜单时段');
  }
  function imageMarkup(item, className, alt, loading) {
    item = item || {};
    var local = item.imageLocal || '';
    var remote = item.imageRemote || '';
    var initial = local || item.image || (S && S.PLACEHOLDER) || '';
    return '<img class="' + attr(className || '') + '" src="' + attr(initial) + '" data-local="' + attr(local) + '" data-remote="' + attr(remote) + '" data-stage="0" alt="' + attr(alt || item.name || item.title || '麦当劳官方图片') + '" loading="' + (loading || 'lazy') + '" decoding="async">';
  }
  function imageError(event) {
    var img = event.target;
    if (!img || img.tagName !== 'IMG') return;
    var stage = Number(img.getAttribute('data-stage') || 0);
    var remote = img.getAttribute('data-remote');
    if (stage === 0 && remote && img.src !== remote) {
      img.setAttribute('data-stage', '1');
      img.src = remote;
      return;
    }
    if (stage <= 1 && S && S.PLACEHOLDER) {
      img.setAttribute('data-stage', '2');
      img.src = S.PLACEHOLDER;
      return;
    }
    img.removeAttribute('src');
    img.classList.add('image-unavailable');
  }
  document.addEventListener('error', imageError, true);

  function buildTag(text, kind) {
    return '<span class="plan-label ' + (kind || '') + '">' + esc(text) + '</span>';
  }
  function unique(values) {
    var out = [];
    (values || []).forEach(function (v) { if (v && out.indexOf(v) < 0) out.push(v); });
    return out;
  }
  function roleLabel(item) {
    var role = { main: '主食', side: '小食', drink: '饮品', dessert: '甜品', share: '分享', chicken: '炸鸡' };
    return role[item.role] || item.cat || '菜单';
  }

  function renderShowcase() {
    if (!state.showcase.length) {
      $('showcaseImageWrap').classList.add('showcase-empty');
      els.heroName.textContent = '今日官方菜单';
      els.heroCategory.textContent = '麦当劳 MCP 快照';
      els.heroPrice.textContent = '—';
      return;
    }
    var index = ((state.slide % state.showcase.length) + state.showcase.length) % state.showcase.length;
    var item = state.showcase[index];
    var image = els.showcaseImage;
    image.setAttribute('data-stage', '0');
    image.setAttribute('data-local', item.imageLocal || '');
    image.setAttribute('data-remote', item.imageRemote || '');
    image.alt = item.name + '，麦当劳官方菜单图片';
    image.src = item.imageLocal || item.image || S.PLACEHOLDER;
    image.loading = index === 0 ? 'eager' : 'lazy';
    image.fetchPriority = index === 0 ? 'high' : 'auto';
    els.heroName.textContent = item.name || '官方菜单';
    els.heroCategory.textContent = item.cat || '官方菜单';
    els.heroPrice.textContent = money(item.price);
    if (item.originalPrice != null && Number(item.originalPrice) > Number(item.price)) {
      els.heroOriginal.textContent = money(item.originalPrice);
      els.heroOriginal.hidden = false;
    } else { els.heroOriginal.hidden = true; }
    var labels = [];
    if (item.isNew) labels.push({ text: '菜单上新', kind: '' });
    if (item.isPromo) labels.push({ text: item.dealType || '菜单活动价', kind: 'red' });
    if (!labels.length) labels.push({ text: '人气菜单', kind: '' });
    els.heroLabels.innerHTML = labels.map(function (x) { return '<span class="hero-label ' + x.kind + '">' + esc(x.text) + '</span>'; }).join('');
    els.heroSource.textContent = '图片与商品信息来自麦当劳官方 MCP · ' + (item.source || '菜单快照');
    $('imageCaption').textContent = index === 0 ? '趁热咬下，香气正好' : (item.isNew ? '新鲜上桌，尝一口新意' : '这一口，刚刚好');
    $('showcaseImageWrap').setAttribute('data-product-code', item.productCode || '');
    els.slideIndex.innerHTML = String(index + 1).padStart(2, '0') + ' <b>/</b> ' + String(state.showcase.length).padStart(2, '0');
    els.dots.innerHTML = state.showcase.slice(0, 8).map(function (_, i) {
      return '<button class="carousel-dot" type="button" data-slide="' + i + '" aria-label="展示第 ' + (i + 1) + ' 个菜单" aria-current="' + (i === index ? 'true' : 'false') + '"></button>';
    }).join('');
  }
  function renderCampaigns() {
    if (!state.campaigns.length) {
      els.campaignTrack.innerHTML = '<article class="campaign-card"><div></div><div><span class="campaign-type">官方活动日历</span><h3>暂时没有今日活动快照</h3><p>菜单与商品快照仍可用于个性化配餐。</p></div></article>';
      els.campaignPosition.textContent = '—';
      return;
    }
    els.campaignTrack.innerHTML = state.campaigns.map(function (campaign, i) {
      var d = Object.assign({}, campaign, { name: campaign.title });
      var description = (campaign.desc || '').replace(/\s+/g, ' ').trim();
      return '<article class="campaign-card" data-campaign-index="' + i + '">' + imageMarkup(d, '', campaign.title + '，麦当劳官方活动图片') +
        '<div><span class="campaign-type">官方活动 · ' + esc(campaign.date || '今日') + '</span><h3>' + esc(campaign.title) + '</h3><p>' + esc(description) + '</p><button class="campaign-prompt" type="button" data-campaign-request="' + i + '">把这条活动加入配餐需求　↗</button></div></article>';
    }).join('');
    updateCampaignPosition();
  }
  function updateCampaignPosition() {
    var total = state.campaigns.length;
    if (!total) return;
    state.campaignSlide = (state.campaignSlide + total) % total;
    els.campaignTrack.style.transform = 'translateX(-' + (state.campaignSlide * 100) + '%)';
    els.campaignPosition.textContent = String(state.campaignSlide + 1).padStart(2, '0') + ' / ' + String(total).padStart(2, '0');
  }
  function renderCoupons() {
    els.couponCount.textContent = String(state.coupons.length);
    if (!state.coupons.length) {
      els.couponList.innerHTML = '<p class="soft-placeholder">当前快照没有可展示的优惠券。</p>';
      return;
    }
    els.couponList.innerHTML = state.coupons.map(function (coupon, i) {
      return '<article class="coupon-card">' + imageMarkup(coupon, '', coupon.title + '，麦当劳官方优惠券图片') +
        '<div class="coupon-copy"><h3>' + esc(coupon.title) + '</h3><p>可领券 · ' + esc(coupon.source || '麦当劳官方 MCP') + '</p></div>' +
        '<button class="coupon-use" type="button" data-coupon-index="' + i + '">' + (state.activeCoupon && state.activeCoupon.title === coupon.title ? '已带入清单 ✓' : '带入本次清单') + '</button></article>';
    }).join('');
  }
  function renderMeta() {
    if (!state.meta) return;
    var store = state.meta.store || {};
    var slot = store.slotNow;
    var slotText = typeof slot === 'string' ? slot : (slot && (slot.name || slot.label || slot.slot)) || store.slotText || '当前菜单';
    var simulated = state.mode !== 'online' || state.degraded;
    var modeLabel = simulated ? '离线预演' : '在线 MCP';
    var requestId = state.requestId || state.meta.requestId || '';
    els.metaLine.innerHTML = '<span class="meta-dot ' + (simulated ? 'meta-dot-offline' : '') + '"></span><span>' + modeLabel + ' · 更新于 ' + esc(fmtDateTime(state.meta.fetchedAt)) + ' · ' + esc(slotText) + (requestId ? ' · ID ' + esc(requestId) : '') + '</span>';
    els.metaLine.title = simulated ? (state.degradeReason || '使用本地快照，在线状态未被校验') : '在线数据来自本机 MCP 服务';
    if (simulated) {
      els.notices.innerHTML = '<div class="notice offline-notice"><strong>离线预演</strong> 当前显示本地快照，价格和优惠券未向 MCP 实时校验；库存以门店实际为准。' + (state.degradeReason ? ' ' + esc(state.degradeReason) : '') + '</div>';
    }
  }
  function renderAvoidOptions(options, selectedValues) {
    selectedValues = selectedValues || [];
    if (!options.length) { els.avoid.innerHTML = '<span class="soft-placeholder">无忌口选项</span>'; return; }
    els.avoid.innerHTML = options.map(function (option) {
      var id = 'avoid-' + option.value.replace(/[^\w\u4e00-\u9fa5]/g, '');
      return '<label class="avoid-tag"><input type="checkbox" value="' + attr(option.value) + '" id="' + attr(id) + '" ' + (selectedValues.indexOf(option.value) >= 0 ? 'checked' : '') + '><span>' + esc(option.value) + '</span></label>';
    }).join('');
  }
  function renderGoalOptions(options) {
    var preferred = ['lose', 'bulk', 'new', 'full', 'balance', 'cheap'];
    options.sort(function (a, b) { return preferred.indexOf(a.key) - preferred.indexOf(b.key); });
    els.goals.innerHTML = '<span class="goal-chip-label">常见目标</span>' + options.slice(0, 6).map(function (goal) {
      return '<button class="goal-chip" type="button" data-goal="' + attr(goal.label) + '">' + esc(goal.label) + '</button>';
    }).join('');
  }

  function renderPlan(plan) {
    var tierNames = { budget: '省钱聚餐', lean: '低卡高蛋白', new: '新品尝鲜' };
    var items = plan.items || [];
    var tags = [];
    (plan.newTags || []).forEach(function (t) { tags.push(buildTag(t, 'new')); });
    (plan.promoTags || []).forEach(function (t) { tags.push(buildTag(t, 'promo')); });
    if (!tags.length) tags.push(buildTag('按你的需求搭配', ''));
    var itemHtml = items.map(function (item) {
      var imgObj = { image: item.image, imageLocal: item.imageLocal, imageRemote: item.imageRemote, name: item.name };
      var itemCode = item.productCode || item.code || item.product_code || '';
      var availability = state.availability[itemCode] || item.availability;
      var stock = (plan.simulated === true || state.mode !== 'online' || availability === 'unknown') ? '<small class="stock-unknown">库存以门店为准</small>' : ((availability === 'soldout') ? '<small class="stock-soldout">在线探测：售罄</small>' : ((availability === 'available' || availability === 'ok') ? '<small class="stock-available">在线探测：可售</small>' : '<small class="stock-unknown">库存未校验</small>'));
      // 套餐 vs 散件对比（问题四）：按官方子项单点价重算，省了多少直接写在菜品上。
      // 子项只对上一部分价时，partsTotal 是下限 → save 也是下限，文案必须带「起」，不装全知
      var comboBadge = '';
      var combo = item.combo;
      if (combo && combo.save > 0) {
        comboBadge = '<small class="combo-save" title="套餐 ' + money(combo.comboPrice) + ' vs 子项单点合计 ' + money(combo.partsTotal) + '（' + combo.partsKnown + '/' + combo.partsCount + ' 个子项有官方价' + (combo.complete ? '' : '，为下限') + '）">套餐比单点省 ' + money(combo.save) + (combo.complete ? '' : ' 起') + '</small>';
      } else if (combo && combo.complete === false) {
        comboBadge = '<small class="combo-partial" title="部分子项官方未提供价格，未估算">套餐子项部分无官方价</small>';
      }
      return '<div class="plan-item" title="' + attr(item.name) + ' · ' + roleLabel(item) + '">' + imageMarkup(imgObj, '', item.name + '，官方商品图') +
        '<span>' + esc(item.name) + '<b>×' + esc(item.quantity) + '</b>' + stock + comboBadge + '</span></div>';
    }).join('');
    var isSimulated = plan.simulated === true || plan.mode === 'offline' || state.mode !== 'online';
    var priceNote = isSimulated ? '<span class="source-pill simulated-pill">离线预演</span>' : '<span class="source-pill live-pill">MCP 在线</span>';
    var comboTag = '';
    var cs = plan.comboSummary;
    if (cs && cs.savingCount > 0) {
      var anyPartial = items.some(function (i) { return i.combo && i.combo.complete === false; });
      comboTag = buildTag('含 ' + cs.comboCount + ' 份套餐 · 比拆开单点' + (anyPartial ? '至少省 ' : '共省 ') + money(cs.totalSave), 'combo');
    }
    return '<article class="plan-card" data-plan-id="' + attr(plan.planId) + '">' +
      '<div class="plan-main"><div class="plan-cover"><span class="plan-tier">' + esc(tierNames[plan.tier] || '个性搭配') + '</span>' + imageMarkup(items[0] || {}, '', (items[0] && items[0].name || plan.title) + '，麦当劳官方商品图') + '</div>' +
      '<div class="plan-copy"><div class="plan-title-row"><h3>' + esc(plan.title) + '</h3></div><p class="plan-subtitle">' + esc(plan.subtitle || (plan.people + ' 人 · ' + plan.itemCount + ' 款')) + '</p>' +
      '<p class="plan-why">' + esc(plan.why || '') + '</p><div class="price-line"><strong class="plan-price">' + money(plan.totalPrice) + '</strong><span class="plan-original">' + money(plan.originalPrice) + '</span><span class="save-pill">省 ' + money(plan.discount) + '</span><span class="per-person">人均 ' + money(plan.perPersonPrice) + ' · ' + esc(plan.people) + ' 人</span>' + priceNote + '</div>' +
      '<div class="plan-labels">' + tags.join('') + comboTag + '</div></div></div>' +
      '<div class="plan-items" aria-label="方案菜品">' + itemHtml + '</div>' +
      '<div class="plan-actions"><button type="button" class="detail-button" data-detail="calories" aria-expanded="false">看这顿热量</button><button type="button" class="detail-button" data-detail="nutrition" aria-expanded="false">看营养成分</button><button type="button" class="select-plan" aria-pressed="false">选这份</button></div>' +
      '<section class="detail-panel" data-panel="calories" hidden></section><section class="detail-panel" data-panel="nutrition" hidden></section></article>';
  }
  function caloriePanel(plan) {
    if (plan.totalCalories == null || plan.calorieKnown === false) {
      return '<h4>这一顿的热量</h4><div class="notice">官方未提供，未估算。此方案无法显示热量合计。</div>';
    }
    var rows = (plan.nutritionRows || []).map(function (row) {
      return '<div class="nutrition-row"><span>' + esc(row.name) + (row.quantity > 1 ? ' ×' + esc(row.quantity) : '') + '</span><span>' + (row.known && row.kcal != null ? num(row.kcal, 0) + ' kcal' : '官方未提供，未估算') + '</span></div>';
    }).join('');
    var verdict = plan.calorieVerdict === 'fit' ? '符合本方案目标' : plan.calorieVerdict === 'over' ? '已超出本方案热量目标' : '官方未提供，未估算';
    var klass = plan.calorieVerdict === 'over' ? 'over' : plan.calorieVerdict === 'fit' ? 'fit' : '';
    return '<h4>这一顿的热量</h4><div class="calorie-summary"><div class="calorie-stat"><b>' + num(plan.totalCalories, 0) + '</b><span>整顿 kcal</span></div><div class="calorie-stat"><b>' + num(plan.perPersonCalories, 2) + '</b><span>人均 kcal</span></div><div class="calorie-stat"><span class="verdict ' + klass + '">' + esc(verdict) + '</span><b>' + (plan.overCalories == null ? '—' : (plan.calorieVerdict === 'over' ? '+' : '') + num(plan.overCalories, 0)) + '</b><span>超出目标 kcal · ' + num(plan.targetCaloriesPerPerson, 0) + ' kcal / 人目标</span></div></div>' +
      '<div class="detail-rows">' + rows + '</div>' + (plan.unknownItems && plan.unknownItems.length ? '<p class="unknown-list">未提供官方数据：' + esc(plan.unknownItems.join('、')) + '。上方合计仅为已知部分下限。</p>' : '');
  }
  function nutritionPanel(plan) {
    var nutrition = plan.nutrition;
    if (!nutrition) return '<h4>营养成分</h4><div class="notice">官方未提供，未估算。此方案没有可展示的营养合计。</div>';
    var names = ['蛋白质', '脂肪', '碳水', '钠', '钙'];
    var keys = ['protein', 'fat', 'carbs', 'sodium', 'calcium'];
    var units = ['g', 'g', 'g', 'mg', 'mg'];
    var head = '<div class="nutrition-row head"><span>菜品 / 数量</span>' + names.map(function (n) { return '<span>' + n + '</span>'; }).join('') + '</div>';
    var rows = (plan.nutritionRows || []).map(function (row) {
      return '<div class="nutrition-row"><span>' + esc(row.name) + (row.quantity > 1 ? ' ×' + esc(row.quantity) : '') + '</span>' + keys.map(function (key, i) {
        return '<span>' + (row.known && row[key] != null ? num(row[key], 1) + units[i] : '官方未提供，未估算') + '</span>';
      }).join('') + '</div>';
    }).join('');
    var aggregate = '<div class="nutrition-row"><strong>已知合计</strong>' + keys.map(function (key, i) {
      return '<strong>' + (nutrition[key] == null ? '官方未提供，未估算' : num(nutrition[key], 1) + units[i]) + '</strong>';
    }).join('') + '</div>';
    var partial = Number(plan.nutritionCoverage) < 1 || nutrition.partial;
    var note = partial ? '<p class="lower-bound-note">合计为已知部分的下限。未知菜品不参与合计：' + esc((plan.unknownItems || []).join('、') || '部分营养项目') + '。此值为下限。</p>' : '<p class="lower-bound-note">营养数据来自麦当劳官方信息。</p>';
    return '<h4>官方营养成分 · 碳水、蛋白质、脂肪、钠、钙</h4><div class="detail-rows">' + head + rows + aggregate + '</div>' + note;
  }
  function selectedPlanObjects() {
    return state.plans.filter(function (plan) { return state.selected.has(plan.planId); });
  }
  function updateSelectionBar() {
    var count = state.selected.size;
    els.selectionBar.hidden = !count;
    els.selectedCount.textContent = '已选 ' + count + ' 份方案';
  }
  var WANTED_REASON = {
    'not-found': '菜单里没找到这道菜（可能是活动名称或已下架），没有加入方案',
    'avoid': '与忌口冲突，已不加入方案',
    'budget': '当前预算装不下，没有加入方案'
  };
  function showNotices(plans) {
    var first = plans && plans[0] || {};
    var notices = [];
    // ① 输入冲突：文本与控件不一致 / 忌口挡住点名菜——如实说谁生效了
    (first.conflicts || []).forEach(function (c) {
      notices.push('<div class="notice notice-warn">⚠ ' + esc(c.note) + '</div>');
    });
    // ② 点名菜没能落实的：不静默丢弃
    (first.wantedReport || []).forEach(function (w) {
      if (!w.reason) return;
      var extra = w.reason === 'avoid' && w.avoid && w.avoid.length ? '（含 ' + esc(w.avoid.join('、')) + '）' : '';
      notices.push('<div class="notice notice-warn">🍔 想吃「' + esc(w.name) + '」：' + esc(WANTED_REASON[w.reason] || w.reason) + extra + '</div>');
    });
    // ③ 目标没匹配上：温和兜底 + 可点的目标示例（不再是吓人的「没能匹配」）
    var seen = {};
    plans.forEach(function (plan) {
      var info = plan.goalInfo || {};
      if (info.recognized !== false) return;
      var key = (info.userText || '') + '|' + (info.kcal || '');
      if (seen[key]) return;
      seen[key] = true;
      var suggestions = (info.suggestions || []).map(function (label) {
        return '<button type="button" class="notice-suggestion" data-goal-suggest="' + attr(label) + '">' + esc(label) + '</button>';
      }).join('');
      notices.push('<div class="notice notice-info">🎯 你说的「' + esc(info.userText || '这个需求') + '」我先按「均衡就好」理解（' + (info.kcal || 670) + ' kcal/人）。想更准，可以点：' + suggestions + '</div>');
    });
    var markup = notices.join('');
    if (state.mode !== 'online' || state.degraded) markup = '<div class="notice offline-notice"><strong>离线预演</strong> 本地快照可用于演示；价格、优惠和库存未实时校验。库存以门店实际为准。' + (state.degradeReason ? ' ' + esc(state.degradeReason) : '') + '</div>' + markup;
    els.notices.innerHTML = markup;
  }
  function renderPlans(plans) {
    state.plans = plans;
    state.selected.clear();
    els.planGrid.innerHTML = plans.map(renderPlan).join('');
    els.results.hidden = false;
    $('resultCount').textContent = plans.length + ' 份个性化方案';
    applyResolved(plans);
    showNotices(plans);
    updateSelectionBar();
  }

  function currentAvoid() {
    return Array.prototype.slice.call(els.avoid.querySelectorAll('input:checked')).map(function (input) { return input.value; });
  }
  /* 采集控件原值交给服务层 parseQuery 统一裁决（文本 > 控件 > 默认）。
   * 冲突检测、实际生效值（resolved）都在 service.js 里做，UI 只负责展示与回填。 */
  function mergeQuery() {
    var text = els.request.value.trim();
    var budgetMax = els.budgetMax.value === '' ? null : Number(els.budgetMax.value);
    var goal = els.goal.value.trim();
    if (!goal && !text) goal = '均衡就好';
    return {
      text: text,
      people: Number(els.people.value) || 1,
      budgetMin: Number(els.budgetMin.value) || 0,
      budgetMax: budgetMax,
      unlimited: els.unlimited.checked || budgetMax == null,
      goal: goal,
      avoid: currentAvoid(),
      taste: []
    };
  }
  /* 控件双向同步：文本与控件不一致时，服务层按「文本赢」算出 resolved，
   * 这里把控件改回实际生效值并标记 touched——用户能看见"刚才那句话算出来是 3 人"，
   * 下次提交也不会再把同一个值当冲突重复报。 */
  function applyResolved(plans) {
    var first = plans && plans[0];
    var r = first && first.resolved;
    if (!r) return;
    if (r.people && Number(els.people.value) !== Number(r.people)) {
      els.people.value = r.people;
      els.people.dataset.touched = 'true';
    }
    if (r.unlimited) {
      if (!els.unlimited.checked) els.unlimited.checked = true;
      els.budgetMin.value = '';
      els.budgetMax.value = '';
      els.unlimited.dataset.touched = 'true';
    } else if (r.budgetMax != null) {
      if (els.unlimited.checked) els.unlimited.checked = false;
      if (String(els.budgetMin.value) !== String(r.budgetMin || 0)) els.budgetMin.value = r.budgetMin || 0;
      if (String(els.budgetMax.value) !== String(r.budgetMax)) els.budgetMax.value = r.budgetMax;
      els.budgetMin.dataset.touched = 'true';
      els.budgetMax.dataset.touched = 'true';
    }
    var avoidSet = {};
    (r.avoid || []).forEach(function (v) { avoidSet[v] = true; });
    els.avoid.querySelectorAll('input').forEach(function (input) {
      var should = !!avoidSet[input.value];
      if (input.checked !== should) input.checked = should;
    });
  }
  function appendMessage(kind, text) {
    var node = document.createElement('div');
    node.className = 'message ' + (kind === 'user' ? 'user-message' : 'assistant-message assistant-followup');
    if (kind === 'user') node.innerHTML = '<p>' + esc(text) + '</p>';
    else node.innerHTML = '<span class="message-face" aria-hidden="true">M</span><p>' + esc(text) + '</p>';
    els.conversation.appendChild(node);
    els.conversation.scrollTop = els.conversation.scrollHeight;
  }
  function setBusy(busy) {
    els.submit.disabled = busy;
    els.submit.querySelector('.button-label').textContent = busy ? '正在按菜单搭配…' : '给我搭三份';
    els.error.hidden = true;
  }
  async function runRecommendation(query, options) {
    options = options || {};
    var revision = state.slotRevision;
    setBusy(true);
    try {
      var plans = await S.recommendPlans(query);
      if (revision !== state.slotRevision) return;
      state.availability = {};
      var availabilityCheck = S && typeof S.checkAvailability === 'function' ? S.checkAvailability.bind(S) : (state.adapter && typeof state.adapter.checkAvailability === 'function' ? state.adapter.checkAvailability.bind(state.adapter) : null);
      if (state.mode === 'online' && availabilityCheck) {
        var codes = unique([].concat.apply([], (plans || []).map(function (plan) { return (plan.items || []).map(function (item) { return item.productCode || item.code || item.product_code; }); })).filter(Boolean));
        if (codes.length) {
          try {
            var probe = await availabilityCheck(codes);
            var rows = Array.isArray(probe) ? probe : (probe && (probe.items || probe.results)) || null;
            if (rows) rows.forEach(function (row) { var code = row.code || row.productCode || row.product_code; if (code) state.availability[code] = row.availability || row.status || (row.available === true ? 'available' : 'unknown'); });
            else if (probe && typeof probe === 'object') codes.forEach(function (code) { var value = probe[code]; state.availability[code] = typeof value === 'string' ? value : value && (value.availability || value.status) || (value && value.available === true ? 'available' : 'unknown'); });
          } catch (probeError) { codes.forEach(function (code) { state.availability[code] = 'unknown'; }); }
        }
      }
      if (revision !== state.slotRevision) return;
      renderPlans(plans);
      if (options.announce) appendMessage('assistant', options.announce);
      if (options.scroll) els.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
      try { localStorage.setItem('mcadvisor-preferences', JSON.stringify(query)); } catch (ignore) { /* 本机存储不可用时仍正常配餐 */ }
      return plans;
    } catch (error) {
      if (revision !== state.slotRevision) return;
      els.error.textContent = error && error.message ? error.message : '这次没有找到合适的组合，请稍微调整预算或忌口再试一次。';
      els.error.hidden = false;
      if (options.announceError) appendMessage('assistant', '这组条件暂时没有合适组合。可以放宽预算或减少忌口，再试一次。');
    } finally {
      if (revision === state.slotRevision) setBusy(false);
    }
  }
  async function submitRequest(event) {
    event.preventDefault();
    var text = els.request.value.trim();
    if (!text && !els.goal.value.trim() && !currentAvoid().length && els.budgetMax.value === '' && !els.unlimited.checked && els.people.dataset.touched !== 'true') {
      els.request.focus();
      showToast('先说说你想吃什么吧');
      return;
    }
    var query = mergeQuery();
    state.lastQuery = query;
    appendMessage('user', text || [query.people + ' 人', query.unlimited ? '预算不限' : '预算 ' + query.budgetMin + ' 至 ' + query.budgetMax + ' 元', query.goal].filter(Boolean).join(' · '));
    await runRecommendation(query, {
      announce: '我按你的条件搭好了三份：省钱聚餐、低卡高蛋白和新品尝鲜。每份都可以展开看热量与官方营养信息。',
      announceError: true,
      scroll: true
    });
  }

  async function toggleDetail(card, kind, button) {
    var panel = card.querySelector('[data-panel="' + kind + '"]');
    var isOpen = !panel.hidden;
    card.querySelectorAll('.detail-panel').forEach(function (p) { p.hidden = true; });
    card.querySelectorAll('.detail-button').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
    if (isOpen) return;
    var plan = state.plans.filter(function (p) { return p.planId === card.dataset.planId; })[0];
    if (!plan) return;
    button.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    panel.innerHTML = kind === 'calories' ? caloriePanel(plan) : nutritionPanel(plan);
  }
  async function selectedAction(mode) {
    var plans = selectedPlanObjects();
    if (!plans.length) return;
    var service = S;
    var revision = state.slotRevision;
    els.summaryOutput.hidden = false;
    els.summaryText.textContent = '正在生成…';
    var results = [];
    try {
      for (var i = 0; i < plans.length; i++) {
        if (mode === 'calculate') results.push(await service.calculatePlan(plans[i].planId));
        else results.push(await service.buildOrderSummary(plans[i].planId));
        if (revision !== state.slotRevision) return;
      }
      if (mode === 'summary') {
        els.summaryText.textContent = results.join('\n\n────────────────────────\n\n') + couponSummaryNote();
      } else {
        els.summaryText.textContent = results.map(function (item) {
          return '麦当劳官方算价 · ' + (item.people || '—') + ' 人 · ' + (item.storeName || '') + '\n' +
            '应付金额 ' + money(item.payPrice) + '　原价 ' + money(item.originalPrice) + '　优惠 ' + money(item.discount) + '\n' +
            '人均 ' + money(item.perPersonPrice) + '　配送/打包/餐具费用：以麦当劳官方小程序结算为准\n' + (item.note || '');
        }).join('\n\n────────────────────────\n\n') + couponSummaryNote();
      }
      els.summaryOutput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
      if (revision !== state.slotRevision) return;
      els.summaryText.textContent = error && error.message ? error.message : '暂时无法生成清单，请重试。';
    }
  }

  function splitSelectedPlan() {
    var planId = $('splitPlan').value;
    return state.plans.filter(function (plan) { return plan.planId === planId; })[0];
  }
  function renderSplitMembers() {
    var count = Math.max(1, Math.min(12, Number($('splitMembers').value) || 1));
    $('splitMembers').value = count;
    $('splitMembersList').innerHTML = Array.from({ length: count }, function (_, index) {
      return '<label class="split-member"><span>成员 ' + (index + 1) + ' 名称' + ($('splitMode').value === 'byWeight' ? ' · 权重' : '') + '</span><input type="text" data-member-name="' + index + '" value="' + (index === 0 ? '我' : '成员' + (index + 1)) + '" maxlength="20" aria-label="成员 ' + (index + 1) + ' 名称">' + ($('splitMode').value === 'byWeight' ? '<input type="number" data-member-weight="' + index + '" min="0.01" step="0.01" value="1" aria-label="成员 ' + (index + 1) + ' 分账权重">' : '') + '</label>';
    }).join('');
    var byItem = $('splitMode').value === 'byItem';
    $('splitItemsList').hidden = !byItem;
    if (byItem) renderSplitItems();
    $('splitResult').hidden = true;
    $('assignResult').hidden = true;
    $('assignResult').innerHTML = '';
  }
  function renderSplitItems() {
    var plan = splitSelectedPlan();
    if (!plan) { $('splitItemsList').innerHTML = ''; return; }
    var members = Array.from(document.querySelectorAll('[data-member-name]'));
    var options = '<option value="">公共菜 · 全员均摊</option>' + members.map(function (input, index) { return '<option value="' + index + '">' + esc(input.value || ('成员' + (index + 1))) + '</option>'; }).join('');
    $('splitItemsList').innerHTML = (plan.items || []).map(function (item) {
      return '<label class="split-item-row"><span>' + esc(item.name) + ' ×' + esc(item.quantity || 1) + '</span><select multiple size="' + Math.min(3, Math.max(2, members.length)) + '" data-item-code="' + attr(item.productCode || item.code || item.product_code || '') + '" aria-label="选择 ' + attr(item.name) + ' 的付款成员">' + options + '</select></label>';
    }).join('') + '<p class="soft-placeholder">未选择成员的菜品会作为公共菜，由所有人均摊。</p>';
  }
  function openSplitPanel() {
    var selected = selectedPlanObjects();
    if (!selected.length) { showToast('先勾选一个或多个方案'); return; }
    $('splitPanel').hidden = false;
    $('splitPlan').innerHTML = selected.map(function (plan) { return '<option value="' + attr(plan.planId) + '">' + esc(plan.title || '个性套餐') + ' · ' + money(plan.totalPrice) + '</option>'; }).join('');
    $('splitMembers').value = selected[0].people || $('people').value || 2;
    $('splitStatus').textContent = '离线时是预演分账；在线时按服务返回的金额分摊。';
    $('assignResult').hidden = true;
    $('assignResult').innerHTML = '';
    renderSplitMembers();
    $('splitPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('splitMode').focus();
  }
  function renderSplitResult(bill) {
    var shares = bill.shares || bill.members || bill.allocations || [];
    var balanced = bill.balanced === true;
    $('splitResult').innerHTML = shares.map(function (share, index) {
      var name = share.name || (share.member && share.member.name) || ('成员' + (index + 1));
      var amount = share.amount != null ? share.amount : (share.total != null ? share.total : share.payPrice);
      var items = share.items || share.itemNames || [];
      return '<div class="split-result-card"><strong>' + money(amount) + '</strong><span>' + esc(name) + (items.length ? ' · ' + esc(items.map(function (item) { return typeof item === 'string' ? item : item.name; }).join('、')) : '') + '</span></div>';
    }).join('') + '<p class="split-result-note">' + (bill.simulated ? '⚠ ' : '✓ ') + esc(bill.note || (bill.simulated ? '预演分账，在线后校准' : '按实付分摊')) + (balanced ? ' · 金额已平衡' : '') + (bill.total != null ? ' · 总额 ' + money(bill.total) : '') + '</p>';
    $('splitResult').hidden = false;
    $('splitStatus').textContent = balanced ? '分账完成：各份合计与总额一致。' : '分账已返回；请核对各成员金额。';
  }
  async function runSplit() {
    var plan = splitSelectedPlan();
    if (!plan) { showToast('请选择需要分账的方案'); return; }
    if (!S || typeof S.splitBill !== 'function') { $('splitStatus').textContent = '当前服务版本尚未提供 splitBill；请同步 WorkBuddy 的最新 service.js。'; return; }
    var members = Array.from(document.querySelectorAll('[data-member-name]')).map(function (input, index) {
      var member = { name: input.value.trim() || ('成员' + (index + 1)) };
      var weight = document.querySelector('[data-member-weight="' + index + '"]');
      if (weight) member.weight = Number(weight.value) || 1;
      return member;
    });
    var mode = $('splitMode').value;
    var options = { mode: mode, members: members };
    if (mode === 'byItem') options.items = Array.from(document.querySelectorAll('[data-item-code]')).map(function (select) {
      return { code: select.dataset.itemCode, owners: Array.from(select.selectedOptions).filter(function (option) { return option.value !== ''; }).map(function (option) { return Number(option.value); }).filter(function (value) { return isFinite(value); }) };
    });
    $('runSplit').disabled = true;
    $('splitStatus').textContent = '正在计算分账…';
    try {
      var bill = await S.splitBill(plan.planId, options);
      renderSplitResult(bill || {});
    } catch (error) { $('splitStatus').textContent = error && error.message ? error.message : '分账暂时失败，请重试。'; }
    finally { $('runSplit').disabled = false; }
  }

  /* ---- 多人拆单 · 分人用券（问题一）----
   * 成员名单复用分账面板里的人名；useCoupons 关掉时只做拆单、不配券。 */
  async function runAssignOrders() {
    var plan = splitSelectedPlan();
    if (!plan) { showToast('请选择需要拆单的方案'); return; }
    if (!S || typeof S.assignOrders !== 'function') {
      $('assignResult').hidden = false;
      $('assignResult').innerHTML = '<div class="notice notice-warn">当前服务版本尚未提供 assignOrders；请同步 WorkBuddy 的最新 service.js。</div>';
      return;
    }
    var members = Array.from(document.querySelectorAll('[data-member-name]')).map(function (input, index) {
      return { name: input.value.trim() || ('成员' + (index + 1)) };
    });
    $('runAssign').disabled = true;
    $('assignResult').hidden = false;
    $('assignResult').innerHTML = '<p class="soft-placeholder">正在拆单并估算用券…</p>';
    try {
      var ao = await S.assignOrders(plan.planId, { members: members, useCoupons: $('assignUseCoupons').checked });
      renderAssignResult(ao || {});
    } catch (error) {
      $('assignResult').innerHTML = '<div class="notice notice-warn">' + esc(error && error.message ? error.message : '拆单暂时失败，请重试。') + '</div>';
    } finally { $('runAssign').disabled = false; }
  }
  function renderAssignResult(ao) {
    var t = ao.totals || {};
    var combined = ao.combined || {};
    var cmp = ao.comparison || {};
    var cards = (ao.members || []).map(function (m) {
      var coupon = m.coupon;
      var couponHtml = coupon
        ? '<span class="assign-coupon">用「' + esc(coupon.title) + '」估省 ' + money(coupon.estimatedCut) + '</span>'
        : '<span class="assign-coupon none">这张单没用券</span>';
      var realHtml = m.real && typeof m.real.price === 'number'
        ? '<span class="assign-real">MCP 实算 ' + money(m.real.price) + (m.real.deliveryPrice != null ? '（含配送 ' + money(m.real.deliveryPrice) + '）' : '') + '</span>'
        : '';
      return '<div class="assign-card"><strong>' + money(m.subtotal) + '</strong><span>' + esc(m.name) + '</span>' + couponHtml + '<span class="assign-pay">估付 ' + money(m.payAfterCoupon) + '</span>' + realHtml + '</div>';
    }).join('');
    var combinedLabel = combined.coupon ? '用「' + esc(combined.coupon.title) + '」估省 ' + money(combined.coupon.estimatedCut) : '无可用券';
    var notes = (ao.notes || []).map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('');
    $('assignResult').innerHTML =
      '<div class="assign-summary">' +
        '<div class="assign-stat"><b>' + money(t.splitSubtotal) + '</b><span>拆单小计合计</span></div>' +
        '<div class="assign-stat"><b>' + money(t.estimatedCouponCut) + '</b><span>分人用券估省</span></div>' +
        '<div class="assign-stat"><b>' + money(t.splitPayEstimate) + '</b><span>拆单估付合计</span></div>' +
        '<div class="assign-stat"><b>' + money(combined.payEstimate) + '</b><span>合单估付 · ' + combinedLabel + '</span></div>' +
      '</div>' +
      '<p class="assign-verdict">' + esc(cmp.verdict || '两条路子估算打平') + '</p>' +
      '<div class="assign-cards">' + cards + '</div>' +
      (notes ? '<ul class="assign-notes">' + notes + '</ul>' : '');
  }

  function applyCoupon(index) {
    var coupon = state.coupons[index];
    if (!coupon) return;
    state.activeCoupon = coupon;
    renderCoupons();
    els.couponDialog.close();
    showToast('优惠券已带入清单提示；金额以官方结算为准');
  }
  function couponSummaryNote() {
    if (!state.activeCoupon) return '';
    return '\n\n优惠券提示：' + state.activeCoupon.title + '。方案金额未扣除此券；请在麦当劳官方小程序 / APP 核实可用范围并领取使用。';
  }
  function useShowcaseInQuery() {
    var item = state.showcase[state.slide];
    if (!item) return;
    var phrase = '想把「' + item.name + '」作为这顿的一部分';
    var current = els.request.value.trim();
    els.request.value = current ? current + '，' + phrase : phrase;
    els.charCount.textContent = els.request.value.length + ' / 500';
    els.request.focus();
    showToast('已加入配餐描述，告诉我人数和预算吧');
  }
  function initRotation() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var hero = $('heroShowcase');
    var paused = false;
    hero.addEventListener('mouseenter', function () { paused = true; });
    hero.addEventListener('mouseleave', function () { paused = false; });
    hero.addEventListener('focusin', function () { paused = true; });
    hero.addEventListener('focusout', function (event) { if (!hero.contains(event.relatedTarget)) paused = false; });
    state.rotationTimer = window.setInterval(function () {
      if (!paused && document.visibilityState === 'visible' && state.showcase.length > 1) { state.slide += 1; renderShowcase(); }
    }, 6500);
    state.campaignTimer = window.setInterval(function () {
      if (document.visibilityState === 'visible' && state.campaigns.length > 1 && !document.querySelector('.campaign-strip:hover')) {
        state.campaignSlide += 1; updateCampaignPosition();
      }
    }, 7200);
  }

  async function readServiceSnapshot() {
    var loaded = await Promise.all([S.getMeta(), state.adapter ? S.getShowcase(state.activeSlot || undefined, 12) : S.getShowcase(12), S.getCampaigns(), S.getAvoidOptions(), S.getGoalOptions()]);
    state.meta = loaded[0];
    var modeValue = typeof S.mode === 'function' ? S.mode() : S.mode;
    state.mode = modeValue || (S.isSimulated && S.isSimulated() ? 'offline' : 'online');
    state.requestId = state.meta && state.meta.requestId || '';
    state.showcase = loaded[1] || [];
    var bundle = loaded[2] || {};
    state.coupons = bundle.coupons || [];
    state.campaigns = (bundle.today && bundle.today.length ? bundle.today : bundle.upcoming) || [];
    renderMeta(); renderShowcase(); renderCampaigns(); renderCoupons();
    renderAvoidOptions(loaded[3] || [], state.lastQuery ? state.lastQuery.avoid : []);
    renderGoalOptions(loaded[4] || []);
    $('campaignSource').textContent = bundle.campaignCalendarLinked ? '官方活动日历 · 麦当劳 MCP' : '官方菜单标签 · 麦当劳 MCP';
  }

  async function switchSlot(key) {
    key = key || '';
    if (key === state.activeSlot) return;
    var slot = state.slots.filter(function (item) { return (item.key || '') === key; })[0];
    if (!slot || !slot.available) { renderSlotSelector(); return; }
    var label = slotDisplayLabel(slot);
    var revision = ++state.slotRevision;
    var hadQuery = !!state.lastQuery;
    state.activeSlot = key;
    state.selected.clear();
    state.plans = [];
    state.activeCoupon = null;
    $('splitPanel').hidden = true;
    $('splitResult').hidden = true;
    $('assignResult').hidden = true;
    $('assignResult').innerHTML = '';
    els.planGrid.innerHTML = '';
    els.notices.innerHTML = '';
    els.selectionBar.hidden = true;
    els.summaryOutput.hidden = true;
    els.results.hidden = !hadQuery;
    if (hadQuery) els.notices.innerHTML = '<div class="notice">正在切换到' + esc(label) + '菜单，并按你刚才的需求重新搭配…</div>';
    els.error.hidden = true;
    renderSlotSelector();
    els.slotSelector.disabled = true;
    if (hadQuery) setBusy(true);
    try {
      S = McAdvisor.createService(Object.assign(state.adapter ? { adapter: state.adapter } : {}, key ? { slot: key } : {}));
      await readServiceSnapshot();
      if (revision !== state.slotRevision) return;
      if (hadQuery) {
        await runRecommendation(state.lastQuery, {
          announce: '已切换到' + label + '时段，我按当前菜单和你刚才的条件重新搭好了。旧方案的选择已清除。',
          scroll: false
        });
        showToast('已切换到' + label + '，方案已按当前条件重新搭配');
      } else {
        setBusy(false);
        showToast('已切换到' + label + '菜单');
      }
    } catch (error) {
      if (revision !== state.slotRevision) return;
      els.error.textContent = '切换菜单时段失败：' + (error && error.message ? error.message : '请重试');
      els.error.hidden = false;
      setBusy(false);
    } finally {
      if (revision === state.slotRevision) els.slotSelector.disabled = state.slots.length < 2;
    }
  }

  function bindEvents() {
    els.form.addEventListener('submit', submitRequest);
    els.request.addEventListener('input', function () { els.charCount.textContent = els.request.value.length + ' / 500'; });
    document.querySelectorAll('[data-step]').forEach(function (button) {
      button.addEventListener('click', function () {
        var input = $(button.dataset.target); input.value = Math.max(Number(input.min) || 1, Math.min(Number(input.max) || 12, (Number(input.value) || 1) + Number(button.dataset.step)));
        input.dataset.touched = 'true'; input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
    [els.people, els.budgetMin, els.budgetMax, els.unlimited].forEach(function (input) {
      input.addEventListener('input', function () { input.dataset.touched = 'true'; });
      input.addEventListener('change', function () { input.dataset.touched = 'true'; });
    });
    els.goal.addEventListener('input', function () { els.goal.dataset.touched = 'true'; });
    els.unlimited.addEventListener('change', function () {
      if (els.unlimited.checked) { els.budgetMin.value = ''; els.budgetMax.value = ''; }
    });
    els.slotSelector.addEventListener('change', function () { switchSlot(els.slotSelector.value); });
    document.querySelectorAll('.suggestion-chip').forEach(function (button) {
      button.addEventListener('click', function () { els.request.value = button.dataset.prompt || ''; els.charCount.textContent = els.request.value.length + ' / 500'; els.request.focus(); });
    });
    els.goals.addEventListener('click', function (event) {
      var button = event.target.closest('[data-goal]');
      if (button) { els.goal.value = button.dataset.goal; els.goal.dataset.touched = 'true'; els.goal.focus(); }
    });
    els.dots.addEventListener('click', function (event) {
      var button = event.target.closest('[data-slide]');
      if (button) { state.slide = Number(button.dataset.slide); renderShowcase(); }
    });
    $('previousSlide').addEventListener('click', function () { state.slide -= 1; renderShowcase(); });
    $('nextSlide').addEventListener('click', function () { state.slide += 1; renderShowcase(); });
    els.heroAction.addEventListener('click', useShowcaseInQuery);
    $('campaignPrev').addEventListener('click', function () { state.campaignSlide -= 1; updateCampaignPosition(); });
    $('campaignNext').addEventListener('click', function () { state.campaignSlide += 1; updateCampaignPosition(); });
    els.campaignTrack.addEventListener('click', function (event) {
      var button = event.target.closest('[data-campaign-request]');
      if (!button) return;
      var campaign = state.campaigns[Number(button.dataset.campaignRequest)];
      if (!campaign) return;
      var phrase = '想了解「' + campaign.title + '」相关的菜单搭配';
      var current = els.request.value.trim();
      els.request.value = current ? current + '，' + phrase : phrase;
      els.charCount.textContent = els.request.value.length + ' / 500';
      els.request.focus();
      showToast('已把官方活动加入配餐描述');
    });
    $('couponOpen').addEventListener('click', function () { els.couponDialog.showModal(); $('couponClose').focus(); });
    $('couponClose').addEventListener('click', function () { els.couponDialog.close(); $('couponOpen').focus(); });
    $('couponDone').addEventListener('click', function () { els.couponDialog.close(); $('couponOpen').focus(); });
    els.couponDialog.addEventListener('click', function (event) { if (event.target === els.couponDialog) els.couponDialog.close(); });
    els.couponList.addEventListener('click', function (event) {
      var button = event.target.closest('[data-coupon-index]');
      if (button) applyCoupon(Number(button.dataset.couponIndex));
    });
    els.planGrid.addEventListener('click', function (event) {
      var card = event.target.closest('.plan-card');
      if (!card) return;
      var detail = event.target.closest('[data-detail]');
      if (detail) { toggleDetail(card, detail.dataset.detail, detail); return; }
      var select = event.target.closest('.select-plan');
      if (select) {
        var planId = card.dataset.planId;
        if (state.selected.has(planId)) { state.selected.delete(planId); card.classList.remove('is-selected'); select.setAttribute('aria-pressed', 'false'); select.textContent = '选这份'; }
        else { state.selected.add(planId); card.classList.add('is-selected'); select.setAttribute('aria-pressed', 'true'); select.textContent = '已选中 ✓'; }
        updateSelectionBar();
      }
    });
    $('calculateSelected').addEventListener('click', function () { selectedAction('calculate'); });
    $('summarySelected').addEventListener('click', function () { selectedAction('summary'); });
    $('splitSelected').addEventListener('click', openSplitPanel);
    $('closeSplit').addEventListener('click', function () { $('splitPanel').hidden = true; });
    $('splitMembers').addEventListener('input', renderSplitMembers);
    $('splitMode').addEventListener('change', renderSplitMembers);
    $('splitPlan').addEventListener('change', renderSplitItems);
    $('splitMembersList').addEventListener('input', function (event) { if (event.target.matches('[data-member-name]') && $('splitMode').value === 'byItem') renderSplitItems(); });
    $('runSplit').addEventListener('click', runSplit);
    $('runAssign').addEventListener('click', runAssignOrders);
    // 目标兜底建议：点一个就填进目标框并按新目标重配
    els.notices.addEventListener('click', function (event) {
      var button = event.target.closest('[data-goal-suggest]');
      if (!button) return;
      els.goal.value = button.dataset.goalSuggest || '';
      els.goal.dataset.touched = 'true';
      showToast('已把目标换成「' + (button.dataset.goalSuggest || '') + '」，正在重新搭配');
      runRecommendation(mergeQuery(), { scroll: false });
    });
    $('projectorToggle').addEventListener('click', function () {
      var enabled = document.body.classList.toggle('projector-mode');
      $('projectorToggle').setAttribute('aria-pressed', enabled ? 'true' : 'false');
      $('projectorToggle').textContent = enabled ? '退出投屏' : '投屏大字';
    });
    $('closeSummary').addEventListener('click', function () { els.summaryOutput.hidden = true; });
    $('copySummary').addEventListener('click', async function () {
      try { await navigator.clipboard.writeText(els.summaryText.textContent); showToast('清单已复制'); }
      catch (error) {
        var range = document.createRange(); range.selectNodeContents(els.summaryText); var selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        showToast('请按 Ctrl+C 复制已选中的清单');
      }
    });
  }

  async function boot() {
    bindEvents();
    try {
      state.slots = McAdvisor.listSlots().filter(function (slot) { return slot.available; });
      state.activeSlot = state.slots.length ? (state.slots[0].key || '') : '';
      renderSlotSelector();
      var adapterOptions = {};
      if (window.McAdvisorData) {
        if (window.location.protocol === 'file:' && typeof McAdvisorData.OfflineAdapter === 'function') {
          state.adapter = new McAdvisorData.OfflineAdapter(state.activeSlot ? { slot: state.activeSlot } : {});
          state.degraded = true;
          state.degradeReason = '双击打开使用离线快照，不会发起网络请求。';
        } else if (typeof McAdvisorData.detectAdapter === 'function') {
          var detected = await McAdvisorData.detectAdapter();
          state.adapter = detected.adapter || null;
          state.degraded = !!detected.degraded;
          state.degradeReason = detected.reason || '';
        }
      } else {
        state.degraded = true;
        state.degradeReason = '数据适配器文件未随当前工作区提供。';
      }
      if (state.adapter) adapterOptions.adapter = state.adapter;
      if (state.activeSlot) adapterOptions.slot = state.activeSlot;
      S = McAdvisor.createService(adapterOptions);
      await readServiceSnapshot();
      initRotation();
    } catch (error) {
      els.metaLine.innerHTML = '<span class="meta-dot meta-dot-error"></span><span>本地菜单快照未能载入</span>';
      els.error.textContent = '菜单服务未能初始化，请确认当前目录中的 data/menu_data.js、data/menu_data_night.js、data/campaigns.js、engine.js 与 service.js 完整。' + (error && error.message ? ' (' + error.message + ')' : '');
      els.error.hidden = false;
    }
  }
  boot();
})();
