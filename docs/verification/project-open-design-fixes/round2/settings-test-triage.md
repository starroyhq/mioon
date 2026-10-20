# 设置、原生桥接与传输夹具回归归类

本表保留本轮全量执行的归类过程；最终结果以文末独占复验和 `settings-test-results.json` 为准，不替代全量原始结果。所有复验使用真实路径 `TMPDIR=/private/tmp`，未修改内部测试时限、业务断言或生产依赖。

## 已完成的适配

| 文件 | 原因与处理 | 实际结果 |
| --- | --- | --- |
| `settings-design-panels.test.mjs` | 修复工作区旧轮询在保存 ACK 后回写旧值的真实竞态；读写 epoch + 不重叠轮询，覆盖隐藏/重开及保存失败重试 | 12/12 |
| `agent-timeline-app.test.ts` | 源码提取夹具漏注入 `lockedTrackIds`；补空集合并增加锁轨提示断言 | 3/3 |
| `cli-mcp-key-recovery-transport.test.ts` | 真实图片 review 准备新增工作区总开关准入；通过公共设置操作显式启用，网络适配仍拒绝所有真实 I/O，未批准付费请求 | 64/64 |
| `comfy-business.test.mjs` | 显式启用工作区总开关，保留原模拟连接器和 Comfy 自身准入 | 10/10 |
| `comfy-module-business.test.ts` | 共有夹具显式启用工作区总开关，模块缺失、原结果观察等断言保持 | 8/8 |
| `comfy-module-http.test.ts` | HTTP 夹具显式启用工作区总开关，权限与模块缺失断言保持 | 7/7 |
| `comfy-transports.test.ts` | 公共设置操作显式启用，生成仍只访问夹具拥有的 loopback 服务 | 2/2 |
| `custom-image-business.test.mjs` | 显式启用总开关，保留合成网关与原批准/历史回执断言 | 9/9 |
| `custom-image-transports.test.mjs` | 公共设置操作显式启用，保留原合成 DNS/TLS 双网关及密钥脱敏断言 | 12/12 |
| `image-activation-transports.test.mjs` | 公共设置操作显式启用，保留原官方 review、私有批准、未知结果与历史回执断言及合成网络 | 10/10 |
| `image-profile-discovery.test.mjs` | 仅准备 review 的单项显式启用总开关，其它纯发现用例保持零写入 | 失败单项定向 1/1，完整文件待最终汇总 |
| `desktop-agent-secrets.test.ts` | 精确白名单纳入已授权的单一 workspace native 通道与两个固定 preload 接口，扩大密钥泄漏扫描到新增 preload 叶模块 | 23/23 |
| `desktop-image-secrets.test.ts` | 同上，保留 utility 密钥所有权及严格通道白名单 | 17/17 |
| `desktop-security.test.ts` | 纳入单一固定通道；LUT 守卫提取终点改为新 native host 起点，原全部 LUT 权限断言保持 | 10/10 |
| `desktop-async-secrets.test.ts` | 严格模块清单纳入新 broker；新增计数拒绝的 workspace native schema 双重桩，断言执行次数为零 | 36/36 |
| `desktop-media-shutdown.test.mjs` | VM 注入新固定通道与实际 host 工厂 | 28/28 |
| `desktop-startup-restart-race.test.mjs` | 同上，原重启竞态与生命周期断言保持 | 27/27 |
| `desktop-window-ownership.test.mjs` | 同上，原窗口所有权断言保持 | 43/43 |

以上完整原始日志位于 `/private/tmp/mioon-round2-full-tests/reruns/`，分别以 `.fixture-fix.tap`、`.live-optin.tap`、`.native-fixture.tap` 结尾。`desktop-security` 使用 `.native-fixture-final.tap`；保留的首次日志包含旧提取边界失败。

`asset-disposition-transports.test.mjs` 曾临时按 JSON 规范化 expected 后执行通过，但该改动已撤回，**该次通过作废**。最终必须由原断言验证主代理补齐的 effects notes。

## 重型 wire 与媒体

