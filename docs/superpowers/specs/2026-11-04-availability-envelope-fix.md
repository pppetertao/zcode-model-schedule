# availability 信封解包修复（simplified spec）

日期：2026-11-04 ｜ 路径：simplified（2 文件，无跨文件接口）｜ 执行：单卡 A/B，TDD 先红后绿

## Goal

修复 `checkAvailability` 读不到 plan 的 bug：真实端点 200 响应为信封 `{ code, msg, data: { server_time, plans }, logid }`，现代码取顶层 `data.server_time`/`data.plans` 恒为空 → 恒返回 `no-active-plan`（实测 `node apply.mjs --dry-run --force` 输出 `skipped: no-active-plan`）。解包信封后恢复正确判定。

## Files to Change

1. `/Users/peter/Documents/project/zcode-model-schedule/lib/availability.mjs:50-53` — `checkAvailability()`（:10）内：形状守卫（:48-49）之后插入「信封错误码分支 + 信封解包」，`server_time`/`plans` 改从解包后的 `payload` 读取。函数签名与返回形状 `{ available, reason, plan? }` 不变，reason 集合不变。
2. `/Users/peter/Documents/project/zcode-model-schedule/test/apply.test.mjs:1047-1048` — `describe('checkAvailability')`（:879 起）内、`'config.json 不存在 → 仍 http-error'` 用例（:1041-1047）之后、describe 收口 `});`（:1048）之前追加 2 个用例；复用既有 helper：`withFetch`（:884）、`okResponse`（:893）、`writeAvailConfig`（:897）、`availSchedule`（:726）。无独立 `test/availability.test.mjs`，本文件即等价测试文件。

### 生产代码块（lib/availability.mjs）

将 :50-53（空行 + `const serverTime = data.server_time;` 起 3 行）替换为下块；:48-49 形状守卫与 :54-64（`activeInWindow`/`usable`/return）逐字不动：

```js

  // 信封错误码：HTTP 200 但业务码非 0（{ code, msg, data } 信封）→ 接口层失败，按 non-200 处理（reason 集合不扩）
  if (data.code !== undefined && data.code !== 0) return { available: false, reason: 'non-200' };

  // 信封解包：真实端点 200 响应为 { code, msg, data: { server_time, plans }, logid }；
  // data.data 为对象时取内层，否则回退顶层（兼容扁平响应与旧测试 fixture）
  const payload = data.data && typeof data.data === 'object' ? data.data : data;

  const serverTime = payload.server_time;
  // plans 过滤前先剔除非对象元素（含 null），避免后续访问 p.status 等属性对 null 抛错
  const plans = (Array.isArray(payload.plans) ? payload.plans : []).filter((p) => p && typeof p === 'object');
```

### 测试代码块（test/apply.test.mjs，追加 2 用例）

```js
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
```

### 验证命令（TDD 顺序执行并贴 stdout/exit code）

```bash
node --test test/apply.test.mjs   # ① baseline（改前）全绿；② 仅加测试后：恰 2 个新用例红（旧码实际均 no-active-plan）；③ 改产后全绿（17 用例）
npm test                          # ④ 全仓回归绿
node apply.mjs --dry-run --force  # ⑤ 可选人工冒烟（触真实网络与真实 ~/.zcode config）：不再输出 skipped: no-active-plan
```

## Acceptance Criteria

- `node --test test/apply.test.mjs` exit 0：checkAvailability 既有 15 用例全绿（扁平 fixture 零回归）+ 新增 2 用例绿
- 嵌套信封用例精确断言 `{ available: true, reason: 'ok', plan: { endsAt: 1793754000 } }`（实测字段自洽：server_time=1793753110 ∈ [1793704125, 1793754000)，capabilities 含 `model:glm-5.3-flash`）
- code!==0 用例精确断言 `{ available: false, reason: 'non-200' }`
- `npm test` exit 0
- `grep -n "reason: '" lib/availability.mjs`：reason 字面量仍为 9 种（ok/disabled/http-error/non-200/no-active-plan/no-entitlement/not-in-window/timeout/parse-error），无新增
- 测试零真实网络：fetch 全部经 `withFetch` stub

## Risks

- **code!==0 分支（要求 3）保留**：若省略，HTTP 200 + 业务错误码会解包失败落到 `no-active-plan`，排障语义误导；复用 `non-200` 使 reason 集合保持封闭。严格 `!== 0` 判定下 `code: null` 或字符串 `"0"` 会被判接口错误——实测真实端点恒为数字 `0`，风险可忽略。
- `data.data` 为数组时（`typeof === 'object'` 为真）取到数组本身 → server_time/plans 取不到 → `no-active-plan`，不 throw；与既有垃圾输入降级路径一致，不加额外分支。
- 扁平兼容：既有 fixture 无 `code`/`data` 键 → 两个新分支均跳过，行为不变；无 `code` 键但带 `data` 对象的信封也能解包（解包不依赖 code 存在）。
- 下游无影响：apply.mjs / dashboard / run-log 只消费返回形状与 reason，二者未变。

## Exclusions

- 不改 apply.mjs（含 gate 顺序）、schedule.json、dashboard、lib/config.mjs
- 不新增 reason 值；不改 endpoint/apiKey 读取、超时与 header 逻辑
- 不做真实网络集成测试（冒烟仅人工可选，不入 CI）
- 不处理多 plan priority 排序（priority 字段仅原样出现在 fixture，判定逻辑不变）
