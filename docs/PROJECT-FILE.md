# 项目文件 v1：约定（草稿）
日期：2026-10-30。基线：main `15671b7c`。状态：草稿；约定要改时提给协调人。

项目文件 v1 让 `.mioon` 成为项目本身：一个 SQLite 文件只存一个项目的当前内容；Mio 记录、撤销、版本、任务、回执和草稿按项目 ID 存在本机。这份文档记下各张任务卡共同遵守的约定，名字以契约代码为准：

| 文件 | 内容 |
|---|---|
| `packages/contracts/src/project-file.ts` | 扩展名、文件夹名、四个目录、测试布局、库名、`ProjectStore`、打开结果、本机记录状态、错误码、按项目寻址的地址 |
| `packages/contracts/src/media-reference.ts` | 素材引用、指纹、素材状态、项目外位置 |
| `packages/contracts/src/project-registry.ts` | 最近项目及摘要缓存、后台任务索引、收件箱、规范信任、项目外路径确认、本机记录清单 |
| `packages/contracts/src/project-versions.ts` | 版本摘要、恢复预览、打包结果 |

这四个模块不引入 Node 的模块，网页也能导入。按路径导入，不经过 `contracts/src/index.ts`。现有的交换文件见 `PROJECT-PACKAGE.md`，由 V4 删除。

## 一个文件一个项目
- 一个 `.mioon` 恰好一个项目。项目 ID 在建文件时生成并写进文件；文件里只有一行 `projects`，ID 等于文件的项目 ID，由 K1 在结构里保证。
- 项目 ID 是小写的 UUID，即 `crypto.randomUUID()` 的写法，别的写法一律拒绝。它还用作目录名，而 macOS、Windows 默认的文件系统不区分大小写。
- `project.create` 分两层：
  - **应用级**（HTTP 的 `/api/rpc`、CLI、MCP）：建一个新文件，再初始化它。不指定位置时，网页版和无界面服务建在 `<dataDir>/projects/<项目名>/`，桌面版建在 `~/Movies/Mioon/<项目名>/`；文件夹重名时加序号。
  - **store 级**（`createServices(store)` 里的 `project.create`）：只初始化文件里唯一的一行，第二次报 `PROJECT_FILE_SINGLE_PROJECT`。
- 直接 `INSERT INTO projects` 的测试改用 `project.create`（W1）。

## 用法不变
`openStore(root)`、`createServices(store)`、`startServer({dataDir})` 的用法都不变。`dataDir` 改为应用数据目录。

## 四个目录
| 目录 | 位置 | 放什么 |
|---|---|---|
| `projectDir` | `.mioon` 所在的文件夹 | 素材引用的基准；`生成/`、`导出/`、`AGENTS.md` |
| `localDir` | `<应用数据目录>/records/<项目 ID>/` | `history.db`、`backups/`、Mio 的对话附件 `imports/`（原 `agent-imports/`） |
| `cacheDir` | `<应用缓存目录>/projects/<项目 ID>/` | `cache.db`（波形、预演缩略图） |
| `tempDir` | 应用临时目录 | 图片、抽帧、拆解的暂存 |

- `root` 保留，等于 `projectDir`。S0 把用到 `store.root` 的 29 个业务文件逐个改到四个目录之一。
- 本机记录放在 `records/`，不放在 `projects/`。网页版默认把项目建在 `<dataDir>/projects/` 下，分开以后，列项目时不会把本机记录（尤其是 `backups/` 里同 ID 的副本）当成项目。
- 文件夹名 `生成`、`导出` 固定，不随界面语言变化。
- `tempDir` 可能和项目目录不在同一个盘上，暂存文件移进项目目录时不能只靠一次改名，否则会报 `EXDEV`。
- 契约里的 `ProjectStore<Db>` 是 store 新增的部分：`db`、`root`、`projectId`、`projectFile`、四个目录、`historyState` 和 `close()`。`Db` 在后端是 `DatabaseSync`，写成类型参数是为了让契约不带 Node 的类型；`ProjectStore<DatabaseSync>` 满足业务包的 `ServiceStore`（`{db, root}`）。K1 的 store 同时保留现有 `WorkspaceStore` 的 `get`、`list`、`put`、`tx`。

### 测试布局
测试用的 store 级 `openStore(root)` 把所有目录都放在 `root` 下（`TEST_STORE_LAYOUT`）：

| | 位置 |
|---|---|
| `projectDir` | `root` |
| 项目文件 | `root/project.mioon` |
| `localDir` | `root/.mioon-store/local/` |
| `cacheDir` | `root/.mioon-store/cache/` |
| `tempDir` | `root/.mioon-store/tmp/` |

