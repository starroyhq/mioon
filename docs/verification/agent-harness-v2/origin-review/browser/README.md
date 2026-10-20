# origin/main 适配后的浏览器功能验证

2026-10-20，固定基线 `cfa2f83e1a4febeec335ccd5a51d09b35d72a76b`，分支 `codex/agent-harness-v2-origin-review`。本目录为本轮新的 Chromium 真实交互记录，旧 `../../browser/` 仅作首轮历史证据。截图验证功能链路，不代表视觉验收。

使用 Playwright CLI、1920×1080 Chromium，对 `http://127.0.0.1:52750` 的独立合成服务操作。新建普通格式 52 临时 SQLite，项目 `bde7224b-77b2-4777-a5e4-bef6b0c7b9c0`（“V2 origin/main 浏览器验证”）；未打开用户数据。测试网关为纯内存函数：普通文本调用一次本地 `shot.create`；`[read]` 使用 `project.inspect`；`[long]` 首轮延迟 8 秒。没有供应商网络调用、真实付费接口或真实凭据；登录值是仅该临时服务有效的合成值。

## 实际步骤与结果

| 步骤 | 结果 |
| --- | --- |
| 打开设置“模型与服务”，展开视频供应商目录 | 原有视频连接界面保留，Seedance / Google Veo / MiniMax / Vidu / Kling / Wan 可见，品牌图标存在；未点击供应商检测或真实生成。见 [视频目录](remote-video-models.png)。 |
| 打开任务概览，再进入“全部任务” | 原有任务中心、过滤器和空状态正常，无任务处置错误。见 [任务中心](remote-task-center.png)。 |
| 设置“本地可撤销=需要确认”，付费仍为确认；审阅并授予新的 `project_agent` | 任务入口获得授权，默认预算 30 步。 |
| 取得镜头 A 的编辑保护，再输入“origin/main 第二轮人工草稿 A 保留”；切到助理发送创建 B | 在审批处暂停，画布仍仅有原来两个镜头；卡片提供批准、拒绝和跳转设置。见 [审批前](v2-approval.png)。 |
| 批准原工具步骤，等待项目刷新，再定位 Change | 3/30 步完成，B 出现；画布节点实际可见且宽高非零。切回属性，A 的手动草稿逐字保留，定位未改变 A 的表单归属。见 [草稿 A 与 AI B](manual-draft-ai-b.png)。 |
| 整次撤销 | B 被移除，两个原有镜头保留，任务显示已撤销。见 [撤销后](v2-undone.png)。 |
| 完成只读任务并打开任务历史；重新读取保留保护 | 新 Run 能从历史读取，SSE 处于 ready；本窗口活跃 A 草稿不出现在“其他窗口或重载后保留”的可解除列表。 |
| 显式保存 A 的标题/提示词，结束保护后刷新最新构建页面 | 保存已确认，画布继续可见；未用重载清除尚未保存的草稿。 |
| 发送 `[long] [read]`，使用浏览器请求拦截令原 Run GET 连续两次返回 `ERR_INTERNET_DISCONNECTED`，再解除拦截 | 先进入 detached；第一次重连仍失败后继续退避。网络恢复后自动读取原 Run 并恢复 ready / 已完成。监听到该轮 v2 POST 共 1 次；恢复没有重发任务。 |

最后一轮使用 `pnpm --filter @mioon/web build` 生成的完整类型检查后构建。浏览器控制台的网络错误包含测试注入的两次断联；最初出现的 `/api/workspace-preferences/:projectId` 400 已继续追查并修复，具体证据见下节；不能将它归为合成环境警告。未观察到 JavaScript 运行异常。

## 自动化验证

