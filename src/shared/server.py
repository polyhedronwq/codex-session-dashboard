"""Session dashboard MCP App server (read-only).

Reads one Codex thread's rollout JSONL + state sqlite and returns numeric
session metrics. Never reads message contents, never writes outside its folder.

Rollout files are large (100+ MB), so parsing is incremental: the server keeps
a per-file byte offset and only reads appended lines on each refresh.

Protocol: MCP over stdio (JSON-RPC 2.0), plus one MCP App resource.
"""
import codecs
import datetime
import json
import pathlib
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
import uuid


# ---------------------------------------------------------------------------- quota API

QUOTA_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage/thread_usage/query_v2'
_QUOTA_CACHE = {}          # thread_id -> (timestamp, result), in-process
# The panel and the status bar are separate processes, each asking for the same number.
# An on-disk cache keeps the whole machine down to one real request per TTL.
_QUOTA_CACHE_FILE = pathlib.Path.home() / '.codex-bar' / 'quota-cache.json'
_QUOTA_CACHE_KEEP = 20
# 实测：服务端聚合几小时才动一次（7 条会话的 data_as_of 是同一个 134 分钟前的时间），
# 15 分钟刷新拿回同一个数，纯浪费。未归属的会话更不会因为等就出现，所以拉得更长。
_QUOTA_TTL_OK = 3600.0     # 60 min：服务端本身就没那么快更新
_QUOTA_TTL_MISSING = 7200.0  # 120 min：未归属的会话短期不会突然有
_QUOTA_TIMEOUT = 6.0


def _auth_tokens():
    try:
        data = json.loads((CODEX_HOME / 'auth.json').read_text(encoding='utf-8'))
    except Exception:
        return None, None
    tokens = data.get('tokens') or {}
    return tokens.get('access_token'), tokens.get('account_id')


def _quota_cache_read():
    try:
        return json.loads(_QUOTA_CACHE_FILE.read_text(encoding='utf-8'))
    except Exception:
        return {}


def _quota_cache_write(thread_id, result):
    # 只写真实会话 id：以前测试用的假 id（如 't'）会污染共享缓存
    try:
        uuid.UUID(str(thread_id))
    except (ValueError, AttributeError, TypeError):
        return
    data = _quota_cache_read()
    data[thread_id] = {'ts': time.time(), 'result': result}
    if len(data) > _QUOTA_CACHE_KEEP:
        newest = sorted(data.items(), key=lambda kv: kv[1].get('ts', 0), reverse=True)
        data = dict(newest[:_QUOTA_CACHE_KEEP])
    try:
        _QUOTA_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        temp = _QUOTA_CACHE_FILE.with_suffix('.tmp')
        temp.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        temp.replace(_QUOTA_CACHE_FILE)      # atomic on Windows for same-volume rename
    except Exception:
        pass


def _quota_ttl(result):
    has_value = isinstance((result or {}).get('weekly_percent'), (int, float))
    return _QUOTA_TTL_OK if has_value else _QUOTA_TTL_MISSING


def api_thread_quota(thread_id, force=False):
    """Ask ChatGPT how much of the weekly limit this conversation used.

    The number is attributed server-side per conversation, which is the only way to get
    the real cost: the local rate_limits samples only say how much the whole account moved.
    Returns None when offline, not signed in, or the request fails.
    """
    if not thread_id:
        return None

    if not force:
        cached = _QUOTA_CACHE.get(thread_id)
        if cached and time.time() - cached[0] < _quota_ttl(cached[1]):
            return cached[1]

        shared = _quota_cache_read().get(thread_id) or {}
        if shared:
            age = time.time() - float(shared.get('ts') or 0)
            if age < _quota_ttl(shared.get('result')):
                result = shared.get('result')
                _QUOTA_CACHE[thread_id] = (time.time(), result)
                return result

    token, account = _auth_tokens()
    if not token:
        return None

    body = json.dumps({'threads': [{'thread_id': thread_id}]}).encode('utf-8')
    request = urllib.request.Request(QUOTA_ENDPOINT, data=body, method='POST')
    request.add_header('Authorization', 'Bearer ' + token)
    request.add_header('Content-Type', 'application/json')
    request.add_header('origin', 'https://chatgpt.com')
    request.add_header('referer', 'https://chatgpt.com/')
    if account:
        request.add_header('chatgpt-account-id', account)

    try:
        with urllib.request.urlopen(request, timeout=_QUOTA_TIMEOUT) as response:
            payload = json.loads(response.read().decode('utf-8'))
    except Exception:
        _QUOTA_CACHE[thread_id] = (time.time(), None)
        _quota_cache_write(thread_id, None)
        return None

    rows = payload.get('threads') or []
    row = rows[0] if rows else {}
    result = {
        'weekly_percent': row.get('weekly_limit_percent'),
        'five_hour_percent': row.get('five_hour_limit_percent'),
        'data_status': row.get('data_status'),
        'credits': row.get('balance_usage_credits'),
        'data_as_of': payload.get('data_as_of'),
    }
    _QUOTA_CACHE[thread_id] = (time.time(), result)
    _quota_cache_write(thread_id, result)
    return result
ROOT = pathlib.Path(__file__).resolve().parent
CODEX_HOME = pathlib.Path.home() / '.codex'
DB_PATH = CODEX_HOME / 'state_5.sqlite'
URI = 'ui://session-dashboard/dashboard.html'
MAX_TURNS = 60
MAX_ITEMS = 80
PAGE_COUNT_DEFAULT = 30   # 面板分页一页多少轮（实测 ~92 KB，不含明细）
PAGE_COUNT_MAX = 60       # 一次最多取多少轮，防大请求
OUTLINE_PROMPT_LIMIT = 50    # 预览：对齐 DSH turnOutline（1 行 prompt）
OUTLINE_RESPONSE_LIMIT = 120  # 预览：3 行回复
MAX_READERS = 4

