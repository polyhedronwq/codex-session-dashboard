"""挑一个"有内容"的会话给回归套件用。

最新会话可能刚建、还没有 rollout 文件，直接拿它会让 harness 生成失败。
这里只挑 rollout 存在且非空的最新一条。
"""
import pathlib
import sqlite3

HOME = pathlib.Path.home()
con = sqlite3.connect('file:' + (HOME / '.codex' / 'state_5.sqlite').as_posix() + '?mode=ro', uri=True)

rows = con.execute(
    """
    select id, rollout_path from threads
    where model not like 'codex-auto-review%'
      and rollout_path is not null
    order by updated_at_ms desc
    limit 40
    """
).fetchall()

for thread_id, rollout in rows:
    if not rollout:
        continue
    path = pathlib.Path(str(rollout).replace('\\\\?\\', ''))
    try:
        if path.is_file() and path.stat().st_size > 2000:
            print(thread_id)
            raise SystemExit(0)
    except OSError:
        continue

print('')
