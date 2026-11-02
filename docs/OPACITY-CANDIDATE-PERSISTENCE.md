# 片段透明度：内部持久化候选

**历史记录。** 透明度候选（固定 42/43 工作区、候选网页入口、候选备份档案和 40→42 升级命令）已在 #119（P1b，2026-11-02 合入）整条删除，本页写到的入口、命令和代码大多已不存在。下文保留 2026-10-16 当时的记录，不再更新。迁移链里的 `packages/business/src/workspace-opacity-legacy.ts`、`workspace-opacity-validation.ts` 和 `packages/contracts/src/timeline-opacity-persistence.ts` 暂时保留。

日期：2026-10-16。此片完成内部固定 42/43 工作区的保存与恢复基础，尚未作为普通产品功能启用。默认生产工作区仍为 40/41；没有自动迁移、RPC 开关或用户数据指定的校验器。

后续候选 Inspector／四语言／v3 草稿接线见[内部编辑器记录](OPACITY-CANDIDATE-EDITOR.md)。本页下方“仍需后续交付”描述此持久化提交时的范围；实际画面渲染仍未接入。

## 已实现范围

- `openOpacityCandidateStore` 仅构造空的应用自有 42 库，或重开精确 42/43；现有 40 库原样拒绝升级。固定 43 安装器从 42 构造 `restored-local-v10`，保留原始证据字节及 held 记录。
- 私有 store 与 service 绑定把候选接入现有 `createServices`、时间线事务及 `createEditTasks`。透明度更新复用同一套 revision、历史、幂等回执、原子提交及任务协调器，未另建写入引擎。
- 候选允许片段更新、撤销及重做；不开放添加片段、渲染、provider、Agent 或媒体执行。曲线最多七个片段局部帧关键点，值为有限的 0–1 线性透明度。裁短越过关键点时必须在同一 patch 替换曲线或显式清空。
- 42/43 独立验证实际 catalog、marker 及完整原始 JSON。组合 opacity、volume、audioRole、colour 时，先验证透明度原文，再把只读结果交给原有特性扫描器；不改写原文、不伪造旧 schema 标记。
- 43 继续要求显式 origin、新请求身份、当前任务 claim/epoch 与有效 invocation。能力绑定实际 store、DB、root 和锁；跨库、复制、关闭、锁失效、catalog 或 origin 篡改均不能复用。
- prepare 保持 128 节点／深度 8、意图 8 KiB、任务 16 KiB，完整时间线／历史／普通回执保持 256 KiB。已有 loudness 独立 320 KiB 回执的只读契约保留。旧字段及未知字段拒绝规则保留。旧本地草稿读写器仍不接受透明度；v3 目前只有隔离的数据契约。

新增 runtime 均为 TypeScript，三个现有 JavaScript 文件只包含最小装配接缝。冻结清单中的 64 个旧实现／夹具保持原哈希；没有扩大 legacy allowlist、放宽类型检查或修改冻结历史构造器。

## 验证边界

测试只使用内存数据和临时应用自有 SQLite 库中的合成项目／素材元数据。验证实际任务 prepare/execute、持久化、重开、历史回放、撤销／重做、失败原子回滚，以及 origin、held、epoch、跨库和过期能力拒绝。另运行原有任务与音量包络回归及 canonical strict typecheck。

最终定向测试 171/171 通过，零跳过；`node scripts/tooling.mjs typecheck` 通过。独立复测实际事务及字节边界 8/8。真实回执 INSERT 后故障会回滚时间线、历史、游标及 redo 替换，且不错误签发 `not_applied`；同请求随后可重试。262143→262144 字节保存成功，262144→262145 字节在首次写入前拒绝。Provider 触碰和媒体进程事件均为零。

本机执行环境为 Node v26.9.0；这不是 Node24、打包版或真实媒体验收。旧 `workspace-schema40-dispatch.test.mjs` 固定断言 Node v24.21.0，本环境无法给出该项通过证据；不修改其断言。

## 仍需后续交付

实际画面合成／预览／导出仍未消费透明度，Inspector 和关键帧编辑器尚未接入。简中、无地区标签的繁中、英文、日语的产品文案及交互验收随该入口实现。真实媒体验证需另行确定必要的最小范围；此片不代表用户已经能看到透明度动画。

默认工作区启用、现有项目迁移、v3 草稿实际读写及发布验收也未交付。位置、缩放、转场等其他动画不属于此片。
