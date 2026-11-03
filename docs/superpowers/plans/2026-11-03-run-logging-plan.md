# PLAN — Structured Run Logging · B0（Phase A：run-log 模块 + apply.mjs 重构 + E2E 扩展）

## Header

- **spec（唯一事实源）**：`docs/superpowers/specs/2026-11-03-run-logging.md`
- **worktree**：`/Users/peter/Documents/project/zcode-model-schedule/.worktrees/run-logging`（分支 `fix/run-logging`，HEAD 38eba53）
- **计划文件**：`docs/superpowers/plans/2026-11-03-run-logging-plan.md`
- **分段**：B0（spec Phase A：lib/run-log.mjs 新建 + apply.mjs 修改 + test/apply.test.mjs 中 run-log/parseArgs/E2E 测试，Task 1-3）→ B1（spec Phase B 代码：install.mjs + hooks/model-schedule-apply.sh + generatePlist/hook 测试断言，Task 4-5）→ B-final（README.md + README.en.md 同步 Task 6 + 全量 Self-Review）。三段全部落在本文件。
- **baseline 实测（2026-11-03）**：`npm test` → `# tests 114 / # pass 114 / # fail 0`（21 suites）。VERIFY 只对「baseline 绿 → 现在红」负责。
- **测试形态**：`package.json:10` `"test": "node --test test/apply.test.mjs"` —— 全项目仅此一个测试文件。**所有新增测试必须落在 `test/apply.test.mjs`**；禁止新建测试文件、禁止改 package.json（spec Files 列表不含两者）。

## Global Constraints

- **G1 TDD 卡内次序**：Task 1/2 先落测试（跑红，登记红清单）再落生产（跑绿）；Task 3 为纯测试锁定卡（无生产代码）。每卡 dispatch 结束时全量绿，红基线不留到下一卡。
- **G2 控制台逐字冻结**：apply.mjs 既有 stdout/stderr 文案一个字节不改——:129 `[invalid]`、:145 `no mode change`、:153 `skipped: `、:165 dry-run JSON、:179/:207 `no change`、:192 `applied mode=target ...`、:199 `applied mode=original ...`、:204 `no change (--force rewrite done)`、:218 `[locked] `、:221 `[error] `。测试断言逐字依赖（test :1145-1147、:1170、:1197、:1213、:1276、:1291、:1332、:1514-1520 等）。
- **G3 run-log 永不 throw**：`appendRunLog` 全包 try/catch；失败 → `console.error('[warn] run-log 写入失败(<path>): <code>')` + `return false`，code 取 `err.code ?? err.name`（禁 `err.message`）。
- **G4 apiKey 禁入 runs.jsonl**：`record.error` 只经 `summarizeError`（仅 `{type, code}`，无 message 字段）；`record.availability` 只存 reason 字符串。对齐既有策略锚点 `lib/availability.mjs:21`。
- **G5 --logs 语义**：分支位置在 parseArgs 之后、`loadSchedule` 之前（坏 schedule 也能查）；本身**不写** run-log（直接 `process.exit(0)`，不经 finish）；两文件均缺 → `console.log('no runs logged yet (<path>)')` + exit 0。
- **G6 history 零改动**：`lib/apply-core.mjs:160-164`（appendHistory / history.jsonl 写入侧）不动；runs.jsonl 与 history.jsonl 并存，语义不同（每运行一条 vs 状态变更账本）。
- **G7 零新依赖**：仅 `node:fs` / `node:path`；`.gitignore:1` 已含 `logs/`，不改。
- **G8 parseArgs 抛错安全网**：record 骨架先于 parseArgs 构造（安全默认 `trigger:'manual' / ifDue:false / dryRun:false / status:false`）；任何失败路径不得因 record 未定义二次抛错；parseArgs 抛错 → 外层 catch 打 `[error]`（文案与 :221 一致）+ `finish(1)` 落记录。
- **G9 验证命令**：`cd /Users/peter/Documents/project/zcode-model-schedule/.worktrees/run-logging && npm test`（全量）；焦点验证 `node --test --test-name-pattern "<pat>" test/apply.test.mjs`（若 pattern 与 describe 前缀拼接规则不符，以全量 npm test 判定为准）。各卡预期 pass 数：baseline 114 → Task 1 后 124 → Task 2 后 128 → Task 3 后 132。
- **G10 串行执行**：Task 1 → Task 2 → Task 3，**禁止并行**。三者 Files 相交于 `test/apply.test.mjs`；且 Task 2 生产代码 import Task 1 模块、Task 3 锁定 Task 2 行为。

---

## 任务卡集（B0，共 3 卡，全串行）

### Task 1 — lib/run-log.mjs 新建 + 单元测试（tier A）

- **Files**：`lib/run-log.mjs`（新建）；`test/apply.test.mjs`（末尾追加 import + describe 块）
- **依赖/并行**：无前置；与 Task 2/3 相交于 test 文件 → 串行第 1 位
- **TDD 次序**：先落 1b 测试（红：`../lib/run-log.mjs` 不存在，import 失败）→ 再落 1a 生产（绿）
- **验收**：焦点 `node --test --test-name-pattern "run-log" test/apply.test.mjs` 新增 10 用例全过；`npm test` → `# tests 124 / # pass 124 / # fail 0`

#### 1a 生产代码 — 新建 `lib/run-log.mjs`（全文）

```js
// lib/run-log.mjs — 结构化运行日志（logs/runs.jsonl）：每次 apply.mjs 运行追加一条 JSON 记录
// schema 版本化惯例对齐 lib/config.mjs:8（SCHEDULE_SCHEMA）；仅用 Node 内置模块
// 降级保证：写入失败永不 throw，只打 [warn] 并返回 false（观测能力不得影响执行路径）
import fs from 'node:fs';
import path from 'node:path';
import { LockBusyError } from './apply-core.mjs';

export const RUN_LOG_SCHEMA = 'zcode-model-schedule/run-log/v1';
export const RUN_LOG_MAX_BYTES = 1024 * 1024;

// 本体 ≥ RUN_LOG_MAX_BYTES → renameSync 到 `${runLogPath}.1`（覆盖旧 .1）；本体不存在（ENOENT）→ 直接返回
export function rotateIfNeeded(runLogPath) {
  let size;
  try {
    size = fs.statSync(runLogPath).size;
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (size < RUN_LOG_MAX_BYTES) return;
  try {
    fs.renameSync(runLogPath, `${runLogPath}.1`);
  } catch (err) {
    if (err.code === 'ENOENT') return; // stat 与 rename 间隙本体被删（并发）：无事可轮转
    throw err;
  }
}

// 追加一条 JSONL 记录：先轮转，再 mkdirSync(recursive) + appendFileSync（mode 0o644，O_APPEND 单次 write 不交错）
// 永不 throw：任何失败 → [warn]（只记 code/name，不打 message）+ return false
export function appendRunLog(runLogPath, record) {
  try {
    rotateIfNeeded(runLogPath);
    fs.mkdirSync(path.dirname(runLogPath), { recursive: true });
    fs.appendFileSync(runLogPath, JSON.stringify(record) + '\n', { mode: 0o644 });
    return true;
  } catch (err) {
    console.error(`[warn] run-log 写入失败(${runLogPath}): ${err.code ?? err.name}`);
    return false;
  }
}

// 读取单个文件的合法 JSONL 行；ENOENT → []（容忍缺失），其他读错误向上抛
function readJsonlLines(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const records = [];
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // 吞掉单行 JSON.parse 的 SyntaxError：半截写入/手工损坏的行不可恢复，跳过不中断其余记录（try 仅此一条语句）
    }
  }
  return records;
}

// 读本体 + `${runLogPath}.1`（均容忍缺失）；坏行跳过；按 time 降序取前 limit 条
export function readRunLogs(runLogPath, { limit = 10 } = {}) {
  const records = [...readJsonlLines(`${runLogPath}.1`), ...readJsonlLines(runLogPath)];
  // ISO 时间串字典序 = 时间序；缺失 time 的记录排最后
  records.sort((a, b) => String(b.time ?? '').localeCompare(String(a.time ?? '')));
  return records.slice(0, limit);
}

// 单行人类可读摘要：[<time>] <trigger> desired=<d> inWindow=<w> action=<a> avail=<r> changes=<n> dur=<ms>ms exit=<code>
// null/undefined 字段统一打 '-'；changes 为数组时打条数
export function formatRunRecord(r) {
  const v = (x) => (x === null || x === undefined ? '-' : String(x));
  const changes = Array.isArray(r.changes) ? String(r.changes.length) : v(r.changes);
  return `[${v(r.time)}] ${v(r.trigger)} desired=${v(r.desiredMode)} inWindow=${v(r.inWindow)} action=${v(r.action)} avail=${v(r.availability)} changes=${changes} dur=${v(r.durationMs)}ms exit=${v(r.exitCode)}`;
}

// 错误摘要：LockBusyError → {type:'lock', code:'LOCK_BUSY'}；否则 {type:'runtime', code: err.code ?? null}
// 绝不返回 err.message（V8 的 JSON.parse 错误串可能内嵌 apiKey 片段，锚点 lib/availability.mjs:21）
export function summarizeError(err) {
  if (err instanceof LockBusyError) return { type: 'lock', code: 'LOCK_BUSY' };
  return { type: 'runtime', code: err?.code ?? null };
}
```

