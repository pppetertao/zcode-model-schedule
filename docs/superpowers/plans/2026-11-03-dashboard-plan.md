# PLAN — 本地 Dashboard（简化路径：3 卡全 A，严格串行）

## Header

- **spec（唯一事实源）**：`docs/superpowers/specs/2026-11-03-dashboard.md`
- **worktree**：`/Users/peter/Documents/project/zcode-model-schedule/.worktrees/dashboard`（分支 `fix/dashboard`，HEAD 2494664）
- **计划文件**：`docs/superpowers/plans/2026-11-03-dashboard-plan.md`
- **计划形态**：简化路径单次 PLAN-B（spec 方案已定死，3 卡 ≤4 → 不分段）
- **baseline 实测（2026-11-03）**：`npm test` → `# tests 132 / # pass 132 / # fail 0`（22 suites）。VERIFY 只对「baseline 绿 → 现在红」负责。
- **测试形态（变更后）**：`package.json` scripts 块（:9-11）由 `"test": "node --test test/apply.test.mjs"` 改为 `"test": "node --test test/*.test.mjs"` + 新增 `"dashboard": "node dashboard.mjs"`（C3）。C1/C2 阶段 package.json 未改，验证用双文件显式命令（见各卡）。注：Node 22 不接受目录参数（`node --test test/` → MODULE_NOT_FOUND），故用 shell glob 展开。
- **测试文件唯一**：`test/dashboard.test.mjs`（新建）。C1 建文件含用例 1-15，C2 追加用例 16-21 → **C1/C2 Files 相交，严格串行**。
- **用例总数恒等**：21 新 + 132 存量 = 153。**禁止增删用例**（增删即破坏 153 验收）。spec 用例清单之外的函数（`parseHHMMLocal` / `tzParts` / `parseArgs`）不设专测：前两者由用例 1-10 间接覆盖（每次 computeNextSwitch/activeWindow 调用都走过），parseArgs 由 C3 冒烟人工覆盖——这是 spec 21 用例清单的既定范围，不是缺口。
- **spec 行文勘误（不改 spec，卡内按此执行）**：spec :32 罗列的区块 id 实为 9 个（`banners` / `clock` / `next-switch` / `mode` / `availability` / `runs` / `history` / `config-summary` / `trigger`），测试逐一断言全部 9 个 + `initial-data`（数据锚点）；spec 用例 8 的 `'00:00'` 即当日分钟数 0（`wallTimeToInstant` 第 4 参为 number 分钟数，`parseHHMMLocal` 产物）。

## Global Constraints

- **G1 TDD 卡内次序**：每卡先落测试（跑红）再落生产（跑绿）；卡结束全量绿，红基线不留到下一卡。
- **G2 固定时区与瞬时**：全部测试 `TZ = 'Asia/Shanghai'`（+08:00 无 DST）；瞬时用固定 ISO 串构造。日历事实（2026 年）：11-02=周一、11-03=周二、11-06=周五、11-07=周六、11-08=周日、11-09=周一。
- **G3 零触真实环境**：测试只用 `fs.mkdtempSync` 临时目录 + 注入（fake `spawnTrigger` / fake `execFileImpl` / 固定 `now`）；**禁止**触达真实 `~/.zcode`、真实 `apply.mjs`、真实网络、固定端口 8787。
- **G4 存量文件零改动**：`apply.mjs` / `lib/apply-core.mjs` / `lib/config.mjs` / `lib/run-log.mjs` / `lib/state.mjs` 一个字节不改（本地复刻正是为此）。
- **G5 零新依赖**：仅 Node 内置模块（`node:fs` / `node:path` / `node:http` / `node:url` / `node:child_process`）；无构建步骤。
- **G6 buildDashboardData 绝不 throw**：schedule/state/runs/history 四路全部降级容错；错误信息只含路径/格式（无凭据，对齐 `lib/availability.mjs:21` 策略）。
- **G7 触发零强制**：触发只走 `node apply.mjs --if-due --trigger dashboard`（同锁/快照/run-log 路径）；**绝不** `--force`、绝无模式覆盖参数；服务请求本身不写 run-log。
- **G8 安全头统一**：所有响应带 `Cache-Control: no-store` + `X-Content-Type-Options: nosniff`；仅绑定 `127.0.0.1`。
- **G9 空 catch 自证**：每处吞异常的空 catch 必须注释 ①吞掉什么 ②为何可容忍 ③try 仅一条语句（照 `lib/run-log.mjs:57-59` 惯例）。
- **G10 验证命令**：
  - C1：`node --test test/apply.test.mjs test/dashboard.test.mjs` → `# tests 147 / # pass 147 / # fail 0`
  - C2：同命令 → `# tests 153 / # pass 153 / # fail 0`
  - C3：`npm test` → `# tests 153 / # pass 153 / # fail 0` + 冒烟命令（见卡内）
- **G11 串行执行**：C1 → C2 → C3，禁止并行（C1/C2 相交于 `test/dashboard.test.mjs`；C2 生产依赖 C1 模块；C3 收编全部测试并全量 verify）。
- **G12 Conventional Commits**：每卡一个 commit（卡内给出 message）；禁 placeholder author。

---

## Card C1 — lib/dashboard.mjs（聚合层 + 模板）+ test/dashboard.test.mjs 用例 1-15（tier A）

- **Files**：`lib/dashboard.mjs`（新建）；`test/dashboard.test.mjs`（新建，本卡只写到用例 15 为止）
- **依赖/并行**：无前置；与 C2 相交于测试文件 → 串行第 1 位
- **TDD 次序**：先落测试（红：`../lib/dashboard.mjs` 不存在，import 失败）→ 再落生产（绿）
- **验收**：焦点断言用例 1-15 全过；`node --test test/apply.test.mjs test/dashboard.test.mjs` → 147 pass / 0 fail

### C1-a 生产代码 — 新建 `lib/dashboard.mjs`（全文，逐字落盘）

