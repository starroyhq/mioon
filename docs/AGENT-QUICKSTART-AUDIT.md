# 外部 Agent 从零接入 Mioon：契约审查与命令草案

2026-10-10（Asia/Taipei）；基线 `8c694d191e6c90379c32c9f8db0a778c35c31e14`。工作树 `/Users/kouzen/Documents/data/mioon-dot-agent-quickstart-b1aee020`，分支 `dot/agent-quickstart-b1aee020`。开始时身份匹配、工作区干净，两个新增目标不存在，未发现额外 AGENTS.md。此前发布审查工作树未操作。

当前补充（2026-10-10，基线 `090a8e3`）：原审查的 Q1 已由显式只读 revision 发现契约修复，见 [发现性验收](IMAGE-PROFILE-DISCOVERY.md)。以上 Mac 基线和环境仍是原始审查证据，不代表后续变更已在 Mac 原生验证。

结论：现有 CLI/MCP 可以连接用户选定的服务，按显式项目读写、准备图片 review、读取结果并编排导出；付费图片批准必须交回用户界面。新 review 可显式只读发现对应 Images 槽的当前 `settingsRevision`；没有可用值时仍须由用户从对应 Images 设置槽交接并完成配置。以下全部是**未执行草案**，静态检查不证明实际连接、上传、生成或导出成功。

## 1. 前提、发现和连接

已逐项核对 [项目 Skill](../skills/mioon/SKILL.md)、[连接说明](../skills/mioon/references/connection.md)、[CLI](CLI.md)、[MCP](MCP.md)、[API](API.md)、[Images 激活](IMAGE-ACTIVATION.md)及[自定义 Images](IMAGE-COMPATIBLE.md)。Skill 是本次被审对象，没有据它执行业务操作。

外部源码 CLI/MCP 需要 Node ≥24 和已安装的 workspace 依赖；安装 skill 不会安装应用、依赖或配置 MCP。已运行的 Electron 拥有其后端，外部 Agent 不应在同一数据目录再启动服务。服务未运行、缺依赖或不知道连接文件位置时先交接前提，不能自行扫描凭据、启动替代服务或改全局配置。本次新工作树没有 `node_modules`，只用现有 Node `v26.9.0` 做无第三方依赖的静态检查。

`packages/client/src/connection.mjs:35–58` 的真实顺序是：有 `MIOON_TOKEN` 且无 `MIOON_TOKEN_FILE` 时优先环境 token，即使同时设置 descriptor；否则尝试 `MIOON_CONNECTION_FILE`，且拒绝混用其他连接变量；再尝试 token file；没有配置则失败。不会扫描目录、猜端口或启动后台。descriptor 必须是私有文件，引用相邻绝对 token 路径和活 PID；origin 仅允许本机 HTTP `localhost`/`127.0.0.1`。每次请求重读连接，适应桌面端口/token 轮换。

下列 POSIX shell 草案只选一种；`/ABS/...` 必须替换成用户明确选定的真实路径。`unset`/`export` 仅影响调用者 shell，不是建议修改全局配置。不打印文件内容，不把 token 放在命令参数或对话里。Windows 私有文件访问仍有 ACL 前置限制，见 [私有存储](PRIVATE-STORAGE.md)。

```sh
# Electron；排除继承的直接 token/另一个服务连接
unset MIOON_TOKEN MIOON_TOKEN_FILE MIOON_BASE_URL
export MIOON_CONNECTION_FILE='/ABS/所选渠道/userData/mcp-connection.json'
```

或选择直接 Web 连接：

```sh
unset MIOON_TOKEN MIOON_CONNECTION_FILE
export MIOON_BASE_URL='http://127.0.0.1:4318'
export MIOON_TOKEN_FILE='/ABS/所选数据目录/access-token'
```

后续 CLI 草案均从已安装依赖的应用源码根运行。stdout 是 `{ok:true,data:...}` 或 `{ok:false,error:...}` JSON，stderr 是进度/诊断；结合退出码解析，不能只匹配人类文字（`apps/cli/src/index.mjs:123–128`）。

**离线发现**，不需要连接服务：