- 生产环境里后三个目录不在项目目录里，所以列项目目录、打包这类代码在测试里会多看到 `.mioon-store/`。
- 测试给目录做快照时，用 `isProjectStoreInternalEntry(entry)` 识别存储内部的条目：`.mioon-store/` 及其下的一切、`*.mioon-journal`、超级日志 `*-mj*`。超级日志的名字是项目文件名后接 `-mj`、6 位十六进制、`9`、2 位十六进制，例如 `project.mioon-mj0DA3D190E`，这是用 Node 24 自带的 SQLite 3.53 实测的。

## 一个连接，三个库
- 项目连接的主库是项目文件。本机记录以 `history` 的名字挂载，缓存库以 `cache` 的名字挂载（`PROJECT_DATABASE_NAMES`）。未加限定的表名，SQLite 依次到各个库里找，所以现有 SQL 大多不用改。
- 本机记录只挂在项目文件上一起打开，从不单独打开。跨库提交时，SQLite 把超级日志建在主库旁边；单独打开 `history.db` 时找不到它，会把半提交当成已提交，两个文件就对不上了。本机记录清单只统计大小、删除文件，不打开库。
- 应用库不挂到项目连接上，单独开一个连接。
- 项目文件和本机记录都用回滚日志模式和独占锁，打开时立即取得写锁。第二个进程打开同一个项目时报 `PROJECT_LOCKED`。
- 日志文件：
  - 单库提交后 `-journal` 留着，头部清零、旧页还在，关闭项目时才删；
  - 跨库提交后 `-journal` 截成 0 字节；
  - 超级日志只在跨库提交的过程中出现，提交中途崩溃时会留下。
- 项目打开期间单独拷走 `.mioon`，只有在两次提交之间拷出的副本才完整。

## 按项目寻址
- 项目级接口放在 `/api/projects/<项目 ID>/` 下：
  - RPC：`/api/projects/<项目 ID>/rpc`；
  - 媒体：`/api/projects/<项目 ID>/media/<素材 ID>`，按素材 ID，不按路径。现在的 `/media/<素材 ID>` 本来就按素材 ID；`?preview=1&exportId=…`（导出预览）、`?download=1&exportId=…`（命名导出下载）和 `?download` 照旧保留；
  - 其余项目级接口也移到这个前缀下，由 K2 按清单第 2 节逐个处理。`/api/timeline-audio-preview/continuous` 的路径取自契约常量，按字符串扫描找不到，也在其中。
- 跨项目的接口留在原处：项目列表、新建、打开、设置、连接等。
- 拼接和解析都用契约里的函数：

| 函数 | 作用 |
|---|---|
| `projectRpcPath(projectId)` | `/api/projects/<项目 ID>/rpc` |
| `projectMediaPath(projectId, assetId)` | `/api/projects/<项目 ID>/media/<素材 ID>`；查询参数由调用方照旧加 |
| `projectApiPath(projectId, ...segments)` | 其余接口。每段做百分号编码，不能为空，不能是 `.`、`..`，不能含斜杠 |
| `parseProjectApiPath(pathname)` | 严格解析，得到 `rpc`、`media` 或 `other`；不合规则时返回 `null` |

- 解析只接受 `URL.pathname`。项目 ID 必须是小写 UUID；之后的每段不能为空，解码后不能是 `.`、`..`，不能含斜杠、反斜杠和 NUL，所以 `%2F`、`%5C`、`%2E%2E` 都被拒绝。`rpc` 后面不能再有段，`media` 后面恰好一个素材 ID。拼出来的地址都能原样解析回来。
- 输入里本来就带 projectId 的操作，服务端核对它和 URL 里的一致，不一致报 `PROJECT_ID_MISMATCH`。
- 只按实体 ID 寻址的 11 个操作：`edge.delete`、`export.get`、`generation.submit`、`job.cancel`、`job.get`、`job.reconcile`、`job.retry`、`node.update`、`shot.update`、`version.list`、`version.select`。实体属于别的项目时，返回现有的 `NOT_FOUND`。按审阅 ID 寻址的两个图片审阅接口同样处理，返回它们现有的 `IMAGE_REVIEW_NOT_FOUND`。K2 在旧存储上就这样核对，切换前后行为一致。
- 操作的输入结构不变，所以 146 个契约和 Mio 的请求指纹都不变，由 K2 验证。CLI 和 MCP 调用这 11 个操作时也带上项目 ID。
- **项目没打开时：** 请求指向已登记、但没打开的项目时，服务端按登记自动打开；打不开报 `PROJECT_UNAVAILABLE`，没有登记报 `PROJECT_NOT_FOUND`。CLI、MCP 和外部 agent 照旧传 projectId。什么时候关闭由 S0 定。
- **生命周期操作：** 删除、复制、改名、关闭、另存为虽然带 projectId，但属于应用级操作，因为它们要关掉项目宿主、改登记。
- 桌面主进程也是客户端（`main.ts` 等 5 个文件），在 K2 的范围里。`native-audio-preview-host.ts` 只给 `/api/timeline-audio-preview` 开头的请求加原生音频签名头，路由挪动时要一起改。