TOOL_LABELS = {
    'CommandExecution': '命令',
    'FileChange': '改文件',
    'McpToolCall': 'MCP',
    'WebSearch': '搜索',
    'SubAgentActivity': '子代理',
    'Reasoning': '推理',
    'AgentMessage': '回复',
    'UserMessage': '用户',
    'Plan': '计划',
    'ContextCompaction': '压缩',
    'ImageView': '图片',
    'Extension': '扩展',
    'CollabAgentToolCall': '协作',
    'FunctionCallOutput': '结果',
    'CustomToolCallOutput': '结果',
}
TOOL_TYPES = {'CommandExecution', 'FileChange', 'McpToolCall', 'WebSearch', 'SubAgentActivity', 'CollabAgentToolCall'}
FIELD_KEYS = ('input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
              'output_tokens', 'reasoning_output_tokens', 'total_tokens')

READERS = {}


def newest_active_thread():
    """宿主没给线程上下文时的兜底：取最近仍在写入的那个会话。

    rollout 文件一直在追加，所以它的修改时间最接近"用户当前正在看的对话"。
    """
    try:
        con = sqlite3.connect(f'file:{DB_PATH.as_posix()}?mode=ro', uri=True)
    except sqlite3.Error:
        return None
    try:
        rows = con.execute(
            """
            select id, rollout_path from threads
            where model not like 'codex-auto-review%' and rollout_path is not null
            order by updated_at_ms desc limit 30
            """
        ).fetchall()
    except sqlite3.Error:
        return None
    finally:
        con.close()

    best = None
    for thread_id, rollout in rows:
        if not rollout:
            continue
        try:
            path = pathlib.Path(str(rollout).replace('\\\\?\\', ''))
            if not path.is_file():
                continue
            mtime = path.stat().st_mtime
        except OSError:
            continue
        if best is None or mtime > best[1]:
            best = (thread_id, mtime)
    return best[0] if best else None



def resolve_thread_id(params):
    meta = (params or {}).get('_meta') or {}
    if not isinstance(meta, dict):
        meta = {}
    candidates = [meta.get('threadId'), meta.get('thread_id')]
    turn_meta = meta.get('x-codex-turn-metadata')
    if isinstance(turn_meta, str):
        try:
            turn_meta = json.loads(turn_meta)
        except ValueError:
            turn_meta = None
    if isinstance(turn_meta, dict):
        candidates += [turn_meta.get('thread_id'), turn_meta.get('threadId')]
    args = (params or {}).get('arguments') or {}
    if isinstance(args, dict):
        candidates.append(args.get('thread_id'))
    for value in candidates:
        if isinstance(value, str) and value.strip():
            try:
                return str(uuid.UUID(value.strip()))
            except ValueError:
                continue
    # 宿主没给上下文：按 rollout 最近写入推断，避免"有的对话打不开"
    return newest_active_thread()


def thread_row(thread_id):
    con = sqlite3.connect(f'file:{DB_PATH.as_posix()}?mode=ro', uri=True)
    try:
        row = con.execute(
            'select id, name, title, rollout_path, model, updated_at, source from threads where id = ?',
            (thread_id,),
        ).fetchone()
    finally:
        con.close()
    if not row:
        return None
    path = str(row[3] or '').replace('\\\\?\\', '')
    return {
        'id': row[0],
        'title': (row[1] or row[2] or '').strip(),
        'first_message': (row[2] or '').strip(),
        'path': pathlib.Path(path) if path else None,
        'model': row[4] or '',
        'updated_at': row[5],
        'source': row[6] or '',
    }


def pct(part, total):
    if not total:
        return None
    return round(100.0 * part / total, 1)


def ms(value):
    return int(value) if isinstance(value, (int, float)) else 0


def iso_ms(value):
    if not isinstance(value, str) or not value:
        return 0
    try:
        return int(datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)
    except ValueError:
        return 0


# ---------------------------------------------------------------- incremental reader

def new_state():
    return {
        'offset': 0,
        'buffer': '',
        'decoder': codecs.getincrementaldecoder('utf-8')('replace'),
        'turns': {},
        'order': [],
        'last_info': None,
        'thread_total': None,
        'last_usage': None,
        'compactions': 0,
        'user_messages': 0,
        'parse_errors': 0,
        'commands': 0,
        'mcp_servers': {},
        'searches': 0,
        'file_hits': {},
        'sub_kinds': {},
        'sub_threads': set(),
        'env': None,
        'settings_last': None,
        'settings_changes': [],
        'rules': None,
        'agent_msgs': {'count': 0, 'by_author': {}, 'items': []},
        'aborted': 0,
        'aborted_ids': set(),
    }


