# 项目重命名、规范与移到废纸篓

0.1.0 的 `project.delete` 仅将已关闭项目的 `.mioon` 文件移到系统废纸篓。素材和本机记录保留；没有永久删除或旧清理队列。内置 Mio 模型工具仍禁用该操作。

## 契约与入口

重命名传入 `requestId`、`projectId`、`expectedRevision` 和 `name`。名称首尾空白被移除，限 1–150 字符；成功后项目 revision 加一并更新业务时间。同一请求精确重放原回复，改变内容复用请求 ID 则冲突。现有 HTTP、CLI、MCP 重命名入口不变。

旧项目说明（C6）已随 U2-A 退役：公共发现、HTTP/CLI/MCP 和业务入口不再提供 `project.notes.set`，调用返回 `UNKNOWN_OPERATION`（404）。新公共项目读/重命名响应不含 `notes`；已有项目 JSON 和 `project_mutation_requests` 原回执原位保留，读取与重命名不顺带清洗旧说明，重放只对外投影、不重写 ACK。新规范使用同目录 `AGENTS.md` 的 R2 文件 hash、信任和原请求回执；旧 notes 不迁移、不自动启用、不注入新 Mio 轮次。历史工具目录和 typed context 仅保留旧请求诊断/重建，不能执行旧写操作。

应用层移到废纸篓使用 `POST /api/rpc` 的 `project.delete`，输入严格包含：

- `requestId`、`projectId`：UUID，调用方保留同一请求键及完整输入。
- `expectedRevision`：用户确认的项目版本。
- `projectFile`：用户确认的规范绝对 `.mioon` 路径。
- `fileIdentity`：该登记的十进制字符串 `{dev, ino}`，执行时仍需重新验证，不能用来授权任意路径。
- `confirmTrash: true`：明确确认只将该项目文件移到废纸篓。

旧 `confirmPermanentDeletion`、缺确认、额外字段和无效身份严格返回 `VALIDATION_ERROR`（400）。只有受信桌面主进程可以调用 `shell.trashItem`；网页、headless 没有此能力，返回 `PROJECT_TRASH_UNAVAILABLE`，不回退为 `unlink`、`rm` 或删除父目录。本卡不接菜单、确认框或其他界面。

CLI 和 MCP 的新复制、另存为和移到废纸篓命令留 0.1.x。当前 CLI `project delete`（含点号和 `rpc` 别名）在读取 JSON 输入或输入文件、初始化私有存储和查找后端之前返回 `PROJECT_TRASH_UNAVAILABLE`（409）；MCP `project_delete` 在初始化私有存储或调用后端之前返回同码。它们保留 schema、帮助和工具目录，不会因连接到桌面后端而取得新能力。

确定成功后返回固定回执：

```json
{"requestId":"…","projectId":"…","projectFile":"/confirmed/Project.mioon","trashed":true,"records":"retained"}
```

该回执表示项目文件已移到废纸篓、登记已撤销，素材和本机记录原样保留。没有 `deleted` 或 `cleanup:'pending'` 语义。

## 准入、文件身份与回执

执行前通过应用写入守卫，取得项目独占并复验登记、项目 revision、内容 pair 和文件代次。任何窗口打开项目都报 `PROJECT_HOST_BUSY`，不替用户关窗。请求、任务、后台生成、供应商结果未知或待对账、inbox 待写结果也阻止操作；关闭项目仍使用 S3-A 的 `inspectProjectWork` 判断。

Mio 等待用户回答或审批同样拒绝，不能只看 runtime 的 `isBusy`，不能用最近 100 条列表证明没有等待；关闭宿主前读取真实记录，拒绝时不靠 `interrupt` 改变状态。S8 草稿不阻止操作，随本机记录保留。

只读检查复用内核验证，不迁移或创建源记录。符号链接、硬链接、被占用、项目或 history 无法安全读取、未知或热日志均拒绝；不手工清日志。关闭检查句柄后，主进程调用 OS 前再次核对完整文件身份，不能误处理同路径后来文件。

