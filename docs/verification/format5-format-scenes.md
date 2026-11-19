# FR-B2 复审修复：画幅切换和按场景切开

## 复审六条对应

1. **预览分配 cuts 已修**：`previewSequenceSync` 的 `allocationForCommand(context, command, cuts)` 现在把真实切点传进去；有可切点时 `splitClips` 不再为空。格式 5 真实场景结果的端到端夹具仍缺（见遗留）。
2. **按场景切开对齐格式 3/4**：事务内读场景结果；对**该素材在所有轨上的片段**分别取源范围内切点：
   - 主轨片段按 TSb 的普通 split 顺序规划（左保 ID、右段用 envelope 预分配的新 ID、锚/主轨组/画板链一致）；
   - 其他轨片段在时间线补丁里按普通切开复制行；落在淡入/淡出内的切点跳过；
   - 回执 `sceneSplit` 列出 `split`（clipId/clipIds/cutFrames/fadeCutFrames）与 `skipped`（NO_CUT_IN_RANGE / FADE_BOUNDS）；
   - 一个也切不了整次 `NOTHING_TO_SPLIT`；一次 intent、一条 history、一步撤销；
   - Mio `split-at-scenes` 只收 assetId/resultId；UI 用回执实际 split/skipped 数提示。
3. **画幅对齐格式 4**：补短边档位拒绝 `TIMELINE_FORMAT_TIER_MISMATCH`；字幕绝对 profile 转相对 profile 并记下当前 basis，与片段 layout 同进一条历史补丁；超时间线字节上限拒绝。
   - 格式 4 其他拒绝逐条：待处理编辑/旧时间线请求在格式 5 走统一 history/事务，没有第二条待处理队列，不适用；图片总量限制格式 5 由 timeline/export 字节上限和真实媒体校验承担，不在本 intent 内；快照上限用 `FORMAT5_LIMITS.timelineBytes` 已加。
4. **FR-0 门禁和 Mio 不可用说明**：`timeline.format.set`、`timeline.clip.splitAtScenes` 的 `use` 改为 `sequence.preview/commit`；格式5不可用清单改为指向统一入口/`mioon_sequence_edit`；`format5-legacy-write-gates` 期望同步更新。
5. **清理**：删除 `FS_DEBUG`；`saveTimelineFormat` 直接读 `dataRef`，UI seam 测试补对应的 `dataRef` 参数。
6. **测试**：画幅单测覆盖短边拒绝、layout 冻结、字幕冻结、提交/重复提交、撤销、同 preset no-op；字幕 Mio 动作预览/提交/撤销；其余见遗留。

## 检查

- `format5-mio-write` 9/9；typecheck；五指守卫；三格式指纹；三格式 `mio_entries` 重建；字幕/画幅/FR-0/UI 回归本地全过。
- 格式 5 指纹重生成 90/99 变化，格式 3/4 未改。

## 遗留（本 PR 未完成）

- 场景切开真实场景结果端到端夹具测试仍未加；失败在测试资产/任务状态机夹具，不是产品路径；建议 FR 线补。
- Mio 三动作没有走真实任务 runtime 的审批→提交→撤销集成测试，目前是服务层预览/提交/撤销测试。
- 两项 K1 性能测试未新增。
