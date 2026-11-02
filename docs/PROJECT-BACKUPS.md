# 项目自动备份（V2）

V2 在项目打开、关闭时自动保存项目文件的物理副本，保留最近三份有效备份。备份可只读查看，也可恢复成新的项目文件。后端、CLI 和 MCP 已提供接口；本卡没有接入备份界面，也没有实现 V1 的逻辑版本。

## 备份的范围和时点

生产 `startServer` 组装 `createProjectBackups`，把其 hooks 放在宿主管理器的第一个位置。`afterOpen` 按注册顺序调用，备份发生在运行时组装好以后、第一个租约之前；`beforeClose` 倒序调用，备份发生在其它关闭钩子之后。关闭时对应 [13 步顺序](PROJECT-HOST.md#43-关闭时的顺序) 的第 7 步：请求和运行时排空以后、读取摘要和关闭 store 以前。排空失败时继续遵守宿主保留连接和锁的规则，不为了备份强行关库。

复制使用持有项目的原始内核连接：

```ts
await backup(store.db, destination, {source: PROJECT_DATABASE_NAMES.project});
```

`main` 是 `history.db`，所以必须显式选 `project`。不另开源项目连接，不用文件复制、读文件哈希或重新打开源文件的方法复制活跃数据库。物理备份只含项目内容，不含 history、cache、Mio 对话、任务、回执、外部媒体、`AGENTS.md` 或生成目录。

运行时工厂在打开钩子前已经启动 worker。V2 接受 SQLite **完成备份时的一致副本**，项目身份、内容序号和大小从完成后的副本读取；不承诺严格的“打开瞬间”，也不增加 worker 激活闸门。

## 目录、标记和轮换

本机记录位于 `<dataDir>/records/<projectId>/backups/`，不放在项目目录或缓存中：

```text
backups/
  index.json
  status.json
  <backupId>/project.mioon
  restore-requests/<requestId>.json
```

索引和恢复意图使用带版本号的私有 JSON，状态也存在私有 JSON 中，**不新增或升级 history 表**。目录和文件遵守私有存储的权限、无符号链接、单链接文件检查；外部请求只用项目 ID 和备份 ID 选源，不接受源数据库路径或 SQL。

完成的备份使用专用 SQLite `application_id = 0x4d696f42`（`MioB`）。只改副本的标记，源项目保持普通标记。普通 opener 拒绝备份，即使把它改名、搬到普通目录或复制成新 inode，也不能据此登记为项目。专用备份 opener 只读打开并验证该标记、当前项目结构、项目 ID、内容序号和完整性；不创建本机库或启动宿主。应用的私有路径和文件身份守卫继续生效。

每个项目的复制、读取、恢复和轮换共用一条队列，读取期间不会删除其备份。以索引中最新的**完成且验证有效**备份为去重依据：内容序号相同就跳过，不更新时间、不轮换。缺失或损坏的副本不用于去重，也不出现在有效备份列表中；索引自身损坏则明确拒绝，不猜测原记录。

不能省略去重：CLI 和外部 agent 的只读请求会让项目反复打开、空闲关闭；每次都复制会很快把三份有变化的历史挤掉。只有 history 写入的活动不会增加项目内容序号，也不会制造新物理备份。

复制在独占的新暂存目录中完成，验证后以不覆盖目标的方式发布。**原子更新 `index.json` 是发布提交点，确认其目录同步以后才清理旧文件。** 索引最多引用最近三份有效副本：

- 提交前失败，原索引和旧备份保留。
- 索引已发布、但目录同步或后续清理失败，不回滚旧索引，不删除尚未确认安全的旧副本；记录失败，下一次捕获重试维护。
- 后续捕获包括同序号跳过时都会清理未被有效索引引用的保留命名目录，处理中断复制和发布后未清理的孤儿。只清理 V2 自己的 UUID 备份目录和已知暂存文件；遇到未知文件或不安全路径保留并报错，不递归清理其它本机记录或恢复回执。

正常维护结束后保留三份；发生故障时可暂留额外文件，以保护已提交的有效备份。

## 恢复成新文件

恢复给目标分配**新的 projectId、空的本机记录**。项目内实体 ID 和真实 provenance 保留，所有项目归属按新 ID 重建；不合成旧任务，不携带旧 Mio、撤销、版本或任务回执。原项目、原 history 和源备份不变。目标存在就报 `PROJECT_FILE_EXISTS`，不覆盖。

`project-file/copy.ts` 的 `copyProjectToNewFile` 是可供 S5 复用的新 ID 复制能力；V2 用验证过的只读备份 reader 调用它。转换只发生在隔离的新目标中，校验完整项目结构和引用以后再发布，不改源库的约束或元数据。新文件登记后可正常打开，首次打开时才创建它自己的 history/cache。

素材按当前 main 的实际存储形态处理：

- 当前托管素材的 `media/` 文件从原项目目录复制，校验指纹/大小，并使用不覆盖目标的文件创建方式；目标媒体已存在时，只有完整校验为相同字节才复用，保留原文件身份，支持发布前中断后的重试。源文件缺失、变化或目标内容冲突会让恢复失败，不用错误字节顶替。
- 已使用 `mediaReference` 的行保留引用和指纹。相对引用依据备份记录的原项目目录解析，再针对目标目录重定位；同卷可继续相对引用，无法证明同卷时使用绝对引用。绝对引用保持不变，缺失文件仍是缺失引用，不把旧相对路径直接套到新目录。

备份不包含外部素材字节，因此不能承诺在原媒体被删除以后恢复它。尚未接入的 S5 复制/另存为接口和旧交换导入接口不会因 V2 恢复而启用。

恢复请求必须保留同一个 `requestId`。创建目标前先持久化私有意图，记录输入 digest、预分配新 ID、目标和阶段；发布、登记、原始结果回执按阶段落盘。确认丢失后重放相同请求，返回同一项目和原始回执；同 requestId 换输入报 `REQUEST_ID_REUSED`。发布后崩溃或登记失败可以依据意图与实际文件/登记对账，不再生成第二份项目。目标已由自己的宿主打开时，可信登记和文件身份用于回执重放，不二次打开活跃数据库。目标被移动、删除或身份不匹配时拒绝，不重新创建或覆盖。

## 应用级接口

契约位于 `packages/contracts/src/project-backups.ts`，私有 JSON 记录位于 `project-backup-records.ts`，均按路径导入。四个操作加入应用级白名单，使用 **`POST /api/rpc`**；它们虽然带 projectId，仍是应用操作。列表、只读查看、状态和从备份恢复都不 acquire 原项目。

| 操作 | 严格输入 | 结果 |
| --- | --- | --- |
| `project.backup.list` | `{projectId}` | `{projectId, backups}`，最多三份有效副本；每份含 backupId、projectId、contentSequence、createdAt、reason（open/close）、sizeBytes |
| `project.backup.inspect` | `{projectId, backupId}` | 该份摘要，加 projectName、sourceProjectDir 和 tableCounts；只读摘要，不返回数据库句柄或完整媒体 |
| `project.backup.restore` | `{projectId, backupId, requestId, projectFile}` | `{requestId, sourceProjectId, backupId, project}`；project 为新项目的登记回执 |
| `project.backup.status` | `{projectId}` | state、lastAttemptAt、lastCompletedAt、lastError；state 为 idle/running/slow/failed |

ID 使用小写 UUID；`projectFile` 必须是新的、规范化的绝对 `.mioon` 路径，父目录已存在，目标不能处于应用私有记录/缓存/暂存目录，文件名不能以 `.` 开头。没有隐式的恢复目标或覆盖模式。HTTP 使用现有认证和 `{ok:true,data}` / 错误 envelope。

列出备份的请求体示例：

```json
{"operation":"project.backup.list","input":{"projectId":"9c9f99a7-20ee-479a-8da2-e4bfa034d355"}}
```

恢复请求体示例（路径和 ID 换成实际值）：

```json
{"operation":"project.backup.restore","input":{"projectId":"9c9f99a7-20ee-479a-8da2-e4bfa034d355","backupId":"89ee1597-318e-49c8-9c3a-6501af95c656","requestId":"23cdbb73-5013-4f21-924a-1643dcba352e","projectFile":"/private/tmp/recovered/project.mioon"}}
```

CLI 使用相同 JSON 输入和后端连接配置：

```sh
node apps/cli/src/index.ts project backup list --input '{"projectId":"9c9f99a7-20ee-479a-8da2-e4bfa034d355"}'
node apps/cli/src/index.ts project backup status --input '{"projectId":"9c9f99a7-20ee-479a-8da2-e4bfa034d355"}'
```

MCP 名称为 `project_backup_list`、`project_backup_inspect`、`project_backup_restore`、`project_backup_status`，参数与表格一致。它们通过 client 的同一 schema/discovery 暴露，不加入内置 Mio 的模型工具目录；本卡不改 agent 实现或 99 条请求指纹。

常见错误包括 `PROJECT_BACKUP_NOT_FOUND`、`PROJECT_BACKUP_INDEX_INVALID`、`PROJECT_BACKUP_INVALID`、`PROJECT_BACKUP_CHANGED`、`PROJECT_BACKUP_COPY_FAILED`、`PROJECT_BACKUP_RESTORE_CHANGED`、`PROJECT_BACKUP_RESTORE_BUSY`、`REQUEST_ID_REUSED` 和 `PROJECT_FILE_EXISTS`。客户端不会在断连后自动重发恢复；错误保留 requestId 和“可能已完成”的信息，调用方用原输入明确对账。

## 失败、慢备份和已知边界

备份 hook 捕获自身已经结束的复制、校验、发布和清理失败，写安全错误码和通用说明后正常返回，不使打开或关闭失败。状态写失败还有本地结构化警告兜底，不记录原始异常、路径堆栈或秘密。重启发现旧 running/slow 状态时返回 `PROJECT_BACKUP_INTERRUPTED`，不假称上次仍在运行。

原生 SQLite backup 没有已验证的取消接口。超过 10 秒报告 slow，仍完整等待原生操作结束；不使用 Promise.race 让关闭先走，不引入原生依赖，也不承诺慢 I/O 下的关闭时限。关闭开始时宿主信号已经中止，不以该信号取消关闭前备份。

服务端已有的 5 秒总停机预算仍适用：很慢的备份可能使应用 `close()` 报 `SERVER_STOP_TIMEOUT`。这不是备份取消成功；项目管理器仍等待原生结束，不据此提前关闭 SQLite 或释放应用锁。不要把停机超时当作已经安全退出。

当前去重只比较内容序号。**两份副本序号相同、实际内容不同的分叉识别不出来，可能跳过备份。** 内容令牌、宿主对 file-older/file-newer 的处置以及“序号＋令牌”去重归后续 V5；本卡不改项目格式或 history 来解决该盲点。
