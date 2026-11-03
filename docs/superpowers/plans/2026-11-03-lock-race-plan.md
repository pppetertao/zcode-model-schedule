# PLAN — 修复 apply 锁竞态（acquireLock token 化 + releaseLock 定向删除 + 确定性竞态回归）

- **plan**: `docs/superpowers/plans/2026-11-03-lock-race-plan.md`
- **spec**: `docs/superpowers/specs/2026-11-03-lock-race.md`（2026-11-03，5 section 齐全）
- **worktree**: `.worktrees/lock-race`（分支 `fix/lock-race`，HEAD=`f532f27`）
- **日期**: 2026-11-03
- **卡数**: 3（全 A 档 → executor；严格串行：卡 1 → 卡 2 → 卡 3，三卡同改 `test/apply.test.mjs`）
- **目标**: 修复并发 apply 偶发 exit 1（根因：acquireLock read/stat 竞态窗口 crash + 误删活跃锁 + releaseLock 无条件 unlink）；验收 `node --test test/*.test.mjs` → **167 pass（基线 155 + 新增 12）/ 0 fail**

## Global Constraints（全卡适用）

1. **基线（2026-11-03 于 f532f27 实测）**：`node --test test/*.test.mjs` → `# tests 155 / # pass 155 / # fail 0`（duration ≈3.0s）。三卡完成后 167 pass / 0 fail。
2. **严格串行**：三卡都改 `test/apply.test.mjs` 与 `lib/apply-core.mjs`，禁止并行派发；卡 N 开工前提 = 卡 N-1 随卡 VERIFY 绿（RTC STATUS + 焦点/全量测试计数吻合）。
3. **TDD 次序（每卡内）**：先转写测试 → 跑焦点测试取 RED 证据（贴 stdout/exit code）→ 再转写生产代码 → 全量测试取 GREEN gate。A 档代码已写死，executor 无任何设计决策空间；发现锚点不符 → STOP 报告，不边设计边执行。
4. **生产代码 = 逐字转写 spec**：卡 1 生产代码标注「逐字转写 spec Files #1（spec :11 import + :13-67 代码块）」；卡 2 标注「逐字转写 spec Files #2（spec :72-85 代码块）」与「spec Files #3（spec :89 两行）」。唯一允许的偏差：spec 内两处 `catch {}` 行内注释按本 PLAN 补足自证文案（吞掉什么 / 为何无其他路径 / 可抛语句数），代码结构零改动。
5. **禁区**：不改 README；不改 state/history/run-log 语义与退出码映射（0/1/2，`[locked]`/`applied` 文案逐字不变）；不改 `apply.mjs` 主流程结构（仅 :249/:294 两行）；不引入任何依赖；不改 `test/apply.test.mjs:1519`（双进程）与 `:1569`（并发 ×3）用例代码。
6. **无 lint 脚本**：`package.json` 仅 `test`/`dashboard` 两个 script，无 eslint 配置文件 → VERIFY gate 只有测试套件。
7. **既有用例数不变**：三卡均不增删既有 155 用例（卡 2 只改 4 个既有用例的方法体行，测试名与断言语义不变）；新增 8+3+1=12。
8. **清理约定**：卡 1 阶段 `releaseLock` 尚未改签名，新增用例需要清理锁文件时一律 `fs.unlinkSync(lockPath)`，禁止调 `releaseLock`。临时目录用既有 `makeTmpDir(label)` helper（`test/apply.test.mjs:22-24`，mkdtemp 于 `os.tmpdir()`），与既有用例一致不做目录级清理。
9. **提交**：每卡一个 commit，Conventional Commits：卡 1 `fix: acquireLock 返回 token，竞态消失重试、不再误删活跃锁`；卡 2 `fix: releaseLock 按 token 定向删除，apply.mjs 调用点随签名更新`；卡 3 `test: 补确定性竞态回归用例（fs monkey-patch 注入 read/stat 窗口）`。

---

## 卡 1（A）：acquireLock token 化重写 + 竞态守恒用例 1-8

**Files**：`lib/apply-core.mjs`（import + :166-208 全量替换）；`test/apply.test.mjs`（describe `'acquireLock / releaseLock'` 内追加 8 用例）

