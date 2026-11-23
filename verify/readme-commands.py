"""P10：README 里的命令能跑通。

README 的「常用命令」块是用户最常照抄的地方，以前只检查了"引用的文件存在"。
这里补两件事：
1. 关键命令仍在清单里、且引用的脚本真实存在（文档和仓库不能脱节）；
2. 唯一没有被其它检查执行过的 `perf-baseline.ps1` 现场跑一遍（写临时文件，不污染 docs/PERF.md）。

    python verify/readme-commands.py
"""
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SYSTEM_ROOT = os.environ.get('SystemRoot', r'C:\Windows')
POWERSHELL = os.path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

# README 命令清单里必须有、且要能执行的命令（其余命令已由套件的其它检查执行）
EXPECTED = [
    ('./build.ps1', 'build.ps1'),
    ('./verify/run-all.ps1', 'verify/run-all.ps1'),
    ('node verify/test-resolver.js', 'verify/test-resolver.js'),
    ('python verify/test_server.py', 'verify/test_server.py'),
    ('./verify/perf-baseline.ps1', 'verify/perf-baseline.ps1'),
]


def readme_commands():
    text = (ROOT / 'README.md').read_text(encoding='utf-8')
    commands = []
    for block in re.findall(r'```[a-zA-Z]*\n(.*?)```', text, re.S):
        for line in block.splitlines():
            line = line.split('#', 1)[0].strip()
            if line.startswith('./') or line.startswith('node ') or line.startswith('python '):
                commands.append(line)
    return commands


def main():
    results = []

    def record(name, ok, detail=''):
        results.append((name, ok, detail))

    commands = readme_commands()
    problems = []
    for command, rel in EXPECTED:
        if command not in commands:
            problems.append(f'README 命令清单缺少 {command}')
        source = ROOT / rel
        if not source.is_file() or source.stat().st_size == 0:
            problems.append(f'{rel} 不存在或为空')
    record('README 命令清单与仓库一致', not problems, '; '.join(problems))

    # perf-baseline 是清单里唯一没被别的检查执行过的命令：现场跑一遍
    with tempfile.TemporaryDirectory() as tmp:
        out_file = pathlib.Path(tmp) / 'PERF.md'
        try:
            run = subprocess.run(
                [POWERSHELL, '-NoProfile', '-ExecutionPolicy', 'Bypass',
                 '-File', str(ROOT / 'verify' / 'perf-baseline.ps1'),
                 '-IdleSeconds', '1', '-OutFile', str(out_file)],
                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=180,
            )
        except subprocess.TimeoutExpired:
            run = None
        text = out_file.read_text(encoding='utf-8') if out_file.is_file() else ''
        sections = ['# 性能基线', '## 解析耗时', '## 底栏刷新', '## 内存']
        ok = (run is not None and run.returncode == 0
              and all(section in text for section in sections)
              and '| --- | ---: |' in text)
        detail = '超时' if run is None else f'rc={run.returncode} 缺节=' + str([s for s in sections if s not in text])
        record('perf-baseline.ps1 实跑并生成完整报告', ok, detail)

    failed = [row for row in results if not row[1]]
    print(f'  README 命令: {len(results) - len(failed)}/{len(results)} 通过')
    for name, _ok, detail in failed:
        print(f'    FAIL {name} — {detail}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
