// A 档：真实流程验证——像用户一样点「仪表盘」，全程盯 console。
//
// 今天面板空白时，控制台里明写着 CSP 违规；以前没有任何检查在听。
//
// 用法：node verify/panel-live.js <输出目录>
// 产出：panel-live.png + panel-live.json
const path = require('path');
const fs = require('fs');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  ({ chromium } = require('C:/Users/admin/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright'));
}

const ENDPOINTS = ['http://localhost:9223', 'http://127.0.0.1:9223', 'http://[::1]:9223'];
// 实测在"面板正常工作"时也会出现的噪音，不能判失败：
//   - CSP 内联脚本告警：宿主只放行自己那段的 hash，我们的脚本实际仍被 eval 执行
//   - MutationObserver 的 pageerror：Codex 自己的代码在面板窗口上抛的
// 真正判断"面板有没有内容"靠截图（panel-pixels.py），不靠这两条。
const NOISE = [
  'User has not allowed access to system location',
  'files.openai.com',
  'net::ERR_FAILED',
  'Failed to load resource',
  'Content Security Policy',
  "observe' on 'MutationObserver'",
];

// 这些一旦出现就是真问题
const FATAL = [
  '未能显示',
  'Failed to fetch dynamically imported module',
  'ERR_BLOCKED_BY_CLIENT',
];

const outDir = process.argv[2] || path.join(__dirname, 'shots');
fs.mkdirSync(outDir, { recursive: true });
const shotPath = path.join(outDir, 'panel-live.png');
const jsonPath = path.join(outDir, 'panel-live.json');

function writeResult(result) {
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf8');
}

(async () => {
  let browser = null;
  let page = null;
  for (const endpoint of ENDPOINTS) {
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 4000 });
      const pages = browser.contexts().flatMap((c) => c.pages());
      // Codex 还开着 avatar-overlay / detached-window 等页面，它们 URL 前缀相同但没底栏
      page = pages.find((p) => p.url() === 'app://-/index.html');
      if (!page) {
        for (const candidate of pages.filter((p) => p.url().startsWith('app://-/index.html'))) {
          const hasBar = await candidate.evaluate(() => !!document.getElementById('dsh-bar-root')).catch(() => false);
          if (hasBar) { page = candidate; break; }
        }
      }
      if (page) break;
      await browser.close();
      browser = null;
    } catch (_) { /* 换下一个 */ }
  }
  if (!page) {
    writeResult({ ok: false, reason: '连不上 Codex 调试端口' });
    console.log('panel-live: 连不上调试端口');
    process.exit(1);
  }

  const errors = [];
  const noise = [];
  const record = (text) => {
    if (NOISE.some((pattern) => text.includes(pattern))) { noise.push(text.slice(0, 160)); return; }
    errors.push(text.slice(0, 240));
  };
  page.on('console', (message) => {
    if (message.type() === 'error') record(message.text());
  });
  page.on('pageerror', (error) => record('pageerror: ' + String(error && error.message || error)));

  // 关掉可能停在错误态/加载中的旧标签页，从干净状态开始
  await page.evaluate(() => {
    const close = document.querySelector('button[aria-label="关闭会话仪表盘标签页"]');
    if (close) close.click();
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const clicked = await page.evaluate(() => {
    const button = document.querySelector('#dsh-bar-root .dsh-dash');
    if (!button) return false;
    button.click();
    return true;
  });
  if (!clicked) {
    writeResult({ ok: false, reason: '底栏没有仪表盘入口（注入器没跑？）' });
    console.log('panel-live: 找不到仪表盘按钮');
    process.exit(1);
  }

  let errorText = false;
  let sawTab = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const state = await page.evaluate(() => ({
      failed: document.body.innerText.includes('未能显示'),
      tab: [...document.querySelectorAll('[role="tab"]')]
        .some((t) => (t.getAttribute('aria-label') || '').includes('会话仪表盘')),
    }));
    sawTab = sawTab || state.tab;
    if (state.failed) { errorText = true; break; }
    if (i >= 9 && state.tab) break;          // 10 秒无错即可认为渲染成功
  }

  const clip = await page.evaluate(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')]
      .find((t) => (t.getAttribute('aria-label') || '').includes('会话仪表盘'));
    if (!tab) return null;
    const panel = tab.closest('[class*="pane"], [class*="panel"], [data-pane]') || document.body;
    const rect = panel.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 600), 1100);
    const height = Math.min(Math.max(rect.height, 400), 760);
    return { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width, height };
  }).catch(() => null);

  await page.screenshot({ path: shotPath, clip: clip || undefined });

  const result = {
    ok: !errorText && errors.length === 0,
    failedBanner: errorText,
    sawTab,
    consoleErrors: errors.slice(0, 8),
    noise: noise.slice(0, 5),
    screenshot: shotPath,
  };
  writeResult(result);
  console.log('panel-live: ' + JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
})().catch((error) => {
  writeResult({ ok: false, reason: String(error && error.message || error) });
  console.log('panel-live: 异常 ' + (error && error.message));
  process.exit(1);
});
