# 隔离夹具复制与服务重启排查

2026-10-20，仅使用合成验收目录 `/private/tmp/mioon-full36-r3-uf1tcdln`，未修改主服务或应用代码，未打印令牌

复制旧工作区后，5 个 companion 文件携带原目录的同一 `workspaceScope`；新目录基于路径、目录/数据库文件身份计算的 scope 不同。首次 `UI_PREFERENCES_SCOPE_MISMATCH` 是跨目录复制保护。主代理停止服务后，将 `ui-preferences-v1.json`、`local-drafts-v1.json`、`local-delivery-v1.json`、`agent-authorizations-v1.json`、`last-project-v1.json` 移出工作区并以 `copied-*` 保留，没有改写其 scope，也没有清除原夹具

重启后，读取 3 个现有片段的 `/api/local-drafts/clip` 均返回 HTTP 200、`supported:true`、`revision:0`、`draft:null`、`targetStatus:matching`。连续两次列表 GET 也返回 200/空列表；所有回复的 `workspaceScope` 和 `instanceId` 一致。工作区无 `local-drafts-v1.json`，后端没有继续读到跨目录文件

旧 IAB 页面仍报身份变化，是重启前 ClipDraftController 留有旧服务实例确认。`apps/web/src/clip-draft-state.ts:144` 明确拒绝跨 scope/instance 的重新读取，并要求重新载入页面；“重新核对”不会采用新实例覆盖旧授权。既有 `tests/clip-draft-ui.test.mjs:194` 专门覆盖该保护。主代理用新 IAB 标签页打开同一项目后，草稿恢复正常且无暂停，确认属于夹具生命周期问题

后续夹具操作：复制到新目录时先保留并移出跨目录 companion；服务重启后使用新页面/完整重载，并在有未保存输入时先明确保留或处理。不要修改产品身份校验或删除用户草稿来绕过保护
