# 本机项目版本

版本领域提供手动保存、自动保存、分页列表、只读预览和确认恢复。版本正文保存在该项目的本机 `history.db`，不放进 `.mioon`，不随发送项目文件自动携带。本文记录实现边界，验证与发布状态以对应 PR 为准。

宿主预览返回 `restoreAvailable:true`；恢复必须提交完整摘要与当前内容序号。版本界面仍属于 U2。自动保存和恢复只使用当前项目宿主的真实连接，不重新启动已完成的任务。

## 快照格式与封闭台账

`project-versions/document.ts` 定义独立 `snapshotProfileVersion:1`，不沿用旧交换格式，不依赖 `project-package/`。正文记录项目 ID、项目格式版本、内容序号证据、修订账本证据，以及下列完整内容行：

| 收入内容快照的表 | 内容 |
| --- | --- |
| `projects`、`assets`、`shots`、`nodes`、`edges` | 项目资料、素材行、镜头、画布和关系 |
| `asset_annotations`、`asset_dispositions`、`asset_ranges` | 素材标注、处置和范围 |
| `versions`、`timelines` | 生成结果与时间线；这里的 versions 是内容表，不是本机版本领域 |
| `subjects`、`subject_versions`、`subject_bindings` | 主体、主体版本与绑定墓碑 |
| `image_groups`、`image_versions`、`scene_results` | 图像组、图像结果和场景结果 |
| `project_lut_resources` | 项目内嵌 LUT，包含其 BLOB 内容 |

共 17 张内容表。以下 3 张表明确归为内核证据，不是恢复目标：

| 表 | 使用方式 |
| --- | --- |
| `schema_version` | 以当前项目格式版本作证据，不保存为可回写的旧格式行 |
| `project_file` | 以真实 projectId 和 contentSequence 作证据，不倒退内容序号或改项目身份 |
| `agent_task_target_revisions_v2` | 记录目标修订证据；恢复推进当前修订，不能写回旧账本 |

该台账是显式封闭清单，实际项目库出现未分类的新表或不匹配的列结构时拒绝拍摄，测试也会失败。不是从收集器的当前输出反推“所有表都已覆盖”。

收集保留真实实体 ID、出处 ID、隐藏和墓碑行、没有本机 job 的生成结果，不按当前可见集合过滤。history 的任务、Mio 对话/变化、请求回执、草稿、主体变体批次撤回等过程状态，以及应用库和 cache，都不进入内容快照。

素材只保存当前素材行里的引用、指纹和元数据，不读取外部媒体字节。内嵌 LUT BLOB 本身属于项目内容。采集使用宿主持有的原始连接和同步事务，不重新打开源文件。

## 规范编码与容量

对象键使用固定顺序，用户字符串和业务数组顺序不变；内容行按其稳定主键排序。JSON 列解析后规范化，SQLite BLOB 显式编码为 base64，超出 JavaScript 安全整数范围的整数使用带类型的十进制表示。歧义的重复 JSON 键、非法值、归属不一致、重复主键或约束/FK 不合法的文档会拒绝。

补回行使用规范化 JSON 文本。主体归属及未 pin 的生成参考清单按结构和值严格比较，不依赖对象键的存储顺序；字段、数组顺序和内容哈希仍必须一致。

规范文档的 UTF-8 字节计算 SHA-256，使用 `gzip` level 1，记录 profile、codec、原文长度、压缩长度和正文。版本名称、版本 ID、保存时间不进入正文；完全相同的规范文档共用 blob，不同手动请求仍保存为不同版本记录。内容序号和修订证据仍属于文档，不能把不同证据误认为同一正文。

常量在 `project-versions/limits.ts`：

- 规范原文最多 **128 MiB**；压缩正文最多 **64 MiB**。超限整次拒绝，不截断，不删手动版本腾空间。
- 原先 64 MiB 原文提案不足以容纳合法的 64 MiB LUT 总量：base64 会膨胀。合法最大 LUT 组合加普通内容的校准测试测得原文 `89,596,888` 字节，约 89.6 MB，因而核定为 128 MiB；它不是无限容量承诺。
- 解压先设置输出上限，再核对长度、SHA-256、严格 UTF-8、规范 JSON、profile、项目格式、完整行结构和约束。未知 profile、损坏、截断或压缩炸弹均拒绝，不能靠正文声明放大解压额度。

## 本机领域与保存事务

`project-file/schema/domains/versions.ts` 定义独立领域，不占用内容库中生成视频的 `versions` 表名：

