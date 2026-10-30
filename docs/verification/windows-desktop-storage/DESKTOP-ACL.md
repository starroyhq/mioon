# Windows 桌面私有存储接入验证

日期：2026-10-30。分支 `claude/windows-desktop-storage`，基线 main `f6e8340`。依据是 [平台门槛](../../PLATFORM-RELEASE-GATES.md) 的 R2；ACL 后端本身的原生验收见 [CLI-SDK-ACCEPTANCE](../ai-workflows-acceptance/CLI-SDK-ACCEPTANCE.md)。

## 改动

- `packages/node-host` 新增 `initializeDesktopPrivateStorage(helperFile)`：只在 Windows 的 Electron 内注册，宿主给出确切的组件文件，不做搜索；路径不是绝对路径、不是 `.node`、文件缺失或不兼容时，以 `STORAGE_PRIVACY_UNAVAILABLE` / `WINDOWS_HELPER_UNAVAILABLE` 拒绝，存储保持关闭。无界面入口仍拒绝在 Electron 内运行。
- 桌面主进程在第一次访问存储前注册（与 `prepareDesktopStorage` 同一失败路径），并把同一路径交给后端 utilityProcess；后端在启动服务前注册。开发运行时组件在 `build/native/`，打包后在 `resources/native/`。
- `apps/desktop/scripts/build.ts` 在 Windows 上把组件放进 `build/native/`，缺失时报错。
- 自带 POSIX 检查的桌面模块在 Windows 上改走存储后端：退出与渲染诊断的有界 JSONL（读出、追加、原子替换，轮换为复制后删除）；LUT 恢复记录的身份比较改用 `samePrivateStorageIdentity`，目录落盘用后端的已验证句柄；导出校验用后端句柄分块读取并比较完整文件身份；开发冒烟检查以后端的私有校验代替 `0600` 模式。POSIX 路径不变。
- 组件缺失时的启动提示改为说明缺少随应用提供的组件并建议重新安装；存储提示中“现有数据保持原样”与处理建议之间补上换行。

## 环境

- Windows 11 build 26200，ARM64，Parallels 隔离克隆 `Mioon CLI Acceptance 20261021`；原 VM 未改动。
- 便携 Node 24.21.0、Visual Studio 2022 Build Tools 17.14 与 Windows SDK、Python 3.13；`pnpm 11.25.0` 冻结安装。
- Electron 44.7.0（内置 Node 24.21.0），开发渠道 staging。

## 结果

| 项 | 方法 | 结果 |
| --- | --- | --- |
| 组件编译 | `pnpm --filter @mioon/node-host build:native` | 通过，包含 `win_delay_load_hook` |
| Electron 加载 | 临时探针：主进程与 utilityProcess 各自加载同一 `.node`、注册后端、创建私有目录并读写 | 两侧能力均为 `windows-current-user-acl`；目录关闭继承，仅 SYSTEM 与当前用户 |
| 构建 | Web `vite build` 与 `apps/desktop/scripts/build.ts --channel=development` | 通过；`build/native/mioon_private_storage.node` 存在 |
| 正常启动 | userData 为 `%LOCALAPPDATA%` 下新目录 | 不再报隐私不可用，停在“配置视频工具”；userData 与 `desktop-identity.json` 关闭继承、仅 SYSTEM 与当前用户；Chromium 缓存继承同一 ACL |
| 不安全祖先 | userData 位于继承 `Authenticated Users` 修改权限的目录下 | 提示“数据目录未通过隐私检查”，未创建目录 |
| 错误 ACL | 已有 userData 额外授予 `Users` 读取 | 同样拒绝；该 ACE 原样保留，身份文件保留 |
| 缺少组件 | 暂时移走 `build/native` 中的组件 | 提示“缺少 Windows 存储保护组件”，建议重新安装 |
| 第二用户 | `tests/windows-desktop-storage-two-user.ps1`：普通权限 `-Prepare`，一次性计划任务以最高权限 `-Verify`，再 `-Cleanup` | 临时标准用户能列出探针父目录，读取 `desktop-identity.json` 与列出 userData 均被拒；临时账户、计划任务与探针目录清理为 0 |
| 原生测试集 | 原生存储、流式、竞态、存储规则、node-host 冒烟、旧存储门槛、备份发布与集成、无界面凭据、`desktop-windows-storage` | 除两项无界面凭据测试外均通过；备份集成单独运行也通过。这两项在同一 VM 上对未改动的 main `f6e8340` 同样以“超过时限”失败（Windows 凭据管理器在 VM 中较慢），与本改动无关 |

`windows-backup-integration-native.test.ts` 原先写死 schema 60/61，只在 Windows 上运行，所以 schema 升级后一直未被发现；现改用当前 schema 常量。

## 未覆盖

- 桌面后端尚未在 Windows 上启动：VM 中没有 FFmpeg/ffprobe，应用停在工具配置。工作区数据库、媒体、导出、诊断写入、LUT 恢复和导出校验的 Windows 分支只有 macOS 单元测试与代码审查。后端在 utilityProcess 中加载组件已由上面的探针在同一 Electron 上验证。
- 开发冒烟脚本 `apps/desktop/scripts/smoke.ts` 依赖仅支持 POSIX 的 `migrate-data` / `migration-restore-guard`，尚未移植到 Windows。
- legacy 手工草稿与 `project.delete` 的草稿保护流程在 Windows 上按设计拒绝，未在桌面端核对其表现。
- Windows 安装包（`resources/native` 的放置）、x64、签名与 per-user 安装待另行决定。
