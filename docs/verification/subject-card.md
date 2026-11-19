# SB-b：格式 5 主体上画板

- 卡片：`lane-b-subject-card.md`；SB-a 审查/报告见 `.agents/tasks/howard-format5-subject-binding/`。
- 分支：`howard/subject-card`，从 main `77a1e091` 开，已 merge 最新 main（含格式5 Mio 指纹 #313 等）。PR 目标 main。

## 数据与命令

- `subject_card` 节点只存 `subjectId` 与画板字段；主体/版本行按格式5存储合同保留，建卡不复制主体作品。
- 新增 subject intent（统一 `sequence.preview / commit`，同一 history/undo）：
  - `subject.card.create {nodeId,subjectId,position}`：一张活体主体一张卡；预览/提交在同一事务。
  - `subject.card.delete {nodeId}`：移除卡片，生效绑定写为 `detached` 墓碑并移除引用边；已解绑行保留。
  - `subject.delete {subjectId}`：移除该主体在画板上的全部卡、生效绑定和引用边；主体库主体/版本证据保留（格式5 retain 合同）。物理删除主体库记录需要单独的存储保留决策。
  - 既有 `subject.binding.create/set-mode/detach/restore` 用于卡→镜头连线与跟随/锁定/断开/恢复；新建/恢复的引用边 ID 取 `allocation.edges`。
- `sequence.board.get` 增补 `subjects[]`（名称/类型/head 版本/可锁定版本）与 `bindings[]`（镜头/主体/角色/三态/版本/边 ID），画板卡节点仍来自 `project.get`。
- CS 的统一撤销路径支持 `subject_binding` 墓碑写；subject 动作的一步 undo/redo 与画板、剪辑共用一个栈。

## Web

- `SubjectLibrary` 主体卡可拖到格式5画板；画板内也可用“添加主体”选择器建卡。
- `projectLiveBoard` 用主体行填卡名、类型和 head 版本缩略图；主体卡显示名称/类型/缩略图。
- 主体卡→镜头引用线走 `subject.binding.create`，默认 follow；一卡可连多镜头，引用线沿用 UI-B1 角色标签；引用线选中可断开。
- 镜头右侧 BoardInspector 的“生成输入”列出主体绑定：跟随最新版、锁定 Vn、断开、恢复（已解绑列表）；主体卡选中时列出连接镜头。
- 两种删除各有确认框，列出影响：卡片/绑定（生效/墓碑）/镜头数量；删主体额外提示主体库证据保留。全部一步撤销。
- 格式 3/4 的旧画板/主体库行为不变（主体库拖拽只在格式5画板有 drop 目标）。

## 验证

- `tests/format5-subject-card.test.ts` 5 项：建卡不复制版本、删卡墓碑/边/undo、remove-subject 保留库行、board.get 投影、重复/未知拒绝。
- `tests/board-ui-wire-rpc.test.ts` 6 项：真实 project service 的卡创建、绑定 create/lock/detach、卡删除/undo、主体移除保留库、style 角色引用边。
- `tests/board-ui-live.test.ts` 8 项：卡名/类型/缩略图投影、subject command builder、subject preview→commit 与重复点击。
- 真实无头（本机，非 CI）：`node tests/browser_board_ui_wire.mjs --screens .agents/tasks/howard-subject-card/screens`；真实 kernel+RPC，覆盖拖入建卡、一卡多镜头、锁定/跟随/断开/恢复、主体卡连接列表、删卡/删主体确认与撤销，16 项检查全过；截图/report 在卡目录 `screens/`。
- typecheck/build、五守卫、Mio 指纹（main 合并后三套 fixture）通过。

## 边界

- 主体库物理删除：格式5存储保留 `subjects`/`subject_versions` 证据，本卡实现的是“从画板删除主体”；若产品需要删除主体库记录，需单独存储决策/迁移。
- 生成输入冻结/实际生成消费仍由后续 RI/GE 卡接线；本卡只改绑定关系和画板显示。
- 预演人偶/道具主体引用和 Mio 工具不在本卡新增。