| 本机表 | 用途 |
| --- | --- |
| `project_versions` | 不可变版本摘要、正文哈希、内容序号及保存时 Mio change 的 rowid 边界；按项目/时间/ID 分页 |
| `project_version_blobs` | 规范正文去重、长度与 profile 元数据、gzip BLOB |
| `project_version_requests` | 输入 digest 和稳定的完整保存回执；同请求不得换输入 |
| `project_version_capture_marks` | Mio 每轮和本地日历日期/时区的持久化去重标记 |

公开保存只能产生 `manual` 版本，不能指定 trigger、mioRunId 或任意 snapshot。事务内先检查旧请求，再采集和编码当前内容、保存正文和版本、记录回执；任何失败一起回滚。手动保存不改变项目内容序号、业务修订或内容行。

同 projectId/requestId 和相同输入重放原始回执，即使当前内容后来已改变；同 requestId 换名称等输入报 `REQUEST_ID_REUSED`。相同内容使用新 requestId 仍创建另一条手动版本。已存在的 blob 在复用前会校验，不接受损坏正文冒充去重命中。

正文、版本和回执有不可变/拒绝 REPLACE 约束；手动版本有保留保护。没有公开的任意删除入口；可信自动保存事务按保留规则清理。history 的目标版本由 `HISTORY_SCHEMA_VERSION` 决定，不在本文写死数字；V1-A 接在 R2 后新增领域，必须以精确历史清单完成窄升级。旧 2–5 到新终点的实际验收结果见本 PR，不以计划代替已通过的升级测试。

## 预览、来源与保持当前

预览在同一项目连接的事务里读取旧文档和当前内容，只生成差异数据，不写内容、回执或 Mio 标记。每条包含 `table`、稳定 `key`、动作、变动字段、来源和保持原因，不返回原始 SQL、媒体字节或 history 过程正文。

对外预览额外返回可选的 `reasonCode`，供界面映射四语原因；未知或缺少原因码时显示通用说明与代码，不直接显示服务端 `reason`。原因码只在预览响应投影中添加，不参与内部差异、`previewDigest` 或恢复 ACK，已有摘要与回执不改写。

- 以“快照目标”和“当前状态”比较，忽略纯 `revision`/`updatedAt` 的显示差异；`add/remove/change` 的方向表示将来回到所选版本需要的动作。
- 快照以后 Mio change 记录涉及的目标标 `source:'mio'`；其余标 `source:'user-or-other'`，含义是“你或其他来源改的”，不宣称能证明纯手动归因。
- 预览考虑删除、墓碑、不可变结果、图像组只前进的 head，以及当前本机过程/缓存仍引用的 owner。不能删的对象逐个列为 `keep-current`，必须有原因；引用依赖按闭包计算，不能只保留一层 owner。
- 没有时间线的版本不能删除仍被本机编辑历史、游标或请求回执引用的当前时间线，预览会明确列为 `keep-current`，保留原聚合和回执。没有这些引用时仍按版本删除时间线。实际恢复时间线仍写编辑历史并锁定输出规格；仅保留当前的候选不伪造恢复历史，也不改变原有资格。
- 同 ID 的不可变内容不同，或者保留当前内容与快照的组合违反引用/唯一性约束时，整次拒绝预览，不给出看似可执行的部分计划。
- `totalChanges` 是完整差异总数，`keptCurrentCount` 是其中保持当前的数量；页面只返回最多 100 条。`previewDigest` 绑定整份当前文档、所选正文和完整差异，不能只对当前页签名。
- 列表游标绑定项目、页大小和时间/ID 锚点；预览游标还绑定版本、完整 digest 和偏移。后续内容变化会使原预览分页失效；游标由本进程签名，重启后旧游标失效，调用方重新读首页。

## 确认恢复与自动保存

`project.version.restore` 同时验证 `expectedContentSequence`、`expectedContentToken` 与完整 `previewDigest`。预览返回当前 `contentSequence` 和 `contentToken`，摘要也绑定令牌；同序号但不同令牌的副本会使旧确认和分页失效。成功回执返回实际提交后的 pair，恢复不写回快照旧序号或令牌。宿主拒绝尚有工作、未知提交结果或在途内容请求的项目；随后在原连接的同步事务里重新核对基线、保存恢复前版本、应用预览计划、写完整原始回执。内容和目标修订只向前推进。任一步失败，内容、恢复前版本、回执、清理均回滚。

可变状态恢复到快照；快照以后新增的对象按删除、墓碑、保持当前的顺序处理。保留对象的依赖闭包不能丢失。`keep-current` 项与原因原样写进成功回执，不是部分失败。不可变结果不覆盖；缺失的历史结果可在事务内按经校验计划精确补回，不伪造 job、不关闭 FK 或删除本机过程记录。时间线经领域入口追加手动历史，保留正常 undo/redo；不相关子目标保持其当前 JSON 表示和修订。

