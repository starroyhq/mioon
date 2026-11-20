# SP-E0 音频原型门槛脚本

这是 0.4.0 变速音频的**原型和门槛**，不接产品代码、不加依赖。脚本用应用同款 FFmpeg 7.1.5 处理内存里合成的 48 kHz 立体声素材，量常速保音调（atempo 链）、常速变调（连续重采样）和曲线分块时间伸缩的指标，按 `thresholds.json` 自动判定，报告写到指定 JSON。

## 运行

```sh
export MIOON_FFMPEG_PATH="<app media-tools 目录>/ffmpeg"   # 或 --ffmpeg <path>
mkdir -p /private/tmp/speed-audio-gate
node scripts/speed-audio-gate/run-gate.mjs \
  --ffmpeg "$MIOON_FFMPEG_PATH" \
  --out /private/tmp/speed-audio-gate/gate-report.json
```

可选的第四条原型线（SP-E1）用另一个带 `rubberband` 滤镜的 FFmpeg，路径单独指定；不给这条线时前三线照旧：

```sh
node scripts/speed-audio-gate/run-gate.mjs \
  --ffmpeg "$MIOON_FFMPEG_PATH" \
  --rubberband-ffmpeg /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg \
  [--sweep-rubberband] \
  --out /private/tmp/speed-audio-gate/gate-report.json
```

`--sweep-rubberband` 会先跑 14 组滤镜参数（transients/window/phase/smoothing）的小扫描，报告里带 `rubberband.sweep`；默认矩阵用脚本里选定的参数。rubberband 线会做长度补偿：源尾部补 1 个成片帧、按冲激探针标定的延迟从前面剪掉，再归一化到 SP-M 的 `N × 1600` 样本。

不加 `--allow-gate-failure` 时，门槛不通过脚本退出码为 1；`--out` 指向的报告仍会写出。常用参数：

- `--quick`：只跑语音尾字和敲击两种素材、0.5×/2× 两个速度；
- `--skip-curve`：跳过曲线分块原型；
- `--speeds 0.1,0.25,0.5,2,4,10`、`--materials speech-tail,transient,...`；
- `--allow-gate-failure`：门槛失败也返回 0，便于生成报告。

素材全部由 `materials.mjs` 用固定随机种子合成（语音样尾字、敲击瞬态、鼓点循环、长持续音、左右声道相位差），不下载、不写盘、不提交大文件。

## 文件

- `run-gate.mjs`：编排、量测、门槛判定和报告。
- `materials.mjs`：五种合成素材生成器（48 kHz 立体声，30 fps 整数帧长）。
- `pcm.mjs`：PCM 与量测工具（尾部无声、峰值/能量起音、声道相位、第一差分）。
- `timemap.mjs`：SP-M 编译计划的适配层（连续窗口查询，不生成整条 30 万帧向量）。
- `stretch.mjs`：atempo 链、连续重采样的变调、曲线分块时间伸缩和交叉淡化拼接。
- `thresholds.json`：可自动判定的阈值和依据。
- `rubberband.mjs`（SP-E1）：FFmpeg `rubberband` 滤镜的保音调原型、参数小扫、冲激延迟标定和曲线块处理器。

报告字段含每次运行的链、样本数、自然长度误差、尾部/瞬态/相位/接缝指标和耗时；曲线和 0.1×/10× 的边缘补帧变体单独成表。合成素材、报告和日志都放 `/private/tmp/speed-audio-gate/`，不提交。

## 已知限制

- 量测是客观信号指标，不是主观听音测试；阈值是原型门槛，不是最终产品规格。
- 瞬态位置用切片窗口的峰值位置量；相位用 440 Hz 单音的互谱相位量；atempo 的相位声码器本身会改变瞬态包络，报告同时给出原始偏差和按探针标定的补偿后偏差。
- 只用应用同款 FFmpeg 7.1.5；不同版本的结果不能直接比较。rubberband 线必须用带 `librubberband` 的另一个 FFmpeg（例如 Homebrew `ffmpeg-full` 9.0.2），两条线的版本不同，报告里分开标。
