# 桌面打包入口与 Web 源码新鲜度

当前增量基线：`783fae70b1aae4d6b032df573d0e1ee9d45c4359`，2026-10-13。本片将四个 Linux 打包入口接到既有完整构建流程，保持渠道、输出目标、安全配置和关闭发布的行为。应用运行代码、依赖与锁文件未改。下方保留的 macOS 记录属于历史单独修复，不是本次原生平台复测。

## 当前六个入口

| 桌面 workspace 脚本 | 先执行的完整构建 | builder 后续参数 |
| --- | --- | --- |
| `package:linux` | `node ../../scripts/tooling.mjs build --channel=production` | `--config electron-builder.cjs --linux --publish never` |
| `package:dir` | 同上 | `--config electron-builder.cjs --linux --dir --publish never` |
| `package:mac` | 同上，原有入口未改 | `--config electron-builder.cjs --mac --publish never` |
| `package:linux:dev` | `node ../../scripts/tooling.mjs build --channel=development` | `--config electron-builder.dev.cjs --linux --publish never` |
| `package:dir:dev` | 同上 | `--config electron-builder.dev.cjs --linux --dir --publish never` |
| `package:mac:dev` | 同上，原有入口未改 | `--config electron-builder.dev.cjs --mac --publish never` |

完整流程先核验已安装的本地工具和严格类型，再运行 Vite 生成当前 Web，随后构建同渠道桌面暂存；最后才由既有 `&&` 执行 electron-builder。生产渠道仍为 `app.starroy.mioon` / `mioon`，开发渠道仍为 `app.starroy.mioon.dev` / `mioon-dev`，输出分别在 `release/desktop/production` 与 `release/desktop/development`。Linux 目标仍为 x64 的 tar.gz 或解包目录，本片不新增安装器、更新器、签名或发布。

从仓库根目录，四条当前 Linux 命令可独立使用，不需要先手动构建 Web：

```sh
pnpm desktop:package:linux
pnpm --filter @mioon/desktop package:dir
pnpm desktop:package:linux:dev
pnpm --filter @mioon/desktop package:dir:dev
```

四条命令共用 Web dist 和桌面暂存，只能串行执行。根目录两个 `desktop:package:linux*` 别名保持原样。直接 `build`、`build:production`、`desktop:build*` 和 `start` 没有改成完整打包流程；直接运行桌面暂存脚本仍由调用方先准备新鲜 Web 输出。已有 Web 开发服务和业务 API 不受影响。

## 已复现的问题与核验边界

旧四条 Linux 命令只调用桌面暂存脚本。该脚本验证类型和版本、检查 `dist/index.html` 存在，然后复制已有 dist；合法的旧 dist 会被接受。真实反例已在隔离工作树运行原 `package:dir`：刻意置入两个带唯一旧标记的生成文件，不预构建 Web，实际打包 exit 0 后 ASAR 仍保留两个文件/两处标记。旧版本与身份检查通过不能证明 renderer 与当前源码一致。

先修改严格契约测试、保持旧入口时，实际 20 项中 15 通过、5 失败，准确拒绝四个旧 Linux 前缀和对应身份入口。最小修复只有四个 manifest 前缀替换；修复后串行受影响检查 **91/91**，0 失败/0 跳过，3.028 秒。测试使用真实 `parseArguments`、`buildCommands`、`buildChannel` 和 builder 配置，核完整 argv、Web→stage 顺序/cwd、六入口渠道、目标/目录与禁用发布，并保留明确错误变体检查。静态契约不替代真实包内容核验。

四入口的真实产物验收均已完成，实际命令与检查器分别 **exit 0**：每条命令前分别置入不同的旧 dist，保存旧生成输出并隔离已有同渠道包，不额外预构建。四次均核验全部三个 Web 文件的路径、大小和 SHA 在 dist→stage→ASAR 完全相等；旧标记为 0，旧文件消失。两个归档均有 80 个条目，gzip、tar 内 ASAR、完整可执行文件和固定字幕资源与各自本次目录包完全相同。两个 `--dir` 的全新渠道输出中均无 tar.gz，未借用先前归档。

| 实际产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| 生产 ASAR（两入口相同） | 4628172 | `1a274219f58289341107d0ca9de8fdcca2284ccf47eff880acbe7f768f7376d1` |
| 开发 ASAR（两入口相同） | 4628191 | `673ff0de85c69800b6fb46f3759b1ac7fea581abebd33531b40cfe02b69cce35` |
| `mioon-0.4.1-linux-x64.tar.gz` | 133432835 | `e95109d9eea82baa377f98566b04e889459ad169c0859036e19500c5d9bdd0e0` |
| `mioon-dev-0.4.1-linux-x64.tar.gz` | 133433019 | `c4c9a9e5e712fd4c1ae9cc6b4d0c4aab055ac5aa24903aa18ec9f3675d59ca43` |

