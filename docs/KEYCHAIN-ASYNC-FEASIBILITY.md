# Electron 44.7.0 Keychain 异步可行性

来源访问日期：2026-10-10（UTC）。项目基线：`8c694d191e6c90379c32c9f8db0a778c35c31e14`。

工作树：Mac 独立隔离 checkout；分支：`codex/keychain-async-feasibility-7af12e69`。已读取适用的开发约束；初始工作区干净。本轮仅新增本文，保留全部旧成果，不修改运行时、测试、依赖或 main。

## 结论

**可以在 main 调用官方异步 API，将 macOS Keychain 取钥 I/O 移出 main 的 JavaScript 线程；不能把 safeStorage 直接迁到 worker／utility 并宣称受支持，也不能据此承诺卡住时应用会在固定期限内正常退出。**

| 目标／路线 | 判断 | 证据层级与限制 |
| --- | --- | --- |
| main 改用完整异步 status/encrypt/decrypt | **可行，适合作为最小候选方案** | 44.7.0 官方支持；源码显示 Keychain I/O 在线程池，AES 与结果转换仍在调用线程。尚未原生验收 |
| 直接在 WebWorker／Node worker_threads／utilityProcess 调 safeStorage | **不是受支持的可行方案** | 模块限 Main；WebWorker 明确不支持 Electron 模块；utility 无导出；Node worker 另有 browser/main isolate 初始化约束 |
| 保持现有 appId 包装并读取旧同步密文 | **同一原生身份下有兼容依据** | macOS 共享密钥、格式，且上游有双向互操作测试；本项目旧密文、签名和目标 OS 未验证 |
| 内建 async 保证取消／重新取钥／退出硬期限 | **不成立或未证实** | 无公开取消、刷新、重置接口；初始化缓存；已运行线程池任务可能拖延正常 shutdown |
| 自建原生 helper 或独立完整 Electron 主进程 | **原理上可研究，当前未证实兼容** | 是新执行／身份边界，不能只复制 appId；不是本轮最小实现，也未获运行验证 |

“移出主进程”必须区分 **移出 main 线程的阻塞 I/O** 与 **移到另一个 OS 进程**：官方 async 满足前者的源码设计，仍在原 Electron browser 进程中工作。[官方 API][api]、[原生绑定][binding]、[Keychain provider][provider]

## 版本已核实

项目根 `package.json` 和 `pnpm-lock.yaml` 都锁定 `44.7.0`。不是用 latest 文档或 v44.0.0 替代该版本。

- [官方 release][release] 与 [release API][release-api] 实际可读取：`tag_name=v44.7.0`、`draft=false`、`prerelease=false`、`published_at=2026-10-07T19:13:08Z`。这是本次读取的元数据，不预测未来稳定版。
- [tag ref][tag-ref] 指向 annotated tag `794670e0659c5818dd56b6211be64e5f409ca91a`；[tag object][tag-object] 解引用为 Electron commit **`61f55c4ce540416b3e43f75f6c0f125d22e5e908`**。
- 该 commit 的 [DEPS][deps] 锁定 Chromium `152.0.7977.130`；[Chromium tag 元数据][chromium-tag] 对应 commit **`2c592105bbcd9490a9894df48d0fe59b2c512651`**。
- 下文源码链接全部固定到上述 commit。Electron 的 [Chromium patch 清单][patch-list]及相关补丁一并核对；不能仅拿未打补丁的 Chromium 推定 Electron 行为。未下载或执行 Electron 二进制。

## 官方 API 与实际实现

| 操作 | 同步 API | 异步 API（44.7.0） |
| --- | --- | --- |
| status | `isEncryptionAvailable(): boolean` | `isAsyncEncryptionAvailable(): Promise<boolean>` |
| encrypt | `encryptString(string): Buffer` | `encryptStringAsync(string): Promise<Buffer>` |
| decrypt | `decryptString(Buffer): string` | `decryptStringAsync(Buffer): Promise<{result: string, shouldReEncrypt: boolean}>` |

