// P23：底栏锚点回归——多个 composer（交互提问卡片）+ 未知卡片/按钮条时不能压住输入区。
//
// 用系统 Edge/Chrome 起一个隔离的 headless 页面，加载 src/bar/injected.js 本体，
// 不碰真实 Codex：
//   1) 基准：底栏在主输入框下方、宽度/左边跟随主输入框
//   2) 主输入框上方再插一个 composer（模拟问题卡片）→ 仍锚主输入框，且不与卡片重叠
//   3) 底栏区域出现未知按钮条（未来 Codex 新容器）→ 自动让位到条下方
//   4) 让位后仍没空间 → clamp + 上报 __dshBarLayoutWarn / layout().noRoom
//
//   node verify/bar-anchor.js
//   DSH_INJECTED_SRC=<旧文件> node verify/bar-anchor.js   # 故障注入用
const fs = require('fs');
const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  ({ chromium } = require('C:/Users/admin/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright'));
}

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(process.env.DSH_INJECTED_SRC || path.join(ROOT, 'src/bar/injected.js'), 'utf8');
const VIEW = { width: 1400, height: 900 };

const HTML = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:#1b1d21;color:#e6e6e6;font:13px/1.4 sans-serif}
#main-composer{position:fixed;left:200px;top:600px;width:700px;height:200px;background:#282a30;border-radius:14px}
#main-editor{width:640px;height:100px;margin:20px;background:#1f2126;color:#ddd}
</style></head><body>
<div id="fake-qcard" class="ComposerLayoutRoot" style="position:fixed;left:200px;top:480px;width:490px;height:80px;z-index:5">
  <div class="ProseMirror" contenteditable="true" style="width:420px;height:60px"></div>
