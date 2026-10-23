# Mio · M2 返修报告（待验收）

日期：2026-10-22。只修复 M2（含 A6），没有进入 M3。工作树 `/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon`，分支 `codex/mio-m0-preparation`，HEAD 仍为 `ab65771998936e5e0bb1e2465e40ecefff233e91`。

持久证据根：`/Users/kouzen/Library/Caches/mioon-mio-m2-repair-20261022/`。上一轮只跑相关子集，漏掉了本轮发现的回归，完成结论不充分；旧 `/private/tmp` 证据已不存在，原 932 项和 157 张截图均不作为本轮可访问证据。原报告文字保存在 `evidence/M2-PANEL-before-repair.md`；本报告使用重新运行的结果和新截图。

## 1. 本轮修改文件

本节只列返修相对开工快照的变化，M1/M2 原有未提交修改继续保留，不把它们全部算成本轮新增。

| 分类 | 文件 | 修复 |
| --- | --- | --- |
| 界面 | `apps/web/src/AgentTaskPanel.tsx` | 附件使用项目共享 `Input`，保留 `sr-only`、非焦点/非可见原生控件与附件图标按钮。 |
| 界面、i18n | `apps/web/src/image-generation.ts` | 恢复失败提示复用既有消息 descriptor，不再引入中文 UI 字面量；没有修改例外清单或其哈希。 |
| 界面格式化 | `apps/web/src/agent-task-presentation.ts` | description / subtitleText 单独按已授权项目内容呈现，不再被用于步骤说明/目标名的启发式过滤器丢弃。React 仍按普通字符串呈现。 |
| 业务 | `packages/business/src/agent/task-display-v2.ts` | `safeText` 只清理 C0/C1 控制与 Bidi 字符、合并空白、按字符安全截断；保留 basename。删除 URL、路径、UUID、id 前缀及凭据关键词的猜测脱敏，保留两个白名单文本字段。 |
| 业务、模型侧语言 | `packages/business/src/agent/task-runtime-v2.ts` | 托管附件说明按本轮 locale 生成简中、繁中、English、日本語，语义相同且随 Run 持久保留。 |
| 传输与恢复入口 | `apps/web/src/App.tsx` | 普通任务仍走原独立 overlay；image/frame 仅定位已有精确记录。确认和读回包后复查项目、workspace/epoch、视图、连接、IME、retained；确认后捕获草稿 owner/版本，阻断迟到读卸载新草稿。纯守卫不产生晚到提示或修改。 |
| 测试 | `tests/agent-task-display-v2.test.ts`、`agent-task-runtime-v2.test.ts`、`agent-task-http-v2.test.ts`、`mio-presentation.test.ts` | 五条原文、普通 URL/路径等内容、Unicode/Bidi、planned/current、四语附件双协议往返与重启；HTTP 精确核对用户当前文本及请求私有边界。 |
| 测试 | `tests/frame-extraction-integration.test.mjs`、`source-range-ui.test.mjs`、`workbench-shell.test.mjs`、`task-center-app.test.mjs`、`settings-navigation-state.test.mjs`、`transport-utf8-output.test.mjs` | 补齐实际 App 片段依赖和精确匹配；旧 pure overlay 仍禁止 RPC，新恢复路由单独检查严格只读 seam 和正反路径；Mio 文案；登记新增连续 UTF-8 读取。 |
| 文档 | `docs/AGENT-TASKS-V2.md`、`docs/CLI.md`、本报告 | 说明两个项目文本字段的例外、附件语言及真实验证边界。 |

契约没有新增改动，工作区 schema/恢复格式、业务 CLI/MCP 参数、授权与收费策略均未改变。普通库仍为 52，恢复格式仍为 53。

## 2. 修复与边界依据

以下原文在 description / subtitleText、工具计划与冲突 current 投影，以及四语前端格式化中精确保留：

- 镜头从左/右两侧推进
- A/B 对比
- 16/9 画幅
- 慢慢推近 1/2 速度
- 台词：密码：芝麻开门

