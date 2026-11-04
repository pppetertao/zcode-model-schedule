// test/dashboard.test.mjs — dashboard 聚合层 + 模板 + HTTP（node --test；临时目录隔离，禁止触碰真实 ~/.zcode）
// C1：用例 1-15（lib/dashboard.mjs）；C2 追加用例 16-21（dashboard.mjs HTTP 层，见文件末尾）；review fix 追加 2 条回归用例（窗口不变量、/api/history null 行）
// TZ 固定 Asia/Shanghai（+08:00 无 DST）；2026-11-02=周一、11-03=周二、11-06=周五、11-07=周六、11-08=周日、11-09=周一
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  wallTimeToInstant,
  computeNextSwitch,
  activeWindow,
  readJsonlLinesLocal,
  buildDashboardData,
  renderDashboardPage,
} from '../lib/dashboard.mjs';
import { createRequestHandler, runApplyIfDue, startServer } from '../dashboard.mjs';
import { MESSAGES, t, resolveLang, LOCALES, LANG_KEYS } from '../lib/i18n.mjs';

const TZ = 'Asia/Shanghai';
const NOW_IN_WINDOW = new Date('2026-11-03T10:00:00+08:00'); // 周二 10:00，白日窗内

function makeTmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `msched-dash-${label}-`));
}

function baseSchedule(overrides = {}) {
  return {
    $schema: 'zcode-model-schedule/v2',
    timezone: TZ,
    target: { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', reasoningLevel: 'max' },
    agents: [{ name: 'Explore', kind: 'builtin' }],
    dayWindows: [{ days: [1, 2, 3, 4, 5], from: '08:50', to: '23:10' }],
    availability: {
      enabled: false,
      endpoint: 'https://billing.example.invalid/api/v1/zcode-plan/billing/current',
      provider: 'builtin:bigmodel-start-plan',
      model: 'model:glm-5.3-flash',
      timeout: 5000,
    },
    ...overrides,
  };
}

function writeSchedule(dir, schedule = baseSchedule()) {
  const configPath = path.join(dir, 'schedule.json');
  fs.writeFileSync(configPath, JSON.stringify(schedule));
  return configPath;
}

// 全数据齐全夹具（用例 11/13/14/15/16-21 共用）：4 文件齐全，runs/history 文件内按时间升序写，断言接口输出降序
function writeFullFixtures(dir) {
  const configPath = writeSchedule(dir);
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    mode: 'target',
    switchedAt: '2026-11-03T00:30:00.000Z', // 11-03 08:30+08，今晨 target 窗切过
    snapshot: { Explore: { providerId: 'magpie', modelId: 'group/glm5.3', options: { reasoningLevel: 'max' } } },
    lastCheck: '2026-11-03T01:55:00.000Z',
  }));
  const historyPath = path.join(dir, 'history.jsonl');
  fs.writeFileSync(historyPath, [
    JSON.stringify({ time: '2026-11-02T00:30:00.000Z', mode: 'target', reason: 'switch', agents: ['Explore'] }),
    JSON.stringify({ time: '2026-11-02T15:10:00.000Z', mode: 'original', reason: 'restore', agents: ['Explore'] }),
  ].join('\n') + '\n');
  const runLogPath = path.join(dir, 'logs', 'runs.jsonl');
  fs.mkdirSync(path.dirname(runLogPath), { recursive: true });
  fs.writeFileSync(runLogPath, [
    JSON.stringify({ schema: 'zcode-model-schedule/run-log/v1', time: '2026-11-02T15:10:05.000Z', trigger: 'launchd', desiredMode: 'original', inWindow: true, action: 'restored', availability: null, changes: [{ agent: 'Explore', field: 'model', old: 'x', new: 'y' }], durationMs: 34, exitCode: 0 }),
    JSON.stringify({ schema: 'zcode-model-schedule/run-log/v1', time: '2026-11-03T01:55:00.000Z', trigger: 'launchd', desiredMode: 'target', inWindow: false, action: 'no-change', availability: 'disabled', changes: [], durationMs: 12, exitCode: 0 }),
  ].join('\n') + '\n');
  return { configPath, statePath, historyPath, runLogPath };
}

