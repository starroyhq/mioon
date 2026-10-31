# 项目宿主：接口草稿（S0 第一步）
日期：2026-10-31。状态：草稿。接口和第 7 节的 10 件事已由协调人定下（10-31）；S1–S6、S8、R1、V1 在这个接口上开发。

项目文件 v1 以后，后端同时开着多个项目：每个打开的项目有一个“项目宿主”，里面是这个项目的 store、服务、后台任务循环和 Mio 运行时；应用级的“宿主管理器”负责列出、新建、打开、关闭项目，按 URL 里的项目 ID 把请求交给对应的宿主。

这份文档定下宿主的接口、生命周期和下一轮切换的计划。不在其中的：

- **S0 的切换本身**：接到 `composeServer`、改 `services.ts` 和 `db.ts`、K1 交接的修改、删旧路径。等接口审过、第一波的卡合入以后另起一轮，见第 6 节。
- **内核上的改动**（S0a，PR #106）：本分支不实现，只写宿主在什么时候调用，见第 5 节。

约定以 `PROJECT-FILE.md` 为准，本文只引用、不重复。代码在 `apps/server/src/project-host/`：

| 文件 | 内容 |
|---|---|
| `types.ts` | 租约种类、宿主状态、关闭原因、项目可用性、默认时长、状态和事件。不引入任何模块 |
| `naming.ts` | 由项目名得出文件夹名，以及序号。不引入任何模块 |
| `errors.ts` | 寻址错误、宿主错误、`isDatabaseMovedError`。只引入 `app-error.ts`、`project-file.ts` 两个契约 |
| `folders.ts` | 占用新项目的文件夹 |
| `directories.ts` | 应用级的目录，以及给内核的 `locate` |
| `host.ts` | 单个项目宿主的类型 |
| `ports.ts` | 需要别的卡提供的端口 |
| `stand-ins.ts` | 端口在那些卡合入之前的替身 |
| `manager.ts` | 宿主管理器和新建项目 |
| `index.ts` | 显式导出 |

前三个文件网页也能导入，按路径导入，不经过 `index.ts`。宿主放在服务端，因为它要用服务端的设置、密钥编解码和网关。测试是 `tests/project-host-naming.test.ts`、`tests/project-host-directories.test.ts`、`tests/project-host-manager.test.ts`，都在本进程里跑，用真实的内核 store 加假的运行时。

## 1. 清点

`apps/server/src/index.ts` 的 `composeServer` 现在建的每一样东西，分成三类。“卡”一列是由哪张卡挪动或改写。

### 每个项目一份（进项目宿主）

| 组成部分（`composeServer` 里的名字） | 理由 | 卡 |
|---|---|---|
| `store`（`openStore(root)`） | 一个 `.mioon` 一个连接，独占锁从打开到关闭 | S0 |
| `providers`（`createProviderRegistry({db, root, env})`） | Mock 供应商把任务账本建在 store 的连接上；真实供应商用 `root` 读参考图、存下载 | S0（Mock 的两张表收进本机记录），S1、S2（`root`） |
| `services`（`createServices`）和 `services.drain()` | 绑定 store | S0 |
| `worker`（`startWorker`） | 只扫已打开项目的 `jobs`（计划第 9 节） | S0；调度和任务索引归 S3 |
| `editTasks`、`reconcileStartup()`、`editTasksHttp`（`/api/tasks…`） | 编辑任务记在本机记录；打开时对账 | S0 |
| `taskToolsV2`、`taskRuntimeV2`，`taskHttpV2` 的项目路由和 `editing` | Mio 的对话和步骤记在本机记录 | S0 接线，R1 改运行时 |
| `versionComparisonMedia` | 读这个项目的素材 | K2 改路径，S0 |
| `exportFileRecovery`（`/api/export-files`） | 同上 | K2 改路径，S0 |
| 预听：`audioPreviewHttp`、`continuousAudioHttp`、`services.audioPreview` | 同上 | K2 改路径，S0 |
| 图片审阅的 `approve`、`reject`（`imageHttp` 里调 `imageApproval`、`imageRejection` 的两条） | 按审阅 ID 在项目里找 | K2 改路径，S0 从 `imageHttp` 拆出 |
| 本机草稿：`localDrafts`、`localDelivery`、`localShotText` 和它们的 HTTP，`shotTextDomain`、`shotReplay` | 草稿属于本机记录 | S8；S8 之前每个宿主一份，三个 JSON 文件放 `localDir` |
| `files`（`createFileResponses`）的媒体流 | 关闭项目要等它的文件流；静态文件另用应用级的一份 | S0 |
| 删除闸门的请求跟踪（`deletionGate.track`、`rpc`）和 `hold()` | 换成宿主的请求租约；`hold()` 算进运行时的忙碌和排空 | S0 |
| `/api/projects/<id>/package-preview`（交换文件的预览） | 读项目内容；已经在新前缀下 | V4 删除；之前进宿主 |

### 整个应用一份

| 组成部分 | 理由 | 卡 |
|---|---|---|
| HTTP 服务、`handleRequest`、Host 和 Origin 检查、`auth`、`access-token`、`/api/login` | 不随项目 | 不变；S0 改分派 |
| 静态文件（`distDir`、`index.html`） | 同上 | 不变 |
| `agentSettings`（网页版的 `agent-settings/`，桌面版由主进程代理）和密钥编解码（`agentSecretCodecFactory`、`imageSecretCodec`、`videoSecretCodec`） | 设置和密钥属于这台电脑 | 不变 |
| `agentAuthorizations`（`agent-authorizations-v1.json`） | 发送授权属于这台电脑；范围改按应用库的文件身份算（定下的两处之一） | S0，和己、B1 确认 |
| 图片、自定义图片、视频、ComfyUI 的设置和连接（`imageSettings`、`customImageSettings`、`videoSettings`、`comfySettings`、`comfyConnector`），两个图片网关，以及它们的 HTTP | 同上 | 不变 |
| 全局放行档位（`/api/agent/tasks/v2/policy`、`/policy/requests/<id>`）、测试连接（`/diagnostics/latest`）、`agentDiagnosticsHttp` | 这几张表进应用库；`agentDiagnosticsHttp` 带 `projectId` 时，`hasProject` 改查登记，存储统计只在项目开着时给（不触发自动打开） | B1、S0、己 |
| `uiPreferences`（`ui-preferences-v1.json`，含 `recentOpened`） | B1 收进应用库；`hasProject` 改查登记 | B1、S0 |
| 工作区配置 `createWorkspaceConfiguration`（`workspace-settings-v1.json`、`environment()`） | B1 收进应用库；自动备份的字段随 S7 去掉 | B1、S7 |
| `workspacePreferences`（`workspace_preferences` 表，按 projectId） | 表进应用库，项目在不在改查登记 | B1、S0 |
| `lastProject`（`last-project-v1.json`） | 改由最近项目登记提供 | B1、S6 |
| 媒体进程 `onMediaProcess`、`terminateMediaProcesses` | 进程级 | 不变 |
| `/health`、`/api/workspace-info`、`/api/media-tools/check` | `/health` 不再读项目库（用 `process.versions.sqlite`）；`/api/workspace-info` 改成应用信息，`pendingProjectCleanup` 随 S5 去掉 | S0 |
| 存储预检 `validateWorkspaceStorage(root)` 和单实例锁 `server.lock` | 改成应用数据目录的检查（去掉 `workbench.sqlite`、`media/`、暂存目录这些条目）。单实例锁仍在应用数据目录，现在由 `db.ts` 的 `openStore` 取（`workspace-lock.ts`），切换后由 `startServer` 自己取 | S0 |
| `shutdown` 中止信号 | 应用一份；每个宿主另有自己的信号，应用退出时全部关闭 | S0 |
| `nativeAudioPreview` 授权对象 | 每个 utility 进程一个，`bind()` 只能调一次（`native-audio-preview.ts`）；改为绑定一个按 projectId 分派到宿主的服务 | S0 |
| 桌面 `backend.ts` 的授权代理、两个密钥客户端、字幕资源；`cli.ts` 的私有存储初始化和无界面密钥编解码 | 进程级 | 不变；`cli.ts` 加 `MIOON_PROJECTS_DIR`（S4 或 S0） |

### 随删除一起去掉

| 组成部分 | 卡 |
|---|---|
| v1 助理：`chatRuntime`、`chatHttp`、`createAgentEditService`、`chatGateway`、`agentEditFault` | P1a-2 |
| 透明度候选：`candidate`、`candidateEditor`、`candidateDomain`、`createOpacityCandidateRequestApplication`、`opacityCandidateLaunch` | P1b |
| 工作区备份和恢复：`resolveWorkspaceActivation`、`restored` 分支（含只读的 Mio 运行时）、`services.backups`、`setBackupDirectory`、`/api/workspace-backups/…`、`workspaceBaseRoot`、`backupQuiescent` | S7 |
| 交换文件：`projectPackages`、`/api/project-packages/…`（导出、导入归 V4；`duplicates` 改为复制文件，归 S5） | V4、S5 |
| 删除记账：`setProjectDeletionCompanions`、`deletionGate.assertIdle`、两处 `PROJECT_DELETE_BUSY` | S5（删除改为移到废纸篓，经 `withExclusive`） |

### 按 `workbench.sqlite` 算范围的模块

