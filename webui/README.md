# RunBuild

React + Vite + TypeScript + Mantine 的本地编程 Agent 工作台。它实现了模型选择、任务草稿、执行状态、真实 ACP 会话连接、写入审批和对话输入。

## 桌面客户端

从仓库根目录启动独立桌面窗口：

```sh
./run desktop
```

生成可双击的 macOS 应用：

```sh
./run desktop-build
```

产物位于 `webui/release/mac-arm64/RunBuild.app`。桌面主进程会在启动阶段依次准备本机 HTTP/WebSocket 工作台和根 Agent；项目 Runner 在打开对应项目时按需启动。左下角的登录入口会复用内嵌 Grok CLI 的浏览器 OAuth，并把认证保存到应用私有运行目录；取消或失败不会覆盖原认证。退出应用时会停止登录进程、根 Agent、全部项目 Runner 和本地工作台服务，并等待子进程退出。模型凭据只传给 Agent 子进程，不会暴露给页面或打包进应用。

从仓库根目录启动：

```sh
./run web
```

打开终端输出的本地地址（默认 `http://127.0.0.1:5173`）。

这仅启动前端演示，不会连接 Agent。

## 连接本地 Agent

从仓库根目录启动默认的 Grok 4.5 Agent 与 Web UI：

```sh
./run web-agent
```

Grok 使用当前 `GROK_HOME` 中的 xAI 登录状态，也可以显式提供 `XAI_API_KEY`。启动 Agent 服务不代表模型账号已经授权；未登录时需要先完成 xAI 登录。

显式启动 MiMo：

```sh
./run web-agent mimo
```

启动 DeepSeek V4 Pro：

```sh
./run web-agent deepseek
```

这个命令会在 `127.0.0.1:2419` 启动 `grok agent serve`，并在 Vite 本地代理中注入一次性 WebSocket 认证令牌。浏览器仅能访问 `/acp`，不会读取 API Key 或 Agent 认证令牌。

## 项目与会话

- 项目创建后会在 `$GROK_HOME/projects` 下生成独立目录，并写入 `AGENTS.md`、`.grok/` 和 `references/`。
- 项目只保存名称、目录、指令和来源文件元数据；不会把项目上下文伪装成每一轮聊天消息。
- 打开项目时，WebUI 会按需启动一个独立的 RunBuild Runner；Runner 的进程、端口、`GROK_HOME` 和会话目录均属于该项目。
- 新建项目会话时，ACP `session/new` 的 `cwd` 是项目目录，并通过 `_meta.modelId` 使用当前配置的模型。
- 历史会话通过 `x.ai/session/list` 按项目读取，并通过 `session/load` 恢复完整对话；回放期间界面会明确显示“正在恢复历史会话”，不会表现为空白或卡死。
- 每个 Runner 使用 `workspace` 沙箱。项目目录及系统临时目录可写；兄弟项目目录不可写。该边界限制写入范围，不等同于禁止读取主机上的所有文件。
- 非项目聊天继续使用启动命令创建的根 Bridge；项目会话通过 `/acp/projects/:projectId` 路由到对应 Runner。

## 当前边界

前端已验证 ACP 初始化、会话创建、项目间会话切换、`session/load` 回放，以及两个项目 Runner 同时运行。跨项目写入使用测试文件验收，sandbox 会拒绝写入并记录 `FsViolation`。对工具权限的“允许一次 / 拒绝”响应也已接入界面。Grok 4.5 的服务启动与真实模型推理是两个验收层级；模型推理仍需有效的 xAI 登录或 `XAI_API_KEY`。