只保留显式字符清理和既有长度约束，截断不拆开 Unicode 代理对。原始业务 before/after、undo、请求和配置密钥仍不公开；其他操作仍只有类型与目标。该例外来自用户本轮明确要求，不修改设计输入文件。

`openAgentRequests` 的代码检查误将新增合法恢复定位合并进旧 pure-overlay 范围，不能继续用“整段无 RPC/属性切换”的断言；现分别验证旧入口与新精确只读路由。新路由不执行业务写入，不替代授权或生成恢复。

同时修复两个真实异步缺口：确认或 RPC 等待中开始 IME/retained 状态后，拒绝迟到导航；RPC 等待中输入普通镜头/片段草稿时，旧实现会切入 SourceRangeInspector，卸载并 dispose 原表单的未保存定时器。真实 controller 反例修前 0/2、修后 2/2。现在使用确认后 owner/capture 保证等待期的新输入、改后改回和 owner 更换均使读失效；frame 合法卸载旧表单后不继续用旧 capture 自我阻断，subtitle 继续保留 App owner，image 保持原 owner 校验。证据：`source-checks/draft-race-summary.json`。

## 3. 全量回归与只在本工作树失败的用例

环境：同一台 Darwin arm64，Node **24.19.0**、pnpm **11.25.0**，`TMPDIR=/private/tmp`。证据/源码副本均在上述持久根，未清空原 node_modules。baseline 是精确 ab65771，两个工作树副本具有独立完整 Git 历史；依赖均 `CI=true pnpm install --frozen-lockfile`，没有新增/升级依赖。每轮每文件隔离进程，并发 2、600 秒测试超时；三轮并行时最多 6 个文件进程，分别保存原始完整结果，不拼接通过片段。

每个副本的全量命令均为：

```sh
TMPDIR=/private/tmp node --test --test-concurrency=2 --test-timeout=600000 \
  --test-reporter=tap --test-reporter-destination=stdout \
  --test-reporter=<持久证据根>/evidence/full-test-events-reporter.mjs \
  --test-reporter-destination=<对应轮次>.events.ndjson \
  "tests/*.test.mjs" "tests/*.test.ts"
```

实际 Node 绝对路径、参数、环境、Git 与源码/测试/日志哈希均在 `evidence/*-full-state.json`、`*-full-manifest.json`。临时测试数据可以使用 `/private/tmp`，日志与汇总不在该目录。

| 完整轮次 | 文件覆盖 | tests | pass | Node fail（实际失败） | skip | cancel | exit | Node 时长（秒） |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 冻结 main ab65771 | 830/830 | 13015 | 12925 | 68（65） | 22 | 0 | 1 | 2297.163 |
| 首轮工作树（已包含部分修复） | 835/835 | 13166 | 13073 | 71（68） | 22 | 0 | 1 | 2329.936 |
| 修复后完整工作树 | 835/835 | 13196 | 13106 | 68（65） | 22 | 0 | 1 | 2397.369 |

三轮均完整结束，没有缺失文件证据、解析歧义或副本运行期间源码漂移。每轮 3 条 `subtestsFailed` 父级重复保留在 Node fail 中，实际差集排除它们；两个 Node 顶层文件进程失败仍计入实际失败。完整索引：`evidence/full-validation-index.json`。

按文件与完整父子用例名匹配；排除父级 `subtestsFailed` 重复，不隐藏实际失败、取消或跳过。

首轮工作树全量在上述定向修复后另发现 **3 条只在工作树失败的用例**，逐条为：

1. `tests/agent-task-http-v2.test.ts` — `chat_completions: conflict snapshot reads current saved values on the server without exposing raw evidence or replaying work`。
2. `tests/agent-task-http-v2.test.ts` — `responses: conflict snapshot reads current saved values on the server without exposing raw evidence or replaying work`。
3. `tests/task-center-app.test.mjs` — `actual App keeps retained owners mounted and routes task opening through its overlay`。

前两条是旧断言仍禁止用户已允许的项目正文，改为精确核对原文、排除过期值并保留 request/data 私有边界；第三条是旧源码检查把新的只读恢复 seam 合并进 pure-overlay 区间，拆开后分别校验，并补全真实草稿竞态用例。

