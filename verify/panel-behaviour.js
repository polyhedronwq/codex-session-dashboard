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
    placeholder: (document.getElementById('agents-list') || {}).innerText.includes('没有子代理'),
    activity: (() => {
      const dt = [...document.querySelectorAll('#footprint-kv dt')].find((d) => d.textContent.includes('子代理活动'));
      return dt ? (dt.nextElementSibling || {}).textContent || '' : '';
    })(),
  }));

  // 会话可能本来就没有子代理：此时应显示占位文案，而不是空白
  record('面板/代理 子代理列表有行或占位', agents.rows >= 1 || agents.placeholder,
    `行数 ${agents.rows} 占位=${agents.placeholder}`);
  record('面板/代理 工作足迹有 6 项以上', agents.footprint.length >= 6, agents.footprint.join(','));
  record('面板/代理 子代理活动是中文（不是 started/completed）',
    agents.activity.length === 0
      || (/启动|交互|完成/.test(agents.activity) && !/started|completed|interacted/.test(agents.activity)),
    agents.activity.slice(0, 40));


  // ---------- P4：头部、最近一轮、异常态、控件 ----------
  await clickTab('概览');
  const head = await frame.evaluate(() => {
    const get = (id) => (document.getElementById(id) || {}).textContent || '';
    return {
      model: get('model'), title: get('thread-title'), auto: get('auto'),
      updated: get('updated'), refresh: !!document.getElementById('refresh'),
      kv: [...document.querySelectorAll('#last-turn dt')].map((d) => d.textContent.trim()),
      recentCols: [...document.querySelectorAll('#recent tr')].map((r) => r.children.length),
    };
  });

  record('面板/头部元素齐全（模型/标题/自动刷新/更新时间/刷新按钮）',
    head.model.trim().length > 0 && head.model.trim() !== '—'
    && head.title.trim().length > 0 && head.auto.includes('自动刷新')
    && head.updated.length > 0 && head.refresh,
    JSON.stringify({ model: head.model, title: head.title, auto: head.auto, updated: head.updated, refresh: head.refresh }));

  record('面板/最近一轮有 6 组以上指标',
    head.kv.length >= 6 && head.kv.includes('输入') && head.kv.includes('输出'),
    head.kv.join(','));

  record('面板/最近 5 轮每行列数一致',
    head.recentCols.length >= 2 && new Set(head.recentCols).size === 1,
    JSON.stringify(head.recentCols));

  await clickTab('代理');
  const agentRows = await frame.evaluate(() => [...document.querySelectorAll('#agents-list > *')]
    .map((row) => row.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean));
  record('面板/子代理行有名称与数值',
    agentRows.length >= 1 && agentRows.every((t) => /\d/.test(t) && /[A-Za-z\u4e00-\u9fa5]/.test(t)),
    JSON.stringify(agentRows.slice(0, 2)));

  // ---------- 异常态：从父页面注入最小 payload ----------
  const minimal = {
    ok: true,
    thread: { id: 'empty-thread', thread_id: 'empty-thread', title: '新对话', model: 'gpt-test' },
    summary: { ok: true, turns: 0, steps: 0, total: {}, cache_hit_pct: 0, context: {}, quota: { api: null }, last_turn: null, running: false },
    turns: [],
  };
  // 先恢复默认勾选状态，否则"空数据应该显示占位"会被上一段勾选的合计行干扰
  await frame.evaluate(() => {
    for (const id of ['opt-total', 'opt-events', 'opt-delta']) {
      const el = document.getElementById(id);
      if (el && el.checked) el.click();
    }
    const latest = document.querySelector('button[data-mode="latest"]');
    if (latest) latest.click();
  });
  await page.waitForTimeout(250);

  await page.evaluate((payload) => {
    const frameEl = document.getElementById('frame');
    frameEl.contentWindow.postMessage({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { content: [{ type: 'text', text: 'ok' }], structuredContent: payload },
    }, '*');
  }, minimal);
  await page.waitForTimeout(700);

  const emptyState = await frame.evaluate(() => {
    const text = document.body.innerText;
    return {
      hasBadToken: /NaN|undefined|\[object/.test(text),
      statsEmpty: (document.getElementById('stats-body') || {}).innerText || '',
      traceEmpty: (document.getElementById('trace-list') || {}).innerText || '',
      agentsEmpty: (document.getElementById('agents-list') || {}).innerText || '',
      quotaCap: (document.getElementById('c-quota-cap') || {}).textContent || '',
    };
  });

  record('面板/空数据不出现 NaN/undefined', !emptyState.hasBadToken,
    emptyState.hasBadToken ? '命中异常占位符' : '');

  record('面板/空数据的统计页显示占位而不是空白',
    emptyState.statsEmpty.includes('暂无数据'), emptyState.statsEmpty.slice(0, 30));

  record('面板/空数据的轨迹页显示占位',
    emptyState.traceEmpty.includes('没有匹配'), emptyState.traceEmpty.slice(0, 30));

  record('面板/空数据的代理页显示占位',
    emptyState.agentsEmpty.includes('没有子代理'), emptyState.agentsEmpty.slice(0, 30));

  // 完全没数据时说明是「未取到」；服务端标记 unavailable 时才是「新对话，稍后才统计」
  record('面板/空数据的额度说明有明确原因',
    /新对话|未取到/.test(emptyState.quotaCap), emptyState.quotaCap.slice(0, 30));

  // ---------- 控件弱断言：点击有反应且不报错 ----------
  const controlErrorsBefore = errors.length;
  const controls = await frame.evaluate(() => {
    const out = [];
    for (const id of ['opt-total', 'opt-events', 'opt-delta', 'opt-fold']) {
      const el = document.getElementById(id);
      if (!el) { out.push({ id, exists: false }); continue; }
      const before = el.checked;
      el.click();
      out.push({ id, exists: true, toggled: el.checked !== before });
    }
    const cum = document.querySelector('button[data-mode="cum"]');
    if (cum) cum.click();
    const latest = document.querySelector('button[data-mode="latest"]');
    if (latest) latest.click();
    return out;
  });
  await page.waitForTimeout(300);

  record('面板/四个复选框都能切换',
    controls.every((c) => c.exists && c.toggled), JSON.stringify(controls));
  record('面板/点击控件不产生脚本错误', errors.length === controlErrorsBefore,
    errors.slice(controlErrorsBefore, controlErrorsBefore + 2).join(' | '));

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
