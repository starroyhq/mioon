# U6 剪辑与时间线验收

交互与七态视觉复核均通过。`final result: passed`。

## 范围与环境

- 设计真值：[mioon-design.pen](../../../designs/mioon-design.pen) 的七个剪辑 frame；节点名称见 [design-inventory.json](design-inventory.json)。
- 最终构建 `http://127.0.0.1:60841` 已在收起工具栏修复后完整重跑10项交互、125%四项真实坐标检查及八张截图。使用已安装 Google Chrome 155.0.8059.80 和仓库已有 Python Playwright。独立浏览器 context，`zh-Hans`、1440×900 CSS px、deviceScaleFactor=1；设计导出和实际截图均1440×900，无密度换算。
- 只操作本轮创建的合成项目、纯色视频/PNG与本地 FFmpeg；未调用供应商，未写共享 workspace 外观偏好。100%与125%仅在各自 context 的 DOM 设置。
- 两轮交互与末次截图的控制台 `pageerror` 均为空。原始结果：[10项交互](u6-browser-results.json)、[125%真实坐标](u6-zoom-results.json)、[最终视觉](u6-visual-results.json)；执行日志：[交互](u6-browser.log)、[125%](u6-zoom.log)、[最终截图](u6-visual.log)。

## 实际交互

十项100%检查全部通过：

1. 预览媒体区有可用高度，播放条在预览底部，轨头实测168px。
2. 选中片段播放、暂停与单帧前进驱动其绑定的时间线帧。
3. 独立素材播放、暂停与单帧前进只推进素材时钟，时间线仍为0。
4. 实际波纹删除60帧片段后，后续同轨起点90/180变为30/120，原有30帧间隙保留；确认前没有删除。
5. UI撤销、重做、再撤销精确往返原片段位置。
6. 输入框及未保存草稿下的Shift+Backspace不能删除。
7. Shift+Backspace打开波纹确认；普通Backspace删除后保留90/180的原起点；撤销恢复。
8. 音频素材的role、线性gain、淡入/淡出、包络预设、ducking与显式响度测量入口均按真实准入可用。
9. 更新预览的toast实测296×62px，位于右上方，不覆盖播放条。
10. 实际预览渲染成功后保存属性使旧预览过期；点击更新显示真实待处理渲染进度。

125%四项检查全部通过：

- CSS片段宽152px，物理宽190px，比例实测1.25；每帧2.5333 CSS px。
- 按物理坐标点击ruler30帧，实际播放头为30；分割后保存两段30帧，后一段sourceIn精确增加30。
- 使用真实鼠标HTML拖动，以30帧抓取偏移移动末片段，拖放预览和数据库最终起点均为240。
- 撤销拖动后恢复180，片段持续60帧与sourceIn不变。

证据：[拖动预览](screenshots/u6-zoom125-drag-preview.png)、[撤销后](screenshots/u6-zoom125-restored.png)。不是通过直接派发合成drag事件或修改应用状态得到。

## 七态截图

以下八张均为最终60841构建的实际浏览器截图；合成项目的镜头名称、数量、媒体画面、源入点和时间码与设计示例不同。设计中的普通opacity控件不代表本轮普通profile自动获得候选能力；本轮保留真实像素rect编辑和既有音频/LUT能力。

| 状态 | 设计frame | 实际截图 |
| --- | --- | --- |
| 空时间线 | g4H17A | [empty](screenshots/u6-empty.png) |
| 选中片段 | kW2kV | [selected](screenshots/u6-selected.png) |
| 预览过期 | Oq580 | [stale](screenshots/u6-stale.png) |
| 渲染预览 | y1lmu | [rendering](screenshots/u6-rendering.png) |
| 音频展开 | V6Ofzj | [audio](screenshots/u6-audio-expanded.png) |
| 更多菜单 | lcuQ6 | [more](screenshots/u6-more.png) |
| 普通移除确认 | HBh5I | [remove](screenshots/u6-remove-confirm.png) |
| 新增波纹确认 | D6新增状态 | [ripple](screenshots/u6-ripple-confirm.png) |

## 视觉对照与修复记录

已经把设计导出与实际截图合成在同一对照输入中检查全页和属性/确认框局部。

