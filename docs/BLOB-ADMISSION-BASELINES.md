# 历史BLOB回执：精确基线归因与冻结边界

日期：2026-10-16。后续于d52f50f发布检查；全部工作在自有临时Git worktree中完成，主工作树仍为`d52f50fc83b5cad99512853cb041e9eb4d977638`，`designs/`未触碰，未push。

## 已确认的结果

原6项不是本批透明度改动新引入的失败。用同一已安装Node24.21.0执行每个精确快照的原生测试文件，只选这6项，四个快照均0/6、真实exit1、0跳过／取消。所有24个错误都先到`workspace-volume-envelope-validation.ts:178`的非TEXT拒绝，尚未执行旧原生文件中的ordinary34 catalog期望，不能把旧34断言混算成这6项。

| 精确快照 | 6项结果 | 证据 |
| --- | --- | --- |
| a7父：`c2000a1118c57585cc94a42f53ff6febf86bbec9` | 0通过／6失败 | [原生TAP](evidence/blob-admission-baselines/pre-a7-native.tap) |
| `a7fcf74199ed7ca54c5be408e6c67cd33b19b645` | 0通过／6失败 | [原生TAP](evidence/blob-admission-baselines/a7-native.tap) |
| `ff85c9a8daaa35bff080d0979fe2faa3683cd3b5` | 0通过／6失败 | [原生TAP](evidence/blob-admission-baselines/ff85-native.tap) |
| `d52f50fc83b5cad99512853cb041e9eb4d977638` | 0通过／6失败 | [原生TAP](evidence/blob-admission-baselines/current-native.tap) |

这证明失败最迟在所测a7父快照中已经存在，**未定位最初引入提交**；没有运行这些快照的全库测试。[完整命令、原生测试文件SHA与实际导入源码SHA](evidence/blob-admission-baselines/native-results.json)

6个当前准确名称如下；旧快照普通24名称仍写28/30/32/34，失败发生在该期望之前：

- `frozen ordinary24-seeded reopens with only the reviewed28 through40 schema delta, preserving raw rows, receipts and sequence`
- `independent frozen restored25-seeded opens and validates without ordinary bootstrap or evidence rewrites`
- `frozen ordinary24-mock-seeded reopens with only the reviewed28 through40 schema delta, preserving raw rows, receipts and sequence`
- `independent frozen restored25-mock-seeded opens and validates without ordinary bootstrap or evidence rewrites`
- `ordinary runtime retains baseline repair eligibility for known-marker-gap; offline classification stays strict`
- `ordinary runtime retains baseline repair eligibility for initial-markers-absent; offline classification stays strict`

## 格式与a7修复的区别

独立0343 golden的`timeline_requests` rowid88.response为BLOB `00FF0D0A`；恢复25还包含与原类型／字节绑定的capture rowHash。它是历史opaque存储／捕获证据，不能简单称为非法BLOB。固定24／25构造与验证、golden／manifest及[历史恢复契约](WORKSPACE-RESTORE.md)要求保留TEXT/BLOB；有效25的[启动门](WORKSPACE-RESTORE.md)还承诺跳过普通bootstrap。该证据不等于任意合成回执可以在现代业务服务中执行。

当前volume扫描选择所有非TEXT单元，在旧24／25未授权volume能力的分支抛`RESTORE_SCHEMA_UNSUPPORTED`。特别是两个有效restored25／Mock冷重开失败，涉及已有历史启动兼容承诺；不能用替换数据让正例通过后宣称兼容已恢复。另四项旧24／marker repair可用现代TEXT另测当前40资格，但原BLOB迁移／修复缺口仍须保留。这里没有将原6项改成跳过、删除、纯拒绝预期或仅过期fixture。

`a7fcf741`修改的是另一份`workspace-restore-schema.test.mjs`的普通current40动态seed：正例在初次INSERT时使用合法TEXT JSON，原BLOB seed保留为`WORKSPACE_VOLUME_ENVELOPE_INVALID`的拒绝负例。精确控制实验中，a7父原该正例0/1；a7、ff85和d52各自TEXT正例＋BLOB拒绝负例2/2通过。该修复没有改独立golden或本次旧24／25入口。[独立控制命令与结果](evidence/blob-admission-baselines/a7-controls-results.json)

## 本轮只增加独立定位回归

