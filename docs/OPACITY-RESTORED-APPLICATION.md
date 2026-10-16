# 恢复43透明度候选应用入口

日期：2026-10-16 UTC。开发基线：`5df70103ffc636d9cbc2d32f516af8ebab3c1519`。

固定42冷备份恢复得到的43目录，现可通过独立、显式的候选应用入口打开已有项目，修改并保存片段透明度，撤销／重做，并以新请求发起预览／导出。复用同一个App、时间线事务、编辑任务协调器、共享server和媒体worker。普通40／恢复41默认入口、新建42和普通42重开入口保持原范围；没有自动迁移、目录覆盖或旧任务重新授权。

## 使用流程

在已安装依赖的源码仓库构建默认及独立候选前端：

```sh
node scripts/tooling.mjs build
(cd apps/web && node node_modules/vite/bin/vite.js build --mode opacity-candidate)
```

先保存并正常关闭自己创建的42测试工作区，再使用[固定离线备份／恢复CLI](OPACITY-CANDIDATE-BACKUP-RESTORE.md)：

```sh
node apps/cli/src/opacity-backup.ts create --source /absolute/closed42 --destination /absolute/new-backup42
node apps/cli/src/opacity-backup.ts verify --directory /absolute/new-backup42
node apps/cli/src/opacity-backup.ts restore --directory /absolute/new-backup42 --destination /absolute/new-restored43
node apps/server/src/opacity-candidate-cli.ts --open-restored-workspace /absolute/new-restored43 --port 4319
```

备份与恢复目标均须不存在；源须已冷关闭，不能改用用户已有目录或覆盖失败产物。候选server只监听`127.0.0.1`，令牌保存在该恢复目录自己的`access-token`，不迁移源令牌或凭据。浏览器访问`http://127.0.0.1:4319`后登录、打开已有项目，在剪辑属性中编辑透明度并明确Save或Cancel，再使用Undo／Redo或预览／交付入口。结束后让本次CLI正常关闭；重开仍使用同一个`--open-restored-workspace`参数。

`--new-workspace`、`--open-workspace`、`--open-restored-workspace`三者互斥：分别只创建不存在的普通42、重开已有普通42、重开完整受保护43。后者拒绝40／41／42、缺失或损坏数据库、未知catalog、坏恢复证据和不安全路径；不会猜测或改写版本。独立候选构建标记仅防止前后端入口误配，不授予数据库权限。

## 恢复身份、任务与媒体边界

43应用的私有注册与普通42应用注册分开。启动时先取得原独占lease，在只读连接完整验证固定43构造、held、历史证据及原始opacity；复核数据库dev／ino和锁后，RW连接再次验证，通过后才进入原WAL和运行时装配。复制对象、marker、URL或HTTP字段不能获得该注册。通用候选store也不会自动变成应用store。

每个新编辑／预览／导出携带恢复后的精确`expectedWorkspaceOrigin`。这个字段用于身份错配检查，访问令牌和owner lease仍独立校验。缺失或其他分支origin拒绝；已有请求和回执不能被补写新origin。新编辑任务必须为`origin:'new'`，`executionEpoch`为当前恢复origin，继续使用原request ID、digest、claim、ACK及结果不确定处理。

捕获时的pending任务仍为`executionEpoch:'captured'`且held，启动不派发；执行、对账和确认均拒绝。旧request ID仍被保留，不可当成新任务重用。历史任务与导出可见，项目快照明确列出`heldExportIds`。旧held导出不会因此变成可播放、下载或重跑的产物。

新预览／导出沿原接受回执和`workspace_restore_export_origins`绑定本分支，worker只选择当前origin的已接受记录。媒体读取仍验证原snapshot、request/hash、受管输出和来源身份，并在文件打开后再次核对。裸来源只接受规范受管导入路径及owned graph，不能把输出改标成导入素材绕过守卫。实际源文件probe／hash与解码在使用时检查；数据库重开成功不代表任意媒体可用。

| 开放范围 | 当前边界 |
| --- | --- |
| 读取已有项目、资产、时间线、历史及导出 | 不自动初始化缺失时间线；provider列表为空 |
| 保存已有片段属性与opacity、Undo／Redo | 仅既有`timeline.clip.update`、`timeline.undo`、`timeline.redo` |
| 新建预览／导出、只读preflight／capabilities | `timeline.render`及准备操作要求当前origin；导出沿恢复分支RPC路径 |
| 新项目、导入、track／clip增删、split、来源替换、seed、字幕与画幅 | 本入口未开放，包括`timeline.format.get/set` |
| Agent、provider／Image生成、波形／抽帧、额外音频测量 | 本入口未开放，不构造真实provider |
| 再次创建可恢复备份、持久偏好及companion | 继续拒绝；请保留原始42备份 |

## 未保存输入与视图

