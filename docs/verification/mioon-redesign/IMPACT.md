# 阶段、测试与文档对应

私有设计素材不入库；本表仅列实现范围、测试及实机证据。

| 阶段 | 重点测试 | 同步文档 |
| --- | --- | --- |
| U1/U2 | design-tokens、workbench-controls、ui-components；对比度与真实Base UI渲染 | UI-COMPONENTS |
| B1 | generation-capabilities/input-boundary/output-validation、provider-settings-ui、providers-runway-parity、cli-v4、mcp-v4；相关transport夹具 | README、ARCHITECTURE、PROVIDERS、PROVIDER-TRIAL-READINESS、LIVE-VERIFICATION-APPROVAL、mioon Skill |
| B2 | redesign-output-contracts、redesign-output-media-transports、export-settings-*、timeline-media、preflight与历史恢复 | TIMELINE-OUTPUT-FORMATS、EXPORT-SETTINGS、README、CONTRACT、mioon Skill |
| B3 | ripple domain/schema/backup/transports、timeline history/recovery、edit-task恢复 | TIMELINE、CONTRACT、CLI、MCP、mioon Skill |
| B4 | agent-authorizations、agent-authorization-transports、agent-chat-runtime/http/journal/durable-crash、tool/edit/timeline runtime与renderer | AGENT-CHAT、CONTRACT、CLI、MCP |
| B5 | ui-preferences、project-home-summary、项目管理/删除与备份恢复、last-project、现有workspace-preferences | WORKSPACE-PREFERENCES、LAST-PROJECT、WORKSPACE-GUIDE、CONTRACT |
| U3 | workbench-shell、workspace-layout/panels/state/preferences-client、right-dock-layout、task-center-app、export-preflight-ui | UI-COMPONENTS、WORKSPACE-GUIDE |
| U4/U5 | 素材筛选/标记/注释/来源范围、subject库、canvas引用连线、版本比较与可见性 | WORKSPACE-GUIDE、比较/素材/引用功能说明 |
| U6/U7 | 片段属性/分割/波纹/历史、预览、范围/命名/浮点导出、任务恢复；真实ffprobe | TIMELINE*、EXPORT-SETTINGS、相关验收说明 |
| U8 | 任务、Agent、settings导航/dirty保护、全局偏好、视频工具、备份恢复 | AGENT-*、WORKSPACE-GUIDE、DESKTOP |
| U9 | project-home-panel/app、登录/新建/项目导航栅栏、recent与summary运输 | WORKSPACE-GUIDE、CORE-TRIAL、README |
| U10/U11 | 双窗口尺寸×四语言、焦点/键盘/减少动态、浅色两页截图后确认 | 设计偏离和截图验收记录 |
| 收尾 | 全部受影响测试与冻结基线比较、首次试用流程、Electron实际启动 | 当前状态与事实验收记录 |

文件名按功能族列出，精确已运行文件、退出码、耗时保留在逐文件结构化结果中；历史失败不会因后续通过而删除。

## 最终证据入口

- [STATUS](STATUS.md)：实施、实际验证和未完成验收分开列明。
- [candidate-results.json](candidate-results.json)：189个唯一受影响文件，179文件通过，2509项中2489通过；采用最终有效结果，同一文件不重复计数。token最终5项，正式主题包含23文件411项定向及相邻回归，全数通过。
- [test-coverage-audit.json](test-coverage-audit.json)：173个新增或修改的Node测试文件均有最终结果，未外推为全部测试通过。
- [remaining-failures.md](remaining-failures.md)：10文件基线与候选逐子项对照；相同17个实际失败子项及3聚合项。
- [baseline-final-report.json](baseline-final-report.json)：718文件的完整冻结基线。
- [VISUAL-COVERAGE](VISUAL-COVERAGE.md)、[U4/U5](U4-U5-ACCEPTANCE.md)、[U6](U6-ACCEPTANCE.md)：实际页面、局部组件测试及环境阻塞分别记录。
- `four-languages-results.json`、`layout-scale-results.json`、`compact-visual/results.json`：最终浏览器布局和真实交互；`compact-panels-browser-results.json`保留早期独立检查。
- `agent-dialog/results.json`、`agent-chat-journey/results.json`：最终8态授权弹窗与本地注入网关6步对话闭环；无真实模型调用。
- `media/ffprobe.json`、`export-journey/results.json`、`native/report.json`：真实产物及Electron验收。
- [第二版浅色](light-v2/README.md)与[原生系统帧](native-system-frame/REPORT.md)：首版被拒绝后的候选修正，以及解锁后补齐的非激活交通灯/系统边框证据。
- [第三版浅色](light-v3/README.md)：根据用户的Codex参考截图改为中性白色层次，并修复设置缩放手柄的显示及键盘焦点；用户已明确确认第三版，正式浅色及跟随系统已启用，见[正式主题验证](appearance/README.md)。

导出文件恢复补充了HTTP结束后的文件发布lease；恢复组件按完整owner隔离GET和原生文件选择回调，隐藏时不启动检查，已接受上传仍完成且释放锁。独立审查未发现本次lease及受限native导航修复引入的确定并发/权限问题。

正式主题还记录了四语言两尺寸120个浅色状态、最终构建8步主题闭环及30状态重复选片回归。重复选片仅发布展示层导航状态，不写项目偏好；两次初始超时与修复后证据分开归档。原生7项构建与该展示修复后的构建差异见appearance/native/final/post-navigation-build-comparison.json。

来源核对：15个官方组件源与HEAD相同；dialog登记哈希在基线已有差异，其余14项一致。所有package.json与锁文件均未修改。精确值见provenance.json。
