#!/usr/bin/env node
// hooks/register-hook.mjs — 把 model-schedule-apply.sh 幂等注册进 ~/.zcode/cli/config.json
// 不被任何步骤自动执行；仅用户显式运行（node register-hook.mjs 或 install.mjs --register-hook）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOOK_MARKER = 'model-schedule-apply.sh';
// hook 脚本绝对路径：基于本文件自身目录解析（工具可安装于任意目录，不依赖 $HOME/.zcode/tools）
const HOOK_SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), HOOK_MARKER);
const DEFAULT_CLI_CONFIG = path.join(os.homedir(), '.zcode', 'cli', 'config.json');

// 直接执行判定：argv[1] 经 realpath 对比（容忍工具目录为 symlink 的部署方式）
// ENOENT：argv[1] 指向已删除文件 → 不可能为本模块入口，按非入口处理
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// hook 条目形状与 cli/config.json 现存条目实测一致（matcher + hooks[{type,command,timeout,statusMessage}]）
// command 用本文件目录解析出的绝对路径（shell 引号包裹，容忍含空格路径）；timeout:10 即 ZCode 侧超时（替代 shell timeout 命令）
function buildHookEntry() {
  return {
    matcher: 'startup|clear|compact',
    hooks: [
      {
        type: 'command',
        command: `bash "${HOOK_SCRIPT_PATH}"`,
        timeout: 10,
        statusMessage: 'Applying model schedule',
      },
    ],
  };
}

// 幂等注册：SessionStart 数组已含 model-schedule-apply 条目 → 打印 already registered 不修改；
// 否则 cp 备份（config.json.bak-<ISO>，保留供回滚）后追加条目，tmp+rename 原子写
export function registerHook(cliConfigPath = DEFAULT_CLI_CONFIG) {
  const hookEntry = buildHookEntry();
  if (!fs.existsSync(cliConfigPath)) {
    // 全新机器无 cli/config.json：直接创建最小结构（无历史可备份）
    const config = { hooks: { events: { SessionStart: [hookEntry] } } };
    fs.mkdirSync(path.dirname(cliConfigPath), { recursive: true });
    fs.writeFileSync(cliConfigPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o644 });
    console.log(`created ${cliConfigPath} with model-schedule hook`);
    return { changed: true };
  }
  const raw = fs.readFileSync(cliConfigPath, 'utf8');
  const config = JSON.parse(raw);
  config.hooks = config.hooks ?? {};
  config.hooks.events = config.hooks.events ?? {};
  const sessionStart = config.hooks.events.SessionStart;
  if (Array.isArray(sessionStart) && JSON.stringify(sessionStart).includes(HOOK_MARKER)) {
    console.log('already registered');
    return { changed: false };
  }
  const backupPath = `${cliConfigPath}.bak-${new Date().toISOString()}`;
  fs.copyFileSync(cliConfigPath, backupPath);
  const mode = fs.statSync(cliConfigPath).mode & 0o777;
  const arr = Array.isArray(sessionStart) ? sessionStart : [];
  arr.push(hookEntry);
  config.hooks.events.SessionStart = arr;
  const tmp = `${cliConfigPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode });
  fs.renameSync(tmp, cliConfigPath);
  console.log(`registered model-schedule hook in ${cliConfigPath} (backup: ${backupPath})`);
  return { changed: true };
}

if (isMainModule()) {
  registerHook();
}
