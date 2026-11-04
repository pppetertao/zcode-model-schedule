# PLAN — dashboard 中英文切换

## Header

- **目标一句话**：为本地 dashboard 增加中/英语言切换——服务端与客户端共享 `lib/i18n.mjs` 文案字典，中文模式全中文化（含 KV 字段名/表头），英文模式全英文，按钮即时重绘、`localStorage` 刷新保持、`?lang=` URL 可直达。
- **分支**：`fix/dashboard-i18n-toggle`
- **Spec**：`docs/superpowers/specs/2026-11-04-dashboard-i18n-toggle.md`（唯一需求源）
- **写作状态**：**PLAN-B 全部完成（B0+B1+B2 分段写作 + B-final 统查通过）**——Task 1-5 均为完整代码级卡（Task 5 为文档插入卡），executor 可按卡照抄执行；卡间 1→2→3→4→5 严格串行。

## Global Constraints（全卡约束）

1. **零依赖**：不新增 npm 包；`lib/i18n.mjs` 顶层无任何 `import`。
2. **ESM**：所有新建/修改文件均为 `.mjs` ESM；Node >=18（package.json engines）。
3. **客户端脚本原生 ES5**：`renderClientScript` 注入 `<script>` 的代码必须 ES5（`var`/`function` 声明，禁箭头函数、模板字符串、`const`/`let`、`??`、`?.`）；服务端 `lib/i18n.mjs` 不受此限。
4. **LF 换行**，禁 CRLF。
5. **默认语言 zh**：`resolveLang(raw)` 非 `'en'` 一律 `'zh'`；`renderDashboardPage` 默认 `lang='zh'`；**现有测试既有用例（用例 1-21）零改动**——尤其 `test/dashboard.test.mjs:208` 的 `renderDashboardPage(d).includes('暂无数据')` 依赖默认 zh 文案。
6. **数据值不翻译**：`original`/`target`/`state.mode`/`desiredMode` 值等数据保持原样，仅 label/表头/文案/banner/空态走 `t()`。
7. **`/api/*` JSON 响应结构不随 lang 变化**（数据层不 i18n）。
8. **`localStorage` 不可用降级**：客户端读写 `zcode-dashboard-lang` 一律 `try/catch` 包裹，降级为本次会话生效。
9. **TDD 铁律**：每卡先写失败测试并跑出红相（贴 stdout/exit code）→ 实现 → 绿 → `npm test` 回归，随卡 VERIFY。
10. **新增测试用例从 22 起编号**（既有文件用例 1-21；fixture/helper 复用现有 `makeTmpDir`/`baseSchedule`/`writeFullFixtures`）。
11. **测试归属**：全部 i18n 用例按 spec Files#4 放 `test/dashboard.test.mjs`（新增 `describe('i18n')` 等），**不建独立 `test/i18n.test.mjs`**——理由：spec Acceptance#2 的验证命令是 `node --test test/dashboard.test.mjs`，独立文件会脱离该命令覆盖；`test/*.test.mjs` glob 虽不冲突，但拆文件徒增 spec 偏离。
12. **双份渲染风险对策**（spec Risks#1）：服务端 `renderDashboardPage` 与客户端 `renderClientScript` 各持一份 `t()` 实现，文案同源靠注入 `window.__I18N__ = JSON.stringify(MESSAGES)`；客户端 `setLang` 全量 `render(data)` + `[data-i18n]` 静态重标。
13. **Commit 规约**：Conventional Commits（`feat:` 为主），一个卡一个逻辑 commit。

## 任务卡清单

| Task | 文件 | 内容 | tier | 状态 |
|---|---|---|---|---|
| Task 1 | 新建 `lib/i18n.mjs`；修改 `test/dashboard.test.mjs`（import 行 + 末尾 `describe('i18n')` 纯模块 3 用例） | 文案字典 + `t()`/`resolveLang()` | **A** | **B0 已写完整卡**（下方） |
| Task 2 | 修改 `lib/dashboard.mjs`（服务端渲染链：`:239`-`:526` 12 个函数签名 lang 化、7 个 `<h2>` `sec.*`、header 切换按钮 + CSS `:534-552`、`window.__I18N__` 注入）+ `test/dashboard.test.mjs` 服务端 lang 用例 | 服务端渲染 lang 化 | A | **B1 已填完整卡**（下方） |
| Task 3 | 修改 `lib/dashboard.mjs` `renderClientScript()`（`:352` 起，ES5 客户端 `t()`/`setLang`/重绘清单/`data-i18n`/`localStorage`/lang-toggle listener）+ `test/dashboard.test.mjs` 脚本字符串断言 | 客户端脚本 i18n | A | **B1 已填完整卡**（下方） |
| Task 4 | 修改 `dashboard.mjs:106` + `test/dashboard.test.mjs` HTTP lang 用例 | HTTP 层 lang 接线 | A | **B2 已填完整卡**（下方） |
| Task 5 | 修改 `README.md`、`README.en.md`（Dashboard 节各补一句话） | 文档同步 | B | **B2 已填完整卡**（下方） |

**卡间依赖**：1 → 2 → 3 → 4 → 5 严格串行（Task 2/3 同文件接口耦合：`renderDashboardPage(data, {lang})` 调 `renderClientScript(lang)`；Task 4 依赖 Task 2 的签名；Task 5 文档独立但默认串行）。Files 相交，禁并行。

---

## Task 1 — 新建 `lib/i18n.mjs` + i18n 纯模块测试（tier A：转写，代码写死，executor 照抄）

### Files

- **新建** `lib/i18n.mjs`（零依赖，无 import）
- **修改** `test/dashboard.test.mjs`（仅两处追加：import 区 1 行；文件末尾 1 个 describe 块。既有用例 1-21 零改动）

### 接口契约（spec Files#1）

```js
export const LANG_KEYS = ['zh', 'en'];            // 支持语言枚举
export const LOCALES = { zh: 'zh-CN', en: 'en-US' }; // lang → BCP47，供 toLocaleString
export const MESSAGES = { zh: {...}, en: {...} };   // 57 key，zh/en 完全对等
export function t(lang, key, params = {})           // 缺失 key 回退 key 本身（fail-open）；非法 lang 回落 zh；{name} 占位替换
export function resolveLang(raw)                    // 仅 'en' → 'en'，其余（含 undefined/null/''/非法值）→ 'zh'
```

### 锚点（已 grep 实测，B0 段）

- `test/dashboard.test.mjs:18` = `import { createRequestHandler, runApplyIfDue, startServer } from '../dashboard.mjs';`——新 import 行插在其后。
- `test/dashboard.test.mjs` 共 442 行，末行 `:442` = startServer describe 收尾 `});`——新 describe 块追加其后。
- `test/dashboard.test.mjs:208` = `assert.ok(renderDashboardPage(d).includes('暂无数据'))`——本卡不触碰，默认 zh 保证其不变。
- 既有 `^  test(` 计数 = **23**；本卡 +3 → 预期 26。
- `lib/i18n.mjs` 当前不存在（`ls lib/` 确认）——gap 真实，红相成立。
- key 清单 = spec Files#1 表 `:27-:83` 逐行核对共 **57** 个（7 mode + 6 avail + 9 runs.col + 3 hist.col + 3 dw.col + 2 config + 2 common + 5 next + 3 banner + 6 trigger + 3 ui + 1 title + 6 sec + 1 config.details）。

### TDD 步骤（严格按序）

1. **写失败测试**：按死清单 Edit `test/dashboard.test.mjs` 两处（下方测试代码块）。
2. **跑红**：`node --test test/dashboard.test.mjs` → 预期整个文件加载失败：`ERR_MODULE_NOT_FOUND`（找不到 `../lib/i18n.mjs`），exit code 非 0。
3. **实现**：Write `lib/i18n.mjs`（下方生产代码块）。
4. **跑绿**：`node --test test/dashboard.test.mjs` → 预期 `tests 26 / pass 26 / fail 0`，exit 0。
5. **回归**：`npm test` → 全绿，exit 0。

### 死清单（executor 逐条执行）

1. Edit `test/dashboard.test.mjs`：在 `:18` 的 `import { createRequestHandler, runApplyIfDue, startServer } from '../dashboard.mjs';` 行后插入一行 import（见测试代码块 §A）。
2. Edit `test/dashboard.test.mjs`：在文件末尾（`:442` startServer describe 收尾 `});` 之后）追加 describe 块（见测试代码块 §B）。
3. `node --test test/dashboard.test.mjs` → 确认红相为 `ERR_MODULE_NOT_FOUND`，贴 stdout。
4. Write `lib/i18n.mjs` = 生产代码块全文。
5. `node --test test/dashboard.test.mjs` → 贴 stdout（预期 26 pass 0 fail）。
6. `npm test` → 贴 stdout/exit code。
7. commit：`feat: add i18n message dictionary with t() and resolveLang`

### 生产代码块 — `lib/i18n.mjs`（新建，全文照抄）

