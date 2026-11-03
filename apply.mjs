#!/usr/bin/env node
// apply.mjs — CLI 入口：解析参数 → 算 desiredMode → 检可用性 → 切换/恢复 → 写 state → 退出码
// 退出码：0=成功/无需变更/不可用跳过/if-due 跳过/dry-run；1=校验/参数/运行时错误；2=锁占用（LockBusyError）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadSchedule, loadModelRegistry, validateSchedule, inDayWindow, expandHome, defaultCustomAgentPath } from './lib/config.mjs';
import { checkAvailability } from './lib/availability.mjs';
import { loadState, saveState, captureSnapshot } from './lib/state.mjs';
import {
  LockBusyError,
  acquireLock,
  releaseLock,
  computeTargetState,
  diffBuiltinState,
  applyBuiltinOverrides,
  applyCustomAgent,
  computeCustomAgentChanges,
  appendHistory,
  modeChanged,
} from './lib/apply-core.mjs';
import { RUN_LOG_SCHEMA, appendRunLog, readRunLogs, formatRunRecord, summarizeError } from './lib/run-log.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(TOOL_DIR, 'schedule.json');
const AGENTS_STATE_PATH = path.join(os.homedir(), '.zcode', 'v2', 'agents-state.json');
const AGENTS_DIR = path.join(os.homedir(), '.zcode', 'agents');
const STATE_PATH = path.join(TOOL_DIR, 'state.json'); // 工具自身状态（区别于 AGENTS_STATE_PATH，锚点补全 #1）
const HISTORY_PATH = path.join(TOOL_DIR, 'history.jsonl');
const LOCK_PATH = path.join(TOOL_DIR, '.apply.lock');
const RUN_LOG_PATH = path.join(TOOL_DIR, 'logs', 'runs.jsonl'); // 结构化运行日志（run-log/v1，1MiB 轮转 + .1 一份）
const USAGE = '用法: node apply.mjs [--config <path>] [--dry-run] [--status] [--force] [--if-due] [--logs [-n <N>]] [--trigger <name>]';

// 直接执行判定：argv[1] 经 realpath 对比（容忍 symlink 部署）
// ENOENT：argv[1] 指向已删除文件 → 不可能为本模块入口，按非入口处理
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

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

// custom agent 的 md 路径：显式 path 优先（expandHome），缺省 ~/.zcode/agents/<name>.md（defaultCustomAgentPath）
function resolveCustomPath(agent) {
  return agent.path ? expandHome(agent.path) : defaultCustomAgentPath(agent.name);
}

// 计算给定 desiredMode 下的变更清单（只读，不写任何文件）；供 --dry-run 展示
function collectChanges(schedule, desiredMode, state) {
  const target = computeTargetState(schedule, desiredMode, state.snapshot);
  const changes = [];
  let currentOverrides = {};
  try {
    currentOverrides = JSON.parse(fs.readFileSync(AGENTS_STATE_PATH, 'utf8')).builtInModelSelectionOverrides ?? {};
  } catch (err) {
    // agents-state.json 读不到：dry-run 当前 builtin 视为空（全部按新增展示）；仅影响展示，不影响执行路径
    console.error(`[warn] 读取 ${AGENTS_STATE_PATH} 失败: ${err.message}`);
  }
  if (Object.keys(target.builtin).length > 0) {
    changes.push(...diffBuiltinState({ builtInModelSelectionOverrides: currentOverrides }, target.builtin).changes);
  }
  for (const agent of schedule.agents) {
    if (agent.kind !== 'custom') continue;
    const tgt = target.custom[agent.name];
    if (!tgt) continue;
    try {
      const raw = fs.readFileSync(resolveCustomPath(agent), 'utf8');
      for (const c of computeCustomAgentChanges(raw, tgt).changes) {
        changes.push({ agent: agent.name, field: c.field, old: c.old, new: c.new });
      }
    } catch (err) {
      // md 读不到/frontmatter 非法：dry-run 展示为错误项；正式执行路径同场景会 throw → exit 1
      changes.push({ agent: agent.name, field: '(file)', old: null, new: `不可读: ${err.message}` });
    }
  }
  return { target, changes };
}

// 变更明细（只读，dry-run 同源）；只读计算抛错 → null（明细仅观测用，不阻断执行路径）
function collectChangesSafe(schedule, desiredMode, state) {
  try {
    return collectChanges(schedule, desiredMode, state).changes;
  } catch {
    // 吞掉只读 diff 计算异常（computeTargetState/readFileSync 系）：变更明细仅观测用，主路径不由它驱动（try 仅一条语句）
    return null;
  }
}

// 将 target.builtin / target.custom 落盘（switch 与 restore 共用；缺快照的条目已被 computeTargetState 跳过）
function applyTarget(schedule, target, { force = false } = {}) {
  if (Object.keys(target.builtin).length > 0) applyBuiltinOverrides(AGENTS_STATE_PATH, target.builtin, { force });
  for (const agent of schedule.agents) {
    if (agent.kind !== 'custom') continue;
    const tgt = target.custom[agent.name];
    if (tgt) applyCustomAgent(resolveCustomPath(agent), tgt, { force });
  }
}

function printStatus(schedule, desiredMode, state, avail) {
  console.log(`timezone: ${schedule.timezone}`);
  console.log(`current mode: ${state.mode}${state.switchedAt ? ` (switchedAt: ${state.switchedAt})` : ''}`);
  console.log(`desired mode: ${desiredMode}`);
  console.log(`availability: ${avail.available ? 'available' : `unavailable (${avail.reason})`}`);
  console.log(`snapshot: ${state.snapshot ? JSON.stringify(state.snapshot) : '(none)'}`);
}

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

    const lockToken = acquireLock(LOCK_PATH); // LockBusyError → 下方 catch 落记录后 exit 2
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
      releaseLock(LOCK_PATH, lockToken);
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

if (isMainModule()) {
  main().catch((err) => {
    if (err instanceof LockBusyError) {
      console.error(`[locked] ${err.message}`);
      process.exit(2);
    }
    console.error(`[error] ${err?.message ?? err}`);
    process.exit(1);
  });
}
