简体中文 | [English](README.en.md)

# zcode-model-schedule

为 [ZCode](https://zcode.ai) 提供基于时间的模型切换：在夜间和周末使用你的计划内模型，并在工作时间内自动恢复日常配置。

> **免责声明：** 这是一个个人社区工具。**不是** ZCode 官方项目，与 ZCode 无隶属或背书关系。

## Features

- **定时切换** — `dayWindows` 日程决定何时切换（窗口外）以及何时恢复（窗口内）。
- **可用性门禁** — 切换到目标模型之前，可以检查你计划的计费端点，当计划不可用或已过期时跳过切换。
- **快照恢复** — 切换前的模型设置会被捕获一次，并在日窗口打开时逐字节还原。
- **热重载** — ZCode 监听自身的配置文件，因此本工具所做的更改在约 1–2 秒内生效，无需重启。
- **双触发** — launchd agent 在窗口边界（加上 5 分钟安全网间隔）触发，而 ZCode `SessionStart` hook 在每个会话启动时运行本工具。
- **幂等且带锁保护** — 重复运行仅在模式真正改变时才执行；独占锁配合过期锁检测防止并发运行损坏状态。

## Requirements

- **macOS**（调度使用 launchd；hook 和 `apply.mjs` 也可在不使用 launchd 的情况下工作）
- **Node.js >= 18**
- **ZCode** 已安装，且在 `~/.zcode/v2/config.json` 中至少配置了一个 provider
- 对于自定义 agents：agent 定义文件（例如 `~/.zcode/agents/implementer.md`），其 YAML frontmatter 包含 `model:` 行以及可选的 `thoughtLevel:` 行

## How it works

ZCode 监听自身配置文件（`~/.zcode/v2/agents-state.json` 和你的自定义 agent `.md` 文件），并在变更发生后约 1–2 秒内热重载它们。

`apply.mjs` 在每次运行时评估日程：

1. **在日窗口之外**（夜间、周末）：如果尚未切换，它会先快照当前模型设置，然后将每个已配置的 agent 指向**目标**模型——内置 agent 通过 `~/.zcode/v2/agents-state.json` 中的 `builtInModelSelectionOverrides` 切换，自定义 agent 则重写其 frontmatter 中的 `model:` / `thoughtLevel:` 行。
2. **在日窗口之内**（你的工作时间）：如果有切换处于活动状态，它会精确还原快照值并清除快照。
3. 如果所需模式已经处于活动状态，则不做任何操作（幂等）。如果启用了可用性检查且计划不可用，则跳过切换到目标模式并附带原因。

触发方式：

- **launchd**（`node install.mjs`）：每个窗口边界（每个 `dayWindow` 的进入/退出时间）各一个日历条目，另加 `StartInterval=300`，以便错过触发器（例如在边界时刻笔记本处于睡眠状态）能在 5 分钟内被捕获到。每次运行调用 `apply.mjs --if-due`。
- **ZCode SessionStart hook**（`node install.mjs --register-hook`）：在会话启动时运行 `apply.mjs --if-due`，这样一台整夜关闭的机器会在你开始工作时立即切换。

所有状态都保存在脚本旁边的目录中（你克隆此仓库的目录），因此该工具可以安装在任意位置。

## Quick start

```bash
git clone https://github.com/pppetertao/zcode-model-schedule.git
cd zcode-model-schedule

# 1. 从示例创建你的配置
cp schedule.example.json schedule.json

# 2. 编辑 schedule.json：设置目标（provider/model/reasoning level）以及要管理的 agents
#    （见下方 Configuration 部分）

# 3. 预览将发生哪些更改（除写入 logs/runs.jsonl 运行记录外不写任何文件）
node apply.mjs --dry-run

# 4. 检查当前状态和可用性
node apply.mjs --status

# 5. 注册 SessionStart hook，使每个新的 ZCode 会话都应用日程
node install.mjs --register-hook

# 6.（可选）安装 launchd agent，实现基于时间的切换，无需依赖会话启动
node install.mjs
```

`node apply.mjs` 会立即执行切换；验证错误会以 `[invalid] <scope>: <reason>` 格式打印，退出码为 1。

## Dashboard

一个可选的本地只读 web dashboard，让你一眼看到当前模式、可用性、最近运行、切换历史、配置摘要，并支持手动触发一次 `apply --if-due`。

```bash
npm run dashboard        # 或：node dashboard.mjs --port <n>
```

启动后访问 **http://127.0.0.1:8787**。注意：**不会自动打开浏览器**，请在浏览器地址栏手动输入上面的地址。

页面包含：当前模式、可用性、最近运行（最多 10 条）、切换历史（最多 10 条）、配置摘要、手动触发。

- 手动触发按钮等价于 `node apply.mjs --if-due --trigger dashboard`，是幂等的（仅在模式真正需要改变时执行），不提供强制覆盖。
- 仅监听本机 loopback（`127.0.0.1`），无认证、无 HTTPS。
- 若端口 8787 已被占用，启动会报错退出；用 `--port <n>` 换一个端口即可。

### 常驻（launchd）

`node install.mjs` 默认同时安装 dashboard LaunchAgent（`com.zcode.model-schedule-dashboard`）：RunAtLoad 登录自动拉起、KeepAlive 崩溃自动重启，端口默认 8787。换端口 `node install.mjs --dashboard-port <n>`（写入 plist 持久生效）；端口只记录在 dashboard plist 中，重装/升级重新执行 `node install.mjs` 时需重复带 `--dashboard-port <n>`，否则回落 8787。只装调度 agent `node install.mjs --no-dashboard`；日志 `logs/dashboard.out.log` / `logs/dashboard.err.log`；**安装前若已有手工启动的 dashboard 占用端口，先停掉再 install，否则 KeepAlive 会反复重启并刷错误日志**。

停用分两档：

- **临时停止** — `launchctl bootout gui/$(id -u)/com.zcode.model-schedule-dashboard`：仅卸载当前 job，plist 仍在，下次登录会再次加载。
- **长期停用** — `node install.mjs --uninstall`（移除两个 agent），或 bootout 后删除 `~/Library/LaunchAgents/com.zcode.model-schedule-dashboard.plist`。

## Configuration

配置文件是项目根目录下的 `schedule.json`（参见 `schedule.example.json`）。`$schema` 必须为 `"zcode-model-schedule/v2"`。

| Field | Type | Description |
|---|---|---|
| `timezone` | string | 用于评估日程的 IANA 时区，例如 `"Asia/Shanghai"`。 |
| `target.providerId` | string | 要切换到的 Provider ID，例如 `"account:your-plan-provider"`。必须在 `~/.zcode/v2/config.json` 中存在。 |
| `target.modelId` | string | 要切换到的 Model ID。必须由该 provider 提供（或全局存在于 `account:*` 别名中）。 |
| `target.reasoningLevel` | string | 取值为 `low`、`medium`、`high`、`xhigh`、`max` 之一；必须被目标模型支持。 |
| `agents` | array | 要管理的 Agents。每项格式：`{ "name": "...", "kind": "builtin" \| "custom", "path": "..." }`。 |
| `agents[].kind` | string | `builtin` — ZCode 内置 agent（通过 `agents-state.json` 切换）。`custom` — 你自己的 agent `.md` 文件（重写 frontmatter 行）。 |
| `agents[].path` | string | 仅自定义 agents。`.md` 文件路径；`~` 会被展开。默认为 `~/.zcode/agents/<name>.md`。 |
| `dayWindows` | array | 你的**原始**配置处于活动状态的时段窗口。不在任何窗口内时应用**目标**模型。 |
| `dayWindows[].days` | number[] | 星期几，整数表示，`1=Mon` … `7=Sun`。 |
| `dayWindows[].from` / `.to` | string | `HH:MM` 边界；`to` 必须晚于 `from`（不支持跨夜窗口；`to` 本身为左开右闭）。 |
| `availability.enabled` | boolean | 计划检查的主开关。设为 `false` 以完全跳过检查（视为始终可用）。 |
| `availability.endpoint` | string | 启用时进行 GET 请求的计费/计划 URL。 |
| `availability.provider` | string | `~/.zcode/v2/config.json` 中的 Provider ID，其 `options.apiKey` 用于请求。 |
| `availability.model` | string | 必须出现在活跃计划的 entitlements 中的能力名称，切换才能继续。 |
| `availability.timeout` | number | 请求超时时间，毫秒（正整数）。 |

`kind: "custom"` 的 agent `name` 也用于状态快照和日志行；`kind: "builtin"` 的 agent `name` 必须与 `~/.zcode/v2/agents-state.json` 中出现的内置 agent ID 匹配（例如 `Explore`）。

## CLI reference

### `apply.mjs`

```
node apply.mjs [--config <path>] [--status] [--dry-run] [--force] [--if-due] [--logs [-n <N>]] [--trigger <name>]
```

| Flag | Behavior |
|---|---|
| `--config <path>` | 日程文件路径。默认：脚本所在目录下的 `schedule.json`。`~` 会被展开。 |
| `--status` | 打印时区、当前模式、期望模式、可用性以及当前快照。除写入 `logs/runs.jsonl` 运行记录外不写任何文件。 |
| `--dry-run` | 打印将要发生更改的 JSON 报告 `{ desiredMode, available, changes }`。除写入 `logs/runs.jsonl` 运行记录外不写任何文件。 |
| `--force` | 即使没有差异也重新应用目标值（仅限目标模式；其他情况无操作）。 |
| `--if-due` | 仅在记录的模式与期望模式不同时执行。由 launchd 和 hook 使用；否则打印 `no mode change`。 |
| `--logs [-n <N>]` | 查询运行日志：按时间倒序打印最近 N 条（默认 10）单行摘要，来自 `logs/runs.jsonl`（含 `.1` 轮转份）。查询本身不写入运行日志。 |
| `--trigger <name>` | 触发来源标注，写入运行记录的 `trigger` 字段。launchd 安装传 `launchd`，SessionStart hook 传 `hook`；缺省 `manual`。 |

退出码：

| Code | Meaning |
|---|---|
| `0` | 成功 — 已应用、无需更改、已跳过（不可用）、已跳过（`--if-due`）或干跑。 |
| `1` | 验证、参数或运行时错误（详细信息在 stderr 上，以 `[invalid]` 或 `[error]` 前缀）。 |
| `2` | 锁忙 — 另一个 `apply.mjs` 运行持有 `.apply.lock`。 |

### `install.mjs`

```
node install.mjs [--config <path>] [--dry-run] [--uninstall] [--register-hook] [--dashboard-port <n>] [--no-dashboard]
```

| Flag | Behavior |
|---|---|
| (no flags) | 完整安装：调度 agent + dashboard agent。写入 `~/Library/LaunchAgents/com.zcode.model-schedule.plist`，在当前 Node 二进制路径记录到 `node-path`，并使用 `launchctl` 引导 agent。 |
| `--config <path>` | 用于生成 plist 的日程文件。默认：脚本所在目录下的 `schedule.json`。 |
| `--dry-run` | 将生成的 plist XML 打印到 stdout，不写入或引导任何内容。 |
| `--uninstall` | 卸载调度与 dashboard 两个 launchd agent 并删除对应 plist（如不存在则优雅跳过）。 |
| `--register-hook` | 向 `~/.zcode/cli/config.json` 幂等地添加 `SessionStart` hook 条目（首次变更前会写入带时间戳的备份）。 |
| `--dashboard-port <n>` | dashboard 端口，1..65535 整数，默认 8787，写入 dashboard plist 的 `ProgramArguments`。 |
| `--no-dashboard` | 跳过 dashboard agent 安装，只装调度 agent；与 `--dashboard-port` 同给时以 `--no-dashboard` 为准。 |

plist、`node-path` 和 launchd 日志均相对于脚本自身目录解析，因此项目可以放在家目录中的任意位置。

## Availability check

当 `availability.enabled` 为 `true` 时，`apply.mjs` 在切换到目标之前通过计划检查进行门控：

1. 从 `~/.zcode/v2/config.json` 读取 `availability.provider` 的 API key（`provider.<id>.options.apiKey`）。key **仅保留在内存中**——永远不会写入磁盘，也不会出现在日志或输出中。
2. 使用 `Authorization: Bearer <apiKey>` 和配置的超时时间对 `GET availability.endpoint` 发起请求。
3. 解析响应：查找 `status: "active"` 的计划，其 `[starts_at, ends_at)` 窗口包含服务器的 `server_time`。
4. 在这些计划中，要求至少有一个计划的 `entitlements[].capabilities` 包含 `availability.model`。

如果任何步骤失败，切换将被跳过（`apply.mjs` 退出码 0 并打印 `skipped: <reason>`）。可能的原因：`http-error`、`non-200`、`no-active-plan`、`not-in-window`、`no-entitlement`、`timeout`、`parse-error`。当 `enabled: false` 时，整个检查被跳过（原因 `disabled`）。

默认端点 `https://zcode.z.ai/api/v1/zcode-plan/billing/current` 是 ZCode 计划计费 API。如果你使用不同的 provider，请将 `endpoint` / `provider` / `model` 指向等效值——或者直接禁用检查。

## Logs & state

以下所有文件都位于项目目录中：

| File | Purpose |
|---|---|
| `state.json` | 当前模式（`original`/`target`）、`switchedAt`、预切换值的快照、`lastCheck`。 |
| `history.jsonl` | 每次切换/恢复一行 JSON：`{ time, mode, reason: "switch"\|"restore", agents }`。 |
| `logs/` | `launchd.out.log` / `launchd.err.log`（launchd 运行）、`hook.out.log` / `hook.err.log`（SessionStart hook 运行）、`dashboard.out.log` / `dashboard.err.log`（dashboard launchd 运行）。 |
| `logs/runs.jsonl` | 每次运行追加一条 JSON 记录（schema `zcode-model-schedule/run-log/v1`：时间、触发源、窗口判定、可用性、action、变更明细、耗时、退出码）；达到 1 MiB 轮转为 `runs.jsonl.1`（保留一份）。`error` 字段只含错误类型与代码，不含 API key 与错误消息；`changes` 中的失败项可能带一句读取错误摘要（不含凭据）。 |

损坏的 `state.json` 被视为"未切换"（stderr 上输出 `[warn]`），因此工具可通过重新评估日程自我修复。

升级到带触发标注的版本后，launchd 侧需重新运行 `node install.mjs` 以更新 plist 中的 `--trigger launchd` 实参（未重装的 plist 在运行记录中仍标为 `manual`）；SessionStart hook 无需重新注册，更新工具目录后 `hooks/model-schedule-apply.sh` 自带 `--trigger hook`。

## Security notes

- API key 从 `~/.zcode/v2/config.json` 读取，仅用于可用性请求头，永不持久化、记录或回显。错误路径刻意只记录文件路径和错误类型。
- 文件写入是原子的（临时文件 + 重命名）并保留文件权限。
- 工具仅修改以下文件：
  - `~/.zcode/v2/agents-state.json` — `builtInModelSelectionOverrides` 内的键（其他顶层键不受影响）；
  - 你的自定义 agent `.md` 文件 — 仅 YAML frontmatter 内的 `model:` / `thoughtLevel:` 行；
  - `~/.zcode/cli/config.json` — 追加 hook 条目，首次变更前写入带时间戳的 `.bak-<ISO>` 备份。
- 无遥测；唯一的出站网络调用是可用性端点，且仅在 `availability.enabled` 为 `true` 时。
- 工具以你的用户权限运行（通过 launchd 或 hook）。安装前请阅读源码——代码量小且无外部依赖（仅使用 Node 内置模块）。

## Troubleshooting

- **`[invalid] target: ...` / 模型未找到** — `target.providerId` 或 `target.modelId` 与 `~/.zcode/v2/config.json` 不匹配，或 `target.reasoningLevel` 不在模型的支持列表中。在 ZCode 的配置中检查确切的 provider/model ID。
- **`[invalid] agents[n]: custom agent "..." 文件不存在`** — 自定义 agent 的 `.md` 文件缺失。修正 `agents[].path` 或创建该文件（需要包含 `model:` 行的 frontmatter）。
- **`applied` 失败并显示 `[error] ... frontmatter`** — 自定义 agent 文件缺少 frontmatter 标记或 `model:` 行。修复文件后重新运行；预切换快照已保留，因此不会丢失任何内容。
- **计划过期 / `skipped: no-active-plan` / `skipped: not-in-window`** — 计费端点当前未报告活跃计划。工具保持在你的原始配置上；当计划再次可用时，会在后续触发时切换。
- **升级/移动 Node 后 Node 路径无效** — launchd 运行的是 `node-path` 中记录的二进制文件。重新运行 `node install.mjs` 以刷新它。当 `node-path` 缺失时，hook 脚本会回退到 `$NODE` 或 `PATH` 中的 `node`。
- **过期锁 / 退出码 2** — 之前的运行在持有 `.apply.lock` 时崩溃。如果锁超过 10 分钟或其所属进程已不存在，工具会自动删除该锁。否则，确保没有 `apply.mjs` 在运行，然后手动删除 `.apply.lock`。
- **ZCode 更改了配置格式** — 工具依赖于 `~/.zcode/v2/agents-state.json` 和 `~/.zcode/cli/config.json` 的当前结构。如果 ZCode 更新更改了这些 schema，切换可能会失败或发出警告；请检查 `logs/` 中的 `[warn]` 行并提交 issue。

## Uninstall

```bash
# 1. 移除 launchd agent（调度 + dashboard 两个）
node install.mjs --uninstall

# 2. 移除 SessionStart hook：编辑 ~/.zcode/cli/config.json 并删除
#    command 中提到 model-schedule-apply.sh 的 SessionStart 条目
#    （hook 首次注册时会创建 .bak-<timestamp> 备份）

# 3. 删除项目目录（state.json、history.jsonl 和 logs/ 都在其中）
```

## License

[MIT](LICENSE) © 2026 pppetertao
