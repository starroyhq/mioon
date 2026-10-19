# 设计页面视觉与实机覆盖

日期：2026-10-19。以下记录36类产品页面与6类规范范围的实机覆盖及未完成验收；私有设计源文件、导出图和对照拼图不入库。

**当前不能声明“36 页在 1440×900 和 1050×680 全部逐像素一致”。** 本轮没有完成这项全量双尺寸 pixelmatch，也没有把组件测试、源码断言、SSR 布局夹具或后端测试计作整页实机验收。合成媒体、标题和数量与设计示例不同；截图存在不代表所有错误、加载、禁用与异步状态都已验收。

## 可复核的实机证据

- [四语言访问矩阵](four-languages-results.json)：4 种语言 × 2 种窗口 × 15 个实际页面/浮层状态，共 **120 条状态记录**，无 `pageerror`。[语言截图目录](screenshots/languages/)已归档 **124 张实际 PNG**：上述120个状态各一张，另有4种语言的登录图。包括项目首页、新建项目、画板、剪辑、任务浮层/弹窗、8个设置页和导出入口；有实际截图不代表已完成设计叠图或所有文案逐字符裁切检查。
- [窗口与缩放矩阵](layout-scale-results.json)：1440×900、1050×680 × 90%/100%/125%，**6 个组合**；剪辑、设置和导出边界已实测，关闭入口可操作，无页面错误。代表图见 [1050 剪辑](screenshots/editing-zh-Hans-1050-100.png)、[125% 设置](screenshots/settings-zh-Hans-1050-125.png)、[125% 导出](screenshots/export-zh-Hans-1050-125.png)。
- [紧凑桌面实机交互](compact-panels-browser-results.json)：**6 组检查通过**。1050 下双侧 44px 图标栏、素材/属性浮层与固定、草稿保留、恢复 1440，以及 90%/100%/125% 下继续使用 compact；无布局偏好 PUT、无创作/任务变更、无页面错误。[实际图](compact-panels-1050-125.png)是 1050×680、125%，不是设计的 100% 对照图。
- [紧凑特殊页面补验](compact-visual/results.json)：49506独立浏览器context、独立合成项目，**7项真实交互检查通过、11张PNG**，没有注入运行时CSS。实际素材overlay为260×624，保持画布宽度；真实pointer将时间线294→160px，收起后预览stage372→492px，恢复/回到1440/实际reload后仍保留160px和选中片段。检查阶段全局UI偏好PUT为0、创作/任务变更为0，无页面错误；8次项目偏好PUT均属于该合成项目。收起后保留同实例40px完整工具栏，实际时间码/吸附可操作，body隐藏且inert，删除快捷键无动作；展开保留同一片段DOM、滚动和选择。另验剪辑模式左右浮层：[属性](compact-visual/editing-1050-properties-overlay.png)内容318px、[素材](compact-visual/editing-1050-assets-overlay.png)260px，普通点击/中心命中检查通过，浮层止于预览行而不遮时间线。
- [导出闭环](export-journey/results.json)：**6 个实际检查通过**，包括显式检查、设置/确认、受理后关闭、后台完成、重新打开完成页下载、再进入任务；无页面错误。[下载 MP4](export-journey/accepted-export.mp4)经探测为 **1080×1920、30 fps、4 秒**。已留存[检查](export-journey/step1-check.png)、[设置](export-journey/step2-settings.png)、[确认](export-journey/step3-confirm.png)、[进行中](export-journey/step4-accepted.png)、[完成](export-journey/step5-complete.png)和[历史](export-journey/history.png)全部实际步骤图；未外推为所有语言/尺寸/错误组合通过。
- [首页真实闭环](home-journey/results.json)：独立空 workspace 下实测两尺寸登录、确为空列表首页、默认竖屏创建弹窗，实际UI创建竖屏/横屏/方形1080项目后读取真实时间线宽高，并实际切换首页列表/网格。
- [首次授权确认最终8态](agent-dialog/results.json)：49506构建，4语言×1440/1050实际打开、正常取消；实测宽560px、标题18px、两按钮36px、checkbox24px，初始未勾选且确认禁用，0chat POST、0grant POST、0页面错误。[简中1440](agent-dialog/zh-Hans-1440.png)、[日文1050](agent-dialog/ja-1050.png)。
- [Agent本地正向闭环](agent-chat-journey/results.json)：**6项实机检查通过**，实际确认授权后收到合成流式回复，目标/范围摘要默认收起、可展开，reload保留会话/授权，1050浮层可操作，公共撤销后恢复完整披露且不重新发送。网关为本机注入的async generator，`gatewayCalls=1`、0外部请求；不是外部模型或供应商调用。[1440对话](agent-chat-journey/conversation-1440.png)、[1050浮层](agent-chat-journey/conversation-overlay-1050.png)、[展开选项](agent-chat-journey/target-options-1440.png)已归档。
- 剪辑七态已有 [交互记录](u6-browser-results.json)及 [125% 鼠标坐标记录](u6-zoom-results.json)。[55203最终视觉补拍](u6-visual-results.json)归档8张1440×900图；轨道底色实际为 `rgb(20, 21, 24)`，真实渲染、过期、音频能力入口和296×62 toast检查通过。该补拍覆盖最后两处轨道底色修复，旧 `*-before-*` 图片只作修复前记录。
- [Electron 报告](native/report.json)与[窗口内容截图](native/electron-workbench.png)：22 项 smoke 检查通过，包含真实渲染、媒体解码、交通灯位置API和窗口生命周期。解锁后另补[真实系统帧](native-system-frame/REPORT.md)，可见三个非激活灰色交通灯、边框与阴影，顶栏无重叠；激活颜色和控制点击未验。报告另有明确跳过的孤儿媒体进程恢复检查；这不是36张设计页的Electron逐页验收。`embedded-home-error-*.png`是组件SSR/CSS夹具，不计为原生项目选择页实机图。

