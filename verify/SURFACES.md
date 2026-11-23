# 可测试面清单（从实现代码 + 实际渲染反查）

> 生成方式：从 `src/` 源码里的 DOM id / 控件 / 分支 / 脚本 / 外部依赖反查，
> 再用运行中的页面核对实际结构。**不是**从事故事故倒推。

状态说明：✅ 已有断言 · ❌ 无断言

## 一、底栏静态结构（实际渲染树）

```
#dsh-bar-root
├─ span#dsh-health .dsh-health.hide            ✅ 隐藏/显示/异常色
├─ div.dsh-items.dsh-left
│  ├─ button.dsh-item (轮次)                    ✅ 可点开弹窗
│  │  ├─ svg（闪电图标）                        ✅ 16×16
│  │  └─ span#dsh-turns                        ✅ 文本「6 轮 439 步 · 最近 42 tok/s」与分段
│  ├─ span.dsh-sep                             ✅ 存在且可见（1×10）
│  └─ button.dsh-item (token)                   ✅ 可点开弹窗
│     ├─ svg（数据库图标）                      ✅ 16×16
│     └─ span#dsh-tokens                       ✅ 文本、单位、十亿→B、缓存命中百分比
├─ div.dsh-items.dsh-right
│  ├─ button.dsh-item (额度)                    ✅ 可点开弹窗
│  │  └─ span#dsh-quota                        ✅ 有值/仅图标 两种形态
│  ├─ span.dsh-sep                             ✅
│  └─ button.dsh-dash（仪表盘）                  ✅ 图标+文字+aria；❌ 点击是否真打开标签页（SKIP）
├─ div#dsh-pop-turns.dsh-pop                    ✅ 能开且可命中；✅ 内容对账（大数/kv/明细/变更/说明）
├─ div#dsh-pop-tokens.dsh-pop                   ✅ 能开且可命中；✅ 内容对账（大数/千位分隔/缓存条）
└─ div#dsh-pop-quota.dsh-pop                    ✅ 能开且可命中；✅ 无数据时只留图标、5 小时行隐藏
```

弹窗内部结构（三处类似）：`pop-head`（标题 + tag）、`big`（数值 + 单位）、`kv`（若干 dt/dd）、`list`（轮次明细）、`track/fill`（额度条）、`note`（说明文字）——**P7 已逐块对账**。

## 二、底栏行为

| 行为 | 断言要求 | 现状 |
| --- | --- | --- |
| 底栏显示/隐藏 | ok 显示、empty 隐藏、error 亮灰点 | ✅ |
| 弹窗开合 | 点击开、再点关 | ✅ |
| 弹窗互斥 | 开第二个时第一个自动关 | ✅ |
| 点外部关闭 | 点页面任意处关闭 | ✅ |
| Esc 关闭 | 按键关闭 | ✅ |
| 弹窗不超出视口 | 贴右/贴左时不被裁 | ✅ |
| 用量 chip | 每条助手消息一个、图标 13px | ✅ 部分 |
| chip 悬停显隐 | 随 Codex 动作行 hover 出现 | ⚠️ 当前构建动作行常显，"悬停才出现"不可观测；已断言 chip 挂在动作行内（随行同显隐） |
| chip 点击 | 弹出单轮明细 `#dsh-usage-pop` | ✅ |
| 仪表盘按钮 | 点击后右侧出现"会话仪表盘"标签页 | ⚠️ 当前构建标签页不可按文案识别（SKIP） |
| 跟随动画 | 面板开关时位置偏差 < 2px | ✅ |
| 主题 | data-theme light/dark 都能读 | ✅ 底栏与弹窗配色都跟随 |
| 大数格式化 | 十亿 → `1B`、千位分隔 | ✅ 1.2B、1,234,567,890 |
| 空值 | 缺失字段显示 `—` 而不是 NaN | ✅ 并有产品修复：`data_as_of=null` 不再显示成 08:00 |

## 三、面板（panel.html）

### 头部
| 元素 | 现状 |
| --- | --- |
| 标题「会话仪表盘」 | ✅ |
| 模型 chip、会话标题 chip | ✅ |
| 「自动刷新 4s」chip | ✅ |
| 「更新于 …」 | ✅ |
| 「刷新」按钮 | ✅ 发起新请求、文案「刷新中…」→「刷新」、失败显示原因、恢复后回到仪表盘 |

### 页签
| 页签 | 现状 |
| --- | --- |
| 概览 / 统计 / 轨迹 / 代理 切换 | ✅ 渲染可切；✅ 切换后只显示当前页签且内容非空、互不串台 |

### 概览
| 区块 | 现状 |
| --- | --- |
| 6 张卡片（轮次/速度/累计/缓存/上下文/额度）数值 | ✅ 数值对账 |
| 6 张卡片的 cap 文案（含「截至 xx（本地）」） | ✅ |
| 最近一轮 kv（输入/输出/推理/缓存/用时/上下文） | ✅ 部分对账 |
| 最近 5 轮表格（含列数一致） | ✅ |
| 运行环境（工作目录/审批/沙箱/网络/模型） | ✅ |
| 变更记录（完整 model+effort） | ✅ 模型/推理强度成对显示前后态，审批值译成中文 |
| 底部说明「只读本地记录」 | ✅ |

