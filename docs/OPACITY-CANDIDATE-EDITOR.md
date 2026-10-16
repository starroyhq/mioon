# 透明度候选编辑器与草稿 v3

日期：2026-10-16。编辑器片基线：`0ac49ab861a28c22a09e2324404d3762ea23d896`；后续渲染片：`a5e1f9e0ef012ff9fca5db2823e59d0bddeec9bd`。下列历史验证与当前激活状态分开记录。

后续[部分Safari与真实短媒体验收](OPACITY-CANDIDATE-NATIVE-ACCEPTANCE.md)已完成HTTP保存／重开／历史和10帧实际预览导出；GUI在导入选择器阶段工具断连，后续界面项未验。下文“不运行监听／媒体”保留对应早期切片的验证归属。

本片在内部候选装配中接入实际 Inspector、同一片段草稿控制器及独立 v3 companion。默认生产启动仍使用 40/41；不迁移用户项目、不通过 payload、URL、schema marker 或环境开关启用候选入口。

## 编辑闭环

- `createOpacityCandidateInspectorBinding` 创建不可由 JSON 或对象复制伪造的本地绑定，固定使用候选草稿客户端；普通 Inspector 不创建该绑定。新 TSX 控件提供简中、繁中、英文、日语文案，保留不完整数值文本，保存时才检查七点、帧范围、顺序及 0–1。
- 原 `createClipDraftController` 继续拥有 autosave、恢复、Save、Cancel、关闭保护与迟到确认。候选客户端由私有 WeakSet 确切识别；普通客户端即使收到编辑标记也不能保存透明度。完整 ACK 检查包含未变动的透明度字段以及 absent/null 区别。
- 音量与透明度共享一个 composition owner，并记录字段种类。仅当前控件可完成输入；另一个控件、保存、取消、移除及关闭保持阻断。连接或内部绑定变化不会把输入转给其他客户端。
- `createOpacityCandidateEditorAssembly` 只组合真实候选服务、原编辑任务协调器和原草稿 HTTP handler，不建立 listener、worker 或 provider。合成测试通过实际客户端／HTTP／控制器／任务／SQLite 验证保存、重开、恢复及取消。

## 独立草稿文件

`createOpacityCandidateLocalDrafts` 绑定真实 owned42 store，写入 `local-drafts-v3.json`。旧 `local-drafts-v1.json` 不读取、不覆盖、不升级；原 v1/v2 服务和音量编辑器继续使用原路径。43 仍不支持 companion 写入，显式 origin 下的时间线编辑沿原任务保护执行。

v3 完整 PUT 含 JPEG/LUT、audioRole、16 点音量、7 点透明度及三个来源字段时是 **132 节点、7590 字节、深度 5**。候选 walker 明确限制 132；旧 v1/v2 的 128 节点上限不变。行 8192、HTTP 12288、磁盘 2 MiB、128 个槽位及 CAS、目录同步、不确定写入语义保留。133 节点或超限请求不写入。

## 验证

编辑器片完成时，定向集合500/500通过、规格 Inspector独立用例另1/1，canonical类型检查通过，64个冻结文件当时均保持原值。独立审查覆盖客户端／控制器、合成HTTP→草稿与任务持久化、编译器及候选snapshot；双控件IME所有权和未完成时长显示已修正。随后渲染片获批修改一个冻结文件，现为63项原hash＋明确的单文件例外，不能继续宣称当前64项均原字节不变。

完整 `project-specifications-ui.test.mjs` 的 12 项既有 App guard 提取夹具缺少 `clipDraftRef`，本轮未修这些夹具，`App.jsx` 未改；不把上述定向通过写成整个仓库全量验收。没有启动真实媒体／provider、网络 listener 或用户项目。

## 渲染与运行时边界

后续渲染片已经将同一TypeScript编译器接入现有共享renderer的候选preview/export路径；raw snapshot、精确素材Map、来源hash/inode、LUT与发布fence均保留。4个获批2×2×3 RGBA像素探针在Node26.9.0／FFmpeg9.0.2下通过，详见[渲染接缝证据](OPACITY-RENDER-SEAM-PROPOSAL.md)。上述是渲染片完成时的范围；后续已将全新42接入实际App，并更新候选渲染提示，见[全新42应用入口](OPACITY-CANDIDATE-APPLICATION.md)。真实短媒体的后续范围见页首报告；完整GUI仍未完成。

