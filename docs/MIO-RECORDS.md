# Mio 本机记录

Mio 的新记录层位于每个项目的本机 `history.db`，与项目内容文件通过同一 SQLite 连接工作。R1-A 提供结构、仓库、修订号路由和内核升级，R1-B 提供 entries 投影、冻结请求的重建和每宿主 runtime 构造器。用量接口及规范文件分别由 R1-C、R2 完成。旧工作区入口继续使用原 journal；项目宿主通过业务层构造器选择新记录层。

## 发布前的开发数据重置

**这次升级只适用于发布前的开发数据。** S0 的 history 格式 2 升到 R1 格式 3 时，内核删除旧的 13 张 Mio 表并建立新的 `mio_*` 表。这个项目在本机的 Mio 对话、执行历史和 Mio 修改的撤销记录会清空。任务、导出、回执、时间线历史等其他领域的表和记录保留；应用库的全局放行设置不在这次重置范围内。

升级只接受已知旧版本和完整结构清单，不能用它修复任意损坏的库。它在项目宿主建立 Mio 之前、持有独占锁的同一连接中执行，一个事务完成，版本最后写入；失败回滚。未知结构和未来版本仍拒绝打开。项目文件与本机记录的内容序号不一致时，先完成 S0 的外部变更处置，不能用升级把差异掩盖成“当前”。

发布之后的结构升级必须无损保留用户数据，不能继续使用这次开发期领域重置。

## 记录结构

`schema/domains/mio.ts` 定义 18 张表：

- `mio_conversations`、`mio_runs` 保存身份、状态、预算和引用。
- `mio_entries` 追加语义内容，`mio_blobs` 按内容哈希去重，`mio_steps` 保存步骤和来源引用。
- `mio_requests` 保存请求装配版本、原字节哈希、输入清单与派发状态。完整模型输出和步骤完成证据提交成功后，同事务清原件；失败或未知仍保留。
- `mio_changes`、`mio_controls`、`mio_control_states` 保留变化和控制回执语义。
- `mio_imports`、`mio_job_origins` 保存附件与后台工作归属。
- `mio_edit_claims`、`mio_edit_owners`、`mio_edit_receipts` 保存编辑占用与回执。
- `mio_conversation_policies`、`mio_conversation_policy_requests` 保存对话级放行覆盖及其回执。
- `mio_events` 仅通知某一轮有变化，不复制正文或模型请求。
- `mio_process_target_revisions` 保存四类过程实体的修订号。

仓库写入必须在调用方的项目事务内进行，使项目变化和 Mio 证据一起提交；读取不写库。内容引用、归属、哈希和状态转换都在仓库和数据库约束中验证。开发阶段暂用每项目 256 MiB / 20000 行的执行记录保护，最终配额由 R1-C 在改后 stress30 测量后确定；本 PR 不宣称已达到 100 轮目标。

## 过程修订不再修改项目文件

`job`、`export`、`image_task`、`frame_task` 的修订号由本机表记录，12 个触发器在 history 内执行。内容实体继续使用项目文件中的 `agent_task_target_revisions_v2`，该表不改名。

升级或新建本机记录时，项目文件中旧的四类过程修订行会被清除，本机从头记录，不迁移旧墓碑。存在旧行时，这次清理只推进一次项目内容序号；没有旧行则不推进。日常过程进度、删除与重建的修订变化都只写本机记录，删除后保留本机墓碑以检测 ABA。内容变化仍正常推进项目内容序号。

## 与 S0 的分工

R1-A 在 S0 P1 的内核和固定格式 72 推导工具上实现窄升级、新 Mio 领域及过程修订路由。S0 P2 负责现有 Mio 文件中的八处表探测和应用授权范围，本 PR 保留这些函数。R1-B 再接入 S0 修改后的运行时和宿主。

R1 的 PR 可以先取得 CI 和审查，但须等待 S0 P4 合入后，合进最新 main 并再次通过 CI，再由协调人合并。

## 冻结装配与原件生命周期

`mio-journal.ts` 从规范 entries 投影当前运行、步骤和历史，不把整段运行或事件正文反复写回。模型的原 provider output 是规范来源；文本、工具调用和来源能力从它与该请求的冻结视图派生。未完成模型只保存当前 partial 检查点，`mio_events` 只保存轮次、序号和时间，SSE 仍返回经过脱敏的快照。

`mio-assembly.ts` 的 collector 在 intent 事务中冻结配置、有效协议包装、工具 schema、baseline 和 entry 来源。描述符按 entry 身份和 JSON 路径引用正文、思考签名及原参数字符串，保留字段顺序和确定的压缩视图。纯函数 `assembleRequest(version, snapshot)` 只序列化冻结值，不读取数据库、文件、当前配置或目录，也不生成时间和身份。清原件后，重建需逐项验证来源和内容哈希，再核对请求字节数与 SHA-256；缺引用、损坏或未知版本都报错，不返回近似请求。

成功指完整且合法的模型响应已经归档，不能以 HTTP 200、首段 delta 或部分工具调用作为成功。输出 entry、步骤完成、partial 清除和原件删除在同一项目事务提交；工具批即使还待批准，也继续引用原请求的冻结 schema 和 baseline。失败、截断、超时和未知结果保留原件，不自动重发。

只有能够证明从未派发的旧装配 intent 才能升级。版本链保留旧 hash、字节数和输入范围，追加 `request_reassembled` 记录；同一逻辑步骤不重复计步，也不吸收后来的说明或配置。任何已越过派发边界的请求保留派发证据，不因步骤状态回到 intent 就允许重装。

## 每宿主运行时

`mio-runtime.ts` 的 `createMioRuntime` 接受真实内核 `ProjectStore`、设置与授权端口、工具、网关和全局 policy 的结构型端口，复用现有执行引擎。每次构造拥有独立的 executor、取消和关闭状态，不引用 server 类型，不打开第二条数据库连接。`createMioRuntimePort` 再接收调用方提供的 HTTP/SSE 适配器，返回 `handle`、`isBusy`、`interrupt`、`drain`、`dispose` 五方法；中断同时关闭流和 executor，排空等待两者结束。

宿主先 interrupt，再 drain，最后 dispose 并关闭自己持有的 store；runtime 不替宿主关闭连接。S0 最终 composition、项目租约与 HTTP/SSE 接线仍由 S0 收尾。R1-A 与 R1-B 须在 S0 P4 后接连合入，不能单独部署只含新表而仍使用旧 journal 的中间状态。
