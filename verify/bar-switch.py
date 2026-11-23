"""P12：切换会话后底栏不能消失（历史 bug：缓存了已隐藏的旧编辑器）。

现象：只有第一个会话有底栏，切到第二个就没了。
根因：resolveComposer 只看 cachedEditor.isConnected；Codex 切会话后旧编辑器仍 connected
但被隐藏（宽 0），于是 place() 一直按 0 宽算位置，把底栏 display 设成 none。

做法：真实点击侧边栏第 2/3 个会话，每次等 health=ok 后检查底栏 display/宽/透明度。

    python verify/bar-switch.py
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
HEALTH = HOME / '.codex-bar' / 'health.json'

PAGE_HELPER = r'''
const pw = require('C:/Users/admin/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright');
const action = process.argv[2];
const arg = process.argv[3];
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
    if (action === 'items') {
      const items = await page.evaluate(() => [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
        .map((el) => el.getAttribute('data-app-action-sidebar-thread-id')));
      console.log(JSON.stringify({ items }));
    } else if (action === 'click') {
      const clicked = await page.evaluate((i) => {
        const els = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')];
        if (!els[i]) return false;
        els[i].click();
        return true;
      }, Number(arg));
      console.log(JSON.stringify({ clicked }));
    } else if (action === 'state') {
      const state = await page.evaluate(() => {
        const bar = document.getElementById('dsh-bar-root');
        if (!bar) return { bar: null };
        const rect = bar.getBoundingClientRect();
        return {
          bar: {
            display: bar.style.display,
            opacity: bar.style.opacity,
            width: Math.round(rect.width),
            turns: (document.getElementById('dsh-turns') || {}).textContent || '',
          },
        };
      });
      console.log(JSON.stringify(state));
    }
  } catch (e) {
    console.log(JSON.stringify({ error: 'evaluate' }));
  }
  await browser.close().catch(() => {});
})();
'''


def read_state():
    try:
        return json.loads(HEALTH.read_text(encoding='utf-8')).get('state')
    except (OSError, ValueError):
        return None


def page_action(helper, action, arg=None):
    cmd = ['node', str(helper), action] + ([str(arg)] if arg is not None else [])
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=90)
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


def wait_visible_bar(helper, timeout=15):
    deadline = time.time() + timeout
    last = {}
    while time.time() < deadline:
        last = page_action(helper, 'state')
        bar = last.get('bar') or {}
        if (read_state() == 'ok' and bar.get('display') != 'none'
                and (bar.get('width') or 0) >= 200 and bar.get('opacity') == '1'):
            return True, bar
        time.sleep(0.5)
    return False, last.get('bar') or last


def main():
    results = []

    def record(name, ok, detail=''):
        results.append((name, ok, detail))

    with tempfile.TemporaryDirectory() as tmp:
        helper = pathlib.Path(tmp) / 'page-helper.js'
        helper.write_text(PAGE_HELPER, encoding='utf-8')

        items = page_action(helper, 'items').get('items') or []
        if len(items) < 3:
            record('切换会话后底栏仍在', False, f'侧边栏会话不足（{len(items)} 个），无法测切换')
            failed = [row for row in results if not row[1]]
            print(f'  会话切换: {len(results) - len(failed)}/{len(results)} 通过')
            for name, _ok, detail in failed:
                print(f'    FAIL {name} — {detail}')
            return 1
        if not wait_visible_bar(helper)[0]:
            record('切换会话后底栏仍在', False, '起始状态底栏就不可见（会话没打开或注入器没跑）')
        else:
            for idx, label in ((1, '第二个'), (2, '第三个')):
                clicked = page_action(helper, 'click', idx).get('clicked')
                visible, detail = wait_visible_bar(helper)
                record(f'切到{label}会话后底栏仍在', bool(clicked) and visible,
                       f'clicked={clicked} bar={json.dumps(detail, ensure_ascii=False)}')
            # 回到第一个会话，别把调试实例留在测试最后切换的位置
            page_action(helper, 'click', 0)
            wait_visible_bar(helper, timeout=10)

    failed = [row for row in results if not row[1]]
    print(f'  会话切换: {len(results) - len(failed)}/{len(results)} 通过')
    for name, _ok, detail in failed:
        print(f'    FAIL {name} — {detail}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