def item_display(itype, item):
    """Short label: commands, paths and tool names only, never message text."""
    if itype == 'CommandExecution':
        parts = item.get('command')
        if isinstance(parts, list):
            tokens = []
            for index, part in enumerate(parts):
                text = str(part)
                if index == 0 and (text.lower().endswith('.exe') or '/' in text or '\\' in text):
                    text = pathlib.Path(text).name
                tokens.append(text)
            if len(tokens) >= 2 and tokens[1] in ('-Command', '-c', '-lc', '/c', '/C'):
                tokens = tokens[2:]
            text = ' '.join(tokens)
        else:
            text = str(parts or '')
        return ' '.join(text.split())[:120]
    if itype == 'FileChange':
        changes = item.get('changes')
        if isinstance(changes, dict):
            names = [pathlib.PurePath(str(path)).name for path in changes.keys()]
            if names:
                return ', '.join(names[:3]) + (f' 等 {len(names)} 个' if len(names) > 3 else '')
        return ''
    if itype == 'McpToolCall':
        server = str(item.get('server') or '')
        tool = str(item.get('tool') or '')
        return f'{server}.{tool}' if server and tool else tool
    if itype == 'WebSearch':
        return str(item.get('query') or '')[:120]
    if itype == 'SubAgentActivity':
        path = str(item.get('agent_path') or '').replace('/root/', '', 1)
        return ' '.join(filter(None, [str(item.get('kind') or ''), str(item.get('model') or ''), path]))[:120]
    if itype == 'Plan':
        return str(item.get('plan') or '')[:120]
    return ''


MD_LINK = re.compile(r'\[([^\]]{1,80})\]\([^)]{0,200}\)')
MD_NOISE = re.compile(r'(\*\*|__|~~|`)')


def strip_markdown(text):
    """把 markdown 噪音去掉，只留可读文字。

    预览的作用是"认出是哪一轮"，语法符号只会让人以为渲染坏了。
    """
    if not text:
        return ''
    # 顺序很重要：先整段丢掉图片，否则 ![](x) 会被后面的链接规则变成 "!文字"
    out = re.sub(r'!\[[^\]]*\]\([^)]*\)', ' ', text)
    out = MD_LINK.sub(r'\1', out)           # [文字](链接) -> 文字
    out = MD_NOISE.sub('', out)
    out = re.sub(r'^\s{0,3}#{1,6}\s*', '', out, flags=re.M)   # 行首标题标记
    out = re.sub(r'^\s{0,3}>\s?', '', out, flags=re.M)        # 引用符
    return ' '.join(out.split())


def plain_text(item, limit=140):
    """Short single-line preview of a message, for the stats table only."""
    content = item.get('content')
    parts = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and isinstance(block.get('text'), str):
                parts.append(block['text'])
    elif isinstance(item.get('text'), str):
        parts.append(item['text'])
    text = ' '.join(parts)
    marker = '## My request:'
    if marker in text:
        text = text.split(marker, 1)[1]
    return strip_markdown(text)[:limit]


def item_detail(itype, item):
    """Record-level detail for the trajectory inspector, capped for transport."""
    detail = {}
    if itype == 'CommandExecution':
        command = item.get('command')
        detail['command'] = ' '.join(str(part) for part in command) if isinstance(command, list) else str(command or '')
        detail['cwd'] = str(item.get('cwd') or '')
        detail['status'] = str(item.get('status') or '')
        if item.get('exit_code') is not None:
            detail['exit_code'] = item.get('exit_code')
        output = str(item.get('aggregated_output') or '')
        detail['output'] = output[:4000]
        detail['output_truncated'] = len(output) > 4000
    elif itype == 'FileChange':
        changes = item.get('changes') or {}
        rows = []
        for path, change in list(changes.items())[:5]:
            change = change or {}
            rows.append({
                'path': str(path),
                'kind': str(change.get('type') or ''),
                'diff': str(change.get('unified_diff') or '')[:1500],
            })
        detail['changes'] = rows
        detail['files'] = len(changes)
    elif itype == 'McpToolCall':
        detail['server'] = str(item.get('server') or '')
        detail['tool'] = str(item.get('tool') or '')
        try:
            detail['arguments'] = json.dumps(item.get('arguments') or {}, ensure_ascii=False)[:2000]
        except (TypeError, ValueError):
            detail['arguments'] = ''
        result = item.get('result') or {}
        texts = [block.get('text') for block in (result.get('content') or [])
                 if isinstance(block, dict) and isinstance(block.get('text'), str)]
        joined = '\n'.join(texts)
        detail['result'] = joined[:4000]
        detail['result_truncated'] = len(joined) > 4000
        detail['is_error'] = bool(result.get('isError'))
    elif itype in ('WebSearch', 'Extension'):
        detail['query'] = str(item.get('query') or '')[:500]
        results = item.get('results') or []
        snippets = []
        for row in results[:8]:
            if isinstance(row, dict):
                snippets.append(' '.join(filter(None, [str(row.get('domain') or ''), str(row.get('snippet') or '')]))[:300])
        detail['results'] = snippets
    elif itype == 'SubAgentActivity':
        detail['model'] = str(item.get('model') or '')
        detail['kind'] = str(item.get('kind') or '')
        detail['agent_thread_id'] = str(item.get('agent_thread_id') or '')
        detail['agent_path'] = str(item.get('agent_path') or '')
    elif itype == 'Reasoning':
        summaries = item.get('summary_text') or []
        detail['summary'] = ' '.join(str(part) for part in summaries)[:2000]
    elif itype in ('UserMessage', 'AgentMessage'):
        detail['text'] = plain_text(item, 4000)
    return detail


