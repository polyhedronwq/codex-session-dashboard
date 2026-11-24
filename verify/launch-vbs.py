"""P10：launch.vbs 隔离实跑——验证它真的按顺序启动 Codex（带调试端口）和注入器（隐藏窗口），
但**不启动真实 Codex**：用一个只记录参数、不带任何窗口 API 依赖的小程序冒充
Codex 可执行文件与 node，两者的路径通过"路径模板渲染"同样的方式替换进临时副本。

    python verify/launch-vbs.py

做法：
1. 用 Add-Type 现场编译一个记录器 exe：把 argv/时间/pid 追加到 P10_RECORD 指定的文件，然后睡 4 秒。
2. 临时目录里生成 launch.vbs 副本：{{node}} → 记录器；codexExe 那一行 → 记录器副本（模拟"Codex 装在这里"）。
3. 用 wscript 跑它，收集两次记录，并在记录进程还活着时看主窗口句柄：
   Codex（窗口样式 1）应有可见窗口，注入器（样式 0）应没有。
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
SYSTEM_ROOT = os.environ.get('SystemRoot', r'C:\Windows')
WSCRIPT = os.path.join(SYSTEM_ROOT, 'System32', 'wscript.exe')
POWERSHELL = os.path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

RECORDER_CS = r'''
using System;
using System.IO;
using System.Text;
using System.Threading;
public class DshRecorder {
  static string Esc(string s) {
    var b = new StringBuilder();
    foreach (var c in s) {
      if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
      else if (c == '\n') { b.Append("\\n"); }
      else { b.Append(c); }
    }
    return b.ToString();
  }
  public static void Main(string[] args) {
    var path = Environment.GetEnvironmentVariable("P10_RECORD");
    if (string.IsNullOrEmpty(path)) { return; }
    var sb = new StringBuilder();
    for (int i = 0; i < args.Length; i++) {
      if (i > 0) { sb.Append(','); }
      sb.Append('"'); sb.Append(Esc(args[i])); sb.Append('"');
    }
    var span = DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    var line = "{\"at\":" + (long)span.TotalMilliseconds
             + ",\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id
             + ",\"args\":[" + sb.ToString() + "]}";
    for (int i = 0; i < 40; i++) {
      try { File.AppendAllText(path, line + "\n", new UTF8Encoding(false)); break; }
      catch { Thread.Sleep(50); }
    }
    Thread.Sleep(4000);
  }
}
'''

COMPILER_PS1 = r'''param([string]$CodePath, [string]$OutPath)
$ErrorActionPreference = 'Stop'
$code = Get-Content -Raw -Encoding UTF8 -LiteralPath $CodePath
Add-Type -TypeDefinition $code -OutputAssembly $OutPath -OutputType ConsoleApplication
'''

FAKE_CODEX_LINE = re.compile(r'(?m)^codexExe = .*$')


def run(cmd, **kwargs):
    return subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace', **kwargs)


def injector_process_count():
    out = run([POWERSHELL, '-NoProfile', '-Command',
               "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | "
               "Where-Object { $_.CommandLine -match 'injector\\.js' }).Count"])
    try:
        return int((out.stdout or '0').strip().splitlines()[-1])
    except (ValueError, IndexError):
        return -1


def main_checks():
    results = []

    def record(name, ok, detail=''):
        results.append((name, ok, detail))

    real_injectors = injector_process_count()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = pathlib.Path(tmp)
            # ---- 编译记录器 ----
            cs = tmp_path / 'recorder.cs'
            cs.write_text(RECORDER_CS, encoding='utf-8')
            compiler = tmp_path / 'compile.ps1'
            compiler.write_text(COMPILER_PS1, encoding='utf-8-sig')
            recorder = tmp_path / 'recorder.exe'
            built = run([POWERSHELL, '-NoProfile', '-ExecutionPolicy', 'Bypass',
                         '-File', str(compiler), '-CodePath', str(cs), '-OutPath', str(recorder)], timeout=180)
            if not recorder.is_file():
                record('launch.vbs 启动链路实跑', False,
                       '记录器编译失败: ' + ((built.stderr or built.stdout or '')[-300:]))
                return results

            fake_apps = tmp_path / 'fakeapps'
            fake_apps.mkdir()
            fake_codex = fake_apps / 'codex.exe'
            fake_codex.write_bytes(recorder.read_bytes())

            # ---- 生成临时 launch.vbs（只做"路径渲染"级别的替换）----
            source = (ROOT / 'src' / 'bar' / 'launch.vbs').read_text(encoding='utf-8')
            rendered = source.replace('{{node}}', str(recorder))
            rendered = FAKE_CODEX_LINE.sub(lambda _m: 'codexExe = "' + str(fake_codex) + '"', rendered, count=1)
            if '{{node}}' in rendered or '$env:USERPROFILE' in rendered:
                record('launch.vbs 启动链路实跑', False, '临时副本渲染失败')
                return results
            bar = tmp_path / 'bar'
            bar.mkdir()
            (bar / 'launch.vbs').write_text(rendered, encoding='utf-8')
            (bar / 'injector.js').write_text('// placeholder', encoding='utf-8')
            (bar / 'supervisor.js').write_text('// placeholder', encoding='utf-8')

            # ---- 跑 wscript ----
            record_file = tmp_path / 'record.jsonl'
            env = os.environ.copy()
            env['P10_RECORD'] = str(record_file)
            run([WSCRIPT, '//nologo', str(bar / 'launch.vbs')], env=env, timeout=30)

            entries = []
            deadline = time.time() + 15
            while time.time() < deadline:
                if record_file.is_file():
                    lines = [line for line in record_file.read_text(encoding='utf-8').splitlines() if line.strip()]
                    try:
                        entries = [json.loads(line) for line in lines]
                    except ValueError:
                        entries = []
                    if len(entries) >= 2:
                        break
                time.sleep(0.2)

            # 记录进程要在退出前看主窗口句柄（记录器自己会睡 4 秒）
            windows = {}
            for entry in entries[:2]:
                try:
                    out = run([POWERSHELL, '-NoProfile', '-Command',
                               f'$p = Get-Process -Id {int(entry["pid"])} -ErrorAction SilentlyContinue; '
                               'if ($p) { $p.MainWindowHandle } else { -1 }'], timeout=20)
                    windows[int(entry['pid'])] = int((out.stdout or '-1').strip().splitlines()[-1])
                except (ValueError, IndexError):
                    windows[int(entry['pid'])] = -1

            codex_entry = entries[0] if entries else {}
            injector_entry = entries[1] if len(entries) > 1 else {}
            codex_args = codex_entry.get('args') or []
            injector_args = injector_entry.get('args') or []

            # ---- 断言 1：顺序、参数 ----
            order_ok = (len(entries) >= 2
                        and '--remote-debugging-address=127.0.0.1' in codex_args
                        and '--remote-debugging-port=9223' in codex_args
                        and injector_args
                        and injector_args[-1].endswith('supervisor.js')
                        and codex_entry['at'] <= injector_entry['at'])
            record('launch.vbs 真的按顺序启动 Codex（调试端口）与守护进程',
                   order_ok, f'codex={codex_args} 守护={injector_args}')

            # ---- 断言 2：Codex 可见 / 注入器隐藏 / 间隔≥900ms / 未启动真实注入器 ----
            codex_handle = windows.get(codex_entry.get('pid')) if entries else None
            injector_handle = windows.get(injector_entry.get('pid')) if len(entries) > 1 else None
            gap = (injector_entry['at'] - codex_entry['at']) if len(entries) > 1 else 0
            after_injectors = injector_process_count()
            window_ok = (codex_handle is not None and codex_handle > 0
                         and injector_handle == 0
                         and gap >= 900
                         and after_injectors == real_injectors)
            record('launch.vbs：Codex 窗口可见、守护进程隐藏、间隔≥900ms 且不碰真实注入器',
                   window_ok,
                   f'codex窗口={codex_handle} 守护窗口={injector_handle} 间隔={gap}ms '
                   f'真实注入器 {real_injectors}→{after_injectors}')
    except Exception as error:  # noqa: BLE001 - 记失败继续
        record('launch.vbs 启动链路实跑', False, f'异常 {error.__class__.__name__}: {error}')
    return results


def main():
    results = main_checks()
    failed = [row for row in results if not row[1]]
    print(f'  launch.vbs 实跑: {len(results) - len(failed)}/{len(results)} 通过')
    for name, _ok, detail in failed:
        print(f'    FAIL {name} — {detail}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
