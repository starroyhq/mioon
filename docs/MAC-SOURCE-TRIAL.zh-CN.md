# Mioon Mac 源码试用指南

这份说明用于在自己的 Mac 上，从源码启动 Mioon 开发版，试用导入素材、画板、时间线和本地 MP4 导出。首次试用只用新建项目和模拟供应商，不需要 API 密钥。

当前状态：2026-10-10 按源码基线 `9e9598d887b21b8e1b7dc742e5d15c66a3ff93d4` 重新核对说明；初稿的 `7b85186` 仅为历史说明基线。此次核对没有执行 Mac 安装、构建或原生验收。应用源码版本为 `0.4.1`，依赖固定为 Electron `44.7.0`。这些版本信息不是 Mac 运行结果。实际试用必须记录所用源码快照；本文不提供已验证的 Mac 安装包。

上述日期与基线保留为历史核对记录。当前核心试用及成片命名候选状态另见[核心试用一页指南](CORE-TRIAL.zh-CN.md)；Mac/Windows 原生验收仍暂停，旧源码交付不会自动更新到当前候选。下文导出步骤已按当前界面纠正，不代表补做了 Mac 验收。

## 开始前

- 使用最终确认的同一份源码快照。不要把 Linux 的 node_modules、Electron 可执行文件或 release 目录复制到 Mac。
- 在本机普通目录放置源码，例如用户目录下的 Projects/MioonTrial。首次试用避开外置盘、云同步目录、符号链接和 /tmp 路径，减少路径和权限差异。
- 使用 Node.js ≥24、固定的 pnpm 11.25.0，以及适合本机架构的 FFmpeg 和 ffprobe。已有符合要求的 Node（例如 26.x）不必降级到 24.x；通过版本要求不等于该组合已完成原生验收。Mioon 不会自动安装这些工具。
- 在“关于本机”查看芯片和 macOS 版本。Apple Silicon 使用原生 arm64 工具；Intel 使用 x64 工具。本次没有验证任何具体 macOS 版本或架构组合。
- 使用自己的普通 macOS 账户。遇到安全阻止或私有目录检查失败时先停止并保留错误，不调整系统安全设置来继续。

