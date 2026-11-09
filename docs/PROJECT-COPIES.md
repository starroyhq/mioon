# 项目复制、另存为与模板（S5-A/B）

日期：2026-11-04。本文对应 S5-A/B 的应用能力和受信端口；界面尚未接线，验收与发布状态以对应 PR 为准。S5-C 的废纸篓另卡实施。

## 当前入口与契约

`project.duplicate` 和 `project.save-as` 使用已认证的应用级 `POST /api/rpc`。它们不走项目 RPC，不恢复旧 `/api/project-packages/…` 路由。契约在 `packages/contracts/src/project-copies.ts`，是独立叶模块；不加入公共 `schemas`、CLI/MCP discovery 或内置 Mio 工具目录。

两个操作共用严格的 `projectCopyInputSchema`，未知字段拒绝：

| 字段 | 含义 |
| --- | --- |
| `projectId` | 已登记的源项目小写 UUID；源文件位置从登记读取 |
| `requestId` | 调用方提供的稳定小写 UUID；不明结果按原键重试 |
| `projectFile` | **新目标文件**在服务端当前系统上的规范化绝对路径，最长 4096 字符，以 `.mioon` 结尾，文件名不能以 `.` 开头；父目录须存在且可写。共享契约支持各平台，但服务端拒绝其他平台的路径，不能把它当作本机相对路径 |
| `name` | 可选的新项目名，沿用项目名严格校验和 150 个 UTF-16 单元上限；省略时保留源名称 |

应用 RPC 请求体示例：

```json
{
  "operation": "project.duplicate",
  "input": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "requestId": "22222222-2222-4222-8222-222222222222",
    "projectFile": "/Users/you/Movies/Mioon/Copy/Copy.mioon",
    "name": "Copy"
  }
}
```

严格响应 `projectCopyResponseSchema` 包含 `requestId`、`sourceProjectId`、新登记 `project`、实际完成的 `contentSequence/contentToken` 及携带的 `versions` 数量。`project.projectId` 必须不同于源 ID；新登记起初没有最近打开时间和摘要。响应的版本数表示复制完成时携带的版本，不包含后来正常打开生成的每日版本。

受信 `ProjectEntryControlPort` 可选提供 `duplicate(input)` 和 `saveAs({...input, windowId})`。`saveAs` 返回 `{copy, window}`；`windowId` 是主进程持有的窗口 owner，不能由普通 HTTP 请求指定。端口存在不代表桌面选择器、菜单或窗口 UI 已接入。

### S5-B：副本、受限源和模板

下列三个操作同样只在已认证的应用 `/api/rpc` 和受信端口提供，不进入公共 `schemas`、CLI/MCP discovery 或 Mio 工具。未知字段严格拒绝，普通 HTTP 不能指定 `windowId`。

| 操作 | 严格输入 | 受信端口 |
| --- | --- | --- |
| `project.adopt-copy` | `sourceProjectId`、`sourceFile`、`sourceIdentity`、`sourceStamp`、`requestId` | `adoptCopy({...input, windowId})` 返回 `{copy, window}`，在指定空窗口打开新身份 |
| `project.copy-to` | 上述源字段，加新目标 `projectFile` 和可选 `name` | `copyTo(input)` 返回复制结果，后续打开由调用方负责 |
| `project.template.instantiate` | `templateId`、正整数 `templateVersion`、`parentDir`、`name`、`requestId` | `instantiateTemplate(input)` 返回实例结果，后续打开由调用方负责 |

`sourceIdentity` 是精确十进制字符串 `{dev, ino}`，`sourceStamp` 是 `{contentSequence, contentToken}`。它们绑定用户选择时观察到的关闭文件，不授予覆盖权限；执行时重新核对路径、文件身份、项目 ID 和内容 pair，变化就拒绝。源、目标 `.mioon` 路径与父目录必须是当前系统的规范绝对路径。三个操作均返回既有 `projectCopyResponseSchema`；模板的 `sourceProjectId` 指向受控模板的项目身份。

“作为新项目打开”只接受仍被登记原件识别为副本的文件；原件、同 inode 硬链接、原件已移动的候选都不能借此改身份。不 acquire 原项目，不读取它的 history。服务对选中副本持 SQLite 写锁，用 copy builder 在同一目录生成、校验新 ID/令牌的暂存文件，再核对原 dev/ino 并 rename 替换；不原位重键、不摘触发器，不遗留旧 `-wal`、`-shm`、`-journal`。登记原件和其本机记录不变；新项目不带原件的版本、Mio、任务、撤销或草稿。受信端口先保留窗口 owner 并检查冲突/容量，才替换副本；已完成替换后的打开失败不回写旧身份。普通 HTTP 仅完成操作本身，不管理窗口。

