# 英文 16 格独立视觉复核

2026-10-20。逐张使用 view_image 查看英文 16 张原始截图，覆盖深色/浅色、1440×900/1050×680、剪辑/导出/设置/智能助理。没有仅凭元数据或缩略图推断结果，没有操作 IAB 或修改应用

未发现明显文字截断、重叠、不可见主操作或视口溢出。1050 窗口按设计收起素材侧栏；属性、助理、弹窗内容内部滚动，底部操作仍可见。英文截图中的中文项目名、文件名、用户和合成回复是夹具内容，并非漏翻译

| 主题 | 尺寸 | 页面 | 观察 |
| --- | --- | --- | --- |
| 深色 | 1050 | [agent](screens/matrix-en-dark-1050-agent.jpg) | 长标题、模型/范围行和授权提示可读；输入区及 Send 固定可见，空输入下禁用符合状态 |
| 深色 | 1050 | [editing](screens/matrix-en-dark-1050-editing.jpg) | 音量、包络、淡入淡出及属性分组可读；Save clip 固定可见，内部滚动不盖住底栏 |
| 深色 | 1050 | [export](screens/matrix-en-dark-1050-export.jpg) | 名称、码率等长标签允许换行；样片入口、范围行、检查与底部导航均未越界 |
| 深色 | 1050 | [settings](screens/matrix-en-dark-1050-settings.jpg) | 八项导航、Theme/Density/Time display 分段完整；长时间码选项和底部状态/保存栏未裁切 |
| 深色 | 1440 | [agent](screens/matrix-en-dark-1440-agent.jpg) | 长标题、模型/范围行和授权提示可读；输入区及 Send 固定可见，空输入下禁用符合状态 |
| 深色 | 1440 | [editing](screens/matrix-en-dark-1440-editing.jpg) | 音量、包络、淡入淡出及属性分组可读；Save clip 固定可见，内部滚动不盖住底栏 |
| 深色 | 1440 | [export](screens/matrix-en-dark-1440-export.jpg) | 名称、码率等长标签允许换行；样片入口、范围行、检查与底部导航均未越界 |
| 深色 | 1440 | [settings](screens/matrix-en-dark-1440-settings.jpg) | 八项导航、Theme/Density/Time display 分段完整；长时间码选项和底部状态/保存栏未裁切 |
| 浅色 | 1050 | [agent](screens/matrix-en-light-1050-agent.jpg) | 长标题、模型/范围行和授权提示可读；输入区及 Send 固定可见，空输入下禁用符合状态 |
| 浅色 | 1050 | [editing](screens/matrix-en-light-1050-editing.jpg) | 音量、包络、淡入淡出及属性分组可读；Save clip 固定可见，内部滚动不盖住底栏 |
| 浅色 | 1050 | [export](screens/matrix-en-light-1050-export.jpg) | 名称、码率等长标签允许换行；样片入口、范围行、检查与底部导航均未越界 |
| 浅色 | 1050 | [settings](screens/matrix-en-light-1050-settings.jpg) | 八项导航、Theme/Density/Time display 分段完整；长时间码选项和底部状态/保存栏未裁切 |
| 浅色 | 1440 | [agent](screens/matrix-en-light-1440-agent.jpg) | 长标题、模型/范围行和授权提示可读；输入区及 Send 固定可见，空输入下禁用符合状态 |
| 浅色 | 1440 | [editing](screens/matrix-en-light-1440-editing.jpg) | 音量、包络、淡入淡出及属性分组可读；Save clip 固定可见，内部滚动不盖住底栏 |
| 浅色 | 1440 | [export](screens/matrix-en-light-1440-export.jpg) | 名称、码率等长标签允许换行；样片入口、范围行、检查与底部导航均未越界 |
| 浅色 | 1440 | [settings](screens/matrix-en-light-1440-settings.jpg) | 八项导航、Theme/Density/Time display 分段完整；长时间码选项和底部状态/保存栏未裁切 |

浅色复核：主文案、字段值与按钮文字在白/浅灰分层上可读；音频轨使用深绿底配亮字，选中白边在外层深边的辅助下可辨；白底导出主按钮改为深底浅字，模态背景虚化没有影响前景。未把空输入 Send、未修改 Save 或尚未重检的 Next confirm 的禁用样式误判为不可用缺陷

边界：这是静态视觉复核，不是 WCAG 对比度数值测量、英文全功能或全仓测试；未用这 16 张截图替代其他语言、原生窗口及实际异步流程证据。无应用修改
