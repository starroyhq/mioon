# R1-C 每项目存储实测与配额候选

生产基线提交 `80a10890e3f5a0485f2dcdb69e31dfad44d4600b` 加本卡未提交源码；精确源码 SHA、发送向量、18 表增量、命令、exit 与原报告 hash 见 [R1-C-STORAGE.json](R1-C-STORAGE.json)。本报告只提出数字，开发常量仍为 **256MiB / 20,000 行 / 单行2MiB**。

版本说明：下列原13轮矩阵在零余量通知顺序修复前执行（records SHA `47d006fe840178c9a9cdb13994025753be1f8befd0e2e64c894b5f6c6aea744c`），原raw及hash未覆盖。最终源码SHA `5d6566d8b1e31dce80f0bc891618bb3519171f87561c913fba3a902f873927ba` 只把同事务的step通知移至raw清理之后；最终CC/300完整轮、6项正式测试和0/1B四边界另附实测，容量最大B/R及18表最终增量相同。逐版本映射见JSON的 `originalMatrixVersion` / `finalProductionVerification`。

## 负载和测量边界

- 主矩阵：三协议官方 presets；每轮30步＝15模型＋15工具，模型正文30,720B，delta3,072B，每份工具结果完整20,480B，不加载额外工具组。模拟时钟与44a34212基线一致。每协议测冷首轮、同项目同conversation第二轮、另一项目独立首轮。
- 真实 K1 项目库、MioRuntime、tools、journal、entries/manifest 路径；只替换离线 gateway，无真实 provider 或网络 socket。发送边界只存 body 的字节数和完整 SHA，成功后原 body/partial 全清；关库重开后每个请求从 entries/blobs/manifest 重建，字节/hash一致，重读 total_changes=0。
- 逻辑量使用生产 `readMioStorage` 的18表 inventory，blob内容按唯一行计一次；物理量只用 SQL/dbstat/stat 观察，打开期间不通过 fs 打开或读取数据库。三库合计含 history/project/cache，不含 B1 应用库和建库过程。
- checkpoint累计重写量是实际 appendText 所赋值 partialText/data/updatedAt/status 列的 UTF-8 字节之和，排除其他 SQL 更新、未赋值列、索引和物理写放大。网络量仅为离线 gateway 收到的请求正文，排除 headers/TLS/SSE。token/cache计数未提供，不能推导 tokenizer 用量、命中率或费用。

## 完整轮主矩阵（delta0ms）

| 协议 | 冷首轮逻辑B/行 | 同conversation第二轮B/行 | 独立冷项目B/行 | 请求正文累计B（首/续） |
|---|---:|---:|---:|---:|
| chat_completions | 1,058,515 / 298 | 1,044,945 / 293 | 1,058,515 / 298 | 1,432,640 / 1,432,268 |
| responses | 1,019,058 / 298 | 1,002,837 / 293 | 1,019,058 / 298 | 1,431,550 / 1,431,021 |
| anthropic_messages | 1,018,628 / 298 | 1,003,093 / 293 | 1,018,628 / 298 | 1,423,504 / 1,423,120 |

三协议均完整结束30/30，未裁剪 raw 工具结果。额外用最终helper补测Chat Completions/300ms（完整30步）组合最大冷轮协议和密集checkpoint，纳入B/R最大值。44a34212旧 inventory 的首轮逻辑量对照：

| 协议 | 44a34212 B/行 | 新冷首轮B/行 | 逻辑B下降 |
|---|---:|---:|---:|
| chat_completions | 6,485,658 / 198 | 1,058,515 / 298 | 83.68% |
| responses | 6,490,826 / 198 | 1,019,058 / 298 | 84.30% |
| anthropic_messages | 6,475,222 / 198 | 1,018,628 / 298 | 84.27% |

旧数值是旧 data 列口径，新数值按18表全部被配额计量的文本列计量；这不是物理文件或网络降幅。新表和通知行增加，不能把字节下降当作20k行配额已能容纳100轮。

## H2 检查点对照（Responses，每项完整30步）

