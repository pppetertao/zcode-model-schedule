// lib/config.mjs — 配置读取/校验/窗口判定（v2 schema：target + agents + dayWindows + availability）
// 被 apply.mjs、install.mjs、state.mjs 与 test/apply.test.mjs 调用；仅用 Node 内置模块
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const THOUGHT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const SCHEDULE_SCHEMA = 'zcode-model-schedule/v2';
const AGENT_KINDS = ['builtin', 'custom'];

// '~/x' → '<homedir>/x'；其余原样返回（用户绝对路径只能经本函数展开，代码与配置禁止硬编码）
export function expandHome(p) {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// custom agent 缺省 md 路径（spec：path 可省略 → ~/.zcode/agents/<name>.md）
export function defaultCustomAgentPath(name) {
  return path.join(os.homedir(), '.zcode', 'agents', `${name}.md`);
}

function parseHHMM(value, label) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) {
    throw new Error(`schedule ${label} 必须为 HH:MM 格式，实际: ${JSON.stringify(value)}`);
  }
  const [h, m] = value.split(':').map(Number);
  if (h > 23 || m > 59) throw new Error(`schedule ${label} 时间越界: ${value}`);
  return h * 60 + m;
}

function validateTimezone(tz) {
  if (typeof tz !== 'string' || tz.length === 0) {
    throw new Error('schedule.timezone 必须为非空 IANA tz 字符串');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch (err) {
    throw new Error(`schedule.timezone 非法 IANA tz: "${tz}"（${err.message}）`);
  }
}

// 读取并解析 schedule.json（v2 schema）；parse/结构错误直接 throw（apply.mjs 转 exit 1）
export function loadSchedule(configPath) {
  const resolved = expandHome(configPath);
  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new Error(`无法读取 schedule 配置 ${resolved}: ${err.message}`);
  }
  let schedule;
  try {
    schedule = JSON.parse(raw);
  } catch (err) {
    throw new Error(`schedule.json 解析失败 (${resolved}): ${err.message}`);
  }
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    throw new Error('schedule.json 顶层必须为对象');
  }
  if (schedule.$schema !== SCHEDULE_SCHEMA) {
    throw new Error(`schedule.$schema 必须为 "${SCHEDULE_SCHEMA}"，实际: ${JSON.stringify(schedule.$schema)}`);
  }
  validateTimezone(schedule.timezone);
  const t = schedule.target;
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('schedule.target 必须为对象');
  for (const key of ['providerId', 'modelId', 'reasoningLevel']) {
    if (typeof t[key] !== 'string' || t[key].length === 0) {
      throw new Error(`schedule.target.${key} 必须为非空字符串`);
    }
  }
  if (!Array.isArray(schedule.agents) || schedule.agents.length === 0) {
    throw new Error('schedule.agents 必须为非空数组');
  }
  for (const [i, a] of schedule.agents.entries()) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error(`schedule.agents[${i}] 必须为对象`);
    if (typeof a.name !== 'string' || a.name.length === 0) throw new Error(`schedule.agents[${i}].name 必须为非空字符串`);
    if (!AGENT_KINDS.includes(a.kind)) {
      throw new Error(`schedule.agents[${i}].kind 必须为 builtin|custom，实际: ${JSON.stringify(a.kind)}`);
    }
    if (a.kind === 'custom' && a.path !== undefined && (typeof a.path !== 'string' || a.path.length === 0)) {
      throw new Error(`schedule.agents[${i}].path 必须为非空字符串（kind=custom）`);
    }
  }
  if (!Array.isArray(schedule.dayWindows)) throw new Error('schedule.dayWindows 必须为数组');
  for (const [i, w] of schedule.dayWindows.entries()) {
    if (!w || typeof w !== 'object' || Array.isArray(w)) throw new Error(`schedule.dayWindows[${i}] 必须为对象`);
    if (!Array.isArray(w.days) || w.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      throw new Error(`schedule.dayWindows[${i}].days 必须为 1..7 的整数数组（1=Mon..7=Sun）`);
    }
    parseHHMM(w.from, `dayWindows[${i}].from`);
    parseHHMM(w.to, `dayWindows[${i}].to`);
  }
  const av = schedule.availability;
  if (!av || typeof av !== 'object' || Array.isArray(av)) throw new Error('schedule.availability 必须为对象');
  if (typeof av.enabled !== 'boolean') throw new Error('schedule.availability.enabled 必须为 boolean');
  if (av.enabled) {
    if (typeof av.endpoint !== 'string' || av.endpoint.length === 0) {
      throw new Error('schedule.availability.endpoint 必须为非空字符串');
    }
    if (typeof av.provider !== 'string' || av.provider.length === 0) {
      throw new Error('schedule.availability.provider 必须为非空字符串');
    }
    if (typeof av.model !== 'string' || av.model.length === 0) {
      throw new Error('schedule.availability.model 必须为非空字符串');
    }
    if (!Number.isInteger(av.timeout) || av.timeout <= 0) {
      throw new Error('schedule.availability.timeout 必须为正整数毫秒');
    }
  }
  return schedule;
}

