---
id: kc_mnyigkbl_06c370bf
category: workflow
confidence: 0.95
tags: [awarenessclaw, release, v0.3.0, error-ux]
created_at: 2026-04-14T11:00:59.745Z
---

# AwarenessClaw v0.3.0 发布 — 友好错误提示 + 安装自动修复

新增 classifyProviderError() 将 LLM provider 错误分为 8 类，每类有中英文标题+操作提示。register-setup-handlers.ts 安装前检测损坏的 openclaw npm 目录并自动清理。ENOENT 正则从 npx-only 扩展到 openclaw。commit 86f38da。