<!-- quickstart discovery offline -->
```sh
node apps/cli/src/index.mjs --help
node apps/cli/src/index.mjs --version
node apps/cli/src/index.mjs schema image.review.prepare
node apps/cli/src/index.mjs schema timeline.clip.add
node apps/cli/src/index.mjs schema timeline.render
```

**只读本地服务检查**。`doctor` 仅请求 health 和视频 `provider.list`，不验证 FFmpeg、渲染、Images 当前配置版本或真实供应商可用性（`packages/client/src/index.mjs:146–150`）；Images 另查 profile。本次历史审查基线的客户端 `--version` 是 `0.4.0`，根应用清单是 `0.4.1`；后续[版本来源修正](CLIENT-VERSION-SOURCE.md)已让 CLI/MCP 实现版本读取根清单，后端 `/health` 版本仍独立保留。版本元数据不同本身不等于协议不兼容。

<!-- quickstart readiness read -->
```sh
node apps/cli/src/index.mjs doctor
node apps/cli/src/index.mjs capabilities
node apps/cli/src/index.mjs image profile list --input '{}'
```

MCP 是 stdio bridge，由已获配置授权的宿主以 `node` 和绝对 `apps/mcp/src/index.mjs` 路径启动，传同一组连接环境；没有 HTTP MCP 地址。初始化/list/schema 不需业务服务；业务调用仍需连接。`apps/mcp/src/index.mjs:10–24,40` 将共享 schemas 映射成工具。普通工具名由点换下划线，辅助发现工具才有 `mioon_` 前缀：

| CLI 操作 | MCP 工具 |
| --- | --- |
| `project.list` | `project_list` |
| `image.review.prepare` | `image_review_prepare` |
| `image.review.get` | `image_review_get` |
| `image.version.list` | `image_version_list` |
| `timeline.clip.add` | `timeline_clip_add` |
| `timeline.render` | `timeline_render` |
| `image.task.cancelQueued` | `image_task_cancelQueued` |
| `image.task.recoverResult` | `image_task_recoverResult` |

辅助工具为 `mioon_doctor({})`、`mioon_capabilities({})`、`mioon_schema({"operation":"image.review.prepare"})`。CLI 的 watch/download 包装器不是 MCP 工具。HTTP 公共操作外形为 `POST /api/rpc`，body 为 `{operation,input}`；CLI `--input` 和 MCP arguments 只传内层 input，不能再次包上 operation。HTTP 认证由现有客户端处理，本文不提供携带 token 或代替用户批准的 curl。

## 2. 项目选择和授权素材导入

**所有 UUID、requestId、revision、模型示例和哈希均为草案。** UUID 使用合法形状便于静态检查，不代表存在的记录；执行前替换为前序响应中的真实值。数值 revision 绝不能猜测；同一未决意图保留原 key 和完整输入，新意图才分配新的稳定 key。示例图片模型以当前 `image profile list` 和 schema 为准，不代表服务商现时已验证支持。

**只读选择。** 没有 `project use/select` 或隐式“当前项目”。从 list 选择用户指定项目的 `.data[].id`；重名/意图不明确时交接确认，不能默认选第一项。之后每个需要项目的操作显式传 ID。

<!-- quickstart project-selection read -->
```sh
node apps/cli/src/index.mjs project list --input '{}'
node apps/cli/src/index.mjs project inspect --input '{"projectId":"11111111-1111-4111-8111-111111111111"}'
node apps/cli/src/index.mjs asset inspect --input '{"projectId":"11111111-1111-4111-8111-111111111111","limit":10}'
node apps/cli/src/index.mjs shot inspect --input '{"projectId":"11111111-1111-4111-8111-111111111111","limit":10}'
node apps/cli/src/index.mjs timeline inspect --input '{"projectId":"11111111-1111-4111-8111-111111111111"}'
```

inspect 的 cursor 只用原响应值、保持同一项目/limit，重启后重新从第一页读取。`project get` / `timeline get` 可能初始化空时间线，不列入严格只读发现（`packages/business/src/services.mjs:86`、`timeline.mjs:135`）。

