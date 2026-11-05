# 项目宿主
日期：2026-10-31 起草，2026-11-02 补充 P4 实现状态，2026-11-03 补充 V2 自动备份与 V1-B 版本恢复及自动保存，2026-11-04 补充 S5-A/B。当前代码已切换到真实项目内核；本轮整体验收和发布状态以 PR 为准。

项目文件 v1 以后，后端同时开着多个项目：每个打开的项目有一个“项目宿主”，里面是这个项目的 store、服务、后台任务循环和 Mio 运行时；应用级的“宿主管理器”负责列出、新建、打开、关闭项目，按 URL 里的项目 ID 把请求交给对应的宿主。

## 0. P4 当前运行状态

### V5 恢复会话

manager 在 factory、`ensureProjectRow`、业务服务/Mio 构造、worker 和生命周期 hook 之前检查内核准入。`diverged` 只建立恢复会话，普通项目 RPC、REST、媒体及 CLI/MCP 的同一项目入口返回 `PROJECT_HISTORY_DIVERGED`（409）；没有 provider 请求、旧回执重放、daily 或打开/关闭备份。进程重启的后台任务索引不会启动这个会话的旧任务。

宿主专用接口位于 `/api/projects/<ID>/history/`，沿用认证和项目寻址，不进入业务 RPC 注册表或模型工具目录：

| 方法和路径 | 行为 |
| --- | --- |
| GET `status` | 状态、差异原因、文件/seen pair、history 身份、版本数、已提交且结果未知任务数、确认摘要 |
| GET `versions?limit=&cursor=` | 只读版本分页 |
| GET `preview?versionId=&limit=&cursor=` | 空执行域的 V1 版本预览，不把待归档旧任务或缓存引用当作新执行域的保留依赖 |
| POST `resolve` | 稳定小写 UUID requestId、continue/restore-version、完整 expected pair、historyIdentity、confirmationDigest；恢复另带 versionId/previewDigest |

状态提示为“这份项目与本机记录不一致”；原因仅区分文件序号较小/较大、同序号内容不同、旧 history 没有令牌，不称其为可靠的旧版本或后继。确认页须说明：旧对话、任务回执、Mio/时间线撤销将整份归档，不再执行；已经交给服务商而结果未知的任务不续跑；本机版本会保留为恢复来源。可确认“以当前文件继续”或“恢复某个本机版本”，也可关闭会话。

确认经过真实应用库 owner/中止守卫和 manager 独占，普通请求 lease 排空后关闭旧连接；确认请求本身不持有该 lease，避免等待自己。旧 history 完整改名为 `history-<时间>-<requestId>.db`、设为 0400；新库只复制版本两表，保留原 ID/来源和 blob 字节，不复制请求/自动 mark。缓存为可重建的空执行视图，项目中的四种本机过程目标修订按内核 fresh 规则清理；内容目标修订、素材定位和权限不放宽。恢复操作在同一事务写 V1 回执与宿主提交证据。

私有 `history-switch-<requestId>.json` 固定输入、文件身份、暂存/归档名、阶段和结果；active 指针先于切换发布。prepared/copy 中断仍可回到恢复会话；已提交的恢复不重做，归档和发布步骤可续完。每次文件发布及意图更新都 fsync，缺失 history 不能自动 fresh；异常状态保留全部证据。确认成功返回固定结果和 `activation:'pending'`，释放独占后由下一次普通项目请求照常激活，再做本日首次打开版本。重复确认直接返回原结果，即使项目后来已编辑或正在工作，也不关闭正常运行时。

`PROJECT_HISTORY_BASELINE_CHANGED`（409）要求重新读取确认，`REQUEST_ID_REUSED`（409）拒绝不同输入重用 ID；`PROJECT_HISTORY_SWITCH_PENDING/INVALID`（409）保留切换证据；普通已准入宿主访问这些恢复会话读接口返回 `PROJECT_HISTORY_NOT_DIVERGED`（409）。非法参数返回 `VALIDATION_ERROR`（400），URL/input 项目不同为 `PROJECT_ID_MISMATCH`（400）。关闭仍使用 manager 的普通关闭能力，不新增通用 history RPC。

`startServer` 在应用数据目录预检、取得 `server.lock` 后打开唯一的 B1 应用库，再组装应用设置和 `createProjectHostManager`；`manager.restore()` 完成后开始监听。项目请求经真实租约进入 `composeHostedProject` / `composeProjectRuntime`，一个项目只持有一个内核连接，应用库不挂到项目连接上。关闭项目不关闭借用的应用设置或应用库。普通测试通过 `project-file/test-store.ts` 的 `openStore(root)` 和七个数据库辅助函数使用真实内核；旧工作区 opener、迁移、备份和恢复实现已退役。

`dataDir` 是应用数据目录，放应用库、设置、令牌、`records/`、`tmp/`；项目目录独立。服务端默认项目在 `<dataDir>/projects/`，缓存为 `<dataDir>/cache/projects/<ID>/`。桌面使用 `<userData>/data/`，旧 `<userData>/workspace/` 不迁移、不再读取；默认项目在 `<videos>/Mioon/`，缓存用系统缓存目录。设置 `MIOON_DESKTOP_USER_DATA` 时，项目和缓存均留在覆盖目录的 `data/` 内，具体布局见 2.1。应用目录含旧 `workbench.sqlite` 时，生产启动精确拒绝 `VALIDATION_ERROR`（400），不迁移旧树或旧库。

生产仅接受项目前缀下的项目 RPC、REST 和媒体。旧 `/api/rpc` 里的项目操作返回 `VALIDATION_ERROR`（400）；旧项目 REST 和 `/media/<ID>` 返回 `NOT_FOUND`（404）。`project-routes.ts` 仅供测试内部 handler 适配，生产入口不导入它，也不注册旧公开地址。历史记录内保存的 URL 不改写，读取和下载按项目 ID 重建实际地址。同一个 `requestId` 的精确回执按项目独立保存，不能跨项目读取或复用为另一项目的回执。

- `GET /api/project-covers/<ID>` 是应用级只读缓存接口，只读该项目缓存中的 `cover.jpg`、`cover.json`；缺失或不匹配返回 404，从不 acquire 项目。`projectSummaryCoverSchema` 的 URL 已改为此地址，并要求 ID 与摘要项目一致。
- `GET /api/workspace-info` 返回应用目录；`GET /api/projects/<ID>/workspace-info` 取得正常项目请求租约后返回真实 `projectDir`。两者复用 `workspaceInfoSchema`。桌面导出按已验证 owner 的项目 ID 请求后者，不从 `fileLocation` 猜素材根。
- 全局 `GET /api/agent/tasks/v2/diagnostics/latest` 只读应用 documents 的 `agent-diagnostic-summary-v1.json`，返回 `{test: null | summary}`，summary 严格只有 `completedAt`、`status`、`protocol`、`model`、`errorCode`。项目诊断完成时更新，不复制对话、请求原文或密钥，不扫描或打开关闭的项目。应用库当前为 4：仅精确已知 v3 做 S3-A 的3→4升级；保留旧索引JSON及其它文档、登记和策略回执，不组合旧1/2升级到4。
- 经过 HTTP 的 B1 错误仅列 `APP_LIBRARY_LIMIT`（507，登记容量上限）和 `APP_LIBRARY_INVALID`（422，无效诊断摘要，`details: {reason:'unusable'}`）。`APP_LIBRARY_LOCKED`、`APP_LIBRARY_FORMAT_NEWER` 是监听前的启动错误；`APP_LIBRARY_CLOSED` 是内部生命周期错误，不据此新增公开端点。
- `inspectProject: receive => …` 是受信测试接收选项；真实服务端子进程可用固定测试 IPC 读取其 own connection。HTTP、CLI 和环境变量不接受 SQL、回调或 inspect 开关；活跃连接复用、关闭项目短开即关、同步回调和 transition 拒绝规则不变。
- V2 的 `createProjectBackups` 已在生产注册第一个生命周期 hook。正常准入后打开复制项目文件，关闭在运行时排空后、store 关闭前复制；按项目 ID、内容序号和令牌去重、保留最近三份，登记实际完成副本的 pair。`project.backup.list/inspect/restore/status` 走应用 RPC，不 acquire 原项目，恢复为新 ID、新令牌、空本机记录的新文件。实现边界和契约见 [PROJECT-BACKUPS.md](PROJECT-BACKUPS.md)，本卡没有备份界面。
- S1 素材媒体 GET/HEAD/Range 使用精确宿主 store 的 L1 引用服务，逐块重查权限与身份，响应 no-store；宿主不再预建私有 `media/`。受信用户路径导入/位置确认走固定 `asset-media/trusted` 项目路由，沿用认证与 origin 检查，普通 RPC/MCP 无确认入口。封面缓存绑定无路径内容指纹，首页仍不 acquire 项目。导入、复制恢复许可和格式拒旧见 [ASSET-REFERENCES.md](ASSET-REFERENCES.md)。
- 备份完整校验成功后按文件身份和变动时间在同一服务实例内缓存；安全属性仍逐次检查，替换或变动即重验。打开去重只确认最近有效项，列表仍核对全部有效项，inspect/restore 仍完整只读校验。
- 版本领域在真实项目服务中接入 `project.version.list/save/preview/restore`，走项目前缀 RPC；正常准入的每日 hook 在 V2 打开备份校验后执行，Mio 首改与恢复前保存使用同一真实连接和事务。恢复同时核对完整摘要与内容序号/令牌，并在写入前检查应用能力和宿主在途工作。当前 project/history/cache 为 3/10/2，精确已知 history 2–9 可直升到 10，旧 token 缺失时进入恢复会话；详见 [PROJECT-VERSIONS.md](PROJECT-VERSIONS.md)。备份四项与版本四项统一进契约根操作表及 effect 表，内置 Mio 均禁用。

### S5-A：复制与另存为

应用级 `POST /api/rpc` 已接 `project.duplicate` / `project.save-as`，使用 `project-copies.ts` 的独立叶契约：源 projectId、稳定 requestId、明确的新目标绝对 `.mioon` projectFile 及可选 name；不进入公共/模型/CLI/MCP discovery，不挂回旧 package 路由。真实应用复制服务由唯一 B1 owner 与中止守卫保护，不借一个项目的服务充全局入口。

manager 独占先排除窗口和待写工作，再关闭源；随后由关闭源只读 reader 在同一受保护读事务中 SQLite backup 项目和现有 history，不构造源 runtime、升级源或新建源 records。存在 history 即携带全部可转换版本，不要求 seen 匹配；坏、占用、热日志或未完成 V5 切换整笔拒绝。目标是新 ID/令牌、当前内容和重绑定版本，空执行域，不归档完整旧 history；seen 使用 builder 最终实际 pair。素材继续引用同一文件，源目录与既有目录确认随新登记/固定回执在应用事务中转移。

`ServerInstance.projectEntries` 可选 `duplicate` / `saveAs`；另存为核对可信 window owner，仅释放自己的 window，复制服务关闭源后复制，成功同窗口 acquire 新项目，异常尝试重开源。应用 RPC 本身不管理窗口。当前没有桌面选择器、行菜单或复制/删除 UI 接线。

复用既有应用回执，另以 `<dataDir>/project-copies/` 的私有 v1 intent 固定新身份、暂存/占位身份和阶段，不改变应用库或 history 版本。新 records/项目发布后续办登记与回执，不重拷已发布内容；重放不重新授予撤销的目录确认。S5 发布采用 hard link 或已核身份的 `wx` 占位+rename 回退，exFAT 不因缺 hard link 一概拒绝；协调人接受核对与 rename 间的窄竞态，不新增原生端口。契约、失败/恢复限制、已销项义务见 [PROJECT-COPIES.md](PROJECT-COPIES.md)。

### S5-B：作为新项目打开、复制到和模板

应用 RPC 的 `project.adopt-copy` / `project.copy-to` 绑定选中源的项目 ID、绝对路径、dev/ino 和内容 pair；执行时重验，源始终关闭。adopt 不 acquire 原项目，也不读原 history，用 builder 暂存、持副本 SQLite 写锁、核身份后替换，不做原位重键。copyTo 只读捕获源和本机已有 history，不论 seen 是否匹配都携带版本；坏或被占用就整笔拒绝。`project.template.instantiate` 仅选可信 catalog 的模板 ID/版本，在新文件夹建实例并复制校验过的白名单素材；文件夹冲突不合并。新操作都不进公共、CLI/MCP 或 Mio discovery。