## 错误码
| 错误码 | 什么时候 | 带什么 |
|---|---|---|
| `PROJECT_MISSING` | 找不到项目文件（设计稿 12-03） | `projectFile`；`projectId` 在文件读不出来、也没有登记时为 `null` |
| `PROJECT_LOCKED` | 已在另一个 Mioon 中打开（12-03b） | 同上 |
| `PROJECT_FORMAT_NEWER` | 格式比当前 Mioon 支持的新（12-03c） | 另带 `database`（`project`、`history` 或 `cache`）、`formatVersion`、`supportedFormatVersion` |
| `PROJECT_INVALID` | 文件损坏、不是项目文件，或结构对不上（12-03d） | 同第一行 |
| `PROJECT_FILE_SINGLE_PROJECT` | store 级 `project.create` 用在已有项目的文件上 | |
| `PROJECT_NOT_FOUND` | URL 里的项目 ID 没有登记 | `details: {projectId}` |
| `PROJECT_ID_MISMATCH` | URL 和输入里的 projectId 不一致 | `details: {projectId}`，是 URL 里的 ID |
| `PROJECT_UNAVAILABLE` | 已登记，但现在打不开 | `details: {projectId, reason}`，`reason` 是前四个原因码之一 |

- 打开结果（`projectOpenResultSchema`）：成功时带 `projectId`、`projectFile`、`projectDir`、`historyState`，失败时带前四种之一。
- 只按实体 ID 寻址的操作不用新的错误码，见上一节。

## 本机记录状态
打开项目时，比较项目文件的内容序号和本机记录见过的序号：

| 状态 | 含义 |
|---|---|
| `fresh` | 本机还没有这个项目的记录，例如别人发来的文件 |
| `current` | 序号一致 |
| `file-older` | 文件比记录旧，例如从备份恢复过，或被旧副本覆盖。超出文件状态的记录改为只读，相关的 Mio 撤销不可用，版本仍可恢复 |
| `file-newer` | 文件在别处改过。记录照常继续，之前的 Mio 变化按修订号核对 |

## 素材引用
引用的字段一次定全（`mediaReferenceSchema`）：

| 字段 | 含义 |
|---|---|
| `pathForm` | `relative` 或 `absolute` |
| `path` | 相对路径相对项目目录，一律用 `/`，只有开头可以是 `..`；绝对路径是规范化的 POSIX、盘符或 UNC 路径 |
| `volume` | 卷名。相对路径为 `null`；绝对路径在知道时填 |
| `sizeBytes`、`mtimeMs` | 大小、修改时间 |
| `sampledSha256` | 抽样哈希。抽哪些字节由 L1 定，定了就不再改 |
| `fullSha256` | 完整哈希，需要时再算，例如付费生成派发前；没算过为 `null` |

- 后四个字段合称指纹（`mediaFingerprintSchema`）。
- 素材状态：`online`（指纹一致）、`missing`（路径上没有文件）、`changed`（文件在，但指纹对不上）。
- 素材和项目文件在同一个盘上时存相对路径，跨盘时存绝对路径和卷名。S0 先把托管副本记成相对路径 `media/<ID>.<扩展名>`，S1 再改成引用原文件。
- 项目外位置（`outsideProjectLocationSchema`）：引用落在项目目录以外的文件夹，带素材数，以及这台电脑上有没有这个文件夹（12-06）。别人发来的项目，用户确认后才读取这些位置；确认记录在应用库，见下一节。

## 登记与记录
下面这些都存在应用库里，从不写进项目文件（`project-registry.ts`）：

