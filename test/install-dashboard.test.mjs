// test/install-dashboard.test.mjs — dashboard launchd agent：plist 生成纯函数 + 参数解析 + dryRun（node --test；不触碰真实 launchd）
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateDashboardPlist, parseInstallArgs, dryRun } from '../install.mjs';

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeTmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `msched-dash-install-${label}-`));
}

function baseSchedule() {
  return {
    $schema: 'zcode-model-schedule/v2',
    timezone: 'Asia/Shanghai',
    target: { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', reasoningLevel: 'max' },
    agents: [{ name: 'Explore', kind: 'builtin' }],
    dayWindows: [{ days: [1, 2, 3, 4, 5], from: '08:50', to: '23:10' }],
    availability: { enabled: false },
  };
}

describe('generateDashboardPlist', () => {
  test('默认端口 8787：Label/ProgramArguments/RunAtLoad/KeepAlive/日志路径', () => {
    const xml = generateDashboardPlist('/fake/node/bin/node', '/fake/tool/dashboard.mjs', 8787, 501);
    assert.match(xml, /<key>Label<\/key><string>com\.zcode\.model-schedule-dashboard<\/string>/);
    assert.match(xml, /<string>\/fake\/node\/bin\/node<\/string>\n    <string>\/fake\/tool\/dashboard\.mjs<\/string>\n    <string>--port<\/string>\n    <string>8787<\/string>/);
    assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(xml, /<key>KeepAlive<\/key><true\/>/);
    assert.match(xml, /<key>StandardOutPath<\/key><string>\/fake\/tool\/logs\/dashboard\.out\.log<\/string>/);
    assert.match(xml, /<key>StandardErrorPath<\/key><string>\/fake\/tool\/logs\/dashboard\.err\.log<\/string>/);
    assert.match(xml, /gui\/501/);
  });

  test('自定义端口 9000 写入 ProgramArguments', () => {
    const xml = generateDashboardPlist('/fake/node', '/fake/tool/dashboard.mjs', 9000, 501);
    assert.match(xml, /<string>--port<\/string>\n    <string>9000<\/string>/);
    assert.doesNotMatch(xml, /8787/);
  });

  test('nodePath/scriptPath 含 & 时 xmlEscape（无裸 &）', () => {
    const xml = generateDashboardPlist('/fake/node&bin', '/fake/tool&x/dashboard.mjs', 8787, 501);
    assert.equal(xml.includes('<string>/fake/node&bin</string>'), false);
    assert.match(xml, /\/fake\/node&amp;bin/);
    assert.match(xml, /\/fake\/tool&amp;x\/dashboard\.mjs/);
  });

  test('不含调度 agent 专属键（StartCalendarInterval/StartInterval）', () => {
    const xml = generateDashboardPlist('/fake/node', '/fake/tool/dashboard.mjs', 8787, 501);
    assert.doesNotMatch(xml, /StartCalendarInterval/);
    assert.doesNotMatch(xml, /StartInterval/);
  });
});

describe('parseInstallArgs', () => {
  test('默认 dashboardPort=8787、noDashboard=false', () => {
    assert.deepEqual(parseInstallArgs([]), {
      config: path.join(TOOL_ROOT, 'schedule.json'),
      dryRun: false,
      uninstall: false,
      registerHook: false,
      dashboardPort: 8787,
      noDashboard: false,
    });
  });

  test('--dashboard-port 9000 → dashboardPort=9000；--no-dashboard → noDashboard=true；同给时并存', () => {
    assert.equal(parseInstallArgs(['--dashboard-port', '9000']).dashboardPort, 9000);
    assert.equal(parseInstallArgs(['--no-dashboard']).noDashboard, true);
    const both = parseInstallArgs(['--dashboard-port', '9000', '--no-dashboard']);
    assert.equal(both.dashboardPort, 9000);
    assert.equal(both.noDashboard, true);
  });

  test('--dashboard-port 缺值 / 非整数 / 0 / 越界 → throw', () => {
    assert.throws(() => parseInstallArgs(['--dashboard-port']), /--dashboard-port/);
    assert.throws(() => parseInstallArgs(['--dashboard-port', 'abc']), /--dashboard-port/);
    assert.throws(() => parseInstallArgs(['--dashboard-port', '0']), /--dashboard-port/);
    assert.throws(() => parseInstallArgs(['--dashboard-port', '65536']), /--dashboard-port/);
  });

  test('既有参数不回归：--config/--dry-run/--uninstall/--register-hook；未知参数 → throw', () => {
    const opts = parseInstallArgs(['--config', '/tmp/x.json', '--dry-run', '--uninstall', '--register-hook']);
    assert.equal(opts.config, '/tmp/x.json');
    assert.equal(opts.dryRun, true);
    assert.equal(opts.uninstall, true);
    assert.equal(opts.registerHook, true);
    assert.throws(() => parseInstallArgs(['--bogus']), /未知参数/);
  });
});

describe('dryRun', () => {
  test('默认打印两个 plist（调度 + dashboard）；--no-dashboard 只打印调度 plist', () => {
    const dir = makeTmpDir('dryrun');
    const configPath = path.join(dir, 'schedule.json');
    fs.writeFileSync(configPath, JSON.stringify(baseSchedule()));
    const out = [];
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
    try {
      dryRun(configPath, {});
      dryRun(configPath, { noDashboard: true });
    } finally {
      process.stdout.write = origWrite;
    }
    assert.match(out[0], /com\.zcode\.model-schedule<\/string>/);
    assert.match(out[0], /com\.zcode\.model-schedule-dashboard<\/string>/);
    assert.match(out[1], /com\.zcode\.model-schedule<\/string>/);
    assert.doesNotMatch(out[1], /com\.zcode\.model-schedule-dashboard/);
  });
});
