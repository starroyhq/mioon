# SP-Q 变速整体验收

使用 Node.js 24、已安装仓库依赖的集成工作树，以及能编码 H.264、生成或解码合成素材的 FFmpeg 和 ffprobe。脚本使用开发渠道和 `MIOON_FORMAT6_DEV=1` 启动隔离的项目服务。关开关的场景单独使用 `MIOON_FORMAT6_DEV=0`。

```sh
node scripts/speed-acceptance/run.mjs --list
node scripts/speed-acceptance/run.mjs --repo /path/to/integration-checkout
node scripts/speed-acceptance/run.mjs --repo /path/to/integration-checkout --case four-entry-parity
```

可以重复传 `--case`。脚本所在的工作树可与 `--repo` 不同。脚本 PR 基于 main。要跑全套，目标工作树需包含 SP-D、SP-P、SP-E、SP-I、SP-V 和已经接入的变速界面。当前项目服务版本的局限会按场景列在结果中。

| 场景 | 检查 |
| --- | --- |
| `format6-create-upgrade` | 走开发渠道的新建、重开及升级入口，核对格式 6 和开关。 |
| `four-entry-parity` | 同一个源片段分别走界面用的项目 HTTP RPC、源码 CLI、官方 SDK 的 MCP stdio、Mio 审批。比较 2× 与 17 帧定格后的完整投影，核对重放及撤销。HTTP、CLI、MCP 再核对重做结果。Mio 只替换模型网关。 |
| `preview-export-frame-ordinals` | 逐帧解码并对比常速、正／倒放曲线、定格的源帧和输出 PTS。 |
| `preview-export-audio-pcm` | 比较连续及按片预览与实际导出准备的 PCM 样本，检查常速保音调、曲线变调、倒放以及定格静音。 |
| `export-interpolation-modes` | 复用正式渲染的 off、blend、optical 合成样片，检查三档及缺失或无效代理的拒绝。 |
| `project-preview-proxy-media` | 真实项目预览 RPC，检查原生预览速率及各模式的代理。就绪后读取媒体并核对源帧。所需 SP-P／SP-V 接线未就绪时记录具体模式及错误。 |
| `project-native-preview-export` | 导入合成素材，验证真实素材读取、1.5× 原生预览、导出预检、公开导出及解码帧号。首次预检拒绝会记录为失败。 |
| `processing-worker-killed` | 在真实倒放处理进行中强杀该场景自己的 FFmpeg 子进程，核对失败、清理、重开及原任务 ID 上的显式重试。 |
| `processing-disk-and-source-faults` | 用隔离的缓存预算替身注入无磁盘余量，并在排队至执行之间改变合成源文件。 |
| `format6-off-legacy` | 比较旧格式输出参数和音频字节，检查关开关时的项目、任务、徽标和轮询。 |

标准输出为 JSON。退出码 `0` 表示通过，`1` 表示有场景失败，`2` 表示存在依赖阻塞或调用无效。提前集成时可传 `--allow-blocked` 采集已能运行的证据，仍保留 `blocked` 及原因。正式验收使用默认严格模式。

每个场景使用独立进程、临时 HOME、应用数据和媒体。样片全部合成。只在 loopback 上运行测试宿主。默认回收临时目录，传 `--keep-work` 可保留结果与本地诊断。可经 `MIOON_FFMPEG_PATH`、`MIOON_FFPROBE_PATH` 指定媒体工具。