- **最近项目：** 项目 ID、项目文件路径、文件身份、名称、最近打开时间，以及首页摘要的缓存（描述、版本号、创建和更新时间、画幅、镜头数、时长、封面素材）。`project.summary.list` 读不了没打开的项目，所以由项目宿主在项目打开期间和关闭时刷新缓存。
- **后台任务索引：** 每个未完成的任务一条，记项目 ID、路径、任务种类和任务 ID。重启后按索引重新打开项目，继续轮询和对账。
- **收件箱：** 项目打不开时到达的结果。媒体先放在应用数据目录的暂存区，下次打开项目时再写入，回执和对账规则不变。
- **规范信任：** 项目 ID 加 `AGENTS.md` 的内容哈希。
- **项目外路径确认：** 项目 ID、文件夹、确认时间。
- **本机记录清单：** 项目 ID、大小。列清单时不打开 `history.db`。

## 跨文件约束
160 列外键全是 `NO ACTION`，没有级联。清单第 5 节逐条列出；K1 按下面的规则处理，并在 PR 里附对照表。

- **本机记录、缓存表指向内容表的外键**（分别 62 列、3 列），以及这两类表上查内容表的触发器：改成连接级的临时触发器，完整模拟 `NO ACTION` 外键：
  - 插入子行、子表改外键列时，父行必须存在；
  - 删除被引用的父行、改被引用的父键时报错；
  - 外键列为空时不检查（`MATCH SIMPLE`），复合外键只要有一列为空就不检查。
- **两个原本延迟检查的跨文件外键：** `image_tasks(versionId,id,groupId,projectId)` 指向 `image_versions`，`scene_tasks(resultId,projectId)` 指向 `scene_results`。临时触发器只能立即检查。现有代码先插结果行，再回填任务的 `versionId`、`resultId`，所以立即检查也能过；K1 写进对照表并加测试。
- **内容表指向过程表的外键：** 共 10 列，属于 5 个复合外键：`versions.jobId` 指向 `jobs`，`image_groups`、`image_versions` 指向 `image_tasks`，`scene_results` 指向 `scene_requests`、`scene_tasks`。去掉约束，ID 列保留为普通列；本机没有对应的过程记录时，代码按“来自别处”处理。`image_groups.activeTaskId` 在本机找不到对应任务时当作空闲。
- **内容表上查过程表的 4 个触发器**（`reject_legacy_frame_asset_owner`、`reject_image_frame_asset_owner`、`scene_result_identity`、`subject_variant_version_binding`）：改成连接级的临时触发器。
- **Mio 配额的 20 个触发器：** 建在 Mio 表上的 16 个改写，只统计本机记录里的 Mio 表；建在放行表上的 4 个删除。上限在 R1 再定。
- **引用删除记账表的 124 个触发器：**
  - 建在要删除的表上的 16 个：不建；
  - 56 个目标修订触发器和 40 个保留类触发器（内容表 7 个、本机记录 32 个、应用库 1 个）：去掉 `WHEN NOT EXISTS(SELECT 1 FROM project_deletion_scope …)` 这句豁免条件后照建；
  - 建在 `jobs`、`exports`、`image_tasks`、`frame_tasks` 上的 12 个目标修订触发器：同样去掉豁免条件。它们写入的 `agent_task_target_revisions_v2` 在项目文件里，所以改成连接级的临时触发器。
- **应用库**指向内容表的 1 列外键改由代码检查。
- **运行时的结构探测：** S0 删掉通过 `sqlite_master` 或 `main.sqlite_schema` 判断表是否存在的代码（19 个文件 25 处，其中 7 个是 Mio 文件，要和己约好）。挂载以后这些查询只看主库，会把本机记录里的表当成不存在，而且不报错。
- **`PRAGMA foreign_key_check` 必须带库名**，例如 `PRAGMA history.foreign_key_check`；不带库名只查主库。跨文件的关系用测试辅助函数 `foreignKeyCheck(db)` 检查。

## 放行设置、草稿和建库文件
- **放行设置：** 全局放行档位及其回执（2 张表）放在应用库；对话级覆盖及其回执（2 张表）跟着对话，放在本机记录里。两者都不在项目文件里，别人发来的项目照样放宽不了权限。这样 `agent_task_conversation_policy_owner_v2` 也不再跨文件。
- **草稿：** `local-drafts-v1.json`、`local-delivery-v1.json`、`local-shot-text-v1.json` 三个文件改为本机记录里的草稿表，由 S8 实现。
- **建库文件按领域分，每份有一个负责人：**

| 建库文件 | 负责人 |
|---|---|
| 内容、回执、任务、时间线历史 | 丙 |
| Mio（含对话级放行） | 己 |
| 版本 | 甲 |
| 草稿、应用库 | 戊 |
| 缓存 | 丁 |

