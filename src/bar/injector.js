const net = require('net');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  ({ chromium } = require('C:/Users/admin/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright'));
}
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HERE = __dirname;
// Chromium 可能只监听 IPv6 回环（重启后出现过只绑 [::1] 的情况），
// 所以候选多个地址，连上哪个用哪个。
const ENDPOINTS = (process.env.DSH_BAR_CDP
  ? [process.env.DSH_BAR_CDP]
  : ['http://127.0.0.1:9223', 'http://[::1]:9223', 'http://localhost:9223']);
let ENDPOINT = ENDPOINTS[0];
const PYTHON = process.env.DSH_BAR_PYTHON || '{{python}}';
const LOG = path.join(HERE, 'bar.log');
const INJECT_SRC = fs.readFileSync(path.join(HERE, 'injected.js'), 'utf8');
// 会话判定逻辑单独成文件，便于单测（曾经因为兜底规则写错，显示成了别的会话的数据）
const RESOLVER_SRC = fs.readFileSync(path.join(HERE, 'thread-resolver.js'), 'utf8');
const REFRESH_MS = 1000;
// 空闲时降频：没有新数据就 2 秒一探（原 5 秒，切会话后要等下一轮才发现，体感卡顿）
const IDLE_REFRESH_MS = 2000;
const IDLE_AFTER_MS = 30000;
// 冷启动预热：Codex 渲染进程刚起来时页面还没有任何锚点（实测 8-12 秒）。
// 这段时间判成"启动中"而不是故障，否则每次启动都先亮一个橙色故障点。
// 超时后仍然缺锚点，照样按故障报出来（不掩盖真坏的情况）。
const START_GRACE_MS = 20000;
// 构建号取自页面脚本，保证 health.json 和底栏报告的是同一版本
const BUILD = (INJECT_SRC.match(/const BUILD = '([^']+)'/) || [])[1] || 'unknown';

let kickResolver = null;
// 本次注入（含页面重载后重新注入）的时间点与"是否已就绪过一次"，
// 用于冷启动预热：只有还没成功判定过、且注入未满 START_GRACE_MS 时才算启动中。
let pageStartedAt = Date.now();
let pageReadySeen = false;
let lastKick = 0;
function kick() {
  const now = Date.now();
  if (now - lastKick < 200) return;
  lastKick = now;
  if (kickResolver) {
    const resolve = kickResolver;
    kickResolver = null;
    resolve();
  }
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 2 * 1024 * 1024) fs.writeFileSync(LOG, '');
    fs.appendFileSync(LOG, line + '\n');
  } catch (_) {}
}

// ---------------------------------------------------------------- 健康状态
// 出问题时底栏不再"静默消失"，而是显示一个灰点；诊断信息写入 health.json，
// 便于事后判断是端口、页面、锚点还是数据的问题。
const HEALTH_PATH = path.join(os.homedir(), '.codex-bar', 'health.json');
const health = {
  state: 'starting',
  message: '',
  since: Date.now(),
  lastOkAt: 0,
  thread: null,
  missingAnchors: [],
  // 底栏布局警告（Codex 新容器导致底栏只能让位/没空间时非空）
  layoutWarn: null,
  build: BUILD,
  writtenAt: 0,
};

function setHealth(state, message, extra) {
  const changed = state !== health.state || message !== health.message;
  if (changed) {
    health.state = state;
    health.message = message || '';
    health.since = Date.now();
    if (extra) Object.assign(health, extra);
    log('health ->', state, message ? '(' + message + ')' : '');
  }
  if (state === 'ok') health.lastOkAt = Date.now();
  // 主循环 1 秒一轮，若无条件写盘等于每天写 8 万多次。只在状态变化时写，
  // 另外每 60 秒补一次心跳，保证 lastOkAt 不会无限陈旧。
  const now = Date.now();
  if (!changed && now - health.writtenAt < 60000) return;
  health.writtenAt = now;
  try {
    fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true });
    fs.writeFileSync(HEALTH_PATH, JSON.stringify({
      state: health.state,
      message: health.message,
      since: new Date(health.since).toISOString(),
      lastOkAt: health.lastOkAt ? new Date(health.lastOkAt).toISOString() : null,
      thread: health.thread,
      missingAnchors: health.missingAnchors,
      layoutWarn: health.layoutWarn || null,
      build: health.build,
    }, null, 2));
  } catch (error) { /* 健康文件写不了也不能影响主循环 */ }
}

