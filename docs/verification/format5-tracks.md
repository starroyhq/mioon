# FR-D：格式 5 轨道管理

- 卡片：`lane-b-format5-tracks.md`；分支 `howard/format5-tracks`，从 main `4735462f` 开。
- PR：<!--PR-->。

## 命令与规则

- 新增 `trackIntent`（统一 `sequence.preview / commit`，一条 history-13、一步 undo/redo）：
  - `track-structure.add`：`trackId`、`trackKind=video|audio`、可选 `name`/`orderIndex`；默认追加到最大 orderIndex+1；最多 12 轨；新轨 `hidden:false`、`muted:false`。
  - `track-structure.update`：`trackId` + `patch`（`name`/`hidden`/`muted`/`orderIndex`，至少一项）；音频轨不能隐藏；orderIndex 必须在 0..11 且不能与别的轨道重复。
  - 历史名：`timeline.track.add` / `timeline.track.update`（对齐格式 3/4 操作名）。
- 主轨规则：`mainTrack.trackId` / `sequenceNodeId` 永不改；轨道 id/kind 不可变；主轨始终是 video；不能删。排序只改 `orderIndex`，主轨身份保留。
- 删轨：格式 3/4 合同和 UI 都没有轨道删除入口（无 `timeline.track.delete` RPC/Mio 工具，Timeline 无删除按钮），格式 5 也不提供。若以后要删轨，按 TSb 规则处理锚（锚到被删片段的内容原位解除），另卡设计。
- 锁定：轨道锁定是客户端视图保护（`trackLocks`，不是时间线数据，也没有持久列），格式 3/4/5 一致；只阻止时间线直接编辑，不阻止画板链同步主轨。若要求锁定主轨也阻止画板同步，需要格式 6 持久锁定字段。
- 改名/排序的 UI：格式 3/4 轨道头原本没有改名/拖拽排序按钮；本卡只打开已有的添加/隐藏/静音（和既有锁定）按钮，改名/orderIndex 经统一动作/Mio 可用。
- 格式 3/4 继续走旧 `timeline.track.add/update`，行为不变。

## 实现

- 合同：`SequenceEditTrackIntent`/`TrackPatch`/`TrackEdit`；`SEQUENCE_EDIT_OPERATIONS` 增两个历史名；`SequenceEditTimelineDelta.tracks?` 携带全量 header 行；`SequenceEditImpact.trackIds?`；`SequenceEditTargetKind` 增 `timeline_track`；affected counts 增 `tracks`。
- 服务：`packages/business/src/format5-tracks.ts` 计划/校验/envelope/预览/单事务提交；`format5-sequence-edit-service.ts` 路由 trackIntent；`format5-sequence-sync.ts` 应用 tracks；CS 撤销的 timelineDeltaMatches 比较 tracks；`format5-editor-history.ts` affected total 计 tracks。
- Web：`App.tsx` 的 `onTrackAdd/onTrackUpdate` 在格式 5 下走 `Format5EditSession.runTrack`，格式 3/4 原路；`edit-ui/session.ts` 增 `runTrack` 预览→提交握手与错误映射；i18n 两条通知/一条错误。
- Mio：`mioon_sequence_edit` 增 `track-add`、`track-update`；旧 `timeline.track.*` 目录文案改指统一动作，旧入口仍不可用；格式5指纹重生成，格式3/4不变。

## 验证

- `tests/format5-tracks.test.ts`（4）：增/改/撤销/重做；拒绝无效轨道/重复 ID/顺序/音频隐藏/未知/空补丁/no-op；12 轨上限；重放；主轨身份。
- `tests/format5-track-session.test.ts`（2）：预览→提交、拒绝不提交、inflight。
- `tests/board-ui-wire-rpc.test.ts`：真实 service 的 trackIntent add/update、undo、digest 拒绝。
- `tests/format5-mio-write.test.ts`：Mio track-add/update envelope、origin mio、一步撤销。
- `tests/sequence-edit-contract.test.ts`：操作名/目标种类/impact 计数。
- typecheck/build、155 项回归、五守卫通过；format3/4 指纹不变，format5 指纹 90 条变化全来自 `mioon_sequence_edit` 两个新 action（PR 附录逐条列 bytes/SHA）。

## 待定

1. 主轨锁定的产品语义（见上）需协调人确认；当前保持“锁定只保护时间线编辑，画板链仍权威并同步主轨”。
2. 删轨不提供；若要做，另卡按 TSb 锚规则。
3. 剪辑界面没有轨道拖拽排序 UI；orderIndex 仅统一动作/Mio 可用。
