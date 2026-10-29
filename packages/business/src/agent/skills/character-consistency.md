---
name: character-consistency
version: 1
title: 角色一致性
summary.zh-Hans: 用主体和主体绑定让同一角色在各个镜头里的外貌、服装和持物保持一致。
summary.zh-Hant: 用主體和主體綁定讓同一角色在各個鏡頭裡的外貌、服裝和持物保持一致。
summary.en: Keep a character's look, clothes and props consistent across shots with subjects and subject bindings.
summary.ja: 被写体と被写体の関連付けで、同じ人物の外見、服装、持ち物をショット間でそろえます。
---
# 角色一致性

同一个角色出现在多个镜头里时，用主体固定外貌，用绑定把主体关联到镜头。

## 固定项

每个角色先确定一组固定项，写进项目说明的角色设定（用户同意后用 project.notes.set 更新），提示词里一直用同一组词：

- 年龄感、脸型、发型和发色；
- 服装和颜色；
- 配饰，例如手表、眼镜、耳环；
- 持物习惯，例如总是右手持伞；
- 伤痕、妆容等需要延续的细节。

## 什么时候建主体

- 出场两次以上的角色建一个主体；只出场一次的角色可以不建。
- 建主体前先问用户。先用 subject.list 看是否已有同一角色，避免重复。
- 加载 subjects 组：subject.create 建主体，subject.version.add 添加参考图版本。参考图只能用项目里已有的素材。

## 绑定到镜头

- 镜头里出现的每个已建主体的角色都要绑定（subject.binding.set）。先用 subject.binding.list 看已有绑定。
- 绑定后，提示词里只写动作、表情和与镜头相关的变化，外貌由主体参考提供；不要在提示词里写和主体矛盾的外貌。
- 角色在剧情中换装或受伤时，在项目说明里注明从哪个镜头起变化，并在之后的镜头里统一使用新的描述。

## 检查

生成之后或用户要求时，按“连续性检查”方法核对各镜头的衣着、持物和伤情，并报告不一致的地方。
