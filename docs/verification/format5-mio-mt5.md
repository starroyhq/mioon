# 格式 5 Mio 动作补齐（MT-5）

MT-5 把 #322 之后仍然只有界面入口的格式 5 写动作补进 `mioon_sequence_edit`，并把画板属性栏的只读生成输入投影开放成有界只读工具。所有写动作仍经服务器预览 → 审批 → 提交，模型只给一个动作和已检查目标，不给 envelope、分配 ID 或回执。

## `mioon_sequence_edit` 新增动作

- `reference-reorder`：把一个镜头的全部素材引用线按给定顺序排好（第一条参考图是主图）。`edgeIds` 必须正好是当前全部素材引用线（最多 48 条、不重复），列表过期/缺项直接拒绝；审批级别与引用线连接/改角色/断开相同。
- `subject-card-create`：建一张主体卡。节点 ID 由服务器分配；`position` 可选，省略时放在画板右侧空位（所有现存活节点/镜头最右 x + 340，y = 120，限制在合同坐标范围内）。
- `subject-card-delete`：删一张主体卡（现有绑定写墓碑、引用边移除；主体库不动），与 SB-b 界面同一服务端语义。
- `previs-create`：建预演节点。节点 ID 和默认场景由服务器生成；`label` 必填、`position` 可选（缺省同上的空位规则）。
- `previs-scene-set`：保存整场预演（场景最多 16 KiB，人偶/道具可带主体引用），`expectedSceneRevision` 来自 `previs.inspect`，过期返回 `SEQUENCE_EDIT_REVISION_CONFLICT`。

这些动作和原有动作共用同一条 history-13 撤销栈；写请求 `origin: 'mio'`，Mio 用 `mioon_sequence_undo` 按 actionId 撤销自己的栈顶动作。建卡/删卡/预演新建和引用线排序进入现行审批；预演保存和原有可撤销档一样不额外强制审批。

## 新只读工具

- `mioon_sequence_generation_inputs_get`（格式 5 core）：对应公共只读操作 `sequence.generation-inputs.get`，查看一个镜头在实际生成服务下的模式、每条引用线的角色/来源/顺序/主体版本、不支持原因、主图和用到几项；输出上界 64 条。`connectionId`/`configurationRevision`/`modelEntryId` 三个一起给，省略表示还没选服务。
- 从 `MIO_DEFERRED_OPERATIONS` 移除 `sequence.generation-inputs.get`；同时清掉两个已开放工具留下的过期条目（`sequence.inspect`、`sequence.board.get`），`agent-task-operation-parity-v2` 的目录改为合并原生/格式 4 与格式 5 两套工具再审计。

## 不可用清单和说明

- `previs.create` / `previs.scene.set` 的格式 5 不可用原因改为指向 `mioon_sequence_edit` 的 `previs-create` / `previs-scene-set`；`reference.attach` 的原因补上 `reference-reorder`。
- `mioon_sequence_edit` 的工具说明列出新增动作。

## 指纹

- 格式 5 套件按 `common.md` 的授权重生成一次：99 条中 96 条变化、3 条不变（`diagnostic_text` × 3 协议，纯文本请求不带工具目录）。
- 变化来源：core 工具目录新增只读工具，`mioon_sequence_edit` 参数新增五个动作。逐条旧/新字节、SHA-256 在卡笔记目录的 `mt5-fingerprint-differences.md`。
- 格式 3、格式 4 两套夹具未重新生成，由 `tests/agent-task-request-fingerprints-v2.test.ts` 逐字节门禁。