```js
// lib/dashboard.mjs — dashboard 只读聚合层 + 内联 HTML 模板（零依赖，可无端口单测）
// spec: docs/superpowers/specs/2026-11-03-dashboard.md
// 本地复刻 parseHHMM（lib/config.mjs:22-29）与 readJsonlLines（lib/run-log.mjs:44-62）：
// 不 import 存量私有函数、不改存量模块（G4）；聚合层绝不 throw（G6，降级渲染）
import fs from 'node:fs';
import { loadSchedule, parseSlotTime } from './config.mjs';
import { loadState } from './state.mjs';
import { readRunLogs } from './run-log.mjs';

export const DASH_SCHEMA = 'zcode-model-schedule/dashboard/v1';

// parseHHMMLocal — 正则与校验逐字照 lib/config.mjs:22-29 parseHHMM（含错误文案）
export function parseHHMMLocal(value, label = 'dayWindows') {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) {
    throw new Error(`schedule ${label} 必须为 HH:MM 格式，实际: ${JSON.stringify(value)}`);
  }
  const [h, m] = value.split(':').map(Number);
  if (h > 23 || m > 59) throw new Error(`schedule ${label} 时间越界: ${value}`);
  return h * 60 + m;
}

// tzParts — 模式照 lib/config.mjs:136-152 parseSlotTime（hourCycle:'h23'），另取 year/month/day
export function tzParts(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(date);
  const pick = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour: Number(pick('hour')),
    minute: Number(pick('minute')),
  };
}

// wallTimeToInstant — 墙钟 → epoch ms（guess + Intl 偏移校正；DST 消失时段 best-effort 取一值，spec Risks）
export function wallTimeToInstant(year, month, day, minutes, timezone) {
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const guess = Date.UTC(year, month - 1, day, hh, mm);
  const p = tzParts(new Date(guess), timezone);
  return guess + (guess - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute));
}

// computeNextSwitch — 14 天边界扫描：每天对每个命中窗口取 from('original')/to('target') 两个候选，
// 取严格晚于 now 的最早者。now 恰在 from 分钟 → from 候选==nowMs 被 `>` 滤除 → 返回当日 to（spec 用例 5）。
// 14 天覆盖每个 weekday ≥2 次 → days 非空（lib/config.mjs:87 已校验）时必非 null（spec 用例 7）。
export function computeNextSwitch(schedule, now = new Date()) {
  const tz = schedule.timezone;
  const nowMs = now.getTime();
  let best = null; // { ms, at, toMode }
  for (let offset = 0; offset < 14; offset++) {
    const inst = new Date(nowMs + offset * 86400000);
    const slot = parseSlotTime(inst, tz);
    const base = tzParts(inst, tz);
    for (const w of schedule.dayWindows) {
      if (!w.days.includes(slot.day)) continue;
      const candidates = [
        { minutes: parseHHMMLocal(w.from, 'dayWindows.from'), toMode: 'original' },
        { minutes: parseHHMMLocal(w.to, 'dayWindows.to'), toMode: 'target' },
      ];
      for (const c of candidates) {
        const ms = wallTimeToInstant(base.year, base.month, base.day, c.minutes, tz);
        if (ms > nowMs && (best === null || ms < best.ms)) {
          best = { ms, at: new Date(ms).toISOString(), toMode: c.toMode };
        }
      }
    }
  }
  return best ? { at: best.at, toMode: best.toMode } : null;
}

// activeWindow — now 命中的窗口；判定条件逐字照 lib/config.mjs:156-164（from<=minutes<to，to 严格不命中）
export function activeWindow(schedule, now = new Date()) {
  const { day, minutes } = parseSlotTime(now, schedule.timezone);
  for (const w of schedule.dayWindows) {
    const from = parseHHMMLocal(w.from, 'dayWindows.from');
    const to = parseHHMMLocal(w.to, 'dayWindows.to');
    if (w.days.includes(day) && from <= minutes && minutes < to) return w;
  }
  return null;
}

// readJsonlLinesLocal — 语义照 lib/run-log.mjs:44-62：ENOENT→[]；坏行跳过；其他读错误向上抛
export function readJsonlLinesLocal(filePath) {
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
      // 吞掉单行 JSON.parse 的 SyntaxError：半截写入/手工损坏行不可恢复，跳过不中断其余记录（try 仅此一条语句）
    }
  }
  return records;
}

// buildDashboardData — 只读幂等、绝不 throw（G6）；schedule 失败 → 窗口系字段全 null + scheduleError
export function buildDashboardData({ configPath, statePath, historyPath, runLogPath, now = new Date() }) {
  // --- schedule（loadSchedule 抛错信息仅含路径/格式，无凭据）---
  let schedule = null;
  let scheduleError = null;
  let timezone = null;
  let inWindow = null;
  let desiredMode = null;
  let activeWin = null;
  let nextSwitch = null;
  let configSummary = null;
  try {
    schedule = loadSchedule(configPath);
    const win = activeWindow(schedule, now);
    timezone = schedule.timezone;
    inWindow = win !== null;
    activeWin = win;
    desiredMode = inWindow ? 'original' : 'target';
    nextSwitch = computeNextSwitch(schedule, now);
    configSummary = { target: schedule.target, agents: schedule.agents, dayWindows: schedule.dayWindows };
  } catch (err) {
    scheduleError = err.message; // 降级：保留路径/格式信息供 #banners 展示，窗口系字段保持 null
  }

  // --- state probe（missing/corrupt 本地判定，不复制 loadState 归一化）---
  let rawState;
  let stateMissing = false;
  let stateCorrupt = false;
  try {
    rawState = fs.readFileSync(statePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      stateMissing = true;
    } else {
      stateCorrupt = true; // 非 ENOENT 读错误（如 EISDIR）按 corrupt 降级：只读观测面绝不 throw
    }
  }
  if (rawState !== undefined) {
    try {
      JSON.parse(rawState);
    } catch {
      // 吞掉 probe 的 JSON.parse SyntaxError：内容损坏 → corrupt 标记；实际状态由下方 loadState 自愈为 original（try 仅此一条语句）
      stateCorrupt = true;
    }
  }
  let state = { mode: 'original', switchedAt: null, lastCheck: null, snapshot: null };
  if (rawState !== undefined) {
    state = loadState(statePath); // rawState 可读已证实，loadState 的读错误路径不可达；损坏由其内部自愈（[warn] + 空态）
  }

  // --- runs/history（读错误降级为空列表；排序语义照 lib/run-log.mjs:67-69）---
  let runs = [];
  try {
    runs = readRunLogs(runLogPath, { limit: 10 });
  } catch (err) {
    // 吞掉 runs.jsonl 读错误（EISDIR 等）：dashboard 为只读观测面，读不到即降级空列表，页面照常渲染（绝不 throw 契约）
    runs = [];
  }
  let history = [];
  try {
    const all = readJsonlLinesLocal(historyPath);
    all.sort((a, b) => String(b.time ?? '').localeCompare(String(a.time ?? '')));
    history = all.slice(0, 10);
  } catch (err) {
    // 吞掉 history.jsonl 读错误（EISDIR 等）：同 runs，降级空列表不阻断渲染（绝不 throw 契约）
    history = [];
  }

  // --- availability（纯配置回显，不做实时探测，spec Exclusions）---
  const av = schedule ? schedule.availability : null;
  const availability = {
    enabled: av ? av.enabled : null,
    endpoint: av ? av.endpoint : null,
    provider: av ? av.provider : null,
    model: av ? av.model : null,
    timeout: av ? av.timeout : null,
    lastRunReason: runs.length > 0 ? (runs[0]?.availability ?? null) : null,
  };

  return {
    schema: DASH_SCHEMA,
    generatedAt: now.toISOString(),
    now: now.getTime(),
    timezone,
    scheduleError,
    inWindow,
    desiredMode,
    activeWindow: activeWin,
    nextSwitch,
    state: {
      mode: state.mode,
      switchedAt: state.switchedAt,
      lastCheck: state.lastCheck,
      hasSnapshot: state.snapshot !== null,
      missing: stateMissing,
      corrupt: stateCorrupt,
    },
    availability,
    config: configSummary,
    runs,
    history,
  };
}

// ===== 内联 HTML 模板（零外链；拆同文件 template 子函数，spec Risks 允许）=====

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(v) {
  if (!v) return '-';
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN');
}

function renderBanners(data) {
  const banners = [];
  if (data.scheduleError) banners.push(`<div class="banner error">schedule 加载失败：${escapeHtml(data.scheduleError)}</div>`);
  if (data.state?.missing) banners.push('<div class="banner">state.json 不存在（尚未切换过）</div>');
  if (data.state?.corrupt) banners.push('<div class="banner">state.json 损坏（已按 original 处理）</div>');
  return banners.join('');
}

function renderClock(data) {
  return escapeHtml(`${fmtDate(data.generatedAt)}（${data.timezone ?? '-'}）`);
}

function renderNextSwitch(data) {
  const ns = data.nextSwitch;
  if (!ns?.at) return '暂无数据';
  const label = ns.toMode === 'target' ? '切 target' : '恢复 original';
  return escapeHtml(`${fmtDate(ns.at)} → ${label}`);
}

function renderModeBlock(data) {
  const w = data.activeWindow;
  const rows = [
    ['state.mode', data.state?.mode ?? '-'],
    ['desiredMode', data.desiredMode ?? '-'],
    ['inWindow', data.inWindow === null || data.inWindow === undefined ? '-' : data.inWindow ? '是（白日窗）' : '否（target 窗）'],
    ['activeWindow', w ? `${w.days.join('/')} ${w.from}-${w.to}` : '-'],
    ['switchedAt', fmtDate(data.state?.switchedAt)],
  ];
  return rows.map(([k, v]) => `<span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span>`).join('');
}

function renderAvailabilityBlock(data) {
  const a = data.availability ?? {};
  const rows = [
    ['enabled', a.enabled ?? '-'],
    ['endpoint', a.endpoint ?? '-'],
    ['provider', a.provider ?? '-'],
    ['model', a.model ?? '-'],
    ['timeout', a.timeout === null || a.timeout === undefined ? '-' : `${a.timeout}ms`],
    ['lastRunReason', a.lastRunReason ?? '-'],
  ];
  return rows.map(([k, v]) => `<span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span>`).join('');
}

function renderRunsTable(data) {
  const rows = data.runs ?? [];
  const body = rows.length === 0
    ? '<tr><td colspan="9">暂无数据</td></tr>'
    : rows
        .map((r) => {
          const fail = r.exitCode !== null && r.exitCode !== undefined && r.exitCode !== 0;
          const changes = Array.isArray(r.changes) ? String(r.changes.length) : `${r.changes ?? '-'}`;
          const duration = r.durationMs === null || r.durationMs === undefined ? '-' : `${r.durationMs}ms`;
          const cells = [
            fmtDate(r.time),
            `${r.trigger ?? '-'}`,
            `${r.desiredMode ?? '-'}`,
            `${r.inWindow ?? '-'}`,
            `${r.action ?? '-'}`,
            `${r.availability ?? '-'}`,
            changes,
            duration,
            `${r.exitCode ?? '-'}`,
          ];
          return `<tr>${cells.map((c, i) => `<td${fail && i === 8 ? ' class="fail"' : ''}>${escapeHtml(c)}</td>`).join('')}</tr>`;
        })
        .join('');
  return `<table id="runs"><thead><tr><th>时间</th><th>trigger</th><th>desiredMode</th><th>inWindow</th><th>action</th><th>availability</th><th>changes</th><th>耗时</th><th>exit</th></tr></thead><tbody id="runs-body">${body}</tbody></table>`;
}

function renderHistoryTable(data) {
  const rows = data.history ?? [];
  const body = rows.length === 0
    ? '<tr><td colspan="4">暂无数据</td></tr>'
    : rows
        .map((r) => {
          const agents = Array.isArray(r.agents) ? r.agents.join(', ') : `${r.agents ?? '-'}`;
          const cells = [fmtDate(r.time), `${r.mode ?? '-'}`, `${r.reason ?? '-'}`, agents];
          return `<tr>${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`;
        })
        .join('');
  return `<table id="history"><thead><tr><th>时间</th><th>mode</th><th>reason</th><th>agents</th></tr></thead><tbody id="history-body">${body}</tbody></table>`;
}

function renderConfigSummary(data) {
  const c = data.config;
  if (!c) return '<span class="k">config</span><span class="v">暂无数据</span>';
  const t = c.target;
  const agents = (c.agents ?? []).map((a) => `${a.name}(${a.kind})`).join(', ');
  const kv = [
    ['target', `${t.providerId} / ${t.modelId} / ${t.reasoningLevel}`],
    ['agents', agents],
  ].map(([k, v]) => `<span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span>`).join('');
  const dwRows = (c.dayWindows ?? [])
    .map((w) => `<tr><td>${escapeHtml(w.days.join('/'))}</td><td>${escapeHtml(w.from)}</td><td>${escapeHtml(w.to)}</td></tr>`)
    .join('');
  const dwBody = dwRows === '' ? '<tr><td colspan="3">暂无数据</td></tr>' : dwRows;
  return `${kv}<table><thead><tr><th>days</th><th>from</th><th>to</th></tr></thead><tbody id="dw-body">${dwBody}</tbody></table><details><summary>完整 config JSON</summary><pre id="config-json">${escapeHtml(JSON.stringify(c, null, 2))}</pre></details>`;
}

function renderTriggerBlock() {
  return '<button id="trigger-btn" type="button">手动触发 apply（--if-due，幂等）</button><div id="trigger-result"></div>';
}

// 客户端脚本：JSON.parse 初始数据 → setInterval 5s fetch /api/status 局部重渲染；
// document.hidden 暂停轮询；触发按钮 confirm() → POST /api/trigger → 结果 + 立即重拉。
// 注意：本函数返回的脚本内禁用模板插值（纯字符串拼接），避免与外层模板字面量的 ${} 冲突。
function renderClientScript() {
  return `
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('initial-data').textContent);
  function el(id) { return document.getElementById(id); }
  function text(id, v) { var n = el(id); if (n) n.textContent = v; }
  function dash(v) { return v === null || v === undefined || v === '' ? '-' : String(v); }
  function fmtTime(v) {
    if (!v) return '-';
    var d = new Date(typeof v === 'number' ? v : String(v));
    return isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN');
  }
  function fmtCountdown(next) {
    if (!next || !next.at) return '暂无数据';
    var ms = new Date(next.at).getTime() - Date.now();
    var label = next.toMode === 'target' ? '切 target' : '恢复 original';
    if (ms <= 0) return '即将切换 → ' + label;
    var m = Math.floor(ms / 60000);
    var s = Math.floor((ms % 60000) / 1000);
    return fmtTime(next.at) + '（' + m + ' 分 ' + s + ' 秒后 → ' + label + '）';
  }
  function fillKv(container, pairs) {
    container.textContent = '';
    for (var i = 0; i < pairs.length; i++) {
      var k = document.createElement('span'); k.className = 'k'; k.textContent = pairs[i][0];
      var v = document.createElement('span'); v.className = 'v'; v.textContent = pairs[i][1];
      container.append(k, v);
    }
  }
  function fillTable(tbody, rows, cols) {
    if (!tbody) return;
    tbody.textContent = '';
    if (!rows || rows.length === 0) {
      var tr0 = document.createElement('tr');
      var td0 = document.createElement('td');
      td0.colSpan = cols.length;
      td0.textContent = '暂无数据';
      tr0.appendChild(td0);
      tbody.appendChild(tr0);
      return;
    }
    for (var i = 0; i < rows.length; i++) {
      var tr = document.createElement('tr');
      for (var j = 0; j < cols.length; j++) {
        var td = document.createElement('td');
        td.textContent = cols[j].text(rows[i]);
        if (cols[j].cls && cols[j].cls(rows[i])) td.className = cols[j].cls(rows[i]);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }
  function fillBanners(d) {
    var box = el('banners');
    if (!box) return;
    box.textContent = '';
    var banners = [];
    if (d.scheduleError) banners.push({ cls: 'banner error', msg: 'schedule 加载失败：' + d.scheduleError });
    if (d.state && d.state.missing) banners.push({ cls: 'banner', msg: 'state.json 不存在（尚未切换过）' });
    if (d.state && d.state.corrupt) banners.push({ cls: 'banner', msg: 'state.json 损坏（已按 original 处理）' });
    for (var i = 0; i < banners.length; i++) {
      var div = document.createElement('div');
      div.className = banners[i].cls;
      div.textContent = banners[i].msg;
      box.appendChild(div);
    }
  }
  function modePairs(d) {
    var w = d.activeWindow;
    return [
      ['state.mode', dash(d.state && d.state.mode)],
      ['desiredMode', dash(d.desiredMode)],
      ['inWindow', d.inWindow === null || d.inWindow === undefined ? '-' : (d.inWindow ? '是（白日窗）' : '否（target 窗）')],
      ['activeWindow', w ? w.days.join('/') + ' ' + w.from + '-' + w.to : '-'],
      ['switchedAt', fmtTime(d.state && d.state.switchedAt)]
    ];
  }
  function availPairs(d) {
    var a = d.availability || {};
    return [
      ['enabled', dash(a.enabled)],
      ['endpoint', dash(a.endpoint)],
      ['provider', dash(a.provider)],
      ['model', dash(a.model)],
      ['timeout', a.timeout === null || a.timeout === undefined ? '-' : a.timeout + 'ms'],
      ['lastRunReason', dash(a.lastRunReason)]
    ];
  }
  function configPairs(d) {
    var c = d.config;
    if (!c || !c.target) return [['target', '暂无数据'], ['agents', '暂无数据']];
    var names = (c.agents || []).map(function (a) { return a.name + '(' + a.kind + ')'; }).join(', ');
    return [
      ['target', c.target.providerId + ' / ' + c.target.modelId + ' / ' + c.target.reasoningLevel],
      ['agents', names]
    ];
  }
  var runCols = [
    { text: function (r) { return fmtTime(r.time); } },
    { text: function (r) { return dash(r.trigger); } },
    { text: function (r) { return dash(r.desiredMode); } },
    { text: function (r) { return dash(r.inWindow); } },
    { text: function (r) { return dash(r.action); } },
    { text: function (r) { return dash(r.availability); } },
    { text: function (r) { return Array.isArray(r.changes) ? String(r.changes.length) : dash(r.changes); } },
    { text: function (r) { return r.durationMs === null || r.durationMs === undefined ? '-' : r.durationMs + 'ms'; } },
    { text: function (r) { return dash(r.exitCode); }, cls: function (r) { return (r.exitCode !== null && r.exitCode !== undefined && r.exitCode !== 0) ? 'fail' : ''; } }
  ];
  var historyCols = [
    { text: function (r) { return fmtTime(r.time); } },
    { text: function (r) { return dash(r.mode); } },
    { text: function (r) { return dash(r.reason); } },
    { text: function (r) { return Array.isArray(r.agents) ? r.agents.join(', ') : dash(r.agents); } }
  ];
  var dwCols = [
    { text: function (w) { return w.days.join('/'); } },
    { text: function (w) { return w.from; } },
    { text: function (w) { return w.to; } }
  ];
  function render(d) {
    fillBanners(d);
    text('clock', fmtTime(d.generatedAt) + '（' + dash(d.timezone) + '）');
    text('next-switch', fmtCountdown(d.nextSwitch));
    fillKv(el('mode'), modePairs(d));
    fillKv(el('availability'), availPairs(d));
    fillTable(el('runs-body'), d.runs, runCols);
    fillTable(el('history-body'), d.history, historyCols);
    fillKv(el('config-summary'), configPairs(d));
    fillTable(el('dw-body'), d.config ? d.config.dayWindows : [], dwCols);
    text('config-json', d.config ? JSON.stringify(d.config, null, 2) : '暂无数据');
  }
  var timer = null;
  function refresh() {
    return fetch('/api/status').then(function (res) {
      if (res.ok) return res.json().then(render);
    }).catch(function () {
      // 吞掉轮询 fetch 的网络错误：页面保留上次数据，下一轮 5s 重试自愈（try 仅此一条语句）
    });
  }
  function startPolling() { if (timer === null) timer = setInterval(refresh, 5000); }
  function stopPolling() { if (timer !== null) { clearInterval(timer); timer = null; } }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { stopPolling(); } else { refresh(); startPolling(); }
  });
  el('trigger-btn').addEventListener('click', function () {
    if (!window.confirm('手动触发一次 apply --if-due（幂等，无强制覆盖）？')) return;
    var btn = el('trigger-btn');
    var result = el('trigger-result');
    btn.disabled = true;
    fetch('/api/trigger', { method: 'POST' }).then(function (res) {
      return res.json().then(function (body) { return { status: res.status, body: body }; });
    }).then(function (r) {
      var msg;
      if (r.status === 409) msg = '已有触发进行中，请稍候';
      else if (r.body.ok) msg = '触发完成 exit=' + r.body.exitCode;
      else msg = '触发失败 exit=' + r.body.exitCode + (r.body.error ? '（' + r.body.error + '）' : '');
      result.textContent = msg;
      result.className = r.body.ok && r.status === 200 ? 'ok' : 'fail';
    }).catch(function () {
      // 吞掉触发 fetch 的网络错误：仅在结果区提示，不影响轮询（try 仅此一条语句）
      result.textContent = '触发请求失败（网络/服务异常）';
      result.className = 'fail';
    }).then(function () {
      btn.disabled = false;
      refresh();
    });
  });
  render(data);
  startPolling();
})();
`;
}

export function renderDashboardPage(data) {
  const initialData = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>zcode-model-schedule dashboard</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; margin: 0; background: #f5f5f7; color: #1d1d1f; }
  main { max-width: 880px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 20px; }
  h2 { font-size: 15px; margin: 20px 0 8px; color: #555; }
  .card { background: #fff; border-radius: 10px; padding: 12px 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); margin-bottom: 8px; }
  .banner { background: #fff3cd; border: 1px solid #ffe08a; border-radius: 8px; padding: 8px 12px; margin-bottom: 8px; font-size: 13px; }
  .banner.error { background: #fde8e8; border-color: #f5b5b5; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #eee; }
  td.fail { color: #c62828; font-weight: 600; }
  .kv { display: grid; grid-template-columns: 150px 1fr; gap: 4px 12px; font-size: 13px; align-content: start; }
  #trigger-result.ok { color: #2e7d32; font-size: 13px; }
  #trigger-result.fail { color: #c62828; font-size: 13px; }
  button { font: inherit; padding: 6px 14px; border-radius: 8px; border: 1px solid #ccc; background: #fff; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  pre { font-size: 12px; overflow: auto; }
</style>
</head>
<body>
<main>
<h1>zcode-model-schedule</h1>
<div id="banners">${renderBanners(data)}</div>
<div class="card"><span id="clock">${renderClock(data)}</span><br><span id="next-switch">${renderNextSwitch(data)}</span></div>
<h2>当前模式</h2>
<div class="card kv" id="mode">${renderModeBlock(data)}</div>
<h2>可用性</h2>
<div class="card kv" id="availability">${renderAvailabilityBlock(data)}</div>
<h2>最近运行（最多 10 条）</h2>
<div class="card">${renderRunsTable(data)}</div>
<h2>切换历史（最多 10 条）</h2>
<div class="card">${renderHistoryTable(data)}</div>
<h2>配置摘要</h2>
<div class="card kv" id="config-summary">${renderConfigSummary(data)}</div>
<h2>手动触发</h2>
<div class="card" id="trigger">${renderTriggerBlock()}</div>
</main>
<script type="application/json" id="initial-data">${initialData}</script>
<script>
${renderClientScript()}
</script>
</body>
</html>`;
}
```

### C1-b 测试代码 — 新建 `test/dashboard.test.mjs`（全文，本卡到用例 15 为止）

```js
// test/dashboard.test.mjs — dashboard 聚合层 + 模板 + HTTP（node --test；临时目录隔离，禁止触碰真实 ~/.zcode）
// C1：用例 1-15（lib/dashboard.mjs）；C2 追加用例 16-21（dashboard.mjs HTTP 层，见文件末尾）
// TZ 固定 Asia/Shanghai（+08:00 无 DST）；2026-11-02=周一、11-03=周二、11-06=周五、11-07=周六、11-08=周日、11-09=周一
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  wallTimeToInstant,
  computeNextSwitch,
  activeWindow,
  readJsonlLinesLocal,
  buildDashboardData,
  renderDashboardPage,
} from '../lib/dashboard.mjs';

