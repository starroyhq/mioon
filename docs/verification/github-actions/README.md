# GitHub Actions 实施验证

基线：`c9a81ac050e23bc0cf3298a41f428c0afa26b46c`（已合并 PR #11）。独立分支：`codex/github-actions`。原工作区、私有 designs 和无关待办未纳入修改

## 本地检查

在 macOS arm64 使用 Node `24.21.0`、pnpm `11.25.0`，临时目录使用真实路径 `/private/tmp`

| 检查 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，复用 397 个依赖，锁文件未改 |
| `node scripts/tooling.ts typecheck` | 通过，包含 `.github/scripts/**/*.ts` |
| `node scripts/tooling.ts build --channel=development` | 通过 |
| `node scripts/tooling.ts build --channel=production` | 本地暂存构建通过，未等同安装包验收 |
| `node scripts/tooling.ts test --suite=portable --concurrency=1 --reporter=tap` | 98/98 通过，无跳过 |
| `node --test tests/actions-{release,desktop-helpers,desktop-media,ffmpeg-install,test-shards}.test.ts` | 60/60 通过，无跳过 |
| actionlint `1.7.12`、`git diff --check` | 通过 |
| macOS 基础 FFmpeg/ffprobe 探针 | 通过；仅证明本地合成所需基础编码能力 |

辅助测试覆盖版本、标签、main 归属、标签移动、凭据缺失、错误或缺失附件、哈希、公开版本拒绝、草稿恢复、归档路径和链接安全、错误脱敏及超时。媒体集成通过与原生冒烟相同的公共 HTTP 配方，实际导入合成媒体、编排音视频、渲染 MP4，再由 ffprobe 检查 1280×720 与音频流

扩展严格类型检查后，两个既有测试对 tsconfig 的精确列表断言需要同步增加 CI 脚本目录；已更新断言，未放宽编译选项或减少原有覆盖

## 远端与发布验收边界