#### 1b 测试代码 — `test/apply.test.mjs` 末尾追加（在文件最后一个 `});`（hook script describe 结束）之后）

```js

// ── run-logging 追加：run-log 模块单元测试 ──
import {
  RUN_LOG_SCHEMA,
  RUN_LOG_MAX_BYTES,
  appendRunLog,
  rotateIfNeeded,
  readRunLogs,
  formatRunRecord,
  summarizeError,
} from '../lib/run-log.mjs';

describe('run-log（appendRunLog / rotateIfNeeded / readRunLogs / formatRunRecord / summarizeError）', () => {
  test('appendRunLog：写一行合法 JSON（record 原样序列化），嵌套目录自建，mode 0644', () => {
    const dir = makeTmpDir('runlog');
    const logPath = path.join(dir, 'nested', 'deeper', 'runs.jsonl');
    const rec = { schema: RUN_LOG_SCHEMA, time: '2026-11-03T10:00:00.000Z', trigger: 'manual', exitCode: 0 };
    assert.equal(appendRunLog(logPath, rec), true);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), rec);
    assert.ok(!Number.isNaN(Date.parse(JSON.parse(lines[0]).time)));
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o644);
  });

  test('appendRunLog：多次追加 = 多行 JSONL（每条一行）', () => {
    const dir = makeTmpDir('runlog');
    const logPath = path.join(dir, 'runs.jsonl');
    appendRunLog(logPath, { time: '2026-11-03T10:00:00.000Z', seq: 1 });
    appendRunLog(logPath, { time: '2026-11-03T10:01:00.000Z', seq: 2 });
    assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, 2);
  });

  test('appendRunLog：父路径是普通文件 → 不 throw、返回 false（降级保证 G3）', () => {
    const dir = makeTmpDir('runlog');
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'i am a file', { mode: 0o644 });
    const logPath = path.join(blocker, 'runs.jsonl'); // 父路径是文件 → mkdirSync 必败
    assert.equal(appendRunLog(logPath, { time: '2026-11-03T10:00:00.000Z' }), false);
  });

  test('rotateIfNeeded：< 1MiB 不轮转；≥ 1MiB → rename 到 .1 且旧 .1 被覆盖', () => {
    const dir = makeTmpDir('runlog');
    const logPath = path.join(dir, 'runs.jsonl');
    fs.writeFileSync(logPath, 'x'.repeat(RUN_LOG_MAX_BYTES - 1), { mode: 0o644 });
    rotateIfNeeded(logPath);
    assert.ok(fs.existsSync(logPath), '阈值下不轮转');
    assert.ok(!fs.existsSync(`${logPath}.1`));
    fs.writeFileSync(`${logPath}.1`, 'old-rotated', { mode: 0o644 });
    fs.writeFileSync(logPath, 'y'.repeat(RUN_LOG_MAX_BYTES), { mode: 0o644 });
    rotateIfNeeded(logPath);
    assert.ok(!fs.existsSync(logPath), '本体已 rename 走');
    assert.equal(fs.readFileSync(`${logPath}.1`, 'utf8'), 'y'.repeat(RUN_LOG_MAX_BYTES), '旧 .1 被覆盖');
  });

  test('rotateIfNeeded：本体缺失（ENOENT）→ 直接返回不 throw', () => {
    const dir = makeTmpDir('runlog');
    rotateIfNeeded(path.join(dir, 'absent.jsonl'));
  });

  test('readRunLogs：按 time 降序 + limit 截断', () => {
    const dir = makeTmpDir('runlog');
    const logPath = path.join(dir, 'runs.jsonl');
    for (let i = 1; i <= 3; i++) {
      appendRunLog(logPath, { time: `2026-11-03T10:0${i}:00.000Z`, seq: i });
    }
    assert.deepEqual(readRunLogs(logPath).map((r) => r.seq), [3, 2, 1]);
    assert.deepEqual(readRunLogs(logPath, { limit: 1 }).map((r) => r.seq), [3]);
  });

  test('readRunLogs：坏行/空行跳过 + .1 与本体合并降序', () => {
    const dir = makeTmpDir('runlog');
    const logPath = path.join(dir, 'runs.jsonl');
    fs.writeFileSync(`${logPath}.1`, `${JSON.stringify({ time: '2026-11-01T00:00:00.000Z', seq: 0 })}\n`, { mode: 0o644 });
    fs.writeFileSync(logPath, [
      JSON.stringify({ time: '2026-11-03T12:00:00.000Z', seq: 2 }),
      '{broken json',
      '',
      JSON.stringify({ time: '2026-11-03T11:00:00.000Z', seq: 1 }),
    ].join('\n') + '\n', { mode: 0o644 });
    assert.deepEqual(readRunLogs(logPath).map((r) => r.seq), [2, 1, 0]);
  });

  test('readRunLogs：文件缺失（本体与 .1 均无）→ []', () => {
    const dir = makeTmpDir('runlog');
    assert.deepEqual(readRunLogs(path.join(dir, 'absent.jsonl')), []);
  });

  test('formatRunRecord：含 action/dur/exit，changes 数组计条数，null 字段打 -', () => {
    const line = formatRunRecord({
      time: '2026-11-03T10:00:00.000Z', trigger: 'manual', desiredMode: 'target', inWindow: false,
      action: 'applied', availability: 'ok', changes: [{}, {}, {}, {}], durationMs: 12, exitCode: 0,
    });
    assert.match(line, /\[2026-11-03T10:00:00\.000Z\] manual/);
    assert.match(line, /desired=target/);
    assert.match(line, /inWindow=false/);
    assert.match(line, /action=applied/);
    assert.match(line, /avail=ok/);
    assert.match(line, /changes=4/);
    assert.match(line, /dur=12ms/);
    assert.match(line, /exit=0/);
    const sparse = formatRunRecord({ time: null, trigger: 'hook', desiredMode: null, inWindow: null, action: null, availability: null, changes: null, durationMs: null, exitCode: null });
    assert.equal(sparse, '[-] hook desired=- inWindow=- action=- avail=- changes=- dur=-ms exit=-');
  });

  test('summarizeError：LockBusyError → lock/LOCK_BUSY；普通 Error → runtime/code；无 message 字段', () => {
    assert.deepEqual(summarizeError(new LockBusyError('/tmp/x')), { type: 'lock', code: 'LOCK_BUSY' });
    const e = new Error('boom with api key msched-e2e-secret-9f2');
    e.code = 'EACCES';
    const summarized = summarizeError(e);
    assert.deepEqual(summarized, { type: 'runtime', code: 'EACCES' });
    assert.equal('message' in summarized, false);
    assert.ok(!JSON.stringify(summarized).includes('msched-e2e-secret-9f2'), '摘要不得含 message');
    assert.deepEqual(summarizeError(new Error('no code')), { type: 'runtime', code: null });
  });
});
```

---

### Task 2 — apply.mjs 重构 + parseArgs 测试（tier A）

- **Files**：`apply.mjs`（修改）；`test/apply.test.mjs`（替换 `describe('apply.mjs parseArgs', ...)` 整块）
- **依赖/并行**：依赖 Task 1 模块（import）；与 Task 3 相交于 test 文件 → 串行第 2 位
- **TDD 次序**：先落 2b 测试（红：新键 `trigger/logs/lines` 缺失 → 新用例红、deepEqual 更新后红）→ 再落 2a 生产（绿）。main() 的 E2E 行为 red 证据由 Task 3 用例固化（Task 3 为纯测试锁定卡）；本卡同时保证既有 124 用例零回归（runs.jsonl 不在 watched 断言内，见 G2/既有 `assertFilesUntouched` 不受影响）。
- **验收**：焦点 `node --test --test-name-pattern "parseArgs" test/apply.test.mjs` 全过；`npm test` → `# tests 128 / # pass 128 / # fail 0`

