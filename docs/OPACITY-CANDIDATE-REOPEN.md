# 候选42已有目录重开

日期：2026-10-16。基线：`b6e2543cf117be0f32bdfabc462b5ca4abac6657`。

本初片提供两个互斥入口：`--new-workspace`只创建新目录，`--open-workspace`只打开已存在且完整验证的普通42目录。生产默认40/41不变；这两个入口没有迁移、自动profile选择或43应用授权。后续新增第三个互斥`--open-restored-workspace`，只沿[恢复43独立应用边界](OPACITY-RESTORED-APPLICATION.md)打开已有受保护43，不改变本页普通42重开的范围。

## 重开边界

`reopenOpacityCandidateApplicationStore`复用原有owned store实现。先要求private目录和受管数据库存在，再取得同一owner lease，在只读SQLite连接执行原`classifyWorkspaceSchema42`。完整catalog、markers、raw opacity／来源归属、历史与回执验证通过后，复核DB inode及锁，打开RW连接再验42，才继续原WAL／store装配并授予应用私有标记。通用`openOpacityCandidateStore`仍不授予应用标记。

40、41、43、未知catalog、损坏／空数据库、外部活动锁、符号链接和损坏来源归属均拒绝。沿用既有stale-lock策略，不修复profile或重写历史数据。拒绝前不打开RW连接；只读WAL连接可能产生SQLite sidecars，因此不承诺“绝无文件系统变化”，测试核对原DB字节及schema未修改。

干净关闭后重开，实际共享HTTP handler保留同一项目、时间线、透明度、历史、偏好及v3未完成草稿。草稿workspaceScope保持、instanceId更新，旧实例PUT被拒绝；原pending交付意图仅被读回，不因无监听测试而执行。撤销／重做继续使用原任务与回执。

初片重开测试不运行监听或GUI。后续用户已明确授权；实际补充验收使用同一CLI函数重开此前创建的专用目录，等价CLI为：

```sh
node apps/server/src/opacity-candidate-cli.ts --open-workspace /private/tmp/mioon-opacity42-manual-20261016 --port 4319
```

后续[Safari部分结果与真实短媒体验收](OPACITY-CANDIDATE-NATIVE-ACCEPTANCE.md)验证了同一项目的HTTP草稿重开、Undo／Redo及10帧实际预览／导出，最终正常关闭；GUI在文件选择器阶段连接中断，后续界面项未验。此前初片无监听记录保留其历史范围；新授权启动未绕过拒绝，也未启动provider。实际素材文件的probe／hash及渲染资格仍由原on-use准备流程验证，不能用元数据重开通过替代媒体可用性验收。

## 42→43冷备份恢复的最小后续方案

重开初片仅调查，没有执行备份／恢复或用户数据操作。后续已完成[固定42冷备份→43离线产品入口](OPACITY-CANDIDATE-BACKUP-RESTORE.md)，仅对自建临时工作区验证；下面保留当时设计。现有`workspace-restore-schema-v43.ts`具备固定43构造、校验、原始回执／历史字节、held、epoch及origin保护，产品流水线现已沿这些边界接入。

1. 新增固定候选42备份／43结果DTO和内部离线入口，不放宽冻结的默认版本枚举或旧dispatcher。
2. 复用现有`workspace-backup.mjs`的owner lock、冷库检查、受管路径、库存、逐文件hash及COMPLETE发布；在`workspace-backup-inventory.mjs`增加候选固定reader接缝，仅接受普通42，拒绝43递归备份。
3. 复用`workspace-restore.mjs`的离线复制及原子发布，只在候选入口调用`installWorkspaceRestoreSchemaV43`并复验43。源目录、原始行和回执不投影、不重算或改标记。
4. 给restore-status增加固定43校验和DTO，沿用全量备份或精确provenance观察，以及`not_reconfirmed`语义；未确认发布结果不盲目重试。
5. 仅临时库验证冷备份→verify→新43目录、原文／媒体hash、captured任务held、epoch、锁／sidecar／损坏／身份错配、中途故障和丢ACK。当时43应用执行入口尚未开放；后续[独立43应用片](OPACITY-RESTORED-APPLICATION.md)已接通原窄编辑／新render能力，未放宽旧任务与来源证据。

准确接缝：默认`workspace-backup-schema-versions.ts`和`workspace-schema-profiles.ts`已冻结且只接受旧范围；备份`refuseRestoredCapture`和离线恢复／status仍依赖旧profile检查。不能直接把42/43加入旧白名单。备份继续沿用原范围，v3未保存草稿、token、设置不随备份迁移。

初片验证记录见[本片证据](evidence/opacity-reopen/qualification.json)。完整GUI、四语言／IME、Node24与产品固定FFmpeg仍未完成；短媒体的已验证范围见上述后续报告，原[应用切片范围](OPACITY-CANDIDATE-APPLICATION.md)继续有效。
