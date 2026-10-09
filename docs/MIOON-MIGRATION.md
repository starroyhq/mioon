# Mioon 命名与升级

产品、登录页、页面标题与 Electron 窗口统一为 **Mioon**；开发渠道为 **Mioon Dev**。两个渠道的既有 ID 和数据根保持不变：`app.starroy.mioon`、`app.starroy.mioon.dev`。

## 当前入口

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm desktop:build
pnpm desktop
pnpm exec mioon --help
MIOON_BASE_URL=http://127.0.0.1:4318 MIOON_TOKEN_FILE=/absolute/data/access-token pnpm exec mioon doctor
```

- npm workspace：`@mioon/*`；CLI：`mioon`；桌面可执行文件：`mioon` / `mioon-dev`
- MCP server 名称：`mioon`；发现工具：`mioon_schema`、`mioon_doctor`、`mioon_capabilities`。业务操作及对应工具名称不变
- 配置环境变量统一为 `MIOON_*`，包括 `MIOON_DATA_DIR`、`MIOON_CONNECTION_FILE`、`MIOON_BASE_URL`、`MIOON_TOKEN_FILE`、`MIOON_TOKEN`、`MIOON_FFMPEG_PATH`、`MIOON_FFPROBE_PATH`、`MIOON_DESKTOP_USER_DATA` 和 `MIOON_ENABLE_LIVE_PROVIDER`
- 服务商自身的密钥/区域变量名称保持不变。只有当前名称启用功能；旧环境变量不会被读取，旧 CLI 与包名没有兼容别名
- Web 会话 cookie 改为 `mioon_session`。浏览器需要重新登录一次；Electron 自动建立本地会话。登录时清除旧 cookie

## 现有项目、媒体与恢复记录

启动新版本前正常关闭旧版本窗口/后端。已有 Mioon 应用 ID 目录、SQLite 业务数据、媒体路径、项目 ID、版本、时间线历史和请求日志保持原位。数据库格式文件名 `workbench.sqlite` 是通用工作区数据格式名，不是旧产品入口。

浏览器在打开项目前一次性迁移本地视图与请求恢复记录：

- `frame.project` → `mioon.project`
- `frame.workspace.v1:<projectId>` → `mioon.workspace.v1:<projectId>`
- `frame.pending.v1:<projectId>:<key>` → `mioon.pending.v1:<projectId>:<key>`

迁移先预检所有目标，原样复制字符串并逐字验证，全部确认后才删除旧键。请求的 operation、input、requestId、原始 JSON 字节不重写；不调用服务商，不重新提交生成，不制造新的 requestId。相同的目标记录可安全恢复中断迁移；不同的目标记录会阻止继续，不覆盖任何一方。写入/验证失败保留源记录并阻止请求提交。修复存储问题后可重试。浏览器禁止 localStorage 时服务端视图仍可使用；请求会话存储不可用则安全阻止提交。

新版本只读写 Mioon 名称；旧名称只出现在一次性迁移源和历史事实说明中。旧版窗口不得与新版并行操作同一浏览器存储。Git 历史、历史验收材料/安装包和用户原始文件不改写。仓库所在目录无需重命名。

已有更早版本独立目录的项目仍可使用 [桌面数据复制工具](DESKTOP.md#数据位置与单实例) 显式迁入空目标。该工具不猜测、删除或合并数据，也不复制凭据。