“复制到…”从用户选中的关闭或受限文件只读捕获，不依赖它能被普通 writable opener 打开，也不把原登记移到选中路径。源文件、日志和登记均不写；本机有该 `sourceProjectId` 的 history **就必须携带版本，不论 seen 是否匹配**，分叉不另加确认。坏、被占用或无法可靠读取的 history 整笔拒绝，只有不存在才没有版本来源。转换、执行域清空、素材引用重定位、原目录确认和目标排他发布与普通复制相同。

模板来自宿主安装时注入的可信 catalog。请求只选择已登记的 ID/版本，不能上传 manifest、白名单或任意源路径。模板必须是当前物理格式的普通项目文件；素材按白名单验证真实大小/hash，拒绝穿越、symlink、隐藏/私有文件、缺失或损坏素材。实例只建到 `<parentDir>/<name>/<name>.mioon` 的**新文件夹**，已存在目录或 symlink 均报 `PROJECT_FILE_EXISTS`，不合并进已有目录。白名单素材复制到新目录并重写引用，不用 hard link；两次请求生成独立 ID、令牌和素材，模板不变。模板不提供原 history、Mio、撤销、草稿、cache、imports 或规范信任。S6-D 的正式示例、界面和真实卷验收另行交付，小测试夹具不能代替正式示例验收。

## 关闭源与窗口顺序

- 首页复制先检查窗口租约；源在任何窗口打开时返回 `PROJECT_HOST_BUSY`，不会替用户关闭窗口。
- 受信另存为先验证当前窗口确实持有源，且没有其他窗口、在途请求、任务或忙运行时；仅释放自己的窗口租约，再由复制服务在独占中关闭源。成功后在同一个 owner 下打开新项目。
- 复制失败或新项目打开失败时，端口尝试重新打开原项目并返回真实错误；原项目也打不开时返回 `PROJECT_SAVE_AS_REOPEN_FAILED`。若新文件已经发布，不因窗口激活失败将它回滚或重拷。
- 应用 RPC 的 `project.save-as` 提供复制服务本身；同窗口切换由受信 `saveAs` 端口负责。复制过程不持普通项目请求租约等待自身独占，也不复用已关闭的 `host.db`。

实际捕获只读已关闭的源。在受保护的同一读事务内，用 SQLite backup 捕获项目及存在的本机 history；不对持有中的数据库做文件复制或哈希，不调用普通 opener 升级源、创建源 records/cache 或启动 worker/Mio。占用、热日志、活动 super-journal、损坏、未来格式或无法取得一致快照时拒绝，不能退回文件系统拷库。

现有 history 必须读取，不以 seen 与源文件是否匹配决定是否携带版本；分叉不导致静默丢版本，也不表示已替用户处置源分叉。精确已知的旧 history 结构按冻结清单只读校验，不升级源。只有 history 不存在时才没有本机版本来源；history 坏了或被占用时整笔拒绝。未完成的 V5 切换返回 `PROJECT_HISTORY_SWITCH_PENDING`，不能绕过。

## 新身份、版本和素材

复制在持久 intent 中固定新项目 ID 和新内容令牌，保留当前内容、镜头/素材等实体 ID、自由文本、标签与非执行来源。归属按字段重写，不全局替换恰好等于旧 UUID 的文本。新文件与源独立提交；复制的读取和转换不改源项目、原版本行或 blob。

**本机记录只携带重绑定的版本。** 每个版本严格解码，再重写正文项目归属、项目/时间线虚拟目标及该历史版本里的素材定位，按当前 canonical JSON/gzip 编码重新计算 hash；相同新正文去重。保留版本 ID、名称、trigger、时间、内容序号和来源说明。格式 2/profile 1 用已有冻结 decoder 逻辑适配到当前格式；格式 1 整笔报 `PROJECT_VERSION_SNAPSHOT_UNSUPPORTED`（422），`details.versionId` 指明具体版本。损坏、错归属、超限或缺失 blob 不跳过、不部分完成。

这里的旧格式兼容只指本机逻辑版本快照；源 `.mioon` 仍须通过当前内核的完整物理格式校验，不开放旧物理项目格式。

新 history 只写版本行和正文，不带 Mio 对话、后台任务、Mio/时间线撤销、草稿、旧请求回执、自动保存标记、imports、自动备份、cache 或 `AGENTS.md` 信任；不在新项目归档一份完整旧 history。源 history 留在源项目 records 中。版本中的 `mioRunId` 仅是来源，不能变成新项目的执行或撤销资格；新版本边界为 0，并移除 job/export/image_task/frame_task 四种过程目标修订证据，保留持久内容修订。

