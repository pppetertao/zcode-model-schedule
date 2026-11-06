// test/apply.test.mjs — node --test；临时目录隔离，禁止触碰真实 ~/.zcode
// Task 1 重写（v2）：config 段为 v2 用例；apply-core 段自旧基线逐字继承（Task 3 原地增删；Task 2/4/5 末尾追加）
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  loadSchedule,
  loadModelRegistry,
  validateSchedule,
  inDayWindow,
  parseSlotTime,
} from '../lib/config.mjs';

const TZ = 'Asia/Shanghai'; // 固定 +08:00 无 DST，用固定偏移 ISO 串构造确定瞬时
// 2026-11-02=周一、11-06=周五、11-07=周六、11-08=周日（2026-11-03 为周二，倒推核实）
const at = (iso) => new Date(iso);

function makeTmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `msched-${label}-`));
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

function makeRegistry(entries) {
  const registry = new Map();
  for (const [providerId, models] of Object.entries(entries)) {
    const modelsMap = new Map();
    for (const [modelId, levels] of Object.entries(models)) modelsMap.set(modelId, new Set(levels));
    registry.set(providerId, modelsMap);
  }
  return registry;
}

const testRegistry = makeRegistry({
  magpie: {
    'group/flash': ['low', 'high', 'max'],
    'group/glm5.3': ['low', 'medium', 'high', 'xhigh', 'max'],
    'group/m3.1': ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  'builtin:bigmodel-start-plan': { 'GLM-5.3-Flash': ['low', 'high', 'max'] },
});

describe('loadSchedule', () => {
  test('合法 schedule 从临时文件加载成功', () => {
    const dir = makeTmpDir('sched');
    const configPath = path.join(dir, 'schedule.json');
    fs.writeFileSync(configPath, JSON.stringify(baseSchedule()));
    const schedule = loadSchedule(configPath);
    assert.equal(schedule.timezone, TZ);
    assert.equal(schedule.target.modelId, 'GLM-5.3-Flash');
  });

  test('schedule.example.json（仓库根）可通过 v2 schema 校验', () => {
    const toolSchedulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'schedule.example.json');
    const schedule = loadSchedule(toolSchedulePath);
    assert.equal(schedule.$schema, 'zcode-model-schedule/v2');
    assert.deepEqual(schedule.dayWindows, [{ days: [1, 2, 3, 4, 5], from: '08:50', to: '23:10' }]);
    assert.equal(schedule.availability.endpoint, 'https://zcode.z.ai/api/v1/zcode-plan/billing/current');
    assert.equal(schedule.agents.length, 3);
    assert.equal(schedule.agents.filter((a) => a.kind === 'custom').length, 2);
    assert.equal(schedule.agents.filter((a) => a.kind === 'builtin').length, 1);
  });

  test('$schema 不符 → throw', () => {
    const dir = makeTmpDir('sched');
    const configPath = path.join(dir, 'schedule.json');
    fs.writeFileSync(configPath, JSON.stringify({ ...baseSchedule(), $schema: 'zcode-model-schedule/v1' }));
    assert.throws(() => loadSchedule(configPath), /\$schema/);
  });

  test('非法 timezone → throw', () => {
    const dir = makeTmpDir('sched');
    const configPath = path.join(dir, 'schedule.json');
    fs.writeFileSync(configPath, JSON.stringify({ ...baseSchedule(), timezone: 'Mars/Olympus' }));
    assert.throws(() => loadSchedule(configPath), /timezone/);
  });

  test('文件不存在 → throw', () => {
    assert.throws(() => loadSchedule('/nonexistent/msched/schedule.json'), /无法读取/);
  });

  test('target 缺字段 / 非字符串 → throw', () => {
    const dir = makeTmpDir('sched');
    const configPath = path.join(dir, 'schedule.json');
    fs.writeFileSync(configPath, JSON.stringify(baseSchedule({ target: { providerId: 'x', modelId: '', reasoningLevel: 'max' } })));
    assert.throws(() => loadSchedule(configPath), /target\.modelId/);
  });

  test('agents 非法（空数组 / kind 非法 / name 空）→ throw', () => {
    const dir = makeTmpDir('sched');
    const mk = (agents) => {
      const p = path.join(dir, `sched-${Math.random().toString(36).slice(2)}.json`);
      fs.writeFileSync(p, JSON.stringify(baseSchedule({ agents })));
      return p;
    };
    assert.throws(() => loadSchedule(mk([])), /agents/);
    assert.throws(() => loadSchedule(mk([{ name: 'x', kind: 'helper' }])), /kind/);
    assert.throws(() => loadSchedule(mk([{ name: '', kind: 'builtin' }])), /name/);
  });

  test('dayWindows days 越界 / from 非 HH:MM → throw', () => {
    const dir = makeTmpDir('sched');
    const mk = (dayWindows) => {
      const p = path.join(dir, `sched-${Math.random().toString(36).slice(2)}.json`);
      fs.writeFileSync(p, JSON.stringify(baseSchedule({ dayWindows })));
      return p;
    };
    assert.throws(() => loadSchedule(mk([{ days: [0, 8], from: '08:50', to: '23:10' }])), /dayWindows\[0\]\.days/);
    assert.throws(() => loadSchedule(mk([{ days: [1], from: '8:50', to: '23:10' }])), /dayWindows\[0\]\.from/);
  });

  test('availability.enabled=true 缺 endpoint / timeout 非法 → throw', () => {
    const dir = makeTmpDir('sched');
    const configPath = path.join(dir, 'schedule.json');
    fs.writeFileSync(configPath, JSON.stringify(baseSchedule({ availability: { enabled: true, endpoint: '', provider: 'p', model: 'm', timeout: 5000 } })));
    assert.throws(() => loadSchedule(configPath), /endpoint/);
    const configPath2 = path.join(dir, 'schedule2.json');
    fs.writeFileSync(configPath2, JSON.stringify(baseSchedule({ availability: { enabled: true, endpoint: 'https://x', provider: 'p', model: 'm', timeout: -1 } })));
    assert.throws(() => loadSchedule(configPath2), /timeout/);
  });

  test('availability.enabled=false 时其余字段可缺省 → 通过', () => {
    const dir = makeTmpDir('sched');
    const configPath = path.join(dir, 'schedule.json');
    fs.writeFileSync(configPath, JSON.stringify(baseSchedule({ availability: { enabled: false } })));
    const schedule = loadSchedule(configPath);
    assert.equal(schedule.availability.enabled, false);
  });
});

describe('loadModelRegistry', () => {
  test('读取 reasoning.levels（magpie 形状）', () => {
    const dir = makeTmpDir('registry');
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      provider: { magpie: { models: { 'group/flash': { reasoning: { levels: ['low', 'high', 'max'] } } } } },
    }));
    const registry = loadModelRegistry(configPath);
    assert.deepEqual([...registry.get('magpie').get('group/flash')], ['low', 'high', 'max']);
  });

  test('读取 reasoning.variants（builtin:* 形状）', () => {
    const dir = makeTmpDir('registry');
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      provider: { 'builtin:bigmodel-start-plan': { models: { 'GLM-5.3-Flash': { reasoning: { variants: ['low', 'max', 'high'] } } } } },
    }));
    const registry = loadModelRegistry(configPath);
    assert.deepEqual([...registry.get('builtin:bigmodel-start-plan').get('GLM-5.3-Flash')], ['low', 'max', 'high']);
  });

  test('缺 provider 字段 → throw', () => {
    const dir = makeTmpDir('registry');
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ unrelated: true }));
    assert.throws(() => loadModelRegistry(configPath), /provider/);
  });
});

describe('parseSlotTime', () => {
  test('返回 ISO weekday 与当日分钟数', () => {
    assert.deepEqual(parseSlotTime(at('2026-11-02T09:30:00+08:00'), TZ), { day: 1, minutes: 570 });
    assert.deepEqual(parseSlotTime(at('2026-11-08T00:15:00+08:00'), TZ), { day: 7, minutes: 15 });
  });

  test('非法 timezone → throw', () => {
    assert.throws(() => parseSlotTime(new Date(), 'Not/AZone'));
  });
});

describe('inDayWindow', () => {
  const schedule = baseSchedule(); // dayWindows: 工作日 08:50-23:10

  test('周五 23:10（to 时刻严格不命中）→ false（target 窗）', () => {
    assert.equal(inDayWindow(schedule, at('2026-11-06T23:10:00+08:00')), false);
  });

  test('周五 23:09 → true（original 窗）', () => {
    assert.equal(inDayWindow(schedule, at('2026-11-06T23:09:00+08:00')), true);
  });

  test('周一 08:49 → false（target 窗）', () => {
    assert.equal(inDayWindow(schedule, at('2026-11-02T08:49:00+08:00')), false);
  });

  test('周一 08:50（from 时刻命中）→ true（original 窗）', () => {
    assert.equal(inDayWindow(schedule, at('2026-11-02T08:50:00+08:00')), true);
  });

  test('周六 03:00（days 不含 6）→ false（target 窗）', () => {
    assert.equal(inDayWindow(schedule, at('2026-11-07T03:00:00+08:00')), false);
  });

  test('周日 12:00 → false（target 窗）', () => {
    assert.equal(inDayWindow(schedule, at('2026-11-08T12:00:00+08:00')), false);
  });
});

describe('validateSchedule', () => {
  function writeAgentMd(dir, name = 'implementer') {
    const mdPath = path.join(dir, `${name}.md`);
    fs.writeFileSync(mdPath, ['---', `name: "${name}"`, 'model: magpie/group/flash', 'thoughtLevel: max', '---', '', '# body', ''].join('\n'), { mode: 0o644 });
    return mdPath;
  }

  test('合法配置（registry 命中 target + 临时 custom path 存在）→ valid', () => {
    const dir = makeTmpDir('valid');
    const mdPath = writeAgentMd(dir);
    const schedule = baseSchedule({
      target: { providerId: 'magpie', modelId: 'group/flash', reasoningLevel: 'max' },
      agents: [{ name: 'implementer', kind: 'custom', path: mdPath }, { name: 'Explore', kind: 'builtin' }],
    });
    const { valid, errors } = validateSchedule(schedule, testRegistry);
    assert.equal(valid, true);
    assert.deepEqual(errors, []);
  });

  test('target.providerId 在 registry：modelId 不在 provider 下 → 失败', () => {
    const schedule = baseSchedule({ target: { providerId: 'magpie', modelId: 'group/nope', reasoningLevel: 'max' } });
    const { valid, errors } = validateSchedule(schedule, testRegistry);
    assert.equal(valid, false);
    assert.equal(errors[0].scope, 'target');
    assert.match(errors[0].reason, /group\/nope/);
  });

  test('target.providerId 在 registry：reasoningLevel 不在支持列表 → 失败', () => {
    const schedule = baseSchedule({ target: { providerId: 'magpie', modelId: 'group/flash', reasoningLevel: 'medium' } });
    const { valid, errors } = validateSchedule(schedule, testRegistry);
    assert.equal(valid, false);
    assert.match(errors[0].reason, /reasoningLevel/);
  });

  test('模型未声明 reasoning 档位（levels 空）→ 按 THOUGHT_LEVELS 枚举放行，非法档位仍拒绝', () => {
    const emptyLevels = makeRegistry({ magpie: { 'group/trial': [] } });
    const ok = baseSchedule({ target: { providerId: 'magpie', modelId: 'group/trial', reasoningLevel: 'max' } });
    assert.equal(validateSchedule(ok, emptyLevels).valid, true);
    const bad = baseSchedule({ target: { providerId: 'magpie', modelId: 'group/trial', reasoningLevel: 'ultra' } });
    const { valid, errors } = validateSchedule(bad, emptyLevels);
    assert.equal(valid, false);
    assert.match(errors[0].reason, /ultra/);
  });

  test('account: 前缀 provider 不在 registry 且 modelId 全局存在 → 通过', () => {
    const dir = makeTmpDir('valid');
    const mdPath = writeAgentMd(dir);
    const schedule = baseSchedule({ agents: [{ name: 'implementer', kind: 'custom', path: mdPath }] });
    const { valid, errors } = validateSchedule(schedule, testRegistry);
    assert.equal(valid, true);
    assert.deepEqual(errors, []);
  });

  test('account: 前缀 provider 且 modelId 全局不存在 → 失败（scope=target）', () => {
    const schedule = baseSchedule({ target: { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-9.9', reasoningLevel: 'max' } });
    const { valid, errors } = validateSchedule(schedule, testRegistry);
    assert.equal(valid, false);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].scope, 'target');
    assert.match(errors[0].reason, /GLM-9\.9/);
  });

  test('provider 不在 registry 且 reasoningLevel ∉ THOUGHT_LEVELS → 失败', () => {
    const schedule = baseSchedule({ target: { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', reasoningLevel: 'ultra' } });
    const { valid, errors } = validateSchedule(schedule, testRegistry);
    assert.equal(valid, false);
    assert.match(errors[0].reason, /ultra/);
  });

  test('custom agent path 不存在 → 失败（scope=agents[i]）', () => {
    const schedule = baseSchedule({ agents: [{ name: 'ghost', kind: 'custom', path: '/nonexistent/msched/ghost.md' }] });
    const { valid, errors } = validateSchedule(schedule, testRegistry);
    assert.equal(valid, false);
    assert.equal(errors[0].scope, 'agents[0]');
    assert.match(errors[0].reason, /不存在/);
  });

  test('custom agent path 带 ~/ 前缀经 expandHome 解析后不存在 → 失败', () => {
    const schedule = baseSchedule({ agents: [{ name: 'ghost', kind: 'custom', path: '~/msched-nonexistent/ghost.md' }] });
    assert.equal(validateSchedule(schedule, testRegistry).valid, false);
  });

  test('dayWindows to <= from（跨午夜）→ 失败；days 越界 → 失败', () => {
    const crossMidnight = baseSchedule({ dayWindows: [{ days: [1], from: '23:10', to: '08:50' }] });
    const { valid, errors } = validateSchedule(crossMidnight, testRegistry);
    assert.equal(valid, false);
    assert.match(errors[0].reason, /跨午夜/);
    const badDays = baseSchedule({ dayWindows: [{ days: [0], from: '08:50', to: '23:10' }] });
    assert.equal(validateSchedule(badDays, testRegistry).valid, false);
  });
});

// ── 以下 apply-core 段自旧基线逐字继承（Task 3 原地增删；Task 2/4/5 末尾追加） ──
import {
  LockBusyError,
  acquireLock,
  releaseLock,
  computeTargetState,
  modeChanged,
  diffBuiltinState,
  applyBuiltinOverrides,
  computeCustomAgentChanges,
  applyCustomAgent,
  appendHistory,
} from '../lib/apply-core.mjs';

function writeStateFixture(dir) {
  const statePath = path.join(dir, 'agents-state.json');
  const state = {
    builtInModelOverrides: { 'general-purpose': 'custom:x', Explore: 'custom:y' },
    builtInThoughtLevelOverrides: {},
    disabledAgentIds: [],
    builtInModelSelectionOverrides: {
      Explore: { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } },
      'general-purpose': { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } },
    },
    pluginAgentModelSelectionOverrides: { 'plugin:documents@0.1.0': { providerId: 'magpie', modelId: 'group/flash' } },
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o644 });
  return statePath;
}

describe('diffBuiltinState', () => {
  const targetState = {
    Explore: { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } },
  };

  test('无变更 → changed=false', () => {
    const current = { builtInModelSelectionOverrides: { Explore: { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } } } };
    assert.deepEqual(diffBuiltinState(current, targetState), { changed: false, changes: [] });
  });

  test('单字段变更 → changes 含 1 条', () => {
    const current = { builtInModelSelectionOverrides: { Explore: { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'low' } } } };
    const { changed, changes } = diffBuiltinState(current, targetState);
    assert.equal(changed, true);
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0], { agent: 'Explore', field: 'reasoningLevel', old: 'low', new: 'max' });
  });

  test('多字段变更 → changes 含多条', () => {
    const current = { builtInModelSelectionOverrides: { Explore: { providerId: 'other', modelId: 'group/other', options: { reasoningLevel: 'low' } } } };
    const { changed, changes } = diffBuiltinState(current, targetState);
    assert.equal(changed, true);
    assert.equal(changes.length, 3);
  });

  test('当前态缺 key → 视为新增（old=null）', () => {
    const current = { builtInModelSelectionOverrides: {} };
    const { changed, changes } = diffBuiltinState(current, targetState);
    assert.equal(changed, true);
    assert.deepEqual(changes, [
      { agent: 'Explore', field: 'providerId', old: null, new: 'magpie' },
      { agent: 'Explore', field: 'modelId', old: null, new: 'group/flash' },
      { agent: 'Explore', field: 'reasoningLevel', old: null, new: 'max' },
    ]);
  });
});

