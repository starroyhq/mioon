# 让 Claude Code、Codex 操作 Mioon

仓库里的 [`skills/mioon`](../skills/mioon/SKILL.md) 是给外部 Agent 用的技能。装好技能、连上正在运行的 Mioon 以后，Claude Code、Codex 等 Agent 可以和你在界面里操作同一个项目：导入素材、管理镜头和版本、提交生成并取回结果、修改时间线上的具体片段、导出 MP4。修改直接写进项目，界面里能看到。

外部 Agent 和界面里的 Mio 是两回事。它不经过 Mio 的放行档位，而是通过命令行或 MCP 直接调用和界面相同的操作；每次调用前是否先问你，由 Agent 客户端自己的权限设置决定。Mio 的用法见 [Mio 使用说明](MIO-GUIDE.zh-CN.md)。

**关于费用：**

- 技能要求 Agent 在提交在线视频生成前，先向你确认服务商和模型、提示词和参考素材、生成次数和费用上限。这是写给 Agent 的规则：视频服务启用并配好密钥后，Mioon 不会对外部 Agent 的提交再弹出确认。
- 在线图片生成必须由你在 Mioon 界面里确认，外部 Agent 只能准备待确认的请求。
- Mioon 不设生成次数或金额上限，请在服务商那边设好用量上限或提醒。

## 1. 准备

- **Mioon 正在运行**：桌面版，或按[源码试用指南](CORE-TRIAL.zh-CN.md)启动的本机服务。Agent 连接的是这个正在运行的 Mioon，不要为它再启动一份。
- **一份 Mioon 源码**：命令行工具和 MCP 服务从源码运行，桌面安装包里不带。需要 Node.js 24 或更新版本，以及 pnpm 11.25.0：

  ```sh
  git clone https://github.com/starroyhq/mioon.git
  cd mioon
  pnpm install --frozen-lockfile
  ```

  源码最好和正在运行的 Mioon 是同一个版本，版本不一致时有些操作可能用不了。从源码启动服务时，直接用同一份源码。

下文用 `MIOON_REPO` 表示源码目录，先在终端里设好，例如：

```sh
MIOON_REPO="$HOME/mioon"
```

## 2. 安装技能

两种方式选一种。

### 方式一：链接到源码（推荐）

技能跟着源码一起更新，和命令行工具始终是同一个版本。

```sh
# Claude Code
mkdir -p ~/.claude/skills
ln -s "$MIOON_REPO/skills/mioon" ~/.claude/skills/mioon

# Codex
mkdir -p ~/.agents/skills
ln -s "$MIOON_REPO/skills/mioon" ~/.agents/skills/mioon
```