def consume(state, line):
    line = line.strip()
    if not line:
        return
    try:
        record = json.loads(line)
    except ValueError:
        state['parse_errors'] += 1
        return
    kind = record.get('type')
    payload = record.get('payload') or {}
    if not isinstance(payload, dict):
        return
    ptype = payload.get('type')

    if kind == 'turn_context':
        sandbox = payload.get('sandbox_policy') if isinstance(payload.get('sandbox_policy'), dict) else {}
        roots = sandbox.get('writable_roots')
        state['env'] = {
            'cwd': payload.get('cwd') or None,
            'approval_policy': payload.get('approval_policy') or None,
            'sandbox_type': sandbox.get('type') or None,
            'writable_roots': [str(r) for r in roots] if isinstance(roots, list) else [],
            'network': sandbox.get('network_access'),
            'model': payload.get('model') or None,
            'effort': payload.get('effort') or None,
        }
        # turn_context is written once per turn, so diffing it gives real user-visible
        # switches (model / reasoning effort / approval / sandbox) without the
        # duplicate-applies that thread_settings_applied emits within milliseconds.
        snapshot = {
            'model': state['env']['model'],
            'effort': state['env']['effort'],
            'approval_policy': state['env']['approval_policy'],
            'sandbox': state['env']['sandbox_type'],
            'network': state['env']['network'],
        }
        previous = state['settings_last']
        if previous is not None:
            diffs = [
                {'field': key, 'from': previous.get(key), 'to': snapshot.get(key)}
                for key in snapshot
                if snapshot.get(key) != previous.get(key) and previous.get(key) is not None
            ]
            if diffs:
                state['settings_changes'].append({
                    'ts': iso_ms(record.get('timestamp')),
                    'after_turns': len(state['order']),
                    'changes': diffs,
                    # full state so a caller can render "model+effort -> model+effort"
                    # instead of only the fields that happened to change
                    'before': {'model': previous.get('model'), 'effort': previous.get('effort')},
                    'after': {'model': snapshot.get('model'), 'effort': snapshot.get('effort')},
                })
        state['settings_last'] = snapshot
        return

    if kind == 'world_state':
        world = payload.get('state')
        if isinstance(world, dict):
            agents_md = world.get('agents_md')
            if isinstance(agents_md, dict):
                text = agents_md.get('text') or ''
                state['rules'] = {
                    'file': 'AGENTS.md',
                    'chars': len(text),
                    'head': text.strip().split('\n', 1)[0][:80] if text.strip() else '',
                }
            else:
                state['rules'] = None
        return

    if kind == 'response_item' and ptype == 'agent_message':
        author = str(payload.get('author') or '')
        recipient = str(payload.get('recipient') or '')
        meta = payload.get('internal_chat_message_metadata_passthrough')
        turn_id = meta.get('turn_id') if isinstance(meta, dict) else None
        record_msg = {
            'author': author.replace('/root/', '', 1) if author.startswith('/root/') else author,
            'recipient': recipient.replace('/root', '主线程', 1) if recipient.startswith('/root') else recipient,
            'ts': iso_ms(record.get('timestamp')),
            'turn_id': turn_id,
        }
        state['agent_msgs']['count'] += 1
        key = record_msg['author'] or '?'
        state['agent_msgs']['by_author'][key] = state['agent_msgs']['by_author'].get(key, 0) + 1
        if len(state['agent_msgs']['items']) < 60:
            state['agent_msgs']['items'].append(record_msg)
        return

    if kind == 'event_msg' and ptype == 'turn_aborted':
        tid = payload.get('turn_id')
        if tid:
            state['aborted_ids'].add(tid)
            if tid in state['turns']:
                state['turns'][tid]['aborted'] = True
        state['aborted'] += 1
        return

    if kind == 'event_msg' and ptype == 'task_started':
        tid = payload.get('turn_id')
        if not tid:
            return
        if tid not in state['turns']:
            state['turns'][tid] = {
                'id': tid,
                'trigger': (payload.get('turn_attribution') or {}).get('turn_trigger') or 'user',
                'started_at': payload.get('started_at') or 0,
                'duration_ms': None,
                'ttft_ms': None,
                'steps': 0,
                'tokens': {k: 0 for k in FIELD_KEYS},
                'items': [],
                'context_used': None,
                'context_sum': 0,
                'steps_detail': [],
                'user_text': '',
                'assistant_text': '',
                'tool_counts': {},
            }
            state['order'].append(tid)
        return

    if kind == 'event_msg' and ptype == 'task_complete':
        turn = state['turns'].get(payload.get('turn_id'))
        if turn is not None:
            turn['duration_ms'] = payload.get('duration_ms')
            turn['ttft_ms'] = payload.get('time_to_first_token_ms')
        return

    if kind == 'token_usage_record':
        turn = state['turns'].get(payload.get('turn_id'))
        usage = payload.get('usage') or {}
        if turn is not None:
            turn['steps'] += 1
            for key in FIELD_KEYS:
                turn['tokens'][key] += int(usage.get(key) or 0)
            turn['context_used'] = int(usage.get('input_tokens') or turn['context_used'] or 0)
            turn['context_sum'] += int(usage.get('input_tokens') or 0)
            turn['steps_detail'].append({
                'input': int(usage.get('input_tokens') or 0),
                'cached': int(usage.get('cached_input_tokens') or 0),
                'output': int(usage.get('output_tokens') or 0),
                'reasoning': int(usage.get('reasoning_output_tokens') or 0),
                'ts': iso_ms(record.get('timestamp')),
            })
        state['thread_total'] = payload.get('thread_token_usage') or state['thread_total']
        state['last_usage'] = usage or state['last_usage']
        return

    if kind == 'event_msg' and ptype == 'token_count':
        info = payload.get('info')
        if isinstance(info, dict) and info:
            state['last_info'] = info
            if payload.get('rate_limits'):
                info['_rate_limits'] = payload['rate_limits']
        return

    if kind == 'event_msg' and ptype == 'item_completed':
        turn = state['turns'].get(payload.get('turn_id'))
        item = payload.get('item') or {}
        if turn is None or not isinstance(item, dict):
            return
        itype = item.get('type') or ''
        if itype == 'McpToolCall' and item.get('server') == 'session-dashboard':
            return  # the panel's own refresh calls are not session work
        if itype == 'UserMessage':
            state['user_messages'] += 1
            turn['user_text'] = plain_text(item, 200) or turn['user_text']
        elif itype == 'AgentMessage':
            turn['assistant_text'] = plain_text(item, 200) or turn['assistant_text']
        elif itype in TOOL_TYPES:
            turn['tool_counts'][itype] = turn['tool_counts'].get(itype, 0) + 1

        # Codex-only footprint counters
        if itype == 'CommandExecution':
            state['commands'] += 1
        elif itype == 'McpToolCall':
            server_name = str(item.get('server') or '?')
            state['mcp_servers'][server_name] = state['mcp_servers'].get(server_name, 0) + 1
        elif itype == 'WebSearch':
            state['searches'] += 1
        elif itype == 'Extension' and str(item.get('kind') or '').startswith('web.search'):
            state['searches'] += 1
        elif itype == 'FileChange':
            changes = item.get('changes')
            if isinstance(changes, dict):
                for changed_path in changes.keys():
                    key = str(changed_path)
                    state['file_hits'][key] = state['file_hits'].get(key, 0) + 1
        elif itype == 'SubAgentActivity':
            kind_name = str(item.get('kind') or '?')
            state['sub_kinds'][kind_name] = state['sub_kinds'].get(kind_name, 0) + 1
            agent_id = item.get('agent_thread_id')
            if isinstance(agent_id, str) and agent_id:
                state['sub_threads'].add(agent_id)
        start = ms(payload.get('started_at_ms') or item.get('started_at_ms'))
        end = ms(payload.get('completed_at_ms') or item.get('completed_at_ms'))
        turn['items'].append({
            'type': itype,
            'label': TOOL_LABELS.get(itype, itype or '步骤'),
            'name': item_display(itype, item)[:120],
            'ms': max(end - start, 0) if start and end else 0,
            'start': start,
            'end': end,
            'text': plain_text(item, 400) if itype in ('AgentMessage', 'UserMessage') else '',
            'detail': item_detail(itype, item),
        })
        return

    if kind == 'compacted':
        state['compactions'] += 1