受信 `projectEntries.adoptCopy({...input, windowId})` 先保留空窗口 owner，再执行替换并打开新项目，返回 `{copy, window}`；窗口冲突/容量不足时还没改变副本。`copyTo` / `instantiateTemplate` 返回复制结果，S6 再调用现有打开能力。S6-C 2b 通过受信票据接选择器和桌面 UI，确定回执后才进入原有窗口准入链。catalog 由 `ServerOptions.projectTemplates` 在受信初始化时注入，普通请求不提供模板路径/manifest。

启动恢复将 prepared/captured 的未完成转换按已记录身份清理隐藏暂存目录并作废，原键报 `PROJECT_COPY_INTERRUPTED`；不删除身份已变的后来文件，不在同键重造新身份。ready 以后完整结果继续按 intent 续办。

### S5-C：只将项目文件移到废纸篓

应用 RPC `project.delete` 要求严格的 `confirmTrash`、确认路径/文件身份和项目 revision。只有受信桌面主进程可以执行 `shell.trashItem`；网页/headless 缺少能力时返回 `PROJECT_TRASH_UNAVAILABLE`，CLI/MCP 命令留 0.1.x 并在本机访问前明确拒绝。成功后仅撤登记并提交固定回执，素材和全部本机记录保留；未知结果保留 intent 和登记，不重做、不根据路径缺失推断成功。

项目有窗口、会写回项目的工作或 Mio 等待回答/审批时拒绝；关闭项目通过 S3-A `inspectProjectWork` 检查，S8 草稿不阻止。关闭前准入不靠 `interrupt` 清掉等待状态。具体契约、保留项和已销项的永久清理义务见 [PROJECT-LIFECYCLE.md](PROJECT-LIFECYCLE.md)。本卡未接 UI，真实 macOS 废纸篓验收交 Q。

### 暂不可用的后续能力

| 归属 | 当前操作/地址 | 精确结果 |
|---|---|---|
| S5-A / 0.1.x | CLI 和旧客户端 `project.duplicate` | 409 `PROJECT_COPY_UNAVAILABLE`，网络/存储访问前拒绝；新 CLI/MCP 命令后续接入 |
| V4 | 打包导入导出尚无新生产接口；旧 `/api/project-packages/…`、项目 `package-preview` | 404 `NOT_FOUND`；不进入旧复制、删除或导入链 |
| S7 | 应用 RPC `workspace.backup.create/inspect/list/restore.stage/status`、`/api/workspace-backups/…`（含 bundle 下载/导入、directory 导入） | 404 `UNKNOWN_OPERATION`（旧文件地址为 `NOT_FOUND`） |

`workspace.restore.inspect` 已退役并返回 404 `UNKNOWN_OPERATION`；不再有旧恢复来源或能力探测协议。工作区设置去掉五个退役备份键；项目自动备份仍由 V2 宿主 hooks 提供。S5-C、V4 继续按各卡边界实施。

数据库内的队列、保留容量与配额按各项目宿主的实际三库计算。Mio 的 256 MiB / 65536 行及回执豁免仍由当前 history 计量和触发器保护；各项目的 LUT 保留和任务队列彼此独立。明确的应用级资源预算（例如连续音频会话内存和媒体进程 admission）保持各自契约。

### 配额口径

原 SQL 的 `Global` / `workspace` 常量现在只查询当前项目的库，常量本身未提高。设 N 为独立项目数，下面是跨项目的可达合计；各项目仍受原项目上限、任务状态和字节校验约束。

| 资源 | P4 按项目的合计上限 | 原单工作区合计上限 |
|---|---:|---:|
| 图片排队 / 任务 / 请求 | `8N / 1000N / 3000N` | `32 / 10000 / 30000` |
| 帧排队 / 活跃 / 任务 / 请求 | `2N / 1N / 256N / 4096N` | `8 / 1 / 2048 / 32768` |
| LUT 数量 / 字节 | `128N / 64 MiB × N` | `512 / 128 MiB` |

S3-A只增加应用任务索引的4096/512条上限，不增加全应用运行槽或公平调度；跨项目总量调度、历史/LUT/Mio存量硬限留0.1.x或另卡。各项目原有上限照旧。

### S6-A：项目目录与受信控制

应用级认证读取新增 GET /api/project-entries，严格契约在 packages/contracts/src/project-entry.ts。响应为版本 1、appLibraryScope、instanceId 和 registered；每条含完整 RecentProject（summary 可以为空）、availability 和 coverUrl。封面仍只读 GET /api/project-covers/<ID>，没有缓存就显示占位。

- 网页渠道只列配置 projectsDir 内已登记的项目；生产/开发桌面渠道列全部最近登记。范围由启动时的受信渠道决定，HTTP 不接受目录、模式或分页参数，也不扫描未知文件。手工放进目录的文件，须经明确的打开流程登记一次后才出现；0.1.0 没有新增网页文件扫描或任意路径打开接口。
- 读取先刷新已打开宿主的登记摘要，再经 manager.list()，让画幅、时长和封面信息反映当前编辑；不取得新租约或为补摘要自动组装项目。保留热日志恢复及后台查找移动位置的规则。availability 是提示，实际打开结果仍是权威。
- appLibraryScope 与原 last-project 的 workspaceScope 使用同一应用库身份算法；instanceId 仅表示这次服务实例，不能用来代替稳定缓存身份。读取前后检查身份，换库或失去应用库持有权时拒绝。旧 `/api/last-project` 已随 S6-C 2a 退役，renderer 身份与缓存阻断规则见下节。
- 目录最多 8192 条（沿用 B1），本新资源的完整 JSON 传输单独限 384 MiB，超过返回 PROJECT_ENTRY_LIMIT（413），不截断成假完整列表。这是读取资源的上限，不改变应用库容量或保证容纳其全部理论极限数据。

ServerInstance.projectEntries 是生产受信端口，契约在 project-entry-native.ts：listRecent、create、openPath、acquire、release、onWindowRevoked。它由当前服务实例闭包持有，不注册到 HTTP、RPC、CLI 或环境变量，也不使用 retainProjectForTest。S6-A 只交付此端口；桌面主进程/utility 消息和真实窗口接线归 S6-B。

- create 共用 createInitializedProject：校验位置、创建唯一文件、初始化项目行和画幅，然后关初始化连接；原生创建本身不组装运行时。原公共 project.create 在共用初始化后继续保留既有 request 租约激活行为，响应字段不变。
- 名称由独立 project-name.ts 同时给服务端和 U1 预检使用：拒绝空名、超过 150 个 UTF-16 单元、控制字符、非法路径字符、首尾空白/点、Windows 设备保留名（含扩展名、大小写和上标数字）。底层文件夹清洗/NFC/序号规则保留，不用静默清洗代替公共输入校验。
- 宿主在 factory、afterOpen 和摘要全部成功后才提交 lastOpenedAt；身份登记提前保留旧时间或 null。失败不刷新打开时间，也不盲目回滚并发的新登记。
- openPath/acquire 固定取得 window 租约。windowId 是主进程生成的 UUID owner，不是页面任选的租约种类或 BrowserWindow 数字 ID。同一 owner 同一意图共享绑定；不同意图冲突。release 幂等，pending open 的晚到租约会回收，不能交给替代 owner。
- 普通 release 只释放自己的 window 租约；强制撤销或退出通过 onWindowRevoked 通知。网页编辑页仍使用原 request 租约/空闲关闭规则，网页 window-session 留到 0.1.x；S6-A 没有新增持久化窗口表。
- 当前端口不提供忘记登记或显式强关项目：忘记仅限缺失且无活跃窗口、无待写入结果的已审流程，显式强关会撤任务，均不能用这个端口绕过后续 S3/S6 的准入。

Node 只读客户端为 @mioon/client/project-entry 的 createProjectEntriesClient().list()：固定地址、认证 GET、严格响应/UTF-8/字节上限、取消和超时，不自动重试。新增错误为 PROJECT_ENTRY_SCOPE_MISMATCH（409）、PROJECT_ENTRY_UNAVAILABLE（503）、PROJECT_ENTRY_WINDOW_CONFLICT（409，受信端口）、PROJECT_ENTRY_LIMIT（413）。未改应用库/项目/history/cache 格式、Mio 工具目录或请求指纹。

### S6-C：首页与最近项目

网页首页、原生启动器和编辑器内的项目选择共用 GET /api/project-entries；渠道范围仍由服务端决定。无摘要的登记保留名称和位置，未知时间不编造。最近打开为默认顺序；搜索、排序和网格/列表仅作用于已登记目录。封面读取失败显示占位，不为补图打开项目。没有显式项目 URL 时停在首页；显式目标不可用时不改开其他项目，原生编辑窗口仍由宿主指定项目。

最近记录来自登记及成功打开事实；目录读取、搜索或卡片选择不再持久化一个“上次选择”。`project-entry-identity.ts` 的只读 owner 只在完整严格快照后验证 appLibraryScope 与 instanceId。磁盘偏好缓存仍按稳定 scope 隔离；换库或同库更换服务 instance 都 sticky block 当前 renderer，清除目录/verified scope，须由新 renderer 完整验证后建立新身份。不通过 A→null→A 自动恢复旧队列；旧请求、晚到成功/错误及原实例偏好 ACK 都不能因身份恢复重新取得写入资格。普通网络失败保持未知，可在相同身份下重试，不发布空目录。

“生成任务在等项目”来自 GET /api/background-tasks 的完整分页，按当前目录核对身份和项目后统计；读取失败或换库时不展示旧计数，用户可明确重试。首页不自动打开、接收或丢弃结果。打开卡片前重新读取目录并核对库身份；原生窗口的未保存输入确认先于该读取，未知打开/创建结果仍由原窗口核对。

S6-C 2a 的范围是 12-04 素材状态、12-06 外部位置的现有 HTTP 接线与内容读取门，受控的新建、打开错误和位置风险 UI、四语、目录身份，以及旧 last-project 退役。读取门按当前项目/素材状态阻止缺失、变化、未确认和未知内容读取；刷新状态不证明未知写入成功。原生 dirty 确认、entry receipt、unknown owner 和 P0 关闭准入继续保留；设置页身份不可确认时保留原表单和秘密输入，仅阻断交互。本批不宣称全部 Q 或 S6-C 流程完成。

`GET/PUT /api/last-project` 与子路径在既有 Host/Origin、令牌/会话校验后固定为 404 `NOT_FOUND`，不解析为旧定位读写。application/project runtime 不再构造 lastProject/Http，生产消费者已改用只读目录身份。应用库里的旧 `last-project-v1.json` document 保留原字节，即使损坏也不修复、不删除、不迁移；本次不提升 schema/version。旧模块和契约仅作不可达遗留与单元测试依据。

S6-C 2b 消费 S6-B/B2 的真实项目和素材桥。系统选择、COPY 原件事实、只读/网络复制来源、固定权限帮助与 Reveal、当前位置风险、示例及废纸篓均按公开能力接线。选择和结果绑定原文档/项目/修订；目录身份与 lease 仍共同控制旧请求。未知结果保留原请求并参与原生关闭准入，用户明确重试才使用原 token/requestId，不从列表或路径缺失推断写入成功。

模板桥仅扩固定 `timeline-basics` v1：经已有安装 catalog 验证后声明能力，main 的 `template` 存储票据持有真实目标，并经严格私有控制命令调用已有 `instantiateTemplate`。不改 S5/S6-D 服务或其他桥权限。成功创建、复制及模板的打开使用 renderer 私有的一次许可：保留原 dirty 同意，再读目录验证新 ID 后只开一次；过期、换 owner 或新输入均使许可失效。另存为保持 `saveAs=false` 并隐藏。系统权限与物理卷的实际验收仍归 Q。

以下保留 10-31 的接口设计、切换前清点和第 6 节实施计划作为历史依据；其中“下一轮”“现在的 composeServer”指当时的旧入口，当前行为以上述 P4 状态和实际源码为准。S0a 内核接口的调用时机仍见第 5 节。

约定以 `PROJECT-FILE.md` 为准，本文只引用、不重复。代码在 `apps/server/src/project-host/`：

| 文件 | 内容 |
|---|---|
| `types.ts` | 租约种类、宿主状态、关闭原因、项目可用性、默认时长、状态和事件。不引入任何模块 |
| `naming.ts` | 由项目名得出文件夹名，以及序号。不引入任何模块 |
| `errors.ts` | 寻址错误、宿主错误、`isDatabaseMovedError`。只引入 `app-error.ts`、`project-file.ts` 两个契约 |
| `folders.ts` | 占用新项目的文件夹 |
| `directories.ts` | 应用级的目录，以及给内核的 `locate` |
| `host.ts` | 单个项目宿主的类型 |
| `ports.ts` | 需要别的卡提供的端口 |
| `stand-ins.ts` | 端口在那些卡合入之前的替身 |
| `manager.ts` | 宿主管理器和新建项目 |
| `index.ts` | 显式导出 |