describe('applyBuiltinOverrides', () => {
  const targetState = {
    Explore: { providerId: 'magpie', modelId: 'group/glm5.3', options: { reasoningLevel: 'max' } },
    'general-purpose': { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'low' } },
  };

  test('幂等：目标=当前 → written=false，文件字节不变', () => {
    const dir = makeTmpDir('state');
    const statePath = writeStateFixture(dir);
    const before = fs.readFileSync(statePath);
    const target = {
      Explore: { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } },
      'general-purpose': { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } },
    };
    const result = applyBuiltinOverrides(statePath, target);
    assert.deepEqual(result, { written: false, reason: 'no-change', path: statePath, changes: [] });
    assert.ok(before.equals(fs.readFileSync(statePath)));
  });

  test('写入目标值；只改目标 key 不动其他 key；mode 保持 0644', () => {
    const dir = makeTmpDir('state');
    const statePath = writeStateFixture(dir);
    const result = applyBuiltinOverrides(statePath, targetState);
    assert.equal(result.written, true);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.deepEqual(state.builtInModelSelectionOverrides.Explore, { providerId: 'magpie', modelId: 'group/glm5.3', options: { reasoningLevel: 'max' } });
    assert.deepEqual(state.builtInModelSelectionOverrides['general-purpose'], { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'low' } });
    // 其他 key 原样保留
    assert.deepEqual(state.builtInModelOverrides, { 'general-purpose': 'custom:x', Explore: 'custom:y' });
    assert.deepEqual(state.disabledAgentIds, []);
    assert.deepEqual(state.builtInThoughtLevelOverrides, {});
    assert.deepEqual(state.pluginAgentModelSelectionOverrides, { 'plugin:documents@0.1.0': { providerId: 'magpie', modelId: 'group/flash' } });
    assert.equal((fs.statSync(statePath).mode & 0o777).toString(8), '644');
    // 无 tmp 残留
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
  });

  test('force=true：无 diff 也重写（written=true）', () => {
    const dir = makeTmpDir('state');
    const statePath = writeStateFixture(dir);
    const sameState = {
      Explore: { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } },
      'general-purpose': { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } },
    };
    const result = applyBuiltinOverrides(statePath, sameState, { force: true });
    assert.equal(result.written, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).builtInModelSelectionOverrides, sameState);
  });
});

describe('applyCustomAgent / computeCustomAgentChanges', () => {
  const SAMPLE_MD = [
    '---',
    'name: "reviewer"',
    'description: "Reviews code changes..."',
    'color: pink',
    'model: magpie/group/flash',
    'thoughtLevel: max',
    'tools:',
    '  - Read',
    '  - Grep',
    '  - Glob',
    '---',
    '',
    '# Reviewer body',
    '正文段落。',
    '',
  ].join('\n');

  function writeAgentMd(dir, body = SAMPLE_MD) {
    const mdPath = path.join(dir, 'reviewer.md');
    fs.writeFileSync(mdPath, body, { mode: 0o644 });
    return mdPath;
  }

  test('替换 model 行，其余行原序保留（diff 只含 model 行）', () => {
    const dir = makeTmpDir('agent');
    const mdPath = writeAgentMd(dir);
    const result = applyCustomAgent(mdPath, { model: 'magpie/group/glm5.3', thoughtLevel: 'max' });
    assert.equal(result.written, true);
    assert.deepEqual(result.changes, [{ field: 'model', old: 'model: magpie/group/flash', new: 'model: magpie/group/glm5.3' }]);
    const out = fs.readFileSync(mdPath, 'utf8');
    const expected = SAMPLE_MD.replace('model: magpie/group/flash', 'model: magpie/group/glm5.3');
    assert.equal(out, expected); // 行序 + body + 结尾换行逐字节一致
  });

  test('model 行替换后为完整 providerId/modelId 格式；带引号旧行也整行替换', () => {
    const dir = makeTmpDir('agent');
    const quoted = SAMPLE_MD.replace('model: magpie/group/flash', 'model: "account:bigmodel-start-plan/GLM-5.3-Flash"');
    const mdPath = writeAgentMd(dir, quoted);
    const result = applyCustomAgent(mdPath, { model: 'magpie/group/flash', thoughtLevel: 'max' });
    assert.equal(result.written, true);
    assert.ok(fs.readFileSync(mdPath, 'utf8').includes('\nmodel: magpie/group/flash\n'));
  });

  test('替换 thoughtLevel 行', () => {
    const dir = makeTmpDir('agent');
    const mdPath = writeAgentMd(dir);
    const result = applyCustomAgent(mdPath, { model: 'magpie/group/flash', thoughtLevel: 'low' });
    assert.equal(result.written, true);
    assert.deepEqual(result.changes, [{ field: 'thoughtLevel', old: 'thoughtLevel: max', new: 'thoughtLevel: low' }]);
    assert.ok(fs.readFileSync(mdPath, 'utf8').includes('thoughtLevel: low'));
  });

  test('thoughtLevel 行不存在时插入到 model 行后', () => {
    const dir = makeTmpDir('agent');
    const noThought = SAMPLE_MD.replace('thoughtLevel: max\n', '');
    const mdPath = writeAgentMd(dir, noThought);
    const result = applyCustomAgent(mdPath, { model: 'magpie/group/flash', thoughtLevel: 'low' });
    assert.equal(result.written, true);
    const lines = fs.readFileSync(mdPath, 'utf8').split('\n');
    const modelIdx = lines.indexOf('model: magpie/group/flash');
    assert.equal(lines[modelIdx + 1], 'thoughtLevel: low');
    assert.deepEqual(result.changes, [{ field: 'thoughtLevel', old: null, new: 'thoughtLevel: low' }]);
  });

  test('无变更 → written=false 且文件不动', () => {
    const dir = makeTmpDir('agent');
    const mdPath = writeAgentMd(dir);
    const before = fs.readFileSync(mdPath);
    const result = applyCustomAgent(mdPath, { model: 'magpie/group/flash', thoughtLevel: 'max' });
    assert.equal(result.written, false);
    assert.deepEqual(result.changes, []);
    assert.ok(before.equals(fs.readFileSync(mdPath)));
  });

  test('frontmatter 外内容不被修改', () => {
    const dir = makeTmpDir('agent');
    const mdPath = writeAgentMd(dir);
    applyCustomAgent(mdPath, { model: 'magpie/group/glm5.3', thoughtLevel: 'low' });
    const out = fs.readFileSync(mdPath, 'utf8');
    assert.ok(out.endsWith('---\n\n# Reviewer body\n正文段落。\n'));
    assert.ok(out.includes('  - Read\n  - Grep\n  - Glob\n---'));
  });

  test('无 frontmatter → throw；缺 model: 行 → throw', () => {
    assert.throws(() => computeCustomAgentChanges('no frontmatter here\n', { model: 'x', thoughtLevel: 'low' }), /frontmatter/);
    const noModel = SAMPLE_MD.replace('model: magpie/group/flash\n', '');
    assert.throws(() => computeCustomAgentChanges(noModel, { model: 'x', thoughtLevel: 'low' }), /model: 行/);
  });
});

describe('appendHistory', () => {
  test('追加一行 JSON；time 缺省补 ISO', () => {
    const dir = makeTmpDir('history');
    const historyPath = path.join(dir, 'nested', 'history.jsonl');
    appendHistory(historyPath, { mode: 'target', reason: 'switch', agents: ['implementer', 'vision', 'Explore'] });
    const lines = fs.readFileSync(historyPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.mode, 'target');
    assert.equal(record.reason, 'switch');
    assert.deepEqual(record.agents, ['implementer', 'vision', 'Explore']);
    assert.ok(!Number.isNaN(Date.parse(record.time)));
  });
});

