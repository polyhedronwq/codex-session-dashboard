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
const REFRESH_MS = 1000;
// 空闲时降频：没有新数据就 5 秒一探，避免空转
const IDLE_REFRESH_MS = 5000;
const IDLE_AFTER_MS = 30000;
// 构建号取自页面脚本，保证 health.json 和底栏报告的是同一版本
const BUILD = (INJECT_SRC.match(/const BUILD = '([^']+)'/) || [])[1] || 'unknown';

let kickResolver = null;
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
const READ_THREAD = () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // 1) The conversation actually on screen. Message nodes carry the real thread UUID.
  //    Codex keeps previously opened panes mounted, so several ids coexist here; only
  //    the active pane's nodes are laid out, which is what separates them.
  const scores = new Map();
  for (const el of document.querySelectorAll('[data-response-annotation-conversation]')) {
    const id = el.getAttribute('data-response-annotation-conversation') || '';
    if (!UUID_RE.test(id)) continue;
    const rect = el.getBoundingClientRect();
    if (el.offsetParent === null || rect.width <= 0 || rect.height <= 0) continue;
    scores.set(id, (scores.get(id) || 0) + 1);
  }
  let best = null;
  for (const [id, score] of scores) {
    if (!best || score > best.score) best = { id, score };
  }
  if (best) return best.id;

  // 1b) 窗口在后台时布局尺寸全是 0，此时"可见性"无法判断；退回到出现次数最多的
  //     合法 UUID——页面里挂着的会话副本都是同一个 id 时不会选错。
  const byCount = new Map();
  for (const el of document.querySelectorAll('[data-response-annotation-conversation]')) {
    const id = el.getAttribute('data-response-annotation-conversation') || '';
    if (!UUID_RE.test(id)) continue;
    byCount.set(id, (byCount.get(id) || 0) + 1);
  }
  let mostSeen = null;
  for (const [id, count] of byCount) {
    if (!mostSeen || count > mostSeen.count) mostSeen = { id, count };
  }
  if (mostSeen) return mostSeen.id;

  // 2) Fall back to the sidebar selection, but only when it holds a real UUID. A newly
  //    created conversation keeps a "client-new-thread:..." placeholder there, which
  //    never matches a row in the database, so trusting it hides the whole bar.
  const el = document.querySelector('[data-app-action-sidebar-thread-selected="true"]')
    || document.querySelector('[data-app-action-sidebar-thread-active="true"]');
  if (!el) return null;
  const raw = (el.getAttribute('data-app-action-sidebar-thread-id') || '').replace(/^local:/, '');
  return UUID_RE.test(raw) ? raw : null;
};

async function injectInto(page) {
  try {
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

  // Not open. If the launcher is already on screen (a blank tab is showing) use it as is;
  // only create a tab when there is none. Locators must be :visible — the app keeps the
  // other tabs' DOM around, and clicking a hidden tab's button silently does nothing.
  const more = target.locator('button[aria-label="More tools and shortcut options"]:visible').first();
  let ready = (await more.count()) > 0;
  if (!ready) {
    const plus = target.locator('button[aria-label="新标签页"]:visible').first();
    if (await plus.count()) {
      await plus.click({ timeout: 3000 }).catch(() => {});
    } else {
      const cdp = await target.context().newCDPSession(target).catch(() => null);
      if (cdp) {
        const press = async (type) => cdp.send('Input.dispatchKeyEvent', {
          type, modifiers: 2, key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, nativeVirtualKeyCode: 84,
        });
        await press('keyDown');
        await press('keyUp');
      } else {
        await target.keyboard.press('Control+T');
      }
    }
    for (let attempt = 0; attempt < 45 && !ready; attempt += 1) {
      await target.waitForTimeout(60);
      ready = (await more.count()) > 0;
    }
  }
  if (!ready) {
    log('dashboard: no new-tab page button');
    return false;
  }
  await more.click({ timeout: 3000 }).catch(() => {});

  let item = null;
  for (let attempt = 0; attempt < 45 && !item; attempt += 1) {
    await target.waitForTimeout(60);
    const menu = target.locator('[role="menu"]:visible').first();
    if (await menu.count()) {
      const candidate = menu.getByText('会话仪表盘', { exact: true }).first();
      if (await candidate.count()) item = candidate;
    }
  }
  if (!item) {
    log('dashboard: no menu item');
    return false;
  }
  await item.click({ timeout: 3000 });
  log('dashboard: opened');
  return true;
}

  page.on('domcontentloaded', () => injectInto(page).catch(() => {}));
  page.on('load', () => injectInto(page).catch(() => {}));

  let stopped = false;
  let watchedPath = null;
  let lastThread = null;
  let lastReason = null;
  let lastSig = null;
  let emptyStreak = 0;
  let lastChangeAt = Date.now();
  const stop = () => { stopped = true; };
  browser.on('disconnected', stop);
  page.on('close', stop);

  while (!stopped) {
    try {
      const missing = await page.evaluate(PROBE_ANCHORS).catch(() => []);
      health.missingAnchors = missing;
      if (missing.length > 0) {
        setHealth('no-anchor', '缺少页面锚点: ' + missing.join('、'));
      }
      const thread = await page.evaluate(READ_THREAD).catch(() => null);
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
      if (thread) {
        emptyStreak = 0;
      } else if (missing.length === 0) {
        emptyStreak += 1;
        if (emptyStreak >= 8) setHealth('empty', '');
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
          if (missing.length === 0) setHealth('ok', '');
        } else {
          setHealth('error', data.reason || '指标不可用');
        }
        const file = data.ok && data.thread && data.thread.path;
        if (file && file !== watchedPath) {
          if (watchedPath) fs.unwatchFile(watchedPath);
          watchedPath = file;
          fs.watchFile(file, { interval: 200 }, () => kick());
        }
      }
      data.health = {
        state: health.state,
        message: health.message,
        missingAnchors: health.missingAnchors,
      };
      // 轮次/步数没变化就认为空闲，逐步拉长轮询间隔
      const sig = data.ok ? (data.summary.turns + ':' + data.summary.steps) : 'nok';
      if (sig !== lastSig) { lastSig = sig; lastChangeAt = Date.now(); }
      await page.evaluate((payload) => {
        if (window.__dshBar) window.__dshBar.render(payload);
      }, data).catch(() => {});
    } catch (error) {
      log('loop error', error.message);
      break;
    }
    const idle = Date.now() - lastChangeAt > IDLE_AFTER_MS;
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, idle ? IDLE_REFRESH_MS : REFRESH_MS)),
      new Promise((resolve) => { kickResolver = resolve; }),
    ]);
    kickResolver = null;
  }
  if (watchedPath) fs.unwatchFile(watchedPath);
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