describe('computeNextSwitch', () => {
  test('用例1 窗口内（周二 10:00+08）→ 当日 23:10、toMode target', () => {
    const ns = computeNextSwitch(baseSchedule(), NOW_IN_WINDOW);
    assert.deepEqual(ns, { at: '2026-11-03T15:10:00.000Z', toMode: 'target' });
  });

  test('用例2 窗口前（周二 08:00+08）→ 当日 08:50、toMode original', () => {
    const ns = computeNextSwitch(baseSchedule(), new Date('2026-11-03T08:00:00+08:00'));
    assert.deepEqual(ns, { at: '2026-11-03T00:50:00.000Z', toMode: 'original' });
  });

  test('用例3 周六 12:00+08 → 下周一（11-09）08:50、toMode original', () => {
    const ns = computeNextSwitch(baseSchedule(), new Date('2026-11-07T12:00:00+08:00'));
    assert.deepEqual(ns, { at: '2026-11-09T00:50:00.000Z', toMode: 'original' });
  });

  test('用例4 周五 23:30+08（to 已过）→ 下周一 08:50、toMode original', () => {
    const ns = computeNextSwitch(baseSchedule(), new Date('2026-11-06T23:30:00+08:00'));
    assert.deepEqual(ns, { at: '2026-11-09T00:50:00.000Z', toMode: 'original' });
  });

  test('用例5 now 恰为 08:50:00 → from 候选被 > 滤除，返回当日 23:10、target', () => {
    const ns = computeNextSwitch(baseSchedule(), new Date('2026-11-03T08:50:00+08:00'));
    assert.deepEqual(ns, { at: '2026-11-03T15:10:00.000Z', toMode: 'target' });
  });

  test('用例6 双窗口（days[6,7] 周末窗）周日窗内 → 周日 to、target', () => {
    const schedule = baseSchedule({
      dayWindows: [
        { days: [1, 2, 3, 4, 5], from: '08:50', to: '23:10' },
        { days: [6, 7], from: '09:00', to: '22:00' },
      ],
    });
    const ns = computeNextSwitch(schedule, new Date('2026-11-08T12:00:00+08:00')); // 周日 12:00，窗 09:00-22:00 内
    assert.deepEqual(ns, { at: '2026-11-08T14:00:00.000Z', toMode: 'target' });
  });

  test('用例7 任意 3 瞬时均非 null（14 天扫描终止保证）且严格晚于 now', () => {
    for (const iso of ['2026-02-15T03:24:56.789Z', '2026-06-30T21:11:00.000Z', '2027-01-01T00:00:00.000Z']) {
      const ns = computeNextSwitch(baseSchedule(), new Date(iso));
      assert.ok(ns !== null, `nextSwitch 为 null @ ${iso}`);
      assert.ok(Date.parse(ns.at) > Date.parse(iso), `候选未晚于 now @ ${iso}`);
      assert.ok(['original', 'target'].includes(ns.toMode));
    }
  });
});

describe('wallTimeToInstant', () => {
  test('用例8 纽约 2026-07-01 00:00 墙钟（分钟数 0）→ 2026-07-01T04:00:00.000Z（偏移校正）', () => {
    const ms = wallTimeToInstant(2026, 7, 1, 0, 'America/New_York');
    assert.equal(ms, Date.parse('2026-07-01T04:00:00.000Z'));
    assert.equal(new Date(ms).toISOString(), '2026-07-01T04:00:00.000Z');
  });
});

describe('activeWindow', () => {
  test('用例9 命中返回窗口；窗前/to 严格不命中返回 null；空 dayWindows 返回 null', () => {
    const schedule = baseSchedule();
    assert.deepEqual(activeWindow(schedule, NOW_IN_WINDOW), { days: [1, 2, 3, 4, 5], from: '08:50', to: '23:10' });
    assert.equal(activeWindow(schedule, new Date('2026-11-03T08:00:00+08:00')), null); // from 前
    assert.equal(activeWindow(schedule, new Date('2026-11-03T23:10:00+08:00')), null); // to 严格不命中
    assert.equal(activeWindow(baseSchedule({ dayWindows: [] }), NOW_IN_WINDOW), null);
  });
});

describe('readJsonlLinesLocal', () => {
  test('用例10 ENOENT→[]；坏行跳过好行保留；目录读错误向上抛', () => {
    const dir = makeTmpDir('jsonl');
    assert.deepEqual(readJsonlLinesLocal(path.join(dir, 'nope.jsonl')), []);
    const mixed = path.join(dir, 'mixed.jsonl');
    fs.writeFileSync(mixed, '{"a":1}\nnot-json\n\n{"b":2}\n');
    assert.deepEqual(readJsonlLinesLocal(mixed), [{ a: 1 }, { b: 2 }]);
    assert.throws(() => readJsonlLinesLocal(dir), (err) => err.code === 'EISDIR');
  });
});

