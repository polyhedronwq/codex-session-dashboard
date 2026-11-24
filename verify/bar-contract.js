// P7：底栏内容契约——文本/单位/大数缩写、分隔符、三个弹窗内容、最近变更、
// 空值、主题跟随、用量 chip 与单轮明细。
//
// 和 bar-states.js 一样跑在真实 Codex 页面上：先停掉注入器（否则它每秒用真实数据
// 覆盖断言用的假快照），再用 window.__dshBarRender 推假数据，最后恢复注入器。
// 数据形状照 src/bar/bar_metrics.py 的 build()（底栏真正收到的 trimmed payload）。
//
//   node verify/bar-contract.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  ({ chromium } = require('C:/Users/admin/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright'));
}

const barDir = path.join(os.homedir(), '.codex-bar');
const endpoints = ['http://127.0.0.1:9223', 'http://localhost:9223', 'http://[::1]:9223'];
const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stopInjector() {
  // 守护进程会在 2 秒内重启注入器；先写暂停标记，确保断言期间它保持停止。
  try { fs.writeFileSync(path.join(barDir, '.supervisor-pause'), ''); } catch (_) { /* 写不了也继续 */ }
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'supervisor\\.js|injector\\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { stdio: 'ignore' });
  } catch (_) { /* 停不掉就算了 */ }
}
function startInjector() {
  try { fs.rmSync(path.join(barDir, '.supervisor-pause'), { force: true }); } catch (_) { /* 忽略 */ }
  try {
    execFileSync('wscript', ['//nologo', path.join(barDir, 'injector-only.vbs')], { stdio: 'ignore' });
  } catch (_) { /* 起不来后面会失败 */ }
}
let injectorRestored = false;
function restoreInjector() {
  if (injectorRestored) return;
  injectorRestored = true;
  startInjector();
}
process.on('exit', restoreInjector);
process.on('SIGINT', () => { restoreInjector(); process.exit(1); });