| delta / tail ms | 逻辑B/行 | checkpoint次数 | checkpoint累计重写列B | done前正文B / 次数 |
|---|---:|---:|---:|---:|
| 0 / 0 | 1,019,058 / 298 | 60 | 1,322,160 | 27648 / 3 |
| 80 / 0 | 1,019,058 / 298 | 60 | 1,322,160 | 27648 / 3 |
| 300 / 0 | 1,024,458 / 388 | 150 | 2,614,200 | 30720 / 10 |
| 0 / 300 | 1,019,058 / 298 | 60 | 1,322,160 | 30720 / 4 |

最终helper的Chat Completions/300ms补样：1,063,915B/388行，150次checkpoint、累计重写列2,614,200B，成为最大B观测。

0/80ms最终flush前仅落盘27,648B，done会补齐；尾停顿让最后3,072B在250ms期限落盘。300ms每delta均形成检查点，最终保留行数与累计重写量随之增大。

## 物理文件、页、索引、日志峰值

| 协议/项目 | 数据库文件B | 页数（页B） | 索引页B | rollback/WAL/SHM合计峰B |
|---|---:|---:|---:|---:|
| chat_completions / 1 | 4,087,808 | 998（4,087,808） | 823,296 | 99,520 |
| chat_completions / 2 | 3,006,464 | 734（3,006,464） | 786,432 | 99,520 |
| responses / 1 | 4,014,080 | 980（4,014,080） | 823,296 | 99,520 |
| responses / 2 | 2,973,696 | 726（2,973,696） | 786,432 | 99,520 |
| anthropic_messages / 1 | 4,009,984 | 979（4,009,984） | 823,296 | 99,520 |
| anthropic_messages / 2 | 2,969,600 | 725（2,969,600） | 786,432 | 99,520 |

项目1峰值跨同conversation两轮，项目2只含独立冷首轮；dbstat在本机可用。采样发生于事务提交前、checkpoint后和gateway边界，不是OS写入跟踪，不能视为严格全时刻峰值；不含super-journal。本机为rollback模式，`-wal/-shm`未出现，计入项为rollback journal。

## 异常、升级和近满归档

最大字节补测使用真实 K1/MioRecords 与未改动的约束/触发器，512KiB原件加接近2MiB整行上限的manifest，failed/unknown另保留256KiB解码NUL正文（JSON存储扩大为1,572,866B），升级保留两份原件/manifest。**这是存储合法边界包络，不表示真实协议装配会产生padding manifest或达到512KiB。**

| 场景 | whole场景逻辑B/行 | 原件B | request表B | partial存储B |
|---|---:|---:|---:|---:|
| intent | 2,097,753 / 8 | 524,288 | 2,096,829 | 0 |
| failed | 3,671,474 / 11 | 524,288 | 2,096,877 | 1,572,866 |
| unknown | 3,671,476 / 11 | 524,288 | 2,096,878 | 1,572,866 |
| upgraded | 4,195,280 / 12 | 1,048,576 | 4,193,708 | 0 |

真实并发验证：一个held gateway时，另8个同项目send全为AGENT_TASK_BUSY，仅1个pending request；这只限制当前执行队列，stop后的旧原件没有全局数量上限。

近满验证：保持256MiB配额，填至 `268,434,432B`（仅余1,024B）；旧先INSERT输出顺序触发STORAGE_LIMIT并完整回滚。修复版在同一savepoint先完成证据状态/清原件再插入canonical输出，成功归档128KiB正文，清512KiB原件，净 `-392,788B`，最终 `268,041,644B`。归档插入失败后的raw/partial/summary原子回滚另由usage仓库故障测试验证。

## C / B / R / E 与协调人候选

- chat_completions 冷共享blob：21,894B / 4行（两次同conversation请求都引用的冻结配置、目录、系统包络、baseline去重）。
- responses 冷共享blob：24,478B / 4行（两次同conversation请求都引用的冻结配置、目录、系统包络、baseline去重）。
- anthropic_messages 冷共享blob：24,028B / 4行（两次同conversation请求都引用的冻结配置、目录、系统包络、baseline去重）。

取最大观测 `C=24,478B/4行`，`B=1,063,915B`，`R=388行`。B是所有完整轮观测中的最大增量，包含冷轮已有的共享成本，另外加C是保守余量；没有用平均值或最小样本估容量。