已归档的其他设置页也有独立实机图：[智能助理](screenshots/languages/zh-Hans-1440-settings-agent.png)、[扩展](screenshots/languages/zh-Hans-1440-settings-extensions.png)、[快捷键](screenshots/languages/zh-Hans-1440-settings-shortcuts.png)、[关于](screenshots/languages/zh-Hans-1440-settings-about.png)；四语言和1050版本均在上述语言截图目录。

## 36 张产品 frame

“实机”表示确有运行页面或实际交互；“部分”表示只覆盖该页的一部分状态或尺寸；“未完成”不因局部测试通过而改为完成。下列各行的未完成范围同时受开头的全量双尺寸对照限制约束。

| # | 设计 frame | 已有实际截图 / 交互证据 | 未完成范围与判定 |
| --- | --- | --- | --- |
| 1 | 登录 1440×900 | 独立空workspace实际登录图：[1440](home-journey/login-1440.png)、[1050](home-journey/login-1050.png)；[四语言登录示例](screenshots/languages/ja-login.png)；后续浏览器验收均通过真实令牌表单。 | **双尺寸正常登录实机已观察**：错误令牌、网络失败和全部输入状态未形成最终整页矩阵。 |
| 2 | 项目首页空状态 | 独立空workspace，实际确认为零项目：[1440](home-journey/empty-home-1440.png)、[1050](home-journey/empty-home-1050.png)；[真实记录](home-journey/results.json)。 | **空列表双尺寸实机已观察**：未将后续有项目首页冒充空态；不声称与设计逐像素一致。 |
| 3 | 项目首页有项目 | 四语言两尺寸：[1440](screenshots/languages/zh-Hans-1440-home.png)、[1050](screenshots/languages/ja-1050-home.png)；首页实际[网格](home-journey/populated-grid-1050.png)/[列表](home-journey/populated-list-1050.png)切换与持久化检查通过。 | **列表/网格与窗口实机已观察**：封面种类、排序、重命名/删除及清理警告等状态未逐一形成整页设计对照。 |
| 4 | 新建项目弹窗 | 默认竖屏表单：[1440](home-journey/create-default-1440.png)、[1050](home-journey/create-default-1050.png)；[英文实际图](screenshots/languages/en-1440-new-project.png)；[首页闭环](home-journey/results.json)经实际UI创建三种1080画幅并读取真实时间线宽高正确。 | **双尺寸表单及三画幅创建闭环通过**：校验失败、创建未知结果等状态未形成整页视觉矩阵。 |
| 5 | 画板空状态 | [1440](screenshots/board-empty-1440.png)、[1050](screenshots/board-empty-1050.png)；见 [U4/U5 记录](U4-U5-ACCEPTANCE.md)。 | **部分实机对照**：早期画板截图；1050 的最终自动双栏展示以紧凑交互证据为准，未为此空态重拍全套最终两尺寸对照。 |
| 6 | 画板镜头与节点 | [实际节点](screenshots/board-nodes-1440.png)、[图片节点](screenshots/board-image-node-1440.png)；125% 节点鼠标移动/连线坐标另有[移动后图](screenshots/canvas-125-compensated-after.png)。 | **部分**：合成节点布局、真实操作有证据；全部节点类型、连线、错误/禁用及两尺寸最终同页对照未齐。 |
| 7 | 画板选中镜头 | [1440](screenshots/board-selected-1440.png)、[英语 1050](screenshots/board-selected-en-1050.png)、[日语 1050](screenshots/board-selected-ja-1050.png)；紧凑交互实际检查隐藏/固定后提示词草稿不丢。 | **部分**：早期选中页图及最终草稿保留交互；属性分组、所有控件状态及最终两尺寸完整视觉一致仍未逐项签核。 |
| 8 | 画板版本页 | 有版本叶组件/身份边界测试，但不作为本行实机证据。 | **未完成**：本机 FFmpeg 缺 `drawtext`，公共 Mock 返回 `MOCK_RENDER_FAILED`，未产出真实版本媒体；版本页媒体实机闭环受阻。 |
| 9 | 画板版本对比 | 有比较协调器/真实组件回调测试，但不作为整页实机证据。 | **未完成**：同一 Mock 媒体阻塞；两实际版本、选择/加入时间线、同步播放及参数差异的整页闭环未完成。私有对照素材不入库，不作为版本对比页实机证据。 |
| 10 | 画板生成中 | 公共 Mock 调用曾实际尝试，失败后按公共操作取消；见 [U4/U5 边界](U4-U5-ACCEPTANCE.md)。 | **未完成**：没有成功发布版本的生成中→完成闭环，也没有此设计状态的最终整页截图；未调用真实供应商。 |
| 11 | 剪辑空时间线 | [最终实际空时间线](screenshots/u6-empty.png)；[55203记录](u6-visual-results.json)包含首屏视频/音频drop zone、轨道底色实际检查。 | **最终1440实机状态已观察**：空时间线1050的专门同态对照未单独补拍，不外推为全七态双尺寸完成。 |
| 12 | 剪辑选中片段 | [最终1440图](screenshots/u6-selected.png)；播放/暂停、单帧、保存草稿、125%分割与鼠标拖动有实机记录；最终轨道底色已补图。 | **实机状态/交互已观察**：两尺寸全部控件、媒体内容与设计完全一致仍未逐项签核。 |
| 13 | 预览已过期 | [最终过期图](screenshots/u6-stale.png)；[实际记录](u6-visual-results.json)真实渲染后保存修改使预览过期，再显式更新。 | **最终1440状态/交互已观察**：1050专门同态及全部过期原因未逐一验收。 |
| 14 | 正在渲染预览 | [最终真实渲染图](screenshots/u6-rendering.png)；[实际记录](u6-visual-results.json)确认296×62 toast与播放条不相挡。 | **最终1440状态/交互已观察**：两尺寸完整对照及所有渲染错误状态未齐；旧竖卡toast图仅留作修复前记录。 |
| 15 | 音频分组展开 | [最终实际音频展开](screenshots/u6-audio-expanded.png)；[55203记录](u6-visual-results.json)实际访问gain/fade/envelope/ducking/测量入口，保留能力准入。 | **最终1440部分实机**：真实展开与入口检查完成；每个音频结果状态及1050同态未分别拍整页。 |
| 16 | 片段更多菜单 | [最终实际菜单](screenshots/u6-more.png)；实际普通删除/波纹删除入口及快捷键检查，最终轨道底色已补图。 | **最终1440状态已观察**：菜单全部hover/focus/disabled和1050同态未单独验收。 |
| 17 | 移除片段确认 | 最终[普通确认](screenshots/u6-remove-confirm.png)、[波纹确认](screenshots/u6-ripple-confirm.png)；确认前不删、普通留空/波纹前移、撤销重做、草稿/输入保护均有实际交互；最终补拍检查18px标题/36px按钮。 | **最终1440状态/交互已观察**：新增波纹态不冒充原设计页；未声明两尺寸所有确认状态像素一致。 |
| 18 | 导出检查 | 四语言两尺寸实际图：[1440](screenshots/languages/zh-Hans-1440-export.png)、[1050](screenshots/languages/zh-Hans-1050-export.png)；导出闭环 `step1-explicit-check`。 | **实机入口与显式检查通过**：未覆盖全部检查警告、失败、过期和可恢复状态的整页视觉。 |
| 19 | 导出设置 | [实际第二步](export-journey/step2-settings.png)；闭环实际进入设置后再进入冻结确认。 | **实机截图/交互**：只留一组实际设置页图；所有分辨率、码率组合及两尺寸视觉未穷举。 |
| 20 | 导出确认 | [实际冻结确认页](export-journey/step3-confirm.png)；导出闭环 `steps2-3-frozen-review`，实际确认后接受同次提交。 | **实机截图/确认通过**：多语言、两尺寸及全部警告组合未单独逐页对照。 |
| 21 | 导出进行中 | [实际受理进行中](export-journey/step4-accepted.png)；闭环实际接受导出后关闭弹窗，任务继续，最终成功。 | **进行中截图与后台继续交互通过**：全部进度阶段和错误状态尚未逐一拍摄。 |
| 22 | 导出完成 | [实际完成页](export-journey/step5-complete.png)；重新打开第五步并下载真实 1080×1920/4s MP4。 | **实机完成/下载闭环通过**：完成页尚未做全语言、两尺寸逐页视觉比较。 |
| 23 | 导出记录 | [实际导出记录](export-journey/history.png)；真实compose→history导航；记录对应已下载的1080×1920/4s MP4。 | **成功记录实机截图/导航通过**：失败、取消和缺失文件卡片的完整实机矩阵未齐；文件恢复回调/HTTP测试不计作此整页验收。 |
| 24 | 任务浮层 | 四语言两尺寸实际截图：[1440](screenshots/languages/zh-Hans-1440-task-popover.png)、[1050](screenshots/languages/zh-Hans-1050-task-popover.png)；实际顶栏浮层→“查看全部”→任务弹窗，导出完成后任务入口再验。 | **实机截图/交互通过**：任务混合进度、错误、未知等全部浮层状态未逐一对照。 |
| 25 | 任务全部/结果未知详情 | 四语言两尺寸实际全部任务图：[1440](screenshots/languages/zh-Hans-1440-tasks.png)、[1050](screenshots/languages/zh-Hans-1050-tasks.png)；实际打开/关闭，导出闭环再进入任务。 | **全部任务实机已观察**：仍未运行“结果未知详情”指定状态的本轮造态闭环，不能用列表访问代替。 |
| 26 | 首次发送授权确认 | [49506四语言×两尺寸实际记录](agent-dialog/results.json)及[1440](agent-dialog/zh-Hans-1440.png)/[1050日文](agent-dialog/ja-1050.png)；实测560px宽、18px标题、36px按钮、24px checkbox，初始未选/确认disabled，Escape关闭；0chat POST/0grant POST/0pageerror。 | **8组非外发确认状态实机通过**：确认后的本地正向授权闭环另见第27行；不代表真实外部模型调用，未声称整页逐像素一致。 |
| 27 | 智能助理对话与建议 | [本地注入网关6步闭环](agent-chat-journey/results.json)，真实浏览器[1440合成对话](agent-chat-journey/conversation-1440.png)、[1050浮层](agent-chat-journey/conversation-overlay-1050.png)及[目标/范围展开](agent-chat-journey/target-options-1440.png)；reload与公共撤销实测通过，网关仅调用1次、0external请求。 | **本地合成对话/授权呈现实机通过**：没有调用外部模型；真实供应商流式输出、修改建议/审批/应用的完整整页闭环仍未运行，不把局部测试作为本行完成依据。 |
| 28 | 设置通用 | 四语言两尺寸实际图：[1440](screenshots/languages/zh-Hans-1440-settings-general.png)、[1050](screenshots/languages/zh-Hans-1050-settings-general.png)；6组合缩放/真实关闭已测。 | **实机截图、几何与关闭通过**：外观全部保存/冲突/错误态未形成整页视觉矩阵；浅色已获用户确认，正式切换和保存验证见[正式主题](appearance/README.md)。 |
| 29 | 设置模型与服务 | 四语言两尺寸实际图：[1440](screenshots/languages/zh-Hans-1440-settings-models.png)、[1050](screenshots/languages/zh-Hans-1050-settings-models.png)；真实页面显示未配置状态及受限字段说明。 | **实机截图/访问通过**：供应商配置、失败、秘密字段及真实连接外发不在本轮完整实机范围。 |
| 30 | 设置工作区 | 四语言两尺寸实际图：[1440](screenshots/languages/zh-Hans-1440-settings-workspace.png)、[1050](screenshots/languages/zh-Hans-1050-settings-workspace.png)；包含工作区信息入口。 | **实机截图/访问通过**：备份/恢复/清理待办所有状态的整页视觉未逐一验收。 |
| 31 | 设置视频工具 | 四语言两尺寸实际图：[1440](screenshots/languages/zh-Hans-1440-settings-video-tools.png)、[1050](screenshots/languages/zh-Hans-1050-settings-video-tools.png)；原生smoke检查固定workspace-tools bridge，实际FFmpeg可运行。 | **实机截图/访问通过**：路径选择、检查失败和未保存离开守卫的完整页面状态未逐一验收。 |
| 32 | 紧凑画板/素材收起 | 最新1050×680/100%实际[素材收起、属性固定](compact-visual/canvas-1050-assets-collapsed-inspector-pinned.png)、[双rails](compact-visual/canvas-1050-dual-rails.png)；[补验记录](compact-visual/results.json)确认浮层和宽窄切换保留属性草稿。 | **指定紧凑展示状态已实机补拍**：合成媒体、节点内容与设计不同；草稿警告区等视觉细节仍不同于设计，不声称像素一致。 |
| 33 | 素材库临时浮层 | 最新1050×680/100%[实际有素材浮层](compact-visual/canvas-1050-assets-overlay.png)；实际rail打开/关闭，260×624浮层覆盖画布且画布宽度不变，属性草稿保留。 | **指定状态实机截图/交互通过**：该合成项目只有1个素材，未冒充设计中的8素材筛选/网格内容；全部筛选组合未逐一对照。 |
| 34 | 紧凑剪辑/时间线最小160 | 最新1050×680/100%[实际160px、属性固定](compact-visual/editing-1050-timeline-160-inspector-pinned.png)；[真实pointer检查](compact-visual/results.json)从294拖至160px，并经宽窗返回和reload保持。 | **最小160同态实际操作/截图通过**：使用本地合成源素材，未渲染成与设计相同的成片画面；未声明媒体内容或全部控件逐像素一致。 |
| 35 | 时间线收起/预览最大化 | 最新1050×680/100%[实际收起](compact-visual/editing-1050-timeline-collapsed.png)、[实际恢复160](compact-visual/editing-1050-timeline-restored-160.png)；实际点击收起/恢复，预览stage372→492px，选中片段与160px高度保留。 | **完整工具栏收起/恢复实机通过**：40px工具栏保持同一Timeline实例；时间码/吸附可操作，隐藏body inert、删除快捷键无动作；展开保留片段DOM、滚动和选择。合成媒体与设计不同，未声称逐像素一致。 |
| 36 | 剪辑属性也收起 | 最新1050×680/100%[实际双rails、时间线160](compact-visual/editing-1050-timeline-160-dual-rails.png)；由属性固定状态实际收起，再[恢复1440](compact-visual/editing-1440-timeline-restored-160.png)，选择与高度不变。 | **指定双rail状态实机截图/交互通过**：合成源素材及轨道内容与设计不同；没有宣称整页逐像素一致。 |