describe('buildDashboardData', () => {
  test('用例11 全数据齐全 → 各字段正确、missing/corrupt 全 false、lastRunReason=runs[0].availability', () => {
    const dir = makeTmpDir('full');
    const paths = writeFullFixtures(dir);
    const d = buildDashboardData({ ...paths, now: NOW_IN_WINDOW });
    assert.equal(d.schema, 'zcode-model-schedule/dashboard/v1');
    assert.equal(d.generatedAt, NOW_IN_WINDOW.toISOString());
    assert.equal(d.now, NOW_IN_WINDOW.getTime());
    assert.equal(d.timezone, TZ);
    assert.equal(d.scheduleError, null);
    assert.equal(d.inWindow, true);
    assert.equal(d.desiredMode, 'original');
    assert.deepEqual(d.activeWindow, { days: [1, 2, 3, 4, 5], from: '08:50', to: '23:10' });
    assert.deepEqual(d.nextSwitch, { at: '2026-11-03T15:10:00.000Z', toMode: 'target' });
    assert.equal(d.state.mode, 'target');
    assert.equal(d.state.hasSnapshot, true);
    assert.equal(d.state.missing, false);
    assert.equal(d.state.corrupt, false);
    assert.deepEqual(d.availability, {
      enabled: false,
      endpoint: 'https://billing.example.invalid/api/v1/zcode-plan/billing/current',
      provider: 'builtin:bigmodel-start-plan',
      model: 'model:glm-5.3-flash',
      timeout: 5000,
      lastRunReason: 'disabled',
    });
    assert.equal(d.config.target.modelId, 'GLM-5.3-Flash');
    assert.equal(d.runs.length, 2);
    assert.equal(d.runs[0].time, '2026-11-03T01:55:00.000Z'); // 降序
    assert.equal(d.history.length, 2);
    assert.equal(d.history[0].reason, 'restore'); // 降序
  });

  test('用例12 全缺失 → 降级标记、runs/history 空、不 throw；渲染含「暂无数据」', () => {
    const dir = makeTmpDir('empty');
    const d = buildDashboardData({
      configPath: path.join(dir, 'schedule.json'),
      statePath: path.join(dir, 'state.json'),
      historyPath: path.join(dir, 'history.jsonl'),
      runLogPath: path.join(dir, 'logs', 'runs.jsonl'),
      now: NOW_IN_WINDOW,
    });
    assert.ok(d.scheduleError !== null);
    assert.ok(d.scheduleError.includes('无法读取'));
    assert.equal(d.timezone, null);
    assert.equal(d.inWindow, null);
    assert.equal(d.desiredMode, null);
    assert.equal(d.activeWindow, null);
    assert.equal(d.nextSwitch, null);
    assert.equal(d.config, null);
    assert.equal(d.state.missing, true);
    assert.equal(d.state.corrupt, false);
    assert.equal(d.state.mode, 'original');
    assert.deepEqual(d.runs, []);
    assert.deepEqual(d.history, []);
    assert.equal(d.availability.enabled, null);
    assert.equal(d.availability.lastRunReason, null);
    assert.ok(renderDashboardPage(d).includes('暂无数据')); // Acceptance：降级页面显示「暂无数据」
    assert.match(renderDashboardPage(d), /id="config-kv"/); // 降级页也必须有 #config-kv，否则客户端 fillKv 空引用
  });

  test('用例13 state.json 损坏 → corrupt=true、mode original；history 坏行跳过好行保留', () => {
    const dir = makeTmpDir('corrupt');
    const paths = writeFullFixtures(dir);
    fs.writeFileSync(paths.statePath, '{oops broken');
    fs.writeFileSync(paths.historyPath, '{"time":"2026-11-02T00:30:00.000Z","mode":"target","reason":"switch","agents":["Explore"]}\nbroken-line\n');
    const d = buildDashboardData({ ...paths, now: NOW_IN_WINDOW });
    assert.equal(d.state.corrupt, true);
    assert.equal(d.state.missing, false);
    assert.equal(d.state.mode, 'original'); // loadState 自愈
    assert.equal(d.history.length, 1);
    assert.equal(d.history[0].reason, 'switch');
  });

  test('用例14 schedule.json 缺失 → scheduleError 非空、窗口系字段 null、runs 照常返回', () => {
    const dir = makeTmpDir('nosched');
    const runLogPath = path.join(dir, 'logs', 'runs.jsonl');
    fs.mkdirSync(path.dirname(runLogPath), { recursive: true });
    fs.writeFileSync(runLogPath, JSON.stringify({ schema: 'zcode-model-schedule/run-log/v1', time: '2026-11-03T01:55:00.000Z', trigger: 'dashboard', availability: 'disabled' }) + '\n');
    const d = buildDashboardData({
      configPath: path.join(dir, 'schedule.json'),
      statePath: path.join(dir, 'state.json'),
      historyPath: path.join(dir, 'history.jsonl'),
      runLogPath,
      now: NOW_IN_WINDOW,
    });
    assert.ok(d.scheduleError !== null);
    assert.equal(d.inWindow, null);
    assert.equal(d.desiredMode, null);
    assert.equal(d.nextSwitch, null);
    assert.equal(d.activeWindow, null);
    assert.equal(d.config, null);
    assert.equal(d.runs.length, 1);
    assert.equal(d.runs[0].trigger, 'dashboard');
  });

  test('窗口不变量违规（days 空 / 跨午夜）→ scheduleError 非空、窗口系字段 null', () => {
    const dir = makeTmpDir('invariant');
    const paths = writeFullFixtures(dir);
    fs.writeFileSync(paths.configPath, JSON.stringify(baseSchedule({ dayWindows: [{ days: [], from: '08:50', to: '23:10' }] })));
    let d = buildDashboardData({ ...paths, now: NOW_IN_WINDOW });
    assert.match(d.scheduleError, /days 不能为空/);
    assert.equal(d.inWindow, null);
    assert.equal(d.nextSwitch, null);

    fs.writeFileSync(paths.configPath, JSON.stringify(baseSchedule({ dayWindows: [{ days: [1], from: '23:00', to: '04:00' }] })));
    d = buildDashboardData({ ...paths, now: NOW_IN_WINDOW });
    assert.match(d.scheduleError, /不支持跨午夜窗口/);
    assert.equal(d.activeWindow, null);
  });
});

