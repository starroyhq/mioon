# 命令行启动器与 Mioon 的协议 v1

已运行的 Mioon 在 macOS 通过 Unix 域套接字代执行。正式渠道的命令是 `mioon`，应用 ID 是 `app.starroy.mioon`。开发渠道的命令是 `mioon-dev`，应用 ID 是 `app.starroy.mioon.dev`。启动器编译时固定应用版本和渠道。业务调用在应用未运行时退出，由用户打开应用后重试。

## 发现

从与渠道对应的应用数据目录读取 `mcp-connection.json`。默认目录是 macOS 用户 Application Support 下以应用 ID 命名的目录。测试或自选目录可由显式 `MIOON_CLI_USER_DATA` 指定，仍须校验渠道。现有描述符字段 `version: 1`、`url`、`pid`、`tokenFile`、`appId`、`channel` 保留。旧的源码 CLI/MCP 使用原有 HTTP 字段。带运行时的描述符还包含以下字段。

```json
{
  "appVersion": "0.4.0",
  "cli": {
    "protocol": 1,
    "socket": "/absolute/private-directory/cli.sock",
    "tokenFile": "/absolute/app-data/cli-token"
  }
}
```

`channel` 为 `production` 或 `development`。`pid` 是当前本机服务的 PID，用于判断描述符是否过期。`cli.tokenFile` 与描述符同目录。令牌是 32 字节随机值的 64 字符小写十六进制文本，文件末尾有换行。读取时去掉末尾换行。每次宿主启动分配新的令牌和套接字路径。套接字目录为 `0700`，套接字、描述符和令牌文件为 `0600`，归当前用户所有。读描述符和令牌时校验文件类型、所有者、权限及大小，拒绝符号链接。描述符最大 16 KiB，令牌文件最长 65 字节。

套接字路径以描述符为准。通常在应用数据目录里的私有临时子目录；路径过长时用系统临时区里的短私有目录，仍是 Unix 套接字。缺少 `cli`、进程已结束或无法连接时命令行退出 4。启动器只读取 `cli.tokenFile` 作为握手令牌，`tokenFile` 属于原 HTTP 通道。

## 握手

所有整数是大端字节序。客户端发送这三段，允许一次写入或任意分片。

1. 9 字节 magic `4d 49 4f 4f 4e 43 4c 49 00`（`MIOONCLI\0`）。
2. 无符号 16 位协议版本 `1`。
3. 无符号 32 位 JSON 字节数，紧跟无 BOM 的 UTF-8 HELLO JSON。

```json
{
  "protocol": 1,
  "channel": "development",
  "launcherVersion": "0.4.0",
  "appVersion": "0.4.0",
  "token": "<64 lowercase hex characters>",
  "role": "cli",
  "argv": ["--help"]
}
```

HELLO 的七个字段必填，可另传 `cwd`，总长最多 1 MiB（1,048,576 字节）。`argv` 最多 256 个 UTF-8 字符串，允许空参数，拒绝 NUL 和非法 Unicode。版本字段为 1–64 字节的 ASCII 版本标识。`appVersion` 来自描述符，`launcherVersion` 来自启动器。两者、两处协议版本及渠道必须与运行中的应用完全一致。普通命令以 `cli` 为角色。`mioon mcp` 或 `mioon-dev mcp` 以 `mcp` 为角色，去掉作为角色选择的首个 `mcp` 参数，其余参数原样发送。

启动器用 `getcwd()` 传递终端当前目录，从而保留 `--input-file`、`--file`、`--output` 的相对路径语义。`cwd` 为无 NUL、最多 4096 字节的 UTF-8 绝对目录路径，省略时使用应用数据目录。宿主检查令牌，随后只按角色启动 ASAR 内固定的 `cli-runtime.cjs` 或 `mcp-runtime.cjs`。目录只用于 utility 的工作目录。模块路径和进程环境由宿主选定。[Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)

响应从第一个帧头开始。READY 的 JSON 为 `{"protocol":1,"appVersion":"0.4.0","channel":"development"}`。启动器核对三项后才能发送流帧。拒绝时用 ERROR 帧，正文至少含 `code`。已认证的不一致可另带 `launcherVersion`、`appVersion`、`channel`，供启动器格式化错误。