```js
// lib/i18n.mjs — dashboard 中英文案字典与翻译函数（零依赖；仅服务端 import，客户端走 renderClientScript 内 ES5 版本）
export const LANG_KEYS = ['zh', 'en'];
export const LOCALES = { zh: 'zh-CN', en: 'en-US' };
export const MESSAGES = {
  zh: {
    'mode.state': '当前模式',
    'mode.desiredMode': '期望模式',
    'mode.inWindow': '窗口内',
    'mode.activeWindow': '活动窗口',
    'mode.switchedAt': '切换时间',
    'mode.inWindow.yes': '是（白日窗）',
    'mode.inWindow.no': '否（target 窗）',
    'avail.enabled': '启用',
    'avail.endpoint': '端点',
    'avail.provider': '提供方',
    'avail.model': '模型',
    'avail.timeout': '超时',
    'avail.lastRunReason': '上次运行原因',
    'runs.col.time': '时间',
    'runs.col.trigger': '触发源',
    'runs.col.desiredMode': '期望模式',
    'runs.col.inWindow': '窗口内',
    'runs.col.action': '动作',
    'runs.col.availability': '可用性',
    'runs.col.changes': '变更数',
    'runs.col.duration': '耗时',
    'runs.col.exit': '退出码',
    'hist.col.mode': '模式',
    'hist.col.reason': '原因',
    'hist.col.agents': '代理',
    'dw.col.days': '日期',
    'dw.col.from': '开始',
    'dw.col.to': '结束',
    'config.target': '目标',
    'config.agents': '代理',
    'common.empty': '暂无数据',
    'common.none': '暂无数据',
    'next.none': '暂无数据',
    'next.toTarget': '切 target',
    'next.restore': '恢复 original',
    'next.soon': '即将切换',
    'next.countdown': '{time}（{m} 分 {s} 秒后 → {label}）',
    'banner.scheduleError': 'schedule 加载失败：{msg}',
    'banner.stateMissing': 'state.json 不存在（尚未切换过）',
    'banner.stateCorrupt': 'state.json 损坏（已按 original 处理）',
    'trigger.button': '手动触发 apply（--if-due，幂等）',
    'trigger.confirm': '手动触发一次 apply --if-due（幂等，无强制覆盖）？',
    'trigger.busy': '已有触发进行中，请稍候',
    'trigger.done': '触发完成 exit={code}',
    'trigger.fail': '触发失败 exit={code}（{msg}）',
    'trigger.network': '触发请求失败（网络/服务异常）',
    'ui.toggleEn': 'EN',
    'ui.toggleZh': '中文',
    'ui.lang': '语言',
    'title': '当前模式',
    'sec.currentMode': '当前模式',
    'sec.availability': '可用性',
    'sec.recentRuns': '最近运行（最多 10 条）',
    'sec.switchHistory': '切换历史（最多 10 条）',
    'sec.configSummary': '配置摘要',
    'sec.manualTrigger': '手动触发',
    'config.details': '完整 config JSON',
  },
  en: {
    'mode.state': 'Current mode',
    'mode.desiredMode': 'Desired mode',
    'mode.inWindow': 'In window',
    'mode.activeWindow': 'Active window',
    'mode.switchedAt': 'Switched at',
    'mode.inWindow.yes': 'Yes (day window)',
    'mode.inWindow.no': 'No (target window)',
    'avail.enabled': 'Enabled',
    'avail.endpoint': 'Endpoint',
    'avail.provider': 'Provider',
    'avail.model': 'Model',
    'avail.timeout': 'Timeout',
    'avail.lastRunReason': 'Last run reason',
    'runs.col.time': 'Time',
    'runs.col.trigger': 'Trigger',
    'runs.col.desiredMode': 'Desired mode',
    'runs.col.inWindow': 'In window',
    'runs.col.action': 'Action',
    'runs.col.availability': 'Availability',
    'runs.col.changes': 'Changes',
    'runs.col.duration': 'Duration',
    'runs.col.exit': 'Exit',
    'hist.col.mode': 'Mode',
    'hist.col.reason': 'Reason',
    'hist.col.agents': 'Agents',
    'dw.col.days': 'Days',
    'dw.col.from': 'From',
    'dw.col.to': 'To',
    'config.target': 'Target',
    'config.agents': 'Agents',
    'common.empty': 'No data',
    'common.none': 'No data',
    'next.none': 'No data',
    'next.toTarget': 'Switch to target',
    'next.restore': 'Restore original',
    'next.soon': 'Switching soon',
    'next.countdown': '{time} ({m}m {s}s → {label})',
    'banner.scheduleError': 'Schedule load failed: {msg}',
    'banner.stateMissing': 'state.json missing (never switched)',
    'banner.stateCorrupt': 'state.json corrupt (treated as original)',
    'trigger.button': 'Manually trigger apply (--if-due, idempotent)',
    'trigger.confirm': 'Manually trigger one apply --if-due (idempotent, no force)?',
    'trigger.busy': 'A trigger is already running, please wait',
    'trigger.done': 'Trigger finished exit={code}',
    'trigger.fail': 'Trigger failed exit={code} ({msg})',
    'trigger.network': 'Trigger request failed (network/server error)',
    'ui.toggleEn': 'EN',
    'ui.toggleZh': '中文',
    'ui.lang': 'Language',
    'title': 'Current mode',
    'sec.currentMode': 'Current mode',
    'sec.availability': 'Availability',
    'sec.recentRuns': 'Recent runs (up to 10)',
    'sec.switchHistory': 'Switch history (up to 10)',
    'sec.configSummary': 'Config summary',
    'sec.manualTrigger': 'Manual trigger',
    'config.details': 'Full config JSON',
  },
};
export function t(lang, key, params = {}) {
  const dict = MESSAGES[lang] ?? MESSAGES.zh;
  const tmpl = dict[key] ?? key; // 缺失 key 回退为 key 本身（fail-open）
  return String(tmpl).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}
export function resolveLang(raw) {
  return raw === 'en' ? 'en' : 'zh'; // 非 'en' 一律 zh（含 undefined/null/非法值）
}
```

### 测试代码块 — `test/dashboard.test.mjs` 追加

**§A import 行**（插在 `:18` 之后）：

```js
import { MESSAGES, t, resolveLang, LOCALES, LANG_KEYS } from '../lib/i18n.mjs';
```

**§B describe 块**（追加在文件末尾 `:442` 收尾 `});` 之后）：

```js

// ===== i18n 追加（dashboard 中英文切换）：纯模块用例 22-24（字典/翻译函数/语言解析），不依赖 dashboard 改动 =====

describe('i18n', () => {
  // spec Files#1 表（:27-:83）穷尽 57 key；遍历断言防「两侧同漏」，对等断言防「单侧漏/多」
  const SPEC_KEYS = [
    'mode.state', 'mode.desiredMode', 'mode.inWindow', 'mode.activeWindow', 'mode.switchedAt',
    'mode.inWindow.yes', 'mode.inWindow.no',
    'avail.enabled', 'avail.endpoint', 'avail.provider', 'avail.model', 'avail.timeout', 'avail.lastRunReason',
    'runs.col.time', 'runs.col.trigger', 'runs.col.desiredMode', 'runs.col.inWindow', 'runs.col.action',
    'runs.col.availability', 'runs.col.changes', 'runs.col.duration', 'runs.col.exit',
    'hist.col.mode', 'hist.col.reason', 'hist.col.agents',
    'dw.col.days', 'dw.col.from', 'dw.col.to',
    'config.target', 'config.agents',
    'common.empty', 'common.none',
    'next.none', 'next.toTarget', 'next.restore', 'next.soon', 'next.countdown',
    'banner.scheduleError', 'banner.stateMissing', 'banner.stateCorrupt',
    'trigger.button', 'trigger.confirm', 'trigger.busy', 'trigger.done', 'trigger.fail', 'trigger.network',
    'ui.toggleEn', 'ui.toggleZh', 'ui.lang',
    'title',
    'sec.currentMode', 'sec.availability', 'sec.recentRuns', 'sec.switchHistory', 'sec.configSummary', 'sec.manualTrigger',
    'config.details',
  ];

  test('用例22 MESSAGES zh/en key 对等、无空值、覆盖 spec 全部 57 key', () => {
    const zhKeys = Object.keys(MESSAGES.zh);
    const enKeys = Object.keys(MESSAGES.en);
    assert.deepEqual([...enKeys].sort(), [...zhKeys].sort()); // 单侧漏/多 key 即红
    assert.equal(SPEC_KEYS.length, 57); // 本数组自身抄录完整性自检
    for (const k of SPEC_KEYS) {
      assert.ok(k in MESSAGES.zh, `zh 缺 key ${k}`); // 双侧同漏即红
      assert.ok(k in MESSAGES.en, `en 缺 key ${k}`);
    }
    for (const k of zhKeys) {
      assert.equal(typeof MESSAGES.zh[k], 'string');
      assert.ok(MESSAGES.zh[k].length > 0, `zh 空值 @ ${k}`);
      assert.equal(typeof MESSAGES.en[k], 'string');
      assert.ok(MESSAGES.en[k].length > 0, `en 空值 @ ${k}`);
    }
  });

  test('用例23 t() 基本翻译 / 参数替换 / 缺失 key 回退 / 非法 lang 回落 zh', () => {
    assert.equal(t('zh', 'mode.state'), '当前模式');
    assert.equal(t('en', 'mode.state'), 'Current mode');
    assert.equal(
      t('zh', 'next.countdown', { time: '23:10', m: 3, s: 20, label: 'target' }),
      '23:10（3 分 20 秒后 → target）',
    );
    assert.equal(
      t('en', 'next.countdown', { time: '23:10', m: 3, s: 20, label: 'target' }),
      '23:10 (3m 20s → target)',
    );
    assert.equal(t('zh', 'banner.scheduleError', { msg: 'oops' }), 'schedule 加载失败：oops');
    assert.equal(t('en', 'trigger.fail', { code: 2, msg: 'busy' }), 'Trigger failed exit=2 (busy)');
    assert.equal(t('zh', 'no.such.key'), 'no.such.key'); // 缺失 key fail-open 回退 key 本身
    assert.equal(t('zh', 'no.such.key', { x: 1 }), 'no.such.key'); // 占位不在模板中时不受 params 影响
    assert.equal(t('xx', 'mode.state'), '当前模式'); // 非法 lang 回落 zh
    assert.equal(t(undefined, 'mode.state'), '当前模式');
    assert.equal(t('zh', 'ui.toggleEn'), 'EN'); // zh 模式按钮显示 EN（点击切英）
    assert.equal(t('en', 'ui.toggleZh'), '中文'); // en 模式按钮显示中文（点击切回）
  });

  test('用例24 resolveLang 仅 en→en、其余一律 zh；LOCALES/LANG_KEYS 形状冻结', () => {
    assert.equal(resolveLang('en'), 'en');
    assert.equal(resolveLang('zh'), 'zh');
    assert.equal(resolveLang('xx'), 'zh');
    assert.equal(resolveLang('EN'), 'zh'); // 大小写敏感，不归一
    assert.equal(resolveLang(''), 'zh');
    assert.equal(resolveLang(undefined), 'zh');
    assert.equal(resolveLang(null), 'zh');
    assert.deepEqual(LOCALES, { zh: 'zh-CN', en: 'en-US' });
    assert.deepEqual(LANG_KEYS, ['zh', 'en']);
  });
});
```