### 统计
| 控件/区块 | 现状 |
| --- | --- |
| 复选框 `#opt-total` 合计行 | ✅ 合计行取 summary 全量（步数/输入/输出数值对账） |
| 复选框 `#opt-events` 事件行 | ✅ 勾选后用户/助手/压缩事件行出现，关闭时隐藏 |
| 复选框 `#opt-delta` 上下文增量 | ✅ 最新/累计两种口径的增量数值都对账（+1,000 等） |
| 复选框 `#opt-fold` 折叠调用 | ✅ 连续同类调用合并为「×N」，关闭后逐条 |
| 「累计/最新」切换 | ✅ 上下文列分别取 context_used / context_sum |
| 「展开全部」 | ✅ |
| 表头单位（tok/%/tok/s） | ✅ |
| 点击行展开逐步明细 | ✅ |

### 轨迹
| 区块 | 现状 |
| --- | --- |
| 搜索框 `#trace-q` 过滤 | ✅ |
| 折叠调用开关 | ✅ 合并「×3」与逐条两种形态，明细条数对账 |
| 轮次行与时间条 | ✅ 每轮「第 N 轮」+ 时间条小段数量/位置与 timeline 一致 |
| 28 轮 · 358 步 汇总行 | ✅ 「N 轮 · M 步」对账，搜索过滤后同步变化 |

### 代理
| 区块 | 现状 |
| --- | --- |
| 子代理图（名称/角色/模型/条形/数值） | ✅ 名称/模型/条形比例（100%/50%）/数值（200K/100K）对账 |
| 图例「条形长度 = token 比例」 | ✅ |
| 工作足迹 kv（改动文件/命令/MCP/搜索/压缩/子代理活动/模型） | ✅ |
| 改动最多的文件（链接可点） | ✅ 显示基名、链接携带完整路径、点击发出 ui/open-link |
| 代理间消息（总数/参与方/分项条） | ✅ 总数/参与方/分项条数与比例对账 |

### 异常态
| 状态 | 现状 |
| --- | --- |
| 没有记录（reason=not_found） | ✅ 空 payload 渲染 |
| rollout 缺失（reason=rollout_missing） | ✅ isError 分支显示「本地记录文件不可用」并隐藏空卡片 |
| 数据只有部分（无 quota） | ✅ 说明文案 |
| 刷新失败 | ✅ 显示明确原因、按钮恢复、数据恢复后再刷新回到仪表盘 |

## 四、服务端（server.py）

### MCP 方法
| 方法 | 现状 |
| --- | --- |
| initialize | ✅ |
| notifications/initialized | ✅（间接） |
| tools/list | ✅ |
| tools/call | ✅ |
| resources/list | ✅ |
| resources/read | ✅ |
| resources/templates/list | ✅ |
| ping | ✅ |
| 未知方法 → 报错而非崩溃 | ✅ |

### payload 结果
| 分支 | 现状 |
| --- | --- |
| ok | ✅ |
| not_found（会话不存在） | ✅ |
| rollout_missing（会话存在但无路径） | ✅ |
| 额度有值 / null / partial / unavailable | ✅ 结构 + None 回退 + 渲染两侧都已覆盖 |
| 额度接口超时 → 回退 `—` | ✅ 超时不外抛，结果写缓存（None 也缓存），payload 里 api=null |
| 缓存命中 / 过期 / 非法 key 不写入 | ✅ 进程内命中、磁盘命中都不发网络；过期重取；非法 key 不落盘 |

### 解析的事件类型
| 类型 | 现状 |
| --- | --- |
| token_usage_record | ✅ |
| event_msg/token_count | ✅ |
| task_started / task_complete | ✅ |
| turn_context（模型/强度变更） | ✅ |
| world_state（AGENTS.md 规则） | ✅ |
| response_item（消息/工具） | ✅ 钉住设计：工具/正文只认 `event_msg/item_completed`，response_item 并存时不得重复计数 |
| compacted（压缩次数） | ✅ |
| 半行 / 截断 / 损坏 JSONL | ✅ |

## 五、注入器（injector.js）

| 行为 | 现状 |
| --- | --- |
| 三地址回退（127.0.0.1 / [::1] / localhost） | ✅ 静态契约（P5 起有，P8 才真正接入套件） |
| 单实例锁 9224 | ✅ |
| 重注入（页面 reload 后） | ⚠️ 间接 |
| health 四种状态 ok/empty/no-anchor/error | ✅ 含 no-anchor 端到端 |
| 文件监听事件驱动 + 2s 兜底 | ✅ 静态契约：`fs.watch` + `fs.watchFile(2000)` 都在 |
| 仪表盘标签页：打开 / 复用 / 已存在时聚焦 | ⚠️ 四个分支有静态契约；「按钮真的打开标签页」仍是 SKIP（Codex DOM 漂移） |
| 注入失败时的日志与重试 | ✅ 注入失败有日志、domcontentloaded 重注入、连接失败 800ms 退避 |

## 六、用户可直接双击的脚本（全部零测试）

