# 格式 5 Mio 工具（MT，写半）

本 PR 是 #305 读半的写半：高层的、有界的格式 5 序列写动作全部经统一 `sequence.preview → commit`，并补 D5 Mio 撤销和 origin 区分。片段属性（FR-A #306）尚未合入；格式 5 三协议 99 条指纹新套件未在本 PR 完成（见遗留）。

## Mio 写工具

- 新合同 `packages/contracts/src/mio-sequence.ts`：
  - `sequence.tool.edit` 只接受一个动作和已检查目标：`connect`/`disconnect`/`insert`/`delete-node`，`reorder`/`remove`/`split`/`set-mode`/`copy-move`，`subject-binding`（create/set-mode/detach/restore）。严格拒绝额外字段、自建 envelope、生成的 rightClipId/copyNodeId/bindingId。
  - `sequence.tool.undo` 只接受 `actionId`。
  - 工具参数由 `scripts/generate-agent-task-schemas.ts` 生成，`AGENT_TASK_TOOL_SCHEMAS` 与测试 guard 一致。
- 新业务模块 `packages/business/src/format5-mio-sequence.ts`：
  - `previewMioSequenceAction`：服务器把动作展开成 board/timeline/subject intent，生成 split rightClipId、copy move 的 copyNodeId、subject bindingId，调用统一预览得到 envelope + planDigest；返回有界的 affected 计数/目标/警告数。
  - `commitMioSequenceAction`：只用预览返回的 envelope 和 digest 提交；模型从不持有可编辑 envelope。
  - `set-mode` 未给 versionId 时，follow 取画板选中版本、locked 取当前应用版本；`reorder`/`remove`/`split`/`copy-move` 直接构造 TS 命令；`board` 动作走 B 的 board planner；`subject-binding` 走统一 subject 事务。
  - 预览/提交失败保留领域错误码；Mio 无法用裸 `timeline.*`/`canvas.apply`/`shot.update` 等旧入口（#305 已标不可用）。
- Mio 工具：`mioon_sequence_edit`、`mioon_sequence_undo` 加入格式 5 core；`sequence.tool.edit` 是 `local_reversible`，复制/删除/切开/插入/主体绑定强制进入现行审批；工具结果只返回动作、状态、精确 affected 计数、history 位置和预览计数，不返回 envelope。
- 补偿：统一 history 写前仍校验单笔 4 MiB / 项目预算，超限在提交前拒绝，不会记录半个逆操作。

## D5 Mio 撤销和 origin

- 统一预览请求/ envelope 增加可选 `origin: 'user' | 'mio'`；Mio 写工具固定 `mio`，UI/普通请求不传，保持原字节。
- history-13 的 `origin` 从 `user` 放开为 `user|mio`；写入口用 `envelope.origin ?? 'user'`。B 的 history 视图只对 Mio 动作附加 `origin:'mio'`，用户动作形状不变。
- Mio 撤销按 D5 找自己的 `actionId`，要求该动作仍在历史栈顶且 origin=mio，再走同一逆补丁验证和事务；游标变化返回 `SEQUENCE_EDIT_HISTORY_CONFLICT`，已撤回的旧请求不能重复补偿。
- 仍未做：用户 Ctrl+Z 跳过非栈顶 Mio 动作的独立 Mio 栈（当前共享一条 history 栈，只做到 origin 区分和 Mio 按 actionId 撤销）；留给 UI-E2/协调人确认是否要独立游标。

## 检查

- `tests/format5-mio-write.test.ts` 4/4：服务器生成 envelope 且 origin=mio；Mio 撤销自己的动作；拒绝 user 动作；split 服务器分配右侧片段；严格输入边界；格式 5 目录才出现两个写工具。
- typecheck、五个守卫、旧格式 3/4 两套 99 条指纹、`mio-runtime-fingerprints` 重建、schema manifest / generated tool schemas、合同/格式5写栅栏、B/C/TSb、parity/寻址/检查/help 测试待回填 CI。
- 旧格式指纹没有更新；本 PR 没有新增格式 5 三协议 99 条指纹套件。

## 遗留

1. **格式 5 三协议 99 条指纹新套件**：需要把 fingerprint helper 扩到 format5、给 16 个场景写格式 5 脚本/夹具、生成并逐条审阅；本 PR 未完成，需单独追加到本卡或新卡。
2. 片段属性（C FR-A #306 的 `propertiesIntent`）等 #306 合入后再开放 Mio 工具；本次未接。
3. 用户 Ctrl+Z 跳过 Mio 动作的独立游标/栈（D5 完整形态）未做；当前是同一 history + origin 标记 + Mio 按 actionId 撤销（仅栈顶）。
