# PR #17 · 复审修复记录

日期：2026-10-23（Asia/Taipei）。固定审查基线 `471197b7b21360f3f4d85349d0d8692504e1894b`，初始 PR head `5a220a856eb92169f6c0efc2ddbfac6e49e1e62a`。范围为已验收的 M0–M4，不进入 M5。该文档记录各轮发现与修复，不将后续审查或运行中的测试预先记为通过。

## Standards

**[P2] 公开 display 放宽持久记录格式。** 公共 Step/Change 新增读取时展示投影后，持久校验复用公共 schema，使旧 52/53 等固定格式接受本不应持久保存的 display。违反 `docs/AGENT-TASKS-V2.md` 中投影只在读取时构建、旧备份固定格式不变的约定。

修复：`task-schema-v2.ts` 在所有持久 Step/Change 入口明确拒绝 display；不改变公开响应、不修改固定历史 DDL。新增 52/54/56 × Step/Change 分类与恢复准入拒绝反例，确认拒绝不改 marker／原记录；移除污染后实际安装 53/55/57 恢复格式，公共响应解析正例保留。Node24 修复前 6 项反例失败，修复后 interactions 与 conversations 两文件 39/39 通过。

## Spec

**[P2] 嵌套显式参考绕过跳过名单。** 设计 A2 要求本轮涉及已跳过目标的调用一律 denied/TARGET_SKIPPED，但此前只枚举顶层身份；已实测跳过轨道后仍能通过 patch.trackId 移入片段并产生 Change。

修复：基于已验证 schema 的明确身份路径统一提取参考，包含片段目的轨道、镜头素材数组／末帧、图像编辑素材、LUT 和时间线身份等，不猜测正文或任意参数 JSON。目标读取前、实际工具执行前、后台发送门禁与迟到结果选择均复查；保留独立修改目标集合，不因参考的普通修改或草稿而扩大冲突范围。旧已受理步骤缺少参考元数据时，从原始 toolCall 纯提取身份，保留旧队列保护。完整合成运行回归同时检查同目标拒绝、用户占用保留和另一目标正常修改。

**[P2] 补充说明组合已知超限仍确认受理。** 五条单条 32KiB 的说明可以全部取得 completed 回执，下一模型请求随后因原有 128KiB 历史上限而失败，说明从未发送。双协议实测均为 failed/AGENT_CHAT_LIMIT、说明5条、请求1次。

修复：保留五条数量、单条32KiB、历史128KiB和请求512KiB上限；在受理事务内按已有上下文、已保存回复／工具结果及排队说明做纯构建容量预检。已知超限原子回滚正文和状态，保存稳定 rejected 回执并返回 AGENT_TASK_NOTE_CAPACITY；原执行和 UI 草稿／附件不变，四语提供可操作提示。未来尚未产生的模型／工具输出仍受原上限，不保证一定可容纳。修复前正式4项回归全失败，修复后4/4通过；不提高上限、不静默截断说明、不自动重发。

## 验证记录

- 工具层嵌套与旧元数据定向验证分别9/9、6/6通过（范围重叠，不相加）。
- 整合后的runtime新保护8/8、真实HTTP与CLI读取路径2/2通过；所有请求经合成网关，无真实模型／付费调用。
- `node scripts/tooling.ts typecheck`、`node scripts/tooling.ts build --channel=development` 退出0，后者包含三项目严格检查、Web及desktop main/backend/preload构建；既有构建警告保留。
- 首轮修复的37个相关测试文件以独立Node24进程、并发2、每文件600秒测试超时完整运行：763项，761通过、2失败，相对初始已验证PR head没有新增失败、无源码漂移。两项为初始PR及main共有的runtime媒体路径失败（生成镜头整体撤销／保留镜头迟到产物），错误同原记录；没有将其算作通过，精确媒体根因尚未证实。原始命令、来源SHA与逐项比较保存到下列证据。

持久证据根：`/Users/kouzen/Library/Caches/mioon-pr17-review-20261023/`。

- `review-scope.json`、`round1.diff`：初始固定范围和设计指纹。
- `standards-r1.md`、`spec-r1.md`、`spec-r1-capacity-supplement.md`：按轴分开的发现及复现限制。
- `display-red.tap`、`note-capacity-red.tap`、`spec-r1-track-result.jsonl`：修复前失败／错误副作用。
- `runtime-fixes-green.tap`、`http-capacity-green.tap`、`build-r1-receipt.json`：定向成功与构建记录。
- `related-r1-summary.json`、`related-r1-sourcepins.json`、`related-r1/`：37文件完整相关回归、源指纹、逐文件TAP和结构化事件；原初始PR全量和环境限制仍见 [M4报告](M4-CONFLICTS-NOTES.md)。

## 第二轮：重启后的冲突选择

固定审查 head `baf1af7fe7b6e77bcbcdda8c1df049e71261f81f`。Spec 轴 no finding；Standards 轴发现一项 **[P2] 重启丢失未处理冲突选择**：编辑占用使工具暂停后，原窗口放弃草稿并释放占用，重启把原因覆盖为 `restart`，普通继续便执行旧工具参数。合成探针观察到 Change=1、跳过名单为空，违反普通继续不能绕过冲突选择的约定。

修复：重启仍统一进入 `interrupted`，保留未处理的 `editing` / `conflict` 原因；继续先走原未知结果门禁，再在同一控制事务回到冲突暂停，不运行模型、旧工具或后台队列。旧版本仅保存 `restart` 的记录由未处理步骤的持久冲突证据恢复；已拒绝／已处理的冲突不误判。随后仍须明确跳过或停止；恢复冲突不扩充预算，控制回执写入失败则一起回滚。没有新增状态、schema 或授权范围。

验证先覆盖双协议、当前／旧恢复元数据、编辑占用释放、ABA、后台发送屏障、重复控制、未知结果、已处理冲突和普通暂停恢复。修复前选择24项中16项预期失败、8项对照通过，修复后24/24通过；两文件当轮全量154项，152通过，仅余前述2个共有媒体失败。其后追加了未知工具和满预算的双协议对照；最终定向、两文件全量、三项目类型检查和37文件相关回归以独立日志保存，写本文时仍在执行，不预记结果。

- `standards-r2.md`、`spec-r2.md`：分轴结论与范围。
- `standards-r2-restart-probe.test.ts`、`conflict-restart-red.log`、`conflict-restart-green.log`：错误副作用和红／绿证据。
- `conflict-restart-final-focused.log`、`conflict-restart-final-full.log`、`conflict-restart-final-typecheck.log`：追加对照后的最终四文件验证。
- `related-r2-summary.json`、`related-r2-sourcepins.json`、`related-r2/`、`build-r2-receipt.json`：最终修复版本的相关回归、源码指纹与构建证据（结束后生成）。

后续独立双轴复审结论在 PR 描述及同一缓存根单独记录，并绑定具体 commit；此处不预写 no finding。原 M0–M4 报告与设计输入不改写；没有新增依赖、修改凭据、真实调用、合入 main 或发布。
