---
id: kc_mn9w9yj0_0d99ec91
category: pitfall
confidence: 0.95
tags: [prisma, database, migration]
created_at: 2026-03-28T05:33:31.788Z
---

# prisma db push 会删除 memory_vectors 表

绝不运行 prisma db push，它会删除 memory_vectors 表导致数据丢失。必须用手动 SQL 迁移。
