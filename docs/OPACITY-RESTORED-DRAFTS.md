# 恢复43当前origin的新片段草稿

日期：2026-10-16 UTC。开发基线：`eee1db48686dff5db8f4f0c9434b96cdcecd0c52`。

固定43应用现可将恢复后本origin的新片段输入保存为独立本地草稿，正常冷关闭及新进程重开后，在Inspector中明确选择恢复或丢弃。未完成的数值文本也可保留；恢复草稿不会自动修改时间线。业务Save成功并确认后清除本草稿，Cancel以带修订号的墓碑丢弃。源42的v3草稿仍从备份排除并留在源目录，既不读取也不隐式迁移。

## 最小接缝与兼容边界

没有数据库schema迁移或新渲染架构。后端仅为精确固定43应用store装配新协议，复用既有v3的行验证、CAS、原子文件写入、目录同步、结果不确定暂停及历史／来源检查。默认40／41、普通42和冻结构造器不变，未新增冻结例外、JS allowlist或类型豁免。

新端点为`/api/local-drafts/restored43/clip`和只读列表`/api/local-drafts/restored43`。每次调用要求版本1及精确`expectedWorkspaceOrigin`；响应要求固定profile与当前origin。文件`local-drafts-restored43-v1.json`绑定版本、profile、origin和原workspace scope，写入还绑定本次instance、项目、时间线、片段、来源及baseRevision。不同恢复分支或旧instance不能写入，错误或损坏文件不被重置为空。

新inspection声明`localClipDrafts`固定能力；旧43 inspection缺少此字段仍可读取并保持内存模式，字段存在但畸形则拒绝。前端只为严格通过的固定43能力建立私有标记客户端，并复核context origin。普通42客户端、复制对象、普通43句柄及URL标志不能打开此路径。旧草稿端点仍返回unsupported，源v3和目标中的旧v3文件不读、不升级、不覆盖。

存储预算保持每行8192 bytes、最多128槽、文件2 MiB和HTTP12 KiB。新调用仅增加两个身份字段，捕获预算134节点；普通42仍132节点，完整合法数组不会被裁剪。墓碑继续占槽并保留CAS修订。新文件是本地明文，不包含媒体或可执行任务；备份声明仍为`draftPolicy:'excluded'`，本片未开放43递归备份或偏好持久化。

## 关闭、恢复与结果不确定

自动保存确认只证明该份输入已完成当前文件及目录同步，不等于业务时间线已保存。重开先展示候选草稿，明确Restore后才进入表单；Discard或Cancel保持CAS，迟到ACK不能覆盖更新文本。旧held任务、executionEpoch、恢复证据和历史权限不变。

关闭排空捕获controller、origin及当前输入所有者，等待持久化后再次核对。组合输入、取消中、过期所有者、未知ACK或存储失败不能被当作可安全关闭。浏览器`beforeunload`阻挡尚未确认输入；`pagehide`的异步保存只属best effort。断网／超时／发布后失败保留输入并暂停覆盖，不盲目重试，不把新instance当作旧实例的成功ACK。

简中、无地区标签繁中、英文、日语均区分“源v3仍排除”与“当前新草稿可恢复”，并说明明文存储和未确认输入可能丢失。

## 验证与证据

[保留的独立进程脚本](evidence/opacity-restored-drafts/cold-process-qualification.mjs)在全新临时42上建立合成数据，实际冷备份为独立43，再用四个不同Node进程依次写入、冷重开显式恢复、丢弃、重开验证墓碑。四阶段均正常关闭和释放锁；scope／origin相同、instance更新，旧instance写入拒绝，源数据库／v3字节和目标全部业务／held／历史逻辑表hash相同。[四阶段记录](evidence/opacity-restored-drafts/cold-process-record.json)。没有监听、媒体进程、provider、外部fetch或用户项目。

最终**36个去重文件、429/429定向测试通过**，无失败、跳过或取消；[文件与范围](evidence/opacity-restored-drafts/aggregate-selection.json)、[汇总与日志](evidence/opacity-restored-drafts/aggregate-summary.json)。canonical typecheck、默认Web／development Desktop源码构建和独立候选构建均exit0。冻结64项中63项原hash及唯一既有`timeline-media.mjs`例外不变，manifest本身未改。独立Standards／Spec审查均0项发现，另行复跑24/24通过，与聚合重叠、不加总。

完整范围见[验证汇总](evidence/opacity-restored-drafts/qualification.json)。故障测试包含坏UTF8／JSON／重复解码键、版本与origin错配、跨恢复副本、文件权限／链接／inode替换、预算、PUT及丢弃的四个故障点、实际目录fsync失败和未知ACK后重开。合成IME事件与真实controller／关闭逻辑验证不等于OS输入法或GUI验收。只验证本机Node26.9.0；没有全库、Node24、安装包或跨平台结论。

首轮聚合误纳入旧`workspace-origin-transports.test.mjs`：其中CLI与MCP两项在监听`127.0.0.1`临时端口时被沙箱以`EPERM`拒绝，尚未启动服务或子进程，未发送信号。没有重试或提权；最终验证移除整个5项文件，不将其计为通过。另17项失败来自旧native生命周期夹具缺少实际controller方法，补齐夹具并保留全部原断言后，该组21项通过。首轮完整日志与最终范围均保留。

本片未调用GUI，不重试上轮断连窗口，也未盲目关闭。**新草稿实际GUI、真实中文／日文IME、原生窗口关闭重开仍未验证**；上轮工具断连、原窗口关闭及服务退出码不确定的记录保留于[语言与IME专项](OPACITY-LANGUAGE-IME-ACCEPTANCE.md)。本片没有待审批操作；上述监听测试状态为已拒绝且未重试，不阻碍无监听验证。没有真实媒体、系统设置、凭据、依赖、用户项目或push操作。
