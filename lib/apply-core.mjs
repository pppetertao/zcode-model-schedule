// lib/apply-core.mjs — 计算目标态 → diff → 原子写 → history → 锁（v2：mode 驱动 + 快照）
// 被 apply.mjs CLI 与 test/apply.test.mjs 调用；仅用 Node 内置模块
import fs from 'node:fs';
import path from 'node:path';

export class LockBusyError extends Error {
  constructor(lockPath) {
    super(`apply 锁被占用: ${lockPath}`);
    this.name = 'LockBusyError';
    this.code = 'LOCK_BUSY';
  }
}

// 计算目标态（v2 签名：mode 驱动 + 快照）
// mode='target' → 各 agent 映射 schedule.target：
//   builtin → {providerId, modelId, options:{reasoningLevel}}；custom → {model: 'providerId/modelId', thoughtLevel}
// mode='original' → 从 snapshot 恢复切换前值；
//   snapshot 为 null / 缺该 agent / 值不完整（builtin 缺 providerId|modelId、custom 缺 model|thoughtLevel）→ 该 agent 跳过
// 返回 { builtin: { <name>: {providerId, modelId, options:{reasoningLevel}} },
//         custom:  { <name>: {model, thoughtLevel} } }
export function computeTargetState(schedule, mode, snapshot) {
  const builtin = {};
  const custom = {};
  const t = schedule.target;
  for (const agent of schedule.agents) {
    if (mode === 'target') {
      if (agent.kind === 'builtin') {
        builtin[agent.name] = { providerId: t.providerId, modelId: t.modelId, options: { reasoningLevel: t.reasoningLevel } };
      } else {
        custom[agent.name] = { model: `${t.providerId}/${t.modelId}`, thoughtLevel: t.reasoningLevel };
      }
    } else {
      const snap = snapshot?.[agent.name];
      if (!snap) continue; // 快照缺该 agent → 跳过（不恢复）
      if (agent.kind === 'builtin') {
        if (snap.providerId == null || snap.modelId == null) continue;
        builtin[agent.name] = { providerId: snap.providerId, modelId: snap.modelId, options: { reasoningLevel: snap.options?.reasoningLevel } };
      } else {
        if (snap.model == null || snap.thoughtLevel == null) continue; // md 缺行无法逐字节恢复 → 跳过
        custom[agent.name] = { model: snap.model, thoughtLevel: snap.thoughtLevel };
      }
    }
  }
  return { builtin, custom };
}

// diff 当前 state vs 目标 state；只比 builtInModelSelectionOverrides[agent] 的
// providerId / modelId / options.reasoningLevel；当前态缺 key 视为新增（old=null）
export function diffBuiltinState(currentState, targetState) {
  const changes = [];
  const currentOverrides = currentState?.builtInModelSelectionOverrides ?? {};
  for (const agent of Object.keys(targetState)) {
    const cur = currentOverrides[agent] ?? {};
    const tgt = targetState[agent];
    const fields = [
      ['providerId', cur.providerId, tgt.providerId],
      ['modelId', cur.modelId, tgt.modelId],
      ['reasoningLevel', cur.options?.reasoningLevel, tgt.options.reasoningLevel],
    ];
    for (const [field, oldV, newV] of fields) {
      if (oldV !== newV) changes.push({ agent, field, old: oldV ?? null, new: newV });
    }
  }
  return { changed: changes.length > 0, changes };
}