// 注入依赖的页面锚点；缺哪个就报哪个，避免"底栏不见了"这种无信息故障。
const PROBE_ANCHORS = () => {
  const checks = {
    '会话消息容器': '[data-response-annotation-conversation]',
    '输入框': '.ProseMirror[contenteditable="true"]',
    '输入区布局': '[class*="ComposerLayoutRoot"]',
    '侧边栏会话项': '[data-app-action-sidebar-thread-id]',
  };
  return Object.entries(checks)
    .filter(([, selector]) => !document.querySelector(selector))
    .map(([name]) => name);
};

// ---------------------------------------------------------------- metrics daemon
class Metrics {
  constructor() {
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.start();
  }
  start() {
    this.child = spawn(PYTHON, [path.join(HERE, 'bar_metrics.py')], { windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            pending.resolve(msg.data);
          }
        } catch (error) {
          log('metrics parse error', error.message);
        }
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (text) => log('metrics stderr', String(text).trim().slice(0, 300)));
    this.child.on('exit', (code) => {
      log('metrics exited', code);
      for (const [, pending] of this.pending) pending.reject(new Error('metrics exited'));
      this.pending.clear();
      setTimeout(() => this.start(), 2000);
    });
  }
  request(thread) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('metrics timeout'));
        }
      }, 8000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(JSON.stringify({ id, thread }) + '\n');
    });
  }
}

const metrics = new Metrics();

// ---------------------------------------------------------------- injection
// NOTE: READ_THREAD is serialised and evaluated inside the page, so it cannot close over
// anything defined out here — every helper it needs must live inside the function body.
// 在页面里收集节点可见性，再交给 decideThread 判定（判定逻辑有单测）
async function resolveThreadInPage(page, lastThread) {
  return page.evaluate(({ src, last }) => {
    const factory = new Function(src + '; return decideThread;');
    const decide = factory();
    const nodes = [...document.querySelectorAll('[data-response-annotation-conversation]')].map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        id: el.getAttribute('data-response-annotation-conversation') || '',
        visible: rect.width > 0 && rect.height > 0,
      };
    });
    return decide({ nodes, visibilityState: document.visibilityState, lastThread: last });
  }, { src: RESOLVER_SRC, last: lastThread || null });
}

async function injectInto(page) {
  try {
    pageStartedAt = Date.now();
    pageReadySeen = false;
    await page.addInitScript({ content: INJECT_SRC });
    // Each cleanup step runs on its own: one failure must not leave the install flag set,
    // otherwise the new script returns early and the page keeps running old code.
    await page.evaluate(() => {
      try {
        if (typeof window.__dshBarTeardown === 'function') window.__dshBarTeardown();
      } catch (error) { /* keep going */ }
    }).catch(() => {});
    await page.evaluate(() => {
      try { delete window.__dshBarInstalled; } catch (error) { /* keep going */ }
      ['dsh-bar-style', 'dsh-bar-root', 'dsh-usage-pop'].forEach((id) => {
        const node = document.getElementById(id);
        if (node) node.remove();
      });
    }).catch(() => {});
    await page.evaluate(INJECT_SRC);
    const build = await page.evaluate(() => window.__dshBarBuild || '(none)').catch(() => '(unreadable)');
    log('injected into', page.url(), 'build', build);
    return true;
  } catch (error) {
    log('inject failed', error.message);
    return false;
  }
}