## 6 张规范板（不计入36产品页）

规范板提供实现目标，不能因导出完成或 token/组件测试通过就称整板已实机逐项验收。

| 规范板 | 已有对照依据 | 尚缺范围 |
| --- | --- | --- |
| Foundations | 已导出；实际深色截图、字体/尺寸 computed、对比度与 token 检查提供局部依据。 | 全部色阶/字体/焦点与媒体语义的真实状态对照未形成整板实机图。 |
| Controls | 按钮、输入、页签、Chip、下拉等已在真实工作流出现，官方组件/API来源另有记录。 | 6变体×3尺寸×全部 hover/pressed/focus/disabled/loading 的实机展示矩阵未完成。 |
| Content | 素材卡、空态、状态提示、真实进度与 toast 有页面截图；新渲染 toast 已实测有界。 | 所有内容/反馈变体、长文案和错误组合未逐项截图。 |
| Panels | 设置/导出/任务实际弹窗及6组合边界，compact真实浮层/固定交互。 | 标准/确认/危险/嵌套浮层全部状态与两尺寸完整视觉矩阵未齐；SSR夹具不替代原生整页。 |
| Timeline | 七态截图，168px轨头及52/44/32轨高、真实播放/删除/拖动记录。 | 最后两处轨道底色已由60841最终补拍及computed检查确认；全部控件状态未逐项整板验收。 |
| Shell | 顶栏、模式页签、实际44px rails、原生交通灯位置API与窗口内容截图；解锁后[系统帧](native-system-frame/native-workbench-system-frame.png)显示三个非激活灰色交通灯与边框，无顶栏遮挡。 | 激活颜色和窗口控制点击未验；各种状态/语言/浮层组合没有完成整个1640宽规范板的逐项像素对照。 |

