// Panel regression: every tab, both themes, plus a numeric cross-check against the payload.
// Usage: node panel-render.js <harnessDir> <expectedPayload.json> <resultFile>
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/admin/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright');

const [harnessDir, expectedFile, resultFile] = process.argv.slice(2);
const expected = expectedFile && fs.existsSync(expectedFile)
  ? JSON.parse(fs.readFileSync(expectedFile, 'utf8'))
  : null;

const PAGES = [
  ['概览', 'panel-harness.html'],
  ['统计', 'panel-harness-stats.html'],
  ['轨迹', 'panel-harness-trace.html'],
  ['代理', 'panel-harness-agents.html'],
];

const BAD_TOKENS = ['undefined', 'NaN', 'Infinity', '[object'];

const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail: detail || '' });

function scanText(text) {
  const hits = [];
  for (const bad of BAD_TOKENS) {
    if (text.includes(bad)) {
      const line = text.split('\n').find((l) => l.includes(bad)) || '';
      hits.push(`${bad} @ ${line.trim().slice(0, 60)}`);
    }
  }
  return hits;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  });

  for (const [label, file] of PAGES) {
    const full = path.join(harnessDir, file);
    if (!fs.existsSync(full)) {
      record(`面板/${label}`, false, `缺少 harness: ${file}`);
      continue;
    }
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
      await page.goto('file:///' + full.replace(/\\/g, '/'));
      await page.waitForTimeout(2200);
      const frame = page.frames().find((f) => f.url().includes('panel.html'));
      if (!frame) {
        record(`面板/${label}/${theme}`, false, 'panel.html iframe 未加载');
        await page.close();
        continue;
      }
      await frame.evaluate((t) => { document.body.dataset.theme = t; }, theme);
      await frame.evaluate(() => {
        const row = document.querySelector('#stats-body tr.clickable');
        if (row) row.click();
        const trow = document.querySelector('.trow');
        if (trow) trow.click();
      });
      await page.waitForTimeout(600);

      const info = await frame.evaluate(() => ({
        text: document.body.innerText,
        ids: ['c-turns', 'c-total', 'c-cache', 'c-ctx', 'c-quota'].map((id) => {
          const el = document.getElementById(id);
          return { id, value: el ? el.textContent.trim() : null };
        }),
      }));

      if (errors.length) record(`面板/${label}/${theme}/JS错误`, false, errors.slice(0, 2).join(' | '));
      const bad = scanText(info.text);
      if (bad.length) record(`面板/${label}/${theme}/脏值`, false, bad.slice(0, 2).join(' | '));

      const tabProblems = errors.length + bad.length;
      if (tabProblems === 0) record(`面板/${label}/${theme}`, true, 'ok');

      if (label === '概览') {
        for (const item of info.ids) {
          if (item.value === null) {
            record(`面板/概览/${item.id}`, false, '元素不存在');
          } else if (item.value === '' || item.value === '—') {
            // quota is allowed to be empty when the API has no attribution yet
            const allowEmpty = item.id === 'c-quota';
            record(`面板/概览/${item.id}`, allowEmpty, allowEmpty ? '允许为空' : '卡片无值');
          }
        }
      }
      await page.close();
    }
  }

  // numeric cross-check on the overview tab
  if (expected) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto('file:///' + path.join(harnessDir, 'panel-harness.html').replace(/\\/g, '/'));
    await page.waitForTimeout(2500);
    const frame = page.frames().find((f) => f.url().includes('panel.html'));
    const shown = await frame.evaluate(() => {
      const get = (id) => (document.getElementById(id) || {}).textContent || '';
      const rows = [...document.querySelectorAll('#recent tr')].map((tr) =>
        [...tr.children].map((td) => td.textContent.trim()));
      return { turns: get('c-turns'), total: get('c-total'), cache: get('c-cache'), ctx: get('c-ctx'), rows };
    });

    const s = expected.summary;
    const norm = (v) => String(v == null ? '' : v).replace(/[,\s]/g, '');
    const num = (v) => {
      const m = String(v).match(/-?[\d.]+/);
      return m ? parseFloat(m[0]) : null;
    };

    record('对账/轮次步数',
      norm(shown.turns) === norm(`${s.turns}/${s.steps}`),
      `DOM=${shown.turns} 期望=${s.turns}/${s.steps}`);

    const unit = shown.total.replace(/[\d.\s]/g, '');
    const factor = unit.includes('M') ? 1e6 : unit.includes('K') ? 1e3 : 1;
    const got = parseFloat(shown.total.replace(/[^\d.]/g, '')) * factor;
    record('对账/累计token',
      Math.abs(got - s.total.total_tokens) / s.total.total_tokens < 0.02,
      `DOM=${shown.total} 期望=${s.total.total_tokens}`);

    record('对账/缓存命中',
      Math.abs(num(shown.cache) - s.cache_hit_pct) < 0.15,
      `DOM=${shown.cache} 期望=${s.cache_hit_pct}%`);

    if (s.context && s.context.pct != null) {
      record('对账/上下文',
        Math.abs(num(shown.ctx) - s.context.pct) < 0.15,
        `DOM=${shown.ctx} 期望=${s.context.pct}%`);
    }

    const lastTurns = expected.turns.slice(-5).reverse();
    const rows = shown.rows;
    record('对账/最近5轮行数', rows.length > 0 && rows.length <= lastTurns.length,
      `DOM=${rows.length} 期望<=${lastTurns.length}`);
    for (let i = 0; i < Math.min(rows.length, lastTurns.length); i += 1) {
      const want = lastTurns[i];
      record(`对账/第${want.index}轮输入`, norm(rows[i][2]) === norm(want.tokens.input_tokens),
        `DOM=${rows[i][2]} 期望=${want.tokens.input_tokens}`);
      record(`对账/第${want.index}轮输出`, norm(rows[i][3]) === norm(want.tokens.output_tokens),
        `DOM=${rows[i][3]} 期望=${want.tokens.output_tokens}`);
    }
    await page.close();
  }

  await browser.close();
  if (resultFile) fs.writeFileSync(resultFile, JSON.stringify(results, null, 1), 'utf8');
  const failed = results.filter((r) => !r.ok);
  console.log(`  面板检查: ${results.length - failed.length}/${results.length} 通过`);
  for (const f of failed.slice(0, 8)) console.log(`    FAIL ${f.name} — ${f.detail}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log('  面板检查异常:', e.message.split('\n')[0]);
  process.exit(1);
});
