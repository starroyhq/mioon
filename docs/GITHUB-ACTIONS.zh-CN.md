# GitHub Actions 与桌面发布

Mioon 的自动检查与桌面发布分开运行。PR 和 main 自动检查代码；版本标签才会公开 Release。当前发布目标是 macOS arm64、macOS x64 和 Linux x64。Windows 只做类型、可移植源码及发布辅助逻辑检查，不能据此判断 Windows 应用可用

## 自动检查

`ci.yml` 调用可复用的 `checks.yml`，提供总检查 `CI`。同一分支的新提交会取消旧 CI；发布运行不会因此被取消

- 固定 Node **24.21.0**、pnpm **11.25.0**，执行 `pnpm install --frozen-lockfile`，缓存 pnpm store
- 独立 Ubuntu 22.04 source job 执行一次 actionlint 和 development Web/桌面暂存构建；构建入口包含源码与 CI 辅助代码的严格 TypeScript 检查，保留桌面暂存替换前的内部类型检查
- 一个独立 Ubuntu 22.04 准备 job 恢复精确构建缓存；未命中时从固定源码镜像构建 CI 专用 FFmpeg **7.1.5**。验证工具文件、版本、所需滤镜、编码器及命令参数后，才保存缓存并上传本轮 artifact
- 八个独立 Ubuntu 22.04 测试 job 安装 GNU tar、DejaVu 字体及媒体运行依赖，从同一准备 job 的 artifact 读取 FFmpeg，核验构建身份及文件哈希、恢复可执行权限，重新检查实际媒体能力，再运行 Linux full 测试分片
- macOS 和 Windows 运行类型、portable 和发布辅助脚本检查；不在这两个平台调用明确限于 Linux 的 full 通道
- source、媒体准备和 portable job 并行运行，八个 full 分片等待媒体准备，全部使用相同冻结源码 SHA；总检查要求 source、媒体准备、八个 full 分片和两个 portable job 全部成功。PR 不接触 Apple 签名凭据

完整测试使用现有 tooling 的环境清理和真实生成关闭策略，每个文件仍是独立进程；Ubuntu 运行机有 4 个 vCPU，每个 job 同时跑 3 个测试文件。与其他文件同时运行时，文件平均慢约 1.5 倍、最多约 2 倍，因此时限余量不足的测试文件列在 `.github/scripts/test-shard.ts` 的 `EXCLUSIVE_TEST_FILES`，每个分片先在空闲的运行机上单独跑本片的这些文件，再并行跑其余文件。入选标准：串行 CI 耗时达到自身声明时限三分之一的测试所在的文件，或共用 CPU 时因其他原因（如信号送达竞态、固定操作预算）在 CI 中失败过的文件；每项注明依据。不对失败的测试自动重跑。八个 Linux 测试 job 各限时 60 分钟，source job 限时 20 分钟。测试 job 不重复执行工作流检查和应用构建，也不依赖 source job 的暂存产物；保留现有测试选择、断言和 FFmpeg 自身的阶段期限。分片从 full 权威列表自动分配：按 `.github/test-timings.json` 记录的每文件耗时，从最长的文件开始，依次放进当前累计耗时最少的分片，使各片大致同时结束；表里没有的新测试按已记录耗时的中位数估算，没有耗时表时退回按名称轮流分配。结果只取决于测试列表和提交的耗时表。先校验并集完整且互不重叠，再通过已有 `--file` 参数执行；新测试会自动进入，不维护排除名单。每片随覆盖证明上传本次各文件的实际耗时（`timings.json`）。测试增删或耗时明显变化后，用 `gh run download <运行 ID> --pattern 'checks-linux-*-coverage' --dir <目录>` 下载，再运行 `node .github/scripts/test-timings.ts <目录>` 刷新耗时表并提交；本次没测到的文件保留原值，已删除的测试会被移除；单独运行的文件记录在 `timings-alone.json`，一并读取。矩阵保持 `fail-fast: false`，八个分片全部成功才允许总检查通过。每片记录源码 SHA、全集哈希、耗时表哈希、选中文件和预计耗时，便于核查覆盖范围。失败不会被自动忽略；日志和诊断报告分别标明执行范围。本地 macOS 缺失的媒体滤镜是否在 Ubuntu 已解决，以实际能力检查和测试结果为准

测试 job 不安装随后会被替代的系统 FFmpeg，也不安装只供桌面窗口冒烟使用的 GTK、Xvfb、DBus 和 xdotool 依赖。FFmpeg 仍依赖 Ubuntu 的动态库，因此准备 job 和各消费者保留相同的媒体依赖包；分片不会重新下载源码或编译。字幕使用仓库内固定哈希的字体文件，无需下载整套系统 Noto CJK；DejaVu 为模拟视频的英文标记提供默认字体。apt 步骤独立限时 10 分钟，HTTP/HTTPS 下载超时为 30 秒，最多重试两次；超限直接失败，不占满整个测试窗口。发布 job 仍保留生产应用构建、桌面运行依赖和真实安装包冒烟；Linux 打包复用本轮 checks 的 FFmpeg artifact，macOS 明确安装并选择 Homebrew 的 `ffmpeg-full`

