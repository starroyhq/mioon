# 本机项目版本（V1-A）

V1-A 提供手动保存、分页列表和只读预览数据。版本正文保存在该项目的本机 `history.db`，不放进 `.mioon`，不随发送项目文件自动携带。本文记录实现边界，验证与发布状态以对应 PR 为准。

本阶段没有恢复接口，预览固定返回 `restoreAvailable:false`。也没有接入 Mio 首次修改、大改动前、每天第一次打开等自动拍摄，未接自动保留清理或版本界面。它们属于 V1-B、U2；不要把已有的触发类型或预留表当成自动保存已经启用。

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
| `agent_task_target_revisions_v2` | 记录目标修订证据；以后恢复应推进当前修订，不能写回旧账本 |

该台账是显式封闭清单，实际项目库出现未分类的新表或不匹配的列结构时拒绝拍摄，测试也会失败。不是从收集器的当前输出反推“所有表都已覆盖”。

收集保留真实实体 ID、出处 ID、隐藏和墓碑行、没有本机 job 的生成结果，不按当前可见集合过滤。history 的任务、Mio 对话/变化、请求回执、草稿、主体变体批次撤回等过程状态，以及应用库和 cache，都不进入内容快照。

素材只保存当前素材行里的引用、指纹和元数据，不读取外部媒体字节。内嵌 LUT BLOB 本身属于项目内容。采集使用宿主持有的原始连接和同步事务，不重新打开源文件。

## 规范编码与容量

对象键使用固定顺序，用户字符串和业务数组顺序不变；内容行按其稳定主键排序。JSON 列解析后规范化，SQLite BLOB 显式编码为 base64，超出 JavaScript 安全整数范围的整数使用带类型的十进制表示。歧义的重复 JSON 键、非法值、归属不一致、重复主键或约束/FK 不合法的文档会拒绝。

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
| `project_version_capture_marks` | 为后续自动拍摄保留的标记结构；V1-A 不写自动拍摄标记 |

公开保存只能产生 `manual` 版本，不能指定 trigger、mioRunId 或任意 snapshot。事务内先检查旧请求，再采集和编码当前内容、保存正文和版本、记录回执；任何失败一起回滚。手动保存不改变项目内容序号、业务修订或内容行。

同 projectId/requestId 和相同输入重放原始回执，即使当前内容后来已改变；同 requestId 换名称等输入报 `REQUEST_ID_REUSED`。相同内容使用新 requestId 仍创建另一条手动版本。已存在的 blob 在复用前会校验，不接受损坏正文冒充去重命中。

正文、版本和回执有不可变/拒绝 REPLACE 约束；手动版本有保留保护。本阶段不提供删除或清理入口。history 的目标版本由 `HISTORY_SCHEMA_VERSION` 决定，不在本文写死数字；V1-A 接在 R2 后新增领域，必须以精确历史清单完成窄升级。旧 2–5 到新终点的实际验收结果见本 PR，不以计划代替已通过的升级测试。

## 预览、来源与保持当前

预览在同一项目连接的事务里读取旧文档和当前内容，只生成差异数据，不写内容、回执或 Mio 标记。每条包含 `table`、稳定 `key`、动作、变动字段、来源和保持原因，不返回原始 SQL、媒体字节或 history 过程正文。

- 以“快照目标”和“当前状态”比较，忽略纯 `revision`/`updatedAt` 的显示差异；`add/remove/change` 的方向表示将来回到所选版本需要的动作。
- 快照以后 Mio change 记录涉及的目标标 `source:'mio'`；其余标 `source:'user-or-other'`，含义是“你或其他来源改的”，不宣称能证明纯手动归因。
- 预览考虑删除、墓碑、不可变结果、图像组只前进的 head，以及当前本机过程/缓存仍引用的 owner。不能删的对象逐个列为 `keep-current`，必须有原因；引用依赖按闭包计算，不能只保留一层 owner。
- 同 ID 的不可变内容不同，或者保留当前内容与快照的组合违反引用/唯一性约束时，整次拒绝预览，不给出看似可执行的部分计划。
- `totalChanges` 是完整差异总数，`keptCurrentCount` 是其中保持当前的数量；页面只返回最多 100 条。`previewDigest` 绑定整份当前文档、所选正文和完整差异，不能只对当前页签名。
- 列表游标绑定项目、页大小和时间/ID 锚点；预览游标还绑定版本、完整 digest 和偏移。后续内容变化会使原预览分页失效；游标由本进程签名，重启后旧游标失效，调用方重新读首页。

