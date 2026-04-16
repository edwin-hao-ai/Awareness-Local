---
id: kc_mnzwzxec_2b626653
category: decision
confidence: 0.85
tags: []
created_at: 2026-04-15T10:35:43.957Z
---

# AwarenessClaw 桌面 Onboarding 升级设计文档

docs/features/f-040/awarenessclaw-onboarding-upgrade.md：5→7 步（插 Workspace 必填 + CloudAuth 可选）。最大程度复用现有 IPC（workspace:set-active / cloud:auth-start / cloud:auth-poll）和 React 组件（SettingsCloudAuthModal 抽成 CloudAuthPanel 共享）。字符图完整、i18n 对齐、5 层金字塔测试指定、4 个 Gherkin 场景（含 javascript: URL defang regression）。
