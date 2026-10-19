# 界面文案段尾标点

后续状态：下文记录的 7 个失败文件均已修复，相关 36 文件418项全部通过，见[修复与续验](../test-repairs/README.md)。本目录保留文案修改当时的实际结果。

按用户要求，统一去掉界面每段最后的中文/日文句号 `。` 和英文句点 `.`，保留同一段内的句号。示例现在显示为“全局设置独立于项目。片段属性和导出选项仍在各自的工作区”。

本轮静态修改 29 个 i18n 文件中的 6,889 条四语言模板（含缺失文案的固定兜底），以及 4 个原生源文件的 7 条可见失败提示。多段模板逐段处理，395 条以省略号结尾的模板原样保留；动态参数、用户输入、文件名、链接和品牌字标保留原文。没有加入运行时裁剪。`docs/UI-COMPONENTS.md` 已记录规则。

原生中文文案对应的 5 条既有 literal ledger 哈希同步更新，owner、理由与例外条目数保持原样。17 个测试/浏览器文件适配了固定文案预期；原始 Error 对象、错误码、生命周期、精确匹配与转义断言保留。

## 实际验证

- [静态核对](catalog-verification.json)：16,188 个实际文案分支逐个与修改前比较，变化仅限段尾标点；四语言、占位符及复数结构通过，用户文本和参数中的标点保持。
- 隔离副本冻结安装、`node scripts/tooling.mjs typecheck` 和 `node scripts/tooling.mjs build --channel=development` 均退出 0。33 个生产源文件及 61 个构建文件逐字节核对，见[源码](source-hashes.json)、[构建](build-artifacts.json)与[命令日志](logs/)。
- [真实浏览器](browser/results.json)：四语言 × 1440×900、1050×680 共 8 个设置页面状态通过，0 页面异常、0 外部请求。逐段检查可见提示末尾，确认示例的段内句号仍在。[简体截图](browser/zh-Hans-1440-settings.png)、[英文截图](browser/en-1440-settings.png)。
- 29 个测试文件逐文件独立进程、真实 TMPDIR、900 秒超时执行。最终 22 文件通过、7 文件失败；375 项中 356 通过、19 失败，0 跳过。初次运行中由句号差异触发的 `i18n-task-errors` 预期已适配并通过。完整记录见[测试结果](test-results.json)，不记作整套通过。

## 检查中暴露的既有问题

以下问题与本轮标点修改分开记录。恢复修改前的 i18n 目录并还原两处导出文案预期后，对 5 个文件作对照运行，失败子项名称和数量一致；MCP/CLI 三个文件对应的缺失 key 也在修改前后完全相同，见[操作 key 对照](operation-key-comparison.json)。

| 文件/范围 | 实际失败原因 |
| --- | --- |
| `export-history-ui`、`named-delivery-ui` | 旧 SSR 测试仍期待直接下载链接；界面已迁入需要异步检查文件的 `ExportFileActions` |
| `i18n-command-unit`、`i18n-command-presentation`、`i18n-backup-mcp-diagnostics` | 上轮新增的 7 个操作缺少本地化 key，导致带 locale 的工具说明生成失败；旧 help 快照另缺新增操作 |
| `i18n-catalog-integrity` | 剩余界面字标/单位等旧 ledger 条目与上轮组件迁移未同步；本轮 5 条原生文案 hash 已同步 |
| `desktop-media-shutdown` | 原 VM 夹具缺少 `CLIP_LUT_RECOVERY_CHANNEL` 绑定，4 个子项报 ReferenceError |

这些失败未通过降低校验、恢复旧下载行为或增加运行时 fallback 处理。对应的源代码与协议行为保持本轮之前的状态，日志保留供独立收尾。

原工作区保持原样；本轮没有提交、推送、发布、真实供应商调用或依赖变更。临时环境清理见[记录](cleanup.json)。
