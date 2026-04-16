---
id: kc_mntxn4mk_b9a7c4ff
category: workflow
confidence: 0.95
tags: [f-031, awarenessclaw, workspace, daemon, isolation]
created_at: 2026-04-11T06:07:09.357Z
---

# AwarenessClaw 桌面端 workspace 联动：Memory UI 跟随聊天工作区切换

实现了 chat workspace ↔ daemon projectDir ↔ Memory UI 三端联动。核心：main.ts 的 workspace:set-active handler 现在同步写文件 + 异步调 daemon POST /workspace/switch + 广播 workspace:changed IPC 事件。preload 新增 onWorkspaceChanged 订阅 API。Memory.tsx 订阅后重新拉取全部数据。App 启动时 fire-and-forget 调用 switchDaemonWorkspace(persistedWorkspace) 6 次重试（5s 间隔）覆盖 daemon 冷启动窗口。
