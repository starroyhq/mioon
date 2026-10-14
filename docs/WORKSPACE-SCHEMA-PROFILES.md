# 工作区固定 schema / profile 边界（S 前置片）

基线：`0343ed390a85c319210b5f179180cf9c8c3985c2`。这是统一响度原子应用之前的兼容保护；本片不新增编辑操作，不写入 26/27 marker，也不执行新迁移。2026-10-14 已通过独立最终 typecheck 与串行全量核验。

## 角色与入口

| 实际库证据 | 普通启动角色预检 | 离线恢复的完整结构检查 |
| --- | --- | --- |
| 无 marker 表、空 marker、已知 1–24 缺号 | 保留原普通 bootstrap / repair 资格 | 仍按既有严格固定 SQL / 连续 marker 规则，不由宽松角色结果授权 |
| 明确 25，或恢复元数据/guard/executionEpoch 残留 | 必须进入原恢复校验，失败不回退普通初始化 | 只接受完整固定 `restored-local-v1`，来源 schema24、恢复 schema25 |
| 26、27、未知整数、0/负数、混入未知 marker | 拒绝，不按数值大小猜 ordinary/restored | 拒绝 |
| marker 表型未知、DDL 超限不可读；edit_tasks DDL 不可读 | 拒绝 | 拒绝 |

`detectWorkspaceRestoreEvidence` 保持原布尔返回 API；新 TS 内部角色不进入旧 DTO。`false` 只表示未发现恢复/未知版本证据，不证明任意普通表结构安全。完整离线分类仍逐项比较固定表、索引、trigger 和来源绑定。

角色检测使用 `main.sqlite_schema` / `main.schema_version`，不会被 TEMP 同名表替代；名字按 SQLite 的 ASCII 大小写规则识别。marker 表经固定 `INTEGER PRIMARY KEY` DDL 检查后，只读取不在固定 1–24 集合的最多两行。已知值最多24个，因此这不是将无限 marker 全部 materialize 后再截断。表目录沿原1024项和单条128KiB SQL上限；超限不猜普通角色。

同一预检覆盖：
- `openStore`：拒绝发生在普通 bootstrap 和业务 worker 之前。既有 WAL/连接 PRAGMA 可能已执行，保证是逻辑 schema/记录/回执/约束不变，不声称 DB/WAL 物理字节不变。
- `getWorkspaceRestoreContext`：沿原原生 SQLite prepare 和 WeakMap 身份检查；未知角色映射 `RESTORE_STORE_UNVERIFIED`。
- backup create：只检查私密副本；未知角色沿现有错误屏蔽映射 `WORKSPACE_BACKUP_IO`，不会创建目标。完整恢复分支仍是 `RESTORE_BACKUP_UNAVAILABLE`。
- legacy migration：消费/目标创建前拒绝；未知角色为 `RESTORE_SCHEMA_UNSUPPORTED`。
- offline restore：完整固定来源校验拒绝，公开错误为 `WORKSPACE_RESTORE_SOURCE_SCHEMA_UNSUPPORTED`。原来源与 backup 的内容、权限保持。

## 冻结 24 / 25，而不是复制一个最新构造器

`initializeWorkspaceSchemaThrough24` 与旧 `initializeLegacyWorkspaceSchema` 是同一个固定函数。旧 SQL/事务/repair 正文不变，原 schema-only 模块成为历史版本的单一实现；未来普通迁移必须放在独立 initializer，不能继续向 through24 追加版本。

固定闭包包括 edit-task、subtitle、subject、image、review、Comfy、frame、timeline-format、Agent proposal 的历史构造。DDL 所用 inspection expression / 64KiB version 上限、frame profile / selection rule 和13个 frame 容量常量已移到固定 literal TS 模块，不再引用活动业务常量。没有复制整个业务系统或 contracts。

恢复 v25 的 metadata、families、guards、Mock 结构、unique-key 推导与 cache 仍归同一历史模块；参考库明确由 through24 构建。未来恢复 profile 不可复用/修改该模块级缓存来伪装新版本。

维护门：固定声明 body hash、精确 import/re-export 白名单、禁止动态依赖、独立 raw SQL/记录 golden。它们用于阻止维护回归，不是运行时防篡改承诺。应用仍信任其安装包源码。

## 独立证据与历史边界

`tests/fixtures/workspace-schema-profiles/` 从固定 0343 的 `git show` 源码在独立临时树生成，测试运行时不使用被测构造器生成 expected。31个合成 profile、424个去重原始 SQL 对象覆盖 ordinary1–24、ordinary24/restored25 的空/有记录/Mock组合。

