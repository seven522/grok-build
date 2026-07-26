# RunBuild 文字动效审查

日期：2026-07-24

参考：<https://ui.aceternity.com/blocks/text-animations>

## 结论

现有语义化字体系统不需要重做。Aceternity 文字动画只应作为少量状态组件使用，不应覆盖侧栏、正文、任务标题或 Agent 流式回复。

## Step 1：空白任务入口

- 截图：`01-empty-task.png`
- 健康度：良好，但中央区域信息密度偏低。
- 建议：在 RunBuild 品牌下加入一次性、短时的淡入文案，例如“今天要构建什么？”。可借鉴 Text Generate Effect 的逐词淡入，但不循环、不改变布局。
- 无障碍：`prefers-reduced-motion: reduce` 下直接显示最终文本；动画文本必须保留完整可读 DOM，不能逐字符播报。

## Step 2：已选择任务的工作区

- 截图：`02-conversation.png`
- 健康度：结构稳定；导航、任务标题和输入区可快速扫描。
- 建议：侧栏、顶栏、任务标题、Agent 正文、代码和工具结果保持静态。Agent 回复本身已经流式出现，不再叠加打字机动画。
- 状态反馈：任务创建或恢复只使用 120–180ms 淡入/位移和现有 loader，不使用 Flip Words 或循环 Typewriter。

## 推荐边界

- 适合：空白任务欢迎文案、页面首次进入的标题/副标题、任务创建完成的短状态切换。
- 不适合：任务列表、项目名、面包屑、代码、错误信息、权限提示、Agent 流式回复。
- 首选：轻量 Blur/Fade 或一次性 Text Generate。
- 避免：Flip Words、循环 Typewriter、带声音的打字效果。
