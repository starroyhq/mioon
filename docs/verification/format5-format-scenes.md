# FR-B2：格式 5 画幅切换和按场景切开（+ MT-5 画板/格式工具）

## 画幅

- 合同新增 `formatIntent`（timeline origin，presetId 取 `TIMELINE_FORMAT_WRITE_PRESETS`），仍是 `intents/subjectIntent/propertiesIntent/formatIntent` 四选一。
- `format5-format-set.ts` 一次事务：
  - 每个没有显式 `layout` 的片段冻结当前画幅为 `{profileId:'mioon-clip-layout-v2', basisPresetId:<旧 preset>}`，已有显式 layout 的片段不动；
  - 时间线 header 的 fps/width/height 切到新 preset；
  - 整个新时间线用 `getFormat5TimelineIssue` 校验，失败拒绝；
  - 一条 history-13 补丁同时含 header 旧/新三态和变化 clip 行，一步撤销/重做；header 变化带 `timeline.format.set` 操作名；
  - 时间线 revision 前进，导出票据按 revision 冻结/过期。
- 撤销时先按目标 header 校验 patch 行，再一起写 header + 行，避免旧画幅片段在新 header 下被误判。
- 相同 preset 返回 `SEQUENCE_EDIT_NOOP`，不写历史。

## 按场景切开

- 合同新增 `split-at-scenes` track intent（clipId/assetId/resultId）和 `clip-split-scenes` 命令；TS sync 在预览和提交事务内读场景结果（`readSceneSplitCuts`），过期/不匹配返回 `SEQUENCE_EDIT_SCENE_RESULT_CONFLICT/STALE`。
- 服务端把该 intent 展开成按切点顺序的普通 `split` 命令：左段保 ID，右段使用 envelope 预分配的新 ID（请求重试复用同一 allocation），锚/拆分组/画板链按 TSb 的同一 split planner 转交；一次 envelope、一条 history、一次撤销。
- 新 preset/场景命令都开放给 Mio：`mioon_sequence_edit` 新增 `format-set`、`split-at-scenes` 动作（format-set 与切开都强制审批），ID 和 envelope 仍由服务器生成。
- FR-0 门禁里 `timeline.format.set`、`timeline.clip.splitAtScenes` 改为指向 `sequence.preview/commit`。
- UI：格式面板和场景切开在格式 5 下走 `Format5EditSession.format/splitAtScenes`，不再调旧 timeline RPC。

## MT-5 状态

- 本 PR 完成本卡画幅/切开的 Mio 工具。
- 字幕 `subtitlesIntent` 的 Mio 工具需要 C 的 FR-B #314 合入（当前 main 没有该 intent）；SB-b 主体卡需要 B #316 合入。二者未在本 PR 硬编码另一分支合同，留到合入后的小 MT-5 PR。

## 检查

- `tests/format5-mio-write.test.ts` 8/8：格式切换+冻结 layout+header 撤销、D5、画板、既有写工具边界。
- 五指守卫、typecheck、tool schema/schema manifest `--check`、三格式指纹、三格式 `mio_entries` 重建、合同/写栅栏/TS/UI 回归本地通过；格式 5 指纹重生成 90/99 变化（format-set/split-at-scenes schema 与工具描述），格式 3/4 逐字节不变。
- 场景切开的完整存储夹具需要真实 scene task 状态机；本 PR 未加该集成测试，已由合同/planner 静态路径和 CI 其余回归覆盖（见报告遗留）。