清点时发现，按 `workbench.sqlite` 的文件身份算“工作区范围”的不止 Mio 授权，一共 8 处：`agent/authorizations.ts`、`ui-preferences.ts`、`last-project.ts`、`local-drafts.ts`、`local-delivery.ts`、`local-shot-text.ts`（都在 `packages/business/src/`），以及桌面的 `window-appearance.ts` 和 `main.ts` 里的 LUT 恢复。切换以后 `workbench.sqlite` 不再存在，这些范围都要换文件，见 6.2 第 4 步。

## 2. 接口

签名从源码摘出，只留签名和要点注释。

### 2.1 应用级的目录（`directories.ts`）

```ts
export interface AppDirectories {
  readonly dataDir: string;     // 应用数据目录：access-token、server.lock、设置、应用库、records/、tmp/
  readonly cacheDir: string;    // 应用缓存目录；一个项目的缓存是 <cacheDir>/projects/<ID>/
  readonly tempDir: string;     // 应用临时目录；一个项目的暂存是 <tempDir>/projects/<ID>/
  readonly projectsDir: string; // 不指定位置时新项目的上级目录
}
export const PROJECT_TEMP_DIRECTORY = 'projects';
export function serverAppDirectories(dataDir: string, options?: {readonly cacheDir?: string; readonly projectsDir?: string}): AppDirectories;
export interface SystemCacheInput {readonly platform: string; readonly home: string; readonly env: Readonly<Record<string, string | undefined>>}
export function systemCacheDirectory(input: SystemCacheInput): string;
export interface DesktopDirectoriesInput extends SystemCacheInput {
  readonly appId: string;               // identity.appId
  readonly dataDir: string;             // DesktopPaths.dataDir
  readonly videosDir: string;           // app.getPath('videos')
  readonly userDataOverridden: boolean; // 设了 MIOON_DESKTOP_USER_DATA
}
export function desktopAppDirectories(input: DesktopDirectoriesInput): AppDirectories;
export function projectLocation(directories: AppDirectories, projectId: string): ProjectLocation; // 内核的 locate
```

| | 网页版、无界面服务 | 桌面版 | 桌面版，设了 `MIOON_DESKTOP_USER_DATA` |
|---|---|---|---|
| `dataDir` | `startServer` 的 `dataDir`（`cli.ts` 取 `MIOON_DATA_DIR`，默认仓库的 `data/`） | `dataPaths().dataDir`，切换时从 `<userData>/workspace` 改成新的 `<userData>/data` | `<覆盖目录>/data` |
| 新项目默认的上级目录 | `<dataDir>/projects/` | `<videos>/Mioon/`（macOS `~/Movies/Mioon/`，Windows `Videos\Mioon\`） | `<dataDir>/projects/` |
| 本机记录 `localDir` | `<dataDir>/records/<ID>/` | 同左 | 同左 |
| 缓存 `cacheDir` | `<dataDir>/cache/projects/<ID>/` | `<系统缓存目录>/<应用 ID>/projects/<ID>/` | `<dataDir>/cache/projects/<ID>/` |
| 暂存 `tempDir` | `<dataDir>/tmp/projects/<ID>/` | 同左 | 同左 |

- 系统缓存目录：macOS `~/Library/Caches`，Windows `%LOCALAPPDATA%`（缺失或不是绝对路径时用 `<home>\AppData\Local`），其他系统 `$XDG_CACHE_HOME`（同样要求绝对路径）或 `~/.cache`。
- 内核按私有目录的规则建这三个本机目录：0700、本人所有、路径里不能有符号链接（`tests/project-host-directories.test.ts` 实测）。所以 macOS 的系统临时目录（经过 `/var` 这个符号链接）不能用，`tempDir` 放在应用数据目录下。
- `tempDir` 可能和项目目录不在同一个盘上，暂存文件移进项目目录时不能只靠一次改名（`EXDEV`）。
- 本机记录的文件夹以后不能搬（`PROJECT-FILE.md`“一个连接，三个库”），所以 `dataDir` 的取法要在切换时一次定好。桌面版定为新的 `<userData>/data/`（第 7 节第 3 条）：切换时改 `config.ts` 的 `dataPaths`；旧的 `workspace/` 里的开发数据不迁移，也不再读。
- 网页版和无界面服务的 `dataDir` 里有旧的 `workbench.sqlite` 时，启动报错，提示换一个目录或删掉旧文件，不和新布局混在一起。
- `desktopAppDirectories` 在主进程里算：桌面后端拿不到 `app.getPath`，`supervisor.ts` 的启动消息只有 `dataDir`、`distDir`、`subtitleResourcesDir`、`token`、`nativeAudioPreview`，`utilityEnvironment` 也不转发 `LOCALAPPDATA`、`XDG_CACHE_HOME`。主进程把 `cacheDir`、`projectsDir` 传给后端。Windows 的路径用 `path.win32` 拼，在 macOS 上也能测。

### 2.2 项目宿主的管理器（`manager.ts`）

```ts
export interface ManagerClock {now(): number; setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void}
export const SYSTEM_CLOCK: ManagerClock; // 真实时间，计时器 unref
export interface ProjectHostManagerOptions<Runtime extends ProjectHostRuntime> {
  readonly directories: AppDirectories;
  readonly registry: ProjectRegistryPort;
  readonly factory: ProjectHostFactory<Runtime>;
  readonly identity?: ProjectFileIdentityPort;          // 默认 statProjectFileIdentity
  readonly taskIndex?: BackgroundTaskIndexPort;         // 默认空的内存索引
  readonly hooks?: readonly ProjectLifecycleHooks[];    // 默认 []
  readonly maintenance?: KernelMaintenancePort;         // 默认 STAT_ONLY_MAINTENANCE
  readonly idleCloseMs?: number;                        // 默认 DEFAULT_IDLE_CLOSE_MS（60 秒）
  readonly drainTimeoutMs?: number;                     // 默认 DEFAULT_REQUEST_DRAIN_MS（3 秒）
  readonly busyRecheckMs?: number;                      // 默认 DEFAULT_BUSY_RECHECK_MS（1 秒）
  readonly clock?: ManagerClock;                        // 默认 SYSTEM_CLOCK
  readonly openStore?: (options: OpenProjectConnectionOptions) => ProjectStore; // 默认内核的 openProjectStore
  readonly onEvent?: (event: ProjectHostEvent) => void; // 抛错被忽略
}
export interface CreateProjectInput {
  readonly name: string;          // project.create 的 name，1–150 字
  readonly projectFile?: string;  // 指定的 .mioon：从不覆盖，所在文件夹必须存在
  readonly parentDir?: string;    // 新文件夹的上级；默认 directories.projectsDir
  readonly projectId?: string;    // 只给测试；不能已经登记
}
export interface CreateProjectPorts {readonly directories: AppDirectories; readonly registry: ProjectRegistryPort; readonly identity: ProjectFileIdentityPort}
export function createProjectFiles(input: CreateProjectInput, ports: CreateProjectPorts): RecentProject;
export interface RestoreResult<Runtime extends ProjectHostRuntime> {
  readonly leases: readonly ProjectLease<Runtime>[];
  readonly failures: readonly {readonly projectId: string; readonly error: unknown}[];
}
export interface ListedProject {readonly project: RecentProject; readonly availability: ProjectAvailability}
export interface ProjectHostManager<Runtime extends ProjectHostRuntime = ProjectHostRuntime> {
  list(): readonly ListedProject[];
  create(input: CreateProjectInput): Promise<RecentProject>;
  openPath(projectFile: string, kind: ProjectLeaseKind): Promise<ProjectLease<Runtime>>;
  acquire(projectId: string, kind: ProjectLeaseKind): Promise<ProjectLease<Runtime>>;
  close(projectId: string): Promise<void>;
  closeAll(): Promise<void>;
  withExclusive<T>(projectId: string, run: (registration: RecentProject) => T | Promise<T>): Promise<T>;
  restore(): Promise<RestoreResult<Runtime>>;
  checkMoved(projectId: string): boolean;
  readonly inspectProject: InspectProject;
  status(projectId: string): ProjectHostStatus | null;
}
export function createProjectHostManager<Runtime extends ProjectHostRuntime = ProjectHostRuntime>(options: ProjectHostManagerOptions<Runtime>): ProjectHostManager<Runtime>;
```

`types.ts` 里的共用类型：

```ts
export const PROJECT_LEASE_KINDS = Object.freeze(['window', 'task', 'request'] as const);
export const PROJECT_HOST_STATES = Object.freeze(['opening', 'open', 'closing'] as const);
export const PROJECT_CLOSE_REASONS = Object.freeze(['idle', 'explicit', 'exclusive', 'relocate', 'shutdown'] as const);
export type ProjectAvailability =
  | {readonly state: 'open' | 'busy' | 'available' | 'locked' | 'missing'}
  | {readonly state: 'invalid'; readonly reason: string};
export const DEFAULT_IDLE_CLOSE_MS = 60_000;
export const DEFAULT_REQUEST_DRAIN_MS = 3_000;
export const DEFAULT_BUSY_RECHECK_MS = 1_000;
export interface ProjectHostStatus {readonly projectId: string; readonly state: ProjectHostState; readonly paused: boolean; readonly leases: Readonly<Record<ProjectLeaseKind, number>>}
export type ProjectHostEvent =
  | {readonly type: 'opened'; readonly projectId: string}
  | {readonly type: 'open-failed'; readonly projectId: string | null; readonly error: unknown}
  | {readonly type: 'closing'; readonly projectId: string; readonly reason: ProjectCloseReason}
  | {readonly type: 'closed'; readonly projectId: string; readonly reason: ProjectCloseReason; readonly errors: readonly unknown[]}
  | {readonly type: 'recovered'; readonly projectId: string}
  | {readonly type: 'maintenance-failed'; readonly projectId: string; readonly error: unknown};
