"""解析层单元测试：直接构造 rollout JSONL，验证统计口径。

    python verify\test_server.py
"""
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest


def load_server():
    path = pathlib.Path(__file__).resolve().parent.parent / 'src' / 'shared' / 'server.py'
    spec = importlib.util.spec_from_file_location('srv', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SRV = load_server()


def rec(kind, payload):
    return json.dumps({'type': kind, 'timestamp': '2026-11-19T00:00:00Z', 'payload': payload})


def task_started(turn_id, started_at=1000):
    return rec('event_msg', {
        'type': 'task_started',
        'turn_id': turn_id,
        'started_at': started_at,
        'turn_attribution': {'turn_trigger': 'user'},
    })


def task_complete(turn_id, duration=5000, ttft=800):
    return rec('event_msg', {
        'type': 'task_complete',
        'turn_id': turn_id,
        'duration_ms': duration,
        'time_to_first_token_ms': ttft,
    })


def usage(turn_id, thread_totals=None, **kwargs):
    base = {
        'input_tokens': 100,
        'cached_input_tokens': 40,
        'output_tokens': 10,
        'reasoning_output_tokens': 0,
        'total_tokens': 110,
    }
    base.update(kwargs)
    payload = {'thread_id': 't', 'turn_id': turn_id, 'usage': base}
    # 总量不是逐条相加：Codex 在 thread_token_usage 里给的是累计值
    if thread_totals is not None:
        payload['thread_token_usage'] = thread_totals
    return rec('token_usage_record', payload)


def token_count(input_tokens, cached, output, window=258400):
    return rec('event_msg', {
        'type': 'token_count',
        'info': {'model_context_window': window},
        'rate_limits': {
            'limit_id': 'codex',
            'primary': {'used_percent': 50.0, 'window_minutes': 10080, 'resets_at': 1},
        },
        'usage': {'input_tokens': input_tokens, 'cached_input_tokens': cached, 'output_tokens': output},
    })


class ParseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile('w', suffix='.jsonl', delete=False, encoding='utf-8')
        self.tmp.close()
        self.path = pathlib.Path(self.tmp.name)
        self.state = SRV.new_state()

    def tearDown(self):
        try:
            self.path.unlink()
        except OSError:
            pass

    def write(self, *lines):
        self.path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
        SRV.read_appended(self.state, self.path)

    # ---- 轮次与步数 ----
    def test_turn_and_steps(self):
        self.write(
            task_started('turn-a'),
            usage('turn-a'),
            usage('turn-a'),
            task_complete('turn-a'),
        )
        turns = SRV.build_turns(self.state)
        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0]['steps'], 2)
        self.assertFalse(turns[0]['running'])

    def test_running_turn_has_no_duration(self):
        self.write(task_started('turn-b'), usage('turn-b'))
        turns = SRV.build_turns(self.state)
        self.assertTrue(turns[0]['running'])

    # ---- token 汇总 ----
    def test_token_accumulation_and_cache_pct(self):
        self.write(
            task_started('turn-c'),
            usage('turn-c', thread_totals={'input_tokens': 100, 'cached_input_tokens': 40, 'output_tokens': 10, 'total_tokens': 110},
                  input_tokens=100, cached_input_tokens=40, output_tokens=10, total_tokens=110),
            usage('turn-c', thread_totals={'input_tokens': 200, 'cached_input_tokens': 100, 'output_tokens': 30, 'total_tokens': 230},
                  input_tokens=100, cached_input_tokens=60, output_tokens=20, total_tokens=120),
            task_complete('turn-c'),
        )
        summary = SRV.build_summary(self.state, SRV.build_turns(self.state), 't')
        self.assertEqual(summary['total']['input_tokens'], 200)
        self.assertEqual(summary['total']['cached_input_tokens'], 100)
        self.assertEqual(summary['total']['output_tokens'], 30)
        # 缓存命中率 = 缓存输入 / 输入
        self.assertAlmostEqual(summary['cache_hit_pct'], 50.0, places=2)

    def test_context_usage_from_token_count(self):
        self.write(
            task_started('turn-d'),
            token_count(12345, 6000, 100),
            usage('turn-d', input_tokens=12345, cached_input_tokens=6000, output_tokens=100),
            task_complete('turn-d'),
        )
        summary = SRV.build_summary(self.state, SRV.build_turns(self.state), 't')
        self.assertEqual(summary['context']['window'], 258400)
        self.assertIsNotNone(summary['context']['pct'])
        # 服务端 pct() 保留一位小数，这里按它的口径校验
        self.assertAlmostEqual(summary['context']['pct'], 12345 / 258400 * 100, delta=0.1)

    # ---- 额度 ----
    def test_quota_payload_only_exposes_api(self):
        self.write(task_started('turn-e'), token_count(100, 0, 10), task_complete('turn-e'))
        summary = SRV.build_summary(self.state, SRV.build_turns(self.state), 't')
        self.assertEqual(sorted(summary['quota'].keys()), ['api'])

    def test_quota_survives_api_failure(self):
        self.write(task_started('turn-f'), token_count(100, 0, 10), task_complete('turn-f'))
        original = SRV.api_thread_quota
        SRV.api_thread_quota = lambda *a, **k: None
        try:
            summary = SRV.build_summary(self.state, SRV.build_turns(self.state), 'turn-f')
            self.assertIsNone(summary['quota']['api'])
        finally:
            SRV.api_thread_quota = original

    # ---- 增量读取 ----
    def test_incremental_read_only_parses_new_lines(self):
        self.write(task_started('turn-g'), usage('turn-g'))
        first_offset = self.state['offset']
        self.assertGreater(first_offset, 0)

        with self.path.open('a', encoding='utf-8') as handle:
            handle.write(usage('turn-g') + '\n')
        SRV.read_appended(self.state, self.path)
        self.assertGreater(self.state['offset'], first_offset)

        turns = SRV.build_turns(self.state)
        self.assertEqual(turns[0]['steps'], 2)

    def test_half_line_is_buffered_not_lost(self):
        full = usage('turn-h')
        head, tail = full[:20], full[20:]
        self.path.write_text(task_started('turn-h') + '\n' + head, encoding='utf-8')
        SRV.read_appended(self.state, self.path)
        # 半行不应被解析成一条记录
        self.assertEqual(SRV.build_turns(self.state)[0]['steps'], 0)

        with self.path.open('a', encoding='utf-8') as handle:
            handle.write(tail + '\n')
        SRV.read_appended(self.state, self.path)
        self.assertEqual(SRV.build_turns(self.state)[0]['steps'], 1)

    def test_truncated_file_resets_baseline(self):
        self.write(task_started('turn-i'), usage('turn-i'))
        self.path.write_text(task_started('turn-j') + '\n', encoding='utf-8')
        SRV.read_appended(self.state, self.path)
        turns = SRV.build_turns(self.state)
        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0]['id'], 'turn-j')

    # ---- 健壮性 ----
    def test_malformed_line_is_counted_not_fatal(self):
        self.write(task_started('turn-k'), '{not json', task_complete('turn-k'))
        self.assertGreaterEqual(self.state['parse_errors'], 1)
        self.assertEqual(len(SRV.build_turns(self.state)), 1)

    def test_aborted_turn_is_marked(self):
        self.write(
            task_started('turn-l'),
            usage('turn-l'),
            rec('event_msg', {'type': 'turn_aborted', 'turn_id': 'turn-l'}),
        )
        turns = SRV.build_turns(self.state)
        self.assertTrue(turns[0]['aborted'])

