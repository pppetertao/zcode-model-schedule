# 2026-11-04 dashboard launchd 常驻（简化路径 spec，即计划）

## Goal

让本地 dashboard（dashboard.mjs，127.0.0.1:8787）通过第二个 launchd LaunchAgent（`com.zcode.model-schedule-dashboard`，RunAtLoad + KeepAlive）随登录自动常驻、崩溃自动重启，端口经 `install.mjs --dashboard-port <n>` 持久化到 plist。

**方案取舍**：dashboard.mjs 已支持 `--port`（dashboard.mjs:36-42），故采用方案 A——**dashboard.mjs 零改动**，端口经 dashboard plist `ProgramArguments` 显式传 `--port <n>`（显式来源，无环境变量隐式来源，CLI 契约完全兼容）。备选 B（dashboard.mjs 读环境变量）需改生产代码且引入隐式来源，弃；备选 C（wrapper 脚本）多余，弃。

## Files to Change

1. `/Users/peter/Documents/project/zcode-model-schedule/install.mjs` — 唯一生产文件，11 处改动（锚点见下）：
   - `install.mjs:13-20` 常量区 — 新增 `DASHBOARD_LABEL = 'com.zcode.model-schedule-dashboard'`、`DASHBOARD_PLIST_PATH`（`~/Library/LaunchAgents/<label>.plist`）、`DASHBOARD_SCRIPT`（`<TOOL_DIR>/dashboard.mjs`）；更新 `USAGE`。
   - `install.mjs:40 generatePlist` 之后 — 新增导出纯函数 `generateDashboardPlist(nodePath, scriptPath, port, uid)`（签名风格对齐现有 `generatePlist`；既有 `generatePlist` 签名**不变**，防 apply.test.mjs:1825-1857 回归）。
   - `install.mjs:79 bootoutIgnoreFailure(uid)` — 加 `label` 参数 → `bootoutIgnoreFailure(uid, label)`。
   - `install.mjs:88 install(schedulePath)` — 签名改 `install(schedulePath, { dashboardPort = 8787, noDashboard = false } = {})`，默认同时装两个 agent。
   - `install.mjs:106 uninstall()` — 循环清理两个 agent（bootout + 删 plist）。
   - `install.mjs:118 dryRun(schedulePath)` — 签名改 `dryRun(schedulePath, { dashboardPort = 8787, noDashboard = false } = {})`，默认打印两个 plist。
   - `install.mjs:123 parseInstallArgs` — 新增 `--dashboard-port <n>`（校验同 dashboard.mjs:39：1..65535 整数）与 `--no-dashboard`。
   - `install.mjs:145-157` main 分支 — 传 `opts` 给 install/dryRun。
2. `/Users/peter/Documents/project/zcode-model-schedule/test/install-dashboard.test.mjs` — 新建；锚点 = 导出符号 `generateDashboardPlist` / `parseInstallArgs` / `dryRun`（纯函数测试，不触碰真实 launchd）。
3. `/Users/peter/Documents/project/zcode-model-schedule/README.md` — 4 处：Dashboard 章节（:69-83）加「常驻（launchd）」小节；install.mjs CLI reference（:135-149）加 `--dashboard-port` / `--no-dashboard` 行并更新 `--uninstall` 与用法行；Logs & state 表格（:172）加 `dashboard.out.log` / `dashboard.err.log`；Uninstall 章节（:200-211）说明同时移除两个 agent。

## Acceptance Criteria

自动化（CI 可跑，无 launchd 权限）：
- `node --test test/install-dashboard.test.mjs` → exit 0 全绿。
- `npm test` → exit 0（既有 generatePlist 测试不回归）。
- `node install.mjs --dry-run | grep -c 'com.zcode.model-schedule-dashboard'` → 输出 `1`。
- `node install.mjs --dry-run --no-dashboard | grep -c 'com.zcode.model-schedule-dashboard'` → 输出 `0`。
- `node install.mjs --dry-run --dashboard-port 9000 | grep -A1 -- '--port'` → 含 `<string>9000</string>`。
- `node install.mjs --dashboard-port abc` → exit 1，stderr 含 `--dashboard-port 需要 1..65535`。