describe('acquireLock / releaseLock', () => {
  test('占用中再次抢锁 → LockBusyError；释放后可重新抢锁', () => {
    const lockPath = path.join(makeTmpDir('lock'), '.apply.lock');
    const token = acquireLock(lockPath);
    assert.throws(() => acquireLock(lockPath), (err) => err instanceof LockBusyError && err.code === 'LOCK_BUSY');
    releaseLock(lockPath, token);
    const token2 = acquireLock(lockPath); // 不抛即通过
    releaseLock(lockPath, token2);
  });

  test('releaseLock 幂等（锁不存在再释放不抛）', () => {
    const lockPath = path.join(makeTmpDir('lock'), '.apply.lock');
    assert.equal(releaseLock(lockPath, 'any-token'), false); // 锁不存在 → false 静默，不抛
  });

  // ── F5：陈旧锁回收 ──
  test('陈旧锁（mtime >10min）→ 可重抢', () => {
    const dir = makeTmpDir('lock-stale');
    const lockPath = path.join(dir, '.apply.lock');
    // 创建锁文件，PID=99999（不存在），mtime 设为 11 分钟前
    fs.writeFileSync(lockPath, '99999\n', { mode: 0o644 });
    const oldTime = Date.now() - 660000; // 11 分钟前
    fs.utimesSync(lockPath, new Date(oldTime), new Date(oldTime));
    // 重抢应成功（删除旧锁并创建新锁）
    const token = acquireLock(lockPath);
    releaseLock(lockPath, token);
  });

  test('死进程活锁（pid 不存在 + mtime 新鲜）→ 可重抢', () => {
    const dir = makeTmpDir('lock-dead');
    const lockPath = path.join(dir, '.apply.lock');
    fs.writeFileSync(lockPath, '99999\n', { mode: 0o644 });
    // mtime 保持当前（不陈旧），但 pid=99999 不存在
    const token = acquireLock(lockPath);
    releaseLock(lockPath, token);
  });

  test('活锁（pid 存在 + mtime 新鲜）→ LockBusyError', () => {
    const dir = makeTmpDir('lock-live');
    const lockPath = path.join(dir, '.apply.lock');
    // 用当前进程 PID 写锁，mtime 为当前时间
    fs.writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o644 });
    assert.throws(() => acquireLock(lockPath), (err) => err instanceof LockBusyError && err.code === 'LOCK_BUSY');
  });

  // ── 锁竞态修复新增用例（spec 2026-11-03-lock-race §4 用例 1-8；无 sleep，锁文件直接构造）──
  test('不可读+fresh（目录 EISDIR）→ LockBusyError 且目标不删除【旧代码 unlink 被吞 → open EISDIR crash】', () => {
    const lockPath = makeTmpDir('lock-eisdir'); // 用目录本身当锁路径 → openSync('wx') EEXIST → readFileSync EISDIR
    assert.throws(() => acquireLock(lockPath), (err) => err instanceof LockBusyError && err.code === 'LOCK_BUSY');
    assert.equal(fs.existsSync(lockPath), true); // reap 不动 EISDIR → 目录仍在
  });

  test('不可读+陈旧（目录 EISDIR + mtime -11min）→ LockBusyError（reap 失败不 crash）', () => {
    const lockPath = makeTmpDir('lock-eisdir-stale');
    const oldTime = Date.now() - 660000; // 11 分钟前
    fs.utimesSync(lockPath, new Date(oldTime), new Date(oldTime));
    assert.throws(() => acquireLock(lockPath), (err) => err instanceof LockBusyError && err.code === 'LOCK_BUSY');
    assert.equal(fs.existsSync(lockPath), true); // unlinkSync 对目录非 ENOENT → busy 而非 crash
  });

  test('空文件（0 字节）+fresh → LockBusyError 且文件仍在', () => {
    const lockPath = path.join(makeTmpDir('lock-empty'), '.apply.lock');
    fs.writeFileSync(lockPath, '', { mode: 0o644 });
    assert.throws(() => acquireLock(lockPath), (err) => err instanceof LockBusyError && err.code === 'LOCK_BUSY');
    assert.equal(fs.existsSync(lockPath), true);
  });

  test('非 JSON 内容 garbage +fresh → LockBusyError 且文件仍在', () => {
    const lockPath = path.join(makeTmpDir('lock-garbage'), '.apply.lock');
    fs.writeFileSync(lockPath, 'garbage\n', { mode: 0o644 });
    assert.throws(() => acquireLock(lockPath), (err) => err instanceof LockBusyError && err.code === 'LOCK_BUSY');
    assert.equal(fs.existsSync(lockPath), true);
  });

  test('非 JSON garbage + mtime >10min → 接管成功返回 token', () => {
    const lockPath = path.join(makeTmpDir('lock-garbage-stale'), '.apply.lock');
    fs.writeFileSync(lockPath, 'garbage\n', { mode: 0o644 });
    const oldTime = Date.now() - 660000;
    fs.utimesSync(lockPath, new Date(oldTime), new Date(oldTime));
    const token = acquireLock(lockPath);
    assert.equal(typeof token, 'string');
    assert.ok(token.length > 0);
    fs.unlinkSync(lockPath); // 卡 1 阶段 releaseLock 未改签名 → 直接 unlink 清理本用例自建的锁
  });

  test('JSON 锁（活 pid + foreign token）+fresh → LockBusyError', () => {
    const lockPath = path.join(makeTmpDir('lock-json-live'), '.apply.lock');
    const holder = { pid: process.pid, token: 'holder-token', startedAt: new Date().toISOString() };
    fs.writeFileSync(lockPath, JSON.stringify(holder) + '\n', { mode: 0o644 });
    assert.throws(() => acquireLock(lockPath), (err) => err instanceof LockBusyError && err.code === 'LOCK_BUSY');
    assert.equal(fs.existsSync(lockPath), true);
  });

  test('JSON 锁（pid 99999 已死）+fresh → 解析 pid 判死接管【旧代码不解析 JSON pid → 误判 busy】', () => {
    const lockPath = path.join(makeTmpDir('lock-json-dead'), '.apply.lock');
    const staleHolder = { pid: 99999, token: 'dead-holder', startedAt: new Date().toISOString() };
    fs.writeFileSync(lockPath, JSON.stringify(staleHolder) + '\n', { mode: 0o644 });
    const token = acquireLock(lockPath);
    assert.equal(typeof token, 'string');
    fs.unlinkSync(lockPath);
  });

  test('JSON 锁（活 pid）+ mtime >10min → 陈旧接管返回 token', () => {
    const lockPath = path.join(makeTmpDir('lock-json-stale'), '.apply.lock');
    const holder = { pid: process.pid, token: 'stale-holder', startedAt: new Date().toISOString() };
    fs.writeFileSync(lockPath, JSON.stringify(holder) + '\n', { mode: 0o644 });
    const oldTime = Date.now() - 660000;
    fs.utimesSync(lockPath, new Date(oldTime), new Date(oldTime));
    const token = acquireLock(lockPath);
    assert.equal(typeof token, 'string');
    fs.unlinkSync(lockPath);
  });

  // ── releaseLock token 化用例（spec 2026-11-03-lock-race §4 用例 9-11）──
  test('releaseLock(path, 正确 token) → true 且锁文件删除', () => {
    const lockPath = path.join(makeTmpDir('lock-rel'), '.apply.lock');
    const token = acquireLock(lockPath);
    assert.equal(releaseLock(lockPath, token), true);
    assert.equal(fs.existsSync(lockPath), false);
  });

  test('他人接管后原持有者 releaseLock(tokenA) → false 不抛、他人锁原样保留（决策①④）', () => {
    const lockPath = path.join(makeTmpDir('lock-takeover'), '.apply.lock');
    const tokenA = acquireLock(lockPath);
    // 模拟旧 bug 场景：锁被他人接管（外部 unlink + 写入他人 JSON 锁）
    fs.unlinkSync(lockPath);
    const other = { pid: process.pid, token: 'other-token', startedAt: new Date().toISOString() };
    fs.writeFileSync(lockPath, JSON.stringify(other) + '\n', { mode: 0o644 });
    assert.equal(releaseLock(lockPath, tokenA), false); // token 不符 → false 静默，不删
    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'other-token'); // 他人锁原样
  });

  test('releaseLock(path) 缺 token → TypeError（签名契约）【旧代码不抛】', () => {
    const lockPath = path.join(makeTmpDir('lock-notoken'), '.apply.lock');
    assert.throws(() => releaseLock(lockPath), TypeError);
  });

  // ── 用例 12：原 1/25 flake 的确定性复现（spec §4 用例 12 / §Acceptance）──
  // 子进程 monkey-patch fs.readFileSync：首次读到锁文件后在 read 与 stat 之间 unlink（模拟持有方释放），
  // 旧实现 statSync ENOENT 未捕获 → child exit 1；新实现 gone → 重试 → 自持 → 自释 → exit 0
  test('确定性竞态回归：持有方在 read 与 stat 之间释放 → acquireLock 重试自持（原 1/25 flake）', () => {
    const dir = makeTmpDir('lock-race');
    const lockPath = path.join(dir, '.apply.lock');
    const childPath = path.join(dir, 'race-child.mjs');
    const coreAbs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'apply-core.mjs');
    const childSource = `// race-child.mjs — 竞态注入：模拟持有方在 acquireLock 的 read 与 stat 之间释放锁
import fs from 'node:fs';
const lockPath = ${JSON.stringify(lockPath)};
const coreUrl = ${JSON.stringify(pathToFileURL(coreAbs).href)};
const originalReadFileSync = fs.readFileSync;
let injected = false; // 注入只触发一次：首次读到锁文件即删除，后续读（如 releaseLock 内部）不再干扰
fs.readFileSync = function patchedReadFileSync(p, ...rest) {
  const result = originalReadFileSync(p, ...rest);
  if (!injected && p === lockPath) {
    injected = true;
    try { fs.unlinkSync(lockPath); } catch (e) { if (e.code !== 'ENOENT') throw e; } // 容忍 ENOENT：锁恰已被并发方删除正是被模拟的竞态终态；try 仅一条语句
  }
  return result;
};
const { acquireLock, releaseLock } = await import(coreUrl);
const token = acquireLock(lockPath);
if (typeof token !== 'string' || token.length === 0) {
  console.error('acquireLock 未返回 token:', token);
  process.exit(1);
}
if (releaseLock(lockPath, token) !== true) {
  console.error('releaseLock 应返回 true');
  process.exit(1);
}
`;
    fs.writeFileSync(childPath, childSource, { mode: 0o644 });
    // 预置活 JSON 锁（模拟真实持有方；pid=本测试进程，必活）
    const holder = { pid: process.pid, token: 'holder-token', startedAt: new Date().toISOString() };
    fs.writeFileSync(lockPath, JSON.stringify(holder) + '\n', { mode: 0o644 });
    const r = spawnSync(process.execPath, [childPath], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, `child 应 exit 0, status=${r.status}, stderr=${r.stderr}`);
    assert.equal(fs.existsSync(lockPath), false, 'child 释放后锁文件应不存在');
  });
});

// ── Task 2 追加：state + availability ──
import { loadState, saveState, captureSnapshot } from '../lib/state.mjs';
import { checkAvailability } from '../lib/availability.mjs';

// 捕获 console.error 输出（断言 [warn] 容错日志用）；用后必还原
async function captureStderr(fn) {
  const original = console.error;
  let captured = '';
  console.error = (msg) => {
    captured += `${msg}\n`;
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return captured;
}

// 仅含 availability 键的最小 schedule（checkAvailability 只读 schedule.availability）
function availSchedule(overrides = {}) {
  return {
    availability: {
      enabled: true,
      endpoint: 'https://billing.example.invalid/api',
      provider: 'builtin:bigmodel-start-plan',
      model: 'model:glm-5.3-flash',
      timeout: 5000,
      ...overrides,
    },
  };
}

describe('loadState', () => {
  test('state 不存在 → 默认 original 无快照', () => {
    const statePath = path.join(makeTmpDir('state'), 'state.json');
    assert.deepEqual(loadState(statePath), { mode: 'original', snapshot: null, switchedAt: null, lastCheck: null });
  });

  test('合法 state 读取（全字段 roundtrip）', () => {
    const dir = makeTmpDir('state');
    const statePath = path.join(dir, 'state.json');
    const written = {
      mode: 'target',
      switchedAt: '2026-11-03T15:10:00.000Z',
      snapshot: { Explore: { providerId: 'a', modelId: 'b', options: { reasoningLevel: 'max' } } },
      lastCheck: '2026-11-03T15:12:00.000Z',
    };
    saveState(statePath, written);
    assert.deepEqual(loadState(statePath), written);
  });

  test('乱码损坏 → 默认态 + stderr [warn]，不 throw', async () => {
    const dir = makeTmpDir('state');
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, 'garbage{{{', { mode: 0o644 });
    let snapState;
    const stderr = await captureStderr(() => {
      snapState = loadState(statePath);
    });
    assert.deepEqual(snapState, { mode: 'original', snapshot: null, switchedAt: null, lastCheck: null });
    assert.match(stderr, /\[warn\] state\.json 损坏/);
  });

  test('顶层非对象（[]）→ 视为损坏默认态 + [warn]', async () => {
    const dir = makeTmpDir('state');
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, '[]', { mode: 0o644 });
    let snapState;
    const stderr = await captureStderr(() => {
      snapState = loadState(statePath);
    });
    assert.equal(snapState.mode, 'original');
    assert.match(stderr, /\[warn\]/);
  });

  test('mode 垃圾值 → 归一为 original', () => {
    const dir = makeTmpDir('state');
    const statePath = path.join(dir, 'state.json');
    saveState(statePath, { mode: 'weird', snapshot: {}, switchedAt: null, lastCheck: null });
    const state = loadState(statePath);
    assert.equal(state.mode, 'original');
    assert.deepEqual(state.snapshot, {});
  });
});

describe('saveState', () => {
  test('写入后 loadState roundtrip；首次写默认 0644；无 tmp 残留', () => {
    const dir = makeTmpDir('state');
    const statePath = path.join(dir, 'state.json');
    saveState(statePath, { mode: 'target', switchedAt: null, snapshot: null, lastCheck: null });
    assert.equal(loadState(statePath).mode, 'target');
    assert.equal((fs.statSync(statePath).mode & 0o777).toString(8), '644');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
  });

  test('已存在文件 mode 保持（0600 → 仍 0600）', () => {
    const dir = makeTmpDir('state');
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, '{}', { mode: 0o600 });
    saveState(statePath, { mode: 'target', switchedAt: null, snapshot: null, lastCheck: null });
    assert.equal((fs.statSync(statePath).mode & 0o777).toString(8), '600');
  });
});

describe('captureSnapshot', () => {
  const SNAP_MD = ['---', 'name: "implementer"', 'description: "snap fixture"', 'model: "account:old-acct/GLM-9"', 'thoughtLevel: high', '---', '', '# body', ''].join('\n');

  function writeSnapMd(dir, name = 'implementer', body = SNAP_MD) {
    const mdPath = path.join(dir, `${name}.md`);
    fs.writeFileSync(mdPath, body, { mode: 0o644 });
    return mdPath;
  }

  test('builtin：读 agents-state.json builtInModelSelectionOverrides 当前值', () => {
    const dir = makeTmpDir('snap');
    const statePath = writeStateFixture(dir);
    assert.deepEqual(captureSnapshot([{ name: 'Explore', kind: 'builtin' }], statePath, dir), {
      Explore: { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } },
    });
  });

  test('builtin 缺 key → 该 agent 记 null', () => {
    const dir = makeTmpDir('snap');
    const statePath = writeStateFixture(dir);
    assert.deepEqual(captureSnapshot([{ name: 'Reviewer', kind: 'builtin' }], statePath, dir), { Reviewer: null });
  });

  test('custom 显式 path：model/thoughtLevel 原值（引号形态逐字保留）', () => {
    const dir = makeTmpDir('snap');
    const statePath = writeStateFixture(dir);
    const mdPath = writeSnapMd(dir);
    assert.deepEqual(captureSnapshot([{ name: 'implementer', kind: 'custom', path: mdPath }], statePath, dir), {
      implementer: { model: '"account:old-acct/GLM-9"', thoughtLevel: 'high' },
    });
  });

  test('custom 无 path → agentsDir/<name>.md 默认拼接', () => {
    const dir = makeTmpDir('snap');
    const statePath = writeStateFixture(dir);
    const agentsDir = makeTmpDir('snap-agents');
    writeSnapMd(agentsDir, 'vision');
    assert.deepEqual(captureSnapshot([{ name: 'vision', kind: 'custom' }], statePath, agentsDir), {
      vision: { model: '"account:old-acct/GLM-9"', thoughtLevel: 'high' },
    });
  });

  test('custom md 缺失 → null + [warn]', async () => {
    const dir = makeTmpDir('snap');
    const statePath = writeStateFixture(dir);
    let snap;
    const stderr = await captureStderr(() => {
      snap = captureSnapshot([{ name: 'ghost', kind: 'custom', path: '/nonexistent/msched/ghost.md' }], statePath, dir);
    });
    assert.deepEqual(snap, { ghost: null });
    assert.match(stderr, /\[warn\].*ghost\.md/);
  });

  test('agents-state 损坏 → builtin 记 null + [warn]，custom 仍读取', async () => {
    const dir = makeTmpDir('snap');
    const statePath = path.join(dir, 'agents-state.json');
    fs.writeFileSync(statePath, 'not-json{{{', { mode: 0o644 });
    const mdPath = writeSnapMd(dir);
    let snap;
    const stderr = await captureStderr(() => {
      snap = captureSnapshot([{ name: 'Explore', kind: 'builtin' }, { name: 'implementer', kind: 'custom', path: mdPath }], statePath, dir);
    });
    assert.equal(snap.Explore, null);
    assert.deepEqual(snap.implementer, { model: '"account:old-acct/GLM-9"', thoughtLevel: 'high' });
    assert.match(stderr, /\[warn\]/);
  });
});