class BranchTests(unittest.TestCase):
    """P2：事件类型与失败分支。"""

    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile('w', suffix='.jsonl', delete=False, encoding='utf-8')
        self.tmp.close()
        self.path = pathlib.Path(self.tmp.name)
        self.state = SRV.new_state()

    def tearDown(self):
        try:
            self.path.unlink()
        except OSError:
            pass

    def write(self, *lines):
        self.path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
        SRV.read_appended(self.state, self.path)

    def test_turn_context_records_settings_change(self):
        first = rec('turn_context', {
            'cwd': 'D:/w', 'model': 'gpt-6.2-astra', 'effort': 'low',
            'approval_policy': 'on-request', 'sandbox_policy': {'type': 'workspace-write', 'network_access': False},
        })
        second = rec('turn_context', {
            'cwd': 'D:/w', 'model': 'gpt-6.2-astra', 'effort': 'high',
            'approval_policy': 'on-request', 'sandbox_policy': {'type': 'workspace-write', 'network_access': False},
        })
        self.write(first, second)
        summary = SRV.build_summary(self.state, SRV.build_turns(self.state), 't')
        changes = summary['settings_changes']
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]['changes'][0]['field'], 'effort')
        self.assertEqual(changes[0]['before']['effort'], 'low')
        self.assertEqual(changes[0]['after']['effort'], 'high')

    def test_world_state_records_agents_md(self):
        self.write(rec('world_state', {'state': {'agents_md': {'text': 'rules-here' * 10}}}))
        summary = SRV.build_summary(self.state, SRV.build_turns(self.state), 't')
        self.assertIsNotNone(summary['rules'])
        self.assertEqual(summary['rules']['file'], 'AGENTS.md')
        self.assertEqual(summary['rules']['chars'], 100)

    def test_compacted_increases_count(self):
        self.write(rec('compacted', {}), rec('compacted', {}))
        summary = SRV.build_summary(self.state, SRV.build_turns(self.state), 't')
        self.assertEqual(summary['compactions'], 2)

    def test_rollout_missing_reason(self):
        original = SRV.thread_row
        SRV.thread_row = lambda tid: {'id': tid, 'title': 'x', 'model': 'm', 'path': None,
                                      'updated_at': None, 'source': None}
        try:
            data = SRV.payload_for('00000000-0000-0000-0000-000000000000')
            self.assertFalse(data['ok'])
            self.assertEqual(data['reason'], 'rollout_missing')
        finally:
            SRV.thread_row = original

    def test_invalid_cache_key_not_written(self):
        cache_file = SRV._QUOTA_CACHE_FILE
        backup = cache_file.read_text(encoding='utf-8') if cache_file.exists() else None
        try:
            SRV._quota_cache_write('t', {'weekly_percent': 1.0})
            data = json.loads(cache_file.read_text(encoding='utf-8')) if cache_file.exists() else {}
            self.assertNotIn('t', data, '非法 key 不应写入额度缓存')
        finally:
            if backup is None:
                if cache_file.exists():
                    cache_file.unlink()
            else:
                cache_file.write_text(backup, encoding='utf-8')