**写入，可选。** 仅用户要求新项目时 create；已授权的本机素材才 import。`--file` 由 CLI 读本机文件、推断名称/MIME 并发送 base64 字节，不向后端发送任意路径；上限 30 MiB（`apps/cli/src/index.mjs:63–76`）。后端写托管文件/记录并运行 ffprobe。MCP `asset_import` 必须提供 `{projectId,name,mimeType,dataBase64}`，没有 `--file` 或路径字段；不能因此读取未授权文件。

<!-- quickstart project-import write -->
```sh
node apps/cli/src/index.mjs project create --input '{"name":"Agent 接入试用","description":"仅在用户要求新建时使用"}'
node apps/cli/src/index.mjs asset import --file '/ABS/已授权素材/example.png' --input '{"projectId":"11111111-1111-4111-8111-111111111111"}'
```

create/import 均没有 `requestId` 字段，不能添加 `--request-id`。ACK 丢失时先只读核对项目/素材，不自动重放非幂等操作；名称相同也不能证明一定是同一次导入。

## 3. 图片 review → 用户批准 → 结果读取

### 3.1 准备之前的配置与只读发现

用户先在 Mioon 图像工坊配置所选官方/自定义 Images 或本机 ComfyUI 槽。外部 Agent 可以显式请求非秘密配置版本，响应中使用同一 provider 项的 `settingsRevision`：

<!-- quickstart image-revision-discovery read -->
```sh
node apps/cli/src/index.mjs image profile list --input '{"includeSettingsRevision":true}'
```

MCP 是 `image_profile_list`，同一严格 JSON。默认 `{}`（或 false）保留旧响应；显式 true 只增加来自同一安全快照的正安全整数。Mock、缺失、0、无效或不可读版本不猜测；未完整配置的 custom/Comfy 项仍不返回。无当前值就停在这里，请用户配置，不猜 `1`、不借其他槽版本，不用私有 HTTP 获取设置。此读不返回 endpoint/key/secret/settings，不探测、不解密、不准备、不批准。历史 review 的版本不证明当前配置；设置变化仍由原 CAS 拒绝，不自动改已保留意图或重分配 key。

`enabled` 和 `configured` 不是付费批准或实测兼容性。Images 专用配置与视频/内置聊天 Agent 配置不同；`MIOON_ENABLE_LIVE_PROVIDER=0` 也不是所有模型联网功能的总开关。

### 3.2 外部 Agent：本地写入准备，不批准、不生成

prepare 精确输入是 `{input:<完整 image.generate 输入>,settingsRevision}`；稳定 key 位于 **`input.requestId`**。`--request-id` 只注入顶层字段，不能用于 prepare；`requiresRequestId:false` 元数据也只检查顶层，不能据此省略内层 key（`packages/client/src/index.mjs:55–58`）。

以下假设所选 profile 返回 r7，必须替换为实际发现值；prompt 保留用户批准前待审的原文。当前官方模型字面量来自 `packages/contracts/src/images.mjs:6–8`，fixed options 不可自行省略/改名：

<!-- quickstart image-review write -->
```sh
node apps/cli/src/index.mjs image review prepare --input '{"input":{"projectId":"11111111-1111-4111-8111-111111111111","name":"开场图片","providerId":"openai","model":"gpt-image-2.5-flare-2026-09-08","prompt":"清晨湖边的一间木屋。","options":{"size":"1024x1024","quality":"low","outputFormat":"png","background":"opaque","n":1},"requestId":"quickstart-image-review-0001"},"settingsRevision":7}'
```

自定义意图只把 providerId 改为 `openai-compatible`、model 改为该槽配置的精确模型、revision 改为该槽当前值；公开输入不接受 endpoint、baseUrl、key、connectionId 或 approval override。该 profile 没有参考素材字段，因此前面的导入图片不会自动成为图片生成输入。新图像组同时省略 `groupId/expectedRevision`；旧组新版本同时提供两项，名称还须匹配旧组，先用 `image group get` 读取，而不是把 shot/timeline revision 混用。

返回 `.data.id` 是 reviewId；记录项目、原输入、requestId、inputHash、destination、settingsRevision、state/revision。精确重复 prepare 返回原 review 的当前状态；同 key 改内容或设置版本会冲突（`packages/business/src/images/reviews.mjs:166–193`）。

