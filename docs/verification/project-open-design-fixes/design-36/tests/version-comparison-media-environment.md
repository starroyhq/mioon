# 版本对比媒体测试：环境阻塞

原始结果：[version-comparison-media.test.tap](version-comparison-media.test.tap)，12项中11通过、1失败、0跳过。失败保留，不记作通过

失败项为 `comparison GET/HEAD/ranges serve exact production Mock-published version with no writes`。`tests/version-comparison-media.test.mjs:53` 在准备阶段要求真实worker完成Mock视频发布，实际任务进入 `failed`，错误为 `MOCK_RENDERER_UNSUPPORTED`：当前FFmpeg缺少 `drawtext` 滤镜。该项尚未进入HTTP、Range或无写入断言

独立只读核查：`/opt/homebrew/bin/ffmpeg` 为9.0.2；实际执行 `-hide_banner -filters` 退出码0，但滤镜表同时缺少 `drawtext` 与 `subtitles`。Mock provider在完成轮询时检查drawtext能力，在下载阶段也需要drawtext写入模拟视频标识；这是既有媒体环境能力限制

该测试文件、Mock provider及其能力检测、media runtime、worker jobs、版本对比媒体路由相对基线 `b8d6f4e` 均无改动。前端版本CSS不参与这条Node后端测试路径，没有证据表明本轮UI修改引入回归

其余11项实际通过，覆盖历史版本GET/HEAD/Range、无写入、身份与权限、所有权变更、文件替换/链接、锁丢失和恢复工作区拒绝。它们不能替代生产Mock发布链路这1项的验证

处理：不修改测试、不跳过断言、不安装或升级依赖。应在已包含drawtext的FFmpeg环境中，以真实路径TMPDIR、独立进程重跑本文件。UI视觉验收使用的本地合成MP4版本fixture不能冒充真实Mock生成发布成功
