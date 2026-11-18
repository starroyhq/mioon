# 剪辑界面静态投影与组件（UI-E1）

这一层只做剪辑侧的展示：组件不读取后台、不调用项目命令、不写项目数据、不改格式。输入由调用方从一份时间线快照组装；正式接线（TS/UI-E2）负责把持久化字段映射成这里的展示形状。当前 main 的默认渲染路径不传这些可选属性时与改动前逐像素一致，见文末的对照证据。

## 投影数据

`apps/web/src/edit-ui/projection.ts`

`projectEditUi(input: EditUiTimeline): EditUiProjection` 接收：

- `fps`、`timelineRevision`、`syncRevision`：本次快照的时基与两个修订；
- `mainTrack: {trackId, sequenceNodeId} | null`：格式 5 的显式主轨关联。`trackId` 必须指向快照内存在的视频轨，否则整体视为未关联；
- `tracks: {id, kind}[]`；
- `clips: EditUiClip[]`：主轨片段可带 `sequenceSource`（`shot` 或 `media`）、`sourceState`、`durationFrames` 等；其他轨片段可带 `anchor`；
- `cues: EditUiCue[]`：字幕条，可带 `anchor`。

字段语义对齐格式 5 方案 §2.2/§2.3，但名称是网页展示用的，不直接持久化。镜头来源包含 `nodeId`、`segmentGroupId`、`versionMode: 'follow'|'locked'`、画板选中版本 `boardVersion` 和已应用版本 `appliedVersion`。锚点为 `null`（未挂靠，保留原位）或 `{clipId, offsetFrames}`（挂到主轨具体分段）。

输出 `EditUiProjection`：

- `mainTrackId`、`sequenceNodeId`：校验通过的主轨与成片根；
- `clips: Map<clipId, {status?, shot?, anchor?}>`：主轨镜头片段的状态（`follow`/`locked`/`placeholder`）、镜头来源；非主轨片段的锚点投影；
- `cueAnchors: Map<cueId, anchor>`：字幕锚点投影；
- 两个修订原样带回，供 UI-E2 判断过期。

判定规则：

- `status.kind === 'follow'` 的 `version` 是画板当前选中版本（缺失时退回已应用版本）；`locked` 的 `version` 是锁定的已应用版本；`placeholder` 带 `durationSeconds = durationFrames / fps`。已应用版本仍可从 `shot.appliedVersion` 读到，便于显示「跟随但尚未应用」。
- 锚点只有在 `item.startFrame === segment.startFrame + offsetFrames`、偏移是 `[0, durationFrames)` 内的整数、且目标分段仍在主轨时才投影为 `attached`；`anchor: null` 投影为 `detached`；其余不一致投影为未定义（不画线、不加标签），避免拿旧位置冒充连接。
- 主轨片段仍用 `validChainClipFrames` 校验，坏分段不进入投影。

辅助导出：`editUiAnchorEntries(projection)`（当前可画的锚线，`{id, kind, startFrame, targetClipId}`）和 `editUiTrackBadge(tracks, trackId)`（`V1`/`V2`…，与时间线轨道头一致）。

## 组件

`apps/web/src/edit-ui/`

- `EditUiClipTitle`：片段标题加状态后缀，跟随画板 ` · V2`、锁定 ` · 锁定 V1`、占位 ` · 待生成（占位 4 秒）`。
- `EditUiAnchorLayer`：在 `.timeline-content` 内按 DOM 实际布局量出字幕/叠加素材起点到主轨分段小圆点的竖线；`x` 来自源元素（因此跟随缩放和滚动），纵向来自轨道实际高度（普通/紧凑/换轨都成立）。投影未提供时不渲染任何节点。
- `EditUiDetachedAnchor`：锚断开时的「未挂靠」轻标签，原位显示在片段/字幕右侧。
- `ShotVersionBar`：属性栏顶部，标题 `镜头 02 · 窗口剪影` +「在画板中查看 ↗」按钮、版本下拉（跟随画板 · V2 / 锁定 · V1）和右侧锁按钮。只调 `onRevealShot` 与 `onVersionChoice({mode, versionId})`，不写数据。
- `CopyMoveConfirmDialog`：21-03 的「复制成新镜头再挪？」确认框，只有标题和两个按钮（设计稿里的说明句按界面文字规则不做）。回调参数 `EditUiCopyMoveRequest` 绑定 `{clipId, nodeId, segmentGroupId, targetTrackId, targetStartFrame, timelineRevision}`，UI-E2 用它核对原片、目标位置和修订。Enter 确认（焦点在取消按钮时取消）、Esc 取消、Tab 在两个按钮内循环。
- `EditUiNoticeBar` + `editUiNoticeReducer`：21-04 的撤销条。「已从主轨移除 …」+ 撤销 + 关闭；同一时间只显示一条，新通知替换旧通知；带 `id`，迟到的关闭/撤销不会关掉新通知。撤销按钮是普通可聚焦按钮。
- `edit-ui.css`：全部选择器都挂在新增的可选 class 上。

