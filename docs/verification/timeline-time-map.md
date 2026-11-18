# 共享时间映射（SP-M）

这一层是 0.4.0 变速的纯函数合同：常速、log-PCHIP 曲线、倒放和定格共用同一个「不可变 basis + view + 输出窗口」模型。它不依赖 DOM、数据库、FFmpeg、墙钟或 I/O，不写项目数据，也不改项目格式（格式 6 由 SP-D 做）。

## 接口

`packages/contracts/src/timeline-time-map.ts`（`packages/contracts/src/index.ts` 已转出）。

- `compileTimeMap(basis, options?)` → `CompiledTimeMapRoot`：编译固定正向积分时钟 T；返回 `mapHash`、`durationFrames`、源/输出时间基和源范围。
- `initialTimeMap(root, direction?)`、`reverseTimeMap(plan)`、`splitTimeMap(plan, outputOffset)`、`trimTimeMap(plan, from, to)`：view/window 运算。切分只改输出窗口，不重拟合、不重取整；翻转只换遍历方向并保持输出长度；两次翻转恢复原采样。
- `timeMapRootFrames(root, direction)`、`timeMapPlanFrames(plan)` → `Int32Array`：逐输出帧的源时钟帧号（正放 floor、倒放 ceil−1，越界夹到合法源帧）；失败时返回 `UNRESOLVED_BOUNDARY` / `NUMERIC_BUDGET_EXCEEDED`。
- `timeMapVisibleSourceRange(plan)`、`timeMapSourceWindowForOutput(plan, {contextFrames?})`：可见连续源区间和严格整帧包络 `[floor(lo), ceil(hi))`（正放/倒放各自的取帧规则）。
- `timeMapSourceAtOutputFrame(plan, offset)`：连续源位置、显示源帧、相邻帧和相位；`timeMapOutputAtSourceFrame(plan, frame)`：某素材帧对应的输出帧区间（重复/跳帧是允许的，不宣称离散双射）。
- `timeMapTailInverse(plan, position, {tailInverse})`：尾端 ceil 余量 `[L, N)` 的显式广义逆，`earliest`/`latest` 由调用方选择，不读区间外。
- `compileFreezeTimeMap({sourceFrame, durationFrames})`：定格保持区间。
- `TIMELINE_SPEED_PRESETS`、`instantiateSpeedPreset`：八个预设的归一化点集和落到整数源帧的实例化；点集是权威，预设标签只是展示元数据。
- `projectSourceBoundaryToQ64`、`q64ToExactBoundary`：曲线新 basis 边界的 Q64 网格投影（最近值、ties-to-even，误差界跨过舍入边界时明确失败）。
- `timeMapVfrFrame(pts, sourceFps, position)`：VFR 适配，把连续源时钟位置映射到 PTS 帧 ordinal 和相位，不把源坐标当编码帧号。
- `timeMapBasisFromCurrentClip(clip, timeline)`、`projectTimeMapToCurrentClipFields`、`verifyCurrentClipTiming`：现有 clip 合同的读取/投影接缝；不新增格式字段。
- `timeMapSettingEquals(a, b)`：同值设置的严格无操作判定（只看权威字段，预设标签不影响）。
- `timeMapStableHash` / `timeMapStableJson`：跨运行时夹具用的稳定 JSON 和 FNV-1a/64。

## 数值 profile `timeline-time-map-v1`

- **常速**：全程 `BigInt` 约分有理数。长度 `L = (Fo/Fs)·S/r`（同 fps 即 P5 的 `ceil(S*q/p)`）、逆位置、floor/ceil、尾端与切分全部精确。
- **曲线**：log-speed PCHIP（Fritsch–Carlson，端点斜率公式固定在代码里），源坐标严格递增、含两端、最多 32 点。积分 `exp(−p(u))` 用版本化 double 流水线（只用 IEEE-754 `+ - * /` 和 `Math.round/floor/ceil`，不用 libm），因此 Node 和 Chromium 的整数输出逐位一致。常数速率的曲线（例如自定义恒等曲线）走精确有理路径，不付数值误差。
- **误差界**：每段自适应 Simpson 带局部误差估计和舍入余量；编译时给出根长度 `{value, errorBound}`，取样/窗口边界的整数判定只在误差界内唯一时通过。`UNRESOLVED_BOUNDARY` 只在根长度跨整数且两级精度都无法判定时返回（见测试里的 Q64 构造例）。
- **细化**：曲线积分精度阶梯固定为 `1e-11 / 1e-12 / 1e-13`；反求与边界判定逐级细化，达到预算仍无法唯一时按版本化 ties 规则处理帧边界（最后 `2^-30` 带内按最高精度估计值取 floor/ceil），根长度歧义则明确失败。ties 规则写进 profile，不会靠 epsilon 多取一帧。
- **预算**：曲线积分 cell 上限默认 1,000,000，可传 `maxCurveCells` 缩小；输出帧上限 300,000、源范围上限 3,000,000 帧、速率项上限 1,000,000、源边界有理数分量 128 bit。

