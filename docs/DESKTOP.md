# Electron 桌面版

当前说明核对基线：`9e9598d887b21b8e1b7dc742e5d15c66a3ff93d4`（2026-10-10）。下方 V3/V4/V4.1 运行记录保留其历史归属；此次文档核对不产生 Mac/Windows 原生通过记录。

桌面版使用 Electron 44.7.0，运行同一份 React 页面、HTTP 适配层和业务包。没有另写一套生成、时间线、幂等或数据库逻辑。桌面主进程只负责窗口、安全边界、工具配置与服务生命周期。

## 运行模型

```text
Electron 主进程
  ├─ 沙箱 BrowserWindow → 同源 HTTP → 127.0.0.1:系统分配端口
  └─ Electron utilityProcess（捆绑的 Node + node:sqlite）
       └─ @mioon/server → @mioon/business → SQLite / managed media
            └─ 用户明确指定的 FFmpeg / ffprobe 可执行文件

独立 MCP 客户端 → stdio MCP bridge → 同一个正在运行的 HTTP 服务
```

打包后的桌面应用不调用系统 `node`，不使用 `child_process.fork`，也不会悄悄回退到 PATH 中的 Node。此前 Linux Electron 44.7.0 的实际二进制探测结果为 Node 24.21.0、SQLite 3.53.4；其他平台必须记录其实际运行结果。最终运行验证还须覆盖 utilityProcess，而不能仅凭版本或 Node 模式探测声称通过。

`apps/desktop/scripts/build.mjs` 用 esbuild 将共享服务及其运行依赖打入 `backend.cjs`，将桌面壳打入 `main.cjs`，复制 `apps/web/dist`。暂存目录与最终 ASAR 均排除 workspace 软链接、`node_modules`、原素材、项目数据库或访问令牌。生产依赖许可证和 checked-in shadcn/ui 的 MIT 许可证一同装入 ASAR 的 `licenses/`。Electron/Chromium 原始通知来自各目标 Electron 分发包：Linux 保持可执行文件旁的 `LICENSE.electron.txt` 和 `LICENSES.chromium.html`；macOS 的 `afterExtract` 钩子在 builder 删除分发包根目录通知之前，将两份原始字节保存到 `.app/Contents/Resources/licenses/`，`afterPack` 再分别核对大小与 SHA-256。这些额外资源不扩大 ASAR 白名单，也不使用构建主机的 Electron 通知替代目标运行时。现有 Linux 专用 `inspect-package.mjs` 仍按原有路径检查最终 ASAR 及实际二进制 fuse 字节。

macOS 通知保护钩子要求目标 framework/config 版本和尚未改写的 `Electron.app/Contents/Info.plist` 版本与根清单 Electron 固定版本一致；正常解包会在钩子前移除根目录 `version`，所以不依赖该文件。输入与输出拒绝符号链接、非普通文件、空文件和超限文件；Electron 通知上限 256 KiB、Chromium 通知上限 32 MiB、原始 plist 上限 1 MiB。版本证据是解包上下文和原始 bundle 元数据，不构成运行时签名认证。2026-10-11 留存的旧 arm64 development/production `.app` 验收仍缺少两份通知，development DMG 也没有重新生成或重新挂载检查；此处源码修复与云端契约测试不能替代新的 Mac 验收。

## 从源码启动

Mac 首次源码试用见 [Mac 源码试用指南](MAC-SOURCE-TRIAL.zh-CN.md) 与 [试用记录表](MAC-TRIAL-CHECKLIST.zh-CN.md)；Mac 原生行为仍未验证。

需要 Node ≥24、pnpm 11.25.0 和可信来源安装的 FFmpeg / ffprobe。Node 与 pnpm 是构建工具要求，发布桌面包的后端不依赖它们。

```sh
pnpm install --frozen-lockfile
node scripts/tooling.mjs doctor
node scripts/tooling.mjs build --channel=development
MIOON_ENABLE_LIVE_PROVIDER=0 pnpm desktop
```

Electron 44 的 npm 分发会在需要时下载官方运行时。构建主机需要能访问 npm registry 及 Electron 官方下载，缓存目录需要可写。Electron npm 安装器实际读取 `electron_config_cache`；electron-builder 可使用自己的 `ELECTRON_CACHE`。受限 CI 还可明确设置 `XDG_CACHE_HOME`、`XDG_DATA_HOME` 和 pnpm store；不要因此关闭 Chromium 沙箱。

