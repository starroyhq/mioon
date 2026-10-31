# 项目文件 v1：约定（草稿）
日期：2026-10-30 起草，10-31 按新内核（K1、S0a）的实测和协调人的决定补充。状态：草稿；约定要改时提给协调人。

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

## 用法不变
`openStore(root)`、`createServices(store)`、`startServer({dataDir})` 的用法都不变。`dataDir` 改为应用数据目录。

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
  - 未加限定的表名，SQLite 依次到各个库里找，所以现有 SQL 大多不用改。
  - 建表、建触发器，以及 `PRAGMA user_version`、`PRAGMA application_id` 这类语句要带库名，不带时落到主库，也就是本机记录。`PRAGMA foreign_key_check` 不带库名时只查主库。
  - 日志模式和锁模式另有规则，见下面的“日志模式按库名设”。
- **为什么本机记录作主库：**
  - 跨文件提交时，SQLite 把超级日志建在主库旁边，并在每个文件的日志里记下它的绝对路径。
  - 项目目录会被移动，这是常规操作；本机记录的位置固定。
  - 项目文件作主库时，提交中途崩溃后再移动项目目录，SQLite 照旧路径找不到超级日志，就把两边的热日志都当成已提交，项目文件或本机记录损坏（实测 `database disk image is malformed`）。
  - 本机记录作主库时，同样的情况下两个文件都能正确回滚。
- **打开顺序：**
  1. 单独打开项目文件，读出项目 ID 和格式版本，同时让 SQLite 完成恢复，然后关掉；
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
  - 内核要在 `store.tx` 开头和 `put` 里各做两次 `lstat`，两条都满足就抛 `PROJECT_FILE_MOVED`（HTTP 409）：
    - 打开时的路径上没有文件了，或者换了文件身份；
    - 原路径的 `-journal` 还在，说明是单独移动了文件，不是连同文件夹一起移动。移动文件夹时日志跟着走，写入照常，不报错。
  - 宿主收到这个错误，或者 1032，就 `relocate`：停写、关掉，按文件身份找到新位置后重开。请求方重试即可。
  - 内核的检查合入以前，宿主先把同样的检查登记成事务守卫，抛同样的错误。
- **崩溃后没在本机恢复就被拷走：** 拷到别的电脑上的项目文件可能带着半个事务，因为那边找不到本机记录旁边的超级日志。S0、S6 在启动时，以及列最近项目时，对没打开的项目调用内核的 `recoverProjectFile(projectFile)`：它只做打开顺序的第 1 步，项目文件旁边的日志是热日志时，单独打开项目文件、取锁让 SQLite 回滚、关掉，不打开本机记录。结果：
  - `clean`：没有要恢复的；`recovered`：已回滚；
  - `locked`：别的进程开着它，并且正在写，这里不用管，打开时会报 `PROJECT_LOCKED`；
  - `open-here`：本进程开着它，按内核的已持有文件登记表认出，不碰文件；
  - `missing`：找不到，按文件身份找新位置；
  - `invalid`：带打开时会报的 `PROJECT_INVALID` 原因，例如 `not-a-project-file`、`read-only`（只读位置上的热日志回滚不了）。
  - **没有热日志时不读项目文件**（10-31 定，S0 切换时改）：先看项目文件旁边的 `-journal`，没有、是 0 字节或不是热日志，就直接返回 `clean`，不读项目文件的头。首页每次列项目都会调它；放在 iCloud 里、已经被系统移出本机的项目文件，一读文件头就会被整个下载回来。现在的内核先读文件头，不是项目文件的也会报 `invalid`；改了以后，旁边没有热日志的这种文件，要等打开时才报出来。
- **事务：** `store.tx` 用 `BEGIN`，不用 `db.ts` 的 `BEGIN IMMEDIATE`，这是和 `db.ts` 唯一有意的差别。独占锁下 `BEGIN IMMEDIATE` 已经没有提前取锁的作用，反而让每次提交都把三个库拉进写事务、建一个超级日志。用 `BEGIN` 时只有写到的库进入写事务：只写本机记录的提交（例如 Mio 流式输出）不碰项目文件，也不建超级日志；同时写两个文件的提交照旧用超级日志。K1 实测，p50 从 1.11 ms 降到 0.34 ms。
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
  - **自动关闭**（10-31 定，S0 实现）：没有租约、没有在途请求、运行时也不忙，而且最后一个请求结束已满 60 秒，就关闭。关窗口不用等这 60 秒。有未完成的后台任务（S3 持有的租约）或 Mio 正在跑时不关。
- **封面**（10-31 定）：宿主在打开时、关闭前，以及封面素材变了时，把封面缩成长边 512 像素的 JPEG，和一个记素材 ID、指纹的 `cover.json` 一起存进这个项目的缓存目录。应用级的封面接口只读这两个文件，不打开项目，找不到时界面显示占位图。封面不写进项目目录，接口名由 S6 和 B1 定。
- **生命周期操作：** 删除、复制、改名、关闭、另存为虽然带 projectId，但属于应用级操作，因为它们要关掉项目宿主、改登记。
- 桌面主进程也是客户端（`main.ts` 等 5 个文件），在 K2 的范围里。`native-audio-preview-host.ts` 只给 `/api/timeline-audio-preview` 开头的请求加原生音频签名头，路由挪动时要一起改。

