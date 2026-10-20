# 测试最终分类

首轮完整逐文件运行后，对失败原因逐项修复或隔离重跑；不是第二轮冻结后的全套重跑

| 分类 | 文件数 |
| --- | --- |
| 初轮通过 | 648 |
| 初轮非零，之后整文件复验通过 | 98 |
| 环境阻塞 | 26 |
| 未分类 / 待复验 | 0 |

共 772 个文件，按已有完整执行证据分类为 746 通过、26 环境阻塞。不能由此声称完整测试全绿

每个文件的初始结果、命令、日志、完整文件范围和最终分类见 [test-disposition.json](test-disposition.json)

## 环境阻塞文件

以下文件保留非零结果，未将部分通过项目冒充整文件通过。8 个代表性纯 HEAD 对照见 [baseline-media-results.json](baseline-media-results.json)

| 文件 | 已核对原因 |
| --- | --- |
| `tests/cli-v4.test.mjs` | FFmpeg lacks drawtext; real Mock generation fails and version/revision checks cascade |
| `tests/export-settings-media.test.ts` | FFmpeg lacks drawtext required by actual subtitle measurement |
| `tests/integration.test.mjs` | Mock drawtext failure prevents genuine versions; subsequent undefined output assertions cascade |
| `tests/look-pack-portability.test.ts` | FFmpeg lacks zscale required by fixed Look colour conversion; lut3d itself is present |
| `tests/mcp.test.ts` | Real Mock generation returns MOCK_RENDERER_UNSUPPORTED because drawtext is absent |
| `tests/media-runtime-paths.test.ts` | Selected absolute FFmpeg executable lacks drawtext; path-selection fixture reaches actual Mock renderer |
| `tests/providers.test.mjs` | Real Mock poll/download paths detect missing drawtext; fake Runway output fixture also depends on Mock-produced bytes |
| `tests/subject-video-provider.test.mjs` | Real Mock success status is unavailable without drawtext |
| `tests/subtitles-media.test.mjs` | Actual subtitle measurement/render requires missing drawtext |
| `tests/subtitles-package.test.ts` | Installed BSD tar rejects --format=gnu; PATH and fixed common candidates have no GNU tar |
| `tests/timeline-colour-media.test.mjs` | Fixed managed colour graph requires missing zscale; subtitle case also requires drawtext |
| `tests/timeline-colour-worker.test.mjs` | Colour capability stage fails on missing zscale before later replacement/publication fences |
| `tests/timeline-export-range-media.test.mjs` | Only subtitle three-canvas case fails on missing drawtext; remaining five pass |
| `tests/timeline-float-media.test.mjs` | Only subtitle float/range case fails on missing drawtext; remaining four pass |
| `tests/timeline-image-concurrency.test.mjs` | Actual managed PNG conversion requires missing zscale |
| `tests/timeline-image-filter.test.mjs` | Actual managed PNG conversion/resize requires missing zscale |
| `tests/timeline-image-media.test.mjs` | Managed image conversion requires missing zscale; mixed subtitle cases also require drawtext |
| `tests/timeline-image-restored-render.test.mjs` | Managed image conversion/subtitle path requires missing zscale/drawtext |
| `tests/timeline-jpeg-concurrency.test.ts` | Managed JPEG/PNG conversion requires missing zscale |
| `tests/timeline-jpeg-decode.test.ts` | Actual float transfer filter explicitly uses missing zscale |
| `tests/timeline-jpeg-restored-render.test.ts` | Managed JPEG/PNG conversion/subtitle path requires missing zscale/drawtext |
| `tests/timeline-mcp.test.mjs` | Official MCP reaches actual Mock generation; missing drawtext returns MOCK_RENDERER_UNSUPPORTED |
| `tests/timeline-media.test.mjs` | Owned backend10s readiness deadline, before actual media acceptance |
| `tests/timeline-preflight-business.test.mjs` | Third real-media recipe requests missing libwebp encoder, before preflight dispatch |
| `tests/version-comparison-media.test.mjs` | Only actual production Mock-published source fixture fails on missing drawtext |
| `tests/workspace-restore-local-execution.test.mjs` | Only actual Mock media publication fails on missing drawtext; restored refusal paths pass |

原始及复验日志归档见 `validation-logs.tar.gz`，映射见 `validation-log-index.json`。归档只含本轮本地验证日志，不含设计源、私有设计导出或工作区数据库
