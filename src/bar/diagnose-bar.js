// Collects the browser-side facts for diagnose.ps1 and prints one JSON object.
// Everything here answers "what does the page look like right now", which the logs cannot.
const PW = 'C:/Users/admin/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright';

let chromium;
try {
  ({ chromium } = require(PW));
} catch (error) {
  console.log(JSON.stringify({ ok: false, reason: 'playwright not found: ' + error.message }));
  process.exit(0);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const bar = document.getElementById('dsh-bar-root');
  const map = window.__dshTurnMap || {};

  // which conversations are actually laid out on screen
  const scores = {};
  for (const el of document.querySelectorAll('[data-response-annotation-conversation]')) {
    const id = el.getAttribute('data-response-annotation-conversation');
    const rect = el.getBoundingClientRect();
    if (el.offsetParent === null || rect.width <= 0 || rect.height <= 0) continue;
    scores[id] = (scores[id] || 0) + 1;
  }
  const onScreen = Object.entries(scores).sort((a, b) => b[1] - a[1])[0] || null;

  const sidebar = document.querySelector('[data-app-action-sidebar-thread-selected="true"]')
    || document.querySelector('[data-app-action-sidebar-thread-active="true"]');
  const sidebarRaw = sidebar ? (sidebar.getAttribute('data-app-action-sidebar-thread-id') || '') : '';
  const sidebarId = sidebarRaw.replace(/^local:/, '');

  const chips = [...document.querySelectorAll('.dsh-turn-usage')].map((chip) => {
    const holder = chip.closest('[data-response-annotation-conversation]');
    return {
      turn: (chip.dataset.turn || '').slice(0, 13),
      known: !!map[chip.dataset.turn],
      conversation: holder ? holder.getAttribute('data-response-annotation-conversation').slice(0, 13) : null,
      text: (chip.innerText || '').replace(/\s+/g, ' ').trim(),
    };
  });

  const placeholders = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
    .map((el) => el.getAttribute('data-app-action-sidebar-thread-id') || '')
    .filter((id) => id.includes('client-new-thread'));

  return {
    build: window.__dshBarBuild || null,
    barPresent: !!bar,
    barOpacity: bar ? bar.style.opacity : null,
    barText: bar ? bar.innerText.replace(/\n/g, ' ').slice(0, 90) : null,
    theme: bar ? bar.dataset.theme : null,
    onScreen: onScreen ? { id: onScreen[0], nodes: onScreen[1] } : null,
    laidOutConversations: scores,
    sidebarSelectedRaw: sidebarRaw,
    sidebarSelectedId: sidebarId,
    sidebarIsPlaceholder: sidebarRaw.includes('client-new-thread'),
    sidebarIsUuid: UUID.test(sidebarId),
    placeholdersInSidebar: placeholders.length,
    storedThread: (() => { try { return localStorage.getItem('dsh.currentThread'); } catch (e) { return null; } })(),
    turnMapSize: Object.keys(map).length,
    chipCount: chips.length,
    chipsUnknown: chips.filter((c) => !c.known).length,
    chips,
  };
};

(async () => {
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  } catch (error) {
    console.log(JSON.stringify({ ok: false, reason: 'cannot connect to CDP 9223: ' + error.message.split('\n')[0] }));
    process.exit(0);
  }
  let result;
  try {
    const pages = browser.contexts().flatMap((c) => c.pages());
    const page = pages.find((p) => p.url() === 'app://-/index.html')
      || pages.find((p) => p.url().startsWith('app://-/index.html'));
    if (!page) {
      result = { ok: false, reason: 'no app://-/index.html page', pages: pages.map((p) => p.url()) };
    } else {
      await wait(400);
      result = { ok: true, page: await page.evaluate(PROBE), pageUrls: pages.map((p) => p.url()) };
    }
  } catch (error) {
    result = { ok: false, reason: 'probe failed: ' + error.message.split('\n')[0] };
  }
  console.log(JSON.stringify(result));
  process.exit(0);
})();