| 脚本 | 现状 |
| --- | --- |
| `launch.vbs`（带端口启动 Codex） | ✅ 隔离实跑（假 Codex/node 记录器）：启动顺序、调试参数、可见/隐藏窗口、1.2s 间隔；不真起 Codex |
| `injector-only.vbs` | ✅ 静态契约 + 一直被套件用于重启注入器 |
| `start-bar.cmd` | ✅ 静态契约：必须真的调用 launch.vbs（注释里提到不算） |
| `stop-bar.cmd` / `stop-bar.ps1` | ✅（-Full） |
| `stop-watch.cmd` / `watch-windows.ps1` | ✅ |
| `switch-icon.cmd` / `switch-icon.ps1` | ✅ 黑白往返 |
| `diagnose.cmd` / `diagnose.ps1` | ✅ 能生成报告 |

## 七、安装器 / 构建 / 文档

| 项 | 现状 |
| --- | --- |
| `install.ps1 -CheckOnly` | ✅ |
| 全新安装（从 zip） | ✅ 解压发布包 → 隔离 HOME 完整安装（文件/配置/快捷方式/清单） |
| 覆盖升级（连装两次） | ✅（-Full + 隔离 HOME 下的连装不重复注册） |
| Codex 未运行时安装 | ✅ -TestHome 走「Codex 未运行」分支，全程不碰进程/端口 |
| 缺 node / 缺 python 的提示路径 | ✅ 净化环境实跑 -CheckOnly：点名缺 node/python、只读不修改 |
| 已有 config.toml 内容不被破坏 | ✅ 隔离 HOME 预置 notify/注释 → 内容保留、配置段只一份、留有备份 |
| 快捷方式创建 | ✅ 静态契约：桌面+开始菜单两个、wscript 启动 launch.vbs、图标；内容另有 scripts-smoke 断言 |
| `uninstall.ps1` 完整执行 + 残留 = 0 | ✅（-Full） |
| `render-paths.ps1` 渲染正确性 | ⚠️ 间接 |
| `reload-page.js` | ⚠️ 交付副本实跑「端口不可达优雅跳过」；真实重载 2026-11-23 手动验过 |
| `build.ps1 -NoMirror` | ✅ 内容标记验证 |
| zip 包内容与模板占位符 | ✅ |
| README 参数与代码一致 | ✅ |
| README 里的命令能跑通 | ✅ 命令清单完整性 + `perf-baseline` 现场实跑；其余命令由套件各段执行 |

## 八、统计

| 分类 | 面数 | 已覆盖 | 缺口 |
| --- | --- | --- | --- |
| 底栏结构 | 16 | 15 | 1 |
| 底栏行为 | 14 | 13 | 1 |
| 面板结构 | 30 | 30 | 0 |
| 面板交互 | 8 | 8 | 0 |
| 服务端方法/分支 | 15 | 15 | 0 |
| 解析事件类型 | 8 | 8 | 0 |
| 注入器行为 | 7 | 6 | 1 |
| 用户脚本 | 9 | 9 | 0 |
| 安装/构建/文档 | 14 | 14 | 0 |
| **合计** | **121** | **118** | **3** |

## 九、建议顺序

| 阶段 | 内容 | 理由 |
| --- | --- | --- |
| ~~P0~~ | ~~弹窗交互、chip 点击、仪表盘按钮、跟随偏差~~ | ✅ 已完成（7 条断言，均验证过能失败） |
| P1 | 面板控件 5 个、面板各区块内容、异常态文案 | 面板是主功能，交互全靠这些控件 |
| P2 | 服务端分支（rollout_missing / 额度失败 / 事件类型）、注入器三地址与锁 | 数据正确性与环境适配 |
| P3 | 9 个用户脚本、升级路径、卸载残留、构建 -NoMirror | 生命周期与可维护性 |
| P4 | 极值、深色主题、窄窗口、CPU 阈值 | 打磨 |
| ~~P5~~ | ~~注入器契约、快捷方式内容、文档引用~~ | ✅ 已完成 |
| ~~P6~~ | ~~面板页签内容、刷新按钮、统计 4 控件、轨迹明细、代理图/链接/消息、异常态文案~~ | ✅ 已完成（16 条断言，均验证过能失败） |
| ~~P7~~ | ~~底栏文本/大数/分隔符、三个弹窗内容对账、空值、主题、chip 结构~~ | ✅ 已完成（13 条断言，均验证过能失败） |
| ~~P8~~ | ~~额度缓存/超时、response_item 不重复计数、注入器重试与标签页分支、用户脚本与安装前置检查~~ | ✅ 已完成（14 条断言，均验证过能失败） |
| ~~P9~~ | ~~安装器生命周期（隔离 HOME）、性能阈值~~ | ✅ 已完成（9 条断言，均验证过能失败） |
| ~~P10~~ | ~~launch.vbs 隔离实跑、README 命令可执行~~ | ✅ 已完成（4 条断言，均验证过能失败） |

每一条新增断言都要**先制造对应缺陷、确认它 FAIL、再恢复**，否则不算断言。

## 十、P0 完成记录（2026-11-20）

新增 7 条断言，全部**先制造故障、确认 FAIL、再恢复**：