describe('checkAvailability', () => {
  const API_KEY = 'msched-test-secret-key';
  const ORIGINAL_FETCH = globalThis.fetch;

  // mock fetch：用后必还原（finally），禁止真实网络
  function withFetch(mock, fn) {
    globalThis.fetch = mock;
    return Promise.resolve()
      .then(fn)
      .finally(() => {
        globalThis.fetch = ORIGINAL_FETCH;
      });
  }

  function okResponse(payload) {
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  }

  function writeAvailConfig(dir, { apiKey } = {}) {
    const configPath = path.join(dir, 'config.json');
    const providerConf = { models: { 'GLM-5.3-Flash': { reasoning: { variants: ['low', 'max', 'high'] } } } };
    if (apiKey !== undefined) providerConf.options = { apiKey };
    fs.writeFileSync(configPath, JSON.stringify({ provider: { 'builtin:bigmodel-start-plan': providerConf } }));
    return configPath;
  }

  const ACTIVE_OK = {
    server_time: 1800000000,
    plans: [
      { status: 'active', starts_at: 1790000000, ends_at: 1810000000, entitlements: [{ capabilities: ['model:glm-5.3-flash', 'other:cap'] }] },
    ],
  };

  test('active plan + entitlement 匹配 + 窗口内 → available ok + plan.endsAt + Bearer header', async () => {
    const configPath = writeAvailConfig(makeTmpDir('avail'), { apiKey: API_KEY });
    let capturedHeaders;
    const result = await withFetch(async (_url, init) => {
      capturedHeaders = init.headers;
      return okResponse(ACTIVE_OK);
    }, () => checkAvailability(availSchedule(), configPath));
    assert.deepEqual(result, { available: true, reason: 'ok', plan: { endsAt: 1810000000 } });
    assert.equal(capturedHeaders.Authorization, `Bearer ${API_KEY}`);
  });

  test("plan status='expired' → no-active-plan", async () => {
    const configPath = writeAvailConfig(makeTmpDir('avail'), { apiKey: API_KEY });
    const payload = { server_time: 1800000000, plans: [{ status: 'expired', starts_at: 1700000000, ends_at: 1750000000, entitlements: [{ capabilities: ['model:glm-5.3-flash'] }] }] };
    const result = await withFetch(async () => okResponse(payload), () => checkAvailability(availSchedule(), configPath));
    assert.deepEqual(result, { available: false, reason: 'no-active-plan' });
  });

  test('active plan 无匹配 entitlement → no-entitlement', async () => {
    const configPath = writeAvailConfig(makeTmpDir('avail'), { apiKey: API_KEY });
    const payload = { server_time: 1800000000, plans: [{ status: 'active', starts_at: 1790000000, ends_at: 1810000000, entitlements: [{ capabilities: ['other:cap'] }] }] };
    const result = await withFetch(async () => okResponse(payload), () => checkAvailability(availSchedule(), configPath));
    assert.deepEqual(result, { available: false, reason: 'no-entitlement' });
  });

  test('active plan 但 server_time >= ends_at → not-in-window', async () => {
    const configPath = writeAvailConfig(makeTmpDir('avail'), { apiKey: API_KEY });
    const payload = { server_time: 1800000000, plans: [{ status: 'active', starts_at: 1700000000, ends_at: 1750000000, entitlements: [{ capabilities: ['model:glm-5.3-flash'] }] }] };
    const result = await withFetch(async () => okResponse(payload), () => checkAvailability(availSchedule(), configPath));
    assert.deepEqual(result, { available: false, reason: 'not-in-window' });
  });

  test('HTTP 500 → non-200', async () => {
    const configPath = writeAvailConfig(makeTmpDir('avail'), { apiKey: API_KEY });
    const result = await withFetch(async () => ({ ok: false, status: 500, text: async () => 'server error' }), () => checkAvailability(availSchedule(), configPath));
    assert.deepEqual(result, { available: false, reason: 'non-200' });
  });

  test('fetch reject TimeoutError → timeout', async () => {
    const configPath = writeAvailConfig(makeTmpDir('avail'), { apiKey: API_KEY });
    const result = await withFetch(async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }, () => checkAvailability(availSchedule(), configPath));
    assert.deepEqual(result, { available: false, reason: 'timeout' });
  });

  test('fetch reject TypeError（网络不可达） → http-error', async () => {
    const configPath = writeAvailConfig(makeTmpDir('avail'), { apiKey: API_KEY });
    const result = await withFetch(async () => {
      throw new TypeError('fetch failed');
    }, () => checkAvailability(availSchedule(), configPath));
    assert.deepEqual(result, { available: false, reason: 'http-error' });
  });

  test('200 响应非 JSON → parse-error', async () => {
    const configPath = writeAvailConfig(makeTmpDir('avail'), { apiKey: API_KEY });
    const result = await withFetch(async () => ({ ok: true, status: 200, text: async () => '<html>not json</html>' }), () => checkAvailability(availSchedule(), configPath));
    assert.deepEqual(result, { available: false, reason: 'parse-error' });
  });

  test('enabled:false → disabled 且不发请求', async () => {
    const configPath = writeAvailConfig(makeTmpDir('avail'), { apiKey: API_KEY });
    let called = false;
    const result = await withFetch(() => {
      called = true;
      return okResponse(ACTIVE_OK);
    }, () => checkAvailability(availSchedule({ enabled: false }), configPath));
    assert.deepEqual(result, { available: true, reason: 'disabled' });
    assert.equal(called, false);
  });

  test('apiKey 缺失 → http-error 且不发请求', async () => {
    const configPath = writeAvailConfig(makeTmpDir('avail')); // 无 options.apiKey
    let called = false;
    const result = await withFetch(() => {
      called = true;
      return okResponse(ACTIVE_OK);
    }, () => checkAvailability(availSchedule(), configPath));
    assert.deepEqual(result, { available: false, reason: 'http-error' });
    assert.equal(called, false);
  });

  test('config.json 读不到 → http-error（不 throw，无 [warn] 外泄 apiKey）', async () => {
    let result;
    await captureStderr(async () => {
      result = await checkAvailability(availSchedule(), '/nonexistent/msched/config.json');
    });
    assert.deepEqual(result, { available: false, reason: 'http-error' });
  });

  test('apiKey 不出现在返回值/原因串中（成功与失败路径）', async () => {
    const configPath = writeAvailConfig(makeTmpDir('avail'), { apiKey: API_KEY });
    const results = [];
    await withFetch(async () => okResponse(ACTIVE_OK), async () => {
      results.push(await checkAvailability(availSchedule(), configPath));
      results.push(await checkAvailability(availSchedule({ model: 'model:none' }), configPath));
    });
    assert.equal(JSON.stringify(results).includes(API_KEY), false);
  });

  test('畸形 config.json（含 apiKey 字面量但 JSON 坏）→ 不 throw，available:false，stderr 不含 apiKey', async () => {
    const dir = makeTmpDir('avail-malformed');
    const configPath = path.join(dir, 'config.json');
    // 故意写成损坏 JSON，但字面量含 apiKey 片段（验证 warn 不回显 err.message）
    fs.writeFileSync(configPath, '{ "provider": { "builtin:bigmodel-start-plan": { "options": { "apiKey": "msched-leak-secret-xyz" } }', { mode: 0o644 });
    const LEAK = 'msched-leak-secret-xyz';
    let result;
    const stderr = await captureStderr(async () => {
      result = await checkAvailability(availSchedule(), configPath);
    });
    assert.deepEqual(result, { available: false, reason: 'http-error' });
    assert.equal(stderr.includes(LEAK), false);
  });

  test('200 响应体为 null → parse-error，不 throw', async () => {
    const configPath = writeAvailConfig(makeTmpDir('avail'), { apiKey: API_KEY });
    const result = await withFetch(async () => ({ ok: true, status: 200, text: async () => 'null' }), () => checkAvailability(availSchedule(), configPath));
    assert.deepEqual(result, { available: false, reason: 'parse-error' });
  });

  test('200 响应体 data.plans 含 null → 剔除非对象元素，无 active plan', async () => {
    const configPath = writeAvailConfig(makeTmpDir('avail'), { apiKey: API_KEY });
    const payload = { server_time: 1800000000, plans: [null] };
    const result = await withFetch(async () => okResponse(payload), () => checkAvailability(availSchedule(), configPath));
    assert.deepEqual(result, { available: false, reason: 'no-active-plan' });
  });

  test('config.json 不存在 → 仍 http-error，不 throw（确认既有路径仍绿）', async () => {
    let result;
    const stderr = await captureStderr(async () => {
      result = await checkAvailability(availSchedule(), '/nonexistent/msched/config.json');
    });
    assert.deepEqual(result, { available: false, reason: 'http-error' });
  });

  // ── 信封解包用例（spec 2026-11-04-availability-envelope-fix）：真实端点 200 为 { code, msg, data: {...}, logid } 信封 ──
  test('嵌套信封 code=0（实测真实字段值）→ 解包后 available ok', async () => {
    const configPath = writeAvailConfig(makeTmpDir('avail'), { apiKey: API_KEY });
    const payload = {
      code: 0,
      msg: '',
      data: {
        server_time: 1793753110,
        plans: [
          {
            user_plan_id: 'up-1001',
            plan_id: 'plan-start',
            name: 'GLM Coding Start',
            description: 'start plan',
            priority: 1,
            status: 'active',
            starts_at: 1793704125,
            ends_at: 1793754000,
            entitlements: [{ capabilities: ['model:glm-5.3-flash'] }],
          },
        ],
      },
      logid: '20261104-envelope-fix',
    };
    const result = await withFetch(async () => okResponse(payload), () => checkAvailability(availSchedule(), configPath));
    assert.deepEqual(result, { available: true, reason: 'ok', plan: { endsAt: 1793754000 } });
  });

  test('信封 code!==0（HTTP 200 但接口错误）→ non-200', async () => {
    const configPath = writeAvailConfig(makeTmpDir('avail'), { apiKey: API_KEY });
    const payload = { code: 401, msg: 'unauthorized', data: null, logid: 'x' };
    const result = await withFetch(async () => okResponse(payload), () => checkAvailability(availSchedule(), configPath));
    assert.deepEqual(result, { available: false, reason: 'non-200' });
  });
});

// ── Task 3 追加：apply-core v2 ──
describe('computeTargetState', () => {
  const agents = [
    { name: 'Explore', kind: 'builtin' },
    { name: 'implementer', kind: 'custom', path: '/tmp/unused/implementer.md' },
    { name: 'vision', kind: 'custom' },
  ];
  const schedule = { target: { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', reasoningLevel: 'max' }, agents };

  test("mode='target'：builtin → 三元组；custom → providerId/modelId + thoughtLevel", () => {
    const t = computeTargetState(schedule, 'target', null);
    assert.deepEqual(t.builtin.Explore, { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'max' } });
    assert.deepEqual(t.custom.implementer, { model: 'account:bigmodel-start-plan/GLM-5.3-Flash', thoughtLevel: 'max' });
    assert.deepEqual(t.custom.vision, { model: 'account:bigmodel-start-plan/GLM-5.3-Flash', thoughtLevel: 'max' });
  });

  test("mode='original'：从快照恢复各 agent 切换前值；快照缺 vision → 跳过", () => {
    const snapshot = {
      Explore: { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } },
      implementer: { model: '"account:old-acct/GLM-9"', thoughtLevel: 'high' },
    };
    const t = computeTargetState(schedule, 'original', snapshot);
    assert.deepEqual(t.builtin.Explore, { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } });
    assert.deepEqual(t.custom.implementer, { model: '"account:old-acct/GLM-9"', thoughtLevel: 'high' });
    assert.equal(t.custom.vision, undefined);
  });

  test("mode='original' 且 snapshot=null → builtin/custom 均为空", () => {
    assert.deepEqual(computeTargetState(schedule, 'original', null), { builtin: {}, custom: {} });
  });

  test("mode='original'：值不完整的快照条目 → 该 agent 跳过", () => {
    const snapshot = {
      Explore: null,
      implementer: { model: '"account:old-acct/GLM-9"', thoughtLevel: null },
      vision: { model: null, thoughtLevel: 'low' },
    };
    assert.deepEqual(computeTargetState(schedule, 'original', snapshot), { builtin: {}, custom: {} });
  });
});

describe('modeChanged', () => {
  test('state 不存在 → true', () => {
    const statePath = path.join(makeTmpDir('modechg'), 'state.json');
    assert.equal(modeChanged(statePath, 'target'), true);
  });

  test('state.mode 与 desiredMode 不同 → true', () => {
    const statePath = path.join(makeTmpDir('modechg'), 'state.json');
    saveState(statePath, { mode: 'target', switchedAt: null, snapshot: null, lastCheck: null });
    assert.equal(modeChanged(statePath, 'original'), true);
  });

  test('state.mode 与 desiredMode 相同 → false', () => {
    const statePath = path.join(makeTmpDir('modechg'), 'state.json');
    saveState(statePath, { mode: 'target', switchedAt: null, snapshot: null, lastCheck: null });
    assert.equal(modeChanged(statePath, 'target'), false);
  });

  test('state 损坏（乱码）→ true', () => {
    const statePath = path.join(makeTmpDir('modechg'), 'state.json');
    fs.writeFileSync(statePath, 'garbage{{{', { mode: 0o644 });
    assert.equal(modeChanged(statePath, 'original'), true);
  });

  test('state 顶层非对象（[]）→ true', () => {
    const statePath = path.join(makeTmpDir('modechg'), 'state.json');
    fs.writeFileSync(statePath, '[]', { mode: 0o644 });
    assert.equal(modeChanged(statePath, 'original'), true);
  });
});
// ── Task 4 追加：apply.mjs CLI ──
import { spawnSync, spawn } from 'node:child_process';
import { parseArgs } from '../apply.mjs';

