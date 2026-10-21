# 纯 CLI、官方 SDK 与三系统存储验收

日期：2026-10-21。分支 `codex/ai-workflows-acceptance`，固定基线 `2d7b0521df3cad45270958b0bec071cde5c8bb17`。保留此前未提交改动；未 commit、push、部署或发布。完整实施与审查依据见 [CLI-IMPLEMENTATION-PLAN.md](CLI-IMPLEMENTATION-PLAN.md)，其中包含用户后续改用官方 OpenAI SDK 的明确要求。

## 实现与边界

- 独立 headless 服务提供配置、密钥、策略、doctor、显式 live 诊断和 v2 任务控制。CLI 不启动第二服务；写入使用调用者 requestId/revision，失联只查询原回执。配置 PUT 没有持久回执时，只向原绑定连接追加一次有界 GET 观察公开现状，仍报告未知；configured=true 不证明新 Key 保存成功，取消前后均不重发 PUT。观察进度只写 stderr，stdout 保持一个 JSON 信封。
- 锁定生产依赖 `openai@7.39.0` 和 `@napi-rs/keyring@2.1.2`。官方 SDK 的 `chat.completions.create` / `responses.create` 经自定义 fetch 回到原 Mioon transport；逐字核对已写库 body、固定目的地和 POST。SDK maxRetries=0、日志关闭，不继承其环境 Key/地址/租户/附加 headers。使用 `.asResponse()` 保留 harness 原有有界 SSE、UTF-8、结束证据和工具校验，没有声称 SDK 替代这些安全校验。
- Key 由人通过隐藏输入提交到独立服务，未从桌面进程或配置中抽取。凭据库仅保存随机 DEK，配置保存绑定工作区、渠道及模型设置的 AES-256-GCM 密文；辅助进程有界执行，不覆盖既有 DEK，不自动降级。
- Windows 新 Node-API 后端限定固定本地 NTFS，校验真实 SID/ACL、完整文件身份，固定各级句柄，拒绝 reparse/hardlink，提供原子替换与不覆盖发布。已有权限不修复。离线备份入口统一初始化后端，通过不暴露 fd/HANDLE 的原生 lease 分块复制、校验、flush 和发布；单文件上限 8 GiB，单次分配不超过 1 MiB，未扩大密钥整体读取的 64 MiB 上限。缺少完整能力时在锁和目标创建前拒绝。legacy 手工草稿及其 `project.delete` 保护流程仍在读写前拒绝；v2 SQLite 占用和 CLI 任务控制不受该拒绝影响。

## 真实模型与工具

独立工作区 `/private/tmp/mioon-cli-real-acceptance-20261021`；项目 `ed7de618-dd2e-49e5-b480-a33d2b9a092f`。使用 DeepSeek `deepseek-flash` 的 Chat Completions，非思考模式。真实 Responses 未调用，由合成双协议回归验证。真实图像/视频供应商未调用。

供应商 HTTP 400 已缩小到 `timeline.export.preflight` 的 deliveryName 复合正则 schema：原单项失败、同类 export.capabilities 单项成功。仅 DeepSeek CC 的 preflight/render 两个同形字段改用 string/min/max 和格式说明；完整静态 schema 与宿主原三条正则、strict 字段和权限保持。未知形状拒绝投影；未泛化删除 allOf 或图像 union。该单项及完整 89 项目录均已被真实模型接受；尚未进一步区分到底是哪条正则或 allOf 触发供应商限制。

| 验收 | 原 Run 与实际结果 |
| --- | --- |
| SDK 纯文本诊断 | `1753fbf0-8045-4752-9150-15f6e18ac5fd`，完成“连接正常” |
| 完整 89 项目录 | `2d2b264c-ccaf-4743-ab4b-cbd64379d76c`，完成；未执行工具 |
| 正常任务回复，完整目录 | `9c30ee38-067f-4992-92e9-60aca1d48f51`，一个模型步骤完成 |
| 正常任务只读往返，完整目录 | `6920b8eb-a022-4f9b-871f-c51cf5220299`，模型→项目只读工具→模型三步完成，返回实际项目名 |
| 自主剪片，完整目录 | `67fbc103-ca39-4a37-b57e-237e098472c0`，40 步完成；30 步预算暂停后原 Run 追加到 60，不重做前轮 |

