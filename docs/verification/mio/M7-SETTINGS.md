# Mio · M7 设置 · Mio

日期：2026-10-26，10-27 合入最新 main 后复核。本阶段实施 M7（设计稿 07-09、07-10，计划 5.15、5.16），之后在同一工作树完成收尾（见 [WRAP-UP.md](WRAP-UP.md)）。工作树 `~/Documents/data/mioon-worktrees/mio-m7`，分支 `claude/mio-m7`。开工时基于 main `cfc5e8f`（PR #31 合并），工作树干净；之后两次合入 main，最终基于 `2bb498f`（PR #42 合并）。没有新增依赖或付费生成。

测试连接的项目选择由你决定：用最近的项目跑诊断（项目内用当前项目；首页和桌面设置窗口用最近打开、其次最近更新的项目；没有项目时不可测试；该项目忙时提示先处理）。

持久证据根：`~/Library/Caches/mioon-mio-m7-20261025/`，下文简称 E。

## 1. 完成内容与文件

| 分类 | 文件（相对仓库） | 内容 |
| --- | --- | --- |
| 设置页 | `apps/web/src/AgentSettings.tsx`、`AgentTaskPolicy.tsx`、`AgentAuthorizations.tsx`、`settings-center.css`、`App.tsx` | 按 07-09、07-10 重排：模型连接、执行方式、每轮步数上限、已授权目标；页底一处状态和"放弃 / 保存"。去掉页内标题和返回，沿用设置中心外框。 |
| 测试连接（新） | `apps/web/src/agent-connection-test.ts`、`AgentConnectionTest.tsx` | 选项目、首次发送授权（5.7）、发送文本诊断、结果不明时只查原回执、跟踪到结束、显示最近结果。 |
| 服务端与契约 | `packages/contracts/src/agent-tasks-v2.ts`、`packages/business/src/agent/task-journal-v2.ts`、`task-runtime-v2.ts`、`apps/server/src/agent-task-http-v2.ts` | 只读接口 `GET /api/agent/tasks/v2/diagnostics/latest`；启动恢复时未结束的诊断运行记为 `stopped`。 |
| 客户端与 CLI | `packages/client/src/agent.ts`、`apps/cli/src/agent.ts`、`apps/web/src/agent-tasks-v2.ts` | `diagnoseLatest()`、`mioon agent diagnose latest`；浏览器会话的 send 接受 `diagnostic`。 |
| 词条 | `packages/i18n/src/catalogs/mio-settings.ts`（新）、`index.ts`、`settings-redesign.ts`、`docs/i18n-ui-exceptions-creation.json` | 设置页新词条四种语言；Mio 页说明改为"Mio 是项目里的 AI 助手，可以直接查看、修改和生成内容"；删除 2 条已不存在的字面量例外。 |
| 测试 | `tests/agent-connection-test.test.ts`（新）、`agent-settings-ui.test.ts`、`settings-navigation-state.test.ts`、`agent-task-runtime-v2.test.ts`、`agent-task-http-v2.test.ts`、`transport-utf8-output.test.ts` | 见 3.1。 |
| 文档 | `docs/AGENT-TASKS-V2.md`、`AGENT-AUTHORIZATION.md`、`CLI.md`、本报告 | 新增"设置与测试连接（M7）"一节、接口表、CLI 命令行；授权文档补充测试连接也先审阅授权。 |

## 2. 行为

**页面结构。** 从上到下：
- 模型连接：服务商预设（多平台时另有平台 / 地区）、接口地址、协议（分段切换，旁边显示实际请求地址）、模型（预设默认值被改动时出现"恢复默认"）、密钥、连接测试。
- 执行方式：本地可撤销、本地不可撤销、付费各一行"直接执行 / 需要确认"。付费行带"会产生费用"标记和固定提示；改为直接执行仍先确认，再带 `acknowledgePaid` 保存。查看类始终直接执行，只有存储里不是直接执行（例如经 CLI 改过）时才显示为可调的一行。其下是锁定说明。
- 每轮步数上限（下一轮生效）。
- 已授权目标：模型、完整地址、发送范围、授权日期，逐条撤销；读取失败时才显示刷新。
- 页底：已保存 / 有未保存的更改 / 正在保存 / 需要核对；"放弃"恢复已保存值；"保存"一次提交连接和执行方式，各自的回执、未知结果核对和不自动重发保持原样。

**密钥。** 已配置时只显示"已配置"标记，可"更换"（展开输入框和保存方式）或"清除"（标为"保存后清除"，可撤销）。没有密钥、正在更换或连接目标变化时才显示输入框。界面从不显示密钥本身。

**测试连接。**
- 只测试已保存的连接；有未保存的改动或正在保存时显示"保存后再测试"。
- 选项目：当前项目 → 最近打开 → 最近更新；都没有时提示"先新建一个项目"，不发送。
- 该项目有未结束的执行时，服务端返回 `AGENT_TASK_BUSY`，界面提示先处理。
- 目标未授权时先弹出首次发送授权（复用面板的 5.7 弹窗，另加一句"这次只发送一条测试消息，不发送项目内容"）。取消不发送；确认只授予所审阅的地址、模型和 `project_agent` 范围，再复查设置与目标后发送。
- 发送一条固定文字的 `diagnostic:{profile:"text"}` 运行：不带工具和项目上下文，不进对话历史。发送结果不明时只查一次原回执，不重发。之后每秒读取一次，最长 150 秒。
- 结果来自 `diagnostics/latest`：全工作区最近一次文本诊断的运行 ID、项目、状态、时间、协议、地址、模型，失败时另有失败代码；不含测试文字、回复或密钥。只有协议、地址、模型都与已保存连接相同时，才显示为当前连接的结果。

