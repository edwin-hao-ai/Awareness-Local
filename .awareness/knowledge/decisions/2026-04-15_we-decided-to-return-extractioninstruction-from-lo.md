---
id: kc_mo05rwf3_cfbbfe81
category: decision
confidence: 0.7
tags: []
created_at: 2026-04-15T14:41:25.983Z
---

# We decided to return _extraction_instruction from local daemon when insights are missing, mirroring

We decided to return _extraction_instruction from local daemon when insights are missing, mirroring the cloud backend behaviour. The extraction orchestrator module (extraction-orchestrator.mjs) existed but was never called — now we wire shouldRequestExtraction + buildExtractionInstruction into _remember().