async function serve(browser) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((p) => p.url() === 'app://-/index.html') || pages.find((p) => p.url().startsWith('app://-/index.html')) || pages[0];
  if (!page) throw new Error('no page');
  log('attached to', page.url());

  await injectInto(page);
  await page.exposeFunction('__dshBarKick', kick).catch(() => {});
  // Serialise dashboard clicks instead of dropping them: a dropped click looks like a
  // dead button. Each click queues behind the previous one and still toggles.
  let dashChain = Promise.resolve();
  await page.exposeFunction('__dshOpenDashboard', () => {
    const run = dashChain.then(() => openDashboardTab(browser, page)).catch((error) => {
      log('open dashboard failed', error.message);
      return false;
    });
    dashChain = run.catch(() => false);
    return run;
  }).catch(() => {});

// Opens / collapses / focuses the dashboard tab. Called through a serialised queue so
// that rapid clicks are all honoured instead of being dropped by a "busy" flag.
async function openDashboardTab(browser, page) {
  const all = browser.contexts().flatMap((context) => context.pages());
  const target = all.find((p) => p.url() === 'app://-/index.html')
    || all.find((p) => p.url().startsWith('app://-/index.html'))
    || page;

  // One synchronous DOM read decides everything. It is fast, and unlike a locator it
  // cannot miss a tab that is already there (a miss used to open a duplicate).
  const readState = () => target.evaluate(() => {
    const tabs = [...document.querySelectorAll('[role="tab"][aria-label="会话仪表盘"]')];
    return {
      // the toggle button reads "显示标签页" only while the strip is hidden
      stripHidden: !!document.querySelector('button[aria-label="显示标签页"]'),
      count: tabs.length,
      active: tabs.some((t) => t.getAttribute('aria-selected') === 'true'),
    };
  }).catch(() => null);

  // Show/hide the tab strip (Ctrl+Shift+B). Hiding it takes the dashboard off screen but
  // KEEPS its tab, so the next click brings it back instantly instead of rebuilding it.
  const toggleStrip = async () => {
    const cdp = await target.context().newCDPSession(target).catch(() => null);
    if (cdp) {
      const send = (type) => cdp.send('Input.dispatchKeyEvent', {
        type, modifiers: 10, key: 'B', code: 'KeyB',
        windowsVirtualKeyCode: 66, nativeVirtualKeyCode: 66,
      });
      await send('keyDown');
      await send('keyUp');
      return true;
    }
    return target.evaluate(() => {
      const b = document.querySelector('button[aria-label="显示标签页"], button[aria-label="隐藏标签页"]');
      if (!b) return false;
      b.click();
      return true;
    }).catch(() => false);
  };

  let state = await readState();

  if (state && state.stripHidden) {
    // The strip is hidden. Show it: the app re-selects whatever tab was last active.
    await toggleStrip();
    await target.waitForTimeout(350);
    state = await readState();
    if (state && state.active) {
      log('dashboard: shown again (tab was retained)');
      return true;
    }
    if (state && state.count > 0) {
      await target.evaluate(() => {
        const tab = document.querySelector('[role="tab"][aria-label="会话仪表盘"]');
        if (tab) tab.click();
      }).catch(() => {});
      log('dashboard: activated retained tab');
      return true;
    }
    // nothing was retained -> fall through and open a fresh one
  } else if (state && state.active) {
    // Showing -> hide, keeping the tab alive for an instant reopen.
    await toggleStrip();
    await target.waitForTimeout(350);
    const after = await readState();
    const ok = !!(after && after.stripHidden);
    log(ok ? 'dashboard: hidden (tab retained)' : 'dashboard: hide did not take effect');
    return ok;
  } else if (state && state.count > 0) {
    // Open on another tab -> bring it forward.
    await target.evaluate(() => {
      const tab = document.querySelector('[role="tab"][aria-label="会话仪表盘"]');
      if (tab) tab.click();
    }).catch(() => {});
    log('dashboard: activated existing tab');
    return true;
  }

  // Not open. Codex 26.1120 renders tabs as SPA pages: a blank「新标签页」shows the launcher
  // cards（会话仪表盘 / 侧边聊天 / 终端 / 新建页面）. The card is the fast, reliable entry;
  // the old「More tools」菜单只存在于旧构建，不能再拿它作为"启动页就绪"的判据。
  const stripHiddenNow = async () => target.evaluate(() => !!document.querySelector('button[aria-label="显示标签页"]'))
    .catch(() => false);
  const tabLabels = async () => target.evaluate(() => [...document.querySelectorAll('[role="tab"]')]
    .map((t) => (t.getAttribute('aria-label') || '') || (t.innerText || '').trim())
    .filter(Boolean)).catch(() => []);
  const launcherReady = async () => ((await target.locator('button:visible')
    .filter({ hasText: /^会话仪表盘$/ }).count().catch(() => 0)) > 0);
  const waitFor = async (check, timeoutMs, stepMs = 100) => {
    for (let waited = 0; waited < timeoutMs; waited += stepMs) {
      if (await check()) return true;
      await target.waitForTimeout(stepMs);
    }
    return false;
  };

  let createdTab = false;
  const stripWasHidden = await stripHiddenNow();
  // 标签栏收起时先展开，否则看不到「新标签页」、也点不到启动页卡片。
  if (stripWasHidden) {
    await toggleStrip();
    await target.waitForTimeout(350);
  }

  let cardsReady = await launcherReady();
  if (!cardsReady) {
    // 已经有「新标签页」标签（可能是上次失败留下的）→ 激活它，别重复开新的。
    if ((await tabLabels()).some((label) => label.includes('新标签页'))) {
      await target.evaluate(() => {
        const tab = [...document.querySelectorAll('[role="tab"]')]
          .find((t) => ((t.getAttribute('aria-label') || '') + (t.innerText || '')).includes('新标签页'));
        if (tab) tab.click();
      }).catch(() => {});
      cardsReady = await waitFor(launcherReady, 1500);
    }
    if (!cardsReady) {
      // 没有可用启动页：Ctrl+T 新建一个（页面聚焦时 CDP keydown 比键盘 API 可靠）
      const cdp = await target.context().newCDPSession(target).catch(() => null);
      if (cdp) {
        const press = async (type) => cdp.send('Input.dispatchKeyEvent', {
          type, modifiers: 2, key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, nativeVirtualKeyCode: 84,
        });
        await press('keyDown');
        await press('keyUp');
      } else {
        await target.keyboard.press('Control+T').catch(() => {});
      }
      createdTab = true;
      cardsReady = await waitFor(launcherReady, 5000);
    }
  }

  if (cardsReady) {
    await target.locator('button:visible').filter({ hasText: /^会话仪表盘$/ }).first()
      .click({ timeout: 3000 }).catch(() => {});
    if (await waitFor(async () => {
      const now = await readState();
      return !!(now && now.count > 0);
    }, 6000)) {
      log('dashboard: opened from launcher card');
      return true;
    }
  }

  // 旧构建兜底：More 菜单里的「会话仪表盘」菜单项（新构建没有这个菜单）
  const more = target.locator('button[aria-label="More tools and shortcut options"]:visible').first();
  if ((await more.count().catch(() => 0)) > 0) {
    await more.click({ timeout: 3000 }).catch(() => {});
    let item = null;
    for (let attempt = 0; attempt < 45 && !item; attempt += 1) {
      await target.waitForTimeout(60);
      const menu = target.locator('[role="menu"]:visible').first();
      if (await menu.count()) {
        const candidate = menu.getByText('会话仪表盘', { exact: true }).first();
        if (await candidate.count()) item = candidate;
      }
      if (!item) {
        // 菜单开了但按文案抓不到（图标/嵌套结构差异）：退而找可见菜单项里的同名文字
        const loose = target.locator('[role="menuitem"]:visible, [role="option"]:visible')
          .filter({ hasText: '会话仪表盘' }).first();
        if (await loose.count()) item = loose;
      }
    }
    if (item) {
      await item.click({ timeout: 3000 }).catch(() => {});
      log('dashboard: opened');
      return true;
    }
  }

  log('dashboard: no launcher card / menu item');
  await target.keyboard.press('Escape').catch(() => {});
  // 只关掉本次自己新建的空标签页，别动用户原有的新标签页；标签栏恢复原状态。
  if (createdTab) {
    await target.evaluate(() => {
      const close = document.querySelector('button[aria-label="关闭新标签页标签页"]');
      if (close) close.click();
    }).catch(() => {});
  }
  if (stripWasHidden && !(await stripHiddenNow())) {
    await toggleStrip();
  }
  return false;
}

  page.on('domcontentloaded', () => injectInto(page).catch(() => {}));
  page.on('load', () => injectInto(page).catch(() => {}));

  let stopped = false;
  let watchedPath = null;
  let watcher = null;
  let lastThread = null;
  let lastReason = null;
  let lastSig = null;
  let lastBusy = false;
  let emptyStreak = 0;
  let lastChangeAt = Date.now();
  let lastLayoutWarn = '';
  const stop = () => { stopped = true; };
  browser.on('disconnected', stop);
  page.on('close', stop);

  while (!stopped) {
    try {
      const missing = await page.evaluate(PROBE_ANCHORS).catch(() => []);
      // 底栏自己会让位；只有"让位后仍没空间"才带 warning，提醒布局变了。
      const layoutWarn = await page.evaluate(() => (typeof window.__dshBarLayoutWarn === 'string' ? window.__dshBarLayoutWarn : ''))
        .catch(() => '');
      if (layoutWarn !== lastLayoutWarn) {
        lastLayoutWarn = layoutWarn;
        if (layoutWarn) log('layout warning:', layoutWarn, '(底栏空间不足，诊断见 health.json)');
      }
      health.layoutWarn = layoutWarn || null;
      const resolved = await resolveThreadInPage(page, lastThread).catch(() => ({ id: null, reason: 'unknown' }));
      // 冷启动预热：页面还没渲染出锚点时是"加载中"，不是故障。
      const warmingUp = missing.length > 0 && !pageReadySeen && Date.now() - pageStartedAt < START_GRACE_MS;
      // 首页/新对话本来就没有会话容器：只要其它锚点还在、页面上也没有**可见的**消息，
      // 这就是"空对话"而不是故障。注意必须看可见性——Codex 会把其它会话的隐藏面板留在 DOM 里
      // （它们有消息节点但宽高为 0），只看"存在"会误判成"这不是空对话"。
      const looksLikeConversation = (resolved.reason === 'empty' && missing.length > 0)
        ? await page.evaluate(() => {
            const nodes = document.querySelectorAll('[data-local-conversation-final-assistant="true"], [data-content-search-turn-key]');
            for (const el of nodes) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) return true;
            }
            return false;
          }).catch(() => true)
        : false;
      const newChatLike = resolved.reason === 'empty'
        && missing.length > 0
        && missing.every((name) => name === '会话消息容器')
        && !looksLikeConversation;
      health.missingAnchors = newChatLike ? [] : missing;
      if (warmingUp) {
        setHealth('starting', '页面加载中');
      } else if (missing.length > 0 && !newChatLike) {
        setHealth('no-anchor', '缺少页面锚点: ' + missing.join('、'));
      }
      const thread = resolved.id;
      health.thread = thread || health.thread;
      // Log only when the resolved conversation changes, so the log stays short while still
      // answering "which conversation was the bar showing when it broke".
      if (thread !== lastThread) {
        log('thread ->', thread || '(none)');
        lastThread = thread;
        lastReason = null;
      }
      let data = { ok: false };
      // 读不到会话不立刻当成"空对话"：窗口切到后台时布局尺寸为 0，会误判。
      // 连续多次都读不到，才认为确实是新对话。
      // reason 已由 decideThread 区分了"新对话"和"窗口在后台"；
      // 有会话时下面的 data.ok 分支会把状态推回 ok。
      // 只有"锚点齐全"时才把空会话当成正常状态；
      // 锚点缺失是故障，不能被"看起来像空会话"覆盖掉。
      if (resolved.reason === 'empty' && (missing.length === 0 || newChatLike)) {
        setHealth('empty', '');
        pageReadySeen = true;
      }
      if (thread) {
        data = await metrics.request(thread).catch((error) => {
          log('metrics request failed', error.message);
          return { ok: false };
        });
        if (!data.ok && data.reason && data.reason !== lastReason) {
          log('metrics not ok:', data.reason, 'for', thread);
          lastReason = data.reason;
        }
        if (data.ok) {
          if (missing.length === 0) { setHealth('ok', ''); pageReadySeen = true; }
        } else {
          setHealth('error', data.reason || '指标不可用');
        }
        const file = data.ok && data.thread && data.thread.path;
        if (file && file !== watchedPath) {
          if (watchedPath) {
            fs.unwatchFile(watchedPath);
            if (watcher) { try { watcher.close(); } catch (_) { /* 已关闭 */ } }
            watcher = null;
          }
          watchedPath = file;
          // 事件驱动：有新行立刻唤醒。Windows 上 fs.watch 偶尔漏事件，
          // 所以额外挂一个 2 秒的低频兜底轮询，而不是原来的 200ms。
          try {
            watcher = fs.watch(file, () => kick());
            watcher.on('error', () => { watcher = null; });
          } catch (_) { watcher = null; }
          fs.watchFile(file, { interval: 2000 }, () => kick());
        }
      }
      data.health = {
        state: health.state,
        message: health.message,
        missingAnchors: health.missingAnchors,
      };
      // 判定忙闲：正在跑的一轮必须保持高频，否则长时间思考/长工具期间
      // 轮次步数没变化，会被误判成空闲降到 5 秒，底栏数字看起来像卡住。
      const running = !!(data.ok && data.summary && data.summary.running);
      const sig = data.ok ? (data.summary.turns + ':' + data.summary.steps) : 'nok';
      if (sig !== lastSig || running) { lastSig = sig; lastChangeAt = Date.now(); }
      lastBusy = running;
      await page.evaluate((payload) => {
        if (window.__dshBar) window.__dshBar.render(payload);
      }, data).catch(() => {});
    } catch (error) {
      log('loop error', error.message);
      break;
    }
    const idle = !lastBusy && Date.now() - lastChangeAt > IDLE_AFTER_MS;
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, idle ? IDLE_REFRESH_MS : REFRESH_MS)),
      new Promise((resolve) => { kickResolver = resolve; }),
    ]);
    kickResolver = null;
  }
  if (watchedPath) fs.unwatchFile(watchedPath);
  if (watcher) { try { watcher.close(); } catch (_) { /* 已关闭 */ } }
  log('detached');
}

async function main() {
  let lastConnectError = null;
  const lock = net.createServer();
  lock.once('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      log('another injector is already running; exiting');
      process.exit(0);
    }
    log('lock error', error.message);
    process.exit(1);
  });
  lock.listen(9224, '127.0.0.1', async () => {
    log('injector starting, endpoint', ENDPOINT);
    for (;;) {
      let browser = null;
      try {
        // 逐个候选地址尝试：Chromium 可能只监听 IPv6 回环
    for (const candidate of ENDPOINTS) {
      try {
        browser = await chromium.connectOverCDP(candidate, { timeout: 5000 });
        ENDPOINT = candidate;
        break;
      } catch (error) {
        lastConnectError = error;
      }
    }
    if (!browser) throw lastConnectError || new Error('no endpoint reachable');
        if (lastConnectError) { log('connected again'); lastConnectError = null; }
        await serve(browser);
      } catch (error) {
        const brief = String(error.message).split('\n')[0];
        if (brief !== lastConnectError) {
          lastConnectError = brief;
          log('connect failed:', brief);
        }
      }
      if (browser) {
        // Do not call browser.close(): on a CDP connection it would close the app.
        browser = null;
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  });
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
main();