- 字体：标题、标签、正文、单色时间码使用现有`--wb-*`字体与字号层级；字段仍显示真实帧数，显示时间码受偏好控制。
- 布局：预览标题36、播放条48、时间线工具条36、ruler24、轨头168、视频/音频/字幕轨高52/44/32；保留底部保存栏与可滚动属性区。
- 颜色：复用深色tokens、片段类别色、选中描边、过期warning及删除danger，不引入新全局palette。
- 图像：媒体由实际导入资产展示，保持真实宽高比；纯色合成媒体用于验收，没有把示例装饰图作为生产假素材。
- 文案/动作：源素材与成片、四组属性、普通移除和波纹删除均有四语言catalog；普通移除留空与波纹前移的说明不同。菜单保留实际支持的动作；渲染取消因无后端取消操作而不伪装可用。

此前发现并已修复的叶问题：媒体区塌缩/播放条贴顶；时间线图标与文字重叠；普通草稿说明长期占满属性区；音频展开时其它组仍占空间；zoom后指针坐标未从物理px映射回布局px。上述修复已包含本轮实际运行构建。

最后视觉复核记录：

- 全局toast已改为独立workbench样式；实际296×62px且不盖播放条，旧竖卡问题已关闭。
- 删除确认框已实际复拍：18px标题、36px按钮、6px圆角及raised底色，与HBh5I同屏对照。
- 音频展开已按真实ScrollArea回顶；基础/画面折叠，role/gain/fade、包络/ducking/测量入口和固定保存栏可用。保留真实线性gain与精确包络/测量准入，设计示例中的dB数值和曲线没有作为合成状态写入产品。
- 末次限定轨道底色修复已在最终60841构建实际复核。所有track-lane和track-label实际计算色均为panel token的`rgb(20,21,24)`；36/48/36/24/52/44/32/48px组件高度与168px轨头实际断言通过。最终七态同屏对照已全部重新检查。

同屏证据：[七态全页示例](screenshots/u6-comparison-selected.png)、[音频属性](screenshots/u6-comparison-audio-expanded-inspector.png)、[确认框](screenshots/u6-comparison-remove-confirm-dialog.png)。

## U10 时间线收起边界

桌面收起后保留原工具栏实例与全部显式动作；内容keepMounted且hidden/inert，暂停波形和删除快捷键，所有旧body/portal回调按当前render失效。展开保留滚动、缩放与吸附设置。此轮body/portal/drag边界改变后，最终60841构建重新通过上述10+4实际交互，包含125%真实拖放正例。

[u10-timeline-results.json](u10-timeline-results.json)记录4个独立文件69/69通过：新增收起边界4、原删除5、吸附31、共享UI29。新增4项验证当前收起工具栏可操作、隐藏/旧回调拒绝、项目与unmount退役、视图恢复，以及展开后真实geometry/dropPreview仍精确提交120帧。独立TAP为[新增边界](logs/U10-timeline-collapsed-presentation.tap)、[删除](logs/U10-client-timeline-removal.tap)、[吸附](logs/U10-client-timeline-snapping.tap)、[共享组件](logs/U10-ui-components.tap)。

## 关联回归

- [u6-focused.tap](u6-focused.tap)：72/72通过，4.34s；包括实际删除确认hook、键盘/IME/草稿、预览逐帧helper、缩放坐标、旧opacity Inspector，以及显式46备份恢复47后的durable执行和关闭重开。
- [u6-project-specifications.tap](u6-project-specifications.tap)：43/43通过，0.374s。默认fixtures迁至1080，旧720快照另验；原有dirty/CAS/晚ACK/unknown/项目epoch/native-close覆盖全部保留。UI选择器保留当前legacy读值与三个1080；未更改业务或既有legacy契约。
- [u6-fades-transports.tap](u6-fades-transports.tap)：2/2通过，26.64s；仅维护exact discovery白名单增加rippleRemove，其余fade/schema/effect/三传输/重启断言保留。初次直跑继承非canonical TMPDIR触发SYMBOLIC_LINK，改用本次私有canonical TMPDIR后整文件通过并清理。
- 初次浏览器脚本的CSP字符串predicate、片段绑定/独立素材时钟假设与pause后时钟ACK等待已修正。最终上述14项是真实通过结果，没有降低产品guard或跳过检查。末次独立确认框DOM量测初次未等待入场动画结束，补齐与截图相同的动画稳定等待后，实际按钮高度为36px。

- [impact-contracts-results.json](impact-contracts-results.json)：剩余18个契约/业务/客户端/文档影响文件264/264通过；保留历史720、回执/所有权/回滚/重启强断言。六种规格真实媒体额外发现新分镜资产名硬编码9x16，已由主代理修复后8/8完整媒体复验通过。

final result: passed