OS 调用前持久化绑定请求摘要和原文件身份的私有 intent。只有取得确定成功且应用写入权仍有效时，才在同一应用库事务中撤掉原登记并保存固定回执；不删项目内容行、history 或 retained 数据。同键重放返回原回执，不能再次调用 OS，改变输入复用键则冲突。

## 结果不明与保留项

OS 已动作但回复丢失、进程崩溃或应用回执提交失败时，结果可能不明。保留 intent 和登记，返回 `PROJECT_TRASH_UNCONFIRMED`；同键、新键和重启都不重新执行该不明操作，不用“原路径不存在”补造成功。最近项目沿现有缺失状态显示；不增加不明结果界面。

只移 `.mioon`，不动父目录、项目素材、外部与共享文件、生成或导出结果、history、版本、Mio 对话与终态政策、撤销、S8 草稿、自动备份、V5 归档、imports 或目录信任。其他项目保持不变。本机记录清理交 U2；此操作不提供永久删除或安全擦除。

协调人 11-04 已销项的旧义务如下，不再作为后续清理承诺：

| 旧永久清理义务 | 状态 |
| --- | --- |
| 删除独占托管素材 | **已销项（协调人11-04）** |
| 清行和缩略图 | **已销项（协调人11-04）** |
| `cleanup:'pending'`、`workspace.info.cleanupPending` 清理未完成续跑 | **已销项（协调人11-04）** |
| 删除清单 `projectDeleteManifestSchema` | **已销项（协调人11-04）** |
| 清除终态政策 | **已销项（协调人11-04）** |

## 当前项目菜单

“存为版本…”和“版本历史…”接真实的[版本接口](PROJECT-VERSIONS.md)；自动备份在历史框的第二个标签页，沿用[备份接口](PROJECT-BACKUPS.md)。未保存的编辑不会被版本恢复覆盖：可以查看历史，保存和恢复需先保存或放弃当前编辑。版本预览过期后必须重新预览；保存或恢复未收到回执时只允许核对原请求，不自动新建请求。

“项目规范…”编辑项目文件同目录的 `AGENTS.md`。外部改动需查看后明确启用；读取失败、未决写入或结果未知时不能当作已启用。Mio 提议修改规范仍走原任务的审批与回执，界面只展示宿主给出的完整提议。规范影响后续请求，不改变已经开始的一轮所冻结的上下文。 浏览器未确认的规范请求按稳定应用库 scope 存在 v2 本地键，同库服务重启可查询原请求，不把另一个库的同 UUID 项目当原 owner。旧 v1 键未记录资料库，原位保留草稿和未知请求；无法证明归属时明确阻止核对、重发及自动清理，不擅自迁移给当前库。

`GET /api/project-entries/<项目 ID>` 返回经过认证的单条登记与应用身份，仅用于可信路径显示及原生恢复结果核对；读取不会打开项目，也不授予文件或窗口能力。网页沿用项目目录边界，桌面受信通道才可核对外部已登记项目。

## 验证边界

`tests/project-lifecycle.test.ts`、`project-lifecycle-transports.test.ts`、`project-package-http.test.ts`、`agent-task-policy-answer-v2.test.ts`、`agent-task-storage-schema-v2.test.ts` 保留旧永久确认严格拒绝和零写入覆盖；`project-copy-cli-unavailable.test.ts` 用私有存储和网络哨兵验证 CLI/MCP 门禁。真实 trash 的窗口、工作、Mio 等待、S8 草稿、身份变化、固定回执和不明结果由宿主与桌面端口测试覆盖。

测试中的 fake OS 只证明调用顺序及隔离，不代表真实废纸篓验收。0.1.0 真实系统边界限 macOS，签名安装包上 `shell.trashItem`、Finder 恢复、权限和丢回复验收交 Q。项目复制见 [PROJECT-COPIES.md](PROJECT-COPIES.md)，宿主和租约见 [PROJECT-HOST.md](PROJECT-HOST.md)，本机记录见 [PROJECT-FILE.md](PROJECT-FILE.md)。
