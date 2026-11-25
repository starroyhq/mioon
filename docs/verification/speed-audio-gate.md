# SP-E0 音频原型门槛（0.4.0 变速提前项）

本卡只做原型和门槛，不接产品代码、不改项目格式、不加依赖。素材全部由脚本合成；量测用应用同款 FFmpeg 7.1.5（`MIOON_FFMPEG_PATH`）和 48 kHz 立体声 PCM，项目帧 30 fps（每帧 1,600 样本）。结论决定 SP-E 用什么算法。

## 素材（脚本合成，不下载、不提交）

| 素材 | 时长 | 内容 | 量测重点 |
| --- | ---: | --- | --- |
| `speech-tail` | 6 s | 语音样词串；最后一个词以清辅音（`s` 样宽带噪声）结束，最后一个样本仍出声 | 尾部丢音、瞬态 |
| `transient` | 8 s | 安静底噪 + 4 个已知源帧的敲击瞬态 | 瞬态位置偏差 |
| `drums` | 8 s | 120 bpm 鼓点循环（kick/snare/hi-hat），末尾仍有击打 | 输出样本数、瞬态 |
| `sustain` | 20 s | 440/660/880 Hz 长持续音，末尾硬切 | 尾部丢音、相位 |
| `stereo-phase` | 5 s | 440 Hz 音，右声道延迟 24 样本（0.5 ms） | 声道相位差 |

## 原型

1. **常速保音调**：FFmpeg `atempo` 链，每项限制在 0.5–2；0.1× 为 `.5,.5,.5,.8`、10× 为 `2,2,2,1.25`。输出裁/补到 SP-M 的 `N × 1600` 样本，余量明确静音。
2. **常速变调**：不调用固定整数 `asetrate`，而是按 SP-M 编译计划的连续线性映射逐样本重采样（Catmull-Rom），曲线形态用真实连续时间。
3. **曲线保音调**：用 SP-M 的连续窗口查询把每个输出块映射回带上下文的源窗口，块内用 atempo 链，块间 2 帧交叉淡化；块长 30 输出帧、上下文 8 帧、重叠 2 帧。

## 指标和阈值

脚本以 `thresholds.json` 自动判定；依据写在同文件 `rationale` 里：

| 指标 | 阈值 | 依据 |
| --- | --- | --- |
| 尾部无声（扣掉 ceil 余量） | ≤ 20 ms | 小于 30 fps 的一帧 |
| 瞬态位置偏差 | ≤ 10 ms | 约 1/3 帧，低于常见切点听感阈值 |
| 声道相位偏差（保音调） | ≤ 0.2 ms | 约 10 个 48 kHz 样本 |
| 接缝步进/第一差分比 | ≤ 2× 全段 99.9 分位 | 接缝不额外冒尖 |
| 曲线块边界第一差分比 | ≤ 2× 全段 99.5 分位 | 同上 |
| 输出样本数 | 与 `N × 1600` 完全相等 | 导出必须精确拼接 |

瞬态用 ±0.4×最近标记间隔窗口内峰值位置量；相位用互谱相位量（变调按 `440×rate` 测）。同时记录用冲激探针标定的 atempo 固定偏移和补偿后偏差；补偿不可靠时以原始偏差判。

## 结果（FFmpeg 7.1.5，合成素材，2026-11-18）

### 常速保音调（atempo 链）

| 素材 | 0.1× | 0.25× | 0.5× | 2× | 4× | 10× |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| speech-tail 尾部无声 ms | **119.1** | **29.0** | 13.8 | 7.4 | 0 | 0 |
| sustain 尾部无声 ms | **155.2** | **52.6** | **22.0** | 0 | 0 | 0 |
| stereo-phase 尾部无声 ms | **171.5** | **57.9** | **20.1** | 0 | 2.8 | 0 |
| transient 瞬态偏差 ms | **262.6** | **97.4** | **37.8** | 8.9 | 5.4 | **21.0** |
| 声道相位偏差 ms | 0 | 0 | 0 | 0 | 0 | 0 |
| 接缝第一差分比 | 0.001–1.11 | — | — | — | — | — |

- **尾部**：0.1×/0.25×/0.5× 全部或部分超 20 ms；0.1× 最坏 171 ms。4×/10× 自然长度偏长，裁掉后无尾部问题。
- **瞬态**：0.1×/0.25×/0.5× 和 10× 超 10 ms，最坏 263 ms；2×/4× 通过。用冲激探针标定的固定偏移补偿后仍有 19–77 ms 残差，不能当成可简单修正的固定延迟。
- **声道相位**：保音调时左右声道样本间延迟保持不变，偏差全部 ≤ 0.2 ms，通过。
- **切点接缝**：把源在 45% 处切成两段各自处理后拼接，接缝相对全段第一差分比 0.001–1.11，未超 2×。
- **切段顺序**：切两段再拼的输出样本数与整段一致、精确对齐到 `N × 1600`。

