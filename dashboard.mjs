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

// runApplyIfDue — spawn node <toolDir>/apply.mjs --if-due --trigger dashboard；永不 reject，结果全部落 {ok,...}
export function runApplyIfDue({ toolDir, execFileImpl = execFile, timeoutMs = 60000 }) {
  return new Promise((resolve) => {
    execFileImpl(
      process.execPath,
      [path.join(toolDir, 'apply.mjs'), '--if-due', '--trigger', 'dashboard'],
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

// createRequestHandler — 全依赖注入；deps = {configPath, statePath, historyPath, runLogPath, now, spawnTrigger}
export function createRequestHandler(deps) {
  let triggerInFlight = false;
  const data = () => buildDashboardData({
    configPath: deps.configPath,
    statePath: deps.statePath,
    historyPath: deps.historyPath,
    runLogPath: deps.runLogPath,
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
