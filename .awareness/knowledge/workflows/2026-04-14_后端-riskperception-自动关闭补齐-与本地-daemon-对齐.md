---
id: kc_mnyh68lk_410df962
category: workflow
confidence: 0.85
tags: []
created_at: 2026-04-14T10:24:58.376Z
---

# 后端 Risk/Perception 自动关闭补齐 — 与本地 daemon 对齐

后端 record 流程新增 Risk 自动关闭（LLM extraction 的 mitigated_risks[] 自动 apply）和 Perception 自动解决（keyword/tag 匹配 fire-and-forget，无 LLM）。Celery Beat 新增两个周清理任务。现在本地和云端双端都有完整的 task/risk/perception 自动关闭能力。