现有组件的可选属性：

- `Timeline.editUiProjection?: EditUiProjection | null`：主轨轨道头改为 `V1 · 主轨`（badge 仍在），片段标题后缀、占位整体变暗、锚线与未挂靠标签。不传时保持原渲染。
- `SubtitleLane.cueAnchors?: ReadonlyMap<string, EditUiAnchorProjection> | null`：字幕的未挂靠标签。
- `TimelineInspector.sequence?: EditUiInspectorSequence | null`：「镜头 …」+ 在画板中查看、版本下拉与锁按钮；轨道下拉里主轨显示 `V1 · 主轨`。不传时保持原属性面板。

UI-E2 接线要点：把自己的时间线快照映射成 `EditUiTimeline`（主轨关联、片段的 `sequenceSource`/`sourceState`/`anchor`、字幕 `anchor`）后调用 `projectEditUi`；把选中片段的投影交给 `TimelineInspector.sequence`；把确认框请求、撤销条通知的显示状态接到自己的命令与回执上。本卡不接后台，拖动/删除/切开仍由调用方处理。

## 四语与键盘

新增文案在 `packages/i18n/src/catalogs/edit-ui.ts`（简中、繁中、英、日），`validateCatalogs` 校验占位符一致。确认框和撤销条的键盘行为见上；不影响时间线原有的键盘处理。

## 减少动态效果

新增组件没有持续动画或无限循环动画，系统 `prefers-reduced-motion`、应用减少动态效果和显式属性下都没有仍在运行的无限动画；时间线原有动画不受影响。

## 验证入口

```sh
node --test --test-timeout=600000 tests/edit-ui-projection.test.ts
node --test --test-timeout=600000 tests/edit-ui-static.test.ts
node --test --test-timeout=600000 tests/edit-ui-i18n.test.ts
node tests/browser_edit_ui_static.mjs --mode design --report /private/tmp/edit-ui-static/design-report.json
```

按开发环境约定使用 Node 24；浏览器脚本用仓库已有的 Python Playwright 和本机 Chrome（`--browser` 可指定 Chromium）。`--serve` 打印只含合成场景的本地夹具地址；`--screens .agents/tasks/howard-edit-ui-static/screens` 只留本地，不提交、不上传。

浏览器验收覆盖：主轨标记与属性栏 `V1 · 主轨`、三种片段后缀和占位变暗、三条锚线与主轨小圆点的几何关系、缩放/滚动后锚线的相对位置、未挂靠标签原位显示、版本下拉与锁按钮的回调、确认框的绑定参数和 Enter/Esc/Tab、撤销条唯一显示与键盘可达、四语、减少动态效果，以及零后台/外部请求、零页面错误。

## 对照证据

- 不传新属性时旧时间线不变：`tests/fixtures/edit-ui-static/baseline-entry.tsx` 只渲染真实 `Timeline`，分别用 main `8f86b5a3` 与分支工作树构建同一夹具，Chromium 157 无头、1440×900、DPR1 截图为同一 SHA-256（`5eb473c8…`）。对照记录留在本卡笔记目录的 `baseline-compare.json`，截图只留本地。
- 21-02/21-03/21-04 对照截图由同一夹具的三个场景生成，合成顶栏、素材栏和预览只是截图薄壳；时间线、属性栏顶部、确认框和撤销条是真实组件。

## 局限

- 机器上真实项目的 TS/UI-E2 接线尚未存在：主轨关联、版本命令、复制并挪动和撤销都还是回调，夹具只记录调用。
- 截图是隔离组件场景，不等于真实 Electron 窗口的最终像素；整合后的验收在 UI-E2。
- 夹具用仓库自带示例媒体和合成画面，不打开项目、不启动宿主。
