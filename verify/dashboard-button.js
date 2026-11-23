// P12：「仪表盘」按钮真正打开/关闭仪表盘标签页（以前是 SKIP：Codex 标签页 DOM 漂移）。
//
// 历史 bug：注入器只走 More 菜单找「会话仪表盘」菜单项，部分构建里定位不到，
// 结果打开了一个新标签页却停在那里（日志：dashboard: no menu item）。
// 现在改为先点新标签页启动页里的「会话仪表盘」入口卡片，再退回菜单。
//
//   node verify/dashboard-button.js
const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  ({ chromium } = require('C:/Users/admin/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright'));
}

const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail: detail || '' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let browser = null;
  let page = null;
  for (const endpoint of ['http://127.0.0.1:9223', 'http://localhost:9223', 'http://[::1]:9223']) {
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 4000 });
      page = browser.contexts().flatMap((c) => c.pages())
        .find((p) => p.url().startsWith('app://-/index.html') && !p.url().includes('avatar-overlay'));
      if (page) break;
      await browser.close();
      browser = null;
    } catch (_) { /* 换下一个地址 */ }
  }
  if (!page) {
    console.log('  连不上调试端口或没有 Codex 页面（9223）');
    process.exit(1);
  }

  const tabState = () => page.evaluate(() => {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const dash = tabs.filter((t) => (t.getAttribute('aria-label') || '') === '会话仪表盘'
      || (t.innerText || '').trim() === '会话仪表盘');
    return {
      dashCount: dash.length,
      dashActive: dash.some((t) => t.getAttribute('aria-selected') === 'true'),
      closeButton: !!document.querySelector('button[aria-label="关闭会话仪表盘标签页"]'),
      newTabButton: !!document.querySelector('button[aria-label="关闭新标签页标签页"]'),
    };
  });
  const barState = () => page.evaluate(() => {
    const bar = document.getElementById('dsh-bar-root');
    if (!bar) return null;
    const rect = bar.getBoundingClientRect();
    return { display: bar.style.display, opacity: bar.style.opacity, width: Math.round(rect.width) };
  });

  try {
    // 起手先清掉可能残留的仪表盘标签页
    for (let i = 0; i < 3; i += 1) {
      const state = await tabState();
      if (!state.dashCount && !state.newTabButton) break;
      await page.evaluate(() => {
        const close = document.querySelector('button[aria-label="关闭会话仪表盘标签页"], button[aria-label="关闭新标签页标签页"]');
        if (close) close.click();
      });
      await sleep(800);
    }

    // ---- 断言 1：点按钮 → 真的打开会话仪表盘标签页并激活 ----
    await page.evaluate(() => { const btn = document.querySelector('#dsh-bar-root .dsh-dash'); if (btn) btn.click(); });
    let opened = false;
    let openState = {};
    for (let i = 0; i < 40; i += 1) {
      await sleep(500);
      openState = await tabState();
      if (openState.dashCount > 0 && openState.dashActive) { opened = true; break; }
    }
    record('底栏/仪表盘按钮真的打开标签页', opened, JSON.stringify(openState));

    // ---- 断言 2：关闭标签页后底栏回到可见状态，且没留下空标签页 ----
    if (opened) {
      await page.evaluate(() => {
        const close = document.querySelector('button[aria-label="关闭会话仪表盘标签页"]');
        if (close) close.click();
      });
      let closed = false;
      let afterClose = {};
      for (let i = 0; i < 20; i += 1) {
        await sleep(400);
        afterClose = await tabState();
        if (afterClose.dashCount === 0) { closed = true; break; }
      }
      let bar = null;
      for (let i = 0; i < 20; i += 1) {
        await sleep(300);
        bar = await barState();
        if (bar && bar.display !== 'none' && bar.width >= 200) break;
      }
      record('底栏/关闭仪表盘标签页后底栏恢复',
        closed && !afterClose.newTabButton && !!bar && bar.display !== 'none' && bar.width >= 200,
        JSON.stringify({ tabs: afterClose, bar }));
    } else {
      record('底栏/关闭仪表盘标签页后底栏恢复', false, '前提失败：标签页没打开');
    }

    // ---- 断言 3：入口找不到时不能"点了没反应"（亮故障点 + 说明，随后自动恢复） ----
    const hint = await page.evaluate(async () => {
      const original = window.__dshOpenDashboard;
      window.__dshOpenDashboard = () => Promise.resolve(false); // 模拟三层兜底全失败
      window.__dshOpenDashboard.__saved = original;
      const dash = document.querySelector('#dsh-bar-root .dsh-dash');
      if (dash) dash.click();
      await new Promise((r) => setTimeout(r, 400));
      const dot = document.getElementById('dsh-health');
      const state = {
        dotVisible: !!dot && !dot.classList.contains('hide'),
        dotBad: !!dot && dot.classList.contains('bad'),
        dotTitle: dot ? dot.title : '',
        dashTitle: dash ? dash.title : '',
      };
      window.__dshOpenDashboard = original;
      return state;
    });
    record('底栏/入口找不到时给出可见提示',
      hint.dotVisible && hint.dotBad && hint.dotTitle.includes('入口未找到') && hint.dashTitle.includes('入口未找到'),
      JSON.stringify(hint));

    // ---- 断言 4：提示会自动消失，不留下永久故障点 ----
    let cleared = null;
    let clearedAt = 0;
    const hintStarted = Date.now();
    for (let i = 0; i < 40; i += 1) {
      await sleep(400);
      cleared = await page.evaluate(() => {
        const dot = document.getElementById('dsh-health');
        const dash = document.querySelector('#dsh-bar-root .dsh-dash');
        return {
          dotHidden: !!dot && dot.classList.contains('hide'),
          dotTitle: dot ? dot.title : '',
          dashTitle: dash ? dash.title : '',
        };
      });
      if (cleared.dotHidden && cleared.dashTitle === '打开会话仪表盘') {
        clearedAt = Date.now();
        break;
      }
    }
    record('底栏/入口提示 8 秒后自动消失',
      !!cleared && cleared.dotHidden && cleared.dashTitle === '打开会话仪表盘'
      && clearedAt > 0 && (clearedAt - hintStarted) < 15000,
      JSON.stringify({ hint: cleared, afterMs: clearedAt ? clearedAt - hintStarted : -1 }));
  } catch (error) {
    record('底栏/仪表盘按钮真的打开标签页', false, '异常 ' + (error && error.message ? error.message.split('\n')[0] : error));
  } finally {
    await browser.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`  仪表盘按钮: ${results.length - failed.length}/${results.length} 通过`);
  for (const r of failed) console.log(`    FAIL ${r.name} — ${r.detail}`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.log('  仪表盘按钮异常:', error && error.message);
  process.exit(1);
});
