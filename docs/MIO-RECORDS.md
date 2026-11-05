# Mio 本机记录

Mio 的新记录层位于每个项目的本机 `history.db`，与项目内容文件通过同一 SQLite 连接工作。R1-A 提供结构、仓库、修订号路由和内核升级，R1-B 提供 entries 投影、冻结请求的重建和每宿主 runtime 构造器，R1-C 提供每轮用量、项目存储清单及配额实测。R2 增加项目规范、应用级用户规范、信任与每轮冻结，只接新项目路径。旧工作区入口已随 S7 退役。

## 发布前的开发数据重置

**S0 旧表重置只适用于发布前的开发数据。** S0 的 history 格式 2 升到当前格式 8 时，内核删除旧的 13 张 Mio 表并建立新的 `mio_*` 表。这个项目在本机的 Mio 对话、执行历史和 Mio 修改的撤销记录会清空。任务、导出、回执、时间线历史等其他领域的表和记录保留；应用库的全局放行设置不在这次重置范围内。

已知 R1 history 格式 3 升到 4 则保留所有记录，只增加单行存储计数表并替换配额触发器。新建与升级都在同一事务内按完整记录初始化计数，版本最后写入；格式 3 的精确 manifest 白名单也须通过，不能把任意旧结构当成可升级数据。

R2 的 history 格式为 5：已知格式 4 经完整清单核对后无损增加 `mio_rule_writes`，不重置 R1 对话或原件。应用库从精确格式 2 升到 3，只增加 typed `user_rules` 单行表；用户规范、信任和应用回执不放进项目连接。两处升级均在所属连接的事务内完成，版本最后写入。

V1-A 引入 history 格式 **6**，在 R2 后增加独立 `versions` 领域的四表：`project_versions`、`project_version_blobs`、`project_version_requests`、`project_version_capture_marks`。精确已知格式 2、3、4、5 均可直接升级到 6；格式 2 沿用上述开发期重置，3–5 保留原 Mio 记录和原件，按原格式补齐规则写入/计数及版本领域。当时项目文件和 cache 为格式 1。Mio 存储清单与配额只统计 Mio 领域，不把版本 BLOB 算入 Mio 用量。

版本接口提供 `project.version.list/save/preview/restore`；Mio 每轮首次内容修改前自动保存，恢复后沿用目标修订与既有撤销规则，不主动标记 Mio change。完整内容范围、回执和差异语义见 [PROJECT-VERSIONS.md](PROJECT-VERSIONS.md)。版本四项与备份四项虽已合入契约根注册表，但都在内置 Mio 禁用列表中，模型请求字节保持不变。

升级只接受已知旧版本和完整结构清单，不能用它修复任意损坏的库。它在项目宿主建立 Mio 之前、持有独占锁的同一连接中执行，一个事务完成，版本最后写入；失败回滚。未知结构和未来版本仍拒绝打开。V5 不再因旧 history 序号与文件不等而拒绝窄升级：精确升级后进入恢复会话，不能把缺令牌或序号差异掩盖成“当前”。

G1a 合入后的当前格式为项目 **3**、history **10**、cache **2**。项目新增 `contentToken`，history 新增 `seenContentToken`；内容身份是序号与令牌的完整 pair。独立冻结的 history 2–9 均可精确直升 10，版本最后写；2 保留上述开发期 Mio reset，3–9 保留原 Mio 记录和原件，6–9 还原样保留版本 blob、版本行、请求与自动标记。2–7 的旧源没有令牌时写 NULL，不伪造当前令牌；8→10 新增空草稿域并重建图片审核约束，9→10 只重建图片审核约束以接纳带服务 UUID 的 v6 意图，不修改原 JSON、rowid、草稿、内容 pair 或执行记录。

| 打开结果 | Mio 行为 |
| --- | --- |
| fresh/current | 只有完整 pair 一致或真正没有本机 history 才构造运行时，沿用现有 recover、修订/ABA、撤销与配额规则。 |
| diverged | 文件序号较小、较大、同序号异令牌、旧 history 无令牌均进入恢复会话，不构造 Mio/worker，不继续请求、对账或撤销；序号大小不证明先后。 |
| invalid | 同令牌异序号、非法字段或结构损坏确切拒绝，不建立可写宿主。 |