**锚点（f532f27 实测）**：
- `lib/apply-core.mjs:3-4`：`import fs from 'node:fs';` / `import path from 'node:path';`
- `lib/apply-core.mjs:166-208`：旧 `acquireLock`（:166 注释 + :167-208 函数体）
- `test/apply.test.mjs:525-569`：`describe('acquireLock / releaseLock', ...)`，含 5 个既有用例；:569 为 describe 收尾 `});`
- `test/apply.test.mjs:302-313`：apply-core import 块已含 `LockBusyError, acquireLock, releaseLock`（无需新增 import）

### 步骤 1 — 先写测试（RED）

在 `test/apply.test.mjs` 的 `describe('acquireLock / releaseLock', ...)` 内、既有用例「活锁（pid 存在 + mtime 新鲜）→ LockBusyError」（:562-568）之后、:569 `});` 之前，追加以下 8 个用例（整块插入；无新 import，`fs`/`path`/`acquireLock`/`LockBusyError` 均已在文件头导入）：

```js
  // ── 锁竞态修复新增用例（spec 2026-11-03-lock-race §4 用例 1-8；无 sleep，锁文件直接构造）──
  test('不可读+fresh（目录 EISDIR）→ LockBusyError 且目标不删除【旧代码 unlink 被吞 → open EISDIR crash】', () => {
    const lockPath = makeTmpDir('lock-eisdir'); // 用目录本身当锁路径 → openSync('wx') EEXIST → readFileSync EISDIR
    assert.throws(() => acquireLock(lockPath), (err) => err instanceof LockBusyError && err.code === 'LOCK_BUSY');
    assert.equal(fs.existsSync(lockPath), true); // reap 不动 EISDIR → 目录仍在
  });

  test('不可读+陈旧（目录 EISDIR + mtime -11min）→ LockBusyError（reap 失败不 crash）', () => {
    const lockPath = makeTmpDir('lock-eisdir-stale');
    const oldTime = Date.now() - 660000; // 11 分钟前
    fs.utimesSync(lockPath, new Date(oldTime), new Date(oldTime));
    assert.throws(() => acquireLock(lockPath), (err) => err instanceof LockBusyError && err.code === 'LOCK_BUSY');
    assert.equal(fs.existsSync(lockPath), true); // unlinkSync 对目录非 ENOENT → busy 而非 crash
  });

  test('空文件（0 字节）+fresh → LockBusyError 且文件仍在', () => {
    const lockPath = path.join(makeTmpDir('lock-empty'), '.apply.lock');
    fs.writeFileSync(lockPath, '', { mode: 0o644 });
    assert.throws(() => acquireLock(lockPath), (err) => err instanceof LockBusyError && err.code === 'LOCK_BUSY');
    assert.equal(fs.existsSync(lockPath), true);
  });

  test('非 JSON 内容 garbage +fresh → LockBusyError 且文件仍在', () => {
    const lockPath = path.join(makeTmpDir('lock-garbage'), '.apply.lock');
    fs.writeFileSync(lockPath, 'garbage\n', { mode: 0o644 });
    assert.throws(() => acquireLock(lockPath), (err) => err instanceof LockBusyError && err.code === 'LOCK_BUSY');
    assert.equal(fs.existsSync(lockPath), true);
  });

  test('非 JSON garbage + mtime >10min → 接管成功返回 token', () => {
    const lockPath = path.join(makeTmpDir('lock-garbage-stale'), '.apply.lock');
    fs.writeFileSync(lockPath, 'garbage\n', { mode: 0o644 });
    const oldTime = Date.now() - 660000;
    fs.utimesSync(lockPath, new Date(oldTime), new Date(oldTime));
    const token = acquireLock(lockPath);
    assert.equal(typeof token, 'string');
    assert.ok(token.length > 0);
    fs.unlinkSync(lockPath); // 卡 1 阶段 releaseLock 未改签名 → 直接 unlink 清理本用例自建的锁
  });

  test('JSON 锁（活 pid + foreign token）+fresh → LockBusyError', () => {
    const lockPath = path.join(makeTmpDir('lock-json-live'), '.apply.lock');
    const holder = { pid: process.pid, token: 'holder-token', startedAt: new Date().toISOString() };
    fs.writeFileSync(lockPath, JSON.stringify(holder) + '\n', { mode: 0o644 });
    assert.throws(() => acquireLock(lockPath), (err) => err instanceof LockBusyError && err.code === 'LOCK_BUSY');
    assert.equal(fs.existsSync(lockPath), true);
  });

  test('JSON 锁（pid 99999 已死）+fresh → 解析 pid 判死接管【旧代码不解析 JSON pid → 误判 busy】', () => {
    const lockPath = path.join(makeTmpDir('lock-json-dead'), '.apply.lock');
    const staleHolder = { pid: 99999, token: 'dead-holder', startedAt: new Date().toISOString() };
    fs.writeFileSync(lockPath, JSON.stringify(staleHolder) + '\n', { mode: 0o644 });
    const token = acquireLock(lockPath);
    assert.equal(typeof token, 'string');
    fs.unlinkSync(lockPath);
  });

  test('JSON 锁（活 pid）+ mtime >10min → 陈旧接管返回 token', () => {
    const lockPath = path.join(makeTmpDir('lock-json-stale'), '.apply.lock');
    const holder = { pid: process.pid, token: 'stale-holder', startedAt: new Date().toISOString() };
    fs.writeFileSync(lockPath, JSON.stringify(holder) + '\n', { mode: 0o644 });
    const oldTime = Date.now() - 660000;
    fs.utimesSync(lockPath, new Date(oldTime), new Date(oldTime));
    const token = acquireLock(lockPath);
    assert.equal(typeof token, 'string');
    fs.unlinkSync(lockPath);
  });
```