#### 2a 生产代码 — `apply.mjs` 五处修改（全部给全文，锚点引原文）

**改动 ① — import 追加**（在 `} from './lib/apply-core.mjs';`（:22）之后插入一行）：

```js
import { RUN_LOG_SCHEMA, appendRunLog, readRunLogs, formatRunRecord, summarizeError } from './lib/run-log.mjs';
```

**改动 ② — 常量区**：替换 :30-31 两行（锚原文：`const LOCK_PATH = path.join(TOOL_DIR, '.apply.lock');` 与 `const USAGE = '用法: node apply.mjs [--config <path>] [--dry-run] [--status] [--force] [--if-due]';`）为：

```js
const LOCK_PATH = path.join(TOOL_DIR, '.apply.lock');
const RUN_LOG_PATH = path.join(TOOL_DIR, 'logs', 'runs.jsonl'); // 结构化运行日志（run-log/v1，1MiB 轮转 + .1 一份）
const USAGE = '用法: node apply.mjs [--config <path>] [--dry-run] [--status] [--force] [--if-due] [--logs [-n <N>]] [--trigger <name>]';
```

**改动 ③ — parseArgs 全文替换**（:45-67 整个函数，锚原文从 `export function parseArgs(argv) {` 到其 `}`）：

```js
export function parseArgs(argv) {
  const opts = { config: DEFAULT_CONFIG, dryRun: false, status: false, force: false, ifDue: false, trigger: 'manual', logs: false, lines: 10 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`--config 需要一个路径参数\n${USAGE}`);
      opts.config = value;
      i += 1;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--status') {
      opts.status = true;
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--if-due') {
      opts.ifDue = true;
    } else if (arg === '--trigger') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value.length === 0) throw new Error(`--trigger 需要一个非空名称参数\n${USAGE}`);
      opts.trigger = value;
      i += 1;
    } else if (arg === '--logs') {
      opts.logs = true;
    } else if (arg === '-n') {
      const value = argv[i + 1];
      const n = Number(value);
      if (value === undefined || !Number.isInteger(n) || n <= 0) throw new Error(`-n 需要一个正整数参数\n${USAGE}`);
      opts.lines = n;
      i += 1;
    } else {
      throw new Error(`未知参数: ${arg}\n${USAGE}`);
    }
  }
  return opts;
}
```

**改动 ④ — collectChangesSafe 辅助函数**（在 collectChanges 函数结束 `}`（:103）之后、`// 将 target.builtin / target.custom 落盘`（:105）之前插入）：

```js
// 变更明细（只读，dry-run 同源）；只读计算抛错 → null（明细仅观测用，不阻断执行路径）
function collectChangesSafe(schedule, desiredMode, state) {
  try {
    return collectChanges(schedule, desiredMode, state).changes;
  } catch {
    // 吞掉只读 diff 计算异常（computeTargetState/readFileSync 系）：变更明细仅观测用，主路径不由它驱动（try 仅一条语句）
    return null;
  }
}
```

**改动 ⑤ — main() 全文替换**（:123-213 整个函数）+ **外层兜底保留**（:215-224 `if (isMainModule())` 块原样不动，作兜底）：

```js
async function main() {
  const t0 = Date.now();
  // record 骨架先行：parseArgs 抛错时 opts 不存在 → 安全默认（G8），catch 路径仍能落记录、不二次抛错
  const record = {
    schema: RUN_LOG_SCHEMA,
    time: new Date().toISOString(),
    trigger: 'manual',
    ifDue: false,
    dryRun: false,
    status: false,
    desiredMode: null,
    inWindow: null,
    stateMode: null,
    availability: null,
    action: null,
    changes: null,
    error: null,
    exitCode: null,
    durationMs: null,
  };
  const finish = (code) => {
    record.exitCode = code;
    record.durationMs = Date.now() - t0;
    if (code !== 0) record.action = null; // spec 字段契约：exitCode≠0 → action=null + error
    appendRunLog(RUN_LOG_PATH, record);
    process.exit(code);
  };
  try {
    const opts = parseArgs(process.argv.slice(2));
    record.trigger = opts.trigger;
    record.ifDue = opts.ifDue;
    record.dryRun = opts.dryRun;
    record.status = opts.status;

    // --logs：查询入口，先于 loadSchedule（坏 schedule 也能查）；本身不写 run-log（G5）
    if (opts.logs) {
      const logs = readRunLogs(RUN_LOG_PATH, { limit: opts.lines });
      if (logs.length === 0) {
        console.log(`no runs logged yet (${RUN_LOG_PATH})`);
      } else {
        for (const r of logs) console.log(formatRunRecord(r));
      }
      process.exit(0); // 查询路径直接退出，不经 finish（spec：--logs 本身不写 run-log）
    }

    const schedule = loadSchedule(opts.config);
    const registry = loadModelRegistry();
    const { valid, errors } = validateSchedule(schedule, registry);
    if (!valid) {
      for (const e of errors) console.error(`[invalid] ${e.scope}: ${e.reason}`);
      record.error = { type: 'validation', code: null }; // 无异常对象的 exit 1 路径：error 非空才可观测（B0 决策 D2）
      finish(1);
    }

    const now = new Date();
    const inWindow = inDayWindow(schedule, now);
    const desiredMode = inWindow ? 'original' : 'target';
    record.inWindow = inWindow; // true = 白日窗
    record.desiredMode = desiredMode;

    if (opts.status) {
      const state = loadState(STATE_PATH);
      const avail = await checkAvailability(schedule);
      record.availability = avail.reason;
      record.action = 'status';
      printStatus(schedule, desiredMode, state, avail);
      finish(0);
    }

    // --if-due：state 不存在/损坏 → true（重新评估）；mode 相同 → 跳过（无需加锁）
    if (opts.ifDue && !opts.force && !modeChanged(STATE_PATH, desiredMode)) {
      record.action = 'if-due-skip';
      console.log('no mode change');
      finish(0);
    }

    // 锁外只做可用性检测（仅切 target 时需要，恢复/幂等不需要）
    if (desiredMode === 'target') {
      const avail = await checkAvailability(schedule);
      record.availability = avail.reason;
      if (!avail.available) {
        record.action = 'skipped';
        console.log(`skipped: ${avail.reason}`);
        finish(0);
      }
    }

    // --dry-run：只读，无需加锁；需 state 计算变更清单
    if (opts.dryRun) {
      const state = loadState(STATE_PATH);
      const switchingToTarget = desiredMode === 'target' && state.mode !== 'target';
      const avail = await checkAvailability(schedule);
      record.availability = avail.reason;
      record.action = 'dry-run';
      const wouldSkip = switchingToTarget && !avail.available;
      const { changes } = wouldSkip ? { changes: [] } : collectChanges(schedule, desiredMode, state);
      record.changes = changes;
      console.log(JSON.stringify({ desiredMode, available: avail.available, changes }, null, 2));
      finish(0);
    }

    acquireLock(LOCK_PATH); // LockBusyError → 下方 catch 落记录后 exit 2
    try {
      // 锁内重读 state（F1：避免并发快照被已切换值污染）
      const state = loadState(STATE_PATH);
      record.stateMode = state.mode;
      const switchingToTarget = desiredMode === 'target' && state.mode !== 'target';
      const restoring = desiredMode === 'original' && state.mode === 'target';
      const idempotent = !switchingToTarget && !restoring;

      if (idempotent && !opts.force) {
        record.action = 'no-change';
        console.log('no change');
      } else if (switchingToTarget) {
        // F2：先快照并持久化，再执行切换
        // F1：若 state.mode==='original' && state.snapshot!==null → 被打断切换残留，复用已落盘值
        const snapshot = state.snapshot ?? captureSnapshot(schedule.agents, AGENTS_STATE_PATH, AGENTS_DIR);
        saveState(STATE_PATH, { mode: 'original', switchedAt: null, snapshot, lastCheck: now.toISOString() });
        record.changes = collectChangesSafe(schedule, desiredMode, state); // applyTarget 前取 pre-state diff
        const target = computeTargetState(schedule, 'target', null);
        applyTarget(schedule, target);
        saveState(STATE_PATH, { mode: 'target', switchedAt: now.toISOString(), snapshot, lastCheck: now.toISOString() });
        appendHistory(HISTORY_PATH, { mode: 'target', reason: 'switch', agents: schedule.agents.map((a) => a.name) });
        record.action = 'applied';
        console.log(`applied mode=target agents=${schedule.agents.map((a) => a.name).join(',')}`);
      } else if (restoring) {
        // 进入白天窗：按快照恢复切换前值
        record.changes = collectChangesSafe(schedule, desiredMode, state); // applyTarget 前取 pre-state diff
        const target = computeTargetState(schedule, 'original', state.snapshot);
        applyTarget(schedule, target);
        saveState(STATE_PATH, { mode: 'original', switchedAt: now.toISOString(), snapshot: null, lastCheck: now.toISOString() });
        appendHistory(HISTORY_PATH, { mode: 'original', reason: 'restore', agents: schedule.agents.map((a) => a.name) });
        record.action = 'restored';
        console.log(`applied mode=original agents=${schedule.agents.map((a) => a.name).join(',')}`);
      } else if (opts.force && desiredMode === 'target') {
        // 幂等 + --force：重写 target 值（无 diff 也写）
        const target = computeTargetState(schedule, 'target', null);
        applyTarget(schedule, target, { force: true });
        record.action = 'force-rewrite';
        console.log('no change (--force rewrite done)');
      } else {
        // 幂等 + --force 于 original 窗：无快照可恢复，无事可做
        record.action = 'no-change';
        console.log('no change');
      }
    } finally {
      releaseLock(LOCK_PATH);
    }
    finish(0);
  } catch (err) {
    // 控制台文案与既有 :216-223 逐字一致（stderr 断言依赖）；区别仅在于先落 run-log 记录再退出
    if (err instanceof LockBusyError) {
      console.error(`[locked] ${err.message}`);
    } else {
      console.error(`[error] ${err?.message ?? err}`);
    }
    record.error = summarizeError(err);
    finish(err instanceof LockBusyError ? 2 : 1);
  }
}
```