- `agent-edit-wire.test.mjs` 初轮被外部 180 秒总预算截断；一次不设外部总预算的诊断复跑为 35/37，仅最初两项在内部 12 秒 readiness 边界失败，两项分别复跑均通过
- 获准使用每文件 600 秒外部总预算后，`agent-edit-wire.test.mjs` 完整 **37/37 通过，用时 301.29 秒**，内部 12 秒 readiness 和各项 30/45 秒预算均未修改。日志 `tests__agent-edit-wire.test.mjs.600s.tap`
- `agent-timeline-gain-wire.test.mjs` 初轮已完成 27 项通过后被 180 秒截断；600 秒重跑完整执行 37 项，为 **33/37，用时 369.34 秒**，4 项均在内部 12 秒 readiness 失败，需全量结束后独占完整复验；未记为通过
- `agent-timeline-move-wire.test.mjs` 初轮已完成 29 项通过、无单项失败后被 180 秒截断；等待全量结束后以 600 秒外部预算独占完整复验
- `agent-timeline-gain-media.test.mjs` 初轮仅在 readiness 失败；完整文件只有一个真实媒体用例，复跑 **1/1 通过，用时 50.82 秒**。工具输出对应执行会话 96138，摘要 `gain-media-rerun-summary.json`
- `image-generation-recovery.test.ts` 初轮已完成 18 项通过后被外部 180 秒截断，没有单项失败；`image-generation-transports.test.mjs` 初轮前四项通过，第五项在父用例内部 120 秒截止后取消。两者等待全量结束后独占复验，内部时限未改
- `inspection-wire-lifecycle.test.mjs` 的人工 300 毫秒子进程截止先于预设 trace 执行，正确观察到 `startup` 而非用例预期的后续阶段；定向原断言复验也有同类失败。`inspection-wire.test.mjs` 出现单次 CLI 10 秒 command 截止，等待独占复验；未扩大时限或改分类断言
- 使用相同子入口、隔离环境和临时 CPU profile 诊断，模块加载 1.16 秒、`startServer` 完成至 3.34 秒、退出码 0、stderr 空；CPU 样本主要落在 SQLite 历史 schema 迁移与校验。此诊断未将 readiness 超时自动判为通过

## 环境阻塞与分工

- `cli-v4.test.mjs`：真实 Mock 生成明确返回 `MOCK_RENDERER_UNSUPPORTED`，当前 FFmpeg 缺少 drawtext；后续版本数量和 revision 断言为前置生成失败的连锁结果，未修改断言或伪造媒体
- `export-settings-media.test.ts`：第一项字幕测量进入 `subtitle-media.ts` 的 drawtext 后报 `MEDIA_EXIT_FAILED`；本机 `ffmpeg -filters` 无 drawtext/subtitles，固定合成命令直接复核报 `No such filter: 'drawtext'`、退出码 8。第二项非字幕编码测试原轮通过，未改生产渲染或媒体断言
- schema 黄金及历史冻结依赖失败交 schema 代理；首页/入口及导出 UI 提取夹具失败交对应 UI 代理
- 未提交、未推送；私有设计文件未复制至验证目录

## 公共操作副作用复核

只读核查本轮 12 个 export/workspace/task 公共操作：schema、说明、effects、CLI/MCP 元数据与普通服务 handler 均已登记。普通 RPC 的数据库/文件/本地进程副作用统一进入备份修改门禁；`workspace.settings.set` 在 handler 独立检查；备份 create/stage 与固定二进制 import 进入同一排他队列。内置助理工具的既有清单未扩张为这些管理能力。

复核发现 `export.cancel` 可触发 worker 清理其 `.part` 与未发布输出，原 `fileWrite:false` 描述不准确；主代理已改为 `true`。门禁此前也由 `databaseWrite/localProcess` 命中。schema 代理在保留严格只读清单后补充取消的文件/进程副作用断言，`inspection-contracts.test.mjs` 完整 5/5 通过。

## 新增全量失败归类（执行中）

- `providers.test.mjs`、`mcp.test.ts`、`media-runtime-paths.test.ts`、`subject-video-provider.test.mjs`：真实 Mock 的成功或下载路径依赖 drawtext，直接错误或状态错误可追溯到 `MOCK_RENDERER_UNSUPPORTED`，不是工作区 live opt-in 夹具问题
- `subtitles-media.test.mjs`：三项真实字幕测量/渲染失败，当前 drawtext 缺失；取消清理及无字幕路径通过
- `look-pack-portability.test.ts`：Look 颜色路径依赖 `timeline-colour-lut.ts` 固定 zscale 图；本机同样缺 zscale。16×16 单帧合成命令明确报 `No such filter: 'zscale'`、退出码 8，lut3d 则存在。后续 current50/guarded51 schema 夹具由 schema 代理处理
- `subtitles-package.test.ts`：原命令 `tar --format=gnu` 被 `/usr/bin/tar` 拒绝，PATH 及 `/opt/homebrew/opt/gnu-tar/{bin/gtar,libexec/gnubin/tar}`、`/usr/local/bin/gtar` 均无已安装 GNU tar，未安装新依赖
- `mutation-wire.test.mjs`、`project-specifications-transports.test.mjs`：owned 后端 readiness 或既有 CLI 总期限失败，留待全量后独占复验
- `races.test.mjs`：三项命中既有 5 秒单项截止；`reference-recovery-business.test.mjs`：前 36 个子项通过后被外部 180 秒预算截断；`timeline-audio-continuous-runtime.test.ts`：仅 active-timeout 单项命中既有 10 秒截止；均未改内部时限或记为通过

