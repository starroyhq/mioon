# 第 2 组：素材状态、重新指向和项目外位置

本轮 23 张 PNG，共 449,036 字节，最大单张 32,744 字节，均低于 95,000 字节。Chromium 156.0.8078.75；23 个 `results.errors` 数组均为空。简体中文截图，另外三种语言由同场景表的 `tests/project-file-ui-media.test.ts` SSR 覆盖。

P6 只验证受控展示，不证明 2a 已接原生选择器。`12-05` 的 picked/auto 行和示例回调表示夹具给定的可信选择后状态；S6-B2 提供绑定项目/素材/修订的选择票据后才接真实入口。缺 native chooser 时按钮隐藏，不用浏览器文件路径或先 import 的资产冒充可信选择。`12-05-no-native-chooser` 明确展示当前缺能力边界。

变化文件的“使用新文件”先暂存意图，应用后添加新素材；旧素材、已有片段和历史引用保持不变。成功提示不代表旧引用被替换。12-06 默认 `fromAnotherComputer=false`，只有单独的 `12-06-from-another` 受控正例传 true；2a 生产 DTO 没有来源字段，生产始终 false。规范未在此设备启用时不会发给 Mio，不推断另一台电脑的状态。

## 逐图对照

| 设计稿 | 状态 | 截图 | 核对内容与限制 |
|---|---|---|---|
| 12-04 | 就绪（标签） | [12-04-badges.png](12-04-badges.png) | “缺失”（红字）、“已变化”（橙字）标签的样式和位置；卡片边框和名称的颜色; 预览只有缺失和已变化。另加待确认、可能已变化、核对中、无法核对四种标签，以及每张卡下面的一行说明；在线的卡没有标签 |
| 12-04 | 就绪（提示条） | [12-04-banner.png](12-04-banner.png) | “3 个素材需要处理”和“重新指向”，红色底和图标; 无 |
| 12-04 | 空 | [12-04-none.png](12-04-none.png) | 没有要处理的素材、文件在线时，提示条和标签都不渲染，截图是空的场景外框; 预览没有 |
| 12-04 | 加载中 | [12-04-banner-checking.png](12-04-banner-checking.png) | 核对中的提示条，带 `role="status"`; 预览没有 |
| 12-04 | 出错 | [12-04-banner-error.png](12-04-banner-error.png) | 没能核对素材状态，橙色提示条和“重试”; 预览没有 |
| 12-05 | 就绪 | [12-05.png](12-05.png) | 示例可信选择结果与自动找到项、内容变化项；说明“使用新文件”应用后添加新素材，旧素材/片段/历史引用不变 |
| 12-05 | 就绪，还有没找到的 | [12-05-missing.png](12-05-missing.png) | 没找到的那行是红色的“还没找到”，只有“另选文件…”; 预览没有 |
| 12-05 | 加载中（查找中） | [12-05-searching.png](12-05-searching.png) | 按原来的文件夹结构查找，带 `role="status"`；“应用”不能点; 预览没有 |
| 12-05 | 空 | [12-05-empty.png](12-05-empty.png) | “没有需要处理的素材”，只有“关闭”; 预览没有 |
| 12-05 | 出错（查找失败） | [12-05-error.png](12-05-error.png) | “没能查找素材”和“重试”；“应用”不能点; 预览没有 |
| 12-05 | 应用中 | [12-05-applying.png](12-05-applying.png) | “应用”显示加载，其他按钮不能点; 预览没有 |
| 12-05 | 出错（应用失败） | [12-05-apply-error.png](12-05-apply-error.png) | danger 提示：没有应用，素材的位置没有改变; 预览没有 |
| 12-05 | 缺少原生可信选择能力 | [12-05-no-native-chooser.png](12-05-no-native-chooser.png) | 缺失和变化行保留，未给选择/使用新文件回调，按钮隐藏且应用禁用；受控演示，不伪造 S6-B2 桥 |
| 12-05 | 变化文件暂存 | [12-05-changed-selected.png](12-05-changed-selected.png) | 显示将添加为新素材，尚未应用；旧素材、已有片段和历史引用不改 |
| 12-05 | 新素材已添加 | [12-05-new-added.png](12-05-new-added.png) | 受控 newAdded=1 成功提示；旧变化行仍保留原引用，不把新增素材当作旧引用已替换 |
| 12-06 | 无来源事实 | [12-06.png](12-06.png) | 默认 fromAnotherComputer=false，显示外部位置与确认动作，不声称来自另一台电脑 |
| 12-06 | 加载中 | [12-06-loading.png](12-06-loading.png) | 正在核对项目文件夹以外的位置；“允许读取并打开”不能点，可以“只打开项目”; 预览没有 |
| 12-06 | 空 | [12-06-empty.png](12-06-empty.png) | 没有项目外的位置：一句说明和“打开”; 预览没有 |
| 12-06 | 出错 | [12-06-error.png](12-06-error.png) | “没能核对项目文件夹以外的位置”和“重试”；只能“只打开项目”; 预览没有 |
| 12-06 | 无规范提示 | [12-06-no-rules-note.png](12-06-no-rules-note.png) | rulesUntrusted=false 时无 AGENTS.md 提示；仅表达调用方事实，不推断来源 |
| 12-06 | 允许中 | [12-06-allowing.png](12-06-allowing.png) | “允许读取并打开”显示加载，“只打开项目”不能点; 预览没有 |
| 12-06 | 明确的异机来源示例 | [12-06-from-another.png](12-06-from-another.png) | 仅此受控场景传 true，保留设计稿与四语来源说明验证；2a 生产 DTO 无来源字段，生产始终 false |
| 12-06 | 不可授权 | [12-06-allow-unavailable.png](12-06-allow-unavailable.png) | 位置清单仍显示，但 canAllow=false 时允许读取禁用，不冒充已经获得权限 |

