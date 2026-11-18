# SP-M 时间映射夹具

`entry.ts` 只导入纯函数模块和共享向量 helper，在页面里重算整数帧表和稳定 hash；`acceptance.py` 用仓库已有的 Python Playwright 和本机 Chrome 与提交的 `cross-runtime-v1.json` 比较。不启动应用、项目宿主或 RPC，不发网络请求。

```sh
mkdir -p /private/tmp/speed-time-map/tmp
TMPDIR=/private/tmp/speed-time-map/tmp node tests/browser_timeline_time_map.mjs --report /private/tmp/speed-time-map/browser.json
```

`--serve` 打印独立本机夹具地址，`--browser`/`--python` 可指定 Chromium 和 QA Python。报告只留本地或被 PR 引用的结论。

夹具重新生成（先审点集、profile 和 ties 规则）：

```sh
node --experimental-strip-types tests/helpers/timeline-time-map-cross-runtime.ts --write
node --experimental-strip-types tests/helpers/timeline-time-map-cross-runtime.ts --check
```
