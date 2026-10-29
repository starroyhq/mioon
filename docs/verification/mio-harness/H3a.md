# H3a · 宿主检查（后端）

2026-10-28 实施，2026-10-29 按授权同步 main 并准备提交／PR。H3a 已确认；显式完整预检审查见第 7 节，超时修复、main 同步与提交前验证见第 8 节；PR CI 后续修复见第 9 节。PR 要求 merge commit，代理不执行合并。

## 1. 基点与范围

从拉取后的 `origin/main` `2665fcfc850c8062d7fcebc7c770c5564c10f7ce`（merge commit 合入 H1c 的 PR #58）创建分支 `codex/mio-harness-h3a`。独立工作树：`/Users/kouzen/.codex/worktrees/mio-harness-h3a/mioon`，创建时干净。原工作树与主 checkout 的文件未修改。

| 分类 | 文件与行为 |
| --- | --- |
| 业务 | 新增 `task-checks-v2.ts`；runtime 仅新增只读 `checks()` 入口及预检回调，不改执行、发送或流式写入 |
| 契约 | 新增 `agent-task-checks-v2.ts` 并从现有 `agent-tasks-v2.ts` 导出；所有嵌套对象 strict |
| 传输 | `agent-task-http-v2.ts`、server `index.ts` 接入只读路由与既有预检生命周期；client、CLI 增加 checks |
| 测试 | 新增 `agent-task-checks-v2`、`agent-task-checks-transport-v2`、`agent-task-checks-integration-v2` 三个独立文件；新增测量辅助 `agent-task-checks-report.ts` |
| 文档 | 只追加 `AGENT-TASKS-V2.md`、`CLI.md` 中检查相关段落，本验证记录包含接口示例 |

初次实现冻结摘要（审查修改前）：`13fd42e1b1018bc9fd0e08412bf0ac71f9dbde183d2171ffea6752bfdc619535`，5992 个仓库输入文件；本验证记录不计入。完整清单与锁定依赖核对见证据目录 `snapshot.json`、`linux-dependency-ready.json`。

## 2. 与计划对照

- 四组：`export_render`、`generation`、`timeline`、`decomposition_frames`。每项含检查类型、稳定 ID、`source: host`、四态、可定位目标和安全名称、依据修订；按需包含原因码、安全参数、进度、期望和当前值。不适用的组保留明确的不适用项。
- 导出／渲染：当前终态、托管产物存在性、原参数／冻结记录与输出元数据一致性。时间线渲染核对不可变 `timeline_requests` queued ACK、请求摘要和完整 snapshot；分镜导出核对原步骤 ACK、幂等身份、版本顺序及来源图。
- 生成：分别检查终态、同项目版本发布、费用状态；已提交未确认费用仍等待，费用未知单列，Mock 不适用。读取当前本地记录，可从等待变为通过，不发起模型或供应商请求。
- 时间线：仅本轮有时间线 Change 时每次检查当前引用。默认完整预检项为 `pending / PREFLIGHT_NOT_REQUESTED`，只有 `GET checks?preflight=1` 才调用既有完整 `timeline.export.preflight`。client／CLI 输入为可选布尔值 `preflight`，`true` 映射到该查询，省略或 `false` 不请求完整预检。恢复副本使用既有来源身份和只读 invocation／fence，不开放写入权限。
- 拆解与关键帧：读取本轮来源绑定及当前本地终态，支持取消／中断等机器原因码。
- 接口独立于快照／SSE／执行循环。客户端断开取消本次预检；服务关闭由原 services 生命周期取消、等待并回收本地进程。检查不计步骤、不落库、不改变状态或授予权限。
- 所有返回值为结构化数据，无模型或界面成句文案；未实施 H3b、H4a 或其他阶段。没有有意偏离本阶段计划。

审查时补齐了 128 条合法预检问题的契约容量、原 queued ACK 一致性，以及 HTTP 断开取消链。对应回归保留生产写入触发器，读侧损坏证据通过临时 VIEW 注入，不放宽原存储保护。

## 3. 初次实现验证（审查修改前）

证据目录：`/Users/kouzen/Library/Caches/mioon-harness-H3a-2026-10-28/`。

环境：原生 Node 24.21.0、pnpm 11.25.0、UTC、`TMPDIR=/private/tmp`；长时间命令使用专用 `caffeinate -i`。在本工作树 `CI=true ... pnpm install --frozen-lockfile` 成功（6.1 秒），未清理主 checkout 依赖；只跳过 Electron binary 下载，不代表原生打包／发布验收。锁 SHA-256：`429c516aa89649ac5acb2e4313c7087060bf3acbe1f6b9b749685eadde497e5b`。

