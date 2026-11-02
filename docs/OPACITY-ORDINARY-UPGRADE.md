# 普通40到普通42的显式离线升级

**历史记录。** 透明度候选（固定 42/43 工作区、候选网页入口、候选备份档案和 40→42 升级命令）已在 #119（P1b，2026-11-02 合入）整条删除，本页写到的入口、命令和代码大多已不存在。下文保留 2026-10-16 当时的记录，不再更新。

日期：2026-10-16 UTC。开发基线：`4607947c2ff7a3e8f44b20f2a157224c3641d78b`。

已提供独立源码CLI，将符合资格的普通40工作区复制成全新的普通42候选工作区。源40及已有校验备份保持不变；不原地升级、不自动选择版本、不改变默认生产40／恢复41入口，也不把恢复41转为普通42或恢复43。本片只对自行构造的临时40数据执行；用户工作区及未归属的`designs/`未读取或修改。

## 显式流程

先在原40中明确保存或取消输入、确认任务结果，正常关闭所有使用源目录的应用。使用现有独立备份入口创建并校验普通40冷备份，再选择全新42目标：

```sh
node apps/cli/src/backup.mjs create --source /absolute/closed40 --destination /absolute/verified40-backup
node apps/cli/src/backup.mjs verify --directory /absolute/verified40-backup
node apps/cli/src/opacity-upgrade.ts upgrade --source /absolute/closed40 --backup /absolute/verified40-backup --destination /absolute/new42 --channel web --lang zh-Hans
```

升级入口的`--backup`必须已经存在且完整，升级期间只读，不会创建或覆盖它。三个目录须使用规范绝对路径、两两独立且无嵌套；目标必须不存在，父目录安全且已经存在。源必须仍冷关闭，数据库及全部受管素材与所给备份精确匹配。任何既有源锁都拒绝，不删除或修复；不处理未checkpoint的WAL／journal。升级复制的是整个合资格工作区，包含所有项目，不做单项目裁剪。

`--channel`必填，可为`web`、`development`、`production`，只用于严格验证原伴随偏好的来源作用域；不能靠更改channel绕过现有scope。新42副本的`last-project`作用域固定绑定唯一候选启动器的`development`渠道，不把源渠道当成目标渠道。`--lang`支持简中`zh-Hans`、无地区标签繁中`zh-Hant`、英文`en`和日语`ja`，默认简中。`help`与`schema`不载入业务、不打开工作区。只有收到`publication:'confirmed'`成功结果后，才沿既有候选`--open-workspace /absolute/new42`入口重开；CLI不自动启动应用、worker或provider。

## 首批资格与保留策略

| 数据 | 本片处理 |
| --- | --- |
| 项目、时间线、历史／cursor、请求／回执、LUT原BLOB、数据库视图偏好与sequence | 整库复制；逐表、rowid、storage class及原始字节证明保留，唯一新增schema marker42 |
| 素材 | 仅支持规范受管`user-import`；逐文件流式复制并独立校验hash／长度。旧generated素材明确拒绝，保留源40 |
| 旧导出 | 只接收能通过候选时间线snapshot及原接受回执身份验证的终态记录；旧sequence导出明确拒绝，不静默隐藏或重跑 |
| 编辑任务 | 仅候选应用可读取的七项操作：track add／update、clip add／update／remove、undo／redo，且须`applied`／`not_applied`并已ACK；核验digest、原回执及结果，原行保留。其他旧操作（如clip split／replaceSource）即使已终态ACK也明确`SOURCE_UNSUPPORTED`拒绝。prepared／dispatching／unknown／未ACK拒绝，不改状态或补确认 |
| jobs／exports | 仅固定终态；不会恢复旧队列。image／frame／remote／review／Agent／mock复杂执行族只要有行，首片明确拒绝，而非删除历史或转换为held |
| 片段v1文件（含内容版本2）、delivery及shot-text | 活动草稿或任何保留intent拒绝；严格有效的空槽／墓碑文件按`excluded-empty-only`明确排除，源文件保留，旧scope／CAS不带到新副本 |
| 普通40中出现v3或恢复43草稿 | 明确不支持并拒绝，既不读入新草稿服务，也不猜测格式或重置文件 |
| `last-project-v1.json` | 严格校验UTF-8、重复键、格式、来源scope/channel及项目存在性，重绑定新目录／DB身份及候选`development`渠道的scope；projectId、revision、updatedAt保留 |
| token、provider设置、浏览器状态与应用语言 | 不读取或复制。这些不属于工作区数据库偏好；新应用仍沿原凭据／独立偏好流程 |

