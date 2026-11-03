#!/usr/bin/env node
// install.mjs — launchd 安装器：生成/卸载 plist（dayWindows 驱动）+ 可选注册 SessionStart hook
// 仅用户显式运行；--dry-run 只打印不写不 bootstrap
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadSchedule } from './lib/config.mjs';
import { registerHook } from './hooks/register-hook.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const LABEL = 'com.zcode.model-schedule';
const DEFAULT_CONFIG = path.join(TOOL_DIR, 'schedule.json');
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const APPLY_SCRIPT = path.join(TOOL_DIR, 'apply.mjs');
const NODE_PATH_FILE = path.join(TOOL_DIR, 'node-path');
const LOGS_DIR = path.join(TOOL_DIR, 'logs');
const LAUNCHD_PATH_ENV = '/usr/local/bin:/usr/bin:/bin';
const USAGE = '用法: node install.mjs [--config <path>] [--dry-run] [--uninstall] [--register-hook]';

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// plist XML；nodePath 由 install/dryRun 传 process.execPath（不假设 node 在 PATH）
// StartCalendarInterval：每个 dayWindow × 每 day × {from, to} 各一条
//（from 时刻进入白天窗恢复 original；to 时刻进入 target 窗切 target——实际模式由 apply.mjs 按钟点自判）
// StartInterval=300 兜底（每 5 分钟 --if-due 检查，防睡眠漏触发；launchd Weekday 为单整数，无法一条表达 1-5）
export function generatePlist(schedule, nodePath, scriptPath, uid) {
  const logsDir = path.join(path.dirname(scriptPath), 'logs');
  const calendarEntries = [];
  for (const window of schedule.dayWindows) {
    for (const day of window.days) {
      for (const time of [window.from, window.to]) {
        const [hour, minute] = time.split(':').map(Number);
        calendarEntries.push(
          `    <dict><key>Weekday</key><integer>${day}</integer><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`,
        );
      }
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${LABEL} (gui/${uid}) -->
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(scriptPath)}</string>
    <string>--if-due</string>
    <string>--trigger</string>
    <string>launchd</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
${calendarEntries.join('\n')}
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>${xmlEscape(logsDir)}/launchd.out.log</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logsDir)}/launchd.err.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${LAUNCHD_PATH_ENV}</string></dict>
</dict></plist>
`;
}

// bootout 对未加载服务报错属预期（首次安装/已卸载）——吞掉该错误让 bootstrap 干净执行
function bootoutIgnoreFailure(uid) {
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
  } catch {
    // launchctl bootout 目标未加载时的报错无后续影响（非敏感 + 幂等语义）
  }
}

// 写 plist + node-path 文件 + bootstrap；重复安装先 bootout 旧实例
export function install(schedulePath) {
  const schedule = loadSchedule(schedulePath);
  const uid = process.getuid();
  const nodePath = process.execPath;
  const plist = generatePlist(schedule, nodePath, APPLY_SCRIPT, uid);
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.writeFileSync(PLIST_PATH, plist, { mode: 0o644 });
  fs.writeFileSync(NODE_PATH_FILE, `${nodePath}\n`, { mode: 0o644 });
  bootoutIgnoreFailure(uid);
  execFileSync('launchctl', ['bootstrap', `gui/${uid}`, PLIST_PATH], { stdio: 'inherit' });
  console.log(`installed: ${PLIST_PATH}`);
  console.log(`bootstrapped: gui/${uid}/${LABEL}`);
  console.log(`node-path: ${NODE_PATH_FILE}`);
  return PLIST_PATH;
}

// bootout + 删除 plist；plist 不存在时提示跳过
export function uninstall() {
  const uid = process.getuid();
  bootoutIgnoreFailure(uid);
  if (fs.existsSync(PLIST_PATH)) {
    fs.unlinkSync(PLIST_PATH);
    console.log(`removed: ${PLIST_PATH}`);
  } else {
    console.log(`plist 不存在（跳过删除）: ${PLIST_PATH}`);
  }
}

// 只打印 plist，不写文件不 bootstrap
export function dryRun(schedulePath) {
  const schedule = loadSchedule(schedulePath);
  process.stdout.write(generatePlist(schedule, process.execPath, APPLY_SCRIPT, process.getuid()));
}

function parseInstallArgs(argv) {
  const opts = { config: DEFAULT_CONFIG, dryRun: false, uninstall: false, registerHook: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`--config 需要一个路径参数\n${USAGE}`);
      opts.config = value;
      i += 1;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--uninstall') {
      opts.uninstall = true;
    } else if (arg === '--register-hook') {
      opts.registerHook = true;
    } else {
      throw new Error(`未知参数: ${arg}\n${USAGE}`);
    }
  }
  return opts;
}

if (isMainModule()) {
  const opts = parseInstallArgs(process.argv.slice(2));
  if (opts.uninstall) {
    uninstall();
  } else if (opts.dryRun) {
    dryRun(opts.config);
  } else {
    install(opts.config);
  }
  if (opts.registerHook) {
    registerHook(); // 写真实 ~/.zcode/cli/config.json（默认路径），用户显式 opt-in
  }
}
