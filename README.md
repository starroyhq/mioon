<p align="center">
  <img src="apps/web/src/assets/mioon-mark.png" width="104" alt="Mioon" />
</p>

<h1 align="center">Mioon</h1>

<p align="center"><strong>内置视频 Agent 的创作工作台</strong></p>

<p align="center">一句话交给 Mio，排镜头、剪时间线，你随时接手</p>

<p align="center">
  <a href="https://mioon.app">官网</a> ·
  <a href="https://github.com/starroyhq/mioon/releases/tag/v0.1.0">下载 v0.1.0</a> ·
  <a href="#mioon-能帮你做什么">功能介绍</a> ·
  <a href="#开始试用">开始试用</a> ·
  <a href="docs/WORKSPACE-GUIDE.zh-CN.md">使用指南</a> ·
  <a href="https://github.com/starroyhq/mioon/issues">问题反馈</a>
</p>

<p align="center">
  <img alt="v0.1.0 桌面试用" src="https://img.shields.io/badge/%E7%89%88%E6%9C%AC-v0.1.0%20%E6%A1%8C%E9%9D%A2%E8%AF%95%E7%94%A8-475569" />
  <img alt="本地保存" src="https://img.shields.io/badge/%E6%95%B0%E6%8D%AE-%E6%9C%AC%E5%9C%B0%E4%BF%9D%E5%AD%98-16a34a" />
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/License-Apache--2.0-blue" /></a>
</p>

## Mioon 是什么

Mioon 是内置视频 Agent **Mio** 的开源创作工作台，面向个人创作者，本地优先。用一句话告诉 Mio 想做什么，它会读取已授权的项目内容，用和界面相同的操作整理镜头、编排时间线、加字幕，需要时提交生成。每一步都显示在对话里，修改落在同一份可编辑的项目中，你随时可以在画板和时间线上接手。

创意和关键决定由你掌握：付费生成默认先征得你确认，你正在编辑的地方 Mio 不会改。不用 Mio 时，工作台本身就能导入、剪辑、加手动字幕、预览和导出已有素材，不需要 AI 账号或密钥。

Mioon 免费开源（Apache-2.0），项目和素材默认保存在自己的电脑上。

## Mioon 能帮你做什么

### 把具体工作交给 Mio

Mio 是工作台里的创作 Agent，不只回答问题，会直接动手：

- **能干活**：排镜头、剪片段、加字幕，也能提交图片或视频生成
- **每步可见**：每一步都显示在对话里，每处修改都有记录，可撤销的修改能单独或整体撤销；画板和时间线上被 Mio 改过的地方带有标记
- **你说了算**：本地修改和付费操作可以分别设为直接执行或需要确认，付费生成默认需要确认；你正在编辑的地方 Mio 不会改；它计划修改的地方被你改过时，那一步不执行，Mio 按你保存的内容重新规划
- **模型自选**：DeepSeek、通义千问、Kimi、Claude 等服务或本机 Ollama，支持 Chat Completions、Responses 和 [Anthropic Messages](docs/AGENT-ANTHROPIC.md) 三种协议，由你明确选择，不自动重试或回退到其他协议

使用方法见 [Mio 使用说明](docs/MIO-GUIDE.zh-CN.md)，执行与恢复规则见 [Mio 执行与恢复](docs/AGENT-TASKS-V2.md)。模型服务按你在服务商的用量计费。

[![Mioon 的 Mio 助手空闲面板：可按项目授权协助创作，尚未发起模型调用](docs/images/readme/mio.webp)](docs/images/readme/mio.webp)

### 用画板整理故事

把参考图片、视频、文字和镜头卡摆在画板上，为场景记下画面、顺序和想法。画板适合构思，剪辑区适合做成片，可以在同一个项目中随时切换。

[![Mioon 画板：参考图片、镜头卡和文字整理 CHROMA RUSH 演示项目](docs/images/readme/board.webp)](docs/images/readme/board.webp)

### 在时间线上剪辑、预览与导出

调整片段的顺序和长短，叠放画面，配上音乐和手动字幕，再调节声音大小。操作失误时，可以撤销后重新尝试；通过合成预览检查画面与声音，确认后导出 MP4。

新项目可以选择横屏、竖屏或方形画幅。导出进度保留在任务中，关闭导出窗口后，已经开始的任务仍会继续。

[![Mioon 剪辑：视频与图片叠加、音轨和真实合成预览](docs/images/readme/timeline.webp)](docs/images/readme/timeline.webp)

### 接入你自己的生成服务

图片和视频生成使用你自己配置的服务和凭据，提交前按界面核对本次输入与费用。生成的镜头会作为新版本保留，已经放进剪辑区的片段不会因为新一轮生成而自动替换。

- [视频服务](docs/PROVIDERS.md)：火山方舟、Google Veo、MiniMax、Vidu、可灵、通义万相及自定义兼容连接。
- [图片生成](docs/IMAGE-ACTIVATION.md)与[图片编辑](docs/IMAGE-EDITING.md)：OpenAI 官方、自定义兼容连接及 ComfyUI 的范围见对应说明。

### 让 Claude Code、Codex 也来操作

