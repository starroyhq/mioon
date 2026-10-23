# 任务的本地处置

任务中心显示当前项目中已加载的任务，可以按状态筛选、搜索任务或原请求 ID，并复制选中任务的 ID。复制失败时会显示提示，仍可手动选择 ID 复制

## 标记失败

未知结果的生成任务或编辑请求可以在明确确认后标记为本地失败。这只记录用户在本机的判断，不会改变原始任务状态，也不会重试、取消、重新生成或伪造服务商结果

服务商可能已经接受请求并计费，原始 requestId 和对账入口始终保留。后续对账取得明确结果后，界面以实际任务状态为准；本地标记仍保留在审计记录中。此标记不能解除待对账任务对永久删除项目的限制

## 清除已完成

“清除已完成”将终结任务归档隐藏，每批最多 100 条。它保留原始记录、导出文件、素材、幂等回执和历史，不删除数据。运行中、未知结果、需要检查输出的任务，以及仅停止本地等待但服务商可能继续执行的生成任务不会被清除。编辑请求还必须已明确结束并确认关闭

工作区使用普通 schema50 保存处置记录；旧 schema48 工作区在启动时迁移。冷备份恢复采用独立 schema51 精确 profile，处置审计记录随备份保留，恢复工作区不提供新的处置写入权限

## 公共接口

三个操作通过 HTTP RPC、CLI 和官方 MCP 共用同一契约，不会自动提供给Mio模型工具

| 操作 | 输入 |
| --- | --- |
| `task.disposition.list` | `projectId`、明确的 `targets: [{kind, taskId}]` |
| `task.disposition.markFailed` | `projectId`、`kind`、`taskId`、`expectedRevision`、`expectedStatus`、`requestId`、`confirm: true` |
| `task.disposition.archiveCompleted` | `projectId`、`targets: [{kind, taskId, expectedRevision, expectedStatus}]`、`requestId` |

`kind` 为 `generation`、`render` 或 `edit`。列表查询只读取明确的已知任务，不枚举后台任务，不发起对账。每批须有 1–100 个互不重复的目标

`expectedRevision` 是独立的本地处置版本，尚未处置时为 0；`expectedStatus` 是刚读取的原始任务状态。写入在同一 SQLite 事务中重新检查项目归属、工作区锁、状态和版本，再一并提交标记及不可变回执。同一 requestId 和相同输入重放返回原回执，不能用同一 ID 改变操作或内容

HTTP 使用 `/api/rpc`；CLI 示例：

```sh
node apps/cli/src/index.ts task disposition list --input '{"projectId":"<项目UUID>","targets":[{"kind":"generation","taskId":"<任务UUID>"}]}'
```

MCP 工具名分别为 `task_disposition_list`、`task_disposition_markFailed`、`task_disposition_archiveCompleted`