现存素材保留这台机器上的当前定位及其配套身份信息，包括 S1 的 `reference`、`referenceRevision`，避免恢复旧版本使已经修复的链接再次失效；其他可变字段按版本恢复。缺失素材则补回快照引用，仍须通过通常的读取授权，不新授予外部目录访问权。恢复不读取或复制外部媒体字节。

同请求重试先返回原始回执，不要求再次满足旧基线，即使自动版本后来已轮转也不重新恢复。仍须通过当前应用写入守卫。换输入报 `REQUEST_ID_REUSED`。回执包含全部应用项与保持项；超过已有 64 KiB 回执上限整笔拒绝，不截断。主体修订须遵守原生逐次 +1 约束；单次恢复累计最多推进 10,000 步，过大跨度在预览阶段报 `PROJECT_VERSION_RESTORE_LIMIT`，执行阶段再防御核对，避免小快照携带巨大编号而阻塞宿主。

## 外部副本与恢复会话

项目格式 3 的内容令牌是当前 CAS 身份，不是快照内容哈希。新快照仍使用 profile 1，记录真实项目格式，不给历史快照编造捕获 token。物理旧格式项目不能直接打开；本机已经保存的**逻辑格式 2 / profile 1** 正文则先经独立冻结的 18 表约束、封闭字段、原有解压容量及 hash 校验，再仅将格式元数据适配到当前格式 3。原 blob/hash/gzip 字节不重写。合法格式 1/profile 1 通过有界 codec/hash/规范 JSON、冻结的封闭字段/列形状、项目归属和引用检查后，只原字节携带并保留在列表；预览和恢复明确报 `PROJECT_VERSION_SNAPSHOT_UNSUPPORTED`，不适配或应用旧业务行。损坏正文和未知格式仍拒绝，不能靠“不支持恢复”跳过完整性检查。

文件与本机记录失配时，宿主在正常运行时、Mio、worker 和自动保存启动前进入恢复会话。版本 list/preview 直接使用真实连接的读事务；预览按处置后空执行域规划，旧 Mio 来源、时间线撤销和 history/cache 引用不参与保持闭包，内容自身的领域约束、不可变结果、墓碑、素材定位和权限规则仍适用。预览不修改源项目或旧 history。确认恢复在新建的真实 store 上重新计算同一摘要并校验当前 pair，不把旧 store 的执行计划能力转移到新连接。

切换仅复制 `project_version_blobs`、`project_versions` 原始行，校验有界正文、摘要对应、引用、容量和复制计数；不复制请求回执、自动保存标记、Mio 或其他执行记录。`mioRunId` 保留原来源值，脱离旧执行域的外键依赖；它不意味着旧运行仍可恢复或撤销。旧 history 整份只读归档。恢复会话不触发 daily，新 history 正常打开后按原日期/时区键保存当天首个版本，保留政策不变。

自动保存时机：

- 手动：公开 save 操作，稳定请求回执；永久保留。
- Mio 每轮首改：事务开始前准备完整前态，仅内容序号实际推进才写 `mio-turn` 版本和 run 标记。同值、仅 history、失败或回滚不消耗首改；后台绑定和 LUT 的原始事务同样覆盖。
- 大改动前：可信批量入口，当前恢复入口必调；先完成重放和 CAS 检查，再与大改动一起提交。
- 每天第一次打开：在 V2 打开备份校验之后按本地日期和 IANA 时区拍摄。失败仅记录安全错误码，不阻止打开、不记成功标记，同日可重试。当前尚无 S3 升级钩子，未来顺序为备份校验、S3、每日版本。

自动版本保留最近 20 条与最近 7 个本地日历日各自最早一条的并集，时区和 DST 使用日历计算。执行中的版本 pin 和新恢复前版本受保护；只删除无剩余版本引用的 blob。请求回执、捕获标记和手动版本不删除。采集、内存库校验和 gzip 同步进行；首改/大改前存不下则整笔回滚，每日失败可稍后重试，不通过删除手动版本腾空间，不承诺文件立即缩小。

恢复不主动更改 Mio change 的状态。被恢复目标的修订变化使旧 undo 按现有规则报 `AGENT_TASK_TARGET_CHANGED`；独立目标仍可撤销，`undo_all` 沿用现有 supersession 规则。V5 按序号加令牌识别分叉，失配时先进入宿主恢复会话；处置后旧执行记录整份归档，不再授予撤销资格。

## HTTP、CLI、MCP 契约

契约在 `packages/contracts/src/project-version-operations.ts`。旧 `project-versions.ts` 中 U1 的 summary/演示预览 schema 保留，新的完整分页预览使用独立 DTO，不把新数据强塞进旧界面形状。

