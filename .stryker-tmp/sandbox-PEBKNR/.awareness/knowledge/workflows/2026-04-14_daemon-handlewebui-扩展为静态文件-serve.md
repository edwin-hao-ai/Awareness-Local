---
id: kc_mnyr7212_b4ec9b4c
category: workflow
confidence: 0.85
tags: []
created_at: 2026-04-14T15:05:32.679Z
---

# daemon handleWebUi 扩展为静态文件 serve

src/daemon/http-handlers.mjs handleWebUi 新增 pathname 参数。whitelist：仅 index.html 和 onboarding/ 子路径。WEB_MIME 映射 .js/.css/.json/.svg。防 path traversal（拒绝 .. 和绝对路径 + startsWith webDir 检查）。未知路径 404 而非 fallback。test/web-static-handler.test.mjs 6 个测试通过（200 正常文件 + 400 traversal + 404 whitelist 外 + 404 文件不存在）。
