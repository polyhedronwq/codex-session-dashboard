"""Sanity checks on the dashboard server payload.

    python payload-check.py <server.py> <thread_id> [ok|quota|dump <outfile>]
"""
import importlib.util
import json
import pathlib
import sys


def load(path):
    spec = importlib.util.spec_from_file_location('srv', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if len(sys.argv) < 3:
        print('usage: payload-check.py <server.py> <thread_id> [ok|quota|dump <outfile>]')
        return 2
    server_path = pathlib.Path(sys.argv[1])
    thread_id = sys.argv[2]
    mode = sys.argv[3] if len(sys.argv) > 3 else 'ok'

    module = load(server_path)
    data = module.payload_for(thread_id)

    if mode == 'ok':
        print('ok' if data.get('ok') and data.get('summary') else 'bad')
    elif mode == 'quota':
        print(json.dumps(sorted((data.get('summary') or {}).get('quota', {}).keys())))
    elif mode == 'dump':
        out = pathlib.Path(sys.argv[4])
        out.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        print('ok')
    else:
        print('unknown mode')
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