手动（真实 launchd，登录会话；**先停手工进程**）：
- `kill 74857`（当前手工 dashboard）→ `node install.mjs` → `launchctl print gui/$(id -u)/com.zcode.model-schedule-dashboard` 显示 state=running → `curl -s http://127.0.0.1:8787/api/status` 返回 200 JSON（schema v1）。
- `kill -9 <dashboard pid>` → ≤10 秒内 `curl -s http://127.0.0.1:8787/api/status` 恢复 200（KeepAlive 自动重启）。
- `node install.mjs --uninstall` → 两个 plist 均删除；`launchctl print gui/$(id -u)/com.zcode.model-schedule-dashboard` 报错（agent 不存在）。

## Risks

- **KeepAlive + EADDRINUSE 重启循环**：dashboard.mjs:157-160 对端口占用 `process.exit(1)`，launchd 会每 ~10 秒重启并持续刷 `dashboard.err.log`。部署前必须停手工进程（当前 pid 74857）；README 已写注意事项。端口被其他程序占用同理，用 `--dashboard-port` 换端口重装。
- 既有 `generatePlist` 签名不变（apply.test.mjs:1825-1857 依赖），本 spec 不改。
- `dryRun` 输出从单 plist 变双 plist：README 同步描述；无既有测试断言其精确 stdout。
- uninstall 删两个 plist：旧版仅装过调度 agent 的用户跑新版 uninstall，dashboard plist 不存在 → 打印「跳过删除」，兼容。
- 升级：重跑 `node install.mjs` 对两个 agent 均 bootout 旧实例再 bootstrap（幂等，沿用 install.mjs:97-98 模式），端口变更生效。
- launchd KeepAlive 重启有内置 10 秒节流，不会打爆 CPU。

## Exclusions

- 不改 dashboard.mjs（零改动；端口经 plist ProgramArguments 显式传入）。
- 不改 apply.mjs / hooks/ / lib/ 任何文件。
- 不做 launchd 真实 bootstrap 的自动化测试（约束明确禁止）。
- 不做登录会话/开机自启的自动化验证。
- 不引入新依赖；不做 dashboard 认证/HTTPS/非 loopback 监听。

---

## 生产代码（install.mjs 改动单元，executor 逐 hunk 转写）

**Hunk 1 — 常量区（install.mjs:13-20 原地增改）**：
```js
const LABEL = 'com.zcode.model-schedule';
const DASHBOARD_LABEL = 'com.zcode.model-schedule-dashboard';
const DEFAULT_CONFIG = path.join(TOOL_DIR, 'schedule.json');
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const DASHBOARD_PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${DASHBOARD_LABEL}.plist`);
const APPLY_SCRIPT = path.join(TOOL_DIR, 'apply.mjs');
const DASHBOARD_SCRIPT = path.join(TOOL_DIR, 'dashboard.mjs');
const NODE_PATH_FILE = path.join(TOOL_DIR, 'node-path');
const LOGS_DIR = path.join(TOOL_DIR, 'logs');
const LAUNCHD_PATH_ENV = '/usr/local/bin:/usr/bin:/bin';
const USAGE = '用法: node install.mjs [--config <path>] [--dry-run] [--uninstall] [--register-hook] [--dashboard-port <n>] [--no-dashboard]';
```

**Hunk 2 — 新增 `generateDashboardPlist`（generatePlist 之后，install.mjs:76 与 bootoutIgnoreFailure 之间）**：
```js
// dashboard agent plist：RunAtLoad 登录拉起 + KeepAlive 崩溃重启；端口经 ProgramArguments 显式传入（CLI 契约兼容，dashboard.mjs 零改动）
export function generateDashboardPlist(nodePath, scriptPath, port, uid) {
  const logsDir = path.join(path.dirname(scriptPath), 'logs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${DASHBOARD_LABEL} (gui/${uid}) -->
<plist version="1.0"><dict>
  <key>Label</key><string>${DASHBOARD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(scriptPath)}</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(logsDir)}/dashboard.out.log</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logsDir)}/dashboard.err.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${LAUNCHD_PATH_ENV}</string></dict>
</dict></plist>
`;
}
```

**Hunk 3 — `bootoutIgnoreFailure` 加 label 参数（install.mjs:79-85）**：
```js
function bootoutIgnoreFailure(uid, label) {
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' });
  } catch {
    // launchctl bootout 目标未加载时的报错无后续影响（非敏感 + 幂等语义）
  }
}
```

