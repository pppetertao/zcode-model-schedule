// lib/state.mjs — state.json 原子读写 + 损坏容错 + 快照存取
// state.json schema:
// { "mode": "original"|"target", "switchedAt": ISO|null,
//   "snapshot": { "<agentName>": builtin{providerId,modelId,options:{reasoningLevel}}
//                              | custom{model,thoughtLevel} | null },
//   "lastCheck": ISO|null }
// 注意：本文件的 state.json 是工具自身状态（TOOL_DIR/state.json，apply.mjs 内命名 STATE_PATH），
// 与 ZCode 的 agents-state.json（apply-core 的操作对象，命名 AGENTS_STATE_PATH）是两个文件。
import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './config.mjs';

function emptyState() {
  return { mode: 'original', snapshot: null, switchedAt: null, lastCheck: null };
}

// 读取 state.json；不存在/损坏（JSON.parse 抛错或顶层非对象）→ 返回默认态（original 无快照），不 throw
export function loadState(statePath) {
  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState(); // 首次运行无 state：按未切换处理（自愈安全）
    throw err;
  }
  try {
    const state = JSON.parse(raw);
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('state.json 顶层必须为对象');
    return {
      mode: state.mode === 'target' ? 'target' : 'original', // mode 垃圾值归一为 original（按未切换处理）
      snapshot: state.snapshot ?? null,
      switchedAt: state.switchedAt ?? null,
      lastCheck: state.lastCheck ?? null,
    };
  } catch (err) {
    // 损坏容错：吞掉 JSON.parse/形状错误（spec：损坏视为 original 不切换，不阻断自愈；有 [warn] log 非沉默）
    console.error('[warn] state.json 损坏，视为 original 无快照');
    return emptyState();
  }
}

// 原子写 state.json（同目录 tmp + rename + chmod 保持既有 mode；首次写入默认 0644）
export function saveState(statePath, state) {
  const mode = fs.existsSync(statePath) ? fs.statSync(statePath).mode & 0o777 : 0o644;
  const tmp = `${statePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode });
  fs.renameSync(tmp, statePath);
  fs.chmodSync(statePath, mode);
}

// 从 md 原文提取 model: / thoughtLevel: 行的当前值。
// 正则与 lib/apply-core.mjs 的 computeCustomAgentChanges 逐字一致（锚点补全 #2，Task 3 不得改其语义）；
// 值保留行内原始形态（含引号）→ 恢复时逐字节还原。行缺失 → 该字段 null。
function readCustomAgentCurrent(raw) {
  const lines = raw.split('\n');
  const modelLine = lines.find((line) => /^model:\s*.+$/.test(line));
  const thoughtLine = lines.find((line) => /^thoughtLevel:\s*.+$/.test(line));
  return {
    model: modelLine ? modelLine.replace(/^model:\s*/, '') : null,
    thoughtLevel: thoughtLine ? thoughtLine.replace(/^thoughtLevel:\s*/, '') : null,
  };
}

// 读取各 agent 当前值作为切换前快照：
//   builtin → agents-state.json builtInModelSelectionOverrides[agent]（读不到 → null，恢复时跳过）
//   custom  → md 文件 model:/thoughtLevel: 当前值（path 缺省 → ~/.zcode/agents/<name>.md）
// 返回 { <agentName>: current|null }
export function captureSnapshot(agents, agentsStatePath, agentsDir) {
  const snapshot = {};
  let overrides = null;
  try {
    overrides = JSON.parse(fs.readFileSync(agentsStatePath, 'utf8')).builtInModelSelectionOverrides ?? {};
  } catch (err) {
    // agents-state.json 不存在/损坏：builtin 当前值记 null（恢复时跳过该 agent；不阻断切换流程）
    console.error(`[warn] 读取 ${agentsStatePath} 失败，builtin 快照记空: ${err.message}`);
  }
  for (const agent of agents) {
    if (agent.kind === 'builtin') {
      snapshot[agent.name] = (overrides && overrides[agent.name]) || null;
    } else {
      const mdPath = agent.path ? expandHome(agent.path) : path.join(agentsDir, `${agent.name}.md`);
      try {
        snapshot[agent.name] = readCustomAgentCurrent(fs.readFileSync(mdPath, 'utf8'));
      } catch (err) {
        // md 读不到：快照记 null，恢复时跳过该 agent（不写坏文件）
        console.error(`[warn] 读取 ${mdPath} 失败，custom 快照记空: ${err.message}`);
        snapshot[agent.name] = null;
      }
    }
  }
  return snapshot;
}