本轮限定检查PATH、Homebrew Cellar node/node@24、nvm、fnm、mise/rtx、asdf、Volta、`~/.codex/runtimes`及已知Codex bundle工具目录，未发现可用Node24，只确认`/opt/homebrew/Cellar/node/26.9.0/bin/node`（v26.9.0）。没有全盘扫描或安装。这不是Node24或旧固定FFmpeg验收证据。

## 当前候选 preflight

`createOpacityCandidateServices` 已装配现有 `timeline.export.capabilities` 和 `timeline.export.preflight`。两者使用独立、可撤销的只读invocation，不加入mutation或edit-task白名单；43仍需显式origin。自定义preset先走原有有界capability实现，再走原source preparation；生产装配固定依赖，RPC不能替换probe、LUT reader或fence。

候选预检与render使用同一raw snapshot freezer。曲线、absent/null、派生opacityPlan、输出设置、名称和范围均参与hash；`timeline.render`接收`preflightSnapshotHash`后对原始快照重新比较。源素材、LUT及全部inode在准备后再次验证；预检不注册worker claim或render Map能力，也不写入timeline、历史、回执或导出任务。ready仅表示这次有界检查完成，实际执行仍重新验证。

候选内部预检支持可选`purpose: preview | export`，省略时按export检查；旧公共schema仍不接受新增purpose字段。固定已知source／LUT拒绝保留实际code、使用脱敏文案，并提供简中、无地区标签繁中、英文、日语解释。自定义preset在capability阶段遇到已知来源错误时抛出对应安全业务错误，使现有controller能显示具体原因，不放宽旧capability DTO枚举。

本轮使用真实SQLite、服务、素材图、合成文件hash/inode、回执、worker和共享renderer；仅codec传输被替换，没有启动FFmpeg、provider、GUI或listener。断连测试直接调用现有`callObservedRpc`，没有通过其他网络路径绕过已拒绝的listen。

最终相关集合277/277通过、零跳过／取消；其中preflight runtime wrapper另执行14项真实链路用例。foundation和browser严格类型检查通过，legacy allowlist未变；独立审查发现的错误原因聚合、权限撤销透传及异步Promise持有问题均已修复。可复查[机器可读证据](evidence/opacity-preflight-candidate/qualification.json)和[测试摘要](evidence/opacity-preflight-candidate/tests-summary.txt)。

## preflight片结束时的入口缺口（历史记录）

这不是单一flag的改动。最小发布顺序应先开放新建42工作区，再补42冷备份→43恢复；旧40/41升级单独处理。

1. **真实启动和业务入口。** `apps/server/src/index.mjs`仍固定`openStore`及旧恢复上下文／锁守卫，默认dispatcher仍只接受40/41。需要在应用所有者边界选择精确42/43装配并贯穿关闭、恢复和worker生命周期。内部editor assembly的`drain`目前使用`allSettled`吞掉服务／任务失败，接入真实启动前应保留这些有界停止错误，避免错误宣告可关闭。候选services还缺App启动必需的`workspace.restore.inspect`、`project.list/get`，以及新用户从空库操作所需的project/create、素材导入、clip.add等；应复用原业务handler，不得用测试预置数据库替代产品入口。
2. **公共传输与客户端确认。** server RPC和`packages/client/src/index.mjs`仍先走旧schema；需要只在后端精确候选装配下选用候选parser/ACK。实际`edit-task-client.js`的envelope/list、App的timeline mutation/render ACK和sample record仍使用旧validator。现有编辑器合成e2e直接读取task HTTP JSON，未证明这些真实客户端已支持新字段。必须保留原request身份、迟到ACK和未知结果处理。
3. **实际Inspector与草稿。** App挂载`TimelineInspector`时未传私有`opacityCandidate`，`main.jsx`也未创建绑定。真实server还未选择v3 companion装配。应接入原草稿控制器和关闭保护，并用真实能力替换过期`renderPending`提示；43当前不支持companion写入，需要明确产品处理，不能假装自动恢复可用。
4. **播放、下载与完成状态。** server的`deliveryGuards`固定旧`isTimelineRenderRecord`。需将精确候选record校验接入同一source／held／文件响应守卫，确保worker成功后，用户能取得正确的preview/export媒体。
5. **备份恢复产品链。** 公共backup DTO、DB classifier、离线restore、CLI和诊断仍只支持40/41。42→43构造器存在，但create/verify/restore/restore-status尚未贯通；43应继续拒绝递归备份。此闭环完成前，不向用户提供43恢复入口。

