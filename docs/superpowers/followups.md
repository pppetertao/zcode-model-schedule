# Follow-ups

独立于当前 episode 的发现，按需另开 episode 处理。

| 发现位置 | 描述 | 建议处理方式 |
|---|---|---|
| `lib/apply-core.mjs:167-208` | `acquireLock` 把不可读的 lock 视为损坏并 unlink；第二进程因此可删掉第一进程仍持有的锁，第一进程 `releaseLock` 的 `stat` 抛 ENOENT → 以 exit 1 退出而非 0/2。pre-existing：在 Task 2 基线 `f8c6d51` 上同样复现，约 1/25 概率。 | 新 episode：`releaseLock` 容忍锁文件已消失，或 `acquireLock` 不 unlink 活跃锁；补并发回归测试消除 flake。 |
