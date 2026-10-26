# 参与 Mioon

欢迎提交问题、改进建议、文档和代码。先查看 [README](README.md)、[使用指南](docs/WORKSPACE-GUIDE.zh-CN.md)及已有 [Issues](https://github.com/starroyhq/mioon/issues)，避免重复反馈。

## 反馈问题

请提供应用版本或提交 SHA、操作系统与架构、最少复现步骤、预期和实际结果。日志与截图应脱敏；不要上传 API Key、访问令牌、连接描述文件、完整工作区或私人素材。安全问题请按 [安全政策](SECURITY.md)私下报告。

功能建议请说明要完成的创作任务、现有流程的障碍及可接受的替代方案。

## 准备开发环境

推荐与 CI 保持一致：Node.js `24.21.0`、pnpm `11.25.0`。项目要求 Node.js ≥24；媒体工具及平台限制见[源码试用指南](docs/CORE-TRIAL.zh-CN.md)和[本地工具说明](docs/PORTABLE-TOOLING.md)。

```sh
git clone https://github.com/starroyhq/mioon.git
cd mioon
pnpm install --frozen-lockfile
node scripts/tooling.ts doctor
```

使用独立的试用工作区和合成素材，避免让测试或开发实例修改日常项目。启动方式见[桌面开发说明](docs/DESKTOP.md)；架构、类型和组件约定分别见 [ARCHITECTURE](docs/ARCHITECTURE.md)、[TYPESCRIPT](docs/TYPESCRIPT.md)及 [UI-COMPONENTS](docs/UI-COMPONENTS.md)。

## 修改与验证

保持改动聚焦，缺陷修复应覆盖原触发条件及相关边界；行为变化同步更新文档。保留授权、凭据绑定、输入冻结和任务恢复检查，不以自动重试、自动回退或跳过断言掩盖失败。新增界面文案同步四种语言。

```sh
pnpm typecheck
node scripts/tooling.ts test --suite=portable --concurrency=1
```

先执行与改动直接相关的测试，再按影响范围执行 `pnpm build`、`pnpm desktop:build` 等检查。完整测试通道含 Linux 存储和进程假设，仅在 Linux 运行：

```sh
node scripts/tooling.ts test --suite=full --concurrency=1
```

macOS/Windows 的便携测试通过不代表完整通道或原生安装包已验证；不要绕过平台门禁。完整 CI 与发布验证范围见 [GitHub Actions 说明](docs/GITHUB-ACTIONS.zh-CN.md)。

默认使用离线模拟网络，不在测试中读取真实凭据或自动发起付费生成。真实模型验证需要单独明确授权，并在结果中区分模拟测试和真实服务验证。

## 提交 Pull Request

从最新 `main` 创建分支，说明问题、最终行为、验证命令与结果；列明未验证部分或平台限制。不要提交工作区数据、密钥、构建产物或临时诊断。提交信息沿用 `type(scope): 简述结果`，例如 `fix(backup): 修复取消后的状态恢复`。

只提交你有权提供的内容，保留第三方的版权及许可证声明。除非事先明确另有约定，你有意提交并纳入本项目的贡献按 [Apache License 2.0](LICENSE)提供；第三方组件继续遵循其自身许可。
