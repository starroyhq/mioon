# GitHub Actions 与桌面发布

Mioon 的自动检查与桌面发布分开运行。PR 和 main 自动检查代码；版本标签才会公开 Release。当前发布目标是 macOS arm64、macOS x64 和 Linux x64。Windows 只做类型、可移植源码及发布辅助逻辑检查，不能据此判断 Windows 应用可用

## 自动检查

`ci.yml` 调用可复用的 `checks.yml`，提供总检查 `CI`。同一分支的新提交会取消旧 CI；发布运行不会因此被取消

- 固定 Node **24.21.0**、pnpm **11.25.0**，执行 `pnpm install --frozen-lockfile`，缓存 pnpm store
- Ubuntu 22.04 从固定哈希的官方源码构建 CI 专用 FFmpeg **7.1.5**，安装 GNU tar、字体和桌面运行依赖，实际检查所需滤镜、编码器及命令参数，再运行类型检查、development Web/桌面暂存构建及 Linux full 测试
- macOS 和 Windows 运行类型、portable 和发布辅助脚本检查；不在这两个平台调用明确限于 Linux 的 full 通道
- 工作流使用 actionlint 校验；辅助代码纳入项目严格 TypeScript 检查。PR 不接触 Apple 签名凭据

完整测试使用现有 tooling 的环境清理和真实生成关闭策略，测试文件串行、独立进程。失败不会被自动忽略；日志和诊断报告分别标明执行范围。本地 macOS 缺失的媒体滤镜是否在 Ubuntu 已解决，以实际能力检查和测试结果为准

Ubuntu 22.04 的系统 FFmpeg 4.4.2 缺少当前代码使用的文件值参数及 `fps_mode`，只检查滤镜列表不足以证明兼容。CI 固定使用[官方 7.1.5 源码](https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz)，SHA-256 为 `de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f`；引入时已按[官方签名方法](https://ffmpeg.org/download.html)在独立临时密钥环核验发布签名。安装后还实际运行 `-/filter:v`、`-/filter_complex` 和 `-fps_mode` 单帧探针，并确认 PNG 编解码能力。这个工具仅用于 runner，不随 Mioon 安装包发布，不改变 pnpm 依赖

## 配置 Apple 签名

在仓库 **Settings → Secrets and variables → Actions** 添加以下 Secrets，或为仓库授权同名组织级 Secrets。不要将密钥写入工作流、提交或聊天

| Secret | 内容 |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application 证书及私钥的 `.p12` 文件，Base64 编码 |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` 导出密码 |
| `APPLE_SIGNING_IDENTITY` | 完整 Developer ID Application 签名身份 |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `APPLE_API_ISSUER` | App Store Connect API Issuer ID |
| `APPLE_API_KEY` | API Key ID，不是文件路径 |
| `APPLE_API_PRIVATE_KEY` | 对应 `.p8` 文件的文本内容 |

证书、公证私钥只写入 runner 临时目录，以私有权限创建；使用临时签名钥匙链并在结束时清理。缺少任一凭据或签名、公证、票据、Gatekeeper 检查失败时，发布停止，不降级为未签名正式包

正式工作流通过 CI 专用参数启用签名，不改变本地 `package:mac` 的现有默认值。配置按项目锁定的 electron-builder v26 使用，不能套用 v27 的字段结构

## 先做不发布的演练

工作流合入 main 后，在 **Actions → Desktop release → Run workflow** 选择 main，保持 `release_tag` 为空

这会对 main 上的确切提交执行完整检查、三个平台的打包与真实包冒烟，并上传 Actions 产物；不会创建或公开 GitHub Release。macOS 仍须签名、公证，因此需要先配置上述凭据

每个平台的检查使用当前源码构建 Web、桌面暂存和安装包，不复用旧 dist。原生冒烟自己生成临时合成媒体及私有工作区，不依赖未入库的演示数据库；核对真实窗口、后端、认证拒绝、本地合成和退出清理。它不调用真实供应商，也不等于所有界面和系统密钥链场景均已验收

Linux 在非 root、支持沙箱的 Xvfb/DBus 会话中运行，保留 Chromium sandbox；安全解压最终 tar.gz，核对完整文件树后启动解包应用。macOS 检查并启动最终 DMG 内的应用。FFmpeg/ffprobe 只在 runner 上准备，继续由使用者在本机单独提供，不随安装包捆绑

## 正式发布

1. 合并版本修改，保证根 `package.json` 和桌面包版本一致
2. 在 main 已包含的确切提交上创建并推送 `v<版本>` 标签，例如版本 `0.4.1` 对应 `v0.4.1`；工作流不会代替维护者递增版本或创建标签
3. 标签触发 `release-desktop.yml`；也可以手动填写已有的相同版本标签重新运行
4. preflight 验证版本、标签、确切源码 SHA 和 main 包含关系，所有检查与打包使用同一 SHA
5. 三个平台全部通过后，发布 job 再次检查标签未移动，核对三份安装包、清单与哈希，创建草稿并上传；远端附件核对通过后自动公开

Release 附件只有两份 DMG、一份 Linux x64 tar.gz、`SHA256SUMS` 和 `release-manifest.json`。清单记录版本、源码 SHA、平台、架构、字节数及 SHA-256。预发布版本公开为 prerelease，不更新 stable latest。没有应用自动更新器或更新元数据

仅最终发布 job 有仓库内容写权限。已经公开的相同版本不会被覆盖；不要移动旧标签来重新发布

## 失败与恢复

- CI 日志或能力探针失败：先修复依赖、接线或实际缺陷，再重跑；不能用 `continue-on-error` 或排除原测试获得通过
- 缺少签名凭据：配置或授权 Secrets 后重跑。未完成签名验证不能描述为完整发布链已通过
- 打包、原生检查或任一平台失败：保留 Actions 诊断，不公开部分平台 Release
- 发布中断：只允许恢复本工作流所属、标签和 SHA 及产物清单完全一致的草稿；陌生或已公开的 Release 会被拒绝
- 标签移动、附件缺失或哈希不同：停止，不自动替换或覆盖；检查版本和源码后使用正确的新版本重新发布

脱敏诊断保留 7 天，Actions 安装包产物保留 14 天。上传范围只包含明确报告和最终安装产物，不包含临时工作区、数据库、令牌、Apple 私钥或 designs

现有 main 保护规则保持原样。`CI` 首轮实际通过后，维护者可按团队策略将其设置为 required check；本次搭建不自动改变合并或直接推送策略