const TZ = 'Asia/Shanghai';
const NOW_IN_WINDOW = new Date('2026-11-03T10:00:00+08:00'); // 周二 10:00，白日窗内

function makeTmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `msched-dash-${label}-`));
}

function baseSchedule(overrides = {}) {
  return {
    $schema: 'zcode-model-schedule/v2',
    timezone: TZ,
    target: { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', reasoningLevel: 'max' },
    agents: [{ name: 'Explore', kind: 'builtin' }],
    dayWindows: [{ days: [1, 2, 3, 4, 5], from: '08:50', to: '23:10' }],
    availability: {
      enabled: false,
      endpoint: 'https://billing.example.invalid/api/v1/zcode-plan/billing/current',
      provider: 'builtin:bigmodel-start-plan',
      model: 'model:glm-5.3-flash',
      timeout: 5000,
    },
    ...overrides,
  };
}

function writeSchedule(dir, schedule = baseSchedule()) {
  const configPath = path.join(dir, 'schedule.json');
  fs.writeFileSync(configPath, JSON.stringify(schedule));
  return configPath;
}

// 全数据齐全夹具（用例 11/13/14/15/16-21 共用）：4 文件齐全，runs/history 文件内按时间升序写，断言接口输出降序
function writeFullFixtures(dir) {
  const configPath = writeSchedule(dir);
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    mode: 'target',
    switchedAt: '2026-11-03T00:30:00.000Z', // 11-03 08:30+08，今晨 target 窗切过
    snapshot: { Explore: { providerId: 'magpie', modelId: 'group/glm5.3', options: { reasoningLevel: 'max' } } },
    lastCheck: '2026-11-03T01:55:00.000Z',
  }));
  const historyPath = path.join(dir, 'history.jsonl');
  fs.writeFileSync(historyPath, [
    JSON.stringify({ time: '2026-11-02T00:30:00.000Z', mode: 'target', reason: 'switch', agents: ['Explore'] }),
    JSON.stringify({ time: '2026-11-02T15:10:00.000Z', mode: 'original', reason: 'restore', agents: ['Explore'] }),
  ].join('\n') + '\n');
  const runLogPath = path.join(dir, 'logs', 'runs.jsonl');
  fs.mkdirSync(path.dirname(runLogPath), { recursive: true });
  fs.writeFileSync(runLogPath, [
    JSON.stringify({ schema: 'zcode-model-schedule/run-log/v1', time: '2026-11-02T15:10:05.000Z', trigger: 'launchd', desiredMode: 'original', inWindow: true, action: 'restored', availability: null, changes: [{ agent: 'Explore', field: 'model', old: 'x', new: 'y' }], durationMs: 34, exitCode: 0 }),
    JSON.stringify({ schema: 'zcode-model-schedule/run-log/v1', time: '2026-11-03T01:55:00.000Z', trigger: 'launchd', desiredMode: 'target', inWindow: false, action: 'no-change', availability: 'disabled', changes: [], durationMs: 12, exitCode: 0 }),
  ].join('\n') + '\n');
  return { configPath, statePath, historyPath, runLogPath };
}

