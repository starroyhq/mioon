# 内置时间线示例

`timeline-basics`（模板版本 1）是普通项目文件与四份原创程序化素材，展示十秒竖屏时间线的切换、空隙、画中画和独立音轨。项目文件使用当前冻结的项目结构；生成时验证当前 history 结构，发行资源不含 history、cache、Mio、任务、撤销、备份、凭据或规范信任。

源目录为 `examples/project-file-v1/timeline-basics/`。`manifest.json` 沿用 `projectTemplateManifestSchema`，记录项目和每份素材的路径、字节数及 SHA-256；README、SOURCE 和 Apache-2.0 LICENSE 随示例分发。素材来自本仓库 `examples/timeline-synthetic`，来源及字形渲染说明见示例的 SOURCE.md，不分发字体软件或用户素材。

## 离线生成

使用 Node 24 和仓库锁定依赖，向一个尚不存在的绝对目录生成：

```sh
node scripts/create-project-file-example.ts --output=/absolute/new/timeline-basics
```

生成器只复用已检入的程序化媒体，通过真实内核、时间线校验和共享 copy builder 构造项目。固定的示例身份、日期、令牌和源指纹用于验证重建；用户实例由 S5 模板操作重新分配身份、令牌和媒体观察值。生成不联网、不调模型、不启动供应商，不使用旧工作区迁移入口。

输出目录存在就拒绝，不能覆盖用户文件。更新检入示例时，先在新位置生成并审阅完整目录及 manifest，再更新源码资源。重做最初媒体可单独运行 `scripts/create-timeline-fixtures.py`；编码器、字体或 SQLite/项目格式变化可能改变字节，应重新验证后有意更新清单。

## 构建与运行目录

- 网页构建插件先严格校验源资源，再生成 `dist/project-examples/timeline-basics/`。
- 桌面 staging 复用这份网页产物，复制至 `build/examples/`，不再把示例重复装入 ASAR 的 web 目录。
- electron-builder 通过 `extraResources` 把它放到 `resources/examples/`；beforePack、afterPack 再次校验。元数据、项目与素材逐项检查，未知文件、符号链接、硬链接、坏 hash 和超出 5 MiB 的示例均拒绝。
- 网页服务端从所选 `distDir/project-examples` 加载；桌面主进程向 utility 后端传受信的 `resources/examples` 路径。运行时不读取仓库的 examples 源目录，也不会在安装目录生成或修复示例。

宿主配置 `projectTemplatesDir` 是服务端/主进程能力，不是 HTTP 输入；已有的进程内 `projectTemplates` 数组可用于显式目录覆盖。安装资源缺失或损坏时只停用示例 catalog，普通项目仍可使用；模板请求按现有 `PROJECT_TEMPLATE_NOT_FOUND` 拒绝，不回退到仓库资源。

## 实例化与验收

实例化继续走 S5-B 的 `project.template.instantiate` 或受信 `instantiateTemplate`：仅接受固定模板 ID/版本，目标为完整的新文件夹，已有目标不覆盖。项目和媒体复制完成后才登记；每次产生新 ID、令牌和独立素材，不带源本机记录。用户项目的必要空 history 由现有内核建立。

媒体引用都落在实例目录内。安装示例关闭或移走后，已完成的实例仍能离线重开、读取素材和编辑；编辑一个实例不会改变另一个或安装模板。自动验收覆盖这些行为、实际媒体 HTTP 读取、字节重建及打包清单。

首页“从示例开始”的按钮和选择流程由 S6-C 接线，本卡不新增界面。签名安装包和真实 Finder/外置盘等系统验收由 Q 执行，资源 staging 和静态元数据检查不代表这些系统验收已完成。
