// C 档：每次验证都生成一组固定截图，供人工/模型逐张查看。
// 不做基线 diff（UI 还在变，基线会天天失效），只保证"能看到真实效果"。
//
// 用法：node verify/screens.js <输出目录> [harness 目录]
const path = require('path');
const fs = require('fs');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  ({ chromium } = require('C:/Users/admin/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright'));
}

const outDir = process.argv[2] || path.join(__dirname, 'shots');
const harnessDir = process.argv[3] || path.join(__dirname, '..', 'probe');
fs.mkdirSync(outDir, { recursive: true });

const ENDPOINTS = ['http://localhost:9223', 'http://127.0.0.1:9223', 'http://[::1]:9223'];
const results = [];

async function connect() {
  for (const endpoint of ENDPOINTS) {
    try {
      const browser = await chromium.connectOverCDP(endpoint, { timeout: 4000 });
      const pages = browser.contexts().flatMap((c) => c.pages());
      let page = pages.find((p) => p.url() === 'app://-/index.html');
      if (!page) {
        for (const candidate of pages.filter((p) => p.url().startsWith('app://-/index.html'))) {
          const hasBar = await candidate.evaluate(() => !!document.getElementById('dsh-bar-root')).catch(() => false);
          if (hasBar) { page = candidate; break; }
        }
      }
      if (page) return { browser, page };
      await browser.close();
    } catch (_) { /* 换下一个 */ }
  }
  return null;
}

// ---- 1) 真实界面：底栏、消息动作行（含用量 chip） ----
async function liveShots() {
  const live = await connect();
  if (!live) {
    results.push({ name: 'live', ok: false, reason: '连不上调试端口' });
    return;
  }
  const { browser, page } = live;
  try {
    const barBox = await page.evaluate(() => {
      const root = document.getElementById('dsh-bar-root');
      if (!root) return null;
      const rect = root.getBoundingClientRect();
      if (rect.width < 50) return null;
      return { x: Math.max(0, rect.left - 10), y: Math.max(0, rect.top - 8), width: rect.width + 20, height: rect.height + 16 };
    });
    if (barBox) {
      await page.screenshot({ path: path.join(outDir, 'bar-live.png'), clip: barBox });
      results.push({ name: 'bar-live', ok: true });
    } else {
      results.push({ name: 'bar-live', ok: false, reason: '底栏不可见（可能是空会话）' });
    }

    // 把一条消息滚到中间，鼠标悬停让动作行显形，再截「用量 chip」
    const chipBox = await page.evaluate(() => {
      const chips = [...document.querySelectorAll('.dsh-turn-usage')];
      if (!chips.length) return null;
      const chip = chips[chips.length - 1];
      chip.scrollIntoView({ block: 'center' });
      const row = chip.closest('[class*="actionRow"]') || chip.parentElement;
      const rect = row.getBoundingClientRect();
      return { x: Math.max(0, rect.x - 8), y: Math.max(0, rect.y - 8), width: Math.min(rect.width + 16, 900), height: rect.height + 16 };
    });
    if (chipBox) {
      await page.mouse.move(chipBox.x + 60, chipBox.y + chipBox.height / 2);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await page.screenshot({ path: path.join(outDir, 'chip-live.png'), clip: chipBox });
      results.push({ name: 'chip-live', ok: true });
    } else {
      results.push({ name: 'chip-live', ok: false, reason: '没有用量 chip' });
    }
  } finally {
    try { await browser.close(); } catch (_) { /* ignore */ }
  }
}

// ---- 2) 面板四个页签（用 harness，内容可控） ----
async function panelShots() {
  const files = [
    ['overview', 'panel-harness.html'],
    ['stats', 'panel-harness-stats.html'],
    ['trace', 'panel-harness-trace.html'],
    ['agents', 'panel-harness-agents.html'],
  ];
  const available = files.filter(([, file]) => fs.existsSync(path.join(harnessDir, file)));
  if (!available.length) {
    results.push({ name: 'panel-tabs', ok: false, reason: '没有 harness（先跑 build_harness.py）' });
    return;
  }

  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    for (const [name, file] of available) {
      for (const theme of ['light', 'dark']) {
        const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
        await page.goto('file:///' + path.join(harnessDir, file).replace(/\\/g, '/'));
        await page.waitForTimeout(2300);
        const frame = page.frames().find((f) => f.url().includes('panel.html'));
        if (frame) {
          await frame.evaluate((t) => { document.body.dataset.theme = t; }, theme);
          await page.waitForTimeout(250);
        }
        await page.screenshot({ path: path.join(outDir, `panel-${name}-${theme}.png`) });
        await page.close();
      }
      results.push({ name: `panel-${name}`, ok: true });
    }
  } finally {
    await browser.close();
  }
}

(async () => {
  await liveShots();
  await panelShots();
  fs.writeFileSync(path.join(outDir, 'screens.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2), 'utf8');
  const failed = results.filter((r) => !r.ok);
  console.log('screens: ' + results.length + ' 张，失败 ' + failed.length);
  for (const item of failed) console.log('  ✗ ' + item.name + ' — ' + item.reason);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.log('screens: 异常 ' + (error && error.message));
  process.exit(1);
});