### 常速变调（连续重采样）

全部素材、全部 6 档速度通过：尾部无声 ≤ 0.5 ms（全是刻意 ceil 余量）、瞬态偏差 ≤ 0.06 ms、相位偏差 ≤ 0.014 ms、接缝差为 0、样本数精确。变调路径的映射可以做准；变调本身是产品选择，不能静默替代保音调。

### 曲线保音调（分块 atempo + 重叠）

| 用例 | 输出帧 | 块数 | 尾部无声 ms | 瞬态偏差 ms | 块边界第一差分比 |
| --- | ---: | ---: | ---: | ---: | ---: |
| speech-tail/slowMiddle | 425 | 50 | 0（27.9 为故意余量） | — | 1.77 |
| transient/slowMiddle | 566 | 67 | — | **59.3** | 1.46 |
| sustain/slowMiddle | 1,414 | 167 | 0 | — | 1.13 |
| speech-tail/fastToSlow | 148 | 18 | 0.08 | — | 1.94 |
| transient/fastToSlow | 197 | 24 | — | 9.5 | 1.24 |
| sustain/fastToSlow | 492 | 58 | 0.02 | — | 1.07 |

块边界判定全部通过，尾部余量正确；但 `slowMiddle` 的瞬态在速率变化剧烈处偏 59 ms，说明固定块内常速近似不够，SP-E 需要更细的块或外部时间伸缩器。

### 边缘尾损缓解

给源前后补 1 帧内容再裁掉的对照：`sustain@0.1×` 用后补可从 155 ms 降到 0，但 `speech-tail@0.1×` 后补仍有 125 ms、前后都补仍有 71 ms；前补普遍更差。补零/补帧不能作为通用修法。

## 过不了时的算法选项（本卡不加依赖，待协调人定）

| 选项 | 许可证/分发 | 预估效果 | 工作量 |
| --- | --- | --- | --- |
| Rubber Band Library | GPL-2.0+ 或商业授权；当前媒体工具已随 GPL FFmpeg 构建发布，增加 GPL 组件会扩大源码提供义务，需法务确认 | 业界常用，瞬态/相位声码器质量通常明显好于 atempo，尤其 0.1×；预计能过 10 ms 瞬态与 20 ms 尾部门槛（需原型复测） | 4–6 人天（含打包、签名、分发和质量门槛） |
| SoundTouch | LGPL-2.1；动态链接/源码提供满足 LGPL 即可 | WSOLA 类，瞬态质量中等；预计能过尾部门槛，0.1× 瞬态需实测 | 3–5 人天 |
| zita-stretch | GPL-2.0+（需确认） | 音质好，接口简单；GPL 分发影响与 Rubber Band 类似 | 4–6 人天 |
| 自研 WSOLA/相位声码器 | 自有代码 | 可控但要自己过全部门槛和跨平台；风险最高 | 6–10 人天 |
| 限制启用范围 | 无新依赖 | 保音调只开 2×–4×（本卡实测通过），0.1×/0.25×/0.5×/10× 走变调或禁用声音 | 0.5–1 人天 |

## 复跑

见 `scripts/speed-audio-gate/README.md`。报告是 `--out` 指定的 JSON，含每次运行的链、样本数、自然长度误差、各指标和耗时；素材不落盘。合成素材的随机种子固定，同一 FFmpeg 版本重复运行得到相同数字（机器忙时耗时字段会变）。

## 局限

- 结论来自合成素材和客观指标，不是主观试听；还需要 SP-E 做真实语音/音乐试听和跨段试听。
- 瞬时位置和相位用单点/单频测量，相位声码器会使瞬态包络变化，数字会有测量误差；报告保留原始值、补偿值和方法。
- 只验证了常速保音调、常速变调、曲线分块三条原型；倒放音频、定格静音、gain/fade/ducking、转场音频和最终 AAC 拼接属于 SP-E 的后续工作，不在本卡范围。
- 应用同款 FFmpeg 是 7.1.5；升级媒体工具后必须重跑同一门槛，不能沿用本表。

## SP-E1：rubberband 保音调复测（2026-11-20）

