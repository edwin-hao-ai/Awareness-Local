---
id: kc_mnth1u55_44157e00
category: workflow
confidence: 0.95
tags: [f-031, awarenessclaw, wiki-ui, desktop]
created_at: 2026-04-10T22:22:42.138Z
---

# AwarenessClaw Memory UI 从 6 Tab 收敛为 5 Tab 完成

桌面端 Memory.tsx 从 6 Tab（Timeline/Knowledge/Self-Improvement/Graph/Conflicts/Settings）收敛为 5 Tab（Overview/Wiki/Graph/Sync/Settings）。Wiki Tab 内含 sidebar+content 两栏架构，对齐云端 InsightsTab 和 local daemon index.html。Self-Improvement 完全移除。新增 6 个文件，修改 5 个文件。650 tests pass（9 个 pre-existing failure 与本次无关）。