class QuotaCacheTests(unittest.TestCase):
    """P8：额度接口失败/缓存分支——超时必须回退，缓存命中不能白发请求。"""

    THREAD = '11111111-2222-3333-4444-555555555555'

    def setUp(self):
        import time
        self.time = time
        self.tmpdir = tempfile.TemporaryDirectory()
        self.cache = pathlib.Path(self.tmpdir.name) / 'quota-cache.json'
        self._orig_file = SRV._QUOTA_CACHE_FILE
        self._orig_auth = SRV._auth_tokens
        self._orig_urlopen = SRV.urllib.request.urlopen
        SRV._QUOTA_CACHE_FILE = self.cache
        SRV._QUOTA_CACHE.clear()
        SRV._auth_tokens = lambda: ('fake-access-token', 'fake-account')
        self.calls = []

    def tearDown(self):
        SRV.urllib.request.urlopen = self._orig_urlopen
        SRV._auth_tokens = self._orig_auth
        SRV._QUOTA_CACHE_FILE = self._orig_file
        SRV._QUOTA_CACHE.clear()
        self.tmpdir.cleanup()

    def _urlopen_raises(self, error):
        def _open(*args, **kwargs):
            self.calls.append(args)
            raise error
        SRV.urllib.request.urlopen = _open

    def _urlopen_payload(self, weekly):
        class Response:
            def __init__(self, body):
                self.body = body

            def read(self):
                return self.body

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def _open(*args, **kwargs):
            self.calls.append(args)
            body = json.dumps({
                'threads': [{'weekly_limit_percent': weekly, 'five_hour_limit_percent': None,
                             'data_status': 'partial', 'balance_usage_credits': 1}],
                'data_as_of': '2026-11-23T00:00:00Z',
            }).encode('utf-8')
            return Response(body)

        SRV.urllib.request.urlopen = _open

    def test_quota_timeout_falls_back_to_none(self):
        self._urlopen_raises(TimeoutError('timed out'))
        self.assertIsNone(SRV.api_thread_quota(self.THREAD, force=True))
        self.assertEqual(len(self.calls), 1, '超时只应尝试一次')
        # 结果写入缓存（None 也缓存），TTL 内不再打网络
        self.assertIsNone(SRV.api_thread_quota(self.THREAD))
        self.assertEqual(len(self.calls), 1, '失败结果在 TTL 内应复用，不再请求')
        # 面板/底栏拿到的令牌是 null，而不是异常
        summary = SRV.build_summary(SRV.new_state(), [], self.THREAD)
        self.assertIsNone(summary['quota']['api'])

    def test_quota_inprocess_cache_skips_network(self):
        result = {'weekly_percent': 3.5, 'five_hour_percent': None, 'data_status': 'partial', 'data_as_of': None}
        SRV._QUOTA_CACHE[self.THREAD] = (self.time.time(), result)
        self._urlopen_raises(AssertionError('进程内缓存命中不应发网络请求'))
        self.assertEqual(SRV.api_thread_quota(self.THREAD), result)

    def test_quota_disk_cache_skips_network(self):
        self.cache.write_text(json.dumps({
            self.THREAD: {'ts': self.time.time(), 'result': {'weekly_percent': 7.0}},
        }), encoding='utf-8')
        self._urlopen_raises(AssertionError('磁盘缓存命中不应发网络请求'))
        self.assertEqual(SRV.api_thread_quota(self.THREAD)['weekly_percent'], 7.0)

    def test_quota_expired_disk_cache_refetches(self):
        self.cache.write_text(json.dumps({
            self.THREAD: {'ts': self.time.time() - 10 * 3600, 'result': {'weekly_percent': 7.0}},
        }), encoding='utf-8')
        self._urlopen_payload(9.5)
        got = SRV.api_thread_quota(self.THREAD)
        self.assertEqual(len(self.calls), 1, '过期缓存必须重新请求')
        self.assertEqual(got['weekly_percent'], 9.5)


