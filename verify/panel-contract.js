// P6：面板内容契约——页签、刷新、统计控件、轨迹明细、代理图/链接/消息、变更记录。
//
// 为什么不用真实会话快照：这些断言要对"确定的数字"对账（增量、比例、条数），
// 真实会话里没有子代理/消息/变更记录时就只能 SKIP，等于没测。
// 所以这里自己造一份 schema 忠实于 src/shared/server.py 的 payload，
// 通过一个临时 host 页面按 MCP 协议喂给 src/shared/panel.html——
// 渲染路径、消息协议、面板代码都是真的，只有数据是确定的。
//
//   node verify/panel-contract.js [probeDir]
const fs = require('fs');
const path = require('path');

const chromiumPath = (() => {
  try { return require('playwright').chromium; } catch (_) { /* fallback */ }
  try { return require('C:/Users/admin/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright').chromium; } catch (_) { return null; }
})();

const probeDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'probe'));
const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 合成 payload
// 字段顺序/形状照 src/shared/server.py 的 payload_for()：thread / summary / turns / meta。
// 数字是挑过的，好让断言能对"是否算对"下结论（例如增量 1000/2000/4000、条形 100%/50%）。
function buildSnapshot() {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const items1 = [
    { type: 'UserMessage', label: '用户', name: '', start: 0, ms: 0, text: '第一条用户消息' },
    { type: 'AgentMessage', label: '助手', name: '', start: 100, ms: 0, text: '第一条助手回复' },
    { type: 'CommandExecution', label: '命令', name: 'python -c pass', start: 200, ms: 400, text: 'python -c pass' },
    { type: 'CommandExecution', label: '命令', name: 'git status', start: 700, ms: 300, text: 'git status' },
    { type: 'CommandExecution', label: '命令', name: 'node --check x.js', start: 1100, ms: 200, text: 'node --check x.js' },
    { type: 'ContextCompaction', label: '压缩', name: '自动压缩', start: 2400, ms: 100, text: '上下文压缩' },
  ];
  const turn = (index, steps, ctx) => ({
    index,
    steps,
    running: false,
    aborted: false,
    tokens: {
      input_tokens: ctx.input,
      cached_input_tokens: ctx.input / 2,
      output_tokens: ctx.output,
      reasoning_output_tokens: 10,
      total_tokens: ctx.input + ctx.output,
    },
    cache_hit_pct: 50,
    speed: 10,
    duration_ms: ctx.duration,
    ttft_ms: 100,
    model_ms: ctx.model,
    tool_ms: ctx.tool,
    context_used: ctx.used,
    context_prev: ctx.prev,
    context_sum: ctx.sum,
    context_sum_prev: ctx.sumPrev,
    user_text: ctx.userText,
    assistant_text: '助手回复 ' + index,
    trigger: 'composer',
    item_count: ctx.itemCount,
    timeline: ctx.timeline,
    tool_counts: { CommandExecution: 1 },
  });
  const turns = [
    turn(1, 3, {
      input: 1000, output: 100, duration: 3000, model: 2000, tool: 500,
      used: 5000, prev: 4000, sum: 6000, sumPrev: 4000,
      userText: '第一条用户消息', itemCount: 6,
      timeline: [
        { start: 0, len: 1200, label: '模型', name: 'gpt-5-codex' },
        { start: 1200, len: 300, label: '工具', name: 'shell' },
        { start: 1500, len: 800, label: '模型', name: 'gpt-5-codex' },
      ],
    }),
    turn(2, 5, {
      input: 2000, output: 200, duration: 4000, model: 2500, tool: 800,
      used: 8000, prev: 6000, sum: 9000, sumPrev: 6000,
      userText: '第二条用户消息', itemCount: 2,
      timeline: [
        { start: 0, len: 2000, label: '模型', name: 'gpt-5-codex' },
        { start: 2000, len: 800, label: '工具', name: 'shell' },
      ],
    }),
    turn(3, 2, {
      input: 3000, output: 300, duration: 2000, model: 1500, tool: 200,
      used: 12000, prev: 8000, sum: 14000, sumPrev: 8000,
      userText: '第三条用户消息', itemCount: 1,
      timeline: [{ start: 0, len: 1500, label: '模型', name: 'gpt-5-codex' }],
    }),
  ];
  turns[0].items = items1;
  turns[1].items = [
    { type: 'CommandExecution', label: '命令', name: 'node --version', start: 2100, ms: 200, text: 'node --version' },
    { type: 'CommandExecution', label: '命令', name: 'python --version', start: 2400, ms: 200, text: 'python --version' },
  ];
  turns[2].items = [{ type: 'CommandExecution', label: '命令', name: 'git status', start: 0, ms: 100, text: 'git status' }];

  return {
    ok: true,
    thread: {
      id: 'contract-thread',
      thread_id: 'contract-thread',
      title: '面板契约测试会话',
      model: 'gpt-5-codex',
      updated_at: Math.floor((now - 60000) / 1000),
      source: 'local',
    },
    summary: {
      turns: 3,
      user_messages: 3,
      steps: 10,
      last_turn_steps: 2,
      last_turn_tools: 1,
      total: {
        input_tokens: 1500000,
        cached_input_tokens: 1200000,
        output_tokens: 45000,
        reasoning_output_tokens: 8000,
        total_tokens: 1545000,
      },
      cache_hit_pct: 80,
      context: { used: 120000, window: 258400, pct: 46.4 },
      quota: { api: { weekly_percent: 12.34, five_hour_percent: null, data_status: 'partial', data_as_of: iso(3600000) } },
      compactions: 1,
      footprint: {
        files: 2,
        top_files: [
          { path: 'C:\\work\\repo\\src\\main.py', name: 'main.py', count: 5 },
          { path: 'C:\\work\\repo\\README.md', name: 'README.md', count: 2 },
        ],
        commands: 3,
        mcp: [{ server: 'filesystem', count: 2 }],
        mcp_calls: 2,
        searches: 1,
        compactions: 1,
        subagent_events: { started: 2, completed: 1 },
        subagent_threads: 2,
      },
      env: {
        cwd: 'C:\\work\\repo',
        approval_policy: 'on-request',
        sandbox_type: 'workspace-write',
        writable_roots: [],
        network: false,
        model: 'gpt-5-codex',
        effort: 'high',
      },
      settings_changes: [{
        ts: now - 300000,
        after_turns: 1,
        changes: [
          { field: 'model', from: 'gpt-5', to: 'gpt-5-codex' },
          { field: 'effort', from: 'low', to: 'high' },
          { field: 'approval_policy', from: 'on-request', to: 'never' },
        ],
        before: { model: 'gpt-5', effort: 'low' },
        after: { model: 'gpt-5-codex', effort: 'high' },
      }],
      rules: { file: 'AGENTS.md', chars: 1234, head: '契约测试规则' },
      agent_msgs: {
        count: 5,
        by_author: { 'child-a': 3, 'child-b': 2 },
        items: [{ author: 'child-a', recipient: '主线程', ts: now, turn_id: 'turn-1' }],
      },
      aborted: 0,
      last_turn: turns[2],
      last_completed: turns[2],
      running: false,
      subagents: {
        edges: 2,
        children: 2,
        tokens: 300000,
        share_pct: 19.4,
        models: [{ model: 'gpt-5-codex', count: 2 }],
        items: [
          {
            id: 'child-aaaaaaaa', short: 'child-aaaa', label: '子代理甲', nickname: '子代理甲',
            model: 'gpt-5-codex', effort: 'high', path: 'sub/agent-a', tokens: 200000,
            updated_at: now, role: 'explorer', nested: 0, status: 'completed', times: 1,
          },
          {
            id: 'child-bbbbbbbb', short: 'child-bbbb', label: '子代理乙', nickname: '子代理乙',
            model: 'gpt-5-codex', effort: '', path: 'sub/agent-b', tokens: 100000,
            updated_at: now, role: 'worker', nested: 0, status: 'completed', times: 2,
          },
        ],
      },
    },
    turns,
    meta: { parse_errors: 0, file_bytes: 2048, generated_at: new Date(now).toISOString() },
  };
}