**Hunk 4 — `install` 双 agent（install.mjs:88-103 整体替换）**：
```js
export function install(schedulePath, { dashboardPort = 8787, noDashboard = false } = {}) {
  const schedule = loadSchedule(schedulePath);
  const uid = process.getuid();
  const nodePath = process.execPath;
  const plist = generatePlist(schedule, nodePath, APPLY_SCRIPT, uid);
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.writeFileSync(PLIST_PATH, plist, { mode: 0o644 });
  fs.writeFileSync(NODE_PATH_FILE, `${nodePath}\n`, { mode: 0o644 });
  bootoutIgnoreFailure(uid, LABEL); // 幂等：bootout 旧实例再 bootstrap
  execFileSync('launchctl', ['bootstrap', `gui/${uid}`, PLIST_PATH], { stdio: 'inherit' });
  console.log(`installed: ${PLIST_PATH}`);
  console.log(`bootstrapped: gui/${uid}/${LABEL}`);
  console.log(`node-path: ${NODE_PATH_FILE}`);
  if (!noDashboard) {
    fs.writeFileSync(DASHBOARD_PLIST_PATH, generateDashboardPlist(nodePath, DASHBOARD_SCRIPT, dashboardPort, uid), { mode: 0o644 });
    bootoutIgnoreFailure(uid, DASHBOARD_LABEL);
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, DASHBOARD_PLIST_PATH], { stdio: 'inherit' });
    console.log(`installed: ${DASHBOARD_PLIST_PATH}`);
    console.log(`bootstrapped: gui/${uid}/${DASHBOARD_LABEL}`);
  }
  return PLIST_PATH;
}
```

**Hunk 5 — `uninstall` 双 agent（install.mjs:106-115 整体替换）**：
```js
export function uninstall() {
  const uid = process.getuid();
  for (const [label, plistPath] of [[LABEL, PLIST_PATH], [DASHBOARD_LABEL, DASHBOARD_PLIST_PATH]]) {
    bootoutIgnoreFailure(uid, label);
    if (fs.existsSync(plistPath)) {
      fs.unlinkSync(plistPath);
      console.log(`removed: ${plistPath}`);
    } else {
      console.log(`plist 不存在（跳过删除）: ${plistPath}`);
    }
  }
}
```

**Hunk 6 — `dryRun` 双 plist（install.mjs:118-121 整体替换）**：
```js
export function dryRun(schedulePath, { dashboardPort = 8787, noDashboard = false } = {}) {
  const schedule = loadSchedule(schedulePath);
  process.stdout.write(generatePlist(schedule, process.execPath, APPLY_SCRIPT, process.getuid()));
  if (!noDashboard) {
    process.stdout.write('\n');
    process.stdout.write(generateDashboardPlist(process.execPath, DASHBOARD_SCRIPT, dashboardPort, process.getuid()));
  }
}
```

**Hunk 7 — `parseInstallArgs`（install.mjs:123-143 整体替换）**：
```js
function parseInstallArgs(argv) {
  const opts = { config: DEFAULT_CONFIG, dryRun: false, uninstall: false, registerHook: false, dashboardPort: 8787, noDashboard: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`--config 需要一个路径参数\n${USAGE}`);
      opts.config = value;
      i += 1;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--uninstall') {
      opts.uninstall = true;
    } else if (arg === '--register-hook') {
      opts.registerHook = true;
    } else if (arg === '--dashboard-port') {
      const value = argv[i + 1];
      const n = Number(value);
      if (value === undefined || !Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`--dashboard-port 需要 1..65535 的整数\n${USAGE}`);
      }
      opts.dashboardPort = n;
      i += 1;
    } else if (arg === '--no-dashboard') {
      opts.noDashboard = true;
    } else {
      throw new Error(`未知参数: ${arg}\n${USAGE}`);
    }
  }
  return opts;
}
```

**Hunk 8 — main 分支（install.mjs:145-157 整体替换）**：
```js
if (isMainModule()) {
  const opts = parseInstallArgs(process.argv.slice(2));
  if (opts.uninstall) {
    uninstall();
  } else if (opts.dryRun) {
    dryRun(opts.config, opts);
  } else {
    install(opts.config, opts);
  }
  if (opts.registerHook) {
    registerHook(); // 写真实 ~/.zcode/cli/config.json（默认路径），用户显式 opt-in
  }
}
```

## 测试代码（新建 test/install-dashboard.test.mjs，完整文件）

