# Mio harness H0 · 基线

日期：2026-10-27（Asia/Taipei）。基线提交：`ce89144cd695b6291cc7c60ba9d9e1595b16077a`，已包含 M7（PR #43）。

工作目录：`~/.codex/worktrees/mio-harness-h0/mioon`。原 checkout 的 `.idea/`、架构文档和其他本地文档保留。本阶段只新增测试、fixture、辅助和文档。

## 范围与前置

- 使用独立 worktree，依赖通过 `CI=true pnpm install --frozen-lockfile` 安装，锁文件没有修改。
- `docs/MIO-HARNESS.md` 从主 checkout 原样复制，SHA-256 为 `85352ce45a4dc54d7c2da03ae8a7ebf9f4fe43b95600bf7951ab7c5dc2bb7ffd`。
- 实施计划和提示位于主 checkout 的本地忽略目录 `designs/`，没有被 Git 带入 worktree；按原文件读取，不另行改写或纳入本阶段。
- 业务、契约、传输、界面和存储格式没有改动；没有真实模型请求或付费生成。

环境：Node `v26.12.0`，pnpm `11.25.0`，FFmpeg `9.0.2`，macOS。测试统一使用真实临时目录 `TMPDIR=/private/tmp`。证据保存在 `~/Library/Caches/mioon-harness-H0-2026-10-27/`。

## 请求指纹

新增：

- `tests/agent-task-request-fingerprints-v2.test.ts`。
- `tests/helpers/agent-task-request-fingerprints-v2.ts`。
- `tests/fixtures/agent-task-request-fingerprints-v2.json`。

三种协议各跑 16 个独立场景，共 48 组场景、87 次模型请求。原有 Ollama 的 42 组场景、75 条指纹及顺序保持不变，官方预设的 6 组场景、12 条指纹只追加到末尾。每次记录 `{scenario, protocol, index, bytes, sha256}`；哈希输入是 runtime 已落库的原始 `request.body`，没有解析后重排、归一化、替换 ID 或清洗正文。

| 场景 | 每种协议的请求数 | 关键断言 |
|---|---:|---|
| 单次回复（简中、繁中、English、日本語） | 各 1，共 4 | 四种语言指令与完整工具目录 |
| 读取与编辑往返 | 3 | 真实项目检查、镜头修改及 Change |
| 回复过程中补充说明 | 2 | 原请求不变，说明只进入下一请求 |
| 冲突、跳过与重规划 | 3 | 编辑占用阻断；跳过后再次修改被拒；原镜头不变 |
| 工具失败后重试 | 3 | 参数错误停止，重试请求包含失败，再由新计划完成修改 |
| 未知结果标记失败后继续 | 2 | 重启不重发；继续先被拒；显式 discard 后才有新请求 |
| 两轮历史与整轮裁剪 | 3 | 第三轮保留第二轮，第一轮整体裁掉 |
| 所选附件（English） | 1 | 真实私有附件文件、固定合法托管句柄与名称 |
| text 诊断 | 1 | 没有工具 |
| read_only 诊断 | 2 | 工具数量等于只读目录，执行检查但没有修改 |
| catalog 诊断 | 1 | 只提供选中工具，返回的修改调用也不执行 |
| 官方预设单次回复 | 1 | Chat Completions、Responses 使用项目默认 openai 预设；Anthropic Messages 使用 anthropic global 默认值 |
| 官方预设读取与编辑往返 | 3 | 同样的官方预设，经过真实项目检查、镜头修改及工具结果续接 |

确定性来自固定的种子项目、镜头、附件、调用 ID 和合成时间；Run、Step、控制请求仍使用真实随机 ID。真实 runtime、journal、领域工具、授权及控制机制均执行，仅模型 gateway 在启动前替换为合成实现。普通消息不能插入工具调用与结果之间；Anthropic 续接经过现有 `anthropicMessages` 校验。门闩等待设有 10 秒超时，测试文件上限 120 秒。

