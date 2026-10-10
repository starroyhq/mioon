# Mioon · 视频创作工作台

个人、本地优先的视频画布与多轨剪辑工作台。简体中文界面；项目、素材、分镜、任务与版本持久化。Web UI、HTTP API、CLI 和 MCP 使用同一个后端业务服务。采用 Electron + pnpm monorepo：桌面壳、Web、HTTP、MCP 独立工作区，共用 Node 24 + SQLite 业务层；通用界面组件使用官方 shadcn/ui 的 Base UI（base-nova）版本，画布保留 React Flow。FFmpeg 执行真实多轨合成。V4 提供 Runway、火山方舟 Seedance、Gemini Veo、MiniMax H3 和 Vidu Q3 Turbo 五个平台的适配器，以及本地模拟供应商。真实生成尚未执行；供应商能力由模型、输入方式及后端安全配置共同决定。

## 安装与启动

源码开发要求 Node.js 24 或更新版本、pnpm 11.25.0，以及 FFmpeg/ffprobe。测试浏览器需要 Python 3、Playwright 和 Chromium。所有依赖由根目录 pnpm-lock.yaml 锁定。

```sh
pnpm install --frozen-lockfile
pnpm run doctor
pnpm build
```

已安装依赖时，也可直接运行无 shell 包装的 `node scripts/tooling.mjs doctor`、`node scripts/tooling.mjs build` 和 `node scripts/tooling.mjs test`（默认 66 项可移植检查，不等于完整回归）。完整 Linux 回归使用 `node scripts/tooling.mjs test --suite=full --concurrency=1`。检查通过不代表 macOS/Windows 原生发布就绪；退出码、平台阻塞项和运行范围见 [本地构建与可移植检查](docs/PORTABLE-TOOLING.md)。

启动 Electron 桌面开发版：

```sh
pnpm desktop:build
pnpm desktop
```

桌面版把 Electron 内置的 Node 用于独立业务进程；渲染器禁用 Node 并启用 sandbox/contextIsolation。初次启动会让你选择本机 FFmpeg 和 ffprobe 可执行文件，也可用 MIOON_FFMPEG_PATH、MIOON_FFPROBE_PATH 提供绝对路径。它们是明确的外部运行要求，并没有捆绑进安装包。正式版 ID 为 `app.starroy.mioon`，开发版为 `app.starroy.mioon.dev`；源码启动默认开发版，两个渠道使用独立的 userData 路径，初次启动自动登录本地服务。详见 [桌面运行和数据迁移](docs/DESKTOP.md)。

首次无密钥试用按[十步工作区指南](docs/WORKSPACE-GUIDE.zh-CN.md)完成导入、模拟版本、剪辑与真实 MP4 导出。Mac 源码启动见 [Mac 试用指南](docs/MAC-SOURCE-TRIAL.zh-CN.md)与[原生检查表](docs/MAC-TRIAL-CHECKLIST.zh-CN.md)；当前尚无已验证的 Mac 安装包，历史 V3 Linux 二进制不代表本次源码。

继续使用浏览器入口：

```sh
pnpm start
```

打开 http://127.0.0.1:4318 。首次启动在 `data/access-token` 创建仅本机可读的访问令牌；在终端读取该文件，把它填入本地登录框。不要把令牌或供应商密钥发到聊天、URL 或公开文件中。可用 `MIOON_TOKEN` 环境变量替代令牌文件，长度至少20字符。`PORT` 更改端口；`MIOON_DATA_DIR` 指定数据目录。

```sh
cat data/access-token
```

默认只监听回环地址，不是公网网站。云端开发时显示的 localhost 只属于开发环境；下载本项目后在自己的电脑执行上述命令才可在自己的浏览器打开。Electron 的 macOS 打包配置已提供；本轮运行在 Linux 云电脑，不能据此声称 Mac 原生运行、签名或公证通过。

操作说明见 `docs/WORKSPACE-GUIDE.zh-CN.md`；实际截图见 `evidence/v3-browser/deliverable-region-guide.png`。

## Agent 直接操作：CLI、MCP 和 Skill

安装依赖后，仓库内即可执行真正的 CLI：

