# V2 浏览器功能验证

本目录为旧本地 main 首轮实现的历史证据。最新 origin/main 适配后的独立功能验证见 [本轮浏览器记录](../origin-review/browser/README.md)，不得将本目录截图当作本轮结果。

2026-10-20，使用 Playwright CLI 驱动真实 Chromium，对临时合成服务进行功能检查。截图用于说明操作链路，不代表 UI 视觉验收。

环境：`http://127.0.0.1:52750`；项目 `bc5ccefe-5b83-4754-8abc-f9984c37feb3`（“V2 本地浏览器验证”）。服务使用隔离临时 SQLite、内存合成模型网关和仓库内 PNG；页面显示的模型/端点是合成配置，未发送真实付费请求。没有使用用户项目或真实凭据。

最终表结构稳定后，另用新建临时库的项目 `846463c5-bc6b-46d9-a4e9-984f1043b264` 复测重启恢复、历史、审批与 SSE；之前的合成目录保留，没有迁移用户数据。

测试专用登录值：`synthetic-browser-task-v2-only`，仅该临时服务有效。

| 操作 | 结果与证据 |
| --- | --- |
| 打开智能助理，审阅并授予 `project_agent`，发送“创建测试镜头” | 3/30 步完成；新镜头实时出现；定位高亮。见 [创建与定位](task-created-highlight.png)。 |
| 对该 Change 逐条撤销 | 镜头移除，Change 显示“已撤销”，其他人工镜头保留。 |
| 设置“本地可撤销”为“需要确认”，发送创建任务 | 工具停在审批；卡片只有批准、拒绝、跳设置入口。批准后执行；另一次拒绝后无新镜头；最终新库又验证批准后整次撤销，原人工镜头保留且回执已确认。见 [待审批](approval-required.png)。 |
| 设置付费档“直接执行” | 先出现明确费用确认；取消保持“需要确认”，确认并保存后显示费用提示；测试结束改回确认，未调用付费工具。见 [费用警告](paid-direct-warning.png)。 |
| 取得人工镜头 A 编辑保护，再输入尚未保存的描述；切到智能助理，创建 B 并批准 | 新 Change 刷新项目后，A 描述原样保留；不清空人工草稿。见 [人工草稿保留](manual-draft-preserved.png)。 |
| 发送 `[long][read]` 延迟任务并暂停、停止 | 状态分别变为“已暂停”“已停止”，不出现工具副作用。状态已核对。 |
| 同一服务目录实际重启，浏览器保持 A 草稿 | 原草稿保留、输入先禁用；明确恢复同 owner 保护后继续编辑；通过既有本地文字草稿重新核对入口恢复保存，再明确提交成功。见 [重启后继续编辑](restart-restore.png)。 |
| 最新新库重新授权并发送 `[read]`，打开任务历史 | 历史接口能读到刚完成的 Run，SSE 保持 `ready`。 |
| 选择本地 PNG，再发送 `[read]` | 文件先显示“已托管”；任务完成后 SSE 会话保持 `ready`，无任务错误；模型只读步骤往返完成。 |

重复步骤需使用该专用合成网关：普通文本生成一次本地 `shot.create`；包含 `[read]` 改用 `project.inspect`；包含 `[long]` 时首轮模型延迟 8 秒。配置“本地可撤销=需要确认”后，创建步骤会等待审批。文件输入使用仓库内 `apps/web/dist/assets/mioon-mark-*.png`。

本目录不声称已通过：真实供应商、真实费用、原生桌面窗口、视觉验收。崩溃窗口、双协议、数据库失败、30 步续轮、目标 ABA/IME/断连占用和补偿一致性以同分支的自动化状态/业务/运行时测试为依据，不能用截图替代。


自动化回归记录（同分支最终 UI 代码）：

```sh
node --test tests/agent-task-panel-v2-components.test.mjs tests/agent-tasks-v2-ui.test.ts tests/agent-editing-protection.test.ts tests/agent-manual-collaboration.test.ts tests/asset-annotation-components.test.ts tests/asset-disposition-ui.test.mjs tests/subjects-ui.test.mjs tests/agent-chat-ui.test.mjs tests/agent-settings-ui.test.mjs tests/native-close-sources.test.mjs tests/native-close-state.test.mjs tests/clip-draft-ui.test.mjs tests/subtitles-ui.test.mjs tests/clip-opacity-inspector-candidate.test.mjs tests/opacity-restored-draft-ime.test.ts
# 320 pass, 0 fail
pnpm exec tsc -p tests/typecheck/tsconfig.browser.json --pretty false
# 退出 0，无诊断
cd apps/web
pnpm exec vite build
# 成功；保留既有大块体积和第三方 use-client/source-map 提示
```
