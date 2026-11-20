# GitHub Actions 与桌面发布

Mioon 的自动检查与桌面发布分开运行。PR 和 main 自动检查代码；版本标签才会公开 Release。v0.1.0 先发布 macOS arm64 和 macOS x64，Linux 桌面包暂不发布。Windows 只做类型、可移植源码及发布辅助逻辑检查，不能据此判断 Windows 应用可用

## 自动检查

`ci.yml` 调用可复用的 `checks.yml`，提供总检查 `CI`。同一分支的新提交会取消旧 CI；发布运行不会因此被取消

- 固定 Node **24.21.0**、pnpm **11.25.0**，执行 `pnpm install --frozen-lockfile`，缓存 pnpm store
- 独立 Ubuntu 22.04 source job 执行一次 actionlint 和 development Web/桌面暂存构建；构建入口包含源码与 CI 辅助代码的严格 TypeScript 检查，保留桌面暂存替换前的内部类型检查
- 类型检查子进程固定使用每个项目 4 GiB 的堆预算（foundation、browser、两个拆分后的 tests 项目），由受信工具入口指定
- 一个独立 Ubuntu 22.04 准备 job 恢复精确构建缓存；未命中时从固定源码镜像构建 CI 专用 FFmpeg **7.1.5**。验证工具文件、版本、所需滤镜、编码器及命令参数后，才保存缓存并上传本轮 artifact
- 八个独立 Ubuntu 22.04 测试 job 安装 GNU tar、DejaVu 字体及媒体运行依赖，从同一准备 job 的 artifact 读取 FFmpeg，核验构建身份及文件哈希、恢复可执行权限，重新检查实际媒体能力，再运行 Linux full 测试分片
- macOS 把 portable 检查、发布辅助脚本检查和桌面组检查合并到一个 job（同一台 `macos-15` 上先 portable、再 `--suite=macos-desktop`，共 124 个桌面文件、并发 2，限时 45 分钟），每轮只占 1 个 macOS runner 名额；Windows 单独一个 portable job。不在这两个平台调用明确限于 Linux 的 full 通道；需要完整 FFmpeg 的媒体探针文件留给夜间 `full-darwin`（macOS 专用入口，Linux 仍是 `full`）。macOS 测试子进程的临时目录固定为 `/private/tmp`，完整/夜间车道对每个文件使用 3 倍计时 + 2 分钟、最短 10 分钟、无记录 35 分钟的期限
- 修改导出基准脚本的 PR，在同一个 macOS arm64 检查中使用应用固定下载的 FFmpeg，分别用 PR 基线和当前实现导出合成时间线。运行摘要记录耗时、CPU、进程树 RSS 和负载，并核对输出 SHA-256；不上传成片
- source、媒体准备、macOS 合并 job 和 Windows portable job 并行运行，八个 full 分片等待媒体准备，全部使用相同冻结源码 SHA；总检查要求 source、媒体准备、八个 full 分片、macOS 合并 job 和 Windows portable job 全部成功。PR 不接触 Apple 签名凭据

### 未分到机器时自动重跑

`.github/workflows/retry-not-acquired.yml` 只处理 GitHub 托管 runner 容量不足导致的「作业从未被分配机器」：`CI` 工作流失败完成后触发，先分类再决定是否重跑。

- 只有 `run_attempt === 1`、且每个非聚合失败 job 都满足「没有 steps、没有 runner、注解含 `The job was not acquired by Runner of type hosted even after multiple attempts`」时才调用 `rerun-failed-jobs`；混合真实失败、真实测试失败、非首次 attempt、注解缺失或拿不准一律不重跑（fail-closed）。
- 手动 `workflow_dispatch` 是只读演练（`actions: read`），自动路径才给 `actions: write`；两条路径都显式检出 `main`、不使用 PR 代码，run id 通过环境变量传入并在脚本里校验为纯数字。
- 每次判定（verdict、理由、是否调用重跑及结果）都写 step summary，便于事后核对。自动重跑每个 run 最多一次（attempt 检查），不会掩盖容量外的问题。

