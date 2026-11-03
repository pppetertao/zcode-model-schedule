# README 补 dashboard 说明 — 文档轻量 spec（spec 即计划）

## Goal
为 `README.md`（简体中文）与 `README.en.md`（英文）各补一段 dashboard 使用说明，解决用户「dashboard 看不到」——根因是 dashboard 已实现但无任何入口文档，且启动不会自动打开浏览器。

## Files to Change
1. `README.md` — 在 `## Quick start` 段（现 line 42-67）之后、`## Configuration`（line 69）之前插入新 `## Dashboard` 段。理由：Quick start 是用户首次跑通流程后最可能继续探索的位置，紧贴其后最易被发现；dashboard 是可选查看工具，放 CLI reference 前会打断 apply/install 的命令参考连续性。最终文本见下「插入文本 A」。
2. `README.en.md` — 在 `## Quick start` 段（现 line 42-67）之后、`## Configuration`（line 69）之前插入新 `## Dashboard` 段，语义与中文等价，保持英文排版风格。最终文本见下「插入文本 B」。

不改其他段落、不新增文件、不改任何代码。

## 插入文本 A（README.md，中文）

```markdown
## Dashboard

一个可选的本地只读 web dashboard，让你一眼看到当前模式、可用性、最近运行、切换历史、配置摘要，并支持手动触发一次 `apply --if-due`。

```bash
npm run dashboard        # 或：node dashboard.mjs --port <n>
```

启动后访问 **http://127.0.0.1:8787**。注意：**不会自动打开浏览器**，请在浏览器地址栏手动输入上面的地址。

页面包含：当前模式、可用性、最近运行（最多 10 条）、切换历史（最多 10 条）、配置摘要、手动触发。

- 手动触发按钮等价于 `node apply.mjs --if-due --trigger dashboard`，是幂等的（仅在模式真正需要改变时执行），不提供强制覆盖。
- 仅监听本机 loopback（`127.0.0.1`），无认证、无 HTTPS。
- 若端口 8787 已被占用，启动会报错退出；用 `--port <n>` 换一个端口即可。
```

## 插入文本 B（README.en.md，英文）

```markdown
## Dashboard

An optional local, read-only web dashboard that shows at a glance the current mode, availability, recent runs, switch history, and a config summary, and lets you manually trigger one `apply --if-due`.

```bash
npm run dashboard        # or: node dashboard.mjs --port <n>
```

Once started, open **http://127.0.0.1:8787** in your browser. Note: it does **not** open a browser automatically — type the address above into your browser's address bar.

The page shows: current mode, availability, recent runs (up to 10), switch history (up to 10), a config summary, and a manual trigger button.

- The manual trigger button is equivalent to `node apply.mjs --if-due --trigger dashboard`; it is idempotent (only acts when a mode change is actually due) and offers no forced override.
- It listens only on the loopback interface (`127.0.0.1`), with no authentication and no HTTPS.
- If port 8787 is already in use, startup fails with an error; pass `--port <n>` to use a different port.
```

## Acceptance Criteria
- 两份 README 各出现一次 `npm run dashboard` 与 `127.0.0.1:8787`（正 grep 各 ≥1）。
- 两份 README 各出现「不会自动打开浏览器」语义（中文「不会自动打开浏览器」/ 英文 `not open a browser automatically`）。
- 两份 README 各出现 `--if-due --trigger dashboard` 与「无强制覆盖」语义。
- 两份 README 各出现 loopback（`127.0.0.1`）、无认证、端口占用换 `--port` 语义。
- 中英文语义等价；未改其他段落；未新增文件；未改代码。
- 无与「dashboard 跨平台可跑」冲突的错误陈述（dashboard 仅依赖 node 内置模块，跨平台；项目整体 launchd 调度才是 macOS 专属——README Requirements 已正确限定 macOS 于 launchd，本次插入文本不重复该限定）。

验证命令（在项目根目录执行）：
```bash
grep -c 'npm run dashboard' README.md README.en.md        # 各 ≥1
grep -c '127.0.0.1:8787' README.md README.en.md           # 各 ≥1
grep -c '不会自动打开浏览器' README.md                      # ≥1
grep -c 'not open a browser automatically' README.en.md    # ≥1
grep -c '--if-due --trigger dashboard' README.md README.en.md  # 各 ≥1
grep -c 'loopback' README.md README.en.md                  # 各 ≥1
# 负向：确认未引入「macOS 专属 dashboard」错误陈述
grep -n 'macOS' README.md README.en.md                    # 仅出现在 Requirements 的 launchd 语境，Dashboard 段内无 macOS
```

## Risks
- 插入位置若与后续编辑冲突（Quick start / Configuration 行号漂移），以「Quick start 段之后、Configuration 段之前」的语义定位为准，不依赖行号。
- 中英文语义漂移：两段由同一 spec 提供，转写时逐条核对 6 个覆盖点（启动命令、访问地址、不自动开浏览器、区块列举、手动触发等价命令、限制）。
- 若未来 dashboard 行为变更（端口、路由、触发语义），本段需同步更新——本次仅补现状，不写变更史。

## Exclusions
- 不改 dashboard.mjs / lib/dashboard.mjs / package.json / 任何代码。
- 不新增 README 之外的文件。
- 不重排或改写 README 其他段落（Features / Requirements / CLI reference / Logs & state 等均不动）。
- 不补 launchd 自启 dashboard 的说明（dashboard 未做自启，属后续 episode）。