| 断言 | 故障注入方式 | 故障时表现 |
| --- | --- | --- |
| 弹窗互斥 | 打开时不关其它弹窗 | 两个弹窗同时展开 |
| 点外部关闭 | 捕获阶段直接 return | 点外面不关 |
| Esc 关闭 | 把 Escape 改成 F13 | 按 Esc 不关 |
| 弹窗不越界 | 弹窗宽度改 2000px | 右边界 2104 > 视口 1920 |
| chip 明细 | openUsage 立即 return | 没有 #dsh-usage-pop |
| 仪表盘按钮 | 删掉 openDashboard() 调用 | 10 秒内没出现标签页 |
| 跟随动画 | 逐帧 rAF 改回 1 秒定时器 | 最大偏差 428.5px |

同时修掉两个测试自身的问题：
1. 断言之间没有重置状态，上一条留下的展开状态导致下一条误判 → 每条从 Esc 清场开始
2. "没有 chip 就跳过"等于没测 → 改为自造轮次锚点，强制走真实的 chip 注入路径

## 十一、P1 完成记录（2026-11-20）

新增 `verify/panel-behaviour.js`（16 条断言，覆盖概览/统计/轨迹/代理四个页签的内容与控件）。

故障注入验证（5 类故障，命中 5 条断言）：

| 故障 | 失败断言 |
| --- | --- |
| 卡片 cap 不写 | 概览卡片都有说明文字 |
| 表头去掉单位 | 统计表头带单位 |
| 搜索监听失效 | 轨迹搜索会过滤条目 |
| 子代理活动改英文 | 代理子代理活动是中文 |
| 展开全部失效 | 统计展开全部出现明细 |

仍缺口（下一阶段）：`opt-events` / `opt-delta` / `opt-fold` / 累计模式、代理图条形与图例、
代理间消息、改动文件链接、异常态文案、头部元素（标题/模型 chip/更新时间/刷新按钮）、最近一轮 kv。

## 十二、P2 完成记录（2026-11-20）

新增：
- `verify/server-branches.py`（8 条）：initialize / ping / resources/templates/list / 未知方法 / 未知工具 / 资源 uri 不匹配 / 非法 JSON / 出错后仍能响应
- `verify/test_server.py` +5 条：turn_context 设置变更、world_state 的 AGENTS.md、compacted 计数、rollout_missing、非法缓存 key 不写入
- 套件新增「注入器单实例锁」检查

故障注入验证（3 类，全部命中）：

| 故障 | 失败断言 |
| --- | --- |
| ping 改为抛异常 | 服务端/ping 返回空结果 |
| compacted 计数写成 +0 | test_compacted_increases_count |
| 锁端口改为 0（锁失效） | 注入器进程数 1 → 2 |

剩余缺口：注入器的三地址回退、no-anchor 状态、文件监听、注入失败重试；
代理图细节、面板头部元素、异常态文案、9 个用户脚本、升级/卸载路径、构建 -NoMirror。

## 十三、P3 完成记录（2026-11-20）

新增 `verify/scripts-smoke.ps1`：

默认档（4 条，不打断使用）：
- `diagnose.ps1` 能生成报告
- `switch-icon.ps1` 黑白往返（并还原）
- `watch-windows.ps1` 起得来、`stop-watch.cmd` 停得掉
- `build.ps1 -NoMirror` 只出 dist，不改安装目录

`-Full` 档（额外 3 条，破坏性）：
- `stop-bar.ps1` 停止注入器并能重新拉起
- 连装两次不重复注册（市场段/插件段各 1 次）
- 卸载后无残留、重装后恢复

故障注入验证（4 类，全部命中）：诊断脚本不产出、图标切换写死白色、
监视器不写 pid、`-NoMirror` 失效 → 对应断言全部 FAIL。

过程中发现并修掉两个真实问题：

1. **`Copy-Item` 保留时间戳**，导致原来用 mtime 判断 `-NoMirror` 的断言根本测不出镜像 →
   改成"在安装目录写内容标记，看是否被覆盖"。
2. **卸载后留下空目录**，但自检仍报"无残留" → 卸载改为删除空目录，
   同时给冒烟脚本加"未安装"前置提示（避免半安装状态下测出莫名其妙的失败）。

## 十四、P4 完成记录（2026-11-20）

面板新增 10 条：头部元素齐全、最近一轮 6 组指标、最近 5 轮列数一致、子代理行有内容、
空数据不出现 NaN、空数据三个页签的占位文案、空数据额度说明、四个复选框可切换、点控件无脚本错误。

注入器新增 1 条端到端：**降级链路**（临时移除锚点属性 → health=no-anchor、
底栏亮起故障色点 → 恢复属性 → 回到 ok）。恢复放在 finally，失败时重载页面兜底。

发布包新增 1 条：解压 zip，断言 `.mcp.json` 与 `injector.js` 都保留 `{{python}}` / `{{server}}`
占位符且不含本机绝对路径。

顺带修掉两个产品问题（都是测试逼出来的）：
1. 空会话判定覆盖了锚点缺失 → 现在锚点缺失优先，故障不会被当成"新对话"
2. 故障态只显示灰色点 → 现在 no-anchor/error 用橙色，信息缺失用灰色

故障注入验证：回退优先级修复 → 降级检查 FAIL；篡改包内模板 → 发布包检查 FAIL。
回归：48 → 50 项全绿。

## 十五、P5 完成记录（2026-11-20）

