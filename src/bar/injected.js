(() => {
  // Bump when this file changes: the injector logs it, and a stale build means the
  // page is still running old code (the install guard below would otherwise hide that).
  const BUILD = '2026-11-19.8';
  if (window.__dshBarInstalled) return;
  window.__dshBarInstalled = true;
  window.__dshBarBuild = BUILD;

  const ID = 'dsh-bar-root';
  const STYLE = 'dsh-bar-style';

  const CSS = `
  /* The reserved space follows the bar's real height (see place()); 22px is only the
     initial value before the first measurement. */
  [class*="ComposerLayoutRoot"]{margin-bottom:var(--dsh-bar-space, 22px) !important;}\n  #dsh-bar-root{position:fixed;z-index:2147483000;will-change:transform;contain:layout paint;display:flex;align-items:center;gap:2px;
    font:12px/1.2 system-ui,"Segoe UI","Microsoft YaHei UI",sans-serif;font-variant-numeric:tabular-nums;
    color:#8b919a;background:transparent;padding:0 6px;height:24px;max-width:100%;white-space:nowrap;
    pointer-events:auto;user-select:none;}
  #dsh-bar-root[data-theme="light"]{color:#7c828b;}
  #dsh-bar-root .dsh-items{display:flex;align-items:center;gap:2px;min-width:0;overflow:hidden;flex:0 1 auto;}
  #dsh-bar-root .dsh-left{flex:0 1 auto;}
  #dsh-bar-root .dsh-health{width:6px;height:6px;border-radius:50%;background:#9aa0a8;
    flex:0 0 6px;margin-right:5px;display:inline-block;opacity:.75;}
  #dsh-bar-root .dsh-health.hide{display:none;}
  #dsh-bar-root .dsh-health.bad{background:#d99b2b;opacity:1;}
  #dsh-bar-root .dsh-right{flex:0 0 auto;}
  #dsh-bar-root .dsh-right{margin-left:auto;}\n  #dsh-bar-root .dsh-item{all:unset;display:inline-flex;align-items:center;gap:5px;padding:1px 7px;min-width:0;
    border-radius:6px;cursor:pointer;color:inherit;line-height:18px;}\n  #dsh-bar-root .dsh-item>span{overflow:hidden;text-overflow:ellipsis;}
  #dsh-bar-root .dsh-item:hover,#dsh-bar-root .dsh-item.on{background:rgba(127,127,127,.16);color:#dcdcdc;}
  #dsh-bar-root[data-theme="light"] .dsh-item:hover,
  #dsh-bar-root[data-theme="light"] .dsh-item.on{color:#1b1d21;}
  #dsh-bar-root .dsh-item b{color:#c9ccd1;font-weight:500;}
  #dsh-bar-root[data-theme="light"] .dsh-item b{color:#2a2d33;}
  #dsh-bar-root .dsh-dim{opacity:.75;}
  #dsh-bar-root .dsh-sep{width:1px;height:10px;background:rgba(127,127,127,.28);margin:0 3px;}
  #dsh-bar-root svg{width:16px;height:16px;flex:0 0 auto;opacity:.9;}
  #dsh-bar-root .dsh-ring{transform:rotate(-90deg);}
  #dsh-bar-root .dsh-ring circle{fill:none;stroke-width:2.6;}
  #dsh-bar-root .dsh-ring .bg{stroke:rgba(127,127,127,.3);}
  #dsh-bar-root .dsh-ring .fg{stroke:#53b559;stroke-linecap:round;}

  #dsh-bar-root .dsh-pop{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);
    width:380px;background:#202020;border:1px solid #333;border-radius:12px;padding:12px 14px 10px;
    box-shadow:0 18px 50px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.35);color:#ececec;display:none;
    font-size:12px;line-height:1.5;text-align:left;
    /* the bar sets nowrap for its inline items; a popover must wrap and must never
       grow past the space above it */
    white-space:normal;max-height:min(70vh,calc(100vh - 90px));overflow-y:auto;overflow-x:hidden;}
  #dsh-bar-root[data-theme="light"] .dsh-pop{background:#fff;border-color:#e6e7ea;color:#1b1d21;
    box-shadow:0 18px 50px rgba(15,20,30,.16),0 2px 8px rgba(15,20,30,.08);}
  #dsh-bar-root .dsh-pop.right{left:auto;right:-10px;transform:none;}
  #dsh-bar-root .dsh-pop.show{display:block;}
  #dsh-bar-root .dsh-pop-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;}
  #dsh-bar-root .dsh-pop-title{font-size:12.5px;font-weight:600;}
  #dsh-bar-root .dsh-tag{margin-left:auto;font-size:10.5px;color:#9aa0a6;border:1px solid #3a3a3a;
    border-radius:999px;padding:1px 7px;}
  #dsh-bar-root[data-theme="light"] .dsh-tag{border-color:#e2e3e6;color:#6f757c;}
  #dsh-bar-root .dsh-big{display:flex;align-items:baseline;gap:6px;margin:2px 0 10px;}
  #dsh-bar-root .dsh-big .n{font-size:22px;font-weight:600;letter-spacing:-.3px;}
  #dsh-bar-root .dsh-big .u{font-size:11px;color:#9aa0a6;}
  #dsh-bar-root .dsh-kv{display:grid;grid-template-columns:1fr auto;gap:6px 14px;}
  #dsh-bar-root .dsh-kv dt{color:#9aa0a6;}
  #dsh-bar-root .dsh-kv dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;}
  #dsh-bar-root .dsh-track{height:5px;border-radius:99px;background:rgba(127,127,127,.25);overflow:hidden;margin:8px 0 10px;}
  #dsh-bar-root .dsh-fill{height:100%;border-radius:99px;background:#53b559;}
  #dsh-bar-root .dsh-note{margin-top:10px;padding-top:8px;border-top:1px solid rgba(127,127,127,.22);
    color:#6f757c;font-size:10.5px;line-height:1.5;}
  #dsh-bar-root[data-theme="light"] .dsh-note{color:#9096a0;border-color:#ececee;}
  #dsh-bar-root .dsh-list{margin:0;padding:0;list-style:none;}
  #dsh-bar-root .dsh-list li{display:grid;grid-template-columns:56px 1fr 52px;gap:8px;
    color:#c9ccd1;font-size:11.5px;padding:2px 0;}
  #dsh-bar-root[data-theme="light"] .dsh-list li{color:#2a2d33;}
  #dsh-bar-root .dsh-list li span:last-child{text-align:right;color:#9aa0a6;}
  #dsh-bar-root[data-theme="light"] .dsh-list li span:last-child{color:#6f757c;}
  #dsh-bar-root .dsh-changes{margin-top:10px;padding-top:8px;border-top:1px solid rgba(127,127,127,.22);}
  #dsh-bar-root .dsh-changes-head{display:flex;align-items:center;margin-bottom:5px;font-size:11px;font-weight:600;}
  #dsh-bar-root .dsh-changes-tag{margin-left:auto;font-size:10px;font-weight:400;color:#9aa0a6;}
  #dsh-bar-root .dsh-change-row{display:grid;grid-template-columns:66px minmax(0,1fr);gap:8px;
    font-size:11px;line-height:1.6;color:#c9ccd1;padding:1px 0;}
  #dsh-bar-root .dsh-change-row .what{min-width:0;overflow-wrap:anywhere;}
  #dsh-bar-root .dsh-change-row .what .chg{display:block;}
  #dsh-bar-root[data-theme="light"] .dsh-change-row{color:#2a2d33;}
  #dsh-bar-root .dsh-change-row .when{color:#9aa0a6;font-variant-numeric:tabular-nums;}
  #dsh-bar-root[data-theme="light"] .dsh-change-row .when{color:#9096a0;}
  #dsh-bar-root .dsh-change-row .f{color:#9aa0a6;}
  #dsh-bar-root .dsh-change-row b{color:#5b8def;font-weight:600;}
  #dsh-bar-root[data-theme="light"] .dsh-change-row b{color:#3a83f7;}
  #dsh-bar-root .dsh-dash{all:unset;cursor:pointer;padding:1px 8px;border-radius:6px;color:inherit;opacity:.85;font-size:12px;display:inline-flex;align-items:center;gap:5px;}
  #dsh-bar-root .dsh-dash svg{width:16px;height:16px;flex:0 0 16px;}
  #dsh-bar-root .dsh-dash:hover{background:rgba(127,127,127,.16);opacity:1;}
  .dsh-turn-usage{display:inline-flex;align-items:center;gap:4px;margin-left:4px;padding:0 4px;
    color:#8b919a;background:transparent;border:0;
    font:12px/1.5 system-ui,"Segoe UI","Microsoft YaHei UI",sans-serif;cursor:pointer;user-select:none;}
  .dsh-turn-usage svg{width:13px;height:13px;opacity:.9;}
  .dsh-turn-usage[data-theme="light"]{color:#7c828b;}
  .dsh-turn-usage:hover{color:#dcdcdc;}
  .dsh-turn-usage[data-theme="light"]:hover{color:#1b1d21;}
  #dsh-usage-pop{position:fixed;z-index:2147483002;width:310px;display:none;
    background:#202020;color:#ececec;border:1px solid #333;border-radius:12px;padding:12px 14px;
    box-shadow:0 18px 50px rgba(0,0,0,.55);font:12px/1.5 system-ui,"Segoe UI","Microsoft YaHei UI",sans-serif;}
  #dsh-usage-pop[data-theme="light"]{background:#fff;color:#1b1d21;border-color:#e6e7ea;box-shadow:0 18px 50px rgba(15,20,30,.16);}
  #dsh-usage-pop .h{display:flex;align-items:center;margin-bottom:8px;}
  #dsh-usage-pop .h .t{font-weight:600;font-size:12.5px;}
  #dsh-usage-pop .h .tag{margin-left:auto;font-size:10.5px;color:#9aa0a6;border:1px solid #3a3a3a;border-radius:999px;padding:1px 7px;}
  #dsh-usage-pop[data-theme="light"] .h .tag{border-color:#e2e3e6;color:#6f757c;}
  #dsh-usage-pop .n{font-size:20px;font-weight:600;margin:2px 0 8px;}
  #dsh-usage-pop dl{display:grid;grid-template-columns:1fr auto;gap:5px 12px;margin:0;}
  #dsh-usage-pop dt{color:#9aa0a6;}
  #dsh-usage-pop dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;}
  #dsh-usage-pop .note{margin-top:9px;padding-top:8px;border-top:1px solid rgba(127,127,127,.22);color:#6f757c;font-size:10.5px;}
  #dsh-usage-pop[data-theme="light"] .note{color:#9096a0;border-color:#ececee;}
  `;

  function luminance(el) {
    const bg = getComputedStyle(el).backgroundColor;
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
    if (!m) return null;
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    return 0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3];
  }

  // Codex states the theme itself: <html data-theme="light|dark">. Use that instead of
  // guessing from background luminance (the guessing stays only as a fallback).
  function theme() {
    const declared = document.documentElement.dataset.theme;
    if (declared === 'light' || declared === 'dark') return declared;
    let node = editorEl();
    while (node) {
      const lum = luminance(node);
      if (lum !== null) return lum > 140 ? 'light' : 'dark';
      node = node.parentElement;
    }
    const fallback = luminance(document.body);
    if (fallback !== null) return fallback > 140 ? 'light' : 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function editorEl() {
    const list = Array.from(document.querySelectorAll('.ProseMirror[contenteditable="true"]'));
    return list.find((el) => el.getBoundingClientRect().width > 200) || null;
  }

  function fmtInt(n) {
    return typeof n === 'number' && isFinite(n) ? n.toLocaleString('en-US') : '—';
  }
  function fmtNum(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';   // 十亿：曾经显示成 1000M
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return n.toLocaleString('en-US');
  }
  // data_as_of 是 UTC（形如 2026-11-19T07:14:58Z），直接截取会显示成错误的本地时间
  function localHM(iso) {
    const date = new Date(iso);
    if (!date || Number.isNaN(date.getTime())) return null;
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  }

  // One line describing how much of the rolling quota this conversation burned.
  function quotaLine(q) {
    if (!q) return '—';
    // Only the per-conversation number belongs under this label. A brand-new conversation
    // comes back as "unavailable" until the server attributes it, and the account-wide
    // percentage must never be shown here as if it were this conversation's cost.
    const api = q.api || {};
    if (typeof api.weekly_percent === 'number') {
      return `${api.weekly_percent.toFixed(2)}%（占每周限额）${api.data_status === 'partial' ? ' · 数据未全' : ''}`;
    }
    if (api.data_status === 'unavailable') return '—（新对话，稍后才统计）';
    return '—（未取到）';
  }
  function fmtPct(n) {
    return typeof n === 'number' && isFinite(n) ? n.toFixed(1) + '%' : '—';
  }
  function fmtDur(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '—';
    if (ms < 1000) return Math.round(ms) + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1).replace(/\.0$/, '') + 's';
    return Math.floor(ms / 60000) + 'm' + (Math.round((ms % 60000) / 1000) || '');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  // A session can span days, so never show a bare clock.
  function fmtWhen(ts) {
    if (!ts) return '—';
    const date = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((dayStart(new Date()) - dayStart(date)) / 86400000);
    if (days === 0) return '今天 ' + clock;
    if (days === 1) return '昨天 ' + clock;
    const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    if (date.getFullYear() === new Date().getFullYear()) return `${md} ${clock}`;
    return `${date.getFullYear()}-${md} ${clock}`;
  }
  const CHANGE_FIELDS = { approval_policy: '审批', sandbox: '沙箱' };
  const CHANGE_VALUES = {
    'workspace-write': '工作区可写',
    'read-only': '只读',
    'danger-full-access': '无限制',
    'on-request': '按需批准',
    'on-failure': '失败后询问',
    never: '从不询问',
    untrusted: '仅可信命令',
    none: '—',
  };
  // Show the full model+effort state, but write the shared part only once:
  //   same model      -> "gpt-6-astra xhigh → medium"
  //   model switches  -> "gpt-6-astra medium → gpt-6.1-sol high"
  // Showing only the changed field drops the model and reads as if it were relative
  // to whatever model is current; repeating an unchanged model name is just noise.
  function describeEntry(entry) {
    const diffs = entry.changes || [];
    const show = (value) => {
      const key = String(value);
      return esc(CHANGE_VALUES[key] !== undefined ? CHANGE_VALUES[key] : key);
    };
    const parts = [];

    const modelTouched = diffs.some((d) => d.field === 'model' || d.field === 'effort');
    if (modelTouched) {
      const before = entry.before || {};
      const after = entry.after || {};
      const bModel = before.model || '';
      const aModel = after.model || '';
      const bEffort = before.effort || '';
      const aEffort = after.effort || '';
      if (bModel || aModel || bEffort || aEffort) {
        let text;
        if (bModel && aModel && bModel === aModel) {
          text = `${esc(bModel)} ${esc(bEffort)} → <b>${esc(aEffort)}</b>`;
        } else {
          const left = [bModel, bEffort].filter(Boolean).join(' ');
          const right = [aModel, aEffort].filter(Boolean).join(' ');
          text = `${esc(left)} → <b>${esc(right)}</b>`;
        }
        parts.push(`<span class="chg">${text}</span>`);
      } else {
        // older entries carry no full state; fall back to the changed fields only
        const model = diffs.find((d) => d.field === 'model');
        const effort = diffs.find((d) => d.field === 'effort');
        const from = [model ? model.from : null, effort ? effort.from : null].filter(Boolean).join(' ');
        const to = [model ? model.to : null, effort ? effort.to : null].filter(Boolean).join(' ');
        if (from && to) parts.push(`<span class="chg">${esc(from)} → <b>${esc(to)}</b></span>`);
      }
    }

    for (const diff of diffs) {
      if (diff.field === 'model' || diff.field === 'effort') continue;
      const field = CHANGE_FIELDS[diff.field] || diff.field;
      parts.push(`<span class="chg"><span class="f">${esc(field)}</span> ${show(diff.from)} → <b>${show(diff.to)}</b></span>`);
    }
    return parts.join('');
  }

  function ensure() {
    if (!document.body) return;
    if (!document.getElementById(STYLE)) {
      const style = document.createElement('style');
      style.id = STYLE;
      style.textContent = CSS;
      document.head ? document.head.appendChild(style) : document.documentElement.appendChild(style);
    }
    if (document.getElementById(ID)) return;
    const root = document.createElement('div');
    root.id = ID;
    root.dataset.theme = theme();
    root.style.opacity = '0';
    root.innerHTML = `
      <span id="dsh-health" class="dsh-health hide" title=""></span>
      <div class="dsh-items dsh-left">
      <button class="dsh-item" data-pop="turns">
        <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M14 1.9 4.6 13.2h6.1L8.9 22.1 19.4 10.8h-6.1z"/></svg>
        <span id="dsh-turns">—</span>
      </button>
      <span class="dsh-sep"></span>
      <button class="dsh-item" data-pop="tokens">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><ellipse cx="12" cy="5.4" rx="8.2" ry="3.2"/><path d="M3.8 5.4v7.2c0 1.8 3.7 3.2 8.2 3.2s8.2-1.4 8.2-3.2V5.4"/><path d="M3.8 12.6v6c0 1.8 3.7 3.2 8.2 3.2s8.2-1.4 8.2-3.2v-6"/></svg>
        <span id="dsh-tokens">—</span>
      </button>
      </div>
      <div class="dsh-items dsh-right">
      <button class="dsh-item" data-pop="quota" title="本会话占每周限额">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6.63 17.37A7.6 7.6 0 1 1 17.37 17.37" stroke-width="2.1" stroke-linecap="round"/><path d="M12 12.6 15.4 7.9" stroke-width="2.3" stroke-linecap="round"/><circle cx="12" cy="12.6" r="1.5" fill="currentColor" stroke="none"/></svg>
        <span id="dsh-quota"></span>
      </button>
      <span class="dsh-sep"></span>
      <button class="dsh-dash" data-dash="1" title="打开会话仪表盘" aria-label="打开会话仪表盘"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.2" y="4.4" width="17.6" height="15.2" rx="2.6"/><path d="M9.4 4.4v15.2"/></svg><span>仪表盘</span></button>
      </div>
      <div class="dsh-pop" id="dsh-pop-turns"></div>
      <div class="dsh-pop" id="dsh-pop-tokens"></div>
      <div class="dsh-pop" id="dsh-pop-quota"></div>
    `;
    document.body.appendChild(root);
    window.__dshBarSig = null;

    root.addEventListener('click', (event) => {
      const dash = event.target.closest('.dsh-dash');
      if (dash) {
        event.stopPropagation();
        openDashboard();
        return;
      }
      const btn = event.target.closest('.dsh-item');
      if (!btn) return;
      event.stopPropagation();
      const name = btn.dataset.pop;
      const pop = document.getElementById('dsh-pop-' + name);
      const open = pop.classList.contains('show');
      root.querySelectorAll('.dsh-pop').forEach((p) => p.classList.remove('show'));
      root.querySelectorAll('.dsh-item').forEach((b) => b.classList.remove('on'));
      if (!open) { pop.classList.add('show'); btn.classList.add('on'); }
    });
    document.addEventListener('click', (event) => {
      // 捕获阶段先于底栏自己的点击处理；若不管点击来源就清状态，
      // 后面判断"是否已展开"永远为 false，同一项就只能开不能关。
      if (root.contains(event.target)) return;
      root.querySelectorAll('.dsh-pop').forEach((p) => p.classList.remove('show'));
      root.querySelectorAll('.dsh-item').forEach((b) => b.classList.remove('on'));
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        root.querySelectorAll('.dsh-pop').forEach((p) => p.classList.remove('show'));
        root.querySelectorAll('.dsh-item').forEach((b) => b.classList.remove('on'));
        const usage = document.getElementById('dsh-usage-pop');
        if (usage) {
          usage.classList.remove('show');
          usage.style.display = 'none';
        }
      }
    });
    document.addEventListener('click', (event) => {
      const usage = document.getElementById('dsh-usage-pop');
      if (!usage || usage.style.display !== 'block') return;
      const target = event.target;
      if (target.closest && (target.closest('#dsh-usage-pop') || target.closest('.dsh-turn-usage'))) return;
      usage.classList.remove('show');
      usage.style.display = 'none';
    }, true);
    place();
  }



  // 缓存输入框元素：每帧重新 querySelectorAll 要 0.039ms，缓存后只要 0.0025ms
  let cachedEditor = null;
  let cachedComposer = null;
  let lastPlacedKey = '';
  let lastSpace = '';

  function resolveComposer() {
    if (cachedEditor && cachedEditor.isConnected) {
      return { editor: cachedEditor, composer: cachedComposer };
    }
    cachedEditor = editorEl();
    cachedComposer = cachedEditor
      ? (cachedEditor.closest('[class*="ComposerLayoutRoot"]') || cachedEditor.closest('form') || cachedEditor.parentElement)
      : null;
    return { editor: cachedEditor, composer: cachedComposer };
  }

  function place() {
    const root = document.getElementById(ID);
    if (!root) return;
    const { editor, composer } = resolveComposer();
    if (!editor) { root.style.display = 'none'; lastPlacedKey = ''; return; }
    const box = composer || editor;
    const r = box.getBoundingClientRect();
    if (!r || r.width < 100) { root.style.display = 'none'; lastPlacedKey = ''; return; }
    root.style.display = '';

    const height = root.getBoundingClientRect().height || 24;
    const room = window.innerHeight - r.bottom;
    const top = r.bottom + Math.max((room - height) / 2, 0);
    const topPx = Math.min(top, window.innerHeight - height - 1);

    // 位置/宽度/纵向位置都没变就不写样式——逐帧写会持续触发布局
    const key = `${r.left}|${r.width}|${Math.round(topPx)}`;
    if (key === lastPlacedKey) return;
    lastPlacedKey = key;

    // 横向用合成层位移，避免改 left 触发重排；不取整，消除亚像素抖动
    root.style.left = '0px';
    root.style.transform = `translate3d(${r.left}px, 0, 0)`;
    root.style.maxWidth = Math.max(r.width, 200) + 'px';
    root.style.width = `${r.width}px`;
    root.style.top = `${Math.round(topPx)}px`;

    // 占位高度只在真的变了才写，避免每帧改动文档根的样式
    const space = `${Math.round(height + 6)}px`;
    if (space !== lastSpace) {
      lastSpace = space;
      document.documentElement.style.setProperty('--dsh-bar-space', space);
    }
  }

  function openUsage(chipEl) {
    let pop = document.getElementById('dsh-usage-pop');
    if (!pop) {
      pop = document.createElement('div');
      pop.id = 'dsh-usage-pop';
      document.body.appendChild(pop);
    }
    const turnId = chipEl && chipEl.dataset ? chipEl.dataset.turn : null;
    const detail = (turnId && window.__dshTurnMap && window.__dshTurnMap[turnId]) || window.__dshUsage;
    if (!detail) return pop;
    const total = detail.tokens || {};
    pop.dataset.theme = theme();
    pop.innerHTML = `
      <div class="h"><span class="t">本轮用量</span><span class="tag">${turnId ? '第 ' + detail.index + ' 轮' : '最近完成的一轮'}</span></div>
      <div class="n">${fmtNum(total.total_tokens)} tok</div>
      <dl>
        <dt>输入（含缓存）</dt><dd>${fmtInt(total.input_tokens)}</dd>
        <dt>其中缓存命中</dt><dd>${fmtInt(total.cached_input_tokens)}（${fmtPct(detail.cache_hit_pct)}）</dd>
        <dt>输出</dt><dd>${fmtInt(total.output_tokens)}</dd>
        <dt>推理</dt><dd>${fmtInt(total.reasoning_output_tokens)}</dd>
        <dt>首 token / 耗时</dt><dd>${fmtDur(detail.ttft_ms)} / ${fmtDur(detail.duration_ms)}</dd>
        <dt>模型 / 工具用时</dt><dd>${fmtDur(detail.model_ms)} / ${fmtDur(detail.tool_ms)}</dd>
      </dl>
      <div class="note">${esc(detail.model || '')} · 第 ${detail.index} 轮</div>`;
    const anchor = chipEl;
    if (anchor) {
      pop.style.display = 'block';
      const r = anchor.getBoundingClientRect();
      const ph = pop.offsetHeight || 240;
      const pw = pop.offsetWidth || 310;
      pop.style.left = Math.round(Math.min(Math.max(r.left, 8), window.innerWidth - pw - 8)) + 'px';
      pop.style.top = Math.round(Math.max(r.top - ph - 8, 8)) + 'px';
    }
    return pop;
  }

  function toggleUsage(pop) {
    const open = pop.classList.contains('show');
    document.querySelectorAll('#dsh-usage-pop').forEach((p) => {
      p.classList.remove('show');
      p.style.display = 'none';
    });
    if (!open) {
      pop.classList.add('show');
      pop.style.display = 'block';
    }
  }

  function openDashboard() {
    // No "busy" flag here: a click right after a previous one used to be swallowed
    // silently, which reads as "the button stopped working". The injector serialises
    // clicks on its side, so every click is honoured (and toggles as expected).
    if (typeof window.__dshOpenDashboard === 'function') {
      window.__dshOpenDashboard().catch(() => {});
      return true;
    }
    return openDashboardLocal();
  }

  // Fallback when the injector is unreachable: only toggle between what already exists.
  // Never open a second tab from here — that is what made the button feel random.
  function openDashboardLocal() {
    const close = document.querySelector('button[aria-label="关闭会话仪表盘标签页"]');
    const tabs = Array.from(document.querySelectorAll('[role="tab"][aria-label="会话仪表盘"]'));
    const active = tabs.find((el) => el.getAttribute('aria-selected') === 'true');
    if (active && close) {
      close.click();
      return true;
    }
    const tab = tabs[0];
    if (tab) {
      tab.click();
      return true;
    }
    return false;
  }

  const USAGE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6"/><path d="M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6"/></svg>';

  function ensureTurnChips(turns) {
    document.querySelectorAll('.dsh-turn-usage-row').forEach((node) => node.remove());
    // Chips for other conversations stay behind when you switch (Codex keeps the previous
    // pane mounted) and keep showing that conversation's numbers. Only those are removed —
    // a chip from *this* conversation whose turn has scrolled out of the 20-turn window is
    // still correct, so it stays.
    const known = new Set((turns || []).map((t) => t.id).filter(Boolean));
    let activeConv = null;
    for (const turn of (turns || [])) {
      if (!turn.id) continue;
      const escaped = (window.CSS && CSS.escape) ? CSS.escape(turn.id) : turn.id;
      const el = document.querySelector(`[data-content-search-turn-key="${escaped}"]`);
      const holder = el && el.closest('[data-response-annotation-conversation]');
      if (holder) {
        activeConv = holder.getAttribute('data-response-annotation-conversation');
        break;
      }
    }
    document.querySelectorAll('.dsh-turn-usage').forEach((chip) => {
      if (known.has(chip.dataset.turn)) return;
      const holder = chip.closest('[data-response-annotation-conversation]');
      const chipConv = holder && holder.getAttribute('data-response-annotation-conversation');
      // no way to attribute the chip -> fall back to the strict rule
      if (activeConv && chipConv === activeConv) return;
      chip.remove();
    });
    if (!turns || !turns.length) return 0;
    let count = 0;
    for (const turn of turns) {
      if (!turn.id) continue;
      const id = (window.CSS && CSS.escape) ? CSS.escape(turn.id) : turn.id;
      const turnEl = document.querySelector(`[data-content-search-turn-key="${id}"]`);
      if (!turnEl) continue;
      const host = turnEl.querySelector('[data-local-conversation-final-assistant="true"]');
      if (!host) continue;
      const actionRow = host.querySelector('[class*="actionRow"]')
        || Array.from(host.querySelectorAll('div')).find((div) => div.querySelector('button[aria-label="复制"]'));
      if (!actionRow) continue;
      let chip = actionRow.querySelector('.dsh-turn-usage');
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'dsh-turn-usage';
        chip.addEventListener('click', (event) => {
          event.stopPropagation();
          toggleUsage(openUsage(chip));
        });
        actionRow.appendChild(chip);
      }
      // Timestamps are not always bare "9:59": older messages show "星期二18:16" or
      // "今天 9:59". Match any leaf that contains a clock, and re-place an existing chip
      // that a previous build parked in the wrong spot (it never moves by itself).
      const timeNode = Array.from(actionRow.querySelectorAll('span,time,div'))
        .find((el) => el.children.length === 0 && /\d{1,2}:\d{2}/.test((el.textContent || '').trim()));
      if (timeNode && timeNode.parentElement) {
        if (chip.parentElement !== timeNode.parentElement || chip.nextElementSibling !== timeNode) {
          timeNode.parentElement.insertBefore(chip, timeNode);
        }
      }
      chip.dataset.turn = turn.id;
      chip.dataset.theme = theme();
      chip.innerHTML = `${USAGE_ICON}<span>用量 ${fmtNum(turn.tokens.total_tokens)} tok</span>`;
      count += 1;
    }
    return count;
  }

  // debug hook: lets a probe push a payload without waiting for a real refresh
  window.__dshBarRender = (d) => render(d);

  function render(data) {
    const root = document.getElementById(ID);
    if (!root) return;
    const head = (data && data.summary) || {};
    const sig = JSON.stringify([
      theme(), data && data.ok, head.turns, head.steps,
      head.total && head.total.total_tokens, head.cache_hit_pct,
      head.last_turn && head.last_turn.duration_ms,
      (data && data.turns || []).map((t) => t.steps + ':' + t.running).join(','),
    ]);
    if (sig === window.__dshBarSig) return;
    window.__dshBarSig = sig;
    root.dataset.theme = theme();
    const on = (id) => document.getElementById(id);
    // 拿不到指标时不再整条隐藏——那样用户只看到"底栏没了"，没有任何线索。
    // 保留一个灰点和仪表盘入口，原因写进 title 和 health.json。
    if (!data || data.ok !== true) {
      const state = (data && data.health && data.health.state) || '';
      const dot = on('dsh-health');
      if (state === 'empty') {
        // 新对话还没开始：整条隐藏，和以前一样，不打扰
        root.style.opacity = '0';
        root.style.pointerEvents = 'none';
        if (dot) dot.classList.add('hide');
        return;
      }
      root.style.opacity = '1';
      root.style.pointerEvents = 'auto';
      const left = root.querySelector('.dsh-left');
      if (left) left.style.display = 'none';
      if (dot) {
        dot.classList.remove('hide');
        const why = (data && data.health && (data.health.message || data.health.state)) || '暂无数据';
        dot.title = '底栏异常：' + why;
      }
      return;
    }
    root.style.opacity = '1';
    root.style.pointerEvents = 'auto';
    const leftEl = root.querySelector('.dsh-left');
    if (leftEl) leftEl.style.display = '';
    {
      const h = data.health || {};
      const bad = h.state && h.state !== 'ok';
      const dot = on('dsh-health');
      if (dot) {
        dot.classList.toggle('hide', !bad);
        dot.classList.toggle('bad', !!bad);
        dot.title = bad ? ('底栏异常：' + (h.message || h.state)) : '';
      }
    }
    // Publish the resolved thread for the dashboard panel, which may otherwise receive
    // a "client-new-thread:..." placeholder from the host and render nothing.
    if (data.thread && data.thread.id) {
      try { localStorage.setItem('dsh.currentThread', data.thread.id); } catch (error) { /* ignore */ }
    }
    const s = data.summary;
    const last = s.last_completed || s.last_turn || {};
    window.__dshTurnMap = {};
    (data.turns || []).forEach((t) => {
      window.__dshTurnMap[t.id] = Object.assign({}, t, { model: data.thread && data.thread.model });
    });
    window.__dshTurns = data.turns || [];
    window.__dshUsage = s.last_completed
      ? Object.assign({}, s.last_completed, { model: data.thread && data.thread.model })
      : null;
    ensureTurnChips(window.__dshTurns);
    on('dsh-turns').innerHTML = `<b>${s.turns}</b> 轮 <b>${s.steps}</b> 步 · 最近 <b>${last.speed == null ? '—' : last.speed}</b> tok/s`;
    on('dsh-tokens').innerHTML = `<b>${fmtNum(s.total.total_tokens)}</b> tok · 缓存命中 <b>${fmtPct(s.cache_hit_pct)}</b>`;
    // Quota as its own bar item: the number is the only thing worth showing here; the
    // reason it is missing belongs in the popover, not in the bar.
    const apiQuota = (s.quota && s.quota.api) || {};
    const weekly = apiQuota.weekly_percent;
    const quotaEl = on('dsh-quota');
    if (quotaEl) {
      quotaEl.innerHTML = typeof weekly === 'number' ? `<b>${weekly.toFixed(2)}%</b>` : '';
      quotaEl.parentElement.title = typeof weekly === 'number'
        ? `本会话占每周限额 ${weekly.toFixed(2)}%`
        : '本会话额度：暂无数据';
    }

    const quotaPop = on('dsh-pop-quota');
    if (quotaPop) {
      // 5 小时窗口在本套餐恒为 null，没有就不占位
      const fiveHourRow = typeof apiQuota.five_hour_percent === 'number'
        ? `<dt>5 小时窗口</dt><dd>${fmtPct(apiQuota.five_hour_percent)}</dd>` : '';
      const asOf = localHM(apiQuota.data_as_of);
      const asOfText = asOf ? asOf + '（本地）' : '—';
      quotaPop.innerHTML = `
        <div class="dsh-pop-head"><span class="dsh-pop-title">额度</span><span class="dsh-tag">本会话</span></div>
        <div class="dsh-big"><span class="n">${typeof weekly === 'number' ? weekly.toFixed(2) + '%' : '—'}</span><span class="u">占每周限额</span></div>
        <dl class="dsh-kv">
          ${fiveHourRow}
          <dt>数据截至</dt><dd>${asOfText}</dd>
        </dl>
        <div class="dsh-note">额度按会话归属，取自 ChatGPT 用量接口，服务端聚合可能有几分钟延迟；尚未统计的会话只显示图标。</div>`;
    }


    const turnsPop = on('dsh-pop-turns');
    const recent = (data.turns || []).slice(-5).reverse();
    const sa = s.subagents && s.subagents.children ? s.subagents : null;
    const changes = (s.changes || []).filter((c) => (c.changes || []).length);
    turnsPop.innerHTML = `
      <div class="dsh-pop-head"><span class="dsh-pop-title">轮次与步数</span><span class="dsh-tag">本线程</span></div>
      <div class="dsh-big"><span class="n">${s.turns}</span><span class="u">轮</span><span class="n">${s.steps}</span><span class="u">步</span></div>
      <dl class="dsh-kv">
        <dt>最近一轮</dt><dd>${last.steps || '—'} 步 · ${fmtDur(last.duration_ms)}${last.speed == null ? '' : ` · ${last.speed} tok/s`}</dd>
        <dt>工具项</dt><dd>${last.item_count == null ? '—' : last.item_count + ' 项'}</dd>
        <dt>模型 / 工具用时</dt><dd>${fmtDur(last.model_ms)} / ${fmtDur(last.tool_ms)}</dd>
        <dt>首 token</dt><dd>${fmtDur(last.ttft_ms)}</dd>
        <dt>自动压缩</dt><dd>${s.compactions || 0} 次</dd>
        ${sa ? `<dt>子代理</dt><dd>${sa.children} 个 · ${fmtNum(sa.tokens)} tok${sa.share_pct != null ? `（占总消耗 ${sa.share_pct}%）` : ''}</dd>` : ''}
      </dl>
      <ul class="dsh-list">${recent.map((t) => `<li><span>第 ${t.index} 轮</span><span>${t.steps} 步 · ${fmtPct(t.cache_hit_pct)}</span><span>${t.running ? '进行中' : fmtDur(t.duration_ms)}</span></li>`).join('')}</ul>
      ${changes.length ? `<div class="dsh-changes">
        <div class="dsh-changes-head"><span>最近变更</span><span class="dsh-changes-tag">模型与运行设置</span></div>
        ${changes.map((c) => `<div class="dsh-change-row"><span class="when">${fmtWhen(c.ts)}</span><span class="what">${describeEntry(c)}</span></div>`).join('')}
      </div>` : ''}
      <div class="dsh-note">轮 = 用户发起的回合；步 = 模型调用次数。</div>`;

    const tokPop = on('dsh-pop-tokens');
    tokPop.innerHTML = `
      <div class="dsh-pop-head"><span class="dsh-pop-title">Token 用量</span><span class="dsh-tag">本线程累计</span></div>
      <div class="dsh-big"><span class="n">${fmtNum(s.total.total_tokens)}</span><span class="u">tok · 缓存命中 ${fmtPct(s.cache_hit_pct)}</span></div>
      <dl class="dsh-kv">
        <dt>累计输入（含缓存）</dt><dd>${fmtInt(s.total.input_tokens)}</dd>
        <dt>其中缓存命中</dt><dd>${fmtInt(s.total.cached_input_tokens)}</dd>
        <dt>累计输出</dt><dd>${fmtInt(s.total.output_tokens)}</dd>
        <dt>最近一轮</dt><dd>入 ${fmtInt(last.tokens && last.tokens.input_tokens)} · 出 ${fmtInt(last.tokens && last.tokens.output_tokens)}</dd>
      </dl>
      <div class="dsh-track"><div class="dsh-fill" style="width:${Math.min(s.cache_hit_pct || 0, 100)}%"></div></div>
      <div class="dsh-note">缓存命中 = 缓存输入 ÷ 输入；缓存已含在输入内，不重复相加。额度按会话归属，取自 ChatGPT 用量接口；新对话要等它统计完才有值。</div>`;
  }

  const kick = () => { if (typeof window.__dshBarKick === 'function') window.__dshBarKick(); };
  const onKey = (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    const target = event.target;
    if (target && target.closest && target.closest('.ProseMirror')) kick();
  };
  const onClick = (event) => {
    const target = event.target;
    if (target && target.closest && target.closest('[data-app-action-sidebar-thread-id]')) kick();
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('click', onClick, true);

  ensure();
  const observer = new MutationObserver(() => { ensure(); if (window.__dshTurns) ensureTurnChips(window.__dshTurns); });
  observer.observe(document.documentElement, { childList: true });
  const ensureTimer = setInterval(() => {
    ensure();
    if (window.__dshTurns) ensureTurnChips(window.__dshTurns);
  }, 1500);
  // 逐帧跟随：面板开关时输入框只是"位置"在变、宽度不变，
  // ResizeObserver 看不到这种变化，定时器又会整段丢帧（实测偏差最大 174px）。
  // 逐帧读一次 rect 只要 0.0025ms，且没变化时不写样式，开销可忽略。
  let placeFrame = 0;
  const followLoop = () => {
    place();
    placeFrame = requestAnimationFrame(followLoop);
  };
  placeFrame = requestAnimationFrame(followLoop);
  window.addEventListener('resize', place);

  window.__dshBar = { render, place, ensure };
  window.__dshBarTeardown = () => {
    clearInterval(ensureTimer);
    if (placeFrame) cancelAnimationFrame(placeFrame);
    observer.disconnect();
    window.removeEventListener('resize', place);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('click', onClick, true);
    const root = document.getElementById(ID);
    if (root) root.remove();
    ['dsh-usage-pop'].forEach((id) => {
      const node = document.getElementById(id);
      if (node) node.remove();
    });
    document.querySelectorAll('.dsh-turn-usage').forEach((node) => node.remove());
    // leave the composer's spacing as we found it
    document.documentElement.style.removeProperty('--dsh-bar-space');
    const style = document.getElementById(STYLE);
    if (style) style.remove();
    // drop every global we publish, otherwise a re-injection leaves the previous

    // instance's helpers alive on the page

    ['__dshBarInstalled', '__dshBar', '__dshBarBuild', '__dshBarSig', '__dshBarRender',

     '__dshBarSetLayout', '__dshBarKick', '__dshOpenDashboard',

     '__dshTurnMap', '__dshTurns', '__dshUsage'].forEach((key) => {

      try { delete window[key]; } catch (error) { /* non-configurable, ignore */ }

    });

  };
})();