```sh
node --test tests/agent-task-panel-v2-components.test.mjs tests/agent-tasks-v2-ui.test.ts tests/agent-editing-boundaries-v2.test.mjs tests/agent-editing-protection.test.ts tests/agent-manual-collaboration.test.ts tests/asset-annotation-components.test.ts tests/asset-disposition-ui.test.mjs tests/subjects-ui.test.mjs tests/agent-chat-ui.test.mjs tests/agent-settings-ui.test.mjs tests/native-close-sources.test.mjs tests/native-close-state.test.mjs tests/clip-draft-ui.test.mjs tests/subtitles-ui.test.mjs tests/clip-opacity-inspector-candidate.test.mjs tests/opacity-restored-draft-ime.test.ts
# 339 pass, 0 fail
pnpm --filter @mioon/web build
# 退出 0；包含 node scripts/tooling.ts typecheck 和 Vite build
pnpm exec tsc -p tests/typecheck/tsconfig.browser.json --pretty false
# 退出 0，无诊断
```

新基线的远端前端回归另跑 175/175 通过，范围为任务中心、工作区壳、紧凑轨道、锁轨相关响度交互、视频设置/目录/供应商配置及导出工作流。窗口轨道锁仍是原有每窗口交互偏好，本记录不声称服务器 AI 读取该偏好。

本轮未重复全部旧版浏览器重启、多窗口、IME 和托管文件矩阵；相应保护、异步竞态、ABA、未知回执、精确 53 只读入口等由同分支自动化测试覆盖，不能把旧截图当作本轮现场结果。原生桌面窗口、真实供应商、真实费用及视觉验收未进行。


## 视图偏好 400 的归因与修复复验

最初捕获的是 `PUT /api/workspace-preferences/:projectId`，请求根对象含 `expectedRevision`、`state` 以及内部排队字段 `key`、`invocation`。服务端返回 `VALIDATION_ERROR`，`error.details.issues[0].path=[]`、消息为 `Expected exactly the documented fields`。视图中的 `{x:160,y:316,zoom:1}` 合法；错误发生在请求根对象，不是旧画布高度或 viewport 数值。完整合成请求和响应见 [修前 HTTP](preferences-before-fix.json)。

修前对客户端 `workspace-preferences.ts`、状态规范化和服务端偏好实现逐字核对，三者均与固定 `origin/main` 相同；新建无缓存客户端、默认视图且不访问已有业务库，也复现根字段校验失败。字节 SHA 和独立调用证据见 [基线归因](preferences-baseline-proof.json)。这是主线已有缺陷，实际阻断本轮视图持久化，已在当前授权范围内窄修客户端序列化：线上只投影 `expectedRevision`、`state` 及原已校验的 `expectedWorkspaceOrigin`，队列内部字段继续用于原有 CAS/未知响应重试；没有放宽服务端校验。

新增客户端直连真实 SQLite 服务的三项回归，修前三项失败，修后三项通过，覆盖正常保存与重新读取、丢 ACK 后重放完全相同的原 CAS body 再保存新视图、跨恢复分支不重绑定已排队请求。相关 client/business/http/restore-renderer 套件共 66/66 通过：

```sh
env TMPDIR=/private/tmp node --test --test-concurrency=2 tests/workspace-preferences-client-service.test.mjs tests/workspace-preferences-client.test.mjs tests/workspace-preferences.test.mjs tests/workspace-preferences-http.test.mjs tests/workspace-restore-renderer.test.mjs
pnpm exec tsc -p tests/typecheck/tsconfig.browser.json --pretty false
pnpm --filter @mioon/web build
# 均退出 0；最新 Web 构建包含完整类型检查
```

首次旧 HTTP 用例使用系统 `/var/...` 临时别名，受现有禁止符号链接存储策略阻断；未改变校验，完整套件在 canonical `/private/tmp` 重跑通过。

最新构建的真实 Chromium 复验：

- [修后 PUT](preferences-after-fix.json) 返回 200、revision=1，线上根字段仅 `expectedRevision` / `state`。
- 切换缩略地图再次 PUT 200、revision=2，刷新后 `aria-pressed=true`，画布节点实际高度 203.875。见 [视图刷新恢复](preferences-reload.json)。
- 此后再次发送延迟只读任务并注入 GET 断联，实际有 3 次失败读取，恢复后 `ready`，该轮任务 POST 仍只有 1 次，原两个镜头保留。见 [修后 v2 断联复验](preferences-fix-sse-smoke.json)。该复验没有新的偏好 400。
