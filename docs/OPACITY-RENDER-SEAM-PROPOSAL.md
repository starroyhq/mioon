# 透明度渲染接缝：待明确的冻结例外

日期：2026-10-16。本方案未应用到渲染器，未执行 FFmpeg。

## 准确阻点

`tests/fixtures/opacity-envelope-frozen-baseline.json` 的 64 个冻结文件包含 `packages/business/src/timeline-media.mjs`。该函数在内部编译全部视觉 layer 与 overlay，没有受信任的层滤镜扩展点。当前不能同时保持其原字节、复用同一渲染器并实际应用透明度。单纯去掉透明度后调用旧渲染器会丢失效果，另复制整套 renderer 又超出本轮要求。

此路径已停在设计结果，等待父任务明确是否允许对这一个冻结文件增加下述极窄接缝。没有操作遭到工具拒绝，也没有不确定的媒体操作。

## 具体最小改动

1. 新 TypeScript 模块在完整 owned store／来源／导出身份校验后，为本次 attempt 的精确 snapshot 对象登记私有 WeakMap 绑定。raw snapshot、曲线、回执及 hash 保留；只给旧验证器提供只读投影。用户 JSON 的 `opacityPlan` 或 profile 不产生绑定。
2. `timeline-media.mjs` 只新增固定内部 getter import，并在现有 image/video layer 的 `setpts=N/(30*TB)` 之后、`[vN]` 和 overlay 之前追加已经编译的 stage。无绑定的旧 snapshot 返回空字符串，旧图不变；未绑定的新字段必须拒绝，不能静默忽略。
3. getter 从被绑定的原 clip 计算 `beginFrame - clip.startFrame`，不能由输出选区时钟或 caller expression 决定。视频和普通 RGBA 为 straight；经过当前 image staging 的已预乘 layer 为 premultiplied。LUT／色彩／缩放都在透明度之前，字幕在合成之后。
4. 同一个 `renderTimeline` 继续服务 preview/export。沿非冻结的 timeline/domain、export admission/source、jobs 及 origin binding 入口增加固定候选分支；不复制服务或 worker。带透明度的任务始终核对原始 snapshot/hash/source/inode/publication fence。
5. 43 只运行本 origin 新建且非 held 的导出。现有 `workspace_restore_export_origins` 及其保护已具备，无需新 DDL；RPC invocation 不延长给后台 worker。旧 40/41、旧构造器及其余冻结文件不放宽。

纯编译器已使用封闭数值语法生成 `geq`，无外部表达式／label／路径输入。其 `N`、RGB 和 alpha 选项依据 [FFmpeg 官方 geq 文档](https://ffmpeg.org/ffmpeg-filters.html#geq)；这不证明本机二进制及像素行为已通过。

## 最小像素探针计划（尚未执行）

每个 alpha mode 分别做 identity 和三帧曲线两次探针，共四个短进程。源为自行构造的 2×2 RGBA 原始内存色块，无源媒体文件或输出文件。每次 stdin/stdout 各 48 字节；stdout 硬限 48 字节且结束必须恰为 48，stderr 限 65536，超时 5000 ms；单线程。不得顺带渲染项目。

固定参数结构：

```text
ffmpeg -hide_banner -loglevel error -threads 1 -filter_threads 1
  -f rawvideo -pixel_format rgba -video_size 2x2 -framerate 30 -i pipe:0
  -vf <仅 compileTimelineOpacityFilterCandidate 生成的 stage>
  -frames:v 3 -an -pix_fmt rgba -f rawvideo pipe:1
```

曲线帧值为 0→0、1→0.5、2→1。straight 输入像素 `[200,100,24,128]`，RGB 保持、A 为 0/64/128；premultiplied 输入 `[100,50,12,128]`，RGB/A 同乘，期望逐帧 `[0,0,0,0]`、`[50,25,6,64]`、`[100,50,12,128]`。先验 identity，随后按明确每通道最多 1 字节舍入容差比较。实际探针及渲染接缝均需后续安排，当前不能宣称像素已验证。
