# Keychain async 受控候选

日期：2026-10-10（UTC）。基线：`8c694d191e6c90379c32c9f8db0a778c35c31e14`。
原 Mac 分支：`codex/keychain-async-candidate-93c86f1a`。下方原 Mac 35项结果归属于该候选。云端在 `9e9598d887b21b8e1b7dc742e5d15c66a3ff93d4` 上整合并保留 Linux 兼容路径；当前云端聚焦门、fresh build 与 Linux 原生重开回归已通过，父级独立 full 已通过（3099总/3097通过/0失败/2跳过）；分项证据见下文，不以旧 Mac 结果代替。未提交或发布。

## 改动与范围

沿用已锁定的 Electron 44.7.0，在现有 main 身份下调用官方
`isAsyncEncryptionAvailable`、`encryptStringAsync`、`decryptStringAsync`。
macOS 路径不调用同步状态/加解密 API，失败也不回退同步；不增加 helper、依赖、弱加密或明文回退。
Linux 按可信平台静态选型保留原同步强 keyring 路径，不进入 macOS 的共享状态/失败锁存。

原候选修改以下六个生产文件；云端额外提取一个 Linux 平台模块：

| 文件 | 必要性 |
| --- | --- |
| `apps/desktop/src/secret-store-linux.mjs` | 保留 Linux 同步四类强 keyring、原密文包装与动态可用性检查，增加关闭/归属结果围栏；不提供同步不阻塞保证。 |
| `apps/desktop/src/secret-store.mjs` | 共享 async 适配器、实际加解密探针、期限、原生在途上限、局部取消与全库故障隔离；保持 channel 包装与公开错误。 |
| `apps/desktop/src/image-secret-store.mjs` | 等待共享 codec，传递 signal/owner，继续验证两个 Images namespace/profile，正确提取异步解密结果。 |
| `apps/desktop/src/image-secret-broker.mjs` | 有界 await，私有 deadline/cancel，关闭及 utility 归属复核，逻辑请求清理；client 拒绝过期响应及过期 availability。 |
| `apps/desktop/src/secret-broker.mjs` | Agent get/put/acquire 统一传递取消和原始期限，在返回与缓存前复核；client 拒绝计时器尚未执行时到达的过期响应。 |
| `apps/desktop/src/main.mjs` | 仅把 `startup.signal` 接到 Agent 初始化，避免启动取消仍等待原生解密。 |
| `packages/business/src/agent/settings.mjs` | 异步刷新能力、初始化/读取/加密有界等待、排队和保存前检查、close 撤销未保存工作并等待已开始的保存。 |

附带 `tests/desktop-async-secrets.test.mjs` 和三个旧测试文件的 async fixture/断言适配。
云端将成功、跨 channel、持久化、旧密文与双 Images 槽位用例分别在 `linux`/`darwin` 合成路径执行；保留 Linux 弱后端拒绝、动态恢复及 session-only 用例。
实际 payload 加密失败测试放行探针，继续核对旧磁盘字节、revision、configuration 与 secret 不变。

## 可用性、容量与恢复

- macOS 每次 codec 操作先等待 async status，再对随机非秘密字符串加密、解密并核对结果。
  status=true 本身不能证明存在可用 key。该探针验证加解密可用性，不检测密码学强度，
  也不证明系统此刻重新授权；强度与 provider 的适用性依赖受控 macOS 原生实现。
- macOS 每个 codec 操作（含探针和该次实际加/解密）共享 **1500 ms** 单调时钟预算。
  测试可注入更短预算；不能扩大生产上限。Agent 的 refresh 与 encrypt/decrypt 是独立操作，
  整个设置调用不承诺在 1500 ms 内结束。业务层另有 5 秒等待上限。
- macOS 一个 `safeStorage` 对象共用 WeakMap 状态，最多 **16 个在途操作**；每个操作最多同时等待
  一个 native Promise。Agent、Images、重建 codec/broker 和 utility 重启都不能绕过该上限。
  外层超时、取消或关闭立即停止调用方等待，但槽位只在实际 native Promise settle 后释放。
- 局部取消、失去 owner、容量拒绝和坏密文不递增共享 epoch，也不禁用其他健康 owner。
  只有仍有效请求的初始化/探针/加密失败或 codec 期限到达可锁存全库失败。
  迟到的成功或拒绝均不得恢复或禁用新的有效状态；失效 native 回调仅释放自己的槽位。
