// 现场一致性检查：页面里实际判定出来的会话，必须和注入器写进 health.json 的一致。
//
// 单测保证"逻辑对"，这条保证"部署到本机的那一份逻辑确实在跑"。
//
//   node verify/resolver-live.js <安装目录>
const fs = require('fs');
const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  ({ chromium } = require('C:/Users/admin/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright'));
}

const installed = process.argv[2] || path.join(process.env.USERPROFILE, '.codex-bar');
const endpoints = ['http://localhost:9223', 'http://127.0.0.1:9223', 'http://[::1]:9223'];

(async () => {
  let resolverSrc;
  try {
    resolverSrc = fs.readFileSync(path.join(installed, 'thread-resolver.js'), 'utf8');
  } catch (_) {
    console.log('  缺少 thread-resolver.js（安装不完整？）');
    process.exit(1);
  }

  let health;
  try {
    health = JSON.parse(fs.readFileSync(path.join(installed, 'health.json'), 'utf8'));
  } catch (_) {
    console.log('  读不到 health.json');
    process.exit(1);
  }

  let page = null;
  let browser = null;
  for (const endpoint of endpoints) {
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
    console.log('  找不到注入了底栏的页面');
    process.exit(1);
  }

  const decided = await page.evaluate((src) => {
    const decide = new Function(src + '; return decideThread;')();
    const nodes = [...document.querySelectorAll('[data-response-annotation-conversation]')].map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        id: el.getAttribute('data-response-annotation-conversation') || '',
        visible: rect.width > 0 && rect.height > 0,
      };
    });
    return decide({ nodes, visibilityState: document.visibilityState, lastThread: null });
  }, resolverSrc);
  await browser.close().catch(() => {});

  const healthThread = health.thread || null;
  const healthState = health.state || '';

  // 页面可见 + 判定为空 → health 必须是 empty
  if (decided.reason === 'empty') {
    if (healthState !== 'empty' && healthThread) {
      console.log(`  判定为新对话（empty），但 health 仍是 ${healthState}/${healthThread?.slice(0, 8)}`);
      process.exit(1);
    }
    console.log(`  一致：页面判定 empty，health=${healthState}`);
    return process.exit(0);
  }

  // 判定出具体会话 → health 必须是同一个（后台态由注入器保留 lastThread，允许不同但要求非空）
  if (decided.id && healthThread && decided.id !== healthThread) {
    console.log(`  不一致：页面判定 ${decided.id.slice(0, 8)}，health 记录 ${healthThread.slice(0, 8)}`);
    process.exit(1);
  }
  console.log(`  一致：页面判定 ${(decided.id || '(无)').slice(0, 8)} (${decided.reason})，health=${healthState}`);
  process.exit(0);
})().catch((error) => {
  console.log('  异常 ' + (error && error.message));
  process.exit(1);
});