库存必须完整，无缺失、未知或不一致素材；备份的宽松“保留警告”不是升级资格。若任何项目、任务或伴随文件不符合上述范围，整个升级停止，源和备份保留供原40处理。没有为了升级而确认、取消、删除或重放旧任务；没有新的held、origin或epoch转换权限。

40与42物理catalog兼容，但只插标记不足以证明升级。新独立TS叶先严格分类普通40，在私有副本同一事务内重做资格、记录原始行证据、插42、运行完整42分类及保留比较后提交。历史40／41分类器、初始化器、恢复构造器及manifest均未修改；旧42初始化器仍拒绝直接打开40。

## 发布、失败与回退

复用现有format1清单／校验、受管路径与源锁、流式复制、目录fsync及离线恢复的同一no-clobber数据库发布函数。旧JS仅窄导出既有边界，新运行逻辑均为TypeScript。所有素材、偏好和来源记录完成并复核后，最后才将候选DB原子link到`workbench.sqlite`；没有可启动的半份42。

发布前的普通失败／取消只清理本次可证明拥有的文件与目录。外来文件或替换inode不会被删除；清理不能确认时明确返回`cleanupUnconfirmed`并保留目录。发布开始后的异常返回`WORKSPACE_UPGRADE_PUBLICATION_UNCONFIRMED`及精确backup／hash绑定，保留目标，不能当作失败后覆盖重做。`UPGRADE.json`只是`prepared-provenance`来源记录，不包含“已完成”声明；文件存在不证明此前fsync成功。业务成功确认来自最后link和目录同步后的CLI结果。

源锁及目标锁释放状态独立报告。回退是关闭42副本、重新明确选择保留的原40目录；不要删除42标记、覆盖原库或把新数据截回旧字段。生产默认启用、升级按钮、安装包流程与真实GUI验收仍未交付；首批资格之外的旧任务、生成素材和sequence导出兼容也仍缺。

## 验证

最终11个去重文件、**235/235通过**，无跳过或取消，含本片171项与六个相邻旧版本／备份回归文件。[范围](evidence/opacity-ordinary-upgrade/aggregate-selection.json) · [汇总](evidence/opacity-ordinary-upgrade/aggregate-summary.json)。实际CLI测试只启动离线Node进程；其余业务／故障测试禁止listener、fetch、provider和媒体进程。覆盖普通40→42重开及`project.get`、透明度Save／Undo、原ACK任务不恢复、raw历史／回执／LUT／偏好／REAL sequence和素材保留，以及40→受保护41的原路径、40／41／42错误输入拒绝。

49项故障与竞态验证覆盖损坏源、活动锁、非空目标、符号链接／嵌套路径、源文件和伴随文件变更／同字节inode替换、目标外来文件保护、取消、no-clobber和同步／发布未知结果。首轮发现最终未知文件检查与证明文件fsync残留，随后发现IO错误分类；修复后的49项全部通过，未放宽测试。[红绿阶段](evidence/opacity-ordinary-upgrade/faults-stages.json)。

canonical typecheck、默认Web／development Desktop源码构建及独立候选构建通过；独立Standards／Spec审查均0发现，另行62/62复跑与聚合重叠、不加总。冻结64项中63项原hash及唯一既有`timeline-media.mjs`例外保持，未新增例外或类型／JS allowlist豁免。只验证本机Node26.9.0，无Node24、安装包或跨平台结论。

另保留自建40→原备份→实际CLI→另一进程42重开的[过程脚本](evidence/opacity-ordinary-upgrade/qualification-process.mjs)及[证据汇总](evidence/opacity-ordinary-upgrade/qualification.json)。整个流程不解码合成素材，不访问用户项目、`designs/`、实际凭据或系统设置，不重试旧监听EPERM或失联GUI，不push。