**插入锚点（Edit old_string，:562-569 整块，测试名行唯一）**：

```js
  test('活锁（pid 存在 + mtime 新鲜）→ LockBusyError', () => {
    const dir = makeTmpDir('lock-live');
    const lockPath = path.join(dir, '.apply.lock');
    // 用当前进程 PID 写锁，mtime 为当前时间
    fs.writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o644 });
    assert.throws(() => acquireLock(lockPath), (err) => err instanceof LockBusyError && err.code === 'LOCK_BUSY');
  });
});
```

→ new_string = 上述整块原样 + 8 个新用例 + `});`（即插在活锁用例 `});` 之后、describe `});` 之前）。

**RED 验证（此时生产未改）**：

```
$ node --test test/apply.test.mjs 2>&1 | tail -8
预期：# fail 5（新用例 1/2/5/7/8 红）
```

旧实现红因（spec :109 指定 1/2/7 必红；5/8 因新增 token 契约断言 `typeof token === 'string'` 亦红，旧实现返回 `undefined`）：
- 用例 1/2：旧 :177-179 读失败 → `unlinkSync` EISDIR/EPERM 被 `catch {}` 吞 → :180 `openSync('wx')` 对目录抛 EISDIR（裸错误非 LockBusyError）→ 断言失败。
- 用例 5/8：旧实现接管成功但返回 `undefined` → `typeof token` 断言失败。
- 用例 7：旧实现 `content.match(/^(\d+)/)` 对 `{"pid":99999,...}` 首字符 `{` 不匹配 → pid=null → 非 stale → LockBusyError 抛出（用例预期接管成功）→ 断言失败。
- 用例 3/4/6 设计为守恒用例（旧实现亦绿），不作 RED gate。

### 步骤 2 — 再写生产（GREEN）

**改动 1：import（逐字转写 spec :11）** — `lib/apply-core.mjs:3-4` 后追加一行：

Before:
```js
import fs from 'node:fs';
import path from 'node:path';
```
After:
```js
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
```

**改动 2：:166-208 全量替换（逐字转写 spec Files #1，spec :13-67 代码块；仅 spec :35 的 `catch {}` 行内注释按 Global Constraints #4 补足自证）** — Edit old_string 为现 :166-208 整块（`// O_EXCL 抢锁（wx）；...` 注释行起至旧 acquireLock 收尾 `}`），new_string：