Linux 使用 H0 的完整 FFmpeg 镜像 `sha256:32fc444b18573b988300b1bb9ceb7009ae4d9cb2456c382a0353b0c521846de5`，Node 24.21.0、非 root 1000:1000、测试断网。独立 APFS clone 与现锁／12 manifests 一致的已安装 Linux 依赖；不是重新安装记录。每文件独立进程／容器，有界超时；本机按并行安排不跑全量，后续 PR 的完整 CI 仍待执行。

初步验证：领域 15/15（9.351 秒）、传输 6/6（6.282 秒）、实际时间线普通／恢复集成 2/2（4.481 秒）。最终冻结源码的统一结果见下表。

初始失败均保留：模块开发中未导出子路径、fixture 未标记派发／无效参数、类型推断的 Buffer 泛型、server 恢复上下文空值收窄；均修正具体实现或 fixture，未降低断言／类型要求。首次 nullable 检查与 Buffer 构建失败日志分别为 `typecheck-initial.log`、`native-build-initial.log/json`。领域、传输和测量的初始 TAP／stderr 亦保留，不能把这些尝试写成通过。

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| `node scripts/tooling.ts build --channel=development` | exit 0，299.271 秒；内置三个严格类型项目、Web 与 Desktop 开发构建通过 | `native-build.json`、`native-build.log` |
| 请求指纹 | 99 条全部匹配，12 条诊断不变；fixture 未更新 | `candidate-focus-agent-task-request-fingerprints-v2.test.ts.tap` |
| Linux 新增检查回归 | 3 文件、23/23，0 失败／取消／跳过 | `candidate-focus-agent-task-checks*.test.ts.tap` |
| Linux 全部聚焦回归 | 39/39 文件、854/854 测试；0 失败／取消／跳过／超时，exit 0，872.21 秒 | `candidate-focus-results.json`、`validation-summary.json` |

聚焦选择集是原 34 个 harness 文件，加 client／CLI 两个文件和 H3a 三个新文件；没有运行仓库全量。每个文件实际执行 `node --test --test-reporter=tap <单文件>`，容器内原 600 秒／外层 630 秒限制不变，驱动持有专用 `caffeinate -i`；完整命令保存在逐文件结果中。实际驱动命令：

```sh
TMPDIR=/private/tmp python3 -u /Users/kouzen/Library/Caches/mioon-harness-H3a-2026-10-28/focus-suite.py
```

按 `文件 + 完整层级 TAP 路径 + 同名出现序号` 精确比较，不模糊匹配或只比文件数：

| 基线范围 | 原测试数 | 匹配 | 新增／缺失／状态变化 |
| --- | ---: | ---: | --- |
| H1c 最后 C8c 同步后的 34 个 harness 文件 | 796 | 796 | 0／0／0 |
| H1c full 有效记录中的 client／CLI | 35 | 35 | 0／0／0 |
| H0 原始 client／CLI TAP（交叉核对，不重复计数） | 35 | 35 | 0／0／0 |
| H3a 新增三个文件 | — | 23/23 通过 | 新增 23 条 |

`agent-task-runtime-v2.test.ts` 185/185，400.57 秒；两个完整 FFmpeg 用例都通过：

- `whole undo retains the generated shot owner while reverting earlier edits and preserving products across restart and replay`
- `retained shot keeps a late product without selecting it and never dispatches after reversion`

99 条请求指纹包括 12 条诊断，全部与 HEAD 原件一致，fixture SHA-256：`01492d0daa0cdc653108036d5f9dbc2029e64b452cd3fdbf4fbd0ecbfe78fac5`。没有执行 `--update`。reviewed-live-sources 的所有现有 pin 逐一核对不变，无需更新。

验证结束后再次核对 5992 个冻结文件：工作树和隔离副本均无差异；只允许本报告继续写入。驱动、wrapper、专用 caffeinate 已退出，专用 label 无残留容器。期间观察到宿主高负载，见 `host-load-observation.json/txt`；没有调整原时限、停止其他工作或重跑已通过套件。

完整证据：`name-comparison.json`、`validation-summary.json`、`candidate-focus-results.json`、`focus-suite-command-result.json`、`scope-audit.json`。这份聚焦通过记录不等于全量 CI 通过。