前三个文件网页也能导入，按路径导入，不经过 `index.ts`。宿主放在服务端，因为它要用服务端的设置、密钥编解码和网关。测试是 `tests/project-host-naming.test.ts`、`tests/project-host-directories.test.ts`、`tests/project-host-manager.test.ts`，都在本进程里跑，用真实的内核 store 加假的运行时。

## 1. 清点

以下清点记录切换前 `apps/server/src/index.ts` 的 `composeServer` 组装，分成三类。“卡”一列是当时计划由哪张卡挪动或改写。

### 每个项目一份（进项目宿主）

| 组成部分（`composeServer` 里的名字） | 理由 | 卡 |
|---|---|---|
| `store`（`openStore(root)`） | 一个 `.mioon` 一个连接，独占锁从打开到关闭 | S0 |
| `providers`（`createProviderRegistry({db, root, env})`） | Mock 供应商把任务账本建在 store 的连接上；真实供应商用 `root` 读参考图、存下载 | S0（Mock 的两张表收进本机记录），S1、S2（`root`） |
| `services`（`createServices`）和 `services.drain()` | 绑定 store | S0 |
| `worker`（`startWorker`） | 只处理该宿主统一投影已纳管的 job/export ID | S3-A 提交后通知和有界恢复 |
| `editTasks`、`reconcileStartup()`、`editTasksHttp`（`/api/tasks…`） | 编辑任务记在本机记录；打开时对账 | S0 |
| `taskToolsV2`、`taskRuntimeV2`，`taskHttpV2` 的项目路由和 `editing` | Mio 的对话和步骤记在本机记录 | S0 接线，R1 改运行时 |
| `versionComparisonMedia` | 读这个项目的素材 | K2 改路径，S0 |
| `exportFileRecovery`（`/api/export-files`） | 同上 | K2 改路径，S0 |
| 预听：`audioPreviewHttp`、`continuousAudioHttp`、`services.audioPreview` | 同上 | K2 改路径，S0 |
| 图片审阅的 `approve`、`reject`（`imageHttp` 里调 `imageApproval`、`imageRejection` 的两条） | 按审阅 ID 在项目里找 | K2 改路径，S0 从 `imageHttp` 拆出 |
| 本机草稿：`ProjectDraftsFactory` 创建的 clip、delivery、shot-text 和 HTTP，`shotTextDomain`、`shotReplay` | 四张草稿领域表属于本机记录，同宿主唯一连接 | S8；三个旧 JSON 原位退役，不导入、不读写 |
| `files`（`createFileResponses`）的媒体流 | 关闭项目要等它的文件流；静态文件另用应用级的一份 | S0 |
| 删除闸门的请求跟踪（`deletionGate.track`、`rpc`）和 `hold()` | 换成宿主的请求租约；`hold()` 算进运行时的忙碌和排空 | S0 |
| `/api/projects/<id>/package-preview`（交换文件的预览） | 读项目内容；已经在新前缀下 | V4 删除；之前进宿主 |

### 整个应用一份

| 组成部分 | 理由 | 卡 |
|---|---|---|
| HTTP 服务、`handleRequest`、Host 和 Origin 检查、`auth`、`access-token`、`/api/login` | 不随项目 | 不变；S0 改分派 |
| 静态文件（`distDir`、`index.html`） | 同上 | 不变 |
| `agentSettings`（网页版的 `agent-settings/`，桌面版由主进程代理）和密钥编解码（`agentSecretCodecFactory`、`imageSecretCodec`、`videoSecretCodec`） | 设置和密钥属于这台电脑 | 不变 |
| `agentAuthorizations`（`agent-authorizations-v1.json`） | 发送授权属于这台电脑；范围改按应用库的文件身份算（定下的两处之一） | S0，和己、B1 确认 |
| 图片、自定义图片、视频、ComfyUI 的设置和连接（`imageSettings`、`customImageSettings`、`videoSettings`、`comfySettings`、`comfyConnector`），两个图片网关，以及它们的 HTTP | 同上 | 不变 |
| 全局放行档位（`/api/agent/tasks/v2/policy`、`/policy/requests/<id>`）、测试连接（`/diagnostics/latest`）、`agentDiagnosticsHttp` | 这几张表进应用库；`agentDiagnosticsHttp` 带 `projectId` 时，`hasProject` 改查登记，存储统计只在项目开着时给（不触发自动打开） | B1、S0、己 |
| `uiPreferences`（`ui-preferences-v1.json`，含 `recentOpened`） | B1 收进应用库；`hasProject` 改查登记 | B1、S0 |
| 工作区配置 `createWorkspaceConfiguration`（`workspace-settings-v1.json`、`environment()`） | B1 收进应用库；自动备份的字段随 S7 去掉 | B1、S7 |
| `workspacePreferences`（`workspace_preferences` 表，按 projectId） | 表进应用库，项目在不在改查登记 | B1、S0 |
| `lastProject`（`last-project-v1.json`） | S6-C 2a 已退役生产读写，改用最近目录身份；旧 document 字节保留，不删除、不升版本 | B1、S6 |
| 媒体进程 `onMediaProcess`、`terminateMediaProcesses` | 进程级 | 不变 |
| `/health`、`/api/workspace-info`、`/api/media-tools/check` | `/health` 不再读项目库（用 `process.versions.sqlite`）；`/api/workspace-info` 改成应用信息，`pendingProjectCleanup` 随 S5 去掉 | S0 |
| 存储预检 `validateWorkspaceStorage(root)` 和单实例锁 `server.lock` | 改成应用数据目录的检查（去掉 `workbench.sqlite`、`media/`、暂存目录这些条目）。单实例锁仍在应用数据目录，现在由 `db.ts` 的 `openStore` 取（`workspace-lock.ts`），切换后由 `startServer` 自己取 | S0 |
| `shutdown` 中止信号 | 应用一份；每个宿主另有自己的信号，应用退出时全部关闭 | S0 |
| `nativeAudioPreview` 授权对象 | 每个 utility 进程一个，`bind()` 只能调一次（`native-audio-preview.ts`）；改为绑定一个按 projectId 分派到宿主的服务 | S0 |
| 桌面 `backend.ts` 的授权代理、两个密钥客户端、字幕资源；`cli.ts` 的私有存储初始化和无界面密钥编解码 | 进程级 | 不变；`cli.ts` 加 `MIOON_PROJECTS_DIR`（S4 或 S0） |

### 随删除一起去掉

| 组成部分 | 卡 |
|---|---|
| v1 助理：`chatRuntime`、`chatHttp`、`createAgentEditService`、`chatGateway`、`agentEditFault` | P1a-2 |
| 透明度候选：`candidate`、`candidateEditor`、`candidateDomain`、`createOpacityCandidateRequestApplication`、`opacityCandidateLaunch` | P1b |
| 工作区备份和恢复：`resolveWorkspaceActivation`、`restored` 分支（含只读的 Mio 运行时）、`services.backups`、`setBackupDirectory`、`/api/workspace-backups/…`、`workspaceBaseRoot`、`backupQuiescent` | S7 |
| 交换文件：`projectPackages`、`/api/project-packages/…`（导出、导入归 V4；`duplicates` 改为复制文件，归 S5） | V4、S5 |
| 删除记账：`setProjectDeletionCompanions`、`deletionGate.assertIdle`、两处 `PROJECT_DELETE_BUSY` | S5（删除改为移到废纸篓，经 `withExclusive`） |

### 按 `workbench.sqlite` 算范围的模块

清点时发现，按 `workbench.sqlite` 的文件身份算“工作区范围”的不止 Mio 授权，一共 8 处：`agent/authorizations.ts`、`ui-preferences.ts`、`last-project.ts`、`local-drafts.ts`、`local-delivery.ts`、`local-shot-text.ts`（都在 `packages/business/src/`），以及桌面的 `window-appearance.ts` 和 `main.ts` 里的 LUT 恢复。切换以后 `workbench.sqlite` 不再存在，这些范围都要换文件，见 6.2 第 4 步。

## 2. 接口

签名从源码摘出，只留签名和要点注释。

### 2.1 应用级的目录（`directories.ts`）

```ts
export interface AppDirectories {
  readonly dataDir: string;     // 应用数据目录：access-token、server.lock、设置、应用库、records/、tmp/
  readonly cacheDir: string;    // 应用缓存目录；一个项目的缓存是 <cacheDir>/projects/<ID>/
  readonly tempDir: string;     // 应用临时目录；一个项目的暂存是 <tempDir>/projects/<ID>/
  readonly projectsDir: string; // 不指定位置时新项目的上级目录
}
export const PROJECT_TEMP_DIRECTORY = 'projects';
export function serverAppDirectories(dataDir: string, options?: {readonly cacheDir?: string; readonly projectsDir?: string}): AppDirectories;
export interface SystemCacheInput {readonly platform: string; readonly home: string; readonly env: Readonly<Record<string, string | undefined>>}
export function systemCacheDirectory(input: SystemCacheInput): string;
export interface DesktopDirectoriesInput extends SystemCacheInput {
  readonly appId: string;               // identity.appId
  readonly dataDir: string;             // DesktopPaths.dataDir
  readonly videosDir: string;           // app.getPath('videos')
  readonly userDataOverridden: boolean; // 设了 MIOON_DESKTOP_USER_DATA
}
export function desktopAppDirectories(input: DesktopDirectoriesInput): AppDirectories;
export function projectLocation(directories: AppDirectories, projectId: string): ProjectLocation; // 内核的 locate
```