```js
const STALE_MS = 600000; // 10min，保留（README.md:181 已文档化）

// 锁状态探测：gone=文件消失（竞态正常态，重试）；unparsable=空/损坏/不可读(EACCES/EISDIR)；
// locked={pid,mtimeMs,legacy?}（JSON 或旧格式 '^\d+$'）
function readLockState(lockPath) {
  let content;
  try { content = fs.readFileSync(lockPath, 'utf8'); }
  catch (err) {
    if (err.code === 'ENOENT') return { kind: 'gone' };
    try { return { kind: 'unparsable', mtimeMs: fs.statSync(lockPath).mtimeMs }; }
    catch (e2) { if (e2.code === 'ENOENT') return { kind: 'gone' }; throw e2; }
  }
  let st;
  try { st = fs.statSync(lockPath); }
  catch (err) { if (err.code === 'ENOENT') return { kind: 'gone' }; throw err; } // ← 原 :183 crash 点，现归入 gone
  const t = content.trim();
  if (t !== '') {
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object' && obj.pid != null)
        return { kind: 'locked', pid: Number(obj.pid), mtimeMs: st.mtimeMs };
    } catch {} // 吞掉 JSON.parse 的 SyntaxError：锁内容非 JSON（旧格式 pid 行/损坏数据）→ 落到下方旧格式正则判定而非 crash；无其他路径可达——JSON.parse 对 string 输入只可能 SyntaxError，且 try 内 JSON.parse 之后的判型/属性访问/return 不可能抛；try 内可抛语句仅 JSON.parse 一条
  }
  if (/^\d+$/.test(t)) return { kind: 'locked', pid: Number(t), mtimeMs: st.mtimeMs, legacy: true };
  return { kind: 'unparsable', mtimeMs: st.mtimeMs };
}

// 仅 ESRCH 判死；EPERM（跨用户存在）视为活
function pidDead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (err) { return err.code === 'ESRCH'; }
}

export function acquireLock(lockPath) {
  const token = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }) + '\n';
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd;
    try { fd = fs.openSync(lockPath, 'wx'); }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const s = readLockState(lockPath);
      if (s.kind === 'gone') continue;                    // 持有方刚释放 → 重试
      const reap = (Date.now() - s.mtimeMs) > STALE_MS || (s.kind === 'locked' && pidDead(s.pid));
      if (!reap) throw new LockBusyError(lockPath);       // fresh 一律忙——含不可读/损坏（不再 unlink，决策②）
      try { fs.unlinkSync(lockPath); }
      catch (err2) { if (err2.code === 'ENOENT') continue; throw new LockBusyError(lockPath); } // reap 不动（EISDIR/EACCES）→ 忙而非 crash
      continue;
    }
    try { fs.writeFileSync(fd, payload); } finally { fs.closeSync(fd); }
    return token;
  }
  throw new LockBusyError(lockPath); // 3 次都被抢先/消失 → exit 2
}
```

### 步骤 3 — VERIFY（GREEN gate）

```
$ node --test test/*.test.mjs 2>&1 | tail -8
预期：# tests 163 / # pass 163 / # fail 0（基线 155 + 新增 8；既有用例零改动全绿，apply.mjs E2E 不受影响——:249 忽略返回值、旧 releaseLock(:211-218) 本卡未动）
$ node --test test/apply.test.mjs --test-name-pattern '不可读|空文件|garbage|JSON 锁' 2>&1 | tail -8
预期：新增 8 用例全 pass
```

---

## 卡 2（A）：releaseLock(lockPath, token) 定向删除 + apply.mjs 调用点 + 用例 9-11 + 既有 4 用例改造

**Files**：`lib/apply-core.mjs`（:210-218 替换，卡 1 后实际行号约 :222-230，以内容锚点定位）；`apply.mjs`（:249、:294）；`test/apply.test.mjs`（新增用例 9-11 + 改造既有用例 1-4 的调用行）

**锚点（f532f27 实测；apply-core 行号卡 1 后有漂移，executor 以内容定位）**：
- `lib/apply-core.mjs:210-218`（原始行号）：`// 释放锁；ENOENT...` 注释 + 旧 `releaseLock(lockPath)`
- `apply.mjs:249`：`    acquireLock(LOCK_PATH); // LockBusyError → 下方 catch 落记录后 exit 2`（全文件唯一调用点，grep 实测）
- `apply.mjs:293-295`：`} finally {` / `      releaseLock(LOCK_PATH);` / `    }`（全文件唯一，grep 实测）
- `test/apply.test.mjs` describe 内既有调用行（原始行号）：:528/:530/:531/:532（用例 1）、:537（用例 2）、:549/:550（用例 3）、:558/:559（用例 4）；:562-568 用例 5（活锁）无 releaseLock 调用，**不改**

### 步骤 1 — 先写测试（RED）