describe('renderDashboardPage', () => {
  test('用例15 含 </html> 与全部区块 id；数据含 <script> 时输出转义为 \\u003c（无裸注入）', () => {
    const dir = makeTmpDir('render');
    const paths = writeFullFixtures(dir);
    // 注入含 <script> 的 history reason，验证双通道转义（初始 JSON + 服务端渲染）
    fs.writeFileSync(paths.historyPath, JSON.stringify({ time: '2026-11-02T15:10:00.000Z', mode: 'original', reason: '<script>alert(1)</script>', agents: ['Explore'] }) + '\n');
    const d = buildDashboardData({ ...paths, now: NOW_IN_WINDOW });
    const html = renderDashboardPage(d);
    assert.ok(html.includes('<!doctype html'));
    assert.ok(html.includes('</html>'));
    for (const id of ['banners', 'clock', 'next-switch', 'mode', 'availability', 'runs', 'history', 'config-summary', 'trigger', 'initial-data']) {
      assert.ok(html.includes(`id="${id}"`), `missing id="${id}"`);
    }
    assert.match(html, /id="config-kv"/);
    assert.equal(html.includes('<script>alert'), false); // 无裸注入
    assert.ok(html.includes('\\u003cscript>alert')); // 初始数据 JSON 通道转义
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;')); // 服务端渲染通道转义
  });
});

// ===== C2 追加（用例 16-21）：dashboard.mjs HTTP 层 =====
// handler 全依赖注入（deps.now / deps.spawnTrigger 为 fake），mock req/res 不起端口；
// 仅用例 21 起真实 http.Server（port 0 随机端口，close 后 await close 事件不挂起）。

function mockRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? null; },
    end(body) { this.body = body ?? ''; },
  };
}

async function fire(handler, method, target) {
  const res = mockRes();
  await handler({ method, url: target }, res);
  return res;
}

function httpDeps(paths, overrides = {}) {
  return {
    configPath: paths.configPath,
    statePath: paths.statePath,
    historyPath: paths.historyPath,
    runLogPath: paths.runLogPath,
    now: () => new Date('2026-11-03T10:00:00+08:00'),
    spawnTrigger: async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '' }),
    ...overrides,
  };
}

describe('dashboard HTTP handler', () => {
  test('用例16 GET / → 200 text/html 含 <!doctype html', async () => {
    const dir = makeTmpDir('http-index');
    const res = await fire(createRequestHandler(httpDeps(writeFullFixtures(dir))), 'GET', '/');
    assert.equal(res.statusCode, 200);
    assert.ok(String(res.headers['Content-Type']).includes('text/html'));
    assert.ok(res.body.includes('<!doctype html'));
  });

  test('用例17 GET /api/status → 200 schema v1；/api/runs?limit=abc → clamp 10（非 400）', async () => {
    const dir = makeTmpDir('http-status');
    const paths = writeFullFixtures(dir);
    const lines = [];
    for (let i = 0; i < 12; i++) {
      lines.push(JSON.stringify({ schema: 'zcode-model-schedule/run-log/v1', time: new Date(Date.parse('2026-11-03T01:00:00.000Z') + i * 60000).toISOString(), trigger: 'launchd', availability: 'disabled' }));
    }
    fs.writeFileSync(paths.runLogPath, lines.join('\n') + '\n'); // 12 条 > 默认 10
    const handler = createRequestHandler(httpDeps(paths));
    const res = await fire(handler, 'GET', '/api/status');
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.schema, 'zcode-model-schedule/dashboard/v1');
    const res2 = await fire(handler, 'GET', '/api/runs?limit=abc');
    assert.equal(res2.statusCode, 200);
    assert.equal(JSON.parse(res2.body).runs.length, 10); // 非整数 → 回退 10
  });

  test('/api/history 遇合法 JSON null 行 → 200 且过滤该行（不 500）', async () => {
    const dir = makeTmpDir('http-history-null');
    const paths = writeFullFixtures(dir);
    fs.writeFileSync(paths.historyPath, [
      JSON.stringify({ time: '2026-11-02T00:30:00.000Z', mode: 'target', reason: 'switch', agents: ['Explore'] }),
      'null',
      JSON.stringify({ time: '2026-11-01T00:30:00.000Z', mode: 'original', reason: 'restore', agents: ['Explore'] }),
    ].join('\n') + '\n');
    const res = await fire(createRequestHandler(httpDeps(paths)), 'GET', '/api/history');
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.history.length, 2);
    assert.equal(body.history[0].reason, 'switch');
  });

  test('用例18 GET /nope → 404 JSON；POST /api/status → 405 + Allow 头', async () => {
    const dir = makeTmpDir('http-404');
    const handler = createRequestHandler(httpDeps(writeFullFixtures(dir)));
    const res = await fire(handler, 'GET', '/nope');
    assert.equal(res.statusCode, 404);
    assert.deepEqual(JSON.parse(res.body), { error: 'not-found' });
    const res2 = await fire(handler, 'POST', '/api/status');
    assert.equal(res2.statusCode, 405);
    assert.equal(res2.headers.Allow, 'GET');
  });

  test('用例19 POST /api/trigger：exit0 → ok；exit2 → 回显；进行中二次调用 → 409', async () => {
    const dir = makeTmpDir('http-trigger');
    const paths = writeFullFixtures(dir);
    const h1 = createRequestHandler(httpDeps(paths, { spawnTrigger: async () => ({ ok: true, exitCode: 0, stdout: 'no change', stderr: '' }) }));
    const r1 = await fire(h1, 'POST', '/api/trigger');
    assert.equal(r1.statusCode, 200);
    assert.deepEqual(JSON.parse(r1.body), { ok: true, exitCode: 0, stdout: 'no change', stderr: '' });

    const h2 = createRequestHandler(httpDeps(paths, { spawnTrigger: async () => ({ ok: false, exitCode: 2, stdout: '', stderr: '[locked] busy' }) }));
    const r2 = await fire(h2, 'POST', '/api/trigger');
    assert.deepEqual(JSON.parse(r2.body), { ok: false, exitCode: 2, stdout: '', stderr: '[locked] busy' });

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const h3 = createRequestHandler(httpDeps(paths, {
      spawnTrigger: () => { calls += 1; return gate.then(() => ({ ok: true, exitCode: 0, stdout: '', stderr: '' })); },
    }));
    const pending = fire(h3, 'POST', '/api/trigger'); // 第 1 发：handler 同步段已置 in-flight
    const rBusy = await fire(h3, 'POST', '/api/trigger'); // 第 2 发撞守卫
    assert.equal(rBusy.statusCode, 409);
    assert.deepEqual(JSON.parse(rBusy.body), { error: 'busy' });
    release();
    const rDone = await pending;
    assert.equal(rDone.statusCode, 200);
    assert.equal(calls, 1); // 第 2 发未触达 spawnTrigger
  });
});