```

- **`list()`**：已登记的项目，一个都不打开。本进程没开着、也不在独占操作中的项目，先各调一次 S0a 的 `recoverProjectFile`，结果放进 `availability`（第 5 节的表）。`missing` 的项目在后台按文件身份找新位置，找到就改登记、在新位置再恢复一次，下一次 `list()` 就是新路径。`availability` 只是提示，能不能打开以打开时为准。
- **`create(input)`**：建文件夹（不指定 `projectFile` 时）和 `.mioon`，登记，`lastOpenedAt` 为 `null`，不打开。名字规则见 3.1。指定的 `.mioon` 已存在报 `PROJECT_FILE_EXISTS`（409，`details` 是内核的写法再加 `projectFile`）；所在文件夹不存在报 `PROJECT_LOCATION_INVALID`（400）；不是绝对路径、扩展名不是 `.mioon`、文件名以 `.` 开头报 `VALIDATION_ERROR`。中途失败时删掉这次建出的东西。`createProjectFiles` 是同一件事的函数形式，测试辅助函数 `createServerProject` 直接用它（2.7）。
- **`openPath(projectFile, kind)`**：按路径打开（桌面的打开对话框、双击 `.mioon`、CLI 的 `project open --path`）。同一个文件（按文件身份认）已经开着就直接给租约；否则内核打开。没登记的新登记，名字取文件名去掉 `.mioon`；已登记的把登记改到这个路径。项目正在打开、关闭或独占时，在内核的 `checkCopy` 里中止，等它结束再试。内核的错误原样抛出，由应用级的 `project.open` 填进 `projectOpenFailureSchema`。
- **`acquire(projectId, kind)`**：按项目 ID 取得宿主的租约。已登记但没打开的，按登记自动打开。没登记报 `PROJECT_NOT_FOUND`；打不开报 `PROJECT_UNAVAILABLE`，见 2.5。登记的路径上没有文件（`PROJECT_MISSING`），或打开途中被移动（S0a：`PROJECT_INVALID`，起因是 1032）时，先按文件身份找一次，找到就改登记再开。登记的路径上是另一个项目 ID 的文件时，在 `checkCopy` 里拒绝（`PROJECT_UNAVAILABLE`、`reason: 'PROJECT_MISSING'`），不会给那个 ID 建本机记录。
- **三种租约**（`PROJECT_LEASE_KINDS`）：`window`，编辑窗口显示这个项目，窗口关掉时释放；`task`，S3 在项目有未完成的后台任务时持有；`request`，一个在途的 HTTP 请求，SSE 和文件流也算，响应结束时释放。`release()` 幂等。
- **什么时候自动关闭**：见 3.3。
- **`close(projectId)`**：立即关闭，撤销所有租约，在途请求先给 3 秒。各步出错照样走完，最后抛第一个错误。
- **`closeAll()`**：应用退出时用。并行关闭全部宿主，等独占操作结束；之后 `acquire`、`openPath`、`create`、`withExclusive` 都报 `PROJECT_HOST_STOPPED`（503）。
- **关闭时按文件身份更新登记**：打开时 `lstat` 记下文件身份，写进登记；关闭时再 `lstat` 打开时的路径，文件不在或身份不同，就调登记表的 `findMoved` 找新位置，找到就改登记。名字和摘要也在这一步更新。
- **`restore()`**：启动时用。和 `list()` 一样先做恢复，等后台的查找结束，再按后台任务索引逐个 `acquire(id, 'task')`，返回的租约交给 S3，任务结束时释放。除了有未完成任务的项目，启动时不打开任何项目。
- **`withExclusive(projectId, run)`**：应用级操作（删除、复制、改名、关闭、另存为）取得独占，见 4.2。
- **`checkMoved(projectId)`**：单独改名或移动 `.mioon` 的检查。定为由内核检查（第 7 节第 6 条）；内核的检查合入以前，宿主把它登记成事务守卫顶上，见 4.6。
- **`inspectProject`**：受信任的测试接口，见 2.7。
- **`status(projectId)`**：开着的宿主的状态和各类租约的个数；没开着返回 `null`。`onEvent` 收到打开、打开失败、开始关闭、关闭完成、恢复了热日志、恢复失败这几种事件。

### 2.3 单个项目宿主（`host.ts`）

```ts
export interface ProjectRequest {
  readonly req: IncomingMessage; readonly res: ServerResponse; readonly url: URL;
  readonly route: ProjectApiRoute;  // parseProjectApiPath 的结果
  readonly signal: AbortSignal;     // 强制关闭时中止
}
export interface ProjectHostContext {
  readonly projectId: string;
  readonly store: ProjectStore;     // 内核的 store：项目唯一的连接
  readonly directories: AppDirectories;
  readonly signal: AbortSignal;     // 开始关闭时中止
  relocate(): void;                 // 写入遇到 SQLITE_READONLY_DBMOVED 时调用
}
export interface ProjectHostSummary {readonly name: string; readonly summary: RecentProjectSummary | null}
export interface UnfinishedTask {readonly kind: BackgroundTaskKind; readonly taskId: string}
export interface ProjectHostRuntime {
  handle(request: ProjectRequest): Promise<boolean>;  // 项目级路由；都不匹配时返回 false
  isBusy(): boolean;
  interrupt(): void;
  drain(): Promise<void>;
  dispose(): void;
  summarize?(): ProjectHostSummary | null;            // 打开时、关闭前读
  unfinishedTasks?(): readonly UnfinishedTask[];      // S3：关闭时写进任务索引
}
export type ProjectHostFactory<Runtime extends ProjectHostRuntime = ProjectHostRuntime> = (context: ProjectHostContext) => Promise<Runtime>;
export interface ProjectHost<Runtime extends ProjectHostRuntime = ProjectHostRuntime> {
  readonly projectId: string; readonly projectFile: string; readonly store: ProjectStore;
  readonly runtime: Runtime; readonly signal: AbortSignal;
  relocate(): void;
}
export interface ProjectLease<Runtime extends ProjectHostRuntime = ProjectHostRuntime> {
  readonly kind: ProjectLeaseKind; readonly host: ProjectHost<Runtime>;
  readonly signal: AbortSignal;     // 被强制关闭撤销时中止
  release(): void;                  // 幂等
}
export type InspectProject = <T>(projectId: string, inspect: (db: DatabaseSync) => T) => T;
```

管理器拥有 store：内核打开以后，工厂在这个 store 上组装运行时，`dispose()` 之后由管理器关闭 store。下一轮生产用的工厂 `composeProjectHost`（新文件 `apps/server/src/project-host/compose.ts`）从现在的 `composeServer` 里拆出每个项目的部分，在一个宿主里建：

- `providers`、`services`；
- 编辑任务，打开时 `reconcileStartup()`；
- `worker`；
- Mio 的工具和运行时（R1 的端口）；
- 本机草稿（S8 的端口）；
- 媒体、版本对比、导出文件、预听、图片审阅等项目级 HTTP。

各个方法：

| 方法 | 做什么 |
|---|---|
| `handle(request)` | 按顺序试 `rpc`、`media`、版本对比、预听、导出文件、图片审阅、草稿、Mio（`agent/tasks/v2/…`、`editing`）、编辑任务（`tasks…`）；`rpc` 里沿用 K2 的 `PROJECT_ID_MISMATCH` 核对。都不匹配返回 `false`，由分派层回 404 |
| `isBusy()` | Mio 正在跑的轮次、执行中的编辑任务、`hold()` 住的文件发布、`worker` 正在调的供应商请求。忙时既不空闲关闭，也不让独占操作进来 |
| `interrupt()` | 关闭的第一步：关掉 SSE（Mio 的 `taskHttpV2.close()`、运行时的 `close()`），中止 Mio 正在跑的轮次 |
| `drain()` | 停 `worker`，等 `services.drain()`、`editTasks.drain()`、Mio 的 `drain()`、文件流和版本对比媒体关闭 |
| `dispose()` | `taskToolsV2.dispose()` 这类同步的收尾 |

现在的 `composeServer` 关闭时正是这个顺序：`shutdown.abort()`，关 SSE，`Promise.all` 等 `worker.stop()`、`taskRuntimeV2.drain()`、`serviceDrain()`、`editTasks.drain()`、`files.close()`、`versionComparisonMedia.close()`，然后 `taskToolsV2.dispose()`、`store.close()`。

### 2.4 需要别的卡提供的端口（`ports.ts`、`stand-ins.ts`）

```ts
// B1：应用库
export interface ProjectRegistryPort {
  list(): readonly RecentProject[];
  get(projectId: string): RecentProject | null;
  upsert(entry: RecentProject): void;                  // 按 recentProjectSchema 校验
  remove(projectId: string): void;
  findMoved(entry: RecentProject): Promise<string | null>; // 只用 readdir、lstat
  checkCopy?(file: {readonly projectId: string; readonly projectFile: string}): void; // 内核的 checkCopy
}
export type ProjectFileIdentityPort = (projectFile: string) => ProjectFileIdentity | null; // 只 lstat
export interface AgentPolicyStorePort {
  read(): AgentTaskPolicy | null;
  readRequest(requestId: string): {readonly digest: string; readonly policy: AgentTaskPolicy} | null;
  write(policy: AgentTaskPolicy, request?: {readonly requestId: string; readonly digest: string}): void; // 一个事务
}
export interface AppLibraryPort {
  readonly registry: ProjectRegistryPort;
  readonly agentPolicy: AgentPolicyStorePort;
  readonly projectFileIdentity: ProjectFileIdentityPort;
  readonly databaseFile: string;  // 应用库文件；Mio 授权等改按它的文件身份算范围
  close(): void;
}
// S3：后台任务
export interface BackgroundTaskIndexPort {list(): readonly BackgroundTaskIndexEntry[]; replace(projectId: string, entries: readonly BackgroundTaskIndexEntry[]): void}
export interface ProjectInboxPort {add(item: ProjectInboxItem): void; list(projectId: string): readonly ProjectInboxItem[]; remove(projectId: string, itemId: string): void}
// V1、V2、S3：生命周期钩子
export interface ProjectLifecycleHooks {
  afterOpen?(host: ProjectHostContext): void | Promise<void>;   // 运行时组装好、第一个租约之前；抛错则打开失败
  beforeClose?(host: ProjectHostContext): void | Promise<void>; // 请求和运行时排空以后、store 关闭以前；出错记下，关闭照常
}
// R1：Mio
export interface MioAppServices {readonly policy: AgentPolicyStorePort; readonly selfPort: () => number}
export interface MioRuntimePort {handle(request: ProjectRequest): Promise<boolean>; isBusy(): boolean; interrupt(): void; drain(): Promise<void>; dispose(): void}
export type MioRuntimeFactory = (context: ProjectHostContext, app: MioAppServices) => MioRuntimePort;
// S8：草稿
export interface ProjectDraftsPort {handle(request: ProjectRequest): Promise<boolean>; drain(): Promise<void>}
export type ProjectDraftsFactory = (context: ProjectHostContext) => ProjectDraftsPort;
// S0a：内核的恢复函数
export type ProjectFileRecovery =
  | {readonly state: 'clean' | 'recovered' | 'locked' | 'open-here' | 'missing'}
  | {readonly state: 'invalid'; readonly reason: string};
