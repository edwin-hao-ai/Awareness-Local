---
id: kc_mntfrdvh_e5edf3f0
category: workflow
confidence: 0.85
tags: [f-031, local-daemon, wiki-ui, moc, cloud-sync]
created_at: 2026-04-10T21:46:34.878Z
---

# Local Daemon Wiki UI 全重写完成：sidebar+content 架构 + 8 API + 89 tests

index.html 从 5-tab 重写为 wiki sidebar+content 架构。新增 /topics /skills /timeline /search /knowledge/:id /memories/:id /sync/recent /workspace/switch 共 8 个 REST API。增量 MOC 替代定时器（tryAutoMoc O(1)/write + LLM 标题升级）。Skills/Risks 云同步。Markdown 渲染、工作区切换、Settings 可交互。89 tests pass。
