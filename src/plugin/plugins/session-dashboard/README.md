# 会话仪表盘（Codex 本地插件）

只读读取当前 Codex 会话的本地 rollout 记录，以 MCP App 面板展示轮次、步数、token、缓存命中、上下文和每轮耗时。

## 用法

1. 重启 Codex（改过 `server.py` / `panel.html` 后都需要重启，因为 MCP server 常驻）。
2. 在任意会话里说「打开会话仪表盘」或「调用 show_session_dashboard」。
3. 面板顶部可切换「概览 / 统计 / 轨迹 / 代理」；统计页点一行展开每一步，轨迹页可搜索、展开时间条、折叠连续同类调用，点单条记录看命令/输出/参数/正文（带语法着色），代理页看子代理图、工作足迹与代理间消息。

## 数据与隐私

- 只读：`~/.codex/state_5.sqlite` 的 `threads` 表 + 该会话的 `rollout-*.jsonl`。
- 返回数字与时间、命令/文件名短标签、对话摘要，以及展开记录时的命令/输出/参数/正文（单段截断 4,000 字符）；不上传、不落盘。
- 会话绑定优先取每次 `tools/call` 的 `_meta.threadId`，依次回退 `_meta.thread_id`、`arguments.thread_id`、底栏写入的 `localStorage.dsh.currentThread`；都没有才报"无法识别会话"。

## 文件

| 文件 | 作用 |
|---|---|
| `server.py` | MCP stdio server：`show_session_dashboard` 工具 + `ui://session-dashboard/dashboard.html` 资源 |
| `panel.html` | MCP App 面板（概览 / 统计 / 轨迹 / 代理四页） |
| `.mcp.json` | 启动命令（Python 绝对路径 + `server.py` 绝对路径） |
| `.codex-plugin/plugin.json` | 插件清单 |

## 维护

- 改 `server.py` / `panel.html`：保存后重启 Codex 即可生效（`.mcp.json` 指向源码目录，不走缓存副本）。
- 改了 `plugin.json`（版本、名称）或移动了目录：重新执行
  `codex plugin add session-dashboard@codex-dashboard-local`。
- 卸载：`codex plugin remove session-dashboard@codex-dashboard-local`。

## 已知限制

- 速度是「每轮生成均速」（输出 token ÷（总用时 − 首 token 延迟）），不是流式瞬时值。
- 数据来自落盘记录，轮结束后 1–2 秒才可见；面板运行中每 4 秒自动拉一次轻量数据，静止 30 秒后降到 30 秒，展开的行单独补取明细。
- 统计 / 轨迹默认显示最近 60 轮。
- 面板自己的刷新调用不会写入会话记录（App 发起的 MCP 调用不生成 tool call item）。
- 桌面版界面里没有常驻底栏位置，入口是会话内的面板。
