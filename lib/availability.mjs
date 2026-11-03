// lib/availability.mjs — plan 可用性检测：调 billing API 判定 target 模型是否可用
// apiKey 只在内存中传入 fetch header；禁止出现在任何 console 输出/返回值/文件
import fs from 'node:fs';
import { expandHome } from './config.mjs';

// 返回 { available: boolean, reason: string, plan?: { endsAt: number } }
// reason ∈ 'ok'|'http-error'|'non-200'|'no-active-plan'|'no-entitlement'|'not-in-window'|'timeout'|'parse-error'|'disabled'
// available=true 时 plan.endsAt 为 active plan 的 ends_at（unix 秒）
// 所有失败路径返回 { available:false, reason }，不 throw（调用方按 available 决定是否切换）
export async function checkAvailability(schedule, configJsonPath = '~/.zcode/v2/config.json') {
  const av = schedule.availability;
  if (av?.enabled === false) return { available: true, reason: 'disabled' };

  const resolvedConfigPath = expandHome(configJsonPath);
  let apiKey;
  try {
    const cfg = JSON.parse(fs.readFileSync(resolvedConfigPath, 'utf8'));
    apiKey = cfg.provider?.[av.provider]?.options?.apiKey;
  } catch (err) {
    // config.json 读不到/非法 JSON：与网络不可达同类处理（不可用即跳过切换）；只 log 路径与错误类型，不暴露 err.message（V8 的 JSON.parse 错误可能内嵌 apiKey 片段）
    console.error(`[warn] 读取 ${resolvedConfigPath} 失败（${err.code ?? err.name}），按不可用处理`);
    return { available: false, reason: 'http-error' };
  }
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return { available: false, reason: 'http-error' }; // apiKey 缺失：不发请求，直接判不可用
  }

  let res;
  try {
    res = await fetch(av.endpoint, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(av.timeout),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') return { available: false, reason: 'timeout' };
    return { available: false, reason: 'http-error' }; // TypeError（网络不可达/DNS 失败）等
  }
  if (!res.ok) return { available: false, reason: 'non-200' };

  let data;
  try {
    data = JSON.parse(await res.text());
  } catch {
    // 吞掉 200 响应体的 JSON.parse 错误：响应非 JSON 视为端点异常（不可用即跳过，无其他路径可达）
    return { available: false, reason: 'parse-error' };
  }

  // 形状守卫：data 非对象（含 null）或基础类型 → 视为端点异常，绝不 throw
  if (!data || typeof data !== 'object') return { available: false, reason: 'parse-error' };

  const serverTime = data.server_time;
  // plans 过滤前先剔除非对象元素（含 null），避免后续访问 p.status 等属性对 null 抛错
  const plans = (Array.isArray(data.plans) ? data.plans : []).filter((p) => p && typeof p === 'object');
  const activeInWindow = plans.filter((p) => p.status === 'active' && p.starts_at <= serverTime && serverTime < p.ends_at);
  if (activeInWindow.length === 0) {
    // 有 status=active 的 plan 但 server_time 不在 [starts_at, ends_at) → not-in-window；否则无 active plan
    const hasActiveStatus = plans.some((p) => p.status === 'active');
    return { available: false, reason: hasActiveStatus ? 'not-in-window' : 'no-active-plan' };
  }
  const usable = activeInWindow.filter(
    (p) => Array.isArray(p.entitlements) && p.entitlements.some((e) => Array.isArray(e.capabilities) && e.capabilities.includes(av.model)),
  );
  if (usable.length === 0) return { available: false, reason: 'no-entitlement' };
  return { available: true, reason: 'ok', plan: { endsAt: usable[0].ends_at } };
}