项目文件测试的媒体 fixture 同样优先使用已选定的 `MIOON_FFMPEG_PATH` / `MIOON_FFPROBE_PATH`，避免 Linux 已安装工具却因检测 Mac 目录而跳过导入、导出和备份用例。没有显式路径时保留既有测试目录约定；显式路径不存在时不能用备用目录掩盖配置错误

Linux full 完整检出现有 Git 历史，以读取历史回归中固定提交的源码；历史对象不足时直接失败，不改用当前源码替代旧基线

Ubuntu 22.04 的系统 FFmpeg 4.4.2 缺少当前代码使用的文件值参数及 `fps_mode`，只检查滤镜列表不足以证明兼容。CI 使用[仓库固定源码镜像](https://github.com/starroyhq/mioon/releases/download/ci-ffmpeg-7.1.5/ffmpeg-7.1.5.tar.xz)，与[官方 7.1.5 源码](https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz)的 SHA-256 相同：`de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f`。引入时已按[官方签名方法](https://ffmpeg.org/download.html)在独立临时密钥环核验发布签名；镜像不改变官方来源、版本和哈希校验。专用 `ci-ffmpeg-7.1.5` 预发布仅存放 CI 源码，不属于 Mioon 应用发布，也不标记为最新应用版本。安装后还实际运行 `-/filter:v`、`-/filter_complex` 和 `-fps_mode` 单帧探针，并确认 PNG 编解码能力。这个工具仅用于 runner，不随 Mioon 安装包发布，不改变 pnpm 依赖

构建缓存严格按工具链身份匹配，不使用前缀降级恢复；命中后仍须核验清单、构建配置、二进制哈希及版本。每轮只由准备 job 保存缓存和上传 artifact，消费者读取该 job 输出的 artifact 名称及构建身份；只重跑失败分片时仍复用原准备结果，不按新的运行次数猜测名称。缓存缺失只触发一次构建，校验或媒体能力失败直接阻断该轮检查，不回退系统 FFmpeg，也不跳过测试

macOS 发布 runner 使用 [Homebrew `ffmpeg-full`](https://formulae.brew.sh/formula/ffmpeg-full)，从 `brew --prefix ffmpeg-full` 下的 `bin/ffmpeg` 与 `bin/ffprobe` 写入明确的 `MIOON_FFMPEG_PATH` / `MIOON_FFPROBE_PATH`；不强制链接系统命令，也不因 PATH 中已有精简版而跳过选择。两平台均检查 `drawtext`、`subtitles`、`zscale`、`loudnorm`、`ebur128` 滤镜及 `libx264`、`aac`、`libwebp`、`libwebp_anim` 编码器，并保留实际文件值参数、`fps_mode` 与 PNG 编解码探针。缺失能力直接阻断演练；这些 runner 工具不随应用安装包捆绑

源码下载仅对已知临时网络错误、HTTP 408/429/5xx 重试，最多三次并共用 120 秒总预算。每次重新下载完整文件，之后仍须通过固定哈希；校验、构建和测试失败不会因此重试或被忽略

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

创建临时钥匙链前先保存原用户钥匙链搜索列表，导入身份并设置访问分区后，将临时钥匙链追加到搜索列表，保留原有项且不改变默认钥匙链。打包前在凭据临时目录编译一个最小本机 Mach-O，用相同签名身份和钥匙链执行带时间戳、Hardened Runtime 的签名及严格校验；导入成功不能代替这项自检。探针不公证、不发布，随临时凭据清理。无论打包是否成功，清理先恢复原搜索列表，再删除临时钥匙链；恢复失败仍尝试删除并明确报告清理失败。最终应用签名、公证、Gatekeeper 和安装包冒烟仍须分别通过

正式工作流通过 CI 专用参数启用签名，不改变本地 `package:mac` 的现有默认值。配置按项目锁定的 electron-builder v26 使用，不能套用 v27 的字段结构

## 先做不发布的演练

工作流合入 main 后，在 **Actions → Desktop release → Run workflow** 选择 main，保持 `release_tag` 为空

这会对 main 上的确切提交执行完整检查、三个平台的打包与真实包冒烟，并上传 Actions 产物；不会创建或公开 GitHub Release。macOS 仍须签名、公证，因此需要先配置上述凭据

每个平台的检查使用当前源码构建 Web、桌面暂存和安装包，不复用旧 dist。原生冒烟自己生成临时合成媒体及私有工作区，不依赖未入库的演示数据库；核对真实窗口、后端、认证拒绝、本地合成和退出清理。它不调用真实供应商，也不等于所有界面和系统密钥链场景均已验收

Linux 在非 root、支持沙箱的 Xvfb/DBus 会话中运行，保留 Chromium sandbox；安全解压最终 tar.gz，核对完整文件树后启动解包应用。macOS 检查并启动最终 DMG 内的应用。FFmpeg/ffprobe 只在 runner 上准备，继续由使用者在本机单独提供，不随安装包捆绑

## 正式发布

1. 合并版本修改，保证根 `package.json` 和桌面包版本一致
2. 在 main 已包含的确切提交上创建并推送 `v<版本>` 标签，例如版本 `0.1.0` 对应 `v0.1.0`；工作流不会代替维护者递增版本或创建标签
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
