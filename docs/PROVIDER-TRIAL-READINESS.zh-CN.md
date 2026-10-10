# Mioon 供应商试用准备与核验边界

核对日期：2026-10-10 UTC。代码基线：`7b85186`。本文整合供应商核验草案，已重新对照当前适配器、[配置模板](../.env.example)与[供应商实现说明](PROVIDERS.md)。本次只读取代码和官方公开文档，未执行构建、测试、真实生成、媒体上传、账户操作或配置修改，也未读取真实密钥或当前账户配置。

**现在可以准备本地 mock 试用；五家真实供应商均未完成真实核验，本文不授予调用或付费权限。** 后续真实核验须先补齐[单次授权确认](LIVE-VERIFICATION-APPROVAL.zh-CN.md)。

## 1. 三类证据分别说明

| 证据层 | 当前能说明什么 | 不能据此说明什么 |
| --- | --- | --- |
| 官方文档与代码核对 | 精确模型、固定 API 入口、实现参数和公开协议可逐项对照；下表是当前适配器的窄范围子集 | 账户已开通、区域资格满足、在线 API 可用、真实媒体质量、实际价格或成功率 |
| 本地 mock／离线契约 | mock 的本地合成 MP4 可用于体验导入、生成流程、剪辑、恢复与导出；仓库测试使用注入 HTTP 响应检查映射和异常边界 | mock 不是供应商生成；离线契约不是付费 API 实测。本次没有重跑这些测试或完成新的 mock 验收 |
| 真实供应商核验 | 五家适配器均声明 `liveVerified: false`，真实提交、输出和账单仍待单独授权后核验 | 不能把某个模型／区域的一次成功推广为所有供应商已验证 |

`provider.list` 的 `available` 只表示本地配置与次数门槛允许请求，不表示真实可用、费用已批准或 `liveVerified` 已变为真。能力返回值不包含密钥值；本次未查询正在运行的实例，也未确认任何账户已经配置。

## 2. 当前实现的精确模型与区域

以下限制来自当前代码，官方依据见第 6 节。供应商公开能力可能更广，不会自动扩展本应用的支持范围。

| 供应商 | 精确模型与固定入口 | 当前实现子集 | 真实试用前仍需解决 |
| --- | --- | --- | --- |
| Runway | `gen4_turbo`；`https://api.dev.runwayml.com`；无区域切换配置 | 必须一张首帧图；整数 2–10 秒；9:16、16:9、1:1、3:4、4:3、21:9；9:16 映射为 720×1280；可选 `seed`；未暴露音频控制 | 账户／组织、模型资格、精确素材与提示词、报价和总预算。可作为首个单供应商候选，但未真实核验；当前实现无需迁移到 `gen4_aleph` |
| 火山方舟 Ark | `doubao-seedance-2-5-260628`；中国北京 `https://ark.cn-beijing.volces.com/api/v3` | 文生或一张首帧图；4／8 秒；9:16、16:9；720p、MP4、`generate_audio: false`；首帧按 `ratio: adaptive` 保持输入比例 | 中国区账户、该模型资格及账户报价；不能将其他区域服务或其他 Seedance 型号视为同一授权目标 |
| Gemini Veo | `veo-3.1-generate-preview`；Gemini Developer API `https://generativelanguage.googleapis.com/v1beta` | 文生或一张首帧图；4／6／8 秒；9:16、16:9；720p；音频始终开启；不是 Vertex AI 接口 | 账户、地区限制、报价与下载行为；**官方最早可能停用日为 2026-10-22**，见下节 |
| MiniMax | `MiniMax-H3`，V2 API；`MINIMAX_REGION=global` → `https://api.minimax.io`；`cn` → `https://api.minimax.cn` | 文生或一张首帧图；4／8 秒；9:16、16:9；768P；首帧 `ratio: adaptive`；`/v2/video_generation`、`task_id`、`task.content.url`；未暴露音频控制 | 明确区域、匹配区域的账户凭据、报价。当前代码已是 H3 V2，无需按旧 Hailuo V1 方案重新迁移；实际音轨须验收 |
| Vidu | `viduq3-turbo`；`VIDU_REGION=global` → `https://api.vidu.com`；`cn` → `https://api.vidu.cn` | 文生或一张首帧图；4／8 秒；9:16、16:9；720p；`audio: false`、`off_peak: false`；Token 鉴权 | 区域账户与报价；**提交前必须独立核实精确 `VIDU_OUTPUT_HOSTS`**。首帧生成不发送 `aspect_ratio`，依靠匹配的输入比例，实际输出尺寸仍待真实核验 |

