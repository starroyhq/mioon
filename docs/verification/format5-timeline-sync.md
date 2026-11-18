# 格式 5 主轨同步（TSa）

本卡把画板顺序链和剪辑主轨接进同一个格式 5 写事务：关联和按根计划、版本跟随/锁定、占位首次换版、同步基线、共用事务回执和一步撤销。锚、删除/切开/挪动、复制并挪动确认和导出准入属于 TSb，不在本次改动里。格式 3/4 的行为不变；这里没有新增默认入口，应用默认仍是格式 4。

## 入口

`packages/business/src/format5-sequence-sync.ts`，类型在 `packages/contracts/src/sequence-sync.ts`（`@mioon/contracts` 转出）。

| 入口 | 作用 |
| --- | --- |
| `readSequenceSyncProjection(store)` | 只读投影：`timelineId/rootNodeId/mainTrackId`、两侧 revision、链节点顺序、游离节点、主轨组（node/group/clip/versionMode/applied version/长度）和画板选中版本。TSa 的「按根计划」从这里取输入。 |
| `runSequenceSync(store, envelope, command)` | 在一个 `ProjectStore.tx` 内应用一条命令，返回不可变回执。 |
| `undoSequenceSync(store, {requestId, expected, actionId})` | 对栈顶动作做一次逆补丁，保持一步撤销。 |

命令（`SequenceSyncCommand`）：

- `sync-board`：链修好后显式让主轨跟随当前链（SA 的 `sync-board`）；不会改变画板边。
- `board-version {nodeId, versionId|null}`：画板侧选择版本。跟随段换到新版本；锁定段保持；清空选择保留已应用片段（D4）。
- `clip-version {clipId, versionId|null, mode:'follow'|'locked'}`：剪辑侧。`locked` 只锁这一段并保留剪的长度；`follow` 选择/解锁后走同一跟随规则。
- `undo {actionId}` 走独立入口 `undoSequenceSync`。

`envelope = {requestId, expected:{syncRevision,timelineRevision}}`。`requestId` 是稳定重放键：同 ID 同输入返回原回执，同 ID 不同输入冲突；`expected` 是两侧 CAS，旧值直接拒绝且不写任何东西。

## 回执（给 UI-E2）

`SequenceSyncReceipt`（JSON，≤64 KiB）：

```
{ok, operation, requestId, actionId, changed,
 root:{timelineId, rootNodeId, mainTrackId},
 syncRevision, timelineRevision,
 nodes|edges|shotSources|clips|tracks|anchored:{created[],updated[],removed[]},
 warnings:[{code:'SOURCE_TOO_SHORT', clipId,nodeId,versionId,shortByFrames}],
 history:{actionId, undoable, position}|null}
```

- `changed:false` 是真正的无操作：不写历史栈、不推进 `syncRevision`/`timelineRevision`，只记回执供重放。
- 版本太短时保留原已应用版本和剪的长度，把原因放进 `warnings`；画板选中版本仍前进。
- `history` 对最后一个错误动作返回 `undoable:false`（栈顶已变），UI-E2 的撤销条按此禁用。
- 回执里的 ID 是格式 5 的真实行 ID：`clips` 是 `timeline_clips.id`，`tracks` 是辅轨片段/字幕的 ID。

错误码（`SEQUENCE_SYNC_ERROR_CODES`，HTTP 409）：`SEQUENCE_SYNC_FORMAT_REQUIRED`（非格式 5）、`SEQUENCE_SYNC_ROOT_NOT_BOUND`、`SEQUENCE_SYNC_STALE_REVISION`、`SEQUENCE_SYNC_REQUEST_CONFLICT`、`SEQUENCE_SYNC_PLAN_REJECTED`（SA 原因和 ID）、`SEQUENCE_SYNC_UNDO_STALE`、`SEQUENCE_SYNC_UNSUPPORTED_COMMAND`。

## 事务

1. 校验是格式 5；查 `main.editor_requests` 同 `requestId + inputDigest`（未知结果按原键找回，不换 ID 重试）。
2. 读 `timelines` 头 + `timeline_clips`/`timeline_cues` + `sequence_sync_state` + 活体节点/边/镜头/版本/素材。读路径只做拓扑投影；终态由 store 提交栅栏（K5a `fenceFormat5ProjectContent`）再次全量校验，读侧优化不放宽任何写入。
3. 用 SA `planChainSync` 生成两侧 plan；版本命令在这里核 `(nodeId,versionId)` 归属和素材 hash。
4. 版本选择写镜头行；主轨和锚的变化只写变化的 clip/cue 行 + 头，一次内容戳；`sequence_sync_state.revision` 精确 +1 并写新基线。
5. 写 history-13：新 `editor_history_entries`（正/反补丁）、推进 `editor_history_state`，然后写不可变回执。所有内容与历史在同一个事务内。
6. 提交栅栏通过才发布回执；任何失败整次回滚。

