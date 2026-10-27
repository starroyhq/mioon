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

`apps/desktop/scripts/build.ts` 用 esbuild 将共享服务及其运行依赖打入 `backend.cjs`，将桌面壳打入 `main.cjs`，复制 `apps/web/dist`。暂存目录与最终 ASAR 均排除 workspace 软链接、`node_modules`、原素材、项目数据库或访问令牌。生产依赖许可证和 checked-in shadcn/ui 的 MIT 许可证一同装入 ASAR 的 `licenses/`。Electron/Chromium 原始通知来自各目标 Electron 分发包：Linux 保持可执行文件旁的 `LICENSE.electron.txt` 和 `LICENSES.chromium.html`；macOS 的 `afterExtract` 钩子在 builder 删除分发包根目录通知之前，将两份原始字节保存到 `.app/Contents/Resources/licenses/`，`afterPack` 再分别核对大小与 SHA-256。这些额外资源不扩大 ASAR 白名单，也不使用构建主机的 Electron 通知替代目标运行时。现有 Linux 专用 `inspect-package.ts` 仍按原有路径检查最终 ASAR 及实际二进制 fuse 字节。桌面 builder 配置已迁移为 typed ESM：`apps/desktop/builder-config.ts`（配合 `identity.ts`、`build-metadata.ts`、`subtitle-resources.ts`、`runtime-notices.ts`）由 `apps/desktop/scripts/prepare-builder-config.ts` 打包成忽略目录中的 `.generated/electron-builder{,.dev}.cjs`；`scripts/build.ts` 在暂存构建时自动生成，仓库不再保留手写 builder CJS 入口。