已有工具可以直接使用。缺少 Node 时使用 [Node.js 官方下载页](https://nodejs.org/en/download) 的 Node 24。pnpm 需要固定为 11.25.0，不能直接套用安装页的 latest 版本；安装方式可参照 [pnpm 官方安装说明](https://pnpm.io/installation)。

如果已经使用 Homebrew，可按 [Homebrew 的 FFmpeg 配方](https://formulae.brew.sh/formula/ffmpeg) 安装 FFmpeg。其他来源先从 [FFmpeg 官方下载页](https://ffmpeg.org/download.html) 核实；该页面说明 FFmpeg 项目本身提供源码，预编译工具由所列第三方提供。无论采用哪种构建，都要通过下面的版本和编码器检查。

## 一次性安装依赖

打开终端，进入源码根目录，也就是包含 package.json 和 pnpm-lock.yaml 的目录。以下每一步成功后再继续。

```sh
node --version
pnpm --version
```

Node 应为 ≥24，pnpm 应为 11.25.0。若已有 Node/npm，且决定通过 npm 安装指定 pnpm，可执行下面的命令；它会安装全局命令。遇到权限问题先检查自己的 Node 安装方式，不加 sudo 强行继续。

```sh
npm install --global pnpm@11.25.0
```

在源码根目录安装锁定依赖：

```sh
pnpm install --frozen-lockfile
```

这一步需要网络，会下载依赖以及适合当前系统和架构的 Electron 运行时。项目已明确允许 Electron 和 esbuild 的安装步骤。不要改锁文件、关闭校验或沿用 Linux 的依赖目录来处理下载失败。

## 选择本机视频工具

如果工具已加入终端 PATH，下面两条命令可以显示其位置：

```sh
command -v ffmpeg
command -v ffprobe
```

确认这些路径属于自己从可信来源安装的工具。未显示路径时，使用实际安装位置；不能把示例路径当成已存在的文件。

在同一个终端窗口里，把下面两处替换成自己确认的绝对路径。引号保留，因此路径可以含空格：

```sh
export MIOON_FFMPEG_PATH="/实际安装位置/ffmpeg"
export MIOON_FFPROBE_PATH="/实际安装位置/ffprobe"
export MIOON_ENABLE_LIVE_PROVIDER=0
```

核对工具输出：

```sh
"$MIOON_FFMPEG_PATH" -version
"$MIOON_FFPROBE_PATH" -version
"$MIOON_FFMPEG_PATH" -hide_banner -encoders
```

最后一条的编码器列表必须包含 libx264 和 aac。桌面启动时还会自行验证可执行文件、版本和这两个编码器。Electron 内部用于播放的 libffmpeg 不能代替这里的两个命令行工具。

本地模拟生成还会使用 FFmpeg 的 drawtext 滤镜及其字体依赖。准备试用模拟生成时，可检查滤镜列表：

```sh
"$MIOON_FFMPEG_PATH" -hide_banner -filters
```

确认有 drawtext；这不代替实际模拟生成和播放验收。doctor 和桌面启动的编码器检查不会验证该滤镜能否在本机正常绘字。

也可以不设置两个路径变量，在首次桌面启动时通过文件选择框分别选择 ffmpeg 和 ffprobe。工具路径检查通过后才会打开工作区。不要选择安装器、压缩包或所在文件夹。

## 构建并启动开发版

推荐先使用上面的路径变量完成 doctor 检查；doctor 不会弹出工具选择框。首次试用前先检查下节数据位置：若默认开发版目录已有项目、旧配置或凭据，选择一个从未使用的新试用目录，不要覆盖它。

在同一个终端、源码根目录依次运行：

```sh
node scripts/tooling.mjs doctor
node scripts/tooling.mjs test --suite=portable --concurrency=1
node scripts/tooling.mjs build --channel=development
MIOON_ENABLE_LIVE_PROVIDER=0 pnpm desktop
```

build 会依次构建网页和桌面代码；不要在前一步失败后继续。portable 仅运行明确列出的可移植测试，不等于完整测试或原生验收。`pnpm desktop` 只运行现有暂存产物，不会重新构建。桌面进程使用 Electron 自带的 Node 和 SQLite。首次进入桌面工作区会自动连接本机服务，不需要手动复制令牌。

doctor 检查 Node、构建身份、依赖包版本、内存 SQLite 和媒体工具版本；它不验证编码器、Electron 可执行文件能否启动、Mac 窗口、媒体导出、Keychain 或安装包。普通 doctor 通过可返回 0，同时 nativeReadiness 仍为未验证。若另行运行 `node scripts/tooling.mjs doctor --native-ready`，本地前提检查通过后 macOS 仍返回未验证状态和退出码 2；前提检查失败则返回 1。不能把此固定门槛当作实际 Mac 测试结果。

应用、CLI/MCP 实现元数据与暂存包版本均为 `0.4.1`；后端 `/health` 当前仍独立报告兼容版本 `0.4.0`，不能仅凭此数值判定运行了旧构建。MCP 协议日期和连接描述文件版本也是不同版本域。记录终端 Node 与 Electron utilityProcess 的实际版本时必须分开。

本文只指导源码构建与试用，不运行安装包、签名或公证流程。完整测试入口的 `--suite=full` 当前限 Linux；不能把 Linux 检查或 Mac 上的可移植检查写成 Mac 原生通过。

## 数据位置与旧项目保护

上面的构建明确选择 development；`pnpm desktop` 运行刚构建的渠道。未设置 MIOON_DESKTOP_USER_DATA 时，源码开发版预期使用：

```text
~/Library/Application Support/app.starroy.mioon.dev/
```

其中 workspace 保存项目和托管素材；实际 macOS 路径仍待原生确认。若终端已有 MIOON_DESKTOP_USER_DATA，它会覆盖上述默认位置；不要在不清楚其用途时沿用。需要隔离首次试用时，在启动前明确设置新的真实绝对路径，例如：

```sh
export MIOON_DESKTOP_USER_DATA="$HOME/Library/Application Support/app.starroy.mioon.dev-source-trial"
```

这是可选的独立开发版试用位置。先确认该目录从未使用；若已有数据，改用另一个新名字，不删除、合并或覆盖。后续重开时使用同一目录。已有工具路径变量也需在新终端重新设置。

第一次试用只新建项目，不搬入旧数据库。旧版 `~/Library/Application Support/video-workbench/workspace` 不会自动迁移，也不会因新建渠道目录而被删除。不要为找回旧项目复制令牌、Chromium 配置或凭据；未来确需迁移，先正常退出所有相关服务、备份整个旧 workspace（包含媒体），再按 [桌面数据迁移说明](DESKTOP.md#数据位置与单实例) 评估复制到尚不存在的目标，保留原目录。试用指南不要求执行迁移。

数据库中的项目、聊天、恢复请求与托管素材是普通本地 SQLite/文件，未经保险库加密；密钥库功能不等于这些文件已加密。旧数据根目录可能因所有者、权限或符号链接检查被拒绝。应用不会自动修权限、迁移、删令牌或覆盖数据；`/tmp`、`/var` 等 macOS 路径别名也可能被拒绝。遇到拒绝，保留目录和错误，参照 [私有存储与恢复边界](PRIVATE-STORAGE.md)，不移除检查或改系统安全设置。

关闭窗口和退出应用在 Mac 上是两件事：源码预期关闭最后一个窗口后服务仍运行，从 Dock 可重新打开；完全退出使用菜单“退出”或 Cmd+Q。这些行为仍需要本机确认。

## 先试这条最短流程

1. 新建一个试用项目，导入仓库自带的合成素材 `examples/timeline-synthetic/scene-a.png` 与 `examples/timeline-synthetic/scene-b.mp4`；后者带合成音频。先记录原文件 SHA-256，不使用用户真实素材。无需运行素材生成脚本，其 Linux 字体/Pillow 依赖不属于 Mac 首次试用前提。
2. 从素材的“加入时间线”入口进入剪辑，修改一个片段属性并保存。
3. 点“更新预览”，确认新画面。点“导出时间线”，在右侧“交付检查”的“本次导出”页核对可选的“本次成片名称”和导出设置，再明确点“检查本次设置”；打开页面不会自动检查。检查通过后点“确认导出”；改名称或设置后须重新检查，检查报告不代表导出完成。完成后在同一右栏的“导出记录”点“下载”，打开原生另存为，保存到自己选定的位置，再打开 MP4 检查播放。
4. 完全退出 Mioon，再按同一条启动命令打开，重新进入同一项目，检查素材、片段和已完成导出。
5. 想试生成流程时，创建镜头并只选带“本地模拟”标记的 `Mock · simulated motion`，使用“正常完成”场景。模拟 MP4 带有 SIMULATED MOCK 标记，它验证流程，不会根据提示词生成真实 AI 画面；模拟视频本身不带音频。

先使用无关紧要的试用素材。首次验收不要输入供应商、Agent 或 Images 密钥，不配置或调用 Agent 模型；官方/自定义 Images 与 ComfyUI 保持未启用，也不点击 ComfyUI 的连接检查（检查本身会发送 HTTP）。不要用重要项目测试中断或恢复。MIOON_ENABLE_LIVE_PROVIDER=0 是视频供应商的开关，不应把它当作所有模型联网调用的总开关。完整记录表见 [Mac 试用记录](MAC-TRIAL-CHECKLIST.zh-CN.md)。

## 任务中心与恢复的范围

顶部“任务”打开“任务中心”，分别显示“本地编辑请求”“当前会话的待确认请求”和“生成任务”。没有记录与加载失败不是一回事；恢复列表还在加载或报错时，相关编辑会被阻止。

- 21 类本地编辑请求可将原始请求编号和完整参数保存在当前 workspace：轨道新增/更新，片段新增/更新/替换来源/移除/波纹删除（`timeline.clip.rippleRemove`）/分割，从分镜导入时间线，撤销/重做，首帧连接/断开，以及主体创建/追加版本/设置镜头关联（`subject.create`、`subject.version.add`、`subject.binding.set`），以及 `timeline.format.set` 时间线输出规格与 `timeline.subtitle.add`、`timeline.subtitle.update`、`timeline.subtitle.remove` 手动字幕，以及 `timeline.loudness.apply` 完整固定倍率候选原子应用。它们并非整个应用所有操作的恢复保证；主体/风格关联当前仅用于本地规划，不会自动提交给供应商。
- 启动、打开任务中心、查看或转存旧会话请求都不会自动执行编辑。结果待确认时，先处理当前未保存草稿，再使用该记录的“恢复同一请求”或“核对同一请求”。恢复使用已保存的原参数与原编号，不使用当前草稿，不另造新请求。
- 其余 8 类画板/素材元数据编辑、时间线渲染及原有视频生成/导出提交的待确认请求参数仍依赖当前浏览器会话。生成、导出等领域已有的任务与完成记录继续独立保存；不能据此认为丢失的会话参数一定能恢复。Images/ComfyUI 另有专属审批、任务和结果恢复，不纳入这 21 类编辑账本，也不能用“重启重发”代替各自的恢复规则。
- 只有仍存在且参数完整、属于上述 21 类的旧会话请求可以明确转存。已丢失的旧会话不能从当前项目状态推测重建；不要通过清空浏览器数据、删数据库记录或反复提交来解决不确定结果。
- 该恢复账本初始最多保留 4,096 条任务身份，容量用尽会阻止新任务；长期归档/压缩策略尚未实现。它不是数据库或 WAL 文件总大小的上限。

首次试用只观察日常保存与重开；故障注入和同一请求恢复验收留给隔离的工程试用项目。更多边界见 [任务恢复契约](TASK-RECOVERY.md)。

## 常见问题

### 找不到 pnpm 或 Node 版本太旧

核对 node --version 和 pnpm --version，并确认终端使用的是刚安装的工具。重新打开终端后，视频工具路径变量需要重新设置。不要为这次试用修改项目要求或升级依赖版本。

### Electron 下载失败或可执行文件缺失

保存不含个人目录信息的错误摘要，核对网络能否访问依赖仓库和 Electron 官方下载。下载中断后可以重试同一条锁定安装命令。证书、安全软件或系统安全提示阻止时先停止，不绕过告警、不更换来源不明的二进制。

### FFmpeg 无法启动或缺少编码器

确认选的是实际可执行文件，且架构与本机一致。缺少 libx264 或 aac 时换用提供所需编码器的可信构建，并重新选择路径。若报动态库加载问题，记录错误并检查该 FFmpeg 构建的安装是否完整；Mioon 不会继承 DYLD_* 注入变量。

### 数据目录隐私检查失败

保留原目录和错误。应用不会自动修权限或覆盖原项目。先核实目录是否属于自己的账户、是否经过符号链接，再决定使用新的真实绝对路径。不要删除 desktop-identity.json 或权限检查来继续；如果要尝试新目录，需要保持开发版与正式版分开。

### 启动成功但生成不可用

本次只开放本地模拟流程，真实供应商保持关闭。填写真实密钥、选择付费服务或打开真实生成不属于这次无密钥试用。

### 已经导出却找不到文件

任务完成后的项目资产与另存为到 Finder 的文件是两个步骤。先打开“查看导出记录”，找到已完成结果并点“下载”，再完成另存为；不要重复提交同一个导出来找文件。取消另存为不会要求重新渲染。

## 桌面入口暂时不可用时的本机浏览器入口

若问题仅限 Electron 窗口或桌面集成，可以在同一台 Mac 上尝试项目原有的本机浏览器入口。它仍需要 Node、已安装的依赖、已构建的网页和可运行的 FFmpeg；无法解决媒体工具或私有存储失败。不要用它绕过系统安全告警或访问拒绝。

先正常退出桌面试用。下例给浏览器试用单独的新目录，不复用桌面 workspace，也不迁移旧项目。如果这个目录已经有数据，先换一个从未使用的目录名。

```sh
env -u MIOON_TOKEN -u MIOON_DIST_DIR \
PORT=4318 MIOON_DATA_DIR="$HOME/Library/Application Support/Mioon Browser Trial" \
MIOON_ENABLE_LIVE_PROVIDER=0 pnpm start
```

此命令沿用当前终端里已确认的 MIOON_FFMPEG_PATH 和 MIOON_FFPROBE_PATH，并仅为这次启动排除已有的令牌和网页目录覆盖变量。保持终端运行，打开 http://127.0.0.1:4318 ，以终端实际显示的地址为准。首次启动会创建只供本机账户读取的 access-token；在另一个本机终端读取它，并只填入这个本机登录框：

```sh
cat "$HOME/Library/Application Support/Mioon Browser Trial/access-token"
```

不要将令牌发到聊天、截图、URL 或共享文件。浏览器试用结束后，在运行服务的终端按 Ctrl+C 正常停止。4318 被占用时，可将启动命令中的 PORT=4318 改为 PORT=4319，并打开终端实际显示的地址；不要结束来历不明的进程。

127.0.0.1 始终指打开浏览器的那台电脑。云端启动的服务不会因此出现在你的 Mac 上。浏览器流程通过后只能记录为“Mac 本机浏览器流程通过”，不能记为“Electron Mac 原生桌面通过”。

## 依据与交付前核对

本次按 `9e9598d887b21b8e1b7dc742e5d15c66a3ff93d4` 重新核对了 package.json、pnpm-workspace.yaml、桌面启动/工具配置、portable tooling、本机服务 CLI、模拟供应商、交付检查和任务中心代码，以及 [DESKTOP.md](DESKTOP.md)、[PORTABLE-TOOLING.md](PORTABLE-TOOLING.md)、[PRIVATE-STORAGE.md](PRIVATE-STORAGE.md) 和 [TASK-RECOVERY.md](TASK-RECOVERY.md)。

实际交付与试用应记录最终源码快照、构建文件哈希、macOS 版本和架构；集成后的验证结果另行记录，不把本说明的源码核对或历史 Linux 验收当作 Mac 实测。