**v3未保存草稿不随备份迁移，源`local-drafts-v3.json`原文保留。当前43应用未保存的输入和视图只存在于本窗口内存。即使是正常关闭，dirty输入也可能丢失；刷新／重开后无法自动恢复。请在关闭前明确保存或取消。**

入口、Inspector和吸附提示用简中、无地区标签繁中、英文、日语说明上述范围。43 companion仍返回`RESTORED_WORKSPACE_UNSUPPORTED`，不读取、迁移或写回源草稿；`workspace.preferences.put`明确拒绝，选择、播放头、布局和吸附选择只在当前窗口有效。普通42继续原v3持久草稿及CAS偏好。

普通未完成文本的关闭与IME组合期间保护须分开看待：当前窗口仍沿原编辑和组合输入守卫，但不承诺对所有dirty输入阻止浏览器关闭，也不承诺崩溃或断电恢复。已明确保存并取得业务回执的时间线修改继续持久化；未确认请求保留原身份，不自动重投。

## 本片验证与未验收范围

只对本任务创建的临时42／43工作区操作。真实冷42→归档→独立43的准备产物见[seed记录](evidence/opacity-restored-application/seed.json)，包含165字节自生成64×64 PNG及10帧时间线，源已正常关闭。这里记录备份／恢复产物，不等同于GUI或解码验收。

最终定向聚合 **124/124通过**（18个去重文件，全部5个本片新测试与13个相邻旧测试），[命令和数量](evidence/opacity-restored-application/aggregate-summary.json)。测试使用实际SQLite、冷42→归档→43、共享HTTP handler、真实前端客户端和任务协调器，以及受管合成字节，不启动监听或codec。覆盖错误版本、坏证据、活动锁／符号链接、RO到RW之间同字节不同inode替换、复制／重复proof、旧pending的execute／reconcile／ACK拒绝、新origin保存／Undo／Redo／预览接受、断连预取消和晚媒体检查。原普通偏好及恢复41 origin／revision补验另有 **12/12通过**，与聚合分开记录；[首轮环境失败及最终结果](evidence/opacity-restored-application/preferences-regression-summary.json)均保留。

canonical `node scripts/tooling.mjs typecheck`、`node scripts/tooling.mjs build`和独立`vite build --mode opacity-candidate`均exit0。最初新browser直接导入旧contracts barrel引入JS类型闭包，已通过改用纯TS合同接缝修正；原失败日志保留，没有放宽类型或allowlist。冻结64项中63项原hash一致，唯一既有`timeline-media.mjs`例外不变；[独立审查](evidence/opacity-restored-application/independent-review.json)无阻断发现。

**本片真实Safari27.0.1与10帧短媒体验收通过，范围见[汇总](evidence/opacity-restored-application/qualification.json)。** 在本轮新标签页登录并打开43，实际GUI完成透明度Save（修订版3）、Cancel（不改变已保存值）、Undo（4）、Redo（5）、合成预览、编码／素材检查、明确确认导出、预览与成片播放。正常关闭服务后以同入口重开，GUI仍显示已保存的`.4→1`曲线和修订版5；origin相同、运行instance更新、导出保留、旧pending仍held。新标签页已关闭，两次本轮服务均通过自身close正常退出，端口与锁已释放，没有遗留本轮媒体进程。

[真实HTTP／媒体审计](evidence/opacity-restored-application/http-media-qualification.json)分别核对预览和导出4477字节、720×1280／30fps／10帧（0.333333秒）、GET／HEAD／Range与导出下载字节相同，裸输出及preview下载拒绝。首RGB`[37,17,37]`到末`[88,39,88]`，亮度比2.3626，与`.4→1`变化一致。审计4个codec子进程均在5秒内正常close；产品服务观察中每个媒体子进程15秒上限且没有触发。两次临时审计脚本把public DTO当成原DB行导致的失败记录保留，最终用原DB记录完成只读核对，未改产品或新建job。

真实GUI仅覆盖系统选择的无地区标签繁中；完整四语言GUI／IME、GUI默认下载目录、Node24、产品固定FFmpeg、长片资源、安装包和跨平台仍分别验收。其他三语言和繁中文案有组件断言；本片HTTP下载不冒充GUI下载。本机为Node26.9.0、已安装FFmpeg／ffprobe9.0.2。43未保存输入仍仅内存，普通dirty关闭可丢失；完整草稿持久化／递归备份是后续独立能力，不能从本片推出。

之前Safari工具断连、首次CLI退出码及旧窗口状态不确定，保留[原验收记录](OPACITY-CANDIDATE-NATIVE-ACCEPTANCE.md)。本片不盲目操作旧PID／窗口，不重试已停止的旧文件选择器问题。无用户项目访问、40／41迁移、依赖安装、凭据修改、付费服务或push。