固定恢复场景明确限定1 failed＋1 unknown＋1单次升级双份＋1 active intent。fresh仓库包络和为13,635,983B/42行；补1,468B至请求行上界，并给每个槽再留1个完整同负载轮B/R覆盖异常发生前的已完成前缀，得到推荐 `E=17,893,111B/1594行`。这不是生产全局异常数量上限。

- 只按fresh包络：N100至少120,053,429B / 38,846行。
- 推荐前缀余量：`C+100*B+E`＝**124,309,089B / 40,398行**。256MiB字节余量144,126,367B，20k行缺20,398行。
- 候选A（推荐）：保持256MiB，行数由协调人选择 **45,000**；同一保守模型按字节235轮/按行111轮，取 **111轮**，满足100轮目标并留余量。开发常量不变。
- 候选B：保持256MiB，行数选择 **65,536**；同一保守模型按字节235轮/按行164轮，取 **164轮**，提供更大的同预算行数余量。开发常量不变。
- 现状参照：256MiB/20k按字节235轮/按行47轮，取 **47轮，不满足D5的100轮目标**，不作为达标候选。
- 若每个完整轮都另留1 failed＋1 unknown＋1 upgrade及各自前缀，N100需1,582,689,969B / 159,000行，已超过当前字节预算。不能据固定E承诺任意失败率下100轮。

这些是观测样本和明确余量情景，不是任意项目大小、任意工具/未来目录、任意会话长度的数学上界。手工回执只有单条保护、没有独立全局保留上限，也会消耗真实字节。quota触发器仅拒绝 `usage>limit`，诊断从 `usage>=limit` 标full；保持既有含义。

## 复现与原始证据

环境：Node24，`PATH="$HOME/.npm/_npx/538786c08bcb9442/node_modules/node/bin:$PATH"`，`TMPDIR=/private/tmp/r1c/tmp`，`TZ=UTC`。以下每条实际exit0，完整argv在JSON逐artifact登记。

```sh
node tests/helpers/mio-storage-report.ts --output=/private/tmp/r1c/stress30-delta0.json
node tests/helpers/mio-storage-report.ts --protocol responses --rounds 1 --single-project --delta-interval-ms 80 --tail-pause-ms 0 --output=/private/tmp/r1c/stress30-delta80.json
node tests/helpers/mio-storage-report.ts --protocol responses --rounds 1 --single-project --delta-interval-ms 300 --tail-pause-ms 0 --output=/private/tmp/r1c/stress30-delta300.json
node tests/helpers/mio-storage-report.ts --protocol responses --rounds 1 --single-project --delta-interval-ms 0 --tail-pause-ms 300 --output=/private/tmp/r1c/stress30-delta0-tail300.json
node tests/helpers/mio-storage-report-recovery.ts --near-full --output=/private/tmp/r1c/recovery-final.json
node tests/helpers/mio-storage-report-max-retention.ts --output=/private/tmp/r1c/max-retention.json
node --test --test-timeout=600000 tests/mio-storage-report.test.ts # 原helper5/5；最终扩展版6/6见下文
node scripts/tooling.ts typecheck # exit0
```

主矩阵/H2中16个相关源码/锁/helper测前测后hash完全相同。max helper是独立新增文件，不参与已冻结主矩阵执行，单独登记自身SHA并核验相同16源文件。Git工作区含本卡未提交改动，用完整sourcehash映射标识实际执行代码，不把base commit冒充完整测量版本。

