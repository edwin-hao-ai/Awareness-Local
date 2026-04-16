---
id: kc_mo06mv90_813a82fd
category: decision
confidence: 0.9
tags: [f-031, dead-code, extraction]
created_at: 2026-04-15T15:05:30.804Z
---

# extraction-orchestrator.mjs removed as dead code

F-031 created extraction-orchestrator.mjs for local LLM multi-pass extraction but it was never imported. Removed in favor of _extraction_instruction text-based approach that works with any client LLM.