**重启恢复。** 诊断运行看不见、也没有要核对的副作用。重启时，未结束的诊断运行记为 `stopped`（原因 `restart`），已发出的模型步骤记为 unknown，不再留下一条看不见、却会挡住该项目后续发送的 interrupted 执行。普通执行的规则不变。

**合入 main 后。** 两次合入（`2bcfc7d`：#29、#32–#37；`0fef88a`：#38–#42）中与本页相关的变化：
- #34 新增 Anthropic Messages 协议：协议分段改为由 `AGENT_PROTOCOLS` 生成的三项，下方加协议说明；选 Anthropic 时，接口地址说明换成对应版本，并显示适用范围。
- #39 的文字选择规则：错误、预设说明、实际请求地址、密钥清除和连接变化提示、页底状态、授权行和测试结果可以选中复制；按钮、分段和标记仍不可选中。#39 还把设置中心改成了模态窗口，本页内容不受影响。
- #33 把测试改成严格类型的 `.ts`：本阶段对 `agent-settings-ui`、`settings-navigation-state`、`transport-utf8-output` 的修改移到了新文件。

## 3. 验证

### 3.1 新增与修改的测试

- `tests/agent-connection-test.test.ts`（7 个）：选项目的顺序；只有协议、地址、模型都相同才算当前连接的结果；已授权时发一次诊断并跟到结束；未授权时先审阅，取消不发送，确认只授予审阅的目标；设置变化、没有项目、明确拒绝都不发送；发送结果不明时只查回执并跟踪原运行，不重发；打开时跟踪别处仍在进行的测试，销毁后停止读取。
- `tests/agent-task-runtime-v2.test.ts`（+2）：重启打断的文本诊断记为 stopped，项目仍可发送，且仍是最近一次测试；最近测试只取最新的文本诊断，失败时只带失败代码。
- `tests/agent-task-http-v2.test.ts`（+1）：HTTP 路由的空结果、405、400、401；CLI `agent diagnose latest` 与 HTTP 结果相同，不含测试文字和密钥。
- `tests/agent-settings-ui.test.ts`、`tests/settings-navigation-state.test.ts`：按新结构更新断言（协议分段为三项、已配置时隐藏输入框、更换后出现、放弃不关闭页面、Mio 页没有表单级返回）。
- `tests/transport-utf8-output.test.ts`：`agent-task-http-v2` 的输出收集点从 6 个改为 7 个（新增 CLI 子进程）。

### 3.2 相关测试与类型检查

见 [WRAP-UP.md](WRAP-UP.md) 第 5 节：类型检查、收口命令、全量对比都在收尾结束时对最终代码重新执行。

### 3.3 浏览器验证（设置页）

合成工作区 `E/browser/fixture.ts`：DeepSeek 连接（合成密钥只在进程内存），另有 qwen3-max、kimi-k2、qwen3:8b 三条历史授权；模型由进程内合成网关回答，诊断回 `OK`，不发网络请求。前端构建到 `E/web-dist`。

截图（`E/browser/shots-final/`，脚本 `capture-settings.mjs`）：简体中文、英文、日文各 1440×900 和 1050×680，浅色和深色，每组 4 张（页顶、执行方式、页底、更换密钥）；繁体中文 1440 浅色抽查。自动检查：没有横向溢出，没有小于 10px 的文字，页底状态"已保存"，测试结果行"上次测试 … · 连接正常"，授权列表 4 条。10-27 合入 main 后在最终构建上重截，结果相同；三项协议分段在 1050 宽度、三种语言下都放得下。

行为探测（`probe-settings.mjs`，结果 `E/browser/probe-settings.json`，10-27 在最终构建上重跑，结果相同）：
- 已授权：点"测试连接"产生一条新的文本诊断（运行 ID 改变），结果行更新。
- 撤销当前目标后再测：先出现授权弹窗；Esc 取消后没有新诊断；确认后授权并测试，出现新诊断，授权列表恢复 4 条。
- 改执行方式出现"有未保存的更改"，"放弃"恢复为已保存值且不关闭页面。
- 付费改为直接执行先弹确认；取消后仍为需要确认。

### 3.4 设计对照

设计导出 `E/design/F112jm.png`（07-09）、`Tg2uD.png`（07-10）。分区、行标签、分段控件、付费行底色与提示、锁定说明、步数输入、授权行（链接图标、粗体模型、地址 · 范围 · 日期、红色撤销）、页底状态和按钮与设计一致。

有意保留：
- 预设说明和官方文档链接（设计稿没有画，原页面已有，便于核对来源）。同一预设有两个来源时，两条链接都显示为"官方文档"，因为来源标题目前只有中文。
- 协议旁的实际请求地址、密钥的保存方式说明。

## 4. 兼容性

- 新增只读接口 `GET /api/agent/tasks/v2/diagnostics/latest`、客户端方法 `diagnoseLatest`、CLI 命令 `agent diagnose latest` 和对应 schema；原有接口、请求和响应不变。
- 浏览器会话的 send 输入多了可选的 `diagnostic`，与服务端既有的诊断入口一致；普通发送不受影响。
- 重启恢复对诊断运行的处理变了（stopped 而非 interrupted），普通执行不变。没有升级工作区版本，也没有新增持久字段。
- 新增词条 `mio.settings.*`；`redesign.settings.agentHint` 文案更新。
- 改动的文件都不在 `tests/fixtures/reviewed-live-sources.json` 的字节锁定清单里。

## 5. 剩余事项

- 已提交到分支 `claude/mio-m7`，与收尾一起开 PR。
- 真实模型的测试连接放在收尾的真实模型验收里，见 [WRAP-UP.md](WRAP-UP.md) 第 7 节。
