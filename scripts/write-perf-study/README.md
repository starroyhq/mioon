# 项目写入性能量测

在仓库根目录使用 Node 24.21.0 和锁文件中的依赖。指定可由当前用户读写、路径不含符号链接的临时目录。下面的命令为量测创建独立 HOME 和临时项目。

```bash
study_root=$(mktemp -d "${TMPDIR:-/tmp}/mioon-write-study.XXXXXX")
mkdir -m 700 "$study_root/home" "$study_root/tmp"
export HOME="$study_root/home" CFFIXED_USER_HOME="$study_root/home" TMPDIR="$study_root/tmp"
node tests/fixtures/write-perf-study/durability.mjs --benchmark --first-count=32 --steady-count=64 > "$study_root/durability.json"
node tests/fixtures/write-perf-study/durability.mjs --crash --repeats=2 > "$study_root/crash.json"
node scripts/write-perf-study/product.mjs --rounds=10 > "$study_root/product.json"
node --test --test-reporter=tap scripts/write-perf-study/history.ts > "$study_root/history.tap"
```

macOS 上可先把 `TMPDIR` 设为 `/private/tmp`。崩溃实验另外需要 C 编译器、SQLite 开发头文件和共享库。探针编进临时目录，只给自己创建的子进程注入停点并发送 SIGKILL。它验证进程崩溃后的跨库状态与单文件副本。断电行为需结合 SQLite 的同步语义判断。 [SQLite 原子提交](https://www.sqlite.org/atomiccommit.html) · [SQLite synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)

- `durability.mjs` 的提交计时使用 Node 内置的 SQLite。按 Mioon 的挂库顺序和独占锁建合成库，每个动作写入 48 个片段和约 229 KiB 历史。首笔指新连接上的首个事务，不要求清空系统页缓存。COMMIT、动作总时长和强制 checkpoint 分别计时。分拆对照按四笔 COMMIT 的总时间与一次合并动作比较。
- `product.mjs` 复跑真实的格式 5 K1 预算用例，保留各轮诊断。各轮的稳态分位数单独列出，首次编辑和重开按项目规模重新汇总。macOS 使用现有预算记录模式保留超时样本，功能断言仍执行。另在实时连接仍持有项目时验证空闲期外部复制、应用内复制和移动后的行为。
- `history.ts` 读取合成真实项目的持久历史条目。独立原型只在内存里比较字段与区间补丁尺寸和可逆性。
