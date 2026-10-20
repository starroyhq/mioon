# 36 页复验的代码与环境检查

2026-10-20，在 `codex/project-open-design-fixes` 工作树执行。本目录只记录工具链、受影响测试及环境核对；页面截图与 36 页对照由父记录提供

- `node scripts/tooling.ts typecheck` 退出 0
- `node scripts/tooling.ts build --channel=development` 退出 0；Web 与桌面 staging 内的 5 个 Web 文件逐字节相同，详见 [构建核对](build-artifacts.json)
- [76 个文件的选择清单](selection.txt)逐文件独立进程执行，`TMPDIR=/private/tmp`，禁用真实供应商，不转发凭据环境。普通文件外层超时 180 秒，真实导出 240 秒；各文件原有 node:test 超时仍保留
- 逐文件结果：**76/76 文件成功，1041/1041 测试通过，失败 0、跳过 0、取消 0，外层超时 0**。汇总见 [summary.json](summary.json)；串行子进程累计 156.648 秒
- [运行器](run-isolated.py)、[逐文件结果](isolated-results.json)、[工具命令与哈希](commands.json)保留供复查。该选择覆盖项目加载、首页、画板、设置、任务、助理、时间线、音频、导出及四语言基础约束，并非全仓测试

## 独立环境阻塞

[环境清单](environment.json)与[实际能力复现](capability-probes.json)记录：

- 当前为 macOS arm64、Node 26.9.0、FFmpeg/ffprobe 9.0.2。libx264、AAC、ebur128、loudnorm 可用；缺少 drawtext、subtitles、zscale、libwebp/libwebp_anim。依赖这些能力的模拟文字视频、烧录字幕、相关色彩/静态图路径不能在此环境判为通过
- 系统是 bsdtar 3.5.3，未发现 gtar；实际 `tar --sort=name` 被拒绝。GNU tar 专用归档路径仍为环境阻塞
- 对完整测试启动器只做一个显式单文件的准入探测，退出 2、`NATIVE_TEST_LANE_BLOCKED`，在测试执行前拒绝。该拒绝不是测试通过或跳过，也没有启动全量 772 文件
- 本工作树 Electron 44.7.0 依赖目录只有包元数据，没有原生 dist。已定位此前存在的 44.7.0 原生运行时，路径记录在环境清单并交给主代理；本代理未启动它。新 staging 构建成功不等于原生窗口验收通过

未安装、升级或清空依赖，未调用外部供应商或模型，未修改应用代码，未提交或推送