**1a. 新增用例 9-11**：插入位置 = describe 收尾 `});` 之前、卡 1 用例 8（`test('JSON 锁（活 pid）+ mtime >10min → 陈旧接管返回 token', ...)`）之后。Edit 锚点：卡 1 用例 8 的收尾三行 + describe `});`：

```js
    const token = acquireLock(lockPath);
    assert.equal(typeof token, 'string');
    fs.unlinkSync(lockPath);
  });
});
```

new_string = 上述 + 以下 3 用例 + `});`：

```js
  // ── releaseLock token 化用例（spec 2026-11-03-lock-race §4 用例 9-11）──
  test('releaseLock(path, 正确 token) → true 且锁文件删除', () => {
    const lockPath = path.join(makeTmpDir('lock-rel'), '.apply.lock');
    const token = acquireLock(lockPath);
    assert.equal(releaseLock(lockPath, token), true);
    assert.equal(fs.existsSync(lockPath), false);
  });

  test('他人接管后原持有者 releaseLock(tokenA) → false 不抛、他人锁原样保留（决策①④）', () => {
    const lockPath = path.join(makeTmpDir('lock-takeover'), '.apply.lock');
    const tokenA = acquireLock(lockPath);
    // 模拟旧 bug 场景：锁被他人接管（外部 unlink + 写入他人 JSON 锁）
    fs.unlinkSync(lockPath);
    const other = { pid: process.pid, token: 'other-token', startedAt: new Date().toISOString() };
    fs.writeFileSync(lockPath, JSON.stringify(other) + '\n', { mode: 0o644 });
    assert.equal(releaseLock(lockPath, tokenA), false); // token 不符 → false 静默，不删
    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'other-token'); // 他人锁原样
  });

  test('releaseLock(path) 缺 token → TypeError（签名契约）【旧代码不抛】', () => {
    const lockPath = path.join(makeTmpDir('lock-notoken'), '.apply.lock');
    assert.throws(() => releaseLock(lockPath), TypeError);
  });
```

**1b. 改造既有 4 用例（测试名不变；旧格式用例 3/4 的 legacy 逻辑不动，只改调用行）**：

用例 1（原 :526-533）Before:
```js
  test('占用中再次抢锁 → LockBusyError；释放后可重新抢锁', () => {
    const lockPath = path.join(makeTmpDir('lock'), '.apply.lock');
    acquireLock(lockPath);
    assert.throws(() => acquireLock(lockPath), (err) => err instanceof LockBusyError && err.code === 'LOCK_BUSY');
    releaseLock(lockPath);
    acquireLock(lockPath); // 不抛即通过
    releaseLock(lockPath);
  });
```
After:
```js
  test('占用中再次抢锁 → LockBusyError；释放后可重新抢锁', () => {
    const lockPath = path.join(makeTmpDir('lock'), '.apply.lock');
    const token = acquireLock(lockPath);
    assert.throws(() => acquireLock(lockPath), (err) => err instanceof LockBusyError && err.code === 'LOCK_BUSY');
    releaseLock(lockPath, token);
    const token2 = acquireLock(lockPath); // 不抛即通过
    releaseLock(lockPath, token2);
  });
```

用例 2（原 :535-538）Before:
```js
  test('releaseLock 幂等（锁不存在再释放不抛）', () => {
    const lockPath = path.join(makeTmpDir('lock'), '.apply.lock');
    releaseLock(lockPath);
  });
```
After（spec :92「追加 `assert.equal(releaseLock(lockPath, 'any-token'), false)`」——原裸调用在新签名下会 TypeError，故替换为断言式）:
```js
  test('releaseLock 幂等（锁不存在再释放不抛）', () => {
    const lockPath = path.join(makeTmpDir('lock'), '.apply.lock');
    assert.equal(releaseLock(lockPath, 'any-token'), false); // 锁不存在 → false 静默，不抛
  });
```

用例 3（原 :541-551，陈旧锁）Before（仅列调用行，其余行不动）:
```js
    // 重抢应成功（删除旧锁并创建新锁）
    acquireLock(lockPath);
    releaseLock(lockPath);
```
After:
```js
    // 重抢应成功（删除旧锁并创建新锁）
    const token = acquireLock(lockPath);
    releaseLock(lockPath, token);
```