- ordinary1 是第一批初始化 SQL 中 marker2 之前的合成 checkpoint，不冒称取得了一个真实历史发布二进制。
- 对比原始 SQL、text/blob/null/real/integer、超安全整数 rowid、AUTOINCREMENT 高水位、receipt/history/approval 字节；不先 JSON parse/stringify 旧值后再宣称字节保留。
- 已有历史冻结入口测试仍是旧源码入口加精确下游探针；不是完整旧打包二进制。
- 本片保留现有恢复只读归档、继承任务隔离、本地编辑导出权限与不能再次创建可恢复备份的边界。

因果红例已保留：旧 `>=25` 把未知未来版本误当恢复角色；非标准 marker DDL 可跳过检查；独立 review 再发现超长 edit_tasks DDL 可隐藏部分恢复 epoch。修复后均明确拒绝。测试编写时两处 fixture 错误（完整 frame 业务常量与固定 DDL 子集混比、使用 SQLite 保留的 `sqlite_` 名）也保留红日志，未改业务断言掩盖。

本轮实际结果：
- 49 个受影响测试文件：598/598，0失败、0跳过，86.54秒；完整 strict typecheck exit0。
- Linux production `package:linux` 和 ASAR/tar/许可/外置字体 inspector 均 exit0；前端原构建输出逐文件比较在证据中记录，源码未改 UI。
- 锁定 Electron44.7.0 / Node24.21.0 / SQLite3.53.4：自有 main helper 经 utilityProcess 加载实际生产 ASAR backend。ordinary24/restored25 正常 ready、通过只读 HTTP 项目列表、stop/exit0；26/27 从未 ready，BACKEND_START_FAILED/exit1；四库锁均释放，原 schema/项目记录保持。
- 此门是非 GUI backend 运行验证，不宣称本轮重新做完整桌面编辑/媒体或 Mac/Windows 验收。
- 首次 shell 探针存在无 DISPLAY/D-Bus 接入日志；更具体原因还包括 helper 用 Electron 的透明 ASAR fs 读取归档本体发生 ENOENT，故未到测试阶段。原 session以Ctrl+C结束exit130；云桌面第一次探针同样无结果，人工结束即使exit0也未计通过。只将 helper 哈希读取改为 original-fs 后，从受支持云桌面终端运行同一参数完成4/4。没有改产品源码、GPU、sandbox或权限配置。

## 首次独立全量与精确 fixture 适配

首次父级全量 typecheck exit0、测试 exit1：7395项，7390通过、3失败、2既有跳过，1362784.926044ms。三项均来自同一旧 Agent gain validator 的固定依赖 hash 检查：S 修改了原先直接引用的 db、fixed-schema、restore-schema 模块；没有把新源码 hash 写进旧证据。

修正仅涉及该历史 fixture 和其 loader：补入 git c3a0a57 的五份完整旧模块（另含 image/frame schema）及九个精确直接依赖 pin，保留全部旧 source/hash、catalog、raw rows、receipts、sequence 与原七项测试正文。文件式 loader 保留旧 db/restore-schema 循环及 TS 文件语义；其余当前 helper 的传递依赖仍明确不属于完整旧打包二进制。新增旧源码篡改、直接依赖漂移和未登记 import 的拒绝负例。

loader 首次定向还发现之前未遍历的保留 local-delivery.ts 需要精确 zod 解析条目；该失败单独保留。补固定模块条目后11/11通过。产品七个源码文件及已验证 ASAR 不变，因此沿用上述实际 runtime 门，未宣称为测试 fixture 调整重新运行了原生验收。修正后10个相关消费者测试文件201/201通过、0失败/0跳过（74274.909713ms），strict typecheck exit0。第二轮父级独立 typecheck exit0、全量实际 exit0：7399项，7397通过、0失败、0取消、2既有跳过，1343943.929259ms。总数比首轮增加4项，来自新加的历史源码/依赖保留与拒绝负例；没有移除原测试或新增跳过。首轮3失败与修复中途失败日志均保留。

## 后续原子应用的边界

完整混音候选仍为 [`timeline.loudness.prepare`](TIMELINE-MIX-LOUDNESS.md) 的只读结果，`applyAllowed:false`。下一片才讨论新的 durable intent / exact replay / 原子 gain + undo，并单独审真实迁移。

拟议版本映射仅供下一片设计：ordinary26 使用1–24及26，不含25；新 restored27 使用1–24、26、27，来源26；既有 restored25 不自动升级。**这些版本本片全部拒绝。** 后续迁移失败须验证事务回滚后的逻辑 schema、原始记录、回执、索引/trigger约束不变，并覆盖重启重入；不能承诺 SQLite/WAL 文件绝对字节不变。新普通备份与相应恢复须成对交付。