describe('computeNextSwitch', () => {
  test('用例1 窗口内（周二 10:00+08）→ 当日 23:10、toMode target', () => {
    const ns = computeNextSwitch(baseSchedule(), NOW_IN_WINDOW);
    assert.deepEqual(ns, { at: '2026-11-03T15:10:00.000Z', toMode: 'target' });
  });

  test('用例2 窗口前（周二 08:00+08）→ 当日 08:50、toMode original', () => {
    const ns = computeNextSwitch(baseSchedule(), new Date('2026-11-03T08:00:00+08:00'));
    assert.deepEqual(ns, { at: '2026-11-03T00:50:00.000Z', toMode: 'original' });
  });

  test('用例3 周六 12:00+08 → 下周一（11-09）08:50、toMode original', () => {
    const ns = computeNextSwitch(baseSchedule(), new Date('2026-11-07T12:00:00+08:00'));
    assert.deepEqual(ns, { at: '2026-11-09T00:50:00.000Z', toMode: 'original' });
  });

  test('用例4 周五 23:30+08（to 已过）→ 下周一 08:50、toMode original', () => {
    const ns = computeNextSwitch(baseSchedule(), new Date('2026-11-06T23:30:00+08:00'));
    assert.deepEqual(ns, { at: '2026-11-09T00:50:00.000Z', toMode: 'original' });
  });

  test('用例5 now 恰为 08:50:00 → from 候选被 > 滤除，返回当日 23:10、target', () => {
    const ns = computeNextSwitch(baseSchedule(), new Date('2026-11-03T08:50:00+08:00'));
    assert.deepEqual(ns, { at: '2026-11-03T15:10:00.000Z', toMode: 'target' });
  });

  test('用例6 双窗口（days[6,7] 周末窗）周日窗内 → 周日 to、target', () => {
    const schedule = baseSchedule({
      dayWindows: [
        { days: [1, 2, 3, 4, 5], from: '08:50', to: '23:10' },
        { days: [6, 7], from: '09:00', to: '22:00' },
      ],
    });
    const ns = computeNextSwitch(schedule, new Date('2026-11-08T12:00:00+08:00')); // 周日 12:00，窗 09:00-22:00 内
    assert.deepEqual(ns, { at: '2026-11-08T14:00:00.000Z', toMode: 'target' });
  });

  test('用例7 任意 3 瞬时均非 null（14 天扫描终止保证）且严格晚于 now', () => {
    for (const iso of ['2026-02-15T03:24:56.789Z', '2026-06-30T21:11:00.000Z', '2027-01-01T00:00:00.000Z']) {
      const ns = computeNextSwitch(baseSchedule(), new Date(iso));
      assert.ok(ns !== null, `nextSwitch 为 null @ ${iso}`);
      assert.ok(Date.parse(ns.at) > Date.parse(iso), `候选未晚于 now @ ${iso}`);
      assert.ok(['original', 'target'].includes(ns.toMode));
    }
  });
});

