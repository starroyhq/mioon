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

## 合并后补充

同日在已包含本改动的 main `0e43f47e` 上补测，同一台 VM。FFmpeg/ffprobe 用 BtbN 预编译的 n7.1.5 winarm64 GPL 版（与 CI 同为 7.1 系列），只在测试 VM 中使用，不随应用分发。

| 项 | 方法 | 结果 |
| --- | --- | --- |
| 桌面后端流程 | 用 `MIOON_FFMPEG_PATH` / `MIOON_FFPROBE_PATH` 启动开发构建，经已认证的本地 RPC 新建项目、导入真实 H.264/AAC 片段、加入时间线并导出 | 后端在 utilityProcess 中启动，主窗口显示项目列表；导出成功，已认证请求取回 366,850 字节 `video/mp4`，未带令牌的请求返回 401；`workspace/media` 中的文件只继承当前用户与 SYSTEM；`diagnostics/backend-exit.jsonl` 关闭继承，记下 start 与 ready 两条 |
| 桌面模块原生测试 | `tests/windows-desktop-storage-native.test.ts`：经无界面入口加载同一组件，直接调用桌面模块 | 3 项通过。诊断：轮换、超大文件丢弃、超长行拒绝，外来授权拒绝且不修复；LUT 恢复记录：重命名覆盖后身份不变，暂存与发布之间被改写判为冲突并清理暂存文件，外来授权拒绝；导出校验：打开与显示前分块计算哈希，摘要或大小不符、硬链接都拒绝，中途撤销后句柄已释放 |
| 测试有效性 | 临时去掉导出校验中的 `handle.close()` | 该项以 `EPERM` 失败（组件打开文件时不允许删除共享），恢复后通过 |

## 未覆盖

- 界面里的“打开导出文件”“在资源管理器中显示”和 LUT 导入恢复没有在 Windows 上实际点击；对应模块由上面的原生测试直接调用。实际运行中诊断文件没有达到轮换上限。
- 开发冒烟脚本 `apps/desktop/scripts/smoke.ts` 依赖仅支持 POSIX 的 `migrate-data` / `migration-restore-guard`，尚未移植到 Windows。
- legacy 手工草稿与 `project.delete` 的草稿保护流程在 Windows 上按设计拒绝，未在桌面端核对其表现。
- Windows 安装包（`resources/native` 的放置）、x64、签名与 per-user 安装待另行决定。