整个模块仍标为 Main。异步 encrypt/decrypt 在 app ready 前拒绝，异步 status 在 ready 前为 false；ready 后首次相关调用才请求 encryptor。[官方 API][api]、[SafeStorage 绑定][binding]

**源码推断：** Electron 注册 macOS `KeychainKeyProvider` 受 `kUseKeychainKeyProvider` 控制，该 feature 在所核 Chromium 默认启用，实际启动参数仍须验证。[provider 注册][browser-process]、[feature 默认值][features]。provider 的 `GetKey` 使用 `ThreadPool::PostTaskAndReplyWithResult` 与 `MayBlock`，`GetKeyTask` 调用共同的 `KeychainPassword::GetPassword()`；因此等待 Keychain 的工作不由 main JS 线程执行。[provider][provider]

这不代表所有工作都在后台：SafeStorage 回调／就绪分支直接调用 Encryptor 的 AES 运算并构造 JS 返回值。本项目应保留明密文长度上限和并发限制。固定 Chromium [Encryptor][encryptor] 的缺 key／解密失败路径没有回退到同步 OSCrypt；对 Electron patch 清单逐项只读扫描也未发现改动该 async Encryptor、OSCryptAsync 或 Keychain provider 的补丁。[恢复同步组件的补丁][sync-patch]不把同步回退加回 async 路径。

### status、恢复和取消的实质限制

- **不能把 async status 的 true 直接映射为持久化可用。** SafeStorage 的 `OnOsCryptReady` 无条件设置 `is_available_=true` 并 resolve pending status，未检查 `Encryptor::IsEncryptionAvailable()`。后者才检查有效加密 provider。初始化回调完成可能仍没有可用密钥。[绑定][binding]、[Encryptor][encryptor]
- 临时不可用的 provider 会以空 key 保留；OSCryptAsync 完成初始化后缓存 encryptor，后续 `GetInstance` 返回同一对象，SafeStorage 又只请求一次。**源码上，单纯在同一进程重复这些 API 不会重新取钥。**目标 OS 的拒绝后解锁、重新提示、恢复策略仍须原生验证。[OSCryptAsync][oscrypt-async]
- 缓存 key 后成功加密不等于每次都重新检查了当前 OS 授权。项目现有“每次重新计算 status”的意图不能靠方法重命名等价保留；应定义可用性与失败恢复语义，失败保留旧密文并拒绝持久化。Linux 的同步 backend 名也不能独立证明异步 provider 符合拒绝弱后端的策略。
- 公开 API 没有 AbortSignal、deadline、刷新或重置方法。外层 Promise 超时只能停止等待，不能取消 Keychain I/O。底层 pending 仍可保留明文，故超时后不能无限重试或把并发占位立即视为已释放。[绑定及 pending 结构][binding-header]
- 文档概述提到临时不可用，但固定 binding 对外是 Promise rejection，并不返回可依赖的 `isTemporarilyUnavailable` 字段。不要直接把原生错误文本作为公共错误协议。[绑定][binding]
- `shouldReEncrypt` 表示应以所得明文重新加密；文档中“再调用 decryptStringAsync”的句子与底层 [DecryptFlags 定义][encryptor-header]不一致，不能据此循环解密。当前正常 macOS 单一 v10 provider 不因换成 async 就必然要求重加密；本轮不建议读取时自动改写旧密文。

### 主循环恢复不等于正常退出有硬期限

固定 provider 只指定 USER_BLOCKING 和 MayBlock，没有 shutdown trait。[TaskTraits 构造默认值][task-traits]为 SKIP_ON_SHUTDOWN；其语义是未开始任务可跳过，**已开始任务会阻塞 ThreadPool shutdown 直到结束**。Chromium [BrowserMainLoop 退出链][main-loop]实际调用 `ThreadPoolInstance::Get()->Shutdown()`。

