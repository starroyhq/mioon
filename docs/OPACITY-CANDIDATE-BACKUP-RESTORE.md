# 固定42冷备份与43离线恢复

日期：2026-10-16 UTC。基线：`9732bbe9291b99a0671908e8c5dab1a169bc11b5`。

已提供可实际使用的独立离线CLI，将正常关闭的普通42备份为原format1目录，再恢复到全新、独立的受保护43目录。复用原清单、库存、流式复制／hash、冷库／锁检查、COMPLETE发布、no-clobber数据库发布和状态观察，没有新造归档框架。默认旧备份／恢复版本范围、40／41启动和冻结构造器保持；没有自动迁移。

## 使用入口

在已安装依赖的源码仓库，使用Node24+：

```sh
node apps/cli/src/opacity-backup.ts create --source /absolute/closed42 --destination /absolute/new-backup42
node apps/cli/src/opacity-backup.ts verify --directory /absolute/backup42
node apps/cli/src/opacity-backup.ts restore --directory /absolute/backup42 --destination /absolute/new-restored43
node apps/cli/src/opacity-backup.ts restore-status --directory /absolute/original-backup42 --destination /absolute/restored43
```

所有路径须为显式规范绝对路径；create和restore目标必须不存在，不能复用空目录或覆盖非空目录。源须已正常关闭，没有现有锁或非空WAL／journal。本入口不接管stale锁、不修sidecar、不自动删除失败目录，不在原工作区内部创建恢复目标。

丢失发布输出时，status可用原备份重新确认目标绑定；也可使用精确模式：

```sh
node apps/cli/src/opacity-backup.ts restore-status --destination /absolute/restored43 --restoration-id UUID --backup-id UUID --manifest-hash SHA256 --source-db-hash SHA256
```

`--locale zh-Hans|zh-Hant|en|ja`分别提供简中、无地区标签繁中、英文和日语，默认简中。stdout恰好一个JSON信封；create／restore成功时stderr还会明确显示草稿排除提示。输出含`draftPolicy:"excluded"`，并保留原锁清理警告与发布不确定绑定。`--help`记录完整用法和退出码。

**v3未保存草稿不备份、不恢复，源草稿保留。** 根目录的`local-drafts-v3.json`不属于format1受管payload；不能把原workspaceScope／未完成输入带到新origin。恢复43的原草稿服务仍返回`RESTORED_WORKSPACE_UNSUPPORTED`。token、凭据、设置和连接文件继续排除。数据库内的原始用户文字仍完整保留，备份是私有明文。

## 固定版本与任务边界

新增TS合同复用原strict format1对象、Entry、Inventory及Complete限制，新增固定42和`draftPolicy`字段；保留唯一数据库、排序／去重和总字节限制。旧DTO不接受这个候选归档。共享MJS流水线的候选版本策略只由唯一模块对象的内部身份选择；复制profile、普通payload、marker或自定义函数不能选择或覆盖构造器／验证器。原额外检查回调不能替代固定42校验。

源库通过完整`classifyWorkspaceSchema42`，恢复只调用原`installWorkspaceRestoreSchemaV43`并独立重验43。不会把41改marker冒充43。数据库原始表值／rowid、时间线opacity、任务input、回执、历史及游标逐字保留；新guard表、held和`executionEpoch='captured'`由原43构造器安装，workspaceOrigin与恢复身份新建。

旧pending仍held，不能重新排队或执行。43仍只允许原有精确origin下的`timeline.clip.update`、`timeline.undo`、`timeline.redo`、`timeline.render`；读取与只读preflight／capabilities保持原范围。新origin不会获得项目创建、素材导入、track／clip add、provider或普通42应用能力。43递归备份继续拒绝，保留原始备份。

