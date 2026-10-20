# 简体与繁体主题矩阵独立视觉复核

2026-10-20。逐张使用 `view_image` 查看 32 张实际截图：简体/繁体 × 深色/浅色 × 1440×900/1050×680 × 通用设置/剪辑音频/导出设置/智能助理。没有使用 DOM 存在性替代视觉检查，也没有修改应用或关闭验收窗口

32 张均未发现本次范围内的明显溢出、遮挡、错误页签/步骤选态或不可读文字。这里的“通过”只指各张截图的明显视觉检查，不替代功能、异步行为或对比度数值测量

| 语言 | 主题 | 尺寸 | 通用设置 | 剪辑音频 | 导出设置 | 智能助理 |
| --- | --- | --- | --- | --- | --- | --- |
| 简体 | 深色 | 1440×900 | [通过](screens/matrix-zh-Hans-dark-1440-settings.jpg) | [通过](screens/matrix-zh-Hans-dark-1440-editing.jpg) | [通过](screens/matrix-zh-Hans-dark-1440-export.jpg) | [通过](screens/matrix-zh-Hans-dark-1440-agent.jpg) |
| 简体 | 深色 | 1050×680 | [通过](screens/matrix-zh-Hans-dark-1050-settings.jpg) | [通过](screens/matrix-zh-Hans-dark-1050-editing.jpg) | [通过](screens/matrix-zh-Hans-dark-1050-export.jpg) | [通过](screens/matrix-zh-Hans-dark-1050-agent.jpg) |
| 简体 | 浅色 | 1440×900 | [通过](screens/matrix-zh-Hans-light-1440-settings.jpg) | [通过](screens/matrix-zh-Hans-light-1440-editing.jpg) | [通过](screens/matrix-zh-Hans-light-1440-export.jpg) | [通过](screens/matrix-zh-Hans-light-1440-agent.jpg) |
| 简体 | 浅色 | 1050×680 | [通过](screens/matrix-zh-Hans-light-1050-settings.jpg) | [通过](screens/matrix-zh-Hans-light-1050-editing.jpg) | [通过](screens/matrix-zh-Hans-light-1050-export.jpg) | [通过](screens/matrix-zh-Hans-light-1050-agent.jpg) |
| 繁体 | 深色 | 1440×900 | [通过](screens/matrix-zh-Hant-dark-1440-settings.jpg) | [通过](screens/matrix-zh-Hant-dark-1440-editing.jpg) | [通过](screens/matrix-zh-Hant-dark-1440-export.jpg) | [通过](screens/matrix-zh-Hant-dark-1440-agent.jpg) |
| 繁体 | 深色 | 1050×680 | [通过](screens/matrix-zh-Hant-dark-1050-settings.jpg) | [通过](screens/matrix-zh-Hant-dark-1050-editing.jpg) | [通过](screens/matrix-zh-Hant-dark-1050-export.jpg) | [通过](screens/matrix-zh-Hant-dark-1050-agent.jpg) |
| 繁体 | 浅色 | 1440×900 | [通过](screens/matrix-zh-Hant-light-1440-settings.jpg) | [通过](screens/matrix-zh-Hant-light-1440-editing.jpg) | [通过](screens/matrix-zh-Hant-light-1440-export.jpg) | [通过](screens/matrix-zh-Hant-light-1440-agent.jpg) |
| 繁体 | 浅色 | 1050×680 | [通过](screens/matrix-zh-Hant-light-1050-settings.jpg) | [通过](screens/matrix-zh-Hant-light-1050-editing.jpg) | [通过](screens/matrix-zh-Hant-light-1050-export.jpg) | [通过](screens/matrix-zh-Hant-light-1050-agent.jpg) |

## 观察与边界

- 通用设置：两种语言的导航、标签和分段文字均完整；弹窗和固定底栏在最小窗口内，语言和主题与各张截图所标状态一致，保存禁用态与已保存状态不混淆
- 剪辑音频：dB 输入、包络、淡入淡出和固定保存栏未挤出面板。1440 下可看到响度卡与目标；1050 下后续内容通过属性区内部滚动查看，不把未滚到的内容判为缺失。两种语言的字幕轨短名及完整轨道行可读
- 浅色素材库：使用次数徽标数字可读，音频素材名称与时长徽标分开，没有复现黑块遮住数字或文字重叠。1050 下左侧按布局收成图标栏，未要求同时显示素材网格
- 导出设置：本次导出页签和第二步选态清楚，左右两栏、起止帧行、生成样片和检查/上一步操作未相互遮挡。后续未准入步骤为禁用态，浅色下呈灰色属预期。当前矩阵的样片为空态，真实播放器与成片另有主页面验证
- 智能助理：标题和对话气泡可读，模型与范围摘要、输入和发送区固定在底部。1050 下历史只显示当前可容纳的内容并独立滚动，没有让范围选项和说明重新占满半个面板。夹具中的文件名、用户消息、模型回复及自定义轨名保留原文，不要求界面切语言时改写项目数据
- 本报告只覆盖四种关键面的静态可见状态；没有把 32 张描述为全部 36 页在两语言两主题两尺寸下的穷举，也不声称完成原生窗口或真实外部模型验收