### 验收（Task 1）

1. `node --test test/dashboard.test.mjs` → **26 pass / 0 fail**（23 既有 + 3 新增），exit 0。
2. `npm test` → 全绿，exit 0。
3. `lib/i18n.mjs` 无 import、导出恰为 `LANG_KEYS`/`LOCALES`/`MESSAGES`/`t`/`resolveLang` 五项。
4. 红相证据：步骤 2 的 `ERR_MODULE_NOT_FOUND` stdout 已贴。

---

## Task 2 — `lib/dashboard.mjs` 服务端渲染链 lang 化（tier A：转写，代码写死，executor 照抄）

- **Files**：修改 `lib/dashboard.mjs`（import 行 + 11 个整函数替换）；修改 `test/dashboard.test.mjs`（末尾追加用例 25-26 describe 块）。
- **接口签名**：`fmtDate(v, lang)`、`renderBanners(data, lang)`、`renderClock(data, lang)`、`renderNextSwitch(data, lang)`、`renderModeBlock(data, lang)`、`renderAvailabilityBlock(data, lang)`、`renderRunsTable(data, lang)`、`renderHistoryTable(data, lang)`、`renderConfigSummary(data, lang)`、`renderTriggerBlock(lang)`、`renderClientScript(lang)`（本卡只改签名，函数体 Task 3 替换）、`export function renderDashboardPage(data, { lang = 'zh' } = {})`。

### 锚点（B1 段 grep/Read 实测，Task 1 合入 5d80920 后）

- `lib/dashboard.mjs` 578 行未变；`:239 fmtDate` / `:245 renderBanners` / `:253 renderClock` / `:257 renderNextSwitch` / `:264 renderModeBlock` / `:276 renderAvailabilityBlock` / `:289 renderRunsTable` / `:315 renderHistoryTable` / `:329 renderConfigSummary` / `:345 renderTriggerBlock` / `:352 renderClientScript` / `:526 export function renderDashboardPage` 全部实测一致。
- **陷阱（必读）**：`lib/dashboard.mjs:332` 现有 `const t = c.target;` 与本卡 import 的 `t()` 冲突——替换版已改名 `const target = c.target;`，executor 不得保留旧名。
- `test/dashboard.test.mjs` 现 517 行（Task 1 追加后）：`:19` 已有 i18n import 行（本卡测试**不需要**新 import——`renderDashboardPage`/`buildDashboardData`/`writeFullFixtures`/`makeTmpDir`/`NOW_IN_WINDOW`/`path`/`assert` 均已在文件作用域）；文件末尾 `:517` = describe('i18n') 收尾 `});`，新块追加其后。
- 现状代码确认：服务端文案硬编码点 = `:242` `'zh-CN'`、`:247-249` banner 三条、`:259`/`:260` next.none/toTarget/restore、`:267-271` mode KV、`:279-284` avail KV、`:292`/:312 runs 空态/表头、`:318`/:326 history 空态/表头、`:331`/:341-342 config 空态/表头/summary、`:346` trigger 按钮、`:529` `lang="zh-CN"`、`:556-570` h1/h2 区。
- **归属微调（相对 spec Files#4）**：「不含裸 `state.mode`」整页断言放 Task 3 用例28（Task 2 阶段客户端脚本仍有该字面量，整页断言必假）；Task 2 用 `id="mode"` 区块片段断言替代，语义相同。

### TDD 步骤（严格按序）

1. **写失败测试**：死清单第 1 步（test 追加用例 25-26）。
2. **跑红**：`node --test test/dashboard.test.mjs` → 用例 25/26 fail（当前 `renderDashboardPage(data)` 忽略第二参数输出 zh：`<html lang="en">` 缺失等），1-24 pass；exit 非 0。
3. **实现**：死清单第 2-13 步（lib/dashboard.mjs import + 11 个整函数替换）。
4. **跑绿**：`node --test test/dashboard.test.mjs` → `tests 28 / pass 28 / fail 0`（23 旧 + 3 i18n + 2 新），exit 0。
5. **回归**：`npm test` 全绿，exit 0。

### 死清单（executor 逐条执行；行号以当前 578 行版本为准，每步用「整函数替换」= 以下方代码块整体替换同名函数从 `function`/`export function` 声明行到收尾 `}` 的完整文本）

1. Edit `test/dashboard.test.mjs`：文件末尾（`:517` describe('i18n') 收尾 `});` 之后）追加下方「测试代码块 §T2」全文。
2. `node --test test/dashboard.test.mjs` → 贴红相 stdout（用例 25/26 fail）。
3. Edit `lib/dashboard.mjs`：`:8`（`import { readRunLogs } from './run-log.mjs';`）之后插入一行：见下方代码块 §2.1。
4. Edit `lib/dashboard.mjs`：整函数替换 `fmtDate`（`:239-243`）→ §2.2。
5. 整函数替换 `renderBanners`（`:245-251`）→ §2.3。
6. 整函数替换 `renderClock`（`:253-255`）→ §2.4。
7. 整函数替换 `renderNextSwitch`（`:257-262`）→ §2.5。
8. 整函数替换 `renderModeBlock`（`:264-274`）→ §2.6。
9. 整函数替换 `renderAvailabilityBlock`（`:276-287`）→ §2.7。
10. 整函数替换 `renderRunsTable`（`:289-313`）→ §2.8。
11. 整函数替换 `renderHistoryTable`（`:315-327`）→ §2.9。
12. 整函数替换 `renderConfigSummary`（`:329-343`）→ §2.10（注意 `const target = c.target;` 改名）。
13. 整函数替换 `renderTriggerBlock`（`:345-347`）→ §2.11；Edit `:352` 签名行 `function renderClientScript() {` → `function renderClientScript(lang) {`（仅签名，函数体 Task 3 替换）。
14. 整函数替换 `renderDashboardPage`（`:526-578`）→ §2.12。
15. `node --test test/dashboard.test.mjs` → 贴绿 stdout（tests 28 / pass 28 / fail 0）。
16. `npm test` → 贴 stdout/exit code。
17. commit：`feat: localize dashboard server-side rendering with lang parameter`

### 生产代码块

**§2.1 import 行**（`:8` 后插入）：

```js
import { t, LOCALES, MESSAGES } from './i18n.mjs';
```

**§2.2 `fmtDate` 整函数替换（原 `:239-243`）**：

```js
function fmtDate(v, lang) {
  if (!v) return '-';
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(LOCALES[lang] ?? 'zh-CN');
}
```

**§2.3 `renderBanners` 整函数替换（原 `:245-251`）**：

```js
function renderBanners(data, lang) {
  const banners = [];
  if (data.scheduleError) banners.push(`<div class="banner error">${escapeHtml(t(lang, 'banner.scheduleError', { msg: data.scheduleError }))}</div>`);
  if (data.state?.missing) banners.push(`<div class="banner">${escapeHtml(t(lang, 'banner.stateMissing'))}</div>`);
  if (data.state?.corrupt) banners.push(`<div class="banner">${escapeHtml(t(lang, 'banner.stateCorrupt'))}</div>`);
  return banners.join('');
}
```

**§2.4 `renderClock` 整函数替换（原 `:253-255`）**：

```js
function renderClock(data, lang) {
  return escapeHtml(`${fmtDate(data.generatedAt, lang)}（${data.timezone ?? '-'}）`);
}
```

**§2.5 `renderNextSwitch` 整函数替换（原 `:257-262`）**：

```js
function renderNextSwitch(data, lang) {
  const ns = data.nextSwitch;
  if (!ns?.at) return t(lang, 'next.none');
  const label = ns.toMode === 'target' ? t(lang, 'next.toTarget') : t(lang, 'next.restore');
  return escapeHtml(`${fmtDate(ns.at, lang)} → ${label}`);
}
```

