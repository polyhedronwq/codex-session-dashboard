"""文档与代码的一致性检查：README 里写的参数必须和源码常量对得上。

参数表一旦和代码脱节，比没有文档更糟——用户照着调，调的是错的。
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# (README 里应出现的写法, 源码里应出现的常量写法, 源码文件)
CHECKS = [
    ('1000 ms', 'REFRESH_MS = 1000', 'src/bar/injector.js'),
    ('5000 ms', 'IDLE_REFRESH_MS = 5000', 'src/bar/injector.js'),
    ('30 s', 'IDLE_AFTER_MS = 30000', 'src/bar/injector.js'),
    ('60 s', 'writtenAt < 60000', 'src/bar/injector.js'),
    ('4000 ms', 'REFRESH_MS = 4000', 'src/shared/panel.html'),
    ('30000 ms', 'IDLE_MS = 30000', 'src/shared/panel.html'),
    ('1500 ms', '}, 1500)', 'src/bar/injected.js'),
    ('1000 ms', 'setInterval(place, 1000)', 'src/bar/injected.js'),
    ('3600 s', '_QUOTA_TTL_OK = 3600.0', 'src/shared/server.py'),
    ('7200 s', '_QUOTA_TTL_MISSING = 7200.0', 'src/shared/server.py'),
    ('6 s', '_QUOTA_TIMEOUT = 6.0', 'src/shared/server.py'),
    ('200 字', 'plain_text(item, 200)', 'src/shared/server.py'),
    ('400 字', 'plain_text(item, 400)', 'src/shared/server.py'),
    ('4000 字', 'plain_text(item, 4000)', 'src/shared/server.py'),
    ('9223', '9223', 'src/bar/injector.js'),
    ('9224', 'listen(9224', 'src/bar/injector.js'),
]


def main():
    readme = (ROOT / 'README.md').read_text(encoding='utf-8')
    problems = []
    for doc_text, code_text, rel in CHECKS:
        source = (ROOT / rel).read_text(encoding='utf-8')
        if doc_text not in readme:
            problems.append(f'README 缺少「{doc_text}」')
        elif code_text not in source:
            problems.append(f'{rel} 里找不到「{code_text}」')
    for item in problems:
        print('  ✗ ' + item)
    if not problems:
        print(f'  文档与代码一致：{len(CHECKS)} 项参数')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