因此可推断：async 改善 main 事件循环可响应性，但已开始的 Keychain 长等待仍可能拖延应用正常退出。不能将原先 2 秒 client timeout 或 main 的停止预算称为整个应用退出墙钟保证；强制终止另一进程的方案另需设计，不属于本轮修改。此处是固定源码退出风险，未做真实弹窗、app.quit 或强制退出测试。

## worker、utility 与 helper 边界

- **WebWorker：官方明确不支持 Electron 内置模块。**[多线程文档][multithreading]
- **Node worker_threads：不能作为受支持的 safeStorage 位置。**除了 Main API 范围，绑定还依赖 Browser、g_browser_process 和保存的 main isolate；Node worker 采用另一套 preload／isolate 初始化。本次没有实测其报错形式，也不声称所有原生 binding 必然完全不可见。[绑定][binding]、[JS 环境][js-environment]、[Node 初始化][node-bindings]
- **utilityProcess：固定的公开模块列表没有 safeStorage，原生 utility binding 列表也没有它。**把当前 Images codec 文件移到 utility 不足以获得同一个密钥库。[utility 模块表][utility-modules]、[原生注册][node-bindings]
- **child_process.fork／ELECTRON_RUN_AS_NODE：是 Node 模式，不是完整 Electron browser 环境。**即使 macOS 可执行文件名为 Electron Helper，也不能据此获得 Main API；本项目打包 fuse 还配置了 `runAsNode: false`。[Node fork hook][node-init]、[模式说明][environment]
- **系统原生 helper／独立完整 Electron 实例：未证实。**前者需要另行实现 OS 密钥与密文访问，后者有自己的 browser 主进程；二者都必须解决打包签名、身份、权限、IPC 校验、迟到结果、退出回收以及旧密文兼容，不能视为直接搬代码。没有为此放宽现有 fuse、沙箱或 IPC 权限。

## appId 与旧密文兼容

**应用内绑定与 OS 密钥库身份是两个不同层面。**项目 `secret-store.mjs` 的加密明文包装仍应保持 `{version: 1, appId, plaintext}`、严格字段／大小／base64 校验，Images namespace/profile 与 Agent binding 验证也应保留。生产 `app.starroy.mioon` 和开发 `app.starroy.mioon.dev` 不可互相接受。

macOS 系统取钥名称来自 Electron app name：初始化设置 service 为 `N Safe Storage`、基础 account 为 `N`。[Electron browser 初始化][browser-main]。应用名可由 app.setName 覆盖；本项目在 ready 前设置为 `Mioon`／`Mioon Dev`。Electron 的 [MAS 补丁][mas-patch]还会将实际 account 变为普通 darwin 的 `N Key`、MAS 的 `N App Store Key`；旧无后缀账户可能被复制迁移并删除。不能只读补丁前言或将非 MAS 描述为没有后缀。

同一进程内改用 async 共用该 KeychainPassword 组件，macOS provider 明确按同步实现兼容设计：共同密钥、v10 前缀、相同派生参数与 AES-128-CBC 格式。[provider 声明][provider-header]、[provider 实现][provider]、[同步恢复补丁][sync-patch]。上游 [safeStorage spec][upstream-spec]包含 sync→async 和 async→sync 两个互操作用例；**本轮仅阅读这些测试，没有执行，更没有验证用户旧密文。**

保持 appId 字符串不足以保证 Keychain 访问权相同；还要保持应用名称、bundle/signing identity、entitlements、darwin/MAS 渠道及原钥访问权限。官方特别提醒有效且一致的代码签名；本项目 `builder-config.cjs` 当前 `mac.identity: null`，签名／原生 QA 未验收。helper 共享同一个 service/account 字符串也不能证明 OS 允许访问。[签名说明][api]

以上兼容依据针对固定版本的 macOS 默认 provider；不能外推到所有 Linux provider、Windows、更旧／更新 Electron、修改 feature 或不同签名的构建。

