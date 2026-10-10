# macOS 打包入口与 Web 构建新鲜度

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
