/* 多时段探针：不同时段是不是真的能配出不一样的一桌饭 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.resolve(__dirname, '..');
const sb = { window: {}, console, Date, Math, JSON, Promise, Error, encodeURIComponent };
sb.globalThis = sb;
vm.createContext(sb);
const load = f => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sb);

load('data/menu_data.js');
load('data/menu_data_night.js');
load('data/campaigns.js');
load('engine.js');
load('service.js');

const M = sb.window.McAdvisor;
(async function () {
  const slots = M.listSlots();
  console.log('='.repeat(78));
  console.log('已落地的时段快照：' + slots.length + ' 份');
  console.log('='.repeat(78));
  slots.forEach(s => console.log(
    `  ${s.label.padEnd(6)} key=${(s.key || '(默认)').padEnd(8)} 全局 ${s.global.padEnd(18)} ` +
    `餐品 ${String(s.dishCount).padStart(3)} 算价通过 ${s.verifiedCount} 营养 ${s.nutritionCount} 抓于 ${s.fetchedAt}`));

  console.log('\n--- 同一句话在不同时段配出来的差别 ---');
  const q = '3个人聚餐预算150以内';
  for (const s of slots) {
    const S = M.createService({ slot: s.key || undefined });
    const met = await S.getMeta();
    const plans = await S.recommendPlans(q);
    console.log(`\n[${s.label}]  「${q}」`);
    console.log('  门店 ' + met.store.name + ' | 时段文本 ' + (met.store.slotText || '').slice(0, 30));
    plans.forEach(p => console.log(
      `   ${p.title.padEnd(12)} ¥${String(p.totalPrice).padStart(6)} 人均¥${String(p.perPersonPrice).padStart(6)} ` +
      `人均${String(p.perPersonCalories).padStart(5)}kcal  ${p.items.length}件`));
  }
})().catch(e => console.log('ERR', e && e.message, e && e.stack ? e.stack.split('\n')[1] : ''));
