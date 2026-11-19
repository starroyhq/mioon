# 格式 5 K1 性能基准的预算口径（Linux CI / macOS）

四个 K1 基准直接测共享事务的同步调用，不做预览、不做 UI 往返：

| 测试 | 规模 | 测什么 |
| --- | --- | --- |
| `tests/project-format5-performance.test.ts` | 100 / 500 / 1,500 段 | K5a 行编辑事务：`read → plan → entity update → content stamp → terminal fence → COMMIT` |
| `tests/format5-timeline-sync-performance.test.ts` | 500 主轨 + 1,000 锚定段 + 500 字幕 | `runSequenceSync` 一次主轨/画板同步（读投影、SA plan、写实体、基线、一条历史） |
| `tests/format5-timeline-sync-b-performance.test.ts` | 499 主轨 + 1,000 锚定段 + 500 字幕 | TSb track 命令 split/trim/remove/add 各一次同步 + undo |
| `tests/sequence-edit-performance.test.ts` | 500 主轨 + 1,000 锚定段 + 500 字幕 | `sequence.edit` 一次板版本选择（投影、SA plan、写实体、基线、一条历史） |

## 为什么把 COMMIT 拆出预算

1,500 段基准长期在 Linux CI 分片 4 失败，曾怀疑有约 50 ms 未计时（组装 `TimelineRecord`、
JSON 序列化、GC）。补上 `attributedMs = begin+read+validate+write+terminalFence+commit` 和
`unattributedMs = total−attributed` 后实测（PR #311）：

- 未归属时间 p50/p95/max 均 ≤0.002 ms，分步完美覆盖 total，没有隐藏代码路径或 GC 停段；
- 失败尖峰的 p50/p95 全部落在 `exec('COMMIT')`：Linux 共享 runner 上 single commit p50 47.4/18.7 ms、
  batch p95 272 ms / max 825 ms；同代码 macOS commit p50 0.48/1.77 ms；
- 项目基准用 journal=`delete`、synchronous=`FULL`，每次提交都要 fsync。这是共享 runner 的磁盘
  延迟，不是代码回归。

因此：

- **Linux CI** 断言「代码路径」= total − native COMMIT，含 BEGIN、事务预检、业务 body、terminal
  fence 与返回；沿用原预算，不放宽：p95 ≤200 ms、单次 ≤400 ms（各测试沿用自己原有的数字）。
- **COMMIT** 单独统计 p50/p95/max，只进 diagnostic，不在 Linux CI 卡门槛。
- **macOS 本机**继续断言含 COMMIT 的 total（p95 ≤100 ms、单次 ≤200 ms，沿用原数字）；APFS 上
  commit 本来很小，这是用户真实感受到的延迟。
- 不选 `synchronous=NORMAL`：那会让基准测的东西和生产不一致。WAL / 合并提交等生产耐久性策略
  另行评审，不在这条基准线上改。

## Diagnostic 字段

- 项目基准：`totalMs`、`codePathMs`、`beginMs/readMs/validateMs/writeMs/terminalFenceMs`、
  `commitMs`、`attributedMs`、`unattributedMs`，以及 `journal/synchronous`。
- 三个服务级基准：`p50/p95/max`（total，兼容旧日志）、`codePath`、`commit` 三段同类分布。
- `unattributedMs.p50` 守卫 5 ms：以后若新的未计时工作混入项目基准，会先报未归属时间，而不是
  只表现为 total 抖动（服务级基准的 body 无法再分步，total−COMMIT 即全部事务体）。
