"""P2：服务端协议分支的断言（spawn 真实 MCP 服务）。

覆盖 SURFACES.md 里"服务端"缺的 7 项里可测的部分：
ping / resources/templates/list / 未知方法 / 未知工具 / 资源 uri 不匹配 / 非法 JSON / initialize 字段。

    python verify/server-branches.py [安装目录]
"""
import json
import pathlib
import queue
import subprocess
import sys
import threading
import time

BASE = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else pathlib.Path.home() / '.codex-bar')
RESULTS = []


def record(name, ok, detail=''):
    RESULTS.append((name, ok, detail))


class Client:
    def __init__(self, conf):
        self.proc = subprocess.Popen(
            [conf['command'], *conf['args']], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding='utf-8', bufsize=1)
        self.lines = queue.Queue()
        threading.Thread(target=lambda: [self.lines.put(l) for l in self.proc.stdout], daemon=True).start()

    def send_raw(self, text):
        self.proc.stdin.write(text + '\n')
        self.proc.stdin.flush()

    def call(self, msg, expect_id, timeout=10):
        self.send_raw(json.dumps(msg))
        end = time.time() + timeout
        while time.time() < end:
            try:
                raw = self.lines.get(timeout=0.3)
            except queue.Empty:
                continue
            data = json.loads(raw)
            if data.get('id') == expect_id:
                return data
        raise TimeoutError(f'id={expect_id}')

    def close(self):
        try:
            self.proc.kill()
        except OSError:
            pass


def main():
    mcp = json.loads((BASE / 'plugin-market/plugins/session-dashboard/.mcp.json').read_text(encoding='utf-8'))
    conf = mcp['mcpServers']['session-dashboard']
    client = Client(conf)
    counter = [0]

    def next_id():
        counter[0] += 1
        return counter[0]

    try:
        # initialize
        ident = next_id()
        init = client.call({'jsonrpc': '2.0', 'id': ident, 'method': 'initialize',
                            'params': {'protocolVersion': '2025-06-18', 'capabilities': {},
                                       'clientInfo': {'name': 'p2-check', 'version': '0'}}}, ident)
        result = init.get('result') or {}
        record('服务端/initialize 返回协议版本与服务器信息',
               bool(result.get('protocolVersion')) and (result.get('serverInfo') or {}).get('name') == 'session-dashboard',
               json.dumps(result.get('serverInfo'), ensure_ascii=False))

        client.send_raw(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}))

        # ping
        ident = next_id()
        ping = client.call({'jsonrpc': '2.0', 'id': ident, 'method': 'ping'}, ident)
        record('服务端/ping 返回空结果', 'result' in ping and not ping.get('error'), json.dumps(ping)[:80])

        # resources/templates/list
        ident = next_id()
        tmpl = client.call({'jsonrpc': '2.0', 'id': ident, 'method': 'resources/templates/list'}, ident)
        record('服务端/resources/templates/list 返回空模板列表',
               (tmpl.get('result') or {}).get('resourceTemplates') == [], json.dumps(tmpl)[:80])

        # 未知方法
        ident = next_id()
        unknown = client.call({'jsonrpc': '2.0', 'id': ident, 'method': 'no/such/method'}, ident)
        record('服务端/未知方法返回 -32601 而不是崩溃',
               (unknown.get('error') or {}).get('code') == -32601, json.dumps(unknown)[:100])

        # 未知工具
        ident = next_id()
        bad_tool = client.call({'jsonrpc': '2.0', 'id': ident, 'method': 'tools/call',
                                'params': {'name': 'no_such_tool', 'arguments': {}}}, ident)
        record('服务端/未知工具返回 -32601',
               (bad_tool.get('error') or {}).get('code') == -32601, json.dumps(bad_tool)[:100])

        # 资源 uri 不匹配
        ident = next_id()
        bad_uri = client.call({'jsonrpc': '2.0', 'id': ident, 'method': 'resources/read',
                               'params': {'uri': 'ui://wrong/path.html'}}, ident)
        record('服务端/资源 uri 不匹配返回错误',
               (bad_uri.get('error') or {}).get('code') == -32601, json.dumps(bad_uri)[:100])

        # 非法 JSON
        client.send_raw('{not json')
        end = time.time() + 8
        got_parse_error = False
        while time.time() < end:
            try:
                raw = client.lines.get(timeout=0.3)
            except queue.Empty:
                continue
            data = json.loads(raw)
            if (data.get('error') or {}).get('code') == -32700:
                got_parse_error = True
                break
        record('服务端/非法 JSON 返回 -32700', got_parse_error, '')

        # 错误之后仍能继续工作（不崩）
        ident = next_id()
        after = client.call({'jsonrpc': '2.0', 'id': ident, 'method': 'tools/list'}, ident)
        record('服务端/出现错误后仍能继续响应', bool((after.get('result') or {}).get('tools')), '')
    finally:
        client.close()

    failed = [r for r in RESULTS if not r[1]]
    print(f'  服务端分支: {len(RESULTS) - len(failed)}/{len(RESULTS)} 通过')
    for name, ok, detail in RESULTS:
        if not ok:
            print(f'    FAIL {name} — {detail}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