- 真正全库失败锁存后，同进程不无限重试，也不通过新 codec 清除故障。
  Electron 缓存 initializer，没有公开的强制重新取钥 API。重启应用可重新尝试，
  单独重启 utility 不能重置 main 的缓存；重启不是保证恢复。首次系统授权交互若慢于1500ms预算，即使用户随后允许，本进程也可能继续显示持久化不可用，需要完整重启后再尝试。异步保证JS事件循环仍可调度，不代表无需等待或可任意重试。
- 原 Mac 候选曾关闭所有非 darwin 平台持久化；云端未接受这一 Linux 支持收缩。当前静态 Linux 路径继续仅允许 `gnome_libsecret`、`kwallet`、`kwallet5`、`kwallet6`，拒绝 `basic_text`、未知/缺失后端；旧密文可读，availability 恢复按原同步策略重新检查，不自动改写或降级持久密钥。该路径仍可能同步阻塞，超时不能抢占；不声称 Linux 已获此次非阻塞修复。
- Windows/其他平台依然关闭持久凭据能力；Windows 私有存储 ACL 总门仍阻止正常启动。平台选择来自 main 的可信运行时，不接受 renderer/配置指定，不存在 macOS失败后选择Linux的回退。

外层 `{version:1,appId,plaintext}`、原 base64/长度限制、Images namespace/profile、Agent
binding 与既有公开错误码保持。`shouldReEncrypt` 只按官方返回类型检查，不触发读时重加密
或自动迁移。fake vault 证明包装和绑定逻辑，不证明真实旧 Keychain 密文兼容。

## 私有 IPC 和保存边界

两个私有 request envelope 增加可选绝对 `deadline`，现有 client 每次都发送。
Images 增加固定 `image-secret-codec-cancel`；Agent 沿用 `agent-credential-cancel`，
扩展到 get/put。版本仍为 1，旧的无 deadline 请求在 main 获得默认期限。
main 期限取 client deadline 与本地上限的较小值：Images 2 秒，Agent 7 秒；client 默认
分别为 2 秒和 10 秒。这些是本地等待/后续动作边界，不是原生取消 API。
更改仅发生在已有可信 utility 通道，未增加 renderer 权限或公开 HTTP/MCP/CLI/schema。

Agent put 在入队执行、异步刷新/加密完成及 `persistence.save` 开始前检查 signal、owner
和原始期限。因此取消后的迟到密文不能开始保存，也不能覆盖当前 revision/session。
**原子 save 一旦开始，取消不能撤销它**；完成后仍同步更新 RAM，close 等待该保存结束。
已超期或关闭的 broker 不发送或缓存迟到成功。这一窗口中的调用方结果可能未知，必须重新
读取设置/revision 后决定下一步，不能把 timeout 解释成“磁盘肯定未写”。没有新增事务取消保证。

## 原 Mac 候选验证（历史）

环境为现有 Node **v26.9.0**。在本候选 worktree 根目录执行：

```sh
env -u NODE_OPTIONS -u NODE_PATH node --test --test-concurrency=1 tests/desktop-async-secrets.test.mjs
```

结果：**35 tests，35 pass，0 fail，0 cancelled，0 skipped**。
包括两个共享状态 P2 的回归；真实 payload 加解密错误；16 槽位跨重建；原生 gate 挂起时 JS
事件循环可运行；client/broker/owner/engine/startup 取消；原始期限；排队取消；已开始保存的
RAM/持久状态配对和 close 等待；utility 替换；双方 client 的过期响应拒绝。
broker-close/owner 用例在 client deadline 之前放行 native gate 并断言不保存，不依赖客户端
超时兜底；startup abort 在同一事件循环 turn 结束时已完成，不依赖 1500 ms 超时。

在原 29 项之外新增 6 项，实际覆盖默认 2000 ms、构造零调用与 Images 完整异步往返、
Images 微任务前关闭零调用，以及 status/实际 payload encrypt/实际 payload decrypt 三阶段
挂起时的定时探针、queued quit 和真实 supervisor 主体的合成 child 停止预算，详见下面对应表。

这 35 项只使用 Node 内置模块、注入的异步合成 AES vault、内存持久层与 EventEmitter。
测试仅重写白名单源码的 import 路径，执行真实 codec/broker/Agent settings/config/supervisor/quit helper。
Images plaintext validator 明确为两个字符串的 fixture，文件工厂禁止访问持久层；因此不能
据此声称真实 Zod/profile 校验、文件权限/原子保存或 Electron/Keychain 验收通过。
fixture 的同步 vault API 会抛错，用于证明生产适配器只走 async API。