模型自行导入三个托管句柄、创建时间线、安排红/蓝/Mock 三个视频片段、音乐和两条中文字幕，使用 task.wait 等待原任务并完成导出。宿主只准备素材、提交自然语言、批准一次精确 Mock 参数、续同一 Run 和核验；没有用业务脚本代替模型剪辑。

Mock job `2c29433f-4cea-45b4-97aa-a442263649f5`；导出 `b11119ac-6176-4f59-bb8f-250eb11a1b1a`。独立只读验收已通过，报告见 [real-cli-film-acceptance.json](real-cli-film-acceptance.json)：

- 原 Run 40/60 步，其中 16 次模型、24 次工具，后台任务已全部结束。真实时间线 revision 7、180 帧：三个视频分别 0–60、60–120、120–180；背景音覆盖 0–180；两个中文 cue 分别 15–90、90–165。Mock 全库仅一条 submission，同一 job 的 submissionCount=1。
- 正式 CLI 下载 `/private/tmp/mioon-cli-real-acceptance-control/media/final-captioned.mp4`，242521 字节，SHA-256 `9701e2bf0d5663e8c9a0b0a73cd114eaae6acfd7fb0dcf4e4865660b5504ad28`。ffprobe 为 H.264/AAC、360×640、30fps、180 帧、6.000 秒、48kHz 双声道；完整解码 exit 0、无错误。
- 独立代理与主代理均查看原始 1/3/5 秒帧，确认红→蓝→SIMULATED MOCK 与两条清晰中文烧录字幕。PCM 非静音，RMS −51.56 dBFS，220Hz 主峰与原 tone 素材一致。验证者没有代剪、控制 Run 或另建生成/导出。

一次只读任务在发送前遇到系统缓存中的 `198.18.0.5` 被拒绝，保留 intent 和可信未发送证据；清理 DNS 缓存后正常公网解析恢复。没有放宽网络策略或添加保留地址例外。已发送的失败目录诊断显式处置原未知模型步骤，没有自动重发或提交生成代替恢复。

## 已完成回归与审查

以下组有重叠，不相加为唯一用例总数。日志只含合成或公开运行身份，无 Key/token。

| 检查 | 结果与证据 |
| --- | --- |
| SDK 最终双协议 gateway | 32/32；`/private/tmp/mioon-official-sdk-gateway-final.log` |
| legacy Chat/Responses、network、gateway | 87/87；`/private/tmp/mioon-openai-sdk-protocol-regression.log`，当时 gateway 为 30 项，随后新增环境隔离两项 |
| 窄 schema 投影与实际工具拒绝 | 4/4；`/private/tmp/mioon-agent-wire-schema-independent-review.log`，非法名零 Change/jobs/exports |
| runtime/tools/journal/crash/boundaries/http 六个完整文件 | 151/151；`/private/tmp/mioon-openai-sdk-harness-regression-final.log` |
| SDK 独立 Standards / Spec | 均 no finding；另独立合成环境覆盖 4/4，未泄露标记或走 global fetch |
| schema 投影独立 Standards / Spec | 均 no finding；两边均独立核对范围并跑 4 项回归 |
| 严格类型与 Web | 最终 `pnpm build` exit 0（含仓库严格类型），`/private/tmp/mioon-cli-sdk-final-web-build.log`；另独立 `pnpm typecheck` exit 0，`/private/tmp/mioon-cli-sdk-windows-backup-typecheck.log` |
| 最终桌面构建 | Web 完成后串行执行 `pnpm desktop:build` exit 0；`/private/tmp/mioon-cli-sdk-final-desktop-build.log`，不是打包或发布 |
| 最终 CLI/client/doctor/密钥合成回归 | 六文件 41/41、0skip；`/private/tmp/mioon-final-sdk-cli-client-secret-regressions.log` |
| 配置未知结果读回 | CLI/client 最终 29/29、0skip；`/private/tmp/mioon-settings-unknown-readback-final.log`；覆盖失联、畸形响应、固定连接、读回失败及取消。与上行有重叠 |
| Windows backup 的 POSIX 回归 | CLI/bundle/restore 41/41；业务/锁/marker/restore 40/40；publication 故障 1/1。`/private/tmp/mioon-windows-backup-posix-regression.log`、`/private/tmp/mioon-windows-backup-business-regression.log`、`/private/tmp/mioon-windows-backup-publication.log`。其中另列的两个 Windows native 测试在 macOS 跳过，不作为原生证据 |
| 最终独立整体审查 | Standards 与 Spec 均 no finding；覆盖基线以来改动及未跟踪源码，Spec 独立 CLI/client/doctor/publication 32/32、0skip。不是用合成结果替代下表原生证据 |

