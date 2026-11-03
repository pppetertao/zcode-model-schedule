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
