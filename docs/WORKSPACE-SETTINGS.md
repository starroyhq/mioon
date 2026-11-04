# 工作区真实生成开关

这些设置属于本机应用，与当前打开的项目无关。界面、HTTP、CLI 和官方 MCP 共享同一严格契约。

在“设置 → 生成服务”切换“真实生成”，更改立即保存。开关关闭时，已配置服务也不能接受新的真实生成；实际外发前仍会再次检查。开关不配置密钥，也不代替图像逐次付费确认、Mio 的目标与范围授权。关闭它不能撤回已发出的请求，未知结果仍须核对原请求。各家服务的保存、密钥和旧版本处理见[生成服务](GENERATION-SERVICES.md)。

`workspace.settings.get` 只返回 `formatVersion`、`revision`、`liveGeneration`。`workspace.settings.set` 按 `expectedRevision` 保存 `liveGeneration`，保留修订冲突、订阅通知和应用库真实事务；不接受路径、密钥或备份字段。

读取旧设置文档时，仅放过并丢弃 `automaticBackup`、`backupIntervalHours`、`backupLocation`、`backupDirectory`、`selectedDirectory` 五个退役键名，不解释其值。其它未知键仍报 `WORKSPACE_SETTINGS_INVALID`。下次保存只写现行字段。

旧工作区备份面板、原生目录选择器、离线备份 CLI 和整个工作区恢复分支已退役。五个 `workspace.backup.*` 操作和 `workspace.restore.inspect` 均为 404 `UNKNOWN_OPERATION`；旧 `/api/workspace-backups/…` 为 404 `NOT_FOUND`。CLI 退出 2，MCP 返回 `isError:true`，发现列表不再列出这些入口。

当前自动备份以单个项目为单位，存于 `<dataDir>/records/<项目ID>/backups/`，不读取上述退役偏好。`project.backup.*` 的列表、检查、状态和恢复成新文件契约见 [项目备份](PROJECT-BACKUPS.md)。当前没有对应备份设置面板。