## 4. 初次实现的完整预检耗时与读写量

实际命令：

```sh
PATH=/Users/kouzen/.npm/_npx/538786c08bcb9442/node_modules/node/bin:$PATH \
TMPDIR=/private/tmp TZ=UTC caffeinate -i node tests/helpers/agent-task-checks-report.ts
```

合成 PNG 每个 128×128、49,363 B，分别 1／10／100 个独立素材和片段，真正经 `services.call('timeline.export.preflight')` 哈希和本地探测；每组 3 次。

| 素材／片段 | 源字节 | 中位耗时 ms | 最大耗时 ms | 结果 |
| ---: | ---: | ---: | ---: | --- |
| 1 | 49,363 | 46.17 | 52.64 | 3/3 ready，数据库写入数不变 |
| 10 | 493,630 | 388.59 | 405.68 | 3/3 ready，数据库写入数不变 |
| 100 | 4,936,300 | 4,953.96 | 5,316.98 | 3/3 ready，数据库写入数不变 |

100 个小素材已约 5 秒；审查后进一步改为必须显式带 `preflight=1` 才计算，默认 checks 不运行完整预检，也不放入常规快照。这是本机小合成数据的时间，不是大媒体性能上限。服务原有有界预算、繁忙／不完整／过期语义保留，不把这些情况当作通过。

普通与真实备份恢复后的 HTTP 集成读取，前后全表与结构 dump 相同；各测量的 `total_changes()` 不增加。checks 本身新增持久字节 0、行 0、模型请求 0、token 0。H3a 不改变执行容量、流式事件频率或配额；未重复宣称新的长执行容量测量。产物存在性只验证来源、受管普通文件与记录尺寸；参数比较使用已保存元数据，不对成品重新全量哈希、ffprobe 或解码。

详见 `checks-report-second.json`、`preflight-measurements.json`。首轮合成素材 `duration:null` 被既有渲染契约拒绝的证据未覆盖。

## 5. 兼容性与剩余事项

- 新增只读 HTTP／client／CLI 能力，原快照没有新增字段，旧严格快照客户端仍可读取；新 checks 客户端须连接支持本接口的后端。审查后默认只算轻量检查，需要完整预检的调用方显式传 `preflight:true`，并使用包含新原因码的契约。
- 旧执行记录不迁移、不改写。持久来源绑定优先，旧 ACK 仅在当前同项目记录仍绑定原请求时回退；无法证明的引用返回不可用，不猜测通过。未发送 intent 与冻结模型请求不重新装配。
- 恢复副本可读，不能借 checks 继续、生成或修改。没有工作区 schema、表、持久字段、备份恢复规则或依赖变化。
- 请求指纹 fixture 与 reviewed-live-sources pin 无改动；没有新增 RPC operation schema，工具 schema 无需生成。原工具目录不增加 checks，RPC／MCP 无新增工具。
- 进度只使用可读取的本地记录字段。视频进度已覆盖 62%；scene worker 的私有内存进度不额外接入，不虚构百分比。
- 初次实施与审查阶段未提交、推送或创建 PR；用户确认后的最新提交／PR 授权与同步验证见第 8 节。全量由 PR CI 执行。H3b 可按该结构生成四语界面文案；目标条件和一次补做留到 H4a。

## 6. 实际接口返回示例

以下为审查修复后的测量辅助实际调用 `readAgentTaskChecks(...,{includePreflight:true})` 得到的完整 HTTP `data` 字段（HTTP 外层为 `{ok:true,data:...}`）。对应显式请求 `GET .../checks?preflight=1`；client／CLI 使用 `preflight:true`。同一合成 Run 同时有导出、生成和时间线变化：导出三项通过、生成等待 62%、时间线引用和完整预检通过；拆解／关键帧不适用。示例中的 MP4 是存在性检查用的合成文件，不是完成解码验收的成片。

