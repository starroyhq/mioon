# 独立审查记录

基线：`2d7b0521df3cad45270958b0bec071cde5c8bb17`。审查对象是隔离工作树中未提交的改动；没有通过空的 `HEAD` 提交差异代替实际工作区差异。

本记录由主代理整理当前 Codex 会话中的独立子代理审查结果。原始报告保留在该会话的子代理消息中。初轮 Standards 与 Spec 分别由 `workflow_standards_review`、`workflow_spec_review` 执行；最终 CLI/SDK/Windows 收口由 `skill_cli_acceptance` 做 Standards、未参与实现的 `cli_sdk_final_spec` 做 Spec。均只读审阅，独立测试仅使用合成/本地 fixture，不操作真实服务、UI 或真实凭据。

| 批次 | 实际范围 | Standards | Spec |
| --- | --- | --- | --- |
| 初轮 | 桌面设置桥、只读加载恢复、发送前证据、字幕能力及 CLI/Skill 调整 | no finding | no finding，另核对两份原始设计文件 |
| 工具 schema | 生成器、引用投影 helper、生成表及工具回归 | no finding；独立定向 4/4 | no finding |
| Worker | 可信控制阻断按候选处理，审计失败仍终止本轮 | no finding | no finding |
| 产物容器保留 | tools/runtime/journal 三个生产文件及两份回归；唯一镜头、来源证明、事务、补偿链与恢复 | no finding | no finding |
| 测试类型修复 | runtime 测试字段断言与 Mock Provider context 适配 | no finding；确认未削弱栅栏及断言 | 生产实现未变化，沿用上一批结论 |
| 纯 CLI / 密钥 / 诊断 | 独立客户端、管理命令、诊断隔离、凭据辅助进程、存储组合 | no finding；spawn close 边界修复后复审 | no finding；最终六文件独立回归 41/41 |
| 官方 OpenAI SDK | 固定依赖、custom fetch bridge、三处新旧网关接线及双协议回归 | no finding；最终 gateway 32/32 | no finding；独立 gateway 30/30、环境覆盖 4/4 |
| DeepSeek 名称格式投影 | 两个固定工具的模型格式提示，原始领域校验保留 | no finding；独立 4/4 | no finding；独立 4/4，实际工具拒绝非法名称且零副作用 |
| Windows 固定句柄增量 | 真实 Stats 回调、完整身份、共享模式修复 | no finding；代码审阅，不冒充重复 VM 测试 | 旧 backup/draft 最早拒绝 guard 独立 no finding；跨平台范围限制另列 |
| Windows 离线备份补齐 | opaque lease、分块复制、原生 flush/发布、恢复、bundle 和入口初始化 | no finding；普通父目录 flush 修复后复审 | no finding；独立核对 14 native、3 backup、2 vault、1 CLI 原生日志及 12 项源码指纹 |
| 配置未知结果读回 | 原连接一次 GET，保留 UNKNOWN、公开观察及取消语义 | no finding；读回期间 Ctrl+C 的退出码修复后复审 | no finding；独立 CLI/client/doctor/publication 32/32、0skip |

最后一批审查确认：保留分支仅限单一 `shot.create`，先检查修订、草稿、内容和连线；全部任务须匹配同 Run 的真实生成步骤、受理身份和不可逆 Change。保留记录与事件同事务提交，原始 before/after/undo 留存，不伪造回退目标。控制完成失败继续沿用逐 Change 提交与重启阻断语义。

审查结论针对代码差异。纯 CLI 真实回复、完整目录只读往返和 40 步自主剪片已通过，详见 [CLI-SDK-ACCEPTANCE.md](CLI-SDK-ACCEPTANCE.md)；旧原生界面历史阻塞不能代替 CLI 验收或被 CLI 通过抹去。Windows 双账户隔离已取得原生证据；legacy manual-draft、受其保护的 project.delete 及未验证平台仍单独记录。

## 已修复并关闭的 Spec finding

批准计划要求 Windows 离线备份统一使用原生能力；原先 guard 只证明安全拒绝，未完成所需功能。现已补齐有界流式复制、完整文件身份、原子发布与恢复，Windows 原生 65 MiB create/verify/restore/status、bundle、取消及不确定发布均通过。最终 Spec 已独立核对真实日志与冻结源码指纹，不再用 guard 或 POSIX 跳过替代原生实现证据。

收口结论：Standards、Spec 均 **no finding**。三系统密钥及 Windows 原生必要验证已完成；桌面旧草稿和发行范围限制不扩大为已支持能力。没有 commit、push、部署或发布。

`reviewed-code-fingerprints.json` 记录审查收口后当前改动的代码、测试、工具说明及 Skill 文件 SHA-256，用于识别后续变动；不包含凭据或运行数据库。