## 状态映射与视觉差异

- 12-04 在线无标签；缺失、变化、待确认、可能变化、核对中、无法核对保留各自语义。`online/same-stats/outside/readable=false` 显示“找到了，确认后可用”；`changed/unverified` 显示“可能已变化，确认后核对”。unknown/changed 状态在生产读门中不能读取，画廊不访问真实素材字节。
- 标签画在简化的示例素材卡上。真实 AssetLibrary 缩略图、时间线、视频/音频读取门和观察器另行验证；本组不声明其端到端状态。
- 12-05 没有真实工作台背景。changed-selected 的“将添加为新素材”是暂存提示；new-added 的旧变化行保留，因为已有引用没有被重写。
- 12-06 背后是受控首页。默认画面少了稿中的“来自另一台电脑”副标题，这是缺少事实时的有意保守行为；单独 from-another 场景保留原四语正向验证。
- 模态框使用共享尺寸/内边距、图标与字体。长说明自然换行，和静态设计的断行略有差异；不做像素比对。

## 复现与留证

旧 18 张及原 results/README 已备份到主目录 `.agents/tasks/howard-s6-open-flow/s6c-2/gallery-validation/baseline/media/`。沿用 `build-gallery.ts` 独立构建，只执行本组 capture，不运行产品构建：

```sh
export PATH="$HOME/.npm/_npx/538786c08bcb9442/node_modules/node/bin:$PATH"
export TMPDIR=/private/tmp/s6c/tmp
node tests/fixtures/project-file-ui/build-gallery.ts --out /private/tmp/s6c/pr2-gallery/gallery-dist
python3 -u tests/fixtures/project-file-ui/capture.py --dist /private/tmp/s6c/pr2-gallery/gallery-dist --group media
node --test tests/project-file-ui-media.test.ts
```

原始构建/截图日志在主目录 `.agents/tasks/howard-s6-open-flow/s6c-2/gallery-validation/build.log`、`capture-media-attempt1.log`；capture `.exit` 为 0。SSR 的中间失败及最终结果分别保留。capture 的页面/console/fixture 错误断言与压缩上限均未改动，没有清洗 errors。版本打包和规范组的场景与截图未改。