describe('apply.mjs parseArgs', () => {
  test('无参数 → 默认值（config 为脚本自身目录下 schedule.json，与 $HOME 无关）', () => {
    const opts = parseArgs([]);
    assert.deepEqual(opts, {
      config: path.join(TOOL_ROOT, 'schedule.json'),
      dryRun: false,
      status: false,
      force: false,
      ifDue: false,
      trigger: 'manual',
      logs: false,
      lines: 10,
    });
  });

  test('全量 flag + --config 取值', () => {
    const opts = parseArgs(['--config', '/tmp/x.json', '--dry-run', '--status', '--force', '--if-due']);
    assert.deepEqual(opts, { config: '/tmp/x.json', dryRun: true, status: true, force: true, ifDue: true, trigger: 'manual', logs: false, lines: 10 });
  });

  test('--config 缺值 → throw；未知参数 → throw', () => {
    assert.throws(() => parseArgs(['--config']), /--config/);
    assert.throws(() => parseArgs(['--bogus']), /未知参数/);
  });

  test('--trigger hook → trigger=hook；--trigger launchd → launchd', () => {
    assert.equal(parseArgs(['--trigger', 'hook']).trigger, 'hook');
    assert.equal(parseArgs(['--trigger', 'launchd']).trigger, 'launchd');
  });

  test('--trigger 缺值 / 空串 → throw', () => {
    assert.throws(() => parseArgs(['--trigger']), /--trigger/);
    assert.throws(() => parseArgs(['--trigger', '']), /--trigger/);
  });

  test('-n 5 → lines=5；-n 0 / -n x / -n 缺值 → throw', () => {
    assert.equal(parseArgs(['-n', '5']).lines, 5);
    assert.throws(() => parseArgs(['-n', '0']), /-n/);
    assert.throws(() => parseArgs(['-n', 'x']), /-n/);
    assert.throws(() => parseArgs(['-n']), /-n/);
  });

  test('--logs → logs=true；与 -n / --trigger 组合共存', () => {
    assert.equal(parseArgs(['--logs']).logs, true);
    assert.equal(parseArgs(['--logs', '-n', '3']).lines, 3);
    assert.equal(parseArgs(['--logs', '--trigger', 'launchd']).trigger, 'launchd');
  });
});