**只读核对**，查询不会批准：

<!-- quickstart review-read read -->
```sh
node apps/cli/src/index.mjs image review get --input '{"projectId":"11111111-1111-4111-8111-111111111111","reviewId":"22222222-2222-4222-8222-222222222222"}'
node apps/cli/src/index.mjs image review list --input '{"projectId":"11111111-1111-4111-8111-111111111111","limit":20}'
```

### 3.3 用户界面：核对并明确批准可能收费的请求

外部 Agent 向用户交接项目、reviewId、原 prompt/model/options/destination 及 requestId。用户打开同一项目的图像工坊，找到对应待确认记录，核对完整意图后**亲自点击“批准并付费生成”**；不要要求其在 composer 重新输入/创建第二个请求。现有界面会列出外部准备的 review，并保留其原输入执行批准（`apps/web/src/ImageGeneration.jsx:80–83`、`image-generation.js:228–237,351–361`）。

公开 review 操作只有 prepare/get/list。settings/approve/reject 是私有用户界面动作，**没有 Agent 代批命令**；不得通过 raw HTTP、浏览器自动点击或任意执行器绕过这个交接。服务认证不是密码学上的真人点击证明（`apps/server/src/image-http.mjs:14–16`），所以不要声称“有 token 就有代批授权”，也不要声称后端能独立证明物理点击。

用户批准最多一次 POST，费用按用量且未知，不是金额封顶；保存配置不批准请求。设置改变会阻止旧 review 批准：由用户处理旧记录，再明确形成新意图，不自动改旧 key 或重新批准。`dispatched` 只说明派发边界已经记录，不证明供应商成功或费用结果。

### 3.4 只读观察任务与不可变版本

批准后，从 review 的 `.data.taskId` 或原接受 ACK 的 `.data.id` 获取 taskId。`image request get` 返回原始回执 `{projectId,requestId,operation,response}` 或 null；其中 `response.id` 才是 taskId，原接受回执固定描述 queued/r1，不能当作实时状态。

<!-- quickstart image-results read -->
```sh
node apps/cli/src/index.mjs image request get --input '{"projectId":"11111111-1111-4111-8111-111111111111","requestId":"quickstart-image-review-0001"}'
node apps/cli/src/index.mjs image task get --input '{"projectId":"11111111-1111-4111-8111-111111111111","taskId":"33333333-3333-4333-8333-333333333333"}'
node apps/cli/src/index.mjs image group get --input '{"projectId":"11111111-1111-4111-8111-111111111111","groupId":"44444444-4444-4444-8444-444444444444"}'
node apps/cli/src/index.mjs image version list --input '{"projectId":"11111111-1111-4111-8111-111111111111","groupId":"44444444-4444-4444-8444-444444444444","limit":20}'
```

没有 `image watch` / `image task watch`；只在约定的时间和次数上限内重复 `image task get`。`state:succeeded` 后按该 task 的 `groupId` 读取版本页，在 `.data.items` 中匹配 `version.taskId === task.id` 且 `version.id === task.versionId` 的记录，再取得固定 `assetId`，不要默认最新项就是自己的结果。分页使用返回 cursor 原值；图片分页默认 20、最多 50。

prepare ACK 丢失时有 reviewId 就 get，否则在 bounded list 中核对 requestId，或在获准范围精确重放**原 prepare**；准备未批准时 `image request get` 为 null 是正常的，不能据此重建请求。已接受任务结果未知时保留原身份、读现有记录；重启不会自动续发。`interrupted_before_dispatch`、`outcome_unknown`、`local_result_error` 要按 [Images 恢复规则](IMAGE-GENERATION.md)处理；`cancelQueued`/`recoverResult` 都是另行明确的写入，后者只发布已有任务绑定的本地 staged 结果，不获取缺失的供应商结果，不重新生成。

**可选 Mock 本地写入**：仅用户明确选择流程测试时使用。它生成带标识的确定性测试图，不会按 prompt 创作，不可替代用户要求的真实服务商；它不使用 review/付费批准步骤。