用例 4（原 :553-560，死进程活锁）Before（仅调用行）:
```js
    acquireLock(lockPath);
    releaseLock(lockPath);
  });
```
After:
```js
    const token = acquireLock(lockPath);
    releaseLock(lockPath, token);
  });
```
（用例 4 的 Before 含收尾 `  });` 以区别于用例 3 的同文本行；Edit 时用各自测试名行作唯一锚。）

**RED 验证（生产未改，旧 releaseLock 忽略第二参/不抛）**：

```
$ node --test test/apply.test.mjs 2>&1 | tail -8
预期：# fail 4
```
红因：用例 2（改造后）旧实现返回 `undefined ≠ false`；用例 9 旧实现无条件 unlink 且返回 `undefined ≠ true`；用例 10 旧实现无条件 unlink → `existsSync` 断言失败；用例 11 旧实现不抛 TypeError。既有用例 1/3/4 改造行在旧实现下仍绿（旧 releaseLock 忽略多余实参）。其余 162 用例绿。

### 步骤 2 — 再写生产（GREEN）

**改动 1：`lib/apply-core.mjs` releaseLock 重写（逐字转写 spec Files #2，spec :72-85；仅 `catch {}` 注释补足自证）** — 替换旧块（原始 :210-218；卡 1 后行号漂移，Edit 以内容定位）：

Before:
```js
// 释放锁；ENOENT（锁已被释放）为幂等场景，容忍
export function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // ENOENT：锁文件已被并发方释放，无后续影响
  }
}
```
After:
```js
// 返回 boolean=是否实际删除。只删 token 匹配的 JSON 锁；gone/token 不符/旧格式 → false 静默；真实 IO 错误上抛
export function releaseLock(lockPath, token) {
  if (typeof token !== 'string' || token.length === 0)
    throw new TypeError('releaseLock(lockPath, token) 需要 acquireLock 返回的 token');
  let content;
  try { content = fs.readFileSync(lockPath, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  let parsed = null;
  try { parsed = JSON.parse(content.trim()); } catch {} // 吞掉 JSON.parse 的 SyntaxError：锁内容非 JSON（旧格式 pid 行/损坏数据）必非本进程 token 锁 → 落到下方 token 判等返回 false；无其他路径可达——JSON.parse 对 string 输入只可能 SyntaxError；try 内可抛语句仅 JSON.parse 一条
  if (!parsed || typeof parsed !== 'object' || parsed.token !== token) return false; // 他人接管 → 不删（决策①④）
  try { fs.unlinkSync(lockPath); }
  catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  return true;
}
```

**改动 2：`apply.mjs:249`（spec Files #3）**：

Before:
```js
    acquireLock(LOCK_PATH); // LockBusyError → 下方 catch 落记录后 exit 2
```
After:
```js
    const lockToken = acquireLock(LOCK_PATH); // LockBusyError → 下方 catch 落记录后 exit 2
```

**改动 3：`apply.mjs:294`（spec Files #3）**：

Before:
```js
    } finally {
      releaseLock(LOCK_PATH);
    }
```
After:
```js
    } finally {
      releaseLock(LOCK_PATH, lockToken);
    }
```

（`acquireLock` 抛错发生在 :250 `try` 之前 → finally 不会以 undefined token 触发，spec :89 已论证；catch→exit 映射 :297-306 零改动。）

### 步骤 3 — VERIFY（GREEN gate）

```
$ node --test test/*.test.mjs 2>&1 | tail -8
预期：# tests 166 / # pass 166 / # fail 0（163 + 新增 3；既有 155 用例计数不变，4 个用例仅方法体调用行改造）
$ node --test test/apply.test.mjs --test-name-pattern 'acquireLock|releaseLock|锁定|锁文件|锁' 2>&1 | tail -8
预期：describe 'acquireLock / releaseLock' 全部 16 用例（5 既有 + 11 新增）pass
```

---

## 卡 3（A）：确定性竞态回归用例 12（子进程 fs monkey-patch）+ soak ×10

**Files**：`test/apply.test.mjs`（:8 import 扩展 + describe 内新增 1 用例）。生产代码零改动。