上述结果仍是 **V1-A 的预览数据，不是执行恢复的许可**。V1-B 才会接入恢复前版本、内容独占/CAS、实际修订推进、恢复回执及与 Mio 撤销的组合验收。V1-A 不主动把 Mio change 标为已取代，也不新增来源索引、选用状态或内容令牌。同内容序号的分叉副本盲点仍归 V5。

## HTTP、CLI、MCP 契约

契约在 `packages/contracts/src/project-version-operations.ts`。旧 `project-versions.ts` 中 U1 的 summary/演示预览 schema 保留，新的完整分页预览使用独立 DTO，不把新数据强塞进旧界面形状。

| 项目级操作 | 严格输入 | 响应 |
| --- | --- | --- |
| `project.version.list` | `{projectId,limit?,cursor?}` | `{projectId,versions,nextCursor}` |
| `project.version.save` | `{projectId,requestId,name?}` | `{projectId,requestId,version}`，稳定手动保存回执 |
| `project.version.preview` | `{projectId,versionId,limit?,cursor?}` | `{projectId,version,contentSequence,previewDigest,totalChanges,keptCurrentCount,changes,nextCursor,restoreAvailable:false}` |

limit 为 1–100，默认 100；name 为 1–150 字符；游标最多 4096 字符。HTTP 使用认证 `POST /api/projects/<projectId>/rpc` 的 `{operation,input}`。URL 与 input 项目不一致报 `PROJECT_ID_MISMATCH`；旧应用 `/api/rpc` 不接受这三个项目级操作。版本不存在和外项目版本都返回同样的未找到，不泄露另一项目。

CLI 沿用现有 JSON 输入，不新增 `--project-id` 参数：

```sh
node apps/cli/src/index.ts project version save --input '{"projectId":"11111111-aaaa-4111-8111-111111111111","requestId":"22222222-bbbb-4222-8222-222222222222","name":"修改前"}'
node apps/cli/src/index.ts project version list --input '{"projectId":"11111111-aaaa-4111-8111-111111111111","limit":100}'
node apps/cli/src/index.ts project version preview --input '{"projectId":"11111111-aaaa-4111-8111-111111111111","versionId":"33333333-cccc-4333-8333-333333333333"}'
```

MCP 名称为 `project_version_list/save/preview`，参数和结果与表格一致。客户端严格校验项目、请求、版本、名称和分页边界；丢 ACK 不自动换 requestId 或重发保存。版本三个操作及备份四个操作最终统一到契约根注册表与 effect 表；Mio 禁用列表显式归类，重新生成模型 schema 不代表把这些操作开放给内置 Mio，99 条模型请求指纹必须不变。

## 主要错误

| 错误 | 状态与含义 |
| --- | --- |
| `VALIDATION_ERROR` / `PROJECT_ID_MISMATCH` | 400；严格输入或 K2 地址不一致，未保存版本 |
| `PROJECT_VERSION_NOT_FOUND` | 404；当前项目没有该版本，外项目 ID 同样处理 |
| `REQUEST_ID_REUSED` | 409；保存请求 ID 对应的输入已不同，不新增版本 |
| `PROJECT_VERSION_CURSOR_INVALID` | 400；签名、请求绑定、重启或预览内容变化导致游标无效 |
| `PROJECT_VERSION_RECORD_INVALID` | 422；本机摘要、正文关联、保存回执或 Mio 来源记录损坏 |
| `PROJECT_VERSION_SNAPSHOT_INVALID` | 422；profile、规范文档、行、归属、gzip、长度或哈希不合法 |
| `PROJECT_VERSION_SNAPSHOT_LIMIT` | 413；原文或压缩正文超限，整次保存拒绝 |
| `PROJECT_VERSION_PREVIEW_LIMIT` | 409；对象标识超出有界预览上限，不截断 |
| `PROJECT_VERSION_IMMUTABLE_CONFLICT` | 409；同一 ID 的不可变内容冲突，不能给出恢复计划 |
| `PROJECT_VERSION_DEPENDENCY_CONFLICT` | 409；保留对象和快照组合违反引用或唯一约束 |

内核的项目缺失/锁/移动/格式错误继续使用原有约定。SQL 层还保护 `PROJECT_VERSION_IMMUTABLE`、`PROJECT_VERSION_MANUAL_RETAINED`，它们不是新增的任意更新/删除 API。