class ResponseItemTests(unittest.TestCase):
    """P8：response_item 与 event_msg/item_completed 并存时不能重复计数。

    Codex 的 rollout 里同一个工具调用会同时以 response_item 和 item_completed 出现；
    仪表盘只认 item_completed。补解析时最容易踩的坑就是把两边都算一遍。
    """

    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile('w', suffix='.jsonl', delete=False, encoding='utf-8')
        self.tmp.close()
        self.path = pathlib.Path(self.tmp.name)
        self.state = SRV.new_state()
        self._orig_quota = SRV.api_thread_quota
        SRV.api_thread_quota = lambda *args, **kwargs: None

    def tearDown(self):
        SRV.api_thread_quota = self._orig_quota
        try:
            self.path.unlink()
        except OSError:
            pass

    def write(self, *lines):
        self.path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
        SRV.read_appended(self.state, self.path)

    def item_completed(self, turn_id, item):
        return rec('event_msg', {
            'type': 'item_completed', 'turn_id': turn_id, 'item': item,
            'started_at_ms': 1000, 'completed_at_ms': 1500,
        })

    def test_response_item_tool_not_double_counted(self):
        command = {'type': 'CommandExecution', 'command': ['echo', 'hi'], 'status': 'completed', 'exit_code': 0}
        self.write(
            task_started('turn-r'),
            self.item_completed('turn-r', command),
            rec('response_item', {'type': 'custom_tool_call', 'name': 'shell', 'input': 'echo hi'}),
            rec('response_item', {'type': 'function_call', 'name': 'shell', 'arguments': '{}'}),
            task_complete('turn-r'),
        )
        turns = SRV.build_turns(self.state)
        self.assertEqual(len(turns), 1)
        self.assertEqual(len(turns[0]['items']), 1, '同一工具只能记一次（只认 item_completed）')
        self.assertEqual(turns[0]['items'][0]['type'], 'CommandExecution')
        self.assertEqual(turns[0]['tool_counts'], {'CommandExecution': 1})
        summary = SRV.build_summary(self.state, turns, 'turn-r')
        self.assertEqual(summary['footprint']['commands'], 1)

    def test_response_item_message_not_double_counted(self):
        user = {'type': 'UserMessage', 'content': [{'type': 'text', 'text': '用户正文'}]}
        agent = {'type': 'AgentMessage', 'content': [{'type': 'text', 'text': '助手正文'}]}
        self.write(
            task_started('turn-s'),
            self.item_completed('turn-s', user),
            self.item_completed('turn-s', agent),
            rec('response_item', {'type': 'message', 'role': 'user',
                                  'content': [{'type': 'input_text', 'text': '用户正文'}]}),
            rec('response_item', {'type': 'message', 'role': 'assistant',
                                  'content': [{'type': 'output_text', 'text': '助手正文'}]}),
            task_complete('turn-s'),
        )
        turns = SRV.build_turns(self.state)
        self.assertEqual(len(turns[0]['items']), 2, '两条消息各记一次')
        self.assertEqual(turns[0]['user_text'], '用户正文')
        self.assertEqual(turns[0]['assistant_text'], '助手正文')
        summary = SRV.build_summary(self.state, turns, 'turn-s')
        self.assertEqual(summary['user_messages'], 1)


