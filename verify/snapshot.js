// Baseline snapshot: capture the current visual state so a later change can be diffed
// by eye without re-deriving what "before" looked like.
// Usage: node snapshot.js <outDir> <harnessDir>
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('C:/Users/admin/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright');

const [outDir, harnessDir] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: node snapshot.js <outDir> <harnessDir>');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const TABS = [
  ['overview', 'panel-harness.html'],
  ['stats', 'panel-harness-stats.html'],
  ['trace', 'panel-harness-trace.html'],
  ['agents', 'panel-harness-agents.html'],
];

function codexVersion() {
  try {
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-Command', "(Get-AppxPackage -Name OpenAI.Codex).Version"],
      { encoding: 'utf8' });
    return out.trim();
  } catch {
    return 'unknown';
  }
}

(async () => {
  const meta = {
    capturedAt: new Date().toISOString(),
    codexVersion: codexVersion(),
    bar: null,
    tabs: [],
  };

  const browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  });

  // panel tabs
  for (const [name, file] of TABS) {
    const full = path.join(harnessDir, file);
    if (!fs.existsSync(full)) { meta.tabs.push({ name, missing: true }); continue; }
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto('file:///' + full.replace(/\\/g, '/'));
    await page.waitForTimeout(2200);
    const frame = page.frames().find((f) => f.url().includes('panel.html'));
    if (frame) {
      await frame.evaluate(() => { document.body.dataset.theme = 'light'; });
      await page.waitForTimeout(300);
      meta.tabs.push({
        name,
        title: await frame.evaluate(() => (document.querySelector('h1, .title, header') || {}).innerText || ''),
        cards: await frame.evaluate(() =>
          ['c-turns', 'c-speed', 'c-total', 'c-cache', 'c-ctx', 'c-quota']
            .map((id) => {
              const el = document.getElementById(id);
              return { id, value: el ? el.textContent.trim() : null };
            })),
      });
    }
    await page.screenshot({ path: path.join(outDir, `panel-${name}.png`) });
    await page.close();
  }

  // live status bar
  try {
    const live = await chromium.connectOverCDP(process.env.DSH_CDP || 'http://localhost:9223', { timeout: 5000 });
    const page = live.contexts().flatMap((c) => c.pages()).find((p) => p.url() === 'app://-/index.html');
    if (page) {
      const state = await page.evaluate(() => {
        const root = document.getElementById('dsh-bar-root');
        if (!root) return null;
        const q = document.getElementById('dsh-quota');
        const r = root.getBoundingClientRect();
        return {
          build: window.__dshBarBuild,
          items: [...root.querySelectorAll('.dsh-item, .dsh-dash')].map((el) => el.innerText.trim()),
          quotaText: q ? q.textContent.trim() : null,
          quotaTitle: q ? q.parentElement.title : null,
          rect: { x: Math.round(r.x), w: Math.round(r.width) },
        };
      });
      meta.bar = state;
      if (state) {
        const br = await page.evaluate(() => {
          const r = document.getElementById('dsh-bar-root').getBoundingClientRect();
          return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 5), width: r.width + 16, height: r.height + 10 };
        });
        await page.screenshot({ path: path.join(outDir, 'bar.png'), clip: br });
      }
    }
    // 断开 CDP 连接：不关闭 Codex，但如果不断开，node 进程会一直挂着不退
    await live.close().catch(() => {});
  } catch (e) {
    meta.bar = { error: e.message.split('\n')[0] };
  }

  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 1), 'utf8');
  await browser.close();
  console.log(`  快照已保存: ${outDir}`);
  console.log(`  build=${meta.bar && meta.bar.build}  页签=${meta.tabs.filter((t) => !t.missing).length}`);
})().catch((e) => {
  console.error('  快照失败:', e.message.split('\n')[0]);
  process.exit(1);
});
