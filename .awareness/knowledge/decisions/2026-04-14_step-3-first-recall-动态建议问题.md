---
id: kc_mnyr7213_09593067
category: decision
confidence: 0.85
tags: []
created_at: 2026-04-14T15:05:32.679Z
---

# Step 3 First Recall 动态建议问题

不写死默认问题。recall-suggestions.js loadScanMeta() 调 /api/v1/stats + /api/v1/scan/state + /api/v1/wiki/list 收集元数据（has_readme/wiki_titles/top_language/has_docs/total_cards）。pickSuggestions() 按命中把握选最多 3 个 i18n 模板：onb.q.readme / onb.q.wiki_page({title}) / onb.q.architecture / onb.q.lang({lang}) / onb.q.decisions。空工作区 fallback 到 no_results 提示。