## 仍需收尾的范围

1. 按本表未完成项补齐真实版本/版本比较、生成中、未知任务详情等指定状态；版本链路先解决本机 `drawtext` 环境阻塞。空项目首页、三画幅创建、素材浮层、时间线收起/恢复与160px实际操作及截图均已补齐。
2. Agent 首次授权确认已补不外发的实际页面状态；本地注入网关的合成对话、摘要折叠/展开、reload和公共撤销已实机通过。外部模型调用及修改建议/审批/应用仍未验收，不能用本地替身或局部测试外推这些闭环。
3. U6 最终8张补图已归档并替换本表引用；[U6 报告](U6-ACCEPTANCE.md)已更新为60841实机14项交互通过，并由[最终补拍](u6-visual-results.json)记录当前状态。早期失败日志保留作为修复过程证据。
4. 前两版浅色未获接受；[第三版](light-v3/README.md)参考用户的Codex截图，已重拍[设置](light-v3/settings-1440.png)/[剪辑](light-v3/editing-1440.png)，两尺寸四状态及真实键盘焦点通过，使用编译后的候选样式。缩放手柄显示及100%→101%→100%键盘调节已复核；用户已明确通过第三版，正式 `dark | light | system` 已启用，保存、实时系统变化及跨窗口同步另见[正式主题验收](appearance/README.md)；未将布局矩阵外推为全部设计逐像素通过。
5. 时间线完整工具栏已在49506最终构建实机补拍；继续按实际图做设计叠图/逐项检查。当前124语言PNG、6窗口缩放、6紧凑检查、7紧凑特殊状态检查、8授权确认状态、6本地Agent检查、首页闭环和6导出检查分别证明其实际范围，不相加或外推为“36页×双尺寸全部视觉通过”。