def read_appended(state, path):
    size = path.stat().st_size
    if size < state['offset']:
        fresh = new_state()
        state.clear()
        state.update(fresh)
    if size == state['offset']:
        return
    with path.open('rb') as handle:
        handle.seek(state['offset'])
        chunk = handle.read()
        state['offset'] = handle.tell()
    text = state['buffer'] + state['decoder'].decode(chunk)
    lines = text.split('\n')
    state['buffer'] = lines.pop()
    for line in lines:
        consume(state, line)


def build_turns(state):
    result_turns = []
    prev_context = None
    prev_context_sum = None
    for index, tid in enumerate(state['order'], start=1):
        turn = state['turns'][tid]
        tokens = turn['tokens']
        tool_ms = sum(i['ms'] for i in turn['items'] if i['type'] in TOOL_TYPES)
        duration = turn['duration_ms'] or 0
        ttft = turn['ttft_ms'] or 0
        gen_ms = max(duration - ttft, 1) if duration else 0
        speed = round(tokens['output_tokens'] / (gen_ms / 1000), 1) if gen_ms else None
        start_ms = (turn['started_at'] or 0) * 1000
        step_rows = []
        cursor = start_ms
        for step in turn['steps_detail']:
            ts = step['ts'] or cursor
            duration = max(ts - cursor, 0) if cursor else 0
            step_rows.append({
                'input': step['input'],
                'cached': step['cached'],
                'output': step['output'],
                'reasoning': step['reasoning'],
                'ts': step['ts'],
                'duration_ms': duration,
            })
            cursor = ts or cursor
        timeline = []
        if duration and start_ms:
            for item in turn['items']:
                if not item.get('start') or item['type'] not in TOOL_TYPES:
                    continue
                rel = max(item['start'] - start_ms, 0)
                if rel > duration:
                    continue
                length = max(min(item['ms'], duration - rel), 1)
                timeline.append({
                    'start': rel,
                    'len': length,
                    'type': item['type'],
                    'label': item['label'],
                    'name': item['name'],
                })
        result_turns.append({
            'id': turn['id'],
            'index': index,
            'trigger': turn['trigger'],
            'running': turn['duration_ms'] is None,
            'aborted': turn.get('aborted') or turn['id'] in state['aborted_ids'],
            'started_at': turn['started_at'],
            'duration_ms': turn['duration_ms'],
            'ttft_ms': turn['ttft_ms'],
            'steps': turn['steps'],
            'tokens': tokens,
            'cache_hit_pct': pct(tokens['cached_input_tokens'], tokens['input_tokens']),
            'speed': speed,
            'tool_ms': tool_ms,
            'model_ms': max(duration - tool_ms, 0) if duration else None,
            'context_used': turn['context_used'],
            'context_prev': prev_context,
            'context_sum': turn['context_sum'],
            'context_sum_prev': prev_context_sum,
            'steps_detail': step_rows,
            'user_text': turn['user_text'],
            'assistant_text': turn['assistant_text'],
            'tool_counts': turn['tool_counts'],
            'timeline': timeline,
            'items': [dict(item) for item in turn['items'][:MAX_ITEMS]],
            'item_count': len(turn['items']),
        })
        if turn['context_used']:
            prev_context = turn['context_used']
        if turn['context_sum']:
            prev_context_sum = turn['context_sum']
    return result_turns


