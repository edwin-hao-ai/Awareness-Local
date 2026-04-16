---
id: kc_mnyh68ll_77518f96
category: decision
confidence: 0.85
tags: []
created_at: 2026-04-14T10:24:58.377Z
---

# 后端 extraction prompt 新增 existing_risks 上下文给 LLM

extraction_v2_pass2_synthesis.py 的 prompt 新增 {existing_risks} 占位符 + mitigated_risks[] 返回格式。integration_handlers.py 对称地 fetch open risks（与 tasks 相同的 user_id/agent_role 过滤逻辑）传入 pass2_payload。LLM 现在可以检测 active risks 是否已被解决。
