# 本地 Dashboard 页面设计 spec

## Goal
为 zcode-model-schedule 增加零依赖本地 web dashboard（仅绑定 127.0.0.1），一眼可见「当前模式、为什么、下次切换、最近活动」，替代翻日志文件；默认只读 + 可选幂等触发；state/history/runs/schedule 任一缺失或损坏页面照常渲染。

关键决策（均已选定）：
| 项 | 决定 | 理由 |
|---|---|---|
| 文件组织 | `lib/dashboard.mjs`（纯聚合+模板，可无端口单测）+ `dashboard.mjs`（HTTP 入口）+ `package.json` script = 3 文件 | 聚合层不触端口即可测；不改 config/run-log 存量模块（132 测试零风险，命中简化路径 ≤3 文件） |
| 端口 | 默认 8787，`--port` 覆盖；EADDRINUSE → 明确报错 exit 1，不递增探测 | 探测会静默开未知端口、URL 不可收藏；固定端口报错可预期 |
| 路由 | HTML 仅 `GET /`；JSON 全在 `/api/*` | handler 全依赖注入，无端口即可单测 |
| 手动触发 | 有：`POST /api/trigger` → spawn `node apply.mjs --if-due --trigger dashboard`（同锁/快照/run-log 路径）；前端 confirm() 防误触；绝无强制覆盖 | 复用既有执行路径零重复；--if-due 幂等，误触无害 |
| 轮询 | 页面每 5s fetch `/api/status`，`document.hidden` 时暂停 | 切换低频，但触发后需看结果闭环 |
| 下次切换 | 14 天边界扫描 + Intl 偏移校正（算法见 Files #1） | 覆盖周末/跨周；跨午夜窗口已被校验禁止（lib/config.mjs:226） |
| script | `"dashboard": "node dashboard.mjs"` | 与 CLI 双入口 |
| 测试 | 纯函数 + handler 注入假 fs/spawn + port 0 集成（close 后 await close 事件） | now/端口全注入，零 flaky |

## Files to Change

### 1. 新增 `lib/dashboard.mjs`（顶层导出以下符号）
- `parseHHMMLocal(value)` — 正则与校验逻辑照 lib/config.mjs:22-29 逐字（`/^\d{2}:\d{2}$/`、h>23||m>59 throw、返回 h*60+m）。本地复刻而非 import 私有 parseHHMM，避免改存量模块。
- `tzParts(date, timezone)` → `{year,month,day,hour,minute}` — Intl.DateTimeFormat formatToParts，模式照 lib/config.mjs:136-152 parseSlotTime（hourCycle:'h23'），另取 year/month/day 字段。
- `wallTimeToInstant(year, month, day, minutes, timezone)` → epoch ms：`guess=Date.UTC(y,m-1,d,hh,mm)`；`p=tzParts(new Date(guess),tz)`；`return guess+(guess-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute))`（偏移校正；DST 消失时段 best-effort，见 Risks）。
- `computeNextSwitch(schedule, now = new Date())` → `{at: ISO, toMode:'original'|'target'}|null`。算法：offset 0..13，`inst=new Date(now.getTime()+offset*86400000)`，`slot=parseSlotTime(inst, tz)`（复用 config.mjs:136 导出）；对每窗口（from/to 经 parseHHMMLocal）：`w.days.includes(slot.day)` 时 `base=tzParts(inst,tz)`，候选 from→toMode 'original'、to→'target'；`cand > now.getTime()` 且更早者胜。边界：now 恰在 from 分钟 → inDayWindow 为 true（from<=minutes<to，config.mjs:161），cand==nowMs 被 `>` 滤除，正确返回窗口 to；窗口内 → 当日 to；周末 → 下一窗口 from；14 天扫描保证非 null（days 非空由 buildDashboardData 的窗口不变量校验保证，见 Files #1 该段）。
- `activeWindow(schedule, now)` → 命中窗口 `{days,from,to}|null` — 判定条件逐字照 lib/config.mjs:156-164（`w.days.includes(day) && from<=minutes && minutes<to`）。
- `readJsonlLinesLocal(filePath)` — 语义照 lib/run-log.mjs:44-62：ENOENT→[]；坏行（JSON.parse 抛错）跳过（try 仅此一条语句，注释自证）；其他读错误向上抛。
- `buildDashboardData({configPath, statePath, historyPath, runLogPath, now = new Date()})` → 只读幂等、绝不 throw：
  - schedule：`loadSchedule(configPath)`（config.mjs:43）try/catch → `scheduleError = err.message`（仅路径/格式信息，无凭据）；失败时 inWindow/desiredMode/nextSwitch/activeWindow/config 全 null。
  - state：复用 `loadState(statePath)`（state.mjs:18，损坏→original 自愈）；`missing/corrupt` 由本地 probeJson 判定（readFileSync ENOENT→missing；JSON.parse 抛错→corrupt），不复制 loadState 归一化。
  - runs：复用 `readRunLogs(runLogPath, {limit:10})`（run-log.mjs:65）；history：readJsonlLinesLocal(historyPath) 按 time 降序 slice 10（排序语义照 run-log.mjs:67-69）；`lastRunReason = runs[0]?.availability ?? null`（不做实时探测）。
  - 返回 `{schema:'zcode-model-schedule/dashboard/v1', generatedAt, now, timezone|null, scheduleError, inWindow, desiredMode, activeWindow, nextSwitch, state:{mode,switchedAt,lastCheck,hasSnapshot,missing,corrupt}, availability:{enabled,endpoint,provider,model,timeout,lastRunReason}, config:{target,agents,dayWindows}|null, runs, history}`。
