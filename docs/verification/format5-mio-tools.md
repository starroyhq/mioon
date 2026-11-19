# 格式 5 Mio 工具（MT，读半）

本 PR 先交付读侧和格式 5 独立工具目录；写工具和格式 5 指纹套件按卡允许的「拆读/写两个 PR」放在后续 PR。

## 格式 5 独立工具目录

- 按受信打开的内核格式选择目录：`createAgentTaskTools` 用 `isFormat5Project(store)` 选 `catalogProfile='format5'`，不从旧 `frameProject` 布尔值猜；格式 3/4 继续用各自冻结目录。
- `task-tool-groups-v2.ts` 新增 `format5` profile：沿用同一套工具组，追加 `sequence.inspect`（core）和格式 5 专用不可用清单 `FORMAT5_UNAVAILABLE_OPERATIONS`。
- 不可用入口仍保留名字、参数和所在组，工具定义带 `unavailableReason`，`prepare` 在格式 5 下先返回 `AGENT_TASK_TOOL_FORBIDDEN` 和具体原因。覆盖：旧 `timeline.seed`/`shots.append`/`timeline.*` 写、旧 track/subtitle/format/undo/history、shot/node/edge/参考线/预演/旧主体、`version.select`、旧画布写与旧画布历史。FR 每补回一组再由 FR 卡开放对应工具。
- `timeline.seed`、`timeline.shots.append` 在格式 5 目录标为不可用；旧 `shot.reorder` 原因写明「格式 5 用明确链顺序，旧 shot.reorder 不代表成片重排」。
- 工具加载名枚举按 profile 冻结：新增 `AGENT_TASK_FORMAT5_TOOLS_LOAD_PARAMETERS`；现有格式 3/4 的加载名和已保存请求不受影响。

## 读侧

- 新公共操作 `sequence.inspect`（`packages/contracts/src/sequence-inspection.ts`）：
  - 输入 `{projectId, rootId?, limit≤50, cursor?}`，输出同一快照下的 `snapshotId`、`contentRevision/timelineRevision/syncRevision`、按链顺序分页的 segment（nodeId/kind/order/groupIds/clipIds/start/duration/clips）、每段实际版本/画板版本/状态/锚、`inSync`、`differences`、`freeNodeIds`、`nextCursor`。
  - 游标用服务端 HMAC 绑定 `snapshotId` 和下一页 order；快照变化返回 `INVALID_CURSOR`，不能拼接两次读。
- `project.inspect` / `timeline.inspect` 在格式 5 项目追加有界 `sequence` 证据：主轨、链顺序、组、自由节点、副轨锚、每个主轨片段的状态/版本；格式 3/4 的 DTO 逐字节不变。
- Mio 只读工具 `mioon_sequence_inspect` 加入格式 5 目录 core，参数来自生成的 `AGENT_TASK_TOOL_SCHEMAS['sequence.inspect']`。
- MCP 沿用同一套 tool admission（`sequence.inspect` 在 read 名单中），旧格式的加载枚举和 MCP 请求不变。

## 检查

- `tests/format5-mio-tools.test.ts` 3/3：目录 profile/工具/不可用原因、分页与快照游标、画板版本变化作为差异只读。
- 类型检查、`transport-utf8-output`、`project-file-guard`、`strict-test-suite`、`actions-test-shards`、`agent-task-request-fingerprints-v2`（3/4 两套 99 条不变）、`mio-runtime-fingerprints`（重建一致）、合同/格式5写栅栏、B/C/TSb、parity/寻址/检查/help 测试全部通过。
- 给 `.github/test-timings.json` 补了缺记录的 `tests/sequence-edit-performance.test.ts` 独占耗时；main 上的 `actions-test-shards` 守卫缺这条已红，本分支带上修复。
- 旧格式 3/4 两套 99 条指纹不更新；本 PR 没有新增格式 5 指纹套件（写侧 PR 一起交）。

## 遗留

- 写工具（连接/插入/断开/组重排/跟随锁定/切开复制挪动/主体绑定三态）与审批、影响摘要、补偿预算、Mio 撤销 origin 区分，按卡拆到写侧 PR；本 PR 不含任何格式 5 写工具。
- 格式 5 三协议 99 条指纹新套件、`mio_entries` 重建和诊断固定样本核对，随写侧 PR 一起交并与本 PR 的读工具目录合并。