普通生成版本保留的 `jobId` 同样是来源标识，不表示副本拥有该任务。读取版本、镜头文字及选择版本时，普通版本缺失来源任务须通过既有的可携带版本证明：发布证明、完整素材哈希、快照关联均一致，且没有残留的本地执行记录，不能只按任务缺行放行。若任务行存在，仍严格校验关系行、正文身份及当前项目归属，损坏或超限不能当成缺行。主体参考版本的原快照、回执和归属校验继续保留；执行、恢复或重试仍要求本项目的真实任务，不能借用原项目任务。文字编辑仍须通过原版本/素材归属、更新与回执校验。该兼容也适用于已建好的旧副本，不修改原版本或补写任务。

复制当前内容也清理这四种过程目标修订。目标 history 的 seen 取 builder 完成后的实际 `{contentSequence, contentToken}`，而非最初分配的旧值；首次正常打开应为 `current`，不会伪造分叉。后续打开仍执行正常的版本/备份生命周期。

普通复制、另存为和复制到继续**引用同一份素材**。每个当前或历史素材 reference 按源、目标项目目录重新定位，保留指纹和 referenceRevision；不存在的素材仍指向原位置，不因复制而删除引用。只有模板在本卡生成独立素材副本；携带素材打包由 V4 承担。

同一台电脑上，源项目目录及既有外部目录确认按原有范围转给新项目，和新登记、固定应用回执在 B1 事务中一起提交；不扩大到新位置，也不复制规范信任。重放不重新授予用户后来已撤销的目录许可。

## 回执、持久 intent 与发布

复用 B1 的应用回执，不新增应用库表或升级应用库/history 结构。私有 `project-copy-records.ts` 定义本机 intent **v1**，存于 `<dataDir>/project-copies/<operation>-<requestId>.json`；它不是项目文件或 history 格式。记录操作、严格输入与摘要、固定新 ID/令牌、源身份和 pair、暂存/占位身份、阶段及完成结果。

阶段为 `prepared → captured → ready → records-published → project-published → completed`。项目和版本转换、完整校验与同步在发布前完成；新 records 先发布，项目文件随后发布，再将登记、目录确认和应用回执原子提交。源快照仅为私有转换输入，完成后清理，不成为目标 history 归档。

S5-B 的三个操作使用独立的私有 **v1** `project-copy-action-records.ts`，位于 `<dataDir>/project-copy-actions/<operation>-<requestId>.json`。除严格输入、摘要、新身份/令牌及阶段外，记录选中源的身份/pair、固定目标路径、模板目标文件夹与排他目录占位的身份；A intent 仅补 `abandoned` 作废阶段，其输入及身份绑定保持原义，不增加应用库表或占 history 号。模板完整目录和 adopt 替换都由同一请求的记录续办，不把中断当成新的复制。

同一 `(operation, requestId)` 与同一输入返回固定结果；不同输入复用键返回 `REQUEST_ID_REUSED`。重放不再复制、转换版本、重新分配 ID 或打开目标。目标已编辑但文件身份仍一致时仍返回原回执；目标被移动、替换或撤登记则报 `PROJECT_COPY_TARGET_CHANGED`，不重新创建。

目标已有普通文件、空文件或 symlink 均拒绝覆盖。支持 hard link 的卷采用排他发布；S5 的不支持 hard link 分支（含 exFAT）先用 `wx` 建自己的占位，intent 记录 dev/ino，rename 前核对占位身份。崩溃后仅按身份处理本请求占位，不删除后来文件。核对与 rename 之间被非 SQLite 程序换掉占位的窄竞态是协调人明确接受的边界；没有新增原生 no-replace 端口，也不宣称真实卷验收已完成。

启动恢复将 `prepared/captured` 阶段未完成的转换作废，只按已记录身份清理本请求的隐藏暂存目录；保留作废记录，同一请求键返回 `PROJECT_COPY_INTERRUPTED`，不重新分配身份或重新复制。目录/文件身份已变时不删后来内容。`ready` 及之后已有固定完整结果的 intent 可在启动恢复中尝试续办发布、登记和回执。发布后故障保留目标与 intent，不能当成“零写入失败”再次覆盖。异常身份、无法清理的未知内容或应用 owner 失效时保留证据，不以换库重开取得旧写权限。实际故障与平台验收以 PR 证据为准；本文不提供未实测的耗时。

## 主要错误