**锚点（f532f27 实测）**：
- `test/apply.test.mjs:8`：`import { fileURLToPath } from 'node:url';` → 需扩为 `{ fileURLToPath, pathToFileURL }`（spec :105 要求 test 新增 `pathToFileURL`）
- `spawnSync` 无需新 import：`test/apply.test.mjs:987` 已有 `import { spawnSync, spawn } from 'node:child_process';`，ESM import 全模块提升，:525 的 describe 内直接可用（不新增 import 行，避免死代码）
- 插入位置：describe 收尾 `});` 之前、卡 2 用例 11 之后

### 步骤 1 — import 扩展

Before:
```js
import { fileURLToPath } from 'node:url';
```
After:
```js
import { fileURLToPath, pathToFileURL } from 'node:url';
```

### 步骤 2 — 新增用例 12

Edit 锚点（用例 11 收尾 + describe 收尾）：
```js
  test('releaseLock(path) 缺 token → TypeError（签名契约）【旧代码不抛】', () => {
    const lockPath = path.join(makeTmpDir('lock-notoken'), '.apply.lock');
    assert.throws(() => releaseLock(lockPath), TypeError);
  });
});
```

new_string = 上述 + 以下用例 + `});`：

```js
  // ── 用例 12：原 1/25 flake 的确定性复现（spec §4 用例 12 / §Acceptance）──
  // 子进程 monkey-patch fs.readFileSync：首次读到锁文件后在 read 与 stat 之间 unlink（模拟持有方释放），
  // 旧实现 statSync ENOENT 未捕获 → child exit 1；新实现 gone → 重试 → 自持 → 自释 → exit 0
  test('确定性竞态回归：持有方在 read 与 stat 之间释放 → acquireLock 重试自持（原 1/25 flake）', () => {
    const dir = makeTmpDir('lock-race');
    const lockPath = path.join(dir, '.apply.lock');
    const childPath = path.join(dir, 'race-child.mjs');
    const coreAbs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'apply-core.mjs');
    const childSource = `// race-child.mjs — 竞态注入：模拟持有方在 acquireLock 的 read 与 stat 之间释放锁
import fs from 'node:fs';
const lockPath = ${JSON.stringify(lockPath)};
const coreUrl = ${JSON.stringify(pathToFileURL(coreAbs).href)};
const originalReadFileSync = fs.readFileSync;
let injected = false; // 注入只触发一次：首次读到锁文件即删除，后续读（如 releaseLock 内部）不再干扰
fs.readFileSync = function patchedReadFileSync(p, ...rest) {
  const result = originalReadFileSync(p, ...rest);
  if (!injected && p === lockPath) {
    injected = true;
    try { fs.unlinkSync(lockPath); } catch (e) { if (e.code !== 'ENOENT') throw e; } // 容忍 ENOENT：锁恰已被并发方删除正是被模拟的竞态终态；try 仅一条语句
  }
  return result;
};
const { acquireLock, releaseLock } = await import(coreUrl);
const token = acquireLock(lockPath);
if (typeof token !== 'string' || token.length === 0) {
  console.error('acquireLock 未返回 token:', token);
  process.exit(1);
}
if (releaseLock(lockPath, token) !== true) {
  console.error('releaseLock 应返回 true');
  process.exit(1);
}
`;
    fs.writeFileSync(childPath, childSource, { mode: 0o644 });
    // 预置活 JSON 锁（模拟真实持有方；pid=本测试进程，必活）
    const holder = { pid: process.pid, token: 'holder-token', startedAt: new Date().toISOString() };
    fs.writeFileSync(lockPath, JSON.stringify(holder) + '\n', { mode: 0o644 });
    const r = spawnSync(process.execPath, [childPath], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, `child 应 exit 0, status=${r.status}, stderr=${r.stderr}`);
    assert.equal(fs.existsSync(lockPath), false, 'child 释放后锁文件应不存在');
  });
```

**确定性论证（无 sleep、单线程同步注入）**：child 内 acquireLock attempt 1 → `openSync('wx')` EEXIST（锁在）→ `readLockState` 的 `readFileSync`（被 patch：先返回 JSON 原文，随后 unlink）→ `statSync` ENOENT → `{kind:'gone'}` → `continue` → attempt 2 `openSync('wx')` 成功（已被注入删除）→ 写 payload → 返回 token → `releaseLock(path, token)` 读到自己的 JSON（injected 已 true，二次读不删）→ token 匹配 → unlink → `true` → exit 0。旧实现同一序列在 `statSync` ENOENT 处裸抛 → child exit 1（spec RED 论证，生产已修复后此用例直接 GREEN——本卡无生产改动，RED-on-old 由 spec :105 论证背书，不要求 executor 回滚验证）。

