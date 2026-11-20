# 格式 5 Mio 工具请求体积（MT-6 第二步）

MT-6 按 C+A 把格式 5 单轮 Mio 请求从格式 4 的 225.6% 降到 110% 以内。目标按同一场景、同一协议、同一序号比较：格式 5 每个冻结场景请求 ≤ 格式 4 的 ×110%。

## 一、格式 5 目录不再列不可用旧工具（A）

`FORMAT5_UNAVAILABLE_OPERATIONS` 表保留（用于 parity、发现和文档），但格式 5 的工具目录和 `mioon_tools_load` 名字枚举都不再包含这 35 个会被门禁拒绝的旧工具。每个会话请求因此少 946 字节（`mioon_tools_load` 枚举缩短）且模型不会误加载不可用工具。

## 二、格式 5 专用紧凑 `_mio_step`（B）

同一个 315 字节的 `_mio_step` 说明原先被复制到每个工具/对象分支（格式 5 单请求 51 处 = 16,065 字节）。现在只改格式 5 的请求构建：`_mio_step` 字段仍保留 `type/minLength/maxLength`，但不再重复长说明；说明文字仍在系统指令里。格式 3/4 的请求构建不传该选项，两套夹具逐字节不变，并有测试锁住。

- 构建入口：`buildTaskModelRequest` / `taskModelHistoryBudget` 的 `format5` 选项。
- 运行时按项目格式自动传：`isFormat5Project(store)`。

## 三、动作按领域拆到按需加载工具（C）

`mioon_sequence_edit` 核心只保留 9 个基础动作：

- 连线：`connect` / `disconnect`
- 节点：`insert` / `delete-node`
- 成片内剪辑：`reorder` / `remove` / `split` / `set-mode` / `copy-move`

其余 23 个动作按领域拆成 6 个按需加载工具（仍走同一服务器展开、审批和 Mio 撤销）：

| 工具 | 操作 | 动作 |
| --- | --- | --- |
| `mioon_sequence_board_edit` | `sequence.tool.board` | 画板根/镜头创建、画布节点创建与更新、布局移动、归档恢复、复制 |
| `mioon_sequence_reference_edit` | `sequence.tool.reference` | 素材引用线连接/改角色/断开/排序（第一条参考图是主图） |
| `mioon_sequence_subject_edit` | `sequence.tool.subject` | 主体绑定三态、主体卡建卡/删卡 |
| `mioon_sequence_previs_edit` | `sequence.tool.previs` | 预演节点新建、预演场景保存（人偶/道具可带主体） |
| `mioon_sequence_timeline_edit` | `sequence.tool.timeline` | 画幅切换、按场景切开、字幕增改删、台词增改删、轨道增改 |
| `mioon_sequence_clip_edit` | `sequence.tool.clip` | 片段属性（变换/转场/增益/淡入淡出/颜色/音频角色/音量包络/名称） |

台词（`dialogue`）放在时间线组：台词和字幕同属一段文字内容，共用时间线组不需要第 7 个组名。生成输入只读工具的上限由服务端三个实际上限算出：一镜头 48 条引用线 + 8 个主体绑定 + 32 个预演主体 = 88 条（`FORMAT5_INPUT_LIMITS`，`SEQUENCE_GENERATION_INPUT_LIMITS.entries` 与工具说明同源）。

Mio 在修改前用 `mioon_tools_load` 按名字加载相应组，加载后的下一次回复即可调用；审批级别、`origin: mio` 和 D5 撤销与原来一致。`mioon_tools_load` 的格式 5 说明列出每组的一句话用途。`mioon_sequence_undo` 和三个只读格式 5 工具（`sequence.inspect`、`sequence.board.get`、`sequence.generation-inputs.get`）仍是 core。

每个动作在且仅在一个工具里；`tests/format5-mio-tools.test.ts` 逐条核对 32 个动作的分组、组工具只在格式 5 目录、加载名字与不可用清单不冲突；`tests/format5-mio-write.test.ts` 覆盖“加载组 → 审批 → 提交 → Mio 撤销”。

## 四、指纹和体积结果

- 格式 5 套件按授权重生成一次：99 条中 96 条变化，`diagnostic_text` 的 3 条不变（纯文本请求不带工具目录）。逐条旧/新字节、SHA-256、格式 4 对照和达标情况见卡笔记目录 `mt6-fingerprint-differences.md`。
- `single_reply/chat_completions`：**59,518 → 24,476 字节**（格式 4 同场景 25,148；新值/格式 4 = 0.97，目标 1.10）。全部 99 条同场景比较的最大比值为 1.00，无一条超过 110%。
- `diagnostic_catalog` 场景的代表工具改为 `mioon_sequence_undo`：核心 sequence 工具现在覆盖多域，用单动作有界写工具更符合“诊断目录只暴露一个工具”的原意，并让该场景从 31,778 降到 1,463 字节（格式 4 同场景 2,980）。

## 五、兼容性

- 格式 3/4 两套指纹夹具未重新生成，逐字节不变；紧凑说明和分组工具只在格式 5 目录/请求构建中生效。
- 三格式 `mio_runtime_fingerprints` 重建一致。
- 生成了新的工具 schema（`AGENT_TASK_TOOL_SCHEMAS` 增加 6 个组操作），`node scripts/generate-agent-task-schemas.ts --check` 一致。
