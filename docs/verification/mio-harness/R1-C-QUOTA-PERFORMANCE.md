# R1-C 增量配额性能复测

协调人要求的旧扫描实现与新计数实现，在同机Node24、真实K1临时项目中顺序实测。生产额度已定为 **256MiB / 65,536行**。原始分布、完整guard SQL、EXPLAIN潜在读游标、命令/exit及sourcehash见 [JSON报告](R1-C-QUOTA-PERFORMANCE.json)。

## 计时范围

- 仅计prepared `INSERT.run`：逻辑200B＝content112B＋SHA64B＋ISO时间24B；每组5次预热、31次测量。
- 每次写后用savepoint回滚；savepoint建立、rollback/release、hash/prepare、填充、全量核对和commit/fsync均在计时之外。**各采样组前后**核对full inventory/counter完全相等，没有逐sample执行full inventory。
- large样本以约2MiB行填充0/31/63/128/191/250MiB；small为40,000个受保护blob，每行2,752B，合计110,080,000B（104.98MiB）。
- baseline仅在新建临时K1 fixture中换入6d433c23的私有MIO_SCHEMA：row预算20k→65,536对齐，填充时暂不安装扫描quota，填完计时前全部安装。其余FK/immutable/retain/row/identity约束保留；没有改生产文件或提供降级入口。
- current全程使用未改动的生产v4 schema，填充阶段也不卸trigger。自身counter是整数0B/1行，所以current quota rows比同数据baseline多1。

## 同机结果（ms）

| 保留数据 | 旧扫描p50 | 新counter p50 | 新counter p90 |
|---|---:|---:|---:|
| 0MiB-large | 0.006833 | 0.003125 | 0.003292 |
| 31MiB-large | 7.057125 | 0.002958 | 0.003083 |
| 63MiB-large | 16.452333 | 0.003042 | 0.003125 |
| 128MiB-large | 29.260041 | 0.002875 | 0.002958 |
| 191MiB-large | 55.045667 | 0.002959 | 0.003083 |
| 250MiB-large | 75.874917 | 0.003000 | 0.003167 |
| 40000-rows-2752B | 55.128708 | 0.002792 | 0.002917 |

旧扫描延迟随保留量增加；新样本p50约0.0028–0.0032ms，未观察到随保留量增长。这里只证明配额算法：quota SQL只查询/更新单行 `mio_storage_counters WHERE singleton=1`，没有sum/count或保留表扫描。SQLite原生FK/索引仍有自己的代价，EXPLAIN潜在FK读游标未被隐去，也不把端到端服务或持久化commit延迟说成3µs。

## 正确性与容量

- 最终CC300完整30步：1,063,915B / 本轮388行；旧18表增量、流式重写2,614,200B、请求正文1,432,640B均相同。19表inventory新增counter冷行0B/1row，冷库usage.rows=1，轮后389；重开15请求全部自洽重建，0写。
- nearfull0/1B × text/tool_only四边界全部成功，正文净-392,788B，tool-only净-523,735B；原1024B回归保留。max-retention四场景旧18表逐项相同，各独立fixture只多counter1行。
- storage-report 6/6、perf current小fixture 1/1、typecheck均exit0。普通CI perf test不访问旧Git ref，也不运行250MiB矩阵。
- 原数据C/B/R/E保留：C=24,478B、B=1,063,915B、R=388、E=17,893,111B/1,594行。只Crows从4变5，`C+100B+E`仍124,309,089B，行数变**40,399**；65,536行保守可容164轮。

## 复现

```sh
export PATH="$HOME/.npm/_npx/538786c08bcb9442/node_modules/node/bin:$PATH"
TMPDIR=/private/tmp/r1c-quota/tmp TZ=UTC node tests/helpers/mio-quota-performance.ts --profile baseline --output=/private/tmp/r1c-quota/baseline-performance-final.json
TMPDIR=/private/tmp/r1c-quota/tmp TZ=UTC node tests/helpers/mio-quota-performance.ts --profile current --output=/private/tmp/r1c-quota/current-performance-final.json
```

baseline显式CLI需要本地有6d433c23对象；普通current测试没有此依赖。所有原件和日志另存主任务notes的 `measurements/incremental-quota-20261102/`，原13轮raw未覆盖。

| artifact | SHA256 | exit |
|---|---|---:|
| `baseline-performance-final.json` | `3506ca055f2c9c75e019cf4260fbc703683b422c2387ac4fd8c2512f82a7313f` | 0 |
| `current-performance-final.json` | `ad18e7688e686474d0b8513386c452220b13280e3d26b1288ce559051d26d915` | 0 |
| `final-cc300.json` | `163554b0cf47c8398a305d6cbfb06178083c58f4ff3b9a98a79a8a9573b6523d` | 0 |
| `nearfull-formal-after.json` | `c8e5ca202da642e8998a4cb23cdfb7fbaf636d44a5388842ac48d892b9f6e4b6` | 0 |
| `max-retention-after.json` | `e0147771e7fa83553ad4a77c0d803cc10a618eb7a4b96a7dc0731d5b07dc7f37` | 0 |
