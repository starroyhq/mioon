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

## TSb 增补（锚、切分/挪动/删除、复制并挪动、导出边界）

TSb 在同一个共享合同和同一个事务入口上补齐主轨编辑和导出边界；envelope/回执/错误码/history 仍只来自 `sequence-edit.ts`，history/回执仍只由 `format5-editor-history.ts` 写。

### 新命令（`sequence-sync.ts`，都包装成合同 intent）

| 命令 | SA operation | 说明 |
| --- | --- | --- |
| `clip-remove` | `track.remove` | 删除主轨段，链自动重接、后缀压紧、锚按 D3 处理。 |
| `clip-add` | `track.add` | 把已存在的游离镜头/素材节点插入主轨；新节点/素材卡由 CS 创建，本卡只接已有节点。 |
| `clip-split` | `track.split` | 左段保 ID，右段用确认时给的 `rightClipId`；同一 `segmentGroupId`。 |
| `clip-trim` | `track.trim` | 整数帧改长度/入点；后缀移动，锚偏移保留。 |
| `clip-move` | `track.move` | 主轨重排；跨切分组需要 `copyNodeId`。 |
| `clip-move-off-track` | `track.move-off-track` | 移到其它轨并建立显式锚；切分片段需要 `copyNodeId`。 |

### 复制并挪动

- 预览生成 `SequenceEditEnvelope`（含 `allocation.nodes`/`allocation.edges`/`rightClipId`）和 `planDigest`；确认请求必须带同一 `requestId/actionId/envelope` 和 `expectedPlanDigest`，不一致返回 `SEQUENCE_EDIT_PATCH_INVALID`，不会重新分配 ID。
- 服务端确认时重读现场并做 SA 规划；复制镜头会新建 shot 行、通过 `shot_version_adoptions` 采纳实际应用版本，并按新的 `segmentGroupId` 建独立组；复制素材节点复制节点行。
- 复制产生的节点/边/采纳行都在同一个 `SequenceEditPatch` 里，撤销会删除新 shot/节点/采纳并恢复原组和边。

### 锚和 D3

- 每次主轨变化后按 `planTrackAnchors` 重算其它轨和字幕：owner 消失/偏移越界时在原位解除锚（字幕不能空锚，会在同一帧重新挂到覆盖它的主轨段）。
- 重算后若同轨片段/字幕重叠、越界或锚无效，整次动作返回 `SEQUENCE_EDIT_ANCHOR_CONFLICT` 和受影响 ID，零写入。
- 缩短导致锚偏移出界也按原位解除；不自动裁剪、不避让。

### 导出边界（`format5-timeline-export.ts`）

- `createFormat5ExportTicket(store, range?)` 冻结 `contentRevision`/`timelineRevision`/`syncRevision`、冻结投影和 sha256；返回 blockers：选定范围内 `PLACEHOLDER_CLIP`、跟随但所选版本过短的 `VERSION_TOO_SHORT`（带 clip/node/version/短少帧数）。
- `recheckFormat5ExportTicket` 在最终入队前重读三个修订和快照 hash；不一致返回 `EXPORT_SNAPSHOT_STALE`，不拿旧票据入队。
- `assertFormat5ExportAdmissible` 有 blocker 时返回 `EXPORT_BLOCKED` 和具体片段；已入队导出使用自己的冻结快照，后续同步不影响旧导出。
- 现有 `timeline-export-admission.ts` 的 capabilities issue 表固定四项（TIMELINE_MISSING/INVALID_TIMELINE_SNAPSHOT/TIMELINE_SOURCE_UNAVAILABLE/EXPORT_CAPABILITY_STALE），新增 blocker 需要合同扩展；本 PR 只提供模块与测试，不改异步 RPC 入口。

### 覆盖和性能

- `tests/format5-timeline-sync-b.test.ts` 9/9：切分（左保 ID/右新 ID/组和边）、删除中间段（压紧、链重接、孤儿锚原位解除、重叠拒绝）、修剪（后缀移动、越界锚解除）、重排（链边重接、锚随 owner 移动）、跨轨（显式锚）、插入游离素材（新组和链边）、复制并挪动（shot+adoption+新组、撤销删除、同分配确认）、plan digest 不匹配拒绝、精确重放。
- `tests/format5-timeline-export.test.ts` 3/3：占位 blocker、范围排除、过短 blocker、三修订过期。
- `tests/format5-timeline-sync-b-performance.test.ts`：K1 499 镜头 + 499 主轨段 + 1,000 辅轨段 + 500 字幕；split/trim/remove/add 四类动作（预热 5 + 30 采样）本机 p95 43.6/37.3/42.1/46.5 ms（预算 100）；单条 history 平均 229,081 bytes、最大 305,372 bytes（协调人门槛平均 ≤256 KiB，通过）。CI 首轮 Linux 上超预算后改为只比较 SA 变更 id + 锚身份、复用已读时间线、确定性基线比较，减少整条投影的重复序列化；重跑结果见 PR CI。
- 合同扩展（本 PR 列出）：`SequenceEditBoardEntity.kind` 增加 `adoption`（复制镜头的版本采纳行要进正反补丁才能正确撤销）；新错误码 `SEQUENCE_EDIT_ANCHOR_CONFLICT`。其余 envelope/回执/patch/history 字段不变。
- 修复 K5a 实体 delta 的 `changed` 标志漏算删除行：`planFormat5TimelineEntityUpdate` 之前对纯删除返回 changed=false，TSb 的撤销/删除会跳过写入；现在把 clip/cue 删除计入 changed。

### 接缝和遗留

- `jobs.ts` 的首个生成版本自动选择仍是旧路径（format4 语义）；格式 5 的生成提交/自动选择需要和 job 提交事务一起改，属于后续接线，不在本 PR 偷写。
- 真实导出 RPC 的票据字段/最终 enqueue 由导出能力卡消费本模块；本 PR 只提供 ticket/recheck/blocker 模块和测试，未改异步 admission 的 RPC 契约。
- CS 的画板事务可能同时改 `sequence-edit.ts`/`format5-sequence-sync.ts`：本 PR 按后合入方 merge main 处理；CS 只通过 `BoardSeamProjectionPort`/`MainTrackProjectionPort` 和 `format5-editor-history.ts` 对接。