另尝试以下旧套件的正常入口：

```sh
env -u NODE_OPTIONS -u NODE_PATH node --test --test-concurrency=1 tests/desktop-agent-secrets.test.mjs tests/desktop-image-secrets.test.mjs tests/desktop-custom-image-secrets.test.mjs
```

退出 **1**；三个测试文件均在模块导入阶段因缺少 `@mioon/business` 或 `@mioon/contracts`
报 `ERR_MODULE_NOT_FOUND`，**0 pass / 3 file failures**，内部用例未执行。
未安装、借用或替代 workspace/Zod 依赖，未通过 skip 掩盖阻塞。依赖齐备后仍需执行这三个
真实契约/持久化套件。十个变更 `.mjs` 文件的 `node --check` 与 `git diff --check` 通过。
独立子代理最后只读复核未发现新的明确阻塞缺陷；不是完整回归或原生验证。

## 历史同步审查测试对应与云端入口迁移（2026-10-10 UTC）

协调者报告云端下一轮审查 **51/51** 通过，其中包含此前 Mac 未运行的 14 项 SQLite/durable
Undo/Redo。本轮没有独立执行该云端批次，也不将该结果计入候选的 35 项。
`tests/keychain-timeout-audit.test.mjs` 在候选基线 `8c694d1` 的 Git tree 中不存在，当时的原 Mac 候选
工作树也未添加它。只读核对的原件位于原 Mac 隔离工作树的 `tests/keychain-timeout-audit.test.mjs`，
旧树 HEAD 同为 `8c694d1`，该文件为未跟踪文件；SHA-256 为
`04a29eb424b5a5009ed185d64db92e32e5ae97a0bc9d600cfef6538e87c35600`。
旧文件与旧工作树保持原样。原 Mac 当次补充仅修改本文及 `desktop-async-secrets.test.mjs`，
六个生产文件、三个旧测试文件、main 和全部 Git 基线未变。

历史文件是 **7 项同步缺陷复现**：3 项控制检查、status/encrypt/decrypt 三项阻塞复现和
1 项停止预算复现。它的 sync-only fake 与“必须阻塞”的断言不能原样用作 async 发布标准。
候选对缺少 async 方法的 fake 提前拒绝，只证明失败关闭，不证明调用进入后主循环仍可响应。
原 29 项缺少的针对性证明现已通过新增 6 项补齐。旧的停止预算证明在三阶段各验证一次，
因此不以一对一测试数量相等作为覆盖判断。以下均为实际通过的合成测试，未改历史断言：

| 历史断言（原文件行号） | 新测试（名称前缀） | 实际断言 |
| --- | --- | --- |
| 150–156：导入/构造不触发 vault，显式操作往返成功 | `audited imports and codec construction` | 构造后 vault 调用数为 0；import 白名单排除 main/backend；真实 Images client→broker→codec 异步往返成功，三类 async 调用均发生。 |
| 159–187：真实 client 默认 2000 ms，正常往返 | `Images client directly arms its 2000ms default`，及上一项 | 不传 timeout，直接捕获真实 timer 参数 2000，立即恢复全局 timer，再等待静默端口的真实 TIMEOUT；耗时不少于 1900 ms，取消携带原 ID，迟到状态回复不能恢复 availability。 |
| 191–198：broker 微任务前 close，零调用/零回包 | `Images broker close before its microtask` | 使用具备三项 async 方法的 fake，handle 后立即 close，下一事件循环 turn 的 native 调用和回包均为 0。 |
| 243–267 的 status：native 未返回、heartbeat 冻结、quit 未进入 | `pending async status permits heartbeat` | status 确实进入一次且 Promise 未 settle、client 未提前完成；5 ms JS 探针新增至少 3 次，queued quit 与 stop 预算均可推进，迟到结果不能成功回包。 |
| 同段 encrypt：凭据加密期间同样阻塞 | `pending async encrypt permits heartbeat` | 放行所有探针，只挂起实际 JSON payload，核对 version/appId/plaintext；同样验证持续探针、quit/stop 与迟到隔离。 |
| 同段 decrypt：凭据解密期间同样阻塞 | `pending async decrypt permits heartbeat` | 只挂起与指定 ciphertext Buffer 相同的实际解密，探针不会匹配；同样验证持续探针、quit/stop 与迟到隔离。 |
| 272–290：20+20+20 ms stop budget 冻结，释放后才 stop/cleanup | 上述 `pending async ...` 三项均覆盖 | 真实 supervisor.stop 在 gate 未释放时达到 BACKEND_STOP_UNCONFIRMED；fake kill 执行，强制阶段最多一次且仅针对确切 child；quit helper 保留 child 并等待 exit，cleanup 未执行；仅收到该 child 的合成 exit 后完成 cleanup，此时 native 仍 pending。 |