// ── E2E：子进程 + HOME 沙箱（os.homedir() 尊重 $HOME，锚点实测）──
const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runApply(toolDir, home, args = []) {
  return spawnSync(process.execPath, [path.join(toolDir, 'apply.mjs'), ...args], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
}

function snapshotTimes(paths) {
  const times = {};
  for (const p of paths) times[p] = fs.existsSync(p) ? fs.statSync(p).mtimeMs : null;
  return times;
}

function assertFilesUntouched(before) {
  for (const [p, t] of Object.entries(before)) {
    const nowT = fs.existsSync(p) ? fs.statSync(p).mtimeMs : null;
    assert.equal(nowT, t, `文件被意外修改: ${p}`);
  }
}

// 按序读取 runs.jsonl 全部记录（append-only，文件序 = 时间序）
function readRunRecords(runsLogPath) {
  return fs.readFileSync(runsLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function setupE2E({ dayWindows, availability, timezone } = {}) {
  const home = makeTmpDir('e2e-home');
  // 沙箱把工具放在任意目录（刻意避开 ~/.zcode/tools/model-schedule）：
  // CLI DEFAULT_CONFIG 必须按脚本自身目录解析（apply.mjs/import.meta.url），与 $HOME 布局无关
  const toolDir = path.join(home, 'apps', 'zcode-model-schedule');
  fs.mkdirSync(path.dirname(toolDir), { recursive: true });
  // 只复制源码与测试所需文件，排除真实运行时产物（logs/state/history/lock）与无关大目录（.git/node_modules/.worktrees）
  // filter 用相对路径判定：根目录自身放行，命中排除清单的路径整棵子树跳过（cpSync 递归时目录被拦截即不进入）
  const EXCLUDED = new Set(['logs', 'state.json', 'history.jsonl', '.apply.lock', '.git', 'node_modules', '.worktrees']);
  fs.cpSync(TOOL_ROOT, toolDir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(TOOL_ROOT, src);
      if (rel === '') return true; // 根目录自身必须放行
      return !EXCLUDED.has(rel.split(path.sep)[0]);
    },
  }); // STATE_PATH/HISTORY_PATH/LOCK_PATH 随 TOOL_DIR 落沙箱（沙箱内新建，非复制）
  const v2Dir = path.join(home, '.zcode', 'v2');
  fs.mkdirSync(v2Dir, { recursive: true });
  const agentsStatePath = path.join(v2Dir, 'agents-state.json');
  fs.writeFileSync(agentsStatePath, JSON.stringify({
    builtInModelOverrides: {},
    builtInThoughtLevelOverrides: {},
    disabledAgentIds: [],
    builtInModelSelectionOverrides: {
      Explore: { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } },
    },
    pluginAgentModelSelectionOverrides: {},
  }, null, 2) + '\n', { mode: 0o644 });
  // 最小 registry（无 apiKey；availability 用 disabled 或显式覆写避免真实网络）
  fs.writeFileSync(path.join(v2Dir, 'config.json'), JSON.stringify({
    provider: { 'builtin:bigmodel-start-plan': { models: { 'GLM-5.3-Flash': { reasoning: { variants: ['low', 'high', 'max'] } } } } },
  }, null, 2) + '\n', { mode: 0o644 });
  const agentsDir = path.join(home, '.zcode', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const ORIGINAL_MODEL = '"account:bigmodel-individual-coding-plan/GLM-5.3-Flash"';
  const mdBody = (name) => ['---', `name: "${name}"`, 'description: "e2e fixture"', `model: ${ORIGINAL_MODEL}`, 'thoughtLevel: max', '---', '', `# ${name} body`, ''].join('\n');
  const implementerMd = path.join(agentsDir, 'implementer.md');
  const visionMd = path.join(agentsDir, 'vision.md');
  fs.writeFileSync(implementerMd, mdBody('implementer'), { mode: 0o644 });
  fs.writeFileSync(visionMd, mdBody('vision'), { mode: 0o644 });
  const schedule = {
    $schema: 'zcode-model-schedule/v2',
    timezone: timezone ?? 'Asia/Shanghai',
    target: { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', reasoningLevel: 'max' },
    agents: [
      { name: 'implementer', kind: 'custom', path: '~/.zcode/agents/implementer.md' },
      { name: 'vision', kind: 'custom', path: '~/.zcode/agents/vision.md' },
      { name: 'Explore', kind: 'builtin' },
    ],
    dayWindows: dayWindows ?? [],
    availability: availability ?? { enabled: false, endpoint: 'https://billing.example.invalid/api', provider: 'builtin:bigmodel-start-plan', model: 'model:glm-5.3-flash', timeout: 5000 },
  };
  const schedulePath = path.join(toolDir, 'schedule.json');
  fs.writeFileSync(schedulePath, JSON.stringify(schedule, null, 2) + '\n', { mode: 0o644 });
  const statePath = path.join(toolDir, 'state.json');
  const historyPath = path.join(toolDir, 'history.jsonl');
  const lockPath = path.join(toolDir, '.apply.lock');
  const runsLogPath = path.join(toolDir, 'logs', 'runs.jsonl');
  const watched = [agentsStatePath, implementerMd, visionMd, statePath, historyPath]; // runs.jsonl 刻意不入 watched：它按设计每次运行都会写
  // 防回归：沙箱不得携带真实运行时产物（logs/runs.jsonl 等），否则本地 main 会因真实 41 行日志污染 E2E 计数断言
  assert.equal(fs.existsSync(path.join(toolDir, 'logs')), false, '沙箱不得包含真实运行时 logs/ 目录');
  return { home, toolDir, schedulePath, agentsStatePath, statePath, historyPath, lockPath, runsLogPath, implementerMd, visionMd, watched, ORIGINAL_MODEL };
}

// 选取当前本地时间距午夜 >4 分钟的时区，构造「运行时刻必在窗口内」的白日窗（确定性，无时钟竞态）
function alwaysInWindow() {
  for (const timezone of ['Asia/Shanghai', 'Pacific/Kiritimati', 'Etc/GMT+9']) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const pick = (type) => parts.find((p) => p.type === type)?.value;
    const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    const day = weekdayMap[pick('weekday')];
    const minutes = Number(pick('hour')) * 60 + Number(pick('minute'));
    if (minutes >= 5 && minutes <= 1434) {
      const pad = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      return { timezone, dayWindows: [{ days: [day], from: pad(minutes - 4), to: pad(minutes + 4) }] };
    }
  }
  // 数学上不可达（+8/+14/-9 三个偏移保证任一时刻至少一个时区处于安全内区）；防御性抛错
  throw new Error('无法构造确定性白日窗');
}

// ── 并发测试辅助 ──
// 等待进程关闭后，返回 {stdout, stderr}；spawn pipe 不触发 stream end，
// 因此依赖进程 close 事件来终结流收集。
function runConcurrent(toolDir, home, argCount = 2) {
  return new Promise((resolve) => {
    let pending = argCount;
    const procs = [];
    const stdouts = [];
    const stderrs = [];
    for (let i = 0; i < argCount; i++) {
      stdouts.push([]);
      stderrs.push([]);
    }
    for (let i = 0; i < argCount; i++) {
      const p = spawn(process.execPath, [path.join(toolDir, 'apply.mjs')], {
        env: { ...process.env, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      procs.push(p);
      p.stdout.on('data', (d) => stdouts[i].push(d));
      p.stderr.on('data', (d) => stderrs[i].push(d));
      p.on('close', () => {
        if (--pending === 0) {
          // 最后一个进程关闭 → 汇总结果
          resolve({
            exitCodes: procs.map((x) => x.exitCode),
            stdouts: stdouts.map((bufs) => Buffer.concat(bufs).toString()),
            stderrs: stderrs.map((bufs) => Buffer.concat(bufs).toString()),
          });
        }
      });
    }
  });
}

describe('apply.mjs E2E（子进程 + HOME 沙箱）', () => {
  test('--status：打印 current/desired mode + availability，exit 0；state/history/lock 三路径不落盘', () => {
    const e = setupE2E({ dayWindows: [] }); // dayWindows=[] → 恒 target 窗
    const r = runApply(e.toolDir, e.home, ['--status']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /current mode: original/);
    assert.match(r.stdout, /desired mode: target/);
    assert.match(r.stdout, /availability: available/); // availability.enabled=false → available(disabled)
    assert.equal(fs.existsSync(e.statePath), false);
    assert.equal(fs.existsSync(e.historyPath), false);
    assert.equal(fs.existsSync(e.lockPath), false);
    const recs = readRunRecords(e.runsLogPath);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].action, 'status');
    assert.equal(recs[0].exitCode, 0);
    assert.equal(recs[0].availability, 'disabled');
  });

  test('非法 target 三元组 → [invalid] + exit 1 + 目标文件零修改（mtime 前后对比）', () => {
    const e = setupE2E({ dayWindows: [] });
    const bad = JSON.parse(fs.readFileSync(e.schedulePath, 'utf8'));
    bad.target.modelId = 'GLM-9.9'; // 全局不存在 → validateSchedule 失败
    fs.writeFileSync(e.schedulePath, JSON.stringify(bad, null, 2) + '\n', { mode: 0o644 });
    const before = snapshotTimes(e.watched);
    const r = runApply(e.toolDir, e.home);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\[invalid\]/);
    assert.match(r.stderr, /GLM-9\.9/);
    assertFilesUntouched(before);
  });

  test('首次切换（target 窗）→ builtin + 2 md 切换 + state(mode/snapshot) + history 1 行', () => {
    const e = setupE2E({ dayWindows: [] });
    const r = runApply(e.toolDir, e.home);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /applied mode=target/);
    const overrides = JSON.parse(fs.readFileSync(e.agentsStatePath, 'utf8')).builtInModelSelectionOverrides;
    assert.deepEqual(overrides.Explore, { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'max' } });
    const implOut = fs.readFileSync(e.implementerMd, 'utf8');
    assert.ok(implOut.includes('model: account:bigmodel-start-plan/GLM-5.3-Flash'));
    assert.ok(implOut.includes('thoughtLevel: max'));
    const state = JSON.parse(fs.readFileSync(e.statePath, 'utf8'));
    assert.equal(state.mode, 'target');
    // 快照记录切换前原值（含引号形态）
    assert.deepEqual(state.snapshot.Explore, { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } });
    assert.deepEqual(state.snapshot.implementer, { model: e.ORIGINAL_MODEL, thoughtLevel: 'max' });
    assert.deepEqual(state.snapshot.vision, { model: e.ORIGINAL_MODEL, thoughtLevel: 'max' });
    const lines = fs.readFileSync(e.historyPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.mode, 'target');
    assert.equal(rec.reason, 'switch');
    assert.deepEqual(rec.agents, ['implementer', 'vision', 'Explore']);
    assert.ok(!Number.isNaN(Date.parse(rec.time)));
    // run-log：恰好 1 行，结构化字段齐备（run-log/v1）
    const runRecs = readRunRecords(e.runsLogPath);
    assert.equal(runRecs.length, 1);
    assert.equal(runRecs[0].schema, 'zcode-model-schedule/run-log/v1');
    assert.equal(runRecs[0].trigger, 'manual');
    assert.equal(runRecs[0].action, 'applied');
    assert.equal(runRecs[0].exitCode, 0);
    assert.equal(runRecs[0].desiredMode, 'target');
    assert.equal(runRecs[0].inWindow, false); // dayWindows=[] → 恒 target 窗
    assert.equal(runRecs[0].stateMode, 'original'); // fresh state → emptyState().mode
    assert.ok(Array.isArray(runRecs[0].changes) && runRecs[0].changes.length >= 4);
    assert.ok(runRecs[0].durationMs >= 0);
    assert.ok(!Number.isNaN(Date.parse(runRecs[0].time)));
    assert.equal(runRecs[0].error, null); // 成功路径 error=null（无 message 泄露面）
    assert.match(r.stdout, /applied mode=target/); // 控制台输出原样（G2）
  });

  test('幂等：同 mode 二次运行 → no change + exit 0 + 文件零修改', () => {
    const e = setupE2E({ dayWindows: [] });
    assert.equal(runApply(e.toolDir, e.home).status, 0);
    const before = snapshotTimes(e.watched);
    const r2 = runApply(e.toolDir, e.home);
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /no change/);
    assertFilesUntouched(before);
  });

  test('可用性失败 → skipped: <reason> + exit 0 + 文件零修改 + stdout/stderr 不含 apiKey', () => {
    const e = setupE2E({
      dayWindows: [],
      availability: { enabled: true, endpoint: 'http://127.0.0.1:9/billing', provider: 'builtin:bigmodel-start-plan', model: 'model:glm-5.3-flash', timeout: 2000 },
    });
    // 127.0.0.1:9（discard 端口）连接拒绝 → TypeError → http-error；config 带 apiKey 验证请求路径
    fs.writeFileSync(path.join(e.home, '.zcode', 'v2', 'config.json'), JSON.stringify({
      provider: { 'builtin:bigmodel-start-plan': { options: { apiKey: 'msched-e2e-secret-9f2' }, models: { 'GLM-5.3-Flash': { reasoning: { variants: ['low', 'high', 'max'] } } } } },
    }), { mode: 0o644 });
    const before = snapshotTimes(e.watched);
    const r = runApply(e.toolDir, e.home);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /skipped: /);
    assert.ok(!r.stdout.includes('msched-e2e-secret-9f2'), 'stdout 泄露 apiKey');
    assert.ok(!r.stderr.includes('msched-e2e-secret-9f2'), 'stderr 泄露 apiKey');
    assertFilesUntouched(before);
    // run-log：action=skipped + avail.reason；runs.jsonl 全文不含 apiKey
    const skipRecs = readRunRecords(e.runsLogPath);
    assert.equal(skipRecs.length, 1);
    assert.equal(skipRecs[0].action, 'skipped');
    assert.equal(skipRecs[0].exitCode, 0);
    assert.equal(skipRecs[0].availability, 'http-error'); // 127.0.0.1:9 连接拒绝 → http-error
    const rawLog = fs.readFileSync(e.runsLogPath, 'utf8');
    assert.ok(!rawLog.includes('msched-e2e-secret-9f2'), 'runs.jsonl 泄露 apiKey');
  });

  test('original 恢复：同一沙箱内先切 target → 改 schedule 为恒白日窗 → 逐字节还原 + snapshot=null（F3 真实往返）', () => {
    // 阶段 1：dayWindows=[] → 恒 target 窗，首次运行切换
    const e = setupE2E({ dayWindows: [] });
    // F2（round 3）：先保存 fixture 原文，恢复后 assert.equal 全量字节比较（非 includes 子串）
    const implOriginal = fs.readFileSync(e.implementerMd, 'utf8');
    const visionOriginal = fs.readFileSync(e.visionMd, 'utf8');
    const r1 = runApply(e.toolDir, e.home);
    assert.equal(r1.status, 0);
    assert.match(r1.stdout, /applied mode=target/);

    // 断言文件确为 target 值
    const overrides = JSON.parse(fs.readFileSync(e.agentsStatePath, 'utf8')).builtInModelSelectionOverrides;
    assert.deepEqual(overrides.Explore, { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'max' } });
    const implAfterSwitch = fs.readFileSync(e.implementerMd, 'utf8');
    assert.ok(implAfterSwitch.includes('model: account:bigmodel-start-plan/GLM-5.3-Flash'));
    const visionAfterSwitch = fs.readFileSync(e.visionMd, 'utf8');
    assert.ok(visionAfterSwitch.includes('model: account:bigmodel-start-plan/GLM-5.3-Flash'));

    // 阶段 2：改写 schedule.json 为恒在白天窗（用 alwaysInWindow 确保当前时刻命中）
    const aw = alwaysInWindow();
    const sched = JSON.parse(fs.readFileSync(e.schedulePath, 'utf8'));
    sched.dayWindows = aw.dayWindows;
    sched.timezone = aw.timezone;
    fs.writeFileSync(e.schedulePath, JSON.stringify(sched, null, 2) + '\n', { mode: 0o644 });

    // 阶段 3：再次运行 → 应进入 original 窗，按快照恢复
    const r2 = runApply(e.toolDir, e.home);
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /applied mode=original/);

    // F2（round 3）：恢复后逐字节全量比较（assert.equal 全文相等，不做 normalize）
    assert.equal(fs.readFileSync(e.implementerMd, 'utf8'), implOriginal, 'implementer.md 恢复后应与切换前 fixture 原文逐字节一致');
    assert.equal(fs.readFileSync(e.visionMd, 'utf8'), visionOriginal, 'vision.md 恢复后应与切换前 fixture 原文逐字节一致');
    // builtin 恢复为快照值（重新读取）
    const overridesAfter = JSON.parse(fs.readFileSync(e.agentsStatePath, 'utf8')).builtInModelSelectionOverrides;
    assert.deepEqual(overridesAfter.Explore, { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } });

    // state 复位：snapshot === null
    const state = JSON.parse(fs.readFileSync(e.statePath, 'utf8'));
    assert.equal(state.mode, 'original');
    assert.equal(state.snapshot, null);
  });

  test('original 幂等（无 state + 白日窗）→ no change + 不写文件', () => {
    const e = setupE2E(alwaysInWindow());
    const before = snapshotTimes(e.watched);
    const r = runApply(e.toolDir, e.home);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no change/);
    assertFilesUntouched(before);
  });

  test('state 损坏 + target 窗 → [warn] + 重新切换 + 新建快照（快照=切换前 fixture 值）', () => {
    const e = setupE2E({ dayWindows: [] });
    fs.writeFileSync(e.statePath, 'garbage{{{', { mode: 0o644 });
    const r = runApply(e.toolDir, e.home);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /\[warn\] state\.json 损坏/);
    const state = JSON.parse(fs.readFileSync(e.statePath, 'utf8'));
    assert.equal(state.mode, 'target');
    assert.deepEqual(state.snapshot.Explore, { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } });
    assert.deepEqual(state.snapshot.implementer, { model: e.ORIGINAL_MODEL, thoughtLevel: 'max' });
  });

  test('--if-due 连续两次（同 mode）：第一次执行，第二次 no mode change 跳过', () => {
    const e = setupE2E({ dayWindows: [] });
    const r1 = runApply(e.toolDir, e.home, ['--if-due']);
    assert.equal(r1.status, 0);
    assert.match(r1.stdout, /applied mode=target/);
    const before = snapshotTimes(e.watched);
    const r2 = runApply(e.toolDir, e.home, ['--if-due']);
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /no mode change/);
    assertFilesUntouched(before);
    // run-log：第 1 行 applied、第 2 行 if-due-skip（append-only，文件序 = 时间序）
    const dueRecs = readRunRecords(e.runsLogPath);
    assert.equal(dueRecs.length, 2);
    assert.equal(dueRecs[0].action, 'applied');
    assert.equal(dueRecs[1].action, 'if-due-skip');
    assert.equal(dueRecs[1].exitCode, 0);
  });

  // ── F2：失败重跑回归测试 ──
  // Step 0：先成功切换建立快照（含 fixture 真值）
  // Step 1：破坏 implementer.md（删 model: 行）→ 把 state 设为 original + snapshot 非 null（模拟被打断的切换）
  //         → run → exit 1，但 snapshot 已落盘含 fixture 真值
  //         （因为 F1：state.snapshot ?? captureSnapshot，复用已有快照不重新 capture）
  // Step 2：修复 md → run → snapshot 不变（仍复用）
  // Step 3：切白日窗 → 完整恢复原值 + snapshot=null
  test('custom md 缺 model: 行 → apply 失败 exit 1 + snapshot 已落盘；修复后重跑复用快照；切白日窗恢复', () => {
    const e = setupE2E({ dayWindows: [] }); // 恒 target 窗
    const implContent = fs.readFileSync(e.implementerMd, 'utf8');
    // F2（round 3）：保存 vision fixture 原文，恢复步骤逐字节全量比较
    const visionOriginal = fs.readFileSync(e.visionMd, 'utf8');

    // Step 0：首次成功切换 → snapshot 记录 fixture 真值
    const r0 = runApply(e.toolDir, e.home);
    assert.equal(r0.status, 0, '首次切换应成功');
    assert.match(r0.stdout, /applied mode=target/);
    const state0 = JSON.parse(fs.readFileSync(e.statePath, 'utf8'));
    assert.equal(state0.mode, 'target');
    assert.deepEqual(state0.snapshot.Explore, { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } });
    assert.deepEqual(state0.snapshot.implementer, { model: e.ORIGINAL_MODEL, thoughtLevel: 'max' });
    assert.deepEqual(state0.snapshot.vision, { model: e.ORIGINAL_MODEL, thoughtLevel: 'max' });

    // Step 1：破坏 implementer.md + 把 state 设为 original（模拟被打断的切换残留）
    const brokenImpl = implContent.replace(/model:.*\n/, '');
    fs.writeFileSync(e.implementerMd, brokenImpl, { mode: 0o644 });
    saveState(e.statePath, {
      mode: 'original',
      switchedAt: null,
      snapshot: state0.snapshot,
      lastCheck: new Date().toISOString(),
    });

    // 再跑：switchingToTarget=true, state.snapshot 存在 → 复用（F1），不重新 capture
    // 然后 applyCustomAgent throw → exit 1
    const r1 = runApply(e.toolDir, e.home);
    assert.equal(r1.status, 1, '缺 model: 行应 exit 1');
    assert.match(r1.stderr, /\[error\]/);

    // state.json 里 mode='original'，snapshot 是复用的 fixture 真值
    const state1 = JSON.parse(fs.readFileSync(e.statePath, 'utf8'));
    assert.equal(state1.mode, 'original');
    assert.deepEqual(state1.snapshot.Explore, { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } });
    assert.deepEqual(state1.snapshot.implementer, { model: e.ORIGINAL_MODEL, thoughtLevel: 'max' });
    assert.deepEqual(state1.snapshot.vision, { model: e.ORIGINAL_MODEL, thoughtLevel: 'max' });

    // run-log：exit 1 → 记录 exitCode=1 + error.type=runtime，且 error 无 message 字段（G4）
    const recsAfterFail = readRunRecords(e.runsLogPath);
    assert.equal(recsAfterFail.length, 2); // r0 成功 + r1 失败
    const failRec = recsAfterFail[1];
    assert.equal(failRec.exitCode, 1);
    assert.equal(failRec.error.type, 'runtime');
    assert.equal('message' in failRec.error, false);
    assert.equal(failRec.action, null); // exitCode≠0 → action=null
    assert.equal(failRec.trigger, 'manual');

    // Step 2：修复 implementer.md → 再跑 → snapshot 不变
    fs.writeFileSync(e.implementerMd, implContent, { mode: 0o644 });
    const r2 = runApply(e.toolDir, e.home);
    assert.equal(r2.status, 0, '修复后应成功');
    assert.match(r2.stdout, /applied mode=target/);

    const state2 = JSON.parse(fs.readFileSync(e.statePath, 'utf8'));
    assert.equal(state2.mode, 'target');
    assert.deepEqual(state2.snapshot.Explore, { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } });
    assert.deepEqual(state2.snapshot.implementer, { model: e.ORIGINAL_MODEL, thoughtLevel: 'max' });
    assert.deepEqual(state2.snapshot.vision, { model: e.ORIGINAL_MODEL, thoughtLevel: 'max' });

    // Step 3：改 schedule 为恒白日窗 → 恢复原值 + snapshot=null
    const aw = alwaysInWindow();
    const sched = JSON.parse(fs.readFileSync(e.schedulePath, 'utf8'));
    sched.dayWindows = aw.dayWindows;
    sched.timezone = aw.timezone;
    fs.writeFileSync(e.schedulePath, JSON.stringify(sched, null, 2) + '\n', { mode: 0o644 });

    const r3 = runApply(e.toolDir, e.home);
    assert.equal(r3.status, 0);
    assert.match(r3.stdout, /applied mode=original/);

    const state3 = JSON.parse(fs.readFileSync(e.statePath, 'utf8'));
    assert.equal(state3.mode, 'original');
    assert.equal(state3.snapshot, null);

    // F2（round 3）：恢复后逐字节全量比较（assert.equal 全文相等，不做 normalize）
    assert.equal(fs.readFileSync(e.implementerMd, 'utf8'), implContent, 'implementer.md 恢复后应与 fixture 原文逐字节一致');
    assert.equal(fs.readFileSync(e.visionMd, 'utf8'), visionOriginal, 'vision.md 恢复后应与 fixture 原文逐字节一致');
    const overridesAfter = JSON.parse(fs.readFileSync(e.agentsStatePath, 'utf8')).builtInModelSelectionOverrides;
    assert.deepEqual(overridesAfter.Explore, { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } });
  });

  // ── F1（round 3）：fresh-state 验证「先落盘快照再切换」的真实顺序 ──
  // 与上一用例的关键区别：不预置任何 state.json。fresh state 下，失败 run 后 state.json 存在且
  // mode=original + fixture 真值快照，只能来自 apply.mjs 的中间 saveState（captureSnapshot 后、
  // applyTarget 前）；若删掉该中间落盘，本用例 Step 1 即红（state.json 不存在）。
  // 上一用例预置了残留 state，state.snapshot ?? captureSnapshot 短路复用，无法证明「先落盘」。
  test('fresh-state：vision.md frontmatter 未闭合 → 首跑 exit 1 但快照先落盘（先落盘再切换顺序回归）；修复重跑复用快照；白日窗逐字节恢复', () => {
    const e = setupE2E({ dayWindows: [] }); // 恒 target 窗
    const implOriginal = fs.readFileSync(e.implementerMd, 'utf8');
    const visionOriginal = fs.readFileSync(e.visionMd, 'utf8');
    // fresh 判据：不预置 state.json（若预置残留则中间 saveState 被删后用例仍绿 → finding 复现）
    assert.equal(fs.existsSync(e.statePath), false, '前置：fresh state，state.json 不应存在');

    // Step 1：破坏 vision.md frontmatter 闭合（删结尾 ---）。
    // captureSnapshot 的 readCustomAgentCurrent 按行正则读 model:/thoughtLevel:，不校验闭合 → 仍得真值；
    // applyCustomAgent → computeCustomAgentChanges 对未闭合 frontmatter throw → exit 1
    const brokenVision = visionOriginal.replace('thoughtLevel: max\n---\n', 'thoughtLevel: max\n');
    assert.notEqual(brokenVision, visionOriginal, '前置：破坏应实际改变文件内容');
    fs.writeFileSync(e.visionMd, brokenVision, { mode: 0o644 });

    const r1 = runApply(e.toolDir, e.home);
    assert.equal(r1.status, 1, 'frontmatter 未闭合应 exit 1');
    assert.match(r1.stderr, /\[error\]/);
    assert.match(r1.stderr, /frontmatter 未闭合/);

    // 快照先落盘：三个条目都是 fixture 真值（若在切换后才补拍，implementer 已是 target 值 → 断言红）
    const state1 = JSON.parse(fs.readFileSync(e.statePath, 'utf8'));
    assert.equal(state1.mode, 'original');
    assert.deepEqual(state1.snapshot.Explore, { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } });
    assert.deepEqual(state1.snapshot.implementer, { model: e.ORIGINAL_MODEL, thoughtLevel: 'max' });
    assert.deepEqual(state1.snapshot.vision, { model: e.ORIGINAL_MODEL, thoughtLevel: 'max' });

    // builtin 先写（随后 vision 抛错中断）：agents-state.json Explore 已是 target 三元组
    const overrides1 = JSON.parse(fs.readFileSync(e.agentsStatePath, 'utf8')).builtInModelSelectionOverrides;
    assert.deepEqual(overrides1.Explore, { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'max' } });
    // 顺序证据：implementer.md 已被切成 target（快照却记录其 fixture 原值 → 快照先于切换拍下并落盘）
    assert.ok(fs.readFileSync(e.implementerMd, 'utf8').includes('model: account:bigmodel-start-plan/GLM-5.3-Flash'));
    // vision.md 未被写坏（保持 broken 原文）
    assert.equal(fs.readFileSync(e.visionMd, 'utf8'), brokenVision);

    // Step 2：修复 vision.md → 重跑 → mode=target，快照复用失败 run 落盘的 fixture 真值
    fs.writeFileSync(e.visionMd, visionOriginal, { mode: 0o644 });
    const r2 = runApply(e.toolDir, e.home);
    assert.equal(r2.status, 0, '修复后重跑应成功');
    assert.match(r2.stdout, /applied mode=target/);
    const state2 = JSON.parse(fs.readFileSync(e.statePath, 'utf8'));
    assert.equal(state2.mode, 'target');
    assert.deepEqual(state2.snapshot.Explore, { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } });
    assert.deepEqual(state2.snapshot.implementer, { model: e.ORIGINAL_MODEL, thoughtLevel: 'max' });
    assert.deepEqual(state2.snapshot.vision, { model: e.ORIGINAL_MODEL, thoughtLevel: 'max' });

    // Step 3：切白日窗 → 恢复原值 + snapshot=null；恢复断言逐字节全量比较（F2 同源判据）
    const aw = alwaysInWindow();
    const sched = JSON.parse(fs.readFileSync(e.schedulePath, 'utf8'));
    sched.dayWindows = aw.dayWindows;
    sched.timezone = aw.timezone;
    fs.writeFileSync(e.schedulePath, JSON.stringify(sched, null, 2) + '\n', { mode: 0o644 });
    const r3 = runApply(e.toolDir, e.home);
    assert.equal(r3.status, 0);
    assert.match(r3.stdout, /applied mode=original/);
    const state3 = JSON.parse(fs.readFileSync(e.statePath, 'utf8'));
    assert.equal(state3.mode, 'original');
    assert.equal(state3.snapshot, null);
    assert.equal(fs.readFileSync(e.implementerMd, 'utf8'), implOriginal, 'implementer.md 恢复后应与 fixture 原文逐字节一致');
    assert.equal(fs.readFileSync(e.visionMd, 'utf8'), visionOriginal, 'vision.md 恢复后应与 fixture 原文逐字节一致');
    const overrides3 = JSON.parse(fs.readFileSync(e.agentsStatePath, 'utf8')).builtInModelSelectionOverrides;
    assert.deepEqual(overrides3.Explore, { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } });
  });

  test('并发：双进程同时运行，最终 state.snapshot = 切换前 fixture 值（F4 真实双进程）', async () => {
    const e = setupE2E({ dayWindows: [] }); // 初始恒 target 窗 → 两个进程都判定切 target

    // 记录切换前 fixture 原值
    const fixtureExplore = { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } };

    const result = await runConcurrent(e.toolDir, e.home, 2);

    // 至少一个退出码为 0，另一个为 0 或 2
    const codes = result.exitCodes;
    assert.ok(codes.includes(0), `至少一个进程 exit 0, got ${codes}`);
    assert.ok(codes.every((c) => c === 0 || c === 2), `所有退出码合法: ${codes}`);

    // 断言最终文件状态一致（无损坏），且 state.snapshot 是切换前 fixture 值
    assert.ok(fs.existsSync(e.implementerMd));
    assert.ok(fs.existsSync(e.visionMd));
    assert.ok(fs.existsSync(e.agentsStatePath));
    assert.ok(fs.existsSync(e.statePath), 'state.json 应存在（至少一个进程成功切换）');

    const finalState = JSON.parse(fs.readFileSync(e.statePath, 'utf8'));
    assert.equal(finalState.mode, 'target');
    // snapshot 应为切换前的原始 fixture 值（不是 target 值）
    assert.deepEqual(finalState.snapshot.Explore, fixtureExplore);
    assert.deepEqual(finalState.snapshot.implementer, { model: e.ORIGINAL_MODEL, thoughtLevel: 'max' });
    assert.deepEqual(finalState.snapshot.vision, { model: e.ORIGINAL_MODEL, thoughtLevel: 'max' });

    // 内容断言：implementer/vision md 含 target model 行；agents-state.json 可 JSON.parse 且 Explore 为 target 值
    const implContent = fs.readFileSync(e.implementerMd, 'utf8');
    const visionContent = fs.readFileSync(e.visionMd, 'utf8');
    assert.ok(implContent.includes('model: account:bigmodel-start-plan/GLM-5.3-Flash'), 'implementer md 应含 target model');
    assert.ok(visionContent.includes('model: account:bigmodel-start-plan/GLM-5.3-Flash'), 'vision md 应含 target model');
    const stateJson = JSON.parse(fs.readFileSync(e.agentsStatePath, 'utf8'));
    assert.deepEqual(stateJson.builtInModelSelectionOverrides.Explore,
      { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'max' } });

    // stdout 断言：恰好一个进程输出 applied mode=target，另一进程输出 no change 或 stderr 含 [locked]
    const appliedCount = result.stdouts.filter((s) => s.includes('applied mode=target')).length;
    assert.equal(appliedCount, 1, `恰好一个进程输出 applied mode=target, stdout=[${result.stdouts[0].trim()}, ${result.stdouts[1].trim()}]`);
    // 另一个进程要么 no change 要么 [locked]
    const idx = result.stdouts.findIndex((s) => !s.includes('applied mode=target'));
    assert.ok(result.stdouts[idx].includes('no change') || result.stderrs[idx].includes('[locked]'),
      `另一进程预期 no change 或 [locked], stdout="${result.stdouts[idx].trim()}", stderr="${result.stderrs[idx].trim()}"`);
    // run-log：双进程各落 1 行（O_APPEND 单次 write 不交错）；一行 exit 0、另一行 0 或 2
    const concRecs = readRunRecords(e.runsLogPath);
    assert.equal(concRecs.length, 2);
    const recCodes = concRecs.map((rec) => rec.exitCode);
    assert.ok(recCodes.includes(0), `至少一行 exit 0, got ${recCodes}`);
    assert.ok(recCodes.every((c) => c === 0 || c === 2), `所有记录退出码合法: ${recCodes}`);
  });

  test('并发 ×3 轮（每轮新 sandbox）提高真实交错概率 + snapshot 不变量', async () => {
    for (let round = 0; round < 3; round++) {
      const e = setupE2E({ dayWindows: [] });

      const fixtureExplore = { providerId: 'magpie', modelId: 'group/flash', options: { reasoningLevel: 'max' } };
      const fixtureImpl = { model: e.ORIGINAL_MODEL, thoughtLevel: 'max' };
      const fixtureVision = { model: e.ORIGINAL_MODEL, thoughtLevel: 'max' };

      const result = await runConcurrent(e.toolDir, e.home, 2);

      const codes = result.exitCodes;
      assert.ok(codes.includes(0), `round ${round}: 至少一个进程 exit 0, got ${codes}`);
      assert.ok(codes.every((c) => c === 0 || c === 2), `round ${round}: 所有退出码合法: ${codes}`);

      const finalState = JSON.parse(fs.readFileSync(e.statePath, 'utf8'));
      assert.equal(finalState.mode, 'target');
      assert.deepEqual(finalState.snapshot.Explore, fixtureExplore, `round ${round}: Explore snapshot`);
      assert.deepEqual(finalState.snapshot.implementer, fixtureImpl, `round ${round}: implementer snapshot`);
      assert.deepEqual(finalState.snapshot.vision, fixtureVision, `round ${round}: vision snapshot`);
    }
  });

  test('--dry-run：打印 {desiredMode, available, changes} JSON，exit 0，不写任何文件', () => {
    const e = setupE2E({ dayWindows: [] });
    const before = snapshotTimes(e.watched);
    const r = runApply(e.toolDir, e.home, ['--dry-run']);
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.desiredMode, 'target');
    assert.equal(payload.available, true);
    // 实际变更 4 条：Explore providerId+modelId + implementer model + vision model
    // （reasoningLevel/thoughtLevel 前后同为 'max' → 无 diff，故非 7 条）
    assert.ok(Array.isArray(payload.changes) && payload.changes.length >= 4);
    assert.ok(payload.changes.every((c) => 'agent' in c && 'field' in c && 'old' in c && 'new' in c));
    assertFilesUntouched(before);
    // run-log：action=dry-run + 变更明细与 stdout JSON 同源；watched 断言不变（runs.jsonl 不在 watched）
    const dryRecs = readRunRecords(e.runsLogPath);
    assert.equal(dryRecs.length, 1);
    assert.equal(dryRecs[0].action, 'dry-run');
    assert.equal(dryRecs[0].exitCode, 0);
    assert.ok(Array.isArray(dryRecs[0].changes) && dryRecs[0].changes.length >= 4);
  });

  test('--force（已 target 态）→ 强制重写（mtime 变化）+ exit 0', () => {
    const e = setupE2E({ dayWindows: [] });
    assert.equal(runApply(e.toolDir, e.home).status, 0);
    const targets = [e.agentsStatePath, e.implementerMd, e.visionMd];
    const before = snapshotTimes(targets);
    const r = runApply(e.toolDir, e.home, ['--force']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--force rewrite done/);
    for (const p of targets) {
      assert.ok(fs.statSync(p).mtimeMs > before[p], `--force 未重写: ${p}`);
    }
  });

  test('--trigger launchd → 记录 trigger=launchd（launchd/hook 标注通道）', () => {
    const e = setupE2E({ dayWindows: [] });
    const r = runApply(e.toolDir, e.home, ['--trigger', 'launchd']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /applied mode=target/);
    const recs = readRunRecords(e.runsLogPath);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].trigger, 'launchd');
    assert.equal(recs[0].action, 'applied');
  });

  test('--logs：单行摘要逐条输出（最新在前）；-n 1 → 仅最新 1 条；查询本身不写 run-log', () => {
    const e = setupE2E({ dayWindows: [] });
    runApply(e.toolDir, e.home, ['--trigger', 'hook']); // 第 1 条：applied（trigger=hook）
    runApply(e.toolDir, e.home, ['--if-due']); // 第 2 条：if-due-skip（trigger=manual，最新）
    const r = runApply(e.toolDir, e.home, ['--logs']);
    assert.equal(r.status, 0);
    const outLines = r.stdout.trim().split('\n');
    assert.equal(outLines.length, 2);
    assert.match(outLines[0], /action=if-due-skip/); // 降序：最新在前
    assert.match(outLines[0], /\] manual /); // 摘要格式 [<time>] <trigger> ...（trigger 为裸值，非 trigger= 形态）
    assert.match(outLines[0], /exit=0/);
    assert.match(outLines[1], /action=applied/);
    assert.match(outLines[1], /\] hook /);
    const r1 = runApply(e.toolDir, e.home, ['--logs', '-n', '1']);
    assert.equal(r1.status, 0);
    const oneLine = r1.stdout.trim().split('\n');
    assert.equal(oneLine.length, 1);
    assert.match(oneLine[0], /action=if-due-skip/);
    assert.equal(fs.readFileSync(e.runsLogPath, 'utf8').trim().split('\n').length, 2, '--logs 查询本身不追加记录');
  });

  test('--logs 无记录 → no runs logged yet + exit 0，且不创建 runs.jsonl', () => {
    const e = setupE2E({ dayWindows: [] });
    const r = runApply(e.toolDir, e.home, ['--logs']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no runs logged yet/);
    assert.equal(fs.existsSync(e.runsLogPath), false);
  });

  test('--logs 先于 loadSchedule：schedule 损坏也能查日志', () => {
    const e = setupE2E({ dayWindows: [] });
    runApply(e.toolDir, e.home); // 先落一条成功记录
    fs.writeFileSync(e.schedulePath, 'not-json{{{', { mode: 0o644 });
    const r = runApply(e.toolDir, e.home, ['--logs']);
    assert.equal(r.status, 0); // 若 --logs 在 loadSchedule 之后处理，这里会 exit 1（锁死分支次序回归）
    assert.match(r.stdout, /action=applied/);
    assert.equal(fs.readFileSync(e.runsLogPath, 'utf8').trim().split('\n').length, 1, '查询运行不追加记录');
  });
});

