# 独立环境阻塞与验证边界

这些项目没有被计为通过，不妨碍本轮已有页面状态的视觉对照

| ID | 证据与影响 | 本轮处理 |
|---|---|---|
| FFMPEG_DRAWTEXT | FFmpeg 9.0.2缺drawtext/subtitles；实际最小命令复现Unknown filter | 版本页使用明确标注的本地MP4夹具；模拟文字视频完整发布、烧录字幕路径不判通过。没有调用真实供应商代替 |
| FFMPEG_COLOR_IMAGE | 缺zscale及libwebp/libwebp_anim | 依赖这些滤镜/编码器的路径仍受阻，未安装或升级工具 |
| GNU_TAR | 系统bsdtar不支持GNU tar的--sort=name，未找到gtar | GNU tar专用归档验证受阻；本轮只核对备份/恢复界面，不把入口可见视为真实备份恢复成功 |
| NATIVE_TEST_LANE | 完整测试启动器在macOS执行测试前返回NATIVE_TEST_LANE_BLOCKED（exit2） | 未伪报通过/跳过；76个明确受影响文件用独立进程运行，不等同全仓全套 |
| IAB_STREAM_DISPLAY | IAB两次本地SSE消息显示断开；后端已完成，只读重新读取可恢复。同服务、同构建的独立Chrome只POST一次并实时完成，SSE GET200 | 暂列IAB宿主实时流显示限制；未声称已定位宿主内部根因，不改应用协议、不重复发送。见[Chrome对照](streaming/chrome-result.json) |
| NATIVE_ACTIVE_TRAFFIC_LIGHTS | macOS录屏/屏幕共享紫色系统指示覆盖激活交通灯区域 | 新构建真实窗口灰态交通灯位置可检查，激活彩色态未通过视觉验收 |

工具版本、实际复现输出及命令见[环境证据](validation/README.md)。原生窗口限制见[native/README.md](native/README.md)

设计适配：浅色沿用用户确认的Codex风格；Mock比例按真实能力只读9:16；淡入淡出保留线性；无后端能力的复制/副本/重置菜单不虚构。原生登录与浏览器令牌登录入口不同，原生空首页无令牌页为既有架构

覆盖边界：36个设计状态都重新操作、截图和独立对照；64格覆盖4个关键界面×4语言×2主题×2尺寸，未穷举36×16的576组合；静态截图和键盘/流程抽查不等于完整无障碍认证。未运行真实外部模型或供应商，不把合成夹具视为其能力验证
