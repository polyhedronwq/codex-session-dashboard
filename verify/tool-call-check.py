"""按 Codex 的方式调用面板工具，确认无参也能返回数据。"""
import json, pathlib, queue, subprocess, sys, threading, time


def main(base):
    cfg = json.loads((pathlib.Path(base) / 'plugin-market/plugins/session-dashboard/.mcp.json').read_text(encoding='utf-8'))
    conf = cfg['mcpServers']['session-dashboard']
    proc = subprocess.Popen([conf['command'], *conf['args']], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, encoding='utf-8', bufsize=1)
    q = queue.Queue()
    threading.Thread(target=lambda: [q.put(l) for l in proc.stdout], daemon=True).start()

    def call(msg, expect, timeout=20):
        proc.stdin.write(json.dumps(msg) + '\n')
        proc.stdin.flush()
        end = time.time() + timeout
        while time.time() < end:
            try:
                raw = q.get(timeout=0.3)
            except queue.Empty:
                continue
            data = json.loads(raw)
            if data.get('id') == expect:
                return data
        raise TimeoutError(f'id={expect}')

    try:
        call({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
              'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'check', 'version': '0'}}}, 1)
        proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) + '\n')
        proc.stdin.flush()

        for label, args, ident in [('无参数', {}, 2), ('空对象参数', {'thread_id': ''}, 3)]:
            res = call({'jsonrpc': '2.0', 'id': ident, 'method': 'tools/call',
                        'params': {'name': 'show_session_dashboard', 'arguments': args}}, ident)
            result = res.get('result') or {}
            if res.get('error') or result.get('isError'):
                print(f'{label}: 失败 {res.get("error") or result.get("content")}')
                return 1
            structured = result.get('structuredContent') or {}
            if not structured.get('ok'):
                print(f'{label}: structuredContent.ok 不为 true')
                return 1
            print(f'{label}: ok, {len(structured.get("turns") or [])} 轮')
        return 0
    finally:
        proc.kill()


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else str(pathlib.Path.home() / '.codex-bar')))