用户确认继续当前文件或恢复版本时，旧 history 整份成为只读诊断归档，新 history 仅带版本 blob 和版本行，不带旧请求回执/自动标记。旧 Mio 对话、撤销、生成任务和未知结果都留在归档，不会自动续跑；确认页列出已提交服务商但结果未知的任务数。版本行的 `mioRunId` 原值保留为来源标识，history 8 起不再以它引用新库中的可执行 Mio run。新的 Mio 执行域为空，不需要修改 agent 校验、恢复或撤销逻辑。项目格式 1/2 则零写入拒绝，不因 history 可升级而获得物理项目转换资格。

发布之后的结构升级必须无损保留用户数据，不能继续使用这次开发期领域重置。

## 记录结构

`schema/domains/mio.ts` 定义 20 张表：

- `mio_conversations`、`mio_runs` 保存身份、状态、预算和引用。
- `mio_entries` 追加语义内容，`mio_blobs` 按内容哈希去重，`mio_steps` 保存步骤和来源引用。
- `mio_requests` 保存请求装配版本、原字节哈希、输入清单与派发状态。完整模型输出和步骤完成证据提交成功后，同事务清原件；失败或未知仍保留。
- `mio_changes`、`mio_controls`、`mio_control_states` 保留变化和控制回执语义。
- `mio_imports`、`mio_job_origins` 保存附件与后台工作归属。
- `mio_edit_claims`、`mio_edit_owners`、`mio_edit_receipts` 保存编辑占用与回执。
- `mio_conversation_policies`、`mio_conversation_policy_requests` 保存对话级放行覆盖及其回执。
- `mio_events` 仅通知某一轮有变化，不复制正文或模型请求。
- `mio_process_target_revisions` 保存四类过程实体的修订号。
- `mio_storage_counters` 保存项目 Mio 领域的字节/行增量计数，单行自身计 0 个逻辑字节、1 行。
- `mio_rule_writes` 保存规范写入的持久 intent、批准来源、前后 hash/blob 引用、文件发布证据和对账状态，不保存一份新的规范正文。

仓库写入必须在调用方的项目事务内进行，使项目变化和 Mio 证据一起提交；读取不写库。内容引用、归属、哈希和状态转换都在仓库和数据库约束中验证。执行记录限额已定为每项目 256 MiB / 65,536 行，单行 2 MiB；[stress30 测量](verification/mio-harness/R1-C-STORAGE.md) 分列字节、行和异常余量，计数表自身 1 行计入冷启动成本。

## 过程修订不再修改项目文件

`job`、`export`、`image_task`、`frame_task` 的修订号由本机表记录，12 个触发器在 history 内执行。内容实体继续使用项目文件中的 `agent_task_target_revisions_v2`，该表不改名。

真正新建 history，或用户确认切换到新 history 时，项目文件中旧的四类过程修订行会被清除，本机从头记录，不迁移旧墓碑。旧 history 升级后尚未确认时保持 diverged，不清理项目过程证据。存在旧行时，这次清理在准入/处置事务内只推进一次项目内容序号并换新令牌、同步 seen pair；没有旧行则不推进。R1 格式 3 到 4 保留这些本机修订和全部 Mio 记录。日常过程进度、删除与重建的修订变化都只写本机记录，删除后保留本机墓碑以检测 ABA。内容变化仍正常推进项目内容序号。

## 与 S0 的分工

R1-A 在 S0 P1 的内核和固定格式 72 推导工具上实现窄升级、新 Mio 领域及过程修订路由，并保留 S0 P2 负责的八处表探测和应用授权范围。R1-B 在 P2 合入后 merge main，再通过其连接身份接缝选择新 Mio 表，保留应用授权范围与全局 policy 语义。现有执行引擎在真实内核 store 下也默认创建新 journal，当前服务器项目装配因此可以消费新记录层。