describe('wallTimeToInstant', () => {
  test('用例8 纽约 2026-07-01 00:00 墙钟（分钟数 0）→ 2026-07-01T04:00:00.000Z（偏移校正）', () => {
    const ms = wallTimeToInstant(2026, 7, 1, 0, 'America/New_York');
    assert.equal(ms, Date.parse('2026-07-01T04:00:00.000Z'));
    assert.equal(new Date(ms).toISOString(), '2026-07-01T04:00:00.000Z');
  });
});

describe('activeWindow', () => {
  test('用例9 命中返回窗口；窗前/to 严格不命中返回 null；空 dayWindows 返回 null', () => {
    const schedule = baseSchedule();
    assert.deepEqual(activeWindow(schedule, NOW_IN_WINDOW), { days: [1, 2, 3, 4, 5], from: '08:50', to: '23:10' });
    assert.equal(activeWindow(schedule, new Date('2026-11-03T08:00:00+08:00')), null); // from 前
    assert.equal(activeWindow(schedule, new Date('2026-11-03T23:10:00+08:00')), null); // to 严格不命中
    assert.equal(activeWindow(baseSchedule({ dayWindows: [] }), NOW_IN_WINDOW), null);
  });
});

describe('readJsonlLinesLocal', () => {
  test('用例10 ENOENT→[]；坏行跳过好行保留；目录读错误向上抛', () => {
    const dir = makeTmpDir('jsonl');
    assert.deepEqual(readJsonlLinesLocal(path.join(dir, 'nope.jsonl')), []);
    const mixed = path.join(dir, 'mixed.jsonl');
    fs.writeFileSync(mixed, '{"a":1}\nnot-json\n\n{"b":2}\n');
    assert.deepEqual(readJsonlLinesLocal(mixed), [{ a: 1 }, { b: 2 }]);
    assert.throws(() => readJsonlLinesLocal(dir), (err) => err.code === 'EISDIR');
  });
});

describe('buildDashboardData', () => {
  test('用例11 全数据齐全 → 各字段正确、missing/corrupt 全 false、lastRunReason=runs[0].availability', () => {
    const dir = makeTmpDir('full');
    const paths = writeFullFixtures(dir);
    const d = buildDashboardData({ ...paths, now: NOW_IN_WINDOW });
    assert.equal(d.schema, 'zcode-model-schedule/dashboard/v1');
    assert.equal(d.generatedAt, NOW_IN_WINDOW.toISOString());
    assert.equal(d.now, NOW_IN_WINDOW.getTime());
    assert.equal(d.timezone, TZ);
    assert.equal(d.scheduleError, null);
    assert.equal(d.inWindow, true);
    assert.equal(d.desiredMode, 'original');
    assert.deepEqual(d.activeWindow, { days: [1, 2, 3, 4, 5], from: '08:50', to: '23:10' });
    assert.deepEqual(d.nextSwitch, { at: '2026-11-03T15:10:00.000Z', toMode: 'target' });
    assert.equal(d.state.mode, 'target');
    assert.equal(d.state.hasSnapshot, true);
    assert.equal(d.state.missing, false);
    assert.equal(d.state.corrupt, false);
    assert.deepEqual(d.availability, {
      enabled: false,
      endpoint: 'https://billing.example.invalid/api/v1/zcode-plan/billing/current',
      provider: 'builtin:bigmodel-start-plan',
      model: 'model:glm-5.3-flash',
      timeout: 5000,
      lastRunReason: 'disabled',
    });
    assert.equal(d.config.target.modelId, 'GLM-5.3-Flash');
    assert.equal(d.runs.length, 2);
    assert.equal(d.runs[0].time, '2026-11-03T01:55:00.000Z'); // 降序
    assert.equal(d.history.length, 2);
    assert.equal(d.history[0].reason, 'restore'); // 降序
  });

  test('用例12 全缺失 → 降级标记、runs/history 空、不 throw；渲染含「暂无数据」', () => {
    const dir = makeTmpDir('empty');
    const d = buildDashboardData({
      configPath: path.join(dir, 'schedule.json'),
      statePath: path.join(dir, 'state.json'),
      historyPath: path.join(dir, 'history.jsonl'),
      runLogPath: path.join(dir, 'logs', 'runs.jsonl'),
      now: NOW_IN_WINDOW,
    });
    assert.ok(d.scheduleError !== null);
    assert.ok(d.scheduleError.includes('无法读取'));
    assert.equal(d.timezone, null);
    assert.equal(d.inWindow, null);
    assert.equal(d.desiredMode, null);
    assert.equal(d.activeWindow, null);
    assert.equal(d.nextSwitch, null);
    assert.equal(d.config, null);
    assert.equal(d.state.missing, true);
    assert.equal(d.state.corrupt, false);
    assert.equal(d.state.mode, 'original');
    assert.deepEqual(d.runs, []);
    assert.deepEqual(d.history, []);
    assert.equal(d.availability.enabled, null);
    assert.equal(d.availability.lastRunReason, null);
    assert.ok(renderDashboardPage(d).includes('暂无数据')); // Acceptance：降级页面显示「暂无数据」
  });

  test('用例13 state.json 损坏 → corrupt=true、mode original；history 坏行跳过好行保留', () => {
    const dir = makeTmpDir('corrupt');
    const paths = writeFullFixtures(dir);
    fs.writeFileSync(paths.statePath, '{oops broken');
    fs.writeFileSync(paths.historyPath, '{"time":"2026-11-02T00:30:00.000Z","mode":"target","reason":"switch","agents":["Explore"]}\nbroken-line\n');
    const d = buildDashboardData({ ...paths, now: NOW_IN_WINDOW });
    assert.equal(d.state.corrupt, true);
    assert.equal(d.state.missing, false);
    assert.equal(d.state.mode, 'original'); // loadState 自愈
    assert.equal(d.history.length, 1);
    assert.equal(d.history[0].reason, 'switch');
  });

  test('用例14 schedule.json 缺失 → scheduleError 非空、窗口系字段 null、runs 照常返回', () => {
    const dir = makeTmpDir('nosched');
    const runLogPath = path.join(dir, 'logs', 'runs.jsonl');
    fs.mkdirSync(path.dirname(runLogPath), { recursive: true });
    fs.writeFileSync(runLogPath, JSON.stringify({ schema: 'zcode-model-schedule/run-log/v1', time: '2026-11-03T01:55:00.000Z', trigger: 'dashboard', availability: 'disabled' }) + '\n');
    const d = buildDashboardData({
      configPath: path.join(dir, 'schedule.json'),
      statePath: path.join(dir, 'state.json'),
      historyPath: path.join(dir, 'history.jsonl'),
      runLogPath,
      now: NOW_IN_WINDOW,
    });
    assert.ok(d.scheduleError !== null);
    assert.equal(d.inWindow, null);
    assert.equal(d.desiredMode, null);
    assert.equal(d.nextSwitch, null);
    assert.equal(d.activeWindow, null);
    assert.equal(d.config, null);
    assert.equal(d.runs.length, 1);
    assert.equal(d.runs[0].trigger, 'dashboard');
  });
});

