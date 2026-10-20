# 第四轮小问题修复与复核

日期：2026-10-20。工作树 `codex/project-open-design-fixes`，基线 `01a83cb`。用户已确认前轮 36 页及 R1–R7 通过设计验收；本轮仅处理余下 5 个小问题，没有重新宣称执行整套 36 页验证

## 修改与实际结果

| 项目 | 修复 | 新构建复核 |
| --- | --- | --- |
| 1440 首字幕轨 | 普通时间线在默认高度附近适度分配轨道行高，刻度尺和字幕行不收缩；更小空间或更多轨道仍可滚动 | 300px、290px 面板选择底部音频后均 `scrollTop=0`，字幕 32px 完整位于刻度尺下；1050×680 / 160px 首屏 V1/A1 和底部轨道仍完整 |
| 音频源预览 | 使用已有 `AudioLines` 图标，恢复其显示；规格取当前项目，无项目规格时留空 | 48×48 图标可见，显示 `1080 × 1920 · 30 fps`；实际播放时 `paused=false`、时间前进、无媒体错误，暂停有效 |
| 任务详情 | 增加四语言“状态与诊断”标题；“标记失败”改为有边框按钮，和对账放在底部操作区 | 标题、诊断、原请求 ID 保留；按钮可用，打开确认后取消，任务仍待确认，原请求不变 |
| 导出检查说明 | 两段说明移入现有折叠区，保留可见状态和检查按钮 | 默认只显示“说明”；展开后可读；展开、关闭均保持检查 `idle`，不触发检查 |
| 日文小窗口导出 | 为导出工作区设置语言，局部增加日文页签左侧空间 | 1050×680 标题文字右缘 142px、当前页签左缘 156.75px，间距 14.75px；1440、简中及浅色英文抽查无明显退化 |

音频规格修改仅影响源音频：图片/视频仍使用素材规格，已完成历史成片仍使用保存的快照；缺快照不会冒充当前项目规格。任务的原确认、选择上下文、恢复工作区、忙碌及未知结果保护保持有效

主要文件：`Preview.tsx`、`preview-editing.css`、`timeline-editing.css`、`TaskCenter.tsx`、`TaskWorkspace.css`、`TimelineExportPreflight.tsx`、`DeliveryWorkspace.tsx`、`export-workflow.css`，以及任务标题 catalog 和注册入口

## 截图与独立复核

所有 `.jpg` 为最终新构建的实际浏览器截图，使用隔离合成项目，没有注入 CSS 或调用真实服务

- [1440 音频与字幕轨](editing-audio-1440.jpg) · [290px 时间线](timeline-1440-290.jpg)
- [1050 首屏轨道](timeline-1050-160-top.jpg) · [1050 底部轨道](timeline-1050-160-bottom.jpg)
- [任务标题](tasks-detail-top-1440.jpg) · [任务操作区](tasks-actions-1440.jpg)
- [导出默认折叠](export-check-1440.jpg) · [导出展开说明](export-help-expanded-1440.jpg)
- [日文 1050](export-ja-1050.jpg) · [日文 1440](export-ja-1440.jpg)
- [浅色英文音频](editing-audio-light-en-1440.jpg) · [浅色英文导出 1050](export-light-en-1050.jpg)

三位子代理分别只读复核最终截图，均未发现明显退化：[时间线/音频](timeline-final-review.md)、[任务](tasks-final-review.md)、[导出](export-final-review.md)。[浏览器观测](browser-checks.json)记录几何、音频播放、任务取消和导出状态；浏览器错误日志为空

`*-probe.png` 和 `timeline-layout-probe.json` 是问题定位阶段在旧构建注入同一份 CSS 的探查，明确不作为最终新构建验收证据；上面的 `.jpg` 和浏览器记录才是最终复核

## 验证

20 个相关测试文件逐文件独立进程，真实路径 `TMPDIR=/private/tmp`，每文件 90 秒或 120 秒超时。最终 **351/351 通过，0 失败、0 跳过**：[汇总](test-summary.json)、[命令](commands.json)、[日志](logs/)

| 组别 | 结果 |
| --- | ---: |
| 源预览、抽帧与音频预览 | 90/90 |
| 任务与上下文保护 | 98/98 |
| 时间线、字幕与紧凑布局 | 82/82 |
| 导出与保留页面 | 76/76 |
| 四语言 catalog 与界面文案审计 | 5/5 |

- `node scripts/tooling.ts typecheck` 退出 0：[日志](logs/typecheck.txt)
- `node scripts/tooling.ts build --channel=development` 退出 0：[日志](logs/build.txt)，已有 Base UI 指令、sourcemap 和包体提示保留
- Web 与桌面 staging 的 5 个文件逐字节一致：[核对](build-match.json)
- `git diff --check` 通过

文案审计首次发现前轮 `SettingsRoot.tsx` 品牌从 `mioon.` 改为 `Mioon` 后，精确字面量例外账本尚未更新。仅修正该品牌的哈希与说明，最终 5/5 通过；没有放宽规则，原失败日志保留在 `logs/i18n-catalog-integrity-initial.tap.gz`（逐字节保留原日志）

## 范围与环境

保留原有第三轮、响度分析与匹配及完整设计复核的未提交改动。15 个官方 Base UI 源文件哈希未变，依赖字段与锁文件未变，`designs/` 无跟踪文件、无修改、无设计原图复制：[源码核对](source-audit.json)。本轮未提交、未推送，原工作区无新增改动

没有新增环境阻塞。真实供应商生成、烧录字幕导出及原生激活交通灯颜色不在本轮设计复核范围内，未记为通过；FFmpeg 缺 `drawtext/subtitles` 等滤镜和原生窗口限制沿用[前轮环境记录](../full36-round3/validation/README.md)与[原生记录](../full36-round3/native/README.md)。新桌面 staging 构建通过不代表这些项目已验收