// 原子写：同目录 tmp + rename；rename 后 chmod 恢复 mode
function writeAtomic(targetPath, data, mode) {
  const tmp = `${targetPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, targetPath);
  fs.chmodSync(targetPath, mode);
}

// 原子写入 agents-state.json：JSON.parse → 浅合并目标字段 → tmp + rename，mode 保持
// 只改 builtInModelSelectionOverrides 的目标 key；不动 builtInModelOverrides /
// builtInThoughtLevelOverrides / disabledAgentIds / pluginAgentModelSelectionOverrides
// 幂等：无 diff 且非 force 时不写文件
export function applyBuiltinOverrides(statePath, targetState, { force = false } = {}) {
  const raw = fs.readFileSync(statePath, 'utf8');
  const state = JSON.parse(raw);
  const { changed, changes } = diffBuiltinState(state, targetState);
  if (!changed && !force) {
    return { written: false, reason: 'no-change', path: statePath, changes };
  }
  const mode = fs.statSync(statePath).mode & 0o777;
  const overrides = state.builtInModelSelectionOverrides ?? {};
  for (const agent of Object.keys(targetState)) {
    overrides[agent] = {
      providerId: targetState[agent].providerId,
      modelId: targetState[agent].modelId,
      options: { reasoningLevel: targetState[agent].options.reasoningLevel },
    };
  }
  state.builtInModelSelectionOverrides = overrides;
  writeAtomic(statePath, JSON.stringify(state, null, 2) + '\n', mode);
  return { written: true, path: statePath, changes };
}

// 纯函数：给定 md 原文与目标 {model, thoughtLevel}，返回 { changes, output }
// 只替换 frontmatter 内 model: / thoughtLevel: 两行（正则 ^(model|thoughtLevel):\s*.+$ 语义）；
// thoughtLevel 行不存在时插入到 model 行后；frontmatter 边界 --- 之外内容不动；
// 无 frontmatter / 缺 model: 行 → throw
export function computeCustomAgentChanges(raw, target) {
  const lines = raw.split('\n');
  if ((lines[0] ?? '').trim() !== '---') {
    throw new Error('自定义 agent 文件缺少 YAML frontmatter（首行必须为 ---）');
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) throw new Error('自定义 agent 文件 frontmatter 未闭合（缺少结束 ---）');
  const modelRe = /^model:\s*.+$/;
  const thoughtRe = /^thoughtLevel:\s*.+$/;
  let modelLineIdx = -1;
  let thoughtLineIdx = -1;
  for (let i = 1; i < endIdx; i++) {
    if (modelLineIdx === -1 && modelRe.test(lines[i])) modelLineIdx = i;
    else if (thoughtRe.test(lines[i])) thoughtLineIdx = i;
  }
  if (modelLineIdx === -1) throw new Error('自定义 agent 文件 frontmatter 缺少 model: 行');
  const changes = [];
  const newModelLine = `model: ${target.model}`;
  if (lines[modelLineIdx] !== newModelLine) {
    changes.push({ field: 'model', old: lines[modelLineIdx], new: newModelLine });
    lines[modelLineIdx] = newModelLine;
  }
  const newThoughtLine = `thoughtLevel: ${target.thoughtLevel}`;
  if (thoughtLineIdx !== -1) {
    if (lines[thoughtLineIdx] !== newThoughtLine) {
      changes.push({ field: 'thoughtLevel', old: lines[thoughtLineIdx], new: newThoughtLine });
      lines[thoughtLineIdx] = newThoughtLine;
    }
  } else {
    lines.splice(modelLineIdx + 1, 0, newThoughtLine);
    changes.push({ field: 'thoughtLevel', old: null, new: newThoughtLine });
  }
  return { changes, output: lines.join('\n') };
}

// 写入自定义 agent md：无变更且非 force 时不写文件；写入走原子写并保持 mode
export function applyCustomAgent(agentMdPath, target, { force = false } = {}) {
  const raw = fs.readFileSync(agentMdPath, 'utf8');
  const { changes, output } = computeCustomAgentChanges(raw, target);
  if (changes.length === 0 && !force) {
    return { written: false, changes };
  }
  const mode = fs.statSync(agentMdPath).mode & 0o777;
  writeAtomic(agentMdPath, output, mode);
  return { written: true, changes };
}

// 追加一行 JSON 到 history.jsonl；entry 形状（v2，apply.mjs 写入侧）：
// { mode: 'original'|'target', reason: 'switch'|'restore', agents: string[] }
// time 未提供时补当前 ISO 时间；目录不存在则创建
export function appendHistory(historyPath, entry) {
  const record = { time: new Date().toISOString(), ...entry };
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.appendFileSync(historyPath, JSON.stringify(record) + '\n', { mode: 0o644 });
}

// O_EXCL 抢锁（wx）；EEXIST → 检查陈旧性：mtime >10min 或 pid 不存在 → 删除重抢；否则 LockBusyError
export function acquireLock(lockPath) {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') {
      // 读取已有锁内容判断陈旧性
      let content;
      try {
        content = fs.readFileSync(lockPath, 'utf8');
      } catch {
        // 锁文件读不到：视为损坏，删除后重抢
        try { fs.unlinkSync(lockPath); } catch {}
        fd = fs.openSync(lockPath, 'wx');
      }
      if (!fd) {
        const mtimeMs = fs.statSync(lockPath).mtimeMs;
        const now = Date.now();
        const pidMatch = content.match(/^(\d+)/);
        const pid = pidMatch ? Number(pidMatch[1]) : null;
        let dead = false;
        if (pid !== null) {
          try { process.kill(pid, 0); } catch { dead = true; }
        }
        const stale = (now - mtimeMs) > 600000 || dead;
        if (stale) {
          fs.unlinkSync(lockPath);
          fd = fs.openSync(lockPath, 'wx');
        } else {
          throw new LockBusyError(lockPath);
        }
      }
    } else {
      throw err;
    }
  }
  try {
    fs.writeFileSync(fd, `${process.pid}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

// 释放锁；ENOENT（锁已被释放）为幂等场景，容忍
export function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // ENOENT：锁文件已被并发方释放，无后续影响
  }
}

// if-due：state.json 的 mode 与 desiredMode 比较；state 不存在/损坏 → true（重新评估，宁可多跑不漏切）
// 不复用 loadState：loadState 对「不存在/损坏」与「真 original」均返回 original，
// 无法满足 spec「state 不存在/损坏 → true」（锚点补全 #4）
export function modeChanged(statePath, desiredMode) {
  let mode;
  try {
    mode = JSON.parse(fs.readFileSync(statePath, 'utf8'))?.mode;
  } catch {
    // 吞掉读文件/JSON.parse 错误：state 缺失或损坏一律视为「有变更需重新评估」；
    // 无其他路径可达——任何异常都意味着当前态不可信，重新评估即自愈
    return true;
  }
  return mode !== desiredMode;
}
