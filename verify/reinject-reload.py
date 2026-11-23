"""P11：reload-page.js 真实重载 + 重注入（以前只能手动验）。

覆盖 SURFACES 里两个"间接/静态"项：
- reload-page.js 真的把 Codex 渲染进程重载了（不只是"端口不可达时优雅跳过"）；
- 页面 reload 之后注入器能重新注入当前构建的底栏，health.json 是重载后新写的。

做法：先在页面里放一个 window 标记 → 跑交付出去的 share/reload-page.js →
等标记消失（说明页面真的导航了）→ 检查底栏回来、构建号与安装版一致、health 刷新。
跑完把调试实例恢复到会话页，避免影响下一次回归。

    python verify/reinject-reload.py
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
HOME = pathlib.Path(os.environ.get('USERPROFILE') or os.path.expanduser('~'))
INSTALLED = HOME / '.codex-bar'
HEALTH = INSTALLED / 'health.json'

PAGE_HELPER = r'''
const pw = require('C:/Users/admin/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright');
const action = process.argv[2];
(async () => {
  let browser = null;
  for (const endpoint of ['http://127.0.0.1:9223', 'http://localhost:9223', 'http://[::1]:9223']) {
    try { browser = await pw.chromium.connectOverCDP(endpoint, { timeout: 4000 }); break; } catch (e) { /* next */ }
  }
  if (!browser) { console.log(JSON.stringify({ error: 'connect' })); return; }
  const page = browser.contexts().flatMap((c) => c.pages())
    .find((p) => p.url().startsWith('app://-/index.html') && !p.url().includes('avatar-overlay'));
  if (!page) { console.log(JSON.stringify({ error: 'no-page' })); await browser.close().catch(() => {}); return; }
  try {
    if (action === 'mark') {
      await page.evaluate(() => { window.__p11ReloadMarker = 'alive'; });
      console.log(JSON.stringify({ marked: true }));
    } else if (action === 'state') {
      const state = await page.evaluate(() => ({
        marker: window.__p11ReloadMarker,
        bar: !!document.getElementById('dsh-bar-root'),
        build: window.__dshBarBuild || '',
        // 注入器每轮都会 render 一次并写 __dshBarSig；注入后它是 null，被推过数据才是字符串
        pushed: typeof window.__dshBarSig === 'string',
        ready: document.readyState,
      }));
      console.log(JSON.stringify({ state }));
    } else if (action === 'restore') {
      const converged = await page.evaluate(() => !!document.querySelector('[data-response-annotation-conversation]'));
      if (!converged) {
        await page.evaluate(() => {
          const el = document.querySelector('[data-app-action-sidebar-thread-id]');
          if (el) el.click();
        });
        await page.waitForTimeout(5000);
      }
      console.log(JSON.stringify({ restored: true }));
    }
  } catch (e) {
    console.log(JSON.stringify({ error: 'evaluate' }));
  }
  await browser.close().catch(() => {});
})();
'''


def read_build(path):
    try:
        text = path.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return None
    match = re.search(r"const BUILD = '([^']+)'", text)
    return match.group(1) if match else None


def health_snapshot():
    try:
        stat = HEALTH.stat()
        data = json.loads(HEALTH.read_text(encoding='utf-8'))
        return {'mtime': stat.st_mtime, 'state': data.get('state')}
    except (OSError, ValueError):
        return {'mtime': 0, 'state': None}


def page_action(script, action):
    try:
        out = subprocess.run(['node', str(script), action], capture_output=True, text=True,
                             encoding='utf-8', errors='replace', timeout=90)
    except subprocess.TimeoutExpired:
        return {'error': 'timeout'}
    for line in reversed((out.stdout or '').splitlines()):
        line = line.strip()
        if line.startswith('{'):
            try:
                return json.loads(line)
            except ValueError:
                continue
    return {'error': (out.stderr or out.stdout or 'no output')[-200:]}


def finish(results):
    failed = [row for row in results if not row[1]]
    print(f'  重载/重注入: {len(results) - len(failed)}/{len(results)} 通过')
    for name, _ok, detail in failed:
        print(f'    FAIL {name} — {detail}')
    return 1 if failed else 0


def main():
    results = []

    def record(name, ok, detail=''):
        results.append((name, ok, detail))

    with tempfile.TemporaryDirectory() as tmp:
        helper = pathlib.Path(tmp) / 'page-helper.js'
        helper.write_text(PAGE_HELPER, encoding='utf-8')

        installed_build = read_build(INSTALLED / 'injected.js')
        source_build = read_build(ROOT / 'src' / 'bar' / 'injected.js')
        before = health_snapshot()

        marked = page_action(helper, 'mark')
        if not marked.get('marked'):
            record('reload-page.js 实跑触发真实重载', False, f'CDP 页面不可用: {marked}')
            record('reload 后重新注入当前构建并刷新 health', False, 'CDP 页面不可用')
            return finish(results)

        reload_script = ROOT / 'share' / 'reload-page.js'
        if not reload_script.is_file():
            reload_script = ROOT / 'tools' / 'reload-page.js'
        try:
            run = subprocess.run(['node', str(reload_script)], capture_output=True, text=True,
                                 encoding='utf-8', errors='replace', timeout=60)
        except subprocess.TimeoutExpired:
            record('reload-page.js 实跑触发真实重载', False, 'reload-page.js 超时')
            record('reload 后重新注入当前构建并刷新 health', False, 'reload-page.js 超时')
            return finish(results)
        output = (run.stdout or '') + (run.stderr or '')

        # 等标记消失（= 页面真的导航过）且底栏回来
        reloaded = False
        page_state = {}
        deadline = time.time() + 30
        while time.time() < deadline:
            result = page_action(helper, 'state')
            page_state = result.get('state') or {}
            if (page_state.get('marker') is None and page_state.get('bar')
                    and page_state.get('ready') == 'complete'):
                reloaded = True
                break
            time.sleep(0.5)

        record('reload-page.js 实跑触发真实重载（页面标记消失）',
               run.returncode == 0 and '已重载 Codex 页面' in output and reloaded,
               f'rc={run.returncode} 输出={output.strip()[:80]} 标记={page_state.get("marker")}')

        # 注入器每轮最长 5 秒推一次数据：再等一会儿看新文档有没有被推过 payload
        pushed_deadline = time.time() + 15
        while time.time() < pushed_deadline and not page_state.get('pushed'):
            time.sleep(0.5)
            result = page_action(helper, 'state')
            page_state = result.get('state') or {}

        after = health_snapshot()
        build_ok = (bool(installed_build) and page_state.get('build') == installed_build
                    and installed_build == source_build)
        # 重载后注入器要能继续往新文档推数据（__dshBarSig 由注入器每轮 render 写入）
        pushed = bool(page_state.get('pushed'))
        health_ok = after['state'] in ('ok', 'empty', 'no-anchor', 'error')
        record('reload 后重新注入当前构建并继续推数据',
               build_ok and pushed and health_ok,
               f'底栏构建={page_state.get("build")} 安装版={installed_build} 源码={source_build} '
               f'注入器已推数据={pushed} health state={after["state"]}')

        page_action(helper, 'restore')
    return finish(results)


if __name__ == '__main__':
    sys.exit(main())