结构性说明（供 reviewer）：原 `if (idempotent && !opts.force) { ...; return; }` + 其后的独立 `if/else if` 链合并为单一 else-if 链——原 early-return 语义由链首分支等价承载，控制台输出不变；`process.exit(n)` 全部替换为 `finish(n)`，仅 `--logs` 分支保留 `process.exit(0)`（G5）。

#### 2b 测试代码 — `test/apply.test.mjs` 中 `describe('apply.mjs parseArgs', ...)` 整块替换（:990-1011，锚原文从 `describe('apply.mjs parseArgs', () => {` 到该块的 `});`）

```js
describe('apply.mjs parseArgs', () => {
  test('无参数 → 默认值（config 为脚本自身目录下 schedule.json，与 $HOME 无关）', () => {
    const opts = parseArgs([]);
    assert.deepEqual(opts, {
      config: path.join(TOOL_ROOT, 'schedule.json'),
      dryRun: false,
      status: false,
      force: false,
      ifDue: false,
      trigger: 'manual',
      logs: false,
      lines: 10,
    });
  });

  test('全量 flag + --config 取值', () => {
    const opts = parseArgs(['--config', '/tmp/x.json', '--dry-run', '--status', '--force', '--if-due']);
    assert.deepEqual(opts, { config: '/tmp/x.json', dryRun: true, status: true, force: true, ifDue: true, trigger: 'manual', logs: false, lines: 10 });
  });

  test('--config 缺值 → throw；未知参数 → throw', () => {
    assert.throws(() => parseArgs(['--config']), /--config/);
    assert.throws(() => parseArgs(['--bogus']), /未知参数/);
  });

  test('--trigger hook → trigger=hook；--trigger launchd → launchd', () => {
    assert.equal(parseArgs(['--trigger', 'hook']).trigger, 'hook');
    assert.equal(parseArgs(['--trigger', 'launchd']).trigger, 'launchd');
  });

  test('--trigger 缺值 / 空串 → throw', () => {
    assert.throws(() => parseArgs(['--trigger']), /--trigger/);
    assert.throws(() => parseArgs(['--trigger', '']), /--trigger/);
  });

  test('-n 5 → lines=5；-n 0 / -n x / -n 缺值 → throw', () => {
    assert.equal(parseArgs(['-n', '5']).lines, 5);
    assert.throws(() => parseArgs(['-n', '0']), /-n/);
    assert.throws(() => parseArgs(['-n', 'x']), /-n/);
    assert.throws(() => parseArgs(['-n']), /-n/);
  });

  test('--logs → logs=true；与 -n / --trigger 组合共存', () => {
    assert.equal(parseArgs(['--logs']).logs, true);
    assert.equal(parseArgs(['--logs', '-n', '3']).lines, 3);
    assert.equal(parseArgs(['--logs', '--trigger', 'launchd']).trigger, 'launchd');
  });
});
```

---

### Task 3 — test/apply.test.mjs E2E 扩展（tier A，纯测试锁定卡）

- **Files**：`test/apply.test.mjs`（setupE2E 返回值、readRunRecords 辅助、:1141 用例改名、6 处既有用例扩展、4 个新用例）
- **依赖/并行**：依赖 Task 2 生产落地；串行第 3 位
- **卡性质（TDD 说明）**：本卡无生产代码改动（Iron Law 不适用——无生产代码）；定位 = spec E2E 验收断言固化 + 回归锁定（若回退 Task 2 的 main()/parseArgs，本卡用例必红，可静态论证）。执行 = 直接落用例跑绿。
- **验收**：焦点 `node --test --test-name-pattern "E2E" test/apply.test.mjs` 全过；`npm test` → `# tests 132 / # pass 132 / # fail 0`

#### 3a 测试基础设施（两处小改）

**改动 A — setupE2E 返回 runsLogPath**：替换（锚原文，:1083-1085）：

```js
  const lockPath = path.join(toolDir, '.apply.lock');
  const watched = [agentsStatePath, implementerMd, visionMd, statePath, historyPath];
  return { home, toolDir, schedulePath, agentsStatePath, statePath, historyPath, lockPath, implementerMd, visionMd, watched, ORIGINAL_MODEL };
```

为：

```js
  const lockPath = path.join(toolDir, '.apply.lock');
  const runsLogPath = path.join(toolDir, 'logs', 'runs.jsonl');
  const watched = [agentsStatePath, implementerMd, visionMd, statePath, historyPath]; // runs.jsonl 刻意不入 watched：它按设计每次运行都会写
  return { home, toolDir, schedulePath, agentsStatePath, statePath, historyPath, lockPath, runsLogPath, implementerMd, visionMd, watched, ORIGINAL_MODEL };
```

**改动 B — readRunRecords 辅助**：在 `assertFilesUntouched` 函数结束 `}`（:1034）之后插入：

```js
// 按序读取 runs.jsonl 全部记录（append-only，文件序 = 时间序）
function readRunRecords(runsLogPath) {
  return fs.readFileSync(runsLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}
```

#### 3b — :1141 用例整块替换（改名 + 断言更新，spec：不再声称「不写任何文件」，只查 state/history/lock 三路径）

锚原文：`test('--status：打印 current/desired mode + availability，exit 0，不写任何文件', () => {` 至该用例 `});`。替换为：

```js
  test('--status：打印 current/desired mode + availability，exit 0；state/history/lock 三路径不落盘', () => {
    const e = setupE2E({ dayWindows: [] }); // dayWindows=[] → 恒 target 窗
    const r = runApply(e.toolDir, e.home, ['--status']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /current mode: original/);
    assert.match(r.stdout, /desired mode: target/);
    assert.match(r.stdout, /availability: available/); // availability.enabled=false → available(disabled)
    assert.equal(fs.existsSync(e.statePath), false);
    assert.equal(fs.existsSync(e.historyPath), false);
    assert.equal(fs.existsSync(e.lockPath), false);
    const recs = readRunRecords(e.runsLogPath);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].action, 'status');
    assert.equal(recs[0].exitCode, 0);
    assert.equal(recs[0].availability, 'disabled');
  });
```

#### 3c — 六处既有用例扩展（给出唯一锚原文 + 插入内容）

**扩展 ①（:1166 首次切换）**——锚原文（该用例末尾，唯一）：

```js
    assert.ok(!Number.isNaN(Date.parse(rec.time)));
  });
```

改为：

