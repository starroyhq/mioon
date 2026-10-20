# 第二轮修复与验收

历史记录：本轮实现已提交为 `01a83cb`，未推送。其截图后来被第三轮设计检查指出 R1–R7 差异，不能作为设计全量通过结论；后续处理见 [第三轮记录](../round3/README.md)。下文保留当时的执行与测试状态

以本地私有第二轮设计检查的 P1/P2/P3 为清单，并包含用户明确授权的真实生成总开关、自动备份与恢复、任务处置能力。工作基线为 `b8d6f4e7897d0d32aeb07749a6605637787de4f6`，修改保留在 `codex/project-open-design-fixes` 工作树，尚未提交或推送

本报告区分代码修复、实际操作、截图目检和环境阻塞。设计源及设计导出图仍在忽略目录，没有复制到交付证据或纳入 Git；原工作区及其无关待办文档未改动

完整文件清单见 [changed-files.json](changed-files.json)，区分应用/共享包、测试、说明文档和验收产物

## 修复范围

- 项目初次加载的空状态不再令主体库读取空 `view.list` 而白屏；新建、打开、刷新自动进入项目均使用真实浏览器检查
- 画板版本页签、版本卡及对比、镜头分段控件、生成进度、助理授权与修改建议重新整理；内部身份保留在可展开详情中
- 任务计数和列表同源，进行中与待处理分组，详情使用键值表；新增持久本地失败标记、归档已完成记录和复制 ID，保留未知请求的原始身份与对账要求
- 剪辑默认轨道名本地化，补显示、静音、锁定与媒体类型颜色；音频属性补滑块、包络和响度入口；最小时间线优先显示 V1/A1
- 导出按检查、设置、确认、进行中、完成与记录重新组织；进度显示真实阶段，不编造百分比、大小或用时；完成页及历史使用已登记输出的真实规格和大小
- 设置补可持久保存的真实生成总开关、空闲自动备份、导入下载、确认恢复与原生重启；模型、工作区、视频工具使用固定底部状态栏
- 独立审查发现并修复两处导出取消竞态：确认期间 queued→running 后调用最新回调；旧导出在 link 后、数据库发布前取消时，只清理精确所属 inode，保留替换文件和已发布成片

使用说明：[工作区设置与备份](../../../WORKSPACE-SETTINGS.md)、[任务处置](../../../TASK-DISPOSITIONS.md)、[导出控制](../../../EXPORT-CONTROLS.md)

## 视觉与交互证据

- [36 页截图索引](SCREENS.md)、[逐页清单](coverage.json)与[独立目检](visual-review.md)：按实际页面状态截图，没有用静态 DOM 或假响应填补业务状态
- [64 张语言、主题、尺寸矩阵](matrix.json)：设置、剪辑、导出记录、任务中心 × 简体中文/繁体中文/英语/日语 × 深色/浅色 × 1440×900/1050×680；这是四类代表页面矩阵，不是声称每个设计页都做了全部组合
- [跟随系统](follow-system-theme.json)：浅色系统为 `light`，深色系统为 `dark`
- 版本卡等实际媒体解码完成后再截图；助理修改建议来自本机回环模型产生的真实持久提案，保持待处理，没有调用真实模型服务
- 音频属性的上部控件和底部响度分别见 [音频](screens/editing-05.png)、[响度](screens/editing-05-loudness.png)，长面板可滚动，不以一张首屏图冒充全部内容

## 实际业务验证

HTTP、真实 CLI 与官方 MCP 共用严格契约。新增操作的四语言发现及 schema 已通过定向验证；内置助理模型工具没有获得工作区设置、备份、任务处置或自我授权能力。恢复分支的显式拒绝清单同步列出全部新增操作，保持原权限边界

- [三种规格的真实 MP4 与 ffprobe](three-presets.json)：1080×1920、1920×1080、1080×1080，均为 30fps；[竖屏成片](formal-export.mp4)、[横屏成片](preset-landscape_1080.mp4)、[方形成片](preset-square_1080.mp4)
- [取消导出](export-cancellation.json)：真实运行任务经确认后取消，保留 `failed`/`EXPORT_CANCELLED` 原记录，无输出资产或成片文件；已经在后台完成的导出仍保留。link 发布窗口的四个归属边界另由真实 worker 回归验证
- [任务处置](task-disposition-browser.json)：复制 ID、本地失败标记、清除已完成经真实界面执行；未知任务原 requestId、提交身份及快照保持，活跃轮询仍可正常更新轮询时间与修订号
- [桌面备份与恢复](native-verification.json)：系统目录选择器、立即备份、自动备份偏好、确认恢复、受限原生重启均实际操作；普通 schema 50 恢复为受保护 schema 51，原工作区保留
- [原生文件入口](native-file-actions.json)：受限 broker 核对归属与内容后，在 Finder 选中对应 MP4，并交由系统默认播放器打开；[原生剪辑窗口](screens/native-editing-window.png)