**修复后完整全量：只在当前工作树失败的用例为 0；只在 main 失败为 0；共同实际失败为 65。** 没有用定向重跑拼接此结论。8 条共同错误的消息仍含不同合成任务字段；逐条保留双方原错误和相同错误码证据，不把消息差异藏成通过。

首轮失败历史及修复后差集：`evidence/current-vs-baseline-comparison.json`、`current-fix1-vs-baseline-comparison.json`；用户指定 9 例在完整 main 与最终工作树中均通过，精确 caseId、文件 SHA、事件来源见 `known-nine-comparison.json`。

用户列出的修复前问题在独立冻结返修前源码中逐条复现，9 个文件 154 项中 145 通过、9 失败；最终同 9 文件扩展至 **225/225**。这部分是定向证据，不冒充另一轮全量。9 条为：

| 文件 / 原位置 | 具体修复前失败 |
| --- | --- |
| `i18n-catalog-integrity.test.ts:32` | current source has no unreviewed or stale static UI literal exceptions |
| `ui-components.test.mjs:254` | renderer uses shared components for ordinary controls and modal confirmations |
| `workbench-shell.test.mjs:9` | task reveal uses a separate overlay and keeps project, view and composition admission |
| `task-center-app.test.mjs:133` | actual App keeps retained owners mounted and routes task opening through its overlay |
| `frame-extraction-integration.test.mjs:91` | actual App hook connects capture/rpc/reveal with source or narrow Properties visibility |
| `frame-extraction-integration.test.mjs:125` | actual App source inspector keeps the normal frame panel and replaces it with the restored hold notice |
| `source-range-ui.test.mjs:144` | App guards dirty clip before source selection, clears clip selection, and rereads after replay |
| `settings-navigation-state.test.mjs:255` | agent: optional closeLabel changes only return text and accessibility labels |
| `transport-utf8-output.test.mjs:267` | every inventoried test/QA text collector configures continuous decoding at its actual listener, before delivery |

定向汇总/原失败/精确补丁：`source-checks/SUMMARY.json`、`source-checks/before-targeted/`、`source-checks/after-draft-race-targeted/`、`source-checks/repair.patch`。HTTP + 前端原文完整文件另有 **25/25**，日志为 `evidence/repair-http-presentation.tap`，不与全量相加。

### 环境与基线问题（不作为本次回归修复）

最终 65 条共同失败全部保留，独立逐条归因为：23 条原始错误直接证明的环境失败、37 条由执行顺序／源码及同机探针支持的环境失败、5 条同一失败 fixture 引发的后续失败；**未分类为 0**。这些类别区分证据强度，不能把未到达的业务断言当作通过。具体证据在 `evidence/failure-audit-final.json`、`failure-audit-final-message-variance.json`、`failure-audit-media-probes.json`、`failure-audit-codec-probes.json`、`media-environment-probe.json`。

三轮命令均 exit 1，因此**全量未全绿**。当前工作树没有相对 main 的新增失败；仍需在满足冻结 Node 和媒体／归档能力的环境中重新完成这些共同失败对应的验证。

同一 Homebrew FFmpeg **9.0.2** 缺 drawtext、subtitles、zscale 与 libwebp 编码器：原 filters / encoder 输出及独立纯合成探针分别证明具体失败，不把 zscale/WEBP 归为 drawtext。真实 Mock 的 poll/download 返回 `MOCK_RENDERER_UNSUPPORTED`，无法到达迟到产物或发布屏障的用例不能宣称相应媒体保护已通过。

固定 PATH 的 `tar` 是 `/usr/bin/tar`（BSD tar），不支持测试所用 `--format=gnu`；本机另有 GNU tar 1.35，未偷偷改变三轮环境以消除差异。证据见 `failure-audit-tar-probe.json`。Git 历史在各副本可读，不把缺历史作为环境借口。另有两个 frozen-v40 顶层脚本精确要求 Node v24.21.0，现有 v24.19.0 在命名用例注册前失败；保留为两条真实文件进程失败，不剔除，也不放宽冻结断言。相应冻结格式保护在这次环境下未执行，不能宣称全部备份兼容检查通过。