- `renderDashboardPage(data)` → 完整 HTML（零外链、CSS/JS 内联 `<style>`/`<script>`、system-ui 字体栈、zh-CN）。区块 id（测试锚点）：`#banners`（scheduleError/降级提示）、`#clock`+`#next-switch`（倒计时）、`#mode`（state.mode/desiredMode/inWindow/activeWindow/switchedAt）、`#availability`、`#runs`（time/trigger/desiredMode/inWindow/action/availability/changes 数/durationMs/exitCode，exit≠0 标红）、`#history`（time/mode/reason/agents）、`#config-summary`（target 三元组、agents、dayWindows 表、`<details>` snapshot JSON）、`#trigger`（按钮+结果区）。初始数据经 `<script type="application/json" id="initial-data">` 嵌入，转义 `JSON.stringify(data).replace(/</g,'\\u003c')`；客户端 `JSON.parse` 后 setInterval 5s fetch `/api/status` 局部重渲染，visibilitychange hidden 暂停；按钮 confirm() → POST /api/trigger → toast 结果 + 立即重拉。

### 2. 新增 `dashboard.mjs`（入口 + HTTP）
- `parseArgs(argv)` — `--port <n>`（1..65535 整数否则报错）、`--config <path>`；未知参数报错（风格照 apply.mjs:47-82）。
- `createRequestHandler(deps)` → `async (req, res) => void`；deps = `{configPath, statePath, historyPath, runLogPath, toolDir, now: () => new Date(), spawnTrigger}`（全注入，测试用临时目录 + fake spawnTrigger）。路由：
  - `GET /` → 200 `text/html; charset=utf-8`，`renderDashboardPage(await buildDashboardData({...deps}))`
  - `GET /api/status` → 200 JSON = buildDashboardData
  - `GET /api/runs?limit=N`、`GET /api/history?limit=N` → `{schema, runs|history}`；N 非整数→10，clamp 1..100
  - `POST /api/trigger` → in-flight 布尔守卫（进行中 → 409 `{error:'busy'}`）；`await deps.spawnTrigger()` → 200 `{ok: exitCode===0, exitCode, stdout, stderr, error?}`
  - 其余路径 → 404 `{error:'not-found'}`；方法不符 → 405 + `Allow` 头。统一头：`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。外层兜底 try/catch → 500 `{error:'internal'}`。
- `runApplyIfDue({toolDir, execFileImpl = execFile, timeoutMs = 60000})` → Promise：`execFileImpl(process.execPath, [path.join(toolDir,'apply.mjs'), '--if-due', '--trigger', 'dashboard'], {cwd: toolDir, timeout: timeoutMs, maxBuffer: 1048576}, cb)`；成功 → `{ok:true, exitCode:0, stdout, stderr}`；`err.killed || err.code==='ETIMEDOUT'` → `{ok:false, error:'timeout'}`；其他 → `{ok:false, exitCode: err.code ?? 1, stdout, stderr}`（exit 2=锁忙经此回显）。**绝不 `--force`、绝无模式覆盖参数。**
- `startServer({handler, port, host = '127.0.0.1'})` → Promise<http.Server>：`server.listen(port, host)`；error 事件 EADDRINUSE → stderr「端口 N 已被占用（已有 dashboard 在跑？），可用 --port 换端口」+ `process.exit(1)`。
- `isMainModule()` 照 apply.mjs:37-45 逐字（realpath 对比）；`main()` 仅入口执行：路径常量照 apply.mjs:25-32（DEFAULT_CONFIG / STATE_PATH / HISTORY_PATH / RUN_LOG_PATH），listen 后打印 `dashboard: http://127.0.0.1:<port>`，SIGINT → `server.close()` 退出。服务请求本身不写 run-log（触发产生的记录由被 spawn 的 apply.mjs 自己写）。

### 3. 修改 `package.json:9`
scripts 增 `"dashboard": "node dashboard.mjs"`；`"test"` 由 `node --test test/apply.test.mjs` 改为 `node --test test/`（收编新测试文件，132 存量不变）。