## 错误码
| 错误码 | 什么时候 | 带什么 |
|---|---|---|
| `PROJECT_MISSING` | 找不到项目文件（设计稿 12-03） | `projectFile`；`projectId` 在文件读不出来、也没有登记时为 `null` |
| `PROJECT_LOCKED` | 已在另一个 Mioon 中打开（12-03b） | 同上 |
| `PROJECT_FORMAT_NEWER` | 格式比当前 Mioon 支持的新（12-03c） | 另带 `database`（`project`、`history` 或 `cache`，本机记录有自己的格式版本）、`formatVersion`、`supportedFormatVersion` |
| `PROJECT_INVALID` | 文件损坏、不是项目文件、结构对不上，或在只读位置（12-03d） | 同第一行，另带 `reason`（`PROJECT_INVALID_REASONS`） |
| `PROJECT_FILE_SINGLE_PROJECT` | store 级 `project.create` 用在已有项目的文件上 | |
| `PROJECT_FILE_EXISTS` | 新建时目标位置已有文件；HTTP 409 | 内核的详情照打开错误的写法，是 `{database: 'project', reason: 'exists'}`，不放绝对路径；应用级的新建再补上 `projectFile` |
| `PROJECT_FILE_MOVED` | 项目打开期间单独改名或移动了 `.mioon`，文件夹没动；HTTP 409 | `details` 带 `projectId`。宿主正在按新位置重开，重试即可，见“只改名或单独移动 `.mioon`” |
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
- **本机记录清单：** 项目 ID、大小，以及文件夹里有没有还用得着的超级日志（`hasSuperJournal`，按内核的 `isSuperJournalInUse` 算）。列清单时不打开 `history.db`；有还用得着的超级日志的不能删。

## 跨文件约束
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
K0 只定名字和语义，由后续的卡实现：W2 先在旧存储上实现，S0 再换成新内核的实现。

```ts
projectDatabasePath(root: string): string                 // 取代直接拼 workbench.sqlite
openProjectDatabase(root: string): DatabaseSync           // 按“一个连接，三个库”的顺序打开；只在 store 和服务端都没占着项目时用
schemaObjects(db: DatabaseSync): SchemaObject[]           // 主库和挂载库的结构合在一起
projectDirFor(dataDir: string, projectId: string): string // 取代直接拼 <dataDir>/media/…
createServerProject(dataDir: string): {projectId: string; store: ProjectStore<DatabaseSync>}
foreignKeyCheck(db: DatabaseSync): ForeignKeyViolation[]  // 所有库，以及用临时触发器模拟的跨文件关系
```

- `SchemaObject`、`ForeignKeyViolation` 两个类型定义在 `project-file.ts`。新内核上的 `schemaObjects`、`foreignKeyCheck` 由 K1 实现（`packages/business/src/project-file/cross-file/inspect.ts`），W2 在旧存储上实现同样的签名。
- 不带库名的 `PRAGMA foreign_key_check` 只查主库。K1 清点出生产代码里有 3 处、测试里有 21 个文件这样写，改用 `foreignKeyCheck` 或带上库名：生产代码那 3 处归 S0，测试归 W2。
- `openProjectDatabase` 设置和内核相同的 pragma，建同样的连接级临时触发器，否则经这个连接写入时会绕过跨文件约束和目标修订触发器。store 或服务端还占着这个项目时拒绝打开；旧存储上也执行这条规则，例如发现 `server.lock` 存在就拒绝。
- `createServerProject` 给“先填库、再起服务”的测试用：按服务端的布局建一个已登记的项目，返回 `{projectId, store}`。写完先 `store.close()`，再 `startServer({dataDir})`。切换以后，服务端只认登记过的项目，看不到在 `dataDir` 本身建的 store。

### 测试里怎样访问库
生产和测试一样，都用独占锁，测试不开特例。

- store 打开期间要查库或改库：直接用 `store.db`，不要另开连接。
- 要模拟别的进程，或者检查重开后的状态：先 `store.close()`，再用 `openProjectDatabase(root)`。
- 服务端运行期间要查库：
  - 进程内启动的服务端：用受信任的测试接口 `inspectProject`，见下一节；
  - 子进程里的服务端：改成进程内启动，或者调整检查的时机；
  - 也可以先关掉服务端再打开，或者改用接口读取。
- 生产代码对项目文件只开一个连接，现在只有 `db.ts` 打开库文件。除了打开时第 1 步单独打开项目文件，不另开连接；K1 已经加了守卫测试，防止以后有人另开连接。
- 同一进程对同一个项目再开一个 store，报 `PROJECT_LOCKED`。例如用 `openStore(root,{lock:false})` 再开一个连接的测试，要先 `close()`，或者把第二个连接放进子进程。
- 项目打开期间，测试也不能用 `fs` 读、拷贝库文件或算它的哈希，见“一个连接，三个库”。要算哈希，在子进程里算，或者先关掉 store。

### 受信任的测试接口
进程内启动的 `startServer` 增加一个只供测试用的受信任选项，写法参照现有的 `taskFault`、`taskGatewayV2`：注释写明只供测试，从不来自 HTTP 或环境变量。名字和形状：

```ts
inspectProject<T>(projectId: string, inspect: (db: DatabaseSync) => T): T
```

- 回调在项目宿主自己的连接上同步执行，不会撞上独占锁，也不能跨 `await` 持有连接。
- W2 先在旧服务端上加，只在 `apps/server/src/index.ts` 里加一小块；S0 再换成项目宿主的实现。选项怎样把这个函数交给测试，由 W2 定、S0 沿用。

## 待定
- 封面接口的名字：S6、B1。
- 打开副本时的提示还没有设计稿，打开结果里暂不带副本信息。
- 收件箱条目的结果字段由 S3 补上；恢复预览的改动列表沿用 Mio 修改卡片的展示词汇，V1 可以补字段。
