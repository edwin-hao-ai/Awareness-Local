---
id: kc_mnyidakz_b857b840
category: workflow
confidence: 0.85
tags: []
created_at: 2026-04-14T10:58:27.155Z
---

# 本地 daemon Task 自动关闭升级为 FTS5 BM25

lifecycle-manager.mjs 的 _autoResolveTasks 从 Jaccard word-overlap 升级为 SQLite FTS5 BM25 ranking（与 _autoMitigateRisks 对齐）。新增 tasks_fts FTS5 虚拟表 + indexer.mjs indexTask() 同步 FTS。Jaccard 保留为无 FTS 的旧 DB fallback。精确度显著提升。
