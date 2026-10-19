# 全新42透明度应用入口

日期：2026-10-16。基线：`ec01753056c0f31706d29ed279ae1944c822ad94`。

本片将全新、独立42工作区接入同一个实际App。生产默认仍为40/41；没有迁移已有目录，没有新增普通payload、URL或环境profile开关。43冷备份／恢复产品链和40/41升级不在本初片；后续已补[固定42备份／43恢复](OPACITY-CANDIDATE-BACKUP-RESTORE.md)、[恢复43独立应用入口](OPACITY-RESTORED-APPLICATION.md)、[43新草稿持久化](OPACITY-RESTORED-DRAFTS.md)（`4607947`）及[普通40→42显式离线副本升级](OPACITY-ORDINARY-UPGRADE.md)（`256cfd3`），各自验收范围另记。整体[发布前集成检查](OPACITY-RELEASE-CHECK.md)已记录最终通过、失败和未验项，不改写本初片范围。

## 已接通的路径

内部TypeScript launcher仅接受不存在的绝对目录，独占创建42并授予不可复制的一次性启动证明。实际server、RPC、持久任务与ACK、项目读取、受管素材导入、时间线初始化、track／clip增删改、undo／redo、Inspector和v3草稿使用原组件。浏览器只在独立构建入口创建私有能力；普通main入口继续DesktopRoot和原客户端。没有复制App。

同一App可创建项目、导入素材、加入剪辑、选择片段、编辑透明度、Save，再请求合成预览，进入交付预检和导出历史。候选界面隐藏或禁用尚未接通的format、split、seed、来源替换、字幕、画布生成、Agent／Image和额外音频检查。画面保持现有720×1280／30fps片段架构，未扩大到位置、缩放或转场功能。

编辑任务保留原request ID、digest、结果不确定状态及迟到ACK守卫。透明度原始值、absent／null、同一片段add确认、历史和回执均经过候选校验。偏好仍使用原CAS，草稿写入独立`local-drafts-v3.json`；`local-drafts-v1.json`不迁移。

预览和下载复用原文件响应器及Range行为。只有精确新42守卫可播放preview／export产物，export允许有名／无名下载。读取绑定原始snapshot、queued回执、输出素材、发布路径和owned store，并在打开文件后、响应前复核。裸媒体仅接受规范受管导入路径和owned graph，反向export关系及输出路径不能靠改provenance绕过。旧默认守卫仍只允许原export／有名下载规则。

## 构建与最短使用步骤

构建命令不启动监听或媒体，可以单独执行：

```sh
node scripts/tooling.mjs build
cd apps/web
node node_modules/vite/bin/vite.js build --mode opacity-candidate
```

候选产物位于`apps/web/dist-opacity-candidate/`，页面为`opacity-candidate.html`；构建插件生成固定`mioon-opacity-candidate-entry.json`。默认产物仍为`apps/web/dist/index.html`。标记只用于防止内部启动器误配前端，不赋予后端工作区权限。

**后续已获用户明确授权并执行本机隔离验收；[Safari部分结果与真实短媒体验收](OPACITY-CANDIDATE-NATIVE-ACCEPTANCE.md)记录准确范围。** 本次首次启动命令（在仓库根目录）：

```sh
node apps/server/src/opacity-candidate-cli.ts --new-workspace /private/tmp/mioon-opacity42-manual-20261016 --port 4319
```

创建时该目录必须不存在，不允许改成用户已有工作区；该专用目录现已存在，不能重复使用`--new-workspace`覆盖。监听目标为`127.0.0.1:4319`。访问令牌由专用目录的`access-token`提供，不需要配置provider。Safari已实际登录、创建并打开项目，打开导入选择器后GUI连接中断；同一临时项目随后通过真实HTTP导入、保存、草稿持久化、Undo／Redo及10帧预览／导出与下载校验。完整界面操作仍待补验。

初片只创建新目录；后续已补[已有普通42目录安全重开](OPACITY-CANDIDATE-REOPEN.md)，使用互斥`--open-workspace`并复用完整profile／owner校验。通用生产启动器仍拒绝42；[42冷备份→43离线恢复](OPACITY-CANDIDATE-BACKUP-RESTORE.md)已独立实现，随后通过互斥`--open-restored-workspace`接通[恢复43应用](OPACITY-RESTORED-APPLICATION.md)。43保持原origin／held／epoch及窄编辑权限，不取得普通42创建／导入能力。[后续草稿片](OPACITY-RESTORED-DRAFTS.md)仅在精确`localClipDrafts`能力下持久化本origin的新片段草稿，durable ACK后可在冷重开时显式恢复／丢弃；源42 v3仍排除且保留。无此能力的旧43及恢复视图仍仅内存，未确认输入不能视为已安全保存。完整GUI及各片真实媒体范围分别记录。

## 验证范围与剩余验收

测试使用真实SQLite、实际共享HTTP handler（内存请求，无listen）、实际客户端／任务协调器、Inspector／播放器组件及合成受管文件。素材服务测试只替换codec transport，禁止真实媒体子进程；文件GET／HEAD／Range使用合成字节。关闭失败继续向上传播，不在停止结果不确定时强行释放SQLite／lease。

初片命令、通过数量、构建结果和独立审查见[验证证据](evidence/opacity-application/qualification.json)。该初片没有启动GUI、监听、媒体或provider；后续实际运行见[独立验收](OPACITY-CANDIDATE-NATIVE-ACCEPTANCE.md)。没有安装依赖、修改凭据、接触实际项目或push。

完整四语言GUI、真实IME、最终构建的新草稿恢复／关闭保护及播放／下载界面矩阵仍未验；本轮短媒体和HTTP结果不替代这些界面验收，后续部分语言GUI范围见[语言专项](OPACITY-LANGUAGE-IME-ACCEPTANCE.md)。GUI工具连接丢失后首次CLI退出码不确定，后续HTTP服务4次正常关闭，最终无监听／锁。本初片及短媒体验收当时仅确认Node26.9.0和本机FFmpeg9.0.2，没有Node24、产品固定FFmpeg或长片性能验收结论。[本轮集成检查](OPACITY-RELEASE-CHECK.md)另发现已安装CUA Node24.21.0 darwin-arm64；这不替代旧固定Linux二进制或产品运行时资格。后续监听基于用户新授权正常审批启动，未绕过拒绝。
