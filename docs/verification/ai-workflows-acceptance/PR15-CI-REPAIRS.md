# PR #15 首轮 CI 修复

首轮 GitHub Actions `39556364070` 检查 PR head `f26d403eae80b030c8c7e178f90151cbb0c51a49`：macOS、Windows portable 成功，Linux 四个分片分别失败 3、2、2、9 项。各分片的类型检查、应用构建均成功；失败来自完整测试，而非通过定向测试就宣称整套 CI 成功。

## 原因与修复

- **CLI 帮助与多语言。** 保留旧 CLI/backup 完整帮助 fixture，只允许新增的 Agent 入口和 Windows 存储说明。新增 Windows requirements 插入第 1 项后，四语言 catalog 未同步，导致后续文义错位且缺少第 4 项；现补齐四语 Windows 条目，旧四语文案逐字保留并顺移，用独立 fixture 核对。命令字段、schema、版本和 JSON 协议不变。
- **UTF-8 流清单。** 给真实文本 listener 补连续解码；仅按字节计数的原生测试继续使用 Buffer，逐个 consumer 分类，未整文件豁免。分块中文、emoji 和非文本 `0xff` 回归核对实际解码与原始字节计数。
- **冻结兼容测试。** 新增 `agent-cli-reviewed-source-deltas.json`，仅记录已审查的四个 Git 前后源码差异。校验完整 accepted 字节、唯一 inverse 和真实 predecessor 字节后，再核对原始 raw/type-erased 指纹。原 historical maps、64 文件 manifest、固定 import/schema allowlist 均未改；新增删除、重复和未知追加负例，未直接刷新旧 hash 放行变化。
- **字幕能力探测。** 两个真实媒体测试改为核对完整进程序列，补上新增的 drawtext help。旧 renderer fake 精确验证该探测的 argv、15 秒及 stdout/stderr 各 64 KiB 边界，继续比较全部渲染调用。受控 fake 补齐 help，并分别覆盖探测后、测量后撤权；不改变生产能力校验、媒体身份、字幕或 PCM 断言。
- **最大时长响度观察。** 首轮 CI 在 120 秒限额超时。本机完整观察约 77 秒；隔离 Linux arm64、Node 24.21.0、FFmpeg 7.1、2 CPU、1 GiB 内存的 CPU profile 显示大量时间用于反复读取工作区角色。`fence` 紧邻 `current(input)` 前的 `assertOwner()` 与 `current` 入口检查重复；只删除这次重复扫描，保留 `current` 在实时快照前后的所有权检查、逐 checkpoint 新读、源身份、取消及最终写入栅栏。未缓存角色/标记、放宽 120 秒预算、缩短 600 秒素材或改变 DSP。

## 本地验证

| 检查 | 结果 |
| --- | --- |
| CLI/i18n/UTF-8 原失败组 | 修复前 4 项失败；修复后 21/21、0 skip |
| catalog/foundation/UTF-8 | 35/35、0 skip；独立定向 5/5 |
| gain/opacity 冻结兼容两完整文件 | 修复前 7 项失败；修复后 23/23、0 skip；13 个 inverse 独立核验真实 Git 前后字节 |
| 四个字幕媒体完整文件 | 43/43、0 skip；含画幅/缩放/字幕边界/PCM、旧 renderer 全图与 argv 比较、撤权清理 |
| 响度观察完整业务回归 | 34/34、0 skip；新增 snapshot 内撤权和变为 restored 的 initial/decode 四子例，后续源读取与持久效果均阻断 |
| 响度应用、解码及真实 HTTP/CLI/MCP 边界 | 42/42、0 skip |
| 相同 Linux 环境的 600 秒双遍观察 | 修复前 88761 ms，修复后 60016 ms；均实际流过 460800000 PCM 字节，哈希 38400088 源字节，完整断言通过 |
| 严格类型、构建与审查 | 生产及 tests 类型、Web/桌面构建、diff 检查均通过；有限源码差异、CLI/UTF-8、响度栅栏已独立复审，no finding |

Linux 性能对比只代表上述 arm64 容器，不冒充 GitHub x64 runner 的复验。没有把原超时改成允许失败或跳过；远端完整重跑结果以 [PR #15](https://github.com/starroyhq/mioon/pull/15) 最新 head 的检查为准。合并前必须等待全部检查成功，不绕过 CI。

复现、性能剖析及回归日志位于 `/private/tmp/mioon-pr15-*.log`；仅使用合成数据、本地媒体及隔离临时工作区，没有读取 Key、重启持有会话 Key 的原生主进程或调用真实模型/媒体接口。用户原有未跟踪待办不进入提交。
