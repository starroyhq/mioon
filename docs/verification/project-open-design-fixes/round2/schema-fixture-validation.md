# 第二轮 schema 与当前版本夹具复验

普通工作区当前版本为 50，精确恢复目标为 51 / `restored-local-v14`。原 schema48 黄金、历史恢复实现、旧 TypeScript 迁移 hash 和 opacity 候选 46/47 保持原有边界

## 实际产品修复

`lutRestorePolicy` 原先遗漏精确恢复版本 51，导致同一恢复工作区中 LUT 读取已经成功，但 `workspace.restore.inspect` 披露为不可用。仅将 51 加入原有显式列表；导入仍不可用，50/52 等未支持版本仍拒绝。没有放宽历史分类器

## 夹具修复原则

- 使用当前 `openStore` 创建的普通库明确验证 50→51，不将它误写为历史 48→49
- 历史 schema14/17/22 等旧行和 SQL 仍逐字节比较；新增 schema50 的两张空表和十个 SQL 对象依据独立冻结 delta 另行验证
- opacity 测试只调整普通支路的当前版本期望，候选支路及权限断言保留
- 首页摘要测试固定其测试时钟，确保原有“资产时间晚于项目/时间线”的样本语义不会随实际日历日期失效

## 完整文件复验

以下均使用 `TMPDIR=/private/tmp node --test <file>`，每个文件独立进程，保留原时限

| 测试文件 | 结果 |
| --- | --- |
| `lut-resources-contracts-client.test.ts` | 7/7 |
| `look-pack-inspection.test.mjs` | 12/12 |
| `lut-resources-backup.test.ts` | 2/2 |
| `project-home-summary.test.mjs` | 2/2 |
| `subjects-migration.test.mjs` | 8/8 |
| `opacity-candidate-application-services.test.mjs` | 7/7 |
| `opacity-candidate-transactions.test.mjs` | 7/7 |
| `server-storage.test.ts` | 30/30 |

共 75 项通过。逐项真实日志与耗时清单位于 `/private/tmp/mioon-round2-full-tests/reruns/schema50-fixture-results.json`，此表不是全项目验收结论

独立 schema50 runtime map 仅更新已审查的当前文件 hash；旧 pin 和历史来源不变。`export.cancel` 清理效果声明变更后，gain preservation 完整 12/12 通过，包含额外源字节漂移仍被拒绝的负例。`inspection-contracts` 完整 5/5 通过，保留 descriptor 冻结与共享 schema、CLI、官方 MCP 的严格一致性断言
