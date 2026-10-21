# 桌面真实助理验收（2026-10-21）

本批在本地 `main` 的合并提交 `f7beb75b239a87f444a828ccf80f780ac3ab41f8` 上继续验证。用户在原生设置中保存测试 Key；测试使用独立开发 profile 和独立项目，没有提取桌面 Key。真实文本模型为 DeepSeek `deepseek-flash`，协议为 Chat Completions，沿用官方 OpenAI SDK、现有网关、授权、SQLite 和 harness。视频生成只用 Mock，没有调用真实图像或视频接口。

## 实际完成的链路

| 原生界面任务 | 持久身份 | 实际结果 |
| --- | --- | --- |
| 简单回复 | Run `3cdc8399-5d2f-4f3c-84b2-12edf65a5cbe` | 单个模型步骤完成，界面显示“桌面连接正常”，没有工具或业务 Change |
| 只读往返 | Run `52108967-ccde-45be-901b-2ef93b26ef32` | 模型 → `mioon_project_inspect` → 模型，共 3 步；回答真实项目名称及数量，前后项目 DTO 相同、零 Change |
| 自主剪片 | Run `a5802d0c-0b18-4237-8fb2-a3d062c373af` | 同一任务完成 47 步（22 个模型步骤、25 个工具步骤），无未知步骤或未完成后台任务 |

自主剪片项目为 `2c26f7b0-faea-400f-82e4-a366864ff141`，从空白项目开始。宿主仅创建测试项目、通过原生文件选择器选择三份本地素材、发送自然语言要求、批准精确工具操作和核验结果。素材导入、镜头创建、生成、时间线、字幕、导出及等待均由 Mioon 内置真实模型规划并调用工具，未用外部脚本代剪。所有模型请求携带完整 89 项准入目录。

时间线 `5cf44ed3-edf7-4c2d-8232-1143192aa8ce` 最终 revision 7，1080×1920、30 fps、180 帧：

- 红色视频为 0–60 帧，蓝色视频为 60–120 帧，Mock 结尾为 120–180 帧，均从源入点 0 开始。
- `tone.m4a` 覆盖 0–180 帧，`audioRole: music`、`gain: 0.5`。
- “创作从这里开始”为 15–90 帧；“让想象成为画面”为 90–165 帧。

生成 job `912483ca-8a43-462b-a474-8f2ffbd16ecd` 使用 `mock / mock-motion-v1`，2 秒、9:16、无参考图。持久提交记录和 `submissionCount` 均为 1。工具仍按付费档要求精确批准；Mock 没有真实费用证据，不标为已产生真实媒体费用。

导出 `c977216f-cf5b-45c3-8d90-aadee0322070` 成功，产物 asset `cc21e304-a5c2-4aea-9c9b-7cf63f31ce24`，只有一条实际受理的导出。原生剪辑工作区显示修订版 7 的当前成片、4 个片段和两条字幕；点击播放后播放头由 0 到 14 帧，最终到 180 帧并恢复播放按钮，没有再次渲染。

实际 MP4 为 360×640、30 fps、180 帧、6 秒、H.264/AAC、48 kHz 双声道，248818 字节，SHA-256 为 `7e4d0fb904ae6d59632c2f4d49dafa00b3207aa6f61d64d3f1c76d0fef0f43f0`。完整严格解码退出 0、错误输出为零；音轨非静音且保留 220 Hz 背景音。独立审查者目视核对原始 1/3/5 秒采样帧，确认红、蓝、Mock 顺序及实际烧录的两条中文字幕；按同一中段 1–5 秒比较源音频与成片 PCM，RMS 比值为 `0.499636917253`，符合 0.5 音量和 AAC 重编码误差。

当前桌面的 MCP 连接也经官方 SDK stdio 读取同一项目、时间线、job 和 export：发现 123 个业务工具，助理配置/策略/任务管理命令没有暴露为模型工具。前后项目相同，没有新增模型、生成或导出请求。外部 MCP/CLI/Skill 的实际编辑导出验收沿用 [CLI-SDK-ACCEPTANCE.md](CLI-SDK-ACCEPTANCE.md) 及此前现场证据，本次只读探针不冒充再次剪片。

## 现场发现及处理