```json
{
  "projectId": "7795bd19-bb3f-4ef6-8508-9f1115cb0ea1",
  "runId": "d65f3ce9-31bc-4439-90c7-bbd90da09795",
  "runRevision": 9,
  "groups": [
    {
      "id": "export_render",
      "items": [
        {
          "id": "export_status:export:16088e02-a508-4692-b009-4650a255efb3",
          "type": "export_status",
          "source": "host",
          "status": "passed",
          "target": {
            "kind": "export",
            "id": "16088e02-a508-4692-b009-4650a255efb3"
          },
          "basis": [
            {
              "kind": "export",
              "id": "16088e02-a508-4692-b009-4650a255efb3",
              "revision": 2
            }
          ],
          "current": {
            "status": "succeeded"
          }
        },
        {
          "id": "export_artifact:export:16088e02-a508-4692-b009-4650a255efb3",
          "type": "export_artifact",
          "source": "host",
          "status": "passed",
          "target": {
            "kind": "export",
            "id": "16088e02-a508-4692-b009-4650a255efb3"
          },
          "basis": [
            {
              "kind": "export",
              "id": "16088e02-a508-4692-b009-4650a255efb3",
              "revision": 2
            },
            {
              "kind": "asset",
              "id": "26e2f416-80e0-498d-bdbe-b597e689ebf6",
              "revision": 1
            }
          ],
          "current": {
            "assetId": "26e2f416-80e0-498d-bdbe-b597e689ebf6",
            "available": true
          }
        },
        {
          "id": "export_parameters:export:16088e02-a508-4692-b009-4650a255efb3",
          "type": "export_parameters",
          "source": "host",
          "status": "passed",
          "target": {
            "kind": "export",
            "id": "16088e02-a508-4692-b009-4650a255efb3"
          },
          "basis": [
            {
              "kind": "export",
              "id": "16088e02-a508-4692-b009-4650a255efb3",
              "revision": 2
            },
            {
              "kind": "asset",
              "id": "26e2f416-80e0-498d-bdbe-b597e689ebf6",
              "revision": 1
            }
          ],
          "expected": {
            "width": 1080,
            "height": 1920,
            "fps": 30,
            "durationFrames": 30
          },
          "current": {
            "width": 1080,
            "height": 1920
          }
        }
      ]
    },
    {
      "id": "generation",
      "items": [
        {
          "id": "generation_status:job:71a5d7ad-a71c-41af-bf14-9096b72fb4ad",
          "type": "generation_status",
          "source": "host",
          "status": "pending",
          "target": {
            "kind": "job",
            "id": "71a5d7ad-a71c-41af-bf14-9096b72fb4ad",
            "name": "Synthetic generation shot"
          },
          "basis": [
            {
              "kind": "job",
              "id": "71a5d7ad-a71c-41af-bf14-9096b72fb4ad",
              "revision": 1
            }
          ],
          "reason": {
            "code": "TASK_PENDING"
          },
          "progress": 62,
          "current": {
            "status": "running"
          }
        },
        {
          "id": "generation_publication:job:71a5d7ad-a71c-41af-bf14-9096b72fb4ad",
          "type": "generation_publication",
          "source": "host",
          "status": "pending",
          "target": {
            "kind": "job",
            "id": "71a5d7ad-a71c-41af-bf14-9096b72fb4ad",
            "name": "Synthetic generation shot"
          },
          "basis": [
            {
              "kind": "job",
              "id": "71a5d7ad-a71c-41af-bf14-9096b72fb4ad",
              "revision": 1
            }
          ],
          "reason": {
            "code": "TASK_PENDING"
          },
          "current": {
            "available": false
          }
        },
        {
          "id": "generation_cost:job:71a5d7ad-a71c-41af-bf14-9096b72fb4ad",
          "type": "generation_cost",
          "source": "host",
          "status": "not_applicable",
          "target": {
            "kind": "job",
            "id": "71a5d7ad-a71c-41af-bf14-9096b72fb4ad",
            "name": "Synthetic generation shot"
          },
          "basis": [
            {
              "kind": "job",
              "id": "71a5d7ad-a71c-41af-bf14-9096b72fb4ad",
              "revision": 1
            }
          ],
          "current": {
            "cost": "not_applicable"
          }
        }
      ]
    },
    {
      "id": "timeline",
      "items": [
        {
          "id": "timeline_references:timeline:a877c29a-bf4e-4d34-a33e-4959e88cebc0",
          "type": "timeline_references",
          "source": "host",
          "status": "passed",
          "target": {
            "kind": "timeline",
            "id": "a877c29a-bf4e-4d34-a33e-4959e88cebc0"
          },
          "basis": [
            {
              "kind": "timeline",
              "id": "a877c29a-bf4e-4d34-a33e-4959e88cebc0",
              "revision": 2
            },
            {
              "kind": "asset",
              "id": "d0dee255-0636-478c-ae53-5e58bcefbeb4",
              "revision": 1
            }
          ],
          "current": {
            "missingCount": 0,
            "referenceCount": 1
          }
        },
        {
          "id": "timeline_preflight:timeline:a877c29a-bf4e-4d34-a33e-4959e88cebc0",
          "type": "timeline_preflight",
          "source": "host",
          "status": "passed",
          "target": {
            "kind": "timeline",
            "id": "a877c29a-bf4e-4d34-a33e-4959e88cebc0"
          },
          "basis": [
            {
              "kind": "timeline",
              "id": "a877c29a-bf4e-4d34-a33e-4959e88cebc0",
              "revision": 2
            },
            {
              "kind": "asset",
              "id": "d0dee255-0636-478c-ae53-5e58bcefbeb4",
              "revision": 1
            }
          ],
          "current": {
            "width": 1080,
            "height": 1920,
            "fps": 30,
            "durationFrames": 30,
            "blockingCount": 0,
            "issueCodes": []
          }
        }
      ]
    },
    {
      "id": "decomposition_frames",
      "items": [
        {
          "id": "decomposition_status:run:d65f3ce9-31bc-4439-90c7-bbd90da09795",
          "type": "decomposition_status",
          "source": "host",
          "status": "not_applicable",
          "target": {
            "kind": "run",
            "id": "d65f3ce9-31bc-4439-90c7-bbd90da09795"
          },
          "basis": [
            {
              "kind": "run",
              "id": "d65f3ce9-31bc-4439-90c7-bbd90da09795",
              "revision": 9
            }
          ],
          "reason": {
            "code": "NO_APPLICABLE_TASK"
          }
        }
      ]
    }
  ]
}
```

