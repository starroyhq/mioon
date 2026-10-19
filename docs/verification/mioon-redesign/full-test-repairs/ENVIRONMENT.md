# 环境阻塞与已修代码问题

本机 FFmpeg/ffprobe 均为 9.0.2。真实滤镜列表没有 `drawtext`、`subtitles`；Mock 同款图的实际 stderr 为 `No such filter: 'drawtext'`，见[修复前诊断](media-diagnostics/mock-diagnostics.json)。真实 H264 正对照及 ffprobe 成功，说明不能把所有本地媒体错误都归因编码器不可用。

## 已修代码

- FFmpeg 列表的精确 `------` 表头分隔行曾导致能力结果变成 unknown，Mock 持续重试。修复后真实 poll 为 `MOCK_RENDERER_UNSUPPORTED`、不可重试；三次对账保持同一任务，一次提交，见[修复后账本](media-diagnostics/mock-diagnostics-after.json)。未知行、重复/错误分隔符、取消、未确认终止及工具替换仍保持原边界。
- 原字幕测量首先报 `Unrecognized option 'filter_script:v'`，并非首先缺滤镜。两个脚本选项现用 `-/filter:v`、`-/filter_complex` 读取同一受控文件，当前二进制实测成功；[FFmpeg 手册](https://ffmpeg.org/ffmpeg.html#Options)与[7.1.5 固定文档](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.1.5/doc/fftools-common-opts.texi)均说明文件参数语法。未运行 7.1.5 二进制。
- 修复后真实字幕生产调用已越过参数解析，现明确报缺 `drawtext`，见[字幕原样调用](media-diagnostics/subtitle-diagnostics-after.json)。新回归使用真实 FFmpeg、特殊字符文件路径及逐像素断言；旧渲染回归仅允许两组明确参数别名，其他参数、脚本和 concat 字节仍严格相等。

## 仍受阻范围

原10文件中的 `cli-v4`、`integration`、`mcp`、`timeline-mcp`、`timeline-media` 真实成功链依赖 Mock 生成；当前返回不可重试的能力错误，后续版本、导出及冲突断言可能级联失败。`export-settings-media` 的字幕首例仍因缺 `drawtext` 受阻。各文件具体子项见最终逐文件报告，不把级联断言当成独立滤镜错误。

`subject-video-provider` 另有真实 Mock poll 成功预期，保留原断言。该TAP只打印状态；结合就绪、未取消的合成任务与唯一失败分支，推断为同一 `drawtext` 环境前提，未伪称日志打印了错误码。多流媒体测试的受控适配器原本自定义下载，现配套明确的已存在/未取消/已就绪任务完成状态；它继续执行真实多流 MP4 发布、音频、像素与导出检查，不证明真实 Mock 渲染成功。

没有安装或替换媒体工具，没有调用真实供应商，没有新增 skip，也没有将去掉 `drawtext` 的诊断正对照用作生产 fallback。

macOS 正式 `tooling test --suite=full` 仍退出2并报告 `NATIVE_TEST_LANE_BLOCKED`。另行逐文件执行全部当前测试；这不等同 Linux 发布门禁。300毫秒合成启动时序用例曾在并发调度下提前到 startup 截止，原样串行12/12通过；最终轮将它安排在其他进程结束后执行，生产10秒及测试300毫秒均未改动。
