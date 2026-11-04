# 项目文件 v1：约定
日期：2026-10-30 起草，2026-11-02 按 S0 P4 实现补充，2026-11-03 补充 V2 项目自动备份与 V1-B 版本恢复及自动保存，2026-11-04 补充 S5-A/B 复制、另存为与模板。当前代码已切换真实项目存储，验收和发布状态以对应 PR 为准；后续约定变更仍提给协调人。

项目文件 v1 让 `.mioon` 成为项目本身：一个 SQLite 文件只存一个项目的当前内容；Mio 记录、撤销、版本、任务、回执和草稿按项目 ID 存在本机。这份文档记下各张任务卡共同遵守的约定，名字以契约代码为准：

## S0 P4 当前状态

- 普通 `db.ts.openStore(root)` 已使用下文 TEST 布局的真实内核；七个测试辅助函数也走真实三库连接和登记。生产 `startServer` 直接组装 B1 应用库、宿主管理器和每项目内核，不从 TEST 布局推断服务端项目。历史 schema、备份和恢复仅显式 `openLegacyWorkspaceStore` 保留。
- 应用目录为服务端 `dataDir` 或桌面 `<userData>/data/`，与项目目录分开；桌面旧 `workspace/` 不迁移、不再读。服务端发现旧 `workbench.sqlite` 时以 `VALIDATION_ERROR`（400）拒绝启动且零迁移。目录选项、覆盖 userData 的隔离规则和实际工厂见 [PROJECT-HOST.md](PROJECT-HOST.md)。
- 生产旧项目 RPC/REST/media 地址已退役：应用 `/api/rpc` 仍存在，但只接受应用操作；项目请求必须带 `/api/projects/<ID>/` 前缀。`project-routes.ts` 仅作测试内部适配。历史保存 URL 不改字节，实际访问重建新地址。同一 `requestId` 的回执在各项目独立，不能跨项目重放。
- 首页封面使用应用级 `GET /api/project-covers/<ID>`，只读缓存，缺失返回 404，不 acquire 项目；`projectSummaryCoverSchema` 已同步此 URL。应用 `/api/workspace-info` 返回应用根，新增项目 `/api/projects/<ID>/workspace-info` 在真实租约内返回项目根，复用原 schema，供可信桌面导出使用。
- 全局 `diagnostics/latest` 从应用 documents 读取严格五字段摘要：`completedAt/status/protocol/model/errorCode`；无项目对话、请求或密钥，也不打开项目。应用库当前为 v4，仅精确已知 v3 做 S3-A 的3→4升级，扩展后台任务索引，保留旧索引JSON及其他数据；不接受未知/改动结构，也不组合旧1/2升级到4。历史冻结件和旧升级函数仍保留供验证。HTTP B1 错误仅公开 `APP_LIBRARY_LIMIT`（507）与 `APP_LIBRARY_INVALID`（422）。
- V2 已接入宿主打开/关闭的项目自动备份，最近三份按项目 ID、内容序号和令牌去重；`project.backup.list/inspect/restore/status` 是应用级操作，恢复使用新 ID、新令牌和空本机记录。专用 `MioB` 标记使备份不能作为普通项目打开或登记；接口、提交点和故障边界见 [PROJECT-BACKUPS.md](PROJECT-BACKUPS.md)。不启用旧工作区备份接口，也没有接入备份界面。
- 生产素材以引用定位：项目格式为 3、cache 为 2，history 为 10。格式 1、2 的旧开发项目及备份明确拒绝、零写入，需重建。路径导入不复制，网页/Mio 上传写固定 `素材/`；生成写 `生成/`，成片写 `导出/`，排他发布、不自动删除项目文件。完整契约见 [素材引用](ASSET-REFERENCES.md)和[项目产物](PROJECT-OUTPUTS.md)。
- `project.version.list/save/preview/restore` 是项目级操作，提供手动/自动保存、保留清理和确认恢复；正文仅存本机 history，界面另卡实现；见 [PROJECT-VERSIONS.md](PROJECT-VERSIONS.md)。
- S5-A/B 已提供应用级复制/另存为、副本作为新项目打开、复制到和受控模板及受信端口；按入口只带重绑定版本或空本机记录，不接界面或 CLI/MCP 新命令；见 [PROJECT-COPIES.md](PROJECT-COPIES.md)。S5-C 的废纸篓及 V4 的打包导入导出尚未接入；旧工作区备份/恢复已退役。精确错误和按项目后的图片、帧、LUT 可达容量见 [宿主当前状态](PROJECT-HOST.md#0-p4-当前运行状态)。不调用旧生产生命周期链；S3-A只做任务索引上限，跨项目运行调度和历史/LUT/Mio总量硬限留0.1.x或另卡。

下文保留内核约定和 P1/P2 阶段记录；注明阶段的历史说明不代表 P4 仍在使用旧默认入口。

| 文件 | 内容 |
|---|---|
| `packages/contracts/src/project-file.ts` | 扩展名、文件夹名、四个目录、测试布局、库名、`ProjectStore`、打开结果、本机记录状态、错误码、按项目寻址的地址 |
| `packages/contracts/src/media-reference.ts` | 素材引用、指纹、素材状态、项目外位置 |
| `packages/contracts/src/project-registry.ts` | 最近项目及摘要缓存、后台任务索引、收件箱、规范信任、项目外路径确认、本机记录清单 |
| `packages/contracts/src/project-versions.ts` | 版本摘要、恢复预览、打包结果 |
| `packages/contracts/src/project-version-operations.ts` | 版本保存、分页列表、完整预览和确认恢复契约 |
| `packages/contracts/src/project-backups.ts` | V2 应用级备份操作、响应、描述和效果声明 |
| `packages/contracts/src/project-backup-records.ts` | V2 私有 JSON 索引和恢复意图，不是 history 表 |
| `packages/contracts/src/project-copies.ts` | S5-A/B 应用层复制/另存为、副本、复制到和模板叶契约，不进入公共或模型目录 |
| `packages/contracts/src/project-copy-records.ts` | S5-A 私有 v1 intent，不是应用库或 history 结构升级 |
| `packages/contracts/src/project-copy-action-records.ts` | S5-B 私有 v1 intent，记录选中源/新文件夹的身份和恢复阶段 |

这些模块不引入 Node 的模块，网页也能导入。按路径导入，不经过 `contracts/src/index.ts`。现有的交换文件见 `PROJECT-PACKAGE.md`，由 V4 删除。

备份四个操作与版本四个操作统一登记到契约根 `index.ts` 的 `schemas/descriptions` 和 `operation-effects.ts`；客户端不再另拼备份操作表。八项都在内置 Mio 的禁用列表中，生成 schema 不表示向 Mio 开放。V5 只同步 `project.version.restore` 新 CAS 字段的生成 schema，不改变 Mio 的校验、恢复或撤销实现。

## 一个文件一个项目
- 一个 `.mioon` 恰好一个项目。项目 ID 在建文件时生成并写进文件；文件里只有一行 `projects`，ID 等于文件的项目 ID，由 K1 在结构里保证。
- 项目 ID 是小写的 UUID，即 `crypto.randomUUID()` 的写法，别的写法一律拒绝。它还用作目录名，而 macOS、Windows 默认的文件系统不区分大小写。
- `project.create` 分两层：
  - **应用级**（HTTP 的 `/api/rpc`、CLI、MCP）：建一个新文件，再初始化它。不指定位置时：
    - 网页版和无界面服务建在 `<dataDir>/projects/<项目名>/`；
    - 桌面版建在 Electron 的 `app.getPath('videos')` 下的 `Mioon/<项目名>/`：macOS 上是 `~/Movies/Mioon/`，Windows 上是 `Videos\Mioon\`；
    - 文件夹名由项目名得出，重名时加序号（10-31 定，S0 实现）：
      - 按 NFC 规范化，控制字符和 `<>:"/\|?*` 换成 `-`；
      - 去掉首尾的空白和点，Windows 的设备名前加 `_`；
      - 最长 80 个 UTF-8 字节，空名用 `未命名项目`；
      - 重名时依次试 `名字 2` 到 `名字 999`，用不递归的 `mkdir` 占位；
      - `.mioon` 和文件夹同名。
  - **指定了位置时**（桌面版新建、另存为，以及 CLI、MCP 传了路径）：目标位置已经有同名的 `.mioon`，报 `PROJECT_FILE_EXISTS`，从不覆盖，见“错误码”。只是文件夹已经存在、里面没有这个文件时，照常建在里面。
  - **store 级**（`createServices(store)` 里的 `project.create`）：只初始化文件里唯一的一行，第二次报 `PROJECT_FILE_SINGLE_PROJECT`。
- 直接 `INSERT INTO projects` 的测试改用 `project.create`（W1）。

## 复制、另存为与项目身份

S5-A 的 `project.duplicate` / `project.save-as` 在应用 `/api/rpc` 使用独立严格叶契约：源 `projectId`、稳定 `requestId`、明确的新目标绝对 `.mioon` 路径 `projectFile`，以及可选名称；不加入 CLI/MCP discovery 或 Mio 工具。目标生成新 ID 和新内容令牌，保留当前内容及实体 ID，已有目标不覆盖。复制只读已关闭源；首页复制拒绝仍有窗口的源，受信另存为释放自己的窗口后关闭源，成功同窗口开新项目，失败尝试重开原项目。

复制和另存为**只携带重绑定的本机版本**：逐份严格解码，按新项目 ID 重写归属和历史素材定位，再以当前编码、canonical JSON 和新 hash 存储；保留版本 ID、名称、trigger、时间及非执行来源。格式 2 快照逻辑兼容，格式 1 整笔拒绝并指出 versionId。存在源 history 就只读捕获其版本，不要求 seen 匹配；坏、占用或不一致快照整笔拒绝，不升级源或静默不带。原 history 留在源 records，不在目标复制完整旧档。

目标不带 Mio 对话、后台任务、撤销、草稿、旧请求回执/自动标记、备份、imports、cache 或规范信任；旧 mioRunId 仅为版本来源。复制保留素材引用，按新目录重定位而不复制媒体；源目录与已有外部目录确认按既有范围随登记和应用回执原子转移，重放不恢复已撤销许可。新 history 的 seen 记录 builder 最终实际 pair，首次打开为 current。

Finder 直接复制出的同 ID 文件仍走副本检测；S5-B 的 `project.adopt-copy` 只在持 SQLite 写锁时用 builder 生成新 ID 暂存文件，校验原文件身份后替换选中副本，不原位重键，不带登记原件的版本或执行记录。`project.copy-to` 只读捕获选中的受限源；本机有 history 就携带重绑定版本，分叉也带，读不了整笔拒绝。`project.template.instantiate` 只按可信 catalog 在新文件夹建实例并复制白名单素材，两次实例素材独立；不合并到已有文件夹。三项不接界面、CLI/MCP 或 Mio。S5-C 的废纸篓尚未提供，0.1.0 永久清理义务已按协调决定销项。完整入口、intent、发布与后续义务见 [PROJECT-COPIES.md](PROJECT-COPIES.md)。

## 入口与作用域
`openStore(root)` 用于 store 级真实 TEST 布局；`startServer({dataDir})` 的 `dataDir` 是应用目录，项目通过真实登记和内核 opener 打开。`createServices` 仅为确切 TEST store 惰性接入真实测试应用库；生产宿主必须显式注入应用配置、写入守卫和备份端口，不能靠 root 或复制 store 字段获得应用能力。测试显式的 `createServerProject` / `openServerProject` 也登记同一 TEST 能力，使用真实服务端布局，不另外创建 TEST 布局的影子项目。共享一个应用目录的这些测试 store 复用唯一真实 B1，最后一个 store 关闭时才关闭 B1；生产服务端不参与这个 TEST 持有者表。

- 共用存储类型由 `store-contract.ts` 的 `Store` / `StoreIdentity` 提供，不初始化旧工作区。`db.ts` 暂保 `WorkspaceStore` 类型别名供历史代码过渡；事务、真实持有身份和观察者规则不变。
- `ServiceApplicationPorts.assertMutationAllowed()` 独立于 `backups`，由应用所有者提供。项目业务、Mio 派发和设置写入使用这个守卫；正式应用实现仍检查中止信号和确切 B1 连接的有效持有身份，配置写入仍通过 B1 的真实事务。历史工作区缺省接线继续委托原备份/恢复忙状态守卫。
- 配置和交换文件复用的安全 IO 位于 `managed-file-io.ts`；路径、身份、拒绝覆盖、有界读写、原子发布和同步规则保持。为维持现有错误语义，共用 IO 暂保 `WORKSPACE_BACKUP_*` 错误码；旧备份容器保留自身的发布编排，并重导出共用 IO 的兼容入口。

## 四个目录
| 目录 | 位置 | 放什么 |
|---|---|---|
| `projectDir` | `.mioon` 所在的文件夹 | 素材引用的基准；`生成/`、`导出/`、`AGENTS.md` |
| `localDir` | `<应用数据目录>/records/<项目 ID>/` | `history.db`、`backups/`、Mio 的对话附件 `imports/`（原 `agent-imports/`） |
| `cacheDir` | `<应用缓存目录>/projects/<项目 ID>/` | `cache.db`（波形、预演缩略图） |
| `tempDir` | `<应用临时目录>/projects/<项目 ID>/` | 图片、抽帧、拆解的暂存 |

- `root` 保留，等于 `projectDir`。S0 把用到 `store.root` 的 29 个业务文件逐个改到四个目录之一。
- 本机记录放在 `records/`，不放在 `projects/`。网页版默认把项目建在 `<dataDir>/projects/` 下，混在一起时，列项目会把本机记录（尤其是 `backups/` 里同 ID 的副本）当成项目。
- 同样的原因，网页版和无界面服务的应用缓存目录不能就是 `dataDir`：缓存用 `<dataDir>/cache/`，临时文件用 `<dataDir>/tmp/`（`SERVER_CACHE_DIRECTORY`、`SERVER_TEMP_DIRECTORY`），由 S0 实现。
- **网页版和无界面服务的旧目录：** `dataDir` 里有旧的 `workbench.sqlite` 时，启动报错，提示换一个目录或删掉旧文件，不和新布局混在一起（10-31 定，S0 实现）。
- **桌面版的目录**（10-31 定，S0 实现）：
  - 应用数据目录换成新的 `<userData>/data/`，不沿用 `<userData>/workspace/`。本机记录的文件夹以后不能搬，所以只能在 S0 切换时定这一次。旧的 `workspace/` 里还留着开发数据，既不迁移，也不再读。S0 改 `config.ts` 的 `dataPaths`。
  - 缓存放在系统缓存目录下的 `<应用 ID>/`，临时目录用 `<应用数据目录>/tmp/`，新项目默认放在 `<videos>/Mioon/`。
  - 设了 `MIOON_DESKTOP_USER_DATA` 时，缓存和新项目都放进应用数据目录，测试和冒烟运行不碰真实的影片和缓存目录。
- 内核按私有目录的规则检查 `localDir`、`cacheDir`、`tempDir`，路径里不能有符号链接；macOS 的系统临时目录经过 `/var` 这个符号链接，会被拒绝。
- **每个项目的 `tempDir`** 是 `<应用临时目录>/projects/<项目 ID>/`，不是应用临时目录本身。暂存的文件带着崩溃恢复用的回执，要跨重启保留，也不能被别的项目的清理扫掉。
- 文件夹名 `生成`、`导出` 固定，不随界面语言变化。
- `tempDir` 可能和项目目录不在同一个盘上，暂存文件移进项目目录时不能只靠一次改名，否则会报 `EXDEV`。
- 生产代码列项目目录时（L1 给 Mio 列目录、R3、V3 打包、宿主找被移动的项目），跳过以 `.` 开头的条目。生产环境里本来就有 `.DS_Store` 这类文件，这样也不用专门识别测试布局里的 `.mioon-store`。
  - 同样要跳过 `*.mioon-journal`：项目打开期间一直有一个 0 字节的日志，绝不能拷走或删除，见“日志文件”。
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

- 测试给目录做快照时，用 `isProjectStoreInternalEntry(entry)` 识别存储内部的条目：`.mioon-store/` 及其下的一切、`*.mioon-journal`、超级日志 `*-mj*`。
- 超级日志的名字是主库文件名后接 `-mj`、6 位十六进制、`9`、2 位十六进制，例如 `history.db-mj0DA3D190E`，这是用 Node 24 自带的 SQLite 3.53 实测的。主库是本机记录，所以超级日志在本机记录旁边：测试布局里在 `.mioon-store/local/` 下，项目目录里不会出现。按名字匹配超级日志的规则作为保险留着。

## 一个连接，三个库
依据是 10-30 的崩溃恢复实测：跨两个文件的大事务提交到一半时 `SIGKILL`，再看重开以后两个文件是否一致（Node 24.21.0，SQLite 3.53.4，回滚日志模式加独占锁）。

- **主库是本机记录 `history.db`。** 项目文件以 `project` 的名字挂上去，缓存库以 `cache` 的名字挂上去（`PROJECT_DATABASE_NAMES`）。
  - 当前 project/history/cache 格式为 **3/10/2**。项目增加 32 位小写十六进制 `contentToken`，头部 `user_version=3`；history 6 增加版本领域四表，7 允许已发布预演图的图片编辑来源，8 增加 `seenContentToken` 和单行宿主处置提交证据，9 增加三种草稿槽及 scope 状态四表，10 允许带服务 UUID 与配置修订的自定义图片审核意图（`schemaVersion:6`）。版本 `mioRunId` 保留来源值，解除对可执行 `mio_runs` 的外键依赖。
  - 精确已知的 history 2–9 都可在打开事务内直升 10，版本最后写入；2 保留既有开发期 Mio 重置，3–9 保留已有记录和版本字节。2–6 同时沿用 S2 的 `image_reviews` 窄升级，保留 rowid、审阅状态和原始 JSON 字节。2–7 也直升 10，升级的 token 为 NULL，进入恢复会话；8→10 建空草稿域并重建 `image_reviews` 审核意图版本约束，9→10 只重建该约束，保留 rowid、原始 JSON、审阅状态、原内容 pair 与所有旧记录；不把旧记录补成当前令牌，不在准入前清理项目修订账本。外键始终开启，失败或中途退出整笔恢复；未知或改动过的结构仍拒绝，详见 [MIO-RECORDS.md](MIO-RECORDS.md#发布前的开发数据重置)。
  - 未加限定的表名，SQLite 依次到各个库里找，所以现有 SQL 大多不用改。
  - 建表、建触发器，以及 `PRAGMA user_version`、`PRAGMA application_id` 这类语句要带库名，不带时落到主库，也就是本机记录。`PRAGMA foreign_key_check` 不带库名时只查主库。
  - 日志模式和锁模式另有规则，见下面的“日志模式按库名设”。
- **为什么本机记录作主库：**
  - 跨文件提交时，SQLite 把超级日志建在主库旁边，并在每个文件的日志里记下它的绝对路径。
  - 项目目录会被移动，这是常规操作；本机记录的位置固定。
  - 项目文件作主库时，提交中途崩溃后再移动项目目录，SQLite 照旧路径找不到超级日志，就把两边的热日志都当成已提交，项目文件或本机记录损坏（实测 `database disk image is malformed`）。
  - 本机记录作主库时，同样的情况下两个文件都能正确回滚。
- **打开顺序：**
  1. 先查本进程持有的文件身份，再只读原始文件头和完整精确结构。项目格式 1、2、未知新格式、伪造的新头或热日志均在读写打开和创建本机目录之前拒绝。合法格式 3 的故障恢复由显式 `recoverProjectFile` 先在隔离副本验证，再按项目优先的顺序恢复原件；普通 open 不隐式恢复热日志；
  2. 打开本机记录，作主库；
  3. 挂上项目文件和缓存库，按结构清单校验，建连接级的临时触发器。

  顺序不能反。SQLite 恢复完一个库以后，如果超级日志里列出的其他日志都不在原路径上，就会删掉超级日志，所以项目文件要先恢复。打开前本来也要先读出项目 ID，才知道该挂哪份本机记录。
- **日志模式按库名设**（10-30 实测）：
  - 不带库名的 `PRAGMA journal_mode=…` 只改当时已经挂上的库，之后挂上的库不受影响；`PRAGMA locking_mode=…` 则连之后挂上的库也一起改。所以挂上以后，三个库都按库名设一遍日志模式。
  - WAL 模式写在文件头里，跟着文件走。内核读文件头时发现是 WAL 模式，报 `PROJECT_INVALID`（`reason: 'journal-mode'`），不转换。Mioon 自己从不建 WAL 模式的项目文件。
- **其余时候只用这一个连接：** 除了第 1 步，项目文件和本机记录都只在这个连接上打开。临时触发器只存在于这个连接上，另开连接写入会绕过跨文件约束。
- **同一进程不能对同一个项目开第二个连接：** 再开报 `PROJECT_LOCKED`。测试的写法见“测试里怎样访问库”。
- **本进程不能用 `fs` 打开再关闭这三个库文件**（K1 实测）：
  - POSIX 的锁属于进程。关闭任何一个指向同一文件的描述符，都会释放 SQLite 在上面的锁，别的进程随即能读写。
  - 项目打开期间，拷贝、算哈希、读文件都不行；`stat` 可以，它不打开文件。
  - 要拷贝，用 SQLite 的备份接口或 `VACUUM INTO`，或者先关掉项目。
  - 涉及 S5（复制、另存为）、V2（备份）、V3（打包）、W2，以及 B1 的文件身份（只用 `stat`）。Windows 的锁按句柄，没有这个问题。
- **本机记录的文件夹：**
  - 本机记录清单只统计大小、删除文件，不打开库。
  - 文件夹里有还用得着的超级日志（`*-mj*`）时不能删，否则项目文件就恢复不了（`localRecordsEntrySchema` 的 `hasSuperJournal`）。删除接口在服务端也要核对，不能只靠界面。
  - 也不能移动或改名，包括以后迁移应用数据目录（K1 实测）。日志里记的是超级日志的绝对路径，路径一变，SQLite 就把热日志当成已提交，`history.db` 里留下半个事务。要搬，先经内核把项目打开一次再关上。
  - 没用的超级日志：进程正好在写超级日志时被杀，会留下一个没人引用的超级日志，约 230 字节，它会让这个文件夹永远删不掉。内核在每次成功打开以后删掉本机目录里用不着的超级日志，还用得着的留着。
  - 判断规则：超级日志列出的日志里，至少有一个还存在、是热日志（第一个字节不是 0），而且尾部记的正是这个超级日志（同一路径，或同一个文件），才算还用得着。日志尾部的格式照 SQLite 的 `pager.c`：超级日志的名字、4 字节长度、4 字节校验和、8 字节魔数。内核导出这条规则 `isSuperJournalInUse(superJournal)` 和列出超级日志的 `superJournalsIn(localDir)`，B1 列清单时用它们算 `hasSuperJournal`。只在没有进程开着这个项目时才有意义：提交过程中，超级日志先于热日志出现。
- **打开期间移动项目文件夹**（macOS、Linux 上能移；Windows 上文件被占用，移不动）：
  - SQLite 在打开一个库以后第一次写它时才打开它的日志，这时如果库文件已经被改名或移走，就报 `SQLITE_READONLY_DBMOVED`（1032）；日志打开以后，独占模式下一直开着，不再检查（K1 实测）。
  - 所以内核在打开的最后一步把项目文件的日志开着：在事务里把 `PRAGMA project.user_version` 写回原值，这一页只进了缓存，随即回滚。项目文件的字节和修改时间都不变（测试在子进程里算哈希）。之后移动项目文件夹，写入照常，从新位置重开能读到；提交中途崩溃，从新位置打开，两个文件都回到提交前。
  - 项目打开期间，项目文件旁边一直有 `<文件名>-journal`，提交之间是 0 字节。关闭时 SQLite 按打开时的路径删它：没移动过就删掉了；移动过的，旧路径上什么都不剩，新位置留下这个 0 字节的日志，它不是热日志，下次在新位置打开再关闭时删掉。
  - 关闭时按文件身份更新登记。
- **只改名或单独移动 `.mioon`，文件夹不动**（10-31 定）：
  - SQLite 的日志名跟着打开时的文件名，日志留在原来的名字旁边。这时提交中途崩溃，从新名字打开找不到日志，项目文件里是半个事务（实测：项目文件是新值，本机记录回到旧值）。K1 起写过一次项目文件以后就是这样，打开时开着日志以后，打开后还没写过的也一样。
  - 内核在 `store.tx` 开头（`BEGIN` 之前）和 `put` 里（写语句之前，事务里也查）各做最多两次 `lstat`，两条都满足就抛 `PROJECT_FILE_MOVED`（HTTP 409），两个文件都不写：
    - 打开时的路径上没有文件了，或者换了文件身份；
    - 原路径的 `-journal` 还在，说明是单独移动了文件，不是连同文件夹一起移动。移动文件夹时日志跟着走，写入照常，不报错。
  - 宿主收到这个错误，或者 1032，就 `relocate`：停写、关掉，按文件身份找到新位置后重开。请求方重试即可。
  - 这项检查在内核里（`ProjectConnection.throwIfMoved`），宿主不用再登记同样的事务守卫。
- **崩溃后没在本机恢复就被拷走：** 拷到别的电脑上的项目文件可能带着半个事务，因为那边找不到本机记录旁边的超级日志。S0、S6 在启动时，以及列最近项目时，对没打开的项目调用内核的 `recoverProjectFile(projectFile)`：它只做打开顺序的第 1 步，项目文件旁边的日志是热日志时，单独打开项目文件、取锁让 SQLite 回滚、关掉，不打开本机记录。结果：
  - `clean`：没有要恢复的；`recovered`：已回滚；
  - `locked`：别的进程开着它，并且正在写，这里不用管，打开时会报 `PROJECT_LOCKED`；
  - `open-here`：本进程开着它，按内核的已持有文件登记表认出，不碰文件；
  - `missing`：找不到，按文件身份找新位置；
  - `access-denied`：系统明确返回 EACCES/EPERM，打开时为 `PROJECT_ACCESS_DENIED`，不归入缺失、只读或损坏；
  - `invalid`：带打开时会报的 `PROJECT_INVALID` 原因，例如 `not-a-project-file`、`read-only`（只读位置上的热日志回滚不了）。
  - **没有热日志时不读项目文件**（10-31 定）：`lstat` 和本进程已持有的判断之后，先看项目文件旁边的 `-journal`：没有、是 0 字节或第一个字节是 0，就不是热日志，直接返回 `clean`，项目文件连文件头也不读。首页每次列项目都会调它；放在 iCloud 里、已经被系统移出本机的项目文件，一读文件头就会被整个下载回来。所以旁边没有热日志、又不是项目文件的普通文件，这里返回 `clean`，要等打开时才报 `PROJECT_INVALID`。
- **事务：** `store.tx` 用 `BEGIN`，不用 `db.ts` 的 `BEGIN IMMEDIATE`，这是和 `db.ts` 唯一有意的差别。独占锁下 `BEGIN IMMEDIATE` 已经没有提前取锁的作用，反而让每次提交都把三个库拉进写事务、建一个超级日志。用 `BEGIN` 时只有写到的库进入写事务：只写本机记录的提交（例如 Mio 流式输出）不碰项目文件，也不建超级日志；同时写两个文件的提交照旧用超级日志。K1 实测，p50 从 1.11 ms 降到 0.34 ms。
- **S0 P1 的内部接缝：** `db.ts` 的事务 fence/observer 注册遇到真实的新内核连接时，转交内核的注册表，仍在同一事务里按 fence、业务回调、observer 的顺序执行，失败一起回滚。`isProjectStore` 只认可内核返回的确切对象和仍然打开的原连接；复制公开字段不能获得锁归属或跳过旧恢复校验，关闭后证明失效。项目连接和应用库连接不允许用原生 `db.open()` 重开：它不会重新挂库、安装 TEMP 约束或登记，必须再次调用相应的内核或应用库 opener。P1 当时保留旧默认入口；P4 已切换普通 opener、测试辅助函数和生产装配。
- **本进程持有的文件：** 内核的 `isProjectFileHeld(identity)` 查询项目文件、history.db、cache.db，应用库的 `isAppLibraryHeld(identity)` 查询 app-library.db；调用方按两者的或组合传给 L1 的 `isHeld`。只查询实际连接的持有表，不额外打开或关闭文件，不按路径名猜测；身份取 `lstat/stat` 的十进制 dev、ino，ino 为 0 时不作身份匹配。硬链接、改名仍是同一身份，连接关闭后不再持有。P1 只提供端口，素材读取接线归 S1。

**S0 P2 的组装接缝（历史阶段记录，当时尚未切换生产存储）：**

- `apps/server/src/project-runtime.ts` 的 `composeProjectRuntime` 从已打开的 store 组装 providers、业务服务、编辑任务和 Mio，并返回已绑定业务依赖的草稿工厂。真实宿主把自己的 context 传给 `ProjectDraftsFactory`，每个宿主创建一份草稿服务及 HTTP handler。工厂不打开/关闭 store、不绑定监听器，也不创建宿主管理器；store 及其唯一连接仍由宿主管理器持有。
- P2 时新内核只在定向集成测试中装配，必须显式提供应用库端口与 `ServiceApplicationPorts`；P4 的生产宿主沿用此注入。项目连接不挂载应用库。应用配置、偏好、全局 Mio policy、授权、最近项目使用应用范围；三个项目 JSON 使用 `localDir/history.db` 的身份。`databaseFile` 的验证仍要求私有根内的直接子文件，只做原有 stat 验证，不读取持有的数据库。
- `isAppLibraryHeld(identity, db)` 可同时核对文件身份与实际持有它的连接；不能把一个仍打开的连接与另一个库的路径拼接成应用权限。应用 documents 的 companion 写入经独立应用事务提交后才返回确认，拒绝加入外层未提交事务。Mio policy 的 CAS 写入也使用独立应用事务，policy 与请求回执一起提交；无 CAS 的既有 B1 写法仍可组合进应用事务。
- 新工厂支持借用应用设置；借用的设置和配置/备份端口由应用所有者关闭，关闭项目不关闭它们。工厂启动失败时先取消并等待内部任务和自建设置；清理成功才重抛原启动错误。清理失败或超时会保留两类错误，外层不得关闭 SQLite 或释放锁，遵守既有 `boundedShutdown` 的安全边界。
- 领域能力来自真实内核登记和已验证结构，不把新连接伪装成 ordinary-72。固定历史构造器和验证源码保持原字节；旧布局检查继续执行原规则。Mock 的原 SQL 不变，只在真实内核跳过预建两表的安装；其当前运行时源码摘要随接缝更新，历史源摘要与 golden 不重设。内容表按 project、记录表按 main、缓存表按 cache 定位；LUT 的运行时读取复用原有有界投影、字节哈希及格式校验。
- 图片组保留的 activeTaskId 若在本机没有任务、也没有该组其它未解决的本机任务，读取时视为空闲，下一次生成的原 CAS 更新替换旧指针。若本机任务存在，它必须属于同项目、同组；错绑或本机未解决任务与指针不一致仍是损坏，不能当作外来任务放行。
- 新内核的图片、帧、分镜暂存放 `tempDir` 下原有 staging 子目录，最终素材仍在 projectDir/media。发布在目标目录内原子写入，成功前保留源文件和回执，跨盘暂存不依赖 rename。旧 store 的路径不变。编码能力探测可使用 tempDir；素材只读路径仍为 projectDir，波形缓存仍用 cache 库。

P2 当时不改变公开地址、落盘格式、Mio 请求字节、生产入口或测试辅助函数。以下是该阶段留给 P4 的边界清单；当前已实现及仍延期的项目以上方状态和宿主文档为准：

| 项目 | P4 必须处理的边界 |
| --- | --- |
| 生命周期、包、工作区备份 | 新内核不调用旧删除/导入/备份链；列暂不可用操作、精确错误及需改的正向测试。三处旧无库名 foreign_key_check 留在这些旧格式专用链中；新内核检查使用跨文件 foreignKeyCheck |
| 存储统计 | 现有 11 表统计协议包含应用 policy 两表；项目库单独统计返回既有 unavailable，不伪造零计数。应用与项目的真实聚合随切换接入 |
| 可携带内容 | 缺本机来源任务的 image_versions、scene_results 等需要单独保留来源核验及负例；P2 不放松严格 ownership/provenance。普通 0755 项目目录的最终媒体写入策略也须明确，当前私有存储拒绝和源文件保留规则不放宽 |
| native 与容量 | 新内核不在各项目工厂重复 bind 原生音频 authority，P4 提供按项目分派的聚合服务。队列和配额的常量不在 P2 改动，按项目后的可达容量变化在 P4 列明 |
- **应用库：** 不挂到项目连接上，单独开一个连接。
- **锁：** 都用回滚日志模式和独占锁，打开时立即取得写锁。第二个进程打开同一个项目时报 `PROJECT_LOCKED`。

## 日志文件
10-30 实测，并按 SQLite 的实现核对过。

- **单库提交后：** 不设上限时，`-journal` 留着，头部清零，旧页还在，关闭项目时才删。内核设 `journal_size_limit=0`（`PROJECT_JOURNAL_SIZE_LIMIT`），所以每次提交后日志都截成 0 字节，旧内容不会在项目目录里留到关闭。
- **跨库提交后：** `-journal` 截成 0 字节。
- **超级日志：** 只在多个库同时处于写事务时出现，提交完删掉；提交中途崩溃时会留下。它在本机记录旁边，见上一节。`store.tx` 用 `BEGIN`，只写一个库的提交不建；打开时取锁用的 `BEGIN EXCLUSIVE; COMMIT` 仍会建一个、随即删掉。用不着的，下次成功打开时删掉。
- **打开期间：** 项目文件旁边一直有 `<文件名>-journal`，提交之间是 0 字节，关闭时删掉，见上一节。生产代码列项目目录、打包时跳过它，绝不能拷走或删除（契约的 `isProjectStoreInternalEntry` 认得它）。
- **拷贝：** 项目打开期间，在别处（例如访达）单独拷走 `.mioon`，只有在没有写事务进行时拷出来的才完整。本进程要拷，见上一节。

## 按项目寻址
- 项目级接口放在 `/api/projects/<项目 ID>/` 下：
  - RPC：`/api/projects/<项目 ID>/rpc`；
  - 媒体：`/api/projects/<项目 ID>/media/<素材 ID>`，按素材 ID，不按路径。现在的 `/media/<素材 ID>` 本来就按素材 ID；`?preview=1&exportId=…`（导出预览）、`?download=1&exportId=…`（命名导出下载）和 `?download` 照旧保留；
  - 其余项目级接口也移到这个前缀下，由 K2 按清单第 2 节逐个处理。`/api/timeline-audio-preview/continuous` 的路径取自契约常量，按字符串扫描找不到，也在其中。
  - 清单漏列的编辑任务接口 `/api/tasks…`（`edit-tasks-http.ts`）也是项目级，归 K2。新地址保留 `/api/` 之后的部分，即 `/api/projects/<项目 ID>/tasks…`（10-31 定）。
- 跨项目的接口留在原处：项目列表、新建、打开、设置、连接等。
  - 清单漏列的 `/api/workspace-preferences/<id>`、`/api/agent/tasks/v2/policy`、`/policy/requests/<id>`、`/diagnostics/latest` 也属于应用级（10-31 定）。
  - `/api/agent/diagnostics?projectId=` 留在应用级，存储统计只在项目开着时给，不触发自动打开。
- S0 切换以后，`/api/rpc` 只收应用级的操作，项目级的操作发到这里报 `VALIDATION_ERROR`。
- 拼接和解析都用契约里的函数：

| 函数 | 作用 |
|---|---|
| `projectRpcPath(projectId)` | `/api/projects/<项目 ID>/rpc` |
| `projectMediaPath(projectId, assetId)` | `/api/projects/<项目 ID>/media/<素材 ID>`；查询参数由调用方照旧加 |
| `projectApiPath(projectId, ...segments)` | 其余接口。每段做百分号编码，不能为空，不能是 `.`、`..`，不能含斜杠 |
| `parseProjectApiPath(pathname)` | 严格解析，得到 `rpc`、`media` 或 `other`；不合规则时返回 `null` |

- 解析只接受 `URL.pathname`。项目 ID 必须是小写 UUID；之后的每段不能为空，解码后不能是 `.`、`..`，不能含斜杠、反斜杠和 NUL，所以 `%2F`、`%5C`、`%2E%2E` 都被拒绝。`rpc` 后面不能再有段，`media` 后面恰好一个素材 ID，也必须是小写 UUID。拼出来的地址都能原样解析回来。
- 输入里本来就带 projectId 的操作，服务端核对它和 URL 里的一致，不一致报 `PROJECT_ID_MISMATCH`。
- 只按实体 ID 寻址的 11 个操作：`edge.delete`、`export.get`、`generation.submit`、`job.cancel`、`job.get`、`job.reconcile`、`job.retry`、`node.update`、`shot.update`、`version.list`、`version.select`。实体属于别的项目时，返回现有的 `NOT_FOUND`。按审阅 ID 寻址的两个图片审阅接口同样处理，返回它们现有的 `IMAGE_REVIEW_NOT_FOUND`。K2 在旧存储上就这样核对，切换前后行为一致。
- 操作的输入结构不变，所以 146 个契约和 Mio 的请求指纹都不变，由 K2 验证。CLI 和 MCP 调用这 11 个操作时也带上项目 ID。
- **项目没打开时：**
  - 请求指向已登记、但没打开的项目时，服务端按登记自动打开；CLI、MCP 和外部 agent 照旧传 projectId；
  - 打不开报 `PROJECT_UNAVAILABLE`，详情里带打开失败的原因码，原因码是 `PROJECT_INVALID` 时另带细分原因 `invalidReason`；没登记报 `PROJECT_NOT_FOUND`；
  - 列表和封面请求不触发自动打开。没打开的项目，封面用缓存的缩略图，见下面的“封面”；
  - **自动关闭**（10-31 定，S0 实现）：没有租约、没有在途请求、运行时也不忙，而且最后一个请求结束已满 60 秒，就关闭。关窗口不用等这 60 秒。有可推进的后台任务（S3 持有的租约）或 Mio 正在跑时不关；仅等用户/源的任务仍保留索引，但不永久持库。
- **封面**（10-31 定）：宿主在打开时、关闭前，以及封面素材变了时，把封面缩成长边 512 像素的 JPEG，和一个记素材 ID、指纹的 `cover.json` 一起存进这个项目的缓存目录。应用级的封面接口只读这两个文件，不打开项目，找不到时界面显示占位图。封面不写进项目目录，接口名由 S6 和 B1 定。
- **生命周期操作：** 删除、复制、改名、关闭、另存为虽然带 projectId，但属于应用级操作，因为它们要关掉项目宿主、改登记。
- 桌面主进程也是客户端（`main.ts` 等 5 个文件），在 K2 的范围里。`native-audio-preview-host.ts` 只给 `/api/timeline-audio-preview` 开头的请求加原生音频签名头，路由挪动时要一起改。

## 错误码
| 错误码 | 什么时候 | 带什么 |
|---|---|---|
| `PROJECT_MISSING` | 找不到项目文件（设计稿 12-03） | `projectFile`；`projectId` 在文件读不出来、也没有登记时为 `null` |
| `PROJECT_LOCKED` | 已在另一个 Mioon 中打开（12-03b） | 同上 |
| `PROJECT_ACCESS_DENIED` | 系统明确返回 EACCES/EPERM（含隐私授权拒绝），HTTP 403；不从通用 SQLITE_CANTOPEN 猜权限 | 同上；按项目寻址时 `PROJECT_UNAVAILABLE.details.reason` 保留此码，目录 availability 为 `access-denied` |
| `PROJECT_FORMAT_NEWER` | 格式比当前 Mioon 支持的新（12-03c） | 另带 `database`（`project`、`history` 或 `cache`，本机记录有自己的格式版本）、`formatVersion`、`supportedFormatVersion` |
| `PROJECT_INVALID` | 文件损坏、不是项目文件、结构对不上，或在只读位置（12-03d） | 同第一行，另带 `reason`（`PROJECT_INVALID_REASONS`） |
| `PROJECT_FILE_SINGLE_PROJECT` | store 级 `project.create` 用在已有项目的文件上 | |
| `PROJECT_FILE_EXISTS` | 新建时目标位置已有文件；HTTP 409 | 内核的详情照打开错误的写法，是 `{database: 'project', reason: 'exists'}`，不放绝对路径；应用级的新建再补上 `projectFile` |
| `PROJECT_FILE_MOVED` | 项目打开期间单独改名或移动了 `.mioon`，文件夹没动；HTTP 409 | `details` 带 `projectId`。宿主正在按新位置重开，重试即可，见“只改名或单独移动 `.mioon`” |
| `PROJECT_FILE_COPY` | 要打开的 `.mioon` 带着一个已登记项目的 ID，而登记的那个文件还在原处，这个文件是副本（计划 5.2）；HTTP 409 | `details` 带 `projectId`。应用库在内核的 `checkCopy` 里拒绝，这时还没给副本建本机记录；S5-B 的 `project.adopt-copy` 可对已重验的选中副本生成新身份后替换，S6 接确认界面 |
| `PROJECT_NOT_FOUND` | URL 里的项目 ID 没有登记；HTTP 404 | `details: {projectId}` |
| `PROJECT_ID_MISMATCH` | URL 和输入里的 projectId 不一致；HTTP 400 | `details: {projectId}`，是 URL 里的 ID |
| `PROJECT_UNAVAILABLE` | 已登记，但现在打不开；HTTP 409 | `details: {projectId, reason, invalidReason?}`，`reason` 是前四个原因码之一 |

- 三个寻址错误码的 HTTP 状态是 K2 先用的默认值，要改提给协调人。
- `PROJECT_UNAVAILABLE` 的 `invalidReason` 是 `PROJECT_INVALID_REASONS` 之一，取内核的 `details.reason`，只在 `reason` 是 `PROJECT_INVALID` 时出现（10-31 定）。CLI、MCP 按项目 ID 访问时，由此分清只读和损坏。
- 内核的打开错误另带 `details.reason`。`PROJECT_INVALID` 的原因列在契约的 `PROJECT_INVALID_REASONS` 里，例如 `journal-mode`、`schema`、`not-a-project-file`；内核的 `ProjectFileErrorReason` 由它和另外四个码各自的原因（`missing`、`locked`、`format-newer`、`exists`）组成。
  - `read-only`：没有写权限，或在只读卷上。打开的最后一步要写一次项目文件的日志（见“打开期间移动项目文件夹”），只读通常就在这一步暴露出来：项目文件是 0444 时报 SQLite 的 `SQLITE_READONLY`，项目目录是 0555、日志建不出来时报 `SQLITE_READONLY_DIRECTORY`。这不是文件损坏，界面按 12-03d 的样式换文案。
  - `corrupt`：SQLite 认出文件损坏；`unusable`：其余的 SQLite 错误。
- 打开结果（`projectOpenResultSchema`）：成功时带 `projectId`、`projectFile`、`projectDir`、`historyState`，失败时带前四种之一；`PROJECT_INVALID` 带 `reason`，取内核的 `details.reason`。
- 只按实体 ID 寻址的操作不用新的错误码，见上一节。

## 本机记录状态
打开项目时，比较文件与本机记录的完整内容身份 `{contentSequence, contentToken}`。现有持久内容行触发器在推进序号的同一 UPDATE 中用 SQLite `randomblob(16)` 换令牌；raw SQL、自动提交和 LUT 独立事务都适用，回滚不推进。多行事务仍可推进多次，history-only 写入不换令牌。

| 状态 | 含义 |
|---|---|
| `fresh` | 本机还没有这个项目的记录，例如别人发来的文件 |
| `current` | 序号和令牌都相等，正常准入 |
| `diverged` | 其他合法差异：序号较小、较大、同序号异令牌、旧 history 缺少令牌；都要确认处置，不按序号推断可靠的内容先后 |
| `invalid` | 非法字段、同令牌异序号、身份或结构损坏，返回确切错误，不建立 store |

成功 store 的 `historyState` 只有前三项；`historyAdmission` 保留打开时的不可变 pair/原因证据。只有 fresh/current 连接可同步 seen pair。diverged 的连接由 SQLite 只读模式和连接级写入守卫拒绝内容与旧 history 写入，宿主在 factory 之前分流，不构造 Mio、worker、业务服务，不做 daily 或自动备份。

恢复会话只可查看状态、列版本、预览、确认和关闭。确认“以当前文件继续”或“恢复某个本机版本”都经过应用 owner 守卫、项目独占和文件/history 身份及 pair CAS。整份旧 history 改名为同目录只读归档，新 history 只带原版本 blob 和版本行；旧请求回执、自动保存标记、Mio 对话/任务/撤销不带。已提交但结果未知的 provider 任务只显示数量，不续跑或重发。恢复版本在新 history 中作为新的 V1 内容提交，序号与令牌向前走。

切换使用私有持久 intent、暂存 history 的事务提交证据及 fsync/rename；打开必须先恢复未完成切换，不能把暂时缺失的 history 当 fresh。相同确认重复返回原结果，后续编辑也不重做恢复。最小宿主接口和文字见 [PROJECT-HOST.md](PROJECT-HOST.md#v5-恢复会话)。不提供通用 history 业务 RPC，也不向 Mio 增加工具。

未改内容的物理备份保留 pair；换项目 ID 的复制必须换新令牌，打包改写持久引用也必须换令牌。S5-A/B 的复制/另存为、副本/复制到和模板入口见 [PROJECT-COPIES.md](PROJECT-COPIES.md)，S5-C、打包由后续卡实施；内容令牌不是内容哈希或防篡改凭据，不提供父链、祖先证明或旧执行记录的部分继续资格。

## 项目自动备份（V2）

- 备份在真实宿主的 `afterOpen` / `beforeClose` 中，用持有连接的 SQLite backup 接口复制 attached `project`，不是 `main`（history）。关闭备份在排空后、关库前；打开接受 SQLite 完成时一致副本，不暂停 worker。
- `localDir/backups/` 保存项目副本、私有 JSON 索引/状态和恢复意图。只改目标副本的专用 `application_id` 为 `MioB`；普通 opener 拒绝，专用 opener 只读查看，不建 history/cache 或登记。
- 与最近有效副本的项目 ID、内容序号、令牌都相同才不轮换；同序号异令牌仍备份，损坏、缺失副本不作去重依据。索引最多指向三份；确认原子索引的目录同步后才清理旧份，维护失败保留额外文件，后续捕获清理受控孤儿。
- 同进程完整校验成功后，按文件 dev/ino/size/mtime/ctime/birthtime 和索引中的项目/内容序号/令牌/大小记住结果；每次命中仍检查私有文件安全属性与 journal sidecar。替换、变动或失败都须重验。打开去重只找到最近有效副本即停止；列表仍逐项确认全部有效项，inspect/restore 仍完整只读校验。索引和恢复 intent 为私有 JSON v2；缺令牌旧索引没有去重资格。
- 恢复到明确的新文件，目标存在报 `PROJECT_FILE_EXISTS`；新 projectId、空本机记录，实体 ID 保留。V2 的共享复制能力供 S5 复用，当前托管媒体校验后复制，正式引用按原来源目录重定位，不改源项目或源备份。
- 新增的四个 `project.backup.*` 操作走应用 `/api/rpc`，列表/查看/状态和从备份恢复不 acquire 原项目。原生备份完整 await，超过阈值可见 slow，不做硬超时；失败不挡开关，但不承诺慢 I/O 的关闭时限。

完整接口、JSON 发布/恢复重试、媒体和停机边界见 [PROJECT-BACKUPS.md](PROJECT-BACKUPS.md)。V2 本身不改 history 结构；V1-A 的本机逻辑版本见 [PROJECT-VERSIONS.md](PROJECT-VERSIONS.md)。备份/版本界面仍由后续卡交付，请求指纹保持不变。

## 素材引用
S1 已切换生产导入和全部素材读端。资产只以 `reference` 定位，普通结果返回无路径指纹与 `referenceRevision`；图片/音频导入即完整哈希，视频强执行前 prepare→CAS。目录许可按项目和实际目录本身确认，不含子目录；普通 MCP/Mio 不能确认。完整导入、状态、重连和格式拒旧规则见 [素材引用](ASSET-REFERENCES.md)。注明 S0 的托管素材说明仅为阶段记录。

引用的字段一次定全（`mediaReferenceSchema`）：

| 字段 | 含义 |
|---|---|
| `pathForm` | `relative` 或 `absolute` |
| `path` | 相对路径相对项目目录，一律用 `/`，只有开头可以是 `..`；绝对路径是规范化的 POSIX、盘符或 UNC 路径 |
| `volume` | 卷名。相对路径为 `null`；绝对路径在知道时填 |
| `sizeBytes`、`mtimeMs` | 大小（字节）、修改时间。`mtimeMs` 由 bigint `lstat` 的 `mtimeNs` 换算，精确到微秒：`Number(mtimeNs / 1000n) / 1000`，早于 1970 年的记为 0。一律用 L1 的 `mediaMtimeMs` 算：Node 的数字 `mtimeMs` 末位和它不同，混用会让修改时间永远对不上 |
| `sampledSha256` | 抽样哈希，现有 L1 算法不变：不超过 1 MiB（1 048 576 字节）的文件读取整个文件并计算 SHA-256，等于完整哈希；更大的文件只取 5 段，每段 64 KiB（65 536 字节），第 i 段（i = 0…4）从 ⌊i × (大小 − 65 536) / 4⌋ 开始，按顺序拼接计算 SHA-256。五段合计 320 KiB，覆盖开头、中间和结尾；不是所有大小的文件都只读 320 KiB |
| `fullSha256` | 完整哈希，需要时再算，例如付费生成派发前；没算过为 `null` |

- 后四个字段合称指纹（`mediaFingerprintSchema`）。
- 素材状态：`online`（指纹一致）、`missing`（路径上没有文件）、`changed`（文件在，但指纹对不上）。
- 素材和项目文件在同一个盘上时存相对路径，跨盘时存绝对路径和卷名。路径导入引用原文件；上传在 `素材/` 创建副本后引用。没有旧 `relativePath` 资产定位回退。
- 项目外位置（`outsideProjectLocationSchema`）：引用落在项目目录以外的文件夹，带素材数，以及这台电脑上有没有这个文件夹（12-06）。别人发来的项目，用户确认后才读取这些位置；确认记录在应用库，见下一节。

## 登记与记录
下面这些都存在应用库里，从不写进项目文件（`project-registry.ts`）：

- **最近项目：** 项目 ID、项目文件路径、文件身份、名称、最近打开时间，以及首页摘要的缓存（描述、版本号、创建和更新时间、画幅、镜头数、时长、封面素材）。`project.summary.list` 读不了没打开的项目，所以由项目宿主在项目打开期间和关闭时刷新缓存。
- **后台任务索引：** S3-A在任务事务提交后同步记录，关闭时仍整项目更新；包含项目/任务身份、阶段、原因、来源history代际和修订，最多全应用4096/单项目512条。重启消费租约和失败，blocked保留等待原因；V5旧代际archived，不写进新history。项目COMMIT到索引之间强退仍可能漏登，下次打开补上，见[后台任务](BACKGROUND-TASKS.md)。
- **收件箱：** 现有表只保留占位格式；离线应用接收、暂存和回填（S3-B/C）已定放0.1.x。0.1.0项目不在时暂停，任务留本机history，找到后按原规则继续；离线超过供应商保留期可能无法取回结果，不自动重提。
- **规范信任：** 项目 ID 加 `AGENTS.md` 的内容哈希。
- **项目外路径确认：** 项目 ID、文件夹、确认时间。
- **本机记录清单：** 项目 ID、大小，以及文件夹里有没有还用得着的超级日志（`hasSuperJournal`，按内核的 `isSuperJournalInUse` 算）。列清单时不打开 `history.db`；有还用得着的超级日志的不能删。

## 内核结构的权威来源

`project-file/schema/domains/` 的领域 DDL 是直接维护的源文件，不再从旧工作区的 1→72 迁移链推导。`schema/databases.ts` 组合领域声明和内核元数据；`schema/tables.ts` 记录表的归属。跨文件关系和 TEMP 业务守卫分别由 `cross-file/relations.ts`、`cross-file/converted-triggers.ts` 维护。

修改持久结构时，改所属领域并提升相应数据库版本，补升级路径，并为新支持的旧版本保存白名单；已有历史白名单保持不变。然后运行：

```sh
node tests/helpers/project-file-schema-derivation.ts --write
node tests/helpers/project-file-schema-derivation.ts --check
```

`--write` 只生成当前 `schema/manifest.ts`，不会重写领域、跨文件声明、历史白名单或测试 fixture。`--check` 从权威声明建真实 SQLite，核对表归属、列与有序唯一键、跨文件关系、TEMP 守卫的独立合法/违规写入，以及当前清单。`--report` 显示当前库、关系和 TEMP 目录。关系的编号、列顺序、空值语义和立即检查边界都需要对应的行为测试；清单通过不能代替它们。

`tests/project-file-schema.test.ts` 另记每个数据库版本的独立摘要，重新生成不能替代升版本。`tests/fixtures/kernel-history-previous-schema/` 仅保存仍支持升级的旧内核 history SQL，逐版对原有白名单核对；它不依赖当前领域或旧工作区建库器，也不由 `--write` 更新。生成文件发生合并冲突时，同步 main 后重新生成，不手工拼接。

## 跨文件约束
以下记录 K1 从旧工作区拆分时的约束去向；现行对象以权威声明及 `--report` 为准。

160 列外键全是 `NO ACTION`，没有级联。清单第 5 节逐条列出；新内核（K1）按下面的规则实现，PR #104 附了逐条的对照表。

按去掉豁免条件后的 SQL 算，跨文件的触发器共 46 个：读别的库的 14 个、建在过程表上写目标修订的 12 个、Mio 配额 20 个。`scene_task_state_transitions` 只在字符串 `'shots'` 里出现表名，不读别的库，不算在内。

- **本机记录、缓存表指向内容表的外键**（分别 62 列、3 列），以及这两类表上查内容表的触发器：改成连接级的临时触发器，完整模拟 `NO ACTION` 外键：
  - 插入子行、子表改外键列时，父行必须存在；
  - 删除被引用的父行、改被引用的父键时报错；
  - 外键列为空时不检查（`MATCH SIMPLE`），复合外键只要有一列为空就不检查。
- **两个原本延迟检查的跨文件外键：** `image_tasks(versionId,id,groupId,projectId)` 指向 `image_versions`，`scene_tasks(resultId,projectId)` 指向 `scene_results`。临时触发器只能立即检查。
  - 插入路径：现有代码先插结果行，再回填任务的 `versionId`、`resultId`，所以立即检查也能过。
  - 删除和改父键的路径：同一事务里先删父行、后清子行的写法，改成立即检查以后会失败。在真实的表上走不到这条路径，因为 `image_versions`、`scene_results` 本来就有保留类和不可改的触发器。
  - K1 把这两项写进了对照表，并有测试。
- **内容表指向过程表的外键：** 共 10 列，属于 5 个复合外键：`versions.jobId` 指向 `jobs`，`image_groups`、`image_versions` 指向 `image_tasks`，`scene_results` 指向 `scene_requests`、`scene_tasks`。去掉约束，ID 列保留为普通列；本机没有对应的过程记录时，代码按“来自别处”处理。`image_groups.activeTaskId` 在本机找不到对应任务时当作空闲。
- **内容表上查过程表的 4 个触发器**（`reject_legacy_frame_asset_owner`、`reject_image_frame_asset_owner`、`scene_result_identity`、`subject_variant_version_binding`）：改成连接级的临时触发器。
- **Mio 配额的 20 个触发器：** 建在 Mio 表上的 16 个改写，只统计本机记录里的 Mio 表；建在放行表上的 4 个删除。上限在 R1 再定。
- **和删除记账、旧版助理有关的 124 个触发器：**
  - 建在要删除的表上的 16 个：不建；
  - 其余 108 个只是带着删除记账的豁免条件 `NOT EXISTS(SELECT 1 FROM project_deletion_scope …)`，删除项目时放行。新库没有删除记账，去掉这个条件后照建：
    - 目标修订 68 个：内容表上的 56 个照建；建在 `jobs`、`exports`、`image_tasks`、`frame_tasks` 上的 12 个会写项目文件里的目标修订表，所以改成临时触发器。这四类过程实体的修订号移到本机记录（10-31 定，R1 做，R1 之前照现在的样子）：K1 实测，这四张表的每次写入都会改项目文件、让内容序号加 1，生成任务轮询进度时项目文件一直在变。移走以后，这 12 个就是本机记录里的普通触发器；
    - 保留类 40 个（项目文件 7 个、本机记录 32 个、应用库 1 个）：没有豁免条件以后，这些行一律不能删。V1 恢复版本时，不删受保护的行（生成结果、标注修订、主体版本等），只恢复可变的状态，例如选中的版本、时间线和墓碑。
- **应用库**指向内容表的 1 列外键改由代码检查。
- **运行时的结构探测：** 有些代码通过 `sqlite_master`、`main.sqlite_schema` 判断表是否存在。挂载以后这些查询只看主库，查不到别的库里的表，而且不报错。S0 删掉这些代码，Mio 文件里的由己删，或者和己约好由 S0 删；S0 开工前，协调人在清单里补上这份列表。
- **`PRAGMA foreign_key_check` 必须带库名**，例如 `PRAGMA project.foreign_key_check`；不带库名只查主库。跨文件的关系用测试辅助函数 `foreignKeyCheck(db)` 检查。

## 放行设置、草稿和建库文件
- **放行设置：** 全局放行档位及其回执（2 张表）放在应用库；对话级覆盖及其回执（2 张表）跟着对话，放在本机记录里。两者都不在项目文件里，别人发来的项目照样放宽不了权限。这样 `agent_task_conversation_policy_owner_v2` 也不再跨文件。
- **草稿：** clip、delivery、shot-text 草稿分别存在本项目 `history.db` 的 `local_clip_drafts`、`local_delivery_drafts`、`local_shot_text_drafts`；`local_draft_states` 保留每类已保存空状态的 scope。写入只使用宿主持有的同一个连接和短事务，不改变项目文件、内容序号或内容身份。执行原业务仍遵循原业务事务及回执，不与草稿终态伪装成一次提交。
  - `local-drafts-v1.json`、`local-delivery-v1.json`、`local-shot-text-v1.json` **已退役**：不导入、不再读取或写入，原位、原名、原字节保留，可以手工删除。打开、升级和关闭不会自动删除或改名这些文件，旧 pending 不会被自动恢复执行。
  - scope 继续绑定渠道、本机目录和该连接持有的 `history.db` 文件身份；instanceId 每次宿主打开重新生成，不落库。GET/list 不建记录，discard 留修订墓碑；成功 ACK 在 SQLite COMMIT 后发出，丢失 ACK 仍须重新读取或显式恢复确认。
  - Mio 撤销素材导入的零消费者证明会按真实槽结构检查 clip 草稿的 `source.assetId`；当前片段已经移除也不丢弃该依赖。`draft:null` 墓碑没有素材引用；scope、delivery 名称/导出意图和 shot-text 文本/窄 patch 没有素材身份，归入忽略清单。文本中恰好出现素材 UUID 不构成引用。
  - 0.1.0 只发布 macOS。Windows 的 clip 接口保持不可用；delivery/shot-text 可读，变更操作在任何 SQL 效果前报本地错误族的 `STORAGE_UNAVAILABLE`，不再先写入后返回 `SAVE_UNCERTAIN`。Windows 保存支持另行实施和原生验收。
- **Mock 供应商的账本：** Mock 供应商运行时在库连接上建的 `mock_provider_tasks`、`mock_provider_submissions` 两张表和它们的索引，收进本机记录的任务领域（`schema/domains/tasks.ts`），本机记录的格式版本从 1 升到 2。供应商照旧用不带库名的 `CREATE TABLE IF NOT EXISTS`，在主库也就是本机记录里找到这两张表，不会再建；不收进来的话，下次打开时本机记录的结构对不上清单，报 `PROJECT_INVALID`（`schema`）。
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
K0 定下名字和语义，W2 先在旧存储实现；S0 P4 已将全部七个辅助函数切到真实新内核。

```ts
projectDatabasePath(root: string): string                 // 取代直接拼 workbench.sqlite
openProjectDatabase(root: string): DatabaseSync           // 按“一个连接，三个库”的顺序打开；只在 store 和服务端都没占着项目时用
schemaObjects(db: DatabaseSync): SchemaObject[]           // 主库和挂载库的结构合在一起
projectDirFor(dataDir: string, projectId: string): string // 取代直接拼 <dataDir>/media/…
createServerProject(dataDir: string, options?: {name?: string; projectId?: string}): {projectId: string; store: ProjectStore<DatabaseSync>}
foreignKeyCheck(db: DatabaseSync): ForeignKeyViolation[]  // 所有库，以及用临时触发器模拟的跨文件关系
withoutForeignKeys<T>(db: DatabaseSync, write: () => T): T // 只在这次写入前后关外键，写坏数据用
```

- `SchemaObject`、`ForeignKeyViolation` 两个类型定义在 `project-file.ts`。新内核上的 `schemaObjects`、`foreignKeyCheck` 由 K1 实现（`packages/business/src/project-file/cross-file/inspect.ts`），W2 在旧存储上实现同样的签名。
- 不带库名的 `PRAGMA foreign_key_check` 只查主库。K1 清点出生产代码里有 3 处、测试里有 21 个文件这样写，改用 `foreignKeyCheck` 或带上库名：生产代码那 3 处归 S0，测试归 W2。
- `openProjectDatabase` 设置和内核相同的 pragma，建同样的连接级临时触发器，否则经这个连接写入时会绕过跨文件约束和目标修订触发器。store 或服务端还占着这个项目时拒绝打开；旧存储上也执行这条规则，例如发现 `server.lock` 存在就拒绝。
- `createServerProject` 给“先填库、再起服务”的测试用：按服务端的布局建一个已登记的项目，返回 `{projectId, store}`。写完先 `store.close()`，再 `startServer({dataDir})`。切换以后，服务端只认登记过的项目，看不到在 `dataDir` 本身建的 store。
  - 项目名用 `name` 选项给，不要建好以后再用 `store.put` 改名。切换以后，服务端的项目列表读的是登记里的名字；测试自己关掉的 store 不会更新登记，所以事后改的名字在列表里看不到。
  - 共用种子可以用可选的 `projectId` 指定固定项目 ID，每个项目调一次；只接受 `isProjectId` 认可的小写 UUID，非法值抛错。复用生产创建/登记函数检查已有 ID，重复时报错且不覆盖；初始化失败时关闭三库并清理本次创建的文件和登记。不传或传 `undefined` 时照旧生成新 ID，显式的 `null` 或其他非字符串值不能当成缺省值。
  - 固定 ID 只供测试种子使用，服务端不允许客户端选择项目 ID；这样的测试不能证明 ID 生成行为。S0 的新内核版沿用同一个选项。
- `withoutForeignKeys` 给要写坏数据的测试用，例如一行属于或指向这个 store 里没有的项目；测试不再自己开关 `PRAGMA foreign_keys`。切换以后，本机记录指向项目文件的关系由临时触发器检查，这个 pragma 管不到，S0 只换这一个函数的实现。它必须在事务外开始；`write` 返回 Promise 时，等它结束再打开外键，所以能包住一次在自己的事务里篡改的 service 调用。
- 查结构按名字找对象，不按库名断言。旧存储上的对象都在 `main` 里；切换以后，内容表在 `project`，本机记录在 `main`。

### 测试里怎样访问库
生产和测试一样，都用独占锁，测试不开特例。

- store 打开期间要查库或改库：直接用 `store.db`，不要另开连接。
- 要模拟别的进程，或者检查重开后的状态：先 `store.close()`，再用 `openProjectDatabase(root)`。
- 服务端运行期间要查库：
  - 进程内启动的服务端：用受信任的测试接口 `inspectProject`，见下一节；
  - 子进程里的服务端：通过测试夹具的固定 IPC 消息让实际 owner 调用 `inspectProject`，或调整检查的时机；不传任意 SQL、路径或可执行回调；
  - 也可以先关掉服务端再打开，或者改用接口读取。
- 生产代码由内核的 connection 统一打开项目。除了打开时第 1 步单独打开项目文件，不另开连接；K1 的守卫测试约束此边界。
- 同一进程或另一个进程对活跃项目再开 store，均报 `PROJECT_LOCKED`，没有 `lock:false` 旁路。检查重开状态须先关 owner；检查运行中的服务端则复用其连接，不把第二连接搬进子进程绕锁。
- 项目打开期间，测试也不能用 `fs` 读、拷贝库文件或算它的哈希，见“一个连接，三个库”。要算哈希，在子进程里算，或者先关掉 store。

### 受信任的测试接口
进程内启动的 `startServer` 增加一个只供测试用的受信任选项 `inspectProject`，写法参照现有的 `taskFault`、`taskGatewayV2`：注释写明只供测试，从不来自 HTTP 或环境变量。交给测试的方式和函数的形状：

```ts
startServer({…, inspectProject: inspect => { … }})
type InspectProject = <T>(projectId: string, inspect: (db: DatabaseSync) => T) => T
```

- 这个选项是一个接收函数。服务端打开 store 以后、启动完成以前调用它一次，把 `InspectProject` 交给测试。测试把它存下来，服务端运行期间用它查库。
- 回调在项目宿主自己的连接上同步执行，不会撞上独占锁，也不能跨 `await` 持有连接。
- W2 先在旧服务端上加，只在 `apps/server/src/index.ts` 里加一小块；S0 再换成项目宿主的实现，交给测试的方式不变。

应用库使用同样的受信接收方式：`startServer({inspectApplication: inspect => { … }})`，其中 `InspectApplication = <T>(read: (db: DatabaseSync) => T) => T`。它只借用当前服务端实际持有的 B1 连接，拒绝 async 回调、Promise/thenable 返回及关闭后的调用；不新增 HTTP、CLI 或环境变量开关。测试子进程只回答固定应用快照或固定故障问题，不把 SQL 接口公开出去。活动库文件及其日志、改名或硬链接不通过 `fs` 读取，快照使用真实 owner 的全行、结构和变更标记，普通文件另作字节快照。

长时间核对零写入的夹具可通过仅进程内的 `retainProjectForTest` 接收端取得 `retain(projectId): Promise<() => void>`，在基线前持有真实 `window` 租约，结束后释放。这样普通的 60 秒空闲关闭及应用库登记不会混入只读操作的测量；原有行快照和 `total_changes()` 断言仍全部检查。它不接受 HTTP/环境输入，不改变生产空闲策略，也不允许异步持有检查回调里的数据库连接。

## 待定
- 封面接口已在 P4 定为 `GET /api/project-covers/<ID>`；后续首页体验归 S6。
- 打开副本时的提示还没有设计稿，打开结果里暂不带副本信息。
- 收件箱条目的结果字段留0.1.x的S3-B/C另排应用库版本；S3-A不扩表、不加应用接收器。恢复预览的改动列表沿用 Mio 修改卡片的展示词汇。
