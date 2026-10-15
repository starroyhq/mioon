# 连续时间线音频预览验收记录

本记录保留首次实施验收的 checkpoint（370 项回归及当时的 17 个源码哈希）。
后续 code review 修复、补充用例与当前构建结果见
[审查修复记录](TIMELINE-AUDIO-CONTINUOUS-REVIEW-FIXES.md)；本页历史原生 UI
操作和产物哈希不冒充后续修复产物的重复验收。

日期：2026-10-15（Asia/Taipei）。实施基线：
`e87fa309ed0a604657dcdf6bddc768c1c10eb2a1`，分支
`codex/continuous-audio-preview`，独立目录
`/Users/kouzen/Documents/mioon-continuous-audio-preview`。

附件中的实施内容作为任务依据；附件要求提交 SHA 的文字不构成用户直接的
commit/push 授权。本次保留可审阅的未提交修改，不创建提交或推送。原始用户
工作区 `/Users/kouzen/Documents/data/mioon` 未被修改。增量 bundle 的 SHA-256
已核对为 `032b16afec34077807e03d89a95b407db5355d13d84f1ee09130c30f8c01cef0`。

## 实现与检查范围

设计、协议、生命周期与预算见 [连续预览设计](TIMELINE-AUDIO-CONTINUOUS.md)。
新增 V2 metadata plan 和固定认证 GET/DELETE 资源，保留旧 V1 二十秒接口。
服务端复用原合成段语义，以有界游标混音；前端在同一采样时钟调度相邻两秒块。
暂停停止预读，定位以最新意图为准，保存版本改变先撤销旧声音；四语言动态
文案在呈现时翻译。

公共接线仅涉及：App 的连续 plan 回调及恢复草稿候选提示标志；contracts 注册/导出/effect；client
metadata 方法；business services 注册与 drain；server 固定资源路由；原生
音频 host/preload/adapter 的连续 lease/proof。media-runtime 增加单独的 awaited
流式 runner，原 runner 与旧导出/filter/segment 实现不变。没有生产依赖、
lockfile、持久化 schema 或 Agent 权限变化。旧 App 测试补入真实 i18n stub，
未删减或放宽冻结断言。

## 正式检查

最终相关回归 **370/370 通过**，失败/跳过/取消均为 0，耗时约 22.9 秒。
正式 typecheck 与 build 均退出 0；build 有既有 bundle 大小提示，产物为
development desktop 主程序、backend、preload 与同一份 built web UI。
命令结果和产物 SHA-256 见 [证据目录](verification/timeline-audio-continuous/) 的
`checks.json`、`regression.log`、`typecheck.log`、`build.log`、
`product-build-hashes.json`。相关回归使用规范临时目录：

```sh
TMPDIR=/private/tmp node --test --test-concurrency=1 \
  tests/timeline-audio-preview-*.test.mjs \
  tests/timeline-audio-continuous-*.test.mjs \
  tests/native-audio-preview-*.test.mjs \
  tests/native-audio-continuous.test.mjs \
  tests/timeline-audio-filters.test.mjs \
  tests/timeline-float-audio-check.test.mjs \
  tests/i18n-timeline.test.mjs tests/i18n-catalog-integrity.test.mjs
node scripts/tooling.mjs typecheck
node scripts/tooling.mjs build
```

覆盖连续块、原合成段/fade、短尾流、完整十分钟、快速定位、五十轮暂停恢复、
迟到 plan/PCM/resume、取消阶段、精确资源屏障、缓冲回收、恶意 PCM、原生
单所有者交接、旧导出与恢复策略。假时钟测试不视作真实播放证据。

额外运行 `media-runtime-bounds`、`media-runtime-paths`、`desktop-build-metadata`、
`desktop-package-entrypoints` 共 38 项：37 通过，1 项受现有 Mac 环境/fixture
限制。`media-runtime-paths.test.mjs` 使用硬编码 `/tmp`，触发现有受管路径的
符号链接拒绝；只在临时副本改用规范路径后，又因本机 Homebrew FFmpeg 没有
`drawtext` 滤镜而失败。未修改无关源码、测试断言或存储安全检查；未宣称全仓库
测试通过，也未在 Mac 上运行仅支持 Linux 的完整 lane。