```js
// test/install-dashboard.test.mjs — dashboard launchd agent：plist 生成纯函数 + 参数解析 + dryRun（node --test；不触碰真实 launchd）
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateDashboardPlist, parseInstallArgs, dryRun } from '../install.mjs';

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeTmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `msched-dash-install-${label}-`));
}

function baseSchedule() {
  return {
    $schema: 'zcode-model-schedule/v2',
    timezone: 'Asia/Shanghai',
    target: { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', reasoningLevel: 'max' },
    agents: [{ name: 'Explore', kind: 'builtin' }],
    dayWindows: [{ days: [1, 2, 3, 4, 5], from: '08:50', to: '23:10' }],
    availability: { enabled: false },
  };
}

describe('generateDashboardPlist', () => {
  test('默认端口 8787：Label/ProgramArguments/RunAtLoad/KeepAlive/日志路径', () => {
    const xml = generateDashboardPlist('/fake/node/bin/node', '/fake/tool/dashboard.mjs', 8787, 501);
    assert.match(xml, /<key>Label<\/key><string>com\.zcode\.model-schedule-dashboard<\/string>/);
    assert.match(xml, /<string>\/fake\/node\/bin\/node<\/string>\n    <string>\/fake\/tool\/dashboard\.mjs<\/string>\n    <string>--port<\/string>\n    <string>8787<\/string>/);
    assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(xml, /<key>KeepAlive<\/key><true\/>/);
    assert.match(xml, /<key>StandardOutPath<\/key><string>\/fake\/tool\/logs\/dashboard\.out\.log<\/string>/);
    assert.match(xml, /<key>StandardErrorPath<\/key><string>\/fake\/tool\/logs\/dashboard\.err\.log<\/string>/);
    assert.match(xml, /gui\/501/);
  });

  test('自定义端口 9000 写入 ProgramArguments', () => {
    const xml = generateDashboardPlist('/fake/node', '/fake/tool/dashboard.mjs', 9000, 501);
    assert.match(xml, /<string>--port<\/string>\n    <string>9000<\/string>/);
    assert.doesNotMatch(xml, /8787/);
  });

  test('nodePath/scriptPath 含 & 时 xmlEscape（无裸 &）', () => {
    const xml = generateDashboardPlist('/fake/node&bin', '/fake/tool&x/dashboard.mjs', 8787, 501);
    assert.equal(xml.includes('<string>/fake/node&bin</string>'), false);
    assert.match(xml, /\/fake\/node&amp;bin/);
    assert.match(xml, /\/fake\/tool&amp;x\/dashboard\.mjs/);
  });

  test('不含调度 agent 专属键（StartCalendarInterval/StartInterval）', () => {
    const xml = generateDashboardPlist('/fake/node', '/fake/tool/dashboard.mjs', 8787, 501);
    assert.doesNotMatch(xml, /StartCalendarInterval/);
    assert.doesNotMatch(xml, /StartInterval/);
  });
});

describe('parseInstallArgs', () => {
  test('默认 dashboardPort=8787、noDashboard=false', () => {
    assert.deepEqual(parseInstallArgs([]), {
      config: path.join(TOOL_ROOT, 'schedule.json'),
      dryRun: false,
      uninstall: false,
      registerHook: false,
      dashboardPort: 8787,
      noDashboard: false,
    });
  });

  test('--dashboard-port 9000 → dashboardPort=9000；--no-dashboard → noDashboard=true；同给时并存', () => {
    assert.equal(parseInstallArgs(['--dashboard-port', '9000']).dashboardPort, 9000);
    assert.equal(parseInstallArgs(['--no-dashboard']).noDashboard, true);
    const both = parseInstallArgs(['--dashboard-port', '9000', '--no-dashboard']);
    assert.equal(both.dashboardPort, 9000);
    assert.equal(both.noDashboard, true);
  });

  test('--dashboard-port 缺值 / 非整数 / 0 / 越界 → throw', () => {
    assert.throws(() => parseInstallArgs(['--dashboard-port']), /--dashboard-port/);
    assert.throws(() => parseInstallArgs(['--dashboard-port', 'abc']), /--dashboard-port/);
    assert.throws(() => parseInstallArgs(['--dashboard-port', '0']), /--dashboard-port/);
    assert.throws(() => parseInstallArgs(['--dashboard-port', '65536']), /--dashboard-port/);
  });

  test('既有参数不回归：--config/--dry-run/--uninstall/--register-hook；未知参数 → throw', () => {
    const opts = parseInstallArgs(['--config', '/tmp/x.json', '--dry-run', '--uninstall', '--register-hook']);
    assert.equal(opts.config, '/tmp/x.json');
    assert.equal(opts.dryRun, true);
    assert.equal(opts.uninstall, true);
    assert.equal(opts.registerHook, true);
    assert.throws(() => parseInstallArgs(['--bogus']), /未知参数/);
  });
});

describe('dryRun', () => {
  test('默认打印两个 plist（调度 + dashboard）；--no-dashboard 只打印调度 plist', () => {
    const dir = makeTmpDir('dryrun');
    const configPath = path.join(dir, 'schedule.json');
    fs.writeFileSync(configPath, JSON.stringify(baseSchedule()));
    const out = [];
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
    try {
      dryRun(configPath, {});
      dryRun(configPath, { noDashboard: true });
    } finally {
      process.stdout.write = origWrite;
    }
    assert.match(out[0], /com\.zcode\.model-schedule<\/string>/);
    assert.match(out[0], /com\.zcode\.model-schedule-dashboard<\/string>/);
    assert.match(out[1], /com\.zcode\.model-schedule<\/string>/);
    assert.doesNotMatch(out[1], /com\.zcode\.model-schedule-dashboard/);
  });
});
```

