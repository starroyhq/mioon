# 格式 5 大画板平移量测

使用已安装依赖的工作树、Node 24、Playwright CLI 和 Google Chrome。主样本使用 macOS Apple M3 Max、Playwright CLI 0.0.65、Chrome 158、1440×900 和 DPR 1。等待各组进程空档后串行量测。Chrome 用独立临时配置启动，夹具使用真实格式 5 项目、真实本地 RPC 和生产画板组件。

```sh
if [ "$(uname -s)" = Darwin ]; then
  board_scratch=$(mktemp -d /private/tmp/mwb.XXXXXX)
else
  board_scratch=$(mktemp -d /tmp/mwb.XXXXXX)
fi
mkdir "$board_scratch/home" "$board_scratch/tmp"
(
  export HOME="$board_scratch/home" CFFIXED_USER_HOME="$board_scratch/home"
  export TMPDIR="$board_scratch/tmp" XDG_CACHE_HOME="$board_scratch/home/.cache"
  export XDG_CONFIG_HOME="$board_scratch/home/.config"
  MIOON_BOARD_STUDY_RUNS=6 node scripts/write-perf-study/board.mjs \
    > "$board_scratch/board.json" 2> "$board_scratch/board.log"
)
```

短临时路径为 Playwright CLI 的 Unix 套接字留空间。默认每种场景测首次手势，热身两次，再用轮换顺序测三种方案。脚本自动关闭本次的浏览器会话及夹具。 `MIOON_BOARD_STUDY_RUNS=1` 配合 `MIOON_BOARD_STUDY_TRACE=0` 可先跑冒烟。 `MIOON_BOARD_PLAYWRIGHT_CLI` 可指定 CLI 可执行文件。

- 原夹具确实是 500 镜头、500 条顺序边和 200 条引用边。900 边试验给合成项目新增第二条、由 200 张静帧组成的成片链，保留原有 500 镜头主轨和同步基线。两组开场分别渲染 601/802 张卡和 700/900 条边。
- 每轮用浏览器中键平移 180×90 像素，分 30 步，下一轮回到相同起点。结果检查 viewport 位移、缩放、任务前后 RPC 次数、历史位置、时间线/同步 revision 和图实体数量。
- 主分位数只取手势期间相邻 rAF 间隔，使用最近秩。兼容口径额外保留 300 ms 的释放后空闲。p95 约 33.4 ms 表示尾部仍有明显的 60 Hz 双帧间隔，同时看超过 20 ms 帧的比例。
- Chrome trace 单独采集，避免干扰主分位数。事件时间是指定组内持续区间的并集，各组可能重叠。跨组汇总用主线程 `RunTask`，组间比较可把耗时乘以 1000 再除以手势窗口长度，得到毫秒/秒。
- 试验都通过临时 CSS 改变呈现。默认比较原样、平移中暂停动画、暂停并临时隐藏顺序边圆点和引用边标签。额外选项可连续静态显示低缩放总览中的边动画，或进一步给视口增加 `will-change: transform` 并去掉工具栏 backdrop blur。额外选项保留边、标签和热点。

900 边补充试验可在相同临时目录环境中运行。

```sh
(
  export HOME="$board_scratch/home" CFFIXED_USER_HOME="$board_scratch/home"
  export TMPDIR="$board_scratch/tmp" XDG_CACHE_HOME="$board_scratch/home/.cache"
  export XDG_CONFIG_HOME="$board_scratch/home/.config"
  MIOON_BOARD_STUDY_FOCUS=requested MIOON_BOARD_STUDY_RUNS=6 \
  MIOON_BOARD_STUDY_MODES=baseline,pause-edge-motion,small-scale-edge-detail,overview-static-edges,overview-composited \
  node scripts/write-perf-study/board.mjs > "$board_scratch/board-extra.json" 2> "$board_scratch/board-extra.log"
)
```

## 主量测

同一台 Mac 上本卡各组串行运行，主轮次首尾 CPU 空闲度采样为 17.8% 和 48.2%。六轮每轮轮换顺序。单位为 ms。