**§2.6 `renderModeBlock` 整函数替换（原 `:264-274`；数据值 `state.mode`/`desiredMode` 不翻译）**：

```js
function renderModeBlock(data, lang) {
  const w = data.activeWindow;
  const rows = [
    [t(lang, 'mode.state'), data.state?.mode ?? '-'],
    [t(lang, 'mode.desiredMode'), data.desiredMode ?? '-'],
    [t(lang, 'mode.inWindow'), data.inWindow === null || data.inWindow === undefined ? '-' : data.inWindow ? t(lang, 'mode.inWindow.yes') : t(lang, 'mode.inWindow.no')],
    [t(lang, 'mode.activeWindow'), w ? `${w.days.join('/')} ${w.from}-${w.to}` : '-'],
    [t(lang, 'mode.switchedAt'), fmtDate(data.state?.switchedAt, lang)],
  ];
  return rows.map(([k, v]) => `<span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span>`).join('');
}
```

**§2.7 `renderAvailabilityBlock` 整函数替换（原 `:276-287`；endpoint/provider/model 数据值不翻译）**：

```js
function renderAvailabilityBlock(data, lang) {
  const a = data.availability ?? {};
  const rows = [
    [t(lang, 'avail.enabled'), a.enabled ?? '-'],
    [t(lang, 'avail.endpoint'), a.endpoint ?? '-'],
    [t(lang, 'avail.provider'), a.provider ?? '-'],
    [t(lang, 'avail.model'), a.model ?? '-'],
    [t(lang, 'avail.timeout'), a.timeout === null || a.timeout === undefined ? '-' : `${a.timeout}ms`],
    [t(lang, 'avail.lastRunReason'), a.lastRunReason ?? '-'],
  ];
  return rows.map(([k, v]) => `<span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span>`).join('');
}
```

**§2.8 `renderRunsTable` 整函数替换（原 `:289-313`；9 列表头 `runs.col.*` + `data-i18n` 供客户端重标）**：

```js
function renderRunsTable(data, lang) {
  const rows = data.runs ?? [];
  const body = rows.length === 0
    ? `<tr><td colspan="9">${escapeHtml(t(lang, 'common.empty'))}</td></tr>`
    : rows
        .map((r) => {
          const fail = r.exitCode !== null && r.exitCode !== undefined && r.exitCode !== 0;
          const changes = Array.isArray(r.changes) ? String(r.changes.length) : `${r.changes ?? '-'}`;
          const duration = r.durationMs === null || r.durationMs === undefined ? '-' : `${r.durationMs}ms`;
          const cells = [
            fmtDate(r.time, lang),
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
  return `<table id="runs"><thead><tr><th data-i18n="runs.col.time">${t(lang, 'runs.col.time')}</th><th data-i18n="runs.col.trigger">${t(lang, 'runs.col.trigger')}</th><th data-i18n="runs.col.desiredMode">${t(lang, 'runs.col.desiredMode')}</th><th data-i18n="runs.col.inWindow">${t(lang, 'runs.col.inWindow')}</th><th data-i18n="runs.col.action">${t(lang, 'runs.col.action')}</th><th data-i18n="runs.col.availability">${t(lang, 'runs.col.availability')}</th><th data-i18n="runs.col.changes">${t(lang, 'runs.col.changes')}</th><th data-i18n="runs.col.duration">${t(lang, 'runs.col.duration')}</th><th data-i18n="runs.col.exit">${t(lang, 'runs.col.exit')}</th></tr></thead><tbody id="runs-body">${body}</tbody></table>`;
}
```

**§2.9 `renderHistoryTable` 整函数替换（原 `:315-327`；时间列复用 `runs.col.time`，spec 无 hist.col.time）**：

```js
function renderHistoryTable(data, lang) {
  const rows = data.history ?? [];
  const body = rows.length === 0
    ? `<tr><td colspan="4">${escapeHtml(t(lang, 'common.empty'))}</td></tr>`
    : rows
        .map((r) => {
          const agents = Array.isArray(r.agents) ? r.agents.join(', ') : `${r.agents ?? '-'}`;
          const cells = [fmtDate(r.time, lang), `${r.mode ?? '-'}`, `${r.reason ?? '-'}`, agents];
          return `<tr>${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`;
        })
        .join('');
  return `<table id="history"><thead><tr><th data-i18n="runs.col.time">${t(lang, 'runs.col.time')}</th><th data-i18n="hist.col.mode">${t(lang, 'hist.col.mode')}</th><th data-i18n="hist.col.reason">${t(lang, 'hist.col.reason')}</th><th data-i18n="hist.col.agents">${t(lang, 'hist.col.agents')}</th></tr></thead><tbody id="history-body">${body}</tbody></table>`;
}
```

**§2.10 `renderConfigSummary` 整函数替换（原 `:329-343`；`const t = c.target` 改名 `target` 避让 `t()`；空态 k='config' 为数据 key 性质保持字面量）**：

```js
function renderConfigSummary(data, lang) {
  const c = data.config;
  if (!c) return `<div id="config-kv" class="kv"><span class="k">config</span><span class="v">${escapeHtml(t(lang, 'common.empty'))}</span></div>`;
  const target = c.target;
  const agents = (c.agents ?? []).map((a) => `${a.name}(${a.kind})`).join(', ');
  const kv = [
    [t(lang, 'config.target'), `${target.providerId} / ${target.modelId} / ${target.reasoningLevel}`],
    [t(lang, 'config.agents'), agents],
  ].map(([k, v]) => `<span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span>`).join('');
  const dwRows = (c.dayWindows ?? [])
    .map((w) => `<tr><td>${escapeHtml(w.days.join('/'))}</td><td>${escapeHtml(w.from)}</td><td>${escapeHtml(w.to)}</td></tr>`)
    .join('');
  const dwBody = dwRows === '' ? `<tr><td colspan="3">${escapeHtml(t(lang, 'common.empty'))}</td></tr>` : dwRows;
  return `<div id="config-kv" class="kv">${kv}</div><table><thead><tr><th data-i18n="dw.col.days">${t(lang, 'dw.col.days')}</th><th data-i18n="dw.col.from">${t(lang, 'dw.col.from')}</th><th data-i18n="dw.col.to">${t(lang, 'dw.col.to')}</th></tr></thead><tbody id="dw-body">${dwBody}</tbody></table><details><summary data-i18n="config.details">${t(lang, 'config.details')}</summary><pre id="config-json">${escapeHtml(JSON.stringify(c, null, 2))}</pre></details>`;
}
```

**§2.11 `renderTriggerBlock` 整函数替换（原 `:345-347`）**：

```js
function renderTriggerBlock(lang) {
  return `<button id="trigger-btn" type="button" data-i18n="trigger.button">${t(lang, 'trigger.button')}</button><div id="trigger-result"></div>`;
}
```

**§2.12 `renderDashboardPage` 整函数替换（原 `:526-578`；CSS 增 header 行；h2 全部 `data-i18n="sec.*"`；header 切换按钮；`__I18N__`/`__I18N_LANG__` 注入沿用 `:527` `\u003c` 转义惯例）**：

```js
export function renderDashboardPage(data, { lang = 'zh' } = {}) {
  const initialData = JSON.stringify(data).replace(/</g, '\\u003c');
  const messages = JSON.stringify(MESSAGES).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="${lang === 'en' ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>zcode-model-schedule dashboard</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; margin: 0; background: #f5f5f7; color: #1d1d1f; }
  main { max-width: 880px; margin: 0 auto; padding: 16px; }
  header { display: flex; align-items: center; justify-content: space-between; }
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
<header><h1>zcode-model-schedule</h1><button id="lang-toggle" type="button" data-i18n="${lang === 'en' ? 'ui.toggleZh' : 'ui.toggleEn'}">${t(lang, lang === 'en' ? 'ui.toggleZh' : 'ui.toggleEn')}</button></header>
<div id="banners">${renderBanners(data, lang)}</div>
<div class="card"><span id="clock">${renderClock(data, lang)}</span><br><span id="next-switch">${renderNextSwitch(data, lang)}</span></div>
<h2 data-i18n="sec.currentMode">${t(lang, 'sec.currentMode')}</h2>
<div class="card kv" id="mode">${renderModeBlock(data, lang)}</div>
<h2 data-i18n="sec.availability">${t(lang, 'sec.availability')}</h2>
<div class="card kv" id="availability">${renderAvailabilityBlock(data, lang)}</div>
<h2 data-i18n="sec.recentRuns">${t(lang, 'sec.recentRuns')}</h2>
<div class="card">${renderRunsTable(data, lang)}</div>
<h2 data-i18n="sec.switchHistory">${t(lang, 'sec.switchHistory')}</h2>
<div class="card">${renderHistoryTable(data, lang)}</div>
<h2 data-i18n="sec.configSummary">${t(lang, 'sec.configSummary')}</h2>
<div class="card" id="config-summary">${renderConfigSummary(data, lang)}</div>
<h2 data-i18n="sec.manualTrigger">${t(lang, 'sec.manualTrigger')}</h2>
<div class="card" id="trigger">${renderTriggerBlock(lang)}</div>
</main>
<script type="application/json" id="initial-data">${initialData}</script>
<script>
window.__I18N__ = ${messages};
window.__I18N_LANG__ = ${JSON.stringify(lang)};
${renderClientScript(lang)}
</script>
</body>
</html>`;
}
```

### 测试代码块

**§T2 追加到 `test/dashboard.test.mjs` 末尾（`:517` 收尾 `});` 之后）**：

```js