完整测试使用现有 tooling 的环境清理和真实生成关闭策略，每个文件仍是独立进程；Ubuntu 运行机有 4 个 vCPU，每个 job 同时跑 3 个测试文件。并行执行会争用 CPU，文件耗时也随运行机波动。时限余量不足的测试文件列在 `.github/scripts/test-shard.ts` 的 `EXCLUSIVE_TEST_FILES`，每个分片先在空闲的运行机上单独跑本片的这些文件，再并行跑其余文件。入选标准：串行 CI 耗时达到自身声明时限三分之一的测试所在的文件，或共用 CPU 时因其他原因（如信号送达竞态、固定操作预算）在 CI 中失败过的文件；每项注明依据。不对失败的测试自动重跑。八个 Linux 测试 job 各限时 60 分钟，source job 限时 20 分钟。测试 job 不重复执行工作流检查和应用构建，也不依赖 source job 的暂存产物；保留现有测试选择、断言和 FFmpeg 自身的阶段期限。分片从 full 权威列表自动分配：按 `.github/test-timings.json` 记录的每文件耗时，从最长的文件开始，依次放进当前累计耗时最少的分片，使各片大致同时结束；表里没有的新测试按已记录耗时的中位数估算，没有耗时表时退回按名称轮流分配。结果只取决于测试列表和提交的耗时表。先校验并集完整且互不重叠，再逐文件启动 Node 测试进程；新测试会自动进入，不维护排除名单。每片随覆盖证明上传本次各文件的实际耗时（`timings.json`）。测试增删或耗时明显变化后，用 `gh run download <运行 ID> --pattern 'checks-linux-*-coverage' --dir <目录>` 下载，再运行 `node .github/scripts/test-timings.ts <目录>` 刷新耗时表并提交；本次没测到的文件保留原值，已删除的测试会被移除；单独运行的文件记录在 `timings-alone.json`，一并读取。矩阵保持 `fail-fast: false`，八个分片全部成功才允许总检查通过。每片记录源码 SHA、全集哈希、耗时表哈希、选中文件和预计耗时，便于核查覆盖范围。失败不会被自动忽略；日志和诊断报告分别标明执行范围。本地 macOS 缺失的媒体滤镜是否在 Ubuntu 已解决，以实际能力检查和测试结果为准

每个文件从进程启动开始单独计时，期限为计时表记录的三倍再加 2 分钟，最短 10 分钟。没有记录的文件用 35 分钟。h1e 报告测试曾在共享阶段用 332.51 秒正常完成，两次触发原 300 秒期限后改为单独运行。当前最长记录 933.12 秒对应约 48 分 39 秒期限。超时会终止该文件的进程组，日志记录仓库相对路径、已运行时长和最多 12 行输出。分片继续调度剩余文件，最终返回失败。超时文件的耗时不进入计时产物。

测试 job 不安装随后会被替代的系统 FFmpeg，也不安装只供桌面窗口冒烟使用的 GTK、Xvfb、DBus 和 xdotool 依赖。FFmpeg 仍依赖 Ubuntu 的动态库，因此准备 job 和各消费者保留相同的媒体依赖包；分片不会重新下载源码或编译。字幕使用仓库内固定哈希的字体文件，无需下载整套系统 Noto CJK；DejaVu 为模拟视频的英文标记提供默认字体。apt 步骤独立限时 10 分钟，HTTP/HTTPS 下载超时为 30 秒，最多重试两次；超限直接失败，不占满整个测试窗口。发布 job 仍保留生产应用构建、桌面运行依赖和真实安装包冒烟；当前 macOS 打包明确安装并选择 Homebrew 的 `ffmpeg-full`；Linux 仍保留源码 CI 与媒体测试

Mio 运行时回归按模型协议、控制与预算、撤销、生成、后台任务、会话、消息压缩、冲突八个场景放在 `tests/agent-task-runtime-*-v2.test.ts`，共用夹具在 `tests/helpers/agent-task-runtime-fixture.ts`。每个文件由 full 清单自动发现，并在独立进程中运行。109 步离线压缩用例位于 control 文件；Node 的 TAP 输出可能在长用例执行期间停留在先前的用例，定位慢测时应核对用例自身的 `duration_ms` 和采样栈，不能仅按相邻日志的时间间隔归因。新增文件的实测耗时在拆分合入 main、整轮检查成功后，按上面的流程通过独立 PR 刷新，不在拆分 PR 中估填

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

正式工作流通过 CI 专用参数启用签名。本地 `package:mac:dev` 及其别名 `package:mac` 生成 Mioon Dev。锁定的 electron-builder v26 先合并 Apple 芯片和 Intel 的 Electron，再签名通用正式应用并生成 DMG 与 ZIP。

正式工作流在签名完成后调用专用 `afterSign` hook，复用已锁定的 `@electron/notarize` 提交应用，公证调用仅一次。该库的装订错误出现在 `Accepted` 之后；只有其明确的装订错误前缀、退出68以及 Apple CloudKit 的已识别 URL 网络错误同时存在时，才对同一应用继续装订，计入原失败次数后最多三次。最终 DMG 的装订和应用/DMG 的票据验证同样最多三次，只对明确网络瞬态退避，第二、三次调用前分别等待 30 秒和 90 秒。恢复器执行的命令每次仍限 60 秒；直接调用恢复器时，三次命令加两段等待的配置预算最多 300 秒（不含 runner 调度）。库已执行的首次应用装订仍计入三次上限，其公证及首次装订耗时不计入恢复器的命令预算。没有票据、票据无效、签名/认证失败、未知错误、命令超时或信号终止都直接阻断。不会重新提交公证或重跑整个 builder 碰运气，也不通过修改签名身份、凭据、Hardened Runtime 或 Gatekeeper 绕过问题

