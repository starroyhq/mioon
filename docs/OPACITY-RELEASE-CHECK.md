# 透明度候选集成／发布前检查

日期：2026-10-16。检查范围为已知远端`ff85c9a8daaa35bff080d0979fe2faa3683cd3b5`之后至`256cfd3d6bff0fbd304958125884acbe7a126348`的16项连续本地提交，以及本轮最小回归修复。没有新远端查询或push；最终提交身份以`git log -1`为准。

后续精确基线复现见[BLOB准入归因](BLOB-ADMISSION-BASELINES.md)：四快照原生6项均真实失败，已确认早于本批；本页d52当时的未证实记录保留为当时状态。原6项和冻结准入未改，新增独立格式控制不代表恢复历史兼容。

结论：本轮源码检查保留失败项，候选入口仍须显式使用。默认40／41不启用透明度，产品发布验收未完成。没有实际用户项目迁移、真实provider／媒体运行、软件安装、系统设置或凭据修改；`designs/`未读取、修改或纳入提交。

## 当前可用流程

| 流程 | 可用范围与限制 |
| --- | --- |
| 默认40／restored41 | 原启动、构造与版本分派保持；不会自动成为42／43 |
| 普通42候选 | 独立构建及`--new-workspace`／`--open-workspace`；项目、受管导入、七项时间线操作、透明度Inspector、v3草稿、预检和预览／导出使用原共享装配 |
| 42冷备份→43 | 独立离线create／verify／restore／restore-status；原42 v3草稿排除保留；43仅由`--open-restored-workspace`显式打开，不递归备份43 |
| restored43 | 已有片段属性／透明度、Undo／Redo和当前origin的新渲染；captured历史可读，旧任务保持held，execute／reconcile／ACK拒绝。新建项目、导入、track／clip增删仍不开放 |
| 43新片段草稿 | 仅精确能力及当前origin下的独立协议，durable ACK后可冷重开并显式恢复；旧43缺省能力、未获ACK输入及视图仍有内存／丢失边界。源42 v3不会迁入 |
| 普通40→42新副本 | 需要正常关闭的合资格源、已有完整校验40备份和新目标；不原地升级。源`--channel`严格验证，新last-project scope绑定候选`development`。仅规范user-import、可验证终态导出、七项可读且已ACK终态编辑操作；其他任务族、generated素材、旧sequence导出、活动／未知草稿明确拒绝 |

详细边界见[42应用](OPACITY-CANDIDATE-APPLICATION.md)、[43恢复应用](OPACITY-RESTORED-APPLICATION.md)、[43草稿](OPACITY-RESTORED-DRAFTS.md)及[40副本升级](OPACITY-ORDINARY-UPGRADE.md)。所有入口保留原始source／LUT／hash／inode、request／receipt、origin／epoch与发布fence；新目标成功不意味着默认生产入口已开放。

## 本轮修复

1. **42→43任务历史读取。** 合法`clip.add`携带opacity时，恢复后的任务get／list原会报`EDIT_TASK_STORAGE_UNAVAILABLE`。现在只在原captured任务、hold行身份、原始input／digest及回执匹配时选择既有application语法读取；新43prepare和执行权限不变。真实合成备份／恢复覆盖applied、prepared、not_applied、历史ACK及篡改拒绝。
2. **升级后的记住项目。** web／production源的目标scope原与唯一development候选启动器不匹配。现在只固定目标渠道，原源渠道校验保持；实际共享HTTP handler在内存请求下验证GET／PUT last-project及task get／list。
3. **旧任务升级资格。** 已ACK的旧split／replaceSource原能升级却使42任务读取失败。现在复用候选application任务语法收紧资格，明确`SOURCE_UNSUPPORTED`并保留源／备份，不删除或重写历史。四语言帮助及错误原因同步。
4. **断线IME祖先事件。** App保留输入白名单漏了opacity区域，Enter／Escape先被父层取消。现在与音量区域同样保留系统默认事件；Inspector仍阻止工作台快捷键，断线不保存业务或草稿。使用真实App guard与组件／controller的合成回归；不视为真实OS输入法验收。