// ===== i18n Task2 追加（用例 25-26）：renderDashboardPage 服务端 lang 渲染 =====

describe('renderDashboardPage i18n', () => {
  test('用例25 lang=en：html lang/en 文案/表头/KV label/按钮/注入全 t() 化，mode 区块无裸 state.mode', () => {
    const dir = makeTmpDir('i18n-en');
    const d = buildDashboardData({ ...writeFullFixtures(dir), now: NOW_IN_WINDOW });
    const html = renderDashboardPage(d, { lang: 'en' });
    const serverHtml = html.split('<script>')[0]; // 服务端渲染区（<script> 注入行的 __I18N__ 含 zh 字典全文属预期，排除后断言）
    assert.ok(html.includes('<html lang="en">'));
    assert.ok(html.includes('Current mode')); // h2 sec.currentMode + mode KV label
    assert.equal(serverHtml.includes('当前模式'), false);
    assert.ok(html.includes('<th data-i18n="runs.col.time">Time</th>'));
    assert.ok(html.includes('<th data-i18n="runs.col.availability">Availability</th>'));
    assert.ok(html.includes('<th data-i18n="dw.col.days">Days</th>'));
    assert.ok(html.includes('>Desired mode<')); // mode KV desiredMode label
    const modeKv = html.match(/<div class="card kv" id="mode">([\s\S]*?)<\/div>/)[1];
    assert.equal(modeKv.includes('>state.mode<'), false); // 服务端 KV label 不再裸 key（数据值仍原样）
    assert.ok(modeKv.includes('>In window<'));
    assert.ok(html.includes('data-i18n="config.details">Full config JSON</summary>'));
    assert.ok(html.includes('Manually trigger apply (--if-due, idempotent)')); // trigger 按钮文本
    assert.ok(html.includes('id="lang-toggle"'));
    assert.ok(html.includes('data-i18n="ui.toggleZh"')); // en 页按钮指向中文 key
    assert.ok(html.includes('>中文</button>')); // en 页按钮显示中文（点击切回）
    assert.ok(html.includes('window.__I18N__'));
    assert.ok(html.includes('window.__I18N_LANG__ = "en"'));
  });

  test('用例26 lang=en 全缺失数据 → 服务端空态 No data；默认 zh 保持中文且结构断言兼容', () => {
    const dir = makeTmpDir('i18n-empty-en');
    const d = buildDashboardData({
      configPath: path.join(dir, 'schedule.json'),
      statePath: path.join(dir, 'state.json'),
      historyPath: path.join(dir, 'history.jsonl'),
      runLogPath: path.join(dir, 'logs', 'runs.jsonl'),
      now: NOW_IN_WINDOW,
    });
    const htmlEn = renderDashboardPage(d, { lang: 'en' });
    assert.ok(htmlEn.includes('<td colspan="9">No data</td>')); // runs 空态（服务端区）
    const htmlZh = renderDashboardPage(d);
    assert.ok(htmlZh.includes('<td colspan="9">暂无数据</td>')); // 与 :208 断言同源（默认 zh）
    assert.ok(htmlZh.includes('当前模式'));
    assert.ok(htmlZh.includes('<html lang="zh-CN">'));
    assert.ok(htmlZh.includes('data-i18n="ui.toggleEn"')); // zh 页按钮指向英文 key
    assert.ok(htmlZh.includes('>EN</button>'));
    assert.ok(htmlZh.includes('<th data-i18n="runs.col.time">时间</th>'));
  });
});
```

### 验收（Task 2）

1. `node --test test/dashboard.test.mjs` → **tests 28 / pass 28 / fail 0**，exit 0。
2. `npm test` 全绿，exit 0。
3. 红相证据：死清单第 2 步 stdout（用例 25/26 fail、1-24 pass）已贴。
4. `lib/dashboard.mjs` 内 `const t =` 无残留（grep 应为 0 命中）；`renderClientScript(lang)` 签名已改、函数体未动（Task 3 范围）。

## Task 3 — `renderClientScript` 客户端脚本 i18n（tier A：转写，代码写死，executor 照抄）

- **Files**：修改 `lib/dashboard.mjs`（仅 `renderClientScript` 整函数替换，Task 2 后位于 `:352-524`）；修改 `test/dashboard.test.mjs`（末尾追加用例 27-28 describe 块）。
- **接口签名**：`renderClientScript(lang)`（签名 Task 2 已改）；返回字符串为 ES5 脚本：`var I18N = window.__I18N__ || { zh: {}, en: {} };`、`var LANG = window.__I18N_LANG__ || <服务端 lang JSON>;`、`function t(key, params)`、`function setLang(next)`（spec Files#2 给定逻辑逐字采用）、lang-toggle click listener、启动时 `localStorage.getItem('zcode-dashboard-lang')` 恢复（spec Acceptance#3 刷新保持的服务端侧机制）。

### 锚点（B1 段实测）

- `lib/dashboard.mjs:352-524` = `renderClientScript` 整函数（Task 2 已改 `:352` 签名为 `renderClientScript(lang)`；`:524` 收尾 `}`）；`:523` = 模板收尾反引号+分号。整函数替换区间不变。
- `test/dashboard.test.mjs`：Task 2 合入后为 28 用例（23 旧 + 3 i18n + 2 Task2），文件末尾 = 用例 26 的 describe('renderDashboardPage i18n') 收尾 `});`，新块追加其后。
- spec Files#2 与本卡的两处**已声明微调**（其余逐字）：
  1. `var LANG = window.__I18N_LANG__ || ${JSON.stringify(lang)};`（spec `:115` 为 `|| 'zh'`）——fallback 参数化，语义等价（服务端总注入 `__I18N_LANG__`，fallback 仅防御注入缺失）。
  2. 新增启动恢复段（spec Files#2 未写，Acceptance#3「刷新保持」必须）：`render(data)` 后读 `localStorage['zcode-dashboard-lang']`，合法值（`'en'`/`'zh'` 白名单）且异于当前 `LANG` 时 `setLang(saved)`；读操作 `try/catch`（隐私模式降级为服务端渲染语言）。
- 重绘覆盖清单 → 逐函数落点：`fmtTime`（`LOCALE_MAP[LANG]`，`LOCALE_MAP` = 服务端插值 `JSON.stringify(LOCALES)`）；`fmtCountdown`（next.none/toTarget/restore/soon/countdown）；`fillTable` 空态 `common.empty`；`fillBanners` 三条 `banner.*`；`modePairs`/`availPairs`/`configPairs` KV label + inWindow 值；`config-json` 空态；trigger `confirm/busy/done/fail/network`。表头不进客户端脚本——`<th>` 由服务端 `data-i18n` 属性（Task 2 已加）经 `setLang` 遍历重标。`runCols`/`historyCols`/`dwCols` 为数据值渲染器，零改动。

### TDD 步骤（严格按序）

1. **写失败测试**：死清单第 1 步（test 追加用例 27-28）。
2. **跑红**：`node --test test/dashboard.test.mjs` → 用例 27 fail（脚本无 `querySelectorAll('[data-i18n]')`/`localStorage.getItem`）、用例 28 fail（en 页残留脚本内中文 `'暂无数据'` 等），1-26 pass；exit 非 0。
3. **实现**：死清单第 3 步（`renderClientScript` 整函数替换 → §3.1）。
4. **跑绿**：`node --test test/dashboard.test.mjs` → `tests 30 / pass 30 / fail 0`，exit 0。
5. **回归**：`npm test` 全绿，exit 0。

### 死清单（executor 逐条执行）

1. Edit `test/dashboard.test.mjs`：文件末尾（用例 26 describe 收尾 `});` 之后）追加下方「测试代码块 §T3」全文。
2. `node --test test/dashboard.test.mjs` → 贴红相 stdout（用例 27/28 fail、1-26 pass）。
3. Edit `lib/dashboard.mjs`：整函数替换 `renderClientScript`（Task 2 后 `:352-524`，从 `function renderClientScript(lang) {` 到收尾 `}` 含末尾反引号行）→ 下方 §3.1 全文。
4. `node --test test/dashboard.test.mjs` → 贴绿 stdout（tests 30 / pass 30 / fail 0）。
5. `npm test` → 贴 stdout/exit code。
6. commit：`feat: localize dashboard client script with setLang and data-i18n redraw`

### 生产代码块

**§3.1 `renderClientScript` 整函数替换（Task 2 后 `:352-524`；全文照抄。ES5：var/function、无箭头/模板字面量/const/let/??；`${JSON.stringify(...)}` 为服务端插值输出 JSON 字面量，非运行时依赖）**：

```js
function renderClientScript(lang) {
  return `
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('initial-data').textContent);
  var I18N = window.__I18N__ || { zh: {}, en: {} };
  var LANG = window.__I18N_LANG__ || ${JSON.stringify(lang)};
  var LOCALE_MAP = ${JSON.stringify(LOCALES)};
  function el(id) { return document.getElementById(id); }
  function text(id, v) { var n = el(id); if (n) n.textContent = v; }
  function dash(v) { return v === null || v === undefined || v === '' ? '-' : String(v); }
  function t(key, params) {
    var dict = I18N[LANG] || I18N.zh;
    var tmpl = dict[key] || key;
    return String(tmpl).replace(/\\{(\\w+)\\}/g, function (m, k) { return (params && k in params) ? String(params[k]) : m; });
  }
  function fmtTime(v) {
    if (!v) return '-';
    var d = new Date(typeof v === 'number' ? v : String(v));
    return isNaN(d.getTime()) ? String(v) : d.toLocaleString(LOCALE_MAP[LANG] || 'zh-CN');
  }
  function fmtCountdown(next) {
    if (!next || !next.at) return t('next.none');
    var ms = new Date(next.at).getTime() - Date.now();
    var label = next.toMode === 'target' ? t('next.toTarget') : t('next.restore');
    if (ms <= 0) return t('next.soon') + ' → ' + label;
    var m = Math.floor(ms / 60000);
    var s = Math.floor((ms % 60000) / 1000);
    return t('next.countdown', { time: fmtTime(next.at), m: m, s: s, label: label });
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
      td0.textContent = t('common.empty');
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
    if (d.scheduleError) banners.push({ cls: 'banner error', msg: t('banner.scheduleError', { msg: d.scheduleError }) });
    if (d.state && d.state.missing) banners.push({ cls: 'banner', msg: t('banner.stateMissing') });
    if (d.state && d.state.corrupt) banners.push({ cls: 'banner', msg: t('banner.stateCorrupt') });
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
      [t('mode.state'), dash(d.state && d.state.mode)],
      [t('mode.desiredMode'), dash(d.desiredMode)],
      [t('mode.inWindow'), d.inWindow === null || d.inWindow === undefined ? '-' : (d.inWindow ? t('mode.inWindow.yes') : t('mode.inWindow.no'))],
      [t('mode.activeWindow'), w ? w.days.join('/') + ' ' + w.from + '-' + w.to : '-'],
      [t('mode.switchedAt'), fmtTime(d.state && d.state.switchedAt)]
    ];
  }
  function availPairs(d) {
    var a = d.availability || {};
    return [
      [t('avail.enabled'), dash(a.enabled)],
      [t('avail.endpoint'), dash(a.endpoint)],
      [t('avail.provider'), dash(a.provider)],
      [t('avail.model'), dash(a.model)],
      [t('avail.timeout'), a.timeout === null || a.timeout === undefined ? '-' : a.timeout + 'ms'],
      [t('avail.lastRunReason'), dash(a.lastRunReason)]
    ];
  }
  function configPairs(d) {
    var c = d.config;
    if (!c || !c.target) return [[t('config.target'), t('common.empty')], [t('config.agents'), t('common.empty')]];
    var names = (c.agents || []).map(function (a) { return a.name + '(' + a.kind + ')'; }).join(', ');
    return [
      [t('config.target'), c.target.providerId + ' / ' + c.target.modelId + ' / ' + c.target.reasoningLevel],
      [t('config.agents'), names]
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
    fillKv(el('config-kv'), configPairs(d));
    fillTable(el('dw-body'), d.config ? d.config.dayWindows : [], dwCols);
    text('config-json', d.config ? JSON.stringify(d.config, null, 2) : t('common.empty'));
  }
  function setLang(next) {
    LANG = next;
    try { localStorage.setItem('zcode-dashboard-lang', next); } catch (e) {
      // 吞掉 SecurityError/QuotaExceededError：localStorage 写不可用（隐私模式/禁用）时降级为本次会话生效，无可替代持久化路径
    }
    document.documentElement.lang = next === 'en' ? 'en' : 'zh-CN';
    var btn = el('lang-toggle');
    if (btn) btn.textContent = next === 'en' ? t('ui.toggleZh') : t('ui.toggleEn');
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    render(data);
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
  el('lang-toggle').addEventListener('click', function () { setLang(LANG === 'en' ? 'zh' : 'en'); });
  el('trigger-btn').addEventListener('click', function () {
    if (!window.confirm(t('trigger.confirm'))) return;
    var btn = el('trigger-btn');
    var result = el('trigger-result');
    btn.disabled = true;
    fetch('/api/trigger', { method: 'POST' }).then(function (res) {
      return res.json().then(function (body) { return { status: res.status, body: body }; });
    }).then(function (r) {
      var msg;
      if (r.status === 409) msg = t('trigger.busy');
      else if (r.body.ok) msg = t('trigger.done', { code: r.body.exitCode });
      else msg = t('trigger.fail', { code: r.body.exitCode, msg: r.body.error || r.body.stderr || '-' });
      result.textContent = msg;
      result.className = r.body.ok && r.status === 200 ? 'ok' : 'fail';
    }).catch(function () {
      // 吞掉触发 fetch 的网络错误：仅在结果区提示，不影响轮询（try 仅此一条语句）
      result.textContent = t('trigger.network');
      result.className = 'fail';
    }).then(function () {
      btn.disabled = false;
      refresh();
    });
  });
  render(data);
  try {
    var saved = localStorage.getItem('zcode-dashboard-lang');
    if ((saved === 'en' || saved === 'zh') && saved !== LANG) setLang(saved); // 刷新保持：localStorage 优先于服务端渲染语言（Acceptance#3）
  } catch (e) {
    // 吞掉 SecurityError：localStorage 读不可用（隐私模式/禁用）时保持服务端渲染语言，无其他恢复路径
  }
  startPolling();
})();
`;
}
```

### 测试代码块

**§T3 追加到 `test/dashboard.test.mjs` 末尾（用例 26 describe 收尾 `});` 之后）**：

```js

