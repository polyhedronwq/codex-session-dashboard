"""Line-daemon: stdin {"id":n,"thread":"<uuid>"} -> stdout {"id":n,"data":{...}}.

Reuses the dashboard server's incremental reader so repeated refreshes stay cheap.
"""
import importlib.util
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
SERVER = HERE / 'server.py'
if not SERVER.exists():
    SERVER = HERE.parent / 'plugin-market' / 'plugins' / 'session-dashboard' / 'server.py'

spec = importlib.util.spec_from_file_location('dashboard_server', SERVER)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')


def trim_turn(turn):
    return {
        'id': turn.get('id', ''),
        'index': turn['index'],
        'running': turn['running'],
        'steps': turn['steps'],
        'tokens': {k: turn['tokens'].get(k, 0) for k in
                   ('input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_output_tokens', 'total_tokens')},
        'cache_hit_pct': turn['cache_hit_pct'],
        'speed': turn['speed'],
        'duration_ms': turn['duration_ms'],
        'ttft_ms': turn['ttft_ms'],
        'tool_ms': turn['tool_ms'],
        'model_ms': turn['model_ms'],
        'item_count': turn['item_count'],
    }


def slim_subagents(sub):
    """Only what the bar popover needs: how many, and how much was delegated."""
    if not sub or not sub.get('children'):
        return None
    return {
        'edges': sub.get('edges', 0),
        'children': sub.get('children', 0),
        'tokens': sub.get('tokens', 0),
        'share_pct': sub.get('share_pct'),
    }


BAR_CHANGE_FIELDS = {'model', 'effort', 'approval_policy', 'sandbox'}


def slim_changes(changes, limit=3):
    """The most recent model/effort/approval/sandbox switches, for the bar popover."""
    if not changes:
        return []
    picked = []
    for entry in reversed(changes):
        if len(picked) >= limit:
            break
        diffs = [c for c in (entry.get('changes') or []) if c.get('field') in BAR_CHANGE_FIELDS]
        if not diffs:
            continue
        picked.append({
            'ts': entry.get('ts'),
            'after_turns': entry.get('after_turns'),
            'before': entry.get('before'),
            'after': entry.get('after'),
            'changes': [
                {'field': c['field'], 'from': c.get('from'), 'to': c.get('to')}
                for c in diffs
            ],
        })
    return picked


def build(thread):
    data = server.payload_for(thread)
    if not data.get('ok'):
        return {'ok': False, 'reason': data.get('reason', 'unknown')}
    summary = data['summary']
    row = server.thread_row(thread) or {}
    rollout = str(row.get('path') or '')
    return {
        'ok': True,
        'thread': {
            'id': data['thread']['id'],
            'title': data['thread']['title'],
            'model': data['thread']['model'],
            'updated_at': data['thread']['updated_at'],
            'path': rollout.replace('\\\\?\\', ''),
        },
        'summary': {
            'turns': summary['turns'],
            'steps': summary['steps'],
            'running': summary['running'],
            'cache_hit_pct': summary['cache_hit_pct'],
            'total': summary['total'],
            'context': summary['context'],
            'quota': summary['quota'],
            'compactions': summary['compactions'],
            'subagents': slim_subagents(summary.get('subagents')),
            'changes': slim_changes(summary.get('settings_changes')),
            'last_turn': trim_turn(summary['last_turn']) if summary.get('last_turn') else None,
            'last_completed': trim_turn(summary['last_completed']) if summary.get('last_completed') else None,
        },
        'turns': [trim_turn(t) for t in data['turns'][-20:]],
    }


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        request_id = request.get('id')
        thread = str(request.get('thread') or '')
        try:
            result = build(thread)
        except Exception as error:  # keep the daemon alive
            result = {'ok': False, 'reason': f'error: {error.__class__.__name__}'}
        print(json.dumps({'id': request_id, 'data': result}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
