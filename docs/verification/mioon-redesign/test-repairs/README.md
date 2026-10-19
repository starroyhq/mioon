# 七个失败文件的修复与续验

用户要求修复上一轮记录的 7 个失败文件。现已全部通过，并修复相邻启动重启测试的同类夹具遗漏。最终 **36 个文件、418 项全部通过，0 失败、取消或跳过**；类型检查和 development 构建退出 0。

## 修改

| 范围 | 修复及保留的约束 |
| --- | --- |
| 四语言 CLI/MCP | 补齐项目重命名、删除、摘要、三种授权操作和波纹删除共 7 个 operation key；带 locale 的 MCP 启动和工具发现恢复正常。机器 schema、原始操作描述和运行时缺失 key 校验保持原契约 |
| CLI help 预期 | 从未修改的冻结 fixture 显式插入新增操作，保留旧字段、字节和操作顺序；预期不由实际输出生成 |
| 导出历史/命名导出 | 组合测试捕获真实列表传给 `ExportFileActions` 的身份和 URL，再渲染真实组件初始状态；正常下载仍先检查文件。保留 URL 优先级、固定 ID、编码转义、深冻结、顺序、历史记录和服务端文件名约束 |
| 原生退出/启动重启 | VM 夹具补齐真实 LUT、工作区工具及外观依赖；严格验证 5 个 IPC 注册且拒绝重复。原 28 项退出和 27 项重启竞态用例完整保留，生产宿主源码未变 |
| 静态文案 ledger | 删除恰好 10 条已失效身份，逐项核对并登记恰好 16 条当前固定字面值：单位、品牌、路径、MIT 署名及已由 descriptor 呈现的原始诊断。每条均限定文件、分类和 SHA256，扫描规则保持原样 |

新增四语言说明沿用段尾无句号的规则。授权说明明确内置 Agent 模型工具不能自授权；重放授权不会恢复随后已撤销的授权。没有通过默认 fallback 绕过缺失 key。

## 实际验证

- 原 7 个失败文件均退出 0；其余原有文案检查、真实异步文件动作、HTTP 文件恢复、导出流程、原生生命周期及 HTTP/CLI/官方 MCP 的项目摘要、授权、波纹删除回归共 **418/418** 通过。按文件去重，见[完整结果](test-results.json)。
- 全部文件独立 Node 进程、真实 TMPDIR、900 秒外层超时；相邻 race 首次 27 项夹具失败的原始日志保留，最终有效结果另行列明。
- `CI=true pnpm install --frozen-lockfile`、`node scripts/tooling.mjs typecheck`、`node scripts/tooling.mjs build --channel=development` 均退出 0，见[安全日志](logs/)。
- 静态扫描为 668 条已审字面值，unreviewed 和 stale 均为 0；[修改前](ui-ledger-before.json)、[修改后](ui-ledger-after.json)及[逐条理由](ledger-review.json)分开保存。
- 冻结 `cli-help-legacy.json` 与 HEAD 逐字节一致；10 个变更文件与隔离验证副本一致，61 个构建文件已核对，见[源码 hash](source-hashes.json)、[构建 hash](build-artifacts.json)和[验证元数据](verification.json)。
- 独立交叉检查未发现确定问题；导出真实 leaf 的 9 项状态/归属测试及 HTTP 恢复测试实际执行通过，SSR 捕获替身不伪造检查完成或下载成功。

本轮验证范围为上述 36 个相关文件，不代表全套测试或打包发布验收；原生 OS 文件选择器、浏览器视觉验收沿用前轮各自范围。原有全套测试与环境阻塞仍见[总状态](../STATUS.md)。

没有提交、推送、发布、真实供应商调用或依赖变更。原工作区保持原样，独立工作树保留；临时副本清理见[记录](cleanup.json)。
