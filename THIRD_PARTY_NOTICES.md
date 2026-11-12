# 第三方声明

Mioon 原创代码与文档采用根目录 [Apache License 2.0](LICENSE)。以下第三方内容保留各自的版权与许可，项目许可证不替代这些声明；其原始声明文件应随对应内容保留。

## 仓库内的第三方内容

| 内容 | 许可与来源 | 仓库内声明 |
| --- | --- | --- |
| shadcn/ui 衍生组件 | MIT，Copyright (c) 2023 shadcn | [LICENSE.shadcn.md](packages/ui/src/LICENSE.shadcn.md)；组件来源见 [UI-COMPONENTS.md](docs/UI-COMPONENTS.md) |
| 供应商 SVG 图标 | LobeHub Lobe Icons，MIT；固定版本与提交见原声明。供应商名称和商标归各自权利人 | [LICENSE](apps/web/public/provider-icons/LICENSE)、[NOTICE.txt](apps/web/public/provider-icons/NOTICE.txt) |
| 内置字幕字体 | Noto Sans CJK SC 2.004，SIL Open Font License 1.1 | [OFL-1.1.txt](packages/business/resources/subtitles/OFL-1.1.txt)、[SOURCE-COPYRIGHT.txt](packages/business/resources/subtitles/SOURCE-COPYRIGHT.txt)、[提取与来源说明](packages/business/resources/subtitles/README.md) |
| Mio 光标轮廓 | Cua Driver 0.38.0，MIT。轮廓取自 Computer Use | [来源和许可原文](#mio-光标轮廓) |

字体来源文件中的 Debian 包装许可说明不改变字体本身的 OFL 许可。项目的 Apache-2.0 声明也不改变供应商商标的使用条件。

### Mio 光标轮廓

Mio 光标使用 Computer Use 应用图标的 `#cursor` 路径。该路径改编自 Cua Driver 0.38.0 的默认指针。 [Computer Use 图标](https://github.com/starroyhq/computer-use/blob/96ae09378425ffaf44d499cd22f057e01394439c/assets/app-icon.svg#L25) · [Cua Driver 0.38.0](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.38.0)

Computer Use 的原始内容采用 MIT 许可，版权为 Copyright (c) 2026 Starroy。 [Computer Use 许可](https://github.com/starroyhq/computer-use/blob/96ae09378425ffaf44d499cd22f057e01394439c/LICENSE)

以下是 Computer Use 随指针轮廓保留的 Cua Driver MIT 许可原文。 [指针许可](https://github.com/starroyhq/computer-use/blob/96ae09378425ffaf44d499cd22f057e01394439c/assets/CUA-CURSOR-LICENSE.txt)

```text
MIT License

Copyright (c) 2025 Cua AI, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 依赖与桌面产物

JavaScript/Node.js 依赖的版本由 `pnpm-lock.yaml` 固定，各依赖遵循其上游许可。桌面构建会沿实际打包依赖图收集上游 LICENSE、COPYING、NOTICE 等文件，并生成 `licenses/THIRD-PARTY-NOTICES.md`；这是随包依赖通知，不是根目录本文件的副本。

项目自身的 `LICENSE`、`NOTICE` 和本文件另存为桌面产物中的 `licenses/Mioon-LICENSE.txt`、`licenses/Mioon-NOTICE.txt` 和 `licenses/Mioon-THIRD-PARTY-NOTICES.md`。内置图标及字幕字体的原始声明也会随对应资源保留。

Electron 与 Chromium 使用目标运行时发行包提供的原始通知：macOS 位于 `.app/Contents/Resources/licenses/`，Linux 位于可执行文件旁。具体收集与验证方式见 [桌面说明](docs/DESKTOP.md)。

已知上游缺口：`mmx-cli@1.0.28` 的发布包 README 声明 MIT，但发布包未附 LICENSE 全文及 `package.json` 的许可字段。构建会如实保存该 README 声明的来源与缺口，不自行补造其版权声明或许可证正文。

## 外部工具与用户内容

FFmpeg、ffprobe 不随 Mioon 桌面安装包捆绑。用户可以自行安装，其工具、编码器和构建选项适用各自许可；也可以在 macOS 版应用内明确选择下载 Mioon 构建的 FFmpeg 7.1.5 与 ffprobe。该构建包含 libx264 等组件，整体按 GPL-2.0-or-later 分发，完整对应源码和构建脚本随同一 GitHub Release 提供，组件清单见 [视频工具说明](docs/MEDIA-TOOLS.md)。Mioon 通过命令行将其作为独立程序调用。CI 使用的固定 FFmpeg 源码镜像与启用 GPL/libx264 的构建仅供测试，不因 Mioon 采用 Apache-2.0 而改变许可。相关说明见 [GitHub Actions 文档](docs/GITHUB-ACTIONS.zh-CN.md)。

导入的项目、媒体、LUT，以及模型或外部服务提供的内容，其权利和服务条款由对应来源决定。使用 Mioon 不会自动将这些内容改为 Apache-2.0。本说明不构成对全部历史媒体或第三方内容权利的认证。