S0 P4 已合入。本分支把 R1-A、R1-B、R1-C 与 P4 作为一组验证，由包含前三张卡的 R1-C PR 一起合入；不单独部署只建新表而仍读旧 journal 的中间状态。全局放行策略的 CAS 和回执继续由 B1 应用库持有，应用 doctor 使用同一份纯工具目录；文字诊断结束后仍向应用 documents 写严格五字段摘要。

项目行校验读取新的 `mio_*`，核对三库外键、内容序号、内容及过程修订、规范记录引用与哈希，并校验 B1 的全局策略和回执。doctor 使用 v2 项目清单，不把应用的两张全局表计入项目。

## 冻结装配与原件生命周期

`mio-journal.ts` 从规范 entries 投影当前运行、步骤和历史，不把整段运行或事件正文反复写回。模型的原 provider output 是规范来源；文本、工具调用和来源能力从它与该请求的冻结视图派生。未完成模型只保存当前 partial 检查点，`mio_events` 只保存轮次、序号和时间，SSE 仍返回经过脱敏的快照。

跨轮上下文只在 SQL 中提取所需的原消息、说明、回答、最终文本及有界执行摘要，不重建历史模型请求，也不把完整 provider metadata、before/after 或 undo 载入 JavaScript。详细快照和执行恢复仍按完整来源验证并重建请求。可信发送前检查拒绝请求时，只复位逻辑步骤；随后可记为失败并保留原件与派发边界，不能把明确未发送的尝试记成结果未知。

`mio-assembly.ts` 的 collector 在 intent 事务中冻结配置、有效协议包装、工具 schema、baseline 和 entry 来源。描述符按 entry 身份和 JSON 路径引用正文、思考签名及原参数字符串，保留字段顺序和确定的压缩视图。纯函数 `assembleRequest(version, snapshot)` 只序列化冻结值，不读取数据库、文件、当前配置或目录，也不生成时间和身份。清原件后，重建需逐项验证来源和内容哈希，再核对请求字节数与 SHA-256；缺引用、损坏或未知版本都报错，不返回近似请求。

成功指完整且合法的模型响应已经归档，不能以 HTTP 200、首段 delta 或部分工具调用作为成功。输出 entry、步骤完成、partial 清除和原件删除在同一项目事务提交；工具批即使还待批准，也继续引用原请求的冻结 schema 和 baseline。失败、截断、超时和未知结果保留原件，不自动重发。

只有能够证明从未派发的旧装配 intent 才能升级。版本链保留旧 hash、字节数和输入范围，追加 `request_reassembled` 记录；同一逻辑步骤不重复计步，也不吸收后来的说明或配置。任何已越过派发边界的请求保留派发证据，不因步骤状态回到 intent 就允许重装。

## 每宿主运行时

`mio-runtime.ts` 的 `createMioRuntime` 接受真实内核 `ProjectStore`、设置与授权端口、工具、网关和全局 policy 的结构型端口，复用现有执行引擎。每次构造拥有独立的 executor、取消和关闭状态，不引用 server 类型，不打开第二条数据库连接。`createMioRuntimePort` 再接收调用方提供的 HTTP/SSE 适配器，返回 `handle`、`isBusy`、`interrupt`、`drain`、`dispose` 五方法；中断同时关闭流和 executor，排空等待两者结束。

宿主先 interrupt，再 drain，最后 dispose 并关闭自己持有的 store；runtime 不替宿主关闭连接。服务器通过 P4 的项目宿主管理器持有项目租约和真实内核连接，再装配该运行时与 HTTP/SSE 端口。

## 每轮用量：规范来源与只读子资源

规范 model_output entry 保存服务方被实际报告的四字段用量。请求身份决定唯一贡献，重放不重复累加；失败、unknown 和仍在进行的派发进入覆盖分母，明确未发送的 intent 不进入。`mio_runs.usageSummary` 是同完成/失败事务更新的可重算投影，GET 始终按规范记录读取，不通过读操作补写投影。

