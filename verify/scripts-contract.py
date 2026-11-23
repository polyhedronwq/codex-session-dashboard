"""P8：用户脚本与安装前置检查。

这些脚本平时只有双击才会跑到，回归套件以前完全没碰：
- start-bar.cmd → launch.vbs → Codex(调试端口) + injector.js 这条启动链不能断（静态）；
- reload-page.js 在调试端口不可达时必须优雅跳过（实跑死端口）；
- install.ps1 -CheckOnly 在缺 node/python 时必须点名缺什么，而不是只说"环境有问题"（净化环境实跑）；
- 安装器要创建桌面/开始菜单两个快捷方式，且指向 launch.vbs（静态）。

    python verify/scripts-contract.py
"""
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
NODE = shutil.which('node') or 'node'


def read(rel):
    return (ROOT / rel).read_text(encoding='utf-8', errors='replace')


def check_start_chain():
    start_bar = read('src/bar/start-bar.cmd')
    launch = read('src/bar/launch.vbs')
    injector_only = read('src/bar/injector-only.vbs')
    problems = []
    # 只看真正的调用，注释里提到 launch.vbs 不算（否则把调用改坏也测不出来）
    if '"%~dp0launch.vbs"' not in start_bar:
        problems.append('start-bar.cmd 不再启动 launch.vbs')
    for needle, name in (
        ('--remote-debugging-port=9223', 'launch.vbs 没有调试端口'),
        ('--remote-debugging-address=127.0.0.1', 'launch.vbs 没有强制 IPv4'),
        ('{{node}}', 'launch.vbs 没有 node 路径模板'),
        ('injector.js', 'launch.vbs 没有启动 injector'),
        (', 0, False', 'launch.vbs 的注入器不再是隐藏窗口'),
    ):
        if needle not in launch:
            problems.append(name)
    for needle, name in (
        ('{{node}}', 'injector-only.vbs 没有 node 路径模板'),
        ('injector.js', 'injector-only.vbs 没有指向 injector'),
        (', 0, False', 'injector-only.vbs 的注入器不再是隐藏窗口'),
    ):
        if needle not in injector_only:
            problems.append(name)
    return problems


def check_reload_dead_port():
    # 测交付出去的那份（share/），它是别人真正双击的脚本
    script = ROOT / 'share' / 'reload-page.js'
    if not script.exists():
        script = ROOT / 'tools' / 'reload-page.js'
    started = time.time()
    try:
        out = subprocess.run(
            [NODE, str(script), 'http://127.0.0.1:9'],
            capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=25,
        )
    except subprocess.TimeoutExpired:
        return ['reload-page.js 在端口不可达时没有退出（超时 25s）']
    elapsed = time.time() - started
    problems = []
    text = (out.stdout or '') + (out.stderr or '')
    if out.returncode != 0:
        problems.append(f'reload-page.js 退出码 {out.returncode}')
    if '连不上调试端口' not in text:
        problems.append('reload-page.js 没有给出"连不上调试端口"的提示')
    if re.search(r'Traceback|Unhandled|TypeError', text):
        problems.append('reload-page.js 抛了未处理异常')
    if elapsed > 20:
        problems.append(f'reload-page.js 花了 {elapsed:.1f}s，太慢')
    return problems


def check_installer_missing_deps():
    """净化环境跑 -CheckOnly：USERPROFILE/LOCALAPPDATA/ProgramFiles 指到空目录，PATH 只留系统目录。

    注意要在 PowerShell 里改 $env:*（从外部 env= 传 ProgramFiles 时进程里仍是真实值），
    脚本本身不做任何修改，只是它看到的环境是"什么都没有"。
    """
    system_root = os.environ.get('SystemRoot', r'C:\\Windows')
    powershell = os.path.join(system_root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    with tempfile.TemporaryDirectory() as fake_home:
        assignments = (
            "$env:USERPROFILE='{home}'; $env:LOCALAPPDATA='{home}\\LocalAppData'; "
            "$env:APPDATA='{home}\\AppData'; $env:ProgramFiles='{home}\\ProgramFiles'; "
            "$env:PATH='{system32}'; "
        ).format(home=fake_home, system32=os.path.join(system_root, 'System32'))
        command = assignments + "& '" + str(ROOT / 'share' / 'install.ps1') + "' -CheckOnly; exit $LASTEXITCODE"
        try:
            out = subprocess.run(
                [powershell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=90,
            )
        except subprocess.TimeoutExpired:
            return ['install.ps1 -CheckOnly 在缺依赖时超时（90s）']
    text = (out.stdout or '') + (out.stderr or '')
    problems = []
    if out.returncode != 0:
        problems.append(f'只读检查以退出码 {out.returncode} 结束（应为 0）')
    if not re.search(r'\[缺失\]\s*node', text):
        problems.append('没有点名缺 node')
    if not re.search(r'\[缺失\]\s*python', text):
        problems.append('没有点名缺 python')
    if '检查完成：缺少' not in text:
        problems.append('没有给出「检查完成：缺少 …」的结论')
    if '未做任何修改' not in text:
        problems.append('没有说明只读检查未做修改')
    return problems


def check_shortcuts():
    installer = read('share/install.ps1')
    problems = []
    if 'CreateShortcut' not in installer:
        problems.append('安装器不再创建快捷方式')
    for needle, name in (
        ('ChatGPT 仪表盘.lnk', '缺少快捷方式名 ChatGPT 仪表盘.lnk'),
        ('foreach ($dir in @($desktop, $startMenu))', '快捷方式没有同时建到桌面和开始菜单'),
        ('wscript.exe', '快捷方式不是用 wscript 启动'),
        ('$launch', '快捷方式没有指向 launch.vbs'),
        ('IconLocation', '快捷方式没有设置图标'),
    ):
        if needle not in installer:
            problems.append(name)
    return problems


CHECKS = [
    ('启动链路：start-bar.cmd → launch.vbs → 调试端口 + injector', check_start_chain),
    ('reload-page.js：端口不可达时优雅跳过', check_reload_dead_port),
    ('install.ps1 -CheckOnly：缺 node/python 时点名', check_installer_missing_deps),
    ('安装器：桌面 + 开始菜单快捷方式指向 launch.vbs', check_shortcuts),
]


def main():
    failed = 0
    for name, fn in CHECKS:
        try:
            problems = fn()
        except Exception as error:  # noqa: BLE001 - 报告后继续跑其它检查
            problems = [f'异常 {error.__class__.__name__}: {error}']
        if problems:
            failed += 1
            print(f'    FAIL {name}')
            for problem in problems:
                print(f'         - {problem}')
    print(f'  用户脚本/安装契约: {len(CHECKS) - failed}/{len(CHECKS)} 通过')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
