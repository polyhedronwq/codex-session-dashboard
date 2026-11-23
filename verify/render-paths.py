"""P11：render-paths.ps1 渲染边界。

历史事故（脚本头注释里记着）：两套替换逻辑不一致导致
- "兜底语句被一起替换"（`nodeExe = "node.exe"` 被替换成真实路径）
- "反斜杠被重复转义"（JS/JSON 里路径坏掉）

这里用临时目录 + 带空格的假路径跑一遍真实脚本，把这两类事故钉住。

    python verify/render-paths.py
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SYSTEM_ROOT = os.environ.get('SystemRoot', r'C:\Windows')
POWERSHELL = os.path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
SCRIPT = ROOT / 'tools' / 'render-paths.ps1'

NODE_PATH = r'C:\fake dir with space\bin\node.exe'
PYTHON_PATH = r'C:\fake dir with space\py\python.exe'

LAUNCH_VBS = '''Option Explicit
Dim sh, fso, dir, nodeExe
nodeExe = "{{node}}"
If Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"
' keep-me-comment
'''

INJECTOR_JS = 'const PYTHON = "{{python}}";\nconst NOTE = "keep-me";\n'


def run_render(bar, plugin):
    return subprocess.run(
        [POWERSHELL, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(SCRIPT),
         '-BarDir', str(bar), '-PluginDir', str(plugin), '-Node', NODE_PATH, '-Python', PYTHON_PATH],
        capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120,
    )


def main():
    results = []

    def record(name, ok, detail=''):
        results.append((name, ok, detail))

    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = pathlib.Path(tmp)
            bar = tmp_path / 'bar'
            plugin = tmp_path / 'plugin'
            bar.mkdir()
            plugin.mkdir()
            (bar / 'launch.vbs').write_text(LAUNCH_VBS, encoding='utf-8')
            (bar / 'injector-only.vbs').write_text(LAUNCH_VBS.replace('launch', 'injector-only'), encoding='utf-8')
            (bar / 'injector.js').write_text(INJECTOR_JS, encoding='utf-8')
            (plugin / '.mcp.json').write_text(json.dumps({
                'mcpServers': {'session-dashboard': {'command': '{{python}}', 'args': ['{{server}}']}}
            }, ensure_ascii=False), encoding='utf-8')
            (plugin / 'server.py').write_text('# placeholder', encoding='utf-8')

            run = run_render(bar, plugin)

            # ---- 断言 1：VBS 单反斜杠 + 空格路径 + 兜底语句不被替换 ----
            launch = (bar / 'launch.vbs').read_text(encoding='utf-8')
            injector_only = (bar / 'injector-only.vbs').read_text(encoding='utf-8')
            problems = []
            if run.returncode != 0:
                problems.append(f'render-paths 退出码 {run.returncode}: {((run.stderr or run.stdout) or "")[-200:]}')
            for name, text in (('launch.vbs', launch), ('injector-only.vbs', injector_only)):
                if '{{node}}' in text:
                    problems.append(f'{name} 仍有 {{{{node}}}}')
                if f'nodeExe = "{NODE_PATH}"' not in text.replace('\\\\', '\\'):
                    problems.append(f'{name} 没有渲染成给定路径')
                if 'nodeExe = "node.exe"' not in text:
                    problems.append(f'{name} 的兜底语句被替换了')
                if 'keep-me-comment' not in text:
                    problems.append(f'{name} 的其它内容被改动')
            record('render-paths：VBS 单反斜杠、空格路径、兜底语句保留', not problems, '; '.join(problems))

            # ---- 断言 2：JS/JSON 双反斜杠转义，JSON 能解析回原路径 ----
            problems = []
            js_text = (bar / 'injector.js').read_text(encoding='utf-8')
            if '{{python}}' in js_text:
                problems.append('injector.js 仍有 {{python}}')
            expected_js = PYTHON_PATH.replace('\\', '\\\\')
            if expected_js not in js_text:
                problems.append('injector.js 里的 python 路径没有正确转义（应为双反斜杠）')
            if 'keep-me' not in js_text:
                problems.append('injector.js 的其它内容被改动')
            mcp_text = (plugin / '.mcp.json').read_text(encoding='utf-8')
            if '{{' in mcp_text:
                problems.append('.mcp.json 仍有占位符')
            try:
                mcp = json.loads(mcp_text)
                conf = mcp['mcpServers']['session-dashboard']
                if conf['command'] != PYTHON_PATH:
                    problems.append(f"JSON 解析后的 python 路径不对: {conf['command']}")
                if conf['args'][0] != str(plugin / 'server.py'):
                    problems.append(f"JSON 解析后的 server 路径不对: {conf['args'][0]}")
            except (ValueError, KeyError, IndexError) as error:
                problems.append(f'.mcp.json 解析失败: {error}')
            record('render-paths：JS/JSON 双反斜杠转义与 JSON 可解析', not problems, '; '.join(problems))
    except Exception as error:  # noqa: BLE001 - 记失败继续
        record('render-paths 渲染边界', False, f'异常 {error.__class__.__name__}: {error}')

    failed = [row for row in results if not row[1]]
    print(f'  render-paths: {len(results) - len(failed)}/{len(results)} 通过')
    for name, _ok, detail in failed:
        print(f'    FAIL {name} — {detail}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