## 7. 审查修复：显式完整预检（已确认的历史证据）

按 2026-10-28 审查要求，仅调整检查接口设计；其余已确认实现保留，没有提交或推送。

- `GET /api/agent/tasks/v2/:projectId/:runId/checks` 默认不调用完整预检，即使宿主已经注入预检回调。若本轮改过时间线，`timeline_preflight` 为 `pending`，原因码 `PREFLIGHT_NOT_REQUESTED`；时间线引用每次仍重新计算，人工变更能反映在新结果中。
- 唯一开启方式为可选查询 `preflight=1`；`0`、`true`、空值、重复参数或未知参数均拒绝。带参数时保留原完整预检、过期／繁忙处理、取消和恢复副本只读行为。不复用上次完整预检结果。
- 新增共享 strict 输入契约 `agentTaskChecksInputSchema`：`{projectId,runId,preflight?:boolean}`。client `checks({projectId,runId,preflight:true})` 和 CLI JSON 输入 `preflight:true` 发送 `?preflight=1`；`false` 或省略不带查询。实际 `agent task checks --help`、离线 schema、CLI 文档均同步。
- 本次触及原 H3a 范围内的业务／runtime 只读入口、契约、HTTP、client、CLI、三个检查测试、测量辅助和文档；未改执行循环、流式写入、请求装配、指纹 fixture、依赖或存储格式。

审查前的完整证据保留在原目录；新证据独立位于 `review-preflight-opt-in/`。本次新冻结摘要为 `69c9694665fae170dfdb68937b4dfed45480fe9acd68d7a7fe8bbafc22051b6c`，5992 个仓库输入文件，本报告排除。本次聚焦为原 831 个既有测试加 25 个 H3a 测试，按完整测试名与前次 854 条及 H1c 基线对比。

| 本次审查复验 | 实际结果 | 新证据子目录中的文件 |
| --- | --- | --- |
| 开发构建（内置严格类型检查、Web、Desktop） | exit 0，252.763 秒 | `native-build.json/log` |
| 原生检查回归 | 领域 16/16、传输 7/7、普通／恢复集成 2/2，合计 25/25 | `domain-tests.tap`、`transport-native.tap`、`integration-native.tap` |
| Linux 检查回归 | 25/25；原先 23 条完整保留，仅新增 2 条 | `candidate-focus-agent-task-checks*.test.ts.tap` |
| 请求指纹 | 99 条全匹配，12 条诊断不变；fixture 未更新 | `candidate-focus-agent-task-request-fingerprints-v2.test.ts.tap` |
| Linux 全组聚焦与逐名对比 | 39/39 文件、856/856 测试通过；0 失败／取消／跳过／超时，exit 0，836.413 秒 | `validation-summary.json`、`candidate-focus-results.json`、`name-comparison.json` |