// 临时 host：只做 MCP 的最小实现（initialize / tools/call / ui/open-link），
// 并把收到的请求记到 window.HOST 上，供断言检查"面板真的发了请求"。
function buildHostHtml(snapshot) {
  const snapshotJs = JSON.stringify(snapshot).replace(/</g, '\\u003c');
  return [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    'html,body{margin:0;height:100%;background:#181818}iframe{border:0;width:100%;height:100%}',
    '</style></head><body>',
    '<iframe id="frame" src="../src/shared/panel.html"></iframe>',
    '<script>',
    'const PARAMS = new URLSearchParams(location.search);',
    'const HOST = window.HOST = {',
    "  calls: 0, opens: [], mode: PARAMS.get('mode') || 'ok',",
    "  errorText: PARAMS.get('errorText') || '读取本地会话记录失败，请稍后重试。',",
    "  delay: Number(PARAMS.get('delay') || 0),",
    '};',
    'const SNAPSHOT = ' + snapshotJs + ';',
    "const frameEl = document.getElementById('frame');",
    "window.addEventListener('message', (e) => {",
    '  const msg = e.data;',
    "  if (!msg || msg.jsonrpc !== '2.0' || !msg.id) return;",
    '  const reply = (payload) => {',
    '    const send = () => frameEl.contentWindow.postMessage(',
    "      Object.assign({ jsonrpc: '2.0', id: msg.id }, payload), '*');",
    '    if (HOST.delay) setTimeout(send, HOST.delay); else send();',
    '  };',
    "  if (msg.method === 'ui/initialize') {",
    "    reply({ result: { protocolVersion: '2025-06-18',",
    "      hostInfo: { name: 'contract-harness', version: '0' }, hostCapabilities: {},",
    "      hostContext: { theme: 'dark' } } });",
    '    return;',
    '  }',
    "  if (msg.method === 'tools/call') {",
    '    HOST.calls += 1;',
    "    if (HOST.mode === 'error') {",
    "      reply({ result: { content: [{ type: 'text', text: HOST.errorText }], isError: true } });",
    '    } else {',
    "      reply({ result: { content: [{ type: 'text', text: 'ok' }], structuredContent: SNAPSHOT } });",
    '    }',
    '    return;',
    '  }',
    "  if (msg.method === 'ui/open-link') {",
    '    HOST.opens.push(msg.params && msg.params.url);',
    '    reply({ result: {} });',
    '    return;',
    '  }',
    '  reply({ result: {} });',
    '});',
    '</script></body></html>',
  ].join('\n');
}