MiniMax／Vidu 默认区域为 `global`，非法区域会被拒绝；不跨区回退。已有任务保留其区域快照，切换配置不能作为原任务的恢复方案。

一张 720×1280、低于 3 MiB 的 PNG／JPEG 合成图，以及 4 秒、9:16，是五家适配器本地约束的共同候选，**不是五家线上必然受理或产生相同输出的保证**。Ark 与 MiniMax 还校验实际图片尺寸范围和精确比例。新增模型、更多时长／分辨率、多参考素材、视频编辑／延长均属另行扩展，不阻塞当前 mock 试用。

## 3. 两个需要单独处理的门槛

### Veo：最早可能停用，不是确定停用

[Google 官方停用计划](https://ai.google.dev/gemini-api/docs/deprecations/)于 2026-10-09 更新；表中 `veo-3.1-generate-preview` 的日期为 **2026-10-22**。页面明确这些日期是最早可能停用日期，不能改写成“已停用”或“保证在该日停用”，也不能保证此日期之前某个账户必然可用。

每次未来试用前重新核对官方状态及账户可用性；**2026-10-22 当天或之后暂停沿用本报告的可用性判断，重新核验后再决定是否提交**。官方列出的替代项是 `gemini-omni-1.1-flash`，但本仓库没有该适配器。现有代码同时固定提交模型、operation 名称匹配和结果下载协议，不能只替换字符串便宣称兼容。迁移和新的付费核验需独立决定。

### Vidu：输出域名必须先有独立可信依据

当前代码没有默认可信的 Vidu 输出 CDN；缺失有效 `VIDU_OUTPUT_HOSTS` 时，`configured` 为假且提交被拒绝。公开任务结果示例仍为占位 URL；输入示例素材主机不能作为输出 CDN 的证据。

未来执行前，应由对应区域的官方账户资料或经核实的官方支持说明确认精确主机名，并记录来源、区域和核对日期。仅有 API key、DNS 可解析、TLS 有效，或某次生成响应出现一个新主机，都不足以证明它应该进入白名单。不得使用通配后缀、任意完整 URL，也不得先付费生成来绕过“先核实输出域”的门槛。

若既有任务后来返回未批准主机，暂停下载，独立核实该主机，再恢复同一个任务。不要为获取另一个 URL 创建第二个付费任务。国际站文档本次读取受限，详情见第 6 节，因此仍需在选择 `global` 的执行前复核该区当前协议。

## 4. 次数、金额与异常不能混为一谈

- `*_MAX_GENERATIONS` 由共享服务按**当前数据目录内该供应商的全部已记录 jobs**计数，不按成功视频数计数，也不按区域／账户分别记账。已经入队后又失败、取消、拒绝或结果未知的任务仍保守占用次数；创建本地 job 之前被校验拒绝的请求不会因此生成一条 job。
- 若已记录 N 个任务，批准新增 1 次对应总阈值 N+1；执行前以安全的能力返回值确认 `usedGenerations`／`remainingGenerations`，不要固定填 `1`，也不要删除记录或更换数据目录重置授权额度。
- 次数限制不是金额限制，不追踪 USD／CNY 扣费，也不覆盖同一账户在其他软件中的消费。必须另行确认当前账户报价、适用费用、已有结算方式与本次总金额上限；不能证明可控制在上限内时，停止提交。
- `submission_unknown` 表示请求可能已受理且可能计费。网络中断、提交超时／中止、不明确 HTTP 状态或缺少有效任务 ID 都不能当作“未提交”。保留本地记录，调查原任务；`reconcile()` 返回空值也不允许重新提交。
- 已知任务的轮询／下载失败只允许在授权范围内恢复该任务；任务 `failed` 也不自动证明未扣费、可退款或获准再试。一次确认中的“新增 1 次”不包含失败后另一笔生成。
- 当前五家真实适配器均只停止本地等待，不保证远端停止或退款。Runway／MiniMax 的远端删除接口还涉及终态记录删除，本应用没有以取消名义调用它们。

对应实现：[provider-registry.mjs](../packages/business/src/provider-registry.mjs)、[services.mjs](../packages/business/src/services.mjs)、[live-common.mjs](../packages/business/src/providers/live-common.mjs)。

## 5. 最小真实核验流程与完成条件

以下是未来执行方案，当前未启动：

1. 优先完成本地 mock 体验；若要真实生成，先完成[授权确认](LIVE-VERIFICATION-APPROVAL.zh-CN.md)。首轮可只选 Runway，明确一个账户、一张已审素材、完整提示词、4 秒、9:16、最多新增 1 次及总金额上限。
2. 在明确批准的执行阶段安全配置所选后端；重新核对模型、区域、账户可用性、价格、素材 SHA-256、次数余额与输出主机条件。配好密钥并不代替调用授权。
3. 提交一次，持久化本地请求 ID 与供应商任务 ID；后续只查询原任务。接受状态不明时暂停并对账，不更换请求 ID 重发。
4. 对已知成功任务下载并进行媒体探测及完整解码，核对来源、实际时长、宽高、画幅、音轨和本地导入／播放／剪辑／导出。下载失败或画幅不符不触发再次生成。
5. 在供应商账户核对是否扣费、实际金额、币种和账单状态。账单尚未结算时标注“技术核验完成、费用待确认”，不写“费用已验证”或“免费”。

成功报告至少包含日期、供应商／账户的非敏感标识、区域、精确模型、批准范围、素材校验值、本地任务 ID、供应商任务 ID、终态、媒体检查结论与费用证据。不要收录 API key、授权头、完整签名下载 URL 或无关账户信息。失败报告保留原任务状态与待调查事项。任何一次真实成功都不自动修改代码中的 `liveVerified`，也不构成下一次调用授权。

## 6. 官方来源与阅读限制

以下链接于 2026-10-10 核对。公开说明与实现核对不能替代账户验证；实际价格、凭据、额度、线上结果和生产 CDN 均未验证。

- **Runway**：[当前 OpenAPI](https://docs.dev.runwayml.com/openapi.json)可读，确认 `gen4_turbo`、2–10 秒整数及比例映射；代码：[runway.mjs](../packages/business/src/providers/runway.mjs)。
- **Ark**：[模型列表](https://docs.volcengine.com/docs/ark/model-list?lang=en)、[创建视频任务](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)。直接打开创建页只得到 JavaScript 外壳；本次通过官方文档的搜索索引核对精确模型、中国北京入口、720p 与首帧 `adaptive` 限制。代码：[ark.mjs](../packages/business/src/providers/ark.mjs)。
- **Veo**：[生成指南](https://ai.google.dev/gemini-api/docs/veo?hl=en)、[停用计划](https://ai.google.dev/gemini-api/docs/deprecations/)正文可读；代码：[veo.mjs](../packages/business/src/providers/veo.mjs)。更细的 REST 字段／下载协议证据沿用[现有实现说明](PROVIDERS.md#gemini-veo-31-preview)，本次没有重新逐行核验官方 SDK 源码。
- **MiniMax**：[国际站 V2 创建](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)、[中国站 V2 创建](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create)、[V2 查询](https://platform.minimax.io/docs/api-reference/video-generation-v2-query)正文可读，确认 H3、对应区域入口与 V2 协议。代码：[minimax.mjs](../packages/business/src/providers/minimax.mjs)。
- **Vidu**：[中国站 Q3 图生及结果查询](https://platform.vidu.cn/docs/api-reference/video-models/vidu-q3/image-to-video)、[国际站任务查询](https://platform.vidu.com/docs/api-reference/task-management/task-detail)可读；[国际站 Q3 图生](https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/image-to-video)与[文生](https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/text-to-video)本次直接读取失败。国际站[旧图生路径](https://platform.vidu.com/docs/image-to-video)和[旧文生路径](https://platform.vidu.com/docs/text-to-video)直接打开显示文档未找到，官方域名的搜索索引仍返回旧正文，可佐证实现来源但不是完整的新页面复核。未根据示例猜测输出 CDN。代码：[vidu.mjs](../packages/business/src/providers/vidu.mjs)。

离线证据入口：[providers.test.mjs](../tests/providers.test.mjs)、[providers-v4.test.mjs](../tests/providers-v4.test.mjs)、[providers-additional.test.mjs](../tests/providers-additional.test.mjs)、[Runway 离线验收](ACCEPTANCE-RUNWAY-PARITY.md)。这些是已有代码与记录，本次没有运行测试。
