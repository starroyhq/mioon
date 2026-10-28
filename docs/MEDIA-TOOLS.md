# Mioon 提供的视频工具（FFmpeg / ffprobe）

macOS 桌面版可以在应用里下载 Mioon 自己构建的 FFmpeg 7.1.5 和 ffprobe，不需要先装 Homebrew。仍然可以选择自己安装的工具；两条路径使用同一套检查。Linux 和 Windows 目前不提供下载，界面保持原来的“选择工具”。

## 用户看到什么

- **第一次启动**：没有可用的工具时，提示框提供“下载并安装”“选择已安装的工具”“退出”。选择下载后显示一个小进度窗口，关闭窗口即取消。下载或检查失败会回到这个提示框，并写明原因。
- **设置 › 视频工具**：顶部的“Mioon 提供的版本”卡片显示版本、架构和大小，可以下载、取消或改用已下载的副本。安装成功后自动保存路径，点“重启本地服务”后生效。
- 安装位置是桌面数据目录下的 `media-tools/<版本>/`，例如正式版的 `~/Library/Application Support/app.starroy.mioon/media-tools/7.1.5-1/`。目录权限为 0700，不进入工作区备份。

## 构建内容

`.github/scripts/build-media-tools.ts` 在对应架构的原生 macOS 上，从固定了 SHA-256 的源码包编译全部组件。第三方库都编成静态库，最终的 `ffmpeg` 和 `ffprobe` 只动态链接 macOS 自带的库和框架。

| 组件 | 版本 | 许可 |
| --- | --- | --- |
| FFmpeg | 7.1.5（仓库 `ci-ffmpeg-7.1.5` 镜像，已核对官方签名） | 按此配置为 GPL-2.0-or-later |
| x264 | stable 分支 `b35605ac` | GPL-2.0-or-later |
| FreeType | 2.14.3 | FTL 或 GPL-2.0-or-later |
| HarfBuzz | 14.6.0 | MIT |
| FriBidi | 1.0.17 | LGPL-2.1-or-later |
| Expat | 2.9.0 | MIT |
| Fontconfig | 2.16.0 | HPND |
| libass | 0.17.5 | ISC |
| zimg | 3.0.6 | WTFPL |

- 开启的库与 Linux CI 工具链一致：`libx264`、`libass`、`libfontconfig`、`libfreetype`、`libharfbuzz`、`libzimg`、`libfribidi`。没有包含 CI 里的 `libvpx`、`libmp3lame`、`libwebp`，应用只用到它们对应格式的解码，FFmpeg 自带解码器。
- 使用 `--disable-autodetect` 和 `--disable-network`，没有任何网络协议；没有开启 `nonfree`，可以按 GPL 再分发。
- 最低系统版本 macOS 12.0，与 Electron 44 一致。
- Fontconfig 的配置路径编译为系统位置 `/etc/fonts`，缓存目录为 `/var/cache/fontconfig`，不会指向构建机的临时目录。macOS 上通常没有 `/etc/fonts/fonts.conf`，Fontconfig 使用内置的后备配置，查找 `/System/Library/Fonts`、`/Library/Fonts` 和 `~/Library/Fonts`，缓存写在 `~/.cache/fontconfig`。只有不带字体文件的 `drawtext`（模拟生成的“SIMULATED MOCK”字样）会用到它：第一次约 2 秒扫描字体，之后读缓存，stderr 会多一行配置文件缺失的提示，不影响结果。字幕使用指定的字体文件，libass 使用 Core Text，都不经过这个后备配置。
- M4、Autoconf、Automake、Libtool、NASM、Meson 和 Ninja 只用于构建，不进入发布的程序。

构建脚本在打包前检查：版本号；`otool -L` 只出现 `/usr/lib/` 和 `/System/Library/Frameworks/`；`LC_BUILD_VERSION` 的 minos 为 12.0；架构正确；包含 `libx264`、`aac` 编码器以及 `drawtext`、`subtitles`、`zscale`、`loudnorm`、`ebur128` 等滤镜；没有网络协议；`drawtext` 提供字幕所需选项。还会实际运行一遍模拟生成的默认字体字幕、带字体文件的 1080×1920 导出（zscale、AAC、响度）、ASS 字幕，并用 ffprobe 读取结果。