[PR #12](https://github.com/starroyhq/mioon/pull/12) 中运行 Ubuntu full、macOS portable、Windows portable，最终状态以 PR 的 `CI` 总检查为准。Linux full 不在 macOS 上伪装执行成功

[首轮运行](https://github.com/starroyhq/mioon/actions/runs/39387931266) 的 Ubuntu actionlint 启用了本机未安装的 shellcheck，指出内嵌 JavaScript 模板字符串的 SC2016 提示；已改为等价字符串拼接，保留完整 lint 门禁。独立审查发现的组合符号链接逃逸边界也已补回归：Linux 归档链接禁止向上路径段，实际包不符合时严格拒绝

[跨平台运行](https://github.com/starroyhq/mioon/actions/runs/39388344465) 中 macOS 全部通过；Windows 的两个既有 portable 测试暴露原生路径键与换行问题。已统一编译测试的路径键并增加 Windows 路径回归；`.gitattributes` 仅固定五个字幕资源的字节表示，原生产尺寸和 SHA 校验保持不变。临时 Git 索引模拟 `core.autocrlf=true`，确认四份文本未经约束时全部偏离既有尺寸/哈希，应用属性后全部恢复；相关两文件本地 17/17 通过

后续 Ubuntu 日志确认系统包为 FFmpeg 4.4.2。对照官方 [4.4.2 参数实现](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n4.4.2/fftools/cmdutils.c)与 [7.1.5 参数实现](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.1.5/fftools/cmdutils.c)，前者不支持当前生产代码的文件值参数；`-fps_mode` 也不在 4.4 中。CI 改为校验固定源码哈希后构建 7.1.5，保留 Ubuntu 22.04 和生产参数，新增真实命令探针，防止仅滤镜列表通过便进入长时间全量测试。官方源码压缩包签名已用发布密钥指纹 `FCF986EA15E6E293A5644F10B4322F04D67658D8` 独立核验；未导入用户钥匙环

已知环境不兼容的[运行](https://github.com/starroyhq/mioon/actions/runs/39389024360)主动取消，其 Linux full 不计为通过；该轮 macOS、Windows 各有 portable 99/99、辅助 29/29 通过。后续完整复验使用固定工具环境，继续保留全部既有测试

固定工具安装与实际参数/PNG探针补齐后，本地严格类型检查、actionlint、diff-check通过；发布、原生辅助、工具安装及真实媒体测试合计 **41/41 通过，无跳过**。源码编译的实际结果由 Ubuntu 后续运行验证，本机未冒充 Linux 编译通过

[固定工具运行](https://github.com/starroyhq/mioon/actions/runs/39394182568) 已实际完成 Ubuntu 官方源码编译、五项媒体探针、严格类型及 development 构建；macOS、Windows 检查通过。旧轮约 37 分钟仅执行到文件排序的 37%，单 job 存在明显 60 分钟超时风险，因此改为四个独立 job；每片保留原 full 准入、逐文件串行及 60 分钟限制，并验证全集恰好覆盖一次。后续全量状态以 PR 检查为准

旧轮部分日志中的非媒体失败单独修正：两处已授权响度扩展用唯一精确逆变换恢复原 schema50 字节后继续核验全部历史哈希；两份 Agent 界面 harness 按当前折叠流程展开选择区，并继续验证隐藏操作、授权、dirty 和 stale 围栏；重启说明断言对齐完整“不自动续接或重新发送”文案。生产 UI、历史哈希和旧版拒绝规则均未放宽

导出两项旧断言按已合入 `01a83cb` 的输出保护升级同步：持久记录遭替换时精确保留本次唯一空 part 的名称/inode/字节和全部文件集合；输出 inode 被替换时先报告输出身份错误，替换字节与 inode 必须原样保留。生产清理和所有权围栏未改。定点 6/6、整文件 19/20 通过；唯一未通过项为本机缺字幕滤镜的画幅矩阵，留给 Linux 实际复验

分片辅助测试 8/8、当前 785 文件的真实 full 选择校验、严格类型和 actionlint 通过；四片为 197/196/196/196 文件，并集完整、无重复，全集 SHA-256 一致。历史保留测试 13/13、两份 Agent harness 24/24 与 18/18、说明文案测试 17/17 均通过

[首次四分片运行](https://github.com/starroyhq/mioon/actions/runs/39395989355) 的 macOS、Windows 各通过 portable 99/99、辅助 47/47，无跳过。Linux 分片 2 的 3687 项中仅一项失败：历史渲染回归需要 `git show` 固定旧提交，而默认浅克隆缺少对应对象。该提交仍属于干净 main 的祖先，原源码哈希保持不变；Linux full 改为完整检出历史，继续执行原回归，不替换基线或放宽哈希

该轮 Linux 四片均执行完成，785 个文件覆盖清单已下载核对：同一源码 SHA、同一全集哈希、并集完整且互不重叠。合计 12687 项，12678 通过、7 失败、2 个既有条件跳过、0 取消。失败归为浅克隆两项、已合入 LRA 扩展的历史源码比较两项、当前普通 schema 的旧期望一项、已合入导出所有权围栏的保守清理期望两项。历史比较继续使用原哈希和有限精确逆变换，清理检查继续核对确切 inode、字节、请求回执和完整文件集合；未改生产业务行为

两项既有跳过分别要求 POSIX 更换文件所有者能力和原生 Windows ACL 环境；非 root Linux runner 不伪装这些能力，也不将其报告为通过。后续完整复验结果见 PR 的最新 `CI` 检查

本地修复验证：原历史渲染回归 1/1、opacity 历史比较 7/7、restore 源码保护 77/77、两处 owner 回归 2/2 通过。preflight 整文件 45/46，唯一未通过项为本机缺 `libwebp`，该项在上述 Linux 完整运行已通过；Look 媒体链仍受本机缺 `zscale` 限制，独立真实备份/恢复已确认普通 50 → 备份 50 → 恢复 51，完整链留给固定工具环境复验

[后续运行](https://github.com/starroyhq/mioon/actions/runs/39402252728) 有一片在官方源码下载阶段失败，另三片已开始编译；为整合下载可靠性修复主动取消，未计为通过。下载器对已知临时网络错误及 HTTP 408/429/5xx 最多尝试三次，共用原 120 秒总预算，每次按自身 inode 清理部分文件后完整重下；404、重定向、已有文件、超大/空文件、哈希错误及构建失败不重试。诊断仅输出固定分类或 HTTP 状态，固定来源和 SHA-256 不变

下载器 20/20、包含真实媒体的辅助整合 60/60 通过，foundation/tests 两套严格类型检查通过。独立实测确认替换 inode 不被删除、响应体超时被有界拒绝，以及磁盘写入失败和超时同刻发生时只请求一次并返回 `WRITE_FAILED`；未知字节、超大响应及哈希错误均不触发重试

签名发布尚未验收：仓库级 Apple Secrets 当前为空，组织级授权未知；本地没有最终签名安装包。需要维护者配置文档列出的七项凭据，并在工作流合入 main 后运行 `release_tag` 留空的演练，实际完成三平台打包、macOS 签名和公证、Gatekeeper 与最终包原生冒烟

本轮不创建版本标签、不公开 Release、不改变 main 保护规则。Windows 仍限于源码检查，现有桌面启动保护保留

## PR #14 合入后的主线整合

2026-10-20，将 `origin/main@10f1638`（已合并视频供应商及 harness v2）合回 PR #12 的 `927aafd`。工作流、发布脚本和生产业务源码保持各自已提交的实现；没有为解决冲突改生产行为。

- 唯一文本冲突是 `agent-timeline-gain-preservation` 的 LRA 逆变换与新 schema52 pin 链。保留 52/53 整体源码 pin 和原 50 前驱 pin，对 LRA 字节增加修改、删除、重复、未知导入的严格拒绝测试。
- opacity 历史保护的八个当前源码固定完整 SHA，然后读取固定 `927aafd` 前驱继续验证原始 raw/type-erased pins。原历史 manifest、27 项 map、有限 delta ledger 和所有旧 SHA 均未修改，新增删除、重复、换行及隐藏导出的拒绝测试。
- Look 用例通过当前 `openStore` 新建库，当前期望同步为普通52/恢复53；独立实际备份恢复也验证了 52 → 53。没有将固定旧格式测试改为新格式。

合并后的本地验证使用 Node 24.21.0、pnpm 11.25.0 和 canonical `/private/tmp`：

| 检查 | 实际结果 |
| --- | --- |
| CI 辅助与增益保护 | 71/71 通过 |
| portable 通道 | 99/99 通过，无跳过 |
| opacity 与 restore source guard | 85/85 通过 |
| 严格类型检查、actionlint、diff-check | 通过 |
| 其他 PR 改动相关回归 | 129 项中 127 通过；Look 渲染及 WebP 探针两项受本机媒体能力限制失败 |
| full 分片静态选择核对 | 实际 812 文件，四片各 203；并集完整且无重复，12 个新增 v2/编辑保护入口均恰好入选一次 |
| 独立合并复核 | no finding；另外复跑 gain/shard 21/21、opacity 8/8 |

本机 FFmpeg 确实没有 `zscale` 和 `libwebp`，不将上述两项算作通过，也没有添加跳过、失败排除或放宽断言。更新后的实际 Linux full、macOS/Windows 状态以 [PR #12 的当前 CI](https://github.com/starroyhq/mioon/pull/12/checks) 为准；前述旧 SHA 的成功记录不代表本次新合并已通过。未创建标签、运行签名发布或调用真实付费供应商。

### 全量预检查补齐当前版本断言

`faa5f5b` 的[整合运行](https://github.com/starroyhq/mioon/actions/runs/39439429900)已通过 macOS/Windows，Linux 四片也完成工具能力、类型和构建。等待 full 期间的有界排查实际重现了其他当前库旧预期：先选的 8 文件 49 例中 11 项仍断言50/51，另 5 文件的启动、目录与 marker 比较仍只包含50。发现这些必然失败项后主动取消旧轮，未把它计为完整通过。

共 13 个测试文件按当前52/53/v15窄适配，业务源码、工作流及原历史 fixtures 均未改。原始24/17 SQL、raw bytes、rowid、sequence、未知对象拒绝及固定50/51仍保持严格比较；迁移目录先逐项核验52独立黄金的130个对象及count/hash、14张表字段和初始行，再剥离已验证新增项。schema17的目标修订初始化按原seed精确验证7个目标及revision=1，同时检查新rowid完整1–7和kind分段，冷重开仍全snapshot比较；不把无ORDER的UUID首次扫描顺序当作契约。

| 本轮修复组 | 实际结果 |
| --- | --- |
| shot draft、视频设置、工作区配置、导出备份恢复 | 4/4 通过 |
| opacity application/transactions、BLOB边界、restore schema | 45/45 通过 |
| server storage、backup marker、receipt protections | 430/430 通过 |
| independent schema profiles | 56/56 通过 |
| image migration（最终独立复验） | 4/4 通过 |
| 测试代码严格类型检查、diff-check | 退出0 |

以上为本地定向红绿验证，远端全量状态仍以新提交的 CI 为准。没有跳过测试、减少历史比较或为通过CI改变生产行为。

剩余 `currentOrdinary50Delta` 消费者的有界核对又实际重现四条旧迁移快照失败：image edit、subjects、source ranges、asset dispositions。均按同样的独立52完整目录及原seed目标修订先验后剥离；range/disposition额外逐表比较迁移前后的SQLite原始类型/字节/rowid/sequence，冷重开比较完整raw snapshot。修订初始化只固定目标身份、revision=1、完整rowid及kind分段，不把无ORDER扫描的UUID顺序当作契约。

同文件及同模式的metadata快照也精确补齐目标台账：range revision2、三个disposition各revision5、annotation revision2，以及subject2、两个version1、两个binding4/1；不忽略修订整表，其他目标和业务表仍全量比较。损坏project JSON夹具先断言新target guard原子拒绝，随后仅在造坏数据的瞬间移除并finally恢复同一条guard；业务负例执行时所有保护启用，保留原无泄露、零变更断言。

最终完整文件分别通过 image edit+subjects migration **14/14**、source ranges **16/16**、asset dispositions **28/28**、annotation **9/9**、subjects domain **10/10**，无跳过；测试严格类型及独立复核通过。这两轮合计涉及19个相关测试文件的当前格式适配，未改变生产源码或原历史fixtures。[第二次整合运行](https://github.com/starroyhq/mioon/actions/runs/39442747856)因上述已确认红例也主动取消，不计为通过；最终跨平台完整结果以之后提交的当前CI为准。


### 当前主线的实际 full 回归

[整合运行 39444741986](https://github.com/starroyhq/mioon/actions/runs/39444741986/attempts/2) 的四片都完成固定 FFmpeg 7.1.5 编译、媒体能力检查、严格类型和构建；macOS/Windows 的 portable 99/99、辅助58/58通过。首轮曾因官方源码下载连接中断而失败，取消后在同一源码上重跑整轮；没有把网络失败计为通过。

该轮四片全部跑完，覆盖812个文件：合计13021项，12817通过、202失败、2项既有条件跳过、0取消。失败标题和位置逐项归集，保留该轮失败证据，未将部分平台成功当作整轮通过。

实际 full 暴露的主线接入遗漏逐项红绿复现。生产源码窄修四个文件：补 `video.connection.list` 四语展示文案（否则显式 locale 的 MCP 在启动时抛未知文案 key）；助理面板使用现有 `--wb-panel`/`--wb-accent` 共享颜色变量；助理上传与视频设置的两个多行输入分别使用现有共享 Input/Textarea，保留原事件、值、文件类型与禁用条件。没有改变操作 schema/effect、授权、调度或持久化语义。

相关测试继续比较全部新旧表及目标台账。正常编辑只接受明确项目、类型、目标与确切修订；异步导出失败只允许该已受理 export 的终态修订加一。历史 golden 先核验固定52目录及原 seed 对应的初始目标，再比较旧字节；SIGKILL 测试保留完整新表/行。坏 JSON 夹具先证明活跃 guard 原子拒绝，仅在构造损坏字节时暂移除四条确切 JSON reader trigger，并在执行业务负例前恢复原 SQL。没有放宽未知目录、删除旧 hash、忽略整张修订表、加大超时或添加失败跳过。

提取实际 App/desktop 源码的测试补齐新增导入边界。视频 codec 生命周期用例等待真正进入刷新，再在未释放 gate 时停止，确认不提前退出、发布 ready 或关闭 codec。source inspector 用例实际渲染新增占用边界，验证精确 target、脏稿保留和同 scope 放弃，不以宽松源码正则替代。

| 修复验证组 | 实际本地结果 |
| --- | --- |
| 项目首页、last project、import feedback | 94/94 通过 |
| 四语展示及 CLI/MCP、只读 effects | 40/40、5/5 通过 |
| desktop startup / settings navigation | 74/74 通过 |
| float recovery、local delivery process、LUT backup、project specifications | 58/58 通过 |
| 当前 durable envelope ingress | 6/6 通过，冻结38/40仍保留 |
| local shot process、timeline replacement | 90/90 通过 |
| source range、loudness apply 三协议往返 | 16/16 通过 |
| annotation/disposition 三协议、reference/source UI | 40/40 通过，UI独立重跑29/29 |
| desktop shutdown / UTF-8 inventory | 33/33 通过 |
| 最终 desktop shutdown / tokens / empty workspace | 43/43 通过 |
| desktop exit / window ownership、MCP 启动诊断 | 55/55、8/8 通过 |
| local shot HTTP、恢复执行、workspace visibility | 32/32 通过 |
| last project、reference recovery、audio preview | 151/151 通过，独立定向5/5 |
| 共享控件、Agent panel/session、video generation UI | 58/58 通过，最终 panel3/3 |
| 测试严格类型、含全项目类型的 Web 构建、diff-check | 退出0 |

各组最终 diff 均有独立复核；发现的视频刷新 gate 覆盖缺口已修正并复验，无遗留发现。独立漏项审计逐项对照四片202个原失败标题，196项原名命中，6项登记明确的当前格式/固定历史标题迁移，全部找到最终成功日志。历史 reference bootstrap 使用既有固定through24 helper单独保留，另验证当前52缺 guard 时严格拒绝启动、全部SQL/类型/原始字节/rowid/receipt/sequence保持不变。上述为本地证据，分组存在重叠，不据此替代最终新 SHA 的跨平台完整 CI；状态仍以 [PR #12 当前检查](https://github.com/starroyhq/mioon/pull/12/checks) 为准。未触发签名、打包发布、标签或真实付费接口。
