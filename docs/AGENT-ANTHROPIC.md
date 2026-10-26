# Anthropic Messages

Mio 支持显式选择 `anthropic_messages`，与既有 Chat Completions、Responses 分别适配。使用官方 `@anthropic-ai/sdk@1.3.0`，以 `2023-06-01` 作为 Messages 兼容基线。协议、模型和目标地址由已保存配置决定，不根据名称、URL 或失败响应自动选择。

在「设置 → Mio」独立选择厂商预设和 API 协议。所有预设均可明确选择 Chat Completions、Responses 或 Anthropic Messages，不必为切换协议改选自定义服务。Anthropic 预设默认模型为 `claude-haiku-4-5`，服务根地址为 `https://api.anthropic.com`。预设只提供默认参数，不保证供应商支持每种组合；切换协议不会自动修改已填写的地址或模型。

Messages 在根地址后追加固定的 `/v1/messages`；例如 MiniMax 国内站使用 `https://api.minimax.cn/anthropic`，对应 `https://api.minimax.cn/anthropic/v1/messages`。不要填写完整 Messages 地址，也不会自动剥离、补救或替换用户填写的前缀。完整目标地址显示在设置面板中，切换后需重新核对并授权。

现有预设继续保持原来的默认协议。MiniMax 等服务的现有 OpenAI 兼容连接保持原绑定；需要另一种兼容端点时，在原预设中明确选择协议和填写地址。已维护的专用参数约束保持原行为；此前没有专用配置的厂商／协议组合，从首次请求起使用所选协议的通用参数模板，不根据错误、模型名或地址重新选择。支持一种兼容格式不等于保证该供应商的所有模型都支持同样的工具能力。

本机预设继续只接受回环地址并拒绝连接 Mioon 自身端口：Chat Completions 和 Responses 的基址仍须含 `/v1`，Messages 使用回环服务根地址，例如 `http://127.0.0.1:11434`。Messages 的本机无密钥请求不向 HTTP 传输写入 SDK 占位凭据。开放协议选项不代表 Ollama 或其他本机服务实际提供 Messages 接口。

当前支持文本和 Mio 已有宿主工具，包括工具结果续写。思考模式被关闭，供应商托管的浏览器、联网搜索、执行代码等服务端工具不在此范围内。工具由 Mio 的既有审批、执行方式、步数和项目边界控制，SDK 不接管业务工具执行。第三方兼容服务若拒绝声明的协议字段，会明确失败，不会删除字段、切换模型或换协议重发。

SDK 调用经过项目受控网络传输，继续执行派发前授权、凭据绑定、DNS/连接目标校验、重定向限制、取消、超时及错误脱敏。自动重试关闭；已发送但结果未知的推理请求不会因恢复或网络异常自动重发。

设置继续使用原来的 v2 JSON 信封和凭据绑定结构。旧 v1 设置只在内存中补齐原 Chat Completions 协议，读取不会改写文件或修订号；即使旧模型名或地址看起来像 Anthropic，也不改变协议。已保存的旧任务和请求保留原协议、精确请求体与历史快照，恢复不重新解释成 Messages。

验证使用离线模拟传输、真实 SDK 参数组装和项目授权/恢复链。应覆盖三协议选择、端点与模型变更后旧授权失效、未知协议拒绝、工具分片与结束证据、取消/超时/未知结果、重启不重复发送，以及旧两种协议的历史兼容。离线通过不代表真实供应商、账户或模型已完成调用验证。

本次定向验证包含真实 SDK、受控本地 HTTP、SQLite、CLI 子进程和 stdio MCP。MCP 沿用现有公开工具范围，不新增设置、密钥、任务发送或审批工具；可通过共有的授权接口核对目标，模型也不能调用这些管理操作为自己授权。合法的直接工具调用元数据、空引用与拒绝详情会在校验后剥除，不进入工具续写或公开错误。

旧版本兼容测试使用 `c3a0a57` 的原始协议源码及既有哈希；当前目录新增第三协议不会使旧验证器接受新协议。原 baseline、迁移哈希和未冻结依赖的漂移检查保持不变。

主要验证入口：

```sh
node --test tests/agent-anthropic-*.test.ts
node --test tests/client-agent.test.ts tests/agent-task-storage-diagnostics-v2.test.ts tests/agent-timeline-gain-preservation.test.ts
pnpm typecheck
pnpm build
pnpm desktop:build
```

桌面构建会将 SDK 静态打入后端，并沿现有流程收集 SDK 及依赖的许可证；隔离 bundle 测试不依赖源码目录的 `node_modules`。

2026-10-26 在 macOS 开发版中使用用户配置的 MiniMax 国内站 `MiniMax-M3`，经同一桌面后端的宿主 CLI 完成真实文本、一次项目只读工具往返及一次镜头修改审批。审批等待时正常重启本地服务，原 Run、工具步骤和 119232 字节模型请求的 SHA-256 保持不变，会话凭据及设置修订保留；明确继续后仍停在原审批，没有再次规划。批准只产生一次镜头修改，最终回复完成，本地撤销恢复原文且不增加模型请求。

真实流暴露了 `message_start.message.service_tier` 与最终 usage 的兼容遗漏，现仅校验并剥除这些被动元数据，保留工具、思考内容及终止证据的原校验。修复前的三条失败请求保留原记录，不重发；本次共八个模型步骤，五个完成、三个失败，文本计费以供应商账户为准。媒体任务、素材、版本及导出计数均为零。临时结构诊断已从构建和当前运行后端移除。具体结果见[真实流程验证记录](verification/anthropic-messages-live/2026-10-26.json)。此证据仅覆盖该国内账户、模型和上述流程，不代表其他服务商、套餐、模型、系统钥匙串、完整应用退出恢复或真实网络故障已验证。

官方资料（核对日期：2026-10-26）：

- [Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [流式事件](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [官方 TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript)
- [MiniMax 国内站的 Anthropic 兼容接口](https://platform.minimax.cn/docs/api-reference/text-anthropic-api)
