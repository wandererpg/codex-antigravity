# codex-antigravity

独立的 Codex 插件，通过本机 MCP 桥接器将有明确边界的任务交给正在运行的 Antigravity Desktop，支持模型路由、任务跟进、结果回收和取消。

适用于文字整理与润色、信息提取、独立代码任务、问题排查和方案讨论。Codex 负责规划、来源核验、关键决策、结果审阅和最终验收；Antigravity 作为执行或讨论队友。插件不绑定特定项目或行业工作流。

**简短描述：** 连接本机 Antigravity Desktop，为 Codex 提供有边界的任务委派与模型协作。

**下载 0.2.1：** [独立插件 ZIP](https://github.com/wandererpg/codex-antigravity/raw/refs/heads/main/releases/codex-antigravity-v0.2.1.zip) · [SHA-256](https://github.com/wandererpg/codex-antigravity/raw/refs/heads/main/releases/codex-antigravity-v0.2.1.sha256) · [更新记录](CHANGELOG.md)

## 功能与环境

- 检查本机连接、查看桌面模型，按任务类型和思考强度路由，也可指定精确模型 ID。
- 在新会话提交任务，查询进度、回收文字或工作结果，并请求取消。
- 提供 MCP 服务、协作 Skill、命令行客户端及 Windows 安装器。
- 每次由 Codex 自动使用当前任务的绝对项目目录，切换项目后同步更新。

需要 **Windows、Node.js 22+、npm、PowerShell**，以及已安装、登录并运行的 **Antigravity Desktop**。当前适配并验证过 Desktop **2.29.0**，使用非官方本机私有接口，升级可能影响兼容性。其他系统尚未完成适配验证。

桥接器不需要单独填写模型 API Key；请求沿用 Antigravity 当前账号并消耗其额度。模型是否真正可用取决于桌面应用、账号资格、地区、额度和网络。连接成功、列出模型或提交成功均不证明实际模型调用成功。

## 安装

克隆仓库，或将发布 ZIP 解压到独立目录，在该目录执行：

```powershell
git clone https://github.com/wandererpg/codex-antigravity.git
cd codex-antigravity
powershell -NoProfile -File .\scripts\install.ps1
```

安装器复制文件到用户 Codex 目录的 `tools/codex-antigravity/`，安装 npm 依赖，注册全局 `mcp_servers.codex-antigravity`，并安装同名协作 Skill。默认目录为 `~/.codex/`；设置了 `CODEX_HOME` 时使用该目录。配置备份和旧名称迁移仅针对本插件，历史桥接任务保留。

安装器只在运行目录生成含本机绝对路径的 MCP 配置，不改写源码清单。已有依赖可用 `-SkipDependencies` 跳过安装。完成后重新打开 Codex 或新建会话，加载新工具与 Skill；无需重启 Antigravity。

### 手动运行与插件格式

```powershell
npm ci
npm start
```

`npm start` 是标准输入输出 MCP 服务，由客户端启动，不是网页服务器。手动注册时，使用本机 `node` 和 `src/server.mjs` 的**绝对路径**；Skill 入口在 [skills/codex-antigravity/SKILL.md](skills/codex-antigravity/SKILL.md)。

根目录 `plugin.json`、`mcp.json` 使用可移植 Agent Plugins 格式，支持该格式的宿主展开 `${PLUGIN_ROOT}`；加载前需安装 npm 依赖。`.codex-plugin/plugin.json` 保留兼容入口；源码 `.mcp.json` 是以插件根目录启动时使用的相对路径模板。跨目录启动或旧版 Codex 优先使用安装器生成的全局绝对路径配置。

项目使用 `private: true`，按 Git/ZIP 分发，不发布为 npm registry 包；ZIP 不附带 `node_modules/`，安装时按锁文件恢复依赖。

## 在 Codex 中调用

安装后直接说明目标，例如：

> 使用 codex-antigravity，让 Flash 整理这段会议笔记，只返回精简文字，不修改文件。

> 使用 codex-antigravity，让 Opus 分析当前项目中的这个问题，限定读取范围，先返回诊断建议。

> 使用 codex-antigravity，让 Argon 比较两个具体实现方案，列出约束与取舍。

原生 MCP 每次必须传入已存在的绝对 `workspace`，由 Codex 自动填写，不需要用户重复输入。全局服务安装目录不代表当前任务目录；模型输出需要由 Codex 审阅后采用。

## 模型路由

| `task_type` | 适用范围 | 配置的模型系列 | `effort: auto` |
| --- | --- | --- | --- |
| `simple` | 润色、整理、提取、独立小任务 | Gemini 3.8 Flash | Medium |
| `complex` | 复杂排查、设计、多文件依赖 | Claude Opus 5.5 | High |
| `discussion` | 比较具体方案与约束 | Gemini 4 Argon | Medium |

`effort` 支持 `auto`、`medium`、`high`，由 Codex 根据实际难度决定。显式 `model` 优先，精确 ID 以 `antigravity_models` 为准；目标模型不可用时报告错误，不擅自跨系列替换。配置见 [config/routing.json](config/routing.json)。

仅在确认 Opus 额度耗尽且 `fallback: true` 时，最多在原会话中使用 Flash 续接一次，并继承 Medium/High；Flash High 不可用时允许降为 Flash Medium。认证、地区或一般网络错误不触发切换。要求固定模型时传 `fallback: false`。

## MCP 工具与参数

| 工具 | 作用 |
| --- | --- |
| `antigravity_status` | 检查本机连接，不验证云端模型权限 |
| `antigravity_models` | 列出桌面模型，不保证账号实际可调用 |
| `antigravity_start_task` | 在新会话中提交任务，返回任务编号 |
| `antigravity_get_task` | 查询结果，也可能触发上述单次额度续接 |
| `antigravity_cancel_task` | 请求取消本桥接器创建的任务 |

`start_task` 接收 `prompt`、`workspace`、`task_type`、`effort`、可选 `model`、`mode` 与 `fallback`。`prompt` 最多 64,000 字符；默认类型 `simple`、思考强度 `auto`、模式 `analysis`、回退 `true`。

- `analysis` 请求禁用工具调用，不构成操作系统级只读隔离。
- `work` 沿用桌面当前工具和权限，可能读写文件，任务范围须已经授权。
- 插件不自动批准权限请求，不放宽全局权限，不查询或取消用户原有会话。

提交后保存任务编号，使用 `get_task` 持续跟进，每次 `wait_seconds` 为 **0—30**。`submitted` 仅代表已提交，`fallback_submitted` 仅代表续接已提交；`submission_error` 带编号时应先查询，避免重复创建已送达的任务。`needs_attention` 表示桌面需要用户处理提问或权限请求，不能自动批准。

任务完成后检查输出与错误；工作任务还应核对文件差异并验证结果。取消不撤销已经发生的修改。返回正文最多 48,000 字符，截断时标记 `output_truncated`。

## 命令行示例

在**实际任务目录**调用安装后的客户端：

```powershell
$bridgeClient = Join-Path $env:USERPROFILE '.codex\tools\codex-antigravity\scripts\call.mjs'
node $bridgeClient antigravity_status
node $bridgeClient antigravity_models
node $bridgeClient antigravity_start_task --input-file .\task-input.json
node $bridgeClient antigravity_get_task --input-file .\poll-input.json
```

自定义安装目录时调整 `$bridgeClient`。也支持 `--stdin` 读取 JSON，不将任意提示拼接进 shell 命令。`task-input.json` 示例：

```json
{
  "prompt": "将下面的任务清单整理成三条建议，只返回文字，不使用工具、不修改文件：先核对输入，再整理方案，最后检查结果。",
  "task_type": "simple",
  "effort": "medium",
  "model": "gemini-3.8-flash-medium",
  "mode": "analysis",
  "fallback": false
}
```

CLI 省略 `workspace` 时采用调用者的当前目录，并拒绝插件源码目录、运行目录及其子目录；也可以显式填写绝对路径。原生 MCP 仍须每次明确传入工作区。`poll-input.json` 使用本次提交返回的编号：

```json
{
  "task_id": "填写本次提交返回的任务编号",
  "wait_seconds": 10
}
```

## 验证与排错

```powershell
npm test
npm run check
node .\scripts\smoke.mjs
```

`npm test` 使用模拟接口和隔离目录，不请求云模型。`npm run check` 检查本机桌面发现；默认 smoke 检查五个 MCP 工具、连接和模型列表，也不提交模型任务。显式执行 `node .\scripts\smoke.mjs --run-model` 才创建真实任务并使用账号额度；`--work-test` 还会在临时工作区写测试文件，两者均不是安装的必需步骤。

| 错误或状态 | 处理 |
| --- | --- |
| `DESKTOP_NOT_RUNNING`、`DESKTOP_UNREACHABLE` | 打开 Antigravity，确认本地服务正常后重新诊断 |
| `AUTH_REQUIRED` | 在 Antigravity 中完成登录 |
| `LOCATION_UNSUPPORTED` | 服务决定地区资格，桥接器不能绕过 |
| `MODEL_UNAVAILABLE` | 检查实际模型列表与路由配置 |
| `QUOTA_EXCEEDED` | 检查账号额度，仅上述 Opus 情况可自动续接 |
| `WORKSPACE_REQUIRED`、`INVALID_WORKSPACE` | 提供已存在的绝对项目目录，CLI 切换到实际任务目录 |
| 升级后无法发现接口 | 运行诊断，核对桌面版本与具体错误 |

## 本地记录与发布范围

桥接器只连接本机 `127.0.0.1` 服务，动态取得请求所需 CSRF 标记，不读取或保存账号凭据，不修改 Antigravity 安装包，不改变全局权限或 TLS 配置。

运行目录 `.local/` 保存桥接任务与迁移备份，可能含提示和模型输出；Git 与发布 ZIP 均排除该目录、依赖、日志与缓存。向模型提供任务前，只传完成任务需要的材料。

发布内容包括源码、路由、安装器、协作 Skill、通用说明与测试，不附带 Antigravity Desktop、模型权重、账号或额度。当前源码未指定独立开源许可证，不应把依赖许可证当作本项目许可证。

## 目录与参考

```text
codex-antigravity/
├── plugin.json                  # 可移植插件身份与展示信息
├── mcp.json                     # 可移植 stdio MCP 清单
├── .codex-plugin/plugin.json     # Codex 兼容入口
├── .mcp.json                    # 兼容启动模板
├── config/routing.json          # 模型与额度续接规则
├── src/                        # MCP 服务、传输、任务与工作区校验
├── scripts/                    # 安装、CLI、诊断和 smoke 检查
├── skills/codex-antigravity/    # 通用协作 Skill
├── test/                       # 自动检查
├── README.md
└── CHANGELOG.md
```

版本说明见 [CHANGELOG.md](CHANGELOG.md)。插件格式参考 [OpenAI 打包文档](https://developers.openai.com/plugins/build/plugins) 与 [Agent Plugins schema](https://agent-plugins.org/)。
