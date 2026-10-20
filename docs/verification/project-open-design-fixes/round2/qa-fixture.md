# 第二轮本地合成验收夹具

此夹具只准备 36 页状态检查所需的数据，不代表真实供应商或真实模型验收通过。脚本、源媒体、token 与数据库都位于专属 `/private/tmp` 目录，没有复制设计稿，没有修改现有工作区

- 脚本：`/private/tmp/mioon-round2-qa-lZuUke/qa-fixture.mjs`
- 环境参数：`/private/tmp/mioon-round2-qa-lZuUke/env.sh`
- `WORKSPACE=/private/tmp/mioon-round2-qa-lZuUke/workspace`
- 数据清单：`/private/tmp/mioon-round2-qa-lZuUke/fixture.json`
- token 只保存在该临时根目录及工作区的受限本地文件中，记录与终端输出不含值

## 启动

由主代理构建后，运行：

```sh
source /private/tmp/mioon-round2-qa-lZuUke/env.sh
TMPDIR=/private/tmp node "$QA_SCRIPT" --serve
```

默认使用工作树 `apps/web/dist`，随机空闲端口，不占用既有 QA 端口。可用 `QA_DIST` 指定新构建目录、`QA_PORT` 指定主代理选择的端口。服务启动后，地址、PID、工作区和 token 文件路径写入临时 `runtime.json`。按 Ctrl+C 或发送 SIGTERM 会关闭应用服务及回环模型服务

`--prepare` 幂等读取已有夹具，不会重复创建项目或任务；只有缺少 `fixture.json` 时才执行合成准备。准备阶段使用随机临时端口并在完成后关闭，当前没有留后台服务

## 已准备内容

- 项目“晨雾漫游 · 合成验收项目”，三个画板镜头、一张参考图和创作笔记
- 两个真实 MP4、一张 PNG、一段 48kHz 双声道 WAV，均通过管理导入 API 导入并验证 HTTP Range 返回 206 / 64 字节，源文件与导入素材 SHA256 记录在临时清单中
- 第一段 MP4 复用本轮自产 `design-36/final-export.mp4`，实际 1080×1920、10 秒，包含声音；第二段为 FFmpeg 本地色相变化、360×640、4 秒，图片提取自真实帧，音频为本地正弦波
- 时间线含两段视频与配乐，使用公共 `timeline.*` 操作建立，未加入可能依赖当前缺失字幕滤镜的字幕，便于继续实际导出
- 一个通过 Mock provider 公共生成提交形成的 `submission_unknown` 任务，保留真实的合成原 requestId
- 一个通过 Mock provider 公共提交形成的进行中任务；仅在临时夹具中延长 Mock 完成时间，便于持续截图，不会外发
- 两个显式合成版本各自拥有独立 `synthetic-mock` 素材，文件复制自上述实际导入的 MP4，使用既有发布器路径 `media/result-<jobId>.mp4`。原导入素材与时间线保持原样；新素材的字节数、SHA256、单一反向版本归属、job/version/snapshot 关联均已核对，并通过严格版本对比媒体描述符检查。这些记录由离线夹具建立，没有把 FFmpeg 缺少 drawtext 时的 Mock 生成当作成功；`generationSuccessVerified` 明确为 false
- 一轮实际 HTTP 回环文本回复与一轮通过真实 Agent 工具审阅流程产生的待审标题修改建议，模型端点仅绑定 `127.0.0.1`，回复含“本地合成回环夹具”标识。原建议尚未应用，项目和镜头 ID 见清单

准备脚本及启动冒烟不调用真实供应商、不读取供应商密钥，也不使用真实模型。每次启动会更新本地模型服务的随机端口，新的目标可能需要在 UI 重新授权；旧的待审建议和会话记录保留

## 实际验证

准备脚本成功退出；本地合成素材全部经过管理导入和 Range 检查。离线修正合成版本发布归属后已重启 `--serve`，两个版本均通过真实 `/api/version-comparison/media` Range 请求：206、`video/mp4`、64 字节，完整文件大小分别为 1,224,347 与 325,340 字节，结果写入临时清单。最终 36 页、四语言、最小窗口、主题及 Electron 的视觉/交互验证由主代理使用新构建继续执行