def build_summary(state, result_turns, thread_id=None):
    total = state['thread_total'] or {k: 0 for k in FIELD_KEYS}
    info = state['last_info'] or {}
    context_window = info.get('model_context_window')
    context_used = (state['last_usage'] or {}).get('input_tokens')
    rate = info.get('_rate_limits') or {}
    primary = rate.get('primary') or {}

    last_turn = result_turns[-1] if result_turns else None
    last_completed = next((t for t in reversed(result_turns) if not t.get('running')), None)
    reference = last_completed or last_turn
    tool_calls = sum(1 for i in (reference or {}).get('items', []) if i['type'] in TOOL_TYPES)
    return {
        'turns': len(result_turns),
        'user_messages': state['user_messages'],
        'steps': sum(t['steps'] for t in result_turns),
        'last_turn_steps': (last_turn or {}).get('steps'),
        'last_turn_tools': tool_calls,
        'total': total,
        'cache_hit_pct': pct(total.get('cached_input_tokens', 0), total.get('input_tokens', 0)),
        'context': {
            'used': context_used,
            'window': context_window,
            'pct': pct(context_used, context_window) if context_used and context_window else None,
        },
        # Only the per-conversation number is exposed. The account-wide percentage is
        # visible in Codex itself and must not be dressed up as this conversation's cost.
        'quota': {
            'api': api_thread_quota(thread_id),
        },
        'compactions': state['compactions'],
        'footprint': footprint(state),
        'env': state['env'],
        'settings_changes': state['settings_changes'],
        'rules': state['rules'],
        'agent_msgs': state['agent_msgs'],
        'aborted': state['aborted'],
        'last_turn': last_turn,
        'last_completed': last_completed,
        'running': bool(last_turn and last_turn.get('running')),
    }


def footprint(state):
    """Codex-only: what the agent actually touched (files, commands, servers)."""
    files = sorted(state['file_hits'].items(), key=lambda kv: -kv[1])
    top_files = [
        {'path': path, 'name': pathlib.PurePath(path).name, 'count': count}
        for path, count in files[:6]
    ]
    servers = sorted(state['mcp_servers'].items(), key=lambda kv: -kv[1])
    return {
        'files': len(state['file_hits']),
        'top_files': top_files,
        'commands': state['commands'],
        'mcp': [{'server': name, 'count': count} for name, count in servers[:6]],
        'mcp_calls': sum(state['mcp_servers'].values()),
        'searches': state['searches'],
        'compactions': state['compactions'],
        'subagent_events': dict(state['sub_kinds']),
        'subagent_threads': len(state['sub_threads']),
    }


def subagent_graph(thread_id, main_tokens):
    """Codex-only: the delegation ledger (thread_spawn_edges + child threads)."""
    try:
        con = sqlite3.connect(f'file:{DB_PATH.as_posix()}?mode=ro', uri=True)
    except sqlite3.Error:
        return None
    try:
        edges = con.execute(
            'select child_thread_id, status from thread_spawn_edges where parent_thread_id = ?',
            (thread_id,),
        ).fetchall()
        if not edges:
            return {'edges': 0, 'children': 0, 'tokens': 0, 'share_pct': None, 'items': [], 'models': []}
        seen = {}
        for child_id, status in edges:
            entry = seen.get(child_id)
            if entry is None:
                row = con.execute(
                    'select name, title, model, tokens_used, updated_at, agent_role, agent_nickname, reasoning_effort, agent_path '
                    'from threads where id = ?',
                    (child_id,),
                ).fetchone()
                nested = con.execute(
                    'select count(*) from thread_spawn_edges where parent_thread_id = ?',
                    (child_id,),
                ).fetchone()[0]
                label = ''
                model = ''
                tokens = 0
                updated = 0
                role = ''
                nickname = ''
                effort = ''
                agent_path = ''
                if row:
                    nickname = (row[6] or '').strip()
                    label = (row[0] or row[1] or '').strip().replace('\n', ' ')
                    model = row[2] or ''
                    tokens = int(row[3] or 0)
                    updated = row[4] or 0
                    role = row[5] or ''
                    effort = (row[7] or '').strip()
                    agent_path = (row[8] or '').strip()
                seen[child_id] = {
                    'id': child_id,
                    'short': child_id[:10],
                    'label': (nickname or label)[:60],
                    'nickname': nickname,
                    'model': model,
                    'effort': effort,
                    'path': agent_path.replace('/root/', '', 1) if agent_path.startswith('/root/') else agent_path,
                    'tokens': tokens,
                    'updated_at': updated,
                    'role': role,
                    'nested': nested,
                    'status': status or '',
                    'times': 0,
                }
            seen[child_id]['times'] += 1
        items = sorted(seen.values(), key=lambda item: -item['tokens'])
        delegated = sum(item['tokens'] for item in items)
        whole = delegated + int(main_tokens or 0)
        models = {}
        for item in items:
            key = item['model'] or '(未知)'
            if item.get('effort'):
                key = f"{key}·{item['effort']}"
            models[key] = models.get(key, 0) + 1
        return {
            'edges': len(edges),
            'children': len(items),
            'tokens': delegated,
            'share_pct': pct(delegated, whole) if whole else None,
            'items': items,
            'models': [{'model': name, 'count': count} for name, count in sorted(models.items(), key=lambda kv: -kv[1])],
        }
    except sqlite3.Error:
        return None
    finally:
        con.close()


