"""P15：守护进程（supervisor.js）行为契约。

1. 子进程意外退出（非 0）→ 2 秒后自动重启（这里用假子进程：前两次退出 1，第三次退出 0）；
2. 子进程正常退出 0（单实例锁冲突 / 正常停止）→ 守护自己也退出，不无限拉起；
3. 看到 .supervisor-pause 标记 → 退出，不与 stop-bar / 测试打架。

用临时目录里的假子进程跑，不碰真实注入器与页面。

    python verify/supervisor-behaviour.py
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
SUPERVISOR = ROOT / 'src' / 'bar' / 'supervisor.js'

CHILD_FLaky = """const fs = require('fs');
const counter = process.env.P15_COUNTER;
let n = 0;
try { n = Number(fs.readFileSync(counter, 'utf8')) || 0; } catch (_) { n = 0; }
n += 1;
fs.writeFileSync(counter, String(n));
process.exit(n <= 2 ? 1 : 0);
"""

CHILD_ALWAYS_FAIL = """const fs = require('fs');
const counter = process.env.P15_COUNTER;
let n = 0;
try { n = Number(fs.readFileSync(counter, 'utf8')) || 0; } catch (_) { n = 0; }
fs.writeFileSync(counter, String(n + 1));
process.exit(1);
"""


def run_supervisor(child, pause, counter, timeout=25):
    env = dict(os.environ)
    env['DSH_SUPERVISOR_PAUSE'] = str(pause)
    env['DSH_SUPERVISOR_LOCK_PORT'] = '0'  # 测试用临时端口，避开真实守护的 9225
    env['P15_COUNTER'] = str(counter)
    try:
        proc = subprocess.run(['node', str(SUPERVISOR), str(child)], env=env,
                              capture_output=True, text=True, encoding='utf-8',
                              errors='replace', timeout=timeout)
        return proc.returncode, proc
    except subprocess.TimeoutExpired:
        return None, None


def read_counter(counter):
    try:
        return int(counter.read_text(encoding='utf-8').strip())
    except (OSError, ValueError):
        return 0


def main():
    results = []

    def record(name, ok, detail=''):
        results.append((name, ok, detail))

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = pathlib.Path(tmp)
        counter = tmp_path / 'counter.txt'

        # 1) 意外退出 → 自动重启；第 3 次退出 0 → 守护停止
        child = tmp_path / 'flaky.js'
        child.write_text(CHILD_FLaky, encoding='utf-8')
        code, proc = run_supervisor(child, tmp_path / 'no-pause', counter, timeout=30)
        calls = read_counter(counter)
        record('子进程意外退出后自动重启', code == 0 and calls >= 2,
               f'calls={calls} exit={code}')

        # 2) 暂停标记：子进程一直失败，但写了暂停标记后守护必须退出
        counter.write_text('0', encoding='utf-8')
        child2 = tmp_path / 'always-fail.js'
        child2.write_text(CHILD_ALWAYS_FAIL, encoding='utf-8')
        pause = tmp_path / 'pause'
        env = dict(os.environ)
        env['DSH_SUPERVISOR_PAUSE'] = str(pause)
        env['P15_COUNTER'] = str(counter)
        env['DSH_SUPERVISOR_LOCK_PORT'] = '0'
        proc = subprocess.Popen(['node', str(SUPERVISOR), str(child2)], env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(4)
        pause.write_text('', encoding='utf-8')
        try:
            proc.wait(timeout=10)
            exited = True
        except subprocess.TimeoutExpired:
            proc.kill()
            exited = False
        final_calls = read_counter(counter)
        record('看到暂停标记后守护退出', exited and final_calls >= 1,
               f'exited={exited} calls={final_calls}')

        # 3) 连续失败有上限，不会无限重启
        sup_text = SUPERVISOR.read_text(encoding='utf-8')
        record('守护有重启次数上限', 'MAX_RESTARTS' in sup_text and 'giving up' in sup_text)

    failed = [row for row in results if not row[1]]
    print(f'  守护进程契约: {len(results) - len(failed)}/{len(results)} 通过')
    for name, _ok, detail in failed:
        print(f'    FAIL {name} — {detail}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