// ── Task 5 追加：install / register-hook / hook script ──
import { execFileSync } from 'node:child_process';
import { generatePlist } from '../install.mjs';
import { registerHook } from '../hooks/register-hook.mjs';

describe('generatePlist', () => {
  test('schedule.example.json dayWindows → 10 条 StartCalendarInterval（5 天 × from/to），含 08:50 与 23:10', () => {
    const toolSchedule = JSON.parse(fs.readFileSync(path.join(TOOL_ROOT, 'schedule.example.json'), 'utf8'));
    const xml = generatePlist(toolSchedule, '/fake/node/bin/node', '/fake/tool/apply.mjs', 501);
    assert.equal((xml.match(/<key>Weekday<\/key>/g) ?? []).length, 10);
    assert.match(xml, /<key>Weekday<\/key><integer>1<\/integer><key>Hour<\/key><integer>8<\/integer><key>Minute<\/key><integer>50<\/integer>/);
    assert.match(xml, /<key>Weekday<\/key><integer>5<\/integer><key>Hour<\/key><integer>23<\/integer><key>Minute<\/key><integer>10<\/integer>/);
  });

  test('StartInterval=300 + Label + ProgramArguments=[node, apply.mjs, --if-due, --trigger launchd] + 日志路径', () => {
    const xml = generatePlist(baseSchedule(), '/fake/node/bin/node', '/fake/tool/apply.mjs', 501);
    assert.match(xml, /<key>Label<\/key><string>com\.zcode\.model-schedule<\/string>/);
    assert.match(xml, /<key>StartInterval<\/key><integer>300<\/integer>/);
    assert.match(xml, /<string>\/fake\/node\/bin\/node<\/string>\n    <string>\/fake\/tool\/apply\.mjs<\/string>\n    <string>--if-due<\/string>/);
    assert.match(xml, /<string>--if-due<\/string>\n    <string>--trigger<\/string>\n    <string>launchd<\/string>/);
    assert.match(xml, /<key>StandardOutPath<\/key><string>\/fake\/tool\/logs\/launchd\.out\.log<\/string>/);
    assert.match(xml, /<key>StandardErrorPath<\/key><string>\/fake\/tool\/logs\/launchd\.err\.log<\/string>/);
  });

  test('多窗口合成 schedule → 条目数 = Σ(days×2)：[1-5]+[6,7] → 10+4=14', () => {
    const schedule = baseSchedule({
      dayWindows: [
        { days: [1, 2, 3, 4, 5], from: '08:50', to: '23:10' },
        { days: [6, 7], from: '10:00', to: '22:00' },
      ],
    });
    const xml = generatePlist(schedule, '/fake/node', '/fake/apply.mjs', 501);
    assert.equal((xml.match(/<key>Weekday<\/key>/g) ?? []).length, 14);
  });
});