def window_turns(turns, limit=None, focus=None):
    """取轮次窗口：默认最近 MAX_TURNS；limit<=0 取全部；focus 保证被展开的轮次在窗口内。

    这是 1.0.x 的旧语义，保留给旧面板/旧参数兼容；新面板用 page_turns。
    """
    total = len(turns)
    lim = MAX_TURNS if limit is None else int(limit)
    if focus is not None:
        # focus 是 1-based 轮次号：窗口要从第 focus 轮开始取，才能包含它
        lim = max(lim, total - int(focus) + 1)
    if lim <= 0 or lim >= total:
        return list(turns), total, lim
    return list(turns[-lim:]), total, lim


def page_turns(turns, from_turn=None, count=None):
    """按 1-based 轮次号取一页；from_turn 缺省取尾部 count 轮。

    返回 (shown, window) —— window 里带 from/to/total/has_earlier/has_later，
    面板据此决定"还能不能往上加载"和标注区间。
    """
    total = len(turns)
    size = PAGE_COUNT_DEFAULT if count is None else int(count)
    size = max(1, min(size, PAGE_COUNT_MAX))
    if from_turn is None or from_turn == 'tail':
        end = total
        start = max(1, total - size + 1)
    else:
        start = max(1, min(int(from_turn), total + 1))
        end = min(total, start + size - 1)
    if start > total:  # 会话变短/轮次被裁剪后仍可能越界
        start = max(1, total - size + 1)
        end = total
    window = {
        'from': start if total else 0,
        'to': end,
        'total': total,
        'has_earlier': start > 1,
        'has_later': end < total,
    }
    return list(turns[start - 1:end]), window


def build_outline(turns):
    """全量轻量目录：每轮只带编号/步数/耗时/两段预览（DSH turnOutline 的等价物）。"""
    outline = []
    for turn in turns:
        text = (turn.get('user_text') or '').strip()
        reply = (turn.get('assistant_text') or '').strip()
        outline.append({
            'turn': turn.get('index'),
            'steps': turn.get('steps'),
            'duration_ms': turn.get('duration_ms'),
            'running': bool(turn.get('running')),
            'user_preview': text[:OUTLINE_PROMPT_LIMIT],
            'assistant_preview': reply[:OUTLINE_RESPONSE_LIMIT],
            'preview_truncated': len(text) > OUTLINE_PROMPT_LIMIT or len(reply) > OUTLINE_RESPONSE_LIMIT,
        })
    return outline


def payload_for(thread_id, limit=None, focus=None, view=None, from_turn=None, count=None):
    row = thread_row(thread_id)
    if row is None:
        return {'ok': False, 'reason': 'not_found', 'thread_id': thread_id}
    path = row['path']
    if path is None or not path.is_file():
        return {'ok': False, 'reason': 'rollout_missing', 'thread_id': thread_id,
                'thread': {'id': row['id'], 'title': row['title'], 'model': row['model']}}
    key = str(path)
    state = READERS.get(key)
    if state is None:
        state = new_state()
        if len(READERS) >= MAX_READERS:
            READERS.pop(next(iter(READERS)))
        READERS[key] = state
    read_appended(state, path)
    turns = build_turns(state)
    summary = build_summary(state, turns, thread_id)
    summary['subagents'] = subagent_graph(thread_id, (summary.get('total') or {}).get('total_tokens'))
    outline = None
    window = None
    if view == 'outline':
        outline = build_outline(turns)
        shown, total_turns, turn_limit = [], len(turns), 0
    elif view == 'items':
        total_turns = len(turns)
        turn_limit = 0
        target = next((item for item in turns if item.get('index') == focus), None)
        shown = [target] if target is not None else []
        window = {'from': focus, 'to': focus, 'total': total_turns,
                  'has_earlier': False, 'has_later': False}
    elif view == 'page':
        shown, window = page_turns(turns, from_turn=from_turn, count=count)
        total_turns = window['total']
        turn_limit = len(shown)
    else:
        shown, total_turns, turn_limit = window_turns(turns, limit, focus)
    if window is None:
        first = shown[0].get('index') if shown else 0
        last = shown[-1].get('index') if shown else 0
        window = {'from': first, 'to': last, 'total': total_turns,
                  'has_earlier': first > 1, 'has_later': last < total_turns}
    return {
        'ok': True,
        'thread': {
            'id': row['id'],
            'thread_id': thread_id,
            'title': row['title'],
            'model': row['model'],
            'updated_at': row['updated_at'],
            'source': row['source'],
        },
        'summary': summary,
        'turns': shown,
        'outline': outline,
        'meta': {
            'parse_errors': state['parse_errors'],
            'file_bytes': state['offset'],
            'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            # 面板据此显示"共 N 轮 / 已加载第 X–Y 轮"、决定能否继续向上加载
            'total_turns': total_turns,
            'shown_turns': len(shown),
            'turn_limit': turn_limit,
            'window_from': window['from'],
            'window_to': window['to'],
            'has_earlier': window['has_earlier'],
            'has_later': window['has_later'],
        },
    }


