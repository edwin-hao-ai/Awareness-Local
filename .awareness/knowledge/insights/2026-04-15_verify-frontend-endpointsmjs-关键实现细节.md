---
id: kc_mnzwtkh4_a00547ec
category: insight
confidence: 0.85
tags: []
created_at: 2026-04-15T10:30:47.276Z
---

# verify-frontend-endpoints.mjs 关键实现细节

frontend 调 API 的 pattern 是 ${API_BASE_URL}${path}（相对路径，无 /api/v1 前缀），backend 路由是 /api/v1/{prefix}/{path}。脚本需要：(1) 剥离 /api/v1 做相对比较；(2) transitive mount prefix：从 memories.py facade 递归跟 from .foo import 一路到 leaf route files；(3) norm 里先替 ${foo}→{}，再替 {foo}→{}，否则 ${} 残留；(4) 尾部 ${qs}/${params} query-string 过度捕获需要额外 variant（strip 尾部 {} 或 /{}）。