## 最小实现范围与原生验收门槛

后续若授权实施，先选**保留原 main 身份、切换官方 async 三项操作**的受控方案，不先加 native helper；但本报告不将其批准为满足全部退出／恢复要求的最终实现。

1. `apps/desktop/src/secret-store.mjs` 与 `image-secret-store.mjs`：status/encrypt/decrypt 全链路异步，正确提取解密 `result`，保留外层格式、校验和公开错误语义；不以同步 status 前置检查重新引入 Keychain 阻塞，也不以 async status true 单独承诺可写。
2. `image-secret-broker.mjs` 当前微任务直接校验同步返回值，必须有界 await，并在完成后重新检查关闭／所属 utility／请求有效性；保持容量、去重、关闭后拒绝与迟到结果隔离。仅将底层函数改成 async 会让现有返回值校验失败。
3. Agent codec 调用已有 await，但 `packages/business/src/agent/settings.mjs` 的 capabilities/storage 回调同步；需协调状态快照与刷新语义。覆盖 main 在 supervisor 启动前的 Agent 初始解密、后续 acquire/put/close，避免只修 Images。
4. 明确本地等待 deadline、底层在途请求、拒绝后恢复与停机边界；保持心跳与退出处理可调度，同时保留“正常进程退出仍可能等线程池”的限制。不得通过无限重试、错误时回退同步或弱加密消除表面失败。
5. 不自动迁移密文、schema、appId 或签名策略。若最终要求 Keychain 永久阻塞时仍有退出硬期限／同进程可靠重新授权，内建 async 单独不足；需另行审查隔离单元及其身份兼容。

必须在获授权的目标 macOS／签名安装包上验证：相同渠道旧同步密文→async 读取、async 新密文→需要支持的旧路径及重启读取；生产／开发互相拒绝；锁定、拒绝、允许、初始化失败后解锁的实际恢复；挂起弹窗期间主循环/心跳/退出；正常 shutdown 是否被线程池拖住；超时／关闭后的迟到结果不会落盘覆盖状态。使用专门合成凭据和可恢复测试副本，保留旧密文；不能把上游测试存在视作这些验收已通过。其他目标 OS 的 provider 和弱后端策略另需对应验收。

## 实际检查与限制

使用现有 Node v26.9.0，仅执行只读文本／元数据断言。以下命令在新 worktree 根目录运行，不导入项目运行时、不执行网络返回的代码，也不调用 Keychain。首次联网检查遇到 raw.githubusercontent.com TLS ECONNRESET；只为该网络错误增加一次受限重试后完整重跑，退出码 0，全部断言通过，无跳过。检查覆盖项目版本、官方 release/tag、Chromium 版本、异步 API、utility 导出、线程派发／shutdown trait、上游互操作测试存在性；这些结果不是 Electron／原生测试通过。

