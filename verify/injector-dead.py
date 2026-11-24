"""P15：注入器死掉时，底栏必须"看起来不对"，而不是继续假装正常。

背景：用户实测"仪表盘按钮又点不动了"，查下来是 injector.js 进程已经不在了，
但页面残留的底栏还在显示旧数字——没有任何东西告诉用户底栏已经停止更新。

做法：暂停守护 → 杀掉注入器和守护 → 底栏应在 15 秒（判定阈值）后亮橙点、
标题说明"注入器可能已退出" → 删除暂停标记并拉起注入器 → 提示自动消失。

    python verify/injector-dead.py
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time

HOME = pathlib.Path(os.environ.get('USERPROFILE') or os.path.expanduser('~'))
INSTALLED = HOME / '.codex-bar'
HEALTH = INSTALLED / 'health.json'
PAUSE = INSTALLED / '.supervisor-pause'
WSCRIPT = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32', 'wscript.exe')
POWERSHELL = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32',
                          'WindowsPowerShell', 'v1.0', 'powershell.exe')

PAGE_HELPER = r'''
const pw = require('C:/Users/admin/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright');
const action = process.argv[2] || 'state';
(async () => {
  let browser = null;
  for (const endpoint of ['http://127.0.0.1:9223', 'http://localhost:9223']) {
    try { browser = await pw.chromium.connectOverCDP(endpoint, { timeout: 4000 }); break; } catch (e) { /* next */ }
  }
  if (!browser) { console.log(JSON.stringify({ error: 'connect' })); return; }
  const page = browser.contexts().flatMap((c) => c.pages())
    .find((p) => p.url().startsWith('app://-/index.html') && !p.url().includes('avatar-overlay'));
  if (!page) { console.log(JSON.stringify({ error: 'no-page' })); await browser.close().catch(() => {}); return; }
  if (action === 'open') {
    const clicked = await page.evaluate(() => {
      const el = document.querySelector('[data-app-action-sidebar-thread-id]');
      if (!el) return false;
      el.click();
      return true;
    });
    console.log(JSON.stringify({ clicked }));
    await browser.close().catch(() => {});
    return;
  }
  const state = await page.evaluate(() => {
    const bar = document.getElementById('dsh-bar-root');
    const dot = document.getElementById('dsh-health');
    const rect = bar ? bar.getBoundingClientRect() : { width: 0 };
    return {
      bar: { opacity: bar ? bar.style.opacity : null, width: Math.round(rect.width) },
      dot: dot ? { hidden: dot.classList.contains('hide'), bad: dot.classList.contains('bad'), title: dot.title } : null,
    };
  });
  console.log(JSON.stringify({ page: state }));
  await browser.close().catch(() => {});
})();
'''


def read_health():
    try:
        return json.loads(HEALTH.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def page_action(helper, action='state'):
    try:
        out = subprocess.run(['node', str(helper), action], capture_output=True, text=True,
                             encoding='utf-8', errors='replace', timeout=60)
    except subprocess.TimeoutExpired:
        return {'error': 'timeout'}
    for line in reversed((out.stdout or '').splitlines()):
        if line.strip().startswith('{'):
            try:
                data = json.loads(line)
                if 'page' in data:
                    return data['page']
            except ValueError:
                continue
    return {'error': (out.stderr or out.stdout or 'no output')[-200:]}


def page_state(helper):
    return page_action(helper, 'state')


def supervisor_count():
    # 按进程数判断会被 Volta shim（shim + 真实 node 各一条命令行）误导，
    # 直接看守护的单实例锁端口 9225 是否在监听。
    out = subprocess.run([POWERSHELL, '-NoProfile', '-Command',
                          "@(Get-NetTCPConnection -LocalPort 9225 -State Listen -ErrorAction SilentlyContinue).Count"],
                         capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30)
    try:
        return 1 if int((out.stdout or '0').strip().splitlines()[-1]) >= 1 else 0
    except (ValueError, IndexError):
        return -1


def process_count():
    out = subprocess.run([POWERSHELL, '-NoProfile', '-Command',
                          "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | "
                          "Where-Object { $_.CommandLine -match 'injector\\.js' }).Count"],
                         capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30)
    try:
        return int((out.stdout or '0').strip().splitlines()[-1])
    except (ValueError, IndexError):
        return -1


def kill_injector():
    PAUSE.write_text('', encoding='utf-8')
    subprocess.run([POWERSHELL, '-NoProfile', '-Command',
                    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | "
                    "Where-Object { $_.CommandLine -match 'supervisor\\.js|injector\\.js' } | "
                    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
                   capture_output=True, timeout=60)


def start_injector():
    # 走真实用户路径：拉守护进程，由它拉起注入器（而不是只起一个裸注入器）
    try:
        PAUSE.unlink()
    except OSError:
        pass
    if supervisor_count() > 0:
        return
    flags = 0x08000000 if os.name == 'nt' else 0  # CREATE_NO_WINDOW
    subprocess.Popen(['node', str(INSTALLED / 'supervisor.js')],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, creationflags=flags, close_fds=True)


def main():
    results = []

    def record(name, ok, detail=''):
        results.append((name, ok, detail))

    with tempfile.TemporaryDirectory() as tmp:
        helper = pathlib.Path(tmp) / 'page-state.js'
        helper.write_text(PAGE_HELPER, encoding='utf-8')

        first = page_state(helper)
        if 'error' in first:
            record('注入器退出后底栏亮橙点提示', False, f'CDP 不可用：{first.get("error")}')
            record('注入器恢复后提示自动消失', False, '前提失败')
            return finish(results)

        # 前提：底栏可见（在会话页）。若停在新对话，先点一个会话。
        if ((first.get('bar') or {}).get('opacity')) != '1':
            page_action(helper, 'open')
            deadline = time.time() + 25
            while time.time() < deadline:
                state = page_state(helper)
                if ((state.get('bar') or {}).get('opacity')) == '1':
                    break
                time.sleep(1)
            first = page_state(helper)
        if (first.get('bar') or {}).get('opacity') != '1':
            record('注入器退出后底栏亮橙点提示', False, '前提失败：底栏不可见（没有打开会话？）')
            record('注入器恢复后提示自动消失', False, '前提失败')
            return finish(results)

        try:
            kill_injector()
            deadline = time.time() + 22
            hint = None
            while time.time() < deadline:
                state = page_state(helper)
                dot = (state or {}).get('dot') or {}
                if dot.get('bad') and not dot.get('hidden') and '注入器' in (dot.get('title') or ''):
                    hint = dot
                    break
                time.sleep(1)
            record('注入器退出后底栏亮橙点提示',
                   hint is not None and hint.get('hidden') is False,
                   f'dot={hint} processes={process_count()}')
        finally:
            start_injector()

        recovered = None
        deadline = time.time() + 20
        while time.time() < deadline:
            if read_health().get('state') in ('ok', 'empty'):
                state = page_state(helper)
                dot = (state or {}).get('dot') or {}
                if not dot.get('bad') or dot.get('hidden'):
                    recovered = dot
                    break
            time.sleep(1)
        record('注入器恢复后提示自动消失', recovered is not None and process_count() == 1 and supervisor_count() == 1,
               f'dot={recovered} state={read_health().get("state")} sup={supervisor_count()}')
        try:
            PAUSE.unlink()
        except OSError:
            pass

    return finish(results)


def finish(results):
    failed = [row for row in results if not row[1]]
    print(f'  注入器退出提示: {len(results) - len(failed)}/{len(results)} 通过')
    for name, _ok, detail in failed:
        print(f'    FAIL {name} — {detail}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
