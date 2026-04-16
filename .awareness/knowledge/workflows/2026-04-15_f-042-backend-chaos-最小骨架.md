---
id: kc_mnzxbaqx_c4440586
category: workflow
confidence: 0.85
tags: []
created_at: 2026-04-15T10:44:34.473Z
---

# F-042 backend chaos 最小骨架

backend/tests/chaos/test_llm_gateway_502.py 建立，2 个占位 tests（502 HTML 不能被当 JSON 解析 + timeout 必须抛 typed exception）。pytest.ini 注册 chaos + unit markers。下一步：为 inference_service / pgvector / redis / ollama_client 的每个外部调用补 happy+5xx+timeout 三组。