```js
    assert.ok(!Number.isNaN(Date.parse(rec.time)));
    // run-log：恰好 1 行，结构化字段齐备（run-log/v1）
    const runRecs = readRunRecords(e.runsLogPath);
    assert.equal(runRecs.length, 1);
    assert.equal(runRecs[0].schema, 'zcode-model-schedule/run-log/v1');
    assert.equal(runRecs[0].trigger, 'manual');
    assert.equal(runRecs[0].action, 'applied');
    assert.equal(runRecs[0].exitCode, 0);
    assert.equal(runRecs[0].desiredMode, 'target');
    assert.equal(runRecs[0].inWindow, false); // dayWindows=[] → 恒 target 窗
    assert.equal(runRecs[0].stateMode, 'original'); // fresh state → emptyState().mode
    assert.ok(Array.isArray(runRecs[0].changes) && runRecs[0].changes.length >= 4);
    assert.ok(runRecs[0].durationMs >= 0);
    assert.ok(!Number.isNaN(Date.parse(runRecs[0].time)));
    assert.equal(runRecs[0].error, null); // 成功路径 error=null（无 message 泄露面）
    assert.match(r.stdout, /applied mode=target/); // 控制台输出原样（G2）
  });
```

注：成功路径 `error` 断言用 `assert.equal(runRecs[0].error, null)`——不可用 `'message' in error`（error 为 null 时 `in` 运算符会 throw TypeError，语义不同）；exit 1 路径（扩展 ④）的 error 是对象，`'message' in` 写法才适用。

**扩展 ②（:1201 可用性失败）**——锚原文（该用例末尾，唯一）：

```js
    assert.ok(!r.stderr.includes('msched-e2e-secret-9f2'), 'stderr 泄露 apiKey');
    assertFilesUntouched(before);
  });
```

改为：

```js
    assert.ok(!r.stderr.includes('msched-e2e-secret-9f2'), 'stderr 泄露 apiKey');
    assertFilesUntouched(before);
    // run-log：action=skipped + avail.reason；runs.jsonl 全文不含 apiKey
    const skipRecs = readRunRecords(e.runsLogPath);
    assert.equal(skipRecs.length, 1);
    assert.equal(skipRecs[0].action, 'skipped');
    assert.equal(skipRecs[0].exitCode, 0);
    assert.equal(skipRecs[0].availability, 'http-error'); // 127.0.0.1:9 连接拒绝 → http-error
    const rawLog = fs.readFileSync(e.runsLogPath, 'utf8');
    assert.ok(!rawLog.includes('msched-e2e-secret-9f2'), 'runs.jsonl 泄露 apiKey');
  });
```

**扩展 ③（:1283 --if-due 两次）**——锚原文（唯一）：

```js
    assert.match(r2.stdout, /no mode change/);
    assertFilesUntouched(before);
  });
```

改为：

```js
    assert.match(r2.stdout, /no mode change/);
    assertFilesUntouched(before);
    // run-log：第 1 行 applied、第 2 行 if-due-skip（append-only，文件序 = 时间序）
    const dueRecs = readRunRecords(e.runsLogPath);
    assert.equal(dueRecs.length, 2);
    assert.equal(dueRecs[0].action, 'applied');
    assert.equal(dueRecs[1].action, 'if-due-skip');
    assert.equal(dueRecs[1].exitCode, 0);
  });
```

**扩展 ④（:1302 custom md 缺 model 行）**——锚原文（`// Step 2：修复 implementer.md` 注释唯一）：

```js
    assert.deepEqual(state1.snapshot.vision, { model: e.ORIGINAL_MODEL, thoughtLevel: 'max' });

    // Step 2：修复 implementer.md → 再跑 → snapshot 不变
```

改为：

```js
    assert.deepEqual(state1.snapshot.vision, { model: e.ORIGINAL_MODEL, thoughtLevel: 'max' });

    // run-log：exit 1 → 记录 exitCode=1 + error.type=runtime，且 error 无 message 字段（G4）
    const recsAfterFail = readRunRecords(e.runsLogPath);
    assert.equal(recsAfterFail.length, 2); // r0 成功 + r1 失败
    const failRec = recsAfterFail[1];
    assert.equal(failRec.exitCode, 1);
    assert.equal(failRec.error.type, 'runtime');
    assert.equal('message' in failRec.error, false);
    assert.equal(failRec.action, null); // exitCode≠0 → action=null
    assert.equal(failRec.trigger, 'manual');

    // Step 2：修复 implementer.md → 再跑 → snapshot 不变
```

**扩展 ⑤（:1443 并发双进程）**——锚原文（该用例末尾，唯一）：

```js
    assert.ok(result.stdouts[idx].includes('no change') || result.stderrs[idx].includes('[locked]'),
      `另一进程预期 no change 或 [locked], stdout="${result.stdouts[idx].trim()}", stderr="${result.stderrs[idx].trim()}"`);
  });
```

改为：

```js
    assert.ok(result.stdouts[idx].includes('no change') || result.stderrs[idx].includes('[locked]'),
      `另一进程预期 no change 或 [locked], stdout="${result.stdouts[idx].trim()}", stderr="${result.stderrs[idx].trim()}"`);
    // run-log：双进程各落 1 行（O_APPEND 单次 write 不交错）；一行 exit 0、另一行 0 或 2
    const concRecs = readRunRecords(e.runsLogPath);
    assert.equal(concRecs.length, 2);
    const recCodes = concRecs.map((rec) => rec.exitCode);
    assert.ok(recCodes.includes(0), `至少一行 exit 0, got ${recCodes}`);
    assert.ok(recCodes.every((c) => c === 0 || c === 2), `所有记录退出码合法: ${recCodes}`);
  });
```

**扩展 ⑥（:1509 --dry-run）**——锚原文（该用例末尾，唯一）：

```js
    assert.ok(payload.changes.every((c) => 'agent' in c && 'field' in c && 'old' in c && 'new' in c));
    assertFilesUntouched(before);
  });
```

改为：

```js
    assert.ok(payload.changes.every((c) => 'agent' in c && 'field' in c && 'old' in c && 'new' in c));
    assertFilesUntouched(before);
    // run-log：action=dry-run + 变更明细与 stdout JSON 同源；watched 断言不变（runs.jsonl 不在 watched）
    const dryRecs = readRunRecords(e.runsLogPath);
    assert.equal(dryRecs.length, 1);
    assert.equal(dryRecs[0].action, 'dry-run');
    assert.equal(dryRecs[0].exitCode, 0);
    assert.ok(Array.isArray(dryRecs[0].changes) && dryRecs[0].changes.length >= 4);
  });
```

#### 3d — 四个新 E2E 用例（追加在 E2E describe 内末尾；锚原文 = `--force` 用例末尾至 describe 收口，唯一）

锚原文（:1532-1536）：

```js
    for (const p of targets) {
      assert.ok(fs.statSync(p).mtimeMs > before[p], `--force 未重写: ${p}`);
    }
  });
});
```

改为：

```js
    for (const p of targets) {
      assert.ok(fs.statSync(p).mtimeMs > before[p], `--force 未重写: ${p}`);
    }
  });

  test('--trigger launchd → 记录 trigger=launchd（launchd/hook 标注通道）', () => {
    const e = setupE2E({ dayWindows: [] });
    const r = runApply(e.toolDir, e.home, ['--trigger', 'launchd']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /applied mode=target/);
    const recs = readRunRecords(e.runsLogPath);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].trigger, 'launchd');
    assert.equal(recs[0].action, 'applied');
  });

  test('--logs：单行摘要逐条输出（最新在前）；-n 1 → 仅最新 1 条；查询本身不写 run-log', () => {
    const e = setupE2E({ dayWindows: [] });
    runApply(e.toolDir, e.home, ['--trigger', 'hook']); // 第 1 条：applied（trigger=hook）
    runApply(e.toolDir, e.home, ['--if-due']); // 第 2 条：if-due-skip（trigger=manual，最新）
    const r = runApply(e.toolDir, e.home, ['--logs']);
    assert.equal(r.status, 0);
    const outLines = r.stdout.trim().split('\n');
    assert.equal(outLines.length, 2);
    assert.match(outLines[0], /action=if-due-skip/); // 降序：最新在前
    assert.match(outLines[0], /trigger=manual/);
    assert.match(outLines[0], /exit=0/);
    assert.match(outLines[1], /action=applied/);
    assert.match(outLines[1], /trigger=hook/);
    const r1 = runApply(e.toolDir, e.home, ['--logs', '-n', '1']);
    assert.equal(r1.status, 0);
    const oneLine = r1.stdout.trim().split('\n');
    assert.equal(oneLine.length, 1);
    assert.match(oneLine[0], /action=if-due-skip/);
    assert.equal(fs.readFileSync(e.runsLogPath, 'utf8').trim().split('\n').length, 2, '--logs 查询本身不追加记录');
  });

  test('--logs 无记录 → no runs logged yet + exit 0，且不创建 runs.jsonl', () => {
    const e = setupE2E({ dayWindows: [] });
    const r = runApply(e.toolDir, e.home, ['--logs']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no runs logged yet/);
    assert.equal(fs.existsSync(e.runsLogPath), false);
  });

  test('--logs 先于 loadSchedule：schedule 损坏也能查日志', () => {
    const e = setupE2E({ dayWindows: [] });
    runApply(e.toolDir, e.home); // 先落一条成功记录
    fs.writeFileSync(e.schedulePath, 'not-json{{{', { mode: 0o644 });
    const r = runApply(e.toolDir, e.home, ['--logs']);
    assert.equal(r.status, 0); // 若 --logs 在 loadSchedule 之后处理，这里会 exit 1（锁死分支次序回归）
    assert.match(r.stdout, /action=applied/);
    assert.equal(fs.readFileSync(e.runsLogPath, 'utf8').trim().split('\n').length, 1, '查询运行不追加记录');
  });
});
```