// 读取 config.json 模型注册表 → Map<providerId, Map<modelId, Set<reasoningLevel>>>>
// 实测锚点：顶层键为 provider（单数）；levels 字段兼容 reasoning.levels（magpie）与 reasoning.variants（builtin:*）
export function loadModelRegistry(configJsonPath = '~/.zcode/v2/config.json') {
  const resolved = expandHome(configJsonPath);
  const raw = fs.readFileSync(resolved, 'utf8');
  const cfg = JSON.parse(raw);
  const providers = cfg.provider;
  if (!providers || typeof providers !== 'object') {
    throw new Error(`config.json 缺少 provider 字段: ${resolved}`);
  }
  const registry = new Map();
  for (const [providerId, p] of Object.entries(providers)) {
    const models = new Map();
    for (const [modelId, m] of Object.entries(p.models ?? {})) {
      const levels = m.reasoning?.levels ?? m.reasoning?.variants ?? [];
      models.set(modelId, new Set(levels));
    }
    registry.set(providerId, models);
  }
  return registry;
}

// ISO 周几 + 当日分钟数；day: 1=Mon..7=Sun，minutes: 0..1439
export function parseSlotTime(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(date);
  const pick = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const day = weekdayMap[pick('weekday')];
  if (day === undefined) throw new Error(`无法解析 weekday（timezone=${timezone}）: ${pick('weekday')}`);
  const hour = Number(pick('hour'));
  const minute = Number(pick('minute'));
  return { day, minutes: hour * 60 + minute };
}

// now 是否落在任一 dayWindow 内（同日区间 from <= minutes < to，to 严格不命中）
// true = 白天窗（用原模型）；false = target 窗（夜间/周末，切 target）
export function inDayWindow(schedule, now = new Date()) {
  const { day, minutes } = parseSlotTime(now, schedule.timezone);
  for (const w of schedule.dayWindows) {
    const from = parseHHMM(w.from, 'dayWindows.from');
    const to = parseHHMM(w.to, 'dayWindows.to');
    if (w.days.includes(day) && from <= minutes && minutes < to) return true;
  }
  return false;
}

// target 形状校验（三字段非空字符串）；供 dashboard 保存入口在注册表校验前使用
// 与 loadSchedule 的 target 校验同语义，错误文案面向「要保存的 target 输入」而非整个 schedule
export function validateTargetShape(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return [{ scope: 'target', reason: 'target 必须为对象' }];
  }
  const errors = [];
  for (const key of ['providerId', 'modelId', 'reasoningLevel']) {
    if (typeof target[key] !== 'string' || target[key].length === 0) {
      errors.push({ scope: `target.${key}`, reason: `${key} 必须为非空字符串` });
    }
  }
  return errors;
}

// target 三元组与注册表校验（validateSchedule 与 dashboard 保存入口共用）：
// providerId 在 registry → modelId+reasoningLevel 按 registry 校验；
// providerId 不在 registry（account:* 运行时别名）→ modelId 全局存在 + reasoningLevel ∈ THOUGHT_LEVELS
export function validateTarget(target, registry) {
  const errors = [];
  const t = target ?? {};
  const provider = registry.get(t.providerId);
  if (provider) {
    const levels = provider.get(t.modelId);
    if (!levels) {
      errors.push({ scope: 'target', reason: `modelId "${t.modelId}" 不在 provider "${t.providerId}" 下` });
    } else if (levels.size === 0) {
      // 模型未声明 reasoning 档位（config.json 允许）：无法按模型校验，退回 THOUGHT_LEVELS 枚举
      if (!THOUGHT_LEVELS.includes(t.reasoningLevel)) {
        errors.push({ scope: 'target', reason: `reasoningLevel "${t.reasoningLevel}" 必须 ∈ ${THOUGHT_LEVELS.join('/')}（"${t.providerId}/${t.modelId}" 未声明档位）` });
      }
    } else if (!levels.has(t.reasoningLevel)) {
      errors.push({ scope: 'target', reason: `reasoningLevel "${t.reasoningLevel}" 不在 "${t.providerId}/${t.modelId}" 支持列表 ${[...levels].join('/')}` });
    }
  } else {
    const globalModelIds = new Set();
    for (const models of registry.values()) {
      for (const mid of models.keys()) globalModelIds.add(mid);
    }
    if (!globalModelIds.has(t.modelId)) {
      errors.push({ scope: 'target', reason: `providerId "${t.providerId}" 不在注册表且 modelId "${t.modelId}" 全局不存在` });
    } else if (!THOUGHT_LEVELS.includes(t.reasoningLevel)) {
      errors.push({ scope: 'target', reason: `reasoningLevel "${t.reasoningLevel}" 必须 ∈ ${THOUGHT_LEVELS.join('/')}` });
    }
  }
  return errors;
}