```sh
env -u NODE_OPTIONS -u NODE_PATH node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const E = '61f55c4ce540416b3e43f75f6c0f125d22e5e908';
const C = '2c592105bbcd9490a9894df48d0fe59b2c512651';
async function text(url) {
  const response = await fetch(url, {signal: AbortSignal.timeout(20000)}).catch(error => {
    if (error.cause?.code !== 'ECONNRESET') throw error;
    return fetch(url, {signal: AbortSignal.timeout(20000)});
  });
  assert.equal(response.status, 200, url);
  return response.text();
}
const json = async url => JSON.parse(await text(url));
const electron = file => text('https://raw.githubusercontent.com/electron/electron/' + E + '/' + file);
const chromium = async file => Buffer.from(await text('https://chromium.googlesource.com/chromium/src/+/' + C + '/' + file + '?format=TEXT'), 'base64').toString();
assert.equal(JSON.parse(readFileSync('package.json', 'utf8')).devDependencies.electron, '44.7.0');
assert.match(readFileSync('pnpm-lock.yaml', 'utf8'), /specifier: 44\.7\.0/);
const [ref, release, deps, docs, binding, modules, provider, spec, traits] = await Promise.all([
  json('https://api.github.com/repos/electron/electron/git/ref/tags/v44.7.0'),
  json('https://api.github.com/repos/electron/electron/releases/tags/v44.7.0'),
  electron('DEPS'), electron('docs/api/safe-storage.md'),
  electron('shell/browser/api/electron_api_safe_storage.cc'),
  electron('lib/utility/api/module-list.ts'),
  chromium('components/os_crypt/async/browser/keychain_key_provider.mm'),
  electron('spec/api-safe-storage.spec.ts'), chromium('base/task/task_traits.h')
]);
assert.equal(ref.object.type, 'tag');
assert.equal((await json(ref.object.url)).object.sha, E);
assert.equal(release.tag_name, 'v44.7.0');
assert.equal(release.draft, false);
assert.equal(release.prerelease, false);
assert.equal(release.published_at, '2026-10-07T19:13:08Z');
assert.match(deps, /'chromium_version':\s*'152\.0\.7977\.130'/);
const chromiumRef = JSON.parse((await text('https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.130?format=JSON')).replace(/^\)\]\}'\n/, ''));
assert.equal(chromiumRef.commit, C);
assert.match(docs, /Process: \[Main\]/);
for (const name of ['isAsyncEncryptionAvailable', 'encryptStringAsync', 'decryptStringAsync']) {
  assert.ok(docs.includes(name) && binding.includes('.SetMethod("' + name + '"'), name);
}
assert.ok(!modules.includes('safeStorage') && !modules.includes('safe-storage'));
assert.match(provider, /ThreadPool::PostTaskAndReplyWithResult/);
assert.match(provider, /TaskPriority::USER_BLOCKING, base::MayBlock\(\)/);
assert.ok(!provider.includes('TaskShutdownBehavior::'));
assert.match(traits, /GetEnum<TaskShutdownBehavior,\s*TaskShutdownBehavior::SKIP_ON_SHUTDOWN>/);
assert.match(spec, /can decrypt data encrypted with sync method/);
assert.match(spec, /sync decrypt can handle async encrypted data/);
console.log('PASS: local pin, official release/tag, Chromium pin, async API, utility exports, worker dispatch/shutdown trait, upstream interoperability test presence');
console.log('Static source assertions only; no Electron/native test was executed.');
NODE
```

本轮没有安装依赖、构建、打包、启动应用、调用真实凭据／媒体／服务、创建测试文件、commit 或 push。链接与唯一文件范围另做静态检查。完成后冻结本文；未执行的原生条件如上，不扩张为实施任务。