纯基线副本已用 `git archive HEAD` 提取到 `/private/tmp/mioon-round2-baseline-40vsb6n8/source`，HEAD 为 `b8d6f4e7897d0d32aeb07749a6605637787de4f6`，756 个测试文件，不含 `designs/`。`CI=true pnpm install --frozen-lockfile --offline` 退出 0，复用 397 项、下载 0；原有依赖目录未改。待本轮全量结束再执行媒体路径对照。

`selected-range-transports.test.mjs` 的离线发现断言原先禁止任何 export cancellation operation，已按本轮授权真实 `export.cancel` 改为严格检查唯一操作名、仅 `projectId/exportId` UUID 输入、官方 MCP schema/annotation 和数据库/文件/本地进程副作用；外部 I/O 与付费生成仍为 false。定向发现项 1/1 通过，其余 5 项本轮原完整运行通过，尚未整文件重跑；日志 `tests__selected-range-transports.test.mjs.offline-cancel-final.tap`。

新增 `timeline-clip-loudness-transports.test.mjs` 仅第 6 项 CLI 被既有总期限 SIGKILL，其余 5 项通过，加入全量后独占复验；不改内部计时。

追加媒体范围：`timeline-colour-media.test.mjs` 3/8、`timeline-colour-worker.test.mjs` 3/7，失败进入固定 zscale 颜色链；后置 source-replacement 断言因更早的能力编码失败未能到达，属于同一前置阻塞的连锁结果。`timeline-export-range-media.test.mjs` 5/6，仅带字幕的三画幅项失败；`timeline-float-media.test.mjs` 4/5，仅带字幕的 float/range 项失败，均进入 drawtext。以上保留原断言，基线对照尚待执行。

PNG/JPEG 新增实际媒体阻塞与原全量计数：image-concurrency 7/9、image-filter 6/15、image-media 2/4、image-restored-render 0/1、jpeg-concurrency 4/6、jpeg-decode 2/5、jpeg-restored-render 0/1。失败全部进入静态图片/颜色转换图；PNG 图固定使用 zscale，JPEG decode 测试第 27 行也直接指定 zscale，当前不存在该滤镜。准入、预算、取消等不依赖完整转换的原用例仍通过。需基线同路径复核，未将环境阻塞记为通过。

`timeline-opacity-legacy-render-regression.test.mjs` 的历史 pin `812d18a9d493f01f94235bd4f424b4e17e742ad8` 实际保存 `timeline-media.mjs`，TS 迁移后夹具误按 `.ts` 读取而失败。已修历史路径，严格保留原 pin、原 SHA256 与源码 bytes，仅通过 resolve hook 将该历史模块的旧相对 `.mjs` 导入映射到当前 `.ts`。完整 1/1，通过 8 组旧40/41 graph/argv 比较，子进程尝试 0；日志 `.historical-path.tap`。

`docs/WORKSPACE-SETTINGS.md` 已与配置、调度/排他备份、恢复 activation、原生受限选择器和 HTTP 下载/导入实现核对，未发现需更正的事实错误。

`timeline-mcp.test.mjs` 实际 Mock 生成被 drawtext 缺失阻断；`timeline-media.test.mjs` 尚未进入媒体，既有后台 startup 10 秒截止，留待独占复验。

`timeline-preflight-business.test.mjs` 原全量 45/46；唯一失败在八格式真实 fixture 的第三项 `-c:v libwebp`。当前 FFmpeg 编码器列表没有 libwebp；16×16 单帧原生调用报 `Unknown encoder 'libwebp'`、退出码 8，尚未进入 preflight，单列为 WebP 编码能力环境阻塞。

`workspace-backup-contracts.test.ts` 与 `workspace-backup-inspection-transports.test.ts` 的旧断言禁止全部在线 backup create。已按授权新能力适配：保留任意路径 cold verify/restore 不公开，严格校验 managed create/stage 仅 UUID identity/确认参数及无路径、无外部 I/O/支付/进程副作用；官方 MCP schema/annotation 与共享定义完全一致。原 inspection 的鉴权、path拒绝与零DB写入仍保持。完整分别 5/5 与 2/2 通过，日志 `.managed-actions.tap`。

