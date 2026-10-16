# 透明度渲染接缝：获批例外与候选验证

日期：2026-10-16。父任务已批准单文件兼容接缝；已接入内部候选42/43并完成四个短像素探针。生产默认40/41仍未启用透明度。

## 冻结例外

原 `tests/fixtures/opacity-envelope-frozen-baseline.json` 的64文件清单保持原字节，SHA-256 为 `7381ed3486563b84cf4f4912dfde81ae07b0369cde4e479ad2b1bcfd88633f0d`。其中63项继续匹配原 hash。仅 `packages/business/src/timeline-media.mjs` 使用明确获批的接缝；例外证据见 `tests/fixtures/opacity-render-seam-exception.json`：

- 原 hash：`b89728d7508ea1ca0d2011c3fad710722411993bd8a0989553167733bf343dde`
- 新 hash：`db497b44160a3d5c3b398fb5be795a0aecfdd8df23e54d00c1dcbdc6ccb0e9ee`

旧40/41回归使用本地 Git 固定原源码和实际内存40→41恢复捕获，逐字节比较8组完整滤镜、argv、脚本及 concat 内容；覆盖普通／managed 视频和PNG、音频、字幕、完整／区间输出。仅 codec 传输被模拟，没有媒体子进程。这证明这些旧分支的命令构建一致，不声称编码文件逐字节相同。

## 已实现的最小接缝

1. 新 TypeScript 模块在完整 owned store／来源／导出身份校验后，为本次 attempt 的精确 snapshot 对象登记私有 WeakMap 绑定。raw snapshot、曲线、回执及 hash 保留；只给旧验证器提供只读投影。用户 JSON 的 `opacityPlan` 或 profile 不产生绑定。
2. `timeline-media.mjs` 新增固定内部 getter import，入口核对精确 snapshot 和实际消费的 prepared Map，并采用绑定中的只读投影、固定 LUT reader、内部 effect fence 和组合取消 signal。两处 image/video layer 在 `setpts=N/(30*TB)` 之后、`[vN]` 和 overlay 之前追加编译 stage。旧 snapshot 不产生绑定和新滤镜字节；未绑定的新字段在 spawn 前拒绝。
3. getter 从被绑定的原 clip 计算 `beginFrame - clip.startFrame`，不能由输出选区时钟或 caller expression 决定。视频和普通 RGBA 为 straight；经过当前 image staging 的已预乘 layer 为 premultiplied。LUT／色彩／缩放都在透明度之前，字幕在合成之后。
4. 同一个 `renderTimeline` 继续服务 preview/export。沿非冻结的 timeline/domain、export admission/source、jobs 及 origin binding 入口增加固定候选分支；不复制服务或 worker。带透明度的任务始终核对原始 snapshot/hash/source/inode/publication fence。
5. 43 只运行本 origin 新建且非 held 的导出。现有 `workspace_restore_export_origins` 及其保护已具备，无需新 DDL；RPC invocation 不延长给后台 worker。旧 40/41、旧构造器及其余冻结文件不放宽。

候选 authority 使用实际 SQL 回执、原始 snapshot digest、来源图、哈希和 inode；精确 claim、Map、条目及 snapshot 分别绑定。复制／反序列化／跨 store／失效 attempt 均不能获得能力。冷启动只恢复没有活动私有 claim 的本 origin 新导出；状态或来源失效永久撤销旧 proof。原 float outcome 的 raw snapshot hash 和输出资产 hash 校验继续执行。Admission 的私有 WeakSet 在内部 render 注册 fence，并在结束时撤销，调用方 callback 不能授予权限。

纯编译器使用封闭数值语法生成 `geq`，无外部表达式／label／路径输入。其 `N`、RGB 和 alpha 选项依据 [FFmpeg 官方 geq 文档](https://ffmpeg.org/ffmpeg-filters.html#geq)。

## 已执行的最小像素探针

使用本机已有 `/opt/homebrew/Cellar/ffmpeg/9.0.2_1/bin/ffmpeg`，版本 `ffmpeg version 9.0.2`。命令 `node scripts/probe-timeline-opacity-candidate.ts` 仅执行一次，四个进程串行完成。独立审查后才执行；版本信息另由有界 owned-child 调用读取，无安装或项目渲染。

每个 alpha mode 分别做 identity 和三帧曲线两次探针。源为自行构造的2×2 RGBA内存色块，无源媒体文件或输出文件。每次 stdin/stdout 各48字节；stdout硬限48字节且结束必须恰为48，stderr限65536，执行5000 ms，失败时追加既有 owned-child 2000+1000 ms停止观察；输入／过滤器／输出均限制单线程。任一失败或 uncertain 都停止其余探针，不自动重试。

固定参数结构：

```text
ffmpeg -hide_banner -loglevel error -threads 1 -filter_threads 1
  -f rawvideo -pixel_format rgba -video_size 2x2 -framerate 30 -i pipe:0
  -vf <仅 compileTimelineOpacityFilterCandidate 生成的 stage>
  -frames:v 3 -an -pix_fmt rgba -threads:v 1 -f rawvideo pipe:1
```

曲线帧值为0→0、1→0.5、2→1。straight 输入 `[200,100,24,128]`，RGB保持、A为0/64/128；premultiplied 输入 `[100,50,12,128]`，期望逐帧 `[0,0,0,0]`、`[50,25,6,64]`、`[100,50,12,128]`。容差上限为每通道1字节，实际四项最大误差均为0。

| 探针 | 结果 | stdin/stdout | stderr | close/code/signal | 最大误差 |
| --- | --- | --- | --- | --- | --- |
| straight identity | 通过 | 48/48字节 | 0字节 | true / 0 / null | 0 |
| straight curve | 通过 | 48/48字节 | 0字节 | true / 0 / null | 0 |
| premultiplied identity | 通过 | 48/48字节 | 0字节 | true / 0 / null | 0 |
| premultiplied curve | 通过 | 48/48字节 | 0字节 | true / 0 / null | 0 |

四项 stdin finish、stdout end、stderr end 均已观察到；没有超时、超限、停止或 uncertain。机器可读结果见 `docs/evidence/opacity-render-candidate/pixel-probe.json` 和 `ffmpeg-version.json`。

## 验证范围与剩余工作

- `node --test tests/*opacity*.test.mjs`：168/168顶层测试通过，含四语言 React/Inspector、草稿、实际42/43事务、source/claim/worker发布和冻结边界。实际 authority 的9项子进程用例另外由 wrapper 执行；codec传输被模拟，SQL、合成文件哈希／inode和共享 renderer 使用实际代码。
- foundation严格类型检查及探针CLI独立严格检查通过；未扩大 legacy JS allowlist 或放宽类型设置。独立权限／发布审查和探针生命周期审查的问题均已修复并复核。
- 默认生产40/41仍不启用候选42/43，不迁移用户项目。候选 `preflightSnapshotHash` 明确返回 `OPACITY_CANDIDATE_PREFLIGHT_UNAVAILABLE`，尚需单独接入候选 preflight。
- 本机测试运行时为 Node26.9.0；没有可用 Node24，尚未补最低版本验证。未进行实际GUI手动验收、真实用户媒体或长时间FFmpeg测试；此次像素探针只证明固定48字节样本和本机FFmpeg的结果。
- 额外旧恢复服务器测试有1项在监听 `127.0.0.1` 时被沙箱以 `EPERM` 阻止；相关媒体 fence 测试均通过。未提权重试此监听，没有不确定执行。
