# Electron 密钥库超时审查

以下正文保留原8c694d1同步实现的历史审查。当前9e归档、文档串写更正及后续macOS异步整合的证据身份见文末；本文旧行号和“当前worktree”均指当时的隔离审查环境。

审查日期：2026-10-10（UTC）。基线：`8c694d191e6c90379c32c9f8db0a778c35c31e14`。隔离分支：`codex/keychain-timeout-6415a02c`。

结论：**Images 后端默认 2 秒超时只结束等待，不会取消主进程已经开始的同步密钥库调用。注入同步阻塞时，主事件循环探针、排队退出请求和已启动的退出预算均无法推进。**这是本次可复现的既有控制流缺陷／设计限制，不是新引入的回归，也不是 macOS Keychain 原生复现。已有 [IMAGE-COMPATIBLE.md](IMAGE-COMPATIBLE.md#inherited-desktop-keychain-limitation) 和 [IMAGE-ACTIVATION.md](IMAGE-ACTIVATION.md) 已说明这一限制。

本次只新增本说明与 `tests/keychain-timeout-audit.test.mjs`，没有修改运行时或其他工作树。

## 导入安全与证明边界

执行前逐一读取并核对了 broker、codec、supervisor、shutdown、identity/security 模块及其导入；这些模块通过注入参数取得 safeStorage，不直接导入 Electron。未导入有启动副作用的 `main.mjs`、`backend.mjs`，未调用创建真实设置引擎或文件持久化的入口。

当前 worktree 没有安装依赖。测试从该 worktree 读取真实模块主体，以内存 data URL 加载，只替换明确列举的 import：

- 保留真实 Images broker/client、共享 secret codec、Images codec、BackendSupervisor、stopBackendForQuit 的控制流，以及真实 identity/security 实现。
- 业务 schema、错误构造和持久化依赖使用显式合成替身；明文校验仅接受一个固定测试字符串。未使用的 Agent settings、文件存储和目录校验入口调用即抛错。**没有执行真实 Zod/schema、业务持久化或完整设置流程。**
- data URL 模块的导入检查仅允许已审查的模块和所需 Node 内建模块，拒绝新增动态／副作用导入和未登记依赖；直接按文件加载的 identity.cjs 另有无 import／require 的断言。这些检查是当前已审查源码的变更探针，不是通用递归安全沙箱。不加载 Electron、child_process 或联网工具。导入与 codec 构造阶段的假 vault 调用数为零。
- 所有值均为新造内存数据；假加密仅用 Buffer 包装，不代表密码学验证，也不读写密钥文件、真实媒体或用户数据。

测试用一个 Worker 代表 main，用测试线程代表 utility，两者拥有独立事件循环，经消息适配调用真实 broker/client。同步假 safeStorage 用 SharedArrayBuffer 与 Atomics.wait 阻塞 Worker；实际客户端使用默认 2000 ms，没有缩短该期限。对照用例同步捕获真实请求的 setTimeout 参数并断言为 2000，以独立锁定默认值；墙钟下限只证明没有缩短等待，不设置易受调度影响的窄上限。共享状态证明调用已进入、尚未返回及主循环探针不再推进。阻塞有 8 秒安全上限，各阻塞测试有 12 秒总上限，清理始终先释放 gate，再终止本测试拥有的 Worker；不使用真实进程 PID。

Worker 发出 entered 后可能在进入 Atomics.wait 前被调度暂停。因此测试接受释放后返回 ok 或 not-equal（gate 已提前释放），明确拒绝 8 秒安全上限导致的 timed-out。结论依据释放前的共享状态与独立客户端超时，不单凭 Atomics.wait 返回 ok 判断。

10 ms 定时探针只测量 main 替身的 JavaScript 事件循环。**它不是 renderer 动画、Electron UI 心跳或原生窗口的测量。**已加载的 renderer 动画是否继续、具体交互是否受影响，本次均未执行。

## 已证明 bug：客户端超时不能约束主循环阻塞

触发条件是主线程调用的 status/encrypt/decrypt 同步函数长时间不返回。真实 Keychain 是否触发、持续多久不在本次证明范围内。

| 证明测试 | 实际观察 |
| --- | --- |
| 导入及 codec 构造 | 无 vault 调用；显式操作仅进入注入的假服务 |
| 默认期限与非阻塞 broker/client 对照 | 捕获真实请求 timer 参数，严格等于 2000 ms；真实调度和 codec 主体完成合成加解密，客户端可用性为 true |
| broker 在微任务执行前关闭 | 未开始的 vault 操作没有执行，也没有回包 |
| status 同步阻塞 | 客户端约 2001 ms 返回 IMAGE_SECRET_CODEC_TIMEOUT；调用仍阻塞，探针冻结，排队退出处理未进入 |
| encrypt 同步阻塞 | 客户端约 2002 ms 超时；同样观察到未返回、探针冻结和退出延迟 |
| decrypt 同步阻塞 | 客户端约 2001 ms 超时；同样观察到未返回、探针冻结和退出延迟 |
| 已启动的 supervisor 停止预算 | 使用注入的 20+20+20 ms 预算，实际客户端 2 秒期限到达时停止仍 pending，fake child.kill 尚未执行；释放后才继续停止 |

三个阻塞用例释放 gate 后，都检查了**同一个超时 requestId** 的迟到成功响应：客户端仍保持不可用，没有恢复原请求、发送取消或重新执行操作。排队退出随后通过真实 quit helper 和假 child 完成清理。

停止预算用例仅证明依赖同一事件循环的计时器不能抢占同步阻塞。释放后允许逾期终止与确认回调出现合法竞态；若先得到 BACKEND_STOP_UNCONFIRMED，则通过合成 owned-child exit 完成确认。没有向 OS 发送终止信号，没有声称生产 13 秒停止预算已做原生实测。

## 静态调用链与设计风险

以下行号均对应上述基线，运行时文件未改动。

| 位置 | 事实及边界 |
| --- | --- |
| `apps/desktop/src/image-secret-broker.mjs:104–117` | queueMicrotask 内同步调用 codec；微任务没有把工作移出主事件循环 |
| `apps/desktop/src/secret-store.mjs:19,41,53` | 直接调用 isEncryptionAvailable、encryptString、decryptString；外层 Promise 不会抢占它们 |
| `apps/desktop/src/image-secret-broker.mjs:127,132–140,169` | 默认 2 秒只删除客户端 pending 并 reject，迟到响应被忽略，没有传输级取消消息 |
| `apps/desktop/src/image-secret-broker.mjs:184–187` | crypto 先 status 再 encrypt/decrypt；2 秒是每条 wire request 的期限，不能描述为整个 crypto 操作的端到端 2 秒 |
| `packages/business/src/images/settings.mjs:112–123` | 另有 5 秒业务等待包装，不会停止 main 中已开始的同步函数 |
| `apps/desktop/src/supervisor.mjs:103–105`；`backend.mjs:35–37` | main 每 10 秒发 ping；utility 每 5 秒检查距最后 ping 是否超过 30 秒。长 main 阻塞可能令 utility 自行关闭；时间依赖上次 ping 和检查相位，不能说“阻塞恰好 30 秒必退出” |
| `apps/desktop/src/main.mjs:206–224,247–250`；`supervisor.mjs:173–185` | before-quit、停止调度和确认计时器也依赖 main。排队退出可能尚未进入；已进入的默认 10+2+1 秒停止预算也不是 main 卡住时的墙钟保证 |
| `apps/desktop/src/main.mjs:74–84`；`packages/business/src/agent/settings.mjs:80–85` | Agent 持久化初始化解密发生在创建／启动 supervisor 前，utility 启动 20 秒预算尚未开始 |
| `apps/desktop/src/secret-broker.mjs:96,117,148,158,203`；`packages/business/src/agent/settings.mjs:19–31,118` | Agent 是另一组期限：client 默认 10 秒，acquire 有取消消息、7 秒 broker 与 5 秒读取包装。main 的计时器和 abort 处理仍无法抢占同步调用；不得套用 Images 的 2 秒结论 |

基于这些接线，主进程依赖的交互、窗口生命周期和退出可能延迟；只停止 utility 不会停止 main 内的 vault 调用。30 秒 lease、Agent 启动和 Agent acquire 在此为静态风险分析，未做对应时长或原生动态验收。Agent put 超时后仍可能在底层返回后继续保存（`agent/settings.mjs:147–158`），属于既有结果未知／需重新读取语义；本次未执行持久化，也不将它误报成 Images 的迟到回包恢复。

已证明的保护仍有效：未开始的 broker 操作可在 close 后被阻止；迟到结果不会让超时客户端恢复可用。没有发现本次条件下的自动重试、自动降级明文或凭据回显；这不是完整安全审计结论。

## 目标 OS 未验证

- 未调用真实 macOS Keychain、Electron safeStorage、解锁／拒绝／授权弹窗；不知道原生调用在目标版本上的实际阻塞条件和时长。
- 未启动 Electron、renderer、utilityProcess 或应用；Worker 只用于分离事件循环，不代表原生进程或 UI 验收。
- 未执行生产 10 秒 heartbeat／30 秒 lease 的真实过期、应用强制退出、安装／签名／公证、Keychain 身份或既有密文兼容性验证。
- 其他 OS 的 vault 行为也未验证；不会据合成 `platform: 'darwin'` 参数宣称 macOS 通过。

## 最小修复边界

若目标是“密钥库卡住时 main 仍可响应和退出”，修复必须改变同步 vault 工作的执行位置或采用经目标 Electron/OS 验证的非阻塞执行方式。仅添加 Promise.race、AbortController、微任务、同线程队列或延长超时，都不能实现这个目标。

范围至少涵盖共享 secret-store 的 status/encrypt/decrypt、Images broker，以及直接由 main 持有的 Agent 初始化／读写路径。执行单元需由可响应的监督方限制并发、管理 deadline、拒绝关闭后的新请求、隔离迟到结果，并保留原有渠道与凭据绑定、不可用时拒绝持久化和显式 session-only 选择。不能用无限重试或杀 utility 代替取消 main 的调用。

在选择 Worker、utility 或独立 helper 前，必须验证目标 Electron API 是否支持该执行位置，以及原 app 身份、Keychain 权限和既有密文能否保持兼容；本次不预先指定某种实现一定可行。这是后续修复边界，不是本轮运行时修改或原生验证授权。

## 验证记录

使用现有 Node v26.9.0，在本 worktree 根目录执行：

```sh
env -u NODE_OPTIONS -u NODE_PATH node --check tests/keychain-timeout-audit.test.mjs
env -u NODE_OPTIONS -u NODE_PATH node --test --test-concurrency=1 tests/keychain-timeout-audit.test.mjs
```

最终测试代码实际执行 **7 项通过、0 失败、0 跳过、0 取消**，约 8.38 秒。诊断输出只有操作名、合成状态和计时，不含真实凭据。所有本次新增可运行用例都已执行；没有把导入失败当通过或跳过。

未运行依赖未安装的既有完整 settings/desktop 套件，也未安装依赖或绕入其他 worktree。未执行 build、packaging、应用、真实网络、Keychain 或文件持久化。新增测试仅作上述审查证明，不代表完整应用回归通过。

## 云端整合复验：2026-10-10

整合基线 `3ece477`，Linux Node `v24.19.0`：新增 **7 项、7 通过、0 失败、0 跳过**。这里仍使用原报告的 Worker 与明确假 vault/schema 依赖；云端已安装的业务依赖不会把这些替身验证变成原生密钥库或完整业务验收。Images/Agent 的密钥运行时代码没有在此切片改动。

这是同步设计的历史故障基线。未来正式采用异步 safeStorage 时，应将该组迁移为“旧基线独立复现 + 新异步行为不阻塞”的明确测试，不得为了绿灯弱化断言，也不得要求新运行时继续满足同步阻塞缺陷。macOS 用户提示、拒绝、旧密文互操作及实际正常退出仍需另行原生验证。

父级最终独立整合 full：3035 项、3033 通过、0 失败、2 项既有平台/权限跳过；此 Keychain 合成基线 7 项均通过，不意味着同步阻塞已经修复。


## 文档身份更正：2026-10-10

提交 `9e9598d` 中本文件正文被错误写为 Timeline 审查，还带入了 Timeline 的25项云端补验；这是云端整合文档串写，不是 Keychain 的运行结果。本次从完整 SHA-256 为 `0f96d8700f667252f3c678ac932f87b62e54661a5f7c0b6c1e1b9a62da597fab` 的原始 Mac 补丁恢复上面的正确 Keychain 正文，仅保留属于 Keychain 的7项云端追加结果。Timeline 报告与其25项结果仍保留在 [TIMELINE-RECOVERY-AUDIT.md](TIMELINE-RECOVERY-AUDIT.md)。

实际9e原审计测试 SHA-256 为 `c8da3aef5577cd47fb1e049ee5ac4a14f82220e6bb0f4ce732c00171cd6e8863`。本轮将原测试及8个精确依赖源码固定在 `tests/fixtures/keychain-sync-9e9598d.json`，由历史重放测试按原字节重建；7项历史同步缺陷复现不表示当前 macOS 仍应阻塞。当前异步正向测试与 Linux 保留的同步强 keyring 语义分别验收，见 [KEYCHAIN-ASYNC-CANDIDATE.md](KEYCHAIN-ASYNC-CANDIDATE.md)。
