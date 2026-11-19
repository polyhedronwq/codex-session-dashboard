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


if __name__ == '__main__':
    unittest.main(verbosity=2)
