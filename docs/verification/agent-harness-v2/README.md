# Harness v2 功能验证记录

本文件及 `browser/` 截图记录原本地 main 基线上的首轮实现，保留作历史证据。用户后续指定适配最新 `origin/main`，本轮 52/53 格式、审查和复验结果见 [origin 适配与审查记录](origin-review/README.md)；不能将下列旧结果当作新基线的验收结果。

2026-10-20。实现位于 `codex/agent-harness-v2`，基于本地 main `96b0689a55607e66f26e23098f50033d744300d2`。没有引入运行框架或新增生产依赖，没有 commit、push、部署或真实付费请求。main 及其原有未跟踪文档保持不变。

## 最终检查

以下为不同范围的检查，测试数有重叠，不累加为总数。

| 范围 | 结果 |
| --- | --- |
| v2 运行时、日志、双协议网关、HTTP、工具、崩溃、编辑保护和客户端状态 | 140/140 通过，Node 24.21.0，文件并发 2 |
| 综合测试后新增的已有图像组后台审批回归 | 定向 1/1 通过；自身受理修订不会误冲突，原任务只发送一次 |
| 前端组件、旧聊天及设置、草稿、IME、原生关闭状态等组合回归 | 320/320 通过，命令见浏览器记录 |
| 严格类型检查及 Web 构建 | `pnpm --filter @mioon/web build` 退出 0，包含项目类型检查；Vite 构建成功 |
| 浏览器测试的严格类型检查 | `pnpm exec tsc -p tests/typecheck/tsconfig.browser.json --pretty false` 退出 0 |
| 测试代码严格类型检查 | `pnpm exec tsc -p tests/tsconfig.tests.json --pretty false` 退出 0 |
| Git 补丁检查 | `git diff --check` 通过 |

最终 v2 套件命令：

```sh
env TMPDIR=/private/tmp node --test --test-concurrency=2 \
  tests/agent-task-*-v2.test.ts \
  tests/agent-tasks-v2-ui.test.ts \
  tests/agent-editing-protection.test.ts \
  tests/agent-manual-collaboration.test.ts
pnpm --filter @mioon/web build
git diff --check
```

新增图像组用例的定向命令为 `env TMPDIR=/private/tmp node --test --test-name-pattern='existing image group accepts' tests/agent-task-tools-v2.test.ts`；完整套件命令会包含该新增用例。

Node 使用 24.21.0。macOS 私有存储测试使用解析后的真实临时目录，避免 `/var` 符号链接别名触发既有安全校验；未放宽校验。

## 安全边界

- 两种协议的连续多轮和完整工具往返；同响应的工具顺序执行；30 步预算继续保留已完成结果。
- SQLite intent、dispatch、结果等六个写入点注入失败，失败后不再产生后续发送或业务副作用。
- intent 后撤销授权，以及后台 durable claim 后、实际 POST 前撤权或关闭付费直调，均阻断未发送工作。
- 后台队列原步骤支持单次批准／拒绝，重复控制不重交；批准后发生人工 ABA，POST 为 0，继续时取消旧队列并仅重新规划一次。
- 双协议分别在模型 intent、模型发送、本地事务提交前后、生成受理、结果落库窗口真实 SIGKILL 专用子进程，共 12 项通过；重启不自动续跑，明确恢复也不重复修改或提交生成。
- 多 owner、断联和重启保留的草稿占用、IME、同目标 ABA、无关目标编辑及目标级补偿；撤销链可以跨自身修订，不能跨人工修改。
- 托管导入句柄、宿主本地等待、图像审批桥、费用证据、后台迟到结果、暂停／停止后未发送队列的处置。

## 兼容和实际操作

最新 schema dispatcher 42/42 通过；固定旧 v1/v2 记录和 v3 SQL 保持检查再次通过。v2 套件包含普通库 50、恢复格式 51、托管文件备份恢复、恢复副本只读及数据库字节不变检查。

此外已运行项目删除 12 项、桌面普通数据迁移 10 项、备份就绪 5 项、恢复应用回放 9 项，以及旧格式源代码冻结保护 76 项。新增的目标占用基线属于尚未发布的 schema 50，本次不支持开发期间旧临时 50 库原地打开。

旧 agent 广泛回归首次运行 961 项，其中 16 项因并行负载导致既有 12 秒后端启动超时。涉及的两个 wire 文件改用 Node 24 串行重跑后 68/68 通过；没有修改超时或降低断言。

```sh
env TMPDIR=/private/tmp node --test --test-concurrency=1 \
  tests/agent-timeline-gain-wire.test.mjs \
  tests/agent-timeline-move-wire.test.mjs
```

[真实 Chromium 操作步骤和截图](browser/README.md)覆盖授权、实时变化、审批／拒绝、设置费用提示、撤销、草稿保留、暂停／停止、托管上传、历史、SSE 及实际服务重启恢复。截图只证明功能操作，不代表视觉验收。

系统 FFmpeg 缺少 `libwebp`，以下媒体扩展回归 58/59 通过，唯一受阻测试是 `restricted metadata probe accepts PNG JPEG WEBP MP4 WebM MP3 WAV and M4A with no full-decode process`。用例在制作 WebP fixture 时失败，独跑复现相同问题；没有安装替代工具或削弱测试。

```sh
env TMPDIR=/private/tmp node --test --test-concurrency=1 --test-reporter=spec \
  tests/timeline-preflight-business.test.mjs tests/timeline-colour-source.test.mjs
ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=red:s=16x16:d=1 \
  -frames:v 1 -c:v libwebp -threads 1 -f webp pipe:1 > /dev/null
# Unknown encoder 'libwebp' / Encoder not found，退出 8
```

原生桌面窗口交互、真实供应商及真实计费未进行现场测试。