<!-- quickstart image-mock write -->
```sh
node apps/cli/src/index.mjs image generate --input '{"projectId":"11111111-1111-4111-8111-111111111111","name":"本地流程测试","providerId":"mock","model":"mock-image-v1","prompt":"仅验证本地流程。","options":{"size":"1024x1024","quality":"low","outputFormat":"png","background":"opaque","n":1},"requestId":"quickstart-mock-image-0001"}'
```

已有视频镜头的版本是另一族契约：`version.list` 只收 shotId，按 number 升序；不是 image version list，也没有 `version get`。选择版本是独立写入，需要当前 shot revision，不能借图片完成自动修改镜头。

<!-- quickstart video-version-read read -->
```sh
node apps/cli/src/index.mjs version list --input '{"shotId":"55555555-5555-4555-8555-555555555555"}'
```

## 4. 时间线编排与本地导出

图片结果是托管 asset。用户明确要求放入时间线后，按实际 assetId、当前 timeline revision、目标 video trackId 和空闲区间构造编辑；图片可以直接成为静帧片段，无需先调用视频生成。后续 image group head 或视频 selected version 变化不会自动替换已有 clip。

**可能写入的完整编辑态读取**：`timeline get` 可创建默认时间线。返回 `.data.revision` 和 `.data.tracks`，从真实 video 轨取得 ID，不猜轨道 ID/序号。若用户只授权查看，继续使用 inspect。

<!-- quickstart timeline-state write -->
```sh
node apps/cli/src/index.mjs timeline get --input '{"projectId":"11111111-1111-4111-8111-111111111111"}'
```

**写入示例**：假设当前 revision=4 且所选视频轨 0–90 帧空闲，加入固定资产的三秒静帧。替换真实值后执行；时间线固定 30fps，整数帧，rect 若显式传入须满足当前 schema。`timeline.clip.add` 不接受 imageVersionId 或 versionId，把已核对的 image version 转成其 assetId。

<!-- quickstart timeline-clip write -->
```sh
node apps/cli/src/index.mjs timeline clip add --input '{"projectId":"11111111-1111-4111-8111-111111111111","expectedRevision":4,"requestId":"quickstart-clip-add-0001","assetId":"66666666-6666-4666-8666-666666666666","trackId":"77777777-7777-4777-8777-777777777777","startFrame":0,"durationFrames":90}'
```

保留完整请求和 ACK；首次成功返回修改后的 timeline。精确重放返回原来的历史回执，其 revision 未必仍是当前值（`packages/business/src/timeline.mjs:47–50`）；恢复后重新 `timeline get` 读取当前编辑态，再以当前 revision 开展新编辑。发生冲突先读取并交接，不静默换 revision 重放旧意图；未知响应先使用相同输入/key 恢复原回执。

**只读但会读取媒体/运行本地子进程**：导出 preflight 不修改业务记录，但不是纯元数据查看。用编辑后的实际 revision；下面的 r5 仅示例。只有 ready 且项目/revision 匹配时使用返回 snapshotHash，blocked/incomplete/stale 先处理，不把检查当成已经导出或完整解码。

<!-- quickstart preflight read-local-process -->
```sh
node apps/cli/src/index.mjs timeline export preflight --input '{"projectId":"11111111-1111-4111-8111-111111111111","expectedRevision":5}'
```

**写入并运行 FFmpeg**：明确获准导出后，冻结同一 timeline/revision 和检查返回的真实 hash；下列重复 a 的 hash 只是格式示例。render 返回 `.data.id` 是 exportId。

<!-- quickstart timeline-export write -->
```sh
node apps/cli/src/index.mjs timeline render --input '{"projectId":"11111111-1111-4111-8111-111111111111","expectedRevision":5,"requestId":"quickstart-timeline-export-0001","purpose":"export","preflightSnapshotHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
```

**只读状态观察**：watch 只轮询已有 export，不生成、不重试，超时/Ctrl+C 只停止本地等待。

<!-- quickstart export-observe read -->
```sh
node apps/cli/src/index.mjs export get --input '{"exportId":"88888888-8888-4888-8888-888888888888"}'
node apps/cli/src/index.mjs export watch --input '{"exportId":"88888888-8888-4888-8888-888888888888"}' --timeout-ms 60000 --interval-ms 500
```