describe('renderDashboardPage', () => {
  test('用例15 含 </html> 与全部区块 id；数据含 <script> 时输出转义为 \\u003c（无裸注入）', () => {
    const dir = makeTmpDir('render');
    const paths = writeFullFixtures(dir);
    // 注入含 <script> 的 history reason，验证双通道转义（初始 JSON + 服务端渲染）
    fs.writeFileSync(paths.historyPath, JSON.stringify({ time: '2026-11-02T15:10:00.000Z', mode: 'original', reason: '<script>alert(1)</script>', agents: ['Explore'] }) + '\n');
    const d = buildDashboardData({ ...paths, now: NOW_IN_WINDOW });
    const html = renderDashboardPage(d);
    assert.ok(html.includes('<!doctype html'));
    assert.ok(html.includes('</html>'));
    for (const id of ['banners', 'clock', 'next-switch', 'mode', 'availability', 'runs', 'history', 'config-summary', 'trigger', 'initial-data']) {
      assert.ok(html.includes(`id="${id}"`), `missing id="${id}"`);
    }
    assert.equal(html.includes('<script>alert'), false); // 无裸注入
    assert.ok(html.includes('\\u003cscript>alert')); // 初始数据 JSON 通道转义
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;')); // 服务端渲染通道转义
  });
});
```

### C1 验证命令

```bash
cd /Users/peter/Documents/project/zcode-model-schedule/.worktrees/dashboard
# 1) 红证明（生产未落时）：node --test test/dashboard.test.mjs → import 失败（ERR_MODULE_NOT_FOUND）
# 2) 生产落盘后：
node --test test/apply.test.mjs test/dashboard.test.mjs 2>&1 | tail -7
# 预期：# tests 147 / # pass 147 / # fail 0
```

### C1 commit

```
feat: dashboard aggregation layer and inline template (cases 1-15)
```

---

## Card C2 — dashboard.mjs（HTTP 入口）+ 用例 16-21 追加（tier A）

- **Files**：`dashboard.mjs`（新建）；`test/dashboard.test.mjs`（追加：顶部 import 一行 + 文件末尾 helpers 与用例 16-21）
- **依赖/并行**：依赖 C1（import `../lib/dashboard.mjs`）；与 C1 Files 相交 → 串行第 2 位
- **TDD 次序**：先追加测试（红：`../dashboard.mjs` 不存在，import 失败）→ 再落生产（绿）
- **验收**：`node --test test/apply.test.mjs test/dashboard.test.mjs` → 153 pass / 0 fail

### C2-a 测试代码 — `test/dashboard.test.mjs` 两处编辑（完整内容）

**编辑 1（顶部 import 区）**——在 `} from '../lib/dashboard.mjs';` 之后追加一行：

```js
import { createRequestHandler, runApplyIfDue, startServer } from '../dashboard.mjs';
```

**编辑 2（文件末尾追加）**——以下整块追加到用例 15 的 `});` 之后：

```js
// ===== C2 追加（用例 16-21）：dashboard.mjs HTTP 层 =====
// handler 全依赖注入（deps.now / deps.spawnTrigger 为 fake），mock req/res 不起端口；
// 仅用例 21 起真实 http.Server（port 0 随机端口，close 后 await close 事件不挂起）。

function mockRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? null; },
    end(body) { this.body = body ?? ''; },
  };
}

async function fire(handler, method, target) {
  const res = mockRes();
  await handler({ method, url: target }, res);
  return res;
}

function httpDeps(paths, overrides = {}) {
  return {
    configPath: paths.configPath,
    statePath: paths.statePath,
    historyPath: paths.historyPath,
    runLogPath: paths.runLogPath,
    toolDir: '/nonexistent-tool-dir', // 单测不 spawn 真实进程；runApplyIfDue 单独注入 fake execFileImpl
    now: () => new Date('2026-11-03T10:00:00+08:00'),
    spawnTrigger: async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '' }),
    ...overrides,
  };
}

describe('dashboard HTTP handler', () => {
  test('用例16 GET / → 200 text/html 含 <!doctype html', async () => {
    const dir = makeTmpDir('http-index');
    const res = await fire(createRequestHandler(httpDeps(writeFullFixtures(dir))), 'GET', '/');
    assert.equal(res.statusCode, 200);
    assert.ok(String(res.headers['Content-Type']).includes('text/html'));
    assert.ok(res.body.includes('<!doctype html'));
  });

  test('用例17 GET /api/status → 200 schema v1；/api/runs?limit=abc → clamp 10（非 400）', async () => {
    const dir = makeTmpDir('http-status');
    const paths = writeFullFixtures(dir);
    const lines = [];
    for (let i = 0; i < 12; i++) {
      lines.push(JSON.stringify({ schema: 'zcode-model-schedule/run-log/v1', time: new Date(Date.parse('2026-11-03T01:00:00.000Z') + i * 60000).toISOString(), trigger: 'launchd', availability: 'disabled' }));
    }
    fs.writeFileSync(paths.runLogPath, lines.join('\n') + '\n'); // 12 条 > 默认 10
    const handler = createRequestHandler(httpDeps(paths));
    const res = await fire(handler, 'GET', '/api/status');
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.schema, 'zcode-model-schedule/dashboard/v1');
    const res2 = await fire(handler, 'GET', '/api/runs?limit=abc');
    assert.equal(res2.statusCode, 200);
    assert.equal(JSON.parse(res2.body).runs.length, 10); // 非整数 → 回退 10
  });

  test('用例18 GET /nope → 404 JSON；POST /api/status → 405 + Allow 头', async () => {
    const dir = makeTmpDir('http-404');
    const handler = createRequestHandler(httpDeps(writeFullFixtures(dir)));
    const res = await fire(handler, 'GET', '/nope');
    assert.equal(res.statusCode, 404);
    assert.deepEqual(JSON.parse(res.body), { error: 'not-found' });
    const res2 = await fire(handler, 'POST', '/api/status');
    assert.equal(res2.statusCode, 405);
    assert.equal(res2.headers.Allow, 'GET');
  });

  test('用例19 POST /api/trigger：exit0 → ok；exit2 → 回显；进行中二次调用 → 409', async () => {
    const dir = makeTmpDir('http-trigger');
    const paths = writeFullFixtures(dir);
    const h1 = createRequestHandler(httpDeps(paths, { spawnTrigger: async () => ({ ok: true, exitCode: 0, stdout: 'no change', stderr: '' }) }));
    const r1 = await fire(h1, 'POST', '/api/trigger');
    assert.equal(r1.statusCode, 200);
    assert.deepEqual(JSON.parse(r1.body), { ok: true, exitCode: 0, stdout: 'no change', stderr: '' });

    const h2 = createRequestHandler(httpDeps(paths, { spawnTrigger: async () => ({ ok: false, exitCode: 2, stdout: '', stderr: '[locked] busy' }) }));
    const r2 = await fire(h2, 'POST', '/api/trigger');
    assert.deepEqual(JSON.parse(r2.body), { ok: false, exitCode: 2, stdout: '', stderr: '[locked] busy' });

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const h3 = createRequestHandler(httpDeps(paths, {
      spawnTrigger: () => { calls += 1; return gate.then(() => ({ ok: true, exitCode: 0, stdout: '', stderr: '' })); },
    }));
    const pending = fire(h3, 'POST', '/api/trigger'); // 第 1 发：handler 同步段已置 in-flight
    const rBusy = await fire(h3, 'POST', '/api/trigger'); // 第 2 发撞守卫
    assert.equal(rBusy.statusCode, 409);
    assert.deepEqual(JSON.parse(rBusy.body), { error: 'busy' });
    release();
    const rDone = await pending;
    assert.equal(rDone.statusCode, 200);
    assert.equal(calls, 1); // 第 2 发未触达 spawnTrigger
  });
});