新增：
- `verify/injector-contract.py`（15 条静态契约）：三地址回退、事件监听 + 兜底轮询、
  单实例锁提示、刷新常量、health 状态、启动参数（端口 + 强制 IPv4）
- `verify/scripts-smoke.ps1`：快捷方式内容（wscript + launch.vbs + 图标存在）
- `verify/test-docs.py`：README 引用的 7 个脚本必须真实存在
- `bar-states.js`：标签页唯一性（不重复打开）

过程中修掉的测试自身问题：
1. 底栏可见性断言被注入器每秒推送的真实数据覆盖 → 测试期间暂停注入器，结束时恢复（exit 兜底）
2. 打开标签页依赖注入器（`openDashboard` 由注入器暴露）→ 拆成两阶段，先测 UI 再恢复注入器测按钮
3. 注入器契约脚本初版漏了 `path` 引入 → 语法错误立刻暴露

已知 SKIP（1 条）：
- 「仪表盘按钮能打开标签页」：当前 Codex 构建里 `[role="tab"]` 的 `aria-label` 为空、
  且按钮是显隐切换语义，无法稳定按文案识别。已明确标记 SKIP 而不是假装通过，
  Codex 标签页 DOM 稳定后再补。

## 十六、P6 完成记录（2026-11-23）

新增 `verify/panel-contract.js`（16 条断言），接入 `run-all.ps1`（套件 50 → **51 项全绿**）。

**为什么用合成 payload**：这批断言要对确定的数字下结论（增量 +1,000、条形 100%/50%、
消息 5 条、变更前后 model+effort）。真实会话里没有子代理/代理间消息/变更记录时就只能 SKIP，
等于没测。所以脚本自己造一份 schema 忠实于 `src/shared/server.py` 的 payload，
通过一个临时 host 页面按 MCP 协议喂给真的 `src/shared/panel.html`——
渲染代码、消息协议都是真的，只有数据是确定的。

| # | 断言 |
| --- | --- |
| 1 | 四个页签互斥且各有内容（不串台） |
| 2 | 刷新按钮发起新请求、文案「刷新中…」→「刷新」 |
| 3 | 刷新失败显示原因、恢复后再刷新回到仪表盘 |
| 4 | rollout_missing（isError）显示明确原因、不显示空卡片 |
| 5 | opt-events 勾选后用户/助手/压缩事件行出现 |
| 6 | opt-delta 最新/累计两种口径的增量数值对账 |
| 7 | 累计/最新切换分别取 context_used / context_sum |
| 8 | 合计行取 summary 全量数值（步数/输入/输出） |
| 9 | 轨迹轮次行与时间条小段数量/位置 |
| 10 | 轨迹汇总行「N 轮 · M 步」并随搜索过滤变化 |
| 11 | 折叠调用「×N」合并与逐条两种形态 |
| 12 | 子代理图名称/模型/条形比例/数值/图例 |
| 13 | 改动文件链接显示基名、携带完整路径、点击发出 `ui/open-link` |
| 14 | 代理间消息总数/参与方/分项条 |
| 15 | 变更记录完整 model+effort 与中文审批值 |
| 16 | 无脚本错误（渲染后异步抛异常也能抓到） |

故障注入验证（4 批，16 条全部命中）：

| 批次 | 注入的故障 | 变红的断言 |
| --- | --- | --- |
| 1 | 页签全显示 / 刷新按钮失效 / 错误文案不写 | 1, 2, 3, 4 |
| 2 | 事件行恒隐藏 / 不计增量 / 累计模式失效 / 合计不取全量 / 时间条不画 / 汇总行只写轮数 / 折叠失效 | 5, 6, 7, 8, 9, 10, 11 |
| 3 | 条形恒 100% / 链接丢完整路径 / 消息区恒隐藏 / 变更只显示变化字段 | 12, 13, 14, 15 |
| 4 | 渲染后异步抛异常 | 16 |

故障脚本：`probe/inject-p6-faults.py`（`probe/` 是本机开发目录，不进仓库）。

**顺带发现（尚未修，记录待定）**

1. 调试 Codex 停在首页（页面没有会话容器）时 `health=no-anchor`，套件的
   「重启注入器后能在 20 秒内恢复」会失败（只有 ok|empty 才算恢复）。
   首页/新对话到底该判 empty 还是 no-anchor 需要产品决策；本轮先通过 CDP 把
   调试实例切到真实会话，再跑回归。
2. `bar.log` 出现 `dashboard: no menu item`：当前构建里用菜单项打开「会话仪表盘」
   标签页也找不到入口，和 §十五 的 SKIP 是同一类 DOM 漂移。

**仍缺口（P7 候选）**

- 底栏：`#dsh-turns` / `#dsh-tokens` 文本与单位、大数缩写（1B/千位分隔）、空值「—」、
  三个弹窗内容正确性、chip 悬停显隐、light/dark 主题。
- 服务端：额度接口超时回退「—」、缓存命中/过期分支。
- 解析：`response_item` 里的消息/工具。
- 注入器：文件监听事件驱动 + 2s 兜底、标签页打开/复用/聚焦、注入失败重试日志。
- 用户脚本：`launch.vbs`、`injector-only.vbs`、`start-bar.cmd`。
- 安装器：Codex 未运行安装、缺 node/python 提示、已有 config.toml 内容保留、
  快捷方式创建、`reload-page.js`、README 命令跑通。

