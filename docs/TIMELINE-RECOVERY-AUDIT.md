# Timeline Undo/Redo 恢复审查

2026-10-10（UTC）。结论：本轮只读源码核对未证实运行时缺陷；发现的是需要补齐的组合测试，以及当前环境不能执行的验证层。不得将静态阅读、注入测试或依赖失败计为真实后端验收通过。

## 范围与环境

- 唯一工作树：Mac 独立隔离 checkout。
- 分支：`codex/timeline-recovery-audit-f683b10d`；基线：`8c694d191e6c90379c32c9f8db0a778c35c31e14`。开始核验时工作区干净。
- 已读取该工作树适用的开发约束。本轮仅新增本报告与 `tests/timeline-recovery-audit.test.mjs`；不修改运行时代码或其他工作树。
- 使用现有 Node `v26.9.0`；未安装依赖、构建、启动应用/服务、访问真实媒体/凭据、调用供应商、提交或推送。
- 请求的执行参数为 `gpt-6-astra` / `ultra`；此处只记录请求，不能据此核验实际承载的模型后端。
- 当前缺少 `@mioon/contracts`、`zod`、`esbuild`、`react`。真实 controller 和 timeline 的 import 探针均在初始化阶段受阻，exit 2；业务断言没有开始执行。

## 已核对的后端不变量

| 行为 | 源码证据 |
| --- | --- |
| 精确回执优先于当前 revision 检查；同 key 改输入/operation 冲突 | `packages/business/src/timeline.ts:41–54` |
| Undo/Redo 共用 travel，原子更新 timeline、cursor、回执；revision 单调加一 | `packages/business/src/timeline.ts:103–118` |
| 历史只保存 tracks、clips、durationFrames，不恢复 aggregate ID、createdAt 或 revision | `packages/business/src/timeline.ts:76–80`；`timeline-recovery.ts:99–104` |
| 新编辑裁剪 redo 分支；失败事务不能留下分支删除或游标移动 | `packages/business/src/timeline.ts:94–101,120–131` |
| `not_applied` 仅用于已回滚、原 key 无回执、未开始写入的白名单拒绝 | `packages/business/src/timeline-recovery.ts:14–23` |
| 精确重放仍核验当前所属项目和素材，返回历史响应而非当前 timeline | `packages/business/src/timeline-recovery.ts:143–153` |
| 事务回调必须同步，禁止嵌套；异常回滚 | `packages/business/src/db.ts:405–416` |

因此，丢失响应不能直接视为撤销失败。保留原 operation、projectId、expectedRevision、requestId；恢复历史回执后，重新读取当前 timeline/history，再形成新的编辑意图。普通 4xx、冲突字样或连接错误不能单独证明此前未提交。

## 现有覆盖，不重复声称缺失

以下为已有测试源码中的断言，不代表本轮已执行这些依赖完整环境的测试。

| 已有覆盖 | 测试证据 |
| --- | --- |
| 空历史不初始化；完整域快照往返、稳定 ID、单调 revision | `tests/timeline-history.test.mjs:34–82` |
| seed 保留固定素材；不撤销镜头选择、jobs、exports | `tests/timeline-history.test.mjs:84–103` |
| 分支替换后旧 edit/undo/redo 回执跨重开仍精确；改内容冲突 | `tests/timeline-history.test.mjs:105–122` |
| 同请求重复、竞争 revision、独立 SQLite 连接重复 undo | `tests/timeline-history.test.mjs:124–148` |
| 回执失败回滚、迁移、项目隔离、并发读取一致性 | `tests/timeline-history.test.mjs:150–202` |
| 全部 11 种 timeline 写入的回执重放、stale proof、归属/回执损坏、写后失败 | `tests/timeline-recovery-business.test.mjs:89–179` |
| 历史不能注入身份/revision，大历史记录重开重放 | `tests/timeline-recovery-business.test.mjs:181–190,258–282` |
| malformed-success 的 undo/redo 不自动重试 | `tests/timeline-recovery-transports.test.mjs:72–83` |
| durable 五个故障阶段跨重开恢复，现有矩阵使用 track.add | `tests/edit-tasks-business.test.mjs:28,72–82` |
| durable 正常路径包含 undo/redo，复用相同业务回执 | `tests/edit-tasks-business.test.mjs:160–182` |

## 三个具体后端组合缺口