## CI 构建、签名与公证

`.github/workflows/media-tools.yml` 在修改构建脚本或工作流的 PR 上运行，也可以手动触发。arm64 在 `macos-15`、x64 在 `macos-15-intel` 上原生构建。有签名凭据时，用 Developer ID 和 hardened runtime 分别签名两个程序，提交 `notarytool` 并要求结果为 Accepted，然后对签名后的程序重新运行全部检查。

产物上传为 `media-tools-darwin-arm64` 和 `media-tools-darwin-x64` 两个 artifact，各包含：

- `mioon-ffmpeg-<版本>-darwin-<架构>.gz`、`mioon-ffprobe-<版本>-darwin-<架构>.gz`
- `mioon-media-tools-<版本>-darwin-<架构>.json`：组件、configure 参数、链接库，以及每个文件压缩前后的 SHA-256 和大小
- `notarization-darwin-<架构>.json`
- arm64 的 artifact 另含 `mioon-media-tools-<版本>-sources.tar`：所有随程序分发的组件源码包、构建脚本和许可说明

没有签名凭据的运行（例如来自 fork 的 PR）只构建和检查，artifact 名称带 `-unsigned`，不能用于发布。

## 应用如何下载和校验

`apps/desktop/src/media-tools.ts` 的 `MEDIA_TOOLS_RELEASE` 写死了版本、下载地址前缀和每个文件的 SHA-256 与大小。

1. 主进程通过 Electron 的网络栈（跟随系统代理）下载，只接受 HTTPS，`Content-Length` 必须与清单一致。
2. 边下载边计算压缩包和解压后程序的 SHA-256 并限制大小，写入私有临时目录，权限 0700。
3. 对临时目录里的程序运行与手动选择相同的 `validateTools` 检查（版本、`libx264`、`aac`）。
4. 全部通过后才把临时目录改名为正式目录；已有的损坏副本在新副本就位后才删除。失败或取消时删除临时目录。
5. 已下载且内容校验一致的副本直接复用，不再下载。

渲染进程只能调用 `mediaToolsStatus`、`installMediaTools`、`cancelMediaToolsInstall` 三个固定动作，不能传入 URL、路径或命令。设置页保存路径时沿用原来的规则：发起请求的窗口在安装完成时仍是受信任的当前文档，且工具具备必要编码器。

首次启动的进度窗口出现在本地服务启动之前，使用固定的内联页面（`apps/desktop/src/media-tools-window.ts`）：独立的内存会话拒绝除 `data:` 以外的全部请求和权限，沙箱开启、没有 preload，禁止导航和弹窗。主进程只向页面发送数字进度；页面的取消按钮通过改写标题通知主进程，关闭窗口同样会取消。

## 发布新版本

1. 修改 `build-media-tools.ts` 的源码版本或 `MEDIA_TOOLS_VERSION`，同步 `MEDIA_TOOLS_RELEASE` 的 `version` 和地址，开 PR。
2. 等两个架构的 CI 成功，下载 artifact，核对 manifest 和公证结果。
3. 把 manifest 里 `assets` 的 `file`、`sha256`、`bytes`、`unpackedSha256`、`unpackedBytes` 填入 `MEDIA_TOOLS_RELEASE.builds`。
4. 用这些 artifact 原样创建 GitHub Release `media-tools-<版本>`（预发布），附件包括两个架构的 `.gz`、manifest、公证结果和源码包，说明里写明 GPL 许可与源码位置。CI 重新构建的文件哈希不同，不能替代已固定的文件。
5. 合并 PR。

## 许可

下载的 FFmpeg 和 ffprobe 包含 libx264，按 GPL-2.0-or-later 分发；同一 Release 提供完整的对应源码和构建脚本。Mioon 本身仍采用 Apache-2.0，它把 FFmpeg 作为独立程序通过命令行调用。

## 限制

- 新的 FFmpeg 版本需要随 Mioon 新版本更新清单；应用不会自动升级已安装的工具。
- 下载地址指向 GitHub Releases。国内网络访问较慢时可以改用自己安装的工具；以后如果增加镜像，只需要在清单里加地址，校验规则不变。
- Windows 和 Linux 不提供下载。
