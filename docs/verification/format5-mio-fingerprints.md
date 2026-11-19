# 格式 5 Mio 请求指纹（MT-3）

本 PR 新建格式 5 的 Mio 请求指纹套件：同样 16 个场景、三协议，共 99 条。格式 3、格式 4 两套 99 条逐字节不变。

## 生成方式

- `FINGERPRINT_FORMATS` 增加 `format5`，夹具 `agent-task-format5-request-fingerprints-v2.json`。
- 格式 5 项目用真实格式 5 内核创建并种一份固定、完整的主轨：root 节点、shot、version、一个主轨 clip、sequence_sync_state baseline；不复制格式 3/4 的假数据。
- `--update format5` 走指定授权生成器；旧格式路径和夹具不动。生成后逐条记入 `mt3-fingerprint-differences.md`（协议/场景/序号/字节数/SHA-256/来源），本 PR 描述附全表。
- 格式 5 场景仍使用真实 runtime、真实工具、真实 services，只冻结 `Date`；没有 mock 模型或提前重置请求字节。

## 格式 5 场景差异

- `read_edit_roundtrip` / `official_read_edit_roundtrip`：project.inspect → sequence.inspect → `mioon_sequence_edit` set-mode（服务器 preview→commit）→ 完成，4 条请求。
- `conflict_reread`：Mio remove 进入审批，用户用真实用户的 `clip-properties` 改动同一 clip；审批返回 `TARGET_CHANGED` 后重读并 set-mode，4 条请求。
- `tool_failure_retry`：无效 split 参数得到 `VALIDATION_ERROR`，重试 set-mode，4 条请求。
- `diagnostic_catalog`：只暴露并验证 `mioon_sequence_edit` 的 schema，不执行写。
- 其余单轮/note/unknown/trim/attachment/诊断场景与旧格式共用结构；格式 5 工具目录和上下文/装配仍由真实 runtime 冻结。

## 额外修复（生成过程中暴露）

- `prepare` 先做工具名到 operation 的归一化，再进 Mio sequence 分支；否则 `mioon_sequence_edit` 会走通用路径失败。
- 格式 5 目录不再混入格式 4 的 canvas 工具；格式 5 诊断目录加入 `mioon_sequence_edit`/`mioon_sequence_undo`/`sequence.inspect`。
- 模型可见的序列编辑结果不再包含随机 `actionId`（动作 ID 仍写真实 receipt），否则请求字节不可复现；`sequence.tool.undo` 的 actionId 改为可选，省略时服务器取栈顶 Mio 动作。
- 生成器给 `sequence.tool.edit` 的 JSON schema 加 object 根，满足三协议 wire schema（尤其 Anthropic）要求。

## 检查

- 旧格式 3/4 两套 fixture 逐字节未改；`tests/agent-task-request-fingerprints-v2.test.ts` 9/9（三格式）。
- `tests/mio-runtime-fingerprints.test.ts` 3/3：三格式 `mio_entries` 重建请求后逐字节一致，清理/重开后仍一致；格式 5 99 条也通过。
- 诊断固定 6 条旧样本未变；格式 5 新诊断请求单独纳入新套件。
- typecheck、五指守卫、schema/生成器 --check、格式5写/读/属性、合同/写栅栏等测试待回填 CI。
