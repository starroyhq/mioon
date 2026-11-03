# 素材引用：S1

项目资产只有引用一种定位方式。路径导入不复制；网页上传先暂存，再排他发布到固定的 `素材/`。项目格式为 2，旧格式明确拒绝打开、零写入；旧开发项目需要重建，不做转换。cache v2 不匹配时只重建缓存，history 沿 V1-A 的 6。本卡不修改 Mio 工具目录、请求指纹和 agent 运行时。

直接打开旧格式时，内核返回 `PROJECT_INVALID`（422），`details.reason` 为 `schema-version`。通过项目 ID 打开时，宿主返回 `PROJECT_UNAVAILABLE`（409），`details.reason` 为 `PROJECT_INVALID`、`invalidReason` 为 `schema-version`。

## 共享契约

领域契约独立定义；根契约只复用现有导入 schema 和公共投影：

| 文件 | 内容 |
|---|---|
| `packages/contracts/src/media-reference.ts` | 原有引用/指纹，加统一的 `MediaStatusReason`、`MediaStatusView` 与校验 schema。网页和 L1 使用同一份定义。 |
| `packages/contracts/src/media-reference-errors.ts` | 原 L1 错误定义及公开素材错误的窄投影。 |
| `packages/contracts/src/asset-media.ts` | 引用资产记录、无路径的公共 DTO、状态/位置 DTO、导入 union、素材操作的独立 schema 与公开投影。不扩 Mio 工具目录。 |
| `packages/contracts/src/public-operations.ts` | 公共操作与描述的单一权威目录。客户端直接导出同一对象，HTTP/CLI/MCP 共享公共输入，不在客户端另拼目录。 |

`asset-generation.ts` 提供公共客户端的导入 union 和可选 `referenceRevisions`。固定 Mio 模型目录仍使用原有输入定义，模型不能传任意本机路径或目录确认；`modelOperationDefinition` 和生成器的只读 `--check` 核对其固定 schema。两套入口最终都经过业务层的引用、权限和完整哈希冻结。

资产记录的唯一定位来源是 `reference`。`referenceRevision` 表示登记引用的修订；`sha256` 只表示完整哈希，可以是 `null`，有值必须等于 `reference.fullSha256`。抽样哈希不能用来填完整哈希字段。大小也必须和引用一致。

公共资产 DTO 包含无路径的指纹、`hashState`、修订号和按项目/素材 ID 构造的媒体 URL。URL 不是可用性证明；真实读取仍须检查状态和权限。文件位置另用受信本机界面的专用 DTO，不把引用路径、绝对文件位置或 `file://` 地址发给模型。通用 `publicValue` 将实际资产投影成此 DTO；冻结参考只公开无路径指纹及原有角色、哈希与修订。内部 `producer` 不能进入普通资产结果。

`MediaStatusView` 同时给出 `status/reason/outside/readable`。项目外文件即使是 `online/same-stats`，未确认时也不可读；只有 mtime 变且尚未获准读取时是 `changed/unverified`。U1 的两种待确认显示继续保留。

## 真实路径与确认范围

可搬运引用的纯路径匹配保留原 NFC 兼容规则。真实文件的项目内外判断、授权、列表遍历和引用路径生成使用单独的真实路径规则：POSIX 上不同的 NFC/NFD 名称不互相授权，也不把引用写到另一个目录。Windows 的平台路径比较不把 Unicode 规范化当文件身份；读取仍有 realpath、lstat 和句柄验证。

确认按项目和**实际文件所在目录本身**生效，不包括子目录。`isFileInDirectory` 等真实目录函数接收已经解析的实际路径；不能拿显示路径或可搬运路径的模糊匹配来做授权。应用库的许可在每次效果围栏重查，撤销后旧服务对象不能继续使用缓存许可。

授权接线：桌面系统选择或 Finder/资源管理器真实拖入算主动确认，在同次导入登记目录；CLI 必须显式参数并逐项打印。MCP、Mio 和任何模型输入永远不能确认目录。外来项目的引用不携带本机许可。L1 引用服务只借用可信宿主注入的 B1 读取端口，不提供确认写入方法；确认写入由专用受信用户操作入口承担。

普通素材写操作（包括只写私有预览 token 的操作）使用应用写入守卫。受信路径导入、目录确认和撤销在请求解析后调用同一 `project.services.assertMutationAllowed()`；所有者中止或原 B1 关闭后被新所有者重开，旧能力不能写入项目或应用库。位置列表读取不要求写入许可。

