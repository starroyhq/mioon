# 连续音频 code review 修复记录

本轮承接针对 `e87fa309ed0a604657dcdf6bddc768c1c10eb2a1` 到当前工作区的审查，
修复两个确定的 TS 约定违反及两个重复代码维护问题。所有修改继续保留在独立
`codex/continuous-audio-preview` 分支，未 commit/push。

## 修改范围

- 将新增的异步背压进程实现迁入受严格类型检查的
  `packages/business/src/media-streaming-runtime.ts`；旧 `media-runtime.mjs`
  只组装依赖并保留兼容导出，原同步 runner 行为不变。
- 将 V1/V2 资源计数、准入及 drain 策略迁入
  `packages/business/src/timeline-audio-preview-coordinator.ts`；`services.mjs`
  保留注册接线。V1、V2 复用同一个保存快照读取器，事务与校验语义不变。
- 将 native V1/V2 的资源、HTTP transport、调用三方屏障提取成同一私有 helper，
  版本各自的 proof、sequence 与 cursor 校验仍在原入口。
- 为两个新增 TS 模块添加真实正反编译 consumer，接入正式 foundation 项目；
  未增加类型检查例外、ambient 声明、依赖或持久化结构。
- 背压执行器以独立错误记录保存 `unknown` 异常，消费者抛出 `null` 等 falsy
  值时也会进入失败与精确清理路径；正常播放、超时和预算语义保持原值。

## 补充用例与验证

补充用例覆盖背压/进程退出的资源归属、consume 返回与 settlement 不同时序、
V1/V2 互斥、共享快照的内外事务、native 三方屏障的不同完成顺序，以及异常
注册时的拒绝策略。真实 HTTP 集成另检查 V2 session 退役前 V1 不启动解码，
退役后 V1 仍返回原来的 pre-gain/pre-fade PCM。

相对首次 370 项核心检查，新增 **83 项**：native 屏障 63 项、协调/快照 9 项、
runtime 边界 8 项、真实 HTTP 子用例 2 项、真实编译正反例验收 1 项。另纳入
已有 runtime bounds 15 项、probe resources 12 项，最终 **480/480 通过**，失败、
跳过和取消均为 0，约 49.4 秒。

| 测试文件 | 新增检查 |
| --- | --- |
| `tests/native-audio-preview-settlement.test.mjs` | V1 GET、V2 GET/DELETE 六种三方完成顺序 × finish/close；拒绝、错误、重复及提前 finish |
| `tests/timeline-audio-preview-coordinator.test.mjs` | 观察完成与资源完成分离、注册失败、双向互斥、drain、内外事务和真实保存图读取 |
| `tests/timeline-audio-continuous-runtime.test.mjs` | 活动超时、取消、非零退出、stderr 超限、异常 callback/observer、预算、未确认 close |
| `tests/timeline-audio-continuous-transports.test.mjs` | 真实 HTTP 在 V2 session 存续时拒绝 V1 且无新解码；退役后 V1 原始 PCM 正确 |
| `tests/timeline-audio-continuous-types.test.mjs` | 复制真实实现与依赖，注入无抑制 TS2322、恢复成功，编译全程无 emit |

正式命令均退出 0：

```sh
TMPDIR=/private/tmp node --test --test-concurrency=1 \
  tests/timeline-audio-preview-*.test.mjs tests/timeline-audio-continuous-*.test.mjs \
  tests/native-audio-preview-*.test.mjs tests/native-audio-continuous.test.mjs \
  tests/timeline-audio-filters.test.mjs tests/timeline-float-audio-check.test.mjs \
  tests/i18n-timeline.test.mjs tests/i18n-catalog-integrity.test.mjs \
  tests/media-runtime-bounds.test.mjs tests/media-probe-resources.test.mjs
node scripts/tooling.mjs typecheck
node scripts/tooling.mjs build
```

结果与新构建哈希见
[本轮证据目录](verification/timeline-audio-continuous/review-fixes/)、
[检查摘要](verification/timeline-audio-continuous/review-fixes/checks.json)。
旧 `run/runStreaming/runMedia` 实现、冻结导出/filter/segment 测试及断言未修改。
独立只读复核确认原四项均已解决，未发现新的确定问题。

## 新 Electron 数值复验

在新隔离的合成素材工作区重建测试 bundle 并完整执行五项。保留原 `2e-6`
误差门限和绝对采样时钟对齐，未复用旧 bundle 或覆盖原始数值证据。
共享 snapshot adapter 也使用本轮生产 TS 读取器。

| 案例 | 双声道采样帧 | 最大误差 | RMSE | FFmpeg 启动数 |
| --- | ---: | ---: | ---: | ---: |
| 25 秒实际 AudioContext 连续播放 | 1,200,000 | 1.49e-8 | 1.17e-9 | 16 |
| AAC 44.1 kHz 逐块对照 | 1,200,000 | 1.49e-8 | 1.01e-10 | 10 |
| 两分钟逐块对照 | 5,760,000 | 0 | 0 | 7 |
| 十分钟逐块对照 | 28,800,000 | 0 | 0 | 26 |

实时播放 underrun 为 0，renderer 持有峰值 3,072,000 字节、结尾归零，设备前
首个信号约 1,553.7 ms；结尾 callback 时钟偏差约 4 ms。50 轮播放/暂停通过，
首次准备约 1,107.8 ms，热准备 p50/p95 为 1,060.2/1,122.1 ms，未缓冲暂停定位
p50/p95 为 166.6/172.9 ms，缓冲内定位 p95 约 0.1 ms。缓存未清空，小样本
性能结果仅供本机比较，不是物理设备首声保证。

全部 case 与 Electron 退出 0，无遗留 owned child；20 个相关源码哈希和实际
bundle 哈希逐一核对匹配。完整结果见
[新数值报告](verification/timeline-audio-continuous/review-fixes/numeric-report.json)、
[源码清单](verification/timeline-audio-continuous/review-fixes/source-hashes.json)。
应用 PCM 上界仍为 53,669,888 字节、原生 session 额度仍为 96 MiB，不是 RSS。

## 历史证据与边界

[首次验收](TIMELINE-AUDIO-CONTINUOUS-ACCEPTANCE.md) 的失败诊断、原生 UI
截图/操作与数值结果完整保留。当前修改没有前端交互或混音语义变化；本轮不
把旧 UI 操作记作新产物人工操作，不宣称主观物理听音或正式发布资格。

早期扩展检查的两次失败发生在 macOS 临时目录符号链接策略：probe 资源检查
改用 `TMPDIR=/private/tmp` 后通过；既有 `media-runtime-paths.test.mjs` 硬编码
`/tmp` 的限制仍保留，未修改无关测试或安全检查。其历史细节见首次验收记录。
未在 Mac 上宣称完整 Linux suite 通过。

本轮文件与完整工作区变更哈希见
[当前文件清单](verification/timeline-audio-continuous/review-fixes/worktree-changes.json)。