```sh
pnpm exec mioon --help
pnpm exec mioon schema generation.submit
```

连接运行中的 Web 服务时，使用私有令牌文件而非命令行令牌：

```sh
MIOON_BASE_URL=http://127.0.0.1:4318 MIOON_TOKEN_FILE=/absolute/path/to/data/access-token pnpm exec mioon doctor
```

连接 Electron 时改用 `MIOON_CONNECTION_FILE` 指向桌面 userData 中的 `mcp-connection.json`，客户端每次请求重新读取，适应端口和令牌轮换。CLI 与真实 stdio MCP 均调用同一后端，不另开数据库。

- [CLI 命令、JSON、退出码与视频下载](docs/CLI.md)
- [Codex / Claude Code MCP 配置](docs/MCP.md)
- [可独立复制的 mioon Skill](skills/mioon/SKILL.md)
- [纯本地完整示例](skills/mioon/references/mock-workflow.md)：导入 → 分镜 → 模拟生成 → 选择版本 → 时间线 → MP4 导出

Skill 包仅供手动安装/发现，不自动修改任何 agent 全局配置；也不构成真实生成授权。所有命令有共享运行时 schema。收费请求需保留原始 requestId；未知提交先对账，不能盲目换 ID 重发。

## 五个平台的生成配置

在镜头属性中选择服务商、模型和文生/图生方式，查看实际支持的比例、时长及配置状态。浏览器只显示变量名称和缺失项，不读取、保存或显示 API 密钥。画布与属性面板使用同一份生成选择。

本版窄范围适配：Runway Gen-4 Turbo；Seedance 2.5；Gemini Veo 3.1 preview；MiniMax H3 V2；Vidu Q3 Turbo。以 `provider list` 的实时能力为准，详见 [官方文档与实现矩阵](docs/PROVIDERS.md)。MiniMax/Vidu 的 `global` 与 `cn` 区域由后端明确配置，绝不跨区回退。Vidu 未找到可验证的默认输出 CDN，因此还需独立核实并配置精确的 `VIDU_OUTPUT_HOSTS` 后才能提交。

所有真实调用默认关闭。启用前须另行确认服务商/模型、提示词与素材范围、次数、总金额上限，并安全设置后端密钥。`*_MAX_GENERATIONS` 是当前数据目录内的保守次数上限，不能保证美元支出；账户计费和预算也须核实。官方历史 Sora API 已停用，本版不暴露假装可用的 Sora 适配器。

独立的图像生成另有[Images 设置与逐次付费确认](docs/IMAGE-ACTIVATION.md)：固定 OpenAI 预设及独立密钥已实现，受影响测试、构建与 Linux 原生合成网络验收已通过，最终全量检查 2758 项（2756 通过、2 跳过、0 失败）已通过；尚未建立真实供应商或 macOS/Windows 验收证据。

## 同一项目，两种工作模式

顶部“画板 / 剪辑”是同一个项目的两种工作空间。一次只挂载当前模式，不再把画布、预览、分镜和时间线同时挤在一屏。

- 画板：左侧素材库、中央无限画布、右侧镜头/节点属性。用于构思、首帧参考连线、生成和比较版本；不显示时间线，分镜顺序默认收起。
- 剪辑：左侧素材库、中央大预览、右侧片段属性，下方横跨工作区的多轨时间线。用于编排、预览和导出；不显示分镜板或 React Flow 画布。
- 每个项目分别持久记住当前模式、画板缩放/位置和选择，以及剪辑的片段选择、播放头、时间线缩放/滚动与面板状态。打开项目后，从本地后端恢复同一用户的共享视图；Electron 正常退出重启后仍可恢复，临时认证会话与随机端口保持不变。此功能不记住全局“最后打开的项目”。多窗口冲突会停止保存并提示载入已保存视图；自由搜索文本只留在当前界面。模式切换不保存未提交的属性草稿：有修改时先确认保存或放弃，取消会留在原处。详见[视图偏好与退出限制](docs/WORKSPACE-PREFERENCES.md)及[重启验收](docs/ACCEPTANCE-WORKSPACE-PREFERENCES.md)。
- 面板固定在工作区边缘，以留白、圆角和阴影呈现。拖动左右面板内侧边缘调整宽度，拖动时间线上边缘调整高度；减号收起，边缘入口或顶部“面板”菜单可重新展开。画板和剪辑分别保存尺寸与开关，收起属性不会丢草稿，隐藏的媒体会暂停。画板收起面板只露出更多画布，不自动缩放或移动；剪辑始终为预览保留独立空间。“重置当前工作区布局”只恢复当前模式面板，不改素材、播放头或时间线历史。详见[固定面板验收](docs/ACCEPTANCE-DOCKABLE-PANELS.md)。
- “加入时间线”是明确的跨模式入口，成功加入后打开剪辑。片段保存的是加入时的素材引用，后续选用新版本不会替换已有片段。
- 片段属性中的“返回来源”回到画板；生成素材定位到对应镜头的确切历史版本，标记来源但不改选该镜头当前使用的版本。原始导入素材定位到唯一关联节点，找不到唯一节点时只查看素材。