describe('runApplyIfDue', () => {
  test('用例20 注入 execFileImpl 三态：成功回调 / err.code=2 / err.killed → timeout', async () => {
    const seen = {};
    const ok = (file, args, opts, cb) => {
      seen.file = file; seen.args = args; seen.opts = opts;
      cb(null, 'out-data', 'err-data');
    };
    const r1 = await runApplyIfDue({ toolDir: '/tmp/tool', execFileImpl: ok });
    assert.deepEqual(r1, { ok: true, exitCode: 0, stdout: 'out-data', stderr: 'err-data' });
    assert.equal(seen.file, process.execPath);
    assert.deepEqual(seen.args, ['/tmp/tool/apply.mjs', '--if-due', '--trigger', 'dashboard']); // 绝无 --force / 模式覆盖参数
    assert.equal(seen.opts.cwd, '/tmp/tool');

    const busy = (f, a, o, cb) => cb(Object.assign(new Error('lock busy'), { code: 2 }), '', '[locked]');
    const r2 = await runApplyIfDue({ toolDir: '/tmp/tool', execFileImpl: busy });
    assert.deepEqual(r2, { ok: false, exitCode: 2, stdout: '', stderr: '[locked]' }); // 锁忙 exit 2 回显

    const timedOut = (f, a, o, cb) => cb(Object.assign(new Error('timeout'), { killed: true }), '', '');
    const r3 = await runApplyIfDue({ toolDir: '/tmp/tool', execFileImpl: timedOut });
    assert.deepEqual(r3, { ok: false, error: 'timeout' });
  });
});