| 原artifact | SHA256 | exit |
|---|---|---:|
| `stress30-delta0.json` | `48e4b30061ee9810bbe593b6ab6da56f969dfb86382ec3fc7a40910705e819bf` | 0 |
| `stress30-delta80.json` | `f3270732950acf2d14d794a0f35ec9da0444547da471a3d02a9c40445831d760` | 0 |
| `stress30-delta300.json` | `4d0a8d6589a0de4921ca86625ee526927ebe419e95b5cd54192664448abfdff4` | 0 |
| `stress30-delta0-tail300.json` | `363900f958cf56de1f549b171b6f9f64951a8b3e828b5aff4826a47bc1872fc7` | 0 |
| `recovery-final.json` | `44ef0078f6898851bbd3de5628c407796d37b8b2570563a1934bdce9f7935df2` | 0 |
| `max-retention.json` | `fbc2af9308873ade05961ea24cd122cb688aa69229071847c9b5d95caf38e1eb` | 0 |
| `final-helper-cc-delta300.json` | `3816cc5b486704be51fa72f276b025c4fb183879f4abdb3eba432db0773bbefb` | 0 |
| `stress30-baseline-44a34212.json` | `39597edefd0fa6d041508d23d958c8daccddc1fa6c6c46cfd719cf409ee1f59c` | 0 |

原件和日志同时保存在 `/private/tmp/r1c/` 与主任务笔记目录 `.agents/tasks/howard-r1-mio-usage-quota/measurements/`。JSON附每轮18表增量、全部请求完整SHA/字节、物理峰值及manifest大小；数据库内容不作为报告附件，也没有保存凭据或完整请求历史副本。

测量完成后，helper只给两条Git元数据命令补了 `-C process.cwd()`，测量逻辑不变。主矩阵/H2的原hash保留，未重写raw artifact。实测helper SHA为 `3a2bd56dc089aa16955be850b0efd6134e1f61fbc99276ae3d85e2c47487e789`；最终helper SHA为 `e769f1440548857a64a1dbe12beeed6d0e53f90ce9cf1096391c79709a23eedc`。Git-C调整后的helper（通知延后修复前）另跑CC/300ms完整轮和当时5项test通过；旧helper源码副本和逐artifact源码映射均已保留。

## 零字节余量回归与最终源码复核

原1024B余量不能覆盖精确满额：无partial、保留512KiB原件时，0/1B余量下的128KiB正文与tool-only四种情况原先全部在 `emit INSERT mio_events` 失败。step状态缩短只释放7B，通知新增60B，分别先越界53/52B；事务完整回滚，raw保留。

最终实现保持所有SQL guard，把step的touch/emit延至rawclear后。正式helper支持slack0/1/1024和text/tool_only；0/1B四种情况现均completed、raw清空、partial仍NULL，正文净-392,788B，tool-only净-523,735B。原1024B回归继续通过。最终单文件测试**6/6**、typecheck均exit0。

最终CC/300实测仍为**1,063,915B/388行**，150个checkpoint、重写列2,614,200B，请求正文累计1,432,640B；18表增量和15个请求的字节数逐项等于修复前最大样本，容量公式和A/B候选不变。

跨独立fixture的原始SHA受随机身份影响：全新项目仅1/15相同；私有helper副本先以旧projectId建立新临时项目（没有改写发送正文）后3/15相同。后续compaction可包含随机modelStepId/stepId等身份或执行输出；报告保留全部真实SHA差异，不以跨独立run的SHA相等作兼容性判定，也不把这些差异归因于通知顺序。最终每个请求均从entries重开重建，与本次gateway原SHA/字节完全一致且0写；确定性99向量守卫由根另列。

最终补测证据：

| artifact | SHA256 | exit |
|---|---|---:|
| `nearfull-zero-slack-before.json` | `3594766bc92dc5c17b61a2825b987c06e7aa3f1a2b4358950cb03f2ba026788a` | 0 |
| `nearfull-formal-slack-after.json` | `0a443b604ee32e2ec1677db7a2ab54d86f4eb87876cfcdbf7d2a699e5bea018f` | 0 |
| `final-production-cc300.json` | `170cbf22dcf8548b2148f808fd2b4cab70f1a065f65a515e06f0089320c1ca00` | 0 |
| `fixed-identity-final-production-cc300.json` | `70d5ea69658e7e2eed7674320b3659d4401b0901f03f376dba7e27fe37dc3fbb` | 0 |

未完成的重复合成测量已取消，记录见notes `aborted-synthetic-runs.json`，不纳入测量结果。原13轮完整原件全部保留。最终补测原件与私有探针在notes的 `final-notification-fix/` 子目录，JSON列出完整命令、sourcehash及逐15请求比较。
