---
id: kc_mo05vras_06b7f072
category: decision
confidence: 0.7
tags: []
created_at: 2026-04-15T14:44:25.973Z
---

# We decided to use session-buffer + Stop hook consolidation instead of 60s debounce, because short se

We decided to use session-buffer + Stop hook consolidation instead of 60s debounce, because short sessions were producing zero events. This is a decision between two approaches.