未提供或无法验证已保存/环境指定的视频工具路径时，启动会用原生文件对话框要求选择已安装的 `ffmpeg` 与 `ffprobe`。不会自动下载或运行来源不明的二进制。也可由启动者明确给出绝对路径：

```sh
MIOON_FFMPEG_PATH=/usr/bin/ffmpeg MIOON_FFPROBE_PATH=/usr/bin/ffprobe pnpm desktop
```

这两个路径必须指向可执行文件，并通过 `-version` 检查；FFmpeg 还必须提供 `libx264` 和 `aac` 编码器。只有路径会写入 `desktop-config.json`。FFmpeg 是明确的外部依赖，没有捆绑；安装来源、GPL/LGPL 组合及其许可义务由实际采用的 FFmpeg 构建决定。Electron 自带的 `libffmpeg` 仅服务于 Chromium 媒体播放，不代替这里的 FFmpeg CLI。

媒体子进程的最小环境、输出和探测限制、退出时限与恢复语义，见 [MEDIA-RUNTIME.md](MEDIA-RUNTIME.md)。停止本地等待不表示供应商已取消或费用已退还；退出未获确认时不会自动启动第二个本地服务。

## V4.1 应用身份与构建渠道

- 正式版 application / bundle ID：`app.starroy.mioon`
- 开发版 application / bundle ID：`app.starroy.mioon.dev`
- `pnpm desktop:build` 默认构建开发版；`pnpm desktop:build:production` 明确构建正式版暂存产物。之后 `pnpm desktop` 运行刚刚构建的渠道。
- 渠道在构建时写入主进程和 `build/package.json` 的 `mioonDesktop`，启动时不读取 `NODE_ENV`、`MIOON_DESKTOP_CHANNEL` 等环境变量，也不把 `app.isPackaged` 当作渠道。因此开发版打包后仍是 `.dev`。
- `app.setAppUserModelId`（Windows）、Linux desktop name / WM_CLASS 与打包 ID 保持一致；macOS bundle ID 来自 builder 配置，尚未实机验证。
- 开发版系统应用名称/可执行文件增加 Dev / `-dev` 以便并存；界面统一为 Mioon，npm workspace 为 `@mioon/*`，CLI 为 `mioon`，不提供旧命令别名。
- 打包前检查暂存渠道，拒绝把开发版暂存目录当成正式版，或反过来。源码版本为 `0.4.1`。

## 数据位置与单实例