`mio-run-usage.ts` 的严格 v1 DTO 只公开 runId、revision、派发/结果数量、逐字段 knownTotals、覆盖率/溢出和 cacheReadRate。全未知的字段为 null，明确报告零才是 0；input 包含缓存分项，不把 cache 再相加。只有 input/cache-read 完整且 input>0、read<=input 时返回命中率。无效/溢出计数不阻断任务完成，也不伪装成零。

读取地址是 `GET /api/projects/<projectId>/agent/tasks/v2/<runId>/usage`，client 使用 `usage({projectId,runId})`，经项目宿主租约进入对应处理函数，旧地址不增加 usage 入口。它不计步、不写库、不调用模型，不把原请求、provider raw usage 或其他项目记录带入响应；原有 snapshot/events/控制回执继续保持私密边界。不新增界面或 CLI 命令。

## 每项目清单与归档边界

`mio-storage.ts` 的当前严格 v3 契约用内核登记的连接与 history_state 确认 projectId，枚举全部 20 表；历史 v2 的 19 表 profile 仍可验证，不伪造不存在的规则写入表。SQL UTF-8 文本列的计量和执行配额字节式一致；唯一 blob 只计一次，失败/unknown 原件、partial、对话 policy 和回执均有真实占用。`retained.rows` 披露被执行行配额豁免的编辑回执，`usage.rows` 计入计数表自身 1 行。全局 policy 属于应用库，不计回项目。

19 个记录表的 INSERT/UPDATE/DELETE 触发器按 NEW/OLD 差额更新单行计数，受保护写入随后只查询计数判断配额。计数与检查在同一触发器内，不能依赖 SQLite 的触发器创建顺序。K1 连接启用 recursive_triggers，让 REPLACE 的隐式删除也执行计数及原证据保留约束；普通 UPSERT/IGNORE 不重复计数。计数与业务写入、回滚及强杀恢复共用同一事务。

doctor 只有在明确请求该项目时返回新项目清单；同一条 SQL 快照全量重算并核对单行计数，缺失或不一致报 `AGENT_TASK_STORAGE_CORRUPT`，不通过读取修复。client 校验版本、项目身份、闭合表名及计量等式。旧工作区诊断仍为原 v1 profile。字节计量不是 SQLite 页、索引、journal 或网络字节，四种测量分列在实测报告中。

claims、owners、edit receipts 和过程修订沿用现有写入豁免；R2 的规则写入证据也只计量、不新增执行配额拦截，供未决操作收尾。编辑回执受单条 payload 64 KiB 和单行保护，没有独立累计总量上限，新契约明确披露 null。豁免记录仍占真实逻辑字节，不能因为执行配额已满就丢弃手工回执或删除旧原件。

完整响应归档在原事务内先释放成功原件/partial，再写通知、output 与最终指针，因此近满时可按净占用完成。步骤完成通知也必须晚于原件释放，避免 partial 为空、字节配额恰好用满时被一条中间通知挡住。若归档任意位置出错或在清原件后、写输出前强杀，原件、状态、partial、entry、计数和用量投影一起回滚。SQL 完成证据约束保持，配额检查改查增量计数。

## R2：规范、信任与每轮冻结

项目规范固定为宿主 `projectDir/AGENTS.md`，不向父目录查找、不接受任意路径。项目规范和应用级用户规范各限 8192 个 UTF-8 字节，允许 tab、LF、CR/CRLF，拒绝非法控制字符、孤立代理和非法 UTF-8；不改变换行、BOM 或 Unicode 组合形式。空文本保存为零字节文件，不删除文件。读取验证普通文件、目录和打开后身份，并在同一 fd 上有界复读比较原字节，覆盖同一时钟 tick 内 stat 不变的等长改写；不安全、读取中变化、超长或解码失败时不给模型正文。

B1 的 `project_rules_trust` 按项目 ID 和实际字节 hash 记录信任。Mioon 手工保存的精确内容自动信任；外部修改后 hash 不匹配，项目规范停用，用户查看后可显式启用。用户规范由 `user_rules` 的 revision CAS 和 `app_operation_receipts` 同事务保存，默认空文本、revision 0；应用级读写不打开任何项目。