最终构建与类型检查：

```sh
node scripts/tooling.ts build --channel=development
node node_modules/typescript/bin/tsc -p tests/tsconfig.tests.json
```

生产严格类型、Web、桌面 development 构建和测试严格类型均 **exit 0**。最终日志为 `evidence/repair-draft-guard-build.log`、`repair-draft-guard-tests-typecheck.log`，指纹见 `repair-final-build-result.json`。保留既有 chunk/sourcemap 提示，没有放宽检查。

## 4. 新的持久截图与日志

截图根：`/Users/kouzen/Library/Caches/mioon-mio-m2-repair-20261022/evidence/browser/`。本轮重建 **41 张 PNG**：原报告引用的 9 张 + 32 张四语、两尺寸、description/subtitle 原文的上下滚动截图。**18 项逻辑检查通过**；16 对文字截图中五条原文均完整可见，不能只以 DOM 中存在判断。取消授权保草稿两例通过。最低有效正文对比度 5.252，无小于 10px 正文/24px 点击区或本面板溢出。

原报告引用的截图均已在持久根重建：

| 状态 | 当前实际路径（相对截图根） |
| --- | --- |
| 运行 / 完成 / 审批 | `dark/zh-Hans-1440-running.png`、`dark/zh-Hans-1440-completed.png`、`dark/zh-Hans-1440-approval.png` |
| 冲突 | `matrix/zh-Hans-1440-conflict.png`、`dark/zh-Hans-1440-conflict.png` |
| 首次授权 | `authorization/zh-Hans-1050-authorization.png`、`authorization/en-1050-authorization.png` |
| 恢复 | `focused/zh-Hans-1050-retained.png`、`matrix/en-1050-unknown-image.png` |
| 原文可见 | `copy/en-1050-subtitle-copy.png` + `copy/en-1050-subtitle-copy-bottom.png`，以及同目录其他四语/两尺寸图片 |

每张实际加载的最终 JS/CSS URL 与字节哈希已核对，见 `browser/acceptance-summary.json`；最终 JS 为 `index-BTR-Qies.js`。主代理实际查看了最终授权、审批和原文上下截图；截图代理实际核看 14 张（含上述 9 张）并与重新导出的设计 PNG 对照。设计导出 10 张保存在 `evidence/design/`，源 `.pen` 指纹未变，没有读取其文本或修改设计。

这些是合成网关、真实领域工具生成的 Change 及明确 journal 状态 fixture 的显示验证，不冒充真实模型或自然崩溃恢复端到端测试；旧 157 张、两个中间截图轮次不计为最终通过。中间失败/过期构建在 `evidence/browser-round1/`、`evidence/browser-round2/` 明确保留。自有浏览器、服务和合成数据已关闭清理，最终浏览器记录 `closed:true`，没有触碰用户原生进程。

## 5. 收口与限制

最终活跃生产源码／测试与完整全量快照逐文件相同；收口只更新本报告。`evidence/final-validation.json` 记录最终 HEAD、原 main 状态、保护文件及 i18n 例外清单哈希和 `git diff --check` 结果。没有用修改例外清单放行中文字面量。

仅删除本轮创建的源码与依赖验证副本、最初的临时源码归档；原始三轮 TAP、事件、解析器、哈希清单、失败探针、截图、before/after 反例和最终工作树 overlay／构建产物归档均保留。清理收据为 `evidence/verification-copy-cleanup.json`，未清理真实工作树或用户资料。兼容性限制同第 3 节：两个精确 Node 守卫阻止的冻结备份验证没有完成，不作全量兼容已通过的承诺。

没有 commit、push、部署或发布；没有调用真实模型、真实付费图像/视频生成。M0/M1 报告、设计输入、package/lockfile 和原 main 的用户待办未改。原授权、持久 intent、未知结果不重发、网络策略、付费默认确认及不覆盖人工修改的执行规则保留；没有新增公共动作、schema 或迁移。

本阶段仍停在 M2，等待用户验收。M3、A1 分组和后续阶段没有实施。