此前单独 `pnpm typecheck` 已通过；新增 wire 测试初版的 closure narrowing 导致两处 TS 错误，已绑定局部常量修复，未改变断言或生产校验。最终严格检查包含该修复。

## 三系统实际证据与平台边界

| 系统 | 已实际取得的证据 |
| --- | --- |
| macOS 27.0.1 / arm64 / Node 24.21.0 | 原生凭据 2/2、0skip：跨 host 保存/读取，正式 CLI 删除后新 host configured=false，丢失自有合成 DEK 时拒绝保存且密文/fence 不变、不自动轮换；`/private/tmp/mioon-headless-public-native-macos-readback-final.log`。终端隐藏输入另 3/3；真实 Key 多次 headless 重启后真实模型请求成功 |
| Debian 12 / aarch64 / Node 24.21.0，Docker 原生 Linux 用户态 | GNOME Secret Service 4/4、0skip：上述跨 host 公共保存/删除及 DEK 不可用，另覆盖无 D-Bus 拒绝、锁定 Secret Service 保留旧密文；`/private/tmp/mioon-headless-public-native-linux-readback-final.log` |
| Windows 11 build 26200 / arm64 / Node 24.21.0，隔离 Parallels 克隆 | MSVC/SDK 真编译成功；原生存储与竞态 14/14、离线备份 3/3（真实集成 2 + publication 合成故障 1）、原生凭据 2/2，均 0skip；`/private/tmp/mioon-windows-final-native-backup-vault.log`。最终 SDK server/CLI 合成任务 1/1、两轮模型与真实 SQLite 工具/撤销；`/private/tmp/mioon-windows-node-host-sdk-v2-final.log` |

Windows 原生覆盖固定句柄阻止 rename、SQLite WAL、大小写敏感根、并发替换/no-clobber、终止 staged writer、NAPI type-tag 拒绝借用外来 receiver、普通父目录 flush 及危险 ACL/junction 拒绝。真实 65 MiB 媒体超过整体读取上限，经 CLI create/verify/restore/status 与 bundle export/import；源 hash 不变、重复目标拒绝，取消不发布 COMPLETE 并释放锁。

第二个真实标准账户能够列出公共 probe 父目录，但不能列私有子目录或读取文件；`/private/tmp/mioon-windows-two-user-final-proof.log`。临时账户/任务/目录均为 0；`/private/tmp/mioon-windows-two-user-cleanup-proof.log`。所有凭据测试均使用合成命名空间、零供应商调用。macOS/Windows 的 DEK 不可用证据是删除测试自有 DEK，不声称锁定了整个系统凭据库。

Windows 的模型验证是合成网关，真实模型与成片证据来自 macOS；未声称原生 Windows x64、Windows 桌面打包或发行认证。legacy 手工草稿及其 `project.delete` 连带拒绝仍是明确限制，本轮没有移植该桌面旧流程。正式 UI 视觉验收、独立安装器、真实视频生成供应商接入继续后置。

控制脚本、稳定请求 ID、托管句柄、媒体及逐次 stdout/stderr 证据位于 `/private/tmp/mioon-cli-real-acceptance-control/`。仓库不保存运行数据库、完整连接文件、密钥或媒体二进制。
