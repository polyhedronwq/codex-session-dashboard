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
  // 需要"底栏可见"的断言前先渲染一份有数据的假快照：
  // 用户停在新对话时真实状态是 empty，底栏按设计隐藏，尺寸类断言会测到 0。
  const showBar = () => page.evaluate((fake) => {
    window.__dshBarSig = null;
    window.__dshBarRender(fake);
  }, FAKE_HAS_VALUE);

  // 所有交互断言都从"全部关闭"开始：先按一次 Esc 清掉可能残留的展开状态
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  record('底栏/存在', !!state, state ? `build ${state.build}` : '未注入');
  if (state) {
    record('底栏/三个数据项 + 入口', state.items.length === 4, state.items.join(' | '));
    record('底栏/可见', state.opacity === '1', `opacity=${state.opacity}`);
  }

  // state: value present
  await showBar();
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
  await showBar();
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


  // ---------- P0：交互行为（每条都从"全部关闭"开始，避免状态串扰） ----------

  const closeAll = () => page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  const popState = () => page.evaluate(() => {
    const root = document.getElementById('dsh-bar-root');
    return [...root.querySelectorAll('.dsh-item')].map((b) => {
      const pop = document.getElementById('dsh-pop-' + b.dataset.pop);
      return { name: b.dataset.pop, open: !!pop && pop.classList.contains('show') };
    });
  });
  const clickItem = (index) => page.evaluate((i) => {
    const items = [...document.querySelectorAll('#dsh-bar-root .dsh-item')];
    items[i] && items[i].click();
  }, index);

  await showBar();
  // ① Esc 关闭
  await closeAll();
  await clickItem(0);
  const beforeEsc = (await popState())[0].open;
  await closeAll();
  const afterEsc = await popState();
  record('底栏/Esc 关闭弹窗', beforeEsc && afterEsc.every((x) => !x.open), JSON.stringify({ beforeEsc, afterEsc }));

  // ② 点外部关闭
  await closeAll();
  await clickItem(1);
  const beforeOutside = (await popState())[1].open;
  await page.evaluate(() => {
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  const afterOutside = await popState();
  record('底栏/点外部关闭弹窗',
    beforeOutside && afterOutside.every((x) => !x.open), JSON.stringify({ beforeOutside, afterOutside }));

  // ③ 互斥
  await closeAll();
  await clickItem(0);
  const firstOpen = (await popState())[0].open;
  await clickItem(1);
  const afterSecond = await popState();
  record('底栏/弹窗互斥（开第二个时关掉第一个）',
    firstOpen && afterSecond[1].open && !afterSecond[0].open, JSON.stringify(afterSecond));

  // ④ 弹窗不超出视口
  const overflow = [];
  for (const index of [0, 1, 2]) {
    await closeAll();
    await clickItem(index);
    const box = await page.evaluate((i) => {
      const items = [...document.querySelectorAll('#dsh-bar-root .dsh-item')];
      const pop = document.getElementById('dsh-pop-' + items[i].dataset.pop);
      if (!pop || !pop.classList.contains('show')) return { shown: false };
      const r = pop.getBoundingClientRect();
      return { shown: true, left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top),
               vw: window.innerWidth, vh: window.innerHeight };
    }, index);
    if (!box.shown) { overflow.push({ index, why: '没打开' }); continue; }
    if (box.left < 0 || box.right > box.vw || box.top < 0) overflow.push({ index, ...box });
  }
  await closeAll();
  record('底栏/三个弹窗都不超出视口', overflow.length === 0, JSON.stringify(overflow));

  // ⑤ 用量 chip → 单轮明细（没有真实消息时自己造一个轮次锚点，让注入逻辑真跑一遍）
  const chipResult = await page.evaluate((fake) => {
    let cleanup = null;
    let chips = [...document.querySelectorAll('.dsh-turn-usage')];
    if (!chips.length) {
      const anchor = document.createElement('div');
      anchor.setAttribute('data-content-search-turn-key', 'p0-fake-turn');
      anchor.innerHTML = '<div data-local-conversation-final-assistant="true">' +
        '<div class="actionRow"><button aria-label="复制"></button></div></div>';
      document.body.appendChild(anchor);
      const payload = JSON.parse(JSON.stringify(fake));
      payload.turns = [{
        id: 'p0-fake-turn', index: 1, steps: 1, running: false,
        tokens: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 50, reasoning_output_tokens: 0, total_tokens: 110 },
        cache_hit_pct: 50, duration_ms: 2000, ttft_ms: 200, model_ms: 1200, tool_ms: 300, speed: 10,
      }];
      payload.summary.last_turn = payload.turns[0];
      window.__dshBarSig = null;
      window.__dshBarRender(payload);
      chips = [...document.querySelectorAll('.dsh-turn-usage')];
      cleanup = anchor;
    }
    if (!chips.length) {
      if (cleanup) cleanup.remove();
      return { ok: false, reason: 'chip 注入逻辑没有产出 chip' };
    }
    chips[0].click();
    const pop = document.getElementById('dsh-usage-pop');
    let result;
    if (!pop) {
      result = { ok: false, reason: '没有 #dsh-usage-pop' };
    } else {
      const r = pop.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + 12));
      const shown = pop.style.display === 'block' && r.width > 0;
      result = { ok: shown && !!(hit && pop.contains(hit)),
                 reason: shown ? '' : '明细没有显示', size: Math.round(r.width) + 'x' + Math.round(r.height) };
    }
    if (cleanup) { cleanup.remove(); }
    return result;
  }, FAKE_HAS_VALUE);
  await closeAll();
  record('底栏/用量 chip 能打开单轮明细', chipResult.ok === true, JSON.stringify(chipResult));

  // ⑥ 仪表盘按钮 → 真的打开标签页
  const dashOpen = await (async () => {
    await page.evaluate(() => { const b = document.querySelector('#dsh-bar-root .dsh-dash'); b && b.click(); });
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(800);
      const found = await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')]
        .some((t) => (t.getAttribute('aria-label') || '').includes('会话仪表盘')));
      if (found) {
        await page.evaluate(() => {
          const close = document.querySelector('button[aria-label="关闭会话仪表盘标签页"]');
          if (close) close.click();
        });
        return true;
      }
    }
    return false;
  })();
  record('底栏/仪表盘按钮能打开标签页', dashOpen, dashOpen ? '' : '10 秒内没有出现仪表盘标签页');

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
