# 格式 5 主轨同步（TSa，共用合同对齐）

本卡把画板顺序链和剪辑主轨接进同一个格式 5 写事务：关联和按根计划、版本跟随/锁定、占位首次换版、同步基线（三态）、共用事务回执和一步撤销/重做。锚、删除/切开/挪动、复制并挪动确认、导出准入边界属于 TSb，见本卡笔记目录的设计笔记，不在本次改动里。格式 3/4 行为不变；应用默认仍是格式 4。

## 共用合同

以 B 的 #289 为准（`packages/contracts/src/sequence-edit.ts`，子路径 `@mioon/contracts/sequence-edit`）：

- `SequenceEditEnvelope`（contractVersion/epoch/actionId/requestId/originSide/filmId/intents/baseline/impact/allocation）、`SequenceEditReceipt`、`SequenceEditPatch`/`SequenceEditStateDelta`、`SequenceEditHistoryEntry`、`SequenceEditErrorCode`/`SEQUENCE_EDIT_ERRORS` 全部来自这份合同，本卡不复制第二套。
- 同步基线用合同的三态 `SequenceEditBaselineChange`（`unchanged` / `set` / `absent`）：只有真的改变才在正反补丁里带完整快照，撤销时 `unchanged` 不动基线。
- TS 专有的有界命令载荷留在 `packages/contracts/src/sequence-sync.ts`（`sync-board`、`board-version`、`clip-version` 的参数），由 `sequenceSyncIntent` 包成合同 envelope 里的 intent；side 由 `sequenceEditIntentSide` 判定。
- 本卡对合同的两处扩展（协调人审查允许，PR 里列明）：① `SequenceEditReceipt.warnings?` + `SEQUENCE_EDIT_WARNING_CODES`，用来持久化和重放 `SOURCE_TOO_SHORT`（旧版本保留剪的长度）这类非阻断原因；② 新错误码 `SEQUENCE_EDIT_NOOP`，表示合法请求但现场已经等于目标状态——只写不可变回执、不写历史/不推进 revision。
- `packages/contracts/package.json` 新增 `./sequence-sync` 子路径导出。

## 入口

`packages/business/src/format5-sequence-sync.ts`：

| 入口 | 作用 |
| --- | --- |
| `readSequenceSyncProjection(store)` | 只读投影：timeline/root/mainTrack、两侧 revision、链顺序、游离节点、主轨组/版本模式、画板选中版本。 |
| `previewSequenceSync(store, command, {requestId, actionId?})` | 读一次现场并规划，返回合同 `SequenceEditEnvelope`（含 impact/targets/allocation）和 warnings；UI-E2/MT 用它生成确认请求。 |
| `runSequenceSync(store, envelope)` | 一个 `ProjectStore.tx` 内：回执重放、CAS、规划、写主轨/时间线和（当前还没有 CS 接缝时的）镜头版本行、三态基线、一条 history、回执。返回 `SequenceEditCommitResult | SequenceEditTransactionFailure`。 |
| `moveSequenceSyncHistory(store, command)` | 用同一 patch 和历史模块做 undo/redo；`SequenceEditHistoryCommand` 带 expected 游标和方向。 |
| `createMainTrackProjectionPort(store)` | CS 事务内接缝：把同一个 plan 映射为 timeline 半边的 `SequenceEditTimelineCommit`，不写历史、不写内容戳。 |

命令映射：`sync-board` → `board.sync`（board side）；`board-version` → `board.version`；`clip-version` → `track.version`（timeline side）。

## 唯一 history 写入模块

`packages/business/src/format5-editor-history.ts`。CS 和 TS 都只能通过它写 `editor_requests` / `editor_history_entries` / `editor_history_state`：

- `prepareSequenceEditHistory(store, epoch?)`：读/首次创建统一游标，返回 undo/redo 视图。
- `sequenceEditInputDigest(envelope)` / `findSequenceEditReceipt`：按 `requestId + inputDigest` 找回未知结果，不能换 ID 重试。
- `writeSequenceEditAction(store, {envelope, patch, receipt})`：校验合同、截断 redo 分支、写一条 history、推进游标、写不可变回执，返回带 history 视图的回执。
- `writeSequenceEditFailure(store, envelope, code)`：合法但被拒绝/无操作的请求只写 `not_applied` 回执，不动历史。
- `moveSequenceEditHistoryCursor(store, command, receipt)`：undo/redo 校验 expected 游标、移动位置、写回执；不新增 history 分支。
- `readSequenceEditHistoryEntry` / `patchFromEntry`：读回存的正反补丁，重放和撤销共用。