backup四语言帮助也已修正为恢复后可通过独立43入口显式打开；当前索引补齐43持久草稿和40副本升级，不改写旧GUI记录。原`opacity-ordinary-upgrade/qualification-process.mjs`的目标web断言属于`256cfd3`旧证据，本轮以新增实际应用装配回归验证development目标，不重跑或篡改旧记录。

## 本轮验证

最终121个去重文件共**3574项：3568通过、6失败、0跳过／取消**，真实exit1；这不是全库或发布通过。全部6项均为下述历史BLOB期望，未排除换绿。[最终完整TAP](evidence/opacity-release-check/aggregate-final.tap)／[命令及结果](evidence/opacity-release-check/aggregate-result.json)／[总资格记录](evidence/opacity-release-check/qualification.json)。独立代理或旧阶段重叠数量不相加。

- 严格类型／source-language guard：绝对Node运行`node scripts/tooling.mjs typecheck`，exit0；foundation与browser均通过，未放宽编译设置。
- 版本锁定40分派／冻结证据两文件：Node24.21.0下203/203通过；将包含于最终聚合，不另累加。
- 四语言backup CLI：8/8通过；将包含于最终聚合。
- Node24默认Web／候选Web构建均exit1，macOS Team ID限制见下；Node26.9.0辅助默认Web＋development Desktop及候选Web源码构建均exit0，类型／构建子命令沿绝对Node，没有记为正式Node24验收。[产物入口隔离核对](evidence/opacity-release-check/build-entry-audit.json)
- 冻结manifest的64项：63项原SHA不变，唯一旧批准的`timeline-media.mjs`例外仍为既有SHA；零新增例外。legacy JS allowlist、typed exclusions和contracts package未改。[核对记录](evidence/opacity-release-check/frozen-check.json)

完整首轮121文件为3572项：3122通过、450失败、0跳过／取消；[原始TAP](evidence/opacity-release-check/aggregate-initial.tap)与[结果](evidence/opacity-release-check/aggregate-initial-result.json)原样保留。其中444项通过修正邻近旧夹具的canonical路径、App闭包／渲染边界、编译consumer清单／隔离复制与默认／历史版本装配失配解决；另6项当前profile期望与BLOB准入冲突保持失败，是否属于受支持历史兼容或过时fixture尚待判断。修复没有更改生产保护。receipt旧394项明确限定固定26历史修复，并新增真实当前dispatcher的fresh40与非法raw历史零写入拒绝两项，不能宣称这些raw旧项目已支持迁入当前40。

执行选择、每文件SHA、命令及排除理由见[aggregate-selection.json](evidence/opacity-release-check/aggregate-selection.json)。新IME回归的原始TAP未保留，真实红绿执行摘要明确记录此限制；升级回归的红／绿日志在同目录。最终聚合保留完整TAP与机器结果。

关于6项BLOB失败，比较对象的完整基线为`ff85c9a8daaa35bff080d0979fe2faa3683cd3b5`，只做了相关源码／fixture字节对照，没有在该完整快照执行，故**尚未证实基线问题**。`a7fcf74199ed7ca54c5be408e6c67cd33b19b645`修的是`workspace-restore-schema.test.mjs`中普通40动态seed的TEXT正例，并保留`WORKSPACE_VOLUME_ENVELOPE_INVALID`的BLOB拒绝负例；这6项则来自独立0343 golden的旧24／25及marker修复入口，错误是`RESTORE_SCHEMA_UNSUPPORTED`。两者属于相邻opaque回执测试族，不能当成同一fixture或已证明的真实用户数据回归，也不能直接把6项认定为过时fixture。[准确测试名、来源、支持性界限与未复现声明](evidence/opacity-release-check/blob-baseline-qualification.json)

## 工具链与发布门槛