详细说明见 [双模式使用指南](docs/WORKSPACE-GUIDE.zh-CN.md)；本次验证见 [双模式验收](docs/ACCEPTANCE-DUAL-WORKSPACE.md)。

时间线固定30fps、720×1280输出，默认两条画面轨和一条音频轨。视频轨可放图片/视频，音频轨可放WAV/MP3/M4A。同轨片段不能重叠，跨轨可叠放；画面轨层级越高越靠上。预览由真实FFmpeg渲染，和多轨导出使用相同合成器；修改后需要更新预览，旧快照会明确提示。

选择一个片段，将播放头移到片段内部的整数帧，然后点击“分割”或按 Cmd/Ctrl+B。只分割所选片段，左段保留原 ID，右段拥有固定新 ID；源范围、画面位置、音量和素材版本保持不变，总时长不变，不移动其他片段。可一次撤销/重做。起止边界、未保存修改、待确认请求、离线或同步期间禁用；输入框、输入法和弹窗保留自己的快捷键。详见[分割验收](docs/ACCEPTANCE-CLIP-SPLIT.md)。

时间线工具栏支持持久化撤销/重做与 Cmd/Ctrl+Z、Cmd/Ctrl+Shift+Z（Ctrl+Y）。轨道、片段及从分镜导入的编辑均可恢复，重启后保留历史；撤销不影响生成任务、已选版本、素材或导出，也不会撤销服务商花费。CLI/MCP 使用相同的时间线历史服务。

旧项目升级只新增空时间线，不自动改变分镜或复制片段。可以明确执行“从分镜导入”，仅对空时间线生效；导入后片段固定引用当时选中的素材，后续切换生成版本不会悄悄替换它。原来的按分镜顺序导出继续独立可用。详细规则见 `docs/TIMELINE.md`。

## 原有分镜创作流程

1. 创建项目，导入 PNG/JPEG/WebP 图片、MP4/WebM 视频或 WAV/MP3/M4A 音频（每个≤30 MiB）
2. 添加镜头，按模型选择文生视频或一张首帧参考图，填写提示词、画幅和时长
3. 拖拽/缩放画布；拖动位置不会改变成片顺序，用镜头顺序控件排序
4. 选择模拟供应商生成，等待真实测试 MP4 落盘；模拟片带明显水印
5. 重新生成保留旧版本，比较两个视频，选择想要的版本
6. 每个镜头选定一个版本后导出，按镜头顺序生成720×1280、H.264/AAC MP4；素材有声音则保留并统一格式，无声段补静音

支持文本、图片、视频、音频节点与连线。任务失败可以显式重试；提交结果未知时不会自动重新发起生成。停止等待仅停止本地轮询，不表示供应商任务已取消。

