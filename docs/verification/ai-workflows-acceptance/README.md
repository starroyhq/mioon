# AI 工作流现场验收

基线：`origin/main` 的 `2d7b0521df3cad45270958b0bec071cde5c8bb17`。工作分支：`codex/ai-workflows-acceptance`。使用独立测试工作区、本地合成媒体和 Mock 视频生成，不修改用户项目，不调用真实视频或图像付费接口，不自动 commit、push 或发布。

验收包括：内置真实文本模型、工具剪辑及成片、Mock 视频生成完整流程，以及外部 AI 经 MCP、CLI 和 Skill 的等效操作。真实视频供应商尚未配置，相关质量及计费不属于本次通过声明。既有自动化与本次现场结果分别记录。

最新纯 CLI、官方 OpenAI SDK 和三系统存储批次见 [CLI-SDK-ACCEPTANCE.md](CLI-SDK-ACCEPTANCE.md)。下面保留此前阶段的现场结果与失败历史；本轮已通过完整 89 项目录、真实普通回复和只读工具往返，不能再将下面早期的 HTTP 400 记录视为当前结论。

## 已确认问题与修复

- v2 snapshot/send 读取桌面设置时漏传 `selfPort`，被原生 broker 拒绝。补齐两处调用，保留 broker 校验；真实内存桥接覆盖双协议，旧代码 2/2 失败，修复后的 runtime + desktop-agent-secrets 共 58/58 通过。
- 初始只读加载失败被统一标成 `error`，即使无草稿、无请求回执和无 Run，仍阻断原生刷新及服务重启。新增 `read_error`，只放行已经成功读取本地回执、且没有待确认请求的只读加载失败；未知提交继续阻断。原生菜单已验证能够正常重启本地服务，主进程中的 session key 未被重置。
- CLI/MCP/Skill 文档与样例使用不存在的 `.mjs` 入口；修正为当前 `.ts`。规格说明补齐 1080 默认，保留受支持的旧 720 规格。
- 系统 FFmpeg 缺少 drawtext/subtitles；使用本机已有的完整工具进行媒体测试。其 drawtext 没有 `text_shaping` 选项，又暴露预检 ready 但实际导出失败的问题。新增完整、有界的 filter help 探测：支持该选项时显式关闭 shaping；完整输出证明未编入该选项时使用等价路径；未知或残缺输出仍拒绝导出。预检和实际渲染采用相同能力判定，固定字体和字符策略保持不变。
- 模型发送前被网络策略拒绝时，曾被误记为“结果未知”。新增仅传输实现可以创建的私有身份凭证，证明失败发生在 `request.end` 之前才记为未发送；进入 `end` 后的错误仍未知。没有放宽 DNS、公网地址、TLS 或授权校验。
- 模型工具 schema 删除宿主 `projectId` 后，嵌套 UUID 仍引用该位置，造成悬空 `$ref`。生成前解析完整原始 schema，再隐藏宿主字段；使用已有转换器内联引用并逐项核对约束等价。CLI/MCP 公共 schema、UUID、strict 参数和宿主身份注入保持不变。
- 暂停或撤权的后台导出会使整个 worker cycle 跳过后续无关任务。现在按候选处理可信宿主控制阻断；数据库、审计和无法确认副作用的错误仍停止本轮。双项目回归验证无关手工导出可以完成，被暂停任务不被启动或重复受理。
- 整次撤销发现额外边界：本 Run 创建并用于生成的镜头不能删除，原实现却将其当成外部冲突，阻断更早的独立可逆编辑。现在仅在严格证明单一镜头的全部生成记录属于本 Run 后，在同一事务中将原 Change 标为不可撤销并说明“保留生成记录及产物所需镜头”，继续回退其余编辑。不删除 job、版本、素材或导出，不把仍存在的镜头标记成已撤销；外部依赖、复合 Change、ABA、草稿和新连线仍停止回退。审计失败回滚本项，控制完成回执失败沿用逐 Change 保留进度与重启恢复规则。

- 真实接口被拒时 HTTP 状态丢失，v2 面板也没有显示已保存的步骤错误。新增传输层私有身份绑定，只让合法 HTTP 状态数字进入固定脱敏文案；runtime 保存该文案，面板按纯文本显示。保持既有错误码、对外 HTTP 502、发送后未知和不自动重发语义。

## 此前阶段的现场证据

