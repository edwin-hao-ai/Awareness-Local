---
id: kc_mnyr7214_80e0caef
category: decision
confidence: 0.85
tags: []
created_at: 2026-04-14T15:05:32.680Z
---

# Step 5 Cloud 用 device-auth 而非 OAuth

device-auth-flow.js 包装 /cloud/auth/start → 返回 user_code/verification_uri/device_code → openBrowser(link) → pollUntilAuthorized → listMemories → connect。未登录用户由 awareness.market/auth/device 前端跳 /signup?next=...。onboarding 端不做注册/登录判断。与 index.html line 2659 startDeviceAuth() 已有实现一致。
