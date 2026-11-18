# 剪辑界面接真实数据（UI-E2）

UI-E2 把 UI-E1 的静态组件接到格式 5 的共享 `sequence-edit` 合同。格式 3/4 的时间线、撤销、导出检查仍走原有 RPC；新代码只在 `projectFormatVersion === 5` 时启用。

## 项目 RPC

新增五个项目操作（`packages/contracts/src/sequence-edit-rpc.ts`，已加入 `schemas` 和 `operationEffects`）：

| 操作 | 读写 | 说明 |
| --- | --- | --- |
| `sequence.preview` | 本地写（首次可能建 history cursor） | 把一条 TS 命令包成共享 envelope，返回 `{envelope, planDigest, warnings}`。 |
| `sequence.commit` | 可重放写 | 只提交带同一 `expectedPlanDigest` 的 envelope；一块事务写 board/timeline/baseline/回执/history。 |
| `sequence.history.get` | 只读 | 统一 history 的 epoch/position/revision 和当前 undo/redo 摘要。 |
| `sequence.undo` / `sequence.redo` | 可重放写 | 绑定 actionId 和读到的 cursor/revision，游标变了返回 `SEQUENCE_EDIT_HISTORY_CONFLICT`。 |

服务入口 `packages/business/src/format5-sequence-edit-service.ts` 只转交 `format5-sequence-sync.ts` / `format5-editor-history.ts`，不自己建回执或 history 行。新操作在 `task-tools-v2.ts` 里登记为 forbidden：本卡不加 Mio 工具，Mio 的格式 5 工具归 MT。

## 前端

- `apps/web/src/edit-ui/session.ts`：`Format5EditSession` 一次只跑一个 preview/commit，复制失效时重新预览并只保留第二次 envelope；确认框提交的就是这份 envelope + digest。命令构造覆盖版本、删除、切开、修剪、移动、移到别的轨；`clip-move` 首次返回 `COPY_NODE_REQUIRED` 时用新 `copyNodeId` 再预览，确认或取消都不写数据。
- `App.tsx`：`projectFormatVersion === 5` 时把 `format5Projection(...)` 传给 `Timeline`，属性栏传 `ShotVersionBar` 需要的 shot/version 信息和「在画板中查看」回调；删除/切开/修剪/移动/移到别的轨走上述命令；确认框和撤销条挂在时间线上方；重复点击由 session 的在飞标志挡住；格式 3/4 分支保持原样。
- Cmd/Ctrl+Z、Shift+Cmd/Ctrl+Z 在格式 5 下走统一 `sequence.history.get/undo/redo`；撤销条绑定当时动作 ID，栈顶不是它时只关闭提示，不盲撤。
- 版本下拉/锁按钮经 `clip-version` 写；修剪经 `clip-trim`；属性栏其它未接字段（变换、增益、过渡等）在格式 5 下不落到旧 `timeline.clip.update`，避免写错格式；轨道增删、seed、渲染入口在格式 5 下暂不开放。
- 导出：`timeline-preflight.ts` 在格式 5 项目读取 TSb 票据 blockers；`PLACEHOLDER_CLIP` / `VERSION_TOO_SHORT` 进入现有 preflight 问题列表，带 `clipId`，沿用导出弹窗的「定位片段」。`timeline-export-admission.ts` 的 capabilities 同样先报这两个 blocker（固定 issue 表已扩），render 在最终 accept 前重比三个修订，票据过期返回 `EXPORT_CAPABILITY_STALE`。

## 检查

- `tests/edit-ui-session.test.ts` 7/7：preview→commit 同 envelope/digest、重复点击不重复写、复制确认/取消、undo/redo 绑定 cursor、projection 映射、patch→命令映射。
- `tests/sequence-edit-rpc.test.ts` 3/3：RPC schema、preview→commit→history→undo→redo 共用回执/history、导出占位 blocker。
- UI-E1 回归 `edit-ui-static`、`edit-ui-i18n`、`edit-ui-projection`、导出 preflight/能力相关测试通过；typecheck、五个守卫通过；格式 3/4 的 App/timeline 测试 `agent-timeline-app` 等 75 项通过。
- 无头截图：当前 `screens/` 下是 UI-E1 静态夹具的 21-02/03/04 截图（真实组件、无 RPC）；格式 5 真实项目夹具和本机开发渠道实拍未在本机完成，见报告遗留。


## 统一 RPC（合并 main `887a0f95` 后）

B 的 CS（#296）与 C 的主体绑定（#300）合入后，只保留一套对外操作（`packages/contracts/src/sequence-edit-rpc.ts`）：

| 操作 | 说明 |
| --- | --- |
| `sequence.preview` | 任意 intent（画板、时间线、主体绑定）→ 共享 envelope + `planDigest` + warnings；server 负责补 baseline/history/impact/allocation。 |
| `sequence.commit` | 校验 `expectedPlanDigest` 后按 intent 路由：画板 → `sequence-edit.ts`（CS）；时间线 → `format5-sequence-sync.ts`（TS）；主体绑定 → 共享 TS 事务里的 subject planner。 |
| `sequence.history.get` / `sequence.undo` / `sequence.redo` | 只有 CS 的实现（`format5-editor-history.ts`），含最旧条目淘汰和 `atEarliest`/conflict 字段。 |

B 原来的 `sequence.edit` 不再是公开操作（只在 CS 内部单测/协调方使用）；`sequence.commit` 已覆盖它。我们的旧 `sequence.preview/commit` 服务已删除重复实现，只做统一 dispatcher。主体/画板/时间线现有测试（#296/#300/TSb）通过统一入口全部通过。

## 真实格式 5 项目的无头流程

- `tests/helpers/edit-ui-wire-fixture.ts` 建真实格式 5 kernel（主轨/辅轨、镜头、切开的片段、占位、版本、adoption 基线），`tests/browser_edit_ui_wire.mjs` 用真实 `createServices` 通过 `POST /rpc` 暴露项目服务，并用 Vite 打包真实 `Timeline`、`ShotVersionBar`、`CopyMoveConfirmDialog`、`EditUiNoticeBar`、`Format5EditSession`。
- `tests/fixtures/edit-ui-wire/acceptance.py` 用 Playwright 跑：21-04 删除→唯一撤销条→撤销；Cmd/Ctrl+Z、Shift+Cmd/Ctrl+Z；21-02 版本锁定；21-03 复制并挪动取消/确认（`COPY_NODE_REQUIRED` 二次预览后提交同一 envelope）；导出 preflight 返回 `PLACEHOLDER_CLIP` 并定位片段。
- 截图和报告写到本卡笔记目录 `screens/ui-e2/`（本地证据，不提交）。本机开发渠道实拍留给格式 5 激活前 Q 验收。

## 合同/固定文件

- 新增 `sequence.preview/commit/history.get/undo/redo` schema 与效果描述；`timeline-export-profile.ts` 的 issue 表扩 `PLACEHOLDER_CLIP`、`VERSION_TOO_SHORT`。
- 新增 i18n：`editUi.notice.*`、`editUi.error.*`、`export.preflight.issue.PLACEHOLDER_CLIP/VERSION_TOO_SHORT`。
- 不加 Mio 工具，`agent-task-request-fingerprints-v2` 两套 99 条不变。
- 不改 `.github/test-timings.json`。