新用户轮次接受发送时冻结可信项目规范和用户规范，并引用 `mio_blobs`。该轮后续模型调用、批准续接和重放只用冻结版本；本轮获批修改的规范在下一用户轮次生效。优先级是宿主规则、本次明确请求、项目规范、用户通用规范。规范不能扩大权限；诊断不读取或注入规范。旧 `project.notes` 已随 U2-A 从当前公共 DTO、API 和界面退役，不进入新 Mio 上下文，不迁移到 AGENTS.md；已有项目 JSON、原 ACK 和冻结历史 context 原位保留，不清洗历史字节。

模型工具 `mioon_project_rules_set` 只有 `expectedHash`、`proposedText`，始终要求明确批准；模型不能传 `approved`、`trust` 或路径。旧冻结请求里的写说明调用拒绝并交回重新规划，不能沿用旧批准写文件。

文件、history 和 B1 以持久 intent 对账：同目录候选文件写完后，将原文件 rename 为备份并核对批准时的 before hash，再用 `link` 不覆盖地发布。遇到 `EEXIST` 保留双方证据并报冲突；不支持硬链接时拒绝，不退回覆盖式 rename。成功后清候选/备份，修改前正文仍由 before blob 保留。

未决状态包括 `prepared`、`publication_unknown`、`published`、`trust_pending`。重启先挂起；GET 不发布文件、不补信任，同 requestId 的保存不重试未决副作用。只有显式对账请求可根据原 intent、文件身份和 B1 回执完成已证明的发布；仅 hash 相同不能证明本次操作成功。未决写入期间，新轮次不采集该项目规范，已接受轮次仍使用自己的冻结版本。

R2 的规范 blob 和写入证据占同一项目配额。R1 的 stress30 数字仍是原负载历史基准；不能据此声称任意规范长度、修改次数或异常历史的 R2 容量不变。

## 交给 U2 的接口

契约位于 `@mioon/contracts/mio-rules`，Node 管理 client 位于 `@mioon/client/project-rules`，不加入 RPC/MCP 操作目录。项目端点绑定地址中的项目身份，输入不重复接收 projectId：

| 方法和地址 | 输入 | 成功数据 |
|---|---|---|
| `GET /api/projects/<id>/rules` | 无 | 项目规范快照 |
| `PUT /api/projects/<id>/rules` | `{requestId, expectedHash: hash或null, text}` | 项目规范快照 |
| `POST /api/projects/<id>/rules/enable` | `{requestId, expectedHash: hash}` | 项目规范快照 |
| `GET /api/projects/<id>/rules/requests/<requestId>` | 无 | 写请求查证结果 |
| `POST /api/projects/<id>/rules/requests/<requestId>/reconcile` | `{}` | 写请求查证结果 |
| `GET /api/user-rules` | 无 | 用户规范快照 |
| `PUT /api/user-rules` | `{requestId, expectedRevision, text}` | 用户规范快照 |
| `GET /api/user-rules/requests/<requestId>` | 无 | 用户规范请求查证结果 |

项目快照严格包含 `projectId,file,exists,text,hash,trust,maxBytes,readError,pendingWrites`；`file` 固定 `AGENTS.md`。trust 是 `trusted/untrusted/absent/unavailable/pending`；不可读正文与 hash 为 null，readError 是闭集，响应不含真实路径、候选或备份名。用户快照是 `text,revision,updatedAt,maxBytes`。

项目查证结果为 `not_applied/applied/uncertain`，绑定项目 ID 和 requestId，只有 applied 返回严格快照；uncertain 返回已知写入状态。用户规范只有同事务的 applied/not_applied。client 提供 `get/save/enable/lookup/reconcile/getUser/saveUser/lookupUser`，拒绝额外字段和跨项目响应；丢失或无法验证写响应时保留原 requestId 与 GET 查证地址，不自动重发或对账。U2 仍负责真实页面、提示和批准卡接线。
