# 第三方声明

Mioon 原创代码与文档采用根目录 [Apache License 2.0](LICENSE)。以下第三方内容保留各自的版权与许可，项目许可证不替代这些声明；其原始声明文件应随对应内容保留。

## 仓库内的第三方内容

| 内容 | 许可与来源 | 仓库内声明 |
| --- | --- | --- |
| shadcn/ui 衍生组件 | MIT，Copyright (c) 2023 shadcn | [LICENSE.shadcn.md](packages/ui/src/LICENSE.shadcn.md)；组件来源见 [UI-COMPONENTS.md](docs/UI-COMPONENTS.md) |
| 供应商 SVG 图标 | LobeHub Lobe Icons，MIT；固定版本与提交见原声明。供应商名称和商标归各自权利人 | [LICENSE](apps/web/public/provider-icons/LICENSE)、[NOTICE.txt](apps/web/public/provider-icons/NOTICE.txt) |
| 内置字幕字体 | Noto Sans CJK SC 2.004，SIL Open Font License 1.1 | [OFL-1.1.txt](packages/business/resources/subtitles/OFL-1.1.txt)、[SOURCE-COPYRIGHT.txt](packages/business/resources/subtitles/SOURCE-COPYRIGHT.txt)、[提取与来源说明](packages/business/resources/subtitles/README.md) |

字体来源文件中的 Debian 包装许可说明不改变字体本身的 OFL 许可。项目的 Apache-2.0 声明也不改变供应商商标的使用条件。

## 依赖与桌面产物

JavaScript/Node.js 依赖的版本由 `pnpm-lock.yaml` 固定，各依赖遵循其上游许可。桌面构建会沿实际打包依赖图收集上游 LICENSE、COPYING、NOTICE 等文件，并生成 `licenses/THIRD-PARTY-NOTICES.md`；这是随包依赖通知，不是根目录本文件的副本。

项目自身的 `LICENSE`、`NOTICE` 和本文件另存为桌面产物中的 `licenses/Mioon-LICENSE.txt`、`licenses/Mioon-NOTICE.txt` 和 `licenses/Mioon-THIRD-PARTY-NOTICES.md`。内置图标及字幕字体的原始声明也会随对应资源保留。

Electron 与 Chromium 使用目标运行时发行包提供的原始通知：macOS 位于 `.app/Contents/Resources/licenses/`，Linux 位于可执行文件旁。具体收集与验证方式见 [桌面说明](docs/DESKTOP.md)。

已知上游缺口：`mmx-cli@1.0.28` 的发布包 README 声明 MIT，但发布包未附 LICENSE 全文及 `package.json` 的许可字段。构建会如实保存该 README 声明的来源与缺口，不自行补造其版权声明或许可证正文。

## 外部工具与用户内容

FFmpeg、ffprobe 由用户单独安装，不随当前 Mioon 桌面安装包捆绑；其工具、编码器和构建选项适用各自许可。CI 使用的固定 FFmpeg 源码镜像与启用 GPL/libx264 的构建仅供测试，不因 Mioon 采用 Apache-2.0 而改变许可。相关说明见 [GitHub Actions 文档](docs/GITHUB-ACTIONS.zh-CN.md)。

导入的项目、媒体、LUT，以及模型或外部服务提供的内容，其权利和服务条款由对应来源决定。使用 Mioon 不会自动将这些内容改为 Apache-2.0。本说明不构成对全部历史媒体或第三方内容权利的认证。