## 十七、P7 完成记录（2026-11-23）

新增 `verify/bar-contract.js`（13 条断言），接入 `run-all.ps1`（套件 51 → **52 项全绿**）。

**做法**：跑在真实 Codex 页面上（CDP 9223），先停掉注入器（否则它每秒用真实数据
覆盖断言用的假快照），再用 `window.__dshBarRender` 推一份形状照
`src/bar/bar_metrics.py` 的假 payload。布局类断言前先确认底栏真的有尺寸——
切到「会话仪表盘」标签页时输入框不参与布局，`place()` 会把底栏隐藏（rect 全 0），
不确认就会把 0×0 误判成「分隔符不可见」。

| # | 断言 |
| --- | --- |
| 1 | 轮次文本「6 轮 439 步 · 最近 42 tok/s」与分段 b 标签 |
| 2 | token 文本、十亿 → B 缩写、缓存命中百分比 |
| 3 | 左右两个分隔符存在且可见（1×10） |
| 4 | 轮次弹窗：标题/大数/kv/最近 5 轮明细/说明 |
| 5 | 子代理行只在有子代理时出现 |
| 6 | token 弹窗：大数、千位分隔、4 行 kv、缓存条宽度、说明 |
| 7 | 额度弹窗：数值、本地时间、5 小时行按数据隐藏 |
| 8 | 额度无数据：只留图标、弹窗大数 `—`、说明原因 |
| 9 | 最近变更：完整 model+effort、中文审批值、时间语义 |
| 10 | 空值：缺失字段显示 `—`，不出现 NaN/undefined |
| 11 | 主题跟随 `data-theme`（底栏配色 + 弹窗背景） |
| 12 | 用量 chip 挂在动作行内、位于时间戳前、文本缩写、点开单轮明细 |
| 13 | 无脚本错误 |

故障注入验证（3 批，13 条全部命中）：

| 批次 | 注入的故障 | 变红的断言 |
| --- | --- | --- |
| A | 轮次文本丢速度 / 大数不缩写 / 分隔符 0×0 / 主题恒深色 | 1, 2, 3, 6, 10, 11 |
| B | 明细只留 3 条 / 缓存条恒 0% / 5 小时行恒显示 / 无数据大数 0.00% | 4, 6, 7, 8 |
| C | 子代理行恒显示 / 变更恒空 / 空值显示 NaN / chip 不缩写 / 渲染后异步异常 | 5, 9, 10, 12, 13 |

故障脚本：`probe/inject-p7-faults.py`（本机开发目录，不进仓库）。

**修掉的产品问题**

1. `localHM(null)` 把 `new Date(null)` 当成有效日期：额度弹窗的「数据截至」在
   `data_as_of=null` 时显示成 `08:00（本地）` 而不是 `—`。已在 `injected.js` 加空值守卫。

**顺带发现（未修）**

1. `panel.html` 的 `fmtLocalHM` 有同样问题（`data_as_of=null` 会显示 08:00）；
   面板当前只在有 weekly_percent 时才用它，暂时不触发，补断言时一起修。
2. 调试实例停在「会话仪表盘」标签页时，底栏会被 `place()` 隐藏（没有输入框布局）。
   这不是缺陷，但所有底栏几何断言都要先确保布局（见 bar-contract.js 的 ensureBarLayout）。

**仍缺口（P8 候选，15 面）**

- 底栏结构：仪表盘按钮点击后真的打开/聚焦标签页（当前 SKIP，Codex 标签页 DOM 漂移）。
- 底栏行为：chip 悬停显隐（当前构建动作行常显，不可观测）。
- 服务端：额度接口超时回退 `—`、缓存命中/过期分支。
- 解析：`response_item` 里的消息/工具。
- 注入器：文件监听事件驱动 + 2s 兜底、标签页打开/复用/聚焦、注入失败重试日志。
- 用户脚本：`launch.vbs`、`injector-only.vbs`、`start-bar.cmd`。
- 安装器：Codex 未运行安装、缺 node/python 提示、已有 config.toml 内容保留、
  快捷方式创建、`reload-page.js`、README 命令跑通。

## 十八、P8 完成记录（2026-11-23）

补齐数据正确性与生命周期一侧的缺口，套件 52 → **54 项全绿**：

- `verify/test_server.py` +6（额度失败与缓存、response_item 不重复计数）
- `verify/injector-contract.py` +4（失败日志/重注入/退避重试/标签页四分支）
- 新增 `verify/scripts-contract.py` 4 条（启动链路、reload-page、缺依赖提示、快捷方式）
- 把 `injector-contract.py` 接进 `run-all.ps1`

**先说一个 P5 遗留问题**：`injector-contract.py` 从 P5 就存在，但一直没接进 `run-all`，
那 15 条静态契约从未在回归里跑过——这轮补上（P8 新增 4 条后共 19 条）。