1. **Undo/Redo 回执落库失败后，同一原请求跨重开恢复。** 对两个方向注入 `BEFORE INSERT ON timeline_requests` 失败；断言 timeline/history/cursor/receipts 不变且没有 `not_applied`。移除故障、关闭重开 store，再提交原输入/key：仅应用一次，重复提交不再推进 revision/cursor。现有 `timeline-history.test.mjs:150–159` 恢复时改用新 key；`timeline-recovery-business.test.mjs:172–179` 只检查失败瞬间。split 有类似测试（`timeline-split.test.mjs:334–360`），不能代替两个 travel 方向。

2. **Undo/Redo 已 COMMIT、响应阶段抛错后恢复。** 真实 `store.tx(callback)` 返回后抛异常，模拟提交成功但上层未取得 ACK；应没有 `not_applied`，且已经保留一个回执和一次游标变化。重开后原请求恢复历史响应，不重复遍历历史。现有提交后异常只测 track.add（`timeline-recovery-business.test.mjs:115–125`），未覆盖两个 travel 方向的后续重开。

3. **当前时间线为空、历史目标素材归属失效时的 fresh travel。** Undo 用“添加 clip 后移除”，Redo 用“添加 clip 后 undo”；仅改变合成历史目标素材的 SQL owner。原请求应以 `TIMELINE_SOURCE_UNAVAILABLE` 失败、无 `not_applied`，四类状态不变；修复合成 owner 并重开后，同一原请求才能成功。现有归属损坏主要覆盖已成功回执的 replay（`timeline-recovery-business.test.mjs:128–139`），不是这个历史目标恢复路径。

以上均为覆盖建议，不是已复现缺陷。所有素材可只用合成 metadata，禁止为这些测试启动 worker、导入或读取媒体。

## 当前 durable 入口与旧 runSession 的差异

当前 UI 顺序是 `changeTimelineHistory` → `mutateTimeline` → `run` → `runDurable`。触发前检查编辑模式、项目、history 同步、busy/pending/dirty/online；mutation 还检查任务 lane（`apps/web/src/App.jsx:728–753`）。Undo/Redo 属于 durable allowlist，render 不属于（`packages/contracts/src/edit-tasks.ts:7–10,21–24`）。

`run()` 对新 durable 意图调用任务控制器，只有 excluded 操作或 `options.replay` 走 `runSession`（`App.jsx:354–356`）。`runDurable` 经 prepare/execute/acknowledge，失效 history、保留未知结果、按当前项目刷新；不会直接调用 RPC 或以 sessionStorage 作为新任务的事实来源（`:358–409`）。

实际 controller 负责加载完整任务页、冻结原输入、禁止未确认 lane 新编辑、导航后禁止迟到派发；显式恢复先 get，再按状态 reconcile/execute（`apps/web/src/edit-task-controller.js:54–120`）。这些行为不能仅靠注入假的任务服务证明。

`tests/timeline-recovery-ui.test.mjs:10–16` 精确提取的是旧 `runSession`。它仍覆盖兼容恢复路径，但不能独自代表当前 Undo/Redo 新提交入口。`tests/edit-task-app.test.mjs:15,55–65` 已有真实 controller 与当前 App 分派测试，但其主要 fixture 固定为 `timeline.track.update`；`tests/edit-task-client.test.mjs:10` 同样如此。当前环境因依赖缺失未能执行这两个文件。

候选“冲突仍显示旧文案”已否定：`readableError` 按 `CONFLICT` / `REVISION_CONFLICT` code 转换提示（`apps/web/src/App.jsx:55–59`）；不能只看 durable 分支构造的原始 message 就报告 UI 缺陷。

## 新增测试矩阵与可信边界

| 层级 | 用例 | 执行边界 |
| --- | --- | --- |
| 纯 Node 导入真实模块 | history 状态、busy/pending/dirty/offline、快照不一致；键盘/输入控件/弹窗屏蔽 | 实际 `timeline-history.js:13–38`、`timeline-keyboard.js:12–25`，无 React/SQLite |
| 当前 App 普通 JS 函数 | 精确提取 run/runDurable、history 触发与 mutation 包装；注入任务服务验证成功/拒绝/未知/导航/重复点击 | 执行真实函数体，任务服务端口由合成替身提供；未执行 controller、HTTP、SQLite，不称端到端 |
| 真实业务恢复 | undo/redo × 回执插入失败、COMMIT 后抛错 × store 重开/原 key 重放 | 需实际 contracts/Zod；缺依赖显式 skip，不改用重写的内存业务模型冒充 |
| durable 针对性扩展 | undo/redo × afterClaim、beforeDispatch、afterBusinessCommit、beforeOutcomePersist、afterOutcomePersist × 重开 | 实际 `edit-tasks.ts:228–260`、`:284–297`；覆盖 startup 不派发、旧 instance 拒绝、原 key 最多应用一次 |
| 历史来源边界 | 两方向历史目标 owner 失效、恢复后原 key 重放 | 仅列明具体后续用例；本轮新增测试未纳入这一项，也未执行 |

