# 透明度四语言与组合输入专项

日期：2026-10-16 UTC。基线：`1e95a4492633dd2f4e1db16793f5b86dabdcabe3`。

本片修复两处已复现的交互错误，并完成四语言合成事件／实际会话回归。真实GUI只完成部分矩阵；工具断连后停止该路径。**不能将本片标为真实中文／日文IME或完整四语言GUI通过。**

## 修复与保留边界

原Inspector只在提交时检查composition pending。某些事件顺序为组合Enter／keyCode229、compositionend、表单implicit submit，此时pending已经解除，确认候选的Enter会误保存。现仅对候选透明度字段围住同一次Enter的提交，不阻止IME自己的确认或Escape默认行为；围栏逻辑独立为纯TypeScript helper。后续明确点击Save仍可保存，旧keyup不能解除新一轮组合的围栏；已结束的Process229／鼠标移焦／后续新按键会释放旧围栏，同一次确认Enter的重复按键仍被阻止。控件也保留compositionupdate中的原文，未完成组合不会被当成最终数字。

原42草稿Cancel等待在途PUT／DELETE时，没有覆盖整个取消过程的同步锁；此时Save仍可能提交，迟到清理结果又可能留下永久submitting／businessPending。现取消从入口到finally持有本次锁，Save和关闭排空尊重该状态，界面禁用竞争操作。迟到GET／PUT／DELETE及业务ACK继续核对owner、generation和serial，新草稿不被旧响应覆盖；已发生的业务结果与本地记录未确认仍分别保留。

数值准入不变：半角数值语法、最多32字符、1–7个严格递增且不重复的整数帧，以及0–1不透明度。组合中的中文／日文／全角文本可暂存；结束后不合法的内容仍拒绝，不自动转写数值。四语素材提示收窄为支持的导入素材可预览，捕获成片仅保留历史；不开放held或裸输出读取。日文补充半角数字及不重复的升序说明。

默认40／41、冻结构造器与唯一既有`timeline-media.mjs`例外不变；本片没有新schema、迁移或执行权限。本片结束时42继续v3持久草稿／显式恢复，43的源v3排除保留、当前输入和视图仅窗口内存，普通dirty关闭仍可能丢失。后续[43新草稿片](OPACITY-RESTORED-DRAFTS.md)（`4607947`）只在精确`localClipDrafts`能力下持久化本origin的新片段输入，durable ACK后可冷重开显式恢复／丢弃；源42 v3仍不迁移，无能力的旧43及恢复视图仍仅内存。新origin／held／epoch、回执及未知结果策略未放宽；这里的GUI结果不代替后续草稿能力验收。

## 非GUI验证

- **241/241定向回归通过**，其中15项新合成组合事件测试。使用实际Controls→Inspector→draft controller与内存CAS客户端，覆盖四locale×42／43、compositionupdate／blur／Escape／Enter229／compositionend、重复Save／Cancel和迟到响应。原runtime的3项失败复现保留；合成事件不等于OS输入法。[命令、红绿证据和范围](evidence/opacity-language-ime/synthetic-qualification.json)
- 另组**5/5通过**：两个实际共享handler会话测试循环42／43×四语言的8组会话，另三个文案／数字／恢复媒体边界测试。包含实际冷42→归档→43、真实前端client／任务／controller、v3重开／显式恢复、无效输入不提交、保存ACK与取消后重开，以及origin／held／历史／资产保全。[日志](evidence/opacity-language-ime/language-session-copy-tests.tap)
- canonical typecheck、默认Web／development Desktop源码构建及独立候选构建均exit0。没有修改类型检查、legacy allowlist或安装依赖；没有全库、安装包、Node24或跨平台通过结论。

Web语言保存在浏览器origin下的`mioon.app-language.v1`，桌面保存在独立应用偏好；它们不属于workspace备份，不随43恢复复制。语言菜单只有简中、无地区繁中、English、日本語及跟随系统。

## 实际GUI与IME缺口

本轮只使用[新建临时项目](evidence/opacity-language-ime/seed.json)，有效165字节PNG和10帧时间线，不访问用户项目。Safari27.0.1使用本轮新建独立窗口，前端为基线已编译版本；以下GUI结果不能冒充最终修复构建的GUI验收。

| 界面语言／profile | 本轮实际观察 |
| --- | --- |
| 简中／43 | Inspector、恢复／内存提示、无效`.`、普通Enter／Escape、焦点切换、重复Save／Cancel、刷新重选保留`.41`；仅新增一次修订到3 |
| 繁中／43 | 菜单无地区标签；同类操作及`1.2`错误提示，刷新保留`.42`；修订到4 |
| 英文／43 | 同类提示和操作，刷新保留`.43`；修订到5 |
| 日文／43 | 语言选择和设置标签已切换为日本語；读取下一状态时CUA断连，Inspector／错误／Save／Cancel未验 |
| 42／完整四语矩阵 | 本轮未做GUI；上面的实际handler会话回归覆盖42／43四语，不能替代GUI |

只读输入源记录显示现有中文／日文输入法条目，但配置条目不是组合输入证据。在不改变当前输入源的前提下，向透明度字段发送原生`n`、`i`按键，只观察到普通字符被拒、原值`.25`保留，没有候选窗口或composition pending。因此**真实中文及日文IME均未验证**。没有切换OS输入法、修改权限或系统设置。[GUI记录](evidence/opacity-language-ime/gui-acceptance.json)

断连发生在本轮测试窗口的日文设置读取，`cua_repl`返回`Transport closed`。未重复该路径，也未盲目操作窗口。应用语言最后观察为日文，原先跟随系统的浏览器应用偏好未能还原；这是应用偏好，OS设置未改。本轮窗口是否关闭无法确认。

随后原exec会话也失去连接，`close`写入未获得确认，**不能声称该服务正常退出或退出码0**。精确自有PID已不存在，4319无监听；残留锁先记录，再通过原固定43 owner-lease的stale-lock策略准入及正常store.close释放，没有手删锁、发进程信号或重启监听服务。最终目录、held任务、保存曲线和锁状态另见[工作区审计](evidence/opacity-language-ime/final-workspace-audit.json)。

本片证据统一见[汇总](evidence/opacity-language-ime/qualification.json)。剩余门包括最终修复构建的四语言GUI、真实中文／日文IME、原生窗口关闭重开、安装包和跨平台；GUI不可用时不把这些门改标通过。没有provider、长时媒体、依赖安装、凭据修改、用户项目操作或push。

后续另有[普通40→42显式离线副本升级](OPACITY-ORDINARY-UPGRADE.md)（`256cfd3`）；不改默认入口或41来历。[本轮发布前集成检查](OPACITY-RELEASE-CHECK.md)已单列最终结果，限定工具库存另发现CUA Node24.21.0 darwin-arm64；它与旧固定Linux SHA不同，不追认本片Node26执行为Node24验收，也不填补真实GUI／IME缺口。
