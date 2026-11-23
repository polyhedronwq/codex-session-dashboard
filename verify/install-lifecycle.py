"""P9：安装器生命周期（隔离 HOME，不碰真实安装/配置/快捷方式）。

靠 install.ps1 的 `-TestHome <目录>` 测试入口：所有产物写进临时目录，
不停止任何服务/进程、不碰调试端口，并走"Codex 未运行"的等待分支。

    python verify/install-lifecycle.py
"""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHARE = ROOT / 'share'
SYSTEM_ROOT = os.environ.get('SystemRoot', r'C:\Windows')
POWERSHELL = os.path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
HOME = pathlib.Path(os.environ.get('USERPROFILE') or os.path.expanduser('~'))
REAL_BAR = HOME / '.codex-bar'
REAL_CONFIG = HOME / '.codex' / 'config.toml'
# 注入器/面板运行期会改写的文件，不算"真实安装被改动"
RUNTIME_FILES = {'health.json', 'bar.log', 'quota-cache.json', '.install-manifest.json'}
MARKET_HEADER = '[marketplaces.codex-dashboard-local]'
PLUGIN_HEADER = '[plugins."session-dashboard@codex-dashboard-local"]'


def run_install(package, home):
    return subprocess.run(
        [POWERSHELL, '-NoProfile', '-ExecutionPolicy', 'Bypass',
         '-File', str(package / 'install.ps1'), '-Yes', '-TestHome', str(home)],
        capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=180,
        cwd=str(package),
    )


def real_snapshot():
    files = {}
    if REAL_BAR.is_dir():
        for item in REAL_BAR.rglob('*'):
            if not item.is_file() or item.name in RUNTIME_FILES:
                continue
            if any(part.startswith('.backup-') for part in item.parts):
                continue
            files[str(item.relative_to(REAL_BAR))] = hashlib.md5(item.read_bytes()).hexdigest()
    config = hashlib.md5(REAL_CONFIG.read_bytes()).hexdigest() if REAL_CONFIG.is_file() else None
    return files, config


def newest_zip():
    zips = sorted((ROOT / 'dist-package').glob('*.zip'), key=lambda p: p.stat().st_mtime)
    return zips[-1] if zips else None


def read_text(path):
    if not path.is_file():
        return ''
    return path.read_bytes().decode('utf-8-sig')


