# Mioon 名称统一验收

本轮将当前产品界面、登录/启动页、网页标题、Electron 产品名/程序名、npm workspace、CLI、MCP 与配置前缀统一为 Mioon。升级及破坏性名称变化见 [迁移指南](MIOON-MIGRATION.md)。不保留旧命令、包名或环境变量别名。

## 已完成检查

- 全量 Node 回归：428/428 通过，0 失败、0 跳过。日志：`evidence/mioon-rename/all-tests-final.log`
- 后续仅恢复历史数据测试夹具为真实旧目录名称；该测试组另跑10/10通过：`identity-tests-final.log`
- 浏览器存储迁移9项：原始字符串/请求 ID 不变、重复执行、目标冲突、配额失败、静默写坏、删除失败、精确请求恢复，以及 localStorage 读取被拒。失败情况下保留原记录且阻止危险提交
- 真实浏览器迁移通过：旧 `frame.*` 键删除、新 `mioon.*` 键存在，含缩进/末尾换行的 pending JSON 与原 requestId 逐字不变；未自动重放业务操作。另验证目标冲突时所有原记录保留并阻止启动。证据：`evidence/workspace-preferences/browser/storage-migration-audit.json`、`migration-conflict-audit.json` 与 `migration-conflict-preserved.png`
- 当前 @mioon 依赖重连及独立空目录安装，使用官方 registry、冻结锁文件与未修改的供应链检查。独立安装成功后 `mioon --version` 正常，旧 CLI 和旧包名链接不存在。安装使用 `--ignore-scripts`，未重装/启动第三方二进制安装脚本。日志：`clean-install.log`
- Web 及 Electron 源码构建通过；`pnpm run doctor` 检查 Node、SQLite、FFmpeg、ffprobe 通过
- 15个 shadcn 原始快照与源码哈希保持不变；Mioon import 的 installed hash 从固定上游源码按文档转换生成，并与当前 TSX 逐字比较
- 只读检查7个已有工作区数据库全部通过 quick_check，6个项目与36个媒体文件均可读，媒体 SHA-256 与既有记录一致。未迁移或重写业务数据库路径。报告：`existing-data-readback.json`
- 原生 Electron 重启后的真实画布截图已目视确认显示 Mioon：`evidence/workspace-preferences/native-restored-canvas.png`。真实未登录页面截图也已目视确认：`evidence/workspace-preferences/browser/mioon-login.png`。完整视图持久化、迁移与故障流程见对应工作区偏好验收

## 范围与边界

正式/开发 app ID 仍分别是 `app.starroy.mioon`、`app.starroy.mioon.dev`。既有项目 ID、素材、时间线、不可变版本和请求日志不因命名变化重建。

当前打包 QA 脚本默认定位 Mioon 对应渠道。显式 `--historical-v3` 模式只验证旧0.3.0安装包与它原有解包内容；该检查已通过，旧包未改名或改写，也不作为当前 Mioon 包的验收。

本轮未创建新安装包/源码交付包、推送、发布或部署；未进行真实服务商调用。当前生产/开发打包二进制运行与 macOS/Windows 实机验证不能由本次源码构建结果推出。旧名称仅在迁移源、历史验证和文档事实说明中出现；通用 workbench 组件/数据库格式名及视频帧概念保留。