describe('startServer', () => {
  test('用例21 port 0 集成：绑定 127.0.0.1 + fetch /api/status 200 + close 后 await close 不挂起', async () => {
    const dir = makeTmpDir('http-server');
    const paths = writeFullFixtures(dir);
    const handler = createRequestHandler(httpDeps(paths));
    let server;
    try {
      server = await startServer({ handler, port: 0 });
      const addr = server.address();
      assert.equal(addr.address, '127.0.0.1');
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/status`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.schema, 'zcode-model-schedule/dashboard/v1');
      assert.equal(body.inWindow, true);
    } finally {
      if (server) {
        server.closeIdleConnections?.();
        await new Promise((resolve) => server.close(resolve)); // try/finally 兜底 close，禁止挂起
      }
    }
  });
});
```

### C2-b 生产代码 — 新建 `dashboard.mjs`（全文，逐字落盘）

```js
#!/usr/bin/env node
// dashboard.mjs — 本地 dashboard HTTP 入口（仅绑定 127.0.0.1；零依赖）
// spec: docs/superpowers/specs/2026-11-03-dashboard.md
// 路径常量照 apply.mjs:25-32；isMainModule 照 apply.mjs:37-45；parseArgs 风格照 apply.mjs:47-82
// 触发只走 apply.mjs --if-due（幂等，同锁/快照/run-log 路径）；绝不 --force、绝无模式覆盖参数
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { DASH_SCHEMA, buildDashboardData, readJsonlLinesLocal, renderDashboardPage } from './lib/dashboard.mjs';
import { readRunLogs } from './lib/run-log.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(TOOL_DIR, 'schedule.json');
const STATE_PATH = path.join(TOOL_DIR, 'state.json'); // 工具自身状态（同 apply.mjs:29 命名）
const HISTORY_PATH = path.join(TOOL_DIR, 'history.jsonl');
const RUN_LOG_PATH = path.join(TOOL_DIR, 'logs', 'runs.jsonl');
const USAGE = '用法: node dashboard.mjs [--port <n>] [--config <path>]';

// 直接执行判定：argv[1] 经 realpath 对比（容忍 symlink 部署）；照 apply.mjs:37-45 逐字
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

export function parseArgs(argv = []) {
  const opts = { port: 8787, config: DEFAULT_CONFIG };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') {
      const value = argv[i + 1];
      const n = Number(value);
      if (value === undefined || !Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`--port 需要 1..65535 的整数\n${USAGE}`);
      }
      opts.port = n;
      i += 1;
    } else if (arg === '--config') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`--config 需要一个路径参数\n${USAGE}`);
      opts.config = value;
      i += 1;
    } else {
      throw new Error(`未知参数: ${arg}\n${USAGE}`);
    }
  }
  return opts;
}

// runApplyIfDue — spawn node <toolDir>/apply.mjs --if-due --trigger dashboard；永不 reject，结果全部落 {ok,...}
export function runApplyIfDue({ toolDir, execFileImpl = execFile, timeoutMs = 60000 }) {
  return new Promise((resolve) => {
    execFileImpl(
      process.execPath,
      [path.join(toolDir, 'apply.mjs'), '--if-due', '--trigger', 'dashboard'],
      { cwd: toolDir, timeout: timeoutMs, maxBuffer: 1048576 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.killed || err.code === 'ETIMEDOUT') return resolve({ ok: false, error: 'timeout' });
          return resolve({ ok: false, exitCode: err.code ?? 1, stdout, stderr }); // exit 2=锁忙经此回显
        }
        resolve({ ok: true, exitCode: 0, stdout, stderr });
      },
    );
  });
}

// createRequestHandler — 全依赖注入；deps = {configPath, statePath, historyPath, runLogPath, toolDir, now, spawnTrigger}
export function createRequestHandler(deps) {
  let triggerInFlight = false;
  const data = () => buildDashboardData({
    configPath: deps.configPath,
    statePath: deps.statePath,
    historyPath: deps.historyPath,
    runLogPath: deps.runLogPath,
    now: deps.now(),
  });
  const sendJson = (res, status, body, extraHeaders = {}) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    });
    res.end(JSON.stringify(body));
  };
  // limit 解析：缺省/空/非整数 → 10；整数 clamp 1..100（spec：N 非整数→10，clamp 1..100）
  const parseLimit = (raw) => {
    if (raw === null || raw === '') return 10;
    const n = Number(raw);
    if (!Number.isInteger(n)) return 10;
    return Math.min(Math.max(n, 1), 100);
  };
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const { pathname } = url;
      if (pathname === '/') {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' }, { Allow: 'GET' });
        const html = renderDashboardPage(await data());
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(html);
        return;
      }
      if (pathname === '/api/status') {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' }, { Allow: 'GET' });
        sendJson(res, 200, await data());
        return;
      }
      if (pathname === '/api/runs' || pathname === '/api/history') {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' }, { Allow: 'GET' });
        const limit = parseLimit(url.searchParams.get('limit'));
        if (pathname === '/api/runs') {
          sendJson(res, 200, { schema: DASH_SCHEMA, runs: readRunLogs(deps.runLogPath, { limit }) });
        } else {
          const all = readJsonlLinesLocal(deps.historyPath);
          all.sort((a, b) => String(b.time ?? '').localeCompare(String(a.time ?? ''))); // 排序语义照 lib/run-log.mjs:67-69
          sendJson(res, 200, { schema: DASH_SCHEMA, history: all.slice(0, limit) });
        }
        return;
      }
      if (pathname === '/api/trigger') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' }, { Allow: 'POST' });
        if (triggerInFlight) return sendJson(res, 409, { error: 'busy' });
        triggerInFlight = true;
        try {
          const result = await deps.spawnTrigger();
          sendJson(res, 200, result);
        } finally {
          triggerInFlight = false;
        }
        return;
      }
      return sendJson(res, 404, { error: 'not-found' });
    } catch (err) {
      console.error(`[error] dashboard handler: ${err?.message ?? err}`);
      sendJson(res, 500, { error: 'internal' });
    }
  };
}

export function startServer({ handler, port, host = '127.0.0.1' }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`端口 ${port} 已被占用（已有 dashboard 在跑？），可用 --port 换端口`);
        process.exit(1);
      }
      reject(err);
    });
    server.listen(port, host, () => resolve(server));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const server = await startServer({
    handler: createRequestHandler({
      configPath: opts.config,
      statePath: STATE_PATH,
      historyPath: HISTORY_PATH,
      runLogPath: RUN_LOG_PATH,
      toolDir: TOOL_DIR,
      now: () => new Date(),
      spawnTrigger: () => runApplyIfDue({ toolDir: TOOL_DIR }),
    }),
    port: opts.port,
  });
  console.log(`dashboard: http://127.0.0.1:${server.address().port}`);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close();
    server.closeIdleConnections?.();
  };
  process.on('SIGINT', shutdown); // Ctrl+C → close → 'close' 事件 exit 0（spec）
  process.on('SIGTERM', shutdown); // 同路径：让脚本化冒烟（kill 默认 TERM）也能验证优雅退出
  server.on('close', () => process.exit(0));
}

if (isMainModule()) {
  main().catch((err) => {
    console.error(`[error] ${err?.message ?? err}`);
    process.exit(1);
  });
}
```

### C2 验证命令

```bash
cd /Users/peter/Documents/project/zcode-model-schedule/.worktrees/dashboard
# 1) 红证明（生产未落时）：node --test test/dashboard.test.mjs → ERR_MODULE_NOT_FOUND '../dashboard.mjs'
# 2) 生产落盘后：
node --test test/apply.test.mjs test/dashboard.test.mjs 2>&1 | tail -7
# 预期：# tests 153 / # pass 153 / # fail 0
```

### C2 commit

```
feat: dashboard HTTP entry with injected handler and trigger (cases 16-21)
```

---

## Card C3 — package.json script 收编 + 全量 verify + 冒烟（tier A）

- **Files**：`package.json`（修改，唯一改动文件）
- **依赖/并行**：依赖 C2；串行第 3 位
- **TDD 豁免**：配置文件改动（AGENTS.md IMPLEMENT 铁律例外清单）
- **验收**：`npm test` → 153 pass / 0 fail；冒烟四连：URL 打印 / status JSON schema=v1 / GET / 200 / SIGTERM/SIGINT 退出码 0

### C3-a 生产代码 — `package.json` scripts 块精确替换

**Before（现状，package.json:9-11）：**

```json
  "scripts": {
    "test": "node --test test/apply.test.mjs"
  },
```

**After：**

```json
  "scripts": {
    "test": "node --test test/*.test.mjs",
    "dashboard": "node dashboard.mjs"
  },
```

其余字段一律不动；无新增 dependencies（G5）。

### C3 验证命令

```bash
cd /Users/peter/Documents/project/zcode-model-schedule/.worktrees/dashboard
# 1) 全量 verify
npm test 2>&1 | tail -7
# 预期：# tests 153 / # pass 153 / # fail 0（132 存量 + 21 新增，exit 0）

# 2) 冒烟（端口 18787 避开 8787 冲突；后台 + SIGTERM 优雅退出）
node dashboard.mjs --port 18787 & SMOKE_PID=$!
sleep 1
curl -s http://127.0.0.1:18787/api/status | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(j.schema!=='zcode-model-schedule/dashboard/v1')process.exit(1);console.log('schema ok')})"
# 预期 stdout：schema ok
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18787/
# 预期：200
lsof -iTCP:18787 -sTCP:LISTEN
# 预期：仅 127.0.0.1:18787（无 *:18787 / 0.0.0.0）
kill $SMOKE_PID && wait $SMOKE_PID; echo "exit=$?"
# 预期：exit=0（SIGTERM → close → exit 0；与 SIGINT Ctrl+C 同路径）
```

冒烟备注：非交互 shell 的后台作业可能忽略 SIGINT（POSIX 行为），故冒烟用 `kill`（SIGTERM）验证同一条优雅退出路径；「Ctrl+C 退出码 0」由 SIGINT/SIGTERM 共用 shutdown 函数保证，主代理验收时可在前台终端人工 Ctrl+C 复核。

### C3 commit

```
chore: collect dashboard tests via glob and add dashboard script
```

---

## Self-Review（5 项，PLAN-B 完成自查）

1. **spec coverage**：21 用例 → C1=1-15（computeNextSwitch×7 / wallTimeToInstant×1 / activeWindow×1 / readJsonlLinesLocal×1 / buildDashboardData×4 / renderDashboardPage×1）、C2=16-21（handler×4 / runApplyIfDue×1 / startServer×1），一一映射无遗漏；Files 3 项全覆盖（lib/dashboard.mjs、dashboard.mjs、package.json）；Acceptance 逐条核对：153 全绿（C3 G10）、冒烟（C3 验证命令）、降级渲染（用例 12 断言「暂无数据」）、零依赖（G5 + C3 After 无 dependencies 变化）、触发回显（用例 19/20）、仅 loopback + 无 apiKey（C3 lsof 命令 + G6；全代码路径无 apiKey 引用）。已知留白（spec 既定）：parseArgs 无专测、/api/history 无专测（用例 17 只测 runs clamp）——均在 spec 21 用例清单范围内，不扩。
2. **placeholder scan**：无 TODO / 省略号 / 「照抄原文件」类指令替代代码；三个生产块 + 测试块全部完整可逐字落盘；模板拆 6 个 render 子函数 + renderClientScript（同文件，spec Risks 允许）。
3. **type consistency**：`parseHHMMLocal(value, label='dayWindows')`（spec 单参为默认参特例，语义同 config.mjs:22）；`wallTimeToInstant(year, month, day, minutes:number, timezone)`（用例 8 传 0，卡内已注明）；`computeNextSwitch(schedule, now=new Date())` → `{at: ISO(Z 串), toMode}|null`；`activeWindow` 返回窗口对象本体或 null；`buildDashboardData({4 路径, now})` 返回 shape 与 spec :31 字段一一对应（generatedAt=ISO、now=epoch ms）；deps 形状 `{configPath, statePath, historyPath, runLogPath, toolDir, now:()=>Date, spawnTrigger}` 测试侧 `httpDeps` 一致；handler 统一 `writeHead(status, headers)` 与 mockRes 匹配；`runApplyIfDue` 三态返回与用例 20 deepEqual 一致。
4. **可落盘性**：C1 测试只 import lib 模块（C2 前不触根 dashboard.mjs，红→绿次序成立）；mockRes/fire 不起端口、handler 纯 async 函数可直接调用；用例 21 端口 0 + closeIdleConnections + try/finally close 无挂起路径；用例 19 用未 resolve 的 gate promise 构造 in-flight（handler 同步段置位语义已在卡内注明）；C3 冒烟端口 18787 避让 8787，SIGTERM 路径在非交互 shell 可验证（SIGINT 忽略的 shell 行为已在卡内注明）；执行者无任何待决设计点。
5. **锚点实测**：已 Read 实测——`lib/config.mjs:22-29`（parseHHMM 逐字源）、`:43`（loadSchedule export）、`:87`（days 校验）、`:136-152`（parseSlotTime，parseSlotTime 确为 export，apply.test.mjs:15 已 import）、`:156-164`（inDayWindow，条件在 :161）、`:226`（to<=from 跨午夜禁止）；`lib/run-log.mjs:44-62`（readJsonlLines）、`:65-70`（readRunLogs，排序在 :68）；`lib/state.mjs:18`（loadState，损坏自愈 :35-39）；`apply.mjs:25-32`（路径常量）、`:37-45`（isMainModule 逐字源）、`:47-82`（parseArgs 风格）；`package.json:9-11`（scripts 块现状）；`lib/apply-core.mjs`（无 import 时副作用，run-log 依赖链安全）；baseline `npm test` = 132 pass / 0 fail 已实跑（2026-11-03）。

**自查结论**：5 项全过，无 placeholder、无待决设计点，可派 executor 按 C1 → C2 → C3 串行转写。
