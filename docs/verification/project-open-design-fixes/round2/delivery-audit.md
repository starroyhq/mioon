# 最终交付证据审计

已只读核对本轮初始执行、分工复验、最终分类和浏览器检查记录；未发现遗漏、子范围冒充整文件通过，或原始失败证据被覆盖。本次仅写入本审计文档，没有修改产品源码或运行测试、构建

## 测试文件覆盖

| 项目 | 文件数 | 依据 |
| --- | ---: | --- |
| 初始逐文件执行 | 772 | [full-test-results.json](full-test-results.json) |
| 初始通过 | 648 | 保留初轮原记录与日志 |
| 初始非零或外层超时 | 124 | 全部进入最终分类，无遗漏 |
| 初始失败后完整文件复验通过 | 98 | UI、schema、settings、root 四组记录去重 |
| 环境阻塞 | 26 | 明确保留失败状态、原因和日志，不计通过 |
| 未分类或待处理 | 0 | 最终 pending 为空 |
| 最终按文件分类通过 | 746 | 648 初始通过加 98 完整复验通过 |

最终分类见 [test-disposition.json](test-disposition.json)。这是一次逐文件完整执行后，再对失败文件做完整文件复验的汇总；不是第二次冻结源码后重新执行全部 772 文件，也未将不同执行中的重复子测试数相加成一次全量结果

核对的分工证据为 [ui-retest-results.json](ui-retest-results.json)、[schema-retest-results.json](schema-retest-results.json)、[settings-test-results.json](settings-test-results.json) 和 [root-retest-results.json](root-retest-results.json)。124 个初始非零文件全部被覆盖；仅 `agent-timeline-app.test.ts` 在 UI/settings 中重复出现，两份均为完整文件通过，没有状态冲突

全部 772 份原始日志仍存在，各条非空 tests/pass/fail/skipped 计数与日志摘要一致；schema/settings 保存的 initial 字段以及最终分类中的 initial 记录均与原始记录相符。通过项的范围、退出码和计数与各自日志一致；未发现 `--test-name-pattern` 结果被标成整文件通过。之前两个仅 pattern 通过的文件已由 settings 补齐完整文件复验，旧局部结果不再承担整文件通过证据

root 的最后三项均已核对真实单文件显式 TAP 结果：asset-disposition-transports 10/10、typecheck-runtime 5/5、ui-components 29/29，均退出 0。ui-components 现已替换先前含不存在第二路径的旧命令记录，不将被忽略路径计入通过

UI 清单另外明确保留了三个 transport 测试只改连续解码、仅由 UTF-8 inventory 审计实际监听表达式而未重跑整套的边界；本审计未将该局部验证扩展为整文件复验结论。环境阻塞详情以 settings 的原日志和原因记录为准

## 视觉与真实指针检查

[visual-review.md](visual-review.md) 已逐页记录 36 页截图目检。最终重拍关闭了导出确认按钮铺满、运行提示遮挡关闭入口、版本缩略图未等待解码以及截图沿用折叠时间线等证据缺口；截图目检未留下明确阻断布局项

已核对最新 [browser-final-checks.json](browser-final-checks.json)：Tooltip 的 Positioner 计算值为 `pointer-events: none`，真实鼠标点击设置成功，紧凑项目可访问名称检查值为 1，64 个矩阵状态没有视口越界，`pageErrors` 为空

Tooltip 小补仅作用于直接包含 `workbench-tooltip-popup` 的 presentation 定位父层，现有内容均为只读文本，保留原 Trigger、键盘焦点和工作区可见性门禁；静态审查与上述真实指针结果一致，没有扩大到菜单、选择器或交互弹层

本审计不以截图替代异步准入、取消终态竞态、媒体能力或原生文件操作验证。26 个环境阻塞仍保留；构建与其他行为验证应同时参阅主代理的实际执行记录，不能由本审计文档推定通过