用本机 Homebrew `ffmpeg-full` 9.0.2（`--enable-librubberband`，Rubber Band Library 4.0.0）单独作为第四条原型线；atempo 和连续重采样两条线仍用应用同款 FFmpeg 7.1.5。素材、速度档、指标和 `thresholds.json` 未改。脚本：`scripts/speed-audio-gate/rubberband.mjs`，复跑方式见同目录 README。

### 滤镜参数小扫

先扫 14 组 `transients × window × phase × smoothing`（其余固定 `detector=compound, formant=shifted, pitchq=speed, channels=apart`），在敲击/语音尾字两种素材、0.1×/0.5×/10× 三档上量尾部、瞬态和样本数。结论：

- `transients=smooth` + `window=short` 明显最好：剧变处瞬态与尾部都最小；`mixed/crisp` 或 `standard` 窗口在慢速档更差。
- `detector`（compound/percussive/soft）在这组素材上对结果没有影响；`phase=laminar` 在 0.1×/4× 最好，`independent` 在 0.5×/2×/10× 略好，综合取 `laminar`。
- `smoothing=on`、`formant=preserved`、`pitchq=quality/consistency`、`channels=together` 没有改善门槛，部分还放大尾部；最终选用 `transients=smooth, window=short, phase=laminar, smoothing=off, formant=shifted, pitchq=speed, channels=apart, detector=compound`（见 `rubberband.mjs` 的 `RUBBERBAND_PARAMS`）。

### 长度补偿

Rubber Band 是带延迟和 flush 尾的流式算法。整段直接处理时，输出自然长度比 SP-M 目标短：0.1× 少 294.29 ms、0.25× 少 127.96 ms、0.5× 少 66.67 ms、2× 少 16.67 ms、4× ±8.33 ms、10× 少 3.33 ms（目标 `N × 1600` 样本，30 fps）。做法：

1. 处理前在源尾部重复最后一个成片帧（1 帧）作为 flush 上下文；
2. 用一个 2 s 处的冲激探针标定每条速度的固定延迟，从输出前面剪掉（负值则补静音）；
3. 归一到 `N × 1600` 样本。

处理后所有档位的 `durationErrorSamples` 为 0；标定延迟见报告 JSON 的 `rubberband.calibrationMs`（0.1× −48.04 ms、0.25× −16.04 ms、0.5× −5.37 ms、2× 0.98 ms、4× 1.63 ms、10× 14.75 ms）。分段（45% 处切开、各自处理、拼接）也按同样方法归一，块边界指标见下表。

### 三条线对照（同一素材、同一档位，过=该线在该用例没有任何超阈值指标）

| 用例 | atempo | 连续重采样 | rubberband |
| --- | --- | --- | --- |
| speech-tail@0.1x | 不过（尾部） | 过 | 过 |
| speech-tail@0.25x | 不过（尾部） | 过 | 过 |
| speech-tail@0.5x/2x/4x/10x | 过 | 过 | 过 |
| transient@0.1x | 不过（瞬态） | 过 | 不过（瞬态） |
| transient@0.25x | 不过（瞬态） | 过 | 过 |
| transient@0.5x | 不过（瞬态） | 过 | 过 |
| transient@2x | 过 | 过 | 过 |
| transient@4x | 过 | 过 | 不过（瞬态） |
| transient@10x | 不过（瞬态） | 过 | 不过（瞬态） |
| drums 全部档位 | 过 | 过 | 过 |
| sustain@0.1x–0.5x | 不过（尾部） | 过 | 不过（分块接缝） |
| sustain@2x–4x | 过 | 过 | 不过（分块接缝） |
| sustain@10x | 过 | 过 | 过 |
| stereo-phase@0.1x–10x | 0.1–0.5× 不过（尾部），2–10× 过 | 过 | 全部不过（声道相位，部分还有接缝） |
| speech-tail/slowMiddle | 过 | — | 过 |
| transient/slowMiddle | 不过（瞬态 59.3 ms） | — | 不过（瞬态 10.51 ms、块边界 6.06×） |
| sustain/slowMiddle | 过 | — | 过 |
| speech-tail/fastToSlow | 过 | — | 过 |
| transient/fastToSlow | 过 | — | 过 |
| sustain/fastToSlow | 过 | — | 过 |

### rubberband 的失败数字