已安装的`/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node`实际为`v24.21.0`，manifest为`24.21.0-cua.1`、darwin-arm64。本轮源码检查采用该绝对路径，子compiler／Vite／desktop继续使用`process.execPath`，未改PATH。这满足两组测试的精确版本断言，**不等于**历史固定Linux Node SHA或Electron产品运行时认证。

当前源码gate要求Node≥24，产品没有全局精确FFmpeg版本pin；桌面继续使用外置FFmpeg／ffprobe并检查版本前缀和编码器能力。限定目录仅发现Homebrew9.0.2，未找到历史Linux7.1.5／固定hash组合。本轮只读媒体工具版本，没有运行codec，不能把9.0.2或早先Node26探针当成旧固定组合验收。[工具链证据](evidence/opacity-release-check/toolchain.json)

| 未验收项 | 状态及原因 |
| --- | --- |
| 6项冻结历史兼容检查 | `workspace-schema-profiles.test.mjs`的seeded旧24／25（含mock）及两种marker修复源仍失败，`RESTORE_SCHEMA_UNSUPPORTED`。原timeline_requests rowid88的response是BLOB `00FF0D0A`，冻结volume validator要求TEXT；validator／dispatch相对ff85未变，但没有在完整精确基线运行，尚未证实是基线问题或真实受支持数据回归。不能与此前`a7fcf741`的current reopen夹具修复仅凭错误相似合并归因。原golden与全部保留断言未改。调整准入需先交父任务判断，未尝试扩大历史恢复权限；[精确缺口与SHA](evidence/opacity-release-check/workspace-portable-fixture-repair.json) |
| 最终版本真实四语言GUI、中文／日文系统IME、草稿恢复与正常关闭重开 | 未运行；原CUA连接已断，未重试旧窗口。本轮合成事件不能补此门槛；旧服务退出码与原窗口关闭仍未确认，历史记录保留 |
| 实际监听HTTP／CLI／MCP和native／Electron | 明确排除；已知旧loopback EPERM路径不重开。内存HTTP handler通过不代表监听／原生进程已验收 |
| 真实媒体与长片资源／连续音频、LUT原文件重选及重启 | 本轮未运行；需先确定并提供产品验证的工具链组合及必要最小范围，既有10-frame历史只覆盖当时版本 |
| 产品打包、全平台、签名／公证、安装后与正式工具链 | 未完成；源码build不等于安装包或产品运行时验收；历史Linux固定媒体组合在本机未找到，未安装 |
| 真实provider与付费调用 | 未运行，保持现有独立授权门槛 |

18个具名测试／QA入口的排除理由列在selection中，包含监听、SIGKILL旧路径、真实codec、GUI、MCP stdio及旧崩溃验收。未删断言或改allowlist换取通过。Node24默认及候选构建均exit1：macOS拒绝CUA Node映射已安装的Rollup原生模块，原因是process与模块Team ID不同（ERR_DLOPEN_FAILED）；wrapper的Cannot find module文案不表示依赖未安装。没有改签名、安装或重试该路径。正式Node24构建因此被阻塞；没有自动审批拒绝、待批准或结果不确定的新增操作。其余未运行项目是发布缺口，不能记为通过或新遭拒绝。

最小后续真实验收可限定为一个全新自有42工作区与10-frame合成素材：四语言Inspector、真实中文／日文系统IME、Save／Cancel和正常关闭重开；再备份恢复43，验证当前origin新草稿显式冷恢复及新预览／导出／下载身份。使用正式认可的Node／媒体工具链，无需用户实际项目、真实provider或长时FFmpeg；本轮未执行该计划。

## 下一项开发建议

先完成上述最终GUI／产品工具链门槛，再设计**已ACK旧编辑操作的严格历史只读兼容**，优先split／replaceSource；证明可读后才按操作放宽40副本升级资格。本轮已实际证明这些合法终态操作会阻断整个现有工作区升级，影响面直接且可用合成旧项目界定；不得因此开放旧任务执行。generated素材兼容仍是后续独立边界，不在本轮扩充位置／缩放／转场。
