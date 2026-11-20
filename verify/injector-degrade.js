// P4：降级链路端到端——锚点消失时底栏必须可见地降级，恢复后自动回到正常。
//
// 做法：在页面里临时隐藏会话消息容器（CSS only，可恢复），
// 观察 health.json 变成 no-anchor、底栏亮起灰点；移除后回到 ok。
//
//   node verify/injector-degrade.js [安装目录]
const fs = require('fs');
const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  ({ chromium } = require('C:/Users/admin/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright'));
}

const installed = process.argv[2] || path.join(process.env.USERPROFILE || process.env.HOME, '.codex-bar');
const healthFile = path.join(installed, 'health.json');
const ENDPOINTS = ['http://localhost:9223', 'http://127.0.0.1:9223', 'http://[::1]:9223'];

const readHealth = () => {
  try { return JSON.parse(fs.readFileSync(healthFile, 'utf8')); } catch (_) { return {}; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await sleep(500);
  }
  return false;
}

(async () => {
  let browser = null;
  let page = null;
  for (const endpoint of ENDPOINTS) {
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 4000 });
      const pages = browser.contexts().flatMap((c) => c.pages());
      for (const candidate of pages.filter((p) => p.url().startsWith('app://-/index.html'))) {
        const hasBar = await candidate.evaluate(() => !!document.getElementById('dsh-bar-root')).catch(() => false);
        if (hasBar) { page = candidate; break; }
      }
      if (page) break;
      await browser.close();
      browser = null;
    } catch (_) { /* 换下一个 */ }
  }
  if (!page) { console.log('  连不上调试端口或没有底栏'); process.exit(1); }

  const barState = () => page.evaluate(() => {
    const dot = document.querySelector('#dsh-bar-root .dsh-health');
    const bar = document.getElementById('dsh-bar-root');
    return {
      dotVisible: !!dot && !dot.classList.contains('hide'),
      dotBad: !!dot && dot.classList.contains('bad'),
      title: dot ? dot.title : '',
      barVisible: !!bar && bar.style.opacity !== '0',
    };
  });

  let ok = true;
  try {
    // 前提：当前必须是正常态
    const startState = readHealth().state;
    if (startState !== 'ok') {
      console.log(`  起始状态是 ${startState}，不是 ok（可能在空会话），跳过`);
      process.exit(0);
    }

    // 隐藏元素不算"锚点缺失"（DOM 里还在），要临时移除属性，
    // 模拟 Codex 改版后锚点真的消失。finally 里一定会恢复。
    await page.evaluate(() => {
      window.__dshSavedAttrs = [...document.querySelectorAll('[data-response-annotation-conversation]')]
        .map((el) => [el, el.getAttribute('data-response-annotation-conversation')]);
      for (const [el] of window.__dshSavedAttrs) el.removeAttribute('data-response-annotation-conversation');
    });

    const degraded = await waitFor(() => readHealth().state === 'no-anchor', 12000);
    const degradedBar = await barState();
    if (!degraded) {
      ok = false;
      console.log(`  FAIL 隐藏会话容器后 health 仍是 ${readHealth().state}`);
    } else if (!(degradedBar.dotVisible && degradedBar.dotBad)) {
      ok = false;
      console.log(`  FAIL 降级后灰点没有显示（dotVisible=${degradedBar.dotVisible} bad=${degradedBar.dotBad}）`);
    } else {
      console.log('  PASS 锚点消失 → health=no-anchor 且底栏亮起灰点');
    }
  } finally {
    const restored = await page.evaluate(() => {
      const saved = window.__dshSavedAttrs || [];
      for (const [el, value] of saved) {
        if (value !== null) el.setAttribute('data-response-annotation-conversation', value);
      }
      return saved.length;
    }).catch(() => 0);
    if (!restored) {
      // 兜底：属性没恢复就重载页面，避免把 Codex 留在缺锚点的状态
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }

  const recovered = await waitFor(() => readHealth().state === 'ok', 15000);
  const recoveredBar = await barState();
  if (!recovered) {
    ok = false;
    console.log(`  FAIL 移除后没有恢复，health=${readHealth().state}`);
  } else if (recoveredBar.dotVisible) {
    ok = false;
    console.log('  FAIL 恢复后灰点仍然显示');
  } else {
    console.log('  PASS 恢复后 health=ok 且灰点隐藏');
  }

  await browser.close().catch(() => {});
  process.exit(ok ? 0 : 1);
})().catch((error) => {
  console.log('  异常 ' + (error && error.message));
  process.exit(1);
});