durable 五阶段不是完全未测：旧矩阵已有 track.add；这里要求补充 Undo/Redo 与历史 cursor 的交叉断言。缺依赖时应保留明确 skip 原因，不能将未执行的真实路径计入纯 Node 通过数。

## 执行记录

所有命令在上述工作树运行，使用 Node `v26.9.0`。初次失败与受限重跑分别保留，不把前一次失败改写为通过。

| 检查 | 已知结果 |
| --- | --- |
| controller / timeline 真实 import 探针 | exit 2，缺依赖导致初始化阻塞；没有业务断言通过 |
| 首次现有 UI suite，`--test-name-pattern='^(?!history controls render)'` | 未排除 render 子测；12 tests，11 pass，1 fail，0 skipped，exit 1；失败因 esbuild 缺失，非业务断言 |
| 改用下方 `--test-skip-pattern` | exit 0；Node 报告 11 tests / 11 pass / 0 fail / 0 skipped。显式排除 1 项依赖 esbuild 的控件渲染测试，不能写成 skipped 1 |
| 新增 audit 完整文件 | exit 0；25 tests，11 pass，0 fail，14 skipped。14 项真实 SQLite/durable 组合因缺少 `@mioon/contracts`、`zod` 在初始化前显式跳过；未执行，不是通过 |
| 新测试语法检查、最终 diff/范围检查 | `node --check` exit 0；tracked/staged diff 为空，新文件空白检查无诊断，仅两份指定新增文件，分支/HEAD 未变。这些不计入业务通过项 |

新增审查测试与语法检查命令：

```sh
env -u NODE_OPTIONS -u NODE_PATH node --test --test-concurrency=1 tests/timeline-recovery-audit.test.mjs
env -u NODE_OPTIONS -u NODE_PATH node --check tests/timeline-recovery-audit.test.mjs
```

新增 11 项通过：Undo/Redo 各 5 项 App 控制流（重复触发、明确拒绝、普通 409、函数作用域重建后显式恢复、关闭任务中心后的执行回调），另 1 项直接导入的历史状态时序检查。重建函数作用域和保留内存合成任务不等于真实关闭/重开应用；业务模块依赖完备后才会执行其余 14 项。源码导入或 fixture 若在依赖解析成功后失败，测试直接失败，不捕获成通过。

已执行的现有 suite 重跑命令：

```sh
env -u NODE_OPTIONS -u NODE_PATH node --test --test-concurrency=1 \
  --test-skip-pattern='history controls render shared Base UI' \
  tests/client-timeline-history-ui.test.mjs
```

执行目录为上述唯一工作树。这个受限通过结果只支持 history/keyboard 与该文件其余无第三方依赖检查；不证明 React 控件渲染、真实 controller、SQLite、HTTP/CLI/MCP 或浏览器恢复已经通过。

后续在已授权且依赖完备的环境补跑真实路径即可；本次不安装依赖、不改生产代码以消除环境失败，也不依据上述缺口预设需要修复运行时。


## 云端补验：2026-10-10

在 `3ece477` 之上的整合 checkout，依赖已完备。相同新增文件执行 **25 项、25 通过、0 失败、0 跳过**；之前未执行的 14 项真实 SQLite/durable undo/redo 路径全部运行。整合聚焦门还保留旧 CLI/MCP、Comfy 恢复与连接权限覆盖。

这些结果证实本报告逐项列出的回滚、提交后响应丢失、五处 durable 中断及同 key 恢复断言；并不把前 11 项合成 App 函数测试升级为 React/native 恢复验收。历史快照素材所有权改变后的新 travel 仍是本审查未覆盖项，不能因这一组通过就宣称任意损坏状态均已验证。生产 timeline/recovery 代码未改变。

父级最终独立整合 full：3035 项、3033 通过、0 失败、2 项既有平台/权限跳过，716943.546 ms。本审查新增 25 项没有跳过；该 aggregate 不是新的 native 平台测试。