官方预设场景使用一次性合成会话凭据，通过真实 settings 的 `replace` / `session` 路径受理。网关仅断言凭据正确到达，并以不输出凭据值的断言检查请求正文、已落库请求原件和指纹记录不含凭据；fixture、日志和汇报不保存其值。凭据每次重新生成，两次独立运行仍须得到相同请求指纹。全部场景均使用合成网关，不访问官方模型服务。

显式更新命令：

```sh
TMPDIR=/private/tmp node tests/helpers/agent-task-request-fingerprints-v2.ts --update
```

首次创建 fixture 后，普通测试只比较，不写 fixture。当前 87 条 fixture SHA-256：`1813840e99f88c7bd245c62472ef9adec64ba894802d28457d11a9e4445a0de2`。原始 75 条版本的 SHA-256 为 `1581dbd9739d6246ebba058e51bd09a23a7ad60b67d35a987d44f9943cf22ecb`；补充官方预设时逐条核对原 75 条及其前缀字节不变，metadata 也不变。H1a 应保持当前 87 条全部一致；后续有意改变请求的阶段，先审查差异，再更新并说明原因。

## 长执行与容量测量

新增 `tests/helpers/agent-task-context-report.ts`，可直接运行或调用导出的 `collectAgentTaskContextReport()`。默认每协议使用新临时工作区，计划 14 次只读工具往返、最后一次总结；每次合成回复为 30 KiB ASCII 文本，以 3 KiB delta 连续输出，步数预算 30。三种协议模型配置都选取当前支持的 Ollama `qwen3:8b`，没有启动或连接 Ollama。

```sh
TMPDIR=/private/tmp node tests/helpers/agent-task-context-report.ts \
  --output=~/Library/Caches/mioon-harness-H0-2026-10-27/measurement-agent.json
```

可选参数：`--protocol=all|chat_completions|responses|anthropic_messages`、`--tool-rounds=1..14`、`--reply-bytes`、`--delta-bytes`、`--output`。H1/H2 前后比较需保留相同参数。

| 指标 | Chat Completions | Responses | Anthropic Messages |
|---|---:|---:|---:|
| 每次请求的工具数 | 98 | 98 | 98 |
| 请求 1 字节 | 125,665 | 124,400 | 122,872 |
| 请求 2 字节 | 156,852 | 155,716 | 154,084 |
| 请求 3 字节 | 188,039 | 187,032 | 185,296 |
| 请求 4 字节 | 219,226 | 218,348 | 216,508 |
| 请求 5 字节 | 250,413 | 249,664 | 247,720 |
| 模型步骤 1 的落库字节 | 230,046 | 228,706 | 226,662 |
| 模型步骤 2 的落库字节 | 292,585 | 291,523 | 289,257 |
| 模型步骤 3 的落库字节 | 355,063 | 354,279 | 351,791 |
| 模型步骤 4 的落库字节 | 417,541 | 417,035 | 414,325 |
| 模型步骤 5 的落库字节 | 480,019 | 479,791 | 476,859 |
| 本轮新增配额字节 | 2,428,656 | 2,425,320 | 2,412,248 |
| 本轮新增配额行 | 99 | 99 | 99 |
| 其中 Run / Step / Event 行 | 1 / 10 / 88 | 1 / 10 / 88 | 1 / 10 / 88 |
| 其中文本事件数 | 50 | 50 | 50 |
| 按剩余配额估算可再执行的同等负载轮数 | 109 | 109 | 110 |
| 结果 | failed / AGENT_CHAT_LIMIT | failed / AGENT_CHAT_LIMIT | failed / AGENT_CHAT_LIMIT |
| 已用步骤 / 预算 | 10 / 30 | 10 / 30 | 10 / 30 |

每轮在第 5 次模型请求及其只读工具完成后，构造第 6 次请求时触发历史上限；不是请求体 512 KiB 上限。报告保存了每个模型步骤的历史字节、正文大小、文本事件数及所有配额表的明细。