describe('runApplyIfDue', () => {
  test('用例20 注入 execFileImpl 三态：成功回调 / err.code=2 / err.killed → timeout', async () => {
    const seen = {};
    const ok = (file, args, opts, cb) => {
      seen.file = file; seen.args = args; seen.opts = opts;
      cb(null, 'out-data', 'err-data');
    };
    const r1 = await runApplyIfDue({ toolDir: '/tmp/tool', execFileImpl: ok });
    assert.deepEqual(r1, { ok: true, exitCode: 0, stdout: 'out-data', stderr: 'err-data' });
    assert.equal(seen.file, process.execPath);
    assert.deepEqual(seen.args, ['/tmp/tool/apply.mjs', '--if-due', '--trigger', 'dashboard']); // 绝无 --force / 模式覆盖参数
    assert.equal(seen.opts.cwd, '/tmp/tool');

    const busy = (f, a, o, cb) => cb(Object.assign(new Error('lock busy'), { code: 2 }), '', '[locked]');
    const r2 = await runApplyIfDue({ toolDir: '/tmp/tool', execFileImpl: busy });
    assert.deepEqual(r2, { ok: false, exitCode: 2, stdout: '', stderr: '[locked]' }); // 锁忙 exit 2 回显

    const timedOut = (f, a, o, cb) => cb(Object.assign(new Error('timeout'), { killed: true }), '', '');
    const r3 = await runApplyIfDue({ toolDir: '/tmp/tool', execFileImpl: timedOut });
    assert.deepEqual(r3, { ok: false, error: 'timeout' });
  });
});

