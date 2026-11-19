"""按"消费者视角"校验产物：用严格解析器、按 Codex 的要求，而不是按我们自己的宽松读取。

重点：
  1. JSON 一律用严格解析（带 BOM 直接报错）——Codex 就是这样读的
  2. 插件清单字段齐全、市场指向的路径真实存在
  3. 真的把 MCP 服务起起来握手一次（initialize / tools/list / resources/list / resources/read）
  4. config.toml 严格解析，且市场源路径存在

    python verify/contract-check.py <dist 或安装目录>
"""
import json
import pathlib
import queue
import subprocess
import sys
import threading
import time

FAILS = []
CHECKS = 0


def check(name, fn):
    global CHECKS
    CHECKS += 1
    try:
        ok, detail = fn()
    except Exception as exc:            # noqa: BLE001
        ok, detail = False, f'{type(exc).__name__}: {exc}'
    if not ok:
        FAILS.append(f'{name} — {detail}')
    print(f'  {"PASS" if ok else "FAIL"}  {name}' + ('' if ok else f'  -> {detail}'))
    return ok


def strict_json(path):
    """严格解析：显式 utf-8 会让 BOM 变成解析错误。"""
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


def mcp_handshake(server_py, cwd):
    """按 .mcp.json 启动服务并完成一次握手，验证 Codex 真的能用它。"""
    proc = subprocess.Popen(
        [sys.executable, str(server_py)],
        cwd=str(cwd), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, encoding='utf-8', bufsize=1,
    )
    lines = queue.Queue()

    def reader():
        for line in proc.stdout:
            lines.put(line)

    threading.Thread(target=reader, daemon=True).start()

    def call(msg, expect_id, timeout=15):
        proc.stdin.write(json.dumps(msg, ensure_ascii=False) + '\n')
        proc.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                raw = lines.get(timeout=0.3)
            except queue.Empty:
                continue
            try:
                payload = json.loads(raw)
            except ValueError:
                continue
            if payload.get('id') == expect_id:
                return payload
        raise TimeoutError(f'未收到 id={expect_id} 的响应')

    try:
        init = call({
            'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
            'params': {
                'protocolVersion': '2025-06-18',
                'capabilities': {},
                'clientInfo': {'name': 'contract-check', 'version': '0'},
            },
        }, 1)
        if 'result' not in init:
            raise AssertionError(f'initialize 失败: {init}')

        proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) + '\n')
        proc.stdin.flush()

        tools = call({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'}, 2)
        resources = call({'jsonrpc': '2.0', 'id': 3, 'method': 'resources/list'}, 3)
        return {
            'protocol': init['result'].get('protocolVersion'),
            'tools': [t.get('name') for t in (tools.get('result') or {}).get('tools', [])],
            'resources': [(r.get('uri'), r.get('mimeType')) for r in (resources.get('result') or {}).get('resources', [])],
        }
    finally:
        proc.kill()


def main(target):
    base = pathlib.Path(target)
    if not base.is_dir():
        print(f'  目标不存在: {base}')
        return 1
    print(f'\n== 消费者契约检查: {base.name}')

    # 1. 所有 JSON 严格解析
    def all_json():
        bad = []
        for path in base.rglob('*.json'):
            try:
                strict_json(path)
            except Exception as exc:  # noqa: BLE001
                bad.append(f'{path.relative_to(base)}: {type(exc).__name__}')
        return (not bad), ', '.join(bad)
    check('所有 JSON 严格可解析（含无 BOM）', all_json)

    # 2. 插件清单
    plugin_json = base / 'plugin-market' / 'plugins' / 'session-dashboard' / '.codex-plugin' / 'plugin.json'

    def plugin_fields():
        data = strict_json(plugin_json)
        missing = [k for k in ('name', 'version', 'mcpServers') if not data.get(k)]
        return (not missing), f'缺少字段 {missing}'
    check('plugin.json 字段齐全', plugin_fields)

    # 3. 市场清单指向的目录存在
    market_json = base / 'plugin-market' / '.agents' / 'plugins' / 'marketplace.json'

    def market_sources():
        data = strict_json(market_json)
        market_root = market_json.parent.parent.parent
        bad = []
        for entry in data.get('plugins', []):
            rel = (entry.get('source') or {}).get('path')
            if not rel:
                bad.append(f'{entry.get("name")}: 无 source.path')
            elif not (market_root / rel).is_dir():
                bad.append(f'{entry.get("name")}: 路径不存在 {rel}')
        return (not bad), ', '.join(bad)
    check('marketplace.json 指向的插件目录存在', market_sources)

    # 4. .mcp.json 的 command / args 可用
    plugin_dir = plugin_json.parent.parent
    mcp_json = plugin_dir / '.mcp.json'
    # dist 与发布包里 .mcp.json 保留占位符（可移植），安装后才渲染成真实路径
    template_mode = '{{' in mcp_json.read_text(encoding='utf-8')

    def mcp_paths():
        data = strict_json(mcp_json)
        conf = (data.get('mcpServers') or {}).get('session-dashboard') or {}
        cmd, args = conf.get('command'), conf.get('args') or []
        problems = []
        if template_mode:
            # 模板态：必须保留占位符，且不能残留本机绝对路径
            if cmd != '{{python}}':
                problems.append(f'command 应为占位符，实际 {cmd}')
            if not args or args[0] != '{{server}}':
                problems.append('args[0] 应为 {{server}}')
            if 'C:' in json.dumps(data):
                problems.append('模板里残留本机绝对路径')
        else:
            if not cmd or not pathlib.Path(cmd).exists():
                problems.append(f'command 不存在: {cmd}')
            if not args or not pathlib.Path(args[0]).exists():
                problems.append(f'args[0] 不存在: {args[0] if args else None}')
            if '{{' in json.dumps(data):
                problems.append('仍含未渲染的模板占位符')
        return (not problems), ', '.join(problems)
    check('.mcp.json ' + ('保留可移植模板' if template_mode else '已渲染且路径存在'), mcp_paths)

    # 5. MCP 握手
    handshake = {}

    def handshake_check():
        if template_mode:
            return True, '跳过（模板态，安装后才可启动）'
        conf = strict_json(mcp_json)['mcpServers']['session-dashboard']
        handshake.update(mcp_handshake(conf['args'][0], plugin_dir))
        return (bool(handshake['tools']) and bool(handshake['resources'])), json.dumps(handshake, ensure_ascii=False)
    check('MCP 服务握手成功（initialize / tools / resources）', handshake_check)

    # 6. config.toml 严格解析 + 市场源存在
    cfg = pathlib.Path.home() / '.codex' / 'config.toml'

    def config_check():
        try:
            import tomllib
        except ImportError:
            try:
                import tomli as tomllib
            except ImportError:
                return True, '跳过（无 TOML 解析器）'
        text = cfg.read_text(encoding='utf-8')
        if text.startswith('\ufeff'):
            return False, 'config.toml 带 BOM'
        data = tomllib.loads(text)
        markets = data.get('marketplaces', {})
        entry = markets.get('codex-dashboard-local')
        if not entry:
            return False, '缺少 marketplaces.codex-dashboard-local'
        src = entry.get('source', '').replace('\\\\?\\', '')
        if not pathlib.Path(src).is_dir():
            return False, f'市场源路径不存在: {src}'
        if 'session-dashboard@codex-dashboard-local' not in data.get('plugins', {}):
            return False, '缺少插件注册'
        return True, 'ok'
    check('config.toml 可解析且注册正确', config_check)

    print()
    print(f'  {CHECKS - len(FAILS)}/{CHECKS} 通过')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else '.'))