- **瞬态**（补偿后）：0.1× 10.40 ms、0.25× 5.13 ms、0.5× 0.63 ms、2× 5.44 ms、4× 15.08 ms、10× 12.94 ms；阈值 10 ms。0.25×/0.5×/2× 过，0.1×/4×/10× 不过（0.1× 只差 0.4 ms）。
- **尾部**：整段全部通过（≤20 ms，多数 0）；10× 还有 11.42 ms 的刻意余量。
- **声道相位**：stereo-phase 上 0.205–0.616 ms，阈值 0.2 ms；`channels=together` 没有改善（0.036–0.973 ms）。Rubber Band 的相位声码器会改变左右声道间延迟，这是它没过的关键项。
- **分段/整段一致**：sustain 的 45% 切开再拼在 0.1×/0.25×/0.5×/2×/4× 块边界步进比 2.29–6.18（阈值 2），stereo-phase 最高 14.6；说明独立处理两段和整段处理不等价。加 8 帧重叠上下文后接缝仍 3.4–7.15，未解决，需要共享滤波状态或更长的交叉淡化才能谈分段一致。
- **曲线**：`transient/slowMiddle` 的瞬态从 atempo 的 59.3 ms 降到 **10.51 ms**（几乎过线），但块边界第一差分比 6.06（阈值 2）不过；其余五个曲线用例都过。rubberband 的曲线质量明显好于分块 atempo，但慢中段仍有块边界点击需要解决。

### 发出去要改什么（只评估，不改构建）

- **源码**：Rubber Band Library 4.0.0，`rubberband-4.0.0.tar.bz2`（sha256 `af050313ee63bc18b35b2e064e5dce05b276aaf6d1aa2b8a82ced1fe2f8028e9`），GPL-2.0-or-later；构建用 Meson（脚本已有 meson/ninja），macOS 用 vDSP、内置重采样器，建议 `-Dcmdline=disabled -Dtests=disabled -Dresampler=builtin -Dfft=auto`，不需要额外 libsamplerate（当前 Homebrew 包依赖它只因为 pkg-config 自动探测；固定 `-Dresampler=builtin` 即可去掉）。
- **build-media-tools.ts**：`SOURCES` 增加 pinned rubberband 源（license 标 GPL-2.0-or-later，role shipped）；构建顺序放在 FFmpeg 前，用现有 `meson(context, 'rubberband', ['-Dcmdline=disabled', '-Dtests=disabled', '-Dresampler=builtin'])`；`FFMPEG_LIBRARIES` 加 `librubberband`；`REQUIRED_FILTERS` 加 `rubberband`；sources bundle 会自动带上新源码。
- **体积/时间（估算）**：arm64 静态库 743 KiB（Homebrew 4.0.0 实测）；x64 同量级。两个可执行文件合计预计增加 0.7–1.0 MiB/架构，gz 资产增加约 0.3–0.5 MiB；单架构构建预计多 30–90 秒（rlib 编译 + FFmpeg 重链），下载体积和 CI 时长按实际构建回填。
- **Windows**：Gyan 8.1.2 essentials 的库列表已包含 `librubberband`（<https://www.gyan.dev/ffmpeg/builds/> 的 “libraries in essentials build”；CI 固定使用其长期保留的 GitHub 发布镜像 <https://github.com/GyanD/codexffmpeg/releases/tag/8.1.2>），因此 Windows 开发包无需换构建；只需在能力探针/`REQUIRED_FILTERS` 里加 `rubberband` 并确认 `-filters` 列出。Gyan 构建是 GPLv3，和新增的 GPL Rubber Band 不冲突。
- **能力探针**：`ffmpeg -hide_banner -filters` 里出现 `rubberband`，且 `-h filter=rubberband` 能列出 `tempo/pitch/transients/...` 选项；没有这个滤镜的 FFmpeg 继续按 SP-E0 第 1 条只开放 2×–4× 保音调。
- **许可证/分发**：现在 macOS 媒体工具已带 GPL 的 libx264，加入 GPL-2.0-or-later 的 Rubber Band 不新增许可类别，但会扩大源码提供范围（Rubber Band 源码须随 sources bundle 发布）；Windows 走 Gyan 的 GPLv3 构建，不变。

### SP-E1 结论和建议

- rubberband 把 0.25×/0.5× 的尾部+瞬态补过门槛，曲线 `slowMiddle` 瞬态从 59.3 ms 降到 10.5 ms；但 **0.1×/4×/10× 瞬态仍不过、stereo-phase 在全部档位不过、分段/整段一致性和曲线块边界不过**。因此不能据此把 0.1×/10× 保音调打开。
- 建议 SP-E 仍只把 2×–4× 交给内置 atempo；0.25×/0.5× 只在解决 声道相位和分段一致性后考虑 rubberband；0.1×/10× 保持变调/禁用声音。其他办法（SoundTouch LGPL、zita-stretch、自研、限制范围）继续按 SP-E0 的成本表由协调人定。