---

---

## 任务卡集（B1，spec Phase B 代码部分）

串行说明：Task 4 → Task 5 → Task 6。Task 4 与 Task 5 相交于 `test/apply.test.mjs` 必须串行；Task 6（README）与两者 Files 不相交，可按并行护栏（≤2 无竞争卡）提前并行，建议串行以保分支 diff 清晰。Task 4/5 前置 = Task 1-3（B0）已落地。

### Task 4 — install.mjs generatePlist 追加 `--trigger launchd` + generatePlist 断言扩展（tier A）

- **Files**：`install.mjs`（ProgramArguments 数组）；`test/apply.test.mjs`（:1552 用例改名 + 新增断言）
- **依赖/并行**：前置 Task 1-3；与 Task 5 相交于 test 文件 → 串行第 4 位
- **TDD 次序**：先落 4b 测试断言（红：generatePlist 尚无 `--trigger`）→ 再落 4a 生产（绿）。既有断言 :1556 的正则以 `<string>--if-due</string>` 结尾且不锚定行尾，改动后仍匹配（spec 风险项已核）。
- **验收**：焦点 `node --test --test-name-pattern "generatePlist" test/apply.test.mjs` 全过；`npm test` → `# tests 132 / # pass 132 / # fail 0`（增断言不增用例）

#### 4a 生产代码 — `install.mjs` ProgramArguments 段替换

锚原文（generatePlist 模板串内，:60-63，唯一）：

```xml
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(scriptPath)}</string>
    <string>--if-due</string>
  </array>
```

替换为：

```xml
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(scriptPath)}</string>
    <string>--if-due</string>
    <string>--trigger</string>
    <string>launchd</string>
  </array>
```

（:69-70 StandardOut/ErrPath 重定向不动，spec Exclusions。）

#### 4b 测试代码 — `test/apply.test.mjs` generatePlist 用例两处

**改动 ① — 用例名更新**。锚原文（:1552，唯一）：

```js
  test('StartInterval=300 + Label + ProgramArguments=[node, apply.mjs, --if-due] + 日志路径', () => {
```

替换为：

```js
  test('StartInterval=300 + Label + ProgramArguments=[node, apply.mjs, --if-due, --trigger launchd] + 日志路径', () => {
```

**改动 ② — 新增断言**。锚原文（:1556，唯一）：

```js
    assert.match(xml, /<string>\/fake\/node\/bin\/node<\/string>\n    <string>\/fake\/tool\/apply\.mjs<\/string>\n    <string>--if-due<\/string>/);
```

替换为：

```js
    assert.match(xml, /<string>\/fake\/node\/bin\/node<\/string>\n    <string>\/fake\/tool\/apply\.mjs<\/string>\n    <string>--if-due<\/string>/);
    assert.match(xml, /<string>--if-due<\/string>\n    <string>--trigger<\/string>\n    <string>launchd<\/string>/);
```

### Task 5 — hooks/model-schedule-apply.sh 追加 `--trigger hook` + hook stub 断言扩展（tier A）

- **Files**：`hooks/model-schedule-apply.sh`（:13 单行）；`test/apply.test.mjs`（:1639 用例改名 + 新增断言）
- **依赖/并行**：前置 Task 4；串行第 5 位
- **TDD 次序**：先落 5b 测试断言（红：stub 入参尚无 `--trigger hook`）→ 再落 5a 生产（绿）。`>>` 重定向与 `|| true` 不动（spec Exclusions）。
- **验收**：焦点 `node --test --test-name-pattern "hook" test/apply.test.mjs` 全过；`npm test` → `# tests 132 / # pass 132 / # fail 0`

#### 5a 生产代码 — `hooks/model-schedule-apply.sh` :13 行替换

锚原文（:13，唯一）：

```bash
"$NODE_BIN" "$SCRIPT_DIR/apply.mjs" --if-due >>"$SCRIPT_DIR/logs/hook.out.log" 2>>"$SCRIPT_DIR/logs/hook.err.log" || true
```

替换为：

```bash
"$NODE_BIN" "$SCRIPT_DIR/apply.mjs" --if-due --trigger hook >>"$SCRIPT_DIR/logs/hook.out.log" 2>>"$SCRIPT_DIR/logs/hook.err.log" || true
```

#### 5b 测试代码 — `test/apply.test.mjs` hook script 用例两处

**改动 ① — 用例名更新**。锚原文（:1639，唯一）：

```js
  test('node-path 存在 → 用该 node 执行 apply.mjs --if-due，logs 目录自动创建', () => {
```

替换为：

```js
  test('node-path 存在 → 用该 node 执行 apply.mjs --if-due --trigger hook，logs 目录自动创建', () => {
```

**改动 ② — 新增断言**。锚原文（:1645-1648，三行 existsSync 上下文保证唯一——第二个 hook 用例 :1658-1660 无 existsSync 行）：

```js
    const logged = fs.readFileSync(stubLog, 'utf8');
    assert.match(logged, /apply\.mjs/);
    assert.match(logged, /--if-due/);
    assert.ok(fs.existsSync(path.join(toolDir, 'logs', 'hook.out.log')));
```

替换为：

```js
    const logged = fs.readFileSync(stubLog, 'utf8');
    assert.match(logged, /apply\.mjs/);
    assert.match(logged, /--if-due/);
    assert.match(logged, /--trigger hook/);
    assert.ok(fs.existsSync(path.join(toolDir, 'logs', 'hook.out.log')));
```

### Task 6 — README.md + README.en.md 同步（tier B，文档机械转写）

- **Files**：`README.md`；`README.en.md`（均不改代码/测试）
- **依赖/并行**：Files 与 Task 4/5 不相交，可并行；建议串行第 6 位
- **卡性质（TDD 说明）**：纯文档卡，TDD 豁免（AGENTS.md IMPLEMENT 例外：文档）；验收 = 正负 grep 断言 + 语义核对
- **验收**：见 6c 验证命令；`npm test` 不受影响仍 `# tests 132 / # pass 132 / # fail 0`

#### 6a 生产代码 — README.md 六处替换（每处给唯一锚原文 + 完整目标文本）

**改动 ① — 用法行**。锚原文（:98，唯一）：

```
node apply.mjs [--config <path>] [--status] [--dry-run] [--force] [--if-due]
```

替换为：

```
node apply.mjs [--config <path>] [--status] [--dry-run] [--force] [--if-due] [--logs [-n <N>]] [--trigger <name>]
```

**改动 ② — Flag 表**（含 --status/--dry-run 两行「不写入任何文件」现状修正——B0 后它们会写 runs.jsonl）。锚原文（:101-107 整表，唯一）：

```
| Flag | Behavior |
|---|---|
| `--config <path>` | 日程文件路径。默认：脚本所在目录下的 `schedule.json`。`~` 会被展开。 |
| `--status` | 打印时区、当前模式、期望模式、可用性以及当前快照。不写入任何文件。 |
| `--dry-run` | 打印将要发生更改的 JSON 报告 `{ desiredMode, available, changes }`。不写入任何文件。 |
| `--force` | 即使没有差异也重新应用目标值（仅限目标模式；其他情况无操作）。 |
| `--if-due` | 仅在记录的模式与期望模式不同时执行。由 launchd 和 hook 使用；否则打印 `no mode change`。 |
```