## 事务顺序

1. 回执重放（同 `requestId` 同 digest 返回原回执；不同 digest 返回 `SEQUENCE_EDIT_REQUEST_REUSED`）。
2. 读现场，校验 envelope 的 `contentRevision/timelineRevision/syncRevision`，旧值返回 `SEQUENCE_EDIT_REVISION_CONFLICT`，零写入。
3. 一次 SA `planChainSync`。版本命令核 `(nodeId,versionId)` 归属、素材 hash 和源长度。
4. 镜头版本行（board delta 的 shot）、主轨/锚的行（timeline delta）和 `sequence_sync_state.baseline` 三态在同一个事务里写；内容戳由行写/提交栅栏推进。
5. `format5-editor-history.ts` 写一条 `editor_history_entries`、推进 `editor_history_state`、写 64 KiB 回执；提交栅栏（K5a `fenceFormat5ProjectContent`）全量校验后才发布。
6. 合法无操作：`status:'not_applied' + code:'SEQUENCE_EDIT_NOOP'`，只写回执，不写历史、不推进 revision。版本过短：保留原已应用版本和剪的长度，warnings 写入回执。

撤销/重做：读 entry 的正/反补丁，写回镜头/主轨/锚/基线，`syncRevision`/`timelineRevision` 继续向前，游标移动；栈顶已变返回 `SEQUENCE_EDIT_HISTORY_CONFLICT`；任何失败整体回滚。

## 覆盖和结果

`tests/format5-timeline-sync.test.ts`，9/9：

- 投影：主轨关联、链顺序、两侧 revision、画板/主轨投影。
- 占位首次换版：按新版本完整源长度取长度；后台片段后移；锚定辅轨/字幕保持相对偏移；受影响镜头行/主轨行数量进回执。
- 版本过短：保留旧应用版和剪长度，`SOURCE_TOO_SHORT` 写入共用回执。
- 锁定/跟随：锁定段不跟随后续画板选版；剪辑侧跟随/解锁保留剪长度。
- 清空选择保留已应用片段（D4）。
- 精确重放、同 ID 不同输入冲突、无操作只写回执不写历史、旧 revision 原子拒绝。
- 一步 undo + 一步 redo，共用历史游标。
- 格式 4 store 不进入新入口。
- 合同测试 `tests/sequence-edit-contract.test.ts`（#289 带入）12/12 通过。

`tests/format5-timeline-sync-performance.test.ts`：K1 形状 500 镜头 + 500 主轨段 + 1,000 辅轨段 + 500 字幕，主轨中间换版让后缀移动；只计时共享事务（预览是独立只读步骤）。本机 p50 49.5–51.8 ms / p95 56.7–57.1 ms（预算 p95 ≤100）；Linux CI runner 用 200 ms 门槛（按 `process.platform` 判定），数值写进 CI 日志。

## CS / MT 对接

- CS 事务完成后调用同一 `runSequenceSync(store, envelope)`（envelope 由双方共用的 preview/确认流程生成），board delta 的节点/边写留在 CS；若 CS 在自己的事务里驱动，则调用 `createMainTrackProjectionPort(store).projectMainTrack(request)` 得到 timeline 半边，再和 CS 的 board delta 一起交给 `format5-editor-history.ts` 写一条历史/回执。SA 审查要求「修复让链恢复干净的那一步在同一事务里接着 sync-board」即合同允许的复合 intent。
- MT（Mio 工具，后续卡）复用同一 preview/run/undo 入口；命令有界、只传稳定 ID，回执里有 affected 计数和 history 视图。本卡不加 Mio 工具，两套请求指纹不变。
- UI-E2 使用回执的 `status/code/warnings/affected/history/contentRevision/timelineRevision/syncRevision`；占位用 `sourceState`，版本模式用主轨组 `versionMode`；撤销条按 history 的 actionId/position 工作。

## 局限和后续

- TSb：锚删除/重挂、切开/挪动/复制并挪动确认、导出准入边界、跨轨移动；遇到节点/边写入或新建/删除片段时返回 `SEQUENCE_EDIT_SYNC_SEAM_UNAVAILABLE`/`SEQUENCE_EDIT_CONTRACT_INVALID`，不偷写。
- 显式改绑主轨/根的协调命令放 TSb；本卡只读关联。
- 撤销/重做目前只覆盖 TSa 的动作和共享游标；旧两栈合并、Mio 独立补偿按 P5 D5。
- 真实导出预检票据和 `edit-tasks.ts` 未知结果查询归 TSb（本卡已经有 requestId 回执重放）。
