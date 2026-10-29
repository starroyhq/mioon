# Mio · 付费步骤"结果未知"的处理

日期：2026-10-27。对应收尾验收 [WRAP-UP.md](WRAP-UP.md) 第 6 节的问题 1。按你的决定，在 M7 开出 PR #43 之后单独修改和验证：工作树 `~/Documents/data/mioon-worktrees/mio-paid-unknown`，分支 `claude/mio-paid-unknown`，基于 `claude/mio-m7` 的 `4be68a9`。之后按你的意见合入 PR #43。没有新增依赖，也没有付费生成。

持久证据根：`~/Library/Caches/mioon-mio-paid-unknown-20261027/`，下文简称 E。

## 1. 问题

以下两种情况，这一步都会记为"结果未知"：
- 付费提交在受理事务里同步报错，例如参数不被服务商支持、服务商不存在；
- 进程在受理事务提交前退出。

这是错误没有"未生效"证明时的保守规则。但这两种情况下其实并没有生成任务，而面板只提供"向服务商核对结果"，任务中心里又找不到这次请求；服务端 `recoverLocalUnknown` 也只处理查看类和本地可撤销操作。结果只能"放弃"，而放弃后这个对话里仍留着未知步骤，"新建对话"一直不可用。

## 2. 依据

- 付费请求到达服务商只有一条路径：worker 派发已受理、处于排队状态的任务（视频生成写在 `jobs`，图像生成写在 `image_tasks`）。派发时，步骤的费用状态会记为"已提交"。
- 受理是一次本地事务，事务里没有网络调用：
  - 视频生成：`createJob` 写入任务、`idempotency` 回执（scope 为 `generation`）和 `agent_task_job_origins_v2` 来源；
  - 图像生成：`accept` 写入 `image_tasks`、`image_requests` 和来源。非 Mock 图像先做的审阅准备只写 `image_reviews`。
- Agent 执行时，这些记录里的请求 ID 都是步骤 ID。

所以，只要这一步的请求 ID 没有受理回执、没有任务记录、没有来源绑定，而且费用状态为空，这次请求就不可能被受理，也不可能发给服务商。

## 3. 改动

| 文件 | 内容 |
| --- | --- |
| `packages/business/src/agent/task-tools-v2.ts` | `recoverLocalUnknown` 增加付费档位：上面这些记录都不存在、费用状态为空时，返回 `not_applied`（`atomic_receipt_absent`）。只要有任意一项记录或费用状态，仍返回空，保留原来的对账流程。 |
| `apps/web/src/AgentTaskPanel.tsx`、`agent-task-v2.css` | 付费未知步骤在"向服务商核对结果"旁加"标记为失败"（设计稿 06）。两个按钮放得下时并排，放不下时"标记为失败"换到下一行。 |
| `packages/i18n/src/catalogs/agent-tasks.ts` | 新词条 `agent.task.paidReconcile`，四种语言："请先在任务中心核对这次生成请求。任务中心里没有这次请求时，可以标记为失败，Mio 会重新规划；这里不会重新提交生成"。 |
| `docs/AGENT-TASKS-V2.md`、`docs/MIO-GUIDE.zh-CN.md` | 恢复规则和使用说明。 |
| `tests/agent-task-tools-v2.test.ts`、`agent-task-runtime-v2.test.ts`、`agent-task-panel-v2-components.test.ts`、`mio-naming.test.ts` | 见第 4 节。 |

运行时的 `resolve_unknown`（`discard`）本来就对所有工具步骤开放，这次没有改：
- 证明成立后，这一步记为失败（`UNKNOWN_NOT_APPLIED`），同一模型回复里还没执行的其他工具调用作废；
- 继续执行时，Mio 收到失败结果并重新规划；
- 再次提交生成会是一个新步骤，仍按付费档位需要确认。

服务端拒绝时（已有记录），面板显示"上一步结果未知，请先核对原请求，不要重复发送"。

## 4. 验证