合成夹具的来源和限制见 [qa-fixture.md](qa-fixture.md)。其中的已发布版本使用本地合成媒体和明确模拟来源，不能视为真实供应商生成成功验收

## 测试与工具链

首轮逐文件运行 772 个测试文件，每文件独立 Node 进程、真实路径 `TMPDIR=/private/tmp`、最多 3 路、外层 180 秒，并保留测试自身时限。初始结果为 648 个文件退出 0、124 个文件非零，其中 8 个被外层超时终止；TAP 汇总为 11,551 pass、383 fail、2 skipped，另有未完成的测试取消。原始结果不因后续复验而覆盖：[文件清单](full-test-files.json)、[初始结果](full-test-results.json)

修复后的完整文件复验与最终分类单独记录；不把部分 `test-name-pattern` 通过算作整文件通过，也不把初轮与复验相加当成一次全绿运行

- [界面复验](ui-retest-results.json)、[界面夹具说明](ui-test-triage.md)
- [schema 与历史夹具说明](schema-fixture-validation.md)
- [服务、原生与环境分类](settings-test-triage.md)
- [纯 HEAD 的 8 文件媒体基线对照](baseline-media-results.json)：冻结离线安装后运行，相同失败路径与计数在未修改基线重现

全量使用现有 `/opt/homebrew/bin/node` v26.9.0；固定历史证据测试另使用已有 Node v24.21.0，保持版本 pin。没有安装或升级依赖。[来源核对](source-audit.json)确认 15 个官方 Base UI 组件与 HEAD 逐字节相同，依赖清单和锁文件未变

最终分类见 [TESTS.md](TESTS.md) 和 [test-disposition.json](test-disposition.json)：746 个文件有通过证据（648 个初轮通过、98 个失败后整文件复验通过），26 个环境阻塞，0 个未分类。此结果不等于完整测试全绿，也没有将定向复验描述为第二次冻结后的 772 文件全套重跑

`node scripts/tooling.ts typecheck`、`node scripts/tooling.ts build --channel=development` 均退出 0；最后的提示浮层点击修正后，Web 构建与含类型门禁的桌面开发构建再次退出 0。`typecheck-runtime` 完整 5/5、组件来源完整 29/29、提示/紧凑栏/音频预览完整 43/43 通过。[最终浏览器检查](browser-final-checks.json)实际确认 Tooltip 定位层不再拦截设置入口、紧凑项目入口有名称、64 张矩阵无整页越界且无 page error

原始和复验日志共 958 份归档于 [validation-logs.tar.gz](validation-logs.tar.gz)，原路径及哈希见 [validation-log-index.json](validation-log-index.json)；未包含设计源或工作区数据库。后续独立交付核对见 [delivery-audit.md](delivery-audit.md)

## 环境阻塞与验收边界

- 当前 Homebrew FFmpeg 9.0.2 缺少 `drawtext`、`subtitles`、`zscale` 和 `libwebp` 编码器；小尺寸直接探针及纯 HEAD 对照均复现，不能将相关真实媒体路径判为通过
- macOS BSD tar 不支持测试要求的 GNU tar 格式，当前没有 `gtar`；字幕包对应路径单独阻塞
- 官方完整测试启动器在 macOS 返回 `NATIVE_TEST_LANE_BLOCKED`，因此另行逐文件运行；启动器拒绝本身没有记作通过
- 原生截图确认交通灯与标题没有重叠。激活颜色被系统的控制状态指示条遮住，未完成该项目检；没有以灰色非激活截图冒充激活颜色通过
- 没有真实供应商或外部模型调用，没有推送、发布或新增依赖

一次原生验收启动误写了隔离数据目录环境变量，进入开发频道默认目录；该实例已停止，未创建或删除其中的项目，默认目录未清理。后续原生文件验收使用明确的独立数据副本。这一偏差保留记录，不作为隔离验证成功的一部分
