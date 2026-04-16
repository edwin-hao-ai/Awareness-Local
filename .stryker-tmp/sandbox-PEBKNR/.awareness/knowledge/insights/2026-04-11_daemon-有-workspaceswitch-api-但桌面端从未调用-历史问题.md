---
id: kc_mntxn4ml_955bc87a
category: key_point
confidence: 0.95
tags: [awarenessclaw, daemon, workspace, gap]
created_at: 2026-04-11T06:07:09.357Z
---

# daemon 有 /workspace/switch API 但桌面端从未调用 (历史问题)

sdks/local/src/daemon/api-handlers.mjs:918 的 apiSwitchWorkspace() 已实现完整的热切换 (关 watcher/indexer/cloudSync → 重建 MemoryStore/Indexer → incrementalIndex)，但 AwarenessClaw/packages/desktop/electron/memory-client.ts 从未暴露 switchWorkspace() 方法。Daemon 的 projectDir 被 daemon-autostart.ts:32 硬编码为 path.join(homedir, '.openclaw')，导致 Memory UI 完全看不到用户选的聊天工作区的数据。