### TDD 用例清单（21 个，全部先写失败测试）
固定 TZ=Asia/Shanghai、固定 ISO 瞬时构造，照 test/apply.test.mjs:18-20 注释约定（2026-11-02=周一）；临时目录用 mkdtempSync，禁止触碰真实 ~/.zcode：
1. nextSwitch 窗口内（2026-11-03 Tue 10:00+08）→ 当日 23:10、toMode 'target'
2. nextSwitch 窗口前（Tue 08:00）→ 当日 08:50、'original'
3. nextSwitch 周六 12:00 → 2026-11-09 Mon 08:50、'original'
4. nextSwitch 周五 23:30 → Mon 08:50、'original'
5. nextSwitch now 恰为 08:50:00 → 23:10（from 候选被 `>` 滤除）
6. nextSwitch 双窗口（days[6,7] 周末窗）周日窗内 → 周日 to、'target'
7. nextSwitch 对 3 个任意瞬时均非 null（14 天扫描终止保证）
8. wallTimeToInstant(2026,7,1,'00:00','America/New_York') → 2026-07-01T04:00:00.000Z（偏移校正）
9. activeWindow 命中 / 不命中 / 空 dayWindows → null
10. readJsonlLinesLocal：ENOENT→[]；坏行跳过、好行保留；目录读错误向上 throw
11. buildDashboardData 全数据齐全（临时目录 4 文件）→ 各字段正确、missing/corrupt 全 false、lastRunReason=runs[0].availability
12. buildDashboardData 全缺失 → 降级标记全 true、runs/history 为 []、不 throw
13. buildDashboardData state.json 损坏 → corrupt=true、mode 'original'；history 坏行跳过好行保留
14. buildDashboardData schedule.json 缺失 → scheduleError 非空、窗口系字段 null、runs 照常返回
15. renderDashboardPage：含 `</html>` 与全部 8 个区块 id；数据字段含 `<script>` 时输出转义为 `\u003c`（无裸注入）
16. GET / → 200 `text/html`、含 `<!doctype html`
17. GET /api/status → 200、JSON.parse 成功、schema==='zcode-model-schedule/dashboard/v1'；`/api/runs?limit=abc` → clamp 10（非 400）
18. GET /nope → 404 JSON；POST /api/status → 405 + Allow 头
19. POST /api/trigger：fake spawnTrigger 返回 exit0 → `{ok:true,exitCode:0}`；exit2 → `{ok:false,exitCode:2}`；进行中二次调用 → 409
20. runApplyIfDue 注入 execFileImpl：成功回调 / err.code=2 / err.killed → error:'timeout' 三态
21. startServer port 0 集成：`server.address().address === '127.0.0.1'`；fetch `/api/status` 200；`close()` 后 await 'close' 事件不挂起（try/finally 兜底 close）

## Acceptance Criteria
- `npm test` 全绿：132 存量 + 21 新 = 153 通过，exit 0；CI macos-latest 同。
- 冒烟：`node dashboard.mjs` 打印 URL；`curl -s http://127.0.0.1:8787/api/status` 为合法 JSON 且 schema=v1；`curl -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/` → 200；Ctrl+C 退出码 0。
- 降级：删除 state.json / history.jsonl / logs/ 后页面仍 200 且显示「暂无数据」（单测 12/13/14 覆盖）。
- 零依赖：package.json 无新增 dependencies；无 node_modules 时 `node dashboard.mjs` 可跑。
- 触发：POST /api/trigger 后 `/api/status` 的 runs[0].trigger === 'dashboard'（或 exit 2 回显锁忙）。
- 安全：`lsof -iTCP:8787 -sTCP:LISTEN` 仅显示 127.0.0.1；任何响应不含 apiKey 字样。

## Risks
- DST 时区（非 Asia/Shanghai）在消失/重复墙钟时段 wallTimeToInstant 为 best-effort（guess 法确定性取一值）；唯一出厂配置 Asia/Shanghai 无 DST，页面标注 timezone 提示。
- 内联前端 JS 维护成本：集中在 renderDashboardPage 单函数；若超 ~400 行拆同文件 template 子函数（不跨文件）。
- `node --test test/` 会把未来新增测试文件纳入 CI —— 预期行为，非回归。
- 端口 8787 冲突：报错指引 `--port`，非阻塞；不自动换端口是有意为之。
- spawnTrigger 依赖 toolDir 正确；真实 spawn 仅冒烟人工验证，单测全用 fake（零 flaky）。

## Exclusions
- 不做强制覆盖/跳过 schedule 的端点；不做认证、不做 HTTPS（仅 loopback 监听）。
- 不做实时 availability 探测端点（保持工具「唯一出站 = availability 检查」契约；页面只显示配置 + 最近 run 结果）。
- 不改 apply.mjs / lib/apply-core.mjs / lib/state.mjs / lib/config.mjs / lib/run-log.mjs 任何语义（parseHHMM / readJsonlLines 本地复刻正是为此）。
- README 文档更新、launchd 自启 dashboard、历史「加载更多」分页 UI、多实例管理 → 另走文档轻量通道 / 后续 episode。
- 不新增依赖、不引入构建步骤、不写独立 .html/.css/.js 文件。
