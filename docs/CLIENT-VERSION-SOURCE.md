# CLI / MCP 客户端版本来源

下方 Mac 与云端验收保留当时命令和结果；当前同名测试使用 `.test.ts`，执行入口见 [TYPESCRIPT.md](TYPESCRIPT.md#current-test-migration-2026-10-26)。

日期：2026-10-10（UTC）。基线：`8c694d191e6c90379c32c9f8db0a778c35c31e14`。

## 修改与权威来源

根 `package.json` 的应用版本为 `0.4.1`，客户端原先将 `VERSION` 固定为 `0.4.0`。本次仅在 `packages/client/src/index.ts` 增加一行导入、替换一行声明：

```js
import applicationPackage from '../../../package.json' with {type: 'json'};
export const VERSION = applicationPackage.version;
```

`apps/desktop/build-metadata.ts` 的 `validateBuildMetadata()` 已明确以根清单为应用版本权威，并要求桌面清单与其一致。因此不采用仍为 `0.4.0` 的 `packages/client/package.json`，也不让客户端依赖会额外读取桌面清单、校验 Electron pin 的桌面构建辅助模块。

既有调用方继续使用同一个导出：

- CLI 的帮助信息与 `--version`。
- MCP `Server` 初始化时的应用版本元数据。
- 未指定 `operation` 时 schema 目录结果的 `version` 与 doctor 的 `clientVersion`。

未调整 RPC 路由、请求/响应结构、错误语义或连接解析。`apps/server/src/index.ts` 的 `/health` 仍独立报告 `0.4.0`，doctor 的 `backend.version` 保留后端原值；工作区子包版本、连接描述文件版本和 MCP 协议版本均不在此次修改范围。

## 路径与交付布局

静态导入相对于 `packages/client/src/index.ts` 解析，向上三级即仓库根目录，不依赖 shell 当前目录。源码搬迁时须保留根 `package.json` 和 `packages/client/src` 的相对布局；缺少根清单会明确导入失败，没有退回 cwd 清单或硬编码版本的行为。

当前布局依据：

- `packages/client/package.json` 的主导出指向 `./src/index.ts`；CLI / MCP 通过 `@mioon/client` 使用该源码。
- `scripts/package-v4.py` 的源码复制列表同时包含根 `package.json`、`apps` 与 `packages`，并保留相对路径。本次只读该脚本，未执行归档。
- `apps/desktop/scripts/build.ts` 仅将桌面的 `main` 与 `backend` 打包为 CJS，并写入以根应用版本为来源的 staging 清单。当前桌面及后端依赖图未引用 `@mioon/client`。
- `docs/CLI.md`、`docs/MCP.md` 明确其为依赖源码工作区的入口，当前没有独立 CLI / MCP 安装包或桌面内置的对应可执行文件。

因此这里验证的是现有源码布局。静态 JSON 导入给构建工具提供可解析的依赖，但本次没有执行 bundler 或检查生成包，不能据此宣称任意未来单文件 CLI / MCP 或桌面包已验证。以后新增独立交付方式时，须明确内联根清单版本或保留所需文件，并对最终产物验证。

## 原 Mac 隔离验证（历史结果）

在 Mac 隔离工作区、分支 `codex/client-version-source-67c81ad4`，使用本机 Node `v26.9.0` 执行：

```sh
env -u NODE_OPTIONS -u NODE_PATH node --test tests/client-version-source.test.mjs tests/desktop-build-metadata.test.mjs
```

最终退出码 `0`：**19 项，18 通过，0 失败，1 明确跳过**。其中新增测试为 6 通过、1 跳过；既有桌面元数据测试 12 项通过。首轮曾有 1 项新增源码断言误把 `help(operation)` 写成无参数函数匹配，已按真实签名及空白格式修正后重跑；生产修改未因此改变。

新增检查覆盖：

1. 生产源码中的导入路径确实定位根清单，且与现有桌面构建元数据读取结果一致。
2. 从生产文件提取原样的版本导入和声明，在临时合成源码树内以真实 Node ESM 执行；使用当前根清单，验证客户端自身清单和其他 cwd 清单不会覆盖版本。
3. 仅改变根清单，下一次进程启动即读取新版本，完整保留 prerelease / build 信息。
4. 将整个合成源码树搬到带中文、空格的目录，仍可从无关 cwd 读取正确版本。
5. 根清单缺失时导入失败，不伪造成功版本。
6. 对 CLI、MCP、schema 与 doctor 进行源码消费关系检查。

未初始化的依赖为 `@mioon/contracts`、`zod`、`zod-to-json-schema`，因此完整客户端导入与实际 `discoverSchema()` 检查明确跳过，不能计为通过。测试只在依赖预检遇到 `MODULE_NOT_FOUND` 时跳过；依赖存在后的模块初始化或运行错误会正常失败。未安装依赖，也没有借用其他工作区的 `node_modules`。

执行版本切片不等于完整 CLI / MCP 初始化；消费关系检查不等于 MCP 握手或 doctor HTTP 验证。桌面元数据测试使用合成清单及只读构建脚本检查，不生成桌面产物。项目要求 Node 24+，本轮未另行验证 Node 24 运行时。未构建、打包、启动应用/后端、读取真实凭据或媒体、调用网络服务、提交或推送。


## 云端整合与补验：2026-10-10

整合基线为 `3ece477`。补丁原始字节数和 SHA-256 已逐份校验；旧客户端 hunk 因 Comfy 新导入产生上下文冲突，最终仅手工添加同一根清单导入并替换 VERSION 声明。Comfy 请求、恢复、校验与全部旧路由保持不变。

独立源码审查确认：MCP SDK 分别返回 `serverInfo.version`（实现版本）与由支持日期列表协商的 `protocolVersion`（协议版本）。本改动只影响前者。连接描述文件仍为整数 `1`，后端 `/health` 仍报告原 `0.4.0`，不是把全部版本数字强行统一。

新增测试扩充到 10 项，在已安装依赖的 Linux Node `v24.19.0` 全部通过、0 跳过：除原 7 项外，实际启动 CLI 验证 `--version`、help 和 schema；通过官方 MCP SDK/stdio 完成 initialize、list 和 schema，验证实现版本为根版本且协议日期独立；注入合成 HTTP 响应证明 doctor 不改写不同的 backend.version。没有真实 provider 请求、密钥读取或原生 Keychain 调用。

整合聚焦套件 136 项、134 通过、0 失败、2 项既有环境跳过；跳过的是需要 POSIX 更换所有者能力和原生 Windows 的文件凭据检查。此处版本、Keychain 与 timeline 新审查无跳过。fresh Web/main/backend build 已通过；6 个关键产物（main、backend、staging 清单、Web HTML/JS/CSS）与前一原生验收版本逐字节同 hash。当前桌面依赖图不引用客户端，因此没有借版本元数据变更重建不同 UI 的假象。CLI/MCP 源码入口的实际启动结果已另外验证。最终父级独立 full 已通过：3035 项、3033 通过、0 失败、2 项上述既有环境跳过，716943.546 ms。没有独立安装包、签名或 Mac 原生运行验收。