// ===== i18n Task3 追加（用例 27-28）：renderClientScript 客户端脚本 i18n =====

describe('renderClientScript i18n', () => {
  test('用例27 脚本含注入/切换/恢复机制关键串；ES5 合规（无箭头/模板字面量/const/let）', () => {
    const dir = makeTmpDir('i18n-script');
    const d = buildDashboardData({ ...writeFullFixtures(dir), now: NOW_IN_WINDOW });
    const html = renderDashboardPage(d);
    assert.ok(html.includes('window.__I18N__'));
    assert.ok(html.includes('zcode-dashboard-lang'));
    assert.ok(html.includes('data-i18n'));
    assert.ok(html.includes("querySelectorAll('[data-i18n]')"));
    assert.ok(html.includes("localStorage.setItem('zcode-dashboard-lang'"));
    assert.ok(html.includes("localStorage.getItem('zcode-dashboard-lang'"));
    assert.ok(html.includes("addEventListener('click'"));
    const script = html.split('(function () {\n')[1].split('\n})();')[0]; // 客户端纯脚本（排除 __I18N__ 注入行，字典值不受 ES5 断言误伤）
    assert.equal(script.includes('=>'), false); // 无箭头函数
    assert.equal(script.includes('`'), false); // 无模板字面量
    assert.equal(script.includes('const '), false);
    assert.equal(script.includes('let '), false);
  });

  test('用例28 lang=en 整页（含客户端脚本）无中文文案残留、无裸 state.mode；zh 页含恢复机制', () => {
    const dir = makeTmpDir('i18n-script-en');
    const d = buildDashboardData({ ...writeFullFixtures(dir), now: NOW_IN_WINDOW });
    const htmlEn = renderDashboardPage(d, { lang: 'en' });
    const serverHtmlEn = htmlEn.split('<script>')[0]; // 服务端渲染区
    const scriptEn = htmlEn.split('(function () {\n')[1].split('\n})();')[0]; // 客户端纯脚本（注入行的 __I18N__ 含 zh 字典属预期，从 IIFE 起截取排除）
    for (const zh of ['暂无数据', '当前模式', '期望模式', '窗口内', '手动触发', '切 target', '恢复 original', '是（白日窗）', '触发完成', '已有触发进行中']) {
      assert.equal(serverHtmlEn.includes(zh), false, `en 服务端区残留中文: ${zh}`);
      assert.equal(scriptEn.includes(zh), false, `en 客户端脚本残留中文: ${zh}`);
    }
    assert.ok(scriptEn.includes("t('mode.state')")); // 客户端 modePairs label 已 t() 化
    assert.equal(htmlEn.includes('"state.mode"'), false); // 无裸 state.mode 进入任何 JSON/标签（脚本内 d.state.mode 为数据访问表达式，不算裸 key）
    assert.ok(htmlEn.includes('Switching soon'));
    assert.ok(htmlEn.includes('Trigger finished exit='));
    const htmlZh = renderDashboardPage(d);
    assert.ok(htmlZh.includes('当前模式'));
    assert.ok(htmlZh.includes("localStorage.getItem('zcode-dashboard-lang')")); // 刷新保持机制在位
  });
});
```

### 验收（Task 3）

1. `node --test test/dashboard.test.mjs` → **tests 30 / pass 30 / fail 0**，exit 0。
2. `npm test` 全绿，exit 0。
3. 红相证据：死清单第 2 步 stdout（用例 27/28 fail、1-26 pass）已贴。
4. `lib/dashboard.mjs` `renderClientScript` 函数体内无硬编码中文文案字面量（注释中文除外）；ES5 断言（用例27）通过。

## Task 4 — `dashboard.mjs` HTTP 层 lang 接线（tier A：转写，代码写死，executor 照抄）

- **Files**：修改 `dashboard.mjs`（import 行 1 处 + `:106` 行替换 1 处）；修改 `test/dashboard.test.mjs`（末尾追加用例 29 describe 块）。
- **接口签名**：`GET /` handler → `renderDashboardPage(await data(), { lang: resolveLang(url.searchParams.get('lang')) })`；`/api/status`、`/api/runs`、`/api/history` 响应不变（lang 仅作用于 pathname `/` 分支）。

### 锚点（B2 段实测，Task 2 合入 3e0cd6a 后）

- `dashboard.mjs` 198 行未变；`:12` = `import { readRunLogs } from './lib/run-log.mjs';`（新 import 行插其后）；`:102` = `const url = new URL(req.url, 'http://127.0.0.1');`（`url` 变量在位）；`:106` = `        const html = renderDashboardPage(await data());`（8 空格缩进，全文件唯一）。
- `test/dashboard.test.mjs` 现 565 行（Task 3 合入后用例至 28）：文件末尾 = 用例 26 describe('renderDashboardPage i18n') 收尾 `});`，新块追加其后；`httpDeps`/`writeFullFixtures`/`makeTmpDir`/`createRequestHandler`/`startServer` 均已在文件作用域，**无需新 import**。
- 断言设计沿用 Task 3 修正：`<script>` 注入行含 zh 字典全文，lang 断言一律用 `body.split('<script>')[0]` 服务端渲染区。

### TDD 步骤（严格按序）

1. **写失败测试**：死清单第 1 步（test 追加用例 29）。
2. **跑红**：`node --test test/dashboard.test.mjs` → 用例 29 fail（未接线时 `/?lang=en` 返回 zh：`<html lang="en">` 缺失），1-30 pass；exit 非 0。
3. **实现**：死清单第 2-3 步。
4. **跑绿**：`node --test test/dashboard.test.mjs` → `tests 31 / pass 31 / fail 0`，exit 0。
5. **回归**：`npm test` 全绿，exit 0（本卡为整分支最后一卡，此步兼作 whole-branch 验证）。

### 死清单（executor 逐条执行）

1. Edit `test/dashboard.test.mjs`：文件末尾（用例 26 describe 收尾 `});` 之后）追加下方「测试代码块 §T4」全文。
2. `node --test test/dashboard.test.mjs` → 贴红相 stdout（用例 29 fail、1-30 pass）。
3. Edit `dashboard.mjs`：在 `:12` 的 `import { readRunLogs } from './lib/run-log.mjs';` 行后插入下方 §4.1 行。
4. Edit `dashboard.mjs`：将 `:106` 行 `        const html = renderDashboardPage(await data());` 整行替换为下方 §4.2 行。
5. `node --test test/dashboard.test.mjs` → 贴绿 stdout（tests 31 / pass 31 / fail 0）。
6. `npm test` → 贴 stdout/exit code（whole-branch 验证收尾）。
7. commit：`feat: wire lang query parameter into dashboard HTTP handler`

### 生产代码块

**§4.1 import 行**（`dashboard.mjs:12` 后插入）：

```js
import { resolveLang } from './lib/i18n.mjs';
```

**§4.2 `:106` 行替换**（old → new，整行）：

```js
        const html = renderDashboardPage(await data(), { lang: resolveLang(url.searchParams.get('lang')) });