## 验证命令

```bash
node --test test/install-dashboard.test.mjs          # 新测试全绿
npm test                                             # 全量回归（含既有 generatePlist 测试）
node install.mjs --dry-run | grep -c 'com.zcode.model-schedule-dashboard'          # → 1
node install.mjs --dry-run --no-dashboard | grep -c 'com.zcode.model-schedule-dashboard'  # → 0
node install.mjs --dry-run --dashboard-port 9000 | grep -A1 -- '--port'            # 含 <string>9000</string>
node install.mjs --dashboard-port abc; echo "exit=$?"                              # exit=1，stderr 含校验信息
```

手动部署（真实 launchd，先停手工进程避免 EADDRINUSE 重启循环）：
```bash
kill 74857   # 停当前手工 dashboard（占 8787）
node install.mjs --dashboard-port 8787
launchctl print gui/$(id -u)/com.zcode.model-schedule-dashboard | head -20   # state=running
curl -s http://127.0.0.1:8787/api/status | head -c 200                       # 200 JSON
kill -9 $(pgrep -f 'dashboard.mjs' | head -1); sleep 12; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/status  # KeepAlive 重启后 200
node install.mjs --uninstall   # 两个 plist 删除；launchctl print ...dashboard 报错
```

## README 改动（4 处，文本级）

1. **Dashboard 章节（:69-83）末尾追加「常驻（launchd）」小节**：`node install.mjs` 默认同时安装 dashboard LaunchAgent（`com.zcode.model-schedule-dashboard`）：RunAtLoad 登录自动拉起、KeepAlive 崩溃自动重启，端口默认 8787。换端口 `node install.mjs --dashboard-port <n>`（写入 plist 持久生效）；只装调度 agent `node install.mjs --no-dashboard`；日志 `logs/dashboard.out.log` / `logs/dashboard.err.log`；停用 `node install.mjs --uninstall`（同时移除两个 agent）或仅停 dashboard `launchctl bootout gui/$(id -u)/com.zcode.model-schedule-dashboard`；**安装前若已有手工启动的 dashboard 占用端口，先停掉再 install，否则 KeepAlive 会反复重启并刷错误日志**。
2. **install.mjs CLI reference（:135-149）**：用法行更新为含 `[--dashboard-port <n>] [--no-dashboard]`；(no flags) 描述改为「完整安装：调度 agent + dashboard agent」；`--uninstall` 描述改为「卸载调度与 dashboard 两个 launchd agent 并删除对应 plist（如不存在则优雅跳过）」；新增两行：`--dashboard-port <n>`（dashboard 端口，1..65535 整数，默认 8787，写入 dashboard plist 的 ProgramArguments）、`--no-dashboard`（跳过 dashboard agent 安装，只装调度 agent；与 `--dashboard-port` 同给时以 `--no-dashboard` 为准）。
3. **Logs & state 表格（:172）**：`logs/` 行追加 `dashboard.out.log` / `dashboard.err.log`（dashboard launchd 运行）。
4. **Uninstall 章节（:200-211）**：第 1 步注释改为「移除 launchd agent（调度 + dashboard 两个）」。