### 步骤 3 — VERIFY（GREEN gate + soak）

```
$ node --test test/*.test.mjs 2>&1 | tail -8
预期：# tests 167 / # pass 167 / # fail 0（166 + 1）
$ fails=0; for i in $(seq 1 10); do node --test test/apply.test.mjs --test-name-pattern '并发' >/dev/null 2>&1 || { fails=$((fails+1)); echo "run $i FAILED"; }; done; echo "soak failures: $fails/10"
预期输出：soak failures: 0/10（spec Acceptance：--test-name-pattern '并发' 命中 :1519 双进程与 :1569 并发 ×3 两用例，重复 10 次全绿）
```

---

## Self-Review（PLAN-B 五项，2026-11-03）

1. **spec coverage**：Files #1（卡 1 生产）✓；Files #2（卡 2 生产）✓；Files #3（卡 2 apply.mjs 两行）✓；Files #4 12 用例逐个落码（卡 1=1-8、卡 2=9-11、卡 3=12）✓；既有 4 用例 5 处 releaseLock 调用行（:530/:532/:537/:550/:559）+ 对应 acquireLock 行（:528/:531/:549/:558）before/after 逐处给出 ✓；Acceptance 167 计数三卡分摊 163/166/167 ✓；soak ×10 命令与预期输出 ✓；Acceptance 的「旧实现必红」清单 1/2/7/10/11/12 全部在 RED 验证节覆盖（10/11 在卡 2 RED，1/2/7 在卡 1 RED，12 由 spec :105 论证背书）✓。
2. **placeholder scan**：0 命中——三卡生产/测试代码均为完整可落盘代码块，无「此处补充/类似地」类指令；用例 12 子进程生成源码全文写死 ✓。
3. **类型一致**：`acquireLock` 成功返回 token（string，randomUUID）✓；`releaseLock` 返回 boolean（true=实际删除）✓；测试断言与签名一致（`typeof token === 'string'`、`assert.equal(releaseLock(...), true|false)`、`assert.throws(..., TypeError)`）✓；`readLockState` 返回 `{kind, pid?, mtimeMs?, legacy?}` 判别联合与生产用法一致 ✓。
4. **锚点实测（本 dispatch 实跑）**：`lib/apply-core.mjs:3-4/:166-208/:210-218` ✓ Read 实测；`apply.mjs:249/:293-295` 唯一调用点 ✓ grep 实测；`test/apply.test.mjs:8/:525-569` describe 边界与 5 处 releaseLock 调用行号 ✓；基线 155 pass ✓ 实跑（`# tests 155 / # pass 155 / # fail 0`）；`spawnSync` 已于 :987 导入 ✓ grep 实测；无 lint 配置 ✓ 实测。
5. **可落盘性**：每卡 Edit 均给出唯一内容锚点（old_string 含唯一测试名行/唯一注释行），卡间行号漂移已声明并以内容定位兜底；卡 1→2→3 串行依赖显式（同文件、releaseLock 签名依赖）；`catch {}` 两处自证文案补足（诚实表述为「可抛语句仅一条」——spec :35 原文「try 仅一条语句」与代码块 2 条语句不符，本 PLAN 保留 spec 代码结构不变、以补足注释如实自证，见 Observations）。

## Observations

- spec :35 注释「try 仅一条语句」与其代码块（try 内 2 条语句：`const obj = ...` + `if...return`）不完全一致；按 Global Constraints #4 以诚实自证文案补足（可抛语句仅 JSON.parse 一条，其余语句不可能抛），代码结构未改。若 reviewer 判需物理拆分 try，回 PLAN 微调（仅影响卡 1 一处 Edit）。
- 卡 1 RED 实际红 5 个（含 5/8 的 token 契约红），多于 spec 必红清单（1/2/7）；spec Acceptance 只约束「必红」下界，多红不违反。
- `pidDead` 用 99999 沿用既有用例（:545/:556）约定；若 CI 环境恰有 pid 99999 进程则用例 7/既有死进程用例同时受影响（既有风险，非本次引入）。