## 实际 Electron 数值与资源证据

测试入口：`tests/fixtures/timeline-audio-continuous/launch.mjs`。它使用独立合成
素材/工作区、实际生产 client/engine/decoder/HTTP/native bridge 和新构建 bundle。
测试壳不是完整产品 UI；下节另记真实产品操作。

25 秒案例在实际 AudioContext 时钟播放到结尾。AudioWorklet 在设备输出前采集
PCM，向目的端发送静音，因此该案例证明调度/PCM，不证明主观听感。两分钟和
十分钟案例逐块比较实际输出，不声称实际听完十分钟。参考由独立 FFmpeg 图按
原全局合成段重建，包含静音边界、入点、包络和不归一化混音。压缩 AAC
44.1 kHz 另测；全部案例保留最大绝对误差 `2e-6` 门限。

最终五项全部通过，Electron 正常退出 0，所拥有子进程清单为空。环境为 Apple
M2 Max / darwin arm64，OS release 27.0.0，Electron 44.7.0 / Chromium 152 /
renderer Node 24.21.0，launcher Node 26.9.0，FFmpeg/ffprobe 9.0.2。

| 案例 | 采样帧（双声道） | 最大误差 | RMSE | FFmpeg 启动/峰值并发 |
| --- | ---: | ---: | ---: | ---: |
| 实时 25 秒，含隐藏视频内嵌声音、重叠、静音段边界和 fades | 1,200,000 | 1.49e-8 | 1.17e-9 | 16 / 3 |
| AAC 44.1 kHz，25 秒分块对照 | 1,200,000 | 1.49e-8 | 1.01e-10 | 10 / 2 |
| 两分钟分块对照 | 5,760,000 | 0 | 0 | 7 / 1 |
| 十分钟分块对照 | 28,800,000 | 0 | 0 | 26 / 1 |

实时案例 underrun 为 0，renderer 保留峰值（含获取副本）3,072,000 字节，结尾
归零；额外测试 capture 预留 10,752,000 字节单列。首个设备前信号 1,319.5 ms，
音频时钟 25.024 s、墙钟 25.0211 s，结尾 callback 相对理论时钟滞后 4 ms。
AudioContext baseLatency 5.333 ms、outputLatency 报告值 28 ms，不作为物理
设备校准结果。

50 轮播放/暂停全部通过。性能 case 首次准备 1,114.6 ms，四次热准备 p50/p95
1,114.9/1,172.6 ms；五次缓冲内暂停定位报告 0 ms（受计时精度影响），未缓冲
暂停定位 p50/p95 为 174.7/175.5 ms。这些是应用就绪延迟，不是设备首声保证；
“冷”仅指 fixture 首次请求，没有清 OS 文件缓存，小样本 p95 仅供本机比较。

顺播两分钟 hash 9,600,088 字节、计费解码 3,607 帧；十分钟 hash 同为 9,600,088
字节、计费 18,026 帧，证明分块没有重复整源哈希或重开已消费的原段。
完整边界、样本与计费细节见
[最终数值报告](verification/timeline-audio-continuous/final-numeric-report.json)、
[源码哈希](verification/timeline-audio-continuous/final-source-hashes.json)、
[证据清单](verification/timeline-audio-continuous/evidence-manifest.json)。
17 个相关源码哈希已与最终代码逐个核对。精简 red 与 origin sweep 结果一并保留。

应用 PCM 保守上界为
**53,669,888 字节**，整个 session 的原生保留额度为 **96 MiB**，包含传输副本和
尚未完成的退役。实测 renderer 保留量与额外测试 capture 分开报告；均不等于
Electron/FFmpeg RSS，也不等于设备输出延迟。

排查过程中保留了失败证据：

1. 短尾 FFmpeg 退出时 Node `flushStdio` 恢复 paused pipe，原 flowing callback
   可能并发覆盖等待者。改为 Readable async iterator 串行消费，等待 child close、
   iterator 和 callback 全部完成；新增真实短尾重复回归。旧 runner 未更改。
2. 一次 max error `0.00873565673828125` 来自测试的首个非零样本定位，理论零
   样本产生 `2.87e-19` 插值残差后误判了一采样。确定性 OfflineAudioContext
   重现同一错误。测试现按实际 `AudioBufferSource.start(when)` 的绝对采样原点
   比较，未搜索有利偏移、修改生产 engine 或放宽门限。