替换为：

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
```

**改动 ③ — Logs & state 表加一行**。锚原文（:154，唯一）：

```
| `logs/` | `launchd.out.log` / `launchd.err.log`（launchd 运行）、`hook.out.log` / `hook.err.log`（SessionStart hook 运行）。 |
```

替换为：

```
| `logs/` | `launchd.out.log` / `launchd.err.log`（launchd 运行）、`hook.out.log` / `hook.err.log`（SessionStart hook 运行）。 |
| `logs/runs.jsonl` | 每次运行追加一条 JSON 记录（schema `zcode-model-schedule/run-log/v1`：时间、触发源、窗口判定、可用性、action、变更明细、耗时、退出码）；达到 1 MiB 轮转为 `runs.jsonl.1`（保留一份）。记录只含错误类型与代码，绝不含 API key 或错误消息。 |
```

**改动 ④ — 重装提示**。锚原文（:156，唯一）：

```
损坏的 `state.json` 被视为"未切换"（stderr 上输出 `[warn]`），因此工具可通过重新评估日程自我修复。
```

替换为：

```
损坏的 `state.json` 被视为"未切换"（stderr 上输出 `[warn]`），因此工具可通过重新评估日程自我修复。

升级到带触发标注的版本后，重新运行 `node install.mjs`（launchd）与 `node install.mjs --register-hook`（SessionStart hook）以更新 `--trigger` 实参；未重装的存量触发在运行记录中仍标为 `manual`。
```

**改动 ⑤ — Quick Start 注释行现状修正**（--dry-run 注释与 B0 后行为矛盾）。锚原文（:54，唯一）：

```
# 3. 预览将发生哪些更改（不写入任何文件）
```

替换为：

```
# 3. 预览将发生哪些更改（除写入 logs/runs.jsonl 运行记录外不写任何文件）
```

#### 6b 生产代码 — README.en.md 六处替换（与 6a 同构）

**改动 ① — 用法行**。锚原文（:98，唯一）：

```
node apply.mjs [--config <path>] [--status] [--dry-run] [--force] [--if-due]
```

替换为：

```
node apply.mjs [--config <path>] [--status] [--dry-run] [--force] [--if-due] [--logs [-n <N>]] [--trigger <name>]
```

**改动 ② — Flag 表**。锚原文（:101-107 整表，唯一）：

```
| Flag | Behavior |
|---|---|
| `--config <path>` | Path to the schedule file. Default: `schedule.json` in the script's own directory. `~` is expanded. |
| `--status` | Print timezone, current mode, desired mode, availability, and the active snapshot. Writes nothing. |
| `--dry-run` | Print a JSON report `{ desiredMode, available, changes }` of what would change. Writes nothing. |
| `--force` | Re-apply the target values even when nothing differs (target mode only; no-op otherwise). |
| `--if-due` | Act only when the recorded mode differs from the desired mode. Used by launchd and the hook; prints `no mode change` otherwise. |
```

替换为：

```
| Flag | Behavior |
|---|---|
| `--config <path>` | Path to the schedule file. Default: `schedule.json` in the script's own directory. `~` is expanded. |
| `--status` | Print timezone, current mode, desired mode, availability, and the active snapshot. Writes nothing except the `logs/runs.jsonl` run record. |
| `--dry-run` | Print a JSON report `{ desiredMode, available, changes }` of what would change. Writes nothing except the `logs/runs.jsonl` run record. |
| `--force` | Re-apply the target values even when nothing differs (target mode only; no-op otherwise). |
| `--if-due` | Act only when the recorded mode differs from the desired mode. Used by launchd and the hook; prints `no mode change` otherwise. |
| `--logs [-n <N>]` | Inspect run logs: print the latest N entries (default 10), newest first, as one-line summaries from `logs/runs.jsonl` (including the `.1` rotated file). The query itself does not write to the run log. |
| `--trigger <name>` | Trigger annotation, stored in the run record's `trigger` field. launchd installs pass `launchd`, the SessionStart hook passes `hook`; default `manual`. |
```

**改动 ③ — Logs & state 表加一行**。锚原文（:154，唯一）：

```
| `logs/` | `launchd.out.log` / `launchd.err.log` (launchd runs), `hook.out.log` / `hook.err.log` (SessionStart hook runs). |
```

替换为：

```
| `logs/` | `launchd.out.log` / `launchd.err.log` (launchd runs), `hook.out.log` / `hook.err.log` (SessionStart hook runs). |
| `logs/runs.jsonl` | One JSON record appended per run (schema `zcode-model-schedule/run-log/v1`: time, trigger, window decision, availability, action, change details, duration, exit code); rotated to `runs.jsonl.1` at 1 MiB (one backup kept). Records contain only error types and codes — never API keys or error messages. |
```

**改动 ④ — 重装提示**。锚原文（:156，唯一）：

```
A corrupted `state.json` is treated as "not switched" (with a `[warn]` on stderr), so the tool self-heals by re-evaluating the schedule.
```

替换为：

```
A corrupted `state.json` is treated as "not switched" (with a `[warn]` on stderr), so the tool self-heals by re-evaluating the schedule.

After upgrading to a version with trigger annotations, re-run `node install.mjs` (launchd) and `node install.mjs --register-hook` (SessionStart hook) to update the `--trigger` arguments; existing installs that are not re-installed keep recording `manual`.
```

**改动 ⑤ — Quick Start 注释行现状修正**。锚原文（:54，唯一）：

```
# 3. Preview what would change (writes nothing)
```

替换为：

```
# 3. Preview what would change (writes nothing except the logs/runs.jsonl run record)
```

#### 6c 验证命令（worktree 根执行；文档卡用正负 grep，无测试代码）

```bash
# 正向：两份 README 新内容均存在
grep -c -- '--logs' README.md README.en.md        # 各 ≥2（用法行 + flag 行）
grep -c -- '--trigger' README.md README.en.md     # 各 ≥2（用法行 + flag 行 + zh 提示句）
grep -cF 'logs/runs.jsonl' README.md README.en.md # 各 ≥3（CLI 表 2 行 + Quick Start 注释 + Logs 表行）
grep -c 'run-log/v1' README.md README.en.md       # 各 =1
grep -cE '1 MiB|1MiB' README.md README.en.md      # 各 =1
grep -c 'install.mjs --register-hook' README.md README.en.md  # 各 ≥2（install 表 + 提示句）