测量口径：

- 字节为 SQLite 实际 `data` 列的 UTF-8 保留字节，配额聚合复用生产 `readAgentTaskStorage()`。不包括页/WAL开销，也不是重复 UPDATE 的累计磁盘写入量。
- 容量按剩余字节、行数分别除以本轮增量后向下取整，取两者较小值。这里估算的是上述失败负载，不能解释为完整 30 步成功执行的容量保证。
- 当前 3 KiB delta 每次越过 2 KiB 刷写门槛，因此每条回复稳定产生 10 个文本事件。H2 的时间门槛可能受机器速度影响，报告明确记录输出节奏。
- 没有供应商 token 证据，`tokenUsage` 为 `null`。
- `measurement-agent.json` 与 `measurement-agent-repeat.json` 原始字符串一致。
- 另外以 `--reply-bytes=1024 --delta-bytes=1024` 跑成功路径，三协议均完成 15 次模型请求、29 步，结果为 `completed`；证据为 `measurement-small.json`。

## 验证记录

| 命令 / 检查 | 结果 | 证据 |
|---|---|---|
| `CI=true pnpm install --frozen-lockfile` | exit 0；472 个已有锁定包，锁文件未变 | 开工工具输出 |
| `TMPDIR=/private/tmp node --test --test-reporter=tap --test-timeout=120000 tests/agent-task-request-fingerprints-v2.test.ts`，连续两次 | 两次均 exit 0；每次 42 组场景、75 条请求全部匹配；每次 1 个聚合测试通过，无失败或跳过 | `fingerprints-final1.tap`、`fingerprints-final2.tap` |
| `TMPDIR=/private/tmp node scripts/tooling.ts typecheck` | exit 0；三个严格项目均通过 | `typecheck-final.log`（成功时没有正文输出） |
| `TMPDIR=/private/tmp node scripts/tooling.ts build --channel=development` | exit 0；Web 与 Desktop development 构建完成，有既有大 chunk 警告 | `build-development.log` |
| 默认测量辅助，连续两次 | exit 0；两个报告字节相同 | `measurement-agent.json`、`measurement-agent-repeat.json` |
| 测量辅助，小回复负载 | exit 0；三协议成功路径均完成，并额外断言 15 请求、29 步 | `measurement-small.json` |
| 架构文件与主 checkout 的 `cmp` | exit 0，内容原样保留 | 上述 SHA-256 |
| 六个新增文件逐个执行 `git diff --no-index --check /dev/null <file>` | 没有空白错误；no-index 表示文件新增的 exit 1 不视为空白错误 | 收尾工具输出 |
| `git diff --exit-code HEAD -- apps packages scripts pnpm-lock.yaml package.json` | exit 0，生产代码、依赖声明与锁文件未变 | 收尾工具输出 |

初稿类型检查曾因新指纹辅助的 `gateway ↔ runtime` 闭包造成循环类型推断而失败；已补充明确的 `TaskGateway` 和 runtime 返回类型，未使用 `any` 或忽略指令。首次全量执行中的 `typecheck-runtime.test.ts` 同样受到这份初稿影响，不能列为 main 已有失败。全量队列结束后独占复跑该文件，5/5 通过、exit 0，证据为 `typecheck-runtime-final.tap`，首次失败记录仍保留。

全量基线冻结当前 main 的 910 个 tracked 测试文件，排除本阶段新增测试；运行目录包含 H0 新增文件，生产代码与基线提交逐字节一致。既有 macOS full lane 会拒绝，且 runner 没有逐文件超时，因此使用证据目录内的驱动，复用既有 `toolingEnvironment()` 与 exclusive 列表：

```sh
TMPDIR=/private/tmp node ~/Library/Caches/mioon-harness-H0-2026-10-27/baseline-runner.mjs
TMPDIR=/private/tmp node ~/Library/Caches/mioon-harness-H0-2026-10-27/baseline-resume-runner.mjs
```