Mioon 自身采用 Apache-2.0。构建从根目录逐字节复制 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md` 为 ASAR 内的 `licenses/Mioon-LICENSE.txt`、`licenses/Mioon-NOTICE.txt`、`licenses/Mioon-THIRD-PARTY-NOTICES.md`；任一源文件缺失或为空都会阻止构建。暂存 `package.json` 沿用桌面包的许可证字段。这些声明与原第三方通知共同保留，不替换依赖、字体或供应商图标的许可证，也不扩大现有 ASAR 白名单。

macOS 通知保护钩子要求目标 framework/config 版本和尚未改写的 `Electron.app/Contents/Info.plist` 版本与根清单 Electron 固定版本一致；正常解包会在钩子前移除根目录 `version`，所以不依赖该文件。输入与输出拒绝符号链接、非普通文件、空文件和超限文件；Electron 通知上限 256 KiB、Chromium 通知上限 32 MiB、原始 plist 上限 1 MiB。版本证据是解包上下文和原始 bundle 元数据，不构成运行时签名认证。2026-10-11 留存的旧 arm64 development/production `.app` 验收仍缺少两份通知，development DMG 也没有重新生成或重新挂载检查；此处源码修复与云端契约测试不能替代新的 Mac 验收。

界面品牌使用 `apps/web/src/assets/mioon-mark.png` 透明猫耳片带；浏览器 favicon 保持原样。macOS、Windows 和 Linux 桌面图标共用 `apps/desktop/resources/icon.png`（1024×1024 RGBA）。原始 `icon-source.png` 是未预裁切的 1024×1024 RGB 方形品牌图；通过 Icon Composer 文档交给 Apple `actool` 编译，由官方工具生成圆角轮廓、留白、边缘与阴影，不再手画超椭圆或按视觉猜测缩放比例。多尺寸 `icon.icns` 直接采用官方输出，共享 PNG 则提取其 1024px 原始字节。构建复制 `icon.png` 为 `icons/icon.png`，由窗口和 macOS Dock 使用；正式版和开发版打包配置共用这些品牌资源；Linux 打包显式选用该 PNG，Windows 打包由 electron-builder 将其转换为 ICO。两个包检查入口均要求该 PNG 存在，并核对与暂存文件一致。图标共享不改变 Windows 的现有启动限制或桌面发布平台范围。

在已选择包含 Icon Composer 的完整 Xcode 的 macOS 上运行 `swift apps/desktop/scripts/generate-desktop-icons.swift` 可重新生成图标；本次使用 Xcode 27.1。脚本以原图作为一个不添加玻璃材质的平面图层，在临时目录建立 `.icon` 文档，再使用 Apple `actool` 输出完整传统 ICNS。`--minimum-deployment-target 10.12` 只用于图标素材导出：官方工具对 10.13 及以上目标会把高分辨率放入 `Assets.car`，仅留下部分 ICNS；这里需要完整独立 ICNS，此参数不会改变 Electron 应用的最低系统版本。临时 `Assets.car` 不随包发布；常规构建使用已提交的 PNG／ICNS，不要求 Linux、Windows 或最终用户安装 Xcode。

处理依据见 [Apple App icons 指南](https://developer.apple.com/design/human-interface-guidelines/app-icons)和[使用 Icon Composer 创建图标](https://developer.apple.com/documentation/xcode/creating-your-app-icon-using-icon-composer)。Apple 建议提供方形未遮罩图层，由平台处理最终边缘；现有 Electron 打包仍采用兼容的静态 PNG／ICNS，此修改不宣称接入动态 Liquid Glass 或外观变体。

## 从源码启动

桌面设置以依附打开者的较小模态面板呈现，最大 1000×720，并按父窗口内容区域缩小。macOS 使用 Electron 的原生 sheet；主界面增加半透明灰色遮罩并保持挂载，后台任务继续运行。模态限制只作用于打开设置的父窗口，其他项目窗口仍可使用。设置保持全局单例，重复打开不会更换父窗口或重建密钥／未保存表单；只有设置实际关闭后才解除父窗口遮罩并恢复焦点。

父窗口在设置存在时不能关闭、重载或从其恢复提示绕过设置准入。正常退出和后台重启先检查设置的未保存内容，取消时保留面板、父窗口和后台。原生确认期间暂缓该设置文档的自动外观刷新，取消后补读；实际编辑仍会使旧确认失效。设置加载失败或 renderer 故障沿用原恢复流程，不把故障当作已关闭。该呈现使用原有设置业务和权限，不新增数据库或供应商请求。

桌面新增系统托盘：macOS 菜单栏单击展开菜单，Windows 左键显示已有界面、右键展开菜单，Linux 使用桌面环境提供的托盘菜单。提供“显示 Mioon／Mioon Dev”“隐藏到托盘”“新建项目”“打开项目”“设置…”和“退出”。显示恢复最近窗口，有设置面板时优先恢复其原模态 owner；没有窗口时先加载并验证项目列表，再打开设置。重复点击合并，新的明确动作或退出／重启会撤销旧的待显示意图。

“隐藏到托盘”只隐藏现有项目窗口，保留其文档和后台任务；显示时不重新生成、重放编辑或重建项目。设置面板、原生确认或关闭／重载检查尚未结束时不可隐藏；原生确认期间托盘的新建、打开与设置不可用，显示只恢复原确认所属窗口。正常关闭按钮行为保持：关闭最后项目仍返回项目列表，macOS 全部窗口关闭后保留应用，Windows／Linux 全部窗口关闭后正常退出；没有增加“点击关闭即隐藏”或开机自启。托盘随应用创建一次，后台服务重启时保留，只有真正退出才销毁；取消退出保留托盘和原有输入检查。托盘不可用时不允许隐藏，已隐藏界面会在检测到托盘丢失时恢复。

托盘资源直接由现有 `apps/web/src/assets/mioon-mark.png` 确定性导出，不使用重新生成的主体，也不修改原图与 Dock 图标。运行 `swift apps/desktop/scripts/generate-tray-icons.swift` 生成 18px／36px Retina 黑色透明 Template、同轮廓彩色 PNG，以及 16／20／24／32／48／64px 彩色 ICO。macOS 由系统菜单栏外观动态着色，不跟随工作区主题；Windows 使用彩色 ICO。普通构建仅复制五个固定运行时图像，原图、导出 manifest 与说明不进入 ASAR；打包检查同时核对完整性、额外文件和暂存字节。此适配不解除现有 Windows Electron 私有存储启动门禁。

本次在 macOS 隔离开发配置中验证了真实 Mio 未发送草稿的原生退出流程：“继续编辑”保留草稿，“放弃变更”正常退出。已确认 idle 的只读轮询不再使退出确认失效，真实目标、版本或权限变化仍会撤销旧确认。原生宿主回归覆盖隐藏／显示、首次无窗口打开设置或项目入口、取消退出与后台重启。当前自动化工具无法访问系统状态区，托盘实际点击、系统黑白外观切换及 Windows 实机效果仍待手动验收。

顶部原生菜单按“应用名称／文件／编辑／视图／剪辑／窗口／帮助”组织；Windows／Linux 把设置和退出放在文件菜单、关于放在帮助菜单。新建、打开、设置和显示窗口与托盘共用宿主路径；“设置…”（macOS `⌘,`）打开通用页，帮助中的快捷键入口打开同一个设置面板。原四个连接页的请求仍兼容。重载与重启本地服务位于“帮助 → 故障排查”，保留原生关闭确认与恢复校验。

文件菜单的导入沿用本项目素材选择和校验；导出只打开原有审阅面板，不直接开始渲染。视图菜单反映当前画板／剪辑工作区及面板状态，窗口列表只列出当前宿主拥有的项目窗口。业务菜单仅向精确窗口、文档和主 frame 发送固定枚举意图；可用性报告只作显示提示，执行时仍复核当前焦点、输入法、模态框、项目、选择、锁轨和原业务准入。意图绑定当次报告版本；选择、播放源或时间线版本变化时，即使菜单仍可用，旧意图也不能操作新目标。业务目标仅用于 renderer 本地范围校验，不进入菜单 IPC。隐藏、重载、关闭或后端换代后，旧报告与旧文档事件不能取得新窗口的操作权；不重试不确定的派发。

文字焦点中的撤销／重做由原生文本编辑处理，时间线焦点使用原有历史流程。桌面的 `⌘/Ctrl+Z`、`⇧⌘/Ctrl+Shift+Z` 和 `⌘/Ctrl+B` 只由原生菜单派发一次；Windows 原有 `Ctrl+Y` 别名保留。空格、退格和 Shift+退格仍是工作区局部快捷键，避开输入框、按钮、输入法和弹框，菜单点击使用同一播放或删除控制器。删除仍须原确认，播放仍绑定当前可见媒体。菜单和快捷键说明共用固定定义，四种界面语言同步。

浏览器文件选择器要求临时用户手势。鼠标菜单导入仅通过原主 frame 执行固定导入入口，并携带用户手势；脚本只编码经过校验的固定意图，不接收代码、路径或选择器，也不同时再发 IPC。入口与普通菜单共用身份、顺序去重和单消费者检查；返回已消费不代表文件已经选定或导入成功，异常和结果不确定时均不自动重发。

报告版本对应的命令范围只在 renderer 中有界保留。播放暂停绑定媒体及播放状态，分割绑定片段、版本和播放头，普通面板操作不因被动播放进度失效；目标或可用性变化后再恢复，也不能复活旧命令。

2026-10-26 顶部菜单及唤醒租约验收：相关桌面、设置及时间线回归 995/995 通过，`pnpm typecheck`、`pnpm build` 与 `pnpm desktop:build` 通过。macOS 隔离开发实例实测了空项目入口帮助、通用设置、新建项目、输入框原生撤销、鼠标菜单导入本机测试视频、切换剪辑工作区、菜单及快捷键分割与撤销、播放中暂停、导出审阅、删除确认及撤销恢复、原菜单重启同一项目和正常退出；未调用模型或开始渲染。Windows／Linux 原生交互仍未实机验证，跨平台布局与状态检查由离线回归覆盖。

Mac 首次完整源码试用见 [Mac 源码试用指南](MAC-SOURCE-TRIAL.zh-CN.md) 与 [试用记录表](MAC-TRIAL-CHECKLIST.zh-CN.md)。

需要 Node ≥24、pnpm 11.25.0 和可信来源安装的 FFmpeg / ffprobe。Node 与 pnpm 是构建工具要求，发布桌面包的后端不依赖它们。

```sh
pnpm install --frozen-lockfile
node scripts/tooling.ts doctor
node scripts/tooling.ts build --channel=development
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
- 打包前检查暂存渠道，拒绝把开发版暂存目录当成正式版，或反过来。源码版本为 `0.1.0`。

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
node apps/desktop/scripts/migrate-data.ts --source=/absolute/old/data --destination=/absolute/desktop-user-data/workspace
```

助手只复制数据库与托管媒体，在副本应用同一份迁移并执行 `integrity_check`；不会修改或删除源目录，不复制访问令牌、服务锁或 Chromium 配置。源服务锁、未 checkpoint 的 WAL、符号链接或已存在的目标目录都会导致拒绝。不要覆盖已有桌面项目；先保留完整备份并选择新目录。

## 安全边界

- 全局 `app.enableSandbox()`，窗口明确启用 `sandbox`、`contextIsolation`、`webSecurity`
- 禁用 Node integration（含子 frame 和 worker）、WebView、实验性特性及不安全混合内容
- 沙箱 preload 仅提供固定的项目窗口桥：查询非秘密窗口身份、打开当前工作区项目、显示首页/指定设置页、报告编辑器加载状态。主进程逐次验证发送窗口、主 frame、当前 URL 与文档 generation；没有任意 IPC/URL/路径/业务执行接口。页面拿不到 Electron、`fs`、shell 或 bearer token
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

## 窗口外观

macOS 隐藏原生标题栏（`titleBarStyle: 'hidden'`），三枚窗口按钮由系统绘制在工作台顶栏左侧，关闭窗口仍走同一套关窗、未保存确认与退出流程。顶栏同时是窗口拖动区，其中的按钮、标签和输入框、以及对话框与菜单显式排除拖动。窗口选项见 `apps/desktop/src/window-chrome.ts`，页面按 user agent 识别该外壳并在 `<html>` 上标记 `data-desktop-frame="mac-inset"`，顶栏左侧留白见 `apps/web/src/styles.css`。Windows 和 Linux 保留原生标题栏；固定窗口桥与窗口外观独立，不扩展文件、凭据或业务权限。macOS 外观仍是源码契约覆盖，不能替代实机验证。

## 启动、退出与恢复

主进程等待 utilityProcess、认证 cookie 与连接发现就绪，才创建项目入口窗口。桌面最多一个入口窗口、一个编辑窗口，共享同一后台；Web 保留单页。首次入口保留原项目选择优先级，编辑窗口只打开指定项目。关闭编辑器须通过原生关闭准入，之后显示项目首页并保持后台，已接受任务继续按原规则处理。显示首页不会自动关闭或隐藏编辑器。明确退出/重启服务会逐窗取得准入并等待真正关闭，再停止后台；请求阶段即禁止复活窗口。窗口隐藏、销毁标记、busy=false 或一次 toast 均不是保存证明。完整边界见 [独立项目窗口](DESKTOP-PROJECT-WINDOWS.md) 与 [原生关闭准入](NATIVE-CLOSE-ADMISSION.md)。

正常停止先中断操作，再等待已持有句柄的本地媒体进程退出，随后关闭 worker、HTTP、SQLite 并清理 discovery。媒体停止尝试最多 3 秒，worker/server 最多 5 秒，utility 停止尝试最多 13 秒；未确认退出时返回明确失败，不能把发送信号当作回收成功。仍有准确句柄时应用继续等待实际退出，不承诺整个应用一定在 13 秒内关闭。utility 意外退出后，记录的数字 PID 不足以证明进程归属，因此不会据此杀进程；媒体清理不明时阻止该应用内自动替换/重启，并提供明确的“退出应用”警告。退出后的新应用生命周期无法证明旧媒体进程已结束，再次工作前可能需要用户在系统任务管理器中检查。

服务崩溃时提供原生“重启本地服务/退出”选择。重启使用新端口/新令牌并重新载入同一数据目录；未保存界面状态可能丢失。渲染进程崩溃可单独重新载入，后台保持独立。原有视频生成任务按已知远端任务继续查询，提交结果未知的任务先对账，不因 Electron 重启自动重发收费请求。Images/ComfyUI 采用各自的结果恢复规则；ComfyUI 重启后不会自动查询或再次 POST，需要显式观察同一已保存任务。被中断的本地时间线渲染重新排队，旧结果文件保持不可变。utility 另有 30 秒主进程心跳租约。历史无活动媒体的 utility 崩溃恢复与当前正常退出证据，不代表活动媒体异常退出的自动回收能力；旧的“崩溃后按 PID 杀媒体并自动恢复”验收已撤销。操作系统同时强杀整个进程树也可能绕过清理方；原生 macOS/Windows 与异常孤儿进程恢复仍需专项验收。

2026-10-26 菜单验收发现并修复睡眠恢复竞态：Mac 合盖睡眠 594 秒后，维护唤醒与 `lease-expired` 退出发生在同秒；旧实现会把整个睡眠时间计入失联。现以单调时钟观察本地执行间隔，常态仍为 30 秒租约、每 5 秒检查；超过 15 秒未执行租约回调时，先向当前父进程发出新的固定 challenge。排队的普通 ping、错误或旧 ACK 均不能证明恢复，只有与先前已发 challenge 匹配的 ACK 才恢复正常续租；父进程只回应当前子进程的启动／运行状态，停止或替换后不回应，不重启后台或重发业务请求。

恢复只分配一次 30 秒执行预算，普通执行间隔全额扣除，再次长暂停扣一个 5 秒检查粒度，不重新分配预算。持续得不到新证明时会在 30 秒连续执行或最多六次额外长暂停后退出；这是避免反复暂停使孤儿无限续命的边界。回归覆盖两种唤醒顺序、维护唤醒后再次睡眠、重复睡眠、墙钟跳变、旧／迟到／畸形 ACK、通信失败和真正失联；关闭或到期后均不能恢复。此前原故障排查菜单已验证可恢复同一已保存项目、素材和时间线，未重发睡眠期间结果不确定的删除请求。

macOS 独立 Electron 44.7.0 实例另以 `SIGSTOP` 同时暂停真实主进程与后台 40 秒，先恢复后台、1 秒后恢复父进程，再等待超过恢复预算的 32 秒，确认原后台 PID／端口和 HTTP 服务仍可用、没有重启。之后仅暂停父进程，后台按原租约退出并由父进程确认 `lease-expired`；整个过程仅启动一次后台、未强杀后台、未配置凭据或调用供应商。此项是实际进程暂停验收，不能代替所有操作系统睡眠／唤醒情形的实机认证。

macOS 关闭最后一个窗口时保留应用与后端；Dock 激活重新打开窗口，明确退出才关闭服务。此行为已写入源码，但仍需 macOS 实机验证。发布升级、正式签名和公证仍未完成。Agent 与官方/自定义 Images 专用设置及 Electron safeStorage 接入已实现；密钥保持独立绑定，不向 renderer 返回密钥，不用一个配置槽静默替换另一个。ComfyUI 有独立无密钥连接设置。真实 macOS Keychain 可用性/拒绝/重启兼容尚未原生认证；9e基线使用同步 safeStorage；本次整合候选的 macOS 路径使用官方异步 API，超时/失败不回退同步，真实 Keychain 仍待验证。Linux 保留原四类强 keyring 同步路径和旧密文，客户端超时不能解除其主线程阻塞；Windows 仍 fail-closed。候选详情见 [Keychain 异步边界](KEYCHAIN-ASYNC-CANDIDATE.md)。安全存储不可用时仅允许明确的 session-only 模式，不回退到明文持久化；Agent 会话密钥在主进程关闭时丢失，Images 会话密钥在其 backend 生命周期结束时丢失。

本地编辑协调账本当前覆盖 21 类固定操作：原有时间线/首帧连接十二类，加 `timeline.clip.rippleRemove` 波纹删除，加 `subject.create`、`subject.version.add`、`subject.binding.set`，以及 `timeline.format.set` 和三类手动字幕 `timeline.subtitle.add`、`timeline.subtitle.update`、`timeline.subtitle.remove`，以及完整固定倍率候选的 `timeline.loudness.apply` 原子应用。启动或列表读取不会自动执行；其余八类画板/素材编辑和 `timeline.render` 等保持各自原有恢复边界。Images/ComfyUI 的审批与结果恢复是独立任务语义，不通过这份编辑账本执行。详见 [任务恢复契约](TASK-RECOVERY.md)。

## 项目视图记忆

画板/剪辑模式、选择、缩放、播放头、滚动与面板状态保存在当前渠道的 `workspace/` 数据库独立表中。重新打开同一项目可恢复，包括正常完全退出后重启；这不保存全局最后打开的项目。浏览器与桌面连接同一个后端时共享该项目的本地单用户视图，并以独立版本防止旧窗口覆盖。认证 cookie 和 Chromium session 仍不持久化；固定原生窗口桥不保存项目、草稿或偏好。

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

`pnpm --filter @mioon/desktop package:mac` 与 `package:mac:dev` 先通过 tooling 串行构建 Web 和对应渠道，再运行 builder（`--publish never`）；不能并行共用 staging。生成的 `apps/desktop/.generated/electron-builder.cjs` / `.dev.cjs`（源自 typed `apps/desktop/builder-config.ts`）配置 macOS arm64/x64 DMG，目前 `identity:null`，没有已验证的签名/公证、Gatekeeper 或安装升级结果，不能将构建成功称为可分发认证。入口依据见 [打包入口说明](PACKAGE-ENTRYPOINTS.md)，平台门槛见 [发布门槛](PLATFORM-RELEASE-GATES.md)。

## 验证

```sh
pnpm test:desktop
MIOON_FFMPEG_PATH=/usr/bin/ffmpeg MIOON_FFPROBE_PATH=/usr/bin/ffprobe pnpm --filter @mioon/desktop smoke
```

Q3 当前媒体环境/退出验收与原生限制见 [MEDIA-RUNTIME.md](MEDIA-RUNTIME.md)。以下 V4 记录属于历史基线，不能当作当前异常媒体清理能力；旧的活动渲染崩溃回收项在 smoke 报告中已改为明确 skippedChecks。

单元测试覆盖 origin/导航/下载白名单、无 Node 权限与固定窗口 IPC 白名单、cookie 属性、权限拒绝、私有 discovery、环境隔离、启动超时、异常退出、媒体子进程所有权和取消未保存退出。

固定 Electron smoke 在隔离临时 userData 中检查真实 utility Node/SQLite、真实沙箱 renderer、Secure cookie 自动认证、匿名请求拒绝、网络/窗口/权限阻断、项目持久化、普通重启与 SIGKILL 恢复，并写本地 JSON 报告及实际窗口截图。不会调用真实供应商。受限 shell 的一次 headless 探测被宿主 `socket() Operation not permitted` 阻止；没有绕过任何沙箱。图形会话验证及最终结果见 `STATUS.md` 与相应验收证据。

在自己的 Linux 图形会话中，扩展 smoke 已通过 19 项检查：包括真实 10 秒分层合成、活动 FFmpeg 期间的 utility SIGKILL 清理/恢复、正常中断/恢复、实际 renderer `beforeunload` 取消退出，以及 720×1280 成片在第 3 秒成功解码后截图。证据为 `evidence/v3-desktop/smoke.json`、`electron-workbench.png`。

历史 V3 打包黑盒验证针对 `release/desktop/linux-unpacked/video-workbench`，检查空 PATH 启动、捆绑 utility、正常 HTTP 渲染与原生退出；历史证据保留在 `evidence/v3-desktop/`，不是当前 Mioon 构建的验证。

当前 `apps/desktop/scripts/packaged-qa.ts` 默认检查正式渠道 `release/desktop/production/linux-unpacked/mioon`；传入 `--channel=development` 检查开发渠道的 `mioon-dev`。`inspect-package.ts` 使用相同渠道参数检查该渠道的包、归档和当前暂存构建，报告写入 `evidence/mioon-desktop/<channel>/`。只有显式 `--historical-v3` 才检查未改动的旧 0.3.0 归档，且不与当前暂存构建比较；报告为 `evidence/mioon-desktop/historical-v3-inspection.json`。这些脚本没有启用 smoke bridge 或远程调试。本次更名修改了脚本入口，但没有构建安装包或运行上述打包版检查。

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

CLI 与 MCP 都可使用同一 `MIOON_CONNECTION_FILE`，每次请求重新读取，跟随桌面端口/令牌轮换。Web 模式还支持 `MIOON_BASE_URL` + `MIOON_TOKEN_FILE`。连接与命令见 CLI.md / MCP.md。应用的 Node 来自 Electron；源代码 CLI/MCP 仍需客户端电脑安装 Node ≥24 和工作区依赖。当前应用、CLI/MCP 实现元数据与后端 `/health` 同为根应用版本0.1.0；MCP协议日期和descriptor版本独立，不能混用。

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