| # | 断言 | 位置 |
| --- | --- | --- |
| 1 | 额度接口超时：不外抛、结果（None）写缓存、payload 里 api=null | test_server.py |
| 2 | 进程内缓存命中不发网络请求 | test_server.py |
| 3 | 磁盘缓存命中不发网络请求 | test_server.py |
| 4 | 磁盘缓存过期后必须重新请求 | test_server.py |
| 5 | response_item 的工具事件不得与 item_completed 重复计数 | test_server.py |
| 6 | response_item 的消息不得重复计数 | test_server.py |
| 7 | 注入失败会记录日志 | injector-contract.py |
| 8 | 页面载入（domcontentloaded）后重新注入 | injector-contract.py |
| 9 | 连接失败按 800ms 退避循环重试 | injector-contract.py |
| 10 | 仪表盘标签页：复用/聚焦/隐藏保留/找不到入口四个分支都在 | injector-contract.py |
| 11 | 启动链路 start-bar.cmd → launch.vbs（调试端口/IPv4/node 模板/injector/隐藏窗口） | scripts-contract.py |
| 12 | reload-page.js 端口不可达时优雅跳过（实跑死端口） | scripts-contract.py |
| 13 | install.ps1 -CheckOnly 在缺 node/python 时点名（净化环境实跑） | scripts-contract.py |
| 14 | 安装器创建桌面+开始菜单快捷方式、wscript 启动 launch.vbs、带图标 | scripts-contract.py |

故障注入验证（8 批，14 条全部命中）：

| 批次 | 注入的故障 | 变红的断言 |
| --- | --- | --- |
| 1 | 额度超时异常不再被吞 | test_quota_timeout_falls_back_to_none（ERROR） |
| 2 | 进程内缓存失效 | test_quota_inprocess_cache_skips_network |
| 3 | 不读磁盘缓存 | test_quota_disk_cache_skips_network（ERROR） |
| 4 | 过期判断反转（永远当命中） | test_quota_expired_disk_cache_refetches |
| 5 | response_item 工具重复计数 | test_response_item_tool_not_double_counted |
| 6 | response_item 消息重复计数 | test_response_item_message_not_double_counted |
| 7 | 删掉注入失败日志/重注入/退避/标签页分支 | injector-contract 4 条 |
| 8 | start-bar 调用改坏 / reload 提示删掉 / 缺 python 不点名 / 快捷方式改名 | scripts-contract 4 条 |

故障脚本：`probe/inject-p8-faults.py`（本机开发目录，不进仓库）。

**过程中修掉的测试自身问题**

1. `injector-contract.py` 没接入 `run-all`（P5 漏的）→ 已接入，否则"有契约文件"等于没测。
2. 链路断言最初只查 `'launch.vbs' not in start-bar.cmd`，而注释里也提到 launch.vbs——
   把调用改坏了照样 PASS。改成匹配真实调用 `"%~dp0launch.vbs"` 后才测得出。
3. 磁盘缓存故障最初整行替换掉 `if shared:`，造成 IndentationError、整个 test_server 直接崩；
   这种"失败"不代表断言命中。改成 `if False:` 才拿到干净的 FAIL/ERROR。
4. 手动跑 python 会在 `src/shared/__pycache__` 留字节码，回归的「源码树无编译残留」会红；
   套件自己设了 `PYTHONDONTWRITEBYTECODE`，手动跑完要清（已清）。

**仍缺口（P9，8 面）**

- 底栏：仪表盘按钮真的打开/聚焦标签页（SKIP，Codex 标签页 DOM 漂移）、chip 悬停显隐（当前动作行常显，不可观测）。
- 注入器：真实仪表盘标签页打开/复用/聚焦端到端（同上 DOM 限制）。
- 用户脚本：`launch.vbs` 实跑（会再起一个 Codex，需要隔离环境）。
- 安装器：全新安装（从 zip）、Codex 未运行安装、已有 config.toml 内容保留、README 命令全跑通。

## 十九、P9 完成记录（2026-11-23）

把安装器从"只能手动验"变成可回归，并把性能基线接进套件。套件 54 → **56 项全绿**。

**产品改动**

1. `tools/install.ps1` 新增 `-TestHome <目录>`：所有产物（底栏、插件、config.toml、
   桌面/开始菜单快捷方式、备份）写进隔离目录，跳过停止服务/重启注入器/调试端口/重载页面，
   并走"Codex 未运行"的等待分支。README 参数表已同步。
2. 顺带修掉真实场景的问题：`~/.codex` 目录不存在时（Codex 从没运行过）写 config.toml 会失败
   ——现在先建目录再写。

**新增断言（9 条）**

`verify/install-lifecycle.py`（5 条，隔离 HOME）：

| # | 断言 |
| --- | --- |
| 1 | 全新安装：解压发布包 → 文件/插件/配置（两段各一次、无 BOM、市场源指向安装目录）/快捷方式/清单齐全 |
| 2 | Codex 未运行时安装：走跳过等待分支、仍然安装完成 |
| 3 | 已有 config.toml 内容不被破坏：自定义 notify/注释保留、配置段只一份、原件有备份 |
| 4 | 连装两次不重复注册：两段配置各一次、两个备份目录 |
| 5 | 隔离护栏：整套测试不修改真实 `~/.codex-bar` 与 `~/.codex/config.toml` |

`verify/perf-check.ps1`（4 条阈值，取 PERF.md 基线的 5-10 倍，只拦数量级退化）：