- Skill Mock 样例：生成、版本选择、时间线与下载完整通过，实际 MP4 为 H.264/AAC、1080×1920、30 fps、2 秒。
- CLI 剪辑：三段合成视频各裁为 5 秒，按红/绿/蓝顺序拼接，背景音与淡入淡出，包含中英文字幕。实际成片为 360×640、30 fps、450 帧、15 秒、H.264/AAC；完整解码通过。三处帧采样核对顺序、字幕，音轨非静音，且与无字幕对照音轨 PCM 完全一致。成片为 `skill-cli/cli-15s-complete-with-subtitles.mp4`。
- MCP 独立工作区：使用官方 SDK stdio，外部代理根据真实返回逐步调用，完成素材导入、分割/移动、多视频轨、音乐、字幕、Mock 生成、版本选择与导出。`mcp/isolated/mcp-captioned-output.mp4` 为 640×360、30 fps、195 帧、6.5 秒，完整解码与四帧视觉检查通过。
- MCP 桌面同库：通过应用现有连接描述定位正在运行的服务，不读取或输出连接 token。新建独立测试项目，21 次业务工具响应成功，剪辑并导出 6 秒短片；原请求精确回放没有新增导出。完整解码和红→蓝→红帧采样通过，原项目 DTO、目标修订和业务记录保持不变。解锁后已在最新原生构建核对 4 个片段、180 影格、revision 6 的当前成片，并实际播放（播放头推进、结束后恢复播放按钮），截图为 `mcp/desktop-shared/native-playback.png`。没有再次剪辑或导出。
- 内置助理合成现场：从界面发送自然语言任务，交互式合成网关根据工具真实返回逐轮决定后续调用。Run `a111965b-13cc-424e-872b-190f7ce670eb` 完成 27 步（9 次模型轮、18 次工具），包括剪辑、多轨画中画、音乐、两条字幕、Mock 结尾、两次 `task.wait` 和导出。12/24 步两次预算续轮后始终只有一个生成任务和一个导出，Mock `submissionCount=1`。实际 6.5 秒成片已在浏览器播放，完整解码通过。这不代表真实文本模型验收通过。
- 内置真实模型：已从原生界面发起一次仅要求回复“连接正常”的测试。系统将 `api.deepseek.com` 解析为保留地址 `198.18.10.207`，被网络策略在发送前阻断；没有真实供应商请求，也没有读取 key。真实回复、真实模型主动只读工具调用仍待该域名 DNS 恢复后复验。没有修改系统网络或绕过网络策略。
- 界面撤销的环境中断：第一次点击时合成测试服务已退出；只读确认数据库没有收到撤销请求，变化仍保持原状。该环境中断未记作产品缺陷或通过。保留本地未知请求，只查询原操作，不重发；随后关闭合成源服务，在独立副本中验证撤销，原 workspace 保留完整任务和成片。
- 界面普通撤销：另建独立合成项目，界面执行两次真实 `node.create`。先从卡片撤销一条，再整次撤销，Run 为 `reverted`、两项 Change 均为 `reverted`；Run 外的人工节点仍逐字保留。实际两次模型请求均检查完整工具目录没有 `$ref`，未调用真实模型。截图为 `ui-undo/completed.png`。
- 界面完整任务撤销：在完整 27 步任务的独立副本中，先撤销最后一条字幕，再整次撤销。10 项可逆 Change 全部 `reverted`，时间线从 6 片段、2 字幕变成空；创建镜头的 Change 保持 `applied`、`reversible:false` 并显示保留原因，Run 为 `reverted`。1 个 job、1 个版本、6 个资产、1 个导出的 data 字符串逐字相同，全部媒体字节及哈希不变，人工节点逐字不变。9 个目标的修订仅增加实际补偿次数，其余 15 个目标修订不变。证据为 `harness-undo-copy/undo-comparison.json` 和 `completed.png`；原 workspace 仍是 6 片段、2 字幕、无撤销回执。副本未继承源授权；复制的授权封套因工作区绑定正确拒绝，被保留在副本证据目录后以空授权读取历史，未修改源授权或发送模型请求。

## 此前阶段的验证与审查

此前阶段的命令使用仓库要求的 Node 24、冻结锁文件和 `TMPDIR=/private/tmp`，当时没有新增生产依赖；后续 CLI/SDK 批次按用户授权新增的依赖和验证单独记录。GNU tar 只补齐本机现有测试的命令行环境。