沿用原固定 Linux 镜像、Node 24.21.0、UTC、非 root、network none；每文件独立进程／容器，专用 `caffeinate -i`，原 600／630 秒限制不变。新驱动实际命令为 `TMPDIR=/private/tmp python3 -u /Users/kouzen/Library/Caches/mioon-harness-H3a-2026-10-28/review-preflight-opt-in/focus-suite.py`；逐文件完整命令在结果文件中。

按文件、完整层级测试名和重复序号比对：原 H3a **854 条全匹配**，0 缺失、0 改名、0 状态变化；其中原 831 条既有回归与原 23 条检查回归均保留。仅新增：

- `checks discovery shares a strict optional boolean preflight input`
- `default and false checks skip a supplied preflight callback while references keep refreshing`

与 H1c 的原 796 条 harness 也全部匹配，无新增／缺失／状态变化。runtime 185/185，406.790 秒，含第 3 节列出的两个完整 FFmpeg 用例。99 条指纹含 12 条诊断全部不变；fixture 与 HEAD 逐字节相同，SHA-256 仍为 `01492d0daa0cdc653108036d5f9dbc2029e64b452cd3fdbf4fbd0ecbfe78fac5`，未运行 `--update`。所有现有 reviewed-live-sources pin 不变。

验证后，隔离快照与工作树的 5992 个冻结输入均无差异（仅排除本报告）；专用 wrapper、驱动、caffeinate 及所有专用容器均退出。`scope-audit.json` 确认总分支仍为原 15 个授权文件，本次审查仅在其中 12 个文件及本报告内调整，没有暂存或新增范围。原验证证据、初始失败日志和本次新证据分别保留，没有覆盖或重复已通过套件。

本次严格类型检查由成功的完整 development build 再次执行；没有把初次实现时独立 typecheck 的失败记录改写成通过。

测量命令与第 4 节相同，使用最新冻结的辅助；每组分别读默认与显式完整 3 次。下表是业务入口耗时，不包含 HTTP 传输。

| 素材／片段 | 默认读取中位 ms | 默认预检调用 | 显式完整读取中位 ms | 完整预检调用 |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 2.430 | 0 | 47.746 | 3 |
| 10 | 2.346 | 0 | 564.261 | 3 |
| 100 | 10.565 | 0 | 6,972.151 | 3 |

两种读取的数据库写入均为 0；9 次显式完整预检全为 `ready`，默认读取每次均返回 `PREFLIGHT_NOT_REQUESTED` 且引用检查通过。对应 `checks-report-final.json`、`preflight-measurements.json`、`combined-example.json`；样本少且为合成媒体，用于验证调用边界与量级，不代表大媒体性能上限。

本节审查修复时仅完成 H3a，未提交或推送。本机全量测试按并行约定不运行；用户确认后的提交／PR 授权与最新验证见第 8 节，不进入下一阶段。

## 8. 用户确认后的超时修复、main 同步与 PR 前验证

用户确认 H3a，并授权补齐 client 完整预检超时、同步 `origin/main`、提交、推送并创建面向 main 的 PR；合并方式为 merge commit，代理不合并。全量测试交 PR CI。

### 超时修复

服务端完整预检最多 30 秒，原 client 默认也为 30 秒，存在预检耗尽预算时客户端先取消的竞争。`checks` 在 `preflight:true` 时改为至少 60 秒的默认请求超时；显式 `options.timeoutMs` 优先，更长的全局 `requestTimeoutMs` 保留。默认与 `preflight:false` 仍沿用普通超时。同步更新了相关 CLI／执行文档。

新增用例 `full checks default to at least sixty seconds while explicit and longer client timeouts remain authoritative` 使用 `mock.method(AbortSignal,'timeout')` 捕获实际 fetch 信号及真实传入的期限；覆盖默认／false 的 30 秒、完整预检的 60 秒、显式 25／90 秒、较长全局 120 秒和较短全局 12 秒三种输入，没有真实等待 30／60 秒。同步前原生 transport **8/8 通过**（6.686 秒），旧断开取消回归保持；证据 `transport-preflight-timeout-native.tap`。

### main 同步与内容核对

2026-10-29 fetch 后，从 `2665fcfc850c8062d7fcebc7c770c5564c10f7ce` 快进至 `d373a1058da09701c7a4782f8886c771f3711550`，包含 PR #59 产品定位文案与 PR #60 H2 流式合并写入。同步前将 15 个本分支授权文件逐一备份并保留自有 stash，再 fast-forward 和 apply；没有操作主 checkout 或其他工作树。