每文件独立 Node 进程，先完成 15 个 exclusive 文件，再以并发 2 完成 576 个文件。为缩短剩余等待，保存 checkpoint 后仅停止本次专用驱动和两个未完成测试组，剩余 319 个文件改为并发 4；中断的 `source-range-transports.test.ts`、`source-ranges.test.ts` 已在剩余队列重跑，未完成的尝试不计入有效结果。原始证据没有覆盖。选择和切换细节见 `baseline-selection.json`、`baseline-switch-checkpoint.json`、`baseline-resume-metadata.json`。

最终有效结果：**910 个文件，873 通过、37 未通过（含 6 个超时），无遗漏、无重复。** 首次汇总为 872 通过、38 未通过；有效汇总应用了上述 `typecheck-runtime` 5/5 通过的独占复跑结果，保留原始汇总与失败事实。报告末尾完整计数的 TAP 合计 14,175 项：14,078 通过、75 失败、22 跳过；6 个超时文件缺少末尾计数，因此这些测试项计数不覆盖超时文件内的全部用例。

| 未通过原因 | 文件数 | 归因范围 |
|---|---:|---|
| 缺少 drawtext、Mock 或字幕渲染所需能力 | 13 | 有明确错误代码或能力证据 |
| `MEDIA_EXIT_FAILED` | 7 | 具体根因尚未归因 |
| 文件超时 | 6 | 原因尚未归因 |
| 固定 Node 24.21.0 的版本断言 | 2 | 本机运行 Node 26.12.0 |
| 系统 tar 不支持 GNU 格式 | 1 | 本机工具差异 |
| 5173 端口占用 | 1 | 保留既有服务，没有停止它 |
| 其他状态、结果或进程回收断言 | 7 | 尚未归因，不统称环境问题 |

6 个超时文件为 `local-shot-text-process-recovery.test.ts`、`local-shot-text-render.test.ts`、`opacity-upgrade-database.test.ts`、`opacity-workspace-upgrade-faults.test.ts`、`opacity-workspace-upgrade.test.ts`、`project-entry-dialog.test.ts`。驱动在 300 秒发出终止，但部分原段进程或管道收尾实际更久；日志记录真实时长，不能视为严格 300 秒墙钟上限。续跑增加了仅跟踪本次已核实测试后代的收尾 guard，实际没有触发干预。驱动、guard 和最终复跑均已结束。

现有 harness 的 `agent-task-runtime-v2.test.ts` 有两个失败观察：`whole undo retains the generated shot owner while reverting earlier edits and preserving products across restart and replay`、`retained shot keeps a late product without selecting it and never dispatches after reversion`。后续阶段应逐测试名对比，不能仅比较失败文件总数。

完整证据：

- `baseline-effective-summary.json`：最终有效结果和复跑处理。
- `baseline-results.json`、`baseline-failures.json`：首次完整执行结果。
- `baseline-failure-classification.json`：全部 37 个未通过文件、具体测试名、分类和日志位置。
- `baseline-progress.ndjson`、`baseline-resume-progress.ndjson` 与对应 TAP 目录：逐文件结果。
- `baseline-process-completion.json`：本次验证进程结束情况。

H0 的新增测试、两次指纹稳定性、测量辅助、严格类型检查与开发构建均通过。上述全量未通过项作为当前生产源码的本机基线保留，本阶段没有修改生产代码来消除这些失败。

## 兼容与下一阶段

没有修改既有生产代码、旧执行记录、请求原件、工作区版本、恢复规则或 CLI 调用方式。既有 reviewed-live-sources pin 和生成 schema 没有更新；请求 fixture 是 H0 首次新增。

本阶段完成后停在 H0。H1a 应以包含官方预设的 87 条原始请求指纹为门槛抽取上下文装配器，保持请求逐字节一致。

## 后续修复与复验（2026-10-27）

