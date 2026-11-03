# 2026-11-03 E2E 测试隔离缺陷修复

## Goal
修复 `test/apply.test.mjs` 的 `setupE2E` 把整个项目目录（含 launchd 真实运行时写入的 `logs/runs.jsonl`）复制进沙箱，导致本地 main 11 个 E2E 子测试失败、而干净目录全绿的隔离缺陷，使「无论源目录有无运行时文件，测试结果一致」。

## Files to Change
- `test/apply.test.mjs:1208` `setupE2E()` — 给 `fs.cpSync(TOOL_ROOT, toolDir, { recursive: true })` 加 `filter` 回调，排除运行时产物与无关大目录。
- `test/apply.test.mjs:1252` `setupE2E()` return 前 — 加防回归断言：沙箱内 `logs/` 不存在。
- `test/apply.test.mjs:1175` `TOOL_ROOT` 定义处（不改，仅确认 `path.resolve` 后为项目根，filter 相对路径判定基于它）。

不改 `readRunRecords`（`test/apply.test.mjs:1198`）：`:1797` 用例显式依赖「文件不存在」，修复后沙箱内 `logs/runs.jsonl` 不存在，该用例仍成立。

## Acceptance Criteria
1. 本地 main（有 41 行真实 `logs/runs.jsonl`）跑 `npm test` → 167 pass / 0 fail。
2. 干净目录（worktree/CI，无运行时文件）跑 `npm test` → 167 pass / 0 fail。
3. 两环境结果一致（167/0），消除环境依赖。
4. 防回归断言生效：若有人改坏 filter（把 `logs` 复制进沙箱），`setupE2E` 立即抛错，测试红。
5. `test/apply.test.mjs:1797`（`--logs 无记录 → existsSync === false`）与 `:1789`/`:1807`（恰 2 行 / 恰 1 行）用例在本地与干净目录均绿。

## Risks
- `filter` 相对路径判定错误（如根目录自身被误排除）→ 整个复制失败。规避：filter 对 `path.relative(TOOL_ROOT, src) === ''` 的根目录显式放行。
- `filter` 排除 `logs` 目录本身而非仅其内容 → `logs/` 目录被跳过，`logs/runs.jsonl` 自然不复制（cpSync 递归时目录被 filter 拦截即整棵子树跳过）。防回归断言覆盖此点。
- 若未来测试需读 `docs/` 或 `schedule.example.json`（`:1818` 已读 `schedule.example.json`），排除 `docs` 会破坏用例 → `docs` 不排除。
- `readRunRecords` 对不存在文件 `readFileSync` throw 的行为被 `:1797` 依赖，不能改。

## Exclusions
- 不改 `readRunRecords` 的健壮性（文件不存在 throw 是 `:1797` 依赖的既有行为）。
- 不改 `dashboard.test.mjs`（已确认无 cpSync 同类缺陷，仅 mkdirSync 写夹具）。
- 不改 `.gitignore`、`package.json`、任何生产源码。
- 不新增依赖。

## 实现（TDD：先红后绿）

### Step 1 — 加防回归断言（旧实现上红）
在 `test/apply.test.mjs:1252` return 前插入：

```js
  // 防回归：沙箱不得携带真实运行时产物（logs/runs.jsonl 等），否则本地 main 会因真实 41 行日志污染 E2E 计数断言
  assert.equal(fs.existsSync(path.join(toolDir, 'logs')), false, '沙箱不得包含真实运行时 logs/ 目录');
```

旧实现（无 filter）下此断言红（本地 main 有 `logs/`）。

### Step 2 — 改 cpSync 加 filter（绿）
`test/apply.test.mjs:1208` before：

```js
  fs.cpSync(TOOL_ROOT, toolDir, { recursive: true }); // STATE_PATH/HISTORY_PATH/LOCK_PATH 随 TOOL_DIR 落沙箱
```

after：

```js
  // 只复制源码与测试所需文件，排除真实运行时产物（logs/state/history/lock）与无关大目录（.git/node_modules/.worktrees）
  // filter 用相对路径判定：根目录自身放行，命中排除清单的路径整棵子树跳过（cpSync 递归时目录被拦截即不进入）
  const EXCLUDED = new Set(['logs', 'state.json', 'history.jsonl', '.apply.lock', '.git', 'node_modules', '.worktrees']);
  fs.cpSync(TOOL_ROOT, toolDir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(TOOL_ROOT, src);
      if (rel === '') return true; // 根目录自身必须放行
      return !EXCLUDED.has(rel.split(path.sep)[0]);
    },
  }); // STATE_PATH/HISTORY_PATH/LOCK_PATH 随 TOOL_DIR 落沙箱（沙箱内新建，非复制）
```

### 验证命令
- 本地 main：`npm test` → 167 pass / 0 fail。
- 干净目录（worktree 或 CI）：`npm test` → 167 pass / 0 fail。
- 焦点验证：`node --test --test-name-pattern="--logs" test/apply.test.mjs` → 相关 E2E 用例绿。

## 排除清单（filter 排除项）
| 路径 | 理由 |
|------|------|
| `logs` | 真实运行时写入 `runs.jsonl`（当前 41 行），直接污染 E2E 计数断言；测试不需要 |
| `state.json` | 运行时状态产物，测试不需要（沙箱内新建） |
| `history.jsonl` | 运行时历史产物，测试不需要（沙箱内新建） |
| `.apply.lock` | 运行时锁文件，测试不需要（沙箱内新建） |
| `.git` | 大、拖慢复制，测试不需要 |
| `node_modules` | 若存在则大、拖慢复制，测试不需要（无依赖） |
| `.worktrees` | 若存在则大、拖慢复制，测试不需要 |
| `docs` | 不排除：体积小，且测试读 `schedule.example.json`（`:1818`）等源码文件，排除有破坏风险 |