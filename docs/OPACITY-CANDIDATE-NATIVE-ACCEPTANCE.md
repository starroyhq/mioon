# 候选透明度：部分 Safari 与真实短媒体验收

**历史记录。** 透明度候选（固定 42/43 工作区、候选网页入口、候选备份档案和 40→42 升级命令）已在 #119（P1b，2026-11-02 合入）整条删除，本页写到的入口、命令和代码大多已不存在。下文保留 2026-10-16 当时的记录，不再更新。

日期：2026-10-16 UTC。运行基线：`ea6885d50e03026e6ec62c7709e690c369da9963`。

**真实预览／导出和 HTTP 持久化路径通过；完整 GUI 验收未完成。** 用户已明确批准仅本机4319、独立新临时目录与极短自生成素材；本次没有待批准操作。GUI 阻塞来自工具连接中断。

## 环境与范围

- Node `v26.9.0`；Safari `27.0.1`；Homebrew FFmpeg／ffprobe `9.0.2`（Apple clang21.0.0）。这不是 Node24 或产品固定 FFmpeg 资格验证。
- 启动前 HEAD 干净，4319无监听，`/private/tmp/mioon-opacity42-manual-20261016`不存在。通过实际候选 CLI 创建普通42，后续仅由同一 CLI 的 `--open-workspace`重开该目录。
- 唯一素材为自生成64×64 RGBA PNG，165字节；10帧、30fps、720×1280时间线。透明度关键帧为frame0=`0.25`、frame10=`1`。没有读取用户项目、配置provider、修改系统设置／凭据、安装依赖或push。
- 浏览器使用原生 Safari 的新标签；没有接管原有用户标签。界面实际显示无地区标签的繁中。

## 实际 GUI 结果

| 操作 | 结果 |
| --- | --- |
| 导航到 `http://127.0.0.1:4319`、访问令牌登录 | 通过，原生 Safari 实际操作 |
| 创建并打开 `Opacity42 GUI · 10 frames` 项目 | 通过，进入实际剪辑界面和空时间线 |
| 点击导入按钮 | 原生文件选择器已打开；未选择用户文件 |
| 定位专用PNG、导入及后续界面验收 | 未完成，CUA连接中断 |

浏览器inventory没有可用provider，`cua.createBrowserTab('chrome', ...)`返回`Browser is not available: chrome`，因此采用原生 Safari。文件选择器中定位专用PNG时，CUA返回`Transport closed`；之后只读`cua.getState()`同样失败。没有可用的后续GUI控制工具。未保存本地验收截图。

**仍未验：** GUI导入、透明度Save／Cancel、Inspector重开、显式草稿恢复、Undo／Redo、播放器播放、浏览器下载、四语言及CJK IME。下列HTTP结果不能代替这些界面操作。工具中断后，任务标签、文件选择器和初始空窗口是否关闭也无法确认。

实际GUI发现候选空态仍显示无效“返回画板”。App本已不给候选入口传`onCanvas`；本次只令共享Preview在回调为函数时显示按钮。普通入口保持原回调。真实React SSR与接线测试12/12通过；修复后的Safari画面未复验。

## 同一项目的 HTTP／真实媒体补充

补充脚本调用实际`runOpacityCandidateDevelopment`，使用真实监听、SQLite、共享HTTP handler、持久任务／ACK、worker、媒体响应器和本地交付入口。没有模拟codec、素材、任务或输出。项目ID：`bfd45da5-6a2c-46cc-8655-db84156fafce`。

1. 导入上述PNG，实际ffprobe确认64×64、hash一致；添加10帧片段并通过原任务／ACK保存透明度曲线，revision3。
2. v3草稿保存原始未完成输入`.`，正常关闭／重开后workspaceScope保持、instanceId更新、输入原文恢复；DELETE草稿后已保存曲线不变。这验证存储恢复和丢弃接口，未操作GUI Cancel。
3. 实际任务Undo移除曲线，Redo恢复原曲线，revision5。
4. preview和export预检均ready，分别实际渲染成功；export使用原localDelivery prepare／execute路径。
5. 受管HTTP读取并验证输出hash；导出download响应字节完全相同。实际ffprobe和RGB解码确认两份输出均为720×1280、10帧、0.333333秒、5519字节。

两份MP4的SHA256均为`4b8aecf4c7489f69db9e0492c1d90839a408da0d6096e83dfdc50bdb3e623e6d`。缩到1×1后首／末帧RGB分别为`[23,10,23]`与`[86,39,86]`，亮度增加断言通过；这不是完整画面质量或长片性能验证。[真实输出样本](evidence/opacity-native-acceptance/preview-export-sample.mp4)、[通过记录](evidence/opacity-native-acceptance/http-media-qualification.json)和[媒体进程记录](evidence/opacity-native-acceptance/media-events.jsonl)保留。

第一次HTTP脚本在同端口关闭／重开后遇到`fetch failed`，此前导入／保存已成功。将临时客户端连接改为`Connection: close`后第二次从同一已保存项目继续通过；没有修改产品网络实现。[第一次失败](evidence/opacity-native-acceptance/http-media-qualification-attempt1.json)保留，初步判断为脚本复用旧keep-alive连接，不算产品网络回归验收。

## 资源与退出

执行前检查了原媒体边界：buffered stdout4MiB／stderr1MiB、默认120秒、输入threads1／filter_complex_threads1及默认libx264 threads2，原生命周期只清理自己拥有的直接子进程。临时脚本另设单媒体观察15秒／总90秒退出边界，未触发。

两次HTTP脚本合计17个媒体子进程（6FFmpeg、11ffprobe），17个退出均观测到；单个最长1191ms。4次HTTP服务关闭均返回正常、activeMedia0、server.lock不存在；最终脚本exit0。[最终独立检查](evidence/opacity-native-acceptance/final-exit-check.json)确认4319无监听、health=`ECONNREFUSED`、锁不存在。

最初原生GUI使用的CLI exec会话随工具恢复丢失（`executor key changed during session recovery`），其原始退出码和正常关闭结果**不确定**。随后仅检查原server.lock的确切PID46098已不存在、4319拒绝连接；未发kill或自行删除锁。重开沿用产品stale-lock策略。不能把后续4次正常关闭追认成首次CLI正常退出。

## 本次源码验证与后续

本次仅改共享Preview的条件显示与两项针对性测试；12/12通过，canonical build（严格TS、source-language guard、默认Web及development Desktop staging）和独立候选Web构建通过，具体见[汇总](evidence/opacity-native-acceptance/qualification.json)。实际媒体运行发生在此按钮修复之前；修复未改媒体代码，修复后未重新声称GUI／媒体验收。没有全库测试或安装包验收结论。

本次验收结束时，下一项合理开发是[42冷备份→43离线恢复的固定候选产品入口](OPACITY-CANDIDATE-REOPEN.md#4243冷备份恢复的最小后续方案)，当时只有设计，仍须父任务判断恢复边界；本次没有扩大43执行权限或迁移40／41。GUI工具恢复后再补上述未验界面项；Node24／产品固定FFmpeg、长片资源、跨平台安装包和真实provider保留各自独立验收。

后续独立切片已完成[固定42冷备份→43离线入口](OPACITY-CANDIDATE-BACKUP-RESTORE.md)。本页GUI／退出不确定性和未验范围保留，没有操作旧PID／窗口或重试已停止的文件选择器问题。
