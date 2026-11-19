"""Data-side facts for diagnose.ps1: database lookups and today's turn triggers.

Prints one JSON object on stdout. Read-only.
"""

import collections
import datetime
import importlib.util
import json
import pathlib
import sqlite3
import sys

HOME = pathlib.Path.home()
CODEX = HOME / '.codex'
BAR = HOME / '.codex-bar'


def load_server():
    spec = importlib.util.spec_from_file_location('srv', BAR / 'server.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def connect():
    return sqlite3.connect('file:' + (CODEX / 'state_5.sqlite').as_posix() + '?mode=ro', uri=True)


def thread_info(con, thread_id):
    if not thread_id:
        return None
    row = con.execute(
        "select id, model, reasoning_effort, tokens_used, rollout_path, updated_at_ms, "
        "substr(coalesce(name, title, ''), 1, 40) from threads where id = ?", (thread_id,)
    ).fetchone()
    if not row:
        return {'id': thread_id, 'found': False}
    path = pathlib.Path(str(row[4] or '').replace('\\\\?\\', ''))
    return {
        'id': row[0],
        'found': True,
        'model': row[1],
        'effort': row[2],
        'tokens_used': row[3],
        'rollout_exists': path.is_file(),
        'rollout_size': path.stat().st_size if path.is_file() else None,
        'updated_at': datetime.datetime.fromtimestamp((row[5] or 0) / 1000).strftime('%m-%d %H:%M:%S'),
        'name': row[6],
    }


def triggers_today():
    sessions = CODEX / 'sessions'
    today = datetime.date.today()
    cutoff = datetime.datetime(today.year, today.month, today.day).timestamp()
    counts = collections.Counter()
    non_user = []
    for path in sessions.rglob('*.jsonl'):
        try:
            if path.stat().st_mtime < cutoff:
                continue
        except OSError:
            continue
        for line in path.open(encoding='utf-8', errors='replace'):
            if 'task_started' not in line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            payload = rec.get('payload') or {}
            if payload.get('type') != 'task_started':
                continue
            started = payload.get('started_at')
            if not isinstance(started, (int, float)) or started < cutoff:
                continue
            trigger = str((payload.get('turn_attribution') or {}).get('turn_trigger') or 'user')
            counts[trigger] += 1
            if trigger != 'composer':
                non_user.append({
                    'time': datetime.datetime.fromtimestamp(started).strftime('%H:%M:%S'),
                    'trigger': trigger,
                })
    return {'counts': dict(counts), 'nonComposer': non_user[:12]}


def main():
    report = {'ok': True}
    server = load_server()
    con = connect()

    # what the bar says it resolved, handed in by diagnose.ps1
    arg = sys.argv[1] if len(sys.argv) > 1 else ''
    report['resolvedThread'] = thread_info(con, arg) if arg else None

    # resolver behaviour for the two real-world inputs
    report['resolver'] = {
        'placeholderOnly': server.resolve_thread_id(
            {'_meta': {'threadId': 'client-new-thread:00000000-0000-0000-0000-000000000000'}}),
        'placeholderWithArgs': server.resolve_thread_id({
            '_meta': {'threadId': 'client-new-thread:00000000-0000-0000-0000-000000000000'},
            'arguments': {'thread_id': arg or ''}}),
        'plainPlaceholder': server.resolve_thread_id(
            {'_meta': {'threadId': 'client-new-thread:abc'}}),
    }

    # can the panel actually load this conversation?
    if arg:
        try:
            data = server.payload_for(arg)
            summary = data.get('summary') or {}
            report['payload'] = {
                'ok': data.get('ok'),
                'reason': data.get('reason'),
                'turns': summary.get('turns'),
                'steps': summary.get('steps'),
            }
        except Exception as error:  # keep the report coming
            report['payload'] = {'ok': False, 'reason': f'{error.__class__.__name__}: {error}'}

    report['triggers'] = triggers_today()

    # newest threads, to spot "the conversation exists but under another id"
    rows = con.execute(
        "select id, model, created_at_ms, substr(coalesce(name, title, ''), 1, 28) from threads "
        "where model not like 'codex-auto-review%' order by created_at_ms desc limit 5"
    ).fetchall()
    report['newestThreads'] = [
        {'id': r[0], 'model': r[1],
         'created': datetime.datetime.fromtimestamp((r[2] or 0) / 1000).strftime('%m-%d %H:%M'),
         'name': r[3]} for r in rows
    ]

    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