`docs/AGENT-TASKS-V2.md` 和 runtime 自动合并成功，没有冲突。同步前后，H3a 15 文件中 **13 个逐字节相同**；另外两个只增加 main 内容：文档保留完整 H3a 段落及 H2 的 8 KiB／250 ms 流式说明，runtime 的整个流式片段与 main 逐字节相同。相对 main，runtime 仍仅新增 H3a 导入、可选检查回调与只读 `checks()`。H3a 独立 helper 未变，H2 的 `agent-task-context-report.ts` 与 main 完全相同。

根 `package.json` 仅 `description` 变化，其余字段、其他 11 份 workspace manifests、workspace 配置和锁文件保持。原生 `CI=true pnpm install --frozen-lockfile` 实际 exit 0、Already up to date（Node 24.21.0／pnpm 11.25.0）；Linux 依赖从前次成功安装独立 APFS clone，并按依赖字段、实际虚拟 store 锁核对。复用不冒充新的 Linux install。锁 SHA-256 仍为 `429c516aa89649ac5acb2e4313c7087060bf3acbe1f6b9b749685eadde497e5b`。

新证据独立保存在 `/Users/kouzen/Library/Caches/mioon-harness-H3a-2026-10-28/sync-main-for-pr/`：`pre-sync.json`、`pre-sync.patch`、`pre-sync-files/`、`stash-apply.txt`、`sync-result.json`、`dependency-decision.json`、`native-install.log`。同步后源码冻结摘要为 `d1221faac88f4575987d4c442090b81ab5e1c203e929136c9676253bedf98aef`，5995 个仓库输入文件；本报告排除。

### 同步后验证

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| `node scripts/tooling.ts build --channel=development` | exit 0，147.684 秒；内置三个严格类型项目、Web／Desktop development 构建通过 | `native-build.json/log` |
| 指纹 | 99 条全部匹配，含 12 条诊断；fixture 与 HEAD 原件相同 | `candidate-focus-agent-task-request-fingerprints-v2.test.ts.tap` |
| Linux 完整聚焦 | 42/42 文件、895/895 通过；0 失败／取消／跳过／超时，exit 0，759.994 秒 | `validation-summary.json`、`candidate-focus-results.json` |

固定 H0 完整 FFmpeg 镜像、Node 24.21.0、UTC、非 root、network none；原逐文件进程／容器、600／630 秒限制、并发 2 和专用 `caffeinate -i` 方法保持。实际驱动命令为 `TMPDIR=/private/tmp python3 -u /Users/kouzen/Library/Caches/mioon-harness-H3a-2026-10-28/sync-main-for-pr/focus-suite.py`；完整逐文件命令保存在结果中。

| 同步后重点回归 | 结果 |
| --- | ---: |
| `agent-anthropic-task-recovery.test.ts` | 15/15 |
| `agent-task-context-report.test.ts` | 4/4 |
| `agent-task-streaming-v2.test.ts` | 18/18 |
| `agent-task-streaming-report-v2.test.ts` | 5/5 |
| `agent-task-runtime-v2.test.ts` | 185/185，245.819 秒，含两个指定完整 FFmpeg 用例 |
| H3a 三个检查文件 | 26/26（领域 16、传输 8、集成 2） |

按文件、完整层级 TAP 路径和同名出现序号精确比较，原 H3a **856 条全部匹配**，0 缺失／改名／状态变化；原 39 文件范围内只新增超时用例 1 条。新 main 的 H2 **37 文件、834 条全部逐名匹配**，0 缺失／状态变化。全 42 文件相对旧 H3a 增加 39 条，分别是补入 Anthropic 恢复 15 条、H2 两个流式文件 23 条、client 超时新用例 1 条；不把不同基线的重叠用例重复累加。证据为 `name-comparison.json`。

99 条请求指纹（含 12 条诊断）的 fixture SHA-256 仍为 `01492d0daa0cdc653108036d5f9dbc2029e64b452cd3fdbf4fbd0ecbfe78fac5`，逐字节等于 main／HEAD 原件；没有运行 `--update`。现有 reviewed-live-sources pin 与公共操作 schema 未变。没有重采未受影响的 H2 容量报告，本次已明确重跑其测量辅助回归；第 7 节的 H3a 业务入口性能证据保留，client 超时不改变该业务测量。