用户在 H0 汇报后要求修复。本次针对上述 37 个未通过文件，不进入 H1a；原始基线、失败分类、超时记录及全部日志均保留。最终 **37/37 文件、934/934 测试通过，0 失败、0 取消、0 跳过**。这是原失败集合的针对性复验，没有重新执行全部 910 个文件，不能将其写成同一环境中的全量通过记录。

### 代码修复

只修改 `tests/dev-proxy.test.ts`：

- 后端使用系统分配的空闲端口。
- Vite 测试先预留系统分配的端口，再将真实 `vite.config.ts` 中的端口、后端地址和模块定位替换为测试地址；每处替换都有原始片段与次数断言。
- 登录、RPC、恶意 Origin、恶意 Host、后端拒绝 Vite Origin、真实页面检查全部保留，实际边界中间件和代理逻辑仍来自生产配置。
- 测试结束清理两个服务和临时目录；既有 5173 服务保持运行。

该文件在 Node 24.21.0、26.12.0 下各自独立通过。生产代码、工作区格式、依赖声明与锁文件均未修改。

开发代理测试修复独立于 H0 的请求指纹与容量基线，按审查要求另行提交。

### 环境与超时根因

| 问题集合 | 文件数 | 复验结果 | 处理方式 |
|---|---:|---:|---|
| 开发代理端口冲突 | 1 | 1/1 | 上述测试夹具隔离端口 |
| 固定 Node 版本与 GNU tar | 3 | 209/209 | 使用已有缓存 Node 24.21.0 和已安装 GNU tar 1.35；原冻结版本断言不变 |
| 原文件级超时 | 6 | 163/163 | 原断言和文件哈希不变，逐文件有界复跑；宿主电源日志确认原失败期间合盖与维护睡眠，475s、910s、733s 睡眠与对应异常时段重合 |
| 媒体进程回收 | 1 | 15/15 | 原测试在 Node 26、24 下分别独立通过；没有更改回收窗口、未知关闭门禁或断言 |
| 媒体、Mock、Agent 撤销、调色与恢复渲染 | 26 | 546/546 | 用已有隔离 Linux 完整 FFmpeg 工具链执行当前源码和当前锁定依赖 |

本机 Homebrew FFmpeg 9.0.2 缺少 `drawtext`、`subtitles`、`zscale` 和 `libwebp`。其中 `zscale` 缺失解释了原先未归因的 PNG/JPEG/调色执行错误，`libwebp` 缺失影响预检的 WebP fixture。补齐能力的隔离环境使全部 26 个媒体文件通过，包括原 `agent-task-runtime-v2` 的两个撤销失败（176/176）、`subject-video-provider`（127/127）、`timeline-preflight-business`（46/46）、Look 可移植性及两类恢复渲染。没有为消除这些失败修改业务行为或降低能力检查。

### 工具链与复现

原生复验使用已有 Node：`~/.npm/_npx/538786c08bcb9442/node_modules/node/bin/node`；GNU tar 目录：`/opt/homebrew/opt/gnu-tar/libexec/gnubin`。例如：

```sh
PATH=~/.npm/_npx/538786c08bcb9442/node_modules/node/bin:/opt/homebrew/opt/gnu-tar/libexec/gnubin:$PATH \
TMPDIR=/private/tmp \
~/.npm/_npx/538786c08bcb9442/node_modules/node/bin/node \
  --test --test-reporter=tap tests/dev-proxy.test.ts
```

媒体复验使用本机已有不可变镜像 `sha256:32fc444b18573b988300b1bb9ceb7009ae4d9cb2456c382a0353b0c521846de5`：Linux arm64、Node 24.21.0、完整 FFmpeg/ffprobe `n7.1.5-12-g1fdbca85aa-20260731`、GNU tar 1.34。每文件独立容器，非 root（1000:1000）、`network none`、600 秒超时、并发 2；主 `.git` 只读挂载用于冻结源码读取。

