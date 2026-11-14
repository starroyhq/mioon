# HTTP API

HTTP、CLI 和官方 MCP 共享相同的严格参数、权限与副作用描述。本文包含 S7 的公开入口退役状态。项目备份采用独立的 `project.backup.*` 契约。

Base URL defaults to `http://127.0.0.1:4318`. Only loopback Host/Origin accepted. All `/api/*` except login, including project-scoped media, require `Authorization: Bearer <local token>` or the HttpOnly SameSite=Strict login cookie. `/health` is public. The token is server-side configuration; do not place it in URLs.

## P4 当前状态与应用接口

`startServer({dataDir})` 现在以 B1 应用库和真实项目宿主管理器运行，每个项目使用独立内核连接；`dataDir` 是应用根，不是素材根。服务端默认项目位于 `<dataDir>/projects/`，桌面使用 `<userData>/data/` 并默认将项目放在 `<videos>/Mioon/`。覆盖 `MIOON_DESKTOP_USER_DATA` 时，项目和缓存留在该覆盖目录的 `data/` 内。旧 `workbench.sqlite` 目录启动返回 `VALIDATION_ERROR`（400），不迁移；旧工作区 opener、迁移与恢复实现已随 S7 退役。目录与生命周期详见 [PROJECT-HOST.md](PROJECT-HOST.md#0-p4-当前运行状态)。

| 应用/项目接口 | 当前行为 |
| --- | --- |
| `GET /api/background-tasks` | S3-A应用级只读任务等待摘要：`limit`为1–100（默认50）、`after`为项目ID游标；返回`version:1`、`projects[{projectId,taskCount,reasonCodes}]`和`nextCursor`，最多256KiB。只列项目打不开且有未结束任务的项，不打开项目，不提供结果弃置；独立契约`@mioon/contracts/background-task-query` |
| `GET /api/project-entries` | 只读登记目录、availability、封面缓存地址、应用库与服务实例身份，以及新建项目所用格式 `newProjectFormatVersion`（3 或 4，旧服务可省略）。网页渠道限 projectsDir 内已登记项，桌面渠道为全部最近项。不扫描目录，不 acquire 运行时 |
| `GET /api/project-entries/identity` | 同一认证边界下只读返回 `appLibraryScope` 和 `instanceId`。桌面设置用来确认当前应用库和服务归属，无需加载登记目录、扫描项目或读取其文件头 |
| `GET /api/project-covers/{projectId}` | 应用级认证，只读缓存 `cover.jpg/cover.json`；缺失或与登记摘要不匹配为 404 `NOT_FOUND`，不 acquire 项目 |
| `GET /api/workspace-info` | 应用目录信息 |
| `GET /api/projects/{projectId}/workspace-info` | 正常项目请求租约内的真实项目目录信息；复用 `workspaceInfoSchema`，供已验证 owner 的桌面导出选择素材根，不接受调用方文件路径 |
| `GET /api/agent/tasks/v2/diagnostics/latest` | 从应用 documents 返回 `{test:null}` 或连接测试摘要；不打开关闭的项目 |
| `POST /api/agent/models/list` | X6b 应用级只读模型发现：仅列表网络请求，可写独立的无密钥缓存；不打开项目或运行推理 |
| `POST /api/agent/models/cache` | X6b 单服务缓存读取：无网络、无密钥读取、无文件创建；坏缓存视为未命中 |

首页摘要的 `projectSummaryCoverSchema.url` 现在必须为 `/api/project-covers/{摘要项目ID}`，不再是素材 URL。连接测试摘要由项目诊断完成时更新，含 `completedAt`、`status`、`protocol`、`model`、`errorCode` 和可选的设置绑定。遇到上游 HTTP 失败时，摘要可另含 `diagnostic:{kind:'http',status,providerType?,providerCode?}`。服务商类型和错误码仅保留已知机器标签或状态式数字码。旧摘要可省略 `diagnostic`。应用库版本 2 只允许精确已知 v1 结构事务升级，保留原三种 documents 字节及其它登记、策略回执。

模型列表使用 `outcome` 和 `reason` 返回失败分类。上游 401、403、404、429 和 5xx 分别对应
`rejected`、`permission_denied`、`not_found`、`rate_limited` 和 `server_error`。
连接错误和超时分别用 `connection_failed` 和 `timeout` 表示。

真实 HTTP 可达的 B1 错误为：

| 错误码 | HTTP | 条件及 details |
| --- | --- | --- |
| `APP_LIBRARY_LIMIT` | 507 | 新项目登记达到 8192 条上限；`{limit:8192}` |
| `APP_LIBRARY_INVALID` | 422 | 全局 latest 读取到无效诊断摘要；`{reason:'unusable'}` |

两者沿用 `{ok:false,error:{code,message,details,retryable:false}}`，严格契约见 [app-library-http.ts](../packages/contracts/src/app-library-http.ts)。应用库的 `LOCKED`、`FORMAT_NEWER` 在监听前拒绝启动，`CLOSED` 是内部生命周期错误，不能将它们都视为已有 HTTP 操作的可达响应。受信 `inspectProject` 和 `inspectApplication` 仅交给测试代码，分别借用实际项目和 B1 连接；同步调用、拒绝异步回调及关闭后调用。子进程测试使用固定快照/故障 IPC，不接受 SQL 或任意路径，不增加 HTTP、CLI 或环境变量入口。

### Mio 模型发现与缓存（X6b）

这两个应用管理接口仅接受 `POST` 和 `application/json`，继承本机 Host/Origin、Bearer 或 SameSite 会话认证，响应均为 `Cache-Control: no-store`。它们不进入项目 RPC、CLI、MCP 或 Mio 工具目录。严格叶契约为 [agent-model-list.ts](../packages/contracts/src/agent-model-list.ts)，Node 管理 client 提供 `modelsList(input, {signal?, timeoutMs?})`、`modelsCache(input, options)`。

两个输入共同包含 `{serviceKey, expectedSettingsRevision, selection}`；`selection` 为 `{presetId, platformId, baseUrl, protocol}`，不要求先选模型，不接受任意 URL、HTTP 方法或 header。`models/list` 另收 `credential`：`{source:'saved'}`、`{source:'input',value}` 或 `{source:'none'}`。一次性输入仅在本地 POST 中短暂携带，不放 URL、设置、缓存或错误；已保存密钥通过受信代理在宿主获取，列表结果不走密钥 broker。无密钥只限目录明确允许的列表。

成功结果为 `{outcome:'success', models:[{id, displayName?, adaptation}], complete, source, fetchedAt}`。`source` 是 `current_protocol`、`same_platform_compatible` 或 `public_local`；部分清单保留已验证前缀并将 `complete` 设为 `false`。其他结果为 `invalid_key`、`unavailable`、`unreachable`、`network_denied` 和固定的安全 `reason`，不包含供应商原始正文。参数错误、过期设置修订等沿用 `AGENT_SETTINGS_*` 错误 envelope。缓存结果为 `{status:'miss'}` 或 `{status:'hit',result:<成功结果>}`，读取不获取密钥、不联网、不写入设置或缓存。

本地输入完整 UTF-8 上限 16 KiB，响应完整 JSON 上限 256 KiB；单密钥仍为 8192 字节。列表从本地入口起共用 15 秒期限，client 此方法默认等待 18 秒并支持取消，不重试；其他 client 方法超时不变。分页最多 10 页、1000 个模型、累计原始响应 1 MiB，只请求服务端目录推出的地址和分页参数，不跟随重定向或远端 `next` URL。列表观察不会改变设置修订、Mio 选择、授权、`verification` 或已适配模型能力。只有限定的无密钥清单缓存可以写到应用私有的 `agent-settings/model-list-cache/`；项目库、应用 SQL 及 Mio 请求历史均不因模型发现写入。

### S6-A 目录读取

独立严格契约见 packages/contracts/src/project-entry.ts，成功数据为 version=1、appLibraryScope（与原 last-project 的 workspaceScope 同算法）、instanceId、registered；registered 的每条是 project（RecentProject，summary 可为空）、availability、coverUrl。读取会刷新已打开宿主的登记摘要，不取得新租约；封面有值时严格等于该项目的 /api/project-covers/<ID>，不读取关闭项目补摘要。

仅 GET，不接受查询参数、GET 请求体或原生路径控制；其它方法 405，未知子路径 404。路由沿用 Host/Origin 与令牌/会话认证，Cache-Control: no-store。网页不显示未登记文件，手工放入文件须先经明确打开流程登记；本轮未增加网页任意路径打开、目录扫描或 window-session。

目录最多 8192 条，沿用 B1；本资源完整 JSON 上限 384 MiB，超过报 PROJECT_ENTRY_LIMIT（413），不截断。这是传输边界，不是应用库配额或全部理论数据都能列出的承诺。身份改变报 PROJECT_ENTRY_SCOPE_MISMATCH（409），应用库持有权/生命周期不可用报 PROJECT_ENTRY_UNAVAILABLE（503），标准认证错误不变。

@mioon/client/project-entry 提供 createProjectEntriesClient().list({signal?, timeoutMs?})，固定地址、严格 UTF-8/DTO/字节限额，不重试。浏览器使用独立的只读同源 client，不引入 Node client 或文件系统能力。

S6-C 2a 的 renderer identity owner 只从完整校验后的目录建立 appLibraryScope 与 instanceId。appLibraryScope 是稳定的偏好缓存身份；instanceId 是服务实例身份，不参与磁盘缓存 key。首次验证后，换库或同库换 instance 都永久阻断当前 owner，清除可发布目录及 verified scope；必须由新 renderer 完整验证后重新建立身份。普通读取失败保持 unknown/error，可在原身份下重试，不视为空目录；不能通过 A→null→A 自动重绑，让旧偏好队列或晚到回包重新生效。

最近目录表示已登记项目及成功打开记录；读取、搜索、排序和选择卡片不保存“上次选择的项目”。没有明确项目 URL 时停留首页，不因最近记录自动打开；显式目标不可用时不替换为其他项目。原生编辑窗口继续严格使用宿主分配的项目 UUID。旧 last-project HTTP 已退役，见[下文](#private-last-project-locator已退役)。

受信 ServerInstance.projectEntries 的创建、按路径打开、window 租约等方法不是 HTTP/RPC/CLI/环境入口；JSON 里写 path、windowId 或 lease kind 不能取得这些能力。S6-B/B2 已提供主进程/utility 与真实窗口桥，S6-C 2b 按公开能力接入桌面界面，接口与生命周期见 [PROJECT-HOST.md](PROJECT-HOST.md#s6-a项目目录与受信控制)。

S6-C 2a 接入 12-04 素材状态与 12-06 外部位置的现有 HTTP 能力、严格 DTO 适配和内容读取门，以及受控的新建、打开错误、位置风险 UI、四语和目录身份迁移。状态读取走项目 RPC 的 `asset.media.status.list`；外部位置列表和明确确认走项目的 `asset-media/trusted` 固定入口。缺失、变化、未确认或尚未取得有效状态的内容不能触发素材读取；未知写入保留原请求归属，不用刷新列表证明成功。本批不代表全部 Q 或 S6-C 流程完成。

S6-C 2b 消费原生桥：重新指向直接使用 `__mioonAssetMediaNative` 的 choose/apply/discard，页面不提交路径或替代 owner token。原生选择绑定项目、素材及修订，外部目录同意仍由宿主取得；取消不导入、登记或写授权。未知 apply 保留原 preview/requestId，只有用户明确重试原操作才调用同一输入，不自动重发；owner 失效后保留未知关闭保护，不让新 owner 借旧票据。

打开与新建使用受信项目入口；`opened` 表示宿主已经开窗或聚焦，不再开第二次。副本原件名称与路径只来自验证结果，打开原件只传票据；权限帮助只打开固定系统设置页，Reveal 只传登记项目或票据。只读/网络来源继续拒绝原地打开，`copyTo` 用受信只读来源和共享系统存储面板，不覆盖目标。位置风险仅来自真实卷事实，关闭提示仅影响本次窗口会话。

系统打开产生的待确认结果存入宿主后，通过固定 `mioon:project-entries:pending-open:v1` 通道通知首页。通知只含严格校验的 backendId/windowId/contextId；预载与本页窗口上下文匹配后转成无参数 `subscribePendingOpen` 通知，取消订阅后不再回调。首页先订阅再读取，初始化读到 null 后仍接收迟到通知，不轮询；忙碌、隐藏或已有未知写入时保留待取信号，恢复可操作后读取。宿主按原票据期限和原文档归属验证并一次取走结果。副本/只读来源结果增加可选的正整数expiresAt，当前宿主始终提供原票据期限；读取在途时隐藏的结果保留至恢复可见，首次呈现前再次核期限，过期或旧文档结果不显示。旧桥没有订阅方法或该字段时仍兼容初始化读取。

缺失或过期的入口票据报409 `PROJECT_ENTRY_TICKET_EXPIRED`。首次派发时，这是本次请求尚未进入后台的确定拒绝；副本/只读提示保留原问题并显示“这次请求已过期，请重新打开项目文件”，取消和正常关闭可用，目的地选择失效仍要求重新选择。操作缓存继续先于票据校验；已有未知操作的重放即使收到此码，也不能证明原写入未执行，原retry/intent与关闭保护继续保留。

窗口隐藏只阻止开始新动作，不改变已派发写入的 owner。隐藏时收到确定创建回执，恢复可见后沿原许可打开，不重新创建；未知结果恢复可见后仍可明确核对。租约、退出、backend/context 或目录身份失效继续撤销旧 owner。编辑器传当前打开项目 ID，卡片禁用该项目的废纸篓操作；编辑器不提供宿主必然拒绝的复制入口。

首次派发时，`createAtSelection`、`duplicate`、`copyTo`、`instantiateTemplate` 的 main 层 409 `PROJECT_ENTRY_UNAVAILABLE` 是写入前拒绝，提示重新系统选择；`copyTo` 必须重新观察来源再选择目标。未知写入的重放可能在操作缓存之前收到 409 或 BUSY，这不能证明原写入未执行，必须恢复原 retry/intent，保留未知与关闭保护，不能放开新的创建或复制。`adoptCopy` 的同码可能发生在写入后，仍保留未知。打开最近项目时，仅尚未消费 renderer admission 的 main busy/owner 拒绝可以解除 openUnknown；消费后的同码不能证明未开窗。

模板实例化补桥新增可选 `templates` 能力（当前仅 `timeline-basics` v1）、`chooseLocation` 的 `template` 用途与 `instantiateTemplate`。main 把真实目标及模板信息绑定到 backend/window/context 的一次性票据；页面只提交 token、固定模板 ID/版本、名称、原 requestId 和可选 `locale`，不能提供 parentDir/路径。私有 main→utility 严格校验命令与复制回执后调用既有 S5 实例化。没有验证过的资源时不声明该能力；取消零写，同票据同输入只回放原结果，目标存在拒绝。确定回执后通过原先确认所发的局部许可，再核目录并打开新 ID；开窗失败只重试打开，不再实例化。

首页发起时固定界面语言（`zh-Hans`、`zh-Hant`、`en` 或 `ja`）。保存面板仍确认项目名，模板校验后在新实例里写入该语言的项目描述和素材显示名。语言参与请求回执校验，省略时沿用模板中的原始文字。

模板未知回执不能靠重放已拒绝的 promise 核对。界面如实提示项目可能已建好，允许刷新列表和关闭对话框；不自动实例化、不开假回执，也不把列表刷新当作完成证明。关闭后可以明确打开已有项目，未知关闭元数据仍保留，新写继续阻止。按 requestId 查 S5 回执留 0.1.x。模板目标占用检查在位置探测之后异步执行，签票前同时检查所选文件和实际项目目录。

应用 RPC `project.delete` 已采用 S5-C 的移到废纸篓语义：严格确认登记路径、文件身份及项目 revision，仅受信桌面主进程调用 `shell.trashItem`，确定成功后撤登记并保存固定回执。素材及全部本机记录保留；打开窗口、会写回项目的工作或 Mio 等待回答/审批时拒绝，S8 草稿不阻止。没有受信能力的网页/headless 返回 `PROJECT_TRASH_UNAVAILABLE`；CLI/MCP 命令留 0.1.x，在输入/私有存储/后端访问前明确拒绝。同键重放确定回执，结果不明不重做、不撤登记。旧 `confirmPermanentDeletion` 严格报 `VALIDATION_ERROR`（400），没有永久清理或 `cleanup:'pending'`。详见 [PROJECT-LIFECYCLE.md](PROJECT-LIFECYCLE.md)。

首页废纸篓使用私有 browser RPC 客户端区分确定 4xx 拒绝与网络/协议未知；明确 unconfirmed 的 4xx 仍未知。页面 lifetime 变化后，只在目录身份相同且用户重新明确同意时使用原请求核对；其他 native unknown、busy、输入、上下文及租约守卫不豁免。

界面按真实能力显示入口；未有端口时按 D8 隐藏，不从后端服务的存在推断原生能力：

| 归属 | 操作 | 当前结果 |
| --- | --- | --- |
| S6-B/B2、S6-C 2b | 系统项目选择、可信重新指向、权限帮助/Reveal、复制到和复制项目 | 桌面能力就绪时接入；`saveAs=false`，另存为继续隐藏 |
| S6-D、S5-C、S6-C 2b | 从示例开始、移到废纸篓 | 桌面资源/能力就绪时显示；移除仅依确定回执，未知保留原意图和项目卡片 |
| V4 | 打包导入导出；旧 `/api/project-packages/…` 和项目 `package-preview` | 未注册生产接口，旧地址为 404 `NOT_FOUND` |
| S7 | `workspace.backup.create/inspect/list/restore.stage/status`、`/api/workspace-backups/…`（bundle 下载/导入、directory 导入） | 404 `UNKNOWN_OPERATION`（旧文件地址为 `NOT_FOUND`） |

`workspace.restore.inspect` 已完全退役，返回 404 `UNKNOWN_OPERATION`。音频角色和音量包络直接按普通编辑条件使用，不再发能力探测。工作区设置仅保留真实生成开关和修订号，详见 [工作区设置](WORKSPACE-SETTINGS.md)。

项目隔离也作用于幂等与容量：相同 `requestId` 在不同项目各自保存回执，不能跨项目重放。原 `Global/workspace` 配额现在只在当前项目库计算；N 个项目的图片排队/任务/请求可达 `8N/1000N/3000N`（旧总量 `32/10000/30000`），帧排队/活跃/任务/请求可达 `2N/1N/256N/4096N`（旧 `8/1/2048/32768`），LUT 可达 `128N` 个及 `64 MiB × N`（旧 `512` 个及 `128 MiB`）。每项目约束不变；S3-A只限制应用任务索引4096/单项目512条，跨应用运行总量调度留0.1.x，历史/LUT/Mio存量硬限另卡。

任务事务已经提交、随后应用索引确认失败时，503 `BACKGROUND_TASK_INDEX_UNCERTAIN` 的 `details.mutationOutcome` 为 `unknown`；原任务与回执保留，不能当作确定未执行而另发生成。完整恢复与发现窗口见 [后台任务](BACKGROUND-TASKS.md)。

## 按项目寻址

项目级 RPC 使用 `POST /api/projects/{projectId}/rpc`，托管媒体使用
`GET /api/projects/{projectId}/media/{assetId}`（也支持 `HEAD`）。项目 ID 必须是
实际记录的小写 UUID；不根据实体 ID、当前窗口或最近打开的项目猜测。
请求认证先于项目存在性检查。地址改变不修改业务输入、响应、权限、revision
或精确重放规则。

应用级 RPC 继续使用 `POST /api/rpc`：`project.create/list/summary.list/rename/delete`、
`provider.list`、`video.connection.list`、`image.profile.list`、
`agent.authorization.grant/list/revoke`、`workspace.settings.get/set`、
共 19 个。登录、应用设置、全局 Agent 策略/诊断等应用级 HTTP 接口保留原地址；
把应用级操作发到项目 RPC 地址返回 HTTP 400 `VALIDATION_ERROR`。

这 11 个项目级操作的业务输入只标识实体，不新增 `projectId`：
`edge.delete`、`export.get`、`generation.submit`、`job.cancel/get/reconcile/retry`、
`node.update`、`shot.update`、`version.list/select`。直接 HTTP 调用通过 URL
指定项目；共享客户端使用 `rpc(operation, input, {projectId})`。CLI `--input` 和
MCP arguments 则须额外携带 `projectId`，传输层取出它用于地址，不把它送入业务
input。其余项目级操作继续保留原有 `input.projectId`，
`image.review.prepare` 使用 `input.input.projectId`。

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `PROJECT_NOT_FOUND` | 404 | 地址中的项目未登记；details 为 `{projectId}` |
| `PROJECT_ID_MISMATCH` | 400 | 输入或查询参数中的项目与地址不一致；details 携带地址中的项目 ID |
| `PROJECT_UNAVAILABLE` | 409 | 项目已登记但无法打开；details 为 `{projectId,reason,invalidReason?}`，reason 为 `PROJECT_MISSING/PROJECT_LOCKED/PROJECT_FORMAT_NEWER/PROJECT_INVALID` |

实体或媒体属于其他项目时与不存在统一返回 HTTP 404 `NOT_FOUND`，不返回它所属的
项目。上述寻址检查不授权打开另一个存储或自动恢复任务。

下列项目级 HTTP 接口也接受 `/api/projects/{projectId}/` 前缀：
`version-comparison/media`、`timeline-audio-preview/…`、`export-files`、
`images/reviews/approve|reject`、`local-drafts…`、`local-delivery…`、
`local-shot-text…`、`tasks…`，以及 Agent v2 的项目任务和 `editing` 接口。
Agent 项目任务原 `/api/agent/tasks/v2/{projectId}/…` 对应
`/api/projects/{projectId}/agent/tasks/v2/…`；全局 `policy` 和 `diagnostics`
不移入项目路径。请求中已有的项目字段仍须与地址一致。

Mio 模型步骤失败的 `error` 保留原有 `code` 和 `message`，可另含
`diagnostic`。HTTP 诊断与连接测试同形，协议诊断含原因、事件、输出类型或字段名，
上限诊断含触发的上限标签。新 Responses 事件名须以 `response.` 开头，包含一至四段标识符，总长最多 96 字节。
Anthropic 事件、输出类型和字段的新名称使用单个标识符。标识符以 ASCII 小写字母开头，后续可用小写字母、数字和下划线，最多 41 字符。
不符合格式的名称用 `unrecognized` 表示。诊断没有服务商错误原文、模型文本、
工具参数、密文、请求体或密钥，随步骤一起保存。旧步骤可省略该字段。

K2 曾保留的旧项目地址已在 P4 退役：把项目操作发到应用 `/api/rpc` 返回 400
`VALIDATION_ERROR`；认证后的旧项目 REST 和 `/media/{assetId}` 返回 404
`NOT_FOUND`。`project-routes.ts` 只供内部测试适配，生产入口不导入它。
下文沿用旧后缀描述的项目接口，统一按上述项目前缀调用。历史记录内保存的媒体
`url` 不重写；新读取/下载根据记录的项目 ID 和素材 ID 构造实际地址。

## 请求与响应

`POST /api/login` body `{"token":"<local token>"}` exchanges the token for a browser cookie.

应用级 `POST /api/rpc` body 示例（项目级 RPC 使用上面的项目地址）：

```json
{"operation":"project.create","input":{"name":"我的影片"}}
```

Response: `{"ok":true,"data":...}`. Error: `{"ok":false,"error":{"code":"REVISION_CONFLICT","message":"...","details":{"currentRevision":2},"retryable":false}}`. HTTP 400 invalid input, 401 unauthenticated, 403 invalid origin/provider disabled, 404 missing record/operation, 409 stale revision or idempotency conflict. Do not blindly retry a generation with a new key when a response is lost; replay the original exact request.

For business RPC, the runtime schemas in `packages/contracts/src/index.ts` are authoritative and strict (unknown fields rejected). `docs/CONTRACT.md` documents full-record and mutation input/record contracts. MCP tools expose these schemas plus the project-address field for the 11 entity-addressed operations through tools/list.

### 画布编辑（格式 4 候选）

画布操作使用 `POST /api/projects/{projectId}/rpc` 和独立严格契约 `packages/contracts/src/canvas-editing.ts`。只有以格式 4 候选入口打开的项目支持以下操作。默认桌面和 Web 宿主仍按格式 3 打开项目。

- `canvas.archive.preview` 校验选中目标的修订和删除或恢复条件。删除影响已有生成版本或剪辑时，提交要带预检返回的确认值。确认绑定同一持锁项目连接、项目内容、目标及影响范围，最长两分钟。宿主关闭后须重新预检。活动任务或未决写入会阻止整批操作。
- `canvas.archive.list` 以 `next` 分页列出用户删除的项目内对象，返回批次和当前目标修订。恢复支持选中条目。附带 `batchId` 时，必须提交该批仍归档的全部用户删除条目。镜头顺序按项目文件保留的邻居恢复，邻居都失效时追加到末尾。
- `canvas.apply` 原子提交删除、恢复、移动或整理。格式 4 的 `project.get` 在同一事务返回活体和 `canvasEditBase`，其中包含共享目标修订、`contentSequence` 和 `contentToken`。整理提交携带这些凭据和布局函数返回的坐标。项目已改变时，须重新读取并计算布局。既有剪辑、素材和版本保留。
- `canvas.history.get` 返回画布游标、两边动作以及各自的 `undoConflict` 和 `redoConflict`。撤销和重做只核对目标动作的修订、顺序和关联。补丁按最多 100 步及 8 MiB 保留，与剪辑历史和回执窗口独立。
- 写入携带 `historyRevision`，并用 `createCanvasRequestId(requestEpoch, uuid, issuedAt)` 生成 `requestId`。从 `canvas.history.get` 取 `requestEpoch` 和 `requestAfter`。时间戳是大于 `requestAfter` 的 Unix 毫秒，最多比服务时钟快两分钟。候选项目以可写方式打开时保存代际，首次编辑前重开同一份本机记录仍可使用原键。
- 响应丢失时，七天窗口内用同一请求 ID 原样重试可取回原回执。写入时清理已过期的回执并推进持久截止时间。活跃窗口暂满时返回 `CANVAS_RECEIPT_WINDOW_FULL` 和最早可重试时间。回执过期或本机记录已更换且查不到原回执时，返回 `CANVAS_REQUEST_OUTCOME_UNKNOWN`，客户端须先重新读取画布核对结果。

### Private last-project locator（已退役）

`GET /api/last-project`、`PUT /api/last-project` 及该路径的子路径已在 S6-C 2a 退役。保留现有 Host/Origin 和令牌/会话校验；通过校验后，无论 method、query 或 body，均返回 404 `NOT_FOUND`。不存在替代的 last-project RPC、CLI、MCP 或 Mio 操作。

生产 renderer 改用只读目录身份，不再保存选择；服务端不再构造旧定位服务或挂载其读写 handler。应用库中已有 `last-project-v1.json` document 的正常或损坏字节均留作不可达遗留，不删除、不修复、不迁移，本次也不提升库版本。旧 [`last-project.ts`](../packages/contracts/src/last-project.ts) 契约与 [LAST-PROJECT.md](LAST-PROJECT.md) 仅保留为历史实现和单元测试依据，不表示生产接口仍可调用。

### Private clip-property drafts

The authenticated `/api/local-drafts/clip` GET/PUT/DELETE and
`/api/local-drafts?projectId=…` GET routes share the bounded local-draft service.
These are renderer draft storage, outside RPC/MCP/CLI and the Agent catalog.
They cannot execute timeline edits or model tasks. Exact fields, limits,
workspace/instance binding and CAS are specified in
[`local-drafts.ts`](../packages/contracts/src/local-drafts.ts) and
[the first-slice scope](LOCAL-CLIP-DRAFTS.md). Reads do not create or reset files.
Unconfirmed writes require read-only reconciliation before any new write.

### Private delivery-name drafts and export intents

The authenticated `/api/local-delivery` boundary is private first-party renderer
storage and fixed-purpose local export recovery. It shares the existing
Host/Origin/authentication gates and returns `Cache-Control: no-store`. It does
not add an RPC, CLI/MCP tool, Agent capability, native bridge or arbitrary
operation executor. The existing public `timeline.render` schema is unchanged.
Implementation is under acceptance; see [scope and pending gates](DELIVERY-DRAFTS.md).

Exact, unknown-field-rejecting schemas are in
[`local-delivery.ts`](../packages/contracts/src/local-delivery.ts). IDs below are
UUIDs except the existing render `requestId`; `workspaceScope` is a backend-derived
SHA-256 scope and `instanceId` is the current service nonce. Each project's draft
and latest intent have separate monotonic CAS revisions.

- `GET /api/local-delivery?projectId=…`: exactly one query key; noncreating,
  read-only discovery. No other route accepts query parameters.
- `PUT /api/local-delivery/draft`: exactly `{workspaceScope,instanceId,projectId,
  expectedDraftRevision,draftId,timelineId,baseRevision,raw:{deliveryName}}`.
- `DELETE /api/local-delivery/draft`: exactly `{workspaceScope,instanceId,
  projectId,expectedDraftRevision,draftId}`. Retains a revision tombstone; a repeated
  DELETE without its deleted identity is a conflict, not a fabricated success.
- `POST /api/local-delivery/prepare`: exactly `{workspaceScope,instanceId,
  projectId,expectedIntentRevision,expectedIntentId,intentId,timelineId,
  baseRevision,draft,input}`. The prior intent ID is null only at revision zero;
  `draft` is null or `{draftId,revision,raw:{deliveryName}}`. `input` is the exact
  canonical `timeline.render` input restricted to `purpose:'export'`, with
  original project/revision/requestId and optional `deliveryName`,
  `exportSettings`, `exportRange`, `preflightSnapshotHash`. It preserves optional omission and
  must match the captured name and baseline. Prepare durably reserves the intent
  before any render dispatch; it never executes it.
- `POST /api/local-delivery/execute` and `POST /api/local-delivery/recover`:
  exactly `{workspaceScope,instanceId,projectId,intentId,expectedIntentRevision}`.
  Neither accepts a replacement input, operation nor caller-declared outcome.
  Explicit recovery may first execute a prepared-but-unsubmitted export; when
  an original receipt exists, it returns that receipt without another dispatch.

The raw draft holds only a valid-Unicode name of at most 512 UTF-16 units,
including incomplete/invalid-for-render names. It is not an output-settings
form draft. The immutable intent separately stores the complete original render
input. Empty draft name means omitted render `deliveryName`; actual dispatch
still uses the existing strict business name and closed profile validators.

Successful draft/discovery/prepare data is `{supported:true,workspaceScope,
instanceId,projectId,draftRevision,draft,intentRevision,intent,draftTargetStatus,
intentTargetStatus}`. Target status is independently `unset`, `matching`,
`changed` or `missing`. Each intent contains its ID, timeline/baseline, captured
draft or null, exact input, creation time and outcome. Outcomes are `pending`,
`accepted` with `exportId,responseSha256,resolvedAt`, or `not_applied` with
`code,resolvedAt`. Execution data is `{envelope,response}`; response is the
validated original queued acknowledgement only for accepted outcomes, otherwise
null. Accepted is business acceptance, not completed or decoded media.

Terminal acceptance requires the original hash-checked, ownership-validated
shared receipt. Terminal `not_applied` requires the existing proof validator for
the original input and rechecked receipt absence; generic errors or absent
receipts alone are insufficient. A durable `not_applied` intent never executes
again, even if current timeline/settings later become suitable. New preparation
requires exact terminal intent CAS. Accepted settlement clears only its exactly
captured draft, leaving later drafts intact.

Mount, GET, reconnect, restoring the name and reopening never execute/retry an
intent. Unknown prepare keeps the original request/CAS; an empty read cannot
release it. Explicit reprepare may adopt only a verified same-workspace new
instance nonce, not current draft/business revisions or a new request ID. If
another window changed the draft while preparation remained unconfirmed and no
exact saved intent is found, the original prepare remains a conflict. No automatic
rebase or conflict escape is promised.

Draft writes also pause after failure. An explicit retry of an unknown PUT
retains its exact draft identity, expected revision, original baseline and raw
name; a same-workspace read may update only the service nonce. Empty GET or a
later refusal never settles that earlier unknown write. After confirming the
original PUT, newer current input still requires explicit saving. Local input
validation refuses before sending, so correction followed by explicit saving is
available; confirmed service refusal likewise permits an explicit current-input
retry, without silently replacing a newly discovered candidate or rebasing it.
Read-only reconciliation alone never resumes these writes, and failed DELETE
is not retried as PUT.

Storage is the fixed private plaintext `local-delivery-v1.json`: at most 128
retained project slots, 8192 serialized bytes/slot and 2 MiB/file, independent
logical limits rather than disk quota. Tombstones count and are not evicted.
There are no credential/path/media fields, but user-entered name text and its
captured intent copy remain private user data. Existing backups exclude this
companion.

URLs are bounded to 2048 bytes, JSON request bodies to 12 KiB and ordinary data
envelopes to 12 KiB. Original render responses retain their 4 MiB limit; execution
data and the final HTTP success body are separately checked against 4 MiB + 12 KiB.
The renderer also streams and bounds the complete HTTP response: 12 KiB for
ordinary requests and 4 MiB + 12 KiB for execute/recover, with fatal UTF-8 decoding.
Its default whole-transport deadline is 10 seconds for ordinary requests and
35 seconds for execute/recover, including body reads. Timeout only aborts the
transport; it does not cancel backend work or prove nonapplication. Oversized,
malformed and timed-out responses leave the original result unknown.
Unsupported methods return 405; errors expose empty
`details` and `retryable:false`. Fixed codes map validation to 400, owner failure
to 403, missing route/target to 404, CAS/scope/instance conflicts to 409, size to 413,
capacity to 507 and storage/unconfirmed durability to 503. No error response can
supply renderer-authored settlement proof. Corrupt, foreign or unreadable storage
is never silently reset. See the scope document for exact durability and evidence
limits.

`provider.list` additionally returns exact `inputProfiles`, `inputProfileVersion`, `providerRegion`, `profileEvaluationDate` and `inputProfileEvaluations` for the production registry. They are read-only discovery, not request overrides or permission to spend. That original discovery increment left submit/retry schemas and historical replay unchanged; the later explicit subject-video input adds an optional `subjectVersionId` to submit, with historical replay preserved. See [model input limits](GENERATION-INPUT-LIMITS.md).

## Local source-frame extraction

Six strict RPCs share the existing authenticated backend. The authoritative
schemas and non-normalizing response validators are in
`packages/contracts/src/frame-extraction.mjs`. This increment is under acceptance;
see [source-frame scope and release gates](SOURCE-FRAMES.md). No native, live
provider or platform acceptance is implied by API availability.

| Operation | Exact input | Result / effect |
| --- | --- | --- |
| `frame.extract` | `{projectId,sourceAssetId,sourceHash,sourceFrame,requestId}` | Immutable original queued task acknowledgement; accepts one local decode |
| `frame.request.get` | `{projectId,requestId}` | `{projectId,requestId,operation,response}` or `null`; original acknowledgement only |
| `frame.task.get` | `{projectId,taskId}` | Current project-owned task |
| `frame.task.list` | `{projectId,limit?,cursor?}` | `{projectId,items,nextCursor}`; read-only |
| `frame.task.cancelQueued` | `{projectId,taskId,expectedRevision,requestId}` | Original `cancelled_before_start` acknowledgement; only provably unstarted work |
| `frame.task.recoverResult` | `{projectId,taskId,expectedRevision,requestId}` | Original `persisting` acknowledgement; verifies/publishes a complete local checkpoint |

IDs are UUIDs; `sourceHash` is lowercase SHA-256; `sourceFrame` is a nonnegative
integer 30fps editing mark, with the source end exclusive. It is not a native
source-frame index or observed VFR PTS. Profile `local-png-1024-v1` selects the
first presentation timestamp at or after that timepoint, then outputs one PNG
within 1024×1024 without upscaling. It does not promise browser-identical pixels.
The local initial profile permits managed MP4/WebM, one unambiguous H.264/VP8/VP9
8-bit yuv420p progressive stream, known zero start, square pixels and no rotation.
Source limits are 512 MiB, 600 seconds, edge 4096 and 8 Mi pixels; output is at
most 4 MiB. Unsupported capture sources remain usable by existing editor flows.
No path, filename, decoder command, profile override, provider or generic executor
is accepted. It calls no provider or network service and never changes originals,
existing clips, versions, exports, references or subject bindings automatically.

Tasks expose only `id,projectId,requestId,sourceAssetId,sourceHash,sourceFrame,fps,
profileId,state,revision,started,result,errorCode,createdAt,updatedAt`. A successful
`result` contains `assetId,sha256,mimeType,width,height,byteLength`; it names a new
managed image with `extracted-frame` provenance. Other states have `result:null`.
States are `queued`, `running`, `persisting`, `succeeded`,
`cancelled_before_start`, `interrupted`, `local_result_error`, `failed`.
Public DTOs omit bytes, local paths, snapshots and staged manifests. A task/ACK
response is bounded to 4 KiB. Pages default to 20/max 50, with cursors bounded to
768 bytes; use only a returned cursor unchanged with the same project and limit.
Cursors expire at backend restart; pages are not a frozen snapshot.

The three writes require caller-owned 8–200-character request IDs in a separate
workspace-wide frame namespace. Changed operation/input/project reuse conflicts
without disclosing another project's receipt. Exact replay returns the historical
original acknowledgement before current task revision checks, never another
extraction. Control ACKs retain the task's initial extraction `requestId`; their
own keys belong to their separate request receipts. Read current state before a
new control intent, and use its task revision (not a project/timeline revision).

Lost, malformed or mismatched success responses remain uncertain. First-party
clients keep the original operation/key in recovery guidance, never generate a
replacement key, retry automatically or normalize an invalid DTO. Preserve the
complete original input yourself. An authenticated backend refusal can resolve
nonacceptance only through exact `details.frameOutcome`:
`{status:"not_accepted",operation,projectId,requestId,inputHash}`. `inputHash` is
lowercase SHA-256 of shared `canonicalFrameInput(input)` for that exact operation.
Clients require HTTP 507 with `FRAME_CAPACITY`, or HTTP 409 with
`FRAME_QUEUE_FULL`, `FRAME_REVISION_CONFLICT`, `FRAME_STATE_CONFLICT`,
`FRAME_SOURCE_INVALID`, `FRAME_SOURCE_CHANGED` or `FRAME_RESULT_INVALID`.
Every identity field and the proof's exact shape must match. Any other status,
code, message, missing receipt or unverified marker cannot settle a previous
unknown write; unverified frame proofs are discarded. A proven fresh refusal
has `submissionMayHaveSucceeded:false`; an unknown frame write retains `true`.
Reads carrying a request ID never imply a submission.

Only explicit new extraction may decode. Restart classifies unfinished tasks as
interrupted; reads, replay and opening a panel never resume them. Explicit
`recoverResult` may publish the same verified staged PNG/manifest; missing or
corrupt checkpoints never trigger another decode. Running work cannot be
cancelled as unstarted. One local task is active, with at most two queued per
project/eight per workspace; retention is 256 tasks/project, 2048/workspace and
16 immutable ACKs/task, without silent eviction. Task metadata and request
journals use plaintext local SQLite; PNGs/manifests are local managed files,
not vault-encrypted. No built-in Agent tool/catalog or generic recovery allowlist
is expanded by these six external operations.

## Reference-film scene detection (2026-10-24)

Nine strict RPCs on the same backend detect the cuts of one owned reference
video, keep the resulting cut lists and build canvas shots from chosen segments
(storyboards, added 2026-10-25). Schemas and response validators are in
`packages/contracts/src/scene-tasks.ts`; the detector itself is described in
[reference scene detection](SCENE-DETECTION.md).

| Operation | Exact input | Result / effect |
| --- | --- | --- |
| `scene.detect` | `{projectId,sourceAssetId,sourceHash,options?,requestId}` | Immutable queued task acknowledgement; accepts one local decode |
| `scene.request.get` | `{projectId,requestId}` | `{projectId,requestId,operation,response}` or `null`; original acknowledgement only |
| `scene.task.get` | `{projectId,taskId}` | Current task, with live `progress` while it runs and, for a built storyboard, live `undo` |
| `scene.task.list` | `{projectId,sourceAssetId?,limit?,cursor?}` | `{projectId,items,nextCursor}`; newest first, read-only |
| `scene.task.cancel` | `{projectId,taskId,expectedRevision,requestId}` | Queued (or unstarted interrupted) task → `cancelled_before_start`; running task → `cancelling` |
| `scene.result.get` | `{projectId,assetId}` | `{projectId,assetId,result,current,staleReason}` for the newest saved result |
| `scene.cuts.save` | `{projectId,assetId,sourceHash,expectedResultId,cuts,requestId}` | Summary of a new manual result |
| `scene.shots.create` | `{projectId,sourceAssetId,sourceHash,resultId,segments,titlePrefix?,position?,requestId}` | Immutable queued storyboard acknowledgement; accepts one local decode |
| `scene.shots.undo` | `{projectId,taskId,expectedRevision,requestId}` | The storyboard task in state `undone`; its shots are deleted |

Detection:
- `options` may set `mode` (`adaptive`/`fixed`), `sensitivity` (0–100) and
  `minShotSeconds` (0.1–10); omitted fields use adaptive, 60 and 0.6. Task DTOs
  report the normalized options.
- The source must be an owned managed MP4/WebM within frame capture's limits
  (600 s, 512 MiB); its current hash must equal `sourceHash`. A detection or
  storyboard of a video that already has a queued, running, cancelling or
  persisting scene task is refused with `SCENE_TASK_ACTIVE`.
- The acknowledgement is committed before any decode. One scene task decodes at
  a time, with at most two queued per project and eight per workspace; 256 tasks
  per project and 2048 per workspace are retained, without silent eviction.
- A finished run saves the cut list as the video's newest result and the task
  becomes `succeeded` with `result:{id,frameCount,cutCount}`. More than 1500
  cuts fail the task with `SCENE_CUTS_LIMIT`.
- States: `queued`, `running`, `cancelling`, `succeeded`,
  `cancelled_before_start`, `cancelled`, `interrupted`, `failed`; storyboards
  also use `persisting`, `local_result_error` and `undone`. Only `interrupted`,
  `failed` and `local_result_error` carry an `errorCode`.
- Cancelling a running task stops its decoder; the task ends `cancelled` and saves
  nothing, even when the decoder had already finished.
- Restart turns queued, running and persisting tasks into `interrupted`
  (`SCENE_INTERRUPTED`) and cancelling ones into `cancelled`. Reads, replay and
  restart never decode; run a new task instead. A storyboard Mio accepted stays
  queued until its run resumes or stops.
- `progress` (`{frames,frameCount,cuts}`) is advisory, reported at most once per
  source second, and never stored or replayed.

Results:
- A result is `{id,projectId,assetId,sourceHash,origin,taskId,basedOnResultId,
  requestId,profileId,fps,frameCount,options,cuts,createdAt}`. `cuts` are
  `{frame,score}`: the first frame of each new shot on the 30 fps grid
  (`SOURCE_RANGE_FPS`). Detected results keep their options and scores.
- Every result is retained (256 per video, 4096 per project); the newest one is
  current. `scene.result.get` marks it stale with `SOURCE_CHANGED` when the
  video's hash no longer matches, or `PROFILE_CHANGED` when its scoring profile
  is not the current `scene-cuts-v1`.
- `scene.cuts.save` stores the complete edited list (strictly increasing frames
  below `frameCount`, at most 1500) as a `manual` result based on
  `expectedResultId`, which must be the current valid result; otherwise it fails
  with `SCENE_RESULT_CONFLICT` or `SCENE_RESULT_STALE`. A kept cut keeps its
  score; an added or moved cut has `score:null`. The response is the result
  summary (`cutCount` instead of `options` and `cuts`). While a storyboard of the
  video is in progress, `scene.cuts.save` is refused with `SCENE_TASK_ACTIVE`.

Storyboards (2026-10-25):
- `scene.shots.create` builds one canvas shot per chosen segment of `resultId`,
  which must be the video's current valid result (`SCENE_RESULT_CONFLICT`,
  `SCENE_RESULT_STALE`). `segments` are 1–100 strictly increasing segment
  numbers from 1: segment n runs from cut n−1 (or frame 0) to cut n (or
  `frameCount`); a number outside the result fails with `SCENE_SEGMENTS_INVALID`.
- Each shot is titled `<titlePrefix> NN` by segment number (default prefix
  `参考`), lasts the segment's length rounded to whole seconds within 1–20, has an
  empty prompt and takes the project format's aspect ratio (`9:16`, `16:9` or
  `1:1`; `9:16` before the project has a timeline). Its only reference is the
  keyframe at the segment's middle frame. Shots are laid out in rows of six from
  `position` (340 px apart, rows 300 px), or below the existing canvas content,
  and continue the shot order.
- One decode captures every keyframe with frame capture's profile and rule
  (`local-png-1024-v1`, first frame at or after the mark): packet timestamps are
  listed first, then exactly those frames are decoded. Marks between the same two
  source frames share one image; each segment still gets its own asset.
- A running storyboard reports `progress:{done,total}`. The keyframes are staged
  privately (`persisting` holds their receipt), published as PNG assets with
  `provenance:"scene-keyframe"`, and every image and shot is created in one
  transaction; the task becomes `succeeded` with `shots:[{segment,shotId,assetId}]`.
  Cancelling, failing (`failed` with `SCENE_KEYFRAME_UNAVAILABLE`,
  `SCENE_SHOTS_FAILED` and the decoder codes, or `local_result_error` with
  `SCENE_STORAGE_FAILED`) and restart leave no shots, images or staged files.
- Keyframe assets belong to their task's receipt: the media graph accepts them as
  shot references and generation inputs, and rejects one whose row no longer
  matches. They are not yet accepted as image-edit or subject sources.
- `scene.task.get` reports, for a `succeeded` storyboard, `undo:{available,blockers}`
  computed live; pages and receipts report `undo:null`. A blocker is
  `{segment,shotId,reason,fields?}` with reason `MISSING`, `GENERATED` (a job
  exists), `CONNECTED` (an edge touches it), `SUBJECT_BOUND` (any binding row,
  including a cleared one) or `EDITED` with the changed content fields
  (`title`, `prompt`, `referenceAssetIds`, `lastFrameAssetId`, `aspectRatio`,
  `duration`, `parameters`, `selectedVersionId`). Moving or reordering a shot
  does not block undo.
- `scene.shots.undo` deletes the batch's shots under task revision CAS; the task
  becomes `undone` and keeps its `shots` record, and the keyframe images stay in
  the library. A blocked undo fails with `SCENE_UNDO_BLOCKED` and
  `details.blockers`.

Writes need caller-owned 8–200-character request IDs in a workspace-wide scene
namespace; exact replay returns the original acknowledgement, and changed reuse
fails with `SCENE_REQUEST_CONFLICT`. A provable fresh refusal carries
`details.sceneOutcome:{status:"not_accepted",operation,projectId,requestId,inputHash}`
with `inputHash` = SHA-256 of `canonicalSceneInput(input)`. Clients accept it only
for HTTP 507 `SCENE_CAPACITY`, or HTTP 409 with `SCENE_QUEUE_FULL`,
`SCENE_TASK_ACTIVE`, `SCENE_REVISION_CONFLICT`, `SCENE_STATE_CONFLICT`,
`SCENE_SOURCE_INVALID`, `SCENE_SOURCE_CHANGED`, `SCENE_RESULT_CONFLICT`,
`SCENE_RESULT_STALE`, `SCENE_CUTS_INVALID`, `SCENE_SEGMENTS_INVALID` or
`SCENE_UNDO_BLOCKED`. Mio may run `scene.detect` and the four reads
as read-only tools (detection changes no project content) and wait for a task
with `task.wait` kind `scene`. `scene.shots.create` is a local irreversible Mio
tool: its images and shots appear after the call returns, so they are recorded
as a late change that the run's undo keeps; a stopped run retires its unstarted
storyboard. Cancelling, manual saves and storyboard undo are user actions.

## Local image generation and review preparation
### Single-PNG reference edits

The same `image.generate` accepts paired `purpose:"edit"` and
`inputImage:{assetId,sha256}` for Mock and the fixed official OpenAI slot. The
backend validates one project-owned managed PNG (8 MiB, maximum 1024 per edge,
opaque 8-bit RGB/RGBA) and derives immutable source provenance. Omit both fields
for the existing text-generation shape. Custom-compatible/Comfy editing, masks
and identity/pixel guarantees are outside this profile. Mock remains a static
test card. Official edits require the existing private user review; preparation
also performs bounded local source-byte validation. Keep the exact request key
through uncertain outcomes. See [single-PNG editing](IMAGE-EDITING.md) for the
strict source/output contract, disclosure and current verification status.



The same RPC exposes `image.profile.list`, `image.generate`, `image.request.get`,
`image.task.get/list`, `image.group.get/list`, `image.version.list`,
`image.task.cancelQueued`, `image.task.recoverResult`, the two local-ComfyUI
remote operations below, and exactly three review operations. Image schemas and bounded DTOs are authoritative in
`packages/contracts/src/images.mjs`, `image-reviews.mjs` and `comfy-images.mjs`.
[Image generation](IMAGE-GENERATION.md) includes the exact generation request.

Mock produces a deterministic local 1024×1024 PNG test card, not prompt-conditioned
imagery. The fixed OpenAI activation checkpoint `4e66a96` (2026-10-10) passed its
461-test affected gate, builds, Linux synthetic-network native acceptance and
full suite (2758 total, 2756 passed, 0 failed, 2 skipped). The current
[custom Images increment](IMAGE-COMPATIBLE.md) is implemented with its
own passed focused/build/Linux synthetic-native gates and independent full suite
(2857 total, 2855 passed, 0 failed, 2 skipped). Neither checkpoint establishes real-provider or macOS/Windows
acceptance. Official OpenAI retains its fixed destination/model/options. The
custom slot adds `providerId:"openai-compatible"` and its configured model to
the same generation request shape; endpoint/credential/approval overrides are
not public inputs. Agent/video credentials cannot activate Images. Discovery
reports local availability with `offline-tested-not-live` evidence, not live
compatibility or permission to spend.

`image.profile.list` accepts `{}` (unchanged legacy response) or
`{"includeSettingsRevision":true}`. The latter may add `settingsRevision`, a
positive safe integer, to an existing official/custom/local-ComfyUI profile.
It comes from the same safe snapshot as that slot's displayed metadata. Mock,
missing/zero/invalid/unreadable revisions never get an invented value; incomplete
custom/Comfy configurations remain omitted as before. `false` behaves like omission.
No endpoint, key, secret storage data or settings object is returned. The read
neither decrypts nor probes, prepares, approves or dispatches. A revision is a
freshness value, not permission; unavailable profiles remain unavailable.
Use the selected provider's returned revision for a new review, and let existing
CAS reject later changes. Do not replace a retained intent's revision or request
key automatically. See [profile discovery](IMAGE-PROFILE-DISCOVERY.md).

| Review RPC | Strict input | Result / effect |
| --- | --- | --- |
| `image.review.prepare` | `{input:<complete official/custom/local-ComfyUI image.generate input>,settingsRevision}` | Retained exact request/configuration review; local database write and bounded PNG validation for edits |
| `image.review.get` | `{projectId,reviewId}` | Existing owned review; read-only |
| `image.review.list` | `{projectId,limit?,cursor?}` | `{projectId,items,nextCursor}`; read-only |

`settingsRevision` is a positive safe integer. The stable generation `requestId`
is nested in `input`; no extra top-level key, secret, approval flag or endpoint
is accepted. Preparing never approves or dispatches. Exact preparation repeats
return the same identity with its retained current state; changed input/project/
settings revision under its key conflicts. Review fields, state transitions,
plain-local-SQLite storage and limits are specified in
[Images activation](IMAGE-ACTIVATION.md#shared-public-review-operations).

New direct official/custom/local-ComfyUI `image.generate` calls remain blocked without private
review approval. `image.generate` effect metadata nevertheless includes possible
separately approved worker activity: external I/O, paid generation, open-world
access and database/file writes, without local subprocesses. Review preparation
writes local records and, for edits, validates the selected local PNG; reads never dispatch. A local RPC POST used for reads
is not a provider POST. No metadata grants paid Agent authority.

The original three image mutations require an exact stable request ID.
`image.generate` returns its original queued task receipt; query `image.task.get`
for current state. After lost acknowledgement use `image.request.get` in the same
project or replay the exact original input. Do not automatically reapprove or
re-key unknown work. New group versions need both `groupId` and `expectedRevision`;
generated assets never automatically alter a timeline, subject or first-frame
reference. The image request namespace is separate from older mutation journals.
Image/review pages default to 20 records (maximum 50); public DTOs omit result
bytes, secrets and filesystem paths. Review intents are bounded at 32 KiB, rows
at 64 KiB, retained reviews at 1000/project and 10,000/workspace, with no cleanup.
The nested generation input retains its original 24-KiB bound.

### Private Images application routes

Authenticated `GET`/`PUT /api/images/settings` manages the dedicated fixed preset
and redacted secret metadata. It is not an RPC/CLI/MCP/model-tool setting. Web
credentials are session-only for the backend lifetime; Electron persistent
storage uses a narrow main-process OS codec, never renderer/preload decryption
or plaintext fallback. Saving settings neither generates nor approves a request.
The exact official secret-write/read contract is in
[Images activation](IMAGE-ACTIVATION.md#private-authenticated-http-settings-contract).
The separate authenticated `GET`/`PUT /api/images/custom-settings` manages the
v2 custom collection. PUT carries action `create`, `put`, `remove` or `batch`,
the collection revision, and the lowercase draft UUID. Updating/removing an
existing item also checks its configuration revision. Each configuration keeps
provider `openai-compatible`, profile `openai-images-json-png-v1`, a canonical
public-DNS HTTPS URL and a bounded ASCII model. Model changes keep the recipient
key; an address change with `keep` detaches it. Saving validates syntax without
probing. See [generation services](GENERATION-SERVICES.md) for fields and limits.

Web/client-only `POST /api/projects/{projectId}/images/services` accepts
`{operation,input}` for `image.service.list` and `image.service.review.prepare`.
The latter freezes the explicit connection UUID, its configuration revision,
full configuration and actual destination. Old no-ID entry points resolve an
exact single service and reject ambiguous collections. The new operations are
absent from RPC/CLI/MCP/Mio discovery; both fixed request catalogs remain intact.
Official and retained custom v1 review DTOs stay readable.

Authenticated `POST /api/images/reviews/approve` and `/reject` each take exactly
`{projectId,reviewId,expectedRevision}`. Approval returns the original queued
image-task receipt; rejection returns the retained review. These private UI
routes are absent from RPC, CLI, MCP and model-tool discovery. Local token/session
authentication is not cryptographic human-presence proof or permission for an
external agent to approve. The user explicitly approves the visible exact
prompt/project/model/options/destination and at most one POST. Official/custom
Images have unknown usage-based cost; local ComfyUI has unknown local compute cost. This is not a currency spending cap or a per-image budget wizard.

The dispatch gateway checks changed settings and pending saves synchronously at
the same final boundary as the durable review/task dispatch fence and network
`end()`. No automatic retry follows unknown outcomes or restart; result recovery
only validates and publishes an existing task-bound local receipt and staged PNG.
See [Images activation](IMAGE-ACTIVATION.md) for the authority, persistence,
network boundary, and [custom Images](IMAGE-COMPATIBLE.md) for schema 18 and the
current validation results and remaining live/native-platform limits.

### First-party local ComfyUI increment (synthetic validation)

`comfy-local` adds a separate fixed `comfy-t2i-png-v1` text-to-image profile for
ComfyUI `0.39.0`: seven nodes/six standard classes, exactly one 512×512 PNG.
It requires a user-selected installed checkpoint, explicit connection check and
per-request application review. Opening/saving settings does not probe. No
runtime/model installation, image upload, arbitrary workflow, public endpoint,
remote cancellation or real-runtime acceptance is included.

`GET`/`PUT /api/images/comfy-settings` reads/saves the independent no-secret
configuration; PUT is exactly `{expectedRevision,configuration}`.
`POST /api/images/comfy-check` takes `{baseUrl,model?}` and explicitly performs
bounded GETs for version/nodes/checkpoints. Its successful evidence is RAM-only.
Only root HTTP origins with literal `127.0.0.1` or `[::1]` and an explicit port
are accepted, excluding Mioon's actual backend port. These private application
routes are not RPC/CLI/MCP/Agent tools. Local runtime trust remains the user's;
loopback and reported node/version names prove neither safety nor offline/free
execution.

The v3 review freezes full configuration, destination, graph/hash, seed,
prompt/client UUIDs and output nonce. User approval permits at most one POST;
prompt UUID reuse does not provide ComfyUI idempotency. No automatic retry or
runtime polling follows submission or startup.

| Shared operation | Strict input | Effect |
| --- | --- | --- |
| `image.task.remote.get` | `{projectId,taskId}` | Local read of retained `{projectId,taskId,remote,observation}`; never contacts runtime |
| `image.task.observeRemote` | `{projectId,taskId,expectedRevision,requestId}` | Durable explicit observation, then bounded job GET and at most one verified result GET |

Observation `expectedRevision` is the current `remote.revision`; use a distinct
stable 8–200-character request key. Exact replay returns the original queued
acknowledgement without another GET. Read the two task records for current state;
observation `finished` is not proof of successful generation. New explicit queries
use a new observation key and current remote revision. No operation permits
another generation POST or joins the built-in Agent allowlist. Old
`image.task.recoverResult` remains local-only. Terminal graph/client/nonce/status
checks and immutable descriptor/hash/byte pinning precede result staging.

Schema 19 adds remote runs/observations and v3 reviews while preserving legacy
rows/rowids/inputs/receipts and SQL objects, except the documented narrow
ComfyUI-verified `outcome_unknown` → `failed` lifecycle trigger branch. Observation
retention is 1000/project and 10,000/workspace, without eviction. This increment's
focused/build/Linux native synthetic checks and independent full suite passed
(2993 total /2991 pass /0 fail /2 skip); its first aggregate failures are retained. No real runtime, GPU
or model has been used. Exact contracts, bounded effects, migration and remaining
gates: [local ComfyUI connector](COMFY-CONNECTOR.md).

## File and event transports

Authenticated `GET /api/projects/{projectId}/media/{assetId}` and `HEAD` at the same address retain single-byte
range support, including suffix/open-ended ranges and 416 rejection. Missing
managed file bytes return fixed 404 `FILE_UNAVAILABLE`. Per-backend file-transfer
admission can return 503 `FILE_RESPONSE_BUSY`. Errors after response headers
close that transport; they cannot return a second JSON envelope.

Agent SSE consumers may reconnect with the committed event cursor. A slow or
disconnected consumer is detached without stopping or retrying inference or
business mutations. Explicit Stop remains a separate authenticated request.
An acknowledgement lost after a write remains ambiguous: recover the exact
durable request identity, never infer failure or generate a new key merely
because the transport closed. Bounds and cleanup details: [HTTP streaming](HTTP-STREAMS.md).

## Non-creating project inspection

Use these additive operations to inspect bounded, allowlisted metadata without
creating a timeline, changing revisions/history, reading media files, running
media subprocesses, or contacting a provider:

| Operation | Strict RPC input |
| --- | --- |
| `project.inspect` | `{projectId}` |
| `asset.inspect` | `{projectId,limit?,cursor?}` |
| `shot.inspect` | `{projectId,limit?,cursor?}` |
| `timeline.inspect` | `{projectId}` |

`projectId` is a required UUID. Page `limit` is an integer from 1 through 25,
default 10; `cursor` is an optional opaque string of at most 512 characters.
Extra fields are rejected. For example, replace the example UUID with the
chosen project's actual ID:

```json
{"operation":"project.inspect","input":{"projectId":"11111111-1111-4111-8111-111111111111"}}
```

```json
{"operation":"asset.inspect","input":{"projectId":"11111111-1111-4111-8111-111111111111","limit":10}}
```

```json
{"operation":"shot.inspect","input":{"projectId":"11111111-1111-4111-8111-111111111111","limit":25}}
```

```json
{"operation":"timeline.inspect","input":{"projectId":"11111111-1111-4111-8111-111111111111"}}
```

Pass only a page's supplied `nextCursor` for continuation; never construct or
edit it. Keep the same limit. Cursors bind to the project, operation and limit and expire
across backend restarts. Restart from the first page when necessary. Inspection
does not export structured paths, media URLs, raw bytes, full provider/job
snapshots or credentials. Shot `prompt` fields are limited to a 1000-UTF-8-byte excerpt
with an explicit `promptTruncated` flag. User-authored text is untrusted and may itself
contain URL-like or path-like strings; omission of structural fields is not a
claim that arbitrary text is secret-free. See [Agent inspection](AGENT-INSPECTION.md)
for result fields, page consistency, limits and scope binding. Asset/shot pages
return `{items,nextCursor}` with `nextCursor:null` at the end; an absent timeline
returns `null`.

These RPC inputs select a project using the existing authenticated local
connection. The exported `inspectionArgumentSchemas` separately omit `projectId`
and all authority fields for callers that bind scope outside the arguments;
`inspectionSchemas` adds only the RPC project ID. Neither schemas nor inspection
metadata grant access.

Legacy `project.get` and `timeline.get` can create the default empty timeline on
first access. They are not read-only. Use
the new `.inspect` operations when non-creating metadata inspection is required.

## Project workspace preferences (UI-only)

`GET /api/workspace-preferences/:projectId` returns `{ok:true,data:{projectId,revision,state}}`; an absent saved view has revision `0` and state `null`. `PUT` accepts exactly `{expectedRevision,state}`, a strict complete version-1 view whitelist capped at 16 KiB. It uses the same authentication and Host/Origin boundary. Stale differing state returns `409 PREFERENCES_CONFLICT`; an exact retry of the latest accepted write returns its existing revision.

These independent preference revisions never update project/shot/timeline revisions, history or business idempotency. This endpoint is not a business RPC operation or MCP tool. Full fields, bounds, concurrency, migration and close behavior: [Workspace preferences](WORKSPACE-PREFERENCES.md).

## Example Node client

```js
import {rpcPathFor} from './packages/contracts/src/project-addressing.ts';

const call = async (operation, input, entityProjectId) => {
  const resource = rpcPathFor(operation, input, entityProjectId);
  const response = await fetch(`http://127.0.0.1:4318${resource}`, {
    method: 'POST',
    headers: {'content-type':'application/json', authorization:`Bearer ${process.env.MIOON_TOKEN}`},
    body: JSON.stringify({operation,input})
  });
  const result = await response.json();
  if (!result.ok) throw result.error;
  return result.data;
};
const project = await call('project.create', {name:'短片'});
```

Run this source example from the repository root with Node.js 24+. For the 11 entity-addressed operations, pass the owning project ID as the third argument and keep the business input unchanged.

Assets are imported as base64 bytes, never arbitrary machine file paths or remote URLs. Metadata and generated media IDs map to managed files. Download `/api/projects/{projectId}/media/{assetId}?download=1`; requests support byte ranges for browser video playback.

## Concurrency, retries and recovery

- shot.update/node.update/version.select require expectedRevision; stale values reject with the current record, never overwrite silently
- shot.reorder checks the project revision and must be an exact permutation of all shots
- generation.submit requires a stable requestId. Same exact input returns original job before checking current shot revision; same ID with altered payload yields IDEMPOTENCY_CONFLICT
- job.retry only accepts a definitively failed job plus a new requestId, retains the old snapshot, creates a linked new job
- job.reconcile resumes a known task or reconciles its request key without submitting. An optional verified providerJobId can attach an existing unknown task
- job.cancel stops local waiting only and explicitly returns cancelScope=local_only
- Result versions have a database immutability trigger, unique job ID and immutable files; first output auto-selects only if no selection exists
- export.create freezes shot order and chosen version IDs/hashes. Later edits do not change that export

## Optional exact replay for local edits

`shot.create`, `shot.update`, `shot.reorder`, `node.create`, `node.update` and
`version.select` accept optional `requestId` (8–200 characters). Supply and retain
one stable ID for each intent when recovery is needed. Without it, legacy calls
remain non-idempotent. Exact replay returns the original immutable response,
including original IDs/revisions, after ownership validation and before current
revision checks; changed operation/project/input under the key returns
`IDEMPOTENCY_CONFLICT`. New intentional edits use new keys and current revisions.
Mutation and receipt commit in the same synchronous SQLite transaction. Replaying
is not a read of current state; refresh before later edits. Missing/foreign/corrupt
ownership cannot be bypassed by an old receipt.

A fresh keyed business rejection can provide
`error.details:{mutationOutcome:"not_applied",requestId:"..."}` only after the
backend observed no prior receipt and rolled back. Other 4xx, malformed results,
authentication failures or lost responses are not no-commit proof. No HTTP client
or built-in Agent automatically retries these operations. Existing timeline,
reference and generation/export contracts are unchanged. See
[shared mutation replay](MUTATION-REPLAY.md) for UI recovery and persistence limits.

## Image-node generation inputs

Use `reference.attach` with `{projectId,sourceNodeId,targetShotId,expectedSourceRevision,expectedShotRevision,requestId,role:'first_frame'}` to connect a managed image node to a shot, returning `{edge,shot}`. Use `reference.detach` with `{projectId,edgeId,expectedShotRevision,requestId}` to remove it, returning `{edge,shot,detached:true}`. The operations are atomic and share strict schemas across HTTP, CLI and MCP.

- One first-frame connection per shot, same-project endpoints and an existing managed PNG/JPEG/WebP image only.
- Clear and save a manual image choice explicitly before attaching (`REFERENCE_SELECTION_EXISTS`). Connected images cannot be silently changed via `shot.update` or `edge.delete` (`REFERENCE_CONNECTED`); detach first.
- Source node and shot revisions must be current. Detach checks the shot revision. Source image IDs cannot be edited through `node.update`.
- Preserve the exact request after an uncertain result. Replay returns its saved original response even after later edits or restart; changed reuse conflicts. A repeated attach with a new ID and current revisions returns the existing edge without duplicates.
- UI/CLI/MCP validate complete operation-bound acknowledgements. Malformed success and later generic errors retain the original key; only fresh, pre-write, rolled-back reference rejection with exact operation/project/request proof permits clearing it. Historical replay revalidates ownership without requiring the old edge to remain present. Existing receipts gain DELETE/replacement retention triggers without data or schema-version changes. See [reference recovery](REFERENCE-RECOVERY.md).
- Detach preserves the managed asset, source node, generated versions and immutable in-flight snapshots. New generation snapshots also record the typed connection provenance.
- `edge.create` and all historical untyped edges remain decorative. They never supply generation inputs. No general graph execution or character/style consistency is implemented.

Model, MIME/dimension/ratio, budget and approved-media validation remain authoritative at generation time. Connecting an image makes no provider call. See [the full reference contract](CONTRACT.md#typed-first-frame-connections).

## Multitrack timeline (v2)

`project.get` additively includes a persistent `timeline`. Both it and `timeline.get`
accept `{projectId}` and lazily create the same empty default timeline for
legacy projects. Initial revision is 1; defaults are two video tracks and one
audio track. No existing shot or selected version is automatically copied.
On the project-addressed HTTP endpoint, `project.get` also returns
`data.projectFormatVersion` from the open project file (3 or 4). The UI uses
this field to determine which timeline format controls are available.

All timeline writes accept `{projectId,expectedRevision,requestId,...}`:

| Operation | Additional inputs |
| --- | --- |
| `timeline.track.add` | `kind:'video'|'audio'`, optional `name` |
| `timeline.track.update` | `trackId`, nonempty `patch:{name?,hidden?,muted?}` |
| `timeline.clip.add` | `trackId,assetId,startFrame,durationFrames`, optional `name,sourceInFrame,rect,gain,fadeInFrames,fadeOutFrames` |
| `timeline.clip.update` | `clipId`, nonempty `patch:{trackId?,name?,startFrame?,durationFrames?,sourceInFrame?,rect?,gain?,fadeInFrames?,fadeOutFrames?}` |
| `timeline.clip.replaceSource` | required `clipId,assetId`; optional `versionId` (exact generated version) |
| `timeline.clip.remove` | `clipId` |
| `timeline.clip.split` | `clipId,atFrame` (strict interior integer timeline frame; non-ripple) |
| `timeline.seed` | none; only an empty timeline with all shot selections present |
| `timeline.clip.refreshSources` | `clipIds` (1–100 unique clip UUIDs); see Canvas → timeline bridges |
| `timeline.shots.append` | none; see Canvas → timeline bridges |
| `timeline.render` | `purpose:'preview'|'export'`, optional `preflightSnapshotHash` (lowercase SHA-256), optional export-only `exportSettings` (closed MP4/H.264 profile), optional export-only `deliveryName` and `exportRange:{startFrame,endFrame}` |

Mutations return the whole timeline and increment its revision once; the two
canvas → timeline bridges wrap it with per-item outcomes. Rendering
returns a queued `exports` record with `mode:'timeline'`, a frozen snapshot and
`timelineRevision`; poll `export.get` for current progress. The snapshot and
render output are never changed by later edits. Rendering does not increment
the timeline revision. Preview/export composition semantics are identical.

Every timeline request ID has an immutable saved response. Exact replay returns
that original response, including after newer edits and process restart.
Altered reuse conflicts before revision checking. For timeline rendering,
replaying the create call returns the original queued record even after the
job succeeds; use `export.get` to observe completion.

Times are integer frames at 30fps. Output defaults to 720×1280; pristine timelines can explicitly select 1280×720 or 720×720 (see [format rules](TIMELINE-OUTPUT-FORMATS.md)); maximum 12 tracks,
100 clips, 18000 output frames. Reject same-track overlap, source overruns,
wrong track media types, cross-project references and invalid rectangles.
Unknown input fields (including nested patches and rectangles) reject. See
[`TIMELINE.md`](TIMELINE.md) for full rendering, bounds and migration semantics.

Clip `fadeInFrames` and `fadeOutFrames` are optional integer 30fps frame counts
from 0 to 18000. Each must fit the clip duration, and their sum cannot exceed it.
Missing fields mean zero without rewriting legacy clips, snapshots or saved
responses; explicit zero clears an existing fade. Positive fades require an
audio/video asset with `hasAudio:true`. Update validation uses the resulting
clip, so shortening a clip may require reducing its fades in the same patch.
Business bounds failures use `INVALID_FADE`; unsupported positive fades use
`FADE_AUDIO_UNSUPPORTED`; malformed fields use `VALIDATION_ERROR`. Rejections
change no timeline, history, redo branch or request journal.

Splits must also be outside the interior of a fade: the offset from the clip's
start must be at least `fadeInFrames` and at most
`durationFrames - fadeOutFrames`. Exact ramp boundaries are allowed if strictly
inside the clip. Otherwise `SPLIT_FADE_BOUNDS` returns absolute `minFrame` and
`maxFrame`. A successful split preserves the original outer fade-in/fade-out
and zeros only the corresponding present fields at the new inner edges.

Rendered previews and exports apply linear clip-local audio fades with existing
gain/mute behavior; source playback stays dry. The existing timeline revision,
undo/redo and exact-replay contracts apply. Bounded inspection DTOs and built-in
Agent permissions are unchanged. See [audio fades](TIMELINE.md#audio-fades).

`asset.import` also supports `audio/wav`, `audio/mpeg` and `audio/mp4` (M4A),
with byte-signature/decoded-stream validation and the existing 30MiB limit.
`node.create` also supports `type:'audio'` with a matching audio asset.
The original `export.create` selected-shot sequence behavior is unchanged.

### Explicit clip source replacement

`timeline.clip.replaceSource` accepts exactly
`{projectId,expectedRevision,requestId,clipId,assetId,versionId?}`. Project, clip,
asset and any supplied version are UUIDs; `expectedRevision` is the positive
current timeline revision. The stable `requestId` is **required** (8–200
characters); `versionId` alone is optional. The normal `timeline.clip.update`
patch still rejects `assetId`, `versionId` and other source/provenance fields.

This is an explicit, undoable edit of one existing clip. It preserves the clip
ID, name, track, start, duration, source in-point, rectangle, gain, optional fade
values and their exact presence/absence. Neighbors, gaps, track state and total
duration remain unchanged. It never adopts saved source marks, rescales,
retimes, changes audio settings or shortens a clip to fit. Only video→video,
audio→audio and image→image are allowed, including across supported containers
within that category. Image↔video remains incompatible even on a video track.
The new source must cover the unchanged source in-point plus duration and
support any retained positive audio fades.

Without `versionId`, only the fixed `assetId` is stored, even for a generated
asset. Old `versionId`, `shotId` and `jobId` links are cleared rather than
carried to another source. With an explicit `versionId`, the backend validates
the exact owned version/asset/shot/job lineage and asset hash, then pins that
version and its canonical `shotId`; no current shot selection is inferred or
changed. Later `version.select` calls never move this fixed clip.

Success returns the complete timeline, advances its revision once and records
one undoable history entry. Undo/redo restores the exact source and clip state.
Replacing with the already-current asset rejects with `SOURCE_UNCHANGED` (409),
even if a version is supplied; it adds no history or saved request. Incompatible
categories use `INVALID_CLIP_TYPE` (400), a too-short source uses `SOURCE_BOUNDS`
(400), and retained unsupported fades use `FADE_AUDIO_UNSUPPORTED` (400).
Missing/foreign/unsafe source or version lineage uses
`TIMELINE_SOURCE_UNAVAILABLE` (404). All rejection paths preserve timeline,
history, redo branch and request receipts.

A verified fresh-key business rejection may additionally return
`error.details:{...,mutationOutcome:'not_applied',requestId}`. This proof is
bound to that exact key and confirms that this attempt committed no mutation.
Only a checked fresh request with a rolled-back, pre-write revision/no-op/type/
bounds/fade rejection receives it. Missing proof, a different proof key,
ownership/receipt failures, authentication errors and idempotency conflicts do
not establish the outcome of an earlier uncertain attempt. Keep the original
request for explicit recovery instead of clearing it from a later 4xx alone.

The operation shares the existing timeline request-key namespace with timeline
edits, undo/redo and renders, across projects on the same backend; this is not a
new workspace-global key namespace covering unrelated operation families.
Changed operation/project/input reuse returns `IDEMPOTENCY_CONFLICT` before
revision checking. Exact replay retains the original complete response after
newer edits or restart, including original timestamps and provenance. After an
uncertain result, replay the full original input/key, preserving the optional
version's presence or absence and the original revision, then refresh before a
new edit. A new key with a stale revision returns `REVISION_CONFLICT`.
A malformed or mismatched success acknowledgement returns client-side
`BACKEND_PROTOCOL_ERROR` with `submissionMayHaveSucceeded:true`. The first-party
clients validate this operation's bounded full-timeline identity, target source
and optional provenance before clearing recovery state; retain and replay the
original request rather than assuming it failed or inventing another key.

Effects are limited to local timeline/history/replay database writes. No source
bytes, media files, probes, decoding, rendering, provider calls or paid
generation are involved. External HTTP/CLI/MCP discovery does not expand the
built-in Agent catalog, inspection DTOs, media context or approval scope.
Offline transport acceptance: `node --test tests/timeline-replacement-transports.test.mjs`.

### Canvas → timeline bridges (2026-10-23)

Two keyed timeline edits connect the storyboard to the timeline. Both take the
common `{projectId,expectedRevision,requestId}`, record one undoable history
entry and never move other clips. Their acknowledgement wraps the saved
timeline with per-item outcomes, bounded to 100 rows each:

- `timeline.clip.refreshSources` adds `clipIds` (1–100 unique clip UUIDs) and
  returns `{operation,requestId,timeline,refreshed,skipped}`.
  - A clip whose shot now selects another version switches to it with exactly
    the `timeline.clip.replaceSource` edit, pinned to that version and shot.
    ID, position, duration, source in-point, rectangle, gain and fades stay.
  - Each `refreshed` row is `{clipId,shotId,fromVersionId,toVersionId,assetId}`.
  - Skipped clips keep their state. Reasons: `NOT_GENERATED` (not from a
    generated version), `NO_SELECTION` (the shot selects nothing), `UP_TO_DATE`,
    and `SOURCE_TOO_SHORT` with `shortByFrames` (the selected version cannot
    cover `sourceInFrame + durationFrames`).
  - Rows keep request order. Every requested clip is either refreshed or
    skipped; an unknown clip rejects the whole request with `CLIP_NOT_FOUND`.
- `timeline.shots.append` takes nothing more and returns
  `{operation,requestId,timeline,appended,skipped}`.
  - Shots without any clip on the timeline are appended in canvas order with
    their selected version at full length, from frame 0 of the source, one after
    another after the last clip of the first video track, pinned to that version.
  - Each `appended` row is `{clipId,shotId,versionId,startFrame,durationFrames}`.
  - Shots selecting nothing are skipped with `NO_SELECTION`. The usual timeline
    limits apply to the whole request (`TIMELINE_LIMIT`).

When nothing can be refreshed or appended, the request writes nothing and
rejects with `NOTHING_TO_REFRESH` / `NOTHING_TO_APPEND` (409), listing the
reasons in `error.details.skipped`. A fresh-key pre-write rejection (revision,
revision limit, timeline limit, source bounds, clip type and these two codes)
carries a not-applied proof that always binds `operation`, `projectId` and
`requestId`; a missing clip or track does not.

Exact replay returns the original wrapped acknowledgement. Both are local
reversible Mio tools. They are not part of the durable local edit-task ledger,
whose table checks its fixed operation list.

### Split at scene cuts (2026-10-24)

`timeline.clip.splitAtScenes` takes the common
`{projectId,expectedRevision,requestId}` plus `assetId` (the reference video) and
`resultId` (its current scene result) and returns
`{operation,requestId,timeline,split,skipped}`.
- Every clip of that video is split at each cut strictly inside its source range
  (`sourceInFrame` to `sourceInFrame + durationFrames`), left to right, with the
  `timeline.clip.split` edit: the original clip keeps its ID and first piece,
  pieces stay contiguous in time and source, and outer audio fades stay at the
  outer edges.
- Each `split` row is `{clipId,clipIds,cutFrames,fadeCutFrames}`: the pieces in
  order, the source frames they start at, and in-range cuts left out because they
  fall inside an audio fade-in or fade-out.
- Clips without any applicable cut are `skipped` with `NO_CUT_IN_RANGE`, or with
  `FADE_BOUNDS` and their `cutFrames` when every in-range cut is inside a fade.
- The whole batch is one history entry. With nothing to split it writes nothing
  and fails with `NOTHING_TO_SPLIT` (409, `error.details.skipped`). A result that
  is no longer the video's newest fails with `SCENE_RESULT_CONFLICT`; a stale one
  with `SCENE_RESULT_STALE`. These, revision conflicts and `TIMELINE_LIMIT`
  (the 100-clip limit) carry not-applied proofs binding `operation`, `projectId`
  and `requestId`.

Exact replay returns the original acknowledgement. It is a local reversible Mio
tool, outside the durable edit-task ledger.

### Crossfade (2026-10-28)

`timeline.clip.crossfade` takes the common
`{projectId,expectedRevision,requestId}` plus `outgoingClipId` and
`incomingClipId`, and returns `{operation,requestId,timeline,crossfade}` with
`crossfade` = `{outgoingClipId,incomingClipId,startFrame,durationFrames}`.
- The two clips are on different tracks and satisfy
  `out.start <= in.start < out.end <= in.end`: the incoming clip starts within the
  outgoing one (possibly on the same frame) and ends no earlier than it. The
  overlap runs from the incoming clip's `startFrame` to the outgoing clip's end.
  Same-track clips cannot overlap, so a same-track pair never qualifies.
- Both clips must have sound: images and sources without audio fail with
  `CROSSFADE_AUDIO_UNSUPPORTED`.
- The edit writes one linear volume envelope on each clip
  (`mioon-clip-linear-attenuation-v1`): the outgoing clip goes from 1 to 0 over
  the overlap and the incoming clip from 0 to 1. The two multipliers sum to 1 at
  every sample; this is a linear, not an equal-power, crossfade.
- The first version never merges curves: a clip that already has a
  `volumeEnvelope` fails with `CROSSFADE_ENVELOPE_EXISTS`; clear it first. Scalar
  `gain` and the fade fields are kept and still multiply the new curves, so a
  fade-out on the outgoing clip deepens its fade.
- Both clips change in one revision with one history entry, so a single undo
  restores both. Other geometry fails with `CROSSFADE_GEOMETRY`, the same clip
  twice with `CROSSFADE_SAME_CLIP`.
- These codes, `CLIP_NOT_FOUND`, revision conflicts and the revision limit carry
  not-applied proofs binding `operation`, `projectId` and `requestId`. The
  volume-envelope workspace and size rejections keep their own proofs.

Exact replay returns the original acknowledgement. It is outside the durable
edit-task ledger.
Mio uses it as the local reversible tool `mioon_timeline_clip_crossfade` in the
`editing` group: both clips are the step's targets, the step records one change,
and undoing that change restores both clips.

### Clip gains (2026-10-29)

`timeline.clip.setGains` takes the common
`{projectId,expectedRevision,requestId}` plus `gains`, a list of 1 to 100
`{clipId,gain}` items, and returns `{operation,requestId,timeline,gains}` with
one `{clipId,previousGain,gain}` change per item, in request order.
- `gain` has the same 0–2 bounds as a clip update. Each clip may be listed once.
- Every listed clip must have sound: images and sources without audio fail with
  `CLIP_GAINS_AUDIO_UNSUPPORTED`. When no listed gain differs from the clip's
  current gain, nothing is written and the call fails with
  `CLIP_GAINS_UNCHANGED`.
- All gains change in one revision with one history entry, so a single undo
  restores every clip. Fades, volume envelopes and every other clip field are
  kept.
- The operation measures nothing. The dialogue loudness match in the delivery
  panel first measures each dialogue clip with `timeline.clip.loudness` against
  the user's target, then applies the gains the user kept.
- These codes, `CLIP_NOT_FOUND`, revision conflicts and the revision limit carry
  not-applied proofs binding `operation`, `projectId` and `requestId`.

Exact replay returns the original acknowledgement. It is outside the durable
edit-task ledger.
Mio uses it as the local reversible tool `mioon_timeline_clip_setGains` in the
`audio` group, after measuring the clips with `timeline.clip.loudness`: every
listed clip is a target of the step, the step records one change, and undoing
that change restores every listed gain.

### Clip transforms (2026-10-29)

`timeline.clip.setTransform` takes the common
`{projectId,expectedRevision,requestId}` plus `clipId` and `transform`, and
returns `{operation,requestId,timeline,clipId,previousTransform,transform}`.
`transform: null` removes the clip's transform.
- A transform is `{profileId:"mioon-clip-transform-v1",keyframes,rotation,crop}`:
  - `keyframes`: 1 to 16 `{frame,x,y,scale}` at strictly increasing clip-local
    frames, at most the clip duration. Values hold before the first and after
    the last keyframe and change linearly between keyframes.
  - `x`, `y`: offset of the content centre from the clip rectangle centre, in
    timeline pixels (at most ±8192); the content may leave the frame.
  - `scale`: 0.05 to 8 times the size the cropped source has after fitting
    the rectangle.
  - `rotation`: static clockwise degrees, −180 to 180.
  - `crop`: static fractions removed from each source edge before fitting,
    each 0 to 0.9, with left+right and top+bottom at most 0.9.
- Only clips on video tracks with a video or image source take a transform
  (`CLIP_TRANSFORM_UNSUPPORTED`). A keyframe past the clip's end fails with
  `CLIP_TRANSFORM_INVALID`, an identical transform with
  `CLIP_TRANSFORM_UNCHANGED`, a timeline that would exceed its saved size with
  `CLIP_TRANSFORM_LIMIT`, and a workspace older than schema 70 with
  `CLIP_TRANSFORM_WORKSPACE_REQUIRED`. These codes, `CLIP_NOT_FOUND`, revision
  conflicts and the revision limit carry not-applied proofs binding
  `operation`, `projectId` and `requestId`.
- One revision and one history entry. Clip updates never carry a transform;
  the transform follows its clip instead: a split keeps each keyframe on its
  side and adds the interpolated value at the cut, start, source and duration
  edits keep clip-local keyframe times, a shorter clip drops keyframes past its
  new end and keeps the interpolated end value, and moves and source
  replacement keep the transform.
- Preview and export render it through the shared renderer. Animated
  transforms need FFmpeg 5 or later; the render first runs a small probe and
  fails with `TIMELINE_TRANSFORM_UNSUPPORTED` on an older tool.

Exact replay returns the original acknowledgement. It is outside the durable
edit-task ledger, and
not a Mio tool in this version. `timeline.inspect` lists each clip's transform
(keyframes, rotation and crop), so Mio reads it.
The model, rendering and editor are described in
[Clip transforms](CLIP-TRANSFORM.md).

### Clip transitions (2026-10-29)

`timeline.clip.setTransition` takes the common
`{projectId,expectedRevision,requestId}` plus `clipId` and `transition`, and
returns `{operation,requestId,timeline,clipId,previousTransition,transition}`.
`clipId` names the incoming clip: the cut is where it starts, and the clip on
the same track that ends there is the outgoing clip. `transition: null`
removes the cut's transition.
- A transition is `{profileId:"mioon-clip-transition-v1",kind,durationFrames}`
  saved as the incoming clip's `transitionIn`:
  - `kind`: `dissolve`, `dipToBlack`, `wipeLeft`, `wipeRight`, `pushLeft`
    or `pushRight`.
  - `durationFrames`: 2 to 60, centred on the cut: ⌊D/2⌋ frames before it
    come from the incoming clip's source before its in point, the rest after it
    from the outgoing clip's source after its out point. Stills repeat.
- A transition fits when both source handles suffice and both clips keep
  room beside the transitions on their other cuts; composition segments,
  counting transition edges, stay at most 200.
- Refusals: a clip that is not on a video track or has an audio source
  (`CLIP_TRANSITION_UNSUPPORTED`), no adjacent outgoing clip
  (`CLIP_TRANSITION_NO_CUT`), too little room (`CLIP_TRANSITION_ROOM`, with
  `details.maxFrames`), an identical transition (`CLIP_TRANSITION_UNCHANGED`),
  a composition or saved timeline over its limit (`CLIP_TRANSITION_LIMIT`) and a
  workspace older than schema 72 (`CLIP_TRANSITION_WORKSPACE_REQUIRED`). These
  codes, `CLIP_TRANSITION_INVALID`, `CLIP_NOT_FOUND`, revision conflicts and the
  revision limit carry not-applied proofs binding `operation`, `projectId` and
  `requestId`.
- One revision and one history entry. Clip updates never carry a transition.
  Any other timeline edit keeps the transitions that still fit and removes the
  ones it leaves without a cut or room, in the same revision; a split never
  adds one at its new inner cut.
- Preview and export render the picture only: the sound keeps a hard cut. The
  render first runs a small FFmpeg probe and fails with
  `TIMELINE_TRANSITION_UNSUPPORTED` on a tool without the filters it needs.
  With managed colour, both images of a transition count towards the two
  visible images at a time (`TIMELINE_IMAGE_COMPOSITOR_BUDGET` in preflight
  and render).

Exact replay returns the original acknowledgement. It is outside the durable
edit-task ledger, and
not a Mio tool in this version. `timeline.inspect` lists each clip's
`transitionIn` (kind and frames), so Mio reads it.
The model, rendering and editor are described in
[Clip transitions](CLIP-TRANSITIONS.md).

## V4 discovery and capability validation

`pnpm exec mioon schema` provides the current JSON Schema catalog; MCP `tools/list` uses the same runtime definitions. Use the shared client rather than duplicating authentication/discovery logic. See [CLI.md](CLI.md) for private token files, downloads and bounded watches.

Each schema definition also contains explicit advisory `effects`: `readOnly`,
`idempotent`, `destructive`, `openWorld`, `databaseWrite`, `fileWrite`,
`externalIO`, `localProcess`, `paidGeneration`, and explanatory `notes`. The
catalog covers every operation; a missing or unknown effect descriptor fails
coverage instead of inferring safety from names such as `.get` or `.list`.
Effects include downstream scheduled/resumed work. `fileWrite` concerns managed
files separately from SQLite writes; `externalIO` concerns provider/external
services, not the authenticated loopback RPC transport. `paidGeneration` means
a new potentially paid generation can be submitted, not that existing remote
work is free. For example, `job.reconcile` has external I/O and may resume media
downloads, while `export.create`/`timeline.render` can later run local FFmpeg.
Metadata and MCP annotations are not authorization, budget approval or automatic
retry permission. Exact stable-request replay behavior is unchanged.

`provider.list` includes `modelCapabilities`, `status` (`available`, `disabled`, `not_configured`), `configuration.missing`, `configuration.requirements`, `liveVerified` and the local generation-count budget. Provider IDs are `mock`, `runway`, `ark`, `veo`, `minimax`, `vidu`. Configuration values and credentials are never returned. Capabilities can change as local count limits are consumed; re-read before new work.

Zero references means text input; one approved image means first-frame input. Each model controls which mode, MIME types, dimensions, aspect ratios, durations and advanced parameters are accepted. Unsupported inputs fail before creating a job. Seed is not accepted for Ark/Veo/MiniMax/Vidu in this version; inspect each model's `parameters` array.

If an actual downloaded live result differs from the requested ratio by more than 1%, the backend retains the existing task and downloaded file privately, sets `phase=output_review_required` with `OUTPUT_ASPECT_RATIO_MISMATCH`, and publishes no version. Its transport-compatible `status=cancelled` means local publication/waiting is paused, not that the provider failed or was cancelled. Do not submit a replacement or use `job.retry`; inspect/reconcile the same existing task.

## Saved source ranges

`asset.range.get({projectId,assetId})` is a non-creating read for an owned video or
audio asset. `asset.range.set({projectId,assetId,expectedRevision,requestId,inFrame,outFrame})`
saves local selection metadata under an independent range revision and an exact
required replay key. These operations do not modify asset bytes, versions or
existing timeline clips. Full timebase, replay and UI boundaries:
[SOURCE-RANGES.md](SOURCE-RANGES.md). Built-in Agent inspection/tool DTOs do not
include these marks in this increment.

## Asset review dispositions

`asset.disposition.list({projectId,assetIds})` returns
`{projectId,items:[{id,assetId,projectId,revision,disposition}]}` in exactly the
requested ID order. Supply 1–100 unique asset UUIDs. The read never creates
metadata or a timeline; an owned asset without saved metadata is `neutral` at
revision `0`. Images, video, audio and unknown-duration assets are supported.
Any missing/foreign asset rejects the entire batch with the same `NOT_FOUND`
error and no partial result.

`asset.disposition.set({projectId,assetId,expectedRevision,requestId,disposition})`
accepts `neutral`, `favorite` or `rejected` and returns the strict single-item
shape above. `expectedRevision` is the disposition's independent revision,
starting at `0`; every new accepted set advances it by one. Resetting to neutral
retains the row and revision. The 8–200-character request key is required and
shares collision protection with `asset.range.set`, the original six local
mutations and the three subject writes: eleven local operations in total. Exact historical replay precedes current revision checks, after
current ownership validation; changed reuse conflicts.

Only disposition metadata and its receipt are written. Asset bytes and existing
asset/shot/project/timeline revisions, source ranges, versions and in-use clips
are unchanged. `rejected` is a review label, not deletion or an automatic clip
edit; legacy asset list and explicit timeline operations keep their semantics.
No inspection DTO or built-in Agent tool/context is expanded. Browser pending
receipts remain session-only, while backend replay receipts survive restart.
See [asset dispositions](ASSET-DISPOSITIONS.md) for the UI and recovery boundary.

## Opt-in source waveforms

`asset.waveform.request({projectId,assetId,retry?})` explicitly requests a bounded
local source-audio analysis. Both IDs are required UUIDs; `retry` defaults to
`false`. Existing queued, running and ready cache work is reused. An interrupted
or failed attempt requires a new explicit request with `retry:true`; neither a
read nor a backend restart starts it again. After a lost request acknowledgement,
call `asset.waveform.get` for the same project/asset first. This is an evictable
derived cache, not a durable mutation receipt or an exact historical replay key.

`asset.waveform.get({projectId,assetId,sourceStartFrame?,sourceEndFrame?,points?})`
is genuinely read-only: it does not probe files, run decoding, initialize or
repair cache rows, update access timestamps, or create a timeline. Missing cache
returns `status:"missing"`. The default start is `0`; the end defaults to the
source end and is exclusive in the 30fps editing timebase. Explicit start is an
integer 0–17999, end is 1–18000 and must exceed start. The selected range must
fit the available source. `points` is an integer 1–2048, default 512.

Both operations return a strict public cache state:
`{projectId,assetId,algorithm,status,binsPerSecond,reason?,attemptId?,duration?,sourceFrames?,decodedSampleFrames?,sourceStartFrame?,sourceEndFrame?,peaks?,clipped?}`.
The algorithm is `peak-u16-48k-100hz-v1`, `binsPerSecond` is 100, and status is
`missing`, `queued`, `running`, `ready`, `interrupted`, `error` or `unsupported`.
A reason is `{code,message}` without decoder diagnostics. Ready get adds the
resolved range and at most the requested number of normalized peaks (0–1 or
`null` for a display bin entirely outside actual decoded coverage).
Ready request may omit peaks/range; all ready responses require `attemptId`,
`duration`, `sourceFrames`, `decodedSampleFrames` and `clipped`. Ready
`duration`/`sourceFrames` use the saved
asset source clock; `decodedSampleFrames` records actual 48kHz coverage (at most
28,800,000 frames), within 100ms of source duration. `sourceFrames` is the
complete 30fps frame count of that duration, with only binary-rounding tolerance.
Bins use their fixed source time positions, with no stretching
and no invented silent tail. A partly covered bin uses its covered maximum. `clipped` reports amplitude clipping; it is
not a timeline clipping operation. No paths, source hashes, URLs, commands or
credentials are accepted or returned. Unknown arguments are rejected. Missing
and foreign assets have the same `NOT_FOUND` error.

Only the first audio stream is used: mono/stereo, decoded as 48kHz float32 and
reduced by absolute maximum into 100Hz bins. Audio/container duration mismatch
greater than 100ms is unsupported; a tiny codec-padding tail remains explicitly
missing. Relative first-audio start offsets exceeding 1/48000 second are
unsupported; matching known nonnegative format/audio start timestamps are
allowed. Unknown timestamps are supported only for untimed WAV with its known
sample-zero origin; negative timestamps are unsupported.
Sources longer than 600 seconds,
larger than 512MiB, or outside supported audio bounds are unsupported for this
feature. Analysis is local, with a 180-second whole-attempt deadline including
bounded hash/probe/decode and a 120-second decoder deadline. Each backend has at
most one active and four queued attempts. Cache identity is project + source
SHA-256 + algorithm, with at most 64 entries / 16MiB; eviction can require an
explicit rebuild. Startup may mark unfinished attempts interrupted, but never
automatically decodes them. Completed cache data survives restart while retained.

Request can run local media subprocesses and write derived SQLite cache data;
it does not write output media files, contact external services, create paid
generation, or edit source assets, saved ranges, versions, timeline gain/mute/
fades, revisions or history. Peaks describe raw source audio before timeline
mixing and are a visual editing aid, not a rendered-output meter. Get advertises
read-only/idempotent effects; request deliberately has `idempotent:false` because
retry and eviction can repeat work. Request also has `destructive:true` because
admission/retry may replace or evict terminal derived-cache entries; source and
business records are unchanged. These advisory effects do not authorize an
action. External HTTP/CLI/MCP discovery does not add waveform tools or media
context to the built-in Agent allowlist.

## Local timeline export preflight

`timeline.export.preflight` accepts `{projectId,expectedRevision}` with optional
strict `exportSettings` for an export-specific frozen snapshot:
`projectId` is a UUID and `expectedRevision` is a positive integer for the
existing timeline. It is a read operation, separate from export submission.
It does not initialize a missing timeline, write SQLite/cache/files, create an
export, fully decode media, call providers, or incur generation charges. It
reads managed source bytes, hashes them incrementally, and runs bounded local
`ffprobe` metadata checks. Supported timeline output is one of the three [closed 30fps preset pairs](TIMELINE-OUTPUT-FORMATS.md).

```json
{"operation":"timeline.export.preflight","input":{"projectId":"11111111-1111-4111-8111-111111111111","expectedRevision":4}}
```

The strict public response contains only:

- `projectId`, the requested `expectedRevision`, ISO `checkedAt`
- `timelineId` (UUID or null), `timelineRevision` (positive integer or null)
- `snapshotHash` (lowercase 64-character SHA-256 or null; includes delivery settings when supplied)
- `status`: `ready`, `blocked`, `incomplete`, or `stale`
- `summary` (null or the bounded counts below; optional frozen `delivery` when requested)
- `checks:{totalAssets,checkedAssets,bytesHashed,fullDecode:false,subtitles?}`;
  nonempty captions add `subtitles:{profileId,fontVerified,inkMeasured:false}` with
  the saved `bottom_cjk_v1` or `bottom_cjk_relative_v2` profile.
  `bytesHashed` counts managed-media bytes, excluding the separately fixed font read.
- `issues`: at most 128 `{code,severity,message,assetId?,clipId?}` entries;
  codes are 1–64 uppercase letters/digits/underscores beginning with a letter,
  severity is `error` or `warning`, and messages are at most 240 characters.
  Optional asset/clip IDs are UUIDs. No source filenames, paths, URLs, raw probe
  diagnostics, commands, credentials, or media bytes are included.

A non-null summary is
`{fps:30,width,height,durationFrames,trackCount,clipCount,assetCount,visualClipCount,audibleClipCount,mutedTrackCount,hiddenVideoTrackCount}`, with width/height bound to one supported timeline preset pair.
Duration is 0–18000 frames, track counts are 0–12, and clip/asset counts are
0–100. Counts of visual/audible clips reflect track visibility/mute and source
capabilities; they do not claim perceptual picture/sound quality. The check is
bounded to 100 assets, 512MiB per source, 1GiB total hashed bytes, 30 seconds,
and 128 reported issues. `checkedAssets` never exceeds `totalAssets` (both
0–100); `bytesHashed` is 0–1GiB. These bounds do not raise timeline limits.
Checks stop at the first blocking or incomplete condition; the issue list is
not an exhaustive audit of every source. Use `checkedAssets` to see completed
coverage. A strict `ready` report has a non-null timeline identity, revision,
digest and summary, matches the requested revision, has checked every summarized
asset, and contains no error issue. Visual/audible counts cannot exceed clips.
Preflight ownership-graph reads have an aggregate safety budget of 4MiB of
saved metadata and 1024 records. Exhaustion reports `incomplete` with
`PREFLIGHT_SNAPSHOT_BUDGET`; the digest stays null until ownership verification
succeeds. This is a security metadata bound, separate from source-byte limits.
The render worker instead validates each distinct clip/source lineage
independently before file I/O, retaining a 4MiB/1024-record safety bound for each
lineage. It has no aggregate whole-composition metadata ceiling: many valid
independent sources can render even when preflight exhausts its aggregate
budget. The per-lineage bound is an additional security limit that also applies
to rendering; only the aggregate preflight and preflight source-byte/time
budgets are preparation limits.

Interpret the status explicitly:

- `ready`: no known blocker was found by the checks completed at `checkedAt`.
  It is not a full decode or a guarantee that the sources will remain available.
- `blocked`: a known export blocker needs attention. A bounded check must not
  disguise a discovered blocker as a successful result.
- `incomplete`: a cap or timeout prevented a complete check. This does not mean
  export failed, and is not an export ban. A user may explicitly choose to try
  export with the limitations understood.
- `stale`: the expected revision no longer matches the current timeline or the
  checked snapshot changed. Refresh and check the intended current state.

A missing timeline is reported without creating one, with null timeline
identity/revision; an unknown project still returns `NOT_FOUND`. Reports are
point-in-time observations, not stored receipts. Repeated reads can differ.
`effects` truthfully advertises `readOnly:true`, `localProcess:true`, no database
or file writes, no external I/O, and no paid generation. MCP's conventional
`idempotentHint:true` for this read does not promise identical report bytes.

The shared Node client (CLI/MCP) gives only this operation a default 35-second
HTTP deadline, allowing grace after the backend's 30-second analysis budget and
best-effort child cleanup. Existing operations keep their 30-second default.
An explicitly configured client/request timeout wins, including an explicit
30 seconds. Node event-loop scheduling and filesystem work are not hard
real-time guarantees. Timeout/disconnect never causes an automatic POST retry.
The client rejects malformed or wrong-project/revision reports with
`BACKEND_PROTOCOL_ERROR`; it does not describe this read as an uncertain mutation.

For a separate, explicitly intended `timeline.render`, callers may supply the
report's non-null `snapshotHash` as `preflightSnapshotHash`, retaining its
`projectId` and `expectedRevision`. The backend verifies that digest against
current frozen content before admitting a new render. Never construct a digest
or silently replace a stale one. The field is optional with no default: omitted
legacy requests retain their exact input shape and response. Retain the complete
render request, including any digest and stable `requestId`, after uncertainty.
Exact render replay is resolved first and returns the original saved response,
even after later edits or source changes. Changing the digest under the same
key is changed reuse and conflicts. Preflight alone never submits an export;
observe an accepted render with `export.get`.

If an `incomplete` report has no digest, a user can separately choose a clearly
labeled, one-use attempt to export the current saved timeline without completed
preflight. Refresh and bind the intended project/current revision, use a fresh
render request key, and omit `preflightSnapshotHash`; never synthesize a checked
binding or label this attempt as checked/ready. The UI exposes this as a
separate explicit action, not an automatic fallback. Known blockers, error
issues and stale reports do not authorize that action. Actual worker ownership
and media validation still apply. This is a new user-approved intent, never a
way to modify an uncertain render request: exact replay must retain its
original digest or omission.

This additive external HTTP/CLI/MCP capability does not expand built-in Agent
model tools, inspection DTOs, media context, or approval scope. Offline transport
acceptance: `node --test tests/timeline-preflight-transports.test.mjs`.

### Timeline recovery acknowledgement boundary

All eleven keyed timeline writes (track/clip edits, seed, undo, redo and render)
validate complete operation-bound acknowledgements. A later 4xx, malformed success,
corrupt receipt or ownership failure leaves the original outcome unknown. Only a
matching request-bound `mutationOutcome:"not_applied"` proof from a fresh,
pre-write business rejection after rollback establishes non-application. Exact
historical replay checks current ownership before returning unchanged stored data;
it does not require the historical clip to remain present or a newer revision to
match. Request schemas, response shapes, history and journal namespaces are unchanged.

Pending timeline renders require explicit exact replay. Even a well-shaped
progressed public export cannot prove current receipt/source ownership; public
snapshots also omit private paths included in preflight digests. Project refresh
therefore never automatically clears an unknown render receipt. Reference errors conservatively retain uncertainty;
reference recovery now also validates operation-bound acknowledgements and retained ownership; see [REFERENCE-RECOVERY.md](REFERENCE-RECOVERY.md). See
[TIMELINE-RECOVERY.md](TIMELINE-RECOVERY.md) for scope and session-storage limits.

### Durable UI edit tasks (twenty explicit operations)

The authenticated `/api/tasks` route family has an explicit twenty-operation
allowlist: fifteen timeline metadata edits (all timeline mutations except
`timeline.render`), `reference.attach` / `reference.detach`, and the three subject
writes listed below. The sixteenth entry is `timeline.format.set`, with project and timeline revision gates; three `timeline.subtitle.*` writes append to the same timeline lane. The twentieth entry is `timeline.loudness.apply`, which remeasures a bound fixed-gain candidate and atomically writes the audible clip group; see [the apply contract](TIMELINE-LOUDNESS-APPLY.md). The subject extension is implemented; focused checks, builds
and Linux native acceptance passed, with the independent full release gate passed.
See [its current gate](SUBJECT-LIBRARY.md). It is a UI recovery control plane, not
an additional generic RPC, MCP tool or Agent capability. The underlying shared
business handlers, request schemas and exact response journals remain unchanged.
See [TASK-RECOVERY.md](TASK-RECOVERY.md) for implementation/acceptance status.

- `POST /api/tasks/prepare`: `{projectId,operation,input,origin}` where origin is
  `new` or explicitly adopted `legacy_session`. Preserve input's exact original
  request ID. Returns `{task,instanceId}` after durable preparation, without
  executing the edit.
- `GET /api/tasks?projectId=...&pendingOnly=true&limit=20&cursor=...`: bounded,
  noncreating `{items,nextCursor,instanceId}`. `pendingOnly=false` includes
  acknowledged retained identities. Limit is 1–50; cursors bind project/filter.
- `GET /api/tasks/:taskId?projectId=...`: noncreating task lookup.
- `POST /api/tasks/:taskId/execute`: `{projectId,digest,instanceId}`. Explicitly
  execute or recover only the immutable stored intent. A stale backend lifetime
  nonce is rejected; no endpoint automatically retries the request.
- `POST /api/tasks/:taskId/reconcile`: `{projectId,digest}`. Read the original
  business receipt and update coordination state only; never dispatch an edit.
- `POST /api/tasks/:taskId/acknowledge`: `{projectId,digest,expectedRevision,status}`
  with terminal status `applied` or `not_applied`. Acknowledgement hides a finished
  card, not its immutable identity or business receipt.

Action replies are `{task,instanceId,result?}`. A result is the original validated
business response, not a current project snapshot. Task identity, project,
operation, input, digest, backend instance and monotonic revision must be checked
before clearing uncertainty. A malformed 200 or generic 4xx does not establish
non-application. Re-read a lost acknowledgement; never substitute another key.

Preparation accepts at most 8 KiB exact input; HTTP preparation envelopes are
capped at 12 KiB, other action bodies at 1 KiB and request URLs at 2 KiB. Task
storage reserves 16 KiB per identity, up to 4,096 identities / 64 MiB logically.
Capacity refusal occurs before business dispatch and is distinct from disk full.
No silent eviction is implemented; this is not a bound on SQLite/WAL disk size.
GET/list cannot initialize timelines, execute recovery or clear pending state.

The original eight local canvas/asset edits, rendering and generation retain their
existing UI recovery/storage paths. The subject writes use the separate `subject:mutation` lane; format and subtitle edits use `timeline:mutation`. External callers still use
their existing operation and original key directly; this route family does not upgrade their request
persistence automatically. No task input contains credentials or media bytes;
local task parameters are ordinary SQLite data, not vault-encrypted.

## Local versioned subject library

Status: implemented; focused checks, final web/desktop builds and Linux native
acceptance passed. The independent full-suite release gate passed.
These strict shared contracts are specified in
[SUBJECT-LIBRARY.md](SUBJECT-LIBRARY.md) and
`packages/contracts/src/subjects.mjs`. They add local planning metadata only.

| Operation | Strict RPC input |
| --- | --- |
| `subject.create` | `{projectId,kind,name,assetId,requestId}` |
| `subject.version.add` | `{projectId,subjectId,expectedRevision,assetId,requestId}` |
| `subject.binding.set` | `{projectId,shotId,subjectId,role,subjectVersionId,expectedRevision,expectedSubjectRevision,requestId}` |
| `subject.list` | `{projectId,limit?,cursor?}` |
| `subject.version.list` | `{projectId,subjectId,limit?,cursor?}` |
| `subject.binding.list` | `{projectId,shotId?,subjectId?,limit?,cursor?}` with exactly one filter |

Record IDs are UUIDs. `kind` is `character|product|location|look`; name is
nonblank, 1–120 characters. Every version fixes one existing owned managed
PNG/JPEG/WebP asset, without imports, byte copies or caller-supplied provenance.
All three writes require an 8–200-character stable `requestId`. Version-add
checks the positive subject revision; same-head asset rejects without a write.
Binding-set checks its independent revision (0 only if never created) plus the
positive current `expectedSubjectRevision`. `role` is `style` for `look`,
`subject` for other kinds. At most eight active bindings are allowed per shot.

`subjectVersionId` is required and nullable: a UUID pins that exact owned subject
version, and `null` clears while retaining a revisioned tombstone. Every fresh
set saves the current head as `reviewedHeadVersionId`. `needsReview` is derived
from active selection plus a changed head, not selected-version inequality.
Explicitly adopting latest or keeping the old selected version while acknowledging
the latest head both clear that review flag; no choice propagates automatically.

Create/version-add return a subject with
`id,projectId,kind,name,revision,headVersionId,headVersion,createdAt,updatedAt`.
The frozen `headVersion` (also a version-list item) contains
`id,projectId,subjectId,number,assetId,sha256,mimeType,width,height,provenance,createdAt`.
Backend-derived `provenance` has `kind` and nullable local
`versionId,shotId,jobId`, never provider task IDs, paths or URLs. The frozen
`sha256` comes from the existing asset record; subject operations do not read,
rehash or probe media bytes.
Binding-set/list return
`id,projectId,shotId,subjectId,role,revision,subjectVersionId,reviewedHeadVersionId,headVersionId,subjectRevision,needsReview,createdAt,updatedAt`.
Lists return `{projectId,items,nextCursor}`; page size defaults to 20, maximum 50,
cursor maximum 768 characters. Binding-list includes cleared rows. Cursors bind
operation/project/filter/limit and expire after backend restart. Pages are not
a cross-request frozen snapshot. All lists are non-creating metadata reads.

Subject receipts atomically join the existing eight-operation local mutation key
namespace as operations nine through eleven; timeline/reference/generation/export
namespaces remain separate. Exact replay returns the original validated response
before new revision checks, after current ownership checks. Keep full input/key
after uncertain or malformed replies and refresh current state after replay.
Only matching operation/project/request `not_applied` rollback proof resolves a
fresh rejected intent; no generic 4xx or automatic retry does. Subject input and
receipt caps are 8 KiB and 16 KiB respectively.

The three writes also enter the UI's explicit durable allowlist under
`subject:mutation`, with prepare-before-dispatch and restart discovery but no
automatic execution. Task limits remain 8 KiB input, 16 KiB reserved per row,
4,096 identities and 64 MiB logical total; capacity refuses before dispatch and
no unresolved identity is silently evicted. Schema 15 adds subject tables and
transactionally rebuilds `edit_tasks` while preserving old bytes/sequence/guards;
eight independent schema-preservation cases, focused checks, final builds and
Linux native acceptance passed. The independent full release gate passed.
Local SQLite metadata is not
vault-encrypted and must contain no secrets.

No shot revision, first-frame reference, timeline, frozen generation snapshot,
provider input, built-in Agent catalog/context or paid generation changes.
`reference.attach` remains the separate actual `first_frame` path. The later
[saved first/last frames](VIDEO-FRAME-PAIRS.md) and
[explicit subject-version input](SUBJECT-VIDEO-INPUTS.md) are separate generation
choices; they do not automatically consume planning bindings. Motion remains
future work. See [subject scope and recovery](SUBJECT-LIBRARY.md).

### Angle and lighting variants (schema 62)

Status: backend implemented (C7a); the subject inspector and the angle and
lighting dialogs are not built yet. Contracts:
`packages/contracts/src/subject-variants.ts`.

| Operation | Strict RPC input |
| --- | --- |
| `subject.variants.create` | `{projectId,subjectId,sourceVersionId,kind,items,providerId,model,requestId}` |
| `subject.variants.retry` | `{projectId,batchId,position,expectedRevision,requestId}` |
| `subject.variants.undo` | `{projectId,batchId,expectedRevision,requestId}` |
| `subject.variants.get` | `{projectId,batchId}` |
| `subject.variants.list` | `{projectId,subjectId,limit?,cursor?}` |

A batch edits one version of a `character` or `product` subject into up to
eight new versions. `kind` is `angle` or `light` and every item must match it.
An angle item is `{kind:"angle",position,focal}` with `position` one of
`front,front-left,left,back-left,back,back-right,right,front-right,high,low`
and `focal` `standard|wide`; items must be distinct. A lighting batch has one
item `{kind:"light",azimuth,elevation,quality,kelvin}`: integer azimuth
−180–180 (0 faces the camera, positive to the subject's right), elevation
−90–90, `quality` `soft|hard|back`, and 2000–10000 K in steps of 100.
`providerId`/`model` must be an edit-capable pair (`mock` or `openai`).

`create` records the batch and returns it with each item's exact
`image.generate` edit input: the source version as `inputImage`, a server-built
prompt and name, and `options.size` from the model's edit profile (see
[IMAGE-EDITING.md](IMAGE-EDITING.md)). It submits nothing and charges nothing.
The caller submits each item's input as given; official items go through the
usual `image.review.prepare` and in-app approval. Each item's image request ID
is `subject-variant:<batchId>:<position>:<attempt>`. Sources must pass the
model's edit profile and come from an import, an image result or a captured
frame; otherwise create fails with `SUBJECT_VARIANT_SOURCE_UNSUPPORTED` and
`details.reason` `origin|format|bytes|dimensions`. A batch that would not fit
the project's eight-task image queue fails with `SUBJECT_VARIANT_QUEUE_FULL`.

When an item's image is published, the same transaction adds a subject version
with `variant:{...spec,batchId,sourceVersionId}`. The subject `revision`
advances but `headVersionId` does not move, so shot bindings are not flagged
for review; the head is always the newest version without a variant. On start,
a finished image that was not yet linked is linked from its task receipt.

`get` returns the batch with each item's `status`
(`pending|running|succeeded|failed|cancelled|interrupted|unknown|recoverable|undone`),
image task state and `undo:{available,blockers}`; `list` pages batches newest
first with `undo:null`. `retry` gives one item a new request ID only after its
image failed or was cancelled before dispatch (`SUBJECT_VARIANT_RETRY_UNAVAILABLE`
otherwise); an unknown outcome is never retried. `undo` hides every version of
the batch: they leave `subject.version.list` and project packages, and binding
one, generating video from one or using one as a batch source fails with
`SUBJECT_VERSION_HIDDEN`. Versions, images and receipts are retained. Undo is refused with
`SUBJECT_VARIANT_UNDO_BLOCKED` and `details.blockers`, in this order:
`IN_PROGRESS`, `UNKNOWN`, `BOUND` (with `shotId`), `GENERATED`, `SOURCE` (with
the derived `batchId`).

The three writes require a stable `requestId` and replay their original
acknowledgement exactly; `retry` and `undo` check the batch `revision`. A
refusal carries `details.subjectVariantOutcome` with a `not_accepted` proof
only when a fresh transaction finds no receipt for that key. These
operations are not built-in Mio tools.

### Camera previs (schema 64)

Status: implemented, with the canvas node, the 3D editor, keyframes and
keyframe export. The scene format and all rules are in [PREVIS.md](PREVIS.md).

| Operation | Strict RPC input |
| --- | --- |
| `previs.create` | `{projectId,label?,position,requestId}` |
| `previs.scene.set` | `{projectId,nodeId,expectedSceneRevision,scene,requestId}` |
| `previs.thumbnail.set` | `{projectId,nodeId,slot,sceneRevision,framePresetId?,dataBase64}` |
| `previs.thumbnail.get` | `{projectId,nodeId,slots,framePresetId?}` |

A previs node is a canvas node of type `previs` whose record carries a bounded
scene and a `sceneRevision`. `create` adds the default scene; `scene.set`
replaces the whole scene under `expectedSceneRevision` and keeps the node's
label and position. `node.update` changes only a previs node's label and
position. Both writes require a stable `requestId`; only the newest four scene
saves of a node keep receipts, and an older retry fails the revision check
instead of applying again. Thumbnails are a bounded JPEG cache per card or
keyframe, outside receipts and packages. Public thumbnail requests can bind
`framePresetId` to the project's current output preset. Format 4 writes
require this evidence in addition to the current scene revision. The editor
publishes keyframe PNGs with `previs.output.publish` and records the asset ID
in the scene's `exports`. It checks the published image's dimensions against
the shot's ratio before setting a first or last frame with `shot.update`.


## Timeline output frame

`timeline.format.get` returns the effective preset, project and timeline
revisions, and eligibility without creating a timeline. `timeline.format.set`
requires `projectId`, `expectedProjectRevision`, `expectedRevision` (0 means
there is no timeline), a stable `requestId`, and `presetId`. The acknowledgement
is the complete saved timeline. An exact replay returns the original timeline
before evaluating either current revision.

On a project opened by a trusted host in format 4, the setter changes the
ratio within the current 720 or 1080 short-edge tier at 30 fps. The supported
ratios are 9:16, 16:9, 1:1, 4:3, 3:4 and 21:9. The public operation schema
enumerates the preset IDs for both tiers. A different tier or another pending
timeline edit rejects before writing. The transaction adds one undo step and
retains the existing clip and subtitle geometry on its original basis. A new
edit after undo replaces the redo branch. Earlier acknowledgements remain
replayable, and already accepted exports keep their frozen frame.

A migrated clip's stored `rect` uses basis pixels. `timeline.inspect` reports
its projection in the current frame for observation. Direct `rect` updates
to migrated clips return `CLIP_LAYOUT_RECT_READ_ONLY`. Use
`timeline.clip.setTransform` with the clip's stored basis units.

The default format-3 host and built-in Mio tools keep the original
pristine-timeline rules. Storyboard output remains 9:16. After an ambiguous
response, retain the exact input and request ID for recovery. See the
[format-3 recovery rules](TIMELINE-OUTPUT-FORMATS.md).

## Manual timeline subtitles

Three shared, strict writes use the existing timeline journal and CAS:
- `timeline.subtitle.add`: `{projectId,expectedRevision,requestId,text,startFrame,durationFrames}`.
- `timeline.subtitle.update`: `{projectId,expectedRevision,requestId,cueId,patch}`; the nonempty patch contains only text/startFrame/durationFrames.
- `timeline.subtitle.remove`: `{projectId,expectedRevision,requestId,cueId}`.

CLI discovery/commands are `timeline subtitle add|update|remove`; MCP names are
`timeline_subtitle_add`, `timeline_subtitle_update`, `timeline_subtitle_remove`.
Use live schema discovery, retain exact input/key on unknown outcomes, and never
automatically retry under a new key. Each successful write returns the complete
saved timeline. IDs and the layout profile are backend-owned. New subtitle
tracks start with `bottom_cjk_v1`. Edits keep the existing profile, including
`bottom_cjk_relative_v2` after a frame change.
Full subtitle state is available through `timeline.get` or `project.get`;
`timeline.inspect` deliberately omits subtitle cues from its bounded DTO. No new
built-in Agent tool or automatic project-context category is added.

Intervals use integer 30 fps frames with exclusive ends, within existing media
duration. Cues cannot overlap (adjacency is legal); maximum100 cues,1–2 lines,
20 Unicode scalars per line,161 UTF-8 bytes. Only printable ASCII, the pinned
font's supported Han U+4E00–9FEF and an explicit Chinese punctuation set are
accepted. Unsupported characters identify line/column and code point. Literal
text is preserved; there is no ASR, SRT import, automatic wrapping or style menu.

The fixed font/profile burns into timeline rendered preview/export, not dry
source playback or the legacy storyboard export. Saving media edits that strand
existing cues fails atomically; shorten/remove cues explicitly first. History and
recovery preserve optional field absence and original receipt bytes. Frozen
exports retain their accepted subtitle text/font hash. Preflight can verify the
font resource but does not measure glyph ink; actual render performs bounded
measurement and can reject overflow. See [scope and acceptance](MANUAL-SUBTITLES.md).

## Timeline delivery profile and local encoder capability

Optional export-only `timeline.render.exportSettings` and optional
`timeline.export.preflight.exportSettings` use a closed profile union: unchanged
`mp4_h264_v1`, or explicitly selected `mp4_h264_float_checked_v2`.
`timeline.export.capabilities` accepts exactly
`{projectId,expectedRevision,exportSettings}` and performs an explicit bounded
local synthetic encode. It creates no timeline/export and writes no DB/cache.
V1 retains its in-memory proof; v2 creates and cleans fixed private synthetic
MOV/concat/AAC proof files, so advisory `fileWrite` is true. Its read-only business
semantics and localProcess effect remain distinct from source preflight.
Read [EXPORT-SETTINGS.md](EXPORT-SETTINGS.md) for all settings, caps, safe report
statuses, exact frozen delivery fields, cancellation and replay semantics.
Omitted settings preserve legacy requests/receipts; preview rejects settings.

## Saved first/last-frame video selection

See [VIDEO-FRAME-PAIRS.md](VIDEO-FRAME-PAIRS.md) for implementation/acceptance status and exact provider scope.
`shot.create` and `shot.update.patch` accept optional `lastFrameAssetId: UUID | null`.
An omitted property keeps legacy shape (and means no change in an update); `null`
explicitly clears it. Non-null values must identify a same-project managed image.
The existing `referenceAssetIds` array and `reference.attach` / `reference.detach`
remain first-frame-only. Detaching a first frame does not erase the saved tail.
Saving a tail-only draft is allowed, but generation requires one distinct first
image. Only current Ark Seedance 2.5 and Mock profiles accept this paired mode;
subject/style bindings are not sent. Other adapters reject the complete unsupported
selection rather than dropping the tail. For this saved-frame mode, shot revision
pins the saved choices; each accepted job freezes both
roles, identities, hashes and metadata. Old job retry uses only its old snapshot.

Use the existing stable shot mutation request key and `expectedRevision`. Exact
replay returns its original shot response. No new operation, migration, edit-task
namespace or built-in Agent write privilege is added. Manual shot-edit pending
receipt recovery remains session-scoped; this does not add a cross-restart pending
edit ledger or undo/history for shot fields. Successful saved choices persist.

## Explicit one-version subject-image video input

`generation.submit` additionally accepts optional `subjectVersionId: UUID` for
one immutable same-project `character`, `product` or `location` image version.
It is a per-submit choice, not a shot patch. Omission preserves the legacy path;
null, arrays and caller-supplied asset/hash metadata reject. Planning subject/style
bindings never automatically enter the request. Any saved first/last image or
first-frame connection conflicts; clearing it requires a separate explicit save.

Only current Ark Seedance 2.5 and Mock v3 profiles support this role. The server
freezes complete `snapshot.subjectReference` plus the exact one-image manifest.
Same-key changed version conflicts; failed-job retry keeps its old version, even
after head advances. Malformed acknowledgements do not settle new subject pending
requests. The renderer's full reviewed pin is session storage, not a new durable
intent ledger. No operation, migration or Agent authority is added. See
[SUBJECT-VIDEO-INPUTS.md](SUBJECT-VIDEO-INPUTS.md) for implementation status, exact
wire mapping, real-face restrictions, immutable provenance and acceptance.

## Named timeline deliveries

`timeline.render` with `purpose:'export'` and `timeline.export.preflight` accept optional `deliveryName`: exact nonblank1–120 UTF-16 units, valid Unicode without control/line characters. Omission remains absent in historical requests and receipts. The preflight digest and original render key bind the name together with the frozen timeline/settings; changed or removed names cannot reuse that key. The encoding-capability request does not accept a name. `export.get` returns the immutable `snapshot.deliveryName` when supplied.

Named download links bind `/api/projects/{projectId}/media/{assetId}?download=1&exportId={exportId}`. The authenticated server validates the project ownership and historical export/output/receipt and derives a safe attachment filename; callers cannot supply a destination path or trusted filename. Historical stored URLs retain their bytes; P4 downloads rebuild the project address and the legacy public path returns 404. Existing unnamed/storyboard behavior remains. See [scope, safety and acceptance](NAMED-DELIVERIES.md).

### 私有镜头文字草稿与保存恢复

右侧镜头表单使用 authenticated `/api/projects/<项目ID>/local-shot-text` 私有接口保存 title/prompt 草稿及原 `shot.update` 精确意图；不是公共 RPC/CLI/MCP/Agent 操作。GET 必须携带 projectId 与 shotId，只读且不创建记录；草稿与意图使用独立 CAS、本机记录范围和实例身份。公开 shot.update 输入与响应仍兼容。文字请求的 prepare/execute/recover、容量/隐私合同见 [SHOT-TEXT-DRAFTS.md](SHOT-TEXT-DRAFTS.md)。读取或恢复表单不自动执行业务。

三类私有草稿都写本项目 history 的草稿领域表。外部路径统一以 `/api/projects/<项目ID>` 为前缀：clip 使用 `/local-drafts`、`/local-drafts/clip`；delivery 使用 `/local-delivery` 及其 `/draft`、`/prepare`、`/execute`、`/recover` 子路径；shot-text 同理。现有字段、CAS、限额、回执校验和错误族保持；旧 `/api/local-…` 未寻址地址仍返回404。三个旧 JSON 不导入、不读写、不自动清理，详见 [PROJECT-FILE.md](PROJECT-FILE.md)。

宿主关闭先停止草稿接纳，再等待完整 execute/recover（含终态持久化和 finally）结束，最后才可关闭连接。客户端断开响应不能证明后端已结束；持久 pending 不自动执行，也不单独阻止关闭。SQLite COMMIT 后丢失 ACK 仍是不确定结果，须重新读取或按原 intent 显式 recover。0.1.0 Windows 的 delivery/shot-text 变更端点在任何 SQL 效果前返回503 `*_STORAGE_UNAVAILABLE`；clip 维持原不可用状态。


## Selected-range timeline exports

`timeline.render` (only `purpose:'export'`) and `timeline.export.preflight` accept optional strict `exportRange:{startFrame,endFrame}`. Both fields are integer composition frames at30fps, `0 <= startFrame < endFrame <=18000`; fresh acceptance also requires end no later than the saved duration. End is exclusive. Omission preserves the old full-export snapshot/ACK bytes, while explicit full-span is a different request. A preview cannot accept range. `timeline.export.capabilities` remains range-free.

The complete original snapshot remains frozen; only optional `snapshot.exportRange` identifies the output interval. Preflight `summary.durationFrames` and counts still describe the full saved timeline; optional `summary.exportRange` gives the selected interval. All referenced sources are checked. The digest, original request key, strict ACK and existing local-delivery exact intent bind the identical range. Changed/removed range conflicts under that key. Fresh `EXPORT_RANGE_BOUNDS` is a request-bound not-applied rejection only after the existing pre-write rollback proof; stale or unknown receipts never become a fresh retry automatically.

No new operation or schema migration. Historical exact replay precedes current revision/range-length checks and does not requeue an old export. See [selected-range behavior and acceptance](SELECTED-RANGE-EXPORT.md).


## 已导出文件解码样本峰值

`timeline.export.samplePeak` accepts exactly `{projectId,exportId}` for one owned succeeded timeline export. It explicitly reads, hashes and decodes the existing delivered MP4; it does not render, create a task/report/cache, edit state or call providers. It is read-only and resource-intensive (`localProcess:true`), with cancellation scoped only to the check. It is absent from the built-in Agent tool catalog.

The strict report binds original export/output/hash/revision and optional frozen name/range. `ready` includes finite stereo sample peaks, full decoded duration/count and both hash passes; `unsupported`, `incomplete` and `stale` contain no measurement. A value at or below 0 dBFS does not establish no earlier clipping, true peak or loudness compliance. Explicit user recheck is allowed; no automatic retry or exact-receipt promise applies. See [scope, budgets and acceptance](EXPORT-SAMPLE-PEAK.md).

## Opt-in float intermediate and pre-encode sample gate

`mp4_h264_float_checked_v2` retains the existing strict resolution/rateControl
choices but uses float32 MOV intermediate audio. It measures the complete exact
pre-encode stream; a sample peak strictly above one fails with
`EXPORT_AUDIO_OVER_RANGE`, a same-attempt `audioCheck`, and no published asset.
There is no limiter, normalization, implicit gain change or silent fallback.
A passing pre-encode check is not an AAC-decoded, true-peak or loudness guarantee.
The existing final-file `timeline.export.samplePeak` is separate.

New v2 current export rows carry a server-created `renderAttemptId` after claim.
Only terminal outcomes may include a bounded `audioCheck`; successful reports
bind the output asset/hash. None of these fields are accepted as operation input,
frozen snapshot metadata or immutable queued-ACK additions. Same-key exact replay
remains the original queued response, including after a failed worker attempt.
Cancellation/restart remeasure under a fresh attempt; stale callbacks cannot
attach old evidence.

This increment is backend/HTTP/CLI/MCP opt-in only. It does not add a UI selector
or change existing UI defaults. See [FLOAT-CHECKED-EXPORT.md](FLOAT-CHECKED-EXPORT.md)
for report identity, caps, temporary-file ownership and acceptance status.

## Saved timeline sound audition

`timeline.audioPreview.plan` accepts exactly `{projectId,timelineId,expectedRevision,startFrame}`. It reads an existing saved timeline without creating one, returns its strict revision/hash-bound plan for `[startFrame,min(startFrame+600,durationFrames))` at 30fps, and does not read media payloads or launch a decoder. CLI discovery is `timeline audioPreview plan`; MCP discovery is `timeline_audioPreview_plan`. No built-in Agent tool is added.

An explicit browser preparation consumes fixed authenticated `GET /api/timeline-audio-preview/pcm` resources with those four fields plus `clipId`, `sourceHash`, and `planHash`. The resource accepts no path, URL, codec, stream index or filter. It validates owned managed sources, both source hashes and current saved identity, then decodes the fixed probed audio stream to exact 48kHz stereo f32le. This resource-intensive local read has one active decoder and no queue; cancellation retains ownership until child and response cleanup are confirmed. Partial data is never playable. No task, cache file, media asset or database state is created.

Preparation is bounded to 20 seconds, a 120-second total browser budget and a conservative 96MiB application-buffer admission, including source staging/acquisition/transport allowances. This is not total browser/native-process RSS. Unknown audio metadata, unsupported streams and over-budget windows fail explicitly. Playback is sound-only from saved data; unsaved edits remain excluded. Float summation may differ from the legacy s16 export's clipping. Neither audition nor a passing sample-peak check establishes true-peak/LUFS compliance. See [exact limits and verification](TIMELINE-AUDIO-PREVIEW.md).


## Complete exported-file loudness observation

`timeline.export.loudness` is a separate explicit bounded local read. It requires `{projectId,exportId,expectedArtifactSha256,measurementProfile:"bs1770-5-48k-stereo-fir4x-v1"}` and optionally the user's custom `{target:{integratedLufs,truePeakCeilingDbtp}}`. It accepts no path/requestId/permission flag. It completely decodes the owned succeeded delivery file, validates its actual hash twice, and returns integrated LUFS, decoded sample peak and estimated true peak bound to the frozen artifact/profile/target. Selected-range files remain selected-range observations. Silence, under-400ms, below-gate, no-audio and incomplete decode are distinct; no unqualified finite LUFS or gain advice is invented. Target is never defaulted. Advice is arithmetic only, with explicit peak-room conflicts, and never edits, limits, normalizes or authorizes application to today's timeline. Single exported-audio observation permit is shared with samplePeak; no cache/task/file write/provider call. See [full limits, standard sources and phase boundary](EXPORT-LOUDNESS.md).

## Saved-timeline full-mix loudness preparation

`timeline.loudness.prepare` is an explicit resource-intensive, read-only observation of the complete saved timeline before encoding. Supply exactly the project ID, saved `expectedRevision`, `mixProfile:"timeline-float-mix-v1"`, `measurementProfile:"bs1770-5-48k-stereo-fir4x-v1"` and the user's explicit `target:{integratedLufs,truePeakCeilingDbtp}`. Both profiles and both target numbers are required; there is no platform target, request ID, path, URL, caller hash, range or permission flag.

A ready report binds the request, saved revision, timeline/snapshot identity and sorted twice-hashed audible sources. `original` measures the complete pre-encode float mix. A representable candidate applies one fixed multiplier to every audible clip gain without clamping and completes another full measurement; `candidate.measurement`, `meetsTarget` and `meetsTruePeak` describe that actual second pass. Silence, too-short/below-gate measurements and gains outside `(0,2]` do not invent a usable candidate. `applyAllowed` is always false at both report and candidate levels, even when both comparisons pass. This observation cannot edit the timeline, authorize an Agent proposal, render, limit, upload or promise AAC/final-file loudness safety.

The shared client uses125s transport grace over the server's120s work budget; explicit caller timeouts remain respected. The response is stream-bounded to64KiB before JSON parsing and validated against the exact request. Disconnect, CLI Ctrl+C and MCP cancellation retire only this observation's owned local work. Busy/stale/cancelled/unsupported/over-budget failures do not return partial measurements or authorize retries. No queue, report persistence, cache/database/file writes, network, model or paid operation is added. The internal Agent still exposes only its four existing metadata tools.

## Atomic fixed-gain application

`timeline.loudness.apply` is a separate explicit durable mutation. Its strict scalar input adds the caller-owned `requestId`, exact `snapshotSha256`, and versioned `candidateDigest` to the prepare request. No gains, paths, report payload, or approval flag is accepted. Shared `timelineLoudnessCandidateDigest` hashes the complete validated report except its wall clock; the server independently remeasures both complete mixes and both source hashes before one atomic gain/history/receipt commit. Read-only reports keep `applyAllowed:false`.

Exact retained ACK replay precedes media or current-revision admission, including after undo/restart. Disconnect is unknown, never cancellation or permission to use a new key. The UI uses the existing durable task API. Original exports stay v1 unless the user explicitly chooses `mp4_h264_float_checked_v2`; successful application does not certify the encoded file. See [full contract, migration and verification boundary](TIMELINE-LOUDNESS-APPLY.md).

## Project-owned LUT resources (candidate foundation)

`lut.import`, `lut.list` and `lut.inspect` share the typed resource service. Import accepts `{projectId, requestId, name, dataBase64}` with a7MiB exact-byte cap and stable-request replay; list and inspect return metadata/hash only. This is not grading or applied LUT support. Project-owned storage and quotas are documented in [LUT resource foundation](LUT-RESOURCES.md).

## 素材引用接口

`asset.import` 是严格互斥的路径/上传输入。路径分支必须有requestId；上传仍接受原字段和30 MiB上限，可选requestId。同一key同一规范化输入精确重放，不同内容冲突。普通RPC永远不因输入中的路径或来源标记授予目录许可。

独立资产接口：`asset.media.status.list` 返回有界items/nextCursor；`asset.media.prepare` 在事务外算完整哈希并按referenceRevision核对后返回assets；`asset.media.relink.preview/apply` 预览并重指向同内容；`asset.media.acceptChanged` 创建新素材身份，保留旧历史。

敏感操作通过已认证且通过Origin检查的 `POST /api/projects/<ID>/asset-media/trusted`，请求 `{operation,input}`。`asset.import.path` 仅由桌面真实文件选择/拖入和CLI显式目录确认调用，返回asset和confirmedDirectories；`asset.media.location.list`、outside.confirm/revoke不进入MCP或Mio的普通操作目录。用户动作header仅表达意图，不能替代认证、窗口/项目所有权或目录能力检查。

公共目录由 `@mioon/contracts/public-operations` 的 publicOperationSchemas/publicOperationDescriptions 统一提供，客户端直接导出同一对象。HTTP/CLI/MCP使用上述路径/上传导入和可选referenceRevisions；Mio的固定模型目录保留原上传输入和原generation.submit输入，不接受路径或网页确认版本字段。模型冻结schema可用 `node scripts/generate-agent-task-schemas.ts --check` 只读核对。

普通Asset DTO不含reference或relativePath；sha256仅表示完整哈希，可以为null，fingerprint中的sampledSha256不能替代它。状态和位置是本机观测，分别获取，媒体URL存在不代表素材当前在线。付费网页确认绑定有序referenceRevisions（assetId、referenceRevision、完整sha256），派发前仍须完整复核字节。

## S2 项目产物和预演发布

生成、抽帧、拆解及预演 PNG 写固定 `生成/`，成片写固定 `导出/`，上传素材写 `素材/`。目录不随界面语言变化；后端排他创建，失败、取消和本地恢复均不自动删除项目文件。普通资产响应仍不返回内部 publication 或引用路径。详细的中断、跨机来源和命名规则见 [PROJECT-OUTPUTS.md](PROJECT-OUTPUTS.md)。

公共项目 RPC 新增 `previs.output.publish` 与只读 `previs.output.lookup`，HTTP、CLI 和 MCP 使用同一公共目录，内置 Mio 模型目录不增加这两个工具。身份字段为 `{projectId,nodeId,keyframeId,sceneRevision,requestId,name,sha256,width,height}`，publish 另需 `dataBase64`；仅接受有界完整 PNG。新发布必须指向项目中已保存的当前节点、关键帧和修订。响应为完整身份加无路径 `asset` DTO；lookup 未登记返回 `null`。未知 ACK 只按原完整身份查询，不凭同 SHA 认领其他请求，不自动换 requestId 重发。已登记结果可在原节点后来删除后精确查询和重放。

`export.output.get` 的专用原生描述增加 `publication`：绑定项目、export owner、assetId、完整哈希、大小及固定目录的 `projectRelativePath`。真实项目必须提供它；桌面 POSIX/Windows 先验来源再以真实句柄核验字节，成功后才能打开或显示文件。普通资产接口的递归路径过滤不变；同字节但不同 export、外部重新指向和缺证明均不能通过成片核验。
