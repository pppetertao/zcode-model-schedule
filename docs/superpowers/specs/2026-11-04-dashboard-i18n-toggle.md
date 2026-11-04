# 2026-11-04 dashboard 中英文切换

## Goal
为本地 dashboard 增加中/英语言切换：中文模式全中文化（含 KV 字段名/表头），英文模式全英文；服务端与客户端共享同一份文案字典，点按钮即时重绘、刷新保持。

## Files to Change

### 1. 新建 `lib/i18n.mjs`
零依赖，导出 `MESSAGES = { zh, en }` 与 `t(lang, key, params)`、`resolveLang(raw)`、`LANG_KEYS`、`LOCALES = { zh: 'zh-CN', en: 'en-US' }`。顶层结构：
```js
export const LANG_KEYS = ['zh', 'en'];
export const LOCALES = { zh: 'zh-CN', en: 'en-US' };
export const MESSAGES = { zh: { ... }, en: { ... } };
export function t(lang, key, params = {}) {
  const dict = MESSAGES[lang] ?? MESSAGES.zh;
  const tmpl = dict[key] ?? key; // 缺失 key 回退为 key 本身（fail-open）
  return String(tmpl).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}
export function resolveLang(raw) {
  return raw === 'en' ? 'en' : 'zh'; // 非 'en' 一律 zh（含 undefined/null/非法值）
}
```
**key 命名规范**：`<区块>.<项>`，如 `mode.state`、`runs.col.time`。**至少 20 个代表性 key（实现者照抄）**：

| key | zh | en |
|---|---|---|
| `mode.state` | 当前模式 | Current mode |
| `mode.desiredMode` | 期望模式 | Desired mode |
| `mode.inWindow` | 窗口内 | In window |
| `mode.activeWindow` | 活动窗口 | Active window |
| `mode.switchedAt` | 切换时间 | Switched at |
| `mode.inWindow.yes` | 是（白日窗） | Yes (day window) |
| `mode.inWindow.no` | 否（target 窗） | No (target window) |
| `avail.enabled` | 启用 | Enabled |
| `avail.endpoint` | 端点 | Endpoint |
| `avail.provider` | 提供方 | Provider |
| `avail.model` | 模型 | Model |
| `avail.timeout` | 超时 | Timeout |
| `avail.lastRunReason` | 上次运行原因 | Last run reason |
| `runs.col.time` | 时间 | Time |
| `runs.col.trigger` | 触发源 | Trigger |
| `runs.col.desiredMode` | 期望模式 | Desired mode |
| `runs.col.inWindow` | 窗口内 | In window |
| `runs.col.action` | 动作 | Action |
| `runs.col.availability` | 可用性 | Availability |
| `runs.col.changes` | 变更数 | Changes |
| `runs.col.duration` | 耗时 | Duration |
| `runs.col.exit` | 退出码 | Exit |
| `hist.col.mode` | 模式 | Mode |
| `hist.col.reason` | 原因 | Reason |
| `hist.col.agents` | 代理 | Agents |
| `dw.col.days` | 日期 | Days |
| `dw.col.from` | 开始 | From |
| `dw.col.to` | 结束 | To |
| `config.target` | 目标 | Target |
| `config.agents` | 代理 | Agents |
| `common.empty` | 暂无数据 | No data |
| `common.none` | 暂无数据 | No data |
| `next.none` | 暂无数据 | No data |
| `next.toTarget` | 切 target | Switch to target |
| `next.restore` | 恢复 original | Restore original |
| `next.soon` | 即将切换 | Switching soon |
| `next.countdown` | {time}（{m} 分 {s} 秒后 → {label}） | {time} ({m}m {s}s → {label}) |
| `banner.scheduleError` | schedule 加载失败：{msg} | Schedule load failed: {msg} |
| `banner.stateMissing` | state.json 不存在（尚未切换过） | state.json missing (never switched) |
| `banner.stateCorrupt` | state.json 损坏（已按 original 处理） | state.json corrupt (treated as original) |
| `trigger.button` | 手动触发 apply（--if-due，幂等） | Manually trigger apply (--if-due, idempotent) |
| `trigger.confirm` | 手动触发一次 apply --if-due（幂等，无强制覆盖）？ | Manually trigger one apply --if-due (idempotent, no force)? |
| `trigger.busy` | 已有触发进行中，请稍候 | A trigger is already running, please wait |
| `trigger.done` | 触发完成 exit={code} | Trigger finished exit={code} |
| `trigger.fail` | 触发失败 exit={code}（{msg}） | Trigger failed exit={code} ({msg}) |
| `trigger.network` | 触发请求失败（网络/服务异常） | Trigger request failed (network/server error) |
| `ui.toggleEn` | EN | EN |
| `ui.toggleZh` | 中文 | 中文 |
| `ui.lang` | 语言 | Language |
| `title` | 当前模式 | Current mode |
| `sec.currentMode` | 当前模式 | Current mode |
| `sec.availability` | 可用性 | Availability |
| `sec.recentRuns` | 最近运行（最多 10 条） | Recent runs (up to 10) |
| `sec.switchHistory` | 切换历史（最多 10 条） | Switch history (up to 10) |
| `sec.configSummary` | 配置摘要 | Config summary |
| `sec.manualTrigger` | 手动触发 | Manual trigger |
| `config.details` | 完整 config JSON | Full config JSON |

