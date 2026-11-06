// lib/options.mjs — dashboard 下拉选项来源：模型注册表 + 可用 agent 清单（只读、绝不 throw）
// 被 dashboard.mjs 调用；仅用 Node 内置模块
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { THOUGHT_LEVELS, loadModelRegistry, expandHome } from './config.mjs';

// 模型选项：registry → [{ providerId, models: [{ modelId, levels: string[] }] }]
// 读不到/解析失败 → []（调用方回退为当前 target 单项，页面仍可渲染）
export function buildTargetOptions(registryPath = '~/.zcode/v2/config.json') {
  let registry;
  try {
    registry = loadModelRegistry(registryPath);
  } catch (err) {
    console.error(`[warn] 读取模型注册表失败，模型下拉降级为当前 target: ${err.message}`);
    return [];
  }
  const out = [];
  for (const [providerId, models] of registry) {
    const list = [];
    // 模型未声明档位（levels 空）→ 下拉回退 THOUGHT_LEVELS，避免出现无法保存的空 select
    for (const [modelId, levels] of models) {
      list.push({ modelId, levels: levels.size > 0 ? [...levels] : [...THOUGHT_LEVELS] });
    }
    if (list.length > 0) out.push({ providerId, models: list });
  }
  return out;
}

// agent 选项：custom 来自 agentsDir/*.md，builtin 来自 agents-state.json 的 override key
// 任一来源读失败仅跳过该来源（绝不 throw）；返回 [{ name, kind }]（同 kind 内按字母序）
export function buildAgentOptions({
  agentsDir = path.join(os.homedir(), '.zcode', 'agents'),
  agentsStatePath = path.join(os.homedir(), '.zcode', 'v2', 'agents-state.json'),
} = {}) {
  const custom = new Set();
  const builtin = new Set();
  try {
    for (const file of fs.readdirSync(expandHome(agentsDir))) {
      if (file.endsWith('.md')) custom.add(path.basename(file, '.md'));
    }
  } catch (err) {
    // 吞掉 agentsDir 读失败（不存在/EACCES/EISDIR）：custom 来源为空，builtin 来源照常枚举
    console.error(`[warn] 读取 agents 目录失败，跳过 custom 选项: ${err.message}`);
  }
  try {
    const state = JSON.parse(fs.readFileSync(expandHome(agentsStatePath), 'utf8'));
    for (const key of ['builtInModelOverrides', 'builtInModelSelectionOverrides']) {
      for (const name of Object.keys(state?.[key] ?? {})) builtin.add(name);
    }
  } catch (err) {
    // 吞掉 agents-state 读失败：builtin 来源为空，custom 来源照常枚举
    console.error(`[warn] 读取 agents-state 失败，跳过 builtin 选项: ${err.message}`);
  }
  const out = [...builtin].sort().map((name) => ({ name, kind: 'builtin' }));
  out.push(...[...custom].sort().map((name) => ({ name, kind: 'custom' })));
  return out;
}