| 检查 | 实际结果 |
| --- | --- |
| runtime/tools/journal/crash/boundaries-v2 + worker-shutdown/server-worker-shutdown/export-controls 共 8 个完整文件 | 最新回归 165/165；含新 retention、worker、双协议发送边界和 schema 回归。retention 新增定向另 13/13 |
| gateway + network policy 回归 | 31/31；发送前拒绝和发送后未知分别验证 |
| legacy chat/responses/gateway fence 回归 | 37/37 |
| UI session + panel 回归 | 75/75；含只读加载失败、草稿和未知回执关闭保护 |
| subtitles 全组 + timeline preflight 回归 | 132/133；BSD tar 导致的 gzip fixture 失败，在 GNU tar 下原用例单独 1/1 通过 |
| v2 安全、编辑占用及人工并发既有回归 | 165/165；legacy 授权竞态另 27/27 |
| Skill Python 单测及 skill validator | 3/3；validator 通过 |
| `node scripts/tooling.ts build --channel=development` | 最新 schema / worker 修复后退出 0，包含严格类型、Web 和桌面开发构建 |
| `tsc -p tests/tsconfig.tests.json` | 最新修复后退出 0 |
| Standards / Spec 两条独立审查 | 初轮及 schema、worker、retention 三批增量均为 no finding |
| HTTP 状态诊断：network / 双协议 gateway / Responses 协议 | 54/54，含状态防伪、响应正文/头部不反射、发送后未知及不重试 |
| HTTP 状态诊断：runtime / panel 两个完整文件 | 完整 FFmpeg 环境下 53/53；首次遗漏完整 FFmpeg 环境的执行为 51/53，两项 Mock 媒体用例失败，补齐相同工具环境后全过 |
| HTTP 状态诊断：类型 / 构建 / 独立审查 | 生产及 tests 严格类型、Web / desktop 构建通过；独立审查 no finding |

收口命令（媒体回归使用本机已验证的完整 FFmpeg）：

```sh
node --test --test-concurrency=2 tests/agent-task-{runtime,tools,journal,crash,boundaries}-v2.test.ts tests/worker-shutdown.test.mjs tests/server-worker-shutdown.test.ts tests/export-controls.test.ts
node node_modules/typescript/bin/tsc -p tests/tsconfig.tests.json
node scripts/tooling.ts build --channel=development
git diff --check
```

最后一轮严格检查发现新测试夹具的 Provider context 与 unknown 字段类型不匹配，已通过明确适配与字段断言修复；未改变生产类型或放宽校验。修后测试类型检查退出 0，13 项定向回归再次通过。最终构建日志为 `/private/tmp/mioon-ai-workflows-final4-build.log`，完整回归日志为 `/private/tmp/mioon-ai-workflows-retained-shot-full-final.log`。

不同组存在重叠，不将这些数字相加为唯一用例数。已有测试与现场浏览器、MCP、CLI 证据分别记录，不用自动化通过代替真实模型或原生 UI 验收。

现场媒体和合成运行记录位于 `/private/tmp/mioon-ai-workflows/`；验证日志位于 `/private/tmp/mioon-ai-workflows-*.log`。仓库内不保存 key、token、完整连接描述或媒体二进制。

## 早期真实验收的阻塞历史

2026-10-21 恢复排查：Mac 已解锁。原测试原生进程已不存在，已用同一独立测试数据目录启动隔离分支的最新构建；原有两个项目仍可见，另准备了一个独立真实剪片测试项目，真实视频供应商保持禁用。上次选择的“仅本次执行”密钥已随旧进程退出清除；用户已在应用内重新保存，原生设置确认“伺服器已儲存 · 僅本次執行”。没有提取或复制凭据。

DNS 原因已确认并修复：系统解析、多个指定 DNS 的 UDP/TCP 查询和 TUN 路由证据指向 Clash/Mihomo fake-IP 处理。仅在当前订阅原为空逻辑的扩展脚本中向既有 blacklist 追加精确域名 `api.deepseek.com`，通过代理应用正常的“重新激活订阅”生效。有效列表由 86 条变为 87 条，旧 86 条保持原序且仅追加该域名一次；正常 Node 24 `lookup`、`resolve4` 均返回公网地址 `120.232.219.129`、`120.240.157.195`，不再返回 `198.18.10.207`。没有关闭 TUN、替换订阅或放宽 Mioon DNS/公网/TLS 校验。原 96 字节脚本单独备份，未复制完整代理配置或凭据。诊断证据为 `/private/tmp/mioon-ai-workflows/dns-readonly/diagnostic-20261021-084048.json`，变更及回退材料为同目录的 `deepseek-exact-host-20261021/`。