class WindowTests(unittest.TestCase):
    """P16：轮次窗口——默认最近 60 轮，但能取全部，且展开旧轮次时窗口包含它。"""

    def test_default_window_keeps_latest_turns(self):
        turns = [{'index': i} for i in range(1, 71)]
        shown, total, limit = SRV.window_turns(turns)
        self.assertEqual(total, 70)
        self.assertEqual(limit, SRV.MAX_TURNS)
        self.assertEqual(len(shown), 60)
        self.assertEqual(shown[0]['index'], 11)

    def test_zero_limit_returns_all(self):
        turns = [{'index': i} for i in range(1, 71)]
        shown, total, _limit = SRV.window_turns(turns, limit=0)
        self.assertEqual(len(shown), 70)
        self.assertEqual(shown[0]['index'], 1)

    def test_focus_makes_window_include_early_turn(self):
        turns = [{'index': i} for i in range(1, 71)]
        shown, _total, _limit = SRV.window_turns(turns, focus=3)
        self.assertEqual(shown[0]['index'], 3)
        self.assertIn(3, [t['index'] for t in shown])


class PageViewTests(unittest.TestCase):
    """P17：分页窗口（page）与全量轻量目录（outline）。"""

    def turns(self, n=79):
        return [{'index': i, 'steps': i % 5, 'user_text': ('u' * i), 'assistant_text': ('a' * i),
                 'duration_ms': 1000 + i, 'running': False} for i in range(1, n + 1)]

    def test_page_tail_default(self):
        shown, window = SRV.page_turns(self.turns(), from_turn=None, count=30)
        self.assertEqual(len(shown), 30)
        self.assertEqual(window['from'], 50)
        self.assertEqual(window['to'], 79)
        self.assertTrue(window['has_earlier'])
        self.assertFalse(window['has_later'])

    def test_page_middle_flags(self):
        shown, window = SRV.page_turns(self.turns(), from_turn=11, count=30)
        self.assertEqual(window['from'], 11)
        self.assertEqual(window['to'], 40)
        self.assertTrue(window['has_earlier'])
        self.assertTrue(window['has_later'])
        self.assertEqual(shown[0]['index'], 11)

    def test_page_clamps(self):
        _, w0 = SRV.page_turns(self.turns(), from_turn=0, count=30)
        self.assertEqual(w0['from'], 1)
        _, w9 = SRV.page_turns(self.turns(), from_turn=999, count=30)
        self.assertEqual(w9['to'], 79)
        self.assertGreaterEqual(w9['from'], 50)
        _, wc = SRV.page_turns(self.turns(), from_turn=1, count=999)
        self.assertEqual(wc['to'], SRV.PAGE_COUNT_MAX)

    def test_outline_is_light_and_complete(self):
        outline = SRV.build_outline(self.turns())
        self.assertEqual(len(outline), 79)
        first = outline[0]
        self.assertEqual(first['turn'], 1)
        self.assertLessEqual(len(first['user_preview']), SRV.OUTLINE_PROMPT_LIMIT)
        self.assertLessEqual(len(first['assistant_preview']), SRV.OUTLINE_RESPONSE_LIMIT)
        self.assertTrue(first['preview_truncated'] is False)


if __name__ == '__main__':
    unittest.main(verbosity=2)