## 八个预设（提交测试向量）

归一化点集（`position` 为源范围比例，`rate` 为倍速）。`none` 是 1× 基准，`custom` 是可编辑恒等曲线。

| 预设 | 点集 |
| --- | --- |
| none | 常速 1× |
| custom | (0, 1×), (1, 1×) |
| fastToSlow 先快后慢 | (0, 3×), (1/2, 3/2×), (1, 1/2×) |
| slowToFast 先慢后快 | (0, 1/2×), (1/2, 3/2×), (1, 3×) |
| slowMiddle 中段慢放 | (0, 2×), (1/2, 1/4×), (1, 2×) |
| fastMiddle 中段快进 | (0, 1/2×), (1/2, 4×), (1, 1/2×) |
| flashIn 闪进 | (0, 4×), (1/4, 1×), (1, 1×) |
| flashOut 闪出 | (0, 1×), (3/4, 1×), (1, 4×) |

在 `[0, 300)` 上实例化后，源帧点为 `custom [0,300]`、三个中段预设 `[0,150,300]`、`flashIn [0,75,300]`、`flashOut [0,225,300]`；输出长度依次为 `300/246/246/707/186/273/273`（逐点由测试固化，协调人审）。

## 切分、修剪与方向语义

- 片段保存不可变的 basis 和 `[outputFrom, outputTo)`；切分/修剪只改输出窗口，局部 `j` 查询 `outputFrom + j`，两段拼回逐帧等于切前。
- 常速切分保留精确有理相位：1.1× 的窗口 `[1,2)` 是 1 帧；先把端点压到 Q32 再重算的对照会得到 2 帧（测试里复现了这个反例）。
- 只改方向不重取整：翻转保留同一可见时钟区间和输出长度，`reverse(reverse(plan))` 恢复原采样。
- 新曲线 basis 的边界在这一次重建时投影到 Q64（最近值、ties-to-even）。旧窗口从不靠 Q64 重建。
- 反向采样是「反向遍历可见源范围」：正放 `[0,6)` 1.5× 为 `[0,1,3,4]`，反向为 `[5,4,2,1]`。

## 跨运行时门槛

- 测试夹具：`tests/fixtures/timeline-time-map/cross-runtime-v1.json`（29 组、7,128 个整数帧值、FNV-1a/64 hash `f115506a88ccc3cf`）。
- Node：`tests/timeline-time-map-cross-runtime.test.ts` 重算并逐字节比较。
- 浏览器：`node tests/browser_timeline_time_map.mjs --report <本地 json>`，无头 Chrome 计算同一 payload/hash 并与夹具比较；本机 Chrome 157.0.8103.79 通过，零后台/外部请求、零页面错误。夹具重新生成用 `node --experimental-strip-types tests/helpers/timeline-time-map-cross-runtime.ts --write`，只在审过点集/profile/ties 规则后运行。

## 性能

本机 M3 Max（Node 24）：输出 299,582 帧、32 点曲线——编译 33.1 ms，逐帧向量 775.4 ms；同一测试在 CI 上把这两项写进日志（`tests/timeline-time-map-performance.test.ts`）。峰值数据只描述这一隔离编译，不代表导出或持久化事务。

## 局限

- 这是纯合同层：格式 6 timing 字段、持久化、同步事务、导出/播放消费、后台代理和 Mio/MCP 工具都在 SP-D/P/E/V/U 卡。
- 曲线积分是双精度误差受控实现，不是形式化区间算术；误差界由自适应 Simpson 估计和内建余量给出，参考向量与 Decimal60 的 SP0 证据逐帧一致。
- 一个 basis 的源范围上限（3,000,000 帧）和速率项上限（1,000,000）是本卡的保守值，待协调人确认。