TOOL = {
    'name': 'show_session_dashboard',
    'title': '会话仪表盘',
    'description': ('Open the read-only session dashboard for the current conversation: '
                    'turns, steps, token usage, cache hit rate, context usage and per-turn timings.'),
    'inputSchema': {
        'type': 'object',
        'properties': {
            'thread_id': {'type': 'string', 'description': 'Optional explicit thread UUID; defaults to the current conversation.'},
            'view': {'type': 'string', 'enum': ['page', 'outline', 'items'],
                     'description': 'page: one window of turns; outline: lightweight directory of all turns; '
                                    'items: step items of one turn (requires items_for). Omit for legacy tail window.'},
            'from_turn': {'type': 'integer', 'description': '1-based first turn of a page; omit for the tail page.'},
            'count': {'type': 'integer', 'description': 'Turns per page (1..60, default 30).'},
            'turns_limit': {'type': 'integer',
                            'description': 'Legacy: how many recent turns to return; 0 means all. Defaults to 60.'},
            'items_for': {'type': 'integer',
                          'description': 'Only include step items for this 1-based turn index (used to expand one row).'},
            'include_items': {'type': 'boolean', 'description': 'Set false to return turn summaries without step items.'},
            'include_details': {'type': 'boolean', 'description': 'Set true to include full command/output details.'},
        },
        'additionalProperties': False,
    },
    'annotations': {'readOnlyHint': True, 'destructiveHint': False, 'idempotentHint': True, 'openWorldHint': False},
    '_meta': {
        'ui': {'resourceUri': URI},
        'openai/ui': {'entrypoints': [{'type': 'thread'}], 'preferredModelDisplayMode': 'fullscreen'},
    },
}


def dashboard_result(params):
    thread_id = resolve_thread_id(params)
    if thread_id is None:
        return {
            'content': [{'type': 'text', 'text': '无法识别当前会话：请在 Codex 会话内打开此面板。'}],
            'isError': True,
        }
    args = (params or {}).get('arguments') or {}
    if not isinstance(args, dict):
        args = {}
    items_for = args.get('items_for')
    try:
        items_for = int(items_for) if items_for is not None else None
    except (TypeError, ValueError):
        items_for = None
    turns_limit = args.get('turns_limit')
    try:
        turns_limit = int(turns_limit) if turns_limit is not None else None
    except (TypeError, ValueError):
        turns_limit = None
    view = args.get('view')
    if view not in ('page', 'outline', 'items'):
        view = None
    from_turn = args.get('from_turn')
    try:
        from_turn = int(from_turn) if from_turn is not None else None
    except (TypeError, ValueError):
        from_turn = None
    count = args.get('count')
    try:
        count = int(count) if count is not None else None
    except (TypeError, ValueError):
        count = None
    try:
        data = payload_for(thread_id, limit=turns_limit, focus=items_for,
                           view=view, from_turn=from_turn, count=count)
    except (OSError, sqlite3.Error):
        return {
            'content': [{'type': 'text', 'text': '读取本地会话记录失败，请稍后重试。'}],
            'isError': True,
        }
    if not data.get('ok'):
        reason = data.get('reason')
        text = '找不到该会话的本地记录。' if reason == 'not_found' else '该会话的本地记录文件不可用。'
        return {'content': [{'type': 'text', 'text': text}], 'isError': True}
    include_items = args.get('include_items', True) is not False
    include_details = args.get('include_details') is True
    if not include_items or items_for is not None:
        for turn in data.get('turns', []):
            if items_for is not None and turn['index'] == items_for:
                continue
            turn['items'] = []
    if not include_details:
        for turn in data.get('turns', []):
            for item in turn.get('items', []):
                item.pop('detail', None)
    return {
        'content': [{'type': 'text', 'text': '会话统计已生成。'}],
        'structuredContent': data,
        '_meta': {'ui': {'resourceUri': URI}, 'openai/outputTemplate': URI},
    }


def dispatch(method, params):
    if method == 'initialize':
        return {
            'protocolVersion': '2025-06-18',
            'capabilities': {'tools': {}, 'resources': {}},
            'serverInfo': {'name': 'session-dashboard', 'version': '0.2.0'},
        }
    if method == 'ping':
        return {}
    if method == 'tools/list':
        return {'tools': [TOOL]}
    if method == 'resources/list':
        return {'resources': [{
            'uri': URI,
            'name': 'Session dashboard',
            'mimeType': 'text/html;profile=mcp-app',
        }]}
    if method == 'resources/templates/list':
        return {'resourceTemplates': []}
    if method == 'resources/read':
        if (params or {}).get('uri') != URI:
            raise ValueError('unsupported resource')
        html = (ROOT / 'panel.html').read_text(encoding='utf-8')
        return {'contents': [{
            'uri': URI,
            'mimeType': 'text/html;profile=mcp-app',
            'text': html,
            '_meta': {
                'openai/ui': {'availableDisplayModes': ['fullscreen'], 'preferredDisplayMode': 'fullscreen'},
                # 不要声明 ui.csp：一旦声明，宿主就会给 iframe 套上严格 CSP，
                # 而内联脚本不在白名单里，整个面板会被拦成空白（实测）。
            },
        }]}
    if method == 'tools/call':
        if (params or {}).get('name') != TOOL['name']:
            raise KeyError('unknown tool')
        return dashboard_result(params)
    raise ValueError('unsupported method')


def main():
    if '--snapshot' in sys.argv:
        tid = None
        for argv in sys.argv[1:]:
            try:
                tid = str(uuid.UUID(argv))
            except ValueError:
                continue
        if tid is None:
            print(json.dumps({'error': 'pass a thread UUID'}, ensure_ascii=True))
            return
        print(json.dumps(payload_for(tid), ensure_ascii=True, indent=1))
        return

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            print(json.dumps({'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'invalid json'}}), flush=True)
            continue
        if 'id' not in request:
            continue
        try:
            result = dispatch(request.get('method'), request.get('params') or {})
            response = {'jsonrpc': '2.0', 'id': request['id'], 'result': result}
        except (KeyError, ValueError):
            response = {'jsonrpc': '2.0', 'id': request['id'], 'error': {'code': -32601, 'message': 'unsupported request'}}
        except (OSError, sqlite3.Error):
            response = {'jsonrpc': '2.0', 'id': request['id'], 'error': {'code': -32603, 'message': 'local session unavailable'}}
        print(json.dumps(response, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    main()
