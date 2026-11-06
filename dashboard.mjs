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
import { resolveLang } from './lib/i18n.mjs';
import { THOUGHT_LEVELS, loadModelRegistry, saveScheduleSettings, validateTarget, validateTargetShape } from './lib/config.mjs';
import { buildAgentOptions, buildTargetOptions } from './lib/options.mjs';

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

// runApply — spawn node <toolDir>/apply.mjs <args>；永不 reject，结果全部落 {ok,...}
function runApply({ toolDir, args, execFileImpl = execFile, timeoutMs = 60000 }) {
  return new Promise((resolve) => {
    execFileImpl(
      process.execPath,
      [path.join(toolDir, 'apply.mjs'), ...args],
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

// runApplyIfDue — 幂等触发：仅在模式真正需要改变时执行
export function runApplyIfDue(opts = {}) {
  return runApply({ ...opts, args: ['--if-due', '--trigger', 'dashboard'] });
}

// runApplyForceRewrite — 保存设置后若已处于 target 模式：用 --force 立即把新目标重写到各 agent
export function runApplyForceRewrite(opts = {}) {
  return runApply({ ...opts, args: ['--force', '--trigger', 'dashboard'] });
}

const MAX_BODY_BYTES = 16 * 1024;

// readBody — 读取请求体（上限 16KB）；超限 reject { code: 'BODY_TOO_LARGE' }
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function normalizeTargetInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const trim = (v) => (typeof v === 'string' ? v.trim() : v);
  return {
    providerId: trim(raw.providerId),
    modelId: trim(raw.modelId),
    reasoningLevel: trim(raw.reasoningLevel),
  };
}

// 返回去重保序的名字数组；形状非法返回 null
function normalizeAgentNames(raw) {
  if (!Array.isArray(raw)) return null;
  const names = [];
  for (const value of raw) {
    if (typeof value !== 'string') return null;
    const name = value.trim();
    if (name.length === 0) return null;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

// createRequestHandler — 全依赖注入；
// deps = {configPath, statePath, historyPath, runLogPath, now, spawnTrigger,
//         loadRegistry, loadTargetOptions, loadAgentOptions, spawnForceApply}
export function createRequestHandler(deps) {
  let triggerInFlight = false;
  // 下拉选项构建失败只降级为空候选（调用方回退当前配置），不影响其余区块
  const safeOptions = (fn) => {
    if (typeof fn !== 'function') return null;
    try {
      return fn();
    } catch (err) {
      console.error(`[warn] 构建下拉选项失败: ${err?.message ?? err}`);
      return null;
    }
  };
  const data = () => buildDashboardData({
    configPath: deps.configPath,
    statePath: deps.statePath,
    historyPath: deps.historyPath,
    runLogPath: deps.runLogPath,
    targetOptions: safeOptions(deps.loadTargetOptions),
    agentOptions: safeOptions(deps.loadAgentOptions),
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
        const html = renderDashboardPage(await data(), { lang: resolveLang(url.searchParams.get('lang')) });
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
          const all = readJsonlLinesLocal(deps.historyPath)
            .filter((r) => r !== null && typeof r === 'object') // 合法 JSON 值 null 也会被解析出来，先滤掉非对象行
            .sort((a, b) => String(b?.time ?? '').localeCompare(String(a?.time ?? ''))); // 排序语义照 lib/run-log.mjs:67-69
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
      if (pathname === '/api/settings') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' }, { Allow: 'POST' });
        let raw;
        try {
          raw = await readBody(req);
        } catch (err) {
          if (err.code === 'BODY_TOO_LARGE') {
            return sendJson(res, 413, { ok: false, errors: [{ scope: 'body', reason: `请求体超过 ${MAX_BODY_BYTES} 字节` }] });
          }
          throw err;
        }
        let input;
        try {
          input = JSON.parse(raw);
        } catch (err) {
          return sendJson(res, 400, { ok: false, errors: [{ scope: 'body', reason: `JSON 解析失败：${err.message}` }] });
        }
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          return sendJson(res, 400, { ok: false, errors: [{ scope: 'body', reason: '请求体必须为对象' }] });
        }

        const target = normalizeTargetInput(input.target);
        const errors = validateTargetShape(target);
        if (errors.length === 0) {
          let registry = null;
          try {
            registry = typeof deps.loadRegistry === 'function' ? deps.loadRegistry() : null;
          } catch (err) {
            // 吞掉注册表读失败（缺失/损坏）：降级为档位枚举校验；apply 执行时仍按注册表硬校验
            console.error(`[warn] dashboard 读取模型注册表失败，跳过注册表校验: ${err?.message ?? err}`);
          }
          if (registry) errors.push(...validateTarget(target, registry));
          else if (!THOUGHT_LEVELS.includes(target.reasoningLevel)) {
            errors.push({ scope: 'target.reasoningLevel', reason: `reasoningLevel 必须 ∈ ${THOUGHT_LEVELS.join('/')}` });
          }
        }

        const before = await data();
        const agentKinds = new Map((before.agentOptions ?? []).map((a) => [a.name, a.kind]));
        const names = normalizeAgentNames(input.agents);
        if (names === null) {
          errors.push({ scope: 'agents', reason: 'agents 必须为非空字符串数组' });
        } else if (names.length === 0) {
          errors.push({ scope: 'agents', reason: '至少选择一个切换对象' });
        } else {
          for (const name of names) {
            if (!agentKinds.has(name)) errors.push({ scope: 'agents', reason: `"${name}" 不在可用 agent 列表` });
          }
        }
        if (errors.length > 0) return sendJson(res, 400, { ok: false, errors });

        const agents = names.map((name) => ({ name, kind: agentKinds.get(name) }));
        try {
          saveScheduleSettings(deps.configPath, { target, agents });
        } catch (err) {
          console.error(`[error] dashboard 写入 schedule 失败: ${err.message}`);
          return sendJson(res, 500, { ok: false, errors: [{ scope: 'config', reason: err.message }] });
        }
        // 已处于 target 模式：新目标不会等下次窗口切换，立即 --force 重写
        const after = await data();
        let reapply = null;
        if (typeof deps.spawnForceApply === 'function' && after.state?.mode === 'target' && after.desiredMode === 'target') {
          reapply = await deps.spawnForceApply();
        }
        sendJson(res, 200, { ok: true, target, agents, reapply });
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
      now: () => new Date(),
      spawnTrigger: () => runApplyIfDue({ toolDir: TOOL_DIR }),
      spawnForceApply: () => runApplyForceRewrite({ toolDir: TOOL_DIR }),
      loadRegistry: () => loadModelRegistry(),
      loadTargetOptions: () => buildTargetOptions(),
      loadAgentOptions: () => buildAgentOptions(),
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
