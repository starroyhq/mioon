# 旧工作区设置兼容

生成服务各自配置和启用；常规页不再提供总开关。旧偏好中的 `liveGeneration` 在读取时忽略，包括曾保存为 `false` 的情形。付费确认和任务的原请求核对规则不变。各家服务的保存、密钥和旧版本处理见[生成服务](GENERATION-SERVICES.md)。

为兼容旧客户端，`workspace.settings.get` 和按 `expectedRevision` 写入的 `workspace.settings.set` 保留原来的传输字段，其中返回的 `liveGeneration` 固定为 `true`，提交的布尔值不影响生成。修订检查和应用库事务照旧，不接受路径、密钥或备份字段。

读取旧设置文档时，忽略 `liveGeneration` 的值以及旧备份字段 `automaticBackup`、`backupIntervalHours`、`backupLocation`、`backupDirectory`、`selectedDirectory`。其他未知键仍报 `WORKSPACE_SETTINGS_INVALID`。写入保存格式版本、修订和固定的 `liveGeneration: true`，让 0.1.2 仍能读取。

旧工作区备份面板、原生目录选择器、离线备份 CLI 和整个工作区恢复分支已退役。五个 `workspace.backup.*` 操作和 `workspace.restore.inspect` 均为 404 `UNKNOWN_OPERATION`；旧 `/api/workspace-backups/…` 为 404 `NOT_FOUND`。CLI 退出 2，MCP 返回 `isError:true`，发现列表不再列出这些入口。

当前自动备份以单个项目为单位，存于 `<dataDir>/records/<项目ID>/backups/`，不读取上述退役偏好。`project.backup.*` 的列表、检查、状态和恢复成新文件契约见 [项目备份](PROJECT-BACKUPS.md)。当前没有对应备份设置面板。