## L1 安全读取

实际读取先验证引用、realpath、文件类型、保护名称、身份和权限，再打开媒体。项目文件、journal/超级日志、隐藏内部目录，以及本进程持有的项目/history/cache/app 数据库身份都不得打开；硬链接和改名不能绕过身份保护。

`isHeld` 必须组合 `isProjectFileHeld(identity) || isAppLibraryHeld(identity)`。本进程用 fs 打开再关闭持锁的数据库会释放 POSIX SQLite 锁，因此拦截必须发生在媒体 open 之前，不能先试读后判断。

安全字节读取有显式大小上限、取消、效果围栏和完整哈希；保留媒体头、NOFOLLOW/NONBLOCK 与读取前后的句柄身份检查。`beforeEffect` 的失败直接返回，不被媒体错误吞掉。完整哈希不匹配时是变化，不能用新结果更新旧确认。已有完整哈希的重新指向也必须核对整个文件，不能因大小、mtime 或抽样相同就冒认原内容。

仅靠 pathname 向外部解码器传文件不是同用户恶意替换下的沙箱；后续调用方仍需保留原 spawn/effect 围栏、读取预算及完整字节验证。

## 项目引用服务

`packages/business/src/project-asset-references.ts` 的 `createProjectAssetReferenceServices` 只接受精确、存活的内核 store；复制 store 字段、相同 root 字符串、已关闭对象都不能制造能力。outsidePaths 由可信宿主提供，绝不能来自 HTTP 输入或项目文件。

| 方法 | 行为 |
|---|---|
| `inspect(assetId)` | 有界验证资产归属和引用，返回三状态、可读性、修订和指纹 token。 |
| `location(assetId)` / `locations()` | 受信本机界面的文件位置/项目外目录；不写许可或读取未确认内容。 |
| `resolve(assetId)` | 只接受在线可读媒体，返回经过 L1 admission 的实际源。 |
| `prepareFullHash(assetId)` | 事务外完整哈希，返回候选引用与捕获的修订；不改数据库。 |
| `read(assetId, {maxBytes, ...})` | 有界读取并验证完整哈希，可额外指定预期 SHA256。 |
| `referenceForImport(file)` | 为导入准备引用：图片/音频完整哈希，视频采样；不导入、不复制、不登记许可。导入 handler 另外探测真实解码流并核对读前后身份。 |

资产读取验证 SQL 与 JSON 的 id/projectId、引用修订、大小及完整哈希一致性。跨项目资产返回 `NOT_FOUND`。不回退到旧 `relativePath`，也不把普通结构相似的对象当引用资产。文件 I/O 的 await 前后重新核对存活 owner、资产行与许可，防止用过期结果继续执行。

`prepareFullHash` 只产生候选和证明。调用方必须在短事务内 CAS 原资产修订/内容后才保存引用或冻结任务，不能在 SQLite 事务中等待文件哈希，也不能把一次 prepare 当长期可用的读取许可。

惰性完整哈希由内核专用 `commitProjectAssetHash` 回写：只接受精确存活 owner 和原始 JSON CAS，只能补 `null` 完整哈希或在完整哈希不变时更新观测 mtime；路径、大小、采样、引用修订及其他业务字段不能改变。它仍执行文件移动、取消、效果和全部事务围栏，但不触发领域变更观察器，避免把准备哈希当作业务 ACK。项目 contentSequence 仍递增；资产目标修订只对这种严格匹配的派生更新保持不变，名称、来源、定位或内容身份变化照常使旧批准失效。

缓存指纹 token 带算法版本，来自 size/mtime/sample；不含路径、卷名或惰性补算的 fullHash。相同内容换位置不必失效，mtime 变化保守失效；精确执行仍额外核对完整哈希。waveform_cache 与 previs_thumbnails 均绑定服务端指纹；命中和异步发布前检查状态、许可和依赖。封面同样绑定指纹，首页仍只读缓存、不 acquire 项目。

## 错误

原 L1 低层错误码、中文文案和状态码保持：

| 素材不可用码 | HTTP | 公开 reason |
|---|---|---|
| `MEDIA_MISSING` | 404 | not-found/no-access/not-a-file/not-downloaded/other-platform/project-directory |
| `MEDIA_CHANGED` | 409 | size/content/not-media |
| `MEDIA_NOT_MEDIA` | 415 | protected/extension/not-a-file/content |
| `MEDIA_OUTSIDE_NOT_CONFIRMED` | 403 | null |
| `MEDIA_CHANGED_DURING_READ` | 409 | null |

