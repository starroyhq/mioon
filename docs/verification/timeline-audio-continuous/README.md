# 受控连续音频验收证据

主记录：[验收结果与覆盖限制](../../TIMELINE-AUDIO-CONTINUOUS-ACCEPTANCE.md)。

- `checks.json`、`regression.log`、`typecheck.log`、`build.log`：正式命令及结果。
- `final-numeric-report.json`：最终五项 Electron 验收、样本误差、边界、资源与性能。
- `final-source-hashes.json`、`final-artifact-hashes.json`：数值测试源码和实际测试 bundle。
- `product-build-hashes.json`、`product-native-checks.json`：正式产品构建、ASAR 一致性和原生操作。
- `red-*`、`origin-*`、`cursor-reopen-*`：保留的失败及因果诊断证据。
- `extended-regression.log`、`package-custom-dist-failure.log`：没有混入“全绿”的环境/打包尝试。
- `package.log`、`local-adhoc-sign.log`、`product-native.log`：本地 Mac 目录包及运行日志；不代表正式签名、公证或发布。

`evidence-manifest.json` 只校验 native 数值证据，其他结果分别在上述文件记录。
所有数值素材均为本地合成 fixture；不包含媒体、PCM、大型 bundle、凭据或用户
真实项目。数值 fixture 向设备输出静音，不证明主观听感。

完整重现入口和边界见
[`tests/fixtures/timeline-audio-continuous/README.md`](../../../tests/fixtures/timeline-audio-continuous/README.md)。
根目录 `/evidence/` 按既有规则被忽略，精简结果在此复制保存；本目录只为这些
已审阅日志添加局部 `.gitignore` 例外，不改变项目其他日志或生成产物规则。