### 2. 修改 `lib/dashboard.mjs`（578 行）
- `:239 fmtDate(v)` → `fmtDate(v, lang)`：`d.toLocaleString(LOCALES[lang])`。
- `:245 renderBanners(data)` → `renderBanners(data, lang)`：三处文案套 `t(lang, 'banner.*', { msg })`。
- `:253 renderClock(data)` → `renderClock(data, lang)`：`fmtDate(..., lang)`。
- `:257 renderNextSwitch(data)` → `renderNextSwitch(data, lang)`：`next.none` / `next.toTarget` / `next.restore`。
- `:264 renderModeBlock(data)` → `renderModeBlock(data, lang)`：KV label 用 `mode.*`，`inWindow` 值用 `mode.inWindow.yes/no`。
- `:276 renderAvailabilityBlock(data)` → `renderAvailabilityBlock(data, lang)`。
- `:289 renderRunsTable(data)` → `renderRunsTable(data, lang)`：表头 9 个 `runs.col.*`，空态 `common.empty`。
- `:315 renderHistoryTable(data)` → `renderHistoryTable(data, lang)`：表头 4 个 `hist.col.*`。
- `:329 renderConfigSummary(data)` → `renderConfigSummary(data, lang)`：`config.*`、`dw.col.*`、`config.details`、空态。
- `:345 renderTriggerBlock()` → `renderTriggerBlock(lang)`：`trigger.button`。
- `:352 renderClientScript()` → `renderClientScript(lang)`：脚本内所有文案套 `t()`（见下方客户端清单），并注入 `window.__I18N__` 与 `window.__I18N_LANG__`。
- `:526 renderDashboardPage(data)` → `renderDashboardPage(data, { lang = 'zh' } = {})`：
  - `<html lang="${lang === 'en' ? 'en' : 'zh-CN'}">`；
  - 各 render* 调用传 `lang`；7 个 `<h2>` 区块标题套 `sec.*`；
  - header 区（`<h1>` 行）右侧加切换按钮（见下方 HTML）；
  - `<script>` 内注入 `window.__I18N__ = ${JSON.stringify(MESSAGES)}; window.__I18N_LANG__ = ${JSON.stringify(lang)};`（`MESSAGES` 经 `JSON.stringify`，无裸 `</script>` 风险——字典无该序列）。

**切换按钮 HTML（header 区，`<h1>` 右侧）**：
```html
<header style="display:flex;align-items:center;justify-content:space-between">
  <h1>zcode-model-schedule</h1>
  <button id="lang-toggle" type="button" data-i18n="${lang === 'en' ? 'ui.toggleZh' : 'ui.toggleEn'}">${lang === 'en' ? '中文' : 'EN'}</button>
</header>
```
CSS（并入 `:534-552` 内联 style）：`header { display:flex; align-items:center; justify-content:space-between; }`。

**客户端重绘覆盖清单（`renderClientScript` 内全部套 `t()`）**：`fmtTime` 用 `LOCALES[__I18N_LANG__]`；`fmtCountdown`（next.none/toTarget/restore/soon/countdown）；`fillTable` 空态 `common.empty`；`fillBanners` 三条 `banner.*`；`modePairs`/`availPairs`/`configPairs` 的 KV label 与 inWindow 值；`runCols`/`historyCols`/`dwCols` 表头；`config-json` 空态；trigger 的 `trigger.confirm/busy/done/fail/network`。切换逻辑：
```js
var I18N = window.__I18N__ || { zh: {}, en: {} };
var LANG = window.__I18N_LANG__ || 'zh';
function t(key, params) {
  var dict = I18N[LANG] || I18N.zh;
  var tmpl = dict[key] || key;
  return String(tmpl).replace(/\{(\w+)\}/g, function (m, k) { return (params && k in params) ? String(params[k]) : m; });
}
function setLang(lang) {
  LANG = lang;
  try { localStorage.setItem('zcode-dashboard-lang', lang); } catch (e) {}
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  var btn = el('lang-toggle');
  if (btn) btn.textContent = lang === 'en' ? t('ui.toggleZh') : t('ui.toggleEn');
  var nodes = document.querySelectorAll('[data-i18n]');
  for (var i = 0; i < nodes.length; i++) nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
  render(data); // 全量重绘（banner/clock/倒计时/KV/表格/空态）
}
el('lang-toggle').addEventListener('click', function () { setLang(LANG === 'en' ? 'zh' : 'en'); });
```
`data-i18n` 静态 re-label：服务端渲染的 7 个 `<h2>`、`config-details` summary、trigger 按钮文本、lang-toggle 自身加 `data-i18n="sec.*"` 等属性；客户端 `setLang` 一次性遍历 `[data-i18n]` 更新，再 `render(data)` 重画动态区。`render` 内 `text('clock', ...)` 等用 `t()` 后无需 data-i18n。

