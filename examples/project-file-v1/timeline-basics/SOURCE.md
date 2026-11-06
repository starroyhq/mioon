# 来源、许可与重建

模板 timeline-basics，版本 1；项目物理结构版本 3。生成时验证当前本机 history 结构 10，但成品不分发 history。

四份素材逐字节复制自本仓库 examples/timeline-synthetic。原创程序源是 scripts/create-timeline-fixtures.py：Pillow 绘制几何栅格图形，FFmpeg 制作运动视频并合成正弦音调。没有下载照片、用户文件、模型输出、供应商调用或联网步骤。

几何图案、布局、原创标签与合成音调由本项目创作，和 LICENSE 中的项目源码一样按 Apache-2.0 分发。原始绘图脚本使用 DejaVu Sans 渲染可见文字。本示例不分发字体软件；字体自身的 Bitstream Vera/DejaVu 条款由其官方许可说明，不能将字体软件重新声明为 Apache-2.0：https://dejavu-fonts.github.io/License.html 。

使用 Node 24 和仓库已安装的冻结依赖，离线重建普通项目与清单：

    node scripts/create-project-file-example.ts --output=/absolute/new/timeline-basics

输出目录必须不存在。先审阅新输出再替换仓库成品；生成器不会覆盖既有文件或目录。它使用真实项目内核、业务时间线校验和共用 copy builder，并固定示例 ID、内容令牌、元数据日期和引用 mtime。普通重建复用已检入素材，不需要 FFmpeg、Pillow 或已安装字体。Mioon 为每份用户实例重新观察和校验素材指纹。

如需重做原始媒体，另在已具备 Pillow、FFmpeg/libx264 及脚本所列 DejaVu 字体路径的环境运行 scripts/create-timeline-fixtures.py，再重建本项目。编码器或字体版本变化可能改变媒体字节；须审阅并有意更新清单。这里不承诺跨编码器、字体、SQLite 版本或项目格式变化仍保持逐字节一致。