以上1–4已由后续[全新42应用片](OPACITY-CANDIDATE-APPLICATION.md)接通，并补[普通42已有目录重开](OPACITY-CANDIDATE-REOPEN.md)，均限内部明确入口。第5项已有[固定42冷备份→43离线产品入口](OPACITY-CANDIDATE-BACKUP-RESTORE.md)，随后[恢复43应用片](OPACITY-RESTORED-APPLICATION.md)接通独立启动、已有片段编辑／Undo／Redo及新render，保留原held／epoch／origin。43不写companion，当前未保存输入与视图仅在本窗口内存，正常关闭也可能丢失；源v3原文仍保留。preflight／capability无需重复实现，GUI／真实媒体范围单列。旧40/41升级继续按下节单独处理。

## 旧40/41升级条件与备份恢复策略

- **当前不迁移。** `initializeWorkspaceSchema42`仅支持空库构造或精确42重开，明确拒绝旧40；不能插入42标记冒充迁移。
- **40升级需独立迁移器。** 最小首批资格可限定为：所有后端／桌面端干净关闭，没有未解决执行／确认结果，未保存草稿已明确保存或取消，完整40分类与冷备份verify通过。不符合条件就保留40，不删除未知任务或自动重放。
- **只迁移新副本。** 保留原40目录和已验证的原始冷备份，在独立副本内事务升级。需要比较原始行、rowid、来源、历史、request/hash/receipt，明确未完成任务和companion策略，再独立重开42验证；不把投影、重算hash或清空历史当迁移。
- **41继续旧路径。** 43构造器只接受普通42，sourceSchema固定42。41不能改标记成为43；未来若支持，必须另审保留source40来历、held、epoch和原捕获证据的策略，不重写这些证据。
- **回退是选择旧目录。** 关闭新副本，显式重新选择保留的旧40目录；不要删除42/43标记或把新数据截成旧字段。当前40备份通过标准恢复会产生受保护41，而不是重新授权历史任务执行的普通40。恢复发布结果不确认时只检查restore-status，不原地重试／覆盖／清理。
- 现有冷备份不包含凭据、设置、浏览器数据和companion，故备份前需处理未保存草稿。只有42备份／恢复产品链补齐后，才能发布42→43用户恢复流程。

## 仅验收缺口与监听边界

代码接线完成后，仍需真实GUI四语言、IME、草稿恢复、Save/Cancel/关闭保护、播放／下载和性能验收。实际10帧渲染与HTTP读取／下载已经由页首后续报告验证，不能代替界面操作。还需Node24及产品实际固定FFmpeg运行时验证；本轮Node26和此前FFmpeg9.0.2的短像素证据不能替代它们。

上述preflight片的候选服务、worker和observer验证均不依赖监听。当时将真实HTTP恢复命令 `TMPDIR=/private/tmp node --test --test-name-pattern='restored server' tests/workspace-restore-execution.test.mjs` 列为待授权范围，目标为`127.0.0.1`的测试动态端口；该片未执行此命令、未重试此前EPERM拒绝，也未使用其他监听路径。后续用户已明确授权本任务隔离localhost验收，42已运行的结果见页首报告，43后续结果见[独立应用片](OPACITY-RESTORED-APPLICATION.md)；这里保留旧片命令记录，不把它算成已执行或要求对同次授权重复请示。