复用当前 async AES fixture，三项 async 方法存在、所有同步加解密/状态方法均抛错；不会将
缺 async 方法或提前平台拒绝当成响应性证明。main/utility 通道和 child 均由同一 Node 进程的
EventEmitter 模拟，挂起的是可控 Promise，没有真实进程、线程、IPC 或 Atomics.wait。
5 ms heartbeat 是 JS 定时探针，不是生产 10 秒 heartbeat、renderer 或 Electron 实测。
每个阶段确认 native 已进入、尚未 settle、client 未完成后才排队 quit；断言在测试主体执行，
不放进会吞异常的通知/force 回调。quit Promise 立即处理拒绝，失败清理仍释放 gate、关闭
client、清除 interval、发送合成 owned-child exit 并等待本地清理。合成 quit handler 可运行
不代表真实 app.quit 或 Chromium ThreadPool 已结束，原生退出限制继续保留。

旧三阶段“经过约 2 秒 client timeout，main 仍阻塞”的结果需拆开：client 的 2 秒默认期限
由独立无回复端口实测；正常接通的 async codec 配置 1500 ms 预算，可先返回不可用，不再
要求先收到 `IMAGE_SECRET_CODEC_TIMEOUT`。三阶段 quit 用例在约 60 ms 停止预算后检查，
没有靠 1500/2000 ms 超时结束 native 来通过。旧的“最终成功迟到回包”改成“native 可迟到
settle，但 broker 不发送成功且 client 状态不复活”；原始阻塞断言保持于历史文件。

### 云端采用的归档方式（替代原 Mac 迁移提议）

原 Mac `.source.txt` 移动提议未执行；云端采用完整9e JSON源码快照，并保留根测试文件作为哈希验证/历史重放入口。原测试与依赖按精确字节在临时目录还原，原7项断言继续运行；`desktop-async-secrets.test.mjs` 则验证当前macOS异步实现。默认full发现二者，但明确区分历史缺陷复现与当前实现通过，不降低发现范围、不加skip、不重复累加嵌套7项。`pnpm test:desktop` 包含当前async文件；portable白名单不包含这些密钥专项，不能冒称默认portable已覆盖。

云端首批密钥整合门实际 **100项、100通过、0失败、0跳过**，21,790.402ms；含35项当前async、Linux静态兼容、三套真实schema/设置引擎和历史重放。另共享设置/凭据/生命周期/文档等聚焦门 **165项、165通过、0失败、0跳过**，5,351.070ms。两批是独立聚焦结果，不代替最终父级full（结果见末节）。第一批内部历史7项已由外层重放测试报告，不另加到100项。

## 未验证的原生边界

本实现承接先前只读可行性研究固定的 Electron commit
`61f55c4ce540416b3e43f75f6c0f125d22e5e908` / Chromium commit
`2c592105bbcd9490a9894df48d0fe59b2c512651`，本轮未重新联网。
Keychain provider 的等待可移出 main JS，但已开始的 ThreadPool 工作仍可能阻塞正常退出；
JS deadline 不能取消 OS 提示或提供整个应用退出的硬期限。

原 Mac 候选没有运行真实 macOS Keychain、Electron/应用/后端、旧原生密文互操作、允许/拒绝/锁定/恢复、
心跳和 app.quit、签名身份或安装包验证。当前云端 Linux 运行证据见下节，不能填补这些 macOS 项目。
Linux 强 keyring 的原生密文互操作和 Windows async provider 也未验证。已完成云端 development 构建，
未签名、制作安装包、上传、调用模型服务或使用真实凭据/媒体；没有 commit/push。本文不是原生发布认证。

## 云端整合与历史证据身份

整合输入补丁132,577字节，SHA-256 `6754c77d1ccacd9ca4c70c80732588e61267e5c3d67811a50bcb723369fa6068`。Mac 候选的35项结果不等于云端改动后的结果；当前云端聚焦与 Linux 原生回归已完成，独立 full 发布门已通过（3099总/3097通过/0失败/2跳过）。

