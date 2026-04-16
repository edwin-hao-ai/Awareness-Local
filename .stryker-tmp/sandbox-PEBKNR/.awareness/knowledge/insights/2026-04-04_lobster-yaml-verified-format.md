---
id: kc_mnk6f14v_eac6f193
category: key_point
confidence: 0.85
tags: []
created_at: 2026-04-04T10:15:06.367Z
---

# Lobster YAML verified format

Lobster steps use run/command (shell), pipeline (LLM via llm.invoke), approval (human gate). Data flows via stdin: $stepId.stdout or $stepId.json. Args defined as name: {default: value}, referenced via ${name} or $LOBSTER_ARG_NAME env var. Approval returns JSON envelope with status: needs_approval + resumeToken. Resume via {action: resume, token, approve: true}. Tool invocation via openclaw.invoke shim (needs OPENCLAW_URL env).
