---
id: kc_mo06n8kv_76c6cdf7
category: problem_solution
confidence: 0.7
tags: []
created_at: 2026-04-15T15:05:48.080Z
---

# After thorough audit of the record chain, we found that save-memory.js was discarding _extraction_in

After thorough audit of the record chain, we found that save-memory.js was discarding _extraction_instruction from the daemon response. This means Claude Code users following the save-memory.js path would never see the extraction hint. Fixed by including _extraction_instruction in the JSON output when present.