`version-comparison-media.test.mjs` 原全量 11/12；唯一生产 Mock 发布版本用例直接返回 `MOCK_RENDERER_UNSUPPORTED`，其余所有权、范围、认证与恢复拒绝等用例通过。

`workspace-preferences-http.test.mjs` 已精确纳入六个授权的 settings/managed-backup MCP 操作；仍禁止 renderer preferences、任意路径 cold backup/restore 与未登记操作，逐项确认严格schema不接受path/directory/projectId/preferences。完整 3/3 通过。

`workspace-frozen-evidence-v40.test.mjs` 初轮因 Node26.9 与原精确 Node24.21 pin 不同而拒绝加载。使用现有 `/private/tmp/mioon-tools/node-v24.21.0-darwin-arm64/bin/node` 完整复验 **74/74 通过**，未改 runtime pin 或测试内容；日志 `.node24-pin.tap`，不是用 Node24 重新运行全量。

`workspace-restore-integrity-source-guard.test.ts` 仅独立当前 TS 迁移审计中 LUT policy 项更新 type-erased bytes/hash（6899→6923，新增明确 schema51 只读准入），历史manifest、sourceCommit 与所有 legacy hash 不变；完整 **76/76** 通过，日志 `.lut51-current-audit.tap`。

## 纯 HEAD 媒体路径对照

已在隔离 HEAD `b8d6f4e` 副本完整运行 8 个受阻文件：providers 26/32、media-runtime-paths 0/1、subtitles-media 3/6、Look portability 0/1、PNG filter 6/15、JPEG decode 2/5、preflight business 45/46、subtitle-package 5/6。8 个文件的失败子项名称、总数与通过/失败计数均与工作树初始全量完全一致，均无外部超时。对应 drawtext、zscale、libwebp 与 BSD tar 环境能力限制，不是本轮新增回归；未将这些测试记为通过。

原始记录见 `baseline-media-results.json` 和 `media-environment.json`，完整日志在 `/private/tmp/mioon-round2-baseline-40vsb6n8/media-logs/`。独占 deadline 与重型复验逐文件结果见 `isolated-rerun-results.json`；整合结论见 `settings-test-results.json`，保留部分 pattern 与全文件范围区别。

## 最终独占完整复验

19 个文件全部完整运行完毕，18 个文件通过，1 个文件因已证实的 drawtext 环境能力受阻；没有待跑或仅 pattern 的最终记录。全部内部期限保持原值，外部每文件 600 秒仅防挂总预算。

| 文件 | 测试通过/总数 | 结论 |
| --- | --- | --- |
| `tests/races.test.mjs` | 9/9 | 通过 |
| `tests/inspection-wire-lifecycle.test.mjs` | 12/12 | 通过 |
| `tests/inspection-wire.test.mjs` | 9/9 | 通过 |
| `tests/timeline-audio-continuous-runtime.test.ts` | 11/11 | 通过 |
| `tests/mutation-wire.test.mjs` | 14/14 | 通过 |
| `tests/project-specifications-transports.test.mjs` | 3/3 | 通过 |
| `tests/timeline-clip-loudness-transports.test.mjs` | 6/6 | 通过 |
| `tests/image-profile-discovery.test.mjs` | 12/12 | 通过 |
| `tests/selected-range-transports.test.mjs` | 6/6 | 通过 |
| `tests/agent-timeline-gain-media.test.mjs` | 1/1 | 通过 |
| `tests/image-generation-transports.test.mjs` | 7/7 | 通过 |
| `tests/image-generation-recovery.test.ts` | 25/25 | 通过 |
| `tests/image-edit-lifecycle.test.mjs` | 38/38 | 通过 |
| `tests/inspection-business.test.mjs` | 60/60 | 通过 |
| `tests/local-delivery-business.test.mjs` | 28/28 | 通过 |
| `tests/reference-recovery-business.test.mjs` | 108/108 | 通过 |
| `tests/timeline-media.test.mjs` | 8/10 | Mock drawtext 环境阻塞；一个子项与父项失败 |
| `tests/agent-timeline-gain-wire.test.mjs` | 37/37 | 通过 |
| `tests/agent-timeline-move-wire.test.mjs` | 31/31 | 通过 |

工作区 race、两个备份/偏好公共发现夹具、历史 `.mjs` 读取、独立当前TS审计均已完成完整验证；两个先前仅 pattern 的文件现已整文件验证通过。负责的68个初始非零文件最终为42个通过、26个明确环境阻塞、0个未分类失败，另有主动补充的12项设置race回归。环境中的8条实际媒体路径在纯HEAD基线同样重现，失败名称及计数完全相同。未提交、未推送。