Claude Code 从 `~/.claude/skills/` 读取个人技能，Codex 从 `~/.agents/skills/` 读取用户技能，两者都支持链接过去的技能目录，见 [Claude Code 技能说明](https://code.claude.com/docs/en/skills)和 [Codex 技能说明](https://developers.openai.com/codex/skills)。

### 方式二：用 `npx skills` 安装

[skills](https://github.com/vercel-labs/skills) 是 Vercel Labs 的开源技能安装工具，需要 Node.js 22.20 或更新版本。下面的命令从 GitHub 下载 main 分支上的技能：

```sh
npx skills add starroyhq/mioon --skill mioon -g -a claude-code -a codex
```

- 技能装在 `~/.agents/skills/mioon`，`~/.claude/skills/mioon` 是指向它的链接。去掉 `-g` 时只装到当前目录下的 `.agents/skills/` 和 `.claude/skills/`。
- 更新用 `npx skills update mioon -g`。
- 你的源码不在 main 上时，改从本地源码安装，保证版本一致：`npx skills add "$MIOON_REPO" --skill mioon -g -a claude-code -a codex`。
- 这个工具默认收集匿名使用数据，设置环境变量 `DISABLE_TELEMETRY=1` 可以关闭，见它的[说明](https://github.com/vercel-labs/skills#telemetry)。

装好后重新打开 Agent。Claude Code 和 Codex 里都可以输入 `/skills` 查看已装的技能。

## 3. 连接 Mioon

推荐用 MCP：Agent 客户端直接列出 Mioon 的工具和参数。也可以只用命令行。

### 找到连接文件

桌面版运行时，会在应用数据目录里写一个连接文件 `mcp-connection.json`，正常退出时删除。正式版在 macOS 上的位置是：

```text
~/Library/Application Support/app.starroy.mioon/mcp-connection.json
```

- 开发版（包括从源码构建的桌面版）把 `app.starroy.mioon` 换成 `app.starroy.mioon.dev`。
- Linux 上在 `~/.config/` 下的同名目录。
- 这个文件和旁边的 `mcp-token` 用来连接你的 Mioon，不要发给别人，也不要贴进对话。

### Claude Code

```sh
claude mcp add -s user mioon \
  -e MIOON_CONNECTION_FILE="$HOME/Library/Application Support/app.starroy.mioon/mcp-connection.json" \
  -- node "$MIOON_REPO/apps/mcp/src/index.ts"
```

`-s user` 让所有项目都能用；不加时只在当前目录可用。`claude mcp list` 可以查看连接状态。项目级的 `.mcp.json` 写法见 [MCP 说明](MCP.md#standalone-claude-code-configuration)。

### Codex

```sh
codex mcp add mioon \
  --env MIOON_CONNECTION_FILE="$HOME/Library/Application Support/app.starroy.mioon/mcp-connection.json" \
  -- node "$MIOON_REPO/apps/mcp/src/index.ts"
```

配置写进 `~/.codex/config.toml`。只在某个项目里用的写法见 [MCP 说明](MCP.md#standalone-codex-configuration)。

两条命令里的 `node` 都要是 24 或更新版本。用 nvm 等工具切换过 Node 版本时，可以把 `node` 换成 `"$(command -v node)"`，写入当前 Node 的完整路径。

### 只用命令行

Agent 能运行终端命令时，也可以不配 MCP。在启动 Agent 的终端里先设好连接文件，再让 Agent 在源码目录里运行命令行，例如：

```sh
export MIOON_CONNECTION_FILE="$HOME/Library/Application Support/app.starroy.mioon/mcp-connection.json"
cd "$MIOON_REPO"
node apps/cli/src/index.ts doctor
```

技能里写明了 Agent 该怎么用命令行，见[连接说明](../skills/mioon/references/connection.md)。如果 Agent 的沙箱不允许命令访问本机网络，命令行会连不上，请改用 MCP。

### 连接从源码启动的服务

不用桌面版时，把 `MIOON_CONNECTION_FILE` 换成两个变量：`MIOON_BASE_URL`（服务地址，例如 `http://127.0.0.1:4318`）和 `MIOON_TOKEN_FILE`（服务数据目录里的 `access-token`）。详见 [MCP 说明](MCP.md#connection-modes)。

## 4. 试一下

确认 Mioon 正在运行，重新打开 Agent，然后说：

> 用 mioon 技能检查和 Mioon 的连接，列出我的项目。

Agent 应该先运行 `doctor`（MCP 工具名 `mioon_doctor`），再列出项目。Mioon 没有运行或连接文件不对时，`doctor` 会说明原因。

想先不花钱走一遍完整流程，可以让 Agent 用模拟服务（Mock）生成并导出，见[模拟流程](../skills/mioon/references/mock-workflow.md)。模拟服务生成的是带标记的测试画面，不是按提示词生成的内容；它需要 FFmpeg 带 `drawtext` 滤镜，见[安装与首次运行](INSTALL.zh-CN.md)。

## 5. 注意

- **同一个项目，一份服务**：外部 Agent、Mio 和你改的是同一份项目，一个数据目录只能有一个 Mioon 在运行。Agent 修改时会带上版本号；项目在别处被改过时，这次修改会被拒绝，Agent 需要重新读取再改。
- **授权**：把技能装进 Agent、配好 MCP，都不等于同意 Agent 花钱或改动所有内容。需要它做什么，在对话里说清楚范围。
- **卸载**：删除 `~/.claude/skills/mioon` 和 `~/.agents/skills/mioon`（用 `npx skills` 安装的可以运行 `npx skills remove mioon -g`），再用 `claude mcp remove mioon -s user` 或 `codex mcp remove mioon` 删除 MCP 配置。
