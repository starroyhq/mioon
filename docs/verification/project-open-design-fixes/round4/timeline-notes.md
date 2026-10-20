# R4-1：普通时间线首字幕轨被刻度尺遮住

## 根因与修复

1440×900 下，默认 300px 时间线的轨道视口为 238px；字幕、两条视频和两条音频加刻度尺的内容为 250px。初次展开时字幕完整，但 Chrome 在聚焦底部音频片段时自动滚动（实测 4px，上一轮截图为更大的底部偏移），固定在顶部的刻度尺便盖住了字幕轨上沿

仅修改 `apps/web/src/timeline-editing.css`：普通时间线用纵向 flex 在可用高度内分配轨道，刻度尺 24px、字幕 32px 保持不变；视频行最低 40px、音频行最低 36px。默认高度附近的小幅缺口由普通轨道分担，较大面板保持原 52px/44px 行高。更小面板或更多轨道仍可正常滚动，没有重置用户滚动、修改焦点行为或隐藏字幕轨。原有 160px 紧凑模式完全独立，未修改

## 实际浏览器探查

使用隔离的本地合成项目和独立 Chrome 上下文，未调用外部服务。探查基于上一轮开发构建，仅注入与本次源码完全相同的 CSS；主代理负责最终新构建复测

| 窗口 / 时间线高度 | 结果 |
| --- | --- |
| 1440×900 / 292px | 视口与内容均 230px；选择底部 A2 后 scrollTop=0，32px 字幕首轨完整位于刻度尺下 |
| 1440×900 / 300px | 视口与内容均 238px；选择 A2 后 scrollTop=0，字幕完整 |
| 1440×900 / 322px | 视频 52px、音频 44px 保留原行高 |
| 1050×680 / 160px | V1/A1 各 28px 整行；滚动 56px 后 V2/A2 也各 28px 整行；横向滚动仍可用 |
| 1440×900 / 220px | 普通模式视频 40px、音频 36px，内容溢出后正常滚动；所有片段都在所在轨道边界内 |

片段采用现有 `top:4px; height:calc(100% - 8px)`，缩小轨道后没有被旧的固定高度规则覆盖；160px 紧凑模式仍为 top=3px、高 22px

探查记录：`timeline-layout-probe.json`；截图：`timeline-1440-292-probe.png`、`timeline-1050-160-probe.png`。这些截图只用于本问题定位，其他页面仍是上一轮构建状态。当前和 REPL 超时前创建的 headless Chrome 均已退出；未停止共享 QA 服务

## 验证

逐文件独立进程，均使用 `TMPDIR=/private/tmp node --test --test-reporter=tap <文件>`，每文件 120 秒明确超时

| 测试文件 | 结果 |
| --- | --- |
| `tests/timeline-compact-layout.test.ts` | 2/2 |
| `tests/timeline-collapsed-presentation.test.mjs` | 5/5 |
| `tests/subtitles-ui.test.mjs` | 21/21 |
| `tests/waveform-ui.test.mjs` | 23/23 |
| `tests/client-timeline-snapping.test.ts` | 31/31 |

共 82/82，通过；`git diff --check -- apps/web/src/timeline-editing.css` 通过。日志位于 `/private/tmp/mioon-round4-timeline-tests/`。没有本问题新增的环境阻塞，未修改业务、schema、依赖或私有设计文件