[新增边界测试](../tests/workspace-blob-admission-boundary.test.mjs)在Node24.21.0下12/12通过：6项合法TEXT初始输入、普通迁移／marker修复及固定25捕获后的冷重开；6项原golden BLOB历史合法性、当前拒绝及源数据不变。[结果](evidence/blob-admission-baselines/boundary-tests.json)／[完整TAP](evidence/blob-admission-baselines/boundary-tests.tap)

原6项、golden／manifest及生产validator、dispatcher、历史构造器、类型与legacy allowlist全不改。TEXT只在首次INSERT前构造，明确JSON.parse、TEXT类型、原hex、空白、Unicode转义与2.00词法断言；不CAST、不用Buffer.toString伪装JSON、不UPDATE已捕获回执、不重写原hold。

TEXT恢复25控制先插入普通源再调用固定25捕获；当前openStore前的snapshot仅是冷重开字节保留oracle，不冒充新的独立constructor golden。BLOB负例先证明固定25历史校验合法，再要求当前拒绝与SQLite完整typed snapshot／源文件字节／目录不变；拒绝后的SQLite观察在字节副本中进行，避免只读观察自身创建WAL／SHM。

物理文件字节及目录不变结论限这些初始建库即WAL的夹具，不泛化为DELETE-mode头部不会变化。原6个BLOB正向兼容失败仍保留；新的拒绝控制只描述现状，不撤销历史兼容承诺，也不是业务回执执行验收。

最终组合最小回归共18项：12通过、原6失败、0跳过／取消、真实exit1。[组合TAP](evidence/blob-admission-baselines/combined-current.tap)／[总结果](evidence/blob-admission-baselines/qualification.json)。不同快照或重叠控制数量不相加。

Node24 canonical foundation/browser严格类型与source-language guard在隔离current树exit0。第一次检查正确拒绝指向主树的TypeScript symlink；随后仅复制现有精确pin TypeScript6.0.3的140个相同SHA文件到隔离node_modules，原guard未改，没有包管理器或联网安装。[来源与字节核对](evidence/blob-admission-baselines/compiler-copy.json)／[类型输出](evidence/blob-admission-baselines/current-node24-typecheck.txt)

## 隔离与证据界限

四树均从现有Git对象创建，没有fetch；各原生测试blob与其commit一致。四个package／lock SHA相同。只复用本机第三方依赖，各树的@mioon别名指向自身；loader拒绝主工作树apps/packages/scripts/tests源码fallback，记录实际导入的108个本地源文件。为排除Mac /var路径无关symlink保护，只将子进程TMPDIR指向规范自有目录，没有改宿主设置。[环境与快照核对](evidence/blob-admission-baselines/baseline-qualification.json)

Node为已安装CUA darwin-arm64 24.21.0，本轮源码／SQLite检查不宣称历史Linux SHA或产品运行时资格。原Node24／Rollup Team ID构建限制保留，没有重试构建、改签名或系统安全。没有GUI、listener、真实provider、媒体、实际用户项目或credentials操作。

## 停止的部分与技术方案

冻结边界下不修运行时兼容。下一步须先批准明确的历史准入政策，不能以全绿为理由静默跳过所有非TEXT单元：

1. 分开决定有效restored25的只读opaque证据准入与普通24迁到40的资格。不能用一个宽松flag合并，也不回退bootstrap。
2. 若恢复旧25能力，先验证固定结构、原capture类型／字节hash、origin／held、owner／锁及inode。旧BLOB只保留原始证据，不转TEXT、不交现代JSON／volume语法解析，不放行旧request replay、execute、reconcile或ACK。新epoch业务仍遵循现有TEXT契约。
3. 审计所有回执读路径，证明没有隐式Buffer转换或借历史宽限取得volume能力。若需改变冻结validator／dispatcher，先列精确文件、profile／字段与例外供父任务判断，本轮不实施。
4. 获批后保留本轮BLOB拒绝／零写入控制、a7 current40拒绝、畸形TEXT／转义volume词元、错误capture hash、held与未知结果守卫；只对批准的旧profile补原BLOB可冷重开证明。不能重写源行或伪造原回执。

本轮交付已实跑的归因、独立格式控制和限定方案；**原历史BLOB启动兼容未修复，发布检查原6项失败仍存在**。