describe('startServer', () => {
  test('用例21 port 0 集成：绑定 127.0.0.1 + fetch /api/status 200 + close 后 await close 不挂起', async () => {
    const dir = makeTmpDir('http-server');
    const paths = writeFullFixtures(dir);
    const handler = createRequestHandler(httpDeps(paths));
    let server;
    try {
      server = await startServer({ handler, port: 0 });
      const addr = server.address();
      assert.equal(addr.address, '127.0.0.1');
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/status`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.schema, 'zcode-model-schedule/dashboard/v1');
      assert.equal(body.inWindow, true);
    } finally {
      if (server) {
        server.closeIdleConnections?.();
        await new Promise((resolve) => server.close(resolve)); // try/finally 兜底 close，禁止挂起
      }
    }
  });
});

// ===== i18n 追加（dashboard 中英文切换）：纯模块用例 22-24（字典/翻译函数/语言解析），不依赖 dashboard 改动 =====

describe('i18n', () => {
  // spec Files#1 表（:27-:83）穷尽 57 key；遍历断言防「两侧同漏」，对等断言防「单侧漏/多」
  const SPEC_KEYS = [
    'mode.state', 'mode.desiredMode', 'mode.inWindow', 'mode.activeWindow', 'mode.switchedAt',
    'mode.inWindow.yes', 'mode.inWindow.no',
    'avail.enabled', 'avail.endpoint', 'avail.provider', 'avail.model', 'avail.timeout', 'avail.lastRunReason',
    'runs.col.time', 'runs.col.trigger', 'runs.col.desiredMode', 'runs.col.inWindow', 'runs.col.action',
    'runs.col.availability', 'runs.col.changes', 'runs.col.duration', 'runs.col.exit',
    'hist.col.mode', 'hist.col.reason', 'hist.col.agents',
    'dw.col.days', 'dw.col.from', 'dw.col.to',
    'config.target', 'config.agents',
    'common.empty', 'common.none',
    'next.none', 'next.toTarget', 'next.restore', 'next.soon', 'next.countdown',
    'banner.scheduleError', 'banner.stateMissing', 'banner.stateCorrupt',
    'trigger.button', 'trigger.confirm', 'trigger.busy', 'trigger.done', 'trigger.fail', 'trigger.network',
    'ui.toggleEn', 'ui.toggleZh', 'ui.lang',
    'title',
    'sec.currentMode', 'sec.availability', 'sec.recentRuns', 'sec.switchHistory', 'sec.configSummary', 'sec.manualTrigger',
    'config.details',
  ];

  test('用例22 MESSAGES zh/en key 对等、无空值、覆盖 spec 全部 57 key', () => {
    const zhKeys = Object.keys(MESSAGES.zh);
    const enKeys = Object.keys(MESSAGES.en);
    assert.deepEqual([...enKeys].sort(), [...zhKeys].sort()); // 单侧漏/多 key 即红
    assert.equal(SPEC_KEYS.length, 57); // 本数组自身抄录完整性自检
    for (const k of SPEC_KEYS) {
      assert.ok(k in MESSAGES.zh, `zh 缺 key ${k}`); // 双侧同漏即红
      assert.ok(k in MESSAGES.en, `en 缺 key ${k}`);
    }
    for (const k of zhKeys) {
      assert.equal(typeof MESSAGES.zh[k], 'string');
      assert.ok(MESSAGES.zh[k].length > 0, `zh 空值 @ ${k}`);
      assert.equal(typeof MESSAGES.en[k], 'string');
      assert.ok(MESSAGES.en[k].length > 0, `en 空值 @ ${k}`);
    }
  });

  test('用例23 t() 基本翻译 / 参数替换 / 缺失 key 回退 / 非法 lang 回落 zh', () => {
    assert.equal(t('zh', 'mode.state'), '当前模式');
    assert.equal(t('en', 'mode.state'), 'Current mode');
    assert.equal(
      t('zh', 'next.countdown', { time: '23:10', m: 3, s: 20, label: 'target' }),
      '23:10（3 分 20 秒后 → target）',
    );
    assert.equal(
      t('en', 'next.countdown', { time: '23:10', m: 3, s: 20, label: 'target' }),
      '23:10 (3m 20s → target)',
    );
    assert.equal(t('zh', 'banner.scheduleError', { msg: 'oops' }), 'schedule 加载失败：oops');
    assert.equal(t('en', 'trigger.fail', { code: 2, msg: 'busy' }), 'Trigger failed exit=2 (busy)');
    assert.equal(t('zh', 'no.such.key'), 'no.such.key'); // 缺失 key fail-open 回退 key 本身
    assert.equal(t('zh', 'no.such.key', { x: 1 }), 'no.such.key'); // 占位不在模板中时不受 params 影响
    assert.equal(t('xx', 'mode.state'), '当前模式'); // 非法 lang 回落 zh
    assert.equal(t(undefined, 'mode.state'), '当前模式');
    assert.equal(t('zh', 'ui.toggleEn'), 'EN'); // zh 模式按钮显示 EN（点击切英）
    assert.equal(t('en', 'ui.toggleZh'), '中文'); // en 模式按钮显示中文（点击切回）
  });

  test('用例24 resolveLang 仅 en→en、其余一律 zh；LOCALES/LANG_KEYS 形状冻结', () => {
    assert.equal(resolveLang('en'), 'en');
    assert.equal(resolveLang('zh'), 'zh');
    assert.equal(resolveLang('xx'), 'zh');
    assert.equal(resolveLang('EN'), 'zh'); // 大小写敏感，不归一
    assert.equal(resolveLang(''), 'zh');
    assert.equal(resolveLang(undefined), 'zh');
    assert.equal(resolveLang(null), 'zh');
    assert.deepEqual(LOCALES, { zh: 'zh-CN', en: 'en-US' });
    assert.deepEqual(LANG_KEYS, ['zh', 'en']);
  });
});

// ===== i18n Task2 追加（用例 25-26）：renderDashboardPage 服务端 lang 渲染 =====

describe('renderDashboardPage i18n', () => {
  test('用例25 lang=en：html lang/en 文案/表头/KV label/按钮/注入全 t() 化，mode 区块无裸 state.mode', () => {
    const dir = makeTmpDir('i18n-en');
    const d = buildDashboardData({ ...writeFullFixtures(dir), now: NOW_IN_WINDOW });
    const html = renderDashboardPage(d, { lang: 'en' });
    const serverHtml = html.split('<script>')[0]; // 服务端渲染区（<script> 注入行的 __I18N__ 含 zh 字典全文属预期，排除后断言）
    assert.ok(html.includes('<html lang="en">'));
    assert.ok(html.includes('Current mode')); // h2 sec.currentMode + mode KV label
    assert.equal(serverHtml.includes('当前模式'), false);
    assert.ok(html.includes('<th data-i18n="runs.col.time">Time</th>'));
    assert.ok(html.includes('<th data-i18n="runs.col.availability">Availability</th>'));
    assert.ok(html.includes('<th data-i18n="dw.col.days">Days</th>'));
    assert.ok(html.includes('>Desired mode<')); // mode KV desiredMode label
    const modeKv = html.match(/<div class="card kv" id="mode">([\s\S]*?)<\/div>/)[1];
    assert.equal(modeKv.includes('>state.mode<'), false); // 服务端 KV label 不再裸 key（数据值仍原样）
    assert.ok(modeKv.includes('>In window<'));
    assert.ok(html.includes('data-i18n="config.details">Full config JSON</summary>'));
    assert.ok(html.includes('Manually trigger apply (--if-due, idempotent)')); // trigger 按钮文本
    assert.ok(html.includes('id="lang-toggle"'));
    assert.ok(html.includes('data-i18n="ui.toggleZh"')); // en 页按钮指向中文 key
    assert.ok(html.includes('>中文</button>')); // en 页按钮显示中文（点击切回）
    assert.ok(html.includes('window.__I18N__'));
    assert.ok(html.includes('window.__I18N_LANG__ = "en"'));
  });

  test('用例26 lang=en 全缺失数据 → 服务端空态 No data；默认 zh 保持中文且结构断言兼容', () => {
    const dir = makeTmpDir('i18n-empty-en');
    const d = buildDashboardData({
      configPath: path.join(dir, 'schedule.json'),
      statePath: path.join(dir, 'state.json'),
      historyPath: path.join(dir, 'history.jsonl'),
      runLogPath: path.join(dir, 'logs', 'runs.jsonl'),
      now: NOW_IN_WINDOW,
    });
    const htmlEn = renderDashboardPage(d, { lang: 'en' });
    assert.ok(htmlEn.includes('<td colspan="9">No data</td>')); // runs 空态（服务端区）
    const htmlZh = renderDashboardPage(d);
    assert.ok(htmlZh.includes('<td colspan="9">暂无数据</td>')); // 与 :208 断言同源（默认 zh）
    assert.ok(htmlZh.includes('当前模式'));
    assert.ok(htmlZh.includes('<html lang="zh-CN">'));
    assert.ok(htmlZh.includes('data-i18n="ui.toggleEn"')); // zh 页按钮指向英文 key
    assert.ok(htmlZh.includes('>EN</button>'));
    assert.ok(htmlZh.includes('<th data-i18n="runs.col.time">时间</th>'));
  });
});

// ===== i18n Task3 追加（用例 27-28）：renderClientScript 客户端脚本 i18n =====

describe('renderClientScript i18n', () => {
  test('用例27 脚本含注入/切换/恢复机制关键串；ES5 合规（无箭头/模板字面量/const/let）', () => {
    const dir = makeTmpDir('i18n-script');
    const d = buildDashboardData({ ...writeFullFixtures(dir), now: NOW_IN_WINDOW });
    const html = renderDashboardPage(d);
    assert.ok(html.includes('window.__I18N__'));
    assert.ok(html.includes('zcode-dashboard-lang'));
    assert.ok(html.includes('data-i18n'));
    assert.ok(html.includes("querySelectorAll('[data-i18n]')"));
    assert.ok(html.includes("localStorage.setItem('zcode-dashboard-lang'"));
    assert.ok(html.includes("localStorage.getItem('zcode-dashboard-lang'"));
    assert.ok(html.includes("addEventListener('click'"));
    const start = html.indexOf('(function () {\n');
    assert.notEqual(start, -1, '客户端 IIFE 头未找到');
    const script = html.slice(start).split('\n})();')[0]; // 客户端纯脚本（与用例30 同法提取：以 IIFE 头 indexOf 起切、到首个 '\n})();' 止，覆盖整个 IIFE，含 visibilitychange/lang-toggle/trigger 处理器/localStorage 恢复/startPolling；排除 __I18N__ 注入行，字典值不受 ES5 断言误伤）
    assert.ok(script.length > 500 && script.includes("'use strict'"), '客户端脚本提取疑似截断');
    assert.equal(script.includes('=>'), false); // 无箭头函数
    assert.equal(script.includes('`'), false); // 无模板字面量
    assert.equal(script.includes('const '), false);
    assert.equal(script.includes('let '), false);
  });

  test('用例28 lang=en 整页（含客户端脚本）无中文文案残留、无裸 state.mode；zh 页含恢复机制', () => {
    const dir = makeTmpDir('i18n-script-en');
    const d = buildDashboardData({ ...writeFullFixtures(dir), now: NOW_IN_WINDOW });
    const htmlEn = renderDashboardPage(d, { lang: 'en' });
    const serverHtmlEn = htmlEn.split('<script>')[0]; // 服务端渲染区
    const scriptEn = htmlEn.split('(function () {\n')[1].split('\n})();')[0]; // 客户端纯脚本（注入行的 __I18N__ 含 zh 字典属预期，从 IIFE 起截取排除）
    for (const zh of ['暂无数据', '当前模式', '期望模式', '窗口内', '手动触发', '切 target', '恢复 original', '是（白日窗）', '触发完成', '已有触发进行中']) {
      assert.equal(serverHtmlEn.includes(zh), false, `en 服务端区残留中文: ${zh}`);
      assert.equal(scriptEn.includes(zh), false, `en 客户端脚本残留中文: ${zh}`);
    }
    assert.ok(scriptEn.includes("t('mode.state')")); // 客户端 modePairs label 已 t() 化
    assert.equal(htmlEn.includes('"state.mode"'), false); // 无裸 state.mode 进入任何 JSON/标签（脚本内 d.state.mode 为数据访问表达式，不算裸 key）
    assert.ok(htmlEn.includes('Switching soon'));
    assert.ok(htmlEn.includes('Trigger finished exit='));
    const htmlZh = renderDashboardPage(d);
    assert.ok(htmlZh.includes('当前模式'));
    assert.ok(htmlZh.includes("localStorage.getItem('zcode-dashboard-lang')")); // 刷新保持机制在位
  });
});

// ===== fix round 1 追加（用例 30）：客户端切换机制修正（按钮文案翻转 / 轮询数据回写 / URL 参数优先）=====

describe('客户端切换机制修正', () => {
  test('用例30 脚本 setAttribute 回写 data-i18n + URL lang 优先 + trigger.fail 兜底；en 服务端区无中文；表头 key 走服务端属性、KV key 走客户端 t()', () => {
    const dir = makeTmpDir('i18n-fix');
    const d = buildDashboardData({ ...writeFullFixtures(dir), now: NOW_IN_WINDOW });
    const en = renderDashboardPage(d, { lang: 'en' });
    const start = en.indexOf('(function () {\n');
    assert.notEqual(start, -1, '客户端 IIFE 头未找到');
    const script = en.slice(start).split('\n})();')[0]; // 完整客户端 IIFE（以 IIFE 头 indexOf 起切、到首个 '\n})();' 止，不含 __I18N__ 注入行）
    assert.ok(script.length > 500 && script.includes("'use strict'"), '客户端脚本提取疑似截断');
    assert.ok(script.includes("var lp = LANG === 'en' ? '(' : '（';") && script.includes("var rp = LANG === 'en' ? ')' : '）';"), '客户端 clock 括号需随 LANG 切换');
    assert.ok(script.includes("setAttribute('data-i18n'"), '脚本需以 setAttribute 回写 data-i18n');
    assert.ok(script.includes("indexOf('lang=')"), '脚本需读取 URL lang 参数做优先级判定');
    assert.ok(script.includes("t('trigger.fail'"), 'trigger.fail 需走 t()');
    assert.ok(script.includes("'-'"), 'trigger.fail 的 msg 需有 - 兜底');
    assert.ok(script.includes('data = d; render(d)'), 'refresh 必须回写全局 data');
    assert.ok(script.includes("el('trigger-result')") && script.includes("tres.textContent = ''"), '切换语言需清空 #trigger-result 残留旧语言');
    assert.ok(script.includes('aria-label') && script.includes('ui.lang'), '语言切换按钮需带 aria-label（ui.lang）');

    // en 页服务端区无中文。lang-toggle 按钮文本按设计就是「中文」（en 页点击切回中文，用例25 已锁该文本），
    // 属切换控件自身标签而非未翻译残留，故断言前先剔除该按钮再测 CJK（含全角标点）。
    const serverPart = en.split('<script>')[0].replace(/<button id="lang-toggle"[^>]*>[^<]*<\/button>/, '');
    assert.equal(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(serverPart), false);

    // 表头 key 由服务端 data-i18n 属性承载、客户端遍历回写 textContent（不存在 t('<key>' 字面形态）
    for (const key of ['runs.col.time', 'runs.col.trigger', 'runs.col.desiredMode', 'runs.col.inWindow', 'runs.col.action', 'runs.col.availability', 'runs.col.changes', 'runs.col.duration', 'runs.col.exit', 'hist.col.mode', 'hist.col.reason', 'hist.col.agents', 'dw.col.days', 'dw.col.from', 'dw.col.to']) {
      assert.ok(en.includes(`data-i18n="${key}"`), `en 页缺 data-i18n="${key}"`);
    }
    // KV label 由客户端 t() 生成
    for (const key of ['avail.enabled', 'avail.endpoint', 'avail.provider', 'avail.model', 'avail.timeout', 'avail.lastRunReason', 'config.target', 'config.agents']) {
      assert.ok(script.includes(`t('${key}'`), `脚本缺 t('${key}')`);
    }
  });
});

// ===== i18n Task4 追加（用例 29）：dashboard.mjs HTTP 层 lang 接线 =====

describe('dashboard HTTP lang', () => {
  test('用例29 GET /?lang=en 英文、GET / 中文、/?lang=xx 回落中文（port 0 集成）', async () => {
    const dir = makeTmpDir('http-lang');
    const handler = createRequestHandler(httpDeps(writeFullFixtures(dir)));
    let server;
    try {
      server = await startServer({ handler, port: 0 });
      const base = `http://127.0.0.1:${server.address().port}`;
      const htmlEn = await (await fetch(`${base}/?lang=en`)).text();
      assert.ok(htmlEn.includes('<html lang="en">'));
      assert.ok(htmlEn.split('<script>')[0].includes('Current mode')); // 服务端渲染区（<script> 注入含 zh 字典属预期）
      assert.equal(htmlEn.split('<script>')[0].includes('当前模式'), false);
      const htmlZh = await (await fetch(`${base}/`)).text();
      assert.ok(htmlZh.includes('<html lang="zh-CN">'));
      assert.ok(htmlZh.split('<script>')[0].includes('当前模式'));
      const htmlXx = await (await fetch(`${base}/?lang=xx`)).text();
      assert.ok(htmlXx.includes('<html lang="zh-CN">')); // 非法 lang 回落 zh
      assert.ok(htmlXx.split('<script>')[0].includes('当前模式'));
    } finally {
      if (server) {
        server.closeIdleConnections?.();
        await new Promise((resolve) => server.close(resolve)); // try/finally 兜底 close，禁止挂起
      }
    }
  });
});