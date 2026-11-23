"""注入器静态契约：这些行为没法在运行中安全复现（改端口绑定要重启 Codex），
但它们的实现一旦被删就会静默失效，所以用源码断言钉住。

    python verify/injector-contract.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
INJECTOR = (ROOT / 'src/bar/injector.js').read_text(encoding='utf-8')
LAUNCH = (ROOT / 'src/bar/launch.vbs').read_text(encoding='utf-8', errors='replace')
LAUNCHER = (ROOT / 'src/bar/injector-only.vbs').read_text(encoding='utf-8', errors='replace')

CHECKS = [
    ('三地址回退：IPv4', "http://127.0.0.1:9223" in INJECTOR),
    ('三地址回退：IPv6', "http://[::1]:9223" in INJECTOR),
    ('三地址回退：localhost', "http://localhost:9223" in INJECTOR),
    ('逐个地址重试（catch 后换下一个）', "for (const candidate of ENDPOINTS)" in INJECTOR),
    ('文件监听：事件驱动', 'fs.watch(' in INJECTOR),
    ('文件监听：低频兜底轮询', 'fs.watchFile(' in INJECTOR),
    ('单实例锁：提示语', 'another injector is already running' in INJECTOR),
    ('活跃刷新常量', 'REFRESH_MS = 1000' in INJECTOR),
    ('空闲刷新常量（2 秒）', 'IDLE_REFRESH_MS = 2000' in INJECTOR),
    ('空闲判定阈值', 'IDLE_AFTER_MS = 30000' in INJECTOR),
    ('health 状态：no-anchor', "setHealth('no-anchor'" in INJECTOR),
    ('health 状态：empty', "setHealth('empty'" in INJECTOR),
    ('启动参数：调试端口', '--remote-debugging-port=9223' in LAUNCH),
    ('启动参数：强制 IPv4', '--remote-debugging-address=127.0.0.1' in LAUNCH),
    ('injector-only.vbs 指向 injector.js', 'injector.js' in LAUNCHER),
    # P8：注入失败/连接失败不能静默放弃
    ('注入失败会记录日志', "log('inject failed'" in INJECTOR),
    ('页面载入后重新注入', "page.on('domcontentloaded', () => injectInto(page)" in INJECTOR),
    ('连接失败按退避循环重试', "log('connect failed:'" in INJECTOR and 'setTimeout(resolve, 800)' in INJECTOR),
    # P8：仪表盘标签页的打开/复用/聚焦/找不到入口四个分支都要留着
    ('仪表盘标签页：复用/聚焦/隐藏保留/找不到入口',
     all(marker in INJECTOR for marker in (
         'dashboard: activated existing tab',
         'dashboard: shown again (tab was retained)',
         'dashboard: hidden (tab retained)',
         'dashboard: no menu item',
     ))),
]


def main():
    failed = [name for name, ok in CHECKS if not ok]
    print(f'  注入器契约: {len(CHECKS) - len(failed)}/{len(CHECKS)} 通过')
    for name in failed:
        print(f'    FAIL {name}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