</div>
<div id="main-composer" class="ComposerLayoutRoot"><div id="main-editor" class="ProseMirror" contenteditable="true"></div></div>
</body></html>`;

const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });

async function launchBrowser() {
  for (const channel of ['msedge', 'chrome', undefined]) {
    try {
      const opts = { headless: true, timeout: 20000 };
      if (channel) opts.channel = channel;
      const browser = await chromium.launch(opts);
      return browser;
    } catch (_) { /* 换下一个 */ }
  }
  throw new Error('没有可用的 Chromium/Edge');
}

const frame2 = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

(async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: VIEW });
  await page.setContent(HTML);
  await page.addScriptTag({ content: SRC });
  await page.waitForTimeout(250);

  const snap = () => page.evaluate(() => {
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) };
    };
    const bar = document.getElementById('dsh-bar-root');
    // 主输入框固定用 id 取：页面里还会有测试插入的假 composer，不能按"第一个编辑器"找
    const main = document.getElementById('main-composer');
    const layout = window.__dshBar && typeof window.__dshBar.layout === 'function' ? window.__dshBar.layout() : null;
    return {
      bar: rect(bar),
      main: rect(main),
      layout,
      warn: window.__dshBarLayoutWarn,
      fakeQcard: rect(document.getElementById('fake-qcard')),
      strip: rect(document.getElementById('fake-strip')),
    };
  });
  const place = async () => { await page.evaluate(() => window.__dshBar && window.__dshBar.place && window.__dshBar.place()); await frame2(page); };

  const addQcard = () => page.evaluate(() => {
    const mainEditor = [...document.querySelectorAll('.ProseMirror[contenteditable="true"]')].find((el) => el.getBoundingClientRect().width > 200);
    const main = mainEditor.closest('[class*="ComposerLayoutRoot"]');
    const mr = main.getBoundingClientRect();
    const holder = document.createElement('div');
    holder.id = 'fake-qcard';
    holder.className = 'ComposerLayoutRoot';
    holder.style.cssText = `position:fixed;left:${mr.left}px;top:${mr.top - 120}px;width:${mr.width * 0.7}px;height:80px;z-index:5;`;
    const ed = document.createElement('div');
    ed.className = 'ProseMirror';
    ed.setAttribute('contenteditable', 'true');
    ed.style.cssText = `width:${mr.width * 0.6}px;height:60px;`;
    holder.appendChild(ed);
    // DOM 顺序插到最前面：旧逻辑取"第一个编辑器"就会锚到这张卡片
    document.body.insertBefore(holder, document.body.firstChild);
  });

  const addStrip = (top) => page.evaluate((topPx) => {
    const mainEditor = [...document.querySelectorAll('.ProseMirror[contenteditable="true"]')].find((el) => el.getBoundingClientRect().width > 200);
    const main = mainEditor.closest('[class*="ComposerLayoutRoot"]');
    const mr = main.getBoundingClientRect();
    const strip = document.createElement('div');
    strip.id = 'fake-strip';
    strip.style.cssText = `position:fixed;left:${mr.left}px;top:${topPx}px;width:${mr.width}px;height:20px;z-index:6`;
    const btn = document.createElement('button');
    btn.textContent = '权限提示条';
    btn.style.cssText = 'width:100%;height:100%';
    strip.appendChild(btn);
    document.body.appendChild(strip);
  }, top);

  const cleanup = () => page.evaluate(() => {
    ['fake-qcard', 'fake-strip'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
  });

  try {
    // ---- 启动即存在"问题卡片"：旧逻辑会把它当主 composer，底栏错位到主输入框上 ----
    let s = await snap();
    record('问题卡片（启动即存在）：仍锚主输入框（不跟卡片）',
      !!(s.bar && s.main && s.fakeQcard && s.layout) && s.bar.top >= s.main.bottom
      && Math.abs(s.layout.width - Math.round(s.main.width)) <= 2
      && s.bar.top >= s.fakeQcard.bottom && s.layout.composerBottom === Math.round(s.main.bottom),
      JSON.stringify(s));

    // ---- 移除卡片后回到基准 ----
    await cleanup();
    await frame2(page);
    await place();
    s = await snap();
    record('基准：底栏在主输入框下方',
      !!(s.bar && s.main && s.layout) && s.bar.top >= s.main.bottom
      && Math.abs(s.layout.left - Math.round(s.main.left)) <= 1
      && Math.abs(s.layout.width - Math.round(s.main.width)) <= 2,
      JSON.stringify(s));

    // ---- 运行中再插入问题卡片：位置不能被卡片带跑 ----
    await addQcard();
    await frame2(page);
    await place();
    s = await snap();
    record('运行中插入问题卡片：仍锚主输入框',
      !!(s.bar && s.main && s.fakeQcard && s.layout) && s.bar.top >= s.main.bottom
      && Math.abs(s.layout.width - Math.round(s.main.width)) <= 2,
      JSON.stringify(s));

    await cleanup();
    await frame2(page);
    await place();

    // ---- 未知按钮条压在底栏区域：应自动让位 ----
    await addStrip(s.main.bottom + 30);   // 默认底栏 top 约 main.bottom + 38，这条会压在它身上
    await frame2(page);
    await place();
    s = await snap();
    const noOverlap = !!(s.bar && s.strip) && s.bar.top >= s.strip.bottom + 1;
    record('未知按钮条：底栏自动让位到条下方', noOverlap && s.layout && s.layout.adjusted === true,
      JSON.stringify(s));

    await cleanup();
    await frame2(page);
    await place();

    // ---- 让位后仍没空间：clamp + 上报 ----
    s = await snap();
    await addStrip(s.main.bottom + 34);
    await frame2(page);
    // 把条加高到窗口底部，让"让位后没空间"必然发生
    await page.evaluate(() => {
      const strip = document.getElementById('fake-strip');
      const main = [...document.querySelectorAll('.ProseMirror[contenteditable="true"]')].find((el) => el.getBoundingClientRect().width > 200).closest('[class*="ComposerLayoutRoot"]');
      const bottom = main.getBoundingClientRect().bottom;
      strip.style.top = (bottom + 2) + 'px';
      strip.style.height = (window.innerHeight - (bottom + 2)) + 'px';
    });
    await frame2(page);
    await place();
    s = await snap();
    record('没空间：clamp 并写 layoutWarn/noRoom',
      s.layout && s.layout.noRoom === true && s.layout.warn === 'no-room' && s.warn === 'no-room',
      JSON.stringify(s));

    await cleanup();
    await frame2(page);
    await place();
    s = await snap();
    record('清理后警告恢复为空', s.warn === '' && !!(s.bar && s.main) && s.bar.top >= s.main.bottom, JSON.stringify(s));
  } finally {
    await browser.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`  底栏锚点: ${results.length - failed.length}/${results.length} 通过`);
  for (const r of failed) console.log(`    FAIL ${r.name} — ${r.detail}`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.log('  底栏锚点异常:', error && error.message);
  process.exit(1);
});
