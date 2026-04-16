---
id: kc_mnzwbiqw_f98d4c05
category: decision
confidence: 0.85
tags: []
created_at: 2026-04-15T10:16:45.225Z
---

# F-041/F-042 拆分：Ship-Gate 基础设施 vs backend/frontend 落地

F-041 范围：建 scripts/verify-endpoints.mjs + verify-buttons.mjs + chaos-helpers.mjs + smoke-playbook.sh，推广到 7 个 SDK。F-042 范围：backend pytest chaos 覆盖率门禁 + frontend Playwright L4 零 mock user-journeys。两者独立可并行。sdks/local 只有 L4 已落地，L1/L3 scripts 实际未建。
