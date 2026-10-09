# V3 验收：Electron + pnpm monorepo + shadcn/ui Base UI

日期：2026-10-09。环境：自有 Linux 云电脑。未访问用户 Mac、未付费调用供应商、未提交/推送/部署/签名/公证/公开发布。

## 已实现与验证

- 8个 pnpm 工作区；业务/协议为唯一实现，HTTP、MCP与 Electron 共用
- Electron44.7.0 的独立 utilityProcess 实际运行 Node24.21.0 + SQLite3.53.4
- 正常生产 Web 构建与桌面打包暂存构建，锁定安装与异地数据目录复现
- 官方 shadcn/ui base-nova 的15个组件源文件，Base UI1.9.0 实际运行；无 Radix 替代
- 四个区域、React Flow、多轨剪辑、预览/导出、幂等与任务恢复、不可变资产/版本/快照均保留
- 原 v1/v2 交付 ZIP 的 SHA256 与历史交付记录完全一致

## 自动化与真实交互证据

- `evidence/v3/all-tests.tap`：146/146，全量 Node测试，无跳过。含原84项业务/API/MCP/视频测试和新生命周期、组件、桌面配置、迁移等测试
- `evidence/v3-browser/steps.json`：13项真实多轨浏览器流程，包括实际拖放、源裁剪、跨轨移动、冲突拒绝、状态丢失后精确重试、视频解码/播放、最终导出下载
- `evidence/v3-browser-v1/steps.json`：10项原有创作浏览器检查，包括模拟生成、不可变版本、比较/选用、MCP项目出现在UI、状态未知不重提
- `evidence/v3-ui-components/report.json`：12项键盘与组件交互，0页面错误。涵盖菜单与新建项目、焦点与ESC/再打开、选择器/typeahead、手动激活tab、折叠、slider/ruler、switch、dirty与删除确认；“继续”按钮实测对比度11.22:1
- `evidence/v3-desktop/smoke.json`：19项真实 Electron 原生运行检查，保留 Chromium sandbox，没有用 `--no-sandbox`。最后一项明确等待真实项目及时间线加载，视频解码为720×1280、10秒，在3秒处播放后截图
- `evidence/v3-clean-install/commands.log`：隔离目录 `pnpm install --offline --frozen-lockfile`、Web/桌面构建、应用doctor均通过；应用doctor命令是 `pnpm run doctor`，避免与 pnpm 自带doctor重名
- `evidence/v3-clean-install/relocation.json`：复制后的5片段/10秒多轨项目重新真实渲染，新旧MP4 SHA256都是 `569a6408b661921c95ed8b3b93cfe1eec426e8a235898c7d5c80b475952de540`

真实浏览器套件显式启用 `chromium_sandbox=True`，通过云电脑图形终端运行；受限exec的Unix socket拒绝没有用关闭沙箱绕过。Node测试与构建使用命令行正常执行。

## 桌面安全/恢复范围

已验证 renderer sandbox、contextIsolation、无Node/无preload桥、无可读cookie/token URL、Secure/HttpOnly/SameSite=Strict内存会话、匿名请求拒绝、外部网络/导航/新窗口/权限拒绝、重载会话保留、私有MCP发现文件。

已验证后端正常重启、utility SIGKILL后的SQLite恢复、正在渲染时对子进程的清理与恢复、正常退出/重启时中断长FFmpeg合成并保留待恢复快照，以及实际beforeunload取消后窗口和服务仍然可用。并不宣称能对任意整个OS/进程树同时硬杀提供即时子进程清理保证。

桌面迁移只复制关闭后的数据库和managed media，不改动原目录或复制凭据。已有目标、嵌套路径、源锁/非空WAL、软链接（包括父目录）会拒绝。新增测试覆盖目标父目录软链接指回源媒体的错误情形，拒绝发生在任何mkdir之前。

## 打包验收

Linux x64本地未签名tar.gz已构建并实测。`evidence/v3-desktop/packaged-qa.json` 6项独立打包检查通过：把PATH设为空目录后启动正式ASAR程序，确认utility可执行文件就是包内Electron、迁移合成项目、真实FFmpeg渲染/认证媒体、拒绝匿名请求、正常退出清理凭据和数据库锁。

`packaged-native-ui.json` 记录实际原生控件操作：切换预览/时间线合成、定位第90帧、播放推进至96帧，然后Ctrl+Q正常退出。`packaged-electron-preview.jpg` 是该正式打包程序的实际截图。没有开启远程调试或打包版smoke后门。包内容/许可证/fuse和最终归档哈希另见同目录的包检查文件。

开发版19项smoke和打包版6项验证分别报告，不能混同。

## 明确未验证/未包含

- macOS原生安装/运行、arm64/x64设备兼容、签名、公证、升级流程：未在Mac上测试；只提供构建配置
- FFmpeg/ffprobe：明确的外部依赖；桌面原生选择/绝对路径配置，没有捆绑下载
- 独立MCP源码stdio桥：需要Node24+与已安装源码依赖；桌面应用自己的业务进程不需要宿主Node
- 真实Runway调用/A9：未授权，未调用，仍为待真实验证
- TypeScript独立 `tsc --noEmit`：未运行；TSX生产构建、官方组件源哈希、实际运行/浏览器行为已验证

本记录按最终证据更新；没有把未执行的原生平台或付费流程记为通过。