**写入客户端新文件**：成功后下载到用户选定的未存在路径，拒绝覆盖（`packages/client/src/download.mjs:18–21`）。返回的 output/bytes 及实际文件存在/播放应在未来运行时验证；本文未下载。导出 URL 是需认证的本地资源，不是公开链接。

<!-- quickstart export-download local-write -->
```sh
node apps/cli/src/index.mjs export download --input '{"exportId":"88888888-8888-4888-8888-888888888888"}' --output '/ABS/新输出目录/quickstart-result.mp4'
```

`export create` 是按镜头已选版本顺序导出，和 `timeline render` 不同，不能互换；没有公共 `export list`。长 JSON 可改用 `--input-file /ABS/intent.json` 或 `--input -` 从 stdin 读取，两种输入源不能并用。没有 `--project`、`--token`、`--provider`、`--model`、`--prompt` 业务 flags；字段放严格 JSON。恢复时保存完整输入，不能每次运行重新生成 key。

## 5. 发现、缺项及最小后续处理

| 项目 | 已证实事实与位置 | 影响 / 后续处理 |
| --- | --- | --- |
| Q1 原配置版本人工交接缺口（已修复） | 原 `8c694d1` profile DTO 不含 revision；后续显式 `includeSettingsRevision:true` 从对应槽同一安全快照返回可用正整数，默认响应不变 | 新 review 可只读发现；缺失值仍需用户完成配置。历史审查事实保留，不能将 revision 当批准或开放密钥访问 |
| Q2 顶层 requestId 元数据不足以指导 review | `operationDefinition.requiresRequestId` 仅查顶层（`packages/client/src/index.mjs:58`）；prepare 必填 key 在 input 内（`packages/contracts/src/image-reviews.mjs:28–29`、`images.mjs:23–24`） | 不以 false 认定无 key；使用完整 schema。本文检查锁定嵌套位置；后续文档/SDK 改进另行决定 |
| Q3 演示脚本恢复保证有范围 | Skill 第 27 行建议 shot/node/version 选用 key；`skills/mioon/scripts/mock_workflow.py:67–68,73` 未提供。`:32–35` 只保存 data，不保存 extra，导入路径在 `:66` 经 extra 传入；`references/mock-workflow.md:15` 的“每个原请求”说明未区分这一点 | 脚本符合旧契约，但这些写入没有精确重放保证，journal 也不足以重建完整导入调用。不把演示当全流程恢复模板；未来只补明确的 key/记录说明，不自动重跑非幂等步骤 |
| Q4 连接和 watch 能力是显式边界 | 环境 token 优先级（`packages/client/src/connection.mjs:37–41`）；watch 仅 job/export（`packages/client/src/index.mjs:152–153`） | 清除其他连接模式，图片用有界 get；不编造自动发现/image watch。这些已有实现/说明，不作为运行时缺陷 |

批准界面、外部 pending review 列表、同一意图精确回执和固定资产入时间线已有代码依据，无需为了接入重新实现。原 Mac 审查未修改 Skill、API/CLI/MCP 文档或业务；本次发现性补充同步更新共享契约、只读 profile 投影及使用指引。准备/批准/CAS/POST fence 与数据库 schema 不变。

## 6. 静态检查范围

新增 `tests/agent-quickstart-docs.test.mjs`：只读本文和相关源码，校对真实 CLI flags/operation/MCP 映射、示例字段与实际源码形状、图片固定配置及嵌套 key、公开审批边界、effects 分类和链接。直接导入的唯一项目模块是无 I/O、无依赖的 `operation-effects.mjs`；不导入 CLI、MCP server、业务服务或 schema 的第三方依赖。

```sh
node --test tests/agent-quickstart-docs.test.mjs
node --check tests/agent-quickstart-docs.test.mjs
```

这些检查是文档/源码的一致性检查，不是完整 Zod refinement、HTTP、SDK、权限、并发或端到端测试。没有安装依赖、启动应用/服务、访问真实凭据/用户媒体、上传、生成、调用供应商、运行 FFmpeg、迁移、commit 或 push。实际命令结果及最终 diff 由本次交付报告列出；平台和真实服务验收保留未运行。
