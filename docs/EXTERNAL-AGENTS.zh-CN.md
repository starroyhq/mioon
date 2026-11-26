# 让 Claude Code、Codex 操作 Mioon

本指南适用于提供「外部 Agent」设置页的 macOS 桌面版。Claude Code 和 Codex 可以读取和修改你在 Mioon 打开的项目，包括格式 5 项目的画板和时间线，也可以导入素材、提交生成和导出 MP4。命令行和 MCP 随 Mioon 提供，无需下载源码或另装 Node.js、pnpm。

## 安装命令行工具和技能

1. 打开 Mioon，进入「设置 → 外部 Agent」，在「命令行工具」点「安装」。正式渠道默认装到 `~/.local/bin/mioon`，开发渠道使用 `mioon-dev`。安装后可以复制命令的绝对路径。
2. 在「Agent 技能」找到你使用的客户端，点对应的「安装」。正式渠道会装到 `~/.claude/skills/mioon` 或 `~/.codex/skills/mioon`。开发渠道的技能目录名也是 `mioon-dev`。
3. 重新打开 Agent 会话。操作项目时保持 Mioon 运行。

技能会使用安装时写入的绝对命令路径。若想在终端里直接输入 `mioon`，可以点开「不在 PATH 里」，按页面提示把那一行加到对应的 shell 配置文件，再开一个终端。

## 注册 MCP

已安装命令行工具时，可以在「MCP」区复制 Claude Code 或 Codex 对应的命令，并在终端执行。页面上的命令已填好你所安装的启动器路径。下面是正式渠道的命令格式。

```sh
claude mcp add -s user mioon -- "/path/to/mioon" mcp
codex mcp add mioon -- "/path/to/mioon" mcp
```

开发渠道的注册名和启动器都是 `mioon-dev`。执行对应命令后，重新打开 Agent 会话。注册由你在终端完成。用 MCP 时，Agent 可以直接查看工具及参数，也可以使用技能调用命令行。

## 在测试项目试一次

保持 Mioon 运行并打开一个格式 5 测试项目，再把下面这条指令发给 Agent。

> 用 Mioon 技能读这个测试项目的时间线。找一个普通片段，告诉我它现在的名称。等我确认后给它改名，核对结果，然后撤销这一步。

Agent 可以用 `doctor` 或 `mioon_doctor` 检查连接。格式 5 的常用操作如下。 [序列编辑参考](../skills/mioon/references/sequence.md)

| 操作 | 命令行 | MCP |
| --- | --- | --- |
| 查看时间线或画板 | `sequence inspect`、`sequence board get` | `sequence_inspect`、`sequence_board_get` |
| 预览片段修改 | `sequence clip edit` | `sequence_clip_edit` |
| 提交预览中的修改 | `sequence action commit` | `sequence_action_commit` |
| 查看编辑历史 | `sequence history get` | `sequence_history_get` |
| 撤销或重做 | `sequence undo`、`sequence redo` | `sequence_undo`、`sequence_redo` |

预览返回动作摘要、`envelope` 和 `planDigest`。确认后提交时，原样传入 `envelope`，并把 `planDigest` 作为 `expectedPlanDigest`。提交后的序列编辑进入用户历史，也可在 Mioon 剪辑页撤销或重做。

## 恢复连接、更新或卸载

- Mioon 未运行时，先打开 Mioon。应用退出或重启后，重新打开 Agent 会话以恢复 MCP 连接。
- 命令报 `CLI_VERSION_MISMATCH` 或设置显示「需要修复」时，在「命令行工具」点「修复」。安装失败时，可按页面上的原因选择「重试」或「换个位置…」。
- 如果换了命令安装位置，移除 Agent 客户端里的旧 MCP 注册，再执行设置页复制的新命令。
- Mioon 更新时会同步更新未修改过的技能。如果页面显示技能「有更新」，点对应的「更新」。有本地修改时，先确认是否覆盖。
- 用「外部 Agent」页的「卸载」移除命令行工具或对应技能。MCP 注册在 Agent 客户端里移除。

## 权限和生成费用

外部 Agent 通过命令行或 MCP 调用项目操作。操作前的权限提示由 Agent 客户端决定，内置 Mio 有自己的审批规则。 [Mio 使用说明](MIO-GUIDE.zh-CN.md)

- **付费视频生成。** Agent 提交前应向你确认服务商、模型、提示词和参考素材、生成次数及费用上限。Mioon 会把外部 Agent 的提交直接交给已启用的服务，你可以在服务商侧设置用量上限或提醒。提交结果未知时，先查询原请求。
- **在线图片生成。** Agent 可以准备请求，由你在 Mioon 界面确认生成。
