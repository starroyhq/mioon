# 项目示例与原创合成素材

正式普通项目示例是 [Timeline basics](project-file-v1/timeline-basics/README.md)：一个 `.mioon` 项目、四份项目内相对素材、严格的 SHA-256 清单，以及来源和许可说明。不分发工作区数据库、本机 history、Mio 对话、任务、凭据或信任记录。

应用通过受控模板操作实例化这份只读源，每份实例都有新的项目身份和独立素材，放进新的项目文件夹；安装目录里的原模板不会被打开编辑。

使用 Node 24 和仓库冻结依赖，基于已检入的原创媒体离线重建：

```sh
node scripts/create-project-file-example.ts --output=/absolute/new/timeline-basics
```

目标目录必须不存在。先审阅新输出再替换仓库成品。精确重建方式和媒体来源见示例的 [SOURCE.md](project-file-v1/timeline-basics/SOURCE.md)。

`timeline-synthetic/` 保留 `scripts/create-timeline-fixtures.py` 制作的原创程序化图片、MP4 和音调。普通示例生成复用这些字节，不需要 Pillow、FFmpeg、字体、模型供应商或联网。若另行重新编码原始媒体，需要 Python 脚本声明的工具和字体路径；编码器或字体版本变化可能改变文件哈希。

`synthetic/reference.png` 和 `look-packs/` 仍是技术测试资源。历史 demo/workspace 迁移脚本不是创建当前普通项目示例的受支持入口。
