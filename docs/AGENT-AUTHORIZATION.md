# Mio 发送授权

Mio 按“规范化后的完整目标地址 + 模型 + 发送范围类别”在本机工作区保存授权。首次发送显示目标、模型、范围与可能计费的说明，确认后相同单位后续发送免于再次确认。项目、选中对象、消息内容、会话版本及重启不会清除该单位的授权；每次发送仍校验当前对象、设置版本和会话版本。改变目标、模型或范围需要另一条授权。

范围固定为 `project_agent`、`typed_chat_only`、`project_inspection`、`selected_shot_edit`、`selected_timeline_clip_move`、`selected_timeline_clip_gain`。当前 Mio 使用 `project_agent`，仅针对当前项目，执行仍受独立的操作确认与步数上限约束；旧聊天和局部修改授权不能替代它。其余范围用于旧会话与提议，移动与音量提议各自授权，原有应用前审阅保持不变。

设置中心的 Mio 页列出已授权目标并支持逐条撤销；页上的“测试连接”遇到尚未授权的目标，同样先显示首次发送授权，确认只授予所审阅的目标、模型与 `project_agent` 范围。撤销保存成功后，阻止尚未开始的本地工具读取、修改及尚未发送的模型调用，包括多步流程的下一次调用；已完成的读取、已送达供应商的请求、计算或费用无法撤回。发送前须核对实际目标、模型与范围，界面显示或折叠这些信息都不能替代发送校验。

## HTTP、CLI 与 MCP

三个公共操作统一使用 `/api/rpc` 与共享契约；CLI 命令为 `agent authorization list/grant/revoke`，MCP 工具名为 `agent_authorization_list/grant/revoke`。

- `agent.authorization.list {}` 返回授权 `revision`、安全的 `currentTarget`（`destination`、`model`、`settingsRevision`）及已授权列表。
- `agent.authorization.grant` 接受 `requestId`、`expectedRevision`、`expectedSettingsRevision`、`destination`、`model`、`scope`，只能批准当前设置中的目标与模型。目标使用完整 endpoint，包括协议对应的 `/chat/completions` 或 `/responses` 路径。
- `agent.authorization.revoke` 接受 `requestId`、`expectedRevision`、`authorizationId`。修改操作返回原操作回执；相同请求 ID 重放不重新批准已撤销的授权。请重新 list 查询当前状态。

公共批准和撤销是明确的本机授权管理操作，不会发送消息或调用供应商。Mio 的模型工具目录保持封闭，不包含这些操作，模型无法给自己授权。CLI/MCP 调用方应在获得用户明确授权后管理权限。

## 本机持久化与错误

`agent-authorizations-v1.json` 通过既有私有存储边界原子保存，并绑定数据目录、数据库身份及应用渠道。文件仅包含目标元数据、授权时间与幂等回执，不包含密钥或消息。它独立于项目记录及数据库 schema，不进入现有离线备份；恢复工作区不继承授权。

文件缺失表示没有授权；损坏、符号链接、工作区身份改变或锁所有权丢失均拒绝授权与发送，保留原文件。授权列表最多 256 条，保留回执最多 2048 条，文件最多 1 MiB；这些是本机授权元数据的存储边界，不是生成次数上限。达到容量时拒绝新修改并保留原记录，不静默丢弃历史。

后端在接受新一轮、每次模型提交前和实际工具执行前检查授权。首轮响应完成、工具 intent 保存并发布后均重新校验；独立的工具 dispatch-started 标记提交后，在同步读取或执行修改前再校验，覆盖中途撤销。v2 授权拒绝使用 `AGENT_TASK_CONSENT_REQUIRED`，旧会话使用 `AGENT_CHAT_CONSENT_REQUIRED`；未知工具结果仍不重试。未知发送结果仍只查询原始 requestId，不自动重新提交；重启只恢复既有记录显示，不续发模型请求。旧的单次 consent 内容仍作为每轮对象与范围的证据保留，但它本身不能替代持久授权。