export interface KernelMaintenancePort {recoverProjectFile(projectFile: string): ProjectFileRecovery}
```

替身（`stand-ins.ts`）：

```ts
export function statProjectFileIdentity(projectFile: string): ProjectFileIdentity | null;
export function sameProjectFileIdentity(a: ProjectFileIdentity | null | undefined, b: ProjectFileIdentity | null | undefined): boolean;
export const DEFAULT_FIND_MOVED_LIMIT = 2_000;
export interface MemoryProjectRegistryOptions {readonly entries?: readonly RecentProject[]; readonly identity?: ProjectFileIdentityPort; readonly searchLimit?: number}
export function createMemoryProjectRegistry(options?: MemoryProjectRegistryOptions): ProjectRegistryPort;
export function createMemoryBackgroundTaskIndex(entries?: readonly BackgroundTaskIndexEntry[]): BackgroundTaskIndexPort;
export function createMemoryProjectInbox(items?: readonly ProjectInboxItem[]): ProjectInboxPort;
export function createMemoryAgentPolicyStore(initial?: AgentTaskPolicy | null): AgentPolicyStorePort;
export const STAT_ONLY_MAINTENANCE: KernelMaintenancePort;
```

端口都是同步的，只有 `findMoved` 是 async（可能要扫目录）。B1 的应用库用 `node:sqlite`，本来就是同步。端口和替身都用闭包实现、不用 `this`，调用方可以展开再包一层。

| 端口 | 卡 | 宿主什么时候调 | 卡合入之前 S0 用的替身 |
|---|---|---|---|
| `ProjectRegistryPort` | B1 | 新建、打开时写登记；关闭时按文件身份改路径、写名字和摘要；`list()`；打不开或恢复报 `missing` 时 `findMoved` | `createMemoryProjectRegistry`：内存里按插入顺序存，写入时按 `recentProjectSchema` 校验。`findMoved` 在原项目文件夹和它的上一级里各往下找两层，按文件身份比对 `.mioon`；跳过以 `.` 开头的条目和 `*.mioon-journal`；最多看 2000 个条目；只 `readdir`、`lstat` |
| `ProjectFileIdentityPort` | B1 | 新建、打开、关闭时，`openPath` 认已开着的同一个文件，`checkMoved` | `statProjectFileIdentity`：`lstat(…, {bigint: true})` 的 dev、ino，不是普通文件时返回 `null`。只 stat，不打开文件；Windows 上的完整文件 ID 由 B1 验证 |
| `AgentPolicyStorePort` | B1；Mio 怎样读由调用方传入，和己商定 | 不直接调；经 `MioAppServices` 交给 Mio | `createMemoryAgentPolicyStore` |
| `AppLibraryPort` | B1 | 切换时由 `startServer` 打开，交给管理器和 Mio；`databaseFile` 给各个范围文件 | 无；S0 切换要等 B1 合入 |
| `BackgroundTaskIndexPort` | S3 | `restore()` 读；每次关闭用 `unfinishedTasks()` 的结果替换这个项目的条目 | `createMemoryBackgroundTaskIndex`；启动时没有要恢复的项目 |
| `ProjectInboxPort` | S3 | 宿主不直接调；S3 的 `afterOpen` 钩子把结果写进项目再删掉，应用级的 S3 代码 `add` | `createMemoryProjectInbox` |
| `ProjectLifecycleHooks` | V1、V2，也给 S3 | `afterOpen`：组装好以后（V2 的打开备份、S3 的收件箱）；`beforeClose`：倒序，排空以后（V1 的关闭时存版本、V2 的关闭备份） | 不注册 |
| `MioRuntimeFactory`、`MioRuntimePort` | R1 | 工厂里每个宿主建一份；`handle`、`isBusy`、`interrupt`、`drain`、`dispose` 并进宿主的同名方法 | 现在的 `createAgentTaskRuntime` 加 `createAgentTaskHttp`。设置和发送授权也是应用级的，由工厂的闭包带进去 |
| `ProjectDraftsFactory`、`ProjectDraftsPort` | S8 | 工厂里每个宿主建一份 | 现在的三个 JSON 模块，每个宿主一份，根目录用 `localDir`，范围文件用 `history.db`（6.2 第 4 步） |
| `KernelMaintenancePort` | S0a | `list()`、`restore()`，见第 5 节 | `STAT_ONLY_MAINTENANCE`：只 `lstat`，文件不在报 `missing`，不是普通文件报 `invalid`，其余报 `clean`；不读文件，也不恢复 |

### 2.5 路由

清单第 2 节逐个列了 HTTP 路由的归属。按它，加上清点时找到的漏列的几处：

**项目级**（放在 `/api/projects/<id>/…` 下，用契约的 `parseProjectApiPath` 解析后交给宿主）：

| 新路径（`/api/projects/<id>/` 之后） | 现在的路径 | 说明 |
|---|---|---|
| `rpc` | `/api/rpc` 里的项目级操作 | 包括只按实体 ID 寻址的 11 个和 `image.review.prepare` |
| `media/<素材 ID>` | `/media/<素材 ID>` | 查询参数照旧 |
| `version-comparison/media` | `/api/version-comparison/media` | |
| `timeline-audio-preview/pcm`、`timeline-audio-preview/continuous` | `/api/timeline-audio-preview/…` | 原生预听的签名范围跟着改 |
| `export-files` | `/api/export-files` | |
| `images/reviews/approve`、`images/reviews/reject` | `/api/images/reviews/…` | 照旧报 `IMAGE_REVIEW_NOT_FOUND` |
| `local-drafts`、`local-drafts/clip`、`local-delivery…`、`local-shot-text…` | `/api/local-…` | S8 改成本机记录的表 |
| `agent/tasks/v2/…`、`editing` | `/api/agent/tasks/v2/<项目 ID>/…` | 去掉路径里原来的项目 ID 段 |
| `tasks…` | `/api/tasks…`（`edit-tasks-http.ts`） | **清单漏列**；projectId 现在在查询参数或请求体里 |
| `package-preview` | 已在新前缀下（`project-package-http.ts`） | V4 删除 |

新路径保留原来 `/api/` 之后的部分，例如 `/api/tasks…` 改成 `/api/projects/<id>/tasks…`；`/api/tasks…` 也归 K2（第 7 节第 8 条）。

**应用级**（留在原处）：`/health`、`/api/login`、`/api/rpc`（只收应用级操作，项目级操作发到这里报 `VALIDATION_ERROR`）、`/api/agent/settings`、`/api/agent/diagnostics`、`/api/agent/tasks/v2/policy`、`/policy/requests/<id>`、`/diagnostics/latest`（这三条清单只列了项目的部分）、`/api/images/settings`、`custom-settings`、`comfy-settings`、`comfy-check`、`comfy-availability`、`/api/video-providers/*`、`/api/ui-preferences`、`/opened`、`/api/media-tools/check`、`/api/last-project`（B1、S6 换成最近项目）、`/api/workspace-info`（改成应用信息），以及**清单漏列的** `/api/workspace-preferences/<id>`。新增的最近项目和封面接口归 S6、B1（3.4）。删除、复制、改名、关闭、另存为是应用级操作，接口形状由 S4、S5、S6 定，内部都经 `withExclusive`。

**随删除去掉**：`/api/agent/chat/…`（P1a-2）、`/api/local-drafts/restored43…`（P1b）、`/api/workspace-backups/…`（S7）、`/api/project-packages/…`（V4、S5）、`package-preview`（V4）。

**错误码和 HTTP 状态**（`errors.ts`）：

```ts
export const PROJECT_ADDRESS_ERROR_STATUS: Readonly<Record<ProjectAddressErrorCode, number>>; // NOT_FOUND 404、ID_MISMATCH 400、UNAVAILABLE 409
export const PROJECT_HOST_ERROR_CODES: readonly ['PROJECT_HOST_BUSY', 'PROJECT_HOST_TRANSITION', 'PROJECT_HOST_STOPPED', 'PROJECT_LOCATION_INVALID', 'PROJECT_FILE_MOVED'];
export type ProjectHostErrorCode = typeof PROJECT_HOST_ERROR_CODES[number];
export const PROJECT_HOST_ERROR_STATUS: Readonly<Record<ProjectHostErrorCode, number>>;      // 409、409、503、400、409
export function projectNotFound(projectId: string): AppError;
export function projectIdMismatch(projectId: string): AppError;
export function projectUnavailable(projectId: string, reason: ProjectOpenErrorCode, cause?: unknown): AppError;
export function asProjectUnavailable(projectId: string, error: unknown): unknown;  // 内核的打开错误映射成 PROJECT_UNAVAILABLE，其余原样
export function projectHostError(code: ProjectHostErrorCode, details?: Readonly<Record<string, unknown>>): AppError;
export function projectFileExists(projectFile: string): AppError;                   // 应用级新建：内核的 details 加 projectFile
export const SQLITE_READONLY_DBMOVED = 1032;
export function isDatabaseMovedError(error: unknown): boolean;                      // 错误本身或内核错误的 cause 是 1032
```

| 错误码 | HTTP | `details` | 什么时候 |
|---|---|---|---|
| `PROJECT_NOT_FOUND` | 404 | `{projectId}` | 项目没有登记 |
| `PROJECT_ID_MISMATCH` | 400 | `{projectId}`（URL 里的 ID） | 输入里的 projectId 和 URL 的不一致，在 `rpc` 的处理里沿用 K2 的核对 |
| `PROJECT_UNAVAILABLE` | 409 | `{projectId, reason, invalidReason?}`，`reason` 是 `PROJECT_MISSING`、`PROJECT_LOCKED`、`PROJECT_FORMAT_NEWER`、`PROJECT_INVALID` 之一 | 登记了但打不开；内核的原错误放在 `cause`，带着它的 `details.reason`（例如 `read-only`）。`reason` 是 `PROJECT_INVALID` 时，切换后把这个原因也放进 `invalidReason` |
| `PROJECT_HOST_BUSY` | 409 | `{projectId}` | 独占操作等不到在途请求结束，或运行时忙；什么都没取消 |
| `PROJECT_HOST_TRANSITION` | 409 | `{projectId}` | 只给测试接口：项目正在打开、关闭或独占 |
| `PROJECT_HOST_STOPPED` | 503 | `{}` | 后端正在退出 |
| `PROJECT_LOCATION_INVALID` | 400 | `{projectFile}` | 指定的 `.mioon` 所在的文件夹不存在 |
| `PROJECT_FILE_MOVED` | 409 | `{projectId}` | 打开期间 `.mioon` 被单独改名或移动，写入被拒绝；宿主正在按新位置重开，重试即可（4.6） |

响应体照现在的 `{ok: false, error: {code, message, details, retryable: false}}`。`/api/projects/` 下解析不出来的路径、宿主不认的路径都报 404 `NOT_FOUND`。

K0 的小 PR #108 把两项收进了契约（第 7 节第 6、9 条），切换时宿主跟着改：
- `PROJECT_FILE_MOVED` 成了契约的错误码（`PROJECT_FILE_ERROR_CODES`），宿主改从契约导入，不再自己定义；
- `PROJECT_UNAVAILABLE` 的 `details` 可以带 `invalidReason`（`PROJECT_INVALID_REASONS` 之一），只在 `reason` 是 `PROJECT_INVALID` 时出现。`asProjectUnavailable` 把内核的 `details.reason` 抄进去，CLI、MCP 按项目 ID 访问时也能分清只读和损坏。

**分派顺序**（下一轮写进 `index.ts`）：Host 和 Origin → 令牌 → `parseProjectApiPath` → `acquire(id, 'request')`（自动打开）→ `res.once('close', lease.release)`（租约跟着响应结束，SSE 和文件流也算在途）→ `runtime.handle(request)` → 返回 `false` 时 404。处理中抛出的错误 `isDatabaseMovedError` 为真，或者是 `PROJECT_FILE_MOVED` 时，调 `lease.host.relocate()`，再照常回错误。

### 2.6 `startServer({dataDir})` 的新语义

- `dataDir` 是应用数据目录（任务卡第 3 节第 2 条），不传时按服务端的布局取默认值。新增可选的 `cacheDir`、`projectsDir`（桌面版由主进程算好传入），以及只给测试的 `projectInspection`（2.7）。
- 启动时依次：检查应用数据目录、取单实例锁 `server.lock`、打开应用库、建管理器、`await manager.restore()`、开始监听。除了有未完成任务的项目，启动时不打开任何项目。
- `ServerInstance.dataDir` 返回应用数据目录。`close()` 先 `manager.closeAll()`，再关应用级的资源。
- 只经接口建项目的测试（清单 7.6 里不用改的 66 个）照常可用：项目经应用级的 `project.create` 建在 `<dataDir>/projects/<项目名>/`。

### 2.7 测试辅助函数的接法（任务卡第 3 节第 13、14 条）

- **`createServerProject(dataDir)`**：
  1. `createProjectFiles({name}, {directories: serverAppDirectories(dataDir), registry: <B1 的登记表>, identity})` 建文件并登记；
  2. `openProjectStore({projectFile, locate: id => projectLocation(dirs, id)})`；
  3. 用 store 级的 `project.create` 初始化项目行（它用 `store.projectId`）；
  4. 返回 `{projectId, store}`。调用方先 `store.close()`，再 `startServer({dataDir})`；服务端只认登记过的项目。
- **`inspectProject`**：`startServer({dataDir, projectInspection: inspect => {…}})`。服务端组装好以后，把 `manager.inspectProject` 交给这个回调。注释写明只供测试，从不来自 HTTP 或环境变量，写法照 `taskFault`、`taskGatewayV2`。语义：
  - 同步执行；宿主开着就用宿主自己的连接；
  - 没开着就由内核单独打开这个项目、执行、关掉，所以自动关闭以后测试照样能查库，查完不留锁；
  - 项目正在打开、关闭或独占时报 `PROJECT_HOST_TRANSITION`，不等待；
  - 回调是 async 函数或返回 thenable 时报 `TypeError`，不能跨 `await` 持有连接。
  - W2 先在旧服务端上定这个选项的形状；W2 定了别的写法，S0 照 W2 改。

## 3. S0 要定的事

### 3.1 文件夹名和序号（`naming.ts`、`folders.ts`）

```ts
export const PROJECT_FOLDER_NAME_MAX_BYTES = 80;
export const PROJECT_FOLDER_FALLBACK_NAME = '未命名项目';
export const PROJECT_FOLDER_MAX_SEQUENCE = 999;
export function projectFolderName(projectName: string): string;
export function numberedProjectFolderName(folderName: string, sequence: number): string;
export interface ClaimedProjectFolder {readonly folder: string; readonly name: string; readonly projectFile: string}
export function claimProjectFolder(parentDir: string, folderName: string): ClaimedProjectFolder;
```

**决定**（10-31 定）：

1. 名字按 NFC 规范化；
2. 去掉首尾的空白和点；
3. 控制字符和 `<>:"/\|?*` 换成 `-`，再去一次首尾的空白和点；
4. 最长 80 个 UTF-8 字节，按码点截断，不拆开字符；截断后再去一次首尾的空白和点；
5. 第一个点之前的部分（去掉尾部空白）是 Windows 的设备名（`CON`、`PRN`、`AUX`、`NUL`、`COM1`–`COM9`、`COM¹²³`、`LPT1`–`LPT9`、`LPT¹²³`，不分大小写）时，前面加 `_`；
6. 结果为空时用 `未命名项目`；
7. `.mioon` 和文件夹同名；
8. 重名时依次试 `名字 2`、`名字 3` …… `名字 999`，名字截短到带上序号后仍不超过 80 字节；每次用一次不递归的 `mkdir` 占位，`EEXIST` 就试下一个，999 个都占了报 `PROJECT_FILE_EXISTS`。

例子：`A/B: "C"?` → `A-B- -C--`；`CON` → `_CON`；`nul .txt` → `_nul .txt`；`...` → `未命名项目`；`影` 重复 40 次 → 前 26 个字（78 字节）；第二个 `Film` → `Film 2/Film 2.mioon`。

**理由：**

- 80 字节以内，内核建文件时的临时名 `<名字>.mioon.creating-<UUID>-journal`（多 60 字节）也在 255 字节以内；Windows 默认 260 个字符的路径里放得下两次名字。
- 以点开头的条目会被生产代码的目录列表跳过，所以去掉开头的点；Windows 会丢掉结尾的点和空格。
- `mkdir` 占位是原子的，并发新建不会撞名。APFS、NTFS 不区分大小写和 Unicode 规范形式，这类重名由文件系统自己报 `EEXIST`。
- 项目目录不是私有存储，文件夹用默认权限。

### 3.2 缓存和临时目录

**决定**（10-31 定）：见 2.1 的表。网页版和无界面服务是 `<dataDir>/cache/`、`<dataDir>/tmp/`；桌面版的应用数据目录换成新的 `<userData>/data/`，缓存在系统缓存目录下的 `<应用 ID>/`，临时目录在 `<应用数据目录>/tmp/`；设了 `MIOON_DESKTOP_USER_DATA` 时缓存和新项目都放进 `<dataDir>`。每个项目的 `tempDir` 是 `<应用临时目录>/projects/<项目 ID>/`，任务卡已按这个写法改了。

**理由：**

- 内核要求三个本机目录是私有目录、路径里没有符号链接，系统临时目录在 macOS 上经过 `/var`，会被拒绝。
- 桌面版不沿用 `<userData>/workspace/`：本机记录的文件夹以后不能搬，换名字只有切换这一次机会；旧的 `workspace/` 里还留着开发数据，分开以后不会被误读或误删。切换时改 `config.ts` 的 `dataPaths`。Electron 的 `app.getPath` 没有 `cache` 这一项，所以缓存目录按平台算。
- 覆盖 userData 的是测试和冒烟运行，不该碰真实的影片和缓存目录。
- 每个项目一个暂存子目录：图片、抽帧、拆解的暂存带着崩溃恢复用的回执（`image-storage.ts`），要跨重启保留，也不能被别的项目的清理扫掉；和缓存的 `projects/<ID>/` 对称；`tmp/` 下还能放应用级的暂存，例如 S3 收件箱的媒体。

### 3.3 自动打开的项目什么时候关

**决定**（10-31 定）：宿主空闲时关闭。空闲指没有任何租约、没有在途请求、运行时不忙，而且宽限期已过。

- 宽限期是最后一个请求结束后 60 秒（`DEFAULT_IDLE_CLOSE_MS`），期间来的新请求重新计时。
- 释放窗口租约会取消宽限：之后只有在窗口释放以后才开始的请求，结束时才重新计宽限。
- 运行时忙时不关，每秒复查一次（`DEFAULT_BUSY_RECHECK_MS`）。
- 有 `task` 租约时不关。

**理由：** CLI、MCP、外部 agent 一条接一条地发请求，60 秒内不应反复打开；用户关窗口时要尽快放锁（Windows 上项目开着时文件夹移不动）；窗口自己最后的几个请求不该把关闭推迟 60 秒。

| 情形 | 结果 |
|---|---|
| CLI 连发请求，间隔都不到 60 秒 | 一直开着；最后一个请求结束 60 秒后关闭 |
| 关窗口，没有别的租约，运行时不忙 | 立即关闭 |
| 关窗口，还有生成任务没结束（S3 持有 `task` 租约） | 开着；任务结束、释放租约后立即关闭 |
| 关窗口时 Mio 正在跑一轮 | 开着，每秒复查；这一轮结束后关闭 |

测试用手动时钟逐条验证（`tests/project-host-manager.test.ts`）。

### 3.4 没打开的项目的封面（10-31 定；接口名由 S6、B1 定）

- 宿主在打开时、关闭前，以及打开期间封面素材变了时，把登记摘要里 `cover` 指向的素材缩成长边 512 像素的 JPEG（视频取第 0 秒的帧），存成这个项目缓存目录里的 `cover.jpg`；旁边的 `cover.json` 记素材 ID 和素材指纹。用现有的媒体运行时生成，先写临时文件再改名。
- 应用级的封面接口只读这两个文件，不打开项目。建议叫 `GET /api/recent-projects/<id>/cover`，名字随 S6、B1 的最近项目接口定。`cover.json` 和登记摘要对不上，或者文件不在时报 404，界面显示占位图。
- 关闭前来不及生成就保留旧图，不拖慢关闭。缓存可以被系统清掉，下次打开项目时重建。封面永远不写进项目目录，打包也不带。
- 契约的 `projectSummaryCoverSchema` 现在要求 `url === /media/<素材 ID>`，S6、K2 要改成封面接口的地址。

## 4. 生命周期和并发

### 4.1 同一个项目的请求怎样排队

- 不设项目级的队列。同一个项目的请求各拿一个 `request` 租约，并发执行。现在的服务就是并发处理请求；SQLite 的事务是同步回调，在同一个连接上天然串行；冲突靠修订号和幂等回执处理。
- 只有三个阶段请求要等：
  - **打开中**：第一个请求同步建条目（`opening`），同步完成内核打开，再异步组装运行时。组装期间别的请求等同一个 promise，失败时拿到同一个错误，不改写。内核打开失败是同步的，不留条目，下一个请求会重试。并发打开同一个项目只打开一次（有测试）。
  - **关闭中**：新请求等关闭完成，再按登记重新打开；登记没了就报 `PROJECT_NOT_FOUND`。契约里 `PROJECT_UNAVAILABLE` 的 `reason` 只能是四个打开错误码，“正在关闭”不是打不开，所以不报错。
  - **独占中**：等独占操作结束，见 4.2。

### 4.2 应用级操作怎样取得独占

删除、复制、改名、关闭、另存为都经 `withExclusive(projectId, run)`：

1. 同一个项目的独占操作排队，前一个结束才轮到下一个；
2. 先挡住新请求，它们等独占结束；
3. 等在途请求结束，最多 3 秒，而且运行时不忙。做不到就报 `PROJECT_HOST_BUSY`、恢复服务，不取消别人的请求，沿用现在删除闸门“只拒绝、不取消”的规则；
4. 关闭宿主，窗口和任务的租约被撤销；
5. 运行 `run`。这时本进程没开着这个项目，可以用 `fs` 移动、拷贝它的文件，不会碰到 POSIX 锁的问题。

`run` 里不能再 `acquire` 同一个项目，否则会等自己。项目开着的另一个窗口在第 4 步收到撤销（租约的 `signal` 中止），界面按 S6 的设计提示。

### 4.3 关闭时的顺序

`close`、`closeAll`、空闲关闭、独占、`relocate` 都走同一个流程：

1. 停止接收：状态改为 `closing`，发 `closing` 事件；新请求开始等待；
2. 中止宿主的信号；
3. `runtime.interrupt()`：关 SSE、中止 Mio 正在跑的轮次。SSE 不会自己结束，所以先关；
4. 等在途请求结束，最多 3 秒，超时就撤销它们的租约（租约的 `signal` 中止）。空闲关闭时本来就没有在途请求；
5. 撤销其余的租约（窗口、任务）；
6. `runtime.drain()`：停 `worker`，排空服务、编辑任务、Mio；
7. 各钩子的 `beforeClose`，倒序；
8. `summarize()`、`unfinishedTasks()`，它们要读库，所以在关库之前；
9. `runtime.dispose()`；
10. `store.close()`；
11. 按文件身份更新登记：用的是关闭时的真实位置，所以在关库之后；
12. 写后台任务索引；
13. 删条目，发 `closed` 事件（带收集到的错误）。

每一步出错都记下来，关闭照样走完，宿主不会停在半开的状态。测试按日志核对了这个顺序。

### 4.4 关闭窗口后还有未完成的任务（S3）

S3 在项目有未完成任务时持有 `task` 租约，宿主就不关。任务结束、释放租约时，因为窗口释放已经取消了宽限，宿主马上关闭。关闭时 `unfinishedTasks()` 的结果写进任务索引。重启后 `restore()` 按索引重新打开这些项目，并拿 `task` 租约交给 S3，继续轮询和对账。

应用级的“关闭”操作（S6 的菜单）经 `withExclusive`，会撤销 `task` 租约：未完成的任务留在本机记录和索引里，下次打开或重启时继续。要不要在这时提示或拒绝，由 S3、S6 定。

### 4.5 应用退出

`closeAll()` 并行关闭全部宿主，等独占操作结束，然后关应用级的资源。之后的请求报 `PROJECT_HOST_STOPPED`。

### 4.6 打开期间被移动或改名

macOS、Linux 上能移；Windows 上文件被占用，移不动。

- **移动或改名项目文件夹**：S0a 让内核在打开时就把项目文件的日志开着，所以移动以后写入照常。关闭时按文件身份找到新位置，更新登记（4.3 第 11 步；有测试）。SQLite 关闭时按打开时的路径删日志，新位置会留下一个 0 字节的 `<文件名>.mioon-journal`，不是热日志，不影响下次打开。
- **只改名或单独移动 `.mioon` 文件，文件夹不动**（S0a 遗留问题第 1 条）：SQLite 的日志名跟着打开时的文件名，留在原名旁边。之后提交中途崩溃，从新名字打开时找不到这个日志，会得到半个事务。宿主要能发现这种情况，并停写、关掉、在新位置重开：
  - `checkMoved(projectId)` 检查两件事（两次 `lstat`）：打开时路径上的文件不见了或换了文件身份；原路径的 `-journal` 还在。后一条区分了移动文件夹（日志跟着走，写入安全，返回 `false`）和单独移动文件。
  - 发现以后 `relocate`：在连接上登记一个事务守卫（`registerProjectTransactionFence`），之后的 `store.tx` 一律报 `PROJECT_FILE_MOVED`；然后按 4.3 关闭（原因 `relocate`）。关闭时 SQLite 按原路径删掉那个日志，登记按文件身份改到新位置，下一个租约在新位置重开（有测试）。
  - 定为乙（第 7 节第 6 条）：内核在 `store.tx` 开头和 `put` 里做同样的两次 `lstat`，抛 `PROJECT_FILE_MOVED`；宿主收到它或 1032 都调 `relocate`。内核的检查合入以前，切换这一轮先把 `checkMoved` 登记成事务守卫顶上，合入后去掉。
- **写入遇到 errcode 1032（`SQLITE_READONLY_DBMOVED`）**：这是 S0a 预热万一失效时的退路，处理一样。分派层或运行时调 `host.relocate()` / `context.relocate()`，宿主按上面的流程关掉，下一个租约按文件身份在新位置重开。打开途中恰好被移动的，内核报 `PROJECT_INVALID`，`cause` 是 1032；`acquire` 按文件身份找一次再开。
- **打开期间项目目录里一直有 0 字节的 `<文件名>.mioon-journal`**：生产代码列项目目录时（L1 给 Mio 列目录、R3、V3 打包、宿主的 `findMoved`），除了以 `.` 开头的条目，也要跳过 `*.mioon-journal`，绝不能拷走或删除。

## 5. S0a 的内核函数怎样接进来

只写调用的时机，本分支不实现。名字以 PR #106 为准。

| 函数或改动 | 调用时机 | 谁调 | 结果的处理 |
|---|---|---|---|
| `recoverProjectFile(projectFile)`，返回 `ProjectFileRecovery` | 启动时（`restore()`）和列最近项目时（`list()`），对每个已登记、本进程没开着、也不在独占操作中的项目调一次。打开项目本身不用先调，打开的第 1 步就是同一件事 | 管理器，经 `KernelMaintenancePort`；S6 的首页走 `list()` | `clean`、`recovered`：可用，`recovered` 发 `recovered` 事件；`locked`：别的进程正在写，不处理，打开时会报 `PROJECT_LOCKED`（12-03b）；`open-here`：当作开着；`missing`：后台按文件身份找新位置，找到改登记、在新位置再调一次，找不到按 12-03 显示；`invalid`：按 `reason` 显示，`read-only` 用只读的文案（S6）。切换时内核改成先看 `-journal`，没有热日志就直接返回 `clean`，不读项目文件的头：首页每次列项目都调它，放在 iCloud 里、已被系统移出本机的项目文件一读文件头就会被整个下载回来 |
| 清掉没用的超级日志 | 内核每次成功打开时自己做 | 内核 | 宿主不接线 |
| `isSuperJournalInUse`、`superJournalsIn` | B1 算本机记录清单的 `hasSuperJournal` | B1 | 宿主不用 |
| `read-only` 原因，`PROJECT_INVALID_REASONS` | 打开失败时 `PROJECT_INVALID` 带 `reason`，只读位置报 `read-only` | 管理器、S6 | `acquire` 映射成 `PROJECT_UNAVAILABLE`（`reason: 'PROJECT_INVALID'`），细分原因在 `cause.details.reason`，#108 合入后也放进 `details.invalidReason`；`openPath` 原样抛内核错误，应用级的 `project.open` 填 `projectOpenFailureSchema`，其中 `PROJECT_INVALID` 现在必填 `reason`，直接取内核的 `details.reason`，`projectFile` 由调用方补，`projectId` 取 `details.projectId`，读不出时取登记或 `null` |
| `store.tx` 改用 `BEGIN` | 不用接线。只写本机记录的提交（例如 Mio 流式输出）不再碰项目文件、不再建超级日志 | — | — |
| 打开时把项目文件的日志开着 | 不用接线。打开期间移动项目文件夹，写入照常，关闭时按文件身份更新登记（已实现） | — | — |
| 退路：写入遇到 1032 | 写入出错时 | 分派层、运行时调 `relocate()` | 见 4.6 |
| 单独改名或移动 `.mioon` | 内核在 `store.tx` 开头和 `put` 里检查，抛 `PROJECT_FILE_MOVED`（第 7 节第 6 条，定为乙）；内核的检查合入以前，宿主的 `checkMoved` 登记成事务守卫顶上 | 内核；过渡期是宿主 | 收到 `PROJECT_FILE_MOVED` 或 1032 都调 `relocate()`，见 4.6 |

#106 合入以后，`ports.ts` 里镜像的 `ProjectFileRecovery` 改为从内核导入，`reason` 用 `ProjectInvalidReason`；默认的 `STAT_ONLY_MAINTENANCE` 换成内核的 `recoverProjectFile`。

## 6. 下一轮的计划（S0 切换）

### 6.1 要等哪些合入

#105（K0 补充）、S0a（#106）、#108（K0 小 PR：`PROJECT_FILE_MOVED`、`invalidReason`）、K2、B1、W1、W2（含 6 个测试辅助函数和旧服务端上的 `inspectProject`）、P1a-2、P1b。R1、S3、S8、V1 不用等，用 2.4 的替身。

### 6.2 步骤

1. **内核**：
   - 结构：Mock 供应商的 `mock_provider_tasks`、`mock_provider_submissions` 和它们的索引收进本机记录的任务领域（`schema/domains/tasks.ts`），提升本机记录的格式版本，用 `node tests/helpers/project-file-schema-derivation.ts --write` 重新生成清单，`tests/project-file-schema.test.ts` 记新的摘要（定下的两处之一）。推导测试改为直接调用旧的建库链，不再经 `db.ts` 的 `openStore`。
   - 单独改名或移动 `.mioon`：`store.tx` 开头和 `put` 里各做两次 `lstat`，抛 `PROJECT_FILE_MOVED`（第 7 节第 6 条）。这一项合入以前，由第 6 步的宿主守卫顶上。
   - `recoverProjectFile` 先看 `-journal`，没有热日志就直接返回 `clean`，不读项目文件的头（第 5 节）。
2. **`db.ts`**：`openStore(root)` 改由内核按测试布局打开；`registerWorkspaceTransactionFence`、`registerWorkspaceTransactionObserver` 转发到内核的 `registerProjectTransactionFence`、`registerProjectTransactionObserver`；`getWorkspaceRestoreContext`、`ownsStoreLock` 认内核的 store；`validateWorkspaceStorage` 改成应用数据目录的检查。
3. **业务模块**：
   - 按工作区角色判断功能的地方：`readCurrentWorkspaceRole`、`isWorkspaceRoleSince`、`validateFixedWorkspaceRole`，约 20 个文件 35 处，其中 `validateFixedWorkspaceRole` 有 5 个调用方；内核的连接固定当作现行格式，不再按格式 72 校验。
   - 不带库名的 `sqlite_master`、`sqlite_schema` 探测（19 个文件 25 处，其中 7 个 Mio 文件和己约好谁删），改用 `pragma_table_list` 或删掉。
   - 不带库名的 `foreign_key_check` 3 处：`agent/task-schema-v2.ts`、`project-package/document.ts`、`project-lifecycle.ts`，改用 `foreignKeyCheck` 或带库名。
   - `project-lifecycle-schema.ts` 看到 temp 里有对象就拒绝的检查，要改。
   - `image_groups.activeTaskId` 找不到对应任务时当作空闲（`images.ts`）。
   - `services.ts` 的 `project.create` 改用 `store.projectId`。
   - 清单第 3 节的 29 个用到 `store.root` 的文件逐个改到四个目录：暂存 → `tempDir`，`agent-imports` → `localDir/imports`，媒体暂时留在 `projectDir/media`。
4. **范围文件**（清点时新发现，K1 的清单只列了授权）：
   - Mio 授权改按应用库文件的身份算（定下的两处之一，`agent/authorizations.ts`）；
   - `ui-preferences.ts`、`last-project.ts` 随 B1 收进应用库；
   - 三个草稿模块在 S8 之前改按 `history.db` 算；
   - 桌面的 `window-appearance.ts`、`main.ts` 的 LUT 恢复改按应用库文件算（庚）。
5. **Mio**：放行设置由调用方传入（和己、B1 定）；`task-runtime-v2.ts`、`task-storage-v2.ts` 等处的表探测（己）。
6. **服务端组装**：
   - 新文件 `apps/server/src/project-host/compose.ts`（`composeProjectHost`），从 `composeServer` 拆出每个项目的部分；
   - `index.ts` 只留应用级的部分，接上 `createProjectHostManager`；路由按 2.5 分派，删掉 K2 保留的旧路径；
   - `startServer` 加 `cacheDir`、`projectsDir`、`projectInspection`；`/health`、`/api/workspace-info` 改成应用级；
   - 不再调用 `setProjectDeletionCompanions`；
   - 原生预听绑定一个按 projectId 分派的服务；
   - 写入出错是 1032 或 `PROJECT_FILE_MOVED` 时调 `relocate()`；内核的检查合入以前，在 `composeProjectHost` 里把 `checkMoved` 登记成事务守卫（第 7 节第 6 条）；
   - `PROJECT_FILE_MOVED` 改从契约导入，`asProjectUnavailable` 把内核的 `details.reason` 抄进 `invalidReason`（#108）；
   - `startServer` 启动时，`dataDir` 里有旧的 `workbench.sqlite` 就报错，提示换一个目录或删掉旧文件（第 7 节第 3 条）。
7. **入口**：`cli.ts` 加 `MIOON_PROJECTS_DIR`；`backend.ts`、`supervisor.ts` 转发 `cacheDir`、`projectsDir`；`main.ts` 用 `desktopAppDirectories` 算出这两项传给后端（归庚，约好一小块；`desktop-window-ownership`、`desktop-startup-restart-race` 两个测试要为新符号加桩）；`config.ts` 的 `dataPaths` 把桌面版的应用数据目录改成新的 `<userData>/data`，旧的 `workspace/` 不迁移、不再读（第 7 节第 3 条）。
8. **测试辅助函数**：W2 的 6 个函数和 `inspectProject` 换成新内核的实现（2.7）；`tests/subtitles-recovery.test.ts` 在同一进程里开第二个 store 的写法（W2 没改的话）。
9. **验收**：类型检查；清单 7.6 里不用改的 66 个测试不改也能通过；`tests/project-host-*`；CI 全绿。

### 6.3 K1 交接的每一项落在哪一步

包括 PR #104 实验的 11 处补丁：

| K1 交接 / 实验补丁 | 下一轮的做法 | 步骤 |
|---|---|---|
| 推导测试依赖 `db.ts` 的 `openStore` | 直接调用旧的建库链，或随 S7 删 | 1 |
| Mock 的两张表（补丁 9 在内核里放过） | 收进本机记录的结构（定下的） | 1 |
| 事务守卫和观察者（补丁 1） | 转发到内核的 `registerProjectTransactionFence`、`registerProjectTransactionObserver` | 2 |
| `getWorkspaceRestoreContext`、`ownsStoreLock`（补丁 3、4） | 认内核的 store | 2 |
| 角色判断（补丁 5、7） | 内核的连接固定当作现行格式 | 3 |
| `sqlite_master` 探测（补丁 6 改写 `prepare`） | 不改写 `prepare`，逐处改用 `pragma_table_list` 或删掉 | 3、5 |
| 不带库名的 `foreign_key_check`（3 处） | 用 `foreignKeyCheck` 或带库名 | 3 |
| 每个写项目的连接都要建跨文件的临时触发器；`project-lifecycle-schema.ts` 的 temp 检查 | 只有内核开连接；改这条检查 | 3 |
| `project.create` 用 `store.projectId`（补丁 2） | 照补丁 | 3 |
| `image_groups.activeTaskId` | 找不到任务时当作空闲 | 3 |
| 授权范围（补丁 8 改成 `project.mioon`） | 改按应用库文件算（定下的） | 4 |
| 应用库替身（补丁 11 挂 `app`） | 用 B1 的应用库，放行设置由调用方传入 | 4、5 |
| `failStorage` 打诊断（补丁 10） | 不要 | — |
| 过程实体的目标修订在项目文件 | R1 定；S0 照现在 | — |
| `setProjectDeletionCompanions` 读不再建的表 | 不再调用，删除改由 S5 经 `withExclusive` | 6 |
| 打开失败的详情填 `projectOpenFailureSchema` | `project.open` 用 `openPath` 的错误加 `projectFile`；`PROJECT_INVALID` 带 `reason`（S0a） | 6 |
| `BEGIN IMMEDIATE` 留给 S0 定 | S0a 已改成 `BEGIN` | — |
| 测试布局多出 `.mioon-store/` 和 0 字节的日志 | 测试用 `isProjectStoreInternalEntry` | 8 |
| 同一进程第二次打开报 `PROJECT_LOCKED` | 测试先 `close()`，或放进子进程 | 8 |
| 打开期间移动、崩溃后没在本机恢复就被拷走 | S0a 的预热和 `recoverProjectFile`，接法见第 5 节；单独改名 `.mioon` 见 4.6 | 5 节 |

## 7. 协调人的决定（10-31）

下面是当初提的 10 件事，都已定下：第 3 条改了桌面版的应用数据目录，第 6 条定为乙，其余照提案。每条末尾的“定的”是结果。

1. **自动关闭的策略**（3.3）：空闲（没有租约、没有在途请求、运行时不忙）而且宽限期已过就关；宽限期是最后一个请求结束后 60 秒；关窗口取消宽限、空闲即关；有未完成的后台任务（`task` 租约）或 Mio 正在跑时不关。**定的：** 照提案。
2. **文件夹命名**（3.1）：NFC；控制字符和 `<>:"/\|?*` 换成 `-`；去掉首尾的空白和点；Windows 设备名前加 `_`；最长 80 个 UTF-8 字节；空名用 `未命名项目`；重名依次加 ` 2` 到 ` 999`；`.mioon` 和文件夹同名。**定的：** 照提案。
3. **目录的取法**（2.1、3.2）：网页版和无界面服务是 `<dataDir>/{projects,records,cache,tmp}`；桌面版的应用数据目录沿用 `dataPaths().dataDir`（`<userData>/workspace`，`records/`、`tmp/` 在它下面），缓存在系统缓存目录下的 `<应用 ID>/`，新项目默认放在 `<videos>/Mioon/`；覆盖 userData 时缓存和项目都放进 `<dataDir>`；每个项目的 `tempDir` 是 `<tmp>/projects/<ID>/`。如果要给桌面版的应用数据目录换一个不带“工作区”的名字，只能在 S0 切换时改一次 `dataPaths`，之后本机记录就不能再搬。**定的：** 桌面版的应用数据目录换成新的 `<userData>/data/`，不沿用 `<userData>/workspace/`，旧的 `workspace/` 不迁移、不再读，S0 切换时改 `dataPaths`；网页版和无界面服务的 `dataDir` 里有旧的 `workbench.sqlite` 时，启动报错。其余照提案。
4. **端口的形状**（2.4）：登记表同步，只有 `findMoved` 是 async；放行设置是存储端口，由调用方交给 Mio；Mio 授权按应用库文件的身份算范围；S3 用 `task` 租约，加上关闭时写索引；V1、V2 用 `afterOpen`、`beforeClose` 钩子；S8 和 R1 都是每个宿主一份的工厂；`list()` 带上 S0a 恢复的结果（`ProjectAvailability`）。**定的：** 照提案。
5. **封面提案**（3.4）：宿主把封面缩成长边 512 像素的 JPEG，存在项目的缓存目录（`cover.jpg` 加 `cover.json`）；应用级的封面接口只读这两个文件、不打开项目，没有就 404、显示占位图；接口名和 S6 一起定。**定的：** 照提案，接口名由 S6、B1 定。
6. **打开期间单独改名或移动 `.mioon` 的检测**（4.6，S0a 遗留问题第 1 条）。两种做法，发现以后的处理一样（停写、关掉、按文件身份找到新位置、重开，即宿主的 `relocate`）：
   - **甲，由宿主检测**：下一轮在 `composeProjectHost` 里把 `checkMoved` 登记成连接的事务守卫，每次 `store.tx` 开头做两次 `lstat`；也可以在分派每个请求之前调。内核不用改。只保护宿主开着的 store；事务之外的 `put` 不经过守卫。
   - **乙，由内核在 `store.tx` 开头检查**：同样两次 `lstat`（微秒级），发现就抛错（建议沿用 `PROJECT_FILE_MOVED` 这个码），`put` 也检查。宿主只处理这一个错误和 1032，都调 `relocate`。内核本来就记着打开时的路径和文件身份，所有经内核的 store 都受保护，包括测试和以后的工具。代价是改变内核的写入行为。
   - **建议乙**：风险来自 SQLite 按打开时的路径给日志命名，是内核这一层的性质，放在写入发生的地方检查，所有调用方都覆盖，宿主也只需要一条处理路径。乙合入之前，下一轮先按甲把 `checkMoved` 登记成守卫，乙合入后去掉。
   - **定的：** 乙。内核的检查合入以前，宿主先按甲顶上。错误码用 `PROJECT_FILE_MOVED`，由 K0 的小 PR #108 收进契约。
7. **按 `workbench.sqlite` 算范围的模块共 8 处**（第 1 节），不止 Mio 授权：应用级的（授权、界面偏好、上次项目、桌面窗口外观、桌面 LUT 恢复）建议都改按应用库文件算；三个草稿模块在 S8 之前改按 `history.db` 算。**定的：** 照提案。
8. **清单第 2 节漏列的路由的归属**（2.5）：`/api/tasks…`（编辑任务）为项目级；`/api/workspace-preferences/<id>`、`/api/agent/tasks/v2/policy`、`/policy/requests/<id>`、`/diagnostics/latest` 为应用级；`/api/agent/diagnostics?projectId=` 留在应用级，存储统计只在项目开着时给；`/api/projects/<id>/package-preview` 随 V4 删除。**定的：** 照提案。`/api/tasks…` 归 K2，新地址保留 `/api/` 之后的部分，即 `/api/projects/<id>/tasks…`。
9. **`PROJECT_UNAVAILABLE` 要不要带内核的细分原因**：S0a 以后只读位置报 `PROJECT_INVALID`、`reason: 'read-only'`，界面要换文案；但契约里 `PROJECT_UNAVAILABLE` 的 `details` 是严格的 `{projectId, reason}`，按项目 ID 访问（CLI、MCP、外部 agent）时只能看到 `PROJECT_INVALID`。建议 K0 给它加一个可选的 `invalidReason`（`PROJECT_INVALID_REASONS` 之一），只在 `reason` 是 `PROJECT_INVALID` 时出现。首页走 `list()`，已经带着 `reason`。**定的：** 加，由 K0 的小 PR #108 收进契约，S0 切换以前合入。
10. **桌面主进程要多传两项给后端**（`cacheDir`、`projectsDir`）：`main.ts` 归庚，需要约一小块改动。**定的：** 照提案。