**新增测试**（三项都在恢复旧代码时失败）：
- `agent-task-tools-v2`：`generation.submit` 和 `image.generate` 各一项。先让记录写入失败，使整个受理回滚，再把这一步设为未知。四种情况里，只有"什么记录都没有"可以证明未生效；只有费用状态、只有来源绑定、只有受理回执（受理已提交、步骤完成没写入）三种都返回空。
- `agent-task-runtime-v2`：没有注册服务商时，Mio 提交生成，受理事务同步失败，这一步变成未知。这时"继续"被拒绝；"标记为失败"成功；继续执行后，第 2 次模型请求带着 `UNKNOWN_NOT_APPLIED`，这一轮完成；全程没有生成任务，也没有第二次提交。
- `agent-task-panel-v2-components`：付费未知步骤显示新说明和"标记为失败"，点击后发出 `resolve_unknown` / `discard`；本地不可撤销的未知步骤不显示这个按钮。

**命令**（工作树 `mio-paid-unknown`，TMPDIR 用规范路径，日志在 `E/closing/`）：

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck`、`tsc -p tests/tsconfig.tests.json`、`scripts/audit-ui-localization.ts` | 退出 0 |
| acceptance README 收口（`.ts` 文件名，见 WRAP-UP 第 5 节） | 338 项，336 通过 |
| `docs/AGENT-TASKS-V2.md` 验证入口 | 599 项，597 通过 |
| `agent-task-panel-v2-components` 36、`mio-conversations-ui` 37、`mio-errors` 4、`agent-chat-ui` 78、`i18n-catalog-integrity` 5、`i18n-foundation` 26、`agent-quickstart-docs` 7 | 全部通过 |
| `pnpm --filter @mioon/web build`、`git diff --check` | 退出 0，无问题 |
| 全量对比（做法同 WRAP-UP 第 5 节，与 main `2bb498f` 对比） | 910 个文件，14,242 通过，74 失败，0 超时。比 main 多 1 个失败：`mio-naming` 的 Mio 用词规则拦下了新词条里的"任务中心"。它和 `waitReconcile` 一样是指向任务中心的说明，已加入白名单，并断言它确实提到任务中心；该文件单独重跑 3 项通过。其余 73 个失败与 main 逐条相同。 |

两项失败与 M7 相同：`agent-task-runtime-v2` 中依赖 Mock 渲染器的两项，本机 FFmpeg 缺 drawtext 滤镜，main 上同样失败。

**浏览器**（合成工作区，复用 M7 的 `fixture.ts`，源码和构建换成本分支，脚本在 `E/browser/`）：
- 场景：子进程在同一工作区运行真实的 v2 运行时，先受理镜头 02 的生成，在镜头 04 的受理事务提交前 SIGKILL；重启后，这一轮显示"已中断"，镜头 04 那一步显示"结果未知"。
- 截图（`E/browser/shots/`，共 26 张）：简中、英、日各 1440×900 / 1050×680、浅色 / 深色，另加繁中 1440 浅色。每组两张：06 恢复卡片，以及标记为失败之后的状态。自动检查没有发现小于 10px 的文字、截断或横向溢出。
- 06 卡片里，"先核对：提交生成"下面是新说明，"向服务商核对结果"和"标记为失败"两个按钮。简中两种宽度下并排，英文、日文换行。"继续执行"不可用，输入框不可编辑。
- 标记为失败后："提交生成"显示为失败，未知步骤卡片消失，"继续执行"可用。
- 继续执行后，Mio 回复"镜头 04 的生成请求没有被受理，也没有产生费用……"，没有再次提交。这一轮随后停在"等待确认"：镜头 02 那个已受理的任务是在"直接执行"下受理的，重启后付费恢复为"需要确认"，所以派发前要你确认一次。这是原有规则，与本次修改无关。

## 5. 兼容性

- 没有接口、schema 或持久字段变化。
- 付费档位的未知结果规则有所放宽：能证明没有受理时，可以标记为失败。已经受理、或者有派发费用状态的步骤，仍然不能标记，仍走原来的对账流程。
- 新增一个词条。改动的文件不在字节锁定清单里。

## 6. 剩余

- 设计稿 06 的两步编号，以及具体说明（"请求可能已发给 Seedance 2.5，但结果没有记录下来……"）没有做，卡片仍用通用说明。
- 处理完未知步骤后，卡片说明仍是"请先核对结果未知的步骤"；被标记为失败的那一步只显示失败图标，没有原因行。这两点都是 WRAP-UP 里原有的观察项。
- 已有受理记录的付费未知步骤，仍然只能在任务中心核对后放弃。正常情况下，受理和步骤完成在同一事务里提交，不会出现这种状态。