### 3. 修改 `dashboard.mjs`（198 行）
- `:106` `renderDashboardPage(await data())` → `renderDashboardPage(await data(), { lang: resolveLang(url.searchParams.get('lang')) })`。`/api/status`、`/api/runs`、`/api/history` 返回 JSON 数据，不含文案，**不**随 lang 变化（客户端用自身 LANG 渲染）。

### 4. 修改 `test/dashboard.test.mjs`（442 行）
- 新增 `describe('i18n')`：字典 key 对等（`Object.keys(MESSAGES.zh)` 与 `en` 深度相等、无空值）；`renderDashboardPage(d, {lang:'en'})` 含 `Current mode`、不含 `当前模式`、不含裸 `state.mode`；默认 `renderDashboardPage(d)` 含 `当前模式`、含 `state.mode` 的翻译「当前模式」；HTTP `GET /?lang=en` 返回英文 HTML、`GET /` 返回中文。
- 新增 `renderClientScript` 字符串断言：含 `__I18N__`、`zcode-dashboard-lang`、`data-i18n`。
- 现有断言**零改动**（默认 zh 保留「暂无数据」）：`:208` `renderDashboardPage(d).includes('暂无数据')` 仍成立；`:273` 区块 id 断言不变；`:277-279` 转义断言不变。

## Acceptance
1. `npm test` 全绿（含新增 i18n 用例）。
2. `node --test test/dashboard.test.mjs` 全绿。
3. 真浏览器：`npm run dashboard` → 打开 `http://127.0.0.1:8787` → 默认中文、字段名中文化（无裸 `state.mode`/`desiredMode` 等英文 key）→ 点右上角按钮 → 整页变英文（表头/KV/空态/倒计时/trigger 按钮全英文）→ 刷新后保持英文 → 再点按钮回中文 → 无控制台报错。
4. `http://127.0.0.1:8787/?lang=en` 直接英文；`/?lang=xx` 回落中文。
5. README：`README.md` Dashboard 节（`:79` 后）补一行「页面右上角可切换中/英文，选择会保存在浏览器 localStorage」；`README.en.md` Dashboard 节（`:79` 后）补英文对应句。两处均为一句话。

## Risks
- **服务端/客户端双份渲染**：文案在 `renderDashboardPage`（服务端）与 `renderClientScript`（客户端）各有一份，漏改任一侧会导致切换后部分区域不更新。缓解：客户端 `setLang` 全量 `render(data)` 重画动态区 + `data-i18n` 重标静态区，覆盖清单见 Files#2。
- **裸英文 key 残留**：中文模式下若某 KV label 未套 `t()`，会显示 `state.mode`。缓解：Acceptance#3 人工核验 + 测试断言 en/zh 下关键文案。
- **`localStorage` 不可用**（隐私模式/禁用）：`try/catch` 包裹，降级为仅本次会话生效。
- **`JSON.stringify(MESSAGES)` 注入**：字典无 `</script>` 序列，安全；仍按 `:527` 既有 `replace(/</g,'\\u003c')` 惯例处理。
- **现有测试回归**：仅 `:208` 断言页面文案，默认 zh 保留「暂无数据」，零改动；若实现者误改默认语言为 en 会破坏该断言。

## Exclusions
- 不改 `/api/*` JSON 响应结构（数据层不 i18n）。
- 不做语言自动检测（navigator.language）、不做 cookie、不加 npm 依赖、不引入框架。
- 不改 `apply.mjs`/`install.mjs`/`lib/config.mjs`/`state.mjs`/`run-log.mjs` 的文案（仅 dashboard 页面）。
- 不做翻译记忆/自定义词表；`original`/`target`/`state.mode` 等**数据值**（非 label）保持原样不翻译。