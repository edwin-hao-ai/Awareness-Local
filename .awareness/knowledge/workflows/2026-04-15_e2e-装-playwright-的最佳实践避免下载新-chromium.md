---
id: kc_mnzaxqf7_54cd371e
category: workflow
confidence: 0.85
tags: []
created_at: 2026-04-15T00:18:10.051Z
---

# E2E 装 Playwright 的最佳实践（避免下载新 chromium）

sdks/local 用 @playwright/test@1.58.2（pin 而非 ^）匹配本地 ~/Library/Caches/ms-playwright/chromium-1208。playwright.config.mjs 用 webServer 字段自动启动 daemon (--port 37911)，timeout 90s。每个测试用 page.route 拦截 mock 响应。XSS regression 用 page.evaluate 直接调浏览器内函数，避免依赖完整 device-auth flow 的时序。
