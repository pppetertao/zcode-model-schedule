# Structured Run Logging — Design Spec

## Goal

为每次 apply.mjs 运行落一条机器可读 JSONL 记录（`logs/runs.jsonl`，含时间戳/触发源/窗口判定/可用性/action/变更明细/耗时/退出码），提供 `--logs` 查询入口与大小轮转，补上「无时间戳、无决策原因、无轮转」的可观测性缺口；控制台输出、history.jsonl、锁、两路触发语义逐字不变。

## Files to Change

**Phase A — 核心（新模块 + apply.mjs）**

1. **`/Users/peter/Documents/project/zcode-model-schedule/lib/run-log.mjs`（新建）**，顶层导出：
   - `RUN_LOG_SCHEMA = 'zcode-model-schedule/run-log/v1'`（对齐 config.mjs:8 的 $schema 版本化惯例）
   - `RUN_LOG_MAX_BYTES = 1024 * 1024`
   - `export function appendRunLog(runLogPath, record)` — mkdirSync(recursive) + appendFileSync(JSON+'\n', mode 0o644)，写入前调 rotateIfNeeded。**永不 throw**：全包 try/catch → `console.error('[warn] run-log 写入失败(<path>): <code>')` + return false（需求 5 的降级保证）。
   - `export function rotateIfNeeded(runLogPath)` — statSync.size >= MAX → renameSync 到 `${path}.1`（覆盖旧 .1）；ENOENT → 直接返回。
   - `export function readRunLogs(runLogPath, { limit = 10 } = {})` — 读本体 + `${path}.1`（ENOENT 容忍）；逐行 JSON.parse，坏行跳过；按 time 降序 slice(0, limit)。
   - `export function formatRunRecord(r)` — 单行：`[<time>] <trigger> desired=<d> inWindow=<w> action=<a> avail=<r> changes=<n> dur=<ms>ms exit=<code>`，null 字段打 `-`。
   - `export function summarizeError(err)` — 返回 `{ type, code }`：LockBusyError → `{type:'lock', code:'LOCK_BUSY'}`；否则 `{type:'runtime', code: err.code ?? null}`。**绝不返回 err.message**——V8 的 JSON.parse 错误串可能内嵌 apiKey 片段（既有策略锚点：lib/availability.mjs:21 只记 err.code/err.name）。

2. **`/Users/peter/Documents/project/zcode-model-schedule/apply.mjs`（修改）**：
   - :31 USAGE 追加 `[--logs [-n <N>]] [--trigger <name>]`。
   - :45 `parseArgs` — opts 增加 `trigger:'manual', logs:false, lines:10`；`--trigger <v>` 非空字符串否则 throw；`--logs`；`-n <N>` 正整数否则 throw（复用 :49 的取参模式）。
   - :30 附近新增 `const RUN_LOG_PATH = path.join(TOOL_DIR, 'logs', 'runs.jsonl')`。
   - :123 `main()` 重构：`const t0 = Date.now()`；构造 record 骨架 `{ schema: RUN_LOG_SCHEMA, time: ISO, trigger, ifDue, dryRun, status, desiredMode:null, inWindow:null, stateMode:null, availability:null, action:null, changes:null, error:null, exitCode:null, durationMs:null }`；`const finish = (code) => { record.exitCode = code; record.durationMs = Date.now() - t0; appendRunLog(RUN_LOG_PATH, record); process.exit(code); }`；整体包一层 try/catch（catch 内 `record.error = summarizeError(err); finish(err instanceof LockBusyError ? 2 : 1)`）；现有全部 process.exit(n) 替换为 finish(n)。isMainModule 外层 catch（:216-223）原样保留作兜底。
   - 字段写入点：desiredMode/inWindow 在 :133-134 后写入（inWindow 即 `inDayWindow` 返回值取反：true=白日窗）；stateMode 在 :172 loadState 后；availability 在 :151 checkAvailability 后；changes 在 switchingToTarget/restoring 分支 applyTarget 前复用只读的 `collectChanges(schedule, desiredMode, state)`（:75，dry-run 同源）取 .changes，异常时置 null；dry-run 用 :164 已算出的 changes。
   - action 映射：applied / restored / no-change / force-rewrite / skipped / if-due-skip / dry-run / status；exitCode≠0 → action=null + error。
   - `--logs` 分支：parseArgs 后、loadSchedule 前（坏 schedule 也能查日志）；readRunLogs → 逐条 console.log(formatRunRecord)；两文件均缺 → `console.log('no runs logged yet (<path>)')`，exit 0；**--logs 本身不写 run-log**。
   - 控制台输出逐字保留（:145,153,178,192,199,204,207 均有测试断言）。

**Phase B — 触发标注 + 文档**

