# Mio 本机记录

Mio 的新记录层位于每个项目的本机 `history.db`，与项目内容文件通过同一 SQLite 连接工作。R1-A 提供结构、仓库、修订号路由和内核升级，R1-B 提供 entries 投影、冻结请求的重建和每宿主 runtime 构造器，R1-C 提供每轮用量、项目存储清单及配额实测。规范文件由 R2 单独实施。旧工作区入口继续使用原 journal；项目宿主通过业务层构造器选择新记录层。

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

仓库写入必须在调用方的项目事务内进行，使项目变化和 Mio 证据一起提交；读取不写库。内容引用、归属、哈希和状态转换都在仓库和数据库约束中验证。开发阶段仍用每项目 256 MiB / 20000 行的执行记录保护；[改后 stress30 测量与配额候选](verification/mio-harness/R1-C-STORAGE.md) 已分列字节、行和异常余量，最终数字由协调人选择。现有 20000 行不能承诺 100 个同等完整轮次。

## 过程修订不再修改项目文件

`job`、`export`、`image_task`、`frame_task` 的修订号由本机表记录，12 个触发器在 history 内执行。内容实体继续使用项目文件中的 `agent_task_target_revisions_v2`，该表不改名。

升级或新建本机记录时，项目文件中旧的四类过程修订行会被清除，本机从头记录，不迁移旧墓碑。存在旧行时，这次清理只推进一次项目内容序号；没有旧行则不推进。日常过程进度、删除与重建的修订变化都只写本机记录，删除后保留本机墓碑以检测 ABA。内容变化仍正常推进项目内容序号。

## 与 S0 的分工

R1-A 在 S0 P1 的内核和固定格式 72 推导工具上实现窄升级、新 Mio 领域及过程修订路由，并保留 S0 P2 负责的八处表探测和应用授权范围。R1-B 在 P2 合入后 merge main，再通过其连接身份接缝选择新 Mio 表，保留应用授权范围与全局 policy 语义。现有执行引擎在真实内核 store 下也默认创建新 journal，当前服务器项目装配因此可以消费新记录层。

R1 的 PR 可以先取得 CI 和审查，但须等待 S0 P4 合入后，合进最新 main 并再次通过 CI，再由协调人合并。

## 冻结装配与原件生命周期

`mio-journal.ts` 从规范 entries 投影当前运行、步骤和历史，不把整段运行或事件正文反复写回。模型的原 provider output 是规范来源；文本、工具调用和来源能力从它与该请求的冻结视图派生。未完成模型只保存当前 partial 检查点，`mio_events` 只保存轮次、序号和时间，SSE 仍返回经过脱敏的快照。

`mio-assembly.ts` 的 collector 在 intent 事务中冻结配置、有效协议包装、工具 schema、baseline 和 entry 来源。描述符按 entry 身份和 JSON 路径引用正文、思考签名及原参数字符串，保留字段顺序和确定的压缩视图。纯函数 `assembleRequest(version, snapshot)` 只序列化冻结值，不读取数据库、文件、当前配置或目录，也不生成时间和身份。清原件后，重建需逐项验证来源和内容哈希，再核对请求字节数与 SHA-256；缺引用、损坏或未知版本都报错，不返回近似请求。

成功指完整且合法的模型响应已经归档，不能以 HTTP 200、首段 delta 或部分工具调用作为成功。输出 entry、步骤完成、partial 清除和原件删除在同一项目事务提交；工具批即使还待批准，也继续引用原请求的冻结 schema 和 baseline。失败、截断、超时和未知结果保留原件，不自动重发。

只有能够证明从未派发的旧装配 intent 才能升级。版本链保留旧 hash、字节数和输入范围，追加 `request_reassembled` 记录；同一逻辑步骤不重复计步，也不吸收后来的说明或配置。任何已越过派发边界的请求保留派发证据，不因步骤状态回到 intent 就允许重装。

## 每宿主运行时

`mio-runtime.ts` 的 `createMioRuntime` 接受真实内核 `ProjectStore`、设置与授权端口、工具、网关和全局 policy 的结构型端口，复用现有执行引擎。每次构造拥有独立的 executor、取消和关闭状态，不引用 server 类型，不打开第二条数据库连接。`createMioRuntimePort` 再接收调用方提供的 HTTP/SSE 适配器，返回 `handle`、`isBusy`、`interrupt`、`drain`、`dispose` 五方法；中断同时关闭流和 executor，排空等待两者结束。

宿主先 interrupt，再 drain，最后 dispose 并关闭自己持有的 store；runtime 不替宿主关闭连接。S0 最终 composition、项目租约与 HTTP/SSE 接线仍由 S0 收尾。R1-A 与 R1-B 须在 S0 P4 后接连合入，不能单独部署只含新表而仍使用旧 journal 的中间状态。

## 每轮用量：规范来源与只读子资源

规范 model_output entry 保存服务方被实际报告的四字段用量。请求身份决定唯一贡献，重放不重复累加；失败、unknown 和仍在进行的派发进入覆盖分母，明确未发送的 intent 不进入。`mio_runs.usageSummary` 是同完成/失败事务更新的可重算投影，GET 始终按规范记录读取，不通过读操作补写投影。

`mio-run-usage.ts` 的严格 v1 DTO 只公开 runId、revision、派发/结果数量、逐字段 knownTotals、覆盖率/溢出和 cacheReadRate。全未知的字段为 null，明确报告零才是 0；input 包含缓存分项，不把 cache 再相加。只有 input/cache-read 完整且 input>0、read<=input 时返回命中率。无效/溢出计数不阻断任务完成，也不伪装成零。

读取地址是 `GET /api/projects/<projectId>/agent/tasks/v2/<runId>/usage`，client 使用 `usage({projectId,runId})`。S0 P4 前复用 K2 的项目地址映射与现有 handler，旧地址不增加 usage 入口。它不计步、不写库、不调用模型，不把原请求、provider raw usage 或其他项目记录带入响应；原有 snapshot/events/控制回执继续保持私密边界。不新增界面或 CLI 命令。

## 每项目清单与归档边界

`mio-storage.ts` 的严格 v2 契约用内核登记的连接与 history_state 确认 projectId，枚举全部18表。SQL UTF-8 文本列的计量和执行配额字节式一致；唯一 blob 只计一次，失败/unknown 原件、partial、对话 policy 和回执均有真实占用。`retained.rows` 披露被执行行配额豁免的编辑回执，`usage.rows` 则按现有行配额式计算。全局 policy 属于应用库，不计回项目。

doctor 只有在明确请求该项目时返回新项目清单；client 校验版本、项目身份、闭合表名及计量等式。旧工作区诊断仍为原 v1 profile。字节计量不是 SQLite 页、索引、journal 或网络字节，四种测量分列在实测报告中。

claims、owners、edit receipts 和过程修订沿用现有写入豁免；回执受单条 payload 64 KiB 和单行保护，没有独立累计总量上限，新契约明确披露 null。它们仍占真实逻辑字节，不能因为执行配额已满就丢弃手工回执或删除旧原件。

完整响应归档在原事务内先释放成功原件/partial，再写通知、output 与最终指针，因此近满时可按净占用完成。步骤完成通知也必须晚于原件释放，避免 partial 为空、字节配额恰好用满时被一条中间通知挡住。若归档任意位置出错或在清原件后、写输出前强杀，原件、状态、partial、entry 和用量投影一起回滚。SQL 限额和完成证据约束没有移除，开发配额常量也没有改变。