| | 网页版、无界面服务 | 桌面版 | 桌面版，设了 `MIOON_DESKTOP_USER_DATA` |
|---|---|---|---|
| `dataDir` | `startServer` 的 `dataDir`（`cli.ts` 取 `MIOON_DATA_DIR`，默认仓库的 `data/`） | `dataPaths().dataDir`，即 `<userData>/data` | `<覆盖目录>/data` |
| 新项目默认的上级目录 | `<dataDir>/projects/` | `<videos>/Mioon/`（macOS `~/Movies/Mioon/`，Windows `Videos\Mioon\`） | `<dataDir>/projects/` |
| 本机记录 `localDir` | `<dataDir>/records/<ID>/` | 同左 | 同左 |
| 缓存 `cacheDir` | `<dataDir>/cache/projects/<ID>/` | `<系统缓存目录>/<应用 ID>/projects/<ID>/` | `<dataDir>/cache/projects/<ID>/` |
| 暂存 `tempDir` | `<dataDir>/tmp/projects/<ID>/` | 同左 | 同左 |

- 系统缓存目录：macOS `~/Library/Caches`，Windows `%LOCALAPPDATA%`（缺失或不是绝对路径时用 `<home>\AppData\Local`），其他系统 `$XDG_CACHE_HOME`（同样要求绝对路径）或 `~/.cache`。
- 内核按私有目录的规则建这三个本机目录：0700、本人所有、路径里不能有符号链接（`tests/project-host-directories.test.ts` 实测）。所以 macOS 的系统临时目录（经过 `/var` 这个符号链接）不能用，`tempDir` 放在应用数据目录下。
- `tempDir` 可能和项目目录不在同一个盘上，暂存文件移进项目目录时不能只靠一次改名（`EXDEV`）。
- 本机记录的文件夹以后不能搬（`PROJECT-FILE.md`“一个连接，三个库”），所以 `dataDir` 的取法要在切换时一次定好。桌面版定为新的 `<userData>/data/`（第 7 节第 3 条）：切换时改 `config.ts` 的 `dataPaths`；旧的 `workspace/` 里的开发数据不迁移，也不再读。
- 网页版和无界面服务的 `dataDir` 里有旧的 `workbench.sqlite` 时，启动报错，提示换一个目录或删掉旧文件，不和新布局混在一起。
- `desktopAppDirectories` 在主进程里算：桌面后端拿不到 `app.getPath`，`supervisor.ts` 的启动消息只有 `dataDir`、`distDir`、`subtitleResourcesDir`、`token`、`nativeAudioPreview`，`utilityEnvironment` 也不转发 `LOCALAPPDATA`、`XDG_CACHE_HOME`。主进程把 `cacheDir`、`projectsDir` 传给后端。Windows 的路径用 `path.win32` 拼，在 macOS 上也能测。

### 2.2 项目宿主的管理器（`manager.ts`）

```ts
export interface ManagerClock {now(): number; setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void}
export const SYSTEM_CLOCK: ManagerClock; // 真实时间，计时器 unref
export interface ProjectHostManagerOptions<Runtime extends ProjectHostRuntime> {
  readonly directories: AppDirectories;
  readonly registry: ProjectRegistryPort;
  readonly factory: ProjectHostFactory<Runtime>;
  readonly identity?: ProjectFileIdentityPort;          // 默认 statProjectFileIdentity
  readonly taskIndex?: BackgroundTaskIndexPort;         // 默认空的内存索引
  readonly hooks?: readonly ProjectLifecycleHooks[];    // 默认 []
  readonly maintenance?: KernelMaintenancePort;         // 默认是内核的 recoverProjectFile
  readonly idleCloseMs?: number;                        // 默认 DEFAULT_IDLE_CLOSE_MS（60 秒）
  readonly drainTimeoutMs?: number;                     // 默认 DEFAULT_REQUEST_DRAIN_MS（3 秒）
  readonly busyRecheckMs?: number;                      // 默认 DEFAULT_BUSY_RECHECK_MS（1 秒）
  readonly clock?: ManagerClock;                        // 默认 SYSTEM_CLOCK
  readonly openStore?: (options: OpenProjectConnectionOptions) => ProjectStore; // 默认内核的 openProjectStore
  readonly onEvent?: (event: ProjectHostEvent) => void; // 抛错被忽略
}
export interface CreateProjectInput {
  readonly name: string;          // project.create 的 name，1–150 字
  readonly projectFile?: string;  // 指定的 .mioon：从不覆盖，所在文件夹必须存在
  readonly parentDir?: string;    // 新文件夹的上级；默认 directories.projectsDir
  readonly projectId?: string;    // 只给测试；不能已经登记
}
export interface CreateProjectPorts {readonly directories: AppDirectories; readonly registry: ProjectRegistryPort; readonly identity: ProjectFileIdentityPort}
export function createProjectFiles(input: CreateProjectInput, ports: CreateProjectPorts): RecentProject;
export interface RestoreResult<Runtime extends ProjectHostRuntime> {
  readonly leases: readonly ProjectLease<Runtime>[];
  readonly failures: readonly {readonly projectId: string; readonly error: unknown}[];
}
export interface ListedProject {readonly project: RecentProject; readonly availability: ProjectAvailability}
export interface ProjectHostManager<Runtime extends ProjectHostRuntime = ProjectHostRuntime> {
  list(): readonly ListedProject[];
  create(input: CreateProjectInput): Promise<RecentProject>;
  openPath(projectFile: string, kind: ProjectLeaseKind): Promise<ProjectLease<Runtime>>;
  acquire(projectId: string, kind: ProjectLeaseKind): Promise<ProjectLease<Runtime>>;
  close(projectId: string): Promise<void>;
  closeAll(): Promise<void>;
  withExclusive<T>(projectId: string, run: (registration: RecentProject) => T | Promise<T>): Promise<T>;
  restore(): Promise<RestoreResult<Runtime>>;
  checkMoved(projectId: string): boolean;
  readonly inspectProject: InspectProject;
  status(projectId: string): ProjectHostStatus | null;
}
export function createProjectHostManager<Runtime extends ProjectHostRuntime = ProjectHostRuntime>(options: ProjectHostManagerOptions<Runtime>): ProjectHostManager<Runtime>;
```

`types.ts` 里的共用类型：

```ts
export const PROJECT_LEASE_KINDS = Object.freeze(['window', 'task', 'request'] as const);
export const PROJECT_HOST_STATES = Object.freeze(['opening', 'open', 'closing'] as const);
export const PROJECT_CLOSE_REASONS = Object.freeze(['idle', 'explicit', 'exclusive', 'relocate', 'shutdown'] as const);
export type ProjectAvailability =
  | {readonly state: 'open' | 'busy' | 'available' | 'locked' | 'missing'}
  | {readonly state: 'invalid'; readonly reason: string};
export const DEFAULT_IDLE_CLOSE_MS = 60_000;
export const DEFAULT_REQUEST_DRAIN_MS = 3_000;
export const DEFAULT_BUSY_RECHECK_MS = 1_000;
export interface ProjectHostStatus {readonly projectId: string; readonly state: ProjectHostState; readonly paused: boolean; readonly leases: Readonly<Record<ProjectLeaseKind, number>>}
export type ProjectHostEvent =
  | {readonly type: 'opened'; readonly projectId: string}
  | {readonly type: 'open-failed'; readonly projectId: string | null; readonly error: unknown}
  | {readonly type: 'closing'; readonly projectId: string; readonly reason: ProjectCloseReason}
  | {readonly type: 'closed'; readonly projectId: string; readonly reason: ProjectCloseReason; readonly errors: readonly unknown[]}
  | {readonly type: 'recovered'; readonly projectId: string}
  | {readonly type: 'maintenance-failed'; readonly projectId: string; readonly error: unknown};
