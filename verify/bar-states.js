// Status bar regression: verify the three rendering states against the live page.
// Requires the injector to be running (CDP on 9223).
const { chromium } = require('C:/Users/admin/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright');

const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail: detail || '' });

const FAKE_HAS_VALUE = {
  ok: true,
  thread: { id: 'verify' },
  turns: [{ index: 1, steps: 9, running: false, tokens: { input_tokens: 1000, output_tokens: 20 }, cache_hit_pct: 90.3, speed: 19.3, duration_ms: 5000 }],
  summary: {
    ok: true, turns: 1, steps: 9,
    total: { total_tokens: 427900, input_tokens: 400000, cached_input_tokens: 361200, output_tokens: 27900 },
    cache_hit_pct: 90.3, context: { used: 40000, window: 258400, pct: 15.5 },
    quota: { api: { weekly_percent: 1.7132583663551402, five_hour_percent: null, data_status: 'partial', data_as_of: '2026-11-18T07:08:12Z' } },
    last_turn: null, running: false,
  },
};

const FAKE_NO_VALUE = JSON.parse(JSON.stringify(FAKE_HAS_VALUE));
FAKE_NO_VALUE.summary.quota = { api: { weekly_percent: null, five_hour_percent: null, data_status: 'unavailable', data_as_of: null } };

(async () => {
  let browser;
  try {
    browser = await chromium.connectOverCDP(process.env.DSH_CDP || 'http://localhost:9223', { timeout: 5000 });
  } catch (e) {
    record('底栏/CDP连接', false, '连不上 9223（注入器没跑？）');
    report();
    return;
  }

  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url() === 'app://-/index.html');
  if (!page) {
    record('底栏/页面', false, '找不到 app://-/index.html');
    report();
    return;
  }

  const state = await page.evaluate(() => {
    const root = document.getElementById('dsh-bar-root');
    if (!root) return null;
    const items = [...root.querySelectorAll('.dsh-item, .dsh-dash')].map((el) => el.innerText.trim());
    return { build: window.__dshBarBuild, items, opacity: root.style.opacity };
  });
  record('底栏/存在', !!state, state ? `build ${state.build}` : '未注入');
  if (state) {
    record('底栏/三个数据项 + 入口', state.items.length === 4, state.items.join(' | '));
    record('底栏/可见', state.opacity === '1', `opacity=${state.opacity}`);
  }

  // state: value present
  const withValue = await page.evaluate((fake) => {
    window.__dshBarSig = null;
    window.__dshBarRender(fake);
    const q = document.getElementById('dsh-quota');
    return { text: q.textContent.trim(), title: q.parentElement.title };
  }, FAKE_HAS_VALUE);
  record('底栏/有额度时显示数字', withValue.text === '1.71%', `实际=${withValue.text}`);
  record('底栏/有额度时提示正确', withValue.title.includes('1.71%'), withValue.title);

  // state: no value
  const noValue = await page.evaluate((fake) => {
    window.__dshBarSig = null;
    window.__dshBarRender(fake);
    const q = document.getElementById('dsh-quota');
    return { text: q.textContent.trim(), title: q.parentElement.title };
  }, FAKE_NO_VALUE);
  record('底栏/无额度时只留图标', noValue.text === '', `实际="${noValue.text}"`);
  record('底栏/无额度时提示明确', noValue.title.includes('暂无'), noValue.title);

  // 灰点：正常态隐藏，异常态可见
  const dotOk = await page.evaluate(() => {
    const dot = document.getElementById('dsh-health');
    return { exists: !!dot, hidden: dot ? dot.classList.contains('hide') : null };
  });
  record('底栏/灰点存在', dotOk.exists, JSON.stringify(dotOk));
  record('底栏/正常态灰点隐藏', dotOk.hidden === true, `hidden=${dotOk.hidden}`);

  const dotBad = await page.evaluate(() => {
    const fake = { ok: true, thread: { id: 't' }, health: { state: 'no-anchor', message: '缺少页面锚点: 输入框' },
      turns: [], summary: { ok: true, turns: 1, steps: 2, total: { total_tokens: 100, input_tokens: 80, cached_input_tokens: 40, output_tokens: 20 },
        cache_hit_pct: 50, context: { used: 10, window: 100, pct: 10 }, quota: { api: {} }, last_turn: null, running: false } };
    window.__dshBarSig = null;
    window.__dshBarRender(fake);
    const dot = document.getElementById('dsh-health');
    return { shown: !dot.classList.contains('hide'), title: dot.title };
  });
  record('底栏/异常态灰点可见', dotBad.shown === true, `shown=${dotBad.shown}`);
  record('底栏/异常态提示含原因', /缺少页面锚点/.test(dotBad.title), dotBad.title);

  // 新对话（health.state = empty）应整条隐藏，而不是显示异常点
  const emptyState = await page.evaluate(() => {
    window.__dshBarSig = null;
    window.__dshBarRender({ ok: false, health: { state: 'empty', message: '' } });
    const root = document.getElementById('dsh-bar-root');
    const dot = document.getElementById('dsh-health');
    return { opacity: root.style.opacity, dotHidden: dot.classList.contains('hide') };
  });
  record('底栏/新对话应整条隐藏', emptyState.opacity === '0' && emptyState.dotHidden, JSON.stringify(emptyState));

  // 仪表盘入口：图标 + 文字 + 无障碍名
  const dash = await page.evaluate(() => {
    const el = document.querySelector('#dsh-bar-root .dsh-dash');
    if (!el) return null;
    return { hasSvg: !!el.querySelector('svg'), text: el.innerText.trim(), aria: el.getAttribute('aria-label') };
  });
  record('底栏/仪表盘入口有图标', !!(dash && dash.hasSvg), JSON.stringify(dash));
  record('底栏/仪表盘入口保留文字与无障碍名',
    !!(dash && dash.text === '仪表盘' && /仪表盘/.test(dash.aria || '')), JSON.stringify(dash));

  // 页内「用量」图标与仪表盘入口图标的实际渲染尺寸
  const sizes = await page.evaluate(() => {
    const dim = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    const chips = [...document.querySelectorAll('.dsh-turn-usage')];
    return {
      chips: chips.length,
      chipIcon: chips.length ? dim(chips[0].querySelector('svg')) : null,
      dashIcon: dim(document.querySelector('#dsh-bar-root .dsh-dash svg')),
    };
  });
  record('页内用量图标的实际尺寸',
    !sizes.chipIcon || (sizes.chipIcon.w === 13 && sizes.chipIcon.h === 13),
    JSON.stringify(sizes.chipIcon));
  record('仪表盘入口图标 16px',
    !!sizes.dashIcon && sizes.dashIcon.w === 16 && sizes.dashIcon.h === 16,
    JSON.stringify(sizes.dashIcon));

  report();





  function report() {
    const failed = results.filter((r) => !r.ok);
    console.log(`  底栏检查: ${results.length - failed.length}/${results.length} 通过`);
    for (const f of failed) console.log(`    FAIL ${f.name} — ${f.detail}`);
    process.exit(failed.length ? 1 : 0);
  }
})().catch((e) => {
  console.log('  底栏检查异常:', e.message.split('\n')[0]);
  process.exit(1);
});