- Linux 正式版：Electron appData 下的 `app.starroy.mioon/`，通常是 `~/.config/app.starroy.mioon/`
- Linux 开发版：通常是 `~/.config/app.starroy.mioon.dev/`
- macOS 正式版：`~/Library/Application Support/app.starroy.mioon/`；开发版为同层 `app.starroy.mioon.dev/`，此平台尚未实机验证
- Windows 使用 Electron 的 appData 路径，通常为 `%APPDATA%\app.starroy.mioon\` / `%APPDATA%\app.starroy.mioon.dev\`；此平台尚未实机验证
- 项目数据库和托管媒体位于上述目录的 `workspace/`
- Chromium 缓存/配置与业务 `workspace/` 分开；认证 cookie 使用内存 session，不写到 Chromium 持久 cookie 库
- `MIOON_DESKTOP_USER_DATA` 可明确覆盖整个桌面数据目录，必须是绝对路径；每个渠道应使用独立目录。`desktop-identity.json` 私有标记会拒绝已属于另一渠道的目录，不会自动覆盖或改写标记

本地目录的隐私校验、旧目录拒绝时的数据保留与恢复方式，见 [PRIVATE-STORAGE.md](PRIVATE-STORAGE.md)。Q2 不会自动修改已有目录的权限或所有者；Windows ACL 尚未实现，不能以 `0600` / `0700` 数值代替 Windows 原生校验。
- 正式/开发版的数据库、工具配置、Chromium 状态、单实例锁、connection descriptor 和令牌默认隔离；同一渠道再次启动会聚焦原窗口

应用采用 Electron 单实例锁，业务数据库仍有独立单写者锁。再次启动会聚焦已有窗口。默认数据目录与下载目录、源码目录、当前工作目录、安装包目录均无关；换版本不会因此丢失项目。正常退出后再整体备份 `workspace/`，包括媒体，不只复制 SQLite 文件。旧 Web 版数据可以在服务停止后复制到新桌面 `workspace/`；本版本不会自动移动原目录，也没有在用户 Mac 上执行任何迁移。

V3/V4 原来的 `video-workbench/` 目录原封不动保留。V4.1 首次启动默认打开新渠道目录，旧项目不会自动出现，也不会被删除。要保留项目，请先正常退出旧/新应用并备份整个旧 `workspace/`，再使用下面的复制助手。Linux 旧数据通常来自 `~/.config/video-workbench/workspace`，macOS 旧数据来自 `~/Library/Application Support/video-workbench/workspace`。目标是所选新渠道中尚不存在的 `workspace/`。如果新版本已创建目标 workspace，选择全新的 `MIOON_DESKTOP_USER_DATA` 目录；不要覆盖、删除或合并已有项目。工具路径需重新选择，不复制旧 Chromium 配置或凭据。迁移完成后也保留旧数据，确认项目和媒体完整后再由用户决定如何归档。

提供明确执行的源码迁移助手（需要 Node ≥24）。先正常关闭两边应用，再指定旧数据目录与尚不存在的新 `workspace/` 路径：

```sh
node apps/desktop/scripts/migrate-data.mjs --source=/absolute/old/data --destination=/absolute/desktop-user-data/workspace
```

助手只复制数据库与托管媒体，在副本应用同一份迁移并执行 `integrity_check`；不会修改或删除源目录，不复制访问令牌、服务锁或 Chromium 配置。源服务锁、未 checkpoint 的 WAL、符号链接或已存在的目标目录都会导致拒绝。不要覆盖已有桌面项目；先保留完整备份并选择新目录。

## 安全边界

- 全局 `app.enableSandbox()`，窗口明确启用 `sandbox`、`contextIsolation`、`webSecurity`
- 禁用 Node integration（含子 frame 和 worker）、WebView、实验性特性及不安全混合内容
- 没有 preload，也没有 renderer IPC bridge；页面拿不到 Electron、`fs`、shell、任意本地路径或 bearer token
- 主进程为每次服务启动生成随机令牌，只经主进程→utilityProcess 消息传递；在加载 UI 前安装 `Secure; HttpOnly; SameSite=Strict` 的 session cookie
- HTTP 只绑定 `127.0.0.1` 的随机端口。cookie 利用 Chromium 对 loopback 的可信来源处理；这不是公网 TLS 服务，不应暴露、转发到公网或宣称可抵抗同一 OS 用户权限下的恶意进程
- 浏览器请求只允许当前本地服务 origin 和同源 blob；外部链接、跳转、弹窗、子 frame、WebView 全部阻止。没有任意 `shell.openExternal`
- 权限请求、权限检查、设备访问及屏幕捕获默认拒绝。普通 HTML 文件选择只导入用户实际选中的文件内容
- 导航只允许根页面与一个 UUID 格式的 `?project=` 项目参数；登录凭据不会放在 URL 或 Web storage
- 后端统一提供 CSP，脚本只允许本地打包资源，禁止对象嵌入，限制连接与 frame 嵌入
- 下载只接受当前窗口、当前后端的 UUID 托管 MP4，禁止跨来源重定向链；使用原生 Save As/覆盖确认，不接受 renderer 给出的磁盘路径，不自动打开成片
- 构建使用 ASAR，关闭 RunAsNode、NODE_OPTIONS、Node CLI inspector 和 file 协议额外权限，并限制只从 ASAR 加载。ASAR 完整性校验在 macOS/Windows 有平台支持，不能把 Linux 的 ASAR 宣称为防篡改签名
- 打包不启用自动更新或发布；`--publish never`。开发 smoke 不开启调试端口，固定测试入口在 `app.isPackaged` 时禁用

Loopback token 与 OS 账户权限共同构成本地单用户信任边界。本应用不是多用户隔离服务器，也不是针对恶意系统管理员的沙箱。

## 启动、退出与恢复

主进程等待 utilityProcess 就绪、验证它返回的 loopback origin，再创建已认证窗口。启动超时或服务失败会显示本地错误，不会留下永远等待的空白窗口。正常关窗先通过一个固定、无特权的页面函数排空视图偏好的同源 HTTP 保存，最多等待 1.5 秒。失败或超时会询问“仍然退出 / 继续编辑”；选择继续编辑会保持窗口和后端运行。此函数不暴露 IPC、Electron、文件系统或令牌。随后仍执行原有未保存属性草稿确认，窗口真正关闭后才停止服务。

正常停止先中断操作，再等待已持有句柄的本地媒体进程退出，随后关闭 worker、HTTP、SQLite 并清理 discovery。媒体停止尝试最多 3 秒，worker/server 最多 5 秒，utility 停止尝试最多 13 秒；未确认退出时返回明确失败，不能把发送信号当作回收成功。仍有准确句柄时应用继续等待实际退出，不承诺整个应用一定在 13 秒内关闭。utility 意外退出后，记录的数字 PID 不足以证明进程归属，因此不会据此杀进程；媒体清理不明时阻止该应用内自动替换/重启，并提供明确的“退出应用”警告。退出后的新应用生命周期无法证明旧媒体进程已结束，再次工作前可能需要用户在系统任务管理器中检查。

服务崩溃时提供原生“重启本地服务/退出”选择。重启使用新端口/新令牌并重新载入同一数据目录；未保存界面状态可能丢失。渲染进程崩溃可单独重新载入，后台保持独立。原有视频生成任务按已知远端任务继续查询，提交结果未知的任务先对账，不因 Electron 重启自动重发收费请求。Images/ComfyUI 采用各自的结果恢复规则；ComfyUI 重启后不会自动查询或再次 POST，需要显式观察同一已保存任务。被中断的本地时间线渲染重新排队，旧结果文件保持不可变。utility 另有 30 秒主进程心跳租约。历史无活动媒体的 utility 崩溃恢复与当前正常退出证据，不代表活动媒体异常退出的自动回收能力；旧的“崩溃后按 PID 杀媒体并自动恢复”验收已撤销。操作系统同时强杀整个进程树也可能绕过清理方；原生 macOS/Windows 与异常孤儿进程恢复仍需专项验收。

macOS 关闭最后一个窗口时保留应用与后端；Dock 激活重新打开窗口，明确退出才关闭服务。此行为已写入源码，但仍需 macOS 实机验证。发布升级、正式签名和公证仍未完成。Agent 与官方/自定义 Images 专用设置及 Electron safeStorage 接入已实现；密钥保持独立绑定，不向 renderer 返回密钥，不用一个配置槽静默替换另一个。ComfyUI 有独立无密钥连接设置。真实 macOS Keychain 可用性/拒绝/重启兼容尚未原生认证；9e基线使用同步 safeStorage；本次整合候选的 macOS 路径使用官方异步 API，超时/失败不回退同步，真实 Keychain 仍待验证。Linux 保留原四类强 keyring 同步路径和旧密文，客户端超时不能解除其主线程阻塞；Windows 仍 fail-closed。候选详情见 [Keychain 异步边界](KEYCHAIN-ASYNC-CANDIDATE.md)。安全存储不可用时仅允许明确的 session-only 模式，不回退到明文持久化；Agent 会话密钥在主进程关闭时丢失，Images 会话密钥在其 backend 生命周期结束时丢失。

本地编辑协调账本当前覆盖 16 类固定操作：原有时间线/首帧连接十二类，加 `subject.create`、`subject.version.add`、`subject.binding.set`，以及 `timeline.format.set`。启动或列表读取不会自动执行；其余八类画板/素材编辑和 `timeline.render` 等保持各自原有恢复边界。Images/ComfyUI 的审批与结果恢复是独立任务语义，不通过这份编辑账本执行。详见 [任务恢复契约](TASK-RECOVERY.md)。

## 项目视图记忆

画板/剪辑模式、选择、缩放、播放头、滚动与面板状态保存在当前渠道的 `workspace/` 数据库独立表中。重新打开同一项目可恢复，包括正常完全退出后重启；这不保存全局最后打开的项目。浏览器与桌面连接同一个后端时共享该项目的本地单用户视图，并以独立版本防止旧窗口覆盖。认证 cookie 和 Chromium session 仍不持久化，没有增加 preload 或 renderer 到原生的桥接。

草稿、搜索文本、任务、媒体和凭据均不属于视图偏好。强杀、崩溃、后端不可用或明确选择退出未保存视图时，最后未确认的视图变化仍可能丢失。详见[工作区偏好契约](WORKSPACE-PREFERENCES.md)。

## MCP 接入桌面服务

桌面服务就绪后，在桌面数据目录生成 `mcp-connection.json` 和 `mcp-token`，两个文件均为 `0600`。descriptor 包含版本、动态 URL、令牌文件路径、utility PID 及非敏感 `appId` / `channel`；令牌独立保存。正常停止时清理，重启时旋转。不要分享这两个文件或把令牌复制到聊天。

默认 Linux 正式版 descriptor 为 `~/.config/app.starroy.mioon/mcp-connection.json`，开发版为 `~/.config/app.starroy.mioon.dev/mcp-connection.json`；macOS 使用上述 Application Support 对应目录。使用环境变量时应写展开后的绝对路径（例如 shell 中用 `$HOME`），不要在 JSON/TOML 中把 `~` 当作已展开路径。迁移后请明确更新 CLI/MCP 连接配置，旧路径不会自动重定向，不会在两个渠道间静默回退。

MCP bridge 可以配置 `MIOON_CONNECTION_FILE` 指向所选渠道的 descriptor；每次工具调用重新读取，因此能跟随桌面端口和认证轮换。它通过同一 HTTP service 工作，不另开 SQLite、worker 或第二套业务服务。客户端配置和 Node CLI 要求见 `docs/MCP.md`。

视频供应商配置只允许明确列出的服务端环境变量传入 utility，包括 `RUNWAYML_API_SECRET`、`MIOON_ENABLE_LIVE_PROVIDER`、授权素材哈希、输出域名和额度门槛；不会传到页面。Agent/Images 使用各自专用设置与授权边界，不依赖该视频环境开关作为总开关。首次源码试用只用模拟供应商与原创合成素材，不填写真实密钥，不启用 Agent、官方/自定义 Images 或 ComfyUI，也不点击会联网的连接检查。

## 本地打包

```sh
pnpm build
# 正式版
pnpm desktop:package:linux
# 可安装并存的开发版
pnpm desktop:package:linux:dev
# 仅生成解包目录
pnpm --filter @mioon/desktop package:dir
pnpm --filter @mioon/desktop package:dir:dev
```

正式版输出在 `release/desktop/production/`，开发版在 `release/desktop/development/`：Linux x64 解包目录及 `tar.gz`。两个渠道输出互不覆盖，旧 `release/desktop/` 历史产物保持原样。压缩包中包含 Electron / Node / SQLite / 页面 / 后端；解包后运行正式版 `mioon` 或开发版 `mioon-dev`，仍需外部 FFmpeg / ffprobe。必须在支持 Chromium 沙箱的非 root Linux 图形会话中运行。若系统策略阻止用户命名空间或沙箱辅助程序，保持安全失败，不添加 `--no-sandbox` 或静默降级。

`pnpm --filter @mioon/desktop package:mac` 与 `package:mac:dev` 先通过 tooling 串行构建 Web 和对应渠道，再运行 builder（`--publish never`）；不能并行共用 staging。`apps/desktop/electron-builder.cjs` 与 `.dev.cjs` 配置 macOS arm64/x64 DMG，目前 `identity:null`，没有已验证的签名/公证、Gatekeeper 或安装升级结果，不能将构建成功称为可分发认证。入口依据见 [打包入口说明](PACKAGE-ENTRYPOINTS.md)，平台门槛见 [发布门槛](PLATFORM-RELEASE-GATES.md)。

## 验证

```sh
pnpm test:desktop
MIOON_FFMPEG_PATH=/usr/bin/ffmpeg MIOON_FFPROBE_PATH=/usr/bin/ffprobe pnpm --filter @mioon/desktop smoke
```

Q3 当前媒体环境/退出验收与原生限制见 [MEDIA-RUNTIME.md](MEDIA-RUNTIME.md)。以下 V4 记录属于历史基线，不能当作当前异常媒体清理能力；旧的活动渲染崩溃回收项在 smoke 报告中已改为明确 skippedChecks。

单元测试覆盖 origin/导航/下载白名单、无 Node/IPC 窗口设置、cookie 属性、权限拒绝、私有 discovery、环境隔离、启动超时、异常退出、媒体子进程所有权和取消未保存退出。

固定 Electron smoke 在隔离临时 userData 中检查真实 utility Node/SQLite、真实沙箱 renderer、Secure cookie 自动认证、匿名请求拒绝、网络/窗口/权限阻断、项目持久化、普通重启与 SIGKILL 恢复，并写本地 JSON 报告及实际窗口截图。不会调用真实供应商。受限 shell 的一次 headless 探测被宿主 `socket() Operation not permitted` 阻止；没有绕过任何沙箱。图形会话验证及最终结果见 `STATUS.md` 与相应验收证据。

在自己的 Linux 图形会话中，扩展 smoke 已通过 19 项检查：包括真实 10 秒分层合成、活动 FFmpeg 期间的 utility SIGKILL 清理/恢复、正常中断/恢复、实际 renderer `beforeunload` 取消退出，以及 720×1280 成片在第 3 秒成功解码后截图。证据为 `evidence/v3-desktop/smoke.json`、`electron-workbench.png`。

历史 V3 打包黑盒验证针对 `release/desktop/linux-unpacked/video-workbench`，检查空 PATH 启动、捆绑 utility、正常 HTTP 渲染与原生退出；历史证据保留在 `evidence/v3-desktop/`，不是当前 Mioon 构建的验证。

当前 `apps/desktop/scripts/packaged-qa.mjs` 默认检查正式渠道 `release/desktop/production/linux-unpacked/mioon`；传入 `--channel=development` 检查开发渠道的 `mioon-dev`。`inspect-package.mjs` 使用相同渠道参数检查该渠道的包、归档和当前暂存构建，报告写入 `evidence/mioon-desktop/<channel>/`。只有显式 `--historical-v3` 才检查未改动的旧 0.3.0 归档，且不与当前暂存构建比较；报告为 `evidence/mioon-desktop/historical-v3-inspection.json`。这些脚本没有启用 smoke bridge 或远程调试。本次更名修改了脚本入口，但没有构建安装包或运行上述打包版检查。

历史 V3 Linux x64 打包黑盒测试通过 6 项：ASAR 启动、捆绑 utility 身份、迁移项目、真实多轨 MP4、匿名拒绝、正常原生退出清理。`packaged-qa.json` 记录完成状态，`packaged-electron-preview.jpg` 是原生窗口检查截图。最终 `tar.gz` 已通过 gzip 完整性检查，内含 ASAR 哈希与这个实测目录一致；打包检查记录 SHA-256。macOS 仍只交付配置，未验证。

## 官方依据

- [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron session and permissions](https://www.electronjs.org/docs/latest/api/session)
- [Electron cookies](https://www.electronjs.org/docs/latest/api/cookies)
- [Electron beforeunload handling](https://www.electronjs.org/docs/latest/api/web-contents#event-will-prevent-unload)
- [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)
- [electron-builder v26 fuse integration](https://www.electron.build/v26/docs/tutorials/adding-electron-fuses/)

## V4 provider and agent additions

V4 最初桌面源码版本为 0.4.0；V4.1 身份补丁为 0.4.1。utility 的显式环境白名单新增 ARK、GEMINI/VEO、MINIMAX 和 VIDU 配置；名单由 provider registry 维护，仍不继承任意环境或将密钥发送到 renderer。MiniMax/Vidu 的区域只接受 `global` / `cn`，不会跨区切换；Vidu 还必须配置经核实的精确输出主机。

CLI 与 MCP 都可使用同一 `MIOON_CONNECTION_FILE`，每次请求重新读取，跟随桌面端口/令牌轮换。Web 模式还支持 `MIOON_BASE_URL` + `MIOON_TOKEN_FILE`。连接与命令见 CLI.md / MCP.md。应用的 Node 来自 Electron；源代码 CLI/MCP 仍需客户端电脑安装 Node ≥24 和工作区依赖。当前应用/CLI/MCP 实现元数据为0.4.1；后端 `/health` 兼容版本仍为0.4.0，MCP协议日期和descriptor版本独立，不能混用。

上文 V3 的 19 项/6 项及 `0.3.0` Linux 归档是历史证据，不含新适配器。本轮 V4 的 fresh development-runtime smoke 与实际源码验收以 ACCEPTANCE-V4.md 为准。旧包保持原样，未声称其已更新；没有重建/发布安装包或做 macOS 实机验证。

V4.1 的渠道、隔离、迁移和本轮验证记录见 [ACCEPTANCE-V4.1.md](ACCEPTANCE-V4.1.md)；历史 V3/V4 证据不等于本轮重跑。

## 2026-10-11 桌面收口：运行时通知、窗口归属和抽帧详情

本片基线为 `cb864f68af1d0e20663404151afd2c09d5051c3c`。改动只涉及构建时运行时通知保留、桌面窗口生命周期，以及抽帧结果卡的审计详情展示；没有修改项目/任务 schema、业务服务、供应商或媒体原始字节。

- macOS 通知从 builder 正在处理的目标发行包读取，先验证锁定 Electron44.7.0、目标上下文和原始 Info.plist，再分别有界读取 `LICENSE`（≤256KiB）、`LICENSES.chromium.html`（≤32MiB）；plist≤1MiB。拒绝缺失、空文件、非普通文件、符号链接/硬链接、超限、既有目标和版本不符。保存到目标 `.app/Contents/Resources/licenses/` 后，清理/重命名完成还要逐文件比较原大小与 SHA-256。不会从构建主机静默替代另一个目标的通知，也不会放宽既有 ASAR 检查上限。这是通知文件保留检查，不是完整法律合规审计。
- 桌面窗口上下文只在当前服务、认证 cookie 和连接发现均就绪后发布；停止/重启先撤销旧上下文。activate、ready-to-show、closed、导航结果和 renderer 错误对话框均绑定确切窗口/上下文；旧窗口的迟到回调不能显示、关闭、清空或压住新窗口的恢复提示。已有启动取消标记与真实清理错误路径保留。macOS 特有 activate 时序由当前真实 main/supervisor 函数的合成边界测试覆盖，尚未在 Mac 上重验。
- 抽帧结果卡默认显示可读名称、时间点、尺寸、状态和来源；完整源/结果 UUID、SHA、任务/请求标识及配置放在原有“源文件与请求记录”展开区。原控制、草稿守卫和请求身份不变；展开状态只是当前原生 details 元素的临时界面状态。

当前验收：锁安装复用393个缓存包，官方 registry 元数据468项供应链检查通过；没有更改 lockfile 或放宽策略。受影响检查341/341通过（0失败/跳过）；fresh development Web/desktop 构建通过。实际 Linux 图形会话使用未修改的最终 bundle，验证默认折叠、展开七项审计值、空格键折叠、正常服务重启后唯一替代窗口和新的服务 PID/origin、正常退出code0。业务表与原媒体 SHA 在重启/退出前后保持；连接发现文件和令牌正常清理。没有把 Linux 普通重启当作 Mac activate 竞态原生认证。

本轮真实 Linux x64 开发渠道解包构建成功，原 Electron `LICENSE`→`LICENSE.electron.txt` 为1096bytes、SHA `5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d`；Chromium 通知为20,115,518bytes、SHA `3375e2a9bd7bc631738fde10be6548a76efe8cf5e4b8826b8140ba8b0c4d6353`，都与锁定原发行包字节相同，源 Electron 二进制未改动。该解包产物没有另做启动/安装测试；实际原生启动针对上面的源码 development bundle。

历史 Mac arm64 双渠道 `.app` 检查曾确证两份通知丢失；本片在 Linux 合成 Mac 目标布局上验证修复钩子、x64/arm64 与双渠道边界，未重新构建或运行 Mac 包。Mac 会话按用户要求保持停止；签名、公证、传统安装升级和 Windows ACL 门槛仍未由这片验收解决。

保留的前置失败：旧隔离工作树初测22项通过、两个窗口测试文件因尚无 workspace 依赖而未加载；第一次默认缓存安装遇不存在的用户 home，指定既有 store 的离线安装因缺 registry 元数据被供应链门槛拒绝。之后才使用官方 registry 完成同一 frozen lock 安装与上面的完整检查。前片白/蓝绘制异常在本轮未重现，但未查明原因，不能据此宣布修复。最终父级独立全量实际 exit0：3558项，3556通过、0失败、2跳过，576875.394504ms；此结果单独记录，不以 focused 检查替代全量门槛。
