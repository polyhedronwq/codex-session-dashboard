// P1：面板内容与交互断言（用 harness 页面，跨源 iframe 也能读）。
//
// 覆盖 SURFACES.md 里"面板 30 个面 + 8 个交互"中可观测的部分。
//
//   node verify/panel-behaviour.js <harnessDir>
const fs = require('fs');
const path = require('path');

const chromiumPath = (() => {
  try { return require('playwright').chromium; } catch (_) { /* fallback */ }
  try { return require('C:/Users/admin/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright').chromium; } catch (_) { return null; }
})();

const harnessDir = process.argv[2] || path.join(__dirname, '..', 'probe');
const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail: detail || '' });

(async () => {
  if (!chromiumPath) { console.log('  找不到 playwright'); process.exit(1); }
  const file = path.join(harnessDir, 'panel-harness.html');
  if (!fs.existsSync(file)) { console.log('  缺少 harness: ' + file); process.exit(1); }

  const browser = await chromiumPath.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
  await page.goto('file:///' + file.replace(/\\/g, '/'));
  await page.waitForTimeout(2400);
  const frame = page.frames().find((f) => f.url().includes('panel.html'));
  if (!frame) {
    console.log('  panel.html iframe 未加载');
    await browser.close();
    process.exit(1);
  }

  const clickTab = async (name) => {
    await frame.evaluate((n) => {
      const tab = [...document.querySelectorAll('.tab')].find((t) => (t.textContent || '').trim() === n);
      if (tab) tab.click();
    }, name);
    await page.waitForTimeout(350);
  };

  // ---------- 概览 ----------
  await clickTab('概览');
  const overview = await frame.evaluate(() => ({
    cards: [...document.querySelectorAll('.card')].map((c) => ({
      value: (c.querySelector('.v, .val, [id]') || {}).textContent || '',
      cap: (c.querySelector('.cap, .sub') || {}).textContent || '',
      text: c.innerText.replace(/\s+/g, ' '),
    })),
    recentRows: document.querySelectorAll('#recent tr').length,
    envRows: document.querySelectorAll('#env-kv dt').length,
    envText: (document.getElementById('env-kv') || {}).innerText || '',
    note: (document.getElementById('note') || {}).textContent || '',
  }));

  record('面板/概览 6 张卡片都有值', overview.cards.length === 6
    && overview.cards.every((c) => /\d|—/.test(c.text)), `卡片数 ${overview.cards.length}`);

  record('面板/概览 卡片都有说明文字（cap）',
    overview.cards.length === 6 && overview.cards.every((c) => c.cap.trim().length > 0),
    JSON.stringify(overview.cards.map((c) => c.cap.trim().slice(0, 18))));

  record('面板/概览 最近 5 轮表格有数据行', overview.recentRows >= 2, `行数 ${overview.recentRows}`);

  record('面板/概览 运行环境有 4 项以上', overview.envRows >= 4, `项数 ${overview.envRows}`);
  record('面板/概览 运行环境的沙箱/网络是中文值',
    /仅工作区可写|只读|无限制/.test(overview.envText) && /允许|禁止/.test(overview.envText),
    overview.envText.replace(/\s+/g, ' ').slice(0, 60));

  record('面板/概览 底部说明是「只读本地记录」',
    overview.note.includes('只读本地记录'), overview.note.slice(0, 30));

  // ---------- 统计 ----------
  await clickTab('统计');
  const header = await frame.evaluate(() => [...document.querySelectorAll('#stats thead th')].map((t) => t.textContent.trim()));
  record('面板/统计 表头带单位',
    header.some((h) => h.includes('(tok)')) && header.some((h) => h.includes('(%)')) && header.some((h) => h.includes('(tok/s)')),
    header.join('|').slice(0, 80));

  const rowCount = async () => frame.evaluate(() => ({
    rows: document.querySelectorAll('#stats-body tr').length,
    detail: document.querySelectorAll('#stats-body .srow').length,
  }));

  const before = await rowCount();
  await frame.evaluate(() => { const el = document.getElementById('opt-total'); if (el) el.click(); });
  await page.waitForTimeout(350);
  const afterTotal = await rowCount();
  record('面板/统计 勾选「合计行」后多一行',
    afterTotal.rows > before.rows, `${before.rows} → ${afterTotal.rows}`);

  await frame.evaluate(() => { const el = document.getElementById('opt-expand'); if (el) el.click(); });
  await page.waitForTimeout(400);
  const afterExpand = await rowCount();
  record('面板/统计「展开全部」出现逐步明细',
    afterExpand.detail > 0, `明细行 ${afterExpand.detail}`);

  // 收起后点单行展开
  await frame.evaluate(() => { const el = document.getElementById('opt-expand'); if (el) el.click(); });
  await page.waitForTimeout(300);
  await frame.evaluate(() => { const r = document.querySelector('#stats-body tr.clickable'); if (r) r.click(); });
  await page.waitForTimeout(350);
  const single = await rowCount();
  record('面板/统计 点击单行能展开明细', single.detail > 0, `明细行 ${single.detail}`);

  // ---------- 轨迹 ----------
  await clickTab('轨迹');
  const traceCount = async () => frame.evaluate(() => {
    const list = document.getElementById('trace-list');
    return list ? list.innerText.trim().length : -1;
  });
  const traceFull = await traceCount();
  await frame.evaluate(() => {
    const q = document.getElementById('trace-q');
    if (q) { q.value = 'zzz-should-not-match-zzz'; q.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await page.waitForTimeout(450);
  const traceFiltered = await traceCount();
  record('面板/轨迹 搜索会过滤条目',
    traceFull > 0 && traceFiltered >= 0 && traceFiltered < traceFull,
    `全文 ${traceFull} 字 → 过滤后 ${traceFiltered} 字`);

  await frame.evaluate(() => {
    const q = document.getElementById('trace-q');
    if (q) { q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await page.waitForTimeout(450);
  const traceRestored = await traceCount();
  record('面板/轨迹 清空搜索后恢复', traceRestored >= traceFull * 0.9,
    `${traceFiltered} → ${traceRestored}（原 ${traceFull}）`);

  // ---------- 代理 ----------
  await clickTab('代理');
  const agents = await frame.evaluate(() => ({
    rows: document.querySelectorAll('#agents-list > *').length,
    footprint: [...document.querySelectorAll('#footprint-kv dt')].map((d) => d.textContent.trim()),
    activity: (() => {
      const dt = [...document.querySelectorAll('#footprint-kv dt')].find((d) => d.textContent.includes('子代理活动'));
      return dt ? (dt.nextElementSibling || {}).textContent || '' : '';
    })(),
  }));

  record('面板/代理 子代理列表有行', agents.rows >= 1, `行数 ${agents.rows}`);
  record('面板/代理 工作足迹有 6 项以上', agents.footprint.length >= 6, agents.footprint.join(','));
  record('面板/代理 子代理活动是中文（不是 started/completed）',
    /启动|交互|完成/.test(agents.activity) && !/started|completed|interacted/.test(agents.activity),
    agents.activity.slice(0, 40));

  record('面板/无脚本报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`  面板行为: ${results.length - failed.length}/${results.length} 通过`);
  for (const r of failed) console.log(`    FAIL ${r.name} — ${r.detail}`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.log('  异常 ' + (error && error.message));
  process.exit(1);
});