| `code` | 含义 |
| --- | --- |
| `CLI_PROTOCOL_ERROR` | magic、JSON、字段、帧或时序不合法 |
| `CLI_AUTH_FAILED` | 令牌错误 |
| `CLI_VERSION_MISMATCH` | 协议、应用版本或渠道不一致 |
| `SESSION_LIMIT` | 已有 8 条连接，包含握手中的连接 |
| `CLI_RUNTIME_UNAVAILABLE` | 应用或固定运行时暂不可用 |

握手阶段最长 5 秒。启动器遇到 ERROR 时按 CLI 的结构化错误格式返回，退出 4。MCP 握手失败只向 stderr 写诊断，退出 1。版本或渠道不符使用提示「命令行工具来自 Mioon X，当前运行的是 Y，请在 Mioon 设置里修复命令行工具。」英文为 “The command-line tool is from Mioon X. Mioon Y is running. Repair the command-line tool in Mioon Settings.”。X、Y 分别取启动器版本和当前应用版本。启动器根据结构化字段生成这句提示。

## 字节流

每帧有 5 字节帧头，由 1 字节类型和无符号 32 位 payload 字节数组成，随后是 payload。每帧 payload 最多 1 MiB，长输入拆帧，stdout 和 stderr 分别传输原始字节。帧可以跨多个 socket 读写。

| 类型 | 方向 | payload |
| --- | --- | --- |
| 1 STDIN | 启动器 → 应用 | 非空原始字节 |
| 2 STDIN_EOF | 启动器 → 应用 | 空。结束 stdin，仍接收输出和退出码 |
| 3 STDOUT | 应用 → 启动器 | 非空原始字节 |
| 4 STDERR | 应用 → 启动器 | 非空原始字节 |
| 5 CANCEL | 启动器 → 应用 | 空。停止当前会话，CLI 报退出 130 |
| 6 EXIT | 应用 → 启动器 | UTF-8 JSON `{"code":0}`，可选 `signal` 字符串 |
| 7 READY | 应用 → 启动器 | 握手成功的 UTF-8 JSON |
| 8 ERROR | 应用 → 启动器 | 拒绝或协议错误的 UTF-8 JSON |

STDIN_EOF 只发送一次，之后可发 CANCEL，不能再发 STDIN。发完 STDIN_EOF 保持连接打开，等待 EXIT。主进程按背压转发，先传完子进程输出，再发 EXIT。启动器将两个流写入对应描述符，退出码原样传回。SIGINT 发送 CANCEL 或在连接不可用时本地退出 130。连接异常中断、应用退出或重启时，宿主回收会话；启动器收到 EXIT 前失去连接则按运行时不可用退出 4。CLI 会话上限 5 分钟，MCP 可保持长连接。MCP stdout 仅传 stdio 协议消息。

本机启动令牌只用于套接字握手。业务请求继续通过应用已有的本机 HTTP 后端和私有描述符完成。启动器环境不传给 utility，Electron fuse 和应用授权规则沿用现有设置。

## 开发包验证

构建并解包 macOS 开发渠道后，用 `node apps/desktop/scripts/cli-runtime-packaged-qa.ts "<Mioon Dev.app 的路径>"` 验证真实 ASAR。脚本创建临时 HOME 和应用数据目录，给应用空 PATH，以及明确的 FFmpeg、FFprobe 路径。它直接按本协议访问运行时并检查退出、权限和 MCP 目录。可通过 `MIOON_FFMPEG_PATH` 和 `MIOON_FFPROBE_PATH` 指定工具。

## 第 23 分区

设置桥使用已定的 `mioon:external-agents:v1` 契约。K2-B 提供 `cli.status`、安装、卸载和修复底层能力。安装目录来源是默认位置或主进程原生目录选择票据。状态区分未安装、已安装、需要修复和安装失败，包含绝对命令路径、版本、管理归属、三态 PATH 检查和两条 MCP 配置命令。握手的 `CLI_VERSION_MISMATCH` 对应需要在 Mioon 设置里修复命令行工具。