// 原子写入 schedule 的 target 与 agents（dashboard 设置入口）：保留其余字段与文件 mode
// custom agent 若原配置带显式 path 则保留（否则走 defaultCustomAgentPath 缺省）
// 调用方负责写入前完成形状/注册表/候选校验；读/解析/写失败向上抛（dashboard 转 500）
export function saveScheduleSettings(configPath, { target, agents }) {
  const resolved = expandHome(configPath);
  const raw = fs.readFileSync(resolved, 'utf8');
  let schedule;
  try {
    schedule = JSON.parse(raw);
  } catch (err) {
    throw new Error(`schedule.json 解析失败 (${resolved}): ${err.message}`);
  }
  schedule.target = { providerId: target.providerId, modelId: target.modelId, reasoningLevel: target.reasoningLevel };
  const previous = new Map((Array.isArray(schedule.agents) ? schedule.agents : []).map((a) => [a.name, a]));
  schedule.agents = agents.map((a) => {
    const entry = { name: a.name, kind: a.kind };
    const prev = previous.get(a.name);
    if (a.kind === 'custom' && typeof prev?.path === 'string' && prev.path.length > 0) entry.path = prev.path;
    return entry;
  });
  const mode = fs.statSync(resolved).mode & 0o777;
  const tmp = `${resolved}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(schedule, null, 2) + '\n', { mode });
    fs.renameSync(tmp, resolved);
    fs.chmodSync(resolved, mode);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {
      // 吞掉清理时的 ENOENT/EACCES：tmp 未创建或不可删都由下方重抛的原始写错误定性，清理失败不覆盖根因
    }
    throw err;
  }
  return schedule;
}

// 校验 schedule 与模型注册表/文件系统的一致性；返回 { valid, errors }（errors 元素形状 { scope, reason }）
// target 三元组：见 validateTarget（与 dashboard 保存入口共用）
// agents：custom → 解析后的 path 文件必须存在；builtin → name 非空
// dayWindows：days 1..7、from/to HH:MM、to > from（不支持跨午夜，跨午夜配置 → exit 1）
export function validateSchedule(schedule, registry) {
  const errors = [];

  errors.push(...validateTarget(schedule.target ?? {}, registry));

  schedule.agents.forEach((agent, i) => {
    if (agent.kind === 'custom') {
      const mdPath = agent.path ? expandHome(agent.path) : defaultCustomAgentPath(agent.name);
      if (!fs.existsSync(mdPath)) {
        errors.push({ scope: `agents[${i}]`, reason: `custom agent "${agent.name}" 文件不存在: ${mdPath}` });
      }
    } else if (typeof agent.name !== 'string' || agent.name.length === 0) {
      errors.push({ scope: `agents[${i}]`, reason: 'builtin agent name 必须为非空字符串' });
    }
  });

  schedule.dayWindows.forEach((w, i) => {
    if (!Array.isArray(w.days) || w.days.length === 0 || w.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      errors.push({ scope: `dayWindows[${i}]`, reason: 'days 必须为 1..7 的非空整数数组（1=Mon..7=Sun）' });
    }
    let from;
    let to;
    try {
      from = parseHHMM(w.from, `dayWindows[${i}].from`);
    } catch (err) {
      errors.push({ scope: `dayWindows[${i}]`, reason: err.message });
    }
    try {
      to = parseHHMM(w.to, `dayWindows[${i}].to`);
    } catch (err) {
      errors.push({ scope: `dayWindows[${i}]`, reason: err.message });
    }
    if (from !== undefined && to !== undefined && to <= from) {
      errors.push({ scope: `dayWindows[${i}]`, reason: `不支持跨午夜窗口：to(${w.to}) 必须大于 from(${w.from})` });
    }
  });

  return { valid: errors.length === 0, errors };
}