def main():
    results = []

    def record(name, ok, detail=''):
        results.append((name, ok, detail))

    baseline = real_snapshot()

    # ---------- 1 & 2：从发布包全新安装（隔离 HOME）；顺带验证"Codex 未运行"分支 ----------
    package_note = ''
    install_output = ''
    try:
        archive = newest_zip()
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = pathlib.Path(tmp)
            if archive is None:
                package = SHARE
                package_note = '（没有 dist-package zip，退回用 share/ 当包）'
            else:
                package = tmp_path / 'pkg'
                with zipfile.ZipFile(archive) as zf:
                    zf.extractall(package)
                package_note = f'（{archive.name}）'
            home = tmp_path / 'home'
            home.mkdir()
            out = run_install(package, home)
            install_output = (out.stdout or '') + (out.stderr or '')
            bar = home / '.codex-bar'
            config = home / '.codex' / 'config.toml'
            key_files = ['injected.js', 'injector.js', 'server.py', 'panel.html',
                         'bar_metrics.py', 'bar_metrics.py', 'launch.vbs', 'injector-only.vbs']
            missing = [name for name in key_files if not (bar / name).is_file()]
            market_server = bar / 'plugin-market' / 'plugins' / 'session-dashboard' / 'server.py'
            config_bytes = config.read_bytes() if config.is_file() else b''
            config_text = config_bytes.decode('utf-8-sig') if config_bytes else ''
            shortcuts = {name: (home / name / 'ChatGPT 仪表盘.lnk').is_file()
                         for name in ('Desktop', 'StartMenu')}
            manifest = {}
            manifest_file = bar / '.install-manifest.json'
            if manifest_file.is_file():
                try:
                    manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
                except ValueError:
                    manifest = {}
            config_ok = (
                config_bytes[:3] != b'\xef\xbb\xbf'
                and config_text.count(MARKET_HEADER) == 1
                and config_text.count(PLUGIN_HEADER) == 1
                and str(bar / 'plugin-market').replace('\\', '\\\\') in config_text
            )
            ok = (out.returncode == 0 and not missing and market_server.is_file()
                  and config_ok and all(shortcuts.values())
                  and isinstance(manifest.get('shortcuts'), list) and len(manifest.get('shortcuts') or []) == 2)
            record(f'全新安装：从发布包装进隔离 HOME {package_note}', ok,
                   f'rc={out.returncode} 缺文件={missing} 快捷方式={shortcuts} config={config_ok}')
    except Exception as error:  # noqa: BLE001 - 记失败继续跑
        record('全新安装：从发布包装进隔离 HOME', False, f'异常 {error.__class__.__name__}: {error}')

    need = ['Codex 未运行，跳过等待', '测试模式', '安装完成']
    record('Codex 未运行时的安装路径',
           all(text in install_output for text in need),
           '缺少: ' + (', '.join(text for text in need if text not in install_output) or '无'))

    # ---------- 3：已有 config.toml 内容不被破坏 ----------
    try:
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp) / 'home'
            (home / '.codex').mkdir(parents=True)
            original = ('model = "gpt-6"\n'
                        '[notify]\n'
                        'enabled = true\n'
                        'sound = "done.aiff"\n'
                        '# 用户自己加的注释\n')
            (home / '.codex' / 'config.toml').write_text(original, encoding='utf-8')
            out = run_install(SHARE, home)
            config_text = read_text(home / '.codex' / 'config.toml')
            kept = [line for line in original.splitlines() if line.strip() and line not in config_text]
            backups = list((home / '.codex-bar').glob('.backup-*/config.toml'))
            backup_ok = bool(backups) and backups[0].read_text(encoding='utf-8') == original
            ok = (out.returncode == 0 and not kept
                  and config_text.count(MARKET_HEADER) == 1 and backup_ok)
            record('已有 config.toml 内容不被破坏（并留有备份）', ok,
                   f'丢失行={kept} 备份={backup_ok}')
    except Exception as error:  # noqa: BLE001
        record('已有 config.toml 内容不被破坏（并留有备份）', False, f'异常 {error.__class__.__name__}: {error}')

    # ---------- 4：同一 HOME 连装两次，不重复注册 ----------
    try:
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp) / 'home'
            home.mkdir()
            first = run_install(SHARE, home)
            second = run_install(SHARE, home)
            config_text = read_text(home / '.codex' / 'config.toml')
            backups = list((home / '.codex-bar').glob('.backup-*'))
            ok = (first.returncode == 0 and second.returncode == 0
                  and config_text.count(MARKET_HEADER) == 1
                  and config_text.count(PLUGIN_HEADER) == 1
                  and len(backups) == 2
                  and (home / '.codex-bar' / 'injected.js').is_file())
            record('连装两次不重复注册（升级路径）', ok,
                   f'rc={first.returncode}/{second.returncode} 备份目录={len(backups)}')
    except Exception as error:  # noqa: BLE001
        record('连装两次不重复注册（升级路径）', False, f'异常 {error.__class__.__name__}: {error}')

    # ---------- 5：整个测试不碰真实安装与配置 ----------
    after = real_snapshot()
    changed = [name for name in set(baseline[0]) | set(after[0])
               if baseline[0].get(name) != after[0].get(name)]
    record('测试模式不碰真实安装目录与 ~/.codex(config.toml)',
           not changed and baseline[1] == after[1],
           f'被改动={changed[:5]} config变化={baseline[1] != after[1]}')

    failed = [row for row in results if not row[1]]
    print(f'  安装器生命周期: {len(results) - len(failed)}/{len(results)} 通过')
    for name, _ok, detail in failed:
        print(f'    FAIL {name} — {detail}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
