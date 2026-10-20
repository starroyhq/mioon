# 原生 Electron 补充验收

2026-10-20，使用本轮新构建的 development bundle，在两份全新 `/private/tmp` 私有数据目录中验证。Electron 主进程报告 44.7.0 / Node 24.21.0。未使用真实用户数据、供应商、模型或密钥，未安装依赖。

发现并修复了两处明显差异：

- 空首页仍有“最近项目 ▶ 详情”状态条。现在只将正常、已稳定的空目录状态移到帮助，非空目录与读取失败、未确认写入、身份阻断、缺失目标和还原分支仍保留原页内提示
- 原生设置还在使用旧品牌和整页滚动壳，1050×680 下保存按钮在首屏之外。现在品牌统一为 Mioon，原生顶栏为 44px，导航、正文滚动与表单底栏共用现有设置中心布局。工作区与恢复入口保留在顶栏可展开浮层，failed/restored 时仍自动展开；未改变导航、只读限制、密钥处理及原生关闭准入

最终复测结果：

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| 默认启动窗口 | 1500×960，入口完整，无白屏 | final-browser-checks.json |
| 空首页 1440×900 / 1050×680 | 无残留状态条；新建按钮、帮助、设置可用；页面无横向溢出 | entry-02-final-native-1440.png / entry-02-final-native-1050.png |
| 帮助中的位置与刷新 | 最近项目详情、刷新仍可访问；Escape 关闭 | entry-02-final-help-1050.png |
| 原生通用设置 1440×900 | 底栏固定于 y=852–900 | settings-general-final-zh-CN-1440.png |
| 原生通用设置 1050×680 | 底栏固定于 y=632–680，减少动态开关可见 | settings-general-final-zh-CN-1050.png |
| 英语、深浅主题 | 两主题底栏均完整；主题保存并恢复深色 | settings-general-final-en-1050.png / settings-general-final-en-light-1050.png |
| 原生智能助理长表单 | 底栏固定于 y=628–680；正文可独立滚动到 API 密钥区；未配置或发送密钥 | settings-agent-final-native-1050.png / settings-agent-scrolled-final-native-1050.png |
| 视频工具 | 底栏固定于 y=632–680；真实本地工具检测，缺失能力有警告 | settings-tools-final-native-1050.png |
| 恢复状态浮层 | 仍展示唯一记录者说明和只读核对入口 | settings-recovery-final-1440.png |
| 新建并打开项目 | 原生独立编辑窗口可用；画板和剪辑均加载 | create-final-native-1050.png / board-final-native-1440.png / editing-final-native-1440.png / editing-final-native-1050.png |
| 页面异常 | 监听期间 pageerror=0 | final-browser-checks.json |
| 正常退出 | 原生提示本地视图/草稿未确认后，对本轮隔离数据选择 Quit anyway；应用 exit=0，未强杀，连接发现清理 | final-browser-checks.json |

原生 Agent 页的 HTML `scrollHeight` 会计入保留表单的离屏测量内容（859），但 body、#root 均为680，窗口滚动位置为0；实际滚轮只滚动表单正文（scrollTop=435），固定底栏未移动。未将数字测量单独当作视觉通过依据。

验证命令和日志：

- `node scripts/tooling.ts typecheck`：exit 0，[日志](final-typecheck.txt)
- `node scripts/tooling.ts build --channel=development`：exit 0，[日志](final-build.txt)。保留既有 Base UI use-client / 大 chunk 警告
- 入口相关测试：72/72，[日志](final-entry-tests.tap)
- 设置及相邻入口相关测试：70/70，[日志](final-settings-tests.tap)。两组有重叠，不合并累计
- `git diff --check`：通过

环境限制单列：

- macOS 当前系统屏幕共享/录制紫色指示覆盖激活窗口交通灯区域，见 [最终系统截图](settings-final-system-active-1050.png)。首轮非激活灰态截图可确认三枚系统按钮与品牌没有重叠；本轮无法独立验收激活彩色状态，未绕过系统权限或锁定
- 当前本地 FFmpeg 9.0.2 支持 libx264 / aac，缺少 drawtext / subtitles。视频工具页如实显示不可用；此原生补充不宣称字幕渲染通过

首轮 `*-native-*.png` 等不含 final 的截图是修复前问题证据；结论以 `*final*` 截图与 [结构化结果](verification.json) 为准。此目录为36页总验收中的原生补充，不替代整套页面矩阵，也未执行打包、签名、公证、Keychain或异常媒体崩溃认证。所有本轮进程已结束，源码未提交、未推送。
