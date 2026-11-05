---
name: codex-antigravity
description: Delegate bounded tasks to local Antigravity Desktop through the codex-antigravity MCP bridge. Use for requested Antigravity delegation, independent execution tasks, or specific plan discussions; do not route every ordinary question through a worker.
---

# Antigravity 协作

Codex 负责规划、关键判断、来源核验、上下文组织、修改审阅和最终验收。Antigravity 是执行或讨论队友，仅在当前用户授权范围内委派。此 Skill 适用于通用任务，不绑定项目或行业规范。

## 选择模型

按依赖关系、未知项和推理难度选择 `task_type` 与 `effort`，通常省略 `model`，不要只看任务字数。

| 类型 | 适用范围 | 模型系列 | `effort: auto` |
| --- | --- | --- | --- |
| `simple` | 润色、整理、提取、独立小任务 | Gemini 3.8 Flash | Medium |
| `complex` | 复杂排查、多文件依赖、设计 | Claude Opus 5.5 | High |
| `discussion` | 比较明确方案与约束 | Gemini 4 Argon | Medium |

`effort` 为 `auto`、`medium` 或 `high`。显式模型优先，精确 ID 以 `antigravity_models` 为准，不可用时报告错误，不擅自跨系列替换。确认 Opus 额度耗尽且 `fallback: true` 时，最多在原会话中使用 Flash 续接一次，继承 Medium/High；Flash High 不可用时可降为 Flash Medium。地区、登录或一般网络错误不触发切换。固定模型时传 `fallback: false`。

## 工作区与任务输入

每次 `antigravity_start_task` 都由 Codex 自动传入当前聊天或任务的绝对 `workspace`，目录必须已存在。切换项目后同步更新，不要求用户重复输入，不使用插件安装目录或上一次聊天目录。

提供完整目标、必要输入、约束、验收标准、文件范围、`task_type`、`effort` 与 `mode`。只提供当前任务需要的材料。并行文件任务分配不重叠的所有权。讨论须给出具体方案、限制与比较问题；讨论结论不构成执行授权。

默认 `mode: "analysis"` 请求禁用工具调用，不代表操作系统级只读隔离。需要文件操作时使用 `work`，遵守桌面当前权限；不自动批准提问或权限请求，不放宽全局设置。

## 提交与跟进

1. 必要时检查 `antigravity_status` 与 `antigravity_models`；连接和模型列表不证明云端资格或实际调用成功。
2. 提交后保存任务编号，用 `antigravity_get_task` 持续跟进，每次 `wait_seconds` 为 0—30。
3. `submitted` 只是提交成功；`fallback_submitted` 是续接已提交，都需继续查询。`submission_error` 带编号时先查询该编号，避免重复创建已送达任务。
4. `needs_attention` 表示桌面需要用户处理提问或权限请求，如实报告，不代替用户自动批准。
5. 仅在任务完成后审阅输出、核对来源；有文件改动时检查差异并进行相应验证。不把已提交或模型自报成功当作完成。长输出按 `output_truncated` 判断是否截断。
6. 必要时取消本桥接器创建的任务；取消不撤销已发生的文件修改。不查询或取消用户原有会话。

工具不可用或模型调用失败时，如实说明错误，并按当前用户对该任务的要求决定由 Codex 继续还是等待；插件不自动替代 Codex 完成原任务，也不绕过账号、地区或额度限制。

## 当前聊天未加载 MCP 时

安装后的服务名为 `codex-antigravity`。Windows 默认运行目录是用户 `~/.codex/tools/codex-antigravity/`，Skill 位于 `~/.codex/skills/codex-antigravity/`。使用自定义 `CODEX_HOME` 时取实际安装目录。新注册后重新打开 Codex 或新建会话。

从实际项目目录调用全局客户端：

```powershell
$bridgeClient = Join-Path $env:USERPROFILE '.codex\tools\codex-antigravity\scripts\call.mjs'
node $bridgeClient antigravity_status
node $bridgeClient antigravity_models
node $bridgeClient antigravity_start_task --input-file .\task-input.json
node $bridgeClient antigravity_get_task --input-file .\poll-input.json
```

使用文件写入工具生成 JSON 参数，不把任意提示拼进 shell 命令；也支持 `--stdin`。CLI 省略 `workspace` 时采用调用者的当前目录，并拒绝插件源码/运行目录及其子目录；此便利不能替代原生 MCP 每次明确传入工作区的要求。

## 接口边界

当前适配 Antigravity Desktop 2.29.0 的非官方本机私有接口，升级可能影响兼容性。不修改应用安装包，不读取或保存账号凭据，动态 CSRF 标记仅用于请求。运行目录 `.local/` 中的任务记录和备份不随源码发布。
