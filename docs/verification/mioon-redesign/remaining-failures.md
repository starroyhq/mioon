# 剩余失败与基线对照

本页为浅色启用阶段的历史10文件记录；后续修复和755文件完整复验已另存[最新报告](full-test-repairs/README.md)，当前原10文件中4通过、6媒体环境受阻。本页原始对照保留，不覆盖历史证据

2026-10-19，只读比较父代理指定的10个测试文件；没有重跑、修改源码或同步验证副本。基线日志从 `results.jsonl` 按完整 `tests/<文件名>` 精确匹配；候选采用 `focused-final-regression`，仅 `timeline-media` 改用最后的 `focused-legacy-media-final`。精确日志路径、失败子项全名、断言、退出码及行号见 `remaining-failures.json`。20份原日志已按字节归档至 `logs/remaining/baseline/` 与 `logs/remaining/candidate/`，JSON包含相对证据路径与SHA-256；归档前本地凭据模式扫描匹配数为0。

两侧均为66项：46通过、20失败、0跳过；20个失败含3个父级聚合，实际失败子项17个。失败子项集合完全一致，未发现新增失败子项。仍有1处实际断言值变化、2处拒绝诊断变化，不能将这些文件记为通过。

| 文件（均 `.test.mjs`） | 两侧通过/总计 | 对照结果 |
| --- | --- | --- |
| `cli-v4` | 5/9 | WATCH_TIMEOUT；任务停在 downloading；退出码实际5/期望0。后续版本数实际0/期望1、预期冲突退出3但实际成功0均相同。 |
| `export-settings-media` | 19/20 | 同一 native/360/1080 + 字幕测试报 MEDIA_EXIT_FAILED / Local media tool failed. |
| `integration` | 2/9 | A4/A7/A8 的 job 均 downloading，携带 MOCK_RENDER_FAILED；A5/security 读 undefined.id，A6 读 undefined.url。 |
| `local-drafts-transports` | 6/7 | 同一旧 schema-26 备份断言：基线实际40、候选实际48，期望均26。 |
| `mcp` | 0/1 | 同一 Mock job 携带 MOCK_RENDER_FAILED，实际 downloading / 期望 succeeded。 |
| `reference-recovery-transports` | 1/2 | 同一重启报 RESTORE_SCHEMA_UNSUPPORTED；夹具 DROP immutable_reference_responses 后未重建。 |
| `timeline-image-transports` | 4/5 | 同一 restored33 接线测试报 RESTORE_SCHEMA_UNSUPPORTED / Workspace schema role is unsupported。 |
| `timeline-mcp` | 0/1 | 同一 Mock job 携带 MOCK_RENDER_FAILED，实际 downloading / 期望 succeeded。 |
| `timeline-media` | 8/10 | 唯一叶失败为 v1 selected-shot export：MOCK_RENDER_FAILED，实际 downloading / 期望 succeeded；8项通过。 |
| `timeline-recovery-transports` | 1/2 | 同一重启报 RESTORE_SCHEMA_UNSUPPORTED；夹具 DROP immutable_timeline_responses 后未重建。 |


具体边界：

- `local-drafts-transports` 仍要求当前冷备份是26；基线实际40、候选实际48。此断言本来已失败，实际值前进是本轮可见差异。
- 两个 recovery 测试会删除不可变回执触发器，恢复响应内容后直接重启；基线已经拒绝缺失保护。候选继续返回同一 `RESTORE_SCHEMA_UNSUPPORTED`，但文案与栈入口移至48/49固定目录检查。
- `timeline-image-transports` 的历史夹具仅删34 marker，不能把当前目录变成合法32/33。两侧都在历史恢复安装处拒绝，而不是检查恢复后的三传输行为。
- Mock 集成中的 `MOCK_RENDER_FAILED` 与 downloading 状态为直接证据；CLI 的 watch 超时及后续版本/冲突断言依赖同一未完成的生成。将它们与渲染链相联属于源码支持的推断。
- `export-settings-media` 仅给出通用 `MEDIA_EXIT_FAILED`，TAP 未展开底层 stderr；只能确认同一子项、错误码和文案，不能据此证明具体根因均为缺少 `drawtext`。

本报告只说明指定日志中的失败没有增加；未执行到的后续行为仍未验证。

发布整理：20份TAP原日志增加`.tap`后缀，原始字节与hash保持不变；历史hash清单保留当时路径，迁移映射见`full-test-repairs/publication-scope.json`