| 项目级操作 | 严格输入 | 响应 |
| --- | --- | --- |
| `project.version.list` | `{projectId,limit?,cursor?}` | `{projectId,versions,nextCursor}` |
| `project.version.save` | `{projectId,requestId,name?}` | `{projectId,requestId,version}`，稳定手动保存回执 |
| `project.version.preview` | `{projectId,versionId,limit?,cursor?}` | `{projectId,version,contentSequence,contentToken,previewDigest,totalChanges,keptCurrentCount,changes,nextCursor,restoreAvailable:boolean}` |
| `project.version.restore` | `{projectId,versionId,requestId,expectedContentSequence,expectedContentToken,previewDigest}` | `{projectId,requestId,versionId,beforeVersionId,contentSequence,contentToken,totalChanges,appliedChanges,keptCurrent}`，完整原始回执 |

limit 为 1–100，默认 100；name 为 1–150 字符；游标最多 4096 字符。HTTP 使用认证 `POST /api/projects/<projectId>/rpc` 的 `{operation,input}`。URL 与 input 项目不一致报 `PROJECT_ID_MISMATCH`；旧应用 `/api/rpc` 不接受这四个项目级操作。版本不存在和外项目版本都返回同样的未找到，不泄露另一项目。

CLI 沿用现有 JSON 输入，不新增 `--project-id` 参数：

```sh
node apps/cli/src/index.ts project version save --input '{"projectId":"11111111-aaaa-4111-8111-111111111111","requestId":"22222222-bbbb-4222-8222-222222222222","name":"修改前"}'
node apps/cli/src/index.ts project version list --input '{"projectId":"11111111-aaaa-4111-8111-111111111111","limit":100}'
node apps/cli/src/index.ts project version preview --input '{"projectId":"11111111-aaaa-4111-8111-111111111111","versionId":"33333333-cccc-4333-8333-333333333333"}'
```

MCP 名称为 `project_version_list/save/preview/restore`，参数和结果与表格一致。客户端严格校验项目、请求、版本、名称和分页边界；丢 ACK 不自动换 requestId 或重发写入。版本四个操作及备份四个操作统一到契约根注册表与 effect 表；客户端不再保留一份备份操作组合。Mio 禁用列表显式归类，重新生成模型 schema 不代表把这些操作开放给内置 Mio，99 条模型请求指纹必须不变。

## 主要错误

| 错误 | 状态与含义 |
| --- | --- |
| `VALIDATION_ERROR` / `PROJECT_ID_MISMATCH` | 400；严格输入或 K2 地址不一致，未保存版本 |
| `PROJECT_VERSION_NOT_FOUND` | 404；当前项目没有该版本，外项目 ID 同样处理 |
| `REQUEST_ID_REUSED` | 409；保存请求 ID 对应的输入已不同，不新增版本 |
| `PROJECT_HOST_BUSY` | 409；项目仍有在途工作或不确定的外部结果，未恢复 |
| `PROJECT_VERSION_BASELINE_CHANGED` / `PROJECT_VERSION_PREVIEW_CHANGED` | 409；内容序号或完整计划已变化，需重新预览 |
| `PROJECT_VERSION_RESTORE_LIMIT` | 409；主体修订推进超过单次 10,000 步执行预算，未应用恢复 |
| `PROJECT_VERSION_RECEIPT_LIMIT` | 413；完整回执超过 64 KiB，未应用恢复 |
| `PROJECT_VERSION_CURSOR_INVALID` | 400；签名、请求绑定、重启或预览内容变化导致游标无效 |
| `PROJECT_VERSION_RECORD_INVALID` | 422；本机摘要、正文关联、保存回执或 Mio 来源记录损坏 |
| `PROJECT_VERSION_SNAPSHOT_INVALID` | 422；profile、规范文档、行、归属、gzip、长度或哈希不合法 |
| `PROJECT_VERSION_SNAPSHOT_UNSUPPORTED` | 422；已完整保留的格式 1/profile 1 正文尚无业务恢复适配，不能预览或执行恢复 |
| `PROJECT_VERSION_SNAPSHOT_LIMIT` | 413；原文或压缩正文超限，整次保存拒绝 |
| `PROJECT_VERSION_PREVIEW_LIMIT` | 409；对象标识超出有界预览上限，不截断 |
| `PROJECT_VERSION_IMMUTABLE_CONFLICT` | 409；同一 ID 的不可变内容冲突，不能给出恢复计划 |
| `PROJECT_VERSION_DEPENDENCY_CONFLICT` | 409；保留对象和快照组合违反引用或唯一约束 |

内核的项目缺失/锁/移动/格式错误继续使用原有约定。SQL 层还保护 `PROJECT_VERSION_IMMUTABLE`、`PROJECT_VERSION_MANUAL_RETAINED`，它们不是新增的任意更新/删除 API。
