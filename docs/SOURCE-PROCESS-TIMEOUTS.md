# 源码启动、CLI 退出与外层测试时限

下方命令、时限观测与计数均属 2026-10-15 的执行记录；当前 `.test.ts` 测试及 `scripts/tooling.ts` 入口见 [TYPESCRIPT.md](TYPESCRIPT.md#current-test-migration-2026-10-26)。

日期：2026-10-15（Asia/Taipei）。基线：`75ad276034c5a2994fc368cc1b2c356e854cea47`。
分支：`codex/issue1-source-timeouts`。对应 [Issue #1](https://github.com/starroyhq/mioon/issues/1)。

## 结论与证据边界

本轮在 macOS arm64、Node 26.9.0、pnpm 11.25.0 上进行。Node 26 满足项目的 Node >=24 声明，但这些结果不能代替 Issue 中 Linux / Node 24.19、24.21 的历史证据。

历史后端 readiness 超时和 inspection CLI SIGKILL 尚未在本机稳定复现。已确认的独立缺陷是 Agent wire 测试 fixture 在异步启动期间关闭 / 断开 IPC 的竞态：关闭可能先于资源获取完成，且 `process.connected` 检查与实际 `process.send` 之间断连会产生未处理的 `EPIPE`。修复限于测试 fixture 的启动和清理，不将它声明为历史 12 秒超时的根因。

实际红例先在未修改的 `75ad276` fixture 上执行：发送 start 的 callback 中断开 IPC，后端 exit 1 / signal null，stderr 为未处理的 `write EPIPE`。新增的同路径回归在修复前为 1 fail / 0 pass、514.809458 ms；修复后正常退出 0。原 fixture SHA-256 为 `48ff409830efd38e7e47f48604de9294d89317e3e404e34a7cc3dd8656f0c94c`。这份早期输出未保存独立原始日志，已从工具转录整理成明确标注来源的事实摘要，未伪造原始日志。

首次 inspection 整文件运行另有一个可解释失败：215.948041 ms 时后端在 ready 前因 `STORAGE_PRIVATE_REQUIRED / SYMBOLIC_LINK` 退出，尚未进入 CLI。原因是 macOS `tmpdir()` 路径经过系统符号链接；测试改为在 `realpath(tmpdir())` 下创建合成目录，保留产品的私有存储校验。

## 三个时限分别判定

| 层 | 原有边界 | 失败含义 |
| --- | --- | --- |
| Agent wire 后端 | 从启动 IPC 到 ready 的 12 秒 deadline | 后端未在限定时间内确认 ready；需要区分源码加载、settings、server startup、ready IPC 和外层取消 |
| inspection CLI | 每次调用的 10 秒全进程 deadline | 必须正常 exit 且 stdio close；输出一个 JSON envelope 本身不足以证明进程退出 |
| 外层测试 | 各 `node:test` 场景自己的时限，例如 gain Stop 场景 30 秒、inspection 聚合 120 秒 | `TestContext.signal` 取消整个测试，必须保留原取消原因，并完成已拥有资源的清理 |

`scripts/tooling.mjs` / `executeCommand` 没有统一的测试总超时，只转发直接子进程的 SIGINT / SIGTERM 并保留退出码。Issue 中 full run 的退出 130 是被中断的终态，不能当作自然完成的测试汇总。嵌套测试与聚合报告中的同一个 CLI SIGKILL 也不能计为两次独立故障。

## 修改范围

- Agent fixture 在加载 server 之前安装 IPC / disconnect 处理；关闭等待正在获取的资源，再关闭 server、settings。IPC send 使用 callback 处理断连竞态，关闭后不发布迟到的 ready。
- 后端失败记录固定启动阶段与运行时信息，并在清理前冻结观测，保留原错误原因。没有改变 12 秒 readiness 限制。
- inspection CLI 将进程观测收敛到测试帮助器，分别记录启动、请求、响应头、JSON envelope、exit、stdio close。失败快照与清理 SIGKILL 分开，避免把恢复动作解释为原始原因。阶段通道只接受固定标签，不记录请求参数、原始输出、凭据或数据目录。
- 外层真实 `node:test` 超时回归验证原取消原因、owned child 回收，以及一个 disposer 失败时后续清理仍会完成。没有为应用增加强制 `process.exit`。
- UTF-8 文本监听库存随帮助器调整同步；另补登记基线中已有且正确配置解码器的 LUT、时间线图片和 JPEG 三处文件，每处两个监听。没有放宽库存或连续解码断言。

原 inspection 的正常退出、单 envelope、错误码、凭据保密、HTTP / CLI / MCP 一致性和只读断言均保留；未修改生产源码、依赖版本或 lockfile。

## 最小基线观测

以下都是独立的小探针，不是完整回归：

| 探针 | 重复结果 |
| --- | --- |
| 实际源码入口 `node apps/server/src/cli.mjs`，同一合成数据目录启动 / health / SIGTERM / close | 3/3 正常；ready 649、419、474 ms；close 687、431、495 ms；全部 exit 0 / signal null / readiness deadline 未触发 |
| 原 inspection CLI，离线 `schema` | 3/3 正常；close 197、188、193 ms；一个成功 envelope；exit 0 / signal null |
| 原 inspection CLI，合成 loopback `project.inspect` RPC | 3/3 正常；close 199、199、202 ms；一个成功 envelope；exit 0 / signal null |
| `local-tooling` 与 `test-compile-cache` | 初次及随后 5 次共 6 轮，每轮 40 pass / 0 fail / 0 cancelled；耗时 3415.125、3432.085、3479.003、3516.307、3569.101、3505.593 ms |

源码入口探针使用新建的 canonical 临时目录、合成 token、端口 0；只保留耗时、字节数和退出状态。没有打印 token 或实际数据目录。工作区依赖由 `pnpm install --offline --frozen-lockfile --ignore-scripts` 准备：397 个包均从本机 store 复用，未改变锁文件。

工具基线命令：

```sh
node --test --test-reporter=tap --test-concurrency=1 tests/local-tooling.test.mjs tests/test-compile-cache.test.mjs
```

macOS 上实际执行 `node scripts/tooling.mjs test --suite=full --concurrency=1 --file=inspection-wire.test.mjs --reporter=tap` 返回 **2 / NATIVE_TEST_LANE_BLOCKED**，未运行测试。这是原有平台边界，不计为通过或跳过。局部真实进程检查通过直接 Node 文件选择执行，没有绕过 full lane 的平台判断。

## 重复验证

最终冻结实现后的结果如下，全部自然退出；各行测试重叠，不相加为完整回归数量。

| 验证 | 结果 |
| --- | --- |
| 最终 8 文件受影响组合，缓存关闭 | **88 pass / 0 fail / 0 cancelled / 0 skipped**，exit 0 / signal null，42664.827375 ms |
| Agent fixture 生命周期最终版 | 连续 3 轮，每轮 **11/11** |
| Issue 原 gain Stop-request 触发场景，两个协议 | 连续 3 轮，每轮 **2/2**；此前实现版另有 5 轮每轮 2/2，仍未触发 readiness 超时 |
| inspection CLI 生命周期最终版，缓存关闭 | 连续 3 轮，每轮 **12/12**；schema 共 9 次 191–228 ms，RPC 共 9 次 200–213 ms，真实 CLI 均 exit 0 / signal null |
| inspection CLI 生命周期，自有缓存开启 | **12/12**；schema 3 次 164–229 ms，RPC 3 次 174–192 ms；实际观测 cache-active，缓存目录已移除。未宣称具体模块缓存命中 |
| 原 inspection 整文件 | **9/9**，24.94 秒；包含在最终 88 项组合中再次通过 |
| 真实外层 timeout 回归最终版 | 连续 5 轮，每轮 **2/2**；测试内故意超时的 runner 退出 1，外层断言确认原因和清理后通过 |
| 实际 portable tooling 入口、仅 local-tooling 文件、私有缓存开启 | **27/27**，1058.901833 ms；缓存 preparing / active / removed 完整 |
| 最终严格类型检查 | `node scripts/tooling.mjs typecheck`，exit 0 |
| 独立只读审查及四文件复核 | **29/29**，0 fail / cancelled / skipped；未发现阻断问题 |

最终组合命令：

```sh
node --test --test-reporter=tap --test-concurrency=1 \
  tests/agent-edit-wire-lifecycle.test.mjs \
  tests/inspection-wire-lifecycle.test.mjs \
  tests/node-test-outer-timeout.test.mjs \
  tests/inspection-wire.test.mjs \
  tests/local-tooling.test.mjs \
  tests/test-compile-cache.test.mjs \
  tests/transport-utf8-output.test.mjs \
  tests/process-timeout-diagnostics.test.mjs
node scripts/tooling.mjs typecheck
node scripts/tooling.mjs test --suite=portable --file=local-tooling.test.mjs --compile-cache --reporter=tap
```

gain 场景的最小选择为 `node --test --test-name-pattern='Stop during gain request' tests/agent-timeline-gain-wire.test.mjs`。它使用既有数据目录 fixture；在本机 macOS 重复时，driver 只把传入子进程的 `TMPDIR` 设为 `await realpath(tmpdir())`，不修改系统配置，不关闭产品的符号链接检查。最终 88 项组合也通过 `toolingEnvironment()` 的现有环境白名单启动，并使用 canonical `TMPDIR`。其余原始探针和重复运行均明确区分缓存状态。

本机证据保留在工作树 `.verification/issue1/`（按既有规则忽略，不提交缓存字节或测试数据）：`affected-final.tap` / `affected-final-outcome.json`、`backend-baseline-failure.json` / `backend-final-repeats.log`、`cli-first-inspection-failure.json` / `cli-final-repeat-{1,2,3}.tap` / `cli-final-cache-active.tap` / `cli-final-repeats.json`、`source-start-baseline.json`、`portable-tooling.tap` / `portable-tooling.stderr`、`typecheck-final.log`。两个早期失败文件是事实摘要，来源已标明；其余对应实际保存的最终输出。上述结果与限制同时保留在本说明中。

## 保留事项

本轮没有重跑完整回归，没有宣称 Linux / Node 24 的历史时序故障已解决。下一次出现历史问题时，应保存清理前的启动 / CLI 阶段快照、deadline 或外层取消来源、退出 / close 状态、缓存是否开启，以及自然退出的汇总。只有同一条件下的稳定证据才能继续归因；不能用增大超时、移除断言或反复全套试跑替代。
