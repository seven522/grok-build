# RunBuild Sparkles 组件适配评估

日期：2026-07-24

参考：<https://ui.aceternity.com/components/sparkles>

## 结论

有用，但只适合空白任务页的品牌氛围层。它不能承担功能反馈，也不应成为整个工作区的背景。

## Step 1：当前空白任务工作区

- 截图：`01-current-workspace.png`
- 健康度：结构清晰，中央空白区域较大，适合加入一个低存在感的品牌氛围层。
- 推荐位置：仅放在中央 RunBuild 标志附近，位于文字和输入框之后，不能覆盖输入控件。
- 不推荐位置：侧栏、任务列表、对话正文、代码区、自动化页、技能页、错误和权限提示。

## 推荐参数边界

- 容器：宽 300–360px，高 72–96px。
- 粒子：低密度、小尺寸、慢速；视觉强度保持在辅助层级。
- 交互：`pointer-events: none`、`aria-hidden="true"`。
- 生命周期：仅在空白任务状态挂载；进入对话后卸载。
- 动效降级：`prefers-reduced-motion: reduce` 时隐藏或显示静态渐变，不运行粒子动画。

## 与文字动画的关系

不要同时使用高存在感 Sparkles 和 Typewriter。推荐 Sparkles 作为轻背景，欢迎文案保持静态或只做一次 120–180ms 淡入。