历史归档取实际9e提交的原测试与8个依赖文件，测试 SHA-256 为 `c8da3aef5577cd47fb1e049ee5ac4a14f82220e6bb0f4ce732c00171cd6e8863`；和上面原 Mac `04a29e…` 的区别仅是导入审计说明文字，不是测试行为更改。`tests/fixtures/keychain-sync-9e9598d.json` 的整体 SHA-256 为 `db061a98ebd36429230efd92af12a2e053adb5a09cafc1e7ba18f82540012b6f`；重放测试先核整体及逐文件哈希，再在独立临时目录按原字节重建。它明确命名为历史同步缺陷复现，原7项断言不改；当前macOS异步则对当前模块运行35项正向/故障合成用例。嵌套历史7项不能和外层测试数重复相加。fixture仅供测试，构建和包的固定允许清单不包含它。

9e中 Keychain 超时报告正文误写为Timeline正文的整合错误已在 [更正说明](KEYCHAIN-TIMEOUT-AUDIT.md#文档身份更正2026-10-10) 明确恢复；其原始补丁、历史测试和生产源码校验另行留档。当前仍没有macOS真实Keychain、系统提示、签名身份/密文互操作或正常退出的认证。Linux原生验收也不能代替macOS；Windows11 ARM64环境存在不等于ACL/安装包已就绪。

## 当前云端冻结验收（2026-10-10 UTC）

基线 `9e9598d887b21b8e1b7dc742e5d15c66a3ff93d4`，本片仅7个生产文件、测试、历史fixture和5份文档，没有renderer/preload/API/schema/依赖变化。

- 密钥整合100/100与共享设置165/165之外，最终跨功能聚焦 **105/105通过、0跳过**，4,354.521ms：真实Timeline恢复25项（含Mac先前缺依赖未跑的14项）、CLI/MCP启动版本、桌面身份/包入口、Agent/Images UI契约、文档身份。批次有重叠，不相加冒充完整回归。
- `node scripts/tooling.mjs build --channel=development` 实际退出0。构建前后316个生产/构建输入哈希一致；49个产物哈希封存，stage Web与fresh dist一致，历史测试fixture不在stage/bundle中。Vite的依赖`use client`和大chunk警告仍保留。
- 正式构建的main SHA-256为 `db202ed495ead5e06a85eea06a573d3a337d77e423aa6617fdf155b2d0c90b75`；backend为 `4220d752504c7515616878adaf51ba7cd91efc99695a8325525dd493f34a8f62`。没有测试替换backend、远程调试或sandbox参数修改。
- 在独立合成Linux工作区通过实际桌面UI保存明确虚构的Agent session-only值；界面立即清空输入并显示“服务器已保存·仅本次运行”。切换官方/自定义Images设置后仍保留Agent会话状态，两个Images槽均未启用、未配置；当前系统安全存储不可用的说明准确。
- 两个完整Electron应用生命周期分别为PID 30197、30316，均由正常退出动作结束，code 0 / signal null。重开后同一项目/非秘密配置保留，Agent显示“服务器未保存密钥”。两次退出审计均为1项目、0素材/视频任务/导出/图像任务/Agent run；设置revision均为1，secret均为null，文件SHA均为 `42a119db0ea3f6c2cfb895aa461b29f115cd220ba095425ef7b00302ea413965`。
- 原始8张截图、启动/退出记录、日志、构建和输入哈希保留在云端ignored evidence中。这是Linux失败关闭/session生命周期回归；不证明Linux强keyring成功，也不证明macOS Keychain异步原生退出。日志保留系统DBus socket缺失诊断，没有掩盖环境限制。
- 此次没有点击聊天发送、图像生成或Comfy连接检查；合成设置测试不是provider联调。没有网络包捕获，不把零任务计数扩大为“所有进程绝无网络尝试”。

父级独立完整回归已取得实际终态：**3099总、3097通过、0失败、2跳过，652,313.918453ms，exit 0**。日志原件为 `/tmp/mioon-keychain-async-parent-full.tap`，云端证据另存 `parent-full-final.tap`；两项既有平台跳过保留，不记为通过。完整门期间生产/测试未修改。用户Mac当前9e基础启动/工具检查与本片独立；Electron CUA授权仍待用户处理，Keychain原生允许/拒绝/锁定/旧密文/退出各项继续待验收，不得绕过待授权操作。