基线（`sequence_sync_state.baseline`，严格的 `{version:1,board,track}`）在每次成功动作后重算：`board` 是链顺序的节点及画板选中版本/素材，`track` 是主轨有序组及版本模式/实际应用版；修剪、锚、完整项目数据不复制进基线。同步 revision 是 CAS，单调增长。

撤销只做栈顶动作：读 entry 的正/反补丁，逆写镜头选择、主轨/辅轨行、头长度和基线，`syncRevision`/`timelineRevision` 继续向前（只增不减），栈位置减一；不新增历史 entry。栈顶已变时返回 `SEQUENCE_SYNC_UNDO_STALE`。

## 覆盖和结果

`tests/format5-timeline-sync.test.ts`，9/9：

- 投影：主轨关联、链顺序、两侧 revision、画板/主轨投影。
- 占位首次换版：按新版本完整源长度取长度（不是占位估计长度），后续片段后移，锚定的辅轨/字幕保持相对 owner 的偏移。
- 版本过短：保留原已应用版本和剪辑长度，回执给 `SOURCE_TOO_SHORT`。
- 锁定/跟随：锁定段不跟随后续画板选版；剪辑侧解锁后跟随当前选择且保留剪的长度。
- 清空画板选择：保留已应用片段，基线记录空选择。
- 重放/CAS：精确重放返回同一回执且不改状态；同 ID 不同输入冲突；无操作不写历史栈；旧 revision 原子拒绝。
- 撤销：一步逆补丁恢复镜头选择、占位片段、下游位置和基线，栈位置回到 0。
- 格式 4 store 不进入新入口。

`tests/format5-timeline-sync-performance.test.ts`：K1 形状 500 镜头 + 500 主轨段 + 1,000 辅轨段 + 500 字幕；每次动作在 500 段主轨中间换版并让后缀移动。本机两次运行 p50 40.99–49.27 ms / p95 45.14–65.78 ms / max 51.69–74.74 ms（预算 p95 ≤100）；测试在 CI（`CI` 环境）用 200 ms 门槛，数值写进 CI 日志。一次同步读入、规划、写变化行、历史、回执和提交栅栏都在计时内。

## 给 CS / MT 的对接

- CS 画板事务完成后调用同一 `runSequenceSync(store, envelope, {kind:'sync-board'|'board-version',...})`，把边/节点的实际变化留在画板事务里；回执就是两侧唯一结果。SA 审查里「修复让链恢复干净的那一步要在同一事务里接着 sync-board」即：CS 的修复动作在同一事务内调用本入口一次，保持一步撤销。共用 action envelope/错误码以 `sequence-sync.ts` 为准，等 B 线合同合入后再对齐字段，不另造一套。
- MT（Mio 工具，后续卡）：服务层入口可直接复用；命令有界、输入是稳定 ID 而不是整行数据，回执已包含两侧受影响 ID 和计数。本卡不加 Mio 工具，指纹不变。
- UI-E2：监听回执里的 `syncRevision/timelineRevision/warnings/history`；占位片段显示 `sourceState`，版本跟随/锁定显示主轨组 `versionMode`，撤销条按 `history.undoable` 和 `actionId` 工作。不要在前端重新算链或版本。

## 局限和后续

- TSb 才能做：锚的删除/重挂、切开/挪动/复制并挪动确认、导出准入边界、跨轨移动；本卡遇到节点的 `changes` 或边的 `changes` 会明确返回 `SEQUENCE_SYNC_UNSUPPORTED_COMMAND`，不会偷偷写。
- CS 共用合同合入后：把画板事务的 action envelope、错误码表和事务内调用约定对齐；本卡先把形状发布在 contracts 里。
- 目前只支持「读关联」，显式改绑主轨/根的协调命令留给 TSb/UI-E2 的显式入口（K5 创建时已建立合法关联）。
- 撤销只做栈顶；重做、旧两栈合并和 Mio 的独立补偿按 P5 D5。
- `sync-board` 需要新建片段（`NEW_CLIP_ID_REQUIRED`）时属于 TSb 的创建路径，本卡拒绝并提示。
- 格式 5 默认开启仍是单独提交；本卡不改变应用默认格式。
