# 素材引用：S1 基础接口

本次只加入共享契约、L1 安全读取和项目引用服务，供后续完整 S1 接线。现有 `asset.import`、HTTP/CLI/MCP 操作目录、项目格式与缓存格式都没有切换；不能通过现有 RPC 调用下文的新操作。Mio 工具、请求指纹和 agent 运行时保持原样。

## 共享契约

按文件路径导入，不经过 `contracts/src/index.ts`：

| 文件 | 内容 |
|---|---|
| `packages/contracts/src/media-reference.ts` | 原有引用/指纹，加统一的 `MediaStatusReason`、`MediaStatusView` 与校验 schema。网页和 L1 使用同一份定义。 |
| `packages/contracts/src/media-reference-errors.ts` | 原 L1 错误定义及公开素材错误的窄投影。 |
| `packages/contracts/src/asset-media.ts` | 引用资产记录、无路径的公共 DTO、状态/位置 DTO、后续导入和素材操作的独立 schema。此文件不注册操作。 |

资产记录的唯一定位来源是 `reference`。`referenceRevision` 表示登记引用的修订；`sha256` 只表示完整哈希，可以是 `null`，有值必须等于 `reference.fullSha256`。抽样哈希不能用来填完整哈希字段。大小也必须和引用一致。

公共资产 DTO 包含无路径的指纹、`hashState`、修订号和按项目/素材 ID 构造的媒体 URL。URL 不是可用性证明；真实读取仍须检查状态和权限。文件位置另用受信本机界面的专用 DTO，不把引用路径、绝对文件位置或 `file://` 地址发给模型。基础接口不会改变现有通用 `publicValue` 的路径脱敏。

`MediaStatusView` 同时给出 `status/reason/outside/readable`。项目外文件即使是 `online/same-stats`，未确认时也不可读；只有 mtime 变且尚未获准读取时是 `changed/unverified`。U1 的两种待确认显示继续保留。

## 真实路径与确认范围

可搬运引用的纯路径匹配保留原 NFC 兼容规则。真实文件的项目内外判断、授权、列表遍历和引用路径生成使用单独的真实路径规则：POSIX 上不同的 NFC/NFD 名称不互相授权，也不把引用写到另一个目录。Windows 的平台路径比较不把 Unicode 规范化当文件身份；读取仍有 realpath、lstat 和句柄验证。

确认按项目和**实际文件所在目录本身**生效，不包括子目录。`isFileInDirectory` 等真实目录函数接收已经解析的实际路径；不能拿显示路径或可搬运路径的模糊匹配来做授权。应用库的许可在每次效果围栏重查，撤销后旧服务对象不能继续使用缓存许可。

完整 S1 的授权接线已定：桌面系统选择或 Finder/资源管理器真实拖入算主动确认，在同次导入登记目录；CLI 必须显式参数并逐项打印。MCP、Mio 和任何模型输入永远不能确认目录。外来项目的引用不携带本机许可。基础引用服务只借用可信宿主注入的 B1 读取端口，不提供确认写入方法。

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
| `referenceForImport(file)` | 为未来导入准备引用：图片/音频完整哈希，视频采样；不导入、不复制、不登记许可。后续 handler 仍须探测真实解码流。 |

资产读取验证 SQL 与 JSON 的 id/projectId、引用修订、大小及完整哈希一致性。跨项目资产返回 `NOT_FOUND`。不回退到旧 `relativePath`，也不把普通结构相似的对象当引用资产。文件 I/O 的 await 前后重新核对存活 owner、资产行与许可，防止用过期结果继续执行。

`prepareFullHash` 只产生候选和证明。完整 S1 的调用方必须在短事务内 CAS 原资产修订/内容后才保存引用或冻结任务，不能在 SQLite 事务中等待文件哈希，也不能把一次 prepare 当长期可用的读取许可。

缓存指纹 token 带算法版本，来自 size/mtime/sample；不含路径、卷名或惰性补算的 fullHash。相同内容换位置不必失效，mtime 变化保守失效；精确执行仍额外核对完整哈希。基础 PR 不改两张缓存表或启用新 token 的生产索引。

## 错误

原 L1 低层错误码、中文文案和状态码保持：

| 素材不可用码 | HTTP | 公开 reason |
|---|---|---|
| `MEDIA_MISSING` | 404 | not-found/no-access/not-a-file/not-downloaded/other-platform/project-directory |
| `MEDIA_CHANGED` | 409 | size/content/not-media |
| `MEDIA_NOT_MEDIA` | 415 | protected/extension/not-a-file/content |
| `MEDIA_OUTSIDE_NOT_CONFIRMED` | 403 | null |
| `MEDIA_CHANGED_DURING_READ` | 409 | null |

资产边界通过 `mediaUnavailableError` 只生成 `{assetId, reason}`，不转发 fs 错误的路径/其他 details。后两种原 L1 没有细分 reason，所以用 null，不发明新原因。`MEDIA_REFERENCE_INVALID` 和 `MEDIA_LIST_PATH_INVALID` 仍用于引用/列表参数错误。基础 PR 没有改现有媒体 GET 的错误输出；完整 S1 接线时再统一这些公开错误，`FILE_UNAVAILABLE` 仅用于非素材文件。

## 后续完整 S1 和 S2

独立 `assetImportSchema` 为互斥 union：路径分支 `{projectId, requestId, sourcePath, name?}`，上传分支保留 `{projectId, name, mimeType, dataBase64}`、30 MiB 解码上限，另可给 requestId。带 key 的相同规范化输入只能重放原资产，同 key 不同输入冲突；无 key 上传仍是原来的每次新导入。基础 PR 仅定义契约，尚未实现新导入幂等或改变现有上传行为。

`assetMediaSchemas` 的状态/位置/准备/重新指向输入与 `trustedAssetMediaLocationSchemas` 的确认写入输入分开。schema 校验成功不授予许可；后者绝不能随普通 MCP 操作发现而开放。后续 handler 还需绑定真实用户操作及项目/目录 token。

完整 S1 将网页上传和 Mio 已选附件转成的素材放固定 `素材/`，移除私有 media/ 创建，启用引用资产。项目格式从 1 升到 2（和 B 线合并顺序协调编号），旧开发项目明确拒绝、零写入，不转换；需要重建。缓存 v1→v2 可重建，不新增 history 表。这些版本变化均未在基础 PR 启用。

图片和音频在导入时已有 fullHash；网页付费确认检查在线/可读/登记一致并绑定 referenceRevision。Mio 不增加钩子：现有批准没有普遍绑定嵌套参考素材的修订，完整 S1 应按审定方案在业务 `generation.submit` 立即冻结 fullHash+referenceRevision；派发时仍完整重算、POST 前拒绝变化。基础 PR 不改生产生成行为。

S2 再将生成/抽帧/拆解/预演输出写 `生成/`，成片写 `导出/`，用 temp 中的回执进行排他发布和崩溃恢复。严格不自动删除项目文件：跨盘中断的 partial 保留、标未发布、重试换名。换机器丢失本机回执后，它可能显示为普通未引用媒体；不能自动当成成功产物。手动清理、S3 调度、S6/U2 完整界面、V3 打包与 R3 工作目录都在后续卡。
