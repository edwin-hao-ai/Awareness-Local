---
id: kc_mnyhzudc_f05a98a6
category: problem_solution
confidence: 0.9
tags: [awarenessclaw, qwen, gateway, chat-error]
created_at: 2026-04-14T10:47:59.616Z
---

# AwarenessClaw 聊天 internal error 来自 Qwen API 服务端

聊天报 'An internal error has occured' + livenessState: blocked 不是 AwarenessClaw 的 bug。Gateway 日志显示 provider=qwen, model=qwen3.5-omni-plus-realtime，Qwen 返回服务器内部错误。检查 API key/额度或换模型即可。