# 负向：旧行为描述清零（B0 后 --status/--dry-run 会写 runs.jsonl；-i 覆盖 en Quick Start 小写 writes nothing）
grep -nF '不写入任何文件' README.md                # 0 命中（exit 1 = 无匹配，预期）
grep -inF 'writes nothing' README.en.md           # 0 命中（exit 1 = 无匹配，预期）
```

grep 断言全中 + `npm test` 仍 132 pass → 卡过。

## B0 Self-Review（自查结果，2026-11-03）

1. **spec coverage（B0 范围）**：spec Files #1（lib/run-log.mjs 全 5 导出）→ Task 1；#2（apply.mjs :31/:45/:30/:123 全部要求 + 字段写入点 + action 映射 + --logs 分支）→ Task 2；#7 Phase A 部分（parseArgs 清单 7 项 → Task 2b；run-log 单元清单 5 项 → Task 1b；E2E 清单 11 项 → Task 3 全覆盖：首次切换/二次 if-due/availability 失败/md 破坏 exit 1/并发双进程/--dry-run/--status 改名/--trigger launchd/--logs -n 1/无记录，另加 spec 正文「坏 schedule 也能查」用例）→ 全命中，无遗漏。B1 项（install/hook/README）不在本段，符合分段约定。
2. **placeholder scan**：0。三卡生产/测试代码均为完整可转写文本；无 TODO/省略号/「参照实现」类指令描述。机械复核：grep 全文仅 838 行自查描述句本身命中这三个词；26 个 js 代码块中 8 个自包含块（lib/run-log.mjs 全文、测试追加块、parseArgs 全文、collectChangesSafe、main 全文、parseArgs describe 全块、readRunRecords、--status 用例）逐个 `node --check` 全过（其余块为函数体局部替换片段，含 `return`/`});` 收口，独立检查不适用，属预期）。
3. **type consistency**：record 15 字段名与 spec 骨架逐一一致；`changes: Array|null`（formatRunRecord 兼容数组/标量/null）；`opts` 新键 `trigger:string('manual')/logs:boolean/lines:positive-int` 与 parseArgs/main/测试三方一致；`availability:string(reason)|null`；`exitCode:number|`；`inWindow:boolean`；`stateMode:'original'|'target'`（loadState 归一，锚 lib/state.mjs:30）。
4. **可落盘性**：每处改动给出唯一锚原文（引号逐字）+ 完整目标文本；结构变更（main 重构、:1141 改名、parseArgs 整块替换）按整块替换给出，executor 无需设计决策；改动 ④ 的空 catch、扩展①的 `'message' in null` 恒真断言均附行内理由。
5. **锚点实测（本次 dispatch 全部 Read/grep 核对）**：apply.mjs :31/:45-67/:75/:83/:123/:133-134/:145/:151-153/:164/:172/:216-223 ✓；test/apply.test.mjs :510-523（appendHistory 无 mode 断言）/ :990-1011 / :1014-1086（setupE2E/watched）/ :1141-1151 / :1166-1189 / :1201-1217 / :1283-1293 / :1302-1373（Step 2 注释锚）/ :1443-1485 / :1509-1522 / :1524-1536（追加锚）/ :1543-1560 / :1639-1649 ✓；lib/config.mjs:8（SCHEDULE_SCHEMA）✓；lib/availability.mjs:21（err.code ?? err.name 策略）✓；lib/apply-core.mjs:6-12（LockBusyError，code='LOCK_BUSY'）/ :160-164（appendHistory 不动）✓；lib/state.mjs:13-30（emptyState.mode='original'，record.stateMode 取值依据）✓；.gitignore:1 `logs/` ✓；package.json:10 test script ✓；baseline `npm test` = 114 pass / 0 fail ✓。

**B0 决策记录（spec 内延伸，供 B-final 审查）**：
- D1：`record.availability` 写入点除 spec 列明的 :151 外，扩至 status（:138 对应位）与 dry-run（:162 对应位）——avail 值已在手、零额外 IO，覆盖 Goal「每次运行含可用性」；不触碰任何 watched 断言。若 B-final 否决，删两行即回退。
- D2：validation 失败路径 `record.error = { type:'validation', code:null }`——spec 的 summarizeError 仅定义 lock/runtime（针对异常对象）；该路径无异常对象，但 exit 1 记录 error 为空不可观测，故用显式字面量。acceptance 不覆盖此路径，B-final 可复核。
- D3：卡结构取 3 卡（prompt 建议的三关注点），Task 3 定位为纯测试锁定卡以保证每卡结束时全量绿（G1/G9 的卡级 gate），TDD red 证据由 Task 1/2 卡内承担（见各卡 TDD 次序）。

## B-final Self-Review（全量自查，2026-11-03，覆盖 Task 1-6 全卡）

1. **spec coverage（Phase A+B 全量核对）**：
   - Files #1（lib/run-log.mjs，5 导出）→ Task 1；#2（apply.mjs：USAGE/parseArgs/RUN_LOG_PATH/main 重构/字段写入点/action 映射/--logs 分支）→ Task 2；#3（install.mjs :62 后追加 --trigger launchd，:69-70 重定向不动）→ Task 4；#4（hook :13 追加 --trigger hook，`>>` 与 `|| true` 不动）→ Task 5；#5/#6（README.md / README.en.md：CLI reference 加 --logs/--trigger、Logs & state 表加 runs.jsonl + 1 MiB 轮转 + 重装提示）→ Task 6；#7（test/apply.test.mjs 全部新增测试）→ Task 1b/2b/3/4b/5b。
   - Acceptance 清单逐项：parseArgs 7 项 → Task 2b；run-log 单元 5 项 → Task 1b；E2E 11 项 → Task 3；install/hook 2 项 → Task 4b/5b（spec 原文即「新增断言」非新增用例）；回归项（appendHistory 零改动、既有 stdout/stderr 断言原样）→ G2/G6 约束 + 每卡全量绿验收。
   - Risks 逐条落卡：存量 plist/hook 无 --trigger → 归 manual（README 重装提示 Task 6 改动④ + E2E `--trigger launchd` 覆盖标注通道）；并发轮转竞态 → spec 明示可接受（.1 少一代），单行 append 原子性沿用 history.jsonl 同款 O_APPEND 保证（Task 3 扩展⑤断言 2 行）；--status/--dry-run 从零写入变为写 runs.jsonl → :1141 用例改名（Task 3 3b）+ README 旧表述清零（Task 6 改动②/⑤：CLI 表 2 行 + 两份 README Quick Start 注释行，spec 未点名但「文档写现状」必需，特此登记）；[warn] 降级可能掩盖权限问题 → G3 + install.mjs:92 已 mkdir（spec 已核）；1 MiB+1 份 ≈ 5-10 天取舍 → README 表行说明（Task 6 改动③）；collectChanges 复用多打 [warn] → 既有用例 assert.match 子串风格不破坏（Task 2 保持 :83 行为不变）。
   - Exclusions 逐条未越界：未改 plist StandardOut/ErrPath 重定向、未改 hook `>>` 重定向、未压缩轮转文件、未加日志级别、未动 history.jsonl 及其写入方、无 dashboard/--logs 过滤参数/新依赖/schedule schema 与 state.json 改动。
2. **placeholder scan**：全文件 0 真命中（TODO/FIXME/省略号等仅出现在自查描述句自身）。B0 段 8 个自包含块 node --check 全过（首轮已验）；B1/B-final 段新增锚全部 grep -cF 实测唯一（install `<string>--if-due</string>`、hook `--if-due >>`、两份 README 用法行/`logs/` 表行/`state.json` 段、test :1552/:1639 用例名与 :1645-1648 四行上下文块，均 =1）；5b 改动② 五行完整 JS 语句序列 `node --check` 通过；4a 为模板字符串内部片段、6a/6b 为纯文本，均以唯一锚原文 + 完整目标文本给出，无指令描述替代代码。
3. **type consistency（跨 6 卡）**：record 15 字段（Task 2 骨架 = Task 3 断言读取 = spec 骨架）；`trigger` 三个来源值域一致：parseArgs 缺省 `'manual'`（Task 2）、Task 3 E2E 断言 `'launchd'`/`'hook'`/`'manual'`、Task 4 plist 传 `launchd`、Task 5 hook 传 `hook`、README 描述三者（Task 6）；plist XML 实参序列 `--if-due --trigger launchd` 与 E2E `--trigger launchd` 断言同构；hook argv `--if-due --trigger hook` 与 stub 断言 `/--trigger hook/` 同构；`-n` 默认 10（parseArgs lines:10 = README「默认 10」）；轮转阈值 1 MiB（RUN_LOG_MAX_BYTES = 1024*1024 = README「1 MiB」）。
4. **锚点实测（本 resume 段新增核对）**：install.mjs 全文 Read（:40 generatePlist 签名、:58-63 ProgramArguments、:69-70 重定向、:92 mkdirSync LOGS_DIR）✓；hooks/model-schedule-apply.sh 全文 Read（:13 单行，:14 注释行）✓；README.md :85-169 Read（:98 用法行、:101-107 Flag 表、:146-156 Logs & state）✓；README.en.md :93-162 Read（同构区段）✓；test/apply.test.mjs :1543-1662 首轮已 Read（:1552/:1556/:1639/:1645-1648 锚与唯一性核对，:1658-1660 无 existsSync 佐证锚选取）✓。B0 段锚点实测见上方 B0 Self-Review 第 5 项。
5. **累计测试预期数**：baseline 实测 114 pass / 0 fail（21 suites）→ Task 1 +10 = 124 → Task 2 +4 = 128 → Task 3 +4 = **132** → Task 4/5 增断言不增用例、Task 6 纯文档 → 最终 `npm test` 预期 **# tests 132 / # pass 132 / # fail 0 / # suites 22**（Task 1 新增 1 个 describe：21→22）。CI（node --test，macos-latest）同预期。

**B1/B-final 决策记录（供 reviewer 复核）**：
- D4：Task 6 除 spec 点名的 --logs/--trigger 行与 Logs 表外，同步修正 README 中 --status/--dry-run 的「不写入任何文件 / writes nothing」表述（zh :54/:104-105 三处、en :54/:104-105 三处，grep 实测命中数）——B0 后该表述与行为矛盾，属「文档写现状」必要同步而非 scope 扩张；负向 grep 断言以清零为准（-i 覆盖小写形态）。
- D5：Task 5 只在 :1639 用例加 `--trigger hook` 断言、:1651 回退用例不动（spec 点名 :1639）；:1645-1648 四行上下文锚保证唯一性（:1660 同串 `/--if-due/` 无 existsSync 行可区分）。
- D6：Task 4/5 各自用例名同步更新（写入现状），既有正则断言不锚定结尾故无需改动——spec 风险项「:1552 既有正则仍匹配」已核（:1556 正则止于 `--if-due</string>`）。
- D7：runs.jsonl 表行落在 `logs/` 行之后而非之前（最小 diff，logs/ 锚行原文不动）。