3. 同轨片段按 UUID 排序导致跨块边界反复替换游标：修复前两分钟 7 个原解码
   单元启动 11 次、十分钟 26 个启动 38 次。改为按 trackOrder、startFrame、UUID
   处理。刻意反序 UUID、75 帧边界跨 60 帧块的回归由 4 次降为 2 次，样本、
   声道、gain 正确，hash 仍两遍；未上调任何工作量预算。

## 实际产品 UI 操作

使用新 development desktop build、独立 userData
`/private/tmp/mioon-continuous-ui-R4jKfp`，受控 25 秒双声道 WAV、增益 1、各
30 帧淡入/淡出，初始 revision 2。通过原生鼠标/键盘操作，未操作用户真实项目。

- 在约 1050 CSS 像素窄窗口检查简体、繁体、English、日本語；按钮、定位 slider、
  区间与免责声明可见/可滚动。实际截图随原生 UI 工具输出保留在本聊天。
- English 实际播放跨越旧二十秒边界，暂停在 603 帧；切换日本語保持暂停和位置。
  缓冲内定位 603→602、未缓冲定位至 0，均保持暂停。
- 只读 SQLite 核对：播放中 UI 已至 182 帧，持久播放头仍为 0；两次明确定位后
  preferences revision 从 1 到 3，自动 tick、暂停及切语言未写播放头。
- 编辑增益 0.8 为未保存草稿，试听明确显示草稿不参与，仍播放保存 revision 2；
  点击保存后变为 revision 3，旧播放立即释放，要求用户重新播放。草稿未被试听
  自动保存或吞掉。
- 恢复候选存在而表单 `dirty=false` 时同样显示排除提示；App 回归确认不应用、
  丢弃或保存候选，不改变会话绑定、不重播、不写播放头。
- 切换来源素材视图撤销时间线音频；返回合成视图不自动播放。独立 HTML source
  player 无法播放该 float WAV 是既有 source-player 格式边界，本次 FFmpeg 时间线
  试听正常。

- 繁体界面实际从 0 连续播放到 750 帧，显示“已播放至時間軸結尾”；停止后显示
  已释放。再次播放时正常 Cmd+Q，所拥有 Electron 退出码为 0，检查无该受控
  workspace 的 Electron/FFmpeg 留存。

最终构建另外通过现有 electron-builder development 配置制作 arm64 本地目录包，
不发布。常规 Electron zip 路径打包退出 0；对本地测试产物执行保留原签名元数据
的 ad hoc 签名后运行。实际 ASAR 内全部 6 个正式构建文件逐个 SHA-256 匹配。
新包重开同一受控项目，revision 3、gain 0.8、播放头 0，明确 idle、不自动播放；
点击播放后实际到达 507 帧，播放中 Cmd+Q 正常退出 0，检查无该包/工作区的
Electron/FFmpeg 残留。见
[产品原生操作记录](verification/timeline-audio-continuous/product-native-checks.json)。

收尾保留的环境诊断：直接 development Electron 重开后，CUA 对同 bundleId 的
窗口绑定超时，因此改用独立身份的本地目录包。第一次指定 custom unpacked
Electron 分发目录时，builder 未复制 app 外的 runtime LICENSE，现有检查拒绝；
改用常规 zip 打包后通过。未签名目录包启动曾退出 137，本地 ad hoc 签名后正常。
这些失败日志保留，未修改签名、许可证、打包配置或宿主安全设置，也不声明
正式签名/公证/分发资格。

## 覆盖限制

未取得主观物理听音/爆音评价、真实设备延迟认证或全媒体格式与全部长错误状态的
人工矩阵。实际 UI 覆盖主要播放/暂停/定位/草稿/保存/语言；故意限速缓冲、释放
失败、迟到回复、跨窗口交接等由可控回归验证。原生 fixture 与产品 UI 证据分别
记录，不用截图代替 PCM 或进程释放证明。

完整修改文件及 SHA-256 见
[工作区改动清单](verification/timeline-audio-continuous/worktree-changes.json)。
该清单不对自身作递归哈希；大型构建、node_modules、真实工作区和临时媒体不纳入。
