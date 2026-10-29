# Mioon 平台试用与正式发布门槛

审查日期：2026-10-10（Asia/Taipei）。源码基线：`4e66a9621babc4b1b8aed4d03685bbf15eb747d3`。

本次为固定快照的发布配置审查和后续方案，仅新增本文，不改变运行时、打包或安全策略。隔离工作树为 `~/Documents/data/mioon-dot-release-c156c85f`，分支为 `dot/platform-release-gates-c156c85f`；开始时根目录、分支、HEAD 均匹配，工作区干净，本文不存在。本文不是发布授权或原生验收报告。

结论：macOS 两种架构已有 DMG 配置和开发/正式渠道隔离，但正式渠道仍跳过签名，未形成可放行的签名、公证及原生包验收链。Windows 缺少明确的项目打包目标，且 ACL 后端未实现，当前本地工作区启动会被拒绝。FFmpeg/ffprobe 继续由用户单独提供。

| 目标 | 开发试用状态 | 正式发布状态 |
| --- | --- | --- |
| macOS arm64 | 可安排隔离源码试用；本次未运行 | 阻塞：正式签名策略待补齐；安装包、公证及原生 QA 未验证 |
| macOS x64 | 可安排隔离源码试用；本次未运行 | 与 arm64 分别验收；不能由 Apple Silicon 或 Linux 结果推定通过 |
| Windows | 私有存储 ACL 门槛阻止本地桌面和本地 Web 工作区启动 | 阻塞：先实现安全存储，再建立明确包目标和原生发布验收 |

这里的“可安排”不承诺当前 Electron 二进制、操作系统版本或工具组合已在目标机正常运行；“未验证”也不等于已观察到运行失败。历史 Linux 证据不转记为本基线的 Mac/Windows 通过。

## 1. 已核实的脚本和配置引用

根与桌面应用版本均为 `0.4.1`，根清单固定 Electron `44.7.0`、electron-builder `26.15.3`。`apps/desktop/build-metadata.ts` 检查版本一致和精确 Electron 版本；这不校验目标平台实际二进制能否运行。

| 入口/引用 | 实际行为及证据 |
| --- | --- |
| `pnpm desktop:build` / `pnpm desktop:build:production` | 根 `package.json` 转发桌面 workspace；无参数默认 development，见 `apps/desktop/identity.ts` |
| `pnpm desktop` | 根 `package.json` → `apps/desktop/package.json` 的 `electron build`；运行最近一次 staging 的渠道，不固定为开发版 |
| `pnpm --filter @mioon/desktop package:mac` | `apps/desktop/package.json`：production staging → `.generated/electron-builder.cjs --mac --publish never` |
| `pnpm --filter @mioon/desktop package:mac:dev` | `apps/desktop/package.json`：development staging → `.generated/electron-builder.dev.cjs --mac --publish never` |
| 两份 builder 入口 | typed `apps/desktop/builder-config.ts` 由 `apps/desktop/scripts/prepare-builder-config.ts` 打包为忽略目录中的 `apps/desktop/.generated/electron-builder.cjs` / `electron-builder.dev.cjs`（渠道固定为 production/development）；`apps/desktop/scripts/build.ts` 在暂存构建时自动重新生成 |
| macOS 架构和产物 | `apps/desktop/builder-config.ts` 配置 `dmg`，架构数组为 `arm64`、`x64`，文件名包含 `${arch}`；没有配置 universal 目标 |
| Windows 入口 | `apps/desktop/package.json` 没有 Windows 打包脚本；`builder-config.ts` 只有 linux/mac 平台配置。不能把 builder 的潜在默认目标当作项目已支持的 Windows 发行格式 |
| 完整源码构建入口 | `scripts/lib/local-tooling.ts` 依次构建 Web 与桌面 staging；它没有调用 electron-builder，也不签名、公证或生成 DMG |

以上命令用于定位已有入口，本次均未执行。根清单没有 Mac 打包 alias，不能将 `pnpm desktop:package:mac` 写作已存在命令。

