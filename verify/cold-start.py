"""P14：冷启动预热（A1）——刚注入时缺锚点是"加载中"，不是故障；超时后仍要报故障。

做法：移除侧边栏会话项属性（可逆、不影响聊天）→ 杀掉注入器 → 重新启动注入器
（每次 injectInto 都会重置预热窗口）。此时其它锚点都在、只缺侧边栏：
- 预热期内必须 state=starting（底栏隐藏、不亮故障点）；
- 超过 START_GRACE_MS（20 秒）仍缺，必须变回 no-anchor（证明预热不掩盖真故障）；
- 恢复属性后必须回到 ok。

    python verify/cold-start.py
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
HOME = pathlib.Path(os.environ.get('USERPROFILE') or os.path.expanduser('~'))
INSTALLED = HOME / '.codex-bar'
HEALTH = INSTALLED / 'health.json'
WSCRIPT = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32', 'wscript.exe')
POWERSHELL = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32',
                          'WindowsPowerShell', 'v1.0', 'powershell.exe')
GRACE_SECONDS = 20

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
    if (action === 'remove-sidebar') {
      const saved = await page.evaluate(() => {
        const rows = [];
        for (const el of document.querySelectorAll('[data-app-action-sidebar-thread-id]')) {
          rows.push([el, el.getAttribute('data-app-action-sidebar-thread-id')]);
          el.removeAttribute('data-app-action-sidebar-thread-id');
        }
        window.__p14SidebarRows = rows;
        return rows.length;
      });
      console.log(JSON.stringify({ removed: saved }));
    } else if (action === 'restore-sidebar') {
      const restored = await page.evaluate(() => {
        let count = 0;
        for (const [el, value] of (window.__p14SidebarRows || [])) {
          if (value !== null) { el.setAttribute('data-app-action-sidebar-thread-id', value); count += 1; }
        }
        delete window.__p14SidebarRows;
        return count;
      });
      console.log(JSON.stringify({ restored }));
    } else if (action === 'state') {
      const state = await page.evaluate(() => {
        const bar = document.getElementById('dsh-bar-root');
        const dot = document.getElementById('dsh-health');
        const rect = bar ? bar.getBoundingClientRect() : { width: 0 };
        return {
          bar: { display: bar ? bar.style.display : null, opacity: bar ? bar.style.opacity : null, width: Math.round(rect.width) },
          dot: dot ? { hidden: dot.classList.contains('hide'), bad: dot.classList.contains('bad'), title: dot.title } : null,
        };
      });
      console.log(JSON.stringify({ page: state }));
    }
  } catch (e) {
    console.log(JSON.stringify({ error: 'evaluate' }));
  }
  await browser.close().catch(() => {});
})();
'''


def read_health():
    try:
        return json.loads(HEALTH.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def page_action(helper, action):
    try:
        out = subprocess.run(['node', str(helper), action], capture_output=True, text=True,
                             encoding='utf-8', errors='replace', timeout=60)
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


def stop_injector():
    subprocess.run([POWERSHELL, '-NoProfile', '-Command',
                    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | "
                    "Where-Object { $_.CommandLine -match 'injector\\.js' } | "
                    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
                   capture_output=True, timeout=60)


def start_injector():
    subprocess.run([WSCRIPT, '//nologo', str(INSTALLED / 'injector-only.vbs')],
                   capture_output=True, timeout=30)


def wait_state(states, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        now = read_health().get('state')
        if now in states:
            return now
        time.sleep(0.4)
    return read_health().get('state')


def main():
    results = []

    def record(name, ok, detail=''):
        results.append((name, ok, detail))

    with tempfile.TemporaryDirectory() as tmp:
        helper = pathlib.Path(tmp) / 'page-helper.js'
        helper.write_text(PAGE_HELPER, encoding='utf-8')

        removed = page_action(helper, 'remove-sidebar').get('removed')
        if not removed:
            record('冷启动预热期内不报故障', False, '无法移除侧边栏属性（CDP 不可用？）')
            record(f'超过 {GRACE_SECONDS} 秒仍缺锚点必须报故障', False, '前提失败')
            record('恢复属性后回到 ok', False, '前提失败')
            return finish(results)

        # 注入器重启后 injectInto 会重置预热窗口
        stop_injector()
        time.sleep(1.5)
        start_injector()

        started = wait_state({'starting'}, 10)
        page = page_action(helper, 'state').get('page') or {}
        bar = page.get('bar') or {}
        dot = page.get('dot') or {}
        record('冷启动预热期内不报故障',
               started == 'starting'
               and bar.get('opacity') == '0' and dot.get('hidden') is True,
               f'state={started} bar={bar} dot={dot}')

        # 预热期过完、锚点仍然缺失 → 必须报 no-anchor（预热不能把真故障藏起来）
        after_grace = wait_state({'no-anchor'}, GRACE_SECONDS + 12)
        record(f'超过 {GRACE_SECONDS} 秒仍缺锚点必须报故障',
               after_grace == 'no-anchor', f'state={after_grace}')

        page_action(helper, 'restore-sidebar')
        recovered = wait_state({'ok', 'empty'}, 20)
        record('恢复属性后回到 ok', recovered in ('ok', 'empty'), f'state={recovered}')

    return finish(results)


def finish(results):
    failed = [row for row in results if not row[1]]
    print(f'  冷启动预热: {len(results) - len(failed)}/{len(results)} 通过')
    for name, _ok, detail in failed:
        print(f'    FAIL {name} — {detail}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