(async () => {
  if (!chromiumPath) { console.log('  找不到 playwright'); process.exit(1); }
  const hostFile = path.join(probeDir, 'panel-contract-host.html');
  const snapshot = buildSnapshot();
  fs.writeFileSync(hostFile, buildHostHtml(snapshot), 'utf8');

  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser = await chromiumPath.launch({ executablePath: fs.existsSync(edge) ? edge : undefined });
  const pageErrors = [];
  const newPage = async (query) => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    p.on('pageerror', (e) => pageErrors.push(e.message.split('\n')[0]));
    await p.goto('file:///' + hostFile.replace(/\\/g, '/') + (query || ''));
    await p.waitForTimeout(1600); // boot: 先等 host 推/面板自取数据（600ms 自取 + 渲染）
    return p;
  };
  const frameOf = async (p) => {
    for (let i = 0; i < 20; i += 1) {
      const f = p.frames().find((x) => x.url().includes('panel.html'));
      if (f) return f;
      await sleep(200);
    }
    return null;
  };

  let page;
  let frame;
  try {
    page = await newPage('');
    frame = await frameOf(page);
    if (!frame) { record('面板契约/宿主页面', false, 'panel.html iframe 未加载'); throw new Error('no frame'); }

    const f = (fn, arg) => frame.evaluate(fn, arg);
    const reset = async () => {
      await f(() => {
        for (const id of ['opt-total', 'opt-events', 'opt-delta']) {
          const el = document.getElementById(id);
          if (el && el.checked) el.click();
        }
        const latest = document.querySelector('#opt-ctxmode button[data-mode="latest"]');
        if (latest) latest.click();
        const q = document.getElementById('trace-q');
        if (q && q.value) { q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); }
      });
      await sleep(150);
    };
    const clickTab = async (name) => {
      await f((n) => {
        const tab = [...document.querySelectorAll('.tab')].find((t) => (t.textContent || '').trim() === n);
        if (tab) tab.click();
      }, name);
      await sleep(200);
    };

    // ---------- 1. 页签：同时只显示一个，且内容真的是那个页签的 ----------
    const tabReport = [];
    const TAB_SECTION = { '概览': 'overview', '统计': 'stats', '轨迹': 'trace', '代理': 'agents' };
    for (const [label, sectionId] of Object.entries(TAB_SECTION)) {
      await clickTab(label);
      const state = await f((want) => {
        const ids = ['overview', 'stats', 'trace', 'agents'];
        const visible = ids.filter((id) => !document.getElementById(id).classList.contains('hide'));
        const section = document.getElementById(want);
        return { visible, len: (section.innerText || '').trim().length };
      }, sectionId);
      if (state.visible.length !== 1 || state.visible[0] !== sectionId || state.len < 30) {
        tabReport.push(`${label}: 可见=${state.visible.join(',')} 字数=${state.len}`);
      }
    }
    record('面板/四个页签互斥且各有内容', tabReport.length === 0,
      tabReport.join(' | ') || 'overview/stats/trace/agents 均单独可见');

    // ---------- 2. 刷新按钮：发起新请求、文案有过程、不报错 ----------
    await clickTab('概览');
    await page.evaluate(() => { window.HOST.delay = 250; });
    const callsBefore = await page.evaluate(() => window.HOST.calls);
    const refreshClick = await f(() => {
      document.getElementById('refresh').click();
      return document.getElementById('refresh').textContent.trim();
    });
    await page.waitForTimeout(900);
    const refreshAfter = await f(() => document.getElementById('refresh').textContent.trim());
    const callsAfter = await page.evaluate(() => window.HOST.calls);
    record('面板/刷新按钮发起新请求并还原文案',
      refreshClick === '刷新中…' && refreshAfter === '刷新' && callsAfter > callsBefore,
      `点击时=${refreshClick} 900ms后=${refreshAfter} 请求数 ${callsBefore}→${callsAfter}`);

    // ---------- 3. 刷新失败：显示明确原因；恢复后再刷新能回到仪表盘 ----------
    await page.evaluate(() => { window.HOST.mode = 'error'; window.HOST.delay = 0; });
    await f(() => document.getElementById('refresh').click());
    await page.waitForTimeout(900);
    const failed = await f(() => ({
      errShown: !document.getElementById('error').classList.contains('hide'),
      errText: document.getElementById('error').textContent.trim(),
      overviewHidden: document.getElementById('overview').classList.contains('hide'),
      refreshText: document.getElementById('refresh').textContent.trim(),
    }));
    await page.evaluate(() => { window.HOST.mode = 'ok'; });
    await f(() => document.getElementById('refresh').click());
    await page.waitForTimeout(1200);
    const recovered = await f(() => ({
      errHidden: document.getElementById('error').classList.contains('hide'),
      turns: document.getElementById('c-turns').textContent.trim(),
      body: document.body.innerText,
    }));
    record('面板/刷新失败显示原因且恢复后回到仪表盘',
      failed.errShown && failed.errText.includes('读取失败') === false && failed.errText.includes('读取本地会话记录失败')
      && failed.overviewHidden && failed.refreshText === '刷新'
      && recovered.errHidden && /\/\s*\d+/.test(recovered.turns)
      && !/NaN|undefined/.test(recovered.body),
      `失败态=${JSON.stringify(failed)} 恢复态=${recovered.errHidden ? 'error 已隐藏' : 'error 仍在'}`);

    // ---------- 4. 异常结果（rollout_missing 的 isError 分支）显示明确原因 ----------
    const errPage = await newPage('?mode=error&errorText=' + encodeURIComponent('该会话的本地记录文件不可用。'));
    const errFrame = await frameOf(errPage);
    if (!errFrame) {
      record('面板/rollout_missing 显示明确原因', false, 'iframe 未加载');
    } else {
      const errState = await errFrame.evaluate(() => ({
        errShown: !document.getElementById('error').classList.contains('hide'),
        errText: document.getElementById('error').textContent.trim(),
        overviewHidden: document.getElementById('overview').classList.contains('hide'),
        body: document.body.innerText,
      }));
      record('面板/rollout_missing 显示明确原因',
        errState.errShown && errState.errText.includes('本地记录文件不可用')
        && errState.overviewHidden && !/NaN|undefined/.test(errState.body),
        `error=${errState.errText.slice(0, 40)}`);
      await errPage.close();
    }

    // ---------- 5. 统计 opt-events：事件行（用户/助手/压缩）默认隐藏，勾选后出现 ----------
    await clickTab('统计');
    await reset();
    await f(() => document.querySelector('#stats-body tr[data-turn="1"]').click());
    await sleep(250);
    const itemsOff = await f(() => ({
      count: document.querySelectorAll('#stats-body details.it, #stats-body .itemrow').length,
      text: document.getElementById('stats-body').innerText,
    }));
    await f(() => document.getElementById('opt-events').click());
    await sleep(250);
    const itemsOn = await f(() => ({
      count: document.querySelectorAll('#stats-body details.it, #stats-body .itemrow').length,
      text: document.getElementById('stats-body').innerText,
    }));
    await reset();
    record('面板/统计 opt-events 勾选后事件行出现',
      itemsOff.count === 3 && itemsOn.count === 6 && !itemsOff.text.includes('压缩') && itemsOn.text.includes('压缩'),
      `事件行 ${itemsOff.count} → ${itemsOn.count}`);

    // ---------- 6. 统计 opt-delta：勾选后上下文列出现带符号增量（最新/累计口径各对一次） ----------
    await reset();
    const deltaOff = await f(() => document.querySelectorAll('#stats-body .delta').length);
    await f(() => document.getElementById('opt-delta').click());
    await sleep(250);
    const deltaLatest = await f(() => [...document.querySelectorAll('#stats-body .delta')].map((el) => el.textContent.trim()));
    await f(() => document.querySelector('#opt-ctxmode button[data-mode="cum"]').click());
    await sleep(250);
    const deltaCum = await f(() => [...document.querySelectorAll('#stats-body .delta')].map((el) => el.textContent.trim()));
    record('面板/统计 opt-delta 增量按最新/累计分别计算',
      deltaOff === 0
      && JSON.stringify(deltaLatest) === JSON.stringify(['+1,000', '+2,000', '+4,000'])
      && JSON.stringify(deltaCum) === JSON.stringify(['+2,000', '+3,000', '+6,000']),
      `off=${deltaOff} latest=${deltaLatest.join(',')} cum=${deltaCum.join(',')}`);

    // ---------- 7. 累计/最新切换：上下文列取不同字段 ----------
    await reset();
    const latestCell = await f(() => document.querySelector('#stats-body tr[data-turn="1"] td:nth-child(4)').textContent.trim());
    await f(() => document.querySelector('#opt-ctxmode button[data-mode="cum"]').click());
    await sleep(250);
    const cumCell = await f(() => document.querySelector('#stats-body tr[data-turn="1"] td:nth-child(4)').textContent.trim());
    await reset();
    record('面板/统计 累计/最新切换取不同字段',
      latestCell === '5,000' && cumCell === '6,000', `最新=${latestCell} 累计=${cumCell}`);

    // ---------- 8. 合计行：数值来自 summary.steps / summary.total，不是当前窗口求和 ----------
    await reset();
    await f(() => document.getElementById('opt-total').click());
    await sleep(250);
    const totalRow = await f(() => {
      const row = document.querySelector('#stats-body tr.totalrow');
      return row ? [...row.children].map((td) => td.textContent.trim()) : null;
    });
    await reset();
    record('面板/统计 合计行取 summary 全量数值',
      !!totalRow && totalRow[0].startsWith('合计') && totalRow[2] === '10'
      && totalRow[4] === '1,500,000' && totalRow[5] === '45,000',
      totalRow ? totalRow.slice(0, 6).join(' | ') : '没有合计行');

    // ---------- 9. 轨迹：轮次行、时间条小段与轮次一一对应 ----------
    await clickTab('轨迹');
    const traceRows = await f(() => [...document.querySelectorAll('#trace-list .trow')].map((row) => ({
      label: (row.querySelector('.tlabel') || {}).textContent || '',
      turn: row.dataset.turn,
      segs: [...row.querySelectorAll('.tbar .seg')].map((s) => ({
        left: parseFloat(s.style.left), width: parseFloat(s.style.width),
      })),
    })));
    const segBad = traceRows.filter((r) => r.segs.some((s) => !(s.left >= 0 && s.left <= 100 && s.width >= 0 && s.width <= 100)));
    const segCount = Object.fromEntries(traceRows.map((r) => [r.turn, r.segs.length]));
    record('面板/轨迹 轮次行与时间条一致',
      traceRows.length === 3
      && traceRows.every((r) => /^第 \d+ 轮/.test(r.label.trim()))
      && segCount['1'] === 3 && segCount['2'] === 2 && segCount['3'] === 1 && segBad.length === 0,
      `行=${traceRows.length} 段数=${JSON.stringify(segCount)}`);

    // ---------- 10. 轨迹汇总行：N 轮 · M 步，搜索时跟着变 ----------
    const summaryText = await f(() => document.getElementById('trace-summary').textContent.trim());
    await f(() => {
      const q = document.getElementById('trace-q');
      q.value = 'zzz-不会命中的关键词-zzz';
      q.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(300);
    const summaryFiltered = await f(() => ({
      text: document.getElementById('trace-summary').textContent.trim(),
      empty: document.getElementById('trace-list').innerText.includes('没有匹配'),
    }));
    await reset();
    record('面板/轨迹 汇总行与过滤结果一致',
      summaryText.startsWith('3 轮 · 10 步')
      && summaryFiltered.text.startsWith('0 轮 · 0 步') && summaryFiltered.empty,
      `${summaryText} → ${summaryFiltered.text}`);

    // ---------- 11. 轨迹折叠调用：同一类连续调用合并成 ×N，关闭后逐条 ----------
    await f(() => document.getElementById('opt-fold').click()); // 先关闭，从"逐条"开始
    await sleep(250);
    await f(() => document.querySelector('#trace-list .trow[data-turn="1"]').click());
    await sleep(300);
    const foldOff = await f(() => ({
      groups: document.querySelectorAll('#trace-list .rec.group').length,
      recs: document.querySelectorAll('#trace-list .rec[data-idx]').length,
      text: document.getElementById('trace-list').innerText,
    }));
    await f(() => document.getElementById('opt-fold').click()); // 打开折叠
    await sleep(300);
    const foldOn = await f(() => ({
      groups: document.querySelectorAll('#trace-list .rec.group').length,
      groupText: [...document.querySelectorAll('#trace-list .rec.group')].map((el) => el.innerText.replace(/\s+/g, ' ').trim()),
      recs: document.querySelectorAll('#trace-list .rec[data-idx]').length,
    }));
    record('面板/轨迹 折叠调用合并同类记录',
      foldOff.groups === 0 && foldOff.recs === 3
      && foldOn.groups === 1 && foldOn.groupText.some((t) => t.includes('×3') && t.includes('命令'))
      && foldOn.recs === 0,
      `折叠关=组${foldOff.groups}/条${foldOff.recs} 折叠开=组${foldOn.groups}/条${foldOn.recs}`);

    // ---------- 12. 代理：子代理图的名称/模型/条形/数值与图例 ----------
    await f(() => document.querySelector('#trace-list .trow[data-turn="1"]').click()); // 收起明细
    await clickTab('代理');
    const agentView = await f(() => ({
      rows: [...document.querySelectorAll('#agents-list .arow')].map((row) => ({
        name: (row.querySelector('.aname') || {}).textContent || '',
        model: (row.querySelector('.amodel') || {}).textContent || '',
        width: ((row.querySelector('.abar i') || {}).style || {}).width,
        tokens: (row.querySelector('.atokens') || {}).textContent || '',
      })),
      summary: document.getElementById('agents-summary').textContent.trim(),
      legend: (document.querySelector('#agents .legend') || {}).innerText || '',
    }));
    record('面板/代理 子代理图名称/模型/条形/数值',
      agentView.rows.length === 2
      && agentView.rows[0].name.includes('子代理甲') && agentView.rows[0].width === '100%'
      && agentView.rows[1].width === '50%' && agentView.rows[0].tokens === '200K' && agentView.rows[1].tokens === '100K'
      && agentView.rows.every((r) => r.model.includes('gpt-5-codex'))
      && agentView.summary.includes('2 次委派 · 2 个子代理') && agentView.summary.includes('300K tok')
      && agentView.legend.includes('条形长度 = 该子代理的 token 占最大者的比例'),
      `行=${JSON.stringify(agentView.rows)} 摘要=${agentView.summary}`);

    // ---------- 13. 代理：改动文件显示基名，链接携带完整路径且点击真的发出去 ----------
    const fileLinks = await f(() => [...document.querySelectorAll('#footprint-files a.fname')].map((a) => ({
      text: a.textContent.trim(), href: a.getAttribute('data-href'), title: a.getAttribute('title'),
    })));
    await f(() => document.querySelector('#footprint-files a.fname').click());
    await sleep(250);
    const opened = await page.evaluate(() => window.HOST.opens.slice());
    record('面板/代理 改动文件链接可点且指向完整路径',
      fileLinks.length === 2
      && fileLinks[0].text === 'main.py'
      && fileLinks[0].href === 'file:///C:/work/repo/src/main.py'
      && fileLinks[0].title === 'C:\\work\\repo\\src\\main.py'
      && opened[0] === 'file:///C:/work/repo/src/main.py',
      `链接=${JSON.stringify(fileLinks[0])} 打开=${opened[0]}`);

    // ---------- 14. 代理间消息：总数/参与方/分项条 ----------
    const msgView = await f(() => ({
      hidden: document.getElementById('agent-msgs-section').classList.contains('hide'),
      kv: document.getElementById('agent-msgs-kv').innerText.replace(/\s+/g, ' ').trim(),
      rows: [...document.querySelectorAll('#agent-msgs-list .mmsg')].map((row) => ({
        name: (row.querySelector('.mn') || {}).textContent || '',
        width: ((row.querySelector('.mbar i') || {}).style || {}).width,
        count: (row.querySelector('.mc') || {}).textContent || '',
      })),
    }));
    record('面板/代理 代理间消息总数/参与方/分项条',
      !msgView.hidden && msgView.kv.includes('消息总数') && msgView.kv.includes('5 条')
      && msgView.kv.includes('参与的代理') && msgView.kv.includes('2 个')
      && msgView.rows.length === 2
      && msgView.rows[0].name === 'child-a' && msgView.rows[0].width === '100%' && msgView.rows[0].count.includes('3 条')
      && msgView.rows[1].width === '67%',
      `kv=${msgView.kv} 行=${JSON.stringify(msgView.rows)}`);

    // ---------- 15. 概览：变更记录带完整 model+effort，非模型字段也译成中文 ----------
    await clickTab('概览');
    const changes = await f(() => ({
      hidden: document.getElementById('env-changes').classList.contains('hide'),
      rows: [...document.querySelectorAll('#env-changes-list .crow')].map((row) => row.innerText.replace(/\s+/g, ' ').trim()),
    }));
    const changeText = changes.rows[0] || '';
    record('面板/概览 变更记录显示完整模型+强度与中文审批值',
      !changes.hidden && changes.rows.length === 1
      && changeText.includes('模型/推理强度 gpt-5 low → gpt-5-codex high')
      && changeText.includes('审批模式 按需批准 → 从不询问')
      && changeText.includes('第 1 轮后'),
      changeText.slice(0, 100));

    // ---------- 16. 最近一轮 kv：全字段对账（以前只有"6 组以上"） ----------
    const lastKv = await f(() => [...document.querySelectorAll('#last-turn dt')].map((dt) => [
      dt.textContent.trim(), (dt.nextElementSibling || {}).textContent?.trim() || '',
    ]));
    const kvMap = Object.fromEntries(lastKv);
    record('面板/概览 最近一轮 kv 全字段对账',
      kvMap['输入'] === '3,000 tok' && kvMap['输出'] === '300 tok' && kvMap['其中推理'] === '10 tok'
      && kvMap['缓存命中'] === '50.0%' && kvMap['模型用时'] === '1.5s' && kvMap['工具用时'] === '200ms'
      && kvMap['首 token 延迟'] === '100ms' && kvMap['总用时'] === '2s'
      && kvMap['上下文占用'] === '12,000 / 258,400' && kvMap['自动压缩'] === '1 次',
      JSON.stringify(lastKv));

    record('面板契约/无脚本错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  } catch (error) {
    record('面板契约/执行', false, error && error.message ? error.message.split('\n')[0] : String(error));
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
    try { fs.unlinkSync(hostFile); } catch (_) { /* 已经被清理 */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`  面板契约: ${results.length - failed.length}/${results.length} 通过`);
  for (const r of failed) console.log(`    FAIL ${r.name} — ${r.detail}`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.log('  面板契约异常:', error && error.message);
  process.exit(1);
});