## 2. 有代码依据的发布缺口

### R1：正式 Mac 配置明确跳过签名，不能作为正式发布入口放行

**证据：** `apps/desktop/builder-config.ts` 对两个渠道都设置 `hardenedRuntime:true`、`gatekeeperAssess:false`、`identity:null`，并注明 unsigned production；生成的 CJS 入口来自同一 typed 配置。全配置 `builder-config.ts` 没有强制签名、公证成功或票据校验的发布门槛；相关桌面脚本没有项目自有的签名/公证 hook。

**影响：** 使用当前 `package:mac` 不能据其成功退出宣称 Developer ID 签名、公证或 Gatekeeper 已通过。electron-builder v26 明确将 `identity:null` 定义为跳过签名；`hardenedRuntime:true` 本身不构成有效签名。[electron-builder v26 macOS 配置](https://www.electron.build/v26/docs/mac/)

**修复方向：** 后续为正式发布建立缺失签名身份或公证失败即停止的配置与验证步骤，保留 Hardened Runtime、现有 sandbox 和 fuses。使用经授权的 Developer ID 身份，核验主程序、frameworks/helpers 的有效签名、实际 entitlements、时间戳、公证日志和 stapled ticket，并对最终交付物执行 Gatekeeper 验收。Apple 的直接分发流程要求有效 Developer ID 签名及相应公证条件。[Apple 公证说明](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)

**判断边界：** `gatekeeperAssess:false` 是构建签名工具的校验选项，不是关闭用户系统 Gatekeeper 的代码。缺少显式 `notarize` 或自有 entitlements 文件，不足以证明 builder 默认机制不能工作：v26 可根据受保护环境凭据启动内置公证，签名工具也可能提供默认 entitlements。当前可确认的是跳过签名和缺少正式放行证据，不能臆测实际签名失败日志、账户状态或机器证书。本次未读取这些信息，也不建议通过关闭 Hardened Runtime、移除隔离属性或扩大权限绕过验收。

### R2：Windows 存储是明确的启动阻塞，新增安装包配置不能解除它

**证据：** `packages/contracts/src/private-storage.ts:33–55` 在 Windows 报告 `WINDOWS_ACL_UNIMPLEMENTED` / `STORAGE_PRIVACY_UNAVAILABLE`。预留的 `windowsAclVerifier` 即使返回成功，也不能授权文件操作；私有创建和 reparse-safe 访问尚未实现。

桌面调用链为 `apps/desktop/src/main.ts:26` → `config.ts:27–40` → 私有存储策略；失败后走 `main.ts:241–243` 的错误分支，先于正常启动及单实例锁。本地 Web 同样在 `apps/server/src/index.ts:69–83`、`packages/business/src/db.ts:29–49` 验证工作区，不能用浏览器入口绕过。

**影响：** 这同时阻塞 Windows 日常本地试用和正式发布；POSIX `0600/0700`、更换目录或系统密钥加密不能代替 ACL 后端。没有 `win` 配置是另一个发行流程缺口，不代表 electron-builder 本身不支持 Windows。

**修复方向：** 独立实现和原生验证当前用户身份/所有权、有效 ACL 与继承、无公开中间态的私有创建、reparse point/文件身份检查及原子写入；用第二个 OS 用户和错误 ACL 验证实际拒绝访问，并保留已有文件。随后再确定 Windows OS/架构、安装格式、签名及 per-user 安装策略。本文不授权修改该共享契约或存储实现。

### R3：现有包检查和测试通道不能认证 Mac/Windows 产物

**证据：** `apps/desktop/scripts/inspect-package.ts` 固定 `linux-unpacked/resources/app.asar` 和 Linux 可执行文件；`:46–63` 固定 `linux-x64`、`tar.gz`、`gzip`/`tar`。它对 ASAR、fuses、文件来源和哈希的检查值得保留，但路径及归档部分不是跨平台实现。

`scripts/lib/local-tooling.ts` 的默认 portable 清单为 `PORTABLE_TEST_FILES`（当前九个文件）；其 `discoverTests` 在非 Linux 拒绝 full。`scripts/tooling.ts` 将这一拒绝映射为退出码 2；更早的依赖前置检查失败可能先返回 1。`nativeReadiness`（`scripts/lib/local-tooling.ts`）固定 `ready:false`，Mac 是 unverified，Windows 是 blocked。普通 doctor 返回 0 只说明其检查的前提成立，见 `scripts/tooling.ts` 的 doctor 分支。

**影响和方向：** 后续为 `.app/Contents/...`、DMG 以及明确选定的 Windows 安装格式提供各自检查器与原生测试通道。复用现有内容校验逻辑，单独处理包布局、架构、签名和安装行为。不能直接取消 full 的平台保护、将 skipped 记为 passed，或硬改 `nativeReadiness` 掩盖缺少证据。

### R4：打包入口不保证 Web 产物新鲜度，渠道共用 staging 需串行

**证据：** `apps/desktop/package.json` 只调用 desktop build 和 builder；`apps/desktop/scripts/build.ts` 只要求已有 `apps/web/dist/index.html`，然后删除并重建共用的 `apps/desktop/build`、复制现有 Web dist。`builder-config.ts` 与 `build-metadata.ts` 校验暂存版本/渠道/package 元数据，没有校验 Web dist 对应的源码哈希。

**触发条件和影响：** 若修改 Web 源码后直接运行打包入口，旧 dist 仍存在时，可能把旧界面与新桌面/后端一同打包；这不是已观察到的坏包。若同一 checkout 并行构建两个渠道，共用 staging 可能被另一构建删除或改写。输出目录分开不能消除这一共享输入。

**最小处理：** 后续流水线按同一源码快照串行完成 Web → desktop → 包检查，绑定 staging/ASAR/最终产物哈希；多渠道构建串行执行或使用独立 checkout。现有 `tooling.ts build --channel=...` 已提供前两步顺序，无需引入新构建框架。完整性 gate 完成前，不把 `beforePack` 的元数据通过等同于整个产物来自同一源码。

## 3. 已有保护与分发边界

### 应用身份和用户数据隔离

| 项目 | production | development | 源码依据 |
| --- | --- | --- | --- |
| appId | `app.starroy.mioon` | `app.starroy.mioon.dev` | `apps/desktop/identity.ts` |
| 产品名 / executableName 配置 | `Mioon` / `mioon` | `Mioon Dev` / `mioon-dev` | 同上；最终平台内的文件名仍须检查实际包 |
| 默认 userData | `appData/app.starroy.mioon` | `appData/app.starroy.mioon.dev` | `apps/desktop/src/config.ts:18–22` |
| 默认业务目录 | 各自 userData 下的 `workspace` | 同左 | 同上 |
| 包输出 | `release/desktop/production` | `release/desktop/development` | `apps/desktop/builder-config.ts` |

macOS 默认 appData 预期对应 `~/Library/Application Support`，Windows 通常对应 `%APPDATA%`；这是 Electron 路径约定及仓库说明，尚未在本次目标应用中观察。运行时应记录 `app.getPath` 的实际值，不只抄写预期字符串。

渠道经 `apps/desktop/scripts/build.ts:20,25–26` 固定到 bundle 和暂存元数据，`apps/desktop/src/main.ts:17–26` 使用该身份；不会因 `app.isPackaged` 自动把开发包转成正式版。`config.ts:20,111–144` 要求覆盖路径绝对，并以 `desktop-identity.json` 拒绝跨渠道复用。不能删除 marker 来完成试用；两个架构的同一渠道也不会自动得到不同 userData，跨架构试验必须自选新的隔离目录。

`builder-config.ts` 已设置限制 Node 注入和调试的 fuses；`apps/desktop/src/main.ts` 启用 sandbox。这些是源码配置，不是已检查最终可执行文件的 fuse 结果。`apps/desktop/src/secret-store.ts` 使用可用性检查和 appId 绑定的加密封装，但不证明真实 Keychain/Windows 安全存储已通过，也不表示整个 SQLite/媒体目录已加密。

Mac app menu、Dock activate、最后窗口关闭后保持运行、正常退出协调已有实现（`main.ts:192,242–250`）；保留该语义并逐平台验收，不把它当新增设计需求。

### FFmpeg / ffprobe

**当前边界已明确：** `apps/desktop/src/main.ts:35–61` 从已保存配置/环境覆盖读取工具路径，失败时要求原生文件选择；`:48` 明示不捆绑 FFmpeg。`config.ts:147–185` 检查绝对路径、实际文件、执行权限、版本前缀及 `libx264`/`aac`，`:188–190` 仅保存工具路径。通过后才启动后端（`main.ts:70–84`）。

`builder-config.ts:14` 和 `apps/desktop/scripts/build.ts:17–28` 未携带 FFmpeg/ffprobe CLI，且未配置额外媒体二进制资源。Electron 自带播放库不能视为导出所需 CLI，参见 [桌面说明](DESKTOP.md)。实际预览、解码、导出、取消与退出仍须在各目标架构验收；仅 `-version` 或编码器列表通过不够。模拟视频使用 `drawtext`（`packages/business/src/providers/mock.ts:153`），其滤镜/字体能力也需真实本地验证。

安装包仍不携带 FFmpeg。macOS 另提供用户明确选择的下载：`.github/scripts/build-media-tools.ts` 从固定哈希的源码静态构建，`.github/workflows/media-tools.yml` 签名公证，应用只接受 `apps/desktop/src/media-tools.ts` 固定的文件，来源、哈希、布局、动态库、签名、更新与许可材料的处理见 [视频工具说明](MEDIA-TOOLS.md)。其余平台继续维持外部依赖，记录来源、版本、架构、构建选项与所需编码器。若后续另行决定捆绑，则必须独立处理可信来源/哈希、各平台布局、动态库依赖、签名、更新及许可证材料。现有 `apps/desktop/scripts/build.ts:28–59` 收集 JS 依赖 notices，不能证明未来携带的 FFmpeg 已获分发许可或材料齐全。FFmpeg 官方说明许可证取决于构建选项，并特别列出 libx264 的 GPL 相关性；不能把当前编码器要求简化为所有构建都仅 LGPL，也不在此推断 Mioon 的整体许可归属。[FFmpeg 许可说明](https://ffmpeg.org/legal.html)

## 4. 开发试用验收表

此表用于未来明确安排的隔离试用；本次 UI、native、build、测试套件和媒体命令均未运行。Mac arm64 与 x64 各填一份，Windows 先完成 R2；不得为通过试用关闭系统或应用安全检查。

| 门槛 | 必须取得的证据 | 本次状态 |
| --- | --- | --- |
| D1 环境和快照 | 源码 SHA、OS 版本、CPU/进程架构、Node/pnpm/依赖版本；选定该平台实际支持的 Electron/媒体工具组合 | 只静态确认清单版本；目标组合未运行 |
| D2 源码构建 | 同一快照顺序构建 Web 与 development staging，保留命令、退出码和产物哈希；portable 结果单独标注范围 | 未运行 |
| D3 私有目录与渠道 | 使用不存在的新试用目录；检查实际 userData、marker、workspace、单实例行为，错误权限/跨渠道目录无损拒绝 | 代码已核对；Mac 未运行，Windows 阻塞 |
| D4 本地功能闭环 | 新建合成素材项目；导入、播放、剪辑、预览、真实 MP4 导出、原生另存为与重新播放；核对输出时长/帧率/音轨和来源哈希 | 未运行 |
| D5 外部工具故障 | 缺失/错误工具、无必要编码器、中文和空格路径、目标架构/动态库问题有明确错误；正常工具完成实际渲染 | 未运行 |
| D6 原生生命周期 | Mac 关窗→Dock 重开、Cmd+Q；保存草稿、正常退出重开、后端/媒体停止及锁释放；Windows 后续验证其自身关闭行为 | 代码存在；未运行 |
| D7 重启恢复 | 在自有合成项目测试正常重启和受控故障，记录已保存编辑/任务一致性、未知结果保留及无盲目重提交 | 未运行 |
| D8 网络和数据范围 | 首次试用不提供真实密钥、不调用模型/供应商、不迁移用户数据；仅本地模拟流程 | 本次未启动应用或调用供应商 |

`MIOON_ENABLE_LIVE_PROVIDER=0` 不应被解释为所有模型联网功能的总开关；首次试用保持模型与供应商未配置。已有 [Mac 源码指南](MAC-SOURCE-TRIAL.zh-CN.md) 和 [原生记录表](MAC-TRIAL-CHECKLIST.zh-CN.md) 可作为操作参考，其历史基线不替代本基线记录。完成 D 表后，只声明实测的源码试用范围。

## 5. 正式发布验收表

本表针对最终交付的确切产物，不能由开发运行通过替代。每条证据都绑定源码 SHA、渠道、OS/架构、工具链和最终哈希。签名、公证（会向 Apple 上传软件）、安装及发布须在对应授权下分别执行。

| 门槛 | macOS arm64 / x64 | Windows | 当前状态 |
| --- | --- | --- | --- |
| P1 支持范围 | 明确最低/支持的 macOS 版本；两架构各自原生验收，Rosetta 结果单列；当前计划为独立 DMG | 明确 OS、x64/arm64 范围、安装格式和 per-user 行为；不由 builder 默认值代替产品决定 | 范围和原生证据待完成 |
| P2 存储与身份 | 检查最终 bundle ID、主/辅助程序身份、两渠道并存、目录拒绝与跨渠道数据隔离 | 先完成真实 ACL 后端及第二用户访问拒绝；再验安装身份和路径 | Mac 未运行；Windows 阻塞 |
| P3 原生密钥库 | 使用合成值验证 Keychain 可用/拒绝/重启恢复、签名/渠道变化影响 | 使用合成值验证 OS 加密与 ACL；锁定/拒绝状态不能退为明文 | 未运行；不使用真实业务密钥 |
| P4 来源和包内容 | 检查各 `.app`/DMG 架构、版本、Web/后端一致性、ASAR、fuses、notices；无 workspace/凭据/用户素材 | 对选定格式检查对应内容与架构，不能调用 Linux tar.gz 检查器代替 | 平台检查器待实现；实际包未生成 |
| P5 签名及分发验证 | 有效 Developer ID、Hardened Runtime、最小必要 entitlements、嵌套签名、时间戳、公证日志、staple 验证及默认 Gatekeeper 接受 | 确定经授权的签名方案，核验应用/安装器签名、时间戳和安装身份 | Mac 当前跳过签名；Windows 流程未建立 |
| P6 安装和升级 | 以接收者方式取得最终包，安装/首次打开/重开/升级/卸载，验证数据保留和开发正式并存 | 普通用户安装、升级、卸载和权限/路径失败行为；不擅自提权修复用户目录 | 未运行 |
| P7 媒体和进程 | 对确切安装包重复 D4–D7，含最小环境下外部 FFmpeg、播放、退出与异常恢复 | ACL 解锁后对 Windows 工具/路径/进程语义同样验收 | 未运行 |
| P8 放行与留档 | 证据、最终哈希、已知限制与接收者验收相符；发布动作单独批准 | 同左 | 未放行；`publish:null` / `--publish never` 保持 |

R1 的最小实现可采用内置公证能力，不要求增加自定义 hook。是否需要额外 entitlements 必须根据真实签名产物和 Electron 行为确认，不能机械放宽 library validation 或添加调试权限。当前 `gatekeeperAssess:false` 也不能替代 P5 的最终验证。

## 6. 最小后续实施顺序

1. **先完成一个 Mac 架构的隔离源码试用。** 固定目标 OS/架构、同一源码、原生 Electron 和外部 FFmpeg；执行 D 表，发现的问题只在对应模块修复。随后补另一架构，尚无设备的一列保留未运行。
2. **补齐包来源和平台检查。** 顺序构建 Web/desktop，绑定哈希；为 Mac `.app`/DMG 增加最小包检查及原生记录入口。保留渠道身份、fuses、许可和无私有数据检查；共用 staging 不并行。无需改 Images、引入插件框架或重构业务层。
3. **建立正式 Mac 签名/公证门槛。** 在获得签名身份及相应操作授权后，修正正式渠道的跳过签名策略、明确失败处理，按 P 表验证精确产物。开发源码入口和正式发布入口分别验收；不以关闭安全措施解决问题。
4. **Windows 作为独立分支推进 ACL。** 先实现私有存储完整后端并通过原生隔离/失败测试，再做 D 表的启动、工具和恢复流程；该项可与 Mac 工作并行。不能先承诺可用安装包。
5. **再补 Windows 包配置和发布验证。** 明确平台/架构及安装策略，新增对应入口、包内容检查、签名与安装验收；完成后才更新平台就绪声明。FFmpeg 继续外置，捆绑决定另行评估。
6. **最后统一放行。** 对完成的渠道/平台/架构逐项填写 P 表，保持其他组合未验证；通过后才进入单独授权的分发或发布，不自动启用更新。

## 7. 本次实际检查与限制

| 检查 | 实际结果 |
| --- | --- |
| `pwd`、`git rev-parse --show-toplevel`、`git branch --show-current`、`git rev-parse HEAD`、`git status --porcelain=v1` | 初始隔离身份匹配、工作区干净、目标文档不存在 |
| 仓库约定及技能适用性 | 指定目录和上级未发现额外 AGENTS.md；沿用会话约定。检查了 code-review 技能，其差异审查流程不适用于本次同一基线快照配置核验，未为它新增 issue tracker 或扩大任务 |
| `rg`、`nl -ba` 静态读取 | 核对实际 builder、脚本、渠道、存储、工具校验和 Linux 专用 QA 引用；没有执行这些脚本 |
| `node --version` | 本次解析使用现有 Node `v26.9.0`；这不是 Electron 内置 Node 的实测结果 |
| Node 内联配置断言 | 加载本地 CJS 配置/元数据；两渠道身份、Mac 两架构、签名字段、publish、无 win 配置、脚本引用均符合上述描述；合成 staging 正确元数据被接受，错误版本/跨渠道元数据被拒绝；退出 0 |
| `node --check` | 对下列 11 个文件仅做语法解析，全部退出 0，不执行模块体 |

语法检查文件：`apps/desktop/{builder-config,build-metadata,identity,electron-builder,electron-builder.dev}.cjs`、`apps/desktop/scripts/{build,inspect-package}.mjs`、`apps/desktop/src/{config,main}.mjs`、`scripts/lib/local-tooling.ts`、`packages/contracts/src/private-storage.ts`。

可重复的最小只读配置检查（在该源码根目录执行，不调用 builder）：

```sh
node <<'NODE'
const assert = require('node:assert/strict');
const makeConfig = require('./apps/desktop/builder-config.ts');
for (const channel of ['production', 'development']) {
  const c = makeConfig(channel);
  assert.deepEqual(c.mac.target, [{target: 'dmg', arch: ['arm64', 'x64']}]);
  assert.equal(c.mac.identity, null);
  assert.equal(c.mac.hardenedRuntime, true);
  assert.equal(c.publish, null);
  assert.equal(Object.hasOwn(c, 'win'), false);
  console.log(channel, c.appId, c.directories.output);
}
NODE
```

没有运行 doctor（可能探测媒体工具）、测试套件、Web/desktop build、UI/native、打包、签名、公证、应用或 FFmpeg；没有安装依赖、读取真实密钥/用户媒体、迁移真实数据、调用真实供应商、commit、merge 或 push。文档中的待办不构成上述操作已通过或已执行的声明。
