---
id: kc_mnzxbaqx_52462e2d
category: key_point
confidence: 0.85
tags: []
created_at: 2026-04-15T10:44:34.473Z
---

# pre-push hook 会自动跑 L1

git push origin main 时 pre-push hook 依次跑 verify-endpoints + verify-buttons + verify-zero-mock + sync-shared-scripts --check。L1 不绿 push 被拒。完整 L1+L2+L3+L4 跑 bash scripts/ship-gate.sh。