DNS 修复且用户重新保存 Key 后，提交了一次真实简单回复请求：Run `786d3680-d3fe-4ed9-8ae0-2755e1b9c6eb`、Step `294447e6-7ba0-4a0a-863c-db77963a1b0a`。模型服务返回非成功 HTTP 响应，原模型步骤保持 unknown，无工具执行或业务变化；已在界面明确放弃原未知结果，没有自动重发。当前正在补齐仅包含数值 HTTP 状态的脱敏诊断，以区分账户与参数问题，不采集远端错误正文或响应头。最小证据为 `real-model-native/http-failure-786d3680.json`。

状态诊断已激活，最新 Run `5608c894-8959-4b5f-a9b1-38bf13df58c6`、Step `6d994a84-27c5-4dbe-9e08-d1cc40928e27` 明确为 HTTP 400，没有回复或工具执行。离线检查实际 89 个工具均通过 Draft 7 meta-schema 检查与本地编译；名称、根对象、引用与显式非思考配置无确定错误，尚不能认定具体参数根因。中间 Run `39f88611-fdda-421d-8a60-03bc67ebf593` 因网络检查保留 intent，具有 dispatch_prevented 证据、没有请求发送；随后系统 Node、Electron Node 及 utility 进程的无 Key / 不发送 HTTP 握手探针均得到公网匹配 peer 和有效 TLS。服务发生离线后通过原生菜单恢复，主进程未退出，密钥和请求记录保留；没有自动重发任何历史 Run。

上述历史记录截止时，真实 DeepSeek 简单回复、主动只读工具调用，以及内置真实模型自主规划剪片和 Mock 工作流尚未通过。后续真实验收以最新 CLI/SDK 批次为准；合成网关和外部脚本结果始终不替代真实模型验收。真实视频供应商接入、质量和计费验收留待配置后。

当时拟定的恢复后窄验收步骤（执行结果见最新 CLI/SDK 批次）：

1. 已解锁 Mac，已确认 `api.deepseek.com` 恢复正常公网 DNS 解析，用户已在原生设置中重新保存测试 Key。不从聊天接收、提取或复制凭据。
2. 最新原生构建已经启动；保存 Key 后保留主进程。若界面提示草稿或未知回执，先按原记录处理，不能通过退出应用或清空存储绕过保护。
3. 在“AI 助理连接测试 2026-10-21”中只提交一次：`只回复“连接正常”。不要调用任何工具，不要修改或生成任何内容。` 通过条件是一次真实模型步骤完成、界面显示回复、没有工具步骤或业务变化。
4. 再提交一次：`请实际使用只读工具查看当前项目信息，然后用一句话回答项目名和镜头、素材数量。不创建、修改、导入、生成或导出任何内容。` 通过条件是至少一次真实只读工具调用，工具结果回传给模型，随后得到完成回复；不能以模型自行猜测项目名代替工具往返。步数沿用当前测试设置，不为失败重复发送新任务。
5. 保存两次运行的 request/Run/Step 身份、协议、状态、文字及只读工具结果；对比该项目的业务记录与目标修订，确认只新增助理执行记录。若响应丢失，只查询原运行，不自动重发；不保存请求头或凭据。
6. 在原生界面打开“外部MCP桌面同步验收”，核对已有 6 秒时间线和成功导出；本项只读目视检查，不再次剪辑或导出。
7. 前述真实回复和只读往返通过后，在独立的新项目准备本地合成视频、音频与参考图，由真实模型规划并调用 Mioon 工具完成短片和 Mock 结尾。生成审批仅批准精确的 `mock` 参数；保存原 job/export 身份，以 `task.wait` 读取原任务，不另建请求代替等待。核对可播放成片、音轨、字幕、唯一提交和持久步骤。该项要求真实模型根据实际工具结果作后续决策；确定性脚本、外部 Codex 操作及合成网关均不能代替。测试限制为一次有步数上限的短任务，失败后先诊断，不持续追加真实模型调用。

独立审查摘要及所审代码指纹见 [REVIEW.md](REVIEW.md)。
