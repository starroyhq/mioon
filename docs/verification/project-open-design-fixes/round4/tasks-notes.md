# 第四轮任务详情整理

已对照上一轮 `full36-round3/screens/panels-02.jpg` 和第四轮第 3 条修正任务详情。

- 生成任务的下半状态区增加“状态与诊断”标题，同时保留服务商标签、任务状态、错误诊断、原请求 ID 和待对账提示
- “标记失败”从摘要信息区移至底部操作区，并增加明确的按钮边界；对账按钮移至同一操作区，服务商任务 ID 输入仍保留在状态区
- 本地编辑的未知任务也将“标记失败”放到原请求恢复按钮旁，保留现有恢复与确认逻辑
- 四语言新增标题分别为“状态与诊断”“狀態與診斷”“Status and diagnostics”“状態と診断”

此次不增加后端操作，不改变确认弹窗、冻结的任务身份、原请求编号、未知结果对账、恢复分支和禁用条件。等待确认期间离开任务详情或更换项目仍会撤销旧操作权限。

## 修改文件

- `apps/web/src/TaskCenter.tsx`
- `apps/web/src/TaskWorkspace.css`
- `packages/i18n/src/catalogs/round4-tasks.ts`（由主代理在 i18n 入口串行注册）
- `tests/task-center-dock-ui.test.mjs`

## 实际验证

2026-10-20：每个文件独立运行 `TMPDIR=/private/tmp node --test --test-reporter=tap <测试文件>`，每进程超时 90 秒。5 个文件、98 个测试通过，0 失败，见 `tasks-tests.json` 及 `logs/`。

| 测试 | 通过数 |
| --- | ---: |
| `task-center-dock-ui.test.mjs` | 17 |
| `task-center-app.test.mjs` | 25 |
| `redesign-entry-task-ui.test.mjs` | 7 |
| `task-workspace-intent.test.mjs` | 44 |
| `task-disposition-client.test.ts` | 5 |

新增验证覆盖四语言状态区标题、生成任务底部操作分组及本地未知编辑的原请求恢复按钮。已有测试继续覆盖对账精确输入、确认取消、隐藏或切换作用域后的旧回调失权，以及未知结果与复制行为。

`git diff --check` 对本次任务文件通过。视觉截图和整合类型检查由主代理统一执行；此处不把测试通过当作浏览器验收完成。没有本子任务新增的环境阻塞。
