# 单个已保存片段的独立响度测量

共享后端/API/CLI/MCP 与有界 client 已接入片段属性卡。原始实现基线为 `bdc7325`；下方历史资格记录保留当时范围。2026-10-20 扩展 LRA 与显式目标候选，当前结果见[第三轮响度补全](verification/project-open-design-fixes/round3/clip-match/README.md)，不继承旧响度数字。

## 范围

`timeline.clip.loudness` 显式分析一个最多 **60 秒 / 1800 帧** 的完整已保存时间线片段。
超过时在文件/进程工作前明确拒绝，不自动截短。信号处理为：
源入点与时长 → 48 kHz 双声道转换 → 已保存 gain → pad/trim → 片段局部线性淡入淡出。
不包含片段前的时间线空白、其他轨道、其他片段边界或编码后的 AAC。

报告阶段为 `isolated_clip_post_gain_fades_pre_mix`，处理配置为
`timeline-isolated-clip-float-v1`。测量完全沿用
`bs1770-5-48k-stereo-fir4x-v1` 与原有计量器，不改变既有测量或历史备份 profile。独立 `loudnessRange` 字段使用 `ebu3342-2023-48k-stereo-3s-100ms-complete-v1`：3秒完整短时窗、100毫秒步进、−70 LUFS绝对门限与−20 LU相对门限，取10/95百分位差。不补首尾静音，不足3秒返回too_short/null；该边界不同于完整EBU模式文件认证，详见[EBU Tech3342](https://tech.ebu.ch/files/live/sites/tech/files/shared/tech/tech3342.pdf)。
测量单位、门控和估算真峰值的限制见 [已导出文件响度检查](EXPORT-LOUDNESS.md)。
这里是在有限布局转换后的双声道信号上测量，不是任意原始通道布局计量。

可选 `target` 复用 `integratedLufs`（−60至−5）及 `truePeakCeilingDbtp`（−20至0）；省略时不推断默认目标，也不返回候选。有目标时对真实解码浮点样本施加恒定倍率，再用全新计量器完整复测候选；增益必须为正且不超过2，响度误差不超过0.1 LU，并保留0.5 dB峰值余量。门控变化或真峰值冲突不会被公式预测掩盖，也不静默降低目标或放宽增益上限。

读操作的 `applyAllowed` 与候选 `applyAllowed` 均固定为 false，不写时间线、媒体或任务。界面“匹配响度”仅把通过校验的gain放入既有片段草稿，随后以原 `timeline.clip.update` 保存，沿用版本冲突、未知请求对账、一次撤销/重做；也不接受旧的原子应用 WIP。没有limiter、批量归一化或媒体导出。
不同内容的相同 LUFS 不保证相同主观听感，独立片段峰值不证明多轨混音安全。

## 请求与身份

严格输入：`projectId`、`timelineId`、`expectedRevision`、`clipId`、
`expectedAssetSha256`、固定 `measurementProfile`。不接收路径、URL、任意 filter、
媒体字节、目标、增益覆盖、选区覆盖或 mutation requestId。

服务读取并验证完整已保存时间线/来源图和 SQL 归属，但只打开、探测、解码和
前后两次完整 hash 所选片段的源文件。报告绑定完整已保存图及精确选择的摘要、
原始时间线位置、源入点/时长、gain/fades、片段/轨道/资产 ID、实际源 hash/字节数。
内部单片段解码描述将片段起点归零以保持局部 fade 时间；它不写回数据库，
不作为真实保存的时间线对外返回，也不复用整片候选报告合同。

静音轨和零 gain 显式拒绝，不解除静音，不偷偷改为原始源分析。图片与已核实无音轨
视频不可测，不伪装成 digital_silence。潜在可听视频即使保存为 `hasAudio:false`，
仍以实际 ffprobe 核对；音轨存在性与保存元数据不同则拒绝。未知/多声道布局、
损坏媒体、非有限 PCM、不完整输出及过期身份均不产生 ready 报告。
数字静音、过短、低于门限仍沿用既有独立状态。

## 资源与取消

- 单源最大 512 MiB；前后 hash 累计最大 1 GiB。
- 所选片段最长 60 秒/1800 帧；固定 30 fps，每帧恰好 1600 个音频 sample frames。
  原始源与已保存时间线仍可达既有 600 秒/18,000 帧，源入点不是限定为前60秒。
- 单次解码 PCM 最大23,040,000 bytes。无目标时流式计量；有目标时最多保留一份该大小的私有Buffer，EOF后原地缩放并复测，不另存媒体。候选 `measuredPcmBytes` 单列，`checks.passes=1` 仍表示一次解码。每64 KiB候选工作让出事件循环并重复所有权/取消/来源栅栏。
- 解码工作沿用每输入一帧 lookahead，单片段为 durationFrames + 1，最多1801帧，不因其他片段分段。
- 操作全程 120 秒，client 默认 125 秒，可显式更短；完整响应信封上限 8 KiB。
- 与导出文件峰值/响度及整片响度共用单活跃观察槽；不排队、不重试、不缓存。
- 取消、HTTP 观察者断开或 owner shutdown 只撤销本观察；精确子进程确认退休前
  不释放资源，未确认退休继续失败关闭。不能取消其他已接受编辑、生成或导出。
- 恢复隔离工作区在输入解析及媒体访问前拒绝；不扩大内置 Agent 工具目录。

这些是拒绝上限，不保证所有合规素材在所有机器上都能限时完成；JS 流式缓冲
不等于 FFmpeg RSS 上限。报告临时、不持久化，不写 SQL/历史/任务/原媒体。

先经 `mioon schema timeline.clip.loudness` 发现当前输入，再显式调用
`mioon timeline clip loudness --input '<JSON>'` 或 MCP `timeline_clip_loudness`。
继续使用已有运行服务，不为测量另开同工作区后端。

界面绑定当前选择/项目/版本/来源及执行代次；草稿未保存、
冲突或 mutation pending 时禁用。切换选择/项目、隐藏或数据变化撤销旧报告，
拒绝迟到响应，重开不自动测量。目标改变或输入法组合也使旧候选失效；匹配不绕过保存片段。多片段批量处理不在本片范围。


## 显式范围收缩与未通过证据

最初实验请求完整600秒片段，在固定120秒预算内未完成，返回
`TIMELINE_CLIP_LOUDNESS_TIMEOUT` /503；该测试总耗时122,213.443123 ms包含清理。
这不是成功测量，也不是600秒实时播放、物理音频输出或RSS证明。原始测试源码及
红日志以字节未变的形式保存在 [未支持的600秒实验记录](qualification/clip-loudness-600-unsupported/evidence.json)。
未重试600秒实验、未延长预算、未把失败改为通过或跳过。

之后明确选择独立的首片60秒范围：只限制新操作的完整所选片段，不降低已有整片
混音/导出、源媒体及时间线的600秒上限，不改变DSP算法。新60秒实际边界需单独
验证源末尾范围、完整样本数、确切子进程退休以及SQL/源hash/文件清单不变；
不能把原先2秒成功或原600秒失败当作60秒通过。此处不做任何播放/听感交付声明。

## 本片实际验收

60秒边界首次运行通过，观察操作实耗43,699 ms（测试含准备/清理46,929.89622 ms）。
所选范围为600秒源的最后60秒：sourceInFrame=16,200、durationFrames=1800。
实际得到2,880,000 sample frames、23,040,000 PCM bytes，前后完整hash共38,400,088 bytes。
记录的ffprobe PID24和ffmpeg PID25均有started→exited事件；操作后SQL全部行、
`total_changes()`、完整临时夹具文件hash清单和源SHA不变。
[一次边界运行日志](qualification/clip-loudness-60-supported/boundary-once.log)保留实际证据。
大于1800帧的业务测试确认在validate/hash/decode调用前拒绝；没有自动截取或重试。
这些证据只支持本机离线测量，不证明实时播放、物理输出、任意机器限时或进程树RSS。

整仓UTF-8收集器清单门禁另有既存遗漏，仍未通过，不把聚焦模块测试称为整仓通过。
本片只登记新transport的三个收集点及审阅确认的annotation既存两处代码收集点
（共享stdout/stderr循环及MCP stderr，共三个流）；其余九文件维护未扩入本片。

独立基线的CLI默认help预期缺少annotation新增操作；精确移入已接受`128c8fb`的
`asset.annotation.list`/`asset.annotation.set`预期插入行并与本片操作取并集，
保持冻结legacy fixture全部字节不变。初次红日志保留，不把它称为原先已通过。

后续聚焦回归的负向test-name过滤未按预期排除此边界，导致意外再运行一次，
超出仅运行一次的要求。第二次同样通过：观察44,682 ms，ffprobe PID349和
ffmpeg PID350均started→exited；不是超时后重试，也未改动范围或预算。
保留两个实际结果，后续不再运行该边界。

为避免再次误跑，完整60秒边界测试连同辅助函数静态移至
`tests/timeline-clip-loudness-60.qualification.mjs`，不匹配普通`*.test.mjs`。
迁移后未执行；测试体SHA及两次结果见[evidence.json](qualification/clip-loudness-60-supported/evidence.json)。
最后扩展聚焦运行192项，189通过、3失败：CLI annotation预期遗漏已按上述上游精确修复；
另两项仍公开未通过，分别为inspection读操作清单缺少既存`timeline.colour.source.inspect`，
及旧mix decoder针对历史renderer的冻结源码hash不符。本片未修改该renderer或放宽断言。
[原始红日志](qualification/clip-loudness-60-supported/focused-original-red-run.log)保留全部结果。
DSP、mix服务/decoder、filter graph与renderer相对`bdc7325`逐字节未变，
[独立SHA清单](qualification/clip-loudness-60-supported/unchanged-shared-files.json)可复核。

结构分离后的最终纯业务/合同/client/descriptor明确文件清单：44/44通过；
上游精确CLI预期并集的单项回归：1/1通过。foundation TypeScript检查通过。
这些不是完整仓库通过；实际媒体和HTTP/CLI/MCP观察者证据见上述原始运行，
边界结构分离后未再执行媒体。全部操作仅用自有临时夹具，未对用户媒体执行测量或写入。
