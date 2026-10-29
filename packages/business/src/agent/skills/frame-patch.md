---
name: frame-patch
version: 1
title: 首尾帧补镜
summary.zh-Hans: 成片里只有一小段不满意时，切出这一段，用前后两侧的画面作首帧和尾帧生成一段补上，不用整段重做。
summary.zh-Hant: 成片裡只有一小段不滿意時，切出這一段，用前後兩側的畫面作首幀和尾幀生成一段補上，不用整段重做。
summary.en: When only a short stretch of a clip is wrong, cut it out and fill the gap with a clip generated from the frames on either side, instead of remaking the whole shot.
summary.ja: クリップの一部だけがよくないとき、その区間を切り出し、前後の画面を先頭と末尾のフレームにして生成した映像で埋めます。全体を作り直さずに済みます。
---
# 首尾帧补镜

时间线上某个视频片段只有一小段不满意（动作出错、穿帮、画面崩坏），其余可以保留时使用。把这一段换成新生成的一段：首帧是这一段之前的最后一帧，尾帧是这一段之后的第一帧。新的一段能不能和前后自然衔接取决于模型，开始前在回复里说明这一点。

## 先确认

- 加载 editing、scenes、canvas 和 video 组。用 timeline.inspect 找到这个片段，记下轨道、startFrame、durationFrames、sourceInFrame 和素材 ID。时间线固定 30fps，下面的帧号都按 30fps 算。
- 用 provider.list 选模型：inputModes 里要有 frames，才能同时用首帧和尾帧。没有这样的模型时告诉用户，不要改用只有首帧的生成。
- 用 mioon_ask 确认要补的范围（从第几秒到第几秒）和所用模型，选项写成具体的值。
- 有对白的段落不适合这样补：这一段原来的声音会和画面一起被换掉。

## 定补镜范围

- Mioon 不能变速，补上的长度必须是所选模型 durations 里的某个值。取不短于要补范围的最小值，换成帧数记为 N（秒数乘以 30）。
- 在片段里放一个长 N 帧的范围，从时间线帧 P 开始，盖住要补的部分；P 的前一帧和 P+N 都要留在这个片段里。
- 首帧取时间线帧 P−1，尾帧取时间线帧 P+N。时间线帧 t 对应的源帧是 sourceInFrame + (t − startFrame)。
- 首帧和尾帧最好来自原片同一个镜头内部，不要跨过原片里的剪切点。

## 抽帧

1. 用 asset.list 读到片段素材的 sha256，作为 sourceHash。
2. 对两个源帧各调用一次 frame.extract（默认先确认），用 task.wait（kind 为 frame）等结果；任务结果里的 assetId 就是抽出的图片。
3. 抽帧只支持 8 位 yuv420p 的 MP4 或 WebM，最长 600 秒；不支持时告诉用户。

## 生成补镜

1. 用 shot.create 建一个补镜镜头：标题写“补镜 · ”加片段名；referenceAssetIds 只放首帧，lastFrameAssetId 放尾帧；时长是 N 帧对应的秒数；画幅取最接近原素材宽高比的值（asset.inspect 里有宽高）。
2. 提示词写两帧之间要发生的变化：动作、运镜和速度，和前后画面保持一致，不加新的人物或场景。
3. 用 generation.submit 提交，按正常流程确认费用。首帧和尾帧用镜头上保存的这两张，提交时不另传 videoInput。用 task.wait（kind 为 job）等结果，从任务结果或 version.list 找到新视频的素材 ID。

## 接回时间线

生成成功、并且新视频不短于 N 帧（用 asset.inspect 看时长）之后才改时间线；否则原片段保持不动，先告诉用户。
1. 用 timeline.clip.split 在 P 分割片段，再在 P+N 分割右边那一段。
2. 用 timeline.clip.remove 删掉中间那一段。不要用 rippleRemove，后面的片段不能前移。
3. 用 timeline.clip.add 在原轨道的 P 处加入新视频：durationFrames 为 N，sourceInFrame 为 0，rect 和 gain 用原片段的值。
4. 原片段有变换或调色时，在回复里提醒用户给新片段做同样的设置。
5. 分割、删除和加入都可以撤销。抽出的图片和生成的视频会留在素材库，费用记录也会保留。

## 回复

说明补了哪一段（起止时间）、用了哪个模型，以及衔接处需要用户检查的地方。
