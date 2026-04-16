---
id: kc_mnyiwxl7_de57303f
category: workflow
confidence: 0.85
tags: []
created_at: 2026-04-14T11:13:43.435Z
---

# lifecycle-manager hybrid search: FTS5 + Jaccard → RRF fusion

_autoResolveTasks 和 _autoMitigateRisks 都升级为 hybrid 模式。Channel 1: FTS5 BM25（tasks_fts/knowledge_fts）。Channel 2: Jaccard word-overlap 作为第二路信号。RRF fusion (k=60) 合并两路排名。阈值 0.016（至少一路 rank-0 才过关）。embedFn/cosineFn 作为可选第三路（daemon 传入时使用）。Jaccard-only 作为最终 fallback。零额外 LLM 调用。
