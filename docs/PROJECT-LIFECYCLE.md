# 项目重命名与永久删除

`project.rename` 与 `project.delete` 经同一 operation 契约接入 HTTP、CLI 和 MCP。内置 Agent 模型工具不包含这些操作。界面必须在危险确认后发送删除请求。

## 公共契约

重命名传入 `requestId`、`projectId`、`expectedRevision` 和 `name`。名称首尾空白被移除，限 1–150 字符；成功后项目 revision 加一并更新业务时间。同一请求精确重放原回复，改变内容复用请求 ID 则冲突。

永久删除传入 `requestId`、`projectId`、`expectedRevision` 和 `confirmPermanentDeletion: true`。删除成功返回：

```json
{"requestId":"…","projectId":"…","deleted":true,"cleanup":"complete"}
```

`cleanup: "pending"` 表示项目数据库记录已经删除，但本地文件或项目草稿仍待确认清理。此时必须明确展示未完成的清理，并保留原请求 ID；精确重放只继续本地清理，不生成新任务。连接中断或回复丢失也使用原请求 ID 查询结果。

## 准入与事务

普通工作区从严格分类的 schema44 迁移到 schema48；旧 schema44/恢复45 的固定定义不获得删除权限，opacity 候选46/47保持独立。

删除前重新读取项目版本、所有任务状态、跨项目引用与三个项目草稿 companion。拒绝运行、排队、结果未知或待恢复/待对账任务；本地停止等待但已经提交的供应商任务仍拒绝删除。聊天的未知模型提交、未决修改建议、未决本地编辑、图像/抽帧恢复和波形解码同样受此门约束。已有异步服务调用、HTTP/SSE/媒体响应或媒体子进程在途时拒绝删除，不取消其它工作。

单个同步 `BEGIN IMMEDIATE` 事务内再次核查，并为本项目实际拥有的每一条待删除记录授予 `(tableName, rowid)` 范围。原 retain 触发器只允许该精确记录在此事务内删除；其它记录仍受保护。外键始终开启，环形图像/聊天关系仅延迟到本事务结束检查。事务删除项目记录、相关历史与回复，同时提交不含项目文本的删除回执与清理 manifest，移除全部临时范围，再进行外键检查。崩溃会回滚未提交范围；启动和固定 schema 分类都拒绝残留范围。

共享聊天 quota 只扣除此项目的已终态 thread/request/run/event/step 计量；其它项目日志及全局计量保持有效。跨项目业务 JSON 中仍引用本项目资源时拒绝删除，避免留下历史非 FK 关系的悬空引用。

## 文件和草稿清理

数据库提交后，清理 manifest 才能移除独占托管文件。文件来自已登记素材、精确任务 ID 对应的图像/抽帧 staging，以及与冷备份 inventory 相同的精确视频/导出任务命名。没有匹配所有权的目录内容不删除。每个文件固定相对路径、设备/inode、大小和时间身份；普通文件、目录、账户权限及共享引用都会重新校验，删除后同步父目录。符号链接、硬链接、被替换文件或出现新共享引用时保留文件并保持 `pending`。

`local-drafts-v1.json`、`local-delivery-v1.json` 和 `local-shot-text-v1.json` 通过各自经过校验的原子持久化方法，仅移除该项目条目。未决 intent、在途提交或不确定保存会阻止删除；清理失败保留 manifest，下一次普通后端启动绑定 companions 后重新清理。外观偏好只移除该项目的 `recentOpened` 键；全局外观、Agent 设置、Agent 授权不变。旧 last-project 仅含 opaque ID，沿用明确的 `missing` 状态，不会重开不存在的项目。

外部源文件、其它项目的共享文件、无法归属的文件和原有备份保留。此操作不提供归档、回收站或存储介质安全擦除。

## 备份恢复

schema48 冷备份恢复到固定 schema49 / `restored-local-v13`。恢复保留删除回执/未完成清理 manifest 的原字节作为冻结证据，但不授予清理执行、重命名或永久删除能力。原时间线 ripple、音频角色、volume envelope、色彩与 LUT 读取能力按准确的恢复 profile 保留。

## 验证

针对性测试为 `tests/project-lifecycle.test.mjs`、`tests/workspace-project-lifecycle-schema.test.mjs` 和 `tests/project-lifecycle-transports.test.mjs`，包含终态项目删除、任务拒绝、跨项目保护、受控触发器/FK、项目草稿、提交前后崩溃、真实 SIGKILL 恢复与三传输精确重放。最终执行结果以 `docs/verification/mioon-redesign/` 的验收记录为准。
