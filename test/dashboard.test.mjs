// test/dashboard.test.mjs — dashboard 聚合层 + 模板 + HTTP（node --test；临时目录隔离，禁止触碰真实 ~/.zcode）
// C1：用例 1-15（lib/dashboard.mjs）；C2 追加用例 16-21（dashboard.mjs HTTP 层，见文件末尾）
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
