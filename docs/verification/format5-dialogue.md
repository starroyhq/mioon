# 格式 5 台词 ↔ 字幕（DL-a）

本卡只做台词与字幕两边同步：镜头属性里的 `shot.data.dialogue` 是台词的权威数据，镜头在
主轨时每条有效台词投影为一条真实字幕条（`cue.dialogueRef={shotId,lineId}`），编辑任一边
在同一个 `sequence-edit` 事务里写同一条台词并刷新另一边，一步撤销。「会出声的模型按台词
生成」（provider 附加字段）是 DL-b，等 RI-a 合入后另开。格式 3/4 行为不变，默认仍是格式 4。

## 数据形状（K5a 已冻结，本卡不改）

| 字段 | 约束 |
| --- | --- |
| `shot.data.dialogue` | 有序 `{id,text,speakerSubjectId?}`，行 ID 唯一，文本共用字幕规范（最多两行、每行 20 字符、161 字节） |
| `cue.dialogueRef` | `null \| {shotId,lineId}`，每时间线该对最多一条；`cue.text` 必须等于台词行文本（提交栅栏 SQL 强制） |
| `cue.anchor` | 可空：镜头游离时字幕留原位、不挂靠、保留关联 |

## 合同增量（`packages/contracts/src/sequence-edit.ts`，只做加法）

- 新 intent 家族 `dialogueIntent`：`{side, operation:{kind:'dialogue', edits}}`。
  - board 侧：`add{shotId,line,beforeLineId?}`、`update{shotId,lineId,text?,speakerSubjectId?}`、
    `remove{shotId,lineId}`、`reorder{shotId,lineIds}`。
  - timeline 侧：`set-text-by-cue{cueId,text}`，经 `dialogueRef` 找到同一条台词并两边同写。
  - 与 `intents`/`subjectIntent`/`propertiesIntent`（/FR-B 的 `subtitlesIntent`）恰好一个家族；
    board 与 timeline 编辑不混在一次动作里；impact 必须列全被改镜头与 cue。
- 历史 operation：`board.dialogue.add|update|remove|reorder`、`timeline.dialogue.text`，
  与既有统一撤销栈共用（`applySequenceEditHistory` 按 `board.` 前缀路由），不新增 history 模块。
- 错误码：`SEQUENCE_EDIT_DIALOGUE_INVALID`（行/文本/说话人/目标非法）、
  `SEQUENCE_EDIT_DIALOGUE_CONFLICT`（帧不够/与普通字幕冲突，整次拒绝并给受影响 ID）。
- `SequenceEditTimelineDelta.subtitles` 三态 profile 变更：首个投影台词 cue 需要字幕布局时
  建立 `{profileId}`，撤销同一动作时删除；已有 profile 时不动头部。

## ID 生成

- cue ID 由 `(timelineId, shotId, lineId)` SHA-256 派生为 UUID v5 形状；复制镜头的台词行
  ID 由 `(newShotId, 源行序号)` 派生。预览、提交、精确重试、撤销/重做因此恒等，不需要在
  envelope 里为批量投影分配 ID。
- 台词行 ID 由调用方（UI/服务）生成；Mio 动作的行 ID 由服务端生成，模型不提供。

## 投影规则（`packages/business/src/format5-dialogue-projection.ts`）

1. 主轨上每个镜头（`sequenceSource.kind='shot'` 的连续组）的每条有效台词对应一条真实 cue。
2. 默认时序（P5 D7）：在该镜头主轨段跨度内、避开已有 cue 的连续合法帧段，按台词顺序分配
   剩余空档；已有合法锚的 cue 保持帧位置，只补文字。
3. 放不下（跨度被普通字幕占满/镜头太短）→ 整次拒绝，返回受影响 ID；不截字、不移动、不改名
   普通字幕。
4. 台词顺序与 cue 起点顺序不一致（排序动作）→ 整组按默认时序重排，cue ID 不变。
5. 镜头游离：cue 原位、`anchor:null`、保留 `dialogueRef`；重新接回时复用已有 cue（不新建
   重复），未挂靠的按新跨度补挂。
6. 缩短/删除导致锚失效：原位解除锚定，不自动裁剪。
7. 归档镜头：其 cue 去掉 `dialogueRef` 变普通字幕，帧与文本不变；撤销由 history 补丁恢复绑定。
8. 切开：SA 已按字幕起点转交分段锚并保持 ID，投影只做校验。
9. 复制镜头：复制行 ID 定长派生，`(shotId,lineId)` 每时间线唯一，cue 由投影生成。
10. 旧项目普通字幕不改名、不猜台词；转换不清空。

## 入口

| 入口 | 作用 |
| --- | --- |
| `format5-dialogue.ts` `previewDialogueAction` / `runDialogueAction` | 台词动作的预览 envelope 与单事务提交（一行 shot 行 + cue 行 + 一条 history + 回执） |
| `format5-sequence-edit-service.ts` | `sequence.preview` / `sequence.commit` 按 `dialogueIntent` 路由 |
| `format5-sequence-sync.ts` `patchMainTimeline` | 画板/主轨动作的投影接缝：预览、提交、CS 事务内接缝共用同一份 cue 投影 |
| `apps/web/src/ShotDialogue.tsx` + `dialogue-panel-state.ts` | 21-06 镜头属性台词栏；`名字：台词` 一行一条，保存走同一 intent |
| `SubtitleLane` `dialogueCues` | 剪辑字幕轨的关联标记（台词 cue 左侧标记 + 提示里带镜头名） |
| Mio：`sequence.tool.edit` 的 `dialogue` 动作、`sequence.inspect` 的 `dialogue` 行 | 按对齐规则开放；格式 5 指纹按授权重生成，格式 3/4 两套不变 |

## 检查与结果

- `tests/format5-dialogue.test.ts`（14 项）：两侧一致、ID 唯一、切开跟随、删行/撤销、
  游离/接回/归档/复制、普通字幕不动、超长/帧不足/重叠拒绝、noop、精确重放、未挂靠 cue 不被后续同步自动挂上。
- `tests/format5-dialogue-performance.test.ts`：500 镜头 + 500 台词/字幕 + 1,000 锚定段，
  单次台词编辑共享事务本机 p95 约 41 ms（预算 100 ms；Linux CI 断言代码路径 p95 ≤200 ms）。
- `tests/sequence-edit-contract.test.ts`：dialogueIntent 正反例与历史补丁兼容。
- `tests/format5-mio-write.test.ts`：Mio 台词增删改排序 + 一步 Mio 撤销 + `sequence.inspect` 读回。
- `tests/dialogue-panel-state.test.ts`（5 项）、`tests/dialogue-ui.test.ts`（3 项）：面板文本/差异/未载入说话人/空状态/四语文案与
  生产接线（App/Inspector/Timeline/SubtitleLane）静态检查。
- 回归：`format5-timeline-sync`、`format5-timeline-sync-b`、`format5-clip-properties`、
  `sequence-edit*`、`format5-editor-history`、`format5-subject-binding`、`format5-mio-*`、
  `project-format5-*`、`subtitles-ui`、`edit-ui-static`、`timeline-collapsed-presentation` 全过。
- 类型检查、五个守卫、工具 schema 生成 `--check`、格式 5 指纹重生成（格式 3/4 逐字节不变）。
