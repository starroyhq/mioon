# MT-4：完整 D5 + 画板 Mio 工具

本 PR 完成 D5 的双栈撤销语义，并开放 UI-B2 #308 的画板命令给 Mio。

## D5 双栈

- `sequence.history.get` / `undo` / `redo` 增加可选 `origin: 'user' | 'mio'`；UI-E2、UI-B2 明确请求 `user` 栈，Mio 工具用 `mio` 栈。
- history 投影按 origin 找最近的用户/Mio 动作：
  - 用户视图永远不返回 Mio 动作；如果 Mio 动作在用户动作之后，`undo` 指向用户自己的动作，但 `undoConflict=true`、`undoBlockedBy='mio'`，UI 不发撤销并提示「上一步是 Mio 的改动，请在 Mio 里撤销」。
  - Mio 视图同理：之后有用户动作时 `undoBlockedBy='user'`，`mioon_sequence_undo` 返回 `SEQUENCE_EDIT_HISTORY_CONFLICT`（`reason:'USER_ACTION_ABOVE'`），不越过用户动作。
- 服务端 `sequence.undo/redo` 校验目标 entry 的 origin 必须等于请求 origin；跨栈调用返回 `SEQUENCE_EDIT_HISTORY_CONFLICT`（`reason:'ORIGIN'`），不依赖 UI。
- Mio 的 actionId 省略语义保留：取 Mio 栈顶；显式 actionId 必须仍是 Mio 栈顶，否则冲突。已撤回的 Mio 动作不能被旧请求重复补偿（receipt/游标既有约束）。
- UI-E2 `format5UserUndoBlocked` 同时识别 `undo.origin==='mio'` 和 `undoBlockedBy==='mio'`；UI-B2 `BoardUiSession` 同样传 user origin 并尊重 conflict。

## 画板 Mio 工具

- `mioon_sequence_edit` 增加动作：`board-root-create`（name + bounded position）、`board-shot-append`（name + 可选 bounded position）、`board-layout-move`（最多 50 个已检查 nodeId + bounded x/y）。节点/边/剪辑 ID 仍由服务器展开；布局移动只接受模型给出的目标和坐标，边界 ±1,000,000。
- 新只读工具 `mioon_sequence_board_get` 映射 `sequence.board.get`，进入格式 5 core 和格式 5 诊断目录。
- 画板写动作与既有写入口一样：服务器预览 envelope，审批/影响计数/回执，commit 只用预览 envelope。

## 指纹

- 格式 5 套件按授权重生成：99 条中 96 条变化、3 条（纯文本诊断）不变。变化来源：core 新增 `mioon_sequence_board_get` 工具定义，以及 `mioon_sequence_edit` schema 新增三个 board 动作；逐条旧/新 bytes、sha256、来源在 `mt4-fingerprint-differences.md` 和 PR。
- 格式 3/4 两套未重新生成、逐字节不变；三格式 runtime `mio_entries` 重建一致。