| 错误 | 含义 |
| --- | --- |
| `VALIDATION_ERROR`（400） | 输入、名称或目标绝对路径不符合叶契约 |
| `PROJECT_HOST_BUSY`（409） | 仍有窗口、请求或会写回的工作，不能安全关闭复制 |
| `PROJECT_LOCKED`（409）、`PROJECT_INVALID`（422）、`PROJECT_FORMAT_NEWER`（409） | 项目或 history 捕获失败；`details.database/reason` 区分来源 |
| `PROJECT_FILE_EXISTS`（409） | 目标已存在或就是原文件 |
| `PROJECT_COPY_UNSUPPORTED_FILESYSTEM`（409） | 目标卷连排他占位发布也无法提供；不是缺少 hard link 就拒绝 |
| `PROJECT_COPY_BUSY`（409） | 同一目标已有复制进行中 |
| `REQUEST_ID_REUSED`（409） | 同操作的请求键用于不同输入 |
| `PROJECT_COPY_SOURCE_CHANGED` / `PROJECT_COPY_TARGET_CHANGED`（409） | 源或目标的位置、文件身份、登记与已绑定结果不一致 |
| `PROJECT_COPY_INTENT_INVALID`（409） | 私有恢复记录或回执绑定无效，不能猜测续办 |
| `PROJECT_COPY_INTERRUPTED`（409） | 启动恢复已作废的未完成转换；原请求键不再执行 |
| `PROJECT_VERSION_SNAPSHOT_UNSUPPORTED`（422） | 不能跨 ID 转换的历史快照，附具体 versionId |
| `PROJECT_VERSION_SNAPSHOT_INVALID` / `PROJECT_VERSION_RECORD_INVALID`（422） | 快照校验、版本归属、正文引用或计数无效 |
| `PROJECT_VERSION_SNAPSHOT_LIMIT`（413） | 有界快照转换超过容量；不跳过版本 |
| `PROJECT_SAVE_AS_REOPEN_FAILED`（409） | 另存为流程异常，且原窗口未能重新打开源 |

S5-B 另将文件系统失败映射到明确的应用错误：`EACCES` / `EPERM` 保留原码并返回 403；`EROFS` 返回 `PROJECT_INVALID`（422，`details.reason: 'read-only'`）；`ENOENT` / `ENOTDIR` 返回 `PROJECT_LOCATION_INVALID`（400）；`ENOSPC` / `EDQUOT` 返回 `PROJECT_COPY_CAPACITY`（507）。此映射仅限本卡的复制动作，不改全局文件错误语义。

CLI 与旧客户端的 `project.duplicate` 当前在网络/存储访问前返回 `PROJECT_COPY_UNAVAILABLE`（409）；CLI/MCP 新复制和另存为命令留 0.1.x/S4。没有配置复制服务的应用 RPC 返回同码 503。旧 package 路由仍是 404，不是新操作的回退。

## 移到废纸篓与已销项义务

S5-C 的应用 `project.delete` 仅将关闭的 `.mioon` 移到废纸篓，确定成功才撤登记，素材和本机记录原样保留。它要求受信桌面 `shell.trashItem` 能力；网页/headless 无能力时返回 `PROJECT_TRASH_UNAVAILABLE`，CLI/MCP 在本机访问前明确拒绝。结果不明不重做、不撤登记。契约和准入见 [PROJECT-LIFECYCLE.md](PROJECT-LIFECYCLE.md)；本卡不接删除、复制或模板界面。

协调人 11-04 已决定：0.1.0 不做永久删除。以下旧义务逐项销项：

| 旧永久清理义务 | 状态 |
| --- | --- |
| 删除独占托管素材 | **已销项（协调人11-04）** |
| 清行和缩略图 | **已销项（协调人11-04）** |
| 清理未完成时续跑：`cleanup:'pending'`、`workspace.info.cleanupPending` | **已销项（协调人11-04）** |
| 删除清单 `projectDeleteManifestSchema` | **已销项（协调人11-04）** |
| 清除终态政策 | **已销项（协调人11-04）** |

销项不取消 S5-C 的窗口/写回工作/Mio 等待拒绝、显式确认、原键重放、retained 与他项目隔离义务；旧 `confirmPermanentDeletion` 须严格拒绝。S8 草稿保留且不阻止 trash。系统移走结果不明时不重做、不撤登记；records 清理交 U2，不能恢复旧永久素材清理链。

版本容量和恢复规则见 [PROJECT-VERSIONS.md](PROJECT-VERSIONS.md)，素材定位和目录许可见 [ASSET-REFERENCES.md](ASSET-REFERENCES.md)，实际宿主入口与租约见 [PROJECT-HOST.md](PROJECT-HOST.md)。