3. **`/Users/peter/Documents/project/zcode-model-schedule/install.mjs`** — :40 `generatePlist`：ProgramArguments 在 `--if-due`（:62）后追加 `<string>--trigger</string><string>launchd</string>`；:69-70 重定向不动（存量 plist 无需重装）。
4. **`/Users/peter/Documents/project/zcode-model-schedule/hooks/model-schedule-apply.sh`** — :13 改为 `... apply.mjs --if-due --trigger hook >>...`；`>>` 重定向与 `|| true` 不动。
5. **`/Users/peter/Documents/project/zcode-model-schedule/README.md`** — CLI reference 加 `--logs`/`--trigger` 行（:95-107）；Logs & state 表（:146-155）加 `logs/runs.jsonl` 行 + 1MiB 轮转说明 + 「重装 install.mjs 以更新 trigger 标注」提示。
6. **`/Users/peter/Documents/project/zcode-model-schedule/README.en.md`** — 同步相同段落。
7. **`/Users/peter/Documents/project/zcode-model-schedule/test/apply.test.mjs`** — 见下方测试清单。`.gitignore` 无需改（`logs/` 已忽略）。

## Acceptance Criteria

`npm test`（node --test，CI macos-latest）既有 114 测试 + 以下新增全绿；`node apply.mjs --logs` 手工可查。

新增测试（TDD 清单）：
- **parseArgs**：`--trigger hook` → trigger='hook'；缺省 'manual'；`--trigger` 缺值 throw；`-n 5` → lines=5；`-n 0`/`-n x` throw；`--logs` → logs=true。
- **run-log 单元**：appendRunLog 写一行 JSON（time ISO、0644、嵌套目录自建）；父路径是普通文件 → 不 throw、返回 false；rotateIfNeeded ≥1MiB → rename 到 .1 且旧 .1 被覆盖、<阈值不轮转；readRunLogs 降序 + limit + 坏行跳过 + 文件缺失 → []；formatRunRecord 含 action/dur/exit。
- **E2E**：首次切换 → runs.jsonl 恰 1 行，断言 schema/trigger=manual/action=applied/exitCode=0/changes≥4/durationMs≥0，stdout 仍 `applied mode=target`（扩展现有 :1166 用例）；二次 --if-due → 第 2 行 action=if-due-skip（扩展现有 :1283）；availability 失败 → action=skipped + avail.reason，runs.jsonl 不含 apiKey（沿用 :1201 fixture 加 key 断言）；md 破坏 exit 1 → 记录 exitCode=1 + error.type=runtime 且记录无 message 字段；并发双进程（复用 :1443 fixture）→ runs.jsonl 2 行：一行 exit 0、另一行 0 或 2；--dry-run → action=dry-run 且 :1521 watched 文件零修改断言不变；--status → action=status（**更新 :1141 用例名与断言**：只查 state/history/lock 三路径不存在，不再声称"不写任何文件"）；`--trigger launchd` → trigger=launchd；`--logs -n 1` → 仅输出最新 1 条；无记录 → `no runs logged yet` + exit 0。
- **install/hook**：generatePlist 含 `<string>--trigger</string><string>launchd</string>`（:1552 既有正则仍匹配，新增断言）；hook stub 入参含 `--trigger hook`（:1639 既有用例仍绿，新增断言）。
- **回归**：appendHistory 与 history.jsonl 零改动；全部现有 stdout/stderr 断言原样通过。

## Risks

- 存量已装 plist/hook 不含 --trigger → 归为 manual 直到重装；plist 重定向不改，存量安装零影响。
- 并发旋转竞态：双进程同时 rename → .1 可能少一代；单行 appendFileSync 是 O_APPEND 单次 write，行不交错（与 history.jsonl 同保证，锚点 lib/apply-core.mjs:160-164）。
- --status/--dry-run 从「零文件写入」变为写 runs.jsonl：现有断言只覆盖 state/history/lock（:1148-1150、:1521），不冲突；:1141 用例名必须同步更新，防 reviewer 误报。
- run-log 写入失败仅 [warn] 降级（需求 5 强制），可能掩盖 logs/ 权限问题——install.mjs:92 已 mkdir，且 [warn] 会进 err.log。
- 1MiB + 1 份 ≈ 5-10 天（launchd 最坏 5min/次 × ~200B/行 ≈ 0.6MB/天）；高频用户可查历史更短，属明确取舍。
- collectChanges 复用会在 agents-state 读失败时多打一条 [warn]（:83 既有行为）；测试用 assert.match 子串断言，不破坏。

## Exclusions

- 不改 launchd plist 的 StandardOut/ErrPath 重定向、不改 hook 的 `>>` 重定向（*.out.log/*.err.log 继续作人类可读 dump）。
- 不压缩轮转文件；不引入日志级别（本地单用户 CLI、每运行一记录、控制台已有 [warn]/[error]/[invalid]/[locked] 前缀，多级无消费者）。
- 不复用/不改 history.jsonl 及其写入方（状态变更账本 vs 每次运行记录，语义不同，两者并存）。
- 不做 dashboard 消费端、不做 --logs 过滤/搜索参数、不加新依赖、不改 schedule schema 与 state.json。