`app-notarization.json` 记录是否已知公证接受、调用次数及装订/验证阶段；`dmg-stapling.json` 和最终 `inspection.json` 记录安全的退出码、信号、超时、错误类别及重试次数，不写入原始工具错误文本、命令参数或 Apple 凭据。票据验证会访问 Apple 票据服务，刚完成装订不代表下一次联网验证必然成功；最终仍必须验证通过才能冒烟、暂存及上传安装包。检查也核对包内的项目 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md` 与冻结源码逐字节一致（打包名以 `stage-project-notices.ts` 为准）

## 先做不发布的演练

在 **Actions → Desktop release → Run workflow** 选择 main，保持 `release_tag` 为空。本次通用包发布流程改动也可在 `howard/mac-universal-update-feed` 分支做候选演练。

预检冻结源码 SHA，并查询同一仓库 `CI` 工作流由 main push 触发、在该 SHA 上已完成且成功的运行。复用前还核对冻结源码与发布工作流所用的 `checks.yml` 一致。预检摘要和 `release-source-check-decision` 产物会记录来源 run、尝试次数和链接。没有匹配结果、查询暂不可用或启用 `force_checks` 时，完整检查与 Apple 芯片打包并行。Intel runner 下载并启动同一份通用 DMG。只有检查证据、签名、公证、包检查和两架构冒烟都通过，才会暂存最终 Actions 产物。候选包也需要签名和公证凭据。

验证应用内更新时，可填 `update_feed_url`，用 HTTPS 目录或本机回环 HTTP 地址。留空时使用正式的 GitHub 更新源。用 `version_override` 给候选包设置稳定的三段版本号。等当前 main 的 push CI 成功，在 main 保持同一提交时连续触发两次即可并行打包。下面用 0.2.0、0.2.1 举例，每次 dispatch 使用独立并发组。

```sh
gh workflow run release-desktop.yml --ref main -f update_feed_url=http://127.0.0.1:4319/ -f version_override=0.2.0
gh workflow run release-desktop.yml --ref main -f update_feed_url=http://127.0.0.1:4319/ -f version_override=0.2.1
```

核对两次预检的源码 SHA 和复用的 CI run 一致。将新版的 `latest-mac.yml`、ZIP 和 ZIP blockmap 放到同一个目录，让指向该目录的旧候选包检查更新。正式标签构建使用标签版本和固定的 GitHub 更新源。排查时可加 `-f force_checks=true` 强制执行完整检查。

每个平台的检查使用当前源码构建 Web、桌面暂存和安装包，不复用旧 dist。原生冒烟自己生成临时合成媒体及私有工作区，不依赖未入库的演示数据库；核对真实窗口、后端、认证拒绝、本地合成和退出清理。它不调用真实供应商，也不等于所有界面和系统密钥链场景均已验收

检查会比较主程序和 Helper 的 `arm64`、`x86_64` 切片，并对 DMG 和 ZIP 中的应用校验签名、装订票据和 Gatekeeper。应用在制作 ZIP 前完成公证和装订。DMG 制作后另外公证和装订。FFmpeg/ffprobe 在 runner 上另行准备。

打包诊断中的 `build-timings.jsonl` 记录一次完整 TypeScript 检查、Web 打包、桌面 bundle 和暂存的分阶段耗时。桌面暂存只在私有证据确认同一份源码指纹时跳过重复检查，单独运行桌面暂存仍会检查。`desktop-build` 包含该进程的子阶段。通用包合并和公证在后续打包步骤计时。Apple 芯片 runner 支持按 Homebrew bottle 的完整 SHA-256 缓存 `ffmpeg-full` 下载文件，安装和媒体能力探针仍逐轮执行。Intel 和未找到匹配 bottle 的 runner 沿用 Homebrew 安装。依赖下载使用既有的 pnpm store 缓存。

## macOS 媒体工具链（手动）

`.github/workflows/macos-media-toolchain.yml`（`workflow_dispatch`）在 `macos-15` 上安装并验证 Homebrew **`ffmpeg@7`**（Homebrew 的 FFmpeg **7.1.5** 版本化 formula），然后运行 `node scripts/tooling.ts test --suite=macos-media --concurrency=2 --reporter=tap`（H0 中需要完整 FFmpeg 能力的 26 个媒体文件）。Linux 仍使用 `checks.yml` 里准备 job 的固定工具链。

- 选 `ffmpeg@7` 而不是浮动的 `ffmpeg-full`：桌面应用下载的固定工具链和 Linux CI 都是 7.1.5；`ffmpeg-full` 已漂移到 9.0.2，FFmpeg 9 的 alpha side-data 改变了 overlay `alpha=premultiplied` 语义（对已预乘输入再次预乘），会让 4 个精确像素/恢复渲染用例失败。7.1.5 是应用实际使用的版本，`ffmpeg@7` 同时带齐测试需要的 `libwebp`/`libwebp_anim`/`libvpx-vp9`/`libmp3lame` 编码器与 `drawtext`/`subtitles`/`zscale` 滤镜。
- `.github/actions/macos-media-toolchain` 按 `brew info --json=v2 ffmpeg@7` 的 `arm64_sequoia`（macOS 15）bottle SHA-256 缓存下载文件；缓存命中后先重算哈希，不匹配就丢弃再重新下载；`ffmpeg@7` 未安装时回退到 `brew install ffmpeg@7`。安装后把 `<prefix>/bin` 写入 `GITHUB_PATH`，并设置 `MIOON_FFMPEG_PATH`/`MIOON_FFPROBE_PATH`，使直接调用 `ffmpeg` 的测试与应用路径都使用同一版本。
- 安装后用 `.github/scripts/media-environment.ts` 探测版本、`drawtext`/`subtitles`/`zscale`/`loudnorm`/`ebur128` 滤镜、`libx264`/`aac`/`libwebp`/`libwebp_anim` 编码器以及 filter 文件参数、`fps_mode`、PNG 编解码；任一能力缺失直接失败。
- 证据上传为 `macos-media-toolchain-evidence` artifact：`media.json`（版本与能力探针）和 `toolchain.json`（bottle SHA-256、缓存状态、ffmpeg/ffprobe 路径与 SHA-256、能力汇总）。夜间 macOS 完整测试（C 卡）会复用同一个 action。

## 正式发布

1. 合并版本修改，保证根 `package.json` 和桌面包版本一致
2. 在 main 已包含的确切提交上创建并推送 `v<版本>` 标签，例如版本 `0.1.0` 对应 `v0.1.0`；工作流不会代替维护者递增版本或创建标签
3. 标签触发 `release-desktop.yml`；也可以手动填写已有的相同版本标签重新运行
4. preflight 验证版本、标签、确切源码 SHA 和 main 包含关系，所有检查与打包使用同一 SHA
5. 同一份 DMG 的两架构冒烟全部通过后，发布 job 再次检查标签未移动，核对通用包和更新文件，创建草稿并上传。远端附件核对通过后公开为正式 Release。

手动安装用 `mioon-<version>-mac.dmg`。应用内更新用 `mioon-<version>-mac.zip`、`mioon-<version>-mac.zip.blockmap` 和 `latest-mac.yml`。流水线校验清单记录的 ZIP 文件名、版本、大小和 SHA-512 与最终 ZIP 一致。DMG blockmap 如有生成也纳入附件。每份资产有独立清单，`release-manifest.json` 汇总版本、源码 SHA、平台、架构、字节数与 SHA-256，`SHA256SUMS` 覆盖资产及清单。GitHub 更新源使用正式 Release，预发布标签会被拒绝。

仅最终发布 job 有仓库内容写权限。已经公开的相同版本不会被覆盖；不要移动旧标签来重新发布

## 失败与恢复

- CI 日志或能力探针失败：先修复依赖、接线或实际缺陷，再重跑；不能用 `continue-on-error` 或排除原测试获得通过
- 缺少签名凭据：配置或授权 Secrets 后重跑。未完成签名验证不能描述为完整发布链已通过
- 打包、原生检查或任一平台失败：保留 Actions 诊断，不公开部分平台 Release
- 发布中断：只允许恢复本工作流所属、标签和 SHA 及产物清单完全一致的草稿；陌生或已公开的 Release 会被拒绝
- 标签移动、附件缺失或哈希不同：停止，不自动替换或覆盖；检查版本和源码后使用正确的新版本重新发布

预检脱敏诊断保留 7 天，桌面打包诊断及 Actions 安装包产物保留 14 天。上传范围只包含明确报告和最终安装产物，不包含临时工作区、数据库、令牌、Apple 私钥或 designs

现有 main 保护规则保持原样。`CI` 首轮实际通过后，维护者可按团队策略将其设置为 required check；本次搭建不自动改变合并或直接推送策略