旧 Linux 依赖锁与当前不匹配，因此没有复用旧 `node_modules`。在本次私有 cache 的源码副本中按当前 lock 完成 frozen 安装，558 项供应链检查通过，未调整策略；测试期间断网。仅跳过 Electron binary 下载，因此这是源测试验证，不属于原生 Electron 或发布验收。当前 lock SHA-256 仍为 `1f01209b29290b248b96045912aa4fb70d10beb32139de496047d4217163fb42`。

主代理逐字节比较了隔离副本与当前 worktree 的 2,337 个 tracked 代码与测试文件，0 差异；快照摘要为 `acd8c5ed7dbd52fb1045dd84c44ee77688544084243721b212cf24657dc28c99`。没有改系统默认 Node、FFmpeg、tar 或现有服务。测试生命周期内使用的 `caffeinate -i`、专用测试进程和容器均已结束。

修复证据目录：`~/Library/Caches/mioon-harness-fixes-2026-10-27/`。

- `repair-summary.json`：主代理核对原 37 文件集合无遗漏、无重复，以及 934 项全部通过的汇总。
- `portability-dev-proxy-final.tap`、`portability-dev-proxy-node26.tap`：端口修复在两个 Node 版本下的结果。
- `toolchain-node-tar-results.json`：三个固定工具链文件的结果。
- `timeouts-cause-summary.json`、`timeouts-host-power-observation.json`、`timeouts-rerun-results.json`：睡眠关联证据与原样复跑。
- `media-runtime-bounds-final.tap`：Node 24 下的 15 项回收检查。
- `docker-media-results.json`、`docker-*.test.ts.tap`：26 文件结果、具体命令和日志。
- `docker-frozen-install-result.json`、`docker-dependency-lock-comparison.json`：锁定依赖安装与旧锁拒绝复用的依据。
- `typecheck.log`：修复后 `node scripts/tooling.ts typecheck`，exit 0。

本次没有变更运行时代码，开发构建沿用 H0 已通过的结果。`git diff --check` 通过；原请求指纹 fixture 和 reviewed-live-sources pin 未修改。后续阶段复用隔离执行入口前，必须重新同步待验收分支源码并核对锁与快照，不能直接把本次 cache 副本的结果当成新分支的验证。

## H0 审查补充：官方预设（2026-10-27）

只补充官方预设的单次回复、读取加编辑往返：Chat Completions 与 Responses 使用项目默认 openai 配置；Anthropic Messages 使用 anthropic global 默认配置。每种协议新增 1 + 3 条，共追加 12 条，合计 48 组场景、87 条指纹。原有 75 条对象、顺序、原始前缀字节以及 fixture metadata 全部保持不变；没有改写旧指纹。

会话凭据仅通过真实 settings 的 session 路径注入合成网关，不写入 fixture、日志或本报告。执行过程断言凭据正确到达网关，同时断言其不在正文、保存请求和指纹记录中。没有真实模型调用。

审查补充的证据位于 `~/Library/Caches/mioon-harness-H0-review-2026-10-27/`：

| 验证 | 结果 | 证据 |
|---|---|---|
| 显式更新 fixture，再核对旧记录 | 仅追加 12 条；原 75 条及前缀字节不变 | `fingerprints-before.json`、`fingerprints-append-check.json` |
| `TMPDIR=/private/tmp node --test --test-reporter=tap --test-timeout=120000 tests/agent-task-request-fingerprints-v2.test.ts` 连续两次（Node 24.21.0） | 两次 exit 0；每次 87 条全部匹配，0 失败、0 跳过 | `fingerprints-run1.tap`、`fingerprints-run2.tap` |
| `TMPDIR=/private/tmp node scripts/tooling.ts typecheck`（Node 24.21.0） | exit 0；三个严格项目通过 | `typecheck.log` |

当前 fixture SHA-256：`1813840e99f88c7bd245c62472ef9adec64ba894802d28457d11a9e4445a0de2`。H0 的基础设施和本次官方预设补充共同作为一个提交；开发代理测试使用独立提交。本次仍停在 H0。