[release]: https://github.com/electron/electron/releases/tag/v44.7.0
[release-api]: https://api.github.com/repos/electron/electron/releases/tags/v44.7.0
[tag-ref]: https://api.github.com/repos/electron/electron/git/ref/tags/v44.7.0
[tag-object]: https://api.github.com/repos/electron/electron/git/tags/794670e0659c5818dd56b6211be64e5f409ca91a
[deps]: https://github.com/electron/electron/blob/61f55c4ce540416b3e43f75f6c0f125d22e5e908/DEPS
[chromium-tag]: https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.130?format=JSON
[api]: https://github.com/electron/electron/blob/61f55c4ce540416b3e43f75f6c0f125d22e5e908/docs/api/safe-storage.md
[binding]: https://github.com/electron/electron/blob/61f55c4ce540416b3e43f75f6c0f125d22e5e908/shell/browser/api/electron_api_safe_storage.cc
[binding-header]: https://github.com/electron/electron/blob/61f55c4ce540416b3e43f75f6c0f125d22e5e908/shell/browser/api/electron_api_safe_storage.h
[browser-process]: https://github.com/electron/electron/blob/61f55c4ce540416b3e43f75f6c0f125d22e5e908/shell/browser/browser_process_impl.cc#L522
[features]: https://chromium.googlesource.com/chromium/src/+/2c592105bbcd9490a9894df48d0fe59b2c512651/chrome/common/chrome_features.cc#69
[provider]: https://chromium.googlesource.com/chromium/src/+/2c592105bbcd9490a9894df48d0fe59b2c512651/components/os_crypt/async/browser/keychain_key_provider.mm
[provider-header]: https://chromium.googlesource.com/chromium/src/+/2c592105bbcd9490a9894df48d0fe59b2c512651/components/os_crypt/async/browser/keychain_key_provider.h
[encryptor]: https://chromium.googlesource.com/chromium/src/+/2c592105bbcd9490a9894df48d0fe59b2c512651/components/os_crypt/async/common/encryptor.cc
[encryptor-header]: https://chromium.googlesource.com/chromium/src/+/2c592105bbcd9490a9894df48d0fe59b2c512651/components/os_crypt/async/common/encryptor.h
[oscrypt-async]: https://chromium.googlesource.com/chromium/src/+/2c592105bbcd9490a9894df48d0fe59b2c512651/components/os_crypt/async/browser/os_crypt_async.cc
[patch-list]: https://github.com/electron/electron/blob/61f55c4ce540416b3e43f75f6c0f125d22e5e908/patches/chromium/.patches
[sync-patch]: https://github.com/electron/electron/blob/61f55c4ce540416b3e43f75f6c0f125d22e5e908/patches/chromium/revert_oscrypt_remove_sync_backend.patch
[mas-patch]: https://github.com/electron/electron/blob/61f55c4ce540416b3e43f75f6c0f125d22e5e908/patches/chromium/feat_ensure_mas_builds_of_the_same_application_can_use_safestorage.patch
[task-traits]: https://chromium.googlesource.com/chromium/src/+/2c592105bbcd9490a9894df48d0fe59b2c512651/base/task/task_traits.h#94
[main-loop]: https://chromium.googlesource.com/chromium/src/+/2c592105bbcd9490a9894df48d0fe59b2c512651/content/browser/browser_main_loop.cc#1273
[multithreading]: https://github.com/electron/electron/blob/61f55c4ce540416b3e43f75f6c0f125d22e5e908/docs/tutorial/multithreading.md#L29
[utility-modules]: https://github.com/electron/electron/blob/61f55c4ce540416b3e43f75f6c0f125d22e5e908/lib/utility/api/module-list.ts
[js-environment]: https://github.com/electron/electron/blob/61f55c4ce540416b3e43f75f6c0f125d22e5e908/shell/browser/javascript_environment.cc
[node-bindings]: https://github.com/electron/electron/blob/61f55c4ce540416b3e43f75f6c0f125d22e5e908/shell/common/node_bindings.cc
[node-init]: https://github.com/electron/electron/blob/61f55c4ce540416b3e43f75f6c0f125d22e5e908/lib/node/init.ts
[environment]: https://github.com/electron/electron/blob/61f55c4ce540416b3e43f75f6c0f125d22e5e908/docs/api/environment-variables.md#L91
[browser-main]: https://github.com/electron/electron/blob/61f55c4ce540416b3e43f75f6c0f125d22e5e908/shell/browser/electron_browser_main_parts.cc#L649
[upstream-spec]: https://github.com/electron/electron/blob/61f55c4ce540416b3e43f75f6c0f125d22e5e908/spec/api-safe-storage.spec.ts#L180


## 整合状态：2026-10-10

本文在 `3ece477` 后作为独立研究结果纳入。它不改变生产 safeStorage 实现，也不代表异步候选、真实 Keychain 或 macOS UI 已验证。云端同步基线复现实验另见 [超时审查](KEYCHAIN-TIMEOUT-AUDIT.md)；该实验在异步候选落地时需要明确迁移。独立候选与其验收后续整合，不与本轮客户端版本来源修正混为一项修复。