| # | 断言 |
| --- | --- |
| 6 | 解析耗时（缓存命中，中位数）< 50 ms |
| 7 | 底栏指标往返（中位数）< 200 ms |
| 8 | 注入器空闲 CPU（单核）< 10% |
| 9 | 底栏进程内存合计 < 300 MB |

故障注入验证（6 批，9 条全部命中）：

| 批次 | 注入的故障 | 变红的断言 |
| --- | --- | --- |
| 1 | 快捷方式改名 | 1 |
| 2 | 删掉「Codex 未运行」提示 | 2 |
| 3 | 忽略已有 config.toml | 3 |
| 4 | 第二轮安装不清理旧配置段 | 4 |
| 5 | 测试模式写回 `$env:USERPROFILE` 安装目录（跑测试时把 USERPROFILE 指向临时目录） | 5（连带 1/3/4，属同一故障） |
| 6 | 解析 sleep 250ms + 往返 sleep 300ms + 注入器每轮烧 1.2s CPU + 占 320MB | 6、7、8、9 |

故障脚本：`probe/inject-p9-faults.py`（本机开发目录，不进仓库）。

**说明：隔离护栏怎么证明能失败**：不能真去改用户真实配置，所以注入故障时让测试模式写回
`$env:USERPROFILE`，并把跑测试的 USERPROFILE 指到临时目录——真实目录全程没被碰，
护栏断言照样 FAIL，证明它确实盯着真实路径。

**仍缺口（P10，5 面）**

- 底栏：仪表盘按钮真的打开/聚焦标签页（SKIP，Codex 标签页 DOM 漂移）。
- 底栏行为：chip 悬停显隐（当前动作行常显，不可观测）。
- 注入器：真实仪表盘标签页端到端（同上 DOM 限制）。
- 用户脚本：`launch.vbs` 实跑（会再起一个 Codex，需要隔离环境）。
- 安装器：README 命令全部实跑（大部分已在套件里跑到，差 launch 相关）。

## 二十、P10 完成记录（2026-11-23）

关掉用户脚本/文档侧最后两个缺口，套件 56 → **58 项全绿**：

- `verify/launch-vbs.py` 2 条：launch.vbs 隔离实跑
- `verify/readme-commands.py` 2 条：README 命令清单 + perf-baseline 现场实跑

**做法（launch.vbs 不真起 Codex）**

1. 用 `Add-Type` 现场编译一个记录器 exe：把 argv/时间/pid 追加到 `P10_RECORD`，然后睡 4 秒。
2. 临时目录生成 launch.vbs 副本，只做"路径渲染"级的替换：`{{node}}` → 记录器；
   `codexExe = ...` 那一行 → 记录器副本（等价于"Codex 装在这个路径"）。
3. 用 wscript 实跑，收集两次记录；在记录进程还活着时用 `Get-Process MainWindowHandle`
   判断窗口可见性。

| # | 断言 |
| --- | --- |
| 1 | 真的按顺序启动：Codex 带 `--remote-debugging-address=127.0.0.1` + `--remote-debugging-port=9223`，随后注入器指向 `injector.js` |
| 2 | Codex 窗口可见、注入器窗口隐藏、两次启动间隔 ≥900ms（WScript.Sleep 1200 不能被删）、不碰真实注入器进程 |
| 3 | README 命令清单仍含 5 条关键命令且引用的脚本存在 |
| 4 | `perf-baseline.ps1` 现场实跑（`-IdleSeconds 1 -OutFile 临时文件`）生成含解析/刷新/内存三节的报告，不污染 docs/PERF.md |

故障注入验证（2 批，4 条全部命中）：

| 批次 | 注入的故障 | 变红的断言 |
| --- | --- | --- |
| A | 删掉 Codex 的调试端口参数 / 把注入器窗口改成可见 | 1、2 |
| B | README 删掉 perf-baseline 命令 / 报告里改掉「内存」小节 | 3、4 |

故障脚本：`probe/inject-p10-faults.py`（本机开发目录，不进仓库）。

**过程中踩的坑（记录）**

1. 记录器最初用 `DllImport("user32.dll")` 读窗口可见性，结果 exe 一启动就崩（0xE0434352，
   异常信息都打不出来）——这个环境里不能依赖窗口 API。改为"记录器自己睡 4 秒 +
   测试侧用 `MainWindowHandle` 判可见性"。
2. 想用覆写 `LOCALAPPDATA` 让 launch.vbs 找到假 Codex，实测没生效（ExpandEnvironmentStrings
   没按预期用进程环境）——改为直接替换临时副本里的 `codexExe` 行。
3. 记录路径最初用 `DSH_RECORD` 环境变量，子进程读不到（harness 保留 `DSH_` 前缀）——
   改成 `P10_RECORD`。

**仍缺口（P11，3 面，均有外部前置）**

- 底栏：仪表盘按钮真的打开/聚焦标签页（SKIP，Codex 当前构建标签页 DOM 漂移）。
- 底栏行为：chip 悬停显隐（当前构建动作行常显，"悬停才出现"不可观测）。
- 注入器：真实仪表盘标签页端到端打开/复用/聚焦（同上 DOM 限制）。

到 P10 为止：**121 面覆盖 118**，套件 58 项；剩余 3 面都依赖 Codex 构建把标签页/动作行的
DOM 稳定下来，属于"等上游"而不是"没写"。