```

### 测试代码块

**§T4 追加到 `test/dashboard.test.mjs` 末尾（用例 26 describe 收尾 `});` 之后）**：

```js

// ===== i18n Task4 追加（用例 29）：dashboard.mjs HTTP 层 lang 接线 =====

describe('dashboard HTTP lang', () => {
  test('用例29 GET /?lang=en 英文、GET / 中文、/?lang=xx 回落中文（port 0 集成）', async () => {
    const dir = makeTmpDir('http-lang');
    const handler = createRequestHandler(httpDeps(writeFullFixtures(dir)));
    let server;
    try {
      server = await startServer({ handler, port: 0 });
      const base = `http://127.0.0.1:${server.address().port}`;
      const htmlEn = await (await fetch(`${base}/?lang=en`)).text();
      assert.ok(htmlEn.includes('<html lang="en">'));
      assert.ok(htmlEn.split('<script>')[0].includes('Current mode')); // 服务端渲染区（<script> 注入含 zh 字典属预期）
      assert.equal(htmlEn.split('<script>')[0].includes('当前模式'), false);
      const htmlZh = await (await fetch(`${base}/`)).text();
      assert.ok(htmlZh.includes('<html lang="zh-CN">'));
      assert.ok(htmlZh.split('<script>')[0].includes('当前模式'));
      const htmlXx = await (await fetch(`${base}/?lang=xx`)).text();
      assert.ok(htmlXx.includes('<html lang="zh-CN">')); // 非法 lang 回落 zh
      assert.ok(htmlXx.split('<script>')[0].includes('当前模式'));
    } finally {
      if (server) {
        server.closeIdleConnections?.();
        await new Promise((resolve) => server.close(resolve)); // try/finally 兜底 close，禁止挂起
      }
    }
  });
});
```

### 验收（Task 4）

1. `node --test test/dashboard.test.mjs` → **tests 31 / pass 31 / fail 0**，exit 0。
2. `npm test` 全绿，exit 0（whole-branch 验证收尾）。
3. 红相证据：死清单第 2 步 stdout（用例 29 fail、1-30 pass）已贴。
4. `/api/status`/`/api/runs`/`/api/history` 响应 JSON 结构零变化（用例 17/19/21 既有断言仍绿即证）。

## Task 5 — README 双语一句话（tier B：机械插入，死清单明确；文档改动免 TDD）

- **Files**：修改 `README.md`（`:79` 行后插入 1 行）、修改 `README.en.md`（`:79` 行后插入 1 行）。无其他改动。

### 锚点（B2 段实测）

- `README.md:79` = `页面包含：当前模式、可用性、最近运行（最多 10 条）、切换历史（最多 10 条）、配置摘要、手动触发。`——spec Acceptance#5「Dashboard 节（:79 后）」实测吻合（Dashboard 节标题 `:69`）；`:80` 为空行、`:81` 起列表。
- `README.en.md:79` = `The page shows: current mode, availability, recent runs (up to 10), switch history (up to 10), a config summary, and a manual trigger button.`；`:80` 空行、`:81` 起列表。
- 两文件当前分别 226/215 行；插入结构 = 原 `:79` 句 + **分隔空行** + 新句（markdown 独立段落，避免软换行），插入后各 +2 行 → 228/217，原 `:80` 空行自然成为新句与 `:81` 列表区之间的分隔。

### 死清单（executor 逐条执行）

1. Edit `README.md`：将 `:79` 行替换为下方 §5.1（原行 + 空行 + 新句，共三行）。
2. Edit `README.en.md`：将 `:79` 行替换为下方 §5.2。
3. 验证：`grep -c "页面右上角可切换中/英文" README.md` → 1；`grep -c "toggles the page between Chinese and English" README.en.md` → 1；`wc -l README.md README.en.md` → 228 / 217。
4. commit：`docs: mention dashboard language toggle in READMEs`

### 插入文本

**§5.1 `README.md:79` 行替换**（old = 原 `:79` 行；new = 三行——原行 + 分隔空行 + 新句）：

```markdown
页面包含：当前模式、可用性、最近运行（最多 10 条）、切换历史（最多 10 条）、配置摘要、手动触发。

页面右上角可切换中/英文，选择会保存在浏览器 localStorage。
```

**§5.2 `README.en.md:79` 行替换**（old = 原 `:79` 行；new = 三行——原行 + 分隔空行 + 新句）：

```markdown
The page shows: current mode, availability, recent runs (up to 10), switch history (up to 10), a config summary, and a manual trigger button.

The top-right button toggles the page between Chinese and English; the choice is saved in the browser's localStorage.
```

### 验收（Task 5）

1. 两句各恰好命中一次（`grep -c` = 1），插入位置在 Dashboard 节内、`:81` 列表区之前，新句为独立段落（前后各一空行）。
2. 两文件行数各 +2（228/217，新句 + 段落分隔空行），无其他行变动（`git diff --stat` = 2 files changed, 4 insertions(+)）。
3. 文档轻量验收：正 grep 通过即绿（免 TDD，AGENTS.md IMPLEMENT 豁免类）。

---

## B0 自查记录（implementer 自查 5 项，范围=本段产出）

1. **spec coverage（B0 部分）**：Task 1 覆盖 spec Files#1 全部内容——5 项导出、`t()`/`resolveLang()` 逐字采用 spec `:14-21` 代码、57 key 字典逐行对照 `:27-:83` 表格（zh/en 值逐格照抄）；Task 2-5 骨架分别覆盖 Files#2/Files#3/Files#4 拆分与 Acceptance#5，无 spec 条目遗漏到卡外。
2. **placeholder scan**：Task 1 生产/测试代码块均为可照抄全文，无 TODO/`...`/伪代码；Task 2-5 骨架明确标注「B1/B2 填码」属分段写作约定而非占位符。
3. **type consistency**：`t(lang, key, params = {})` 参数与用例实参一致（字符串 lang、字符串 key、对象 params）；测试断言期望值逐条对照字典字面量（含全角括号/全角冒号/`→`）；`resolveLang` 返回值仅 `'en'`/`'zh'`。
4. **可落盘性**（含实跑验证）：测试代码块与现有文件风格一致（node:test `describe`/`test`、`assert/strict`、用例编号接续 22-24）；import 插入点与末尾追加点均给出 grep 实测锚点（`:18`、`:442`）；不与既有任何标识符冲突（`i18n`/`SPEC_KEYS`/`MESSAGES` 等在测试文件中无同名）。**实跑证据（B0 段，/tmp 一次性目录，已清理）**：将本卡两个代码块原样提取为 `lib/i18n.mjs` + 测试文件运行 `node` → `# tests 3 / pass 3 / fail 0`，exit 0；移除 `lib/i18n.mjs` 复跑 → `throw new ERR_MODULE_NOT_FOUND`（红相成立，TDD gap 真实）。
5. **锚点实测**：见 Task 1 锚点节——`:18`/`:208`/442 行/23 test/`lib/i18n.mjs` 不存在/lib/dashboard.mjs 12 函数行号/`dashboard.mjs:106`/`:526`/`:527`/`:534-552` 全部 grep/awk 实测通过，与 spec 行号一致；字典 key 计数实测 57×2（`grep -c "^    '[a-z]*\..*': "` = 112 + `'title'` 无点号 2 行 = 114）。