## 项目文件身份
- 项目文件不在私有存储里，不能用 `samePrivateStorageIdentity`。在 Windows 上，它只认原生组件在私有目录里绑定过的身份，普通 stat 会报 `FILE_IDENTITY_UNVERIFIED`。
- 另写 `projectFileIdentity`：POSIX 上用 dev 和 ino；Windows 上先确认原生组件能否给任意路径出完整的文件 ID，不能的话用 Node 的 bigint stat。登记里存成十进制字符串（`projectFileIdentitySchema`）。
- 它只用来找回被移动的项目和识别副本，不作为安全依据。由 B1 实现，并在 Windows 上验证。

## 测试
### 辅助函数
K0 只定名字和语义，由后续的卡实现。按任务卡，前四个由 W2 先在旧存储上实现，S0 再换成新内核的实现。

```ts
projectDatabasePath(root: string): string                 // 取代直接拼 workbench.sqlite
openProjectDatabase(root: string): DatabaseSync           // 打开项目库，挂上本机记录和缓存库
schemaObjects(db: DatabaseSync): SchemaObject[]           // 主库和挂载库的结构合在一起
projectDirFor(dataDir: string, projectId: string): string // 取代直接拼 <dataDir>/media/…
createServerProject(dataDir: string): {projectId: string; store: ProjectStore<DatabaseSync>}
foreignKeyCheck(db: DatabaseSync): ForeignKeyViolation[]  // 所有库，以及用临时触发器模拟的跨文件关系
```

- `openProjectDatabase` 设置和内核相同的 pragma，建同样的连接级临时触发器，否则经这个连接写入时会绕过跨文件约束和目标修订触发器。store 或服务端还占着这个项目时拒绝打开；W2 在旧存储上就执行这条规则，例如发现 `server.lock` 存在就拒绝。
- `createServerProject` 给“先填库再起服务”的测试用：按服务端的布局建一个已登记的项目，返回 `{projectId, store}`。写完先 `store.close()`，再 `startServer({dataDir})`。服务端只认登记过的项目，看不到在 `dataDir` 本身建的 store。

### 测试里怎样访问库
生产和测试一样，都用独占锁，测试不开特例。

- store 打开期间要查库或改库：直接用 `store.db`，不要另开连接。
- 要模拟别的进程，或者检查重开后的状态：先 `store.close()`，再用 `openProjectDatabase(root)`。
- 服务端运行期间要查库：
  - 进程内启动的服务端：用受信任的测试接口 `inspectProject`；
  - 子进程里的服务端：改成进程内启动，或者调整检查的时机；
  - 也可以先关掉服务端再打开，或者改用接口读取。
- 生产代码对项目文件只开一个连接，现在只有 `db.ts` 打开库文件。K1 加一条守卫测试，防止以后有人另开连接。

### 受信任的测试接口
进程内启动的 `startServer` 增加一个只供测试用的受信任选项，写法参照现有的 `taskFault`、`taskGatewayV2`：注释写明只供测试，从不来自 HTTP 或环境变量。名字和形状：

```ts
inspectProject<T>(projectId: string, inspect: (db: DatabaseSync) => T): T
```

回调在项目宿主自己的连接上同步执行，不会撞上独占锁，也不能跨 `await` 持有连接。K0 只定名字和形状，由 S0 实现；选项怎样把这个函数交给测试，也由 S0 定。

## 待定
- 由项目名得出文件夹名的规则（去掉路径分隔符和保留字符）和序号的写法：S0。
- 桌面版在 Windows 上的默认位置。契约按“系统影片目录下的 `Mioon/`”写（`DESKTOP_PROJECTS_FOLDER`），macOS 上就是 `~/Movies/Mioon/`，Windows 上对应 `Videos\Mioon\`，待协调人确认。
- 网页版和无界面服务的应用缓存目录、临时目录：S0。
- 新错误码对应的 HTTP 状态码：K2、S4。
- 首页封面：没打开的项目，封面地址 `/api/projects/<项目 ID>/media/<素材 ID>` 会按自动打开的规则打开项目。是否改用缓存目录里的缩略图：S0、S6。
- 那 12 个目标修订触发器把过程实体（`job`、`export`、`image_task`、`frame_task`）的修订号写进项目文件，别人收到文件后会看到对不上任何记录的修订行。是否拆回本机记录：R1。
- 打开副本时的提示还没有设计稿，打开结果里暂不带副本信息。
- 收件箱条目的结果字段由 S3 补上；恢复预览的改动列表沿用 Mio 修改卡片的展示词汇，V1 可以补字段。