验证结束后，5995 个冻结输入在工作树和快照中均无漂移（本报告除外）；专用 wrapper、驱动、caffeinate 及容器均退出。第一次发送的启动指令在会话中断后没有恢复驱动；核实未运行后才重新启动正式验证，没有把未启动项记为通过，没有重复累计。启动核对见 `prelaunch-check.json`、`focus-wrapper-start.json`，退出状态见 `focus-suite-command-result.json` 与 `validation-summary.json`。

提交前再次 fetch，`origin/main` 仍为上述 `d373a105…`，与本次已验证基点一致。最新结果与历史证据分别保存，未跑本机全量；全量测试由新 PR 的 CI 执行。

最终提交范围仍为 H3a 原 15 文件，不纳入 main 已有的产品文案／H2 变化；不修改流式实现、请求装配、存储格式、依赖、指纹 fixture 或现有字节 pin。合并仅使用 merge commit，代理不合并。全量验证由本次 PR 的 CI 提供。

## 9. PR #66 CI 修复：UTF-8 输出采集清单漏登记

首次 PR head `f20db24faae933fd8923c5ff8b7945cf41f09467` 的 CI 中，Linux shard 6 在 `tests/transport-utf8-output.test.ts` 的 `every inventoried test/QA text collector configures continuous decoding at its actual listener, before delivery` 失败，报 `tests/agent-task-checks-transport-v2.test.ts: classify each newly introduced stream consumer`。该分片 1714/1715 通过、1 失败；其余 7 个 Linux 分片与 Linux／macOS／Windows source checks 成功。CI run `40727699692`、job `122956062967`，详细链接：<https://github.com/starroyhq/mioon/actions/runs/40727699692/job/122956062967>。

新增 CLI helper 的 stdout JSON 与 stderr 诊断均已使用 `setEncoding('utf8').on('data',...)`，但本阶段漏同步了全库流读取 inventory；原 42 文件聚焦范围也未包含这个审计门禁。修复仅在 `textSites` 增加 `'tests/agent-task-checks-transport-v2.test.ts': 2` 及对应注释，并补录本节。未把新 helper 排除出扫描，也未改动或放宽审计断言。

该 guard 会先转译已登记的严格 TypeScript 源码，核对恰好 2 个实际读取注册点，再执行这两个真实注册表达式，使用中文和 emoji 逐字节投递验证连续解码。现有机制直接覆盖新增 helper，未另造只复述实现的重复用例。

新证据独立保存在 `/Users/kouzen/Library/Caches/mioon-harness-H3a-2026-10-28/ci-utf8-inventory/`：

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| 原生修复前 `transport-utf8-output.test.ts` | 3/4 通过，原样复现 CI 相同的漏登记错误 | `before.tap`、`ci-failure.json` |
| 原生修复后 `transport-utf8-output.test.ts` | 4/4，通过，0 失败／取消／跳过 | `after.tap` |
| 原生 `agent-task-checks-transport-v2.test.ts` | 8/8，通过，0 失败／取消／跳过 | `checks-transport.tap` |
| 固定 Linux 环境两文件复验 | 2/2 文件、12/12 通过（guard 4 + transport 8），22.952 秒；0 失败／取消／跳过／超时 | `linux-validation-summary.json`、`linux-results.json` |

原生均为 Node 24.21.0、UTC、`TMPDIR=/private/tmp`，每文件独立 `node --test --test-reporter=tap --test-timeout=120000 <file>`，使用本次专用 `caffeinate -i`。本轮没有重跑已通过的 42 文件或本机全量；42 文件历史验收仍见第 8 节。本次审计遗漏提示后续涉及新增子进程文本采集时，应把该全库 UTF-8 guard 纳入对应聚焦集合。

Linux 沿用固定完整 FFmpeg 镜像、Node 24.21.0、UTC、逐文件独立进程／有界超时和本次专用 `caffeinate -i`。新隔离快照 SHA-256 为 `15b4c7b4d1a8fccf8704ccf9f5a811280f24334eda205474323e6e4341facfb7`，5995 个输入文件，排除本报告；相对上次已验证的 PR 源码，仅 UTF-8 审计文件变化。未覆盖旧快照或证据，依赖锁及 99 条请求指纹 fixture 哈希保持。

修复前后 guard 的 4 个测试名均保留，失败的 inventory 用例现已通过；transport 的 8 个测试名／状态与上次 Linux 验证完全相同。运行后源码与快照无漂移，专用驱动、caffeinate 和容器均退出。本次只追加该最小修复提交至原 PR #66；全量由修复后的 PR CI 重新执行，代理仍不合并 PR。