## B1 自查记录（implementer 自查 4 项，范围=Task 2/3 完整卡）

1. **spec coverage**：spec Files#2 全部落点入卡——12 函数签名 lang 化（含 `renderClientScript(lang)` 签名）、7 处区块标题 `sec.*` + `data-i18n`（页面实际 6 个 `<h2>` + config-details summary + trigger 按钮，spec「7 个 h2」按实际页面 6 h2 落地，sec.* 6 key 全用）、header 切换按钮/CSS、`__I18N__`/`__I18N_LANG__` 注入（`\u003c` 惯例沿用）、`<html lang>`、客户端重绘清单逐函数落点（fmtTime/fmtCountdown/fillTable/fillBanners/modePairs/availPairs/configPairs/config-json 空态/trigger 五文案）；表头经服务端 `<th data-i18n>` + `setLang` 遍历重标（spec Files#2「runCols/historyCols/dwCols 表头」的落地机制：runCols 等为数据值渲染器，客户端无 thead 渲染）；Acceptance#3「刷新保持」补启动恢复段（spec Files#2 未写，卡内已声明为微调）。Files#4 断言落点：`__I18N__`/`zcode-dashboard-lang`/`data-i18n` → 用例 27。
2. **placeholder scan**：Task 2 卡 13 块（import + 11 整函数 + 测试块）、Task 3 卡 2 块（整函数 + 测试块）均为可整段照抄全文，无 TODO/`...`/伪代码。
3. **type consistency**：服务端 `t(lang, key, params)` 与客户端闭包 `t(key, params)` 双签名并存为 spec 设计（客户端 LANG 在闭包内）；`fmtDate(v, lang)` 所有调用点已在替换块内同步传 lang；`renderConfigSummary` 内 `const t = c.target` 已改名 `target` 避让；trigger.fail 的 `{msg}` 参数化 `r.body.error || r.body.stderr || '-'` 防占位残留（原实现 error 缺失时无括号段，新版有 `(-)` 兜底，行为微变已在卡内注明）。
4. **锚点实测 + 可落盘性实跑（/tmp 一次性副本，已清理）**：从本 PLAN.md 提取两卡代码块，按死清单在 578 行原始副本上模拟 executor 全流程——T2 追加用例 25/26 → 红（tests 28 / pass 26 / fail 2）→ 应用 import + 12 区间替换（原行号区间直接命中）→ 绿（tests 28 / pass 28 / fail 0）；T3 追加用例 27/28 → 红（tests 30 / pass 28 / fail 2）→ 按「签名行 + 模板收尾 `` `; `` + `}`」定位整函数替换（实测 353-525）→ 绿（tests 30 / pass 30 / fail 0）。
5. **实跑驱动的 3 处断言修正（已回写卡内）**：① `__I18N__` 注入行含 zh 字典全文，en 页整页 `!includes(中文)` 必假 → 改对服务端渲染区（`split('<script>')[0]`）与客户端纯脚本（IIFE 起截）分段断言；② 客户端 `dash(d.state && d.state.mode)` 为数据访问表达式，含 `state.mode` 连写串不属裸 key → 改正向断言 `t('mode.state')` 在位 + 仅禁 `"state.mode"`（带引号 JSON key 形式）；③ ES5 断言提取段同 ① 排除注入行。

## B-final 自查（implementer 5 项统查，范围=Task 1-5 全卡）

### 1. spec coverage（跨全卡）

| spec 条目 | 落卡 | 状态 |
|---|---|---|
| Files#1 字典 57 key + `MESSAGES`/`t`/`resolveLang`/`LANG_KEYS`/`LOCALES` | Task 1（逐字） | 已覆盖 |
| Files#2 12 函数签名/header 按钮/CSS/`__I18N__` 注入/`<html lang>`/h2 `sec.*`/`data-i18n` | Task 2（服务端）+ Task 3（客户端重绘清单逐函数落点） | 已覆盖 |
| Files#3 `:106` 接线 + import；`/api/*` 不变 | Task 4 | 已覆盖 |
| Files#4 测试（字典对等/服务端 en·zh/脚本断言/HTTP lang） | 用例 22-24 + 25/26 + 27/28 + 29 | 已覆盖（现有断言 1-21 零改动，三段测试块均为纯追加） |
| Acceptance#1/2（npm test / node --test 全绿） | Task 2/3/4 死清单；Task 4 兼 whole-branch 收尾 | 已覆盖 |
| Acceptance#5（README 两句） | Task 5（实测 `:79` 锚点恰为 spec 所指行） | 已覆盖 |
| **Acceptance#3/4 真浏览器人工项** | 代码侧已全落地（默认 zh/按钮即时重绘/localStorage 刷新保持/`?lang=` 直达/xx 回落） | **C 档留白声明**：真机验证（点按钮→整页切换→刷新保持→控制台无报错）无法由 executor 卡完成，留作 episode 收尾由主代理/用户按 spec Acceptance#3/4 步骤人工核验，不阻塞实现卡 |
| Exclusions（/api 结构/无自动检测/无新依赖/不碰 apply·install·config·state·run-log） | 全卡 Files 均未涉及上述文件；Task 4 用例 17/19/21 既有断言守护 /api | 已遵守 |

### 2. placeholder scan（跨全卡）

Task 1（2 块）+ Task 2（13 块）+ Task 3（2 块）+ Task 4（3 块）+ Task 5（2 块 markdown）均为可整段照抄全文；无 TODO/`...`/「待定」/伪代码；B0-B1 骨架占位标记已全部消除。PLAN 中仅存的中文省略号出现在注释性描述（Global Constraints 语义说明），非代码块。

### 3. type consistency（跨全卡）

- `t` 双签名并存（服务端 `t(lang, key, params)` / 客户端闭包 `t(key, params)`）= spec Files#1/Files#2 设计；客户端 LANG 在闭包内无需 lang 参数（Task 3 卡已声明 fallback 参数化微调）。
- `fmtDate(v, lang)` 全部 4 个调用点（renderClock/renderNextSwitch/renderModeBlock/renderRunsTable）均在替换块内同步传 lang；`renderClientScript(lang)` 签名 Task 2 改、Task 3 用（fallback 内联）。
- `renderConfigSummary` 局部 `const t` 已改名 `target`（避让 import 的 `t`）；grep 确认无其他遮蔽点。
- `url` 变量 `:102` 定义、`:106` 使用，同 handler 作用域（B2 实测）。
- 用例编号连续 22-29；test 总数预期链 26→28→30→31 与三段实跑完全一致。

### 4. 可落盘性（跨全卡实跑汇总，/tmp 一次性副本均已清理）

| 卡 | 验证方式 | 结果 |
|---|---|---|
| Task 1 | B0：代码块提取实跑 | 3 用例绿（tests 3 / pass 3 / fail 0）+ 红相 `ERR_MODULE_NOT_FOUND` |
| Task 2 | B1：原行号区间补丁模拟 | 红 26/28 → 绿 **28/28/0** |
| Task 3 | B1：签名行+模板收尾定位整替换 | 红 28/30 → 绿 **30/30/0** |
| Task 4 | B2：`:12` import 插入 + `:106` 行替换（old 行唯一命中） | 红 30/31 → 绿 **31/31/0** |
| Task 5 | B2：`:79` 行替换（old 行逐字命中） | grep=1 且 wc=228/217 |

全部代码块从本 PLAN.md 原样提取跑通，executor 零决策可执行。

### 5. 锚点实测（跨全卡）

- Task 1：test `:18`/`:442`（Task 1 前）、lib/dashboard.mjs 12 函数行号、`lib/i18n.mjs` 不存在。
- Task 2/3：lib 578 行区间替换全部直接命中；renderClientScript 定位 353-525（签名行 + 模板收尾 `` `; `` + `}` 三点定位）。
- Task 4：`dashboard.mjs:12`（import 锚）、`:102`（url 定义）、`:106`（old 行全文件唯一）——Task 2 合入后 198 行未偏移。
- Task 5：README 两文件 `:79` 行内容逐字匹配（Dashboard 节标题 `:69`，spec 所指 `:79` 即「页面包含：…/The page shows: …」行，无偏移）。
- spec 行号偏差仅一处：spec Files#2 称「7 个 `<h2>`」实为 6 个（sec.* 恰 6 key），按实际页面落地并已在 B1 自查声明。

### 结论

PLAN-B 写作闭环：5 卡均为完整代码级卡且实跑验证通过，无遗留骨架与占位；可直接进入 IMPLEMENT（executor 按 Task 1→5 串行派发；Acceptance#3/4 真机核验留 episode 收尾）。