图片节点可通过“首帧参考”连接向镜头提供真正的生成输入：使用已导入的项目内图片，每个镜头只连接一张。手选参考图需明确清除并保存后才能连接，已有连线需先断开再换图，避免覆盖选择。断开会清除该镜头的连线参考选择，但保留原图、节点及正在生成任务的固定快照。旧连线与普通连线明确标注为“视觉连线 · 不参与生成”；不执行通用节点图、不传递提示词，也不承诺角色或风格一致性。模型支持范围仍在生成时验证。HTTP/CLI/MCP 共用 `reference.attach` / `reference.detach` 与持久化精确请求恢复，详见 [接口契约](docs/CONTRACT.md#typed-first-frame-connections)。

## 合成示例

保持服务运行，在同一电脑的另一个终端执行：

```sh
pnpm demo
```

这会创建 Stanley × Maltese 五镜头×2秒的故事数据样例并生成10秒测试拼接。故事包含追星、接星、印花姿势对位、随行杯与宠物碗、双产品定格。图片为自制测试图形；视频为 FFmpeg 运动测试片。不是品牌广告或模型成片，不能用作真实产品细节依据。原始授权产品图仍需从用户指定的电脑另行导入；本项目没有访问或改动那些文件。

## 多轨合成示例

`examples/multitrack-project/` 是独立的10秒原创几何演示：两段主画面、中间1秒主画面间隙、上层星形卡片画中画，以及独立音频与源内裁剪。素材由脚本生成，不使用任何用户素材或真实供应商。

```sh
node apps/desktop/scripts/migrate-data.mjs --source="$PWD/examples/multitrack-project" --destination="$PWD/data-multitrack/workspace"
MIOON_DATA_DIR=./data-multitrack/workspace pnpm start
```

首次启动后读取该目录新生成的访问令牌并登录。要从头复现到新的私有目录，运行 `MIOON_V2_DEMO_DIR="$PWD/data-timeline-demo" pnpm demo:timeline`；它生成测试素材，并自行启动/关闭后端。需要 Python 3 + Pillow。已有同名示例会复用，不自动重复创建片段。

## 测试

```sh
pnpm test
pnpm test:browser
pnpm test:timeline
pnpm test:browser:timeline
```

`pnpm test` 启动隔离的后端进程并做真实 HTTP、真实 MCP SDK、SIGKILL/重启、并发幂等、冲突、不可变版本和导出验证；供应商测试使用注入 HTTP，不调用真实供应商。已有 Python 浏览器套件保留为历史验收，部分选择器与任务恢复路径仍待刷新，不代表当前全部通过。新的 `python3 tests/browser_first_trial.py --repo "$PWD" --out "$PWD/evidence/first-trial-唯一运行名"`（或 `pnpm test:browser:first-trial` 加同样参数）是可供本机执行的独立试用脚本；本次只做静态核对，未运行该脚本。当前 Linux 原生 CUA 全流程与实际另存为已独立验收，见[首次试用验收](docs/ACCEPTANCE-FIRST-TRIAL.md)；不代表 Mac 或 Windows 原生通过，也不能用脚本存在替代验收。V4 验收见 `docs/ACCEPTANCE-V4.md`；V3 历史桌面打包证据见 `docs/ACCEPTANCE-V3.md`，更早记录保留在 `docs/ACCEPTANCE.md`。

## 数据与恢复

Web入口的业务数据在 `MIOON_DATA_DIR`（默认 `data/`）：SQLite WAL、managed media、访问令牌。桌面入口使用 `MIOON_DESKTOP_USER_DATA` 下的 `workspace/`，见桌面指南。单个数据目录只能运行一个后端。复制/备份前正常关闭后端；整体复制数据目录，包含媒体，不只复制数据库。不要改写结果文件。重启会继续查询已知供应商任务和下载，未知提交先对账。

若电脑异常重启留下 `server.lock`，正常启动会检查原进程并清理失效锁。不要在仍有后端运行时移除锁。应用本身不依赖云同步，开发云电脑文件不能当成永久托管或唯一备份。

## API、MCP 与供应商

- `docs/API.md`：认证、操作、错误及客户端示例
- `docs/MCP.md`：本地 MCP 配置和协议验证
- `docs/PROVIDERS.md`：真实适配器、官方依据和扩展接口
- [供应商试用准备](docs/PROVIDER-TRIAL-READINESS.zh-CN.md)：模型/区域时效与文档、离线、真实验证的区别
- [未来真实核验确认表](docs/LIVE-VERIFICATION-APPROVAL.zh-CN.md)：素材、次数、报价与费用边界；该表本身不授权调用
- `docs/CONTRACT.md`：完整字段和业务不变量

真实生成默认禁用。准备一次联调需确认供应商/模型、授权图片范围、次数和金额上限，并在本机后端安全配置。仅实现适配器和通过离线测试，不代表真实生成已验证；A9明确待真实验证。

## 当前边界

单用户本地应用；无云同步、复杂转场、关键帧动画、变速、多人协作或账号支付。支持最多12条轨道、100个片段、10分钟的轻量多轨合成；画面输出固定为720×1280/30fps。时间线预览需要渲染，不是实时任意效果编辑器。真实生成可能产生成本；本地模拟与下游供应商费用不同。密钥只由后端读取，业务JSON中没有密钥。

架构已明确采用 Electron。本版包含 Linux 本地桌面构建及 macOS 构建配置；Mac 原生运行、签名、公证、系统密钥库与自动升级仍需真实 macOS 环境和另行授权验证。没有自动发布、部署、签名或上传应用。

For a prebuilt example, first copy the closed sample into a new private workspace using the commands in [examples/README.md](examples/README.md), then start that copy. A broadly readable sample directory is intentionally refused; existing data is never chmodded automatically. The delivered sample contains no login token or API key. See [private-storage recovery](docs/PRIVATE-STORAGE.md).


## Monorepo 和开发入口

- apps/desktop：Electron 安全桌面壳和 utilityProcess 业务进程
- apps/web：React/Vite + React Flow 专用编辑区域
- apps/server、apps/mcp、apps/cli：HTTP、官方 SDK MCP 与真正的 CLI 入口
- packages/client：本地 HTTP、私有连接文件、schema 发现、watch 与下载的共享客户端
- packages/business、packages/contracts：唯一业务实现、持久化和共享协议
- packages/ui：官方 shadcn/ui Base UI 组件、通用适配与样式 token

详细决策见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)；组件来源和校验见 [UI-COMPONENTS.md](docs/UI-COMPONENTS.md)。原有 server/index.mjs 与 server/mcp.mjs 仅为兼容启动器。