```

- **`list()`**：已登记的项目，一个都不打开。本进程没开着、也不在独占操作中的项目，先各调一次 S0a 的 `recoverProjectFile`，结果放进 `availability`（第 5 节的表）。`missing` 的项目在后台按文件身份找新位置，找到就改登记、在新位置再恢复一次，下一次 `list()` 就是新路径。`availability` 只是提示，能不能打开以打开时为准。
- **`create(input)`**：建文件夹（不指定 `projectFile` 时）和 `.mioon`，登记，`lastOpenedAt` 为 `null`，不打开。名字规则见 3.1。指定的 `.mioon` 已存在报 `PROJECT_FILE_EXISTS`（409，`details` 是内核的写法再加 `projectFile`）；所在文件夹不存在报 `PROJECT_LOCATION_INVALID`（400）；不是绝对路径、扩展名不是 `.mioon`、文件名以 `.` 开头报 `VALIDATION_ERROR`。中途失败时删掉这次建出的东西。`createProjectFiles` 是同一件事的函数形式，测试辅助函数 `createServerProject` 直接用它（2.7）。
- **`openPath(projectFile, kind)`**：按路径打开（桌面的打开对话框、双击 `.mioon`、CLI 的 `project open --path`）。同一个文件（按文件身份认）已经开着就直接给租约；否则内核打开。没登记的新登记，名字取文件名去掉 `.mioon`；已登记的把登记改到这个路径。项目正在打开、关闭或独占时，在内核的 `checkCopy` 里中止，等它结束再试。内核的错误原样抛出，由应用级的 `project.open` 填进 `projectOpenFailureSchema`。
- **`acquire(projectId, kind)`**：按项目 ID 取得宿主的租约。已登记但没打开的，按登记自动打开。没登记报 `PROJECT_NOT_FOUND`；打不开报 `PROJECT_UNAVAILABLE`，见 2.5。登记的路径上没有文件（`PROJECT_MISSING`），或打开途中被移动（S0a：`PROJECT_INVALID`，起因是 1032）时，先按文件身份找一次，找到就改登记再开。登记的路径上是另一个项目 ID 的文件时，在 `checkCopy` 里拒绝（`PROJECT_UNAVAILABLE`、`reason: 'PROJECT_MISSING'`），不会给那个 ID 建本机记录。
- **三种租约**（`PROJECT_LEASE_KINDS`）：`window`，编辑窗口显示这个项目，窗口关掉时释放；`task`，S3 在项目有可继续推进的后台任务时持有（仅等用户/源的条目可释放）；`request`，一个在途的 HTTP 请求，SSE 和文件流也算，响应结束时释放。`release()` 幂等。
- **什么时候自动关闭**：见 3.3。
- **`close(projectId)`**：立即关闭，撤销所有租约，在途请求先给 3 秒。各步出错照样走完，最后抛第一个错误。
- **`closeAll()`**：应用退出时用。并行关闭全部宿主，等独占操作结束；之后 `acquire`、`openPath`、`create`、`withExclusive` 都报 `PROJECT_HOST_STOPPED`（503）。
- **关闭时按文件身份更新登记**：打开时 `lstat` 记下文件身份，写进登记；关闭时再 `lstat` 打开时的路径，文件不在或身份不同，就调登记表的 `findMoved` 找新位置，找到就改登记。名字和摘要也在这一步更新。
- **`restore()`**：启动时用。和 `list()` 一样先做恢复，等后台的查找结束，再按后台任务索引逐个 `acquire(id, 'task')`，返回的交接租约交给 S3，S3 已在 ready 中另持自身租约，立即释放交接租约；自身租约随可执行工作及真实在途结束而释放。除了有未完成任务的项目，启动时不打开任何项目。
- **`withExclusive(projectId, run)`**：应用级操作（删除、复制、改名、关闭、另存为）取得独占，见 4.2。
- **`checkMoved(projectId)`**：单独改名或移动 `.mioon` 的检查。定为由内核检查（第 7 节第 6 条）；内核的检查合入以前，宿主把它登记成事务守卫顶上，见 4.6。
- **`inspectProject`**：受信任的测试接口，见 2.7。
- **`status(projectId)`**：开着的宿主的状态和各类租约的个数；没开着返回 `null`。`onEvent` 收到打开、打开失败、开始关闭、关闭完成、恢复了热日志、恢复失败这几种事件。

### 2.3 单个项目宿主（`host.ts`）

```ts
export interface ProjectRequest {
  readonly req: IncomingMessage; readonly res: ServerResponse; readonly url: URL;
  readonly route: ProjectApiRoute;  // parseProjectApiPath 的结果
  readonly signal: AbortSignal;     // 强制关闭时中止
}
export interface ProjectHostContext {
  readonly projectId: string;
  readonly store: ProjectStore;     // 内核的 store：项目唯一的连接
  readonly directories: AppDirectories;
  readonly signal: AbortSignal;     // 开始关闭时中止
  relocate(): void;                 // 写入遇到 SQLITE_READONLY_DBMOVED 时调用
}
export interface ProjectHostSummary {readonly name: string; readonly summary: RecentProjectSummary | null}
export interface UnfinishedTask {readonly kind: BackgroundTaskKind; readonly taskId: string}
export interface ProjectHostRuntime {
  handle(request: ProjectRequest): Promise<boolean>;  // 项目级路由；都不匹配时返回 false
  isBusy(): boolean;
  interrupt(): void;
  drain(): Promise<void>;
  dispose(): void;
  summarize?(): ProjectHostSummary | null;            // 打开时、关闭前读
  unfinishedTasks?(): readonly UnfinishedTask[];      // S3：关闭时写进任务索引
}
export type ProjectHostFactory<Runtime extends ProjectHostRuntime = ProjectHostRuntime> = (context: ProjectHostContext) => Promise<Runtime>;
export interface ProjectHost<Runtime extends ProjectHostRuntime = ProjectHostRuntime> {
  readonly projectId: string; readonly projectFile: string; readonly store: ProjectStore;
  readonly runtime: Runtime; readonly signal: AbortSignal;
  relocate(): void;
}
export interface ProjectLease<Runtime extends ProjectHostRuntime = ProjectHostRuntime> {
  readonly kind: ProjectLeaseKind; readonly host: ProjectHost<Runtime>;
  readonly signal: AbortSignal;     // 被强制关闭撤销时中止
  release(): void;                  // 幂等
}
export type InspectProject = <T>(projectId: string, inspect: (db: DatabaseSync) => T) => T;
```

管理器拥有 store：内核打开以后，工厂在这个 store 上组装运行时，`dispose()` 之后由管理器关闭 store。P4 生产工厂为 `composeHostedProject`（`apps/server/src/project-host/runtime.ts`），调用 `composeProjectRuntime`（`apps/server/src/project-runtime.ts`）组装每项目部分：

- `providers`、`services`；
- 编辑任务，打开时 `reconcileStartup()`；
- `worker`；
- Mio 的工具和运行时（R1 的端口）；
- 本机草稿（S8 的端口）；
- 媒体、版本对比、导出文件、预听、图片审阅等项目级 HTTP。

各个方法：

| 方法 | 做什么 |
|---|---|
| `handle(request)` | 按顺序试 `rpc`、`media`、版本对比、预听、导出文件、图片审阅、草稿、Mio（`agent/tasks/v2/…`、`editing`）、编辑任务（`tasks…`）；`rpc` 里沿用 K2 的 `PROJECT_ID_MISMATCH` 核对。都不匹配返回 `false`，由分派层回 404 |
| `isBusy()` | Mio 正在跑的轮次、执行中的编辑任务、`hold()` 住的文件发布、`worker` 正在调的供应商请求，以及草稿完整在途回调（包括业务返回后的终态保存和 finally）。响应断开不会使草稿提前空闲，静止 pending 不算忙；版本恢复也单独检查草稿 busy |
| `interrupt()` | 关闭的第一步：关掉 SSE（Mio 的 `taskHttpV2.close()`、运行时的 `close()`），中止 Mio 正在跑的轮次 |
| `drain()` | 草稿先停止新接纳，晚到请求直接报对应503且不读 body；停 `worker`，等草稿完整回调、`services.drain()`、`editTasks.drain()`、Mio 的 `drain()`、文件流和版本对比媒体关闭。未确认排空时保留连接和锁，不进入关库 |
| `dispose()` | `taskToolsV2.dispose()` 这类同步的收尾 |

切换前的 `composeServer` 关闭顺序为：`shutdown.abort()`，关 SSE，`Promise.all` 等 `worker.stop()`、`taskRuntimeV2.drain()`、`serviceDrain()`、`editTasks.drain()`、`files.close()`、`versionComparisonMedia.close()`，然后 `taskToolsV2.dispose()`、`store.close()`。P4 将项目排空/释放交给运行时和管理器，应用资源在全部项目关闭后释放。

### 2.4 需要别的卡提供的端口（`ports.ts`、`stand-ins.ts`）

```ts
// B1：应用库
export interface ProjectRegistryPort {
  list(): readonly RecentProject[];
  get(projectId: string): RecentProject | null;
  upsert(entry: RecentProject): void;                  // 按 recentProjectSchema 校验
  remove(projectId: string): void;
  findMoved(entry: RecentProject): Promise<string | null>; // 只用 readdir、lstat
  checkCopy?(file: {readonly projectId: string; readonly projectFile: string}): void; // 内核的 checkCopy
}
export type ProjectFileIdentityPort = (projectFile: string) => ProjectFileIdentity | null; // 只 lstat
export interface AgentPolicyStorePort {
  read(): AgentTaskPolicy | null;
  readRequest(requestId: string): {readonly digest: string; readonly policy: AgentTaskPolicy} | null;
  write(policy: AgentTaskPolicy, request?: {readonly requestId: string; readonly digest: string}): void; // 一个事务
}
export interface AppLibraryPort {
  readonly registry: ProjectRegistryPort;
  readonly agentPolicy: AgentPolicyStorePort;
  readonly projectFileIdentity: ProjectFileIdentityPort;
  readonly databaseFile: string;  // 应用库文件；Mio 授权等改按它的文件身份算范围
  close(): void;
}
// S3：后台任务
export interface BackgroundTaskIndexPort {
  list(): readonly BackgroundTaskIndexEntry[];
  replace(projectId: string, entries: readonly BackgroundTaskIndexEntry[]): void;
  listProject?(projectId: string): readonly BackgroundTaskIndexEntry[];
  upsert?(entry: BackgroundTaskIndexEntry): void;
  markProject?(projectId: string, phase: BackgroundTaskPhase, reason: string | null): void;
  archive?(projectId: string, sourceHistory?: string): void;
}
export interface ProjectInboxPort {add(item: ProjectInboxItem): void; list(projectId: string): readonly ProjectInboxItem[]; remove(projectId: string, itemId: string): void}
// V1、V2、S3：生命周期钩子
export interface ProjectLifecycleHooks {
  afterOpen?(host: ProjectHostContext, readiness?: ProjectHostReadiness): void | Promise<void>; // S3只在opening使用固定retainTask接缝；抛错则打开失败
  beforeClose?(host: ProjectHostContext): void | Promise<void>; // 请求和运行时排空以后、store 关闭以前；出错记下，关闭照常
}
// R1：Mio
export interface MioAppServices {readonly policy: AgentPolicyStorePort; readonly selfPort: () => number}
export interface MioRuntimePort {handle(request: ProjectRequest): Promise<boolean>; isBusy(): boolean; interrupt(): void; drain(): Promise<void>; dispose(): void}
export type MioRuntimeFactory = (context: ProjectHostContext, app: MioAppServices) => MioRuntimePort;
// S8：草稿
export interface ProjectDraftsPort {handle(request: ProjectRequest): Promise<boolean>; isBusy(): boolean; drain(): Promise<void>}
export type ProjectDraftsFactory = (context: ProjectHostContext) => ProjectDraftsPort;
// S0a：内核的恢复函数
export type {ProjectFileRecovery};  // 从内核导入；invalid 带 ProjectInvalidReason
export interface KernelMaintenancePort {recoverProjectFile(projectFile: string): ProjectFileRecovery}
```

替身（`stand-ins.ts`）：

```ts
export function statProjectFileIdentity(projectFile: string): ProjectFileIdentity | null;
export function sameProjectFileIdentity(a: ProjectFileIdentity | null | undefined, b: ProjectFileIdentity | null | undefined): boolean;
export const DEFAULT_FIND_MOVED_LIMIT = 2_000;
export interface MemoryProjectRegistryOptions {readonly entries?: readonly RecentProject[]; readonly identity?: ProjectFileIdentityPort; readonly searchLimit?: number}
export function createMemoryProjectRegistry(options?: MemoryProjectRegistryOptions): ProjectRegistryPort;
export function createMemoryBackgroundTaskIndex(entries?: readonly BackgroundTaskIndexEntry[]): BackgroundTaskIndexPort;
export function createMemoryProjectInbox(items?: readonly ProjectInboxItem[]): ProjectInboxPort;
export function createMemoryAgentPolicyStore(initial?: AgentTaskPolicy | null): AgentPolicyStorePort;
```

端口都是同步的，只有 `findMoved` 是 async（可能要扫目录）。B1 的应用库用 `node:sqlite`，本来就是同步。端口和替身都用闭包实现、不用 `this`，调用方可以展开再包一层。

| 端口 | 卡 | 宿主什么时候调 | 卡合入之前 S0 用的替身 |
|---|---|---|---|
| `ProjectRegistryPort` | B1 | 新建、打开时写登记；关闭时按文件身份改路径、写名字和摘要；`list()`；打不开或恢复报 `missing` 时 `findMoved` | `createMemoryProjectRegistry`：内存里按插入顺序存，写入时按 `recentProjectSchema` 校验。`findMoved` 在原项目文件夹和它的上一级里各往下找两层，按文件身份比对 `.mioon`；跳过以 `.` 开头的条目和 `*.mioon-journal`；最多看 2000 个条目；只 `readdir`、`lstat` |
| `ProjectFileIdentityPort` | B1 | 新建、打开、关闭时，`openPath` 认已开着的同一个文件，`checkMoved` | `statProjectFileIdentity`：`lstat(…, {bigint: true})` 的 dev、ino，不是普通文件时返回 `null`。只 stat，不打开文件；Windows 上的完整文件 ID 由 B1 验证 |
| `AgentPolicyStorePort` | B1；Mio 怎样读由调用方传入，和己商定 | 不直接调；经 `MioAppServices` 交给 Mio | `createMemoryAgentPolicyStore` |
| `AppLibraryPort` | B1 | 切换时由 `startServer` 打开，交给管理器和 Mio；`databaseFile` 给各个范围文件 | 无；S0 切换要等 B1 合入 |
| `BackgroundTaskIndexPort` | S3 | S3-A在任务COMMIT后同步更新；`restore()`交接租约/failures，关闭替换当前集合并保留archived | `createMemoryBackgroundTaskIndex`；启动时没有要恢复的项目 |
| `ProjectInboxPort` | S3 | 占位端口保留；S3-B/C离线接收/回填已定0.1.x，S3-A不扩展或应用结果 | `createMemoryProjectInbox` |
| `ProjectLifecycleHooks` | V1、V2，也给 S3 | `afterOpen`：组装好以后，顺序调用；`beforeClose`：倒序，排空以后。打开按V2备份→S3取租约/激活→每日版本；关闭仍倒序，V2最后备份 | V2 已用真实 hooks；其他卡未接入前不注册 |
| `MioRuntimeFactory`、`MioRuntimePort` | R1 | 工厂里每个宿主建一份；`handle`、`isBusy`、`interrupt`、`drain`、`dispose` 并进宿主的同名方法 | 现在的 `createAgentTaskRuntime` 加 `createAgentTaskHttp`。设置和发送授权也是应用级的，由工厂的闭包带进去 |
| `ProjectDraftsFactory`、`ProjectDraftsPort` | S8 | 完成业务装配后绑定依赖，宿主用真实 context 建一份；`isBusy` 并入宿主及版本恢复门禁，`drain` 等完整终态回调与 finally | 三类服务只写同一连接的 history 草稿表；scope 按该连接持有的 history 文件身份算；持久 pending 本身不算忙 |
| `KernelMaintenancePort` | S0a（#106，已合入） | `list()`、`restore()`，见第 5 节 | 不用替身：默认就是内核的 `recoverProjectFile`，测试可以换成别的 |

V2 的 hook 捕获自身已经结束的备份失败，落安全状态后正常返回，不能让 `afterOpen` 因备份失败而失败。S3-A让宿主后台恢复/worker在打开备份之后取得自身租约再激活；备份仍采用SQLite完成时一致副本，从副本读身份/序号，不把备份错误变成业务成功。关闭开始时 context.signal 已中止，V2 不用它取消原生备份；完整等待结束后才让管理器关库。状态与列表等应用操作详见 [PROJECT-BACKUPS.md](PROJECT-BACKUPS.md)，均不以 acquire 原项目来读备份。

### 2.5 路由

清单第 2 节逐个列了 HTTP 路由的归属。按它，加上清点时找到的漏列的几处：

**项目级**（放在 `/api/projects/<id>/…` 下，用契约的 `parseProjectApiPath` 解析后交给宿主）：

| 新路径（`/api/projects/<id>/` 之后） | 原路径 | 说明 |
|---|---|---|
| `rpc` | `/api/rpc` 里的项目级操作 | 包括只按实体 ID 寻址的 11 个和 `image.review.prepare` |
| `media/<素材 ID>` | `/media/<素材 ID>` | 查询参数照旧 |
| `version-comparison/media` | `/api/version-comparison/media` | |
| `timeline-audio-preview/pcm`、`timeline-audio-preview/continuous` | `/api/timeline-audio-preview/…` | 原生预听的签名范围跟着改 |
| `export-files` | `/api/export-files` | |
| `images/reviews/approve`、`images/reviews/reject` | `/api/images/reviews/…` | 照旧报 `IMAGE_REVIEW_NOT_FOUND` |
| `local-drafts`、`local-drafts/clip`、`local-delivery…`、`local-shot-text…` | `/api/local-…` | S8 改成本机记录的表 |
| `agent/tasks/v2/…`、`editing` | `/api/agent/tasks/v2/<项目 ID>/…` | 去掉路径里原来的项目 ID 段 |
| `tasks…` | `/api/tasks…`（`edit-tasks-http.ts`） | **清单漏列**；projectId 现在在查询参数或请求体里 |
| `workspace-info` | 无旧项目接口 | P4 新增，复用原 schema 返回真实项目目录 |
| `package-preview` | 已在新前缀下（`project-package-http.ts`） | P4 不注册，404 `NOT_FOUND`，后续归 V4 |

新路径保留原来 `/api/` 之后的部分，例如 `/api/tasks…` 改成 `/api/projects/<id>/tasks…`；`/api/tasks…` 也归 K2（第 7 节第 8 条）。

**应用级**（留在原处）：`/health`、`/api/login`、`/api/rpc`（只收应用级操作，项目级操作发到这里报 `VALIDATION_ERROR`）、`/api/agent/settings`、`/api/agent/diagnostics`、`/api/agent/tasks/v2/policy`、`/policy/requests/<id>`、`/diagnostics/latest`（这三条清单只列了项目的部分）、`/api/images/settings`、`custom-settings`、`comfy-settings`、`comfy-check`、`comfy-availability`、`/api/video-providers/*`、`/api/ui-preferences`、`/opened`、`/api/media-tools/check`、`/api/workspace-info`（改成应用信息），以及**清单漏列的** `/api/workspace-preferences/<id>`。最近项目和封面现使用 `/api/project-entries`、`/api/project-covers/<id>`；旧 `/api/last-project` 已在 S6-C 2a 退役为 404，不再是可用应用服务。删除、复制、改名、关闭、另存为是应用级操作，接口形状由 S4、S5、S6 定，内部都经 `withExclusive`。

**随删除去掉**：`/api/agent/chat/…`（P1a-2）、`/api/local-drafts/restored43…`（P1b）、`/api/workspace-backups/…`（S7）、`/api/project-packages/…`（V4、S5）、`package-preview`（V4）。

**错误码和 HTTP 状态**（`errors.ts`）：

```ts
export const PROJECT_ADDRESS_ERROR_STATUS: Readonly<Record<ProjectAddressErrorCode, number>>; // NOT_FOUND 404、ID_MISMATCH 400、UNAVAILABLE 409
export const PROJECT_HOST_ERROR_CODES: readonly ['PROJECT_HOST_BUSY', 'PROJECT_HOST_TRANSITION', 'PROJECT_HOST_STOPPED', 'PROJECT_LOCATION_INVALID'];
export type ProjectHostErrorCode = typeof PROJECT_HOST_ERROR_CODES[number];
export const PROJECT_HOST_ERROR_STATUS: Readonly<Record<ProjectHostErrorCode, number>>;      // 409、409、503、400
export function projectNotFound(projectId: string): AppError;
export function projectIdMismatch(projectId: string): AppError;
export function projectUnavailable(projectId: string, reason: ProjectOpenErrorCode, cause?: unknown): AppError; // PROJECT_INVALID 时把 cause 的 details.reason 放进 invalidReason
export function asProjectUnavailable(projectId: string, error: unknown): unknown;  // 内核的打开错误映射成 PROJECT_UNAVAILABLE，其余原样
export function projectHostError(code: ProjectHostErrorCode, details?: Readonly<Record<string, unknown>>): AppError;
export function projectFileMoved(projectId: string): AppError;                     // 契约的 PROJECT_FILE_MOVED，409，details 是 {projectId}
export function projectFileExists(projectFile: string): AppError;                   // 应用级新建：内核的 details 加 projectFile
export const SQLITE_READONLY_DBMOVED = 1032;
export function isDatabaseMovedError(error: unknown): boolean;                      // 错误本身或内核错误的 cause 是 1032
```

| 错误码 | HTTP | `details` | 什么时候 |
|---|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | `{projectId}` | 项目没有登记 |
| `PROJECT_ID_MISMATCH` | 400 | `{projectId}`（URL 里的 ID） | 输入里的 projectId 和 URL 的不一致，在 `rpc` 的处理里沿用 K2 的核对 |
| `PROJECT_UNAVAILABLE` | 409 | `{projectId, reason, invalidReason?}`，`reason` 是 `PROJECT_MISSING`、`PROJECT_LOCKED`、`PROJECT_FORMAT_NEWER`、`PROJECT_INVALID` 之一 | 登记了但打不开；内核的原错误放在 `cause`，带着它的 `details.reason`（例如 `read-only`）。`reason` 是 `PROJECT_INVALID` 时，这个原因也放进 `invalidReason` |
| `PROJECT_HOST_BUSY` | 409 | `{projectId}` | 独占操作等不到在途请求结束，或运行时忙；什么都没取消 |
| `PROJECT_HOST_TRANSITION` | 409 | `{projectId}` | 只给测试接口：项目正在打开、关闭或独占 |
| `PROJECT_HOST_STOPPED` | 503 | `{}` | 后端正在退出 |
| `PROJECT_LOCATION_INVALID` | 400 | `{projectFile}` | 指定的 `.mioon` 所在的文件夹不存在 |
| `PROJECT_FILE_MOVED` | 409 | `{projectId}` | 契约的码，由 `projectFileMoved` 构造：打开期间 `.mioon` 被单独改名或移动，写入被拒绝；宿主正在按新位置重开，重试即可（4.6） |

响应体照现在的 `{ok: false, error: {code, message, details, retryable: false}}`。`/api/projects/` 下解析不出来的路径、宿主不认的路径都报 404 `NOT_FOUND`。

K0 的小 PR #108 把两项收进了契约（第 7 节第 6、9 条），宿主已经跟着改了：
- `PROJECT_FILE_MOVED` 是契约的错误码（`PROJECT_FILE_ERROR_CODES`），宿主不再自己定义，也不在 `PROJECT_HOST_ERROR_CODES` 里，由 `projectFileMoved(projectId)` 构造；
- `PROJECT_UNAVAILABLE` 的 `details` 可以带 `invalidReason`（`PROJECT_INVALID_REASONS` 之一），只在 `reason` 是 `PROJECT_INVALID` 时出现。`projectUnavailable` 这时把 cause 的 `details.reason` 放进去，`asProjectUnavailable` 传的 cause 就是内核的错误；CLI、MCP 按项目 ID 访问时也能分清只读和损坏。

**P4 分派顺序**：Host 和 Origin → 令牌 → `parseProjectApiPath` → `acquire(id, 'request')`（自动打开）→ 响应 `finish/close` 释放租约（SSE 和文件流也算在途）→ `runtime.handle(request)` → 返回 `false` 时 404。处理中抛出的错误 `isDatabaseMovedError` 为真，或者是 `PROJECT_FILE_MOVED` 时，调 `lease.host.relocate()`，再照常回错误。

### 2.6 `startServer({dataDir})` 的新语义

- `dataDir` 是应用数据目录（任务卡第 3 节第 2 条），不传时按服务端的布局取默认值。可选的 `cacheDir`、`projectsDir` 由桌面主进程算好传入；测试接收选项的实际名称是 `inspectProject`（2.7）。
- 启动时依次：检查应用数据目录、取单实例锁 `server.lock`、打开应用库、建管理器、`await manager.restore()`、开始监听。除了有未完成任务的项目，启动时不打开任何项目。
- `ServerInstance.dataDir` 返回应用数据目录。`close()` 先 `manager.closeAll()`，再关应用级的资源。
- 只经接口建项目的测试（清单 7.6 里不用改的 66 个）照常可用：项目经应用级的 `project.create` 建在 `<dataDir>/projects/<项目名>/`。

### 2.7 测试辅助函数的接法（任务卡第 3 节第 13、14 条）

- **`createServerProject(dataDir)`**：
  1. `createProjectFiles({name}, {directories: serverAppDirectories(dataDir), registry: <B1 的登记表>, identity})` 建文件并登记；
  2. `openProjectStore({projectFile, locate: id => projectLocation(dirs, id)})`；
  3. 用生产共用的 `ensureProjectRow` 初始化项目行（它用 `store.projectId`）；
  4. 返回 `{projectId, store}`。调用方先 `store.close()`，再 `startServer({dataDir})`；服务端只认登记过的项目。
- **`inspectProject`**：`startServer({dataDir, inspectProject: inspect => {…}})`。服务端组装好以后，把 `manager.inspectProject` 交给这个回调。注释写明只供测试，从不来自 HTTP 或环境变量，写法照 `taskFault`、`taskGatewayV2`。语义：
  - 同步执行；宿主开着就用宿主自己的连接；
  - 没开着就由内核单独打开这个项目、执行、关掉，所以自动关闭以后测试照样能查库，查完不留锁；
  - 项目正在打开、关闭或独占时报 `PROJECT_HOST_TRANSITION`，不等待；
  - 回调是 async 函数或返回 thenable 时报 `TypeError`，不能跨 `await` 持有连接。
  - W2 先在旧服务端上定这个选项的形状；W2 定了别的写法，S0 照 W2 改。

## 3. S0 要定的事

### 3.1 文件夹名和序号（`naming.ts`、`folders.ts`）

```ts
export const PROJECT_FOLDER_NAME_MAX_BYTES = 80;
export const PROJECT_FOLDER_FALLBACK_NAME = '未命名项目';
export const PROJECT_FOLDER_MAX_SEQUENCE = 999;
export function projectFolderName(projectName: string): string;
export function numberedProjectFolderName(folderName: string, sequence: number): string;
export interface ClaimedProjectFolder {readonly folder: string; readonly name: string; readonly projectFile: string}
export function claimProjectFolder(parentDir: string, folderName: string): ClaimedProjectFolder;
```

**决定**（10-31 定）：

1. 名字按 NFC 规范化；
2. 去掉首尾的空白和点；
3. 控制字符和 `<>:"/\|?*` 换成 `-`，再去一次首尾的空白和点；
4. 最长 80 个 UTF-8 字节，按码点截断，不拆开字符；截断后再去一次首尾的空白和点；
5. 第一个点之前的部分（去掉尾部空白）是 Windows 的设备名（`CON`、`PRN`、`AUX`、`NUL`、`COM1`–`COM9`、`COM¹²³`、`LPT1`–`LPT9`、`LPT¹²³`，不分大小写）时，前面加 `_`；
6. 结果为空时用 `未命名项目`；
7. `.mioon` 和文件夹同名；
8. 重名时依次试 `名字 2`、`名字 3` …… `名字 999`，名字截短到带上序号后仍不超过 80 字节；每次用一次不递归的 `mkdir` 占位，`EEXIST` 就试下一个，999 个都占了报 `PROJECT_FILE_EXISTS`。

例子：`A/B: "C"?` → `A-B- -C--`；`CON` → `_CON`；`nul .txt` → `_nul .txt`；`...` → `未命名项目`；`影` 重复 40 次 → 前 26 个字（78 字节）；第二个 `Film` → `Film 2/Film 2.mioon`。

**理由：**

- 80 字节以内，内核建文件时的临时名 `<名字>.mioon.creating-<UUID>-journal`（多 60 字节）也在 255 字节以内；Windows 默认 260 个字符的路径里放得下两次名字。
- 以点开头的条目会被生产代码的目录列表跳过，所以去掉开头的点；Windows 会丢掉结尾的点和空格。
- `mkdir` 占位是原子的，并发新建不会撞名。APFS、NTFS 不区分大小写和 Unicode 规范形式，这类重名由文件系统自己报 `EEXIST`。
- 项目目录不是私有存储，文件夹用默认权限。

### 3.2 缓存和临时目录

**决定**（10-31 定）：见 2.1 的表。网页版和无界面服务是 `<dataDir>/cache/`、`<dataDir>/tmp/`；桌面版的应用数据目录换成新的 `<userData>/data/`，缓存在系统缓存目录下的 `<应用 ID>/`，临时目录在 `<应用数据目录>/tmp/`；设了 `MIOON_DESKTOP_USER_DATA` 时缓存和新项目都放进 `<dataDir>`。每个项目的 `tempDir` 是 `<应用临时目录>/projects/<项目 ID>/`，任务卡已按这个写法改了。

**理由：**

- 内核要求三个本机目录是私有目录、路径里没有符号链接，系统临时目录在 macOS 上经过 `/var`，会被拒绝。
- 桌面版不沿用 `<userData>/workspace/`：本机记录的文件夹以后不能搬，换名字只有切换这一次机会；旧的 `workspace/` 里还留着开发数据，分开以后不会被误读或误删。切换时改 `config.ts` 的 `dataPaths`。Electron 的 `app.getPath` 没有 `cache` 这一项，所以缓存目录按平台算。
- 覆盖 userData 的是测试和冒烟运行，不该碰真实的影片和缓存目录。
- 每个项目一个暂存子目录：图片、抽帧、拆解的暂存带着崩溃恢复用的回执（`image-storage.ts`），要跨重启保留，也不能被别的项目的清理扫掉；和缓存的 `projects/<ID>/` 对称；`tmp/` 下还能放应用级的暂存，例如留给0.1.x的S3收件箱媒体，S3-A不启用。

### 3.3 自动打开的项目什么时候关

**决定**（10-31 定）：宿主空闲时关闭。空闲指没有任何租约、没有在途请求、运行时不忙，而且宽限期已过。

- 宽限期是最后一个请求结束后 60 秒（`DEFAULT_IDLE_CLOSE_MS`），期间来的新请求重新计时。
- 释放窗口租约会取消宽限：之后只有在窗口释放以后才开始的请求，结束时才重新计宽限。
- 运行时忙时不关，每秒复查一次（`DEFAULT_BUSY_RECHECK_MS`）。
- 有 `task` 租约时不关。

**理由：** CLI、MCP、外部 agent 一条接一条地发请求，60 秒内不应反复打开；用户关窗口时要尽快放锁（Windows 上项目开着时文件夹移不动）；窗口自己最后的几个请求不该把关闭推迟 60 秒。

| 情形 | 结果 |
|---|---|
| CLI 连发请求，间隔都不到 60 秒 | 一直开着；最后一个请求结束 60 秒后关闭 |
| 关窗口，没有别的租约，运行时不忙 | 立即关闭 |
| 关窗口，还有可推进的生成任务（S3 持有 `task` 租约） | 开着；任务结束、释放租约后立即关闭 |
| 关窗口时 Mio 正在跑一轮 | 开着，每秒复查；这一轮结束后关闭 |

测试用手动时钟逐条验证（`tests/project-host-manager.test.ts`）。

### 3.4 没打开的项目的封面（P4 已接入）

- 宿主在打开时、关闭前，以及打开期间封面素材变了时，把登记摘要里 `cover` 指向的素材缩成长边 512 像素的 JPEG（视频取第 0 秒的帧），存成这个项目缓存目录里的 `cover.jpg`；旁边的 `cover.json` 记素材 ID 和素材指纹。用现有的媒体运行时生成，先写临时文件再改名。
- 应用级 `GET /api/project-covers/<id>` 只读这两个文件，不打开项目。`cover.json` 和登记摘要对不上，或者文件不在时报 404，界面显示占位图。
- 关闭前来不及生成就保留旧图，不拖慢关闭。缓存可以被系统清掉，下次打开项目时重建。封面永远不写进项目目录，打包也不带。
- 契约的 `projectSummaryCoverSchema` 要求 `url === /api/project-covers/<项目 ID>`，并与所属摘要 ID 一致；旧素材 URL 不再作为首页封面地址。

## 4. 生命周期和并发

### 4.1 同一个项目的请求怎样排队

- 不设项目级的队列。同一个项目的请求各拿一个 `request` 租约，并发执行。现在的服务就是并发处理请求；SQLite 的事务是同步回调，在同一个连接上天然串行；冲突靠修订号和幂等回执处理。
- 只有三个阶段请求要等：
  - **打开中**：第一个请求同步建条目（`opening`），同步完成内核打开，再异步组装运行时。组装期间别的请求等同一个 promise，失败时拿到同一个错误，不改写。内核打开失败是同步的，不留条目，下一个请求会重试。并发打开同一个项目只打开一次（有测试）。
  - **关闭中**：新请求等关闭完成，再按登记重新打开；登记没了就报 `PROJECT_NOT_FOUND`。契约里 `PROJECT_UNAVAILABLE` 的 `reason` 只能是四个打开错误码，“正在关闭”不是打不开，所以不报错。
  - **独占中**：等独占操作结束，见 4.2。

### 4.2 应用级操作怎样取得独占

删除、复制、改名、关闭、另存为都经 `withExclusive(projectId, run)`：

1. 同一个项目的独占操作排队，前一个结束才轮到下一个；
2. 先挡住新请求，它们等独占结束；
3. 等在途请求结束，最多 3 秒，而且运行时不忙。做不到就报 `PROJECT_HOST_BUSY`、恢复服务，不取消别人的请求，沿用现在删除闸门“只拒绝、不取消”的规则；
4. 关闭宿主，窗口和任务的租约被撤销；
5. 运行 `run`。这时本进程没开着这个项目，可以用 `fs` 移动、拷贝它的文件，不会碰到 POSIX 锁的问题。

`run` 里不能再 `acquire` 同一个项目，否则会等自己。项目开着的另一个窗口在第 4 步收到撤销（租约的 `signal` 中止），界面按 S6 的设计提示。

### 4.3 关闭时的顺序

`close`、`closeAll`、空闲关闭、独占、`relocate` 都走同一个流程：

1. 停止接收：状态改为 `closing`，发 `closing` 事件；新请求开始等待；
2. 中止宿主的信号；
3. `runtime.interrupt()`：关 SSE、中止 Mio 正在跑的轮次。SSE 不会自己结束，所以先关；
4. 等在途请求结束，最多 3 秒，超时就撤销它们的租约（租约的 `signal` 中止）。空闲关闭时本来就没有在途请求；
5. 撤销其余的租约（窗口、任务）；
6. `runtime.drain()`：停 `worker`，排空服务、编辑任务、Mio；
7. 各钩子的 `beforeClose`，倒序；V2 第一个注册、最后执行关闭备份；
8. `summarize()`、`unfinishedTasks()`，它们要读库，所以在关库之前；
9. `runtime.dispose()`；
10. `store.close()`；
11. 按文件身份更新登记：用的是关闭时的真实位置，所以在关库之后；
12. 写后台任务索引；
13. 删条目，发 `closed` 事件（带收集到的错误）。

已结束的钩子等清理错误会收集，关闭继续；**runtime.drain 失败例外**：管理器保留 closing 条目、连接和锁，不继续调用备份或关闭 store，以免迟到发布写入已关库。V2 自行记录已结束的备份错误，不阻断开关。慢备份完整等待原生结束，running/slow 可查，不用硬超时跳过关库前等待。测试按日志核对这一顺序。

### 4.4 关闭窗口后还有未完成的任务（S3）

S3-A在V2打开备份后、每日版本之前，通过固定ready接缝补登并取得自己的一条`task`租约，再激活后台恢复和worker；不在afterOpen里await同项目acquire。任务COMMIT后同步按ID更新索引和统一状态投影，真实回调/finally未结束前不释放。终态或只剩等用户/源等blocked原因时释放，blocked仍算未结束工作。原生音频等其他task租约不受影响。

重启`restore()`的租约和failures交S3；缺失、只读、被锁的项目保留blocked原因，不反复重开。P4每秒扫七表的timer已撤，改用状态通知及对已纳管ID的有界到期检查。关闭时仍取未结束快照，保留archived代际；项目提交与索引之间强退可能漏登，下次打开补登。详情及0.1.x收件箱边界见[后台任务](BACKGROUND-TASKS.md)。

`withExclusive`遇仍在用的task租约返回`PROJECT_HOST_BUSY`，不会替用户撤销。S6不接会撤销后台工作的显式关闭项目；普通窗口释放与应用退出分别沿既有流程。U2删除本机记录现在也检查未结束索引/在线工作，blocked/unknown不放行。

### 4.5 应用退出

`closeAll()` 并行关闭全部宿主，等独占操作结束，然后关应用级的资源。之后的请求报 `PROJECT_HOST_STOPPED`。

若某项目还在 afterOpen 备份，关闭先等其 opening 完成；运行中的原生备份持有源连接，不提前关库。V2 不承诺慢 I/O 下有界关闭。服务端既有 5 秒总停机预算仍可能报 `SERVER_STOP_TIMEOUT`；这不是备份取消或安全退出确认，超时不得据此关闭仍被使用的 SQLite 或释放应用锁，详见 [备份失败与慢 I/O](PROJECT-BACKUPS.md#失败慢备份和已知边界)。

### 4.6 打开期间被移动或改名

macOS、Linux 上能移；Windows 上文件被占用，移不动。

- **移动或改名项目文件夹**：S0a 让内核在打开时就把项目文件的日志开着，所以移动以后写入照常。关闭时按文件身份找到新位置，更新登记（4.3 第 11 步；有测试）。SQLite 关闭时按打开时的路径删日志，新位置会留下一个 0 字节的 `<文件名>.mioon-journal`，不是热日志，不影响下次打开。
- **只改名或单独移动 `.mioon` 文件，文件夹不动**（S0a 遗留问题第 1 条）：SQLite 的日志名跟着打开时的文件名，留在原名旁边。之后提交中途崩溃，从新名字打开时找不到这个日志，会得到半个事务。宿主要能发现这种情况，并停写、关掉、在新位置重开：
  - `checkMoved(projectId)` 检查两件事（两次 `lstat`）：打开时路径上的文件不见了或换了文件身份；原路径的 `-journal` 还在。后一条区分了移动文件夹（日志跟着走，写入安全，返回 `false`）和单独移动文件。
  - 发现以后 `relocate`：在连接上登记一个事务守卫（`registerProjectTransactionFence`），之后的 `store.tx` 一律报 `PROJECT_FILE_MOVED`；然后按 4.3 关闭（原因 `relocate`）。关闭时 SQLite 按原路径删掉那个日志，登记按文件身份改到新位置，下一个租约在新位置重开（有测试）。
  - 定为乙（第 7 节第 6 条）：内核在 `store.tx` 开头和 `put` 里做同样的两次 `lstat`，抛 `PROJECT_FILE_MOVED`；宿主收到它或 1032 都调 `relocate`。内核的检查合入以前，切换这一轮先把 `checkMoved` 登记成事务守卫顶上，合入后去掉。
- **写入遇到 errcode 1032（`SQLITE_READONLY_DBMOVED`）**：这是 S0a 预热万一失效时的退路，处理一样。分派层或运行时调 `host.relocate()` / `context.relocate()`，宿主按上面的流程关掉，下一个租约按文件身份在新位置重开。打开途中恰好被移动的，内核报 `PROJECT_INVALID`，`cause` 是 1032；`acquire` 按文件身份找一次再开。
- **打开期间项目目录里一直有 0 字节的 `<文件名>.mioon-journal`**：生产代码列项目目录时（L1 给 Mio 列目录、R3、V3 打包、宿主的 `findMoved`），除了以 `.` 开头的条目，也要跳过 `*.mioon-journal`，绝不能拷走或删除。

## 5. S0a 的内核函数怎样接进来

#106 已合入，名字以它为准。本节写宿主在什么时候调用这些内核函数：管理器已经用上 `recoverProjectFile`，分派层的接线在切换这一轮做。

| 函数或改动 | 调用时机 | 谁调 | 结果的处理 |
|---|---|---|---|
| `recoverProjectFile(projectFile)`，返回 `ProjectFileRecovery` | 启动时（`restore()`）和列最近项目时（`list()`），对每个已登记、本进程没开着、也不在独占操作中的项目调一次。打开项目本身不用先调，打开的第 1 步就是同一件事 | 管理器，经 `KernelMaintenancePort`；S6 的首页走 `list()` | `clean`、`recovered`：可用，`recovered` 发 `recovered` 事件；`locked`：别的进程正在写，不处理，打开时会报 `PROJECT_LOCKED`（12-03b）；`open-here`：当作开着；`missing`：后台按文件身份找新位置，找到改登记、在新位置再调一次，找不到按 12-03 显示；`invalid`：按 `reason` 显示，`read-only` 用只读的文案（S6）。切换时内核改成先看 `-journal`，没有热日志就直接返回 `clean`，不读项目文件的头：首页每次列项目都调它，放在 iCloud 里、已被系统移出本机的项目文件一读文件头就会被整个下载回来 |
| 清掉没用的超级日志 | 内核每次成功打开时自己做 | 内核 | 宿主不接线 |
| `isSuperJournalInUse`、`superJournalsIn` | B1 算本机记录清单的 `hasSuperJournal` | B1 | 宿主不用 |
| `read-only` 原因，`PROJECT_INVALID_REASONS` | 打开失败时 `PROJECT_INVALID` 带 `reason`，只读位置报 `read-only` | 管理器、S6 | `acquire` 映射成 `PROJECT_UNAVAILABLE`（`reason: 'PROJECT_INVALID'`），细分原因在 `cause.details.reason`，也放进 `details.invalidReason`（#108）；`openPath` 原样抛内核错误，应用级的 `project.open` 填 `projectOpenFailureSchema`，其中 `PROJECT_INVALID` 现在必填 `reason`，直接取内核的 `details.reason`，`projectFile` 由调用方补，`projectId` 取 `details.projectId`，读不出时取登记或 `null` |
| `store.tx` 改用 `BEGIN` | 不用接线。只写本机记录的提交（例如 Mio 流式输出）不再碰项目文件、不再建超级日志 | — | — |
| 打开时把项目文件的日志开着 | 不用接线。打开期间移动项目文件夹，写入照常，关闭时按文件身份更新登记（已实现） | — | — |
| 退路：写入遇到 1032 | 写入出错时 | 分派层、运行时调 `relocate()` | 见 4.6 |
| 单独改名或移动 `.mioon` | 内核在 `store.tx` 开头和 `put` 里检查，抛 `PROJECT_FILE_MOVED`（第 7 节第 6 条，定为乙）；内核的检查合入以前，宿主的 `checkMoved` 登记成事务守卫顶上 | 内核；过渡期是宿主 | 收到 `PROJECT_FILE_MOVED` 或 1032 都调 `relocate()`，见 4.6 |

#106 合入以后已改：`ports.ts` 的 `ProjectFileRecovery` 从内核导入，`reason` 是 `ProjectInvalidReason`；管理器默认用内核的 `recoverProjectFile`，只 `lstat` 的替身 `STAT_ONLY_MAINTENANCE` 删掉了。

## 6. 首次接口评审时的切换计划（历史记录）

### 6.1 要等哪些合入

#105（K0 补充）、#106（S0a）、#108（K0 小 PR）已合入 main，也已合进本分支。还要等 K2、B1、W1、W2（含 6 个测试辅助函数和旧服务端上的 `inspectProject`）、P1a-2、P1b。R1、S3、S8、V1 不用等，用 2.4 的替身。

### 6.2 步骤

1. **内核**：
   - 结构：Mock 供应商的 `mock_provider_tasks`、`mock_provider_submissions` 和它们的索引收进本机记录的任务领域（`schema/domains/tasks.ts`），提升本机记录的格式版本，用 `node tests/helpers/project-file-schema-derivation.ts --write` 重新生成清单，`tests/project-file-schema.test.ts` 记新的摘要（定下的两处之一）。推导测试改为直接调用旧的建库链，不再经 `db.ts` 的 `openStore`。
   - 单独改名或移动 `.mioon`：`store.tx` 开头和 `put` 里各做两次 `lstat`，抛 `PROJECT_FILE_MOVED`（第 7 节第 6 条）。这一项合入以前，由第 6 步的宿主守卫顶上。
   - `recoverProjectFile` 先看 `-journal`，没有热日志就直接返回 `clean`，不读项目文件的头（第 5 节）。
2. **`db.ts`**：`openStore(root)` 改由内核按测试布局打开；`registerWorkspaceTransactionFence`、`registerWorkspaceTransactionObserver` 转发到内核的 `registerProjectTransactionFence`、`registerProjectTransactionObserver`；`getWorkspaceRestoreContext`、`ownsStoreLock` 认内核的 store；`validateWorkspaceStorage` 改成应用数据目录的检查。
3. **业务模块**：
   - 按工作区角色判断功能的地方：`readCurrentWorkspaceRole`、`isWorkspaceRoleSince`、`validateFixedWorkspaceRole`，约 20 个文件 35 处，其中 `validateFixedWorkspaceRole` 有 5 个调用方；内核的连接固定当作现行格式，不再按格式 72 校验。
   - 不带库名的 `sqlite_master`、`sqlite_schema` 探测（19 个文件 25 处，其中 7 个 Mio 文件和己约好谁删），改用 `pragma_table_list` 或删掉。
   - 不带库名的 `foreign_key_check` 3 处：`agent/task-schema-v2.ts`、`project-package/document.ts`、`project-lifecycle.ts`，改用 `foreignKeyCheck` 或带库名。
   - `project-lifecycle-schema.ts` 看到 temp 里有对象就拒绝的检查，要改。
   - `image_groups.activeTaskId` 找不到对应任务时当作空闲（`images.ts`）。
   - `services.ts` 的 `project.create` 改用 `store.projectId`。
   - 清单第 3 节的 29 个用到 `store.root` 的文件逐个改到四个目录：暂存 → `tempDir`，`agent-imports` → `localDir/imports`，媒体暂时留在 `projectDir/media`。
4. **范围文件**（清点时新发现，K1 的清单只列了授权）：
   - Mio 授权改按应用库文件的身份算（定下的两处之一，`agent/authorizations.ts`）；
   - `ui-preferences.ts`、`last-project.ts` 随 B1 收进应用库；
   - 三个草稿模块在 S8 之前改按 `history.db` 算；
   - 桌面的 `window-appearance.ts`、`main.ts` 的 LUT 恢复改按应用库文件算（庚）。
5. **Mio**：放行设置由调用方传入（和己、B1 定）；`task-runtime-v2.ts`、`task-storage-v2.ts` 等处的表探测（己）。
6. **服务端组装**：
   - 新文件 `apps/server/src/project-host/compose.ts`（`composeProjectHost`），从 `composeServer` 拆出每个项目的部分；
   - `index.ts` 只留应用级的部分，接上 `createProjectHostManager`；路由按 2.5 分派，删掉 K2 保留的旧路径；
   - `startServer` 加 `cacheDir`、`projectsDir`、`projectInspection`；`/health`、`/api/workspace-info` 改成应用级；
   - 不再调用 `setProjectDeletionCompanions`；
   - 原生预听绑定一个按 projectId 分派的服务；
   - 写入出错是 1032 或 `PROJECT_FILE_MOVED` 时调 `relocate()`；内核的检查合入以前，在 `composeProjectHost` 里把 `checkMoved` 登记成事务守卫（第 7 节第 6 条）；
   - `startServer` 启动时，`dataDir` 里有旧的 `workbench.sqlite` 就报错，提示换一个目录或删掉旧文件（第 7 节第 3 条）。
7. **入口**：`cli.ts` 加 `MIOON_PROJECTS_DIR`；`backend.ts`、`supervisor.ts` 转发 `cacheDir`、`projectsDir`；`main.ts` 用 `desktopAppDirectories` 算出这两项传给后端（归庚，约好一小块；`desktop-window-ownership`、`desktop-startup-restart-race` 两个测试要为新符号加桩）；`config.ts` 的 `dataPaths` 把桌面版的应用数据目录改成新的 `<userData>/data`，旧的 `workspace/` 不迁移、不再读（第 7 节第 3 条）。
8. **测试辅助函数**：W2 的 6 个函数和 `inspectProject` 换成新内核的实现（2.7）；`tests/subtitles-recovery.test.ts` 在同一进程里开第二个 store 的写法（W2 没改的话）。
9. **验收**：类型检查；清单 7.6 里不用改的 66 个测试不改也能通过；`tests/project-host-*`；CI 全绿。

### 6.3 K1 交接的每一项落在哪一步

包括 PR #104 实验的 11 处补丁：

| K1 交接 / 实验补丁 | 下一轮的做法 | 步骤 |
|---|---|---|
| 推导测试依赖 `db.ts` 的 `openStore` | 直接调用旧的建库链，或随 S7 删 | 1 |
| Mock 的两张表（补丁 9 在内核里放过） | 收进本机记录的结构（定下的） | 1 |
| 事务守卫和观察者（补丁 1） | 转发到内核的 `registerProjectTransactionFence`、`registerProjectTransactionObserver` | 2 |
| `getWorkspaceRestoreContext`、`ownsStoreLock`（补丁 3、4） | 认内核的 store | 2 |
| 角色判断（补丁 5、7） | 内核的连接固定当作现行格式 | 3 |
| `sqlite_master` 探测（补丁 6 改写 `prepare`） | 不改写 `prepare`，逐处改用 `pragma_table_list` 或删掉 | 3、5 |
| 不带库名的 `foreign_key_check`（3 处） | 用 `foreignKeyCheck` 或带库名 | 3 |
| 每个写项目的连接都要建跨文件的临时触发器；`project-lifecycle-schema.ts` 的 temp 检查 | 只有内核开连接；改这条检查 | 3 |
| `project.create` 用 `store.projectId`（补丁 2） | 照补丁 | 3 |
| `image_groups.activeTaskId` | 找不到任务时当作空闲 | 3 |
| 授权范围（补丁 8 改成 `project.mioon`） | 改按应用库文件算（定下的） | 4 |
| 应用库替身（补丁 11 挂 `app`） | 用 B1 的应用库，放行设置由调用方传入 | 4、5 |
| `failStorage` 打诊断（补丁 10） | 不要 | — |
| 过程实体的目标修订在项目文件 | R1 定；S0 照现在 | — |
| `setProjectDeletionCompanions` 读不再建的表 | 不再调用，删除改由 S5 经 `withExclusive` | 6 |
| 打开失败的详情填 `projectOpenFailureSchema` | `project.open` 用 `openPath` 的错误加 `projectFile`；`PROJECT_INVALID` 带 `reason`（S0a） | 6 |
| `BEGIN IMMEDIATE` 留给 S0 定 | S0a 已改成 `BEGIN` | — |
| 测试布局多出 `.mioon-store/` 和 0 字节的日志 | 测试用 `isProjectStoreInternalEntry` | 8 |
| 同一进程第二次打开报 `PROJECT_LOCKED` | 测试先 `close()`，或放进子进程 | 8 |
| 打开期间移动、崩溃后没在本机恢复就被拷走 | S0a 的预热和 `recoverProjectFile`，接法见第 5 节；单独改名 `.mioon` 见 4.6 | 5 节 |

## 7. 协调人的决定（10-31）

下面是当初提的 10 件事，都已定下：第 3 条改了桌面版的应用数据目录，第 6 条定为乙，其余照提案。每条末尾的“定的”是结果。

1. **自动关闭的策略**（3.3）：空闲（没有租约、没有在途请求、运行时不忙）而且宽限期已过就关；宽限期是最后一个请求结束后 60 秒；关窗口取消宽限、空闲即关；有未完成的后台任务（`task` 租约）或 Mio 正在跑时不关。**定的：** 照提案。
2. **文件夹命名**（3.1）：NFC；控制字符和 `<>:"/\|?*` 换成 `-`；去掉首尾的空白和点；Windows 设备名前加 `_`；最长 80 个 UTF-8 字节；空名用 `未命名项目`；重名依次加 ` 2` 到 ` 999`；`.mioon` 和文件夹同名。**定的：** 照提案。
3. **目录的取法**（2.1、3.2）：网页版和无界面服务是 `<dataDir>/{projects,records,cache,tmp}`；桌面版的应用数据目录沿用 `dataPaths().dataDir`（`<userData>/workspace`，`records/`、`tmp/` 在它下面），缓存在系统缓存目录下的 `<应用 ID>/`，新项目默认放在 `<videos>/Mioon/`；覆盖 userData 时缓存和项目都放进 `<dataDir>`；每个项目的 `tempDir` 是 `<tmp>/projects/<ID>/`。如果要给桌面版的应用数据目录换一个不带“工作区”的名字，只能在 S0 切换时改一次 `dataPaths`，之后本机记录就不能再搬。**定的：** 桌面版的应用数据目录换成新的 `<userData>/data/`，不沿用 `<userData>/workspace/`，旧的 `workspace/` 不迁移、不再读，S0 切换时改 `dataPaths`；网页版和无界面服务的 `dataDir` 里有旧的 `workbench.sqlite` 时，启动报错。其余照提案。
4. **端口的形状**（2.4）：登记表同步，只有 `findMoved` 是 async；放行设置是存储端口，由调用方交给 Mio；Mio 授权按应用库文件的身份算范围；S3 用 `task` 租约，加上关闭时写索引；V1、V2 用 `afterOpen`、`beforeClose` 钩子；S8 和 R1 都是每个宿主一份的工厂；`list()` 带上 S0a 恢复的结果（`ProjectAvailability`）。**定的：** 照提案。
5. **封面提案**（3.4）：宿主把封面缩成长边 512 像素的 JPEG，存在项目的缓存目录（`cover.jpg` 加 `cover.json`）；应用级的封面接口只读这两个文件、不打开项目，没有就 404、显示占位图；接口名和 S6 一起定。**定的：** 照提案，接口名由 S6、B1 定。
6. **打开期间单独改名或移动 `.mioon` 的检测**（4.6，S0a 遗留问题第 1 条）。两种做法，发现以后的处理一样（停写、关掉、按文件身份找到新位置、重开，即宿主的 `relocate`）：
   - **甲，由宿主检测**：下一轮在 `composeProjectHost` 里把 `checkMoved` 登记成连接的事务守卫，每次 `store.tx` 开头做两次 `lstat`；也可以在分派每个请求之前调。内核不用改。只保护宿主开着的 store；事务之外的 `put` 不经过守卫。
   - **乙，由内核在 `store.tx` 开头检查**：同样两次 `lstat`（微秒级），发现就抛错（建议沿用 `PROJECT_FILE_MOVED` 这个码），`put` 也检查。宿主只处理这一个错误和 1032，都调 `relocate`。内核本来就记着打开时的路径和文件身份，所有经内核的 store 都受保护，包括测试和以后的工具。代价是改变内核的写入行为。
   - **建议乙**：风险来自 SQLite 按打开时的路径给日志命名，是内核这一层的性质，放在写入发生的地方检查，所有调用方都覆盖，宿主也只需要一条处理路径。乙合入之前，下一轮先按甲把 `checkMoved` 登记成守卫，乙合入后去掉。
   - **定的：** 乙。内核的检查合入以前，宿主先按甲顶上。错误码用 `PROJECT_FILE_MOVED`，由 K0 的小 PR #108 收进契约。
7. **按 `workbench.sqlite` 算范围的模块共 8 处**（第 1 节），不止 Mio 授权：应用级的（授权、界面偏好、上次项目、桌面窗口外观、桌面 LUT 恢复）建议都改按应用库文件算；三个草稿模块在 S8 之前改按 `history.db` 算。**定的：** 照提案。
8. **清单第 2 节漏列的路由的归属**（2.5）：`/api/tasks…`（编辑任务）为项目级；`/api/workspace-preferences/<id>`、`/api/agent/tasks/v2/policy`、`/policy/requests/<id>`、`/diagnostics/latest` 为应用级；`/api/agent/diagnostics?projectId=` 留在应用级，存储统计只在项目开着时给；`/api/projects/<id>/package-preview` 随 V4 删除。**定的：** 照提案。`/api/tasks…` 归 K2，新地址保留 `/api/` 之后的部分，即 `/api/projects/<id>/tasks…`。
9. **`PROJECT_UNAVAILABLE` 要不要带内核的细分原因**：S0a 以后只读位置报 `PROJECT_INVALID`、`reason: 'read-only'`，界面要换文案；但契约里 `PROJECT_UNAVAILABLE` 的 `details` 是严格的 `{projectId, reason}`，按项目 ID 访问（CLI、MCP、外部 agent）时只能看到 `PROJECT_INVALID`。建议 K0 给它加一个可选的 `invalidReason`（`PROJECT_INVALID_REASONS` 之一），只在 `reason` 是 `PROJECT_INVALID` 时出现。首页走 `list()`，已经带着 `reason`。**定的：** 加，由 K0 的小 PR #108 收进契约，S0 切换以前合入。
10. **桌面主进程要多传两项给后端**（`cacheDir`、`projectsDir`）：`main.ts` 归庚，需要约一小块改动。**定的：** 照提案。