| 场景 | 方案 | 帧数 | p50 | p95 | >20 ms | 每轮 p95 ≤20 ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 700 边 | 原样 | 193 | 16.7 | 33.4 | 83 | 0/6 |
| 700 边 | 平移暂停动画 | 259 | 16.7 | 33.4 | 56 | 1/6 |
| 700 边 | 平移暂停并隐藏圆点、标签 | 294 | 16.7 | 33.3 | 38 | 1/6 |
| 900 边 | 原样 | 205 | 33.3 | 33.4 | 120 | 0/6 |
| 900 边 | 平移暂停动画 | 281 | 16.7 | 33.4 | 68 | 3/6 |
| 900 边 | 平移暂停并隐藏圆点、标签 | 339 | 16.7 | 33.3 | 31 | 5/6 |

初次手势的 700 边和 900 边分别为 16.7/33.4 ms 和 33.3/33.4 ms。每轮 p95 揭示运行之间仍有帧预算抖动，单次达到 16.8 ms 的轮次不足以证明通过门槛。

900 边单独采集 trace，数值为主线程毫秒/手势秒。

| 方案 | 总任务 | 样式和布局 | 预绘制和绘制 | 分层和合成提交 | 输入派发 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 原样 | 924 | 206 | 91 | 326 | 124 |
| 平移暂停动画 | 540 | 51 | 19 | 236 | 117 |
| 平移暂停并隐藏圆点、标签 | 483 | 49 | 22 | 203 | 118 |

画板节点拖放才调用 `BoardUiStatic.tsx` 的 `onNodeDragStop` / `flushMoves`，手势平移的 RPC 次数为零。时间集中在 `edges.css` 的 `offset-distance` 和 `stroke-dashoffset` 无限动画触发的样式、绘制与提交，缩放总览还有较多分层工作。参考线标签是 `BoardEdges.tsx` 的 SVG `foreignObject`。数据库耐久策略和历史编码都无需随这项优化变化。

## 900 边补测与取舍

补测首尾 CPU 空闲度采样为 39.3% 和 59.9%。这轮稳定等候 120 ms 后再启动手势，记录手势 CSS 生效帧，六轮每轮轮换顺序。单位为 ms。

| 方案 | 帧数 | p50 | p95 | >20 ms | 每轮 p95 ≤20 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 原样 | 203 | 33.3 | 33.4 | 117 | 0/6 |
| 平移暂停动画 | 246 | 16.7 | 33.4 | 50 | 2/6 |
| 平移暂停并隐藏圆点、标签 | 284 | 16.7 | 33.4 | 54 | 3/6 |
| 低缩放总览静态显示边 | 350 | 16.7 | 16.8 | 13 | 4/6 |
| 低缩放静态边并强制视口分层、去工具栏模糊 | 313 | 16.7 | 33.3 | 41 | 0/6 |

手势暂停变慢的轮次中，几乎所有测量帧都包含生效的 CSS，仍有成段的双帧间隔。低缩放总览静态显示保留边线、标签和命中区域，合并样本 p95 低于 20 ms 的目标，单轮仍有 2/6 未达标。单独 trace 量得样式和布局 182→21、预绘制和绘制 90→17、分层和合成提交 302→203、输入派发 96→83、主线程总任务 830→402 毫秒/手势秒。继续增加视口分层并取消工具栏模糊的组合让分层和合成提交涨至 495 毫秒/秒，收益倒退。

建议先做大图低缩放时静态显示边，保留较高缩放的既有动画和减少动态效果设置。开发与验收粗估 1–2 人日。正式确定门槛前，在日常缩放、鼠标/触摸板/触屏、切换和取消状态下复测，并覆盖普通设备。此外可做标签分级和视口裁剪，但前者增加标签可访问性与视觉反馈成本，后者要验证可见集合、边与焦点切换，粗估 2–5 人日。当前数据支持低缩放原型达到合并样本目标。
