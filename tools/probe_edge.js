/* 边界用例探针：验证契约在各种极端输入下是否仍然成立（不写进交付包时使用） */
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.resolve(__dirname, '..');
const sb = { window: {}, console, Date, Math, JSON, Promise, Error, encodeURIComponent };
sb.globalThis = sb;
vm.createContext(sb);
function load(f) { vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sb); }
const withCampaigns = process.argv.indexOf('--nocampaign') < 0;

load('data/menu_data.js');
if (withCampaigns) load('data/campaigns.js');
load('engine.js');
load('service.js');
const S = sb.window.McAdvisor.createService({});

(async function () {
  const c = await S.getCampaigns();
  const src = {};
  (c.today || c.campaigns || []).slice(0, 3).forEach(function (x) { src[x.source] = 1; });
  console.log('getCampaigns: 今日', (c.today || []).length, '即将', (c.upcoming || []).length,
    '往期', (c.past || []).length, '券', c.coupons.length, '| calendar接入=', c.campaignCalendarLinked);

  const cases = ['1个人20块以内', '10个人无限预算', '2个人减肥不吃辣预算60到80', '随便来点', '3个人想尝新品'];
  for (const t of cases) {
    const q = await S.parseQuery(t);
    const plans = await S.recommendPlans(t);
    console.log('\n[' + t + ']');
    console.log('  parse → people=' + q.people + ' bmin=' + q.budgetMin + ' bmax=' + q.budgetMax +
      ' goal=' + (q.goalKey || JSON.stringify(q.goal)) + ' avoid=' + JSON.stringify(q.avoid) +
      ' unmatched=' + JSON.stringify(q.unmatched || null));
    console.log('  plans=' + plans.length + ' tiers=' + plans.map(function (p) { return p.tier; }).join('/') +
      ' 总价=' + plans.map(function (p) { return p.totalPrice; }).join('/') +
      ' 可用=' + plans.every(function (p) { return p.availability === 'ok'; }));
    console.log('  goalInfo=' + plans.map(function (p) {
      return p.tier + ':' + p.goalInfo.key + '/' + p.goalInfo.label + '(' + p.goalInfo.kcal + 'kcal,custom=' + p.goalInfo.custom + ')';
    }).join(' | '));
    const pb = await S.calculatePlan(plans[0].planId);
    console.log('  breakdown delivery=' + pb.deliveryPrice + ' packing=' + pb.packingPrice +
      ' tableware=' + pb.tablewarePrice + ' pay=' + pb.payPrice + ' method=' + pb.method);
  }
})().catch(function (e) { console.log('ERR', e && e.message); });