// ---------------------------------------------------------------- 假 payload
// 形状 = bar_metrics.py 的 build()：summary 只含底栏需要的那几项，turns 是 trim_turn。
function buildPayload() {
  const turn = (i, over) => Object.assign({
    id: 'p7-turn-' + i,
    index: i,
    running: false,
    steps: i,
    tokens: {
      input_tokens: 1000 * i,
      output_tokens: 100 * i,
      cached_input_tokens: 900 * i,
      reasoning_output_tokens: 10,
      total_tokens: 12345,
    },
    cache_hit_pct: 80,
    speed: 10,
    duration_ms: 2000,
    ttft_ms: 100,
    tool_ms: 300,
    model_ms: 1500,
    item_count: 2,
  }, over || {});
  const turns = [1, 2, 3, 4, 5].map((i) => turn(i));
  const last = turn(6, {
    steps: 2,
    speed: 42,
    duration_ms: 5000,
    item_count: 3,
    tokens: { input_tokens: 3000, output_tokens: 300, cached_input_tokens: 2400, reasoning_output_tokens: 20, total_tokens: 12345 },
  });
  turns.push(last);
  return {
    ok: true,
    thread: { id: 'p7-thread', title: '底栏契约', model: 'gpt-5-codex', updated_at: 1763900000, path: 'C:\\rollout.jsonl' },
    summary: {
      turns: 6,
      steps: 439,
      running: false,
      cache_hit_pct: 80,
      total: {
        input_tokens: 1234567890,
        cached_input_tokens: 987654321,
        output_tokens: 45000,
        reasoning_output_tokens: 8000,
        total_tokens: 1234567890,
      },
      context: { used: 120000, window: 258400, pct: 46.4 },
      quota: { api: { weekly_percent: 12.34, five_hour_percent: null, data_status: 'partial', data_as_of: '2026-11-23T01:00:00Z' } },
      compactions: 2,
      subagents: { edges: 3, children: 2, tokens: 300000, share_pct: 12.5 },
      changes: [{
        ts: Date.now() - 300000,
        after_turns: 1,
        before: { model: 'gpt-5', effort: 'low' },
        after: { model: 'gpt-6', effort: 'high' },
        changes: [
          { field: 'model', from: 'gpt-5', to: 'gpt-6' },
          { field: 'effort', from: 'low', to: 'high' },
          { field: 'approval_policy', from: 'on-request', to: 'never' },
        ],
      }],
      last_turn: last,
      last_completed: last,
    },
    turns,
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

(async () => {
  let browser = null;
  let page = null;
  for (const endpoint of endpoints) {
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 4000 });
      const pages = browser.contexts().flatMap((c) => c.pages());
      page = pages.find((p) => p.url().startsWith('app://-/index.html')
        && !p.url().includes('avatar-overlay'));
      if (page) break;
      await browser.close();
      browser = null;
    } catch (_) { /* 换下一个地址 */ }
  }
  if (!page) {
    console.log('  连不上调试端口或没有 Codex 页面（9223）');
    process.exit(1);
  }

  // 页面里必须有已注入的底栏；没有就说明注入器没跑，直接判失败
  const hasBar = await page.evaluate(() => !!window.__dshBar && !!document.getElementById('dsh-bar-root'));
  if (!hasBar) {
    console.log('  页面里没有底栏（注入器没跑？）');
    await browser.close().catch(() => {});
    process.exit(1);
  }

  const origTheme = await page.evaluate(() => document.documentElement.dataset.theme || '');
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message.split('\n')[0]));
  const origThread = await page.evaluate(() => { try { return localStorage.getItem('dsh.currentThread'); } catch (_) { return null; } });
  // 暂停注入器：它每秒推真实数据，会把断言用的假快照覆盖掉
  stopInjector();
  await sleep(800);

  const render = (payload) => page.evaluate((p) => {
    window.__dshBarSig = null;
    window.__dshBarRender(p);
  }, payload);
  // 切到「会话仪表盘」标签页时输入框不参与布局，底栏会被 place() 隐藏（rect 全 0）。
  // 布局类断言前必须确认底栏真的有尺寸：必要时关掉仪表盘标签页，再强制重新定位。
  const ensureBarLayout = async () => {
    for (let i = 0; i < 12; i += 1) {
      const state = await page.evaluate(() => {
        const root = document.getElementById('dsh-bar-root');
        const rect = root.getBoundingClientRect();
        return { w: rect.width, h: rect.height, display: root.style.display };
      });
      if (state.w > 0 && state.h > 0) return true;
      await page.evaluate(() => {
        const close = document.querySelector('button[aria-label="关闭会话仪表盘标签页"]');
        if (close) close.click();
        if (window.__dshBar && window.__dshBar.place) window.__dshBar.place();
      });
      await sleep(500);
    }
    return false;
  };
  const barText = (id) => page.evaluate((i) => (document.getElementById(i) || {}).textContent || '', id);
  const openPop = (name) => page.evaluate((n) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const btn = document.querySelector(`#dsh-bar-root .dsh-item[data-pop="${n}"]`);
    if (btn) btn.click();
  }, name);
  const closeAll = () => page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  const popInfo = (name) => page.evaluate((n) => {
    const pop = document.getElementById('dsh-pop-' + n);
    if (!pop) return null;
    const kv = [...pop.querySelectorAll('.dsh-kv dt')].map((dt) => [dt.textContent.trim(), (dt.nextElementSibling || {}).textContent?.trim() || '']);
    const big = {
      nums: [...pop.querySelectorAll('.dsh-big .n')].map((el) => el.textContent.trim()),
      units: [...pop.querySelectorAll('.dsh-big .u')].map((el) => el.textContent.trim()),
    };
    return {
      shown: pop.classList.contains('show'),
      text: pop.innerText.replace(/\r/g, ''),
      title: (pop.querySelector('.dsh-pop-title') || {}).textContent || '',
      tag: (pop.querySelector('.dsh-tag') || {}).textContent || '',
      big,
      kv,
      note: (pop.querySelector('.dsh-note') || {}).textContent || '',
      fill: ((pop.querySelector('.dsh-fill') || {}).style || {}).width,
      theme: pop.dataset.theme,
      list: [...pop.querySelectorAll('.dsh-list li')].map((li) => li.innerText.replace(/\s+/g, ' ').trim()),
      changes: [...pop.querySelectorAll('.dsh-change-row')].map((row) => row.innerText.replace(/\s+/g, ' ').trim()),
    };
  }, name);

  try {
    const base = buildPayload();
    await ensureBarLayout();
    await render(base);
    await sleep(150);

    // ---------- 1. 轮次文本与单位 ----------
    const turnsInfo = await page.evaluate(() => ({
      text: document.getElementById('dsh-turns').textContent.trim(),
      bolds: [...document.querySelectorAll('#dsh-turns b')].map((b) => b.textContent.trim()),
    }));
    record('底栏/轮次文本与单位',
      turnsInfo.text === '6 轮 439 步 · 最近 42 tok/s'
      && JSON.stringify(turnsInfo.bolds) === JSON.stringify(['6', '439', '42']),
      JSON.stringify(turnsInfo));

    // ---------- 2. token 文本与大数缩写（十亿 → B） ----------
    const tokensText = await barText('dsh-tokens');
    record('底栏/token 文本与大数缩写',
      tokensText === '1.2B tok · 缓存命中 80.0%', tokensText);

    // ---------- 3. 两个分隔符可见（1×10 的小竖线） ----------
    const seps = await page.evaluate(() => {
      const root = document.getElementById('dsh-bar-root');
      const bar = root.getBoundingClientRect();
      return {
        bar: { w: Math.round(bar.width), h: Math.round(bar.height), display: root.style.display },
        list: [...root.querySelectorAll('.dsh-sep')].map((s) => {
          const r = s.getBoundingClientRect();
          const style = getComputedStyle(s);
          return {
            parent: s.parentElement ? s.parentElement.className : '',
            w: Math.round(r.width * 10) / 10,
            h: Math.round(r.height * 10) / 10,
            cssW: style.width,
            cssH: style.height,
            display: style.display,
            bg: style.backgroundColor,
          };
        }),
      };
    });
    record('底栏/左右分隔符可见',
      seps.list.length === 2
      && seps.list.every((s) => s.w >= 1 && s.h >= 5 && !/rgba\(0, 0, 0, 0\)/.test(s.bg))
      && seps.list[0].parent.includes('dsh-left') && seps.list[1].parent.includes('dsh-right'),
      JSON.stringify(seps));

    // ---------- 4. 轮次弹窗：标题、大数、kv、最近 5 轮明细、说明 ----------
    await openPop('turns');
    const turnsPop = await popInfo('turns');
    const lastRowText = turnsPop.list[0] || '';
    record('底栏/轮次弹窗内容对账',
      turnsPop.shown && turnsPop.title === '轮次与步数' && turnsPop.tag === '本线程'
      && turnsPop.big.nums.join('/') === '6/439' && turnsPop.big.units.join('/') === '轮/步'
      && turnsPop.kv.some(([k, v]) => k === '最近一轮' && v === '2 步 · 5s · 42 tok/s')
      && turnsPop.kv.some(([k, v]) => k === '工具项' && v === '3 项')
      && turnsPop.kv.some(([k, v]) => k === '模型 / 工具用时' && v === '1.5s / 300ms')
      && turnsPop.kv.some(([k, v]) => k === '首 token' && v === '100ms')
      && turnsPop.kv.some(([k, v]) => k === '自动压缩' && v === '2 次')
      && turnsPop.list.length === 5 && lastRowText.includes('第 6 轮')
      && turnsPop.list[4].includes('第 2 轮')
      && turnsPop.note.includes('轮 = 用户发起的回合；步 = 模型调用次数'),
      JSON.stringify({ title: turnsPop.title, big: turnsPop.big, kv: turnsPop.kv, rows: turnsPop.list.length, first: lastRowText }));

    // ---------- 5. 子代理行：有子代理才出现 ----------
    const withSub = turnsPop.kv.filter(([k]) => k === '子代理').map(([, v]) => v)[0] || '';
    const noSub = clone(base);
    noSub.summary.subagents = { edges: 0, children: 0, tokens: 0, share_pct: null };
    await render(noSub);
    await openPop('turns');
    const noSubPop = await popInfo('turns');
    record('底栏/轮次弹窗子代理行按数据出现',
      withSub === '2 个 · 300K tok（占总消耗 12.5%）'
      && !noSubPop.kv.some(([k]) => k === '子代理')
      && noSubPop.shown,
      `有=${withSub} 无=${JSON.stringify(noSubPop.kv.map(([k]) => k))}`);

    // ---------- 6. token 弹窗：大数、千位分隔、4 行 kv、缓存条、说明 ----------
    await render(base);
    await openPop('tokens');
    const tokensPop = await popInfo('tokens');
    record('底栏/token 弹窗内容对账',
      tokensPop.shown && tokensPop.title === 'Token 用量' && tokensPop.tag === '本线程累计'
      && tokensPop.big.nums[0] === '1.2B' && tokensPop.big.units[0] === 'tok · 缓存命中 80.0%'
      && tokensPop.kv.some(([k, v]) => k === '累计输入（含缓存）' && v === '1,234,567,890')
      && tokensPop.kv.some(([k, v]) => k === '其中缓存命中' && v === '987,654,321')
      && tokensPop.kv.some(([k, v]) => k === '累计输出' && v === '45,000')
      && tokensPop.kv.some(([k, v]) => k === '最近一轮' && v === '入 3,000 · 出 300')
      && tokensPop.fill === '80%'
      && tokensPop.note.includes('缓存命中 = 缓存输入 ÷ 输入'),
      JSON.stringify({ big: tokensPop.big, kv: tokensPop.kv, fill: tokensPop.fill }));

    // ---------- 7. 额度弹窗：数值、本地时间、5 小时行隐藏 ----------
    await openPop('quota');
    const quotaPop = await popInfo('quota');
    const quotaText = await barText('dsh-quota');
    const quotaTitle = await page.evaluate(() => {
      const el = document.getElementById('dsh-quota');
      return el ? el.parentElement.title : '';
    });
    const expectHM = (() => {
      const d = new Date('2026-11-23T01:00:00Z');
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    })();
    record('底栏/额度弹窗内容对账',
      quotaText === '12.34%' && quotaTitle.includes('12.34%')
      && quotaPop.shown && quotaPop.title === '额度' && quotaPop.tag === '本会话'
      && quotaPop.big.nums[0] === '12.34%' && quotaPop.big.units[0] === '占每周限额'
      && quotaPop.kv.some(([k, v]) => k === '数据截至' && v === expectHM + '（本地）')
      && !quotaPop.kv.some(([k]) => k === '5 小时窗口')
      && quotaPop.note.includes('取自 ChatGPT 用量接口'),
      JSON.stringify({ bar: quotaText, big: quotaPop.big, kv: quotaPop.kv }));

    // ---------- 8. 额度弹窗无数据形态 ----------
    const noQuota = clone(base);
    noQuota.summary.quota = { api: { weekly_percent: null, five_hour_percent: null, data_status: 'unavailable', data_as_of: null } };
    await render(noQuota);
    const noQuotaBar = await barText('dsh-quota');
    const noQuotaTitle = await page.evaluate(() => {
      const el = document.getElementById('dsh-quota');
      return el ? [el.textContent.trim(), el.parentElement.title] : null;
    });
    await openPop('quota');
    const noQuotaPop = await popInfo('quota');
    record('底栏/额度无数据时只留图标并说明原因',
      noQuotaBar === '' && noQuotaTitle[1].includes('暂无数据')
      && noQuotaPop.big.nums[0] === '—'
      && noQuotaPop.kv.some(([k, v]) => k === '数据截至' && v === '—')
      && noQuotaPop.note.includes('只显示图标')
      && !/NaN|undefined/.test(noQuotaPop.text),
      JSON.stringify({ bar: noQuotaTitle, big: noQuotaPop.big, kv: noQuotaPop.kv }));

    // ---------- 9. 最近变更：完整 model+effort、中文审批值、时间带日期语义 ----------
    await render(base);
    await openPop('turns');
    const changePop = await popInfo('turns');
    const changeText = changePop.changes[0] || '';
    record('底栏/轮次弹窗最近变更内容',
      changePop.changes.length === 1
      && changeText.includes('gpt-5 low → gpt-6 high')
      && changeText.includes('审批 按需批准 → 从不询问')
      && /今天|昨天|\d{2}-\d{2}|\d{4}-\d{2}-\d{2}/.test(changeText),
      changeText.slice(0, 120));

    // ---------- 10. 空值：缺失字段显示 —，不出现 NaN/undefined ----------
    const emptyish = {
      ok: true,
      thread: { id: 'p7-empty', title: '空值', model: '', updated_at: 0 },
      summary: {
        turns: 3, steps: 5, running: false, cache_hit_pct: null, total: {},
        context: {}, quota: { api: {} }, compactions: 0, subagents: null, changes: [],
        last_turn: null, last_completed: null,
      },
      turns: [],
    };
    await render(emptyish);
    const emptyBar = await page.evaluate(() => ({
      turns: document.getElementById('dsh-turns').textContent.trim(),
      tokens: document.getElementById('dsh-tokens').textContent.trim(),
      quota: document.getElementById('dsh-quota').textContent.trim(),
      all: document.getElementById('dsh-bar-root').innerText,
    }));
    await openPop('tokens');
    const emptyTokPop = await popInfo('tokens');
    await openPop('turns');
    const emptyTurnsPop = await popInfo('turns');
    record('底栏/空值显示 — 且不出现 NaN/undefined',
      emptyBar.turns === '3 轮 5 步 · 最近 — tok/s'
      && emptyBar.tokens === '— tok · 缓存命中 —'
      && emptyBar.quota === ''
      && !/NaN|undefined|Infinity/.test(emptyBar.all + emptyTokPop.text + emptyTurnsPop.text)
      && emptyTokPop.big.nums[0] === '—' && emptyTokPop.fill === '0%',
      JSON.stringify({ bar: emptyBar, tokBig: emptyTokPop.big, fill: emptyTokPop.fill }));

    // ---------- 11. 主题跟随 Codex 的 data-theme ----------
    await render(base);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await render(base);
    const darkState = await page.evaluate(() => ({
      bar: document.getElementById('dsh-bar-root').dataset.theme,
      color: getComputedStyle(document.getElementById('dsh-bar-root')).color,
    }));
    await openPop('tokens');
    const darkPopBg = await page.evaluate(() => getComputedStyle(document.getElementById('dsh-pop-tokens')).backgroundColor);
    await closeAll();
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await render(base);
    const lightState = await page.evaluate(() => ({
      bar: document.getElementById('dsh-bar-root').dataset.theme,
      color: getComputedStyle(document.getElementById('dsh-bar-root')).color,
    }));
    await openPop('tokens');
    const lightPopBg = await page.evaluate(() => getComputedStyle(document.getElementById('dsh-pop-tokens')).backgroundColor);
    await closeAll();
    record('底栏/主题跟随 data-theme（浅色/深色）',
      darkState.bar === 'dark' && lightState.bar === 'light'
      && darkState.color !== lightState.color && darkPopBg !== lightPopBg,
      JSON.stringify({ dark: darkState, light: lightState, darkPopBg, lightPopBg }));

    // ---------- 12. 用量 chip：挂在动作行里、文本带「用量 … tok」、点开是单轮明细 ----------
    const chipState = await page.evaluate((payload) => {
      const anchor = document.createElement('div');
      anchor.setAttribute('data-content-search-turn-key', 'p7-turn-6');
      anchor.innerHTML = '<div data-local-conversation-final-assistant="true">' +
        '<div class="actionRow-contract"><button aria-label="复制"></button><span>9:41</span></div></div>';
      document.body.appendChild(anchor);
      window.__dshBarSig = null;
      window.__dshBarRender(payload);
      const chip = anchor.querySelector('.dsh-turn-usage');
      const next = chip ? chip.nextElementSibling : null;
      const result = {
        count: anchor.querySelectorAll('.dsh-turn-usage').length,
        text: chip ? chip.textContent.replace(/\s+/g, ' ').trim() : '',
        inRow: !!(chip && chip.parentElement && chip.parentElement.className.includes('actionRow')),
        beforeTime: !!(next && next.textContent.trim() === '9:41'),
        turn: chip ? chip.dataset.turn : '',
      };
      return result;
    }, base);
    await page.evaluate(() => {
      document.querySelector('.actionRow-contract .dsh-turn-usage').click();
    });
    await sleep(200);
    const usagePop = await page.evaluate(() => {
      const pop = document.getElementById('dsh-usage-pop');
      if (!pop) return null;
      return {
        shown: pop.classList.contains('show') && pop.style.display === 'block',
        head: (pop.querySelector('.h .t') || {}).textContent || '',
        tag: (pop.querySelector('.h .tag') || {}).textContent || '',
        big: (pop.querySelector('.n') || {}).textContent || '',
        dts: [...pop.querySelectorAll('dt')].map((dt) => dt.textContent.trim()),
      };
    });
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const anchor = document.querySelector('[data-content-search-turn-key="p7-turn-6"]');
      if (anchor) anchor.remove();
    });
    record('底栏/用量 chip 挂在动作行并弹出单轮明细',
      chipState.count === 1 && chipState.text === '用量 12.3K tok'
      && chipState.inRow && chipState.beforeTime && chipState.turn === 'p7-turn-6'
      && !!usagePop && usagePop.shown && usagePop.head === '本轮用量'
      && usagePop.tag === '第 6 轮' && usagePop.big === '12.3K tok'
      && usagePop.dts.includes('输入（含缓存）') && usagePop.dts.includes('其中缓存命中')
      && usagePop.dts.includes('输出') && usagePop.dts.includes('推理'),
      JSON.stringify({ chip: chipState, pop: usagePop }));

    record('底栏契约/无脚本错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  } catch (error) {
    record('底栏契约/执行', false, error && error.message ? error.message.split('\n')[0] : String(error));
  } finally {
    // 还原主题与线程提示，避免把调试实例留在测试状态
    try {
      await page.evaluate((theme) => {
        if (theme) document.documentElement.dataset.theme = theme;
      }, origTheme);
      await page.evaluate((thread) => {
        try {
          if (thread) localStorage.setItem('dsh.currentThread', thread);
          else localStorage.removeItem('dsh.currentThread');
        } catch (_) { /* ignore */ }
      }, origThread);
    } catch (_) { /* 页面可能已关闭 */ }
    await browser.close().catch(() => {});
    restoreInjector();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`  底栏契约: ${results.length - failed.length}/${results.length} 通过`);
  for (const r of failed) console.log(`    FAIL ${r.name} — ${r.detail}`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.log('  底栏契约异常:', error && error.message);
  process.exit(1);
});
