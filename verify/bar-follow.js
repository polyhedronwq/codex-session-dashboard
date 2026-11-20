// P0：面板开/关时，底栏必须贴着输入框一起移动（偏差 < 2px）。
//
// 这条对应的真实事故：定位靠 1 秒定时器时，动画期间整段丢帧，
// 实测偏差最大 174px，用户看到的是"卡一下，然后突然跳过去"。
//
//   node verify/bar-follow.js
const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  ({ chromium } = require('C:/Users/admin/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright'));
}

const ENDPOINTS = ['http://localhost:9223', 'http://127.0.0.1:9223', 'http://[::1]:9223'];
const MAX_DEVIATION = 2;      // px

(async () => {
  let page = null;
  let browser = null;
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
  if (!page) {
    console.log('  连不上调试端口或没有底栏');
    process.exit(1);
  }

  // 先确保仪表盘标签页是关的，这样点一次才会产生布局动画
  await page.evaluate(() => {
    const close = document.querySelector('button[aria-label="关闭会话仪表盘标签页"]');
    if (close) close.click();
  });
  await page.waitForTimeout(1200);

  await page.evaluate(() => {
    window.__followSamples = [];
    const editor = [...document.querySelectorAll('.ProseMirror[contenteditable="true"]')]
      .find((el) => el.getBoundingClientRect().width > 200);
    const composer = editor && (editor.closest('[class*="ComposerLayoutRoot"]') || editor.parentElement);
    const bar = document.getElementById('dsh-bar-root');
    const start = performance.now();
    const tick = () => {
      if (composer && bar) {
        const c = composer.getBoundingClientRect();
        const b = bar.getBoundingClientRect();
        window.__followSamples.push({ t: performance.now() - start, cLeft: c.left, bLeft: b.left });
      }
      if (performance.now() - start < 1500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await page.waitForTimeout(120);
  const clicked = await page.evaluate(() => {
    const button = document.querySelector('#dsh-bar-root .dsh-dash');
    if (!button) return false;
    button.click();
    return true;
  });
  if (!clicked) {
    console.log('  找不到仪表盘按钮');
    process.exit(1);
  }

  await page.waitForTimeout(1700);

  const samples = await page.evaluate(() => window.__followSamples || []);
  // 只统计动画真正发生的帧（输入框在移动）
  const moving = [];
  for (let i = 1; i < samples.length; i++) {
    if (Math.abs(samples[i].cLeft - samples[i - 1].cLeft) > 0.2) moving.push(samples[i]);
  }
  const deviations = moving.map((s) => Math.abs(s.bLeft - s.cLeft));
  const maxDeviation = deviations.length ? Math.max(...deviations) : 0;
  const over = deviations.filter((d) => d > MAX_DEVIATION).length;

  // 清理：把打开的面板关掉
  await page.evaluate(() => {
    const close = document.querySelector('button[aria-label="关闭会话仪表盘标签页"]');
    if (close) close.click();
  });
  await browser.close().catch(() => {});

  const distinctPositions = new Set(samples.map((s) => Math.round(s.cLeft))).size;
  // 位置变化太少说明根本没捕捉到动画，这种"通过"没有意义，必须判失败
  const enoughMotion = distinctPositions >= 3;
  const ok = enoughMotion && maxDeviation <= MAX_DEVIATION;
  console.log(`  输入框经过 ${distinctPositions} 个不同位置，最大偏差 ${maxDeviation.toFixed(2)}px，超阈值 ${over} 帧`
    + (enoughMotion ? '' : '（动画帧不足，无法判定）'));
  process.exit(ok ? 0 : 1);
})().catch((error) => {
  console.log('  异常 ' + (error && error.message));
  process.exit(1);
});