const EXISTING_SESSION_START = [
  {
    matcher: 'startup|clear|compact',
    hooks: [{ type: 'command', command: 'bash "$HOME/.zcode/hooks/pipeline-context.sh"', timeout: 5, statusMessage: 'Injecting pipeline stages' }],
  },
];

function writeCliConfig(dir) {
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ hooks: { events: { SessionStart: EXISTING_SESSION_START } } }, null, 2) + '\n', { mode: 0o644 });
  return configPath;
}

describe('registerHook', () => {
  test('首次注册：追加条目（timeout 10）+ 原 hook 保留 + 备份文件', () => {
    const dir = makeTmpDir('hookcfg');
    const configPath = writeCliConfig(dir);
    const { changed } = registerHook(configPath);
    assert.equal(changed, true);
    const sessionStart = JSON.parse(fs.readFileSync(configPath, 'utf8')).hooks.events.SessionStart;
    assert.equal(sessionStart.length, 2);
    assert.equal(sessionStart[0].hooks[0].command, 'bash "$HOME/.zcode/hooks/pipeline-context.sh"');
    assert.equal(sessionStart[1].matcher, 'startup|clear|compact');
    // hook command 必须指向脚本自身目录旁的 hook 脚本（可移植），不得硬编码 $HOME/.zcode/tools/model-schedule
    assert.ok(sessionStart[1].hooks[0].command.includes(path.join(TOOL_ROOT, 'hooks', 'model-schedule-apply.sh')),
      `hook command 应基于脚本目录: ${sessionStart[1].hooks[0].command}`);
    assert.match(sessionStart[1].hooks[0].command, /model-schedule-apply\.sh/);
    assert.equal(sessionStart[1].hooks[0].type, 'command');
    assert.equal(sessionStart[1].hooks[0].timeout, 10);
    assert.equal(sessionStart[1].hooks[0].statusMessage, 'Applying model schedule');
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('config.json.bak-')).length, 1);
  });

  test('重复注册：changed=false，不产生重复条目，不新增备份', () => {
    const dir = makeTmpDir('hookcfg');
    const configPath = writeCliConfig(dir);
    registerHook(configPath);
    const second = registerHook(configPath);
    assert.equal(second.changed, false);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).hooks.events.SessionStart.length, 2);
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('config.json.bak-')).length, 1);
  });

  test('config 不存在 → 创建最小 config 并注册', () => {
    const dir = makeTmpDir('hookcfg');
    const configPath = path.join(dir, 'config.json');
    const { changed } = registerHook(configPath);
    assert.equal(changed, true);
    const sessionStart = JSON.parse(fs.readFileSync(configPath, 'utf8')).hooks.events.SessionStart;
    assert.equal(sessionStart.length, 1);
    assert.match(sessionStart[0].hooks[0].command, /model-schedule-apply\.sh/);
  });
});

describe('hook script (model-schedule-apply.sh)', () => {
  // 在临时目录重建工具布局，stub node 记录入参；绝不触碰真实 ~/.zcode
  function setupFakeTool(dir) {
    const toolDir = path.join(dir, 'model-schedule');
    fs.mkdirSync(path.join(toolDir, 'hooks'), { recursive: true });
    fs.copyFileSync(path.join(TOOL_ROOT, 'hooks', 'model-schedule-apply.sh'), path.join(toolDir, 'hooks', 'model-schedule-apply.sh'));
    const stubLog = path.join(dir, 'stub.log');
    const stubNode = path.join(dir, 'stub-node.sh');
    fs.writeFileSync(stubNode, `#!/bin/sh\necho "$@" >> "${stubLog}"\n`, { mode: 0o755 });
    return { toolDir, stubNode, stubLog };
  }

  test('node-path 存在 → 用该 node 执行 apply.mjs --if-due --trigger hook，logs 目录自动创建', () => {
    const dir = makeTmpDir('hookrun');
    const { toolDir, stubNode, stubLog } = setupFakeTool(dir);
    fs.writeFileSync(path.join(toolDir, 'node-path'), `${stubNode}\n`);
    execFileSync('bash', [path.join(toolDir, 'hooks', 'model-schedule-apply.sh')], { stdio: 'ignore' });
    const logged = fs.readFileSync(stubLog, 'utf8');
    assert.match(logged, /apply\.mjs/);
    assert.match(logged, /--if-due/);
    assert.match(logged, /--trigger hook/);
    assert.ok(fs.existsSync(path.join(toolDir, 'logs', 'hook.out.log')));
    assert.ok(fs.existsSync(path.join(toolDir, 'logs', 'hook.err.log')));
  });

  test('node-path 缺失 → 回退 NODE 环境变量指定的 node', () => {
    const dir = makeTmpDir('hookrun');
    const { toolDir, stubNode, stubLog } = setupFakeTool(dir);
    execFileSync('bash', [path.join(toolDir, 'hooks', 'model-schedule-apply.sh')], {
      stdio: 'ignore',
      env: { ...process.env, NODE: stubNode },
    });
    const logged = fs.readFileSync(stubLog, 'utf8');
    assert.match(logged, /apply\.mjs/);
    assert.match(logged, /--if-due/);
  });
});

// ── run-logging 追加：run-log 模块单元测试 ──
import {
  RUN_LOG_SCHEMA,
  RUN_LOG_MAX_BYTES,
  appendRunLog,
  rotateIfNeeded,
  readRunLogs,
  formatRunRecord,
  summarizeError,
} from '../lib/run-log.mjs';

describe('run-log（appendRunLog / rotateIfNeeded / readRunLogs / formatRunRecord / summarizeError）', () => {
  test('appendRunLog：写一行合法 JSON（record 原样序列化），嵌套目录自建，mode 0644', () => {
    const dir = makeTmpDir('runlog');
    const logPath = path.join(dir, 'nested', 'deeper', 'runs.jsonl');
    const rec = { schema: RUN_LOG_SCHEMA, time: '2026-11-03T10:00:00.000Z', trigger: 'manual', exitCode: 0 };
    assert.equal(appendRunLog(logPath, rec), true);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), rec);
    assert.ok(!Number.isNaN(Date.parse(JSON.parse(lines[0]).time)));
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o644);
  });

  test('appendRunLog：多次追加 = 多行 JSONL（每条一行）', () => {
    const dir = makeTmpDir('runlog');
    const logPath = path.join(dir, 'runs.jsonl');
    appendRunLog(logPath, { time: '2026-11-03T10:00:00.000Z', seq: 1 });
    appendRunLog(logPath, { time: '2026-11-03T10:01:00.000Z', seq: 2 });
    assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, 2);
  });

  test('appendRunLog：父路径是普通文件 → 不 throw、返回 false（降级保证 G3）', () => {
    const dir = makeTmpDir('runlog');
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'i am a file', { mode: 0o644 });
    const logPath = path.join(blocker, 'runs.jsonl'); // 父路径是文件 → mkdirSync 必败
    assert.equal(appendRunLog(logPath, { time: '2026-11-03T10:00:00.000Z' }), false);
  });

  test('rotateIfNeeded：< 1MiB 不轮转；≥ 1MiB → rename 到 .1 且旧 .1 被覆盖', () => {
    const dir = makeTmpDir('runlog');
    const logPath = path.join(dir, 'runs.jsonl');
    fs.writeFileSync(logPath, 'x'.repeat(RUN_LOG_MAX_BYTES - 1), { mode: 0o644 });
    rotateIfNeeded(logPath);
    assert.ok(fs.existsSync(logPath), '阈值下不轮转');
    assert.ok(!fs.existsSync(`${logPath}.1`));
    fs.writeFileSync(`${logPath}.1`, 'old-rotated', { mode: 0o644 });
    fs.writeFileSync(logPath, 'y'.repeat(RUN_LOG_MAX_BYTES), { mode: 0o644 });
    rotateIfNeeded(logPath);
    assert.ok(!fs.existsSync(logPath), '本体已 rename 走');
    assert.equal(fs.readFileSync(`${logPath}.1`, 'utf8'), 'y'.repeat(RUN_LOG_MAX_BYTES), '旧 .1 被覆盖');
  });

  test('rotateIfNeeded：本体缺失（ENOENT）→ 直接返回不 throw', () => {
    const dir = makeTmpDir('runlog');
    rotateIfNeeded(path.join(dir, 'absent.jsonl'));
  });

  test('readRunLogs：按 time 降序 + limit 截断', () => {
    const dir = makeTmpDir('runlog');
    const logPath = path.join(dir, 'runs.jsonl');
    for (let i = 1; i <= 3; i++) {
      appendRunLog(logPath, { time: `2026-11-03T10:0${i}:00.000Z`, seq: i });
    }
    assert.deepEqual(readRunLogs(logPath).map((r) => r.seq), [3, 2, 1]);
    assert.deepEqual(readRunLogs(logPath, { limit: 1 }).map((r) => r.seq), [3]);
  });

  test('readRunLogs：坏行/空行跳过 + .1 与本体合并降序', () => {
    const dir = makeTmpDir('runlog');
    const logPath = path.join(dir, 'runs.jsonl');
    fs.writeFileSync(`${logPath}.1`, `${JSON.stringify({ time: '2026-11-01T00:00:00.000Z', seq: 0 })}\n`, { mode: 0o644 });
    fs.writeFileSync(logPath, [
      JSON.stringify({ time: '2026-11-03T12:00:00.000Z', seq: 2 }),
      '{broken json',
      '',
      JSON.stringify({ time: '2026-11-03T11:00:00.000Z', seq: 1 }),
    ].join('\n') + '\n', { mode: 0o644 });
    assert.deepEqual(readRunLogs(logPath).map((r) => r.seq), [2, 1, 0]);
  });

  test('readRunLogs：文件缺失（本体与 .1 均无）→ []', () => {
    const dir = makeTmpDir('runlog');
    assert.deepEqual(readRunLogs(path.join(dir, 'absent.jsonl')), []);
  });

  test('formatRunRecord：含 action/dur/exit，changes 数组计条数，null 字段打 -', () => {
    const line = formatRunRecord({
      time: '2026-11-03T10:00:00.000Z', trigger: 'manual', desiredMode: 'target', inWindow: false,
      action: 'applied', availability: 'ok', changes: [{}, {}, {}, {}], durationMs: 12, exitCode: 0,
    });
    assert.match(line, /\[2026-11-03T10:00:00\.000Z\] manual/);
    assert.match(line, /desired=target/);
    assert.match(line, /inWindow=false/);
    assert.match(line, /action=applied/);
    assert.match(line, /avail=ok/);
    assert.match(line, /changes=4/);
    assert.match(line, /dur=12ms/);
    assert.match(line, /exit=0/);
    const sparse = formatRunRecord({ time: null, trigger: 'hook', desiredMode: null, inWindow: null, action: null, availability: null, changes: null, durationMs: null, exitCode: null });
    assert.equal(sparse, '[-] hook desired=- inWindow=- action=- avail=- changes=- dur=-ms exit=-');
  });

  test('summarizeError：LockBusyError → lock/LOCK_BUSY；普通 Error → runtime/code；无 message 字段', () => {
    assert.deepEqual(summarizeError(new LockBusyError('/tmp/x')), { type: 'lock', code: 'LOCK_BUSY' });
    const e = new Error('boom with api key msched-e2e-secret-9f2');
    e.code = 'EACCES';
    const summarized = summarizeError(e);
    assert.deepEqual(summarized, { type: 'runtime', code: 'EACCES' });
    assert.equal('message' in summarized, false);
    assert.ok(!JSON.stringify(summarized).includes('msched-e2e-secret-9f2'), '摘要不得含 message');
    assert.deepEqual(summarizeError(new Error('no code')), { type: 'runtime', code: null });
  });
});