资产边界通过 `mediaUnavailableError` 只生成 `{assetId, reason}`，不转发 fs 错误的路径/其他 details。后两种原 L1 没有细分 reason，所以用 null，不发明新原因。`MEDIA_REFERENCE_INVALID` 和 `MEDIA_LIST_PATH_INVALID` 仍用于引用/列表参数错误。素材 GET/HEAD/Range 使用这套错误，并在响应读取期间重查权限及身份；响应为 no-store。`FILE_UNAVAILABLE` 仅用于非素材文件。付费派发保持原 REFERENCE_CHANGED 语义和零提交断言，不能把字节变化当新确认。

## 导入、业务冻结和后续 S2

独立 `assetImportSchema` 为互斥 union：路径分支 `{projectId, requestId, sourcePath, name?}`，上传分支保留 `{projectId, name, mimeType, dataBase64}`、30 MiB 解码上限，另可给 requestId。带 key 的相同规范化输入只能重放原资产，同 key 不同输入冲突；无 key 上传仍是原来的每次新导入。路径 key 重放不重新读取源文件；上传同 key 不复制第二份。私有 temp 回执保留失败的未发布目标，重试使用新名字，绝不覆盖或删除项目文件。丢失本机回执后残留文件可能作为普通未引用媒体出现，不能当已完成产物。

`assetMediaSchemas` 的状态/位置/准备/重新指向输入与 `trustedAssetMediaLocationSchemas` 的确认写入输入分开。schema 校验成功不授予许可；后者绝不能随普通 MCP 操作发现而开放。受信路由绑定现有认证、来源检查和项目作用域；意图 header 本身不是授权。桌面主进程只接受真实选择/拖放所产生的不透明 token，模型输入不能制造它。

网页上传和 Mio 已选附件转成的素材放固定 `素材/`，宿主不再预先创建私有 media/。当前生成/导出产物保留原输出目录，由写端登记引用；S2 再切目录。导入回执放 temp，引用变更复用现有幂等记录，不新增 history 表。仅待 S7 删除的显式旧 workspace 内部路径保留旧严格私有格式，新项目没有旧路径 fallback。

图片和音频在导入时已有 fullHash；网页付费确认检查在线/可读/登记一致并绑定 referenceRevision。Mio 不增加钩子：现有批准没有普遍绑定嵌套参考素材的修订，业务 `generation.submit` 在异步状态检查后、短事务内冻结 fullHash+referenceRevision；有网页确认时核对完整有序清单，无此字段时仍由业务立即冻结。派发时完整重算，字节或引用变更在 POST 前拒绝，不能刷新旧快照。视频强操作先 prepare，再短事务 CAS；纯历史读取不触盘。

S2 再将生成/抽帧/拆解/预演输出写 `生成/`，成片写 `导出/`，用 temp 中的回执进行排他发布和崩溃恢复。严格不自动删除项目文件：跨盘中断的 partial 保留、标未发布、重试换名。换机器丢失本机回执后，它可能显示为普通未引用媒体；不能自动当成成功产物。手动清理、S3 调度、S6/U2 完整界面、V3 打包与 R3 工作目录都在后续卡。

## 复制和恢复

V2/S5 复制不复制媒体，只按真实路径重定位 reference；真实路径不做 NFC 或大小写折叠。恢复到新项目 ID 时，仅转移原项目根目录和原项目已确认目录的既有同意，不含子目录、不新增目录。回执在授予前先记录消费，撤销后的重放不能重新授予；该崩溃窗口可能少转移，用户可以再次明确确认。源项目的嵌套目录若不在精确许可中，恢复后保持未确认。

生成和导出资产内部带 producer（kind/id），读端同时核对原 job/export、字节哈希及引用修订，不能用同项目同字节的另一产物冒领。桌面导出描述携带无路径指纹和来源证明，原生打开前复核实际媒体并再次读取描述。

H3 的既有产物检查仍要求原成片文件名。本轮只在严格核对实际引用、同项目导出和 producer 后，为该内部观察器提供不可枚举的真实路径投影，不持久化第二份定位字段。导出被同内容重连到外部或改名后，素材状态和实际读取仍正常；旧 H3 检查会保守报产物不可用。任意引用位置的 H3 检查接线留给后续 checker 负责人，不改本轮禁改的 agent 文件。
