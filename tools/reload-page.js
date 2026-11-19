// 安装/升级后重载 Codex 渲染进程，让插件与面板服务重新建立连接。
// 不重载的话：底栏能恢复，但已打开的面板会停在"未能显示"。
// 用法：node reload-page.js [cdp 地址]
const chromiumPath = (() => {
  try { return require('playwright').chromium; } catch (_) { /* 走下面的兜底 */ }
  try { return require('C:/Users/admin/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright').chromium; } catch (_) { return null; }
})();

const CANDIDATES = process.argv[2]
  ? [process.argv[2]]
  : ['http://localhost:9223', 'http://127.0.0.1:9223', 'http://[::1]:9223'];

(async () => {
  if (!chromiumPath) {
    console.log('reload: 找不到 playwright，跳过重载');
    return;
  }
  for (const endpoint of CANDIDATES) {
    let browser = null;
    try {
      browser = await chromiumPath.connectOverCDP(endpoint, { timeout: 4000 });
      const page = browser.contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().startsWith('app://-/index.html'));
      if (!page) { console.log('reload: 没找到 Codex 页面'); continue; }
      await page.reload({ waitUntil: 'domcontentloaded' });
      console.log('reload: 已重载 Codex 页面');
      return;
    } catch (error) {
      // 换下一个地址
    } finally {
      if (browser) { try { await browser.close(); } catch (_) { /* 断开即可 */ } }
    }
  }
  console.log('reload: 连不上调试端口，跳过重载');
})();
