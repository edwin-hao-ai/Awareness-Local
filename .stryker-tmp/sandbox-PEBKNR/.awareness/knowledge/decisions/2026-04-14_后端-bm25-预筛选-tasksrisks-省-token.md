---
id: kc_mnyidal2_6070c9cf
category: decision
confidence: 0.85
tags: []
created_at: 2026-04-14T10:58:27.158Z
---

# 后端 BM25 预筛选 tasks/risks 省 token

integration_handlers.py 新增 _fetch_relevant_tasks/_fetch_relevant_risks 函数。当 open items > 15 个时用 PostgreSQL to_tsquery(simple) + ts_rank 排序，只传 top-10 最相关的给用户端 LLM prompt。15 个以下全量传（overhead 不值得）。50 个 tasks 时省约 80% token（2500→500）。FTS 失败时 graceful fallback 到最近创建的 top-N。