仓库自带一份[技能](skills/mioon/SKILL.md)。Claude Code、Codex 等外部 Agent 装上以后，可以通过命令行或 MCP 操作同一个项目：导入素材、管理镜头和版本、提交生成、修改时间线上的具体片段、导出 MP4。技能要求 Agent 在付费生成前先征得你同意，在线图片生成还要你在界面里确认。安装和连接步骤见[让 Claude Code、Codex 操作 Mioon](docs/EXTERNAL-AGENTS.zh-CN.md)。

以上为[官网演示项目截图](docs/images/readme/SOURCES.md)；导入素材不代表 Mioon 生成结果。

界面支持深色、浅色和跟随系统主题，以及简体中文、繁体中文、英语和日语。

## 开始试用

桌面版请从 [v0.1.0 发布页](https://github.com/starroyhq/mioon/releases/tag/v0.1.0)选择适合电脑的安装包，按[安装与首次运行指南](docs/INSTALL.zh-CN.md)开始。本次提供 **macOS Apple Silicon 和 macOS Intel** 安装包，Linux 与 Windows 桌面包暂不发布。**以发布页实际公开的安装附件为准；若尚未公开，说明本轮发布仍在准备中**

安装包不需要 Node.js 或 pnpm，但仍需自己安装 **FFmpeg 和 ffprobe**，并在首次运行时选择它们。Mioon 目前没有自动更新，更新时需重新下载。功能与验证范围见 [v0.1.0 说明](docs/releases/v0.1.0.zh-CN.md)

希望从源码运行时，继续按[源码试用指南](docs/CORE-TRIAL.zh-CN.md)操作；Mac 用户另见 [Mac 源码启动说明](docs/MAC-SOURCE-TRIAL.zh-CN.md)

应用启动后，可以先试着做一段简单的视频：

1. **新建项目**：选好竖屏、横屏或方形画面
2. **导入素材**：加入几张图片、一段视频或一段音乐
3. **开始剪辑**：把素材加入剪辑区，排好顺序，调整长短并更新预览
4. **导出成片**：检查设置，等待完成，再打开导出的视频看看

每一步的详细操作见[工作区使用指南](docs/WORKSPACE-GUIDE.zh-CN.md)，也可以使用仓库提供的[本地示例素材](examples/README.md)练习

## 使用前了解这几件事

- **素材默认保存在本机**：导入素材不会自动上传。使用外部 AI 功能时，相关提示词或素材会发送给你配置的服务，并可能产生费用
- **记得备份项目**：当前没有自动云同步，重要项目请按[备份指南](docs/WORKSPACE-BACKUP-GUIDE.zh-CN.md)保存副本
- **先从短片开始**：当前适合轻量剪辑，复杂转场、变速和多人协作等功能尚未提供
- **仍在桌面试用阶段**：先用不重要的素材完成一个短片。模型与生成服务的支持范围不等于所有供应商均已通过真实付费验收；版本范围见[发布说明](docs/releases/v0.1.0.zh-CN.md)。问题与验证限制持续记录在 [Issues](https://github.com/starroyhq/mioon/issues) 中，遇到问题欢迎反馈

## 更多说明

- [安装与首次运行](docs/INSTALL.zh-CN.md) · [完整使用指南](docs/WORKSPACE-GUIDE.zh-CN.md) · [源码试用](docs/CORE-TRIAL.zh-CN.md)
- [连接 AI 视频服务](docs/PROVIDERS.md) · [生成图片](docs/IMAGE-ACTIVATION.md) · [编辑图片](docs/IMAGE-EDITING.md)
- [导出设置](docs/EXPORT-SETTINGS.md) · [备份与恢复](docs/WORKSPACE-BACKUP-GUIDE.zh-CN.md)
- [反馈问题与建议](https://github.com/starroyhq/mioon/issues)
- [参与贡献](CONTRIBUTING.md) · [安全问题报告](SECURITY.md)

## 许可证

Mioon 原创代码与文档采用 [Apache License 2.0](LICENSE)，允许按许可证条款使用、修改和分发。版权与归属声明见 [NOTICE](NOTICE)。

第三方依赖、组件、图标及字体保留各自许可，详情见 [第三方声明](THIRD_PARTY_NOTICES.md)。用户素材及模型服务输出的权利由对应来源决定。

<details>
<summary>开发者与进阶用户</summary>

- [本地运行与检查](docs/PORTABLE-TOOLING.md) · [桌面运行说明](docs/DESKTOP.md)
- [GitHub 自动检查与发布](docs/GITHUB-ACTIONS.zh-CN.md) · [CI 状态](https://github.com/starroyhq/mioon/actions/workflows/ci.yml)
- [CLI](docs/CLI.md) · [MCP](docs/MCP.md) · [mioon Skill](skills/mioon/SKILL.md)（[安装与连接](docs/EXTERNAL-AGENTS.zh-CN.md)） · [API](docs/API.md)
- [架构说明](docs/ARCHITECTURE.md) · [组件来源](docs/UI-COMPONENTS.md) · [TypeScript 约定](docs/TYPESCRIPT.md)
- [产品定义：创作工作台 + Agent](docs/PRODUCT-DEFINITION.md)
- [详细验证结果](docs/verification/mioon-redesign/full-test-repairs/README.md)

</details>