独立只读审查重算了四份 ASAR、四次 Web/stage 清单与两个归档的哈希并一致。入口改用既有 tooling 后，暂存构建 cwd 从 desktop 目录变为仓库根；main/backend bundle 与前次应用验收产物的完整差异只涉及源码路径注释及两个模块初始化器的调试键，栈标签可能不同。它们并非逐字节相同的产物，因此不把前次原生运行写成本次新包运行。受影响门和四条真实打包门已通过。随后父级对本次最终源码执行严格类型检查与独立串行全量，实际均 exit 0：**5958 项 / 5956 通过 / 0 失败 / 2 项既有平台跳过**，1080459.215382 ms。全量后仅补本文终态事实，未改变产品、测试或包产物。

本次新工作树实际通过 frozen offline 安装建立依赖链接：397 个包复用、0 下载，锁文件和供应链政策未变。首次旧入口打包因默认只读 `/home/agent/.cache/electron` 的 EROFS 失败并保留；将单次命令的 `XDG_CACHE_HOME` 指向既有工作区缓存后重新执行。builder 日志包含下载字样，未做网络抓包，不宣称全程无下载或网络尝试。Electron 44.7.0 缓存 ZIP 的 SHA 与锁定官方包自带 `checksums.json` 对应；两份许可证按既有独立容量上限逐字节核对。首次 QA 检查错误地假设 npm 包内已经存在 `dist/LICENSE` 的失败也保留，后改为核该精确官方 ZIP 的固定成员。

本片不重复启动应用，不把产物比对称为新的 GUI/音视频验收。此前真实 Linux 应用证据保持其原源码归属；macOS/Windows、签名、公证及 live-provider 门不受影响。

---

以下为历史记录；“本次”“其他平台保持原状”等叙述仅指当时的 macOS 两入口修复，不描述上方当前 Linux 增量。

# 历史 macOS 单独修复记录

本次范围：发布审查 R4，源码基线 `8c694d191e6c90379c32c9f8db0a778c35c31e14`。只调整两个 macOS 打包入口，不是原生发布验收。

原入口直接运行 `apps/desktop/scripts/build.mjs`。该脚本只检查 `apps/web/dist/index.html` 存在，随后复制现有 Web dist；源码更新后，旧 dist 仍可能被打入新桌面包。

两个入口现改为从桌面 workspace 调用仓库已有的完整构建流程：

| 桌面 workspace 脚本 | 构建前置命令 | builder 配置 | appId |
| --- | --- | --- | --- |
| `package:mac` | `node ../../scripts/tooling.mjs build --channel=production` | `electron-builder.cjs` | `app.starroy.mioon` |
| `package:mac:dev` | `node ../../scripts/tooling.mjs build --channel=development` | `electron-builder.dev.cjs` | `app.starroy.mioon.dev` |

脚本工作目录是 `apps/desktop`，所以 `../../scripts/tooling.mjs` 指向仓库根目录下的工具。tooling 根据自身模块路径定位仓库，先检查本地构建前提，再串行运行 Web workspace 的 Vite build 和所选渠道的桌面暂存构建。后者将本次 Web 输出复制进 `apps/desktop/build/web`。只有前置命令成功，`&&` 才会继续执行原有 `electron-builder --config … --mac --publish never`。

生产与开发渠道仍使用各自 appId 和输出目录；Web 构建由两渠道共用，桌面身份由显式 `--channel` 决定。builder 的 `publish: null`、macOS `identity: null` 和目标配置均未修改。其他平台、直接桌面 build/start 脚本保持原状；直接调用桌面暂存脚本仍要求调用方先准备 Web 输出。

## 静态验证

在仓库根目录运行：

```sh
env -u NODE_OPTIONS -u NODE_PATH node --test --test-concurrency=1 tests/desktop-package-entrypoints.test.mjs
```

测试仅使用 Node 内建模块及仓库现有纯函数：读取真实 manifest、从桌面工作目录解析入口路径、用 `parseArguments` 验证 CLI 参数、用 `buildCommands` 核验 Web→desktop 命令顺序和 cwd，再用 `buildChannel` 和真实 builder 配置核对渠道、appId 与禁用发布。构造的 Vite 路径是合成输入，测试不会解析或执行已安装工具，也不会调用 tooling CLI、构建脚本、electron-builder 或 `beforePack`。

回归检查同时拒绝旧的仅桌面暂存入口、渠道错配、移除条件执行和启用发布，并锁定其余脚本不变。静态通过不证明构建产物、DMG、签名、公证、Gatekeeper、安装或应用运行成功。

本轮使用 Node v26.9.0 执行上述命令，结果为 4 项通过、0 失败、0 跳过。改动前，同一测试中的两个 Mac 入口检查均因指向旧桌面暂存入口而失败。

## 父级集成验证

`tests/desktop-identity.test.mjs` 中的 `package commands explicitly rebuild the correct channel before electron-builder` 测试（基线第 78–85 行，断言在第 81–82 行）硬编码 `build.mjs --channel=… && electron-builder`。这两条旧正则会拒绝新的正确 Mac 入口，需父级同步调整为入口及渠道契约验证；该已有文件不在本次允许修改范围，因此保留原样。Mac 子任务未运行该整套测试。父级集成已将该处改为逐平台、逐渠道的完整命令等值断言；最终运行结果另行记录，不据新增静态测试通过宣称全量回归通过。

本轮未安装依赖，未执行真实 Web/desktop 构建、打包、签名或任何 native 验收。真实环境验证仍需另行完成；本次未改变相关发布门槛。
