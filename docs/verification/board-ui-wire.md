# UI-B2：格式 5 画板接真实数据

- 卡片：`lane-b-board-ui-wire.md`；开工审查回复见 `.agents/tasks/howard-board-ui-wire/coordinator-review.md`。
- 分支：`howard/board-ui-wire`，从 main `beee2afe` 开（开工后又合入 `52cd5372` 的独占计时 hotfix）。
- 范围：格式 5 项目的画板由真实 `project.get` 行和统一 `sequence.*` RPC 驱动；格式 3/4 画板仍走原 App 路径。

## 统一 RPC（UI-B2 增量）

- `sequence.preview` / `sequence.commit` 继续是唯一写入口；画板 intent 由 CS 的 `sequence-edit.ts` 协调方执行。
- 新增画板 intent（`sequence-editing.ts`）：
  - `board.root.create {nodeId,name,position}`：新建一个成片根，不改当前主轨。
  - `board.shot.append {nodeId,name,position?}`：在活动成片链尾新建镜头、接链和主轨片段；一步撤销。预览服务分配新 clip/edge identity 并返回在 envelope allocation 里。
  - `board.layout.move {moves[]}`：批量位置写入，只改画板坐标，不推进时间线/同步修订；一步撤销。
- 新增只读 `sequence.board.get {projectId}`：返回 `timelineRevision/syncRevision/inSync/archived[{id,kind,name,position}]`。画板图、镜头、版本、素材仍由 `project.get` 提供。
- 历史仍只有一份：`sequence.history.get/undo/redo` 由 `format5-editor-history.ts` 写入，带淘汰与 `earliestPosition/atEarliest`。画板与剪辑共用同一个栈。

## Web 接线

- `apps/web/src/board-ui/live.ts`：`projectLiveBoard` 把 `project.get` 的 shots/nodes/edges/versions/assets/jobs/clips 映射成 UI-B1 的 `BoardUiNode`/边/位置/`projectBoardUi` 投影。时长优先取已应用版本素材时长，退化为主轨片段时长；引用边角色扩到格式 5 的 `last_frame/reference_image/style_reference`。
- `apps/web/src/board-ui/live-session.ts`：preview→commit、digest、in-flight 去重、history/board 读取与 undo/redo 绑定 actionId/cursor。
- `apps/web/src/board-ui/BoardUiLive.tsx`：真实投影上的工具栏（添加镜头、新建成片、已删除）、边操作（断开/在此插入）、归档恢复、失败原因、撤销条、键盘端口连线、拖动布局写回、减少动态效果、大画板虚拟化。
- `apps/web/src/board-ui/BoardInspector.tsx`：画板概览、选中卡片、版本选择、在剪辑中查看、删除、归档列表、同步修订。
- `App.tsx`：`projectFormatVersion===5` 时画板分支渲染真实画板，右侧 dock 使用 BoardInspector；Cmd/Ctrl+Z 与 Shift+Cmd/Ctrl+Z 在两种模式都走统一历史（`atEarliest` 时禁用）；画板选中镜头可跳到剪辑并定位主轨片段。格式 3/4 分支保持原样。

## 验证

- 后端：`tests/board-ui-wire.test.ts`（layout/root/append/archive/connect+insert 分配、拒绝、undo/redo）；`tests/board-ui-wire-rpc.test.ts`（真实 project service：board.get、换版本、追加镜头、布局、连接/断开、真实撤销）。
- Web 纯逻辑：`tests/board-ui-live.test.ts`（投影/时长/状态/引用游离、intent 形状、session preview→commit、重复点击、历史绑定）。
- 真实无头浏览器（本机，非 CI）：`node tests/browser_board_ui_wire.mjs --screens .agents/tasks/howard-board-ui-wire/screens`，真实 kernel + HTTP project RPC + 生产 Board 组件；覆盖 21-01 初始、版本、键盘端口断开/重连、成片条 + 加镜头、删除/撤销条、新成片根、布局拖动、减少动态效果，9 项检查全过。证据 `screens/report.json`。
- 性能：`--stress` 500 镜头 + 700 顺序边 + 200 引用边真实夹具，画板平移采样 p50 16.7ms、p95 33.4ms（UI-B1 200 边基线 p95 16.8ms；采样窗口含大画板的一次两帧抖动，warm-up 后测量）。截图 `screens/stress/`。
- 本机：typecheck、build、五个守卫、Mio 请求指纹两套逐字节不变、格式5合同/CS/TSb/UI-E2 回归通过。

## 已知边界

- 引用线写入（首帧/主体/预演/音频）按协调人回复归 RI / SB-b；本卡只做显示、角色标签、合法接口提示。`reference.attach/detach` 在格式 5 下由 FR-0 门禁。
- 格式 3/4 画板 App 分支未改，现有板卡/组件回归通过；真实工作台的格式 3/4 截图需要 Electron 开发渠道，留给格式 5 激活前 Q 验收。
- 大画板（500 镜头全画布可见）平移仍有偶发两帧抖动；p50 保持 60fps，后续可再做边/端口分级渲染。