这个离线入口不启动后端、监听、worker、媒体或provider。本片完成时普通候选应用启动器仍拒绝43，交付范围仅离线保存／恢复／验证。后续已提供[恢复43独立应用入口](OPACITY-RESTORED-APPLICATION.md)：显式`--open-restored-workspace`完整验证已有43，沿原origin／held／epoch规则读取、编辑并发起新预览／导出。`--open-workspace`仍只认普通42；本页离线测试数量和无GUI／监听／媒体范围保留。

恢复43应用明确展示v3排除及源草稿保留；当前未保存输入和视图仅在本窗口内存，普通dirty关闭也可能丢失。该应用不开放普通42的创建／导入能力、持久companion或递归备份，其GUI／真实媒体验收另记，不能由本页离线通过推定。

## 失败与发布

沿用原路径、symlink／hardlink、inode、权限、文件树、逐文件复hash和独占目标检查。复制、DDL或独立校验失败时，可能保留不可启动的临时目录，但不发布`workbench.sqlite`。最终发布使用原no-clobber hardlink；发布后故障不回滚或删除目标。

发布确认／fsync丢失返回`WORKSPACE_RESTORE_PUBLICATION_UNCONFIRMED`及经过清洗的精确绑定。status只返回`observed_guarded`和`durability:"not_reconfirmed"`，不追认持久化、不修双链接／锁／sidecar、不恢复任务。双链接目标仍拒绝观察且原样保留。

真实冷关闭42验证发现原`withDisposableDatabase`清理缺陷：SQLite关闭其私有只读WAL检查副本时，SHM保持原inode但改变ctime，旧快照的完整身份比较误拒绝清理。已修为关闭后仅重查连接存活时捕获的固定sidecar路径，确认同dev／ino后交原严格删除函数；替换inode和未知新文件仍保留并拒绝，绝不递归清理。源和已发布备份不会被SQLite打开或创建sidecar。[旧逻辑失败](evidence/opacity-backup43/wal-cleanup-before.txt)及[真实WAL因果记录](evidence/opacity-backup43/wal-cleanup-causality.txt)保留。

## 验收范围

具体命令、数量、版本、源hash及独立审查见[汇总](evidence/opacity-backup43/qualification.json)。最终定向组160/160通过，旧备份／恢复回归组70/70通过，两组有重叠，不相加。针对性测试覆盖实际冷42→归档→独立43、全部原表值／rowid、raw opacity／history／task／receipt、资产字节、v3原文保留与明确排除、旧pending拒绝执行、新origin实际保存／Undo／Redo、旧40→41分离、损坏包、路径穿越／链接、未关闭源、非空目标、预发布故障和发布不确定状态。

另在全新专用`/private/tmp/mioon-opacity-backup43-qualification-20261016`实际创建42、服务drain并关闭，然后分别运行create、verify、restore和两种status，五次CLI均exit0；源DB与归档DB字节相同，恢复43保留原始证据和27字节合成资产，源v3草稿原文保留、归档／目标没有草稿，锁均释放。[独立检查](evidence/opacity-backup43/standalone-verification.json)和[CLI输出](evidence/opacity-backup43/cli-commands.json)留存。合成资产只用于字节保全，不是有效视频或本轮解码／渲染验收。

此前旧两套回归在基线源码和初始候选上都有相同20项失败；SHM修复消除实际清理障碍后，仅剩一条旧夹具仍期待schema36，而冻结默认已为40。仅修正该断言为40，最终同组70/70通过；没有修改旧构造器或放宽源校验。[失败对照](evidence/opacity-backup43/baseline-regression.txt)与[最终结果](evidence/opacity-backup43/old-regression-final.txt)保留。

本轮使用Node26.9.0，无GUI、监听、媒体／provider执行、用户项目访问或push。严格TS／source-language guard与canonical默认Web／development Desktop构建另有记录；没有全库、Node24、安装包或跨平台验收结论。之前Safari连接中断、首次CLI退出不确定及窗口状态仍按[原记录](OPACITY-CANDIDATE-NATIVE-ACCEPTANCE.md)保留，没有操作旧PID／窗口或重试已停止的文件选择器问题。