1. **附件上传的 MIME 与错误反馈。** 原生选择 `tone.m4a` 后未出现附件或错误。任务上传现在与现有应用入口一致，只将 `audio/x-m4a`、`audio/x-wav` 两个已知别名转为标准 MIME，不按后缀猜测、不放宽服务端字节校验。明确拒绝且原请求 lookup 不存在时显示固定脱敏错误，保留手动草稿和已选附件；未知提交仍只查询原回执。修复构建后仅重载 renderer，主进程与 session Key 保留；相同 M4A 重新选择成功，其持久 MIME 为 `audio/mp4`，内容哈希与源文件一致。没有直接采集原生 `File.type`，别名原因不冒充直接观测证据。
2. **审批隐式扩额。** 在旧运行中，第 30 步工具等待批准，唯一控制为 `approve`，预算却由 30 自动变成 60，随后发送第 31 步模型请求。Standards、Spec 均独立确认为缺陷。现已将恢复执行与授权新预算分开：`journal.resume` 默认不扩额，批准/拒绝明确保留预算，仅显式 `resume` 控制允许在耗尽时追加此 Run 固定的 `stepLimit`。保留版本、未知结果、整数溢出校验及同事务控制回执；已计步工具可安全完成一次，下一新步骤进入预算暂停。两个协议的批准/拒绝、后台审批、回执写失败回滚、重复控制实际执行次数均有合成回归。历史错误预算不回写，也不能算修复后原生“显式继续增加 30 步”的通过证据；修复后的边界由合成真实 runtime/journal 测试验证，没有再花费真实模型调用重跑 30 步。
3. **模型正确处理的领域拒绝。** `version_select` 使用旧镜头版本，得到 `REVISION_CONFLICT`；模型重新读取后发现唯一生成版本已自动选用，未重提生成。第一次 render 的预检未指定 `deliveryName`，render 却新增该字段并携旧 hash，得到 `PREFLIGHT_STALE`；模型重新读取与预检后，第二次 render 省略可选 hash，走既有导出校验并成功。这不代表匹配预检摘要提交成功。两个失败步骤保留原状态，均无业务 Change 或生成/导出受理记录，不能改记为完成。

## 验证与范围

| 本批检查 | 结果 |
| --- | --- |
| 附件 UI、panel、导入反馈完整回归 | 82/82，0 skip；独立 UI/panel 45/45 |
| 预算修复前的触发回归 | 双协议批准/拒绝及后台审批共 6 项在旧代码失败，修复后通过 |
| 修复后完整 runtime/journal | 89/89，0 skip |
| 最终实际工具调用次数定向回归 | 双协议批准/拒绝 4/4；重复控制不重复执行 |
| crash/boundaries/export-controls | 25/25，0 skip，覆盖崩溃恢复、授权栅栏及原始后台工作控制 |
| 独立 Standards | 定向 21/21、最终调用次数 4/4；四文件最终 SHA 匹配，no finding |
| 独立 Spec | 定向 22/22；最终调用次数断言只读核对、SHA 匹配，no finding |
| 类型与构建 | 生产和 tests 严格类型、Web 与桌面最终构建均退出 0；`git diff --check` 通过 |

对应日志为 `/private/tmp/mioon-native-upload-ui-regression.log`、`mioon-approval-budget-full-regression.log`、`mioon-approval-budget-executor-count.log`、`mioon-native-budget-boundary-regression.log`、`mioon-budget-independent-standards-review.log`、`mioon-budget-independent-final-invocation-count.log`、`mioon-approval-budget-tests-typecheck-final.log`、`mioon-native-budget-web-build.log` 和 `mioon-native-budget-desktop-build.log`。各测试组有重叠，不累计成唯一用例总数。此前 CLI/SDK/三系统验证沿用其独立记录，没有为本次小范围 UI 与预算修改冒充重跑所有平台。

最终构建后，通过原生菜单仅重启本地服务，保留原生主进程及 revision 4 的 session Key。界面重新显示当前成片、时间线和已完成的原任务；重启前后 Run 快照逐字相同（revision 250），没有自动续跑或新建请求。`native-service-update-proof.json` 记录构建产物指纹、公开 Key 状态及快照比较，不包含 Key。该检查证明恢复原任务及产物，不冒充再次执行真实模型或预算边界。

现场安全证据和媒体在 `/private/tmp/mioon-main-desktop-ai-acceptance/`，包括 `native-text-and-readonly-report.json`、`native-film-ui-proof.json`、`mcp-native-film-readonly-report.json`、原 Run 快照、媒体验证与三帧；仓库不保存凭据、连接描述、运行数据库或媒体二进制。旧 CLI/Windows 收口指纹保持其历史含义，不覆盖为本次指纹。

本次原生真实模型只验证 Chat Completions；Responses 由现有合成双协议回归覆盖，没有冒充当前供应商原生实测。真实视频供应商接入、质量、计费及 UI 视觉验收仍后置。Key 选择的是会话保存，退出原生主进程后需重新输入。验收收口时修复未提交；后续提交和 PR 以用户另行授权及 Git 记录为准，不部署或发布。
