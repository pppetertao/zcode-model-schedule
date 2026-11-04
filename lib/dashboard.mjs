// lib/dashboard.mjs — dashboard 只读聚合层 + 内联 HTML 模板（零依赖，可无端口单测）
// spec: docs/superpowers/specs/2026-11-03-dashboard.md
// 本地复刻 parseHHMM（lib/config.mjs:22-29）与 readJsonlLines（lib/run-log.mjs:44-62）：
// 不 import 存量私有函数、不改存量模块（G4）；聚合层绝不 throw（G6，降级渲染）
import fs from 'node:fs';
import { loadSchedule, parseSlotTime } from './config.mjs';
import { loadState } from './state.mjs';
import { readRunLogs } from './run-log.mjs';
import { t, LOCALES, MESSAGES } from './i18n.mjs';

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
// 14 天覆盖每个 weekday ≥2 次 → days 非空（buildDashboardData 的窗口不变量校验已拦住空数组）时必非 null（spec 用例 7）。
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
    for (const [i, w] of schedule.dayWindows.entries()) {
      if (!Array.isArray(w.days) || w.days.length === 0) {
        throw new Error(`schedule.dayWindows[${i}].days 不能为空`);
      }
      if (parseHHMMLocal(w.to) <= parseHHMMLocal(w.from)) {
        throw new Error(`schedule.dayWindows[${i}] 不支持跨午夜窗口：to(${w.to}) 必须大于 from(${w.from})`);
      }
    }
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
  let allHistory = [];
  try {
    allHistory = readJsonlLinesLocal(historyPath);
  } catch (err) {
    // 吞掉 history.jsonl 读错误（EISDIR 等）：同 runs，降级空列表不阻断渲染（绝不 throw 契约）
    allHistory = [];
  }
  // 合法 JSON 值 null 也可能来自 history.jsonl，先滤掉非对象行，再排序（比较器用可选链兜底）
  const history = allHistory
    .filter((r) => r !== null && typeof r === 'object')
    .sort((a, b) => String(b?.time ?? '').localeCompare(String(a?.time ?? '')))
    .slice(0, 10);

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

function fmtDate(v, lang) {
  if (!v) return '-';
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(LOCALES[lang] ?? 'zh-CN');
}

function renderBanners(data, lang) {
  const banners = [];
  if (data.scheduleError) banners.push(`<div class="banner error">${escapeHtml(t(lang, 'banner.scheduleError', { msg: data.scheduleError }))}</div>`);
  if (data.state?.missing) banners.push(`<div class="banner">${escapeHtml(t(lang, 'banner.stateMissing'))}</div>`);
  if (data.state?.corrupt) banners.push(`<div class="banner">${escapeHtml(t(lang, 'banner.stateCorrupt'))}</div>`);
  return banners.join('');
}

function renderClock(data, lang) {
  // 时区括号随语言切换：zh 用全角「（）」，en 用半角「()」——否则 en 页残留 CJK 全角标点
  const lp = lang === 'en' ? '(' : '（';
  const rp = lang === 'en' ? ')' : '）';
  return escapeHtml(`${fmtDate(data.generatedAt, lang)}${lp}${data.timezone ?? '-'}${rp}`);
}

function renderNextSwitch(data, lang) {
  const ns = data.nextSwitch;
  if (!ns?.at) return t(lang, 'next.none');
  const label = ns.toMode === 'target' ? t(lang, 'next.toTarget') : t(lang, 'next.restore');
  return escapeHtml(`${fmtDate(ns.at, lang)} → ${label}`);
}

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

function renderTriggerBlock(lang) {
  return `<button id="trigger-btn" type="button" data-i18n="trigger.button">${t(lang, 'trigger.button')}</button><div id="trigger-result"></div>`;
}

// 客户端脚本：JSON.parse 初始数据 → setInterval 5s fetch /api/status 局部重渲染；
// document.hidden 暂停轮询；触发按钮 confirm() → POST /api/trigger → 结果 + 立即重拉。
// 注意：本函数返回的脚本内禁用模板插值（纯字符串拼接），避免与外层模板字面量的 ${} 冲突。
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
    var lp = LANG === 'en' ? '(' : '（';
    var rp = LANG === 'en' ? ')' : '）';
    text('clock', fmtTime(d.generatedAt) + lp + dash(d.timezone) + rp);
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
    if (btn) btn.setAttribute('data-i18n', next === 'en' ? 'ui.toggleZh' : 'ui.toggleEn');
    if (btn) btn.setAttribute('aria-label', t('ui.lang'));
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    var tres = el('trigger-result');
    if (tres) tres.textContent = '';
    render(data);
  }
  var timer = null;
  function refresh() {
    return fetch('/api/status').then(function (res) {
      if (res.ok) return res.json().then(function (d) { data = d; render(d); });
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
    // URL 显式带 lang 参数时以服务端渲染语言为准，跳过 localStorage 恢复；无参数时刷新保持（Acceptance#3）
    if (location.search.indexOf('lang=') === -1 && (saved === 'en' || saved === 'zh') && saved !== LANG) setLang(saved);
  } catch (e) {
    // 吞掉 SecurityError：localStorage 读不可用（隐私模式/禁用）时保持服务端渲染语言，无其他恢复路径
  }
  startPolling();
})();
`;
}

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
<header><h1>zcode-model-schedule</h1><button id="lang-toggle" type="button" aria-label="${t(lang, 'ui.lang')}" data-i18n="${lang === 'en' ? 'ui.toggleZh' : 'ui.toggleEn'}">${t(lang, lang === 'en' ? 'ui.toggleZh' : 'ui.toggleEn')}</button></header>
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