热更新开发：先在一个终端运行 pnpm start（默认4318），另一个终端运行 pnpm dev:web（固定5173）。开发代理先检查浏览器 Host/Origin，再转发至4318；生产后端没有为开发模式放宽来源校验。

```sh
pnpm desktop:package:linux
pnpm test:desktop
```

Linux 打包为本地未签名 tar.gz，发布被关闭。构建输出及准确验证边界以 docs/ACCEPTANCE-V3.md 为准；原 v1/v2 交付包保持原样。

当前源码版本为 0.4.1（V4.1 应用 ID 补丁）。V4.1 的构建渠道、独立数据目录和旧数据复制说明见 [DESKTOP.md](docs/DESKTOP.md)，本轮验收见 [ACCEPTANCE-V4.1.md](docs/ACCEPTANCE-V4.1.md)。保留的 `video-workbench-0.3.0-linux-x64.tar.gz` 是历史 V3 包，不含 V4 新服务商与 CLI。V4 本次交付以源码和可复用 Skill 为准，桌面源码构建与运行验证单独记录；不把历史二进制称为已更新。

## Mioon 命名更新

当前产品、窗口、登录界面、桌面程序、CLI 和 MCP 统一为 Mioon。命令是 `pnpm exec mioon`，workspace 包是 `@mioon/*`，环境变量改用 `MIOON_*`（包括 `MIOON_ENABLE_LIVE_PROVIDER`）。旧命令、包名和环境变量不设兼容别名；请更新本机启动脚本与客户端配置。完整范围、升级与数据保护说明见 [Mioon 升级指南](docs/MIOON-MIGRATION.md)。

### Timeline drag snapping

Editing now has per-project magnetic snapping (default on): drag either edge near
another clip boundary, the playhead or zero to align within 8 screen pixels. Hold
Alt for free placement. The live span/guide is exactly the dropped integer frame;
red overlap/type-invalid destinations never submit. Known media lengths and the
explicit 90-frame image default support asset drops; unknown-duration media cannot
be inserted. Explicit CLI/MCP frames are unchanged. [Acceptance and limits](docs/ACCEPTANCE-TIMELINE-SNAPPING.md).
